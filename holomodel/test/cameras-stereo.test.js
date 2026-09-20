import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitLayout, wholeLayout, parseZedConf, calibFor, defaultCalib, undistort, rayFromPixel, rotateVec,
  triangulateLocal, residualCm, camToWorld, makeView, viewsForCamera, loadSolver, setSolver, solverInfo,
  triangulate, solve3,
} from '../public/js/input/stereo.js';

// A real SN<serial>.conf looks like this (values trimmed to the sections we read).
const CONF = `
[LEFT_CAM_HD]
fx=700.5
fy=700.1
cx=639.2
cy=361.8
k1=-0.171
k2=0.0273
k3=0
p1=0.0001
p2=-0.0002

[RIGHT_CAM_HD]
fx=701.0
fy=700.6
cx=641.5
cy=360.2
k1=-0.169
k2=0.0261
k3=0

[STEREO]
Baseline=119.87
CV_HD=0.0021
RX_HD=-0.0009
RZ_HD=0.0004
`;

test('a side-by-side frame splits down the middle', () => {
  const L = splitLayout(2560, 720);
  assert.equal(L.mode, 'HD');
  assert.equal(L.eyeW, 1280);
  assert.deepEqual(L.left, { sx: 0, sy: 0, sw: 1280, sh: 720 });
  assert.deepEqual(L.right, { sx: 1280, sy: 0, sw: 1280, sh: 720 });
  const odd = splitLayout(1345, 376);              // an odd width must still cover the whole frame
  assert.equal(odd.left.sw + odd.right.sw, 1345);
  const one = wholeLayout(1920, 1080);
  assert.equal(one.sbs, false);
  assert.equal(one.right, null);
});

test('the factory calibration file parses into centimetres', () => {
  const conf = parseZedConf(CONF);
  const c = calibFor(conf, 2560, 720);
  assert.equal(c.source, 'SN.conf HD');
  assert.equal(c.left.fx, 700.5);
  assert.equal(c.right.cx, 641.5);
  assert.ok(Math.abs(c.baselineCm - 11.987) < 1e-6);   // the file is millimetres
  assert.deepEqual(c.rot, [-0.0009, 0.0021, 0.0004]);
  assert.equal(c.eyeW, 1280);
});

test('no calibration file still gives usable numbers, and says they are a guess', () => {
  const d = defaultCalib(2560, 720);
  assert.equal(d.source, 'typical ZED (no .conf)');
  assert.equal(d.metric, false);                 // usable for reaching out, not for trusting millimetres
  // The guess must agree with a real factory file to a few percent. It used to be derived from the
  // published 110 deg, which is the maximum DISTORTED field, and came out 26% short — a flat 26% of depth.
  const real = calibFor(parseZedConf(CONF), 2560, 720);
  assert.equal(real.metric, true);
  assert.ok(Math.abs(d.left.fx / real.left.fx - 1) < 0.05, `guess ${d.left.fx} vs conf ${real.left.fx}`);
  assert.equal(calibFor(null, 2560, 720).source, 'typical ZED (no .conf)');
  assert.equal(calibFor(parseZedConf(CONF), 1344, 376).source, 'typical ZED (no .conf)');   // no VGA section
  // a Mini's 63 mm baseline is not a 2i's 120 mm, and assuming it doubles the depth error
  assert.ok(Math.abs(defaultCalib(2560, 720, 'ZED Mini').baselineCm - 6.3) < 1e-9);
});

test('undistort inverts the distortion model', () => {
  const k = { fx: 700, fy: 700, cx: 640, cy: 360, k1: -0.17, k2: 0.027, k3: 0.001, p1: 0.0004, p2: -0.0003 };
  for (const [x, y] of [[0, 0], [0.2, -0.1], [-0.35, 0.28], [0.5, 0.5]]) {
    const r2 = x * x + y * y;
    const rad = 1 + k.k1 * r2 + k.k2 * r2 * r2 + k.k3 * r2 * r2 * r2;
    const xd = x * rad + 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x);
    const yd = y * rad + k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y;
    const [ux, uy] = undistort(xd, yd, k);
    assert.ok(Math.hypot(ux - x, uy - y) < 1e-6, `${x},${y}`);
  }
});

test('a pixel on the optical centre looks straight ahead', () => {
  const k = { fx: 700, fy: 700, cx: 640, cy: 360, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  assert.deepEqual(rayFromPixel(640, 360, k).map(v => Math.round(v * 1e6) / 1e6), [0, 0, 1]);
  const right = rayFromPixel(940, 360, k);
  assert.ok(right[0] > 0 && right[2] > 0);
});

test('a camera facing the user maps its image onto the world the way webcam.js does', () => {
  // a point up and to the camera's image-right is, for the viewer, up and to their LEFT
  const p = camToWorld([5, -3, 40]);
  assert.deepEqual(p.map(v => Math.round(v * 1e6) / 1e6), [-5, 3, 40]);
  const moved = camToWorld([0, 0, 40], { posCm: [0, 12, 0], rotDeg: [0, 0, 180] });
  assert.deepEqual(moved.map(v => Math.round(v * 1e6) / 1e6), [0, 12, 40]);
});

test('rotateVec is a rotation (lengths and right-handedness kept)', () => {
  const v = [0.3, -0.4, 0.86];
  const r = rotateVec(v, [0.02, -0.01, 0.005]);
  assert.ok(Math.abs(Math.hypot(...r) - Math.hypot(...v)) < 1e-12);
  assert.ok(Math.hypot(r[0] - v[0], r[1] - v[1], r[2] - v[2]) < 0.05);   // small angles move it a little
});

test('solve3 refuses a singular system instead of returning nonsense', () => {
  assert.equal(solve3([1, 2, 3, 2, 4, 6, 3, 6, 9], [1, 2, 3]), null);
});

// ---- the geometry that matters: a known 3D point, projected into both eyes, recovered ----

const project = (calib, eye, pCam) => {
  const k = eye === 'left' ? calib.left : calib.right;
  const p = eye === 'left' ? pCam : [pCam[0] - calib.baselineCm, pCam[1], pCam[2]];
  const r2 = (p[0] / p[2]) ** 2 + (p[1] / p[2]) ** 2;
  const rad = 1 + k.k1 * r2 + k.k2 * r2 * r2 + k.k3 * r2 * r2 * r2;   // forward model, so undistort has work to do
  const x = (p[0] / p[2]) * rad, y = (p[1] / p[2]) * rad;
  return [(k.fx * x + k.cx) / calib.eyeW, (k.fy * y + k.cy) / calib.eyeH];
};

test('a ZED frame recovers a point in the right place, in world centimetres', () => {
  const calib = calibFor(parseZedConf(CONF), 2560, 720);
  calib.rot = [0, 0, 0];                       // this test is about the pixels, not the tiny rectification angles
  const ext = { posCm: [0, 14, -2], rotDeg: [0, 0, 180] };
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib, ext, label: 'zed' });
  for (const P of [[0, 0, 40], [6, -4, 55], [-8, 3, 30], [2, 2, 70]]) {
    const a = project(calib, 'left', P), b = project(calib, 'right', P);
    const got = triangulateLocal([views[0].ray(...a), views[1].ray(...b)]);
    const want = camToWorld(P, ext);
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) < 0.02, `${P} -> ${got}`);
  }
});

test('one pixel of landmark noise costs a few millimetres at arm\'s length', () => {
  const calib = defaultCalib(2560, 720);
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib, ext: undefined, label: 'zed' });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const errs = [];
  for (let i = 0; i < 400; i++) {
    const P = [rnd() * 20, rnd() * 20, 50];
    const jitter = ([u, v]) => [u + rnd() * 2 / calib.eyeW, v + rnd() * 2 / calib.eyeH];   // +/- 1 px
    const a = jitter(project(calib, 'left', P)), b = jitter(project(calib, 'right', P));
    const got = triangulateLocal([views[0].ray(...a), views[1].ray(...b)]);
    const want = camToWorld(P);
    errs.push(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]));
  }
  errs.sort((x, y) => x - y);
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  assert.ok(mean < 0.8, `mean ${mean.toFixed(3)} cm`);                 // ~4 mm expected at 50 cm
  assert.ok(errs[Math.floor(errs.length * 0.95)] < 1.6, `p95 ${errs[Math.floor(errs.length * 0.95)].toFixed(3)} cm`);
});

test('the residual reports how badly two rays miss each other', () => {
  const rays = [{ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [10, 0, 0], dir: [0, 0, 1] }];
  const p = triangulateLocal(rays);
  assert.equal(p, null);                                   // parallel rays never meet
  const crossing = [{ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [10, 0, 0], dir: [-10, 0, 40] }];
  const q = triangulateLocal(crossing);
  assert.ok(residualCm(q, crossing) < 1e-9);
  const missing = [{ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [10, 2, 0], dir: [-10, 0, 40] }];
  assert.ok(residualCm(triangulateLocal(missing), missing) > 0.5);
});

test('a third view from the side cuts the error, which is why a spare webcam is worth aiming at the hands', () => {
  const calib = defaultCalib(2560, 720);
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib, label: 'zed' });
  const side = makeView({ intr: calib.left, eyeW: calib.eyeW, eyeH: calib.eyeH,
                          ext: { posCm: [45, 0, 45], rotDeg: [0, 90, 180] }, label: 'side' });
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const jitter = ([u, v]) => [u + rnd() * 2 / calib.eyeW, v + rnd() * 2 / calib.eyeH];
  let two = 0, three = 0;
  for (let i = 0; i < 300; i++) {
    const P = [rnd() * 16, rnd() * 16, 50], want = camToWorld(P);
    // the side view's own pixel of noise, applied as a small angular wobble on its exact ray
    const d = [want[0] - side.origin[0], want[1] - side.origin[1], want[2] - side.origin[2]];
    const wob = 1 / calib.left.fx;
    const sideRay = { origin: side.origin, dir: [d[0] + rnd() * 2 * wob * d[2], d[1] + rnd() * 2 * wob * d[2], d[2]], weight: 1 };
    const rays = [views[0].ray(...jitter(project(calib, 'left', P))), views[1].ray(...jitter(project(calib, 'right', P)))];
    const a = triangulateLocal(rays), b = triangulateLocal([...rays, sideRay]);
    two += Math.hypot(a[0] - want[0], a[1] - want[1], a[2] - want[2]);
    three += Math.hypot(b[0] - want[0], b[1] - want[1], b[2] - want[2]);
  }
  assert.ok(three < two * 0.6, `two views ${(two / 300).toFixed(3)} cm, three views ${(three / 300).toFixed(3)} cm`);
});

// ---- the adapter onto ../track/triangulate.js ----

test('the solver adapter falls back to the local midpoint when track/ is missing', async () => {
  const info = await loadSolver(async () => { throw new Error('not built yet'); });
  assert.equal(info.external, false);
  assert.equal(info.name, 'local midpoint');
  const p = triangulate([{ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [10, 0, 0], dir: [-10, 0, 40] }]);
  assert.ok(Math.abs(p[2] - 40) < 1e-6);
});

test('the adapter only takes a solver that gets a known answer right', async () => {
  const wrong = { triangulateRays: () => [0, 0, 0] };
  const { loadSolver: fresh } = await import('../public/js/input/stereo.js?a=1');
  assert.equal((await fresh(async () => wrong)).external, false);
});

test('the real track/triangulate.js is adopted, and it agrees with the local midpoint', async () => {
  const mod = await import('../public/js/input/stereo.js?a=2');
  const info = await mod.loadSolver();                       // no importer: the real file
  assert.equal(info.external, true, info.name);
  assert.match(info.name, /track\/triangulate\.js/);

  const rays = [{ origin: [0, 0, 0], dir: [3, 0, 30] }, { origin: [12, 0, 0], dir: [-9, 0, 30] }];
  const a = mod.triangulate(rays), b = mod.triangulateLocal(rays);
  const gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  console.log(`      real solver ${a.map(v => v.toFixed(3)).join(', ')} cm, local midpoint differs by ${(gap * 10).toFixed(4)} mm`);
  assert.ok(gap < 1e-6, `the two estimators must be the same maths, differ by ${gap}`);
});

test('an injected solver is used, and a throwing one does not take the app down', () => {
  setSolver(() => [1, 2, 3], 'test');
  assert.deepEqual(triangulate([]), [1, 2, 3]);
  setSolver(() => { throw new Error('bad'); }, 'test');
  const p = triangulate([{ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [10, 0, 0], dir: [-10, 0, 40] }]);
  assert.ok(Math.abs(p[2] - 40) < 1e-6);
  setSolver(null, 'local midpoint');
});

// ---- the two files that describe a ZED must describe the SAME ZED ----

test('input/stereo.js and track/calibrate.js place the ZED\'s right eye the same way round', async () => {
  const { parseZedConf: parseConf, camerasFromZedConf } = await import('../public/js/track/calibrate.js');
  // Each file has its own parser for the same .conf; feed each the shape it expects.
  const { left, right, baselineMm } = camerasFromZedConf(parseConf(CONF), 'HD',
    { position: [0, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] });   // left eye at the origin, world axes
  const calib = calibFor(parseZedConf(CONF), 2560, 720);
  assert.deepEqual(calib.rot, [-0.0009, 0.0021, 0.0004], 'the rotation really is in play');
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib,
                                 ext: { posCm: [0, 0, 0], rotDeg: [0, 0, 0] }, label: 'zed' });
  const worst = (A, B) => Math.max(...A.map((v, i) => Math.abs(v - B[i])));
  assert.ok(worst(views[0].pose.R, left.R) < 1e-12, 'left eye agrees');
  // Both directions look like a perfectly good rotation; only ONE of them is the camera the .conf
  // describes. Applied backwards it cost 4.6 mrad, i.e. a systematic 5.7 mm of depth at 380 mm.
  assert.ok(worst(views[1].pose.R, right.R) < 1e-12,
    `right eye agrees (worst element ${worst(views[1].pose.R, right.R)})`);

  // The round trip is the check a compensating sign error cannot pass: project a known point through
  // calibrate.js's pair, triangulate those pixels through stereo.js's rays, land back on the point.
  for (const pMm of [[0, 0, 300], [40, -25, 380], [-60, 30, 500]]) {
    const a = left.project(pMm), b = right.project(pMm);
    const got = triangulateLocal([views[0].ray(a.u / calib.eyeW, a.v / calib.eyeH),
                                  views[1].ray(b.u / calib.eyeW, b.v / calib.eyeH)]);
    const err = Math.hypot(got[0] - pMm[0] / 10, got[1] - pMm[1] / 10, got[2] - pMm[2] / 10) * 10;
    assert.ok(err < 0.05, `${pMm} recovered to ${err.toFixed(4)} mm`);
  }
  assert.ok(Math.abs(baselineMm / 10 - calib.baselineCm) < 1e-9, 'and the same baseline');
});
