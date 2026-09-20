// The one line between the tracking solver and the grab.
//
// grab.js is in metres because the sensors are; public/js/input/state.js is in centimetres because the app
// is. Getting that wrong does not crash: the pinch thresholds come out 100x too small, nothing is ever
// grabbable, and it looks like the tracking is broken. So the conversion lives here, once, and a caller
// says what its scene units are instead of scaling numbers by hand.
//
// It reads the shared input object the solver publishes (input/solver.js -> track/solve.js Tracker ->
// state.js), so it works identically with the ZED pair, the LAN bridge, one webcam or the mouse.

import { createGrab } from './grab.js';
import { GRAB_CONFIG, scaleConfig, cloneConfig } from './config.js';

/**
 * Hands from the shared input object (public/js/input/state.js), in the SCENE's units.
 *
 * `unitsPerMetre` means the same thing here as in scaleConfig() and createFeedback(): how many scene units
 * make a metre (100 for the app's centimetres). All three multiply, and none of them converts the hands,
 * because state.js already publishes in the scene's frame and the scene's units — the solver did that
 * conversion once, through Tracker.appScale.
 *
 * That agreement is load-bearing and it was the bug that hid in the join: an earlier version divided here
 * while scaleConfig multiplied, so the hands arrived in metres and the thresholds were in centimetres. It
 * does not crash. The pinch gap reads 0.075 against a 2.5 threshold, so the hand is permanently pinched;
 * every body is 40 "units" away, so nothing is ever in reach; and the whole thing looks like a tracking
 * failure. `inputUnitsPerMetre` is the escape hatch for the day state.js really does move to metres while
 * the scene stays in centimetres — set it, and only then is anything scaled.
 */
export function handsFromInput(input, now, { unitsPerMetre = 1, inputUnitsPerMetre = unitsPerMetre,
                                             maxAgeMs = null } = {}) {
  const out = [];
  const k = unitsPerMetre / inputUnitsPerMetre;      // 1 in every case the app actually runs
  const finite = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  input.hands.forEach((h, id) => {
    if (!h.active) return;
    // The solver keeps a hand `active` with its pose FROZEN for maxAgeMs (300 ms) after the last sighting,
    // and grab.js then starts its own dropoutMs clock only once that grace is up — so the two windows ran
    // in series and a held model stayed glued to a dead hand for ~450 ms, not the 200 ms grab.js documents
    // and tests. Dropping a hand here as soon as it is older than the grab's own window makes 'active' and
    // 'live' agree at the boundary, so exactly one clock ever runs.
    if (maxAgeMs != null && now != null && h.seenAt != null && now - h.seenAt > maxAgeMs) return;
    const joints = h.jointsWorld;
    const at = i => ({ x: joints[i * 3] * k, y: joints[i * 3 + 1] * k, z: joints[i * 3 + 2] * k });
    // landmark 4 is the thumb tip and 8 the index tip: the pinch pair MediaPipe gives and the ZED body
    // formats do not (see docs/v3-plan.json research notes)
    if (joints && joints.length >= 27) {
      const thumb = at(4), index = at(8);
      if (finite(thumb) && finite(index)) { out.push({ id, active: true, seenAt: h.seenAt, thumb, index }); return; }
    }
    const grip = h.gripRaw || h.grip;
    if (!finite(grip)) return;
    out.push({ id, active: true, seenAt: h.seenAt,
               grip: { x: grip.x * k, y: grip.y * k, z: grip.z * k }, pinch: !!h.pinch });
  });
  return out;
}

let warnedNoVolume = false;

/**
 * @param opts.unitsPerMetre  100 for a centimetre scene (what state.js publishes), 1 for metres.
 * @param opts.config         a base config in METRES; it is scaled for you.
 * @param opts.overrides      applied AFTER scaling, so it is in scene units. `volume` and `floorY` are
 *                            effectively REQUIRED: config.js's box describes grab-demo.html's metre
 *                            scene, not yours, and clamping into somebody else's frame yanks the model
 *                            across the volume on the very first grab. Without them, this turns clamping
 *                            and gravity off rather than pretend to know where your floor is.
 */
export function createSceneGrab({ unitsPerMetre = 100, config = GRAB_CONFIG, overrides = {} } = {}) {
  const cfg = Object.assign(scaleConfig(cloneConfig(config), unitsPerMetre), overrides);
  if (overrides.volume == null) {
    cfg.clampToVolume = false;
    cfg.settleGravity = 0;     // there is no floor to fall to if nobody has said where the floor is
    if (!warnedNoVolume) {
      warnedNoVolume = true;
      console.warn('[grab] createSceneGrab was given no `overrides.volume`, so clamping and gravity are ' +
                   'off. Pass the volume your scene actually works in (and floorY) to get them back.');
    }
  }
  const grab = createGrab({ config: cfg });
  return {
    grab, config: cfg, unitsPerMetre,
    /** Hands as grab.js wants them, straight from the shared input object. */
    hands: (input, now) => handsFromInput(input, now, { unitsPerMetre, maxAgeMs: cfg.dropoutMs }),
    /** One frame: read the solver's output, drive the bodies. Returns grab's frame. */
    step(input, bodies, now) {
      return grab.update({ hands: handsFromInput(input, now, { unitsPerMetre, maxAgeMs: cfg.dropoutMs }), bodies, now });
    },
  };
}

/**
 * How far behind the hand the held body is, and how much it shakes. Both are what the user actually feels,
 * and neither can be read off a single frame, so this keeps the short history it needs.
 *
 * Lag is measured by CROSS-CORRELATION of the two speed traces rather than by comparing positions: the
 * body sits at an offset from the hand by design (the anchor), so a position difference is mostly that
 * offset and says nothing about latency. Shake is the frame-to-frame step of the body while the hand is
 * nearly still, because a step while carrying is mostly real travel.
 */
export function createLagMeter({ windowMs = 1500, stillSpeed = 0.05 } = {}) {
  const samples = [];       // { t, hand:{x,y,z}, body:{x,y,z} }
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  return {
    get samples() { return samples; },
    push(now, hand, body) {
      if (!hand || !body) return;
      samples.push({ t: now, hand: { ...hand }, body: { ...body } });
      while (samples.length && now - samples[0].t > windowMs) samples.shift();
    },
    reset() { samples.length = 0; },

    /** Best-fit delay in ms of the body's speed trace behind the hand's, plus how well it correlates. */
    lagMs(maxLagMs = 300) {
      if (samples.length < 8) return { ms: null, r: 0, n: samples.length };
      const dt = (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1);
      const speed = key => samples.slice(1).map((s, i) => d(s[key], samples[i][key]) / Math.max(1e-6, (s.t - samples[i].t) / 1000));
      const h = speed('hand'), b = speed('body');
      const demean = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.map(v => v - m); };
      const H = demean(h), B = demean(b);
      const maxShift = Math.min(H.length - 4, Math.round(maxLagMs / Math.max(1e-6, dt)));
      const rs = [];
      for (let s = 0; s <= maxShift; s++) {
        let num = 0, dh = 0, db = 0;
        for (let i = 0; i + s < H.length; i++) { num += H[i] * B[i + s]; dh += H[i] * H[i]; db += B[i + s] * B[i + s]; }
        rs.push(dh > 0 && db > 0 ? num / Math.sqrt(dh * db) : 0);
      }
      let best = 0;
      rs.forEach((r, s) => { if (r > rs[best]) best = s; });
      // The true peak is rarely on a frame boundary, and reporting "one frame" for anything between 0 and
      // 33 ms hides exactly the difference worth seeing. A parabola through the three samples around the
      // peak recovers the sub-frame part.
      let sub = best;
      if (best > 0 && best < rs.length - 1) {
        const a = rs[best - 1], b = rs[best], c = rs[best + 1], den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) sub = best + 0.5 * (a - c) / den;
      }
      return { ms: Math.max(0, sub * dt), peakFrames: best, r: rs[best], n: samples.length, dtMs: dt };
    },

    /** rms and worst frame-to-frame step of the body while the hand is nearly still, in scene units. */
    jitter() {
      const steps = [];
      for (let i = 1; i < samples.length; i++) {
        const dtSec = Math.max(1e-6, (samples[i].t - samples[i - 1].t) / 1000);
        if (d(samples[i].hand, samples[i - 1].hand) / dtSec > stillSpeed) continue;
        steps.push(d(samples[i].body, samples[i - 1].body));
      }
      if (!steps.length) return { rms: null, worst: null, n: 0 };
      return {
        rms: Math.sqrt(steps.reduce((s, v) => s + v * v, 0) / steps.length),
        worst: Math.max(...steps), n: steps.length,
      };
    },
  };
}
