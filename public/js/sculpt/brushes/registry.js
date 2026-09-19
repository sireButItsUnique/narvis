// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt: the list of brush kernels the engine can run.
//
// This file never needs editing again. The core four live here; everything else arrives through
// set-a.js and set-b.js, which are filled in separately. A kernel is a plain object:
//
//   {
//     key:        'clay_strips',        // stable id used by voice and the HUD
//     presets:    ['Clay Strips'],      // Essentials brushes this kernel implements (presets.json)
//     type:       'CLAY_STRIPS',        // picks the row in cache.js brushStrength()
//     usesOriginalData: false,          // weigh vertices by the stroke-start shape, not the live one
//     useOriginalNormals: false,        // ... and by the stroke-start normals (Inflate)
//     needsAreaNormal: false,           // engine fills cache.sculptNormalSymm before apply()
//     needsAreaCenter: false,           // ... and cache.areaCenterSymm
//     needsStrokeDirection: false,      // no dab until the hand has moved (skips the first one)
//     restoreEachStep: true,            // rebuild from the stroke start every step (grab family)
//     anchoredOrigin: true,             // dab stays at the stroke start; the hand delta deforms
//     allVertices: false,               // ignore the radius when gathering (elastic, pose)
//     noAutoSmooth: false,              // Smooth and Mask never auto-smooth
//     lazy: true,                       // stabiliser on for this brush
//     apply(ctx) { ... }                // fill ctx.translations, then ctx.commit()
//   }
//
// ctx gives a kernel: proxy, cache, settings, verts, factors, distances, positions, normals,
// origPositions, origNormals, translations, and the helpers commit(), touch(v), markDirty(),
// computeFactors(out). Anything a kernel writes outside translations must be announced with
// touch(v) so undo and the render scatter see it.

import { draw } from './draw.js';
import { smooth } from './smooth.js';
import { grab } from './grab.js';
import { inflate } from './inflate.js';
import setA from './set-a.js';
import setB from './set-b.js';

const CORE = [draw, smooth, grab, inflate];

const byKey = new Map();
const byPreset = new Map();

function register(brush) {
  if (!brush || !brush.key || typeof brush.apply !== 'function') {
    throw new Error('brush registry: a kernel needs a key and an apply()');
  }
  byKey.set(brush.key, brush);
  for (const preset of brush.presets || []) byPreset.set(preset, brush);
}

for (const b of [...CORE, ...(setA || []), ...(setB || [])]) register(b);

/** @returns {object|undefined} the kernel for a key such as 'draw'. */
export function getBrush(key) {
  return byKey.get(key);
}

/** @returns {object|undefined} the kernel that implements an Essentials brush, e.g. "Clay Strips". */
export function getBrushForPreset(name) {
  return byPreset.get(name);
}

export function brushKeys() {
  return [...byKey.keys()];
}

export function registeredPresets() {
  return [...byPreset.keys()];
}

export { register };
