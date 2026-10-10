import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type Mood = 'idle' | 'walk' | 'run' | 'jump' | 'pop';

/**
 * The player: an original cute little android ("Bit"). Chibi proportions — big
 * rounded head with a glossy face screen (blinking, expressive eyes, tiny smile,
 * blush), little ear lights, a springy antenna, a round body with a chest light,
 * and stubby arms and legs that waddle when walking. Height is 1 unit; scale the group.
 */
export class Avatar {
  readonly group = new THREE.Group();
  private body = new THREE.Group();   // everything that bobs and rolls
  private head = new THREE.Group();
  private antennaTip: THREE.Group;
  private armL: THREE.Group; private armR: THREE.Group;
  private legL: THREE.Group; private legR: THREE.Group;
  private chest: THREE.MeshBasicMaterial;
  private faceCanvas = document.createElement('canvas');
  private faceTex: THREE.CanvasTexture;
  private faceKey = '';
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private t = 0;
  private phase = 0;
  private blink = 0;         // > 0 while the eyes are closed
  private nextBlink = 2;
  private tipVel = new THREE.Vector2();
  private tipOff = new THREE.Vector2();
  private lastPos = new THREE.Vector3();
  private pop = 1;           // 0 → 1 while materializing
  private popFx: THREE.Mesh;
  private mood: Mood = 'idle';
  private jets: THREE.Mesh[] = [];
  private jetMat: THREE.MeshBasicMaterial;

  constructor() {
    const shell = this.mat(new THREE.MeshStandardMaterial({ color: '#f6f1e8', roughness: 0.32, metalness: 0.05, emissive: '#8a7f6e', emissiveIntensity: 0.55 }));
    const trim = this.mat(new THREE.MeshStandardMaterial({ color: '#5b6b94', roughness: 0.4, metalness: 0.3, emissive: '#141c34', emissiveIntensity: 0.6 }));
    const cyan = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 1.05, 1.25), toneMapped: false }));
    const pink = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 0.35, 0.95), toneMapped: false }));
    this.chest = cyan.clone() as THREE.MeshBasicMaterial;
    this.materials.push(this.chest);
    const m = (g: THREE.BufferGeometry, mt: THREE.Material) => {
      this.geometries.push(g);
      const x = new THREE.Mesh(g, mt);
      x.castShadow = true;
      return x;
    };

    // ---- body: rounded torso with a belly panel and chest light
    const torso = m(new RoundedBoxGeometry(0.34, 0.3, 0.27, 4, 0.12), shell);
    torso.position.y = 0.33;
    const belly = m(new RoundedBoxGeometry(0.2, 0.13, 0.02, 2, 0.01), trim);
    belly.position.set(0, 0.3, 0.135);
    const light = m(new THREE.CircleGeometry(0.03, 20), this.chest);
    light.position.set(0, 0.31, 0.147);
    this.body.add(torso, belly, light);

    // ---- head: big rounded box, face screen, ears, antenna
    const skull = m(new RoundedBoxGeometry(0.58, 0.46, 0.46, 5, 0.16), shell);
    this.faceCanvas.width = 256; this.faceCanvas.height = 176;
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    const faceMat = this.mat(new THREE.MeshBasicMaterial({ map: this.faceTex, toneMapped: false }));
    const screenBezel = m(new RoundedBoxGeometry(0.46, 0.32, 0.02, 3, 0.07), trim);
    screenBezel.position.set(0, -0.01, 0.228);
    const face = m(new THREE.PlaneGeometry(0.42, 0.29), faceMat);
    face.position.set(0, -0.01, 0.24);
    this.head.add(skull, screenBezel, face);
    for (const side of [-1, 1]) {
      const ear = m(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 20).rotateZ(Math.PI / 2), trim);
      ear.position.set(0.3 * side, 0, 0);
      const ring = m(new THREE.TorusGeometry(0.05, 0.012, 6, 20).rotateY(Math.PI / 2), cyan);
      ring.position.set(0.335 * side, 0, 0);
      this.head.add(ear, ring);
    }
    const stalk = m(new THREE.CylinderGeometry(0.012, 0.016, 0.14, 8), trim);
    stalk.position.set(0, 0.29, 0);
    this.antennaTip = new THREE.Group();
    const tip = m(new THREE.SphereGeometry(0.04, 16, 12), pink);
    this.antennaTip.add(tip);
    this.antennaTip.position.set(0, 0.38, 0);
    this.head.add(stalk, this.antennaTip);
    this.head.position.y = 0.72;
    this.body.add(this.head);

    // ---- stubby limbs (pivot groups at the shoulder / hip)
    const limb = (len: number, r: number, end: THREE.Mesh) => {
      const g = new THREE.Group();
      const seg = m(new THREE.CapsuleGeometry(r, len, 6, 12), shell);
      seg.position.y = -len / 2 - r * 0.3;
      end.position.y = -len - r * 0.6;
      g.add(seg, end);
      return g;
    };
    const hand = () => m(new THREE.SphereGeometry(0.058, 16, 12), trim);
    const foot = () => { const f = m(new RoundedBoxGeometry(0.12, 0.06, 0.16, 2, 0.03), trim); return f; };
    this.armL = limb(0.1, 0.048, hand()); this.armL.position.set(-0.215, 0.42, 0); this.armL.rotation.z = -0.25;
    this.armR = limb(0.1, 0.048, hand()); this.armR.position.set(0.215, 0.42, 0); this.armR.rotation.z = 0.25;
    this.legL = limb(0.07, 0.055, foot()); this.legL.position.set(-0.085, 0.19, 0);
    this.legR = limb(0.07, 0.055, foot()); this.legR.position.set(0.085, 0.19, 0);
    for (const f of [this.legL, this.legR]) f.children[1].position.z = 0.03;
    this.body.add(this.armL, this.armR, this.legL, this.legR);
    // light seams
    const seam = (r: number, y: number, parent: THREE.Object3D, z = 0) => {
      const ring = m(new THREE.TorusGeometry(r, 0.008, 6, 32).rotateX(Math.PI / 2), cyan);
      ring.position.set(0, y, z);
      parent.add(ring);
    };
    seam(0.15, 0.475, this.body);           // neck
    seam(0.175, 0.24, this.body);           // waist
    for (const a of [this.armL, this.armR]) seam(0.05, -0.115, a);
    for (const l of [this.legL, this.legR]) seam(0.058, -0.09, l);
    const line = m(new THREE.BoxGeometry(0.006, 0.2, 0.006), cyan); // spine light
    line.position.set(0, 0.34, -0.138);
    this.body.add(line);
    this.group.add(this.body);

    // ---- foot jets (only while flying)
    this.jetMat = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.3, 1.6), transparent: true, opacity: 0.85,
      toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const leg of [this.legL, this.legR]) {
      const g = new THREE.ConeGeometry(0.045, 0.22, 12, 1, true).rotateX(Math.PI); // tip pointing down
      this.geometries.push(g);
      const jet = new THREE.Mesh(g, this.jetMat);
      jet.position.set(0, -0.26, 0.02);
      jet.visible = false;
      leg.add(jet);
      this.jets.push(jet);
    }

    // ---- materialize burst (a glowing shell that pops away)
    this.popFx = m(new THREE.SphereGeometry(0.62, 24, 16), this.mat(new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.4, 1.2, 1.5), transparent: true, opacity: 0, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending })));
    this.popFx.position.y = 0.5;
    this.group.add(this.popFx);
    this.drawFace();
  }

  private mat<T extends THREE.Material>(x: T): T { this.materials.push(x); return x; }

  /** Pop into existence (after entering a building or a teleport). */
  materialize() { this.pop = 0; }

  setVisible(v: boolean) { this.group.visible = v; }

  /**
   * Animate. speed: horizontal speed in body-heights per second; airborne: in the air.
   * The waddle phase advances with distance so the feet don't slide.
   */
  update(dt: number, speed: number, airborne: boolean, flying = false) {
    this.t += dt;
    const moving = speed > 0.05 && !airborne;
    const running = speed > 2.6;
    this.mood = this.pop < 1 ? 'pop' : flying ? (speed > 0.3 ? 'run' : 'idle') : airborne ? 'jump' : running ? 'run' : moving ? 'walk' : 'idle';
    for (const j of this.jets) {
      j.visible = flying;
      if (flying) j.scale.set(1, 0.7 + 0.5 * Math.random() + Math.min(1.2, speed * 0.15), 1);
    }
    if (flying) this.jetMat.opacity = 0.6 + 0.3 * Math.sin(this.t * 40);
    this.phase += moving ? dt * speed * 6.5 : 0;
    const s = Math.sin(this.phase);
    const amp = moving ? (running ? 0.95 : 0.6) : 0;
    const k = Math.min(1, dt * 14);
    const ease = (o: THREE.Object3D, ax: 'x' | 'z', v: number) => { o.rotation[ax] += (v - o.rotation[ax]) * k; };

    if (flying) {
      // superhero glide: arms out like wings, legs trailing, lean into the speed
      const lean = Math.min(0.6, speed * 0.08);
      ease(this.armL, 'x', -0.2 - lean); ease(this.armR, 'x', -0.2 - lean);
      ease(this.armL, 'z', -1.25 + Math.sin(this.t * 3) * 0.08); ease(this.armR, 'z', 1.25 - Math.sin(this.t * 3) * 0.08);
      ease(this.legL, 'x', 0.25 + lean * 0.6); ease(this.legR, 'x', 0.35 + lean * 0.6);
    } else if (airborne) {
      ease(this.armL, 'x', -2.5); ease(this.armR, 'x', -2.5);
      ease(this.armL, 'z', -0.6); ease(this.armR, 'z', 0.6);
      ease(this.legL, 'x', -0.5); ease(this.legR, 'x', 0.3);
    } else {
      ease(this.legL, 'x', s * amp);
      ease(this.legR, 'x', -s * amp);
      ease(this.armL, 'x', -s * amp * 1.1);
      ease(this.armR, 'x', s * amp * 1.1);
      // idle: a little wave every few seconds
      const wave = !moving && (this.t % 7) > 5.6 ? Math.sin(this.t * 14) * 0.35 - 2.3 : 0;
      ease(this.armR, 'x', moving ? s * amp * 1.1 : wave);
      ease(this.armL, 'z', -0.25 - (moving ? 0.1 : 0));
      ease(this.armR, 'z', wave ? 0.5 : 0.25 + (moving ? 0.1 : 0));
    }
    // waddle: bounce on every step, roll side to side, lean into a run
    const bounce = flying ? Math.sin(this.t * 2.2) * 0.04 : moving ? Math.abs(s) * (running ? 0.06 : 0.04) : 0.012 * (1 + Math.sin(this.t * 2.6));
    this.body.position.y = bounce;
    this.body.rotation.z += ((moving ? s * 0.09 : 0) - this.body.rotation.z) * k;
    this.body.rotation.x += ((flying ? Math.min(0.55, 0.1 + speed * 0.07) : running ? 0.18 : moving ? 0.06 : 0) - this.body.rotation.x) * k;
    // head lags a little behind the body; idle head tilt
    this.head.rotation.z += ((moving ? -s * 0.06 : Math.sin(this.t * 0.7) * 0.08) - this.head.rotation.z) * Math.min(1, dt * 6);
    this.head.rotation.y += ((moving ? 0 : Math.sin(this.t * 0.45) * 0.3) - this.head.rotation.y) * Math.min(1, dt * 3);

    // springy antenna: driven by body acceleration
    const wp = new THREE.Vector3();
    this.group.getWorldPosition(wp);
    const vel = wp.clone().sub(this.lastPos).divideScalar(Math.max(dt, 1e-3));
    this.lastPos.copy(wp);
    const kick = new THREE.Vector2(-vel.x, -vel.z).multiplyScalar(0.0006);
    this.tipVel.add(kick).addScaledVector(this.tipOff, -dt * 90).multiplyScalar(Math.exp(-dt * 6));
    this.tipOff.addScaledVector(this.tipVel, dt * 8).clampLength(0, 0.06);
    this.antennaTip.position.set(this.tipOff.x, 0.38 + Math.abs(this.tipOff.length()) * -0.2 + bounce * 0.3, this.tipOff.y);

    // chest light pulses; faster when running
    this.chest.color.setRGB(0.35, 1.05, 1.25).multiplyScalar(0.7 + 0.35 * Math.sin(this.t * (running ? 9 : 3)));

    // blink
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 0.13; this.nextBlink = 2 + Math.random() * 3.5; }
    if (this.blink > 0) this.blink -= dt;
    this.drawFace();

    // pop-in: squash & stretch with a burst
    if (this.pop < 1) {
      this.pop = Math.min(1, this.pop + dt / 0.7);
      const p = this.pop;
      const sc = p < 0.6 ? THREE.MathUtils.lerp(0.05, 1.18, p / 0.6) : THREE.MathUtils.lerp(1.18, 1, (p - 0.6) / 0.4);
      this.body.scale.set(sc * (p < 0.6 ? 1.1 - 0.1 * p : 1), sc, sc);
      const fx = this.popFx.material as THREE.MeshBasicMaterial;
      fx.opacity = 0.3 * (1 - p) * (1 - p);
      this.popFx.scale.setScalar(0.4 + 1.4 * p);
    } else if (this.body.scale.x !== 1) {
      this.body.scale.set(1, 1, 1);
      (this.popFx.material as THREE.MeshBasicMaterial).opacity = 0;
    }
  }

  /** Face screen: eyes and mouth by mood; redrawn only when something changes. */
  private drawFace() {
    const closed = this.blink > 0 && this.mood !== 'jump';
    const look = Math.round(Math.sin(this.t * 0.45) * 4);
    const key = `${this.mood}|${closed}|${this.mood === 'idle' ? look : 0}`;
    if (key === this.faceKey) return;
    this.faceKey = key;
    const c = this.faceCanvas.getContext('2d')!;
    const W = 256, H = 176;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1426'); g.addColorStop(1, '#050a16');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    // glossy highlight
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.beginPath(); c.ellipse(70, 30, 70, 18, -0.2, 0, Math.PI * 2); c.fill();
    const eye = '#7ff6ff';
    c.shadowColor = '#36e0ff'; c.shadowBlur = 16;
    c.fillStyle = eye; c.strokeStyle = eye; c.lineCap = 'round'; c.lineWidth = 12;
    const ex = 78, ey = 78, gap = 100;
    const dx = this.mood === 'idle' ? look : 0;
    for (const x of [ex + dx, ex + gap + dx]) {
      if (closed) {
        c.beginPath(); c.moveTo(x - 20, ey + 6); c.lineTo(x + 20, ey + 6); c.stroke();
      } else if (this.mood === 'run') { // happy ^ ^
        c.beginPath(); c.moveTo(x - 22, ey + 12); c.lineTo(x, ey - 10); c.lineTo(x + 22, ey + 12); c.stroke();
      } else if (this.mood === 'jump' || this.mood === 'pop') { // wide
        c.beginPath(); c.ellipse(x, ey, 22, 30, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#0b1426'; c.beginPath(); c.ellipse(x + 6, ey - 8, 7, 9, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = eye;
      } else {
        c.beginPath(); c.ellipse(x, ey, 19, 25, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#ffffff'; c.beginPath(); c.ellipse(x + 6, ey - 9, 6, 7, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = eye;
      }
    }
    // mouth
    c.lineWidth = 7;
    c.beginPath();
    if (this.mood === 'jump' || this.mood === 'pop') c.ellipse(W / 2, 130, 11, 12, 0, 0, Math.PI * 2);
    else c.arc(W / 2, 118, 16, 0.15 * Math.PI, 0.85 * Math.PI);
    if (this.mood === 'jump' || this.mood === 'pop') c.stroke(); else c.stroke();
    // blush
    c.shadowBlur = 10; c.shadowColor = '#ff4fd8';
    c.fillStyle = 'rgba(255,79,216,0.55)';
    for (const x of [ex - 34, ex + gap + 34]) { c.beginPath(); c.ellipse(x, 116, 16, 8, 0, 0, Math.PI * 2); c.fill(); }
    c.shadowBlur = 0;
    this.faceTex.needsUpdate = true;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.faceTex.dispose();
  }
}
