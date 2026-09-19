// The current model: its part list, the meshes in the scene, where it stands, and undo.
import * as THREE from 'three';
import { S } from './settings.js';
import { scene, rect, boxDepth } from './view.js';
import { buildModelGroup, disposeGroup } from './builder.js';

const HOME = { fx: 0, fy: 0, fz: 0.5 };   // centre of the floor, halfway back
const SPIN_SPEED = 0.4;                    // rad/s
const MAX_UNDO = 50;

export const model = {
  spec: null,       // { name, parts } in cm, see spec.js
  group: null,      // root THREE.Group in the scene, null when empty
  meshes: [],       // one per part, for raycasting
  place: { ...HOME },   // where it stands, as fractions of the box, so it survives window resizes
  userScale: 1,     // "bigger" / "smaller" on top of the automatic fit
  rotY: 0,
  spinning: true,
};
let grabbing = false;
const history = [];

// drop line to the floor and a ring under the model: the same depth cues the demo objects had
const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x3a8fb8, transparent: true, opacity: 0.8 }));
stick.frustumCulled = false;   // geometry is rewritten every frame
const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2;
stick.visible = ring.visible = false;
scene.add(stick, ring);

const snapshot = () => JSON.stringify({ spec: model.spec, place: model.place, userScale: model.userScale,
                                        rotY: model.rotY, spinning: model.spinning });
function remember() { history.push(snapshot()); if (history.length > MAX_UNDO) history.shift(); }

function rebuild() {
  if (model.group) { scene.remove(model.group); disposeGroup(model.group); }
  model.group = null; model.meshes = [];
  if (model.spec) {
    model.group = buildModelGroup(model.spec);
    model.meshes = [...model.group.children];
    scene.add(model.group);
  }
  layout();
}

export function clampPosition(v) {
  v.x = THREE.MathUtils.clamp(v.x, rect.x0 + 1, rect.x1 - 1);
  v.y = THREE.MathUtils.clamp(v.y, rect.y0, rect.y1 - 1);
  v.z = THREE.MathUtils.clamp(v.z, -boxDepth + 1, S.popout ? 15 : -1);
  return v;
}

// Scale the model to fit the box and put it where `place` says. Call after the box or the model changes.
export function layout() {
  const g = model.group;
  stick.visible = ring.visible = !!g;
  if (!g) return;
  const { w, h, cx, y0 } = rect, r = g.userData.radius;
  const fit = Math.min(0.62 * w / (2 * r), 0.62 * h / g.userData.height, 0.75 * boxDepth / (2 * r));
  g.scale.setScalar(fit * model.userScale);
  g.position.copy(clampPosition(new THREE.Vector3(cx + model.place.fx * w, y0 + model.place.fy * h, -model.place.fz * boxDepth)));
  g.rotation.y = model.rotY;
  ring.scale.setScalar(Math.max(0.5, r * fit * model.userScale));
}

function syncPlace() {
  const p = model.group.position;
  model.place = { fx: (p.x - rect.cx) / rect.w, fy: (p.y - rect.y0) / rect.h, fz: -p.z / boxDepth };
}

// ---------- edits (each one is undoable) ----------
export function setModel(spec, { keepPlacement = false } = {}) {
  remember();
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

// "add a cube": puts it to the right of the current model; `fresh` starts a new model instead
export function addPrimitive(shape, { word = shape, fresh = false } = {}) {
  const base = fresh ? null : model.spec;
  const b = base && model.group.userData.bounds;
  const s = b ? Math.max(1, 0.35 * Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)) : 10;
  const [dims, half, cy] = PRIMITIVE[shape](s);
  const n = (base?.parts.length ?? 0) + 1;
  const part = {
    name: `${word}_${n}`, shape, dims, points: [],
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
  remember();
  const parts = mesh ? model.spec.parts.filter(p => p.name !== mesh.name) : [];
  model.spec = parts.length ? { ...model.spec, parts } : null;
  rebuild();
  return true;
}

export function clearModel() {
  if (!model.spec) return false;
  remember();
  model.spec = null;
  rebuild();
  return true;
}

export function scaleBy(f) {
  if (!model.spec) return false;
  remember();
  model.userScale = THREE.MathUtils.clamp(model.userScale * f, 0.1, 5);
  layout();
  return true;
}

export function setSpin(on) { model.spinning = on; }

export function resetPlacement() {
  if (!model.spec) return;
  remember();
  Object.assign(model, { place: { ...HOME }, userScale: 1, rotY: 0 });
  layout();
}

export function undo() {
  const s = history.pop();
  if (!s) return false;
  Object.assign(model, JSON.parse(s));
  rebuild();
  return true;
}

// ---------- hand grabs (interaction.js moves model.group directly while pinched) ----------
export function beginGrab() { remember(); grabbing = true; model.spinning = false; }
export function endGrab() { grabbing = false; if (model.group) syncPlace(); }

// per frame: spin, depth cues
export function update(dt) {
  const g = model.group;
  if (!g) return;
  if (model.spinning && !grabbing) { model.rotY += dt * SPIN_SPEED; g.rotation.y = model.rotY; }
  const p = g.position, floorY = rect.y0;
  stick.geometry.setFromPoints([p, new THREE.Vector3(p.x, floorY, p.z)]);
  ring.position.set(p.x, floorY + 0.05, p.z);
}

// brighter on the pointed-at part, a little on the rest of the model, most while grabbed
export function highlight(hovered, grabbed) {
  for (const m of model.meshes) {
    m.material.emissiveIntensity = grabbed ? 0.55 : m === hovered ? 0.5 : hovered ? 0.25 : 0.12;
  }
}
