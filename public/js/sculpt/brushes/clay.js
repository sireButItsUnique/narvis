// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/clay.cc (do_clay_brush, calc_closest_to_plane)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (calc_brush_plane, brush_plane_offset_get)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Clay is Draw and Flatten at the same time: it holds a plane 0.4 of a radius ABOVE the surface
// and pulls every vertex in the dab towards it. Vertices below the plane rise (clay is added) and
// anything that pokes through gets pushed back down, which is why Clay builds up volume without
// ever growing spikes - and why it is the brush to hand someone whose "pen" is their own finger.
//
// Two details are easy to get wrong and both are silent:
//   - the plane hangs off cache.location, the point under the cursor, NOT off the area centre.
//     The area normal is still the averaged one, so the plane is tilted with the surface but
//     positioned by the hand;
//   - the offset is measured against the radius the STROKE started with, not the current one, and
//     it is taken as an absolute value before the direction flips it. A brush that grows mid
//     stroke therefore keeps depositing the same thickness of clay.

import { planeOffsetGet } from '../cache.js';

export const clay = {
  key: 'clay',
  presets: ['Clay'],
  type: 'CLAY',
  needsAreaNormal: true,
  needsAreaCenter: false, // the plane is positioned by the cursor, not the area centre
  lazy: true,
  apply(ctx) {
    const { cache, settings, verts, factors, positions, translations } = ctx;
    const n = cache.sculptNormalSymm;

    const initialRadius = Math.abs(cache.initialRadius);
    let displace = Math.abs(initialRadius * planeOffsetGet(settings, cache));
    if (cache.bstrength < 0) displace = -displace;

    const loc = cache.locationSymm;
    const planeCenter = [
      loc[0] + n[0] * displace,
      loc[1] + n[1] * displace,
      loc[2] + n[2] * displace,
    ];
    // The plane as (normal, w): a vertex's signed distance is dot(n, P) - w.
    const w = n[0] * planeCenter[0] + n[1] * planeCenter[1] + n[2] * planeCenter[2];
    // Direction is already in the plane's position, so the pull itself is always positive.
    const strength = Math.abs(cache.bstrength);

    for (let k = 0; k < verts.length; k++) {
      const f = factors[k];
      if (f === 0) continue;
      const i3 = 3 * verts[k];
      const side = n[0] * positions[i3] + n[1] * positions[i3 + 1] + n[2] * positions[i3 + 2] - w;
      const t = -side * strength * f;
      translations[3 * k] = n[0] * t;
      translations[3 * k + 1] = n[1] * t;
      translations[3 * k + 2] = n[2] * t;
    }
    ctx.commit();
  },
};

export default clay;
