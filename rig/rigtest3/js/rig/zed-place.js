// SPDX-License-Identifier: GPL-3.0-or-later
// Where the ZED actually sits on this rig, and what that placement is worth.
//
// The camera is not mounted to anything: it stands on the BASE — the same board the acrylic stands on —
// centred left to right, at the front edge, looking up at the face. It is not literally on the ground, so
// the lens sits a few centimetres above the board (the ZED's own body and foot), and that offset is the
// difference between a head that solves and one that does not: every angle here is measured from the LENS.
//
// Rig frame is js/rig/geometry.js's: centimetres, origin at the centre of the acrylic sheet, +X to the
// viewer's right, +Y up, +Z toward the viewer. So the base is at y = -sheetHeightCm, and the lens at
// y = lensHeightCm - sheetHeightCm, which is NEGATIVE — the camera looks up from under the sheet's level.
//
// Everything is pure maths against input/stereo.js's own camera model, so `node --test` checks the numbers
// this page puts on screen without a ZED plugged in (test/zed-place.test.js).

import { defaultCalib, calibFor, parseZedConf, rotMatrix, matVec3, transpose3 } from '../input/stereo.js';

const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);

// The rig as built: a 6" acrylic sheet on the base, the ZED standing in front of it on the same board.
// zCm is the lens's distance forward of the sheet CENTRE, not of its edge — the sheet is 40 cm deep, so
// its front edge is at z = 20 and the camera sits just past it, clear of the acrylic.
export const DEFAULT_PLACEMENT = {
  sheetHeightCm: 15.2,     // acrylic above the base (6 inches, rigsim's default)
  lensHeightCm: 3.0,       // lens centre above the board the ZED stands on — its body, not a mount
  xCm: 0,                  // the CAMERA's centre line, which is what "centred" means when you set it down
  zCm: 22,                 // just in front of the sheet's front edge (sheet depth 40 -> edge at 20)
  tiltDeg: null,           // null: aim at the head range below. A number is a measured or propped tilt.
  yawDeg: 0,
  model: 'ZED 2',
  baselineCm: 12,          // ZED 2 / 2i; a Mini is 6.3
  width: 2560, height: 720,   // the side-by-side frame we open (HD720 per eye)
};

// Where a seated viewer's eye actually goes, as a range rather than a point: near and leaning in, far and
// sitting back, and the two ends of the head turning. Aiming at ONE of these is what tips the other out of
// frame, which is the whole reason aimTilt() takes a list.
export const HEAD_RANGE = [
  [0, 42, 44],     // geometry.js DEFAULT_EYE: leaning over the rig
  [0, 28, 71],     // rigsim's seated guess: sitting back
  [-18, 35, 58],   // leaning left
  [18, 35, 58],    // leaning right
];

export const merge = (p = {}) => ({ ...DEFAULT_PLACEMENT, ...p });

// The LEFT lens, in rig coordinates — the one everything downstream is written from, because
// viewsForCamera() puts the right eye a baseline along the camera's own +x from it.
//
// xCm is the camera's centre line, so the left lens is half a baseline to one side of it. Which side is
// not a choice: the 180 degree roll that makes a camera face the viewer sends the camera's +x along the
// rig's -X, so the eye at +baseline (the RIGHT one, in the factory's naming) lands on the viewer's left and
// the left lens sits at +baseline/2. Get this backwards and the whole reconstruction is 12 cm wide of true.
export function zedPosition(p = {}) {
  const q = merge(p);
  return [q.xCm + q.baselineCm / 2, q.lensHeightCm - q.sheetHeightCm, q.zCm];
}
// The midpoint between the two lenses: where the camera actually stands, and the origin the rig test's
// tracker frame is written about.
export function zedCentre(p = {}) {
  const q = merge(p), l = zedPosition(q);
  return [l[0] - q.baselineCm / 2, l[1], l[2]];
}

// The up-tilt that points the optical axis straight at one rig point.
export function tiltForPoint(p, pointRig) {
  const d = sub(pointRig, zedPosition(p));
  return Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG;
}

// The tilt that centres a whole set of points in the frame: halfway between the highest and lowest of
// them, which is the minimax answer for a pitch-only aim.
export function aimTilt(p, eyes = HEAD_RANGE) {
  const angles = eyes.map(e => tiltForPoint(p, e));
  return (Math.min(...angles) + Math.max(...angles)) / 2;
}

// The placement as input/cameras.js wants it: { posCm, rotDeg }.
// rotDeg is [pitch, yaw, 180]. The 180 about z is what every user-facing camera carries (stereo.js
// FACING_USER): the image is mirrored left-right and its y runs down, so the roll turns the camera frame
// into the rig frame. Pitch is applied FIRST (rotMatrix is Rz*Ry*Rx), about the camera's own x, and a
// POSITIVE pitch lifts the optical axis toward +Y — i.e. tilts the ZED up at the face.
export function zedExtrinsics(p = {}, eyes = HEAD_RANGE) {
  const q = merge(p);
  const tiltDeg = q.tiltDeg == null ? aimTilt(q, eyes) : q.tiltDeg;
  return { posCm: zedPosition(q), rotDeg: [tiltDeg, q.yawDeg || 0, 180], tiltDeg };
}

// The camera's own axes in the rig frame, for the diagram and for the checks: forward is where the lens
// looks, up is the top of the image.
export function zedAxes(ext) {
  const R = rotMatrix((ext.rotDeg || [0, 0, 0]).map(a => a * DEG));
  return { right: matVec3(R, [1, 0, 0]), down: matVec3(R, [0, 1, 0]), forward: matVec3(R, [0, 0, 1]) };
}

// A dropped SN<serial>.conf, checked before it is believed: a file that parses to nothing would silently
// leave the typical-ZED numbers in place while the page claimed to be calibrated.
export function parseConf(text) {
  let conf = null;
  try { conf = parseZedConf(text); } catch (e) { return { ok: false, why: `it would not parse (${e?.message || e})` }; }
  const cams = Object.keys(conf || {}).filter(k => /^LEFT_CAM_/.test(k));
  if (!cams.length) return { ok: false, why: 'no [LEFT_CAM_*] section in it' };
  const base = Number(conf.STEREO?.baseline ?? conf.STEREO?.baseline_mm ?? NaN);
  if (!(base > 10 && base < 300)) return { ok: false, why: 'no believable [STEREO] Baseline in it' };
  return { ok: true, conf, why: `baseline ${(base / 10).toFixed(1)} cm, ${cams.length} resolution${cams.length > 1 ? 's' : ''}` };
}

export const zedCalib = (p = {}, conf = null) => {
  const q = merge(p);
  return conf ? calibFor(conf, q.width, q.height, q.model) : defaultCalib(q.width, q.height, q.model);
};

// Rig point -> pixels in each eye. Brown-Conrady FORWARD (the distortion the lens adds), which is the
// inverse of what rayFromPixel undoes, so a point pushed through here and pulled back through the ray path
// lands where it started — that round trip is what test/zed-place.test.js checks.
function distort(x, y, k) {
  const r2 = x * x + y * y;
  const rad = 1 + (k.k1 || 0) * r2 + (k.k2 || 0) * r2 * r2 + (k.k3 || 0) * r2 * r2 * r2;
  return [x * rad + 2 * (k.p1 || 0) * x * y + (k.p2 || 0) * (r2 + 2 * x * x),
          y * rad + (k.p1 || 0) * (r2 + 2 * y * y) + 2 * (k.p2 || 0) * x * y];
}

function projectEye(pCam, k, eyeW, eyeH) {
  if (pCam[2] <= 1e-6) return { u: 0, v: 0, px: 0, py: 0, inFrame: false, behind: true, distCm: len(pCam) };
  const [x, y] = distort(pCam[0] / pCam[2], pCam[1] / pCam[2], k);
  const px = k.fx * x + k.cx, py = k.fy * y + k.cy;
  return { u: px / eyeW, v: py / eyeH, px, py, distCm: len(pCam), behind: false,
           inFrame: px >= 0 && px <= eyeW && py >= 0 && py <= eyeH,
           // how far inside the frame edge it is, in pixels: a head 20 px from the edge is one lean from gone
           marginPx: Math.min(px, eyeW - px, py, eyeH - py) };
}

// Where a rig point lands in both eyes of the ZED. Both or nothing: one eye is not a triangulation.
export function projectZed(ext, calib, pointRig) {
  const R = rotMatrix((ext.rotDeg || [0, 0, 0]).map(a => a * DEG));
  const camFromRig = transpose3(R);
  const rel = matVec3(camFromRig, sub(pointRig, ext.posCm || [0, 0, 0]));
  const right = [rel[0] - calib.baselineCm, rel[1], rel[2]];   // the right eye is +baseline along camera x
  const L = projectEye(rel, calib.left, calib.eyeW, calib.eyeH);
  const Rt = projectEye(right, calib.right, calib.eyeW, calib.eyeH);
  const fwd = rel[2] > 0 ? Math.acos(Math.max(-1, Math.min(1, rel[2] / (len(rel) || 1)))) / DEG : 180;
  return { left: L, right: Rt, both: L.inFrame && Rt.inFrame, distCm: len(rel), offAxisDeg: fwd, cam: rel };
}

// The ZED's own blind spot: it cannot fuse anything closer than about 30 cm (ZED 2, the near end of its
// depth range), and past ~150 cm a 12 cm baseline is guessing at the millimetres.
export const ZED_NEAR_CM = 30, ZED_FAR_CM = 150;

// Does the acrylic stand between the lens and the face? The sheet is the plane y = 0, a widthCm x depthCm
// rectangle centred on the origin. A camera BEHIND its front edge shoots the head through the acrylic,
// which is a 4-5% reflector and a refractor — the face still lands, but a few millimetres off, every frame.
export function sheetBlocks(ext, pointRig, sheet = { widthCm: 44, depthCm: 40 }) {
  const o = ext.posCm, d = sub(pointRig, o);
  if (Math.abs(d[1]) < 1e-9) return false;
  const t = -o[1] / d[1];                                    // where the sightline crosses y = 0
  if (t <= 0 || t >= 1) return false;
  const x = o[0] + d[0] * t, z = o[2] + d[2] * t;
  return Math.abs(x) <= sheet.widthCm / 2 && Math.abs(z) <= sheet.depthCm / 2;
}

// The whole verdict on a placement, in the words the page prints: the tilt to prop the camera at, and for
// every plausible head position whether the ZED sees it with both eyes, how far off its own axis it is,
// and how close to the frame edge it gets.
// `calib`, when given, beats both the factory file and the typical-ZED guess: it is what the bridge reads
// off the running camera (the SDK's rectified intrinsics), which is the camera actually doing the looking.
export function checkPlacement(p = {}, { eyes = HEAD_RANGE, conf = null, sheet, calib: given = null } = {}) {
  const q = merge(p);
  const ext = zedExtrinsics(q, eyes);
  const calib = given || zedCalib(q, conf);
  const warnings = [];
  const rows = eyes.map(eye => {
    const pr = projectZed(ext, calib, eye);
    const blocked = sheetBlocks(ext, eye, sheet || { widthCm: 44, depthCm: 40 });
    return { eye, both: pr.both, distCm: pr.distCm, offAxisDeg: pr.offAxisDeg, blocked,
             marginPx: Math.min(pr.left.marginPx ?? -1, pr.right.marginPx ?? -1),
             left: pr.left, right: pr.right };
  });
  const gone = rows.filter(r => !r.both);
  if (gone.length) warnings.push(`${gone.length} of ${rows.length} head positions fall out of one eye's frame`);
  const near = rows.filter(r => r.distCm < ZED_NEAR_CM);
  if (near.length) warnings.push(`the head comes within ${Math.min(...rows.map(r => r.distCm)).toFixed(0)} cm, inside the ZED's ${ZED_NEAR_CM} cm near limit`);
  const far = rows.filter(r => r.distCm > ZED_FAR_CM);
  if (far.length) warnings.push(`the head reaches ${Math.max(...rows.map(r => r.distCm)).toFixed(0)} cm, past the ${ZED_FAR_CM} cm this baseline measures well`);
  const blocked = rows.filter(r => r.blocked);
  if (blocked.length) {
    const sh = sheet || { widthCm: 44, depthCm: 40 };
    warnings.push(`the acrylic is between the lens and the face: the sheet reaches z = ${(sh.depthCm / 2).toFixed(0)} cm `
      + `and the lens is at ${ext.posCm[2].toFixed(0)} cm, so the sightline goes up through the glass. Move the ZED `
      + `forward of the sheet's front edge, or set the sheet's real size in step 3 if it is smaller than this.`);
  }
  return { placement: q, ext, calib, rows, warnings, ok: warnings.length === 0,
           tiltDeg: ext.tiltDeg, posCm: ext.posCm,
           worstMarginPx: Math.min(...rows.map(r => r.marginPx)) };
}

// How much a 1 px landmark error is worth in depth at this distance: the stereo error term, z^2 / (f * b).
// It is the number that decides whether this placement can hold a hologram still, because the image moves
// by roughly (float depth / eye distance) times whatever the eye does.
export function depthErrorCmPerPx(calib, distCm) {
  return (distCm * distCm) / (calib.left.fx * calib.baselineCm);
}

// One line for the readout, and the instruction the user actually follows.
export function describe(p = {}, eyes = HEAD_RANGE) {
  const q = merge(p), ext = zedExtrinsics(q, eyes);
  const [x, y, z] = ext.posCm;
  // toFixed on the lens height too: it is a sum of a block and a body, so it arrives as 5.3100000000000005.
  return `ZED on the base, centred: lens ${q.lensHeightCm.toFixed(1)} cm above the board = ${y.toFixed(1)} cm from the `
       + `sheet (x ${x.toFixed(1)}, z ${z.toFixed(1)}), tilted up ${ext.tiltDeg.toFixed(0)}°`;
}
