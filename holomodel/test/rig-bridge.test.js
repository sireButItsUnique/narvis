// SPDX-License-Identifier: GPL-3.0-or-later
// The bridge, end to end, with no ZED and no browser:  node --test bridge.test.js
//
// Three joins are tested here, because each is a place a sign can be wrong and nothing would crash:
//   1. Python -> page: headtrack.py / fuse3d.py triangulate in the ZED's frame (metres, +Y up, -Z out of the
//      lens). The page places that in the rig. A rig point pushed out to pixels, triangulated the way Python
//      does it, and placed the way the page does it, has to come back to where it started.
//   2. the wire: a `head` message, with and without an eye.
//   3. the optics: the pixel the page lights for a hand joint, followed physically — off the panel, off the
//      sheet, to the eye — has to arrive along the line from the eye to the REAL joint. That is what "the
//      drawn hand sits on my hand" means, and it is checked from several seats because being right from one
//      is easy.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBridgeMessage, zedToCam } from '../public/js/input/zed-client.js';
import { camToWorld, rotMatrix, matVec3, transpose3 } from '../public/js/input/stereo.js';
import * as ZP from '../public/js/rig/zed-place.js';
import * as RT from '../public/js/rig/rig-setup.js';
import { rigCamera, projectToMonitor, reflectPoint, planeOf, lineDist, sub, dist } from '../public/js/rig/geometry.js';
import { boneTransform, BONES, scaleAboutLens, validHandTune } from '../public/js/rig/hands.js';

const setup = RT.mergeSetup(null);
setup.pair.tiltUpDeg = 18;                       // a camera that sees the slot AND the face (see README)
const placement = { sheetHeightCm: setup.rig.baseDropCm, lensHeightCm: setup.rig.baseDropCm + setup.pair.heightCm,
                    xCm: 0, zCm: setup.pair.depthCm, baselineCm: 12, tiltDeg: setup.pair.tiltUpDeg };
const ext = ZP.zedExtrinsics(placement);
const rig = RT.rigFromSetup(setup);

// What headtrack.triangulate_point and fuse3d.rays_from_pixels do, transcribed: rectified pinhole views,
// the right lens one baseline along the camera's +x, the answer in metres with +Y up and -Z out of the lens.
const K = { fx: 523.8, fy: 523.8, cx: 640, cy: 360, baselineM: 0.12 };
function pythonTriangulate(rigPoint) {
  const DEG = Math.PI / 180;
  const camFromRig = transpose3(rotMatrix(ext.rotDeg.map(a => a * DEG)));
  const c = matVec3(camFromRig, sub(rigPoint, ext.posCm)).map(v => v / 100);   // OpenCV metres: y down, z out
  const pix = x0 => [K.cx + K.fx * (c[0] - x0) / c[2], K.cy + K.fy * c[1] / c[2]];
  const l = pix(0), r = pix(K.baselineM);
  const depth = K.fx * K.baselineM / (l[0] - r[0]);
  return [(l[0] - K.cx) * depth / K.fx, -(l[1] - K.cy) * depth / K.fy, -depth];
}
const pageToRig = zedMetres => camToWorld(zedToCam(zedMetres), ext);

test('a rig point survives Python\'s frame and the page\'s placement', () => {
  for (const p of [[0, -6, 8], [-9, -11, 14], [7, -3, -2], [0, 39.5, 45.5], [-18, 35, 58]]) {
    const back = pageToRig(pythonTriangulate(p));
    assert.ok(dist(back, p) < 1e-6, `${p} came back as ${back.map(n => n.toFixed(3))}`);
  }
});

test('the camera is facing the viewer: its +x is the viewer\'s left, its far is the viewer\'s near', () => {
  const lens = ext.posCm;
  const ahead = pageToRig([0, 0, -0.30]);                  // 30 cm straight out of the left lens
  assert.ok(ahead[2] > lens[2] + 25 && ahead[1] > lens[1], 'out of the lens is toward the viewer, and up');
  const toCamerasRight = pageToRig([0.10, 0, -0.30]);
  assert.ok(toCamerasRight[0] < ahead[0], 'the camera\'s right is the viewer\'s left');
  const up = pageToRig([0, 0.10, -0.30]);
  assert.ok(up[1] > ahead[1], 'up is up');
});

test('a head message carries an eye, or says why not', () => {
  const ok = parseBridgeMessage(JSON.stringify({ t: 'head', seq: 3, ts: 1.5, eye: [0.01, 0.4, -0.6], ipd: 0.063, src: 'stereo' }));
  assert.equal(ok.kind, 'head');
  assert.deepEqual(ok.eye, [0.01, 0.4, -0.6]);
  assert.deepEqual(zedToCam(ok.eye), [1, -40, 60]);
  const none = parseBridgeMessage(JSON.stringify({ t: 'head', seq: 4, ts: 1.6, eye: null, ipd: null, src: 'no face in the right view' }));
  assert.equal(none.kind, 'head');
  assert.equal(none.eye, null);
  assert.equal(none.src, 'no face in the right view');
  assert.equal(parseBridgeMessage(JSON.stringify({ t: 'head', eye: [1, 'x', 3] })).eye, null);
});

test('the lit pixel, followed off the panel and off the sheet, arrives along the line to the real joint', () => {
  const sheet = planeOf(rig.sheet);
  const seats = [setup.head.positionCm, [-15, 36, 50], [14, 44, 40], [0, 30, 62]];
  const joints = [[0, -5, 6], [-6, -9, 10], [8, -3, 2], [3, -12, 15], [-2, -7, -4]];
  let drawable = 0;
  for (const eye of seats) {
    const rc = rigCamera(rig, eye);
    for (const j of joints) {
      const pm = projectToMonitor(rig, rc, j);
      if (!pm.inside) continue;                              // off the panel: nothing is lit, nothing to check
      drawable++;
      const seenAt = reflectPoint(sheet, pm.point);          // where that pixel appears to be
      const miss = lineDist(seenAt, eye, sub(j, eye));
      assert.ok(miss < 1e-6, `eye ${eye} joint ${j}: the pixel appears ${miss.toFixed(4)} cm off the sightline`);
    }
  }
  assert.ok(drawable >= 8, `only ${drawable} of ${seats.length * joints.length} joints fell on the panel at all`);
});

test('a camera pose error moves head and hand together, so the overlay moves less than either', () => {
  // The camera is really 3 cm further back than the page believes. Both measurements are placed 3 cm too
  // far forward. Compare what that does to the overlay with what the same error would do to the hand alone.
  const believed = ext, truth = { ...ext, posCm: [ext.posCm[0], ext.posCm[1], ext.posCm[2] - 3] };
  const eyeTrue = setup.head.positionCm, jointTrue = [0, -6, 8];
  const asMeasured = p => { const DEG = Math.PI / 180;
    const c = matVec3(transpose3(rotMatrix(truth.rotDeg.map(a => a * DEG))), sub(p, truth.posCm));
    return camToWorld(c, believed); };
  const sheet = planeOf(rig.sheet);
  const missFor = (eyeUsed, jointUsed) => {
    const pm = projectToMonitor(rig, rigCamera(rig, eyeUsed), jointUsed);
    return lineDist(reflectPoint(sheet, pm.point), eyeTrue, sub(jointTrue, eyeTrue));
  };
  const together = missFor(asMeasured(eyeTrue), asMeasured(jointTrue));
  const handOnly = missFor(eyeTrue, asMeasured(jointTrue));
  assert.ok(together < handOnly, `together ${together.toFixed(2)} cm, hand alone ${handOnly.toFixed(2)} cm`);
  assert.ok(together < 3, `a 3 cm pose error should show as less than 3 cm: ${together.toFixed(2)}`);
});

test('scaling about the lens pulls an over-far hand back along its own sightline, and tames its motion', () => {
  // The hand is really at 25 cm; its distance was over-estimated by 20%, so every coordinate is 1.2x.
  const real = [[3, 2, 25], [8, 2, 25]], seen = real.map(p => p.map(v => v * 1.2));
  const fixed = seen.map(p => scaleAboutLens(p, 1 / 1.2));
  fixed.forEach((p, i) => assert.ok(dist(p, real[i]) < 1e-9));
  assert.ok(Math.abs((seen[1][0] - seen[0][0]) - 6) < 1e-9, 'a 5 cm move was being drawn as 6');
  assert.ok(Math.abs((fixed[1][0] - fixed[0][0]) - 5) < 1e-9);
  // the lens itself does not move, which is what makes it a scale ABOUT the lens
  assert.deepEqual(scaleAboutLens([0, 0, 0], 0.8), [0, 0, 0]);
  assert.deepEqual(validHandTune({ offsetCm: [1, 'x', 3], scale: 1 }), { offsetCm: [0, 0, 0], scale: 1 });
  assert.deepEqual(validHandTune({ offsetCm: [1, -2, 3], scale: 0.9 }), { offsetCm: [1, -2, 3], scale: 0.9 });
  assert.deepEqual(validHandTune({ offsetCm: [0, 0, 0], scale: 40 }), { offsetCm: [0, 0, 0], scale: 1 });
});

test('bones join the joints they name', () => {
  assert.equal(BONES.length, 21);
  const t = boneTransform([0, 0, 0], [0, 3, 4]);
  assert.deepEqual(t.mid, [0, 1.5, 2]);
  assert.equal(t.len, 5);
  assert.deepEqual(t.dir, [0, 0.6, 0.8]);
  assert.deepEqual(boneTransform([1, 1, 1], [1, 1, 1]).dir, [0, 1, 0]);
});

// ---------------------------------------------------------------- a setup saved by an older page

test('a setup saved by the page as it shipped comes back as the rig as built, not as the old guesses', async () => {
  const RT = await import('../public/js/rig/rig-setup.js');
  // what the shipped page wrote to localStorage on its first run: a 24 inch panel, inches, the mat 6 inches
  // down, and the ZED at the FRONT edge of the sheet. Every one of these outlived versions 5 and 6.
  const shipped = { version: 4, units: 'in',
    rig: { monitorDiagIn: 24, tiltDeg: 45, monitorDropCm: 15.24, monitorForwardCm: 0, baseDropCm: 15.24 },
    pair: { baselineCm: 12, heightCm: -12.24, depthCm: 22, tiltUpDeg: 31.2, aimManual: false },
    head: { positionCm: [0, 40, 45] }, trimCm: [0, -3, 2], handTune: { offsetCm: [0, 9, -4], scale: 1.3 },
    cameras: { left: { deviceId: 'abc', label: 'ZED 2' }, right: null } };
  for (const version of [4, 5, 6]) {
    const got = RT.mergeSetup({ ...shipped, version });
    assert.equal(got.version, RT.SETUP_VERSION);
    assert.deepEqual(got.rig, RT.DEFAULT_SETUP.rig, `rig numbers, saved as version ${version}`);
    assert.equal(got.pair.depthCm, RT.DEFAULT_SETUP.pair.depthCm);
    assert.ok(got.pair.depthCm < 0, 'the ZED stands BEHIND the sheet centre, under the panel');
    assert.equal(got.pair.heightCm, RT.DEFAULT_SETUP.pair.heightCm);
    assert.equal(got.pair.tiltUpDeg, 15);
    assert.deepEqual(got.head, RT.DEFAULT_SETUP.head);
    assert.deepEqual(got.trimCm, [0, 0, 0]);
    assert.deepEqual(got.handTune, { offsetCm: [0, 0, 0], scale: 1 });
    assert.equal(got.units, 'cm');
    assert.equal(got.cameras.left.deviceId, 'abc', 'the camera choice describes the PC, not the rig: kept');
  }
  // ...and the defaults it falls back to must not be aliased: editing a loaded setup cannot edit DEFAULT_SETUP
  const a = RT.mergeSetup({ ...shipped }); a.rig.monitorDiagIn = 99; a.head.positionCm[0] = 99;
  assert.equal(RT.DEFAULT_SETUP.rig.monitorDiagIn, 27);
  assert.equal(RT.DEFAULT_SETUP.head.positionCm[0], 0);
});

test('what is typed from version 7 on is kept', async () => {
  const RT = await import('../public/js/rig/rig-setup.js');
  const mine = RT.mergeSetup(null);
  mine.pair.depthCm = -17.5; mine.rig.monitorForwardCm = 3; mine.handTune = { offsetCm: [0, 1, 0], scale: 1.05 };
  const back = RT.mergeSetup(JSON.parse(JSON.stringify(mine)));
  assert.equal(back.pair.depthCm, -17.5);
  assert.equal(back.rig.monitorForwardCm, 3);
  assert.deepEqual(back.handTune, { offsetCm: [0, 1, 0], scale: 1.05 });
});
