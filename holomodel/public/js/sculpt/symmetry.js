// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/mesh_paint.cc
//     (do_symmetrical_brush_actions_with_tiling_and_feathering, calc_overlap, calc_symmetry_feather)
//   source/blender/editors/sculpt_paint/paint_intern.hh (is_symmetry_iteration_valid, symmetry_flip)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (cache_calc_brushdata_symm)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Blender runs the dab once per subset of the enabled mirror axes, including the identity pass,
// mirroring the dab data about the object origin. It never skips near the plane: on the centre
// line the two passes push in opposite directions along the mirrored axis and cancel, which is
// exactly what keeps centre vertices on the plane. Our frame is the model root (holo_sym's
// plane), so a part that sits off-centre still mirrors to the right place - and a mirrored dab
// that lands on a different part is routed there.

export const SYMM_X = 1;
export const SYMM_Y = 2;
export const SYMM_Z = 4;

/** {x,y,z} booleans -> Blender's bit combination. */
export function symmetryFlags(axes = {}) {
  return (axes.x ? SYMM_X : 0) | (axes.y ? SYMM_Y : 0) | (axes.z ? SYMM_Z : 0);
}

/** Blender's is_symmetry_iteration_valid. */
export function isSymmetryIterationValid(i, symm) {
  return i === 0 || ((symm & i) !== 0 && (symm !== 5 || i !== 3) && (symm !== 6 || (i !== 3 && i !== 5)));
}

/** Every pass Blender would run for these axes, identity first. */
export function symmetryPasses(symm) {
  const out = [];
  for (let i = 0; i <= symm; i++) if (isSymmetryIterationValid(i, symm)) out.push(i);
  return out;
}

/** Negate the components named by the pass. */
export function flipVec(v, symm) {
  return [
    symm & SYMM_X ? -v[0] : v[0],
    symm & SYMM_Y ? -v[1] : v[1],
    symm & SYMM_Z ? -v[2] : v[2],
  ];
}

/**
 * Feathering (off by default): when mirrored dabs overlap, divide the strength by how much they
 * overlap so the seam does not get a double dose.
 */
export function symmetryFeather(location, radius, symm, enabled) {
  if (!enabled) return 1;
  let overlap = 0;
  for (const pass of symmetryPasses(symm)) {
    const m = flipVec(location, pass);
    const dsq = (m[0] - location[0]) ** 2 + (m[1] - location[1]) ** 2 + (m[2] - location[2]) ** 2;
    if (dsq <= 4 * radius * radius) overlap += (2 * radius - Math.sqrt(dsq)) / (2 * radius);
  }
  return overlap > 0 ? 1 / overlap : 1;
}

/**
 * Fill the cache's per-pass fields. Vectors are mirrored, never recomputed: the mirrored dab
 * reuses the main pass's area normal and brush plane, mirrored (Blender does the same).
 */
export function applySymmetryPass(cache, symm) {
  cache.mirrorSymmetryPass = symm;
  cache.locationSymm = flipVec(cache.location, symm);
  cache.lastLocationSymm = flipVec(cache.lastLocation, symm);
  cache.grabDeltaSymm = flipVec(cache.grabDelta, symm);
  cache.viewNormalSymm = flipVec(cache.viewNormal, symm);
  cache.initialLocationSymm = flipVec(cache.initialLocation, symm);
  cache.initialNormalSymm = flipVec(cache.initialNormal, symm);
  cache.sculptNormalSymm = flipVec(cache.sculptNormal, symm);
  return cache;
}

/**
 * Cross-part routing hook. A mirrored dab belongs to the stroke's own part when that part is
 * symmetric about the plane; otherwise it belongs to whichever part has surface within 0.5r of
 * the mirrored point (the caller supplies the lookup, usually an octree sphere query per part).
 *
 * @param {object} o {part, selfSymmetric, point, radius, findPartNear}
 * @returns the part to dab, or null when the mirrored dab falls in empty space.
 */
export function routeMirrorPass(o) {
  if (o.selfSymmetric) return o.part;
  if (typeof o.findPartNear !== 'function') return null;
  return o.findPartNear(o.point, o.radius * 0.5) || null;
}
