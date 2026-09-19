// Run a hand track through a grab at a fixed frame rate and measure the result. The same helpers back the
// tests and the demo page's readouts, so a number you tune to on screen is the number a test asserts.

import { createGrab } from './grab.js';
import { vadd, vdist, vlen, vmul, vsub } from './math.js';

export function makeBody({ id = 'body', position = { x: 0, y: 0, z: 0 }, quaternion = { x: 0, y: 0, z: 0, w: 1 },
                           scale = 1, radius = 0.05, restOffset = 0.03, locked = false } = {}) {
  return { id, pose: { position: { ...position }, quaternion: { ...quaternion }, scale }, radius, restOffset, locked };
}

// one hand frame as grab.js wants it: a grip point and a thumb-index gap, split along `axis`
export function handFrame(id, grip, gap, now, axis = { x: 1, y: 0, z: 0 }) {
  const h = vmul(axis, gap / 2);
  return { id, active: true, seenAt: now, thumb: vadd(grip, h), index: vsub(grip, h) };
}

// Root-mean-square of the frame-to-frame step of a series of points: "how much does it shimmer", which is what
// the eye actually sees, as opposed to how far it is from the truth.
export function stepJitter(points) {
  if (points.length < 2) return { rms: 0, max: 0, n: points.length };
  let sum = 0, max = 0;
  for (let i = 1; i < points.length; i++) {
    const d = vdist(points[i], points[i - 1]);
    sum += d * d;
    if (d > max) max = d;
  }
  return { rms: Math.sqrt(sum / (points.length - 1)), max, n: points.length };
}

// The same, but with real travel taken out: each point is measured against a short moving average of its
// neighbours, so carrying the model across the volume does not read as shake. This is the honest "does it
// shimmer" number to tune against while the hand is moving.
export function residualJitter(points, window = 5) {
  if (points.length < window + 2) return { rms: 0, max: 0, n: points.length };
  const h = window >> 1;
  let sum = 0, max = 0, n = 0;
  for (let i = h; i < points.length - h; i++) {
    let mx = 0, my = 0, mz = 0;
    for (let k = i - h; k <= i + h; k++) { mx += points[k].x; my += points[k].y; mz += points[k].z; }
    const w = 2 * h + 1;
    const d = Math.hypot(points[i].x - mx / w, points[i].y - my / w, points[i].z - mz / w);
    sum += d * d; n++;
    if (d > max) max = d;
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, max, n };
}

export function spread(points) {
  if (!points.length) return { sd: 0, mean: null };
  const n = points.length;
  const m = points.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n, z: a.z + p.z / n }), { x: 0, y: 0, z: 0 });
  return { sd: Math.sqrt(points.reduce((a, p) => a + vlen(vsub(p, m)) ** 2, 0) / n), mean: m };
}

// Drive a grab for a while. `hands` is a function (now, index) -> hand frames.
export function run({ grab = null, config = undefined, bodies, hands, hz = 60, durationMs = 2000, t0 = 0, onFrame = null }) {
  const g = grab || createGrab(config ? { config } : {});
  const events = [];
  for (const name of ['grabStart', 'grabMove', 'grabEnd', 'settleStart', 'settleEnd']) {
    g.on(name, e => { if (name !== 'grabMove') events.push({ name, ...e }); });
  }
  const step = 1000 / hz;
  const samples = new Map(bodies.map(b => [b.id, []]));
  const handPoints = new Map();
  let frame = null, i = 0;
  for (let now = t0; now <= t0 + durationMs + 1e-9; now += step, i++) {
    frame = g.update({ hands: hands(now, i) || [], bodies, now });
    for (const b of bodies) samples.get(b.id).push({ ...b.pose.position, t: now, held: g.isHeld(b.id) });
    for (const h of frame.hands) {
      if (!handPoints.has(h.id)) handPoints.set(h.id, []);
      if (h.point) handPoints.get(h.id).push({ ...h.point, t: now });
    }
    if (onFrame) onFrame(frame, now, bodies);
  }
  return { grab: g, events, frame, samples, handPoints, undos: g.undos.slice(),
           count: name => events.filter(e => e.name === name).length };
}

// Same, fed by a track.js tracker.
export function replay({ grab = null, config = undefined, tracker, bodies, hz = 60, durationMs = 4000, t0 = 0, onFrame = null }) {
  tracker.reset(t0);
  return run({ grab, config, bodies, hands: now => tracker.poll(now), hz, durationMs, t0, onFrame });
}
