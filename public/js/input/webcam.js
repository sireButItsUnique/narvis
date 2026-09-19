// Webcam input: MediaPipe face (-> eye position) and hand (-> fingertip + pinch), written into the shared input.
import { S, makeFilter3 } from '../settings.js';
import { webcamPos, focalPx } from '../view.js';
import { input } from './state.js';

const MP_VERSION = '0.10.35';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const eyeFilt = makeFilter3(1.0, 0.05);
const fingerFilt = makeFilter3(1.6, 0.08);

// tracker state, also read by calibration and the debug view
export const cam = { video: null, faceLm: null, handLm: null, lastVideoTime: -1, lastFace: null, lastHand: null, ipdHistory: [] };

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
  cam.handLm = await make(HandLandmarker, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 1 });
  input.mode = 'camera';
}

const d3 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

export function track(now) {
  const hand = input.hands[0];
  hand.active = S.hands && now - hand.seenAt < 300;
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

  // --- hand: index fingertip in 3D (depth from palm size) + pinch ---
  if (S.hands && handLm) {
    const hr = handLm.detectForVideo(video, now);
    if (hr.landmarks && hr.landmarks.length) {
      const K = hr.landmarks[0];
      const P = i => ({ x: K[i].x * vw, y: K[i].y * vh, z: K[i].z * vw });
      // average adult: wrist->middle knuckle ~8.5 cm, index->pinky knuckle ~7 cm; max() resists foreshortening
      const s09 = d3(P(0), P(9)) / 8.5, s517 = d3(P(5), P(17)) / 7.0;
      const pxPerCm = Math.max(s09, s517);   // scale at the depth of the winning palm segment
      const zRef = s09 > s517 ? (K[0].z + K[9].z) / 2 : (K[5].z + K[17].z) / 2;
      // step from that palm segment forward to the fingertip (MediaPipe z: smaller = closer to the camera, same scale as x)
      const depth = Math.max(3, (f + (K[8].z - zRef) * vw) / pxPerCm);
      const tip = P(8);
      hand.tip.set(fingerFilt[0].filter(wc.x - (tip.x - vw / 2) * depth / f, tSec),
                   fingerFilt[1].filter(wc.y - (tip.y - vh / 2) * depth / f, tSec),
                   fingerFilt[2].filter(depth, tSec));
      hand.pinchRatio = d3(P(4), P(8)) / d3(P(0), P(9));
      if (!hand.pinch && hand.pinchRatio < 0.28) hand.pinch = true;
      else if (hand.pinch && hand.pinchRatio > 0.45) hand.pinch = false;
      hand.seenAt = now; hand.joints = K; cam.lastHand = { K, vw, vh };
      hand.active = true;
    } else if (now - hand.seenAt > 500) {
      fingerFilt.forEach(fl => fl.reset()); hand.pinch = false;
    }
  }
}

// ---------- debug view: the camera image with the tracked points ----------
export function drawDebug(dbg) {
  if (dbg.hidden || !cam.video || cam.video.readyState < 2) return;
  const dctx = dbg.getContext('2d'), hand = input.hands[0], now = performance.now();
  dctx.drawImage(cam.video, 0, 0, dbg.width, dbg.height);
  const sx = dbg.width, sy = dbg.height;
  if (cam.lastFace && now - input.faceSeenAt < 300) {
    dctx.fillStyle = '#35d0ff';
    for (const p of [cam.lastFace.a, cam.lastFace.b]) { dctx.beginPath(); dctx.arc(p.x * sx, p.y * sy, 3, 0, 7); dctx.fill(); }
  }
  if (cam.lastHand && now - hand.seenAt < 300) {
    dctx.fillStyle = hand.pinch ? '#ffb23e' : '#7cff9b';
    for (const p of cam.lastHand.K) { dctx.beginPath(); dctx.arc(p.x * sx, p.y * sy, 2, 0, 7); dctx.fill(); }
  }
}
