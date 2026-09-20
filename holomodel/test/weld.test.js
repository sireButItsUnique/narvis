// SPDX-License-Identifier: GPL-3.0-or-later
// The render binding, on real Blender exports.
//
// A Blender object arrives in the browser split apart: one glTF primitive per material, and a
// duplicated vertex wherever a UV seam or a hard edge needs its own normal. Sculpting that
// directly tears the part open along every one of those lines. These tests pin the three things
// the binding has to get right: weld the copies back together, keep the seam invisible after
// heavy sculpting, and still let a flat-shaded cube stay flat.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { createBinding } from '../public/js/sculpt/binding.js';
import { createSculptEngine } from '../public/js/sculpt/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

async function loadGLB(name) {
  const buf = fs.readFileSync(path.join(FIXTURES, name));
  const loader = new GLTFLoader();
  // No image decoding in Node: the tests only care about geometry.
  loader.register(() => ({ name: 'stub', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(arrayBuffer, '', res, rej));
}

function findPart(gltf, name) {
  let found = null;
  gltf.scene.traverse((o) => {
    if (found) return;
    if (o.userData?.name === name || o.name === name) found = o;
  });
  if (!found) throw new Error(`fixture has no part called ${name}`);
  const meshes = found.isMesh ? [found] : found.children.filter((c) => c.isMesh);
  return { object: found, meshes };
}

/** Dab straight down the surface normal at a proxy vertex. */
function dabAt(engine, handle, vertex, radius) {
  const p = handle.proxy.getVertices();
  const n = handle.proxy.getRenderNormals();
  const origin = [p[3 * vertex] + n[3 * vertex], p[3 * vertex + 1] + n[3 * vertex + 1], p[3 * vertex + 2] + n[3 * vertex + 2]];
  const dir = [-n[3 * vertex], -n[3 * vertex + 1], -n[3 * vertex + 2]];
  engine.setRadiusWorld(radius);
  return engine.applyDab({ worldRay: { origin, direction: dir }, pressure: 1, overlap: 1 });
}

test('a multi-material part welds into one proxy and never cracks', async () => {
  const gltf = await loadGLB('teapot_uv.glb');
  const part = findPart(gltf, 'Teapot Body');
  assert.equal(part.meshes.length, 2, 'the body arrives as two primitives, one per material');

  const binding = createBinding(part.meshes);
  const renderCount = part.meshes.reduce((s, m) => s + m.geometry.getAttribute('position').count, 0);
  assert.equal(renderCount, 9610);
  assert.equal(binding.proxyCount, 8258, "welds back to Blender's own vertex count");
  assert.equal(binding.usedVid, false, 'this fixture predates the _vid attribute, so it welds by position');
  assert.ok(binding.faceMaterial.some((m) => m === 0) && binding.faceMaterial.some((m) => m === 1),
    'both materials are recorded per face');

  // Border vertices: the same position in both primitives.
  const a = part.meshes[0].geometry.getAttribute('position').array;
  const b = part.meshes[1].geometry.getAttribute('position').array;
  const key = (arr, i) => `${arr[3 * i].toFixed(6)},${arr[3 * i + 1].toFixed(6)},${arr[3 * i + 2].toFixed(6)}`;
  const inB = new Map();
  for (let i = 0; i < b.length / 3; i++) inB.set(key(b, i), i);
  const border = [];
  for (let i = 0; i < a.length / 3; i++) {
    const j = inB.get(key(a, i));
    if (j !== undefined) border.push([i, j]);
  }
  assert.ok(border.length > 50, `the two primitives share a border (${border.length} vertices)`);
  const crack = () => Math.max(...border.map(([i, j]) => Math.hypot(a[3 * i] - b[3 * j], a[3 * i + 1] - b[3 * j + 1], a[3 * i + 2] - b[3 * j + 2])));
  assert.equal(crack(), 0, 'no crack before sculpting');

  const engine = createSculptEngine();
  const handle = engine.attach(part.meshes, { id: 'body' });
  engine.setBrush('smooth');
  engine.setStrength(1);
  const [ai] = border[Math.floor(border.length / 2)];
  const vertex = handle.binding.renderToProxy[ai];
  let moved = 0;
  for (let i = 0; i < 5; i++) moved += dabAt(engine, handle, vertex, 0.02) ? 1 : 0;
  engine.endStroke();
  assert.ok(moved >= 1, 'the smooth dabs landed');

  const after = crack();
  assert.equal(after, 0, `the material border stays welded after 5 smooth passes (crack ${(after * 100).toFixed(4)} cm)`);
});

test('UV-seam copies share one normal, so the seam does not show', async () => {
  const gltf = await loadGLB('teapot_uv.glb');
  const part = findPart(gltf, 'Teapot Body');
  const engine = createSculptEngine();
  const handle = engine.attach(part.meshes, { id: 'body' });
  const binding = handle.binding;

  // Seam vertices: one proxy vertex, several render copies, all exported with the same normal.
  const seams = [];
  for (let v = 0; v < binding.proxyCount; v++) {
    const copies = binding.csrOff[v + 1] - binding.csrOff[v];
    if (copies < 2) continue;
    const groups = binding.proxyGroupOff[v + 1] - binding.proxyGroupOff[v];
    if (groups === 1) seams.push(v);
  }
  assert.ok(seams.length > 100, `the body has UV seam copies (${seams.length} welded vertices with several copies)`);

  engine.setBrush('smooth');
  engine.setStrength(1);
  for (let i = 0; i < 5; i++) dabAt(engine, handle, seams[Math.floor(seams.length / 2)], 0.03);
  engine.endStroke();

  const normalOf = (renderIndex) => {
    for (let i = binding.prims.length - 1; i >= 0; i--) {
      const p = binding.prims[i];
      if (renderIndex >= p.offset) {
        const li = renderIndex - p.offset;
        const arr = p.normal.array;
        return [arr[3 * li], arr[3 * li + 1], arr[3 * li + 2]];
      }
    }
    return null;
  };
  let worst = 1;
  for (const v of seams) {
    const first = normalOf(binding.csrIdx[binding.csrOff[v]]);
    for (let c = binding.csrOff[v] + 1; c < binding.csrOff[v + 1]; c++) {
      const n = normalOf(binding.csrIdx[c]);
      worst = Math.min(worst, first[0] * n[0] + first[1] * n[1] + first[2] * n[2]);
    }
  }
  assert.ok(worst > 0.9999, `seam copies keep the same normal (worst dot ${worst.toFixed(5)})`);
});

test('a flat-shaded cube keeps its hard edges', async () => {
  const gltf = await loadGLB('seamy.glb');
  const part = findPart(gltf, 'Base');
  const engine = createSculptEngine();
  const handle = engine.attach(part.meshes, { id: 'base' });
  const binding = handle.binding;

  const hard = [];
  for (let v = 0; v < binding.proxyCount; v++) {
    if (binding.proxyGroupOff[v + 1] - binding.proxyGroupOff[v] > 1) hard.push(v);
  }
  assert.ok(hard.length > 0, `the flat-shaded cube has hard-edge copies (${hard.length} welded vertices)`);

  const normalOf = (renderIndex) => {
    for (let i = binding.prims.length - 1; i >= 0; i--) {
      const p = binding.prims[i];
      if (renderIndex >= p.offset) {
        const li = renderIndex - p.offset;
        const arr = p.normal.array;
        return [arr[3 * li], arr[3 * li + 1], arr[3 * li + 2]];
      }
    }
    return null;
  };
  const cornerSpread = () => {
    let worst = 1;
    for (const v of hard) {
      const first = normalOf(binding.csrIdx[binding.csrOff[v]]);
      for (let c = binding.csrOff[v] + 1; c < binding.csrOff[v + 1]; c++) {
        const n = normalOf(binding.csrIdx[c]);
        worst = Math.min(worst, first[0] * n[0] + first[1] * n[1] + first[2] * n[2]);
      }
    }
    return worst;
  };
  const beforeSpread = cornerSpread();
  assert.ok(beforeSpread < 0.9, `hard edges start faceted (worst dot ${beforeSpread.toFixed(3)})`);

  engine.setBrush('smooth');
  engine.setStrength(1);
  for (let i = 0; i < 5; i++) dabAt(engine, handle, hard[Math.floor(hard.length / 2)], 0.05);
  engine.endStroke();

  const afterSpread = cornerSpread();
  assert.ok(afterSpread < 0.9, `and stay faceted after sculpting (worst dot ${afterSpread.toFixed(3)})`);

  // The geometry itself is still welded: every copy of a proxy vertex sits at the same place.
  const proxyPos = handle.proxy.getVertices();
  for (let v = 0; v < binding.proxyCount; v++) {
    for (let c = binding.csrOff[v]; c < binding.csrOff[v + 1]; c++) {
      const r = binding.csrIdx[c];
      let prim = binding.prims[0];
      for (let i = binding.prims.length - 1; i >= 0; i--) if (r >= binding.prims[i].offset) { prim = binding.prims[i]; break; }
      const li = r - prim.offset;
      const arr = prim.position.array;
      assert.ok(Math.abs(arr[3 * li] - proxyPos[3 * v]) < 1e-6, 'render copies follow the proxy exactly');
    }
  }
});
