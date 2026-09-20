// Which part you get, when you may take it again, and what happens when the tracker blinks mid-carry.
//
// Every test here is a case the shipped suite could not see, because its multi-body tests used bodies of
// EQUAL size and its dropout tests used a hand that was standing still. Real Fable models are a big flat
// base with small parts on it, and a real hand is moving when the camera loses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGrab } from '../public/js/interact/grab.js';
import { bindBody } from '../public/js/interact/bodies.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { handFrame, run } from '../public/js/interact/replay.js';
import { vdist, vlen, qangle, qFromAxisAngle } from '../public/js/interact/math.js';

const wide = () => {
  const c = cloneConfig(GRAB_CONFIG);
  c.volume = { minX: -3, maxX: 3, minY: -3, maxY: 3, minZ: -3, maxZ: 3 };
  return c;
};
const at = (x, y, z) => ({ x, y, z });

// A Fable-shaped model: a wide flat base with a tower and a ball standing on it, bound through the real
// bodies.js so the pick volumes are the ones the app would use.
function fableModel() {
  const scene = new THREE.Scene();
  const mk = (id, geo, pos) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    m.position.set(pos.x, pos.y, pos.z);
    scene.add(m);
    return bindBody(m, { id });
  };
  const base = mk('base', new THREE.BoxGeometry(0.30, 0.02, 0.30), at(0, 0.01, 0));
  const tower = mk('tower', new THREE.BoxGeometry(0.04, 0.16, 0.04), at(0.02, 0.10, 0));
  const ball = mk('ball', new THREE.SphereGeometry(0.025, 16, 12), at(-0.09, 0.045, 0.06));
  return { scene, base, tower, ball, bodies: [base.body, tower.body, ball.body] };
}

test('the biggest part does not swallow every other part of the model', () => {
  const { base, tower, ball, bodies } = fableModel();
  console.log(`  pick spheres: base ${(base.body.radius * 100).toFixed(1)} cm, ` +
              `tower ${(tower.body.radius * 100).toFixed(1)} cm, ball ${(ball.body.radius * 100).toFixed(1)} cm`);

  // Aim dead centre on the ball, then at the very top of the tower. Ranking by
  // (distance - bounding-sphere radius) made the base win both, 30 times out of 30.
  for (const [want, aim] of [['ball', at(-0.09, 0.045, 0.06)], ['tower', at(0.02, 0.175, 0)]]) {
    const grab = createGrab({ config: wide() });
    const r = run({ grab, bodies, durationMs: 700,
                    hands: now => [handFrame(0, aim, now < 300 ? 0.06 : 0.012, now)] });
    const got = r.events.find(e => e.name === 'grabStart');
    console.log(`  aiming at the ${want}: took ${got ? got.bodyId : 'nothing'}`);
    assert.ok(got, `aiming at the ${want} grabbed something`);
    assert.equal(got.bodyId, want);
  }
});

test('a pinch in the empty air above a flat part does not pick it up', () => {
  const { base, bodies } = fableModel();
  const grab = createGrab({ config: wide() });
  // 12 cm above the base's own 2 cm-thick top face: nothing is drawn there. With the pick sphere set to
  // half the bounding-box DIAGONAL the base reached 28 cm from its centre and took this.
  const r = run({ grab, bodies: [base.body], durationMs: 700,
                  hands: now => [handFrame(0, at(0, 0.14, 0), now < 300 ? 0.06 : 0.012, now)] });
  assert.equal(r.count('grabStart'), 0, 'nothing was in reach');
});

test('after a release, a re-pinch takes nothing — never the part next door', () => {
  const config = wide();
  config.settleGravity = 0;                     // keep the dropped body under the hand, so this is about choice
  const A = { id: 'A', pose: { position: at(0, 0.12, 0), quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, radius: 0.03 };
  const B = { id: 'B', pose: { position: at(0.09, 0.12, 0), quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, radius: 0.03 };
  const grab = createGrab({ config });
  const hoverDuring = [];
  let releasedAt = null;
  grab.on('grabEnd', e => { if (releasedAt == null) releasedAt = e.at; });

  // Pinch A, hold, let go — then keep opening and closing on the SAME spot, so there is a fresh rising
  // edge every 200 ms through the lockout and out the other side.
  const r = run({ grab, bodies: [A, B], durationMs: 2600, hands: now => {
    let gap;
    if (now < 100) gap = 0.06;                                    // open
    else if (now < 900) gap = 0.012;                              // holding A
    else if (releasedAt == null) gap = 0.06;                      // let go
    else gap = ((now - releasedAt) % 200) < 100 ? 0.06 : 0.012;   // open/close, 200 ms apart
    return [handFrame(0, at(0, 0.12, 0), gap, now)];
  }, onFrame: (frame, now) => {
    if (releasedAt != null && now - releasedAt <= 500) hoverDuring.push(frame.hands[0].hoverId);
  } });

  const starts = r.events.filter(e => e.name === 'grabStart');
  console.log(`  grabs: ${starts.map(e => `${e.bodyId}@${(e.at - (releasedAt ?? 0)).toFixed(0)}ms after the release`).join(', ')}`);
  assert.equal(starts[0].bodyId, 'A');
  const during = starts.slice(1).filter(e => e.at - releasedAt < 500);
  assert.deepEqual(during.map(e => e.bodyId), [], 'nothing may be grabbed during the lockout');
  assert.ok(!hoverDuring.includes('B'), 'and the highlight must not promise the neighbour either');
  const after = starts.slice(1).find(e => e.at - releasedAt >= 500);
  assert.ok(after && after.bodyId === 'A', 'once the lockout is up, the hand takes A again, not B');
});

test('losing tracking mid-carry leaves the model where it was, not thrown across the volume', () => {
  const config = wide();
  const body = { id: 'm', pose: { position: at(-0.10, 0.12, 0), quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 },
                 radius: 0.035, restOffset: 0.02 };
  const grab = createGrab({ config });
  const speed = 0.4;                                    // m/s, a normal carry
  const VANISH = 900;
  let atVanish = null, end = null;
  grab.on('grabEnd', e => { end = e; });

  run({ grab, bodies: [body], durationMs: 2000, hands: now => {
    if (now >= VANISH) return [];                       // the camera goes dark mid-carry
    const x = -0.10 + Math.max(0, now - 200) / 1000 * speed;
    return [handFrame(0, at(x, 0.12, 0), now < 200 ? 0.06 : 0.012, now)];
  }, onFrame: (frame, now) => { if (atVanish == null && now >= VANISH) atVanish = { ...body.pose.position }; } });

  assert.ok(end, 'the hold ended');
  assert.equal(end.reason, 'lost');
  const thrown = vlen(end.velocity);
  const moved = vdist(body.pose.position, atVanish);
  console.log(`  the hand vanished at ${speed} m/s: released with ${(thrown * 100).toFixed(1)} cm/s, ` +
              `model ended ${(moved * 1000).toFixed(1)} mm from where it was`);
  assert.ok(thrown < 0.02, `a blink is not a throw (${(thrown * 100).toFixed(1)} cm/s)`);
  assert.ok(moved < 0.01, `and it does not fall to a floor either (${(moved * 1000).toFixed(1)} mm)`);
});

test('a hand that comes back mid two-hand carry does not snap the model forward', () => {
  const config = wide();
  const body = { id: 'm', pose: { position: at(0, 0.12, 0), quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, radius: 0.04 };
  const grab = createGrab({ config });
  // A 190 ms gap: INSIDE the 200 ms hold-through window, so the hold stays two-handed and the stale
  // basis is reused. (A longer gap demotes to one hand, and that path always re-anchored.)
  const SPAN = 0.20, GONE = [1200, 1390];
  const hz = 60;
  const mid = now => Math.max(0, now - 600) / 1000 * 0.63;   // both hands start straddling the body
  const steps = [];
  let last = null, worstNormal = 0, worstReturn = 0, worstAngle = 0;

  run({ grab, bodies: [body], durationMs: 2400, hz, hands: now => {
    const gap = now < 300 ? 0.06 : 0.012;
    const x = mid(now);
    const a = handFrame(0, at(x - SPAN / 2, 0.12, 0), gap, now);
    const b = handFrame(1, at(x + SPAN / 2, 0.12, 0), gap, now);
    if (now >= GONE[0] && now < GONE[1]) return [b];    // hand 0 blinks out while both are moving
    return [a, b];
  }, onFrame: (frame, now) => {
    if (now > 500 && now < GONE[0]) {
      assert.equal(frame.holds[0]?.kind, 'two', `both hands are on it at ${now.toFixed(0)} ms`);
    }
    if (last) {
      const step = vdist(body.pose.position, last.p);
      const ang = qangle(body.pose.quaternion, last.q) * 180 / Math.PI;
      // the frames just after the hand comes back, against an ordinary carrying frame
      if (now >= GONE[1] && now < GONE[1] + 200) { worstReturn = Math.max(worstReturn, step); worstAngle = Math.max(worstAngle, ang); }
      else if (now > 800 && now < GONE[0]) worstNormal = Math.max(worstNormal, step);
      steps.push(step);
    }
    last = { p: { ...body.pose.position }, q: { ...body.pose.quaternion } };
  } });

  console.log(`  a 190 ms blink in a two-hand carry: worst frame after the hand returns ` +
              `${(worstReturn * 1000).toFixed(1)} mm / ${worstAngle.toFixed(1)} deg, ` +
              `against ${(worstNormal * 1000).toFixed(1)} mm for an ordinary carrying frame`);
  assert.ok(worstReturn < worstNormal * 1.6 + 0.002,
    `the return must not cost more than a carrying frame (${(worstReturn * 1000).toFixed(1)} mm vs ${(worstNormal * 1000).toFixed(1)} mm)`);
  assert.ok(worstAngle < 10, `and it must not spin (${worstAngle.toFixed(1)} deg)`);
});

test('a rotated part rests ON the floor, not above its own ground ring', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.03), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  const binding = bindBody(mesh, { id: 'arm' });
  const box = new THREE.Box3();
  for (const deg of [0, 60, 90]) {
    binding.body.pose.position = at(0, 0.30, 0);
    binding.body.pose.quaternion = qFromAxisAngle({ x: 0, y: 0, z: 1 }, deg * Math.PI / 180);
    binding.apply();
    // put the part down at its own rest height, then measure where its lowest point really is
    binding.body.pose.position = at(0, binding.body.restOffset, 0);
    binding.apply();
    box.setFromObject(mesh);
    console.log(`  tilted ${deg} deg: restOffset ${(binding.body.restOffset * 1000).toFixed(1)} mm, ` +
                `lowest point ${(box.min.y * 1000).toFixed(2)} mm above the floor`);
    assert.ok(Math.abs(box.min.y) < 0.0005, `${deg} deg rests on the floor (${(box.min.y * 1000).toFixed(1)} mm out)`);
  }
});
