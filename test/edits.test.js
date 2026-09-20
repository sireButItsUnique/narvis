// SPDX-License-Identifier: GPL-3.0-or-later
// The sculpt stream: the only copy of a brush stroke that exists anywhere, so the two things that
// must never be wrong are the wire format (a stroke that comes back different is a corrupted model)
// and the caps (one elastic stroke is megabytes, a Mongo document stops at 16 MB, and the free tier
// is 512 MB for everything).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeRecord, decodeRecord } from '../public/js/edits.js';

// history.js reads HOLOMODEL_HOME at import, and with no MONGODB_URI it uses files - so the server
// side can be tested for real, on the same code path a laptop with no Atlas takes.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-edits-'));
process.env.HOLOMODEL_HOME = HOME;
delete process.env.MONGODB_URI;
const { addEdit, listEdits, dropLastEdit, clearEdits, KEEP_EDITS, MAX_RECORD_BYTES } =
  await import('../server/edits.js');

const stroke = (part = 'p1', n = 8, seed = 1) => ({
  type: 'stroke',
  part,
  bytes: n * 28,
  idx: Int32Array.from({ length: n }, (_, i) => i * seed),
  before: Float32Array.from({ length: n * 3 }, (_, i) => i * 0.25 * seed),
  after: Float32Array.from({ length: n * 3 }, (_, i) => i * 0.25 * seed + 1.5),
});

test('a stroke survives the round trip through JSON, exactly', () => {
  // Not "close enough": these are vertex positions, and a stroke that comes back a millimetre out
  // is a model that drifts a little further every time it is reloaded.
  const rec = stroke('teapot', 64, 3);
  const back = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(rec))));
  assert.equal(back.type, rec.type);
  assert.equal(back.part, rec.part);
  assert.deepEqual([...back.idx], [...rec.idx]);
  assert.deepEqual([...back.before], [...rec.before]);
  assert.deepEqual([...back.after], [...rec.after]);
  assert.ok(back.idx instanceof Int32Array && back.after instanceof Float32Array, 'the types come back too');
});

test('the whole-part and multi shapes survive as well', () => {
  const whole = { type: 'stroke', part: 'p', whole: true, bytes: 12,
                  before: Float32Array.from([1, 2, 3]), after: Float32Array.from([4, 5, 6]) };
  const backWhole = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(whole))));
  assert.equal(backWhole.whole, true);
  assert.deepEqual([...backWhole.after], [4, 5, 6]);
  assert.equal(backWhole.idx, undefined, 'a whole-part record has no index array to carry');

  const multi = { type: 'multi', part: 'p', bytes: 99, records: [stroke('p', 4), whole] };
  const back = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(multi))));
  assert.equal(back.records.length, 2);
  assert.deepEqual([...back.records[0].idx], [0, 1, 2, 3]);
});

test('a big stroke encodes without blowing the argument limit', () => {
  // String.fromCharCode.apply over a 4.8 MB array throws; the encoder chunks for exactly this.
  const big = { type: 'stroke', part: 'p', bytes: 1.2e6,
                idx: new Int32Array(100_000), before: new Float32Array(300_000), after: new Float32Array(300_000) };
  big.after[299_999] = 42.5;
  const back = decodeRecord(JSON.parse(JSON.stringify(encodeRecord(big))));
  assert.equal(back.after.length, 300_000);
  assert.equal(back.after[299_999], 42.5);
});

test('the stream keeps the last ten strokes and drops the oldest', async () => {
  const rev = 1;
  for (let i = 0; i < KEEP_EDITS + 5; i++) {
    await addEdit(rev, { part: 'p', type: 'stroke', bytes: 100, payload: encodeRecord(stroke('p', 4, i + 1)) });
  }
  const rows = await listEdits(rev);
  assert.equal(rows.length, KEEP_EDITS, 'ten, not fifteen');
  // oldest first, and the five that fell off are the five that were made first
  const firstIdx = decodeRecord(rows[0].payload).idx[1];
  assert.equal(firstIdx, 6, 'the surviving oldest is the sixth stroke made');
});

test('a stroke too big to store is refused rather than half-sent', async () => {
  // It stays on screen and stays undoable this session; it just will not survive a reload, and the
  // page is told which of the two it got.
  const r = await addEdit(2, { part: 'p', type: 'stroke', bytes: MAX_RECORD_BYTES + 1, payload: { type: 'stroke' } });
  assert.equal(r.ok, false);
  assert.match(r.skipped, /too big/);
  assert.equal((await listEdits(2)).length, 0);
});

test('undo takes the newest off, and only the newest', async () => {
  const rev = 3;
  for (const i of [1, 2, 3]) {
    await addEdit(rev, { part: 'p', type: 'stroke', bytes: 10, payload: encodeRecord(stroke('p', 4, i)) });
  }
  await dropLastEdit(rev);
  const rows = await listEdits(rev);
  assert.equal(rows.length, 2);
  assert.equal(decodeRecord(rows[1].payload).idx[1], 2, 'the one before the newest is now the newest');
});

test('strokes belong to one revision and are not offered for another', async () => {
  // A stroke is vertex indices of a particular mesh. When Blender publishes a new revision the
  // geometry is different and those indices mean something else, so the streams never mix.
  await addEdit(10, { part: 'p', type: 'stroke', bytes: 10, payload: encodeRecord(stroke('p', 4)) });
  assert.equal((await listEdits(10)).length, 1);
  assert.equal((await listEdits(11)).length, 0);
  await clearEdits(10);
  assert.equal((await listEdits(10)).length, 0);
});

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
