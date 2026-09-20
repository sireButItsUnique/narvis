// The solver: the shape it publishes, the filter's lag and jitter, hand slots, pinch hysteresis,
// falling back to one camera, and the already-3D bridge path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, monoHandToRig, assignSlots } from '../public/js/track/solve.js';
import { OneEuro3, makeHandFilter } from '../public/js/track/filter.js';
import { HAND, PINCH, boneLengthSpreadMm } from '../public/js/track/landmarks.js';
import { makeZed, makeWebcam, rigGeometry, handPose, synthesizeView, eyePoints } from '../public/js/sim/rig-sim.js';
import { dist, mean, mulberry32, gaussian, rodrigues, add } from '../public/js/track/linalg.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);
const g = rigGeometry();

function rig() {
  const cams = [...makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, 380], target: g.handVolume.centre }),
                makeWebcam({ id: 'cam-l', position: [-150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
                makeWebcam({ id: 'cam-r', position: [150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] })];
  return { cams, tracker: new Tracker({ cameras: cams, appScale: 1 }) };
}
function feed(tracker, cams, truth, tMs, rng, noisePx = 1) {
  for (const c of cams) {
    const view = synthesizeView(c, truth, { noisePx, rng });
    if (view) tracker.observe2D({ camId: c.id, tMs, face: view.face, hands: view.hands });
  }
  return tracker.solve(tMs);
}
const still = (centre, pinch01 = 1) => ({ head: [0, g.viewer[1], g.viewer[2]],
                                          hands: [{ handedness: 'Right', points: handPose({ centre, pinch01 }) }] });

test('it publishes exactly the shape public/js/input/state.js already exports', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(2);
  const centre = g.handVolume.centre;
  for (let f = 0; f < 12; f++) feed(tracker, cams, still(centre, 0), f * 16, rng);

  // A stand-in for the app's shared input: Vector3-like objects with .set(), which is all publish() needs.
  const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const input = { mode: 'none', eye: vec(), faceSeenAt: -1e9,
                  hands: [0, 1].map(() => ({ active: false, tip: vec(), grip: vec(), gripRaw: vec(),
                                             pinch: false, pinchRatio: 1, jointsWorld: null, seenAt: -1e9 })) };
  tracker.publish(input, 12 * 16);

  assert.equal(typeof input.mode, 'string');
  assert.ok(input.hands[0].active, 'the tracked hand is active');
  assert.ok(input.hands[0].jointsWorld instanceof Float32Array, 'joints come back as a Float32Array');
  assert.equal(input.hands[0].jointsWorld.length, 63, '21 landmarks x 3');
  assert.ok(input.hands[0].pinch, 'a closed hand reads as a pinch');
  assert.equal(input.hands[1].active, false, 'the empty slot stays empty');

  // appScale 0.1 is the conversion the web app wants: rig millimetres -> the app's centimetres.
  const cmTracker = new Tracker({ cameras: cams, appScale: 0.1 });
  const rng2 = mulberry32(2);
  for (let f = 0; f < 12; f++) {
    for (const c of cams) {
      const view = synthesizeView(c, still(centre, 0), { noisePx: 1, rng: rng2 });
      if (view) cmTracker.observe2D({ camId: c.id, tMs: f * 16, face: view.face, hands: view.hands });
    }
    cmTracker.solve(f * 16);
  }
  const cmInput = { mode: 'none', eye: vec(), hands: [0, 1].map(() => ({ tip: vec(), grip: vec(), gripRaw: vec() })) };
  cmTracker.publish(cmInput, 12 * 16);
  near(cmInput.eye.z / input.eye.z, 0.1, 0.02, 'centimetres are exactly a tenth of the millimetres');
});

test('the hand lands where it actually is, to a few millimetres', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(4);
  const centre = g.handVolume.centre;
  const truth = still(centre, 1);
  let out;
  for (let f = 0; f < 30; f++) out = feed(tracker, cams, truth, f * 16, rng);
  const hand = out.hands.find(h => h.active);
  const tipTruth = truth.hands[0].points[HAND.INDEX_TIP];
  const errs = hand.points.map((p, i) => (p ? dist(p, truth.hands[0].points[i]) : null)).filter(Boolean);
  console.log(`  a still hand: fingertip ${dist(hand.tip, tipTruth).toFixed(2)} mm, ` +
              `all 21 landmarks mean ${mean(errs).toFixed(2)} mm, bone-length spread ${boneLengthSpreadMm(hand.points).toFixed(1)} mm`);
  assert.ok(dist(hand.tip, tipTruth) < 3, 'a still fingertip is within 3 mm');
  assert.ok(mean(errs) < 4, 'and so is the rest of the hand');
  assert.equal(hand.source, 'stereo');
  near(dist(out.eye, [0, g.viewer[1], g.viewer[2]]), 0, 5, 'the eye too');
});

test('the 1 euro filter trades lag against jitter the way it is supposed to', () => {
  // A step, then a hold. Lag is how long it takes to arrive; jitter is how much it wobbles once there.
  const measure = (minCutoff, beta) => {
    const f = new OneEuro3(minCutoff, beta);
    const rng = mulberry32(1);
    let lagFrames = -1;
    const held = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 60;
      const truth = i < 30 ? [0, 0, 0] : [100, 0, 0];
      const out = f.filter(truth.map(v => v + gaussian(rng) * 3), t);
      if (i >= 30 && lagFrames < 0 && Math.abs(out[0] - 100) < 10) lagFrames = i - 30;
      if (i > 90) held.push(out[0]);
    }
    const jitter = Math.sqrt(mean(held.map((v, i) => (i ? (v - held[i - 1]) ** 2 : 0))));
    return { lagMs: lagFrames * 1000 / 60, jitter };
  };
  const steady = measure(0.6, 0.02), lively = measure(1.6, 0.15);
  console.log(`  steady tuning (0.6 Hz, beta 0.02): ${steady.lagMs.toFixed(0)} ms to settle, ${steady.jitter.toFixed(2)} mm jitter`);
  console.log(`  lively tuning (1.6 Hz, beta 0.15): ${lively.lagMs.toFixed(0)} ms to settle, ${lively.jitter.toFixed(2)} mm jitter`);
  assert.ok(lively.lagMs < steady.lagMs, 'a higher beta reacts faster');
  assert.ok(lively.jitter > steady.jitter, 'and pays for it with jitter — that is the whole trade');
  assert.ok(steady.lagMs < 200, 'even the steady tuning settles within 200 ms');

  // A long gap must not make the filter jump: the derivative is clamped.
  const f = makeHandFilter();
  f.filter([0, 0, 0], 0);
  const afterGap = f.filter([50, 0, 0], 5);
  assert.ok(Math.abs(afterGap[0]) < 55, 'no overshoot after a five-second gap');
});

test('pinch uses metric hysteresis and holds through a dropout', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(6);
  const centre = g.handVolume.centre;
  let t = 0;
  const step = (pinch01, feedIt = true) => {
    t += 16;
    const truth = still(centre, pinch01);
    if (feedIt) return feed(tracker, cams, truth, t, rng);
    return tracker.solve(t);
  };
  for (let i = 0; i < 5; i++) step(1);
  assert.equal(tracker.slots[0].pinch, false, 'an open hand is not pinching');
  for (let i = 0; i < 5; i++) step(0);
  assert.equal(tracker.slots[0].pinch, true, 'a closed hand is');
  console.log(`  pinch distance open ${(() => { const s = step(1); return tracker.slots[0].pinchDistMm.toFixed(0); })()} mm ` +
              `-> closed ${(() => { for (let i = 0; i < 4; i++) step(0); return tracker.slots[0].pinchDistMm.toFixed(0); })()} mm ` +
              `(in at ${PINCH.closeMm} mm, out at ${PINCH.openMm} mm)`);
  // Halfway between the thresholds, an established pinch must hold rather than chatter.
  const held = [];
  for (let i = 0; i < 6; i++) { step(0.22); held.push(tracker.slots[0].pinch); }
  assert.ok(held.every(Boolean) || !held.some(Boolean), 'no chattering in the hysteresis band');

  // Tracking drops out entirely: the grab survives for releaseHoldMs and then lets go.
  for (let i = 0; i < 4; i++) step(0);
  assert.equal(tracker.slots[0].pinch, true);
  for (let i = 0; i < 8; i++) step(0, false);            // ~128 ms of nothing
  assert.equal(tracker.slots[0].pinch, true, 'a flicker must not drop what you are holding');
  for (let i = 0; i < 12; i++) step(0, false);           // past releaseHoldMs
  assert.equal(tracker.slots[0].pinch, false, 'but a real loss of tracking does release it');
});

test('each hand keeps its slot, and two hands do not swap', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(8);
  const c = g.handVolume.centre;
  let out;
  for (let f = 0; f < 20; f++) {
    const truth = { head: [0, g.viewer[1], g.viewer[2]], hands: [
      { handedness: 'Right', points: handPose({ centre: [c[0] - 90 + f * 3, c[1], c[2]], pinch01: 1 }) },
      { handedness: 'Left', points: handPose({ centre: [c[0] + 90 - f * 3, c[1], c[2]], pinch01: 1, handedness: 'Left' }) },
    ] };
    out = feed(tracker, cams, truth, f * 16, rng);
  }
  const active = out.hands.filter(h => h.active);
  console.log(`  ${active.length} hands tracked, slots: ${out.hands.map(h => h.handedness || '-').join(' / ')}`);
  assert.equal(active.length, 2, 'both hands are tracked');
  assert.notEqual(out.hands[0].handedness, out.hands[1].handedness, 'and they are not both the same hand');

  // The slot rule on its own: a hand near a slot's last position stays in that slot.
  const slots = [{ index: 0, grip: [0, 0, 0], seenAtMs: 100 }, { index: 1, grip: [200, 0, 0], seenAtMs: 100 }];
  const det = p => ({ handedness: 'Right', points: Object.assign(new Array(21).fill(null), { [HAND.INDEX_TIP]: p }) });
  assert.deepEqual(assignSlots(slots, [det([210, 0, 0])], 120), [1], 'nearest slot wins');
  assert.deepEqual(assignSlots(slots, [det([10, 0, 0]), det([190, 0, 0])], 120), [0, 1], 'no swap');
  assert.deepEqual(assignSlots(slots, [det([190, 0, 0]), det([10, 0, 0])], 120), [1, 0], 'swapped input, same assignment');
});

test('one camera is enough to keep going, with depth from palm size', () => {
  const cam = makeWebcam({ id: 'solo', role: 'hands', position: [-40, g.handVolume.centre[1] + 60, 430],
                           target: g.handVolume.centre });
  const truthPts = handPose({ centre: g.handVolume.centre, pinch01: 1 });
  const pts = truthPts.map(p => { const q = cam.project(p); return { u: q.u, v: q.v }; });
  const out = monoHandToRig(cam, pts);
  const err = mean(out.map((p, i) => dist(p, truthPts[i])));
  const depthErr = Math.abs(dist(out[HAND.WRIST], cam.position) - dist(truthPts[HAND.WRIST], cam.position));
  console.log(`  one camera, no z hints: mean landmark error ${err.toFixed(0)} mm, of which depth ${depthErr.toFixed(0)} mm`);
  assert.ok(out.every(p => p.every(Number.isFinite)), 'it produces a finite answer');
  assert.ok(err < 80, 'roughly right, which is what a palm-size guess is worth');

  // The tracker picks this path by itself when only one camera sees the hand.
  const tracker = new Tracker({ cameras: [cam], appScale: 1 });
  const rng = mulberry32(3);
  let res;
  for (let f = 0; f < 10; f++) {
    const view = synthesizeView(cam, { head: [0, g.viewer[1], g.viewer[2]], hands: [{ handedness: 'Right', points: truthPts }] },
                                { noisePx: 1, rng });
    tracker.observe2D({ camId: cam.id, tMs: f * 33, hands: view.hands, face: view.face });
    res = tracker.solve(f * 33);
  }
  assert.equal(res.hands.find(h => h.active).source, 'mono', 'it falls back without being told to');
});

test('already-3D input from a bridge is accepted and filtered the same way', () => {
  const tracker = new Tracker({ cameras: [], appScale: 1 });
  const pts = handPose({ centre: g.handVolume.centre, pinch01: 0 });
  const rng = mulberry32(11);
  let out;
  for (let f = 0; f < 10; f++) {
    tracker.observe3D({ tMs: f * 16, hands: [{ handedness: 'Right',
      points: pts.map(p => p.map(v => v + gaussian(rng) * 2)) }] });
    out = tracker.solve(f * 16 + 20);
  }
  const hand = out.hands.find(h => h.active);
  assert.equal(hand.source, 'bridge');
  assert.ok(hand.pinch, 'pinch works on bridge data too');
  assert.ok(dist(hand.tip, pts[HAND.INDEX_TIP]) < 6, 'and it lands where the bridge said');
  console.log(`  bridge: fingertip ${dist(hand.tip, pts[HAND.INDEX_TIP]).toFixed(2)} mm from truth, ` +
              `latency ${out.quality.latencyMs.toFixed(0)} ms`);

  // A bridge frame in the sensor's own coordinates is moved into the rig frame by the stored similarity.
  const tr = { R: rodrigues([0.02, 0.3, -0.01]), t: [25, -40, 60], scale: 1.0 };
  const t2 = new Tracker({ cameras: [], appScale: 1 });
  t2.setBridgeTransform(tr);
  t2.observe3D({ tMs: 0, hands: [{ handedness: 'Right', points: pts }] });
  const moved = t2.bridge.hands[0].points[HAND.INDEX_TIP];
  assert.ok(dist(moved, pts[HAND.INDEX_TIP]) > 10, 'the transform was actually applied');
});

// ---------------------------------------------------------------- misses, and what they must not cost

// The capture layer never goes silent: landmarks-worker.js ALWAYS posts a result, and a frame where
// MediaPipe found nothing is { face: null, hands: [] }. Nothing in the test suite used to feed that shape
// in, and the solver treated it as "this camera has no hands", evicting a camera whose previous frame was
// perfectly good and dropping the whole solve to the single-camera guess.
test('a frame with no detections does not evict the camera that found one 16 ms ago', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(31);
  const centre = g.handVolume.centre;
  const zed = cams.filter(c => c.id.startsWith('zed'));
  let sawMono = 0, frames = 0;
  for (let f = 0; f < 40; f++) {
    const tMs = f * 16, truth = still(centre, 0);
    for (const c of cams) {
      const view = synthesizeView(c, truth, { noisePx: 1, rng }) || { face: null, hands: [] };
      // one eye of the ZED misses every third frame, the way a detector really does
      const miss = c === zed[0] && f % 3 === 2;
      tracker.observe2D({ camId: c.id, tMs, face: miss ? null : view.face,
                          hands: miss ? [] : view.hands, normalized: true });
    }
    const out = tracker.solve(tMs);
    if (f < 6) continue;                                  // let the ring fill
    frames++;
    if (out.quality.handSource === 'mono') sawMono++;
    assert.equal(out.quality.handSource, 'stereo', `frame ${f} fell back to ${out.quality.handSource}`);
    assert.equal(out.quality.handViews, 2, `frame ${f} solved with ${out.quality.handViews} view(s)`);
  }
  console.log(`  a third of one eye's frames empty: ${sawMono}/${frames} frames on the single-camera guess`);
});

// sampleAt takes the blend path whenever gap <= extrapolateMs, and gap is exactly 0 for the camera that
// DEFINES the reference time — every frame. blend() used to build its hand list from the OLDER frame, so
// at t == 1 the reference camera's fresh detection was thrown away whenever the previous frame lacked it.
test('a camera that missed only the PREVIOUS frame still contributes this one', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(32);
  const zed = cams.filter(c => c.id.startsWith('zed'));
  const path = f => [g.handVolume.centre[0] + f * 10, g.handVolume.centre[1], g.handVolume.centre[2]];
  for (let f = 0; f < 8; f++) {
    const tMs = f * 16;
    const truth = { head: [0, g.viewer[1], g.viewer[2]],
                    hands: [{ handedness: 'Right', points: handPose({ centre: path(f), pinch01: 0 }) }] };
    for (const c of cams) {
      const view = synthesizeView(c, truth, { noisePx: 0, rng }) || { face: null, hands: [] };
      const miss = c === zed[0] && f === 6;              // exactly the frame before the one we check
      tracker.observe2D({ camId: c.id, tMs, face: view.face, hands: miss ? [] : view.hands, normalized: true });
    }
  }
  const out = tracker.solve(7 * 16);
  const hand = out.hands.find(h => h.active);
  const err = dist(hand.raw[HAND.INDEX_TIP], handPose({ centre: path(7), pinch01: 0 })[HAND.INDEX_TIP]);
  console.log(`  the frame after a single missed detection: ${out.quality.handSource}, ` +
              `${out.quality.handViews} views, tip ${err.toFixed(2)} mm`);
  assert.equal(out.quality.handSource, 'stereo');
  assert.equal(out.quality.handViews, 2);
  assert.ok(err < 2, `tip error ${err.toFixed(2)} mm`);
});

// pairCost() returns a sentinel meaning "these cannot be the same hand". It used to be 1e6, and the
// acceptance test was Number.isFinite — which 1e6 passes — so two DIFFERENT hands seen by two cameras
// were fused into one point hundreds of millimetres from either, reported as a clean two-view fix.
test('two different hands are never fused into one phantom', () => {
  const zed = makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, 380], target: g.handVolume.centre });
  const side = makeWebcam({ id: 'side', role: 'hands', position: [420, g.handVolume.centre[1] + 120, 180],
                            target: g.handVolume.centre });
  const cams = [zed[0], side];
  const tracker = new Tracker({ cameras: cams, appScale: 1 });
  const rng = mulberry32(33);
  const rightCentre = g.handVolume.centre;
  const leftCentre = [g.handVolume.centre[0] + 220, g.handVolume.centre[1], g.handVolume.centre[2]];
  const rightPts = handPose({ centre: rightCentre, pinch01: 0, handedness: 'Right' });
  const leftPts = handPose({ centre: leftCentre, pinch01: 1, handedness: 'Left' });
  let out = null;
  for (let f = 0; f < 20; f++) {
    const tMs = f * 16;
    // the ZED eye only sees the RIGHT hand; the side webcam only sees the LEFT one
    for (const [c, pts, handedness] of [[zed[0], rightPts, 'Right'], [side, leftPts, 'Left']]) {
      const view = synthesizeView(c, { head: [0, g.viewer[1], g.viewer[2]],
                                       hands: [{ handedness, points: pts }] }, { noisePx: 0.6, rng });
      if (view) tracker.observe2D({ camId: c.id, tMs, face: null, hands: view.hands, normalized: true });
    }
    out = tracker.solve(tMs);
  }
  const hand = out.hands.find(h => h.active && h.handedness === 'Right');
  const err = dist(hand.raw[HAND.INDEX_TIP], rightPts[HAND.INDEX_TIP]);
  console.log(`  a Right hand and a Left hand, one camera each: ${hand.source}, ` +
              `${hand.views} view(s), tip ${err.toFixed(1)} mm from the real right hand`);
  assert.equal(hand.source, 'mono', 'a handedness mismatch must not become a stereo pair');
  assert.ok(err < 25, `the published point is the hand that was really there (${err.toFixed(1)} mm)`);
});

test('the quality readout says what is tracking and how late it is', () => {
  const { cams, tracker } = rig();
  const rng = mulberry32(12);
  for (let f = 0; f < 10; f++) feed(tracker, cams, still(g.handVolume.centre, 1), f * 16, rng);
  const out = tracker.solve(10 * 16 + 25);
  console.log(`  "${tracker.readout}"`);
  assert.equal(out.quality.cameras, 4);
  assert.equal(out.quality.eyeSource, 'stereo');
  assert.equal(out.quality.handSource, 'stereo');
  assert.ok(out.quality.latencyMs >= 25, 'latency counts from capture, not from arrival');
  assert.ok(out.quality.handRmsPx < 3, 'reprojection is reported in pixels');
  assert.match(tracker.readout, /cams/);
});
