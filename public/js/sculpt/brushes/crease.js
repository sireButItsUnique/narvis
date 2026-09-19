// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/crease.cc
//     (do_crease_or_blob_brush, translations_from_position, add_offset_to_translations)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (brush_strength CREASE/BLOB row)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Crease and Blob are the same kernel with one sign flipped. Each dab does two things at once:
//   - Draw: push along the area normal by radius * bstrength * factor;
//   - pinch: pull every vertex TOWARDS the dab centre, but only sideways - the component of that
//     pull along the area normal is thrown away, so the vertices slide along the surface into a
//     line instead of being sucked into a single point. Without that projection you get a flat
//     dent ringed by a crater instead of a crease.
// Crease pinches in while it pushes down, which cuts a sharp line; Blob does the same pull with
// the sign reversed, so it relaxes sideways while it pushes out and you get a bulge.
//
// The pinch strength is |bstrength| * pinch^2 / alpha^2: Blender divides out the squared UI
// strength that bstrength already carries and multiplies the squared crease_pinch_factor back in,
// so the pinch is governed by the pinch slider alone and keeps its sign even when Draw is
// negative (a crease inverted with Ctrl still creases, it just creases outwards).

/**
 * @param {object} ctx  kernel context
 * @param {number} sign +1 for Crease, -1 for Blob
 */
function creaseDab(ctx, sign) {
  const { verts, factors, translations, cache, settings } = ctx;
  const positions = ctx.useOriginal ? ctx.origPositions : ctx.positions;
  const n = cache.sculptNormalSymm;
  const loc = cache.locationSymm;

  const offsetScale = cache.radius * cache.bstrength;
  const ox = n[0] * offsetScale, oy = n[1] * offsetScale, oz = n[2] * offsetScale;

  const pinch = settings.crease_pinch_factor ?? 0.5;
  const alpha = settings.strength ?? 0.5;
  let correction = pinch * pinch;
  if (alpha > 0) correction /= alpha * alpha;
  const pinchStrength = Math.abs(cache.bstrength) * correction * sign;

  const tube = (settings.falloff_shape || 'SPHERE') === 'TUBE';
  const view = cache.viewNormalSymm;

  for (let k = 0; k < verts.length; k++) {
    const i3 = 3 * verts[k];
    let tx = loc[0] - positions[i3];
    let ty = loc[1] - positions[i3 + 1];
    let tz = loc[2] - positions[i3 + 2];
    if (tube) {
      const d = tx * view[0] + ty * view[1] + tz * view[2];
      tx -= view[0] * d; ty -= view[1] * d; tz -= view[2] * d;
    }
    const f = factors[k];
    const s = f * pinchStrength;
    tx *= s; ty *= s; tz *= s;
    // Drop the part of the pinch that runs along the normal: pinch towards a LINE, not a point.
    const along = tx * n[0] + ty * n[1] + tz * n[2];
    tx -= n[0] * along; ty -= n[1] * along; tz -= n[2] * along;
    translations[3 * k] = tx + ox * f;
    translations[3 * k + 1] = ty + oy * f;
    translations[3 * k + 2] = tz + oz * f;
  }
  ctx.commit();
}

export const crease = {
  key: 'crease',
  presets: ['Crease Sharp', 'Crease Polish'],
  type: 'CREASE',
  needsAreaNormal: true,
  lazy: true,
  apply(ctx) { creaseDab(ctx, 1); },
};

export const blob = {
  key: 'blob',
  presets: ['Blob'],
  type: 'BLOB',
  needsAreaNormal: true,
  lazy: true,
  apply(ctx) { creaseDab(ctx, -1); },
};

export default [crease, blob];
