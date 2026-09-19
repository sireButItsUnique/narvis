// The camera model: projection round trips, distortion, poses, and reading a ZED calibration file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PinholeCamera, makeCamera, intrinsicsFromFov, fovFromFocal } from '../public/js/track/camera.js';
import { parseZedConf, camerasFromZedConf, splitSbs } from '../public/js/track/calibrate.js';
import { dist, matVec, transpose, rodrigues, rodriguesInv, norm, sub } from '../public/js/track/linalg.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

test('intrinsics from a field of view match the datasheet numbers', () => {
  // Logitech C920: 78 degrees diagonal at 1920x1080 is about 1360 px of focal length.
  const K = intrinsicsFromFov({ width: 1920, height: 1080, fovDeg: 78, fovAxis: 'diagonal' });
  near(K.fx, 1360, 12, 'C920 focal px');
  near(fovFromFocal(K.fx, 1920), 70.4, 0.5, 'implied horizontal fov');
  const H = intrinsicsFromFov({ width: 1280, height: 720, fovDeg: 90, fovAxis: 'horizontal' });
  near(H.fx, 640, 1e-6, 'a 90 degree horizontal fov is exactly half the width');
});

test('project and unproject are inverses for a posed camera', () => {
  const cam = makeCamera({ id: 'c', position: [120, 300, 450], target: [0, -150, 0], fovDeg: 78,
                           width: 1280, height: 720 });
  for (const p of [[0, -150, 0], [80, -100, 60], [-200, -50, 120], [30, -220, -40]]) {
    const q = cam.project(p);
    assert.ok(q.inFront, 'point should be in front of the lens');
    const back = cam.unproject(q.u, q.v, q.depth);
    near(dist(back, p), 0, 1e-6, 'unproject(project(p))');
  }
});

test('a ray through a pixel passes through the point that made it', () => {
  const cam = makeCamera({ id: 'c', position: [-200, 100, 300], target: [0, 0, 0], fovDeg: 70 });
  const p = [50, -30, 80];
  const { u, v } = cam.project(p);
  const { o, d } = cam.ray(u, v);
  const t = (p[1] - o[1]) / d[1];
  near(dist([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], p), 0, 1e-6, 'ray hits the point');
  near(norm(d), 1, 1e-12, 'ray direction is a unit vector');
});

test('distortion round trips through the iterative inverse', () => {
  const cam = new PinholeCamera({ id: 'd', width: 1280, height: 720, fx: 700, fy: 700, cx: 640, cy: 360,
                                  dist: { k1: -0.17, k2: 0.028, k3: -0.002, p1: 0.0006, p2: -0.0004 } });
  for (const [x, y] of [[0, 0], [0.3, -0.2], [-0.45, 0.4], [0.6, 0.55]]) {
    const [xd, yd] = cam.distortNormalized(x, y);
    const [xu, yu] = cam.undistortNormalized(xd, yd);
    near(Math.hypot(xu - x, yu - y), 0, 1e-7, 'undistort(distort(x))');
  }
  // With distortion on, project -> unproject must still be exact, because unproject undistorts first.
  const p = [200, 150, 900];
  const q = cam.project(p);
  near(dist(cam.unproject(q.u, q.v, q.depth), p), 0, 1e-5, 'round trip with a distorted lens');
});

test('pose as R,t round trips and the axes point where they should', () => {
  const cam = makeCamera({ id: 'c', position: [0, 200, 500], target: [0, 0, 0], fovDeg: 70 });
  const R = cam.R, t = cam.t;
  const other = new PinholeCamera({ id: 'o', width: cam.width, height: cam.height, fx: cam.fx, fy: cam.fy,
                                    cx: cam.cx, cy: cam.cy }).setPoseFromRt(R, t);
  near(dist(other.position, cam.position), 0, 1e-9, 'position recovered from R,t');
  // +Z is forward (toward the target), +Y is down in the image.
  const fwd = cam.forward;
  const toTarget = sub([0, 0, 0], cam.position);
  const cos = (fwd[0] * toTarget[0] + fwd[1] * toTarget[1] + fwd[2] * toTarget[2]) / norm(toTarget);
  near(cos, 1, 1e-9, 'forward points at the target');
  assert.ok(cam.down[1] < 0, 'image +y is world-down for an upright camera');
});

test('Rodrigues round trips including near 180 degrees', () => {
  for (const r of [[0, 0, 0], [0.4, -0.2, 0.9], [Math.PI - 1e-4, 0, 0], [0, 3.1415, 0]]) {
    const back = rodriguesInv(rodrigues(r));
    const R1 = rodrigues(r), R2 = rodrigues(back);
    for (let i = 0; i < 9; i++) near(R1[i], R2[i], 1e-6, 'rotation matrix round trip');
  }
});

test('a ZED calibration file gives two posed cameras one baseline apart', () => {
  const conf = `[LEFT_CAM_HD]
fx=525.3
fy=525.1
cx=641.2
cy=361.8
k1=-0.171
k2=0.0261
k3=-0.0011
p1=0.0002
p2=-0.0003

[RIGHT_CAM_HD]
fx=524.8
fy=524.6
cx=639.4
cy=359.1
k1=-0.169
k2=0.0255
k3=-0.0010
p1=0.0001
p2=-0.0002

[STEREO]
Baseline=119.97
CV_HD=0.0021
RX_HD=-0.0008
RZ_HD=0.0004
`;
  const parsed = parseZedConf(conf);
  assert.ok(parsed.resolutions.HD, 'HD section parsed');
  near(parsed.resolutions.HD.left.fx, 525.3, 1e-9);
  near(parsed.resolutions.HD.baselineMm, 119.97, 1e-9);
  near(parsed.resolutions.HD.ry, 0.0021, 1e-9, 'CV is read as the convergence angle');

  const { left, right, baselineMm } = camerasFromZedConf(parsed, 'HD', { position: [0, 250, 260], target: [0, -120, 0] });
  near(dist(left.position, right.position), baselineMm, 1e-6, 'the eyes are one baseline apart');
  assert.equal(left.width, 1280);
  // The right eye sits along the left eye's +X (to its right), not somewhere random.
  const offset = sub(right.position, left.position);
  near(offset[0] * left.right[0] + offset[1] * left.right[1] + offset[2] * left.right[2], baselineMm, 1e-6,
    'offset is along the left camera x axis');

  const halves = splitSbs(2560, 720);
  assert.deepEqual(halves.right, { x: 1280, y: 0, width: 1280, height: 720 });
});
