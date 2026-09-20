// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/elastic_deform.cc
//     (do_elastic_deform_brush, calc_translations, calc_faces)
//   source/blender/blenkernel/intern/kelvinlet.cc (see ../kelvinlet.js)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Elastic Grab has no radius and no falloff curve: every vertex of the part is displaced by the
// elastic field of a point force (a regularised Kelvinlet), so the model deforms like a solid
// rather than like a dent stamped into a surface. That makes it the friendliest brush to drive
// with a hand in mid-air - there is no dab edge to fall off, and a shaky finger only shakes the
// whole limb slightly instead of tearing a hole in it.
//
// Like Grab, it anchors at the stroke start, restores the stroke-start shape every step and
// re-applies the total hand movement, and it reads the stroke-start positions, so pulling and
// pushing back retraces the same path.

import { kelvinletParams, KELVINLET_BY_TYPE } from '../kelvinlet.js';

const _v3 = [0, 0, 0];
const _out = [0, 0, 0];   // scratch: every Kelvinlet writes all three components before returning

/**
 * Blender asks "is the cursor right of where the stroke started" to sign the scale/twist force.
 * The anchored grab delta IS cursor - initial cursor, so the same question in part space is which
 * way it points along screen-right = up x view. Grab-type Kelvinlets never read this.
 */
function forceDirection(ctx) {
  const cache = ctx.cache;
  const g = cache.grabDeltaSymm;
  const view = cache.viewNormalSymm;
  const m = ctx.handle?.worldToLocal?.elements;
  if (!m) return 1;
  const ux = m[4], uy = m[5], uz = m[6]; // world +Y (the viewer's up) taken into part space
  const rx = uy * view[2] - uz * view[1];
  const ry = uz * view[0] - ux * view[2];
  const rz = ux * view[1] - uy * view[0];
  return g[0] * rx + g[1] * ry + g[2] * rz > 0 ? 1 : -1;
}

export const elastic = {
  key: 'elastic',
  presets: ['Elastic Grab'],
  type: 'ELASTIC_DEFORM',
  usesOriginalData: true,
  restoreEachStep: true,
  anchoredOrigin: true,
  allVertices: true,      // no radius: the whole part answers the pull
  needsAreaNormal: true,  // only Scale and Twist read it, and then it is frozen at stroke start
  lazy: false,
  apply(ctx) {
    const { verts, translations, cache, settings } = ctx;
    const type = settings.elastic_deform_type || 'GRAB';
    const kelvinlet = KELVINLET_BY_TYPE[type] || KELVINLET_BY_TYPE.GRAB;
    const isGrab = type === 'GRAB' || type === 'GRAB_BISCALE' || type === 'GRAB_TRISCALE';

    const g = cache.grabDeltaSymm;
    let dir = isGrab ? 1 : forceDirection(ctx);
    // Blender mirrors the twist direction on the odd symmetry passes so both halves swirl the
    // same way in the model's own frame.
    if (type === 'TWIST' && [1, 2, 4, 7].includes(cache.mirrorSymmetryPass)) dir = -dir;

    const force = Math.hypot(g[0], g[1], g[2]) * dir * cache.bstrength;
    const params = kelvinletParams(
      cache.radius,
      force,
      1,
      settings.elastic_deform_volume_preservation ?? 0.4,
    );

    // Elastic ignores the falloff chain entirely: the only weight is the mask.
    const mask = ctx.proxy.getMask();
    const positions = ctx.origPositions;
    const loc = cache.locationSymm;
    const axis = cache.sculptNormalSymm;
    const scale = isGrab ? cache.bstrength * 20 : 1;

    for (let k = 0; k < verts.length; k++) {
      const v = verts[k];
      const i3 = 3 * v;
      _v3[0] = positions[i3]; _v3[1] = positions[i3 + 1]; _v3[2] = positions[i3 + 2];
      const out = kelvinlet(_out, params, _v3, loc, isGrab ? g : axis);
      const f = (mask ? 1 - mask[v] : 1) * scale;
      translations[3 * k] = out[0] * f;
      translations[3 * k + 1] = out[1] * f;
      translations[3 * k + 2] = out[2] * f;
    }
    ctx.commit();
  },
};

export default elastic;
