// SPDX-License-Identifier: GPL-3.0-or-later
// Kernel tests for brush set A: Clay Strips, the Plane family, Clay, Layer and Draw Sharp.
//
// The parity suite proves these agree with real Blender on real strokes; this one pins the
// BEHAVIOUR that makes each brush the brush it is, on a flat grid where every number can be worked
// out by hand. A flat grid seen from straight above gives an area normal of exactly +Z and a
// brush-local box whose axes are exactly the world axes, so the maths below is checkable:
//
//   n = +Z, stroke along +X  =>  box x = n x g = +Y, box y = n x boxx = -X, box z = -n = -Z
//
// so a vertex's local z is how far it sits BELOW the brush plane, in radii.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createSculptEngine } from '../public/js/sculpt/index.js';
import { getBrush, getBrushForPreset, brushKeys } from '../public/js/sculpt/brushes/registry.js';
import { loadPresets, brushSettings } from '../public/js/sculpt/presets.js';
import { localFrame, cubeDistance } from '../public/js/sculpt/brushes/brush-frame.js';

await loadPresets();

const RADIUS = 0.3;

/** A flat N x N grid on z = height(x, y), spanning [-EXTENT, EXTENT]. */
function grid(n = 41, extent = 1.2, height = () => 0) {
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -extent + (2 * extent * i) / (n - 1);
      const y = -extent + (2 * extent * j) / (n - 1);
      const k = 3 * (j * n + i);
      positions[k] = x; positions[k + 1] = y; positions[k + 2] = height(x, y);
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, c, b, d, c); // wound so the face normals point at +Z, towards the eye
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
  return geometry;
}

/** An engine with Blender's own settings (hand overrides OFF) attached to one part. */
function rig(presetName, overrides = {}, geometry = grid()) {
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: 'grid' });
  const settings = { ...brushSettings(presetName, { overrides: false }), ...overrides, name: presetName };
  engine.setBrushSettings(settings);
  engine.setRadiusWorld(RADIUS);
  return { engine, handle, settings, positions: handle.proxy.getVertices() };
}

/** A dab straight down at (x, y). Brushes that need a stroke direction get it along +X. */
function dabAt(engine, settings, x, y) {
  return engine.applyDab({
    worldRay: { origin: [x, y, 2], direction: [0, 0, -1] },
    point3D: [x, y, 0],
    pressure: 1,
    overlap: 1,
    settings,
  });
}

/** Displacement of every vertex that moved, as {index, dx, dy, dz, len}. */
function moved(positions, before, eps = 1e-9) {
  const out = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const dx = positions[3 * v] - before[3 * v];
    const dy = positions[3 * v + 1] - before[3 * v + 1];
    const dz = positions[3 * v + 2] - before[3 * v + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len > eps) out.push({ v, dx, dy, dz, len });
  }
  return out;
}

// --------------------------------------------------------------------- the shared brush box

test('the square tip: cube distance', () => {
  // roundness 1 is an ordinary round tip - the distance is just how far out you are.
  assert.ok(Math.abs(cubeDistance(0.6, 0, 1) - 0.6) < 1e-6);
  assert.ok(Math.abs(cubeDistance(0.3, 0.4, 1) - 0.5) < 1e-6);
  // roundness 0 is a perfect square: full strength everywhere inside, nothing outside.
  assert.equal(cubeDistance(0.99, 0.99, 0), 0);
  assert.equal(cubeDistance(1.01, 0, 0), 1);
  // Clay Strips' own 0.15: a flat top out to 0.85, then the rounded border over the last 0.15.
  assert.equal(cubeDistance(0.8, 0.8, 0.15), 0);
  assert.ok(Math.abs(cubeDistance(0.925, 0, 0.15) - 0.5) < 1e-6);
  assert.ok(Math.abs(cubeDistance(1.0, 0, 0.15) - 1) < 1e-6);
  // the corner is further out than either edge, which is what rounds the corners off
  assert.ok(cubeDistance(0.95, 0.95, 0.15) > cubeDistance(0.95, 0, 0.15));
  // outside the unit square the distance saturates, so the radius filter drops the vertex
  assert.equal(cubeDistance(2, 0, 0.5), 1);
});

test('the brush box: axes, scale and the degenerate stroke', () => {
  const n = [0, 0, 1];
  const g = [1, 0, 0];
  const f = localFrame(n, g, [0, 0, 0], 0.3);
  const out = [0, 0, 0];
  // one unit of each axis is one radius
  f.local(0, 0.3, 0, out);
  assert.ok(Math.abs(out[0] - 1) < 1e-6 && Math.abs(out[1]) < 1e-6, 'box x is n x g');
  f.local(-0.3, 0, 0, out);
  assert.ok(Math.abs(out[1] - 1) < 1e-6, 'box y is n x boxx');
  f.local(0, 0, 0.3, out);
  assert.ok(Math.abs(out[2] - 1) < 1e-6, 'box z is the normal when it is not flipped');

  // flipZ turns "below the plane" into positive z, which is what Clay Strips works in
  const flipped = localFrame(n, g, [0, 0, 0], 0.3, { flipZ: true });
  flipped.local(0, 0, -0.3, out);
  assert.ok(Math.abs(out[2] - 1) < 1e-6);

  // tip_scale_x stretches the box along the stroke, so the same point reads as nearer the centre
  const wide = localFrame(n, g, [0, 0, 0], 0.3, { scaleY: 2 });
  wide.local(-0.3, 0, 0, out);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-6);

  // a hand moving straight along the normal gives no "across the stroke" direction at all;
  // Blender's matrix would be singular there, so we refuse the dab instead of inventing one
  assert.equal(localFrame(n, [0, 0, 1], [0, 0, 0], 0.3), null);
  assert.equal(localFrame(n, [0, 0, 0], [0, 0, 0], 0.3), null);
});

// --------------------------------------------------------------------- Clay Strips

test('Clay Strips: a square-edged ribbon with a depth parabola', () => {
  const { engine, handle, settings, positions } = rig('Clay Strips');
  const before = Float32Array.from(positions);
  dabAt(engine, settings, -0.05, 0); // first dab only sets the direction
  dabAt(engine, settings, 0, 0);
  const hits = moved(positions, before);
  assert.ok(hits.length > 0, 'the strip deposited something');

  // Every vertex moves along the area normal of a flat grid, which is exactly +Z.
  for (const h of hits) {
    assert.ok(Math.abs(h.dx) < 1e-9 && Math.abs(h.dy) < 1e-9, 'the strip pushes along the normal only');
    assert.ok(h.dz > 0, 'a positive strength deposits clay rather than carving it');
  }

  // The tip is SQUARE, not round: with tip_roundness 0.15 the corner of the box at 45 degrees is
  // beyond the tip while a point the same distance out along the box's x axis is still inside.
  // Box x is +Y here, so compare a vertex out along Y with one out along the diagonal.
  const p = before;
  const at = (x, y) => {
    let best = null, bestD = Infinity;
    for (const h of hits) {
      const d = Math.hypot(p[3 * h.v] - x, p[3 * h.v + 1] - y);
      if (d < bestD) { bestD = d; best = h; }
    }
    return bestD < 0.04 ? best : null;
  };
  const alongBoxX = at(0, 0.24); // 0.8 radii out along the box's x axis: inside the flat top
  assert.ok(alongBoxX, 'a vertex 0.8 radii along the tip is still in the strip');
  const diagonal = at(0.27, 0.27); // 0.9 radii on each axis: past the rounded corner
  assert.ok(!diagonal, 'the corner of the square tip is rounded off, so this one is outside');

  // The depth parabola, exactly. On a flat grid the plane sits plane_offset (0.15) of a radius
  // above every vertex, so each one has local z = 0.15 and the parabola contributes 0.15 * 0.85.
  // The vertex under the cursor has cube distance 0, so its curve factor is 1 and nothing else is
  // left: its whole move is radius * bstrength * z(1 - z).
  const z = settings.plane_offset;
  const bstrength = 0.3 * settings.strength ** 2; // Blender's CLAY_STRIPS row at pressure 1
  const expected = RADIUS * bstrength * z * (1 - z);
  const centre = hits.find((h) => Math.hypot(before[3 * h.v], before[3 * h.v + 1]) < 1e-6);
  assert.ok(centre, 'the vertex under the cursor moved');
  assert.ok(Math.abs(centre.dz - expected) < 1e-9, `centre moved ${centre.dz}, expected ${expected}`);

  // The parabola is what stops the brush digging: a vertex a full radius below the plane, like one
  // on the plane, gets nothing. Both ends are zero and the clay goes in the band between.
  assert.equal(Math.max(0, 0 * (1 - 0)), 0);
  assert.equal(Math.max(0, 1 * (1 - 1)), 0);
  assert.ok(handle.proxy.getTouched().length > 0, 'the kernel announced its own gather for undo');
});

// --------------------------------------------------------------------- the Plane family

test('the Plane family: height and depth pick which side is touched', () => {
  // A wavy surface so there is material both above and below the brush plane.
  const wave = (x) => 0.04 * Math.sin((x * Math.PI) / 0.25);
  const run = (preset) => {
    const r = rig(preset, {}, grid(61, 1.2, wave));
    const before = Float32Array.from(r.positions);
    dabAt(r.engine, r.settings, -0.05, 0);
    dabAt(r.engine, r.settings, 0, 0);
    const hits = moved(r.positions, before);
    return { hits, up: hits.filter((h) => h.dz > 1e-9).length, down: hits.filter((h) => h.dz < -1e-9).length };
  };

  // Scrape/Fill is height 1, depth 0: it only shaves what sticks UP.
  const scrape = run('Scrape/Fill');
  assert.ok(scrape.down > 0, 'Scrape takes material off');
  assert.equal(scrape.up, 0, 'Scrape never fills, because depth is 0');

  // Fill/Deepen is height 0, depth 1: the mirror image.
  const fill = run('Fill/Deepen');
  assert.ok(fill.up > 0, 'Fill raises the hollows');
  assert.equal(fill.down, 0, 'Fill never shaves, because height is 0');

  // Flatten/Contrast is height 1, depth 1: it does both, which is what flattening is.
  const flatten = run('Flatten/Contrast');
  assert.ok(flatten.up > 0 && flatten.down > 0, 'Flatten works on both sides at once');

  // Every plane preset is the same kernel.
  for (const name of ['Flatten/Contrast', 'Scrape/Fill', 'Fill/Deepen', 'Plateau', 'Trim']) {
    assert.equal(getBrushForPreset(name).key, 'plane', `${name} is a preset of the plane kernel`);
  }
});

test('the Plane family: Flatten really does flatten', () => {
  const wave = (x) => 0.04 * Math.sin((x * Math.PI) / 0.25);
  const r = rig('Flatten/Contrast', {}, grid(61, 1.2, wave));
  const before = Float32Array.from(r.positions);
  // The hand has to keep moving: a Plane dab with no stroke direction has no box to work in, so
  // Blender does nothing at all with it. Nudging 4 mm between dabs keeps the brush over the same
  // patch while still giving it a direction.
  for (let i = 0; i < 13; i++) dabAt(r.engine, r.settings, (i % 2) * 0.004, 0);
  assert.ok(moved(r.positions, before).length > 20, 'the dab covered a patch of the wave');

  // "Flatter" is the spread of the patch under the brush about its own mean, before and after.
  const inner = [];
  for (let v = 0; v < before.length / 3; v++) {
    if (Math.hypot(before[3 * v], before[3 * v + 1]) < 0.12) inner.push(v);
  }
  const spread = (src) => {
    const zs = inner.map((v) => src[3 * v + 2]);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    return Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length);
  };
  const was = spread(before);
  const now = spread(r.positions);
  assert.ok(now < was * 0.8, `the patch should be flatter: spread went ${was} -> ${now}`);
  assert.ok(now > 0, 'and it converges towards the plane rather than inverting the surface');
});

// --------------------------------------------------------------------- Clay

test('Clay: pulls towards a plane held above the cursor', () => {
  const { engine, settings, positions, handle } = rig('Clay');
  const before = Float32Array.from(positions);
  dabAt(engine, settings, 0, 0);
  const hits = moved(positions, before);
  assert.ok(hits.length > 0);

  // The plane sits |initial_radius * plane_offset| above the point under the cursor, so on a flat
  // grid every vertex in the dab rises towards it.
  const displace = RADIUS * settings.plane_offset;
  assert.ok(Math.abs(displace - 0.12) < 1e-9, 'Essentials Clay holds its plane 0.4 radii up');
  for (const h of hits) assert.ok(h.dz > 0, 'clay is added, not carved');

  // The centre vertex travels its own distance to the plane, times the strength and its weight,
  // and its weight is 1 at the very centre: dz = displace * bstrength.
  const bstrength = 0.25 * settings.strength ** 2; // Blender's CLAY row at pressure 1, overlap 1
  const centre = hits.find((h) => Math.hypot(before[3 * h.v], before[3 * h.v + 1]) < 1e-6);
  assert.ok(centre, 'the vertex under the cursor moved');
  assert.ok(Math.abs(centre.dz - displace * bstrength) < 1e-6,
    `centre moved ${centre.dz}, expected ${displace * bstrength}`);

  // And it is the STROKE-START radius that sets how high the plane hangs, not the current one.
  // The plane rides on the live surface, so a second dab at the centre always sees the same
  // 0.12 gap and deposits the same amount again - even after the brush is grown mid stroke.
  // If the plane used the CURRENT radius it would jump to 0.24 and the dab would double.
  assert.equal(handle._cache.initialRadius, RADIUS);
  engine.setRadiusWorld(RADIUS * 2);
  const b2 = Float32Array.from(positions);
  dabAt(engine, settings, 0, 0);
  const centre2 = moved(positions, b2).find((h) => Math.hypot(b2[3 * h.v], b2[3 * h.v + 1]) < 1e-6);
  assert.equal(handle._cache.initialRadius, RADIUS, 'the stroke keeps the radius it started with');
  assert.ok(Math.abs(centre2.dz - centre.dz) < 1e-6,
    `growing the brush mid stroke changed the layer: ${centre.dz} then ${centre2.dz}`);
});

// --------------------------------------------------------------------- Layer

test('Layer: a slab that plateaus at exactly height', () => {
  const { engine, settings, positions } = rig('Layer');
  const before = Float32Array.from(positions);
  const height = settings.height;
  assert.ok(Math.abs(height - 0.05) < 1e-9, 'Essentials Layer is 0.05 m thick');

  let last = 0;
  for (let i = 0; i < 40; i++) {
    dabAt(engine, settings, 0, 0);
    const hits = moved(positions, before);
    const top = Math.max(...hits.map((h) => h.dz));
    assert.ok(top <= height + 1e-6, `dab ${i} overshot the layer: ${top} > ${height}`);
    assert.ok(top >= last - 1e-9, 'the layer only ever grows');
    last = top;
  }
  assert.ok(Math.abs(last - height) < 1e-4, `the layer plateaued at ${last}, expected ${height}`);

  // The approach follows Blender's recurrence d += f * strength * (1.05 - |d|), and at the centre
  // f is 1, so the first dab of a strength-1 brush lands at 1.05 of the way - clamped to 1... which
  // is why the very first dab already reaches the full height at the centre.
  const r2 = rig('Layer');
  const b2 = Float32Array.from(r2.positions);
  dabAt(r2.engine, r2.settings, 0, 0);
  const centre = moved(r2.positions, b2).find((h) => Math.hypot(b2[3 * h.v], b2[3 * h.v + 1]) < 1e-6);
  const bstrength = r2.settings.strength ** 2;
  const expected = Math.min(1, bstrength * 1.05) * height;
  assert.ok(Math.abs(centre.dz - expected) < 1e-6, `centre ${centre.dz}, expected ${expected}`);
});

test('Layer: a mask shortens the layer instead of delaying it', () => {
  const { engine, handle, settings, positions } = rig('Layer');
  const mask = handle.proxy.getMask();
  const centreVert = (() => {
    for (let v = 0; v < positions.length / 3; v++) {
      if (Math.hypot(positions[3 * v], positions[3 * v + 1]) < 1e-6) return v;
    }
    return -1;
  })();
  assert.ok(centreVert >= 0);
  mask[centreVert] = 0.5;
  const before = Float32Array.from(positions);
  for (let i = 0; i < 30; i++) dabAt(engine, settings, 0, 0);
  const dz = positions[3 * centreVert + 2] - before[3 * centreVert + 2];
  // (1 - mask) caps both the weight and the layer, so a half-masked vertex ends at a quarter height
  assert.ok(dz > 0 && dz < settings.height * 0.51, `half-masked vertex reached ${dz}`);
});

// --------------------------------------------------------------------- Draw Sharp

test('Draw Sharp: carves inward, POW4, and weighs the stroke-start shape', () => {
  const preset = brushSettings('Draw Sharp', { overrides: false });
  // Measured headless from the Essentials library: Draw Sharp, Crease Sharp and Crease Polish are
  // the only mesh sculpt brushes whose direction is not the default, so they subtract.
  assert.equal(preset.use_negative_direction, true);
  assert.equal(preset.curve_distance_falloff_preset, 'POW4');

  const { engine, settings, positions } = rig('Draw Sharp');
  const before = Float32Array.from(positions);
  dabAt(engine, settings, 0, 0);
  const first = moved(positions, before).map((h) => ({ v: h.v, dz: h.dz }));
  assert.ok(first.length > 0);
  for (const h of first) assert.ok(h.dz < 0, 'Draw Sharp cuts a crease rather than raising a bump');

  // Because both the dab's raycast and its weights read the stroke-start shape, a second identical
  // dab deposits exactly the same amount again. A brush that weighed the LIVE surface would not.
  dabAt(engine, settings, 0, 0);
  for (const h of first) {
    const total = positions[3 * h.v + 2] - before[3 * h.v + 2];
    assert.ok(Math.abs(total - 2 * h.dz) < 1e-7,
      `vertex ${h.v}: two dabs gave ${total}, twice one dab is ${2 * h.dz}`);
  }

  // Contrast: Draw weighs the live surface, so its second dab is not a repeat of the first.
  const d = rig('Draw');
  const db = Float32Array.from(d.positions);
  dabAt(d.engine, d.settings, 0, 0);
  const one = d.positions[3 * 0 + 2];
  const drawFirst = moved(d.positions, db).reduce((a, h) => (h.len > a.len ? h : a));
  dabAt(d.engine, d.settings, 0, 0);
  const drawTotal = d.positions[3 * drawFirst.v + 2] - db[3 * drawFirst.v + 2];
  assert.ok(Math.abs(drawTotal - 2 * drawFirst.dz) > 1e-9, 'Draw does not simply repeat itself');
  assert.ok(Number.isFinite(one));
});

// --------------------------------------------------------------------- registry

test('set A is registered, once, under Blender\'s own brush names', () => {
  for (const key of ['clay_strips', 'plane', 'clay', 'layer', 'draw_sharp']) {
    const brush = getBrush(key);
    assert.ok(brush, `${key} is in the registry`);
    assert.equal(typeof brush.apply, 'function');
    assert.ok(brush.presets.length > 0);
  }
  assert.equal(getBrushForPreset('Clay Strips').key, 'clay_strips');
  assert.equal(getBrushForPreset('Layer').key, 'layer');
  assert.equal(getBrushForPreset('Draw Sharp').key, 'draw_sharp');
  assert.equal(getBrushForPreset('Clay').key, 'clay');
  // the four core brushes plus set A, and no duplicates
  const keys = brushKeys();
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['draw', 'smooth', 'grab', 'inflate']) assert.ok(keys.includes(k));
});

test('the brushes that need a stroke direction skip their first dab', () => {
  // Flatten needs something to flatten, so it gets the wavy grid; Clay Strips deposits on anything.
  const wave = (x) => 0.04 * Math.sin((x * Math.PI) / 0.25);
  for (const [preset, geometry] of [['Clay Strips', grid()], ['Flatten/Contrast', grid(61, 1.2, wave)]]) {
    const { engine, settings, positions } = rig(preset, {}, geometry);
    const before = Float32Array.from(positions);
    dabAt(engine, settings, 0, 0);
    assert.equal(moved(positions, before).length, 0, `${preset} has no box to work in until the hand moves`);
    dabAt(engine, settings, 0.05, 0);
    assert.ok(moved(positions, before).length > 0, `${preset} works once it has a direction`);
  }
});
