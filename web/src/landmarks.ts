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

  /** World-space positions of all airport planes after the last build(). */
  readonly planeSpots: THREE.Vector3[] = [];

  /** Rebuild every landmark from the city's footprints and base heights. */
  build(city: City, baseY: number[]) {
    this.clear();
    this.planeSpots.length = 0;
    city.buildings.forEach((b, i) => {
      if (!b.lm) return;
      const cx = b.x + b.w / 2, cz = b.z + b.d / 2, y = baseY[i] ?? 0;
      const u = Math.min(b.w, b.d);
      let g: THREE.Group | null = null;
      if (b.lm === 'plant') g = this.powerPlant(b.w, b.d, u);
      else if (b.lm === 'port') {
        g = this.airport(b.w, b.d, u);
        // Record the plane's world-space position for walk-mode proximity.
        // The plane sits at local (0, u*0.09, 0) inside the airport group.
        this.planeSpots.push(new THREE.Vector3(cx, y + u * 0.09, cz));
      }
      if (g) { g.position.set(cx, y, cz); this.group.add(g); }
    });
  }

  setVisible(on: boolean) { this.group.visible = on; }

  /** Switch materials to hacker palette (glossy dark with neon emissives). */
  setHacker(on: boolean) {
    this.group.traverse(obj => {
      const m = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m?.isMeshStandardMaterial) return;
      if (on) {
        m.color.set(0x0a1520);
        m.roughness = 0.12; m.metalness = 0.9;
        // keep emissive-lit parts bright; dim others
        if (m.emissiveIntensity > 0) { m.emissiveIntensity = Math.min(2.5, m.emissiveIntensity * 1.6); }
      } else {
        // restore is not tracked; caller rebuilds on theme change
        m.roughness = m.userData.r ?? m.roughness;
        m.metalness = m.userData.mt ?? m.metalness;
        m.color.set(m.userData.col ?? 0xffffff);
      }
      m.needsUpdate = true;
    });
  }

  private mat(color: number, opts: { emissive?: number; emiss?: number; rough?: number; metal?: number; opacity?: number } = {}): THREE.MeshStandardMaterial {
    const r = opts.rough ?? 0.8, mt = opts.metal ?? 0.1;
    const m = new THREE.MeshStandardMaterial({
      color, roughness: r, metalness: mt,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emiss ?? 1,
      transparent: opts.opacity !== undefined, opacity: opts.opacity ?? 1,
    });
    // stash originals for hacker-mode restore
    m.userData = { col: color, r, mt };
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

  /**
   * Build a swept wing half as a flat Shape extruded to some thickness.
   * The shape lies in the XY plane (extruded along Z), so we rotate -90° around X
   * to lay it flat in the world XZ plane. Root chord starts at x=0, tip swept
   * toward +x (aft), span runs toward +y before rotation (→ +z after).
   */
  private wingShape(rootChord: number, tipChord: number, span: number, sweep: number, thick: number): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);                     // root LE
    shape.lineTo(-rootChord, 0);            // root TE (aft = -x)
    shape.lineTo(-sweep - tipChord, span);  // tip TE
    shape.lineTo(-sweep, span);             // tip LE
    shape.closePath();
    return this.geo(new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false }));
  }

  /**
   * A recognisable commercial airliner: tapered fuselage, swept-back wings
   * with engine pods under them, swept horizontal stabilisers and a vertical fin.
   * The nose points along +X; the caller rotates as needed.
   */
  private plane(u: number): THREE.Group {
    const g = new THREE.Group();
    const body  = this.mat(0xe8f2ff, { rough: 0.35, metal: 0.4, emissive: 0x8ab0cc, emiss: 0.12 });
    // dark material kept for windows
    void this.mat(0x1a2430, { rough: 0.6, metal: 0.2 }); // reserved
    const teal  = this.mat(0x2de2d0, { emissive: 0x2de2d0, emiss: 0.6, rough: 0.3 });
    const eng   = this.mat(0x6b7a8a, { rough: 0.5, metal: 0.7 });

    // ── fuselage: three cylinder sections (nose-cone, main body, tail taper) ──
    const R  = u * 0.072;  // main radius
    const Lm = u * 0.62;   // main body length
    const Ln = u * 0.18;   // nose section
    const Lt = u * 0.14;   // tail taper section

    // nose cone (front-taper: big → small)
    const noseMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(R * 0.18, R, Ln, 16)),
      body);
    noseMesh.rotation.z = Math.PI / 2;
    noseMesh.position.x = Lm / 2 + Ln / 2;
    g.add(noseMesh);

    // main barrel
    const barrel = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(R, R, Lm, 16)),
      body);
    barrel.rotation.z = Math.PI / 2;
    g.add(barrel);

    // tail taper (back-taper: big → small)
    const tailMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(R * 0.28, R, Lt, 16)),
      body);
    tailMesh.rotation.z = Math.PI / 2;
    tailMesh.position.x = -(Lm / 2 + Lt / 2);
    g.add(tailMesh);

    // ── teal window-stripe along the barrel ──
    const stripe = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(Lm * 0.72, R * 0.28, 0.004)),
      teal);
    stripe.position.set(0, R * 0.55, R * 1.01); g.add(stripe);
    const stripe2 = stripe.clone(); stripe2.position.z = -R * 1.01; g.add(stripe2);

    // ── main swept wings ──
    // built as a half-wing shape (XZ plane), then mirrored
    const wSpan    = u * 0.52;  // half-span
    const wRoot    = u * 0.26;  // root chord
    const wTip     = u * 0.10;  // tip chord
    const wSweep   = u * 0.18;  // LE sweep offset at tip (aft)
    const wThick   = R * 0.32;  // wing thickness (extruded along Z)
    const wingHalfGeo = this.wingShape(wRoot, wTip, wSpan, wSweep, wThick);
    for (const side of [1, -1]) {
      const wm = new THREE.Mesh(wingHalfGeo, body);
      // shape is in XY, extruded along Z; rotate -90° around X so span → +z, chord → x
      // then mirror along z for the other side
      wm.rotation.x = -Math.PI / 2;
      wm.scale.z = side;
      // place so root LE is at x = +0.06 (slightly forward of centre), flush with belly
      wm.position.set(u * 0.06, -R - wThick * 0.5, side < 0 ? -wThick : 0);
      g.add(wm);
    }

    // ── engine pods under each wing ──
    const engR = R * 0.52, engL = u * 0.22;
    // engines sit under the wing at ~40% span, slightly aft of LE
    const engX = u * 0.06 - wRoot * 0.28;  // align with swept LE at 40% span
    const engY = -R - wThick - engR * 0.7;  // below wing belly
    for (const side of [1, -1]) {
      const engZ = side * wSpan * 0.42;
      // nacelle
      const nac = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(engR, engR, engL, 12)), eng);
      nac.rotation.z = Math.PI / 2;
      nac.position.set(engX, engY, engZ); g.add(nac);
      // intake lip (glowing rim)
      const lip = new THREE.Mesh(this.geo(new THREE.TorusGeometry(engR * 0.92, engR * 0.14, 8, 14)),
        this.mat(0x3a4050, { emissive: 0x2080ff, emiss: 0.8, rough: 0.3, metal: 0.8 }));
      lip.rotation.y = Math.PI / 2;
      lip.position.set(engX + engL / 2 + engR * 0.05, engY, engZ); g.add(lip);
      // pylon (short strut from wing to engine)
      const pyl = new THREE.Mesh(this.geo(new THREE.BoxGeometry(u * 0.05, R * 0.55 + wThick, u * 0.04)), body);
      pyl.position.set(engX, engY + (R * 0.55 + wThick) / 2, engZ); g.add(pyl);
    }

    // ── horizontal stabilisers (smaller, more swept) ──
    const hSpan  = wSpan * 0.42, hRoot = wRoot * 0.46, hTip = wTip * 0.55, hSweep = wSweep * 0.7;
    const hThick = wThick * 0.7;
    const stabGeo = this.wingShape(hRoot, hTip, hSpan, hSweep, hThick);
    for (const side of [1, -1]) {
      const sm = new THREE.Mesh(stabGeo, body);
      sm.rotation.x = -Math.PI / 2;
      sm.scale.z = side;
      sm.position.set(-(Lm / 2 + Lt) + hRoot * 0.9, -R * 0.1, side < 0 ? -hThick : 0);
      g.add(sm);
    }

    // ── vertical tail fin (swept trapezoid, standing upright) ──
    const fShape = new THREE.Shape();
    const fH = u * 0.28, fRoot = u * 0.19, fTip = u * 0.10, fSwp = u * 0.12;
    fShape.moveTo(0, 0); fShape.lineTo(fRoot, 0);
    fShape.lineTo(fSwp + fTip, fH); fShape.lineTo(fSwp, fH); fShape.closePath();
    const finGeo = this.geo(new THREE.ExtrudeGeometry(fShape, { depth: 0.008, bevelEnabled: false }));
    const fin = new THREE.Mesh(finGeo, body);
    // fin lies in XY; shift so root aligns with tail
    fin.position.set(-(Lm / 2 + Lt) + fRoot * 0.3, R * 0.9, -0.004);
    g.add(fin);

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
