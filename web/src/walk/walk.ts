import * as THREE from 'three';
import type { CityScene } from '../scene';
import { busRoute } from '../links';
import { Avatar } from './avatar';
import { LightTrail } from './trail';
import { CodeWall, TextPanel, type PanelRow } from './codewall';
import { FH, Interior, type InteriorFloor, type InteriorSpec } from './interior';

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
}

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
    | { kind: 'elevator' } | { kind: 'exit' } | { kind: 'building'; i: number } | null = null;
  private busy = false; // teleporting / entering
  private savedCam = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 45, near: 0.1, far: 20000 };
  private tracer: { mesh: THREE.Mesh; head: THREE.Mesh; mat: THREE.ShaderMaterial; curve: THREE.CurvePath<THREE.Vector3>; t: number; dur: number; done: () => void } | null = null;
  private raycaster = new THREE.Raycaster();
  private menuItems: { label: string; go: () => void }[] = [];
  private lastDoorCheck = 0;
  private time = 0;
  private listeners: [EventTarget, string, EventListener][] = [];

  constructor(private scene: CityScene, private host: WalkHost) {}

  /** Outdoor scale: body height in city units. */
  private get u() { return Math.max(0.5, this.scene.cell * 1.6); }
  private get h() { return this.where === 'inside' ? 1.8 : this.u; }

  // ------------------------------------------------------------------ lifecycle

  start() {
    if (this.active || !this.scene.loaded) return;
    this.active = true;
    document.body.classList.add('walking');
    const cam = this.scene.camera;
    this.savedCam = { pos: cam.position.clone(), target: this.scene.controls.target.clone(), fov: cam.fov, near: cam.near, far: cam.far };
    this.scene.stopFly();
    this.scene.controls.enabled = false;
    this.obstacles = this.scene.walkData();
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
    this.yaw = 0;
    this.pitch = -0.08;
    this.camDist = this.u * 3.2;
    this.avatar.group.scale.setScalar(this.u);
    this.scene.cityScene.add(this.avatar.group, this.trail.mesh);
    this.avatar.materialize();
    cam.fov = 70;
    cam.near = Math.max(0.02, this.u * 0.05);
    cam.far = this.scene.worldSize * 8;
    cam.updateProjectionMatrix();
    this.scene.onFrame = dt => this.frame(dt);
    this.bindInput();
    this.toast('WASD move · mouse look (click to capture) · Shift run · Space jump · V view · E enter/use · wheel scroll code · Q exit', 6);
    void this.host.symbols().then(list => {
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
    document.body.classList.remove('walking');
    if (document.pointerLockElement) document.exitPointerLock();
    this.leaveInterior();
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
    this.on(window, 'keyup', e => keyDown.delete((e as KeyboardEvent).code));
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
      else if (!this.firstPerson) this.camDist = Math.max(this.h * 1.2, Math.min(this.h * 9, this.camDist * (w.deltaY > 0 ? 1.12 : 0.89)));
    }, { passive: false });
  }

  private mouse = new THREE.Vector2(0, 0);
  private dragged = false;

  private keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    e.stopImmediatePropagation(); // walk mode owns the keyboard
    if (this.menuItems.length && /^Digit[1-9]$/.test(e.code)) {
      const it = this.menuItems[Number(e.code.slice(5)) - 1];
      if (it) { this.closeMenu(); it.go(); }
      return;
    }
    if (e.code === 'Escape') { if (this.menuItems.length) this.closeMenu(); return; }
    if (e.code === 'KeyQ') { this.stop(); return; }
    if (e.code === 'KeyV') { this.firstPerson = !this.firstPerson; return; }
    if (e.code === 'KeyE') { this.use(); return; }
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
    this.hud.append(cross, this.prompt, this.menu, this.toastEl, this.fx, exit, view);
    document.body.append(this.hud);
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
    else if (a.kind === 'elevator') this.use();
    else if (a.kind === 'exit') this.exitBuilding();
  }

  /** E: enter the building in front / use the elevator / leave. */
  private use() {
    if (this.busy) return;
    if (this.where === 'city') {
      const i = this.aim?.kind === 'building' ? this.aim.i : this.nearestFacade();
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

  private elevatorPage = 0;

  private ride(L: number) {
    const it = this.interior!;
    const dur = it.callElevator(L);
    this.toast(`Going to ${L === 0 ? 'the lobby' : `L${L} · ${it.spec.floors[L - 1].name}`}`, dur + 0.5);
  }

  private offerTeleports(token: string, line: number) {
    if (!this.symbols) { this.toast('Indexing definitions…'); return; }
    const hits = this.lookup(token);
    if (!hits.length) { this.toast(`No definition of “${token}” found in this world`); return; }
    this.openMenu(`TRACE  ${token}`, hits.slice(0, 9).map(s => ({
      label: `${s[0]}  (${s[1]})`,
      sub: `${s[2]}:${s[3]}`,
      go: () => this.teleport({ building: this.host.buildingByPath(s[2]), line: s[3], label: `${s[0]} — ${s[2]}:${s[3]}` }),
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
      this.yaw = sp.yaw;
      this.pitch = L === 0 ? 0.02 : -0.02;
      this.velY = 0;
      this.interior.platformY = 0;
      this.interior.ensureWalls(L);
      if (dest?.line && L > 0) this.interior.codeWall(L)?.highlight(dest.line, dest.line);
      this.avatar.materialize();
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
      this.yaw = Math.PI; // face away from the building
    }
    const cam = this.scene.camera;
    cam.near = Math.max(0.02, this.u * 0.05); cam.far = this.scene.worldSize * 8; cam.updateProjectionMatrix();
    this.camDist = this.u * 3.2;
    this.glitch(0.35);
  }

  /** Building whose facade the player is touching / facing closely, or -1. */
  private nearestFacade(): number {
    const r = this.u * 0.9;
    let best = -1, bestD = Infinity;
    for (const b of this.obstacles?.boxes ?? []) {
      const dx = Math.max(b.x0 - this.pos.x, 0, this.pos.x - b.x1), dz = Math.max(b.z0 - this.pos.z, 0, this.pos.z - b.z1);
      const d = Math.hypot(dx, dz);
      if (d < r && d < bestD && b.top - this.pos.y > this.u * 0.6) { best = b.i; bestD = d; }
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
        this.yaw = sp.yaw;
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

  // ------------------------------------------------------------------ per-frame

  private frame(dt: number) {
    this.time += dt;
    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.toastEl.classList.remove('on'); }
    const cam = this.scene.camera;

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
    const want = this.idle > 1.6 && !this.firstPerson ? camYaw : this.yaw + Math.PI;
    let d = want - this.avatar.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.avatar.group.rotation.y += d * Math.min(1, dt * (this.idle > 1.6 ? 4 : 14));
    this.avatar.setVisible(!this.firstPerson && !this.busy);
    this.avatar.update(dt, speed, !this.grounded);
    const running = keyDown.has('ShiftLeft') || keyDown.has('ShiftRight');
    this.trail.update(dt, this.pos, this.h * 0.32, running && this.lastSpeed > this.h * 0.5);
    if (this.where === 'city' && this.time - this.lastDoorCheck > 0.3) {
      this.lastDoorCheck = this.time;
      const near = this.nearestFacade();
      if (near >= 0 && this.aim?.kind !== 'building') this.showPrompt(`[E] enter ${this.host.buildingName(near)}`);
    }
  }

  private lastSpeed = 0;
  private idle = 0;

  private move(dt: number) {
    const run = keyDown.has('ShiftLeft') || keyDown.has('ShiftRight');
    const speed = this.h * (run ? 5.5 : 2.4);
    const f = (keyDown.has('KeyW') || keyDown.has('ArrowUp') ? 1 : 0) - (keyDown.has('KeyS') || keyDown.has('ArrowDown') ? 1 : 0);
    const s = (keyDown.has('KeyD') || keyDown.has('ArrowRight') ? 1 : 0) - (keyDown.has('KeyA') || keyDown.has('ArrowLeft') ? 1 : 0);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const v = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
    if (v.lengthSq() > 0) v.normalize().multiplyScalar(speed * dt);
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
    if (!tryMove(this.pos.x + v.x, this.pos.z)) { /* slide along z */ }
    if (!tryMove(this.pos.x, this.pos.z + v.z)) { /* slide along x */ }
    if (this.where === 'inside' && this.interior!.clamp(this.pos, 0.35)) { this.exitBuilding(); return; }

    // vertical: gravity, stepping, jumping, elevator
    if (keyDown.has('Space') && this.grounded) { this.velY = this.h * 3.6; this.grounded = false; }
    const g = this.where === 'inside' ? this.interior!.ground(this.pos.x, this.pos.z, this.pos.y, step) : this.groundCity(this.pos.x, this.pos.z, step);
    this.velY -= this.h * 11 * dt;
    let ny = this.pos.y + this.velY * dt;
    const onElevator = this.where === 'inside' && this.interior!.inShaft(this.pos.x, this.pos.z) && Math.abs(this.pos.y - this.interior!.platformY) < 1.2;
    if (onElevator && this.velY <= 0) { ny = this.interior!.platformY; this.velY = 0; this.grounded = true; }
    else if (ny <= g) { ny = g; this.velY = 0; this.grounded = true; }
    else this.grounded = ny - g < 0.02;
    if (!isFinite(ny) || ny < -50) { ny = 0; this.velY = 0; } // safety net
    this.pos.y = ny;
    if (this.where === 'inside') this.interior!.ensureWalls(this.interior!.levelAt(this.pos.y));
  }

  /** Outdoor ground: district plates and low building tops you can step onto. */
  private groundCity(x: number, z: number, step: number): number {
    let g = 0;
    for (const p of this.obstacles?.plates ?? []) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) g = Math.max(g, p.top);
    for (const b of this.obstacles?.boxes ?? []) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.top <= this.pos.y + step) g = Math.max(g, b.top);
    }
    return g;
  }

  private blockedCity(x: number, z: number, step: number): boolean {
    const r = this.u * 0.22;
    for (const b of this.obstacles?.boxes ?? []) {
      if (x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1 && b.top > this.pos.y + step) return true;
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
      want.y = Math.max(want.y, this.groundCity(want.x, want.z, 1e9) + this.h * 0.2);
    }
    cam.position.lerp(want, Math.min(1, dt * 12));
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
      const i = this.scene.rayBuilding(this.raycaster.ray.origin, this.raycaster.ray.direction, this.u * 12);
      if (i >= 0) aim = { kind: 'building', i };
    }
    if (this.aim?.kind === 'panel' && (aim?.kind !== 'panel' || aim.panel !== this.aim.panel)) this.aim.panel.clearHover();
    if (this.aim?.kind === 'code' && (aim?.kind !== 'code' || aim.wall !== this.aim.wall)) this.aim.wall.setHover(null);
    this.aim = aim;
    switch (aim?.kind) {
      case 'code': this.showPrompt(aim.token ? `click: trace “${aim.token}” · wheel: scroll` : 'wheel: scroll code'); break;
      case 'panel': this.showPrompt(aim.row?.action ? `click: ${aim.row.text}` : ''); break;
      case 'elevator': this.showPrompt(this.interior!.inShaft(this.pos.x, this.pos.z) ? '[E] choose floor' : '[E] call elevator'); break;
      case 'exit': this.showPrompt('click / walk through: back to the city'); break;
      case 'building': this.showPrompt(`[E] / click: enter ${this.host.buildingName(aim.i)}`); break;
      default: if (this.where === 'inside' && this.interior!.inShaft(this.pos.x, this.pos.z)) this.showPrompt('[E] choose floor'); else this.showPrompt('');
    }
  }

  private showPrompt(text: string) {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.classList.toggle('on', !!text);
  }
}

export type { InteriorFloor };
