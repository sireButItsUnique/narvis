// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (calc_factors_common_*, fill_factor_from_hide_and_mask, calc_front_face,
//      calc_brush_distances*, filter_distances_with_radius, apply_hardness_to_distances,
//      calc_brush_strength_factors)
//   source/blender/blenkernel/intern/brush.cc (BKE_brush_curve_strength / calc_curve_factors)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Every brush multiplies the same chain into one per-vertex weight:
//   f = (1 - mask) * front-face * [d < r] * falloff(hardness-remapped d)
// and the brush kernel only decides what to do with f.

/**
 * The ten distance falloff presets, written with q = 1 - d/r (q = 1 at the centre, 0 at the rim).
 * CUSTOM has no curve widget here, so it behaves like SMOOTH.
 */
export const FALLOFF_PRESETS = {
  SMOOTH: (q) => 3 * q * q - 2 * q * q * q,
  SMOOTHER: (q) => q * q * q * (q * (q * 6 - 15) + 10),
  SHARP: (q) => q * q,
  ROOT: (q) => Math.sqrt(q),
  LIN: (q) => q,
  CONSTANT: () => 1,
  SPHERE: (q) => Math.sqrt(2 * q - q * q),
  POW4: (q) => q * q * q * q,
  INVSQUARE: (q) => q * (2 - q),
  CUSTOM: (q) => 3 * q * q - 2 * q * q * q,
};

export const FALLOFF_KEYS = Object.keys(FALLOFF_PRESETS);

/** Blender's BKE_brush_curve_strength: 0 outside the radius, preset curve inside. */
export function curveStrength(preset, distance, radius) {
  if (!(distance < radius)) return 0;
  const fn = FALLOFF_PRESETS[preset] || FALLOFF_PRESETS.SMOOTH;
  return fn(1 - distance / radius);
}

/**
 * Hardness remaps the distance before the curve: everything inside hardness*r collapses onto the
 * centre and the rest is stretched back out over the remaining ring, so the dab gets a flat top.
 */
export function applyHardness(distance, radius, hardness) {
  if (hardness <= 0) return distance;
  const threshold = hardness * radius;
  if (hardness >= 1) return distance < threshold ? 0 : radius;
  if (distance < threshold) return 0;
  return ((distance / radius - hardness) / (1 - hardness)) * radius;
}

/** Distance used by the dab: straight 3D for SPHERE, in the view plane for TUBE. */
export function brushDistance(px, py, pz, location, falloffShape, viewNormal) {
  const dx = px - location[0], dy = py - location[1], dz = pz - location[2];
  if (falloffShape === 'TUBE' && viewNormal) {
    // distance to the ray through location along the view normal
    const t = dx * viewNormal[0] + dy * viewNormal[1] + dz * viewNormal[2];
    const ax = dx - viewNormal[0] * t, ay = dy - viewNormal[1] * t, az = dz - viewNormal[2] * t;
    return Math.hypot(ax, ay, az);
  }
  return Math.hypot(dx, dy, dz);
}

/**
 * Fill factors[] and distances[] for a list of proxy vertices.
 *
 * @param {object} proxy    forked SculptorMesh
 * @param {Uint32Array} verts vertices to weigh
 * @param {object} p        {location, radius, hardness, falloff, falloffShape, viewNormal,
 *                           frontFace, positions, normals, mask}
 *                          positions/normals default to the proxy's live arrays; pass the
 *                          stroke-start arrays for the brushes that work from original data.
 */
export function calcFactors(proxy, verts, p, factors, distances) {
  const positions = p.positions || proxy.getVertices();
  const normals = p.normals || proxy.getRenderNormals();
  const mask = p.mask === undefined ? proxy.getMask() : p.mask;
  const { location, radius, falloff, falloffShape, viewNormal } = p;
  const hardness = p.hardness || 0;
  const frontFace = !!p.frontFace;

  for (let k = 0; k < verts.length; k++) {
    const v = verts[k];
    const i3 = 3 * v;
    let f = mask ? 1 - mask[v] : 1;
    if (frontFace && f > 0) {
      const d = viewNormal[0] * normals[i3] + viewNormal[1] * normals[i3 + 1] + viewNormal[2] * normals[i3 + 2];
      f *= Math.max(d, 0);
    }
    const dist = brushDistance(positions[i3], positions[i3 + 1], positions[i3 + 2], location, falloffShape, viewNormal);
    distances[k] = dist;
    if (!(dist < radius)) { factors[k] = 0; continue; }
    const d2 = applyHardness(dist, radius, hardness);
    distances[k] = d2;
    factors[k] = f * curveStrength(falloff, d2, radius);
  }
  return factors;
}
