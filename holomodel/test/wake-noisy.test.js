import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heardCommand } from '../public/js/commands.js';

// A microphone on a hackathon floor does not hand you a sentence. It hands you everything said near
// it, with the command somewhere in the middle, and nobody pauses for the parser. These are the
// shapes that actually come out of a recogniser in a loud room.

test('the command is found inside a paragraph, not just at the front of one', () => {
  const a = heardCommand('so anyway i was telling him that narvis make a sphere and then we should go get food');
  assert.equal(a.said, 'make a sphere');
  assert.equal(a.cmd.type, 'add');
  assert.equal(a.rest, 'and then we should go get food', 'the rest of the conversation is dropped');

  const b = heardCommand('yeah yeah for sure ok narvis smooth it out you know what i mean');
  assert.deepEqual(b.cmd, { type: 'mode', mode: 'smooth' });
  assert.equal(b.said, 'smooth it out');

  const c = heardCommand('and the thing is right, narvis undo, because that looked terrible');
  assert.deepEqual(c.cmd, { type: 'undo' });
});

test('a long request survives, because the cut is where the subject changed', () => {
  // Not at the first words that parse, or "make a coffee mug with a gold handle" would be acted on
  // as "make a coffee".
  const h = heardCommand('dude narvis make a coffee mug with a gold handle thanks');
  assert.equal(h.cmd.type, 'make');
  assert.equal(h.cmd.prompt, 'a coffee mug with a gold handle');
  assert.equal(h.rest, 'thanks');
});

test('said twice in one breath, the second one wins', () => {
  // People correct themselves out loud; the last thing they asked for is the thing they want.
  const h = heardCommand('he said narvis rotate and then narvis undo');
  assert.deepEqual(h.cmd, { type: 'undo' });
});

test('hearing the name is not enough to act - what follows has to be a command', () => {
  // This is what makes scanning a whole paragraph safe rather than reckless. "nervous" is an
  // ordinary English word and it gets past the name test all day; it never gets past this one.
  const h = heardCommand('i was so nervous about the demo honestly');
  assert.equal(h.woke, true, 'it heard something like its name');
  assert.equal(h.cmd, null, 'and did nothing about it');

  const quiet = heardCommand('this is just people talking about nothing at all');
  assert.equal(quiet.woke, false);
  assert.equal(quiet.cmd, null);
});

test('a bare "and" is not a place to cut: "a cube and a sphere" is one request', () => {
  const h = heardCommand('narvis make a cube and a sphere');
  assert.equal(h.cmd.type, 'make');
  assert.match(h.cmd.prompt, /cube and a sphere/);
});

test('the words it acted on are reported, so a wrong one can be explained', () => {
  // In a room where half of what you say is not for the rig, "why did it do that" has to be
  // answerable by looking at the screen.
  const h = heardCommand('right so narvis bigger brush but actually no wait');
  assert.equal(h.said, 'bigger brush');
  assert.ok(h.rest.startsWith('but'), h.rest);
});
