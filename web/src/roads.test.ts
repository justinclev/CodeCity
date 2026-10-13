// Run: node --experimental-strip-types src/roads.test.ts
import assert from 'node:assert/strict';
import { rim, segHits, route, type Rect } from './roads.ts';

const R = (x: number, z: number, w = 10, d = 10): Rect => ({ x, z, w, d });

assert.deepEqual(rim(R(0, 0), 100, 5), [10, 5]);
assert.ok(segHits([-5, 5], [15, 5], R(0, 0), 0));
assert.ok(!segHits([-5, 20], [15, 20], R(0, 0), 0));
assert.ok(segHits([-5, 12], [15, 12], R(0, 0), 3));
assert.ok(!segHits([-5, 12], [15, 12], R(0, 0), 1));

// straight when nothing is in the way
let p = route(R(0, 0), R(50, 0), [], 1);
assert.equal(p.length, 2);
assert.deepEqual(p[0], [10, 5]);
assert.deepEqual(p[1], [50, 5]);

// L-shape around a blocker on the straight line
p = route(R(0, 0), R(50, 40), [R(25, 20, 10, 10)], 1);
assert.equal(p.length, 3);

// boxed in: a row of cities forces a dog-leg
p = route(R(0, 0), R(100, 0), [R(40, -30, 20, 70)], 1);
assert.equal(p.length, 4);
for (let k = 1; k < p.length; k++) assert.ok(!segHits(p[k - 1], p[k], R(40, -30, 20, 70), 1));
console.log('roads: ok');
