// The whole chain with no hardware: the capture layer's cameras -> the real solver (track/solve.js) ->
// the shared input object -> grab.js -> a body that gets picked up, carried and put down.
//
// This is the test the three branches did not have between them. Each side was proved on its own: the
// capture layer against generated video, the solver against the simulator, grab against scripted hands.
// What nobody had checked was that the units, the frames, the landmark order and the timestamps survive
// the joins — and three of the four did not, which is why this file exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as stereo from '../public/js/input/stereo.js';
import { cameraForView, createSolver, camIdFor, normHandedness, faceForTracker, handsForTracker, MM_PER_CM }
  from '../public/js/input/solver.js';
import { createSceneGrab, createLagMeter, handsFromInput } from '../public/js/interact/wire.js';
import { HAND } from '../public/js/track/landmarks.js';
import { handPose } from '../public/js/sim/rig-sim.js';

// ---------------------------------------------------------------- a rig on the bench

// A ZED-shaped side-by-side camera at the origin facing the viewer, exactly as cameras.js builds one.
const W = 1344, H = 376;
function zedViews(ext = { posCm: [0, 0, 0], rotDeg: [0, 0, 180] }) {
  const calib = stereo.defaultCalib(W, H);
  return { calib, ext, views: stereo.viewsForCamera({ width: W, height: H, sbs: true, calib, ext, label: 'zed' }) };
}

function zedSource(ext) {
  const { views, calib } = zedViews(ext);
  return { prefKey: 'zed', deviceId: 'zed', label: 'ZED', role: 'both', fps: 60, views, calib,
           cls: { kind: 'zed' }, tasks: { face: true, hands: true } };
}

// The source's views as PinholeCameras, which is what the Tracker triangulates with.
const camerasOf = src => src.views.map((v, i) =>
  cameraForView(v, { id: camIdFor(src, i), role: 'both', fps: src.fps, noisePx: 1 }));

// Project a world point (CENTIMETRES, app frame) into one camera, as MediaPipe would report it.
function shoot(camera, pCm) {
  const p = camera.project([pCm[0] * MM_PER_CM, pCm[1] * MM_PER_CM, pCm[2] * MM_PER_CM]);
  return p.inFront ? { x: p.u / camera.width, y: p.v / camera.height, z: 0, inFrame: p.inFrame } : null;
}

// A 21-landmark hand in world cm, from the simulator's hand model (which works in mm).
function handCm(centreCm, pinch01) {
  return handPose({ centre: centreCm.map(v => v * MM_PER_CM), pinch01, handedness: 'Right' })
    .map(p => [p[0] / MM_PER_CM, p[1] / MM_PER_CM, p[2] / MM_PER_CM]);
}

// The input object public/js/input/state.js exports, without importing three into a unit test.
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
const makeInput = () => ({
  mode: 'none', eye: vec(0, 0, 55), faceSeenAt: -1e9,
  hands: [0, 1].map(() => ({ active: false, tip: vec(), grip: vec(), gripRaw: vec(),
                             pinch: false, pinchRatio: 1, jointsWorld: null, seenAt: -1e9 })),
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distA = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------- 1. the geometry seam

test('a capture view and its PinholeCamera are the same camera', () => {
  const ext = { posCm: [3, 14, -2], rotDeg: [4, -7, 180] };
  const { views } = zedViews(ext);
  let worst = 0;
  for (const view of views) {
    const camera = cameraForView(view, { id: view.label });
    // the lens sits where the ray path says it does, in mm
    assert.ok(distA(camera.position, view.origin.map(v => v * MM_PER_CM)) < 1e-9, 'lens centre');
    for (const uv of [[0.5, 0.5], [0.2, 0.3], [0.85, 0.72]]) {
      const a = view.ray(uv[0], uv[1]).dir;                                     // cm path, unit direction
      const b = camera.ray(uv[0] * camera.width, uv[1] * camera.height).d;      // mm path, unit direction
      worst = Math.max(worst, distA(a, b));
    }
  }
  console.log(`      ray directions from the two paths differ by at most ${worst.toExponential(2)}`);
  assert.ok(worst < 1e-9, `the two descriptions of the same camera disagree by ${worst}`);
});

test('a point a ZED sees comes back in world centimetres', () => {
  const src = zedSource({ posCm: [0, 10, -5], rotDeg: [0, 0, 180] });
  const cams = camerasOf(src);
  const solver = createSolver();
  for (const c of cams) solver.addCamera(c);
  const input = makeInput();

  const truth = [4, -3, 42];                                  // world cm, in front of the camera
  const hand = handCm(truth, 1);
  let t = 0;
  for (let f = 0; f < 6; f++) {
    t += 16;
    for (const c of cams) {
      const lm = hand.map(p => { const q = shoot(c, p); return q && [q.x, q.y, 0]; });
      if (lm.some(p => !p)) continue;
      solver.tracker.observe2D({ camId: c.id, tMs: t,
        hands: [{ handedness: 'Right', score: 1, landmarks: lm.map(p => ({ x: p[0], y: p[1], z: 0 })) }],
        normalized: true });
    }
    solver.step(input, t);
  }
  const wrist = { x: input.jointsUnused, y: 0 };  // silence linters; the real check is below
  void wrist;
  const got = [input.hands[0].jointsWorld[0], input.hands[0].jointsWorld[1], input.hands[0].jointsWorld[2]];
  const want = hand[HAND.WRIST];
  const err = distA(got, want) * 10;
  console.log(`      wrist recovered at ${got.map(v => v.toFixed(2)).join(', ')} cm, truth ${want.map(v => v.toFixed(2)).join(', ')} cm -> ${err.toFixed(2)} mm`);
  assert.ok(input.hands[0].active, 'the hand reached the shared input object');
  assert.ok(err < 3, `wrist off by ${err.toFixed(2)} mm`);
  assert.equal(input.mode, 'camera', 'input.mode stays the two-valued contract the app reads');
});

test('the bridge lands in the same frame as the cameras, to the millimetre', () => {
  const solver = createSolver();
  const input = makeInput();
  const hand = handCm([2, -4, 38], 1);
  for (let f = 0; f < 4; f++) {
    const t = 16 * (f + 1);
    // ZedClient hands over world CENTIMETRES; observeBridge is what turns them into the solver's mm
    solver.observeBridge({ at: t, source: 'bridge', hands: [{ handedness: 'right', score: 1, world: hand }] });
    solver.step(input, t);
  }
  const tip = input.hands[0].tip;
  const err = dist(tip, { x: hand[HAND.INDEX_TIP][0], y: hand[HAND.INDEX_TIP][1], z: hand[HAND.INDEX_TIP][2] }) * 10;
  console.log(`      bridge fingertip ${err.toFixed(2)} mm from where the bridge said it was (filter lag included)`);
  assert.ok(input.hands[0].active);
  assert.ok(err < 12, `bridge fingertip off by ${err.toFixed(1)} mm`);
});

test('a bridge that goes quiet stops being believed', () => {
  const solver = createSolver();
  const input = makeInput();
  solver.observeBridge({ at: 100, source: 'bridge', hands: [{ handedness: 'right', world: handCm([0, 0, 40], 1) }] });
  solver.step(input, 100);
  assert.ok(solver.tracker.bridge, 'fresh bridge data is held');
  solver.step(input, 100 + 400);
  assert.equal(solver.tracker.bridge, null, 'a 400 ms old payload is dropped, not reused');
});

// ---------------------------------------------------------------- 2. the landmark/handedness seams

test('the landmark shapes the worker and the bridge speak both convert', () => {
  const lm = Array.from({ length: 21 }, (_, i) => [i / 100, i / 50, i / 200]);
  const hands = handsForTracker([{ handedness: 'Left', score: 0.9, lm }]);
  assert.equal(hands.length, 1);
  assert.equal(hands[0].landmarks.length, 21);
  assert.deepEqual(hands[0].landmarks[8], { x: 0.08, y: 0.16, z: 0.04 });
  assert.equal(handsForTracker([{ handedness: 'Right', lm: lm.slice(0, 20) }]).length, 0, 'a short hand is not a hand');

  assert.equal(normHandedness('left'), 'Left');
  assert.equal(normHandedness('Right'), 'Right');
  assert.equal(normHandedness('?'), 'Unknown');

  const face = faceForTracker({ eyes: [[0.4, 0.5, 0], [0.6, 0.5, 0]] });
  assert.deepEqual(face, [{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }]);
  assert.equal(faceForTracker(null), null);
  assert.equal(faceForTracker({ eyes: [[0.4, 0.5]] }), null, 'one iris is not a face');
});

// ---------------------------------------------------------------- 3. the grab seam

test('a landmark the solver could not triangulate does not poison the grab', () => {
  const input = makeInput();
  const h = input.hands[0];
  h.active = true; h.seenAt = 0; h.pinch = true;
  h.gripRaw.set(1, 2, 30);
  h.jointsWorld = new Float32Array(63);
  h.jointsWorld[HAND.THUMB_TIP * 3] = NaN;                  // the thumb was hidden behind the palm
  const hands = handsFromInput(input, 0, { unitsPerMetre: 100 });
  assert.equal(hands.length, 1);
  assert.equal(hands[0].thumb, undefined, 'it must not hand grab.js a NaN pinch pair');
  assert.equal(hands[0].pinch, true, 'it falls back to the solver\'s own pinch decision');
  assert.ok(Math.abs(hands[0].grip.z - 30) < 1e-9, 'and to the grip point, still in scene units');
});

test('the hands and the thresholds are in the SAME units', () => {
  // The join that silently broke: hands in metres against thresholds in centimetres. Neither throws.
  const input = makeInput();
  const h = input.hands[0];
  h.active = true; h.seenAt = 0;
  h.jointsWorld = new Float32Array(63);
  const put = (i, p) => { h.jointsWorld[i * 3] = p[0]; h.jointsWorld[i * 3 + 1] = p[1]; h.jointsWorld[i * 3 + 2] = p[2]; };
  put(HAND.THUMB_TIP, [0, 0, 40]);
  put(HAND.INDEX_TIP, [7, 0, 40]);                          // a 7 cm gap: wide open
  const scene = createSceneGrab({ unitsPerMetre: 100 });
  const hands = scene.hands(input, 0);
  const gap = Math.hypot(hands[0].index.x - hands[0].thumb.x, hands[0].index.y - hands[0].thumb.y,
                         hands[0].index.z - hands[0].thumb.z);
  console.log(`      a 7 cm gap measures ${gap} against a pinchOn of ${scene.config.pinchOn}`);
  assert.ok(Math.abs(gap - 7) < 1e-9, `gap ${gap} is not in the config's units`);
  assert.ok(gap > scene.config.pinchOn * 2, 'an open hand must not read as pinched');
});

test('the centimetre scene gets centimetre thresholds', () => {
  const { config } = createSceneGrab({ unitsPerMetre: 100 });
  assert.ok(Math.abs(config.pinchOn - 2.5) < 1e-9, `pinchOn ${config.pinchOn}`);
  assert.ok(Math.abs(config.pinchOff - 3.0) < 1e-9);
  assert.ok(Math.abs(config.grabRadius - 7) < 1e-9);
  assert.ok(Math.abs(config.holdDeadband - 0.15) < 1e-9);
  console.log(`      cm scene: pinch ${config.pinchOn}/${config.pinchOff} cm, grab radius ${config.grabRadius} cm, volume ${config.volume.maxX} cm`);
});

// ---------------------------------------------------------------- 4. end to end, in one process

/**
 * Reach in, pinch, carry, let go — seen by a stereo pair, solved for real, handed to grab.js.
 * Everything is world centimetres because that is what the app works in.
 */
function runChain({ frames = 290, hz = 60, noisePx = 0, dropEvery = 0, seed = 3 } = {}) {
  const src = zedSource({ posCm: [0, 8, -4], rotDeg: [0, 0, 180] });
  const cams = camerasOf(src);
  const solver = createSolver();
  for (const c of cams) solver.addCamera(c);
  const input = makeInput();

  const scene = createSceneGrab({ unitsPerMetre: 100,
    overrides: { volume: { minX: -25, maxX: 25, minY: -20, maxY: 25, minZ: 20, maxZ: 60 }, floorY: -12 } });
  const body = { id: 'teapot', pose: { position: { x: -4, y: 0, z: 40 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 },
                 radius: 3.5, restOffset: 2.0 };
  const events = [];
  for (const name of ['grabStart', 'grabEnd', 'settleEnd']) scene.grab.on(name, e => events.push({ name, ...e }));

  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

  // reach (0-1 s), pinch shut (1-1.3), carry (1.3-2.2), hold still (2.2-3.0), open (3.0-3.3), withdraw.
  // The still stretch in the middle is there on purpose: shake is only visible when the hand is not moving,
  // and a step taken while carrying is mostly real travel, not jitter.
  const START = [-4, 8, 46], AT = [-4, 0, 40], CARRIED = [8, 5, 36];
  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const truthAt = sec => {
    if (sec < 1.0) return { c: mix(START, AT, smooth(sec / 1.0)), pinch01: 1 };
    if (sec < 1.3) return { c: AT, pinch01: 1 - smooth((sec - 1.0) / 0.3) };
    if (sec < 2.2) return { c: mix(AT, CARRIED, smooth((sec - 1.3) / 0.9)), pinch01: 0 };
    if (sec < 3.0) return { c: CARRIED, pinch01: 0 };
    if (sec < 3.3) return { c: CARRIED, pinch01: smooth((sec - 3.0) / 0.3) };
    return { c: mix(CARRIED, START, smooth((sec - 3.3) / 1.0)), pinch01: 1 };
  };

  // 2 cm/s is "not moving" for a hand; the carry above runs at about 15 cm/s.
  const meter = createLagMeter({ windowMs: 2200, stillSpeed: 2 });      // filtered hand -> body
  const total = createLagMeter({ windowMs: 2200, stillSpeed: 2 });      // the REAL hand -> body
  const log = [];
  for (let f = 0; f < frames; f++) {
    const now = (f * 1000) / hz;
    const t = truthAt(now / 1000);
    const hand = handCm(t.c, t.pinch01);
    if (!(dropEvery && f % dropEvery === 0)) {
      for (const c of cams) {
        const lm = hand.map(p => {
          const q = shoot(c, p);
          return q && q.inFrame ? { x: q.x + gauss() * noisePx / c.width, y: q.y + gauss() * noisePx / c.height, z: 0 } : null;
        });
        if (lm.some(p => !p)) continue;
        solver.tracker.observe2D({ camId: c.id, tMs: now, hands: [{ handedness: 'Right', score: 1, landmarks: lm }], normalized: true });
      }
    }
    solver.step(input, now);
    const frame = scene.step(input, [body], now);
    const gh = frame.hands[0];
    // Only while the body is actually being driven by the hand: the rest of the time it is standing still
    // and would report a perfect zero lag and zero shake, which is a measurement of nothing.
    if (gh?.point && frame.holds.length) {
      meter.push(now, gh.point, body.pose.position);
      const g = hand[HAND.THUMB_TIP].map((v, i) => (v + hand[HAND.INDEX_TIP][i]) / 2);
      total.push(now, { x: g[0], y: g[1], z: g[2] }, body.pose.position);
    }
    log.push({ now, truthTip: hand[HAND.INDEX_TIP], solvedTip: [input.hands[0].tip.x, input.hands[0].tip.y, input.hands[0].tip.z],
               held: !!frame.holds.length, pinched: !!gh?.pinched, pos: { ...body.pose.position },
               gapCm: gh ? gh.gap : null });
  }
  return { log, events, body, meter, total, scene, solver, input };
}

test('a model is picked up, carried and put down, from stereo landmarks through the real solver', () => {
  const r = runChain({ noisePx: 0.6 });
  const starts = r.events.filter(e => e.name === 'grabStart');
  const ends = r.events.filter(e => e.name === 'grabEnd');

  const tipErr = r.log.filter(l => Number.isFinite(l.solvedTip[0]))
    .map(l => distA(l.solvedTip, l.truthTip) * 10);
  const meanTip = tipErr.reduce((a, b) => a + b, 0) / tipErr.length;
  const heldFrames = r.log.filter(l => l.held).length;
  const start = r.log[0].pos, end = r.body.pose.position;

  console.log(`      fingertip vs truth: mean ${meanTip.toFixed(2)} mm over ${tipErr.length} frames`);
  console.log(`      grabStart x${starts.length}, grabEnd x${ends.length} (${ends.map(e => e.reason).join(',')}), held for ${heldFrames} frames`);
  console.log(`      teapot moved from ${[start.x, start.y, start.z].map(v => v.toFixed(1)).join(', ')} to ${[end.x, end.y, end.z].map(v => v.toFixed(1)).join(', ')} cm`);

  assert.equal(starts.length, 1, 'exactly one grab');
  assert.equal(ends.length, 1, 'exactly one release');
  assert.equal(ends[0].reason, 'released', 'released, not lost');
  assert.ok(heldFrames > 60, `held for ${heldFrames} frames`);
  assert.ok(dist(start, end) > 8, `the model actually moved (${dist(start, end).toFixed(1)} cm)`);
  assert.ok(meanTip < 5, `fingertip error ${meanTip.toFixed(2)} mm`);
});

test('the held model lags the hand by a few tens of ms and barely shakes', () => {
  const r = runChain({ noisePx: 1.0 });
  const lag = r.meter.lagMs();
  const all = r.total.lagMs();
  const jit = r.meter.jitter();
  console.log(`      REAL hand -> object lag ${all.ms.toFixed(1)} ms end to end (correlation ${all.r.toFixed(2)})`);
  console.log(`      filtered hand -> object lag ${lag.ms.toFixed(1)} ms (speed-trace correlation ${lag.r.toFixed(2)}, ${lag.n} held samples at ${lag.dtMs.toFixed(1)} ms)`);
  console.log(`      held-object jitter ${(jit.rms * 10).toFixed(2)} mm rms, worst step ${(jit.worst * 10).toFixed(2)} mm, over ${jit.n} near-still held frames`);
  assert.ok(lag.n > 60, `only ${lag.n} held samples to measure from`);
  assert.ok(lag.r > 0.5, `the two speed traces barely correlate (r = ${lag.r.toFixed(2)}): the lag figure would be meaningless`);
  assert.ok(lag.ms >= 0 && lag.ms < 120, `lag ${lag.ms.toFixed(1)} ms`);
  assert.ok(all.ms >= 0 && all.ms < 150, `end-to-end lag ${all.ms.toFixed(1)} ms`);
  assert.ok(jit.n > 20, `only ${jit.n} still frames`);
  assert.ok(jit.rms * 10 < 3, `jitter ${(jit.rms * 10).toFixed(2)} mm rms`);
});

test('the grab survives the cameras dropping frames', () => {
  const r = runChain({ noisePx: 1.0, dropEvery: 7 });       // ~14% of frames see nothing at all
  const ends = r.events.filter(e => e.name === 'grabEnd');
  const lost = ends.filter(e => e.reason === 'lost');
  console.log(`      with 1 frame in 7 dropped: ${r.events.filter(e => e.name === 'grabStart').length} grabs, ` +
              `${ends.length} releases, ${lost.length} of them because tracking was lost`);
  assert.equal(lost.length, 0, 'a dropped frame must not drop the model');
  assert.ok(r.events.some(e => e.name === 'grabStart'), 'it still grabs');
});
