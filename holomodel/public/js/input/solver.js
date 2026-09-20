// The join between the capture layer and the real tracking solver.
//
// input/cameras.js knows how to OPEN cameras, cut a ZED's side-by-side frame in half and get landmarks out
// of a worker. track/solve.js knows how to turn landmarks from several cameras into one steady 3D hand.
// Before this file they each had their own idea of the geometry: cameras.js fused with its own midpoint
// solve in centimetres, and the Tracker sat unused. Everything below exists to make the capture layer feed
// the Tracker and nothing else.
//
// Units are the one thing to be careful about, so they are stated once and converted in one place:
//   capture layer / input/state.js : CENTIMETRES, app world frame (x right, y up, z toward the viewer)
//   track/ and this file's cameras : MILLIMETRES, same axes
// PinholeCamera positions are built at x10, and the Tracker publishes back through appScale = 0.1. Nothing
// else in the chain multiplies by anything.

import { PinholeCamera } from '../track/camera.js';
import { Tracker } from '../track/solve.js';
import { HAND } from '../track/landmarks.js';

export const MM_PER_CM = 10;
export const APP_SCALE = 1 / MM_PER_CM;        // rig mm -> the app's cm

// What we assume each sensor's landmark noise is, in pixels. It is a WEIGHT, not a promise: it decides how
// much each camera's say is worth, and the ZED's wide lens needs the angular correction the Tracker applies.
export const NOISE_PX = { zed: 1.0, webcam: 1.2, unknown: 1.5 };

/**
 * One capture view (from stereo.makeView) -> one posed PinholeCamera in millimetres.
 * The pose comes from stereo.cameraPose(), i.e. the same ext/offsetCam/extraRot the ray path uses, so the
 * two can never disagree about where a camera is.
 */
export function cameraForView(view, { id, role = 'both', fps = 30, noisePx = NOISE_PX.unknown, label } = {}) {
  const k = view.intr;
  const p = view.pose.positionCm;
  return new PinholeCamera({
    id, label: label || view.label || id, role,
    width: view.eyeW, height: view.eyeH,
    fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy,
    dist: { k1: k.k1 || 0, k2: k.k2 || 0, k3: k.k3 || 0, p1: k.p1 || 0, p2: k.p2 || 0 },
    position: [p[0] * MM_PER_CM, p[1] * MM_PER_CM, p[2] * MM_PER_CM],
    R: view.pose.R,
    fps, noisePx,
  });
}

/** Every view of one opened camera, as Tracker cameras. A ZED is one source with two of them. */
export function camerasForSource(src) {
  const role = src.role === 'hands' || src.role === 'head' ? src.role : 'both';
  const noisePx = src.cls?.kind === 'zed' ? NOISE_PX.zed : NOISE_PX.webcam;
  return src.views.map((v, i) => cameraForView(v, {
    id: camIdFor(src, i), role, label: v.label, noisePx,
    fps: src.fps || (src.cls?.kind === 'zed' ? 60 : 30),
  }));
}

export const camIdFor = (src, i) => `${src.prefKey || src.deviceId || src.label}#${i}`;

// ---------------------------------------------------------------- landmark shapes

// The worker speaks arrays ([x, y, z] normalised); the Tracker speaks objects ({x, y, z}). Neither is wrong;
// this is the only place that has to know both.
export const lmToPoints = lm => lm.map(p => ({ x: p[0], y: p[1], z: p[2] }));

export function handsForTracker(hands = []) {
  const out = [];
  for (const h of hands) {
    if (!h?.lm || h.lm.length !== HAND.COUNT) continue;
    out.push({ handedness: normHandedness(h.handedness), score: h.score ?? 1, landmarks: lmToPoints(h.lm) });
  }
  return out;
}

// MediaPipe says 'Left'/'Right', the bridge says 'left'/'right', a blob says '?'. assignSlots() compares
// these as strings, so they have to be one spelling.
export function normHandedness(h) {
  const s = String(h || '').toLowerCase();
  return s.startsWith('l') ? 'Left' : s.startsWith('r') ? 'Right' : 'Unknown';
}

// face.eyes from the worker is [[x,y,z] right iris, [x,y,z] left iris] as they appear in the RAW image,
// which is exactly the order Tracker.observe2D documents.
export const faceForTracker = face =>
  (face?.eyes && face.eyes.length >= 2 ? face.eyes.slice(0, 2).map(p => ({ x: p[0], y: p[1] })) : null);

// ---------------------------------------------------------------- the solver

/**
 * One Tracker, plus the bookkeeping the capture layer needs around it.
 *
 * @param opts.eye         'center' | 'left' | 'right'  (settings.S.eye)
 * @param opts.ipdMm       the user's interpupillary distance (settings.S.ipdMm)
 * @param opts.eyeYNudgeCm a manual vertical offset on the published eye only. It is pushed DOWN into the
 *                         Tracker and applied inside publish(), where the eye is actually written, rather
 *                         than through appTransform (which would also move the hands) or after publish
 *                         (which re-applied it on every frame that published no eye — see publish()).
 */
export function createSolver(opts = {}) {
  const tracker = new Tracker({
    cameras: [],
    appScale: APP_SCALE,
    appTransform: opts.appTransform || null,
    ipdMm: opts.ipdMm ?? 63,
    eye: opts.eye || 'center',
    maxAgeMs: opts.maxAgeMs ?? 300,
  });
  const cameras = new Map();                 // camId -> PinholeCamera
  let lastSolve = null;
  let bridgeAt = -1e9, bridgeSource = '';

  function sync() { tracker.setCameras([...cameras.values()]); }

  return {
    tracker,
    get cameras() { return [...cameras.values()]; },

    addSource(src) {
      for (const c of camerasForSource(src)) cameras.set(c.id, c);
      sync();
      return this;
    },
    removeSource(src) {
      src.views.forEach((_, i) => cameras.delete(camIdFor(src, i)));
      sync();
      return this;
    },
    addCamera(camera) { cameras.set(camera.id, camera); sync(); return this; },
    clear() { cameras.clear(); sync(); return this; },

    /**
     * How fast this view really DELIVERS landmarks, which is not the video's frame rate: MediaPipe on a
     * slow GPU turns a 60 fps camera into a 5 fps tracker. The Tracker decides when a camera has gone
     * quiet from its fps, so feeding it the video rate would declare a slow-but-working detector dead.
     */
    setRate(camId, fps) {
      const c = cameras.get(camId);
      if (c && fps > 0) c.fps = Math.max(2, Math.min(120, fps));
      return this;
    },

    /** One worker result for one view. `at` is the CAPTURE time, which is the whole reason this works. */
    observeView(src, i, result) {
      const camId = camIdFor(src, i);
      if (!cameras.has(camId)) return false;
      tracker.observe2D({
        camId, tMs: result.at,
        face: src.tasks?.face === false ? null : faceForTracker(result.face),
        hands: src.tasks?.hands === false ? [] : handsForTracker(result.hands),
        normalized: true,
      });
      return true;
    },

    /** The LAN bridge: ZedClient has already put these in app world CENTIMETRES, so scale to mm here. */
    observeBridge(payload) {
      if (!payload?.hands?.length) return false;
      bridgeAt = payload.at;
      bridgeSource = payload.source || 'bridge';
      tracker.observe3D({
        tMs: payload.at, source: bridgeSource,
        hands: payload.hands.map(h => ({
          handedness: normHandedness(h.handedness), score: h.score ?? 1,
          points: h.world.map(p => [p[0] * MM_PER_CM, p[1] * MM_PER_CM, p[2] * MM_PER_CM]),
        })),
      });
      return true;
    },

    /**
     * A bridge that has gone quiet must stop being believed, the same way a stalled camera does. Without
     * this the Tracker keeps preferring its last payload over the cameras that are still delivering.
     */
    expireBridge(now, maxAgeMs = 250) {
      // Two-sided: a payload stamped in the FUTURE (a bridge whose clock is not synced yet sends epoch
      // milliseconds) would otherwise never expire, and the Tracker would prefer that one frozen frame
      // over every live camera for the rest of the session.
      if (tracker.bridge && Math.abs(now - bridgeAt) > maxAgeMs) { tracker.bridge = null; return true; }
      return false;
    },

    /** Solve and write into the shared input object. Returns the Tracker's frame. */
    step(input, now, { hands = true, eyeYNudgeCm = 0 } = {}) {
      this.expireBridge(now);
      tracker.eyeNudgeApp = eyeYNudgeCm;   // publish() is the only thing that writes input.eye
      const out = tracker.solve(now);
      lastSolve = out;
      tracker.publish(input, now);
      if (!hands) for (const h of input.hands) { h.active = false; h.pinch = false; }
      return out;
    },

    get last() { return lastSolve; },
    get quality() { return tracker.quality; },
    get readout() { return tracker.readout; },
    get handSource() { return tracker.quality.handSource; },
    get eyeSource() { return tracker.quality.eyeSource; },
    setIpdMm(mm) { tracker.ipdMm = mm; return this; },
    setEyeSide(side) { tracker.eyeSide = side; return this; },
  };
}
