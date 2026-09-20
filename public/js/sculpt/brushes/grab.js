// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/grab.cc (do_grab_brush, calc_silhouette_factors)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (brush_delta_update, restore_from_undo_step)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Grab is "pick up the clay and move it". The mesh is put back to its stroke-start shape on every
// step and the TOTAL hand movement is applied again, so the grabbed lump follows the hand instead
// of stretching further and further. Weights come from the stroke-start shape around the point
// where the stroke started, never from where the surface is now. Strength is not squared here
// (Blender's table), so at strength 1 the lump follows the hand exactly - which is what the hand
// override sets it to, because Essentials' 0.4 feels like lag when your own finger is the cursor.

export const grab = {
  key: 'grab',
  presets: ['Grab', 'Grab Silhouette'],
  type: 'GRAB',
  usesOriginalData: true,
  restoreEachStep: true,
  anchoredOrigin: true, // the dab stays where the stroke started; the hand delta does the work
  needsAreaNormal: false,
  lazy: false,
  apply(ctx) {
    const { verts, factors, translations, cache } = ctx;
    const g = cache.grabDeltaSymm;
    const s = cache.bstrength;
    const offset = [g[0] * s, g[1] * s, g[2] * s];

    if (ctx.settings.use_grab_silhouette) {
      // Only drag the side of the surface that faces the pull, so the far side does not follow.
      const len = Math.hypot(offset[0], offset[1], offset[2]);
      if (len > 0) {
        const n0 = cache.initialNormalSymm;
        const sign = Math.sign(n0[0] * g[0] + n0[1] * g[1] + n0[2] * g[2]) || 1;
        const tx = (offset[0] / len) * sign, ty = (offset[1] / len) * sign, tz = (offset[2] / len) * sign;
        const normals = ctx.origNormals;
        for (let k = 0; k < verts.length; k++) {
          const i3 = 3 * verts[k];
          const d = tx * normals[i3] + ty * normals[i3 + 1] + tz * normals[i3 + 2];
          factors[k] *= Math.max(d, 0);
        }
      }
    }

    for (let k = 0; k < verts.length; k++) {
      const f = factors[k];
      translations[3 * k] = offset[0] * f;
      translations[3 * k + 1] = offset[1] * f;
      translations[3 * k + 2] = offset[2] * f;
    }
    ctx.commit();
  },
};

export default grab;
