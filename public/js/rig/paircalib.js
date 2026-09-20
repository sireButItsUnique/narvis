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

import { relativePoseRansac, triangulateNormalized, spreadCheck, bundleAdjust } from '../track/calibrate.js';
import { PinholeCamera, intrinsicsFromFov } from '../track/camera.js';
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
  const cfg = { ...CAPTURE, ...opts };
  const frames = [], bins = new Map();
  let lastAt = -Infinity;
  const skipped = { noFace: 0, short: 0, skew: 0, soon: 0, binFull: 0, full: 0 };

  const api = {
    cfg, frames,
    /** @param f { tA, tB, a, b } - capture timestamps in ms and the two face meshes, matched by index. */
    add(f) {
      const a = packLm(f.a), b = packLm(f.b);
      if (!a || !b) { skipped.noFace++; return { ok: false, why: 'no-face' }; }
      const n = Math.min(lmCount(a), lmCount(b));
      if (n < cfg.minLandmarks) { skipped.short++; return { ok: false, why: 'short-mesh' }; }
      if (Math.abs(f.tA - f.tB) > cfg.maxSkewMs) { skipped.skew++; return { ok: false, why: 'skew' }; }
      const t = (f.tA + f.tB) / 2;
      if (t - lastAt < cfg.minGapMs) { skipped.soon++; return { ok: false, why: 'too-soon' }; }
      if (frames.length >= cfg.maxFrames) { skipped.full++; return { ok: false, why: 'enough' }; }
      const bin = binOf(a, b, cfg);
      if (!bin) { skipped.noFace++; return { ok: false, why: 'no-face' }; }
      if ((bins.get(bin.key) || 0) >= cfg.perBin) { skipped.binFull++; return { ok: false, why: 'bin-full' }; }
      bins.set(bin.key, (bins.get(bin.key) || 0) + 1);
      lastAt = t;
      frames.push({ t, a, b, n, ...bin });
      return { ok: true, bin: bin.cell, frames: frames.length };
    },

    /** Live progress: how many usable views, how well spread, and what is still missing. */
    progress() {
      const counts = AXES.map(ax => [0, 0, 0]);
      for (const f of frames) AXES.forEach((ax, k) => { counts[k][f.cell[ax.i]]++; });
      const missing = [];
      AXES.forEach((ax, k) => {
        for (const band of [0, 2]) if (!counts[k][band]) missing.push(ax.miss[band]);
      });
      const filled = bins.size;
      const enough = frames.length >= cfg.minFrames && filled >= cfg.minBins && !missing.length;
      return {
        frames: frames.length, maxFrames: cfg.maxFrames, minFrames: cfg.minFrames,
        binsFilled: filled, binsTotal: 27, minBins: cfg.minBins,
        axes: Object.fromEntries(AXES.map((ax, k) => [ax.name, counts[k]])),
        missing, ready: enough, skipped: { ...skipped },
        // one number for a progress bar: the worst of "enough frames" and "enough of the volume"
        fraction: clamp(Math.min(frames.length / cfg.minFrames, filled / cfg.minBins), 0, 1),
      };
    },

    reset() { frames.length = 0; bins.clear(); lastAt = -Infinity; for (const k of Object.keys(skipped)) skipped[k] = 0; },
  };
  return api;
}

// A one-line description of where the capture stands, for the flag on the glass.
export function captureLines(p) {
  const out = [
    `${p.frames} of ${p.minFrames} usable views  ·  ${p.binsFilled} of ${p.minBins} parts of the volume`,
  ];
  if (p.missing.length) out.push('still missing: ' + p.missing.join(', '));
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
  minSpreadMm: 40,          // spreadCheck: below this the fit is good where you stood and wrong elsewhere
  minDepthCm: 20, maxDepthCm: 200,
  polish: false,            // bundleAdjust; see below - correct, but seconds rather than milliseconds
  polishPoints: 36,
};

/**
 * Solve the pair's relative pose from captured face frames and turn it into rig-frame extrinsics.
 *
 * @param frames      from makeCapture()
 * @param camA/camB   PinholeCameras for the LEFT and RIGHT webcam (lens only; the pose is the output)
 * @param baselineCm  the measured centre-to-centre distance. This is the ONLY source of scale.
 * @param typed       { toeInDeg, tiltUpDeg } the angles being replaced - the sanity check, and the one
 *                    degree of freedom (roll about the baseline) the faces cannot see.
 * @returns { ok, pose?, reasons?, report }
 */
export function solvePair({ frames, camA, camB, baselineCm, typed = { toeInDeg: 0, tiltUpDeg: 0 }, opts = {} }) {
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
  const report = { frames: (frames || []).length, pairs: use.length, landmarks: idx.length };
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
  let { R, t } = rp;
  report.inliers = rp.inliers.length;
  report.inlierRatio = round(rp.inlierRatio, 3);
  report.sampsonRmsPx = round(rp.sampsonRmsPx, 3);

  // ---- optional polish: reprojection instead of Sampson, cameras and points together. Camera A is held
  // and camera B is free, so the scale floats; it is put back from the baseline immediately below, which is
  // where it comes from anyway.
  if (cfg.polish) {
    const polished = polishWithBundle(camA, camB, use, rp, cfg);
    if (polished) { R = polished.R; t = polished.t; report.bundleRmsPx = round(polished.rmsPx, 3); }
  }

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
  const spread = spreadCheck(heads.map(h => scale(h, 10)), cfg.minSpreadMm);      // spreadCheck works in mm
  report.spread = { ok: spread.ok, perAxisMm: (spread.perAxisMm || []).map(n => round(n, 0)),
                    minAxisMm: round(spread.minAxisMm || 0, 0) };

  // The headline number in millimetres, which is the one a person can judge: the epipolar error in pixels,
  // carried out to the distance the head actually sits at.
  const f = (camA.fx + camB.fx) / 2;
  report.residualMm = round(medianDepthCm > 0 ? rp.sampsonRmsPx / f * medianDepthCm * 10 : 0, 2);

  // ---- angles, and whether they are believable
  const solvedToe = (right.rotDeg[1] - left.rotDeg[1]) / 2;
  const solvedTilt = (right.rotDeg[0] + left.rotDeg[0]) / 2;
  report.toeInDeg = round(solvedToe, 2);
  report.tiltUpDeg = round(solvedTilt, 2);
  report.dToeDeg = round(solvedToe - typed.toeInDeg, 2);
  report.dTiltDeg = round(solvedTilt - typed.tiltUpDeg, 2);
  report.asymmetryDeg = round(Math.abs(right.rotDeg[0] - left.rotDeg[0]), 2);

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
  if (!spread.ok)
    fail('spread', `You did not move far enough while capturing: the head positions only span `
      + `${report.spread.minAxisMm} mm on their narrowest axis, and ${cfg.minSpreadMm} mm is the minimum. `
      + 'A fit from one spot looks perfect there and is wrong everywhere else. Capture again and go to the '
      + 'corners of where you actually sit.');
  if (rp.inlierRatio < cfg.minInlierRatio)
    fail('inliers', `Only ${Math.round(rp.inlierRatio * 100)}% of the ${use.length} matched points fitted one `
      + `pose (${Math.round(cfg.minInlierRatio * 100)}% is the minimum). The two cameras were probably not `
      + 'looking at the same face at the same moment, or one of them was moved during the capture.');
  if (offDeg > cfg.maxBaselineOffDeg)
    fail('baseline', `The solve puts the line between the two cameras ${report.baselineOffDeg} degrees away `
      + `from running across the rig, and you measured them as level and symmetric. `
      + (report.baselineSwapped ? 'They look marked the wrong way round: swap left and right in step 1.'
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

// bundleAdjust over a handful of points: camera A fixed, camera B free, points free. It minimises the real
// reprojection error rather than Sampson's linearisation of it. Kept small and optional because it is a
// dense solve with 3 parameters per point.
function polishWithBundle(camA, camB, pairs, rp, cfg) {
  try {
    const inl = rp.inliers.slice(0, cfg.polishPoints);
    if (inl.length < 12) return null;
    const A = inl.map(i => camA.normalized(pairs[i].a.u, pairs[i].a.v));
    const B = inl.map(i => camB.normalized(pairs[i].b.u, pairs[i].b.v));
    const pts = A.map((a, k) => triangulateNormalized(rp.R, rp.t, a, B[k])).filter(p => p && p.every(Number.isFinite));
    if (pts.length < 12) return null;
    const ca = camA.clone({ id: 'a' }).setPoseFromRt(I3(), [0, 0, 0]);
    const cb = camB.clone({ id: 'b' }).setPoseFromRt(rp.R, rp.t);
    // The observations are the MEASURED landmarks, put back into pixels; projecting the current estimate
    // instead would hand the adjuster its own answer and it would report a perfect zero.
    const obs = [];
    pts.forEach((p, k) => {
      obs.push({ cam: 0, point: k, u: A[k][0] * ca.fx + ca.cx, v: A[k][1] * ca.fy + ca.cy });
      obs.push({ cam: 1, point: k, u: B[k][0] * cb.fx + cb.cx, v: B[k][1] * cb.fy + cb.cy });
    });
    const out = bundleAdjust({ cameras: [ca, cb], points: pts, observations: obs, fixed: [0], iterations: 12 });
    const R = out.cameras[1].R, t = normalize(out.cameras[1].t);
    if (!R.every(Number.isFinite) || !t.every(Number.isFinite)) return null;
    return { R: orthonormalize(R), t, rmsPx: out.rmsPx };
  } catch { return null; }
}

// ---------------------------------------------------------------- what the page shows

/** The solve, in the sentences a person at the rig can act on. */
export function solveLines(res) {
  const r = res.report || {};
  const head = res.ok ? 'MEASURED — the pair now uses the solved pose' : 'REFUSED — the typed angles are kept';
  const lines = [head, ''];
  lines.push(`views ${r.frames}  ·  matched points ${r.pairs}`
    + (r.inliers != null ? `  ·  inliers ${r.inliers} (${Math.round((r.inlierRatio || 0) * 100)}%)` : ''));
  if (r.residualMm != null) lines.push(`residual ${r.residualMm} mm at ${r.medianDepthCm} cm  ·  ${r.sampsonRmsPx} px`);
  if (r.spread) lines.push(`spread ${r.spread.perAxisMm.join(' / ')} mm (x / y / z), narrowest ${r.spread.minAxisMm} mm`);
  // The angles are only meaningful once the baseline has been anchored, so when THAT is what failed they
  // are not reported as if they were an answer - they would be the aim of a pair that does not exist.
  const anchored = !(res.reasons || []).some(x => x.code === 'baseline');
  if (r.toeInDeg != null && anchored)
    lines.push(`toe-in ${r.toeInDeg} deg (was ${round(r.toeInDeg - r.dToeDeg, 1)})  ·  tilt ${r.tiltUpDeg} deg`
      + `  ·  the two cameras differ by ${r.asymmetryDeg} deg in tilt`);
  else if (r.toeInDeg != null)
    lines.push('angles: not reported — they are only meaningful once the baseline is anchored, and it is not');
  if (r.baselineOffDeg != null) lines.push(`baseline ${r.baselineOffDeg} deg off the line you measured`);
  if (r.scaleFrom) lines.push(`scale: ${r.scaleFrom} — the faces alone cannot set it`);
  if (res.ok) lines.push('the common tilt up is NOT measured (rolling the whole pair is invisible to a face);'
    + ' it is kept from the angles it replaced');
  for (const x of (res.reasons || [])) lines.push('', `${x.code.toUpperCase()}: ${x.text}`);
  return lines;
}

// ---------------------------------------------------------------- hold still where you say you are

// The check that needs no faith in the hardware: stand at a spot you can point at, hold still, and the page
// says how far the solved pair puts you from it. A calibration that cannot survive this is not calibrated.
export function makeHoldCheck({ expectedCm, ms = 2000 } = {}) {
  const samples = [];
  let t0 = null;
  return {
    feed(p, now) {
      if (!p || !p.every(Number.isFinite)) return this.result(now);
      if (t0 === null) t0 = now;
      samples.push(p.slice());
      return this.result(now);
    },
    result(now = 0) {
      const n = samples.length;
      if (!n) return { done: false, n: 0, elapsedMs: 0, message: 'Stand at the spot and hold still…' };
      const m = [0, 1, 2].map(k => mean(samples.map(s => s[k])));
      const steady = [0, 1, 2].map(k => stddev(samples.map(s => s[k])));
      const off = sub(m, expectedCm);
      const elapsed = t0 === null ? 0 : now - t0;
      const done = elapsed >= ms && n >= 10;
      return {
        done, n, elapsedMs: round(elapsed, 0), meanCm: m.map(x => round(x, 2)),
        offsetCm: off.map(x => round(x, 2)), distanceCm: round(norm(off), 2),
        wobbleMm: steady.map(x => round(x * 10, 1)),
        message: done
          ? `The pair puts you ${round(norm(off), 1)} cm from the spot you named `
            + `(${off.map(x => (x >= 0 ? '+' : '') + round(x, 1)).join(', ')} cm), `
            + `holding to within ${round(Math.max(...steady) * 10, 0)} mm.`
          : `Hold still… ${n} samples, ${round(elapsed / 100) / 10} s`,
      };
    },
    reset() { samples.length = 0; t0 = null; },
  };
}
