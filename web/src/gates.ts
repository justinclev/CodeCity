/** Entrances and exits of a project, from the flow graph: where requests, commands and events enter the code and where it talks to the outside world. */
import type { FlowGraph } from './flow/model';

export interface Gate {
  id: number;            // flow node (the route, command, database ...) to open in the flow view
  dir: 'in' | 'out';
  kind: string;          // endpoint | command | flag | event | env | args | stdin | http | db | storage | process | file | network | request
  label: string;
  building: number;      // the file (building) where the door is
  line?: number;
  code?: number;         // the function behind the door (flow node)
}

const IN = new Set(['endpoint', 'command', 'flag', 'event']);
const IN_IO = new Set(['env', 'args', 'stdin']);
const QUIET = new Set(['log', 'stdio']); // everything writes to the log: not a door worth a marker

export function buildGates(g: FlowGraph, buildingOf: (path: string) => number): Gate[] {
  const out: Gate[] = [];
  const seen = new Set<string>();
  const add = (x: Gate) => {
    if (x.building < 0) return;
    const k = `${x.dir}:${x.id}:${x.building}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x);
  };
  const node = g.nodes;
  for (const e of g.edges) {
    const a = node[e.from], b = node[e.to];
    if (!a || !b) continue;
    // entrances: a route / command / flag / event handled by code, or an input (env, args, stdin) that feeds code
    if ((IN.has(a.kind) || (a.kind === 'io' && IN_IO.has(a.sub ?? ''))) && (e.kind === 'handles' || e.kind === 'feeds' || e.kind === 'call') && b.path) {
      add({ id: a.id, dir: 'in', kind: a.kind === 'io' ? a.sub! : a.kind, label: a.name, building: buildingOf(b.path), line: e.lines?.[0] ?? b.start, code: b.id });
    }
    // exits: code that reaches outside (database, http, files, processes ...) or requests another service's route
    if (a.path && e.kind === 'io' && b.kind === 'io' && !IN_IO.has(b.sub ?? '') && !QUIET.has(b.sub ?? '')) {
      add({ id: b.id, dir: 'out', kind: b.sub ?? 'io', label: b.name, building: buildingOf(a.path), line: e.lines?.[0], code: a.id });
    }
    if (a.path && e.kind === 'request' && b.kind === 'endpoint') {
      add({ id: b.id, dir: 'out', kind: 'request', label: `calls ${b.name}`, building: buildingOf(a.path), line: e.lines?.[0], code: a.id });
    }
  }
  // program entry points (main); a script's top level is not worth a gate
  for (const n of node) {
    if (n.entry === 'main' && n.path) add({ id: n.id, dir: 'in', kind: 'entry', label: `${n.name} (${n.entry})`, building: buildingOf(n.path), line: n.start, code: n.id });
  }
  return out;
}

/** Gates grouped by building. */
export function byBuilding(gates: Gate[]): Map<number, Gate[]> {
  const m = new Map<number, Gate[]>();
  for (const x of gates) {
    const l = m.get(x.building);
    if (l) l.push(x); else m.set(x.building, [x]);
  }
  return m;
}

/** A gate on the edge of a city: one entrance or exit (a route, a table ...) and every file it leads to. */
export interface EdgeGate {
  dir: 'in' | 'out';
  kind: string;
  label: string;
  id: number;            // flow node
  repo: number;
  x: number; z: number;  // on the city's edge
  gates: Gate[];         // the doors behind it, one per file
}

const PLURAL: Record<string, string> = {
  entry: 'entries', endpoint: 'routes', command: 'commands', flag: 'flags', event: 'events', http: 'HTTP hosts', db: 'tables', storage: 'stores', process: 'processes', file: 'files', network: 'connections', request: 'service calls', env: 'variables',
};

export interface Rect { x: number; z: number; w: number; d: number }

/**
 * Put the gates on the edge of their city: entrances on the north side, exits on the south (the same
 * direction the world map flows), each as near as it can be to the files it leads to, then spread so
 * gates never overlap. Deterministic: ordered by position, then name.
 */
export function layoutGates(all: Gate[], repoOf: (building: number) => number, rect: (repo: number) => Rect,
  centre: (building: number) => number, width: number, offset: number): EdgeGate[] {
  const by = new Map<string, EdgeGate>();
  for (const g of all) {
    const repo = repoOf(g.building);
    const key = `${repo}:${g.dir}:${g.id}`;
    let e = by.get(key);
    if (!e) { e = { dir: g.dir, kind: g.kind, label: g.label, id: g.id, repo, x: 0, z: 0, gates: [] }; by.set(key, e); }
    e.gates.push(g);
  }
  let edges = [...by.values()];
  // dozens of DOM events, flags or tables: one gate per kind rather than a wall of arches
  const kinds = new Map<string, EdgeGate[]>();
  for (const e of edges) { const k = `${e.repo}:${e.dir}:${e.kind}`; const l = kinds.get(k); if (l) l.push(e); else kinds.set(k, [e]); }
  for (const list of kinds.values()) {
    if (list.length <= 5) continue;
    const first = list[0];
    const merged: EdgeGate = { dir: first.dir, kind: first.kind, label: `${list.length} ${PLURAL[first.kind] ?? first.kind + 's'}`, id: first.id, repo: first.repo, x: 0, z: 0, gates: [] };
    const seenB = new Set<number>();
    for (const e of list) for (const d of e.gates) if (!seenB.has(d.building)) { seenB.add(d.building); merged.gates.push(d); }
    edges = edges.filter(e => !list.includes(e));
    edges.push(merged);
  }
  const groups = new Map<string, EdgeGate[]>();
  for (const e of edges) {
    const k = `${e.repo}:${e.dir}`;
    const l = groups.get(k);
    if (l) l.push(e); else groups.set(k, [e]);
  }
  const want = (e: EdgeGate) => e.gates.reduce((s, g) => s + centre(g.building), 0) / e.gates.length;
  for (const list of groups.values()) {
    const r = rect(list[0].repo);
    list.sort((a, b) => want(a) - want(b) || a.label.localeCompare(b.label));
    const gap = width * 1.5;
    const xs = list.map(e => Math.min(r.x + r.w - width / 2, Math.max(r.x + width / 2, want(e))));
    for (let k = 1; k < xs.length; k++) xs[k] = Math.max(xs[k], xs[k - 1] + gap);
    const over = xs.length ? xs[xs.length - 1] - (r.x + r.w - width / 2) : 0;
    if (over > 0) { // too many for the edge: shift left, then squeeze evenly if it still does not fit
      for (let k = xs.length - 1; k >= 0; k--) xs[k] = Math.min(xs[k], r.x + r.w - width / 2 - (xs.length - 1 - k) * gap);
      if (xs[0] < r.x + width / 2) {
        const step = xs.length > 1 ? (r.w - width) / (xs.length - 1) : 0;
        for (let k = 0; k < xs.length; k++) xs[k] = r.x + width / 2 + k * step;
      }
    }
    list.forEach((e, k) => {
      e.x = xs[k];
      e.z = e.dir === 'in' ? r.z - offset : r.z + r.d + offset;
    });
  }
  return edges.sort((a, b) => a.repo - b.repo || (a.dir === b.dir ? a.x - b.x : a.dir === 'in' ? -1 : 1));
}

/** One stop on a route through the code. */
export interface RouteStep {
  kind: 'enter' | 'code' | 'out';
  label: string;          // short title: the route, the function, the table ...
  detail: string;         // one line: what happens here
  building: number;
  line?: number;
  node: number;           // flow node: the function (code), or the route / table (enter, out)
}

const CALLS = new Set(['call', 'new', 'ref']);

/**
 * Follow the code from an entrance: the handler, then what it calls in the order the calls appear, and each
 * way out it reaches. Stops are per file: a function is its own stop only when it leaves the previous file or
 * reaches outside; helpers in the same file are walked through but not announced.
 */
export function traceRoute(g: FlowGraph, door: Gate, buildingOf: (path: string) => number, maxSteps = 18, maxDepth = 6): RouteStep[] {
  const node = g.nodes;
  const out: FEdgeLike[][] = node.map(() => []);
  for (const e of g.edges) out[e.from]?.push(e);
  for (const l of out) l.sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0));

  const steps: RouteStep[] = [];
  const seen = new Set<number>();
  const entry = node[door.id];
  if (entry) steps.push({ kind: 'enter', label: entry.name, detail: `${door.kind === 'endpoint' ? 'request arrives' : door.kind === 'entry' ? 'program starts' : door.kind + ' comes in'}`, building: door.building, line: door.line, node: door.id });
  let lastBuilding = door.building;

  const visit = (id: number, depth: number, via?: FEdgeLike) => {
    if (seen.has(id) || steps.length >= maxSteps) return;
    seen.add(id);
    const f = node[id];
    if (!f?.path) return;
    const b = buildingOf(f.path);
    const exits = out[id].filter(e => (e.kind === 'io' && !QUIET.has(node[e.to]?.sub ?? '') && !IN_IO.has(node[e.to]?.sub ?? '')) || (e.kind === 'request' && node[e.to]?.kind === 'endpoint') || e.kind === 'writes');
    if (b >= 0 && (b !== lastBuilding || exits.length > 0 || steps.length === 1)) {
      steps.push({ kind: 'code', label: f.name, detail: via ? `called at line ${via.lines?.[0] ?? '?'}` : 'handles it', building: b, line: f.start, node: id });
      lastBuilding = b;
    }
    for (const e of exits) {
      const t = node[e.to];
      if (!t || steps.length >= maxSteps) continue;
      const nm = e.kind === 'request' ? `calls ${t.name}` : t.name;
      steps.push({ kind: 'out', label: nm, detail: e.kind === 'writes' ? `writes ${t.name}` : e.kind === 'request' ? 'calls another service' : `reaches ${t.sub ?? 'outside'} (${e.label ?? 'access'})`, building: b >= 0 ? b : lastBuilding, line: e.lines?.[0], node: e.to });
    }
    if (depth >= maxDepth) return;
    for (const e of out[id]) if (CALLS.has(e.kind) && node[e.to]?.path) visit(e.to, depth + 1, e);
  };
  if (door.code !== undefined) visit(door.code, 0);
  return steps.filter(s => s.building >= 0);
}

type FEdgeLike = { from: number; to: number; kind: string; label?: string; lines?: number[] };
