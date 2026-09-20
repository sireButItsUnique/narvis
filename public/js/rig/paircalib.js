// SPDX-License-Identifier: GPL-3.0-or-later
// Measuring the webcam pair instead of guessing it.
//
// rigtest2 used to DERIVE the pair's toe-in and tilt from "roughly where I sit", and then let the step 4
// trim absorb whatever was left over. A trim cannot fix a wrong ANGLE: it is a constant shift, and an angle
// error is a shift that changes with where you stand. One degree of toe error moves the triangulated head
// about a centimetre at 60 cm, so the hologram swims differently from every seat - which is exactly the
// failure the whole page exists to catch.
//
// So solve the pair's relative pose from data. The calibration target is the user's OWN FACE: both cameras
// already run MediaPipe's FaceLandmarker, the landmark indices mean the same physical point in both images,
// and moving the head round the working volume gives hundreds of correspondences per second with no printed
// pattern to hold.
//
// The maths is NOT here - it is public/js/track/calibrate.js, which is already tested. This file is the
// wiring: collect well-spread correspondences, hand them to relativePoseRansac, put the SCALE back (an
// essential matrix gives a unit translation only, so the baseline has to come from the tape measure), turn
// the answer into the rig-frame extrinsics cameras.js consumes, and refuse it out loud when it is not good
// enough to trust.
//
// WHAT IS MEASURED AND WHAT IS NOT. Two cameras looking at the same face can only ever see their pose
// RELATIVE to each other: rotate the whole pair and the scene with it and every pixel is unchanged. So
//   measured : the relative rotation (which is the toe-in, and any difference in tilt or roll between the
//              two cameras), and the direction of the baseline in the cameras' own frame.
//   assumed  : that the pair is symmetric about the rig centre and the baseline runs across the rig, which
//              is what the user measured with a tape.
//   carried  : the COMMON tilt up. Rolling the whole pair about its own baseline is invisible to the faces,
//              so that one degree of freedom stays at whatever the user typed or aimed. The page says so.
// Pretending otherwise would be the same lie in a new coat, so solvePair() reports which is which.

import { relativePoseRansac, triangulateNormalized, spreadCheck } from '../track/calibrate.js';
import { PinholeCamera, intrinsicsFromFov, fovFromFocal } from '../track/camera.js';
import {
  add, sub, scale, dot, cross, norm, normalize, matMul, matVec, transpose,
  rodrigues, orthonormalize, I3, mean, stddev,
} from '../track/linalg.js';

const DEG = Math.PI / 180;
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- landmarks

// A flat Float32Array of u,v per landmark: the worker sends this, and it is half the bytes of [x,y,z]
// triples for exactly the information the epipolar geometry can use.
export function packLm(lm) {
  if (!lm) return null;
  if (ArrayBuffer.isView(lm)) return lm;
  const out = new Float32Array(lm.length * 2);
  for (let i = 0; i < lm.length; i++) { out[i * 2] = lm[i][0]; out[i * 2 + 1] = lm[i][1]; }
  return out;
}
export const lmCount = p => (p ? p.length >> 1 : 0);
export const lmAt = (p, i) => [p[i * 2], p[i * 2 + 1]];

// The landmarks used as correspondences. A face is 478 points, but they sit on one head: taking all of them
// buys very little new geometry and costs RANSAC a great deal of time, so take a stride across the mesh
// (which spreads them over the whole face) plus the two iris centres, which are the best-localised points
// MediaPipe produces.
export const IRIS = [468, 473];
export const CALIB_LANDMARKS = (() => {
  const out = [];
  for (let i = 0; i < 468; i += 24) out.push(i);
  return out.concat(IRIS);
})();

// Where the face is in one image, and how the mesh is spread there. The centroid is the only "head
// position" available before anything is calibrated, which is precisely why the capture bins on it.
export function faceCentre(p, idx = null) {
  const n = lmCount(p);
  if (!n) return null;
  let su = 0, sv = 0, k = 0;
  const take = i => { const u = p[i * 2], v = p[i * 2 + 1]; if (Number.isFinite(u) && Number.isFinite(v)) { su += u; sv += v; k++; } };
  if (idx) { for (const i of idx) if (i < n) take(i); } else for (let i = 0; i < n; i++) take(i);
  return k ? [su / k, sv / k] : null;
}

// The point that stands in for "the head" when one is triangulated: the midpoint of the two irises when
// MediaPipe found them (that IS the eye the rig tracks), otherwise the whole mesh's centre.
export function headUV(p) {
  const n = lmCount(p);
  if (n > IRIS[1]) {
    const a = lmAt(p, IRIS[0]), b = lmAt(p, IRIS[1]);
    if (a.every(Number.isFinite) && b.every(Number.isFinite)) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return faceCentre(p);
}

// ---------------------------------------------------------------- capture

// Two free-running webcams are never in phase, so "the same moment" has to be a window. 35 ms is about one
// frame at 30 fps: a head moving at 20 cm/s travels 7 mm in that time, which is the noise floor here.
// The bins are the other half of the job: 500 frames of one pose is one pose, however many frames it is.
export const CAPTURE = {
  maxSkewMs: 35,        // both cameras must speak for nearly the same instant
  minGapMs: 70,         // and consecutive frames must be different moments, not the same pose twice
  perBin: 8,            // so one corner of the volume cannot dominate the fit
  maxFrames: 110,
  minFrames: 28,
  minBins: 10,          // of 27
  // The band edges below are image fractions; see binOf(). On this rig (40" apart, a head about 60 cm out,
  // a 78 degree lens on 1280x720) they work out at roughly 8 cm across, 7 cm near-to-far and 5 cm up and
  // down, which is a person shifting in their seat rather than a person doing gymnastics.
  bandL: 0.05,
  bandD: 0.09,
  bandV: 0.07,
  minLandmarks: 200,    // a face mesh shorter than this is not a face mesh
  // Once the buffer is full, a frame only displaces an older one while its band of the volume is this thin.
  // One frame of "further back" is enough to stop the page asking for it and not enough to weigh on the
  // fit, so the band is topped up to a few before the buffer settles.
  minPerBand: 3,
};

// Which cell of the working volume this frame is, WITHOUT using any calibration - because the calibration
// is the thing being measured, and binning on a triangulation from the angles under test would inherit
// their error. Both cameras face the user (rotDeg z = 180), so for a symmetric pair:
//   L = (uA + uB)/2 - 0.5   moves with the head across the rig only   (bigger = toward the viewer's left)
//   D = uA - uB             moves with the head's distance only       (bigger = further from the rig)
//   V = (vA + vB)/2 - 0.5   moves with the head's height only         (bigger = head lower; image v is down)
// The cross terms cancel to first order, which is what makes these three readable as "left/right",
// "near/far" and "up/down" in the advice the user is given.
export function binOf(a, b, cfg = CAPTURE) {
  const ca = faceCentre(a), cb = faceCentre(b);
  if (!ca || !cb) return null;
  const L = (ca[0] + cb[0]) / 2 - 0.5, D = ca[0] - cb[0], V = (ca[1] + cb[1]) / 2 - 0.5;
  const band = (x, w) => (x < -w ? 0 : x > w ? 2 : 1);
  const cell = [band(L, cfg.bandL), band(D, cfg.bandD), band(V, cfg.bandV)];
  return { L, D, V, cell, key: cell[0] * 9 + cell[1] * 3 + cell[2] };
}

const AXES = [
  { name: 'lateral', i: 0, miss: ['lean further to your right', '', 'lean further to your left'] },
  { name: 'depth', i: 1, miss: ['move closer to the rig', '', 'move further back'] },
  { name: 'height', i: 2, miss: ['lift your head higher', '', 'lower your head'] },
];

/**
 * Collects matched face-landmark frames while the user moves about. Pure: the page feeds it, tests feed it.
 */
export function makeCapture(opts = {}) {
  const { stamp = '', ...rest } = opts;
  const cfg = { ...CAPTURE, ...rest };
  const frames = [], bins = new Map();
  let lastAt = -Infinity, evicted = 0;
  const skipped = { noFace: 0, short: 0, skew: 0, soon: 0, binFull: 0, full: 0 };

  const bandCounts = () => {
    const counts = AXES.map(() => [0, 0, 0]);
    for (const f of frames) AXES.forEach((ax, k) => { counts[k][f.cell[ax.i]]++; });
    return counts;
  };
  // Is this cell in a band that is still thin? That is the only reason to displace an older frame.
  const wantsCell = (cell) => {
    const c = bandCounts();
    return AXES.some((ax, k) => c[k][cell[ax.i]] < cfg.minPerBand);
  };
  // Make room by dropping the OLDEST frame from the most over-represented bin. Only a bin holding two or
  // more is touched, so making room can never empty a bin - and so never loses a band that is already
  // covered, which would just move the "still missing" complaint somewhere else.
  const evictOne = () => {
    let key = null, most = 1;
    for (const [k, n] of bins) if (n > most) { most = n; key = k; }
    if (key === null) return false;
    const i = frames.findIndex(f => f.key === key);
    if (i < 0) return false;
    frames.splice(i, 1);
    bins.set(key, most - 1);
    evicted++;
    return true;
  };

  const api = {
    cfg, frames, stamp,
    /** @param f { tA, tB, a, b } - capture timestamps in ms and the two face meshes, matched by index. */
    add(f) {
      const a = packLm(f.a), b = packLm(f.b);
      if (!a || !b) { skipped.noFace++; return { ok: false, why: 'no-face' }; }
      const n = Math.min(lmCount(a), lmCount(b));
      if (n < cfg.minLandmarks) { skipped.short++; return { ok: false, why: 'short-mesh' }; }
      if (Math.abs(f.tA - f.tB) > cfg.maxSkewMs) { skipped.skew++; return { ok: false, why: 'skew' }; }
      const t = (f.tA + f.tB) / 2;
      if (t - lastAt < cfg.minGapMs) { skipped.soon++; return { ok: false, why: 'too-soon' }; }
      const bin = binOf(a, b, cfg);
      if (!bin) { skipped.noFace++; return { ok: false, why: 'no-face' }; }
      if ((bins.get(bin.key) || 0) >= cfg.perBin) { skipped.binFull++; return { ok: false, why: 'bin-full' }; }
      // The cap is a budget, not a wall. It used to be checked BEFORE the bin, so once 110 frames were in,
      // no new part of the volume could ever be recorded - and a capture that filled up before the user had
      // leaned back went on asking forever for the one movement it was throwing away. A frame from a band
      // that has never been seen now displaces the oldest frame of the most over-represented bin instead.
      if (frames.length >= cfg.maxFrames && !(wantsCell(bin.cell) && evictOne()))
        { skipped.full++; return { ok: false, why: 'enough' }; }
      bins.set(bin.key, (bins.get(bin.key) || 0) + 1);
      lastAt = t;
      frames.push({ t, a, b, n, ...bin });
      return { ok: true, bin: bin.cell, frames: frames.length };
    },

    /** Live progress: how many usable views, how well spread, and what is still missing. */
    progress() {
      const counts = bandCounts();
      const missing = [];
      AXES.forEach((ax, k) => {
        for (const band of [0, 2]) if (!counts[k][band]) missing.push(ax.miss[band]);
      });
      const filled = bins.size;
      const enough = frames.length >= cfg.minFrames && filled >= cfg.minBins && !missing.length;
      // Enough to solve with, even though a direction is still missing. Worth saying: the page used to show
      // a full bar and an instruction at the same time, which reads as "stuck" when it is not.
      const solvable = frames.length >= cfg.minFrames && filled >= cfg.minBins;
      return {
        frames: frames.length, maxFrames: cfg.maxFrames, minFrames: cfg.minFrames,
        binsFilled: filled, binsTotal: 27, minBins: cfg.minBins,
        axes: Object.fromEntries(AXES.map((ax, k) => [ax.name, counts[k]])),
        missing, ready: enough, solvable, evicted, skipped: { ...skipped },
        // One number for a progress bar: the worst of "enough frames" and "enough of the volume". It stops
        // short of full while a direction is missing, because 100% and "still missing" together is a lie.
        fraction: clamp(Math.min(frames.length / cfg.minFrames, filled / cfg.minBins, enough ? 1 : 0.95), 0, 1),
      };
    },

    reset() {
      frames.length = 0; bins.clear(); lastAt = -Infinity; evicted = 0;
      for (const k of Object.keys(skipped)) skipped[k] = 0;
    },
  };
  return api;
}

// A one-line description of where the capture stands, for the flag on the glass.
export function captureLines(p) {
  const out = [
    `${p.frames} of ${p.minFrames} usable views  ·  ${p.binsFilled} of ${p.minBins} parts of the volume`,
  ];
  if (p.missing.length)
    out.push('still missing: ' + p.missing.join(', ')
      + (p.solvable ? ' — or press Solve, there is already enough' : ''));
  else if (!p.ready) out.push('keep moving: more views needed');
  else out.push('spread is good — press Solve');
  return out;
}

// ---------------------------------------------------------------- rotations, in this rig's convention

// stereo.js turns a camera vector into a world vector with Rz*Ry*Rx (see camToWorld/rotateVec), camera axes
// x right in the image, y down, z out of the lens. Everything below speaks that convention so the solved
// numbers can be handed straight to cameras.js as ext.rotDeg.
export function rotFromDeg([rx, ry, rz]) {
  const a = rx * DEG, b = ry * DEG, c = rz * DEG;
  const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
          sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
          -sy, cy * sx, cy * cx];
}
/** The inverse: a camera-to-world rotation back to [rx, ry, rz] degrees. */
export function degFromRot(M) {
  const sy = clamp(-M[6], -1, 1), ry = Math.asin(sy), cy = Math.cos(ry);
  if (Math.abs(cy) < 1e-7)                       // straight up or down: rx and rz are the same turn
    return [0, ry / DEG, Math.atan2(-M[1], M[4]) / DEG];
  return [Math.atan2(M[7], M[8]) / DEG, ry / DEG, Math.atan2(M[3], M[0]) / DEG];
}

/** A PinholeCamera posed by { posCm, rotDeg } - the same pose cameras.js gives stereo.js. */
export function cameraFromExt({ posCm = [0, 0, 0], rotDeg = [0, 0, 180], width = 1280, height = 720,
                                dfovDeg = 78, id = 'cam', label = id } = {}) {
  const K = intrinsicsFromFov({ width, height, fovDeg: dfovDeg, fovAxis: 'diagonal' });
  // PinholeCamera.R is world->camera, which is the transpose of the camera-to-world rotation above.
  return new PinholeCamera({ id, label, role: 'head', ...K, position: posCm.slice(), R: transpose(rotFromDeg(rotDeg)) });
}
/** The same camera with no pose: all the solve needs is the lens, to turn pixels into normalised rays. */
export const lensOnly = ({ width = 1280, height = 720, dfovDeg = 78, id = 'cam' } = {}) =>
  cameraFromExt({ width, height, dfovDeg, id });

// The shortest rotation taking one direction onto another.
function rotationBetween(u, w) {
  const a = normalize(u), b = normalize(w), c = clamp(dot(a, b), -1, 1);
  if (c > 1 - 1e-12) return I3();
  if (c < -1 + 1e-12) {                          // opposite: half a turn about any perpendicular
    let ax = cross(a, [1, 0, 0]);
    if (norm(ax) < 1e-6) ax = cross(a, [0, 1, 0]);
    return rodrigues(scale(normalize(ax), Math.PI));
  }
  const ax = cross(a, b);
  return rodrigues(scale(normalize(ax), Math.atan2(norm(ax), c)));
}
const frob2 = (A, B) => { let s = 0; for (let i = 0; i < 9; i++) s += (A[i] - B[i]) ** 2; return s; };
export const angleBetweenDeg = (a, b) => Math.acos(clamp(dot(normalize(a), normalize(b)), -1, 1)) / DEG;
/** How far apart two rotations are, in degrees - the honest way to compare two camera aims. */
export function rotationDeltaDeg(A, B) {
  const M = matMul(A, transpose(B));
  return Math.acos(clamp((M[0] + M[4] + M[8] - 1) / 2, -1, 1)) / DEG;
}

// ---------------------------------------------------------------- the solve

export const POSE_VERSION = 1;
export const SOLVE = {
  thresholdPx: 2.5,         // Sampson inlier threshold; MediaPipe landmark noise is well under a pixel
  iterations: 400,
  seed: 12345,
  minPairs: 120,
  maxPairs: 2200,           // RANSAC is linear in this, and the answer stops improving long before
  minInliers: 40,
  minInlierRatio: 0.55,
  maxBaselineOffDeg: 12,    // the solved baseline vs the one the user measured across the rig
  maxToeDeltaDeg: 12,       // the solved toe-in vs the angles being replaced
  // The capture has to have MOVED, measured on its widest axis. It used to be measured on the NARROWEST,
  // which refused captures that solve perfectly well: a head sliding along one line still carries the
  // geometry in the face's own relief, and this was the only refusal that ever fired on a real capture.
  minSpreadMm: 40,
  minDepthCm: 20, maxDepthCm: 200,
};

// A focal error does not just scale depth - it bends the toe-in, at roughly half a degree of relative
// rotation per 1% of focal error, and the anchoring then carries that into the rig as a real rotation. At
// about 3% (some 2 degrees of diagonal FOV) the solved pose is no better than the typed angles it replaces,
// and no residual or inlier number can see it, because a wrong K is self-consistent in BOTH cameras. So the
// lens is said out loud wherever the solve is reported, and the hold check measures it: see makeHoldCheck.
export const LENS_LIMIT_NOTE =
  'the solve is only as good as the lens fov in step 2: about 2 degrees of diagonal FOV out is break-even '
  + 'against the angles this replaces, and the residual cannot see it — the hold check below can';

/**
 * Solve the pair's relative pose from captured face frames and turn it into rig-frame extrinsics.
 *
 * @param frames      from makeCapture()
 * @param camA/camB   PinholeCameras for the LEFT and RIGHT webcam (lens only; the pose is the output)
 * @param baselineCm  the measured centre-to-centre distance. This is the ONLY source of scale.
 * @param typed       { toeInDeg, tiltUpDeg } the angles being replaced - the sanity check, and the one
 *                    degree of freedom (roll about the baseline) the faces cannot see.
 * @param expectedDepthCm  optional: how far the user says their head sits from the pair. Reported, never
 *                    refused on - the iris is a few cm in front of the head centre and the capture covers a
 *                    whole volume, so a few percent of disagreement is normal and a gate would misfire.
 * @returns { ok, pose?, reasons?, report }
 */
export function solvePair({ frames, camA, camB, baselineCm, typed = { toeInDeg: 0, tiltUpDeg: 0 },
                            expectedDepthCm = null, opts = {} }) {
  const cfg = { ...SOLVE, ...opts };
  const idx = cfg.landmarks || CALIB_LANDMARKS;
  const reasons = [];
  const fail = (code, text) => { reasons.push({ code, text }); };

  // ---- correspondences, in pixels, pooled over every captured frame. The cameras do not move between
  // frames, so every pair from every pose obeys the same epipolar constraint: that is what makes a moving
  // face a calibration target at all.
  const pairs = [], ofFrame = [];
  for (const f of frames || []) {
    for (const i of idx) {
      if (i >= f.n) continue;
      const pa = lmAt(f.a, i), pb = lmAt(f.b, i);
      if (!Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) continue;
      pairs.push({ a: { u: pa[0] * camA.width, v: pa[1] * camA.height },
                   b: { u: pb[0] * camB.width, v: pb[1] * camB.height } });
      ofFrame.push(f);
    }
  }
  // Too many correspondences only slow RANSAC down; thin them evenly so every pose keeps its share.
  let use = pairs, useFrame = ofFrame;
  if (pairs.length > cfg.maxPairs) {
    const step = pairs.length / cfg.maxPairs;
    use = []; useFrame = [];
    for (let k = 0; k < cfg.maxPairs; k++) { const i = Math.floor(k * step); use.push(pairs[i]); useFrame.push(ofFrame[i]); }
  }
  // The lens the solve is being run with, carried on the answer. It is an INPUT, not a measurement, and it
  // sets the toe-in as directly as the pictures do - so a pose that does not say which lens it was fitted
  // against cannot be checked later against the lens the app is decoding with.
  const dfovOf = c => round(fovFromFocal(c.fx, Math.hypot(c.width, c.height)), 2);
  const report = { frames: (frames || []).length, pairs: use.length, landmarks: idx.length,
                   dfovDeg: [dfovOf(camA), dfovOf(camB)] };
  if (use.length < cfg.minPairs) {
    fail('data', `Only ${use.length} matched points were captured; the solve needs at least ${cfg.minPairs}. `
      + 'Run the capture again and keep both cameras seeing your face.');
    return { ok: false, reasons, report };
  }

  // ---- the essential matrix, RANSAC'd. relativePoseRansac's own refinement step IS refineRelativePose
  // (over the inliers, with the cheirality check redone afterwards), so it is not called again here - doing
  // it twice on the same set would only risk walking to the sign-flipped twin without the guard.
  const rp = relativePoseRansac(camA, camB, use, {
    iterations: cfg.iterations, thresholdPx: cfg.thresholdPx, seed: cfg.seed,
    minInliers: Math.min(cfg.minInliers, Math.floor(use.length / 2)), refine: true,
  });
  if (!rp) {
    fail('pose', 'No relative pose fitted the captured points at all. Either the two cameras were not '
      + 'looking at the same face, or the landmarks are too noisy to use.');
    return { ok: false, reasons, report };
  }
  const { R, t } = rp;
  report.inliers = rp.inliers.length;
  report.inlierRatio = round(rp.inlierRatio, 3);
  report.sampsonRmsPx = round(rp.sampsonRmsPx, 3);

  // (There used to be an optional bundleAdjust "polish" here. On a two-view problem it has 6 pose degrees
  // of freedom against 3 per point and nothing else to pin it, so it walks BACK toward the answer
  // refineRelativePose already had at best, and overfits a handful of points at worst - measured over 7
  // seeds of the synthetic session it was 2x to 22x worse than not running it, every time, while reporting
  // a smaller reprojection number than the Sampson one because it was fitted to fewer points. A knob that
  // is never right is not an option, so it is gone.)

  // ---- SCALE. The essential matrix gives a unit translation: the pair could be two webcams a metre apart
  // or two grains of sand. The only metric number in the whole procedure is the baseline the user measured.
  const cB = scale(matVec(transpose(R), t), -baselineCm);   // camera B's centre, in camera A's frame, in cm
  report.scaleFrom = `measured baseline ${round(baselineCm, 1)} cm`;

  // ---- into the rig. Anchor the pair the way the user measured it: symmetric about the rig centre with
  // the baseline running across the rig (+X). That fixes two of the three remaining degrees of freedom;
  // the third, a roll about the baseline (= the pair's COMMON tilt up), is invisible to the faces, so it is
  // taken from the angles being replaced.
  const typedA = transpose(rotFromDeg([typed.tiltUpDeg, -typed.toeInDeg, 180]));   // world->cam, left
  const typedB = transpose(rotFromDeg([typed.tiltUpDeg, typed.toeInDeg, 180]));    // world->cam, right
  const Q0 = rotationBetween(normalize(cB), [1, 0, 0]);
  const at = (deg) => {
    const Q = matMul(rodrigues([deg * DEG, 0, 0]), Q0);
    const RA = orthonormalize(transpose(Q)), RB = orthonormalize(matMul(R, transpose(Q)));
    return { deg, Q, RA, RB, cost: frob2(RA, typedA) + frob2(RB, typedB) };
  };
  let best = at(0);
  for (let d = -180; d < 180; d += 0.5) { const c = at(d); if (c.cost < best.cost) best = c; }
  for (let d = best.deg - 0.5; d <= best.deg + 0.5; d += 0.01) { const c = at(d); if (c.cost < best.cost) best = c; }
  const half = baselineCm / 2;
  const left = { posCm: [-half, 0, 0], rotDeg: extRotDeg(best.RA) };
  const right = { posCm: [half, 0, 0], rotDeg: extRotDeg(best.RB) };

  // ---- the head, triangulated with the solved pose, in the rig's own centimetres. This is what the
  // spread check and the depth sanity check actually look at, and what proves the scale landed.
  const heads = [];
  for (const f of (frames || [])) {
    const ua = headUV(f.a), ub = headUV(f.b);
    if (!ua || !ub) continue;
    const X = triangulateNormalized(R, t, camA.normalized(ua[0] * camA.width, ua[1] * camA.height),
                                          camB.normalized(ub[0] * camB.width, ub[1] * camB.height));
    if (!X || !X.every(Number.isFinite)) continue;
    heads.push(add(matVec(best.Q, scale(X, baselineCm)), left.posCm));
  }
  report.heads = heads.length;
  const depths = heads.map(h => Math.hypot(h[0], h[1], h[2]));
  const medianDepthCm = depths.length ? percentileOf(depths, 0.5) : 0;
  report.medianDepthCm = round(medianDepthCm, 1);
  // How far the triangulated head sits from where the user says they sit. NOT a refusal: the iris is a few
  // cm in front of the head centre and the capture covers a whole volume, so this reads several percent
  // high even with a perfect lens. It is reported because it is the only place a wrong lens fov shows up at
  // all - it drifts about 3% per degree of diagonal FOV, while the residual moves the wrong way.
  if (Number.isFinite(expectedDepthCm) && expectedDepthCm > 0 && medianDepthCm > 0)
    report.depthVsNamedPct = round((medianDepthCm / expectedDepthCm - 1) * 100, 1);

  const spread = spreadCheck(heads.map(h => scale(h, 10)), cfg.minSpreadMm);      // spreadCheck works in mm
  const perAxisMm = (spread.perAxisMm || []).map(n => round(n, 0));
  const widestMm = perAxisMm.length ? Math.max(...perAxisMm) : 0;
  // Refuse on the WIDEST axis, not the narrowest: what makes a capture useless is not moving at all. A head
  // that slid along one line has moved, and the face's own relief carries the rest of the geometry.
  report.spread = { ok: widestMm >= cfg.minSpreadMm, perAxisMm, widestMm,
                    minAxisMm: round(spread.minAxisMm || 0, 0), thin: !spread.ok };

  // The epipolar error in pixels, carried out to the distance the head sits at. This is the CONSISTENCY of
  // the fit with itself, not its accuracy, and it is worth being blunt about why: an inlier is by
  // definition under thresholdPx, so this number cannot exceed the ceiling below whatever the pose is, and
  // it FALLS when the lens fov is wrong. The accuracy number is the ray miss on the live readout.
  const f = (camA.fx + camB.fx) / 2;
  report.residualMm = round(medianDepthCm > 0 ? rp.sampsonRmsPx / f * medianDepthCm * 10 : 0, 2);
  report.residualCeilingMm = round(medianDepthCm > 0 ? cfg.thresholdPx / f * medianDepthCm * 10 : 0, 2);

  // ---- angles, and whether they are believable
  const solvedToe = (right.rotDeg[1] - left.rotDeg[1]) / 2;
  const solvedTilt = (right.rotDeg[0] + left.rotDeg[0]) / 2;
  report.toeInDeg = round(solvedToe, 2);
  report.tiltUpDeg = round(solvedTilt, 2);
  report.dToeDeg = round(solvedToe - typed.toeInDeg, 2);
  report.dTiltDeg = round(solvedTilt - typed.tiltUpDeg, 2);
  report.asymmetryDeg = round(Math.abs(right.rotDeg[0] - left.rotDeg[0]), 2);
  // The two cameras' yaws about the baseline. A symmetric pair sums to zero, so this is the part of the
  // solved rotation the mean toe-in throws away - it was measured and then silently dropped, which let a
  // pair that is a degree out on one side alone read as a pair that is bang on.
  report.asymmetryYawDeg = round(Math.abs(right.rotDeg[1] + left.rotDeg[1]), 2);

  // The baseline check: take the solved A->B direction out of camera A's frame using the angles the user
  // typed, and compare it with the direction they measured (straight across the rig). A pair marked the
  // wrong way round comes out about 180 degrees off, which is the failure this catches first.
  const measuredDir = matVec(transpose(typedA), normalize(cB));
  const offDeg = angleBetweenDeg(measuredDir, [1, 0, 0]);
  report.baselineOffDeg = round(offDeg, 2);
  // Would it agree if the two cameras were exchanged? Exchanging them turns (R, t) into (R^T, -R^T t), so
  // the baseline direction in the other camera's frame is just t: the alternative hypothesis costs nothing
  // to test. A toed-in pair marked the wrong way round does NOT come out 180 degrees wrong - it comes out
  // about twice the toe-in wrong - so "is x negative" would miss it, and this does not.
  const altOff = angleBetweenDeg(matVec(transpose(typedA), normalize(t)), [1, 0, 0]);
  report.baselineSwappedOffDeg = round(altOff, 2);
  report.baselineSwapped = altOff < offDeg - 15;

  // ---- the four ways this is refused. All of them are reported, not just the first: "it failed" is not
  // an answer a person can act on.
  if (!report.spread.ok)
    fail('spread', `You did not move far enough while capturing: the head positions only span `
      + `${report.spread.widestMm} mm on their widest axis, and ${cfg.minSpreadMm} mm is the minimum. `
      + 'A fit from one spot looks perfect there and is wrong everywhere else. Press "Throw the capture '
      + 'away" and capture again, going to the corners of where you actually sit.');
  if (rp.inlierRatio < cfg.minInlierRatio)
    fail('inliers', `Only ${Math.round(rp.inlierRatio * 100)}% of the ${use.length} matched points fitted one `
      + `pose (${Math.round(cfg.minInlierRatio * 100)}% is the minimum). The two cameras were probably not `
      + 'looking at the same face at the same moment, or one of them was moved during the capture — or the '
      + 'buffer still holds frames from before you changed something. Press "Throw the capture away" and '
      + 'capture again.');
  if (offDeg > cfg.maxBaselineOffDeg)
    fail('baseline', `The solve puts the line between the two cameras ${report.baselineOffDeg} degrees away `
      + `from running across the rig, and you measured them as level and symmetric. `
      + (report.baselineSwapped
         ? 'They look marked the wrong way round: swap left and right in step 1, then press "Throw the '
           + 'capture away" — the frames already captured describe the old marking — and capture again.'
         : 'Check the baseline, the height and the depth in step 2, or re-measure the mounting.'));
  if (Math.abs(report.dToeDeg) > cfg.maxToeDeltaDeg)
    fail('angles', `The solve says the cameras are toed in ${report.toeInDeg} degrees, but the angles it `
      + `would replace say ${round(typed.toeInDeg, 1)}. That is ${Math.abs(report.dToeDeg)} degrees apart, `
      + 'which is too big to be a correction — one of the two is describing a different pair of cameras.');
  if (!(medianDepthCm >= cfg.minDepthCm && medianDepthCm <= cfg.maxDepthCm))
    fail('depth', `With this pose your head triangulates ${report.medianDepthCm} cm from the rig centre, `
      + 'which is not a place a person sits. The solve found a pose, but not yours.');

  if (reasons.length) return { ok: false, reasons, report };

  const pose = {
    version: POSE_VERSION, savedAt: new Date().toISOString(),
    baselineCm, left, right, toeInDeg: report.toeInDeg, tiltUpDeg: report.tiltUpDeg,
    scaleFrom: report.scaleFrom,
    // The lens this pose was fitted against. It sets the toe-in as directly as the baseline sets the
    // positions, so like the baseline it has to travel with the pose: changing it later means the pose
    // describes a pair of cameras that no longer exists.
    dfovDeg: report.dfovDeg.slice(),
    // what was measured and what was not, carried with the pose so the page can never overstate it
    tiltFromTyped: true, typedTiltUpDeg: typed.tiltUpDeg, rollDeg: round(best.deg, 2),
    report,
  };
  return { ok: true, pose, report };
}

// A camera facing the user has rz near 180, and atan2 hands that back as either +179.9 or -179.9. Two
// cameras landing on opposite sides of the cut read as 360 degrees of roll apart - on screen, in the
// asymmetry number, and in anything that subtracts them. Keep rz in [0, 360) so 180 is in the middle of
// the range instead of on its edge; the rotation is identical either way.
function extRotDeg(worldToCam) {
  const d = degFromRot(transpose(worldToCam));
  return [round(d[0], 3), round(d[1], 3), round(((d[2] % 360) + 360) % 360, 3)];
}

function percentileOf(xs, p) {
  const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// ---------------------------------------------------------------- what the page shows

/** The solve, in the sentences a person at the rig can act on. */
export function solveLines(res) {
  const r = res.report || {};
  const head = res.ok ? 'MEASURED — the pair now uses the solved pose' : 'REFUSED — the typed angles are kept';
  const lines = [head, ''];
  lines.push(`views ${r.frames}  ·  matched points ${r.pairs}`
    + (r.inliers != null ? `  ·  inliers ${r.inliers} (${Math.round((r.inlierRatio || 0) * 100)}%)` : ''));
  // NOT "residual". It is the epipolar error of the fit against itself, measured over the points that were
  // close enough to be called inliers - so it can never exceed the ceiling, it says nothing about whether
  // the pose is right, and with a wrong lens fov it gets SMALLER as the pose gets worse. Say all of that
  // where the number is, because a small number in millimetres reads as "accurate to a millimetre".
  if (r.residualMm != null)
    lines.push(`epipolar fit ${r.residualMm} mm at ${r.medianDepthCm} cm  ·  ${r.sampsonRmsPx} px`
      + (r.residualCeilingMm ? `  (consistency of the fit with itself, NOT accuracy: anything under `
        + `${r.residualCeilingMm} mm is possible whatever the pose)` : ''));
  if (r.spread)
    lines.push(`spread ${r.spread.perAxisMm.join(' / ')} mm (x / y / z), widest ${r.spread.widestMm} mm`
      + (r.spread.thin ? `  ·  thin on one axis (${r.spread.minAxisMm} mm) — still solvable, but move more` : ''));
  // The angles are only meaningful once the baseline has been anchored, so when THAT is what failed they
  // are not reported as if they were an answer - they would be the aim of a pair that does not exist.
  const anchored = !(res.reasons || []).some(x => x.code === 'baseline');
  if (r.toeInDeg != null && anchored)
    lines.push(`toe-in ${r.toeInDeg} deg (was ${round(r.toeInDeg - r.dToeDeg, 1)})  ·  tilt ${r.tiltUpDeg} deg`
      + `  ·  the two cameras differ by ${r.asymmetryDeg} deg in tilt and ${r.asymmetryYawDeg} deg in yaw`);
  else if (r.toeInDeg != null)
    lines.push('angles: not reported — they are only meaningful once the baseline is anchored, and it is not');
  if (r.baselineOffDeg != null) lines.push(`baseline ${r.baselineOffDeg} deg off the line you measured`);
  if (r.scaleFrom) lines.push(`scale: ${r.scaleFrom} — the faces alone cannot set it`);
  if (r.dfovDeg) lines.push(`lens: solved with ${r.dfovDeg.map(d => `${d} deg`).join(' / ')} diagonal fov — `
    + LENS_LIMIT_NOTE);
  if (r.depthVsNamedPct != null)
    lines.push(`your head triangulates ${r.medianDepthCm} cm from the pair, ${r.depthVsNamedPct > 0 ? '+' : ''}`
      + `${r.depthVsNamedPct}% against the spot you named (a few percent is normal — the iris sits in front `
      + 'of the head centre — but tens of percent is the lens fov, not the angles)');
  if (res.ok) lines.push('the common tilt up is NOT measured (rolling the whole pair is invisible to a face);'
    + ' it is kept from the angles it replaced');
  for (const x of (res.reasons || [])) lines.push('', `${x.code.toUpperCase()}: ${x.text}`);
  return lines;
}

// ---------------------------------------------------------------- hold still where you say you are

// The check that needs no faith in the hardware: stand at a spot you can point at, hold still, and the page
// says how far the solved pair puts you from it. A calibration that cannot survive this is not calibrated.
//
// It used to average EVERYTHING since the button was pressed, with no settling period and no stop: walking
// to the spot over two seconds and then standing on it reported 16 cm of error that was entirely the walk,
// and a finished, correct reading turned itself back into a wrong one as soon as the user leaned over to
// read it. So: the clock only runs while the head is actually still, the mean is over a trailing window,
// and the answer freezes the moment it is a measurement.
export const HOLD = {
  ms: 2000,          // how long the head has to be still for this to be a measurement
  stepMm: 5,         // a jump bigger than this between samples is the user moving, not wobbling
  spreadMm: 10,      // and a window spanning more than this was never a hold
};

export function makeHoldCheck({ expectedCm, originCm = null, lens = null, ms = HOLD.ms, opts = {} } = {}) {
  const cfg = { ...HOLD, ...opts };
  let win = [];                     // {p, t}: only samples from the current unbroken still stretch
  let t0 = null, last = null, frozen = null, jumped = false;

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const spreadOf = () => [0, 1, 2].map(k => {
    const xs = win.map(s => s.p[k]);
    return Math.max(...xs) - Math.min(...xs);
  });

  // Where a wrong lens fov shows up: a focal error is a radial scale about the tracker's own origin, so the
  // named spot being consistently too far or too near is the one metric measurement on the page. f scales
  // almost 1:1 with that ratio, so this hands back the fov to type into step 2 and solve again.
  function lensHint(meanCm) {
    if (!lens?.dfovDeg || !originCm) return null;
    const want = dist(expectedCm, originCm), got = dist(meanCm, originCm);
    if (!(want > 5 && got > 5)) return null;
    const ratio = got / want;
    const diag = Math.hypot(lens.width || 1280, lens.height || 720);
    const f = (diag / 2) / Math.tan((lens.dfovDeg * DEG) / 2) * ratio;
    return { ratio: round(ratio, 4), pct: round((ratio - 1) * 100, 1), dfovDeg: round(fovFromFocal(f, diag), 1) };
  }

  const api = {
    feed(p, now) {
      if (frozen) return frozen;                              // a measurement, not a running average
      if (!p || !p.every(Number.isFinite)) return api.result(now);
      // A step bigger than the wobble threshold is the user walking, not holding: start the clock again.
      jumped = !!last && dist(p, last) > cfg.stepMm / 10;
      if (jumped) { win = []; t0 = null; }
      last = p.slice();
      if (t0 === null) t0 = now;
      win.push({ p: p.slice(), t: now });
      while (win.length > 1 && now - win[0].t > ms) win.shift();          // trailing window, not the lot
      while (win.length > 2 && Math.max(...spreadOf()) > cfg.spreadMm / 10) { win.shift(); t0 = win[0].t; }
      const r = api.result(now);
      if (r.done) frozen = { ...r, frozen: true };             // freeze it; the walk back must not move it
      return frozen || r;
    },
    result(now = 0) {
      if (frozen) return frozen;
      const n = win.length;
      if (!n) return { done: false, frozen: false, n: 0, elapsedMs: 0, message: 'Stand at the spot and hold still…' };
      const m = [0, 1, 2].map(k => mean(win.map(s => s.p[k])));
      const steady = [0, 1, 2].map(k => stddev(win.map(s => s.p[k])));
      const off = sub(m, expectedCm);
      const elapsed = t0 === null ? 0 : now - t0;
      const wobbleMm = steady.map(x => round(x * 10, 1));
      const still = !jumped && Math.max(...spreadOf()) <= cfg.spreadMm / 10;
      const done = elapsed >= ms && n >= 10 && still;
      const hint = done ? lensHint(m) : null;
      return {
        done, frozen: false, n, elapsedMs: round(elapsed, 0), meanCm: m.map(x => round(x, 2)),
        offsetCm: off.map(x => round(x, 2)), distanceCm: round(norm(off), 2), wobbleMm, lens: hint,
        message: done
          ? `The pair puts you ${round(norm(off), 1)} cm from the spot you named `
            + `(${off.map(x => (x >= 0 ? '+' : '') + round(x, 1)).join(', ')} cm), `
            + `holding to within ${round(Math.max(...steady) * 10, 0)} mm.`
            + (hint && Math.abs(hint.pct) >= 2
               ? `\nIt also puts you ${Math.abs(hint.pct)}% ${hint.pct > 0 ? 'further from' : 'nearer'} the `
                 + `pair than the spot you named, which is what a wrong lens fov looks like: try `
                 + `${hint.dfovDeg} deg in step 2 and solve again.` : '')
          : `Hold still… ${n} samples, ${round(elapsed / 100) / 10} s`
            + (still ? '' : ' — still moving'),
      };
    },
    reset() { win = []; t0 = null; last = null; frozen = null; jumped = false; },
  };
  return api;
}
