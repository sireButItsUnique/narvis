// scene/load.js, scene/parts.js and scene/highlight.js on real Blender GLBs and small hand-made ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { readGlb, mergePrimitives } from '../public/js/scene/load.js';
import { createParts } from '../public/js/scene/parts.js';
import { highlight, LOOKS } from '../public/js/scene/highlight.js';

// ---------- GLB plumbing: the contract's extras are added to the fixtures, which Blender exported without them ----------
function splitGlb(buf) {
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(chunk);
    off += 8 + len;
  }
  return { json, bin };
}
function joinGlb(json, bin) {
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const js = pad(Buffer.from(JSON.stringify(json)), 0x20), bn = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bn.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  const out = Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bn.length, 0x004e4942), bn]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
const TEAPOT = fs.readFileSync(new URL('./fixtures/teapot.glb', import.meta.url));
const hex12 = i => (0xabc000000000 + i).toString(16);

// the teapot as the export_glb recipe would send it; `edit(node, i)` changes one node's extras
function teapot(edit = () => {}) {
  const { json, bin } = splitGlb(TEAPOT);
  json.nodes.forEach((n, i) => {
    n.extras = { holo_id: hex12(i), holo_name: n.name, holo_ghash: `g${i}`, holo_mhash: `m${i}` };
    edit(n, i);
  });
  json.scenes[0].extras = { holo_sym: { x: false, y: false, z: true }, holo_rev: 3, holo_units: 'm' };
  return readGlb(joinGlb(json, bin));
}

// A tiny hand-made scene: an Empty scaled x2 holding a two-material object, a squashed one and a mirrored one,
// plus a top-level object with no holo extras at all.
function tinyScene() {
  const f32 = a => Buffer.from(new Float32Array(a).buffer), u16 = a => Buffer.from(new Uint16Array([...a, 0]).buffer);
  const parts = [], views = [], accessors = [];
  const add = (buf, type, count, componentType, extra = {}) => {
    const byteOffset = parts.reduce((s, b) => s + b.length, 0);
    parts.push(buf);
    views.push({ buffer: 0, byteOffset, byteLength: buf.length });
    accessors.push({ bufferView: views.length - 1, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const P = add(f32(tri), 'VEC3', 3, 5126, { min: [0, 0, 0], max: [1, 1, 0] });
  const N = add(f32([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3', 3, 5126);
  const UV = add(f32([0, 0, 1, 0, 0, 1]), 'VEC2', 3, 5126);
  const I = add(u16([0, 1, 2]), 'SCALAR', 3, 5123);
  const P2 = add(f32(tri.map((v, i) => (i % 3 === 2 ? 0.5 : v))), 'VEC3', 3, 5126, { min: [0, 0, 0.5], max: [1, 1, 0.5] });
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    // Blender always names the glTF scene "Scene", so it never says what the model is: holo_model does
    scenes: [{ name: 'Scene', nodes: [0, 4], extras: { holo_sym: { x: true }, holo_rev: 7, holo_units: 'm' } }],
    nodes: [
      { name: 'Root Empty', translation: [1, 0, 0], scale: [2, 2, 2], children: [1, 2, 3], extras: { holo_id: 'aaaaaaaaaaaa', holo_name: 'Root Empty' } },
      { name: 'Two Mats', mesh: 0, extras: { holo_id: 'bbbbbbbbbbbb', holo_name: 'Two Mats' } },
      { name: 'Squashed', mesh: 1, translation: [0, 1, 0], scale: [1, 0.5, 3], extras: { holo_id: 'cccccccccccc', holo_name: 'Squashed' } },
      { name: 'Mirrored', mesh: 1, scale: [-1, 1, 1], extras: { holo_id: 'dddddddddddd', holo_name: 'Mirrored' } },
      { name: 'No Id', mesh: 1 },
    ],
    meshes: [
      { name: 'TwoMatsMesh', primitives: [
        { attributes: { POSITION: P, NORMAL: N, TEXCOORD_0: UV }, indices: I, material: 0 },
        { attributes: { POSITION: P2, NORMAL: N }, indices: I, material: 1 },
      ] },
      { name: 'TriMesh', primitives: [{ attributes: { POSITION: P, NORMAL: N }, indices: I, material: 1 }] },
    ],
    materials: [{ name: 'A', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
                { name: 'B', pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1], metallicFactor: 1 } }],
    accessors, bufferViews: views, buffers: [{ byteLength: parts.reduce((s, b) => s + b.length, 0) }],
  };
  return readGlb(joinGlb(json, Buffer.concat(parts)));
}

const byName = (loaded, name) => loaded.parts.find(p => p.name === name);
const worldVerts = mesh => {
  mesh.updateMatrix();
  const p = mesh.geometry.attributes.position;
  return [...Array(p.count).keys()].map(i => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrix));
};
const near = (a, b, eps = 1e-5) => assert.ok(a.distanceTo(b) < eps, `${a.toArray()} vs ${b.toArray()}`);

// ---------- load.js ----------
test('the teapot loads as 5 parts keyed by holo_id, named as in Blender', async () => {
  const t = await teapot();
  assert.deepEqual(t.parts.map(p => p.name), ['Teapot Body', 'Teapot Handle', 'Teapot Lid', 'Teapot Lid Seat', 'Teapot Spout']);
  assert.deepEqual(t.parts.map(p => p.id), [0, 1, 2, 3, 4].map(hex12));
  assert.equal(t.parts.reduce((s, p) => s + p.meta.tris, 0), 31808);
  assert.deepEqual(t.sym, { x: false, y: false, z: true });
  assert.equal(t.rev, 3);
  assert.equal(t.name, 'Utah Teapot');
  for (const p of t.parts) {
    assert.equal(p.mesh.userData.holo_id, p.id);
    assert.equal(p.meta.parentId, hex12(5));   // the "Utah Teapot" Empty
    assert.equal(p.ghash, `g${t.parts.indexOf(p)}`);
  }
});

test('each teapot part gets its own clone of the shared glaze', async () => {
  const t = await teapot();
  const mats = t.parts.map(p => p.mesh.material);
  assert.equal(new Set(mats).size, 5);
  for (const m of mats) {
    assert.equal(m.type, 'MeshPhysicalMaterial');
    assert.ok(m.clearcoat > 0, 'clearcoat survives');
    assert.equal(m.userData.holo_mat, 'Teapot Glaze');
  }
  mats[0].color.set('#ff0000');
  assert.notEqual(mats[1].color.getHexString(), 'ff0000');
});

test('the teapot stays in metres: about 33 cm handle to spout', async () => {
  const reg = createParts();
  reg.swap((await teapot()).parts);
  const size = reg.bounds().getSize(new THREE.Vector3());
  assert.ok(size.x > 0.25 && size.x < 0.45, `width ${size.x}`);
  assert.ok(size.y > 0.1 && size.y < 0.25, `height ${size.y}`);
});

test('a two-material object becomes one part with a group per material', async () => {
  const s = await tinyScene();
  const p = byName(s, 'Two Mats');
  const g = p.mesh.geometry;
  assert.equal(p.materials.length, 2);
  assert.ok(Array.isArray(p.mesh.material));
  assert.deepEqual(p.materials.map(m => m.userData.holo_mat), ['A', 'B']);
  assert.deepEqual(g.groups.map(x => [x.start, x.count, x.materialIndex]), [[0, 3, 0], [3, 3, 1]]);
  assert.equal(g.attributes.position.count, 6);
  assert.deepEqual([...g.index.array], [0, 1, 2, 3, 4, 5]);
  // the second primitive had no UVs: filled with zeros so the merge still works
  assert.deepEqual([...g.attributes.uv.array.slice(6)], [0, 0, 0, 0, 0, 0]);
  assert.equal(p.meta.parentId, 'aaaaaaaaaaaa');
});

test('parts are flattened relative to the glTF root, keeping their world positions', async () => {
  const s = await tinyScene();
  const p = byName(s, 'Two Mats');
  // Root Empty: x2 at (1,0,0); the part itself is untransformed
  near(worldVerts(p.mesh)[1], new THREE.Vector3(3, 0, 0));
  assert.equal(p.mesh.scale.x, 2);
  assert.equal(p.meta.bake, null);
});

test('non-uniform scale is baked into the geometry and remembered', async () => {
  const s = await tinyScene();
  const p = byName(s, 'Squashed');
  assert.deepEqual(p.mesh.scale.toArray(), [1, 1, 1]);
  assert.ok(Array.isArray(p.mesh.userData.holo_bake));
  // world = T(1,0,0) S(2) * T(0,1,0) S(1, 0.5, 3) * v
  const want = [[0, 0, 0], [1, 0, 0], [0, 1, 0]].map(([x, y, z]) => new THREE.Vector3(1 + 2 * x, 2 * (1 + 0.5 * y), 2 * 3 * z));
  worldVerts(p.mesh).forEach((v, i) => near(v, want[i]));
  // the shared TriMesh geometry was copied before baking, so the other users of it are untouched
  assert.notEqual(p.mesh.geometry, byName(s, 'No Id').mesh.geometry);
  near(worldVerts(byName(s, 'No Id').mesh)[2], new THREE.Vector3(0, 1, 0));
});

test('a mirrored part is baked with its winding flipped, so its faces still face out', async () => {
  const s = await tinyScene();
  const p = byName(s, 'Mirrored');
  const v = worldVerts(p.mesh), [a, b, c] = [...p.mesh.geometry.index.array].map(i => v[i]);
  const facing = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const n = new THREE.Vector3().fromBufferAttribute(p.mesh.geometry.attributes.normal, 0);
  assert.ok(facing.z > 0.99, `winding normal ${facing.toArray()}`);
  assert.ok(n.z > 0.99, `stored normal ${n.toArray()}`);
  near(v[0], new THREE.Vector3(1, 0, 0));
  near(v[1], new THREE.Vector3(-1, 0, 0));
});

test('objects without holo extras still load, keyed by their name', async () => {
  const s = await tinyScene();
  assert.deepEqual(s.parts.map(p => p.id), ['bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'name:No Id']);
  assert.deepEqual(s.sym, { x: true, y: false, z: false });
  assert.equal(s.rev, 7);
  // two top-level objects, so no single model name; the glTF scene's own name ("Scene") is never it
  assert.equal(s.name, 'model');
});

test('the model name is holo_model, else the single root, never the glTF scene name', async () => {
  const { json, bin } = splitGlb(TEAPOT);
  json.nodes.forEach((n, i) => { n.extras = { holo_id: hex12(i), holo_name: n.name }; });
  json.scenes[0].name = 'Scene';   // what Blender always calls it
  assert.equal(json.scenes[0].nodes.length, 1, 'the teapot hangs off one root Empty');
  const rootName = json.nodes[json.scenes[0].nodes[0]].name;
  assert.equal((await readGlb(joinGlb(json, bin))).name, rootName);
  // a build grouped in a collection has several roots, and then only the export can say what the model is
  json.scenes[0].nodes.push(json.nodes.findIndex(n => n.mesh !== undefined));
  assert.equal((await readGlb(joinGlb(json, bin))).name, 'model');
  json.scenes[0].extras = { holo_model: 'Test Lamp' };
  assert.equal((await readGlb(joinGlb(json, bin))).name, 'Test Lamp');
});

test('mergePrimitives widens attributes and switches to 32-bit indices past 65535 vertices', () => {
  const big = new THREE.BufferGeometry();
  big.setAttribute('position', new THREE.BufferAttribute(new Float32Array(70000 * 3), 3));
  big.setIndex([0, 1, 69999]);
  const small = new THREE.BufferGeometry();
  small.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  small.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(0.5), 4));
  const g = mergePrimitives([big, small]);
  assert.ok(g.index.array instanceof Uint32Array);
  assert.deepEqual([...g.index.array], [0, 1, 69999, 70000, 70001, 70002]);
  assert.equal(g.attributes.color.getX(0), 1);   // missing colour is white
  assert.equal(g.attributes.color.getX(70000), 0.5);
});

// ---------- parts.js ----------
test('a new rev swaps only the parts whose hashes changed', async () => {
  const reg = createParts();
  const first = await teapot();
  reg.swap(first.parts);
  const before = new Map(reg.list().map(p => [p.name, p]));
  const bodyMesh = before.get('Teapot Body').mesh, lidMesh = before.get('Teapot Lid').mesh;
  const lidMats = before.get('Teapot Lid').materials, spoutMesh = before.get('Teapot Spout').mesh;
  const disposed = [];
  spoutMesh.geometry.addEventListener('dispose', () => disposed.push('spout geometry'));
  bodyMesh.geometry.addEventListener('dispose', () => disposed.push('body geometry'));
  lidMats[0].addEventListener('dispose', () => disposed.push('old lid material'));

  const next = await teapot((n, i) => {
    if (n.name === 'Teapot Lid') n.extras.holo_mhash = 'm-gold';
    if (n.name === 'Teapot Spout') n.extras.holo_ghash = 'g-sculpted';
  });
  const handle = next.parts.find(p => p.name === 'Teapot Handle');
  const incoming = next.parts.filter(p => p !== handle);
  const saucer = { ...handle, id: 'eeeeeeeeeeee', name: 'Saucer' };
  saucer.mesh.userData.holo_id = saucer.id;
  const report = reg.swap([...incoming, saucer]);

  assert.deepEqual(report, {
    kept: [hex12(0), hex12(3)], restyled: [hex12(2)], replaced: [hex12(4)], added: ['eeeeeeeeeeee'], removed: [hex12(1)],
  });
  assert.equal(reg.get(hex12(0)).mesh, bodyMesh, 'body kept as is');
  assert.equal(reg.get(hex12(2)).mesh, lidMesh, 'lid keeps its mesh');
  assert.notEqual(reg.get(hex12(2)).materials, lidMats, 'lid gets the new materials');
  assert.equal(reg.get(hex12(2)).mhash, 'm-gold');
  assert.notEqual(reg.get(hex12(4)).mesh, spoutMesh, 'spout replaced');
  assert.equal(reg.get(hex12(1)), null, 'handle removed');
  assert.equal(reg.root.children.length, 5);
  assert.deepEqual(disposed.sort(), ['old lid material', 'spout geometry']);
});

test('a part edited here is replaced by Blender\'s copy even when the hashes match', async () => {
  const reg = createParts();
  reg.swap((await teapot()).parts);
  const lid = reg.get(hex12(2));
  lid.dirty.xform = true;
  const report = reg.swap((await teapot()).parts);
  assert.deepEqual(report.replaced, [hex12(2)]);
  assert.notEqual(reg.get(hex12(2)).mesh, lid.mesh);
});

test('hide, isolate and show all, and hidden parts stay hidden across a rev', async () => {
  const reg = createParts();
  reg.swap((await teapot()).parts);
  const lid = reg.get(hex12(2)), body = reg.get(hex12(0));
  reg.hide(lid);
  assert.equal(reg.meshes().length, 4);
  assert.ok(!reg.meshes().includes(lid.mesh));
  reg.swap((await teapot()).parts);
  assert.equal(reg.meshes().length, 4, 'still hidden after a new rev');
  reg.isolate(body);
  assert.deepEqual(reg.meshes(), [body.mesh]);
  assert.equal(reg.showAll(), 4);
  assert.equal(reg.meshes().length, 5);
});

test('duplicate, remove and restore work locally', async () => {
  const reg = createParts();
  reg.swap((await teapot()).parts);
  const lid = reg.get(hex12(2));
  const copy = reg.duplicate(lid);
  assert.match(copy.id, /^[0-9a-f]{12}$/);
  assert.equal(copy.name, 'Teapot Lid copy');
  assert.equal(reg.duplicate(lid).name, 'Teapot Lid copy 2');
  assert.notEqual(copy.mesh.geometry, lid.mesh.geometry);
  assert.notEqual(copy.materials[0], lid.materials[0]);
  assert.ok(copy.mesh.position.x > lid.mesh.position.x);
  assert.ok(copy.dirty.mesh && copy.meta.local);
  assert.equal(reg.ofMesh(copy.mesh), copy);
  reg.remove(copy);
  assert.equal(reg.get(copy.id), null);
  assert.equal(reg.ofMesh(copy.mesh), null);
  reg.restore(copy);
  assert.equal(reg.get(copy.id), copy);
  assert.equal(reg.findByName('lid'), lid);
  assert.equal(reg.findByName('teapot lid seat').name, 'Teapot Lid Seat');
});

test('clay look replaces every material and gives them back', async () => {
  const reg = createParts();
  reg.swap((await tinyScene()).parts);
  const clay = new THREE.MeshStandardMaterial();
  reg.setLook(clay);
  assert.ok(reg.list().every(p => p.mesh.material === clay));
  reg.setLook(null);
  const two = reg.list().find(p => p.name === 'Two Mats');
  assert.deepEqual(two.mesh.material, two.materials);
  assert.equal(reg.list().find(p => p.name === 'Squashed').mesh.material, reg.list().find(p => p.name === 'Squashed').materials[0]);
});

// ---------- highlight.js ----------
test('the hover overlay shares the part geometry and never touches its material', async () => {
  const reg = createParts();
  reg.swap((await teapot()).parts);
  const [body, lid] = [reg.get(hex12(0)), reg.get(hex12(2))];
  const bodyMat = body.mesh.material;
  highlight(reg.meshes(), { hovered: body.mesh });
  const overlay = body.mesh.children[0];
  assert.equal(overlay.geometry, body.mesh.geometry);
  assert.equal(overlay.material, LOOKS.hover);
  assert.equal(overlay.material.blending, THREE.AdditiveBlending);
  assert.ok(overlay.visible);
  assert.equal(body.mesh.material, bodyMat);
  highlight(reg.meshes(), { active: lid.mesh });
  assert.ok(!overlay.visible);
  assert.equal(lid.mesh.children[0].material, LOOKS.active);
  highlight(reg.meshes(), { all: true });
  assert.ok(reg.meshes().every(m => m.children[0].visible && m.children[0].material === LOOKS.all));
  highlight(reg.meshes(), {});
  assert.ok(reg.meshes().every(m => !m.children[0].visible));
});
