// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/plane.cc
//     (do_plane_brush, calc_local_distances, scale_factors_by_height_and_depth, calc_translations)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (calc_brush_plane, calc_stabilized_plane, brush_plane_offset_get)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// ONE kernel, five Essentials brushes. Blender 5.x folded Flatten, Scrape, Fill and Trim into a
// single Plane brush, and the five presets differ only in two numbers:
//
//   Flatten/Contrast  height 1  depth 1   pull both sides onto the plane
//   Scrape/Fill       height 1  depth 0   only shave what sticks up
//   Fill/Deepen       height 0  depth 1   only fill what is hollow
//   Plateau           height 1  depth 1   + hardness 0.5 and a fully stabilised plane
//   Trim              height 1  depth 0   + hardness 0.6 and a stabilised normal
//
// Every vertex is moved straight onto the brush plane, scaled by its weight, so the surface
// flattens instead of being pushed. The clever part is the weight, and it all happens in the
// brush-local box (brush-frame.js), where z is the signed distance to the plane in radii:
//
//   - the distance that feeds the falloff is |(x, y, z/height)| above the plane and
//     |(x, y, z/depth)| below it. A small height squeezes the z axis, so a vertex only a little
//     way above the plane already counts as "far" and barely moves: that is how height and depth
//     turn into "how much of the bump do I take off";
//   - height or depth of exactly 0 sets that side's distance to 1, which the radius filter then
//     throws away - the side is switched off, which is what makes Scrape one-sided;
//   - the weight is finally multiplied by z itself, because the vertex has to travel exactly its
//     own distance to reach the plane.
//
// Like Clay Strips this gathers its own vertices: the brush plane's centre is the area centre,
// which can sit well away from the point under the cursor, and the engine's gather is a sphere
// around the cursor.

import { localFrame, gatherSphere, projectToPlane, baseFactor } from './brush-frame.js';
import { planeOffsetGet, calcStabilizedPlane } from '../cache.js';
import { applyHardness, curveStrength } from '../factors.js';

/** Blender's BRUSH_PLANE_SWAP_HEIGHT_AND_DEPTH; the RNA identifier reads "SWAP_DEPTH_AND_HEIGHT". */
function isSwapMode(mode) {
  return typeof mode === 'string' && mode.includes('SWAP');
}

export const plane = {
  key: 'plane',
  presets: ['Flatten/Contrast', 'Scrape/Fill', 'Fill/Deepen', 'Plateau', 'Trim'],
  type: 'PLANE',
  needsAreaNormal: true,
  needsAreaCenter: true,
  needsStrokeDirection: true, // the local box needs a stroke direction for its x and y axes
  lazy: true,
  apply(ctx) {
    const { proxy, cache, settings } = ctx;
    const direction = cache.grabDeltaSymm;
    if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) return;

    // Blender stabilises the plane inside calc_area_normal_and_center, and only for this brush
    // type: a rolling average over up to 20 frames so a shaky hand does not make the plane wobble.
    // It runs on the main symmetry pass only; the mirrored passes reuse the result, mirrored, so
    // we write it back into the cache before the other passes read it.
    if (cache.mirrorSymmetryPass === 0 && cache.areaCenter) {
      const stabilized = calcStabilizedPlane(
        cache,
        cache.sculptNormal,
        cache.areaCenter,
        settings.stabilize_normal ?? 0,
        settings.stabilize_plane ?? 0,
      );
      cache.sculptNormal = stabilized.normal;
      cache.areaCenter = stabilized.center;
      cache.sculptNormalSymm = stabilized.normal;
      cache.areaCenterSymm = stabilized.center;
    }

    const radius = cache.radius;
    const normal = cache.sculptNormalSymm;
    // Plane reads the direction the stroke STARTED in, not the sign of the current strength.
    const flip = !!cache.initialDirectionFlipped;
    const displace = radius * planeOffsetGet(settings, cache) * (flip ? -1 : 1);
    const center = [
      cache.areaCenterSymm[0] + normal[0] * displace,
      cache.areaCenterSymm[1] + normal[1] * displace,
      cache.areaCenterSymm[2] + normal[2] * displace,
    ];

    let strength = cache.bstrength;
    let height = settings.plane_height ?? 0;
    let depth = settings.plane_depth ?? 0;
    if (flip) {
      if (isSwapMode(settings.plane_inversion_mode)) {
        const swap = height; height = depth; depth = swap;
      } else {
        strength = -strength; // invert displacement: push away from the plane instead
      }
    }

    const frame = localFrame(normal, direction, center, radius);
    if (!frame) return;

    // |z| < height (or depth) in local units, so nothing beyond this can be reached.
    const reach = radius * Math.max(1, height, depth);
    const verts = gatherSphere(proxy, center, reach);
    if (verts.length === 0) return;

    const positions = proxy.getVertices();
    const normals = proxy.getRenderNormals();
    const mask = proxy.getMask();
    const frontFace = !!settings.use_frontface;
    const viewNormal = cache.viewNormalSymm;
    const tube = settings.falloff_shape === 'TUBE';
    const falloff = settings.curve_distance_falloff_preset || 'SMOOTH';
    const hardness = cache.hardness || 0;

    // T = -plane_normal * radius * strength * (factor * z): the vertex travels its own z onto
    // the plane, because in local space the move is (0, 0, -z) and one local unit is one radius.
    const offset = [-normal[0] * radius * strength, -normal[1] * radius * strength, -normal[2] * radius * strength];

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
      } else {
        frame.local(positions[i3], positions[i3 + 1], positions[i3 + 2], loc);
      }
      const z = loc[2];

      // Squeeze the z axis by height above the plane and by depth below it; a 0 means "this side
      // is off", which Blender spells as distance 1 so the radius filter drops the vertex.
      const side = z >= 0 ? height : depth;
      let d;
      if (side !== 0) d = Math.hypot(loc[0], loc[1], z / side);
      else d = 1;
      if (!(d < 1)) continue;

      d = applyHardness(d, 1, hardness);
      f *= curveStrength(falloff, d, 1);
      if (f === 0) continue;

      // Put back the strength the squeeze above took out, so height/depth change the reach of the
      // brush rather than how hard it pulls.
      if (z > 0 && height !== 1 && height !== 0) f *= height;
      else if (z < 0 && depth !== 1 && depth !== 0) f *= depth;

      f *= z;
      if (f === 0) continue;

      ctx.touch(v); // before the move: the stroke-start copy is the undo record
      positions[i3] += offset[0] * f;
      positions[i3 + 1] += offset[1] * f;
      positions[i3 + 2] += offset[2] * f;
    }
  },
};

export default plane;
