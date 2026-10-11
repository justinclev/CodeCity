import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CodeWall, TextPanel, type PanelRow } from './codewall';
import { circuitMaterial } from '../material';

/** One storey: a piece of the file (function, class, method …). */
export interface InteriorFloor { name: string; kind: string; start: number; end: number; loc: number; complexity: number; piece: number }

export interface InteriorSpec {
  path: string;
  lang: string;
  lines: string[];         // whole file
  floors: InteriorFloor[]; // level k (1-based) = floors[k-1]
  lobby: PanelRow[];       // file info, imports, imported-by (with teleport actions)
  directory: PanelRow[];   // one row per floor (elevator shortcuts)
  references: (floor: InteriorFloor) => PanelRow[]; // identifiers defined elsewhere (teleport actions)
  glyphs: THREE.Texture | null;
  circuit: THREE.Texture | null;
  /** The building's architecture inside: finish (material), the tier of each storey, the roof. */
  arch?: InteriorArch;
}

export interface InteriorArch {
  facade: string;          // architecture.ts Facade
  finish: string;          // wall accent color
  tiers: { name: string; s: number; color: string }[];
  tierOf: number[];        // per floor (level k = tierOf[k-1])
  roof: string[];          // what the rooftop equipment means
}

// Layout (interior units ≈ metres; the player is 1.8 tall)
export const HALF = 8;          // plate is 16 × 16
export const FH = 4.5;          // storey height
const SHAFT = { x0: -8, x1: -5, z0: 5, z1: 8 };        // elevator, south-west corner
const LANE_A = { x0: 5.6, x1: 8 }, LANE_B = { x0: 3.2, x1: 5.6 };
const STAIR_Z0 = -5, STAIR_Z1 = 5, STEPS = 18;
const DOOR_W = 1.6;

const laneOf = (k: number) => (k % 2 === 0 ? LANE_A : LANE_B);

/** Stair k climbs from level k to k+1: even k rises toward -z, odd k toward +z (a switchback). */
function stairHeight(k: number, z: number) {
  const t = k % 2 === 0 ? (STAIR_Z1 - z) / (STAIR_Z1 - STAIR_Z0) : (z - STAIR_Z0) / (STAIR_Z1 - STAIR_Z0);
  return k * FH + Math.max(0, Math.min(1, t)) * FH;
}

export class Interior {
  readonly scene = new THREE.Scene();
  readonly levels: number;
  private walls = new Map<number, { code?: CodeWall; info?: TextPanel; sign: THREE.Sprite }>();
  readonly interactive: THREE.Object3D[] = [];
  private platform: THREE.Mesh;
  platformY = 0;
  private platformTarget = 0;
  private disposables: { dispose(): void }[] = [];
  private lobbyInfo: TextPanel;
  private directory: TextPanel;
  readonly exitPortal: THREE.Mesh;
  private time = 0;
  private pulses: THREE.Mesh[] = [];

  constructor(readonly spec: InteriorSpec) {
    this.levels = spec.floors.length + 1;
    const top = this.levels * FH;
    const sc = this.scene;
    sc.background = new THREE.Color('#000208');
    sc.fog = new THREE.Fog('#000208', 18, 60);
    sc.add(new THREE.HemisphereLight('#6080ff', '#000000', 0.9));
    const key = new THREE.PointLight('#5ff0ff', 8, 26, 1.6);
    key.position.set(0, 3.5, 0);
    sc.add(key);
    this.disposables.push(key);

    // ---- floors (slabs with holes for stairs and the elevator), world-space circuit uvs
    // glossy black floor with the same neon grid + circuit traces as the city
    const fm = circuitMaterial('#02030a', false);
    fm.uniforms.uHacker.value = 1;
    fm.uniforms.uCircuit.value = spec.circuit;
    fm.uniforms.uTile.value = 16;
    fm.uniforms.uRadius.value = 40;
    fm.material.roughness = 0.2;
    fm.material.metalness = 0.8;
    const floorMat = fm.material;
    const ceilMat = new THREE.MeshStandardMaterial({ color: '#02030a', roughness: 0.9 });
    this.disposables.push(floorMat, ceilMat);
    for (let L = 0; L < this.levels; L++) {
      const tops: THREE.BufferGeometry[] = [], bottoms: THREE.BufferGeometry[] = [];
      for (const [x0, x1, z0, z1] of this.slabRects(L)) {
        const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, L * FH, (z0 + z1) / 2);
        const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
        for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 7, pos.getZ(i) / 7);
        tops.push(g);
        // underside (ceiling of the storey below), facing down; built directly so z is not mirrored
        if (L > 0) bottoms.push(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(Math.PI / 2).translate((x0 + x1) / 2, L * FH - 0.12, (z0 + z1) / 2));
      }
      const t = new THREE.Mesh(mergeGeometries(tops), floorMat);
      t.receiveShadow = true;
      sc.add(t);
      this.disposables.push(t.geometry);
      if (bottoms.length) { const b = new THREE.Mesh(mergeGeometries(bottoms), ceilMat); sc.add(b); this.disposables.push(b.geometry); }
    }
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(16, 16).rotateX(Math.PI / 2).translate(0, top - 0.05, 0), ceilMat);
    sc.add(roof);
    this.disposables.push(roof.geometry);

    // ---- walls: dark glass with drifting data glyphs
    const glyph = spec.glyphs?.clone();
    if (glyph) { glyph.wrapS = glyph.wrapT = THREE.RepeatWrapping; glyph.repeat.set(16 / 5, top / 5); glyph.needsUpdate = true; this.disposables.push(glyph); }
    const arch = spec.arch;
    const finish = new THREE.Color(arch?.finish ?? '#2ad4ff');
    const wallMat = new THREE.MeshStandardMaterial({ color: '#01030a', roughness: 0.25, metalness: 0.4, side: THREE.DoubleSide,
      emissive: finish.clone().lerp(new THREE.Color('#2ad4ff'), 0.4), emissiveMap: glyph ?? null, emissiveIntensity: glyph ? 0.12 : 0 });
    this.disposables.push(wallMat);
    // the facade's material, drawn as a faint pattern on the inside of the walls (brick courses, concrete grid, steel bracing, …)
    const pattern = arch ? finishTexture(arch.facade) : null;
    let patMat: THREE.MeshBasicMaterial | null = null;
    if (pattern) {
      pattern.repeat.set(16 / 4, top / 4);
      patMat = new THREE.MeshBasicMaterial({ map: pattern, color: finish.clone().multiplyScalar(0.32), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      this.disposables.push(pattern, patMat);
    }
    const wall = (w: number, rotY: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, top), wallMat);
      m.position.set(x, top / 2, z);
      m.rotation.y = rotY;
      sc.add(m);
      this.disposables.push(m.geometry);
      if (patMat) {
        const p = new THREE.Mesh(m.geometry, patMat);
        p.position.copy(m.position).multiplyScalar(0.996);
        p.position.y = top / 2;
        p.rotation.y = rotY;
        p.renderOrder = 1;
        sc.add(p);
      }
    };
    wall(16, 0, 0, -HALF);
    wall(16, Math.PI, 0, HALF);
    wall(16, Math.PI / 2, -HALF, 0);
    wall(16, -Math.PI / 2, HALF, 0);

    // ---- neon edges: corners + every storey line, pulsing
    const neon = (color: string) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.3), toneMapped: false });
    const cyan = neon('#36e0ff'), magenta = neon('#d23cff');
    this.disposables.push(cyan, magenta);
    for (const [x, z] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, top, 0.08), cyan);
      post.position.set(x * 0.995, top / 2, z * 0.995);
      sc.add(post);
      this.disposables.push(post.geometry);
    }
    for (let L = 0; L < this.levels; L++) {
      for (const [w, rot, x, z] of [[16, 0, 0, -HALF + 0.03], [16, 0, 0, HALF - 0.03], [16, Math.PI / 2, -HALF + 0.03, 0], [16, Math.PI / 2, HALF - 0.03, 0]] as const) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.05), L % 2 ? magenta : cyan);
        strip.position.set(x, L * FH + 0.03, z);
        strip.rotation.y = rot;
        sc.add(strip);
        this.disposables.push(strip.geometry);
        if (L === 0) this.pulses.push(strip);
      }
    }

    // ---- stairs: instanced steps with glowing nosings
    const flights = this.levels - 1;
    if (flights > 0) {
      const tread = (STAIR_Z1 - STAIR_Z0) / STEPS, riser = FH / STEPS;
      const stepMat = new THREE.MeshStandardMaterial({ color: '#0a1020', roughness: 0.5, metalness: 0.5 });
      const steps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), stepMat, flights * STEPS);
      const noses = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 0.04), cyan, flights * STEPS);
      const m = new THREE.Object3D();
      let n = 0;
      for (let k = 0; k < flights; k++) {
        const lane = laneOf(k);
        const w = lane.x1 - lane.x0, cx = (lane.x0 + lane.x1) / 2;
        for (let s = 0; s < STEPS; s++) {
          const yTop = k * FH + (s + 1) * riser;
          const z = k % 2 === 0 ? STAIR_Z1 - (s + 0.5) * tread : STAIR_Z0 + (s + 0.5) * tread;
          m.position.set(cx, yTop - riser / 2, z);
          m.scale.set(w - 0.1, riser, tread);
          m.updateMatrix();
          steps.setMatrixAt(n, m.matrix);
          m.position.set(cx, yTop, z + (k % 2 === 0 ? tread / 2 : -tread / 2));
          m.scale.set(w - 0.1, 1, 1);
          m.updateMatrix();
          noses.setMatrixAt(n, m.matrix);
          n++;
        }
      }
      sc.add(steps, noses);
      this.disposables.push(stepMat, steps.geometry, noses.geometry);
    }

    // ---- elevator: glass shaft + platform
    const glass = new THREE.MeshStandardMaterial({ color: '#36e0ff', transparent: true, opacity: 0.08, roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false });
    this.disposables.push(glass);
    const shaftW = SHAFT.x1 - SHAFT.x0, shaftD = SHAFT.z1 - SHAFT.z0;
    const n1 = new THREE.Mesh(new THREE.PlaneGeometry(shaftW, top), glass);
    n1.position.set((SHAFT.x0 + SHAFT.x1) / 2, top / 2, SHAFT.z0);
    sc.add(n1);
    const e1 = new THREE.Mesh(new THREE.PlaneGeometry(shaftD, top), glass);
    e1.rotation.y = Math.PI / 2;
    e1.position.set(SHAFT.x1, top / 2, (SHAFT.z0 + SHAFT.z1) / 2);
    sc.add(e1);
    for (const [x, z] of [[SHAFT.x1, SHAFT.z0]]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, top, 0.06), magenta);
      rail.position.set(x, top / 2, z);
      sc.add(rail);
      this.disposables.push(rail.geometry);
    }
    this.disposables.push(n1.geometry, e1.geometry);
    const platMat = new THREE.MeshStandardMaterial({ color: '#0a1428', metalness: 0.7, roughness: 0.3, emissive: '#d23cff', emissiveIntensity: 0.25 });
    this.platform = new THREE.Mesh(new THREE.BoxGeometry(shaftW - 0.15, 0.18, shaftD - 0.15), platMat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.04, 6, 40).rotateX(Math.PI / 2), magenta);
    ring.position.y = 0.1;
    this.platform.add(ring);
    this.platform.position.set((SHAFT.x0 + SHAFT.x1) / 2, -0.09, (SHAFT.z0 + SHAFT.z1) / 2);
    this.platform.userData.elevator = true;
    sc.add(this.platform);
    this.interactive.push(this.platform);
    this.disposables.push(platMat, this.platform.geometry, ring.geometry);

    // ---- exit portal on the lobby's south wall
    const portalMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.0, 1.4), transparent: true, opacity: 0.5, toneMapped: false, side: THREE.DoubleSide });
    this.exitPortal = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, 2.6), portalMat);
    this.exitPortal.position.set(0, 1.3, HALF - 0.04);
    this.exitPortal.userData.exit = true;
    sc.add(this.exitPortal);
    this.interactive.push(this.exitPortal);
    this.disposables.push(portalMat, this.exitPortal.geometry);
    const exitSign = textSprite('EXIT ▸ CITY', 0.4, '#5ff0ff');
    exitSign.position.set(0, 2.95, HALF - 0.3);
    sc.add(exitSign);

    // ---- lobby: file info + directory, big hologram title
    this.lobbyInfo = new TextPanel(9, 3.8, spec.lobby, spec.path.split('/').pop() ?? spec.path);
    this.lobbyInfo.mesh.position.set(-HALF + 0.05, 2.1, -1.5);
    this.lobbyInfo.mesh.rotation.y = Math.PI / 2;
    this.directory = new TextPanel(10.4, 3.8, spec.directory, 'DIRECTORY');
    this.directory.mesh.position.set(-2.4, 2.1, -HALF + 0.05);
    sc.add(this.lobbyInfo.mesh, this.directory.mesh);
    this.interactive.push(this.lobbyInfo.mesh, this.directory.mesh);
    this.disposables.push(this.lobbyInfo, this.directory);
    const title = textSprite(spec.path, 0.55, '#bff8ff');
    title.position.set(0, 3.6, 0);
    sc.add(title);

    for (let L = 1; L < this.levels; L++) {
      const f = spec.floors[L - 1];
      const tier = arch?.tiers[arch.tierOf[L - 1] ?? 0];
      const sign = textSprite(`L${L} · ${f.name}${tier && arch!.tiers.length > 1 ? `   ▣ ${tier.name}` : ''}`, 0.42, tier && arch!.tiers.length > 1 ? tier.color : L % 2 ? '#ff8adf' : '#5ff0ff');
      sign.position.set(4.4, L * FH + 3.4, -6.6);
      sc.add(sign);
      this.walls.set(L, { sign });
    }
    if (arch) this.buildTiers(arch, top);
  }

  /**
   * Tiers inside: every storey wears its tier's accent (a band along the walls), and storeys of
   * a set-back tier show where the facade steps in — a glowing outline with the terrace beyond it.
   */
  private buildTiers(arch: InteriorArch, top: number) {
    const sc = this.scene;
    const lineMats = new Map<string, THREE.MeshBasicMaterial>();
    const mat = (c: string) => {
      let m = lineMats.get(c);
      if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.2), toneMapped: false }); lineMats.set(c, m); this.disposables.push(m); }
      return m;
    };
    const terraceMat = new THREE.MeshBasicMaterial({ color: '#0b2a33', transparent: true, opacity: 0.35, depthWrite: false });
    this.disposables.push(terraceMat);
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(box);
    for (let L = 1; L < this.levels; L++) {
      const t = arch.tiers[arch.tierOf[L - 1] ?? 0];
      if (!t || arch.tiers.length < 2) continue;
      const m = mat(t.color);
      // tier band along the walls, just under the ceiling
      for (const [w, rot, x, z] of [[16, 0, 0, -HALF + 0.06], [16, 0, 0, HALF - 0.06], [16, Math.PI / 2, -HALF + 0.06, 0], [16, Math.PI / 2, HALF - 0.06, 0]] as const) {
        const band = new THREE.Mesh(box, m);
        band.scale.set(w, 0.12, 0.03);
        band.position.set(x, L * FH + FH - 0.35, z);
        band.rotation.y = rot;
        sc.add(band);
      }
      if (t.s > 0.97) continue;
      // setback: the tier's footprint as a glowing outline on the floor; beyond it, the terrace
      const half = Math.max(5.5, HALF * t.s), y = L * FH + 0.025;
      for (const [sx, sz, x, z] of [[half * 2, 0.06, 0, -half], [half * 2, 0.06, 0, half], [0.06, half * 2, -half, 0], [0.06, half * 2, half, 0]] as const) {
        const ln = new THREE.Mesh(box, m);
        ln.scale.set(sx, 0.03, sz);
        ln.position.set(x, y, z);
        sc.add(ln);
      }
      for (const [x0, x1, z0, z1] of [[-HALF, HALF, -HALF, -half], [-HALF, HALF, half, HALF], [-HALF, -half, -half, half], [half, HALF, -half, half]]) {
        if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
        const p = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), terraceMat);
        p.position.set((x0 + x1) / 2, y + 0.005, (z0 + z1) / 2);
        sc.add(p);
        this.disposables.push(p.geometry);
      }
      if ((arch.tierOf[L - 2] ?? -1) !== arch.tierOf[L - 1]) { // the first storey of a set-back tier
        const lab = textSprite(`TERRACE · ${t.name} steps in`, 0.3, t.color);
        lab.position.set(0, y + 0.4, -half - (HALF - half) / 2);
        sc.add(lab);
      }
    }
    // the roof: what the equipment up there says about this code
    if (arch.roof.length) {
      const rows = ['ROOF ▲', ...arch.roof];
      rows.forEach((t, k) => {
        const sp = textSprite(t, k === 0 ? 0.42 : 0.32, '#ffd23c');
        sp.position.set(0, top - 0.6 - k * 0.42, 0);
        sc.add(sp);
      });
    }
  }

  // ------------------------------------------------------------ geometry helpers

  /** Rectangles [x0,x1,z0,z1] of level L's floor, minus the stair opening and elevator shaft. */
  private slabRects(L: number): [number, number, number, number][] {
    const holes: [number, number, number, number][] = [];
    if (L > 0) {
      holes.push([SHAFT.x0, SHAFT.x1, SHAFT.z0, SHAFT.z1]);
      const lane = laneOf(L - 1);
      holes.push([lane.x0, lane.x1, STAIR_Z0, STAIR_Z1]);
    }
    const xs = [...new Set([-HALF, HALF, ...holes.flatMap(h => [h[0], h[1]])])].sort((a, b) => a - b);
    const zs = [...new Set([-HALF, HALF, ...holes.flatMap(h => [h[2], h[3]])])].sort((a, b) => a - b);
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (!holes.some(h => cx > h[0] && cx < h[1] && cz > h[2] && cz < h[3])) out.push([xs[i], xs[i + 1], zs[j], zs[j + 1]]);
    }
    return out;
  }

  levelY(L: number) { return L * FH; }
  levelAt(y: number) { return Math.max(0, Math.min(this.levels - 1, Math.floor((y + 0.6) / FH))); }

  /** Highest walkable surface at (x,z) that is at most `step` above y. */
  ground(x: number, z: number, y: number, step = 0.7): number {
    let best = -Infinity;
    const consider = (h: number) => { if (h <= y + step && h > best) best = h; };
    const inShaft = x > SHAFT.x0 && x < SHAFT.x1 && z > SHAFT.z0 && z < SHAFT.z1;
    if (inShaft) consider(this.platformY);
    for (let L = 0; L < this.levels; L++) {
      if (L > 0 && inShaft) continue;
      if (L > 0) {
        const lane = laneOf(L - 1);
        if (x > lane.x0 && x < lane.x1 && z > STAIR_Z0 && z < STAIR_Z1) continue; // stair opening
      }
      consider(L * FH);
    }
    for (let k = 0; k < this.levels - 1; k++) {
      const lane = laneOf(k);
      if (x > lane.x0 && x < lane.x1 && z >= STAIR_Z0 && z <= STAIR_Z1) consider(stairHeight(k, z));
    }
    return best;
  }

  /** Keep the player inside the plate. Returns true when walking out through the lobby door. */
  clamp(p: THREE.Vector3, r: number): boolean {
    if (p.y < 1 && Math.abs(p.x) < DOOR_W / 2 && p.z > HALF - r - 0.02) return true;
    p.x = Math.max(-HALF + r, Math.min(HALF - r, p.x));
    p.z = Math.max(-HALF + r, Math.min(HALF - r, p.z));
    return false;
  }

  inShaft(x: number, z: number) { return x > SHAFT.x0 + 0.2 && x < SHAFT.x1 - 0.2 && z > SHAFT.z0 + 0.2 && z < SHAFT.z1 - 0.2; }
  shaftCenter() { return new THREE.Vector3((SHAFT.x0 + SHAFT.x1) / 2, 0, (SHAFT.z0 + SHAFT.z1) / 2); }

  /** Send the elevator platform to level L. Returns the ride duration in seconds. */
  callElevator(L: number): number {
    this.platformTarget = L * FH;
    return Math.min(3.5, 0.6 + Math.abs(this.platformTarget - this.platformY) / FH * 0.35);
  }

  get elevatorMoving() { return Math.abs(this.platformTarget - this.platformY) > 0.01; }

  /** Where to stand on level L, looking at the code wall. */
  spawn(L: number): { pos: THREE.Vector3; yaw: number } {
    return { pos: new THREE.Vector3(-2.4, L * FH, -2.6), yaw: 0 };
  }

  /** Make sure code/info walls exist around level L (others are released to save memory). */
  ensureWalls(L: number) {
    for (const [k, w] of this.walls) {
      const near = Math.abs(k - L) <= 1;
      if (near && !w.code) {
        const f = this.spec.floors[k - 1];
        w.code = new CodeWall(10.4, 3.8, this.spec.lines.slice(f.start - 1, f.end), this.spec.lang, f.start, 30);
        w.code.mesh.position.set(-2.4, k * FH + 2.1, -HALF + 0.05);
        w.info = new TextPanel(9, 3.8, [
          { text: `${f.kind}  ·  lines ${f.start}–${f.end}`, color: '#7fb8c8' },
          { text: `${f.loc} LOC  ·  complexity ${f.complexity}`, color: '#7fb8c8' },
          { text: '' },
          { text: 'REFERENCES  (click to teleport)', color: '#ff8adf', size: 30 },
          ...this.spec.references(f),
        ], f.name);
        w.info.mesh.position.set(-HALF + 0.05, k * FH + 2.1, -1.5);
        w.info.mesh.rotation.y = Math.PI / 2;
        this.scene.add(w.code.mesh, w.info.mesh);
        this.interactive.push(w.code.mesh, w.info.mesh);
      } else if (!near && w.code) {
        for (const o of [w.code, w.info!]) {
          this.scene.remove(o.mesh);
          const i = this.interactive.indexOf(o.mesh);
          if (i >= 0) this.interactive.splice(i, 1);
          o.dispose();
        }
        w.code = w.info = undefined;
      }
    }
  }

  codeWall(L: number) { return this.walls.get(L)?.code; }

  update(dt: number) {
    this.time += dt;
    if (this.elevatorMoving) {
      const d = this.platformTarget - this.platformY;
      const v = Math.sign(d) * Math.min(Math.abs(d), dt * Math.max(FH * 1.2, Math.abs(d) * 2.2));
      this.platformY += v;
    }
    this.platform.position.y = this.platformY - 0.09;
    for (const w of this.walls.values()) w.code?.update(dt);
    const portal = this.exitPortal.material as THREE.MeshBasicMaterial;
    portal.opacity = 0.35 + 0.2 * Math.sin(this.time * 3);
    const k = 0.75 + 0.25 * Math.sin(this.time * 2.4);
    for (const p of this.pulses) p.scale.y = k * 1.5;
  }

  dispose() {
    for (const w of this.walls.values()) { w.code?.dispose(); w.info?.dispose(); w.sign.material.map?.dispose(); w.sign.material.dispose(); }
    for (const d of this.disposables) d.dispose();
    this.scene.traverse(o => {
      const sp = o as THREE.Sprite;
      if (sp.isSprite) { sp.material.map?.dispose(); sp.material.dispose(); }
    });
  }
}

/** A tiling line pattern for an interior finish (white on transparent; tinted by the material). */
function finishTexture(facade: string): THREE.CanvasTexture | null {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  const line = (x0: number, y0: number, x1: number, y1: number) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  switch (facade) {
    case 'brick':
      for (let r = 0; r < 8; r++) {
        line(0, r * 32, S, r * 32);
        for (let c = 0; c < 4; c++) { const x = c * 64 + (r % 2) * 32; line(x, r * 32, x, r * 32 + 32); }
      }
      break;
    case 'concrete': for (let k = 0; k <= 4; k++) { line(k * 64, 0, k * 64, S); line(0, k * 64, S, k * 64); } g.lineWidth = 1.5; for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) { g.beginPath(); g.arc(k * 64 + 12, j * 64 + 12, 3, 0, 7); g.stroke(); } break;
    case 'glass': case 'crystal': for (let k = 0; k <= 2; k++) line(k * 128, 0, k * 128, S); line(0, 0, S, 0); line(0, 128, S, 128); break;
    case 'steel': line(0, 0, S, S); line(S, 0, 0, S); line(0, 0, S, 0); line(0, 0, 0, S); g.lineWidth = 1.5; for (const [x, y] of [[8, 8], [S - 8, 8], [8, S - 8], [S - 8, S - 8]]) { g.beginPath(); g.arc(x, y, 4, 0, 7); g.stroke(); } break;
    case 'library': case 'colonnade': for (let k = 0; k < 4; k++) { line(k * 64 + 20, 0, k * 64 + 20, S); line(k * 64 + 44, 0, k * 64 + 44, S); } line(0, 12, S, 12); break;
    case 'lattice': for (let k = -S; k <= S; k += 64) { line(k, 0, k + S, S); line(k + S, 0, k, S); } break;
    case 'utility': for (let k = 0; k < S; k += 16) line(0, k, S, k); break;
    case 'storefront': line(0, 200, S, 200); for (let k = 0; k <= S; k += 32) line(k, 200, k + 16, 230); break;
    default: return null;
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function textSprite(text: string, height: number, color: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d')!;
  const font = '600 40px "JetBrains Mono", ui-monospace, monospace';
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width) + 40;
  cv.width = tw; cv.height = 64;
  ctx.font = font;
  ctx.fillStyle = 'rgba(0,6,16,0.75)';
  ctx.fillRect(0, 0, tw, 64);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, tw - 4, 60);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false }));
  sp.scale.set((height * tw) / 64, height, 1);
  return sp;
}
