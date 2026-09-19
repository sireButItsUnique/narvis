// Hands (or the mouse) -> what you're pointing at, and what a pinch does in the current tool:
//   move    pinch the model and drag it; push toward the screen to send it deeper
//   part    the same, but only the part you pinched (in this view only until sync arrives in M4)
//   sculpt  / smooth: the Blender brush engine arrives in M2; until then a pinch says so
// Pinching with both hands (in any tool) turns, resizes and moves the whole model.
// Pointing uses the ray from your eye through your index fingertip; a pinch holds the point between thumb and index.
import * as THREE from 'three';
import { canvas, rect, boxDepth } from './view.js';
import { input } from './input/state.js';
import { model, parts, beginEdit, cancelEdit, discardEdit, endGrab, commitPartPosition, clampPosition,
         setTransform, setGestureFlush } from './model.js';
import { highlight } from './scene/highlight.js';
import { updateViz } from './handviz.js';

export const TOOLS = ['move', 'sculpt', 'smooth', 'part'];
export const tool = { mode: 'move', brush: 2.5, mirror: false };   // brush: radius in cm as seen on screen
export const setBrush = r => (tool.brush = THREE.MathUtils.clamp(r, 0.5, 12));
export const SCULPT_SOON = 'Sculpting arrives in the next build. Pinch in move or part mode for now.';

const PUSH_GAIN = 2.0;          // hand toward the screen -> object deeper (move, part)
const TURN_GAIN = 1.5;          // two-hand turn
const MIN_TURN_CM = 6;          // hands closer than this side to side (one above the other) can't steer a turn
const HOVER_MS = 33;            // how often a pointer re-picks: hands arrive at about 30 Hz, and a pick over a
                                // 200-400k-tri model costs 4.5-14 ms of the frame (a BVH lands with the M2 proxy)
const AIM_MS = 400;             // a pinch grabs what was under the open hand this recently (pinching moves the fingertip)
const THAT_MS = 1500;           // "delete that" means what you pointed at this recently (speech finishes after you point)
const TAKEOVER_MS = 600;        // a one-hand gesture this young is undone when the second hand joins in

const raycaster = new THREE.Raycaster();
const mouse = { x: 0.5, y: 0.5, down: false, onScreen: false, depth: 0 };
const per = [0, 1].map(() => ({ wasPinch: false, consumed: false, aim: null, hit: null, castAt: -1e9 }));
let action = null;
let lastHover = { mesh: null, t: -1e9 };
let notify = () => {};
export const setNotify = fn => { notify = fn; };

// the part you're pointing at (or just were), for "delete that", "make that red", "duplicate that"
export function pointedPart(now = performance.now()) {
  const m = lastHover.mesh;
  return m && now - lastHover.t < THAT_MS ? parts.ofMesh(m) : null;
}
export const hoveredMesh = () => lastHover.mesh;

const rayPoint = (p, t) => input.eye.clone().addScaledVector(p.gripDir, t);

function readPointers() {
  const eye = input.eye;
  if (input.mode === 'mouse') {   // the mouse is one hand: drag = pinch, wheel while dragging = push/pull
    const dir = new THREE.Vector3(rect.x0 + mouse.x * rect.w, rect.y1 - mouse.y * rect.h, 0).sub(eye).normalize();
    return [{ id: 0, active: mouse.onScreen, pinch: mouse.down, dir, gripDir: dir, handZ: mouse.depth, grip: null, hand: null }];
  }
  return input.hands.map((h, id) => ({
    id, active: h.active, pinch: h.pinch, hand: h, grip: h.grip, handZ: h.grip.z,
    dir: h.tip.clone().sub(eye).normalize(), gripDir: h.grip.clone().sub(eye).normalize(),
  }));
}

function worldNormal(hit) {
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  return n.dot(raycaster.ray.direction) > 0 ? n.negate() : n;   // face the viewer (inside of open surfaces)
}

// ---------- one-hand gestures ----------
function startAction(p, target, now) {
  const root = model.group, base = { pid: p.id, root, dist: target.dist, handZ0: p.handZ, t0: now };
  if (tool.mode === 'sculpt' || tool.mode === 'smooth') { notify(SCULPT_SOON); return false; }
  if (tool.mode === 'move') {
    beginEdit();
    action = { ...base, kind: 'grab', startPos: root.position.clone(), offset: root.position.clone().sub(rayPoint(p, target.dist)) };
  } else {
    // parts sit directly under the glTF root, so their position is root-relative (metres)
    const mesh = target.mesh, frame = mesh.parent;
    beginEdit(mesh);
    action = { ...base, kind: 'part', mesh, frame, startPos: mesh.position.clone(),
               offset: mesh.position.clone().sub(frame.worldToLocal(rayPoint(p, target.dist))) };
  }
  return true;
}

function updateAction(p) {
  const root = action.root;
  if (action.kind === 'grab') {
    const t = action.dist + (action.handZ0 - p.handZ) * PUSH_GAIN;
    root.position.lerp(clampPosition(rayPoint(p, t).add(action.offset)), 0.5);
    p.end = root.position.clone().sub(action.offset);
  } else if (action.kind === 'part') {
    const t = action.dist + (action.handZ0 - p.handZ) * PUSH_GAIN, frame = action.frame;
    action.mesh.position.lerp(frame.worldToLocal(rayPoint(p, t)).add(action.offset), 0.5);
    p.end = frame.localToWorld(action.mesh.position.clone().sub(action.offset));
  }
}

// did the gesture actually change anything?
function changed(a) {
  const moved = (p, q, eps) => p.distanceTo(q) > eps;
  if (a.kind === 'grab') return moved(a.root.position, a.startPos, 0.01);
  if (a.kind === 'part') return moved(a.mesh.position, a.startPos, 1e-4);   // metres
  return moved(a.root.position, a.pos0, 0.01) || Math.abs(model.rotY - a.rot0) > 1e-3 || Math.abs(model.userScale - a.scale0) > 1e-3;
}

function endAction() {
  const a = action;
  action = null;
  if (!a) return;
  if (!changed(a)) discardEdit();
  else if (a.kind === 'part') commitPartPosition(a.mesh);
  else endGrab();
}

// Anything that changes the parts (a new rev from Blender, "delete that"...) first commits the gesture in
// progress, so a drag you're still holding lands instead of vanishing.
setGestureFlush(() => endAction());

// throw a gesture away as if it never happened (the second hand joined in right after the first pinched)
function cancelAction() {
  const a = action;
  action = null;
  if (!a) return;
  if (a.kind === 'part') a.mesh.position.copy(a.startPos);
  cancelEdit();
}

// ---------- two hands: turn (push one hand away, pull the other in), resize (spread), move (both together) ----------
// The hands' heading in the floor plane; null when they're one above the other and it would be mostly noise.
const heading = v => (Math.hypot(v.x, v.z) > MIN_TURN_CM ? Math.atan2(-v.z, v.x) : null);

function startTwo(ps) {
  const [a, b] = ps, v = b.grip.clone().sub(a.grip), root = model.group;
  beginEdit();
  action = { kind: 'two', root, pids: [0, 1], turn: 0, angPrev: heading(v), len0: Math.max(1, Math.hypot(v.x, v.y)),
             mid0: a.grip.clone().add(b.grip).multiplyScalar(0.5), pos0: root.position.clone(),
             rot0: model.rotY, scale0: model.userScale };
}

function updateTwo(ps) {
  const [a, b] = ps, v = b.grip.clone().sub(a.grip);
  // add up small per-frame changes (no jump at ±180°); hold the turn while the hands are stacked
  const ang = heading(v);
  if (ang !== null && action.angPrev !== null) {
    const d = ang - action.angPrev;
    action.turn += Math.atan2(Math.sin(d), Math.cos(d));
  }
  action.angPrev = ang;
  const mid = a.grip.clone().add(b.grip).multiplyScalar(0.5);
  setTransform({
    rotY: action.rot0 + action.turn * TURN_GAIN,
    userScale: action.scale0 * Math.max(1, Math.hypot(v.x, v.y)) / action.len0,
    position: action.pos0.clone().add(new THREE.Vector3(mid.x - action.mid0.x, mid.y - action.mid0.y, 0)),
  });
  const centre = action.root.position;
  for (const p of ps) p.end = rayPoint(p, input.eye.distanceTo(centre));
}

// ---------- per frame ----------
export function updateInteraction() {
  const now = performance.now(), eye = input.eye;
  const ps = readPointers();
  const meshes = model.meshes;
  // the model went away, or the part being moved did (a new rev from Blender): drop the gesture
  if (action && (action.root !== model.group || (action.mesh && !meshes.includes(action.mesh)))) { action = null; endGrab(); }

  for (const p of ps) {
    const st = per[p.id];
    p.onset = p.pinch && !st.wasPinch;
    st.wasPinch = p.pinch;
    if (!p.pinch) st.consumed = false;
    p.hit = null;
    p.end = p.active && p.dir.z < -1e-3 ? eye.clone().addScaledVector(p.dir, (eye.z + boxDepth) / -p.dir.z) : null;
    const busyHand = action && (action.pid === p.id || action.kind === 'two');
    if (p.end && meshes.length && !busyHand) {
      // Picking is a plain raycast over every visible part until the sculpt proxy's octree arrives (M2), which
      // costs milliseconds on a dense model. Hands only move at about 30 Hz, so the frames in between reuse the
      // last hit rather than paying for it twice.
      if (now - st.castAt >= HOVER_MS || !st.hit || !meshes.includes(st.hit.object)) {
        raycaster.set(eye, p.dir);
        st.hit = raycaster.intersectObjects(meshes, false)[0] || null;
        st.castAt = now;
        if (st.hit) st.hitNormal = worldNormal(st.hit);
      }
      p.hit = st.hit;
      if (p.hit) {
        p.end = p.hit.point.clone();
        p.normal = st.hitNormal;   // from the cast itself: worldNormal reads the ray, which has moved on since
        if (!p.pinch) st.aim = { mesh: p.hit.object, point: p.hit.point.clone(), dist: p.hit.distance, t: now };
      }
    }
  }
  const hovered = ps.find(p => p.hit)?.hit.object || null;
  if (hovered) lastHover = { mesh: hovered, t: now };

  let brush = null;
  const twoHands = input.mode === 'camera' && ps.every(p => p.active && p.pinch) && !!model.group;
  if (twoHands) {
    if (action?.kind !== 'two') {
      if (action) (now - action.t0 < TAKEOVER_MS ? cancelAction : endAction)();
      startTwo(ps);
    }
    updateTwo(ps);
  } else {
    if (action?.kind === 'two') {
      endAction();
      for (const p of ps) per[p.id].consumed = p.pinch;   // the hand still pinched waits for a fresh pinch
    }
    if (action) {
      const p = ps[action.pid];
      if (!p || !p.active || !p.pinch) endAction();
      else updateAction(p);
    } else if (model.group) {
      for (const p of ps) {
        if (!p.onset || per[p.id].consumed) continue;
        const aim = per[p.id].aim;
        const target = p.hit ? { mesh: p.hit.object, point: p.hit.point, dist: p.hit.distance }
          : input.mode === 'camera' && aim && now - aim.t < AIM_MS && meshes.includes(aim.mesh) ? aim : null;
        if (target) { per[p.id].consumed = !startAction(p, target, now); break; }
      }
    }
  }

  // the brush ring previews the size you'll sculpt with (M2)
  if ((tool.mode === 'sculpt' || tool.mode === 'smooth') && !action) {
    const p = ps.find(q => q.hit);
    if (p) brush = { point: p.hit.point, normal: p.normal, radius: tool.brush };
  }
  highlight(meshes, { hovered: action ? null : hovered, active: action?.mesh || null,
                      all: action?.kind === 'grab' || action?.kind === 'two' });
  updateViz(ps.map(p => ({ ...p, end: p.end || eye.clone() })), eye, brush);
}

// ---------- mouse mode: mouse = your head; drag = pinch; wheel while dragging = pull toward you / push away ----------
addEventListener('pointermove', e => {
  mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; mouse.onScreen = true;
  if (input.mode === 'mouse' && !mouse.down) {
    input.eye.x = rect.cx + (mouse.x - 0.5) * rect.w * 1.6;
    input.eye.y = rect.cy - (mouse.y - 0.5) * rect.h * 1.6;
  }
});
addEventListener('pointerleave', () => { mouse.onScreen = false; });
addEventListener('pointerdown', e => { if (e.target === canvas) { mouse.down = true; mouse.depth = 0; } });
addEventListener('pointerup', () => { mouse.down = false; });
addEventListener('wheel', e => {
  if (input.mode !== 'mouse') return;
  if (mouse.down) mouse.depth = THREE.MathUtils.clamp(mouse.depth - e.deltaY * 0.02, -30, 30);
  else input.eye.z = THREE.MathUtils.clamp(input.eye.z + e.deltaY * 0.03, 15, 150);
}, { passive: true });
