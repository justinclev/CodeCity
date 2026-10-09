import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { authorColor, depthColor, heat, languageColor } from './colors';
import { buildingMaterial, type BuildingUniforms } from './material';
import { skyTexture, THEMES, type Theme, type ThemeName } from './theme';
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

export type Pick = { kind: 'building'; index: number } | { kind: 'district'; index: number } | null;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private ground: THREE.Mesh;
  private grid?: THREE.GridHelper;
  private outlines?: THREE.LineSegments;
  theme: Theme = THEMES.night;

  private city!: City;
  private C = 1; // commits
  private vals!: Record<Metric, Int32Array>; // [building * C + commit]; loc is -1 when absent
  private lastTs!: Float64Array; // newest change time (unix s) at or before each commit; 0 = unknown
  private commitTs: number[] = [];
  private arcs = new THREE.Group();
  private cumCommits!: Int32Array; // cumulative churn up to and including each commit
  private cumLines!: Int32Array;
  private buildingMesh?: THREE.InstancedMesh;
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
    this.scene.add(this.hemi, this.sun, this.sun.target, this.labels, this.arcs);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.5, 0.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frameLoop());
  }

  private frameLoop() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.start) / this.fly.dur);
      const e = easeInOut(t);
      this.camera.position.lerpVectors(this.fly.p0, this.fly.p1, e);
      this.controls.target.lerpVectors(this.fly.t0, this.fly.t1, e);
      if (t >= 1) this.fly = null;
    }
    if (this.moving) this.step(dt);
    if (this.pulse > 0) {
      this.pulse = Math.max(0, this.pulse - dt / 1.6);
      for (const i of this.changed) this.paint(i);
    }
    this.fadeLabels();
    this.controls.update();
    if (this.bloom.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get commitCount() { return this.C; }

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
    if (this.uniforms) this.uniforms.uNight.value = t.night;
    if (this.grid) {
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
    if (this.city) { this.makeLabels(); this.refresh(false); }
  }

  private size() { return Math.max(this.city.bounds.w, this.city.bounds.d); }

  // ------------------------------------------------------------------ loading

  load(city: City) {
    this.city = city;
    this.C = city.commits.length;
    this.commit = this.C - 1;
    this.hovered = this.selected = this.selectedDistrict = -1;
    this.authorFilter = -1;
    this.baseline = 0;
    this.clearArcs();
    this.commitTs = city.commits.map(k => Date.parse(k.date) / 1000 || 0);
    for (const m of [this.buildingMesh, this.districtMesh]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
    }
    this.expand();

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
    this.districtMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.05 }), city.districts.length);
    this.districtMesh.receiveShadow = true;
    city.districts.forEach((dist, i) => {
      const top = this.districtTop(dist.depth);
      this.tmp.position.set(dist.x + dist.w / 2, top / 2, dist.z + dist.d / 2);
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

  private districtTop(depth: number) { return DISTRICT_STEP * (depth + 1); }

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
    const tallest = this.size() * 0.16 * this.mult;
    for (let i = 0; i < n; i++) {
      this.target[i] = this.exists(i)
        ? Math.max(MIN_H, maxShaped > 0 ? (this.shape(this.value(i)) / maxShaped) * tallest : MIN_H)
        : 0;
    }
    if (instant) { this.cur.set(this.target); this.delay.fill(0); }
    this.moving = true;
    this.step(0);

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
    this.recolor();
    if (this.selected >= 0 || this.arcs.children.length) this.showCoupling(this.selected);
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
      const b = this.city.buildings[i];
      const h = Math.max(c, 0.01);
      // absent buildings sink below the district surface so they neither show nor get picked
      this.tmp.position.set(b.x + b.w / 2, c > 0.02 ? this.baseY[i] + h / 2 : this.baseY[i] - 1, b.z + b.d / 2);
      this.tmp.scale.set(b.w, h, b.d);
      this.tmp.updateMatrix();
      mesh.setMatrixAt(i, this.tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.moving = any;
    if (!any) { mesh.computeBoundingSphere(); mesh.computeBoundingBox(); }
  }

  private colorFor(i: number): THREE.Color {
    const c = this.baseColors[i].clone();
    if (i === this.selected) return c.lerp(new THREE.Color(0xffffff), 0.35);
    if (i === this.hovered) return c.lerp(new THREE.Color(0xffffff), 0.25);
    if (this.dimmed[i]) return c.lerp(new THREE.Color(this.theme.dim), 0.85);
    if (this.showChanges && this.pulse > 0 && this.change[i]) {
      return c.lerp(new THREE.Color(this.change[i] === 1 ? 0x4dff88 : 0xffc233), 0.75 * this.pulse);
    }
    return c;
  }

  private glowFor(i: number): number {
    const night = this.theme.night;
    if (i === this.selected) return 0.1 + 0.15 * night;
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
    for (let i = 0; i < this.baseColors.length; i++) {
      this.buildingMesh.setColorAt(i, this.colorFor(i));
      this.glow[i] = this.glowFor(i);
    }
    if (this.buildingMesh.instanceColor) this.buildingMesh.instanceColor.needsUpdate = true;
    this.glowAttr!.needsUpdate = true;
  }

  setShowChanges(v: boolean) { this.showChanges = v; this.recolor(); }

  private paint(i: number) {
    if (i < 0 || !this.buildingMesh) return;
    this.buildingMesh.setColorAt(i, this.colorFor(i));
    this.glow[i] = this.glowFor(i);
    this.buildingMesh.instanceColor!.needsUpdate = true;
    this.glowAttr!.needsUpdate = true;
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
    const hits = this.raycaster.intersectObjects([this.buildingMesh, this.districtMesh], false);
    for (const hit of hits) {
      const id = hit.instanceId ?? -1;
      if (id < 0) continue;
      if (hit.object === this.buildingMesh) {
        if (this.exists(id) && !this.dimmed[id]) return { kind: 'building', index: id };
        continue;
      }
      return id === 0 ? null : { kind: 'district', index: id }; // the root plot is not interesting
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
      const col = new THREE.Color().setHSL(0.52 - 0.5 * t, 1, 0.55).multiplyScalar(1 + 1.5 * this.theme.night);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45 + 0.5 * t, toneMapped: false, depthWrite: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, s * (0.0008 + 0.0022 * t), 6), mat);
      tube.renderOrder = 5;
      this.arcs.add(tube);
      this.paint(j);
    }
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
    const cand = districts
      .filter(d => d.depth >= 1 && d.depth <= 2 && d.w * d.d > bounds.w * bounds.d * 0.004)
      .sort((a, b) => b.w * b.d - a.w * a.d)
      .slice(0, 40);
    for (const d of cand) {
      const text = d.name.length > 28 ? '…' + d.name.slice(-27) : d.name;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      const font = '600 40px Inter, system-ui, sans-serif';
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
