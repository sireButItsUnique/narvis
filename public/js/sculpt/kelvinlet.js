// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/blenkernel/intern/kelvinlet.cc
//     (BKE_kelvinlet_init_params, BKE_kelvinlet_grab / _biscale / _triscale,
//      BKE_kelvinlet_scale, BKE_kelvinlet_twist, sculpt_kelvinet_integrate)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// The maths is Pixar TM #17-03 "Regularized Kelvinlets: Sculpting Brushes based on Fundamental
// Solutions of Elasticity". The point of a Kelvinlet is that it is the displacement field of a
// real elastic solid under a point force, so the whole surface reacts to a pull the way clay
// would: no radius, no falloff curve, just physics that decays with distance. That is why it is
// the most forgiving brush to drive with a hand in the air - you cannot miss the edge of the dab,
// because there is no edge.
//
// The "regularisation" is the epsilon that stops the field blowing up at the pull point: every
// distance is softened to sqrt(r^2 + eps^2). One epsilon alone spreads the pull too far, so the
// bi- and tri-scale variants subtract two or three fields at eps, 2*eps and 4*eps to get a
// tighter, more local bump while keeping the elastic behaviour.

/**
 * Elastic constants for one brush size.
 * @param {number} radius     the brush radius in part-local metres (eps)
 * @param {number} force      scale/twist force; the grab variants ignore it
 * @param {number} shear      shear modulus (Blender always passes 1)
 * @param {number} poisson    Poisson ratio = the brush's volume preservation
 */
export function kelvinletParams(radius, force = 0, shear = 1, poisson = 0.4) {
  const a = 1 / (4 * Math.PI * shear);
  const b = a / (4 * (1 - poisson));
  const c = 2 * (3 * a - 2 * b);
  // Blender's fixed epsilon ladder: r, 2r, 4r.
  return { a, b, c, f: force, radiusScaled: [radius, radius * 2, radius * 4] };
}

/**
 * Formula (6) of the paper: the regularised radial weight at each epsilon.
 * @returns {number[]} `count` weights
 */
function grabWeights(p, distance, count) {
  const out = new Array(count);
  const d2 = distance * distance;
  for (let i = 0; i < count; i++) {
    const rs = p.radiusScaled[i];
    const re = Math.sqrt(d2 + rs * rs);
    const re3 = re * re * re;
    out[i] = (p.a - p.b) / re + (p.b * d2) / re3 + (p.a * rs * rs) / (2 * re3);
  }
  return out;
}

/** Single-scale grab: displacement = delta * fade(distance). */
export function kelvinletGrab(out, p, position, location, delta) {
  const d = Math.hypot(position[0] - location[0], position[1] - location[1], position[2] - location[2]);
  const fade = grabWeights(p, d, 1)[0] * p.c;
  out[0] = delta[0] * fade; out[1] = delta[1] * fade; out[2] = delta[2] * fade;
  return out;
}

/** Two epsilons subtracted: a tighter pull than the single scale, same elastic falloff. */
export function kelvinletGrabBiscale(out, p, position, location, delta) {
  const d = Math.hypot(position[0] - location[0], position[1] - location[1], position[2] - location[2]);
  const k = grabWeights(p, d, 2);
  const rs = p.radiusScaled;
  const fade = ((k[0] - k[1]) * p.c) / (1 / rs[0] - 1 / rs[1]);
  out[0] = delta[0] * fade; out[1] = delta[1] * fade; out[2] = delta[2] * fade;
  return out;
}

/**
 * Three epsilons, weighted so the far field cancels: this is what Essentials' Elastic Grab uses.
 * The weights come from matching the 1/r tails of the three fields.
 */
export function kelvinletGrabTriscale(out, p, position, location, delta) {
  const d = Math.hypot(position[0] - location[0], position[1] - location[1], position[2] - location[2]);
  const k = grabWeights(p, d, 3);
  const rs = p.radiusScaled;
  const s0 = rs[0] * rs[0], s1 = rs[1] * rs[1], s2 = rs[2] * rs[2];
  const w = [1, -((s2 - s0) / (s2 - s1)), (s1 - s0) / (s2 - s1)];
  const u = w[0] * k[0] + w[1] * k[1] + w[2] * k[2];
  const fade = (u * p.c) / (w[0] / rs[0] + w[1] / rs[1] + w[2] / rs[2]);
  out[0] = delta[0] * fade; out[1] = delta[1] * fade; out[2] = delta[2] * fade;
  return out;
}

/** Formula (16): a radial push/pull field, used by Elastic Scale. */
function fieldScale(out, position, location, _axis, p) {
  const rx = position[0] - location[0], ry = position[1] - location[1], rz = position[2] - location[2];
  const d = Math.hypot(rx, ry, rz);
  const rs = p.radiusScaled[0];
  const re = Math.sqrt(d * d + rs * rs);
  const re3 = re * re * re;
  const re5 = re3 * re * re;
  const u = (2 * p.b - p.a) * (1 / re3) + (3 * rs * rs) / (2 * re5);
  const fade = u * p.c * p.f;
  out[0] = rx * fade; out[1] = ry * fade; out[2] = rz * fade;
  return out;
}

/** Formula (15): a swirl about `axis`, used by Elastic Twist. */
function fieldTwist(out, position, location, axis, p) {
  const rx = position[0] - location[0], ry = position[1] - location[1], rz = position[2] - location[2];
  const d = Math.hypot(rx, ry, rz);
  const rs = p.radiusScaled[0];
  const re = Math.sqrt(d * d + rs * rs);
  const re3 = re * re * re;
  const re5 = re3 * re * re;
  const u = -p.a * (1 / re3) + (3 * rs * rs) / (2 * re5);
  const fade = u * p.c * p.f;
  out[0] = (axis[1] * rz - axis[2] * ry) * fade;
  out[1] = (axis[2] * rx - axis[0] * rz) * fade;
  out[2] = (axis[0] * ry - axis[1] * rx) * fade;
  return out;
}

/**
 * Scale and twist are not one-shot displacements: the field has to be followed, so Blender walks
 * it with one classic RK4 step. (Blender's third stage adds the whole k[2] and then subtracts the
 * brush location, which is not textbook RK4 - reproduced here because it is what the build does.)
 */
function integrate(field, out, position, location, axis, p) {
  const k0 = field([0, 0, 0], position, location, axis, p);
  const p1 = [position[0] + k0[0] * 0.5, position[1] + k0[1] * 0.5, position[2] + k0[2] * 0.5];
  const k1 = field([0, 0, 0], p1, location, axis, p);
  const p2 = [position[0] + k1[0] * 0.5, position[1] + k1[1] * 0.5, position[2] + k1[2] * 0.5];
  const k2 = field([0, 0, 0], p2, location, axis, p);
  const p3 = [
    position[0] + k2[0] - location[0],
    position[1] + k2[1] - location[1],
    position[2] + k2[2] - location[2],
  ];
  const k3 = field([0, 0, 0], p3, location, axis, p);
  out[0] = (k0[0] + 2 * k1[0] + 2 * k2[0] + k3[0]) / 6;
  out[1] = (k0[1] + 2 * k1[1] + 2 * k2[1] + k3[1]) / 6;
  out[2] = (k0[2] + 2 * k1[2] + 2 * k2[2] + k3[2]) / 6;
  return out;
}

export function kelvinletScale(out, p, position, location, axis) {
  return integrate(fieldScale, out, position, location, axis, p);
}

export function kelvinletTwist(out, p, position, location, axis) {
  return integrate(fieldTwist, out, position, location, axis, p);
}

/** The five Elastic Deform types, keyed by Blender's elastic_deform_type. */
export const KELVINLET_BY_TYPE = {
  GRAB: kelvinletGrab,
  GRAB_BISCALE: kelvinletGrabBiscale,
  GRAB_TRISCALE: kelvinletGrabTriscale,
  SCALE: kelvinletScale,
  TWIST: kelvinletTwist,
};
