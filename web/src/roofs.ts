import * as THREE from 'three';
import type { BuildingSpec, RoofKind } from './architecture';

/**
 * Rooftop equipment (what a file does, from the flow analysis) and construction
 * (scaffolding and cranes for recent churn), as a parametric kit: one InstancedMesh
 * per primitive shape, so the whole city's rooftops cost a handful of draw calls.
 *
 * Every piece is placed relative to the roof of the building's top tier, in units
 * of u = the smaller side of that roof, so equipment scales with the tower it sits on.
 */

type Prim = 'box' | 'cyl' | 'cone' | 'sphere' | 'torus' | 'dish' | 'scaffold';
/** Role colors match the flow view: teal inputs, amber state, coral side effects, magenta requests. */
type Tone = 'metal' | 'dark' | 'light' | 'beacon' | 'input' | 'state' | 'effect' | 'request' | 'crane';

interface PieceDef {
  prim: Prim;
  /** Centre, in u, relative to the slot on the roof (y = up from the roof). */
  at: [number, number, number];
  size: [number, number, number];
  rot?: [number, number, number];
  tone: Tone;
  /** Emissive (pulsing) light. */
  light?: number;
  /** Turns slowly in hacker mode. */
  spin?: boolean;
}

const RECIPES: Record<RoofKind, PieceDef[]> = {
  spire: [
    { prim: 'box', at: [0, 0.09, 0], size: [0.46, 0.18, 0.46], tone: 'metal' },
    { prim: 'cone', at: [0, 0.93, 0], size: [0.3, 1.5, 0.3], tone: 'input' },
    { prim: 'sphere', at: [0, 1.72, 0], size: [0.13, 0.13, 0.13], tone: 'beacon', light: 1.6 },
  ],
  antenna: [
    { prim: 'cyl', at: [0, 0.45, 0], size: [0.05, 0.9, 0.05], tone: 'metal' },
    { prim: 'dish', at: [0, 0.62, 0.02], size: [0.42, 0.14, 0.42], rot: [-0.9, 0, 0], tone: 'input' },
    { prim: 'torus', at: [0, 0.92, 0], size: [0.2, 0.2, 0.2], rot: [Math.PI / 2, 0, 0], tone: 'input', light: 0.6, spin: true },
  ],
  tanks: [
    { prim: 'cyl', at: [-0.15, 0.2, 0], size: [0.26, 0.4, 0.26], tone: 'state' },
    { prim: 'cyl', at: [0.15, 0.17, 0.02], size: [0.24, 0.34, 0.24], tone: 'state' },
    { prim: 'sphere', at: [-0.15, 0.4, 0], size: [0.26, 0.1, 0.26], tone: 'state' },
    { prim: 'sphere', at: [0.15, 0.34, 0.02], size: [0.24, 0.09, 0.24], tone: 'state' },
  ],
  chimney: [
    { prim: 'box', at: [0, 0.32, 0], size: [0.16, 0.64, 0.16], tone: 'dark' },
    { prim: 'cyl', at: [0, 0.67, 0], size: [0.2, 0.06, 0.2], tone: 'effect', light: 0.8 },
  ],
  vents: [
    { prim: 'box', at: [-0.16, 0.06, 0], size: [0.12, 0.12, 0.3], tone: 'metal' },
    { prim: 'box', at: [0, 0.06, 0], size: [0.12, 0.12, 0.3], tone: 'metal' },
    { prim: 'box', at: [0.16, 0.06, 0], size: [0.12, 0.12, 0.3], tone: 'metal' },
    { prim: 'cyl', at: [0, 0.14, 0], size: [0.1, 0.04, 0.1], tone: 'effect', light: 0.7 },
  ],
  uplink: [
    { prim: 'cyl', at: [0, 0.4, 0], size: [0.035, 0.8, 0.035], tone: 'metal' },
    { prim: 'torus', at: [0, 0.5, 0], size: [0.15, 0.15, 0.15], rot: [Math.PI / 2, 0, 0], tone: 'request', light: 0.5, spin: true },
    { prim: 'sphere', at: [0, 0.84, 0], size: [0.1, 0.1, 0.1], tone: 'request', light: 1.3 },
  ],
  watertower: [
    { prim: 'box', at: [-0.14, 0.2, -0.14], size: [0.035, 0.4, 0.035], tone: 'dark' },
    { prim: 'box', at: [0.14, 0.2, -0.14], size: [0.035, 0.4, 0.035], tone: 'dark' },
    { prim: 'box', at: [-0.14, 0.2, 0.14], size: [0.035, 0.4, 0.035], tone: 'dark' },
    { prim: 'box', at: [0.14, 0.2, 0.14], size: [0.035, 0.4, 0.035], tone: 'dark' },
    { prim: 'cyl', at: [0, 0.56, 0], size: [0.44, 0.34, 0.44], tone: 'state' },
    { prim: 'cone', at: [0, 0.8, 0], size: [0.48, 0.16, 0.48], tone: 'dark' },
  ],
};

const CRANE: PieceDef[] = [
  { prim: 'box', at: [0, 1.25, 0], size: [0.09, 2.5, 0.09], tone: 'crane' },
  { prim: 'box', at: [-1.0, 2.5, 0], size: [2.6, 0.07, 0.07], tone: 'crane' },
  { prim: 'box', at: [0.55, 2.5, 0], size: [0.5, 0.16, 0.12], tone: 'dark' },
  { prim: 'box', at: [-2.0, 2.08, 0], size: [0.01, 0.84, 0.01], tone: 'dark' },
  { prim: 'sphere', at: [0, 2.62, 0], size: [0.06, 0.06, 0.06], tone: 'beacon', light: 1.2 },
];

/** Slots on the roof, as fractions of the top tier's width/depth. */
const CENTER: [number, number] = [0, 0];
const CORNERS: [number, number][] = [[0.24, 0.24], [-0.24, -0.24], [-0.24, 0.24]];

/** Where a building's top tier is, for placing its equipment. */
export interface RoofFrame { cx: number; cz: number; top: number; tw: number; td: number; /** top tier's height */ th: number; hide: boolean }

/** The top part of the top tier wrapped in scaffolding. */
export interface Works { building: number; crane: boolean }

interface Piece { def: PieceDef; prim: Prim; slot: number; sx: number; sz: number }

const PALETTE: Record<'normal' | 'hacker', Record<Tone, string>> = {
  normal: { metal: '#8a93a3', dark: '#3d434f', light: '#e9edf3', beacon: '#ff4d4f', input: '#c9d3e0', state: '#b8a27a', effect: '#7b6f68', request: '#c9c2d8', crane: '#f2b705' },
  hacker: { metal: '#36e0ff', dark: '#1d6f8a', light: '#e6fbff', beacon: '#ffffff', input: '#2ee6c9', state: '#ffb547', effect: '#ff6b5e', request: '#ff3cd0', crane: '#ffd23c' },
};

export class RoofKit {
  readonly group = new THREE.Group();
  private geos: Record<Prim, THREE.BufferGeometry>;
  private mat: THREE.MeshStandardMaterial;
  private scaffoldMat: THREE.MeshBasicMaterial;
  private uniforms = { uHacker: { value: 0 }, uTime: { value: 0 } };
  private meshes = new Map<Prim, THREE.InstancedMesh>();
  private pieces: Piece[][] = [];
  private frames: (RoofFrame | null)[] = [];
  private spinning: number[] = []; // buildings with spinning pieces
  private hacker = false;
  /** The city's facade cell (≈ a third of a median building's width): equipment never outgrows a few of these. */
  cell = 1;
  private tmp = new THREE.Object3D();
  private euler = new THREE.Euler();

  constructor() {
    const dish = new THREE.SphereGeometry(0.5, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.32).translate(0, -0.45, 0);
    dish.scale(1, 2.2, 1);
    this.geos = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
      cone: new THREE.ConeGeometry(0.5, 1, 12),
      sphere: new THREE.SphereGeometry(0.5, 14, 10),
      torus: new THREE.TorusGeometry(0.5, 0.06, 6, 28),
      dish,
      scaffold: new THREE.BoxGeometry(1, 1, 1),
    };
    for (const g of Object.values(this.geos)) g.setAttribute('aLight', new THREE.InstancedBufferAttribute(new Float32Array(0), 1));
    this.mat = this.partMaterial();
    this.scaffoldMat = this.scaffoldMaterial();
    this.group.name = 'roofs';
  }

  /** Equipment and outlines in hacker colors (neon) or as painted metal. */
  setHacker(on: boolean) {
    this.hacker = on;
    this.uniforms.uHacker.value = on ? 1 : 0;
    this.mat.metalness = on ? 0.8 : 0.55;
    this.mat.roughness = on ? 0.2 : 0.5;
    this.paint();
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
    if (!this.hacker) return;
    for (const i of this.spinning) this.place(i, this.frames[i], time);
    for (const m of this.meshes.values()) m.instanceMatrix.needsUpdate = true;
  }

  /** Rebuild the instances: each building's roof equipment plus any construction works. */
  build(specs: BuildingSpec[], works: Works[]) {
    for (const m of this.meshes.values()) { this.group.remove(m); m.dispose(); }
    this.meshes.clear();
    const counts = new Map<Prim, number>();
    this.pieces = specs.map(() => []);
    this.spinning = [];
    const push = (i: number, def: PieceDef, slot: [number, number]) => {
      const prim = def.prim;
      const k = counts.get(prim) ?? 0;
      counts.set(prim, k + 1);
      this.pieces[i].push({ def, prim, slot: k, sx: slot[0], sz: slot[1] });
    };
    specs.forEach((sp, i) => {
      const spire = sp.roof.includes('spire');
      const rest = sp.roof.filter(r => r !== 'spire');
      if (spire) RECIPES.spire.forEach(d => push(i, d, CENTER));
      rest.forEach((r, k) => {
        const slot = !spire && rest.length === 1 ? CENTER : CORNERS[k % CORNERS.length];
        RECIPES[r].forEach(d => push(i, d, slot));
      });
      if (sp.roof.includes('antenna') || sp.roof.includes('uplink')) this.spinning.push(i);
    });
    const scaffold: PieceDef = { prim: 'scaffold', at: [0, 0, 0], size: [1, 1, 1], tone: 'crane' };
    for (const w of works) {
      push(w.building, scaffold, CENTER);
      if (w.crane) CRANE.forEach(d => push(w.building, d, [0.42, -0.42]));
    }
    for (const [prim, n] of counts) {
      if (!n) continue;
      const geo = this.geos[prim];
      geo.setAttribute('aLight', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
      const mesh = new THREE.InstancedMesh(geo, prim === 'scaffold' ? this.scaffoldMat : this.mat, n);
      mesh.castShadow = prim !== 'scaffold';
      mesh.frustumCulled = false; // instances are spread over the whole city
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (prim === 'scaffold') mesh.renderOrder = 3;
      this.meshes.set(prim, mesh);
      this.group.add(mesh);
    }
    this.paint();
    this.frames = this.frames.length === specs.length ? this.frames : specs.map(() => null);
    this.frames.forEach((f, i) => this.place(i, f, this.uniforms.uTime.value));
    this.flush();
  }

  /** Move building i's pieces onto its roof (call when the building's height changes). */
  place(i: number, f: RoofFrame | null, time = this.uniforms.uTime.value) {
    this.frames[i] = f;
    const ps = this.pieces[i];
    if (!ps?.length) return;
    const t = this.tmp;
    for (const p of ps) {
      const mesh = this.meshes.get(p.prim);
      if (!mesh) continue;
      if (!f || f.hide) {
        t.position.set(0, -1e4, 0); t.scale.setScalar(1e-4); t.rotation.set(0, 0, 0);
      } else if (p.prim === 'scaffold') {
        // wraps the upper part of the top tier, a little proud of the facade
        const h = Math.min(f.th, Math.max(f.th * 0.45, Math.max(f.tw, f.td) * 0.8));
        t.position.set(f.cx, f.top - h / 2 + 0.01, f.cz);
        t.scale.set(f.tw * 1.07, h, f.td * 1.07);
        t.rotation.set(0, 0, 0);
      } else {
        const u = this.unit(f);
        const d = p.def;
        t.position.set(f.cx + p.sx * f.tw + d.at[0] * u, f.top + d.at[1] * u, f.cz + p.sz * f.td + d.at[2] * u);
        t.scale.set(d.size[0] * u, d.size[1] * u, d.size[2] * u);
        const r = d.rot ?? [0, 0, 0];
        this.euler.set(r[0], r[1] + (d.spin && this.hacker ? time * 0.9 : 0), r[2], 'YXZ');
        t.rotation.copy(this.euler);
      }
      t.updateMatrix();
      mesh.setMatrixAt(p.slot, t.matrix);
    }
  }

  /** Height of building i's equipment above its roof (for the data-bus anchors). */
  heightAbove(i: number): number {
    const f = this.frames[i];
    if (!f || f.hide) return 0;
    const u = this.unit(f);
    let top = 0;
    for (const p of this.pieces[i] ?? []) if (p.prim !== 'scaffold' && p.def.tone !== 'crane') top = Math.max(top, p.def.at[1] + p.def.size[1] / 2);
    return top * u;
  }

  private unit(f: RoofFrame) { return Math.max(0.03, Math.min(f.tw * 0.8, f.td * 0.8, this.cell * 2.2, Math.max(f.th, this.cell) * 1.4)); }

  flush() {
    for (const m of this.meshes.values()) { m.instanceMatrix.needsUpdate = true; }
  }

  private paint() {
    const pal = PALETTE[this.hacker ? 'hacker' : 'normal'];
    const c = new THREE.Color();
    for (const ps of this.pieces) {
      for (const p of ps) {
        const mesh = this.meshes.get(p.prim);
        if (!mesh) continue;
        mesh.setColorAt(p.slot, c.set(pal[p.def.tone]));
        (mesh.geometry.getAttribute('aLight') as THREE.InstancedBufferAttribute).setX(p.slot, p.def.light ?? 0);
      }
    }
    for (const m of this.meshes.values()) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.getAttribute('aLight').needsUpdate = true;
    }
  }

  private partMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.55 });
    const u = this.uniforms;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aLight;\nvarying float vLight;\nvarying float vPhase;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vLight = aLight;
#ifdef USE_INSTANCING
vPhase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.11;
#else
vPhase = 0.0;
#endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHacker;\nuniform float uTime;\nvarying float vLight;\nvarying float vPhase;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float pulse = 0.65 + 0.35 * sin(uTime * 3.0 + vPhase);
  if (uHacker > 0.5) {
    vec3 tint = diffuseColor.rgb;
    diffuseColor.rgb = tint * 0.04;
    float fr = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.0);
    totalEmissiveRadiance += tint * (0.06 + 0.9 * fr) + tint * vLight * 1.2 * pulse;
  } else {
    totalEmissiveRadiance += diffuseColor.rgb * vLight * pulse;
  }
}`);
    };
    m.customProgramCacheKey = () => 'codecity-roof-v1';
    return m;
  }

  /** Scaffolding: a see-through grid of poles and planks; in hacker mode a wireframe with a scanning laser. */
  private scaffoldMaterial(): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const u = this.uniforms;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vP;\nvarying vec3 vN;\nvarying float vH;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vN = normal;
#ifdef USE_INSTANCING
vec3 sz = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
vec3 sz = vec3(1.0);
#endif
vP = position * sz; vH = sz.y;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uHacker;
uniform float uTime;
varying vec3 vP;
varying vec3 vN;
varying float vH;
float gl1(float x, float w) { float fw = max(fwidth(x), 1e-4); float d = abs(fract(x - 0.5) - 0.5); return 1.0 - smoothstep(w, w + fw * 1.5, d); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  if (abs(vN.y) > 0.5) discard;
  float across = abs(vN.x) > 0.5 ? vP.z : vP.x;
  float bay = max(vH / 6.0, 0.05);
  float poles = gl1(across / bay, 0.05);
  float planks = gl1(vP.y / bay, 0.07);
  float brace = gl1((across + vP.y) / (bay * 2.0), 0.03);
  float a = max(max(poles, planks), brace * 0.7);
  if (uHacker > 0.5) {
    float scan = exp(-abs(vP.y + vH * 0.5 - fract(uTime * 0.35) * vH) / max(vH * 0.03, 0.02));
    a = max(a * 0.8, scan * 0.9);
    diffuseColor.rgb = mix(vec3(1.0, 0.82, 0.24), vec3(1.0, 0.95, 0.7), scan) * 1.6;
  }
  if (a < 0.05) discard;
  diffuseColor.a = a * 0.9;
}`);
    };
    m.customProgramCacheKey = () => 'codecity-scaffold-v1';
    return m;
  }
}
