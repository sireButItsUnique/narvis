// Both hands on one model: turn it and resize it. The maths has to be anchored on the pose at the moment the
// second hand arrives, or the model jumps the instant you touch it with two hands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrab } from '../public/js/interact/grab.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { makeBody, handFrame, run } from '../public/js/interact/replay.js';
import { qangle, qmul, qFromUnitVectors, qFromAxisAngle, vdist, vmix } from '../public/js/interact/math.js';

const wideVolume = () => {
  const c = cloneConfig(GRAB_CONFIG);
  c.volume = { minX: -2, maxX: 2, minY: -2, maxY: 2, minZ: -2, maxZ: 2 };
  return c;
};
const at = (x, y, z) => ({ x, y, z });
const CENTRE = at(0, 0.12, 0);

// grab with both hands at ±half the span along x, then interpolate both to `to` over `ms` and hold
// The segments are CONTIGUOUS (each starts one frame after the last one ended) and the helper reports
// where it finished, so a caller that continues the timeline does not leave a dead stretch in which the
// hands were unseen. A hold-through window measured from the last sighting counts that stretch, and
// rightly: the hand really had not been seen.
const STEP = 1000 / 60;
function twoHandRun({ config, body, from, to, ms = 1200, settle = 600, grab = null }) {
  const g = grab || createGrab({ config });
  // hand 0 takes it, then hand 1 joins
  run({ grab: g, bodies: [body], durationMs: 300, hands: now => [handFrame(0, from[0], 0.012, now)] });
  const t1 = 300 + STEP;
  run({
    grab: g, bodies: [body], durationMs: 300, t0: t1,
    hands: now => [handFrame(0, from[0], 0.012, now), handFrame(1, from[1], 0.012, now)],
  });
  const t0 = t1 + 300 + STEP;
  run({
    grab: g, bodies: [body], durationMs: ms + settle, t0,
    hands: now => {
      const u = Math.min(1, (now - t0) / ms);
      return [handFrame(0, vmix(from[0], to[0], u), 0.012, now),
              handFrame(1, vmix(from[1], to[1], u), 0.012, now)];
    },
  });
  g.endAt = t0 + ms + settle;
  return g;
}

test('the second hand joining takes the pose as it is: no jump', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, at(-0.05, 0.12, 0), 0.012, now)] });
  const before = { ...body.pose.position };
  const beforeQ = { ...body.pose.quaternion };
  let worst = 0;
  run({
    grab, bodies: [body], durationMs: 300, t0: 500,
    hands: now => [handFrame(0, at(-0.05, 0.12, 0), 0.012, now), handFrame(1, at(0.05, 0.12, 0), 0.012, now)],
    onFrame: () => { worst = Math.max(worst, vdist(body.pose.position, before)); },
  });
  assert.equal(grab.holdOf('b').kind, 'two');
  assert.ok(worst < 0.002, `moved ${(worst * 1000).toFixed(2)} mm when the second hand arrived`);
  assert.ok(qangle(body.pose.quaternion, beforeQ) < 0.02);
});

test('turning the hands about the model turns the model by the same angle', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  // hands on the x axis, swung round to the z axis: a quarter turn about y
  const grab = twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(0, 0.12, -0.06), at(0, 0.12, 0.06)],
  });
  const expected = qFromUnitVectors({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  assert.equal(grab.holdOf('b').kind, 'two');
  assert.ok(qangle(body.pose.quaternion, expected) < 0.05,
    `turned to ${(qangle(body.pose.quaternion, { x: 0, y: 0, z: 0, w: 1 }) * 180 / Math.PI).toFixed(1)} deg`);
  assert.ok(Math.abs(qangle(body.pose.quaternion, { x: 0, y: 0, z: 0, w: 1 }) - Math.PI / 2) < 0.05, 'a quarter turn');
  assert.ok(Math.abs(body.pose.scale - 1) < 0.01, 'a pure turn must not resize it');
  assert.ok(vdist(body.pose.position, CENTRE) < 0.004, 'and must not move it');
});

test('spreading the hands resizes the model by the same ratio, less the deadband', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  const grab = twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(-0.12, 0.12, 0), at(0.12, 0.12, 0)],
  });
  assert.ok(Math.abs(body.pose.scale - (2 - config.scaleDeadband)) < 0.02,
    `scale ${body.pose.scale.toFixed(3)}, wanted ${(2 - config.scaleDeadband).toFixed(3)}`);
  assert.ok(qangle(body.pose.quaternion, { x: 0, y: 0, z: 0, w: 1 }) < 0.05, 'a pure resize must not turn it');
});

test('a small span wobble inside the deadband does not resize it at all', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  const grab = twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(-0.0605, 0.12, 0), at(0.0605, 0.12, 0)],   // 0.8% wider
  });
  assert.equal(body.pose.scale, 1);
  assert.equal(grab.isHeld('b'), true);
});

test('scale is clamped, so one bad frame cannot shrink the model to nothing', () => {
  const config = wideVolume();
  config.scaleMin = 0.5; config.scaleMax = 1.5;
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(-0.60, 0.12, 0), at(0.60, 0.12, 0)],
  });
  assert.equal(body.pose.scale, 1.5);
});

test('moving both hands together moves the model and leaves its orientation alone', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(-0.06 + 0.07, 0.12 + 0.05, -0.03), at(0.06 + 0.07, 0.12 + 0.05, -0.03)],
    settle: 900,
  });
  assert.ok(vdist(body.pose.position, at(0.07, 0.17, -0.03)) < 0.004,
    `at ${JSON.stringify(body.pose.position)}`);
  assert.ok(qangle(body.pose.quaternion, { x: 0, y: 0, z: 0, w: 1 }) < 0.03);
  assert.ok(Math.abs(body.pose.scale - 1) < 0.01);
});

test('one hand letting go leaves the other holding it, in place', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  const grab = twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(0, 0.12, -0.06), at(0, 0.12, 0.06)],
  });
  const before = { ...body.pose.position };
  const beforeQ = { ...body.pose.quaternion };
  let worst = 0;
  run({
    grab, bodies: [body], durationMs: 500, t0: 2800,
    hands: now => [handFrame(0, at(0, 0.12, -0.06), 0.012, now), handFrame(1, at(0, 0.12, 0.06), 0.070, now)],
    onFrame: () => { worst = Math.max(worst, vdist(body.pose.position, before)); },
  });
  assert.equal(grab.isHeld('b'), true, 'still held by hand 0');
  assert.equal(grab.holdOf('b').kind, 'one');
  assert.deepEqual(grab.holdOf('b').handIds, [0]);
  assert.ok(worst < 0.003, `moved ${(worst * 1000).toFixed(2)} mm when the second hand left`);
  assert.ok(qangle(body.pose.quaternion, beforeQ) < 0.01, 'and kept the turn it was given');
});

test('one of the two hands blinking out does not jerk the model', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: CENTRE, radius: 0.06 });
  const grab = twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(0, 0.12, -0.06), at(0, 0.12, 0.06)],
  });
  const before = { ...body.pose.position };
  const beforeQ = { ...body.pose.quaternion };
  let worst = 0;
  // hand 1 disappears for 150 ms while hand 0 keeps reporting, then comes back
  const blinkAt = grab.endAt + STEP;
  run({
    grab, bodies: [body], durationMs: 150, t0: blinkAt,
    hands: now => [handFrame(0, at(0, 0.12, -0.06), 0.012, now)],
    onFrame: () => { worst = Math.max(worst, vdist(body.pose.position, before)); },
  });
  assert.equal(grab.holdOf('b').kind, 'two', 'still a two-hand hold');
  assert.ok(worst < 0.001, `moved ${(worst * 1000).toFixed(2)} mm while one hand was missing`);
  assert.ok(qangle(body.pose.quaternion, beforeQ) < 0.005);
  run({
    grab, bodies: [body], durationMs: 300, t0: blinkAt + 150 + STEP,
    hands: now => [handFrame(0, at(0, 0.12, -0.06), 0.012, now), handFrame(1, at(0, 0.12, 0.06), 0.012, now)],
    onFrame: () => { worst = Math.max(worst, vdist(body.pose.position, before)); },
  });
  assert.ok(worst < 0.004, `moved ${(worst * 1000).toFixed(2)} mm across the blink and back`);
  assert.equal(grab.isHeld('b'), true);
});

test('a two-hand turn composes onto an orientation the model already had', () => {
  const config = wideVolume();
  const start = qFromAxisAngle({ x: 1, y: 0, z: 0 }, 1.05);   // already tipped 60 deg about x
  const body = makeBody({ id: 'b', position: CENTRE, quaternion: start, radius: 0.06 });
  twoHandRun({
    config, body,
    from: [at(-0.06, 0.12, 0), at(0.06, 0.12, 0)],
    to: [at(0, 0.12, -0.06), at(0, 0.12, 0.06)],
  });
  // the hands' quarter turn is applied in WORLD space, on top of whatever the model already was
  const expected = qmul(qFromUnitVectors({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), start);
  assert.ok(qangle(body.pose.quaternion, expected) < 0.05,
    `off by ${(qangle(body.pose.quaternion, expected) * 180 / Math.PI).toFixed(1)} deg`);
  assert.ok(qangle(body.pose.quaternion, start) > 1.4, 'and it really did turn');
});
