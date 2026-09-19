// SPDX-License-Identifier: GPL-3.0-or-later
// Calibrating the hologram rig: the maths that ties the three frames together, and a small three-step UI.
//
//   1. the rig itself   - monitor size and pose, the acrylic sheet, where the model floats (live side view)
//   2. the head tracker - where the camera sits in the rig frame, so the webcam's eye estimate becomes a
//                         rig-frame eye for the off-axis projection
//   3. the hands        - "touch the marked spots": 4-6 targets floating under the sheet, the tracked
//                         fingertip recorded at each, then a similarity fit (Umeyama 1991, with the rotation
//                         from Horn's 1987 quaternion eigenvector - the same optimum, no SVD needed) from
//                         hand-tracker space to the rig frame, with the residual reported in millimetres.
//
// The maths here is pure and DOM-free (node --test imports it); only openCalibration() touches the page.

import { DEG, v3, add, sub, scale, dot, dist, makeRig, monitorRect, virtualScreen, planeOf,
         rigCheck, planeAxes, foldRig } from './geometry.js';

// ---------- 3x3 helpers (row-major, r*3+c) ----------
const m3mul = (a, b) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
export const m3apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
                                  m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
                                  m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
const m3T = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const Rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const Ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const Rz = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

// ---------- the head tracker ----------
// The tracker (public/js/input/webcam.js) reports points in the display frame: world = webcam + (-x, -y, z)
// of the camera's own frame, so the camera's axes there are x right -> -X, y down -> -Y, z forward -> +Z.
export const CAM_AXES = [-1, 0, 0, 0, -1, 0, 0, 0, 1];   // rig axes of a camera with yaw = pitch = roll = 0

// A tracker point (display-frame cm) back into the camera's own frame: x right in the image, y down, z forward.
export function cameraLocalFromTracker(p, webcam = [0, 0, 0], nudgeYCm = 0) {
  const q = v3(p), w = v3(webcam);
  return [-(q[0] - w[0]), -(q[1] - w[1] - nudgeYCm), q[2] - w[2]];
}
// Rotation rig <- camera. pitch is positive looking down, yaw positive turning toward +X, roll about the lens.
export function poseMatrix3(head) {
  if (head.R) return head.R.slice();
  return m3mul(m3mul(m3mul(Ry((head.yawDeg || 0) * DEG), Rx((head.pitchDeg || 0) * DEG)), CAM_AXES),
               Rz((head.rollDeg || 0) * DEG));
}
// The angles that reproduce a rotation matrix in that convention (for showing a fitted pose in the UI).
export function poseAngles(R) {
  const f = m3apply(R, [0, 0, 1]);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, -f[1]))) / DEG;
  const yawDeg = Math.atan2(f[0], f[2]) / DEG;
  const base = m3mul(m3mul(Ry(yawDeg * DEG), Rx(pitchDeg * DEG)), CAM_AXES);
  const down = m3apply(R, [0, 1, 0]);
  // the camera axes flip x and y, so a positive roll shows up as a negative turn of the image-down vector
  const rollDeg = -Math.atan2(dot(down, m3apply(base, [1, 0, 0])), dot(down, m3apply(base, [0, 1, 0]))) / DEG;
  return { yawDeg, pitchDeg, rollDeg };
}
// Camera-frame point -> rig frame.
export const applyPose = (head, local) =>
  add(m3apply(poseMatrix3(head), scale(v3(local), head.scale ?? 1)), v3(head.position));

// The eye the rig camera needs, from the tracker's display-frame eye.
export const trackerToRig = (rig, p, webcam = [0, 0, 0], nudgeYCm = 0) =>
  applyPose(rig.head, cameraLocalFromTracker(p, webcam, nudgeYCm));
// Hands use the fitted similarity when there is one (it also absorbs the palm-size depth bias), else the pose.
export const handToRig = (rig, p, webcam = [0, 0, 0]) =>
  rig.hand && rig.hand.fit ? applyFit(rig.hand.fit, p) : trackerToRig(rig, p, webcam);

// ---------- similarity fit ----------
// Cyclic Jacobi eigen-decomposition of a small symmetric matrix (row-major n*n).
// Returns eigenvalues and eigenvectors (column j = vectors[k*n + j]).
function jacobiEigen(A, n) {
  const a = A.slice(), v = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-26) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p * n + q]) < 1e-18) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * a[p * n + q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {                       // A <- J^T A J, column then row
        const kp = a[k * n + p], kq = a[k * n + q];
        a[k * n + p] = c * kp - s * kq; a[k * n + q] = s * kp + c * kq;
      }
      for (let k = 0; k < n; k++) {
        const pk = a[p * n + k], qk = a[q * n + k];
        a[p * n + k] = c * pk - s * qk; a[q * n + k] = s * pk + c * qk;
      }
      for (let k = 0; k < n; k++) {
        const kp = v[k * n + p], kq = v[k * n + q];
        v[k * n + p] = c * kp - s * kq; v[k * n + q] = s * kp + c * kq;
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: v };
}

// Least-squares similarity dst ~= s * R * src + t over point pairs (Umeyama). withScale false gives a rigid
// fit (Kabsch). Residuals are reported in millimetres because that is the number that decides whether
// touching a floating target feels right.
export function fitSimilarity(src, dst, { withScale = true } = {}) {
  const P = src.map(v3), Q = dst.map(v3), n = P.length;
  if (n < 3 || Q.length !== n) throw new Error('fitSimilarity needs at least 3 matching pairs');
  const mean = (a) => scale(a.reduce(add, [0, 0, 0]), 1 / a.length);
  const mp = mean(P), mq = mean(Q);
  const p = P.map((x) => sub(x, mp)), q = Q.map((x) => sub(x, mq));
  const S = new Array(9).fill(0);                    // S[a*3+b] = sum src_a * dst_b
  let varP = 0;
  for (let i = 0; i < n; i++) {
    varP += dot(p[i], p[i]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += p[i][a] * q[i][b];
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz];
  const { values, vectors } = jacobiEigen(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  let [w, x, y, z] = [vectors[best], vectors[4 + best], vectors[8 + best], vectors[12 + best]];
  const ql = Math.hypot(w, x, y, z) || 1;
  w /= ql; x /= ql; y /= ql; z /= ql;
  const R = [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
             2 * (y * x + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
             2 * (z * x - w * y), 2 * (z * y + w * x), w * w - x * x - y * y + z * z];
  let s = 1;
  if (withScale && varP > 1e-12) {
    let num = 0;
    for (let i = 0; i < n; i++) num += dot(q[i], m3apply(R, p[i]));
    s = num / varP;
  }
  const t = sub(mq, scale(m3apply(R, mp), s));
  const fit = { s, R, t, quat: [x, y, z, w], n };
  const residualsMm = P.map((pt, i) => dist(applyFit(fit, pt), Q[i]) * 10);
  fit.residualsMm = residualsMm;
  fit.rmsMm = Math.sqrt(residualsMm.reduce((a, b) => a + b * b, 0) / n);
  fit.maxMm = Math.max(...residualsMm);
  return fit;
}
export const applyFit = (fit, p) => add(scale(m3apply(fit.R, v3(p)), fit.s), fit.t);
export const invertFit = (fit) => {                       // rig -> tracker, for drawing targets in tracker space
  const Rt = m3T(fit.R), s = 1 / fit.s;
  return { s, R: Rt, t: scale(m3apply(Rt, fit.t), -s) };
};
// Column-major 16 for THREE.Matrix4.fromArray, so a whole Object3D can be moved into the rig frame.
export const fitMatrix = (fit) => {
  const { R, s, t } = fit;
  return [R[0] * s, R[3] * s, R[6] * s, 0, R[1] * s, R[4] * s, R[7] * s, 0,
          R[2] * s, R[5] * s, R[8] * s, 0, t[0], t[1], t[2], 1];
};
// The head-tracker pose implied by a hand fit, when the same camera tracks both (rig = s*Rf*tracker + tf and
// tracker = webcam + CAM_AXES * local, so the camera sits at s*Rf*webcam + tf with rotation Rf * CAM_AXES).
export function poseFromHandFit(fit, webcam = [0, 0, 0]) {
  const R = m3mul(fit.R, CAM_AXES);
  return { position: add(scale(m3apply(fit.R, v3(webcam)), fit.s), fit.t), R, scale: fit.s, ...poseAngles(R) };
}

// ---------- targets to touch ----------
// 4-6 spots around the model anchor, ordered so that any prefix of 4 is non-coplanar (a flat set would leave
// the fit free to rotate about that plane).
export function defaultTargets(rig, n = 5) {
  const r = Math.max(5, (rig.model.fitCm || 18) * 0.45), a = v3(rig.model.anchor);
  const offs = [[-r, 0, 0], [r, 0, 0], [0, r * 0.7, 0], [0, 0, r], [0, -r * 0.7, 0], [0, 0, -r]];
  return offs.slice(0, Math.max(4, Math.min(6, n))).map((o) => add(a, o));
}

// ---------- settings ----------
export const RIG_KEY = 'holo-rig';
export function loadRig(key = RIG_KEY) {
  try { return makeRig(JSON.parse(localStorage.getItem(key) || '{}')); }
  catch (e) { return makeRig(); }
}
export function saveRig(rig, key = RIG_KEY) {
  try { localStorage.setItem(key, JSON.stringify(rig)); return true; } catch (e) { return false; }
}
export function clearRig(key = RIG_KEY) { try { localStorage.removeItem(key); } catch (e) {} }

// ---------- side-view diagram ----------
// Looking along -X: +Z to the right (the viewer's side), +Y up. Pure 2D canvas, no three.js, so the
// calibration panel works before any scene exists.
export function drawSideView(ctx, rig, eyeRig = null, opts = {}) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const pts = [];
  const mon = monitorRect(rig.monitor), vs = virtualScreen(rig);
  const sheetAx = planeAxes(planeOf(rig.sheet)), sp = v3(rig.sheet.point);
  for (const r of [mon, vs]) pts.push(r.tl, r.tr, r.br, r.bl);
  pts.push(v3(rig.model.anchor), add(sp, scale(sheetAx.v, rig.sheet.depthCm / 2)), add(sp, scale(sheetAx.v, -rig.sheet.depthCm / 2)));
  if (rig.fold) { const f = v3(rig.fold.point); pts.push(f); }
  if (eyeRig) pts.push(v3(eyeRig));
  let zmin = 1e9, zmax = -1e9, ymin = 1e9, ymax = -1e9;
  for (const p of pts) { zmin = Math.min(zmin, p[2]); zmax = Math.max(zmax, p[2]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const pad = 14, sc = Math.min((w - 2 * pad) / Math.max(zmax - zmin, 1), (h - 2 * pad) / Math.max(ymax - ymin, 1));
  const X = (p) => pad + (p[2] - zmin) * sc, Y = (p) => h - pad - (p[1] - ymin) * sc;
  const line = (a, b, style, dash = []) => {
    ctx.save(); ctx.strokeStyle = style; ctx.setLineDash(dash); ctx.beginPath();
    ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); ctx.restore();
  };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = opts.background || '#0a0e16'; ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 2;
  line(add(sp, scale(sheetAx.v, -rig.sheet.depthCm / 2)), add(sp, scale(sheetAx.v, rig.sheet.depthCm / 2)), '#7fd4ff');
  if (rig.fold) {
    const fa = planeAxes(planeOf(rig.fold)), fp = v3(rig.fold.point);
    line(add(fp, scale(fa.v, -rig.fold.heightCm / 2)), add(fp, scale(fa.v, rig.fold.heightCm / 2)), '#c0c8d8', [6, 4]);
  }
  line(mon.tl, mon.bl, '#ffd479');                       // the monitor, edge on
  line(vs.tl, vs.bl, '#ff9bd2', [5, 4]);                 // its reflection: the virtual screen
  if (eyeRig) {
    const eye = v3(eyeRig);
    for (const c of [vs.tl, vs.bl]) line(eye, c, 'rgba(255,155,210,0.45)');
    const chk = rigCheck(rig, eye);
    for (const hit of chk.sheetHits) line(eye, hit, 'rgba(127,212,255,0.25)');
    ctx.fillStyle = '#7cff9b'; ctx.beginPath(); ctx.arc(X(eye), Y(eye), 5, 0, 7); ctx.fill();
  }
  const a = v3(rig.model.anchor), rr = (rig.model.fitCm || 18) / 2;
  ctx.strokeStyle = '#ffffff'; ctx.setLineDash([]); ctx.strokeRect(X([0, a[1] + rr, a[2] - rr]), Y([0, a[1] + rr, a[2] - rr]), rr * 2 * sc, rr * 2 * sc);
  ctx.fillStyle = '#8a97ad'; ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('monitor', X(mon.centre) - 20, Y(mon.centre) - 6);
  ctx.fillText('sheet', X(sp) + 4, Y(sp) - 6);
  ctx.fillText('image', X(vs.centre) - 16, Y(vs.centre) + 12);
  ctx.fillText('model', X(a) - 16, Y(a) - rr * sc - 4);
  return { X, Y, scale: sc };
}

// ---------- the panel ----------
const FIELDS = [
  ['monitor.widthCm', 'screen width cm', 0.1], ['monitor.heightCm', 'screen height cm', 0.1],
  ['monitor.pixelW', 'pixels across', 1], ['monitor.pixelH', 'pixels down', 1],
  ['monitor.centre.0', 'monitor x cm', 0.5], ['monitor.centre.1', 'monitor height cm', 0.5],
  ['monitor.centre.2', 'monitor z cm', 0.5],
  ['monitor.tiltDeg', 'tilt deg (0 = faces down)', 1], ['monitor.yawDeg', 'yaw deg', 1],
  ['sheet.point.1', 'sheet height cm', 0.5], ['sheet.widthCm', 'sheet width cm', 1], ['sheet.depthCm', 'sheet depth cm', 1],
  ['model.anchor.1', 'model floats at y cm', 0.5], ['model.anchor.2', 'model z cm', 0.5], ['model.fitCm', 'model size cm', 0.5],
];
const HEAD_FIELDS = [
  ['head.position.0', 'camera x cm', 0.5], ['head.position.1', 'camera y cm', 0.5], ['head.position.2', 'camera z cm', 0.5],
  ['head.yawDeg', 'camera yaw deg', 1], ['head.pitchDeg', 'camera pitch deg (+ looks down)', 1],
  ['head.rollDeg', 'camera roll deg', 1], ['head.scale', 'tracker scale', 0.01],
];
const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const setPath = (o, path, val) => {
  const ks = path.split('.'), last = ks.pop();
  ks.reduce((v, k) => v[k], o)[last] = val;
};

const CSS = `
.rigcal{position:fixed;top:12px;right:12px;width:340px;max-height:calc(100vh - 24px);overflow:auto;z-index:60;
  background:#0d1118f2;color:#dbe3f0;font:12px/1.45 system-ui,sans-serif;border:1px solid #2a3547;border-radius:10px;padding:10px 12px}
.rigcal h3{margin:0 0 6px;font-size:13px;letter-spacing:.02em}
.rigcal .tabs{display:flex;gap:4px;margin-bottom:8px}
.rigcal .tabs button{flex:1;padding:4px 2px;background:#18202e;color:#9fb0c8;border:1px solid #2a3547;border-radius:6px;cursor:pointer}
.rigcal .tabs button[aria-selected=true]{background:#1d4b6b;color:#eaf4ff}
.rigcal label{display:flex;justify-content:space-between;align-items:center;gap:6px;margin:2px 0}
.rigcal input[type=number]{width:84px;background:#131a26;color:#dbe3f0;border:1px solid #2a3547;border-radius:4px;padding:2px 4px}
.rigcal textarea{width:100%;height:56px;margin-top:6px;background:#131a26;color:#dbe3f0;border:1px solid #2a3547;border-radius:4px;
  padding:3px 4px;font:11px/1.4 ui-monospace,monospace;resize:vertical}
.rigcal canvas{width:100%;height:190px;border:1px solid #2a3547;border-radius:6px;margin:6px 0;display:block}
.rigcal button.act{padding:5px 9px;background:#1d4b6b;color:#eaf4ff;border:0;border-radius:6px;cursor:pointer;margin:2px 4px 2px 0}
.rigcal .warn{color:#ffb23e;margin:4px 0}
.rigcal .ok{color:#7cff9b}
.rigcal ol{padding-left:18px;margin:4px 0}
.rigcal li.active{color:#ffd479;font-weight:600}
.rigcal .muted{color:#8a97ad}`;

// openCalibration({ mount, rig, getTip, getEye, webcam, onChange, onTargets, onClose })
//   getTip()  -> the tracked fingertip in hand-tracker space ([x,y,z] cm) or null
//   getEye()  -> the tracked eye in tracker space, for the live readout
//   onTargets(points, activeIndex) -> the rig renderer draws these spots floating under the sheet
//   onChange(rig) -> the rig changed (re-render, re-place the model)
// Call ctrl.tick() once a frame while step 3 is open; it does the dwell detection and auto-capture.
export function openCalibration(opts = {}) {
  const mount = opts.mount || document.body;
  const rig = opts.rig || loadRig();
  const webcam = opts.webcam || [0, 0, 0];
  const onChange = opts.onChange || (() => {});
  const onTargets = opts.onTargets || (() => {});
  if (!document.getElementById('rigcal-css')) {
    const st = document.createElement('style'); st.id = 'rigcal-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.className = 'rigcal';
  el.innerHTML = `<h3>Rig calibration</h3>
    <div class="tabs"><button data-s="0">1 rig</button><button data-s="1">2 head</button><button data-s="2">3 hands</button></div>
    <div class="body"></div>
    <div style="margin-top:8px"><button class="act" data-do="save">save</button>
      <button class="act" data-do="close">close</button><span class="msg muted"></span></div>`;
  mount.appendChild(el);
  const body = el.querySelector('.body'), msg = el.querySelector('.msg');

  let step = 0, targets = defaultTargets(rig), captures = [], active = 0, samples = [], dwellSince = 0;
  let plainMonitor = rig.fold ? null : rig.monitor;   // the un-folded monitor, kept so the fold toggle is reversible

  const numberRow = (path, label, stepSize) => {
    const row = document.createElement('label');
    row.innerHTML = `<span class="muted">${label}</span>`;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = stepSize; inp.value = getPath(rig, path);
    inp.oninput = () => { setPath(rig, path, parseFloat(inp.value) || 0); refresh(); onChange(rig); };
    row.appendChild(inp);
    return row;
  };
  // a field that is not stored directly on the rig (an angle standing in for a plane normal, say)
  const derivedRow = (label, stepSize, get, set) => {
    const row = document.createElement('label');
    row.innerHTML = `<span class="muted">${label}</span>`;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = stepSize; inp.value = (+get()).toFixed(2).replace(/\.?0+$/, '');
    inp.oninput = () => { set(parseFloat(inp.value) || 0); refresh(); onChange(rig); };
    row.appendChild(inp);
    return row;
  };
  const diagram = document.createElement('canvas');
  diagram.width = 316; diagram.height = 190;

  function render() {
    body.innerHTML = '';
    el.querySelectorAll('.tabs button').forEach((b, i) => b.setAttribute('aria-selected', String(i === step)));
    if (step === 0) {
      for (const [p, l, s] of FIELDS) body.appendChild(numberRow(p, l, s));
      // the sheet may be any plane; the one number worth exposing is its tilt about X
      body.appendChild(derivedRow('sheet tilt deg', 1,
        () => Math.atan2(rig.sheet.normal[2], rig.sheet.normal[1]) / DEG,
        (v) => { rig.sheet.normal = [0, Math.cos(v * DEG), Math.sin(v * DEG)]; }));
      // or skip the numbers above and give four measured corners
      const ta = document.createElement('textarea');
      ta.placeholder = 'or 4 measured corners, one "x y z" per line: top-left, top-right, bottom-right, bottom-left';
      ta.value = rig.monitor.corners ? ['tl', 'tr', 'br', 'bl'].map((k) => rig.monitor.corners[k].map((n) => n.toFixed(1)).join(' ')).join('\n') : '';
      ta.onchange = () => {
        const rows = ta.value.trim().split(/\n+/).map((r) => r.trim().split(/[\s,]+/).map(Number))
          .filter((r) => r.length === 3 && r.every(Number.isFinite));
        if (rows.length === 4) {
          rig.monitor.corners = { tl: rows[0], tr: rows[1], br: rows[2], bl: rows[3] };
          msg.textContent = `corners fit a rectangle to ${(monitorRect(rig.monitor).fitErrorCm * 10).toFixed(1)} mm`;
        } else if (!ta.value.trim()) { rig.monitor.corners = null; msg.textContent = 'using the sizes above'; }
        else { msg.textContent = 'needs 4 lines of x y z'; return; }
        render(); onChange(rig);
      };
      body.appendChild(ta);
      const fold = document.createElement('label');
      fold.innerHTML = '<span class="muted">fold mirror (monitor below, no flip)</span>';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!rig.fold;
      cb.onchange = () => {
        // Folding keeps the same virtual screen, so nothing else in the rig has to change.
        if (cb.checked) { plainMonitor = rig.monitor; const f = foldRig(rig); rig.fold = f.fold; rig.monitor = f.monitor; }
        else { rig.fold = null; rig.monitor = plainMonitor || { ...rig.monitor, corners: null }; }
        render(); onChange(rig);
      };
      fold.appendChild(cb); body.appendChild(fold);
      body.appendChild(diagram);
      const note = document.createElement('div'); note.className = 'checks'; body.appendChild(note);
    } else if (step === 1) {
      for (const [p, l, s] of HEAD_FIELDS) body.appendChild(numberRow(p, l, s));
      const b = document.createElement('button');
      b.className = 'act'; b.textContent = 'copy from hand fit';
      b.onclick = () => {
        if (!rig.hand.fit) return void (msg.textContent = 'fit the hands first');
        Object.assign(rig.head, poseFromHandFit(rig.hand.fit, webcam));
        render(); onChange(rig); msg.textContent = 'head pose taken from the hand fit';
      };
      body.appendChild(b);
      body.appendChild(Object.assign(document.createElement('div'), { className: 'eyeread muted' }));
      body.appendChild(diagram);
    } else {
      const ol = document.createElement('ol');
      targets.forEach((t, i) => {
        const li = document.createElement('li');
        li.className = i === active ? 'active' : '';
        li.textContent = `(${t.map((n) => n.toFixed(1)).join(', ')}) ${captures[i] ? 'captured' : ''}`;
        li.onclick = () => { active = i; onTargets(targets, active); render(); };
        ol.appendChild(li);
      });
      body.appendChild(ol);
      body.appendChild(Object.assign(document.createElement('div'), { className: 'tipread muted' }));
      const cap = document.createElement('button'); cap.className = 'act'; cap.textContent = 'capture (space)';
      cap.onclick = () => capture();
      const again = document.createElement('button'); again.className = 'act'; again.textContent = 'start over';
      again.onclick = () => { captures = []; active = 0; targets = defaultTargets(rig); onTargets(targets, active); render(); };
      const fitb = document.createElement('button'); fitb.className = 'act'; fitb.textContent = 'fit';
      fitb.onclick = () => doFit();
      body.append(cap, fitb, again);
      body.appendChild(Object.assign(document.createElement('div'), { className: 'fitread' }));
      onTargets(targets, active);
    }
    refresh();
  }

  function refresh() {
    if (step === 2) {
      const f = rig.hand.fit;
      const out = body.querySelector('.fitread');
      if (out) out.innerHTML = f
        ? `<span class="${f.maxMm <= 15 ? 'ok' : 'warn'}">fit: rms ${f.rmsMm.toFixed(1)} mm, worst ${f.maxMm.toFixed(1)} mm, scale ${f.s.toFixed(3)} (${f.n} points)</span>`
        : '<span class="muted">no fit yet</span>';
      return;
    }
    const ctx = diagram.getContext('2d');
    const eye = opts.getEye ? safeEye() : null;
    drawSideView(ctx, rig, eye || [0, 40, 40]);
    const checks = body.querySelector('.checks');
    if (checks) {
      const c = rigCheck(rig, eye || [0, 40, 40]);
      checks.innerHTML = c.ok ? '<span class="ok">geometry looks usable</span>'
                              : c.warnings.map((w) => `<div class="warn">${w}</div>`).join('');
    }
    const read = body.querySelector('.eyeread');
    if (read) {
      const e = eye;
      read.textContent = e ? `tracked eye in rig: ${e.map((n) => n.toFixed(1)).join(', ')} cm`
                           : 'no face tracked';
    }
  }
  const safeEye = () => {
    const raw = opts.getEye && opts.getEye();
    return raw ? trackerToRig(rig, raw, webcam) : null;
  };

  function capture() {
    if (!samples.length) { msg.textContent = 'no fingertip'; return; }
    const recent = samples.slice(-10);
    captures[active] = scale(recent.reduce((a, s) => add(a, s.p), [0, 0, 0]), 1 / recent.length);
    samples = [];
    if (active < targets.length - 1) active++;
    else if (captures.filter(Boolean).length >= 3) doFit();
    onTargets(targets, active);
    render();
  }
  function doFit() {
    const src = [], dst = [];
    captures.forEach((c, i) => { if (c) { src.push(c); dst.push(targets[i]); } });
    if (src.length < 3) { msg.textContent = 'need at least 3 captured spots'; return; }
    rig.hand.fit = fitSimilarity(src, dst);
    rig.hand.rmsMm = rig.hand.fit.rmsMm; rig.hand.maxMm = rig.hand.fit.maxMm;
    rig.hand.capturedAt = Date.now();
    onChange(rig); render();
  }

  const onKey = (e) => { if (step === 2 && e.code === 'Space') { e.preventDefault(); capture(); } };
  addEventListener('keydown', onKey);
  el.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => { step = +b.dataset.s; render(); });
  el.querySelector('[data-do=save]').onclick = () => { msg.textContent = saveRig(rig) ? 'saved' : 'could not save'; };
  el.querySelector('[data-do=close]').onclick = () => ctrl.close();

  const ctrl = {
    el, rig, get step() { return step; }, setStep(n) { step = n; render(); },
    get targets() { return targets; }, get captures() { return captures; },
    capture, fit: doFit,
    // Called every frame: keeps a short history of the fingertip and auto-captures when it holds still.
    tick(now = performance.now()) {
      if (step !== 2 || !opts.getTip) return;
      const p = opts.getTip();
      const read = body.querySelector('.tipread');
      if (!p) { samples = []; dwellSince = 0; if (read) read.textContent = 'no fingertip tracked'; return; }
      samples.push({ t: now, p: v3(p) });
      while (samples.length > 60) samples.shift();
      const old = samples.find((s) => now - s.t < 500) || samples[0];
      const moved = dist(old.p, v3(p));
      if (moved < 0.6 && samples.length > 6) { if (!dwellSince) dwellSince = now; }
      else dwellSince = 0;
      if (read) read.textContent = `fingertip ${v3(p).map((n) => n.toFixed(1)).join(', ')} - ${dwellSince ? 'holding ' + Math.round(now - dwellSince) + ' ms' : 'move to the spot and hold still'}`;
      if (dwellSince && now - dwellSince > 900) { dwellSince = 0; capture(); }
    },
    close() { removeEventListener('keydown', onKey); el.remove(); onTargets([], -1); (opts.onClose || (() => {}))(); },
  };
  render();
  return ctrl;
}
