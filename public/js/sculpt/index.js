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
//       input: {worldRay, point3D, pressure, timeMs, part}
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
//   applyHistory(record, 'undo'|'redo')   put a stroke record back, exactly
//   filter(name, options) / maskOp(name, options)   whole-part operations (filled in by set-b)
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
  createCache, brushStrength, brushFlip, calcAreaNormalAndCenter, radiusLocalFromWorld, accumulateFor,
} from './cache.js';
import { StrokeStepper, NO_LAZY_BRUSHES, NEEDS_STROKE_DIRECTION, DAB_BUDGET_MS } from './stroke.js';
import { applySymmetryPass, symmetryFlags, symmetryPasses, flipVec, symmetryFeather, routeMirrorPass } from './symmetry.js';
import { smoothDab } from './smooth.js';
import { getBrush, getBrushForPreset, brushKeys } from './brushes/registry.js';
import { brushSettings, loadPresets, clampRadius, RADIUS_DEFAULT_M } from './presets.js';
import { buildRecord, applyRecord } from './undo.js';

const _v = (a) => (Array.isArray(a) ? a.slice() : [a.x, a.y, a.z]);

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

function allVerts(proxy) {
  const n = proxy.getNbVertices();
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

export function createSculptEngine(engineOptions = {}) {
  const parts = new Map();
  const filters = new Map();
  const maskOps = new Map();

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
      sync() {
        handle.worldToLocal.copy(handle.matrixWorld).invert();
        handle.scale = uniformScaleOf(handle.matrixWorld);
      },
      detach() { parts.delete(id); },
    };
    parts.set(id, handle);
    return handle;
  }

  function collectGeometries(part) {
    if (!part) throw new Error('holosculpt: attach() needs a part');
    if (Array.isArray(part) || part.isBufferGeometry || part.geometries) return part.geometries ?? part;
    const out = [];
    if (part.isMesh) out.push(part);
    if (part.children) for (const c of part.children) if (c.isMesh) out.push(c);
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
    const o = _v(worldRay.origin ?? worldRay.o);
    const d = _v(worldRay.direction ?? worldRay.dir ?? worldRay.d);
    _p.set(o[0], o[1], o[2]).applyMatrix4(handle.worldToLocal);
    _n3.setFromMatrix4(handle.worldToLocal);
    _d.set(d[0], d[1], d[2]).applyMatrix3(_n3).normalize();
    return { origin: [_p.x, _p.y, _p.z], direction: [_d.x, _d.y, _d.z] };
  }

  function pointToLocal(handle, world) {
    const w = _v(world);
    _p.set(w[0], w[1], w[2]).applyMatrix4(handle.worldToLocal);
    return [_p.x, _p.y, _p.z];
  }

  function pointToWorld(handle, local) {
    _p.set(local[0], local[1], local[2]).applyMatrix4(handle.matrixWorld);
    return [_p.x, _p.y, _p.z];
  }

  // ---------------------------------------------------------------- hover

  function hover(worldRay, partRef) {
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

  function dabContext(handle, settings, verts) {
    const proxy = handle.proxy;
    const factors = new Float32Array(verts.length);
    const distances = new Float32Array(verts.length);
    const translations = new Float32Array(verts.length * 3);
    const dirty = new Set();
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
    const handle = partOf(partRef ?? state.stroke?.part);
    if (!handle) throw new Error('holosculpt: no part attached');
    const started = state.stroke && state.stroke.handle === handle;
    if (!started) beginStrokeInternal(handle, input, true);
    const t0 = (globalThis.performance?.now?.() ?? Date.now());
    const moved = dabOnPart(handle, input);
    state.lastDabCostMs = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    return moved;
  }

  function dabOnPart(handle, input) {
    const proxy = handle.proxy;
    const cache = handle._cache;
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
    cache.radius = radiusLocalFromWorld(state.radiusWorld, handle.scale);
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

    if (brush.needsStrokeDirection || NEEDS_STROKE_DIRECTION.has(type)) {
      if (cache.firstTime) { cache.firstTime = false; return false; } // no direction yet
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
    if (cache.firstTime) cache.initialDirectionFlipped = flip < 0;

    const dirty = new Set();
    const useOriginalData = !!brush.usesOriginalData;
    cache._origPositions = proxy.getOrigPositions();
    cache._origNormals = proxy.getOrigNormals();
    const nrf = settings.normal_radius_factor ?? 0.5;
    const arf = settings.area_radius_factor ?? nrf;
    const gatherScale = Math.max(1, nrf, brush.needsAreaCenter ? arf : 0);

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
        ? allVerts(proxy)
        : gatherVerts(proxy, cache.locationSymm, cache.radius * gatherScale);
      if (verts.length === 0) continue;
      for (let k = 0; k < verts.length; k++) proxy.stampOriginal(verts[k]);

      if (pass === 0 && (brush.needsAreaNormal || brush.needsAreaCenter)) {
        updateAreaData(handle, settings, brush, verts);
      }
      if (brush.needsAreaNormal) cache.sculptNormalSymm = flipVec(cache.sculptNormal, pass);
      if (brush.needsAreaCenter) cache.areaCenterSymm = flipVec(cache.areaCenter, pass);

      const ctx = dabContext(handle, settings, verts);
      ctx.useOriginal = useOriginalData;
      // True only for the very first brush action of the stroke (see smooth.js frozenBase).
      ctx.firstBrushAction = cache.strokeStep === 0 && pass === 0;
      calcFactors(proxy, verts, factorParams(cache, settings, useOriginalData), ctx.factors, ctx.distances);
      brush.apply(ctx);

      // Auto-smooth, exactly as Blender does it: a Smooth pass after every dab of every brush
      // except Smooth and Mask.
      const autoSmooth = settings.auto_smooth_factor ?? 0;
      if (!brush.noAutoSmooth && autoSmooth > 0) {
        const strength = settings.use_smooth_pressure ? autoSmooth * cache.pressure : autoSmooth;
        smoothDab(proxy, verts, {
          strength,
          computeFactors: (out) => calcFactors(proxy, verts, factorParams(cache, settings, false), out, ctx.distances),
          onTouch: (v) => { proxy.stampOriginal(v); ctx.dirty.add(v); },
        });
      }
      for (const v of ctx.dirty) dirty.add(v);
    }

    cache.firstTime = false;
    cache.strokeStep++;
    if (dirty.size === 0) return false;
    refresh(handle, Uint32Array.from(dirty));
    return true;
  }

  function updateAreaData(handle, settings, brush, verts) {
    const cache = handle._cache;
    const proxy = handle.proxy;
    // Grab-like brushes freeze the direction at stroke start; so does "original normal".
    const freeze = brush.anchoredOrigin || settings.use_original_normal;
    if (!cache.firstTime && freeze && cache.sculptNormal) return;
    const useOriginal = !accumulateFor(settings.sculpt_brush_type || brush.type, settings);
    const plane = settings.sculpt_plane || 'AREA';
    if (plane !== 'AREA') {
      const axis = { VIEW: cache.viewNormal, X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[plane];
      cache.sculptNormal = axis.slice();
      if (!brush.needsAreaCenter) return;
    }
    const nrf = settings.normal_radius_factor ?? 0.5;
    const arf = settings.area_radius_factor ?? nrf;
    const { normal, center } = calcAreaNormalAndCenter(proxy, {
      verts,
      positions: useOriginal ? proxy.getOrigPositions() : undefined,
      // Always the STROKE-START normals, even with accumulate on. Measured against Blender 5.2.1:
      // replaying the golden strokes with live normals here puts an accumulating Draw 24.9% out
      // and Crease Sharp 8.5% out, while stroke-start normals with live positions bring them to
      // 1.3% and 2.0%. Blender reads these through the evaluated mesh's normal cache, which the
      // brush loop does not refresh between dabs, so the area normal keeps weighing the shape the
      // stroke began with while the dab itself lands on the live surface.
      normals: proxy.getOrigNormals(),
      location: cache.locationSymm,
      viewNormal: cache.viewNormalSymm,
      normalRadius: cache.radius * nrf,
      positionRadius: cache.radius * (brush.needsAreaCenter ? arf : nrf),
      falloffShape: settings.falloff_shape || 'SPHERE',
      needNormal: plane === 'AREA',
      needCenter: !!brush.needsAreaCenter,
    });
    if (plane === 'AREA' && normal) cache.sculptNormal = normal;
    if (center) { cache.areaCenter = center; cache.lastCenter = center; }
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
    refresh(handle, Uint32Array.from(touched));
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

  function beginStrokeInternal(handle, input, silent) {
    const settings = input?.settings ? { ...input.settings } : settingsFor();
    const brush = input?.brush || state.brush;
    handle.proxy.beginStrokeSnapshot();
    handle._cache = createCache({
      radius: radiusLocalFromWorld(state.radiusWorld, handle.scale),
      hardness: settings.hardness || 0,
      firstTime: true,
      invert: state.invert,
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

  function beginStroke(input) {
    const handle = partOf(input.part) || hover(input.worldRay).handle;
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
    const record = buildRecord(stroke.part, stroke.handle.proxy);
    state.stroke = null;
    return record;
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
    const handle = partOf(record.part);
    if (!handle) return false;
    const verts = applyRecord(record, handle.proxy, direction);
    refresh(handle, verts);
    return true;
  }

  function registerFilter(name, fn) { filters.set(name, fn); }
  function registerMaskOp(name, fn) { maskOps.set(name, fn); }

  function filter(name, options = {}) {
    const fn = filters.get(name);
    const handle = partOf(options.part);
    if (!fn || !handle) return null;
    handle.proxy.beginStrokeSnapshot();
    const verts = fn({ engine: api, handle, proxy: handle.proxy, settings: settingsFor(), options }) || allVerts(handle.proxy);
    refresh(handle, Uint32Array.from(verts));
    return buildRecord(handle.id, handle.proxy);
  }

  function maskOp(name, options = {}) {
    const fn = maskOps.get(name);
    const handle = partOf(options.part);
    if (!fn || !handle) return null;
    fn({ engine: api, handle, proxy: handle.proxy, options });
    return true;
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
