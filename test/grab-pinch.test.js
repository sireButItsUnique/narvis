// The pinch state machine: does it commit when the user means it, and stay committed when the numbers wobble?
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrab } from '../public/js/interact/grab.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { makeBody, handFrame, run } from '../public/js/interact/replay.js';
import { rng, gauss } from '../public/js/interact/track.js';

const wideVolume = () => {
  const c = cloneConfig(GRAB_CONFIG);
  c.volume = { minX: -2, maxX: 2, minY: -2, maxY: 2, minZ: -2, maxZ: 2 };
  return c;
};
const at = (x, y, z) => ({ x, y, z });

test('a gap dithering across the thresholds never starts a grab, and never ends one either', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.05 });
  const r = rng(42);
  const grip = at(0, 0.12, 0);

  // Phase 1: sit in the dead zone between pinchOn (25 mm) and pinchOff (30 mm) with 3 mm of noise for 2 s.
  // One threshold would flutter here dozens of times; two must not fire at all.
  const phase1 = run({
    config, bodies: [body], durationMs: 2000,
    hands: now => [handFrame(0, grip, 0.0275 + gauss(r) * 0.003, now)],
  });
  assert.equal(phase1.count('grabStart'), 0, 'the dead zone must not start a grab');

  // Phase 2: a real pinch, then dither in the dead zone again. It must hold.
  const grab = phase1.grab;
  const phase2 = run({
    grab, bodies: [body], durationMs: 300,
    hands: now => [handFrame(0, grip, 0.015, now)],
    t0: 2100,
  });
  assert.equal(phase2.count('grabStart'), 1);
  const phase3 = run({
    grab, bodies: [body], durationMs: 2000,
    hands: now => [handFrame(0, grip, 0.0275 + gauss(r) * 0.003, now)],
    t0: 2500,
  });
  assert.equal(phase3.count('grabEnd'), 0, 'the dead zone must not drop what is already held');
  assert.equal(grab.isHeld('b'), true);
});

test('stickiness means an established grab survives a wider wobble than it needed to start', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.05 });
  const grip = at(0, 0.12, 0);
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, grip, 0.012, now)] });
  assert.equal(grab.isHeld('b'), true);
  // 33 mm is past pinchOff, but pinchStick (0.85) scales it to 28 mm: still held.
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, grip, 0.033, now)], t0: 400 });
  assert.equal(grab.isHeld('b'), true, '33 mm * 0.85 = 28 mm, inside pinchOff');
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, grip, 0.040, now)], t0: 900 });
  assert.equal(grab.isHeld('b'), false, '40 mm * 0.85 = 34 mm, outside it');
});

test('a single-frame blip below the threshold does not grab', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.05 });
  const grip = at(0, 0.12, 0);
  const r = run({
    config, bodies: [body], hz: 60, durationMs: 1000,
    // one frame in twelve reads as closed: exactly the kind of blip a dropped landmark produces
    hands: (now, i) => [handFrame(0, grip, i % 12 === 0 ? 0.010 : 0.060, now)],
  });
  assert.equal(r.count('grabStart'), 0);
});

test('a pinch takes what the OPEN hand meant, not what the closing fingers drifted onto', () => {
  const config = wideVolume();
  const wanted = makeBody({ id: 'wanted', position: at(0, 0.12, 0), radius: 0.03 });
  const other = makeBody({ id: 'other', position: at(0.10, 0.12, 0), radius: 0.03 });
  // hover over `wanted`, then the act of pinching drags the grip point most of the way to `other`
  const r = run({
    config, bodies: [wanted, other], durationMs: 900,
    hands: now => (now < 500
      ? [handFrame(0, at(0, 0.12, 0), 0.070, now)]
      : [handFrame(0, at(0.075, 0.12, 0), 0.012, now)]),
  });
  assert.equal(r.grab.isHeld('wanted'), true, 'intent memory keeps the body the open hand was on');
  assert.equal(r.grab.isHeld('other'), false);
});

test('a single jittery frame next to another part cannot steal the intent', () => {
  const config = wideVolume();
  const a = makeBody({ id: 'a', position: at(0, 0.12, 0), radius: 0.03 });
  const b = makeBody({ id: 'b', position: at(0.06, 0.12, 0), radius: 0.03 });
  const r = run({
    config, bodies: [a, b], hz: 60, durationMs: 900,
    hands: (now, i) => {
      // parked on `a`, but every 10th frame the tracker reports the hand right on top of `b`
      const bad = i % 10 === 0 && now < 600;
      const grip = bad ? at(0.06, 0.12, 0) : at(0, 0.12, 0);
      return [handFrame(0, grip, now < 600 ? 0.070 : 0.012, now)];
    },
  });
  assert.equal(r.grab.isHeld('a'), true);
  assert.equal(r.grab.isHeld('b'), false);
});

test('a sustained move to another part does change the intent', () => {
  const config = wideVolume();
  const a = makeBody({ id: 'a', position: at(0, 0.12, 0), radius: 0.03 });
  const b = makeBody({ id: 'b', position: at(0.06, 0.12, 0), radius: 0.03 });
  const r = run({
    config, bodies: [a, b], durationMs: 1400,
    hands: now => (now < 400 ? [handFrame(0, at(0, 0.12, 0), 0.070, now)]
      : now < 1000 ? [handFrame(0, at(0.06, 0.12, 0), 0.070, now)]
        : [handFrame(0, at(0.06, 0.12, 0), 0.012, now)]),
  });
  assert.equal(r.grab.isHeld('b'), true);
});

test('the hand that just dropped something cannot immediately catch it again', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.05, restOffset: 0 });
  const grip = at(0, 0.12, 0);
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, grip, 0.012, now)] });
  assert.equal(grab.isHeld('b'), true);
  run({ grab, bodies: [body], durationMs: 200, hands: now => [handFrame(0, grip, 0.070, now)], t0: 500 });
  assert.equal(grab.isHeld('b'), false);
  // re-pinch straight away, well inside regrabLockoutMs (500 ms): refused
  run({ grab, bodies: [body], durationMs: 150, hands: now => [handFrame(0, body.pose.position, 0.012, now)], t0: 720 });
  assert.equal(grab.isHeld('b'), false, 'inside the lockout');
  // open, then try again once the lockout has expired
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, body.pose.position, 0.070, now)], t0: 900 });
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, body.pose.position, 0.012, now)], t0: 1400 });
  assert.equal(grab.isHeld('b'), true, 'after it');
});

test('nothing within grabRadius means nothing is grabbed', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.02 });
  const r = run({
    config, bodies: [body], durationMs: 600,
    hands: now => [handFrame(0, at(0.30, 0.12, 0), 0.012, now)],
  });
  assert.equal(r.count('grabStart'), 0);
  assert.equal(r.grab.isHeld('b'), false);
});
