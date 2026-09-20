// One camera view's landmark detector, off the main thread.
// The page sends ImageBitmaps (already cropped to this view, so a ZED's two eyes are two workers) and gets
// back eye centres and hand landmarks with the capture timestamp they came from. Running here keeps
// MediaPipe's inference out of the render loop, which is the whole reason the hologram stays smooth.
//
// Messages in:  {t:'init', ...}, {t:'frame', seq, at, bitmap}, {t:'stop'}
// Messages out: {t:'ready'|'error'|'result', ...}
//
// This is a CLASSIC worker with no static imports: MediaPipe 0.10.35 throws "ModuleFactory not set." when
// it is initialised inside a module worker, but loads fine from a dynamic import() in a classic one.

const MP_VERSION = '0.10.35';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const GOOGLE = 'https://storage.googleapis.com/mediapipe-models';
// local copy first (npm run vendor), online second, so the rig works with no internet at the venue
const URLS = {
  bundle: ['/vendor/mediapipe/vision_bundle.mjs', `${MP_CDN}/vision_bundle.mjs`],
  wasm: ['/vendor/mediapipe/wasm', `${MP_CDN}/wasm`],
  face: ['/vendor/models/face_landmarker.task', `${GOOGLE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`],
  hand: ['/vendor/models/hand_landmarker.task', `${GOOGLE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`],
};

// The whole 478-point face mesh, as a flat u,v Float32Array. Off by default: the eye centres are all the
// tracker needs, and 478 points per frame per camera is bandwidth nobody asked for. Calibration is the one
// job that wants them - the same landmark INDEX is the same physical point in both cameras, which is what
// turns a face moving about into a calibration target (see js/rig/paircalib.js).
function packMesh(L) {
  const out = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { out[i * 2] = L[i].x; out[i * 2 + 1] = L[i].y; }
  return out;
}

const state = {
  id: '?', tasks: { face: true, hands: true, mesh: false }, detector: 'auto', allowBlob: false,
  faceLm: null, handLm: null, busy: false, canvas: null, ctx: null, lastTs: -1,
  dropped: 0, done: 0, delegate: null, kind: null,
};

async function pick([local, online], probe = '') {
  try { const r = await fetch(local + probe, { method: 'HEAD' }); if (r.ok) return local; } catch {}
  return online;
}

async function initMediapipe() {
  const bundleUrl = await pick(URLS.bundle);
  const { FilesetResolver, FaceLandmarker, HandLandmarker } = await import(bundleUrl);
  const wasmBase = await pick(URLS.wasm, '/vision_wasm_internal.js');
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  const make = async (Cls, opts) => {
    try {
      const inst = await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } });
      state.delegate = 'GPU'; return inst;
    } catch (e) {
      state.delegate = 'CPU';
      return Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
    }
  };
  if (state.tasks.face) {
    const model = await pick(URLS.face);
    state.faceLm = await make(FaceLandmarker, { baseOptions: { modelAssetPath: model }, runningMode: 'VIDEO', numFaces: 1 });
  }
  if (state.tasks.hands) {
    const model = await pick(URLS.hand);
    state.handLm = await make(HandLandmarker, { baseOptions: { modelAssetPath: model }, runningMode: 'VIDEO', numHands: 2 });
  }
  state.kind = 'mediapipe';
}

// ---------- blob detector: a real (crude) detector for synthetic input ----------
// Not a stand-in for MediaPipe: it finds the brightest spot and reports it as one "fingertip", which is
// enough to prove the whole chain (crop -> worker -> timestamp -> triangulate -> world) with a generated
// video and no models downloaded. Results are flagged synthetic so nothing can mistake it for tracking.
const BLOB_W = 320;   // wide enough that the centroid is worth about a centimetre of depth at arm's length

function blobDetect(bitmap) {
  const h = Math.max(1, Math.round(BLOB_W * bitmap.height / bitmap.width));
  if (!state.canvas || state.canvas.width !== BLOB_W || state.canvas.height !== h) {
    state.canvas = new OffscreenCanvas(BLOB_W, h);
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true });
  }
  state.ctx.drawImage(bitmap, 0, 0, BLOB_W, h);
  const { data } = state.ctx.getImageData(0, 0, BLOB_W, h);
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, data[i] + data[i + 1] + data[i + 2]);
  if (peak < 120) return null;                       // nothing bright enough to call a blob
  const cut = peak * 0.8;
  let sx = 0, sy = 0, sw = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < BLOB_W; x++) {
    const i = (y * BLOB_W + x) * 4, v = data[i] + data[i + 1] + data[i + 2];
    if (v < cut) continue;
    sx += x * v; sy += y * v; sw += v; n++;
  }
  if (!n) return null;
  const u = (sx / sw + 0.5) / BLOB_W, v = (sy / sw + 0.5) / h;
  return { u, v, r: Math.sqrt(n / Math.PI) / BLOB_W, score: Math.min(1, peak / 765) };
}

// A blob -> the 21-point shape the rest of the pipeline expects, with the fingertip exactly on the blob.
function blobHand(b) {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push([b.u - b.r * 0.6 + (i % 5) * b.r * 0.1, b.v + b.r * 0.8 - Math.floor(i / 5) * b.r * 0.2, 0]);
  lm[8] = [b.u, b.v, 0];                         // index tip: the blob itself
  lm[4] = [b.u + b.r * 0.35, b.v + b.r * 0.2, 0];  // thumb tip, so pinch distance is defined
  return { handedness: 'Right', score: b.score, lm, synthetic: true };
}

function detect(bitmap, at) {
  const out = { face: null, hands: [] };
  if (state.kind === 'blob') {
    const b = blobDetect(bitmap);
    if (b) {
      if (state.tasks.hands) out.hands.push(blobHand(b));
      if (state.tasks.face) out.face = { eyes: [[b.u - b.r * 0.6, b.v, 0], [b.u + b.r * 0.6, b.v, 0]], synthetic: true };
      // No mesh from a blob: one bright spot is one point, and 478 copies of it would be a calibration
      // target made of nothing. Calibration refuses a short mesh rather than fitting a pose to a lamp.
    }
    return out;
  }
  // MediaPipe wants strictly increasing timestamps in VIDEO mode
  const ts = Math.max(state.lastTs + 1, Math.round(at));
  state.lastTs = ts;
  if (state.faceLm) {
    const fr = state.faceLm.detectForVideo(bitmap, ts);
    const L = fr?.faceLandmarks?.[0];
    if (L) {
      const mid = (p, q) => [(p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2];
      const a = L[468] ? [L[468].x, L[468].y, L[468].z] : mid(L[33], L[133]);   // iris centres when present
      const b = L[473] ? [L[473].x, L[473].y, L[473].z] : mid(L[362], L[263]);
      out.face = { eyes: [a, b], nose: L[1] ? [L[1].x, L[1].y, L[1].z] : null };
      if (state.tasks.mesh) out.face.mesh = packMesh(L);
    }
  }
  if (state.handLm) {
    const hr = state.handLm.detectForVideo(bitmap, ts);
    const hands = hr?.landmarks || [];
    for (let i = 0; i < Math.min(2, hands.length); i++) {
      out.hands.push({
        handedness: hr.handednesses?.[i]?.[0]?.categoryName || '?',
        score: hr.handednesses?.[i]?.[0]?.score ?? 0,
        lm: hands[i].map(p => [p.x, p.y, p.z]),
      });
    }
  }
  return out;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'init') {
    state.id = m.id ?? '?';
    state.tasks = { face: !!m.tasks?.face, hands: !!m.tasks?.hands, mesh: !!m.tasks?.mesh };
    state.detector = m.detector || 'auto';
    state.allowBlob = !!m.allowBlob;
    try {
      if (state.detector === 'blob') { if (!state.allowBlob) throw new Error('blob detector not allowed'); state.kind = 'blob'; }
      else await initMediapipe();
    } catch (err) {
      if (state.allowBlob) { state.kind = 'blob'; self.postMessage({ t: 'note', id: state.id, message: `MediaPipe failed (${err.message}); using the blob detector` }); }
      else { self.postMessage({ t: 'error', id: state.id, message: String(err?.message || err) }); return; }
    }
    self.postMessage({ t: 'ready', id: state.id, detector: state.kind, delegate: state.delegate });
    return;
  }
  if (m.t === 'stop') { try { state.faceLm?.close(); state.handLm?.close(); } catch {} self.close(); return; }
  if (m.t !== 'frame') return;
  // Second line of defence for the drop policy: the page keeps one frame in flight, but if one slips
  // through while inference is running (or before the models finished loading), throw it away rather than
  // let a queue of stale frames build up. Always answer, so the page's gate does not wedge shut.
  if (state.busy || !state.kind) {
    state.dropped++; m.bitmap?.close?.();
    self.postMessage({ t: 'drop', id: state.id, seq: m.seq, at: m.at, why: state.kind ? 'busy' : 'still loading' });
    return;
  }
  state.busy = true;
  const t0 = performance.now();
  let res = { face: null, hands: [] }, error = null;
  try { res = detect(m.bitmap, m.at); } catch (err) { error = String(err?.message || err); }
  m.bitmap?.close?.();
  state.busy = false; state.done++;
  self.postMessage({
    t: 'result', id: state.id, seq: m.seq, at: m.at, tookMs: performance.now() - t0,
    detector: state.kind, dropped: state.dropped, error, ...res,
  });
};
