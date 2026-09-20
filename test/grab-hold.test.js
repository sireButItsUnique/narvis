// Holding: does the model stay where the hand put it, stay still while the hand shakes, survive the tracker
// blinking, and land where the user let go rather than where the flick threw it?
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrab } from '../public/js/interact/grab.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { makeBody, handFrame, run, replay, stepJitter, spread } from '../public/js/interact/replay.js';
import { createTracker, makeScript, demoScript, rng, gauss } from '../public/js/interact/track.js';
import { vdist, vsub } from '../public/js/interact/math.js';

const wideVolume = () => {
  const c = cloneConfig(GRAB_CONFIG);
  c.volume = { minX: -2, maxX: 2, minY: -2, maxY: 2, minZ: -2, maxZ: 2 };
  return c;
};
const at = (x, y, z) => ({ x, y, z });
const mm = v => v * 1000;

test('the anchor keeps the offset: the body moves with the hand, it does not jump into it', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  // pinch 4 cm to the side of the centre and 2 cm below it
  const grabAt = at(0.04, 0.10, 0.01);
  const offset = vsub(body.pose.position, grabAt);
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, grabAt, 0.012, now)] });
  assert.equal(grab.isHeld('b'), true);
  assert.ok(vdist(body.pose.position, at(0, 0.12, 0)) < 0.001, 'grabbing must not move it');

  const moved = at(grabAt.x + 0.08, grabAt.y + 0.05, grabAt.z - 0.03);
  run({ grab, bodies: [body], durationMs: 800, hands: now => [handFrame(0, moved, 0.012, now)], t0: 500 });
  const keptOffset = vsub(body.pose.position, moved);
  assert.ok(vdist(keptOffset, offset) < 0.002,
    `offset drifted by ${mm(vdist(keptOffset, offset)).toFixed(2)} mm`);
});

test('a 30 Hz track with 8 mm of jitter does not make a held body shake', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const still = makeScript([
    { t: 0, grip: at(0, 0.12, 0), pinch: false },
    { t: 250, grip: at(0, 0.12, 0), pinch: true },
    { t: 6000, grip: at(0, 0.12, 0), pinch: true },
  ]);
  const tracker = createTracker({
    sources: [{ id: 0, script: still }],
    rateHz: 30, jitterSd: 0.008, lagMs: 0, dropout: null, seed: 3,
  });
  const held = [];
  const r = replay({
    config, tracker, bodies: [body], hz: 60, durationMs: 5000,
    onFrame: (f, now) => { if (now > 1200) held.push({ ...body.pose.position }); },
  });
  assert.equal(r.grab.isHeld('b'), true);

  const raw = stepJitter(r.handPoints.get(0).map(p => p).filter(p => p.t > 1200));
  const out = stepJitter(held);
  const sd = spread(held).sd;
  // What the eye sees is the frame-to-frame step. The raw 30 Hz track steps ~8*sqrt(2) mm per sensor frame;
  // anything the viewer would read as shimmer is above about 2 mm at this distance.
  assert.ok(out.rms < 0.0015, `held step jitter ${mm(out.rms).toFixed(2)} mm rms (filtered hand ${mm(raw.rms).toFixed(2)} mm)`);
  assert.ok(out.max < 0.005, `worst single step ${mm(out.max).toFixed(2)} mm`);
  assert.ok(sd < 0.008, `held position spread ${mm(sd).toFixed(2)} mm`);
  assert.ok(out.rms < raw.rms * 0.75, 'the held body must be steadier than the hand driving it');
});

test('the noise floor does not creep into the grab either: a still noisy hand holds a still body', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const r = rng(9);
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, at(0, 0.12, 0), 0.012, now)] });
  const start = { ...body.pose.position };
  run({
    grab, bodies: [body], durationMs: 4000, t0: 400,
    hands: now => [handFrame(0, at(gauss(r) * 0.008, 0.12 + gauss(r) * 0.008, gauss(r) * 0.008), 0.012, now)],
  });
  assert.ok(vdist(body.pose.position, start) < 0.012,
    `drifted ${mm(vdist(body.pose.position, start)).toFixed(1)} mm under pure noise`);
});

test('the hand may vanish for a dropout window without dropping the model, but not for longer', () => {
  const config = wideVolume();
  const STEP = 1000 / 60;
  const HELD = config.dropoutMs - 60, DROPPED = config.dropoutMs + 60;
  // The segments have to be CONTIGUOUS. They used to leave a 100 ms dead stretch between them, which the
  // old lost-clock silently forgave (it started counting at the first frame after the gap) and a window
  // measured from the last sighting correctly does not: the hand really had been unseen for 100 + gapMs.
  for (const [gapMs, expectHeld] of [[100, true], [HELD, true], [DROPPED, false]]) {
    const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
    const grab = createGrab({ config });
    const grip = at(0, 0.12, 0);
    const t1 = 400;
    run({ grab, bodies: [body], durationMs: t1, hands: now => [handFrame(0, grip, 0.012, now)] });
    assert.equal(grab.isHeld('b'), true);
    // the hand simply stops being reported; seenAt goes stale on its own
    run({ grab, bodies: [body], durationMs: gapMs - 2 * STEP, hands: () => [], t0: t1 + STEP });
    run({ grab, bodies: [body], durationMs: 200, hands: now => [handFrame(0, grip, 0.012, now)], t0: t1 + gapMs });
    assert.equal(grab.isHeld('b'), expectHeld, `a ${gapMs.toFixed(0)} ms dropout`);
  }
});

test('repeated dropouts through a carry neither drop the model nor let it slide out of the hand', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06 });
  const grab = createGrab({ config });
  const path = t => at(Math.min(0.10, (t - 500) * 0.0002), 0.12, 0);
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, at(0, 0.12, 0), 0.012, now)] });
  const offset = vsub(body.pose.position, at(0, 0.12, 0));
  const r = run({
    grab, bodies: [body], durationMs: 2500, t0: 400 + 1000 / 60,   // contiguous: no dead stretch to forgive
    // gone for 150 ms out of every 500
    hands: now => ((now % 500) < 150 ? [] : [handFrame(0, path(now), 0.012, now)]),
  });
  assert.equal(grab.isHeld('b'), true, 'never dropped');
  assert.equal(r.count('grabEnd'), 0);
  const kept = vsub(body.pose.position, path(3000));
  assert.ok(vdist(kept, offset) < 0.006,
    `the grip slid by ${mm(vdist(kept, offset)).toFixed(1)} mm over 5 dropouts`);
});

test('release uses the pose from before the fingers opened, so the flick is not part of the gesture', () => {
  const config = wideVolume();
  const body = makeBody({ id: 'b', position: at(0, 0.12, 0), radius: 0.06, restOffset: 0 });
  config.settleGravity = 0;   // isolate the release pose from the fall
  config.throwGain = 0;
  const holdAt = at(0.05, 0.15, -0.02);
  const flick = at(0.05 + 0.05, 0.15 - 0.02, -0.02 + 0.03);   // 6.2 cm of lurch as the fingers open
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, at(0, 0.12, 0), 0.012, now)] });
  run({ grab, bodies: [body], durationMs: 700, hands: now => [handFrame(0, holdAt, 0.012, now)], t0: 500 });
  const before = { ...body.pose.position };
  // the fingers open over 150 ms and the grip lurches with them
  let ended = null;
  grab.on('grabEnd', e => { ended = e; });
  run({
    grab, bodies: [body], durationMs: 600, t0: 1250,
    hands: now => {
      const u = Math.min(1, (now - 1250) / 150);
      const grip = { x: holdAt.x + (flick.x - holdAt.x) * u, y: holdAt.y + (flick.y - holdAt.y) * u, z: holdAt.z + (flick.z - holdAt.z) * u };
      return [handFrame(0, grip, 0.012 + u * 0.070, now)];
    },
  });
  assert.ok(ended, 'it let go');
  const drift = vdist(ended.pose.position, before);
  assert.ok(drift < 0.012, `released ${mm(drift).toFixed(1)} mm from where it was being held (flick was 62 mm)`);
});

test('a dropped model settles onto the floor of the working volume and stays inside it', () => {
  const config = cloneConfig(GRAB_CONFIG);
  const body = makeBody({ id: 'b', position: at(0, 0.22, 0), radius: 0.05, restOffset: 0.03 });
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 400, hands: now => [handFrame(0, at(0, 0.22, 0), 0.012, now)] });
  run({ grab, bodies: [body], durationMs: 3000, hands: now => [handFrame(0, at(0, 0.22, 0), 0.070, now)], t0: 500 });
  assert.equal(grab.isSettling('b'), false, 'the settle finished');
  assert.ok(Math.abs(body.pose.position.y - (config.floorY + 0.03)) < 1e-6,
    `resting at y=${body.pose.position.y}`);
  assert.ok(body.pose.position.x >= config.volume.minX && body.pose.position.x <= config.volume.maxX);
});

test('a hard throw is clamped and still lands inside the volume', () => {
  const config = cloneConfig(GRAB_CONFIG);
  config.throwGain = 1;
  const body = makeBody({ id: 'b', position: at(0, 0.20, 0), radius: 0.04, restOffset: 0.02 });
  const grab = createGrab({ config });
  run({ grab, bodies: [body], durationMs: 300, hands: now => [handFrame(0, at(0, 0.20, 0), 0.012, now)] });
  // 3 m/s sideways, then let go
  run({
    grab, bodies: [body], durationMs: 200, t0: 400,
    hands: now => [handFrame(0, at((now - 400) * 0.003, 0.20, 0), 0.012, now)],
  });
  run({ grab, bodies: [body], durationMs: 3000, hands: now => [handFrame(0, at(0.6, 0.20, 0), 0.070, now)], t0: 650 });
  const p = body.pose.position;
  assert.ok(p.x <= config.volume.maxX + 1e-9 && p.x >= config.volume.minX - 1e-9, `x=${p.x}`);
  assert.ok(p.y >= config.floorY - 1e-9, `y=${p.y}`);
  assert.equal(grab.isSettling('b'), false);
});

test('the whole reach-grab-carry-drop runs end to end on a bad track and lands where it was let go', () => {
  const body = makeBody({ id: 'teapot', position: at(0, 0.12, 0), radius: 0.05, restOffset: 0.03 });
  const tracker = createTracker({
    sources: [{ id: 0, script: demoScript() }],
    rateHz: 30, jitterSd: 0.008, lagMs: 150, dropout: { everyMs: 1400, forMs: 180 }, seed: 11,
  });
  const r = replay({ tracker, bodies: [body], hz: 60, durationMs: 4200 });
  assert.equal(r.count('grabStart'), 1, 'grabbed exactly once');
  assert.equal(r.count('grabEnd'), 1);
  assert.equal(r.count('settleEnd'), 1);
  assert.equal(r.events.find(e => e.name === 'grabEnd').reason, 'released', 'let go on purpose, not lost');
  // the carry target is (0.08, 0.20, -0.04); the body keeps whatever offset it was grabbed with and then falls
  assert.ok(Math.abs(body.pose.position.y - 0.03) < 1e-6, 'came to rest on the floor');
  assert.ok(Math.abs(body.pose.position.x - 0.08) < 0.04, `landed at x=${body.pose.position.x.toFixed(3)}`);
});
