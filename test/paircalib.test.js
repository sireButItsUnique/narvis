// Calibrating the webcam pair from the user's own face, with no hardware.
//
// The whole claim of public/js/rig/paircalib.js is that a moving head is a calibration target: the two
// cameras never move, so every matched landmark from every pose obeys the same epipolar constraint, and
// enough poses pin the pair's relative rotation down to a fraction of a degree. That claim is checked here
// by building a rig whose pose we KNOW, projecting a face-shaped cloud of points through it with realistic
// pixel noise, running the real capture-and-solve path, and asking how far the answer is from the truth.
//
// The refusals matter as much as the answer. A calibration that quietly accepts a bad solve is worse than
// no calibration at all - it replaces "the angles are a guess" with "the angles are measured", and the
// hologram still swims. So there is a test per refusal, each one built by breaking exactly one thing.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE, SOLVE, CALIB_LANDMARKS, IRIS, makeCapture, binOf, solvePair, solveLines, captureLines,
  cameraFromExt, lensOnly, rotFromDeg, degFromRot, packLm, lmAt, headUV, faceCentre,
  makeHoldCheck, angleBetweenDeg, rotationDeltaDeg, HOLD,
} from '../public/js/rig/paircalib.js';
import { matMul, transpose } from '../public/js/track/linalg.js';
import {
  mergeSetup, saveSetup, loadSetup, SETUP_KEY, pairCameras, pairAngles, solvedPose, poseStatus,
  applySolvedPose, aimCheck, DEFAULT_SETUP,
} from '../public/js/rig/rigtest2.js';
import { mulberry32, gaussian } from '../public/js/track/linalg.js';
import { viewsForCamera, triangulate, residualCm } from '../public/js/input/stereo.js';
import { focalPxFromDiagFov } from '../public/js/input/devices.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- a rig we know the answer to

// The user's rig: two 1080p webcams 40 inches apart at sheet height, angled in at a head that sits about
// 45 cm out and 40 cm up. The TRUE angles are deliberately a couple of degrees off what aimPair() would
// derive from "roughly where I sit", because that difference is the entire reason this code exists.
const TRUTH = {
  baselineCm: 101.6,
  left: { posCm: [-50.8, 0, 0], rotDeg: [29.2, -46.4, 179.1] },
  right: { posCm: [50.8, 0, 0], rotDeg: [31.4, 47.9, 180.6] },
  width: 1280, height: 720, dfovDeg: 78,
};
const TYPED = { toeInDeg: 48.5, tiltUpDeg: 30.5 };      // what aimPair() gives for head (0, 40, 45)

const trueCams = () => [cameraFromExt({ ...TRUTH.left, ...TRUTH, id: 'L' }),
                        cameraFromExt({ ...TRUTH.right, ...TRUTH, id: 'R' })];
const lenses = () => [lensOnly({ ...TRUTH, id: 'L' }), lensOnly({ ...TRUTH, id: 'R' })];

// A face-shaped cloud: 478 points on an ellipsoid about 14 cm wide, 20 cm tall and 9 cm deep, with the two
// iris centres where MediaPipe puts them. Same index = same physical point, which is the property the whole
// method rests on.
function faceModel() {
  const rng = mulberry32(99), pts = [];
  for (let i = 0; i < 478; i++) {
    const a = rng() * Math.PI * 2, b = Math.acos(2 * rng() - 1);
    pts.push([7 * Math.sin(b) * Math.cos(a), 10 * Math.cos(b), 4.5 * Math.sin(b) * Math.sin(a)]);
  }
  pts[IRIS[0]] = [-3.15, 0, 4.0];
  pts[IRIS[1]] = [3.15, 0, 4.0];
  return pts;
}
const FACE = faceModel();

// The head at one place, with a little yaw and pitch: a person moving about does not hold their head like a
// bolted target, and the solve must not need them to.
function headAt(centre, yawDeg, pitchDeg) {
  const cy = Math.cos(yawDeg * DEG), sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG);
  return FACE.map(p => {
    const x = p[0] * cy + p[2] * sy, z = -p[0] * sy + p[2] * cy;        // yaw about Y
    const y = p[1] * cp - z * sp, z2 = p[1] * sp + z * cp;              // pitch about X
    return [centre[0] + x, centre[1] + y, centre[2] + z2];
  });
}

// One frame: the mesh projected into both cameras, in the normalised coordinates MediaPipe reports.
function shoot(cams, world, rng, noisePx) {
  const out = [];
  for (const cam of cams) {
    const flat = new Float32Array(world.length * 2);
    let seen = 0;
    for (let i = 0; i < world.length; i++) {
      const p = cam.project(world[i]);
      if (!p.inFront) return null;
      flat[i * 2] = (p.u + gaussian(rng) * noisePx) / cam.width;
      flat[i * 2 + 1] = (p.v + gaussian(rng) * noisePx) / cam.height;
      if (p.inFrame) seen++;
    }
    if (seen < world.length * 0.6) return null;      // the face has to actually be in the picture
    out.push(flat);
  }
  return out;
}

// A whole session: the user moving their head round the working volume while both cameras watch.
function session({ noisePx = 0.5, seed = 7, poses = null, cams = null, capture = {} } = {}) {
  const rng = mulberry32(seed);
  const cs = cams || trueCams();
  const cap = makeCapture(capture);
  const list = poses || volumePoses();
  let t = 1000;
  for (const pose of list) {
    const shots = shoot(cs, headAt(pose.at, pose.yaw ?? 0, pose.pitch ?? 0), rng, noisePx);
    t += 100;
    if (!shots) continue;
    cap.add({ tA: t, tB: t + (rng() - 0.5) * 20, a: shots[0], b: shots[1] });
  }
  return cap;
}

// Where a person actually goes: a grid over the seat, not a sphere round a tripod.
function volumePoses() {
  const out = [];
  for (const x of [-16, -8, 0, 8, 16]) for (const y of [33, 40, 47]) for (const z of [36, 45, 54]) {
    out.push({ at: [x, y, z], yaw: x * 0.4, pitch: (40 - y) * 0.3 });
  }
  return out;
}

// ---------------------------------------------------------------- the conventions

test('rotDeg round-trips through the rotation this rig uses', () => {
  for (const d of [[0, 0, 180], [30.5, -48.5, 180], [-12, 7, 173], [0, 0, 0]]) {
    const back = degFromRot(rotFromDeg(d));
    for (let i = 0; i < 3; i++) near(back[i], d[i], 1e-6, `rotDeg[${i}]`);
  }
});

test('a camera built from posCm/rotDeg sees what stereo.js says it sees', () => {
  // paircalib and cameras.js must agree about what a pose MEANS, or a solved pose would be decoded by a
  // different convention than it was written in - which is the bug this whole page keeps catching.
  const ext = { posCm: TRUTH.left.posCm, rotDeg: TRUTH.left.rotDeg };
  const cam = cameraFromExt({ ...TRUTH.left, ...TRUTH });
  const f = focalPxFromDiagFov(TRUTH.width, TRUTH.height, TRUTH.dfovDeg);
  const view = viewsForCamera({ width: TRUTH.width, height: TRUTH.height, sbs: false, calib: null,
    intr: { fx: f, fy: f, cx: TRUTH.width / 2, cy: TRUTH.height / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
    ext, label: 'L' })[0];
  const P = [4, 41, 47];
  const pr = cam.project(P);
  const ray = view.ray(pr.u / TRUTH.width, pr.v / TRUTH.height);
  near(ray.origin[0], TRUTH.left.posCm[0], 1e-9, 'same lens centre');
  const want = [P[0] - ray.origin[0], P[1] - ray.origin[1], P[2] - ray.origin[2]];
  near(angleBetweenDeg(ray.dir, want), 0, 1e-4, 'same ray through the same pixel');
});

// ---------------------------------------------------------------- capture

test('the capture bins by where the head is, and says what is missing', () => {
  const cams = trueCams(), rng = mulberry32(3);
  const at = c => shoot(cams, headAt(c, 0, 0), rng, 0);
  const mid = at([0, 40, 45]), left = at([-14, 40, 45]), near_ = at([0, 40, 36]), high = at([0, 47, 45]);
  const bin = s => binOf(s[0], s[1]).cell;
  // The three axes have to move independently, or "move closer" would show up as "lean left".
  assert.deepEqual(bin(mid), [1, 1, 1], 'the seat is the middle cell');
  assert.equal(bin(left)[0], 2, 'moving to the viewer\'s left moves the lateral band up');
  assert.equal(bin(left)[1], 1, 'and leaves the depth band alone');
  assert.equal(bin(near_)[1], 0, 'moving closer to the rig moves the depth band down');
  assert.equal(bin(high)[2], 0, 'a higher head moves the height band down (image v runs down)');

  // 500 frames of one pose is one pose. The cap is what stops a corner owning the fit.
  const still = makeCapture();
  let t = 0, taken = 0;
  for (let i = 0; i < 500; i++) { t += 100; if (still.add({ tA: t, tB: t, a: mid[0], b: mid[1] }).ok) taken++; }
  assert.equal(taken, CAPTURE.perBin, 'one bin holds perBin frames and no more');
  const p = still.progress();
  assert.equal(p.ready, false, 'and a single pose is never ready to solve');
  assert.ok(p.missing.length >= 4, `it asks for the missing directions: ${p.missing.join(', ')}`);
  assert.ok(p.missing.some(m => /left|right/.test(m)) && p.missing.some(m => /closer|back/.test(m)),
    'in plain words');
  assert.ok(captureLines(p).join(' ').includes('still missing'), 'and on one line for the glass');
});

test('the capture refuses frames the two cameras cannot both speak for', () => {
  const cams = trueCams(), rng = mulberry32(4);
  const s = shoot(cams, headAt([0, 40, 45], 0, 0), rng, 0);
  const cap = makeCapture();
  assert.equal(cap.add({ tA: 1000, tB: 1000 + CAPTURE.maxSkewMs + 5, a: s[0], b: s[1] }).why, 'skew',
    'landmarks from different moments are not a correspondence');
  assert.equal(cap.add({ tA: 1000, tB: 1000, a: null, b: s[1] }).why, 'no-face', 'one camera saw nothing');
  assert.equal(cap.add({ tA: 1000, tB: 1000, a: s[0].slice(0, 20), b: s[1] }).why, 'short-mesh',
    'a stub of a mesh is not a face');
  assert.ok(cap.add({ tA: 2000, tB: 2005, a: s[0], b: s[1] }).ok, 'a matched pair is taken');
  assert.equal(cap.add({ tA: 2010, tB: 2015, a: s[0], b: s[1] }).why, 'too-soon',
    'two frames 10 ms apart are the same pose twice');
});

test('a full buffer still takes a direction it has never seen', () => {
  // The cap used to be checked BEFORE the bin, so once maxFrames frames were in, no new part of the volume
  // could ever be recorded. A user who filled the buffer without leaning back was then asked forever for
  // the one movement the capture was silently throwing away, behind a progress bar reading 100%.
  const cams = trueCams(), rng = mulberry32(51);
  const cap = makeCapture({ maxFrames: 40 });
  let t = 0;
  const feed = at => {
    const s = shoot(cams, headAt(at, 0, 0), rng, 0.3);
    t += 200;
    return s ? cap.add({ tA: t, tB: t, a: s[0], b: s[1] }) : { ok: false };
  };
  // fill up without ever moving back: a seated person leaning about in front of their chair
  for (let i = 0; i < 200 && cap.frames.length < 40; i++)
    feed([[-16, -8, 0, 8, 16][i % 5], [33, 40, 47][(i >> 2) % 3], [36, 45][(i >> 1) % 2]]);
  assert.equal(cap.frames.length, 40, 'the buffer is full');
  const stuck = cap.progress();
  assert.ok(stuck.missing.includes('move further back'), `it asks for the missing band: ${stuck.missing}`);
  assert.ok(stuck.fraction < 1, 'and the progress bar does not claim to be finished while it does');

  // the user does exactly what it asks
  let taken = 0;
  for (const x of [-16, -8, 0, 8, 16]) for (const y of [33, 40, 47]) if (feed([x, y, 54]).ok) taken++;
  assert.ok(taken > 0, 'the frames it asked for are recorded, not discarded');
  assert.equal(cap.frames.length, 40, 'without growing past the cap');
  const now = cap.progress();
  assert.equal(now.missing.includes('move further back'), false, 'and the instruction stops');
  assert.ok(now.evicted > 0 && now.binsFilled >= stuck.binsFilled, 'old views made room, none of the volume lost');
});

test('a capture that is enough to solve says so even while a direction is missing', () => {
  const poses = volumePoses().filter(p => p.at[2] < 54);        // never leans back
  const cap = session({ poses, seed: 53 });
  const p = cap.progress();
  assert.equal(p.ready, false, 'it is not a complete capture');
  assert.ok(p.solvable, 'but there is enough of it to solve');
  assert.match(captureLines(p).join(' '), /press Solve/, 'and the flag on the glass says so');
});

// ---------------------------------------------------------------- the solve

test('the pair is recovered to within a degree, and the head to within millimetres', () => {
  const cap = session({ noisePx: 0.5 });
  assert.ok(cap.progress().ready, `the synthetic session is a good capture: ${JSON.stringify(cap.progress())}`);

  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.ok(res.ok, `solved: ${solveLines(res).join(' | ')}`);

  // The angles. The toe-in is what the essential matrix really measures, and it is the one that moves the
  // head in depth; a degree of it is a centimetre at this range.
  const trueToe = (TRUTH.right.rotDeg[1] - TRUTH.left.rotDeg[1]) / 2;
  near(res.pose.toeInDeg, trueToe, 1.0, 'toe-in');
  // ...and the DIFFERENCE between the two cameras' tilts is measured too, even though their common tilt
  // is not: the pair in TRUTH is 2.2 degrees asymmetric and the solve has to see that.
  near(res.pose.right.rotDeg[0] - res.pose.left.rotDeg[0],
       TRUTH.right.rotDeg[0] - TRUTH.left.rotDeg[0], 1.0, 'difference in tilt between the two cameras');
  near(res.pose.right.rotDeg[2] - res.pose.left.rotDeg[2],
       TRUTH.right.rotDeg[2] - TRUTH.left.rotDeg[2], 1.5, 'difference in roll between the two cameras');

  // The scale comes from the tape measure and nowhere else, and it has to be said out loud.
  assert.deepEqual(res.pose.left.posCm, [-TRUTH.baselineCm / 2, 0, 0], 'left camera, symmetric');
  assert.deepEqual(res.pose.right.posCm, [TRUTH.baselineCm / 2, 0, 0], 'right camera, symmetric');
  assert.match(res.pose.scaleFrom, /measured baseline/, 'the scale says where it came from');
  assert.equal(res.pose.tiltFromTyped, true, 'and the common tilt says it was not measured');
  assert.ok(solveLines(res).some(l => /cannot set it/.test(l)), 'the report says so too');

  // And the number that matters: where the pair puts a head, with the solved extrinsics decoded by the
  // app's own stereo.js rather than by paircalib's maths. Anything else would be marking its own homework.
  // The truth to compare against is the EYE (the iris the tracker follows), not the centre of the head -
  // they are 4 cm apart, which is bigger than everything being measured here.
  const rng = mulberry32(31);
  let worst = 0, worstTyped = 0;
  const typedPose = { left: { posCm: [-50.8, 0, 0], rotDeg: [TYPED.tiltUpDeg, -TYPED.toeInDeg, 180] },
                      right: { posCm: [50.8, 0, 0], rotDeg: [TYPED.tiltUpDeg, TYPED.toeInDeg, 180] } };
  for (const at of [[0, 40, 45], [-14, 36, 52], [13, 45, 38], [6, 33, 50]]) {
    const world = headAt(at, 0, 0);
    const eye = world[IRIS[0]];
    const shots = shoot(trueCams(), world, rng, 0.4);
    const p = eyeFromViews(res.pose, shots, IRIS[0]);
    worst = Math.max(worst, Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]));
    const q = eyeFromViews(typedPose, shots, IRIS[0]);
    worstTyped = Math.max(worstTyped, Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]));
  }
  assert.ok(worst < 0.6, `the solved pair puts a known eye within ${(worst * 10).toFixed(1)} mm`);
  // ...and this is the whole point: the DERIVED angles, off by only 1.4 degrees of toe-in, put the same
  // eye centimetres away. That error is not constant over the volume, so no trim can take it out.
  assert.ok(worstTyped > 3 * worst,
    `the derived angles miss by ${(worstTyped * 10).toFixed(0)} mm where the measured pose misses ${(worst * 10).toFixed(1)} mm`);

  // The residual is reported in millimetres, because that is the number a person can judge.
  assert.ok(res.report.residualMm >= 0 && res.report.residualMm < 8,
    `residual ${res.report.residualMm} mm`);
  assert.ok(res.report.inlierRatio > 0.9, `inlier ratio ${res.report.inlierRatio}`);
});

// Where the app itself would put the eye, given a solved pose: stereo.js views, stereo.js triangulation.
function eyeFromViews(pose, shots, index = null) {
  const f = focalPxFromDiagFov(TRUTH.width, TRUTH.height, TRUTH.dfovDeg);
  const intr = { fx: f, fy: f, cx: TRUTH.width / 2, cy: TRUTH.height / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  const mk = side => viewsForCamera({ width: TRUTH.width, height: TRUTH.height, sbs: false, calib: null,
    intr, ext: { posCm: pose[side].posCm, rotDeg: pose[side].rotDeg }, label: side })[0];
  const [va, vb] = [mk('left'), mk('right')];
  const ua = index == null ? headUV(shots[0]) : lmAt(shots[0], index);
  const ub = index == null ? headUV(shots[1]) : lmAt(shots[1], index);
  return triangulate([va.ray(ua[0], ua[1]), vb.ray(ub[0], ub[1])]);
}

test('the scale comes from the measured baseline and scales everything with it', () => {
  const cap = session({ noisePx: 0.3, seed: 11 });
  const [ca, cb] = lenses();
  const one = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  const twice = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm * 2, typed: TYPED });
  assert.ok(one.ok && twice.ok, 'both solve');
  // Double the tape measure and the geometry is identical, twice the size: the angles do not move at all
  // and every distance does. That is what "scale is not observable" means in practice.
  near(twice.pose.toeInDeg, one.pose.toeInDeg, 1e-6, 'the angles do not depend on the scale');
  near(twice.pose.right.posCm[0], one.pose.right.posCm[0] * 2, 1e-9, 'and the positions do');
  near(twice.report.medianDepthCm, one.report.medianDepthCm * 2, 0.15, 'so does where the head lands');
});

test('the answer is measured against the truth, not against itself', () => {
  // The old version of this test compared one solve against another at a tolerance of 1.0 degrees - wider
  // than the 1.4 degrees of error the whole feature exists to remove, so it could not have failed. Every
  // seed is checked against the pose the synthetic rig was BUILT with instead.
  const trueToe = (TRUTH.right.rotDeg[1] - TRUTH.left.rotDeg[1]) / 2;
  const trueRel = relRotDeg(TRUTH.left.rotDeg, TRUTH.right.rotDeg);
  for (const seed of [7, 11, 21, 29]) {
    const cap = session({ noisePx: 0.5, seed });
    const [ca, cb] = lenses();
    const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
    assert.ok(res.ok, `seed ${seed} solves: ${solveLines(res).join(' | ')}`);
    near(res.pose.toeInDeg, trueToe, 0.25, `seed ${seed} toe-in against the truth`);
    // The toe-in is only the MEAN of the two yaws, so it can be right while the pair is wrong. The whole
    // relative rotation is what the essential matrix actually measures, and it is what moves the head.
    const rel = relRotDeg(res.pose.left.rotDeg, res.pose.right.rotDeg);
    assert.ok(rotationDeltaDeg(rel, trueRel) < 0.6,
      `seed ${seed}: relative rotation ${rotationDeltaDeg(rel, trueRel).toFixed(3)} deg from the truth`);
  }
});

test('there is no polish knob, because no setting of it ever helped', () => {
  // bundleAdjust over two views has 6 pose degrees of freedom against 3 per point and nothing to pin them,
  // so it walked back toward the answer refineRelativePose already had at best and overfitted a handful of
  // points at worst - 2x to 22x worse than not running it on every seed tried - while reporting a SMALLER
  // reprojection number than the Sampson one, because it was fitted to fewer points. Unknown opts are
  // ignored, so an old call site cannot quietly turn it back on.
  assert.equal('polish' in SOLVE, false, 'the option is gone from the defaults');
  const cap = session({ noisePx: 0.5, seed: 21 });
  const [ca, cb] = lenses();
  const plain = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  const asked = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm,
                            typed: TYPED, opts: { polish: true, polishPoints: 24 } });
  assert.deepEqual(asked.pose.left.rotDeg, plain.pose.left.rotDeg, 'asking for it changes nothing');
  assert.equal(asked.report.bundleRmsPx, undefined, 'and nothing claims a better number than the fit');
});

// The relative rotation of a pair: what two cameras watching one face can actually measure, and what the
// mean toe-in throws half of away.
function relRotDeg(leftDeg, rightDeg) {
  return matMul(rotFromDeg(rightDeg), transpose(rotFromDeg(leftDeg)));
}

test('the epipolar residual is reported as consistency, with its own ceiling beside it', () => {
  // It is an RMS over the INLIERS, and an inlier is by definition under thresholdPx - so this number
  // cannot exceed the ceiling whatever the pose is, and calling it "the accuracy" was the problem.
  const cap = session({ noisePx: 0.5, seed: 7 });
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED,
                          expectedDepthCm: 60 });
  assert.ok(res.report.residualCeilingMm > res.report.residualMm, 'the ceiling is reported and is above it');
  near(res.report.residualCeilingMm,
       SOLVE.thresholdPx / res.report.sampsonRmsPx * res.report.residualMm, 0.02, 'and it is the same scale');
  const text = solveLines(res).join('\n');
  assert.match(text, /epipolar fit/, 'the line does not call it the residual');
  assert.match(text, /NOT accuracy/, 'and says what it is not');
  assert.ok(res.report.depthVsNamedPct != null, 'the depth is compared with the spot the user named');
  assert.match(text, /lens fov/, 'and the lens is named as what that comparison is for');
  // The differential YAW is measured and used to be thrown away, leaving a pair that is a degree out on
  // one side alone reading as a pair that is bang on.
  near(res.report.asymmetryYawDeg,
       Math.abs(TRUTH.right.rotDeg[1] + TRUTH.left.rotDeg[1]), 0.5, 'the yaw asymmetry is reported');
  assert.match(text, /deg in yaw/);
});

test('the pose records the lens it was fitted with, and stops being used when that changes', () => {
  // A focal error does not just scale depth: it bends the toe-in, and the anchoring carries that into the
  // rig as a real rotation. The fov is therefore an input exactly like the baseline, and a pose fitted at
  // one fov and decoded at another describes a pair of cameras that does not exist.
  const cap = session({ noisePx: 0.5, seed: 7 });
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.ok(res.ok);
  assert.deepEqual(res.pose.dfovDeg.map(Math.round), [TRUTH.dfovDeg, TRUTH.dfovDeg], 'the lens travels with the pose');

  const setup = mergeSetup(null);
  setup.pair.baselineCm = TRUTH.baselineCm;
  setup.pair.dfovDeg = TRUTH.dfovDeg;
  applySolvedPose(setup, res.pose);
  assert.equal(poseStatus(setup).inUse, true);
  setup.pair.dfovDeg = 70;                            // the user reads the real number off the datasheet
  const st = poseStatus(setup);
  assert.equal(st.inUse, false, 'a pose fitted with another lens is not this pair');
  assert.equal(st.stale, true);
  assert.match(st.reason, /lens/i);
  assert.equal(pairAngles(setup).source, 'aimed', 'so the derived angles come back rather than a stale pose');

  // A pose saved before the lens was recorded cannot be checked, and is left alone rather than condemned.
  const old = { ...res.pose };
  delete old.dfovDeg;
  setup.pair.solved = old; setup.pair.useSolved = true;
  assert.equal(poseStatus(setup).stale, false, 'an older pose with no lens on it still works');
});

test('a wrong lens bends the toe-in, and the fit reports itself as fine anyway', () => {
  // The reason the checks above have to exist: this is what a 2 degree datasheet error does, and no
  // residual or inlier number can see it, because a wrong K is self-consistent in BOTH cameras.
  const trueToe = (TRUTH.right.rotDeg[1] - TRUTH.left.rotDeg[1]) / 2;
  const cap = session({ noisePx: 0.5, seed: 7 });               // shot through a real 78 degree lens
  const told = 76;
  const [ca, cb] = [lensOnly({ ...TRUTH, dfovDeg: told, id: 'L' }), lensOnly({ ...TRUTH, dfovDeg: told, id: 'R' })];
  const solve = (cams, expected) => solvePair({ frames: cap.frames, camA: cams[0], camB: cams[1],
    baselineCm: TRUTH.baselineCm, typed: TYPED, expectedDepthCm: expected });
  const right = solve(lenses(), 60);
  const res = solve([ca, cb], 60);
  assert.ok(res.ok, 'it is accepted, which is the whole trouble');
  assert.ok(Math.abs(res.pose.toeInDeg - trueToe) > 0.5,
    `2 degrees of lens moved the toe-in by ${(res.pose.toeInDeg - trueToe).toFixed(2)} deg`);
  assert.ok(res.report.inlierRatio > 0.9, 'with the inliers still perfect');
  // ...and the residual gets SMALLER as the pose gets worse, because a wrong K is self-consistent
  assert.ok(res.report.residualMm <= right.report.residualMm,
    `residual ${res.report.residualMm} mm against ${right.report.residualMm} mm at the right lens`);
  // The depth is the only number that moves in step with the error, which is why it is reported beside
  // the spot the user named and why the hold check chases it.
  assert.ok(Math.abs(res.report.depthVsNamedPct - right.report.depthVsNamedPct) > 2,
    `depth moved ${right.report.depthVsNamedPct}% -> ${res.report.depthVsNamedPct}% against the named spot`);
});

// ---------------------------------------------------------------- the refusals

test('it refuses a capture that never moved', () => {
  const poses = [];
  for (let i = 0; i < 40; i++) poses.push({ at: [0.2 * Math.sin(i), 40 + 0.2 * Math.cos(i), 45], yaw: 0 });
  // (the bins would normally stop this ever reaching the solve; call it straight so the refusal is tested)
  const cap = session({ poses, capture: { perBin: 99, minGapMs: 0 }, seed: 5 });
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.equal(res.ok, false, 'a fit from one spot is not a calibration');
  assert.ok(res.reasons.some(r => r.code === 'spread'), `reasons: ${res.reasons.map(r => r.code)}`);
  assert.match(res.reasons.find(r => r.code === 'spread').text, /did not move far enough/,
    'and it says so in plain words');
});

test('it refuses a capture where the two cameras were not watching the same face', () => {
  const cap = session({ noisePx: 0.5, seed: 13 });
  // Scramble most of the correspondences: landmark i in one camera against landmark j in the other. This is
  // what a mismatched pair of faces (or a worker that lost sync) actually looks like.
  const rng = mulberry32(77);
  for (const f of cap.frames.slice(0, Math.floor(cap.frames.length * 0.8))) {
    const b = f.b.slice();
    for (let i = 0; i < f.n; i++) {
      const j = Math.floor(rng() * f.n);
      f.b[i * 2] = b[j * 2]; f.b[i * 2 + 1] = b[j * 2 + 1];
    }
  }
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.equal(res.ok, false, 'noise is not a pose');
  assert.ok(res.reasons.some(r => r.code === 'inliers'), `reasons: ${res.reasons.map(r => r.code)}`);
});

test('it refuses a pair marked the wrong way round', () => {
  const cap = session({ noisePx: 0.5, seed: 17 });
  for (const f of cap.frames) { const a = f.a; f.a = f.b; f.b = a; }     // left and right exchanged
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.equal(res.ok, false, 'the solve fits, and the answer is a rig that does not exist');
  const why = res.reasons.find(r => r.code === 'baseline');
  assert.ok(why, `reasons: ${res.reasons.map(r => r.code)}`);
  assert.match(why.text, /wrong way round|swap/, 'and it names the fix');
});

test('it refuses angles that are nowhere near the ones it would replace', () => {
  const cap = session({ noisePx: 0.5, seed: 19 });
  const [ca, cb] = lenses();
  // The user says the cameras are nearly parallel; the pictures say they are toed in 47 degrees. Whoever is
  // right, accepting this silently would mean the page had just stopped describing the rig on the desk.
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm,
                          typed: { toeInDeg: 5, tiltUpDeg: 30.5 } });
  assert.equal(res.ok, false, 'a 40 degree correction is not a correction');
  assert.ok(res.reasons.some(r => r.code === 'angles' || r.code === 'baseline'),
    `reasons: ${res.reasons.map(r => r.code)}`);
});

test('too few points is refused before anything is solved', () => {
  const cap = session({ poses: volumePoses().slice(0, 2), seed: 23 });
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'data');
});

// ---------------------------------------------------------------- living in the setup

const fakeStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('a solved pose is what the pair uses, survives a reload, and reverts in one step', () => {
  const cap = session({ noisePx: 0.4, seed: 29 });
  const [ca, cb] = lenses();
  const res = solvePair({ frames: cap.frames, camA: ca, camB: cb, baselineCm: TRUTH.baselineCm, typed: TYPED });
  assert.ok(res.ok);

  let setup = mergeSetup(null);
  setup.pair.baselineCm = TRUTH.baselineCm;
  const typedCams = pairCameras(setup);
  applySolvedPose(setup, res.pose);

  const cams = pairCameras(setup);
  assert.deepEqual(cams[0].rotDeg, res.pose.left.rotDeg, 'the left camera uses the measured rotation');
  assert.deepEqual(cams[1].rotDeg, res.pose.right.rotDeg, 'and so does the right');
  assert.equal(pairAngles(setup).source, 'measured', 'and the page can say which is in use');
  assert.notDeepEqual(cams[0].rotDeg, typedCams[0].rotDeg, 'which is not what it was using before');

  // saved with the rest of the setup, and still there after a reload
  const store = fakeStore();
  saveSetup(setup, store);
  const back = loadSetup(store);
  assert.deepEqual(pairCameras(back)[1].rotDeg, res.pose.right.rotDeg, 'the pose survived the reload');
  assert.equal(poseStatus(back).inUse, true);

  // one button back to the typed angles, and the measurement is kept so it can be put back
  back.pair.useSolved = false;
  assert.deepEqual(pairCameras(back)[0].rotDeg, typedCams[0].rotDeg, 'reverted to the derived angles');
  assert.equal(pairAngles(back).source, 'aimed');
  assert.ok(poseStatus(back).pose, 'the measurement is still on file');
  back.pair.useSolved = true;
  assert.deepEqual(pairCameras(back)[0].rotDeg, res.pose.left.rotDeg, 'and one button puts it back');

  // trim is untouched by any of this: it is still there for the constant offset that is left over
  assert.deepEqual(back.trimCm, [0, 0, 0]);
  back.trimCm = [0.5, 0, 0];
  assert.deepEqual(pairCameras(back)[0].rotDeg, res.pose.left.rotDeg, 'and trim does not disturb the pose');
});

test('a pose stops being used when the rig it describes changes', () => {
  const setup = mergeSetup(null);
  setup.pair.baselineCm = TRUTH.baselineCm;
  applySolvedPose(setup, { version: 1, baselineCm: TRUTH.baselineCm,
    left: { posCm: [-50.8, 0, 0], rotDeg: [30, -47, 180] },
    right: { posCm: [50.8, 0, 0], rotDeg: [30, 47, 180] }, toeInDeg: 47, tiltUpDeg: 30 });
  assert.equal(poseStatus(setup).inUse, true);
  setup.pair.baselineCm = 90;                        // the user re-measured, or moved a camera
  const st = poseStatus(setup);
  assert.equal(st.inUse, false, 'the measured positions no longer describe this pair');
  assert.equal(st.stale, true);
  assert.match(st.reason, /baseline/i);
  assert.equal(pairAngles(setup).source, 'aimed', 'so the derived angles come back rather than a stale pose');
});

test('a corrupt pose is ignored rather than trusted', () => {
  const setup = mergeSetup(null);
  for (const bad of [{ left: null }, { left: { posCm: [0, 0, 0], rotDeg: [1, 2] } }, { version: 99 }, 'nonsense']) {
    setup.pair.solved = typeof bad === 'string' ? bad
      : { version: 1, baselineCm: setup.pair.baselineCm, left: { posCm: [-1, 0, 0], rotDeg: [0, 0, 180] },
          right: { posCm: [1, 0, 0], rotDeg: [0, 0, 180] }, ...bad };
    setup.pair.useSolved = true;
    assert.equal(solvedPose(setup), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test('the aim warning steps aside once the pair is measured', () => {
  const setup = mergeSetup(null);
  setup.pair.aimManual = true; setup.pair.toeInDeg = 14; setup.pair.tiltUpDeg = 12;
  assert.equal(aimCheck(setup).ok, false, 'typed angles that miss the head spot are still a warning');
  applySolvedPose(setup, { version: 1, baselineCm: setup.pair.baselineCm,
    left: { posCm: [-setup.pair.baselineCm / 2, 0, 0], rotDeg: [30.5, -48.5, 180] },
    right: { posCm: [setup.pair.baselineCm / 2, 0, 0], rotDeg: [30.5, 48.5, 180] },
    toeInDeg: 48.5, tiltUpDeg: 30.5 });
  const a = aimCheck(setup);
  assert.equal(a.ok, true, 'a measured pose is not something to warn about');
  assert.equal(a.used.source, 'measured');
});

// ---------------------------------------------------------------- hold still and prove it

test('the hold-still check says how far the solve puts you from where you say you are', () => {
  const h = makeHoldCheck({ expectedCm: [0, 40, 45], ms: 1000 });
  const rng = mulberry32(41);
  let r = h.result(0);
  assert.equal(r.done, false);
  for (let i = 0; i < 40; i++)
    r = h.feed([0.8 + gaussian(rng) * 0.05, 40.2 + gaussian(rng) * 0.05, 44.6 + gaussian(rng) * 0.05], i * 50);
  assert.equal(r.done, true, 'two seconds of samples is a measurement');
  near(r.offsetCm[0], 0.8, 0.1, 'x offset');
  near(r.distanceCm, Math.hypot(0.8, 0.2, 0.4), 0.15, 'distance from the named spot');
  assert.ok(r.wobbleMm.every(w => w < 10), 'and it reports how still you were');
  assert.match(r.message, /from the spot you named/);
});

test('the walk to the spot is not part of the measurement', () => {
  // It used to average everything since the button was pressed, with the clock started on the first sample
  // - so walking to the spot over two seconds reported 16 cm that was entirely the walk, and standing
  // still afterwards only dragged it slowly toward the truth.
  const h = makeHoldCheck({ expectedCm: [0, 40, 45], ms: 1000 });
  let r = null, t = 0;
  const walk = [[-20, 40, 70], [-15, 40, 63], [-10, 40, 57], [-5, 40, 51], [0, 40, 45]];
  for (const p of walk) { r = h.feed(p, t); t += 500; }
  assert.equal(r.done, false, 'a walk is never a measurement, however long it takes');
  const rng = mulberry32(61);
  for (let i = 0; i < 40; i++)
    r = h.feed([gaussian(rng) * 0.05, 40 + gaussian(rng) * 0.05, 45 + gaussian(rng) * 0.05], t + i * 50);
  assert.equal(r.done, true, 'standing still for a second is');
  assert.ok(r.distanceCm < 0.5, `and it is the spot, not the walk: ${r.distanceCm} cm`);

  // and it stays that way while the user walks back to the keyboard to read it
  const kept = r.distanceCm;
  for (let i = 0; i < 20; i++) r = h.feed([-8 - i, 40, 60 + i], t + 2000 + i * 50);
  assert.equal(r.distanceCm, kept, 'a finished measurement does not turn back into a running average');
  assert.equal(r.frozen, true, 'and says it is finished');
});

test('a hold that is not a hold is not reported as one', () => {
  const h = makeHoldCheck({ expectedCm: [0, 40, 45], ms: 1000 });
  let r = null;
  // a head wandering over 4 cm: the mean would look fine, and it is not a measurement of anything
  for (let i = 0; i < 60; i++) r = h.feed([2 * Math.sin(i / 3), 40 + 2 * Math.cos(i / 4), 45], i * 50);
  assert.equal(r.done, false, `wobble ${r.wobbleMm} mm is not holding still`);
  assert.match(r.message, /still moving/);
  assert.ok(HOLD.spreadMm > 0 && HOLD.stepMm > 0, 'the thresholds are named, not buried');
});

test('the hold check hands back the lens fov, which is the one thing the solve cannot measure', () => {
  // A focal error is a radial scale about the tracker's own origin, so a head that is consistently too far
  // from the PAIR is a lens error, not an angle error. f scales with that ratio, so one round trip fixes
  // the number the solve was told.
  const origin = [0, 12, 8], spot = [0, 40, 45];
  const h = makeHoldCheck({ expectedCm: spot, originCm: origin, ms: 500,
                            lens: { dfovDeg: 78, width: 1280, height: 720 } });
  const want = Math.hypot(spot[0] - origin[0], spot[1] - origin[1], spot[2] - origin[2]);
  const k = 1.05;                          // the pair puts the head 5% further out than it really is
  const far = [0, 1, 2].map(i => origin[i] + (spot[i] - origin[i]) * k);
  let r = null;
  for (let i = 0; i < 30; i++) r = h.feed(far, i * 50);
  assert.equal(r.done, true);
  near(r.lens.ratio, k, 0.01, 'it measures the scale error');
  assert.ok(r.lens.dfovDeg < 78, `and a head that is too far means a narrower lens: ${r.lens.dfovDeg} deg`);
  assert.match(r.message, /lens fov/, 'and says so where the user can act on it');
  assert.ok(want > 0);
});
