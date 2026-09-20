// What you said (or typed) -> a command object. Pure: no DOM, no three.js, so `node --test` can check it.
//
// Speech that doesn't start like a command returns null and is ignored, so talking near the mic is harmless.

// spoken word -> primitive shape
export const PRIMITIVES = {
  cube: 'box', box: 'box', block: 'box',
  sphere: 'sphere', ball: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  torus: 'torus', donut: 'torus', doughnut: 'torus', ring: 'torus',
  capsule: 'capsule', pill: 'capsule',
};

// colour words for "make that red" and "quick red"
export const COLORS = {
  red: '#d93a3a', orange: '#f28c28', yellow: '#f2d02e', green: '#3fae4a', blue: '#3a6fd9', purple: '#8a4fd1',
  pink: '#f07ab0', white: '#f2f2f2', black: '#1c1c1c', gray: '#8c8c8c', grey: '#8c8c8c', brown: '#8b5a2b',
  gold: '#d4af37', silver: '#c0c0c0', cyan: '#35d0ff', teal: '#1f9e9a', navy: '#1f2f6b', beige: '#e3d5b8',
  maroon: '#7a1f2b', lime: '#9be34a', magenta: '#d63ad0', tan: '#c9a77c', cream: '#f4eedd', wood: '#a0703c', wooden: '#a0703c',
};

// finish words for "quick metal": what they set on the part's own material clones (three MeshStandardMaterial)
export const FINISHES = {
  metal: { metalness: 1, roughness: 0.25 }, metallic: { metalness: 1, roughness: 0.25 },
  chrome: { metalness: 1, roughness: 0.03 }, mirror: { metalness: 1, roughness: 0.02 },
  shiny: { roughness: 0.05 }, glossy: { roughness: 0.05 }, polished: { roughness: 0.05 },
  matte: { metalness: 0, roughness: 0.9 }, flat: { metalness: 0, roughness: 0.9 },
  rough: { roughness: 1 }, dull: { metalness: 0, roughness: 0.95 },
  glass: { metalness: 0, roughness: 0.02, opacity: 0.3, transparent: true },
  plastic: { metalness: 0, roughness: 0.45 },
};

// "dark red", "light blue", "bright green"
function colorFor(words) {
  const [shade, base] = words.includes(' ') ? words.split(' ') : ['', words];
  const hex = COLORS[base];
  if (!hex) return null;
  if (!shade || shade === 'bright') return hex;
  const mix = shade === 'dark' ? 0 : 255, amount = 0.4;
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + mix * amount)
    .toString(16).padStart(2, '0')).join('');
}

// The four tool modes: what a pinch does. Four, because a hand has one gesture and a person at a
// demo table can hold four ideas - move it, turn it, add clay, smooth it - and because the two that
// were dropped (per-part moves, Blender's edit mode) were both "the same pinch, on a smaller thing".
const MODES = [
  [/^(?:extrude|extruding|extrude mode|sculpt|sculpting|sculpt mode|clay|clay mode|start sculpting|add clay|build(?: it)? up)$/, 'extrude'],
  [/^(?:smooth|smoothing|smooth mode|smooth it(?: out)?|polish|melt)$/, 'smooth'],
  [/^(?:rotate|rotating|rotate mode|turn mode|spin mode|turntable)$/, 'rotate'],
  // "zoom" and "scale" name TOOLS now, because they are separate tools. "zoom in on the handle" is
  // still framing a part (below) - that is a different request, and it keeps the word that has
  // meant it since before there was a zoom tool.
  [/^(?:zoom|zooming|zoom mode|closer|distance|distance mode|dolly)$/, 'zoom'],
  [/^(?:scale|scaling|scale mode|size|size mode|resize|resize mode)$/, 'scale'],
  [/^(?:move|move mode|grab mode|normal mode|object mode|done|done sculpting|stop sculpting|stop smoothing|exit (?:extrude|sculpt|smooth|rotate|zoom|scale)(?: mode)?)$/, 'move'],
];

// Asking for a TOOL, however it is put. The patterns above want the tool's name and little else, and anything
// they missed fell through to "make": "give me the rotate tool" came back as a 3D model of a rotate tool, and
// "move tool" went to Fable as a change. Two rules, both narrow enough not to eat a modelling request:
//   - the words "tool" or "mode" next to a tool's name ARE a tool request, whatever else is in the sentence;
//   - a tool's name on its own, once the asking ("give me", "can I have", "switch to", "please") is taken off.
const TOOL_NAMES = [
  ['move', /\b(?:move|moving|movement|grab|grabbing|carry|carrying|drag|dragging|pick ?up|hand)\b/],
  ['rotate', /\b(?:rotate|rotating|rotation|turn|turning|spin|spinning|twist)\b/],
  ['zoom', /\b(?:zoom|zooming|distance|dolly|closer)\b/],
  ['scale', /\b(?:scale|scaling|resize|resizing|size|sizing)\b/],
  ['extrude', /\b(?:extrude|extruding|extrusion|sculpt|sculpting|clay|pull|pulling)\b/],
  ['smooth', /\b(?:smooth|smoothing|polish|polishing|melt)\b/],
];
const ASKING = /^(?:(?:please|ok|okay|now|hey|um|uh) )*(?:(?:can|could|may) (?:i|you|we) (?:please )?(?:have|get|use|give me|switch to|go to) |(?:i|we) (?:want|need|would like)(?: to (?:use|have|get|switch to))? |(?:give|get|hand|pass) me |let me (?:use|have) |(?:switch|change|go|swap)(?: back)? (?:to|into|over to) |(?:use|enter|select|pick|choose|activate|enable|open|set|start|bring up|put it (?:in|on|into)) )?(?:the |a |an |my )?/;
export function toolRequest(t) {
  const hasToolWord = /\b(?:tool|tools|mode)\b/.test(t);
  const bare = t.replace(ASKING, '').replace(/ (?:tool|tools|mode)\b/g, '').replace(/ (?:please|now|again|it|thanks|thank you)$/g, '').trim();
  const whole = (text, re) => { const m = text.match(re); return !!m && m[0].length === text.length; };
  const plain = t.replace(/ (?:please|now|again|thanks|thank you)$/g, '').trim();     // "pick up": the asking-words must not eat it
  for (const [mode, re] of TOOL_NAMES) {
    if (hasToolWord && re.test(t)) return mode;
    if (whole(bare, re) || whole(plain, re)) return mode;
  }
  return null;
}

// Blender sculpt brushes by what people call them -> the brush's name in Blender's built-in library
export const BRUSHES = {
  draw: 'Draw', 'draw sharp': 'Draw Sharp', clay: 'Clay', 'clay strips': 'Clay Strips', 'clay thumb': 'Clay Thumb',
  smooth: 'Smooth', grab: 'Grab', 'elastic grab': 'Elastic Grab', 'snake hook': 'Snake Hook', inflate: 'Inflate/Deflate',
  deflate: 'Inflate/Deflate', crease: 'Crease Sharp', flatten: 'Flatten/Contrast', scrape: 'Scrape/Fill', fill: 'Fill/Deepen',
  pinch: 'Pinch/Magnify', layer: 'Layer', mask: 'Mask', blob: 'Blob', pose: 'Pose', thumb: 'Thumb', nudge: 'Nudge',
  pull: 'Pull', twist: 'Twist', boundary: 'Boundary', plateau: 'Plateau', trim: 'Trim',
  // What people actually ask for. Blender has no "extrude" in sculpt mode - the brush that pulls
  // material out of a surface and drags it along with your hand is Snake Hook - so the word people
  // bring with them from box modelling lands on the brush that does what they mean.
  extrude: 'Snake Hook', 'pull out': 'Snake Hook', stretch: 'Snake Hook', spike: 'Snake Hook',
  hook: 'Snake Hook', 'snake': 'Snake Hook',
  'push in': 'Draw', dent: 'Draw', bump: 'Draw', add: 'Clay Strips', build: 'Clay Strips',
  polish: 'Smooth', melt: 'Smooth', round: 'Smooth', blend: 'Smooth', soften: 'Smooth',
};

const FILLER = /^(?:(?:hey|ok|okay|so|um+|uh+|and|now|then|please|can you|could you|would you|will you|let's|lets|go ahead and|i want you to)\s+)+/;
// "make it/this ..." edits the current model instead of making a new one
const REFERS = /^(?:it|its|it's|this|that|these|those|them|everything|all)\b/;
// "make the handle bigger" is a change but "make the Mona Lisa" is a new thing: "the ..." counts as a change
// only when it ends in how to change it
// nouns that end like comparatives, so "make the eiffel tower" stays a new thing
const ER_NOUNS = 'tower|flower|computer|poster|burger|sticker|speaker|container|printer|heater|blender|hammer|ladder|player|'
  + 'spider|monster|anchor|cooler|mixer|toaster|charger|controller|river|silver|number|paper|letter|feather|finger|dinner|'
  + 'corner|tiger|lobster|water|soldier|sweater|sneaker|trailer|tractor|butter|border|cylinder|sphere|master|rover|slider';
const CHANGE_TAIL = new RegExp(`\\b(?:(?!(?:${ER_NOUNS})$)[a-z]{2,}(?:er|ier)|more \\w+|less \\w+|`
  + `round|square|flat|curved|straight|shiny|matte|smooth|rough|glossy|transparent|metallic|golden|thick|thin|long|short|`
  + `tall|wide|narrow|big|small|large|tiny|huge|sharp|soft|pointed|pointy|hollow|heavy|bumpy|wavy|curvy|twisted|bent|`
  + `rounded|spiky|fluffy|furry|symmetrical|visible|invisible|bald|open|closed|upright|sideways|`
  + `into .+|look .+|(?:dark |light |bright )?(?:${Object.keys(COLORS).join('|')}))$`);
const THAT_WORDS = 'it|this|that|this part|that part|this one|that one';
// The words that mean "and get rid of what is there", as people actually say them. Without one of
// these a "make" adds to the scene, because asking for a second thing and losing the first is the
// one outcome nobody means.
const REPLACE_WORDS = /\s*\b(?:instead(?: of (?:this|that|it|the \w+))?|on its own|by itself|from scratch|starting over|and clear the (?:rest|scene)|replacing (?:this|that|it|everything))\b\s*/;
const THAT = `(?:${THAT_WORDS})`;

// "version three", "version 3", "version to" (a misheard two), "version twenty one"
const ONES = { one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8,
               nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
               seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DIGIT_WORDS = Object.keys(ONES).filter(w => ONES[w] < 10).join('|');
const NUMBER = `(\\d{1,4}|(?:${Object.keys(TENS).join('|')})(?:[ -](?:${DIGIT_WORDS}))?|${Object.keys(ONES).join('|')})`;
export function numberFrom(words) {
  if (/^\d+$/.test(words)) return Number(words);
  const [a, b] = words.split(/[ -]/);
  if (TENS[a]) return TENS[a] + (b ? ONES[b] || 0 : 0);
  return ONES[a] ?? null;
}

// version history: these come before "go back" (undo) and "save" (export)
function parseVersion(t) {
  let m;
  if ((m = t.match(new RegExp(`^(?:go back|revert|restore|return|roll back|switch|jump|load|open|bring back)(?: to)? (?:the )?version (?:number )?${NUMBER}$`)))) {
    return { type: 'restore_version', which: String(numberFrom(m[1])) };
  }
  if (/^(?:go back (?:a|one) version|(?:(?:go back|revert|return|roll back|switch) to |restore |load |bring back )?(?:the )?(?:previous|last|earlier|old) version|undo (?:the )?(?:last )?build)$/.test(t)) {
    return { type: 'restore_version', which: 'previous' };
  }
  if (/^(?:(?:go|switch|jump|return) (?:back )?to |restore |load )(?:the )?(?:latest|newest|most recent) version$/.test(t)) {
    return { type: 'restore_version', which: 'latest' };
  }
  if ((m = t.match(/^(?:save|keep|make|take|add)(?: a| this| the)?(?: new)? (?:version|checkpoint|snapshot)(?: (?:as|called|named) (.+))?$|^(?:checkpoint|snapshot)(?: (?:it|this|that))?$/))) {
    return { type: 'save_version', label: m[1] || '' };
  }
  if (/^(?:(?:show|list|open)(?: me)?(?: the| all(?: the)?| my)? versions|(?:the )?version history|what versions (?:are there|do i have|have i got))$/.test(t)) {
    return { type: 'versions' };
  }
  return null;
}

export function normalize(text) {
  return String(text ?? '').toLowerCase()
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')        // drop full stops, keep decimals like 1.5
    .replace(/[“”"!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(FILLER, '')
    .replace(/\s+please$/, '')
    .trim();
}

// ---------- the wake word ----------
//
// The microphone is always on, and a demo table is a room full of people saying "make it bigger"
// about something else. So the voice path only acts when it hears the rig's name first.
//
// A recogniser does not hear a made-up name reliably: "narvis" comes back as nervous, jarvis,
// marvis, novis, or split into "nar vis". So the test is a sound-alike one - an edit distance of
// two against the name, on the first word and on the first two words run together - plus the short
// list of mishears that are further away than that and still unmistakably it. Two is deliberate:
// three would reach ordinary English ("marbles", "service") and the command behind it would run.
export const WAKE = 'narvis';
const WAKE_ALIASES = new Set([
  'nervous', 'nervus', 'jarvis', 'marvis', 'harvis', 'carvis', 'novis', 'norvis', 'gnarvis',
  'narvelous', 'nahvis', 'knarvis', 'narviss', 'nervice',
]);

function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n];
}

const soundsLikeWake = (word) => !!word
  && (word === WAKE || WAKE_ALIASES.has(word) || editDistance(word, WAKE) <= 2);

const bare = (w) => String(w || '').replace(/[^a-z]/g, '');

/**
 * Every place the name is heard in a run of words, with how many words it took to say it.
 * Recognisers split an unfamiliar name as often as they mangle it: "nar vis", "gnar viss".
 */
function wakePoints(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (soundsLikeWake(bare(words[i]))) out.push({ at: i, len: 1 });
    else if (i + 1 < words.length && soundsLikeWake(bare(words[i]) + bare(words[i + 1]))) out.push({ at: i, len: 2 });
  }
  return out;
}

// Where a spoken command ends and the conversation starts again. A microphone in a loud room does
// not hand you a sentence, it hands you a paragraph: "...so if we just, yeah, narvis make it bigger
// and then we should go find food". Nobody pauses for the parser. These are the words people
// actually use to change the subject mid-breath - and NOT a bare "and", because "a cube and a
// sphere" is one thing somebody is asking for.
const SEGMENT_BREAK = /\b(?:and then|then again|then|after that|anyway|by the way|you know|i mean|actually|wait|hold on|never mind|forget it|but|because|so that|alright|all right|thanks|thank you|right okay|okay so|ok so)\b/;

/**
 * What was said after the rig's name, or null if its name was not said.
 * An empty string means the name and nothing else ("Narvis?"), which is worth answering.
 * The name is looked for ANYWHERE, and the LAST one wins: if it is said twice in a paragraph, the
 * second is the one the person meant.
 */
export function afterWake(text) {
  const t = normalize(text);
  if (!t) return null;
  const words = t.split(' ');
  const hits = wakePoints(words);
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  return words.slice(last.at + last.len).join(' ');
}

/**
 * The command inside a paragraph, if there is one.
 *
 * Three filters, in this order, and the last one is what makes scanning a whole paragraph safe
 * rather than reckless: the name has to be in there; what follows it is cut at the first place the
 * speaker changed the subject; and whatever is left has to parse as an actual command. A stray
 * "nervous" in somebody's conversation gets through the first filter all day and never gets past
 * the third, because "about the demo" is not something this page can do.
 *
 * @returns {{woke: boolean, said: string, cmd: object|null, rest: string}}
 *   woke  the name was in there somewhere
 *   said  the words that were taken as the command (for the transcript)
 *   cmd   the parsed command, or null
 *   rest  what came after it, which nobody acts on - kept so the HUD can show what was ignored
 */
export function heardCommand(text) {
  const tail = afterWake(text);
  if (tail === null) return { woke: false, said: '', cmd: null, rest: '' };
  if (!tail) return { woke: true, said: '', cmd: null, rest: '' };

  // Cut at the point the sentence stops being an instruction.
  const cut = tail.search(SEGMENT_BREAK);
  const head = (cut > 0 ? tail.slice(0, cut) : tail).trim();
  const rest = cut > 0 ? tail.slice(cut).trim() : '';

  // Longest first: the segment is already bounded, so the whole of it is the best guess at what was
  // asked for ("make a coffee mug with a gold handle" is one request, not three). Shortening from
  // the end is for the words a recogniser tacks on that a person did not say.
  const words = head.split(' ').filter(Boolean);
  for (let len = words.length; len > 0; len--) {
    const said = words.slice(0, len).join(' ');
    const cmd = parseCommand(said);
    if (cmd) return { woke: true, said, cmd, rest: [words.slice(len).join(' '), rest].filter(Boolean).join(' ') };
  }
  return { woke: true, said: head, cmd: null, rest };
}

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return null;
  let m;

  if (/^(?:cancel|never ?mind|forget it|abort)$/.test(t)) return { type: 'cancel' };
  if ((m = parseVersion(t))) return m;
  if (/^(?:undo|undo that|go back|take that back|oops)$/.test(t)) return { type: 'undo' };
  if (/^(?:redo|redo that)$/.test(t)) return { type: 'redo' };
  if (/^(?:focus|focus on it|frame it|zoom to it|show me|show it|center it|centre it|find it)$/.test(t)) return { type: 'focus' };
  if (new RegExp(`^(?:focus|zoom(?: in)?|frame) (?:on |to )?${THAT}$`).test(t)) return { type: 'focus' };
  if (/^(?:zoom out|unfocus|focus off|(?:show|frame) the whole (?:thing|model)|whole model)$/.test(t)) return { type: 'unfocus' };
  if ((m = t.match(/^(?:focus|zoom(?: in)?|frame) (?:on |to )?the ([a-z0-9 ]+)$/))) return { type: 'focus', target: m[1] };
  // parts on screen: hide / isolate / show all ("hide that", "hide the lid", "show only the spout")
  if ((m = t.match(new RegExp(`^hide(?: ${THAT}| the ([a-z0-9 ]+))?$`)))) return m[1] ? { type: 'hide', target: m[1] } : { type: 'hide' };
  if ((m = t.match(new RegExp(`^(?:isolate|solo|show only|only show|just show)(?: ${THAT}| the ([a-z0-9 ]+))?$`)))) {
    return m[1] ? { type: 'isolate', target: m[1] } : { type: 'isolate' };
  }
  if (/^(?:show (?:all|everything|all (?:the )?parts|every part|it all)|unhide(?: all| everything| it all)?|bring (?:everything|them all) back)$/.test(t)) {
    return { type: 'show_all' };
  }
  // "clay view": a neutral matte look for reading the form ("clay" alone is the sculpt tool)
  const LOOK = '(?:view|look|render|shading)';
  if (new RegExp(`^(?:(?:turn on |switch to |use )?(?:the )?clay ${LOOK}(?: on)?|matte view)$`).test(t)) return { type: 'clay', on: true };
  if (new RegExp(`^(?:(?:the )?clay ${LOOK} off|turn (?:off (?:the )?clay ${LOOK}|(?:the )?clay ${LOOK} off)|(?:normal|material|materials|colou?r|full|regular) ${LOOK}|show (?:the )?(?:materials|colou?rs))$`).test(t)) {
    return { type: 'clay', on: false };
  }
  // "quick red", "quick metal": change the pointed-at part right here, no Fable (plain "make that red" goes to Fable)
  if ((m = t.match(new RegExp(`^quick (?:(?:make|colou?r|paint|turn) ${THAT}(?: part)? )?((?:dark |light |bright )?[a-z]+)$`)))) {
    const color = colorFor(m[1]);
    if (color) return { type: 'quick_color', color, name: m[1] };
    if (FINISHES[m[1]]) return { type: 'quick_finish', finish: FINISHES[m[1]], name: m[1] };
  }
  // "quick" promises instant and free, so an unknown word says what quick knows instead of falling through to
  // parseTyped's catch-all, which would start a real Fable build
  if (/^quick\b/.test(t)) return { type: 'quick_unknown', word: t.slice(5).trim() };
  // "clay brush", "use the grab brush", "switch to smooth brush"
  if ((m = t.match(/^(?:(?:use|switch to|change to|give me|pick) )?(?:the |a )?([a-z ]+?) brush$/)) && BRUSHES[m[1]]) {
    return { type: 'brush_pick', name: BRUSHES[m[1]] };
  }
  // The action words people say instead of naming a brush - "extrude", "pull it out", "melt it".
  // They name a brush AND mean "start sculpting with it", which is what brush_pick does. Nobody
  // learning this in thirty seconds at a demo table says "use the snake hook brush".
  // "extrude" is NOT in this list: it is the name of a TOOL now (the MODES table below), and the
  // tool brushes with Clay Strips. Matching it here would quietly load Snake Hook instead, which is
  // the same word meaning two different brushes depending on which line of this file runs first.
  if ((m = t.match(/^(?:(?:let'?s|now|i want to|can you) )?(stretch|spike|hook|melt|polish|soften|blend|dent|bump|pull(?: it)? out|push(?: it)? in)(?: it| that| this| out| more)?$/))) {
    const key = m[1].replace(/\bit\s+/, '').replace(/^build up$/, 'build');
    if (BRUSHES[key]) return { type: 'brush_pick', name: BRUSHES[key] };
  }
  // "add detail": subdivide, so the brush has vertices to move. Said a dozen ways because it is the
  // thing you reach for the moment a pull comes out as flat sails instead of clay.
  if (/^(?:(?:add|more|give me|i need|needs?) (?:more )?(?:detail|resolution|geometry|polys?|polygons?|vertices)|subdivide(?: it)?|more detail|denser|make it denser|smoother mesh)$/.test(t)) {
    return { type: 'detail' };
  }
  if (/^(?:(?:stop|quit) listening|mute(?: the)?(?: mic)?|mic off)$/.test(t)) return { type: 'mic', on: false };
  // "switch to sculpt mode", "go back to move mode", "use smooth"
  const modeText = t.replace(/^(?:(?:switch|change|go|swap)(?: back)? (?:to|into)|use|enter) (?:the )?/, '');
  for (const [re, mode] of MODES) if (re.test(modeText)) return { type: 'mode', mode };
  // ...and however else a tool is asked for (toolRequest, above). "turn" and "spin" on their own keep meaning
  // the turntable, and a brush asked for by name is a brush pick, both decided before this line is reached.
  if (!/^(?:turn|spin|spinning|stop spinning)(?: it)?$/.test(t)) { const asked = toolRequest(t); if (asked) return { type: 'mode', mode: asked }; }
  const MIRROR = '(?:the )?(?:mirror|symmetry)(?: mode)?';
  if (new RegExp(`^${MIRROR}(?: on)?$|^turn on ${MIRROR}$|^turn ${MIRROR} on$`).test(t)) return { type: 'mirror', on: true };
  if (new RegExp(`^${MIRROR} off$|^turn off ${MIRROR}$|^turn ${MIRROR} off$|^no (?:mirror|symmetry)$`).test(t)) return { type: 'mirror', on: false };
  // "bigger brush", "make the brush a bit smaller", "brush size bigger"
  if ((m = t.match(/^(?:make )?(?:the )?brush(?: size)? (a (?:little |bit |tiny bit )|a lot |much |way )?(bigger|larger|smaller)$|^(bigger|larger|smaller) brush$/))) {
    const how = m[1] || '', step = /little|bit/.test(how) ? 1.15 : /lot|much|way/.test(how) ? 1.8 : 1.35;
    return { type: 'brush', factor: (m[2] || m[3]) === 'smaller' ? 1 / step : step };
  }
  if (/^(?:clear(?: (?:it|all|everything|the scene))?|start over|reset(?: the)? scene|new scene|(?:delete|remove) (?:everything|all))$/.test(t)) {
    return { type: 'clear' };
  }
  if (new RegExp(`^(?:delete|remove|erase|get rid of)(?: (?:${THAT_WORDS}|the model|the object))?$`).test(t)) return { type: 'delete' };
  // "delete the teapot", "get rid of the second cube": name the thing instead of pointing at it,
  // which is the only way to do it at all when the thing you mean is behind something else.
  if ((m = t.match(/^(?:delete|remove|erase|get rid of|take away)(?: the| that| this)? ([a-z0-9_ -]+?)(?: please)?$/))
      && !/^(?:everything|all|it|this|that|model|object|scene)$/.test(m[1])) {
    return { type: 'delete', target: m[1].trim() };
  }
  if (new RegExp(`^(?:duplicate|copy|clone)(?: ${THAT})?$`).test(t)) return { type: 'duplicate' };
  if (/^(?:(?:export|save|download)(?: (?:it|this|that|the model|model))?(?: (?:to|for) blender)?|send (?:it |this )?to blender)$/.test(t)) {
    return { type: 'export' };
  }
  if ((m = t.match(/^(?:(?:make|scale) (?:it|this|that) )?(a (?:little |bit |tiny bit )|a lot |much |way )?(bigger|larger|smaller)$/))) {
    const [, how = '', dir] = m;
    const step = /little|bit/.test(how) ? 1.1 : /lot|much|way/.test(how) ? 1.6 : 1.25;
    return { type: 'scale', factor: dir === 'smaller' ? 1 / step : step };
  }
  if (/^(?:grow|enlarge|scale (?:it )?up|size (?:it )?up)$/.test(t)) return { type: 'scale', factor: 1.25 };
  if (/^(?:shrink(?: it)?|scale (?:it )?down|size (?:it )?down)$/.test(t)) return { type: 'scale', factor: 0.8 };
  if ((m = t.match(/^(?:turn|rotate)(?: (?:it|this|that))?(?: to the)? (left|right|around)$/))) {
    return { type: 'turn', deg: { left: -45, right: 45, around: 180 }[m[1]] };
  }
  if (/^(?:spin(?: it)?(?: around)?|rotate(?: it)?|turn(?: it)?|start (?:spinning|rotating)|turntable(?: on)?)$/.test(t)) {
    return { type: 'spin', on: true };
  }
  if (/^(?:stop|stop (?:spinning|rotating|it)|hold (?:it )?still|freeze|stay still|don't move|turntable off)$/.test(t)) {
    return { type: 'spin', on: false };
  }
  // "make that red": a looks-only change, which goes to Fable with the pointed-at part named (main.js)
  if ((m = t.match(new RegExp(`^(?:make|color|colour|paint|turn) ${THAT}(?: part)? ((?:dark |light |bright )?[a-z]+)$`)))) {
    const color = colorFor(m[1]);
    if (color) return { type: 'color', color, prompt: t };
  }

  // "add a cube" adds to the model, "make a cube" asks for a new one (Blender-side add_primitive comes later)
  if ((m = t.match(/^(add|place|put|drop|spawn|insert|make|create|build|give me)(?: me)? (?:a |an |another |one )?(?:new )?(\w+)$/))
      && PRIMITIVES[m[2]]) {
    return { type: 'add', shape: PRIMITIVES[m[2]], word: m[2], fresh: !/^(?:add|place|put|drop|spawn|insert)$/.test(m[1]) };
  }

  if ((m = t.match(/^(make|create|build|generate|design|model|draw|give me|show me|i want|i need)(?: me)? (.+)$/))) {
    if (m[1] === 'make' && (REFERS.test(m[2]) || (/^the\b/.test(m[2]) && CHANGE_TAIL.test(m[2])))) return { type: 'change', prompt: t };
    // Every "make" ADDS to the scene. Asking for a second thing and losing the first is the one
    // outcome nobody means, so emptying the scene has to be asked for in words - "instead", "on its
    // own", "start over" - and those words are how people say it when they do mean it.
    // `replace` is only present when it was asked for. Adding is the default, so the default shape
    // is the plain one and nothing downstream has to remember which way round the flag reads.
    const prompt = m[2].replace(REPLACE_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return REPLACE_WORDS.test(m[2]) ? { type: 'make', prompt, replace: true } : { type: 'make', prompt };
  }
  if (/^(?:change|modify|edit|adjust|update|alter|tweak|replace|swap|recolou?r|colou?r|paint|turn (?:it|this|that) into|give (?:it|this|that)|add|attach|put|place|remove|delete|take (?:off|away)|get rid of|move|raise|lower|widen|stretch|flatten|round|thicken|lengthen|shorten|rotate|tilt|flip|mirror|resize|scale|duplicate|copy|double) .+/.test(t)) {
    return { type: 'change', prompt: t };
  }
  return null;
}

// Typed text is always meant as a command, so anything unrecognised becomes "make <text>".
export function parseTyped(text) {
  const t = normalize(text);
  return parseCommand(t) || (t ? { type: 'make', prompt: t } : null);
}
