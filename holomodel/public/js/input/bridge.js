// SPDX-License-Identifier: GPL-3.0-or-later
// The rig's input source: the ZED tracker (gesture_detection/gesture_detect.py --rig-bridge) instead of a
// webcam and MediaPipe in the page.
//
// The bridge owns the camera and sends, in the ZED's own frame, the viewer's eye and the 21 joints of ONE
// hand - triangulated between two lenses, with a fused pinch reading and a confidence per frame. This file
// turns that into what the rest of the app reads (input/state.js), and that is ALL that changes: commands,
// tools, sculpting and voice read `input` and never knew there was a webcam.
//
// Two frames are in play and they differ by one translation:
//   rig    cm, origin at the centre of the acrylic sheet, +x viewer's right, +y up, +z toward the viewer.
//          Where the bridge's points land (the same camera pose rigtest3 calibrates, saved in this browser).
//   world  the app's own frame: origin at the centre of "the display", the model in a box behind it. On the
//          rig there is no display to reach behind - the box is a STAGE in the slot under the sheet, where the
//          hand can physically be. STAGE.origin is where the box's front face centre sits, in rig cm; the axes
//          already agree. The rig camera is handed the same translation (main.js), so what is drawn, what the
//          hand touches and what the eye sees are one place.
//
// The stage is sized by the hardware, not by taste: the ZED needs the hand in both lenses (about 12-14 cm
// either side of centre) and the panel's picture only covers the front of the slot, so the box is 24 cm wide,
// the slot's 13.5 cm tall, and runs from 24 cm in front of the sheet's centre line back to about 2 cm.

import { input } from './state.js';
import { ZedClient } from './zed-client.js';
import { camToWorld } from './stereo.js';
import * as ZP from '../rig/zed-place.js';
import * as RS from '../rig/rig-setup.js';
import { makeHandGate, makeHandSmoother, scaleAboutLens } from '../rig/hands.js';
import { makeGrab, centroid } from '../rig/demo.js';

export const STAGE = { origin: [0, -6.75, 24], W: 24, H: 13.5 };   // a 24 x 13.5 cm "display": the slot's front face
export const worldFromRig = p => [p[0] - STAGE.origin[0], p[1] - STAGE.origin[1], p[2] - STAGE.origin[2]];
// column-major 4x4 for geometry.js applyRigCamera(camera, rc, worldFromRig)
export const WORLD_FROM_RIG = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -STAGE.origin[0], -STAGE.origin[1], -STAGE.origin[2], 1];
// The slot is as tall as the sheet is above the mat, and that is a MEASURED number (setup.rig.baseDropCm, the
// same one rigtest3's mat grid and demo floor stand on). The stage's floor is the mat: with 13.5 written in
// here, a rig measured at 12.2 had its models set down 1.3 cm inside the table. Call before the room is built.
export function stageFromSetup(setup) {
  const drop = Number(setup?.rig?.baseDropCm);
  if (Number.isFinite(drop) && drop > 2) { STAGE.H = drop; STAGE.origin[1] = -drop / 2; WORLD_FROM_RIG[13] = drop / 2; }
  return STAGE;
}

const STORE = {                        // rigtest3's saved setup: same origin, so the same calibration
  getItem: () => globalThis.localStorage?.getItem('holo-rigtest3') ?? null,
  setItem: (_k, v) => { try { globalThis.localStorage?.setItem('holo-rigtest3', v); } catch {} },
};
export const loadSetup = () => RS.loadSetup(STORE);
export const rigFromSetup = setup => RS.rigFromSetup(setup);

const HAND_FRESH_MS = 150;
const state = { client: null, setup: null, hand: null, head: null, headAt: -1e9, stats: null, eyeRig: null,
                gate: null, smooth: makeHandSmoother({ holdMs: 0 }), grab: null, gated: null, rel: null };

function extrinsics(setup) {
  return ZP.zedExtrinsics({ sheetHeightCm: setup.rig.baseDropCm, lensHeightCm: setup.rig.baseDropCm + setup.pair.heightCm,
                            xCm: 0, zCm: setup.pair.depthCm, baselineCm: ZP.DEFAULT_PLACEMENT.baselineCm,
                            tiltDeg: setup.pair.tiltUpDeg, model: 'ZED 2' }, [setup.head.positionCm]);
}
const toRig = (camCm) => {
  const w = camToWorld(camCm, extrinsics(state.setup)), t = state.setup.trimCm;
  return [w[0] + t[0], w[1] + t[1], w[2] + t[2]];
};
const handToRig = (camCm) => {
  const tune = state.setup.handTune, w = toRig(scaleAboutLens(camCm, tune.scale));
  return [w[0] + tune.offsetCm[0], w[1] + tune.offsetCm[1], w[2] + tune.offsetCm[2]];
};

export function startBridge(url = 'ws://127.0.0.1:8902') {
  state.setup = loadSetup();
  state.gate = makeHandGate({ minConf: state.setup.stability.minConf, holdMs: state.setup.stability.holdMs });
  state.grab = makeGrab({ close: state.setup.demo.grabClose, open: state.setup.demo.grabOpen,
                          wideOpen: state.setup.demo.grabOpen + 0.38 });
  state.eyeRig = state.setup.head.positionCm.slice();
  state.client = new ZedClient({
    url,
    onHead: h => { state.head = h; if (h.eye) state.headAt = performance.now(); },
    onHands: m => { state.hand = m.hands.length ? { ...m.hands[0], seq: m.seq, at: performance.now() } : null; },
    onStatus: st => { state.stats = st; },
  });
  state.client.connect();
  input.mode = 'camera';               // "hands, not the mouse" to everything downstream
  input.source = 'bridge';
  return state;
}

// Once per drawn frame, before the interaction runs. Fills input.eye and input.hands[0]; hands[1] stays off
// (the tracker follows one hand, on purpose: see gesture_detection).
export function bridgeTick(now) {
  if (!state.client) return null;
  if (state.head?.eye && now - state.headAt < 1500) state.eyeRig = toRig(state.head.eye);
  input.eye.fromArray(worldFromRig(state.eyeRig));
  if (now - state.headAt < 300) input.faceSeenAt = now;

  const fresh = state.hand && now - state.hand.at < HAND_FRESH_MS;
  state.gated = state.gate.update(fresh ? { points: state.hand.cam.map(handToRig), pinch: state.hand.pinch,
                                            conf: state.hand.quality?.conf ?? state.hand.score ?? null, id: state.hand.seq } : null, now);
  const pts = state.smooth.update(state.gated.points, now);
  writeHand(state, pts, state.gated.pinch, now);
  return state;
}

// The hand, as the app reads it, from 21 points in RIG centimetres (already gated and smoothed) and the
// bridge's pinch reading. `s` carries the grab machine and the grip's memory between frames. Used by
// bridgeTick above and by rigtest3, which has its own copy of the hand and no need of a second socket.
export function makeHandWriter({ close = 0.40, open = 0.62 } = {}) {
  return { grab: makeGrab({ close, open, wideOpen: open + 0.38 }), rel: null };
}
export function writeEye(eyeRig, tracked, now) {
  input.eye.fromArray(worldFromRig(eyeRig));
  if (tracked) input.faceSeenAt = now;
}
export function writeHand(s, pts, pinch, now) {
  input.spatial = true;                  // this hand is WHERE the model is, not in front of a screen: interaction.js
  const h = input.hands[0], other = input.hands[1];
  other.active = false; other.pinch = false; other.jointsWorld = null;
  if (!pts) {
    const g = s.grab.update(null, now);
    // A coasting grip outlives a lost hand, briefly - and for that it has to still BE a hand: a gesture ends on
    // !active, so with active false the model was dropped anyway, and the pinch that stayed true through the
    // coast then had no rising edge to take it up again when the hand came back still closed.
    h.active = g.held; h.jointsWorld = null; h.pinch = g.held;
    if (!g.held) h.pinchRatio = 1;
    s.rel = null;
    return;
  }
  const state = s;
  const world = pts.map(worldFromRig);
  const joints = h.jointsWorld && h.jointsWorld.length === 63 ? h.jointsWorld : new Float32Array(63);
  world.forEach((p, i) => joints.set(p, i * 3));
  // pinch: the bridge's fused reading through the hold logic that does not drop things (rig/demo.js makeGrab)
  const p = pinch, gap = Number.isFinite(p?.grab) ? p.grab : Number.isFinite(p?.gap) ? p.gap : null;
  const g = state.grab.update(gap ?? ratio(world), now);
  // grip: carried on the palm, with the fingertips' offset from it smoothed hard while holding - they are the
  // shakiest joints there are, and whatever is held is hiding them
  const palm = centroid(world), raw = mid(world[4], world[8]).map((v, i) => v - palm[i]);
  const dt = state.rel && state.relAt ? Math.min(0.1, Math.max(0.001, (now - state.relAt) / 1000)) : 1 / 60;   // this page runs at 25-60 fps
  state.relAt = now;
  const k = state.rel ? 1 - Math.exp(-dt / (g.held ? 0.14 : 0.04)) : 1;
  state.rel = state.rel ? state.rel.map((v, i) => v + (raw[i] - v) * k) : raw;
  h.grip.set(palm[0] + state.rel[0], palm[1] + state.rel[1], palm[2] + state.rel[2]);
  h.gripRaw.fromArray(mid(world[4], world[8]));
  h.tip.fromArray(world[8]);
  h.jointsWorld = joints;
  h.pinch = g.held;
  h.pinchRatio = g.gap ?? 1;
  h.seenAt = now;
  h.active = true;
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ratio = w => d3(w[4], w[8]) / Math.max(d3(w[0], w[9]), 1e-6);

// What to tell the person at the rig when nothing is happening.
export function bridgeStatus(now = performance.now()) {
  const st = state.stats;
  if (!st || st.state !== 'live') return { ok: false, text: 'Waiting for the tracker: run  python gesture_detect.py --rig-bridge  in gesture_detection/' };
  if (now - state.headAt > 2000) return { ok: true, text: 'Tracker connected, but it cannot see your face: the picture is holding still' };
  return { ok: true, text: '' };
}
export const bridgeState = () => state;
