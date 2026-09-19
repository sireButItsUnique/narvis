import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseTyped } from '../public/js/commands.js';

const cases = [
  ['Make a coffee mug.', { type: 'make', prompt: 'a coffee mug' }],
  ['hey can you build me a wooden chair', { type: 'make', prompt: 'a wooden chair' }],
  ['Create a 1.5 metre tall lamp', { type: 'make', prompt: 'a 1.5 metre tall lamp' }],
  ['make the handle bigger', { type: 'change', prompt: 'make the handle bigger' }],
  ['make it red', { type: 'color', color: '#d93a3a', prompt: 'make it red' }],   // recolours the pointed-at part, else goes to the AI
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
  // v2: tools, brush, mirror, pointing at parts, turning
  ['sculpt', { type: 'mode', mode: 'sculpt' }],
  ['clay mode', { type: 'mode', mode: 'sculpt' }],
  ['smooth it out', { type: 'mode', mode: 'smooth' }],
  ['part mode', { type: 'mode', mode: 'part' }],
  ['stop sculpting', { type: 'mode', mode: 'move' }],
  ['done', { type: 'mode', mode: 'move' }],
  ['mirror on', { type: 'mirror', on: true }],
  ['turn off symmetry', { type: 'mirror', on: false }],
  ['bigger brush', { type: 'brush', factor: 1.35 }],
  ['make the brush smaller', { type: 'brush', factor: 1 / 1.35 }],
  ['make that red', { type: 'color', color: '#d93a3a', prompt: 'make that red' }],
  ['paint this part blue', { type: 'color', color: '#3a6fd9', prompt: 'paint this part blue' }],
  ['make it dark red', { type: 'color', color: '#822323', prompt: 'make it dark red' }],
  ['make it taller', { type: 'change', prompt: 'make it taller' }],
  ['paint the handle red', { type: 'change', prompt: 'paint the handle red' }],
  ['duplicate that', { type: 'duplicate' }],
  ['copy this one', { type: 'duplicate' }],
  ['duplicate the legs', { type: 'change', prompt: 'duplicate the legs' }],
  ['delete that one', { type: 'delete' }],
  ['turn it around', { type: 'turn', deg: 180 }],
  ['rotate left', { type: 'turn', deg: -45 }],
  ['turn to the right', { type: 'turn', deg: 45 }],
  // phrasings the review caught going to the AI by mistake
  ['mirror mode off', { type: 'mirror', on: false }],
  ['turn the mirror off', { type: 'mirror', on: false }],
  ['mirror mode', { type: 'mirror', on: true }],
  ['switch to sculpt mode', { type: 'mode', mode: 'sculpt' }],
  ['go back to move mode', { type: 'mode', mode: 'move' }],
  ['change to part mode', { type: 'mode', mode: 'part' }],
  ['make the brush a bit bigger', { type: 'brush', factor: 1.15 }],
  ['brush size smaller', { type: 'brush', factor: 1 / 1.35 }],
  ['turn it', { type: 'spin', on: true }],
  ['change the colour to blue', { type: 'change', prompt: 'change the colour to blue' }],
  // Blender mode
  ['edit mode', { type: 'mode', mode: 'edit' }],
  ['object mode', { type: 'mode', mode: 'move' }],
  ['clay strips brush', { type: 'brush_pick', name: 'Clay Strips' }],
  ['use the grab brush', { type: 'brush_pick', name: 'Grab' }],
  ['switch to inflate brush', { type: 'brush_pick', name: 'Inflate/Deflate' }],
  ['bigger brush', { type: 'brush', factor: 1.35 }],   // size, not a brush called "bigger"
  ['redo', { type: 'redo' }],
  ['frame it', { type: 'focus' }],
  ['make the mona lisa', { type: 'make', prompt: 'the mona lisa' }],
  ['make the eiffel tower', { type: 'make', prompt: 'the eiffel tower' }],
  ['make the legs longer', { type: 'change', prompt: 'make the legs longer' }],
  ['make the handle red', { type: 'change', prompt: 'make the handle red' }],
  ['make the roof more pointy', { type: 'change', prompt: 'make the roof more pointy' }],
  ['make the legs thicker', { type: 'change', prompt: 'make the legs thicker' }],
  ['make the blade sharper', { type: 'change', prompt: 'make the blade sharper' }],
  ['make the head pointy', { type: 'change', prompt: 'make the head pointy' }],
  ['make the monster', { type: 'make', prompt: 'the monster' }],
  ['make the leaning tower', { type: 'make', prompt: 'the leaning tower' }],
  ['make the silver surfer', { type: 'change', prompt: 'make the silver surfer' }],   // -er word that isn't listed: goes to change (Blender mode lets Fable decide anyway)
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

test('version history commands (Blender mode)', () => {
  const said = {
    'save version': { type: 'save_version', label: '' },
    'save a version called gold frame': { type: 'save_version', label: 'gold frame' },
    'checkpoint': { type: 'save_version', label: '' },
    'go back to version 3': { type: 'restore_version', which: '3' },
    'Go back to version three.': { type: 'restore_version', which: '3' },
    'restore version to': { type: 'restore_version', which: '2' },   // a misheard "two"
    'load version number twenty one': { type: 'restore_version', which: '21' },
    'go back a version': { type: 'restore_version', which: 'previous' },
    'go back to the previous version': { type: 'restore_version', which: 'previous' },
    'go to the latest version': { type: 'restore_version', which: 'latest' },
    'show versions': { type: 'versions' },
    'version history': { type: 'versions' },
  };
  for (const [s, expected] of Object.entries(said)) assert.deepEqual(parseCommand(s), expected, s);
  // the older meanings of the same words still work
  assert.deepEqual(parseCommand('go back'), { type: 'undo' });
  assert.deepEqual(parseCommand('save it'), { type: 'export' });
  assert.deepEqual(parseCommand('go back to sculpt mode'), { type: 'mode', mode: 'sculpt' });
});
