// Multi-camera input: opens whatever is plugged in, runs landmark detection per view in a Web Worker,
// fuses the views into 3D world points, and writes them into the shared input object — so interaction,
// sculpting and the renderer read exactly what they read today and need no changes.
//
// Degrades on purpose: no cameras -> mouse mode; one plain webcam -> webcam.js, i.e. today's app,
// untouched; a ZED (or two webcams) -> triangulated 3D; a ZED on another machine -> tools/zed-bridge.
//
// The pure helpers at the top are the parts worth testing without hardware, and test/cameras-*.test.js does.

import { input } from './state.js';
import { S, makeFilter3 } from '../settings.js';
import * as devices from './devices.js';
import * as stereo from './stereo.js';
import { ZedClient } from './zed-client.js';
import { createSolver, camIdFor } from './solver.js';

// ---------------------------------------------------------------- pure helpers

// Never let inference queue: one frame in flight per view, and nothing older than maxAgeMs goes in at all.
// A late hand is worse than no hand, because the model has already moved on.
export class FrameGate {
  constructor({ maxInFlight = 1, maxAgeMs = 120 } = {}) {
    this.maxInFlight = maxInFlight; this.maxAgeMs = maxAgeMs;
    this.inFlight = 0; this.busyDrops = 0; this.staleDrops = 0; this.stallDrops = 0;
    this.sent = 0; this.done = 0; this.strikes = 0;
    this.latencyMs = 0; this.times = []; this.offeredAt = -1;
  }
  offer(at, now) {
    this.prune(now);
    if (this.inFlight >= this.maxInFlight) { this.busyDrops++; return false; }
    if (now - at > this.maxAgeMs) { this.staleDrops++; return false; }
    this.inFlight++; this.sent++; this.offeredAt = now; return true;
  }
  finish(at, now) {
    this.inFlight = Math.max(0, this.inFlight - 1); this.done++; this.strikes = 0; this.offeredAt = -1;
    this.latencyMs = this.latencyMs ? this.latencyMs * 0.8 + (now - at) * 0.2 : now - at;
    this.times.push(now);
    this.prune(now);
  }
  // A frame that went in but produced nothing (the worker was still loading, the crop failed). It must
  // still come out of the count, or the gate wedges shut and the camera looks dead for ever.
  abort() { this.inFlight = Math.max(0, this.inFlight - 1); this.lostDrops = (this.lostDrops || 0) + 1; this.offeredAt = -1; }

  /**
   * A worker that stops answering at all — the thread killed under memory pressure, a GPU reset taking
   * MediaPipe's delegate down — posts no message, so nothing ever frees the slot and the view stops
   * sending frames for the life of the page. Nothing else in this file has a timeout on inFlight, and a
   * ZED is worse than one lost view: startGrabLoop gates BOTH eyes on both gates, so one wedged eye ends
   * hand tracking. Returns true when it actually had to free a slot.
   */
  watchdog(now, timeoutMs = this.maxAgeMs * 4) {
    if (this.inFlight <= 0 || this.offeredAt < 0 || now - this.offeredAt <= timeoutMs) return false;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.stallDrops++; this.strikes++; this.offeredAt = -1;
    return true;
  }
  // Prune by WALL CLOCK, not only on a result: pruning inside finish() alone meant a wedged view kept
  // reporting its last good fps for ever, which is the number an operator reads to decide it is alive.
  prune(now) { while (this.times.length && now - this.times[0] > 1000) this.times.shift(); }
  fpsAt(now) { this.prune(now); return this.times.length; }
  get fps() { return this.times.length; }
  get drops() { return this.busyDrops + this.staleDrops + this.stallDrops; }
}

// Two free-running webcams are never in phase, so a landmark seen at t0 must be moved to the instant we
// are fusing at. Bracketing samples are interpolated; outside the bracket we accept the nearest sample
// only if it is closer in time than maxSkewMs.
export function interpolateLm(samples, t, maxSkewMs = 8) {
  if (!samples?.length) return null;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    if (a.at <= t && t <= b.at) {
      const alpha = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
      return { at: t, lm: a.lm.map((p, k) => p.map((v, j) => v + (b.lm[k][j] - v) * alpha)), interpolated: true };
    }
  }
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.at - t) < Math.abs(best.at - t)) best = s;
  return Math.abs(best.at - t) <= maxSkewMs ? { ...best, interpolated: false } : null;
}

// Same hand, two views. Handedness agreement counts most; after that the wrist/knuckle heights, because a
// horizontal stereo pair puts the same point on nearly the same image row.
export function pairHands(a = [], b = []) {
  const pairs = [];
  const used = new Set();
  for (let i = 0; i < a.length; i++) {
    let best = -1, bestCost = Infinity;
    for (let j = 0; j < b.length; j++) {
      if (used.has(j)) continue;
      const hand = (a[i].handedness || '').toLowerCase()[0] === (b[j].handedness || '').toLowerCase()[0] ? 0 : 0.25;
      const rows = Math.abs(a[i].lm[0][1] - b[j].lm[0][1]) + Math.abs(a[i].lm[9][1] - b[j].lm[9][1]);
      const cost = hand + rows;
      if (cost < bestCost) { bestCost = cost; best = j; }
    }
    if (best >= 0 && bestCost < 0.6) { used.add(best); pairs.push([i, best, bestCost]); }
  }
  return pairs;
}

// One view only: depth from how big the palm looks. Average adult wrist->middle knuckle is ~8.5 cm and
// index->pinky knuckle ~7 cm; the larger apparent scale wins because it is the less foreshortened one.
// (This is the assumption webcam.js already ships; it is the floor we fall back to, not the target.)
export function monoHandWorld(lm, view) {
  const px = i => [lm[i][0] * view.eyeW, lm[i][1] * view.eyeH];
  const dist = (i, j) => Math.hypot(px(i)[0] - px(j)[0], px(i)[1] - px(j)[1]);
  const f = (view.intr.fx + view.intr.fy) / 2;
  const scale = Math.max(dist(0, 9) / 8.5, dist(5, 17) / 7.0);      // px per cm at the palm
  if (!(scale > 0)) return null;
  const depth = Math.max(3, f / scale);
  // every joint sits at the palm's depth, stepped forward or back by its own relative z (same units as x)
  return lm.map(p => view.point(p[0], p[1], Math.max(3, depth + (p[2] || 0) * view.eyeW / scale)));
}

// One head camera only: the eyes' pixel separation against an assumed (or calibrated) interpupillary
// distance gives the distance, which is the depth cue today's app uses.
export function eyeFromMono(eyes, view, ipdCm, which = 'center') {
  const a = [eyes[0][0] * view.eyeW, eyes[0][1] * view.eyeH];
  const b = [eyes[1][0] * view.eyeW, eyes[1][1] * view.eyeH];
  const sep = Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (sep < 1) return null;
  const f = (view.intr.fx + view.intr.fy) / 2;
  const depth = ipdCm * f / sep;
  const p = pickEye(eyes, which);
  return view.point(p[0], p[1], depth);
}

// In a raw (unmirrored) camera image the viewer's RIGHT eye is the one further left, as webcam.js assumes.
export function pickEye(eyes, which = 'center') {
  const [a, b] = eyes;
  if (which === 'right') return a[0] < b[0] ? [a[0], a[1]] : [b[0], b[1]];
  if (which === 'left') return a[0] < b[0] ? [b[0], b[1]] : [a[0], a[1]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// Keep a hand in the slot it was in, so filters, pinch state and whatever it is holding follow the hand.
export function assignSlots(tips, prev, now, { sameHandCm = 15, recentMs = 500 } = {}) {
  const recent = prev.map(h => now - h.seenAt < recentMs);
  if (tips.length === 1) {
    let best = -1, bestD = sameHandCm;
    prev.forEach((h, s) => {
      if (!recent[s]) return;
      const d = Math.hypot(h.tip[0] - tips[0][0], h.tip[1] - tips[0][1], h.tip[2] - tips[0][2]);
      if (d < bestD) { bestD = d; best = s; }
    });
    return [best >= 0 ? best : (recent[1] && !recent[0] ? 1 : 0)];
  }
  const d = (h, t) => Math.hypot(h.tip[0] - t[0], h.tip[1] - t[1], h.tip[2] - t[2]);
  if (recent[0] && recent[1]) {
    const keep = d(prev[0], tips[0]) + d(prev[1], tips[1]);
    const swap = d(prev[0], tips[1]) + d(prev[1], tips[0]);
    return keep <= swap ? [0, 1] : [1, 0];
  }
  if (recent[0] || recent[1]) {
    const s = recent[0] ? 0 : 1;
    return d(prev[s], tips[0]) <= d(prev[s], tips[1]) ? [s, 1 - s] : [1 - s, s];
  }
  return tips[0][0] <= tips[1][0] ? [0, 1] : [1, 0];
}

// Pinch in centimetres, with the hysteresis Ultraleap ships (grab at 25 mm, let go at 30-40 mm), which
// sits well above the few millimetres of triangulation noise at this range.
export const PINCH_CLOSE_CM = 2.5, PINCH_OPEN_CM = 3.5;
export function pinchState(lmWorld, wasPinching) {
  const d = Math.hypot(lmWorld[4][0] - lmWorld[8][0], lmWorld[4][1] - lmWorld[8][1], lmWorld[4][2] - lmWorld[8][2]);
  const palm = Math.hypot(lmWorld[0][0] - lmWorld[9][0], lmWorld[0][1] - lmWorld[9][1], lmWorld[0][2] - lmWorld[9][2]) || 8.5;
  return { cm: d, ratio: d / palm, pinch: wasPinching ? d < PINCH_OPEN_CM : d < PINCH_CLOSE_CM };
}

// ---------------------------------------------------------------- runtime state

export const cams = {
  mode: 'none',                 // 'none' | 'mouse' | 'legacy' | 'multi'
  sources: [],                  // one per camera (a ZED is one source with two views)
  bridge: null,                 // ZedClient
  bridgeHands: null,            // last hands from the bridge
  legacy: null,                 // webcam.js when it is driving
  plan: null,
  handSource: 'none',           // 'bridge' | 'stereo' | 'mono' | 'legacy' | 'none'
  eyeSource: 'none',            // 'stereo' | 'mono' | 'legacy' | 'none'
  notes: [],
  solver: 'local midpoint',
  fusion: 'tracker',            // 'tracker' (track/solve.js) | 'local' (the midpoint fallback below)
  running: false,
};

// The real solver. Built on start(); everything the cameras see goes through it, and it is the only thing
// that writes the hands and the eye into input/state.js. The `local` helpers below stay reachable through
// opts.fusion = 'local' as the honest fallback for a page that cannot load track/ at all.
let solver = null;
export const getSolver = () => solver;

const eyeFilt = makeFilter3(0.6, 0.2);                     // steadier than the fingertip: the head moves slowly
const tipFilt = [makeFilter3(1.2, 0.4), makeFilter3(1.2, 0.4)];
const gripFilt = [makeFilter3(1.2, 0.4), makeFilter3(1.2, 0.4)];
const slotState = [{ tip: [0, 0, 25], seenAt: -1e9 }, { tip: [0, 0, 25], seenAt: -1e9 }];

let geom = null;   // webcamPos()/focalPx() from view.js, loaded lazily so this file also runs under node
async function geometry() {
  if (geom) return geom;
  try {
    const v = await import('../view.js');
    geom = { camPos: () => { const p = v.webcamPos(); return [p.x, p.y, p.z]; }, focalPx: v.focalPx };
  } catch {
    geom = { camPos: () => [0, 12, 0], focalPx: w => (w / 2) / Math.tan(60 * Math.PI / 360) };
  }
  return geom;
}

const note = m => { cams.notes.push(m); if (cams.notes.length > 12) cams.notes.shift(); console.log('[cameras]', m); };

// ---------------------------------------------------------------- opening cameras

const ZED_TRIES = [
  { width: { exact: 2560 }, height: { exact: 720 }, frameRate: { ideal: 60 } },
  { width: { exact: 3840 }, height: { exact: 1080 }, frameRate: { ideal: 30 } },
  { width: { exact: 1344 }, height: { exact: 376 }, frameRate: { ideal: 100 } },
  { width: { ideal: 2560 }, height: { ideal: 720 } },
];
const CAM_TRIES = [
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  {},
];

async function openStream(deviceId, tries) {
  let lastErr = null;
  for (const t of tries) {
    try {
      const video = { ...t, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no camera');
}

// The factory calibration for a ZED, if the user has dropped it in. calib.stereolabs.com/?SN=<serial>
// gives the file for free; without it we fall back to the published field of view, which is enough to
// grab something but not enough to trust the millimetres.
async function loadZedConf() {
  const saved = (() => { try { return localStorage.getItem('holo-zed-conf'); } catch { return null; } })();
  if (saved) return stereo.parseZedConf(saved);
  for (const url of ['/vendor/zed/SN.conf', '/zed.conf']) {
    try { const r = await fetch(url); if (r.ok) return stereo.parseZedConf(await r.text()); } catch {}
  }
  return null;
}

function makeWorker(id, tasks, opts, onMessage) {
  // A CLASSIC worker on purpose: MediaPipe 0.10.35 fails with "ModuleFactory not set." inside a module
  // worker (measured in Edge 2026-09), but loads fine in a classic one via dynamic import(). That is why
  // landmarks-worker.js has no static imports.
  const w = new Worker(new URL('./landmarks-worker.js', import.meta.url));
  w.onmessage = e => onMessage(e.data);
  w.onerror = e => onMessage({ t: 'error', id, message: e.message || 'worker failed' });
  w.postMessage({ t: 'init', id, tasks, detector: opts.detector || 'auto', allowBlob: !!opts.allowBlob });
  return w;
}

async function openSource(dev, opts) {
  const cls = dev.cls || devices.classifyCamera(dev);
  const stream = await openStream(dev.deviceId, cls.kind === 'zed' ? ZED_TRIES : CAM_TRIES);
  const track = stream.getVideoTracks()[0];
  const set = track.getSettings();
  const width = set.width || 640, height = set.height || 480;
  const video = document.createElement('video');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();

  // a ZED only earns the stereo path if the frame really is side-by-side; Chrome may hand back a crop
  const sbs = cls.kind === 'zed' && devices.isSbsSize(width, height);
  if (cls.kind === 'zed' && !sbs) note(`${dev.label || 'ZED'} opened at ${width}x${height}, which is not side-by-side: treating it as one camera, with the ZED's own lens`);
  const layout = sbs ? stereo.splitLayout(width, height) : stereo.wholeLayout(width, height);
  const g = await geometry();
  const ext = opts.ext?.[dev.prefKey] || dev.pref?.ext || { posCm: g.camPos(), rotDeg: [0, 0, 180] };
  const calib = sbs ? stereo.calibFor(await loadZedConf(), width, height, cls.model) : null;
  const intr = sbs ? null : (() => {
    // Which lens this camera actually has, in order of how much the answer is worth knowing:
    //   1. the user's own datasheet number for this camera (a diagonal fov, the way they are quoted);
    //   2. a ZED that came back cropped instead of side-by-side — still a ZED lens, and S.hfovDeg's 60 deg
    //      default is 2.5x too long for it, which put a hand really at 400 mm at 989 mm;
    //   3. a plain webcam, whose datasheet number is a DIAGONAL too (a C920's 78 deg diagonal is 70 deg
    //      horizontal, not 60), so reading S.hfovDeg as horizontal scaled every depth by ~20%.
    // S.hfovDeg stays the last word only where the user has calibrated it (main.js's calibrate button).
    const zedCrop = cls.kind === 'zed';
    const calibrated = !zedCrop && S.hfovCalibrated;
    const f = dev.pref?.dfovDeg ? devices.focalPxFromDiagFov(width, height, dev.pref.dfovDeg)
      : zedCrop ? stereo.ZED_REF.fx * (width / stereo.ZED_REF.eyeW)
      : calibrated ? g.focalPx(width)
      : devices.focalPxFromDiagFov(width, height, devices.WEBCAM_DFOV_DEG);
    return { fx: f, fy: f, cx: width / 2, cy: height / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0,
             source: dev.pref?.dfovDeg ? 'your datasheet fov' : zedCrop ? 'typical ZED (cropped frame)'
               : calibrated ? 'calibrated' : 'typical webcam fov',
             metric: !!(calibrated || dev.pref?.dfovDeg) };
  })();
  const views = stereo.viewsForCamera({ width, height, sbs, calib, intr, ext, label: dev.label || 'camera' });

  const src = {
    deviceId: dev.deviceId, prefKey: dev.prefKey, label: dev.label || 'camera', cls, role: dev.role,
    width, height, fps: set.frameRate || 0, sbs, layout, calib, views, stream, track, video,
    tasks: { face: dev.role === 'head' || dev.role === 'both', hands: dev.role === 'hands' || dev.role === 'both' },
    gate: views.map(() => new FrameGate({ maxAgeMs: opts.maxAgeMs ?? 120 })),
    samples: views.map(() => []), workers: [], ready: views.map(() => false), detector: '?', delegate: null,
    seq: 0, error: '', live: true, lastFaceAt: -1e9, lastHandAt: -1e9, stopped: false,
  };
  src.workers = views.map((v, i) => makeWorker(`${src.prefKey}#${i}`, src.tasks, opts, m => onWorkerMessage(src, i, m)));
  track.addEventListener('ended', () => dropSource(src.deviceId, 'the camera was unplugged'));
  solver?.addSource(src);
  startGrabLoop(src);
  cams.sources.push(src);
  note(`${src.label}: ${width}x${height}${sbs ? ' side-by-side (2 views)' : ''}, role ${src.role}`);
  if (sbs && !src.calib?.metric) note(`${src.label}: no SN.conf, so the lens is a typical-ZED guess — ` +
    `the depth is good enough to reach for something, not to trust in millimetres. Drop in ` +
    `calib.stereolabs.com/?SN=<serial> to fix that.`);
  return src;
}

// Pull frames with requestVideoFrameCallback when it exists (it gives the frame's own timestamp); fall
// back to a rAF poll on currentTime, which is what Firefox needs.
function startGrabLoop(src) {
  const crops = [src.layout.left, src.layout.right];
  const send = (i, at, seq, bitmap) => src.workers[i].postMessage({ t: 'frame', seq, at, bitmap }, [bitmap]);
  const fail = (err, is) => { for (const i of is) src.gate[i].abort(); src.error = String(err?.message || err); };

  const grab = (now, meta) => {
    if (src.stopped) return;
    const at = meta?.captureTime ?? now ?? performance.now();
    const tNow = performance.now();
    if (src.sbs) {
      // Both eyes must come from ONE video frame, or the disparity picks up however far the hand moved
      // between them — which reads as depth error. So take one snapshot and cut both halves out of it,
      // and skip the frame entirely unless both workers are free.
      if (src.ready.some(r => !r) || src.gate.some(g => g.inFlight >= g.maxInFlight)) {
        if (src.ready.every(r => r)) src.gate.forEach(g => g.busyDrops++);
        return schedule();
      }
      if (!src.gate[0].offer(at, tNow)) return schedule();
      if (!src.gate[1].offer(at, tNow)) { src.gate[0].abort(); return schedule(); }
      const seq = ++src.seq;
      createImageBitmap(src.video)
        .then(full => Promise.all(crops.map(c => createImageBitmap(full, c.sx, c.sy, c.sw, c.sh)))
          .then(halves => { full.close(); halves.forEach((b, i) => send(i, at, seq, b)); })
          .catch(err => { full.close(); throw err; }))
        .catch(err => fail(err, [0, 1]));
      return schedule();
    }
    if (src.ready[0] && src.gate[0].offer(at, tNow)) {
      const seq = ++src.seq;
      createImageBitmap(src.video)
        .then(bitmap => send(0, at, seq, bitmap))
        .catch(err => fail(err, [0]));
    }
    schedule();
  };
  const schedule = () => {
    if (src.stopped) return;
    if (src.video.requestVideoFrameCallback) src.video.requestVideoFrameCallback(grab);
    else requestAnimationFrame(now => { if (src.video.currentTime !== src._lastT) { src._lastT = src.video.currentTime; grab(now, null); } else schedule(); });
  };
  schedule();
}

function onWorkerMessage(src, i, m) {
  if (m.t === 'ready') {
    src.ready[i] = true; src.detector = m.detector; src.delegate = m.delegate;
    note(`${src.label} view ${i}: ${m.detector}${m.delegate ? ' (' + m.delegate + ')' : ''}`); return;
  }
  if (m.t === 'note') { note(`${src.label}: ${m.message}`); return; }
  // 'error' was the ONE branch that did not free the slot: a worker error arriving between offer and
  // result left inFlight at 1 for ever and the view never sent another frame.
  if (m.t === 'error') { src.gate[i].abort(); src.error = m.message; note(`${src.label} view ${i}: ${m.message}`); return; }
  if (m.t === 'drop') { src.gate[i].abort(); return; }   // the worker could not take that frame; free the slot
  if (m.t !== 'result') return;
  const now = performance.now();
  src.gate[i].finish(m.at, now);
  if (m.error) src.error = m.error;
  const ring = src.samples[i];
  ring.push({ at: m.at, seq: m.seq, face: m.face, hands: m.hands || [], synthetic: m.detector === 'blob' });
  while (ring.length > 6) ring.shift();
  if (m.face) src.lastFaceAt = now;
  if (m.hands?.length) src.lastHandAt = now;
  // Hand it straight to the solver with the CAPTURE time. Solving happens once per rendered frame in
  // startLoop(), not here: a ZED's two eyes arrive as two messages and solving on each of them would
  // triangulate a one-eyed frame and then immediately redo it.
  if (solver) {
    solver.setRate(camIdFor(src, i), src.gate[i].fpsAt(now));
    solver.observeView(src, i, { at: m.at, face: m.face, hands: m.hands || [] });
  } else fuse(now);
}

// ---------------------------------------------------------------- fusion

const newest = ring => (ring.length ? ring[ring.length - 1] : null);

// One view's landmarks for one hand at time t, interpolated between the samples either side of it.
function handAt(src, i, handedness, t, maxSkewMs = 25) {
  const series = src.samples[i]
    .filter(s => s.hands?.length)
    .map(s => ({ at: s.at, lm: (s.hands.find(h => h.handedness === handedness) || s.hands[0]).lm }));
  return interpolateLm(series, t, maxSkewMs)?.lm || null;
}

// Views that have seen a hand recently. A view whose worker has died or whose camera stopped ages out,
// which is what makes the ladder (two views -> one view -> nothing) happen on its own.
function handViewsWithSamples(now, maxAgeMs = 300) {
  const out = [];
  for (const src of cams.sources) {
    if (!src.live || !src.tasks.hands) continue;
    src.views.forEach((v, i) => {
      const s = newest(src.samples[i]);
      if (s?.hands?.length && now - s.at < maxAgeMs) out.push({ src, view: v, i, sample: s });
    });
  }
  return out;
}

function fuseHands(now) {
  // the bridge wins while it is fresh: it is the sensor that can actually see under the sheet
  if (cams.bridgeHands && Math.abs(now - cams.bridgeHands.at) < 200) {
    const hands = cams.bridgeHands.hands.map(h => h.world);
    if (hands.length) { publishHands(hands, now, 'bridge'); return; }
  }
  const vs = handViewsWithSamples(now);
  if (!vs.length) return;
  if (vs.length >= 2) {
    // Pair the detections across the two views, then triangulate each landmark in world space. Both views
    // must speak for the SAME instant: the two eyes of a ZED share one exposure, two webcams do not, so
    // each view's landmarks are moved to the older view's time first. Triangulating landmarks from
    // different moments reads as depth error (a hand crossing the view at 0.5 m/s moves 8 mm in half a
    // frame), so when the two cannot be aligned we wait for the next result rather than guess.
    const [A, B] = vs;
    const t = Math.min(A.sample.at, B.sample.at);
    const aAligned = A.sample.hands.map(h => ({ ...h, lm: handAt(A.src, A.i, h.handedness, t) }));
    const bAligned = B.sample.hands.map(h => ({ ...h, lm: handAt(B.src, B.i, h.handedness, t) }));
    if (aAligned.some(h => !h.lm) || bAligned.some(h => !h.lm)) return;
    const pairs = pairHands(aAligned, bAligned);
    const hands = [];
    for (const [ia, ib] of pairs) {
      const la = aAligned[ia].lm, lb = bAligned[ib].lm;
      const world = [];
      let ok = true;
      for (let k = 0; k < 21; k++) {
        const rays = [A.view.ray(la[k][0], la[k][1]), B.view.ray(lb[k][0], lb[k][1])];
        const p = stereo.triangulate(rays);
        if (!p || !p.every(Number.isFinite)) { ok = false; break; }
        world.push(p);
      }
      if (ok) hands.push(world);
    }
    if (hands.length) { publishHands(hands.slice(0, 2), now, 'stereo'); return; }
  }
  const one = vs[0];
  const hands = one.sample.hands.slice(0, 2).map(h => monoHandWorld(h.lm, one.view)).filter(Boolean);
  if (hands.length) publishHands(hands, now, 'mono');
}

function publishHands(handsWorld, now, source) {
  cams.handSource = source;
  const tips = handsWorld.map(w => w[8]);
  const slots = assignSlots(tips, slotState, now);
  const tSec = now / 1000;
  handsWorld.forEach((w, k) => {
    const s = slots[k], h = input.hands[s];
    const grip = [(w[4][0] + w[8][0]) / 2, (w[4][1] + w[8][1]) / 2, (w[4][2] + w[8][2]) / 2];
    h.tip.set(tipFilt[s][0].filter(w[8][0], tSec), tipFilt[s][1].filter(w[8][1], tSec), tipFilt[s][2].filter(w[8][2], tSec));
    h.grip.set(gripFilt[s][0].filter(grip[0], tSec), gripFilt[s][1].filter(grip[1], tSec), gripFilt[s][2].filter(grip[2], tSec));
    h.gripRaw.set(grip[0], grip[1], grip[2]);
    const joints = new Float32Array(63);
    for (let i = 0; i < 21; i++) { joints[i * 3] = w[i][0]; joints[i * 3 + 1] = w[i][1]; joints[i * 3 + 2] = w[i][2]; }
    h.jointsWorld = joints;
    const p = pinchState(w, h.pinch);
    h.pinch = p.pinch; h.pinchRatio = p.ratio; h.pinchCm = p.cm;
    h.seenAt = now; h.active = true;
    slotState[s] = { tip: w[8], seenAt: now };
  });
}

function fuseEye(now) {
  const heads = [];
  for (const src of cams.sources) {
    if (!src.live || !src.tasks.face) continue;
    src.views.forEach((v, i) => {
      const s = newest(src.samples[i]);
      if (s?.face?.eyes && now - s.at < 300) heads.push({ src, view: v, i, sample: s });
    });
  }
  if (!heads.length) return;
  const tSec = now / 1000;
  let p = null, source = 'mono';
  if (heads.length >= 2) {
    const t = Math.min(heads[0].sample.at, heads[1].sample.at);   // the instant both cameras can speak for
    const eyesAt = h => interpolateLm(h.src.samples[h.i].filter(s => s.face?.eyes).map(s => ({ at: s.at, lm: s.face.eyes })), t, 25);
    const a = eyesAt(heads[0]), b = eyesAt(heads[1]);
    if (a && b) {
      const pa = pickEye(a.lm, S.eye), pb = pickEye(b.lm, S.eye);
      const q = stereo.triangulate([heads[0].view.ray(pa[0], pa[1]), heads[1].view.ray(pb[0], pb[1])]);
      if (q && q.every(Number.isFinite)) { p = q; source = 'stereo'; }
    }
  }
  if (!p) p = eyeFromMono(heads[0].sample.face.eyes, heads[0].view, S.ipdMm / 10, S.eye);
  if (!p) return;
  cams.eyeSource = source;
  input.eye.set(eyeFilt[0].filter(p[0], tSec), eyeFilt[1].filter(p[1] + S.eyeYNudgeCm, tSec), eyeFilt[2].filter(p[2], tSec));
  input.faceSeenAt = now;
}

function fuse(now) {
  fuseEye(now);
  if (S.hands !== false) fuseHands(now);
}

// ---------------------------------------------------------------- lifecycle

export async function startCameras(opts = {}) {
  const status = opts.status || (() => {});
  if (cams.running) stopCameras();   // restart cleanly rather than opening a second copy of everything
  cams.opts = opts;
  cams.running = true;
  cams.fusion = opts.fusion === 'local' ? 'local' : 'tracker';
  solver = null;
  if (cams.fusion === 'tracker') {
    try {
      solver = createSolver({ eye: S.eye, ipdMm: S.ipdMm });
      cams.solver = 'track/solve.js Tracker';
    } catch (e) {
      note(`the tracking solver would not load (${e?.message || e}); using the local midpoint fusion`);
      cams.fusion = 'local';
    }
  }
  if (!solver) cams.solver = (await stereo.loadSolver()).name;
  status('Looking for cameras…');

  let list = await devices.listCameras();
  if (list.length && list.every(d => !d.label)) {
    // labels are hidden until one camera has been granted, and we identify a ZED by its label
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); } catch {}
    list = await devices.listCameras();
  }
  const prefs = opts.prefs || devices.loadPrefs();
  const merged = devices.mergePrefs(prefs, list).map(d => ({ ...d, cls: devices.classifyCamera(d, null, d.pref) }));
  const bridgeUrl = opts.bridgeUrl || '';
  const plan = cams.plan = devices.planRoles(merged, { bridge: !!bridgeUrl });
  cams.mode = plan.mode;

  if (bridgeUrl) connectBridge(bridgeUrl, opts.ext?.zed);

  let legacyFailed = false;
  if (plan.mode === 'mouse') {
    input.mode = bridgeUrl ? 'camera' : 'mouse';
    note(bridgeUrl ? 'no cameras: hands from the bridge, head fixed' : 'no cameras: mouse mode');
  } else if (plan.legacy) {
    // exactly one plain webcam: hand over to the tracker the app already ships, unchanged. It needs the
    // app's own page (it reads the display geometry from view.js), so a page without that falls through
    // to the multi-camera path rather than failing.
    try {
      cams.legacy = await import('./webcam.js');
      await cams.legacy.startCamera(status);
      cams.handSource = cams.eyeSource = 'legacy';
      note('one webcam: using webcam.js (today\'s behaviour)');
    } catch (e) {
      cams.legacy = null; legacyFailed = true;
      note(`webcam.js could not start (${e?.message || e}); running this camera through the multi-camera path`);
    }
  }
  if ((plan.mode !== 'mouse' && !plan.legacy) || legacyFailed) {
    status('Opening cameras…');
    for (const d of plan.sources) {
      try { await openSource(d, opts); }
      catch (e) { note(`${d.label || d.deviceId}: ${e?.message || e}`); }
    }
    if (!cams.sources.length) { input.mode = bridgeUrl ? 'camera' : 'mouse'; cams.mode = 'mouse'; }
    else { input.mode = 'camera'; cams.mode = 'multi'; }
  }
  if (typeof navigator !== 'undefined' && navigator.mediaDevices) navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange);
  startLoop();
  status('');
  return camerasStatus();
}

// Point at (or move to) a bridge without restarting the cameras.
export function setBridge(url, ext) {
  cams.bridge?.close();
  cams.bridge = null; cams.bridgeHands = null;
  if (url) connectBridge(url, ext);
}

function connectBridge(url, ext) {
  cams.bridge = new ZedClient({
    url, ext,
    onHands: p => {
      cams.bridgeHands = p;
      if (solver) solver.observeBridge(p);        // solved with everything else, in startLoop
      else fuseHands(performance.now());
    },
    onStatus: s => { if (s.state === 'retrying') note(`bridge ${s.state}: ${s.error}`); },
  });
  cams.bridge.connect(url);
  note(`bridge: ${url}`);
}

// Losing a camera must never take the app down: drop it, keep the others, and fall back a rung.
export function dropSource(deviceId, why = 'stopped') {
  const src = cams.sources.find(s => s.deviceId === deviceId);
  if (!src) return false;
  src.stopped = true; src.live = false; src.error = why;
  solver?.removeSource(src);     // the Tracker must stop believing a camera that is gone, not just age it out
  try { src.workers.forEach(w => w.postMessage({ t: 'stop' })); } catch {}
  try { src.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { src.video.remove(); } catch {}
  cams.sources = cams.sources.filter(s => s !== src);
  note(`${src.label}: ${why}`);
  if (!cams.sources.length && !(cams.bridge && cams.bridge.stats.state === 'live')) {
    cams.mode = 'mouse'; input.mode = 'mouse'; cams.handSource = cams.eyeSource = 'none';
    note('no cameras left: mouse mode');
  }
  return true;
}

let deviceChangeTimer = null;
function onDeviceChange() {
  clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(async () => {
    if (!cams.running) return;
    const list = await devices.listCameras();
    const ids = new Set(list.map(d => d.deviceId));
    for (const src of [...cams.sources]) if (!ids.has(src.deviceId)) dropSource(src.deviceId, 'unplugged');
    const known = new Set(cams.sources.map(s => s.deviceId));
    const fresh = list.filter(d => !known.has(d.deviceId));
    if (fresh.length && cams.mode !== 'legacy') {
      const prefs = devices.loadPrefs();
      const plan = devices.planRoles(devices.mergePrefs(prefs, list).map(d => ({ ...d, cls: devices.classifyCamera(d, null, d.pref) })), { bridge: !!cams.bridge });
      for (const d of plan.sources) if (!known.has(d.deviceId)) { try { await openSource(d, cams.opts || {}); } catch (e) { note(String(e?.message || e)); } }
      if (cams.sources.length) { cams.mode = 'multi'; input.mode = 'camera'; }
    }
  }, 400);
}

/**
 * Free any slot a worker has been sitting on for too long, and give up on a worker that keeps doing it.
 * Exported so a test can step it without animation frames.
 */
export function watchdog(now = (typeof performance !== 'undefined' ? performance.now() : Date.now()),
                         { strikesToDrop = 3 } = {}) {
  let freed = 0;
  for (const src of [...cams.sources]) {
    let stalled = false;
    src.gate.forEach((g, i) => {
      if (!g.watchdog(now)) return;
      freed++;
      if (g.strikes >= strikesToDrop) stalled = true;
      else note(`${src.label} view ${i}: the worker stopped answering; the frame was dropped`);
    });
    // Keep dropping frames into a dead thread and the ladder never degrades. Give the camera up instead,
    // so the solver falls back to the other camera, the bridge, or the single-view guess.
    if (stalled) dropSource(src.deviceId, 'the landmark worker stopped answering');
  }
  return freed;
}

let rafId = 0;
let legacyFails = 0;
function startLoop() {
  if (rafId || typeof requestAnimationFrame === 'undefined') return;
  const step = now => {
    rafId = requestAnimationFrame(step);
    if (cams.legacy) {
      // note() is the only thing that caps cams.notes at 12, and camerasStatus() copies the whole array
      // on every poll. Pushing straight to it meant a dead MediaPipe graph — which throws on EVERY call
      // once its context is gone — grew the array by one string per video frame for ever.
      try { cams.legacy.track(now); legacyFails = 0; }
      catch (e) {
        if (++legacyFails === 1) note(`webcam.js: ${e?.message || e}`);
        // Retrying a dead graph at camera frame rate buys nothing; stop and say why, once.
        if (legacyFails >= 30) {
          try { cams.legacy.stopCamera?.(); } catch {}
          cams.legacy = null; cams.handSource = cams.eyeSource = 'none';
          note('webcam.js kept throwing, so it was stopped: reload the page to try the camera again');
        }
      }
      return;
    }
    watchdog(now);
    if (solver) {
      // One solve per rendered frame. Every camera's newest landmarks are lined up to a common instant
      // inside the Tracker, so this is where the 3D actually happens.
      solver.step(input, now, { hands: S.hands !== false, eyeYNudgeCm: S.eyeYNudgeCm || 0 });
      const q = solver.quality;
      cams.handSource = q.handsSeen ? q.handSource : 'none';
      cams.eyeSource = q.eyeViews ? q.eyeSource : 'none';
      return;
    }
    for (const h of input.hands) h.active = S.hands !== false && now - h.seenAt < 300;
    // two-sided: a payload stamped in the future (an unsynced bridge clock) must expire too
    if (cams.bridge && cams.bridgeHands && Math.abs(now - cams.bridgeHands.at) > 400 && cams.handSource === 'bridge') cams.handSource = 'none';
  };
  rafId = requestAnimationFrame(step);
}

// For tests and for pages with no animation frames: do one solve now, exactly as the loop would.
export function stepSolver(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
  if (!solver) return null;
  const out = solver.step(input, now, { hands: S.hands !== false, eyeYNudgeCm: S.eyeYNudgeCm || 0 });
  const q = solver.quality;
  cams.handSource = q.handsSeen ? q.handSource : 'none';
  cams.eyeSource = q.eyeViews ? q.eyeSource : 'none';
  return out;
}

export function stopCameras() {
  cams.running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  clearTimeout(deviceChangeTimer);
  navigator?.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  for (const src of [...cams.sources]) dropSource(src.deviceId, 'stopped');
  cams.bridge?.close();
  // webcam.js owns a camera stream, a hidden <video> and TWO MediaPipe landmarkers, and nulling the
  // module reference gave none of them back. Every Stop/Start (which startCameras does to itself)
  // leaked the lot, so after a few restarts the camera was busy for every other app.
  try { cams.legacy?.stopCamera?.(); } catch (e) { note(`webcam.js would not stop cleanly: ${e?.message || e}`); }
  cams.bridge = null; cams.bridgeHands = null; cams.legacy = null;
  legacyFails = 0;
  solver = null;
  cams.mode = 'none'; cams.handSource = 'none'; cams.eyeSource = 'none';
  cams.notes.length = 0;
}

// What the setup page (and the HUD) show: per camera fps, latency, drops, and who is seeing what.
export function camerasStatus() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    mode: cams.mode, handSource: cams.handSource, eyeSource: cams.eyeSource, solver: cams.solver,
    fusion: cams.fusion, inputMode: input.mode, notes: [...cams.notes],
    // what the solver itself thinks it is doing, which is the first thing to read when a number looks wrong
    tracking: solver ? { readout: solver.readout, ...solver.quality } : null,
    sources: cams.sources.map(s => ({
      label: s.label, deviceId: s.deviceId, kind: s.cls.kind, model: s.cls.model, why: s.cls.why,
      role: s.role, width: s.width, height: s.height, sbs: s.sbs, mode: s.layout.mode,
      detector: s.detector, delegate: s.delegate, error: s.error,
      // Where this camera's lens numbers came from, and whether its millimetres are a measurement. A hand
      // published at 2.5x the right distance looks like broken tracking unless the guess is on screen.
      calib: s.calib?.source || s.views[0]?.intr?.source || null,
      calibMetric: s.calib ? !!s.calib.metric : !!s.views[0]?.intr?.metric,
      views: s.views.map((v, i) => ({
        label: v.label, fps: s.gate[i].fpsAt(now), latencyMs: Math.round(s.gate[i].latencyMs),
        busyDrops: s.gate[i].busyDrops, staleDrops: s.gate[i].staleDrops, stallDrops: s.gate[i].stallDrops,
        sent: s.gate[i].sent, done: s.gate[i].done,
      })),
      seesHead: now - s.lastFaceAt < 500, seesHands: now - s.lastHandAt < 500,
    })),
    bridge: cams.bridge ? { ...cams.bridge.stats } : null,
    eye: [input.eye.x, input.eye.y, input.eye.z],
    hands: input.hands.map(h => ({ active: h.active, pinch: h.pinch, pinchCm: h.pinchCm ?? null, tip: [h.tip.x, h.tip.y, h.tip.z] })),
  };
}

// Remember something about a camera. Keyed by label, because deviceIds change when permissions are reset.
function savePref(deviceId, patch) {
  const prefs = devices.loadPrefs();
  const src = cams.sources.find(s => s.deviceId === deviceId);
  const key = src?.prefKey || src?.label || deviceId;
  prefs[key] = { ...(prefs[key] || {}), key: { deviceId, label: src?.label || '', groupId: '' }, ...patch };
  devices.savePrefs(prefs);
  return prefs;
}

// Handy for the setup page and for tests: swap a camera's job without restarting everything.
export function setRole(deviceId, role) {
  const prefs = savePref(deviceId, { role });
  const src = cams.sources.find(s => s.deviceId === deviceId);
  if (src) { src.role = role; src.tasks = { face: role === 'head' || role === 'both', hands: role === 'hands' || role === 'both' }; }
  return prefs;
}

// "This one really is a ZED" (or really is not). It changes which resolutions we ask for, so it only
// takes effect when the camera is next opened.
export function setKind(deviceId, kind) {
  return savePref(deviceId, { kind: kind === 'auto' ? undefined : kind });
}
