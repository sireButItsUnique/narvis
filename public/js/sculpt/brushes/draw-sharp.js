// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/draw_sharp.cc (do_draw_sharp_brush)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (calc_factors_common_from_orig_data_mesh, tilt_effective_normal_get, stroke_cache_init)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Draw Sharp moves the dab along one direction, exactly like Draw. What makes it cut a crease
// instead of raising a dome is the pair of settings it ships with, and one inverted rule:
//
//   - POW4 falloff, so the weight is q^4: only the few vertices right under the centre move at
//     all and the edge of the dab is untouched. That is the sharp part;
//   - the weights are measured against the mesh as it was when the stroke STARTED. The crease
//     therefore keeps cutting straight down instead of the dab drifting along the groove it has
//     already made and smearing it out;
//   - and the accumulate rule runs backwards here. For every other brush "accumulate off" means
//     "read the stroke-start shape", but Draw Sharp gets its accumulate effect from the original
//     weights above, so Blender flips the flag: the dab is still raycast against the LIVE surface
//     (cache.js accumulateFor(), which is where this inversion lives).

import { offsetTranslations } from './draw.js';

export const drawSharp = {
  key: 'draw_sharp',
  presets: ['Draw Sharp'],
  type: 'DRAW_SHARP',
  needsAreaNormal: true,
  usesOriginalData: true, // weigh the dab by the stroke-start shape
  useOriginalNormals: true,
  lazy: true,
  apply(ctx) {
    const n = ctx.cache.sculptNormalSymm;
    const s = ctx.cache.radius * ctx.cache.bstrength;
    offsetTranslations(ctx, [n[0] * s, n[1] * s, n[2] * s]);
    ctx.commit();
  },
};

export default drawSharp;
