// SPDX-License-Identifier: GPL-3.0-or-later
// Geometry for the Pepper's-ghost rig: a monitor mounted above, tilted and facing down, a flat acrylic
// sheet under it acting as a beam splitter, and the viewer looking down through the sheet at the monitor's
// mirror image floating underneath, with their hands in it.
//
// Rig frame: centimetres, origin at the centre of the acrylic sheet, +X to the viewer's right, +Y up,
// +Z toward the viewer. The sheet may be any plane (default: horizontal through the origin).
//
// The maths is plane reflection plus the generalized off-axis perspective projection of
// R. Kooima, "Generalized Perspective Projection" (2008): build a camera basis from the screen corners and
// an asymmetric frustum from the eye. The screen here is the VIRTUAL screen (the monitor reflected in the
// sheet), because that is where the light appears to come from. One reflection is orientation-reversing,
// so the rendered image must be mirrored before it goes on the monitor; two reflections (fold mirror) are not.
//
// No three.js import: plain [x, y, z] arrays and column-major 16-element matrices (THREE.Matrix4 order),
// so `node --test` can run all of it and the browser side can feed it straight into a THREE camera.

export const DEG = Math.PI / 180;

// ---------- vectors ----------
// Inputs may be [x,y,z], {x,y,z} (THREE.Vector3) — outputs are always arrays.
export const v3 = (p) => Array.isArray(p) || ArrayBuffer.isView(p) ? [+p[0], +p[1], +p[2]] : [+p.x, +p.y, +p.z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => len(sub(a, b));
export const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// distance from point p to the infinite line through a with direction d (used by the parity tests)
export const lineDist = (p, a, d) => len(cross(sub(p, a), unit(d)));

// ---------- planes ----------
export const plane = (pt, n) => ({ point: v3(pt), normal: unit(v3(n)) });
export const planeOf = (o) => plane(o.point ?? [0, 0, 0], o.normal ?? [0, 1, 0]);
export const signedDist = (pl, p) => dot(sub(v3(p), pl.point), pl.normal);
export const reflectPoint = (pl, p) => { const q = v3(p); return sub(q, scale(pl.normal, 2 * signedDist(pl, q))); };
export const reflectVector = (pl, v) => { const w = v3(v); return sub(w, scale(pl.normal, 2 * dot(w, pl.normal))); };
// Ray/plane hit. Returns t along d (may be negative) or null when parallel.
export function rayPlane(origin, d, pl) {
  const den = dot(d, pl.normal);
  if (Math.abs(den) < 1e-12) return null;
  return dot(sub(pl.point, origin), pl.normal) / den;
}
// Two in-plane axes for a plane, for extents and diagrams. For a horizontal sheet: u = +X, v = +Z.
export function planeAxes(pl) {
  const n = pl.normal;
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(n, ref));
  return { u, v: unit(cross(u, n)) };
}

// ---------- rectangles (monitor, virtual screen, sheet) ----------
// Corners are named after PIXELS, not the room: tl is the corner of pixel (0,0), tr of (W,0),
// br of (W,H), bl of (0,H). That way a monitor mounted upside down or rotated needs no special case.
export function rectFrom(centre, right, up, widthCm, heightCm) {
  const c = v3(centre), r = unit(v3(right)), u = unit(v3(up)), hw = widthCm / 2, hh = heightCm / 2;
  const corner = (sx, sy) => add(c, add(scale(r, sx * hw), scale(u, sy * hh)));
  return { centre: c, right: r, up: u, normal: unit(cross(r, u)), widthCm, heightCm,
           tl: corner(-1, 1), tr: corner(1, 1), br: corner(1, -1), bl: corner(-1, -1) };
}
// Rectangle from its four measured corners: the best-fit rectangle (mean centre, averaged edge vectors,
// symmetric orthogonalisation) plus how far the measurements are from it.
export function rectFromCorners(c) {
  const tl = v3(c.tl), tr = v3(c.tr), br = v3(c.br), bl = v3(c.bl);
  const centre = scale(add(add(tl, tr), add(br, bl)), 0.25);
  const rightRaw = scale(add(sub(tr, tl), sub(br, bl)), 0.5);
  const upRaw = scale(add(sub(tl, bl), sub(tr, br)), 0.5);
  const widthCm = len(rightRaw), heightCm = len(upRaw);
  // rotate both by half the angle error so neither measured edge is favoured
  const r0 = unit(rightRaw), u0 = unit(upRaw);
  const n = unit(cross(r0, u0)), b = unit(add(r0, u0)), p = unit(cross(n, b)), k = Math.SQRT1_2;
  const right = unit(sub(scale(b, k), scale(p, k))), up = unit(add(scale(b, k), scale(p, k)));
  const rect = rectFrom(centre, right, up, widthCm, heightCm);
  rect.fitErrorCm = Math.max(dist(rect.tl, tl), dist(rect.tr, tr), dist(rect.br, br), dist(rect.bl, bl));
  return rect;
}
// Sub-rectangle in monitor pixel fractions from the top-left ({u0,v0,u1,v1}), for a canvas that covers
// only part of the monitor. The corner correspondence (and so the pixel mapping) is preserved.
export function subRect(rect, vp) {
  const at = (u, v) => add(rect.tl, add(scale(sub(rect.tr, rect.tl), u), scale(sub(rect.bl, rect.tl), v)));
  const out = { ...rect, tl: at(vp.u0, vp.v0), tr: at(vp.u1, vp.v0), br: at(vp.u1, vp.v1), bl: at(vp.u0, vp.v1) };
  out.centre = at((vp.u0 + vp.u1) / 2, (vp.v0 + vp.v1) / 2);
  out.widthCm = rect.widthCm * (vp.u1 - vp.u0);
  out.heightCm = rect.heightCm * (vp.v1 - vp.v0);
  return out;
}
export function reflectRect(rect, pl) {
  const out = rectFrom(reflectPoint(pl, rect.centre), reflectVector(pl, rect.right), reflectVector(pl, rect.up),
                       rect.widthCm, rect.heightCm);
  // rectFrom recomputes the normal as right x up, which flips under a reflection; the side the image
  // actually faces is the reflected normal.
  out.normal = reflectVector(pl, rect.normal);
  out.tl = reflectPoint(pl, rect.tl); out.tr = reflectPoint(pl, rect.tr);
  out.br = reflectPoint(pl, rect.br); out.bl = reflectPoint(pl, rect.bl);
  return out;
}
// Point on a rectangle from pixel-space uv (u from the left, v DOWN from the top, both 0..1).
export const rectPoint = (rect, u, v) =>
  add(rect.tl, add(scale(sub(rect.tr, rect.tl), u), scale(sub(rect.bl, rect.tl), v)));
// The inverse: pixel-space uv of a point on (or near) the rectangle's plane.
export function rectUV(rect, p) {
  const d = sub(v3(p), rect.tl);
  return { u: dot(d, rect.right) / rect.widthCm, v: -dot(d, rect.up) / rect.heightCm };
}
export const rectPlane = (rect) => plane(rect.centre, rect.normal);

// ---------- the rig ----------
// Defaults: a 24" monitor 30 cm above the sheet, tilted 20 degrees off straight-down toward the viewer,
// and the model floating 13 cm under the sheet where hands can reach it.
export const DEFAULT_RIG = {
  monitor: { widthCm: 53.1, heightCm: 29.9, pixelW: 1920, pixelH: 1080,
             centre: [0, 30, -18], tiltDeg: 20, yawDeg: 0, rollDeg: 0, rot180: false, corners: null },
  sheet: { point: [0, 0, 0], normal: [0, 1, 0], widthCm: 44, depthCm: 40 },
  fold: null,                       // { point, normal, widthCm, heightCm }: fold mirror, hit BEFORE the sheet
  model: { anchor: [0, -13, 0], fitCm: 18, yawDeg: 0 },
  head: { position: [0, 8, 24], yawDeg: 0, pitchDeg: -35, rollDeg: 0, scale: 1 },
  hand: { fit: null, rmsMm: null, maxMm: null, capturedAt: null },
  flipAxis: 'x',                    // which way the rendered image is mirrored for the monitor: 'x' or 'y'
  near: 1, far: 500,
};
// Where a seated viewer's eye is when nothing is tracked yet: used for the diagrams and the checks.
export const DEFAULT_EYE = [0, 42, 44];
export function makeRig(partial = {}) {
  const rig = { ...DEFAULT_RIG, ...partial };
  for (const k of ['monitor', 'sheet', 'model', 'head', 'hand'])
    rig[k] = { ...DEFAULT_RIG[k], ...(partial[k] || {}) };
  rig.fold = partial.fold ? { widthCm: 40, heightCm: 30, ...partial.fold } : null;
  return rig;
}

const rotAxis = (v, axis, ang) => {       // Rodrigues, for roll about the screen normal
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
};
const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

// The physical monitor rectangle, either from 4 measured corners or from size + pose.
// tiltDeg 0 = the screen faces straight down; positive tilts the face toward the viewer (+Z), which is how
// it has to be mounted for the reflection to face the viewer. yawDeg turns it about +Y, rollDeg about its
// own normal, rot180 is the same monitor mounted the other way up.
export function monitorRect(m) {
  if (m.corners) { const r = rectFromCorners(m.corners); r.pixelW = m.pixelW; r.pixelH = m.pixelH; return r; }
  const t = (m.tiltDeg || 0) * DEG;
  let right = [1, 0, 0], up = [0, Math.sin(t), Math.cos(t)];
  if (m.rot180) { right = scale(right, -1); up = scale(up, -1); }
  const n = unit(cross(right, up));
  if (m.rollDeg) { right = rotAxis(right, n, m.rollDeg * DEG); up = rotAxis(up, n, m.rollDeg * DEG); }
  const y = (m.yawDeg || 0) * DEG;
  const rect = rectFrom(v3(m.centre), rotY(right, y), rotY(up, y), m.widthCm, m.heightCm);
  rect.pixelW = m.pixelW; rect.pixelH = m.pixelH;
  return rect;
}
// The mirrors the light meets, in the order it meets them (fold mirror first, sheet last).
export const rigMirrors = (rig) => rig.fold ? [planeOf(rig.fold), planeOf(rig.sheet)] : [planeOf(rig.sheet)];

// The virtual screen: the monitor reflected through every mirror, keeping the pixel-corner correspondence.
// `mirrored` (an odd number of reflections) is what makes the rendered image need a flip.
export function virtualScreen(rig) {
  let rect = monitorRect(rig.monitor);
  const ms = rigMirrors(rig);
  for (const pl of ms) rect = reflectRect(rect, pl);
  rect.reflections = ms.length;
  rect.mirrored = ms.length % 2 === 1;
  rect.pixelW = rig.monitor.pixelW; rect.pixelH = rig.monitor.pixelH;
  return rect;
}

// Fold-mirror variant: a plain mirror above folds the light, and the panel moves to the mirror image of
// where it was. The virtual screen (and therefore every projection) is identical - but with two reflections
// the image is no longer mirrored, so no flip is needed.
// The catch is optical path length: the panel ends up as far behind the mirror as its image is in front, so
// only a rig whose image is well away from the sheet can fold the panel below the sheet (see FOLD_EXAMPLE).
export function foldRig(rig, foldPlane) {
  const pl = planeOf(foldPlane || autoFoldPlane(rig));
  const m = reflectRect(monitorRect(rig.monitor), pl);
  // A real panel cannot be a mirror image of a panel: its pixel frame always turns the right way about its
  // own face. So the panel goes on the reflected rectangle with its columns the other way round, which is
  // also why the folded rig shows the picture un-mirrored.
  return makeRig({ ...rig,
    fold: { point: pl.point, normal: pl.normal,
            widthCm: foldPlane?.widthCm ?? rig.monitor.widthCm * 1.2, heightCm: foldPlane?.heightCm ?? rig.monitor.heightCm * 1.4 },
    monitor: { ...rig.monitor, corners: { tl: m.tr, tr: m.tl, br: m.bl, bl: m.br } } });
}
// The mirror that drops the panel to `target` (by default under the sheet, at the back): the perpendicular
// bisector of the monitor centre and that target.
export function autoFoldPlane(rig, target = null) {
  const c = monitorRect(rig.monitor).centre, s = planeOf(rig.sheet);
  const t = target ? v3(target) : add(v3(rig.sheet.point), [c[0], -12, c[2] - 30]);
  return { point: scale(add(c, t), 0.5), normal: unit(sub(c, t)) };
}
// A worked fold rig: a monitor 55 cm above the sheet tilted 39 degrees, folded through a nearly horizontal
// mirror 20 cm above the back of the sheet, which puts the panel 12 cm BELOW the sheet at the back. The
// image sits where the tall rig put it; the sheet has to be bigger because the throw is longer.
// The rig has to be tall for this: the panel ends up as far behind the mirror as the image is in front of
// it, so only a long throw (here a panel 75 cm above the sheet) folds down to a panel BELOW the sheet while
// leaving the nearly horizontal mirror clear of the viewer's own line of sight.
export const FOLD_EXAMPLE = () => foldRig(
  makeRig({ monitor: { ...DEFAULT_RIG.monitor, centre: [0, 75, -45], tiltDeg: 48 },
            sheet: { ...DEFAULT_RIG.sheet, widthCm: 60, depthCm: 50 } }),
  { point: [0, 30.4, -13.3], normal: [0, 29, 1], widthCm: 50, heightCm: 39 });

// A mirror's own rectangle (for extent and blocking checks): centred on its point, in its own plane.
export function mirrorRect(m) {
  const pl = planeOf(m), ax = planeAxes(pl);
  return rectFrom(pl.point, ax.u, ax.v, m.widthCm ?? 40, m.heightCm ?? m.depthCm ?? 40);
}
// Does `rect` sit between the eye and any of these points?
function blocksSight(rect, eye, targets) {
  const pl = rectPlane(rect);
  for (const c of targets) {
    const t = rayPlane(eye, sub(c, eye), pl);
    if (t === null || t <= 1e-6 || t >= 1) continue;
    const uv = rectUV(rect, add(eye, scale(sub(c, eye), t)));
    if (uv.u > 0 && uv.u < 1 && uv.v > 0 && uv.v < 1) return true;
  }
  return false;
}

// ---------- matrices (column-major, THREE.Matrix4 element order) ----------
export function perspective(l, r, t, b, near, far) {
  const x = 2 * near / (r - l), y = 2 * near / (t - b);
  const a = (r + l) / (r - l), bb = (t + b) / (t - b);
  const c = -(far + near) / (far - near), d = -2 * far * near / (far - near);
  return [x, 0, 0, 0, 0, y, 0, 0, a, bb, c, -1, 0, 0, d, 0];
}
export function mat4Mul(a, b) {          // a * b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
export const mat4Apply = (m, p) => {     // p = [x,y,z,w]
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) o[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3];
  return o;
};
// Inverse of a rigid (rotation + translation) matrix, which is all rigCamera ever produces.
export function invertRigid(m) {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];   // columns of R
  const t = [m[12], m[13], m[14]];
  const rt = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];   // R^T
  const p = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
             -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
             -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])];
  rt[12] = p[0]; rt[13] = p[1]; rt[14] = p[2];
  return rt;
}

// ---------- the rig camera ----------
// Off-axis projection from `eyeRig` through the virtual screen, plus the flip that puts the result on the
// monitor the right way round. opts: { near, far, viewport: {u0,v0,u1,v1} (monitor pixel fractions,
// v down from the top), flipAxis: 'x'|'y' }.
export function rigCamera(rig, eyeRig, opts = {}) {
  const near = opts.near ?? rig.near ?? 1, far = opts.far ?? rig.far ?? 500;
  const eye = v3(eyeRig);
  const full = virtualScreen(rig);
  const vp = opts.viewport || null;
  const V = vp ? subRect(full, vp) : full;
  const flipAxis = opts.flipAxis || rig.flipAxis || 'x';

  // Kooima needs a right-handed screen frame whose normal points at the eye. The virtual screen's own
  // pixel frame is left-handed after one reflection, so swap two corners: swapping left/right leaves the
  // image to be mirrored in x, swapping top/bottom in y. Either is correct; they differ by a 180 deg roll.
  let pa, pb, pc, flipX = false, flipY = false;
  if (!full.mirrored) { pa = V.bl; pb = V.br; pc = V.tl; }
  else if (flipAxis === 'y') { pa = V.tl; pb = V.tr; pc = V.bl; flipY = true; }
  else { pa = V.br; pb = V.bl; pc = V.tr; flipX = true; }

  const vr = unit(sub(pb, pa));
  const up0 = sub(pc, pa);
  const vu = unit(sub(up0, scale(vr, dot(up0, vr))));      // measured corners are not exactly square
  const vn = unit(cross(vr, vu));
  const va = sub(pa, eye), vb = sub(pb, eye), vc = sub(pc, eye);
  const d = -dot(vn, va);                                   // eye distance to the screen plane, + in front
  const k = near / (Math.abs(d) < 1e-6 ? 1e-6 : d);
  const l = dot(vr, va) * k, r = dot(vr, vb) * k, b = dot(vu, va) * k, t = dot(vu, vc) * k;

  return {
    projectionMatrix: perspective(l, r, t, b, near, far),
    matrixWorld: [vr[0], vr[1], vr[2], 0, vu[0], vu[1], vu[2], 0, vn[0], vn[1], vn[2], 0, eye[0], eye[1], eye[2], 1],
    flipX, flipY, near, far, eye,
    frustum: { left: l, right: r, top: t, bottom: b },
    basis: { right: vr, up: vu, normal: vn },
    screen: { pa, pb, pc },
    virtual: V, viewport: vp,
    mirrored: full.mirrored, reflections: full.reflections,
    eyeDistanceCm: d,
    eyeInFront: d > 0,                                      // false = the eye is behind the virtual screen
  };
}

// Apply a rigCamera result to a THREE.PerspectiveCamera. `worldFromRig` (optional, column-major 16) is the
// matrix that maps rig coordinates into the scene's world frame, for the case where the scene is NOT in rig
// coordinates. Never call camera.updateProjectionMatrix() afterwards; it would overwrite the frustum.
export function applyRigCamera(camera, rc, worldFromRig = null) {
  const m = worldFromRig ? mat4Mul(worldFromRig, rc.matrixWorld) : rc.matrixWorld;
  camera.projectionMatrix.fromArray(rc.projectionMatrix);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.matrixAutoUpdate = false;
  camera.matrix.fromArray(m);
  camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
  camera.matrixWorld.fromArray(m);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  camera.near = rc.near; camera.far = rc.far;
  return camera;
}

// ---------- pixels ----------
// NDC (-1..1, y up) -> monitor pixel uv (0..1, v down from the top), undoing the flip and any sub-viewport.
export function ndcToMonitorUV(rc, x, y) {
  let u = rc.flipX ? (1 - x) / 2 : (x + 1) / 2;
  let v = rc.flipY ? (y + 1) / 2 : (1 - y) / 2;
  if (rc.viewport) {
    u = rc.viewport.u0 + u * (rc.viewport.u1 - rc.viewport.u0);
    v = rc.viewport.v0 + v * (rc.viewport.v1 - rc.viewport.v0);
  }
  return { u, v };
}
// Project a rig-frame point the way the GPU will, through the matrices rigCamera returned.
export function projectPoint(rc, p) {
  const c = mat4Apply(rc.projectionMatrix, mat4Apply(invertRigid(rc.matrixWorld), [...v3(p), 1]));
  const w = c[3];
  return { ndc: [c[0] / w, c[1] / w, c[2] / w], w, behind: w <= 0 };
}
// Where on the physical monitor a rig-frame point is drawn: uv, pixels, and the 3D point on the screen.
export function projectToMonitor(rig, rc, p) {
  const pr = projectPoint(rc, p);
  const { u, v } = ndcToMonitorUV(rc, pr.ndc[0], pr.ndc[1]);
  const mon = monitorRect(rig.monitor);
  return { ...pr, u, v, point: rectPoint(mon, u, v),
           pixel: [u * (rig.monitor.pixelW || 1), v * (rig.monitor.pixelH || 1)],
           inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 && !pr.behind };
}

// ---------- ray tracing (the physical check, and the diagrams) ----------
// Follow the light backwards from the eye along an apparent direction: through every mirror in reverse
// order (sheet first) and on to the monitor plane. Returns the reflection points and where it lands.
export function tracePath(rig, eyeRig, apparentDir) {
  let o = v3(eyeRig), d = unit(v3(apparentDir));
  const points = [], ms = rigMirrors(rig).slice().reverse();
  for (const pl of ms) {
    const t = rayPlane(o, d, pl);
    if (t === null || t <= 1e-9) return { ok: false, points, monitorPoint: null };
    o = add(o, scale(d, t));
    points.push(o);
    d = sub(d, scale(pl.normal, 2 * dot(d, pl.normal)));
  }
  const mon = monitorRect(rig.monitor);
  const t = rayPlane(o, d, rectPlane(mon));
  if (t === null || t <= 1e-9) return { ok: false, points, monitorPoint: null };
  const monitorPoint = add(o, scale(d, t));
  const uv = rectUV(mon, monitorPoint);
  return { ok: true, points, monitorPoint, uv,
           onScreen: uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1 };
}
// The whole light path for one monitor pixel, in the direction the light actually travels:
// monitor -> mirrors -> eye. Handy for drawing the rig diagram.
export function pixelPath(rig, u, v, eyeRig) {
  const mon = monitorRect(rig.monitor);
  const start = rectPoint(mon, u, v);
  let img = start;
  for (const pl of rigMirrors(rig)) img = reflectPoint(pl, img);   // the virtual image of that pixel
  const eye = v3(eyeRig);
  const back = tracePath(rig, eye, sub(img, eye));
  return { start, virtualPoint: img, hits: back.points.slice().reverse(), eye, ok: back.ok,
           landsOnPixel: back.ok ? back.uv : null };
}

// ---------- placing the model ----------
// Matrix for the model's display root so its contents float at the rig anchor under the sheet.
// `box` is the root's own bounding box in ITS local frame ({min, max} in cm). With model.fitCm set the
// model is scaled so its largest dimension is that many centimetres; otherwise it keeps its size.
export function modelRigMatrix(rig, box) {
  const min = v3(box.min), max = v3(box.max);
  const c = scale(add(min, max), 0.5), size = sub(max, min);
  const biggest = Math.max(size[0], size[1], size[2], 1e-6);
  const s = rig.model.fitCm ? rig.model.fitCm / biggest : 1;
  const a = (rig.model.yawDeg || 0) * DEG, ca = Math.cos(a), sa = Math.sin(a);
  const R = [ca * s, 0, -sa * s, 0, s, 0, sa * s, 0, ca * s];         // Ry(a) * s, column-major 3x3
  const anchor = v3(rig.model.anchor);
  const t = sub(anchor, [R[0] * c[0] + R[3] * c[1] + R[6] * c[2],
                         R[1] * c[0] + R[4] * c[1] + R[7] * c[2],
                         R[2] * c[0] + R[5] * c[1] + R[8] * c[2]]);
  return [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, t[0], t[1], t[2], 1];
}

// ---------- sanity checks for the calibration UI ----------
// Everything that can be wrong with a rig before you switch the lights off: the image facing away, the
// sheet too small for the cone of sight, the monitor itself in the way, the model above the sheet.
export function rigCheck(rig, eyeRig) {
  const eye = v3(eyeRig), warnings = [];
  const V = virtualScreen(rig), mon = monitorRect(rig.monitor), sheet = planeOf(rig.sheet);
  const rc = rigCamera(rig, eye);
  if (!rc.eyeInFront) warnings.push('The eye is behind the virtual screen: the monitor is facing the wrong way (raise the tilt).');
  if (signedDist(sheet, eye) <= 0) warnings.push('The eye is under the sheet.');
  if (signedDist(sheet, v3(rig.model.anchor)) >= 0) warnings.push('The model anchor is above the sheet; it should float underneath.');

  // does the cone of sight to the virtual screen stay on the sheet?
  const ax = planeAxes(sheet), half = [rig.sheet.widthCm / 2, rig.sheet.depthCm / 2];
  const hits = [], off = [];
  for (const c of [V.tl, V.tr, V.br, V.bl]) {
    const t = rayPlane(eye, sub(c, eye), sheet);
    if (t === null) continue;
    const h = add(eye, scale(sub(c, eye), t));
    hits.push(h);
    const d = sub(h, sheet.point), a = dot(d, ax.u), b = dot(d, ax.v);
    if (Math.abs(a) > half[0] || Math.abs(b) > half[1]) off.push(h);
  }
  if (off.length) warnings.push(`${off.length} of 4 image corners reflect off the edge of the sheet; make the sheet bigger or move the monitor.`);

  // is the panel, or the fold mirror, between the eye and the image?
  const sightlines = [V.tl, V.tr, V.br, V.bl, V.centre];
  if (blocksSight(mon, eye, sightlines)) warnings.push('The panel itself blocks the line of sight to its reflection.');
  if (rig.fold && blocksSight(mirrorRect(rig.fold), eye, sightlines)) warnings.push('The fold mirror hangs in the line of sight; make it shallower or move it back.');

  // does light from the panel actually reach the eye? (a fold mirror the beam never crosses fails here)
  const trace = tracePath(rig, eye, sub(v3(rig.model.anchor), eye));
  if (!trace.ok) warnings.push('No light path from the panel to the eye: check the mirror positions.');
  else if (rig.fold) {
    const fr = mirrorRect(rig.fold), uv = rectUV(fr, trace.points[1]);
    if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) warnings.push('The beam misses the fold mirror; make it bigger or move it.');
  }

  // is the model inside the image?
  const pm = projectToMonitor(rig, rc, rig.model.anchor);
  if (!pm.inside) warnings.push('The model anchor falls outside the monitor image; move the anchor or the monitor.');
  return { ok: warnings.length === 0, warnings, sheetHits: hits, virtual: V, camera: rc, anchorPixel: pm };
}
