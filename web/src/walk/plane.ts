/**
 * Flyable-plane easter egg: when the player walks up to the airport's plane and
 * presses E, they take control of it. GTA-style flight controls for keyboard + mouse.
 *
 * Controls (GTA PC style):
 *   W / S         — pitch nose down / up
 *   A / D         — roll left / right (yaw follows)
 *   Space         — increase throttle
 *   Shift         — decrease throttle / air-brakes
 *   Mouse drag    — camera orbit (yaw/pitch of the chase cam, not the plane)
 *   E             — land / eject when slow and near the ground
 *   Q             — eject immediately
 *
 * Physics is simplified arcade (GTA-ish): lift is proportional to speed, drag
 * reduces speed, gravity pulls down when lift is insufficient, the plane banks
 * when rolling, and touching down at low speed transitions back to walk mode.
 */

import * as THREE from 'three';
import type { CityScene } from '../scene';

const THROTTLE_MAX = 1;
const SPEED_STALL  = 0.18;   // fraction of max; below this lift drops off sharply


export interface PlaneLanding {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Third-person plane flight controller.
 * The caller (WalkMode) creates one, calls `enter()`, then ticks `frame()` each
 * render frame, and watches `active` to know when the player has landed.
 */
export class PlaneMode {
  active = false;
  /** After landing, where the player reappears. */
  landing: PlaneLanding | null = null;

  // plane state
  private pos    = new THREE.Vector3();
  private vel    = new THREE.Vector3();   // world-space velocity
  private throttle = 0.65;              // 0-1
  private pitch  = 0;                    // plane nose pitch (radians, +up)
  private roll   = 0;                    // bank angle
  private yaw    = 0;                    // heading (radians)
  private speed  = 0;                    // m/s in city units

  // camera
  private camDist  = 0;
  // pan offset in camera-right / camera-up space (decays back to 0)
  private camPanX  = 0;
  private camPanY  = 0;

  // 3d objects
  private planeGroup = new THREE.Group();
  private trailL!: THREE.Points;
  private trailR!: THREE.Points;
  private trailGeoL!: THREE.BufferGeometry;
  private trailGeoR!: THREE.BufferGeometry;
  private trailPosL!: Float32Array;
  private trailPosR!: Float32Array;
  private trailAlphaL!: Float32Array;
  private trailAlphaR!: Float32Array;
  private readonly TRAIL_LEN = 160;
  private trailHeadL = 0;
  private trailHeadR = 0;
  private trailCountL = 0;
  private trailCountR = 0;
  private trailTimer = 0;

  private hud!: HTMLElement;
  private prompt!: HTMLElement;
  private throttleBar!: HTMLElement;
  private speedEl!: HTMLElement;
  private altEl!: HTMLElement;

  private listeners: [EventTarget, string, EventListener][] = [];
  private drag: { x: number; y: number } | null = null;
  private time = 0;
  private landTimer = 0;  // time spent near-landing conditions

  constructor(private scene: CityScene) {}

  /** Enter the plane at world position `at`, heading `startYaw` (radians). */
  enter(at: THREE.Vector3, startYaw: number) {
    this.active = true;
    this.landing = null;
    this.pos.copy(at);
    this.yaw   = startYaw;
    this.pitch = 0; this.roll = 0;
    this.throttle = 0.65;
    this.speed = 0;
    this.vel.set(0, 0, 0);
    this.camDist  = this.scene.cell * 8;
    this.camPanX  = 0;
    this.camPanY  = 0;
    this.landTimer = 0;
    this.time = 0;
    this.trailCountL = this.trailCountR = 0;
    this.trailHeadL  = this.trailHeadR  = 0;

    this.buildPlane();
    this.buildTrails();
    this.scene.cityScene.add(this.planeGroup, this.trailL, this.trailR);
    this.buildHud();
    this.bindInput();
  }

  private buildPlane() {
    // Tron Light Jet aesthetic: near-black angular hull with bright cyan/blue
    // emissive edge strips and glowing engine cores.  Every surface is dark;
    // only the trim lines and intakes emit light so the craft reads as neon
    // outlines streaking through the hacker sky.
    const u = this.scene.cell * 0.28;

    const hull  = new THREE.MeshStandardMaterial({ color: 0x050c14, roughness: 0.15, metalness: 0.95, emissive: 0x0a1828, emissiveIntensity: 0.4 });
    const glow  = new THREE.MeshStandardMaterial({ color: 0x00e8ff, emissive: 0x00e8ff, emissiveIntensity: 2.2, roughness: 0.1, metalness: 0.0, toneMapped: false });
    const glow2 = new THREE.MeshStandardMaterial({ color: 0x0055ff, emissive: 0x0055ff, emissiveIntensity: 2.8, roughness: 0.1, metalness: 0.0, toneMapped: false });
    const core  = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 4.0, roughness: 0.0, metalness: 0.0, toneMapped: false });

    const mk = (geo: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, m);
      this.planeGroup.add(mesh);
      return mesh;
    };

    // ── dims ──────────────────────────────────────────────────────────────────
    const TL   = u * 0.95;   // total length  (+x = nose, -x = tail)
    const R    = u * 0.095;  // fuselage half-height (angular, not round)
    const RW   = R * 0.60;   // fuselage half-width (flattened cross-section)
    const EDGE = R * 0.055;  // trim strip thickness

    // ── FUSELAGE: flat angular box — nose wedge + belly wedge ──────────────
    // Main body (rectangular cross-section, tapering to nose)
    const bodyGeo = new THREE.BoxGeometry(TL * 0.72, R * 1.6, RW * 2.1);
    const body = mk(bodyGeo, hull);
    body.position.x = -TL * 0.04;

    // Nose wedge: sharp angular point
    const noseGeo = new THREE.CylinderGeometry(0.002, RW * 0.85, TL * 0.28, 4);
    const nose = mk(noseGeo, hull);
    nose.rotation.z = Math.PI / 2;
    nose.rotation.y = Math.PI / 4; // 45° so the 4-sided base aligns to diamond
    nose.position.x = TL * 0.36 + TL * 0.14;

    // Tail taper
    const tailGeo = new THREE.CylinderGeometry(RW * 0.35, RW * 0.85, TL * 0.22, 4);
    const tail = mk(tailGeo, hull);
    tail.rotation.z = Math.PI / 2;
    tail.rotation.y = Math.PI / 4;
    tail.position.x = -(TL * 0.36 + TL * 0.11);

    // ── TRON EDGE STRIPS on fuselage ──────────────────────────────────────
    // Top centre spine
    const spine = mk(new THREE.BoxGeometry(TL * 0.80, EDGE, EDGE), glow);
    spine.position.set(-TL * 0.04, R * 0.82, 0);

    // Bottom spine
    const bspine = mk(new THREE.BoxGeometry(TL * 0.70, EDGE, EDGE), glow2);
    bspine.position.set(-TL * 0.04, -R * 0.82, 0);

    // Side cheatlines (both sides)
    for (const side of [1, -1] as const) {
      const cl = mk(new THREE.BoxGeometry(TL * 0.75, EDGE, EDGE), glow);
      cl.position.set(-TL * 0.04, R * 0.30, side * RW * 1.06);
    }

    // Nose rim diamond
    const noseRim = mk(new THREE.TorusGeometry(RW * 0.55, EDGE * 0.8, 4, 4), glow);
    noseRim.rotation.y = Math.PI / 4;
    noseRim.rotation.z = Math.PI / 2;
    noseRim.position.x = TL * 0.34;

    // ── WINGS: thin flat swept slabs with glowing leading edges ──────────
    const wSpan  = u * 0.72;
    const wRoot  = u * 0.38;
    const wTip   = u * 0.06;
    const wSweep = u * 0.28;
    const wThick = R * 0.20;

    const wShape = new THREE.Shape();
    wShape.moveTo(0, 0);
    wShape.lineTo(-wRoot, 0);
    wShape.lineTo(-wSweep - wTip, wSpan);
    wShape.lineTo(-wSweep, wSpan);
    wShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wShape, { depth: wThick, bevelEnabled: false });

    for (const side of [1, -1] as const) {
      const wm = mk(wingGeo, hull);
      wm.rotation.x = -Math.PI / 2;
      wm.scale.z = side;
      wm.position.set(-wRoot * 0.08, -R * 0.60, side < 0 ? -wThick : 0);

      // Glowing leading edge strip on wing top
      const leLen = Math.hypot(wSpan, wSweep) * 1.02;
      const le = mk(new THREE.BoxGeometry(leLen, EDGE, EDGE), glow);
      le.rotation.y = -Math.atan2(wSweep, wSpan) * side;
      le.position.set(-wRoot * 0.08 - wSweep * 0.5 + wTip * 0.1, -R * 0.60 + wThick * 0.52, side * wSpan * 0.5);

      // Wing tip cap glow
      const tip = mk(new THREE.BoxGeometry(wTip * 0.9, EDGE, wThick * 1.1), glow);
      tip.position.set(-wRoot * 0.08 - wSweep + wTip * 0.45, -R * 0.60 + wThick * 0.52, side * (wSpan + wThick * 0.15));
    }

    // ── TWIN ENGINES: angular nacelles with bright core rings ─────────────
    const engL  = u * 0.28;
    const engH  = R * 0.60;
    const engW  = R * 0.48;
    const engX  = -wRoot * 0.12;
    const engY  = -R * 0.42 - wThick * 0.5 - engH * 0.6;

    for (const side of [1, -1] as const) {
      const ez = side * wSpan * 0.44;

      // Angular nacelle box
      const nac = mk(new THREE.BoxGeometry(engL, engH, engW), hull);
      nac.position.set(engX, engY, ez);

      // Intake frame (front)
      for (const [ey, ez2] of [[engH * 0.5, 0], [-engH * 0.5, 0], [0, engW * 0.5], [0, -engW * 0.5]] as [number,number][]) {
        const bar = mk(new THREE.BoxGeometry(EDGE, ey === 0 ? EDGE : engH, ey === 0 ? engW : EDGE), glow2);
        bar.position.set(engX + engL * 0.5, engY + ey, ez + ez2);
      }

      // Glowing engine core (torus)
      const ring = mk(new THREE.TorusGeometry(engH * 0.38, EDGE * 1.4, 8, 16), core);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(engX + engL * 0.48, engY, ez);

      // Exhaust glow (back)
      const exhaust = mk(new THREE.BoxGeometry(EDGE, engH * 0.85, engW * 0.85), glow2);
      exhaust.position.set(engX - engL * 0.5, engY, ez);

      // Pylon
      const pylH = Math.abs(engY) - R * 0.58;
      const pyl = mk(new THREE.BoxGeometry(engL * 0.38, pylH, EDGE * 2), hull);
      pyl.position.set(engX, engY + pylH / 2, ez);
      const pylGlow = mk(new THREE.BoxGeometry(engL * 0.35, EDGE, EDGE), glow);
      pylGlow.position.set(engX, engY + pylH, ez);
    }

    // ── VERTICAL FIN: single tall angular slab ────────────────────────────
    const finH    = R * 2.8;
    const finRoot = u * 0.24;
    const finTip  = u * 0.06;
    const finSwp  = u * 0.18;
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(finRoot, 0);
    finShape.lineTo(finSwp + finTip, finH);
    finShape.lineTo(finSwp, finH);
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: EDGE * 2.5, bevelEnabled: false });
    const fin = mk(finGeo, hull);
    fin.rotation.y = Math.PI;
    fin.position.set(-(TL * 0.36) + finRoot, R * 0.82, -EDGE * 1.25);

    // Fin leading edge glow
    const finLeLen = Math.hypot(finH, finSwp) * 1.02;
    const finLe = mk(new THREE.BoxGeometry(finLeLen, EDGE, EDGE), glow);
    finLe.rotation.z = Math.atan2(finSwp, finH);
    finLe.position.set(-(TL * 0.36) + finSwp * 0.5 + finTip * 0.3, R * 0.82 + finH * 0.5, 0);

    // ── HORIZONTAL STABS ──────────────────────────────────────────────────
    const hSpan = wSpan * 0.36, hRoot = wRoot * 0.38, hTip = wTip * 0.7, hSweep = wSweep * 0.55, hThick = wThick * 0.8;
    const hShape = new THREE.Shape();
    hShape.moveTo(0, 0); hShape.lineTo(-hRoot, 0); hShape.lineTo(-hSweep - hTip, hSpan); hShape.lineTo(-hSweep, hSpan); hShape.closePath();
    const stabGeo = new THREE.ExtrudeGeometry(hShape, { depth: hThick, bevelEnabled: false });
    for (const side of [1, -1] as const) {
      const sm = mk(stabGeo, hull);
      sm.rotation.x = -Math.PI / 2; sm.scale.z = side;
      sm.position.set(-(TL * 0.36) + hRoot * 0.88, -R * 0.05, side < 0 ? -hThick : 0);
      // Stab leading edge
      const sLeLen = Math.hypot(hSpan, hSweep) * 1.02;
      const sLe = mk(new THREE.BoxGeometry(sLeLen, EDGE, EDGE), glow);
      sLe.rotation.y = -Math.atan2(hSweep, hSpan) * side;
      sLe.position.set(-(TL * 0.36) + hRoot * 0.88 - hSweep * 0.5, -R * 0.05 + hThick * 0.52, side * hSpan * 0.5);
    }

    // ── COCKPIT: dark tinted visor with subtle glow outline ───────────────
    const visor = mk(new THREE.BoxGeometry(TL * 0.18, R * 0.60, RW * 1.1), hull);
    visor.position.set(TL * 0.28, R * 0.55, 0);
    // visor rim
    mk(new THREE.BoxGeometry(TL * 0.19, EDGE, RW * 1.12), glow).position.set(TL * 0.28, R * 0.84, 0);
    mk(new THREE.BoxGeometry(TL * 0.19, EDGE, RW * 1.12), glow).position.set(TL * 0.28, R * 0.24, 0);
  }

  private buildTrails() {
    const N = this.TRAIL_LEN;
    this.trailPosL = new Float32Array(N * 3);
    this.trailAlphaL = new Float32Array(N).fill(0);
    this.trailPosR = new Float32Array(N * 3);
    this.trailAlphaR = new Float32Array(N).fill(0);

    const makePts = (pos: Float32Array, alpha: Float32Array): THREE.Points => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      // encode alpha in a custom attribute; shader uses it
      const col = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) { col[i * 4] = 1; col[i * 4 + 1] = 0.7; col[i * 4 + 2] = 0.3; col[i * 4 + 3] = 0; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setDrawRange(0, 0);
      const mat = new THREE.PointsMaterial({
        size: this.scene.cell * 0.18,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        sizeAttenuation: true,
      });
      return new THREE.Points(geo, mat);
      void alpha;
    };

    this.trailGeoL = new THREE.BufferGeometry();
    this.trailGeoR = new THREE.BufferGeometry();
    this.trailL = makePts(this.trailPosL, this.trailAlphaL);
    this.trailR = makePts(this.trailPosR, this.trailAlphaR);
    this.trailGeoL = this.trailL.geometry as THREE.BufferGeometry;
    this.trailGeoR = this.trailR.geometry as THREE.BufferGeometry;
    this.trailL.frustumCulled = false;
    this.trailR.frustumCulled = false;
  }

  private addTrailPoint(side: 'L' | 'R', worldPos: THREE.Vector3) {
    const N = this.TRAIL_LEN;
    const pos  = side === 'L' ? this.trailPosL  : this.trailPosR;
    const geo  = side === 'L' ? this.trailGeoL  : this.trailGeoR;
    let head   = side === 'L' ? this.trailHeadL  : this.trailHeadR;
    let count  = side === 'L' ? this.trailCountL : this.trailCountR;

    const i = head * 3;
    pos[i] = worldPos.x; pos[i + 1] = worldPos.y; pos[i + 2] = worldPos.z;

    // update colours: fade all existing points
    const col = geo.attributes.color as THREE.BufferAttribute;
    for (let k = 0; k < count; k++) {
      const age = (k + 1) / N;       // older = higher k offset from head
      const ci = ((head - 1 - k + N) % N) * 4;
      col.array[ci + 3] = Math.max(0, (1 - age * age) * (0.5 + this.throttle * 0.6));
    }
    // new point: full alpha
    const nc = head * 4;
    col.array[nc + 3] = 0.9;
    // colour based on throttle: orange → cyan
    const t = this.throttle;
    col.array[nc]     = 1 - t * 0.5;
    col.array[nc + 1] = 0.4 + t * 0.4;
    col.array[nc + 2] = t * 0.8;
    col.needsUpdate = true;

    head = (head + 1) % N;
    count = Math.min(count + 1, N);
    geo.attributes.position.needsUpdate = true;
    geo.setDrawRange(0, count);

    if (side === 'L') { this.trailHeadL = head; this.trailCountL = count; }
    else              { this.trailHeadR = head; this.trailCountR = count; }
  }

  private buildHud() {
    this.hud = document.createElement('div');
    this.hud.id = 'planehud';
    this.hud.style.cssText = `
      position:fixed; inset:0; pointer-events:none; z-index:200; font-family:"JetBrains Mono",monospace;
    `;

    // reticle
    const cross = document.createElement('div');
    cross.style.cssText = `
      position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
      width:14px; height:14px; border:2px solid rgba(45,226,208,0.7); border-radius:50%;
    `;
    this.hud.appendChild(cross);

    // HUD panel top-left
    const panel = document.createElement('div');
    panel.style.cssText = `
      position:absolute; top:16px; left:16px; background:rgba(0,20,30,0.7);
      border:1px solid rgba(45,226,208,0.4); border-radius:6px; padding:10px 14px;
      color:#2de2d0; font-size:12px; line-height:1.8; min-width:160px;
    `;

    this.throttleBar = document.createElement('div');
    this.speedEl = document.createElement('div');
    this.altEl = document.createElement('div');
    const controls = document.createElement('div');
    controls.style.cssText = 'color:rgba(45,226,208,0.55); font-size:10px; margin-top:6px; line-height:1.6;';
    controls.innerHTML = 'W/S pitch · A/D roll<br>Space throttle+ · Shift throttle-<br>Drag to pan view · E land · Q eject';

    panel.append(this.throttleBar, this.speedEl, this.altEl, controls);
    this.hud.appendChild(panel);

    this.prompt = document.createElement('div');
    this.prompt.style.cssText = `
      position:absolute; bottom:80px; left:50%; transform:translateX(-50%);
      background:rgba(0,0,0,0.6); color:#2de2d0; padding:6px 14px;
      border-radius:4px; font-size:13px; display:none;
    `;
    this.hud.appendChild(this.prompt);

    document.body.appendChild(this.hud);
  }

  private updateHud() {
    const throttlePct = Math.round(this.throttle * 100);
    const bar = '█'.repeat(Math.round(this.throttle * 14)) + '░'.repeat(14 - Math.round(this.throttle * 14));
    this.throttleBar.textContent = `THR ${bar} ${throttlePct}%`;
    this.speedEl.textContent = `SPD ${Math.round(this.speed * 60).toString().padStart(3, ' ')} kts`;
    this.altEl.textContent   = `ALT ${Math.round(Math.max(0, this.pos.y)).toString().padStart(4, ' ')} u`;

    const canLand = this.pos.y < this.scene.cell * 3 && this.speed < SPEED_STALL * 1.4;
    this.prompt.style.display = canLand ? 'block' : 'none';
    this.prompt.textContent = canLand ? '[E] land / eject  [Q] eject' : '';
  }

  private bindInput() {
    const on = <T extends Event>(target: EventTarget, ev: string, fn: (e: T) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(ev, fn as EventListener, opts);
      this.listeners.push([target, ev, fn as EventListener]);
    };
    on<MouseEvent>(window, 'mousemove', e => {
      if (this.drag) {
        // pan: translate the camera's look-at target in screen space
        const panScale = this.camDist * 0.0012;
        this.camPanX -= e.movementX * panScale;
        this.camPanY += e.movementY * panScale;
      }
    });
    on<MouseEvent>(this.scene.renderer.domElement, 'mousedown', e => {
      e.preventDefault();
      this.drag = { x: e.clientX, y: e.clientY };
    });
    on<MouseEvent>(window, 'mouseup', () => { this.drag = null; });
  }

  /** Called every frame by WalkMode. Returns false when the player has landed and exited. */
  frame(dt: number, keyDown: Set<string>): boolean {
    if (!this.active) return false;
    this.time += dt;

    const maxSpeed = this.scene.cell * 14; // city units / second at full throttle

    // --- throttle input ---
    if (keyDown.has('Space'))      this.throttle = Math.min(THROTTLE_MAX, this.throttle + dt * 0.7);
    else if (keyDown.has('ShiftLeft') || keyDown.has('ShiftRight'))
                                   this.throttle = Math.max(0, this.throttle - dt * 0.55);

    // --- pitch and roll ---
    const pitchRate = 2.5, rollRate = 2.8;
    if (keyDown.has('KeyW'))  this.pitch = Math.min(0.9, this.pitch + dt * pitchRate);   // W = nose up
    else if (keyDown.has('KeyS')) this.pitch = Math.max(-0.9, this.pitch - dt * pitchRate); // S = nose down
    else this.pitch *= (1 - dt * 3.0); // auto-level

    if (keyDown.has('KeyA'))  this.roll = Math.max(-1.1, this.roll - dt * rollRate);
    else if (keyDown.has('KeyD')) this.roll = Math.min(1.1, this.roll + dt * rollRate);
    else this.roll *= (1 - dt * 2.5); // auto-level

    // yaw follows roll (coordinated turn) — snappier
    this.yaw -= this.roll * dt * 2.0;

    // --- velocity update ---
    const speedFrac  = this.speed / maxSpeed;
    const liftFrac   = speedFrac < SPEED_STALL ? speedFrac / SPEED_STALL : 1;   // no lift below stall
    const lift       = liftFrac * 1.0;                                           // counteracts gravity
    const drag       = 0.08 + (1 - this.throttle) * 0.12;
    const thrust     = this.throttle * 1.4;

    // gravity
    const g = 9.8 * this.scene.cell * 0.18;

    // forward vector from yaw + pitch
    const fwdX = -Math.sin(this.yaw) * Math.cos(this.pitch);
    const fwdY =  Math.sin(this.pitch);
    const fwdZ = -Math.cos(this.yaw) * Math.cos(this.pitch);

    // accelerate along forward direction
    const accel = (thrust - drag * speedFrac) * maxSpeed;
    this.speed = Math.max(0, this.speed + accel * dt);
    this.speed = Math.min(this.speed, maxSpeed);

    this.vel.set(fwdX * this.speed, fwdY * this.speed, fwdZ * this.speed);

    // gravity counteracted by lift
    const gravEffect = g * (1 - lift * liftFrac);
    this.vel.y -= gravEffect * dt;

    this.pos.addScaledVector(this.vel, dt);

    // ground clamp
    if (this.pos.y < 0) {
      this.pos.y = 0;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    // ceiling
    const ceiling = this.scene.skyline() * 3 + this.scene.worldSize * 0.8;
    if (this.pos.y > ceiling) { this.pos.y = ceiling; this.vel.y = Math.min(0, this.vel.y); }

    // --- landing detection ---
    const grounded = this.pos.y <= 0.1;
    const slow = this.speed < maxSpeed * SPEED_STALL * 1.3;
    if (grounded && slow) {
      this.landTimer += dt;
      if (this.landTimer > 0.6 || keyDown.has('KeyE')) {
        this.land();
        return false;
      }
    } else {
      this.landTimer = 0;
    }

    // eject immediately
    if (keyDown.has('KeyQ')) {
      this.land();
      return false;
    }

    // --- update plane transform ---
    this.planeGroup.position.copy(this.pos);
    // heading yaw
    this.planeGroup.rotation.set(0, 0, 0);
    this.planeGroup.rotateY(this.yaw);
    // pitch nose up/down
    this.planeGroup.rotateZ(-this.pitch);
    // bank (roll) for visual flair
    this.planeGroup.rotateX(this.roll * 0.35);

    // scale to scene units
    const scale = this.scene.cell * 0.28;
    this.planeGroup.scale.setScalar(scale);

    // --- update trails ---
    this.trailTimer += dt;
    if (this.trailTimer > 0.016) { // ~60fps trail points
      this.trailTimer = 0;
      const u = scale;
      const R = u * 0.095, wSpan = u * 0.72, wRoot = u * 0.38, wThick = R * 0.20;
      const engH = R * 0.60, engL = u * 0.28;
      const engX = -wRoot * 0.12;
      const engY = -R * 0.42 - wThick * 0.5 - engH * 0.6;

      // engine exhaust exit positions in local space (back of nacelle)
      const engineSides: [number, 'L' | 'R'][] = [[1, 'L'], [-1, 'R']];
      for (const [side, which] of engineSides) {
        const engZ = side * wSpan * 0.44;
        const local = new THREE.Vector3(engX - engL * 0.52, engY, engZ);
        const world = local.applyMatrix4(this.planeGroup.matrixWorld);
        this.addTrailPoint(which, world);
      }
    }

    // --- camera ---
    this.updateCamera();
    this.updateHud();
    return true;
  }

  private updateCamera() {
    const cam = this.scene.camera;
    const u = this.scene.cell;

    // Forward direction the plane is flying
    const forward = new THREE.Vector3(
      Math.sin(this.yaw),
      Math.sin(this.pitch) * 0.8,
      Math.cos(this.yaw)
    ).normalize();

    // Camera sits BEHIND and above the plane
    const behind = forward.clone().negate();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();

    // Base look-at target is slightly ahead of/above the plane
    const lookTarget = this.pos.clone()
      .addScaledVector(forward, u * 0.5)
      .add(new THREE.Vector3(0, u * 0.2, 0));

    // Apply pan offset in camera-right / camera-up space
    // Decay pan slowly so it re-centres when drag stops
    this.camPanX *= 0.92;
    this.camPanY *= 0.92;
    const panTarget = lookTarget.clone()
      .addScaledVector(right, this.camPanX)
      .add(new THREE.Vector3(0, this.camPanY, 0));

    // Camera position: behind + up offset
    const want = this.pos.clone()
      .addScaledVector(behind, this.camDist)
      .add(new THREE.Vector3(0, u * 1.2, 0));
    want.y = Math.max(want.y, 0.5);

    cam.position.lerp(want, Math.min(1, 0.016 * 10));
    cam.lookAt(panTarget);

    // speed-dependent FOV
    const fovWant = 68 + (this.speed / (this.scene.cell * 14)) * 20;
    cam.fov += (fovWant - cam.fov) * 0.08;
    cam.updateProjectionMatrix();
  }

  private land() {
    this.active = false;
    this.landing = {
      x: this.pos.x,
      y: Math.max(0, this.pos.y),
      z: this.pos.z,
      yaw: this.yaw,
    };
    this.dispose();
  }

  dispose() {
    this.active = false;
    // remove 3d objects
    this.planeGroup.parent?.remove(this.planeGroup);
    this.trailL?.parent?.remove(this.trailL);
    this.trailR?.parent?.remove(this.trailR);
    // dispose geometries/materials
    this.planeGroup.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach(x => x.dispose());
      else (m.material as THREE.Material | undefined)?.dispose();
    });
    this.trailGeoL?.dispose(); this.trailGeoR?.dispose();
    ((this.trailL as THREE.Points | undefined)?.material as THREE.Material | undefined)?.dispose();
    ((this.trailR as THREE.Points | undefined)?.material as THREE.Material | undefined)?.dispose();
    // remove HUD
    this.hud?.remove();
    // remove listeners
    for (const [t, ev, fn] of this.listeners) t.removeEventListener(ev, fn);
    this.listeners = [];
    this.drag = null;
  }
}
