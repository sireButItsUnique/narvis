// SPDX-License-Identifier: GPL-3.0-or-later
// The engine as the APP drives it, which is not how the parity suite drives it.
//
// Two things differ, and both of them were silently wrong the first time the page was wired up:
//
//   1. The app's world is CENTIMETRES (js/model.js: glTF metres x 100), while the engine's own
//      brush limits are physical - 3 mm to 12 cm. A page that asked for a 2.5 cm brush and got the
//      clamp meant for metres ended up with a 0.12 cm one: a brush 20x too small, which reads as
//      "sculpting does nothing" rather than as a units bug.
//   2. The page smooths a surface that is dozens of units across, not one. Strength, spacing and
//      the falloff all scale with the radius, so a stroke that works at metre scale is worth
//      checking at the scale the box actually uses.
//
// What "smoothing works" means here is measured, not asserted: a bumpy surface gets less bumpy,
// by a number, and the bumps are what shrink rather than the surface as a whole collapsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createSculptEngine } from '../public/js/sculpt/index.js';
import { loadPresets, brushSettings, RADIUS_MAX_M, RADIUS_MIN_M } from '../public/js/sculpt/presets.js';

await loadPresets();

const CM_PER_M = 100;                       // what js/sculpting.js passes as worldUnitsPerMetre

// A flat grid 24 cm across, roughened vertex by vertex: per-vertex noise rather than a wave,
// because that is the shape a smooth brush is actually for and a wave gentle enough to sample
// cleanly is barely rough at all. The hash is fixed, so the surface is the same every run.
const N = 61, EXTENT_CM = 12, BUMP_CM = 0.3;   // +-1.5 mm of bump on a 24 cm patch
const hash = (i, j) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s) - 0.5;              // -0.5 .. 0.5, deterministic
};

function bumpyGridCm() {
  const positions = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -EXTENT_CM + (2 * EXTENT_CM * i) / (N - 1);
      const y = -EXTENT_CM + (2 * EXTENT_CM * j) / (N - 1);
      const k = 3 * (j * N + i);
      positions[k] = x; positions[k + 1] = y; positions[k + 2] = BUMP_CM * hash(i, j);
    }
  }
  const idx = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, b, c, b, d, c);          // wound so the faces look at +Z, where the eye is
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  return g;
}

/** How far each vertex sits from the flat surface its neighbours describe, inside a radius of the
 *  centre: the roughness a smooth brush exists to remove. Grid topology, so no proxy needed. */
function roughnessCm(positions, cx = 0, cy = 0, withinCm = 4) {
  let sum = 0, n = 0;
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const at = (ii, jj) => 3 * (jj * N + ii);
      const k = at(i, j);
      const x = positions[k], y = positions[k + 1];
      if (Math.hypot(x - cx, y - cy) > withinCm) continue;
      const ring = (positions[at(i - 1, j) + 2] + positions[at(i + 1, j) + 2]
                  + positions[at(i, j - 1) + 2] + positions[at(i, j + 1) + 2]) / 4;
      sum += Math.abs(positions[k + 2] - ring);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** The engine set up exactly as js/sculpting.js sets it up. */
function appEngine() {
  const engine = createSculptEngine({ worldUnitsPerMetre: CM_PER_M });
  const handle = engine.attach(bumpyGridCm(), { id: 'grid' });
  engine.setBrush('smooth');
  engine.setBrushSettings({ ...brushSettings('Smooth'), name: 'Smooth' }, 'smooth');
  return { engine, handle, positions: handle.proxy.getVertices() };
}

/** Drag the brush across the middle of the grid, the way a hand does: an eye above it, a ray down. */
function strokeAcross(engine, { fromCm = -3, toCm = 3, steps = 12, y = 0 } = {}) {
  const at = (x) => ({
    worldRay: { origin: [x, y, 40], direction: [0, 0, -1] },
    point3D: [x, y, 0],
    pressure: 1,
  });
  let dabs = 0;
  const started = engine.beginStroke({ ...at(fromCm), timeMs: 0 });
  assert.ok(started, 'the stroke found the surface');
  for (let s = 1; s <= steps; s++) {
    const x = fromCm + ((toCm - fromCm) * s) / steps;
    dabs += engine.sampleStroke({ ...at(x), timeMs: s * 16 });
  }
  const record = engine.endStroke();
  return { dabs, record };
}

test('a centimetre world gets centimetre brushes, not the clamp meant for metres', () => {
  const engine = createSculptEngine({ worldUnitsPerMetre: CM_PER_M });
  assert.equal(engine.setRadiusWorld(2.5), 2.5, 'a 2.5 cm brush stays 2.5 cm');
  assert.equal(engine.setRadiusWorld(0.05), RADIUS_MIN_M * CM_PER_M, 'below 3 mm it clamps up to 3 mm');
  assert.equal(engine.setRadiusWorld(40), RADIUS_MAX_M * CM_PER_M, 'above 12 cm it clamps down to 12 cm');

  // The same engine in metres keeps Blender's own numbers, which is what the parity suite runs on.
  const metres = createSculptEngine();
  assert.equal(metres.setRadiusWorld(0.025), 0.025);
  assert.equal(metres.setRadiusWorld(2.5), RADIUS_MAX_M, 'a metre-world engine still clamps at 12 cm');
});

test('the default radius is in the page\'s own unit too', () => {
  const engine = createSculptEngine({ worldUnitsPerMetre: CM_PER_M });
  assert.equal(engine.getRadiusWorld(), 2.5, '2.5 cm, not 0.025 of a centimetre');
});

test('smoothing a bumpy surface at box scale makes it measurably less bumpy', () => {
  const { engine, positions } = appEngine();
  engine.setRadiusWorld(2.5);                       // the page's default brush, in centimetres
  const before = positions.slice();
  const roughBefore = roughnessCm(before);
  assert.ok(roughBefore > 0.05, `the test surface is bumpy to start with (${roughBefore.toFixed(3)} cm)`);

  const { dabs } = strokeAcross(engine);
  assert.ok(dabs > 0, 'the stroke laid down dabs');

  const roughAfter = roughnessCm(positions);
  assert.ok(roughAfter < roughBefore * 0.7,
    `roughness fell from ${roughBefore.toFixed(3)} to ${roughAfter.toFixed(3)} cm`);

  // It smoothed, it did not deflate: a brush that pushed the whole patch down would also read as
  // "less bumpy" against a neighbour average, so check the surface stayed where it was.
  let sumBefore = 0, sumAfter = 0, n = 0;
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[3 * v], y = positions[3 * v + 1];
    if (Math.hypot(x, y) > 4) continue;
    sumBefore += before[3 * v + 2]; sumAfter += positions[3 * v + 2]; n++;
  }
  assert.ok(Math.abs(sumAfter / n - sumBefore / n) < 0.02,
    `the patch stayed at its own height (mean z ${(sumBefore / n).toFixed(4)} -> ${(sumAfter / n).toFixed(4)} cm)`);
});

test('a brush that missed the clamp fix would not smooth anything, and the test can tell', () => {
  // The bug, reproduced on purpose: the metre-world clamp turns a 2.5 cm brush into a 1.2 mm one,
  // which on a 24 cm grid touches almost nothing. This is what "sculpting does nothing" looked like.
  const engine = createSculptEngine();              // no worldUnitsPerMetre: metres
  const handle = engine.attach(bumpyGridCm(), { id: 'grid' });
  engine.setBrush('smooth');
  engine.setBrushSettings({ ...brushSettings('Smooth'), name: 'Smooth' }, 'smooth');
  const clamped = engine.setRadiusWorld(2.5);
  assert.equal(clamped, RADIUS_MAX_M, 'the metre clamp really does cut a 2.5 cm brush to 0.12');

  const positions = handle.proxy.getVertices();
  const before = positions.slice();
  strokeAcross(engine);
  const moved = countMoved(before, positions);
  assert.ok(moved < 40, `a 1.2 mm brush moves almost nothing on a 24 cm grid (${moved} vertices)`);
});

test('the stroke is undoable exactly, which is what the page banks', () => {
  const { engine, positions } = appEngine();
  engine.setRadiusWorld(2.5);
  const before = positions.slice();
  const { record } = strokeAcross(engine);
  assert.ok(record, 'the stroke produced an undo record');
  assert.ok(countMoved(before, positions) > 200, 'and it moved a good part of the patch');

  engine.applyHistory(record, 'undo');
  assert.equal(countMoved(before, positions), 0, 'undo puts every vertex back exactly');
  engine.applyHistory(record, 'redo');
  assert.ok(countMoved(before, positions) > 200, 'and redo puts the stroke back');
});

test('the smooth brush does not need a pinch point, because a hand may not have one', () => {
  // In mouse mode there is no grip point at all (interaction.js sends point3D: null). Smooth walks
  // the surface under the ray, so it has to work anyway - a null here used to end the stroke.
  const { engine, positions } = appEngine();
  engine.setRadiusWorld(2.5);
  const before = positions.slice();
  const at = (x) => ({ worldRay: { origin: [x, 0, 40], direction: [0, 0, -1] }, point3D: null, pressure: 1 });
  assert.ok(engine.beginStroke({ ...at(-3), timeMs: 0 }));
  for (let s = 1; s <= 12; s++) engine.sampleStroke({ ...at(-3 + s * 0.5), timeMs: s * 16 });
  assert.ok(engine.endStroke(), 'the stroke ended with a record');
  assert.ok(countMoved(before, positions) > 200, 'and it moved the clay');
});

function countMoved(before, after, eps = 1e-9) {
  let n = 0;
  for (let v = 0; v < after.length / 3; v++) {
    if (Math.abs(after[3 * v] - before[3 * v]) > eps
      || Math.abs(after[3 * v + 1] - before[3 * v + 1]) > eps
      || Math.abs(after[3 * v + 2] - before[3 * v + 2]) > eps) n++;
  }
  return n;
}
