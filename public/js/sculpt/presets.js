// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. presets.json is a measurement of the Blender 5.2.1 Essentials brush library
// (dumped headless from datafiles/assets/brushes/essentials_brushes-mesh_sculpt.blend), so the
// numbers are facts about Blender, not code copied from it.
//
// Brush settings keep Blender's own field names on purpose: the parity fixtures record exactly
// those fields, so a golden case can be replayed by handing its settings straight to the engine.
//
// HAND_OVERRIDES is the ONE place where we knowingly differ from Blender, because the input is a
// hand in the air rather than a pen on glass. Parity tests run with the overrides off.

let PRESETS = null;

/** The hand-input deviations, with the reason each one exists. */
export const HAND_OVERRIDES = {
  // Essentials Grab is 0.4, so the grabbed point only follows 40% of the hand and feels like lag.
  Grab: { strength: 1.0 },
  'Grab Silhouette': { strength: 1.0 },
  'Elastic Grab': { strength: 1.0 },
  // Pointing error is magnified into the box, so never sculpt the back of a part you cannot see.
  '*': { use_frontface: true },
  // Layer's height is absolute object units in Blender (0.05 m); relative to the radius is what
  // the artist means by "a layer this thick" when the radius is set by voice.
  Layer: { height_is_radius_fraction: 0.15 },
};

/** Radius is world-locked in the box, not a pixel size. */
export const RADIUS_DEFAULT_M = 0.025;
export const RADIUS_MIN_M = 0.003;
export const RADIUS_MAX_M = 0.12;
export const RADIUS_STEP = 1.25;

/** Load presets.json. Works from the browser (fetch) and from Node (fs), no bundler needed. */
export async function loadPresets(source) {
  const url = source ?? new URL('./presets.json', import.meta.url);
  if (typeof url === 'object' && url.brushes) return setPresets(url);
  const href = typeof url === 'string' ? url : url.href;
  if (href.startsWith('file:')) {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return setPresets(JSON.parse(await fs.readFile(fileURLToPath(href), 'utf8')));
  }
  const res = await fetch(href);
  return setPresets(await res.json());
}

/** Inject an already parsed presets.json (tests, or a page that bundles it). */
export function setPresets(data) {
  PRESETS = data;
  return PRESETS;
}

export function getPresets() {
  if (!PRESETS) throw new Error('presets: call loadPresets() first');
  return PRESETS;
}

export function presetNames() {
  return Object.keys(getPresets().brushes);
}

/**
 * Brush settings for one Essentials brush.
 * @param {string} name the Blender brush name, e.g. "Clay Strips"
 * @param {object} [o] {overrides=true, invert=false}
 */
export function brushSettings(name, o = {}) {
  const raw = getPresets().brushes[name];
  if (!raw) throw new Error(`presets: no brush named "${name}"`);
  const settings = { ...raw, name };
  if (o.overrides !== false) applyHandOverrides(settings, name);
  return settings;
}

/** Apply HAND_OVERRIDES in place. Split out so the HUD can show what was changed. */
export function applyHandOverrides(settings, name = settings.name) {
  Object.assign(settings, HAND_OVERRIDES['*'] || {});
  Object.assign(settings, HAND_OVERRIDES[name] || {});
  settings.hand_overrides = true;
  return settings;
}

/** Clamp a world radius to what the box can show, and step it by voice ("bigger"/"smaller"). */
export function clampRadius(r) {
  return Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, r));
}

export function stepRadius(r, direction) {
  return clampRadius(direction > 0 ? r * RADIUS_STEP : r / RADIUS_STEP);
}

/**
 * Layer height in part-local metres: absolute in Blender, a fraction of the radius under the
 * hand override.
 */
export function layerHeight(settings, radiusLocal) {
  if (settings.height_is_radius_fraction) return settings.height_is_radius_fraction * radiusLocal;
  return settings.height ?? 0.05;
}
