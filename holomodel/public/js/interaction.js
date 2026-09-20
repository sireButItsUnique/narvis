// Hands (or the mouse) -> what you're pointing at, and what a pinch does in the current tool:
//   move     pinch the model and carry it about the picture (its depth is held)
//   rotate   pinch anywhere on it and drag across to turn it on its own axis
//   zoom     pull it toward you and it comes nearer, at the size it already is
//   scale    pull it toward you and it gets bigger, where it already stands
//   extrude  build clay up out of the surface (Clay Strips)
//   smooth   melt what you built back into the form
// The last two are the Blender brush engine (js/sculpt, through js/sculpting.js): pinch and drag to brush.
// Pinching with both hands (in any tool) turns, resizes and moves the whole model.
// Pointing uses the ray from your eye through your index fingertip; a pinch holds the point between thumb and index.
import * as THREE from 'three';
import { canvas, rect, boxDepth } from './view.js';
import { input } from './input/state.js';
import { S } from './settings.js';
import { model, parts, beginEdit, beginMove, cancelEdit, discardEdit, endGrab, clampPosition,
         setTransform, setGestureFlush } from './model.js';
import { highlight } from './scene/highlight.js';
import { updateViz } from './handviz.js';
import * as sculpt from './sculpting.js';

// Six tools, in the order they sit on the keys 1-6: carry it, turn it, bring it nearer, make it
// bigger, add clay, smooth it. One property each, and one number on the badge each - zoom and scale
// used to share a pinch with move and rotate, which was quicker to reach and impossible to say out
// loud, because "pull it toward you" meant nearer in one tool and bigger in another.
// 'extrude' is the word people bring with them from box modelling for "pull material out of the
// surface", and it brushes with Clay Strips (js/sculpting.js) because that is what building a form
// up with your hand actually feels like. Per-part moves are gone: the same pinch, aimed smaller.
export const TOOLS = ['move', 'rotate', 'zoom', 'scale', 'extrude', 'smooth'];
export const SCULPT_TOOLS = new Set(['extrude', 'smooth']);
export const tool = { mode: 'move', brush: 4, mirror: false };   // brush: radius in cm. 4 cm is about a sixth
                                                                // of a model fitted to this box: small enough to shape a
                                                                // feature, big enough that one hand pass is visible.
export const setBrush = r => (tool.brush = THREE.MathUtils.clamp(r, 0.5, 12));

// Zoom tool: hand toward your chest -> the model comes with it. Two means a comfortable 30 cm of
// arm covers 60 cm of the room, which is most of the box.
const PUSH_GAIN = 2.0;
const TURN_GAIN = 1.5;          // two-hand turn
const TURN_PER_CM = 6 * Math.PI / 180;   // one hand: turn per centimetre of hand travel across the model
const SCALE_DOUBLE_CM = 20;     // scale tool: pull it this far toward you and it doubles in size
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

// How far the model is from your eye, and whether a pull is being stopped by the front of the box
// rather than by you. The HUD reads this: "zoom" on this rig is the model's distance, so the number
// that changes has to be on screen or nobody can tell zooming from dragging.
export function zoomState() {
  if (!model.group) return null;
  return { distanceCm: input.eye.distanceTo(model.group.position), zCm: model.group.position.z,
           scale: model.userScale,
           atFront: !!action?.atFront, popout: !!S.popout,
           dragging: !!action && action.kind !== 'stroke' };
}

// the part you're pointing at (or just were), for "delete that", "make that red", "duplicate that"
export function pointedPart(now = performance.now()) {
  const m = lastHover.mesh;
  return m && now - lastHover.t < THAT_MS ? parts.ofMesh(m) : null;
}
export const hoveredMesh = () => lastHover.mesh;

const rayPoint = (p, t) => input.eye.clone().addScaledVector(p.gripDir, t);

// On a desk the model is behind a screen and the hand is in front of it: the hand can only POINT, so every
// tool was built on the ray from the eye through the fingers, sliding the model across the picture with its
// depth locked. On the hologram rig the hand and the model are in the same cubic foot of air (input.spatial,
// set by input/bridge.js). There the ray is the wrong tool - it left a teapot that would only go left and
// right - and each gesture follows the hand itself instead: carry it in three dimensions, turn it by going
// round it, stretch it by pulling away from its middle, and take hold of it by being AT it.
const spatial = () => input.spatial === true && input.mode === 'camera';
const REACH_CM = 4;             // fingers this near the model's box have hold of it, wherever the eye is
const MIN_RADIUS_CM = 3;        // nearer the model's axis than this, 'round it' and 'away from it' are noise
const modelCentre = () => new THREE.Box3().setFromObject(model.group).getCenter(new THREE.Vector3());
// Where a brush lands when the hand is really there: the model's surface on the hand's side, along the line
// from the model's middle out through the fingers. (Cast from far outside inward, so it finds the outer
// surface whether the fingers are just off it or have pushed through it.) Null when the fingers are more
// than NEAR_SURFACE_CM from that point - then the hand is pointing from a distance, and the sightline rules.
const NEAR_SURFACE_CM = 6;
function surfaceNearHand(grip, meshes, eye) {
  const c = modelCentre(), out = grip.clone().sub(c);
  if (out.lengthSq() < 1e-6) return null;
  out.normalize();
  raycaster.set(c.clone().addScaledVector(out, 200), out.clone().negate());
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit || hit.point.distanceTo(grip) > NEAR_SURFACE_CM) return null;
  hit.distance = eye.distanceTo(hit.point);      // consumers read this as distance from the EYE
  return hit;
}
const headingAbout = (grip, c) => (Math.hypot(grip.x - c.x, grip.z - c.z) >= MIN_RADIUS_CM ? Math.atan2(-(grip.z - c.z), grip.x - c.x) : null);

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
  if (SCULPT_TOOLS.has(tool.mode)) {
    // The brush is locked to the part the pinch landed on, the way Blender locks a stroke to the
    // active object: a stroke that wandered onto a neighbouring part halfway through would leave
    // two half-edits and one undo step that cannot put either of them back.
    const part = parts.ofMesh(target.mesh);
    sculpt.setMode(tool.mode);
    sculpt.setRadiusCm(tool.brush);
    sculpt.setMirror(tool.mirror);
    // The pinch point is where your fingers are, which is in the AIR in front of the surface. Every
    // brush but the grab family wants the point under the ray instead, and handing the grab family
    // a point that starts off the model anchors the pull to thin air, so the surface hit is what
    // goes in: the hand's travel from there is still the hand's travel.
    if (!sculpt.begin(input.eye, p.dir, { part, point3D: target.point, timeMs: now })) {
      notify(!sculpt.engineReady() ? 'One moment - the brushes are still loading'
        : part?.bindError ? `That part cannot be sculpted: ${part.bindError}`
        : 'Point at the model, then pinch to sculpt');
      return false;
    }
    action = { ...base, kind: 'stroke', mesh: target.mesh, mode: tool.mode, grip0: p.grip?.clone() || null,
               point0: target.point.clone() };
    return true;
  }
  // One tool, one property, one number on the badge. A gesture that changed two things at once was
  // quicker to reach and impossible to describe: "pull it toward you" meant nearer in one tool and
  // bigger in another, and the only way to know which you had just done was to look at the model.
  const hand3 = spatial() && p.grip ? { grip0: p.grip.clone(), centre0: modelCentre() } : null;
  if (tool.mode === 'rotate') {
    beginEdit();                                    // rotation is a property of the thing: undoable
    action = { ...base, kind: 'turn', rot0: model.rotY, aim0: rayPoint(p, target.dist).clone(), hand3,
               turn: 0, angPrev: hand3 ? headingAbout(hand3.grip0, hand3.centre0) : null };
  } else if (tool.mode === 'scale') {
    beginEdit();                                    // so is size
    action = { ...base, kind: 'scale', scale0: model.userScale, hand3,
               r0: hand3 ? hand3.grip0.distanceTo(hand3.centre0) : 0 };
  } else if (tool.mode === 'zoom') {
    // Where it stands is not what it is: no undo step. See model.beginMove().
    beginMove();
    action = { ...base, kind: 'zoom', startPos: root.position.clone(), hand3 };
  } else {
    beginMove();
    action = { ...base, kind: 'grab', startPos: root.position.clone(), hand3,
               offset: hand3 ? root.position.clone().sub(hand3.grip0) : root.position.clone().sub(rayPoint(p, target.dist)) };
  }
  return true;
}

function updateAction(p) {
  const root = action.root;
  if (action.kind === 'stroke') {
    // Every frame, not every hand sample: the engine does its own spacing along the stroke, so a
    // fast drag lays down as many dabs as the distance calls for and a still hand lays down none.
    // The brush point walks with your HAND, from where the stroke landed on the surface. Sending
    // the raw pinch point instead would start the brush wherever your fingers happen to be - in the
    // air, a hand-width in front of the clay - and a pull brush anchored there drags nothing.
    const p3 = action.grip0 && p.grip ? action.point0.clone().add(p.grip.clone().sub(action.grip0)) : null;
    if (sculpt.sample(input.eye, p.dir, { point3D: p3, timeMs: performance.now() })) action.moved = true;
    p.end = p.hit ? p.hit.point.clone() : p.end;
    return;
  }
  if (action.kind === 'turn') {
    // A turntable, and nothing but: how far your hand travels ACROSS the model is how far it turns.
    // TURN_PER_CM is set so a comfortable 20 cm sweep is most of a half turn, which is as much as
    // anyone wants to do without letting go.
    if (action.hand3 && p.grip) {
      // round it: the model turns by the angle your hand has gone about its axis, one for one - the way a
      // thing on a turntable is turned by its rim. Summed frame by frame so it cannot jump at 180 degrees,
      // and held while the hand is over the axis, where the angle means nothing.
      const ang = headingAbout(p.grip, action.hand3.centre0);
      if (ang !== null && action.angPrev !== null) { const d = ang - action.angPrev; action.turn += Math.atan2(Math.sin(d), Math.cos(d)); }
      action.angPrev = ang;
      setTransform({ rotY: action.rot0 + action.turn, userScale: model.userScale, position: root.position.clone() });
      p.end = p.grip.clone();
      return;
    }
    const at = rayPoint(p, action.dist);
    setTransform({ rotY: action.rot0 + (at.x - action.aim0.x) * TURN_PER_CM,
                   userScale: model.userScale, position: root.position.clone() });
    p.end = at;
    return;
  }
  if (action.kind === 'scale') {
    // How BIG the thing is. It does not move: the model stands where it stood, your distance to it
    // is unchanged, the room and the grid squares behind it do not shift, and a 10 cm teapot
    // becomes a 20 cm teapot in the same room. Pull it SCALE_DOUBLE_CM toward you and it doubles.
    if (action.hand3 && p.grip && action.r0 >= MIN_RADIUS_CM) {
      // stretch it: take it by the edge and pull away from its middle, and the edge comes with your fingers
      setTransform({ rotY: model.rotY, position: root.position.clone(),
                     userScale: action.scale0 * Math.max(0.2, p.grip.distanceTo(action.hand3.centre0) / action.r0) });
      p.end = p.grip.clone();
      return;
    }
    setTransform({ rotY: model.rotY, position: root.position.clone(),
                   userScale: action.scale0 * Math.pow(2, (p.handZ - action.handZ0) / SCALE_DOUBLE_CM) });
    return;
  }
  if (action.kind === 'zoom') {
    // How NEAR it is. The model keeps the size it is and travels through the room toward you: it
    // covers more of your view, it passes the grid squares behind it, and with pop-out on it comes
    // out through the glass. This is the only zoom available - the frustum is built from your eye
    // and the screen corners, so there is no field of view to widen, and inventing one would stop
    // the picture matching where your head is. Sideways is locked, so a zoom cannot drift.
    const wanted = action.startPos.clone();
    wanted.z += (p.handZ - action.handZ0) * (action.hand3 ? 1 : PUSH_GAIN);   // in the hand, it moves WITH the hand
    const zWanted = wanted.z;
    root.position.lerp(clampPosition(wanted), 0.5);
    // Pop-out is what allows it past the screen. It is off by default and invisible, so a pull that
    // runs into that wall reads as the model being stuck rather than as a setting: say so.
    action.atFront = zWanted > (S.popout ? 15 : -1) + 0.5;
    p.end = root.position.clone();
    return;
  }
  if (action.kind === 'grab') {
    // Carry it about the picture. The depth is held where it was - bringing it nearer is zoom, and
    // that is its own tool now, so a move can never quietly resize what you are looking at.
    if (action.hand3 && p.grip) {
      // in the hand: it goes where the fingers go, up, across and toward you alike, keeping the hold it was
      // taken by. (clampPosition keeps it on the stage and above the floor.)
      root.position.lerp(clampPosition(p.grip.clone().add(action.offset)), 0.5);
      p.end = p.grip.clone();
      return;
    }
    const wanted = rayPoint(p, action.dist).add(action.offset);
    wanted.z = action.startPos.z;
    root.position.lerp(clampPosition(wanted), 0.5);
    p.end = root.position.clone().sub(action.offset);
  }
}

// did the gesture actually change anything?
function changed(a) {
  const moved = (p, q, eps) => p.distanceTo(q) > eps;
  if (a.kind === 'stroke') return !!a.moved;
  if (a.kind === 'grab' || a.kind === 'zoom') return moved(a.root.position, a.startPos, 0.01);
  if (a.kind === 'turn') return Math.abs(model.rotY - a.rot0) > 1e-3;
  if (a.kind === 'scale') return Math.abs(model.userScale - a.scale0) > 1e-4;
  return moved(a.root.position, a.pos0, 0.01) || Math.abs(model.rotY - a.rot0) > 1e-3 || Math.abs(model.userScale - a.scale0) > 1e-3;
}

function endAction() {
  const a = action;
  action = null;
  if (!a) return;
  // A stroke's undo step comes from the engine, not from a placement snapshot, so it banks itself
  // (sculpting.end -> model.endStroke) whether or not any clay actually moved.
  if (a.kind === 'stroke') {
    const r = sculpt.end({ timeMs: performance.now() });
    if (!r.moved) notify(a.mode === 'smooth' ? 'Nothing to smooth there — pinch on the model and drag'
                                             : 'Nothing sculpted there — pinch on the model and drag');
    return;
  }
  if (!changed(a)) discardEdit();
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
  // A stroke cannot be thrown away as if it never happened - the clay has already moved - so it is
  // banked like any other stroke and stays undoable.
  if (a.kind === 'stroke') { sculpt.end({ timeMs: performance.now() }); return; }
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
  // the model went away, or the part being moved did (a new rev from Blender): drop the gesture.
  // A stroke has to be closed at the engine as well, or it stays live over a part that is gone and
  // the next pinch begins on top of it.
  if (action && (action.root !== model.group || (action.mesh && !meshes.includes(action.mesh)))) {
    const wasStroke = action.kind === 'stroke';
    action = null;
    if (wasStroke) sculpt.abort(); else endGrab();
  }

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
        // A brush in a hand that is AT the model works where the fingers are, not where the line from the eye
        // through them happens to land - which is the front of the model, however far round it you reached.
        if (spatial() && SCULPT_TOOLS.has(tool.mode) && p.grip) st.hit = surfaceNearHand(p.grip, meshes, eye) || st.hit;
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
        let target = p.hit ? { mesh: p.hit.object, point: p.hit.point, dist: p.hit.distance }
          : input.mode === 'camera' && aim && now - aim.t < AIM_MS && meshes.includes(aim.mesh) ? aim : null;
        // Fingers AT the model have hold of it even when the line from the eye through them misses - taking it
        // from the side, or from behind. (Not for the brushes: a stroke has to land on a surface.)
        if (!target && spatial() && p.grip && !SCULPT_TOOLS.has(tool.mode) && meshes.length) {
          const box = new THREE.Box3().setFromObject(model.group);
          if (box.distanceToPoint(p.grip) <= REACH_CM)
            target = { mesh: meshes[0], point: p.grip.clone(), dist: eye.distanceTo(p.grip) };
        }
        if (target) { per[p.id].consumed = !startAction(p, target, now); break; }
      }
    }
  }

  // The brush ring: where the clay will move, and how much of it. It stays up DURING a stroke as
  // well - that is when you most need to see whether the brush is still on the model - which is why
  // the hover raycast above skips the busy hand but this reads the stroke's own hit instead.
  if (SCULPT_TOOLS.has(tool.mode)) {
    const p = ps.find(q => q.hit) || (action?.kind === 'stroke' ? ps[action.pid] : null);
    const hit = p?.hit || (action?.kind === 'stroke' ? sculpt.overPart(eye, p?.dir || ps[0].dir) : null);
    if (p && hit) {
      const point = hit.point?.isVector3 ? hit.point : new THREE.Vector3(...hit.point);
      const normal = hit === p.hit ? p.normal : new THREE.Vector3(...hit.normal);
      brush = { point, normal, radius: tool.brush };
    }
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
