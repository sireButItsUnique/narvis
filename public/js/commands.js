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

const FILLER = /^(?:(?:hey|ok|okay|so|um+|uh+|and|now|then|please|can you|could you|would you|will you|let's|lets|go ahead and|i want you to)\s+)+/;
// "make it/the/this ..." edits the current model instead of making a new one
const REFERS = /^(?:it|its|it's|the|this|that|these|those|them|everything|all)\b/;

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
  if (/^(?:clear(?: (?:it|all|everything|the scene))?|start over|reset(?: the)? scene|new scene|(?:delete|remove) (?:everything|all))$/.test(t)) {
    return { type: 'clear' };
  }
  if (/^(?:delete|remove|erase|get rid of)(?: (?:it|this|that|this part|that part|the model|the object))?$/.test(t)) {
    return { type: 'delete' };
  }
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
  if (/^(?:spin|rotate|turn)(?: (?:it|around|it around))?$|^start (?:spinning|rotating)$|^turntable(?: on)?$/.test(t)) {
    return { type: 'spin', on: true };
  }
  if (/^(?:stop|stop (?:spinning|rotating|it)|hold (?:it )?still|freeze|stay still|don't move|turntable off)$/.test(t)) {
    return { type: 'spin', on: false };
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
