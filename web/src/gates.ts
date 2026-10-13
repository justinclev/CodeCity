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
