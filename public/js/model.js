// The current model: its part list, sculpted shapes, the meshes in the scene, where it stands, and undo.
import * as THREE from 'three';
import { S } from './settings.js';
import { scene, rect, boxDepth } from './view.js';
import { buildModelGroup, disposeGroup } from './builder.js';

const HOME = { fx: 0, fy: 0, fz: 0.5 };   // centre of the floor, halfway back
const SPIN_SPEED = 0.4;                    // rad/s
const MAX_UNDO = 50;
const DEG = Math.PI / 180;

export const model = {
  spec: null,       // { name, parts } in cm, see spec.js
  sculpts: new Map(),   // part name -> Float32Array of sculpted vertex positions (cm, part-local); never mutated, only replaced
  group: null,      // root THREE.Group in the scene, null when empty
  meshes: [],       // one per part, for raycasting
  place: { ...HOME },   // where it stands, as fractions of the box, so it survives window resizes
  userScale: 1,     // "bigger" / "smaller" / two-hand resize on top of the automatic fit
  rotY: 0,
  spinning: true,
};
let editing = false;   // a hand is mid-gesture: don't spin
let editSnap = null;   // the undo step the current gesture pushed
let fit = 1;           // automatic scale that makes the model fit the box
const history = [];

// interaction.js registers this: commit whatever gesture is in progress before the model gets rebuilt
let flushGesture = () => {};
export const setGestureFlush = fn => { flushGesture = fn; };

// drop line to the floor and a ring under the model: depth cues
const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x3a8fb8, transparent: true, opacity: 0.8 }));
stick.frustumCulled = false;   // geometry is rewritten every frame
const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2;
stick.visible = ring.visible = false;
scene.add(stick, ring);

// ---------- undo ----------
function snapshot() {
  const { spec, place, userScale, rotY, spinning } = model;
  return { state: JSON.stringify({ spec, place, userScale, rotY, spinning }), sculpts: new Map(model.sculpts) };
}
function restore(s) { Object.assign(model, JSON.parse(s.state)); model.sculpts = s.sculpts; }
export function remember() { history.push(snapshot()); if (history.length > MAX_UNDO) history.shift(); }

export function undo() {
  const s = history.pop();
  if (!s) return false;
  restore(s);
  editing = false;
  editSnap = null;
  rebuild();
  return true;
}

function rebuild() {
  if (model.group) { scene.remove(model.group); disposeGroup(model.group); }
  model.group = null; model.meshes = [];
  if (model.spec) {
    model.group = buildModelGroup(model.spec, { sculpts: model.sculpts });
    model.meshes = [...model.group.children];
    scene.add(model.group);
  }
  layout();
}

// ---------- placement ----------
export function clampPosition(v) {
  v.x = THREE.MathUtils.clamp(v.x, rect.x0 + 1, rect.x1 - 1);
  v.y = THREE.MathUtils.clamp(v.y, rect.y0, rect.y1 - 1);
  v.z = THREE.MathUtils.clamp(v.z, -boxDepth + 1, S.popout ? 15 : -1);
  return v;
}

function applyTransform() {
  const g = model.group;
  g.scale.setScalar(fit * model.userScale);
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

// The parts' bounds in the spec's own coordinates (cm), including any sculpting.
function specBounds() {
  const box = new THREE.Box3(), shift = model.group.userData.shift;
  for (const m of model.meshes) {
    m.updateMatrix();
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix));
  }
  box.min.sub(shift); box.max.sub(shift);
  return box;
}

const updatePart = (name, fn) => ({ ...model.spec, parts: model.spec.parts.map(p => (p.name === name ? fn(p) : p)) });
const round = v => Math.round(v * 1000) / 1000;

// ---------- whole-model edits (each one is undoable) ----------
// A "change" request comes back as a whole new part list; keep a sculpt when its part kept the same shape.
function carrySculpts(oldSpec, newSpec) {
  const same = (a, b) => a && b && a.shape === b.shape && JSON.stringify(a.dims) === JSON.stringify(b.dims)
                                && JSON.stringify(a.points) === JSON.stringify(b.points);
  const kept = new Map();
  for (const [name, arr] of model.sculpts) {
    if (same(oldSpec.parts.find(p => p.name === name), newSpec.parts.find(p => p.name === name))) kept.set(name, arr);
  }
  return kept;
}
export const sculptedNames = () => [...model.sculpts.keys()];

export function setModel(spec, { keepPlacement = false, keepSculptsFrom = null } = {}) {
  flushGesture();
  remember();
  model.sculpts = keepSculptsFrom ? carrySculpts(keepSculptsFrom, spec) : new Map();
  model.spec = spec;
  if (!keepPlacement) Object.assign(model, { place: { ...HOME }, userScale: 1, rotY: 0, spinning: true });
  rebuild();
}

const PALETTE = ['#ffb23e', '#35d0ff', '#ff5d8f', '#7cff9b', '#c79bff', '#ffe08a'];
// shape -> [dims for size s, half-width, centre height] so the new part stands on the floor
const PRIMITIVE = {
  box:      s => [[s, s, s], s / 2, s / 2],
  sphere:   s => [[s / 2], s / 2, s / 2],
  cylinder: s => [[s / 2, s / 2, s], s / 2, s / 2],
  cone:     s => [[s / 2, s], s / 2, s / 2],
  torus:    s => [[s * 0.4, s * 0.12, 360], s * 0.52, s * 0.52],
  capsule:  s => [[s * 0.3, s * 0.6], s * 0.3, s * 0.6],
};
const uniqueName = base => { let n = base, k = 2; while (model.spec?.parts.some(p => p.name === n)) n = `${base}_${k++}`; return n; };

// "add a cube": puts it to the right of the current model; `fresh` starts a new model instead
export function addPrimitive(shape, { word = shape, fresh = false } = {}) {
  flushGesture();
  const base = fresh ? null : model.spec;
  const b = base && specBounds();
  const s = b ? Math.max(1, 0.35 * Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)) : 10;
  const [dims, half, cy] = PRIMITIVE[shape](s);
  const n = (base?.parts.length ?? 0) + 1;
  const part = {
    name: base ? uniqueName(`${word}_${n}`) : `${word}_1`, shape, dims, points: [],
    position: b ? [b.max.x + half + s * 0.1, b.min.y + cy, (b.min.z + b.max.z) / 2] : [0, cy, 0],
    rotation: [0, 0, 0], color: PALETTE[(n - 1) % PALETTE.length],
  };
  if (base) {
    remember();
    model.spec = { ...base, parts: [...base.parts, part] };
    rebuild();
  } else {
    setModel({ name: word, parts: [part] });
  }
  return part.name;
}

// removes one part, or the whole model when no part is given
export function deletePart(mesh) {
  if (!model.spec) return false;
  flushGesture();
  remember();
  const parts = mesh ? model.spec.parts.filter(p => p.name !== mesh.name) : [];
  model.spec = parts.length ? { ...model.spec, parts } : null;
  model.sculpts = new Map([...model.sculpts].filter(([name]) => parts.some(p => p.name === name)));
  rebuild();
  return true;
}

export function clearModel() {
  if (!model.spec) return false;
  flushGesture();
  remember();
  model.spec = null;
  model.sculpts = new Map();
  rebuild();
  return true;
}

export function scaleBy(f) {
  if (!model.spec) return false;
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
  if (!model.spec) return;
  remember();
  Object.assign(model, { place: { ...HOME }, userScale: 1, rotY: 0 });
  layout();
}

// ---------- single-part edits: pointed at by hand, applied in place (no rebuild, so nothing jumps) ----------
export function recolorPart(mesh, hex) {
  remember();
  model.spec = updatePart(mesh.name, p => ({ ...p, color: hex }));
  mesh.material.color.set(hex);
  mesh.material.emissive.set(hex);
}

export function duplicatePart(mesh) {
  const part = model.spec.parts.find(p => p.name === mesh.name);
  if (!part) return null;
  flushGesture();
  remember();
  mesh.updateMatrix();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const width = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrix).getSize(new THREE.Vector3()).x;
  const name = uniqueName(`${part.name}_copy`);
  const copy = { ...part, name, position: [round(part.position[0] + width * 1.1), part.position[1], part.position[2]] };
  model.spec = { ...model.spec, parts: [...model.spec.parts, copy] };
  if (model.sculpts.has(part.name)) model.sculpts = new Map(model.sculpts).set(name, model.sculpts.get(part.name));
  rebuild();
  return name;
}

// ---------- hand gestures (interaction.js moves meshes directly, then commits here) ----------
// Start of any gesture: one undo step, and the model holds still while you work on it.
export function beginEdit() { remember(); editSnap = history.at(-1); editing = true; model.spinning = false; }

// A gesture being abandoned: drop the step that beginEdit pushed and put things back as they were.
// The caller has already undone its own changes to the geometry. A voice command that landed mid-gesture
// (turn, recolour, resize) pushed its own step on top; that one is kept.
export function cancelEdit() {
  const i = history.lastIndexOf(editSnap);
  if (i >= 0 && i === history.length - 1) restore(history.pop());
  else if (i >= 0) { model.spinning = JSON.parse(editSnap.state).spinning; history.splice(i, 1); }
  editSnap = null;
  editing = false;
  if (model.group) layout();
}

export function endGrab() { editing = false; editSnap = null; if (model.group) syncPlace(); }

// A gesture that changed nothing (a touch, a pinch without moving): leave no empty step in undo.
export function discardEdit() {
  if (editSnap && history.at(-1) === editSnap) history.pop();
  editSnap = null;
  editing = false;
}

export function commitPartPosition(mesh) {
  const p = mesh.position.clone().sub(model.group.userData.shift);
  model.spec = updatePart(mesh.name, part => ({ ...part, position: [round(p.x), round(p.y), round(p.z)] }));
  editing = false;
  editSnap = null;
}

export function commitSculpt(mesh) {
  model.sculpts = new Map(model.sculpts).set(mesh.name, mesh.geometry.attributes.position.array.slice());
  editing = false;
  editSnap = null;
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

// brightest on the part being worked on, bright on the pointed-at part, a little on the rest
export function highlight({ hovered = null, active = null, all = false } = {}) {
  for (const m of model.meshes) {
    m.material.emissiveIntensity = all ? 0.5 : m === active ? 0.4 : m === hovered ? 0.45 : (hovered || active) ? 0.2 : 0.12;
  }
}
