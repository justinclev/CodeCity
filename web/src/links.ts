import * as THREE from 'three';

/** One routed trace: a polyline on (or just above) the ground. */
export interface Trace {
  points: THREE.Vector3[];
  color: THREE.Color;
  width: number;
  speed: number; // pulse speed, world units per second
}

/**
 * Circuit-board style traces drawn as flat ribbons in a single draw call, with
 * light pulses travelling from the first point to the last, plus glowing vias
 * at the ends and bends.
 */
export class TraceLayer {
  readonly group = new THREE.Group();
  private ribbon?: THREE.Mesh;
  private vias?: THREE.InstancedMesh;
  private mat: THREE.ShaderMaterial;
  private viaMat: THREE.MeshBasicMaterial;

  constructor(additive: boolean) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSpacing: { value: 6 }, uBase: { value: 0.35 } },
      vertexShader: `
        attribute float aDist; attribute float aSpeed; attribute vec3 aColor; attribute float aSeed;
        varying float vDist; varying float vSpeed; varying vec3 vColor; varying float vSeed; varying float vSide;
        void main() {
          vDist = aDist; vSpeed = aSpeed; vColor = aColor; vSeed = aSeed; vSide = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime; uniform float uSpacing; uniform float uBase;
        varying float vDist; varying float vSpeed; varying vec3 vColor; varying float vSeed; varying float vSide;
        void main() {
          float f = fract((vDist - uTime * vSpeed) / uSpacing + vSeed);
          float pulse = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.04, 0.22, f));
          float core = 1.0 - abs(vSide * 2.0 - 1.0);            // brighter along the middle of the ribbon
          vec3 c = vColor * (uBase + 2.4 * pulse) * (0.55 + 0.45 * core);
          gl_FragColor = vec4(c, clamp(uBase + pulse, 0.0, 1.0) * (0.6 + 0.4 * core));
        }`,
      transparent: true, depthWrite: false, toneMapped: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.viaMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, vertexColors: false });
  }

  setAdditive(additive: boolean) {
    const b = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mat.blending = b; this.viaMat.blending = b;
    this.mat.needsUpdate = true; this.viaMat.needsUpdate = true;
  }

  set spacing(v: number) { this.mat.uniforms.uSpacing.value = v; }
  set base(v: number) { this.mat.uniforms.uBase.value = v; }

  update(time: number) { this.mat.uniforms.uTime.value = time; }

  clear() {
    for (const o of [this.ribbon, this.vias]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      if (o instanceof THREE.InstancedMesh) o.dispose();
    }
    this.ribbon = this.vias = undefined;
  }

  set(traces: Trace[]) {
    this.clear();
    if (!traces.length) return;
    const pos: number[] = [], uv: number[] = [], dist: number[] = [], speed: number[] = [], color: number[] = [], seed: number[] = [];
    const idx: number[] = [];
    const viaPts: { p: THREE.Vector3; r: number; c: THREE.Color }[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    let v = 0;
    traces.forEach((t, ti) => {
      const s = (ti * 0.6180339) % 1;
      let along = 0;
      for (let k = 0; k < t.points.length - 1; k++) {
        const a = t.points[k], b = t.points[k + 1];
        const len = a.distanceTo(b);
        if (len < 1e-6) continue;
        const dir = b.clone().sub(a).normalize();
        // horizontal runs are flat ribbons; vertical risers are two crossed quads so they read from any side
        const sides = Math.abs(dir.y) > 0.9
          ? [new THREE.Vector3(t.width / 2, 0, 0), new THREE.Vector3(0, 0, t.width / 2)]
          : [new THREE.Vector3().crossVectors(dir, up).normalize().multiplyScalar(t.width / 2)];
        // extend each segment by half a width so corners join without gaps
        const a2 = a.clone().addScaledVector(dir, k === 0 ? 0 : -t.width / 2);
        const b2 = b.clone().addScaledVector(dir, k === t.points.length - 2 ? 0 : t.width / 2);
        for (const side of sides) {
          for (const [p, d, sv] of [[a2.clone().add(side), along, 0], [a2.clone().sub(side), along, 1], [b2.clone().add(side), along + len, 0], [b2.clone().sub(side), along + len, 1]] as [THREE.Vector3, number, number][]) {
            pos.push(p.x, p.y, p.z); uv.push(0, sv); dist.push(d); speed.push(t.speed); color.push(t.color.r, t.color.g, t.color.b); seed.push(s);
          }
          idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
          v += 4;
        }
        along += len;
      }
      for (let k = 0; k < t.points.length; k++) {
        const end = k === 0 || k === t.points.length - 1;
        viaPts.push({ p: t.points[k], r: t.width * (end ? 1.5 : 0.9), c: t.color });
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speed, 1));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.ribbon = new THREE.Mesh(g, this.mat);
    this.ribbon.renderOrder = 3;
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);

    const via = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
    this.vias = new THREE.InstancedMesh(via, this.viaMat, viaPts.length);
    const m = new THREE.Object3D();
    viaPts.forEach((p, i) => {
      m.position.copy(p.p).add(new THREE.Vector3(0, 0.003, 0));
      m.scale.setScalar(p.r);
      m.updateMatrix();
      this.vias!.setMatrixAt(i, m.matrix);
      this.vias!.setColorAt(i, p.c.clone().multiplyScalar(1.6));
    });
    this.vias.renderOrder = 3;
    this.group.add(this.vias);
  }
}

/** Orthogonal route from a to b (same y): one bend, x-first or z-first by a stable hash. */
export function route(a: THREE.Vector3, b: THREE.Vector3, salt: number): THREE.Vector3[] {
  const y = Math.max(a.y, b.y);
  const A = new THREE.Vector3(a.x, y, a.z), B = new THREE.Vector3(b.x, y, b.z);
  const corner = salt % 2 === 0 ? new THREE.Vector3(B.x, y, A.z) : new THREE.Vector3(A.x, y, B.z);
  return [A, corner, B];
}

/**
 * Raised "data bus" route: up from a's roof to a layer above the skyline, across
 * (one orthogonal bend), and down onto b's roof.
 */
export function busRoute(a: THREE.Vector3, b: THREE.Vector3, layer: number, salt: number): THREE.Vector3[] {
  const L = Math.max(layer, a.y, b.y);
  const A = new THREE.Vector3(a.x, L, a.z), B = new THREE.Vector3(b.x, L, b.z);
  const corner = salt % 2 === 0 ? new THREE.Vector3(B.x, L, A.z) : new THREE.Vector3(A.x, L, B.z);
  return [a.clone(), A, corner, B, b.clone()];
}
