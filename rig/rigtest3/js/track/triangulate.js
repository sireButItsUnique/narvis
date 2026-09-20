// Triangulating one 3D point from the same landmark seen by two or more cameras.
//
// Two estimators are here on purpose. The DLT is the textbook homogeneous solve and is what a stereo pair
// reduces to; the weighted ray solve is better conditioned with three or more views and lets a confidence
// weight per view mean something. Both are then polished by a Gauss-Newton step that minimises actual
// reprojection error in pixels, which is the quantity we report.
//
// Every length is millimetres, every image error is pixels.

import { sub, dot, normalize, solveLinear, nullVector, jacobiEigenSym, mean } from './linalg.js';

// A "view" is { camera, u, v, weight? }. u,v are pixels in that camera's frame.

// Classic DLT: stack two rows per view from x*(P row 3) - (P row 1) = 0 and solve the homogeneous system.
// Distortion is removed first, so P is just [R|t] and the normalised coordinates carry the measurement.
export function triangulateDLT(views) {
  const rows = [];
  for (const view of views) {
    const [x, y] = view.camera.normalized(view.u, view.v);
    const P = view.camera.RT, w = Math.sqrt(view.weight ?? 1);
    rows.push(P[2].map((p, i) => w * (x * p - P[0][i])));
    rows.push(P[2].map((p, i) => w * (y * p - P[1][i])));
  }
  if (rows.length < 4) return null;
  const X = nullVector(rows);
  if (Math.abs(X[3]) < 1e-12) return null;             // point at infinity: parallel rays
  return [X[0] / X[3], X[1] / X[3], X[2] / X[3]];
}

// Weighted least squares over rays: minimise the sum of squared perpendicular distances to each ray.
// M = sum w (I - dd^T), b = sum w (I - dd^T) o, X = M^-1 b. For two views this is the midpoint method.
export function triangulateRays(views) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const view of views) {
    const { o, d } = view.camera.ray(view.u, view.v), w = view.weight ?? 1;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const a = w * ((i === j ? 1 : 0) - d[i] * d[j]);
        M[i][j] += a; b[i] += a * o[j];
      }
    }
  }
  const x = solveLinear(M, b);
  return x ? { point: x, M } : null;
}

// How well conditioned the ray geometry is: the eigenvalues of M say how much each direction is pinned
// down. A point on a line through both lens centres, or seen from nearly the same direction, is not.
export function rayConditioning(views) {
  const r = triangulateRays(views);
  if (!r) return { conditionNumber: Infinity, minEigen: 0 };
  const e = jacobiEigenSym(r.M);
  const hi = e.values[0], lo = e.values[2];
  return { conditionNumber: lo > 1e-12 ? hi / lo : Infinity, minEigen: lo };
}

// Largest angle between any pair of viewing rays, in degrees. Below a couple of degrees the depth
// component of the answer is noise, whatever the estimator says.
export function maxRayAngleDeg(views) {
  let best = 0;
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    const a = views[i].camera.ray(views[i].u, views[i].v).d, b = views[j].camera.ray(views[j].u, views[j].v).d;
    const c = Math.min(1, Math.max(-1, dot(a, b)));
    best = Math.max(best, Math.acos(c) * 180 / Math.PI);
  }
  return best;
}

export function reprojectionErrors(point, views) {
  return views.map(view => {
    const p = view.camera.project(point);
    return { id: view.camera.id, px: Math.hypot(p.u - view.u, p.v - view.v), inFront: p.inFront, depth: p.depth };
  });
}

// Gauss-Newton refinement of the 3D point against measured pixels. Numeric Jacobian: three extra
// projections per iteration is cheaper than being clever, and this runs on 42 landmarks per frame.
export function refinePoint(point, views, { iters = 5, step = 0.5 } = {}) {
  let X = point.slice();
  for (let it = 0; it < iters; it++) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    let any = false;
    for (const view of views) {
      const w = view.weight ?? 1, base = view.camera.project(X);
      if (!base.inFront) continue;
      any = true;
      const J = [[0, 0, 0], [0, 0, 0]];            // d(u,v) / d(X,Y,Z)
      for (let k = 0; k < 3; k++) {
        const Xp = X.slice(); Xp[k] += step;
        const p = view.camera.project(Xp);
        J[0][k] = (p.u - base.u) / step; J[1][k] = (p.v - base.v) / step;
      }
      const r = [view.u - base.u, view.v - base.v];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += w * (J[0][i] * J[0][j] + J[1][i] * J[1][j]);
        g[i] += w * (J[0][i] * r[0] + J[1][i] * r[1]);
      }
    }
    if (!any) break;
    for (let i = 0; i < 3; i++) A[i][i] *= 1.0001;   // a whisper of damping keeps the solve stable
    const d = solveLinear(A, g);
    if (!d) break;
    X = [X[0] + d[0], X[1] + d[1], X[2] + d[2]];
    if (Math.hypot(d[0], d[1], d[2]) < 1e-4) break;
  }
  return X;
}

/**
 * Triangulate with all the guards on.
 * Returns { ok, point, rmsPx, maxPx, errors, angleDeg, conditionNumber, degenerate, reason, used }.
 */
export function triangulate(views, opts = {}) {
  const { minAngleDeg = 1.5, maxConditionNumber = 5e3, refine = true } = opts;
  if (!views || views.length < 2) return { ok: false, reason: 'need 2 views', point: null, used: views ? views.length : 0 };

  const angleDeg = maxRayAngleDeg(views);
  const { conditionNumber } = rayConditioning(views);
  const degenerate = angleDeg < minAngleDeg || !(conditionNumber < maxConditionNumber);

  let point = triangulateDLT(views);
  const rayFit = triangulateRays(views);
  if (!point || !point.every(Number.isFinite)) point = rayFit ? rayFit.point : null;
  if (!point) return { ok: false, reason: 'singular', point: null, angleDeg, conditionNumber, degenerate: true, used: views.length };
  // With three or more views the weighted ray solve respects the confidences; the DLT does not.
  if (views.length > 2 && rayFit) point = rayFit.point;
  if (refine) point = refinePoint(point, views);

  const errors = reprojectionErrors(point, views);
  const behind = errors.some(e => !e.inFront);
  const rmsPx = Math.sqrt(mean(errors.map(e => e.px * e.px)));
  const maxPx = Math.max(...errors.map(e => e.px));
  return { ok: !behind && Number.isFinite(rmsPx) && !degenerate, point, rmsPx, maxPx, errors,
           angleDeg, conditionNumber, degenerate, behind,
           reason: behind ? 'behind a camera' : degenerate ? 'degenerate geometry' : null,
           used: views.length };
}

/**
 * Triangulate and throw out views that disagree, by consensus rather than by residual.
 *
 * Dropping whichever view has the biggest reprojection error is WRONG here and quietly loses the good
 * data: with a narrow stereo pair and a wide third view, the wide view owns the depth, so a gross error in
 * it pulls the fit along the pair's weak axis and the residual lands on the innocent pair. Instead every
 * pair of views proposes a point and the other views vote on it; the largest consistent set wins.
 *
 * Three views are enough, because a pair containing the bad view does not fit itself either: its two rays
 * miss each other and the least-squares point splits that miss between both of them, so the corrupted pair
 * scores no inliers at all while the clean pair scores two. If two disjoint hypotheses ever do tie, the
 * result says `ambiguous` rather than pretending to have chosen.
 */
export function triangulateRobust(views, opts = {}) {
  const { maxReprojPx = 4 } = opts;
  const all = triangulate(views, opts);
  if (!views || views.length < 3 || !all.point || !(all.maxPx > maxReprojPx))
    return { ...all, rejected: [], views, ambiguous: false };

  const weightOf = v => v.weight ?? 1 / Math.max(0.05, (v.camera.noisePx || 1) ** 2);
  const hyps = [];
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    const pair = triangulate([views[i], views[j]], { ...opts, refine: true });
    if (!pair.point || pair.degenerate) continue;
    const errs = reprojectionErrors(pair.point, views);
    const inliers = [];
    let sumPx = 0, weight = 0;
    errs.forEach((e, k) => { if (e.inFront && e.px <= maxReprojPx) { inliers.push(k); sumPx += e.px; weight += weightOf(views[k]); } });
    if (inliers.length >= 2) hyps.push({ inliers, sumPx, weight, key: inliers.join(',') });
  }
  if (!hyps.length) return { ...all, rejected: [], views, ambiguous: false };

  hyps.sort((a, b) => b.inliers.length - a.inliers.length || b.weight - a.weight || a.sumPx - b.sumPx);
  const best = hyps[0];
  const tie = hyps.find(h => h.key !== best.key && h.inliers.length === best.inliers.length &&
                             Math.abs(h.weight - best.weight) < 1e-9);
  const live = best.inliers.map(i => views[i]);
  const result = triangulate(live, opts);
  const rejected = views.filter((_, i) => !best.inliers.includes(i))
    .map((v, k) => ({ id: v.camera.id, px: reprojectionErrors(result.point || all.point, [v])[0].px }));
  return { ...result, rejected, views: live, ambiguous: !!tie,
           reason: tie ? 'two readings are equally consistent' : result.reason };
}

/**
 * Expected 3D error for a point, given each camera's pixel noise. Propagates noise through the same
 * normal equations the estimator uses (M^-1 scaled by the per-ray perpendicular sensitivity), which is
 * what the simulator's coverage map paints. Returns millimetres, or null when under-determined.
 */
export function expectedErrorMm(point, cameras) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let seen = 0;
  for (const camera of cameras) {
    const p = camera.project(point);
    if (!p.inFrame) continue;
    seen++;
    const d = normalize(sub(point, camera.position));
    // A one-pixel error moves the ray by (depth * radPerPx) perpendicular to it; weight = 1/sigma^2.
    const sigma = Math.max(1e-6, p.depth * camera.radPerPx * (camera.noisePx || 1));
    const w = 1 / (sigma * sigma);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += w * ((i === j ? 1 : 0) - d[i] * d[j]);
  }
  if (seen < 2) return { mm: null, views: seen };
  const e = jacobiEigenSym(M);
  // Each eigenvalue is 1/variance along that axis; total error is the root of the summed variances.
  const vars = e.values.map(v => (v > 1e-12 ? 1 / v : Infinity));
  const total = Math.sqrt(vars.reduce((a, b) => a + b, 0));
  return { mm: total, views: seen, worstAxisMm: Math.sqrt(Math.max(...vars)) };
}
