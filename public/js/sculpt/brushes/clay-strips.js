// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/clay_strips.cc
//     (do_clay_strips_brush, apply_z_axis_factors, apply_plane_trim_factors,
//      clay_strips::calc_local_matrix, clay_strips::calc_node_mask)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (calc_local_positions, calc_brush_cube_distances)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Clay Strips is the brush that lays a flat, square-edged ribbon of clay along the stroke, and it
// is the first brush here that is not a sphere at all. Everything happens in the brush-local box
// (see brush-frame.js): one unit per radius, z measured down from the brush plane into the surface.
//
// Three things give it its character, all of them visible in the weight:
//   - the tip is a rounded SQUARE (tip_roundness 0.15 in Essentials), so the strip has real edges
//     instead of fading off like a Draw dab;
//   - the strength is a parabola in depth, z(1 - z): vertices ON the plane and vertices a full
//     radius below it both get nothing, and the clay is deposited in the band between. That is
//     what stops the brush from digging when you go over the same place twice;
//   - the plane sits plane_offset (0.15) of a radius ABOVE the surface, so the strip builds up.
//
// Because the support is that box and not a sphere around the cursor, this kernel gathers its own
// vertices: the engine's gather is a sphere of normal_radius_factor radii around the cursor, and
// the far corners of the box (up to sqrt(3) radii away) fall outside it while still carrying
// enough weight to matter. Vertices reached this way are announced with ctx.touch() so undo and
// the render scatter see them.

import { localFrame, cubeDistance, gatherSphere, projectToPlane, baseFactor } from './brush-frame.js';
import { planeOffsetGet } from '../cache.js';
import { applyHardness, curveStrength } from '../factors.js';

export const clayStrips = {
  key: 'clay_strips',
  presets: ['Clay Strips'],
  type: 'CLAY_STRIPS',
  needsAreaNormal: true,
  needsAreaCenter: true,
  needsStrokeDirection: true, // the box has no orientation until the hand has moved
  lazy: true,
  apply(ctx) {
    const { proxy, cache, settings } = ctx;
    const direction = cache.grabDeltaSymm;
    if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) return;

    const radius = cache.radius;
    const bstrength = cache.bstrength;
    const flip = bstrength < 0;
    const normal = cache.sculptNormalSymm;
    const tube = settings.falloff_shape === 'TUBE';
    // The strip follows the surface when the falloff is spherical and the screen when it is a tube.
    const tipNormal = tube ? cache.viewNormalSymm : normal;

    // Lift the plane off the surface so the strip is deposited rather than carved.
    const displace = radius * planeOffsetGet(settings, cache) * (flip ? -1 : 1);
    const center = [
      cache.areaCenterSymm[0] + normal[0] * displace,
      cache.areaCenterSymm[1] + normal[1] * displace,
      cache.areaCenterSymm[2] + normal[2] * displace,
    ];

    // Blender flips z when the brush is NOT inverted, so the vertices under the plane - the ones
    // the brush acts on - always have positive z.
    const frame = localFrame(tipNormal, direction, center, radius, {
      flipZ: !flip,
      scaleY: settings.tip_scale_x ?? 1,
    });
    if (!frame) return; // hand moved along the normal: Blender's matrix would be singular

    const offset = [normal[0] * bstrength * radius, normal[1] * bstrength * radius, normal[2] * bstrength * radius];

    const verts = gatherSphere(proxy, center, frame.reach);
    if (verts.length === 0) return;

    const positions = proxy.getVertices();
    const normals = proxy.getRenderNormals();
    const mask = proxy.getMask();
    const frontFace = !!settings.use_frontface;
    const viewNormal = cache.viewNormalSymm;
    const roundness = settings.tip_roundness ?? 1;
    const falloff = settings.curve_distance_falloff_preset || 'SMOOTH';
    const hardness = cache.hardness || 0;
    const useTrim = !!settings.use_plane_trim;
    const trim = settings.plane_trim ?? 0.5;
    const planeOffset = settings.plane_offset ?? 0;

    const loc = [0, 0, 0];
    const projected = [0, 0, 0];

    for (let k = 0; k < verts.length; k++) {
      const v = verts[k];
      const i3 = 3 * v;
      let f = baseFactor(v, mask, normals, viewNormal, frontFace);
      if (f <= 0) continue;

      if (tube) {
        projectToPlane(positions[i3], positions[i3 + 1], positions[i3 + 2], center, viewNormal, projected);
        frame.local(projected[0], projected[1], projected[2], loc);
        // Flattened against the screen there is no depth left to read, so Blender substitutes the
        // plane offset for every vertex and the strip keeps a constant thickness.
        loc[2] = planeOffset;
      } else {
        frame.local(positions[i3], positions[i3 + 1], positions[i3 + 2], loc);
      }

      // The depth parabola. Negative above the plane and below one radius, which zeroes the weight.
      const z = loc[2];
      f *= Math.max(0, z * (1 - z));
      if (f <= 0) continue;
      if (useTrim && z > trim) continue;

      let d = cubeDistance(loc[0], loc[1], roundness);
      if (!(d < 1)) continue;
      d = applyHardness(d, 1, hardness);
      f *= curveStrength(falloff, d, 1);
      if (f === 0) continue;

      // Our own gather, so the stroke-start copy has to be taken here - and BEFORE the move,
      // because that copy is both the undo record and the original data other brushes read.
      ctx.touch(v);
      positions[i3] += offset[0] * f;
      positions[i3 + 1] += offset[1] * f;
      positions[i3 + 2] += offset[2] * f;
    }
  },
};

export default clayStrips;
