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

/**
 * The hand-input deviations, with the reason each one exists.
 *
 * The theme: Blender's numbers assume a pen, a screen you are six inches from, and as many strokes
 * as you like. A hand in the air in front of a hologram gets ONE slow pass, at arm's length, with
 * no pressure and a centimetre of tracking jitter - so a preset tuned for the pen reads as "the
 * brush does nothing". Every strength below is the same brush doing the same thing, turned up to
 * where one pass of a hand is worth one pass of a pen at the artist's own pace.
 */
export const HAND_OVERRIDES = {
  // Essentials Grab is 0.4, so the grabbed point only follows 40% of the hand and feels like lag.
  //
  // max_pull_radius_fraction and auto_smooth_factor are what make a pull read as CLAY. A surface can
  // only bend so far across the width of the brush: pull further than about half the radius and the
  // falloff edge becomes a crease and the middle a thin sail, which is what "extrude" looked like
  // before these two numbers existed. Measured on the rig's own model: 7 cm brush pulling 2.5 cm
  // gives a dome (0.95 deg between neighbouring faces), 4 cm brush pulling 7 cm gives a folded sheet
  // (2.37 deg, 80 deg creases). So the pull is capped and the surface is smoothed as it goes, and
  // pulling further is done by asking for a bigger brush.
  Grab: { strength: 1.0, max_pull_radius_fraction: 0.5, auto_smooth_factor: 0.4 },
  'Grab Silhouette': { strength: 1.0, max_pull_radius_fraction: 0.5, auto_smooth_factor: 0.4 },
  'Elastic Grab': { strength: 1.0, max_pull_radius_fraction: 0.6, auto_smooth_factor: 0.3 },
  // Pointing error is magnified into the box, so never sculpt the back of a part you cannot see.
  '*': { use_frontface: true },
  // Layer's height is absolute object units in Blender (0.05 m); relative to the radius is what
  // the artist means by "a layer this thick" when the radius is set by voice.
  Layer: { height_is_radius_fraction: 0.15 },

  // Smooth at Blender's 0.7 is two and a bit averaging passes per dab, which is a polish - you are
  // meant to scrub, and a hand gets one pass. Full strength is four passes, which is Blender's own
  // ceiling and where this stops.
  //
  // It went to twelve for a day and that was a mistake worth writing down: averaging a vertex
  // towards its neighbours SHRINKS a surface, so on anything thin the extra passes do not round it,
  // they collapse it. Measured on a pulled ridge, smoothing at 2 / 4 / 6 / 12 passes took the mean
  // angle between neighbouring faces from 2.4 deg to 5.6 / 6.4 / 6.5 / 7.0 and folded faces back on
  // themselves (180 deg) at every setting - the picture was a beak, not a smooth form. Smoothing
  // cannot rescue a shape the surface could not bend into; capping the pull above is what stops that
  // shape being made in the first place.
  Smooth: { strength: 1.0 },

  // Pulling material OUT is the move people mean by "extrude", and Snake Hook is Blender's brush
  // for it. Its 10% spacing leaves gaps when a hand moves fast, and a hand pulls a long way in one
  // gesture, so the dabs are packed closer to keep the pulled shape continuous.
  'Snake Hook': { strength: 1.0, spacing: 5 },
  'Elastic Snake Hook': { strength: 1.0, spacing: 5 },
  Pull: { strength: 1.0 },

  // The clay family: 0.5 is a pen's "build it up over ten strokes". One hand pass should read as
  // one handful of clay.
  //
  // plane_offset is how far above the surface the brush lays its clay, as a fraction of the radius,
  // and Blender's 0.15 is a thin strip you go over again and again. A hand gets one pass, so it
  // lays a thick one: at a 4 cm brush that is 2 cm of clay instead of 6 mm, which is the difference
  // between "did that do anything?" and watching a shape grow out of the surface.
  'Clay Strips': { strength: 1.0, plane_offset: 0.5 },
  Clay: { strength: 1.0 },
  'Clay Thumb': { strength: 1.0 },
  Draw: { strength: 1.0 },
  'Draw Sharp': { strength: 0.9 },
  Blob: { strength: 1.0 },
  'Inflate/Deflate': { strength: 0.9 },
  'Crease Sharp': { strength: 0.9 },
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
