// SPDX-License-Identifier: GPL-3.0-or-later
// The stroke engine, checked against the formulas in Blender's paint_stroke.cc. The golden-stroke
// replay cannot cover any of this: it feeds one dab per recorded element, so spacing, the overlap
// factor, the stabiliser and pressure interpolation never run there.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spacingWorld, overlappedCurve, integrateOverlap, lazyStep, StrokeStepper,
  LAZY_REFERENCE_MS, NO_LAZY_BRUSHES, NEEDS_STROKE_DIRECTION, RESTORE_EACH_STEP,
} from '../public/js/sculpt/stroke.js';
import { curveStrength } from '../public/js/sculpt/factors.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('spacing is a percentage of the DIAMETER, in world units', () => {
  // Blender: step = radius * spacing / 50, i.e. 10% spacing = a tenth of the diameter.
  assert.ok(close(spacingWorld(0.025, 10), 0.005));
  assert.ok(close(spacingWorld(0.025, 100), 0.05));
  assert.ok(close(spacingWorld(0.025, 5), 0.0025));
  assert.ok(spacingWorld(0.025, 0) > 0, 'never zero, or the stepper would not terminate');
});

test('the overlapped curve sums evenly spaced stamps', () => {
  // n = 100/spacing stamps, h = spacing/50 apart, summed at offset x with radius 1.
  const spacing = 10;
  const manual = (x) => {
    let sum = 0;
    for (let i = 0; i < Math.trunc(100 / spacing); i++) {
      const xx = Math.abs(x - 1 + i * (spacing / 50));
      if (xx < 1) sum += curveStrength('SMOOTH', xx, 1);
    }
    return sum;
  };
  for (const x of [0, 0.1, 0.35, 0.9]) {
    assert.ok(close(overlappedCurve('SMOOTH', x, spacing), manual(x)), `x=${x}`);
  }
});

test('the overlap factor normalises the deposit against spacing', () => {
  const at = (s) => integrateOverlap('SMOOTH', s);
  // Tighter spacing means more overlap, so a smaller factor.
  assert.ok(at(5) < at(10) && at(10) < at(50), `${at(5)} < ${at(10)} < ${at(50)}`);
  assert.ok(at(10) > 0 && at(10) < 1);
  // Total deposit per unit of travel is spacing-independent: sum of factor/spacing stays flat.
  const deposit = (s) => at(s) / s;
  assert.ok(Math.abs(deposit(5) / deposit(20) - 1) < 0.05, 'deposit per distance is flat across spacings');
  // Off when the brush says so, or when dabs cannot overlap at all.
  assert.equal(integrateOverlap('SMOOTH', 10, false), 1);
  assert.equal(integrateOverlap('SMOOTH', 100), 1);
  assert.equal(integrateOverlap('SMOOTH', 150), 1);
});

test('lazy mouse ignores small moves and is normalised to time', () => {
  const last = { point: [0, 0, 0], pressure: 1 };
  const near = lazyStep(last, { point: [0.001, 0, 0], pressure: 1 }, { dtMs: LAZY_REFERENCE_MS });
  assert.equal(near.moved, false, 'inside the 0.3 cm dead zone the aim point does not move');

  // One reference-length event pulls 10% of the way, like Blender's 0.9 factor.
  const one = lazyStep(last, { point: [0.1, 0, 0], pressure: 1 }, { dtMs: LAZY_REFERENCE_MS });
  assert.ok(one.moved);
  assert.ok(close(one.point[0], 0.1 * 0.1, 1e-12));

  // Twice the time pulls as much as two events would: 1 - 0.9^2 = 0.19.
  const two = lazyStep(last, { point: [0.1, 0, 0], pressure: 1 }, { dtMs: 2 * LAZY_REFERENCE_MS });
  assert.ok(close(two.point[0], 0.1 * (1 - 0.81), 1e-12));

  // A 30 Hz webcam frame is ~4 events' worth, so the hand is not left behind.
  const webcam = lazyStep(last, { point: [0.1, 0, 0], pressure: 1 }, { dtMs: 1000 / 30 });
  assert.ok(webcam.point[0] > 0.3 * 0.1, 'a 33 ms gap catches up most of the way');
  assert.ok(webcam.point[0] < 0.1, 'but never overshoots the sample');

  // Pressure follows the same filter.
  const p = lazyStep({ point: [0, 0, 0], pressure: 0 }, { point: [0.1, 0, 0], pressure: 1 }, { dtMs: LAZY_REFERENCE_MS });
  assert.ok(close(p.pressure, 0.1, 1e-12));
});

test('the stepper stamps the first dab at the stroke start, then every spacing', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false });
  const first = stepper.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 });
  assert.equal(first.length, 1);
  assert.equal(first[0].first, true);
  assert.deepEqual(first[0].point, [0, 0, 0]);

  // 5 mm step: a 26 mm move gives 5 dabs and keeps the remainder.
  const dabs = stepper.advance({ point: [0.026, 0, 0], pressure: 1, timeMs: 33 });
  assert.equal(dabs.length, 5);
  for (let i = 0; i < dabs.length; i++) assert.ok(close(dabs[i].point[0], 0.005 * (i + 1), 1e-9));
  const more = stepper.advance({ point: [0.031, 0, 0], pressure: 1, timeMs: 66 });
  assert.equal(more.length, 1, 'the leftover 1 mm carries over into the next sample');
  assert.ok(close(more[0].point[0], 0.030, 1e-9));
});

test('pressure is interpolated along the path like paint_stroke.cc', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false });
  stepper.begin({ point: [0, 0, 0], pressure: 0, timeMs: 0 });
  const dabs = stepper.advance({ point: [0.021, 0, 0], pressure: 1, timeMs: 33 });
  assert.equal(dabs.length, 4);
  // Blender's recurrence: p += (spacing / remaining) * (target - p), remaining shrinking each dab.
  let p = 0, remaining = 0.021;
  const spacing = 0.005;
  for (const dab of dabs) {
    p += (spacing / remaining) * (1 - p);
    remaining -= spacing;
    assert.ok(close(dab.pressure, p, 1e-9), `${dab.pressure} vs ${p}`);
  }
  assert.ok(dabs[dabs.length - 1].pressure > 0.9, 'pressure climbs to the sample along the path');
});

test('a brush that needs a stroke direction skips the first dab', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false, skipFirstDab: true });
  assert.deepEqual(stepper.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 }), []);
  const dabs = stepper.advance({ point: [0.01, 0, 0], pressure: 1, timeMs: 33 });
  assert.equal(dabs.length, 2);
  assert.equal(dabs[0].first, true, 'the first real dab is still flagged as the first');
});

test('a DOTS brush stamps once per sample instead of walking the path', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false, spaceStroke: false });
  stepper.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 });
  const dabs = stepper.advance({ point: [0.5, 0, 0], pressure: 1, timeMs: 33 });
  assert.equal(dabs.length, 1);
  assert.deepEqual(dabs[0].point, [0.5, 0, 0]);
  assert.equal(dabs[0].overlap, 1);
});

test('over the dab budget the stepper widens spacing and renormalises the overlap', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false, budgetMs: 6 });
  stepper.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 });
  const cheap = stepper.advance({ point: [0.05, 0, 0], pressure: 1, timeMs: 33 }, { dabCostMs: 0.1 });
  assert.equal(cheap.length, 10);
  const stepper2 = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: false, budgetMs: 6 });
  stepper2.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 });
  const dear = stepper2.advance({ point: [0.05, 0, 0], pressure: 1, timeMs: 33 }, { dabCostMs: 2 });
  assert.ok(dear.length <= 3, `expensive dabs are spread out (got ${dear.length})`);
  assert.ok(dear[0].overlap > cheap[0].overlap, 'wider spacing means less overlap to cancel out');
  const reach = dear[dear.length - 1].point[0];
  assert.ok(reach > 0.05 - 0.05 / dear.length && reach <= 0.05, `the stroke still covers the move (reached ${reach})`);
});

test('the stabiliser is off for the brushes Blender turns it off for', () => {
  for (const type of ['GRAB', 'ELASTIC_DEFORM', 'SNAKE_HOOK', 'THUMB', 'ROTATE', 'POSE']) {
    assert.ok(NO_LAZY_BRUSHES.has(type), type);
  }
  assert.ok(!NO_LAZY_BRUSHES.has('DRAW'));
  for (const type of ['CLAY_STRIPS', 'PLANE', 'PINCH', 'NUDGE', 'SNAKE_HOOK']) {
    assert.ok(NEEDS_STROKE_DIRECTION.has(type), type);
  }
  for (const type of ['GRAB', 'THUMB', 'ROTATE', 'ELASTIC_DEFORM']) {
    assert.ok(RESTORE_EACH_STEP.has(type), type);
  }
});

test('the stabiliser smooths the path but keeps the stroke moving', () => {
  const stepper = new StrokeStepper({ radiusWorld: 0.025, spacingPercent: 10, lazy: true });
  stepper.begin({ point: [0, 0, 0], pressure: 1, timeMs: 0 });
  // 30 Hz samples along a straight line with 2 mm of jitter across it.
  let t = 0, dabs = 0, maxOff = 0;
  for (let i = 1; i <= 20; i++) {
    t += 33;
    const jitter = (i % 2 ? 1 : -1) * 0.002;
    for (const dab of stepper.advance({ point: [i * 0.004, jitter, 0], pressure: 1, timeMs: t })) {
      dabs++;
      maxOff = Math.max(maxOff, Math.abs(dab.point[1]));
    }
  }
  assert.ok(dabs > 10, 'the stroke keeps up with the hand');
  assert.ok(maxOff < 0.002, `the jitter is damped (worst ${maxOff.toFixed(5)} m)`);
});
