// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (StrokeCache, object_space_radius_get, brush_strength, brush_flip,
//      calc_area_normal_and_center + area_normal_calc_weight + area_center_calc_weighted,
//      calc_stabilized_plane, calc_sculpt_normal / update_sculpt_normal, calc_brush_plane,
//      brush_plane_offset_get, brush_delta_update)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// The StrokeCache is everything a dab needs that is not per-vertex: where it landed, how big it is
// in part-local metres, how strong it is for this brush type, which way "out" is (the area normal),
// where the brush plane sits, and how far the hand has dragged since the stroke started.

import { brushDistance } from './factors.js';

const MAX_PLANE_ROLLING_AVERAGE = 20;

/** A fresh stroke cache. World units come in; everything stored here is part-local. */
export function createCache(init = {}) {
  return {
    location: [0, 0, 0],
    locationSymm: [0, 0, 0],
    lastLocation: [0, 0, 0],
    lastLocationSymm: [0, 0, 0],
    initialLocation: [0, 0, 0],
    initialLocationSymm: [0, 0, 0],
    initialNormal: [0, 0, 1],
    initialNormalSymm: [0, 0, 1],
    viewNormal: [0, 0, 1],
    viewNormalSymm: [0, 0, 1],
    sculptNormal: [0, 0, 1],
    sculptNormalSymm: [0, 0, 1],
    grabDelta: [0, 0, 0],
    grabDeltaSymm: [0, 0, 0],
    origGrabLocation: [0, 0, 0],
    oldGrabLocation: [0, 0, 0],
    // Blender's StrokeCache::last_center is zero-initialised and only written by calc_brush_plane,
    // which a cube-tip brush never reaches on the step it drops - so "original plane" really does
    // freeze such a brush to a plane through the object origin. areaCenter mirrors r_area_co.
    areaCenter: [0, 0, 0],
    areaCenterSymm: [0, 0, 0],
    lastCenter: [0, 0, 0],
    // Blender's stroke_is_first_brush_step_of_symmetry_pass, kept as its own flag: firstTime is
    // cleared on the dab a direction-needing brush drops, long before any area data exists.
    areaDataValid: false,
    planeBrush: { firstTime: true, normals: [], centers: [], normalIndex: 0, centerIndex: 0, lastNormal: null, lastCenter: null },
    radius: 0.05,
    radiusSquared: 0.0025,
    initialRadius: 0.05,
    pressure: 1,
    hardness: 0,
    bstrength: 0,
    baseStrength: 0,
    overlap: 1,
    invert: false,
    initialDirectionFlipped: false,
    firstTime: true,
    mirrorSymmetryPass: 0,
    strokeStep: 0,
    detailDirections: null,
    layerDisplacement: null,
    ...init,
  };
}

/**
 * Brushes that offer the Accumulate option at all (Blender's bke::brush::supports_accumulate).
 * This matters more than it looks: "accumulate off" is what makes a dab read the shape the stroke
 * STARTED with, and for a brush that does not support the option the cache stays in accumulate
 * mode, so Smooth and Grab keep raycasting the live surface.
 */
export const SUPPORTS_ACCUMULATE = new Set([
  'DRAW', 'DRAW_SHARP', 'SLIDE_RELAX', 'CREASE', 'BLOB', 'INFLATE', 'CLAY', 'CLAY_STRIPS',
  'CLAY_THUMB', 'ROTATE', 'PLANE', 'SCENE_PROJECT',
]);

/**
 * Blender's stroke_cache_init accumulate rule. "Accumulate off" is what makes a dab read the shape
 * the stroke STARTED with, so this one boolean decides what the dab raycast and the area normal
 * see; a brush with no Accumulate option stays in accumulate mode and reads the live surface.
 *
 * Draw Sharp deserves a note. Blender main @235621e inverts the flag for it ("draw sharp does not
 * need the original coordinates to produce the accumulate effect"), but the build we take as
 * ground truth, 5.2.1, does NOT: there Draw Sharp reads the stroke-start surface like every other
 * accumulate-off brush. Measured on the golden strokes - with main's inversion the two-dab case
 * sits at 5.23% of Blender's max displacement and the long one at 6.40%; without it, 1.17% and
 * 3.78%. So this follows 5.2.1 and leaves the inversion out.
 */
export function accumulateFor(type, settings = {}) {
  let accum = true;
  if (settings.stroke_method === 'ANCHORED') accum = false;
  if (SUPPORTS_ACCUMULATE.has(type) && !settings.use_accumulate) accum = false;
  return accum;
}

/** Brush radius: world (box) units in, part-local metres out. */
export function radiusLocalFromWorld(radiusWorld, partScale) {
  return radiusWorld / (partScale || 1);
}

/**
 * Blender's C enum is BRUSH_PLANE_SWAP_HEIGHT_AND_DEPTH, but the RNA identifier reverses the two
 * words to "SWAP_DEPTH_AND_HEIGHT" (rna_brush.cc, brush_plane_inversion_mode_items), and the RNA
 * spelling is what the Essentials dump wrote into presets.json. Comparing against the C name looks
 * right and never matches, so both readers share one helper instead.
 */
export function isPlaneSwapMode(mode) {
  return mode === 'SWAP_DEPTH_AND_HEIGHT';
}

/** Blender's brush_flip: the "subtract" direction flag times the invert (Ctrl) toggle. */
export function brushFlip({ dirIn = false, invert = false } = {}) {
  return (dirIn ? -1 : 1) * (invert ? -1 : 1);
}

/**
 * Blender's brush_strength table, with a = UI strength squared, p the (curve-mapped) pressure,
 * ov the spacing overlap factor and flip the direction. Grab-like brushes deliberately use the
 * unsquared strength and ignore pressure.
 */
export function brushStrength(type, o = {}) {
  const root = o.strength ?? 0.5;
  const alpha = root * root;
  const p = o.usePressureStrength === false ? 1 : (o.pressure ?? 1);
  const flip = o.flip ?? 1;
  const ov = o.overlap ?? 1;
  const half = (1 + ov) / 2;
  switch (type) {
    case 'CLAY':
      return 0.25 * alpha * flip * (p * p * p * p) * half;
    case 'DRAW':
    case 'DRAW_SHARP':
    case 'LAYER':
      return alpha * flip * p * ov;
    case 'CLAY_STRIPS':
      return 0.3 * alpha * flip * Math.pow(p, 1.5) * ov;
    case 'CLAY_THUMB':
      return 1.3 * alpha * flip * p * p * ov;
    case 'MASK':
      return o.maskTool === 'SMOOTH' ? alpha * p : alpha * flip * p * half;
    case 'CREASE':
    case 'BLOB':
      return alpha * flip * p * ov;
    case 'INFLATE':
      return (flip > 0 ? 0.25 : 0.125) * alpha * flip * p * ov;
    case 'MULTIPLANE_SCRAPE':
      return alpha * flip * p * half;
    case 'PLANE':
      if (flip > 0 || isPlaneSwapMode(o.planeInversionMode)) return alpha * p * half;
      return 0.5 * alpha * p * ov;
    case 'SMOOTH':
      return flip * alpha * p;
    case 'PINCH':
      return (flip > 0 ? 1 : 0.25) * alpha * flip * p * ov;
    case 'NUDGE':
      return alpha * p * half;
    case 'THUMB':
    case 'ROTATE':
      return alpha * p;
    case 'SNAKE_HOOK':
    case 'GRAB':
    case 'ELASTIC_DEFORM':
    case 'POSE':
    case 'BOUNDARY':
      return root;
    case 'DRAW_FACE_SETS':
    case 'DISPLACEMENT_ERASER':
    case 'SMEAR':
    case 'BLUR':
      return alpha * p * ov;
    case 'SLIDE_RELAX':
      return alpha * p * ov * 2;
    case 'SCENE_PROJECT':
      return flip * alpha * p * ov;
    default:
      return alpha * flip * p * ov;
  }
}

// Weight towards the centre, the same smoothstep Blender uses for both the normal and the centre.
function areaWeight(distance, radiusInv) {
  const q = 1 - distance * radiusInv;
  const w = 3 * q * q - 2 * q * q * q;
  return w < 0 ? 0 : (w > 1 ? 1 : w);
}

/**
 * Area normal and area centre: a smoothstep-weighted average of the surface around the dab.
 * Front-facing and back-facing vertices are accumulated apart and the front set wins, which is
 * what keeps a dab on a thin wall from flipping. With accumulate off (Blender's default) the
 * caller passes the stroke-start positions and normals.
 *
 * @returns {{normal: number[]|null, center: number[]|null}}
 */
export function calcAreaNormalAndCenter(proxy, o) {
  const positions = o.positions || proxy.getVertices();
  const normals = o.normals || proxy.getRenderNormals();
  const verts = o.verts;
  const location = o.location;
  const viewNormal = o.viewNormal;
  const needNormal = o.needNormal !== false;
  const needCenter = o.needCenter !== false;
  const normalRadius = o.normalRadius;
  const positionRadius = o.positionRadius ?? o.normalRadius;
  const nr2 = normalRadius * normalRadius;
  const pr2 = positionRadius * positionRadius;
  const nrInv = 1 / normalRadius;
  const prInv = 1 / positionRadius;

  const areaCos = [[0, 0, 0], [0, 0, 0]];
  const areaNos = [[0, 0, 0], [0, 0, 0]];
  const countCo = [0, 0];
  const countNo = [0, 0];

  for (let k = 0; k < verts.length; k++) {
    const v = verts[k];
    const i3 = 3 * v;
    const d = brushDistance(positions[i3], positions[i3 + 1], positions[i3 + 2], location, o.falloffShape, viewNormal);
    const d2 = d * d;
    const wantNormal = needNormal && d2 <= nr2;
    const wantCenter = needCenter && d2 <= pr2;
    if (!wantNormal && !wantCenter) continue;
    const nx = normals[i3], ny = normals[i3 + 1], nz = normals[i3 + 2];
    const flip = viewNormal[0] * nx + viewNormal[1] * ny + viewNormal[2] * nz <= 0 ? 1 : 0;
    if (wantCenter) {
      const w = 1 - areaWeight(d, prInv);
      const co = areaCos[flip];
      co[0] += location[0] + (positions[i3] - location[0]) * w;
      co[1] += location[1] + (positions[i3 + 1] - location[1]) * w;
      co[2] += location[2] + (positions[i3 + 2] - location[2]) * w;
      countCo[flip]++;
    }
    if (wantNormal) {
      const w = areaWeight(d, nrInv);
      const no = areaNos[flip];
      no[0] += nx * w; no[1] += ny * w; no[2] += nz * w;
      countNo[flip]++;
    }
  }

  let center = null;
  for (const i of [0, 1]) {
    if (countCo[i] === 0) continue;
    center = [areaCos[i][0] / countCo[i], areaCos[i][1] / countCo[i], areaCos[i][2] / countCo[i]];
    break;
  }
  if (center === null && needCenter) center = [location[0], location[1], location[2]];

  let normal = null;
  for (const i of [0, 1]) {
    if (countNo[i] === 0) continue;
    const n = areaNos[i];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 0) { normal = [n[0] / len, n[1] / len, n[2] / len]; break; }
  }
  return { normal, center };
}

/**
 * Plane brush stabiliser: a rolling average of the last plane normals and centres, so a shaky
 * hand does not make the plane wobble. stabilize_normal/stabilize_plane pick how many frames.
 */
export function calcStabilizedPlane(cache, planeNormal, planeCenter, normalWeight, centerWeight) {
  const pc = cache.planeBrush;
  let newNormal, newCenter;
  if (pc.firstTime) {
    newNormal = planeNormal.slice();
    newCenter = planeCenter.slice();
    const maxNormal = Math.trunc(1 + normalWeight * (MAX_PLANE_ROLLING_AVERAGE - 1));
    const maxCenter = Math.trunc(1 + centerWeight * (MAX_PLANE_ROLLING_AVERAGE - 1));
    pc.normals = new Array(maxNormal).fill(0).map(() => planeNormal.slice());
    pc.centers = new Array(maxCenter).fill(0).map(() => planeCenter.slice());
    pc.normalIndex = 0;
    pc.centerIndex = 0;
    pc.firstTime = false;
  } else {
    const ln = pc.lastNormal, lc = pc.lastCenter;
    const mix = [
      planeNormal[0] * (1 - normalWeight) + ln[0] * normalWeight,
      planeNormal[1] * (1 - normalWeight) + ln[1] * normalWeight,
      planeNormal[2] * (1 - normalWeight) + ln[2] * normalWeight,
    ];
    const len = Math.hypot(mix[0], mix[1], mix[2]) || 1;
    newNormal = [mix[0] / len, mix[1] / len, mix[2] / len];
    // project the new centre onto the last plane, then blend back towards the raw centre
    const w = ln[0] * lc[0] + ln[1] * lc[1] + ln[2] * lc[2];
    const signed = ln[0] * planeCenter[0] + ln[1] * planeCenter[1] + ln[2] * planeCenter[2] - w;
    const projected = [
      planeCenter[0] - ln[0] * signed,
      planeCenter[1] - ln[1] * signed,
      planeCenter[2] - ln[2] * signed,
    ];
    newCenter = [
      planeCenter[0] * (1 - centerWeight) + projected[0] * centerWeight,
      planeCenter[1] * (1 - centerWeight) + projected[1] * centerWeight,
      planeCenter[2] * (1 - centerWeight) + projected[2] * centerWeight,
    ];
  }

  pc.normals[pc.normalIndex] = newNormal;
  pc.centers[pc.centerIndex] = newCenter;
  pc.normalIndex = (pc.normalIndex + 1) % pc.normals.length;
  pc.centerIndex = (pc.centerIndex + 1) % pc.centers.length;

  let sx = 0, sy = 0, sz = 0;
  for (const n of pc.normals) { sx += n[0]; sy += n[1]; sz += n[2]; }
  const sl = Math.hypot(sx, sy, sz) || 1;
  const stabNormal = [sx / sl, sy / sl, sz / sl];

  const refW = stabNormal[0] * newCenter[0] + stabNormal[1] * newCenter[1] + stabNormal[2] * newCenter[2];
  let total = 0;
  for (const c of pc.centers) total += stabNormal[0] * c[0] + stabNormal[1] * c[1] + stabNormal[2] * c[2] - refW;
  const avg = total / pc.centers.length;
  const adjusted = -avg; // (dot(n, newCenter) - refW) is zero by construction
  const stabCenter = [
    newCenter[0] - stabNormal[0] * adjusted,
    newCenter[1] - stabNormal[1] * adjusted,
    newCenter[2] - stabNormal[2] * adjusted,
  ];

  pc.lastNormal = stabNormal;
  pc.lastCenter = stabCenter;
  return { normal: stabNormal, center: stabCenter };
}

/** Blender's plane_offset, optionally scaled by pressure. */
export function planeOffsetGet(brush, cache) {
  return brush.use_offset_pressure ? (brush.plane_offset ?? 0) * cache.pressure : (brush.plane_offset ?? 0);
}

/** Stroke direction in part space: where the dab moved since the last one, normalised. */
export function strokeDirection(cache) {
  const d = cache.grabDeltaSymm;
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len === 0) return null;
  return [d[0] / len, d[1] / len, d[2] / len];
}
