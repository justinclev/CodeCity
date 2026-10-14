import * as THREE from 'three';
import type { City } from './types';

/**
 * Recognisable landmark buildings, modelled as real geometry rather than the
 * instanced box kit: a nuclear-style power plant (cooling towers + reactor dome)
 * for the external-dependencies building, and an airport (terminal, runway and a
 * plane) for the localization building. The library keeps the columned facade.
 *
 * Each model is built once from the newest-commit footprint (shape never changes
 * between commits) and sits on the building's pad.
 */
export class Landmarks {
  readonly group = new THREE.Group();
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  /** Rebuild every landmark from the city's footprints and base heights. */
  build(city: City, baseY: number[]) {
    this.clear();
    city.buildings.forEach((b, i) => {
      if (!b.lm) return;
      const cx = b.x + b.w / 2, cz = b.z + b.d / 2, y = baseY[i] ?? 0;
      const u = Math.min(b.w, b.d);
      let g: THREE.Group | null = null;
      if (b.lm === 'plant') g = this.powerPlant(b.w, b.d, u);
      else if (b.lm === 'port') g = this.airport(b.w, b.d, u);
      if (g) { g.position.set(cx, y, cz); this.group.add(g); }
    });
  }

  setVisible(on: boolean) { this.group.visible = on; }

  private mat(color: number, opts: { emissive?: number; emiss?: number; rough?: number; metal?: number; opacity?: number } = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0.1,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emiss ?? 1,
      transparent: opts.opacity !== undefined, opacity: opts.opacity ?? 1,
    });
    this.disposables.push(m);
    return m;
  }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.disposables.push(g); return g; }

  /** A nuclear power plant: two hyperboloid cooling towers with steam, a reactor dome, on a concrete pad. */
  private powerPlant(w: number, d: number, u: number): THREE.Group {
    const g = new THREE.Group();
    const concrete = this.mat(0xb9bec6, { rough: 0.95 });
    const steel = this.mat(0x9aa6b4, { metal: 0.6, rough: 0.4 });
    // pad
    const pad = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w * 0.98, u * 0.1, d * 0.98)), concrete);
    pad.position.y = u * 0.05; pad.receiveShadow = true; g.add(pad);

    // cooling-tower silhouette (wide base, narrow waist, slight top flare)
    const prof: [number, number][] = [[0.52, 0], [0.45, 0.15], [0.38, 0.32], [0.32, 0.52], [0.30, 0.66], [0.32, 0.82], [0.37, 1]];
    const towerH = u * 1.5, towerR = u;
    const points = prof.map(([r, t]) => new THREE.Vector2(r * towerR, t * towerH));
    const towerGeo = this.geo(new THREE.LatheGeometry(points, 28));
    const offs: [number, number][] = w > d ? [[-w * 0.22, 0], [w * 0.22, 0]] : [[0, -d * 0.22], [0, d * 0.22]];
    for (const [ox, oz] of offs) {
      const tw = new THREE.Mesh(towerGeo, concrete);
      tw.position.set(ox, u * 0.1, oz); tw.castShadow = true; g.add(tw);
      // steam billowing from the top
      for (let s = 0; s < 3; s++) {
        const puff = new THREE.Mesh(this.geo(new THREE.SphereGeometry(towerR * (0.3 - s * 0.04), 10, 8)),
          this.mat(0xffffff, { emissive: 0xdfe8ff, emiss: 0.5, opacity: 0.5 - s * 0.12 }));
        puff.position.set(ox + (s - 1) * towerR * 0.12, u * 0.1 + towerH + s * towerR * 0.22, oz);
        g.add(puff);
      }
      // a warning light ring at the top
      const ring = new THREE.Mesh(this.geo(new THREE.TorusGeometry(towerR * 0.37, towerR * 0.03, 8, 20)),
        this.mat(0xff5a3c, { emissive: 0xff5a3c, emiss: 1.4 }));
      ring.rotation.x = Math.PI / 2; ring.position.set(ox, u * 0.1 + towerH, oz); g.add(ring);
    }
    // reactor containment dome
    const reactor = new THREE.Mesh(this.geo(new THREE.SphereGeometry(u * 0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2)), steel);
    reactor.position.set(w > d ? 0 : w * 0.02, u * 0.1, w > d ? d * 0.26 : 0);
    reactor.castShadow = true; g.add(reactor);
    const core = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.5, u * 0.5, u * 0.18, 20)), concrete);
    core.position.copy(reactor.position); core.position.y = u * 0.1; g.add(core);
    // a soft core glow under the dome
    const glow = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.3, u * 0.3, u * 0.06, 16)),
      this.mat(0x5fffa8, { emissive: 0x5fffa8, emiss: 1.6 }));
    glow.position.copy(core.position); glow.position.y = u * 0.2; g.add(glow);
    return g;
  }

  /** An airport: an apron, a terminal with a control tower, a runway with centre-line, and a plane. */
  private airport(w: number, d: number, u: number): THREE.Group {
    const g = new THREE.Group();
    const along = w >= d; // runway along the longer axis
    const L = (along ? w : d) * 0.94, Wd = (along ? d : w) * 0.94;
    const apron = this.mat(0x3a4250, { rough: 0.95 });
    const asphalt = this.mat(0x23262e, { rough: 1 });
    const glass = this.mat(0x173042, { emissive: 0x2de2d0, emiss: 0.5 });
    const white = this.mat(0xffffff, { rough: 0.6 });

    const slab = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w * 0.98, u * 0.06, d * 0.98)), apron);
    slab.position.y = u * 0.03; slab.receiveShadow = true; g.add(slab);

    // runway: a long dark strip down the middle
    const runway = new THREE.Mesh(this.geo(new THREE.BoxGeometry(along ? L : Wd * 0.4, u * 0.02, along ? Wd * 0.4 : L)), asphalt);
    runway.position.y = u * 0.07; g.add(runway);
    // dashed centre-line
    const dashes = 7, dashGeo = this.geo(new THREE.BoxGeometry(along ? L / (dashes * 2) : u * 0.05, u * 0.005, along ? u * 0.05 : L / (dashes * 2)));
    for (let k = 0; k < dashes; k++) {
      const dash = new THREE.Mesh(dashGeo, white);
      const t = (k / (dashes - 1) - 0.5) * L * 0.88;
      dash.position.set(along ? t : 0, u * 0.085, along ? 0 : t); g.add(dash);
    }
    // thresholds at both ends
    for (const e of [-1, 1]) {
      const bar = new THREE.Mesh(this.geo(new THREE.BoxGeometry(along ? u * 0.06 : Wd * 0.3, u * 0.006, along ? Wd * 0.3 : u * 0.06)), white);
      bar.position.set(along ? e * L * 0.46 : 0, u * 0.085, along ? 0 : e * L * 0.46); g.add(bar);
    }

    // terminal building to one side, with a glass front and a control tower
    const termW = along ? L * 0.5 : Wd * 0.34, termD = along ? Wd * 0.34 : L * 0.5, termH = u * 0.5;
    const term = new THREE.Mesh(this.geo(new THREE.BoxGeometry(termW, termH, termD)), glass);
    const side = along ? { x: -L * 0.12, z: Wd * 0.4 } : { x: Wd * 0.4, z: -L * 0.12 };
    term.position.set(side.x, u * 0.06 + termH / 2, side.z); term.castShadow = true; g.add(term);
    const towerShaft = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.07, u * 0.08, u * 0.9, 12)), white);
    towerShaft.position.set(side.x + termW * 0.3, u * 0.06 + u * 0.45, side.z); g.add(towerShaft);
    const cab = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.16, u * 0.14, u * 0.16, 12)), glass);
    cab.position.set(towerShaft.position.x, u * 0.06 + u * 0.95, side.z); g.add(cab);
    const beacon = new THREE.Mesh(this.geo(new THREE.SphereGeometry(u * 0.05, 8, 8)), this.mat(0xffd24a, { emissive: 0xffd24a, emiss: 1.6 }));
    beacon.position.set(towerShaft.position.x, u * 0.06 + u * 1.06, side.z); g.add(beacon);

    // a plane sitting on the runway
    const plane = this.plane(u);
    plane.position.set(0, u * 0.09, 0);
    if (!along) plane.rotation.y = Math.PI / 2;
    g.add(plane);
    return g;
  }

  /** A simple airliner: fuselage, swept wings, tail. Nose points +x (rotated by the caller). */
  private plane(u: number): THREE.Group {
    const g = new THREE.Group();
    const body = this.mat(0xeef2f6, { rough: 0.5, metal: 0.3 });
    const accent = this.mat(0x2de2d0, { emissive: 0x2de2d0, emiss: 0.4 });
    const fuseLen = u * 0.9, fuseR = u * 0.09;
    const fuse = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(fuseR, fuseR, fuseLen, 14)), body);
    fuse.rotation.z = Math.PI / 2; g.add(fuse);
    const nose = new THREE.Mesh(this.geo(new THREE.ConeGeometry(fuseR, u * 0.16, 14)), body);
    nose.rotation.z = -Math.PI / 2; nose.position.x = fuseLen / 2 + u * 0.07; g.add(nose);
    // main wing (one span across the fuselage)
    const fullWing = new THREE.Mesh(this.geo(new THREE.BoxGeometry(u * 0.24, u * 0.02, u * 0.9)), body);
    fullWing.position.set(-u * 0.04, 0, 0); g.add(fullWing);
    // tailplane
    const tailWing = new THREE.Mesh(this.geo(new THREE.BoxGeometry(u * 0.14, u * 0.02, u * 0.42)), body);
    tailWing.position.set(-fuseLen * 0.42, 0, 0); g.add(tailWing);
    // vertical stabiliser
    const fin = new THREE.Mesh(this.geo(new THREE.BoxGeometry(u * 0.16, u * 0.22, u * 0.02)), body);
    fin.position.set(-fuseLen * 0.42, u * 0.12, 0); g.add(fin);
    const stripe = new THREE.Mesh(this.geo(new THREE.BoxGeometry(fuseLen, u * 0.03, u * 0.005)), accent);
    stripe.position.set(0, fuseR * 0.3, fuseR * 0.96); g.add(stripe);
    const stripe2 = stripe.clone(); stripe2.position.z = -fuseR * 0.96; g.add(stripe2);
    return g;
  }

  private clear() {
    for (const c of this.group.children) (c as THREE.Group).clear?.();
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  dispose() { this.clear(); }
}
