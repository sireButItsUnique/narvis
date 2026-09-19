// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. Brush set A: the surface-building brushes.
//
// registry.js imports this array and never needs editing. See registry.js for the kernel
// contract, and draw.js / inflate.js for the two shortest examples.
//
//   clay_strips  [clay_strips.cc]  a square-tipped ribbon of clay laid along the stroke
//   plane        [plane.cc]        Flatten/Contrast, Scrape/Fill, Fill/Deepen, Plateau and Trim,
//                                  which in Blender 5.x are five presets of ONE height/depth kernel
//   clay         [clay.cc]         pull towards a plane held 0.4 of a radius above the cursor
//   layer        [layer.cc]        a slab of fixed thickness that plateaus at exactly `height`
//   draw_sharp   [draw_sharp.cc]   Draw with a POW4 falloff weighed on the stroke-start shape
//
// brush-frame.js is shared geometry, not a kernel: the brush-local box that Clay Strips and the
// Plane family both work in.
//
// Still to come (set-b, filled in separately): Crease/Blob, Pinch/Magnify, Snake Hook,
// Elastic Grab, Thumb, Nudge, Mask.

import { clayStrips } from './clay-strips.js';
import { plane } from './plane.js';
import { clay } from './clay.js';
import { layer } from './layer.js';
import { drawSharp } from './draw-sharp.js';

export default [clayStrips, plane, clay, layer, drawSharp];
