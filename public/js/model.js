// The model on screen: the GLB from the hidden Blender (as parts, see scene/parts.js), where it stands in the
// box, spin, and a small undo for placement and local part edits. Blender holds the real model; the unified
// undo (strokes, part ops, Fable builds) arrives with undo.js in M2.
import * as THREE from 'three';
import { S } from './settings.js';
import { scene, rect, boxDepth } from './view.js';
import { createParts } from './scene/parts.js';

const HOME = { fx: 0, fy: 0, fz: 0.5 };   // centre of the floor, halfway back
const SPIN_SPEED = 0.4;                    // rad/s
const MAX_UNDO = 50;
const DEG = Math.PI / 180;
const CM_PER_M = 100;                      // glTF is metres, the box is centimetres

export const parts = createParts();

// display (where it stands, its turn, metres -> cm x fit) -> pivot (puts the model's footprint centre on the
// floor at the display origin) -> parts.root (the glTF frame, untouched) -> one mesh per part
const display = new THREE.Group();
const pivot = new THREE.Group();
display.name = 'display';
pivot.name = 'pivot';
display.add(pivot);
pivot.add(parts.root);

export const model = {
  group: null,          // the display parent while a model is loaded, null when empty
  get meshes() { return parts.meshes(); },   // visible parts, for pointing
  name: '',             // the model's top object in Blender, e.g. "Utah Teapot"
  rev: null,            // the /api/scene rev on screen
  sym: { x: false, y: false, z: false },   // symmetry Blender detected, in three's axes
  focusId: null,        // "focus on that": fit this part in the box instead of the whole model
  place: { ...HOME },   // where it stands, as fractions of the box, so it survives window resizes
  userScale: 1,         // "bigger" / "smaller" / two-hand resize on top of the automatic fit
  rotY: 0,
  spinning: true,
};
let editing = false;   // a hand is mid-gesture: don't spin
let editSnap = null;   // the undo step the current gesture pushed
let fit = 1;           // automatic scale that makes the model fit the box
const history = [];    // steps: { undo(), drop?() }, newest last

// interaction.js registers this: commit whatever gesture is in progress before the parts change under it
let flushGesture = () => {};
export const setGestureFlush = fn => { flushGesture = fn; };

// drop line to the floor and a ring under the model: depth cues
const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x3a8fb8, transparent: true, opacity: 0.8, toneMapped: false }));
stick.frustumCulled = false;   // geometry is rewritten every frame
const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, toneMapped: false }));
ring.rotation.x = -Math.PI / 2;
stick.visible = ring.visible = false;
scene.add(stick, ring);

// ---------- undo ----------
function push(step) {
  history.push(step);
  while (history.length > MAX_UNDO) history.shift().drop?.();
}
function clearHistory() {
  while (history.length) history.pop().drop?.();
  editSnap = null;
}

// placement, plus one part's transform when a gesture is about to move it
function placementStep(mesh = null) {
  const snap = { place: { ...model.place }, userScale: model.userScale, rotY: model.rotY,
                 spinning: model.spinning, focusId: model.focusId };
  const partSnap = mesh && { position: mesh.position.clone(), quaternion: mesh.quaternion.clone() };
  return {
    undo() {
      const refit = snap.focusId !== model.focusId;
      Object.assign(model, snap, { place: { ...snap.place } });
      if (partSnap) { mesh.position.copy(partSnap.position); mesh.quaternion.copy(partSnap.quaternion); }
      if (refit) measure();
      layout();
    },
  };
}
export function remember(mesh = null) { push(placementStep(mesh)); }

export function undo() {
  flushGesture();
  const step = history.pop();
  if (!step) return false;
  step.undo();
  editing = false;
  editSnap = null;
  return true;
}

// ---------- the model from Blender ----------
// A new rev: swaps in only the parts that changed (parts.swap) and keeps the placement.
export function showScene(loaded) {
  flushGesture();
  const wasEmpty = !parts.size;
  const report = parts.swap(loaded.parts);
  Object.assign(model, { name: loaded.name || '', sym: loaded.sym || model.sym, rev: loaded.rev ?? model.rev });
  clearHistory();   // local steps don't carry over a Blender change; "go back a version" does that
  if (model.focusId && !parts.get(model.focusId)) model.focusId = null;
  if (wasEmpty) Object.assign(model, { place: { ...HOME }, userScale: 1, rotY: 0, spinning: true, focusId: null });
  attach();
  return report;
}

export function clearScene() {
  flushGesture();
  parts.clear();
  clearHistory();
  model.focusId = null;
  attach();
}

// in the scene while there's something to show
function attach() {
  if (!parts.size) {
    scene.remove(display);
    model.group = null;
    stick.visible = ring.visible = false;
    return;
  }
  if (!model.group) { scene.add(display); model.group = display; }
  measure();
  layout();
}

// ---------- placement ----------
export function clampPosition(v) {
  v.x = THREE.MathUtils.clamp(v.x, rect.x0 + 1, rect.x1 - 1);
  v.y = THREE.MathUtils.clamp(v.y, rect.y0, rect.y1 - 1);
  v.z = THREE.MathUtils.clamp(v.z, -boxDepth + 1, S.popout ? 15 : -1);
  return v;
}

// Size and footprint of the model (or the focused part). Only when the set of parts changes: re-measuring after
// a part move would make the whole model jump.
function measure() {
  const focus = model.focusId && parts.get(model.focusId);
  const box = parts.bounds(focus ? [focus] : null);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  pivot.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  display.userData.height = Math.max(size.y * CM_PER_M, 1e-3);   // cm
  display.userData.radius = Math.max(Math.hypot(size.x, size.z) / 2 * CM_PER_M, 1e-3);   // footprint around the spin axis, cm
}

function applyTransform() {
  const g = model.group;
  g.scale.setScalar(CM_PER_M * fit * model.userScale);
  g.rotation.y = model.rotY;
  ring.scale.setScalar(Math.max(0.5, g.userData.radius * fit * model.userScale));
}

// Scale the model to fit the box and put it where `place` says. Call after the box or the model changes.
export function layout() {
  const g = model.group;
  stick.visible = ring.visible = !!g;
  if (!g) return;
  const { w, h, cx, y0 } = rect, r = g.userData.radius;
  fit = Math.min(0.62 * w / (2 * r), 0.62 * h / g.userData.height, 0.75 * boxDepth / (2 * r));
  g.position.copy(clampPosition(new THREE.Vector3(cx + model.place.fx * w, y0 + model.place.fy * h, -model.place.fz * boxDepth)));
  applyTransform();
}

function syncPlace() {
  const p = model.group.position;
  model.place = { fx: (p.x - rect.cx) / rect.w, fy: (p.y - rect.y0) / rect.h, fz: -p.z / boxDepth };
}

export function scaleBy(f) {
  if (!model.group) return false;
  remember();
  model.userScale = THREE.MathUtils.clamp(model.userScale * f, 0.1, 5);
  applyTransform();
  return true;
}

export function turnBy(deg) {
  if (!model.group) return false;
  remember();
  model.rotY += deg * DEG;
  model.spinning = false;
  applyTransform();
  return true;
}

export function setSpin(on) { model.spinning = on; }

export function resetPlacement() {
  if (!model.group) return;
  remember();
  Object.assign(model, { place: { ...HOME }, userScale: 1, rotY: 0, focusId: null });
  measure();
  layout();
}

// "focus on that": the part fills the box (null: back to the whole model)
export function focusPart(part) {
  if (!model.group) return false;
  remember();
  Object.assign(model, { focusId: part ? part.id : null, place: { ...HOME }, userScale: 1 });
  measure();
  layout();
  return true;
}

// ---------- local part edits: this view only until sync.js sends them to Blender (M4) ----------
export function deletePart(part) {
  flushGesture();
  parts.remove(part);
  if (model.focusId === part.id) model.focusId = null;
  push({ undo: () => { parts.restore(part); attach(); }, drop: () => parts.dispose([part]) });
  attach();
  return true;
}

export function duplicatePart(part) {
  flushGesture();
  const copy = parts.duplicate(part);
  push({ undo: () => { parts.remove(copy); parts.dispose([copy]); attach(); } });
  attach();
  return copy;
}

// returns false when clay view is hiding the result
export function quickColor(part, hex) {
  const before = part.materials.map(m => m.color?.getHex());
  const wasDirty = part.dirty.material;
  const onScreen = parts.recolor(part, hex);
  push({ undo: () => {
    part.materials.forEach((m, i) => { if (m.color && before[i] !== undefined) m.color.setHex(before[i]); });
    part.dirty.material = wasDirty;
  } });
  return onScreen;
}

// "quick metal", "quick matte": the same instant local edit for how the surface behaves, not its colour
export function quickFinish(part, finish) {
  const keys = Object.keys(finish);
  const before = part.materials.map(m => Object.fromEntries(keys.filter(k => k in m).map(k => [k, m[k]])));
  const wasDirty = part.dirty.material;
  const onScreen = parts.setFinish(part, finish);
  push({ undo: () => {
    part.materials.forEach((m, i) => {
      for (const [k, v] of Object.entries(before[i])) m[k] = v;
      m.needsUpdate = true;
    });
    part.dirty.material = wasDirty;
  } });
  return onScreen;
}

// ---------- hand gestures (interaction.js moves things directly, then commits here) ----------
// Start of any gesture: one undo step. The turntable holds still by itself while `editing` (see update), and it's
// only really stopped when the gesture commits, so a tap that moves nothing leaves the spin as it found it.
export function beginEdit(mesh = null) { remember(mesh); editSnap = history.at(-1); editing = true; }

// A gesture being abandoned: drop the step that beginEdit pushed and put things back as they were.
// A voice command that landed mid-gesture (turn, resize) pushed its own step on top; that one is kept.
export function cancelEdit() {
  const i = history.lastIndexOf(editSnap);
  if (i >= 0 && i === history.length - 1) history.pop().undo();
  else if (i >= 0) history.splice(i, 1);
  editSnap = null;
  editing = false;
  if (model.group) layout();
}

// A gesture that moved the model: it stays where you put it, so the turntable stops. That's part of the step
// beginEdit pushed, so undo brings the spin back with the placement.
export function endGrab() { editing = false; editSnap = null; model.spinning = false; if (model.group) syncPlace(); }

// A gesture that changed nothing (a touch, a pinch without moving): leave no empty step in undo.
export function discardEdit() {
  if (editSnap && history.at(-1) === editSnap) history.pop();
  editSnap = null;
  editing = false;
}

export function commitPartPosition(mesh) {
  const part = parts.ofMesh(mesh);
  if (part) part.dirty.xform = true;
  editing = false;
  editSnap = null;
  model.spinning = false;
}

// two-hand turn / resize / move, applied live
export function setTransform({ rotY, userScale, position }) {
  model.rotY = rotY;
  model.userScale = THREE.MathUtils.clamp(userScale, 0.1, 5);
  model.group.position.copy(clampPosition(position.clone()));
  applyTransform();
}

// per frame: spin, depth cues
export function update(dt) {
  const g = model.group;
  if (!g) return;
  if (model.spinning && !editing) { model.rotY += dt * SPIN_SPEED; g.rotation.y = model.rotY; }
  const p = g.position, floorY = rect.y0;
  stick.geometry.setFromPoints([p, new THREE.Vector3(p.x, floorY, p.z)]);
  ring.position.set(p.x, floorY + 0.05, p.z);
}
