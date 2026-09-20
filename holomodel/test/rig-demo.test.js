// SPDX-License-Identifier: GPL-3.0-or-later
// The demo without a browser, a camera or a hand: `node --test` in this folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGrab, makeDemo, makeGrabWorld, stepGrabWorld, makeSurfaceWorld, stepSurfaceWorld, membraneHeight,
         gapFromPoints, supportY, GRAB_DEFAULTS } from '../public/js/rig/demo.js';
import { makeHandSmoother, makeHandGate, validGate, GATE_DEFAULTS } from '../public/js/rig/hands.js';
import { parseBridgeMessage as parseMessage, parsePinch, parseQuality, ZedClient } from '../public/js/input/zed-client.js';
import { mergeSetup, DEFAULT_SETUP } from '../public/js/rig/rig-setup.js';

const FLOOR = -13.5;
// A hand whose thumb and index tips straddle `point`: palm 8 cm long, reaching in from the viewer's side.
function handAt(point, gapCm) {
  const [x, y, z] = point, pts = Array.from({ length: 21 }, () => [x, y + 2, z + 7]);
  pts[0] = [x, y + 1, z + 14];
  pts[5] = [x - 3, y + 2, z + 6.5]; pts[9] = [x - 1, y + 2, z + 6]; pts[13] = [x + 1, y + 2, z + 6.5]; pts[17] = [x + 3, y + 2, z + 7];
  pts[4] = [x - gapCm / 2, y, z]; pts[8] = [x + gapCm / 2, y, z]; pts[12] = [x + gapCm / 2 + 2.5, y + 0.5, z];
  return pts;
}
const OPEN = 8, SHUT = 1.2;          // cm between the tips: 1.0 and 0.15 of the palm
// Drive a demo along straight segments at 60 Hz. Each leg: { to, gap, ms, hand: false to drop the hand out }.
function drive(demo, legs, start, t0 = 0) {
  let at = start.slice(), t = t0;
  for (const leg of legs) {
    const from = at.slice(), to = leg.to || at, n = Math.max(1, Math.round(leg.ms / (1000 / 60)));
    for (let i = 1; i <= n; i++) {
      t += 1000 / 60;
      at = from.map((v, k) => v + (to[k] - v) * i / n);
      const pts = leg.hand === false ? null : handAt(at, leg.gap);
      demo.step(pts, pts ? { grab: gapFromPoints(pts) } : null, t);
    }
  }
  return t;
}
const bodyOf = (demo, id) => demo.world.bodies.find(b => b.id === id);
const socketOf = (demo, id) => demo.world.sockets.find(s => s.id === id);

test('the grab ignores a flicker, takes a real pinch, and holds through a real one-frame glitch', () => {
  const g = makeGrab();
  let t = 0; const feed = (gap, ms) => { let last; for (let e = t + ms; t < e; t += 1000 / 60) last = g.update(gap, t); return last; };
  feed(1.0, 200);
  assert.equal(g.update(0.1, t).event, null, 'one closed-looking frame is not a grab'); t += 1000 / 60;
  feed(1.0, 100);
  assert.equal(g.held, false);
  feed(0.2, 120);
  assert.equal(g.held, true, 'a pinch that stays closed is');
  for (let i = 0; i < 3; i++) { g.update(0.8, t); t += 1000 / 60; g.update(0.2, t); t += 1000 / 60; }
  assert.equal(g.held, true, 'single open-looking frames in the middle of a carry do not let go');
  // ...nor does the landmarker losing a fingertip for three frames running, which the low-pass alone would not survive
  const seen = [];
  for (const gap of [0.85, 0.85, 0.85, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]) { seen.push(g.update(gap, t).event); t += 1000 / 60; }
  assert.deepEqual(seen.filter(Boolean), [], 'a 50 ms wrong reading does not let go either - not even for a frame');
  assert.equal(g.held, true);
  const out = feed(0.8, GRAB_DEFAULTS.openMs + 120);
  assert.equal(g.held, false, 'opening and staying open does');
  assert.equal(out.held, false);
});

test('a hand flung wide open lets go at once; a vanished hand is waited for, then dropped', () => {
  const g = makeGrab(); let t = 0;
  for (; t < 200; t += 16) g.update(0.2, t);
  assert.equal(g.held, true);
  let ev = null;
  for (let i = 0; i < 4 && !ev; i++, t += 16) ev = g.update(1.6, t).event;      // the low-pass needs a frame or two
  assert.equal(ev, 'release');
  for (const e = t + 200; t < e; t += 16) g.update(0.2, t);
  assert.equal(g.held, true);
  const gone = t;
  for (; t < gone + GRAB_DEFAULTS.coastMs - 40; t += 16) assert.equal(g.update(null, t).held, true, 'coasting');
  let lost = null;
  for (; t < gone + GRAB_DEFAULTS.coastMs + 100; t += 16) lost = g.update(null, t).event || lost;
  assert.equal(lost, 'lost');
  assert.equal(g.held, false);
});

test('pick the cube up, carry it over the platform, let go over its outline: it seats', () => {
  const demo = makeDemo('grab', { floorY: FLOOR }), cube = bodyOf(demo, 'cube'), s = socketOf(demo, 'for-cube');
  const above = [s.pos[0] + 0.8, s.pos[1] + 5, s.pos[2] - 0.6];            // not dead centre: people are not
  drive(demo, [
    { to: [cube.pos[0] + 0.5, cube.pos[1] + 1, cube.pos[2] + 0.5], gap: OPEN, ms: 500 },
    { gap: SHUT, ms: 250 },
    { to: [cube.pos[0], FLOOR + 9, cube.pos[2]], gap: SHUT, ms: 400 },
    { to: above, gap: SHUT, ms: 700 },
    { to: [above[0], s.pos[1] + 2.3, above[2]], gap: SHUT, ms: 400 },
  ], [0, FLOOR + 8, 20]);
  assert.equal(demo.world.held, 'cube');
  assert.ok(Math.hypot(cube.pos[0] - above[0], cube.pos[2] - above[2]) < 1.5, 'the cube is in the fingers, not trailing beside them');
  drive(demo, [{ gap: OPEN, ms: 1200 }], [above[0], s.pos[1] + 2.3, above[2]], 5000);
  assert.equal(demo.world.held, null);
  assert.equal(s.filledBy, 'cube');
  assert.ok(Math.hypot(cube.pos[0] - s.pos[0], cube.pos[2] - s.pos[2]) < 0.15, 'drawn into the outline');
  assert.ok(Math.abs(cube.pos[1] - (s.pos[1] + cube.half[1])) < 1e-6, 'sitting ON the platform');
});

test('the wrong solid in an outline is just a solid on the platform', () => {
  const demo = makeDemo('grab', { floorY: FLOOR }), ball = bodyOf(demo, 'ball'), s = socketOf(demo, 'for-cube');
  ball.pos = [s.pos[0], s.pos[1] + ball.half[1] + 3, s.pos[2]];
  drive(demo, [{ gap: OPEN, ms: 1500, hand: false }], [0, 0, 0]);
  assert.equal(s.filledBy, null);
  assert.ok(Math.abs(ball.pos[1] - (s.pos[1] + ball.half[1])) < 1e-6, 'it still lands and rests there');
});

test('a hand that drops out mid-carry keeps its grip for a moment, and drops the cube if it stays away', () => {
  const carry = (awayMs) => {
    const demo = makeDemo('grab', { floorY: FLOOR }), cube = bodyOf(demo, 'cube'), up = [cube.pos[0], FLOOR + 9, cube.pos[2]];
    const t = drive(demo, [{ to: [cube.pos[0], cube.pos[1] + 1, cube.pos[2]], gap: OPEN, ms: 300 }, { gap: SHUT, ms: 250 },
                           { to: up, gap: SHUT, ms: 400 }], [0, FLOOR + 8, 20]);
    drive(demo, [{ hand: false, ms: awayMs }], up, t);
    return { demo, cube };
  };
  const brief = carry(300);
  assert.equal(brief.demo.world.held, 'cube');
  assert.ok(brief.cube.pos[1] > FLOOR + 6, 'and the cube waits in mid-air where it was');
  const long = carry(1500);
  assert.equal(long.demo.world.held, null);
  assert.ok(Math.abs(long.cube.pos[1] - (FLOOR + long.cube.half[1])) < 1e-6, 'dropped, and at rest on the mat');
});

test('solids land on the platform, stack on each other, and cannot be thrown off the mat', () => {
  const w = makeGrabWorld({ floorY: FLOOR }), [cube, ball, pyramid] = w.bodies, plat = w.statics[0];
  cube.pos = [6, FLOOR + 14, 14]; cube.grounded = false;
  ball.pos = [6.4, FLOOR + 22, 14.3]; ball.grounded = false;
  pyramid.pos = [-5, FLOOR + 3, 15]; pyramid.vel = [400, 80, -300]; pyramid.grounded = false;
  for (let i = 0; i < 60 * 4; i++) stepGrabWorld(w, 1 / 60, null);
  assert.ok(Math.abs(cube.pos[1] - (plat.max[1] + cube.half[1])) < 1e-6, 'cube on the platform');
  assert.ok(Math.abs(ball.pos[1] - (cube.pos[1] + cube.half[1] + ball.half[1])) < 1e-6, 'ball on the cube');
  assert.equal(supportY(w, ball.pos[0], ball.pos[2], ball.pos[1] - ball.half[1], 'ball'), cube.pos[1] + cube.half[1]);
  for (const b of w.bodies) {
    assert.ok(b.pos.every(Number.isFinite));
    assert.ok(b.pos[0] - b.half[0] >= w.bounds.x0 - 1e-6 && b.pos[0] + b.half[0] <= w.bounds.x1 + 1e-6, `${b.id} x`);
    assert.ok(b.pos[2] - b.half[2] >= w.bounds.z0 - 1e-6 && b.pos[2] + b.half[2] <= w.bounds.z1 + 1e-6, `${b.id} z`);
    assert.ok(b.pos[1] - b.half[1] >= FLOOR - 1e-6, `${b.id} is not under the mat`);
    assert.ok(Math.hypot(...b.vel) < 1e-6, `${b.id} came to rest`);
  }
  // a long stall (a backgrounded tab) must not tunnel anything through the platform
  cube.pos = [6, FLOOR + 30, 14]; cube.vel = [0, -300, 0]; ball.pos = [-10, FLOOR + 2.1, 20];
  for (let i = 0; i < 40; i++) stepGrabWorld(w, 0.5, null);
  assert.ok(Math.abs(cube.pos[1] - (plat.max[1] + cube.half[1])) < 1e-6);
});

test('all three home: it celebrates, then sets itself up again', () => {
  const w = makeGrabWorld({ floorY: FLOOR });
  for (const s of w.sockets) { const b = w.bodies.find(q => q.shape === s.shape); b.pos = [s.pos[0] + 0.5, s.pos[1] + b.half[1] + 2, s.pos[2]]; b.grounded = false; }
  for (let i = 0; i < 120; i++) stepGrabWorld(w, 1 / 60, null);
  assert.ok(w.sockets.every(s => s.filledBy), 'all seated');
  assert.notEqual(w.doneAt, null);
  for (let i = 0; i < 60 * 7; i++) stepGrabWorld(w, 1 / 60, null);
  assert.ok(w.sockets.every(s => !s.filledBy) && w.bodies.every(b => b.pos.every((v, k) => v === b.home[k])), 'reset to the start');
});

test('with no pinch on the wire the demo measures its own off the joints', () => {
  const demo = makeDemo('grab', { floorY: FLOOR }), cube = bodyOf(demo, 'cube'), p = [cube.pos[0], cube.pos[1] + 1, cube.pos[2]];
  for (let t = 0; t < 400; t += 16) demo.step(handAt(p, SHUT), null, t);
  assert.equal(demo.world.held, 'cube');
  assert.ok(Math.abs(gapFromPoints(handAt(p, SHUT)) - 0.15) < 0.01 && gapFromPoints(handAt(p, OPEN)) > 0.9);
});

test('a finger dents the sheet under it and nowhere else, it never blows up, and it goes flat again', () => {
  const w = makeSurfaceWorld({ floorY: FLOOR }), m = w.membrane, press = [4, m.y - 2.5, 14];
  const hand = Array.from({ length: 21 }, () => [press[0], m.y + 12, press[2]]); hand[8] = press;
  for (let i = 0; i < 90; i++) stepSurfaceWorld(w, 1 / 60, hand);
  assert.ok(membraneHeight(m, press[0], press[2]) < -2.5, `pressed down under the finger: ${membraneHeight(m, press[0], press[2])}`);
  assert.ok(Math.abs(membraneHeight(m, -10, 8)) < 0.6, 'and not across the sheet');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 600; i++) { hand[8] = [rnd() * 24 - 12, m.y - rnd() * 5, 6 + rnd() * 16]; stepSurfaceWorld(w, 1 / 60, hand); }
  assert.ok(m.h.every(Number.isFinite) && Math.max(...m.h.map(Math.abs)) < (m.y - FLOOR) + 1, 'ten seconds of jabbing: finite and bounded');
  for (let i = 0; i < 60 * 6; i++) stepSurfaceWorld(w, 1 / 60, null);
  assert.ok(Math.max(...m.h.map(Math.abs)) < 0.05, 'left alone it settles flat');
});

test('a marble rolls into a dent made beside it, and stays on the sheet', () => {
  const w = makeSurfaceWorld({ floorY: FLOOR }), m = w.membrane, b = w.marbles[1], start = b.pos.slice();
  const hand = Array.from({ length: 21 }, () => [start[0] + 4, m.y + 12, start[1]]); hand[8] = [start[0] + 4, m.y - 3, start[1]];
  for (let i = 0; i < 60 * 2; i++) stepSurfaceWorld(w, 1 / 60, hand);
  assert.ok(b.pos[0] > start[0] + 0.8, `rolled toward the dent: ${b.pos[0] - start[0]} cm`);
  for (const q of w.marbles) assert.ok(q.pos[0] > m.x0 && q.pos[0] < m.x1 && q.pos[1] > m.z0 && q.pos[1] < m.z1);
});

test('the smoother takes the shake off a still hand, follows a moving one, and holds through a missed frame', () => {
  const s = makeHandSmoother(), base = handAt([0, -6, 12], OPEN);
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const raw = [], out = [];
  let sample = base;
  for (let f = 0, t = 0; f < 600; f++, t += 1000 / 60) {
    if (f % 2 === 0) sample = base.map(p => p.map(v => v + rnd() * 0.25));          // 30 Hz samples, +-2.5 mm of shake
    const got = s.update(sample, t);
    if (f > 60) { raw.push(sample[8][0]); out.push(got[8][0]); }
  }
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  assert.ok(sd(out) < sd(raw) / 2.2, `shake ${sd(raw).toFixed(3)} -> ${sd(out).toFixed(3)} cm`);
  // a real move: 10 cm in one sample. It must be nearly there within ~80 ms, not still easing in.
  const moved = base.map(p => [p[0] + 10, p[1], p[2]]);
  let t = 20000; s.update(base, t - 400); s.update(base, t - 16);
  for (let f = 0; f < 5; f++, t += 1000 / 60) s.update(moved, t);
  assert.ok(Math.abs(s.update(moved, t)[8][0] - moved[8][0]) < 1.0, 'caught up');
  // one missed detection holds the pose; a hand that stays away goes
  assert.ok(s.update(null, t + 100), 'held');
  assert.equal(s.update(null, t + 400), null);
  assert.deepEqual(s.update(base, t + 2000), base, 'and a hand that comes back is drawn where it IS');
});

test('the pinch on the wire: numbers or null, optional, and never NaN', () => {
  const lm = Array.from({ length: 21 }, (_, i) => [0.01 * i, 0, -0.3]);
  const msg = pinch => JSON.stringify({ t: 'hands', seq: 1, ts: 1, hands: [{ handedness: 'right', score: 0.9, lm, ...(pinch === undefined ? {} : { pinch }) }] });
  assert.equal(parseMessage(msg(undefined)).hands[0].pinch, null, 'an older bridge sends none');
  assert.deepEqual(parseMessage(msg({ gap: 0.31, grab: 0.28, closed: true, strength: 0.8, views: 2 })).hands[0].pinch,
                   { gap: 0.31, grab: 0.28, closed: true, strength: 0.8, views: 2 });
  assert.deepEqual(parsePinch({ gap: null, grab: 0.5, closed: 'yes', strength: 'NaN', views: 1 }), { gap: null, grab: 0.5, closed: false, strength: null, views: 1 });
  assert.equal(parsePinch({ gap: null, grab: null }), null);
  assert.equal(parsePinch('closed'), null);
});

// ---------------------------------------------------------------- which frames to believe

const poseAt = x => handAt([x, -6, 12], OPEN);
test('below the threshold the hand stays exactly where it last was, pinch and all, and thaws on a good frame', () => {
  const g = makeHandGate({ minConf: 0.6, holdMs: 1000 });
  let t = 0, id = 0; const step = (x, conf, pinch = { grab: 0.2 }) => g.update({ points: poseAt(x), pinch, conf, id: id++ }, t += 33);
  assert.equal(step(0, 0.9).state, 'tracking');
  const good = step(1, 0.9);
  assert.equal(good.points[8][0], poseAt(1)[8][0]);
  // the ZED loses confidence and what it reports wanders off by 9 cm with the pinch reading wide open:
  // none of it is shown
  for (const x of [3, 6, 10]) {
    const held = step(x, 0.35, { grab: 1.2 });
    assert.equal(held.state, 'holding-unsure');
    assert.deepEqual(held.points, good.points, 'the pose it lost confidence at');
    assert.deepEqual(held.pinch, { grab: 0.2 }, 'and the pinch it had then');
    assert.ok(held.heldMs > 0 && held.conf === 0.35);
  }
  const back = step(10, 0.9);
  assert.equal(back.state, 'tracking');
  assert.equal(back.points[8][0], poseAt(10)[8][0], 'a trusted frame is used as it is');
});

test('a hand that is not seen at all is held the same way, and goes when the hold runs out', () => {
  const g = makeHandGate({ minConf: 0.5, holdMs: 800 });
  const good = g.update({ points: poseAt(2), pinch: null, conf: 0.9, id: 1 }, 0);
  assert.equal(g.update(null, 400).state, 'holding-lost');
  assert.deepEqual(g.update(null, 790).points, good.points);
  const gone = g.update(null, 900);
  assert.equal(gone.state, 'gone'); assert.equal(gone.points, null);
  // unsure frames do not keep a held hand alive either: the hold is counted from the last TRUSTED frame
  g.update({ points: poseAt(2), pinch: null, conf: 0.9, id: 2 }, 2000);
  for (let t = 2033, id = 3; t < 2700; t += 33) assert.equal(g.update({ points: poseAt(5), pinch: null, conf: 0.2, id: id++ }, t).state, 'holding-unsure');
  assert.equal(g.update({ points: poseAt(5), pinch: null, conf: 0.2, id: 99 }, 2900).state, 'gone');
  // and nothing untrusted is ever shown, even as the first frame
  assert.equal(makeHandGate({ minConf: 0.5 }).update({ points: poseAt(0), pinch: null, conf: 0.3, id: 1 }, 0).points, null);
});

test('a confidence sitting on the threshold does not flicker the hand between live and frozen', () => {
  const g = makeHandGate({ minConf: 0.6, holdMs: 5000 });
  let flips = 0, last = null, seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.update({ points: poseAt(0), pinch: null, conf: 0.9, id: 0 }, 0);
  for (let i = 1; i < 600; i++) {
    const s = g.update({ points: poseAt(0), pinch: null, conf: 0.585 + rnd() * 0.04, id: i }, i * 33).state;   // 0.585 .. 0.625
    if (last !== null && s !== last) flips++;
    last = s;
  }
  assert.ok(flips <= 2, `${flips} flips: once it freezes it needs ${GATE_DEFAULTS.hysteresis} more than the threshold to thaw`);
});

test('the gate keeps the numbers the threshold is chosen by, counting each frame once however often it is drawn', () => {
  const g = makeHandGate({ minConf: 0.5 });
  for (let i = 0; i < 100; i++) for (let draw = 0; draw < 2; draw++)            // 30 Hz frames drawn at 60
    g.update({ points: poseAt(0), pinch: null, conf: i % 4 === 0 ? 0.3 : 0.8, id: i }, i * 33 + draw * 16);
  const st = g.stats();
  assert.equal(st.frames, 100);
  assert.ok(st.trusted > 0.4 && st.trusted < 0.8 && st.lowest === 0.3 && st.typical === 0.8, JSON.stringify(st));
  g.update(null, 100 * 33 + 6000);
  assert.equal(g.stats().frames, 0, 'and forgets what is older than its window');
  // a bridge too old to send a confidence is taken at its word rather than frozen for ever
  assert.equal(makeHandGate({ minConf: 0.9 }).update({ points: poseAt(0), pinch: null, conf: null, id: 1 }, 0).state, 'tracking');
});

test('confidence and the running thresholds on the wire; the request back; the saved settings', () => {
  const lm = Array.from({ length: 21 }, (_, i) => [0.01 * i, 0, -0.3]);
  const hand = q => JSON.stringify({ t: 'hands', seq: 1, ts: 1, hands: [{ handedness: 'right', score: 0.9, lm, ...(q === undefined ? {} : { q }) }] });
  assert.equal(parseMessage(hand(undefined)).hands[0].quality, null);
  assert.deepEqual(parseMessage(hand({ conf: 0.93, score: 0.95, other: 0.91, views: 2, tri: 21 })).hands[0].quality,
                   { conf: 0.93, score: 0.95, other: 0.91, views: 2, tri: 21 });
  assert.deepEqual(parseQuality({ conf: 1.7, score: null, other: 'x', views: 5 }), { conf: 1, score: null, other: null, views: 1, tri: 0 });
  assert.equal(parseQuality({ conf: null }), null);
  const hello = parseMessage(JSON.stringify({ t: 'hello', version: 1, landmarker: { detect: 0.7, track: 0.45 } }));
  assert.deepEqual(hello.landmarker, { detect: 0.7, track: 0.45 });
  assert.equal(parseMessage(JSON.stringify({ t: 'hello', version: 1 })).landmarker, null);

  const sent = [];
  class FakeWS { constructor() { this.readyState = 1; } send(m) { sent.push(JSON.parse(m)); } close() {} }
  const c = new ZedClient({ url: 'ws://x', WebSocket: FakeWS, pingEveryMs: 1e9 });
  assert.equal(c.sendConfig({ detect: 0.6 }), false, 'nobody to ask yet');
  c.connect();
  assert.equal(c.sendConfig({ detect: 0.6, track: NaN }), true);
  assert.deepEqual(sent.filter(m => m.t === 'config'), [{ t: 'config', detect: 0.6 }]);
  c.close();

  assert.deepEqual(mergeSetup(null).stability, DEFAULT_SETUP.stability);
  assert.deepEqual(mergeSetup({ version: 7, stability: { minConf: 0.7, holdMs: 2500, detect: 0.6, track: 7 } }).stability,
                   { minConf: 0.7, holdMs: 2500, detect: 0.6, track: null });
  assert.deepEqual(mergeSetup({ version: 7, stability: { minConf: 'high', holdMs: 1 } }).stability, DEFAULT_SETUP.stability);
  assert.deepEqual(validGate({ minConf: 2, holdMs: 100 }), { minConf: GATE_DEFAULTS.minConf, holdMs: GATE_DEFAULTS.holdMs });
});
