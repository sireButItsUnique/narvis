// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/smooth.cc (do_smooth_brush)
//   source/blender/editors/sculpt_paint/mesh/brushes/enhance_details.cc (do_enhance_details_brush)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// The brush itself is thin: smooth.js holds the maths (pass splitting, the border rule). The one
// thing decided here is the direction: Blender fixes it at the START of the stroke, so a stroke
// that begins inverted stays Enhance Details even if the strength dips to zero in the middle.

import { smoothDab, detailDirections, enhanceDab } from '../smooth.js';

export const smooth = {
  key: 'smooth',
  presets: ['Smooth'],
  type: 'SMOOTH',
  usesOriginalData: false,
  needsAreaNormal: false,
  noAutoSmooth: true, // Blender never auto-smooths after Smooth or Mask
  lazy: true,
  apply(ctx) {
    const { proxy, verts, cache } = ctx;
    if (cache.initialDirectionFlipped) {
      // Enhance Details: one direction per vertex, taken once, then pushed the other way.
      if (!cache.detailDirections) cache.detailDirections = detailDirections(proxy);
      for (let k = 0; k < verts.length; k++) ctx.touch(verts[k]);
      enhanceDab(proxy, verts, ctx.factors, cache.detailDirections, cache.bstrength);
      ctx.markDirty();
      return;
    }
    smoothDab(proxy, verts, {
      strength: Math.min(Math.max(cache.bstrength, 0), 1),
      // Blender's four passes, unless the hand profile asks for more (presets.js HAND_OVERRIDES).
      passes: ctx.settings.smooth_passes || 4,
      // Only the first brush action of a stroke gets the frozen base; see smooth.js.
      frozenBase: ctx.firstBrushAction,
      computeFactors: (out) => ctx.computeFactors(out),
      onTouch: (v) => ctx.touch(v),
    });
    ctx.markDirty();
  },
};

export default smooth;
