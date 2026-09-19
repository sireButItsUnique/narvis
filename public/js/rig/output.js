// SPDX-License-Identifier: GPL-3.0-or-later
// Rig output mode: what the page does when it is driving the hologram rig instead of the desktop window.
// Pure black background (plain acrylic reflects 4-5%, so black is transparent and only bright pixels become
// hologram), no HUD, the off-axis rig camera, fullscreen on the rig monitor, and a test pattern for lining
// the physical parts up.
//
// INTEGRATION (this is the whole contract with view.js / main.js; nothing here edits them):
//
//   import { RigView } from './rig/output.js';
//   import { views, renderer, canvas, scene, camera } from './view.js';
//
//   const rigView = new RigView({ renderer, canvas, scene });   // rig comes from localStorage
//   rigView.enter();                                            // black, HUD hidden, canvas flipped
//   views.length = 0;
//   views.push({ camera: rigView.camera, viewport: null });      // the views[] loop renders the rig view
//   rigView.placeModel(modelRoot);                               // model floats under the sheet, in cm
//   // once per frame, before renderViews():
//   rigView.update(input.eye);                                   // tracker-space eye -> rig camera
//   // hands, for interaction.js, converted the same way:
//   const tipRig = rigView.handToRig(input.hands[0].tip);
//   // leaving:
//   rigView.exit(); views.length = 0; views.push({ camera, viewport: null });
//
// The scene's world frame IS the rig frame in this mode (centimetres, origin at the sheet centre), which is
// why placeModel() moves the model rather than the camera. For a scene that must stay in its own frame,
// pass the rig-to-world matrix as the second argument of applyRigCamera() instead.

import * as THREE from 'three';
import { rigCamera, applyRigCamera, modelRigMatrix, virtualScreen, rectPoint, rigCheck, DEFAULT_EYE }
  from './geometry.js';
import { loadRig, trackerToRig, handToRig } from './calibrate.js';

const BLACK = new THREE.Color(0x000000);

export class RigView {
  // { rig, renderer, canvas, scene,
  //   webcam: the tracker camera's position in the display frame (view.js webcamPos()),
  //   hide: elements or selectors to hide instead of the automatic list,
  //   keep: one element that must stay visible (the calibration panel, say),
  //   assumeFullscreen: the canvas IS the whole panel, so skip the window-position viewport }
  constructor(opts = {}) {
    this.opts = opts;
    this.rig = opts.rig || loadRig();
    this.renderer = opts.renderer;
    this.canvas = opts.canvas || opts.renderer?.domElement;
    this.scene = opts.scene;
    this.webcam = opts.webcam || [0, 0, 0];
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.eyeRig = DEFAULT_EYE.slice();
    this.rc = rigCamera(this.rig, this.eyeRig);
    this.active = false;
    this.group = new THREE.Group();          // everything rig mode adds to the scene, in rig coordinates
    this.group.name = 'rig-overlay';
    this.scene?.add(this.group);             // empty until a test pattern or targets are asked for
    this.targets = [];
    this._saved = null;
    this._flip = '';
  }

  // ---------- frames ----------
  setRig(rig) { this.rig = rig; this.update(); this.refreshPattern(); return this; }
  // Tracker-space (what input/state.js holds) -> rig frame.
  eyeToRig(p) { return trackerToRig(this.rig, p, this.webcam); }
  handToRig(p) { return handToRig(this.rig, p, this.webcam); }

  // Once a frame. `eye` is the tracked eye in tracker space, or null to keep the last one; pass
  // { rigFrame: true } if it is already in rig coordinates (a Kinect calibrated straight into the rig).
  update(eye = null, { rigFrame = false } = {}) {
    if (eye) this.eyeRig = rigFrame ? [eye.x ?? eye[0], eye.y ?? eye[1], eye.z ?? eye[2]] : this.eyeToRig(eye);
    this.rc = rigCamera(this.rig, this.eyeRig, { viewport: this.canvasViewport() });
    applyRigCamera(this.camera, this.rc);
    if (this.active) this.applyFlip();
    return this.rc;
  }

  // Which part of the monitor the canvas covers, as pixel fractions: null (the whole panel) when we are
  // fullscreen on it, otherwise an estimate from the window position, like view.js does for the desktop.
  // Pass assumeFullscreen when the canvas is not the panel at all (an offscreen target, or a simulation).
  canvasViewport() {
    if (typeof window === 'undefined' || !this.canvas) return null;
    if (this.opts.assumeFullscreen) return null;
    if (document.fullscreenElement) return null;
    const sw = screen.width, sh = screen.height;
    const border = Math.max(0, (outerWidth - innerWidth) / 2);
    const left = (screenX - (screen.availLeft || 0)) + border;
    const top = (screenY - (screen.availTop || 0)) + Math.max(0, outerHeight - innerHeight - border);
    const r = this.canvas.getBoundingClientRect();
    const vp = { u0: (left + r.left) / sw, v0: (top + r.top) / sh,
                 u1: (left + r.right) / sw, v1: (top + r.bottom) / sh };
    return (vp.u1 - vp.u0 > 0.02 && vp.v1 - vp.v0 > 0.02) ? vp : null;
  }

  // ---------- the model ----------
  // Put a loaded model's display root under the sheet at the rig anchor. The root must hang directly off
  // the scene (rig mode makes the world frame the rig frame).
  placeModel(root) {
    if (!root) return null;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return null;
    box.applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());   // -> the root's own frame
    const m = modelRigMatrix(this.rig, { min: box.min.toArray(), max: box.max.toArray() });
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(m);
    root.matrix.decompose(root.position, root.quaternion, root.scale);
    root.updateMatrixWorld(true);
    return m;
  }

  // ---------- entering and leaving ----------
  enter() {
    if (this.active) return this;
    this.active = true;
    const style = this.canvas?.style;
    this._saved = {
      background: this.scene?.background, clear: this.renderer?.getClearColor(new THREE.Color()).clone(),
      alpha: this.renderer?.getClearAlpha?.(), transform: style?.transform || '', hidden: [],
    };
    if (this.scene) { this.scene.background = BLACK; }
    this.renderer?.setClearColor(0x000000, 1);
    for (const el of this.hideList()) {
      this._saved.hidden.push([el, el.style.visibility]);
      el.style.visibility = 'hidden';
    }
    this.applyFlip();
    this.refreshPattern();
    return this;
  }
  exit() {
    if (!this.active) return this;
    this.active = false;
    if (this.scene) this.scene.background = this._saved.background ?? null;
    if (this._saved.clear) this.renderer?.setClearColor(this._saved.clear, this._saved.alpha ?? 1);
    for (const [el, vis] of this._saved.hidden) el.style.visibility = vis;
    if (this.canvas) this.canvas.style.transform = this._saved.transform;
    this._flip = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return this;
  }
  // Everything on the page except the canvas: in rig mode the panel may only show the hologram. Walking up
  // from the canvas and hiding each level's other children keeps the canvas's own ancestors visible, however
  // deeply the page nests it.
  hideList() {
    if (this.opts.hide) return [...this.opts.hide].map((h) => typeof h === 'string' ? document.querySelectorAll(h) : [h]).flatMap((n) => [...n]);
    if (typeof document === 'undefined' || !this.canvas) return [];
    const out = [];
    for (let node = this.canvas; node && node.parentElement && node !== document.body; node = node.parentElement)
      for (const sib of node.parentElement.children)
        if (sib !== node && sib !== this.opts.keep && !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(sib.tagName)) out.push(sib);
    return out;
  }
  // One reflection mirrors the picture, so the canvas is flipped on its way to the panel. Doing it in CSS
  // costs nothing and, unlike negating a column of the projection matrix, does not invert face winding.
  applyFlip() {
    if (!this.canvas) return;
    const t = this.rc.flipX ? 'scaleX(-1)' : this.rc.flipY ? 'scaleY(-1)' : '';
    if (t !== this._flip) { this.canvas.style.transform = t; this._flip = t; }
  }

  // Fullscreen on the rig monitor. Must be called from a click or key press. Resolves to
  // { ok, screen } or { ok: false, message } with what to do by hand instead.
  async goFullscreen(el = this.canvas) {
    const target = el || document.documentElement;
    try {
      if (typeof window !== 'undefined' && 'getScreenDetails' in window) {
        const details = await window.getScreenDetails();
        const want = this.rig.output?.screenLabel;
        const screenObj = details.screens.find((s) => s.label === want)
          || details.screens.find((s) => !s.isPrimary) || details.currentScreen;
        await target.requestFullscreen({ screen: screenObj, navigationUI: 'hide' });
        return { ok: true, screen: screenObj.label || '(unnamed)' };
      }
      await target.requestFullscreen();
      return { ok: true, screen: null, message: 'No Window Management API: this went fullscreen on the current screen. Drag the window to the rig monitor first if it is not there.' };
    } catch (e) {
      return { ok: false, message: `Could not open the rig monitor automatically (${e.message}). Drag this window onto the rig monitor and press F11.` };
    }
  }

  // ---------- test pattern ----------
  // A grid drawn ON the virtual screen plane plus a cube floating at a known spot. Points on the virtual
  // screen project to themselves whatever the eye does, so the grid's border must line up with the physical
  // edges of the panel: if it does not, the screen size, pixel count or canvas coverage is wrong. The cube
  // must instead stay nailed in space as you move your head, and your fingertip must be able to touch it.
  setTestPattern(on) { this.pattern = !!on; this.refreshPattern(); return this; }
  refreshPattern() {
    this.group.clear();
    if (this.pattern) this.group.add(makeTestPattern(this.rig));
    if (this.targets.length) this.group.add(makeTargets(this.rig, this.targets, this.activeTarget));
  }
  // The spots the calibration step asks the user to touch, drawn floating under the sheet.
  setTargets(points, active = -1) { this.targets = points || []; this.activeTarget = active; this.refreshPattern(); return this; }

  check() { return rigCheck(this.rig, this.eyeRig); }
  dispose() { this.exit(); this.group.removeFromParent(); this.group.clear(); }
}

const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });

export function makeTestPattern(rig, { divisions = 12 } = {}) {
  const g = new THREE.Group();
  g.name = 'rig-test-pattern';
  const V = virtualScreen(rig);
  const P = (u, v) => new THREE.Vector3(...rectPoint(V, u, v));

  const grid = [], rows = Math.max(2, Math.round(divisions * V.heightCm / V.widthCm));
  for (let i = 1; i < divisions; i++) grid.push(P(i / divisions, 0), P(i / divisions, 1));
  for (let j = 1; j < rows; j++) grid.push(P(0, j / rows), P(1, j / rows));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), lineMat(0x1b6f8c)));
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([P(0.002, 0.004), P(0.998, 0.004), P(0.998, 0.996), P(0.002, 0.996)]),
                           lineMat(0x35d0ff)));
  // corner ticks: the first pixel column and row, so a mirrored image is obvious at a glance
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([P(0.01, 0.01), P(0.14, 0.01), P(0.01, 0.01), P(0.01, 0.1)]),
                               lineMat(0xffd479)));

  // a 10 cm wireframe cube floating at the model anchor, with its corners marked
  const a = new THREE.Vector3(...rig.model.anchor), s = 5;
  const cube = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s * 2, s * 2, s * 2)), lineMat(0x7cff9b));
  cube.position.copy(a);
  g.add(cube);
  const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(
    [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
      .map(([x, y, z]) => new THREE.Vector3(a.x + x * s, a.y + y * s, a.z + z * s))),
    new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false, toneMapped: false }));
  g.add(dots);
  // a plumb line from the sheet down to the anchor: it should look vertical from any head position
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, 0, a.z), a.clone()]), lineMat(0x2a5a7a)));
  return g;
}

export function makeTargets(rig, points, active = -1) {
  const g = new THREE.Group();
  g.name = 'rig-targets';
  points.forEach((p, i) => {
    const on = i === active;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(on ? 1.3 : 0.9, on ? 0.16 : 0.08, 8, 32),
      new THREE.MeshBasicMaterial({ color: on ? 0xffd479 : 0x3a6b8c, toneMapped: false }));
    ring.position.set(...p);
    const ring2 = ring.clone(); ring2.rotation.x = Math.PI / 2;
    const ring3 = ring.clone(); ring3.rotation.y = Math.PI / 2;
    g.add(ring, ring2, ring3);
  });
  return g;
}

// A short overlay telling the user how to get the page onto the rig monitor when the Window Management API
// is not available (or was refused). Returns the element so the caller can remove it.
export function fullscreenInstructions(message, mount = document.body) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:70;max-width:420px;' +
    'background:#0d1118f2;color:#dbe3f0;font:13px/1.5 system-ui,sans-serif;border:1px solid #2a3547;border-radius:10px;padding:14px 16px';
  el.innerHTML = `<b>Rig monitor</b><p style="margin:6px 0">${message}</p>
    <ol style="padding-left:18px;margin:6px 0"><li>Drag this window onto the monitor above the sheet.</li>
    <li>Press F11 (or click below) for fullscreen.</li><li>Turn the room lights down.</li></ol>`;
  const b = document.createElement('button');
  b.textContent = 'fullscreen here';
  b.style.cssText = 'padding:5px 9px;background:#1d4b6b;color:#eaf4ff;border:0;border-radius:6px;cursor:pointer';
  b.onclick = () => { document.documentElement.requestFullscreen().catch(() => {}); el.remove(); };
  el.appendChild(b);
  mount.appendChild(el);
  return el;
}
