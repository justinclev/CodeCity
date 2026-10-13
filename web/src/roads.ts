/** Pure road geometry (no three.js), so it can be tested on its own. */
export interface Rect { x: number; z: number; w: number; d: number }
export type Pt = [number, number];

/** Where the straight line from rect r's centre towards (px, pz) leaves the rect. */
export function rim(r: Rect, px: number, pz: number): Pt {
  const cx = r.x + r.w / 2, cz = r.z + r.d / 2, dx = px - cx, dz = pz - cz;
  const t = Math.min(dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity, dz !== 0 ? r.d / 2 / Math.abs(dz) : Infinity);
  return [cx + dx * Math.min(1, t), cz + dz * Math.min(1, t)];
}

/** Does the segment p→q cross rectangle r (grown by pad)? */
export function segHits(p: Pt, q: Pt, r: Rect, pad: number): boolean {
  const x0 = r.x - pad, x1 = r.x + r.w + pad, z0 = r.z - pad, z1 = r.z + r.d + pad;
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dz = q[1] - p[1];
  for (const [pp, dd, lo, hi] of [[p[0], dx, x0, x1], [p[1], dz, z0, z1]] as [number, number, number, number][]) {
    if (Math.abs(dd) < 1e-9) { if (pp < lo || pp > hi) return false; continue; }
    let a = (lo - pp) / dd, b = (hi - pp) / dd;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Route of a highway from city A to city B: straight when nothing is in the way, else the L-shaped
 * route (through a corner of the two cities' centres), else a dog-leg around the blockers.
 */
export function route(A: Rect, B: Rect, others: Rect[], pad: number): Pt[] {
  const ac: Pt = [A.x + A.w / 2, A.z + A.d / 2], bc: Pt = [B.x + B.w / 2, B.z + B.d / 2];
  const straight: Pt[] = [rim(A, bc[0], bc[1]), rim(B, ac[0], ac[1])];
  const clear = (pts: Pt[]) => pts.every((p, k) => k === 0 || others.every(o => !segHits(pts[k - 1], p, o, pad)));
  if (clear(straight)) return straight;
  for (const e of [[ac[0], bc[1]], [bc[0], ac[1]]] as Pt[]) {
    const pts: Pt[] = [rim(A, e[0], e[1]), e, rim(B, e[0], e[1])];
    if (Math.abs(pts[0][0] - e[0]) + Math.abs(pts[0][1] - e[1]) < 1e-3 || Math.abs(pts[2][0] - e[0]) + Math.abs(pts[2][1] - e[1]) < 1e-3) continue; // elbow inside a city
    if (clear(pts)) return pts;
  }
  const hit = others.filter(o => segHits(straight[0], straight[1], o, pad));
  if (hit.length) {
    const vertical = Math.abs(bc[1] - ac[1]) >= Math.abs(bc[0] - ac[0]);
    const lo = Math.min(...hit.map(o => (vertical ? o.x : o.z))) - pad * 3, hi = Math.max(...hit.map(o => (vertical ? o.x + o.w : o.z + o.d))) + pad * 3;
    let best: Pt[] | null = null, bestLen = Infinity;
    for (const c of [lo, hi]) {
      const p1: Pt = vertical ? [c, ac[1]] : [ac[0], c], p2: Pt = vertical ? [c, bc[1]] : [bc[0], c];
      const pts: Pt[] = [rim(A, p1[0], p1[1]), p1, p2, rim(B, p2[0], p2[1])];
      if (!clear(pts)) continue;
      const len = pts.reduce((t, p, k) => t + (k ? Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
      if (len < bestLen) { best = pts; bestLen = len; }
    }
    if (best) return best;
  }
  return straight;
}
