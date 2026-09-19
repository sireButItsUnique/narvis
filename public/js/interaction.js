// Hands (or the mouse) -> what you're pointing at, and what a pinch does in the current tool:
//   move    pinch the model and drag it; push toward the screen to send it deeper
//   part    the same, but only the part you pinched
//   sculpt  pinch the surface and pull it like clay
//   smooth  pinch and rub to even the surface out
// Pinching with both hands (in any tool) turns, resizes and moves the whole model.
// Pointing uses the ray from your eye through your index fingertip; a pinch holds the point between thumb and index.
import * as THREE from 'three';
import { canvas, rect, boxDepth } from './view.js';
import { input } from './input/state.js';
import { model, beginEdit, cancelEdit, discardEdit, endGrab, commitPartPosition, commitSculpt, clampPosition, highlight,
         setTransform, setGestureFlush } from './model.js';
import { ensureSculptable, beginPull, applyPull, revertPull, restorePositions, smoothAt } from './sculpt.js';
import { updateViz } from './handviz.js';

export const TOOLS = ['move', 'sculpt', 'smooth', 'part'];
export const tool = { mode: 'move', brush: 2.5, mirror: false };   // brush: radius in cm as seen on screen
export const setBrush = r => (tool.brush = THREE.MathUtils.clamp(r, 0.5, 12));

const PUSH_GAIN = 2.0;          // hand toward the screen -> object deeper (move, part)
const SCULPT_GAIN = 0.6;        // clay follows the hand a little slower than 1:1, for control
const SCULPT_PUSH_GAIN = 1.2;
const TURN_GAIN = 1.5;          // two-hand turn
const MIN_TURN_CM = 6;          // hands closer than this side to side (one above the other) can't steer a turn
const AIM_MS = 400;             // a pinch grabs what was under the open hand this recently (pinching moves the fingertip)
const THAT_MS = 1500;           // "delete that" means what you pointed at this recently (speech finishes after you point)
const TAKEOVER_MS = 600;        // a one-hand stroke this young is undone when the second hand joins in

const raycaster = new THREE.Raycaster();
const mouse = { x: 0.5, y: 0.5, down: false, onScreen: false, depth: 0 };
const per = [0, 1].map(() => ({ wasPinch: false, consumed: false, aim: null }));
let action = null;
let lastHover = { mesh: null, t: -1e9 };

// the part you're pointing at (or just were), for "delete that", "make that red", "duplicate that"
export function pointedPart(now = performance.now()) {
  const m = lastHover.mesh;
  return m && now - lastHover.t < THAT_MS && model.meshes.includes(m) ? m : null;
}

const partOf = mesh => model.spec.parts.find(p => p.name === mesh.name);
const rayPoint = (p, t) => input.eye.clone().addScaledVector(p.gripDir, t);
// mirror across the model's centre line: spec x = 0, which sits at root-local x = shift.x
const mirrorPlane = root => (tool.mirror ? root.userData.shift.x : null);

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
  beginEdit();
  if (tool.mode === 'move') {
    action = { ...base, kind: 'grab', startPos: root.position.clone(), offset: root.position.clone().sub(rayPoint(p, target.dist)) };
  } else if (tool.mode === 'part') {
    const mesh = target.mesh;
    action = { ...base, kind: 'part', mesh, startPos: mesh.position.clone(),
               offset: mesh.position.clone().sub(root.worldToLocal(rayPoint(p, target.dist))) };
  } else {
    const mesh = target.mesh;
    ensureSculptable(mesh, partOf(mesh));
    if (tool.mode === 'sculpt') {
      const anchor = root.worldToLocal(target.point.clone());
      action = { ...base, kind: 'sculpt', mesh, anchor, anchorWorld: target.point.clone(), start: rayPoint(p, target.dist),
                 stroke: beginPull(mesh, anchor, tool.brush / root.scale.x, mirrorPlane(root)) };
    } else {
      action = { ...base, kind: 'smooth', mesh, before: mesh.geometry.attributes.position.array.slice() };
    }
  }
}

// returns the brush ring to draw, if any
function updateAction(p) {
  const root = action.root;
  if (action.kind === 'grab') {
    const t = action.dist + (action.handZ0 - p.handZ) * PUSH_GAIN;
    root.position.lerp(clampPosition(rayPoint(p, t).add(action.offset)), 0.5);
    p.end = root.position.clone().sub(action.offset);
  } else if (action.kind === 'part') {
    const t = action.dist + (action.handZ0 - p.handZ) * PUSH_GAIN;
    action.mesh.position.lerp(root.worldToLocal(rayPoint(p, t)).add(action.offset), 0.5);
    p.end = root.localToWorld(action.mesh.position.clone().sub(action.offset));
  } else if (action.kind === 'sculpt') {
    const t = action.dist + (action.handZ0 - p.handZ) * SCULPT_PUSH_GAIN;
    const pulled = action.anchorWorld.clone().addScaledVector(rayPoint(p, t).sub(action.start), SCULPT_GAIN);
    applyPull(action.stroke, root.worldToLocal(pulled.clone()).sub(action.anchor));
    p.end = pulled;
    return { point: pulled, normal: input.eye.clone().sub(pulled).normalize(), radius: tool.brush };
  } else if (action.kind === 'smooth') {
    raycaster.set(input.eye, p.gripDir);
    const hit = raycaster.intersectObject(action.mesh, false)[0];
    if (!hit) { p.end = rayPoint(p, action.dist); return null; }
    smoothAt(action.mesh, root.worldToLocal(hit.point.clone()), tool.brush / root.scale.x, mirrorPlane(root), 0.25);
    p.end = hit.point;
    return { point: hit.point, normal: worldNormal(hit), radius: tool.brush };
  }
  return null;
}

// did the gesture actually change anything?
function changed(a) {
  const moved = (p, q) => p.distanceTo(q) > 0.01;
  if (a.kind === 'grab') return moved(a.root.position, a.startPos);
  if (a.kind === 'part') return moved(a.mesh.position, a.startPos);
  if (a.kind === 'two') return moved(a.root.position, a.pos0) || Math.abs(model.rotY - a.rot0) > 1e-3 || Math.abs(model.userScale - a.scale0) > 1e-3;
  const now = a.mesh.geometry.attributes.position.array;
  if (a.kind === 'sculpt') {
    for (let k = 0; k < a.stroke.idx.length; k++) {
      const i = a.stroke.idx[k] * 3;
      if (Math.abs(now[i] - a.stroke.orig[k * 3]) + Math.abs(now[i + 1] - a.stroke.orig[k * 3 + 1]) + Math.abs(now[i + 2] - a.stroke.orig[k * 3 + 2]) > 1e-5) return true;
    }
    return false;
  }
  return now.some((v, i) => Math.abs(v - a.before[i]) > 1e-5);   // smooth
}

function endAction() {
  const a = action;
  action = null;
  if (!a) return;
  if (!changed(a)) discardEdit();
  else if (a.kind === 'part') commitPartPosition(a.mesh);
  else if (a.kind === 'sculpt' || a.kind === 'smooth') commitSculpt(a.mesh);
  else endGrab();
}

// Anything that rebuilds the model (an AI reply, "add a cube", "duplicate that"...) first commits the gesture in
// progress, so a drag or clay stroke you're still holding lands in the new model instead of vanishing.
setGestureFlush(() => endAction());

// throw a gesture away as if it never happened (the second hand joined in right after the first pinched)
function cancelAction() {
  const a = action;
  action = null;
  if (!a) return;
  if (a.kind === 'part') a.mesh.position.copy(a.startPos);
  else if (a.kind === 'sculpt') revertPull(a.stroke);
  else if (a.kind === 'smooth') restorePositions(a.mesh, a.before);
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
  if (action && action.root !== model.group) { action = null; endGrab(); }   // undo replaced the model mid-gesture: drop it

  for (const p of ps) {
    const st = per[p.id];
    p.onset = p.pinch && !st.wasPinch;
    st.wasPinch = p.pinch;
    if (!p.pinch) st.consumed = false;
    p.hit = null;
    p.end = p.active && p.dir.z < -1e-3 ? eye.clone().addScaledVector(p.dir, (eye.z + boxDepth) / -p.dir.z) : null;
    const busyHand = action && (action.pid === p.id || action.kind === 'two');
    if (p.end && model.meshes.length && !busyHand) {
      raycaster.set(eye, p.dir);
      p.hit = raycaster.intersectObjects(model.meshes, false)[0] || null;
      if (p.hit) {
        p.end = p.hit.point.clone();
        p.normal = worldNormal(p.hit);
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
      else brush = updateAction(p);
    } else if (model.group) {
      for (const p of ps) {
        if (!p.onset || per[p.id].consumed) continue;
        const aim = per[p.id].aim;
        const target = p.hit ? { mesh: p.hit.object, point: p.hit.point, dist: p.hit.distance }
          : input.mode === 'camera' && aim && now - aim.t < AIM_MS && model.meshes.includes(aim.mesh) ? aim : null;
        if (target) { startAction(p, target, now); break; }
      }
    }
  }

  if (!brush && (tool.mode === 'sculpt' || tool.mode === 'smooth') && !action) {
    const p = ps.find(q => q.hit);
    if (p) brush = { point: p.hit.point, normal: p.normal, radius: tool.brush };
  }
  highlight({ hovered, active: action?.mesh || null, all: action?.kind === 'grab' || action?.kind === 'two' });
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
