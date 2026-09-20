import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, heardCommand } from '../public/js/commands.js';

// Asking for a tool must never become a modelling request: "give me the rotate tool" used to come back as a 3D
// model of a rotate tool, and "move tool" went to the language model as a change to the scene.
test('a tool asked for in a sentence is a tool, not a thing to build', () => {
  const asks = {
    move: ['move tool', 'the move tool', 'give me the move tool', 'can i have the move tool please', 'use the move tool',
           'select move', 'grab', 'grab tool', 'carry', 'move it', 'i want the grab tool', 'switch to the moving tool', 'pick up'],
    rotate: ['rotate tool', 'give me rotate tool', 'give me the rotation tool', 'rotate mode', 'i want to use the rotate tool',
             'can you give me the rotating tool', 'turn tool', 'spin tool', 'rotate it'],
    zoom: ['zoom tool', 'give me the zoom tool', 'the distance tool'],
    scale: ['scale tool', 'give me the scale tool', 'resize tool', 'the size tool please', 'scaling mode'],
    extrude: ['extrude tool', 'give me the extrude tool', 'sculpt tool', 'the pull tool', 'clay tool'],
    smooth: ['smooth tool', 'give me the smooth tool', 'smoothing mode', 'polish tool'],
  };
  for (const [mode, list] of Object.entries(asks))
    for (const said of list) assert.deepEqual(parseCommand(said), { type: 'mode', mode }, said);
  assert.deepEqual(heardCommand('narvis give me the rotate tool').cmd, { type: 'mode', mode: 'rotate' });
});

test('and things to build, change and do are still what they were', () => {
  assert.equal(parseCommand('make a red sports car').type, 'make');
  assert.equal(parseCommand('make a spinning top').type, 'make');
  assert.equal(parseCommand('make a smooth pebble').type, 'make');
  assert.equal(parseCommand('make a clay pot').type, 'make');
  assert.equal(parseCommand('make the lid gold').type, 'change');
  assert.equal(parseCommand('move the handle to the left').type, 'change');
  assert.deepEqual(parseCommand('turn'), { type: 'spin', on: true });
  assert.deepEqual(parseCommand('delete the handle'), { type: 'delete', target: 'handle' });
  assert.equal(parseCommand('add detail').type, 'detail');
});
