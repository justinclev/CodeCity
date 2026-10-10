import type { VEdge, VNode, View } from './model';

export const GAP_X = 96;   // between columns
export const GAP_Y = 14;   // between boxes in a column

/**
 * Layered left-to-right layout for the system map and module views: inputs on the left, side effects pinned to
 * the right, everything else ranked by the longest path from the inputs (cycles broken by DFS), then ordered
 * within each column by the barycentre of its neighbours to keep lines from crossing.
 */
export function layered(v: View) {
  const byKey = new Map(v.nodes.map(n => [n.key, n]));
  const outs = new Map<string, string[]>(), ins = new Map<string, string[]>();
  for (const n of v.nodes) { outs.set(n.key, []); ins.set(n.key, []); }
  for (const e of v.edges) {
    if (!byKey.has(e.from) || !byKey.has(e.to) || e.from === e.to) continue;
    outs.get(e.from)!.push(e.to);
    ins.get(e.to)!.push(e.from);
  }
  // break cycles: depth-first from the sources (inputs first), back edges are ignored for ranking
  const back = new Set<string>();
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const order = [...v.nodes].sort((a, b) => laneOrder(a) - laneOrder(b) || ins.get(a.key)!.length - ins.get(b.key)!.length || a.label.localeCompare(b.label));
  const visit = (k: string) => {
    state.set(k, 1);
    for (const t of outs.get(k)!) {
      const s = state.get(t);
      if (s === 1) back.add(k + '>' + t);
      else if (!s) visit(t);
    }
    state.set(k, 2);
  };
  for (const n of order) if (!state.get(n.key)) visit(n.key);
  // longest path ranks
  const rank = new Map<string, number>();
  const rankOf = (k: string, guard = 0): number => {
    if (rank.has(k)) return rank.get(k)!;
    if (guard > 400) return 0;
    let r = 0;
    for (const p of ins.get(k)!) if (!back.has(p + '>' + k)) r = Math.max(r, rankOf(p, guard + 1) + 1);
    rank.set(k, r);
    return r;
  };
  for (const n of v.nodes) rankOf(n.key);
  // inputs with nothing coming in start at the left edge; side effects end at the right edge
  let maxR = 0;
  for (const n of v.nodes) if (n.lane !== 'out') maxR = Math.max(maxR, rank.get(n.key)!);
  for (const n of v.nodes) {
    if (n.lane === 'out') rank.set(n.key, maxR + 1);
    // pull a node with a single successor right next to it (shorter lines)
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const n of v.nodes) {
      if (n.lane === 'out' || n.lane === 'in' && !ins.get(n.key)!.length) continue;
      const succ = outs.get(n.key)!.filter(t => !back.has(n.key + '>' + t)).map(t => rank.get(t)!);
      if (succ.length && !ins.get(n.key)!.length) rank.set(n.key, Math.max(rank.get(n.key)!, Math.min(...succ) - 1));
    }
  }
  const cols: VNode[][] = [];
  for (const n of v.nodes) (cols[rank.get(n.key)!] ??= []).push(n);
  for (let i = 0; i < cols.length; i++) cols[i] ??= [];
  // initial order: by lane, then name
  for (const c of cols) c.sort((a, b) => laneOrder(a) - laneOrder(b) || a.label.localeCompare(b.label));
  const pos = new Map<string, number>();
  const setPos = () => { for (const c of cols) c.forEach((n, i) => pos.set(n.key, i)); };
  setPos();
  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0;
    const range = down ? cols.keys() : [...cols.keys()].reverse();
    for (const ci of range) {
      const c = cols[ci];
      const bary = new Map<string, number>();
      for (const n of c) {
        const nb = down ? ins.get(n.key)! : outs.get(n.key)!;
        const ps = nb.map(k => pos.get(k)!).filter(x => x !== undefined);
        bary.set(n.key, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(n.key)!);
      }
      c.sort((a, b) => bary.get(a.key)! - bary.get(b.key)!);
      c.forEach((n, i) => pos.set(n.key, i));
    }
  }
  // coordinates: columns left to right, each centred vertically
  let x = 0;
  for (const c of cols) {
    const w = Math.max(0, ...c.map(n => n.w));
    const total = c.reduce((a, n) => a + n.h, 0) + GAP_Y * Math.max(0, c.length - 1);
    let y = -total / 2;
    for (const n of c) {
      n.x = x + (w - n.w) / 2;
      n.y = y;
      y += n.h + GAP_Y;
    }
    x += w + GAP_X;
  }
  return { back };
}

function laneOrder(n: VNode) { return { in: 0, code: 1, state: 2, out: 3 }[n.lane]; }

/** Two-sided tidy tree for the mind map: callers grow to the left of the centre, callees to the right. */
export function mindmap(v: View) {
  const kids = new Map<string, VNode[]>();
  for (const n of v.nodes) if (n.parentKey) (kids.get(n.parentKey + '|' + n.side) ?? kids.set(n.parentKey + '|' + n.side, []).get(n.parentKey + '|' + n.side)!).push(n);
  const center = v.nodes.find(n => n.key === v.center)!;
  const height = new Map<string, number>();
  const sub = (n: VNode, side: number): number => {
    const ch = kids.get(n.key + '|' + side) ?? [];
    const own = n.h;
    const sum = ch.reduce((a, c) => a + sub(c, side), 0) + GAP_Y * Math.max(0, ch.length - 1);
    const h = Math.max(own, sum);
    height.set(n.key + '|' + side, h);
    return h;
  };
  // column widths per depth and side
  const colW = new Map<string, number>();
  for (const n of v.nodes) if (n.side) colW.set(n.side + ':' + n.depth, Math.max(colW.get(n.side + ':' + n.depth) ?? 0, n.w));
  const xAt = (side: number, depth: number) => {
    let x = side > 0 ? center.w + GAP_X : 0;
    for (let d = 1; d < depth; d++) x += side * ((colW.get(side + ':' + d) ?? 0) + GAP_X);
    return side > 0 ? x : x - (colW.get(side + ':' + depth) ?? 0) - GAP_X;
  };
  center.x = 0;
  center.y = -center.h / 2;
  for (const side of [1, -1]) {
    sub(center, side);
    const place = (n: VNode, top: number) => {
      const ch = kids.get(n.key + '|' + side) ?? [];
      const total = ch.reduce((a, c) => a + height.get(c.key + '|' + side)!, 0) + GAP_Y * Math.max(0, ch.length - 1);
      let y = top + (height.get(n.key + '|' + side)! - total) / 2;
      for (const c of ch) {
        const h = height.get(c.key + '|' + side)!;
        const cw = colW.get(side + ':' + c.depth) ?? c.w;
        c.x = xAt(side, c.depth!) + (side < 0 ? cw - c.w : 0);
        c.y = y + (h - c.h) / 2;
        place(c, y);
        y += h + GAP_Y;
      }
    };
    place(center, -height.get(center.key + '|' + side)! / 2);
  }
}

export function bounds(nodes: VNode[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

export type { VEdge };
