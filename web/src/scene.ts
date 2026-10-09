import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { depthColor, districtColor, heat, languageColor } from './colors';
import type { Building, City, ColorMode, Metric, ScaleMode } from './types';

const DISTRICT_STEP = 0.12; // vertical rise per directory depth

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private city!: City;
  private buildingMesh?: THREE.InstancedMesh;
  private districtMesh?: THREE.InstancedMesh;
  private labels = new THREE.Group();
  private heights: number[] = [];
  private baseColors: THREE.Color[] = [];
  private dimmed: boolean[] = [];
  private hovered = -1;
  private selected = -1;
  private raycaster = new THREE.Raycaster();
  private tmp = new THREE.Object3D();

  metric: Metric = 'loc';
  scale: ScaleMode = 'sqrt';
  mult = 1;
  colorMode: ColorMode = 'language';

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

  load(city: City) {
    this.city = city;
    this.hovered = this.selected = -1;
    for (const m of [this.buildingMesh, this.districtMesh]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    }
    this.disposeLabels();

    const { w, d } = city.bounds;
    this.scene.fog = new THREE.Fog(0x0b0f1a, Math.max(w, d) * 1.5, Math.max(w, d) * 6);

    // districts
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    this.districtMesh = new THREE.InstancedMesh(geo, mat, city.districts.length);
    city.districts.forEach((dist, i) => {
      const top = this.districtTop(dist.depth);
      this.tmp.position.set(dist.x + dist.w / 2, top / 2, dist.z + dist.d / 2);
      this.tmp.scale.set(dist.w, top, dist.d);
      this.tmp.updateMatrix();
      this.districtMesh!.setMatrixAt(i, this.tmp.matrix);
      this.districtMesh!.setColorAt(i, districtColor(dist.depth));
    });
    this.scene.add(this.districtMesh);

    // buildings
    this.buildingMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 }),
      city.buildings.length,
    );
    this.dimmed = city.buildings.map(() => false);
    this.scene.add(this.buildingMesh);
    this.rebuild();
    this.makeLabels();
    this.frame();
  }

  private districtTop(depth: number) { return DISTRICT_STEP * (depth + 1); }

  private value(b: Building): number {
    return this.metric === 'loc' ? b.loc : this.metric === 'lines' ? b.lines : b.bytes;
  }

  private shape(v: number): number {
    if (this.scale === 'linear') return v;
    if (this.scale === 'sqrt') return Math.sqrt(v);
    return Math.log1p(v);
  }

  /** Recompute heights and colors (after any control change). */
  rebuild() {
    if (!this.buildingMesh) return;
    const bs = this.city.buildings;
    let maxShaped = 0, maxRaw = 0;
    for (const b of bs) { maxShaped = Math.max(maxShaped, this.shape(this.value(b))); maxRaw = Math.max(maxRaw, this.value(b)); }
    const tallest = Math.max(this.city.bounds.w, this.city.bounds.d) * 0.16 * this.mult;
    const maxDepth = this.city.districts.reduce((m, x) => Math.max(m, x.depth), 0);
    const logMax = Math.log1p(maxRaw) || 1;

    this.heights = bs.map(b => Math.max(0.35, maxShaped > 0 ? (this.shape(this.value(b)) / maxShaped) * tallest : 0.35));
    this.baseColors = bs.map(b => {
      if (this.colorMode === 'language') return languageColor(b.lang);
      if (this.colorMode === 'size') return heat(Math.log1p(b.loc) / logMax);
      return depthColor(this.city.districts[b.district].depth, maxDepth);
    });
    bs.forEach((b, i) => {
      const base = this.districtTop(this.city.districts[b.district].depth);
      const h = this.heights[i];
      this.tmp.position.set(b.x + b.w / 2, base + h / 2, b.z + b.d / 2);
      this.tmp.scale.set(b.w, h, b.d);
      this.tmp.updateMatrix();
      this.buildingMesh!.setMatrixAt(i, this.tmp.matrix);
    });
    this.buildingMesh.instanceMatrix.needsUpdate = true;
    // the matrix of every instance changed; bounding volumes used by raycasting must follow
    this.buildingMesh.computeBoundingSphere();
    this.buildingMesh.computeBoundingBox();
    this.recolor();
  }

  private colorFor(i: number): THREE.Color {
    const c = this.baseColors[i].clone();
    if (i === this.selected) return c.lerp(new THREE.Color(0xffffff), 0.65);
    if (i === this.hovered) return c.lerp(new THREE.Color(0xffffff), 0.4);
    if (this.dimmed[i]) return c.multiplyScalar(0.18);
    return c;
  }

  private recolor() {
    if (!this.buildingMesh) return;
    for (let i = 0; i < this.baseColors.length; i++) this.buildingMesh.setColorAt(i, this.colorFor(i));
    if (this.buildingMesh.instanceColor) this.buildingMesh.instanceColor.needsUpdate = true;
  }

  private paint(i: number) {
    if (i < 0 || !this.buildingMesh) return;
    this.buildingMesh.setColorAt(i, this.colorFor(i));
    this.buildingMesh.instanceColor!.needsUpdate = true;
  }

  /** Dim buildings whose path does not contain the query. Returns match count. */
  search(q: string): number {
    q = q.trim().toLowerCase();
    let n = 0;
    this.city.buildings.forEach((b, i) => {
      const hit = !q || b.path.toLowerCase().includes(q);
      this.dimmed[i] = !hit;
      if (hit) n++;
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
    const hit = this.raycaster.intersectObject(this.buildingMesh, false)[0];
    const id = hit?.instanceId ?? -1;
    return id >= 0 && this.dimmed[id] ? -1 : id;
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
