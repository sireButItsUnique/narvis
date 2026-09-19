// What you said (or typed) -> a command object. Pure: no DOM, no three.js, so `node --test` can check it.
//
// Speech that doesn't start like a command returns null and is ignored, so talking near the mic is harmless.

// spoken word -> builder shape
export const PRIMITIVES = {
  cube: 'box', box: 'box', block: 'box',
  sphere: 'sphere', ball: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  torus: 'torus', donut: 'torus', doughnut: 'torus', ring: 'torus',
  capsule: 'capsule', pill: 'capsule',
};

// colour words for "make that red" while pointing at a part
export const COLORS = {
  red: '#d93a3a', orange: '#f28c28', yellow: '#f2d02e', green: '#3fae4a', blue: '#3a6fd9', purple: '#8a4fd1',
  pink: '#f07ab0', white: '#f2f2f2', black: '#1c1c1c', gray: '#8c8c8c', grey: '#8c8c8c', brown: '#8b5a2b',
  gold: '#d4af37', silver: '#c0c0c0', cyan: '#35d0ff', teal: '#1f9e9a', navy: '#1f2f6b', beige: '#e3d5b8',
  maroon: '#7a1f2b', lime: '#9be34a', magenta: '#d63ad0', tan: '#c9a77c', cream: '#f4eedd', wood: '#a0703c', wooden: '#a0703c',
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

// tool modes: what a pinch does
const MODES = [
  [/^(?:sculpt|sculpting|sculpt mode|clay|clay mode|start sculpting)$/, 'sculpt'],
  [/^(?:smooth|smoothing|smooth mode|smooth it(?: out)?)$/, 'smooth'],
  [/^(?:part|parts|part mode|parts mode|select parts?|move parts?|pick parts?)$/, 'part'],
  [/^(?:move|move mode|grab mode|normal mode|done|done sculpting|stop sculpting|stop smoothing|exit (?:sculpt|smooth|part)(?: mode)?)$/, 'move'],
];

const FILLER = /^(?:(?:hey|ok|okay|so|um+|uh+|and|now|then|please|can you|could you|would you|will you|let's|lets|go ahead and|i want you to)\s+)+/;
// "make it/the/this ..." edits the current model instead of making a new one
const REFERS = /^(?:it|its|it's|the|this|that|these|those|them|everything|all)\b/;
const THAT_WORDS = 'it|this|that|this part|that part|this one|that one';
const THAT = `(?:${THAT_WORDS})`;

export function normalize(text) {
  return String(text ?? '').toLowerCase()
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')        // drop full stops, keep decimals like 1.5
    .replace(/[“”"!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(FILLER, '')
    .replace(/\s+please$/, '')
    .trim();
}

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return null;
  let m;

  if (/^(?:cancel|never ?mind|forget it|abort)$/.test(t)) return { type: 'cancel' };
  if (/^(?:undo|undo that|go back|take that back|oops)$/.test(t)) return { type: 'undo' };
  if (/^(?:(?:stop|quit) listening|mute(?: the)?(?: mic)?|mic off)$/.test(t)) return { type: 'mic', on: false };
  // "switch to sculpt mode", "go back to move mode", "use smooth"
  const modeText = t.replace(/^(?:(?:switch|change|go|swap)(?: back)? (?:to|into)|use|enter) (?:the )?/, '');
  for (const [re, mode] of MODES) if (re.test(modeText)) return { type: 'mode', mode };
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
  // "make that red": recolours the part you point at; with nothing pointed at, the AI handles it
  if ((m = t.match(new RegExp(`^(?:make|color|colour|paint|turn) ${THAT}(?: part)? ((?:dark |light |bright )?[a-z]+)$`)))) {
    const color = colorFor(m[1]);
    if (color) return { type: 'color', color, prompt: t };
  }

  // "add a cube" adds to the model, "make a cube" starts a new one. Both are instant, no AI.
  if ((m = t.match(/^(add|place|put|drop|spawn|insert|make|create|build|give me)(?: me)? (?:a |an |another |one )?(?:new )?(\w+)$/))
      && PRIMITIVES[m[2]]) {
    return { type: 'add', shape: PRIMITIVES[m[2]], word: m[2], fresh: !/^(?:add|place|put|drop|spawn|insert)$/.test(m[1]) };
  }

  if ((m = t.match(/^(make|create|build|generate|design|model|draw|give me|show me|i want|i need)(?: me)? (.+)$/))) {
    if (m[1] === 'make' && REFERS.test(m[2])) return { type: 'change', prompt: t };
    return { type: 'make', prompt: m[2] };
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
