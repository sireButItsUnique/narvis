// SPDX-License-Identifier: GPL-3.0-or-later
// What Narvis says out loud.
//
// The screen already says what happened, accurately, and nobody wants that read back to them in a
// robot voice - "restored version four" is information, not conversation. So the SPOKEN line is not
// the status line. It is a butler who has been awake for eleven hours and is doing you a favour.
//
// Rules that keep it funny instead of tiring, at a table you will be standing at for two days:
//   - short. Eight words is a joke; twenty is a monologue you have to wait out before the next
//     command, and the mic is muted while it talks.
//   - never the same line twice in a row, so the fourth cube is not the second cube.
//   - never sarcastic about a FAILURE. When a build breaks, the person in front of it is already
//     embarrassed; that is the one moment the butler is sincere.
//   - it makes fun of the work and of itself, never of the person asking.

const LINES = {
  // "Narvis, make me a cube"
  make: [
    'Did you really need to wake me up for this?',
    'A cube. Bold. Nobody has ever asked for that.',
    'One moment. Summoning the full power of a laptop.',
    'Fine. But this is the last one. It is never the last one.',
    'Building. Please admire my restraint.',
    'I trained for this. Well. Something trained for this.',
  ],
  change: [
    'So the first one was wrong. Noted.',
    'Revising. As is tradition.',
    'Sure. Let us ruin a perfectly good model.',
    'Changing it. Again. Not that I am counting.',
  ],
  // the tools
  mode: [
    'Tool switched. Try not to hurt yourself.',
    'Right. New tool, same hands.',
    'Switched. I believe in you, conditionally.',
  ],
  brush: ['Brush resized. Artistry.', 'There. A different size of the same decision.'],
  scale: ['Resizing. The model has opinions about this.', 'Bigger. Or smaller. I have stopped tracking.'],
  zoom: ['Closer. Do not touch the glass.', 'Zooming. The hologram is flattered.'],
  // undo and regret
  undo: [
    'Ah. Regret.',
    'Undoing. We shall never speak of it.',
    'Back it goes. Nobody saw anything.',
  ],
  redo: ['So it was good after all.', 'Redoing. Make up your mind.'],
  // versions
  save_version: ['Saved. Posterity is thrilled.', 'Checkpointed, in case of you.'],
  restore_version: ['Going back. Wise.', 'Restored. That one was better anyway.'],
  // the model is finished
  done: [
    'There. A masterpiece. Probably.',
    'Done. I would like it noted that I did that.',
    'Finished. You may gasp.',
    'It exists. You are welcome.',
  ],
  // it went wrong: no jokes here, on purpose
  failed: [
    'That did not work. The reason is on screen.',
    'It broke. Have a look at the screen and we will try again.',
  ],
  // heard its own name and nothing useful after it
  nothing: [
    'You said my name and then nothing. Cruel.',
    'I am awake now. Was there a plan?',
    'Yes? ... No? Fine.',
  ],
  // heard its name and then something it cannot do
  unknown: [
    'I have no idea what that was.',
    'That is not one of my four tricks.',
    'Say that again, but as a command.',
  ],
  detail: ['Adding detail. This is the expensive part.', 'More triangles. Your laptop says hello.'],
  delete: ['Gone. It was not my favourite either.', 'Removed. The scene is lighter already.', 'Deleted. No notes.'],
  export: ['Exported. Do not lose it.', 'Saved to disk, where things go to be forgotten.'],
};

const lastPicked = new Map();

/**
 * One line for this kind of event, never the same one twice running.
 * @param {string} kind a key of LINES
 * @param {() => number} [rand] injectable for the tests
 * @returns {string} the line, or '' when this kind has nothing to say
 */
export function quip(kind, rand = Math.random) {
  const lines = LINES[kind];
  if (!lines || !lines.length) return '';
  if (lines.length === 1) return lines[0];
  const last = lastPicked.get(kind);
  let pick = Math.floor(rand() * lines.length) % lines.length;
  if (lines[pick] === last) pick = (pick + 1) % lines.length;
  lastPicked.set(kind, lines[pick]);
  return lines[pick];
}

/** Which quip a command deserves. Unknown commands say nothing rather than something wrong. */
export function quipFor(cmd, rand = Math.random) {
  if (!cmd) return '';
  const byType = {
    make: 'make', change: 'change', color: 'change', mode: 'mode', brush_pick: 'mode',
    brush: 'brush', scale: 'scale', mirror: 'mode', undo: 'undo', redo: 'redo',
    save_version: 'save_version', restore_version: 'restore_version', detail: 'detail',
    export: 'export', delete: 'delete',
  };
  return byType[cmd.type] ? quip(byType[cmd.type], rand) : '';
}

export const KINDS = Object.keys(LINES);
export default { quip, quipFor, KINDS };
