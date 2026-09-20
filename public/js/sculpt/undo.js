// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. The idea is Blender's (sculpt_undo.cc): the first time a vertex is touched
// in a stroke its position is saved, and that one copy serves as both the brushes' "original data"
// and the undo record. So undo memory is proportional to what the artist actually touched.
//
// That holds for the dab brushes. It does NOT hold for the two whole-part paths - Elastic Grab
// (allVertices: no radius, so the whole part answers the pull) and the mesh filters - where every
// vertex is genuinely touched and genuinely moves: measured, one elastic stroke is 2.1 MB on a
// 150k-triangle part, 5.5 MB at 400k and 13 MB at a million. Those get a compact whole-part shape
// (`whole: true`, no index array, a memcpy to undo) and say so, so the page's timeline can put a
// byte cap on exactly the records that need one. record.bytes is the real cost, always.
//
// Blender pushes a SECOND undo type, undo::Type::Mask, for the Mask brush and every mask operator,
// and restores it separately (sculpt_undo.cc restore_mask_mesh). Without that, a mask stroke
// produced no record at all here and the next "undo" silently undid the previous sculpt stroke
// instead. So a record is one of:
//   {type:'stroke', part, idx, before, after}    positions, sparse
//   {type:'stroke', part, whole:true, before, after}   positions, every vertex
//   {type:'mask',   part, idx, before, after}    mask values, one float per vertex
//   {type:'multi',  part, records:[...]}         a stroke that changed both
// All of them are plain data, so the page's timeline can keep them next to part moves and Fable
// builds without knowing anything about the engine.

/** Build the undo record for the stroke that just ended, or null when nothing changed. */
export function buildRecord(partId, proxy) {
  const touched = proxy.getTouched();
  if (!touched || touched.length === 0) return null;
  const position = buildPositionRecord(partId, proxy, touched);
  const mask = buildStrokeMaskRecord(partId, proxy, touched);
  if (position && mask) {
    return { type: 'multi', part: partId, records: [position, mask], bytes: position.bytes + mask.bytes };
  }
  return position || mask || null;
}

function buildPositionRecord(partId, proxy, touched) {
  const positions = proxy.getVertices();
  const orig = proxy.getOrigPositions();
  // Count first, allocate exactly. Sizing from touched.length and slicing afterwards doubled the
  // peak - 10.9 MB in flight for a 400k-vertex elastic stroke, 26.6 MB at a million.
  let n = 0;
  for (let k = 0; k < touched.length; k++) {
    const i3 = 3 * touched[k];
    if (orig[i3] !== positions[i3] || orig[i3 + 1] !== positions[i3 + 1] || orig[i3 + 2] !== positions[i3 + 2]) n++;
  }
  if (n === 0) return null;

  // Every vertex of the part moved (Elastic Grab, the filters): the index array is the identity,
  // so drop it and let applyRecord memcpy the whole position buffer back.
  const whole = n === proxy.getNbVertices();
  const before = new Float32Array(3 * n);
  const after = new Float32Array(3 * n);
  if (whole) {
    before.set(orig.subarray(0, 3 * n));
    after.set(positions.subarray(0, 3 * n));
    return { type: 'stroke', part: partId, whole: true, before, after, bytes: n * 24 };
  }

  const idx = new Uint32Array(n);
  let w = 0;
  for (let k = 0; k < touched.length; k++) {
    const v = touched[k];
    const i3 = 3 * v;
    if (orig[i3] === positions[i3] && orig[i3 + 1] === positions[i3 + 1] && orig[i3 + 2] === positions[i3 + 2]) continue;
    idx[w] = v;
    before[3 * w] = orig[i3]; before[3 * w + 1] = orig[i3 + 1]; before[3 * w + 2] = orig[i3 + 2];
    after[3 * w] = positions[i3]; after[3 * w + 1] = positions[i3 + 1]; after[3 * w + 2] = positions[i3 + 2];
    w++;
  }
  return { type: 'stroke', part: partId, idx, before, after, bytes: n * 28 };
}

/** The mask half of a stroke: the stamping machinery already ran, so this is a second pass. */
function buildStrokeMaskRecord(partId, proxy, touched) {
  if (!proxy.getOrigMask) return null;
  const mask = proxy.getMask();
  const orig = proxy.getOrigMask();
  if (!mask || !orig) return null;
  let n = 0;
  for (let k = 0; k < touched.length; k++) if (mask[touched[k]] !== orig[touched[k]]) n++;
  if (n === 0) return null;
  const idx = new Uint32Array(n);
  const before = new Float32Array(n);
  const after = new Float32Array(n);
  let w = 0;
  for (let k = 0; k < touched.length; k++) {
    const v = touched[k];
    if (mask[v] === orig[v]) continue;
    idx[w] = v; before[w] = orig[v]; after[w] = mask[v];
    w++;
  }
  return { type: 'mask', part: partId, idx, before, after, bytes: n * 12 };
}

/**
 * The record for a whole-part mask operation: diff the mask against a copy taken before the op.
 * Fill and invert legitimately cost the whole array; grow, shrink and blur only touch a band.
 */
export function buildMaskRecord(partId, proxy, before) {
  const mask = proxy.getMask();
  if (!mask || !before) return null;
  let n = 0;
  for (let v = 0; v < mask.length; v++) if (mask[v] !== before[v]) n++;
  if (n === 0) return null;
  const idx = new Uint32Array(n);
  const b = new Float32Array(n);
  const a = new Float32Array(n);
  let w = 0;
  for (let v = 0; v < mask.length; v++) {
    if (mask[v] === before[v]) continue;
    idx[w] = v; b[w] = before[v]; a[w] = mask[v];
    w++;
  }
  return { type: 'mask', part: partId, idx, before: b, after: a, bytes: n * 12 };
}

/**
 * Put a record back. Exact: the arrays hold the very floats the vertices had.
 * @returns {Uint32Array} the vertices whose POSITION changed, for the caller to re-scatter (empty
 *          for a mask-only record, which needs no geometry refresh).
 */
export function applyRecord(record, proxy, direction = 'undo') {
  if (!record) return EMPTY;
  if (record.type === 'multi') {
    let out = EMPTY;
    for (const r of record.records) {
      const v = applyRecord(r, proxy, direction);
      if (v.length > out.length) out = v;
    }
    return out;
  }
  const src = direction === 'redo' ? record.after : record.before;
  if (record.type === 'mask') {
    const mask = proxy.getMask();
    for (let k = 0; k < record.idx.length; k++) mask[record.idx[k]] = src[k];
    return EMPTY;
  }
  const positions = proxy.getVertices();
  if (record.whole) {
    positions.set(src);
    return allIndices(src.length / 3);
  }
  for (let k = 0; k < record.idx.length; k++) {
    const i3 = 3 * record.idx[k];
    positions[i3] = src[3 * k];
    positions[i3 + 1] = src[3 * k + 1];
    positions[i3 + 2] = src[3 * k + 2];
  }
  return record.idx;
}

const EMPTY = new Uint32Array(0);

function allIndices(n) {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}
