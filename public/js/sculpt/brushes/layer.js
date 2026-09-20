// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/layer.cc
//     (do_layer_brush, offset_displacement_factors, clamp_displacement_factors, calc_translations)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Layer is the brush that builds a slab of a FIXED thickness, no matter how long you stay on it.
// Every other dab brush adds displacement; Layer instead tracks one number per vertex - how far
// along the layer that vertex has got, from 0 to 1 - and then places the vertex at
//
//     origP + origN * height * d
//
// an absolute target measured from where the vertex was when the stroke began. Go over the same
// place ten times and the tenth dab moves nothing, because d is already 1: the layer plateaus at
// exactly `height` (0.05 m in the Essentials preset, which is where the golden fixture's 0.05000
// comes from).
//
// The approach curve is Blender's:  d += f * strength * (1.05 - |d|)
// The 1.05 rather than 1.0 is what lets d actually reach 1 instead of creeping towards it forever.
// d is then clipped to +/-(1 - mask), so a masked vertex has a shorter layer rather than a
// delayed one.
//
// Distances are measured on the stroke-start shape, so the dab does not chase the slab it is
// building - which is the other half of why the thickness stays put.

import { layerHeight } from '../presets.js';

export const layer = {
  key: 'layer',
  presets: ['Layer'],
  type: 'LAYER',
  usesOriginalData: true,
  useOriginalNormals: true,
  lazy: true,
  apply(ctx) {
    const { proxy, cache, settings, verts, factors, positions, translations, origPositions, origNormals } = ctx;

    const count = proxy.getNbVertices();
    let displacement = cache.layerDisplacement;
    if (!displacement || displacement.length !== count) {
      // One per-stroke array; the cache is rebuilt for every stroke, so the layer always starts flat.
      displacement = cache.layerDisplacement = new Float32Array(count);
    }
    const mask = proxy.getMask();
    const strength = cache.bstrength;
    const height = layerHeight(settings, cache.radius);

    for (let k = 0; k < verts.length; k++) {
      const f = factors[k];
      const v = verts[k];
      let d = displacement[v];
      d += f * strength * (1.05 - Math.abs(d));
      const limit = mask ? 1 - mask[v] : 1;
      if (d > limit) d = limit;
      else if (d < -limit) d = -limit;
      displacement[v] = d;
      if (f === 0) continue;

      const i3 = 3 * v;
      const offset = height * d;
      translations[3 * k] = (origPositions[i3] + origNormals[i3] * offset - positions[i3]) * f;
      translations[3 * k + 1] = (origPositions[i3 + 1] + origNormals[i3 + 1] * offset - positions[i3 + 1]) * f;
      translations[3 * k + 2] = (origPositions[i3 + 2] + origNormals[i3 + 2] * offset - positions[i3 + 2]) * f;
    }
    ctx.commit();
  },
};

export default layer;
