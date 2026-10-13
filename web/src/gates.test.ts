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

import { layoutGates } from './gates.ts';
{
  const mk = (id: number, dir: 'in' | 'out', building: number) => ({ id, dir, kind: 'x', label: 'g' + id, building, code: 0 });
  const gs = [mk(1, 'in', 0), mk(2, 'in', 1), mk(2, 'in', 2), mk(3, 'out', 2), mk(4, 'in', 3)];
  const cx = [10, 30, 50, 90];
  const eg = layoutGates(gs, () => 0, () => ({ x: 0, z: 100, w: 100, d: 60 }), b => cx[b], 6, 4);
  assert.equal(eg.length, 4); // node 2 is one gate with two doors
  assert.equal(eg.find(e => e.id === 2)!.gates.length, 2);
  for (const e of eg) assert.ok(e.x >= 3 && e.x <= 97);
  const ins = eg.filter(e => e.dir === 'in').sort((a, b) => a.x - b.x);
  for (let k = 1; k < ins.length; k++) assert.ok(ins[k].x - ins[k - 1].x >= 9 - 1e-9);
  assert.ok(eg.filter(e => e.dir === 'in').every(e => e.z === 96));
  assert.ok(eg.filter(e => e.dir === 'out').every(e => e.z === 164));
  const again = layoutGates([...gs].reverse(), () => 0, () => ({ x: 0, z: 100, w: 100, d: 60 }), b => cx[b], 6, 4);
  assert.deepEqual(again.map(e => [e.id, e.x, e.z]), eg.map(e => [e.id, e.x, e.z]));
  console.log('layoutGates: ok');
}
