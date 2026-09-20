// SPDX-License-Identifier: GPL-3.0-or-later
// The app side of the sculpt engine: which parts are bound to it, what a pinch does in sculpt and
// smooth mode, and how a finished stroke lands in the model's undo.
//
// js/sculpt/ is the engine (Blender's brushes, paraphrased from the maths). It knows nothing about
// this app: no DOM, no parts registry, no tools, no undo stack. This file is the only place the two
// meet, which is why every unit conversion and every lifetime rule lives here rather than in both.
//
// UNITS. The box is centimetres (js/model.js: glTF metres x 100), the engine's own brush limits are
// physical (3 mm to 12 cm), so the engine is told how big a metre is here and clamps in our unit.
//
// LIFETIME. A part is welded into a sculpt proxy once, the first time anything needs it, and the
// handle lives on the Part (parts.js reserves `proxy` and `binding` for exactly this). A new rev
// from Blender replaces Part objects, so a handle whose part is no longer in the registry is
// detached rather than left holding a mesh nobody can see.

import { createSculptEngine } from './sculpt/index.js';
import { loadPresets } from './sculpt/presets.js';
import { getBrushForPreset } from './sculpt/brushes/registry.js';
import { parts, model, beginStroke as modelBeginStroke, endStroke as modelEndStroke } from './model.js';

const CM_PER_M = 100;

export const engine = createSculptEngine({ worldUnitsPerMetre: CM_PER_M });

// What the two brush tools brush with. 'extrude' is a pick - the word people use for building a form
// up out of a surface, and Clay Strips is the brush that does it - while 'smooth' is always Smooth,
// because it is a mode in its own right on the badge and in the grammar.
// Measured on the rig's own model, 4 cm brush, one hand pass of 8 cm: Grab pulls the surface 68 mm,
// Snake Hook 3.8 mm, Clay Strips 0.2 mm. Clay Strips is the right brush for BUILDING a form over
// many strokes with a pen; Grab is the one that does what a hand means by 'pull this out', because
// the clay simply follows your fingers. Say 'clay strips brush' to build up instead.
const DEFAULT_EXTRUDE_PRESET = 'Grab';
export const brushes = { extrude: DEFAULT_EXTRUDE_PRESET, smooth: 'Smooth' };

let presetsPromise = null;
let presetsReady = false;
/** Load presets.json once. Everything below works without it (the engine has a fallback), but the
 *  brush is only Blender's brush once the measured settings are in. */
export function ready() {
  if (!presetsPromise) {
    presetsPromise = loadPresets()
      .then(() => { presetsReady = true; setPreset(brushes.extrude); return true; })
      .catch((e) => { console.warn('sculpt presets did not load; using fallback settings', e); return false; });
  }
  return presetsPromise;
}
export const presetsLoaded = () => presetsReady;

// ---------------------------------------------------------------- parts

/** Weld one Part into a sculpt proxy, once. Returns the handle, or null if it cannot be bound. */
export function bind(part) {
  if (!part || !part.mesh) return null;
  if (part.proxy && part.binding) return part.handle || null;
  try {
    const handle = engine.attach(part.mesh, { id: part.id });
    part.proxy = handle.proxy;
    part.binding = handle.binding;
    part.handle = handle;
    return handle;
  } catch (e) {
    console.warn(`sculpt: could not bind part "${part.name}"`, e);
    part.bindError = e?.message || String(e);
    return null;
  }
}

/** Bind whatever is on screen and drop handles for parts that went away with a new rev.
 *  Called when a scene loads rather than at the first pinch: welding a 200k-triangle part takes
 *  long enough to be felt as a stutter, and the brush ring needs the proxies before anyone pinches
 *  anything (engine.hover only sees attached parts). */
export function syncParts() {
  const live = new Set();
  for (const part of parts.list()) {
    live.add(part.id);
    // A part whose mesh was swapped under the same id (same object, new geometry) has to be rebound,
    // or the proxy would be a welded copy of a mesh that is no longer drawn.
    if (part.handle && part.handle.object !== part.mesh) {
      part.handle.detach();
      part.handle = part.proxy = part.binding = null;
    }
    if (!part.handle) bind(part);
  }
  for (const handle of [...engine.parts.values()]) if (!live.has(handle.id)) handle.detach();
  return engine.parts.size;
}

// ---------------------------------------------------------------- brush

export function setPreset(name) {
  const kernel = getBrushForPreset(name);
  if (!kernel) return null;
  brushes.extrude = name;
  if (mode !== 'smooth') applyBrush();
  return name;
}

let mode = 'extrude';
function applyBrush() {
  const name = mode === 'smooth' ? brushes.smooth : brushes.extrude;
  const kernel = getBrushForPreset(name);
  engine.setBrush(kernel ? kernel.key : 'draw');
  return name;
}

/** Called when the tool mode changes; 'move' and 'part' leave the engine alone. */
export function setMode(next) {
  if (next !== 'extrude' && next !== 'smooth') return mode;
  mode = next;
  applyBrush();
  return mode;
}

/** tool.brush is a radius in centimetres, which is what the world is measured in here. */
export const setRadiusCm = (cm) => engine.setRadiusWorld(cm);
export const radiusCm = () => engine.getRadiusWorld();
/** Mirror across the model's own middle. Blender's X is the model's left-right, which after the
 *  glTF frame is three's X as well, so the mirror the user asks for is the engine's x. */
export const setMirror = (on) => engine.setSymmetry(on ? { x: true } : {});

// ---------------------------------------------------------------- strokes

const stroke = { live: false, partId: null, moved: false, t0: 0, dabs: 0 };
export const sculpting = () => stroke.live;

const rayOf = (origin, direction) => ({
  origin: [origin.x, origin.y, origin.z],
  direction: [direction.x, direction.y, direction.z],
});
const xyz = (v) => (v ? [v.x, v.y, v.z] : null);

/**
 * Start a stroke on the part under the ray.
 * @param {THREE.Vector3} origin  the eye
 * @param {THREE.Vector3} direction  eye -> fingertip, normalised
 * @param {object} o  {point3D, pressure, timeMs, part}
 * @returns {boolean} whether a stroke started (false = the ray missed every bound part)
 */
export function begin(origin, direction, o = {}) {
  syncParts();
  const part = o.part || null;
  const worldRay = rayOf(origin, direction);
  // Without a part the engine picks by raycast; with one, the stroke is locked to it (Blender's
  // active object), which is what a pinch on a hovered part means.
  const handle = part?.handle || null;
  const input = { worldRay, point3D: xyz(o.point3D), pressure: o.pressure ?? 1, timeMs: o.timeMs ?? performance.now() };
  let started = null;
  try { started = engine.beginStroke(handle ? { ...input, part: handle } : input); } catch (e) { console.warn('sculpt: begin failed', e); }
  if (!started) return false;
  stroke.live = true;
  stroke.partId = engine.state.stroke?.part ?? part?.id ?? null;
  stroke.moved = false;
  stroke.dabs = 0;
  stroke.t0 = input.timeMs;
  modelBeginStroke();
  return true;
}

/** One sample of a live stroke. Safe to call every frame; the engine does its own spacing. */
export function sample(origin, direction, o = {}) {
  if (!stroke.live) return false;
  let moved = false;
  try {
    moved = engine.sampleStroke({
      worldRay: rayOf(origin, direction), point3D: xyz(o.point3D),
      pressure: o.pressure ?? 1, timeMs: o.timeMs ?? performance.now(),
    });
  } catch (e) { console.warn('sculpt: sample failed', e); }
  if (moved) { stroke.moved = true; stroke.dabs++; markDirty(); }
  return moved;
}

/** End the stroke and push its undo record. Returns {moved, dabs, ms} for the HUD. */
export function end(o = {}) {
  if (!stroke.live) return { moved: false, dabs: 0, ms: 0 };
  // No last sample: endStroke(input) would re-run the stepper, and a release carries a worse aim
  // than the frame before it (the fingertip moves as the pinch opens).
  let record = null;
  try { record = engine.endStroke(); } catch (e) { console.warn('sculpt: end failed', e); }
  // Records orphaned mid-stroke (a re-fired begin, a filter) are the page's to keep, or the edits
  // they describe can never be taken back.
  const orphans = engine.drainRecords();
  const all = [...orphans, record].filter(Boolean);
  const out = { moved: stroke.moved, dabs: stroke.dabs, ms: (o.timeMs ?? performance.now()) - stroke.t0 };
  stroke.live = false;
  if (all.length) {
    markDirty();
    modelEndStroke(undoStep(all, mode));
  } else {
    modelEndStroke(null);
  }
  return out;
}

/** Abandon a live stroke (the model went away, the hand vanished) without leaving the engine mid-stroke. */
export function abort() {
  if (!stroke.live) return false;
  end({});
  return true;
}

// One undo step for the app's history, however many engine records the stroke produced. The label is
// what the HUD says when it is undone.
function undoStep(records, kind) {
  return {
    label: kind === 'smooth' ? 'smooth' : 'extrude',
    undo() {
      for (let i = records.length - 1; i >= 0; i--) engine.applyHistory(records[i], 'undo');
      markDirty();
    },
    redo() {
      for (const r of records) engine.applyHistory(r, 'redo');
      markDirty();
    },
  };
}

// The mesh no longer matches the .blend it came from, which is what tells a save to send it back.
function markDirty() {
  const part = stroke.partId ? parts.get(stroke.partId) : null;
  if (part) part.dirty.mesh = true;
}

// ---------------------------------------------------------------- the ring

// Where the brush would land is drawn by js/handviz.js, from the hit interaction.js already has:
// one ring, one raycast, and it keeps working in move mode where this module is not involved.
// What lives here instead is the one thing handviz cannot know - whether the ray is over a part
// the ENGINE has bound, which is what decides if a pinch will sculpt or do nothing at all.
export function overPart(origin, direction) {
  if (!model.group) return null;
  try {
    const hit = engine.hover(rayOf(origin, direction));
    return hit && hit.hit ? hit : null;
  } catch (e) { return null; }
}

export const debug = { engine, stroke, brushes, get mode() { return mode; } };
