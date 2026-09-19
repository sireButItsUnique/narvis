// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/draw.cc (do_draw_brush, do_nudge_brush)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Draw is the simplest kernel there is: every vertex in the dab moves along ONE direction (the
// area normal of the surface under the brush, averaged over 0.5r), by radius * strength * factor.
// Nudge shares the same "one offset for the whole dab" shape, with the offset turned into the
// stroke direction flattened onto the surface, so it is built from the same helper.

/** translations[i] = offset * factor[i]. Every offset-style brush ends here. */
export function offsetTranslations(ctx, offset) {
  const { factors, translations } = ctx;
  for (let k = 0; k < factors.length; k++) {
    const f = factors[k];
    translations[3 * k] = offset[0] * f;
    translations[3 * k + 1] = offset[1] * f;
    translations[3 * k + 2] = offset[2] * f;
  }
}

/** The Nudge offset: the stroke direction with its along-normal part removed. */
export function nudgeOffset(cache) {
  const n = cache.sculptNormalSymm;
  const g = cache.grabDeltaSymm;
  // (n x g) x n  ==  g projected onto the plane of n
  const ax = n[1] * g[2] - n[2] * g[1];
  const ay = n[2] * g[0] - n[0] * g[2];
  const az = n[0] * g[1] - n[1] * g[0];
  return [ay * n[2] - az * n[1], az * n[0] - ax * n[2], ax * n[1] - ay * n[0]];
}

export const draw = {
  key: 'draw',
  presets: ['Draw'],
  type: 'DRAW',
  needsAreaNormal: true,
  lazy: true,
  apply(ctx) {
    const n = ctx.cache.sculptNormalSymm;
    const s = ctx.cache.radius * ctx.cache.bstrength;
    offsetTranslations(ctx, [n[0] * s, n[1] * s, n[2] * s]);
    ctx.commit();
  },
};

export default draw;
