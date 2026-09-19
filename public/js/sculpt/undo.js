// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. The idea is Blender's (sculpt_undo.cc): the first time a vertex is touched
// in a stroke its position is saved, and that one copy serves as both the brushes' "original data"
// and the undo record. So undo memory is proportional to what the artist actually touched, not to
// the size of the part - about 5.7 MB even for a million-triangle part sculpted all over.
//
// A record is plain data ({part, idx, before, after}), so the page's timeline can keep it next to
// part moves and Fable builds without knowing anything about the engine.

/** Build the undo record for the stroke that just ended, or null when nothing moved. */
export function buildRecord(partId, proxy) {
  const touched = proxy.getTouched();
  if (!touched || touched.length === 0) return null;
  const positions = proxy.getVertices();
  const orig = proxy.getOrigPositions();
  const idx = new Uint32Array(touched.length);
  const before = new Float32Array(touched.length * 3);
  const after = new Float32Array(touched.length * 3);
  let n = 0;
  for (let k = 0; k < touched.length; k++) {
    const v = touched[k];
    const i3 = 3 * v;
    if (orig[i3] === positions[i3] && orig[i3 + 1] === positions[i3 + 1] && orig[i3 + 2] === positions[i3 + 2]) continue;
    idx[n] = v;
    before[3 * n] = orig[i3]; before[3 * n + 1] = orig[i3 + 1]; before[3 * n + 2] = orig[i3 + 2];
    after[3 * n] = positions[i3]; after[3 * n + 1] = positions[i3 + 1]; after[3 * n + 2] = positions[i3 + 2];
    n++;
  }
  if (n === 0) return null;
  return {
    type: 'stroke',
    part: partId,
    idx: idx.slice(0, n),
    before: before.slice(0, 3 * n),
    after: after.slice(0, 3 * n),
    bytes: n * 28,
  };
}

/**
 * Put a record's positions back. Exact: the arrays hold the very floats the vertices had.
 * @returns {Uint32Array} the vertices that changed, for the caller to re-scatter.
 */
export function applyRecord(record, proxy, direction = 'undo') {
  const src = direction === 'redo' ? record.after : record.before;
  const positions = proxy.getVertices();
  for (let k = 0; k < record.idx.length; k++) {
    const i3 = 3 * record.idx[k];
    positions[i3] = src[3 * k];
    positions[i3 + 1] = src[3 * k + 1];
    positions[i3 + 2] = src[3 * k + 2];
  }
  return record.idx;
}
