import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { depthColor, districtColor, heat, languageColor } from './colors';
import type { City, ColorMode, Metric, ScaleMode } from './types';

const DISTRICT_STEP = 0.12; // vertical rise per directory depth
const MIN_H = 0.35;
const ABSENT = -1;

/** Docs, data and config files are ranked by churn only; hotspots are about code. */
const NON_CODE = new Set(['Markdown', 'JSON', 'YAML', 'TOML', 'Text', 'Config', 'XML', 'Other', 'HTML', 'CSS']);

export interface Totals { files: number; loc: number }
export interface Churn { commits: number; lines: number; allCommits: number; allLines: number }
export interface Hotspot { index: number; score: number; commits: number; loc: number }

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private city!: City;
  private C = 1; // commits
  private vals!: Record<Metric, Int32Array>; // [building * C + commit]; loc is -1 when absent
  private cumCommits!: Int32Array; // cumulative churn up to and including each commit
  private cumLines!: Int32Array;
  private buildingMesh?: THREE.InstancedMesh;
  private districtMesh?: THREE.InstancedMesh;
  private labels = new THREE.Group();
  private baseY: number[] = [];
  private cur = new Float32Array(0); // displayed height
  private target = new Float32Array(0);
  private moving = false;
  private baseColors: THREE.Color[] = [];
  private change: Uint8Array = new Uint8Array(0); // 0 none, 1 added, 2 changed (vs previous commit)
  private dimmed: boolean[] = [];
  private hovered = -1;
  private selected = -1;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Object3D();
  private last = performance.now();

  commit = 0;
  showChanges = true;
  metric: Metric = 'loc';
  scale: ScaleMode = 'sqrt';
  mult = 1;
  colorMode: ColorMode = 'language';
  churnWindow = 0; // in samples; 0 = everything so far

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0b0f1a);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2036, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-1, 2, 1.2);
    this.scene.add(sun);
    this.scene.add(this.labels);

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      if (this.moving) this.step(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get commitCount() { return this.C; }

  load(city: City) {
    this.city = city;
    this.C = city.commits.length;
    this.commit = this.C - 1;
    this.hovered = this.selected = -1;
    for (const m of [this.buildingMesh, this.districtMesh]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    }
    this.disposeLabels();
    this.expand();

    const { w, d } = city.bounds;
    this.scene.fog = new THREE.Fog(0x0b0f1a, Math.max(w, d) * 1.5, Math.max(w, d) * 6);

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    this.districtMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, city.districts.length);
    city.districts.forEach((dist, i) => {
      const top = this.districtTop(dist.depth);
      this.tmp.position.set(dist.x + dist.w / 2, top / 2, dist.z + dist.d / 2);
      this.tmp.scale.set(dist.w, top, dist.d);
      this.tmp.updateMatrix();
      this.districtMesh!.setMatrixAt(i, this.tmp.matrix);
      this.districtMesh!.setColorAt(i, districtColor(dist.depth));
    });
    this.scene.add(this.districtMesh);

    const n = city.buildings.length;
    this.buildingMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 }),
      n,
    );
    this.baseY = city.buildings.map(b => this.districtTop(city.districts[b.district].depth));
    this.dimmed = city.buildings.map(() => false);
    this.cur = new Float32Array(n);
    this.target = new Float32Array(n);
    this.scene.add(this.buildingMesh);
    this.refresh(true);
    this.makeLabels();
    this.frame();
  }

  /** Turn each building's change points into dense per-commit arrays. */
  private expand() {
    const n = this.city.buildings.length, C = this.C;
    const mk = (fill: number) => new Int32Array(n * C).fill(fill);
    this.vals = { loc: mk(ABSENT), lines: mk(0), bytes: mk(0) };
    this.city.buildings.forEach((b, i) => {
      for (let k = 0; k < b.h.length; k++) {
        const [c0, loc, lines, bytes] = b.h[k];
        const c1 = k + 1 < b.h.length ? b.h[k + 1][0] : C;
        for (let c = c0; c < c1; c++) {
          this.vals.loc[i * C + c] = loc;
          this.vals.lines[i * C + c] = lines;
          this.vals.bytes[i * C + c] = bytes;
        }
      }
    });
    this.cumCommits = new Int32Array(n * C);
    this.cumLines = new Int32Array(n * C);
    this.city.buildings.forEach((b, i) => {
      const dc = new Int32Array(C), dl = new Int32Array(C);
      for (const [c, commits, lines] of b.ch ?? []) { dc[c] += commits; dl[c] += lines; }
      let ac = 0, al = 0;
      for (let c = 0; c < C; c++) {
        ac += dc[c]; al += dl[c];
        this.cumCommits[i * C + c] = ac;
        this.cumLines[i * C + c] = al;
      }
    });
  }

  /** Changes to building i within the churn window ending at the current commit, and all-time so far. */
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

  /** Files with the highest churn × size at the current commit and window. */
  topHotspots(n: number): Hotspot[] {
    const out: Hotspot[] = [];
    for (let i = 0; i < this.city.buildings.length; i++) {
      if (!this.exists(i) || NON_CODE.has(this.city.buildings[i].lang)) continue;
      const commits = this.churnAt(i).commits;
      if (commits <= 0) continue;
      const loc = this.vals.loc[i * this.C + this.commit];
      out.push({ index: i, score: commits * loc, commits, loc });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Move the orbit target to a building, keeping the viewing offset. */
  focus(i: number) {
    const b = this.city.buildings[i];
    const t = new THREE.Vector3(b.x + b.w / 2, this.baseY[i], b.z + b.d / 2);
    const off = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(off);
  }

  private districtTop(depth: number) { return DISTRICT_STEP * (depth + 1); }

  private exists(i: number, c = this.commit) { return this.vals.loc[i * this.C + c] >= 0; }
  private value(i: number, c = this.commit) { return Math.max(0, this.vals[this.metric][i * this.C + c]); }

  private shape(v: number): number {
    if (this.scale === 'linear') return v;
    if (this.scale === 'sqrt') return Math.sqrt(v);
    return Math.log1p(v);
  }

  /** Totals of files present and LOC at a commit. */
  totals(c = this.commit): Totals {
    let files = 0, loc = 0;
    const L = this.vals.loc;
    for (let i = 0; i < this.city.buildings.length; i++) {
      const v = L[i * this.C + c];
      if (v >= 0) { files++; loc += v; }
    }
    return { files, loc };
  }

  /** LOC of a building across all commits (absent → 0), for sparklines. */
  series(i: number): number[] {
    return Array.from({ length: this.C }, (_, c) => Math.max(0, this.vals.loc[i * this.C + c]));
  }

  valuesAt(i: number) {
    const o = i * this.C + this.commit;
    return { exists: this.vals.loc[o] >= 0, loc: this.vals.loc[o], lines: this.vals.lines[o], bytes: this.vals.bytes[o] };
  }

  setCommit(c: number) {
    c = Math.max(0, Math.min(this.C - 1, c));
    if (c === this.commit) return;
    this.commit = c;
    if (this.hovered >= 0 && !this.exists(this.hovered)) this.hovered = -1;
    if (this.selected >= 0 && !this.exists(this.selected)) this.selected = -1;
    this.refresh(false);
  }

  /** Recompute targets, colors and change tints for the current commit/metric/scale. */
  refresh(instant: boolean) {
    if (!this.buildingMesh) return;
    const n = this.city.buildings.length;
    // normalize against the tallest value over the whole history so heights are comparable across commits
    let maxShaped = 0;
    const arr = this.vals[this.metric];
    for (let k = 0; k < arr.length; k++) if (arr[k] > 0) maxShaped = Math.max(maxShaped, this.shape(arr[k]));
    const tallest = Math.max(this.city.bounds.w, this.city.bounds.d) * 0.16 * this.mult;
    for (let i = 0; i < n; i++) {
      this.target[i] = this.exists(i)
        ? Math.max(MIN_H, maxShaped > 0 ? (this.shape(this.value(i)) / maxShaped) * tallest : MIN_H)
        : 0;
    }
    if (instant) this.cur.set(this.target);
    this.moving = true;
    this.step(0);

    let maxLoc = 0;
    for (let k = 0; k < this.vals.loc.length; k++) maxLoc = Math.max(maxLoc, this.vals.loc[k]);
    const logMax = Math.log1p(maxLoc) || 1;
    const maxDepth = this.city.districts.reduce((m, x) => Math.max(m, x.depth), 0);
    let maxChurn = 0, maxScore = 0;
    const churnV: number[] = new Array(n).fill(0), scoreV: number[] = new Array(n).fill(0);
    if (this.colorMode === 'churn' || this.colorMode === 'hotspot') {
      for (let i = 0; i < n; i++) {
        if (!this.exists(i)) continue;
        churnV[i] = this.churnAt(i).commits;
        scoreV[i] = NON_CODE.has(this.city.buildings[i].lang) ? 0 : churnV[i] * this.vals.loc[i * this.C + this.commit];
        maxChurn = Math.max(maxChurn, churnV[i]);
        maxScore = Math.max(maxScore, scoreV[i]);
      }
    }
    this.baseColors = this.city.buildings.map((b, i) => {
      if (this.colorMode === 'churn') return heat(Math.log1p(churnV[i]) / (Math.log1p(maxChurn) || 1));
      if (this.colorMode === 'hotspot') return heat(Math.log1p(scoreV[i]) / (Math.log1p(maxScore) || 1));
      if (this.colorMode === 'language') return languageColor(b.lang);
      if (this.colorMode === 'size') return heat(Math.log1p(Math.max(0, this.vals.loc[i * this.C + this.commit])) / logMax);
      return depthColor(this.city.districts[b.district].depth, maxDepth);
    });
    this.change = new Uint8Array(n);
    if (this.commit > 0) {
      for (let i = 0; i < n; i++) {
        const o = i * this.C + this.commit;
        const was = this.vals.loc[o - 1], now = this.vals.loc[o];
        if (now >= 0 && was < 0) this.change[i] = 1;
        else if (now >= 0 && (now !== was || this.vals.bytes[o] !== this.vals.bytes[o - 1])) this.change[i] = 2;
      }
    }
    this.recolor();
  }

  /** Ease displayed heights toward their targets and write instance matrices. */
  private step(dt: number) {
    const mesh = this.buildingMesh!;
    const k = dt <= 0 ? 0 : 1 - Math.exp(-dt * 12);
    let any = false;
    for (let i = 0; i < this.cur.length; i++) {
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
    if (i === this.selected) return c.lerp(new THREE.Color(0xffffff), 0.65);
    if (i === this.hovered) return c.lerp(new THREE.Color(0xffffff), 0.4);
    if (this.dimmed[i]) return c.multiplyScalar(0.18);
    if (this.showChanges && this.change[i] === 1) return c.lerp(new THREE.Color(0x4dff88), 0.7);
    if (this.showChanges && this.change[i] === 2) return c.lerp(new THREE.Color(0xffc233), 0.6);
    return c;
  }

  private recolor() {
    if (!this.buildingMesh) return;
    for (let i = 0; i < this.baseColors.length; i++) this.buildingMesh.setColorAt(i, this.colorFor(i));
    if (this.buildingMesh.instanceColor) this.buildingMesh.instanceColor.needsUpdate = true;
  }

  setShowChanges(v: boolean) { this.showChanges = v; this.recolor(); }

  private paint(i: number) {
    if (i < 0 || !this.buildingMesh) return;
    this.buildingMesh.setColorAt(i, this.colorFor(i));
    this.buildingMesh.instanceColor!.needsUpdate = true;
  }

  /** Dim buildings whose path does not contain the query. Returns match count at the current commit. */
  search(q: string): number {
    q = q.trim().toLowerCase();
    let n = 0;
    this.city.buildings.forEach((b, i) => {
      const hit = !q || b.path.toLowerCase().includes(q);
      this.dimmed[i] = !hit;
      if (hit && this.exists(i)) n++;
    });
    this.recolor();
    return n;
  }

  /** Building index under the pointer (clientX/Y), or -1. */
  pick(clientX: number, clientY: number): number {
    if (!this.buildingMesh) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    for (const hit of this.raycaster.intersectObject(this.buildingMesh, false)) {
      const id = hit.instanceId ?? -1;
      if (id >= 0 && this.exists(id) && !this.dimmed[id]) return id;
    }
    return -1;
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
  }

  /** Frame the whole city from a pleasant 3/4 angle. */
  frame() {
    const { w, d } = this.city.bounds;
    const s = Math.max(w, d);
    this.controls.target.set(w / 2, 0, d / 2);
    this.camera.position.set(w / 2 - s * 0.55, s * 0.75, d / 2 + s * 0.95);
    this.camera.far = s * 12;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = 2;
    this.controls.maxDistance = s * 4;
    this.controls.update();
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
    const { districts, bounds } = this.city;
    const cand = districts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.depth >= 1 && d.depth <= 2 && d.w * d.d > bounds.w * bounds.d * 0.004)
      .sort((a, b) => b.d.w * b.d.d - a.d.w * a.d.d)
      .slice(0, 40);
    for (const { d } of cand) {
      const text = d.name.length > 28 ? '…' + d.name.slice(-27) : d.name;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      ctx.font = '600 44px system-ui, sans-serif';
      const tw = Math.ceil(ctx.measureText(text).width) + 24;
      cv.width = tw; cv.height = 72;
      ctx.font = '600 44px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(8,11,20,0.7)';
      ctx.fillRect(0, 0, tw, 72);
      ctx.fillStyle = '#eaf0ff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 12, 38);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      const height = Math.min(d.d * 0.3, bounds.w * 0.025);
      sp.scale.set((height * tw) / 72, height, 1);
      sp.position.set(d.x + d.w / 2, this.districtTop(d.depth) + height * 0.6, d.z + d.d / 2);
      sp.renderOrder = 10;
      this.labels.add(sp);
    }
  }
}
