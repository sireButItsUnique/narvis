// The sculpt stream: every brush stroke, in order, in MongoDB.
//
// This is the only copy of your sculpting that exists anywhere. Blender builds the model and owns
// the .blend, but it never sees a brush stroke - those happen in the browser, against a welded proxy
// of the mesh, and until now they lived in one tab's memory and died with it. Reload and the work
// was gone; a version snapshot did not contain it, because a version is a snapshot of Blender.
//
// So the strokes are written here as they happen. Three things fall out of the one mechanism:
//   - undo survives a reload, because the stack is the stream;
//   - the SCULPTING survives a reload, because replaying the stream rebuilds it;
//   - and it is a real workload for the database rather than a file cabinet: an append-only binary
//     stream per scene revision, capped two ways, read back in order.
//
// A stroke's record is already plain data (js/sculpt/undo.js): index and position arrays, sparse,
// sized to what the brush actually touched. It travels as base64 and is stored as binary.
//
// Keyed by scene REVISION, not by session. A stroke describes vertices of one revision's mesh; when
// Blender publishes a new one the geometry is different and the old strokes are meaningless, so
// they are not offered for it. They are left in place rather than deleted: going back to that
// version can pick them up again.
import fs from 'node:fs';
import path from 'node:path';
import { history, HOME } from './history.js';

const DIR = path.join(HOME, 'edits');            // the no-Atlas fallback, one JSON file per revision

// Two caps, because a stroke is not a small thing. KEEP is how far back undo can reach, and is the
// number the page promises. BYTES is the real limit: one elastic-grab stroke on a big part is
// megabytes (the engine measures it and says so in record.bytes), a Mongo document stops at 16 MB,
// and an Atlas free tier is 512 MB for everything including the version snapshots.
export const KEEP_EDITS = 10;
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export class EditsError extends Error {}

const atlas = async () => {
  const store = await history();
  return store.kind === 'atlas' ? store.db.collection('edits') : null;
};

// ---------------------------------------------------------------- local fallback

const localFile = (rev) => path.join(DIR, `rev-${rev}.json`);
function localRead(rev) {
  try { return JSON.parse(fs.readFileSync(localFile(rev), 'utf8')); } catch { return []; }
}
function localWrite(rev, rows) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(localFile(rev), JSON.stringify(rows));
}

// ---------------------------------------------------------------- the stream

const bytesOf = (row) => Number(row.bytes) || 0;

/** Drop the oldest until both caps hold. Returns what survives, in order. */
function trim(rows) {
  let kept = rows.slice(-KEEP_EDITS);
  let total = kept.reduce((n, r) => n + bytesOf(r), 0);
  while (kept.length > 1 && total > MAX_STREAM_BYTES) {
    total -= bytesOf(kept[0]);
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * Append one stroke to a revision's stream.
 * @param {number} rev   the scene revision these vertices belong to
 * @param {object} row   {part, type, bytes, payload} - payload is the record, base64 arrays inside
 * @returns {Promise<{ok: boolean, kept: number, dropped: number, skipped?: string}>}
 */
export async function addEdit(rev, row) {
  if (!Number.isFinite(rev)) throw new EditsError('a stroke belongs to a scene revision');
  if (!row || typeof row.payload !== 'object') throw new EditsError('nothing to save');
  const bytes = bytesOf(row);
  // Too big to be worth the round trip, and close enough to Mongo's document limit to be a real
  // risk. The page keeps it in memory, so undo still works this session - it just will not survive
  // a reload, and the page is told which it got.
  if (bytes > MAX_RECORD_BYTES) return { ok: false, kept: 0, dropped: 0, skipped: 'too big to store' };

  const doc = { rev, at: new Date(), part: String(row.part || ''), type: String(row.type || 'stroke'),
                bytes, payload: row.payload };
  const col = await atlas();
  if (col) {
    await col.insertOne(doc);
    const all = await col.find({ rev }).sort({ at: 1, _id: 1 }).project({ bytes: 1 }).toArray();
    const keep = new Set(trim(all).map(d => String(d._id)));
    const dead = all.filter(d => !keep.has(String(d._id))).map(d => d._id);
    if (dead.length) await col.deleteMany({ _id: { $in: dead } });
    return { ok: true, kept: keep.size, dropped: dead.length };
  }
  const rows = localRead(rev);
  rows.push(doc);
  const kept = trim(rows);
  localWrite(rev, kept);
  return { ok: true, kept: kept.length, dropped: rows.length - kept.length };
}

/** Every stroke for this revision, oldest first: replaying them in order rebuilds the sculpting. */
export async function listEdits(rev) {
  const col = await atlas();
  if (col) return col.find({ rev }).sort({ at: 1, _id: 1 }).toArray();
  return localRead(rev);
}

/** Forget the newest stroke: what undo does, so the stream and the page agree about what happened. */
export async function dropLastEdit(rev) {
  const col = await atlas();
  if (col) {
    const [last] = await col.find({ rev }).sort({ at: -1, _id: -1 }).limit(1).toArray();
    if (!last) return { ok: true, removed: 0 };
    await col.deleteOne({ _id: last._id });
    return { ok: true, removed: 1 };
  }
  const rows = localRead(rev);
  if (!rows.length) return { ok: true, removed: 0 };
  rows.pop();
  localWrite(rev, rows);
  return { ok: true, removed: 1 };
}

/** Throw the whole stream away (a new model, or "clear"). */
export async function clearEdits(rev) {
  const col = await atlas();
  if (col) { const r = await col.deleteMany({ rev }); return { ok: true, removed: r.deletedCount || 0 }; }
  const n = localRead(rev).length;
  try { fs.rmSync(localFile(rev), { force: true }); } catch {}
  return { ok: true, removed: n };
}

/** What the page shows about where its sculpting lives. */
export async function editsInfo(rev) {
  const rows = await listEdits(rev);
  const col = await atlas();
  return { kind: col ? 'atlas' : 'local', count: rows.length,
           bytes: rows.reduce((n, r) => n + bytesOf(r), 0), keep: KEEP_EDITS };
}
