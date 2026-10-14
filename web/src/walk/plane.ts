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
  private throttle = 0.45;              // 0-1
  private pitch  = 0;                    // plane nose pitch (radians, +up)
  private roll   = 0;                    // bank angle
  private yaw    = 0;                    // heading (radians)
  private speed  = 0;                    // m/s in city units

  // camera
  private camYaw   = 0;
  private camPitch = 0.25;
  private camDist  = 0;

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
    this.throttle = 0.45;
    this.speed = 0;
    this.vel.set(0, 0, 0);
    this.camYaw   = 0;
    this.camPitch = 0.25;
    this.camDist  = this.scene.cell * 3.5;
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
    // Re-use the same geometry as Landmarks.plane() but inline here so this
    // module is self-contained. A minimal silhouette is enough: the landmark
    // plane stays visible on the ground; this clone flies.
    const u = this.scene.cell * 0.28;
    const mat = (col: number, opts: { emissive?: number; emiss?: number; rough?: number; metal?: number } = {}) =>
      new THREE.MeshStandardMaterial({
        color: col, roughness: opts.rough ?? 0.4, metalness: opts.metal ?? 0.3,
        emissive: opts.emissive ?? 0, emissiveIntensity: opts.emiss ?? 1,
      });

    const R  = u * 0.072, Lm = u * 0.62, Ln = u * 0.18, Lt = u * 0.14;
    const body  = mat(0xeef4ff, { rough: 0.3, metal: 0.45, emissive: 0x90b0d0, emiss: 0.1 });
    const engM  = mat(0x6b7a8a, { rough: 0.5, metal: 0.7 });
    const teal  = mat(0x2de2d0, { emissive: 0x2de2d0, emiss: 0.8, rough: 0.2 });

    const mk = (geo: THREE.BufferGeometry, m: THREE.Material) => { const mesh = new THREE.Mesh(geo, m); return mesh; };

    // fuselage
    const nose = mk(new THREE.CylinderGeometry(R * 0.18, R, Ln, 14), body);
    nose.rotation.z = Math.PI / 2; nose.position.x = Lm / 2 + Ln / 2;
    const barrel = mk(new THREE.CylinderGeometry(R, R, Lm, 14), body);
    barrel.rotation.z = Math.PI / 2;
    const tail = mk(new THREE.CylinderGeometry(R * 0.28, R, Lt, 14), body);
    tail.rotation.z = Math.PI / 2; tail.position.x = -(Lm / 2 + Lt / 2);
    this.planeGroup.add(nose, barrel, tail);

    // window stripe
    const stripe = mk(new THREE.BoxGeometry(Lm * 0.72, R * 0.26, 0.003), teal);
    stripe.position.set(0, R * 0.55, R * 1.01); this.planeGroup.add(stripe);
    const s2 = stripe.clone(); s2.position.z = -R * 1.01; this.planeGroup.add(s2);

    // wings
    const wSpan = u * 0.52, wRoot = u * 0.26, wTip = u * 0.10, wSweep = u * 0.18, wThick = R * 0.32;
    const wShape = new THREE.Shape();
    wShape.moveTo(0, 0); wShape.lineTo(-wRoot, 0); wShape.lineTo(-wSweep - wTip, wSpan); wShape.lineTo(-wSweep, wSpan); wShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wShape, { depth: wThick, bevelEnabled: false });
    for (const side of [1, -1]) {
      const wm = mk(wingGeo, body);
      wm.rotation.x = -Math.PI / 2; wm.scale.z = side;
      wm.position.set(u * 0.06, -R - wThick * 0.5, side < 0 ? -wThick : 0);
      this.planeGroup.add(wm);
    }

    // engines
    const engR = R * 0.52, engL = u * 0.22;
    const engX = u * 0.06 - wRoot * 0.28, engY = -R - wThick - engR * 0.7;
    for (const side of [1, -1]) {
      const engZ = side * wSpan * 0.42;
      const nac = mk(new THREE.CylinderGeometry(engR, engR, engL, 10), engM);
      nac.rotation.z = Math.PI / 2; nac.position.set(engX, engY, engZ);
      this.planeGroup.add(nac);
      const lip = mk(new THREE.TorusGeometry(engR * 0.92, engR * 0.14, 8, 14),
        new THREE.MeshStandardMaterial({ color: 0x3a4050, emissive: 0x2080ff, emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.8 }));
      lip.rotation.y = Math.PI / 2; lip.position.set(engX + engL / 2, engY, engZ);
      this.planeGroup.add(lip);
    }

    // tail fin
    const fShape = new THREE.Shape();
    const fH = u * 0.28, fRoot = u * 0.19, fTip = u * 0.10, fSwp = u * 0.12;
    fShape.moveTo(0, 0); fShape.lineTo(fRoot, 0); fShape.lineTo(fSwp + fTip, fH); fShape.lineTo(fSwp, fH); fShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(fShape, { depth: R * 0.22, bevelEnabled: false });
    const fin = mk(finGeo, body);
    fin.rotation.y = Math.PI; fin.position.set(-(Lm / 2 + Lt) + fRoot, R * 0.05, -R * 0.11);
    this.planeGroup.add(fin);

    // horizontal stabs
    const hSpan = wSpan * 0.42, hRoot = wRoot * 0.46, hTip = wTip * 0.55, hSweep = wSweep * 0.7, hThick = wThick * 0.7;
    const hShape = new THREE.Shape();
    hShape.moveTo(0, 0); hShape.lineTo(-hRoot, 0); hShape.lineTo(-hSweep - hTip, hSpan); hShape.lineTo(-hSweep, hSpan); hShape.closePath();
    const stabGeo = new THREE.ExtrudeGeometry(hShape, { depth: hThick, bevelEnabled: false });
    for (const side of [1, -1]) {
      const sm = mk(stabGeo, body);
      sm.rotation.x = -Math.PI / 2; sm.scale.z = side;
      sm.position.set(-(Lm / 2 + Lt) + hRoot * 0.9, -R * 0.1, side < 0 ? -hThick : 0);
      this.planeGroup.add(sm);
    }

    // nav lights: red left, green right, white tail strobe
    for (const [z, col] of [[-wSpan, 0xff3030], [wSpan, 0x30ff60]] as [number, number][]) {
      const nl = mk(new THREE.SphereGeometry(R * 0.18, 6, 6),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.5, roughness: 1, toneMapped: false }));
      nl.position.set(u * 0.06 - wSweep, -R - wThick - engR * 0.3, z); this.planeGroup.add(nl);
    }
    const tailLight = mk(new THREE.SphereGeometry(R * 0.15, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.5, roughness: 1, toneMapped: false }));
    tailLight.position.set(-(Lm / 2 + Lt), R * 0.2, 0); this.planeGroup.add(tailLight);
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
    controls.innerHTML = 'W/S pitch · A/D roll<br>Space throttle+ · Shift throttle-<br>E land · Q eject';

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
        this.camYaw   -= e.movementX * 0.003;
        this.camPitch  = Math.max(-0.2, Math.min(0.8, this.camPitch - e.movementY * 0.0025));
      }
    });
    on<MouseEvent>(this.scene.renderer.domElement, 'mousedown', () => { this.drag = { x: 0, y: 0 }; });
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
    const pitchRate = 1.4, rollRate = 1.8;
    if (keyDown.has('KeyW'))  this.pitch = Math.max(-0.9, this.pitch - dt * pitchRate);
    else if (keyDown.has('KeyS')) this.pitch = Math.min(0.9, this.pitch + dt * pitchRate);
    else this.pitch *= (1 - dt * 2.5); // auto-level

    if (keyDown.has('KeyA'))  this.roll = Math.max(-1.1, this.roll - dt * rollRate);
    else if (keyDown.has('KeyD')) this.roll = Math.min(1.1, this.roll + dt * rollRate);
    else this.roll *= (1 - dt * 2.2); // auto-level

    // yaw follows roll (coordinated turn)
    this.yaw -= this.roll * dt * 1.1;

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
      const R = u * 0.072, wSpan = u * 0.52, wRoot = u * 0.26, wThick = u * 0.072 * 0.32;
      const engX = u * 0.06 - wRoot * 0.28;
      const engY = -R - wThick - R * 0.52 * 0.7;
      const engL = u * 0.22;

      // engine exhaust exit positions in local space
      const engineSides: [number, 'L' | 'R'][] = [[1, 'L'], [-1, 'R']];
      for (const [side, which] of engineSides) {
        const engZ = side * wSpan * 0.42;
        const local = new THREE.Vector3(engX - engL / 2 - R * 0.1, engY, engZ);
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

    // chase camera orbits around the plane
    const camFwd = new THREE.Vector3(
      Math.sin(this.yaw + this.camYaw),
      Math.sin(this.camPitch) * 1.2,
      Math.cos(this.yaw + this.camYaw)
    ).normalize();

    const target = this.pos.clone().add(new THREE.Vector3(0, u * 0.3, 0));
    const want = target.clone().addScaledVector(camFwd, this.camDist);
    want.y = Math.max(want.y, 0.5); // never underground

    cam.position.lerp(want, Math.min(1, 0.016 * 14));
    cam.lookAt(target);

    // speed-dependent FOV
    const fovWant = 72 + (this.speed / (this.scene.cell * 14)) * 22;
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
