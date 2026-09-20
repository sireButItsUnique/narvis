// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/mask.cc
//     (do_mask_brush, apply_factors, clamp_mask)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (brush_strength MASK row)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Mask paints a 0..1 protection value per vertex instead of moving anything: every other brush
// multiplies its weights by (1 - mask), so a masked area simply stops responding. Painting it is
// a saturating step - each dab adds `factor * (1 - mask) * strength`, so it approaches 1 and never
// overshoots, and erasing (Ctrl, a negative strength) takes away `factor * mask * strength`, which
// approaches 0 the same way. That symmetry is why holding the brush still fades in smoothly
// instead of snapping to a hard disc.
//
// The one thing to get right: the mask brush's own weights must NOT include the (1 - mask) term
// the other brushes use, or a masked area could never be unmasked.

import { calcFactors } from '../factors.js';

export const mask = {
  key: 'mask',
  presets: ['Mask'],
  type: 'MASK',
  noAutoSmooth: true, // Blender never auto-smooths after Smooth or Mask
  lazy: true,
  apply(ctx) {
    const { proxy, verts, settings, cache } = ctx;
    const masks = proxy.getMask();
    if (!masks) return;

    const factors = new Float32Array(verts.length);
    calcFactors(proxy, verts, {
      location: cache.locationSymm,
      radius: cache.radius,
      hardness: cache.hardness,
      falloff: settings.curve_distance_falloff_preset || 'SMOOTH',
      falloffShape: settings.falloff_shape || 'SPHERE',
      viewNormal: cache.viewNormalSymm,
      frontFace: !!settings.use_frontface,
      mask: null, // deliberately not weighted by the mask it is painting
    }, factors, new Float32Array(verts.length));

    const strength = cache.bstrength;
    const adding = strength > 0;
    for (let k = 0; k < verts.length; k++) {
      const v = verts[k];
      const m = masks[v];
      const next = m + factors[k] * (adding ? 1 - m : m) * strength;
      masks[v] = next < 0 ? 0 : next > 1 ? 1 : next;
    }
    // No positions changed, so nothing is touched: the undo record stays about geometry.
  },
};

export default mask;
