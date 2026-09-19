import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseTyped } from '../public/js/commands.js';

const cases = [
  ['Make a coffee mug.', { type: 'make', prompt: 'a coffee mug' }],
  ['hey can you build me a wooden chair', { type: 'make', prompt: 'a wooden chair' }],
  ['Create a 1.5 metre tall lamp', { type: 'make', prompt: 'a 1.5 metre tall lamp' }],
  ['make the handle bigger', { type: 'change', prompt: 'make the handle bigger' }],
  ['make it red', { type: 'change', prompt: 'make it red' }],
  ['add wheels', { type: 'change', prompt: 'add wheels' }],
  ['remove the handle', { type: 'change', prompt: 'remove the handle' }],
  ['turn it into a boat', { type: 'change', prompt: 'turn it into a boat' }],
  ['add a cube', { type: 'add', shape: 'box', word: 'cube', fresh: false }],
  ['add another sphere', { type: 'add', shape: 'sphere', word: 'sphere', fresh: false }],
  ['make a donut', { type: 'add', shape: 'torus', word: 'donut', fresh: true }],
  ['make it bigger', { type: 'scale', factor: 1.25 }],
  ['Bigger!', { type: 'scale', factor: 1.25 }],
  ['make it a little smaller', { type: 'scale', factor: 1 / 1.1 }],
  ['a lot bigger', { type: 'scale', factor: 1.6 }],
  ['undo', { type: 'undo' }],
  ['Oops.', { type: 'undo' }],
  ['delete that', { type: 'delete' }],
  ['delete everything', { type: 'clear' }],
  ['start over', { type: 'clear' }],
  ['export it to blender', { type: 'export' }],
  ['save', { type: 'export' }],
  ['stop', { type: 'spin', on: false }],
  ['spin it', { type: 'spin', on: true }],
  ['stop listening', { type: 'mic', on: false }],
  ['never mind', { type: 'cancel' }],
];

for (const [said, expected] of cases) {
  test(`"${said}"`, () => assert.deepEqual(parseCommand(said), expected));
}

test('ordinary talk is ignored', () => {
  for (const s of ['what time is it', 'I think this looks cool', '', 'the', 'okay']) assert.equal(parseCommand(s), null, s);
});

test('typed text that is not a command becomes a make request', () => {
  assert.deepEqual(parseTyped('red sports car'), { type: 'make', prompt: 'red sports car' });
  assert.deepEqual(parseTyped('undo'), { type: 'undo' });
  assert.equal(parseTyped('   '), null);
});
