// The tracking pipeline: camera observations in, the app's shared input shape out.
//
// It takes two kinds of input and treats them the same downstream:
//   observe2D  per-camera MediaPipe landmarks (face and hands) in pixels — one camera, two halves of a
//              ZED side-by-side frame, or any number of webcams;
//   observe3D  points that are already 3D, from a bridge process running the ZED SDK on another machine.
//
// Then: match each hand across cameras, triangulate every landmark, throw out views that disagree, filter
// in 3D, and fall back to one camera (depth from palm size / eye spacing, which is what the app does today)
// whenever there is only one view. Everything is millimetres in the rig frame until publish(), which
// converts to the centimetres public/js/input/state.js uses.

import { add, scale, dist, mean, matVec } from './linalg.js';
import { triangulate, triangulateRobust } from './triangulate.js';
import { makeEyeFilter, makeHandFilter, HandFilterBank, HAND_FILTER } from './filter.js';
import { HAND, PALM, PINCH, IPD } from './landmarks.js';

const KEY_LANDMARKS = [HAND.WRIST, HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_MCP];   // enough to match hands
const HISTORY = 12;

// How much to trust one camera's measurement, as an inverse variance. It has to be ANGULAR, not in
// pixels: one pixel of the ZED's 110-degree lens is nearly three times the angle of one pixel of a 1080p
// webcam, so weighting by pixel noise alone quietly hands the wide lens as much say as the sharp one.
const camWeight = camera => (camera.fx / Math.max(0.05, camera.noisePx || 1)) ** 2;

const lerpPt = (a, b, t) => ({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t,
                               z: a.z != null && b.z != null ? a.z + (b.z - a.z) * t : (a.z ?? b.z) });

/** Per-camera ring buffer of observations, so views captured at different times can be lined up. */
class CameraTrack {
  constructor(camera) { this.camera = camera; this.frames = []; }
  push(frame) {
    this.frames.push(frame);
    this.frames.sort((a, b) => a.tMs - b.tMs);
    while (this.frames.length > HISTORY) this.frames.shift();
  }
  get latest() { return this.frames[this.frames.length - 1] || null; }

  /** Blend two frames in pixel space. t between 0 and 1 interpolates; t above 1 extrapolates past b. */
  static blend(a, b, t, tMs) {
    const face = a.face && b.face && a.face.length === b.face.length
      ? a.face.map((p, k) => lerpPt(p, b.face[k], t)) : (t < 0.5 ? a.face : b.face);
    const hands = [];
    for (const ha of a.hands || []) {
      const hb = (b.hands || []).find(h => h.handedness === ha.handedness);
      hands.push(hb && hb.pts.length === ha.pts.length
        ? { ...ha, pts: ha.pts.map((p, k) => lerpPt(p, hb.pts[k], t)) } : ha);
    }
    return { tMs, face, hands, staleMs: 0, interpolated: true };
  }

  /**
   * The observation this camera would have had at time t.
   *
   * Between two frames it interpolates in pixel space, which is what removes the error free-running
   * cameras inject when the subject moves. PAST its newest frame it extrapolates from the last two, up to
   * extrapolateMs — that is what lets every camera be lined up to the NEWEST capture instead of the
   * oldest, so a 30 Hz camera joining a 60 Hz pair adds its accuracy without adding its lag. Extrapolation
   * amplifies landmark noise, so the window is deliberately under one frame period.
   */
  sampleAt(tMs, interpolate = true, extrapolateMs = 0) {
    if (!this.frames.length) return null;
    const f = this.frames;
    if (!interpolate) { const l = f[f.length - 1]; return { ...l, staleMs: Math.max(0, tMs - l.tMs), interpolated: false }; }
    if (tMs <= f[0].tMs) return { ...f[0], staleMs: f[0].tMs - tMs, interpolated: false };
    const last = f[f.length - 1], prev = f[f.length - 2];
    if (tMs >= last.tMs) {
      const gap = tMs - last.tMs, span = prev ? last.tMs - prev.tMs : 0;
      if (!extrapolateMs || !prev || gap > extrapolateMs || span < 1e-6 || span > 120)
        return { ...last, staleMs: gap, interpolated: false };
      return { ...CameraTrack.blend(prev, last, 1 + gap / span, tMs), staleMs: 0, extrapolated: true };
    }
    let i = 0;
    while (i < f.length - 2 && f[i + 1].tMs < tMs) i++;
    const a = f[i], b = f[i + 1], span = b.tMs - a.tMs;
    return CameraTrack.blend(a, b, span > 1e-6 ? (tMs - a.tMs) / span : 0, tMs);
  }
}

/** One tracked hand slot: filters and pinch state that must survive between frames. */
class HandSlot {
  constructor(index) {
    this.index = index;
    this.bank = new HandFilterBank(HAND.COUNT);
    this.tipFilter = makeHandFilter();
    this.gripFilter = makeHandFilter();
    this.points = null;          // filtered, mm, rig frame
    this.raw = null;
    this.tip = null; this.grip = null; this.gripRaw = null;
    this.handedness = null;
    this.pinch = false; this.pinchDistMm = Infinity; this.pinchRatio = 1; this.pinchFrames = 0;
    this.seenAtMs = -1e9; this.active = false;
    this.source = 'none'; this.views = 0; this.rmsPx = 0;
  }
  reset() {
    this.bank.reset(); this.tipFilter.reset(); this.gripFilter.reset();
    this.points = this.raw = this.tip = this.grip = this.gripRaw = null;
    this.pinch = false; this.pinchFrames = 0; this.source = 'none'; this.views = 0;
  }
}

export class Tracker {
  /**
   * @param cameras      PinholeCamera[] posed in the rig frame.
   * @param appScale     rig mm -> app units. The web app works in centimetres, so 0.1.
   * @param ipdMm        the user's interpupillary distance; the single-camera depth estimate is directly
   *                     proportional to it, so a one-off calibration here is worth about +-40 mm at 600 mm.
   */
  constructor({ cameras = [], appScale = 0.1, appTransform = null, ipdMm = IPD.defaultMm, eye = 'center',
                maxAgeMs = 300, pinch = PINCH, filters = {}, interpolate = true, extrapolateMs = 20 } = {}) {
    // Line every camera up to one instant before triangulating. Cameras that are not hardware-synced
    // sample the world at their own phase, and feeding those straight into the geometry bends it.
    this.interpolate = interpolate;
    this.lineUpWindowMs = 40;      // never wait longer than this for a lagging camera
    this.extrapolateMs = extrapolateMs;  // how far a laggard may be pulled forward (0 disables it)
    this.staleFrames = 2.5;        // a camera's newest frame counts for this many of its own frame periods
    this.tracks = new Map();
    this.appScale = appScale;
    this.appTransform = appTransform;   // optional { R, t, scale } rig frame -> the app's world frame
    this.ipdMm = ipdMm;
    this.eyeSide = eye;
    this.maxAgeMs = maxAgeMs;
    this.pinchCfg = { ...PINCH, ...pinch };
    this.eyeFilter = makeEyeFilter();
    if (filters.eye) { this.eyeFilter.minCutoff = filters.eye.minCutoff; this.eyeFilter.beta = filters.eye.beta; }
    this.handCfg = { ...HAND_FILTER, ...(filters.hand || {}) };
    this.slots = [new HandSlot(0), new HandSlot(1)];
    for (const s of this.slots) this.retune(s);
    this.eye = null; this.eyeSeenAtMs = -1e9; this.eyeSource = 'none';
    this.bridge = null;                       // latest observe3D payload
    this.bridgeTransform = null;              // { R, t, scale } bridge frame -> rig frame
    this.quality = emptyQuality();
    this.setCameras(cameras);
  }

  retune(slot) {
    const { minCutoff, beta } = this.handCfg;
    for (const f of [...slot.bank.filters, slot.tipFilter, slot.gripFilter]) { f.minCutoff = minCutoff; f.beta = beta; }
  }

  setCameras(cameras) {
    const next = new Map();
    for (const c of cameras) next.set(c.id, this.tracks.get(c.id) && this.tracks.get(c.id).camera === c
      ? this.tracks.get(c.id) : new CameraTrack(c));
    this.tracks = next;
    return this;
  }
  get cameras() { return [...this.tracks.values()].map(t => t.camera); }

  /**
   * One camera's landmarks for one frame.
   * @param camId      matches a camera's id.
   * @param tMs        CAPTURE time, not arrival time (prefer requestVideoFrameCallback's mediaTime).
   * @param face       [{x,y}|{u,v}] the two iris centres (or eye-corner midpoints), in the order
   *                   [viewer's right eye, viewer's left eye] as they appear in the raw image.
   * @param hands      [{ handedness: 'Left'|'Right', score, landmarks: [{x,y,z}] x21 }]
   * @param normalized true when x/y are MediaPipe's 0..1 (the default).
   */
  observe2D({ camId, tMs, face = null, hands = [], normalized = true }) {
    const track = this.tracks.get(camId);
    if (!track) return this;
    const { width, height } = track.camera;
    const conv = p => (normalized
      ? { u: (p.x ?? p.u) * width, v: (p.y ?? p.v) * height, z: p.z }
      : { u: p.u ?? p.x, v: p.v ?? p.y, z: p.z });
    track.push({
      tMs,
      face: face && face.length >= 2 ? face.map(conv) : null,
      hands: (hands || []).filter(h => h && h.landmarks && h.landmarks.length === HAND.COUNT)
        .map(h => ({ handedness: h.handedness || 'Unknown', score: h.score ?? 1, pts: h.landmarks.map(conv) })),
    });
    return this;
  }

  /**
   * Points that are already 3D — the ZED SDK bridge. Millimetres in the bridge's own frame; the
   * similarity from setBridgeTransform() puts them in the rig frame. Our code never links the SDK: this
   * arrives over a socket as plain numbers.
   */
  observe3D({ tMs, hands = [], eye = null, source = 'bridge' }) {
    this.bridge = { tMs, source, eye, hands: hands.map(h => ({ handedness: h.handedness || 'Unknown',
      score: h.score ?? 1, points: h.points.map(p => this.fromBridge(p)) })) };
    if (eye) this.bridge.eye = this.fromBridge(eye);
    return this;
  }
  setBridgeTransform(tr) { this.bridgeTransform = tr; return this; }
  fromBridge(p) {
    const tr = this.bridgeTransform;
    if (!tr || !p) return p ? p.slice() : null;
    return add(scale(matVec(tr.R, p), tr.scale ?? 1), tr.t);
  }

  // ---------- the frame ----------

  /** How old one camera's newest frame may be before it stops counting as a measurement. */
  frameStaleMs(camera) { return Math.max(60, this.staleFrames * 1000 / (camera.fps || 30)); }

  /**
   * Pick the instant to solve at for one group of cameras. Three strategies, measured against each other
   * in the simulator (test/sim-session.test.js prints the numbers):
   *
   *  - no lining up: take each camera's newest frame as if they were simultaneous. Cheapest, and it bends
   *    the geometry as soon as anything moves — 3.6 mm to 6.2 mm on a fast hand in the measured case.
   *  - wait for the slowest: solve at the OLDEST of the group's newest frames, so every other camera has
   *    frames either side and interpolates cleanly. Best geometry there is (0.7 mm with three cameras) and
   *    the worst thing the user sees, because the answer arrives 13 ms later than it needed to.
   *  - pull the laggards forward (the default): solve at the NEWEST frame and extrapolate the slow cameras
   *    to it. A little worse on geometry, much better on latency, and it wins on total error every time.
   *
   * lineUpWindowMs caps how far back the waiting strategy may go, so one stalled camera cannot drag the
   * whole answer into the past.
   */
  referenceTime(group) {
    if (!group.length) return null;
    const latest = group.map(t => t.latest.tMs), newest = Math.max(...latest);
    if (!this.interpolate || group.length < 2) return newest;
    if (this.extrapolateMs > 0) return newest;
    return Math.max(Math.min(...latest), newest - this.lineUpWindowMs);
  }

  /** @returns { tMs, tEyeMs, tHandMs, eye, hands, quality } with every length in millimetres. */
  solve(nowMs) {
    const q = emptyQuality();
    q.nowMs = nowMs;
    // A camera that has stopped delivering must stop being believed, and quickly. Re-using its last frame
    // gives a hand frozen in mid-air still holding the model — the worst failure there is, because it
    // looks like it is working. The bound is a couple of that camera's own frame periods, so a single
    // dropped detection is covered and a real stall is not.
    const tracks = [...this.tracks.values()]
      .filter(t => t.latest && nowMs - t.latest.tMs <= this.frameStaleMs(t.camera));
    q.cameras = tracks.length;
    q.stale = this.tracks.size - tracks.length;

    // The head and the hands get their OWN reference time. They are watched by different cameras running
    // at different rates, and making the fast ZED wait for a 30 Hz webcam would add lag to the hands for
    // no reason at all.
    const faceTracks = tracks.filter(t => t.latest.face);
    const handTracks = tracks.filter(t => t.latest.hands && t.latest.hands.length);
    const tFace = this.referenceTime(faceTracks), tHand = this.referenceTime(handTracks);
    const refT = Math.max(this.bridge ? this.bridge.tMs : -Infinity,
                          tFace ?? -Infinity, tHand ?? -Infinity);
    if (!Number.isFinite(refT)) {
      // Nothing fresh from anywhere. Still run the expiry, or a hand that vanished stays pinched for ever.
      this.expireSlots(nowMs, []);
      if (nowMs - this.eyeSeenAtMs > 1500) this.eyeFilter.reset();
      this.quality = q;
      return { tMs: nowMs, tEyeMs: nowMs, tHandMs: nowMs, eye: this.eye, hands: this.readSlots(nowMs), quality: q };
    }
    q.tMs = refT;
    q.latencyMs = Math.max(0, nowMs - refT);

    const take = (group, t) => group
      .map(tr => ({ track: tr, sample: tr.sampleAt(t, this.interpolate, this.extrapolateMs) }))
      .filter(s => s.sample);
    const faceSamples = tFace == null ? [] : take(faceTracks, tFace);
    const handSamples = tHand == null ? [] : take(handTracks, tHand);
    const all = [...faceSamples, ...handSamples];
    q.staleMaxMs = Math.max(0, ...all.map(s => s.sample.staleMs || 0));
    q.interpolated = all.filter(s => s.sample.interpolated).length;

    this.solveEye(faceSamples, tFace ?? refT, nowMs, q);
    this.solveHands(handSamples, tHand ?? refT, nowMs, q);

    this.quality = q;
    return { tMs: refT, tEyeMs: tFace ?? refT, tHandMs: tHand ?? refT,
             eye: this.eye, hands: this.readSlots(nowMs), quality: q };
  }

  solveEye(samples, refT, nowMs, q) {
    const views = samples.filter(s => s.sample.face && s.sample.face.length >= 2);
    if (this.bridge && this.bridge.eye && nowMs - this.bridge.tMs < this.maxAgeMs) {
      this.setEye(this.bridge.eye, refT, 'bridge', q);
      q.eyeViews = 1;
      return;
    }
    if (!views.length) { if (nowMs - this.eyeSeenAtMs > 1500) this.eyeFilter.reset(); return; }
    q.eyeViews = views.length;

    if (views.length >= 2) {
      // Triangulate each iris separately: the midpoint of two well-triangulated eyes is steadier than
      // triangulating a midpoint, and the recovered spacing is a free check on the whole calibration.
      const eyes = [0, 1].map(k => triangulateRobust(
        views.map(s => ({ camera: s.track.camera, u: s.sample.face[k].u, v: s.sample.face[k].v,
                          weight: camWeight(s.track.camera) })),
        { maxReprojPx: 6 }));
      if (eyes.every(e => e.ok && e.point)) {
        q.eyeRmsPx = mean(eyes.map(e => e.rmsPx));
        q.measuredIpdMm = dist(eyes[0].point, eyes[1].point);
        const pick = this.eyeSide === 'right' ? eyes[0].point : this.eyeSide === 'left' ? eyes[1].point
          : scale(add(eyes[0].point, eyes[1].point), 0.5);
        this.setEye(pick, refT, 'stereo', q);
        return;
      }
    }
    // One camera (or a failed triangulation): depth from the pixel spacing of the irises.
    const s = views[0], cam = s.track.camera, a = s.sample.face[0], b = s.sample.face[1];
    const ipdPx = Math.hypot(a.u - b.u, a.v - b.v);
    if (ipdPx < 1) return;
    const depth = cam.fx * this.ipdMm / ipdPx;
    const mid = this.eyeSide === 'right' ? a : this.eyeSide === 'left' ? b
      : { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
    q.measuredIpdMm = this.ipdMm;
    this.setEye(cam.unproject(mid.u, mid.v, depth), refT, 'mono', q);
  }

  setEye(point, tMs, source, q) {
    this.eye = this.eyeFilter.filter(point, tMs / 1000);
    this.eyeRaw = point.slice();
    this.eyeSeenAtMs = tMs;
    this.eyeSource = source;
    if (q) { q.eyeSource = source; q.eyeSpeedMmS = this.eyeFilter.speed; }
  }

  solveHands(samples, refT, nowMs, q) {
    let dets = [];
    if (this.bridge && this.bridge.hands.length && nowMs - this.bridge.tMs < this.maxAgeMs) {
      dets = this.bridge.hands.map(h => ({ handedness: h.handedness, points: h.points, source: 'bridge',
                                           views: 1, rmsPx: 0 }));
    } else {
      const withHands = samples.filter(s => s.sample.hands && s.sample.hands.length);
      if (withHands.length) dets = this.reconstructHands(withHands, q);
    }
    q.handsSeen = dets.length;

    const slots = dets.length ? assignSlots(this.slots, dets, nowMs) : [];
    dets.forEach((det, i) => this.updateSlot(this.slots[slots[i]], det, refT, nowMs));
    this.expireSlots(nowMs, slots);
    q.handRmsPx = mean(dets.map(d => d.rmsPx).filter(Number.isFinite));
    q.handViews = Math.max(0, ...dets.map(d => d.views));
    q.handSource = dets.length ? dets[0].source : 'none';
  }

  /**
   * Slots that got no detection this frame. A pinch survives a short gap — MediaPipe and any stereo
   * matcher both drop frames, and letting go of the model every time a hand flickers feels broken in a way
   * no threshold tuning fixes — but a real loss of tracking does eventually release it.
   */
  expireSlots(nowMs, filled) {
    this.slots.forEach((slot, i) => {
      if (filled.includes(i)) return;
      const age = nowMs - slot.seenAtMs;
      if (age > this.pinchCfg.releaseHoldMs) slot.pinch = false;
      if (age > 500) slot.reset();
    });
  }

  /** Cross-camera matching plus per-landmark triangulation. Falls back to one camera when that is all there is. */
  reconstructHands(withHands, q) {
    const groups = matchHandsAcrossCameras(withHands);
    const out = [];
    for (const group of groups) {
      if (group.views.length >= 2) {
        const points = [], errs = [];
        let rejected = 0, degenerate = 0;
        for (let i = 0; i < HAND.COUNT; i++) {
          const views = group.views.map(v => ({ camera: v.camera, u: v.pts[i].u, v: v.pts[i].v,
                                                weight: camWeight(v.camera) }));
          const r = triangulateRobust(views, { maxReprojPx: 5 });
          rejected += (r.rejected || []).length;
          if (r.degenerate) degenerate++;
          points.push(r.point && (r.ok || !r.behind) ? r.point : null);
          if (Number.isFinite(r.rmsPx)) errs.push(r.rmsPx);
        }
        if (points.filter(Boolean).length >= HAND.COUNT / 2) {
          q.rejectedViews += rejected; q.degenerate += degenerate;
          out.push({ handedness: group.handedness, points, source: 'stereo',
                     views: group.views.length, rmsPx: mean(errs) });
          continue;
        }
      }
      const v = group.views[0];
      const points = monoHandToRig(v.camera, v.pts);
      if (points) out.push({ handedness: group.handedness, points, source: 'mono', views: 1, rmsPx: 0 });
    }
    return out;
  }

  updateSlot(slot, det, tMs, nowMs) {
    const tSec = tMs / 1000;
    slot.raw = det.points;
    slot.points = slot.bank.filterAll(det.points, tSec);
    slot.handedness = det.handedness;
    slot.source = det.source; slot.views = det.views; slot.rmsPx = det.rmsPx;
    const tip = det.points[HAND.INDEX_TIP], thumb = det.points[HAND.THUMB_TIP];
    if (tip) slot.tip = slot.tipFilter.filter(tip, tSec);
    if (tip && thumb) {
      const grip = scale(add(tip, thumb), 0.5);
      slot.gripRaw = grip;
      slot.grip = slot.gripFilter.filter(grip, tSec);
      slot.pinchDistMm = dist(tip, thumb);
      const span = det.points[HAND.WRIST] && det.points[HAND.MIDDLE_MCP]
        ? dist(det.points[HAND.WRIST], det.points[HAND.MIDDLE_MCP]) : PALM.wristToMiddleMcpMm;
      slot.pinchRatio = slot.pinchDistMm / Math.max(1, span);
      // Hysteresis plus a two-frame hold: 25 mm in, 30 mm out (Ultraleap's published pinch thresholds).
      const closing = slot.pinchDistMm < this.pinchCfg.closeMm;
      const opening = slot.pinchDistMm > this.pinchCfg.openMm;
      if (!slot.pinch && closing) { slot.pinchFrames++; if (slot.pinchFrames >= this.pinchCfg.holdFrames) slot.pinch = true; }
      else if (slot.pinch && opening) { slot.pinchFrames = 0; slot.pinch = false; }
      else if (!closing) slot.pinchFrames = 0;
    }
    slot.seenAtMs = nowMs;
  }

  readSlots(nowMs) {
    return this.slots.map(s => {
      s.active = nowMs - s.seenAtMs < this.maxAgeMs && !!s.points;
      return { index: s.index, active: s.active, handedness: s.handedness, tip: s.tip, grip: s.grip,
               gripRaw: s.gripRaw, points: s.points, raw: s.raw, pinch: s.pinch,
               pinchDistMm: s.pinchDistMm, pinchRatio: s.pinchRatio, source: s.source,
               views: s.views, rmsPx: s.rmsPx, ageMs: nowMs - s.seenAtMs };
    });
  }

  /**
   * Write into the object public/js/input/state.js exports: { eye, hands: [{ active, tip, grip, pinch,
   * pinchRatio, gripRaw, jointsWorld, seenAt }] }. Vectors are written through .set() so this works with
   * THREE.Vector3 without importing three. appScale converts rig millimetres to the app's centimetres, and
   * appTransform (optional) rotates/translates the rig frame into the app's world frame.
   */
  publish(input, nowMs = 0) {
    const k = this.appScale, T = this.appTransform;
    const toApp = p => {
      const q = T ? add(scale(matVec(T.R, p), T.scale ?? 1), T.t) : p;
      return [q[0] * k, q[1] * k, q[2] * k];
    };
    if (this.eye && input.eye) { const e = toApp(this.eye); input.eye.set(e[0], e[1], e[2]); }
    if (this.eyeSeenAtMs > -1e8) input.faceSeenAt = this.eyeSeenAtMs;
    // input.mode is a two-valued contract the whole app reads ('camera' or 'mouse' — main.js and
    // interaction.js branch on it), so it must stay that. How many cameras and which source won is in
    // quality/readout, which is where a debug overlay should look.
    input.mode = this.quality.cameras || this.quality.handSource === 'bridge' ? 'camera' : input.mode;
    this.slots.forEach((s, i) => {
      const h = input.hands && input.hands[i];
      if (!h) return;
      h.active = nowMs - s.seenAtMs < this.maxAgeMs && !!s.points;
      h.pinch = s.pinch;
      h.pinchRatio = s.pinchRatio;
      // The metric thumb-index gap in app units. Grab logic should prefer this over pinchRatio now that it
      // is a real measured distance and not a proportion of a guessed palm.
      h.pinchCm = Number.isFinite(s.pinchDistMm) ? s.pinchDistMm * k * (T?.scale ?? 1) : null;
      h.seenAt = s.seenAtMs;
      if (s.tip && h.tip) { const p = toApp(s.tip); h.tip.set(p[0], p[1], p[2]); }
      if (s.grip && h.grip) { const p = toApp(s.grip); h.grip.set(p[0], p[1], p[2]); }
      if (s.gripRaw && h.gripRaw) { const p = toApp(s.gripRaw); h.gripRaw.set(p[0], p[1], p[2]); }
      if (s.points) {
        const arr = h.jointsWorld && h.jointsWorld.length === HAND.COUNT * 3 ? h.jointsWorld : new Float32Array(HAND.COUNT * 3);
        s.points.forEach((p, j) => {
          const q = p ? toApp(p) : [NaN, NaN, NaN];
          arr[j * 3] = q[0]; arr[j * 3 + 1] = q[1]; arr[j * 3 + 2] = q[2];
        });
        h.jointsWorld = arr;
      } else if (nowMs - s.seenAtMs > 500) h.jointsWorld = null;
    });
    return input;
  }

  /** A one-line readout for the debug overlay: what is tracking, how well and how late. */
  get readout() {
    const q = this.quality;
    return `${q.cameras} cam${q.cameras === 1 ? '' : 's'} · eye ${q.eyeSource}` +
      (q.eyeRmsPx ? ` ${q.eyeRmsPx.toFixed(1)}px` : '') +
      ` · hands ${q.handSource} ${q.handViews}v` + (q.handRmsPx ? ` ${q.handRmsPx.toFixed(1)}px` : '') +
      ` · ${q.latencyMs.toFixed(0)} ms`;
  }
}

function emptyQuality() {
  return { nowMs: 0, tMs: 0, cameras: 0, stale: 0, latencyMs: 0, staleMaxMs: 0, interpolated: 0,
           eyeViews: 0, eyeSource: 'none', eyeRmsPx: 0, eyeSpeedMmS: 0, measuredIpdMm: 0,
           handsSeen: 0, handViews: 0, handSource: 'none', handRmsPx: 0, rejectedViews: 0, degenerate: 0 };
}

/**
 * Which detection belongs to which hand across cameras. Handedness first (MediaPipe is reliable about it
 * when the palm is visible); when two hands share a label, pick the pairing whose key landmarks triangulate
 * with the lowest reprojection error, which is a geometric answer rather than a guess.
 */
export function matchHandsAcrossCameras(withHands) {
  const entries = withHands.map(s => ({ camera: s.track.camera, hands: s.sample.hands }));
  entries.sort((a, b) => b.hands.length - a.hands.length);
  const ref = entries[0];
  const groups = ref.hands.map(h => ({ handedness: h.handedness, views: [{ camera: ref.camera, pts: h.pts }] }));

  for (const entry of entries.slice(1)) {
    const cand = entry.hands.slice();
    if (!cand.length) continue;
    const cost = groups.map(g => cand.map(h => pairCost(g, entry.camera, h)));
    const taken = new Set();
    // At most two hands, so the exhaustive pairing is two comparisons.
    const order = groups.length === 2 && cand.length === 2 &&
      (cost[0][0] + cost[1][1]) > (cost[0][1] + cost[1][0]) ? [1, 0] : [0, 1];
    groups.forEach((g, gi) => {
      const ci = order[gi] ?? gi;
      if (ci >= cand.length || taken.has(ci)) return;
      if (!Number.isFinite(cost[gi][ci])) return;
      taken.add(ci);
      g.views.push({ camera: entry.camera, pts: cand[ci].pts });
    });
  }
  return groups;
}

function pairCost(group, camera, hand) {
  const base = group.views[0];
  if (group.handedness !== 'Unknown' && hand.handedness !== 'Unknown' && group.handedness !== hand.handedness) return 1e6;
  let total = 0, n = 0;
  for (const i of KEY_LANDMARKS) {
    const r = triangulate([{ camera: base.camera, u: base.pts[i].u, v: base.pts[i].v },
                           { camera, u: hand.pts[i].u, v: hand.pts[i].v }], { minAngleDeg: 0.2 });
    if (!r.point) return 1e6;
    total += Number.isFinite(r.rmsPx) ? r.rmsPx : 1e3; n++;
  }
  return n ? total / n : 1e6;
}

/**
 * One camera only: the depth of the whole hand comes from how big the palm looks, exactly as
 * public/js/input/webcam.js does today, and each landmark steps forward or back from that by MediaPipe's
 * relative z when it is present. This is the graceful-degradation path — no second view, no rig, no ZED.
 */
export function monoHandToRig(camera, pts) {
  const px = (a, b) => Math.hypot(pts[a].u - pts[b].u, pts[a].v - pts[b].v);
  const d1 = px(HAND.WRIST, HAND.MIDDLE_MCP), d2 = px(HAND.INDEX_MCP, HAND.PINKY_MCP);
  if (d1 < 2 && d2 < 2) return null;
  // Take the SHORTER implied depth: the segment that looks biggest is the one least foreshortened.
  const depths = [];
  if (d1 > 2) depths.push(camera.fx * PALM.wristToMiddleMcpMm / d1);
  if (d2 > 2) depths.push(camera.fx * PALM.indexToPinkyMcpMm / d2);
  const refDepth = Math.max(30, Math.min(...depths));
  const useZ = pts.every(p => Number.isFinite(p.z));
  const zRef = useZ ? (d1 >= d2 ? (pts[HAND.WRIST].z + pts[HAND.MIDDLE_MCP].z) / 2
                                : (pts[HAND.INDEX_MCP].z + pts[HAND.PINKY_MCP].z) / 2) : 0;
  const mmPerZ = camera.width * refDepth / camera.fx;    // MediaPipe z is in image-width units, like x
  return pts.map(p => {
    const depth = Math.max(30, refDepth + (useZ ? (p.z - zRef) * mmPerZ : 0));
    return camera.unproject(p.u, p.v, depth);
  });
}

/**
 * Keep each hand in the slot it was in last frame, so its filters, its pinch and anything holding the
 * model stay with it. Same rule as the current webcam tracker, in millimetres.
 */
export function assignSlots(slots, dets, nowMs, nearMm = 150) {
  const recent = slots.map(s => nowMs - s.seenAtMs < 500 && s.grip);
  const key = d => d.points[HAND.INDEX_TIP] || d.points[HAND.WRIST] || [0, 0, 0];
  if (dets.length === 1) {
    let best = -1, bestD = nearMm;
    slots.forEach((s, i) => {
      if (!recent[i]) return;
      const d = dist(s.grip, key(dets[0]));
      if (d < bestD) { best = i; bestD = d; }
    });
    if (best >= 0) return [best];
    // Nowhere near either slot: most likely the same hand after a fast move that tracking lost, so keep
    // the slot that was just tracking rather than opening the other one.
    return [recent[1] && !recent[0] ? 1 : 0];
  }
  const [a, b] = dets;
  if (recent[0] && recent[1]) {
    const keep = dist(slots[0].grip, key(a)) + dist(slots[1].grip, key(b));
    const swap = dist(slots[0].grip, key(b)) + dist(slots[1].grip, key(a));
    return keep <= swap ? [0, 1] : [1, 0];
  }
  if (recent[0] || recent[1]) {
    const s = recent[0] ? 0 : 1;
    const aIsIt = dist(slots[s].grip, key(a)) <= dist(slots[s].grip, key(b));
    return aIsIt ? [s, 1 - s] : [1 - s, s];
  }
  if (a.handedness !== b.handedness && a.handedness !== 'Unknown') return a.handedness === 'Right' ? [0, 1] : [1, 0];
  return key(a)[0] <= key(b)[0] ? [0, 1] : [1, 0];      // both new: the hand further left is slot 0
}
