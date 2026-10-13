import * as THREE from 'three';

const TEAL = new THREE.Color(0x2de2d0), CORAL = new THREE.Color(0xff6b5b);

export interface GateSpot { x: number; z: number; dir: 'in' | 'out'; label: string }

/**
 * Gates on the edge of a city: an arch (two posts and a lintel) standing on the ground, teal where
 * requests, commands and events enter, coral where the code reaches out. A street leads from a gate
 * to the files behind it (see CityScene.showGateStreets).
 */
export class GateMarks {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private spots: GateSpot[] = [];
  private selected = -1;
  private labels: THREE.Sprite[] = [];
  width = 1;

  constructor() { this.group.visible = false; }

  clear() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
    this.mesh = null;
    for (const s of this.labels) { this.group.remove(s); (s.material as THREE.SpriteMaterial).map?.dispose(); s.material.dispose(); }
    this.labels = [];
    this.spots = [];
    this.selected = -1;
  }

  /** width = how wide one gate stands (world units). */
  set(spots: GateSpot[], width: number) {
    this.clear();
    this.spots = spots;
    this.width = width;
    if (!spots.length) return;
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), spots.length * 3);
    m.frustumCulled = false;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const h = width * 1.15, t = width * 0.16;
    spots.forEach((g, k) => {
      const c = g.dir === 'in' ? TEAL : CORAL;
      p.set(g.x - width / 2 + t / 2, h / 2, g.z); s.set(t, h, t); m.setMatrixAt(k * 3, mat.compose(p, q, s));
      p.set(g.x + width / 2 - t / 2, h / 2, g.z); m.setMatrixAt(k * 3 + 1, mat.compose(p, q, s));
      p.set(g.x, h - t / 2, g.z); s.set(width, t, t * 1.4); m.setMatrixAt(k * 3 + 2, mat.compose(p, q, s));
      for (let j = 0; j < 3; j++) m.setColorAt(k * 3 + j, c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.mesh = m;
    this.group.add(m);
    // a name above each gate (alternating heights so neighbours do not hide each other)
    spots.forEach((g, k) => {
      const sp = textSprite(g.label, g.dir === 'in' ? '#7ff3e8' : '#ff9a8c');
      const hgt = width * 0.62;
      sp.scale.set(hgt * (sp.userData.aspect as number), hgt, 1);
      sp.position.set(g.x, h + hgt * (0.7 + (k % 3) * 0.95), g.z);
      this.labels.push(sp);
      this.group.add(sp);
    });
  }

  get count() { return this.spots.length; }
  get meshes(): THREE.Object3D[] { return this.group.visible && this.mesh ? [this.mesh] : []; }

  /** Gate index behind a ray hit. */
  gateOf(mesh: THREE.Object3D, instance: number): number { return mesh === this.mesh ? Math.floor(instance / 3) : -1; }

  /** Make one gate brighter (selected / hovered); -1 for none. */
  highlight(k: number) {
    const m = this.mesh;
    if (!m?.instanceColor) return;
    const paint = (i: number, on: boolean) => {
      if (i < 0 || i >= this.spots.length) return;
      const c = (this.spots[i].dir === 'in' ? TEAL : CORAL).clone();
      if (on) c.lerp(new THREE.Color(1, 1, 1), 0.65);
      for (let j = 0; j < 3; j++) m.setColorAt(i * 3 + j, c);
    };
    paint(this.selected, false);
    this.selected = k;
    paint(k, true);
    m.instanceColor.needsUpdate = true;
  }
}

function textSprite(text: string, color: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  const px = 48;
  const ctx = cv.getContext('2d')!;
  ctx.font = `600 ${px}px ui-monospace, "JetBrains Mono", monospace`;
  const label = text.length > 28 ? text.slice(0, 27) + '…' : text;
  const w = Math.ceil(ctx.measureText(label).width) + 24;
  cv.width = w; cv.height = px + 20;
  ctx.font = `600 ${px}px ui-monospace, "JetBrains Mono", monospace`;
  ctx.fillStyle = 'rgba(4,8,18,0.72)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 12, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  sp.userData.aspect = cv.width / cv.height;
  return sp;
}
