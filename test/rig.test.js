// SPDX-License-Identifier: GPL-3.0-or-later
// Rig-mode maths: reflection, the virtual screen, the off-axis projection and its flip, the fold mirror,
// the hand-tracker fit and the eye conversion. Everything is checked against an independent ray trace,
// not against itself: for a point floating under the sheet, the monitor pixel the projection picks must be
// the pixel whose light actually reflects off the sheet into the eye through that point.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeRig, DEFAULT_RIG, monitorRect, virtualScreen, rigCamera, applyRigCamera, projectPoint,
         projectToMonitor, ndcToMonitorUV, rectPoint, rectUV, tracePath, pixelPath, foldRig, modelRigMatrix,
         rigCheck, reflectPoint, planeOf, lineDist, dist, sub, add, scale, dot, unit, len, FOLD_EXAMPLE,
         mat4Apply, invertRigid } from '../public/js/rig/geometry.js';
import { fitSimilarity, applyFit, invertFit, poseMatrix3, poseAngles, applyPose, cameraLocalFromTracker,
         trackerToRig, poseFromHandFit, defaultTargets, m3apply } from '../public/js/rig/calibrate.js';

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const rand = rng(12345);
const rnd = (a, b) => a + rand() * (b - a);
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b} (eps ${eps})`);
const nearV = (a, b, eps, what = '') => assert.ok(dist(a, b) <= eps, `${what} [${a}] vs [${b}] (${dist(a, b)} > ${eps})`);

const RIG = makeRig();
const EYE = [3, 42, 44];
// points floating under the sheet where the hands work: a 7 cm ball around the model anchor, which is what
// the image has to cover, plus a wider spread that only has to obey the optics
const underSheet = (n, r = 7) => Array.from({ length: n }, () => {
  let p;
  do { p = [rnd(-r, r), rnd(-r, r), rnd(-r, r)]; } while (len(p) > r);
  return add(RIG.model.anchor, p);
});
const anywhereUnder = (n) => Array.from({ length: n }, () => [rnd(-14, 14), rnd(-26, -4), rnd(-14, 14)]);

test('the sheet reflects the monitor into a virtual screen under it', () => {
  const mon = monitorRect(RIG.monitor), vs = virtualScreen(RIG);
  assert.equal(vs.reflections, 1);
  assert.equal(vs.mirrored, true);
  for (const k of ['tl', 'tr', 'br', 'bl']) {
    near(mon[k][0], vs[k][0], 1e-12, `${k} x kept`);
    near(mon[k][1], -vs[k][1], 1e-12, `${k} y mirrored`);
    near(mon[k][2], vs[k][2], 1e-12, `${k} z kept`);
    assert.ok(mon[k][1] > 0 && vs[k][1] < 0, 'monitor above, image below');
  }
  // an isometry: edges and diagonals survive, the tilt is mirrored
  near(dist(mon.tl, mon.tr), dist(vs.tl, vs.tr), 1e-12, 'width');
  near(dist(mon.tl, mon.br), dist(vs.tl, vs.br), 1e-12, 'diagonal');
  near(mon.up[1], -vs.up[1], 1e-12, 'tilt mirrored');
  near(mon.normal[1], -vs.normal[1], 1e-12, 'normal mirrored');
  assert.ok(vs.normal[1] > 0, 'the image faces up, toward the viewer');
});

test('pixel correspondence survives the reflection', () => {
  const mon = monitorRect(RIG.monitor), vs = virtualScreen(RIG), sheet = planeOf(RIG.sheet);
  for (let i = 0; i < 20; i++) {
    const u = rand(), v = rand();
    nearV(reflectPoint(sheet, rectPoint(mon, u, v)), rectPoint(vs, u, v), 1e-12, 'pixel uv maps through');
  }
  const uv = rectUV(mon, rectPoint(mon, 0.3, 0.8));
  near(uv.u, 0.3, 1e-12); near(uv.v, 0.8, 1e-12);
});

test('a measured monitor (4 corners) reproduces the parametric one', () => {
  const mon = monitorRect(RIG.monitor);
  const measured = monitorRect({ ...RIG.monitor, corners: { tl: mon.tl, tr: mon.tr, br: mon.br, bl: mon.bl } });
  for (const k of ['tl', 'tr', 'br', 'bl', 'centre']) nearV(measured[k], mon[k], 1e-9, k);
  near(measured.widthCm, RIG.monitor.widthCm, 1e-9);
  near(measured.fitErrorCm, 0, 1e-9);
  // 2 mm of measurement noise: the fit stays a rectangle and reports the error
  const jig = (p) => p.map((c) => c + rnd(-0.2, 0.2));
  const noisy = monitorRect({ ...RIG.monitor, corners: { tl: jig(mon.tl), tr: jig(mon.tr), br: jig(mon.br), bl: jig(mon.bl) } });
  assert.ok(noisy.fitErrorCm < 0.5, `fit error ${noisy.fitErrorCm}`);
  near(dot(noisy.right, noisy.up), 0, 1e-12, 'still square');
});

test('the projected pixel is the pixel whose reflected ray passes through the point', () => {
  const rc = rigCamera(RIG, EYE);
  assert.equal(rc.eyeInFront, true);
  const sheet = planeOf(RIG.sheet);
  for (const P of [...underSheet(30), ...anywhereUnder(20)]) {
    const pm = projectToMonitor(RIG, rc, P);
    if (len(sub(P, RIG.model.anchor)) <= 7) assert.ok(pm.inside, `point ${P} lands on the monitor (u ${pm.u}, v ${pm.v})`);

    // independent trace: from the eye along the apparent direction, reflect off the sheet, hit the monitor
    const tr = tracePath(RIG, EYE, sub(P, EYE));
    assert.ok(tr.ok, 'the light path reaches the monitor');
    assert.equal(tr.onScreen, pm.inside, 'trace and projection agree on whether it is on the panel');
    nearV(pm.point, tr.monitorPoint, 1e-6, 'projection vs ray trace');
    near(pm.u, tr.uv.u, 1e-8); near(pm.v, tr.uv.v, 1e-8);

    // and the law of reflection holds on that path, with the point on the eye ray beyond the sheet
    const B = tr.points[0];
    near(dot(sub(B, sheet.point), sheet.normal), 0, 1e-9, 'hit is on the sheet');
    const dIn = unit(sub(B, pm.point)), out = unit(sub(EYE, B));
    nearV(sub(dIn, scale(sheet.normal, 2 * dot(dIn, sheet.normal))), out, 1e-9, 'angle in = angle out');
    assert.ok(lineDist(P, EYE, sub(B, EYE)) < 1e-6, 'the point sits on the reflected ray');
    assert.ok(dot(sub(P, B), sheet.normal) < 0, 'and under the sheet');
  }
});

test('the image is flipped, and unflipping it would break the alignment', () => {
  const rc = rigCamera(RIG, EYE);
  assert.equal(rc.flipX, true);
  assert.equal(rc.flipY, false);
  const P = [6, -14, 3];
  const pr = projectPoint(rc, P);
  const good = ndcToMonitorUV(rc, pr.ndc[0], pr.ndc[1]);
  const naive = { u: (pr.ndc[0] + 1) / 2, v: (1 - pr.ndc[1]) / 2 };      // what you get if you forget the mirror
  near(good.u, 1 - naive.u, 1e-12, 'the flip is exactly a mirror in u');
  assert.ok(Math.abs(good.u - naive.u) > 0.02, 'and it matters for this point');
  const mon = monitorRect(RIG.monitor), sheet = planeOf(RIG.sheet);
  const hit = (uv) => {                                                   // where that pixel's light appears
    const img = reflectPoint(sheet, rectPoint(mon, uv.u, uv.v));
    return lineDist(P, EYE, sub(img, EYE));
  };
  assert.ok(hit(good) < 1e-6, 'flipped pixel lands on the point');
  assert.ok(hit(naive) > 1, 'unflipped pixel misses it by centimetres');

  // flipping in y instead is the same picture rolled 180 degrees: the same monitor pixel
  const ry = rigCamera(RIG, EYE, { flipAxis: 'y' });
  assert.equal(ry.flipY, true); assert.equal(ry.flipX, false);
  const py = projectPoint(ry, P);
  const uvy = ndcToMonitorUV(ry, py.ndc[0], py.ndc[1]);
  near(uvy.u, good.u, 1e-9, 'same pixel u'); near(uvy.v, good.v, 1e-9, 'same pixel v');
});

test('pixelPath is the inverse of the projection', () => {
  const rc = rigCamera(RIG, EYE);
  for (let i = 0; i < 10; i++) {
    const u = rnd(0.1, 0.9), v = rnd(0.1, 0.9);
    const path = pixelPath(RIG, u, v, EYE);
    assert.ok(path.ok);
    near(path.landsOnPixel.u, u, 1e-9); near(path.landsOnPixel.v, v, 1e-9);
    // a point on that light ray under the sheet projects back to the same pixel
    const P = add(EYE, scale(sub(path.virtualPoint, EYE), 0.8));
    const pm = projectToMonitor(RIG, rc, P);
    near(pm.u, u, 1e-9); near(pm.v, v, 1e-9);
  }
});

test('a canvas covering part of the monitor draws the same pixels', () => {
  const rc = rigCamera(RIG, EYE);
  const vp = { u0: 0.25, v0: 0.1, u1: 0.8, v1: 0.75 };
  const sub_ = rigCamera(RIG, EYE, { viewport: vp });
  for (const P of underSheet(10)) {
    const a = projectToMonitor(RIG, rc, P), b = projectToMonitor(RIG, sub_, P);
    if (!(b.ndc[0] > -1 && b.ndc[0] < 1 && b.ndc[1] > -1 && b.ndc[1] < 1)) continue;
    near(a.u, b.u, 1e-9, 'same monitor u'); near(a.v, b.v, 1e-9, 'same monitor v');
  }
});

test('fold mirror: two reflections, no flip, same image', () => {
  const tall = makeRig({ monitor: { ...DEFAULT_RIG.monitor, centre: [0, 75, -45], tiltDeg: 48 },
                         sheet: { ...DEFAULT_RIG.sheet, widthCm: 60, depthCm: 50 } });
  const folded = FOLD_EXAMPLE();
  const a = virtualScreen(tall), b = virtualScreen(folded);
  assert.equal(b.reflections, 2);
  assert.equal(b.mirrored, false);
  // the image lands on exactly the same rectangle, with its columns the other way round (the panel is a real
  // panel, not a mirror image of one), which is what saves the flip
  for (const [x, y] of [['tl', 'tr'], ['tr', 'tl'], ['bl', 'br'], ['br', 'bl']]) nearV(b[x], a[y], 1e-9, `folded virtual ${x}`);
  assert.ok(dot(b.normal, sub(EYE, b.centre)) > 0, 'the folded image faces the viewer');
  const panel = monitorRect(folded.monitor);
  assert.ok(panel.centre[1] < -5, `the panel is below the sheet (y ${panel.centre[1].toFixed(1)})`);
  assert.ok(panel.centre[2] < -30, 'and at the back');
  assert.equal(rigCheck(folded, EYE).ok, true, rigCheck(folded, EYE).warnings.join(' | '));

  const rc = rigCamera(folded, EYE);
  assert.equal(rc.flipX, false); assert.equal(rc.flipY, false);
  const single = rigCamera(tall, EYE);
  for (const P of underSheet(20)) {
    const pm = projectToMonitor(folded, rc, P);
    const tr = tracePath(folded, EYE, sub(P, EYE));                 // sheet, then fold mirror, then monitor
    assert.ok(tr.ok, 'the folded path reaches the monitor');
    assert.equal(tr.points.length, 2);
    nearV(pm.point, tr.monitorPoint, 1e-6, 'folded projection vs trace');
    // the law of reflection holds at the fold mirror too
    const [B, A] = tr.points, fold = planeOf(folded.fold);
    near(dot(sub(A, fold.point), fold.normal), 0, 1e-9, 'hit is on the fold mirror');
    const dIn = unit(sub(A, tr.monitorPoint)), out = unit(sub(B, A));
    nearV(sub(dIn, scale(fold.normal, 2 * dot(dIn, fold.normal))), out, 1e-9, 'angle in = angle out');
    // same content as the unfolded rig, mirrored left to right on the physical panel
    const ps = projectToMonitor(tall, single, P);
    near(pm.u, 1 - ps.u, 1e-9, 'unmirrored pixel column');
    near(pm.v, ps.v, 1e-9, 'same pixel row');
  }
  // a fold mirror the beam never crosses is reported rather than silently drawn
  const impossible = foldRig(RIG);
  assert.ok(rigCheck(impossible, EYE).warnings.length > 0, 'a too-short throw cannot be folded');
});

test('the projection matrices feed a THREE camera unchanged', () => {
  const rc = rigCamera(RIG, EYE);
  // the frustum matrix is exactly what three would build for the same off-axis frustum
  const f = rc.frustum;
  const ref = new THREE.Matrix4().makePerspective(f.left, f.right, f.top, f.bottom, rc.near, rc.far);
  ref.elements.forEach((e, i) => near(e, rc.projectionMatrix[i], 1e-12, `projection element ${i}`));
  const cam = new THREE.PerspectiveCamera();
  applyRigCamera(cam, rc);
  const m = cam.matrixWorld.clone();
  assert.ok(Math.abs(m.determinant() - 1) < 1e-9, 'rigid camera matrix');
  nearV([m.elements[12], m.elements[13], m.elements[14]], EYE, 1e-12, 'camera at the eye');
  for (const P of underSheet(10)) {
    const p = new THREE.Vector3(...P).project(cam);
    const mine = projectPoint(rc, P);
    near(p.x, mine.ndc[0], 1e-9); near(p.y, mine.ndc[1], 1e-9); near(p.z, mine.ndc[2], 1e-9);
  }
  // rendering into a scene that is not in rig coordinates: worldFromRig composes on the left
  const worldFromRig = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, -2, 7, 1];
  const cam2 = new THREE.PerspectiveCamera();
  applyRigCamera(cam2, rc, worldFromRig);
  const P = [1, -12, 2];
  const moved = new THREE.Vector3(...add(P, [5, -2, 7])).project(cam2);
  near(moved.x, projectPoint(rc, P).ndc[0], 1e-9, 'same picture, shifted scene');
});

test('the model lands under the sheet at the chosen size', () => {
  const box = { min: [-2, 0, -1], max: [2, 3, 1] };                       // metres-scaled model, 4 x 3 x 2
  const m = modelRigMatrix(RIG, box);
  const apply = (p) => mat4Apply(m, [...p, 1]).slice(0, 3);
  const c = apply([0, 1.5, 0]);
  nearV(c, RIG.model.anchor, 1e-9, 'centre at the anchor');
  const wide = dist(apply([-2, 1.5, 0]), apply([2, 1.5, 0]));
  near(wide, RIG.model.fitCm, 1e-9, 'largest dimension scaled to fitCm');
  assert.ok(c[1] < 0, 'under the sheet');
  const noFit = modelRigMatrix(makeRig({ model: { ...DEFAULT_RIG.model, fitCm: 0 } }), box);
  near(dist(mat4Apply(noFit, [-2, 1.5, 0, 1]).slice(0, 3), mat4Apply(noFit, [2, 1.5, 0, 1]).slice(0, 3)), 4, 1e-9, 'unscaled');
});

test('rigCheck catches the usual mistakes', () => {
  assert.equal(rigCheck(RIG, EYE).ok, true, rigCheck(RIG, EYE).warnings.join(' | '));
  const flat = makeRig({ monitor: { ...DEFAULT_RIG.monitor, tiltDeg: -40 } });   // tilted away from the viewer
  assert.ok(rigCheck(flat, EYE).warnings.length > 0);
  const deep = makeRig({ model: { ...DEFAULT_RIG.model, anchor: [0, 6, 0] } });  // model above the sheet
  assert.ok(rigCheck(deep, EYE).warnings.some((w) => /above the sheet/.test(w)));
  const tiny = makeRig({ sheet: { ...DEFAULT_RIG.sheet, widthCm: 8, depthCm: 8 } });
  assert.ok(rigCheck(tiny, EYE).warnings.some((w) => /edge of the sheet/.test(w)));
});

// ---------- hand tracker ----------
const makeTransform = (s, axis, ang, t) => {   // a known similarity to recover
  const k = unit(axis), c = Math.cos(ang), si = Math.sin(ang);
  const R = [];
  for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const r = add(add(scale(e, c), scale([k[1] * e[2] - k[2] * e[1], k[2] * e[0] - k[0] * e[2], k[0] * e[1] - k[1] * e[0]], si)),
                  scale(k, dot(k, e) * (1 - c)));
    R.push(r);
  }
  const Rm = [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]];   // columns are images of e
  return { s, R: Rm, t };
};

test('the hand fit recovers a known transform, with and without noise', () => {
  const truth = makeTransform(1.17, [0.3, 1, -0.2], 0.7, [4, -11, 3]);
  const src = Array.from({ length: 6 }, () => [rnd(-20, 20), rnd(-20, 20), rnd(20, 60)]);
  const dst = src.map((p) => applyFit(truth, p));
  const exact = fitSimilarity(src, dst);
  near(exact.s, truth.s, 1e-9, 'scale');
  for (let i = 0; i < 9; i++) near(exact.R[i], truth.R[i], 1e-9, 'rotation');
  nearV(exact.t, truth.t, 1e-8, 'translation');
  assert.ok(exact.maxMm < 1e-6, 'no residual');

  const noisy = dst.map((p) => p.map((c) => c + rnd(-0.3, 0.3)));    // 3 mm of tracker noise
  const fit = fitSimilarity(src, noisy);
  near(fit.s, truth.s, 0.05, 'scale under noise');
  assert.ok(fit.rmsMm > 0.2 && fit.rmsMm < 6, `rms ${fit.rmsMm} mm reflects the noise`);
  for (const p of src) assert.ok(dist(applyFit(fit, p), applyFit(truth, p)) < 0.8, 'within 8 mm of the truth');

  const rigid = fitSimilarity(src, dst, { withScale: false });
  near(rigid.s, 1, 1e-12, 'rigid fit keeps scale 1');

  const back = invertFit(fit);                                        // rig -> tracker
  for (const p of src) nearV(applyFit(back, applyFit(fit, p)), p, 1e-8, 'inverse');
  assert.throws(() => fitSimilarity(src.slice(0, 2), noisy.slice(0, 2)));
});

test('the touch targets are spread out enough to pin a transform down', () => {
  const targets = defaultTargets(RIG, 4);
  assert.equal(targets.length, 4);
  for (const t of targets) assert.ok(t[1] < 0, 'targets float under the sheet');
  // not coplanar: the volume of the tetrahedron is far from zero
  const [a, b, c, d] = targets;
  const vol = Math.abs(dot(sub(b, a), [
    (c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]),
    (c[2] - a[2]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[2] - a[2]),
    (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0])])) / 6;
  assert.ok(vol > 20, `tetrahedron volume ${vol} cm3`);
});

test('the webcam eye estimate converts into the rig frame', () => {
  const rig = makeRig({ head: { position: [2, 7, 26], yawDeg: 12, pitchDeg: -28, rollDeg: 4, scale: 1 } });
  const webcam = [0, 12.5, 0];                                       // where view.js says the camera is
  const R = poseMatrix3(rig.head);
  near(len(m3apply(R, [1, 0, 0])), 1, 1e-12, 'rotation keeps lengths');
  const ang = poseAngles(R);
  near(ang.yawDeg, 12, 1e-9); near(ang.pitchDeg, -28, 1e-9); near(ang.rollDeg, 4, 1e-9);

  // a point in front of the camera, expressed the way webcam.js writes it, comes back where it should be
  const local = [4, -3, 55];                                          // camera frame: right, down, forward
  const tracker = add(webcam, [-local[0], -local[1], local[2]]);      // webcam.js: world = wc + (-x, -y, z)
  nearV(cameraLocalFromTracker(tracker, webcam), local, 1e-12, 'back to camera frame');
  nearV(trackerToRig(rig, tracker, webcam), applyPose(rig.head, local), 1e-12, 'and into the rig');
  const eyeRig = trackerToRig(rig, tracker, webcam);
  assert.ok(eyeRig[1] > 0 && eyeRig[2] > 0, 'a viewer in front of and above the sheet');

  // a hand fit from the same camera implies the same pose (and the camera position it was told about)
  const fitFromPose = { s: rig.head.scale, R: (() => {
    const A = poseMatrix3(rig.head), C = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
    return [A[0] * C[0] + A[1] * C[3] + A[2] * C[6], A[0] * C[1] + A[1] * C[4] + A[2] * C[7], A[0] * C[2] + A[1] * C[5] + A[2] * C[8],
            A[3] * C[0] + A[4] * C[3] + A[5] * C[6], A[3] * C[1] + A[4] * C[4] + A[5] * C[7], A[3] * C[2] + A[4] * C[5] + A[5] * C[8],
            A[6] * C[0] + A[7] * C[3] + A[8] * C[6], A[6] * C[1] + A[7] * C[4] + A[8] * C[7], A[6] * C[2] + A[7] * C[5] + A[8] * C[8]];
  })(), t: null };
  fitFromPose.t = sub(v3rig(rig.head.position), scale(m3apply(fitFromPose.R, webcam), fitFromPose.s));
  const pose = poseFromHandFit(fitFromPose, webcam);
  nearV(pose.position, rig.head.position, 1e-9, 'camera position');
  near(pose.yawDeg, 12, 1e-6); near(pose.pitchDeg, -28, 1e-6); near(pose.rollDeg, 4, 1e-6);
  // and points convert identically either way
  nearV(applyFit(fitFromPose, tracker), trackerToRig(rig, tracker, webcam), 1e-9, 'fit == pose');
});
function v3rig(p) { return [p[0], p[1], p[2]]; }

test('a full rig-mode frame: tracked eye in, monitor pixels out', () => {
  const rig = makeRig();
  const webcam = [0, 12.5, 0];
  rig.head = { position: [0, 8, 24], yawDeg: 0, pitchDeg: -35, rollDeg: 0, scale: 1 };
  const trackerEye = [1, 20, 40];                                     // what webcam.js would report
  const eye = trackerToRig(rig, trackerEye, webcam);
  const rc = rigCamera(rig, eye);
  assert.ok(rc.eyeInFront, 'the tracked viewer sees the image');
  const pm = projectToMonitor(rig, rc, rig.model.anchor);
  assert.ok(pm.inside, `anchor on screen at ${pm.pixel.map(Math.round)}`);
  const tr = tracePath(rig, eye, sub(rig.model.anchor, eye));
  nearV(pm.point, tr.monitorPoint, 1e-6, 'pixel matches the traced light path');
  assert.ok(pm.pixel[0] >= 0 && pm.pixel[0] <= rig.monitor.pixelW);
});
