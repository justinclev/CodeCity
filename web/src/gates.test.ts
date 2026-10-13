// Run: node --experimental-strip-types src/gates.test.ts
import assert from 'node:assert/strict';
import { buildGates, byBuilding } from './gates.ts';

const g = {
  version: 1, stats: {} as never,
  nodes: [
    { id: 0, kind: 'endpoint', name: 'GET /orders', parent: -1 },
    { id: 1, kind: 'func', name: 'list', path: 'api/orders.go', start: 10, end: 30, parent: -1 },
    { id: 2, kind: 'io', sub: 'db', name: 'orders', parent: -1 },
    { id: 3, kind: 'io', sub: 'log', name: 'log', parent: -1 },
    { id: 4, kind: 'func', name: 'main', path: 'cmd/main.go', start: 1, end: 5, parent: -1, entry: 'main' },
    { id: 5, kind: 'io', sub: 'http', name: 'users:3000', parent: -1 },
  ],
  edges: [
    { from: 0, to: 1, kind: 'handles', lines: [12] },
    { from: 1, to: 2, kind: 'io', lines: [20] },
    { from: 1, to: 3, kind: 'io', lines: [21] },
    { from: 1, to: 5, kind: 'io', lines: [22] },
  ],
};
const idx = new Map([['api/orders.go', 7], ['cmd/main.go', 3]]);
const gates = buildGates(g as never, p => idx.get(p) ?? -1);
assert.deepEqual(gates.map(x => `${x.dir}:${x.kind}:${x.label}@${x.building}`).sort(),
  ['in:endpoint:GET /orders@7', 'in:entry:main (main)@3', 'out:db:orders@7', 'out:http:users:3000@7'].sort());
assert.equal(gates.find(x => x.kind === 'db')!.line, 20);
assert.equal(byBuilding(gates).get(7)!.length, 3);
console.log('gates: ok');
