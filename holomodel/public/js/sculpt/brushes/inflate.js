// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/inflate.cc (do_inflate_brush)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Unlike Draw, every vertex moves along ITS OWN normal, which is what makes a shape swell rather
// than get pushed. Deflating is half as strong (that multiplier is in the bstrength table).
// The normals are the stroke-start ones: with accumulate off, Blender's dab reads the shape the
// stroke began with, and using live normals instead cost more than the whole parity budget.

export const inflate = {
  key: 'inflate',
  presets: ['Inflate/Deflate'],
  type: 'INFLATE',
  needsAreaNormal: false,
  useOriginalNormals: true,
  lazy: true,
  apply(ctx) {
    const { verts, factors, translations } = ctx;
    const normals = ctx.origNormals;
    const s = ctx.cache.radius * ctx.cache.bstrength;
    for (let k = 0; k < verts.length; k++) {
      const f = factors[k] * s;
      const i3 = 3 * verts[k];
      translations[3 * k] = normals[i3] * f;
      translations[3 * k + 1] = normals[i3 + 1] * f;
      translations[3 * k + 2] = normals[i3 + 2] * f;
    }
    ctx.commit();
  },
};

export default inflate;
