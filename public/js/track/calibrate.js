// Calibration: where the cameras are, what their lenses do, and how their answers land in the rig frame.
//
// Four routes, cheapest first:
//   1. intrinsicsFromFov       - a datasheet number. Good enough, because the fit downstream carries a
//                                scale term that absorbs a focal error.
//   2. parseZedConf            - the ZED's factory calibration, downloadable per serial from
//                                https://calib.stereolabs.com/?SN=<serial>. Exact intrinsics AND the
//                                stereo extrinsic for free, no board, no SDK.
//   3. relativePoseRansac      - two cameras with no shared calibration: essential matrix from a moving
//                                point (a waved fingertip), RANSAC, then a refinement. Scale is not
//                                observable this way, so the result is a unit baseline until route 4.
//   4. umeyamaFit              - the rig frame. The user touches known points (or the app shows a grid
//                                and each camera solves for itself) and we fit a similarity, which fixes
//                                the scale route 3 could not see.
// bundleAdjust polishes 2-4 together. Residuals come back in millimetres because that is the number the
// user can judge: "your fingertip and the model agree to N mm".

import { add, sub, scale as vscale, dot, normalize, dist, matMul, matVec, transpose,
         det3, svd3, nullVector, solveLinear, lmSolve, rodrigues, rodriguesInv, orthonormalize,
         mean, stddev, mulberry32 } from './linalg.js';
import { PinholeCamera, intrinsicsFromFov } from './camera.js';
import { triangulate } from './triangulate.js';

export { intrinsicsFromFov };

// ---------- 1. the ZED factory calibration file ----------

const ZED_RES = { '2K': { width: 2208, height: 1242, key: '2K' }, FHD: { width: 1920, height: 1080, key: 'FHD' },
                  HD: { width: 1280, height: 720, key: 'HD' }, VGA: { width: 672, height: 376, key: 'VGA' } };

/**
 * Parse an SN<serial>.conf. It is an INI file: [LEFT_CAM_HD] / [RIGHT_CAM_HD] sections with fx, fy, cx, cy
 * and k1..k3, p1, p2, plus a [STEREO] section with Baseline in MILLIMETRES and the small alignment
 * rotations RX_<res>, CV_<res> (convergence, i.e. yaw) and RZ_<res> in radians.
 */
export function parseZedConf(text) {
  const out = { raw: {}, resolutions: {} };
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const head = s.match(/^\[(.+)\]$/);
    if (head) { section = head[1].toUpperCase(); out.raw[section] = out.raw[section] || {}; continue; }
    const kv = s.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (kv && section) out.raw[section][kv[1].toLowerCase()] = parseFloat(kv[2]);
  }
  const stereo = out.raw.STEREO || {};
  for (const [name, res] of Object.entries(ZED_RES)) {
    const L = out.raw[`LEFT_CAM_${name}`], R = out.raw[`RIGHT_CAM_${name}`];
    if (!L || !R) continue;
    const suffix = name.toLowerCase();
    const pick = (base) => stereo[`${base.toLowerCase()}_${suffix}`] ?? stereo[base.toLowerCase()] ?? 0;
    out.resolutions[name] = {
      width: res.width, height: res.height,
      left: lensFrom(L), right: lensFrom(R),
      baselineMm: Math.abs(stereo.baseline ?? 120),
      rx: pick('RX'), ry: pick('CV'), rz: pick('RZ'),     // CV is the convergence (yaw) term
    };
  }
  out.serial = out.raw.STEREO?.serial_number ?? null;
  return out;
}
const lensFrom = s => ({ fx: s.fx, fy: s.fy, cx: s.cx, cy: s.cy,
                         dist: { k1: s.k1 || 0, k2: s.k2 || 0, k3: s.k3 || 0, p1: s.p1 || 0, p2: s.p2 || 0 } });

/**
 * Two PinholeCameras from a parsed .conf. The LEFT eye takes the pose you give; the right sits one
 * baseline along the left camera's +X with the small factory rotation applied. Pass the left pose from
 * whatever put the ZED in the rig frame (the screen-reflection PnP, or a touch fit).
 */
export function camerasFromZedConf(conf, resolution = 'HD', pose = {}, ids = ['zed-l', 'zed-r']) {
  const r = conf.resolutions ? conf.resolutions[resolution] : conf[resolution];
  if (!r) throw new Error(`no ${resolution} section in the ZED calibration`);
  const { position = [0, 0, 0], R = null, target = null, up = [0, 1, 0] } = pose;
  const left = new PinholeCamera({ id: ids[0], label: 'ZED left', role: 'hands', width: r.width, height: r.height,
                                   ...r.left, dist: r.left.dist, position, R, target, up, fps: 60 });
  // The right eye's own rotation, in the left camera's axes: RX about x, CV about y, RZ about z.
  const Rrel = matMul(rodrigues([0, 0, r.rz]), matMul(rodrigues([0, r.ry, 0]), rodrigues([r.rx, 0, 0])));
  const Rright = matMul(Rrel, left.R);
  const rightPos = add(left.position, vscale(left.right, r.baselineMm));
  const right = new PinholeCamera({ id: ids[1], label: 'ZED right', role: 'hands', width: r.width, height: r.height,
                                    ...r.right, dist: r.right.dist, position: rightPos, R: Rright, fps: 60 });
  return { left, right, baselineMm: r.baselineMm };
}

/** Where to fetch the factory file. No SDK, no login — just the serial off the camera's back label. */
export const zedCalibUrl = serial => `https://calib.stereolabs.com/?SN=${encodeURIComponent(serial)}`;

/** Split a side-by-side ZED frame: the halves are the left and right eye at full height. */
export const splitSbs = (width, height) => ({ left: { x: 0, y: 0, width: width / 2, height },
                                              right: { x: width / 2, y: 0, width: width / 2, height } });

// ---------- 2. relative pose from correspondences ----------

/** Hartley normalisation: centre the points and scale them to mean distance sqrt(2). Without it the
 *  8-point algorithm is dominated by rounding. Returns the transform as a 3x3 and the new points. */
function hartley(pts) {
  const cx = mean(pts.map(p => p[0])), cy = mean(pts.map(p => p[1]));
  const d = mean(pts.map(p => Math.hypot(p[0] - cx, p[1] - cy))) || 1;
  const s = Math.SQRT2 / d;
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
           pts: pts.map(p => [(p[0] - cx) * s, (p[1] - cy) * s]) };
}

/** Essential matrix from >= 8 NORMALISED correspondences (camera A -> camera B), by the 8-point algorithm. */
export function essentialFrom8Point(a, b) {
  if (a.length < 8) return null;
  const na = hartley(a), nb = hartley(b);
  const rows = na.pts.map((p, i) => {
    const q = nb.pts[i];
    return [q[0] * p[0], q[0] * p[1], q[0], q[1] * p[0], q[1] * p[1], q[1], p[0], p[1], 1];
  });
  const e = nullVector(rows);
  let E = [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]];
  E = matMul(transpose(nb.T), matMul(E, na.T));            // undo the normalisation
  // An essential matrix has two equal non-zero singular values and a zero third: project onto that set.
  const { U, S, V } = svd3(E);
  const s = (S[0] + S[1]) / 2;
  const D = [s, 0, 0, 0, s, 0, 0, 0, 0];
  return matMul(U, matMul(D, transpose(V)));
}

const flipThirdColumn = M => [M[0], M[1], -M[2], M[3], M[4], -M[5], M[6], M[7], -M[8]];

/** Sampson distance, the first-order approximation of the reprojection error for an epipolar constraint. */
export function sampsonError(E, p, q) {
  const Ep = matVec(E, [p[0], p[1], 1]), Etq = matVec(transpose(E), [q[0], q[1], 1]);
  const qEp = q[0] * Ep[0] + q[1] * Ep[1] + Ep[2];
  const d = Ep[0] * Ep[0] + Ep[1] * Ep[1] + Etq[0] * Etq[0] + Etq[1] * Etq[1];
  return d > 1e-15 ? (qEp * qEp) / d : Infinity;
}

/**
 * The four (R, t) candidates an essential matrix admits. t is a unit vector: scale is not observable.
 * The determinant fix has to be applied to U and V, NOT to the finished R. Negating R also gives a proper
 * rotation, which is why the mistake is easy to miss, but it is the one 180 degrees from the right answer
 * and it leaves t pointing the correct way, so it survives the cheirality test and quietly poisons the rig.
 */
export function decomposeEssential(E) {
  let { U, V } = svd3(E);
  // Flip only the THIRD column. An essential matrix has a zero third singular value, so that column plays
  // no part in E = U D V^T and can be signed freely — whereas negating the whole matrix (the version you
  // see in a lot of code) silently decomposes -E, and when only one of U and V gets flipped the candidate
  // set no longer contains the true pose at all. That bug is scale-dependent, so it hides in tests.
  if (det3(U) < 0) U = flipThirdColumn(U);
  if (det3(V) < 0) V = flipThirdColumn(V);
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const Ra = matMul(U, matMul(W, transpose(V)));
  const Rb = matMul(U, matMul(transpose(W), transpose(V)));
  const t = [U[2], U[5], U[8]];                            // third column of U
  return [{ R: Ra, t }, { R: Ra, t: vscale(t, -1) }, { R: Rb, t }, { R: Rb, t: vscale(t, -1) }];
}

/** Pick the candidate that puts the points in front of both cameras (the cheirality test). */
export function chooseByCheirality(candidates, a, b) {
  let best = null;
  for (const c of candidates) {
    let good = 0;
    for (let i = 0; i < a.length; i++) {
      const X = triangulateNormalized(c.R, c.t, a[i], b[i]);
      if (!X) continue;
      const Xb = add(matVec(c.R, X), c.t);
      if (X[2] > 0 && Xb[2] > 0) good++;
    }
    if (!best || good > best.good) best = { ...c, good };
  }
  return best;
}

/** Midpoint triangulation in camera-A coordinates for a normalised pair, with camera B at (R, t). */
export function triangulateNormalized(R, t, a, b) {
  const Rt = transpose(R);
  const da = normalize([a[0], a[1], 1]);
  const db = normalize(matVec(Rt, [b[0], b[1], 1]));
  const ob = matVec(Rt, [-t[0], -t[1], -t[2]]);            // camera B's centre in A's frame
  const w = ob;                                            // A's centre is the origin here
  const dda = dot(da, da), ddb = dot(db, db), dab = dot(da, db);
  const den = dda * ddb - dab * dab;
  if (Math.abs(den) < 1e-12) return null;                  // parallel rays: no intersection to find
  const sA = (ddb * dot(da, w) - dab * dot(db, w)) / den;  // the two perpendicularity conditions, solved
  const sB = (dab * dot(da, w) - dda * dot(db, w)) / den;
  const pA = vscale(da, sA), pB = add(ob, vscale(db, sB));
  return vscale(add(pA, pB), 0.5);
}

/** E = [t]x R for a relative pose. */
export const essentialFromPose = (R, t) =>
  matMul([0, -t[2], t[1], t[2], 0, -t[0], -t[1], t[0], 0], R);

/** Signed Sampson residual — the smooth, one-per-pair quantity the refinement minimises. */
export function sampsonResidual(E, p, q) {
  const Ep = matVec(E, [p[0], p[1], 1]), Etq = matVec(transpose(E), [q[0], q[1], 1]);
  const qEp = q[0] * Ep[0] + q[1] * Ep[1] + Ep[2];
  const d = Math.sqrt(Ep[0] * Ep[0] + Ep[1] * Ep[1] + Etq[0] * Etq[0] + Etq[1] * Etq[1]);
  return d > 1e-12 ? qEp / d : 0;
}

/**
 * Nonlinear refinement of a relative pose over the inliers. The 8-point answer is unbiased but noisy —
 * measured on synthetic data, 0.7 px of landmark noise comes out as about 1.7 px of Sampson error before
 * this step and about 0.6 px (the noise floor) after it, which is the difference between a usable
 * extrinsic and one that has to be thrown away.
 */
export function refineRelativePose(A, B, R0, t0, opts = {}) {
  const t0n = normalize(t0);
  const resid = p => {
    const E = essentialFromPose(rodrigues([p[0], p[1], p[2]]), normalize([p[3], p[4], p[5]]));
    return A.map((a, i) => sampsonResidual(E, a, B[i]));
  };
  const start = [...rodriguesInv(R0), ...t0n];
  const out = lmSolve(start, resid, { iterations: opts.iterations ?? 40, eps: 1e-7 });
  const p = out.params;
  return { R: orthonormalize(rodrigues([p[0], p[1], p[2]])), t: normalize([p[3], p[4], p[5]]), rms: out.rms };
}

/**
 * Relative pose between two cameras from a moving point seen by both (wave a fingertip through the volume).
 * @param pairs [{ a: {u,v}, b: {u,v} }] pixels
 * @returns { R, t (unit), inliers, inlierRatio, sampsonRmsPx } or null
 */
export function relativePoseRansac(camA, camB, pairs, opts = {}) {
  const { iterations = 400, thresholdPx = 3.0, seed = 12345, minInliers = 8, refine = true } = opts;
  const A = pairs.map(p => camA.normalized(p.a.u ?? p.a[0], p.a.v ?? p.a[1]));
  const B = pairs.map(p => camB.normalized(p.b.u ?? p.b[0], p.b.v ?? p.b[1]));
  if (A.length < 8) return null;
  // The Sampson error is in normalised units; convert the pixel threshold with the average focal length.
  const f = (camA.fx + camB.fx) / 2, thr = (thresholdPx / f) ** 2;
  const rng = mulberry32(seed);
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const idx = sampleIndices(A.length, 8, rng);
    const E = essentialFrom8Point(idx.map(i => A[i]), idx.map(i => B[i]));
    if (!E) continue;
    const inliers = [];
    for (let i = 0; i < A.length; i++) if (sampsonError(E, A[i], B[i]) < thr) inliers.push(i);
    if (!best || inliers.length > best.inliers.length) best = { E, inliers };
    if (best.inliers.length === A.length && it > 20) break;
  }
  if (!best || best.inliers.length < minInliers) return null;

  // Refit on every inlier, but never accept a refit that explains fewer points than the hypothesis did.
  const countInliers = E => { const keep = []; for (let i = 0; i < A.length; i++) if (sampsonError(E, A[i], B[i]) < thr) keep.push(i); return keep; };
  let E = essentialFrom8Point(best.inliers.map(i => A[i]), best.inliers.map(i => B[i])) || best.E;
  let inliers = countInliers(E);
  if (inliers.length < best.inliers.length) { E = best.E; inliers = countInliers(E); }
  if (inliers.length < minInliers) inliers = best.inliers;

  const pick = chooseByCheirality(decomposeEssential(E), inliers.map(i => A[i]), inliers.map(i => B[i]));
  if (!pick) return null;
  let R = pick.R, t = normalize(pick.t);
  if (refine) {
    const ref = refineRelativePose(inliers.map(i => A[i]), inliers.map(i => B[i]), R, t);
    // Refinement can walk to the sign-flipped twin; keep whichever still puts the points in front.
    const check = chooseByCheirality([{ R: ref.R, t: ref.t }, { R: ref.R, t: vscale(ref.t, -1) }],
                                     inliers.map(i => A[i]), inliers.map(i => B[i]));
    R = check.R; t = normalize(check.t);
    E = essentialFromPose(R, t);
    const grown = countInliers(E);
    if (grown.length >= inliers.length) inliers = grown;
  }
  const errs = inliers.map(i => Math.sqrt(sampsonError(E, A[i], B[i])) * f);
  return { E, R, t, inliers, inlierRatio: inliers.length / A.length,
           sampsonRmsPx: Math.sqrt(mean(errs.map(e => e * e))) };
}

function sampleIndices(n, k, rng) {
  const idx = new Set();
  let guard = 0;
  while (idx.size < k && guard++ < 1000) idx.add(Math.floor(rng() * n));
  return [...idx];
}

// ---------- 3. the rig frame ----------

/**
 * Umeyama similarity fit: the rotation, translation and uniform scale that best map src onto dst.
 * ALWAYS fit the scale. It is what absorbs a focal-length error, and it is the difference between a 4 mm
 * and a 0.8 mm residual when the assumed field of view is 3% off.
 */
export function umeyamaFit(src, dst, { withScale = true } = {}) {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  const mx = [0, 1, 2].map(k => mean(src.slice(0, n).map(p => p[k])));
  const my = [0, 1, 2].map(k => mean(dst.slice(0, n).map(p => p[k])));
  const H = new Array(9).fill(0);
  let varX = 0;
  for (let i = 0; i < n; i++) {
    const a = sub(src[i], mx), b = sub(dst[i], my);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r * 3 + c] += b[r] * a[c] / n;
    varX += dot(a, a) / n;
  }
  const { U, S, V } = svd3(H);
  const Sfix = det3(U) * det3(V) < 0 ? [1, 0, 0, 0, 1, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const R = matMul(U, matMul(Sfix, transpose(V)));
  const traceDS = S[0] * Sfix[0] + S[1] * Sfix[4] + S[2] * Sfix[8];
  const s = withScale && varX > 1e-12 ? traceDS / varX : 1;
  const t = sub(my, vscale(matVec(R, mx), s));
  const residuals = src.slice(0, n).map((p, i) => dist(add(vscale(matVec(R, p), s), t), dst[i]));
  return { R, t, scale: s, residualsMm: residuals,
           rmsMm: Math.sqrt(mean(residuals.map(r => r * r))), maxMm: Math.max(...residuals) };
}

export const applySimilarity = (tr, p) => add(vscale(matVec(tr.R, p), tr.scale ?? 1), tr.t);
export function invertSimilarity(tr) {
  const s = 1 / (tr.scale ?? 1), R = transpose(tr.R);
  return { R, scale: s, t: vscale(matVec(R, tr.t), -s) };
}

/** RANSAC around the similarity fit, because one badly touched point drags the whole frame. */
export function umeyamaRansac(src, dst, opts = {}) {
  const { iterations = 200, thresholdMm = 12, seed = 7, minInliers = 4 } = opts;
  if (src.length < 4) return umeyamaFit(src, dst);
  const rng = mulberry32(seed);
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const idx = sampleIndices(src.length, 3, rng);
    if (idx.length < 3) continue;
    const fit = umeyamaFit(idx.map(i => src[i]), idx.map(i => dst[i]));
    if (!fit) continue;
    const inliers = [];
    for (let i = 0; i < src.length; i++) if (dist(applySimilarity(fit, src[i]), dst[i]) < thresholdMm) inliers.push(i);
    if (!best || inliers.length > best.inliers.length) best = { inliers };
  }
  if (!best || best.inliers.length < minInliers) return umeyamaFit(src, dst);
  const fit = umeyamaFit(best.inliers.map(i => src[i]), best.inliers.map(i => dst[i]));
  return { ...fit, inliers: best.inliers, outliers: src.map((_, i) => i).filter(i => !best.inliers.includes(i)) };
}

/**
 * Is this set of touched points good enough to fit anything? Clustered points give a fit that reports a
 * small residual and is badly wrong away from the cluster, and cross-validation does NOT catch it —
 * a per-axis spread check does. Refuse below about 40 mm on the smallest axis.
 */
export function spreadCheck(points, minAxisMm = 40) {
  if (points.length < 4) return { ok: false, minAxisMm: 0, reason: 'need at least 4 points' };
  const sd = [0, 1, 2].map(k => stddev(points.map(p => p[k])));
  const worst = Math.min(...sd);
  return { ok: worst >= minAxisMm, perAxisMm: sd, minAxisMm: worst,
           reason: worst >= minAxisMm ? null
             : `the touched points only span ${worst.toFixed(0)} mm on one axis — spread them to the corners of the volume` };
}

// ---------- 4. bundle adjustment ----------

/**
 * Levenberg-Marquardt over camera poses (and optionally focal lengths) and 3D points, minimising
 * reprojection error. Deliberately small and dense: a rig has three or four cameras and a few dozen
 * points, so a dense normal-equation solve is milliseconds and there is no reason for a sparse solver.
 *
 * GAUGE: fixing ONE camera still leaves the scale free — the whole scene can shrink toward that camera
 * with no change in reprojection error, so the points come back a few percent out. Fix TWO cameras (for
 * us, the two ZED eyes, whose separation the factory file already gives) and the answer is metric.
 *
 * @param cameras      PinholeCamera[]; those listed in `fixed` keep their pose. Anchor two, see above.
 * @param points       [[x,y,z]] initial 3D estimates, in the same frame as the camera poses.
 * @param observations [{ cam: index, point: index, u, v }]
 * @returns { cameras, points, rmsPx, before, iterations }
 */
export function bundleAdjust({ cameras, points, observations, fixed = [0], iterations = 30,
                               refineFocal = false, lambda0 = 1e-3 } = {}) {
  const cams = cameras.map(c => c.clone());
  const free = cams.map((_, i) => !fixed.includes(i));
  const perCam = refineFocal ? 7 : 6;
  const camOffset = [];
  let n = 0;
  cams.forEach((_, i) => { camOffset[i] = free[i] ? n : -1; if (free[i]) n += perCam; });
  const ptOffset = points.map(() => { const o = n; n += 3; return o; });

  let X = points.map(p => p.slice());
  const params = new Array(n).fill(0);
  cams.forEach((c, i) => {
    if (!free[i]) return;
    const r = rodriguesInv(c.R), t = c.t, o = camOffset[i];
    params[o] = r[0]; params[o + 1] = r[1]; params[o + 2] = r[2];
    params[o + 3] = t[0]; params[o + 4] = t[1]; params[o + 5] = t[2];
    if (refineFocal) params[o + 6] = c.fx;
  });
  X.forEach((p, i) => { params[ptOffset[i]] = p[0]; params[ptOffset[i] + 1] = p[1]; params[ptOffset[i] + 2] = p[2]; });

  const apply = (ps) => {
    cams.forEach((c, i) => {
      if (!free[i]) return;
      const o = camOffset[i];
      c.setPoseFromRt(rodrigues([ps[o], ps[o + 1], ps[o + 2]]), [ps[o + 3], ps[o + 4], ps[o + 5]]);
      if (refineFocal) { c.fx = Math.max(10, ps[o + 6]); c.fy = c.fx; }
    });
    return points.map((_, i) => [ps[ptOffset[i]], ps[ptOffset[i] + 1], ps[ptOffset[i] + 2]]);
  };
  const residuals = (ps) => {
    const pts = apply(ps), r = new Array(observations.length * 2);
    observations.forEach((ob, k) => {
      const p = cams[ob.cam].project(pts[ob.point]);
      r[k * 2] = ob.u - p.u; r[k * 2 + 1] = ob.v - p.v;
    });
    return r;
  };
  const cost = r => r.reduce((a, b) => a + b * b, 0);

  let r = residuals(params), c0 = cost(r), lambda = lambda0;
  const before = Math.sqrt(c0 / Math.max(1, r.length));
  let it = 0;
  for (; it < iterations; it++) {
    // Numeric Jacobian, one column per parameter. Each observation only touches its camera and its point,
    // so only those columns are non-zero; we exploit that when accumulating the normal equations.
    const A = Array.from({ length: n }, () => new Array(n).fill(0)), g = new Array(n).fill(0);
    const eps = 1e-6;
    const J = observations.map(() => ({}));
    for (let p = 0; p < n; p++) {
      const ps = params.slice(); ps[p] += eps;
      const rp = residuals(ps);
      for (let k = 0; k < observations.length; k++) {
        const du = (rp[k * 2] - r[k * 2]) / eps, dv = (rp[k * 2 + 1] - r[k * 2 + 1]) / eps;
        if (du !== 0 || dv !== 0) J[k][p] = [du, dv];
      }
    }
    residuals(params);                                   // restore the cameras after the probing
    for (let k = 0; k < observations.length; k++) {
      const cols = Object.keys(J[k]).map(Number);
      for (const i of cols) {
        const [dui, dvi] = J[k][i];
        g[i] += -(dui * r[k * 2] + dvi * r[k * 2 + 1]);
        for (const j of cols) {
          const [duj, dvj] = J[k][j];
          A[i][j] += dui * duj + dvi * dvj;
        }
      }
    }
    let stepped = false;
    for (let tryIt = 0; tryIt < 8; tryIt++) {
      const Ad = A.map((row, i) => { const copy = row.slice(); copy[i] += lambda * (Math.abs(copy[i]) + 1e-9); return copy; });
      const d = solveLinear(Ad, g);            // g is already -J^T r, so this is the Gauss-Newton step
      if (!d) { lambda *= 10; continue; }
      const ps = params.map((v, i) => v + d[i]);
      const rn = residuals(ps), cn = cost(rn);
      if (cn < c0) { for (let i = 0; i < n; i++) params[i] = ps[i]; r = rn; c0 = cn; lambda = Math.max(1e-9, lambda / 3); stepped = true; break; }
      lambda *= 10;
    }
    if (!stepped) break;
    if (lambda > 1e9) break;
  }
  X = apply(params);
  const rmsPx = Math.sqrt(cost(residuals(params)) / Math.max(1, observations.length * 2));
  return { cameras: cams, points: X, rmsPx, before, iterations: it };
}

// ---------- the calibration record ----------

export const CALIB_KEY = 'holomodel-calibration';
export const CALIB_VERSION = 1;

/** Everything the app needs to reproduce a calibration, as plain JSON. */
export function makeCalibration({ cameras = [], rigTransform = null, bridgeTransform = null,
                                  ipdMm = null, rig = null, notes = '', report = null } = {}) {
  return { version: CALIB_VERSION, savedAt: new Date().toISOString(),
           cameras: cameras.map(c => (c.toJSON ? c.toJSON() : c)),
           rigTransform, bridgeTransform, ipdMm, rig, notes, report };
}

export function calibrationCameras(calib) { return (calib.cameras || []).map(PinholeCamera.fromJSON); }

/** localStorage, guarded: it throws in a private window and simply does not exist in Node. */
export function saveCalibration(calib, storage = globalThis.localStorage) {
  try { storage.setItem(CALIB_KEY, JSON.stringify(calib)); return true; } catch { return false; }
}
export function loadCalibration(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(CALIB_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && c.version === CALIB_VERSION ? c : null;
  } catch { return null; }
}
export function clearCalibration(storage = globalThis.localStorage) {
  try { storage.removeItem(CALIB_KEY); return true; } catch { return false; }
}
export const exportCalibration = calib => JSON.stringify(calib, null, 2);
export function importCalibration(json) {
  const c = typeof json === 'string' ? JSON.parse(json) : json;
  if (!c || typeof c !== 'object') throw new Error('not a calibration file');
  if (c.version !== CALIB_VERSION) throw new Error(`calibration version ${c.version}, expected ${CALIB_VERSION}`);
  if (!Array.isArray(c.cameras)) throw new Error('calibration has no cameras');
  return c;
}

/**
 * The numbers to put in front of the user. One headline figure in millimetres, and a warning whenever two
 * independent routes disagree — which is the failure that otherwise shows up as "the model is not quite
 * where my hand is" and gets blamed on the display.
 */
export function calibrationReport({ touchFit = null, spread = null, bundle = null, crossCheckMm = null,
                                    triangulationMm = null } = {}) {
  const warnings = [];
  const agreementMm = touchFit ? touchFit.rmsMm : triangulationMm;
  if (spread && !spread.ok) warnings.push(spread.reason);
  if (touchFit && touchFit.maxMm > 3 * Math.max(1, touchFit.rmsMm)) warnings.push(
    `one touched point is ${touchFit.maxMm.toFixed(0)} mm out — redo that one`);
  if (crossCheckMm != null && crossCheckMm > 8) warnings.push(
    `the touch fit and the screen fit disagree by ${crossCheckMm.toFixed(0)} mm — one of them is wrong`);
  if (bundle && bundle.rmsPx > 3) warnings.push(`reprojection is ${bundle.rmsPx.toFixed(1)} px; check the lens settings`);
  if (touchFit && Math.abs((touchFit.scale ?? 1) - 1) > 0.08) warnings.push(
    `the fit needed a ${(((touchFit.scale ?? 1) - 1) * 100).toFixed(0)}% scale change — the assumed field of view is off`);
  const grade = agreementMm == null ? 'unknown' : agreementMm < 8 ? 'good' : agreementMm < 15 ? 'fair' : 'poor';
  return { agreementMm, grade, warnings, reprojectionPx: bundle ? bundle.rmsPx : null,
           scale: touchFit ? touchFit.scale : null,
           headline: agreementMm == null ? 'not calibrated'
             : `finger-to-model agreement: ${agreementMm.toFixed(1)} mm (${grade})` };
}

/**
 * Triangulate a set of correspondences with the current cameras and fit the result to where the user was
 * actually told to touch. This is the whole of "put the sensors in the rig frame" once the cameras know
 * each other: correspondences in, a similarity and a millimetre residual out.
 */
export function fitRigFromTouches({ cameras, touches }) {
  const measured = [], expected = [];
  for (const t of touches) {
    const views = t.views.map(v => ({ camera: cameras.find(c => c.id === v.camId), u: v.u, v: v.v }))
      .filter(v => v.camera);
    if (views.length < 2) continue;
    const r = triangulate(views, { minAngleDeg: 1 });
    if (!r.point) continue;
    measured.push(r.point); expected.push(t.expected);
  }
  if (measured.length < 3) return { ok: false, reason: 'not enough usable touches' };
  const spread = spreadCheck(expected);
  const fit = umeyamaRansac(measured, expected);
  return { ok: !!fit, fit, spread, count: measured.length,
           report: calibrationReport({ touchFit: fit, spread }) };
}
