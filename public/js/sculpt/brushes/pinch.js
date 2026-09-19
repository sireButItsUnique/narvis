// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/pinch.cc (do_pinch_brush, calc_translations)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (brush_strength PINCH row)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Pinch pulls the surface towards a LINE, not towards the cursor: the line runs through the dab
// along the stroke direction, so dragging along a ridge tightens it instead of denting it.
// Blender builds a little frame at the dab - x across the stroke, y along it, z the area normal -
// and keeps only the x and z parts of each vertex's pull towards the centre. Dropping y is what
// makes it a line. Magnify is the same kernel with the sign flipped (and a quarter of the
// strength, which lives in the bstrength table), so the surface is pushed off the line instead.
//
// Because the frame needs a stroke direction, Blender skips the first dab of the stroke and any
// dab where the hand did not move; the engine's NEEDS_STROKE_DIRECTION set does the first, and
// the zero-delta check below does the second.

export const pinch = {
  key: 'pinch',
  presets: ['Pinch/Magnify'],
  type: 'PINCH',
  needsAreaNormal: true,
  needsStrokeDirection: true,
  lazy: true,
  apply(ctx) {
    const { verts, factors, translations, cache, settings } = ctx;
    const positions = ctx.useOriginal ? ctx.origPositions : ctx.positions;
    const n = cache.sculptNormalSymm;
    const g = cache.grabDeltaSymm;
    if (g[0] === 0 && g[1] === 0 && g[2] === 0) return;

    // x across the stroke, z the area normal. (Blender also builds y = n x x and then throws it
    // away by never projecting onto it.)
    let xx = n[1] * g[2] - n[2] * g[1];
    let xy = n[2] * g[0] - n[0] * g[2];
    let xz = n[0] * g[1] - n[1] * g[0];
    const xl = Math.hypot(xx, xy, xz);
    if (xl === 0) return; // the hand moved straight along the normal: no cross-stroke axis
    xx /= xl; xy /= xl; xz /= xl;
    const zl = Math.hypot(n[0], n[1], n[2]) || 1;
    const zx = n[0] / zl, zy = n[1] / zl, zz = n[2] / zl;

    const loc = cache.locationSymm;
    const tube = (settings.falloff_shape || 'SPHERE') === 'TUBE';
    const view = cache.viewNormalSymm;
    const strength = cache.bstrength;

    for (let k = 0; k < verts.length; k++) {
      const i3 = 3 * verts[k];
      const dx = loc[0] - positions[i3];
      const dy = loc[1] - positions[i3 + 1];
      const dz = loc[2] - positions[i3 + 2];
      const ax = dx * xx + dy * xy + dz * xz;
      const az = dx * zx + dy * zy + dz * zz;
      let tx = xx * ax + zx * az;
      let ty = xy * ax + zy * az;
      let tz = xz * ax + zz * az;
      if (tube) {
        const d = tx * view[0] + ty * view[1] + tz * view[2];
        tx -= view[0] * d; ty -= view[1] * d; tz -= view[2] * d;
      }
      const f = factors[k] * strength;
      translations[3 * k] = tx * f;
      translations[3 * k + 1] = ty * f;
      translations[3 * k + 2] = tz * f;
    }
    ctx.commit();
  },
};

export default pinch;
