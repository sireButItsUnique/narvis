// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/thumb.cc (do_thumb_brush)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (brush_type_needs_original, need_delta_from_anchored_origin, restore list, brush_strength)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Thumb is Nudge's offset driven like Grab: the dab stays anchored where the stroke started, the
// mesh is put back to its stroke-start shape every step, and the TOTAL hand movement (flattened
// onto the surface) is applied again from that snapshot. So it smears a dent across the form and
// follows the hand instead of piling up - press your thumb into clay and drag.
//
// The weights come from the stroke-start positions and normals, never the live ones, which is what
// keeps the smeared region from wandering as the surface deforms under it. The area normal is
// frozen at the stroke start too (Blender does not update it for Thumb).

export const thumb = {
  key: 'thumb',
  presets: ['Thumb'],
  type: 'THUMB',
  usesOriginalData: true,
  restoreEachStep: true,
  anchoredOrigin: true,
  needsAreaNormal: true,
  lazy: false,
  apply(ctx) {
    const { verts, factors, translations, cache } = ctx;
    const n = cache.sculptNormalSymm;
    const g = cache.grabDeltaSymm;
    // (n x g) x n: the hand movement with its along-the-normal part removed.
    const ax = n[1] * g[2] - n[2] * g[1];
    const ay = n[2] * g[0] - n[0] * g[2];
    const az = n[0] * g[1] - n[1] * g[0];
    const s = cache.bstrength;
    const ox = (ay * n[2] - az * n[1]) * s;
    const oy = (az * n[0] - ax * n[2]) * s;
    const oz = (ax * n[1] - ay * n[0]) * s;
    for (let k = 0; k < verts.length; k++) {
      const f = factors[k];
      translations[3 * k] = ox * f;
      translations[3 * k + 1] = oy * f;
      translations[3 * k + 2] = oz * f;
    }
    ctx.commit();
  },
};

export default thumb;
