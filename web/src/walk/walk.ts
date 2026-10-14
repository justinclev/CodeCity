import * as THREE from 'three';
import type { CityScene } from '../scene';
import { busRoute } from '../links';
import { Avatar } from './avatar';
import { LightTrail } from './trail';
import { CodeWall, TextPanel, type PanelRow } from './codewall';
import { FH, Interior, type InteriorFloor, type InteriorSpec } from './interior';
import type { Floor } from '../scene';
import type { TourStop } from '../tour';
import { CityMap, type MapLabel, type MapMarker } from './map';
import { Game, type GameWorld, type Reward } from './game';
import { InfoCard, QuestLog, QuizBox, Rewards, SearchBox, StatusBar, TourCard, type CardData, type SearchHit } from './panels';
import { Music } from './music';
import { Props, type Shard, type Terminal } from './props';
import { PlaneMode } from './plane';

/** A definition from the symbol index: [name, kind, path, start, end]. */
export type Sym = [string, string, string, number, number];

export interface Destination { building: number; line?: number; label: string }

/** What walk mode needs from the rest of the app. */
export interface WalkHost {
  /** Build the interior spec for building i (fetches the file). */
  interiorSpec(i: number, go: (d: Destination) => void, symbols: Map<string, Sym[]> | null): Promise<InteriorSpec>;
  buildingByPath(path: string): number;
  buildingName(i: number): string;
  importsOf(i: number): number[];
  symbols(): Promise<Sym[]>;
  onExit(): void;
  /** Floors (with first source lines) for taking a building apart. */
  floors(i: number): Promise<Floor[]>;
  /** Details card; `origin` = it shows the commit that created the file. */
  card(i: number, act: { visit(j: number): void; enterAt(j: number, line: number, label: string): void }): Promise<{ data: CardData; origin: boolean }>;
  tour(): TourStop[];
  gameWorld(): GameWorld;
  /** Top-level directories (terminal sites) and map labels. */
  topDistricts(): { path: string; name: string; x: number; z: number; w: number; d: number }[];
  mapLabels(): MapLabel[];
  searchFiles(q: string): number[];
  /** Entrances and exits on the city edge (the door list shared with the city view). */
  doors(): { k: number; dir: 'in' | 'out'; label: string; leads: number }[];
  /** Every door behind one edge gate (a collapsed "7 routes" gate lists each route with the file and line of its definition). */
  leadsOf(k: number): { label: string; building: number; line?: number; path: string }[];
  /** The code route behind a door: gate, then spot by spot through the functionality. */
  doorRoute(k: number, doorAt?: number): { title: string; steps: { kind: 'enter' | 'code' | 'out'; label: string; detail: string; building: number; line?: number }[] } | null;
}

const HELP = 'WASD move · Space jump · F or double-tap Space: fly (W goes where you look) · Shift run / descend · double-tap W sprint · M map · P music · R routes · T tour · / search · X take apart · I info · J quests · E enter/use · V view · Q exit';

const keyDown = new Set<string>();

/**
 * First/third-person exploration: walk the city as an articulated probe-bot,
 * enter buildings (one storey per piece of code, stairs + elevator), read and
 * scroll code on the walls, click identifiers to teleport to their definitions.
 */
export class WalkMode {
  active = false;
  private where: 'city' | 'inside' = 'city';
  private firstPerson = false;
  private avatar = new Avatar();
  private trail = new LightTrail(new THREE.Color(0.2, 0.85, 1.0));
  private pos = new THREE.Vector3();
  private velY = 0;
  private yaw = 0;
  private pitch = -0.12;
  private grounded = true;
  private camDist = 4;
  private interior: Interior | null = null;
  private inside = -1; // building index of the interior
  private symbols: Map<string, Sym[]> | null = null;
  private obstacles: ReturnType<CityScene['walkData']> | null = null;
  private hud!: HTMLElement;
  private prompt!: HTMLElement;
  private menu!: HTMLElement;
  private toastEl!: HTMLElement;
  private fx!: HTMLElement;
  private locked = false;
  private drag: { x: number; y: number } | null = null;
  private aim: { kind: 'code'; wall: CodeWall; token: string | null; line: number } | { kind: 'panel'; panel: TextPanel; row: PanelRow | null }
    | { kind: 'elevator' } | { kind: 'exit' } | { kind: 'building'; i: number } | { kind: 'floor'; k: number } | { kind: 'gate'; k: number } | null = null;
  private busy = false; // teleporting / entering
  private savedCam = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, near: 0.1, far: 20000 };
  private tracer: { mesh: THREE.Mesh; head: THREE.Mesh; mat: THREE.ShaderMaterial; curve: THREE.CurvePath<THREE.Vector3>; t: number; dur: number; done: () => void } | null = null;
  private raycaster = new THREE.Raycaster();
  private menuItems: { label: string; go: () => void }[] = [];
  private lastDoorCheck = 0;
  private time = 0;
  private listeners: [EventTarget, string, EventListener][] = [];
  // flying (Minecraft rules: double-tap Space toggles, Space up, Shift down, landing ends it)
  private flying = false;
  private lastSpace = -1;
  private lastW = -1;
  private sprint = false;
  private flyBoost = 1;
  private flySpeed = 0;
  private velH = new THREE.Vector3();
  // taking a building apart
  private explodeFloors: Floor[] = [];
  // map, game, panels
  private map: CityMap | null = null;
  private mini!: HTMLCanvasElement;
  private miniLabel!: HTMLElement;
  private game: Game | null = null;
  private status = new StatusBar();
  private rewards = new Rewards();
  private card = new InfoCard();
  private cardFor = -1;
  private cardSeq = 0;
  private tourCard = new TourCard();
  private quizBox = new QuizBox();
  private log = new QuestLog();
  private search = new SearchBox(q => this.find(q), () => this.search.hide());
  private tour: TourStop[] = [];
  private tourK = -1;
  private routeSteps: { kind: 'enter' | 'code' | 'out'; label: string; detail: string; building: number; line?: number }[] = [];
  private routeTitle = '';
  private routeK = -1;
  private props: Props | null = null;
  private music = new Music();
  private symList: Sym[] = [];
  private seeTimer = 0;
  private mapDirty = false;
  // plane easter egg
  private planeCtrl: PlaneMode | null = null;
  private piloting = false;

  constructor(private scene: CityScene, private host: WalkHost) {}

  /** Outdoor scale: body height in city units. */
  private get u() { return Math.max(0.2, this.scene.cell * 0.6); } // ~1/5 of a median building's width
  private get h() { return this.where === 'inside' ? 1.8 : this.u; }

  // ------------------------------------------------------------------ lifecycle

  /** Start walking; with `at` >= 0, spawn on the street in front of that building. */
  start(at = -1) {
    if (this.active || !this.scene.loaded) return;
    this.active = true;
    void this.music.start();
    (document.activeElement as HTMLElement | null)?.blur?.(); // keys belong to walk mode now
    document.body.classList.add('walking');
    const cam = this.scene.camera;
    this.savedCam = { pos: cam.position.clone(), target: this.scene.controls.target.clone(), fov: cam.fov, near: cam.near, far: cam.far };
    this.scene.stopFly();
    this.scene.controls.enabled = false;
    this.obstacles = this.scene.walkData();
    this.scene.setStreetLevel(true);
    this.buildHud();
    // spawn on the ground in front of the city, facing it
    const { boxes } = this.obstacles;
    let cx = 0, cz = 0, maxZ = -Infinity;
    for (const b of boxes) { cx += (b.x0 + b.x1) / 2; maxZ = Math.max(maxZ, b.z1); }
    cx /= Math.max(1, boxes.length);
    cz = maxZ + this.u * 6;
    this.where = 'city';
    this.pos.set(cx, 0, cz);
    this.pos.y = this.groundCity(this.pos.x, this.pos.z, 100);
    this.yaw = 0; this.faceCamera();
    this.pitch = -0.08;
    const spot = at >= 0 ? this.frontSpot(at) : null;
    if (spot) { this.pos.set(spot.x, spot.y, spot.z); this.yaw = spot.yaw; this.faceCamera(); this.pitch = 0.18; }
    this.camDist = this.u * 3.2;
    this.avatar.group.scale.setScalar(this.u);
    this.scene.cityScene.add(this.avatar.group, this.trail.mesh);
    this.avatar.materialize();
    cam.fov = 70;
    cam.near = Math.max(0.02, this.u * 0.05);
    cam.far = this.scene.worldSize * 8;
    cam.updateProjectionMatrix();
    this.flying = false; this.velH.set(0, 0, 0); this.velY = 0;
    this.setupGame();
    this.scene.onFrame = dt => this.frame(dt);
    this.bindInput();
    this.toast(HELP + ' · H help', 9);
    void this.host.symbols().then(list => {
      this.symList = list;
      const m = new Map<string, Sym[]>();
      const add = (k: string, s: Sym) => { const l = m.get(k) ?? []; l.push(s); m.set(k, l); };
      for (const s of list) {
        add(s[0], s);
        const last = s[0].split('.').pop()!;
        if (last !== s[0]) add(last, s);
      }
      this.symbols = m;
    }).catch(() => { this.symbols = new Map(); });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.music.stop();
    document.body.classList.remove('walking');
    if (document.pointerLockElement) document.exitPointerLock();
    this.leaveInterior();
    if (this.scene.explodedBuilding >= 0) this.scene.collapse(true);
    if (this.piloting) { this.planeCtrl?.dispose(); this.piloting = false; }
    this.props?.dispose(); this.props = null;
    this.map?.closeFull(); this.map = null;
    this.tourK = -1; this.cardFor = -1;
    this.card.hide(); this.tourCard.hide(); this.quizBox.hide(); this.log.hide(); this.search.hide();
    this.scene.setStreetLevel(false);
    this.scene.cityScene.remove(this.avatar.group);
    this.trail.mesh.parent?.remove(this.trail.mesh);
    this.clearTracer();
    this.scene.onFrame = null;
    this.scene.controls.enabled = true;
    const cam = this.scene.camera;
    cam.fov = this.savedCam.fov; cam.near = this.savedCam.near; cam.far = this.savedCam.far;
    cam.position.copy(this.savedCam.pos);
    this.scene.controls.target.copy(this.savedCam.target);
    cam.updateProjectionMatrix();
    this.scene.controls.update();
    for (const [t, ev, fn] of this.listeners) t.removeEventListener(ev, fn);
    this.listeners = [];
    keyDown.clear();
    this.hud?.remove();
    this.host.onExit();
  }

  // ------------------------------------------------------------------ input

  private on<K extends string>(t: EventTarget, ev: K, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    t.addEventListener(ev, fn as EventListener, opts);
    this.listeners.push([t, ev, fn as EventListener]);
  }

  private bindInput() {
    const canvas = this.scene.renderer.domElement;
    this.on(window, 'keydown', e => this.keydown(e as KeyboardEvent), { capture: true });
    this.on(window, 'keyup', e => { const c = (e as KeyboardEvent).code; keyDown.delete(c); if (c === 'KeyW') this.sprint = false; });
    this.on(document, 'pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; this.hud.classList.toggle('locked', this.locked); });
    this.on(canvas, 'mousedown', e => {
      const m = e as MouseEvent;
      if (this.busy) return;
      if (this.menu.childElementCount) return;
      if (!this.locked && m.button === 0) {
        // first click captures the mouse; if that is not available (embedded / headless), drag to look
        try { void (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => undefined); } catch { /* not available */ }
        this.drag = { x: m.clientX, y: m.clientY };
      }
      if (this.locked && m.button === 0) this.click();
    });
    this.on(window, 'mouseup', () => {
      if (this.drag && !this.locked) this.click(true);
      this.drag = null;
    });
    this.on(window, 'mousemove', e => {
      const m = e as MouseEvent;
      let dx = 0, dy = 0;
      if (this.locked) { dx = m.movementX; dy = m.movementY; }
      else if (this.drag) { dx = m.clientX - this.drag.x; dy = m.clientY - this.drag.y; this.drag = { x: m.clientX, y: m.clientY }; if (Math.abs(dx) + Math.abs(dy) > 2) this.dragged = true; }
      else { this.mouse.set((m.clientX / innerWidth) * 2 - 1, -(m.clientY / innerHeight) * 2 + 1); return; }
      this.yaw -= dx * 0.0025;
      this.pitch = Math.max(-1.35, Math.min(1.2, this.pitch - dy * 0.0022));
    });
    this.on(canvas, 'wheel', e => {
      const w = e as WheelEvent;
      w.preventDefault();
      if (this.aim?.kind === 'code') this.aim.wall.scrollBy(Math.sign(w.deltaY) * 3);
      else if (!this.firstPerson) this.camDist = Math.max(this.h * 1.2, Math.min(this.h * (this.where === 'city' ? 24 : 9), this.camDist * (w.deltaY > 0 ? 1.12 : 0.89)));
    }, { passive: false });
  }

  private mouse = new THREE.Vector2(0, 0);
  private dragged = false;

  private keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    e.stopImmediatePropagation(); // walk mode owns the keyboard
    if (e.repeat && e.code !== 'Space' && !/^Key[WASD]$|^Arrow|^Shift/.test(e.code)) return;
    if (this.quizBox.open) {
      if (/^Digit[1-4]$/.test(e.code)) { const k = Number(e.code.slice(5)) - 1; if (this.quizBox.waiting) this.quizBox.choose(k); else this.quizBox.goTo(k); return; }
      if (e.code === 'KeyN' && !this.quizBox.waiting) { this.quizBox.next(); return; }
      if (e.code === 'Escape' || e.code === 'KeyE') { this.quizBox.hide(); return; }
    }
    if (this.menuItems.length && /^Digit[1-9]$/.test(e.code)) {
      const it = this.menuItems[Number(e.code.slice(5)) - 1];
      if (it) { this.closeMenu(); it.go(); }
      return;
    }
    if (e.code === 'Escape') {
      if (this.menuItems.length) this.closeMenu();
      else if (this.log.open) this.log.hide();
      else if (this.map?.full) this.toggleMap();
      else if (this.card.open) this.closeCard();
      else if (this.routeK >= 0) this.endRoute();
      else if (this.tourK >= 0) this.endTour();
      return;
    }
    if (e.code === 'KeyQ') { this.stop(); return; }
    if (e.code === 'KeyV') { this.firstPerson = !this.firstPerson; return; }
    if (e.code === 'KeyE') { this.use(); return; }
    if (e.code === 'KeyM') { this.toggleMap(); return; }
    if (e.code === 'KeyF' && !e.repeat) { this.toggleFly(); return; }
    if (e.code === 'KeyP') { this.music.toggle(); return; }
    if (e.code === 'KeyX') { void this.toggleExplode(); return; }
    if (e.code === 'KeyI') { this.toggleCard(); return; }
    if (e.code === 'KeyJ') { if (this.log.open) this.log.hide(); else { this.log.show(this.game!, () => this.resetGame()); this.freeMouse(); } return; }
    if (e.code === 'KeyT') { if (this.tourK >= 0) this.endTour(); else this.startTour(); return; }
    if (e.code === 'KeyR') { if (this.routeK >= 0) this.endRoute(); else this.pickRoute(); return; }
    if (e.code === 'KeyN') { if (this.routeK >= 0) this.goRoute(this.routeK + 1); else if (this.tourK >= 0) this.goStop(this.tourK + 1); return; }
    if (e.code === 'KeyB') { if (this.routeK > 0) this.goRoute(this.routeK - 1); else if (this.tourK > 0) this.goStop(this.tourK - 1); return; }
    if (e.code === 'KeyH') { this.toast(HELP, 10); return; }
    if (e.code === 'Slash') { e.preventDefault(); this.search.show(); this.freeMouse(); return; }
    if (e.code === 'Space' && !e.repeat) {
      // Minecraft: a double tap toggles flight
      if (this.time - this.lastSpace < 0.3) { this.toggleFly(); this.lastSpace = -1; } else this.lastSpace = this.time;
    }
    if (e.code === 'KeyW' && !e.repeat) {
      if (this.time - this.lastW < 0.3) this.sprint = true;
      this.lastW = this.time;
    }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      if (this.aim?.kind === 'code') this.aim.wall.scrollBy(e.code === 'BracketLeft' ? -10 : 10);
      return;
    }
    if (e.code === 'Space') e.preventDefault();
    keyDown.add(e.code);
  }

  // ------------------------------------------------------------------ HUD

  private buildHud() {
    this.hud = document.createElement('div');
    this.hud.id = 'walkhud';
    const cross = document.createElement('div');
    cross.className = 'cross';
    this.prompt = document.createElement('div');
    this.prompt.className = 'prompt';
    this.menu = document.createElement('div');
    this.menu.className = 'tmenu';
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.fx = document.createElement('div');
    this.fx.className = 'tfx';
    const exit = document.createElement('button');
    exit.className = 'wexit';
    exit.textContent = 'Exit walk (Q)';
    exit.onclick = () => this.stop();
    const view = document.createElement('button');
    view.className = 'wview';
    view.textContent = 'View (V)';
    view.onclick = () => { this.firstPerson = !this.firstPerson; };
    const miniWrap = document.createElement('div');
    miniWrap.className = 'wmini';
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = Math.round(184 * devicePixelRatio);
    this.miniLabel = document.createElement('div');
    this.miniLabel.className = 'wminil';
    this.miniLabel.textContent = 'M map';
    miniWrap.append(this.mini, this.miniLabel);
    miniWrap.onclick = () => this.toggleMap();
    this.hud.append(cross, this.prompt, this.menu, this.toastEl, this.fx, exit, view, this.music.button, miniWrap, this.status.root, this.rewards.root,
      this.card.root, this.tourCard.root, this.quizBox.root, this.log.root, this.search.root);
    document.body.append(this.hud);
  }

  // ------------------------------------------------------------------ game setup

  private setupGame() {
    const world = this.host.gameWorld();
    this.game = new Game(world);
    this.game.onReward(r => this.onReward(r));
    this.tour = this.host.tour();
    // props: shards in front of tour stops, gold shards on the roofs of the core modules, a quiz terminal per top directory
    this.props?.dispose();
    const pr = new Props(this.u);
    this.props = pr;
    const u = this.u;
    const placed = new Set<number>();
    for (const st of this.tour) {
      if (placed.has(st.building)) continue;
      const spot = this.frontSpot(st.building);
      if (!spot) continue;
      placed.add(st.building);
      // a few steps along the facade from where the tour drops you, so it is a pickup, not a freebie
      const along = Math.abs(Math.sin(spot.yaw)) < 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      let at = new THREE.Vector3(spot.x, spot.y, spot.z);
      for (const d of [u * 3, -u * 3, u * 2, -u * 2]) {
        const c = at.clone().addScaledVector(along, d);
        if (!this.blockedCity(c.x, c.z, u * 0.38, u * 0.3)) { at = c; break; }
      }
      pr.addShard(st.building, new THREE.Vector3(at.x, this.groundCity(at.x, at.z, 1e9) + u * 0.9, at.z), false, u * 9);
    }
    const golden = new Set<number>();
    for (const i of world.core.slice(0, 3)) {
      if (!this.scene.exists(i)) continue;
      golden.add(i);
      const a = this.scene.buildingAnchor(i, 0);
      pr.addShard(i, a.add(new THREE.Vector3(0, u * 1.1, 0)), true, u * 5);
    }
    // a gold shard crowns each entry point's spire (fly up to it)
    for (const i of world.landmarks.filter(j => this.scene.specOf(j).roof.includes('spire')).slice(0, 2)) {
      if (golden.has(i) || !this.scene.exists(i)) continue;
      pr.addShard(i, this.scene.buildingAnchor(i, 0).add(new THREE.Vector3(0, u * 0.9, 0)), true, u * 5);
    }
    pr.shards.forEach(sh => { if (this.game!.hasShard(sh.building)) { sh.taken = true; sh.group.visible = false; } });
    this.game.shardTotal = pr.shards.length;
    // terminals: on each top directory's street corner (the district padding strip is free of buildings)
    const sites = this.host.topDistricts().slice(0, 14);
    for (const d of sites) {
      const pad = Math.min(3, 0.05 * Math.min(d.w, d.d));
      if (pad < u * 0.5) continue;
      const x = d.x + pad * 0.5, z = d.z + d.d - pad * 0.5;
      if (this.blockedCity(x, z, 0, u * 0.25)) continue;
      pr.addTerminal(d.path, d.name + '/', new THREE.Vector3(x, this.groundCity(x, z, 1e9), z));
    }
    // and one at the spawn point, about the whole city
    const qx = this.pos.x + u * 2.2, qz = this.pos.z - u * 1.5;
    if (!this.blockedCity(qx, qz, 0, u * 0.3)) pr.addTerminal(null, 'QUIZ', new THREE.Vector3(qx, this.groundCity(qx, qz, 1e9), qz));
    this.scene.cityScene.add(pr.group);
    // map
    const o = this.obstacles!;
    this.map = new CityMap(o.boxes.map(b => ({ i: b.i, x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 })), o.plates, this.host.mapLabels(), {
      seen: i => this.game!.isSeen(i),
      studied: i => this.game!.isStudied(i),
      markers: () => this.markers(),
      player: () => {
        if (this.where === 'inside') {
          const b = this.obstacles?.boxes.find(x => x.i === this.inside);
          if (b) return { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, heading: this.avatar.group.rotation.y, yaw: this.yaw };
        }
        return { x: this.pos.x, z: this.pos.z, heading: this.avatar.group.rotation.y, yaw: this.yaw };
      },
    }, [{ x: this.pos.x, z: this.pos.z }], this.scene.roads());
    this.status.update(this.game);
  }

  private markers(): MapMarker[] {
    const out: MapMarker[] = [];
    for (const s of this.props?.shards ?? []) if (!s.taken) out.push({ x: s.pos.x, z: s.pos.z, kind: s.gold ? 'gold' : 'shard' });
    for (const t of this.props?.terminals ?? []) out.push({ x: t.pos.x, z: t.pos.z, kind: 'terminal' });
    const center = (i: number) => { const b = this.obstacles?.boxes.find(x => x.i === i); return b ? { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 } : null; };
    const q = this.game?.activeQuest();
    for (const i of q?.pins?.() ?? []) { if (this.game!.isStudied(i) && q!.id !== 'entry' && q!.id !== 'wiring') continue; const c = center(i); if (c) out.push({ ...c, kind: 'quest' }); }
    if (this.tourK >= 0) this.tour.forEach((st, k) => { const c = center(st.building); if (c) out.push({ ...c, kind: 'tour', label: String(k + 1) }); });
    if (this.routeK >= 0) this.routeSteps.forEach((st, k) => { const c = center(st.building); if (c) out.push({ ...c, kind: 'tour', label: String(k + 1) }); });
    return out;
  }

  private onReward(r: Reward) {
    switch (r.kind) {
      case 'xp': this.rewards.xp(r.amount, r.why); break;
      case 'quest': this.rewards.quest(r.quest); break;
      case 'achievement': this.rewards.achievement(r.a); break;
      case 'rank': this.rewards.rank(r.rank); break;
    }
    if (this.game) this.status.update(this.game);
    this.mapDirty = true;
  }

  private toastTimer = 0;
  toast(text: string, seconds = 3) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.toastTimer = seconds;
  }

  private openMenu(title: string, items: { label: string; sub?: string; go: () => void }[]) {
    this.menuItems = items;
    this.menu.replaceChildren();
    const h = document.createElement('div');
    h.className = 'mtitle';
    h.textContent = title;
    this.menu.append(h);
    items.forEach((it, k) => {
      const b = document.createElement('button');
      const n = document.createElement('span');
      n.className = 'mk';
      n.textContent = String(k + 1);
      const l = document.createElement('span');
      l.className = 'ml';
      l.textContent = it.label;
      b.append(n, l);
      if (it.sub) { const s = document.createElement('span'); s.className = 'ms'; s.textContent = it.sub; b.append(s); }
      b.onclick = () => { this.closeMenu(); it.go(); };
      this.menu.append(b);
    });
    const hint = document.createElement('div');
    hint.className = 'mhint';
    hint.textContent = 'press 1–9 or click · Esc to close';
    this.menu.append(hint);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private closeMenu() { this.menuItems = []; this.menu.replaceChildren(); }

  // ------------------------------------------------------------------ interaction

  /** Primary click: follow what is under the crosshair (or mouse when not captured). */
  private click(fromDrag = false) {
    if (fromDrag && this.dragged) { this.dragged = false; return; }
    this.dragged = false;
    const a = this.aim;
    if (!a) return;
    if (a.kind === 'code' && a.token) this.offerTeleports(a.token, a.line);
    else if (a.kind === 'panel' && a.row?.action) a.row.action();
    else if (a.kind === 'building') this.enter(a.i);
    else if (a.kind === 'floor') this.enterFloor(a.k);
    else if (a.kind === 'gate') this.openGate(a.k);
    else if (a.kind === 'elevator') this.use();
    else if (a.kind === 'exit') this.exitBuilding();
  }

  /** E: enter the building in front / use the elevator / leave. */
  private use() {
    if (this.busy) return;
    if (this.where === 'city') {
      // plane easter egg: board the airport plane
      const ps = this.nearPlane();
      if (ps && !this.piloting) { this.boardPlane(ps); return; }
      const t = this.nearTerminal();
      if (t) { this.openQuiz(t); return; }
      const roof = this.roofUnderfoot();
      if (roof >= 0) { this.useRoof(roof); return; }
      if (this.aim?.kind === 'floor') { this.enterFloor(this.aim.k); return; }
      if (this.aim?.kind === 'gate') { this.openGate(this.aim.k); return; }
      const landed = this.landed.i >= 0 && Math.hypot(this.pos.x - this.landed.x, this.pos.z - this.landed.z) < this.u * 2 ? this.landed.i : -1;
      const i = this.aim?.kind === 'building' ? this.aim.i : landed >= 0 ? landed : this.nearestFacade();
      if (i >= 0) this.enter(i);
      else this.toast('Walk up to a building to enter it');
      return;
    }
    const it = this.interior!;
    if (it.inShaft(this.pos.x, this.pos.z)) {
      const here = it.levelAt(this.pos.y);
      this.elevatorPage = Math.max(0, Math.min(it.levels - 9, here - 4)); // nine floors around the current one
      this.openMenu('ELEVATOR — choose a floor', Array.from({ length: Math.min(9, it.levels) }, (_, k) => {
        const L = this.elevatorPage + k;
        return L < it.levels ? { label: L === 0 ? 'Lobby' : `L${L} · ${it.spec.floors[L - 1].name}`, sub: L === it.levelAt(this.pos.y) ? 'you are here' : '', go: () => this.ride(L) } : null;
      }).filter(Boolean) as { label: string; go: () => void }[]);
      return;
    }
    if (this.aim?.kind === 'exit') { this.exitBuilding(); return; }
    // call the elevator to this floor
    const L = it.levelAt(this.pos.y);
    it.callElevator(L);
    this.toast('Elevator called — step onto the platform and press E');
  }

  /** The building whose rooftop equipment you are standing next to (on its roof), or -1. */
  private roofUnderfoot(): number {
    for (const b of this.obstacles?.solids ?? []) {
      if (Math.abs(this.pos.y - b.top) > this.u * 0.4) continue;
      if (this.pos.x < b.x0 - this.u || this.pos.x > b.x1 + this.u || this.pos.z < b.z0 - this.u || this.pos.z > b.z1 + this.u) continue;
      if (this.scene.specOf(b.i).roof.length && b.top >= this.scene.roofOf(b.i) - 1e-3) return b.i;
    }
    return -1;
  }

  /** Rooftop equipment says what the file does with the outside world. */
  private useRoof(i: number) {
    const lines = this.scene.whyLooks(i).filter(l => l.startsWith('Roof:')).map(l => l.slice(6));
    if (!lines.length) return;
    this.game?.roofVisited(i);
    this.toast(`${this.host.buildingName(i)} · ${lines.join(' · ')} — E on the ground floor to go in, D for the flow view`, 6);
  }

  private elevatorPage = 0;

  /** Standing on the platform while it moves: the platform carries you (however long a frame takes). */
  private riding = false;

  private ride(L: number) {
    const it = this.interior!;
    const dur = it.callElevator(L);
    this.riding = it.inShaft(this.pos.x, this.pos.z) && Math.abs(this.pos.y - it.platformY) < 1.2;
    this.toast(`Going to ${L === 0 ? 'the lobby' : `L${L} · ${it.spec.floors[L - 1].name}`}`, dur + 0.5);
  }

  private offerTeleports(token: string, line: number) {
    if (!this.symbols) { this.toast('Indexing definitions…'); return; }
    const hits = this.lookup(token);
    if (!hits.length) { this.toast(`No definition of “${token}” found in this world`); return; }
    this.openMenu(`TRACE  ${token}`, hits.slice(0, 9).map(s => ({
      label: `${s[0]}  (${s[1]})`,
      sub: `${s[2]}:${s[3]}`,
      go: () => { this.game?.trace(); this.teleport({ building: this.host.buildingByPath(s[2]), line: s[3], label: `${s[0]} — ${s[2]}:${s[3]}` }); },
    })));
    void line;
  }

  /** Definitions for an identifier: same file first, then files this one imports, then the rest. */
  lookup(token: string): Sym[] {
    const all = this.symbols?.get(token) ?? [];
    const here = this.inside >= 0 ? this.host.buildingName(this.inside) : '';
    const imports = new Set((this.inside >= 0 ? this.host.importsOf(this.inside) : []).map(i => this.host.buildingName(i)));
    const rank = (s: Sym) => (s[2] === here ? 0 : imports.has(s[2]) ? 1 : 2);
    return [...all].sort((a, b) => rank(a) - rank(b) || a[2].localeCompare(b[2]) || a[3] - b[3]);
  }

  // ------------------------------------------------------------------ buildings

  private async enter(i: number, dest?: Destination) {
    if (this.busy || i < 0) return;
    this.busy = true;
    this.glitch(0.5);
    try {
      const spec = await this.host.interiorSpec(i, d => this.teleport(d), this.symbols);
      this.leaveInterior();
      this.interior = new Interior(spec);
      this.inside = i;
      this.where = 'inside';
      this.scene.setView(this.interior.scene);
      this.interior.scene.add(this.avatar.group, this.trail.mesh);
      this.trail.clear();
      this.avatar.group.scale.setScalar(1.8);
      const cam = this.scene.camera;
      cam.near = 0.03; cam.far = 220; cam.updateProjectionMatrix();
      this.camDist = 3.4;
      let L = 0;
      if (dest?.line) {
        const k = spec.floors.findIndex(f => dest.line! >= f.start && dest.line! <= f.end);
        L = k >= 0 ? k + 1 : 0;
      }
      const sp = L === 0 ? { pos: new THREE.Vector3(0, 0, 3.6), yaw: 0 } : this.interior.spawn(L);
      this.pos.copy(sp.pos);
      this.yaw = sp.yaw; this.faceCamera();
      this.pitch = L === 0 ? 0.02 : -0.02;
      this.velY = 0;
      this.interior.platformY = 0;
      this.interior.ensureWalls(L);
      this.snapCam = true;
      if (dest?.line && L > 0) this.interior.codeWall(L)?.highlight(dest.line, dest.line);
      this.avatar.materialize();
      this.flying = false;
      this.game?.study(i, 'entered', 10);
      if (this.cardFor >= 0 && this.cardFor !== i) this.closeCard();
      this.toast(L === 0 ? `${spec.path} — ${spec.floors.length} floors · stairs on the right, elevator on the left` : dest?.label ?? '', 4);
    } catch (e) {
      this.toast(`Cannot enter: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private leaveInterior() {
    if (!this.interior) return;
    this.interior.scene.remove(this.avatar.group);
    this.interior.dispose();
    this.interior = null;
    this.scene.setView(null);
  }

  private exitBuilding() {
    if (this.where !== 'inside') return;
    const i = this.inside;
    this.leaveInterior();
    this.where = 'city';
    this.inside = -1;
    this.obstacles = this.scene.walkData();
    this.scene.cityScene.add(this.avatar.group, this.trail.mesh);
    this.trail.clear();
    this.avatar.group.scale.setScalar(this.u);
    const b = this.obstacles.boxes.find(x => x.i === i);
    if (b) {
      this.pos.set((b.x0 + b.x1) / 2, 0, b.z1 + this.u * 1.2);
      this.pos.y = this.groundCity(this.pos.x, this.pos.z, 100);
      this.yaw = Math.PI; this.faceCamera(); // face away from the building
    }
    const cam = this.scene.camera;
    cam.near = Math.max(0.02, this.u * 0.05); cam.far = this.scene.worldSize * 8; cam.updateProjectionMatrix();
    this.camDist = this.u * 3.2;
    this.glitch(0.35);
  }

  /** Building whose facade the player is touching / facing closely, or -1. */
  private nearestFacade(reach = 0.9): number {
    const r = this.u * reach;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw); // camera forward
    let best = -1, bestD = Infinity;
    for (const b of this.obstacles?.boxes ?? []) {
      const dx = Math.max(b.x0 - this.pos.x, 0, this.pos.x - b.x1), dz = Math.max(b.z0 - this.pos.z, 0, this.pos.z - b.z1);
      const d = Math.hypot(dx, dz);
      if (d >= r || b.top - this.pos.y <= this.u * 0.6) continue;
      // prefer what is in front of you over what is behind
      const cx = (b.x0 + b.x1) / 2 - this.pos.x, cz = (b.z0 + b.z1) / 2 - this.pos.z;
      const score = d - ((cx * fx + cz * fz) > 0 ? this.u * 0.8 : 0);
      if (score < bestD) { best = b.i; bestD = score; }
    }
    return best;
  }

  // ------------------------------------------------------------------ teleport (tracer ride)

  teleport(d: Destination) {
    if (this.busy || d.building < 0) return;
    this.closeMenu();
    const sameBuilding = this.where === 'inside' && d.building === this.inside;
    this.busy = true;
    this.glitch(2.6, `TRACING → ${d.label}`);
    if (sameBuilding) {
      // ride a tracer up/down the inside of the tower
      const it = this.interior!;
      const k = it.spec.floors.findIndex(f => d.line !== undefined && d.line >= f.start && d.line <= f.end);
      const L = k >= 0 ? k + 1 : 0;
      const sp = L === 0 ? { pos: new THREE.Vector3(0, 0, 3.6), yaw: 0 } : it.spawn(L);
      const a = this.pos.clone().add(new THREE.Vector3(0, 1, 0)), b = sp.pos.clone().add(new THREE.Vector3(0, 1, 0));
      const mid = new THREE.Vector3(6.8, (a.y + b.y) / 2, 0);
      const path = new THREE.CurvePath<THREE.Vector3>();
      path.add(new THREE.LineCurve3(a, new THREE.Vector3(6.8, a.y, a.z)));
      path.add(new THREE.LineCurve3(new THREE.Vector3(6.8, a.y, a.z), mid));
      path.add(new THREE.LineCurve3(mid, new THREE.Vector3(6.8, b.y, b.z)));
      path.add(new THREE.LineCurve3(new THREE.Vector3(6.8, b.y, b.z), b));
      this.startTracer(it.scene, path, 0.06, 1.2 + Math.abs(a.y - b.y) / 40, () => {
        it.ensureWalls(L);
        this.pos.copy(sp.pos);
        this.yaw = sp.yaw; this.faceCamera();
        this.pitch = -0.02;
        this.velY = 0;
        if (d.line && L > 0) it.codeWall(L)?.highlight(d.line, d.line);
        this.avatar.materialize();
        this.busy = false;
        this.toast(d.label, 3);
      });
      return;
    }
    // across the city: leave the building, race along a circuit route over the skyline, enter the target
    const from = this.where === 'inside' ? this.inside : -1;
    if (this.where === 'inside') {
      this.leaveInterior();
      this.where = 'city';
      this.inside = -1;
      this.scene.cityScene.add(this.avatar.group, this.trail.mesh);
      this.trail.clear();
      this.avatar.group.scale.setScalar(this.u);
    }
    const start = from >= 0 ? this.scene.buildingAnchor(from, 0) : this.pos.clone().add(new THREE.Vector3(0, this.u, 0));
    const end = this.scene.buildingAnchor(d.building, 0);
    const pts = busRoute(start, end, Math.max(start.y, end.y) + this.scene.worldSize * 0.05, d.building);
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let k = 0; k < pts.length - 1; k++) path.add(new THREE.LineCurve3(pts[k], pts[k + 1]));
    const len = path.getLength();
    this.avatar.setVisible(false);
    const cam = this.scene.camera;
    cam.near = 0.05; cam.far = this.scene.worldSize * 8; cam.updateProjectionMatrix();
    this.startTracer(this.scene.cityScene, path, Math.max(0.08, this.scene.worldSize * 0.0025), Math.min(3.2, 1.4 + len / (this.scene.worldSize * 1.2)), () => {
      this.avatar.setVisible(true);
      this.busy = false;
      void this.enter(d.building, d);
    });
  }

  private startTracer(sc: THREE.Scene, curve: THREE.CurvePath<THREE.Vector3>, radius: number, dur: number, done: () => void) {
    this.clearTracer();
    const segs = Math.max(64, Math.round(curve.getLength() / (radius * 2)));
    const geo = new THREE.TubeGeometry(curve as unknown as THREE.Curve<THREE.Vector3>, Math.min(800, segs), radius, 8, false);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uP: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uP; uniform float uTime; varying vec2 vUv;
        void main(){
          float d = uP - vUv.x;                      // distance behind the head
          if (d < 0.0) discard;                      // not drawn yet
          float head = exp(-d * 60.0);
          float trail = exp(-d * 5.0);
          float dash = 0.6 + 0.4 * step(0.5, fract(vUv.x * 120.0 - uTime * 8.0));
          vec3 c = mix(vec3(0.82, 0.24, 1.0), vec3(0.2, 0.9, 1.0), trail) * (0.6 + 3.5 * head) * dash;
          gl_FragColor = vec4(c * 1.3, clamp(0.2 + trail + head, 0.0, 1.0));
        }`,
      transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.8, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.5, 1.9), toneMapped: false }));
    sc.add(mesh, head);
    this.tracer = { mesh, head, mat, curve, t: 0, dur, done };
    this.avatar.setVisible(false);
  }

  private clearTracer() {
    if (!this.tracer) return;
    const { mesh, head } = this.tracer;
    mesh.parent?.remove(mesh); head.parent?.remove(head);
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    head.geometry.dispose(); (head.material as THREE.Material).dispose();
    this.tracer = null;
  }

  private glitch(seconds: number, text = '') {
    this.fx.replaceChildren();
    if (text) {
      const t = document.createElement('div');
      t.className = 'ttext';
      t.textContent = text;
      t.dataset.text = text;
      this.fx.append(t);
    }
    this.fx.classList.remove('on');
    void this.fx.offsetWidth; // restart the CSS animation
    this.fx.style.setProperty('--dur', `${seconds}s`);
    this.fx.classList.add('on');
    window.setTimeout(() => this.fx.classList.remove('on'), seconds * 1000);
  }

  // ------------------------------------------------------------------ explode, cards, map, tour, quiz, search

  /** Release the mouse so panels can be clicked. */
  private freeMouse() { if (document.pointerLockElement) document.exitPointerLock(); }

  /** The building you are looking at, standing in front of, or inside. */
  private focusBuilding(): number {
    if (this.where === 'inside') return this.inside;
    if (this.aim?.kind === 'building') return this.aim.i;
    if (this.aim?.kind === 'floor') return this.scene.explodedBuilding;
    if (this.landed.i >= 0 && Math.hypot(this.pos.x - this.landed.x, this.pos.z - this.landed.z) < this.u * 2) return this.landed.i;
    const near = this.nearestFacade(2);
    if (near >= 0) return near;
    return this.scene.explodingBuilding;
  }

  /** X: take the building apart in place — one floating floor per piece of code — or put it back. */
  private async toggleExplode() {
    if (this.busy) return;
    if (this.where === 'inside') { this.toast('Step outside to take a building apart'); return; }
    const i = this.focusBuilding();
    if (i < 0) { this.toast('Look at a building (or walk up to one) and press X'); return; }
    if (this.scene.explodingBuilding === i) { this.scene.collapse(); this.explodeFloors = []; return; }
    try {
      const floors = await this.host.floors(i);
      if (!floors.length) { this.toast('Nothing to take apart here'); return; }
      this.explodeFloors = floors;
      this.scene.explode(i, floors, false);
      this.game?.study(i, 'exploded', 8);
      this.toast(`${this.host.buildingName(i)} — ${floors.length} pieces. Aim at a floor and click to go in there · fly up between them (double-tap Space)`, 5);
    } catch (e) { this.toast(`Cannot take apart: ${(e as Error).message}`); }
  }

  private enterFloor(k: number) {
    const i = this.scene.explodedBuilding, f = this.explodeFloors[k];
    if (i < 0 || !f) return;
    this.teleport({ building: i, line: f.start, label: `${f.name} — ${this.host.buildingName(i)}${f.start ? `:${f.start}` : ''}` });
  }

  private toggleCard() {
    if (this.card.open) { this.closeCard(); return; }
    const i = this.focusBuilding();
    if (i < 0) { this.toast('Look at a building (or walk up to one) and press I'); return; }
    void this.openCard(i);
  }

  private closeCard() { this.card.hide(); this.cardFor = -1; }

  /** Show the details card for building i; `why` adds a "why it matters" section on top. */
  private async openCard(i: number, why?: string[]) {
    const seq = ++this.cardSeq;
    this.cardFor = i;
    this.card.show({ title: this.host.buildingName(i), subtitle: 'loading…', sections: [] }, () => this.closeCard());
    try {
      const { data, origin } = await this.host.card(i, {
        visit: j => { this.closeCard(); this.travel(j, () => void this.openCard(j)); },
        enterAt: (j, line, label) => { this.closeCard(); this.teleport({ building: j, line, label }); },
      });
      if (seq !== this.cardSeq) return;
      if (why?.length) data.sections.unshift({ title: why[0].toUpperCase(), lines: why.slice(1), tone: 'why' });
      this.card.show(data, () => this.closeCard());
      this.game?.study(i, 'card', 4);
      if (origin) this.game?.readOrigin(i);
    } catch (e) {
      if (seq === this.cardSeq) this.card.show({ title: this.host.buildingName(i), subtitle: (e as Error).message, sections: [] }, () => this.closeCard());
    }
  }

  private toggleMap() {
    if (!this.map) return;
    if (this.map.full) { this.map.closeFull(); return; }
    this.freeMouse();
    this.map.openFull(this.hud, {
      title: () => {
        const e = this.game!.explored();
        return `CITY MAP · ${this.game!.rank.name} · explored ${Math.round(e.loc * 100)}% (${e.files}/${e.total} files) · click a building to travel there`;
      },
      legend: '<span class="lg st"></span>studied <span class="lg se"></span>seen <span class="lg fo"></span>fog ' +
        '<span class="lg sh"></span>shard <span class="lg go"></span>gold shard <span class="lg te">?</span>quiz terminal <span class="lg qu"></span>quest target',
      name: i => this.host.buildingName(i),
      pick: i => { this.map!.closeFull(); this.game?.mapTravel(); this.travel(i, () => void this.openCard(i)); },
      close: () => this.map!.closeFull(),
    });
  }

  /** A free street spot in front of building i (south side first) and the yaw that faces the building. */
  private frontSpot(i: number): { x: number; y: number; z: number; yaw: number } | null {
    const b = this.obstacles?.boxes.find(x => x.i === i);
    if (!b) return null;
    const off = this.u * 1.3, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const sides = [
      { x: cx, z: b.z1 + off, yaw: 0 }, { x: cx, z: b.z0 - off, yaw: Math.PI },
      { x: b.x1 + off, z: cz, yaw: Math.PI / 2 }, { x: b.x0 - off, z: cz, yaw: -Math.PI / 2 },
    ];
    const saved = this.pos.y;
    this.pos.y = 0;
    try {
      for (const sd of sides) {
        if (!this.blockedCity(sd.x, sd.z, this.u * 0.38)) return { ...sd, y: this.groundCity(sd.x, sd.z, this.u * 0.38) };
      }
    } finally { this.pos.y = saved; }
    return { ...sides[0], y: this.scene.roofOf(i) }; // boxed in: stand on the roof
  }

  /** Ride a tracer to the street in front of building i (leaving any interior), then run `then`. */
  travel(i: number, then?: () => void) {
    if (this.busy || i < 0) return;
    const spot = this.frontSpot(i);
    if (!spot) return;
    this.closeMenu();
    const from = this.where === 'inside' ? this.inside : -1;
    if (this.where === 'inside') {
      this.leaveInterior();
      this.where = 'city';
      this.inside = -1;
      this.obstacles = this.scene.walkData();
      this.scene.cityScene.add(this.avatar.group, this.trail.mesh);
      this.trail.clear();
      this.avatar.group.scale.setScalar(this.u);
      const cam = this.scene.camera;
      cam.near = Math.max(0.02, this.u * 0.05); cam.far = this.scene.worldSize * 8; cam.updateProjectionMatrix();
      this.camDist = this.u * 3.2;
    }
    this.busy = true;
    this.flying = false;
    this.glitch(2.2, `ROUTING → ${this.host.buildingName(i)}`);
    const start = from >= 0 ? this.scene.buildingAnchor(from, 0) : this.pos.clone().add(new THREE.Vector3(0, this.u * 0.6, 0));
    const end = new THREE.Vector3(spot.x, spot.y + this.u * 0.6, spot.z);
    const pts = busRoute(start, end, Math.max(start.y, end.y, this.scene.skyline()) + this.scene.worldSize * 0.05, i);
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let k = 0; k < pts.length - 1; k++) if (pts[k].distanceToSquared(pts[k + 1]) > 1e-8) path.add(new THREE.LineCurve3(pts[k], pts[k + 1]));
    const len = path.getLength();
    this.startTracer(this.scene.cityScene, path, Math.max(0.08, this.scene.worldSize * 0.0025), Math.min(3, 1.2 + len / (this.scene.worldSize * 1.2)), () => {
      this.pos.set(spot.x, spot.y, spot.z);
      this.velY = 0; this.grounded = true;
      this.yaw = spot.yaw; this.faceCamera();
      this.pitch = 0.18; // look up at the building
      this.snapCam = true;
      this.landed = { i, x: spot.x, z: spot.z };
      this.avatar.setVisible(true);
      this.avatar.materialize();
      this.busy = false;
      then?.();
    });
  }

  private startTour() {
    if (!this.tour.length) { this.toast('No tour for this city (it needs entry points, imports or docs)'); return; }
    this.goStop(0);
  }

  /** R: every entrance (paged), then each route behind it; the route goes spot by spot (N / B) from its definition. */
  private pickRoute() {
    const doors = this.host.doors().filter(d => d.dir === 'in');
    if (!doors.length) { this.toast('No doors in this city (they need the server and a Go/JS/TS/Python/Rust flow)'); return; }
    this.pagedMenu('ROUTES — pick an entrance', doors.map(d => ({ label: d.label, sub: d.leads > 1 ? `${d.leads} routes` : undefined, go: () => this.chooseLead(d.k) })));
  }

  /** Click / E on an arch: it flares, then its options appear. */
  private openGate(k: number) {
    const d = this.host.doors().find(x => x.k === k);
    if (!d || this.busy) return;
    this.closeMenu();
    this.scene.highlightGate(-1);
    this.scene.highlightGate(k); // restarts the glow
    this.toast(`${d.dir === 'in' ? 'ENTRANCE' : 'EXIT'} · ${d.label}`, 1.2);
    window.setTimeout(() => { if (this.active && !this.busy) this.chooseLead(k); }, 700);
  }

  /** The doors behind one edge gate: one entry per route / table / host, each with its file and line. */
  private chooseLead(k: number) {
    const d = this.host.doors().find(x => x.k === k);
    const leads = this.host.leadsOf(k);
    if (!d || !leads.length) return;
    if (d.dir === 'in' && leads.length === 1) { this.startRoute(k, 0); return; }
    this.pagedMenu(`${d.dir === 'in' ? 'ENTRANCE' : 'EXIT'} — ${d.label}`, leads.map((l, j) => ({
      label: l.label, sub: `${l.path.split('/').slice(-2).join('/')}${l.line ? ':' + l.line : ''}`,
      go: () => d.dir === 'in' ? this.startRoute(k, j) : this.teleport({ building: l.building, line: l.line, label: `${l.label} — ${l.path}${l.line ? ':' + l.line : ''}` }),
    })));
  }

  /** Menu with more than nine entries: eight per page, the ninth turns the page. */
  private pagedMenu(title: string, items: { label: string; sub?: string; go: () => void }[], page = 0) {
    this.freeMouse();
    const per = items.length > 9 ? 8 : 9, pages = Math.ceil(items.length / per);
    const here = items.slice(page * per, page * per + per);
    const list = [...here];
    if (pages > 1) list.push({ label: page + 1 < pages ? 'more ▸' : '◂ first page', sub: `page ${page + 1}/${pages}`, go: () => this.pagedMenu(title, items, (page + 1) % pages) });
    this.openMenu(title, list);
  }

  private startRoute(k: number, doorAt = 0) {
    const r = this.host.doorRoute(k, doorAt);
    if (!r) { this.toast('No route found behind that door'); return; }
    if (this.tourK >= 0) this.endTour();
    this.routeSteps = r.steps; this.routeTitle = r.title;
    this.goRoute(0);
  }

  private endRoute() {
    this.routeK = -1; this.routeSteps = [];
    this.tourCard.hide();
  }

  private goRoute(k: number) {
    if (k >= this.routeSteps.length) { this.toast('End of the route.', 4); this.endRoute(); return; }
    if (k < 0 || this.busy) return;
    this.routeK = k; this.mapDirty = true;
    const s = this.routeSteps[k];
    const kind = s.kind === 'enter' ? 'ENTRANCE' : s.kind === 'out' ? 'EXIT' : 'CODE';
    this.tourCard.show(k, this.routeSteps.length, `${this.routeTitle} · ${kind}`, this.host.buildingName(s.building), [s.label, s.detail], 'N next · B back · E go inside · R end route');
    if (s.line !== undefined) this.teleport({ building: s.building, line: s.line, label: `${s.label}:${s.line}` });
    else this.travel(s.building, () => void this.openCard(s.building, [s.label, s.detail]));
  }

  private endTour() {
    this.tourK = -1;
    this.tourCard.hide();
    this.mapDirty = true;
  }

  private goStop(k: number) {
    if (k >= this.tour.length) {
      this.game?.tourDone();
      this.endTour();
      this.toast('Tour complete! The map (M) and quests (J) take it from here.', 5);
      return;
    }
    if (k < 0 || this.busy) return;
    this.tourK = k;
    const st = this.tour[k];
    const hint = `N next · B back · E go inside · X take apart · T end tour`;
    this.tourCard.show(k, this.tour.length, st.title, this.host.buildingName(st.building), st.why, hint);
    this.travel(st.building, () => void this.openCard(st.building, [st.title, ...st.why]));
  }

  private openQuiz(t: Terminal) {
    if (!this.game) return;
    const byPath = new Map<string, number>();
    this.game.w.files.forEach((f, i) => { if (f) byPath.set(f.path, i); });
    const q = this.game.question(this.symList.length ? this.symList : null, byPath, t.top) ?? this.game.question(this.symList.length ? this.symList : null, byPath, null);
    if (!q) { this.toast('This terminal has no questions yet (needs imports or definitions)'); return; }
    this.freeMouse();
    this.quizBox.show(`QUIZ TERMINAL · ${t.label}`, q, {
      answer: ok => { this.game!.quiz(ok); this.glitch(ok ? 0.3 : 0.15); },
      go: k => { this.quizBox.hide(); const o = q.options[k]; if (o.line) this.teleport({ building: o.building, line: o.line, label: `${o.label}:${o.line}` }); else this.travel(o.building, () => void this.openCard(o.building)); },
      next: () => this.openQuiz(t),
      close: () => this.quizBox.hide(),
    });
  }

  /** Search: files by path, then definitions by name. */
  private find(q: string): SearchHit[] {
    const out: SearchHit[] = [];
    if (!q) {
      return this.tour.slice(0, 8).map((st, k) => ({ label: this.host.buildingName(st.building), sub: `tour ${k + 1} · ${st.title}`,
        go: () => this.travel(st.building, () => void this.openCard(st.building, [st.title, ...st.why])) }));
    }
    for (const i of this.host.searchFiles(q).slice(0, 6)) {
      out.push({ label: this.host.buildingName(i), sub: 'file', go: () => this.travel(i, () => void this.openCard(i)) });
    }
    const lq = q.toLowerCase();
    const syms = this.symList.filter(s => s[0].toLowerCase().includes(lq))
      .sort((a, b) => {
        const ra = a[0].toLowerCase() === lq ? 0 : a[0].toLowerCase().startsWith(lq) ? 1 : 2, rb = b[0].toLowerCase() === lq ? 0 : b[0].toLowerCase().startsWith(lq) ? 1 : 2;
        return ra - rb || a[0].length - b[0].length || a[2].localeCompare(b[2]);
      }).slice(0, 10);
    for (const s of syms) {
      out.push({ label: `${s[0]}  (${s[1]})`, sub: `${s[2]}:${s[3]}`,
        go: () => this.teleport({ building: this.host.buildingByPath(s[2]), line: s[3], label: `${s[0]} — ${s[2]}:${s[3]}` }) });
    }
    return out;
  }

  private resetGame() {
    this.game?.reset();
    this.log.hide();
    this.setupGame();
    this.mapDirty = true;
    this.toast('Progress reset', 2);
  }

  // ------------------------------------------------------------------ per-frame

  private frame(dt: number) {
    this.time += dt;
    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.toastEl.classList.remove('on'); }
    const cam = this.scene.camera;
    this.hudFrame(dt);

    // --- plane flight mode ---
    if (this.piloting && this.planeCtrl) {
      const stillFlying = this.planeCtrl.frame(dt, keyDown);
      if (!stillFlying) this.exitPlane();
      return;
    }

    if (this.tracer) {
      const tr = this.tracer;
      tr.t += dt / tr.dur;
      const e = tr.t < 0.5 ? 2 * tr.t * tr.t : 1 - Math.pow(-2 * tr.t + 2, 2) / 2;
      const p = Math.min(1, e);
      tr.mat.uniforms.uP.value = p;
      tr.mat.uniforms.uTime.value = this.time;
      const at = tr.curve.getPointAt(Math.min(0.999, p));
      const ahead = tr.curve.getPointAt(Math.min(1, p + 0.02));
      tr.head.position.copy(at);
      // chase camera: behind and above the packet, looking along the route
      const dir = ahead.clone().sub(at);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
      dir.normalize();
      const back = this.where === 'inside' ? 3 : Math.max(this.u * 5, this.scene.worldSize * 0.06);
      const want = at.clone().addScaledVector(dir, -back).add(new THREE.Vector3(0, back * 0.6, 0));
      cam.position.lerp(want, Math.min(1, dt * 8));
      cam.lookAt(at.clone().addScaledVector(dir, back));
      cam.fov += ((95 - cam.fov) * Math.min(1, dt * 4));
      cam.updateProjectionMatrix();
      if (tr.t >= 1) {
        const done = tr.done;
        this.clearTracer();
        cam.fov = 70; cam.updateProjectionMatrix();
        done();
      }
      return;
    }

    if (this.interior) this.interior.update(dt);
    this.move(dt);
    this.updateCamera(dt);
    this.updateAim();
    const speed = this.lastSpeed / this.h;
    this.avatar.group.position.copy(this.pos);
    // face the walking direction; after standing still a moment, turn round to look at the camera
    this.idle = this.lastSpeed > 0.05 || !this.grounded ? 0 : this.idle + dt;
    const camYaw = Math.atan2(cam.position.x - this.pos.x, cam.position.z - this.pos.z);
    if (this.firstPerson) this.heading = this.yaw + Math.PI;
    const want = this.idle > 1.6 && !this.firstPerson ? camYaw : this.heading;
    let d = want - this.avatar.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.avatar.group.rotation.y += d * Math.min(1, dt * (this.idle > 1.6 ? 4 : 12));
    this.avatar.setVisible(!this.firstPerson && !this.busy);
    this.avatar.update(dt, speed, !this.grounded && !this.flying, this.flying);
    const running = keyDown.has('ShiftLeft') || keyDown.has('ShiftRight') || this.sprint;
    this.trail.update(dt, this.pos, this.h * 0.32, (running || this.flying) && this.lastSpeed > this.h * 0.5);
    if (this.where === 'city' && this.time - this.lastDoorCheck > 0.3) {
      this.lastDoorCheck = this.time;
      const plane = this.nearPlane();
      const t = this.nearTerminal();
      const near = this.nearestFacade();
      if (plane) this.showPrompt('[E] board the plane ✈');
      else if (t && !this.quizBox.open) this.showPrompt(`[E] quiz terminal · ${t.label}`);
      else if (near >= 0 && this.aim?.kind !== 'building' && this.aim?.kind !== 'floor') this.showPrompt(`[E] enter ${this.host.buildingName(near)} · [X] take apart · [I] info`);
    }
    if (this.where === 'city') this.cityChecks(dt);
  }

  /** Minimap, full map and prop animation (also during tracer rides). */
  private hudFrame(dt: number) {
    this.props?.update(dt, this.time, this.yaw);
    if (!this.map) return;
    if (this.mapDirty && this.time - this.lastMapRender > 0.5) { this.map.invalidate(); this.mapDirty = false; this.lastMapRender = this.time; }
    if (this.time - this.lastMini > 0.066) { this.map.drawMini(this.mini, Math.max(this.u * 28, (this.flying ? this.pos.y : 0) * 1.2 + this.u * 20)); this.lastMini = this.time; }
    if (this.map.full) this.map.drawFull(this.time);
  }
  private lastMapRender = 0;
  private lastMini = 0;

  /** Outdoors: reveal what is near, pick up shards, put taken-apart buildings back when you leave them. */
  private cityChecks(dt: number) {
    this.seeTimer -= dt;
    if (this.seeTimer <= 0 && this.game && this.obstacles) {
      this.seeTimer = 0.25;
      const r = this.u * 22 + Math.max(0, this.pos.y) * 1.5; // higher up, you see further
      for (const b of this.obstacles.boxes) {
        const dx = Math.max(b.x0 - this.pos.x, 0, this.pos.x - b.x1), dz = Math.max(b.z0 - this.pos.z, 0, this.pos.z - b.z1);
        if (dx * dx + dz * dz < r * r && !this.game.isSeen(b.i)) { this.game.see(b.i); this.mapDirty = true; }
      }
    }
    const body = this.pos.clone().add(new THREE.Vector3(0, this.h * 0.5, 0));
    for (const sh of this.props?.shards ?? []) {
      if (sh.taken || sh.pos.distanceTo(body) > this.u * 1.3) continue;
      this.collect(sh);
    }
    const ex = this.scene.explodingBuilding;
    if (ex >= 0) {
      const b = this.obstacles?.boxes.find(x => x.i === ex);
      if (b) {
        const d = Math.hypot(Math.max(b.x0 - this.pos.x, 0, this.pos.x - b.x1), Math.max(b.z0 - this.pos.z, 0, this.pos.z - b.z1));
        if (d > this.u * 40) this.scene.collapse();
      }
    }
  }

  private collect(sh: Shard) {
    this.props!.take(sh);
    if (!this.game!.shard(sh.building)) return;
    this.glitch(0.4);
    const stop = this.tour.find(t => t.building === sh.building);
    this.toast(`${sh.gold ? 'GOLD ' : ''}DATA SHARD · ${this.host.buildingName(sh.building)}`, 3);
    void this.openCard(sh.building, stop ? [stop.title, ...stop.why] : undefined);
  }

  private nearTerminal(): Terminal | null {
    for (const t of this.props?.terminals ?? []) if (Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) < this.u * 1.6 && Math.abs(t.pos.y - this.pos.y) < this.u) return t;
    return null;
  }

  private nearPlane(): THREE.Vector3 | null {
    const spots = this.scene.landmarks?.planeSpots ?? [];
    const thresh = this.scene.cell * 2.8;
    for (const s of spots) {
      if (Math.hypot(s.x - this.pos.x, s.z - this.pos.z) < thresh && Math.abs(s.y - this.pos.y) < this.u * 2) return s;
    }
    return null;
  }

  private boardPlane(spot: THREE.Vector3) {
    if (this.piloting) return;
    this.piloting = true;
    // hide avatar + standard trail
    this.avatar.setVisible(false);
    this.trail.mesh.visible = false;
    // lazily create the controller
    if (!this.planeCtrl) this.planeCtrl = new PlaneMode(this.scene);
    this.planeCtrl.enter(spot.clone(), this.yaw);
    this.toast('✈  PLANE MODE  — W/S pitch · A/D roll · Space throttle+ · Shift throttle- · E land · Q eject', 7);
  }

  private exitPlane() {
    if (!this.piloting || !this.planeCtrl) return;
    this.piloting = false;
    const land = this.planeCtrl.landing;
    this.planeCtrl.dispose();
    // restore avatar visibility
    this.avatar.setVisible(!this.firstPerson && !this.busy);
    this.trail.mesh.visible = true;
    // relocate the player to where the plane landed
    if (land) {
      this.pos.set(land.x, Math.max(0, land.y), land.z);
      this.yaw = land.yaw;
      this.faceCamera();
    }
    // reset camera fov
    const cam = this.scene.camera;
    cam.fov = 70; cam.updateProjectionMatrix();
  }

  private lastSpeed = 0;
  private idle = 0;
  /** Direction the body faces (rotation.y; the model looks down +z). Follows the walking direction. */
  private heading = Math.PI;

  /** Turn the body to face where the camera looks (used at spawn points). */
  private faceCamera() {
    this.heading = this.yaw + Math.PI;
    this.avatar.group.rotation.y = this.heading;
  }

  private move(dt: number) {
    const shift = keyDown.has('ShiftLeft') || keyDown.has('ShiftRight');
    const typing = this.search.open;
    const key = (c: string) => !typing && keyDown.has(c);
    const f = (key('KeyW') || key('ArrowUp') ? 1 : 0) - (key('KeyS') || key('ArrowDown') ? 1 : 0);
    const sd = (key('KeyD') || key('ArrowRight') ? 1 : 0) - (key('KeyA') || key('ArrowLeft') ? 1 : 0);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const dir = fwd.multiplyScalar(f).add(right.multiplyScalar(sd));
    if (dir.lengthSq() > 0) {
      // W/A/S/D move relative to the camera; the body turns to walk that way (S walks towards the camera)
      this.heading = Math.atan2(dir.x, dir.z);
      dir.normalize();
    } else this.sprint = false;
    let v: THREE.Vector3;
    if (this.flying) {
      // creative-mode flight: faster than walking, with a little glide (inertia)
      // cruise speed climbs the longer you hold a direction (x1 -> x3 over ~1.5 s); double-tap W is a further x2.5
      this.flyBoost = dir.lengthSq() > 0 ? Math.min(1.6, this.flyBoost + dt * 0.4) : 1;
      const speed = this.h * 8 * this.flyBoost * (this.sprint ? 2 : 1);
      this.flySpeed = speed;
      this.velH.lerp(dir.clone().multiplyScalar(speed), Math.min(1, dt * 4));
      v = this.velH.clone().multiplyScalar(dt);
    } else {
      const run = shift || this.sprint;
      const speed = this.h * (run ? (this.where === 'city' ? 7 : 5.5) : 2.4);
      v = dir.multiplyScalar(speed * dt);
      this.velH.set(0, 0, 0);
    }
    this.lastSpeed = v.length() / Math.max(dt, 1e-4);

    const step = this.h * 0.38;
    const tryMove = (nx: number, nz: number) => {
      if (this.where === 'inside') {
        const g = this.interior!.ground(nx, nz, this.pos.y, step);
        if (g === -Infinity && this.grounded) return false; // never walk off into nothing... unless jumping
        this.pos.x = nx; this.pos.z = nz;
        return true;
      }
      if (this.blockedCity(nx, nz, step)) return false;
      this.pos.x = nx; this.pos.z = nz;
      return true;
    };
    if (!tryMove(this.pos.x + v.x, this.pos.z)) { if (this.flying) this.velH.x = 0; }
    if (!tryMove(this.pos.x, this.pos.z + v.z)) { if (this.flying) this.velH.z = 0; }
    if (this.where === 'inside' && this.interior!.clamp(this.pos, 0.35)) { this.exitBuilding(); return; }

    // vertical: flight, or gravity / stepping / jumping / elevator
    const g = this.where === 'inside' ? this.interior!.ground(this.pos.x, this.pos.z, this.pos.y, step) : this.groundCity(this.pos.x, this.pos.z, step);
    let ny: number;
    if (this.flying) {
      const up = (key('Space') ? 1 : 0) - (shift && !typing ? 1 : 0);
      // W/S also follow where you look (a dead zone keeps level flight level): look up and fly up
      const tilt = Math.abs(this.pitch) > 0.25 ? Math.sign(this.pitch) * (Math.abs(this.pitch) - 0.25) / 0.9 : 0;
      const climb = f !== 0 ? tilt * f * this.flySpeed : 0;
      this.velY += (up * this.h * 7 + climb - this.velY) * Math.min(1, dt * 5);
      ny = this.pos.y + this.velY * dt;
      const ceiling = this.scene.skyline() * 2 + this.scene.worldSize * 0.6;
      if (ny > ceiling) { ny = ceiling; this.velY = 0; }
      if (ny <= g) { // touching down ends the flight
        ny = g; this.velY = 0;
        if (up <= 0) { this.flying = false; this.grounded = true; this.toast('Landed', 1.2); }
      }
      if (ny > this.scene.skyline() + this.h) this.game?.flewHigh();
    } else {
      if (key('Space') && this.grounded) { this.velY = this.h * 3.6; this.grounded = false; }
      this.velY -= this.h * 11 * dt;
      ny = this.pos.y + this.velY * dt;
      const inShaft = this.where === 'inside' && this.interior!.inShaft(this.pos.x, this.pos.z);
      if (!inShaft) this.riding = false;
      const onElevator = inShaft && (this.riding || Math.abs(this.pos.y - this.interior!.platformY) < 1.2);
      if (this.riding && !this.interior!.elevatorMoving) this.riding = false; // arrived: this frame still lands you on it
      if (onElevator && (this.riding || this.velY <= 0)) { ny = this.interior!.platformY; this.velY = 0; this.grounded = true; }
      else if (ny <= g) { ny = g; this.velY = 0; this.grounded = true; }
      else this.grounded = ny - g < 0.02;
    }
    // heads: floating floors of a taken-apart building are ceilings too
    if (this.where === 'city' && this.velY > 0) {
      const head = this.h * 0.9, r = this.u * 0.22;
      for (const b of this.scene.explodedBoxes()) {
        if (this.pos.x + r > b.x0 && this.pos.x - r < b.x1 && this.pos.z + r > b.z0 && this.pos.z - r < b.z1 &&
          b.y0 >= this.pos.y + head - 1e-3 && ny + head > b.y0) { ny = b.y0 - head; this.velY = 0; }
      }
    }
    if (!isFinite(ny) || ny < -50) { ny = 0; this.velY = 0; } // safety net
    this.pos.y = ny;
    if (this.where === 'inside') this.interior!.ensureWalls(this.interior!.levelAt(this.pos.y));
  }

  private toggleFly() {
    if (this.busy) return;
    if (this.where === 'inside') { this.toast('No flying indoors — take the stairs or the elevator'); return; }
    this.flying = !this.flying;
    this.velY = this.flying ? this.h * 3.5 : 0; // a hop into the air
    this.flyBoost = 1;
    this.grounded = false;
    this.velH.set(0, 0, 0);
    if (this.flying) this.toast('FLYING · W/S go where you look · Space up · Shift down · speeds up slowly · double-tap W boost · F to drop', 4);
  }

  /** Building tiers (setbacks are terraces) plus the floors of a taken-apart building (which replace its tiers). */
  private *cityBoxes(): Generator<{ x0: number; x1: number; z0: number; z1: number; top: number; y0?: number }> {
    const ex = this.scene.explodedBuilding;
    for (const b of this.obstacles?.solids ?? []) if (b.i !== ex) yield b;
    if (ex >= 0) yield* this.scene.explodedBoxes();
  }

  /** Outdoor ground: district plates and roofs (or floating floors) below your feet that you can step onto. */
  private groundCity(x: number, z: number, step: number, from = this.pos.y): number {
    let g = 0;
    for (const p of this.obstacles?.plates ?? []) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) g = Math.max(g, p.top);
    for (const b of this.cityBoxes()) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.top <= from + step) g = Math.max(g, b.top);
    }
    return g;
  }

  private blockedCity(x: number, z: number, step: number, radius?: number): boolean {
    const r = radius ?? this.u * 0.22;
    const head = this.pos.y + this.h * 0.9;
    for (const b of this.cityBoxes()) {
      if (x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && b.top > this.pos.y + step && (b.y0 ?? 0) < head) return true;
    }
    return false;
  }

  private updateCamera(dt: number) {
    const cam = this.scene.camera;
    const eye = this.pos.clone().add(new THREE.Vector3(0, this.h * 0.86, 0));
    const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    if (cam.fov !== 70) { cam.fov += (70 - cam.fov) * Math.min(1, dt * 5); cam.updateProjectionMatrix(); }
    if (this.firstPerson) {
      cam.position.copy(eye);
      cam.lookAt(eye.clone().add(look));
      return;
    }
    const pivot = this.pos.clone().add(new THREE.Vector3(0, this.h * 0.95, 0));
    const shoulder = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(this.h * 0.25);
    pivot.add(shoulder);
    let dist = this.camDist;
    const back = look.clone().multiplyScalar(-1);
    if (this.where === 'city') {
      const hit = this.scene.rayDistance(pivot, back, dist);
      if (hit < dist) dist = Math.max(this.h * 0.4, hit - this.h * 0.2);
    }
    const want = pivot.clone().addScaledVector(back, dist);
    if (this.where === 'inside') {
      const L = this.interior!.levelAt(this.pos.y);
      want.x = Math.max(-7.7, Math.min(7.7, want.x));
      want.z = Math.max(-7.7, Math.min(7.7, want.z));
      want.y = Math.max(L * FH + 0.3, Math.min(L * FH + FH - 0.4, want.y));
    } else {
      // keep the camera above whatever surface is just below it (not the floors stacked above it)
      const floor = this.groundCity(want.x, want.z, this.h * 0.5, want.y);
      if (this.scene.explodedBuilding < 0) want.y = Math.max(want.y, this.groundCity(want.x, want.z, 1e9) + this.h * 0.2);
      else want.y = Math.max(want.y, floor + this.h * 0.2);
    }
    if (this.snapCam) { cam.position.copy(want); this.snapCam = false; } // just arrived: no swoop from the ride camera
    else cam.position.lerp(want, Math.min(1, dt * 12));
    cam.lookAt(pivot.clone().addScaledVector(look, this.h * 2));
  }

  /** What is under the crosshair (or the mouse when it is not captured). */
  private updateAim() {
    const cam = this.scene.camera;
    const ndc = this.locked || this.firstPerson ? new THREE.Vector2(0, 0) : this.mouse;
    this.raycaster.setFromCamera(ndc, cam);
    let aim: WalkMode['aim'] = null;
    if (this.where === 'inside') {
      const hit = this.raycaster.intersectObjects(this.interior!.interactive, false)[0];
      if (hit && hit.distance < 14) {
        const o = hit.object;
        if (o.userData.wall && hit.uv) {
          const w = o.userData.wall as CodeWall;
          const h = w.hit(hit.uv);
          aim = { kind: 'code', wall: w, token: h?.token ?? null, line: h?.line ?? 0 };
        } else if (o.userData.panel && hit.uv) {
          const p = o.userData.panel as TextPanel;
          aim = { kind: 'panel', panel: p, row: p.hitRow(hit.uv) };
        } else if (o.userData.elevator) aim = { kind: 'elevator' };
        else if (o.userData.exit) aim = { kind: 'exit' };
      }
    } else {
      const gk = this.scene.rayGate(this.raycaster.ray.origin, this.raycaster.ray.direction, this.u * 120);
      const k = gk >= 0 ? -1 : this.scene.rayFloor(this.raycaster.ray.origin, this.raycaster.ray.direction, this.u * 60);
      const i = gk >= 0 || k >= 0 ? -1 : this.scene.rayBuilding(this.raycaster.ray.origin, this.raycaster.ray.direction, this.u * 30);
      if (gk >= 0) aim = { kind: 'gate', k: gk };
      else if (k >= 0) aim = { kind: 'floor', k };
      else if (i >= 0) aim = { kind: 'building', i };
    }
    if (this.aim?.kind === 'panel' && (aim?.kind !== 'panel' || aim.panel !== this.aim.panel)) this.aim.panel.clearHover();
    if (this.aim?.kind === 'floor' && aim?.kind !== 'floor') { this.scene.highlightFloor(-1); this.lastFloorHover = -1; }
    if (this.aim?.kind === 'code' && (aim?.kind !== 'code' || aim.wall !== this.aim.wall)) this.aim.wall.setHover(null);
    this.aim = aim;
    switch (aim?.kind) {
      case 'code': this.showPrompt(aim.token ? `click: trace “${aim.token}” · wheel: scroll` : 'wheel: scroll code'); break;
      case 'panel': this.showPrompt(aim.row?.action ? `click: ${aim.row.text}` : ''); break;
      case 'elevator': this.showPrompt(this.interior!.inShaft(this.pos.x, this.pos.z) ? '[E] choose floor' : '[E] call elevator'); break;
      case 'exit': this.showPrompt('click / walk through: back to the city'); break;
      case 'gate': {
        const d = this.host.doors().find(x => x.k === aim.k);
        this.showPrompt(d ? `[E] / click: ${d.dir === 'in' ? 'entrance' : 'exit'} ${d.label} · pick a route` : '');
        break;
      }
      case 'building': this.showPrompt(`[E] / click: enter ${this.host.buildingName(aim.i)} · [X] take apart · [I] info`); break;
      case 'floor': {
        const f = this.explodeFloors[aim.k];
        if (this.lastFloorHover !== aim.k) { this.scene.highlightFloor(aim.k); this.lastFloorHover = aim.k; }
        this.showPrompt(f ? `click: enter at L${aim.k + 1} · ${f.name} (${f.loc} LOC)` : '');
        break;
      }
      default: if (this.where === 'inside' && this.interior!.inShaft(this.pos.x, this.pos.z)) this.showPrompt('[E] choose floor'); else this.showPrompt('');
    }
  }

  private lastFloorHover = -1;
  private snapCam = false;
  /** The building travel last brought you to, and where you landed. */
  private landed = { i: -1, x: 0, z: 0 };

  private showPrompt(text: string) {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.classList.toggle('on', !!text);
  }
}

export type { InteriorFloor };
