// Small dense linear algebra for the tracking maths. Plain arrays and no dependencies, so the same
// code runs in node --test and in the browser.
// Conventions: vec3 = [x, y, z]; mat3 = 9 numbers, ROW major; matrices bigger than 3x3 are arrays of rows.

// ---------- vec3 ----------
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function normalize(a) { const n = norm(a); return n < 1e-12 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n]; }
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------- mat3 (row major) ----------
export const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const matMul = (A, B) => {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
};
export const matVec = (A, p) => [
  A[0] * p[0] + A[1] * p[1] + A[2] * p[2],
  A[3] * p[0] + A[4] * p[1] + A[5] * p[2],
  A[6] * p[0] + A[7] * p[1] + A[8] * p[2]];
export const transpose = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
export const det3 = A => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
export function inverse3(A) {
  const d = det3(A);
  if (Math.abs(d) < 1e-20) return null;
  const i = 1 / d;
  return [
    (A[4] * A[8] - A[5] * A[7]) * i, (A[2] * A[7] - A[1] * A[8]) * i, (A[1] * A[5] - A[2] * A[4]) * i,
    (A[5] * A[6] - A[3] * A[8]) * i, (A[0] * A[8] - A[2] * A[6]) * i, (A[2] * A[3] - A[0] * A[5]) * i,
    (A[3] * A[7] - A[4] * A[6]) * i, (A[1] * A[6] - A[0] * A[7]) * i, (A[0] * A[4] - A[1] * A[3]) * i];
}

// Rodrigues: axis-angle vector (magnitude = radians) <-> rotation matrix. The 3-vector form is what the
// bundle adjuster optimises, because it has no constraints to maintain.
export function rodrigues(r) {
  const th = norm(r);
  if (th < 1e-9) return I3();
  const k = scale(r, 1 / th), c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  const [x, y, z] = k;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y,
          t * x * y + s * z, t * y * y + c, t * y * z - s * x,
          t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
export function rodriguesInv(R) {
  const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2)), th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {          // near 180 degrees: read the axis off R + I
    const d = [Math.sqrt(Math.max(0, (R[0] + 1) / 2)), Math.sqrt(Math.max(0, (R[4] + 1) / 2)), Math.sqrt(Math.max(0, (R[8] + 1) / 2))];
    const s = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
    for (let i = 0; i < 3; i++) if (s[i] < 0) d[i] = -d[i];
    return scale(normalize(d), th);
  }
  const s = Math.sin(th);
  return scale([R[7] - R[5], R[2] - R[6], R[3] - R[1]], th / (2 * s));
}

// Nearest rotation matrix (Gram-Schmidt): keeps a drifting matrix a rotation after numeric work.
export function orthonormalize(R) {
  let x = normalize([R[0], R[3], R[6]]);
  let y = normalize(sub([R[1], R[4], R[7]], scale(x, dot(x, [R[1], R[4], R[7]]))));
  const z = cross(x, y);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

// Rotation whose -Z... no: camera convention here is +Z forward (OpenCV), +X right, +Y down.
// Returns R mapping world vectors into camera axes (rows are the camera axes in world coordinates).
export function lookRotation(from, to, up = [0, 1, 0]) {
  const z = normalize(sub(to, from));                 // forward
  let x = cross(z, up);                               // right  (+Y down means x = z cross up)
  if (norm(x) < 1e-6) x = cross(z, [0, 0, 1]);
  x = normalize(x);
  const y = cross(z, x);                              // down
  return [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
}

// ---------- dense solvers ----------
// Gaussian elimination with partial pivoting. A is an array of rows (modified in place is avoided).
export function solveLinear(Ain, bin) {
  const n = bin.length, A = Ain.map(r => r.slice()), b = bin.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

// Cyclic Jacobi eigendecomposition of a symmetric matrix (array of rows).
// Returns values sorted descending and vectors as an array of rows, where column j is eigenvector j.
export function jacobiEigenSym(Ain, sweeps = 60) {
  const n = Ain.length, A = Ain.map(r => r.slice());
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
  return {
    values: order.map(i => A[i][i]),
    vectors: V.map(row => order.map(i => row[i])),
    column: j => V.map(row => row[order[j]]),
  };
}

// Smallest-singular-vector of A (array of m rows of n) via the eigenvector of A^T A with the smallest
// eigenvalue. Used for homogeneous systems: DLT triangulation and the 8-point essential matrix.
export function nullVector(A) {
  const n = A[0].length, ATA = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of A) for (let i = 0; i < n; i++) for (let j = i; j < n; j++) ATA[i][j] += row[i] * row[j];
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) ATA[i][j] = ATA[j][i];
  const e = jacobiEigenSym(ATA);
  return e.column(n - 1);
}

// SVD of a 3x3 (row major) via the eigendecomposition of A^T A. Returns U, S (3 descending values), V
// with A = U diag(S) V^T. Good enough for Umeyama and the essential matrix; not for ill-conditioned work.
export function svd3(A) {
  const At = transpose(A), ATA = matMul(At, A);
  const rows = [[ATA[0], ATA[1], ATA[2]], [ATA[3], ATA[4], ATA[5]], [ATA[6], ATA[7], ATA[8]]];
  const e = jacobiEigenSym(rows);
  const vcols = [e.column(0), e.column(1), e.column(2)];
  // Take each singular value as |A v| rather than sqrt of the eigenvalue: the eigenvalue of a rank-deficient
  // direction comes out as a tiny positive number whose square root is far larger than the true zero, and
  // dividing by THAT produces a garbage u column. The tolerance has to be relative to the largest value —
  // an absolute one silently changes behaviour when the same matrix is rescaled.
  const w = vcols.map(v => matVec(A, v));
  const S = w.map(norm);
  const tol = 1e-9 * Math.max(S[0], 1e-300);
  const ucols = w.map((wi, i) => (S[i] > tol ? scale(wi, 1 / S[i]) : null));
  for (let i = 0; i < 3; i++) if (S[i] <= tol) S[i] = 0;
  // Fill any degenerate U column so U stays a proper orthonormal basis.
  for (let i = 0; i < 3; i++) if (!ucols[i]) {
    const others = ucols.filter(Boolean);
    let cand = others.length === 2 ? cross(others[0], others[1]) : [1, 0, 0];
    for (const o of others) cand = sub(cand, scale(o, dot(o, cand)));
    ucols[i] = normalize(norm(cand) > 1e-9 ? cand : [0, 0, 1]);
  }
  const colsToMat = c => [c[0][0], c[1][0], c[2][0], c[0][1], c[1][1], c[2][1], c[0][2], c[1][2], c[2][2]];
  return { U: colsToMat(ucols), S, V: colsToMat(vcols) };
}

// ---------- statistics helpers used by the reports ----------
export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export function rms(xs) { return xs.length ? Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length) : 0; }
export function stddev(xs) { const m = mean(xs); return xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)); }

/**
 * Dense Levenberg-Marquardt for small problems (a handful of parameters), with a numeric Jacobian.
 * @param params0     starting parameter vector
 * @param residualFn  params -> array of residuals
 * @param eps         per-parameter probe step (number or array)
 * @returns { params, cost, rms, iterations }
 */
export function lmSolve(params0, residualFn, { iterations = 60, eps = 1e-6, lambda0 = 1e-3, tol = 1e-12 } = {}) {
  const n = params0.length, steps = Array.isArray(eps) ? eps : new Array(n).fill(eps);
  let p = params0.slice(), r = residualFn(p), cost = r.reduce((a, b) => a + b * b, 0), lambda = lambda0, it = 0;
  for (; it < iterations; it++) {
    const J = [];
    for (let k = 0; k < n; k++) {
      const pp = p.slice(); pp[k] += steps[k];
      const rp = residualFn(pp);
      J.push(rp.map((v, i) => (v - r[i]) / steps[k]));
    }
    const A = Array.from({ length: n }, () => new Array(n).fill(0)), g = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        for (let k = 0; k < r.length; k++) s += J[i][k] * J[j][k];
        A[i][j] = s; A[j][i] = s;
      }
      let s = 0;
      for (let k = 0; k < r.length; k++) s += J[i][k] * r[k];
      g[i] = -s;
    }
    let stepped = false;
    for (let t = 0; t < 10; t++) {
      const Ad = A.map((row, i) => { const c = row.slice(); c[i] += lambda * (Math.abs(c[i]) + 1e-12); return c; });
      const d = solveLinear(Ad, g);
      if (d) {
        const pn = p.map((v, i) => v + d[i]), rn = residualFn(pn), cn = rn.reduce((a, b) => a + b * b, 0);
        if (cn < cost) { p = pn; r = rn; const gain = cost - cn; cost = cn; lambda = Math.max(1e-12, lambda / 3); stepped = true;
                         if (gain < tol * Math.max(1, cost)) it = iterations; break; }
      }
      lambda *= 10;
      if (lambda > 1e12) break;
    }
    if (!stepped) break;
  }
  return { params: p, cost, rms: Math.sqrt(cost / Math.max(1, r.length)), iterations: it };
}

// Deterministic RNG so every simulated session and test is repeatable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller on top of a uniform RNG.
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
