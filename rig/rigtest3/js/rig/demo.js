// SPDX-License-Identifier: GPL-3.0-or-later
// The demo: things to pick up, somewhere to put them, and a surface to press.
//
// Two scenes, both in rig centimetres like everything else on this page, both driven by the ONE hand the
// bridge sends (index.html):
//
//   grab     three solids on the mat and a low platform with three outlines on it - a shape sorter. Pinch a
//            solid, carry it, let go over its outline. They fall, land, stack and stay on the mat.
//   surface  a stretched sheet a few centimetres above the mat. Fingers dent it; marbles roll into the dents.
//
// Everything that DECIDES anything is up here and is plain arithmetic - no three.js, no DOM, no clock of its
// own - so `node --test demo.test.js` can pick a cube up and post it through its hole without a browser, a
// camera or a hand. The drawing is one factory at the bottom that is handed THREE, the way hands.js is.
//
// Why the grab is built the way it is. The measurement arrives noisy and sometimes not at all, and the two
// ways of getting it wrong are not equally bad: a grab that starts a twentieth of a second late is not
// noticed, an object that falls out of your fingers half way across is the whole demo failing. So closing
// has to persist for a moment, opening has to persist for longer, and a hand that vanishes mid-carry is
// waited for rather than treated as letting go.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = v => Math.hypot(v[0], v[1], v[2]);
const dist = (a, b) => len(sub(a, b));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const blend = (dt, tau) => 1 - Math.exp(-dt / Math.max(tau, 1e-6));
const finite3 = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

// ---------------------------------------------------------------- the hand, as the demo needs it

export const PALM = [0, 5, 9, 13, 17];
const THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_TIP = 12, WRIST = 0, MIDDLE_MCP = 9;
export const TIP_IDS = [4, 8, 12, 16, 20];

export function centroid(points, ids = PALM) {
  const c = [0, 0, 0];
  for (const i of ids) { c[0] += points[i][0]; c[1] += points[i][1]; c[2] += points[i][2]; }
  return mul(c, 1 / ids.length);
}
// The bridge measures the pinch itself, on the landmarker's metric hand and from both views
// (gestures.pinch_gaps / fuse_gaps). This is the same ratio taken off the drawn joints, for a bridge too old
// to send one: thumb tip to the nearer of index and middle, as a fraction of the palm's length.
export function gapFromPoints(points) {
  const palm = Math.max(dist(points[WRIST], points[MIDDLE_MCP]), 1e-6);
  return Math.min(dist(points[THUMB_TIP], points[INDEX_TIP]), dist(points[THUMB_TIP], points[MIDDLE_TIP])) / palm;
}

// ---------------------------------------------------------------- grab: a pinch you can hold

// close / open are the hysteresis band on the gap (a fraction of the palm's length: ~0.15-0.3 pinched,
// 0.7+ open). closeMs / openMs are how long the gap has to STAY past the threshold: asymmetric on purpose.
// wideOpen lets a hand that is flung open let go at once. coastMs is how long a vanished hand keeps its grip.
export const GRAB_DEFAULTS = { close: 0.40, open: 0.62, closeMs: 40, openMs: 110, wideOpen: 1.0, coastMs: 450, tauMs: 30 };

export function makeGrab(opts = {}) {
  const o = { ...GRAB_DEFAULTS, ...opts };
  let state = 'open', g = null, lastT = null, since = null, lastSeen = -1e9;
  return {
    options: o,
    get held() { return state === 'closed'; },
    get gap() { return g; },
    reset() { state = 'open'; g = null; lastT = since = null; lastSeen = -1e9; },
    // gap: this frame's measurement, or null when there is no fresh hand. Returns what happened.
    update(gap, nowMs) {
      let event = null;
      if (!Number.isFinite(gap)) {
        since = null;                       // an opening that was under way has to start again
        if (state === 'closed' && nowMs - lastSeen > o.coastMs) { state = 'open'; event = 'lost'; }
        return { held: state === 'closed', event, gap: g, coasting: state === 'closed' };
      }
      // a light low-pass at whatever rate this is called, restarted after a gap in the data
      g = (g === null || nowMs - lastSeen > 250) ? gap : g + (gap - g) * blend(nowMs - lastT, o.tauMs);
      lastT = lastSeen = nowMs;
      if (state === 'open') {
        if (g < o.close) { since ??= nowMs; if (nowMs - since >= o.closeMs) { state = 'closed'; since = null; event = 'grab'; } }
        else since = null;
      } else if (g > o.wideOpen) { state = 'open'; since = null; event = 'release'; }
      else if (g > o.open) { since ??= nowMs; if (nowMs - since >= o.openMs) { state = 'open'; since = null; event = 'release'; } }
      else since = null;
      return { held: state === 'closed', event, gap: g, coasting: false };
    },
  };
}

// ---------------------------------------------------------------- the grab scene's world

const body = (id, shape, half, pos, color) =>
  ({ id, shape, half, pos: pos.slice(), home: pos.slice(), vel: [0, 0, 0], color, grounded: true, socket: null });

// Where things are is decided by two facts about this rig, not by taste: the ZED needs the hand in BOTH
// lenses, which at arm's-reach-into-the-slot distance is about 12-15 cm either side of centre, and it loses
// the hand closer than ~15 cm, which is z < 4 or so. So everything lives in x -14..15, z 4..25, and the
// mat's own visible part (the panel's picture ends a little behind the sheet's centre line) covers that.
export function makeGrabWorld({ floorY = -13.5 } = {}) {
  const top = floorY + 3.5;
  return {
    kind: 'grab', floorY, t: 0, doneAt: null, held: null, hot: null, offset: [0, 0, 0], carryVel: [0, 0, 0],
    bounds: { x0: -14, x1: 15, z0: 4, z1: 25 },
    statics: [{ id: 'platform', min: [1.5, floorY, 8], max: [13.5, top, 22] }],
    bodies: [
      body('cube', 'box', [1.9, 1.9, 1.9], [-8, floorY + 1.9, 11], 0xff5a4d),
      body('ball', 'ball', [2.1, 2.1, 2.1], [-4, floorY + 2.1, 18], 0x4dc8ff),
      body('pyramid', 'pyramid', [2.1, 1.9, 2.1], [-9.5, floorY + 1.9, 19], 0xffd24d),
    ],
    sockets: [
      { id: 'for-cube', shape: 'box', pos: [4.7, top, 11.5], radius: 2.6, filledBy: null },
      { id: 'for-ball', shape: 'ball', pos: [10.3, top, 11.5], radius: 2.6, filledBy: null },
      { id: 'for-pyramid', shape: 'pyramid', pos: [7.5, top, 18], radius: 2.6, filledBy: null },
    ],
  };
}
export function resetGrabWorld(w) {
  for (const b of w.bodies) { b.pos = b.home.slice(); b.vel = [0, 0, 0]; b.grounded = true; b.socket = null; }
  for (const s of w.sockets) s.filledBy = null;
  w.held = w.hot = w.doneAt = null;
}

export const GRAB_RADIUS_CM = 3.0;      // how near the pinch has to be to a solid's surface to take it
const GRAVITY = 620, RESTITUTION = 0.22, MAX_THROW = 55, HOLD_TAU = 0.045;

const boxOf = b => ({ min: sub(b.pos, b.half), max: add(b.pos, b.half) });
const gapToBox = (p, b) => len([0, 1, 2].map(i => Math.max(Math.abs(p[i] - b.pos[i]) - b.half[i], 0)));

// The height of whatever is directly under (x, z) and not above `belowY`: the mat, the platform, or a solid.
export function supportY(w, x, z, belowY, exceptId = null) {
  let y = w.floorY;
  const under = (box) => x >= box.min[0] && x <= box.max[0] && z >= box.min[2] && z <= box.max[2] && box.max[1] <= belowY + 0.3;
  for (const s of w.statics) if (under(s)) y = Math.max(y, s.max[1]);
  for (const b of w.bodies) if (b.id !== exceptId && b.id !== w.held) { const bx = boxOf(b); if (under(bx)) y = Math.max(y, bx.max[1]); }
  return y;
}

// Push solid `b` out of `box`. Landing on top wins whenever the solid was above it a moment ago, so a fast
// fall cannot be read as a sideways hit and squirt the solid out of the side of the thing it landed on.
function pushOut(b, box, wasBottom) {
  const lo = sub(b.pos, b.half), hi = add(b.pos, b.half);
  const o = [0, 1, 2].map(i => Math.min(hi[i], box.max[i]) - Math.max(lo[i], box.min[i]));
  if (o[0] <= 0 || o[1] <= 0 || o[2] <= 0) return null;
  const fromAbove = wasBottom >= box.max[1] - 0.25 || (o[1] <= o[0] && o[1] <= o[2] && b.pos[1] > (box.min[1] + box.max[1]) / 2);
  if (fromAbove) {
    b.pos[1] = box.max[1] + b.half[1];
    b.vel[1] = b.vel[1] < -25 ? -b.vel[1] * RESTITUTION : 0;
    b.grounded = b.vel[1] === 0;
    return 'top';
  }
  const axis = o[0] < o[2] ? 0 : 2, mid = (box.min[axis] + box.max[axis]) / 2, dir = b.pos[axis] < mid ? -1 : 1;
  b.pos[axis] += dir * o[axis];
  if (b.vel[axis] * dir < 0) b.vel[axis] *= -RESTITUTION;
  return 'side';
}

function stepBody(w, b, dt) {
  const wasBottom = b.pos[1] - b.half[1];
  b.vel[1] -= GRAVITY * dt;
  b.pos = add(b.pos, mul(b.vel, dt));
  b.grounded = false;
  if (b.pos[1] - b.half[1] <= w.floorY) {
    b.pos[1] = w.floorY + b.half[1];
    b.vel[1] = b.vel[1] < -25 ? -b.vel[1] * RESTITUTION : 0;
    b.grounded = b.vel[1] === 0;
  }
  for (const s of w.statics) pushOut(b, s, wasBottom);
  for (const other of w.bodies) if (other !== b && other.id !== w.held) pushOut(b, boxOf(other), wasBottom);
  const B = w.bounds;
  for (const [axis, a0, a1] of [[0, B.x0, B.x1], [2, B.z0, B.z1]]) {
    if (b.pos[axis] - b.half[axis] < a0) { b.pos[axis] = a0 + b.half[axis]; b.vel[axis] = Math.abs(b.vel[axis]) * RESTITUTION; }
    if (b.pos[axis] + b.half[axis] > a1) { b.pos[axis] = a1 - b.half[axis]; b.vel[axis] = -Math.abs(b.vel[axis]) * RESTITUTION; }
  }
  if (b.grounded) {                       // friction, then sleep: nothing creeps across the mat for ever
    const k = Math.exp(-9 * dt); b.vel[0] *= k; b.vel[2] *= k;
    if (Math.hypot(b.vel[0], b.vel[2]) < 0.6) b.vel[0] = b.vel[2] = 0;
  }
  if (!b.pos.every(Number.isFinite) || b.pos[1] < w.floorY - 5) { b.pos = b.home.slice(); b.vel = [0, 0, 0]; }
}

function seatInSockets(w, dt) {
  for (const s of w.sockets) {
    if (s.filledBy && (w.held === s.filledBy || !w.bodies.some(b => b.id === s.filledBy && b.socket === s.id))) s.filledBy = null;
    for (const b of w.bodies) {
      if (b.id === w.held || b.shape !== s.shape || (s.filledBy && s.filledBy !== b.id)) continue;
      const seatY = s.pos[1] + b.half[1];
      const near = Math.hypot(b.pos[0] - s.pos[0], b.pos[2] - s.pos[2]) < s.radius && Math.abs(b.pos[1] - seatY) < 0.8;
      if (near && b.grounded) {
        const k = blend(dt, 0.06);      // drawn into its outline rather than teleported
        b.pos[0] += (s.pos[0] - b.pos[0]) * k; b.pos[2] += (s.pos[2] - b.pos[2]) * k;
        b.vel = [0, 0, 0]; b.socket = s.id; s.filledBy = b.id;
      } else if (b.socket === s.id) { b.socket = null; s.filledBy = null; }
    }
  }
}

// One step of the grab scene. `pinch` is { point: [x,y,z] | null, held, event } - where the fingers are and
// what makeGrab said about them. Long frames are cut into short steps so a stalled tab does not tunnel a
// cube through the platform.
export function stepGrabWorld(w, dtSec, pinch) {
  const point = pinch && finite3(pinch.point) ? pinch.point : null;
  const holding = () => w.bodies.find(b => b.id === w.held) || null;

  if (pinch?.event === 'grab' && point && !w.held) {
    const near = w.bodies.map(b => [gapToBox(point, b), b]).filter(([d]) => d <= GRAB_RADIUS_CM).sort((a, b) => a[0] - b[0])[0];
    if (near) {
      const b = near[1];
      w.held = b.id; w.offset = sub(b.pos, point); w.carryVel = [0, 0, 0];
      b.vel = [0, 0, 0]; b.grounded = false;
      if (b.socket) { const s = w.sockets.find(q => q.id === b.socket); if (s) s.filledBy = null; b.socket = null; }
    }
  }
  if ((pinch?.event === 'release' || pinch?.event === 'lost' || (pinch && !pinch.held)) && w.held) {
    const b = holding();
    // let go: it leaves with some of the hand's speed, so a toss is a toss, but never enough to leave the
    // mat; a hand that simply vanished drops it where it was
    if (b) { const v = pinch.event === 'lost' ? [0, 0, 0] : mul(w.carryVel, 0.6), s = len(v); b.vel = s > MAX_THROW ? mul(v, MAX_THROW / s) : v; }
    w.held = null;
  }

  let left = clamp(dtSec, 0, 0.1);
  while (left > 1e-6) {
    const dt = Math.min(left, 1 / 120); left -= dt; w.t += dt;
    const h = holding();
    if (h && point) {
      // The solid was taken from up to GRAB_RADIUS away; it closes that distance over a few frames so it
      // ends up IN the fingers rather than trailing beside them, and then follows through a short low-pass:
      // the fingertips are the shakiest joints the ZED reports and a held cube should not show it.
      const keep = 0.5 * Math.min(h.half[0], h.half[1], h.half[2]);
      if (len(w.offset) > keep) w.offset = mul(w.offset, Math.max(keep / len(w.offset), Math.exp(-dt / 0.12)));
      const want = add(point, w.offset);
      want[1] = Math.max(want[1], w.floorY + h.half[1]);
      want[0] = clamp(want[0], w.bounds.x0 + h.half[0], w.bounds.x1 - h.half[0]);
      want[2] = clamp(want[2], w.bounds.z0 + h.half[2], w.bounds.z1 - h.half[2]);
      const next = mix(h.pos, want, blend(dt, HOLD_TAU));
      w.carryVel = mix(w.carryVel, mul(sub(next, h.pos), 1 / dt), blend(dt, 0.08));
      h.pos = next; h.vel = [0, 0, 0];
    }
    for (const b of [...w.bodies].sort((a, c) => a.pos[1] - c.pos[1])) if (b.id !== w.held) stepBody(w, b, dt);
    seatInSockets(w, dt);
  }

  w.hot = w.held || (point
    ? (w.bodies.map(b => [gapToBox(point, b), b.id]).filter(([d]) => d <= GRAB_RADIUS_CM).sort((a, b) => a[0] - b[0])[0] || [0, null])[1]
    : null);
  const done = w.sockets.every(s => s.filledBy);
  if (done && w.doneAt === null) w.doneAt = w.t;
  if (!done) w.doneAt = null;
  if (w.doneAt !== null && w.t - w.doneAt > 6) resetGrabWorld(w);       // an unattended demo starts again
  return w;
}
// The outline a held solid is hovering over, if it is the right one: the view lights it up.
export function readySocket(w) {
  const b = w.bodies.find(q => q.id === w.held);
  if (!b) return null;
  const s = w.sockets.find(q => q.shape === b.shape && Math.hypot(b.pos[0] - q.pos[0], b.pos[2] - q.pos[2]) < q.radius * 1.2);
  return s ? s.id : null;
}

// ---------------------------------------------------------------- the surface scene's world

// A membrane: a grid of heights (0 = at rest) obeying a damped wave equation with a weak pull back to flat,
// so a dent spreads, rings once and settles. Fingers are spheres it may not pass through. Explicit Euler is
// stable while c*dt/step < 0.7; the step below is fixed for that reason and must not follow the frame rate.
export function makeMembrane({ x0 = -14, x1 = 14, z0 = 4, z1 = 24, y = -7.5, step = 1, floorY = -13.5 } = {}) {
  const nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1;
  return { x0, x1, z0, z1, y, step, nx, nz, floorY, h: new Float32Array(nx * nz), v: new Float32Array(nx * nz) };
}
const WAVE_C = 55, PULL = 38, DAMP = 5.5, MEMBRANE_DT = 1 / 180;

function membraneSubstep(m, dt, pushers) {
  const { nx, nz, h, v, step } = m, k = (WAVE_C / step) ** 2;
  for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const q = j * nx + i, lap = h[q - 1] + h[q + 1] + h[q - nx] + h[q + nx] - 4 * h[q];
    v[q] += (k * lap - PULL * h[q] - DAMP * v[q]) * dt;
  }
  for (let q = 0; q < h.length; q++) h[q] += v[q] * dt;      // the rim never moves: v stays 0 there
  const deepest = m.floorY + 0.4 - m.y;
  for (const p of pushers) {
    const r = p.r, bottom = p.p[1] - r;
    if (bottom > m.y + 1.5 || p.p[1] < m.y - 3 * r) continue;          // well above it, or a hand UNDER the sheet
    const i0 = Math.max(1, Math.floor((p.p[0] - r - m.x0) / step)), i1 = Math.min(nx - 2, Math.ceil((p.p[0] + r - m.x0) / step));
    const j0 = Math.max(1, Math.floor((p.p[2] - r - m.z0) / step)), j1 = Math.min(nz - 2, Math.ceil((p.p[2] + r - m.z0) / step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = m.x0 + i * step - p.p[0], dz = m.z0 + j * step - p.p[2], d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const limit = Math.max(p.p[1] - Math.sqrt(r * r - d2) - m.y, deepest), q = j * nx + i;
      if (h[q] > limit) { h[q] = limit; if (v[q] > 0) v[q] = 0; v[q] *= 0.5; }
    }
  }
}
export function membraneHeight(m, x, z) {
  const fx = clamp((x - m.x0) / m.step, 0, m.nx - 1.001), fz = clamp((z - m.z0) / m.step, 0, m.nz - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, q = j * m.nx + i;
  return (m.h[q] * (1 - a) + m.h[q + 1] * a) * (1 - b) + (m.h[q + m.nx] * (1 - a) + m.h[q + m.nx + 1] * a) * b;
}
export function membraneSlope(m, x, z) {
  const e = m.step;
  return [(membraneHeight(m, x + e, z) - membraneHeight(m, x - e, z)) / (2 * e),
          (membraneHeight(m, x, z + e) - membraneHeight(m, x, z - e)) / (2 * e)];
}

export function makeSurfaceWorld({ floorY = -13.5 } = {}) {
  const membrane = makeMembrane({ floorY, y: floorY + 6 });
  const marble = (id, x, z, color) => ({ id, r: 1.25, pos: [x, z], home: [x, z], vel: [0, 0], color });
  return { kind: 'surface', floorY, t: 0, membrane, carry: 0,
           marbles: [marble('a', -7, 10, 0xff5a4d), marble('b', 0, 17, 0x4dc8ff), marble('c', 7, 11, 0xffd24d)] };
}
export function resetSurfaceWorld(w) {
  w.membrane.h.fill(0); w.membrane.v.fill(0);
  for (const b of w.marbles) { b.pos = b.home.slice(); b.vel = [0, 0]; }
}
// points: the hand's 21 joints in rig cm, or null. Every joint presses; the tips are a little fatter.
export function stepSurfaceWorld(w, dtSec, points) {
  const m = w.membrane;
  const pushers = points ? points.map((p, i) => ({ p, r: TIP_IDS.includes(i) ? 1.25 : 1.05 })) : [];
  w.carry += clamp(dtSec, 0, 0.1);
  while (w.carry >= MEMBRANE_DT) {
    w.carry -= MEMBRANE_DT; w.t += MEMBRANE_DT;
    membraneSubstep(m, MEMBRANE_DT, pushers);
    for (const b of w.marbles) {
      // downhill, on a small-slope sheet: a = -g * grad(h); plus rolling resistance
      const s = membraneSlope(m, b.pos[0], b.pos[1]);
      b.vel[0] += (-GRAVITY * s[0] - 1.4 * b.vel[0]) * MEMBRANE_DT;
      b.vel[1] += (-GRAVITY * s[1] - 1.4 * b.vel[1]) * MEMBRANE_DT;
      // a finger is solid to a marble too
      const y = m.y + membraneHeight(m, b.pos[0], b.pos[1]) + b.r;
      for (const p of pushers) {
        const d = [b.pos[0] - p.p[0], y - p.p[1], b.pos[1] - p.p[2]], gap = len(d) - (b.r + p.r);
        const flat = Math.hypot(d[0], d[2]);
        if (gap < 0 && flat > 1e-6) { b.pos[0] -= gap * d[0] / flat; b.pos[1] -= gap * d[2] / flat;
                                       b.vel[0] += -gap * d[0] / flat * 40 * MEMBRANE_DT * 60; b.vel[1] += -gap * d[2] / flat * 40 * MEMBRANE_DT * 60; }
      }
      const sp = Math.hypot(b.vel[0], b.vel[1]); if (sp > 90) { b.vel[0] *= 90 / sp; b.vel[1] *= 90 / sp; }
      b.pos[0] += b.vel[0] * MEMBRANE_DT; b.pos[1] += b.vel[1] * MEMBRANE_DT;
      for (const [axis, a0, a1] of [[0, m.x0 + 1, m.x1 - 1], [1, m.z0 + 1, m.z1 - 1]]) {
        if (b.pos[axis] - b.r < a0) { b.pos[axis] = a0 + b.r; b.vel[axis] = Math.abs(b.vel[axis]) * 0.4; }
        if (b.pos[axis] + b.r > a1) { b.pos[axis] = a1 - b.r; b.vel[axis] = -Math.abs(b.vel[axis]) * 0.4; }
      }
      if (!b.pos.every(Number.isFinite)) { b.pos = b.home.slice(); b.vel = [0, 0]; }
    }
    for (let i = 0; i < w.marbles.length; i++) for (let j = i + 1; j < w.marbles.length; j++) {
      const a = w.marbles[i], b = w.marbles[j], dx = b.pos[0] - a.pos[0], dz = b.pos[1] - a.pos[1], d = Math.hypot(dx, dz), need = a.r + b.r;
      if (d >= need || d < 1e-6) continue;
      const nx = dx / d, nz = dz / d, push = (need - d) / 2, rel = (b.vel[0] - a.vel[0]) * nx + (b.vel[1] - a.vel[1]) * nz;
      a.pos[0] -= nx * push; a.pos[1] -= nz * push; b.pos[0] += nx * push; b.pos[1] += nz * push;
      if (rel < 0) { a.vel[0] += rel * nx; a.vel[1] += rel * nz; b.vel[0] -= rel * nx; b.vel[1] -= rel * nz; }
    }
  }
  return w;
}
export const marbleY = (w, b) => w.membrane.y + membraneHeight(w.membrane, b.pos[0], b.pos[1]) + b.r;

// ---------------------------------------------------------------- one demo, stepped from one hand

// The point things are picked up WITH. Thumb-tip-to-index-tip midpoint is the honest answer and the jittery
// one: those are the two joints the camera sees worst, and while something is held they are behind it. The
// palm is the steadiest thing on the hand. So the point is carried as "the palm, plus where the fingertips
// are relative to it", and that relative part is smoothed hard while holding (it barely changes then) and
// lightly otherwise.
export function makeDemo(kind, { floorY = -13.5, grab = {} } = {}) {
  const world = kind === 'surface' ? makeSurfaceWorld({ floorY }) : makeGrabWorld({ floorY });
  const machine = makeGrab(grab);
  let rel = null, lastMs = null, point = null, state = { held: false, event: null, gap: null, coasting: false };
  return {
    kind, world, machine, frozen: false,
    get point() { return point; },
    get state() { return state; },
    reset() { kind === 'surface' ? resetSurfaceWorld(world) : resetGrabWorld(world); machine.reset(); },
    // points: 21 joints in rig cm or null; pinch: what the bridge said ({ grab, gap, ... }) or null
    step(points, pinch, nowMs) {
      const dt = lastMs === null ? 0 : clamp((nowMs - lastMs) / 1000, 0, 0.1);
      lastMs = nowMs;
      const has = Array.isArray(points) && points.length === 21;
      if (kind === 'surface') { stepSurfaceWorld(world, dt, has ? points : null); point = null; return world; }
      const gap = !has ? null : Number.isFinite(pinch?.grab) ? pinch.grab : Number.isFinite(pinch?.gap) ? pinch.gap : gapFromPoints(points);
      state = machine.update(gap, nowMs);
      if (has) {
        const palm = centroid(points), raw = sub(mix(points[THUMB_TIP], points[INDEX_TIP], 0.5), palm);
        rel = rel === null ? raw : mix(rel, raw, blend(dt, state.held ? 0.14 : 0.04));
        point = add(palm, rel);
      } else if (!state.held) { point = null; rel = null; }
      // a coasting grip holds the solid where it was: `point` is simply not refreshed
      stepGrabWorld(world, dt, { point, held: state.held, event: state.event });
      return world;
    },
  };
}

// ---------------------------------------------------------------- drawing (handed THREE, like hands.js)

// Pepper's ghost ADDS light and cannot take any away: black is "nothing there". So nothing here is shaded to
// black - every solid glows a little in its own colour - and what would be a cast shadow is drawn as the
// opposite, a pool of light on whatever is underneath, which is the depth cue a shadow would have been.
export function makeDemoView(THREE, demo) {
  const group = new THREE.Group(), w = demo.world;
  const line = (c, o = 1) => new THREE.LineBasicMaterial({ color: c, transparent: o < 1, opacity: o, toneMapped: false });
  const loopOf = (pts, mat) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p))), mat);
  const glow = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending,
                                                       depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  if (demo.kind === 'surface') return surfaceView();
  return grabView();

  function grabView() {
    const solids = new Map(), pools = new Map(), outlines = new Map();
    for (const s of w.statics) {
      const size = sub(s.max, s.min), geo = new THREE.BoxGeometry(...size), mid = mix(s.min, s.max, 0.5);
      const block = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x16384a, roughness: 0.8, emissive: 0x0b2230, emissiveIntensity: 1 }));
      block.position.set(...mid);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), line(0x35d0ff, 0.9)); edges.position.set(...mid);
      group.add(block, edges);
    }
    for (const s of w.sockets) {
      const y = s.pos[1] + 0.06, r = s.radius * 0.86, n = s.shape === 'ball' ? 40 : s.shape === 'box' ? 4 : 3;
      const turn = s.shape === 'box' ? Math.PI / 4 : s.shape === 'pyramid' ? -Math.PI / 2 : 0;
      const pts = Array.from({ length: n }, (_, i) => [s.pos[0] + r * Math.cos(turn + i / n * 2 * Math.PI), y, s.pos[2] + r * Math.sin(turn + i / n * 2 * Math.PI)]);
      const o = loopOf(pts, line(0x9fdcff)); group.add(o); outlines.set(s.id, o);
    }
    for (const b of w.bodies) {
      const geo = b.shape === 'ball' ? new THREE.SphereGeometry(b.half[0], 28, 18)
        : b.shape === 'pyramid' ? new THREE.ConeGeometry(b.half[0] * Math.SQRT2, b.half[1] * 2, 4).rotateY(Math.PI / 4)
        : new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.35, metalness: 0.05, emissive: b.color, emissiveIntensity: 0.3 }));
      if (b.shape !== 'ball') mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), line(0xffffff, 0.85)));
      const pool = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2), glow(b.color, 0.4));
      group.add(mesh, pool); solids.set(b.id, mesh); pools.set(b.id, pool);
    }
    const plumb = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), line(0xffffff, 0.5));
    const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 40).rotateX(-Math.PI / 2), glow(0xffffff, 0.9));
    group.add(plumb, cursor, halo);

    return { group, sync() {
      const ready = readySocket(w), done = w.doneAt !== null, beat = 0.5 + 0.5 * Math.sin(w.t * 9);
      for (const b of w.bodies) {
        const mesh = solids.get(b.id), pool = pools.get(b.id), held = w.held === b.id, hot = w.hot === b.id;
        mesh.position.set(...b.pos);
        mesh.material.emissiveIntensity = held ? 0.75 : hot ? 0.55 + 0.2 * beat : done ? 0.4 + 0.4 * beat : 0.3;
        mesh.scale.setScalar(hot && !held ? 1.06 : 1);
        const under = supportY(w, b.pos[0], b.pos[2], b.pos[1] - b.half[1], b.id), lift = Math.max(b.pos[1] - b.half[1] - under, 0);
        pool.position.set(b.pos[0], under + 0.05, b.pos[2]);
        pool.scale.setScalar(b.half[0] * (1.05 + lift * 0.035));
        pool.material.opacity = clamp(0.5 - lift * 0.03, 0.1, 0.5);
      }
      for (const s of w.sockets) {
        const o = outlines.get(s.id);
        o.material.color.setHex(s.filledBy ? 0x5dff8a : ready === s.id ? 0xffe14d : 0x9fdcff);
        o.material.opacity = 1;
      }
      const h = w.bodies.find(b => b.id === w.held), p = demo.point;
      plumb.visible = !!h;
      if (h) { const under = supportY(w, h.pos[0], h.pos[2], h.pos[1] - h.half[1], h.id);
               plumb.position.set(h.pos[0], h.pos[1] - h.half[1], h.pos[2]); plumb.scale.set(1, Math.max(h.pos[1] - h.half[1] - under, 0.001), 1); }
      cursor.visible = halo.visible = !!p;
      if (p) {
        const colour = demo.frozen ? 0xffa23d : demo.state.held ? 0x5dff8a : w.hot ? 0xffe14d : 0xffffff;   // amber: a held pose (hands.js makeHandGate)
        cursor.position.set(...p); cursor.material.color.setHex(colour);
        halo.position.set(...p); halo.material.color.setHex(colour);
        // the ring closes as the fingers do, so "how pinched does it think I am" is on the glass
        halo.scale.setScalar(0.5 + 2.4 * clamp(demo.state.gap ?? 1, 0, 1.1));
      }
    } };
  }

  function surfaceView() {
    const m = w.membrane, { nx, nz } = m, idx = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (i + 1 < nx) idx.push(j * nx + i, j * nx + i + 1);
      if (j + 1 < nz) idx.push(j * nx + i, (j + 1) * nx + i);
    }
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false })));
    const frame = [[m.x0, m.y, m.z0], [m.x1, m.y, m.z0], [m.x1, m.y, m.z1], [m.x0, m.y, m.z1]];
    group.add(loopOf(frame, line(0x35d0ff)));
    const posts = [];
    for (const c of frame) posts.push(new THREE.Vector3(...c), new THREE.Vector3(c[0], w.floorY, c[2]));
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(posts), line(0x1e6f96)));
    const balls = w.marbles.map(b => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r, 24, 16),
        new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.3, emissive: b.color, emissiveIntensity: 0.35 }));
      group.add(mesh); return mesh;
    });
    return { group, sync() {
      for (let j = 0, q = 0; j < nz; j++) for (let i = 0; i < nx; i++, q++) {
        const h = m.h[q], d = clamp(-h / 4, 0, 1), up = clamp(h / 1.5, 0, 1);
        pos[q * 3] = m.x0 + i * m.step; pos[q * 3 + 1] = m.y + h; pos[q * 3 + 2] = m.z0 + j * m.step;
        // at rest a quiet blue; pressed, it heats toward white-gold; the rebound above flat shows green
        col[q * 3] = 0.12 + 0.88 * d; col[q * 3 + 1] = 0.42 + 0.45 * d + 0.4 * up; col[q * 3 + 2] = 0.62 - 0.3 * d;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      w.marbles.forEach((b, i) => balls[i].position.set(b.pos[0], marbleY(w, b), b.pos[1]));
    } };
  }
}
