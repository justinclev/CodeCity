import * as THREE from 'three';

/** A fading wall of light left behind a moving point (drawn while running). */
export class LightTrail {
  readonly mesh: THREE.Mesh;
  private pts: { p: THREE.Vector3; age: number }[] = [];
  private geo = new THREE.BufferGeometry();
  private readonly max = 120;
  private pos: Float32Array;
  private alpha: Float32Array;

  constructor(color: THREE.Color, private life = 1.6) {
    this.pos = new Float32Array(this.max * 2 * 3);
    this.alpha = new Float32Array(this.max * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < this.max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color } },
      vertexShader: `attribute float aAlpha; varying float vA; varying float vY;
        void main(){ vA = aAlpha; vY = float(gl_VertexID % 2); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; varying float vY;
        void main(){ float edge = 0.35 + 0.65 * smoothstep(0.55, 1.0, vY); gl_FragColor = vec4(uColor * (1.2 + 1.6 * edge), vA * edge); }`,
      transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  /** Add the current foot position (when emitting) and age the trail. */
  update(dt: number, at: THREE.Vector3, height: number, emit: boolean) {
    for (const p of this.pts) p.age += dt;
    while (this.pts.length && this.pts[0].age > this.life) this.pts.shift();
    if (emit) {
      const last = this.pts[this.pts.length - 1];
      if (!last || last.p.distanceTo(at) > height * 0.15) this.pts.push({ p: at.clone(), age: 0 });
      if (this.pts.length > this.max) this.pts.shift();
    }
    const n = this.pts.length;
    for (let i = 0; i < this.max; i++) {
      const q = this.pts[Math.min(i, Math.max(0, n - 1))];
      const a = i < n && q ? Math.max(0, 1 - q.age / this.life) * (i / Math.max(1, n - 1)) : 0;
      const p = q ? q.p : at;
      this.pos.set([p.x, p.y + 0.02, p.z, p.x, p.y + height, p.z], i * 6);
      this.alpha[i * 2] = a; this.alpha[i * 2 + 1] = a;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() { this.pts = []; }

  dispose() { this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
