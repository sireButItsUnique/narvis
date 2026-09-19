// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Whole-part mesh filters: "smooth it all", "inflate it all", "sharpen it
// all", "make it bigger". Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/smooth.cc (the neighbour average and the
//     border/corner rule, via ./smooth.js)
//   source/blender/editors/sculpt_paint/mesh/brushes/enhance_details.cc (the sharpen direction)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// A filter is a brush with no dab: it runs over the whole part at one strength, and the only
// weight is the mask, so "smooth it all" leaves a masked face alone. That is the point of the
// mask for a hand-driven workbench - you cannot hold a brush steady enough to smooth a whole
// model by hand, but you can mask the eyes and say "smooth it all".
//
// The two length-based filters need a size. A filter has no brush radius to borrow, so they use a
// fraction of the part's own bounding-box diagonal: that keeps "inflate it all" the same visible
// amount whether the part arrived from Blender at 2 cm or 2 m. Pass {amount} in part-local metres
// to say it exactly instead. This scaling is ours, not Blender's.

import { interiorNeighbors, neighborAverage } from './smooth.js';

/** Fraction of the bounding-box diagonal that strength 1 moves a vertex. */
const DEFAULT_SPAN = 0.02;

function boundsDiagonal(proxy) {
  const p = proxy.getVertices();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

function centroid(proxy) {
  const p = proxy.getVertices();
  let x = 0, y = 0, z = 0;
  const n = proxy.getNbVertices();
  for (let i = 0; i < n; i++) { x += p[3 * i]; y += p[3 * i + 1]; z += p[3 * i + 2]; }
  return n ? [x / n, y / n, z / n] : [0, 0, 0];
}

/** The per-vertex weight every filter shares: 1 where free, 0 where fully masked. */
function weights(proxy) {
  const mask = proxy.getMask();
  const n = proxy.getNbVertices();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mask ? 1 - mask[i] : 1;
  return out;
}

/** Move a vertex and record it for undo and the render scatter. */
function move(proxy, positions, v, dx, dy, dz, touched) {
  if (dx === 0 && dy === 0 && dz === 0) return;
  proxy.stampOriginal(v);
  positions[3 * v] += dx;
  positions[3 * v + 1] += dy;
  positions[3 * v + 2] += dz;
  touched.push(v);
}

/**
 * Smooth the whole part: each free vertex moves towards the average of its neighbours, with
 * Blender's border rule (a border vertex only averages border neighbours, a corner never moves),
 * so the silhouette of an open part survives.
 * options: {strength = 0.5, iterations = 1}
 */
export function filterSmooth({ proxy, options = {} }) {
  const strength = Math.min(Math.max(options.strength ?? 0.5, 0), 1);
  const iterations = Math.max(1, options.iterations ?? 1);
  const w = weights(proxy);
  const positions = proxy.getVertices();
  const n = proxy.getNbVertices();
  const touched = [];
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const avg = neighborAverage(proxy, v, positions);
      next[3 * v] = avg[0]; next[3 * v + 1] = avg[1]; next[3 * v + 2] = avg[2];
    }
    for (let v = 0; v < n; v++) {
      const f = w[v] * strength;
      if (f === 0) continue;
      move(proxy, positions, v,
        (next[3 * v] - positions[3 * v]) * f,
        (next[3 * v + 1] - positions[3 * v + 1]) * f,
        (next[3 * v + 2] - positions[3 * v + 2]) * f,
        touched);
    }
  }
  return touched;
}

/**
 * Inflate (or, with a negative strength, deflate) the whole part along its vertex normals.
 * options: {strength = 0.5, amount}  amount overrides the bounding-box scaling, in part metres.
 */
export function filterInflate({ proxy, options = {} }) {
  const strength = options.strength ?? 0.5;
  const step = options.amount ?? boundsDiagonal(proxy) * DEFAULT_SPAN * strength;
  const w = weights(proxy);
  const positions = proxy.getVertices();
  const normals = proxy.getRenderNormals();
  const touched = [];
  for (let v = 0; v < proxy.getNbVertices(); v++) {
    const f = w[v] * step;
    if (f === 0) continue;
    const i3 = 3 * v;
    move(proxy, positions, v, normals[i3] * f, normals[i3 + 1] * f, normals[i3 + 2] * f, touched);
  }
  return touched;
}

/**
 * Sharpen: the opposite of smooth. Each free vertex is pushed AWAY from its neighbour average,
 * which exaggerates whatever detail is already there (Blender's Enhance Details, over the whole
 * part). Directions are all read first, so one vertex moving does not change its neighbour's aim.
 * options: {strength = 0.5}
 */
export function filterSharpen({ proxy, options = {} }) {
  const strength = Math.min(Math.max(options.strength ?? 0.5, 0), 1);
  const w = weights(proxy);
  const positions = proxy.getVertices();
  const n = proxy.getNbVertices();
  const dirs = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    if (interiorNeighbors(proxy, v).length === 0) continue;
    const avg = neighborAverage(proxy, v, positions);
    dirs[3 * v] = positions[3 * v] - avg[0];
    dirs[3 * v + 1] = positions[3 * v + 1] - avg[1];
    dirs[3 * v + 2] = positions[3 * v + 2] - avg[2];
  }
  const touched = [];
  for (let v = 0; v < n; v++) {
    const f = w[v] * strength;
    if (f === 0) continue;
    move(proxy, positions, v, dirs[3 * v] * f, dirs[3 * v + 1] * f, dirs[3 * v + 2] * f, touched);
  }
  return touched;
}

/**
 * Scale the whole part about its own centroid. strength 0.5 makes it 50% bigger, -0.5 half the
 * size; masked vertices stay put, so scaling a masked head grows the body around it.
 * options: {strength = 0.5, center}
 */
export function filterScale({ proxy, options = {} }) {
  const strength = options.strength ?? 0.5;
  const c = options.center || centroid(proxy);
  const w = weights(proxy);
  const positions = proxy.getVertices();
  const touched = [];
  for (let v = 0; v < proxy.getNbVertices(); v++) {
    const f = w[v] * strength;
    if (f === 0) continue;
    const i3 = 3 * v;
    move(proxy, positions, v,
      (positions[i3] - c[0]) * f,
      (positions[i3 + 1] - c[1]) * f,
      (positions[i3 + 2] - c[2]) * f,
      touched);
  }
  return touched;
}

/** name -> fn({engine, handle, proxy, settings, options}) -> touched vertices. */
export const MESH_FILTERS = {
  smooth: filterSmooth,
  inflate: filterInflate,
  sharpen: filterSharpen,
  scale: filterScale,
};

/** Plug every filter into an engine. */
export function registerFilters(engine) {
  for (const [name, fn] of Object.entries(MESH_FILTERS)) engine.registerFilter(name, fn);
  return engine;
}
