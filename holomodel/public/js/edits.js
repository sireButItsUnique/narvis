// SPDX-License-Identifier: GPL-3.0-or-later
// Brush strokes, kept somewhere other than this tab.
//
// Blender owns the model and every version snapshot is a snapshot of Blender - but Blender never
// sees a brush stroke. Sculpting happens here, against a welded proxy of the mesh, and until this
// file existed it lived in one tab's memory and died with it: reload and the work was gone, and no
// version contained it either.
//
// So each stroke is posted to the server (MongoDB, see server/edits.js) as it finishes, and the
// stream is replayed when a scene loads. The same stream is the undo stack, which is why undo also
// has to take the newest one off: if the page forgot a stroke that the database still had, the next
// reload would put it back.
//
// The wire format is the engine's own undo record with its typed arrays base64'd. Nothing is
// interpreted here or on the server - a record goes out and comes back and is handed straight to
// engine.applyHistory(), so there is one definition of what a stroke is (js/sculpt/undo.js).

const b64 = {
  // Chunked so a big stroke cannot blow the argument limit: 400k vertices is a 4.8 MB Float32Array,
  // and String.fromCharCode.apply on that throws rather than returning a string.
  encode(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  decode(text, Kind) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Kind(bytes.buffer, 0, bytes.byteLength / Kind.BYTES_PER_ELEMENT);
  },
};

const KINDS = { idx: Int32Array, before: Float32Array, after: Float32Array };

/** An engine record -> something JSON can carry. Recurses for the 'multi' shape. */
export function encodeRecord(rec) {
  if (!rec) return null;
  if (rec.type === 'multi') {
    return { type: 'multi', part: rec.part, bytes: rec.bytes, records: rec.records.map(encodeRecord) };
  }
  const out = { type: rec.type, part: rec.part, bytes: rec.bytes };
  if (rec.whole) out.whole = true;
  for (const key of Object.keys(KINDS)) if (rec[key]) out[key] = b64.encode(rec[key]);
  return out;
}

/** ...and back. The arrays come out as the same types the engine put in. */
export function decodeRecord(row) {
  if (!row) return null;
  if (row.type === 'multi') {
    return { type: 'multi', part: row.part, bytes: row.bytes, records: row.records.map(decodeRecord) };
  }
  const out = { type: row.type, part: row.part, bytes: row.bytes };
  if (row.whole) out.whole = true;
  for (const [key, Kind] of Object.entries(KINDS)) if (row[key]) out[key] = b64.decode(row[key], Kind);
  return out;
}

// ---------------------------------------------------------------- the stream

const state = { rev: null, saved: 0, bytes: 0, kind: null, failed: false };
export const editsState = () => ({ ...state });

/** Which scene revision the strokes being saved belong to. A stroke is about one revision's mesh. */
export function forRev(rev) {
  state.rev = Number.isFinite(rev) ? rev : null;
  state.saved = 0; state.bytes = 0;
}

/**
 * Save one finished stroke. Deliberately not awaited by the stroke path: a round trip in the middle
 * of sculpting would be felt, and a stroke that fails to save is still on screen and still undoable
 * this session - it just will not survive a reload, which is what editsState().failed reports.
 */
export function saveStroke(record) {
  if (state.rev === null || !record) return Promise.resolve(null);
  const payload = encodeRecord(record);
  return fetch(`/api/edits?rev=${state.rev}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: record.part, type: record.type, bytes: record.bytes || 0, payload }),
  }).then(r => r.json()).then(r => {
    state.failed = !r?.ok;
    if (r?.ok) { state.saved = r.kept ?? state.saved + 1; state.bytes += record.bytes || 0; }
    return r;
  }).catch(() => { state.failed = true; return null; });
}

/** Undo: the database has to forget it too, or a reload would bring it back. */
export function dropLastStroke() {
  if (state.rev === null) return Promise.resolve(null);
  return fetch(`/api/edits?rev=${state.rev}`, { method: 'DELETE' })
    .then(r => r.json()).then(r => { if (r?.ok) state.saved = Math.max(0, state.saved - 1); return r; })
    .catch(() => null);
}

/** Everything sculpted on this revision, oldest first. */
export async function loadStrokes(rev) {
  try {
    const r = await fetch(`/api/edits?rev=${rev}`);
    if (!r.ok) return [];
    const body = await r.json();
    state.kind = body.kind || null;
    state.saved = body.count || 0;
    state.bytes = body.bytes || 0;
    return (body.edits || []).map(e => decodeRecord(e.payload)).filter(Boolean);
  } catch { return []; }
}

export function clearStrokes(rev = state.rev) {
  if (rev === null) return Promise.resolve(null);
  return fetch(`/api/edits?rev=${rev}&all=1`, { method: 'DELETE' }).then(r => r.json()).catch(() => null);
}
