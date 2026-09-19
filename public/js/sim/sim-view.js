// The simulator's picture: a three.js view of the whole rig, the cameras and what they can see, the truth
// and what the solver recovered from it, plus the portrait panel and a coverage map.
//
// Everything numeric lives in rig-sim.js; this file only draws it and wires the controls, so the page and
// the tests are measuring exactly the same code.

import { DEFAULT_RIG, LAYOUTS, rigGeometry, makeZed, truthAt, handPose,
         eyePoints, synthesizeView, runSession, coverageSlice, offAxisFrustum, parallaxGain,
         compareLayouts, ZED_RANGE_MM } from './rig-sim.js';
import { Tracker } from '../track/solve.js';
import { HAND, HAND_BONES } from '../track/landmarks.js';
import { add, scale, cross, dist, mulberry32 } from '../track/linalg.js';

// three is loaded at run time: the local vendored copy if `npm run vendor` has been run, the CDN otherwise.
// A dynamic import means the page needs no import map and still works either way.
const THREE_SOURCES = ['/vendor/three/three.module.js',
                       'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js'];
export async function loadThree(sources = THREE_SOURCES) {
  let last;
  for (const url of sources) {
    try { return await import(/* @vite-ignore */ url); } catch (e) { last = e; }
  }
  throw new Error(`three.js could not be loaded (${last && last.message})`);
}

const $ = id => document.getElementById(id);
const fmt = (v, n = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(n));
const grade = mm => (mm == null ? '' : mm < 5 ? 'good' : mm < 12 ? 'fair' : 'poor');

export async function start() {
  const THREE = await loadThree();

  const state = {
    layoutName: 'zed-hands',
    rig: { ...DEFAULT_RIG },
    noisePx: 1.0, dropRate: 0.02, zedRangeMm: ZED_RANGE_MM, baselineMm: 120, headBaseMm: 300,
    unsyncZed: false, interpolate: true, extrapolate: true, playing: true, handSpeed: 1,
    pinchHeld: false, headOverride: null, handOverride: null,
    tSec: 0, nowMs: 0,
  };
  const rng = mulberry32(20260919);
  let geom = rigGeometry(state.rig);
  let cameras = [], tracker = null, phase = new Map();

  // ---------- scene ----------
  const canvas = $('scene');
  let renderer, rigRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x04060b);
    rigRenderer = new THREE.WebGLRenderer({ canvas: $('rig'), antialias: true });
    rigRenderer.setPixelRatio(1);
    rigRenderer.setClearColor(0x000000, 1);
    rigRenderer.setSize(300, 400, false);
  } catch (e) {
    // No WebGL (a locked-down headless browser, say). The numbers still work, so say so and carry on.
    $('error').textContent = 'No WebGL here, so the 3D view is off. Every number on this panel is still live.';
  }

  const scene = new THREE.Scene();
  const view = new THREE.PerspectiveCamera(42, 1, 10, 8000);
  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a0f18, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(400, 900, 700); scene.add(key);

  const rigGroup = new THREE.Group(); scene.add(rigGroup);
  const camGroup = new THREE.Group(); scene.add(camGroup);
  const truthGroup = new THREE.Group(); scene.add(truthGroup);
  const solvedGroup = new THREE.Group(); scene.add(solvedGroup);

  const V = p => new THREE.Vector3(p[0], p[1], p[2]);
  const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const makeLines = (pts, mat) => new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts.map(V)), mat);

  // ---------- the rig itself ----------
  function buildRigMeshes() {
    rigGroup.clear();
    const g = geom;
    // The acrylic sheet: a thin, barely-there plane. It reflects about 4-5%, which is exactly why black
    // reads as transparent and the model has to be bright.
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(g.sheet.widthMm, g.sheet.depthMm),
      new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.1, roughness: 0.05,
                                       metalness: 0, side: THREE.DoubleSide }));
    sheet.rotation.x = -Math.PI / 2;
    rigGroup.add(sheet);
    rigGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(sheet.geometry), lineMat(0x35d0ff, 0.5))
      .rotateX(-Math.PI / 2));

    // The portrait panel, with the 4:3 active area picked out and the unused strip left black.
    const panelMesh = (rect, color, opacity) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rect.widthMm, rect.heightMm),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide }));
      return m;
    };
    const orient = (mesh, centre, right, up) => {
      const z = cross(right, up);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(right[0], up[0], z[0], centre[0],
                      right[1], up[1], z[1], centre[1],
                      right[2], up[2], z[2], centre[2],
                      0, 0, 0, 1);
      return mesh;
    };
    rigGroup.add(orient(panelMesh(g.panel, 0x0a0f18, 0.95), g.screen.centre, g.screen.right, g.screen.up));
    rigGroup.add(orient(panelMesh(g.active, 0x123551, 0.95), g.screen.centre, g.screen.right, g.screen.up));
    rigGroup.add(orient(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(g.active.widthMm, g.active.heightMm)), lineMat(0x35d0ff)),
      g.screen.centre, g.screen.right, g.screen.up));

    // The floating image: the active area mirrored in the sheet. This is where the model appears.
    rigGroup.add(orient(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(g.virtualScreen.widthMm, g.virtualScreen.heightMm)),
      lineMat(0xb58bff, 0.9)), g.virtualScreen.centre, g.virtualScreen.right, g.virtualScreen.up));
    // The light path: panel corner -> sheet -> the mirrored corner underneath.
    const rays = [];
    for (const k of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']) {
      const a = g.screen[k], b = [a[0], 0, a[2]];
      rays.push(a, b, b, [a[0], -a[1], a[2]]);
    }
    rigGroup.add(makeLines(rays, lineMat(0xb58bff, 0.28)));

    // The volume the hands work in.
    const v = g.handVolume;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(
      new THREE.BoxGeometry(v.sizeMm[0], v.sizeMm[1], v.sizeMm[2])), lineMat(0xb58bff, 0.35));
    box.position.set(v.centre[0], v.centre[1], v.centre[2]);
    rigGroup.add(box);

    // A ghost of the model where it floats, so it is obvious that the hands and the image share a volume.
    const ghost = new THREE.Mesh(new THREE.TorusKnotGeometry(52, 16, 96, 16),
      new THREE.MeshStandardMaterial({ color: 0x8fe4ff, emissive: 0x1c5f86, transparent: true, opacity: 0.28,
                                       roughness: .35, depthWrite: false }));
    ghost.position.set(...v.centre);
    rigGroup.add(ghost);

    const floor = new THREE.GridHelper(2000, 20, 0x14304a, 0x0d2033);
    floor.position.y = -Math.abs(g.screen.centre[1]) - 260;
    rigGroup.add(floor);
  }

  // ---------- cameras ----------
  function buildCameraMeshes() {
    camGroup.clear();
    for (const c of cameras) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(34, 24, 24),
        new THREE.MeshStandardMaterial({ color: c.role === 'hands' ? 0x35d0ff : 0x7cff9b, roughness: .5 }));
      body.position.set(...c.position);
      camGroup.add(body);
      // The frustum, drawn to where it matters: the hand volume for a hand camera, the viewer for a head one.
      const far = c.role === 'head' ? dist(c.position, geom.viewer) * 1.25
                                    : dist(c.position, geom.handVolume.centre) * 1.25;
      const corners = [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]]
        .map(([u, v]) => add(c.position, scale(c.ray(u, v).d, far)));   // ray().d is already a unit vector
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push(c.position, corners[i], corners[i], corners[(i + 1) % 4]);
      }
      camGroup.add(makeLines(pts, lineMat(c.role === 'hands' ? 0x35d0ff : 0x7cff9b, 0.22)));
    }
  }

  // ---------- head and hands ----------
  const sphere = (r, color, opacity = 1) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
    new THREE.MeshStandardMaterial({ color, roughness: .45, transparent: opacity < 1, opacity }));
  const headTruth = sphere(85, 0x7cff9b, 0.35); truthGroup.add(headTruth);
  const eyeDots = [sphere(9, 0x7cff9b), sphere(9, 0x7cff9b)]; eyeDots.forEach(d => truthGroup.add(d));
  const eyeSolved = sphere(13, 0xffb23e); solvedGroup.add(eyeSolved);
  const eyeLink = makeLines([[0, 0, 0], [0, 0, 0]], lineMat(0xff6b7a, 0.9)); solvedGroup.add(eyeLink);

  const jointTruth = Array.from({ length: HAND.COUNT }, () => sphere(7, 0x7cff9b));
  jointTruth.forEach(j => truthGroup.add(j));
  let boneTruth = makeLines(HAND_BONES.flatMap(() => [[0, 0, 0], [0, 0, 0]]), lineMat(0x7cff9b, 0.8));
  truthGroup.add(boneTruth);
  const jointSolved = Array.from({ length: HAND.COUNT }, () => sphere(6, 0xffb23e));
  jointSolved.forEach(j => solvedGroup.add(j));
  let boneSolved = makeLines(HAND_BONES.flatMap(() => [[0, 0, 0], [0, 0, 0]]), lineMat(0xffb23e, 0.9));
  solvedGroup.add(boneSolved);
  const tipLink = makeLines([[0, 0, 0], [0, 0, 0]], lineMat(0xff6b7a, 0.9)); solvedGroup.add(tipLink);

  const setLine = (line, pts) => {
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(V));
  };

  // ---------- what the panel shows ----------
  // A separate little scene: the model, bright on pure black, plus the recovered hand. This is the picture
  // the viewer actually sees floating under the sheet.
  const content = new THREE.Scene();
  // Bright, saturated and lit from one side: on a Pepper's-ghost rig the panel's own brightness is all the
  // contrast there is, because the acrylic only bounces four or five per cent of it toward the viewer.
  const modelMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(52, 16, 128, 20),
    new THREE.MeshStandardMaterial({ color: 0x5cc8ff, emissive: 0x0d3f63, roughness: .3, metalness: .25 }));
  content.add(modelMesh);
  content.add(new THREE.HemisphereLight(0x9fd8ff, 0x06121c, 0.85));
  const contentKey = new THREE.DirectionalLight(0xffffff, 1.9); contentKey.position.set(300, 500, 600);
  content.add(contentKey);
  const contentHand = makeLines(HAND_BONES.flatMap(() => [[0, 0, 0], [0, 0, 0]]),
    new THREE.LineBasicMaterial({ color: 0xffb23e }));
  content.add(contentHand);
  const rigCam = new THREE.PerspectiveCamera(50, 0.75, 10, 5000);

  // ---------- rebuilding when the controls change ----------
  function rebuild() {
    geom = rigGeometry(state.rig);
    const g = geom;
    const def = LAYOUTS[state.layoutName];
    cameras = def.build(g);
    // Apply the sensor sliders on top of whatever the layout chose.
    const zed = cameras.filter(c => c.id.startsWith('zed'));
    if (zed.length === 2) {
      const [l] = makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, state.zedRangeMm],
                            target: g.handVolume.centre });
      zed[0].position = l.position.slice(); zed[0].setPose({ R: l.R });
      zed[1].position = add(zed[0].position, scale(zed[0].right, state.baselineMm));
      zed[1].setPose({ R: zed[0].R });
    }
    const heads = cameras.filter(c => c.role === 'head');
    if (heads.length === 2) {
      heads[0].position = [-state.headBaseMm / 2, g.viewer[1] + 60, 40];
      heads[1].position = [state.headBaseMm / 2, g.viewer[1] + 60, 40];
      for (const h of heads) h.setPose({ target: [0, g.viewer[1], g.viewer[2]] });
    }
    for (const c of cameras) c.noisePx = state.noisePx;

    tracker = new Tracker({ cameras, appScale: 1, interpolate: state.interpolate,
                            extrapolateMs: state.extrapolate ? 20 : 0 });
    phase = new Map();
    for (const c of cameras) {
      const group = !state.unsyncZed && c.id.startsWith('zed') ? 'zed' : c.id;
      if (!phase.has(group)) phase.set(group, rng() * (1000 / (c.fps || 60)));
      phase.set(c.id, phase.get(group));
    }
    buildRigMeshes();
    buildCameraMeshes();
    drawCoverage();
    $('layout-note').textContent = def.note;
    modelMesh.position.set(...geom.handVolume.centre);
    const area = $('active-area');
    if (area) area.style.height = `${(200 * geom.activeFraction).toFixed(0)}px`;
  }

  // ---------- the truth, which the user can take hold of ----------
  function currentTruth() {
    const base = truthAt(state.tSec, geom, { handSpeed: state.handSpeed });
    const head = state.headOverride || base.head;
    if (!state.handOverride) {
      return { head, hands: base.hands, pinch01: base.pinch01 };
    }
    const pinch01 = state.pinchHeld ? 0 : 1;
    return { head, pinch01, hands: [{ handedness: 'Right', points: handPose({ centre: state.handOverride, pinch01 }) }] };
  }

  // ---------- one simulated frame ----------
  function step(dtMs) {
    if (state.playing) state.tSec += dtMs / 1000;
    state.nowMs += dtMs;
    const nowMs = state.nowMs;
    for (const c of cameras) {
      const period = 1000 / (c.fps || 60);
      const capture = Math.floor((nowMs - phase.get(c.id)) / period) * period + phase.get(c.id);
      if (capture < 0 || capture > nowMs) continue;
      const truthThen = state.playing
        ? (() => { const saved = state.tSec; state.tSec = saved - (nowMs - capture) / 1000;
                   const t = currentTruth(); state.tSec = saved; return t; })()
        : currentTruth();
      const view = synthesizeView(c, truthThen, { noisePx: c.noisePx, rng, dropRate: state.dropRate });
      if (view) tracker.observe2D({ camId: c.id, tMs: capture, face: view.face, hands: view.hands });
    }
    // The bridge preset has no local hand cameras at all: the hands arrive already in 3D, late, from a
    // process running the ZED SDK on another machine.
    if (LAYOUTS[state.layoutName].bridge) {
      const lateBy = 35, tCapture = nowMs - lateBy;
      if (tCapture >= 0 && rng() > state.dropRate) {
        const t = currentTruth();
        tracker.observe3D({ tMs: tCapture, hands: t.hands.map(h => ({ handedness: h.handedness,
          points: h.points.map(p => p.map(v => v + (rng() - 0.5) * 6)) })) });
      }
    }
    const truth = currentTruth();
    const out = tracker.solve(nowMs);
    // The truth at the instant the cameras actually fired, so the panel can separate "the geometry is
    // wrong" from "the answer is late" — two problems with completely different fixes.
    const atCapture = state.playing && !state.handOverride
      ? truthAt(state.tSec - (nowMs - out.tHandMs) / 1000, geom, { handSpeed: state.handSpeed })
      : truth;
    updateVisuals(truth, out);
    updateReadout(truth, out, atCapture);
    return { truth, out };
  }

  function updateVisuals(truth, out) {
    const eyes = eyePoints(truth.head);
    headTruth.position.set(...truth.head);
    eyeDots.forEach((d, i) => d.position.set(...eyes[i]));
    const eyeMid = scale(add(eyes[0], eyes[1]), 0.5);
    const pts = truth.hands[0].points;
    jointTruth.forEach((j, i) => j.position.set(...pts[i]));
    setLine(boneTruth, HAND_BONES.flatMap(([a, b]) => [pts[a], pts[b]]));

    if (out.eye) {
      eyeSolved.visible = true;
      eyeSolved.position.set(...out.eye);
      setLine(eyeLink, [eyeMid, out.eye]);
    } else eyeSolved.visible = false;

    const hand = out.hands.find(h => h.active);
    const show = !!(hand && hand.points);
    jointSolved.forEach(j => (j.visible = show));
    boneSolved.visible = show; tipLink.visible = show;
    if (show) {
      hand.points.forEach((p, i) => { if (p) jointSolved[i].position.set(...p); jointSolved[i].visible = !!p; });
      const seg = HAND_BONES.filter(([a, b]) => hand.points[a] && hand.points[b])
        .flatMap(([a, b]) => [hand.points[a], hand.points[b]]);
      setLine(boneSolved, seg.length ? seg : [[0, 0, 0], [0, 0, 0]]);
      setLine(tipLink, [pts[HAND.INDEX_TIP], hand.tip || pts[HAND.INDEX_TIP]]);
      setLine(contentHand, seg.length ? seg : [[0, 0, 0], [0, 0, 0]]);
      const material = modelMesh.material;
      material.emissive.setHex(hand.pinch ? 0x8a4a00 : 0x1c5f86);
    }
  }

  function updateReadout(truth, out, atCapture = truth) {
    const eyes = eyePoints(truth.head), eyeMid = scale(add(eyes[0], eyes[1]), 0.5);
    const eyeErr = out.eye ? dist(out.eye, eyeMid) : null;
    const hand = out.hands.find(h => h.active);
    const pts = truth.hands[0].points;
    const tipErr = hand && hand.tip ? dist(hand.tip, pts[HAND.INDEX_TIP]) : null;
    const geomErr = hand && hand.raw && hand.raw[HAND.INDEX_TIP]
      ? dist(hand.raw[HAND.INDEX_TIP], atCapture.hands[0].points[HAND.INDEX_TIP]) : null;
    const gripTruth = scale(add(pts[HAND.INDEX_TIP], pts[HAND.THUMB_TIP]), 0.5);
    const gripErr = hand && hand.grip ? dist(hand.grip, gripTruth) : null;
    const q = out.quality;

    const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = cls || (id === 'r-eye' || id === 'r-tip' ? 'big' : ''); };
    set('r-eye', eyeErr == null ? 'not seen' : `${fmt(eyeErr)} mm`, `big ${grade(eyeErr)}`);
    set('r-tip', tipErr == null ? 'not seen' : `${fmt(tipErr)} mm`, `big ${grade(tipErr)}`);
    set('r-geom', geomErr == null ? '—' : `${fmt(geomErr)} mm`);
    set('r-grip', gripErr == null ? '—' : `${fmt(gripErr)} mm`);
    set('r-source', `${q.handSource} / ${q.handViews} view${q.handViews === 1 ? '' : 's'}${q.stale ? `, ${q.stale} stale` : ''}`);
    set('r-rms', `${fmt(q.handRmsPx, 2)} px`);
    set('r-lat', `${fmt(q.latencyMs, 0)} ms`);
    const pinchTruth = truth.pinch01 < 0.25;
    set('r-pinch', `${hand && hand.pinch ? 'held' : 'open'} (truth ${pinchTruth ? 'held' : 'open'})`,
        hand && hand.pinch === pinchTruth ? 'good' : 'poor');
    const gain = parallaxGain(out.eye || eyeMid, geom.virtualScreen, 150);
    set('r-gain', eyeErr == null ? '—' : `${fmt(eyeErr * gain, 1)} mm`);
    $('r-note').textContent = eyeErr == null ? '' :
      `"Cameras alone" is the unfiltered answer against where the hand was when the shutters actually fired: ` +
      `it is how good the geometry is. "Fingertip" is what the user sees, after filtering and after the lag. ` +
      `An eye error is only seen at ${(gain * 100).toFixed(0)}% of its size, because the image floats close to ` +
      `the sheet; a fingertip error is seen at full size, which is why the hands get the stereo pair.`;

    window.sim = { eyeErrMm: eyeErr, tipErrMm: tipErr, geomTipErrMm: geomErr, gripErrMm: gripErr, quality: q,
                   readout: tracker.readout, layout: state.layoutName, cameras: cameras.length };
  }

  // ---------- the portrait panel ----------
  const RIG_W = 300, RIG_H = 400;      // the portrait panel, in canvas pixels
  function renderRigView(out) {
    if (!rigRenderer) return;
    const g = geom, eye = out.eye || geom.viewer;
    const f = offAxisFrustum(eye, g.virtualScreen, 10, 5000);
    if (!f) return;
    // Kooima's generalised perspective projection: the eye is the apex and the screen rectangle is the
    // window, so the frustum is asymmetric and the scene stays put while the head moves. Note three's
    // argument order is (left, right, TOP, BOTTOM, near, far).
    rigCam.position.set(...eye);
    rigCam.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, f.near, f.far);
    rigCam.projectionMatrixInverse.copy(rigCam.projectionMatrix).invert();
    // Camera axes: x along the screen's right edge, y up it, +z back toward the eye (three looks down -z).
    rigCam.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(V(f.vr), V(f.vu), V(f.vn)));

    // The canvas is the portrait panel. Only the 4:3 strip the sheet covers gets drawn; the rest stays
    // black, and black is what the acrylic reads as transparent.
    const activeH = Math.round(RIG_H * g.activeFraction);
    rigRenderer.setScissorTest(true);
    rigRenderer.setViewport(0, RIG_H - activeH, RIG_W, activeH);
    rigRenderer.setScissor(0, RIG_H - activeH, RIG_W, activeH);
    rigRenderer.render(content, rigCam);
    rigRenderer.setScissorTest(false);
  }

  // ---------- the coverage map ----------
  function drawCoverage() {
    const cv = $('coverage'), ctx = cv.getContext('2d');
    const cov = coverageSlice(cameras, geom, 44, 22);
    ctx.fillStyle = '#050a11'; ctx.fillRect(0, 0, cv.width, cv.height);
    const nx = cov.steps[0], nz = cov.steps[2];
    const cw = cv.width / nx, ch = cv.height / nz;
    for (const cell of cov.cells) {
      // x across, z up the canvas (nearest the viewer at the bottom).
      const px = cell.ix * cw, py = cv.height - (cell.iz + 1) * ch;
      if (cell.views < 2) { ctx.fillStyle = cell.views === 1 ? '#16202c' : '#0a0f16'; }
      else {
        const t = Math.min(1, Math.max(0, (cell.mm - 1) / 11));       // 1 mm green -> 12 mm red
        const r = Math.round(60 + t * 195), g = Math.round(235 - t * 130), b = Math.round(155 - t * 90);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillRect(px, py, Math.ceil(cw) + 1, Math.ceil(ch) + 1);
    }
    // Where the model floats, for scale.
    ctx.strokeStyle = 'rgba(181,139,255,.9)'; ctx.lineWidth = 1;
    const v = geom.handVolume;
    const toPx = p => [((p[0] - cov.origin[0]) / cov.size[0]) * cv.width,
                       cv.height - ((p[2] - cov.origin[2]) / cov.size[2]) * cv.height];
    const a = toPx([v.centre[0] - v.sizeMm[0] / 2, 0, v.centre[2] - v.sizeMm[2] / 2]);
    const b = toPx([v.centre[0] + v.sizeMm[0] / 2, 0, v.centre[2] + v.sizeMm[2] / 2]);
    ctx.strokeRect(a[0], b[1], b[0] - a[0], a[1] - b[1]);
    $('cov-note').innerHTML = cov.medianMm == null
      ? 'Only one camera sees this volume, so nothing can be triangulated here at all — the fingertip depth ' +
        'is a guess from how big the palm looks.'
      : `A slice through the middle of the hand volume, seen from above. Green is about a millimetre, red is ` +
        `twelve; dark means fewer than two cameras can see it, which is where tracking quietly gives up. ` +
        `Median <b>${cov.medianMm.toFixed(1)} mm</b>, ${(cov.coveredFraction * 100).toFixed(0)}% covered.`;
  }

  // ---------- orbiting and dragging ----------
  const orbit = { yaw: 0.75, pitch: 0.24, dist: 1500, target: [0, -20, 180] };
  function placeView() {
    const { yaw, pitch, dist: d, target } = orbit;
    view.position.set(target[0] + d * Math.cos(pitch) * Math.sin(yaw),
                      target[1] + d * Math.sin(pitch),
                      target[2] + d * Math.cos(pitch) * Math.cos(yaw));
    view.lookAt(V(target));
  }
  let drag = null;
  const ray = new THREE.Raycaster();
  const pointerNdc = e => {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    ray.setFromCamera(pointerNdc(e), view);
    const hitHead = ray.intersectObject(headTruth, false)[0];
    const hitHand = ray.intersectObjects(jointTruth, false)[0];
    const pick = hitHand && (!hitHead || hitHand.distance < hitHead.distance) ? 'hand' : hitHead ? 'head' : null;
    if (pick) {
      const truth = currentTruth();
      const anchor = pick === 'head' ? truth.head : truth.hands[0].points[HAND.MIDDLE_MCP];
      drag = { what: pick, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
        view.getWorldDirection(new THREE.Vector3()).clone().negate(), V(anchor)), anchor };
      if (pick === 'head') state.headOverride = anchor.slice();
      else state.handOverride = anchor.slice();
    } else {
      drag = { what: 'orbit', x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.what === 'orbit') {
      orbit.yaw -= (e.clientX - drag.x) * 0.006;
      orbit.pitch = Math.max(-1.2, Math.min(1.35, orbit.pitch + (e.clientY - drag.y) * 0.005));
      drag.x = e.clientX; drag.y = e.clientY;
      placeView();
      return;
    }
    ray.setFromCamera(pointerNdc(e), view);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(drag.plane, hit)) return;
    if (drag.what === 'head') state.headOverride = [hit.x, hit.y, hit.z];
    else state.handOverride = [hit.x, hit.y, hit.z];
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    orbit.dist = Math.max(500, Math.min(4500, orbit.dist * (1 + Math.sign(e.deltaY) * 0.12)));
    placeView();
  }, { passive: false });

  // ---------- controls ----------
  const sel = $('layout');
  for (const [name, def] of Object.entries(LAYOUTS)) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = def.label;
    sel.appendChild(opt);
  }
  sel.value = state.layoutName;
  sel.addEventListener('change', () => { state.layoutName = sel.value; rebuild(); });

  const slider = (id, key, format, onRig = false) => {
    const el = $(id), out = $(`${id}-out`);
    const apply = () => {
      const v = parseFloat(el.value);
      if (onRig) state.rig[key] = v; else state[key] = v;
      out.textContent = format(v);
      rebuild();
    };
    el.addEventListener('input', apply);
    out.textContent = format(parseFloat(el.value));
  };
  slider('noise', 'noisePx', v => `${v.toFixed(1)} px`);
  slider('drop', 'dropRate', v => `${(v * 100).toFixed(0)}%`);
  slider('zedz', 'zedRangeMm', v => `${v.toFixed(0)} mm`);
  slider('base', 'baselineMm', v => `${v.toFixed(0)} mm`);
  slider('headbase', 'headBaseMm', v => `${v.toFixed(0)} mm`);
  slider('diag', 'panelDiagIn', v => `${v} in`, true);
  slider('tilt', 'tiltDeg', v => `${v.toFixed(0)}°`, true);
  slider('height', 'panelHeightMm', v => `${v.toFixed(0)} mm`, true);
  slider('viewz', 'viewerZMm', v => `${v.toFixed(0)} mm`, true);
  $('hspeed').addEventListener('input', e => {
    state.handSpeed = parseFloat(e.target.value);
    $('hspeed-out').textContent = `x${state.handSpeed}`;
  });

  const toggle = (id, key, label) => $(id).addEventListener('click', () => {
    state[key] = !state[key];
    $(id).classList.toggle('on', key === 'interpolate' ? state[key] : state[key]);
    $(id).textContent = label(state[key]);
    rebuild();
  });
  toggle('unsync', 'unsyncZed', on => (on ? 'ZED eyes free-running (on)' : 'ZED eyes free-running'));
  toggle('interp', 'interpolate', on => (on ? 'line frames up in time' : 'use the newest frame, as it comes'));
  toggle('extrap', 'extrapolate', on => (on ? 'pull laggards forward' : 'wait for the slowest camera'));

  $('play').addEventListener('click', () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? 'pause' : 'play';
    $('play').classList.toggle('on', state.playing);
  });
  $('pinch').addEventListener('click', () => {
    state.pinchHeld = !state.pinchHeld;
    $('pinch').textContent = state.pinchHeld ? 'open the pinch' : 'close the pinch';
    $('pinch').classList.toggle('on', state.pinchHeld);
    if (!state.handOverride) state.handOverride = currentTruth().hands[0].points[HAND.MIDDLE_MCP].slice();
  });
  $('reset').addEventListener('click', () => {
    state.headOverride = null; state.handOverride = null; state.pinchHeld = false;
    $('pinch').textContent = 'close the pinch'; $('pinch').classList.remove('on');
  });

  $('run300').addEventListener('click', () => {
    $('bench').textContent = 'running…';
    setTimeout(() => {
      // Benchmark the cameras that are actually on screen, sliders and all — not the layout's defaults.
      const live = { ...LAYOUTS[state.layoutName], cameras, geometry: geom };
      const { stats } = runSession({ layout: live, rig: state.rig, frames: 300, hz: 60,
                                     noisePx: state.noisePx, dropRate: state.dropRate,
                                     unsyncZed: state.unsyncZed, handSpeed: state.handSpeed,
                                     overrides: { interpolate: state.interpolate } });
      $('bench').innerHTML =
        `300 frames of reach, pinch, carry and release:<br>` +
        `eye <b>${stats.eyeMeanMm.toFixed(2)} mm</b> mean, ${stats.eyeP95Mm.toFixed(2)} p95<br>` +
        `fingertip <b>${stats.tipMeanMm.toFixed(2)} mm</b> mean, ${stats.tipP95Mm.toFixed(2)} p95 ` +
        `(unfiltered ${stats.rawTipMeanMm.toFixed(2)})<br>` +
        `jitter ${stats.jitterMm.toFixed(2)} mm, tracked ${(stats.trackedFraction * 100).toFixed(0)}%, ` +
        `pinch right ${(stats.pinchAccuracy * 100).toFixed(0)}% of frames`;
      window.simBench = stats;
    }, 10);
  });
  $('compare').addEventListener('click', () => {
    $('bench').textContent = 'running every layout…';
    setTimeout(() => {
      const rows = compareLayouts({ frames: 150, hz: 60, noisePx: state.noisePx, dropRate: state.dropRate });
      $('bench').innerHTML = rows.map(r =>
        `<b>${r.label}</b><br>fingertip ${r.stats.tipMeanMm.toFixed(2)} mm, eye ${r.stats.eyeMeanMm.toFixed(2)} mm, ` +
        `tracked ${(r.stats.trackedFraction * 100).toFixed(0)}%` +
        (r.coverage.median ? `, volume median ${r.coverage.median.toFixed(1)} mm` : '')).join('<br><br>');
      window.simCompare = rows;
    }, 10);
  });

  // ---------- go ----------
  function resize() {
    if (!renderer) return;
    const w = $('left').clientWidth, h = $('left').clientHeight;
    renderer.setSize(w, h, false);
    view.aspect = w / Math.max(1, h);
    view.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  rebuild();
  placeView();
  resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last); last = now;
    const { out } = step(dt);
    if (renderer) renderer.render(scene, view);
    renderRigView(out);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.simReady = true;
  return { state, step, rebuild, get cameras() { return cameras; }, get tracker() { return tracker; } };
}
