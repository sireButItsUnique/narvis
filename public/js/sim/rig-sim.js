// The rig simulator: the whole Pepper's-ghost setup as numbers, so the tracking maths can be exercised,
// measured and argued about before any hardware is plugged in.
//
// No three.js and no DOM in this file — it runs in node --test. public/js/sim/sim-view.js draws it.
//
// THE RIG, in one paragraph. A 16:9 monitor hangs ABOVE in PORTRAIT orientation, tilted, facing down. A
// FLAT sheet of acrylic lies under it and acts as the beam splitter. The floating image is the monitor's
// mirror image in that sheet, so it appears UNDERNEATH the sheet, which is where the hands go. Only a 4:3
// area of the portrait screen is used (the full short side by 75% of the long side — for a 16:9 panel those
// are the same rectangle), because the monitor over-extends the sheet; the rest is black. Plain acrylic
// reflects about 4-5%, so black really is transparent and the model has to be bright on pure black.
//
// RIG FRAME: millimetres, origin at the centre of the acrylic sheet, X right, Y up, Z toward the viewer.

import { add, sub, scale, dot, cross, normalize, dist, lerp3, matVec, rodrigues,
         mean, percentile, mulberry32, gaussian } from '../track/linalg.js';
import { makeCamera } from '../track/camera.js';
import { expectedErrorMm } from '../track/triangulate.js';
import { Tracker } from '../track/solve.js';
import { HAND, PALM } from '../track/landmarks.js';

// ---------- the rig ----------

export const DEFAULT_RIG = {
  panelDiagIn: 24,          // the monitor, measured on the diagonal
  panelAspect: 16 / 9,
  activeFraction: 0.75,     // of the portrait long side: the part of the screen the sheet actually covers
  tiltDeg: 30,              // monitor tilt away from horizontal, facing down and toward the viewer
  panelHeightMm: 260,       // height of the panel centre above the sheet
  panelZMm: -40,            // how far back the panel centre sits
  sheetWidthMm: 400,
  sheetDepthMm: 300,
  viewerZMm: 520,           // where the head usually is
  viewerYMm: 260,
};

/**
 * Everything derived from the rig dimensions: the panel rectangle, the 4:3 active area inside it, and the
 * VIRTUAL image rectangle, which is the active area mirrored in the sheet (the plane y = 0).
 *
 * Mirror once, here, at calibration time — not per frame. Reflecting the camera matrix every frame is where
 * these projects go wrong: winding order, culling and normals all flip and have to be undone again.
 */
export function rigGeometry(rig = DEFAULT_RIG) {
  const r = { ...DEFAULT_RIG, ...rig };
  const diagMm = r.panelDiagIn * 25.4;
  const longMm = diagMm * r.panelAspect / Math.hypot(r.panelAspect, 1);   // 16:9 long side
  const shortMm = longMm / r.panelAspect;
  // Portrait: the short side is the width, the long side is the height.
  const panel = { widthMm: shortMm, heightMm: longMm };
  const active = { widthMm: shortMm, heightMm: longMm * r.activeFraction };
  active.aspect = active.widthMm / active.heightMm;                       // 3:4 portrait, i.e. "4:3"

  const tilt = r.tiltDeg * Math.PI / 180;
  // The panel faces down and toward the viewer. Its own axes in rig coordinates:
  const right = [1, 0, 0];
  const up = [0, Math.cos(tilt), Math.sin(tilt)];                         // "up" across the panel surface
  const normalDown = cross(right, up);                                    // points down-ish, at the sheet
  const centre = [0, r.panelHeightMm, r.panelZMm];

  const cornersOf = (rect, c, u, v) => ({
    topLeft: add(c, add(scale(u, -rect.widthMm / 2), scale(v, rect.heightMm / 2))),
    topRight: add(c, add(scale(u, rect.widthMm / 2), scale(v, rect.heightMm / 2))),
    bottomLeft: add(c, add(scale(u, -rect.widthMm / 2), scale(v, -rect.heightMm / 2))),
    bottomRight: add(c, add(scale(u, rect.widthMm / 2), scale(v, -rect.heightMm / 2))),
  });
  const screen = { centre, right, up, normal: normalDown, ...cornersOf(active, centre, right, up),
                   widthMm: active.widthMm, heightMm: active.heightMm };
  const mirror = p => [p[0], -p[1], p[2]];                                // reflection in the sheet, y = 0
  const virtualScreen = {
    centre: mirror(centre), right, up: [up[0], -up[1], up[2]], normal: mirror(normalDown),
    topLeft: mirror(screen.bottomLeft), topRight: mirror(screen.bottomRight),
    bottomLeft: mirror(screen.topLeft), bottomRight: mirror(screen.topRight),
    widthMm: active.widthMm, heightMm: active.heightMm,
  };
  // The volume the hands work in: around the virtual image, under the sheet.
  const handVolume = {
    centre: [0, virtualScreen.centre[1], virtualScreen.centre[2] + 40],
    sizeMm: [Math.min(r.sheetWidthMm, active.widthMm + 120), 200, 200],
  };
  return { ...r, panel, active, screen, virtualScreen, handVolume, mirror,
           sheet: { widthMm: r.sheetWidthMm, depthMm: r.sheetDepthMm, y: 0 },
           viewer: [0, r.viewerYMm, r.viewerZMm] };
}

/** Where a point on the virtual image lands on the real panel, and vice versa: both are the same mirror. */
export const mirrorPoint = p => [p[0], -p[1], p[2]];

/**
 * Off-axis (asymmetric) frustum for one eye looking at a screen rectangle — Kooima's generalised
 * perspective projection. Returns the frustum extents at the near plane plus the eye-space basis, which is
 * everything a renderer needs. Written out rather than imported so the simulator has no three.js dependency.
 */
export function offAxisFrustum(eye, screen, near = 10, far = 5000) {
  const pa = screen.bottomLeft, pb = screen.bottomRight, pc = screen.topLeft;
  const vr = normalize(sub(pb, pa)), vu = normalize(sub(pc, pa));
  let vn = normalize(cross(vr, vu));
  const va = sub(pa, eye), vb = sub(pb, eye), vc = sub(pc, eye);
  let d = -dot(va, vn);
  if (d < 0) { vn = scale(vn, -1); d = -d; }        // keep the screen normal pointing at the eye
  if (d < 1e-6) return null;                        // the eye is in the plane of the screen
  const n = near / d;
  return { left: dot(vr, va) * n, right: dot(vr, vb) * n, bottom: dot(vu, va) * n, top: dot(vu, vc) * n,
           near, far, distance: d, vr, vu, vn };
}

/**
 * How far the floating image appears to move when the tracked eye is wrong by 1 mm. It is the ratio of the
 * image's depth in front of the screen to the eye's distance from it, so head tracking has to be STEADY
 * rather than accurate — a fingertip error is seen at full size, an eye error at a quarter of it.
 */
export function parallaxGain(eye, screen, floatDepthMm = 150) {
  const f = offAxisFrustum(eye, screen);
  return f ? floatDepthMm / Math.max(1, f.distance) : 1;
}

// ---------- the sensors ----------

const ZED_MODELS = {
  'ZED 2i': { baselineMm: 120, fovDeg: 110, width: 1280, height: 720, fps: 60 },
  'ZED 2': { baselineMm: 120, fovDeg: 110, width: 1280, height: 720, fps: 60 },
  'ZED Mini': { baselineMm: 63, fovDeg: 110, width: 1280, height: 720, fps: 60 },
};
const WEBCAM = { fovDeg: 78, width: 1920, height: 1080, fps: 30 };          // Logitech C920/C922

/** A ZED as what it really is for us: two ordinary cameras that share one exposure. */
export function makeZed({ position, target, model = 'ZED 2i', id = 'zed', noisePx = 1.0, up = [0, 1, 0] }) {
  const m = ZED_MODELS[model] || ZED_MODELS['ZED 2i'];
  const left = makeCamera({ id: `${id}-l`, label: `${model} left`, role: 'hands', position, target, up,
                            fovDeg: m.fovDeg, width: m.width, height: m.height, fps: m.fps, noisePx });
  const right = left.clone({ id: `${id}-r`, label: `${model} right`,
                             position: add(left.position, scale(left.right, m.baselineMm)) });
  right.setPose({ R: left.R });        // the eyes are parallel; the factory convergence is a few milliradians
  return [left, right];
}

export function makeWebcam({ id, position, target, label, role = 'head', noisePx = 1.2, fovDeg = WEBCAM.fovDeg }) {
  return makeCamera({ id, label: label || id, role, position, target, fovDeg,
                      width: WEBCAM.width, height: WEBCAM.height, fps: WEBCAM.fps, noisePx });
}

/**
 * Camera layouts. "zed-hands" is the user's own kit as planned; the others are the alternatives worth
 * measuring against it. Every layout is a function of the rig, so moving the monitor moves the cameras.
 */
// How far in front of the hand volume to put the ZED. Swept in the simulator: closer is more precise but
// the volume overflows the frustum, and the moment ONE eye loses the fingertip the solver drops to the
// single-camera guess — which is a 40-50 mm jump, not a graceful degradation. 380 mm was the knee.
export const ZED_RANGE_MM = 380;

export const LAYOUTS = {
  'zed-hands': {
    label: 'ZED on the hands, two webcams on the head',
    note: 'The planned kit. The ZED watches the volume under the sheet from the front at about 380 mm; the ' +
          'webcams sit on the monitor 300 mm apart and watch the head.',
    build: g => [
      ...makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, ZED_RANGE_MM], target: g.handVolume.centre }),
      makeWebcam({ id: 'cam-l', position: [-150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
      makeWebcam({ id: 'cam-r', position: [150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
    ],
  },
  'zed-plus-side': {
    label: 'ZED on the hands, one webcam on the head, one on the side',
    note: 'The cheapest big win: a third view of the hand volume from the side cuts the predicted error ' +
          'several-fold, because the ZED pair alone is weak exactly along its own line of sight.',
    build: g => [
      ...makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, ZED_RANGE_MM], target: g.handVolume.centre }),
      makeWebcam({ id: 'cam-l', position: [0, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
      makeWebcam({ id: 'cam-side', role: 'hands', position: [420, g.handVolume.centre[1] + 120, 180],
                   target: g.handVolume.centre }),
    ],
  },
  'one-webcam-head': {
    label: 'One webcam, head only (the safe fallback)',
    note: 'ONE camera cannot do both jobs on this rig. The head sits above and in front of the sheet and the ' +
          'hands sit underneath it, about 70 degrees apart from anywhere a camera can go, which is wider than ' +
          'any of these lenses. So one camera has to choose — and it should choose the head, because without ' +
          'head tracking the illusion collapses, while without hand tracking you still have a hologram.',
    build: g => [makeWebcam({ id: 'cam', role: 'head', position: [0, g.viewer[1] + 90, 30],
                              target: [0, g.viewer[1], g.viewer[2]], fovDeg: 78 })],
  },
  'one-webcam-hands': {
    label: 'One webcam on the hands (depth from palm size)',
    note: 'The other half of that choice, and the path the app runs today: a single view with depth guessed ' +
          'from how big the palm looks. It keeps working when the ZED is unplugged, and it is about ten times ' +
          'less accurate — which is exactly why it is a fallback and not the plan.',
    build: g => [makeWebcam({ id: 'cam', role: 'hands', position: [-40, g.handVolume.centre[1] + 60, 430],
                              target: g.handVolume.centre, fovDeg: 78 })],
  },
  'zed-bridge': {
    label: 'ZED SDK on the other laptop (3D over the network)',
    note: 'The hands arrive already in 3D from a bridge process. Only the head is solved here, so this ' +
          'measures what the network costs rather than what the geometry costs.',
    bridge: true,
    build: g => [
      makeWebcam({ id: 'cam-l', position: [-150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
      makeWebcam({ id: 'cam-r', position: [150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
    ],
  },
  'zed-overhead': {
    label: 'ZED overhead, looking down past the sheet',
    note: 'Keeps the camera out of the viewer\'s way, but it sees the backs of the hands, so fingertips hide ' +
          'behind knuckles exactly when you pinch.',
    build: g => [
      ...makeZed({ id: 'zed', position: [0, 400, -140], target: g.handVolume.centre }),
      makeWebcam({ id: 'cam-l', position: [-150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
      makeWebcam({ id: 'cam-r', position: [150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] }),
    ],
  },
};

export function buildLayout(name, rig = DEFAULT_RIG, overrides = {}) {
  const g = rigGeometry(rig);
  const layout = LAYOUTS[name] || LAYOUTS['zed-hands'];
  const cameras = layout.build(g);
  for (const c of cameras) {
    if (overrides.noisePx != null) c.noisePx = overrides.noisePx;
    if (overrides.fps != null) c.fps = overrides.fps;
  }
  return { name, ...layout, cameras, geometry: g };
}

// ---------- the truth: a head and a hand that move ----------

/** A plausible 21-landmark hand at a given palm centre, facing up, with a pinch that opens and closes. */
export function handPose({ centre, pinch01 = 1, spread = 1, yawDeg = 0, handedness = 'Right' }) {
  const s = handedness === 'Left' ? -1 : 1;
  const R = rodrigues([0, yawDeg * Math.PI / 180, 0]);
  const put = p => add(centre, matVec(R, [p[0] * s, p[1], p[2]]));
  const pts = new Array(HAND.COUNT);
  // Palm: wrist behind, knuckles in a row across.
  pts[HAND.WRIST] = put([0, 0, 45]);
  const knuckles = { [HAND.INDEX_MCP]: -30, [HAND.MIDDLE_MCP]: -8, [HAND.RING_MCP]: 14, [HAND.PINKY_MCP]: 35 };
  for (const [i, x] of Object.entries(knuckles)) pts[i] = put([x * spread, 8, -PALM.wristToMiddleMcpMm + 45]);
  // Fingers: three more joints along -z, curled a little.
  const fingers = [[HAND.INDEX_MCP, HAND.INDEX_PIP, HAND.INDEX_DIP, HAND.INDEX_TIP, 45],
                   [HAND.MIDDLE_MCP, HAND.MIDDLE_PIP, HAND.MIDDLE_DIP, HAND.MIDDLE_TIP, 50],
                   [HAND.RING_MCP, HAND.RING_PIP, HAND.RING_DIP, HAND.RING_TIP, 46],
                   [HAND.PINKY_MCP, HAND.PINKY_PIP, HAND.PINKY_DIP, HAND.PINKY_TIP, 36]];
  for (const [mcp, pip, dip, tip, len] of fingers) {
    const base = pts[mcp];
    const curl = mcp === HAND.INDEX_MCP ? (1 - pinch01) * 0.9 : 0.25;    // the index closes for a pinch
    const bend = i => [0, -Math.sin(curl) * len * i * 0.45, -Math.cos(curl) * len * i * 0.42];
    pts[pip] = add(base, bend(1)); pts[dip] = add(base, bend(1.7)); pts[tip] = add(base, bend(2.35));
  }
  // Thumb: swings across the palm toward the index tip as the pinch closes.
  const idxTip = pts[HAND.INDEX_TIP];
  pts[HAND.THUMB_CMC] = put([-24, 2, 30]);
  const open = put([-62, -4, -18]);
  const closed = add(idxTip, matVec(R, [-8 * s, -2, 6]));   // fingertips meet, not quite touching
  const t3 = (p, q, k) => add(scale(p, 1 - k), scale(q, k));
  pts[HAND.THUMB_MCP] = t3(put([-44, 0, 8]), t3(pts[HAND.THUMB_CMC], closed, 0.45), 1 - pinch01);
  pts[HAND.THUMB_IP] = t3(put([-56, -2, -6]), t3(pts[HAND.THUMB_CMC], closed, 0.75), 1 - pinch01);
  pts[HAND.THUMB_TIP] = t3(open, closed, 1 - pinch01);
  return pts;
}

/**
 * A 300-frame session worth of truth: the head drifts, the hand reaches into the volume, pinches, carries
 * the model across and lets go. Deliberately the motion the interaction is FOR, not a stress test.
 */
export function truthAt(tSec, g, opts = {}) {
  const { headSpeed = 1, handSpeed = 1, twoHands = false } = opts;
  const head = [
    g.viewer[0] + 70 * Math.sin(tSec * 0.5 * headSpeed) + 12 * Math.sin(tSec * 1.7),
    g.viewer[1] + 25 * Math.sin(tSec * 0.31 * headSpeed),
    g.viewer[2] + 40 * Math.sin(tSec * 0.23 * headSpeed),
  ];
  const c = g.handVolume.centre;
  // Reach in, close the pinch, carry the model across, let go, withdraw — and end exactly where it began,
  // so the loop has no jump in it. A discontinuity here would show up as solver error that is really the
  // simulator's fault, which is exactly the kind of thing that makes a measurement worthless.
  const START = [c[0] - 130, c[1] + 120, c[2] + 170];
  const AT = [c[0] - 40, c[1], c[2]];
  const CARRIED = [c[0] + 70, c[1] + 45, c[2] - 30];
  const keys = [
    { at: 0, p: START, pinch01: 1 },      // waiting, hand open
    { at: 2, p: AT, pinch01: 1 },         // reached the model
    { at: 3, p: AT, pinch01: 0 },         // pinched
    { at: 6, p: CARRIED, pinch01: 0 },    // carried it across
    { at: 7, p: CARRIED, pinch01: 1 },    // let go
    { at: 9, p: START, pinch01: 1 },      // withdrew: same pose as `at: 0`
  ];
  const k = tSec * handSpeed, phase = ((k % 9) + 9) % 9;
  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  let i = 0;
  while (i < keys.length - 2 && phase >= keys[i + 1].at) i++;
  const a = keys[i], b = keys[i + 1], u = smooth((phase - a.at) / (b.at - a.at));
  const pos = lerp3(a.p, b.p, u);
  const pinch01 = a.pinch01 + (b.pinch01 - a.pinch01) * u;
  const hands = [{ handedness: 'Right', points: handPose({ centre: pos, pinch01, yawDeg: 12 * Math.sin(k * 0.4) }) }];
  if (twoHands) hands.push({ handedness: 'Left',
    points: handPose({ centre: [c[0] + 110, c[1] + 30, c[2] + 60], pinch01: 1, yawDeg: -20, handedness: 'Left' }) });
  return { head, hands, pinch01 };
}

// ---------- what each camera would see ----------

/**
 * Project the truth through one camera, with the errors real sensors make:
 *   noisePx        zero-mean landmark jitter;
 *   dropRate       frames where the detector simply does not fire;
 *   shutterOffset  cameras that are not hardware-synced sample the world at their OWN time, which is the
 *                  single biggest reason to put the hands on the ZED (one exposure, both eyes) and only
 *                  the slow-moving head on two free-running webcams;
 *   occlusion      landmarks hidden behind the hand itself are dropped rather than guessed.
 */
export function synthesizeView(camera, truth, { noisePx, rng, dropRate = 0, occlude = true, want = null } = {}) {
  const sigma = noisePx ?? camera.noisePx ?? 1;
  if (dropRate && rng() < dropRate) return null;
  // Only run the detectors this camera is there for: a face landmarker on the ZED would be wasted frame
  // budget, and the simulator should cost what the real pipeline costs.
  const role = camera.role || 'both';
  const wantFace = want ? want.face : role === 'head' || role === 'both';
  const wantHands = want ? want.hands : role === 'hands' || role === 'both';
  const jitter = () => gaussian(rng) * sigma;
  const seen = p => {
    const q = camera.project(p);
    return q.inFrame ? { u: q.u + jitter(), v: q.v + jitter(), depth: q.depth } : null;
  };
  let face = null;
  if (wantFace) {
    const eyes = eyePoints(truth.head).map(seen);
    face = eyes.every(Boolean) ? eyes : null;  // both irises or nothing: half a face is not a measurement
  }
  const hands = [];
  if (!wantHands) return face ? { face: face.map(q => ({ x: q.u / camera.width, y: q.v / camera.height })), hands } : null;
  for (const h of truth.hands) {
    const pts = h.points.map(seen);
    // A landmark whose own hand is between it and the lens is not visible. Cheap test: a fingertip much
    // further away than the palm centre, along the same ray, is behind the hand.
    if (occlude) {
      const palm = camera.project(h.points[HAND.MIDDLE_MCP]);
      pts.forEach((q, i) => { if (q && q.depth > palm.depth + 60) pts[i] = null; });
    }
    if (pts.filter(Boolean).length < HAND.COUNT * 0.7) continue;
    // MediaPipe always emits all 21 points; a hidden one is simply wrong, so fill it from the palm depth.
    const filled = pts.map((q, i) => q || (() => { const p = camera.project(h.points[i]); return { u: p.u + jitter() * 3, v: p.v + jitter() * 3, depth: p.depth }; })());
    hands.push({ handedness: h.handedness, score: 0.95, landmarks: filled.map(q => ({ x: q.u / camera.width, y: q.v / camera.height })) });
  }
  if (!face && !hands.length) return null;
  return { face: face ? face.map(q => ({ x: q.u / camera.width, y: q.v / camera.height })) : null, hands };
}

/** The two iris centres, from a head position. IPD is the one number a per-user calibration must fix. */
export function eyePoints(head, ipdMm = 63, yawDeg = 0) {
  const R = rodrigues([0, yawDeg * Math.PI / 180, 0]);
  return [add(head, matVec(R, [-ipdMm / 2, 0, 0])),    // the viewer's right eye is at -x as they face us
          add(head, matVec(R, [ipdMm / 2, 0, 0]))];
}

// ---------- running a session ----------

/**
 * Run the REAL solver over synthetic input and measure it.
 * @returns per-frame records plus summary statistics in millimetres.
 */
export function runSession({ layout = 'zed-hands', rig = DEFAULT_RIG, frames = 300, hz = 60, seed = 1,
                             noisePx = 1.0, dropRate = 0.02, unsyncMs = null, unsyncZed = false, ipdMm = 63,
                             headSpeed = 1, handSpeed = 1, twoHands = false, latencyMs = 0,
                             tracker: existing = null, overrides = {} } = {}) {
  const built = typeof layout === 'string' ? buildLayout(layout, rig, { noisePx, ...overrides }) : layout;
  const g = built.geometry;
  const rng = mulberry32(seed);
  const tracker = existing || new Tracker({ cameras: built.cameras, ipdMm, appScale: 1,
                                            interpolate: overrides.interpolate !== false,
                                            ...(overrides.extrapolateMs != null ? { extrapolateMs: overrides.extrapolateMs } : {}) });
  tracker.setCameras(built.cameras);

  // Free-running cameras each sit at their own phase within a frame period, so they sample the world at
  // different instants. The two ZED eyes share ONE exposure, which is the whole point of them — set
  // unsyncZed to break that and measure what the hardware sync is worth.
  const phase = new Map();
  for (const c of built.cameras) {
    const group = !unsyncZed && c.id.startsWith('zed') ? 'zed' : c.id;
    if (!phase.has(group)) phase.set(group, (unsyncMs == null ? rng() * (1000 / (c.fps || hz)) : rng() * unsyncMs));
    phase.set(c.id, phase.get(group));
  }

  const records = [];
  for (let f = 0; f < frames; f++) {
    const nowMs = (f * 1000) / hz;
    for (const c of built.cameras) {
      const period = 1000 / (c.fps || hz);
      const capture = Math.floor((nowMs - phase.get(c.id)) / period) * period + phase.get(c.id);
      if (capture < 0) continue;
      const truthAtCapture = truthAt(capture / 1000, g, { headSpeed, handSpeed, twoHands });
      const view = synthesizeView(c, truthAtCapture, { noisePx: c.noisePx, rng, dropRate });
      if (!view) continue;
      tracker.observe2D({ camId: c.id, tMs: capture, face: view.face, hands: view.hands, normalized: true });
    }
    if (built.bridge) {
      // The bridge path: 3D hands arrive over the network, late and occasionally not at all.
      const tCapture = nowMs - (latencyMs || 35);
      if (tCapture >= 0 && rng() > dropRate) {
        const t = truthAt(tCapture / 1000, g, { headSpeed, handSpeed, twoHands });
        tracker.observe3D({ tMs: tCapture, source: 'bridge',
          hands: t.hands.map(h => ({ handedness: h.handedness,
            points: h.points.map(p => p.map(v => v + gaussian(rng) * 2.5)) })) });
      }
    }

    const truth = truthAt(nowMs / 1000, g, { headSpeed, handSpeed, twoHands });
    const out = tracker.solve(nowMs);
    // Two different errors, kept apart on purpose. Against the truth at NOW is what the user sees, and it
    // includes every millisecond of pipeline lag. Against the truth at the moment the cameras actually
    // fired is the geometry's own error — that is the one to look at when judging camera placement,
    // because otherwise a faster camera looks like a more accurate one.
    const truthRef = truthAt(out.tHandMs / 1000, g, { headSpeed, handSpeed, twoHands });
    const truthEyeRef = truthAt(out.tEyeMs / 1000, g, { headSpeed, handSpeed, twoHands });
    const eyeTruth = scale(add(...eyePoints(truth.head, ipdMm)), 0.5);
    const tipTruth = truth.hands[0].points[HAND.INDEX_TIP];
    const thumbTruth = truth.hands[0].points[HAND.THUMB_TIP];
    const gripTruth = scale(add(tipTruth, thumbTruth), 0.5);
    const hand = out.hands.find(h => h.active && h.handedness === 'Right') || out.hands.find(h => h.active);
    records.push({
      f, nowMs,
      eyeErrMm: out.eye ? dist(out.eye, eyeTruth) : null,
      eyeRawErrMm: tracker.eyeRaw ? dist(tracker.eyeRaw, eyeTruth) : null,
      tipErrMm: hand && hand.tip ? dist(hand.tip, tipTruth) : null,
      gripErrMm: hand && hand.grip ? dist(hand.grip, gripTruth) : null,
      rawTipErrMm: hand && hand.raw && hand.raw[HAND.INDEX_TIP] ? dist(hand.raw[HAND.INDEX_TIP], tipTruth) : null,
      geomTipErrMm: hand && hand.raw && hand.raw[HAND.INDEX_TIP]
        ? dist(hand.raw[HAND.INDEX_TIP], truthRef.hands[0].points[HAND.INDEX_TIP]) : null,
      geomEyeErrMm: tracker.eyeRaw
        ? dist(tracker.eyeRaw, scale(add(...eyePoints(truthEyeRef.head, ipdMm)), 0.5)) : null,
      lagMs: nowMs - out.tHandMs,
      pinch: hand ? hand.pinch : false,
      pinchTruth: truth.pinch01 < 0.25,
      pinchDistMm: hand ? hand.pinchDistMm : null,
      source: hand ? hand.source : 'none',
      views: hand ? hand.views : 0,
      quality: out.quality,
      truth: { eye: eyeTruth, tip: tipTruth, grip: gripTruth },
      solved: { eye: out.eye, tip: hand ? hand.tip : null, points: hand ? hand.points : null },
    });
  }
  return { records, stats: summarize(records), layout: built, geometry: g, tracker };
}

export function summarize(records) {
  const pick = key => records.map(r => r[key]).filter(v => v != null && Number.isFinite(v));
  const eye = pick('eyeErrMm'), tip = pick('tipErrMm'), grip = pick('gripErrMm'), raw = pick('rawTipErrMm');
  const geom = pick('geomTipErrMm'), lag = pick('lagMs');
  const pinchRight = records.filter(r => r.pinch === r.pinchTruth).length;
  const tracked = records.filter(r => r.tipErrMm != null).length;
  return {
    frames: records.length,
    eyeMeanMm: mean(eye), eyeP95Mm: percentile(eye, 0.95), eyeMaxMm: eye.length ? Math.max(...eye) : 0,
    tipMeanMm: mean(tip), tipP95Mm: percentile(tip, 0.95), tipMaxMm: tip.length ? Math.max(...tip) : 0,
    gripMeanMm: mean(grip), gripP95Mm: percentile(grip, 0.95),
    rawTipMeanMm: mean(raw),
    geomTipMeanMm: mean(geom), geomTipP95Mm: percentile(geom, 0.95),
    sampleLagMs: mean(lag),
    jitterMm: mean(records.slice(1).map((r, i) => {
      const a = r.solved.tip, b = records[i].solved.tip;
      return a && b ? dist(a, b) : null;
    }).filter(v => v != null)),
    trackedFraction: records.length ? tracked / records.length : 0,
    pinchAccuracy: records.length ? pinchRight / records.length : 0,
    latencyMs: mean(records.map(r => r.quality.latencyMs)),
    source: records.length ? (records[records.length - 1].source || 'none') : 'none',
  };
}

// ---------- coverage ----------

/**
 * Where in the hand volume is a fingertip actually seen well? For each cell: how many cameras have it in
 * frame, and the error the geometry predicts from their pixel noise. This is the picture that decides
 * where to bolt the cameras, and it needs no hardware to draw.
 */
export function coverageMap({ cameras, geometry, steps = [17, 9, 13], sliceY = null, pad = 60 }) {
  const v = geometry.handVolume;
  const size = [v.sizeMm[0] + pad * 2, v.sizeMm[1] + pad * 2, v.sizeMm[2] + pad * 2];
  const origin = [v.centre[0] - size[0] / 2, v.centre[1] - size[1] / 2, v.centre[2] - size[2] / 2];
  const cells = [];
  let best = Infinity, worst = 0, covered = 0, total = 0;
  for (let ix = 0; ix < steps[0]; ix++) for (let iy = 0; iy < steps[1]; iy++) for (let iz = 0; iz < steps[2]; iz++) {
    const p = [origin[0] + size[0] * (steps[0] === 1 ? 0.5 : ix / (steps[0] - 1)),
               origin[1] + size[1] * (steps[1] === 1 ? 0.5 : iy / (steps[1] - 1)),
               origin[2] + size[2] * (steps[2] === 1 ? 0.5 : iz / (steps[2] - 1))];
    if (sliceY != null && Math.abs(p[1] - sliceY) > size[1] / (2 * Math.max(1, steps[1] - 1))) continue;
    const e = expectedErrorMm(p, cameras);
    total++;
    if (e.views >= 2 && e.mm != null) { covered++; best = Math.min(best, e.mm); worst = Math.max(worst, e.mm); }
    cells.push({ p, ix, iy, iz, views: e.views, mm: e.views >= 2 ? e.mm : null });
  }
  return { cells, steps, origin, size,
           coveredFraction: total ? covered / total : 0,
           bestMm: Number.isFinite(best) ? best : null, worstMm: worst || null,
           medianMm: percentile(cells.map(c => c.mm).filter(v => v != null), 0.5) };
}

/** A horizontal slice through the middle of the hand volume — what the UI paints as a heat map. */
export const coverageSlice = (cameras, geometry, nx = 33, nz = 25) =>
  coverageMap({ cameras, geometry, steps: [nx, 1, nz] });

// ---------- comparing layouts ----------

/** Run every layout with the same seed and the same rig, so the numbers are comparable. */
export function compareLayouts(opts = {}) {
  return Object.keys(LAYOUTS).map(name => {
    const { stats, layout } = runSession({ ...opts, layout: name });
    const cov = coverageSlice(layout.cameras, layout.geometry);
    return { name, label: layout.label, note: layout.note, stats,
             coverage: { median: cov.medianMm, covered: cov.coveredFraction } };
  });
}
