import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTyped, heardCommand } from '../public/js/commands.js';

// A scene holds several things at once. The grammar has to make the common case - another object,
// alongside what is there - the default, and make emptying the scene something you ask for.

test('a make ADDS: nothing says otherwise, so nothing is thrown away', () => {
  // Asking for a second thing and losing the first is the one outcome nobody means, and it is what
  // "make" did for the whole of this project's life before now.
  for (const said of ['make a teapot', 'build me a wooden chair', 'create a lamp', 'a red sports car']) {
    const cmd = parseTyped(said);
    assert.equal(cmd.type, 'make', said);
    assert.notEqual(cmd.replace, true, `"${said}" should add, not replace`);
  }
});

test('and empties the scene only when the words ask for it', () => {
  const replacing = {
    'make a sphere instead': 'a sphere',
    'make a cube on its own': 'a cube',
    'make a lamp from scratch': 'a lamp',
    'make a teapot by itself': 'a teapot',
    'make a chair instead of this': 'a chair',
  };
  for (const [said, prompt] of Object.entries(replacing)) {
    const cmd = parseTyped(said);
    assert.equal(cmd.replace, true, said);
    // and the word that asked for it does not travel on into the prompt, or Fable is asked to model
    // "a sphere instead"
    assert.equal(cmd.prompt, prompt, said);
  }
});

test('a thing can be deleted by name, not only by pointing at it', () => {
  // Pointing is no use for something behind something else, which is most of a scene with six
  // objects in it.
  assert.deepEqual(parseTyped('delete the teapot'), { type: 'delete', target: 'teapot' });
  assert.deepEqual(parseTyped('get rid of the branch'), { type: 'delete', target: 'branch' });
  assert.deepEqual(parseTyped('remove the second cube'), { type: 'delete', target: 'second cube' });
  assert.deepEqual(heardCommand('narvis delete the red cube').cmd, { type: 'delete', target: 'red cube' });
});

test('"delete that" still means the one you are pointing at', () => {
  assert.deepEqual(parseTyped('delete that'), { type: 'delete' });
  assert.deepEqual(parseTyped('delete'), { type: 'delete' });
});

test('"delete everything" is not a named delete of a thing called everything', () => {
  assert.deepEqual(parseTyped('delete everything'), { type: 'clear' });
  assert.deepEqual(parseTyped('remove all'), { type: 'clear' });
  assert.deepEqual(parseTyped('start over'), { type: 'clear' });
});

test('a name with the shape of a Blender object still parses', () => {
  // People read the name off the screen when the obvious word is ambiguous.
  assert.deepEqual(parseTyped('delete the island_tree_branch_1'),
                   { type: 'delete', target: 'island_tree_branch_1' });
});
