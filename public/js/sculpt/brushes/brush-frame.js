// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (calc_local_positions, calc_brush_cube_distances, filter_distances_with_radius)
//   source/blender/editors/sculpt_paint/mesh/brushes/clay_strips.cc (clay_strips::calc_local_matrix)
//   source/blender/editors/sculpt_paint/mesh/brushes/plane.cc (do_plane_brush's local matrix)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// NOT a brush kernel: this is the shared geometry that Clay Strips and the Plane family both need.
//
// Both brushes stop thinking in "distance from the cursor" and start thinking in a little box
// glued to the surface: z along the brush plane's normal, y along the stroke, x across it, and one
// unit of each axis = one brush radius. Blender builds that box as a 4x4, scales it by the radius
// and inverts it; because the three axes come out orthonormal, the inverse is just three dot
// products and a divide, which is what localFrame() returns. Writing it this way also makes the
// degenerate case explicit: a stroke pointing straight along the normal gives a zero x axis, and
// Blender's `math::invert` would hand back garbage, so we refuse the dab instead.

/**
 * The brush-local frame.
 *
 * @param {number[]} normal     the tip normal: the brush plane's normal (SPHERE) or the view
 *                              normal (TUBE). Defines z.
 * @param {number[]} direction  the stroke direction in part space (cache.grabDeltaSymm).
 * @param {number[]} center     the brush plane's centre, the local origin.
 * @param {number} radius       part-local brush radius = one unit on each axis.
 * @param {object} [o]          {flipZ, scaleY}
 *          flipZ   negate z, so the vertices Clay Strips works on get positive z.
 *          scaleY  Blender's tip_scale_x, which stretches the tip along the stroke.
 * @returns {{local(x, y, z, out): number[], reach: number}|null} null when the frame is degenerate.
 *          `reach` is how far from `center` the unit box can possibly extend, so a caller knows
 *          which vertices to gather.
 */
export function localFrame(normal, direction, center, radius, o = {}) {
  // x = normal x direction, y = normal x x, z = normal. Blender normalises the basis afterwards;
  // building y from the unnormalised x gives the same unit vector, so we normalise as we go.
  let ax = normal[1] * direction[2] - normal[2] * direction[1];
  let ay = normal[2] * direction[0] - normal[0] * direction[2];
  let az = normal[0] * direction[1] - normal[1] * direction[0];
  const al = Math.hypot(ax, ay, az);
  if (!(al > 0)) return null; // the hand moved along the normal: no "across the stroke" direction
  ax /= al; ay /= al; az /= al;

  let bx = normal[1] * az - normal[2] * ay;
  let by = normal[2] * ax - normal[0] * az;
  let bz = normal[0] * ay - normal[1] * ax;
  const bl = Math.hypot(bx, by, bz);
  if (!(bl > 0)) return null;
  bx /= bl; by /= bl; bz /= bl;

  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(nl > 0)) return null;
  const s = o.flipZ ? -1 / nl : 1 / nl;
  const cx = normal[0] * s, cy = normal[1] * s, cz = normal[2] * s;

  const scaleY = o.scaleY || 1;
  const invR = 1 / radius;
  const invRy = 1 / (radius * scaleY);
  const [ox, oy, oz] = center;

  return {
    local(x, y, z, out) {
      const dx = x - ox, dy = y - oy, dz = z - oz;
      out[0] = (ax * dx + ay * dy + az * dz) * invR;
      out[1] = (bx * dx + by * dy + bz * dz) * invRy;
      out[2] = (cx * dx + cy * dy + cz * dz) * invR;
      return out;
    },
    // |x| <= 1 and |y| <= 1 and |z| <= 1 in local units, so nothing outside this sphere can matter.
    reach: radius * Math.hypot(1, scaleY, 1),
  };
}

/**
 * Blender's square-tip distance, in local units where 1 = the brush radius.
 * tip_roundness 1 is an ordinary round tip; 0 is a perfect square; in between, everything inside
 * the square of half-width (1 - roundness) is at distance 0 (a flat top) and the rounded border
 * takes the rest. Outside the unit square the distance saturates at 1, which the radius filter
 * then throws away.
 */
export function cubeDistance(x, y, roundness) {
  const lx = Math.abs(x), ly = Math.abs(y);
  if (Math.max(lx, ly) > 1) return 1;
  const hardness = 1 - roundness;
  const ex = Math.max(lx - hardness, 0);
  const ey = Math.max(ly - hardness, 0);
  if (ex === 0 && ey === 0) return 0;
  // Blender's safe_rcp: 1/0 is 0, and with roundness 0 the excess above is already 0 anyway.
  const rcp = roundness !== 0 ? 1 / roundness : 0;
  return Math.min(Math.hypot(ex, ey) * rcp, 1);
}

/** The proxy vertices whose faces touch a sphere. Same query the engine's own gather uses. */
export function gatherSphere(proxy, center, radius) {
  return proxy.getVerticesFromFaces(proxy.intersectSphere(center, radius * radius));
}

/**
 * TUBE falloff flattens the brush against the screen: the vertex is projected onto the plane
 * through `center` with the view normal before it is put into the local frame.
 */
export function projectToPlane(x, y, z, center, normal, out) {
  const d = (x - center[0]) * normal[0] + (y - center[1]) * normal[1] + (z - center[2]) * normal[2];
  out[0] = x - normal[0] * d;
  out[1] = y - normal[1] * d;
  out[2] = z - normal[2] * d;
  return out;
}

/** (1 - mask) x front-face, the part of the weight chain that does not depend on the brush shape. */
export function baseFactor(v, mask, normals, viewNormal, frontFace) {
  let f = mask ? 1 - mask[v] : 1;
  if (f <= 0) return 0;
  if (frontFace) {
    const i3 = 3 * v;
    const d = viewNormal[0] * normals[i3] + viewNormal[1] * normals[i3 + 1] + viewNormal[2] * normals[i3 + 2];
    f *= Math.max(d, 0);
  }
  return f;
}
