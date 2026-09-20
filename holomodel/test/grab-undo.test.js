// One undo record per manipulation, holding the pose before and the pose after — including the settle, so
// "undo" after a drop puts the model back where it was, not where it bounced to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrab, applyRecord } from '../public/js/interact/grab.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { makeBody, handFrame, run } from '../public/js/interact/replay.js';
import { qangle, vdist } from '../public/js/interact/math.js';

const wideVolume = () => {
  const c = cloneConfig(GRAB_CONFIG);
  c.volume = { minX: -2, maxX: 2, minY: -2, maxY: 2, minZ: -2, maxZ: 2 };
  return c;
};
const at = (x, y, z) => ({ x, y, z });

// pinch at `from`, carry to `to`, let go, wait for the settle
function pickAndPlace(grab, body, from, to, t0 = 0) {
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, from, 0.012, now)], t0 });
  run({ grab, bodies: [body], durationMs: 600, hands: now => [handFrame(0, to, 0.012, now)], t0: t0 + 350 });
  run({ grab, bodies: [body], durationMs: 3000, hands: now => [handFrame(0, to, 0.070, now)], t0: t0 + 1000 });
  return t0 + 4100;
}

test('one manipulation makes one record, with the pose before and after', () => {
  const config = wideVolume();
  config.settleGravity = 0; config.throwGain = 0;
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const grab = createGrab({ config });
  const start = { ...body.pose.position };
  pickAndPlace(grab, body, at(0, 0.12, 0), at(0.08, 0.16, -0.02));

  assert.equal(grab.undos.length, 1);
  const rec = grab.undos[0];
  assert.equal(rec.bodyId, 'b');
  assert.equal(rec.kind, 'one');
  assert.deepEqual(rec.handIds, [0]);
  assert.equal(rec.reason, 'released');
  assert.equal(rec.settled, true);
  assert.ok(vdist(rec.before.position, start) < 1e-9, 'before is exactly where it was');
  assert.ok(vdist(rec.after.position, body.pose.position) < 1e-9, 'after is exactly where it ended');
  assert.ok(vdist(rec.before.position, rec.after.position) > 0.05, 'and they differ');
  assert.ok(rec.startedAt < rec.endedAt);
});

test('a record round-trips: undo puts it back, redo puts it forward', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0.02, 0.14, 0.01), radius: 0.06, restOffset: 0 });
  const grab = createGrab({ config });
  const start = { ...body.pose.position };
  pickAndPlace(grab, body, at(0.02, 0.14, 0.01), at(-0.06, 0.20, 0.04));
  const landed = { ...body.pose.position };

  applyRecord(body, grab.undos[0], 'undo');
  assert.ok(vdist(body.pose.position, start) < 1e-9);
  applyRecord(body, grab.undos[0], 'redo');
  assert.ok(vdist(body.pose.position, landed) < 1e-9);
});

test('the record covers the settle, not just the release', () => {
  const config = cloneConfig(GRAB_CONFIG);
  const body = makeBody({ id: 'b', position: at(0, 0.25, 0), radius: 0.05, restOffset: 0.03 });
  const grab = createGrab({ config });
  let releasePose = null;
  grab.on('grabEnd', e => { releasePose = e.pose; });
  pickAndPlace(grab, body, at(0, 0.25, 0), at(0.04, 0.26, 0));

  const rec = grab.undos[0];
  assert.ok(releasePose.position.y > 0.2, 'it was let go high up');
  assert.ok(Math.abs(rec.after.position.y - (config.floorY + 0.03)) < 1e-6,
    'and the record ends on the floor, where it actually came to rest');
  assert.equal(rec.settled, true);
});

test('each pick-and-place adds one more record, oldest first', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06, restOffset: 0 });
  const grab = createGrab({ config });
  let t = 0;
  t = pickAndPlace(grab, body, at(0, 0.12, 0), at(0.06, 0.12, 0), t);
  t = pickAndPlace(grab, body, { ...body.pose.position }, at(0.12, 0.12, 0), t);
  t = pickAndPlace(grab, body, { ...body.pose.position }, at(0.18, 0.12, 0), t);
  assert.equal(grab.undos.length, 3);
  assert.ok(grab.undos[0].startedAt < grab.undos[1].startedAt);
  assert.ok(grab.undos[1].startedAt < grab.undos[2].startedAt);
  for (let i = 1; i < 3; i++) {
    assert.ok(vdist(grab.undos[i - 1].after.position, grab.undos[i].before.position) < 1e-9,
      'each record starts where the last one ended');
  }
  // undoing them in reverse puts the model back at the very start
  for (let i = 2; i >= 0; i--) applyRecord(body, grab.undos[i], 'undo');
  assert.ok(vdist(body.pose.position, at(0, 0.12, 0)) < 1e-9);
});

test('a two-hand manipulation records the turn and the resize too', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, at(-0.06, 0.12, 0), 0.012, now)] });
  run({
    grab, bodies: [body], durationMs: 1400, t0: 400,
    hands: now => {
      const u = Math.min(1, (now - 500) / 900);
      const a = { x: -0.06 - 0.06 * u, y: 0.12, z: -0.06 * u };
      const b = { x: 0.06 + 0.06 * u, y: 0.12, z: 0.06 * u };
      return [handFrame(0, a, 0.012, now), handFrame(1, b, 0.012, now)];
    },
  });
  run({
    grab, bodies: [body], durationMs: 2500, t0: 1900,
    hands: now => [handFrame(0, at(-0.12, 0.12, -0.06), 0.070, now), handFrame(1, at(0.12, 0.12, 0.06), 0.070, now)],
  });

  assert.equal(grab.undos.length, 1);
  const rec = grab.undos[0];
  assert.equal(rec.kind, 'two');
  assert.deepEqual(rec.handIds, [0, 1]);
  assert.equal(rec.before.scale, 1);
  assert.ok(rec.after.scale > 1.5, `recorded scale ${rec.after.scale.toFixed(2)}`);
  assert.ok(qangle(rec.after.quaternion, rec.before.quaternion) > 0.3, 'and the turn');

  applyRecord(body, rec, 'undo');
  assert.equal(body.pose.scale, 1);
  assert.ok(qangle(body.pose.quaternion, { x: 0, y: 0, z: 0, w: 1 }) < 1e-9);
});

test('a grab that changes nothing still records, and records nothing changing', () => {
  const config = wideVolume();
  config.settleGravity = 0; config.throwGain = 0;
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const grab = createGrab({ config });
  pickAndPlace(grab, body, at(0, 0.12, 0), at(0, 0.12, 0));
  assert.equal(grab.undos.length, 1);
  assert.ok(vdist(grab.undos[0].before.position, grab.undos[0].after.position) < 0.001,
    'a no-op grab leaves a no-op record, which the caller can drop');
});

test('takeUndos drains the list', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06, restOffset: 0 });
  const grab = createGrab({ config });
  pickAndPlace(grab, body, at(0, 0.12, 0), at(0.05, 0.12, 0));
  assert.equal(grab.takeUndos().length, 1);
  assert.equal(grab.undos.length, 0);
  assert.equal(grab.takeUndos().length, 0);
});

test('a hold lost to tracking is recorded as lost, not released', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06, restOffset: 0 });
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, at(0, 0.12, 0), 0.012, now)] });
  run({ grab, bodies: [body], durationMs: 1200, hands: () => [], t0: 500 });
  assert.equal(grab.undos.length, 1);
  assert.equal(grab.undos[0].reason, 'lost');
  assert.equal(grab.isHeld('b'), false);
});
