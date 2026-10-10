import * as THREE from 'three';
import { TraceLayer, type Trace } from './links';

/**
 * Hacker-mode atmosphere: decorative circuit tracers racing over the floor
 * around the city, data particles drifting upward, and light beacons over the
 * hottest files.
 */
export class HackerFx {
  readonly group = new THREE.Group();
  private traces = new TraceLayer(true);
  private points?: THREE.Points;
  private beacons: THREE.Mesh[] = [];
  private beaconMat?: THREE.ShaderMaterial;
  private speeds = new Float32Array(0);
  private bounds = { x0: 0, x1: 1, z0: 0, z1: 1, h: 10 };

  constructor() { this.group.add(this.traces.group); }

  build(bounds: { w: number; d: number }, tallest: number, hot: THREE.Vector3[], rand = mulberry(7)) {
    this.clear();
    const s = Math.max(bounds.w, bounds.d);
    const cx = bounds.w / 2, cz = bounds.d / 2;
    this.bounds = { x0: -s * 0.4, x1: bounds.w + s * 0.4, z0: -s * 0.4, z1: bounds.d + s * 0.4, h: Math.max(tallest * 1.4, s * 0.25) };

    // tracers: orthogonal paths starting at the city's edge and running outward
    const traces: Trace[] = [];
    const colors = [new THREE.Color('#d23cff'), new THREE.Color('#36e0ff'), new THREE.Color('#ff3cd0'), new THREE.Color('#7a3cff')];
    for (let k = 0; k < 70; k++) {
      const side = k % 4;
      let x = side === 0 ? -s * 0.02 : side === 1 ? bounds.w + s * 0.02 : cx + (rand() - 0.5) * bounds.w;
      let z = side === 2 ? -s * 0.02 : side === 3 ? bounds.d + s * 0.02 : cz + (rand() - 0.5) * bounds.d;
      const out = [new THREE.Vector3(x, 0.02, z)];
      const dir = side === 0 ? [-1, 0] : side === 1 ? [1, 0] : side === 2 ? [0, -1] : [0, 1];
      let d = dir;
      for (let n = 0; n < 3 + Math.floor(rand() * 4); n++) {
        const len = s * (0.03 + rand() * 0.12);
        x += d[0] * len; z += d[1] * len;
        out.push(new THREE.Vector3(x, 0.02, z));
        d = n % 2 === 0 ? (rand() < 0.5 ? [d[1], d[0]] : [-d[1], -d[0]]) : dir; // zig-zag outward
      }
      traces.push({ points: out, color: colors[k % colors.length], width: s * (rand() < 0.2 ? 0.0018 : 0.001), speed: s * (0.08 + rand() * 0.12) });
    }
    this.traces.spacing = s * 0.09;
    this.traces.base = 0.18;
    this.traces.set(traces);

    // data particles
    const n = 1400;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    this.speeds = new Float32Array(n);
    const b = this.bounds;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = b.x0 + rand() * (b.x1 - b.x0);
      pos[i * 3 + 1] = rand() * b.h;
      pos[i * 3 + 2] = b.z0 + rand() * (b.z1 - b.z0);
      const c = rand() < 0.65 ? colors[1] : colors[0];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      this.speeds[i] = b.h * (0.02 + rand() * 0.05);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: Math.max(0.08, s * 0.0028), vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
    this.group.add(this.points);

    // beacons over hotspots: tall additive beams that fade upward and shimmer
    this.beaconMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){
          float fade = pow(1.0 - vUv.y, 1.6);
          float bands = 0.65 + 0.35 * sin(vUv.y * 40.0 - uTime * 6.0);
          gl_FragColor = vec4(vec3(1.0, 0.3, 0.85) * 0.9 * fade * bands, fade * 0.35);
        }`,
      transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    for (const p of hot) {
      const h = this.bounds.h * 1.4;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.0015, s * 0.004, h, 16, 1, true), this.beaconMat);
      beam.position.set(p.x, p.y + h / 2, p.z);
      this.beacons.push(beam);
      this.group.add(beam);
    }
  }

  update(dt: number, time: number) {
    this.traces.update(time);
    if (this.beaconMat) this.beaconMat.uniforms.uTime.value = time;
    if (this.points) {
      const a = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const h = this.bounds.h;
      for (let i = 0; i < this.speeds.length; i++) {
        let y = a.getY(i) + this.speeds[i] * dt;
        if (y > h) y -= h;
        a.setY(i, y);
      }
      a.needsUpdate = true;
    }
  }

  clear() {
    this.traces.clear();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); this.points = undefined; }
    for (const b of this.beacons) { this.group.remove(b); b.geometry.dispose(); }
    this.beacons = [];
    this.beaconMat?.dispose();
    this.beaconMat = undefined;
  }
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
