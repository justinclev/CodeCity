import { route } from './roads';
import { GateMarks, type GateSpot } from './gatemarks';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { authorColor, depthColor, heat, languageColor } from './colors';
import { buildingMaterial, circuitMaterial, type BuildingUniforms, type CircuitUniforms } from './material';
import { busRoute, TraceLayer, type Trace } from './links';
import { buildSpecs, classicSpec, facadeCode, pathSeed, explain, type BuildingSpec, type Condition } from './architecture';
import { RoofKit, type Works } from './roofs';
import { Walkways } from './walkways';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HackerFx } from './fx';
import { circuitTexture, codeTexture, glyphAtlas, skyTexture, THEMES, type Theme, type ThemeName } from './theme';
import type { City, ColorMode, Metric, ScaleMode } from './types';

const DISTRICT_STEP = 0.12; // vertical rise per directory depth
const MIN_H = 0.35;
const ABSENT = -1;

/** Docs, data and config files are ranked by churn only; hotspots are about code. */
const NON_CODE = new Set(['Markdown', 'JSON', 'YAML', 'TOML', 'Text', 'Config', 'XML', 'Other', 'HTML', 'CSS']);

export interface Totals { files: number; loc: number }
export interface Churn { commits: number; lines: number; allCommits: number; allLines: number }
/** loc holds the complexity used in the score. */
export interface Hotspot { index: number; score: number; commits: number; loc: number }
/** Knowledge risk buckets for the 'knowledge' color mode. */
export const RISK = ['no history', '3+ authors', '2 authors', 'single author', 'owner inactive'] as const;
export const RISK_COLORS = ['#596277', '#51cf66', '#ffd43b', '#ff922b', '#ff4d4f'];
export const INACTIVE_DAYS = 180;

export type Pick = { kind: 'building'; index: number } | { kind: 'district'; index: number } | { kind: 'floor'; index: number } | { kind: 'link'; index: number } | { kind: 'gate'; index: number } | null;

/** A connection between two cities to draw (index into city.links). */
export type LinkKind = 'dependency' | 'people' | 'api' | 'message' | 'data';
export interface Road { kind: LinkKind; pts: [number, number][]; width: number; from: number; to: number }
export interface LinkView { index: number; from: number; to: number; kind: LinkKind; strength: number; label: string }

interface LinkMesh { view: LinkView; mesh: THREE.Mesh; pick: THREE.Mesh; mat: THREE.ShaderMaterial; label?: THREE.Sprite; extra?: THREE.ShaderMaterial[]; extraMeshes?: THREE.Mesh[] }

/** Tube material with light pulses flowing from the start (uv.x = 0) to the end. */
function flowMaterial(a: THREE.Color, b: THREE.Color, count: number, speed: number, additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uA: { value: a }, uB: { value: b }, uCount: { value: count }, uSpeed: { value: speed }, uHi: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform float uCount; uniform float uSpeed; uniform float uHi; varying vec2 vUv;
      void main() {
        float f = fract(vUv.x * uCount - uTime * uSpeed);
        float pulse = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.08, 0.35, f));
        vec3 c = mix(uA, uB, vUv.x);
        float a = 0.32 + 0.68 * pulse + 0.35 * uHi;
        gl_FragColor = vec4(c * (0.75 + 1.6 * pulse + 0.8 * uHi), clamp(a, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false, toneMapped: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/**
 * A highway between two cities: dark asphalt with lit edges, a dashed centre line and "cars"
 * (light pulses) in each lane. u.x runs from the first city to the second. Requests (api) travel
 * both ways (the way back is dimmer: responses); messages only go from publisher to subscriber.
 */
function highwayMaterial(color: THREE.Color, len: number, twoWay: boolean, day: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHi: { value: 0 }, uColor: { value: color }, uLen: { value: len }, uTwo: { value: twoWay ? 1 : 0 }, uDay: { value: day ? 1 : 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uHi; uniform vec3 uColor; uniform float uLen; uniform float uTwo; uniform float uDay; varying vec2 vUv;
      void main() {
        float y = vUv.y, x = vUv.x * uLen;
        float edge = smoothstep(0.09, 0.0, y) + smoothstep(0.91, 1.0, y);
        float centre = (1.0 - smoothstep(0.0, 0.025, abs(y - 0.5))) * step(0.5, fract(x / (uLen * 0.012 + 1.0) * 0.5));
        float lane = y < 0.5 ? 1.0 : -1.0;
        float dir = uTwo > 0.5 ? lane : 1.0;
        float laneMask = 1.0 - smoothstep(0.1, 0.16, abs(y - (y < 0.5 ? 0.27 : 0.73)));
        float f = fract((x - dir * uTime * uLen * 0.05) / (uLen * 0.07 + 1.0));
        float car = smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(0.05, 0.16, f)) * laneMask;
        float dim = (uTwo > 0.5 && lane < 0.0) ? 0.55 : 1.0;
        vec3 road = mix(vec3(0.015, 0.02, 0.04), vec3(0.2, 0.21, 0.24), uDay);
        vec3 c = road + uColor * (edge * (0.8 + 0.8 * uHi) + centre * 0.35 + car * 2.2 * dim);
        gl_FragColor = vec4(c, 0.96);
      }`,
    transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
}

/** One floor of an exploded building (a piece of the file). */
export interface Floor { name: string; kind: string; loc: number; complexity: number; piece: number; /** first source line (walk mode) */ start?: number }

interface Exploded {
  building: number;
  floors: Floor[];
  mesh: THREE.InstancedMesh;
  labels: THREE.Group;
  heights: number[];
  colors: THREE.Color[];
  uniforms: BuildingUniforms;
  t: number; // 0 collapsed → 1 fully exploded
  dir: 1 | -1;
  highlight: number;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  /** Walk mode: called every frame with dt; when set, orbit controls are bypassed. */
  onFrame: ((dt: number) => void) | null = null;
  /** Scene actually rendered (the city, or a building interior in walk mode). */
  private view: THREE.Scene = this.scene;
  private bloom: UnrealBloomPass;
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private ground: THREE.Mesh;
  private groundU: CircuitUniforms;
  private districtU?: CircuitUniforms;
  private glyphTex?: THREE.Texture;
  private circuitTex?: THREE.Texture;
  private time = 0;
  private skin: { building: number; mesh: THREE.Group; content: string } | null = null;
  private grid?: THREE.GridHelper;
  private outlines?: THREE.LineSegments;
  theme: Theme = THEMES.night;

  private city!: City;
  private C = 1; // commits
  private vals!: Record<Metric, Int32Array>; // [building * C + commit]; loc is -1 when absent
  private lastTs!: Float64Array; // newest change time (unix s) at or before each commit; 0 = unknown
  private commitTs: number[] = [];
  private arcs = new THREE.Group();
  private exploded: Exploded | null = null;
  private linkGroup = new THREE.Group();
  private linkMeshes: LinkMesh[] = [];
  private linkHi = -1;
  readonly codeLinks = new TraceLayer(true);
  private highwayGroup = new THREE.Group();
  private gates = new GateMarks();
  private roadPaths: Road[] = [];
  private hackerFx = new HackerFx();
  codeLinkMode: 'off' | 'selection' | 'all' = 'selection';
  private importers: number[][] = []; // building → buildings that import it
  private dirImporters = new Map<number, number[]>(); // district → buildings that import it (Go packages)
  private cumCommits!: Int32Array; // cumulative churn up to and including each commit
  private cumLines!: Int32Array;
  private buildingMesh?: THREE.InstancedMesh; // tier 0 of every building (instance = building index)
  private tierMesh?: THREE.InstancedMesh; // tiers above the podium
  private tierOwner = new Int32Array(0); // tier instance → building
  private tierFirst = new Int32Array(0); // building → its first instance in tierMesh (-1: none)
  private facade0 = new Float32Array(0); // aFacade per building (tier 0)
  private facadeT = new Float32Array(0); // aFacade per upper tier
  private tierGlow = new Float32Array(0);
  private specs: BuildingSpec[] = [];
  private classic = false;
  private roofs = new RoofKit();
  private ways = new Walkways();
  private conds: Condition[] = [];
  private worksKey = '';
  private uniforms?: BuildingUniforms;
  private glow = new Float32Array(0);
  private glowAttr?: THREE.InstancedBufferAttribute;
  private districtMesh?: THREE.InstancedMesh;
  private labels = new THREE.Group();
  private baseY: number[] = [];
  private cur = new Float32Array(0); // displayed height
  private target = new Float32Array(0);
  private delay = new Float32Array(0); // intro stagger, seconds
  private moving = false;
  private baseColors: THREE.Color[] = [];
  private heatT = new Float32Array(0); // 0..1 intensity used for glow in churn/hotspot modes
  private change: Uint8Array = new Uint8Array(0); // 0 none, 1 added, 2 changed (vs previous commit)
  private changed: number[] = [];
  private pulse = 0; // 1 → 0 after a commit change; drives the change highlight
  private dimmed: boolean[] = [];
  private hovered = -1;
  private partners = new Map<number, number>(); // coupled to the selection → degree
  private selected = -1;
  private selectedDistrict = -1;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Object3D();
  private last = performance.now();
  private flowTime = 0;
  private fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; start: number; dur: number } | null = null;

  commit = 0;
  showChanges = true;
  metric: Metric = 'loc';
  scale: ScaleMode = 'sqrt';
  mult = 1;
  colorMode: ColorMode = 'language';
  churnWindow = 0; // in samples; 0 = everything so far
  baseline = 0; // commit index for the 'compare' color mode
  authorFilter = -1; // only highlight files owned by this author
  private searchHit: boolean[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => { this.fly = null; });

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.labels, this.arcs, this.linkGroup, this.codeLinks.group, this.highwayGroup, this.gates.group, this.hackerFx.group, this.roofs.group, this.ways.group);

    const gm = circuitMaterial('#000000', false);
    this.groundU = gm.uniforms;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm.material);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.5, 0.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frameLoop());
  }

  /** While another full-screen view (the flow diagram) covers the city, skip rendering. */
  paused = false;

  private frameLoop() {
    if (this.paused) { this.last = performance.now(); return; }
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.theme.hacker) {
      this.time += dt;
      this.hackerFx.update(dt, this.time);
      for (const u of [this.uniforms, this.exploded?.uniforms, this.groundU, this.districtU]) if (u) u.uTime.value = this.time;
      this.roofs.update(this.time);
      this.updateSkin();
    }
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / this.fly.dur);
      const e = easeInOut(t);
      this.camera.position.lerpVectors(this.fly.p0, this.fly.p1, e);
      this.controls.target.lerpVectors(this.fly.t0, this.fly.t1, e);
      if (t >= 1) this.fly = null;
    }
    if (this.moving) this.step(dt);
    if (this.exploded) this.animateExplode(dt);
    if (this.onFrame) this.onFrame(dt);
    this.codeLinks.update(this.flowTime);
    if (this.gates.group.visible) {
      this.flowTime += dt;
      this.gates.update(this.flowTime, i => (this.exists(i) && this.cur[i] > 0.02 ? this.baseY[i] + this.cur[i] : -1), i => this.city.buildings[i]);
    }
    if (this.linkMeshes.length || this.highwayGroup.children.length || this.arcs.children.length || this.codeLinks.group.children.length) {
      this.flowTime += dt;
      for (const l of this.linkMeshes) { l.mat.uniforms.uTime.value = this.flowTime; for (const m of l.extra ?? []) m.uniforms.uTime.value = this.flowTime; }
      for (const o of this.arcs.children) {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial;
        if (m.uniforms?.uTime) m.uniforms.uTime.value = this.flowTime;
      }
    }
    if (this.pulse > 0) {
      this.pulse = Math.max(0, this.pulse - dt / 1.6);
      for (const i of this.changed) this.paint(i);
    }
    this.fadeLabels();
    if (!this.onFrame) this.controls.update();
    if (this.bloom.enabled) this.composer.render();
    else this.renderer.render(this.view, this.camera);
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get commitCount() { return this.C; }

  // ------------------------------------------------------------------ walk-mode support

  /** Render another scene (a building interior) instead of the city; null = the city. */
  setView(sc: THREE.Scene | null) {
    this.view = sc ?? this.scene;
    this.renderPass.scene = this.view;
    // interiors are close-up and full of emissive surfaces: a calmer bloom than the night skyline;
    // walking the streets sits between the two (whole facades fill the frame up close)
    const t = this.theme.bloom;
    const street = !sc && this.streetLevel;
    this.bloom.enabled = sc || street ? true : t.strength > 0;
    this.bloom.strength = sc ? 0.45 : street ? Math.min(t.strength, 0.6) : t.strength;
    this.bloom.radius = sc ? 0.4 : street ? 0.35 : t.radius;
    this.bloom.threshold = sc ? 0.82 : street ? Math.max(t.threshold, 0.7) : t.threshold;
    this.renderer.toneMappingExposure = sc ? 1.0 : street ? this.theme.exposure * 0.9 : this.theme.exposure;
  }

  private streetLevel = false;
  /** Walk mode outdoors: the camera is at street level, so tone the bloom down. */
  setStreetLevel(on: boolean) {
    this.streetLevel = on;
    if (this.view === this.scene) this.setView(null);
  }

  get cityScene() { return this.scene; }
  get worldSize() { return this.size(); }
  get cell() { return this.uniforms?.uCell.value ?? 1; }
  get loaded() { return !!this.city; }
  get clock() { return this.flowTime; }

  /**
   * Buildings present at the current commit: footprints (boxes: one per building, up to its roof),
   * the solid tiers you collide with and stand on (setbacks are terraces), and district plates.
   */
  walkData() {
    const boxes: { i: number; x0: number; x1: number; z0: number; z1: number; top: number }[] = [];
    const solids: { i: number; x0: number; x1: number; z0: number; z1: number; y0?: number; top: number }[] = [];
    this.city.buildings.forEach((b, i) => {
      if (!this.exists(i)) return;
      const h = Math.max(this.target[i], MIN_H), y = this.baseY[i];
      boxes.push({ i, x0: b.x, x1: b.x + b.w, z0: b.z, z1: b.z + b.d, top: y + h });
      const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
      this.specOf(i).tiers.forEach((t, k) => {
        const hw = (b.w * t.s) / 2, hd = (b.d * t.s) / 2;
        solids.push({ i, x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd, y0: k === 0 ? undefined : y + h * t.y0, top: y + h * t.y1 });
      });
    });
    if (!this.classic) for (const w of this.ways.solids(i => this.podiumTop(i, true))) solids.push({ i: -2, ...w });
    const plates = this.city.districts.filter(d => d.depth >= 0)
      .map(d => ({ x0: d.x, x1: d.x + d.w, z0: d.z, z1: d.z + d.d, top: this.districtTop(d.depth), depth: d.depth }));
    return { boxes, solids, plates };
  }

  /** y of a building's podium roof (the level test walkways meet); -1 when absent. */
  private podiumTop(i: number, target: boolean): number {
    if (!this.exists(i)) return -1;
    const h = target ? Math.max(this.target[i], MIN_H) : this.cur[i];
    return h <= 0.02 ? -1 : this.baseY[i] + h * this.ways.podiumFraction(i);
  }

  /** Boxes of the floors of the exploded building (walk-mode collision: you can stand on them). */
  explodedBoxes(): { x0: number; x1: number; z0: number; z1: number; y0: number; top: number }[] {
    const e = this.exploded;
    if (!e) return [];
    const out: { x0: number; x1: number; z0: number; z1: number; y0: number; top: number }[] = [];
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (let k = 0; k < e.floors.length; k++) {
      e.mesh.getMatrixAt(k, m);
      m.decompose(p, q, sc);
      out.push({ x0: p.x - sc.x / 2, x1: p.x + sc.x / 2, z0: p.z - sc.z / 2, z1: p.z + sc.z / 2, y0: p.y - sc.y / 2, top: p.y + sc.y / 2 });
    }
    return out;
  }

  /** Floor of the exploded building under a ray, or -1. */
  rayFloor(origin: THREE.Vector3, dir: THREE.Vector3, far: number): number {
    if (!this.exploded) return -1;
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    const h = this.raycaster.intersectObject(this.exploded.mesh, false)[0];
    this.raycaster.far = Infinity;
    return h?.instanceId ?? -1;
  }

  /** Top of the skyline (walk mode: "above the skyline"). */
  skyline() {
    let tallest = 0;
    for (let i = 0; i < this.target.length; i++) if (this.exists(i)) tallest = Math.max(tallest, this.baseY[i] + this.target[i]);
    return tallest;
  }

  /** Distance along a ray to the first building or plate (Infinity if none within far). */
  rayDistance(origin: THREE.Vector3, dir: THREE.Vector3, far: number): number {
    if (!this.buildingMesh || !this.districtMesh) return Infinity;
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    const hit = this.raycaster.intersectObjects(this.solidMeshes(true), false)[0];
    this.raycaster.far = Infinity;
    return hit ? hit.distance : Infinity;
  }

  /** Building under a ray (walk-mode aiming), or -1. */
  rayBuilding(origin: THREE.Vector3, dir: THREE.Vector3, far: number): number {
    if (!this.buildingMesh) return -1;
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    for (const h of this.raycaster.intersectObjects(this.solidMeshes(false), false)) {
      const i = this.ownerOf(h);
      if (i >= 0 && this.exists(i)) { this.raycaster.far = Infinity; return i; }
    }
    this.raycaster.far = Infinity;
    return -1;
  }

  /** Meshes making up the buildings (plus the floors of an exploded one). */
  private solidMeshes(withExploded: boolean): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    if (this.buildingMesh) out.push(this.buildingMesh);
    if (this.tierMesh && this.tierMesh.count > 0) out.push(this.tierMesh);
    if (withExploded && this.exploded) out.push(this.exploded.mesh);
    return out;
  }

  /** Building of a ray hit on the podium or tier meshes, else -1. */
  private ownerOf(h: THREE.Intersection): number {
    if (h.instanceId === undefined) return -1;
    if (h.object === this.buildingMesh) return h.instanceId;
    if (h.object === this.tierMesh) return this.tierOwner[h.instanceId] ?? -1;
    return -1;
  }

  /** Stop any camera fly animation (walk mode drives the camera itself). */
  stopFly() { this.fly = null; }
  get glyphTexture() { return this.glyphTex ?? null; }
  get circuitTexture() { return this.circuitTex ?? null; }
  /** Roof height of building i at the current commit. */
  roofOf(i: number) { return this.baseY[i] + Math.max(this.target[i], MIN_H); }

  // ------------------------------------------------------------------ architecture

  /** The building's spec (its shape), or a plain box in "Classic boxes" mode. */
  specOf(i: number): BuildingSpec { return this.classic ? classicSpec(this.city.buildings[i]) : this.specs[i] ?? classicSpec(this.city.buildings[i]); }
  /** Condition at the current commit (scaffolding, irregularity, age). */
  conditionOf(i: number): Condition | undefined { return this.classic ? undefined : this.conds[i]; }
  /** Plain-language reasons for building i's look. */
  whyLooks(i: number): string[] { return this.classic ? [] : explain(this.city.buildings[i], this.specOf(i), this.conds[i]); }
  get classicBoxes() { return this.classic; }

  /** "Classic boxes": every building a plain box (no tiers, facades, roofs or condition). */
  setClassic(on: boolean) {
    if (on === this.classic) return;
    this.classic = on;
    this.ways.setVisible(!on);
    if (!this.city) return;
    const sel = this.skin ? { i: this.skin.building, c: this.skin.content } : null;
    this.buildTiers();
    this.refresh(true);
    if (this.exploded) this.collapse(true);
    if (sel) this.setSkin(sel.i, sel.c);
  }

  /** (Re)create the upper-tier instances and the roof kit for the current specs. */
  private buildTiers() {
    const n = this.city.buildings.length;
    if (this.tierMesh) { this.scene.remove(this.tierMesh); this.tierMesh.geometry.dispose(); this.tierMesh.dispose(); }
    this.tierFirst = new Int32Array(n).fill(-1);
    const owner: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.specOf(i).tiers.length;
      if (t > 1) { this.tierFirst[i] = owner.length; for (let k = 1; k < t; k++) owner.push(i); }
    }
    this.tierOwner = Int32Array.from(owner);
    const m = owner.length;
    this.facade0 = new Float32Array(n * 4);
    this.facadeT = new Float32Array(Math.max(1, m) * 4);
    this.tierGlow = new Float32Array(Math.max(1, m));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(this.tierGlow, 1));
    geo.setAttribute('aFacade', new THREE.InstancedBufferAttribute(this.facadeT, 4));
    this.buildingMesh!.geometry.setAttribute('aFacade', new THREE.InstancedBufferAttribute(this.facade0, 4));
    this.tierMesh = new THREE.InstancedMesh(geo, this.buildingMesh!.material, Math.max(1, m));
    this.tierMesh.count = m;
    this.tierMesh.castShadow = this.tierMesh.receiveShadow = true;
    this.tierMesh.frustumCulled = false;
    this.scene.add(this.tierMesh);
    for (let i = 0; i < n; i++) {
      const sp = this.specOf(i), seed = pathSeed(this.city.buildings[i].path);
      sp.tiers.forEach((t, k) => {
        const arr = k === 0 ? this.facade0 : this.facadeT, o = (k === 0 ? i : this.tierFirst[i] + k - 1) * 4;
        arr[o] = facadeCode(sp, t); arr[o + 3] = seed;
      });
    }
    this.worksKey = '';
    this.roofs.build(this.city.buildings.map((_, i) => this.specOf(i)), []);
    this.moving = true;
  }

  /** Write the tiers and roof of building i for displayed height h. */
  private placeBuilding(i: number, h: number, hide: boolean) {
    const b = this.city.buildings[i], sp = this.specOf(i);
    const cx = b.x + b.w / 2, cz = b.z + b.d / 2, y = this.baseY[i];
    const tiers = sp.tiers;
    for (let k = 0; k < tiers.length; k++) {
      const t = tiers[k];
      const ty0 = h * t.y0, ty1 = h * t.y1;
      this.tmp.position.set(cx, hide ? y - 1 - ty1 : y + (ty0 + ty1) / 2, cz);
      this.tmp.scale.set(b.w * t.s, Math.max(ty1 - ty0, 0.004), b.d * t.s);
      this.tmp.updateMatrix();
      if (k === 0) this.buildingMesh!.setMatrixAt(i, this.tmp.matrix);
      else this.tierMesh!.setMatrixAt(this.tierFirst[i] + k - 1, this.tmp.matrix);
    }
    if (this.exploded?.building === i && hide) return; // the exploded stack carries the roof
    const last = tiers[tiers.length - 1];
    this.roofs.place(i, { cx, cz, top: y + h, tw: b.w * last.s, td: b.d * last.s, th: h * (last.y1 - last.y0), hide });
  }

  /** Per-commit condition: complexity → irregular windows, age → weathering, recent churn → scaffolding. */
  private updateCondition() {
    const n = this.city.buildings.length, C = this.C, c = this.commit;
    const now = this.timeOf();
    const dens = new Float32Array(n);
    const all: number[] = [];
    for (let i = 0; i < n; i++) {
      const loc = this.vals.loc[i * C + c];
      if (loc <= 0 || !this.isCode(i)) continue;
      dens[i] = this.vals.complexity[i * C + c] / loc;
      all.push(dens[i]);
    }
    all.sort((a, b) => a - b);
    const p50 = all[Math.floor(all.length * 0.5)] ?? 0, p95 = all[Math.floor(all.length * 0.95)] ?? 1;
    // construction works: the files changed most in the latest stretch, if they were touched in the last month
    const works: Works[] = [];
    if (this.city.churn && !this.classic) {
      const scored: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        if (!this.exists(i)) continue;
        const last = this.lastTs[i * C + c];
        if (!last || now - last > 30 * 86400) continue;
        const recent = this.cumCommits[i * C + c] - (c > 0 ? this.cumCommits[i * C + c - 1] : 0);
        if (recent >= 2) scored.push([i, recent]);
      }
      scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      let live = 0;
      for (let i = 0; i < n; i++) if (this.exists(i)) live++;
      const max = Math.max(3, Math.min(40, Math.round(live * 0.03)));
      scored.slice(0, max).forEach(([i, k], r) => works.push({ building: i, crane: r < 4 && k >= 3 }));
    }
    this.conds = this.city.buildings.map((_, i) => {
      const last = this.lastTs[i * C + c];
      const w = works.find(x => x.building === i);
      return {
        scaffold: !!w, crane: !!w?.crane,
        irregular: dens[i] > 0 && p95 > p50 ? Math.min(1, Math.max(0, (dens[i] - p50) / (p95 - p50))) : 0,
        age: last > 0 ? Math.min(1, Math.max(0, (now - last) / (2 * 365 * 86400))) : 0,
      };
    });
    for (let i = 0; i < n; i++) {
      const cd = this.classic ? null : this.conds[i];
      const set = (arr: Float32Array, o: number) => { arr[o + 1] = cd?.irregular ?? 0; arr[o + 2] = cd?.age ?? 0; };
      set(this.facade0, i * 4);
      const f = this.tierFirst[i];
      if (f >= 0) for (let k = 1; k < this.specOf(i).tiers.length; k++) set(this.facadeT, (f + k - 1) * 4);
    }
    this.buildingMesh!.geometry.getAttribute('aFacade').needsUpdate = true;
    this.tierMesh!.geometry.getAttribute('aFacade').needsUpdate = true;
    const key = works.map(w => `${w.building}${w.crane ? 'c' : ''}`).join(',');
    if (key !== this.worksKey) {
      this.worksKey = key;
      this.roofs.build(this.city.buildings.map((_, i) => this.specOf(i)), works);
      this.moving = true;
    }
  }

  // ------------------------------------------------------------------ theme

  setTheme(name: ThemeName) {
    const t = (this.theme = THEMES[name]);
    this.scene.background = skyTexture(t);
    if (this.city) {
      const s = this.size();
      this.scene.fog = new THREE.Fog(t.skyBottom, s * 1.6, s * 5.5);
    }
    this.hemi.color.set(t.hemiSky);
    this.hemi.groundColor.set(t.hemiGround);
    this.hemi.intensity = t.hemiIntensity;
    this.sun.color.set(t.sun);
    this.sun.intensity = t.sunIntensity;
    (this.ground.material as THREE.MeshStandardMaterial).color.set(t.ground);
    this.renderer.toneMappingExposure = t.exposure;
    this.bloom.enabled = t.bloom.strength > 0;
    this.bloom.strength = t.bloom.strength;
    this.bloom.radius = t.bloom.radius;
    this.bloom.threshold = t.bloom.threshold;
    if (this.streetLevel && this.view === this.scene) this.setView(null);
    if (t.hacker) {
      this.circuitTex ??= circuitTexture();
      if (this.city && !this.glyphTex) this.glyphTex = glyphAtlas(this.glyphWords());
    }
    for (const u of [this.uniforms, this.exploded?.uniforms]) {
      if (!u) continue;
      u.uNight.value = t.night;
      u.uHacker.value = t.hacker;
      u.uGlyphs.value = this.glyphTex ?? null;
    }
    for (const u of [this.groundU, this.districtU]) {
      if (!u) continue;
      u.uHacker.value = t.hacker;
      u.uCircuit.value = this.circuitTex ?? null;
    }
    // hacker: glossy black surfaces (bright edges and grid do the talking)
    const gm = this.ground.material as THREE.MeshStandardMaterial;
    gm.roughness = t.hacker ? 0.18 : 1; gm.metalness = t.hacker ? 0.85 : 0;
    if (this.buildingMesh) {
      const bm = this.buildingMesh.material as THREE.MeshStandardMaterial;
      bm.roughness = t.hacker ? 0.15 : 0.55; bm.metalness = t.hacker ? 0.9 : 0.15;
    }
    this.roofs.setHacker(!!t.hacker);
    this.ways.setTheme(!!t.hacker, t.name === 'night');
    if (this.skin) this.skin.mesh.visible = !!t.hacker;
    if (this.grid) {
      this.grid.visible = !t.hacker;
      const m = this.grid.material as THREE.LineBasicMaterial;
      m.color.set(t.grid);
      m.opacity = t.gridOpacity;
    }
    if (this.outlines) {
      const m = this.outlines.material as THREE.LineBasicMaterial;
      m.color.set(t.outline);
      m.opacity = t.outlineOpacity;
    }
    if (this.districtMesh) this.paintDistricts();
    if (this.city) {
      this.makeLabels(); this.refresh(false); this.collapse(true);
      this.buildFx();
      this.setLinks(this.linkMeshes.map(l => l.view));
    }
  }

  private size() { return Math.max(this.city.bounds.w, this.city.bounds.d); }

  // ------------------------------------------------------------------ loading

  load(city: City) {
    this.city = city;
    this.C = city.commits.length;
    this.commit = this.C - 1;
    this.collapse(true);
    this.setSkin(-1, '');
    this.setLinks([]);
    this.glyphTex?.dispose();
    this.glyphTex = undefined;
    this.hovered = this.selected = this.selectedDistrict = -1;
    this.authorFilter = -1;
    this.baseline = 0;
    this.clearArcs();
    this.commitTs = city.commits.map(k => Date.parse(k.date) / 1000 || 0);
    for (const m of [this.buildingMesh, this.districtMesh]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
    }
    if (this.tierMesh) { this.scene.remove(this.tierMesh); this.tierMesh.geometry.dispose(); this.tierMesh.dispose(); this.tierMesh = undefined; }
    this.expand();
    this.indexImports();

    const { w, d } = city.bounds;
    const s = this.size();
    const cx = w / 2, cz = d / 2;

    // ground, grid and sun sized to the city
    this.ground.scale.set(s * 12, s * 12, 1);
    this.ground.position.set(cx, -0.02, cz);
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    this.grid = new THREE.GridHelper(s * 6, 60);
    (this.grid.material as THREE.LineBasicMaterial).transparent = true;
    (this.grid.material as THREE.LineBasicMaterial).depthWrite = false;
    this.grid.position.set(cx, 0.001, cz);
    this.scene.add(this.grid);
    const dir = new THREE.Vector3(...this.theme.sunDir).normalize();
    this.sun.position.set(cx, 0, cz).addScaledVector(dir, s * 1.5);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -s * 0.8;
    sc.right = sc.top = s * 0.8;
    sc.near = s * 0.1;
    sc.far = s * 3.5;
    sc.updateProjectionMatrix();
    this.sun.shadow.normalBias = s * 0.0012; // scale with the city to avoid acne on low slabs

    // districts
    const dm = circuitMaterial('#ffffff', true);
    this.districtU = dm.uniforms;
    this.districtU.uTile.value = this.groundU.uTile.value = Math.max(10, s * 0.3);
    for (const u of [this.districtU, this.groundU]) { u.uCenter.value.set(cx, cz); u.uRadius.value = s * 0.75; }
    this.districtMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), dm.material, city.districts.length);
    this.districtMesh.receiveShadow = true;
    city.districts.forEach((dist, i) => {
      // the world plot of a multi-repo map (depth -1) is a thin slab: a zero scale would give NaN normals,
      // and bloom spreads NaN pixels over the whole frame
      const top = dist.depth < 0 ? 0.01 : this.districtTop(dist.depth);
      this.tmp.position.set(dist.x + dist.w / 2, dist.depth < 0 ? -1 : top / 2, dist.z + dist.d / 2); // world plot sits under the ground
      this.tmp.scale.set(dist.w, top, dist.d);
      this.tmp.updateMatrix();
      this.districtMesh!.setMatrixAt(i, this.tmp.matrix);
    });
    this.districtMesh.computeBoundingSphere();
    this.scene.add(this.districtMesh);
    this.makeOutlines();

    // buildings
    const n = city.buildings.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.glow = new Float32Array(n);
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1);
    geo.setAttribute('aGlow', this.glowAttr);
    const { material, uniforms } = buildingMaterial();
    this.uniforms = uniforms;
    const widths = city.buildings.map(b => Math.min(b.w, b.d)).sort((a, b) => a - b);
    uniforms.uCell.value = Math.max(0.15, (widths[Math.floor(widths.length / 2)] ?? 1) / 3.2);
    uniforms.uGlyphScale.value = uniforms.uCell.value * 4.5;
    this.roofs.cell = uniforms.uCell.value;
    this.buildingMesh = new THREE.InstancedMesh(geo, material, n);
    this.buildingMesh.castShadow = true;
    this.buildingMesh.receiveShadow = true;
    this.baseY = city.buildings.map(b => this.districtTop(city.districts[b.district].depth));
    this.dimmed = city.buildings.map(() => false);
    this.searchHit = city.buildings.map(() => true);
    this.cur = new Float32Array(n);
    this.target = new Float32Array(n);
    this.heatT = new Float32Array(n);
    // intro: buildings rise from the center outwards
    this.delay = new Float32Array(n);
    city.buildings.forEach((b, i) => {
      const dd = Math.hypot(b.x + b.w / 2 - cx, b.z + b.d / 2 - cz) / (s * 0.7);
      this.delay[i] = 0.25 + dd * 1.1 + Math.random() * 0.15;
    });
    this.scene.add(this.buildingMesh);
    // architecture: shapes come from the newest commit (the one just loaded)
    this.specs = buildSpecs(city, i => (this.exists(i) ? this.importersOf(i).length : 0));
    this.buildTiers();
    this.ways.build(city, this.specs, uniforms.uCell.value, i => this.exists(i));
    this.ways.setVisible(!this.classic);

    this.setTheme(this.theme.name); // fog, labels, colors, uniforms
    this.refresh(false);
    this.intro();
  }

  /** Turn each building's change points and churn into dense per-commit arrays. */
  private expand() {
    const n = this.city.buildings.length, C = this.C;
    const mk = (fill: number) => new Int32Array(n * C).fill(fill);
    this.vals = { loc: mk(ABSENT), lines: mk(0), bytes: mk(0), complexity: mk(0) };
    this.city.buildings.forEach((b, i) => {
      for (let k = 0; k < b.h.length; k++) {
        const [c0, loc, lines, bytes, cx] = b.h[k];
        const c1 = k + 1 < b.h.length ? b.h[k + 1][0] : C;
        for (let c = c0; c < c1; c++) {
          this.vals.loc[i * C + c] = loc;
          this.vals.lines[i * C + c] = lines;
          this.vals.bytes[i * C + c] = bytes;
          this.vals.complexity[i * C + c] = cx;
        }
      }
    });
    this.cumCommits = new Int32Array(n * C);
    this.cumLines = new Int32Array(n * C);
    this.lastTs = new Float64Array(n * C);
    this.city.buildings.forEach((b, i) => {
      const dc = new Int32Array(C), dl = new Int32Array(C), dt = new Float64Array(C);
      for (const [c, commits, lines, ts] of b.ch ?? []) { dc[c] += commits; dl[c] += lines; dt[c] = Math.max(dt[c], ts); }
      let ac = 0, al = 0, at = 0;
      for (let c = 0; c < C; c++) {
        ac += dc[c]; al += dl[c]; at = Math.max(at, dt[c]);
        this.cumCommits[i * C + c] = ac;
        this.cumLines[i * C + c] = al;
        this.lastTs[i * C + c] = at;
      }
    });
  }

  districtTop(depth: number) { return DISTRICT_STEP * (Math.max(-1, depth) + 1); }

  // ------------------------------------------------------------------ code links (imports inside a repo)

  private indexImports() {
    const n = this.city.buildings.length;
    this.importers = Array.from({ length: n }, () => []);
    this.dirImporters = new Map();
    this.city.buildings.forEach((b, i) => {
      for (const j of b.imp ?? []) this.importers[j]?.push(i);
      for (const d of b.impd ?? []) {
        const l = this.dirImporters.get(d) ?? [];
        l.push(i);
        this.dirImporters.set(d, l);
      }
    });
  }

  /** Files that import building i: directly, or through its package directory. */
  importersOf(i: number): number[] {
    const set = new Set(this.importers[i] ?? []);
    // a Go package import reaches every file of the package, except its tests
    if (!this.city.buildings[i].name.endsWith('_test.go')) {
      for (const k of this.dirImporters.get(this.city.buildings[i].district) ?? []) if (k !== i) set.add(k);
    }
    return [...set].filter(k => this.exists(k));
  }

  dependents(i: number) { return this.importersOf(i).length; }

  /** Roof centre of building i, on top of its rooftop equipment (where code-link traces plug in). */
  buildingAnchor(i: number, lift = 0.03): THREE.Vector3 {
    const b = this.city.buildings[i];
    const gear = this.classic ? 0 : this.roofs.heightAbove(i);
    return new THREE.Vector3(b.x + b.w / 2, this.baseY[i] + Math.max(this.target[i], MIN_H) + gear + lift, b.z + b.d / 2);
  }

  /** Height of the data-bus layer: just above the current skyline. */
  private busLayer(salt: number) {
    let tallest = 0;
    for (let i = 0; i < this.target.length; i++) tallest = Math.max(tallest, this.baseY[i] + this.target[i]);
    const s = this.size();
    return tallest * 1.06 + s * 0.012 + (salt % 7) * s * 0.0035;
  }

  districtAnchor(d: number, lift = 0.03): THREE.Vector3 { return this.districtCenter(d, lift); }

  private linkPalette(): { out: THREE.Color; in: THREE.Color; all: THREE.Color } {
    switch (this.theme.name) {
      case 'hacker': return { out: new THREE.Color('#36e0ff'), in: new THREE.Color('#ff3cd0'), all: new THREE.Color('#b44cff') };
      case 'day': return { out: new THREE.Color('#1c7ed6'), in: new THREE.Color('#d6336c'), all: new THREE.Color('#5f3dc4') };
      default: return { out: new THREE.Color('#4dd4ff'), in: new THREE.Color('#ff6bd6'), all: new THREE.Color('#9a7bff') };
    }
  }

  /** Redraw code-link traces for the current mode, selection and commit. */
  refreshCodeLinks() {
    if (!this.city) return;
    this.codeLinks.setAdditive(this.theme.name !== 'day');
    const s = this.size();
    this.codeLinks.spacing = s * 0.05;
    this.codeLinks.base = this.theme.name === 'day' ? 0.55 : 0.3;
    const pal = this.linkPalette();
    const traces: Trace[] = [];
    const w = Math.max(0.06, s * 0.0016);
    const speed = s * 0.06;
    const sel = this.selected;
    if (this.codeLinkMode !== 'off' && sel >= 0 && this.exists(sel)) {
      const b = this.city.buildings[sel];
      const from = this.buildingAnchor(sel);
      for (const j of b.imp ?? []) if (this.exists(j)) traces.push({ points: busRoute(from, this.buildingAnchor(j), this.busLayer(j), j), color: pal.out, width: w * 1.6, speed });
      for (const d of b.impd ?? []) traces.push({ points: busRoute(from, this.districtAnchor(d), this.busLayer(d), d), color: pal.out, width: w * 1.6, speed });
      for (const k of this.importersOf(sel)) traces.push({ points: busRoute(this.buildingAnchor(k), from, this.busLayer(k + 3), k + 1), color: pal.in, width: w * 1.3, speed });
    } else if (this.codeLinkMode === 'all') {
      traces.push(...this.cityTraces(pal.all, w, speed));
    }
    this.codeLinks.set(traces);
  }

  /** Whole-city view: every file edge when there are few, else bundles between directories. */
  private cityTraces(color: THREE.Color, w: number, speed: number): Trace[] {
    const edges: [number, THREE.Vector3, THREE.Vector3, number][] = [];
    let total = 0;
    this.city.buildings.forEach((b, i) => { if (this.exists(i)) total += (b.imp?.length ?? 0) + (b.impd?.length ?? 0); });
    if (total <= 350) {
      this.city.buildings.forEach((b, i) => {
        if (!this.exists(i)) return;
        const from = this.buildingAnchor(i);
        for (const j of b.imp ?? []) if (this.exists(j)) edges.push([i * 31 + j, from, this.buildingAnchor(j), 1]);
        for (const d of b.impd ?? []) edges.push([i * 31 + d, from, this.districtAnchor(d), 1]);
      });
      return edges.map(([salt, a, b]) => ({ points: busRoute(a, b, this.busLayer(salt), salt), color, width: w, speed }));
    }
    // bundle by directory: ancestors at a depth that keeps the number of groups readable
    const ds = this.city.districts;
    const depthOf = (d: number) => ds[d].depth;
    const maxDepth = ds.reduce((m, x) => Math.max(m, x.depth), 0);
    let G = 1;
    for (let g = Math.min(3, maxDepth); g >= 1; g--) {
      if (ds.filter(x => x.depth === g).length <= 60) { G = g; break; }
    }
    const groupOf = (d: number) => { let x = d; while (x > 0 && depthOf(x) > G) x = ds[x].parent; return x; };
    const counts = new Map<string, number>();
    this.city.buildings.forEach((b, i) => {
      if (!this.exists(i)) return;
      const ga = groupOf(b.district);
      const add = (gb: number) => { if (ga !== gb) counts.set(`${ga}:${gb}`, (counts.get(`${ga}:${gb}`) ?? 0) + 1); };
      for (const j of b.imp ?? []) if (this.exists(j)) add(groupOf(this.city.buildings[j].district));
      for (const d of b.impd ?? []) add(groupOf(d));
    });
    const out: Trace[] = [];
    for (const [k, n] of counts) {
      const [ga, gb] = k.split(':').map(Number);
      out.push({ points: busRoute(this.districtAnchor(ga, 0.04), this.districtAnchor(gb, 0.04), this.busLayer(ga + gb), ga + gb), color, width: w * (1 + Math.log2(n)), speed });
    }
    return out;
  }

  exists(i: number, c = this.commit) { return this.vals.loc[i * this.C + c] >= 0; }
  private value(i: number, c = this.commit) { return Math.max(0, this.vals[this.metric][i * this.C + c]); }

  private shape(v: number): number {
    if (this.scale === 'linear') return v;
    if (this.scale === 'sqrt') return Math.sqrt(v);
    return Math.log1p(v);
  }

  // ------------------------------------------------------------------ queries

  totals(c = this.commit): Totals {
    let files = 0, loc = 0;
    const L = this.vals.loc;
    for (let i = 0; i < this.city.buildings.length; i++) {
      const v = L[i * this.C + c];
      if (v >= 0) { files++; loc += v; }
    }
    return { files, loc };
  }

  allTotals(): Totals[] { return Array.from({ length: this.C }, (_, c) => this.totals(c)); }

  series(i: number): number[] {
    return Array.from({ length: this.C }, (_, c) => Math.max(0, this.vals.loc[i * this.C + c]));
  }

  valuesAt(i: number, c = this.commit) {
    const o = i * this.C + c;
    return { exists: this.vals.loc[o] >= 0, loc: this.vals.loc[o], lines: this.vals.lines[o], bytes: this.vals.bytes[o],
      complexity: this.vals.complexity[o], lastChange: this.lastTs[o] };
  }

  /** All non-merge commits touching file i up to the newest sample. */
  totalCommits(i: number) { return this.cumCommits[i * this.C + this.C - 1]; }

  /** Commit time (unix s) of a sample. */
  timeOf(c = this.commit) { return this.commitTs[c] ?? 0; }

  isCode(i: number) { return !NON_CODE.has(this.city.buildings[i].lang); }

  /** Knowledge-risk bucket (index into RISK). */
  risk(i: number): number {
    const own = this.city.buildings[i].own;
    if (!own) return 0;
    const a = this.city.authors?.[own[0]];
    const newest = this.commitTs[this.C - 1];
    const share = own[1] / Math.max(1, this.totalCommits(i));
    // an inactive owner only matters when they hold most of the knowledge
    if (a && newest - a.last > INACTIVE_DAYS * 86400 && (share >= 0.5 || own[2] <= 2)) return 4;
    return own[2] >= 3 ? 1 : own[2] === 2 ? 2 : 3;
  }

  hotspotScore(i: number) {
    if (!this.exists(i) || !this.isCode(i)) return 0;
    return this.churnAt(i).commits * this.vals.complexity[i * this.C + this.commit];
  }

  churnAt(i: number): Churn {
    const C = this.C, c = this.commit, o = i * C;
    const from = this.churnWindow > 0 ? c - this.churnWindow : -1; // exclusive lower bound
    const base = from >= 0 ? o + from : -1;
    return {
      commits: this.cumCommits[o + c] - (base >= 0 ? this.cumCommits[base] : 0),
      lines: this.cumLines[o + c] - (base >= 0 ? this.cumLines[base] : 0),
      allCommits: this.cumCommits[o + c],
      allLines: this.cumLines[o + c],
    };
  }

  topHotspots(n: number, within?: (i: number) => boolean): Hotspot[] {
    const out: Hotspot[] = [];
    for (let i = 0; i < this.city.buildings.length; i++) {
      if (!this.exists(i) || NON_CODE.has(this.city.buildings[i].lang)) continue;
      if (within && !within(i)) continue;
      const commits = this.churnAt(i).commits;
      if (commits <= 0) continue;
      const loc = this.vals.complexity[i * this.C + this.commit];
      if (loc <= 0) continue;
      out.push({ index: i, score: commits * loc, commits, loc });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Buildings inside district d (recursively), present at the current commit. */
  districtMembers(d: number): number[] {
    const inside = new Set<number>([d]);
    this.city.districts.forEach((x, i) => { if (inside.has(x.parent)) inside.add(i); }); // parents precede children
    const out: number[] = [];
    this.city.buildings.forEach((b, i) => { if (inside.has(b.district) && this.exists(i)) out.push(i); });
    return out;
  }

  // ------------------------------------------------------------------ updates

  setCommit(c: number) {
    c = Math.max(0, Math.min(this.C - 1, c));
    if (c === this.commit) return;
    this.commit = c;
    this.pulse = 1;
    if (this.hovered >= 0 && !this.exists(this.hovered)) this.hovered = -1;
    if (this.selected >= 0 && !this.exists(this.selected)) this.selected = -1;
    this.refresh(false);
  }

  /** Recompute targets, colors, glow and change tints for the current state. */
  refresh(instant: boolean) {
    if (!this.buildingMesh) return;
    const n = this.city.buildings.length;
    let maxShaped = 0;
    const arr = this.vals[this.metric];
    for (let k = 0; k < arr.length; k++) if (arr[k] > 0) maxShaped = Math.max(maxShaped, this.shape(arr[k]));
    const tallest = this.size() * 0.16 * this.mult * this.theme.heightBoost;
    for (let i = 0; i < n; i++) {
      this.target[i] = this.exists(i)
        ? Math.max(MIN_H, maxShaped > 0 ? (this.shape(this.value(i)) / maxShaped) * tallest : MIN_H)
        : 0;
    }
    if (instant) { this.cur.set(this.target); this.delay.fill(0); }
    this.moving = true;
    this.step(0);
    this.updateHighwayVisibility();

    const maxDepth = this.city.districts.reduce((m, x) => Math.max(m, x.depth), 0);

    this.heatT.fill(0);
    const heatOf = (val: (i: number) => number, log = true) => {
      const v = new Float32Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) if (this.exists(i)) { v[i] = Math.max(0, val(i)); max = Math.max(max, v[i]); }
      const norm = log ? Math.log1p(max) || 1 : max || 1;
      for (let i = 0; i < n; i++) this.heatT[i] = log ? Math.log1p(v[i]) / norm : v[i] / norm;
    };
    const now = this.timeOf();
    switch (this.colorMode) {
      case 'churn': heatOf(i => this.churnAt(i).commits); break;
      case 'hotspot': heatOf(i => this.hotspotScore(i)); break;
      case 'complexity': heatOf(i => (this.isCode(i) ? this.vals.complexity[i * this.C + this.commit] : 0)); break;
      case 'dependents': heatOf(i => this.dependents(i)); break;
      case 'age': { // recent changes are hot; a year or more is cold
        for (let i = 0; i < n; i++) {
          const t = this.lastTs[i * this.C + this.commit];
          this.heatT[i] = t > 0 ? Math.max(0, 1 - Math.sqrt(Math.max(0, now - t) / (365 * 86400))) : 0;
        }
        break;
      }
    }
    const tint = this.theme.buildingTint;
    const B = this.baseline, cur = this.commit;
    this.baseColors = this.city.buildings.map((b, i) => {
      let c: THREE.Color;
      switch (this.colorMode) {
        case 'language': c = languageColor(b.lang); break;
        case 'depth': c = depthColor(this.city.districts[b.district].depth, maxDepth); break;
        case 'owner': c = b.own ? authorColor(b.own[0]) : new THREE.Color('#596277'); break;
        case 'knowledge': c = new THREE.Color(RISK_COLORS[this.risk(i)]); break;
        case 'compare': {
          const was = this.vals.loc[i * this.C + B], now2 = this.vals.loc[i * this.C + cur];
          if (was < 0) c = new THREE.Color('#40c057'); // new since baseline
          else if (now2 > was) c = new THREE.Color('#ffa94d').lerp(new THREE.Color('#ff6b6b'), Math.min(1, (now2 - was) / Math.max(20, was)));
          else if (now2 < was) c = new THREE.Color('#4dabf7');
          else c = new THREE.Color(this.theme.night ? '#3b4256' : '#aab2c0');
          break;
        }
        default: c = heat(this.heatT[i]); // churn, hotspot, complexity, age
      }
      return c.multiplyScalar(tint);
    });
    this.change = new Uint8Array(n);
    this.changed = [];
    if (this.commit > 0) {
      for (let i = 0; i < n; i++) {
        const o = i * this.C + this.commit;
        const was = this.vals.loc[o - 1], now = this.vals.loc[o];
        if (now >= 0 && was < 0) this.change[i] = 1;
        else if (now >= 0 && (now !== was || this.vals.bytes[o] !== this.vals.bytes[o - 1])) this.change[i] = 2;
        if (this.change[i]) this.changed.push(i);
      }
    }
    this.updateCondition();
    this.recolor();
    if (this.selected >= 0 || this.arcs.children.length) this.showCoupling(this.selected);
    this.refreshCodeLinks();
  }

  /** Ease displayed heights toward their targets and write instance matrices. */
  private step(dt: number) {
    const mesh = this.buildingMesh!;
    const k = dt <= 0 ? 0 : 1 - Math.exp(-dt * 7);
    let any = false;
    for (let i = 0; i < this.cur.length; i++) {
      if (this.delay[i] > 0) { this.delay[i] -= dt; any = true; if (dt > 0) continue; }
      let c = this.cur[i];
      const t = this.target[i];
      if (c === t && dt > 0) continue;
      c += (t - c) * k;
      if (Math.abs(t - c) < 0.003) c = t; else any = true;
      this.cur[i] = c;
      const h = Math.max(c, 0.01);
      // absent buildings sink below the district surface so they neither show nor get picked
      const hide = c <= 0.02 || this.exploded?.building === i;
      this.placeBuilding(i, h, hide);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (this.tierMesh) this.tierMesh.instanceMatrix.needsUpdate = true;
    this.roofs.flush();
    this.ways.update(i => this.podiumTop(i, false));
    this.moving = any;
    if (!any) {
      mesh.computeBoundingSphere(); mesh.computeBoundingBox();
      if (this.tierMesh && this.tierMesh.count) { this.tierMesh.computeBoundingSphere(); this.tierMesh.computeBoundingBox(); }
    }
  }

  private colorFor(i: number): THREE.Color {
    const c = this.baseColors[i].clone();
    if (i === this.selected) return this.theme.hacker ? c : c.lerp(new THREE.Color(0xffffff), 0.35);
    if (i === this.hovered) return c.lerp(new THREE.Color(0xffffff), 0.25);
    if (this.dimmed[i]) return c.lerp(new THREE.Color(this.theme.dim), 0.85);
    if (this.showChanges && this.pulse > 0 && this.change[i]) {
      return c.lerp(new THREE.Color(this.change[i] === 1 ? 0x4dff88 : 0xffc233), 0.75 * this.pulse);
    }
    return c;
  }

  private glowFor(i: number): number {
    const night = this.theme.night;
    if (i === this.selected) return this.theme.hacker ? 0.05 : 0.1 + 0.15 * night;
    if (this.dimmed[i]) return 0;
    let g = 0;
    if (this.showChanges && this.change[i] && this.pulse > 0) g = (0.2 + 0.6 * night) * this.pulse;
    if (this.colorMode === 'hotspot' || this.colorMode === 'churn') {
      if (this.heatT[i] > 0.6) g = Math.max(g, ((this.heatT[i] - 0.6) / 0.4) * (0.12 + 0.45 * night));
    }
    if (this.partners.has(i)) g = Math.max(g, 0.12 + 0.25 * night);
    return g;
  }

  private recolor() {
    if (!this.buildingMesh) return;
    for (let i = 0; i < this.baseColors.length; i++) this.paintOne(i);
    this.flushPaint();
  }

  /** Color and glow of building i, on every tier. */
  private paintOne(i: number) {
    const c = this.colorFor(i), g = this.glowFor(i);
    this.buildingMesh!.setColorAt(i, c);
    this.glow[i] = g;
    const f = this.tierFirst[i];
    if (f >= 0 && this.tierMesh) {
      const n = this.specOf(i).tiers.length - 1;
      for (let k = 0; k < n; k++) { this.tierMesh.setColorAt(f + k, c); this.tierGlow[f + k] = g; }
    }
  }

  private flushPaint() {
    if (this.buildingMesh!.instanceColor) this.buildingMesh!.instanceColor.needsUpdate = true;
    this.glowAttr!.needsUpdate = true;
    if (this.tierMesh) {
      if (this.tierMesh.instanceColor) this.tierMesh.instanceColor.needsUpdate = true;
      this.tierMesh.geometry.getAttribute('aGlow').needsUpdate = true;
    }
  }

  setShowChanges(v: boolean) { this.showChanges = v; this.recolor(); }

  private paint(i: number) {
    if (i < 0 || !this.buildingMesh) return;
    this.paintOne(i);
    this.flushPaint();
  }

  private paintDistricts() {
    const m = this.districtMesh!;
    this.city.districts.forEach((d, i) => {
      const c = this.theme.district(d.depth);
      if (i === this.selectedDistrict) c.lerp(new THREE.Color(this.theme.outline), 0.45);
      m.setColorAt(i, c);
    });
    m.instanceColor!.needsUpdate = true;
  }

  /** Dim buildings whose path does not contain the query. Returns matches present at the current commit. */
  search(q: string): number[] {
    q = q.trim().toLowerCase();
    const hits: number[] = [];
    this.city.buildings.forEach((b, i) => {
      this.searchHit[i] = !q || b.path.toLowerCase().includes(q);
      if (this.searchHit[i] && q && this.exists(i)) hits.push(i);
    });
    this.applyDim();
    return hits;
  }

  setAuthorFilter(a: number) { this.authorFilter = a; this.applyDim(); }

  private applyDim() {
    this.city.buildings.forEach((b, i) => {
      this.dimmed[i] = !this.searchHit[i] || (this.authorFilter >= 0 && b.own?.[0] !== this.authorFilter);
    });
    this.recolor();
  }

  // ------------------------------------------------------------------ picking & selection

  pick(clientX: number, clientY: number): Pick {
    if (!this.buildingMesh || !this.districtMesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const objects: THREE.Object3D[] = [...this.solidMeshes(false), this.districtMesh, ...this.linkMeshes.map(l => l.pick), ...this.gates.meshes];
    if (this.exploded) objects.unshift(this.exploded.mesh);
    for (const hit of this.raycaster.intersectObjects(objects, false)) { // nearest first
      if (this.exploded && hit.object === this.exploded.mesh && hit.instanceId !== undefined) return { kind: 'floor', index: hit.instanceId };
      const lm = this.linkMeshes.find(l => l.pick === hit.object);
      if (lm) return { kind: 'link', index: lm.view.index };
      if (hit.instanceId !== undefined && this.gates.meshes.includes(hit.object)) {
        const gb = this.gates.buildingOf(hit.object, hit.instanceId);
        if (gb >= 0 && this.exists(gb)) return { kind: 'gate', index: gb };
        continue;
      }
      const id = hit.instanceId ?? -1;
      if (id < 0) continue;
      if (hit.object === this.buildingMesh || hit.object === this.tierMesh) {
        const b = this.ownerOf(hit);
        if (b >= 0 && this.exists(b) && !this.dimmed[b]) return { kind: 'building', index: b };
        continue;
      }
      if (hit.object === this.districtMesh) return id === 0 ? null : { kind: 'district', index: id }; // district 0 is the root / world plot
    }
    return null;
  }

  setHover(i: number) {
    if (i === this.hovered) return;
    const prev = this.hovered;
    this.hovered = i;
    this.paint(prev);
    this.paint(i);
  }

  setSelected(i: number) {
    const prev = this.selected;
    this.selected = i;
    this.paint(prev);
    this.paint(i);
    this.showCoupling(i);
    this.refreshCodeLinks();
  }

  private clearArcs() {
    for (const o of [...this.arcs.children]) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.arcs.remove(m);
    }
    const old = [...this.partners.keys()];
    this.partners.clear();
    old.forEach(p => this.paint(p));
  }

  /** Glowing arcs from building i to the files it changes together with. */
  private showCoupling(i: number) {
    this.clearArcs();
    if (i < 0) return;
    const b = this.city.buildings[i];
    const s = this.size();
    const top = (k: number) => {
      const x = this.city.buildings[k];
      return new THREE.Vector3(x.x + x.w / 2, this.baseY[k] + Math.max(this.target[k], MIN_H), x.z + x.d / 2);
    };
    const from = top(i);
    for (const [j, , degree] of b.cpl ?? []) {
      if (!this.exists(j)) continue;
      this.partners.set(j, degree);
      const to = top(j);
      const dist = from.distanceTo(to);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      mid.y = Math.max(from.y, to.y) + dist * 0.35 + s * 0.01;
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const t = degree / 100;
      const col = this.theme.hacker
        ? new THREE.Color('#ffd23c').lerp(new THREE.Color('#ff7ad9'), t).multiplyScalar(0.45)
        : new THREE.Color().setHSL(0.52 - 0.5 * t, 1, 0.55).multiplyScalar(1 + 0.6 * this.theme.night);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45 + 0.5 * t, toneMapped: false, depthWrite: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, s * (0.0008 + 0.0022 * t), 6), mat);
      tube.renderOrder = 5;
      this.arcs.add(tube);
      this.paint(j);
    }
    this.importArcs(i);
  }

  setSelectedDistrict(d: number) {
    this.selectedDistrict = d;
    if (this.districtMesh) this.paintDistricts();
  }

  // ------------------------------------------------------------------ camera

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 1100) {
    this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur };
  }

  private overview(): [THREE.Vector3, THREE.Vector3] {
    const { w, d } = this.city.bounds;
    const s = this.size();
    return [new THREE.Vector3(w / 2 - s * 0.5, s * 0.62, d / 2 + s * 0.85), new THREE.Vector3(w / 2, 0, d / 2)];
  }

  private setLimits() {
    const s = this.size();
    this.camera.near = Math.max(0.05, s / 5000);
    this.camera.far = s * 14;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.max(1, s / 200);
    this.controls.maxDistance = s * 4;
  }

  /** Swoop in from high above when a city loads. */
  private intro() {
    this.setLimits();
    const [p, t] = this.overview();
    const s = this.size();
    this.camera.position.set(t.x + s * 1.3, s * 2.1, t.z - s * 1.4);
    this.controls.target.copy(t);
    this.controls.update();
    this.flyTo(p, t, 2600);
  }

  /** Fly back to the overview. */
  frame() { const [p, t] = this.overview(); this.flyTo(p, t); }

  /** Fly to a building, keeping the current viewing direction. */
  focus(i: number) {
    const b = this.city.buildings[i];
    const h = this.target[i];
    const t = new THREE.Vector3(b.x + b.w / 2, this.baseY[i] + h * 0.5, b.z + b.d / 2);
    const dist = Math.max(h * 2.2, Math.max(b.w, b.d) * 5, this.size() * 0.06);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) { dir.y = 0.35; dir.normalize(); }
    this.flyTo(t.clone().addScaledVector(dir, dist), t);
  }

  /** Fly to frame a district. */
  focusDistrict(d: number) {
    const x = this.city.districts[d];
    const t = new THREE.Vector3(x.x + x.w / 2, 0, x.z + x.d / 2);
    const dist = Math.max(x.w, x.d) * 1.25;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.5) { dir.y = 0.5; dir.normalize(); }
    this.flyTo(t.clone().addScaledVector(dir, dist), t);
  }

  // ------------------------------------------------------------------ connections between cities

  private districtCenter(d: number, lift = 0): THREE.Vector3 {
    const x = this.city.districts[d];
    return new THREE.Vector3(x.x + x.w / 2, this.districtTop(Math.max(0, x.depth)) + lift, x.z + x.d / 2);
  }

  private linkColors(kind: LinkKind): [THREE.Color, THREE.Color] {
    const t = this.theme.name;
    if (kind === 'data') return t === 'day' ? [new THREE.Color('#862e9c'), new THREE.Color('#be4bdb')] : [new THREE.Color('#b57cff'), new THREE.Color('#ff7ad9')];
    if (kind === 'api') return t === 'day' ? [new THREE.Color('#d9480f'), new THREE.Color('#f59f00')] : [new THREE.Color('#ff9f1c'), new THREE.Color('#ffd166')];
    if (kind === 'message') return t === 'day' ? [new THREE.Color('#087f5b'), new THREE.Color('#0ca678')] : [new THREE.Color('#2bffb0'), new THREE.Color('#7dffe0')];
    if (kind === 'people') return t === 'day' ? [new THREE.Color('#e8590c'), new THREE.Color('#f08c00')] : [new THREE.Color('#ffb547'), new THREE.Color('#ff7ad9')];
    if (t === 'hacker') return [new THREE.Color('#d23cff'), new THREE.Color('#36e0ff')];
    if (t === 'day') return [new THREE.Color('#1c7ed6'), new THREE.Color('#7048e8')];
    return [new THREE.Color('#4dd4ff'), new THREE.Color('#b18cff')];
  }

  /** Draw arcs between cities (dependency: flowing from dependent to dependency). */
  setLinks(views: LinkView[]) {
    for (const l of this.linkMeshes) {
      this.linkGroup.remove(l.mesh, l.pick);
      l.mesh.geometry.dispose(); l.pick.geometry.dispose(); l.mat.dispose();
      if (l.label) { this.linkGroup.remove(l.label); l.label.material.map?.dispose(); l.label.material.dispose(); }
    }
    this.linkMeshes = [];
    for (const o of [...this.highwayGroup.children]) { this.highwayGroup.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    if (!this.city?.repos) return;
    const s = this.size();
    const additive = this.theme.name !== 'day';
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.roadPaths = [];
    this.buildHighways(views.filter(v => v.kind === 'api' || v.kind === 'message' || v.kind === 'data'));
    for (const v of views) {
      if (v.kind === 'api' || v.kind === 'message' || v.kind === 'data') continue;
      const from = this.districtCenter(this.city.repos[v.from].district, 0.05);
      const to = this.districtCenter(this.city.repos[v.to].district, 0.05);
      const dist = from.distanceTo(to);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      // clear the tallest towers so arcs stay visible (towers are taller in hacker mode)
      const tallest = s * 0.16 * this.mult * this.theme.heightBoost;
      mid.y += dist * (v.kind === 'dependency' ? 0.38 : 0.2) + tallest * (v.kind === 'dependency' ? 1.5 : 1.1) + s * 0.02;
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const radius = s * (v.kind === 'dependency' ? 0.0025 + 0.0035 * Math.min(1, v.strength) : 0.0018) * (this.theme.hacker ? 1.6 : 1);
      const [ca, cb] = this.linkColors(v.kind);
      const mat = flowMaterial(ca, cb, Math.max(3, Math.round(dist / (s * 0.08))), v.kind === 'dependency' ? 0.35 : 0.12, additive);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, radius, 8), mat);
      mesh.renderOrder = 6;
      const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, Math.max(radius * 4, s * 0.012), 6), pickMat);
      this.linkGroup.add(mesh, pick);
      const lm: LinkMesh = { view: v, mesh, pick, mat };
      if (v.label) {
        lm.label = this.textSprite(v.label, Math.max(0.8, s * 0.016));
        lm.label.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, Math.max(0.8, s * 0.016) * 0.9, 0));
        this.linkGroup.add(lm.label);
      }
      this.linkMeshes.push(lm);
    }
    this.highlightLink(this.linkHi);
    this.updateHighwayVisibility();
  }

  /** The highways as ground polylines (for maps). */
  roads(): Road[] { return this.roadPaths; }

  /** A highway exists only while both of its cities do (a city appears at its first sampled commit). */
  private updateHighwayVisibility() {
    if (!this.city?.repos || !this.linkMeshes.length) return;
    const live = new Set<number>();
    this.city.buildings.forEach((b, i) => { if (this.exists(i)) live.add(b.repo ?? 0); });
    for (const l of this.linkMeshes) {
      if (l.view.kind !== 'api' && l.view.kind !== 'message' && l.view.kind !== 'data') continue;
      const on = live.has(l.view.from) && live.has(l.view.to);
      l.mesh.visible = on;
      for (const m of l.extraMeshes ?? []) m.visible = on;
      l.pick.visible = on;
      if (l.label) l.label.visible = on;
    }
  }

  /** Entrance / exit markers on the roofs (one spot per building with doors). */
  setGates(spots: GateSpot[]) { this.gates.set(spots, this.cell, this.city ? this.size() : 1); }
  setGatesVisible(on: boolean) { this.gates.group.visible = on && this.gates.count > 0; }

  /** Route of a highway from city A to city B around the other cities (see roads.ts). */
  private highwayRoute(from: number, to: number): [number, number][] {
    const rs = this.city.repos!;
    const others = rs.filter((_, k) => k !== from && k !== to).map(r => this.city.districts[r.district]);
    return route(this.city.districts[rs[from].district], this.city.districts[rs[to].district], others, this.cell);
  }

  /** Highways between cities: asphalt strips from the rim of one city to the rim of the other. */
  private buildHighways(views: LinkView[]) {
    const width = Math.max(this.cell * 1.5, this.size() * 0.006);
    const dark = this.theme.name === 'day';
    const lanes = new Map<string, number>(); // lateral slot per city pair, so highways side by side do not overlap
    const total = new Map<string, number>();
    for (const v of views) { const k = Math.min(v.from, v.to) + ':' + Math.max(v.from, v.to); total.set(k, (total.get(k) ?? 0) + 1); }
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const v of views) {
      const k = Math.min(v.from, v.to) + ':' + Math.max(v.from, v.to);
      const slot = lanes.get(k) ?? 0; lanes.set(k, slot + 1);
      let pts = this.highwayRoute(v.from, v.to);
      const off = (slot - ((total.get(k) ?? 1) - 1) / 2) * width * 1.35;
      if (pts.length === 2) {
        const dx = pts[1][0] - pts[0][0], dz = pts[1][1] - pts[0][1], len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        pts = pts.map(p => [p[0] - (dz / len) * off, p[1] + (dx / len) * off] as [number, number]);
      } else {
        pts = pts.map(p => [p[0] + off, p[1] + off] as [number, number]);
      }
      const [c1] = this.linkColors(v.kind);
      this.roadPaths.push({ kind: v.kind, pts, width, from: v.from, to: v.to });
      let longest = 0, longLen = 0;
      const segs: { mesh: THREE.Mesh; len: number; mid: THREE.Vector3; p0: [number, number]; p1: [number, number] }[] = [];
      const boxes: THREE.BufferGeometry[] = [];
      const segMeshes: THREE.Mesh[] = [];
      for (let q = 0; q + 1 < pts.length; q++) {
        const p0 = pts[q], p1 = pts[q + 1];
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const mat = highwayMaterial(c1.clone(), len, v.kind === 'api', dark);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len + (q + 2 < pts.length ? width : 0) + (q > 0 ? width : 0), width).rotateX(-Math.PI / 2), mat);
        mesh.position.set((p0[0] + p1[0]) / 2, 0.06, (p0[1] + p1[1]) / 2);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.renderOrder = 4;
        segMeshes.push(mesh);
        this.highwayGroup.add(mesh);
        const box = new THREE.BoxGeometry(len, Math.max(width, this.size() * 0.01), Math.max(width * 2, this.size() * 0.01));
        box.applyMatrix4(new THREE.Matrix4().compose(mesh.position, new THREE.Quaternion().setFromEuler(mesh.rotation), new THREE.Vector3(1, 1, 1)));
        boxes.push(box);
        segs.push({ mesh, len, mid: mesh.position.clone(), p0, p1 });
        if (len > longLen) { longLen = len; longest = segs.length - 1; }
      }
      if (!segs.length) continue;
      // one LinkMesh per highway: the longest segment stands for it (highlight / time uniforms of every segment follow it)
      const main = segs[longest];
      const mats = segs.map(sg => sg.mesh.material as THREE.ShaderMaterial);
      const pick = new THREE.Mesh(mergeGeometries(boxes.map(b => { const g = b.clone(); g.deleteAttribute('uv'); g.deleteAttribute('normal'); return g; }))!, pickMat);
      this.linkGroup.add(pick);
      const lm: LinkMesh = { view: v, mesh: main.mesh, pick, mat: mats[longest], extra: mats.filter((_, i) => i !== longest), extraMeshes: segMeshes.filter(m => m !== main.mesh) };
      if (v.label) {
        const h = Math.max(0.8, this.size() * 0.016);
        lm.label = this.textSprite(v.label, h);
        const f = (slot + 1) / ((total.get(k) ?? 1) + 1);
        lm.label.position.set(main.p0[0] + (main.p1[0] - main.p0[0]) * f, h * (0.9 + 1.1 * slot), main.p0[1] + (main.p1[1] - main.p0[1]) * f);
        this.linkGroup.add(lm.label);
      }
      this.linkMeshes.push(lm);
    }
  }

  /** Arcs between the buildings behind one highway (calls and the routes they reach, publishers and subscribers). */
  private viaArcs(vias: { a: number; b: number }[], kind: LinkKind, from?: number) {
    const s = this.size();
    const top = (k: number) => {
      const x = this.city.buildings[k];
      return new THREE.Vector3(x.x + x.w / 2, this.baseY[k] + Math.max(this.target[k], MIN_H), x.z + x.d / 2);
    };
    const [ca, cb] = this.linkColors(kind);
    for (const v of vias.slice(0, 120)) {
      if (!this.exists(v.a) || !this.exists(v.b) || (from !== undefined && v.a !== from && v.b !== from)) continue;
      const a = top(v.a), b = top(v.b), dist = a.distanceTo(b);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y = Math.max(a.y, b.y) + dist * 0.3 + s * 0.01;
      const mat = flowMaterial(ca.clone().lerp(new THREE.Color('#ffffff'), 0.25), cb, Math.max(4, Math.round(dist / (s * 0.04))), 0.6, this.theme.name !== 'day');
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 64, s * 0.0022, 6), mat);
      tube.renderOrder = 7;
      this.arcs.add(tube);
    }
  }

  highlightLink(index: number) {
    const l = index >= 0 ? this.city?.links?.[index] : undefined;
    if (l && (l.kind === 'api' || l.kind === 'message') && l.via) { this.clearArcs(); this.viaArcs(l.via.map(v => ({ a: v.a, b: v.b })), l.kind); }
    this.linkHi = index;
    for (const l of this.linkMeshes) {
      const on = l.view.index === index;
      l.mat.uniforms.uHi.value = on ? 1 : 0;
      for (const m of l.extra ?? []) m.uniforms.uHi.value = on ? 1 : 0;
      if (l.label) l.label.material.opacity = index < 0 || on ? 1 : 0.4;
    }
  }

  private textSprite(text: string, height: number): THREE.Sprite {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d')!;
    const font = this.theme.hacker ? '600 34px "JetBrains Mono", ui-monospace, monospace' : '600 36px Inter, system-ui, sans-serif';
    ctx.font = font;
    const tw = Math.ceil(ctx.measureText(text).width) + 36;
    cv.width = tw; cv.height = 60;
    ctx.font = font;
    ctx.fillStyle = this.theme.labelBg;
    ctx.beginPath(); ctx.roundRect(1, 1, tw - 2, 58, 29); ctx.fill();
    ctx.fillStyle = this.theme.labelFg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 18, 32);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false }));
    sp.scale.set((height * tw) / 60, height, 1);
    sp.renderOrder = 12;
    return sp;
  }

  /** Arcs from building i to the directories it imports in other cities. */
  private importArcs(i: number) {
    const links = this.city.links ?? [];
    if (!links.length) return;
    const s = this.size();
    const b = this.city.buildings[i];
    const from = new THREE.Vector3(b.x + b.w / 2, this.baseY[i] + Math.max(this.target[i], MIN_H), b.z + b.d / 2);
    const [ca, cb] = this.linkColors('dependency');
    for (const l of links) {
      if (l.kind !== 'dependency') continue;
      for (const [bi, d] of l.files ?? []) {
        if (bi !== i) continue;
        const to = this.districtCenter(d, 0.05);
        const dist = from.distanceTo(to);
        const mid = from.clone().add(to).multiplyScalar(0.5);
        mid.y = Math.max(from.y, to.y) + dist * 0.3 + s * 0.01;
        const mat = flowMaterial(ca.clone().lerp(new THREE.Color('#ffffff'), 0.3), cb, Math.max(4, Math.round(dist / (s * 0.04))), 0.6, this.theme.name !== 'day');
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(from, mid, to), 64, s * 0.0018, 6), mat);
        tube.renderOrder = 7;
        this.arcs.add(tube);
      }
    }
    for (const l of links) if ((l.kind === 'api' || l.kind === 'message') && l.via) this.viaArcs(l.via, l.kind, i);
  }

  // ------------------------------------------------------------------ hacker mode

  /** (Re)build hacker-mode atmosphere: tracers, particles, hotspot beacons. */
  private buildFx() {
    this.hackerFx.clear();
    this.hackerFx.group.visible = !!this.theme.hacker;
    if (!this.theme.hacker || !this.city) return;
    let tallest = 0;
    for (let i = 0; i < this.target.length; i++) tallest = Math.max(tallest, this.baseY[i] + this.target[i]);
    const hot = this.city.churn ? this.topHotspots(5).map(h => this.buildingAnchor(h.index, 0)) : [];
    this.hackerFx.build(this.city.bounds, tallest, hot);
  }

  /** Words for the glyph atlas: the repo's own file and directory names. */
  private glyphWords(): string[] {
    const set = new Set<string>();
    for (const b of this.city.buildings) {
      set.add(b.name.replace(/\.[^.]+$/, '').toUpperCase());
      if (set.size > 400) break;
    }
    for (const d of this.city.districts) if (d.name) set.add(d.name.toUpperCase() + '/');
    return [...set].filter(w => w.length > 1 && w.length < 28);
  }

  /** In hacker mode the selected building wears its own source code. */
  setSkin(i: number, content: string) {
    if (this.skin) {
      this.scene.remove(this.skin.mesh);
      const maps = new Set<THREE.Texture>();
      for (const o of this.skin.mesh.children) {
        const m = o as THREE.Mesh;
        m.geometry.dispose();
        for (const mat of m.material as THREE.MeshBasicMaterial[]) { if (mat.map) maps.add(mat.map); mat.dispose(); }
      }
      maps.forEach(t => t.dispose());
      this.skin = null;
    }
    if (i < 0 || !content) return;
    const b = this.city.buildings[i];
    const lines = content.split('\n').filter(l => l.trim());
    const h = Math.max(this.target[i], MIN_H);
    const tex = codeTexture(lines, h / Math.max(b.w, b.d));
    const group = new THREE.Group();
    // one sleeve per tier; the code runs on from tier to tier (texture v = height fraction)
    for (const t of this.specOf(i).tiers) {
      const map = tex.clone();
      map.repeat.set(1, t.y1 - t.y0);
      map.offset.set(0, t.y0);
      map.needsUpdate = true;
      const side = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(0.14, 0.55, 0.75), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const none = new THREE.MeshBasicMaterial({ visible: false });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [side, side, none, none, side, side]);
      mesh.renderOrder = 4;
      group.add(mesh);
    }
    tex.dispose();
    group.visible = !!this.theme.hacker;
    this.scene.add(group);
    this.skin = { building: i, mesh: group, content };
    this.updateSkin();
  }

  private updateSkin() {
    const k = this.skin;
    if (!k) return;
    const i = k.building;
    const b = this.city.buildings[i];
    const h = this.cur[i];
    k.mesh.visible = !!this.theme.hacker && h > 0.05 && this.exploded?.building !== i;
    const tiers = this.specOf(i).tiers;
    k.mesh.children.forEach((o, n) => {
      const t = tiers[n];
      if (!t) { o.visible = false; return; }
      o.position.set(b.x + b.w / 2, this.baseY[i] + h * (t.y0 + t.y1) / 2, b.z + b.d / 2);
      o.scale.set(b.w * t.s * 1.004 + 0.002, h * (t.y1 - t.y0) * 1.002, b.d * t.s * 1.004 + 0.002);
    });
  }

  // ------------------------------------------------------------------ exploded view (pieces as floors)

  get explodedBuilding() { return this.exploded?.building ?? -1; }
  /** The building that is exploded or exploding (not collapsing). */
  get explodingBuilding() { return this.exploded && this.exploded.dir > 0 ? this.exploded.building : -1; }

  /** Split building i into stacked floors, one per piece, separated by gaps. */
  explode(i: number, floors: Floor[], frame = true) {
    this.collapse(true);
    if (!floors.length) return;
    const b = this.city.buildings[i];
    const total = floors.reduce((a, f) => a + Math.max(1, f.loc), 0);
    const H = Math.max(this.target[i], this.size() * 0.04, floors.length * 0.6);
    const heights = floors.map(f => Math.max(H * 0.012, (Math.max(1, f.loc) / total) * H));
    let maxDensity = 0;
    for (const f of floors) maxDensity = Math.max(maxDensity, f.complexity / Math.max(1, f.loc));
    const colors = floors.map(f => {
      if (f.kind === 'imports' || f.kind === 'scope') return new THREE.Color(this.theme.night ? '#4a5470' : '#9aa4b6');
      return heat(maxDensity > 0 ? (f.complexity / Math.max(1, f.loc)) / maxDensity : 0).multiplyScalar(this.theme.buildingTint);
    });
    const { material, uniforms } = buildingMaterial();
    uniforms.uCell.value = this.uniforms!.uCell.value;
    uniforms.uGlyphScale.value = this.uniforms!.uGlyphScale.value * 0.6;
    uniforms.uNight.value = this.theme.night;
    uniforms.uHacker.value = this.theme.hacker;
    uniforms.uGlyphs.value = this.glyphTex ?? null;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(floors.length), 1));
    // the floors keep the building's facade (language) and condition
    const fac = new Float32Array(floors.length * 4), sp = this.specOf(i), cd = this.conditionOf(i), seed = pathSeed(b.path);
    for (let k = 0; k < floors.length; k++) fac.set([facadeCode(sp, { ...sp.tiers[sp.tiers.length - 1], facade: sp.facade }), cd?.irregular ?? 0, cd?.age ?? 0, seed], k * 4);
    geo.setAttribute('aFacade', new THREE.InstancedBufferAttribute(fac, 4));
    const mesh = new THREE.InstancedMesh(geo, material, floors.length);
    mesh.castShadow = true;
    colors.forEach((c, k) => mesh.setColorAt(k, c));
    const labels = new THREE.Group();
    this.scene.add(mesh, labels);
    this.exploded = { building: i, floors, mesh, labels, heights, colors, uniforms, t: 0, dir: 1, highlight: -1 };
    this.makeFloorLabels();
    this.layoutFloors();
    this.moving = true; // hides the original instance on the next step
    if (!frame) return; // walk mode drives the camera itself
    // frame the exploded tower
    const gapTotal = this.floorGap() * (floors.length - 1);
    const mid = new THREE.Vector3(b.x + b.w / 2, this.baseY[i] + (H + gapTotal) / 2, b.z + b.d / 2);
    const dist = Math.max((H + gapTotal) * 1.25, Math.max(b.w, b.d) * 4);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.min(Math.max(dir.y, 0.15), 0.45);
    dir.normalize();
    this.flyTo(mid.clone().addScaledVector(dir, dist), mid, 900);
  }

  /** Put the floors back (animated) or remove them immediately. */
  collapse(immediate = false) {
    const e = this.exploded;
    if (!e) return;
    if (!immediate) { e.dir = -1; return; }
    this.scene.remove(e.mesh, e.labels);
    e.mesh.geometry.dispose();
    (e.mesh.material as THREE.Material).dispose();
    e.mesh.dispose();
    for (const o of e.labels.children) { const sp = o as THREE.Sprite; sp.material.map?.dispose(); sp.material.dispose(); }
    this.exploded = null;
    this.moving = true; // shows the original instance again
    this.step(0);
  }

  highlightFloor(k: number) {
    const e = this.exploded;
    if (!e) return;
    e.highlight = k;
    const glow = e.mesh.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
    e.colors.forEach((c, j) => {
      e.mesh.setColorAt(j, j === k ? c.clone().lerp(new THREE.Color(0xffffff), 0.45) : c);
      glow.setX(j, j === k ? 0.25 + 0.4 * this.theme.night : 0);
    });
    e.mesh.instanceColor!.needsUpdate = true;
    glow.needsUpdate = true;
    e.labels.children.forEach((o, j) => { (o as THREE.Sprite).material.opacity = k < 0 || j === k ? 1 : 0.45; });
  }

  floorAt(k: number): Floor | undefined { return this.exploded?.floors[k]; }

  private floorGap() {
    const b = this.city.buildings[this.exploded!.building];
    return Math.max(0.25, Math.min(b.w, b.d) * 0.18);
  }

  private animateExplode(dt: number) {
    const e = this.exploded!;
    const before = e.t;
    e.t = Math.min(1, Math.max(0, e.t + e.dir * dt * 2.2));
    if (e.t !== before) this.layoutFloors();
    if (e.dir < 0 && e.t <= 0) this.collapse(true);
  }

  private layoutFloors() {
    const e = this.exploded!;
    const i = e.building;
    const b = this.city.buildings[i];
    const ease = easeInOut(e.t);
    const gap = this.floorGap() * ease;
    let y = this.baseY[i];
    e.floors.forEach((_, k) => {
      const h = e.heights[k];
      const inset = 1 - 0.08 * ease * (k % 2); // alternate floors slightly so the slices read as separate
      this.tmp.position.set(b.x + b.w / 2, y + h / 2, b.z + b.d / 2);
      this.tmp.scale.set(b.w * inset, h, b.d * inset);
      this.tmp.updateMatrix();
      e.mesh.setMatrixAt(k, this.tmp.matrix);
      const label = e.labels.children[k] as THREE.Sprite | undefined;
      if (label) {
        label.position.set(b.x + b.w + label.scale.x * 0.55 + 0.2, y + h / 2, b.z + b.d / 2);
        label.visible = ease > 0.6;
      }
      y += h + gap;
    });
    // the roof rides on top of the stack
    const sp = this.specOf(i), last = sp.tiers[sp.tiers.length - 1];
    this.roofs.place(i, { cx: b.x + b.w / 2, cz: b.z + b.d / 2, top: y - gap, tw: b.w * last.s, td: b.d * last.s, th: e.heights[e.heights.length - 1] ?? 1, hide: false });
    this.roofs.flush();
    e.mesh.instanceMatrix.needsUpdate = true;
    e.mesh.computeBoundingSphere();
    e.mesh.computeBoundingBox();
  }

  private makeFloorLabels() {
    const e = this.exploded!;
    const b = this.city.buildings[e.building];
    const H = e.heights.reduce((a, h) => a + h, 0);
    const size = Math.max(0.3, this.size() * 0.007, Math.min(Math.min(b.w, b.d) * 0.35, (H / Math.max(8, e.floors.length)) * 1.6, this.size() * 0.015));
    e.floors.forEach((f, k) => {
      if (k >= 80) return;
      const text = (f.name.length > 40 ? f.name.slice(0, 39) + '…' : f.name) + `  ${f.loc}`;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      const font = '500 34px "JetBrains Mono", ui-monospace, monospace';
      ctx.font = font;
      const tw = Math.ceil(ctx.measureText(text).width) + 28;
      cv.width = tw; cv.height = 52;
      ctx.font = font;
      ctx.fillStyle = this.theme.labelBg;
      ctx.beginPath(); ctx.roundRect(1, 1, tw - 2, 50, 10); ctx.fill();
      ctx.fillStyle = '#' + e.colors[k].clone().lerp(new THREE.Color(this.theme.labelFg), 0.55).getHexString();
      ctx.fillRect(8, 14, 5, 24);
      ctx.fillStyle = this.theme.labelFg;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 20, 27);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false }));
      sp.scale.set((size * tw) / 52, size, 1);
      sp.renderOrder = 11;
      sp.visible = false;
      e.labels.add(sp);
    });
  }

  // ------------------------------------------------------------------ decorations

  private makeOutlines() {
    if (this.outlines) { this.scene.remove(this.outlines); this.outlines.geometry.dispose(); (this.outlines.material as THREE.Material).dispose(); }
    const pts: number[] = [];
    for (const d of this.city.districts) {
      if (d.parent < 0) continue;
      const y = this.districtTop(d.depth) + 0.004;
      const x0 = d.x, z0 = d.z, x1 = d.x + d.w, z1 = d.z + d.d;
      pts.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.outlines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
    this.scene.add(this.outlines);
  }

  /** Labels fade out as the camera gets close, so they don't cover what you are inspecting. */
  private fadeLabels() {
    if (!this.city || !this.labels.children.length) return;
    const s = this.size();
    for (const o of this.labels.children) {
      const sp = o as THREE.Sprite;
      const d = sp.position.distanceTo(this.camera.position);
      if (sp.userData.repo) { sp.visible = true; continue; }
      sp.material.opacity = Math.min(1, Math.max(0, (d - s * 0.3) / (s * 0.3)));
      sp.visible = sp.material.opacity > 0.02;
    }
  }

  private disposeLabels() {
    for (const c of [...this.labels.children]) {
      const s = c as THREE.Sprite;
      s.material.map?.dispose();
      s.material.dispose();
      this.labels.remove(s);
    }
  }

  private makeLabels() {
    this.disposeLabels();
    const { districts, bounds } = this.city;
    const multi = !!this.city.repos?.length;
    if (multi) {
      for (const r of this.city.repos!) {
        const d = districts[r.district];
        const h = Math.max(1.2, Math.min(d.w, d.d) * 0.07, this.size() * 0.02);
        const sp = this.textSprite(this.theme.hacker ? r.name.toUpperCase() : r.name, h);
        sp.position.set(d.x + d.w / 2, h * 0.7, d.z + d.d + h * 1.2); // on the ground just in front of the city
        sp.userData.repo = true;
        this.labels.add(sp);
      }
    }
    const cand = districts
      .filter(d => d.depth >= 1 && d.depth <= (multi ? 1 : 2) && d.w * d.d > bounds.w * bounds.d * (multi ? 0.0015 : 0.004))
      .sort((a, b) => b.w * b.d - a.w * a.d)
      .slice(0, 40);
    for (const d of cand) {
      let text = d.name.length > 28 ? '…' + d.name.slice(-27) : d.name;
      if (this.theme.hacker) text = text.toUpperCase() + '/';
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      const font = this.theme.hacker ? '600 38px "JetBrains Mono", ui-monospace, monospace' : '600 40px Inter, system-ui, sans-serif';
      ctx.font = font;
      const tw = Math.ceil(ctx.measureText(text).width) + 40;
      cv.width = tw; cv.height = 68;
      ctx.font = font;
      ctx.fillStyle = this.theme.labelBg;
      ctx.beginPath();
      ctx.roundRect(2, 2, tw - 4, 64, 32);
      ctx.fill();
      ctx.fillStyle = this.theme.labelFg;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 20, 36);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false }));
      const height = Math.min(d.d * 0.22, bounds.w * 0.02);
      sp.scale.set((height * tw) / 68, height, 1);
      sp.position.set(d.x + d.w / 2, this.districtTop(d.depth) + height * 0.6, d.z + d.d / 2);
      sp.renderOrder = 10;
      this.labels.add(sp);
    }
  }
}
