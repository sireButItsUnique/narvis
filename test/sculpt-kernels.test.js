// SPDX-License-Identifier: GPL-3.0-or-later
// The pieces of the sculpt engine that the golden strokes cannot pin down on their own: the
// falloff curves, the per-brush strength table, how smoothing splits into passes and treats an
// open border, that a mirrored stroke leaves the centre line alone, and that undo is exact.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FALLOFF_PRESETS, curveStrength, applyHardness, brushDistance } from '../public/js/sculpt/factors.js';
import { brushStrength, accumulateFor, SUPPORTS_ACCUMULATE } from '../public/js/sculpt/cache.js';
import { iterationStrengths, interiorNeighbors, neighborAverage } from '../public/js/sculpt/smooth.js';
import { symmetryPasses, symmetryFlags, flipVec, isSymmetryIterationValid } from '../public/js/sculpt/symmetry.js';
import { createSculptEngine } from '../public/js/sculpt/index.js';
import { createBinding } from '../public/js/sculpt/binding.js';
import { SculptorMesh } from '../public/js/sculpt/vendor/SculptorMesh.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('falloff presets match Blender BKE_brush_curve_strength', () => {
  // q = 1 - d/r, so d = r/2 gives q = 0.5.
  const r = 2, d = 1;
  const at = (preset) => curveStrength(preset, d, r);
  assert.ok(close(at('SMOOTH'), 3 * 0.25 - 2 * 0.125));            // 0.5
  assert.ok(close(at('SMOOTHER'), 0.125 * (0.5 * (0.5 * 6 - 15) + 10))); // 0.5
  assert.ok(close(at('SHARP'), 0.25));
  assert.ok(close(at('ROOT'), Math.SQRT1_2));
  assert.ok(close(at('LIN'), 0.5));
  assert.ok(close(at('CONSTANT'), 1));
  assert.ok(close(at('SPHERE'), Math.sqrt(2 * 0.5 - 0.25)));
  assert.ok(close(at('POW4'), 0.0625));
  assert.ok(close(at('INVSQUARE'), 0.5 * 1.5));
  // Every preset is 1 at the centre and 0 at (and beyond) the rim.
  for (const preset of Object.keys(FALLOFF_PRESETS)) {
    assert.ok(close(curveStrength(preset, 0, r), 1), `${preset} at the centre`);
    assert.equal(curveStrength(preset, r, r), 0, `${preset} at the rim`);
    assert.equal(curveStrength(preset, r * 1.5, r), 0, `${preset} outside`);
  }
});

test('hardness flattens the middle of the dab and stretches the rest', () => {
  const r = 1;
  assert.equal(applyHardness(0.4, r, 0), 0.4);           // off: distance untouched
  assert.equal(applyHardness(0.4, r, 0.5), 0);           // inside the hard core
  assert.ok(close(applyHardness(0.75, r, 0.5), 0.5));    // (0.75 - 0.5) / 0.5
  assert.equal(applyHardness(0.4, r, 1), 0);             // fully hard: on or off
  assert.equal(applyHardness(0.999, r, 1), 0);
  assert.equal(curveStrength('SMOOTH', applyHardness(0.4, r, 0.5), r), 1); // flat top
});

test('tube falloff measures distance in the view plane', () => {
  const viewNormal = [0, 0, 1];
  const location = [0, 0, 0];
  assert.ok(close(brushDistance(3, 4, 99, location, 'TUBE', viewNormal), 5));
  assert.ok(close(brushDistance(3, 4, 99, location, 'SPHERE', viewNormal), Math.hypot(3, 4, 99)));
});

test('brush strength table', () => {
  const o = { strength: 0.5, pressure: 1, overlap: 1, flip: 1 };
  const a = 0.25;
  assert.ok(close(brushStrength('DRAW', o), a));
  assert.ok(close(brushStrength('CLAY', o), 0.25 * a));           // (1+ov)/2 = 1
  assert.ok(close(brushStrength('CLAY_STRIPS', o), 0.3 * a));
  assert.ok(close(brushStrength('INFLATE', o), 0.25 * a));
  assert.ok(close(brushStrength('INFLATE', { ...o, flip: -1 }), -0.125 * a));
  assert.ok(close(brushStrength('PINCH', o), a));
  assert.ok(close(brushStrength('PINCH', { ...o, flip: -1 }), -0.25 * a));
  assert.ok(close(brushStrength('SMOOTH', o), a));
  assert.ok(close(brushStrength('PLANE', o), a));
  assert.ok(close(brushStrength('PLANE', { ...o, flip: -1 }), 0.5 * a));
  assert.ok(close(brushStrength('NUDGE', o), a));
  assert.ok(close(brushStrength('THUMB', o), a));
  // Grab-likes use the UNSQUARED strength and ignore pressure.
  assert.ok(close(brushStrength('GRAB', { ...o, pressure: 0.3 }), 0.5));
  assert.ok(close(brushStrength('SNAKE_HOOK', o), 0.5));
  assert.ok(close(brushStrength('ELASTIC_DEFORM', o), 0.5));
  // Pressure curves per brush type.
  assert.ok(close(brushStrength('CLAY', { ...o, pressure: 0.5 }), 0.25 * a * 0.0625));
  assert.ok(close(brushStrength('CLAY_STRIPS', { ...o, pressure: 0.5 }), 0.3 * a * Math.pow(0.5, 1.5)));
  assert.ok(close(brushStrength('DRAW', { ...o, pressure: 0.5 }), a * 0.5));
  assert.ok(close(brushStrength('DRAW', { ...o, usePressureStrength: false, pressure: 0.5 }), a));
  // The overlap factor only reaches the brushes that use it.
  assert.ok(close(brushStrength('DRAW', { ...o, overlap: 0.5 }), a * 0.5));
  assert.ok(close(brushStrength('SMOOTH', { ...o, overlap: 0.5 }), a));
  assert.ok(close(brushStrength('NUDGE', { ...o, overlap: 0.5 }), a * 0.75));
});

test('accumulate rule: only some brushes have the option at all', () => {
  assert.equal(accumulateFor('DRAW', { use_accumulate: false }), false);
  assert.equal(accumulateFor('DRAW', { use_accumulate: true }), true);
  assert.equal(accumulateFor('SMOOTH', { use_accumulate: false }), true, 'Smooth has no accumulate option');
  assert.equal(accumulateFor('GRAB', { use_accumulate: false }), true);
  // Draw Sharp follows the same rule as every other accumulate-off brush in Blender 5.2.1, which
  // is the build the golden fixtures come from: it reads the stroke-start surface. (Blender main
  // @235621e inverts the flag for it; taking main's version costs 5.23% against the golden
  // two-dab stroke where 5.2.1's rule gives 1.17%. See cache.js.)
  assert.equal(accumulateFor('DRAW_SHARP', { use_accumulate: false }), false);
  assert.equal(accumulateFor('DRAW_SHARP', { use_accumulate: true }), true);
  assert.equal(accumulateFor('DRAW', { use_accumulate: false, stroke_method: 'ANCHORED' }), false);
  assert.ok(SUPPORTS_ACCUMULATE.has('CLAY_STRIPS') && !SUPPORTS_ACCUMULATE.has('SMOOTH'));
});

test('smooth splits into floor(4s) full passes plus a partial one', () => {
  assert.deepEqual(iterationStrengths(0), [0]);
  assert.deepEqual(iterationStrengths(0.25), [1, 0], 'the partial pass is always appended, even at 0');
  const s049 = iterationStrengths(0.49);
  assert.equal(s049.length, 2);
  assert.equal(s049[0], 1);
  assert.ok(close(s049[1], 0.96, 1e-6));
  const s1 = iterationStrengths(1);
  assert.deepEqual(s1.slice(0, 4), [1, 1, 1, 1]);
  assert.ok(close(s1[4], 0, 1e-6));
  assert.deepEqual(iterationStrengths(5), iterationStrengths(1), 'strength is clamped to 1');
});

// A 3x3 grid of vertices (4 quads = 8 triangles) with an open border.
function gridProxy() {
  const positions = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) positions.push(x, y, 0);
  const tris = [];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const a = y * 3 + x, b = a + 1, c = a + 3, d = a + 4;
      tris.push(a, b, d, a, d, c);
    }
  }
  const proxy = new SculptorMesh();
  proxy.initFromWelded(Float32Array.from(positions), Uint32Array.from(tris));
  return proxy;
}

test('smoothing uses only border neighbours on a border, and corners never move', () => {
  const proxy = gridProxy();
  const centre = 4;      // the middle of the grid
  const edge = 1;        // middle of the bottom row
  assert.equal(proxy.getVerticesOnEdge()[centre], 0);
  assert.equal(proxy.getVerticesOnEdge()[edge], 1);

  const ring = proxy.getVerticesRingVert();
  assert.deepEqual(interiorNeighbors(proxy, centre).slice().sort(), ring[centre].slice().sort());

  const edgeNb = interiorNeighbors(proxy, edge).slice().sort();
  assert.deepEqual(edgeNb, [0, 2], 'a border vertex only averages along the border');

  // Averaging the border vertex must stay on the border line (y = 0), not sag inwards.
  const eAvg = neighborAverage(proxy, edge);
  assert.ok(close(eAvg[1], 0), 'border average stays on the border');

  // A corner in Blender's sense has exactly two neighbours in total: a lone triangle is all corners.
  const tri = new SculptorMesh();
  tri.initFromWelded(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]));
  for (const v of [0, 1, 2]) {
    assert.deepEqual(interiorNeighbors(tri, v), [], 'a corner is pinned');
    const p = tri.getVertices();
    assert.deepEqual(neighborAverage(tri, v), [p[3 * v], p[3 * v + 1], p[3 * v + 2]], 'a pinned vertex averages to itself');
  }
});

test('symmetry passes follow Blender is_symmetry_iteration_valid', () => {
  assert.deepEqual(symmetryPasses(0), [0]);
  assert.deepEqual(symmetryPasses(symmetryFlags({ x: true })), [0, 1]);
  assert.deepEqual(symmetryPasses(symmetryFlags({ x: true, y: true })), [0, 1, 2, 3]);
  assert.deepEqual(symmetryPasses(5), [0, 1, 4, 5], 'XZ skips the XY pass');
  assert.deepEqual(symmetryPasses(6), [0, 2, 4, 6]);
  assert.equal(isSymmetryIterationValid(3, 5), false);
  assert.deepEqual(flipVec([1, 2, 3], 5), [-1, 2, -3]);
});

function icoEngine(detail = 3) {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: 'ico' });
  return { engine, handle, geometry };
}

test('a mirrored stroke reaches the other side and keeps the centre line on the plane', () => {
  // Blender never skips the passes near the plane (today's sculpt.js does, at 0.3r): it runs both,
  // and the x movement cancels because the mirrored offset has the opposite x. The cancellation is
  // not bit-exact - the second pass weighs the surface the first pass has already moved - so what
  // we check is that the leak is a rounding-level fraction of what the dab deposits.
  const run = (symmetry) => {
    const { engine, handle } = icoEngine(3);
    engine.setBrush('draw');
    engine.setRadiusWorld(0.5);
    engine.setStrength(1);
    engine.setSymmetry({ x: symmetry });
    const before = handle.proxy.getVertices().slice();
    engine.applyDab({ worldRay: { origin: [0.4, 0, 4], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
    const after = handle.proxy.getVertices().slice();
    let moved = 0, movedNegative = 0, worstX = 0, maxDisp = 0;
    for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
      const d = Math.hypot(after[3 * i] - before[3 * i], after[3 * i + 1] - before[3 * i + 1], after[3 * i + 2] - before[3 * i + 2]);
      maxDisp = Math.max(maxDisp, d);
      if (d > 1e-7) {
        moved++;
        if (before[3 * i] < -0.2) movedNegative++;
      }
      if (Math.abs(before[3 * i]) < 1e-6) worstX = Math.max(worstX, Math.abs(after[3 * i] - before[3 * i]));
    }
    return { moved, movedNegative, worstX, maxDisp };
  };
  const off = run(false);
  const on = run(true);
  assert.ok(off.moved > 0, 'the dab did something');
  assert.equal(off.movedNegative, 0, 'without symmetry nothing happens on the far side');
  assert.ok(on.movedNegative > 0, 'the mirrored dab reached the other side');
  assert.ok(on.worstX < 0.03 * on.maxDisp, `centre line stays on the plane (leak ${(on.worstX / on.maxDisp * 100).toFixed(2)}% of the dab)`);
});

test('undo puts every touched vertex back exactly, and redo repeats the stroke', () => {
  const { engine, handle } = icoEngine(3);
  engine.setBrush('draw');
  engine.setRadiusWorld(0.4);
  engine.setStrength(0.8);
  const before = handle.proxy.getVertices().slice();
  for (let k = 0; k < 4; k++) {
    engine.applyDab({
      worldRay: { origin: [0.1 * k, 0.05 * k, 4], direction: [0, 0, -1] },
      pressure: 1,
      overlap: 1,
    });
  }
  const record = engine.endStroke();
  assert.ok(record, 'the stroke produced an undo record');
  assert.equal(record.part, 'ico');
  assert.ok(record.idx.length > 0);
  assert.equal(record.before.length, record.idx.length * 3);
  const after = handle.proxy.getVertices().slice();
  assert.notDeepEqual(after, before);

  engine.applyHistory(record, 'undo');
  assert.deepEqual(handle.proxy.getVertices(), before, 'undo is exact');

  engine.applyHistory(record, 'redo');
  assert.deepEqual(handle.proxy.getVertices(), after, 'redo is exact');

  // Only touched vertices are in the record, and each appears once.
  assert.equal(new Set(record.idx).size, record.idx.length);
  for (let k = 0; k < record.idx.length; k++) {
    const v = record.idx[k];
    const movedBefore = Math.hypot(after[3 * v] - before[3 * v], after[3 * v + 1] - before[3 * v + 1], after[3 * v + 2] - before[3 * v + 2]);
    assert.ok(movedBefore > 0, 'the record only holds vertices that actually moved');
  }
});

test('a dab on a 150k-triangle part fits in the 6 ms frame budget', () => {
  // A Fable part at export density: 150k triangles, 25 mm brush, the default Draw settings.
  const geometry = new THREE.SphereGeometry(0.15, 400, 200);
  const triangles = geometry.getIndex().count / 3;
  assert.ok(triangles > 140000, `${triangles} triangles`);
  const engine = createSculptEngine();
  const t0 = performance.now();
  const handle = engine.attach(geometry, { id: 'big' });
  const buildMs = performance.now() - t0;

  const run = (brush, dabs) => {
    engine.setBrush(brush);
    engine.setRadiusWorld(0.025);
    const times = [];
    for (let i = 0; i < dabs; i++) {
      const x = 0.02 * Math.sin(i * 0.4), y = 0.02 * Math.cos(i * 0.4);
      const t = performance.now();
      engine.applyDab({ worldRay: { origin: [x, y, 1], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
      times.push(performance.now() - t);
    }
    engine.endStroke();
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], worst: times[times.length - 1] };
  };

  const draw = run('draw', 20);
  const smooth = run('smooth', 20);
  console.log(`  proxy build ${buildMs.toFixed(0)} ms for ${triangles} triangles (${handle.proxy.getNbVertices()} welded verts)`);
  console.log(`  draw dab   median ${draw.median.toFixed(2)} ms  worst ${draw.worst.toFixed(2)} ms`);
  console.log(`  smooth dab median ${smooth.median.toFixed(2)} ms  worst ${smooth.worst.toFixed(2)} ms`);
  assert.ok(draw.median < 6, `draw dab ${draw.median.toFixed(2)} ms is over the 6 ms budget`);
  assert.ok(smooth.median < 6, `smooth dab ${smooth.median.toFixed(2)} ms is over the 6 ms budget`);
});

test('the render binding survives a stroke and the proxy stays welded', () => {
  const geometry = new THREE.IcosahedronGeometry(1, 2); // non-indexed, every triangle its own verts
  const binding = createBinding(geometry);
  assert.ok(binding.proxyCount < binding.renderCount, 'duplicate corners welded');
  assert.equal(binding.triangles.length / 3, binding.proxyTriCount);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: 'ico' });
  engine.setBrush('draw');
  engine.setRadiusWorld(0.6);
  engine.applyDab({ worldRay: { origin: [0, 0, 4], direction: [0, 0, -1] }, pressure: 1, overlap: 1 });
  engine.endStroke();
  const pos = geometry.getAttribute('position');
  assert.ok(pos.version > 0, 'the render buffer was marked for upload');
  assert.ok(pos.updateRanges.length > 0, 'and only a range of it');
  // every render copy equals its proxy vertex
  const proxyPos = handle.proxy.getVertices();
  for (let r = 0; r < handle.binding.renderCount; r++) {
    const v = handle.binding.renderToProxy[r];
    assert.ok(close(pos.array[3 * r], proxyPos[3 * v], 1e-6));
  }
});
