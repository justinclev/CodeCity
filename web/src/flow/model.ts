/** Flow graph from /api/flow, and the three views built from it: system map, module, mind map around one node. */

export interface FNode {
  id: number; kind: string; sub?: string; name: string; path?: string; start?: number; end?: number; module?: string;
  parent: number; lang?: string; exported?: boolean; test?: boolean; entry?: string;
}
export interface FEdge { from: number; to: number; kind: string; label?: string; lines?: number[]; exact?: boolean; file?: string }
export interface FlowGraph {
  version: number; nodes: FNode[]; edges: FEdge[];
  stats: { files: number; functions: number; calls: number; exact: number; byName: number; languages: Record<string, number>; truncated?: boolean };
  commits?: Record<string, string>;
}

export interface Filters { state: boolean; effects: boolean; tests: boolean; guesses: boolean }

export type Lane = 'in' | 'code' | 'state' | 'out';

/** A box in the drawing: one graph node, or a group of them. */
export interface VNode {
  key: string; label: string; sub: string; lane: Lane; kind: string; glyph: string;
  node?: number;        // graph node it stands for
  group?: string;       // module group (system map)
  members?: number[];   // grouped graph nodes
  ghost?: boolean;      // already shown elsewhere in the mind map
  side?: -1 | 0 | 1;    // mind map: left / centre / right
  depth?: number;
  parentKey?: string;
  more?: { left: number; right: number }; // hidden neighbours (expand knobs)
  w: number; h: number; x: number; y: number;
}
export interface VEdge { key: string; from: string; to: string; kind: string; count: number; exact: boolean; edges: FEdge[] }
export interface View { kind: 'map' | 'module' | 'focus'; title: string; nodes: VNode[]; edges: VEdge[]; note?: string; center?: string }

const CODE = new Set(['func', 'method', 'class']);
const INPUTS = new Set(['endpoint', 'command', 'flag', 'event']);

export const KIND_LABEL: Record<string, string> = {
  func: 'function', method: 'method', class: 'type', endpoint: 'HTTP route', command: 'CLI command', flag: 'CLI flag', event: 'event',
  io: 'outside world', data: 'state', module: 'module', group: 'group',
};
export const EDGE_LABEL: Record<string, string> = {
  call: 'calls', new: 'creates', ref: 'passes as callback', impl: 'implemented by', handles: 'handled by', feeds: 'read by',
  writes: 'writes', io: 'talks to', request: 'requests',
};

export const IO_GLYPH: Record<string, string> = {
  process: 'proc', file: 'file', http: 'http', db: 'db', storage: 'store', env: 'env', stdio: 'out', log: 'log', network: 'net', args: 'args', stdin: 'in',
};

export class FlowModel {
  readonly nodes: FNode[];
  readonly out: FEdge[][];
  readonly inn: FEdge[][];
  /** io nodes that feed code (inputs), as opposed to sinks / systems (outputs) */
  readonly source: boolean[];
  filters: Filters = { state: true, effects: true, tests: false, guesses: true };

  constructor(readonly g: FlowGraph) {
    this.nodes = g.nodes;
    this.out = g.nodes.map(() => []);
    this.inn = g.nodes.map(() => []);
    for (const e of g.edges) { this.out[e.from].push(e); this.inn[e.to].push(e); }
    this.source = g.nodes.map(n => n.kind === 'io' && this.out[n.id].some(e => e.kind === 'feeds') && !this.inn[n.id].length);
  }

  lane(n: FNode): Lane {
    if (INPUTS.has(n.kind)) return 'in';
    if (n.kind === 'io') return this.source[n.id] ? 'in' : 'out';
    if (n.kind === 'data') return 'state';
    return 'code';
  }

  isCode(n: FNode) { return CODE.has(n.kind); }

  nodeVisible(n: FNode) {
    if (n.test && !this.filters.tests) return false;
    if (n.kind === 'data' && !this.filters.state) return false;
    if (n.kind === 'io' && !this.filters.effects) return false;
    return true;
  }

  edgeVisible(e: FEdge) {
    if (!this.filters.guesses && e.kind === 'call' && !e.exact) return false;
    return this.nodeVisible(this.nodes[e.from]) && this.nodeVisible(this.nodes[e.to]);
  }

  /** Commit a node's file was analyzed at (for fetching its source). */
  commitFor(path: string): string | null {
    const c = this.g.commits ?? {};
    if (c[''] !== undefined) return c[''];
    let best = '';
    for (const p of Object.keys(c)) if (path.startsWith(p) && p.length > best.length) best = p;
    return best ? c[best] : null;
  }

  // ------------------------------------------------------------------ labels

  glyph(n: FNode): string {
    switch (n.kind) {
      case 'endpoint': return n.sub && n.sub !== 'ANY' ? n.sub : 'ANY';
      case 'command': return 'cmd';
      case 'flag': return 'flag';
      case 'event': return n.sub === 'timer' ? 'tick' : n.sub === 'task' ? 'task' : 'event';
      case 'io': return IO_GLYPH[n.sub ?? ''] ?? 'ext';
      case 'data': return 'state';
      case 'class': return n.sub === 'interface' ? 'iface' : n.sub ?? 'type';
      case 'method': return n.sub === 'abstract' ? 'abs' : 'm';
      default: return n.entry === 'main' ? 'main' : n.sub === 'module' ? 'top' : n.sub === 'closure' ? 'λ' : 'fn';
    }
  }

  label(n: FNode): string {
    if (n.kind === 'endpoint' && n.sub && n.sub !== 'ANY') return n.name.slice(n.sub.length + 1);
    return n.name;
  }

  where(n: FNode): string {
    if (!n.path) {
      switch (n.kind) {
        case 'io': return ({ process: 'runs a program', file: 'filesystem', http: 'HTTP', db: 'database table', storage: 'browser storage', env: 'environment',
          stdio: 'console', log: 'log', network: 'network', args: 'command line', stdin: 'standard input' } as Record<string, string>)[n.sub ?? ''] ?? 'outside world';
        case 'endpoint': return 'HTTP route';
        case 'command': return 'CLI command';
        case 'flag': return 'CLI flag';
        case 'event': return n.sub === 'timer' ? 'timer' : n.sub === 'task' ? 'background task' : 'UI event';
      }
      return KIND_LABEL[n.kind] ?? n.kind;
    }
    const file = n.path.split('/').pop();
    return n.start ? `${file}:${n.start}` : file ?? '';
  }

  // ------------------------------------------------------------------ search

  search(q: string, limit = 40): FNode[] {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const scored: [number, FNode][] = [];
    for (const n of this.nodes) {
      if (n.test && !this.filters.tests) continue;
      const name = n.name.toLowerCase();
      const i = name.indexOf(q);
      if (i < 0 && !(n.path ?? '').toLowerCase().includes(q)) continue;
      const short = name.split(/[.:]+/).pop() ?? name;
      let s = i < 0 ? 50 : short === q ? 0 : short.startsWith(q) ? 5 : name.startsWith(q) ? 8 : 20;
      if (!this.isCode(n) && n.kind !== 'data') s -= 2; // routes, events, outside world: usually what you are after
      if (n.sub === 'module') s += 15; // a file's top-level code is rarely what you mean
      s += Math.min(10, name.length / 10) - Math.min(6, (this.out[n.id].length + this.inn[n.id].length) / 6);
      scored.push([s, n]);
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(x => x[1]);
  }

  // ------------------------------------------------------------------ system map

  /**
   * Module groups for the system map: start from top-level directories and keep splitting the biggest group into
   * its subdirectories while it holds more than ~12% of the code and there is room (≤ 32 groups).
   * Returns the number of groups (the argument of groupOf is kept for call-site compatibility).
   */
  private groups: Map<string, string> | null = null;
  groupDepth(): number {
    const count = new Map<string, number>();
    for (const n of this.nodes) if (this.isCode(n) && !n.test) count.set(n.module ?? '', (count.get(n.module ?? '') ?? 0) + 1);
    const mods = [...count.keys()];
    const total = [...count.values()].reduce((a, b) => a + b, 0) || 1;
    const seg = (m: string, k: number) => m.split('/').slice(0, k).join('/');
    // a group: prefix + depth; modules exactly equal to a split prefix stay together as "prefix (files)"
    type G = { key: string; prefix: string; depth: number; exact: boolean; mods: string[]; size: number };
    const make = (prefix: string, depth: number, exact: boolean, ms: string[]): G =>
      ({ key: exact ? prefix + ' (files)' : prefix, prefix, depth, exact, mods: ms, size: ms.reduce((a, m) => a + count.get(m)!, 0) });
    const byTop = new Map<string, string[]>();
    for (const m of mods) { const t = seg(m, 1); (byTop.get(t) ?? byTop.set(t, []).get(t)!).push(m); }
    let groups: G[] = [...byTop].map(([t, ms]) => make(t, 1, false, ms));
    for (let guard = 0; guard < 64; guard++) {
      const big = groups.filter(g => !g.exact && g.size > total * 0.12).sort((a, b) => b.size - a.size)[0];
      if (!big) break;
      const kids = new Map<string, string[]>();
      const exact: string[] = [];
      for (const m of big.mods) {
        if (m.split('/').length <= big.depth) exact.push(m);
        else { const c = seg(m, big.depth + 1); (kids.get(c) ?? kids.set(c, []).get(c)!).push(m); }
      }
      const split = [...kids].map(([c, ms]) => make(c, big.depth + 1, false, ms));
      if (exact.length) split.push(make(big.prefix, big.depth, true, exact));
      if (split.length < 2 || groups.length - 1 + split.length > 32) { big.exact = true; big.key = big.prefix; continue; } // can't split usefully
      groups = groups.filter(g => g !== big).concat(split);
    }
    this.groups = new Map();
    for (const g of groups) for (const m of g.mods) this.groups.set(m, g.key);
    return groups.length;
  }

  groupOf(n: FNode, _k?: number): string {
    if (!this.groups) this.groupDepth();
    return this.groups!.get(n.module ?? '') ?? (n.module ?? '');
  }

  systemMap(): View {
    const k = this.groupDepth();
    const nodes = new Map<string, VNode>();
    const counts = new Map<string, { fns: number; state: number; inner: number }>();
    const key = (n: FNode): string | null => {
      if (!this.nodeVisible(n)) return null;
      const lane = this.lane(n);
      if (lane === 'code' || lane === 'state') {
        const g = this.groupOf(n, k);
        return 'g:' + g;
      }
      return this.inputOutputKey(n);
    };
    const ensure = (k2: string, n: FNode) => {
      let v = nodes.get(k2);
      if (!v) {
        v = this.groupNode(k2, n);
        nodes.set(k2, v);
      }
      v.members ??= [];
      if (!v.members.includes(n.id)) v.members.push(n.id);
      return v;
    };
    for (const n of this.nodes) {
      const k2 = key(n);
      if (!k2) continue;
      if (this.isCode(n)) {
        const c = counts.get(k2) ?? { fns: 0, state: 0, inner: 0 };
        if (n.kind !== 'class') c.fns++;
        counts.set(k2, c);
      } else if (n.kind === 'data') {
        const c = counts.get(k2) ?? { fns: 0, state: 0, inner: 0 };
        c.state++;
        counts.set(k2, c);
        continue; // state stays inside its module on the map
      }
      // only inputs / outputs that touch something
      if (!this.isCode(n) && !this.out[n.id].length && !this.inn[n.id].length) continue;
      ensure(k2, n);
    }
    const edges = new Map<string, VEdge>();
    for (const e of this.g.edges) {
      if (!this.edgeVisible(e)) continue;
      const a = this.nodes[e.from], b = this.nodes[e.to];
      if (a.kind === 'data' || b.kind === 'data') continue;
      const ka = key(a), kb = key(b);
      if (!ka || !kb || !nodes.has(ka) || !nodes.has(kb)) continue;
      if (ka === kb) { const c = counts.get(ka); if (c) c.inner++; continue; }
      const kind = e.kind === 'new' || e.kind === 'ref' || e.kind === 'impl' ? 'call' : e.kind;
      const ek = ka + '>' + kb + ':' + kind;
      const ve = edges.get(ek) ?? { key: ek, from: ka, to: kb, kind, count: 0, exact: true, edges: [] };
      ve.count++;
      ve.exact = ve.exact && e.exact !== false && !(e.kind === 'call' && !e.exact);
      if (ve.edges.length < 400) ve.edges.push(e);
      edges.set(ek, ve);
    }
    for (const [k2, v] of nodes) {
      const c = counts.get(k2);
      if (c && k2.startsWith('g:')) {
        const parts = [`${c.fns} function${c.fns === 1 ? '' : 's'}`];
        if (c.state) parts.push(`${c.state} state`);
        v.sub = parts.join(', ');
      }
    }
    // drop code groups with no edges at all when the map is crowded
    const touched = new Set<string>();
    for (const e of edges.values()) { touched.add(e.from); touched.add(e.to); }
    const list = [...nodes.values()].filter(v => touched.has(v.key) || (nodes.size < 24 && v.lane === 'code'));
    return { kind: 'map', title: 'System', nodes: list, edges: [...edges.values()] };
  }

  /** Inputs and outputs: individual, or grouped when there are many of a kind. */
  private ioGroups: Map<string, string> | null = null;
  inputOutputKey(n: FNode): string {
    if (!this.ioGroups) {
      this.ioGroups = new Map();
      const by = (pred: (n: FNode) => boolean) => this.nodes.filter(x => pred(x) && (this.out[x.id].length || this.inn[x.id].length));
      const endpoints = by(n => n.kind === 'endpoint');
      if (endpoints.length > 14) {
        for (const ep of endpoints) {
          const p = this.label(ep).split('/').filter(Boolean);
          this.ioGroups.set(String(ep.id), 'routes /' + p.slice(0, Math.min(2, p.length - 1 || 1)).join('/') + (p.length > 1 ? '/…' : ''));
        }
      }
      const cmds = by(n => n.kind === 'command');
      if (cmds.length > 12) for (const c of cmds) this.ioGroups.set(String(c.id), 'CLI commands');
      for (const f of by(n => n.kind === 'flag')) this.ioGroups.set(String(f.id), 'CLI flags');
      for (const e of by(n => n.kind === 'event')) this.ioGroups.set(String(e.id), e.sub === 'timer' ? 'timers' : e.sub === 'task' ? 'background tasks' : 'UI events');
      for (const sub of ['db', 'http', 'storage']) {
        const list = by(n => n.kind === 'io' && n.sub === sub);
        if (list.length > 10) for (const x of list) this.ioGroups.set(String(x.id), sub === 'db' ? 'database tables' : sub === 'http' ? 'HTTP services' : 'browser storage');
      }
    }
    const g = this.ioGroups.get(String(n.id));
    return g ? 'grp:' + this.lane(n) + ':' + g : 'n:' + n.id;
  }

  private groupNode(key: string, n: FNode): VNode {
    if (key.startsWith('g:')) {
      const g = key.slice(2);
      return { key, label: g || '(root)', sub: '', lane: 'code', kind: 'module', glyph: 'mod', group: g, members: [], w: 0, h: 0, x: 0, y: 0 };
    }
    if (key.startsWith('grp:')) {
      const rest = key.slice(4);
      const lane = rest.slice(0, rest.indexOf(':')), name = rest.slice(rest.indexOf(':') + 1);
      return { key, label: name, sub: '', lane: lane as Lane, kind: 'group-' + n.kind + (n.sub ? ' ' + n.sub : ''), glyph: this.glyph(n), members: [], w: 0, h: 0, x: 0, y: 0 };
    }
    return this.vnode(n, key);
  }

  vnode(n: FNode, key = 'n:' + n.id): VNode {
    return { key, label: this.label(n), sub: this.where(n), lane: this.lane(n), kind: n.kind + (n.sub ? ' ' + n.sub : ''), glyph: this.glyph(n), node: n.id, w: 0, h: 0, x: 0, y: 0 };
  }

  // ------------------------------------------------------------------ module view

  moduleView(group: string, depth: number, max = 70): View {
    const inside = (n: FNode) => this.isCode(n) && this.nodeVisible(n) && this.groupOf(n, depth) === group;
    const members = this.nodes.filter(inside);
    const deg = (n: FNode) => this.out[n.id].filter(e => this.edgeVisible(e)).length + this.inn[n.id].filter(e => this.edgeVisible(e)).length;
    let shown = members.filter(n => deg(n) > 0 && !(n.kind === 'class' && !this.inn[n.id].some(e => e.kind === 'new')));
    let note = '';
    if (shown.length > max) {
      // keep what connects the module to the rest, then the busiest
      const ext = (n: FNode) => [...this.out[n.id], ...this.inn[n.id]].some(e => !inside(this.nodes[e.from === n.id ? e.to : e.from]));
      shown.sort((a, b) => Number(ext(b)) - Number(ext(a)) || deg(b) - deg(a));
      note = `${shown.length - max} more functions in this module are not drawn — find them with search.`;
      shown = shown.slice(0, max);
    }
    const shownIds = new Set(shown.map(n => n.id));
    const nodes = new Map<string, VNode>();
    for (const n of shown) nodes.set('n:' + n.id, this.vnode(n));
    const edges = new Map<string, VEdge>();
    const k = depth;
    const outsideKey = (n: FNode, side: 'in' | 'out'): string | null => {
      if (!this.nodeVisible(n)) return null;
      if (this.isCode(n)) {
        const g = this.groupOf(n, k);
        const key = `x:${side}:${g}`;
        if (!nodes.has(key)) {
          nodes.set(key, { key, label: g || '(root)', sub: side === 'in' ? 'calls in' : 'called', lane: side === 'in' ? 'in' : 'out', kind: 'module outside', glyph: 'mod', group: g, members: [], w: 0, h: 0, x: 0, y: 0 });
        }
        return key;
      }
      if (n.kind === 'data') {
        if (!this.filters.state) return null;
        const key = 'n:' + n.id;
        if (!nodes.has(key)) nodes.set(key, this.vnode(n));
        return key;
      }
      const key = 'n:' + n.id;
      if (!nodes.has(key)) nodes.set(key, this.vnode(n));
      return key;
    };
    const add = (from: string, to: string, e: FEdge) => {
      const kind = e.kind === 'new' || e.kind === 'ref' ? 'call' : e.kind;
      const ek = from + '>' + to + ':' + kind;
      const ve = edges.get(ek) ?? { key: ek, from, to, kind, count: 0, exact: true, edges: [] };
      ve.count++;
      ve.exact = ve.exact && !(e.kind === 'call' && !e.exact);
      ve.edges.push(e);
      edges.set(ek, ve);
    };
    for (const n of shown) {
      for (const e of this.out[n.id]) {
        if (!this.edgeVisible(e)) continue;
        const t = this.nodes[e.to];
        if (shownIds.has(t.id)) { add('n:' + n.id, 'n:' + t.id, e); continue; }
        if (inside(t)) continue;
        const key = outsideKey(t, 'out');
        if (key) add('n:' + n.id, key, e);
      }
      for (const e of this.inn[n.id]) {
        if (!this.edgeVisible(e)) continue;
        const s = this.nodes[e.from];
        if (shownIds.has(s.id) || inside(s)) continue;
        const key = outsideKey(s, 'in');
        if (key) add(key, 'n:' + n.id, e);
      }
    }
    for (const v of nodes.values()) {
      if (v.members) v.sub = `${new Set([...edges.values()].filter(e => e.from === v.key || e.to === v.key).flatMap(e => e.edges.map(x => v.lane === 'in' ? x.from : x.to))).size} functions`;
    }
    return { kind: 'module', title: group ? group + '/' : '(root)', nodes: [...nodes.values()], edges: [...edges.values()], note };
  }

  // ------------------------------------------------------------------ mind map

  /** Neighbours of n on one side of the mind map: right = where the flow goes next, left = where it comes from. */
  neighbours(id: number, side: 1 | -1): { node: number; edge: FEdge }[] {
    const n = this.nodes[id];
    const out: { node: number; edge: FEdge }[] = [];
    if (side === 1) {
      for (const e of this.out[id]) if (this.edgeVisible(e)) out.push({ node: e.to, edge: e });
      // an interface method also leads to its implementations (already "impl" out-edges); a class leads to its methods' callers? no
      void n;
    } else {
      for (const e of this.inn[id]) if (this.edgeVisible(e)) out.push({ node: e.from, edge: e });
    }
    const order = (k: string) => ['handles', 'request', 'call', 'impl', 'new', 'ref', 'feeds', 'writes', 'io'].indexOf(k);
    const seen = new Set<number>();
    return out.filter(x => !seen.has(x.node) && seen.add(x.node))
      .sort((a, b) => order(a.edge.kind) - order(b.edge.kind) || (a.edge.lines?.[0] ?? 0) - (b.edge.lines?.[0] ?? 0));
  }

  /**
   * Mind map around center. expanded holds "side:id" for nodes whose branch is open; the centre is always open.
   * Each graph node is drawn once per side; later occurrences are ghosts that can be clicked to jump.
   */
  focus(center: number, expanded: Set<string>, limit = 180): View {
    const nodes: VNode[] = [];
    const edges: VEdge[] = [];
    const c = this.vnode(this.nodes[center], 'c:' + center);
    c.side = 0; c.depth = 0;
    nodes.push(c);
    let count = 1;
    let truncated = false;
    for (const side of [1, -1] as const) {
      const placed = new Set<number>([center]);
      let frontier: VNode[] = [c];
      for (let depth = 1; frontier.length && depth < 12; depth++) {
        const next: VNode[] = [];
        for (const parent of frontier) {
          const pid = parent.node!;
          const open = parent === c || expanded.has(`${side}:${pid}`);
          const nb = this.neighbours(pid, side);
          if (!open) {
            if (nb.length) parent.more = { ...(parent.more ?? { left: 0, right: 0 }), [side === 1 ? 'right' : 'left']: nb.length };
            continue;
          }
          for (const { node, edge } of nb) {
            if (count >= limit) { truncated = true; break; }
            const ghost = placed.has(node);
            const v = this.vnode(this.nodes[node], `${side}:${depth}:${pid}:${node}`);
            v.side = side; v.depth = depth; v.parentKey = parent.key; v.ghost = ghost;
            nodes.push(v);
            count++;
            const from = side === 1 ? parent.key : v.key, to = side === 1 ? v.key : parent.key;
            edges.push({ key: from + '>' + to, from, to, kind: edge.kind, count: 1, exact: !(edge.kind === 'call' && !edge.exact), edges: [edge] });
            if (!ghost) { placed.add(node); next.push(v); }
          }
        }
        frontier = next;
      }
    }
    const n = this.nodes[center];
    return { kind: 'focus', title: n.name, nodes, edges, center: c.key,
      note: truncated ? `Showing the first ${limit} boxes — collapse a branch or lower the depth to see others.` : undefined };
  }

  /** Expand the right side to depth d (and the left side to dl) from center. */
  autoExpand(center: number, d: number, dl: number, expanded: Set<string>, budget = 150) {
    for (const [side, depth] of [[1, d], [-1, dl]] as const) {
      let frontier = [center];
      const seen = new Set([center]);
      let used = 0;
      for (let k = 1; k < depth; k++) {
        const next: number[] = [];
        for (const id of frontier) {
          for (const { node } of this.neighbours(id, side)) {
            if (seen.has(node)) continue;
            seen.add(node);
            const n = this.nodes[node];
            if (n.kind === 'io' || n.kind === 'class') continue; // leaves
            used += this.neighbours(node, side).length;
            if (used > budget) return;
            expanded.add(`${side}:${node}`);
            next.push(node);
          }
        }
        frontier = next;
      }
    }
  }
}
