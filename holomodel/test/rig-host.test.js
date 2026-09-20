// SPDX-License-Identifier: GPL-3.0-or-later
// The hand as Holomodel reads it on the rig (input/bridge.js writeHand), and the stage it stands on.
import test from 'node:test';
import assert from 'node:assert/strict';

import { input } from '../public/js/input/state.js';
import { STAGE, WORLD_FROM_RIG, worldFromRig, stageFromSetup, makeHandWriter, writeHand } from '../public/js/input/bridge.js';

// 21 points of a hand in rig cm, thumb and index tips `gapCm` apart
const hand = (gapCm, at = [0, -7, 12]) => Array.from({ length: 21 }, (_, i) => {
  if (i === 4) return [at[0] - gapCm / 2, at[1], at[2]];
  if (i === 8) return [at[0] + gapCm / 2, at[1], at[2]];
  return [at[0] + (i % 5) - 2, at[1] - 1 - Math.floor(i / 5), at[2] + 3];
});
const pinched = { grab: 0.15 }, open = { grab: 0.95 };

// what interaction.js makes of input.hands[0], frame by frame: a gesture starts on the pinch's rising edge and
// ends on !active || !pinch (updateInteraction)
function follow() {
  let was = false, holding = false;
  const log = [];
  return { log, step(t) {
    const h = input.hands[0], onset = h.pinch && !was;
    was = h.pinch;
    if (holding && (!h.active || !h.pinch)) { holding = false; log.push(`end@${t}`); }
    if (!holding && h.active && onset) { holding = true; log.push(`start@${t}`); }
  }, get holding() { return holding; } };
}

test('a hand lost mid-carry and found again still closed is still carrying', () => {
  const w = makeHandWriter(), f = follow();
  let t = 0;
  for (; t < 300; t += 20) { writeHand(w, hand(1), pinched, t); f.step(t); }
  assert.ok(f.holding, 'the pinch took hold');
  for (; t < 600; t += 20) { writeHand(w, null, null, t); f.step(t); }        // 300 ms with no hand: inside the coast
  assert.ok(f.holding, 'the coast is a hand to the gesture, not only a pinch');
  assert.equal(input.hands[0].active, true);
  for (; t < 900; t += 20) { writeHand(w, hand(1), pinched, t); f.step(t); }
  assert.deepEqual(f.log, ['start@40'], 'one gesture (the pinch has to hold 40 ms to count), never dropped');
});

test('a hand that stays lost lets go, and the next pinch takes hold again', () => {
  const w = makeHandWriter(), f = follow();
  let t = 0;
  for (; t < 300; t += 20) { writeHand(w, hand(1), pinched, t); f.step(t); }
  for (; t < 1300; t += 20) { writeHand(w, null, null, t); f.step(t); }       // a second: past the coast
  assert.ok(!f.holding);
  assert.equal(input.hands[0].active, false);
  assert.equal(input.hands[0].pinch, false);
  for (; t < 1600; t += 20) { writeHand(w, hand(1), pinched, t); f.step(t); }
  assert.ok(f.holding, 'a returning pinch is a fresh onset');
  assert.equal(f.log.length, 3);
  for (; t < 2000; t += 20) { writeHand(w, hand(8), open, t); f.step(t); }
  assert.ok(!f.holding);
});

test('the grip settles in real time, whatever the frame rate', () => {
  const settle = stepMs => {
    const w = makeHandWriter();
    writeHand(w, hand(6, [0, -7, 12]), open, 0);
    // the fingers jump 4 cm relative to the palm; how far has the grip followed 100 ms later?
    const moved = hand(6, [0, -7, 12]);
    moved[4][1] += 4; moved[8][1] += 4;
    const y0 = input.hands[0].grip.y;
    for (let t = stepMs; t <= 100; t += stepMs) writeHand(w, moved, open, t);
    return input.hands[0].grip.y - y0;
  };
  const at60 = settle(1000 / 60), at25 = settle(40);
  assert.ok(Math.abs(at60 - at25) < 0.15 * at60, `60 fps ${at60.toFixed(2)} cm vs 25 fps ${at25.toFixed(2)} cm`);
});

test('the stage stands on the mat the setup measured', () => {
  const before = { H: STAGE.H, y: STAGE.origin[1] };
  try {
    assert.deepEqual([STAGE.W, STAGE.H, STAGE.origin[1]], [24, 13.5, -6.75]);
    stageFromSetup({ rig: { baseDropCm: 12.2 } });
    assert.equal(STAGE.H, 12.2);
    const floorWorldY = -STAGE.H / 2;                                   // view.js: rect.y0
    assert.ok(Math.abs(worldFromRig([0, -12.2, 10])[1] - floorWorldY) < 1e-9, 'the mat is the floor');
    assert.ok(Math.abs(worldFromRig([0, 0, 10])[1] - STAGE.H / 2) < 1e-9, 'the sheet is the ceiling');
    assert.equal(WORLD_FROM_RIG[13], -STAGE.origin[1], 'the camera is moved by the same amount as the hand');
    stageFromSetup({ rig: { baseDropCm: 'nonsense' } });
    assert.equal(STAGE.H, 12.2, 'a bad number changes nothing');
  } finally {
    stageFromSetup({ rig: { baseDropCm: before.H } });
    assert.equal(STAGE.origin[1], before.y);
  }
});
