// SPDX-License-Identifier: GPL-3.0-or-later
// The engine's edges, none of which a golden Blender stroke can see: inverted strokes (every
// fixture is recorded with mode='NORMAL'), the "original normal"/"original plane" flags (no
// shipped preset sets either), a hand that emits a NaN, a part that moves under a live stroke, a
// stroke that is interrupted rather than ended, and the two undo shapes.
//
// Each test pins the BEHAVIOUR that was wrong, not a golden number, because the behaviour is what
// real Blender was measured to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createSculptEngine } from '../public/js/sculpt/index.js';
import { brushStrength, isPlaneSwapMode } from '../public/js/sculpt/cache.js';
import { loadPresets, brushSettings } from '../public/js/sculpt/presets.js';
import { installSetB } from '../public/js/sculpt/brushes/set-b.js';

await loadPresets();

const RADIUS = 0.3;

/** A bumpy N x N grid: a flat plane would give the Plane family nothing to flatten. */
function bumpyGrid(n = 41, extent = 1.2) {
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -extent + (2 * extent * i) / (n - 1);
      const y = -extent + (2 * extent * j) / (n - 1);
      const k = 3 * (j * n + i);
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = 0.05 * Math.sin(6 * x) * Math.cos(5 * y);
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  return geometry;
}

function rig(presetName, { invert = false, overrides = {}, geometry = bumpyGrid() } = {}) {
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: 'grid' });
  const settings = { ...brushSettings(presetName, { overrides: false }), ...overrides, name: presetName };
  engine.setBrushSettings(settings);
  engine.setRadiusWorld(RADIUS);
  engine.setPressureEnabled(true);
  engine.setInvert(invert);
  return { engine, handle, settings };
}

/** Five dabs straight down, walking along +X, and the signed z the surface moved in total. */
function strokeDownX(engine, handle, settings, dabs = 5) {
  const before = handle.proxy.getVertices().slice();
  for (let i = 0; i < dabs; i++) {
    const x = -0.3 + 0.15 * i;
    engine.applyDab({
      worldRay: { origin: [x, 0, 4], direction: [0, 0, -1] },
      pressure: 1,
      overlap: 1,
      settings,
    });
  }
  const after = handle.proxy.getVertices();
  let sum = 0;
  for (let i = 0; i < before.length / 3; i++) sum += after[3 * i + 2] - before[3 * i + 2];
  return sum;
}

test('an inverted Plane stroke reverses, instead of doing the same thing at half strength', () => {
  // Blender sets cache->initial_direction_flipped once at stroke start (sculpt.cc:5478), and the
  // Plane kernel reads it to choose the plane_offset sign and the INVERT_DISPLACEMENT /
  // SWAP_DEPTH_AND_HEIGHT branch. Writing it inside the dab never ran for this brush, because the
  // Plane family drops its first dab for want of a stroke direction and clears firstTime there.
  for (const preset of ['Flatten/Contrast', 'Plateau', 'Scrape/Fill', 'Fill/Deepen', 'Trim']) {
    const plain = rig(preset);
    const plainSum = strokeDownX(plain.engine, plain.handle, plain.settings);

    const flipped = rig(preset, { invert: true });
    const flippedSum = strokeDownX(flipped.engine, flipped.handle, flipped.settings);

    assert.equal(flipped.handle._cache.initialDirectionFlipped, true, `${preset}: the stroke knows it is inverted`);
    assert.ok(Math.abs(plainSum) > 1e-4, `${preset}: the un-inverted stroke moved something`);
    assert.ok(Math.abs(flippedSum) > 1e-4, `${preset}: the inverted stroke moved something`);
    assert.ok(
      Math.sign(plainSum) !== Math.sign(flippedSum),
      `${preset}: inverted went ${flippedSum.toExponential(3)}, un-inverted ${plainSum.toExponential(3)} - same direction`,
    );
  }
});

test('the Plane strength table reads the RNA spelling of the swap mode, not the C enum name', () => {
  // rna_brush.cc maps BRUSH_PLANE_SWAP_HEIGHT_AND_DEPTH to the identifier "SWAP_DEPTH_AND_HEIGHT",
  // and the identifier is what presets.json stores. Comparing against the C name never matched, so
  // inverted Scrape/Fill, Fill/Deepen and Trim ran 8.14x too weak.
  assert.equal(isPlaneSwapMode('SWAP_DEPTH_AND_HEIGHT'), true);
  assert.equal(isPlaneSwapMode('SWAP_HEIGHT_AND_DEPTH'), false);
  for (const name of ['Scrape/Fill', 'Fill/Deepen', 'Trim']) {
    assert.equal(isPlaneSwapMode(brushSettings(name, { overrides: false }).plane_inversion_mode), true, name);
  }

  const o = { strength: 0.7, pressure: 1, overlap: 0.1400, flip: -1, planeInversionMode: 'SWAP_DEPTH_AND_HEIGHT' };
  const alpha = 0.7 * 0.7;
  // Blender returns alpha * pressure * (1 + overlap) / 2 in swap mode, whichever way the stroke goes.
  assert.ok(Math.abs(brushStrength('PLANE', o) - alpha * (1 + o.overlap) / 2) < 1e-12);
  // INVERT_DISPLACEMENT still takes the halved branch when inverted.
  assert.ok(Math.abs(brushStrength('PLANE', { ...o, planeInversionMode: 'INVERT_DISPLACEMENT' }) - 0.5 * alpha * o.overlap) < 1e-12);
});

test('"original normal" freezes only the normal, and the Plane brush ignores both flags', () => {
  // calc_brush_plane (sculpt.cc:3089) computes use_original_plane / use_original_normal separately
  // and disables both for SCULPT_BRUSH_TYPE_PLANE. Freezing the area CENTRE along with the normal
  // pinned a Clay Strips stroke to its first dab's plane - and, because the freeze was keyed off
  // firstTime, it fired before any area data existed and threw a TypeError on the second dab.
  const run = (preset, flags) => {
    const r = rig(preset, { overrides: flags });
    const sum = strokeDownX(r.engine, r.handle, r.settings, 6);
    return { sum, positions: r.handle.proxy.getVertices().slice() };
  };

  const base = run('Clay Strips', {});
  const normalOnly = run('Clay Strips', { use_original_normal: true });
  const both = run('Clay Strips', { use_original_normal: true, use_original_plane: true });
  assert.ok(Number.isFinite(normalOnly.sum) && Math.abs(normalOnly.sum) > 0, 'the flagged stroke ran at all');
  // With only the normal frozen the centre still follows the surface, so the stroke keeps
  // travelling and stays close to the unflagged one; freezing the plane too collapses it.
  const spread = (a, b) => {
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    return worst;
  };
  assert.ok(spread(base.positions, both.positions) > spread(base.positions, normalOnly.positions),
    '"original plane" changes the stroke more than "original normal" alone');

  const plane = run('Flatten/Contrast', {});
  const planeNormal = run('Flatten/Contrast', { use_original_normal: true });
  const planeBoth = run('Flatten/Contrast', { use_original_normal: true, use_original_plane: true });
  assert.deepEqual(planeNormal.positions, plane.positions, 'the Plane brush ignores "original normal"');
  assert.deepEqual(planeBoth.positions, plane.positions, 'the Plane brush ignores "original plane" too');
});

// ---------------------------------------------------------------- non-finite input

function sphereEngine(id = 'ball', radius = 0.15, seg = 24) {
  const geometry = new THREE.SphereGeometry(radius, seg, seg / 2);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id });
  engine.setRadiusWorld(0.05);
  return { engine, handle };
}

const allFinite = (a) => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};

test('one non-finite sample is dropped whole, and the stroke survives it', () => {
  for (const brush of ['draw', 'snake_hook', 'grab', 'elastic']) {
    const { engine, handle } = sphereEngine();
    engine.setBrush(brush);
    engine.setPressureEnabled(true);
    const ray = (t) => ({ origin: [0.01 * t, 0, 1], direction: [0, 0, -1] });

    assert.ok(engine.beginStroke({ worldRay: ray(0), point3D: [0, 0, 0.15], pressure: 1, timeMs: 0 }), brush);
    engine.sampleStroke({ worldRay: ray(1), point3D: [0.01, 0, 0.15], pressure: 1, timeMs: 33 });
    // The bad frame: one dropped landmark.
    engine.sampleStroke({ worldRay: ray(2), point3D: [0.02, NaN, 0.15], pressure: 1, timeMs: 66 });
    engine.sampleStroke({ worldRay: { origin: [0, Infinity, 1], direction: [0, 0, -1] }, point3D: [0.02, 0, 0.15], pressure: 1, timeMs: 99 });
    engine.sampleStroke({ worldRay: ray(3), point3D: [0.03, 0, 0.15], pressure: NaN, timeMs: 132 });
    for (let i = 4; i < 12; i++) {
      engine.sampleStroke({ worldRay: ray(i), point3D: [0.01 * i, 0, 0.15], pressure: 1, timeMs: 33 * i });
    }
    engine.endStroke();

    assert.ok(allFinite(handle.proxy.getVertices()), `${brush}: the proxy stayed finite`);
    const render = handle.binding.prims[0].position.array;
    assert.ok(allFinite(render), `${brush}: the render buffer stayed finite`);
    const geo = handle.binding.prims[0].geometry;
    geo.computeBoundingSphere();
    assert.ok(Number.isFinite(geo.boundingSphere.radius), `${brush}: the mesh still has a bounding sphere`);
  }
});

test('applyDab and hover refuse a non-finite ray instead of walking the whole octree', () => {
  const { engine, handle } = sphereEngine();
  engine.setBrush('draw');
  const before = handle.proxy.getVertices().slice();

  assert.equal(engine.applyDab({ worldRay: { origin: [0, NaN, 1], direction: [0, 0, -1] }, pressure: 1 }), false);
  assert.equal(engine.applyDab({ worldRay: { origin: [0, 0, 1], direction: [NaN, 0, -1] }, pressure: 1 }), false);
  assert.deepEqual(handle.proxy.getVertices(), before, 'nothing moved');

  assert.equal(engine.hover({ origin: [0, NaN, 1], direction: [0, 0, -1] }).hit, false);
  assert.equal(engine.hover({ origin: [0, 0, 1], direction: [0, NaN, -1] }).hit, false);
  assert.equal(engine.hover(undefined).hit, false, 'no ray at all, before the tracker has a sample');
  assert.equal(engine.hover({}).hit, false, 'a half-built ray object');

  // The octree itself must fail closed too, or a bad ray costs tens of milliseconds.
  assert.equal(handle.proxy.intersectRay([0, 0, 1], [0, NaN, -1]).length, 0);
  assert.equal(handle.proxy.intersectSphere([NaN, 0, 0], 0.01).length, 0);
  // ... while a legitimate axis-aligned ray, whose slab test produces 0 * Infinity = NaN on any
  // cell plane it grazes, must still hit.
  const hit = engine.hover({ origin: [0, 0, 1], direction: [0, 0, -1] });
  assert.equal(hit.hit, true, 'a head-on axis-aligned ray still hits');
});

// ---------------------------------------------------------------- render upload

test('every dab of a frame reaches the GPU, not just the last one', () => {
  // three.js accumulates BufferAttribute.updateRanges and clears them itself after uploading them,
  // so clearing them per dab dropped every refresh but the last one in a frame.
  const { engine, handle } = sphereEngine('ball', 0.15, 32);
  engine.setBrush('draw');
  const attr = handle.binding.prims[0].position;
  attr.updateRanges.length = 0;

  const touched = new Set();
  for (let i = 0; i < 4; i++) {
    const y = -0.06 + 0.04 * i;
    engine.applyDab({ worldRay: { origin: [0, y, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
    for (const r of attr.updateRanges) for (let k = r.start; k < r.start + r.count; k++) touched.add(k);
  }
  engine.endStroke();

  assert.ok(attr.updateRanges.length >= 2, 'the ranges accumulated across dabs');
  const base = new THREE.SphereGeometry(0.15, 32, 16).getAttribute('position').array;
  const live = attr.array;
  let stale = 0;
  for (let i = 0; i < live.length; i++) if (live[i] !== base[i] && !touched.has(i)) stale++;
  assert.equal(stale, 0, `${stale} changed floats were never in an update range`);
});

// ---------------------------------------------------------------- interrupted strokes

test('an interrupted stroke keeps its undo record', () => {
  const start = (engine, t) => engine.beginStroke({ worldRay: { origin: [0, 0, 1], direction: [0, 0, -1] }, point3D: [0, 0, 0.15], pressure: 1, timeMs: t });
  const push = (engine, i, t) => engine.sampleStroke({ worldRay: { origin: [0, 0.006 * i, 1], direction: [0, 0, -1] }, point3D: [0, 0.006 * i, 0.15], pressure: 1, timeMs: t });

  // (a) a pinch FSM re-firing begin after a dropped frame
  {
    const { engine, handle } = sphereEngine();
    engine.setBrush('draw');
    engine.setStrength(1);
    const before = handle.proxy.getVertices().slice();
    start(engine, 0);
    for (let i = 1; i <= 8; i++) push(engine, i, 33 * i);
    start(engine, 300); // the FSM fires begin again
    for (let i = 1; i <= 8; i++) push(engine, i, 300 + 33 * i);
    const records = [...engine.drainRecords(), engine.endStroke()].filter(Boolean);
    assert.equal(records.length, 2, 'both halves produced a record');
    for (const r of records.reverse()) engine.applyHistory(r, 'undo');
    assert.deepEqual(handle.proxy.getVertices(), before, 'undoing both halves restores the part exactly');
  }

  // (b) the re-fired begin misses the part entirely - the likeliest shape of all
  {
    const { engine, handle } = sphereEngine();
    engine.setBrush('draw');
    engine.setStrength(1);
    const before = handle.proxy.getVertices().slice();
    start(engine, 0);
    for (let i = 1; i <= 8; i++) push(engine, i, 33 * i);
    engine.beginStroke({ worldRay: { origin: [9, 9, 9], direction: [0, 0, 1] }, pressure: 1, timeMs: 300 });
    const orphans = engine.drainRecords();
    assert.equal(orphans.length, 1, 'the first stroke was banked even though the new one found nothing');
    engine.endStroke();
    engine.applyHistory(orphans[0], 'undo');
    assert.deepEqual(handle.proxy.getVertices(), before);
  }

  // (c) a filter run in the middle of a stroke
  {
    const { engine, handle } = sphereEngine();
    installSetB(engine);
    engine.setBrush('draw');
    engine.setStrength(1);
    const before = handle.proxy.getVertices().slice();
    start(engine, 0);
    for (let i = 1; i <= 8; i++) push(engine, i, 33 * i);
    const filterRecord = engine.filter('smooth', { strength: 0.5 });
    const orphans = engine.drainRecords();
    assert.equal(orphans.length, 1, 'filter() banked the live stroke');
    engine.applyHistory(filterRecord, 'undo');
    engine.applyHistory(orphans[0], 'undo');
    assert.deepEqual(handle.proxy.getVertices(), before);
  }

  // (d) a dab aimed at a second part does not steal the first part's record
  {
    const engine = createSculptEngine({ handOverrides: false });
    engine.setHandOverrides(false);
    const a = engine.attach(new THREE.SphereGeometry(0.15, 24, 12), { id: 'A' });
    engine.attach(new THREE.SphereGeometry(0.15, 24, 12), { id: 'B' });
    engine.setBrush('draw');
    engine.setRadiusWorld(0.05);
    const before = a.proxy.getVertices().slice();
    for (let i = 0; i < 4; i++) {
      engine.applyDab({ worldRay: { origin: [0, 0.01 * i, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 }, 'A');
    }
    engine.applyDab({ worldRay: { origin: [0, 0, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 }, 'B');
    const orphans = engine.drainRecords();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].part, 'A');
    engine.endStroke();
    engine.applyHistory(orphans[0], 'undo');
    assert.deepEqual(a.proxy.getVertices(), before);
  }
});

// ---------------------------------------------------------------- moving parts

test('a part that is turned or moved after attach still sculpts where the ring is', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
  mesh.updateMatrixWorld(true);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  engine.attach(mesh, { id: 'cube' });
  engine.setRadiusWorld(0.05);

  mesh.rotation.y = Math.PI / 4;
  mesh.updateMatrixWorld(true);
  const turned = engine.hover({ origin: [1, 0, 0], direction: [-1, 0, 0] });
  assert.equal(turned.hit, true);
  // A 45-degree turn puts the cube's corner at half the diagonal along +X.
  assert.ok(Math.abs(turned.point[0] - 0.1 * Math.SQRT2) < 1e-6, `hit x ${turned.point[0]}`);

  mesh.position.set(0.3, 0, 0);
  mesh.rotation.y = 0;
  mesh.updateMatrixWorld(true);
  const moved = engine.hover({ origin: [1, 0, 0], direction: [-1, 0, 0] });
  assert.equal(moved.hit, true, 'a translated part is still findable');
  assert.ok(Math.abs(moved.point[0] - 0.4) < 1e-6, `hit x ${moved.point[0]}`);

  const stroke = engine.beginStroke({ worldRay: { origin: [1, 0, 0], direction: [-1, 0, 0] }, pressure: 1, timeMs: 0 });
  assert.ok(stroke, 'and still sculptable');
});

// ---------------------------------------------------------------- octree

test('pulling clay out of a part does not rebuild the whole octree inside the dab', () => {
  const { engine, handle } = sphereEngine('ball', 0.15, 48);
  engine.setBrush('snake_hook');
  engine.setRadiusWorld(0.05);
  engine.setStrength(1);

  const proxy = handle.proxy;
  const original = proxy._computeOctree;
  let rebuilds = 0;
  proxy._computeOctree = function counted() { rebuilds++; return original.call(this); };

  engine.beginStroke({ worldRay: { origin: [0, 0, 1], direction: [0, 0, -1] }, point3D: [0, 0, 0.15], pressure: 1, timeMs: 0 });
  for (let i = 1; i <= 24; i++) {
    const z = 0.15 + 0.0125 * i; // 30 cm of pull out of a 30 cm ball
    engine.sampleStroke({ worldRay: { origin: [0, 0, 1], direction: [0, 0, -1] }, point3D: [0, 0, z], pressure: 1, timeMs: 33 * i });
  }
  engine.endStroke();
  proxy._computeOctree = original;

  assert.equal(rebuilds, 0, `${rebuilds} full octree rebuilds ran inside the stroke`);
});

// ---------------------------------------------------------------- undo shapes

test('a whole-part edit gets the compact record shape and still undoes exactly', () => {
  const { engine, handle } = sphereEngine('ball', 0.15, 24);
  installSetB(engine);
  const before = handle.proxy.getVertices().slice();
  const record = engine.filter('inflate', { amount: 0.01 });
  assert.equal(record.whole, true, 'every vertex moved, so the index array is dropped');
  assert.equal(record.idx, undefined);
  assert.equal(record.bytes, handle.proxy.getNbVertices() * 24);
  const after = handle.proxy.getVertices().slice();
  assert.notDeepEqual(after, before);
  engine.applyHistory(record, 'undo');
  assert.deepEqual(handle.proxy.getVertices(), before, 'undo is exact');
  engine.applyHistory(record, 'redo');
  assert.deepEqual(handle.proxy.getVertices(), after, 'redo is exact');
});

test('a mask stroke is undoable, and undoing it does not eat the previous sculpt stroke', () => {
  const { engine, handle } = sphereEngine('ball', 0.15, 24);
  engine.setBrush('draw');
  engine.setStrength(1);
  const before = handle.proxy.getVertices().slice();
  for (let i = 0; i < 4; i++) {
    engine.applyDab({ worldRay: { origin: [0, 0.01 * i, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
  }
  const drawRecord = engine.endStroke();
  const sculpted = handle.proxy.getVertices().slice();
  assert.ok(drawRecord);

  engine.setBrush('mask');
  for (let i = 0; i < 6; i++) {
    engine.applyDab({ worldRay: { origin: [0, 0.01 * i, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
  }
  const maskRecord = engine.endStroke();
  assert.ok(maskRecord, 'a mask stroke produces a record of its own');
  assert.equal(maskRecord.type, 'mask');
  const masked = handle.proxy.getMask().slice();
  assert.ok(masked.some((m) => m > 0));

  engine.applyHistory(maskRecord, 'undo');
  assert.ok(handle.proxy.getMask().every((m) => m === 0), 'undo removed the mask');
  assert.deepEqual(handle.proxy.getVertices(), sculpted, 'and left the geometry alone');
  engine.applyHistory(maskRecord, 'redo');
  assert.deepEqual(handle.proxy.getMask(), masked);

  engine.applyHistory(drawRecord, 'undo');
  assert.deepEqual(handle.proxy.getVertices(), before);
});

// ---------------------------------------------------------------- part resolution

test('beginStroke with a 3D point alone works however many parts are attached', () => {
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const near = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 12));
  const far = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 12));
  far.position.set(1, 0, 0);
  far.updateMatrixWorld(true);
  engine.attach(near, { id: 'near' });
  engine.attach(far, { id: 'far' });
  engine.setBrush('grab');
  engine.setRadiusWorld(0.05);

  const stroke = engine.beginStroke({ point3D: [0, 0, 0.15], pressure: 1, timeMs: 0 });
  assert.ok(stroke, 'it does not throw and it finds a part');
  assert.equal(stroke.part, 'near', 'the nearer part wins');
  engine.sampleStroke({ point3D: [0, 0, 0.17], pressure: 1, timeMs: 33 });
  const record = engine.endStroke();
  assert.ok(record && record.part === 'near');

  // A pinch in empty space names no part rather than throwing.
  assert.equal(engine.beginStroke({ point3D: [5, 5, 5], pressure: 1, timeMs: 0 }), null);
});

// ---------------------------------------------------------------- binding space

test('attach refuses a Group child that carries its own transform, and ignores a Mesh overlay', () => {
  const group = new THREE.Group();
  const a = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  b.position.set(0.3, 0, 0);
  group.add(a, b);
  group.updateMatrixWorld(true);

  const engine = createSculptEngine({ handOverrides: false });
  // Bound as-is this welds the two cubes into one 8-vertex body, in the wrong place, silently.
  assert.throws(() => engine.attach(group, { id: 'pair' }), /carries its own transform/);

  b.position.set(0, 0, 0);
  group.updateMatrixWorld(true);
  const ok = engine.attach(group, { id: 'pair' });
  assert.equal(ok.binding.prims.length, 2, 'identity children are the documented multi-material case');

  // The page hangs an identity fresnel overlay that SHARES the part's geometry on the active part.
  const part = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 8));
  const overlay = new THREE.Mesh(part.geometry);
  part.add(overlay);
  part.updateMatrixWorld(true);
  const single = engine.attach(part, { id: 'solo' });
  assert.equal(single.binding.prims.length, 1, 'a Mesh is the part; its children are not bound');
});
