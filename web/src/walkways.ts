import * as THREE from 'three';
import type { City } from './types';
import type { BuildingSpec } from './architecture';
import { isTest } from './tour';

/**
 * Test walkways: a skybridge from every test file to the code it tests. A test is
 * paired with the files it imports (and its same-named sibling: `foo_test.go` ↔
 * `foo.go`, `foo.test.ts` ↔ `foo.ts`, `test_foo.py` ↔ `foo.py`); a bridge is only
 * built where the two footprints face each other across a gap with nothing in between.
 * The deck lies at the lower of the two podium roofs, so you can walk from one onto the other.
 */

export interface Way {
  test: number;
  subject: number;
  /** Axis the bridge runs along. */
  axis: 'x' | 'z';
  /** Gap start / end along the axis, and the lane centre on the other axis. */
  a: number;
  b: number;
  lane: number;
  width: number;
}

export interface WaySolid { x0: number; x1: number; z0: number; z1: number; y0: number; top: number }

const MAX_WAYS = 600;
const PER_TEST = 2;

const stem = (path: string): string => {
  let n = path.slice(path.lastIndexOf('/') + 1);
  n = n.replace(/\.[^.]+$/, '');
  n = n.replace(/(?:_test|\.test|\.spec|_spec|Tests?)$/, '').replace(/^test_/, '');
  return n.toLowerCase();
};

/** The tier whose roof is the podium (past a lobby plinth, if any). */
const podium = (sp: BuildingSpec) => (sp.tiers[0]?.facade === 'colonnade' && sp.tiers.length > 1 ? 1 : 0);

export class Walkways {
  readonly group = new THREE.Group();
  ways: Way[] = [];
  private deck?: THREE.InstancedMesh;
  private glow?: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  private specs: BuildingSpec[] = [];
  private hacker = false;
  private night = true;

  /** Pair tests with their subjects. `cell` ≈ the unit that sizes streets and people. */
  build(city: City, specs: BuildingSpec[], cell: number, exists: (i: number) => boolean) {
    this.clear();
    this.specs = specs;
    const bs = city.buildings;
    const byDir = new Map<number, number[]>();
    bs.forEach((b, i) => { if (!exists(i)) return; const l = byDir.get(b.district) ?? []; l.push(i); byDir.set(b.district, l); });
    const maxGap = cell * 6, minLane = cell * 0.9;
    const width = cell * 0.7;
    // spatial buckets for the "nothing in between" test
    const bucket = Math.max(cell * 8, 1);
    const grid = new Map<string, number[]>();
    bs.forEach((b, i) => {
      if (!exists(i)) return;
      for (let gx = Math.floor(b.x / bucket); gx <= Math.floor((b.x + b.w) / bucket); gx++)
        for (let gz = Math.floor(b.z / bucket); gz <= Math.floor((b.z + b.d) / bucket); gz++) {
          const k = `${gx},${gz}`; const l = grid.get(k) ?? []; l.push(i); grid.set(k, l);
        }
    });
    const clear = (t: number, s: number, ax: 'x' | 'z', a: number, b: number, lane: number): boolean => {
      const x0 = ax === 'x' ? a : lane - width / 2, x1 = ax === 'x' ? b : lane + width / 2;
      const z0 = ax === 'z' ? a : lane - width / 2, z1 = ax === 'z' ? b : lane + width / 2;
      for (let gx = Math.floor(x0 / bucket); gx <= Math.floor(x1 / bucket); gx++)
        for (let gz = Math.floor(z0 / bucket); gz <= Math.floor(z1 / bucket); gz++)
          for (const j of grid.get(`${gx},${gz}`) ?? []) {
            if (j === t || j === s) continue;
            const o = bs[j];
            if (o.x < x1 && o.x + o.w > x0 && o.z < z1 && o.z + o.d > z0) return false;
          }
      return true;
    };
    const link = (t: number, s: number): Way | null => {
      const A = bs[t], B = bs[s];
      const gapX = Math.max(A.x - (B.x + B.w), B.x - (A.x + A.w));
      const gapZ = Math.max(A.z - (B.z + B.d), B.z - (A.z + A.d));
      const ovX0 = Math.max(A.x, B.x), ovX1 = Math.min(A.x + A.w, B.x + B.w);
      const ovZ0 = Math.max(A.z, B.z), ovZ1 = Math.min(A.z + A.d, B.z + B.d);
      let ax: 'x' | 'z', a: number, b: number, lo: number, hi: number, gap: number;
      if (gapX > 0 && ovZ1 - ovZ0 >= minLane && gapX <= maxGap && (gapZ <= 0 || gapX <= gapZ)) {
        ax = 'x'; gap = gapX; lo = ovZ0; hi = ovZ1;
        if (A.x + A.w <= B.x) { a = A.x + A.w; b = B.x; } else { a = B.x + B.w; b = A.x; }
      } else if (gapZ > 0 && ovX1 - ovX0 >= minLane && gapZ <= maxGap) {
        ax = 'z'; gap = gapZ; lo = ovX0; hi = ovX1;
        if (A.z + A.d <= B.z) { a = A.z + A.d; b = B.z; } else { a = B.z + B.d; b = A.z; }
      } else return null;
      void gap;
      const lane = (lo + hi) / 2;
      if (!clear(t, s, ax, a, b, lane)) return null;
      return { test: t, subject: s, axis: ax, a, b, lane, width: Math.min(width, hi - lo) };
    };
    const ways: Way[] = [];
    const seen = new Set<string>();
    const tests: number[] = [];
    bs.forEach((b, i) => { if (exists(i) && isTest(b.path)) tests.push(i); });
    for (const t of tests) {
      const tb = bs[t], st = stem(tb.path);
      const cand = new Map<number, number>(); // subject → priority (lower first)
      for (const j of byDir.get(tb.district) ?? []) if (j !== t && !isTest(bs[j].path) && stem(bs[j].path) === st) cand.set(j, 0);
      for (const j of tb.imp ?? []) if (exists(j) && !isTest(bs[j].path) && !cand.has(j)) cand.set(j, 1);
      const order = [...cand.entries()].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
      let made = 0;
      for (const [s] of order) {
        if (made >= PER_TEST || ways.length >= MAX_WAYS) break;
        const k = `${Math.min(t, s)}:${Math.max(t, s)}`;
        if (seen.has(k)) continue;
        const w = link(t, s);
        if (!w) continue;
        seen.add(k); ways.push(w); made++;
      }
    }
    this.ways = ways;
    const n = Math.max(1, ways.length);
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.deck = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.6, metalness: 0.3 }), n * 3);
    this.glow = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0x5fd0ff, toneMapped: false }), n * 2);
    for (const m of [this.deck, this.glow]) { m.count = 0; m.frustumCulled = false; m.castShadow = m === this.deck; this.group.add(m); }
    this.applyTheme();
  }

  setTheme(hacker: boolean, night: boolean) { this.hacker = hacker; this.night = night; this.applyTheme(); }

  private applyTheme() {
    if (!this.deck || !this.glow) return;
    const d = this.deck.material as THREE.MeshStandardMaterial, g = this.glow.material as THREE.MeshBasicMaterial;
    d.color.set(this.hacker ? 0x0b1118 : this.night ? 0x7a8396 : 0xa6aab2);
    d.metalness = this.hacker ? 0.9 : 0.3; d.roughness = this.hacker ? 0.25 : 0.6;
    g.color.set(this.hacker ? 0x39ffb6 : this.night ? 0x7fe3ff : 0x2b9bd6);
  }

  /** Position the bridges for the current building heights. `podiumTop(i)` = y of the podium roof (< 0: absent). */
  update(podiumTop: (i: number) => number) {
    if (!this.deck || !this.glow) return;
    let nd = 0, ng = 0;
    const t = this.tmp;
    const put = (m: THREE.InstancedMesh, n: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      t.position.set(x, y, z); t.scale.set(sx, sy, sz); t.rotation.set(0, 0, 0); t.updateMatrix(); m.setMatrixAt(n, t.matrix);
    };
    for (const w of this.ways) {
      const ya = podiumTop(w.test), yb = podiumTop(w.subject);
      if (ya <= 0 || yb <= 0) continue;
      const y = Math.min(ya, yb), len = w.b - w.a, mid = (w.a + w.b) / 2, th = w.width * 0.2;
      const sx = w.axis === 'x' ? len : w.width, sz = w.axis === 'x' ? w.width : len;
      const cx = w.axis === 'x' ? mid : w.lane, cz = w.axis === 'x' ? w.lane : mid;
      put(this.deck, nd++, cx, y - th / 2, cz, sx, th, sz);
      // rails along both edges (lit strips)
      const off = w.width / 2 - th * 0.4;
      for (const sgn of [-1, 1]) {
        const rx = w.axis === 'x' ? cx : cx + sgn * off, rz = w.axis === 'x' ? cz + sgn * off : cz;
        put(this.glow, ng++, rx, y + th * 0.4, rz, w.axis === 'x' ? len : th * 0.6, th * 0.8, w.axis === 'x' ? th * 0.6 : len);
      }
    }
    this.deck.count = nd; this.glow.count = ng;
    this.deck.instanceMatrix.needsUpdate = true; this.glow.instanceMatrix.needsUpdate = true;
  }

  /** Collision / standing surfaces for walk mode (deck only; the rails are decoration). */
  solids(podiumTop: (i: number) => number): WaySolid[] {
    const out: WaySolid[] = [];
    for (const w of this.ways) {
      const ya = podiumTop(w.test), yb = podiumTop(w.subject);
      if (ya <= 0 || yb <= 0) continue;
      const y = Math.min(ya, yb), th = w.width * 0.2;
      const h = w.width / 2;
      out.push(w.axis === 'x'
        ? { x0: w.a, x1: w.b, z0: w.lane - h, z1: w.lane + h, y0: y - th, top: y }
        : { x0: w.lane - h, x1: w.lane + h, z0: w.a, z1: w.b, y0: y - th, top: y });
    }
    return out;
  }

  podiumFraction(i: number): number { const sp = this.specs[i]; return sp ? sp.tiers[podium(sp)].y1 : 1; }

  setVisible(on: boolean) { this.group.visible = on; }

  clear() {
    for (const m of [this.deck, this.glow]) if (m) { this.group.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
    this.deck = this.glow = undefined;
    this.ways = [];
  }
}
