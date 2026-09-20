import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLACEMENT, HEAD_RANGE, zedPosition, zedCentre, tiltForPoint, aimTilt, zedExtrinsics, zedAxes, zedCalib,
  projectZed, sheetBlocks, checkPlacement, depthErrorCmPerPx, describe as describePlacement, ZED_NEAR_CM,
} from '../public/js/rig/zed-place.js';
import { viewsForCamera, triangulate, residualCm } from '../public/js/input/stereo.js';

// The ZED is not mounted: it stands on the base, centred, a few centimetres of its own body above the
// board, looking UP at the face. Every test here is about that one sentence being true in numbers — the
// sign of the tilt, the eye landing in both images, and the pixels coming back as the point they started as.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('the lens sits below the sheet, because the sheet stands on the same board', () => {
  const p = zedPosition(), c = zedCentre();
  assert.equal(c[0], 0, 'the camera is centred left to right');
  assert.equal(p[0], 6, 'so its LEFT lens is half a 12 cm baseline over, on the +X side');
  // 3 cm of camera body on a board 15.2 cm under the acrylic
  assert.ok(Math.abs(p[1] - (3 - 15.2)) < 1e-9, `lens y ${p[1]}`);
  assert.ok(p[1] < 0, 'the lens is under the sheet plane, looking up');
  assert.ok(p[2] > 20, 'and forward of the sheet edge, not under the acrylic');
});

test('a positive tilt is an UP tilt — the axis lifts toward the face', () => {
  const ext = zedExtrinsics();
  assert.ok(ext.tiltDeg > 0, `tilt ${ext.tiltDeg}`);
  const ax = zedAxes(ext);
  assert.ok(ax.forward[1] > 0, 'the optical axis points up');
  assert.ok(ax.forward[2] > 0, 'and toward the viewer');
  // the roll of 180 is what makes the image's left the viewer's right
  assert.ok(ax.right[0] < 0, 'camera +x (image right) runs to the viewer’s left');
  assert.ok(ax.down[1] < 0, 'camera +y (image down) runs down the rig');
});

test('aiming at one head position is what tips the others out of frame', () => {
  const near = tiltForPoint(DEFAULT_PLACEMENT, HEAD_RANGE[0]);   // leaning in
  const far = tiltForPoint(DEFAULT_PLACEMENT, HEAD_RANGE[1]);    // sitting back
  assert.ok(near - far > 20, `the two ends of the head range are ${(near - far).toFixed(0)} deg apart`);
  const mid = aimTilt(DEFAULT_PLACEMENT);
  assert.ok(mid < near && mid > far, 'the aim lands between them');

  const calib = zedCalib();
  const aimedNear = zedExtrinsics({ tiltDeg: near });
  const off = HEAD_RANGE.filter(e => !projectZed(aimedNear, calib, e).both);
  assert.ok(off.length > 0, 'aimed at the near head, at least one other position is gone');
  const aimed = zedExtrinsics();
  for (const e of HEAD_RANGE) {
    assert.ok(projectZed(aimed, calib, e).both, `aimed at the middle, ${e} is still in both eyes`);
  }
});

test('the default placement is one the page can recommend as it stands', () => {
  const v = checkPlacement();
  assert.deepEqual(v.warnings, [], v.warnings.join('; '));
  assert.ok(v.ok);
  assert.ok(v.worstMarginPx > 40, `closest any head gets to the frame edge: ${v.worstMarginPx.toFixed(0)} px`);
  for (const r of v.rows) {
    assert.ok(r.distCm > ZED_NEAR_CM, `${r.eye} at ${r.distCm.toFixed(0)} cm is past the near limit`);
    assert.ok(!r.blocked, 'no sightline crosses the acrylic');
  }
});

test('pixels out and a point back in: the extrinsics the page uses round-trip through the ray path', () => {
  const ext = zedExtrinsics(), calib = zedCalib();
  for (const eye of HEAD_RANGE) {
    const pr = projectZed(ext, calib, eye);
    const views = viewsForCamera({ width: DEFAULT_PLACEMENT.width, height: DEFAULT_PLACEMENT.height,
                                   sbs: true, calib, ext, label: 'zed' });
    const rays = [views[0].ray(pr.left.u, pr.left.v), views[1].ray(pr.right.u, pr.right.v)];
    const p = triangulate(rays);
    assert.ok(p, 'the pair triangulates');
    assert.ok(dist(p, eye) < 0.05, `${eye} came back as ${p.map(n => n.toFixed(2))} (${dist(p, eye).toFixed(3)} cm out)`);
    assert.ok(residualCm(p, rays) < 0.01, 'and the two rays actually meet there');
  }
});

test('the tilt sign is not free: propping it the other way loses the head entirely', () => {
  const right = zedExtrinsics(), calib = zedCalib();
  const wrong = { ...right, rotDeg: [-right.tiltDeg, 0, 180] };
  const eye = HEAD_RANGE[1];
  assert.ok(projectZed(right, calib, eye).both, 'the right way round sees it');
  assert.ok(!projectZed(wrong, calib, eye).both, 'the wrong way round does not');

  // and a tilt that is merely wrong, not inverted, moves the answer by a knowable amount: 5 degrees of
  // unmeasured prop is ~8 cm of eye at arm's length, which is what the one-key aim exists to remove.
  const off5 = zedExtrinsics({ tiltDeg: right.tiltDeg + 5 });
  const pr = projectZed(right, calib, eye);
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib, ext: off5, label: 'zed' });
  const p = triangulate([views[0].ray(pr.left.u, pr.left.v), views[1].ray(pr.right.u, pr.right.v)]);
  const err = dist(p, eye);
  assert.ok(err > 4 && err < 15, `5 deg of tilt error moved the eye ${err.toFixed(1)} cm`);
});

test('one pixel of landmark noise is worth this many millimetres of depth, and the page says so', () => {
  const calib = zedCalib();
  // z^2 / (f * b): 700 px and a 12 cm baseline at 80 cm is about 7.6 mm per pixel
  const perPx = depthErrorCmPerPx(calib, 80);
  assert.ok(perPx > 0.6 && perPx < 0.9, `${(perPx * 10).toFixed(1)} mm per px at 80 cm`);
  assert.ok(depthErrorCmPerPx(calib, 160) > 3 * perPx, 'and it grows as the square of the distance');

  // the same thing measured rather than predicted: push a pixel of noise through the real ray path
  const ext = zedExtrinsics();
  const eye = [0, 35, 58];
  const pr = projectZed(ext, calib, eye);
  const views = viewsForCamera({ width: 2560, height: 720, sbs: true, calib, ext, label: 'zed' });
  const nudged = triangulate([views[0].ray(pr.left.u + 1 / calib.eyeW, pr.left.v), views[1].ray(pr.right.u, pr.right.v)]);
  const moved = dist(nudged, eye);
  const predicted = depthErrorCmPerPx(calib, pr.distCm);
  assert.ok(moved > predicted * 0.5 && moved < predicted * 2,
    `1 px moved the eye ${moved.toFixed(2)} cm against a prediction of ${predicted.toFixed(2)} cm`);
});

test('a ZED pushed back under the acrylic is caught, not quietly refracted', () => {
  const ext = zedExtrinsics({ zCm: 0 });        // under the middle of the sheet
  assert.ok(sheetBlocks(ext, [0, 35, 58]), 'the sightline crosses the sheet');
  const v = checkPlacement({ zCm: 0 });
  assert.ok(v.warnings.some(w => /acrylic/.test(w)), v.warnings.join('; '));

  // The placement as built does not — and neither does one a few centimetres behind the edge, because a
  // lens this low is already looking steeply up: from z = 8 the sightline clears y = 0 at about z = 21,
  // past the sheet. That margin is why the ZED need not be shoved to the very front of the board.
  assert.ok(!sheetBlocks(zedExtrinsics(), [0, 35, 58]));
  assert.ok(!sheetBlocks(zedExtrinsics({ zCm: 8 }), [0, 35, 58]));
});

test('a taller sheet drops the camera further below the rig, and the aim follows it up', () => {
  const tall = checkPlacement({ sheetHeightCm: 25 });
  assert.ok(tall.posCm[1] < zedPosition()[1], 'the lens is further under the sheet');
  assert.ok(tall.tiltDeg > zedExtrinsics().tiltDeg, 'so it has to look up harder');
  assert.ok(/tilted up/.test(describePlacement({ sheetHeightCm: 25 })));
});

test('the ZED on the floor instead of the base costs depth, and the number says how much', () => {
  // 74 cm of table under the rig, i.e. the camera on the floor looking up at a seated head
  const v = checkPlacement({ sheetHeightCm: 15.2 + 74 });
  assert.ok(v.rows.every(r => r.distCm > 120), 'every head position is more than a metre away');
  const onBase = checkPlacement();
  const near = Math.max(...onBase.rows.map(r => depthErrorCmPerPx(onBase.calib, r.distCm)));
  const far = Math.max(...v.rows.map(r => depthErrorCmPerPx(v.calib, r.distCm)));
  assert.ok(far > 3 * near,
    `a pixel of noise is worth ${(far * 10).toFixed(0)} mm from the floor against ${(near * 10).toFixed(0)} mm on the base`);
});
