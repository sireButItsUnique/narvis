// SPDX-License-Identifier: GPL-3.0-or-later
// Brush set B, checked where the golden strokes cannot see: the Kelvinlet constants, which way
// each brush's two components pull, the mask's saturating arithmetic, and the whole-part
// operations (mask ops and mesh filters) that no parity fixture covers at all.
//
// Most tests dab on a flat plane, because there the area normal is exactly +Z: any displacement
// along Z is the "push" part of a brush and anything in the XY plane is its "slide" part, so the
// two can be asserted separately.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  kelvinletParams, kelvinletGrab, kelvinletGrabBiscale, kelvinletGrabTriscale,
  kelvinletScale, kelvinletTwist, KELVINLET_BY_TYPE,
} from '../public/js/sculpt/kelvinlet.js';
import { createSculptEngine } from '../public/js/sculpt/index.js';
import { getBrush, getBrushForPreset } from '../public/js/sculpt/brushes/registry.js';
import setB, { installSetB } from '../public/js/sculpt/brushes/set-b.js';
import {
  maskClear, maskFill, maskInvert, maskGrow, maskShrink, maskBlur, maskSharpen, maskedVertices,
} from '../public/js/sculpt/mask-ops.js';
import { MESH_FILTERS } from '../public/js/sculpt/filters.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const len = (v) => Math.hypot(v[0], v[1], v[2]);

/** A flat 2 x 2 plane in the z = 0 plane, so the area normal under a dab is exactly +Z. */
function planeEngine(segments = 24) {
  const geometry = new THREE.PlaneGeometry(2, 2, segments, segments);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: 'plane' });
  return { engine, handle };
}

/** The settings a dab runs with, in Blender's own field names. */
function settingsFor(over = {}) {
  return {
    name: 'test',
    sculpt_brush_type: 'DRAW',
    strength: 0.5,
    curve_distance_falloff_preset: 'SMOOTH',
    hardness: 0,
    auto_smooth_factor: 0,
    normal_radius_factor: 0.5,
    area_radius_factor: 0.5,
    spacing: 10,
    use_space_attenuation: true,
    use_accumulate: false,
    use_frontface: false,
    falloff_shape: 'SPHERE',
    sculpt_plane: 'AREA',
    use_pressure_strength: true,
    crease_pinch_factor: 0.5,
    rake_factor: 0,
    plane_offset: 0,
    tip_roundness: 1,
    ...over,
  };
}

/** Run dabs down the -Z ray at the given x offsets and return the displacement of every vertex. */
function dabRun(engine, handle, brushKey, settings, dabs) {
  engine.setBrushSettings(settings, brushKey);
  engine.setRadiusWorld(0.4);
  const before = handle.proxy.getVertices().slice();
  for (const d of dabs) {
    engine.applyDab({
      worldRay: { origin: [d.x ?? 0, d.y ?? 0, 2], direction: [0, 0, -1] },
      point3D: [d.x ?? 0, d.y ?? 0, 0],
      pressure: 1,
      overlap: 1,
      settings,
    });
  }
  const after = handle.proxy.getVertices();
  const out = [];
  for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
    out.push({
      i,
      p: [before[3 * i], before[3 * i + 1], before[3 * i + 2]],
      d: [after[3 * i] - before[3 * i], after[3 * i + 1] - before[3 * i + 1], after[3 * i + 2] - before[3 * i + 2]],
    });
  }
  engine.endStroke();
  return out;
}

// ------------------------------------------------------------------ Kelvinlets

test('Kelvinlet parameters follow the regularised elasticity formulas', () => {
  const p = kelvinletParams(0.3, 2, 1, 0.4);
  const a = 1 / (4 * Math.PI);
  assert.ok(close(p.a, a));
  assert.ok(close(p.b, a / (4 * (1 - 0.4))));
  assert.ok(close(p.c, 2 * (3 * p.a - 2 * p.b)));
  assert.equal(p.f, 2);
  // Blender's fixed epsilon ladder: r, 2r, 4r.
  assert.deepEqual(p.radiusScaled, [0.3, 0.6, 1.2]);
  assert.deepEqual(Object.keys(KELVINLET_BY_TYPE).sort(),
    ['GRAB', 'GRAB_BISCALE', 'GRAB_TRISCALE', 'SCALE', 'TWIST']);
});

test('Kelvinlet grab is finite at the pull point, decays, and tightens with more scales', () => {
  const p = kelvinletParams(0.3, 0, 1, 0.4);
  const delta = [1, 0, 0];
  const at = (fn, d) => len(fn([0, 0, 0], p, [d, 0, 0], [0, 0, 0], delta));

  // Regularisation: no singularity where the finger is.
  assert.ok(Number.isFinite(at(kelvinletGrab, 0)));
  assert.ok(at(kelvinletGrab, 0) > 0);

  for (const fn of [kelvinletGrab, kelvinletGrabBiscale, kelvinletGrabTriscale]) {
    let last = Infinity;
    for (const d of [0, 0.1, 0.3, 0.6, 1.2, 2.4]) {
      const v = at(fn, d);
      assert.ok(v <= last + 1e-12, 'the pull never grows with distance');
      last = v;
    }
    // Direction is the pull itself: a grab Kelvinlet only scales the delta.
    const disp = fn([0, 0, 0], p, [0.2, 0.1, 0], [0, 0, 0], delta);
    assert.ok(close(disp[1], 0) && close(disp[2], 0));
  }

  // Far out, subtracting the extra scales leaves a much smaller tail.
  const far = 2.0;
  const one = at(kelvinletGrab, far), two = at(kelvinletGrabBiscale, far), three = at(kelvinletGrabTriscale, far);
  assert.ok(two < one, 'biscale is more local than single scale');
  assert.ok(three < two, 'triscale is more local again');
});

test('Kelvinlet scale is radial and twist is tangential', () => {
  const p = kelvinletParams(0.3, 1, 1, 0.4);
  const axis = [0, 0, 1];
  const pos = [0.2, 0, 0];

  const scale = kelvinletScale([0, 0, 0], p, pos, [0, 0, 0], axis);
  assert.ok(Math.abs(scale[0]) > 0, 'scale pushes along the radius');
  assert.ok(close(scale[1], 0, 1e-12) && close(scale[2], 0, 1e-12));

  const twist = kelvinletTwist([0, 0, 0], p, pos, [0, 0, 0], axis);
  // axis x radius, so for a point on +X and an axis of +Z the swirl is mostly along +/-Y. (The
  // RK4 walk carries the sample off the axis as it integrates, so it is not exactly Y-only.)
  assert.ok(Math.abs(twist[1]) > 10 * Math.abs(twist[0]), 'twist swirls about the axis');
  assert.ok(close(twist[2], 0, 1e-12), 'and never along it');
});

// ------------------------------------------------------------------ brushes

test('set B registers every kernel under its Essentials names', () => {
  assert.equal(setB.length, 8);
  const expected = {
    'Snake Hook': 'snake_hook', Pull: 'snake_hook', 'Elastic Snake Hook': 'snake_hook',
    'Elastic Grab': 'elastic', 'Crease Sharp': 'crease', 'Crease Polish': 'crease', Blob: 'blob',
    'Pinch/Magnify': 'pinch', Mask: 'mask', Nudge: 'nudge', Thumb: 'thumb',
  };
  for (const [preset, key] of Object.entries(expected)) {
    assert.equal(getBrushForPreset(preset)?.key, key, preset);
    assert.ok(getBrush(key), key);
  }
  // The grab family must restore and re-apply, or the pull piles up instead of following the hand.
  for (const key of ['elastic', 'thumb']) {
    assert.equal(getBrush(key).restoreEachStep, true, key);
    assert.equal(getBrush(key).anchoredOrigin, true, key);
  }
  assert.equal(getBrush('elastic').allVertices, true, 'the Kelvinlet has no radius');
  assert.equal(getBrush('mask').noAutoSmooth, true, 'Blender never auto-smooths after Mask');
});

test('Crease pinches sideways while it pushes, and Blob pinches the other way', () => {
  const settings = settingsFor({
    sculpt_brush_type: 'CREASE', strength: 0.6, crease_pinch_factor: 0.8,
    curve_distance_falloff_preset: 'POW4', use_negative_direction: true, use_accumulate: true,
  });
  const { engine, handle } = planeEngine();
  const moved = dabRun(engine, handle, 'crease', settings, [{}]).filter((v) => len(v.d) > 1e-9);
  assert.ok(moved.length > 10);

  let sawInward = false;
  for (const v of moved) {
    const radial = Math.hypot(v.p[0], v.p[1]);
    // Crease digs in: the brush direction is "subtract", so the push is along -Z.
    assert.ok(v.d[2] <= 1e-12, 'crease pushes into the surface');
    if (radial > 1e-6) {
      const towards = -(v.d[0] * v.p[0] + v.d[1] * v.p[1]) / radial;
      assert.ok(towards >= -1e-12, 'the sideways pull is towards the dab, never away');
      if (towards > 1e-9) sawInward = true;
    }
  }
  assert.ok(sawInward, 'the pinch moved something sideways');

  // Blob is the same kernel with the pinch reversed (and Blender's own "add" direction).
  const blobSettings = settingsFor({ sculpt_brush_type: 'BLOB', strength: 0.5, crease_pinch_factor: 0.5 });
  const { engine: e2, handle: h2 } = planeEngine();
  const blob = dabRun(e2, h2, 'blob', blobSettings, [{}]).filter((v) => len(v.d) > 1e-9);
  let sawOutward = false;
  for (const v of blob) {
    assert.ok(v.d[2] >= -1e-12, 'blob pushes out of the surface');
    const radial = Math.hypot(v.p[0], v.p[1]);
    if (radial > 1e-6) {
      const away = (v.d[0] * v.p[0] + v.d[1] * v.p[1]) / radial;
      assert.ok(away >= -1e-12, 'blob relaxes outwards');
      if (away > 1e-9) sawOutward = true;
    }
  }
  assert.ok(sawOutward, 'blob moved something sideways');
});

test('the crease pinch slider scales the sideways pull by its square', () => {
  // Blender divides out the squared UI strength and multiplies the squared pinch factor back in,
  // so doubling the pinch slider quadruples the sideways pull and leaves the push alone.
  const run = (pinch) => {
    const settings = settingsFor({ sculpt_brush_type: 'CREASE', strength: 0.5, crease_pinch_factor: pinch });
    const { engine, handle } = planeEngine();
    return dabRun(engine, handle, 'crease', settings, [{}]);
  };
  const weak = run(0.4);
  const strong = run(0.8);
  let checked = 0;
  for (let i = 0; i < weak.length; i++) {
    const side = (v) => Math.hypot(v.d[0], v.d[1]);
    if (side(weak[i]) < 1e-7) continue;
    assert.ok(close(side(strong[i]) / side(weak[i]), 4, 1e-4), `v${i} pinch ratio`);
    assert.ok(close(strong[i].d[2], weak[i].d[2], 1e-12), `v${i} push changed`);
    checked++;
  }
  assert.ok(checked > 10, 'the pinch moved enough vertices to compare');
});

test('Pinch pulls towards a line along the stroke, not towards a point', () => {
  const settings = settingsFor({ sculpt_brush_type: 'PINCH', strength: 0.8 });
  const { engine, handle } = planeEngine();
  // First dab sets the direction (Blender drops it), second dab does the work; the hand moves +X.
  const run = dabRun(engine, handle, 'pinch', settings, [{ x: 0 }, { x: 0.05 }]);
  const moved = run.filter((v) => len(v.d) > 1e-9);
  assert.ok(moved.length > 10, 'the second dab did something');
  for (const v of moved) {
    // The frame is x = across the stroke, y = along it, z = the normal; the y part is dropped,
    // so on a plane nothing may move along the stroke direction (+X here... the cross product
    // puts "across" in Y).
    const alongStroke = v.d[0];
    assert.ok(close(alongStroke, 0, 1e-12), `v${v.i} moved along the stroke`);
    if (Math.abs(v.p[1]) > 1e-6) {
      assert.ok(v.d[1] * v.p[1] <= 1e-12, 'the cross-stroke pull is inwards');
    }
  }
});

test('Pinch does nothing until the hand has moved', () => {
  const settings = settingsFor({ sculpt_brush_type: 'PINCH', strength: 0.8 });
  const { engine, handle } = planeEngine();
  const run = dabRun(engine, handle, 'pinch', settings, [{ x: 0 }, { x: 0 }]);
  assert.equal(run.filter((v) => len(v.d) > 1e-12).length, 0);
});

test('Nudge and Thumb slide along the surface, never into it', () => {
  for (const [key, type] of [['nudge', 'NUDGE'], ['thumb', 'THUMB']]) {
    const settings = settingsFor({ sculpt_brush_type: type, strength: 0.8, normal_radius_factor: 0.3 });
    const { engine, handle } = planeEngine();
    const run = dabRun(engine, handle, key, settings, [{ x: 0 }, { x: 0.08 }]);
    const moved = run.filter((v) => len(v.d) > 1e-9);
    assert.ok(moved.length > 10, `${key} did something`);
    for (const v of moved) {
      assert.ok(close(v.d[2], 0, 1e-12), `${key} v${v.i} moved along the normal`);
      assert.ok(v.d[0] > 0, `${key} v${v.i} did not follow the hand`);
    }
  }
});

test('Thumb follows the hand instead of piling up', () => {
  // Restoring to the stroke start every step and re-applying the TOTAL delta means two steps of
  // 0.04 land in the same place as one step of 0.08.
  const settings = settingsFor({ sculpt_brush_type: 'THUMB', strength: 0.8, use_pressure_strength: false });
  const a = planeEngine();
  const one = dabRun(a.engine, a.handle, 'thumb', settings, [{ x: 0 }, { x: 0.08 }]);
  const b = planeEngine();
  const two = dabRun(b.engine, b.handle, 'thumb', settings, [{ x: 0 }, { x: 0.04 }, { x: 0.08 }]);
  let worst = 0;
  for (let i = 0; i < one.length; i++) {
    worst = Math.max(worst, len([
      one[i].d[0] - two[i].d[0], one[i].d[1] - two[i].d[1], one[i].d[2] - two[i].d[2],
    ]));
  }
  assert.ok(worst < 1e-9, `two steps drifted from one by ${worst}`);
});

test('Elastic Grab reaches the whole part, with no radius and no falloff curve', () => {
  const settings = settingsFor({
    sculpt_brush_type: 'ELASTIC_DEFORM', strength: 0.5, use_pressure_strength: false,
    elastic_deform_type: 'GRAB_TRISCALE', elastic_deform_volume_preservation: 0.4,
  });
  const { engine, handle } = planeEngine();
  const run = dabRun(engine, handle, 'elastic', settings, [{ x: 0 }, { x: 0.1 }]);
  const radius = engine.getRadiusWorld();
  const outside = run.filter((v) => Math.hypot(v.p[0], v.p[1]) > radius * 2);
  assert.ok(outside.length > 0, 'the plane is bigger than two brush radii');
  assert.ok(outside.every((v) => len(v.d) > 0), 'the elastic field has no edge');
  // The pull is along the hand movement and strongest at the finger.
  const near = run.reduce((best, v) => (Math.hypot(v.p[0], v.p[1]) < Math.hypot(best.p[0], best.p[1]) ? v : best));
  assert.ok(near.d[0] > 0, 'the near vertices follow the hand');
  const far = run.reduce((worst, v) => (len(v.d) < len(worst.d) ? v : worst));
  assert.ok(len(far.d) < len(near.d), 'the far ones move less');
});

test('Snake Hook keeps its grip: the dab centre follows the hand, not the surface', () => {
  const settings = settingsFor({
    sculpt_brush_type: 'SNAKE_HOOK', strength: 1, use_pressure_strength: false,
    crease_pinch_factor: 0.5, rake_factor: 0, snake_hook_deform_type: 'FALLOFF',
  });
  const { engine, handle } = planeEngine(40);
  engine.setBrushSettings(settings, 'snake_hook');
  engine.setRadiusWorld(0.3);
  const dab = (x) => engine.applyDab({
    worldRay: { origin: [x, 0, 2], direction: [0, 0, -1] },
    point3D: [x, 0, 0], pressure: 1, overlap: 1, settings,
  });
  dab(0);      // dropped: no stroke direction yet, but it anchors the centre at x = 0
  dab(0.25);   // centre still at x = 0 (Blender advances by the PREVIOUS step's delta)
  const before = handle.proxy.getVertices().slice();
  dab(0.5);    // centre advances by the last delta, to x = 0.25 - while the ray aims at x = 0.5
  const after = handle.proxy.getVertices();
  let best = -1, bestD = 0;
  for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
    const d = Math.hypot(after[3 * i] - before[3 * i], after[3 * i + 1] - before[3 * i + 1], after[3 * i + 2] - before[3 * i + 2]);
    if (d > bestD) { bestD = d; best = i; }
  }
  engine.endStroke();
  assert.ok(bestD > 0, 'the third dab moved something');
  const x = before[3 * best];
  assert.ok(Math.abs(x - 0.25) < 0.08, `the dab centre sat at x=${x.toFixed(3)}, not with the hand at 0.5`);
});

// ------------------------------------------------------------------ mask

test('the Mask brush saturates towards 1 and erases back towards 0', () => {
  const settings = settingsFor({ sculpt_brush_type: 'MASK', strength: 1, hardness: 0.5 });
  const { engine, handle } = planeEngine();
  engine.setBrushSettings(settings, 'mask');
  engine.setRadiusWorld(0.4);
  const mask = handle.proxy.getMask();
  const paint = () => engine.applyDab({
    worldRay: { origin: [0, 0, 2], direction: [0, 0, -1] }, point3D: [0, 0, 0],
    pressure: 1, overlap: 1, settings,
  });

  paint();
  const first = mask.slice();
  assert.ok(first.some((m) => m > 0.5), 'the middle of the dab is masked');
  assert.ok(first.every((m) => m >= 0 && m <= 1), 'clamped to 0..1');

  paint();
  for (let i = 0; i < mask.length; i++) {
    assert.ok(mask[i] >= first[i] - 1e-12, 'a second dab never un-masks');
    assert.ok(mask[i] <= 1 + 1e-12);
  }
  const partial = [...mask.keys()].find((i) => mask[i] > 0.05 && mask[i] < 0.9);
  assert.ok(partial !== undefined, 'the rim of the dab is a ramp, not a step');

  // Ctrl inverts the brush: erase pulls the same vertices back down.
  engine.setInvert(true);
  const beforeErase = mask.slice();
  paint();
  engine.setInvert(false);
  assert.ok(mask[partial] < beforeErase[partial], 'erasing lowered the mask');
  assert.ok(mask.every((m) => m >= 0), 'erasing never goes below zero');
});

test('a masked vertex is protected from every other brush', () => {
  const settings = settingsFor({ sculpt_brush_type: 'DRAW', strength: 1 });
  const { engine, handle } = planeEngine();
  const mask = handle.proxy.getMask();
  mask.fill(1);
  const run = dabRun(engine, handle, 'draw', settings, [{}]);
  assert.equal(run.filter((v) => len(v.d) > 1e-12).length, 0, 'a fully masked part does not move');
});

test('mask operations: clear, fill, invert, grow, shrink, blur, sharpen', () => {
  const { handle } = planeEngine(12);
  const proxy = handle.proxy;
  const mask = proxy.getMask();
  const n = proxy.getNbVertices();

  maskFill(proxy);
  assert.ok(mask.every((m) => m === 1));
  maskClear(proxy);
  assert.ok(mask.every((m) => m === 0));

  // One masked vertex: grow reaches its ring, shrink takes it back.
  const seed = Math.floor(n / 2);
  mask[seed] = 1;
  const ring = proxy.getVerticesRingVert()[seed];
  assert.ok(ring.length >= 3);
  maskGrow(proxy);
  assert.equal(maskedVertices(proxy).length, 1 + ring.length);
  for (const u of ring) assert.equal(mask[u], 1);
  maskShrink(proxy);
  assert.deepEqual([...maskedVertices(proxy)], [seed], 'shrink walks the boundary back in');

  // Blur turns the step into a ramp without moving the centre off the top.
  maskClear(proxy);
  mask[seed] = 1;
  maskBlur(proxy);
  assert.ok(mask[seed] < 1, 'the peak is averaged down');
  assert.ok(ring.every((u) => mask[u] > 0), 'the ring picked the value up');
  const blurred = mask.slice();
  maskSharpen(proxy);
  for (let i = 0; i < n; i++) {
    if (blurred[i] > 0.5) assert.ok(mask[i] >= blurred[i], 'sharpen pushes the high side up');
    else assert.ok(mask[i] <= blurred[i], 'and the low side down');
  }

  maskFill(proxy, 0.25);
  maskInvert(proxy);
  assert.ok(mask.every((m) => close(m, 0.75, 1e-7)));
});

// ------------------------------------------------------------------ filters

test('mesh filters run over the whole part and respect the mask', () => {
  assert.deepEqual(Object.keys(MESH_FILTERS).sort(), ['inflate', 'scale', 'sharpen', 'smooth']);

  for (const name of Object.keys(MESH_FILTERS)) {
    const { engine, handle } = planeEngine(16);
    installSetB(engine);
    // Roughen the surface so smooth and sharpen have something to work with.
    const positions = handle.proxy.getVertices();
    for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
      positions[3 * i + 2] = 0.02 * Math.sin(37 * positions[3 * i] + 11 * positions[3 * i + 1]);
    }
    handle.proxy.refreshGeometry();
    const mask = handle.proxy.getMask();
    const locked = 3;
    mask[locked] = 1;
    const before = handle.proxy.getVertices().slice();

    const record = engine.filter(name, { strength: 0.5 });
    const after = handle.proxy.getVertices();
    let movedCount = 0;
    for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
      const d = Math.hypot(after[3 * i] - before[3 * i], after[3 * i + 1] - before[3 * i + 1], after[3 * i + 2] - before[3 * i + 2]);
      if (d > 1e-12) movedCount++;
    }
    assert.ok(movedCount > 20, `${name} moved ${movedCount} vertices`);
    assert.ok(close(after[3 * locked], before[3 * locked], 1e-12)
      && close(after[3 * locked + 1], before[3 * locked + 1], 1e-12)
      && close(after[3 * locked + 2], before[3 * locked + 2], 1e-12), `${name} moved a masked vertex`);
    // A filter that moves every vertex gets the compact whole-part record shape (no index array).
    assert.ok(record && record.bytes > 0, `${name} produced an undo record`);
    assert.ok(engine.applyHistory(record, 'undo'), `${name} undo`);
    const undone = handle.proxy.getVertices();
    let worst = 0;
    for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(undone[i] - before[i]));
    assert.ok(worst < 1e-12, `${name} did not undo exactly (${worst})`);
  }
});

test('smooth flattens the surface and sharpen exaggerates it', () => {
  const rough = (proxy) => {
    let sum = 0;
    const p = proxy.getVertices();
    const ring = proxy.getVerticesRingVert();
    for (let v = 0; v < proxy.getNbVertices(); v++) {
      const nb = ring[v];
      if (nb.length === 0) continue;
      let z = 0;
      for (const u of nb) z += p[3 * u + 2];
      sum += Math.abs(p[3 * v + 2] - z / nb.length);
    }
    return sum;
  };
  const build = () => {
    const { engine, handle } = planeEngine(16);
    installSetB(engine);
    const p = handle.proxy.getVertices();
    for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
      p[3 * i + 2] = 0.02 * Math.sin(37 * p[3 * i] + 11 * p[3 * i + 1]);
    }
    handle.proxy.refreshGeometry();
    return { engine, handle, before: rough(handle.proxy) };
  };
  const s = build();
  s.engine.filter('smooth', { strength: 0.8 });
  assert.ok(rough(s.handle.proxy) < s.before, 'smooth reduced the roughness');

  const h = build();
  h.engine.filter('sharpen', { strength: 0.5 });
  assert.ok(rough(h.handle.proxy) > h.before, 'sharpen increased it');
});

test('scale grows the part about its own centre, inflate along the normals', () => {
  const { engine, handle } = planeEngine(10);
  installSetB(engine);
  const before = handle.proxy.getVertices().slice();
  engine.filter('scale', { strength: 0.5 });
  const after = handle.proxy.getVertices();
  for (let i = 0; i < handle.proxy.getNbVertices(); i++) {
    // The plane is centred on the origin, so 1.5x about the centroid is 1.5x about the origin.
    assert.ok(close(after[3 * i], before[3 * i] * 1.5, 1e-6), `v${i} x`);
    assert.ok(close(after[3 * i + 1], before[3 * i + 1] * 1.5, 1e-6), `v${i} y`);
  }

  const flat = planeEngine(10);
  installSetB(flat.engine);
  const z0 = flat.handle.proxy.getVertices().slice();
  flat.engine.filter('inflate', { amount: 0.05 });
  const z1 = flat.handle.proxy.getVertices();
  for (let i = 0; i < flat.handle.proxy.getNbVertices(); i++) {
    assert.ok(close(z1[3 * i] - z0[3 * i], 0, 1e-9), 'a flat part inflates straight up');
    assert.ok(close(z1[3 * i + 2] - z0[3 * i + 2], 0.05, 1e-6), 'by exactly the amount asked for');
  }
});

test('installSetB plugs the whole-part operations into an engine', () => {
  const { engine, handle } = planeEngine(6);
  assert.equal(engine.filter('smooth', {}), null, 'nothing is registered before installSetB');
  assert.equal(engine.maskOp('invert', {}), null);
  assert.equal(installSetB(engine), engine, 'it returns the engine so it chains');
  handle.proxy.getMask().fill(0);
  // A mask op returns an undo record of its own, so "mask the handle" then "undo" removes the mask
  // instead of eating the previous sculpt stroke (Blender pushes undo::Type::Mask here).
  const inverted = engine.maskOp('invert', {});
  assert.equal(inverted.type, 'mask');
  assert.ok(handle.proxy.getMask().every((m) => m === 1));
  assert.ok(engine.applyHistory(inverted, 'undo'));
  assert.ok(handle.proxy.getMask().every((m) => m === 0), 'undoing a mask op restores the mask');
  engine.applyHistory(inverted, 'redo');
  const cleared = engine.maskOp('clear', {});
  assert.equal(cleared.type, 'mask');
  assert.ok(handle.proxy.getMask().every((m) => m === 0));
  // A no-op mask operation has nothing to record.
  assert.equal(engine.maskOp('clear', {}), null);
});
