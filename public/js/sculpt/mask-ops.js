// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Whole-part mask operations.
//
// The maths of blur/sharpen/invert/clear is adapted from SculptGL's editing/tools/Masking.js
// (MIT, (c) Stephane Ginier - see ./NOTICE), with two changes: our mask uses Blender's convention
// (1 = protected, SculptGL's is the other way round) and it lives in its own Float32 array rather
// than in a colour channel. Grow and shrink are the morphological pair Blender's mask filter uses:
// a vertex takes the largest (or smallest) mask in its one-ring, which walks the boundary out or
// in by one edge per call.
//
// These change no positions, so they produce no undo record of their own; the page snapshots the
// mask if it wants them undoable.

/** Every vertex, as a plain iterator over indices. */
function allVerts(proxy) {
  const n = proxy.getNbVertices();
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

export function maskClear(proxy) {
  proxy.getMask().fill(0);
}

export function maskFill(proxy, value = 1) {
  proxy.getMask().fill(Math.min(Math.max(value, 0), 1));
}

export function maskInvert(proxy) {
  const m = proxy.getMask();
  for (let i = 0; i < m.length; i++) m[i] = 1 - m[i];
}

/** One-ring dilate: the masked region grows by one edge ring. */
export function maskGrow(proxy) {
  const m = proxy.getMask();
  const ring = proxy.getVerticesRingVert();
  const next = Float32Array.from(m);
  for (let v = 0; v < m.length; v++) {
    const nb = ring[v];
    let best = m[v];
    for (let i = 0; i < nb.length; i++) if (m[nb[i]] > best) best = m[nb[i]];
    next[v] = best;
  }
  m.set(next);
}

/** One-ring erode: the masked region shrinks by one edge ring. */
export function maskShrink(proxy) {
  const m = proxy.getMask();
  const ring = proxy.getVerticesRingVert();
  const next = Float32Array.from(m);
  for (let v = 0; v < m.length; v++) {
    const nb = ring[v];
    let best = m[v];
    for (let i = 0; i < nb.length; i++) if (m[nb[i]] < best) best = m[nb[i]];
    next[v] = best;
  }
  m.set(next);
}

/** Laplacian smoothing of the mask values: softens the boundary without moving it. */
export function maskBlur(proxy, iterations = 1) {
  const m = proxy.getMask();
  const ring = proxy.getVerticesRingVert();
  for (let it = 0; it < iterations; it++) {
    const next = Float32Array.from(m);
    for (let v = 0; v < m.length; v++) {
      const nb = ring[v];
      if (nb.length === 0) continue;
      let sum = 0;
      for (let i = 0; i < nb.length; i++) sum += m[nb[i]];
      next[v] = sum / nb.length;
    }
    m.set(next);
  }
}

/** SculptGL's contrast step: push each value to whichever end of the range it is nearer. */
export function maskSharpen(proxy) {
  const m = proxy.getMask();
  for (let i = 0; i < m.length; i++) {
    m[i] = m[i] > 0.5 ? Math.min(m[i] + 0.1, 1) : Math.max(m[i] - 0.1, 0);
  }
}

/** The vertices whose mask is above `threshold`, e.g. for a "show the masked part" readout. */
export function maskedVertices(proxy, threshold = 0) {
  const m = proxy.getMask();
  const out = [];
  for (let i = 0; i < m.length; i++) if (m[i] > threshold) out.push(i);
  return Uint32Array.from(out);
}

/** name -> fn({proxy, options}), the shape engine.registerMaskOp() wants. */
export const MASK_OPS = {
  clear: ({ proxy }) => maskClear(proxy),
  fill: ({ proxy, options }) => maskFill(proxy, options?.value ?? 1),
  invert: ({ proxy }) => maskInvert(proxy),
  grow: ({ proxy, options }) => { for (let i = 0; i < (options?.iterations ?? 1); i++) maskGrow(proxy); },
  shrink: ({ proxy, options }) => { for (let i = 0; i < (options?.iterations ?? 1); i++) maskShrink(proxy); },
  blur: ({ proxy, options }) => maskBlur(proxy, options?.iterations ?? 1),
  sharpen: ({ proxy }) => maskSharpen(proxy),
};

/** Plug every mask op into an engine. */
export function registerMaskOps(engine) {
  for (const [name, fn] of Object.entries(MASK_OPS)) engine.registerMaskOp(name, fn);
  return engine;
}

export { allVerts };
