import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseTyped, FINISHES } from '../public/js/commands.js';

const cases = [
  ['Make a coffee mug.', { type: 'make', prompt: 'a coffee mug' }],
  ['hey can you build me a wooden chair', { type: 'make', prompt: 'a wooden chair' }],
  ['Create a 1.5 metre tall lamp', { type: 'make', prompt: 'a 1.5 metre tall lamp' }],
  ['make the handle bigger', { type: 'change', prompt: 'make the handle bigger' }],
  ['make it red', { type: 'color', color: '#d93a3a', prompt: 'make it red' }],   // goes to Fable, naming the pointed-at part; "quick red" is the instant one
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
  // Blender words: modes, brushes, redo, focus
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
  ['make the silver surfer', { type: 'change', prompt: 'make the silver surfer' }],   // -er word that isn't listed: goes to change (Fable decides new vs edit anyway)
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

test('parts on screen: focus, hide, isolate, show all', () => {
  const said = {
    'focus on that': { type: 'focus' },
    'zoom in on this part': { type: 'focus' },
    'focus on the lid': { type: 'focus', target: 'lid' },
    'zoom in on the spout': { type: 'focus', target: 'spout' },
    'zoom out': { type: 'unfocus' },
    'show the whole model': { type: 'unfocus' },
    'hide that': { type: 'hide' },
    'hide': { type: 'hide' },
    'hide the lid': { type: 'hide', target: 'lid' },
    'isolate that': { type: 'isolate' },
    'show only the spout': { type: 'isolate', target: 'spout' },
    'solo this one': { type: 'isolate' },
    'show all': { type: 'show_all' },
    'show everything': { type: 'show_all' },
    'unhide all': { type: 'show_all' },
  };
  for (const [s, expected] of Object.entries(said)) assert.deepEqual(parseCommand(s), expected, s);
  // unchanged neighbours
  assert.deepEqual(parseCommand('frame it'), { type: 'focus' });
  assert.deepEqual(parseCommand('show versions'), { type: 'versions' });
});

test('clay view, and "quick <colour>" for an instant local recolour', () => {
  const said = {
    'clay view': { type: 'clay', on: true },
    'turn on clay view': { type: 'clay', on: true },
    'switch to clay view': { type: 'clay', on: true },
    'clay view off': { type: 'clay', on: false },
    'turn off the clay view': { type: 'clay', on: false },
    'normal view': { type: 'clay', on: false },
    'show the materials': { type: 'clay', on: false },
    'quick red': { type: 'quick_color', color: '#d93a3a', name: 'red' },
    'Quick dark blue.': { type: 'quick_color', color: '#234382', name: 'dark blue' },
    'quick make that gold': { type: 'quick_color', color: '#d4af37', name: 'gold' },
    'quick metal': { type: 'quick_finish', finish: FINISHES.metal, name: 'metal' },
    'quick shiny': { type: 'quick_finish', finish: FINISHES.shiny, name: 'shiny' },
    'quick make that part matte': { type: 'quick_finish', finish: FINISHES.matte, name: 'matte' },
    // "quick" means instant and free, so an unknown word must not fall through to a paid Fable build
    'quick banana': { type: 'quick_unknown', word: 'banana' },
  };
  for (const [s, expected] of Object.entries(said)) assert.deepEqual(parseCommand(s), expected, s);
  // "clay" on its own is still the sculpt tool, "clay brush" still picks the brush, and plain colour talk goes to Fable
  assert.deepEqual(parseCommand('clay'), { type: 'mode', mode: 'sculpt' });
  assert.deepEqual(parseCommand('clay brush'), { type: 'brush_pick', name: 'Clay' });
  assert.deepEqual(parseTyped('quick banana'), { type: 'quick_unknown', word: 'banana' }, 'never a build');
});

test('version history commands', () => {
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
