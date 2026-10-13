import * as THREE from 'three';

const TEAL = new THREE.Color(0x2de2d0), CORAL = new THREE.Color(0xff6b5b);

export interface GateSpot { x: number; z: number; dir: 'in' | 'out' }

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
  width = 1;

  constructor() { this.group.visible = false; }

  clear() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
    this.mesh = null;
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
