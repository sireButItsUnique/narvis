// Webcam input: MediaPipe face (-> eye position) and up to two hands (-> fingertip, pinch point, pinch, skeleton),
// written into the shared input.
import * as THREE from 'three';
import { S, makeFilter3 } from '../settings.js';
import { webcamPos, focalPx } from '../view.js';
import { input } from './state.js';

const MP_VERSION = '0.10.35';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const eyeFilt = makeFilter3(1.0, 0.05);
const tipFilt = [makeFilter3(1.6, 0.08), makeFilter3(1.6, 0.08)];
const gripFilt = [makeFilter3(1.6, 0.08), makeFilter3(1.6, 0.08)];

// tracker state, also read by calibration and the debug view
export const cam = { video: null, faceLm: null, handLm: null, lastVideoTime: -1, lastFace: null, lastHands: [], ipdHistory: [] };

export async function startCamera(status) {
  status('Opening webcam…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' }, audio: false });
  const video = cam.video = document.createElement('video');
  Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();

  status('Loading tracking models (about 25 MB the first time)…');
  const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = async (Cls, opts) => {
    try { return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }); }
    catch (e) { console.warn('GPU delegate failed, using CPU', e); return Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
  };
  cam.faceLm = await make(FaceLandmarker, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'VIDEO', numFaces: 1 });
  cam.handLm = await make(HandLandmarker, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 2 });
  input.mode = 'camera';
}

const d3 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
const joint = (j, i) => new THREE.Vector3(j[i * 3], j[i * 3 + 1], j[i * 3 + 2]);

// Landmarks -> world cm. Depth comes from palm size (average adult: wrist->middle knuckle ~8.5 cm,
// index->pinky knuckle ~7 cm; max() resists foreshortening), then each joint steps forward or back from
// that palm segment by its MediaPipe z (smaller = closer to the camera, same scale as x).
function handToWorld(K, vw, vh, f, wc) {
  const P = i => ({ x: K[i].x * vw, y: K[i].y * vh, z: K[i].z * vw });
  const s09 = d3(P(0), P(9)) / 8.5, s517 = d3(P(5), P(17)) / 7.0;
  const pxPerCm = Math.max(s09, s517);   // scale at the depth of the winning palm segment
  const zRef = s09 > s517 ? (K[0].z + K[9].z) / 2 : (K[5].z + K[17].z) / 2;
  const joints = new Float32Array(21 * 3);
  for (let i = 0; i < 21; i++) {
    const depth = Math.max(3, (f + (K[i].z - zRef) * vw) / pxPerCm);
    joints[i * 3] = wc.x - (K[i].x * vw - vw / 2) * depth / f;
    joints[i * 3 + 1] = wc.y - (K[i].y * vh - vh / 2) * depth / f;
    joints[i * 3 + 2] = depth;
  }
  return { joints, tip: joint(joints, 8), pinchRatio: d3(P(4), P(8)) / d3(P(0), P(9)) };
}

// Which slot each detected hand goes in, so a hand keeps its slot (and its filters and pinch) frame to frame.
// Returns the slot for each detection.
function assignSlots(dets, now) {
  const hands = input.hands, recent = hands.map(h => now - h.seenAt < 500);
  if (dets.length === 1) {
    let best = -1, bestDist = 15;   // cm: close enough to be the same hand
    hands.forEach((h, s) => { if (recent[s] && h.tip.distanceTo(dets[0].tip) < bestDist) { best = s; bestDist = h.tip.distanceTo(dets[0].tip); } });
    // Far from every slot: most likely the same hand after a fast, blurred move that tracking briefly lost,
    // so keep it in the slot that was just tracking (opening the other slot would look like two pinched hands).
    return [best >= 0 ? best : (recent[1] && !recent[0] ? 1 : 0)];
  }
  const [a, b] = dets;
  if (recent[0] && recent[1]) {
    const keep = hands[0].tip.distanceTo(a.tip) + hands[1].tip.distanceTo(b.tip);
    const swap = hands[0].tip.distanceTo(b.tip) + hands[1].tip.distanceTo(a.tip);
    return keep <= swap ? [0, 1] : [1, 0];
  }
  if (recent[0] || recent[1]) {
    const s = recent[0] ? 0 : 1, aIsIt = hands[s].tip.distanceTo(a.tip) <= hands[s].tip.distanceTo(b.tip);
    return aIsIt ? [s, 1 - s] : [1 - s, s];
  }
  return a.tip.x <= b.tip.x ? [0, 1] : [1, 0];   // both new: the hand further left is slot 0
}

function updateHand(s, det, now, tSec) {
  const h = input.hands[s], j = det.joints;
  const grip = joint(j, 4).add(joint(j, 8)).multiplyScalar(0.5);
  h.tip.set(tipFilt[s][0].filter(det.tip.x, tSec), tipFilt[s][1].filter(det.tip.y, tSec), tipFilt[s][2].filter(det.tip.z, tSec));
  h.grip.set(gripFilt[s][0].filter(grip.x, tSec), gripFilt[s][1].filter(grip.y, tSec), gripFilt[s][2].filter(grip.z, tSec));
  h.gripRaw.copy(grip);
  h.jointsWorld = j;
  h.pinchRatio = det.pinchRatio;
  if (!h.pinch && h.pinchRatio < 0.28) h.pinch = true;
  else if (h.pinch && h.pinchRatio > 0.45) h.pinch = false;
  h.seenAt = now;
  h.active = true;
}

export function track(now) {
  for (const h of input.hands) h.active = S.hands && now - h.seenAt < 300;
  const { video, faceLm, handLm } = cam;
  if (!video || !faceLm || video.readyState < 2 || video.currentTime === cam.lastVideoTime) return;
  cam.lastVideoTime = video.currentTime;
  const vw = video.videoWidth, vh = video.videoHeight, f = focalPx(vw), wc = webcamPos(), tSec = now / 1000;

  // --- head: iris centres -> distance from their pixel spacing -> 3D eye position ---
  const fr = faceLm.detectForVideo(video, now);
  if (fr.faceLandmarks && fr.faceLandmarks.length) {
    const L = fr.faceLandmarks[0];
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });
    let a = L[468], b = L[473];                                  // iris centres
    if (!a || !b) { a = mid(L[33], L[133]); b = mid(L[362], L[263]); }
    // raw (unmirrored) frame: the viewer's right eye appears on the left of the image
    const rightEye = a.x < b.x ? a : b, leftEye = a.x < b.x ? b : a;
    const ipdPx = Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh, (a.z - b.z) * vw);   // z term reduces head-turn error
    cam.ipdHistory.push(ipdPx); if (cam.ipdHistory.length > 20) cam.ipdHistory.shift();
    const dist = (S.ipdMm / 10) * f / ipdPx;
    const p = S.eye === 'left' ? leftEye : S.eye === 'right' ? rightEye : mid(a, b);
    const X = -(p.x * vw - vw / 2) * dist / f;
    const Y = -(p.y * vh - vh / 2) * dist / f;
    input.eye.set(eyeFilt[0].filter(wc.x + X, tSec),
                  eyeFilt[1].filter(wc.y + Y + S.eyeYNudgeCm, tSec),
                  eyeFilt[2].filter(dist, tSec));
    input.faceSeenAt = now; cam.lastFace = { a, b, vw, vh };
  } else if (now - input.faceSeenAt > 1500) {
    eyeFilt.forEach(fl => fl.reset());
  }

  // --- hands: fingertip + pinch point in 3D (depth from palm size), pinch, skeleton ---
  if (!S.hands || !handLm) return;
  const hr = handLm.detectForVideo(video, now);
  const dets = (hr.landmarks || []).slice(0, 2).map(K => handToWorld(K, vw, vh, f, wc));
  cam.lastHands = (hr.landmarks || []).slice(0, 2);
  const slots = dets.length ? assignSlots(dets, now) : [];
  dets.forEach((det, k) => updateHand(slots[k], det, now, tSec));
  input.hands.forEach((h, s) => {
    if (!slots.includes(s) && now - h.seenAt > 500) {
      tipFilt[s].forEach(fl => fl.reset()); gripFilt[s].forEach(fl => fl.reset());
      h.pinch = false; h.jointsWorld = null;
    }
  });
}

// ---------- debug view: the camera image with the tracked points ----------
export function drawDebug(dbg) {
  if (dbg.hidden || !cam.video || cam.video.readyState < 2) return;
  const dctx = dbg.getContext('2d'), now = performance.now();
  dctx.drawImage(cam.video, 0, 0, dbg.width, dbg.height);
  const sx = dbg.width, sy = dbg.height;
  if (cam.lastFace && now - input.faceSeenAt < 300) {
    dctx.fillStyle = '#35d0ff';
    for (const p of [cam.lastFace.a, cam.lastFace.b]) { dctx.beginPath(); dctx.arc(p.x * sx, p.y * sy, 3, 0, 7); dctx.fill(); }
  }
  if (input.hands.some(h => now - h.seenAt < 300)) {
    const pinching = input.hands.some(h => h.pinch);
    dctx.fillStyle = pinching ? '#ffb23e' : '#7cff9b';
    for (const K of cam.lastHands) for (const p of K) { dctx.beginPath(); dctx.arc(p.x * sx, p.y * sy, 2, 0, 7); dctx.fill(); }
  }
}
