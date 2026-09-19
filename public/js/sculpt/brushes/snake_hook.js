// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/snake_hook.cc
//     (do_snake_hook_brush, calc_pinch_influence, calc_rake_rotation_influence,
//      sculpt_rake_rotate, sculpt_project_v3, calc_kelvinet_translation)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc
//     (stroke_cache_update / brush_delta_update snake-hook branch, rake_data_update,
//      SCULPT_RAKE_BRUSH_FACTOR, brush_strength SNAKE_HOOK row)
//   source/blender/blenkernel/intern/kelvinlet.cc (see ../kelvinlet.js)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Snake Hook pulls a horn out of the surface. Three things make it that instead of a smeared Draw:
//
//   1. THE DAB FOLLOWS THE HAND, NOT THE SURFACE. Every other brush re-places its dab wherever the
//      aim ray hits the mesh. Snake Hook does that once, at the stroke start, and from then on the
//      dab centre simply travels by the hand's own movement (Blender: `location += grab_delta`,
//      using the PREVIOUS step's delta, so the centre lags the hand by one sample). That is why
//      the tip keeps its grip as the horn grows away from the body - the surface under the ray is
//      no longer where the brush is.
//   2. PINCH. crease_pinch_factor below 0.5 squeezes the ring of vertices towards the axis of the
//      pull as it goes, so the horn tapers instead of fattening. Above 0.5 it flares.
//   3. RAKE. The tip rotates to follow the curve of the stroke, by a quaternion raised to each
//      vertex's own weight, so the horn twists smoothly rather than shearing.
//
// The location override is the one thing a kernel cannot get from the engine, so this file keeps
// its own dab centre on the stroke cache, gathers its own vertices around it and weighs them
// itself. Everything it moves is announced with ctx.touch(), so undo and the render scatter see it.

import { calcFactors } from '../factors.js';
import { kelvinletParams, kelvinletGrabTriscale } from '../kelvinlet.js';

const RAKE_BRUSH_FACTOR = 0.25; // Blender's SCULPT_RAKE_BRUSH_FACTOR
const EPS = 0.00001;

/** Negate the components named by a symmetry pass (same rule as symmetry.js). */
function flip(v, symm) {
  return [symm & 1 ? -v[0] : v[0], symm & 2 ? -v[1] : v[1], symm & 4 ? -v[2] : v[2]];
}

/**
 * Mirror a rotation. An axis is a pseudo-vector, so reflecting the frame flips the mirrored
 * components AND the handedness: axis' = det(M) * M(axis), and the angle (the w term) is untouched.
 */
function flipQuat(q, symm) {
  const s = [symm & 1 ? -1 : 1, symm & 2 ? -1 : 1, symm & 4 ? -1 : 1];
  const det = s[0] * s[1] * s[2];
  return { w: q.w, x: det * s[0] * q.x, y: det * s[1] * q.y, z: det * s[2] * q.z };
}

/** The rotation that takes unit v1 to unit v2, as an axis and an angle. */
function axisAngleBetween(v1, v2) {
  let ax = v1[1] * v2[2] - v1[2] * v2[1];
  let ay = v1[2] * v2[0] - v1[0] * v2[2];
  let az = v1[0] * v2[1] - v1[1] * v2[0];
  const s = Math.hypot(ax, ay, az);
  const c = Math.min(Math.max(v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2], -1), 1);
  if (s < EPS) return null;
  return { axis: [ax / s, ay / s, az / s], angle: Math.atan2(s, c) };
}

/**
 * The dab centre for this step. Blender advances it by the previous step's hand movement, once
 * per stroke step, before the symmetry passes run - so this is stamped with the step counter.
 */
function advanceLocation(cache) {
  if (cache.snakeStep === cache.strokeStep) return;
  cache.snakeStep = cache.strokeStep;
  if (!cache.snakeLocation) {
    // The stroke's first dab is dropped for want of a direction, so the centre starts where the
    // very first aim ray landed.
    cache.snakeLocation = cache.initialLocation.slice();
    cache.snakePrevDelta = [0, 0, 0];
  } else {
    cache.snakeLocation = [
      cache.snakeLocation[0] + cache.snakePrevDelta[0],
      cache.snakeLocation[1] + cache.snakePrevDelta[1],
      cache.snakeLocation[2] + cache.snakePrevDelta[2],
    ];
  }
  cache.snakePrevDelta = cache.grabDelta.slice();
}

/** Blender's rake_data_update: the followed point creeps towards the hand once it is too far. */
function rakeUpdate(cache, grabLocation) {
  const f = cache.rakeFollowCo;
  const dist = Math.hypot(f[0] - grabLocation[0], f[1] - grabLocation[1], f[2] - grabLocation[2]);
  const followDist = cache.radius * RAKE_BRUSH_FACTOR;
  if (dist <= followDist) return;
  // Blender's own lerp factor here is the raw overshoot in metres, not a ratio.
  const t = dist - followDist;
  cache.rakeFollowCo = [
    f[0] + (grabLocation[0] - f[0]) * t,
    f[1] + (grabLocation[1] - f[1]) * t,
    f[2] + (grabLocation[2] - f[2]) * t,
  ];
}

/** The rake rotation for this step, or null. Computed once per step, like Blender's. */
function updateRake(cache, settings) {
  if (cache.rakeStep === cache.strokeStep) return;
  cache.rakeStep = cache.strokeStep;
  const grabLocation = cache.oldGrabLocation; // the hand's 3D point for this step
  if (!cache.rakeFollowCo) cache.rakeFollowCo = cache.origGrabLocation.slice();
  cache.rakeRotation = null;
  const rakeFactor = settings.rake_factor ?? 0;
  if (rakeFactor === 0) return;

  const g = cache.grabDelta;
  if (g[0] !== 0 || g[1] !== 0 || g[2] !== 0) {
    const f = cache.rakeFollowCo;
    const v1 = [f[0] - grabLocation[0], f[1] - grabLocation[1], f[2] - grabLocation[2]];
    const v2 = [v1[0] - g[0], v1[1] - g[1], v1[2] - g[2]];
    const l1 = Math.hypot(v1[0], v1[1], v1[2]);
    const l2 = Math.hypot(v2[0], v2[1], v2[2]);
    if (l1 > EPS && l2 > EPS) {
      const n1 = [v1[0] / l1, v1[1] / l1, v1[2] / l1];
      const n2 = [v2[0] / l2, v2[1] / l2, v2[2] / l2];
      const sep = (n1[0] - n2[0]) ** 2 + (n1[1] - n2[1]) ** 2 + (n1[2] - n2[2]) ** 2;
      if (sep > EPS) {
        const followDist = cache.radius * RAKE_BRUSH_FACTOR;
        const distSq = l1 * l1;
        const fade = distSq > followDist * followDist ? 1 : Math.sqrt(distSq) / followDist;
        const aa = axisAngleBetween(n1, n2);
        if (aa) {
          const half = (aa.angle * rakeFactor * fade) / 2;
          const s = Math.sin(half);
          cache.rakeRotation = {
            w: Math.cos(half),
            x: aa.axis[0] * s, y: aa.axis[1] * s, z: aa.axis[2] * s,
          };
        }
      }
    }
  }
  rakeUpdate(cache, grabLocation);
}

/** Rotate (p - centre) by q^power and return the resulting offset. */
function rakeOffset(out, q, centre, px, py, pz, power) {
  // q^power for a unit quaternion is the same axis at `power` times the angle.
  const vlen = Math.hypot(q.x, q.y, q.z);
  if (vlen < 1e-12 || power === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const half = Math.atan2(vlen, q.w) * power;
  const s = Math.sin(half) / vlen;
  const qw = Math.cos(half), qx = q.x * s, qy = q.y * s, qz = q.z * s;
  const vx = px - centre[0], vy = py - centre[1], vz = pz - centre[2];
  // v' = v + 2w(q x v) + 2 q x (q x v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = qw * tx + (qy * tz - qz * ty);
  out[1] = qw * ty + (qz * tx - qx * tz);
  out[2] = qw * tz + (qx * ty - qy * tx);
  return out; // already (rotated - original)
}

export const snakeHook = {
  key: 'snake_hook',
  presets: ['Snake Hook', 'Pull', 'Elastic Snake Hook'],
  type: 'SNAKE_HOOK',
  needsStrokeDirection: true,
  needsAreaNormal: false,
  lazy: false,
  apply(ctx) {
    const { proxy, cache, settings } = ctx;
    const symm = cache.mirrorSymmetryPass;
    advanceLocation(cache);
    updateRake(cache, settings);

    const loc = flip(cache.snakeLocation, symm);
    const g = cache.grabDeltaSymm;
    const elastic = settings.snake_hook_deform_type === 'ELASTIC';

    // Our own gather around the hand-following centre, not the engine's around the aim ray.
    const faces = proxy.intersectSphere(loc, cache.radius * cache.radius);
    const verts = proxy.getVerticesFromFaces(faces);
    if (verts.length === 0) return;

    const positions = proxy.getVertices();
    const factors = new Float32Array(verts.length);
    const distances = new Float32Array(verts.length);
    const mask = proxy.getMask();

    if (elastic) {
      factors.fill(1);
    } else {
      calcFactors(proxy, verts, {
        location: loc,
        radius: cache.radius,
        hardness: cache.hardness,
        falloff: settings.curve_distance_falloff_preset || 'SMOOTH',
        falloffShape: settings.falloff_shape || 'SPHERE',
        viewNormal: cache.viewNormalSymm,
        frontFace: !!settings.use_frontface,
      }, factors, distances);
      for (let k = 0; k < verts.length; k++) factors[k] *= cache.bstrength;
    }

    const translations = new Float32Array(verts.length * 3);
    for (let k = 0; k < verts.length; k++) {
      const f = factors[k];
      translations[3 * k] = g[0] * f;
      translations[3 * k + 1] = g[1] * f;
      translations[3 * k + 2] = g[2] * f;
    }

    pinchInfluence(ctx, verts, positions, factors, translations, loc, g);
    rakeInfluence(cache, verts, positions, factors, translations, loc, symm);

    if (elastic) {
      const params = kelvinletParams(cache.radius, cache.bstrength, 1, 0.4);
      const scale = cache.bstrength * 20;
      const p = [0, 0, 0], delta = [0, 0, 0], out = [0, 0, 0];
      for (let k = 0; k < verts.length; k++) {
        const v = verts[k];
        const i3 = 3 * v;
        p[0] = positions[i3]; p[1] = positions[i3 + 1]; p[2] = positions[i3 + 2];
        delta[0] = translations[3 * k]; delta[1] = translations[3 * k + 1]; delta[2] = translations[3 * k + 2];
        kelvinletGrabTriscale(out, params, p, loc, delta);
        const f = (mask ? 1 - mask[v] : 1) * scale;
        translations[3 * k] = out[0] * f;
        translations[3 * k + 1] = out[1] * f;
        translations[3 * k + 2] = out[2] * f;
      }
    }

    for (let k = 0; k < verts.length; k++) {
      const tx = translations[3 * k], ty = translations[3 * k + 1], tz = translations[3 * k + 2];
      if (tx === 0 && ty === 0 && tz === 0) continue;
      const v = verts[k];
      ctx.touch(v);
      positions[3 * v] += tx;
      positions[3 * v + 1] += ty;
      positions[3 * v + 2] += tz;
    }
  },
};

/**
 * Squeeze (or flare) the ring of vertices around the axis of the pull. The pinch is measured from
 * the vertex's position relative to the GRABBED point, which is why the horn tapers as it grows
 * instead of only at the dab.
 */
function pinchInfluence(ctx, verts, positions, factors, translations, loc, g) {
  const settings = ctx.settings;
  const cache = ctx.cache;
  const cp = settings.crease_pinch_factor ?? 0.5;
  if (cp === 0.5) return;
  const glenSq = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
  if (glenSq <= Number.EPSILON) return;
  const invNeg = -1 / glenSq;
  const pinch = (2 * (0.5 - cp) * Math.sqrt(glenSq)) / cache.radius;
  const tube = (settings.falloff_shape || 'SPHERE') === 'TUBE';
  const view = cache.viewNormalSymm;

  for (let k = 0; k < verts.length; k++) {
    const i3 = 3 * verts[k];
    let dx = positions[i3] - loc[0];
    let dy = positions[i3 + 1] - loc[1];
    let dz = positions[i3 + 2] - loc[2];
    if (tube) {
      const d = dx * view[0] + dy * view[1] + dz * view[2];
      dx -= view[0] * d; dy -= view[1] * d; dz -= view[2] * d;
    }
    dx += g[0]; dy += g[1]; dz += g[2];
    // strip the component along the pull, so the squeeze is purely radial
    const along = (dx * g[0] + dy * g[1] + dz * g[2]) * invNeg;
    dx += g[0] * along; dy += g[1] * along; dz += g[2] * along;
    const ix = dx, iy = dy, iz = dz;
    let fade = pinch * factors[k];
    if (pinch > 0) {
      // squeezing: ease off near the axis so it never pinches down to nothing
      const q = Math.min(1, Math.hypot(dx, dy, dz) / cache.radius);
      fade *= q * q;
    }
    const s = 1 + fade;
    translations[3 * k] += ix - dx * s;
    translations[3 * k + 1] += iy - dy * s;
    translations[3 * k + 2] += iz - dz * s;
  }
}

/** Twist the dab along the curve of the stroke, each vertex by its own share of the rotation. */
function rakeInfluence(cache, verts, positions, factors, translations, loc, symm) {
  if (!cache.rakeRotation) return;
  const q = flipQuat(cache.rakeRotation, symm);
  const out = [0, 0, 0];
  for (let k = 0; k < verts.length; k++) {
    const i3 = 3 * verts[k];
    rakeOffset(out, q, loc, positions[i3], positions[i3 + 1], positions[i3 + 2], factors[k]);
    translations[3 * k] += out[0];
    translations[3 * k + 1] += out[1];
    translations[3 * k + 2] += out[2];
  }
}

export default snakeHook;
