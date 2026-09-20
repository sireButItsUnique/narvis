// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Brush set B: the pulling brushes, masking and the whole-part filters.
//
// registry.js imports this array and never needs editing. Each kernel lives in its own file next
// to this one; the Blender source it is paraphrased from is named in that file's SPDX header.
//
//   snake_hook.js  Snake Hook / Pull / Elastic Snake Hook  [snake_hook.cc]
//   elastic.js     Elastic Grab                            [elastic_deform.cc + kelvinlet.cc]
//   crease.js      Crease Sharp / Crease Polish, and Blob  [crease.cc]
//   pinch.js       Pinch/Magnify                           [pinch.cc]
//   mask.js        Mask                                    [mask.cc]
//   nudge.js       Nudge                                   [draw.cc]
//   thumb.js       Thumb                                   [thumb.cc]
//
// Filters and mask operations are not brushes, so they do not belong in this array. They are
// plugged into an engine with installSetB(engine) - call it once after createSculptEngine():
//
//   import { createSculptEngine } from './sculpt/index.js';
//   import { installSetB } from './sculpt/brushes/set-b.js';
//   const engine = installSetB(createSculptEngine());
//   engine.maskOp('grow');            // clear | fill | invert | grow | shrink | blur | sharpen
//   engine.filter('smooth', { strength: 0.5 });   // smooth | inflate | sharpen | scale
//
// (It is a call rather than an import side effect because index.js builds its default engine
// while this module is still loading - registry.js needs set-b before index.js exists.)

import { snakeHook } from './snake_hook.js';
import { elastic } from './elastic.js';
import { crease, blob } from './crease.js';
import { pinch } from './pinch.js';
import { mask } from './mask.js';
import { nudge } from './nudge.js';
import { thumb } from './thumb.js';
import { registerFilters } from '../filters.js';
import { registerMaskOps } from '../mask-ops.js';

/** Add set B's whole-part operations to an engine. Returns the engine, so it chains. */
export function installSetB(engine) {
  registerFilters(engine);
  registerMaskOps(engine);
  return engine;
}

export default [snakeHook, elastic, crease, blob, pinch, mask, nudge, thumb];
