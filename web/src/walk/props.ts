import * as THREE from 'three';

/** A collectible floating over a key building: walk (or fly) into it. */
export interface Shard { building: number; gold: boolean; pos: THREE.Vector3; group: THREE.Group; taken: boolean; t: number }
/** A quiz kiosk on a district's street corner: E asks a question about that directory. */
export interface Terminal { top: string | null; label: string; pos: THREE.Vector3; group: THREE.Group }

function textSprite(text: string, color: string, px = 64): THREE.Sprite {
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d')!;
  const font = `700 ${px}px "JetBrains Mono", ui-monospace, monospace`;
  c.font = font;
  cv.width = Math.ceil(c.measureText(text).width) + px * 0.6;
  cv.height = Math.ceil(px * 1.4);
  c.font = font;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = color; c.shadowBlur = px * 0.3;
  c.fillStyle = color;
  c.fillText(text, cv.width / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
  sp.scale.set(cv.width / cv.height, 1, 1);
  return sp;
}

export class Props {
  readonly group = new THREE.Group();
  shards: Shard[] = [];
  terminals: Terminal[] = [];
  private disposables: { dispose(): void }[] = [];
  private shardGeo = new THREE.OctahedronGeometry(0.5, 0);
  private beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true);
  private mats = {
    pink: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 0.35, 1.2), toneMapped: false, transparent: true, opacity: 0.95 }),
    gold: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.3), toneMapped: false, transparent: true, opacity: 0.95 }),
    beamPink: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.25, 0.9), toneMapped: false, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    beamGold: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.2), toneMapped: false, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    base: new THREE.MeshStandardMaterial({ color: '#0b1a24', roughness: 0.3, metalness: 0.8, emissive: '#06222c', emissiveIntensity: 0.6 }),
    ring: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.1, 0.25), toneMapped: false }),
    screen: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.9, 1.1), toneMapped: false, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  };

  constructor(private u: number) {
    this.disposables.push(this.shardGeo, this.beamGeo, ...Object.values(this.mats));
  }

  addShard(building: number, pos: THREE.Vector3, gold: boolean, beam: number) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const s = this.u * (gold ? 0.55 : 0.42);
    const gem = new THREE.Mesh(this.shardGeo, gold ? this.mats.gold : this.mats.pink);
    gem.scale.set(s, s * 1.5, s);
    const halo = new THREE.Mesh(this.shardGeo, gold ? this.mats.beamGold : this.mats.beamPink);
    halo.scale.set(s * 1.7, s * 2.4, s * 1.7);
    g.add(gem, halo);
    if (beam > 0) { // a light pillar so shards can be spotted across the city
      const b = new THREE.Mesh(this.beamGeo, gold ? this.mats.beamGold : this.mats.beamPink);
      b.scale.set(this.u * 1.2, beam, this.u * 1.2);
      b.position.y = beam / 2 + s;
      g.add(b);
    }
    this.group.add(g);
    this.shards.push({ building, gold, pos: pos.clone(), group: g, taken: false, t: Math.random() * 6 });
  }

  addTerminal(top: string | null, label: string, pos: THREE.Vector3) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const u = this.u;
    const baseGeo = new THREE.CylinderGeometry(u * 0.22, u * 0.3, u * 0.9, 6);
    const ringGeo = new THREE.TorusGeometry(u * 0.42, u * 0.03, 6, 32).rotateX(Math.PI / 2);
    const screenGeo = new THREE.PlaneGeometry(u * 0.8, u * 0.55);
    this.disposables.push(baseGeo, ringGeo, screenGeo);
    const base = new THREE.Mesh(baseGeo, this.mats.base);
    base.position.y = u * 0.45;
    const ring = new THREE.Mesh(ringGeo, this.mats.ring);
    ring.position.y = u * 0.05;
    const screen = new THREE.Mesh(screenGeo, this.mats.screen);
    screen.position.y = u * 1.25;
    const q = textSprite('?', '#ffd23c', 96);
    q.scale.multiplyScalar(u * 0.7);
    q.position.y = u * 1.3;
    const name = textSprite(label, '#bff8ff', 40);
    name.scale.multiplyScalar(u * 0.32);
    name.position.y = u * 1.85;
    this.disposables.push(q.material.map!, q.material, name.material.map!, name.material);
    g.add(base, ring, screen, q, name);
    g.userData = { ring, screen, q };
    this.group.add(g);
    this.terminals.push({ top, label, pos: pos.clone(), group: g });
  }

  update(dt: number, time: number, camYaw: number) {
    for (const s of this.shards) {
      if (s.taken) {
        if (s.group.visible) { // burst outward, then vanish
          s.t += dt;
          s.group.scale.setScalar(1 + s.t * 6);
          if (s.t > 0.35) s.group.visible = false;
        }
        continue;
      }
      s.t += dt;
      s.group.children[0].rotation.y += dt * 1.6;
      s.group.children[1].rotation.y -= dt * 0.9;
      s.group.children[0].position.y = s.group.children[1].position.y = Math.sin(s.t * 2) * this.u * 0.15;
    }
    for (const t of this.terminals) {
      const { ring, screen } = t.group.userData as { ring: THREE.Mesh; screen: THREE.Mesh };
      ring.scale.setScalar(1 + 0.12 * Math.sin(time * 3));
      screen.rotation.y = camYaw;
    }
  }

  take(s: Shard) { s.taken = true; s.t = 0; }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose();
  }
}
