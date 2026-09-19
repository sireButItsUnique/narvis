// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/draw.cc (do_nudge_brush)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (brush_strength NUDGE row)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Nudge slides the surface sideways: every vertex in the dab moves by the same offset, which is
// the hand's movement for this step with the along-the-normal part removed, so clay is dragged
// across the form instead of being pushed into it. That "one offset for the whole dab" shape is
// Draw's, so this uses draw.js's helpers; the only difference is where the offset comes from.
//
// Unlike Draw, the offset is NOT scaled by the radius - it is already a distance, the distance the
// hand travelled - so a slow hand nudges less, which is what makes it feel like a thumb on clay.

import { offsetTranslations, nudgeOffset } from './draw.js';

export const nudge = {
  key: 'nudge',
  presets: ['Nudge'],
  type: 'NUDGE',
  needsAreaNormal: true,
  needsStrokeDirection: true,
  lazy: true,
  apply(ctx) {
    const o = nudgeOffset(ctx.cache);
    const s = ctx.cache.bstrength;
    offsetTranslations(ctx, [o[0] * s, o[1] * s, o[2] * s]);
    ctx.commit();
  },
};

export default nudge;
