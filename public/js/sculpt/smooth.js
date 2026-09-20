// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Paraphrased, from the maths, from Blender @235621e:
//   source/blender/editors/sculpt_paint/mesh/brushes/smooth.cc (iteration_strengths, do_smooth_brush)
//   source/blender/editors/sculpt_paint/mesh/brushes/enhance_details.cc (do_enhance_details_brush)
//   source/blender/editors/sculpt_paint/mesh/sculpt_smooth.cc (neighbour averaging)
//   source/blender/editors/sculpt_paint/mesh/sculpt.cc (calc_vert_neighbors_interior, boundary info)
// Blender is GPL-2.0-or-later; this file is distributed as GPL-3.0-or-later.
//
// Smoothing is a neighbour average, but three details make it feel like Blender's:
//   - strength above 0.25 turns into whole extra passes (floor(4s) full passes plus a partial
//     one), instead of one huge step that would collapse the surface;
//   - a vertex on an open border only averages its border neighbours, and a border vertex with
//     just two neighbours (a corner) does not move at all, so edges stay where the artist put them;
//   - inverted smoothing is Enhance Details: the direction is taken once at stroke start and then
//     pushed the other way, which sharpens instead of blurring.

/** floor(4s) full passes plus one partial pass; matches Blender's iteration_strengths. */
export function iterationStrengths(strength) {
  const maxIterations = 4;
  const s = Math.min(Math.max(strength, 0), 1);
  const count = Math.trunc(s * maxIterations);
  const last = maxIterations * (s - count / maxIterations);
  const out = [];
  for (let i = 0; i < count; i++) out.push(1);
  out.push(last);
  return out;
}

/** How many faces of `proxy` contain both v and u (1 means the edge is a border). */
function edgeFaceCount(proxy, v, u) {
  const faces = proxy.getFaces();
  const fring = proxy.getVerticesRingFace()[v];
  let n = 0;
  for (let i = 0; i < fring.length; i++) {
    const idf = fring[i] * 4;
    if (faces[idf] === u || faces[idf + 1] === u || faces[idf + 2] === u) n++;
  }
  return n;
}

/**
 * The neighbours a smoothing pass may average, with Blender's interior rule.
 * @returns {number[]} possibly empty (a corner never moves)
 */
export function interiorNeighbors(proxy, v) {
  const ring = proxy.getVerticesRingVert()[v];
  if (!proxy.getVerticesOnEdge()[v]) return ring;
  if (ring.length === 2) return [];
  const out = [];
  for (let i = 0; i < ring.length; i++) if (edgeFaceCount(proxy, v, ring[i]) < 2) out.push(ring[i]);
  return out;
}

/**
 * Average of the interior neighbours, or the vertex itself when it has none (loose vertex).
 * `out` is written in place when given: a smoothing pass calls this once per vertex per pass, so
 * returning a fresh [x,y,z] made it one of the hottest allocation sites in the engine.
 */
export function neighborAverage(proxy, v, positions, out) {
  const nb = interiorNeighbors(proxy, v);
  const p = positions || proxy.getVertices();
  const o = out || [0, 0, 0];
  if (nb.length === 0) {
    o[0] = p[3 * v]; o[1] = p[3 * v + 1]; o[2] = p[3 * v + 2];
    return o;
  }
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < nb.length; i++) {
    const u = nb[i];
    x += p[3 * u]; y += p[3 * u + 1]; z += p[3 * u + 2];
  }
  o[0] = x / nb.length; o[1] = y / nb.length; o[2] = z / nb.length;
  return o;
}

/**
 * One smoothing dab over `verts`: floor(4s) full passes plus a partial one, each pass moving
 * every weighed vertex towards the average of its neighbours.
 *
 * `o.frozenBase` reproduces a measured quirk of the reference build (Blender 5.2.1). The brushes
 * read positions through an evaluated copy of the mesh; the very first brush action of a stroke
 * un-shares that copy while still reading the shared original, so its passes all weigh and average
 * the same frozen positions and simply add up. Measured headless, ONE dab on a bumpy icosphere at
 * strength 0.125 / 0.25 / 0.5 / 0.7 / 1.0 moves the surface 0.00035 / 0.00142 / 0.00567 / 0.01111
 * / 0.02266 - exactly proportional to the SUM of the pass strengths (0.0625 / 0.25 / 1 / 1.96 / 4),
 * which only happens if the passes never see each other. From the second brush action on, the copy
 * is live again and the passes compose one after another, which is what the numbers show there.
 * Getting this right is the difference between 0.2% and 20% against the golden stroke.
 *
 * @param {object} proxy
 * @param {Uint32Array} verts
 * @param {object} o {strength, frozenBase, computeFactors(factorsOut), onTouch(v), factors,
 *                    newPositions}  the last two are scratch buffers the caller may lend us,
 *                    because auto-smooth runs this on every dab of every brush.
 */
export function smoothDab(proxy, verts, o) {
  const positions = proxy.getVertices();
  const factors = o.factors && o.factors.length >= verts.length
    ? o.factors.subarray(0, verts.length) : new Float32Array(verts.length);
  const newPositions = o.newPositions && o.newPositions.length >= verts.length * 3
    ? o.newPositions.subarray(0, verts.length * 3) : new Float32Array(verts.length * 3);
  const strengths = iterationStrengths(o.strength);

  if (o.frozenBase) {
    let total = 0;
    for (const s of strengths) total += s;
    if (total === 0) return;
    applyPass(proxy, verts, positions, factors, newPositions, total, o);
    return;
  }

  for (const passStrength of strengths) {
    if (passStrength === 0) continue;
    applyPass(proxy, verts, positions, factors, newPositions, passStrength, o);
  }
}

const _avg = [0, 0, 0];

function applyPass(proxy, verts, positions, factors, newPositions, strength, o) {
  o.computeFactors(factors);
  for (let k = 0; k < verts.length; k++) {
    neighborAverage(proxy, verts[k], positions, _avg);
    newPositions[3 * k] = _avg[0];
    newPositions[3 * k + 1] = _avg[1];
    newPositions[3 * k + 2] = _avg[2];
  }
  for (let k = 0; k < verts.length; k++) {
    const f = factors[k] * strength;
    if (f === 0) continue;
    const v = verts[k];
    if (o.onTouch) o.onTouch(v);
    positions[3 * v] += (newPositions[3 * k] - positions[3 * v]) * f;
    positions[3 * v + 1] += (newPositions[3 * k + 1] - positions[3 * v + 1]) * f;
    positions[3 * v + 2] += (newPositions[3 * k + 2] - positions[3 * v + 2]) * f;
  }
}

/**
 * Enhance Details: the per-vertex direction "away from the neighbour average", taken once at the
 * start of the stroke over the whole part (Blender's cache.detail_directions). Plain one-ring
 * neighbours here, not the interior rule.
 */
export function detailDirections(proxy) {
  const n = proxy.getNbVertices();
  const positions = proxy.getVertices();
  const ring = proxy.getVerticesRingVert();
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const nb = ring[v];
    if (nb.length === 0) continue;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < nb.length; i++) {
      const u = nb[i];
      x += positions[3 * u]; y += positions[3 * u + 1]; z += positions[3 * u + 2];
    }
    out[3 * v] = x / nb.length - positions[3 * v];
    out[3 * v + 1] = y / nb.length - positions[3 * v + 1];
    out[3 * v + 2] = z / nb.length - positions[3 * v + 2];
  }
  return out;
}

/** Enhance Details dab: push along the stored direction, scaled by factor and clamped strength. */
export function enhanceDab(proxy, verts, factors, directions, strength) {
  const positions = proxy.getVertices();
  const s = Math.min(Math.max(strength, -1), 1);
  for (let k = 0; k < verts.length; k++) {
    const f = factors[k] * s;
    if (f === 0) continue;
    const v = verts[k];
    positions[3 * v] += directions[3 * v] * f;
    positions[3 * v + 1] += directions[3 * v + 1] * f;
    positions[3 * v + 2] += directions[3 * v + 2] * f;
  }
}
