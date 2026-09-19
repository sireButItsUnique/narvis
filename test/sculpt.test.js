import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sculptGeometry, buildModelGroup } from '../public/js/builder.js';
import { beginPull, applyPull, revertPull, smoothAt, ensureSculptable } from '../public/js/sculpt.js';

const PARTS = [
  { name: 'box', shape: 'box', dims: [10, 4, 6], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'ball', shape: 'sphere', dims: [5], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'can', shape: 'cylinder', dims: [3, 3, 12], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'hat', shape: 'cone', dims: [4, 9], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'ring', shape: 'torus', dims: [4, 1, 360], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'arch', shape: 'torus', dims: [4, 1, 180], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'pill', shape: 'capsule', dims: [2, 6], points: [], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'vase', shape: 'lathe', dims: [], points: [[0, 0], [4, 0], [5, 8], [3, 14]], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
  { name: 'star', shape: 'extrude', dims: [1], points: [[0, 5], [1.2, 1.6], [4.8, 1.5], [1.9, -0.6], [2.9, -4], [0, -2], [-2.9, -4], [-1.9, -0.6], [-4.8, 1.5], [-1.2, 1.6]], position: [0, 0, 0], rotation: [0, 0, 0], color: '#ffffff' },
];

for (const part of PARTS) {
  test(`${part.shape} (${part.name}): dense, welded, deterministic`, () => {
    const a = sculptGeometry(part), b = sculptGeometry(part);
    const n = a.attributes.position.count;
    assert.ok(n >= 1000 && n <= 60000, `vertex count ${n}`);
    assert.ok(a.index, 'indexed');
    assert.equal(b.attributes.position.count, n, 'same vertex count every time');
    assert.deepEqual(Array.from(b.attributes.position.array.slice(0, 300)), Array.from(a.attributes.position.array.slice(0, 300)));
  });
}

test('closed shapes are watertight after welding (every edge shared by exactly two triangles)', () => {
  for (const part of PARTS.filter(p => ['box', 'ball', 'can', 'ring', 'pill'].includes(p.name))) {
    const idx = sculptGeometry(part).index.array, edges = new Map();
    for (let i = 0; i < idx.length; i += 3) {
      for (const [a, b] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
        if (a === b) continue;   // degenerate sliver at a pole
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
    const open = [...edges.values()].filter(c => c !== 2).length;
    assert.equal(open, 0, `${part.name}: ${open} edges not shared by exactly two triangles`);
  }
});

const meshFor = part => {
  const m = new THREE.Mesh(sculptGeometry(part), new THREE.MeshBasicMaterial());
  m.userData.sculptable = true;
  m.updateMatrix();
  return m;
};
const vert = (m, i) => new THREE.Vector3().fromBufferAttribute(m.geometry.attributes.position, i);
const nearest = (m, p) => {
  let best = 0, d = Infinity;
  for (let i = 0; i < m.geometry.attributes.position.count; i++) { const q = vert(m, i).distanceTo(p); if (q < d) { d = q; best = i; } }
  return best;
};

test('pull moves the brush centre by the full delta, leaves far vertices alone, and reverts exactly', () => {
  const m = meshFor(PARTS[0]);   // box 10 x 4 x 6, top face at y = 2
  const top = nearest(m, new THREE.Vector3(0, 2, 0)), far = nearest(m, new THREE.Vector3(5, -2, 3));
  const before = m.geometry.attributes.position.array.slice();
  const s = beginPull(m, vert(m, top), 2, false);
  applyPull(s, new THREE.Vector3(0, 3, 0));
  assert.ok(Math.abs(vert(m, top).y - 5) < 1e-4, 'centre pulled up by 3');
  assert.deepEqual(vert(m, far).toArray(), Array.from(before.slice(far * 3, far * 3 + 3)), 'far corner untouched');
  applyPull(s, new THREE.Vector3(0, 1, 0));   // deltas are from the stroke start, not cumulative
  assert.ok(Math.abs(vert(m, top).y - 3) < 1e-4);
  revertPull(s);
  assert.deepEqual(Array.from(m.geometry.attributes.position.array), Array.from(before));
});

test('mirror pulls the matching spot on the other side, mirrored in x', () => {
  const m = meshFor(PARTS[0]);
  const right = nearest(m, new THREE.Vector3(3, 2, 0)), left = nearest(m, new THREE.Vector3(-3, 2, 0));
  const r0 = vert(m, right), l0 = vert(m, left);
  const s = beginPull(m, r0, 1.5, 0);   // mirror plane at x = 0
  applyPull(s, new THREE.Vector3(1, 2, 0));
  assert.ok(vert(m, right).distanceTo(r0.clone().add(new THREE.Vector3(1, 2, 0))) < 1e-4);
  assert.ok(vert(m, left).distanceTo(l0.clone().add(new THREE.Vector3(-1, 2, 0))) < 1e-4);
});

test('mirror uses the model\'s centre line, not the middle of its bounding box', () => {
  // a 10 cm-wide box whose centre line (spec x = 0) sits at x = 2 in the model's space
  const m = meshFor(PARTS[0]);
  const at = nearest(m, new THREE.Vector3(4, 2, 0)), mirrorOf = nearest(m, new THREE.Vector3(0, 2, 0));
  const a0 = vert(m, at), b0 = vert(m, mirrorOf), untouched = vert(m, nearest(m, new THREE.Vector3(-4, 2, 0)));
  const s = beginPull(m, a0, 1.5, 2);
  applyPull(s, new THREE.Vector3(0, 1, 0));
  assert.ok(vert(m, at).y - a0.y > 0.99, 'brushed spot moved');
  assert.ok(vert(m, mirrorOf).y - b0.y > 0.99, 'its mirror across x = 2 moved');
  assert.ok(Math.abs(vert(m, nearest(m, new THREE.Vector3(-4, 2, 0))).y - untouched.y) < 1e-6, 'the bounding-box mirror (x = -4) did not');
});

test('mirror off (null or false) leaves the other side alone', () => {
  for (const off of [null, false]) {
    const m = meshFor(PARTS[0]);
    const left = nearest(m, new THREE.Vector3(-3, 2, 0)), l0 = vert(m, left);
    applyPull(beginPull(m, vert(m, nearest(m, new THREE.Vector3(3, 2, 0))), 1.5, off), new THREE.Vector3(0, 2, 0));
    assert.ok(vert(m, left).distanceTo(l0) < 1e-6, String(off));
  }
});

test('pull respects the part\'s own rotation inside the model', () => {
  const m = meshFor(PARTS[0]);
  m.rotation.z = Math.PI / 2;   // the part lies on its side inside the model
  m.updateMatrix();
  const localTop = nearest(m, new THREE.Vector3(0, 2, 0));
  const inModel = vert(m, localTop).applyMatrix4(m.matrix);
  const s = beginPull(m, inModel, 2, false);
  applyPull(s, new THREE.Vector3(0, 0, 2));   // pull toward the viewer in model space
  const after = vert(m, localTop).applyMatrix4(m.matrix);
  assert.ok(after.distanceTo(inModel.clone().add(new THREE.Vector3(0, 0, 2))) < 1e-4);
});

test('smoothing flattens a spike', () => {
  const m = meshFor(PARTS[1]);   // sphere r = 5
  const topIdx = nearest(m, new THREE.Vector3(0, 5, 0));
  const s = beginPull(m, vert(m, topIdx), 0.8, false);
  applyPull(s, new THREE.Vector3(0, 4, 0));
  const spike = vert(m, topIdx).y;
  for (let i = 0; i < 20; i++) smoothAt(m, vert(m, topIdx), 3, false, 0.5);   // brush centred on the spike, like a hit
  assert.ok(vert(m, topIdx).y < spike - 1.5, `spike ${spike.toFixed(2)} -> ${vert(m, topIdx).y.toFixed(2)}`);
});

test('a sculpt survives a rebuild from stored positions, and export scales it to metres', () => {
  const part = PARTS[7];
  const spec = { name: 'vase', parts: [part] };
  const m = buildModelGroup(spec).children[0];
  assert.equal(m.userData.sculptable, false);
  ensureSculptable(m, part);
  const s = beginPull(m, vert(m, 0).applyMatrix4(m.matrix), 3, false);
  applyPull(s, new THREE.Vector3(2, 0, 0));
  const stored = m.geometry.attributes.position.array.slice();
  const sculpts = new Map([['vase', stored]]);
  const again = buildModelGroup(spec, { sculpts }).children[0];
  assert.equal(again.userData.sculptable, true);
  assert.deepEqual(Array.from(again.geometry.attributes.position.array), Array.from(stored));
  const exported = buildModelGroup(spec, { sculpts, unit: 0.01, forExport: true }).children[0];
  assert.ok(Math.abs(exported.geometry.attributes.position.array[0] - stored[0] * 0.01) < 1e-7);
  // stored data that no longer matches the shape is ignored rather than crashing
  const bad = buildModelGroup(spec, { sculpts: new Map([['vase', new Float32Array(9)]]) }).children[0];
  assert.equal(bad.userData.sculptable, false);
});
