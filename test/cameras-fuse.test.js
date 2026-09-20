import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameGate, interpolateLm, pairHands, monoHandWorld, eyeFromMono, pickEye, assignSlots, pinchState,
  PINCH_CLOSE_CM, PINCH_OPEN_CM,
} from '../public/js/input/cameras.js';
import { makeView, defaultCalib, camToWorld } from '../public/js/input/stereo.js';

test('the gate keeps one frame in flight, so slow inference never queues', () => {
  const g = new FrameGate({ maxInFlight: 1, maxAgeMs: 120 });
  assert.equal(g.offer(100, 100), true);
  assert.equal(g.offer(116, 116), false);       // still busy
  assert.equal(g.offer(133, 133), false);
  assert.equal(g.busyDrops, 2);
  g.finish(100, 150);
  assert.equal(g.offer(150, 150), true);
  assert.equal(g.inFlight, 1);
  assert.equal(g.sent, 2);
});

test('the gate throws away a frame that is already too old to be useful', () => {
  const g = new FrameGate({ maxAgeMs: 120 });
  assert.equal(g.offer(0, 200), false);
  assert.equal(g.staleDrops, 1);
  assert.equal(g.inFlight, 0);
  assert.equal(g.drops, 1);
});

test('a frame that produces nothing still frees the gate, or the camera looks dead for ever', () => {
  const g = new FrameGate();
  assert.equal(g.offer(0, 0), true);
  g.abort();                                     // the worker was still loading its models
  assert.equal(g.inFlight, 0);
  assert.equal(g.lostDrops, 1);
  assert.equal(g.offer(16, 16), true);
  assert.equal(g.done, 0);                       // an aborted frame is not a processed frame
});

test('a worker that stops answering altogether does not wedge the gate shut for ever', () => {
  // A worker thread that is killed (memory pressure, a GPU reset taking MediaPipe's delegate down) posts
  // NO message, so nothing ever calls finish() or abort(). Nothing else in cameras.js has a timeout on
  // inFlight, so the view stopped sending frames for the life of the page — and on a ZED that ends hand
  // tracking outright, because startGrabLoop gates both eyes on both gates. It was invisible too: `times`
  // was pruned only inside finish(), so a dead view kept reporting its last good frame rate.
  const g = new FrameGate({ maxInFlight: 1, maxAgeMs: 120 });
  for (let i = 0; i < 30; i++) { g.offer(i * 16, i * 16); g.finish(i * 16, i * 16 + 20); }
  const t0 = 30 * 16;
  assert.equal(g.offer(t0, t0), true);
  assert.equal(g.offer(t0 + 16, t0 + 16), false, 'busy, as designed');
  assert.equal(g.watchdog(t0 + 100), false, 'and not yet late enough to give up on');

  const late = t0 + 1200;          // well past the watchdog's 4x maxAgeMs, and past the 1 s fps window
  assert.equal(g.watchdog(late), true, 'the slot is freed once the worker is clearly not coming back');
  assert.equal(g.inFlight, 0);
  assert.equal(g.stallDrops, 1);
  assert.equal(g.strikes, 1);
  assert.equal(g.offer(late, late), true, 'and the view sends frames again');
  console.log(`      after ${(late - t0).toFixed(0)} ms of silence: fps reads ${g.fpsAt(late)}, ${g.stallDrops} stall drop(s)`);
  assert.equal(g.fpsAt(late), 0, 'a wedged view must read 0 fps, not its last good number');

  // repeated strikes are what the caller uses to give the camera up instead of feeding a dead thread
  g.watchdog(late + 4 * g.maxAgeMs + 1);
  assert.equal(g.strikes, 2);
  g.finish(late, late + 20);
  assert.equal(g.strikes, 0, 'one good answer clears the count');
});

test('the gate measures frame rate and latency from what actually came back', () => {
  const g = new FrameGate();
  for (let i = 0; i < 30; i++) { g.offer(i * 16, i * 16); g.finish(i * 16, i * 16 + 25); }
  assert.equal(g.done, 30);
  assert.ok(Math.abs(g.latencyMs - 25) < 1);
  assert.ok(g.fps > 0 && g.fps <= 30);
  g.times = [];                                  // an idle second reads as zero, not as the last known rate
  assert.equal(g.fps, 0);
});

test('landmarks from a free-running camera are moved to the instant we fuse at', () => {
  const samples = [
    { at: 100, lm: [[0, 0, 0], [1, 1, 0]] },
    { at: 116, lm: [[0.2, 0, 0], [1.2, 1, 0]] },
  ];
  const mid = interpolateLm(samples, 108, 8);
  assert.equal(mid.interpolated, true);
  assert.ok(Math.abs(mid.lm[0][0] - 0.1) < 1e-9);
  const near = interpolateLm(samples, 120, 8);   // just past the newest: near enough to use as is
  assert.equal(near.interpolated, false);
  assert.equal(near.at, 116);
  assert.equal(interpolateLm(samples, 300, 8), null);   // too old to pretend
  assert.equal(interpolateLm([], 100, 8), null);
});

test('hands are paired across two views by handedness and image row', () => {
  const lm = (y, hand) => ({ handedness: hand, lm: Array.from({ length: 21 }, () => [0.5, y, 0]) });
  const A = [lm(0.3, 'Left'), lm(0.7, 'Right')];
  const B = [lm(0.72, 'Right'), lm(0.31, 'Left')];
  assert.deepEqual(pairHands(A, B).map(p => [p[0], p[1]]), [[0, 1], [1, 0]]);
  // the same hand seen twice must not be paired with a hand in a completely different place
  const far = [lm(0.05, 'Left')];
  assert.deepEqual(pairHands([lm(0.9, 'Left')], far), []);
});

test('one view only: depth from palm size puts the hand in front of the camera', () => {
  const calib = defaultCalib(2560, 720);
  const view = makeView({ intr: calib.left, eyeW: calib.eyeW, eyeH: calib.eyeH, label: 'one' });
  // a hand whose wrist->knuckle span is 100 px: f/scale with a real ZED's f~700 gives about 60 cm
  const lm = Array.from({ length: 21 }, () => [0.5, 0.5, 0]);
  lm[0] = [0.5, 0.55, 0]; lm[9] = [0.5, 0.55 - 100 / calib.eyeH, 0];
  lm[5] = [0.52, 0.5, 0]; lm[17] = [0.52 - 40 / calib.eyeW, 0.5, 0];
  const world = monoHandWorld(lm, view);
  assert.equal(world.length, 21);
  const depth = world[0][2];
  assert.ok(depth > 45 && depth < 75, `depth ${depth}`);
  assert.equal(monoHandWorld(Array.from({ length: 21 }, () => [0.5, 0.5, 0]), view), null);   // no scale, no guess
});

test('one head camera: eye distance comes from how far apart the eyes look', () => {
  const calib = defaultCalib(2560, 720);
  const view = makeView({ intr: calib.left, eyeW: calib.eyeW, eyeH: calib.eyeH, label: 'head' });
  const f = calib.left.fx, ipdCm = 6.3, want = 60;
  const sepPx = ipdCm * f / want;
  const eyes = [[0.5 - sepPx / 2 / calib.eyeW, 0.5, 0], [0.5 + sepPx / 2 / calib.eyeW, 0.5, 0]];
  const p = eyeFromMono(eyes, view, ipdCm);
  assert.ok(Math.abs(p[2] - want) < 0.5, `${p}`);
  assert.equal(eyeFromMono([[0.5, 0.5, 0], [0.5, 0.5, 0]], view, ipdCm), null);
});

test('the viewer\'s right eye is the one further left in a raw camera image', () => {
  const eyes = [[0.4, 0.5, 0], [0.6, 0.5, 0]];
  assert.deepEqual(pickEye(eyes, 'right'), [0.4, 0.5]);
  assert.deepEqual(pickEye(eyes, 'left'), [0.6, 0.5]);
  assert.deepEqual(pickEye(eyes, 'center'), [0.5, 0.5]);
  assert.deepEqual(pickEye([[0.6, 0.5, 0], [0.4, 0.5, 0]], 'right'), [0.4, 0.5]);
});

test('a hand keeps its slot while it moves, and a new hand takes the free one', () => {
  const prev = [{ tip: [0, 0, 25], seenAt: 1000 }, { tip: [0, 0, 0], seenAt: -1e9 }];
  assert.deepEqual(assignSlots([[2, 1, 26]], prev, 1100), [0]);          // near slot 0: same hand
  assert.deepEqual(assignSlots([[40, 0, 25]], prev, 1100), [0]);         // far, but slot 0 was just tracking
  const both = [{ tip: [-10, 0, 25], seenAt: 1000 }, { tip: [10, 0, 25], seenAt: 1000 }];
  assert.deepEqual(assignSlots([[9, 0, 25], [-9, 0, 25]], both, 1100), [1, 0]);   // swapped order, same slots
  const none = [{ tip: [0, 0, 0], seenAt: -1e9 }, { tip: [0, 0, 0], seenAt: -1e9 }];
  assert.deepEqual(assignSlots([[5, 0, 25], [-5, 0, 25]], none, 1100), [1, 0]);   // leftmost hand gets slot 0
});

test('pinch closes at 25 mm and opens at 35 mm, in real centimetres', () => {
  const hand = gapCm => {
    const lm = Array.from({ length: 21 }, () => [0, 0, 40]);
    lm[0] = [0, -8.5, 40]; lm[9] = [0, 0, 40];
    lm[4] = [0, 0, 40]; lm[8] = [gapCm, 0, 40];
    return lm;
  };
  assert.equal(pinchState(hand(5), false).pinch, false);
  assert.equal(pinchState(hand(2.0), false).pinch, true);
  assert.equal(pinchState(hand(3.0), true).pinch, true);      // hysteresis: an established pinch is stickier
  assert.equal(pinchState(hand(3.0), false).pinch, false);
  assert.equal(pinchState(hand(4.0), true).pinch, false);
  assert.ok(PINCH_CLOSE_CM < PINCH_OPEN_CM);
  const p = pinchState(hand(2.5), false);
  assert.ok(Math.abs(p.cm - 2.5) < 1e-9);
  assert.ok(Math.abs(p.ratio - 2.5 / 8.5) < 1e-6);            // the old ratio is still published for the HUD
});

test('a world point survives the round trip through a camera placed in the rig', () => {
  const calib = defaultCalib(2560, 720);
  const ext = { posCm: [0, 18, -3], rotDeg: [12, 0, 180] };
  const view = makeView({ intr: calib.left, eyeW: calib.eyeW, eyeH: calib.eyeH, ext, label: 'tilted' });
  const pCam = [3, -2, 45];
  const u = (calib.left.fx * pCam[0] / pCam[2] + calib.left.cx) / calib.eyeW;
  const v = (calib.left.fy * pCam[1] / pCam[2] + calib.left.cy) / calib.eyeH;
  const got = view.point(u, v, pCam[2]);
  const want = camToWorld(pCam, ext);
  assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) < 1e-9);
});
