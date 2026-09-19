// Synthetic hand tracks, so the grab can be built and tuned with no camera plugged in.
//
// It models the three things that actually break a grab, from the research pass:
//   jitter    3-7 mm of fingertip error at 0.4-0.8 m is the ZED pair's best case; the demo defaults to 8 mm
//   dropouts  MediaPipe loses a hand for a few frames at a time, especially against a dark background
//   lag       35-50 ms is the honest 60 Hz budget; 150 ms is what a bad day over a network bridge looks like
// plus the one nobody models and everybody trips over: the pinch point FLICKS several centimetres as the
// fingers open, which is why grab.js releases from the pose 100 ms earlier.
//
// Deterministic: same seed, same track, so a test can assert a number.

import { v3, vadd, vmix, vmul, clamp } from './math.js';

// mulberry32: tiny, good enough, and identical in node and the browser
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const gauss3 = (r, sd) => ({ x: gauss(r) * sd, y: gauss(r) * sd, z: gauss(r) * sd });
const smooth = t => t * t * (3 - 2 * t);

// ---------- a scripted path: keyframes of {t, grip, pinch} ----------
// pinch is 0 or 1; it is eased over `pinchMs` so the thumb and index really do travel through the thresholds.
export function makeScript(keys, { pinchMs = 140, openGap = 0.075, closedGap = 0.012, flick = null } = {}) {
  const ks = [...keys].sort((a, b) => a.t - b.t);
  const duration = ks[ks.length - 1].t;
  const pinchKeys = ks.filter((k, i) => i === 0 || k.pinch !== ks[i - 1].pinch);

  function gripAt(t) {
    if (t <= ks[0].t) return { ...ks[0].grip };
    if (t >= duration) return { ...ks[ks.length - 1].grip };
    for (let i = 1; i < ks.length; i++) {
      if (t <= ks[i].t) {
        const span = ks[i].t - ks[i - 1].t;
        return vmix(ks[i - 1].grip, ks[i].grip, smooth(span > 0 ? (t - ks[i - 1].t) / span : 1));
      }
    }
    return { ...ks[ks.length - 1].grip };
  }
  // 0 = open, 1 = closed, eased through the transition
  function pinchAt(t) {
    let p = pinchKeys[0].pinch ? 1 : 0;
    for (const k of pinchKeys) {
      if (t < k.t) break;
      p = clamp((t - k.t) / pinchMs, 0, 1) * ((k.pinch ? 1 : 0) - p) + p;
    }
    return p;
  }

  return function sample(t) {
    const p = pinchAt(t);
    let grip = gripAt(t);
    // The flick: opening the fingers moves the pinch MIDPOINT, because the thumb and index do not separate
    // symmetrically. It starts exactly when the fingers start to open (flick.t), peaks half way, and is gone
    // by flick.ms — it is not a wobble around the release, it is a one-way lurch that begins with it.
    if (flick) {
      const u = clamp((t - flick.t) / (flick.ms || 250), 0, 1);
      if (u > 0) grip = vadd(grip, vmul(flick.by, Math.sin(u * Math.PI)));
    }
    const gap = openGap + (closedGap - openGap) * p;
    return { grip, pinch01: p, gap, done: t >= duration };
  };
}

// thumb and index, symmetric about the grip point along `axis` (the pinch closes across the hand)
export function fingersFor({ grip, gap }, axis = { x: 1, y: 0, z: 0 }) {
  const h = vmul(axis, gap / 2);
  return { thumb: vadd(grip, h), index: vadd(grip, vmul(h, -1)), grip: { ...grip } };
}

// ---------- the tracker: turns a script into the frames grab.js actually sees ----------
// `seenAt` is DELIVERY time, not capture time. A constant pipeline latency is not staleness: the hand is still
// there, we are just seeing where it was. Only a real dropout stops frames arriving, and then seenAt goes stale.
export function createTracker({
  sources = [],            // [{ id, script, axis? }]
  rateHz = 30,
  jitterSd = 0.008,        // metres per axis, common to the whole hand (mostly triangulated depth error)
  fingerSd = null,         // metres per axis, independent per fingertip: what makes the PINCH GAP noisy.
                           // Smaller than jitterSd because a hand's landmarks err together; default 0.35x.
  lagMs = 150,
  dropout = { everyMs: 1400, forMs: 180 },   // a periodic gap; set to null for none
  seed = 7,
} = {}) {
  const r = rng(seed);
  const period = 1000 / rateHz;
  const queue = [];        // { deliverAt, frames }
  const latest = new Map();
  let nextSample = 0, started = false, t0 = 0;

  function emit(tScript, nowStamp) {
    const frames = [];
    for (const s of sources) {
      const dropped = dropout && dropout.everyMs > 0 &&
        (tScript % dropout.everyMs) < dropout.forMs && (s.dropouts !== false);
      if (dropped) continue;
      const raw = s.script(tScript);
      const fsd = fingerSd == null ? jitterSd * 0.35 : fingerSd;
      const n = gauss3(r, jitterSd);
      const f = fingersFor({ grip: vadd(raw.grip, n), gap: raw.gap }, s.axis);
      const thumb = vadd(f.thumb, gauss3(r, fsd)), index = vadd(f.index, gauss3(r, fsd));
      frames.push({ id: s.id, active: true, seenAt: nowStamp, thumb, index, truth: raw.grip });
    }
    return frames;
  }

  return {
    rateHz, period,
    get lagMs() { return lagMs; },
    set lagMs(v) { lagMs = v; },
    get jitterSd() { return jitterSd; },
    set jitterSd(v) { jitterSd = v; },
    get dropout() { return dropout; },
    set dropout(v) { dropout = v; },
    reset(now = 0) { queue.length = 0; latest.clear(); nextSample = 0; started = true; t0 = now; },

    // Call once per render frame. Returns the hand frames that have arrived by `now`, repeating the last
    // delivered set between sensor frames (which is what a real app does).
    poll(now) {
      if (!started) { started = true; t0 = now; }
      const elapsed = now - t0;
      while (nextSample <= elapsed) {
        queue.push({ deliverAt: t0 + nextSample + lagMs, tScript: nextSample });
        nextSample += period;
      }
      while (queue.length && queue[0].deliverAt <= now) {
        const q = queue.shift();
        for (const f of emit(q.tScript, now)) latest.set(f.id, f);
      }
      return [...latest.values()].map(f => ({ ...f }));
    },
    // the noiseless truth at a script time, for tests that want to measure error
    truthAt: (id, t) => sources.find(s => s.id === id)?.script(t) || null,
  };
}

// ---------- a canned reach / pinch / lift / carry / drop, in metres in the rig's working volume ----------
export function demoScript({ start = v3(-0.09, 0.05, 0.06), target = v3(0, 0.12, 0), carry = v3(0.08, 0.20, -0.04),
                             flickBy = v3(0.045, -0.02, 0.03) } = {}) {
  return makeScript([
    { t: 0,    grip: start,  pinch: false },
    { t: 700,  grip: target, pinch: false },
    { t: 900,  grip: target, pinch: true },
    { t: 1500, grip: vadd(target, v3(0, 0.05, 0)), pinch: true },
    { t: 2400, grip: carry,  pinch: true },
    { t: 3000, grip: carry,  pinch: true },
    { t: 3100, grip: carry,  pinch: false },
    { t: 3800, grip: vadd(carry, v3(0.05, 0.03, 0.05)), pinch: false },
  ], { flick: { t: 3100, ms: 260, by: flickBy } });   // starts on the opening keyframe, peaks 130 ms later
}

// Two hands on one model: hand 0 takes it, hand 1 joins, together they turn it a quarter turn and spread to
// resize it, then both let go. Returns [script0, script1].
export function twoHandScripts({ target = v3(0, 0.12, 0), grip = 0.055, spread = 0.09, turn = Math.PI / 2 } = {}) {
  // hand 0 starts on -x and hand 1 on +x; both swing round to ∓z, which is a quarter turn about y
  const at = (side, angle, r) => v3(target.x + Math.cos(angle) * r * side, target.y, target.z + Math.sin(angle) * r * side);
  const make = (side, pinchAt, home) => makeScript([
    { t: 0,    grip: home,                     pinch: false },
    { t: 900,  grip: at(side, 0, grip),        pinch: false },
    { t: pinchAt, grip: at(side, 0, grip),     pinch: false },
    { t: pinchAt + 150, grip: at(side, 0, grip), pinch: true },
    { t: 2000, grip: at(side, 0, grip),        pinch: true },
    { t: 3000, grip: at(side, turn, grip),     pinch: true },
    { t: 3900, grip: at(side, turn, spread),   pinch: true },
    { t: 4400, grip: at(side, turn, spread),   pinch: true },
    { t: 4550, grip: at(side, turn, spread),   pinch: false },
    { t: 5400, grip: home,                     pinch: false },
  ], { flick: { t: 4550, ms: 260, by: v3(0.03 * side, -0.02, 0.02) } });
  return [
    make(-1, 950, v3(-0.13, 0.03, 0.09)),
    make(1, 1550, v3(0.13, 0.03, 0.09)),
  ];
}
