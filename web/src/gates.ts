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
  // CLI / program entry points (main, top level of a script)
  for (const n of node) {
    if (n.entry && n.path) add({ id: n.id, dir: 'in', kind: 'entry', label: `${n.name} (${n.entry})`, building: buildingOf(n.path), line: n.start, code: n.id });
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
  const edges = [...by.values()];
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
