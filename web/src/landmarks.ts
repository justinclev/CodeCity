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
        // The plane sits at u*0.066 height and offset from centre on the apron.
        this.planeSpots.push(new THREE.Vector3(cx, y + u * 0.066, cz));
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

  /**
   * An airport: a wide apron pad, a long realistic runway with full markings
   * (piano-key thresholds, touchdown zone stripes, dashed centreline, runway
   * numbers), edge-light rows, a terminal with jet bridges, control tower,
   * taxiway connector, and a plane parked on the apron ready to board.
   */
  private airport(w: number, d: number, u: number): THREE.Group {
    const g = new THREE.Group();
    const along = w >= d; // runway along the longer axis
    // Make runway much longer — real airports have 10:1 length:width ratio.
    // We expand the pad significantly beyond the building footprint.
    const RW_L = (along ? w : d) * 2.6;   // runway length (2.6× footprint)
    const RW_W = (along ? d : w) * 0.18;  // runway width (~18% of short side)

    const apronMat = this.mat(0x3e4756, { rough: 0.98 });
    const asphalt  = this.mat(0x1c2028, { rough: 1.0 });
    const white    = this.mat(0xffffff, { rough: 0.5 });
    const yellow   = this.mat(0xffc826, { rough: 0.5 });
    const glass    = this.mat(0x173042, { emissive: 0x2de2d0, emiss: 0.45 });
    const concrete = this.mat(0x8a919e, { rough: 0.9 });

    // ── base apron (wide, covers terminal area) ──
    const apronW = along ? w * 1.1 : RW_L * 1.05;
    const apronD = along ? RW_L * 1.05 : d * 1.1;
    const apron = new THREE.Mesh(this.geo(new THREE.BoxGeometry(apronW, u * 0.05, apronD)), apronMat);
    apron.position.y = u * 0.025; apron.receiveShadow = true; g.add(apron);

    // ── runway surface ──
    const rwGeo = along
      ? new THREE.BoxGeometry(RW_L, u * 0.02, RW_W)
      : new THREE.BoxGeometry(RW_W, u * 0.02, RW_L);
    const runway = new THREE.Mesh(this.geo(rwGeo), asphalt);
    runway.position.y = u * 0.06; runway.receiveShadow = true; g.add(runway);

    const RL = RW_L, RW = RW_W; // shorthand
    // helper: place a box marking on the runway surface
    const mark = (xAlong: number, xAcross: number, lenAlong: number, wAcross: number, mat: THREE.MeshStandardMaterial) => {
      const msh = new THREE.Mesh(
        this.geo(along
          ? new THREE.BoxGeometry(lenAlong, u * 0.005, wAcross)
          : new THREE.BoxGeometry(wAcross, u * 0.005, lenAlong)),
        mat);
      msh.position.set(along ? xAlong : xAcross, u * 0.075, along ? xAcross : xAlong);
      g.add(msh);
    };

    // ── centre-line dashes (every ~5% of length) ──
    const dashLen = RL * 0.028, dashGap = RL * 0.022;
    const numDashes = Math.floor(RL / (dashLen + dashGap));
    const dashStart = -RL / 2 + dashLen / 2 + dashGap;
    for (let k = 0; k < numDashes; k++) {
      const pos = dashStart + k * (dashLen + dashGap);
      mark(pos, 0, dashLen, RW * 0.025, white);
    }

    // ── piano-key threshold stripes at each end (12 stripes per end) ──
    const pianoCount = 12, pianoW = RW * 0.06, pianoLen = RL * 0.09;
    const pianoGap   = RW * 0.015;
    const totalBlock = pianoCount * pianoW + (pianoCount - 1) * pianoGap;
    for (const endSign of [-1, 1] as const) {
      const threshX = endSign * (RL / 2 - pianoLen / 2 - RL * 0.01);
      for (let p = 0; p < pianoCount; p++) {
        const across = -totalBlock / 2 + p * (pianoW + pianoGap) + pianoW / 2;
        mark(threshX, across, pianoLen, pianoW, white);
      }
      // ── aiming-point stripes: pair of bold white rectangles ──
      const aimX = endSign * (RL / 2 - pianoLen - RL * 0.12);
      mark(aimX, -RW * 0.24, RL * 0.06, RW * 0.08, white);
      mark(aimX,  RW * 0.24, RL * 0.06, RW * 0.08, white);
      // ── touchdown zone stripes (3 sets inside the threshold) ──
      for (let tz = 1; tz <= 3; tz++) {
        const tzX = endSign * (RL / 2 - pianoLen - RL * (0.18 + tz * 0.065));
        mark(tzX, -RW * 0.28, RL * 0.032, RW * 0.06, white);
        mark(tzX,  RW * 0.28, RL * 0.032, RW * 0.06, white);
      }
      // ── yellow hold-short bar at each end ──
      mark(endSign * (RL / 2 - RL * 0.005), 0, RL * 0.005, RW * 0.88, yellow);
    }

    // ── edge lights: rows of small emissive spheres along both sides ──
    const edgeLightMat = this.mat(0xfff8e0, { emissive: 0xfff8e0, emiss: 1.4 });
    const edgeLightR   = RW * 0.022;
    const lightStep    = RL / 22;
    for (let k = 0; k <= 22; k++) {
      const pos = -RL / 2 + k * lightStep;
      for (const side of [-1, 1] as const) {
        const lx = along ? pos : side * (RW / 2 + edgeLightR);
        const lz = along ? side * (RW / 2 + edgeLightR) : pos;
        const lt = new THREE.Mesh(this.geo(new THREE.SphereGeometry(edgeLightR, 5, 4)), edgeLightMat);
        lt.position.set(lx, u * 0.075 + edgeLightR, lz); g.add(lt);
      }
    }

    // ── approach light bars beyond each threshold ──
    const approachBarMat = this.mat(0xffffff, { emissive: 0xfff0c0, emiss: 1.8 });
    const approachBarLen = RL * 0.03;
    for (const endSign of [-1, 1] as const) {
      for (let ab = 1; ab <= 5; ab++) {
        const abPos = endSign * (RL / 2 + ab * RL * 0.07);
        const approachBar = new THREE.Mesh(
          this.geo(along
            ? new THREE.BoxGeometry(approachBarLen * 0.3, u * 0.008, RW * 0.5 * (1 - ab * 0.08))
            : new THREE.BoxGeometry(RW * 0.5 * (1 - ab * 0.08), u * 0.008, approachBarLen * 0.3)),
          approachBarMat);
        approachBar.position.set(along ? abPos : 0, u * 0.08, along ? 0 : abPos);
        g.add(approachBar);
      }
    }

    // ── taxiway: yellow centreline from runway to terminal apron ──
    const taxiLen  = along ? d * 0.44 : w * 0.44;
    const taxiW    = RW * 0.4;
    const taxiMat  = this.mat(0x2a2e38, { rough: 1.0 });
    const taxi = new THREE.Mesh(
      this.geo(along
        ? new THREE.BoxGeometry(taxiW, u * 0.018, taxiLen)
        : new THREE.BoxGeometry(taxiLen, u * 0.018, taxiW)),
      taxiMat);
    const txOff = along ? { x: -RL * 0.05, z: -(along ? d : w) * 0.28 } : { x: (along ? w : d) * 0.28, z: -RL * 0.05 };
    taxi.position.set(txOff.x, u * 0.062, txOff.z); g.add(taxi);
    // yellow centre stripe on taxiway
    const taxiStripe = new THREE.Mesh(
      this.geo(along
        ? new THREE.BoxGeometry(taxiW * 0.04, u * 0.006, taxiLen)
        : new THREE.BoxGeometry(taxiLen, u * 0.006, taxiW * 0.04)),
      yellow);
    taxiStripe.position.set(txOff.x, u * 0.075, txOff.z); g.add(taxiStripe);

    // ── terminal building ──
    const termSide = along ? { x: -RL * 0.08, z: -(along ? d : w) * 0.48 } : { x: -(along ? w : d) * 0.48, z: -RL * 0.08 };
    const termW = along ? RL * 0.32 : (along ? w : d) * 0.5;
    const termD = along ? (along ? d : w) * 0.5 : RL * 0.32;
    const termH = u * 0.55;
    const term  = new THREE.Mesh(this.geo(new THREE.BoxGeometry(termW, termH, termD)), glass);
    term.position.set(termSide.x, u * 0.05 + termH / 2, termSide.z);
    term.castShadow = true; g.add(term);
    // horizontal window-band stripes on terminal
    for (let fl = 1; fl <= 3; fl++) {
      const stripe = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(termW + 0.01, termH * 0.1, termD + 0.01)),
        this.mat(0x0a2040, { emissive: 0x4ad4e8, emiss: 0.4 }));
      stripe.position.set(termSide.x, u * 0.05 + (fl / 4) * termH, termSide.z);
      g.add(stripe);
    }
    // jet bridges: 3 extendable arms from terminal toward runway
    for (let jb = 0; jb < 3; jb++) {
      const jbOff = (jb - 1) * termW * 0.3;
      const jbLen = along ? (along ? d : w) * 0.12 : (along ? w : d) * 0.12;
      const jbX   = along ? termSide.x + jbOff : termSide.x + jbLen / 2;
      const jbZ   = along ? termSide.z + jbLen / 2 : termSide.z + jbOff;
      const bridge = new THREE.Mesh(
        this.geo(along ? new THREE.BoxGeometry(termW * 0.04, termH * 0.08, jbLen) : new THREE.BoxGeometry(jbLen, termH * 0.08, termD * 0.04)),
        concrete);
      bridge.position.set(jbX, u * 0.05 + termH * 0.55, jbZ); g.add(bridge);
    }
    // control tower
    const twX = termSide.x + (along ? termW * 0.42 : 0);
    const twZ = termSide.z + (along ? 0 : termD * 0.42);
    const towerH = u * 1.1;
    const towerShaft = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.065, u * 0.075, towerH, 12)), concrete);
    towerShaft.position.set(twX, u * 0.05 + towerH / 2, twZ); g.add(towerShaft);
    const cab = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(u * 0.15, u * 0.12, u * 0.18, 10)), glass);
    cab.position.set(twX, u * 0.05 + towerH + u * 0.09, twZ); g.add(cab);
    // rotating beacon atop tower
    const beacon = new THREE.Mesh(this.geo(new THREE.SphereGeometry(u * 0.045, 8, 8)),
      this.mat(0xffd24a, { emissive: 0xffd24a, emiss: 2.0 }));
    beacon.position.set(twX, u * 0.05 + towerH + u * 0.22, twZ); g.add(beacon);

    // ── plane parked on the apron near the terminal ──
    // Position it at the start of the runway, facing along runway axis,
    // placed on the apron so the player can walk up to it from ground level.
    const plane = this.plane(u);
    const planeX = along ? -RL * 0.22 : 0;
    const planeZ = along ? 0 : -RL * 0.22;
    plane.position.set(planeX, u * 0.066, planeZ);
    if (!along) plane.rotation.y = Math.PI / 2;
    g.add(plane);
    return g;
  }

  /**
   * A recognisable commercial airliner with smooth curved geometry:
   * - Fuselage: smooth elliptical LatheGeometry loft (nose bulge, tapered tail)
   * - Wings: curved airfoil profile via extruded curved Shape
   * - Engines: smooth nacelle via LatheGeometry
   * - Vertical fin: thick swept trapezoid (no more paper-thin depth)
   * - Full landing gear with torus wheels
   * - Teal window stripe and cockpit visor
   * The nose points along +X; the caller rotates as needed.
   */
  private plane(u: number): THREE.Group {
    const g = new THREE.Group();
    const body    = this.mat(0xe8f2ff, { rough: 0.28, metal: 0.48 });
    const teal    = this.mat(0x2de2d0, { emissive: 0x2de2d0, emiss: 0.75, rough: 0.22 });
    const eng     = this.mat(0x4a5768, { rough: 0.42, metal: 0.78 });
    const dark    = this.mat(0x0c1620, { rough: 0.75, metal: 0.15 });
    const engGlow = this.mat(0x0d2050, { emissive: 0x1866ff, emiss: 1.2, rough: 0.2, metal: 0.85 });
    const rubber  = this.mat(0x181818, { rough: 0.98 });

    const R  = u * 0.088;  // max fuselage radius
    const TL = u * 1.15;   // total body length

    // ── fuselage: LatheGeometry smooth loft ──
    // Profile rotates around Y; we rotate -90°Z so nose→+X.
    // Stations designed for a recognisable widebody airliner profile:
    // long blunt nose that tapers smoothly, constant barrel, elegant swept tail.
    const fusePts = [
      new THREE.Vector2(0.001, 0),            // nose tip
      new THREE.Vector2(R * 0.22, TL * 0.025),
      new THREE.Vector2(R * 0.58, TL * 0.055),
      new THREE.Vector2(R * 0.88, TL * 0.085),
      new THREE.Vector2(R * 1.00, TL * 0.13), // full width starts here
      new THREE.Vector2(R * 1.00, TL * 0.68), // constant barrel
      new THREE.Vector2(R * 0.96, TL * 0.76),
      new THREE.Vector2(R * 0.84, TL * 0.84),
      new THREE.Vector2(R * 0.62, TL * 0.91),
      new THREE.Vector2(R * 0.38, TL * 0.96),
      new THREE.Vector2(R * 0.14, TL * 1.00), // tail point
    ];
    const fuseMesh = new THREE.Mesh(this.geo(new THREE.LatheGeometry(fusePts, 20)), body);
    fuseMesh.rotation.z = -Math.PI / 2;
    // After -90°Z rotation: lathe-Y maps to world-X. Lathe goes 0..TL.
    // We want nose (+x=TL→+x=TL/2 after offset -TL/2) and tail at -TL/2.
    fuseMesh.position.x = -TL / 2;
    g.add(fuseMesh);

    // ── teal livery band (LatheGeometry ring around barrel) ──
    const liveryPts = [
      new THREE.Vector2(R * 1.004, TL * 0.15),
      new THREE.Vector2(R * 1.008, TL * 0.16),  // slight raised bead
      new THREE.Vector2(R * 1.008, TL * 0.64),
      new THREE.Vector2(R * 1.004, TL * 0.65),
    ];
    const livery = new THREE.Mesh(this.geo(new THREE.LatheGeometry(liveryPts, 20)), teal);
    livery.rotation.z = -Math.PI / 2;
    livery.position.x = -TL / 2;
    g.add(livery);

    // ── cockpit window visor: dark curved cap on nose ──
    // A half-sphere cap sitting on the top-front of the nose
    const visor = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(R * 0.58, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42)),
      dark);
    visor.rotation.z = Math.PI / 2;  // open end faces -X
    visor.position.set(TL / 2 - TL * 0.025, R * 0.32, 0);
    g.add(visor);

    // ── wings: curved airfoil cross-section using extruded curved shape ──
    const wSpan  = u * 0.70;   // half-span
    const wRoot  = u * 0.34;   // root chord
    const wTip   = u * 0.11;   // tip chord
    const wSweep = u * 0.24;   // tip sweep (LE moves aft)
    const wThick = R * 0.30;   // wing thickness at root
    // Wing half uses a curved shape for a better airfoil appearance
    const wingRootX = TL * 0.06; // measured from the fuselage centre
    const halfWingGeo = this.curvedWingShape(wRoot, wTip, wSpan, wSweep, wThick);
    for (const side of [1, -1] as const) {
      const wm = new THREE.Mesh(halfWingGeo, body);
      wm.rotation.x = -Math.PI / 2;
      wm.scale.z = side;
      wm.position.set(-wingRootX, -R * 0.52, side < 0 ? -wThick : 0);
      g.add(wm);
    }
    // winglets: angled upswept tips
    for (const side of [1, -1] as const) {
      const wlH = wSpan * 0.12;
      const wlGeo = this.geo(new THREE.BoxGeometry(wTip * 1.1, wlH, wThick * 0.5));
      const wl = new THREE.Mesh(wlGeo, body);
      // angle outward at ~15°
      wl.rotation.x = (Math.PI / 180) * (-15 * side);
      wl.position.set(-wingRootX - wSweep + wTip * 0.55, -R * 0.52 + wlH * 0.4, side * (wSpan + wThick * 0.25));
      g.add(wl);
    }

    // ── engine nacelles: smooth via LatheGeometry ──
    const nacPts = [
      new THREE.Vector2(0.001,     0),
      new THREE.Vector2(R * 0.50,  u * 0.015),
      new THREE.Vector2(R * 0.56,  u * 0.04),   // intake lip
      new THREE.Vector2(R * 0.53,  u * 0.10),
      new THREE.Vector2(R * 0.50,  u * 0.22),   // barrel
      new THREE.Vector2(R * 0.50,  u * 0.27),
      new THREE.Vector2(R * 0.44,  u * 0.30),   // nozzle taper
      new THREE.Vector2(R * 0.28,  u * 0.32),
    ];
    const engX = -wingRootX - wRoot * 0.24;
    const engY = -R * 0.52 - wThick * 0.55 - R * 0.52;
    const engL = u * 0.32;
    for (const side of [1, -1] as const) {
      const engZ = side * wSpan * 0.44;
      const nacMesh = new THREE.Mesh(this.geo(new THREE.LatheGeometry(nacPts, 14)), eng);
      nacMesh.rotation.z = -Math.PI / 2;
      nacMesh.position.set(engX - engL / 2, engY, engZ);
      g.add(nacMesh);
      // glowing intake ring
      const lip = new THREE.Mesh(
        this.geo(new THREE.TorusGeometry(R * 0.53, R * 0.09, 8, 16)), engGlow);
      lip.rotation.y = Math.PI / 2;
      lip.position.set(engX + engL * 0.01, engY, engZ);
      g.add(lip);
      // pylon
      const pylH = R * 0.45 + wThick;
      const pyl = new THREE.Mesh(this.geo(new THREE.BoxGeometry(engL * 0.55, pylH, u * 0.038)), body);
      pyl.position.set(engX - wRoot * 0.08, engY + pylH / 2, engZ);
      g.add(pyl);
    }

    // ── horizontal stabilisers (same curved shape, smaller) ──
    const hSpan  = wSpan * 0.38, hRoot = wRoot * 0.40, hTip = wTip * 0.52, hSweep = wSweep * 0.60;
    const hThick = wThick * 0.65;
    const hWingGeo = this.curvedWingShape(hRoot, hTip, hSpan, hSweep, hThick);
    const tailX = -(TL / 2 - TL * 0.06);
    for (const side of [1, -1] as const) {
      const sm = new THREE.Mesh(hWingGeo, body);
      sm.rotation.x = -Math.PI / 2; sm.scale.z = side;
      sm.position.set(tailX + hRoot * 0.78, -R * 0.04, side < 0 ? -hThick : 0);
      g.add(sm);
    }

    // ── vertical tail fin: swept, thick, prominent ──
    // Build as stacked slabs (swept trapezoid) for real visible thickness.
    const finH     = u * 0.40;
    const finRootC = u * 0.26;
    const finTipC  = u * 0.11;
    const finThick = R * 0.45;   // much thicker than before
    const finSlabs = 10;
    const finBaseX = tailX + finRootC * 0.22;
    for (let s = 0; s < finSlabs; s++) {
      const t     = (s + 0.5) / finSlabs;
      const chord = finRootC + (finTipC - finRootC) * t;
      const thick = finThick * (1 - t * 0.45);
      const sweep = finRootC * 0.4 * t;   // leading-edge sweeps back
      const slabH = finH / finSlabs;
      const slab  = new THREE.Mesh(this.geo(new THREE.BoxGeometry(chord, slabH + 0.001, thick)), body);
      slab.position.set(finBaseX - sweep, R * 0.88 + s * slabH + slabH / 2, 0);
      g.add(slab);
    }

    // ── landing gear ──
    const gearY  = -R * 0.88;    // belly attachment height
    const strutH = R * 0.72;

    // Main gear (2 bogies, 2 wheels each)
    for (const side of [1, -1] as const) {
      const gearZ = side * wSpan * 0.18;
      const strut = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(R * 0.048, R * 0.055, strutH, 6)), eng);
      strut.position.set(-wingRootX + wRoot * 0.06, gearY - strutH / 2, gearZ);
      g.add(strut);
      const axle = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(R * 0.032, R * 0.032, R * 0.65, 6)), eng);
      axle.rotation.z = Math.PI / 2;
      axle.position.set(-wingRootX + wRoot * 0.06, gearY - strutH, gearZ);
      g.add(axle);
      for (const wx of [-1, 1] as const) {
        const wheel = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.19, R * 0.075, 8, 14)), rubber);
        wheel.position.set(-wingRootX + wRoot * 0.06, gearY - strutH, gearZ + wx * R * 0.27);
        g.add(wheel);
      }
    }
    // Nose gear
    const noseGearX = TL * 0.30;
    const noseStrutH = strutH * 0.75;
    const noseStrut = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(R * 0.038, R * 0.042, noseStrutH, 6)), eng);
    noseStrut.position.set(noseGearX, gearY - noseStrutH / 2, 0);
    g.add(noseStrut);
    const noseWheel = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.15, R * 0.065, 8, 12)), rubber);
    noseWheel.position.set(noseGearX, gearY - noseStrutH, 0);
    g.add(noseWheel);

    return g;
  }

  /**
   * Wing half with a curved airfoil-like cross section extruded along the span.
   * The Shape is in XY (chord=X, thickness=Z after the extrude), and we rotate
   * -90° around X in the caller to lay the span flat along Z.
   */
  /**
   * Wing half planform (swept trapezoid) with bevelled edges for a rounded
   * airfoil look. The shape lies in the XY plane; the caller rotates -90°X to
   * lay the span along Z and mirrors with scale.z=-1 for the other side.
   * Leading edge at x=0, trailing edge at x=-chord, span along Y.
   */
  private curvedWingShape(rootChord: number, tipChord: number, span: number, sweep: number, thick: number): THREE.BufferGeometry {
    const planShape = new THREE.Shape();
    planShape.moveTo(0, 0);                         // LE root
    planShape.lineTo(-rootChord, 0);                // TE root
    planShape.lineTo(-sweep - tipChord, span);      // TE tip
    planShape.lineTo(-sweep, span);                 // LE tip
    planShape.closePath();
    // Bevel gives the wing a rounded leading/trailing edge for a real airfoil feel
    return this.geo(new THREE.ExtrudeGeometry(planShape, {
      depth: thick,
      bevelEnabled: true,
      bevelThickness: thick * 0.14,
      bevelSize: thick * 0.12,
      bevelSegments: 3,
    }));
  }

  private clear() {
    for (const c of this.group.children) (c as THREE.Group).clear?.();
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  dispose() { this.clear(); }
}
