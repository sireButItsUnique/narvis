import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quip, quipFor, KINDS } from '../public/js/narvis.js';

// The voice has a personality; the screen has the facts. These check the rules that keep the
// personality from becoming a liability at a table you are standing at for two days.

test('every kind has something to say, and says it briefly', () => {
  for (const kind of KINDS) {
    const line = quip(kind, () => 0);
    assert.ok(line, kind);
    // Eight words is a joke; twenty is a monologue you have to wait out, and the mic is muted
    // while it talks, so a long line costs you the next command.
    assert.ok(line.split(/\s+/).length <= 12, `${kind}: "${line}" is too long to wait through`);
  }
});

test('it never says the same thing twice running', () => {
  // The fourth cube must not be the second cube. With a generator that always picks slot 0, the
  // no-repeat rule is the only thing that can move it.
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(quip('make', () => 0));
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], seen.join(' | '));
});

test('a failure is the one moment it is sincere', () => {
  // Somebody is standing in front of a broken demo. Every line here points at the screen instead
  // of making a joke about it.
  for (let i = 0; i < 6; i++) {
    const line = quip('failed', Math.random);
    assert.match(line, /screen/i, line);
  }
});

test('a command it ran gets a line; one it did not, does not', () => {
  assert.ok(quipFor({ type: 'make', prompt: 'a cube' }, () => 0));
  assert.ok(quipFor({ type: 'undo' }, () => 0));
  assert.ok(quipFor({ type: 'mode', mode: 'smooth' }, () => 0));
  // types with nothing written for them stay quiet rather than saying something wrong
  assert.equal(quipFor({ type: 'mic', on: false }, () => 0), '');
  assert.equal(quipFor(null, () => 0), '');
});

test('the lines are about the work and itself, never about the person', () => {
  // A demo table is full of strangers. "You" as an insult is the one thing that does not survive
  // being said to somebody's manager, so it is checked rather than remembered.
  const bad = /\byou (?:are|'re|re) (?:an? )?(?:idiot|stupid|dumb|useless|hopeless|terrible|bad)\b/i;
  for (const kind of KINDS) {
    for (let i = 0; i < 12; i++) assert.doesNotMatch(quip(kind, Math.random), bad, kind);
  }
});
