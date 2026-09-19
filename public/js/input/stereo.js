// Stereo geometry for the no-SDK ZED path: split the side-by-side frame, turn landmarks into rays, and
// triangulate. Everything here is pure maths (no DOM, no WebGL) so node --test can check it against
// synthetic points, which is the only way to check it until the camera is on the desk.
// Lengths are cm (the app's world unit); ZED calibration files are mm and are converted on parse.

import { ZED_MODES, zedModeFor } from './devices.js';

// ---------- frame layout ----------

// Where each eye lives inside one side-by-side frame. createImageBitmap() can crop with exactly this rect.
export function splitLayout(width, height) {
  const mode = zedModeFor(width, height);
  const half = Math.floor(width / 2);
  return {
    sbs: true, mode: mode?.name || null, eyeW: half, eyeH: height,
    left: { sx: 0, sy: 0, sw: half, sh: height },
    right: { sx: half, sy: 0, sw: width - half, sh: height },
  };
}

// A single (non-stereo) camera described the same way, so the pipeline has one shape for both.
export function wholeLayout(width, height) {
  return { sbs: false, mode: null, eyeW: width, eyeH: height,
           left: { sx: 0, sy: 0, sw: width, sh: height }, right: null };
}

// ---------- ZED factory calibration (SN<serial>.conf from https://calib.stereolabs.com/?SN=...) ----------

// The .conf is an INI file: [LEFT_CAM_HD] fx=... plus a [STEREO] section with Baseline and the small
// rotations. Parsing it ourselves means no SDK and no CUDA anywhere in this path.
export function parseZedConf(text) {
  const out = {};
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toUpperCase(); out[section] = out[section] || {}; continue; }
    const kv = line.match(/^([\w.]+)\s*=\s*(.+)$/);
    if (kv && section) {
      const v = Number(kv[2].trim());
      out[section][kv[1].trim().toLowerCase()] = Number.isFinite(v) ? v : kv[2].trim();
    }
  }
  return out;
}

const intr = (s, fallback) => ({
  fx: s?.fx ?? fallback.fx, fy: s?.fy ?? fallback.fy, cx: s?.cx ?? fallback.cx, cy: s?.cy ?? fallback.cy,
  k1: s?.k1 ?? 0, k2: s?.k2 ?? 0, k3: s?.k3 ?? 0, p1: s?.p1 ?? 0, p2: s?.p2 ?? 0,
});

// No .conf yet? A ZED's published fov gets us close enough to grab something; the calibration file only
// refines it. 110 deg horizontal is the ZED/ZED 2i wide setting, 90 deg is a safe middle for unknown units.
export function defaultCalib(width, height, hfovDeg = 102) {
  const L = splitLayout(width, height);
  const fx = (L.eyeW / 2) / Math.tan(hfovDeg * Math.PI / 360);
  const base = { fx, fy: fx, cx: L.eyeW / 2, cy: L.eyeH / 2 };
  return { left: intr(null, base), right: intr(null, base), baselineCm: 12, rot: [0, 0, 0], eyeW: L.eyeW, eyeH: L.eyeH, source: 'fov guess' };
}

// conf + the resolution we opened -> the numbers the triangulator needs, in cm.
export function calibFor(conf, width, height) {
  const mode = zedModeFor(width, height) || ZED_MODES.find(m => m.width === width) || null;
  const d = defaultCalib(width, height);
  if (!conf || !mode) return d;
  const suffix = mode.name;
  const L = conf[`LEFT_CAM_${suffix}`], R = conf[`RIGHT_CAM_${suffix}`], S = conf.STEREO || {};
  const baseMm = Number(S.baseline ?? S.baseline_mm ?? 120);
  const rot = [Number(S[`rx_${suffix.toLowerCase()}`] ?? S.rx ?? 0),
               Number(S[`cv_${suffix.toLowerCase()}`] ?? S.cv ?? 0),     // CV is the convergence (Y) rotation
               Number(S[`rz_${suffix.toLowerCase()}`] ?? S.rz ?? 0)];
  return {
    left: intr(L, d.left), right: intr(R, d.right),
    baselineCm: baseMm / 10, rot, eyeW: d.eyeW, eyeH: d.eyeH,
    source: L ? `SN.conf ${suffix}` : 'fov guess',
  };
}

// ---------- pixels -> rays ----------

// Brown-Conrady inverse by fixed point iteration: distorted normalised -> ideal normalised.
export function undistort(xd, yd, k) {
  let x = xd, y = yd;
  for (let i = 0; i < 8; i++) {
    const r2 = x * x + y * y;
    const rad = 1 + k.k1 * r2 + k.k2 * r2 * r2 + k.k3 * r2 * r2 * r2;
    const dx = 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x);
    const dy = k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y;
    x = (xd - dx) / rad; y = (yd - dy) / rad;
  }
  return [x, y];
}

const norm = v => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

// Pixel in one eye's own image -> unit direction in that camera's frame (OpenCV: x right, y down, z forward).
export function rayFromPixel(px, py, k) {
  const [x, y] = undistort((px - k.cx) / k.fx, (py - k.cy) / k.fy, k);
  return norm([x, y, 1]);
}

// Rz * Ry * Rx as a flat row-major 3x3. One function so the ray path and the PinholeCamera path
// (input/solver.js) cannot end up with different ideas of where a camera is pointing.
export function rotMatrix([rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
          sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
          -sy, cy * sx, cy * cx];
}

export function matMul3(a, b) {
  const m = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    m[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return m;
}

export const transpose3 = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export const matVec3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
                                  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
                                  m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

// Small-angle rotation of the right eye into the left eye's frame (rx, ry=CV, rz, radians).
export function rotateVec(v, rot) { return matVec3(rotMatrix(rot), v); }

// The two views of one landmark, as rays in the LEFT camera's frame (the reference frame of a ZED).
export function stereoViews(uvLeft, uvRight, calib, weightL = 1, weightR = 1) {
  const pxL = [uvLeft[0] * calib.eyeW, uvLeft[1] * calib.eyeH];
  const pxR = [uvRight[0] * calib.eyeW, uvRight[1] * calib.eyeH];
  return [
    { origin: [0, 0, 0], dir: rayFromPixel(pxL[0], pxL[1], calib.left), weight: weightL },
    { origin: [calib.baselineCm, 0, 0], dir: rotateVec(rayFromPixel(pxR[0], pxR[1], calib.right), calib.rot), weight: weightR },
  ];
}

// ---------- triangulation (local fallback; the real solver is imported below when it exists) ----------

// N-view weighted midpoint: minimise sum w |(I - dd^T)(p - o)|^2, a 3x3 normal-equation solve.
export function triangulateLocal(views) {
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
  for (const v of views) {
    const d = norm(v.dir), o = v.origin || [0, 0, 0], w = v.weight ?? 1;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const m = w * ((i === j ? 1 : 0) - d[i] * d[j]);
      A[i * 3 + j] += m; b[i] += m * o[j];
    }
  }
  return solve3(A, b);
}

// Gaussian elimination with partial pivoting; returns null when the rays are parallel (no intersection).
export function solve3(A, b) {
  const m = [[A[0], A[1], A[2], b[0]], [A[3], A[4], A[5], b[1]], [A[6], A[7], A[8], b[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// How far the rays miss each other: the honest per-point error bar, in cm.
export function residualCm(point, views) {
  if (!point) return Infinity;
  let worst = 0;
  for (const v of views) {
    const d = norm(v.dir), o = v.origin || [0, 0, 0];
    const p = [point[0] - o[0], point[1] - o[1], point[2] - o[2]];
    const t = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    worst = Math.max(worst, Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]));
  }
  return worst;
}

// ---------- adapter onto ../track/triangulate.js ----------
//
// This is the RAY-level seam. The real pipeline (input/solver.js -> track/solve.js Tracker) works from
// posed PinholeCameras and pixels and never comes through here; what is left needing a ray API is the
// no-Tracker fallback and the setup page's per-view arithmetic. Rather than keep a second implementation
// of the same normal equations, wrap each ray in the smallest thing triangulateRays() actually asks of a
// camera — a .ray() — so both paths run the SAME estimator. The local midpoint stays as the answer when
// track/ is absent, and the known-answer check still gates whatever is adopted.

let solverFn = null, solverName = 'local midpoint', tried = false;

export function setSolver(fn, name = 'injected') { solverFn = fn; solverName = name; tried = true; }
export function solverInfo() { return { name: solverName, external: solverFn !== null }; }

const CHECK = [ // two rays that meet at (3, 0, 30) cm
  { origin: [0, 0, 0], dir: norm([3, 0, 30]) },
  { origin: [12, 0, 0], dir: norm([-9, 0, 30]) },
];

// A ray dressed as the camera triangulateRays() wants. It only ever calls camera.ray(u, v), so this is the
// whole contract; anything that needs project() or RT belongs on the PinholeCamera path instead.
const rayCamera = v => {
  const o = v.origin || [0, 0, 0], d = norm(v.dir);
  return { id: v.label || 'ray', noisePx: 1, ray: () => ({ o, d }) };
};
const asViews = views => views.map(v => ({ camera: rayCamera(v), u: 0, v: 0, weight: v.weight ?? 1 }));

export async function loadSolver(importer = () => import('../track/triangulate.js')) {
  if (tried) return solverInfo();
  tried = true;
  try {
    const mod = await importer();
    const fn = mod?.triangulateRays;
    if (typeof fn === 'function') {
      const p = toXyz(fn(asViews(CHECK)));
      // Never adopt a solver on the strength of its name: it has to get a known answer right first.
      if (p && Math.hypot(p[0] - 3, p[1], p[2] - 30) < 0.05) {
        solverFn = v => toXyz(fn(asViews(v)));
        solverName = 'track/triangulate.js triangulateRays';
      }
    }
  } catch { /* track/ missing: the local midpoint is a correct, if plainer, answer */ }
  return solverInfo();
}

// The solver may hand back an array, a {x,y,z}, or a {point, residual}; normalise to [x,y,z].
function toXyz(r) {
  if (!r) return null;
  if (Array.isArray(r)) return r.length >= 3 ? [r[0], r[1], r[2]] : null;
  if (typeof r.x === 'number') return [r.x, r.y, r.z];
  if (r.point) return toXyz(r.point);
  return null;
}

export function triangulate(views) {
  if (solverFn) { try { const p = solverFn(views); if (p) return p; } catch { /* fall through to local */ } }
  return triangulateLocal(views);
}

// ---------- camera frame -> world ----------

// World is the app's frame: origin at the centre of the display, x right, y up, z out of the screen toward
// you, cm. A camera frame is OpenCV: x right in the image, y down, z out of the lens. A camera looking at
// the user is therefore turned 180 deg about z from the world (the viewer's right hand lands on the image's
// left, and image y runs downward) — the same mapping webcam.js does inline today. Rig tilt goes in rotDeg.
export const FACING_USER = { posCm: [0, 0, 0], rotDeg: [0, 0, 180] };

export function camToWorld(p, ext = FACING_USER) {
  const r = (ext.rotDeg || [0, 0, 0]).map(a => a * Math.PI / 180);
  const v = rotateVec(p, r);
  const t = ext.posCm || [0, 0, 0];
  return [v[0] + t[0], v[1] + t[1], v[2] + t[2]];
}

// A direction has no position, so only the rotation applies.
export function camDirToWorld(d, ext = FACING_USER) {
  return rotateVec(d, (ext.rotDeg || [0, 0, 0]).map(a => a * Math.PI / 180));
}

// Where one eye sits and which way it looks, in the app's world frame (cm).
//
//   R_camToWorld = R(ext.rotDeg) * R(extraRot)
//
// and a calibration file's convention is the other way round, so `R` here is WORLD -> CAMERA, which is what
// track/camera.js PinholeCamera wants. Deriving it from the same ext/offsetCam/extraRot the ray path uses
// is the point: one description of the rig, two consumers.
export function cameraPose({ ext = FACING_USER, offsetCam = [0, 0, 0], extraRot = [0, 0, 0] } = {}) {
  const Rext = rotMatrix((ext.rotDeg || [0, 0, 0]).map(a => a * Math.PI / 180));
  const R = matMul3(Rext, rotMatrix(extraRot));
  return { positionCm: camToWorld(offsetCam, ext), R: transpose3(R), RCamToWorld: R };
}

// One camera (or one eye of a ZED) as the triangulator sees it: normalised image point -> a world-space ray.
// offsetCam/extraRot place this eye inside its camera rig (the right eye of a ZED sits one baseline over).
export function makeView({ intr, eyeW, eyeH, ext = FACING_USER, offsetCam = [0, 0, 0], extraRot = [0, 0, 0], label = '' }) {
  const origin = camToWorld(offsetCam, ext);
  const pose = cameraPose({ ext, offsetCam, extraRot });
  return {
    label, intr, eyeW, eyeH, ext, origin, pose, offsetCam, extraRot,
    // normalised image point -> world ray
    ray(u, v, weight = 1) {
      const d = rayFromPixel(u * eyeW, v * eyeH, intr);
      return { origin, dir: camDirToWorld(rotateVec(d, extraRot), ext), weight };
    },
    // normalised image point + a depth along this camera's optical axis -> world point (the one-view guess)
    point(u, v, depthCm) {
      const [x, y] = undistort((u * eyeW - intr.cx) / intr.fx, (v * eyeH - intr.cy) / intr.fy, intr);
      const p = rotateVec([x * depthCm, y * depthCm, depthCm], extraRot);
      return camToWorld([p[0] + offsetCam[0], p[1] + offsetCam[1], p[2] + offsetCam[2]], ext);
    },
  };
}

// The one or two views a camera contributes: a ZED's side-by-side frame is two views of the same instant.
export function viewsForCamera({ width, height, sbs, calib, intr, ext, label }) {
  if (sbs) {
    const c = calib || defaultCalib(width, height);
    return [
      makeView({ intr: c.left, eyeW: c.eyeW, eyeH: c.eyeH, ext, label: `${label} L` }),
      makeView({ intr: c.right, eyeW: c.eyeW, eyeH: c.eyeH, ext, offsetCam: [c.baselineCm, 0, 0], extraRot: c.rot, label: `${label} R` }),
    ];
  }
  return [makeView({ intr, eyeW: width, eyeH: height, ext, label })];
}
