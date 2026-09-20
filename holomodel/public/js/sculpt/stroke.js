// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/paint_stroke.cc
//     (paint_space_stroke_spacing, paint_stroke_overlapped_curve, paint_stroke_integrate_overlap,
//      PaintStroke::space_stroke, paint_smooth_stroke, the first-dab rule in PaintStroke::modal)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// A stroke is not "one dab per input event": Blender walks the path the cursor took and stamps a
// dab every `spacing` percent of the brush DIAMETER, interpolating pressure along the way, and
// scales the strength by an overlap factor so that the total deposit does not depend on spacing.
// We do all of it in world units (Blender's scene-spacing mode), because a hand at 30 Hz moves
// much further between samples than a mouse does, and because there is no single screen here.
//
// Two hand-specific changes, both deliberate:
//   - the lazy-mouse stabiliser runs on the 3D aim point in metres, not on pixels;
//   - its 0.9-per-event pull is normalised to time (1 - 0.9^(dt/8.33 ms)), so a 30 Hz webcam feels
//     like Blender at 120 Hz instead of lagging a third of a second behind the hand.

import { curveStrength } from './factors.js';

/** Blender's event cadence: 0.9 per event at ~120 Hz is the reference for the time normalisation. */
export const LAZY_REFERENCE_MS = 1000 / 120;
export const LAZY_DEFAULT_FACTOR = 0.9;
export const LAZY_DEFAULT_IGNORE_M = 0.003; // 0.3 cm
export const DAB_BUDGET_MS = 6;

/** Step between dabs in world units: spacing% of the diameter (Blender divides the radius by 50). */
export function spacingWorld(radiusWorld, spacingPercent) {
  return Math.max(Number.EPSILON, (radiusWorld * spacingPercent) / 50);
}

/** Summed falloff of evenly spaced stamps at offset x; Blender's paint_stroke_overlapped_curve. */
export function overlappedCurve(preset, x, spacingPercent) {
  const clamped = Math.max(spacingPercent, 0.1);
  const n = Math.trunc(100 / clamped);
  const h = clamped / 50;
  const x0 = x - 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const xx = Math.abs(x0 + i * h);
    if (xx < 1) sum += curveStrength(preset, xx, 1);
  }
  return sum;
}

/**
 * The overlap factor: 1 / the worst summed overlap over 10 sample offsets, so closely spaced dabs
 * do not pile up. Only when space attenuation is on and spacing is below 100%.
 */
export function integrateOverlap(preset, spacingPercent, useSpaceAttenuation = true) {
  if (!(useSpaceAttenuation && spacingPercent < 100)) return 1;
  const m = 10;
  const g = 1 / m;
  let max = 0;
  for (let i = 0; i < m; i++) max = Math.max(max, Math.abs(overlappedCurve(preset, i * g, spacingPercent)));
  return max === 0 ? 1 : 1 / max;
}

/**
 * Time-normalised lazy mouse on the 3D aim point.
 * @returns {{moved: boolean, point: number[], pressure: number}}
 */
export function lazyStep(last, sample, o = {}) {
  const ignore = o.ignore ?? LAZY_DEFAULT_IGNORE_M;
  const factor = o.factor ?? LAZY_DEFAULT_FACTOR;
  const dtMs = Math.max(o.dtMs ?? LAZY_REFERENCE_MS, 0);
  const dx = sample.point[0] - last.point[0];
  const dy = sample.point[1] - last.point[1];
  const dz = sample.point[2] - last.point[2];
  if (Math.hypot(dx, dy, dz) < ignore) return { moved: false, point: last.point.slice(), pressure: last.pressure };
  // 1 - f^(dt/ref): the same pull per unit of time, whatever the sample rate.
  const u = 1 - Math.pow(factor, dtMs / LAZY_REFERENCE_MS);
  return {
    moved: true,
    point: [last.point[0] + dx * u, last.point[1] + dy * u, last.point[2] + dz * u],
    pressure: last.pressure + (sample.pressure - last.pressure) * u,
  };
}

/** Brushes whose feel depends on following the hand exactly; Blender turns lazy mouse off for these. */
export const NO_LAZY_BRUSHES = new Set(['GRAB', 'ELASTIC_DEFORM', 'SNAKE_HOOK', 'THUMB', 'ROTATE', 'POSE', 'BOUNDARY']);

/** Brushes that need a stroke direction before they can do anything, so they skip the first dab. */
export const NEEDS_STROKE_DIRECTION = new Set(['CLAY_STRIPS', 'PLANE', 'PINCH', 'CLAY_THUMB', 'MULTIPLANE_SCRAPE', 'NUDGE', 'SNAKE_HOOK']);

/** Brushes that rebuild from the stroke-start shape every step and apply the total hand delta. */
export const RESTORE_EACH_STEP = new Set(['GRAB', 'THUMB', 'ROTATE', 'ELASTIC_DEFORM']);

/**
 * Walks the hand path and emits dabs.
 *
 * Options: {radiusWorld, spacingPercent, falloff, useSpaceAttenuation, lazy, lazyIgnore,
 *           lazyFactor, skipFirstDab, budgetMs}
 * Each dab is {point, pressure, overlap, first, t} where t is how far along the current segment
 * the dab sits, so the caller can interpolate the eye ray for the raycast.
 */
export class StrokeStepper {
  constructor(o = {}) {
    this.radiusWorld = o.radiusWorld ?? 0.025;
    this.spacingPercent = o.spacingPercent ?? 10;
    this.falloff = o.falloff ?? 'SMOOTH';
    this.useSpaceAttenuation = o.useSpaceAttenuation !== false;
    this.lazy = !!o.lazy;
    this.lazyIgnore = o.lazyIgnore ?? LAZY_DEFAULT_IGNORE_M;
    this.lazyFactor = o.lazyFactor ?? LAZY_DEFAULT_FACTOR;
    this.skipFirstDab = !!o.skipFirstDab;
    // DOTS-style brushes (Grab, Thumb, Rotate...) stamp once per input sample instead of walking
    // the path, which is what Blender's non-space stroke methods do.
    this.spaceStroke = o.spaceStroke !== false;
    this.budgetMs = o.budgetMs ?? DAB_BUDGET_MS;
    this.baseOverlap = integrateOverlap(this.falloff, this.spacingPercent, this.useSpaceAttenuation);
    this.last = null;      // last dab position (world) and pressure
    this.lazyPoint = null; // filtered aim point
    this.dabCount = 0;
  }

  setRadiusWorld(r) {
    this.radiusWorld = r;
  }

  /** First dab, at the stroke start, unless the brush needs a direction first. */
  begin(sample) {
    this.last = { point: sample.point.slice(), pressure: sample.pressure ?? 1, timeMs: sample.timeMs ?? 0 };
    this.lazyPoint = { point: sample.point.slice(), pressure: sample.pressure ?? 1 };
    this.dabCount = 0;
    if (this.skipFirstDab) return [];
    this.dabCount = 1;
    return [{ point: sample.point.slice(), pressure: this.last.pressure, overlap: this.baseOverlap, first: true, t: 0 }];
  }

  /**
   * Feed one input sample. `dabCostMs` (measured by the caller for the previous frame) lets the
   * stepper widen its spacing when a frame would blow the 6 ms dab budget.
   */
  advance(sample, opts = {}) {
    if (!this.last) return this.begin(sample);
    const dtMs = Math.max((sample.timeMs ?? 0) - (this.last.timeMs ?? 0), 0);
    let target = { point: sample.point.slice(), pressure: sample.pressure ?? 1 };
    if (this.lazy) {
      const step = lazyStep(this.lazyPoint, target, { dtMs, ignore: this.lazyIgnore, factor: this.lazyFactor });
      if (!step.moved) {
        this.last.timeMs = sample.timeMs ?? this.last.timeMs;
        return [];
      }
      this.lazyPoint = { point: step.point, pressure: step.pressure };
      target = { point: step.point, pressure: step.pressure };
    } else {
      this.lazyPoint = { point: target.point.slice(), pressure: target.pressure };
    }

    if (!this.spaceStroke) {
      this.last = { point: target.point.slice(), pressure: target.pressure, timeMs: sample.timeMs ?? 0 };
      const first = this.dabCount === 0;
      this.dabCount++;
      return [{ point: target.point.slice(), pressure: target.pressure, overlap: 1, first, t: 1 }];
    }

    const start = this.last.point;
    const segX = target.point[0] - start[0];
    const segY = target.point[1] - start[1];
    const segZ = target.point[2] - start[2];
    const segLength = Math.hypot(segX, segY, segZ);
    if (segLength === 0) {
      this.last.timeMs = sample.timeMs ?? this.last.timeMs;
      return [];
    }

    let spacing = spacingWorld(this.radiusWorld, this.spacingPercent);
    let overlap = this.baseOverlap;
    // Over budget: widen the spacing for this frame only, and renormalise the overlap so the
    // deposit stays the same. Fewer, slightly fatter dabs beat dropping frames.
    const cost = opts.dabCostMs ?? 0;
    if (cost > 0 && this.budgetMs > 0) {
      const wanted = Math.floor(segLength / spacing);
      const affordable = Math.max(1, Math.floor(this.budgetMs / cost));
      if (wanted > affordable) {
        const widenedPercent = (this.spacingPercent * wanted) / affordable;
        spacing = spacingWorld(this.radiusWorld, widenedPercent);
        overlap = integrateOverlap(this.falloff, widenedPercent, this.useSpaceAttenuation);
      }
    }

    const dirX = segX / segLength, dirY = segY / segLength, dirZ = segZ / segLength;
    const dabs = [];
    let remaining = segLength;
    let lastPressure = this.last.pressure;
    let point = start.slice();
    while (remaining >= spacing) {
      const pressure = lastPressure + (spacing / remaining) * (target.pressure - lastPressure);
      point = [point[0] + dirX * spacing, point[1] + dirY * spacing, point[2] + dirZ * spacing];
      const travelled = segLength - remaining + spacing;
      dabs.push({
        point: point.slice(),
        pressure,
        overlap,
        first: this.dabCount === 0 && dabs.length === 0,
        t: travelled / segLength,
      });
      remaining -= spacing;
      lastPressure = pressure;
    }

    if (dabs.length > 0) {
      const lastDab = dabs[dabs.length - 1];
      this.last = { point: lastDab.point.slice(), pressure: lastDab.pressure, timeMs: sample.timeMs ?? 0 };
      this.dabCount += dabs.length;
    } else {
      this.last.timeMs = sample.timeMs ?? this.last.timeMs;
    }
    return dabs;
  }
}
