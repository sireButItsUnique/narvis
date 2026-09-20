// SPDX-License-Identifier: GPL-3.0-or-later
// holosculpt - Blender's sculpt engine, driven by a hand in the air.
// Paraphrased, from the maths, from Blender @235621e (see ./NOTICE for the file list).
// Blender is GPL-2.0-or-later; this module is distributed as GPL-3.0-or-later.
//
// ============================== THE API THE PAGE USES ==============================
//
//   attach(part, options?) -> handle
//       part: a three.js Mesh, or the Group of primitives of one multi-material part, or
//             {id, geometries, matrixWorld}. The part's world matrix is read from the object (or
//             options.matrixWorld); bake any non-uniform node scale into the geometry first.
//       options: {id, matrixWorld, rootMatrixWorld, selfSymmetric, vidAttribute}
//       Welds the render geometry into a sculpt proxy and keeps the map back. Call once per part.
//       handle: {id, proxy, binding, detach(), sync()}
//
//   hover(worldRay) -> {hit, point, normal, radiusWorld, part} | {hit:false}
//       worldRay: {origin:[x,y,z]|Vector3, direction:[x,y,z]|Vector3}. Drives the brush ring.
//
//   beginStroke(input) / sampleStroke(input) / endStroke(input?)
//       input: {worldRay, point3D, pressure, timeMs, part}. A sample carrying a non-finite number
//       (MediaPipe dropping a landmark, a divide by a zero-length gaze vector) is REJECTED whole:
//       the stroke stays alive and the mesh is untouched.
//         worldRay  - eye -> fingertip ray, used to place each dab on the surface
//         point3D   - the 3D pinch point (world). The grab family deforms by ITS delta; other
//                     brushes fall back to the surface point under the ray.
//         pressure  - 0..1, ignored unless setPressureEnabled(true); default 1 = Blender's mouse
//         timeMs    - sample timestamp, so the stabiliser is frame-rate independent
//       beginStroke locks the stroke to one part (Blender's active object). endStroke returns the
//       undo record {part, idx, before, after} or null.
//
//   setBrush(key) setRadiusWorld(m) setStrength(0..1) setInvert(bool) setFalloff(preset)
//   setHardness(0..1) setAutoSmooth(0..1) setSymmetry({x,y,z}) setPressureEnabled(bool)
//       Brush keys come from brushes/registry.js ('draw', 'smooth', 'grab', 'inflate', ...).
//       Radius is in WORLD units (metres in the box), never pixels.
//
//   applyHistory(record, 'undo'|'redo')   put a stroke or mask record back, exactly
//   drainRecords()   records orphaned by a re-fired beginStroke, a cross-part applyDab or a
//                    filter() run mid-stroke; the page's timeline must pick these up or the
//                    interrupted stroke becomes un-undoable
//   filter(name, options) / maskOp(name, options)   whole-part operations (filled in by set-b);
//                    both return an undo record (or null)
//   registerFilter(name, fn) / registerMaskOp(name, fn)   how set-b plugs them in
//   applyDab(input)   one dab exactly as given, no spacing and no stabiliser (parity replay,
//                     scripted edits); input adds {overlap, first, settings}
//
// Units: world units in, part-local metres inside. The radius is divided by the part's world
// scale per dab, so the brush stays the same physical size whatever the model got fitted to.
// ==================================================================================

import * as THREE from 'three';
import { SculptorMesh } from './vendor/SculptorMesh.js';
import { intersectionRayTriangle } from './vendor/SculptorUtils.js';
import { createBinding } from './binding.js';
import { calcFactors } from './factors.js';
import {
  createCache, brushStrength, brushFlip, calcAreaNormalAndCenter, calcStabilizedPlane,
  radiusLocalFromWorld, accumulateFor,
} from './cache.js';
import { StrokeStepper, NO_LAZY_BRUSHES, NEEDS_STROKE_DIRECTION, DAB_BUDGET_MS } from './stroke.js';
import { applySymmetryPass, symmetryFlags, symmetryPasses, flipVec, symmetryFeather, routeMirrorPass } from './symmetry.js';
import { smoothDab } from './smooth.js';
import { getBrush, getBrushForPreset, brushKeys } from './brushes/registry.js';
import { brushSettings, loadPresets, clampRadius, RADIUS_DEFAULT_M } from './presets.js';
import { buildRecord, buildMaskRecord, applyRecord } from './undo.js';

const _v = (a) => (Array.isArray(a) ? a.slice() : [a.x, a.y, a.z]);

// ---------------------------------------------------------------- input sanity
//
// The hand is an input device that lies. MediaPipe drops a landmark, the page divides by a
// zero-length gaze vector, and a NaN arrives at 30 Hz. Nothing downstream survives one: a NaN
// position poisons the octree's AABBs, after which a sphere query stops pruning and returns EVERY
// face, so the NEXT clean dab writes NaN to the whole part and the mesh vanishes (measured: one bad
// sample plus twenty clean ones took a 60k-triangle part to 89406/89406 non-finite floats). So the
// numbers are checked once, at the API boundary, and a bad sample is dropped whole.

function finiteVec(v) {
  if (!v) return false;
  if (typeof v.x === 'number') return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  return v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function finiteRay(ray) {
  if (!ray) return false;
  return finiteVec(ray.origin ?? ray.o) && finiteVec(ray.direction ?? ray.dir ?? ray.d);
}

/** True when every number the engine will read from this sample is finite. */
function finiteInput(input) {
  if (!input) return false;
  if (input.worldRay != null && !finiteRay(input.worldRay)) return false;
  if (input.point3D != null && !finiteVec(input.point3D)) return false;
  // Pressure looks harmless only because it is forced to 1 while setPressureEnabled(false); with
  // pressure on, one NaN sample poisons Draw through the ordinary stroke API and spreads.
  if (input.pressure != null && !Number.isFinite(input.pressure)) return false;
  if (input.timeMs != null && !Number.isFinite(input.timeMs)) return false;
  return true;
}

function uniformScaleOf(matrix) {
  if (!matrix) return 1;
  const e = matrix.elements;
  const sx = Math.hypot(e[0], e[1], e[2]);
  const sy = Math.hypot(e[4], e[5], e[6]);
  const sz = Math.hypot(e[8], e[9], e[10]);
  return (sx + sy + sz) / 3;
}

/** Ray against the proxy. `original` tests the stroke-start shape (Blender's accumulate-off rule). */
function raycastProxy(proxy, origin, dir, original) {
  const faces = proxy.intersectRay(origin, dir);
  const live = proxy.getVertices();
  const orig = proxy.getOrigPositions();
  const fAr = proxy.getFaces();
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], hit = [0, 0, 0];
  let best = Infinity, bestPoint = null, bestFace = -1;
  const read = (out, v) => {
    const src = original && proxy.hasOriginal(v) ? orig : live;
    out[0] = src[3 * v]; out[1] = src[3 * v + 1]; out[2] = src[3 * v + 2];
  };
  for (let i = 0; i < faces.length; i++) {
    const idf = faces[i] * 4;
    read(a, fAr[idf]); read(b, fAr[idf + 1]); read(c, fAr[idf + 2]);
    const t = intersectionRayTriangle(origin, dir, a, b, c, hit);
    if (t >= 0 && t < best) { best = t; bestPoint = hit.slice(); bestFace = faces[i]; }
  }
  return bestPoint ? { point: bestPoint, distance: best, face: bestFace } : null;
}

function faceNormalAt(proxy, face) {
  const n = proxy.getFaceNormals();
  const len = Math.hypot(n[3 * face], n[3 * face + 1], n[3 * face + 2]) || 1;
  return [n[3 * face] / len, n[3 * face + 1] / len, n[3 * face + 2] / len];
}

function gatherVerts(proxy, center, radius) {
  const faces = proxy.intersectSphere(center, radius * radius);
  return proxy.getVerticesFromFaces(faces);
}

/**
 * Every vertex of the part, cached on the handle. Elastic Grab and the filters ask for this on
 * every dab and every symmetry pass, and building a fresh 200k-entry Uint32Array each time was
 * megabytes of garbage a second next to a WebGL render loop.
 */
function allVerts(handleOrProxy) {
  const handle = handleOrProxy.proxy ? handleOrProxy : null;
  const proxy = handle ? handle.proxy : handleOrProxy;
  const n = proxy.getNbVertices();
  if (handle && handle._allVerts && handle._allVerts.length === n) return handle._allVerts;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  if (handle) handle._allVerts = out;
  return out;
}

/**
 * The per-dab scratch, grown on demand and reused across dabs and symmetry passes. Allocating
 * these inside the dab loop cost 0.6-11 MB of garbage per dab, which showed up as GC pauses of
 * 30-47 ms in the middle of a stroke.
 */
function dabBuffers(handle, n) {
  const b = handle._buf;
  if (b.n < n) {
    b.n = Math.max(n, b.n * 2);
    b.factors = new Float32Array(b.n);
    b.distances = new Float32Array(b.n);
    b.translations = new Float32Array(b.n * 3);
    b.smoothFactors = new Float32Array(b.n);
    b.smoothPositions = new Float32Array(b.n * 3);
  }
  return b;
}

/**
 * A stamped set of vertex ids: the same job as `new Set()` with no allocation and no hashing.
 * The stamp starts at 0 and the tick at 1, so the mark array never has to be cleared.
 */
function makeVertSet(n) {
  return {
    mark: new Int32Array(n),
    list: new Uint32Array(n),
    tick: 0,
    size: 0,
    begin() { this.tick++; this.size = 0; },
    add(v) {
      if (this.mark[v] === this.tick) return;
      this.mark[v] = this.tick;
      this.list[this.size++] = v;
    },
    verts() { return this.list.subarray(0, this.size); },
  };
}

/** A Uint32Array view of the proxy's touched list, reusing one buffer per part. */
function touchedView(handle, touched) {
  let a = handle._touchedBuf;
  if (!a || a.length < touched.length) {
    a = new Uint32Array(Math.max(touched.length, 256));
    handle._touchedBuf = a;
  }
  for (let i = 0; i < touched.length; i++) a[i] = touched[i];
  return a.subarray(0, touched.length);
}

export function createSculptEngine(engineOptions = {}) {
  const parts = new Map();
  const filters = new Map();
  const maskOps = new Map();
  // Undo records for strokes that were interrupted rather than ended; drainRecords() hands them to
  // the page's timeline. Without this they were simply dropped, and the edits became permanent.
  const pendingRecords = [];

  const state = {
    brushKey: 'draw',
    brush: getBrush('draw'),
    settings: null,           // Blender-named brush settings (presets.js or injected)
    overrides: engineOptions.handOverrides !== false,
    radiusWorld: RADIUS_DEFAULT_M,
    strength: null,           // null = the preset's own strength
    invert: false,
    falloff: null,
    hardness: null,
    autoSmooth: null,
    symmetry: 0,
    // Blender 5.2.1 ships symmetry feather ON (verified headless: tool_settings.sculpt
    // .use_symmetry_feather is True at factory settings), so mirrored dabs that overlap near the
    // plane are divided by how much they overlap. Without it a stroke on the centre line is twice
    // as deep as the same stroke anywhere else.
    feather: engineOptions.feather !== false,
    pressureEnabled: false,
    stroke: null,
    lastDabCostMs: 0,
    budgetMs: engineOptions.budgetMs ?? DAB_BUDGET_MS,
  };

  // ---------------------------------------------------------------- brush settings

  function settingsFor() {
    const s = { ...(state.settings || fallbackSettings()) };
    if (state.strength !== null) s.strength = state.strength;
    if (state.falloff !== null) s.curve_distance_falloff_preset = state.falloff;
    if (state.hardness !== null) s.hardness = state.hardness;
    if (state.autoSmooth !== null) s.auto_smooth_factor = state.autoSmooth;
    return s;
  }

  function fallbackSettings() {
    // Used before presets.json has loaded, and by tests that drive the engine directly.
    return {
      name: state.brushKey,
      sculpt_brush_type: state.brush?.type || 'DRAW',
      strength: 0.5,
      curve_distance_falloff_preset: 'SMOOTH',
      hardness: 0,
      auto_smooth_factor: 0,
      normal_radius_factor: 0.5,
      area_radius_factor: 0.5,
      spacing: 10,
      use_space_attenuation: true,
      use_accumulate: false,
      use_frontface: false,
      falloff_shape: 'SPHERE',
      sculpt_plane: 'AREA',
      use_pressure_strength: true,
      plane_offset: 0,
      tip_roundness: 1,
      smooth_stroke_factor: 0.9,
    };
  }

  function setBrush(key) {
    const brush = getBrush(key);
    if (!brush) throw new Error(`holosculpt: no brush "${key}" (have ${brushKeys().join(', ')})`);
    state.brushKey = key;
    state.brush = brush;
    try {
      state.settings = brushSettings(brush.presets[0], { overrides: state.overrides });
    } catch {
      state.settings = null; // presets.json not loaded yet: fall back until it is
    }
    return key;
  }

  /** Drive the engine with explicit Blender settings (parity replay, scripted edits). */
  function setBrushSettings(settings, brushKey) {
    const brush = brushKey ? getBrush(brushKey) : getBrushForPreset(settings.name) || getBrush(state.brushKey);
    if (brush) { state.brush = brush; state.brushKey = brush.key; }
    state.settings = { ...settings };
    return state.brush;
  }

  // ---------------------------------------------------------------- parts

  function attach(part, options = {}) {
    const id = options.id ?? part?.userData?.holo_id ?? part?.uuid ?? `part${parts.size}`;
    const geometries = options.geometries ?? collectGeometries(part);
    const binding = createBinding(geometries, { vidAttribute: options.vidAttribute });
    const proxy = new SculptorMesh();
    proxy.initFromWelded(binding.positions, binding.triangles, binding.triRenderMap, binding.faceMaterial);

    const matrixWorld = options.matrixWorld ?? part?.matrixWorld ?? new THREE.Matrix4();
    const nbVerts = proxy.getNbVertices();
    const handle = {
      id,
      object: part && part.isObject3D ? part : null,
      proxy,
      binding,
      matrixWorld,
      worldToLocal: new THREE.Matrix4().copy(matrixWorld).invert(),
      scale: uniformScaleOf(matrixWorld),
      selfSymmetric: options.selfSymmetric !== false,
      rootMatrixWorld: options.rootMatrixWorld ?? null,
      // The matrix this handle's inverse and scale were derived from, so frame() can tell when the
      // object has moved under us without the page having to say so.
      _mwSnapshot: new THREE.Matrix4().copy(matrixWorld),
      _buf: { n: 0, factors: null, distances: null, translations: null, smoothFactors: null, smoothPositions: null },
      _dirty: makeVertSet(nbVerts),
      _allVerts: null,
      _touchedBuf: null,
      sync() {
        handle._mwSnapshot.copy(handle.matrixWorld);
        handle.worldToLocal.copy(handle.matrixWorld).invert();
        handle.scale = uniformScaleOf(handle.matrixWorld);
        return handle;
      },
      detach() { parts.delete(id); },
    };
    parts.set(id, handle);
    return handle;
  }

  // The part's matrixWorld is a LIVE reference to the object's own matrix, so three.js keeps it
  // current while the inverse and the scale we derived from it go stale the moment the user turns
  // or moves the model - and hover() then transformed the ray with the stale inverse and the hit
  // point with the live matrix, so the brush landed 100 mm from the ring on a 200 mm cube, or the
  // raycast missed entirely and sculpting silently stopped. Sixteen float compares per call is
  // nothing next to the octree raycast that follows, and the page should not have to know.
  function frame(handle) {
    if (!handle._mwSnapshot.equals(handle.matrixWorld)) handle.sync();
    return handle;
  }

  const _relMatrix = new THREE.Matrix4();
  const _invMatrix = new THREE.Matrix4();
  const IDENTITY = new THREE.Matrix4().elements.slice();

  /**
   * createBinding reads every child's position attribute verbatim and scatters straight back into
   * it, while the handle's world matrix is the PARENT's - so a child carrying its own transform is
   * welded, raycast and written back in the wrong space, and (because the weld key is the
   * child-local position) cross-welded with its siblings into one body. GLTFLoader keeps the
   * primitives of one multi-material object at identity, which is the case attach() documents;
   * anything else fails silently in both directions, so refuse it instead.
   */
  function assertChildInPartSpace(part, child) {
    if (!part?.matrixWorld || !child?.matrixWorld) return;
    _relMatrix.copy(child.matrixWorld).premultiply(_invMatrix.copy(part.matrixWorld).invert());
    const e = _relMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(e[i] - IDENTITY[i]) <= 1e-6) continue;
      throw new Error(
        `holosculpt: attach() cannot bind "${child.name || child.uuid}": it carries its own transform ` +
        'inside the part. Bake it into the geometry, or attach it as its own part.',
      );
    }
  }

  function collectGeometries(part) {
    if (!part) throw new Error('holosculpt: attach() needs a part');
    if (Array.isArray(part) || part.isBufferGeometry || part.geometries) return part.geometries ?? part;
    // A Mesh IS the part; never sweep up its children. The page hangs an identity fresnel overlay
    // that SHARES the part's geometry on the hovered part (scene/highlight.js), and binding that
    // too doubles the proxy and perturbs the smooth brush.
    if (part.isMesh) return [part];
    const out = [];
    if (part.children) {
      for (const c of part.children) {
        if (!c.isMesh) continue;
        assertChildInPartSpace(part, c);
        out.push(c);
      }
    }
    if (out.length === 0) throw new Error('holosculpt: attach() found no mesh on the part');
    return out;
  }

  function partOf(ref) {
    if (!ref) return parts.size === 1 ? parts.values().next().value : null;
    if (typeof ref === 'string') return parts.get(ref) ?? null;
    if (parts.has(ref?.id)) return parts.get(ref.id);
    for (const h of parts.values()) if (h.object === ref || h === ref) return h;
    return null;
  }

  // ---------------------------------------------------------------- world <-> part

  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _n3 = new THREE.Matrix3();

  function rayToLocal(handle, worldRay) {
    frame(handle);
    const o = _v(worldRay.origin ?? worldRay.o);
    const d = _v(worldRay.direction ?? worldRay.dir ?? worldRay.d);
    _p.set(o[0], o[1], o[2]).applyMatrix4(handle.worldToLocal);
    _n3.setFromMatrix4(handle.worldToLocal);
    _d.set(d[0], d[1], d[2]).applyMatrix3(_n3).normalize();
    return { origin: [_p.x, _p.y, _p.z], direction: [_d.x, _d.y, _d.z] };
  }

  function pointToLocal(handle, world) {
    frame(handle);
    const w = _v(world);
    _p.set(w[0], w[1], w[2]).applyMatrix4(handle.worldToLocal);
    return [_p.x, _p.y, _p.z];
  }

  function pointToWorld(handle, local) {
    frame(handle);
    _p.set(local[0], local[1], local[2]).applyMatrix4(handle.matrixWorld);
    return [_p.x, _p.y, _p.z];
  }

  // ---------------------------------------------------------------- hover

  function hover(worldRay, partRef) {
    // hover() runs every frame to place the brush ring, so it is the first thing a half-built ray
    // reaches: before the hand tracker's first sample, or when a landmark drops out.
    if (!finiteRay(worldRay)) return { hit: false, radiusWorld: state.radiusWorld };
    const candidates = partRef ? [partOf(partRef)].filter(Boolean) : [...parts.values()];
    let best = null;
    for (const handle of candidates) {
      const ray = rayToLocal(handle, worldRay);
      const hit = raycastProxy(handle.proxy, ray.origin, ray.direction, false);
      if (!hit) continue;
      const worldDistance = hit.distance * handle.scale;
      if (!best || worldDistance < best.distance) {
        best = {
          hit: true,
          part: handle.id,
          handle,
          distance: worldDistance,
          point: pointToWorld(handle, hit.point),
          normal: faceNormalAt(handle.proxy, hit.face),
          radiusWorld: state.radiusWorld,
        };
      }
    }
    return best || { hit: false, radiusWorld: state.radiusWorld };
  }

  // ---------------------------------------------------------------- one dab

  function dabContext(handle, settings, verts, dirty) {
    const proxy = handle.proxy;
    const b = dabBuffers(handle, verts.length);
    // Length-correct views: draw.js and friends iterate factors.length, so handing a brush the
    // over-sized backing buffer would run the kernel past the end of `verts`.
    const factors = b.factors.subarray(0, verts.length);
    const distances = b.distances.subarray(0, verts.length);
    const translations = b.translations.subarray(0, verts.length * 3);
    // commit() reads every entry, and clay-strips and plane only write some of them, so a reused
    // buffer would leak the previous dab's displacement into vertices this dab never touched.
    translations.fill(0);
    const ctx = {
      proxy,
      handle,
      settings,
      cache: handle._cache,
      verts,
      factors,
      distances,
      translations,
      positions: proxy.getVertices(),
      normals: proxy.getRenderNormals(),
      origPositions: proxy.getOrigPositions(),
      origNormals: proxy.getOrigNormals(),
      dirty,
      touch(v) { proxy.stampOriginal(v); dirty.add(v); },
      markDirty() { for (let k = 0; k < verts.length; k++) dirty.add(verts[k]); },
      computeFactors(out) {
        calcFactors(proxy, verts, factorParams(handle._cache, settings, ctx.useOriginal), out, distances);
        return out;
      },
      commit() {
        const positions = proxy.getVertices();
        for (let k = 0; k < verts.length; k++) {
          const tx = translations[3 * k], ty = translations[3 * k + 1], tz = translations[3 * k + 2];
          if (tx === 0 && ty === 0 && tz === 0) continue;
          const v = verts[k];
          positions[3 * v] += tx;
          positions[3 * v + 1] += ty;
          positions[3 * v + 2] += tz;
          dirty.add(v);
        }
      },
    };
    return ctx;
  }

  function factorParams(cache, settings, useOriginal) {
    return {
      location: cache.locationSymm,
      radius: cache.radius,
      hardness: cache.hardness,
      falloff: settings.curve_distance_falloff_preset || 'SMOOTH',
      falloffShape: settings.falloff_shape || 'SPHERE',
      viewNormal: cache.viewNormalSymm,
      frontFace: !!settings.use_frontface,
      positions: useOriginal ? cache._origPositions : undefined,
      normals: useOriginal ? cache._origNormals : undefined,
    };
  }

  /**
   * One dab, all symmetry passes. `input` is already in world units;
   * {worldRay, point3D, pressure, overlap, first, settings}.
   */
  function applyDab(input, partRef) {
    if (!finiteInput(input)) return false;
    const handle = partOf(partRef ?? state.stroke?.part);
    if (!handle) throw new Error('holosculpt: no part attached');
    const started = state.stroke && state.stroke.handle === handle;
    // A dab aimed at a different part re-points the stroke, so the old part's edits have to be
    // banked first or they can never be undone (beginStrokeInternal flushes).
    if (!started) beginStrokeInternal(handle, input, true);
    const t0 = (globalThis.performance?.now?.() ?? Date.now());
    const moved = dabOnPart(handle, input);
    state.lastDabCostMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    return moved;
  }

  function dabOnPart(handle, input) {
    const proxy = handle.proxy;
    const cache = handle._cache;
    frame(handle); // elastic.js reads handle.worldToLocal directly; make sure it is current
    const settings = input.settings ? { ...input.settings } : settingsFor();
    const brush = input.brush || state.brush;
    const type = settings.sculpt_brush_type || brush.type;
    // "Accumulate off" is what makes the dab read the stroke-start shape; a brush that has no
    // Accumulate option (Smooth, Grab) stays in accumulate mode and reads the live surface.
    const accumulate = accumulateFor(type, settings);
    const useOriginalRay = !accumulate;

    const ray = input.worldRay ? rayToLocal(handle, input.worldRay) : null;
    let location = null;
    if (ray) {
      const hit = raycastProxy(proxy, ray.origin, ray.direction, useOriginalRay);
      if (hit) {
        location = hit.point;
        if (cache.firstTime) cache.initialNormal = faceNormalAt(proxy, hit.face);
      } else if (brush.anchoredOrigin && !cache.firstTime && input.allowMiss) {
        // The grab family does not need a surface under the ray once the stroke has started
        // (Blender: paint_brush_type_require_location is false for it), and a hand pulling clay
        // out of the model leaves the silhouette all the time.
        location = cache.origGrabLocation.slice();
      } else {
        return false; // Blender drops a dab whose ray misses the surface
      }
    } else if (input.point3D) {
      location = pointToLocal(handle, input.point3D);
    } else {
      return false;
    }

    // view direction: towards the viewer, i.e. back along the ray
    if (ray) cache.viewNormal = [-ray.direction[0], -ray.direction[1], -ray.direction[2]];
    const grabPoint = input.point3D ? pointToLocal(handle, input.point3D) : location;

    cache.lastLocation = cache.location;
    cache.location = location;
    cache.pressure = state.pressureEnabled ? (input.pressure ?? 1) : 1;
    cache.hardness = settings.hardness || 0;
    // The part's scale is pinned to the stroke start: a model rotated or moved mid-stroke re-frames
    // (frame() above), but resizing it must not change the local radius under a running stroke,
    // whose cached radius, anchor and stroke-start snapshot are all part-local. Blender pins
    // cache->initial_radius the same way.
    cache.radius = radiusLocalFromWorld(state.radiusWorld, cache.strokeScale || handle.scale);
    cache.radiusSquared = cache.radius * cache.radius;

    // Hand delta, Blender's brush_delta_update in 3D: total from the stroke start for the grab
    // family, per-step for the brushes that only need a direction.
    if (cache.firstTime) {
      cache.origGrabLocation = grabPoint.slice();
      cache.oldGrabLocation = grabPoint.slice();
      cache.initialLocation = location.slice();
      cache.grabDelta = [0, 0, 0];
    } else if (brush.anchoredOrigin) {
      cache.grabDelta = [
        grabPoint[0] - cache.origGrabLocation[0],
        grabPoint[1] - cache.origGrabLocation[1],
        grabPoint[2] - cache.origGrabLocation[2],
      ];
      cache.location = cache.origGrabLocation.slice();
    } else {
      cache.grabDelta = [
        grabPoint[0] - cache.oldGrabLocation[0],
        grabPoint[1] - cache.oldGrabLocation[1],
        grabPoint[2] - cache.oldGrabLocation[2],
      ];
    }
    cache.oldGrabLocation = grabPoint.slice();

    const nrf = settings.normal_radius_factor ?? 0.5;
    const arf = settings.area_radius_factor ?? nrf;
    const gatherScale = Math.max(1, nrf, brush.needsAreaCenter ? arf : 0);

    if (brush.needsStrokeDirection || NEEDS_STROKE_DIRECTION.has(type)) {
      if (cache.firstTime) {
        if (brush.needsAreaNormal || brush.needsAreaCenter) {
          applySymmetryPass(cache, 0);
          cache._origPositions = proxy.getOrigPositions();
          cache._origNormals = proxy.getOrigNormals();
          const first = gatherVerts(proxy, cache.locationSymm, cache.radius * gatherScale);
          if (first.length > 0) {
            for (let k = 0; k < first.length; k++) proxy.stampOriginal(first[k]);
            // Blender runs update_sculpt_normal BEFORE the cube-tip first-step return
            // (sculpt.cc:3523 against :3529), so a brush that drops this dab still leaves the
            // stroke holding THIS dab's area normal - the one "original normal" freezes. It never
            // reaches calc_brush_plane, so last_center keeps its zero init, and that is what
            // "original plane" freezes such a brush to.
            //
            // The PLANE brush is the exception, and it matters. BKE_brush_has_cube_tip is true
            // only for Multiplane Scrape or a tip_roundness below 1 (or a tip_scale_x off 1), and
            // all five Essentials Plane presets are round: Blender does NOT skip their first step.
            // plane::calc_node_mask runs the whole plane calculation there, stabiliser included,
            // and only do_plane_brush's own zero-grab-delta check stops it depositing. Skipping it
            // cost the rolling average its first sample, which is invisible while stabilize_* is 0
            // (Flatten, Scrape, Fill) and 34-78% of Blender's displacement when it is 1 (Trim,
            // Plateau).
            updateAreaData(handle, settings, brush, first, { normalOnly: type !== 'PLANE' });
          }
        }
        cache.firstTime = false;
        return false; // no direction yet
      }
    }

    // Restore the stroke-start shape first (grab family), so the total delta is applied once.
    if (brush.restoreEachStep) restoreStrokeStart(handle);

    const flip = brushFlip({ dirIn: !!settings.use_negative_direction, invert: state.invert });
    const overlap = input.overlap ?? 1;
    const feather = symmetryFeather(cache.location, cache.radius, state.symmetry, state.feather);
    cache.overlap = overlap;
    cache.baseStrength = brushStrength(type, {
      strength: settings.strength,
      pressure: cache.pressure,
      usePressureStrength: settings.use_pressure_strength !== false,
      overlap,
      flip,
      maskTool: settings.mask_tool,
      planeInversionMode: settings.plane_inversion_mode,
    });
    cache.bstrength = cache.baseStrength * feather;
    // (cache.initialDirectionFlipped is seeded once in beginStrokeInternal, where Blender sets it.)

    // Second belt for the finite check at the API boundary: a poisoned cache or a kernel bug would
    // otherwise write NaN into the proxy, and once ONE position is non-finite the octree's AABBs
    // stop pruning, so the next dab is a whole-part wipe whatever its source.
    if (!finiteVec(cache.location) || !finiteVec(cache.grabDelta) || !Number.isFinite(cache.bstrength)) {
      cache.firstTime = false;
      return false;
    }

    const dirty = handle._dirty;
    dirty.begin();
    const useOriginalData = !!brush.usesOriginalData;
    cache._origPositions = proxy.getOrigPositions();
    cache._origNormals = proxy.getOrigNormals();

    for (const pass of symmetryPasses(state.symmetry)) {
      applySymmetryPass(cache, pass);
      const target = pass === 0 ? handle : routeMirrorPass({
        part: handle,
        selfSymmetric: handle.selfSymmetric,
        point: cache.locationSymm,
        radius: cache.radius,
        findPartNear: engineOptions.findPartNear,
      });
      if (!target) continue;
      if (target !== handle) continue; // cross-part routing lands in M3 with the part registry

      const verts = brush.allVertices
        ? allVerts(handle)
        : gatherVerts(proxy, cache.locationSymm, cache.radius * gatherScale);
      if (verts.length === 0) continue;
      for (let k = 0; k < verts.length; k++) proxy.stampOriginal(verts[k]);

      if (pass === 0 && (brush.needsAreaNormal || brush.needsAreaCenter)) {
        updateAreaData(handle, settings, brush, verts);
      }
      if (brush.needsAreaNormal) cache.sculptNormalSymm = flipVec(cache.sculptNormal, pass);
      if (brush.needsAreaCenter) cache.areaCenterSymm = flipVec(cache.areaCenter, pass);

      const ctx = dabContext(handle, settings, verts, dirty);
      ctx.useOriginal = useOriginalData;
      // True only for the very first brush action of the stroke (see smooth.js frozenBase).
      ctx.firstBrushAction = cache.strokeStep === 0 && pass === 0;
      calcFactors(proxy, verts, factorParams(cache, settings, useOriginalData), ctx.factors, ctx.distances);
      brush.apply(ctx);

      // Auto-smooth, exactly as Blender does it: a Smooth pass after every dab of every brush
      // except Smooth and Mask.
      const autoSmooth = settings.auto_smooth_factor ?? 0;
      if (!brush.noAutoSmooth && autoSmooth > 0) {
        // "Inverse smooth pressure" (Blender 5.2.1's use_inverse_smooth_pressure, renamed
        // use_smooth_pressure in main): pressing HARDER smooths LESS, so a brush carrying the flag
        // does not auto-smooth at all at full pressure. Clay is the one Essentials brush that has
        // both a non-zero auto-smooth and this flag, and getting the direction backwards is not
        // subtle - it took the golden clay stroke from 2.1% to 161% of Blender's max displacement.
        const inversePressure = settings.use_inverse_smooth_pressure ?? settings.use_smooth_pressure;
        const strength = inversePressure ? autoSmooth * (1 - cache.pressure) : autoSmooth;
        if (strength > 0) {
          const b = handle._buf;
          smoothDab(proxy, verts, {
            strength,
            factors: b.smoothFactors,
            newPositions: b.smoothPositions,
            computeFactors: (out) => calcFactors(proxy, verts, factorParams(cache, settings, false), out, ctx.distances),
            onTouch: (v) => { proxy.stampOriginal(v); dirty.add(v); },
          });
        }
      }
    }

    cache.firstTime = false;
    cache.strokeStep++;
    if (dirty.size === 0) return false;
    refresh(handle, dirty.verts());
    return true;
  }

  /** Blender's area_normal_and_center_get_position_radius, as a factor of the brush radius. */
  function areaRadiusFactor(settings, brush, cache, nrf) {
    const type = settings.sculpt_brush_type || brush.type;
    const arf = settings.area_radius_factor ?? 0;
    if (type !== 'PLANE' || !(arf > 0)) return nrf;
    return settings.use_pressure_area_radius ? arf * cache.pressure : arf;
  }

  /**
   * Blender keeps these two apart and so must we. update_sculpt_normal (sculpt.cc:2755) owns the
   * area NORMAL and skips it for the Grab family and for "original normal"; calc_brush_plane
   * (sculpt.cc:3077) owns the area CENTRE and recomputes it every step unless "original plane" is
   * on as WELL. Both flags are ignored outright for the Plane brush type. Freezing the two together
   * meant "original normal" also pinned the brush plane's centre to one dab, so a Clay Strips
   * stroke was laid on the plane of its first dab for the rest of the stroke.
   *
   * `o.normalOnly` is the dab a direction-needing brush drops: Blender runs update_sculpt_normal
   * there but returns before any brush reaches calc_brush_plane.
   */
  function updateAreaData(handle, settings, brush, verts, o = {}) {
    const cache = handle._cache;
    const proxy = handle.proxy;
    const type = settings.sculpt_brush_type || brush.type;
    const isPlaneBrush = type === 'PLANE';
    const origNormal = !isPlaneBrush && !!settings.use_original_normal;
    const origPlane = !isPlaneBrush && !!settings.use_original_plane;
    // Blender's stroke_is_first_brush_step_of_symmetry_pass. NOT cache.firstTime: a brush that
    // needs a stroke direction clears firstTime on the dab it drops, so keying the freeze off it
    // froze data that had never been computed (and left cache.areaCenter undefined).
    const first = !cache.areaDataValid;
    // The Grab family's frozen direction stands in for update_sculpt_normal's own exception list.
    const keepNormal = !first && (brush.anchoredOrigin || origNormal);
    const keepCenter = !first && origPlane;
    const wantNormal = !!brush.needsAreaNormal && !keepNormal;
    const wantCenter = !o.normalOnly && !!brush.needsAreaCenter && !keepCenter;

    if (wantNormal || wantCenter) {
      const plane = settings.sculpt_plane || 'AREA';
      const areaNormal = wantNormal && plane === 'AREA';
      if (wantNormal && !areaNormal) {
        const axis = { VIEW: cache.viewNormal, X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[plane];
        cache.sculptNormal = axis.slice();
      }
      if (areaNormal || wantCenter) {
        const useOriginal = !accumulateFor(type, settings);
        const nrf = settings.normal_radius_factor ?? 0.5;
        // area_radius_factor sizes the AREA CENTRE, but Blender applies it only to the Plane brush
        // ("the Layer brush produces artifacts with normal and area radius"); every other brush
        // sizes the centre with normal_radius_factor as well. Clay Strips is where this shows: its
        // factors are 1.2 and 0.5, so the wrong one moves the plane and reshapes the whole strip.
        const arf = areaRadiusFactor(settings, brush, cache, nrf);
        const { normal, center } = calcAreaNormalAndCenter(proxy, {
          verts,
          positions: useOriginal ? proxy.getOrigPositions() : undefined,
          // Always the STROKE-START normals, even with accumulate on. Measured against Blender
          // 5.2.1: replaying the golden strokes with live normals here puts an accumulating Draw
          // 24.9% out and Crease Sharp 8.5% out, while stroke-start normals with live positions
          // bring them to 1.3% and 2.0%. Blender reads these through the evaluated mesh's normal
          // cache, which the brush loop does not refresh between dabs, so the area normal keeps
          // weighing the shape the stroke began with while the dab lands on the live surface.
          normals: proxy.getOrigNormals(),
          location: cache.locationSymm,
          viewNormal: cache.viewNormalSymm,
          normalRadius: cache.radius * nrf,
          positionRadius: cache.radius * (brush.needsAreaCenter ? arf : nrf),
          falloffShape: settings.falloff_shape || 'SPHERE',
          needNormal: areaNormal,
          needCenter: wantCenter,
        });
        let outNormal = normal;
        let outCenter = center;
        // Blender stabilises the Plane brush's plane inside calc_area_normal_and_center
        // (sculpt.cc:2226), not inside the kernel - a rolling average over up to 20 steps so a
        // shaky hand does not make the plane wobble. It therefore runs on EVERY step of the
        // stroke, including the first one, where do_plane_brush deposits nothing because the grab
        // delta is still zero. Doing it in the kernel instead meant the first step never entered
        // the average.
        if (isPlaneBrush && areaNormal && outNormal && outCenter) {
          const stabilized = calcStabilizedPlane(
            cache, outNormal, outCenter,
            settings.stabilize_normal ?? 0,
            settings.stabilize_plane ?? 0,
          );
          outNormal = stabilized.normal;
          outCenter = stabilized.center;
        }
        if (areaNormal && outNormal) cache.sculptNormal = outNormal;
        if (wantCenter && outCenter) { cache.areaCenter = outCenter; cache.lastCenter = outCenter; }
      }
    }
    // "Original plane" hands back the plane the stroke froze. For a brush that dropped its first
    // dab that is Blender's zero-initialised last_center - a plane through the object origin.
    if (keepCenter && brush.needsAreaCenter) cache.areaCenter = cache.lastCenter.slice();
    cache.areaDataValid = true;
  }

  function restoreStrokeStart(handle) {
    const proxy = handle.proxy;
    const touched = proxy.getTouched();
    if (touched.length === 0) return;
    const positions = proxy.getVertices();
    const orig = proxy.getOrigPositions();
    for (let k = 0; k < touched.length; k++) {
      const i3 = 3 * touched[k];
      positions[i3] = orig[i3];
      positions[i3 + 1] = orig[i3 + 1];
      positions[i3 + 2] = orig[i3 + 2];
    }
    refresh(handle, touchedView(handle, touched));
  }

  /** Face normals, vertex normals, octree and the render buffers, for the touched vertices only. */
  function refresh(handle, verts) {
    const proxy = handle.proxy;
    const faces = proxy.getFacesFromVertices(verts);
    const ringVerts = proxy.getVerticesFromFaces(faces);
    proxy.refreshGeometry(faces, ringVerts);
    handle.binding.scatter(proxy, ringVerts);
    handle.binding.flush();
  }

  // ---------------------------------------------------------------- stroke

  /**
   * Bank whatever stroke is still live before anything resets the proxy's stroke snapshot.
   * beginStrokeSnapshot() bumps the stroke stamp and clears the touched list, so without this a
   * second beginStroke (a pinch FSM re-firing after a dropped frame), a cross-part applyDab, or a
   * filter() run mid-stroke lost the first half's stroke-start positions for good.
   */
  function flushLiveStroke() {
    if (!state.stroke) return;
    const record = endStroke();
    if (record) pendingRecords.push(record);
  }

  function beginStrokeInternal(handle, input, silent) {
    flushLiveStroke();
    const settings = input?.settings ? { ...input.settings } : settingsFor();
    const brush = input?.brush || state.brush;
    frame(handle);
    handle.proxy.beginStrokeSnapshot();
    const radiusLocal = radiusLocalFromWorld(state.radiusWorld, handle.scale);
    handle._cache = createCache({
      radius: radiusLocal,
      // Blender's cache->initial_radius: the radius the STROKE started with, which Clay measures
      // its plane offset against so a brush resized mid-stroke keeps depositing the same thickness.
      initialRadius: radiusLocal,
      hardness: settings.hardness || 0,
      firstTime: true,
      invert: state.invert,
      // Blender sets cache->initial_direction_flipped once in stroke_cache_init, independently of
      // first_time (sculpt.cc:5478). Writing it inside the dab never ran for the brushes that need
      // a stroke direction - the Plane family among them - because they clear firstTime on the dab
      // they drop, so the whole family's inverted mode (Contrast, Fill, Deepen, inverted Trim and
      // Plateau) silently did the un-inverted thing at half strength.
      initialDirectionFlipped: brushFlip({ dirIn: !!settings.use_negative_direction, invert: state.invert }) < 0,
      // The part's world scale at the stroke start; a resize mid-stroke must not move the brush.
      strokeScale: handle.scale,
    });
    const type = settings.sculpt_brush_type || brush.type;
    state.stroke = {
      handle,
      part: handle.id,
      brush,
      settings,
      stepper: new StrokeStepper({
        radiusWorld: state.radiusWorld,
        spacingPercent: settings.spacing ?? 10,
        falloff: settings.curve_distance_falloff_preset || 'SMOOTH',
        useSpaceAttenuation: settings.use_space_attenuation !== false,
        spaceStroke: (settings.stroke_method ?? 'SPACE') === 'SPACE',
        lazy: brush.lazy !== false && !NO_LAZY_BRUSHES.has(type) && state.overrides,
        // The stepper still emits the dab at the stroke start for a brush that needs a stroke
        // direction: dabOnPart drops it, exactly as Blender does, after using it to set the origin
        // the next dab measures its direction from.
        skipFirstDab: false,
        budgetMs: state.budgetMs,
      }),
      silent: !!silent,
      dabs: 0,
    };
    return state.stroke;
  }

  /**
   * The part whose surface is nearest a world point, within one brush radius. beginStroke's
   * documented ray-less form (point3D alone, for the grab family) had no way to resolve a part
   * once more than one was attached - partOf(undefined) returns null there - and fell into
   * hover(undefined), which threw. A Fable build is multi-part by default.
   */
  function nearestPartTo(worldPoint) {
    if (!finiteVec(worldPoint)) return null;
    let best = null;
    let bestDist = Infinity;
    for (const handle of parts.values()) {
      const local = pointToLocal(handle, worldPoint);
      const r = radiusLocalFromWorld(state.radiusWorld, handle.scale);
      const faces = handle.proxy.intersectSphere(local, r * r);
      if (faces.length === 0) continue;
      const verts = handle.proxy.getVerticesFromFaces(faces);
      const p = handle.proxy.getVertices();
      for (let k = 0; k < verts.length; k++) {
        const i3 = 3 * verts[k];
        const d = Math.hypot(p[i3] - local[0], p[i3 + 1] - local[1], p[i3 + 2] - local[2]) * handle.scale;
        if (d < bestDist) { bestDist = d; best = handle; }
      }
    }
    return best;
  }

  function beginStroke(input) {
    if (!finiteInput(input)) return null;
    const handle = partOf(input.part) || hover(input.worldRay).handle || nearestPartTo(input.point3D);
    if (!handle) return null;
    const stroke = beginStrokeInternal(handle, input, false);
    const point = strokePoint(handle, input);
    if (!point) return stroke;
    const dabs = stroke.stepper.begin({ point, pressure: pressureOf(input), timeMs: input.timeMs ?? 0 });
    for (const dab of dabs) runStepperDab(input, dab);
    return stroke;
  }

  function sampleStroke(input) {
    const stroke = state.stroke;
    if (!stroke) return 0;
    // Drop a bad sample whole and keep the stroke alive. The stepper's own arithmetic is no guard:
    // lazyStep latches a NaN aim point permanently (Math.hypot(NaN) < ignore is false), after which
    // every later sample emits zero dabs and the stroke is silently dead.
    if (!finiteInput(input)) return 0;
    const point = strokePoint(stroke.handle, input);
    if (!point) return 0;
    const dabs = stroke.stepper.advance(
      { point, pressure: pressureOf(input), timeMs: input.timeMs ?? 0 },
      { dabCostMs: state.lastDabCostMs },
    );
    let moved = 0;
    for (const dab of dabs) if (runStepperDab(input, dab)) moved++;
    return moved;
  }

  function endStroke(input) {
    const stroke = state.stroke;
    if (!stroke) return null;
    if (input) sampleStroke(input);
    const handle = stroke.handle;
    const record = buildRecord(stroke.part, handle.proxy);
    state.stroke = null;
    // Last line of defence. If something did get a non-finite value into the proxy, the part is
    // invisible and un-aimable from here on; rolling the stroke back turns "the model is gone" into
    // "the last stroke was discarded". One scan of what the stroke touched, once per stroke.
    if (record && !finiteRecord(record)) {
      applyHistory(record, 'undo');
      return null;
    }
    return record;
  }

  function finiteRecord(record) {
    if (record.type === 'multi') return record.records.every(finiteRecord);
    if (record.type !== 'stroke') return true;
    const a = record.after;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
    return true;
  }

  /** The aim point the stepper walks: the 3D pinch point for grab, else the surface under the ray. */
  function strokePoint(handle, input) {
    if (input.point3D) return _v(input.point3D);
    if (!input.worldRay) return null;
    const ray = rayToLocal(handle, input.worldRay);
    const hit = raycastProxy(handle.proxy, ray.origin, ray.direction, false);
    return hit ? pointToWorld(handle, hit.point) : null;
  }

  function pressureOf(input) {
    return state.pressureEnabled ? (input.pressure ?? 1) : 1;
  }

  // Turn a stepper dab back into a ray: the eye stays put within a frame, so the ray through the
  // interpolated aim point is what Blender's interpolated mouse position would have given.
  function runStepperDab(input, dab) {
    const stroke = state.stroke;
    const handle = stroke.handle;
    const t0 = (globalThis.performance?.now?.() ?? Date.now());
    let worldRay = null;
    if (input.worldRay) {
      const origin = _v(input.worldRay.origin ?? input.worldRay.o);
      const dir = [dab.point[0] - origin[0], dab.point[1] - origin[1], dab.point[2] - origin[2]];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      worldRay = { origin, direction: [dir[0] / len, dir[1] / len, dir[2] / len] };
    }
    const moved = dabOnPart(handle, {
      worldRay,
      point3D: input.point3D ? dab.point : null,
      pressure: dab.pressure,
      overlap: dab.overlap,
      settings: stroke.settings,
      brush: stroke.brush,
      allowMiss: true,
    });
    state.lastDabCostMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    stroke.dabs++;
    return moved;
  }

  // ---------------------------------------------------------------- undo / filters

  function applyHistory(record, direction = 'undo') {
    if (!record) return false;
    const handle = partOf(record.part);
    if (!handle) return false;
    const verts = applyRecord(record, handle.proxy, direction);
    // A mask-only record changes no geometry, and the binding never scatters the mask.
    if (verts.length > 0) refresh(handle, verts);
    return true;
  }

  function registerFilter(name, fn) { filters.set(name, fn); }
  function registerMaskOp(name, fn) { maskOps.set(name, fn); }

  function filter(name, options = {}) {
    const fn = filters.get(name);
    const handle = partOf(options.part);
    if (!fn || !handle) return null;
    flushLiveStroke(); // beginStrokeSnapshot below would otherwise eat a live stroke's undo record
    handle.proxy.beginStrokeSnapshot();
    const verts = fn({ engine: api, handle, proxy: handle.proxy, settings: settingsFor(), options }) || allVerts(handle);
    refresh(handle, verts instanceof Uint32Array ? verts : Uint32Array.from(verts));
    return buildRecord(handle.id, handle.proxy);
  }

  /**
   * A mask op changes protection, not geometry, so it used to fall out of the record stream
   * entirely and the next "undo" ate the previous SCULPT stroke instead. Blender pushes
   * undo::Type::Mask for every one of these (paint_mask.cc), so we return a record too. grow,
   * shrink and blur only touch a boundary band, so the diff is far smaller than the whole array.
   */
  function maskOp(name, options = {}) {
    const fn = maskOps.get(name);
    const handle = partOf(options.part);
    if (!fn || !handle) return null;
    const before = Float32Array.from(handle.proxy.getMask());
    fn({ engine: api, handle, proxy: handle.proxy, options });
    return buildMaskRecord(handle.id, handle.proxy, before);
  }

  /** Records orphaned by a re-fired beginStroke, a cross-part applyDab or a mid-stroke filter. */
  function drainRecords() {
    if (pendingRecords.length === 0) return [];
    return pendingRecords.splice(0, pendingRecords.length);
  }

  // ---------------------------------------------------------------- settings

  const api = {
    attach,
    detach: (ref) => { const h = partOf(ref); if (h) h.detach(); },
    part: partOf,
    parts,
    hover,
    beginStroke,
    sampleStroke,
    endStroke,
    applyDab,
    applyHistory,
    drainRecords,
    filter,
    maskOp,
    registerFilter,
    registerMaskOp,
    loadPresets,
    setBrush,
    setBrushSettings,
    getBrushKey: () => state.brushKey,
    // The 0.3-12 cm clamp is a hand override (a brush you cannot see or aim is no use in the box),
    // so parity replays with the overrides off set the radius Blender recorded.
    setRadiusWorld: (m) => { state.radiusWorld = state.overrides ? clampRadius(m) : m; state.stroke?.stepper.setRadiusWorld(state.radiusWorld); return state.radiusWorld; },
    getRadiusWorld: () => state.radiusWorld,
    setStrength: (s) => { state.strength = s === null ? null : Math.min(Math.max(s, 0), 1); },
    setInvert: (v) => { state.invert = !!v; },
    setFalloff: (preset) => { state.falloff = preset; },
    setHardness: (h) => { state.hardness = h === null ? null : Math.min(Math.max(h, 0), 1); },
    setAutoSmooth: (a) => { state.autoSmooth = a === null ? null : Math.min(Math.max(a, 0), 1); },
    setSymmetry: (axes) => { state.symmetry = typeof axes === 'number' ? axes : symmetryFlags(axes); return state.symmetry; },
    getSymmetry: () => state.symmetry,
    setFeather: (v) => { state.feather = !!v; },
    setPressureEnabled: (v) => { state.pressureEnabled = !!v; },
    setHandOverrides: (v) => { state.overrides = !!v; if (state.settings) setBrush(state.brushKey); },
    settings: settingsFor,
    state,
  };

  setBrush('draw');
  return api;
}

/** The engine the page uses; a second one can be made for tests. */
export const holosculpt = createSculptEngine();
export default holosculpt;
