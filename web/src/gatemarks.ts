import * as THREE from 'three';

export interface GateSpot { building: number; ins: number; outs: number }

const TEAL = 0x2de2d0, CORAL = 0xff6b5b;

/**
 * Door markers on the roofs: a teal pyramid pointing down into a building where requests, commands or
 * events enter; a coral one pointing up where the code reaches out (database, network, files, processes).
 */
export class GateMarks {
  readonly group = new THREE.Group();
  private ins: THREE.InstancedMesh | null = null;
  private outs: THREE.InstancedMesh | null = null;
  private inSpot: number[] = [];  // instance → index in spots
  private outSpot: number[] = [];
  private spots: GateSpot[] = [];
  private size = 1;

  constructor() { this.group.visible = false; }

  private make(color: number, up: boolean, n: number) {
    const geo = new THREE.ConeGeometry(0.5, 1, 4);
    geo.rotateY(Math.PI / 4);
    if (!up) geo.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    m.count = n;
    m.frustumCulled = false;
    this.group.add(m);
    return m;
  }

  clear() {
    for (const m of [this.ins, this.outs]) if (m) { this.group.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.ins = this.outs = null;
    this.inSpot = []; this.outSpot = []; this.spots = [];
  }

  set(spots: GateSpot[], cell: number, world: number) {
    this.clear();
    this.spots = spots;
    this.size = Math.max(cell * 2.2, world * 0.014); // readable from the overview, not just up close
    spots.forEach((s, k) => { if (s.ins) this.inSpot.push(k); if (s.outs) this.outSpot.push(k); });
    this.ins = this.make(TEAL, false, this.inSpot.length);
    this.outs = this.make(CORAL, true, this.outSpot.length);
  }

  get count() { return this.spots.length; }
  get meshes(): THREE.Object3D[] { return this.group.visible ? [this.ins, this.outs].filter((m): m is THREE.InstancedMesh => !!m && m.count > 0) : []; }

  /** Building behind the marker the ray hit. */
  buildingOf(mesh: THREE.Object3D, instance: number): number {
    const k = mesh === this.ins ? this.inSpot[instance] : mesh === this.outs ? this.outSpot[instance] : undefined;
    return k === undefined ? -1 : this.spots[k].building;
  }

  /** top(i) = y of the roof (or -1 when the building is absent); rect(i) = centre x, z and footprint. */
  update(time: number, top: (i: number) => number, rect: (i: number) => { x: number; z: number; w: number; d: number }) {
    if (!this.group.visible) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const place = (mesh: THREE.InstancedMesh | null, idx: number[], side: number, phase: number) => {
      if (!mesh) return;
      idx.forEach((k, n) => {
        const s = this.spots[k], y = top(s.building);
        if (y < 0) { sc.set(0, 0, 0); p.set(0, -1000, 0); } else {
          const r = rect(s.building);
          const sz = this.size;
          sc.set(sz, sz * 1.4, sz);
          p.set(r.x + r.w / 2 + side * r.w * 0.22, y + sz * 1.2 + Math.sin(time * 2 + phase + k) * sz * 0.2, r.z + r.d / 2);
        }
        m.compose(p, q, sc);
        mesh.setMatrixAt(n, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(this.ins, this.inSpot, -1, 0);
    place(this.outs, this.outSpot, 1, 2);
  }
}
