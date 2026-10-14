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

  /**
   * All Mesh objects inside the landmark groups, for raycasting.
   * Populated by build(); cleared by clear().
   */
  readonly meshes: THREE.Mesh[] = [];

  /** Maps a Mesh (from meshes[]) back to its city building index. */
  private meshToBuilding = new Map<THREE.Mesh, number>();

  /** Returns the city building index for a landmark mesh hit, or -1. */
  buildingIndexOf(mesh: THREE.Mesh): number {
    return this.meshToBuilding.get(mesh) ?? -1;
  }

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
        const along = b.w >= b.d;
        const RL = (along ? b.w : b.d) * 2.6;
        g = this.airport(b.w, b.d, u);
        // The plane is offset from the group centre — match airport() placement exactly.
        const planeOffX = along ? -RL * 0.22 : 0;
        const planeOffZ = along ? 0 : -RL * 0.22;
        this.planeSpots.push(new THREE.Vector3(cx + planeOffX, y + u * 0.066, cz + planeOffZ));
      }
      if (g) {
        g.position.set(cx, y, cz);
        this.group.add(g);
        // Register all meshes inside this landmark group for picking.
        g.traverse(obj => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            this.meshes.push(m);
            this.meshToBuilding.set(m, i);
          }
        });
      }
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
    // Materials
    const white   = this.mat(0xf0f4ff, { rough: 0.25, metal: 0.55 });
    const teal    = this.mat(0x00c8b4, { emissive: 0x00c8b4, emiss: 0.6, rough: 0.2 });
    const dark    = this.mat(0x0a1520, { rough: 0.7 });
    const eng     = this.mat(0x3c4858, { rough: 0.4, metal: 0.8 });
    const engGlow = this.mat(0x0020a0, { emissive: 0x2266ff, emiss: 1.4, rough: 0.15, metal: 0.9 });
    const rubber  = this.mat(0x111111, { rough: 1.0 });
    const chrome  = this.mat(0xaabbcc, { rough: 0.1, metal: 1.0 });

    // Key dims — make R much fatter so it reads at a distance
    const R  = u * 0.13;   // fuselage radius (wider than before)
    const TL = u * 1.10;   // total length

    // ── FUSELAGE: 3-part tube (nose sphere + barrel cylinder + tail cone) ──
    // This avoids the thin-spindle problem with LatheGeometry at small screen size.
    const barrelL = TL * 0.56;
    const noseL   = TL * 0.22;
    const tailL   = TL * 0.22;

    // Barrel — fat cylinder
    const barrel = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(R, R, barrelL, 18)),
      white);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.x = 0;
    g.add(barrel);

    // Nose — elongated hemisphere (scaled sphere)
    const noseSphere = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(R, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
      white);
    noseSphere.rotation.z = -Math.PI / 2;  // flat end faces -X
    noseSphere.scale.set(noseL / R, 1, 1);  // elongate along X
    noseSphere.position.x = barrelL / 2;
    g.add(noseSphere);

    // Tail cone — narrow cylinder tapering to a point
    const tailCone = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.001, R, tailL, 18)),
      white);
    tailCone.rotation.z = Math.PI / 2;
    tailCone.position.x = -(barrelL / 2 + tailL / 2);
    g.add(tailCone);

    // ── TEAL LIVERY stripe along barrel ──
    const stripeR = R * 1.012;
    const stripe = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(stripeR, stripeR, barrelL * 0.88, 18)),
      teal);
    stripe.rotation.z = Math.PI / 2;
    g.add(stripe);

    // ── COCKPIT WINDOWS: dark band on nose top ──
    const cockpit = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(noseL * 0.55, R * 0.55, R * 1.1)),
      dark);
    cockpit.position.set(barrelL / 2 + noseL * 0.18, R * 0.55, 0);
    g.add(cockpit);

    // ── WINGS ──
    const wSpan  = u * 0.80;  // half-span (wider = more readable)
    const wRoot  = u * 0.40;  // root chord
    const wTip   = u * 0.12;  // tip chord
    const wSweep = u * 0.26;  // LE sweep
    const wThick = R * 0.38;  // good thickness

    const wingGeo = this.curvedWingShape(wRoot, wTip, wSpan, wSweep, wThick);
    for (const side of [1, -1] as const) {
      const wm = new THREE.Mesh(wingGeo, white);
      wm.rotation.x = -Math.PI / 2;
      wm.scale.z = side;
      wm.position.set(-wRoot * 0.12, -R * 0.35, side < 0 ? -wThick : 0);
      g.add(wm);
      // Teal stripe along top of wing
      const ws = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(wRoot * 0.85, wThick * 0.05, wSpan * 0.72)),
        teal);
      ws.position.set(-wRoot * 0.12 - wSweep * 0.4, -R * 0.35 + wThick * 0.52, side * wSpan * 0.38);
      g.add(ws);
      // Winglet
      const wlH = wSpan * 0.14;
      const wl = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(wTip * 0.9, wlH, wThick * 0.45)),
        white);
      wl.rotation.x = (Math.PI / 180) * (12 * side);
      wl.position.set(-wRoot * 0.12 - wSweep + wTip * 0.45, -R * 0.35 + wlH * 0.45, side * (wSpan + wThick * 0.2));
      g.add(wl);
    }

    // ── ENGINES (2, under wings) ──
    const engL  = u * 0.30;
    const engR  = R * 0.46;
    const engY  = -R * 0.38 - wThick * 0.5;
    const engXc = -wRoot * 0.20;
    for (const side of [1, -1] as const) {
      const ez = side * wSpan * 0.46;
      // Nacelle body
      const nac = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(engR * 0.9, engR, engL, 14)),
        eng);
      nac.rotation.z = Math.PI / 2;
      nac.position.set(engXc, engY, ez);
      g.add(nac);
      // Intake ring (glowing)
      const lip = new THREE.Mesh(
        this.geo(new THREE.TorusGeometry(engR, engR * 0.16, 8, 16)),
        engGlow);
      lip.rotation.y = Math.PI / 2;
      lip.position.set(engXc + engL * 0.5, engY, ez);
      g.add(lip);
      // Pylon connecting wing to engine
      const pylH = Math.abs(engY) - R * 0.35;
      const pyl = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(engL * 0.45, pylH, u * 0.032)),
        white);
      pyl.position.set(engXc, engY + pylH / 2, ez);
      g.add(pyl);
    }

    // ── HORIZONTAL STABILISERS ──
    const hSpan  = wSpan * 0.35;
    const hRoot  = wRoot * 0.38;
    const hTip   = wTip  * 0.55;
    const hSweep = wSweep * 0.55;
    const hThick = wThick * 0.55;
    const hGeo   = this.curvedWingShape(hRoot, hTip, hSpan, hSweep, hThick);
    const tailX  = -(barrelL / 2 + tailL * 0.55);
    for (const side of [1, -1] as const) {
      const hs = new THREE.Mesh(hGeo, white);
      hs.rotation.x = -Math.PI / 2;
      hs.scale.z = side;
      hs.position.set(tailX + hRoot * 0.72, 0, side < 0 ? -hThick : 0);
      g.add(hs);
    }

    // ── VERTICAL TAIL FIN ──
    // Stacked slabs: each slab is a box, swept and tapered toward the top.
    const finH     = u * 0.44;
    const finRootC = u * 0.28;
    const finTipC  = u * 0.10;
    const finThick = R * 0.52;
    const finSlabs = 8;
    const finBaseX = tailX + finRootC * 0.28;
    for (let s = 0; s < finSlabs; s++) {
      const t      = (s + 0.5) / finSlabs;
      const chord  = finRootC + (finTipC - finRootC) * t;
      const thick  = finThick * (1 - t * 0.5);
      const sweep  = finRootC * 0.38 * t;
      const slabH  = finH / finSlabs;
      const slab   = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(chord, slabH + 0.001, thick)),
        s < finSlabs * 0.7 ? teal : white);
      slab.position.set(finBaseX - sweep, R * 0.9 + s * slabH + slabH / 2, 0);
      g.add(slab);
    }

    // ── LANDING GEAR ──
    const gearY  = -(R + R * 0.04);
    const strutH = R * 0.78;
    // Main gear
    for (const side of [1, -1] as const) {
      const gz = side * wSpan * 0.22;
      const strut = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(R * 0.045, R * 0.05, strutH, 6)), chrome);
      strut.position.set(-wRoot * 0.08, gearY - strutH / 2, gz);
      g.add(strut);
      for (const wx of [-1, 1] as const) {
        const wheel = new THREE.Mesh(
          this.geo(new THREE.TorusGeometry(R * 0.20, R * 0.08, 7, 12)), rubber);
        wheel.position.set(-wRoot * 0.08, gearY - strutH, gz + wx * R * 0.28);
        g.add(wheel);
      }
    }
    // Nose gear
    const nStrut = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(R * 0.035, R * 0.04, strutH * 0.72, 6)), chrome);
    nStrut.position.set(barrelL * 0.36, gearY - strutH * 0.36, 0);
    g.add(nStrut);
    const nWheel = new THREE.Mesh(
      this.geo(new THREE.TorusGeometry(R * 0.15, R * 0.07, 7, 10)), rubber);
    nWheel.position.set(barrelL * 0.36, gearY - strutH * 0.72, 0);
    g.add(nWheel);

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
    this.meshes.length = 0;
    this.meshToBuilding.clear();
  }

  dispose() { this.clear(); }
}
