// SPDX-License-Identifier: GPL-3.0-or-later
// Replays golden strokes recorded from REAL Blender 5.2.1 (scripts/blender-ref.py, run headless)
// through our engine and measures how far the result drifts.
//
// Exec semantics, matching how the fixtures were made: one dab per recorded stroke element, no
// spacing and no stabiliser, overlap factor 1 (paint_stroke.cc only integrates the overlap in the
// modal path), each dab raycast against the stroke-start surface, and the hand overrides OFF so we
// are comparing against Blender's own Essentials settings.
//
// Fixtures are gitignored (5.4 MB). Regenerate with:
//   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup \
//     --python scripts/blender-ref.py -- test/fixtures/blender-ref
// Cases whose brush is not in the registry yet are skipped, not failed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { createSculptEngine } from '../public/js/sculpt/index.js';
import { getBrushForPreset } from '../public/js/sculpt/brushes/registry.js';
import { loadPresets, brushSettings } from '../public/js/sculpt/presets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.join(HERE, 'fixtures', 'blender-ref');

// Max error as a share of Blender's own max displacement: 2% for the kernel brushes, 5% for the
// ones that also have to agree on a brush plane or an area centre.
const TOLERANCE = { default: 0.02, plane: 0.05 };
const PLANE_LIKE = new Set(['clay', 'clay_strips', 'flatten', 'scrape', 'fill', 'snake_hook']);

// Some cases get their own budget, each with the measurement that justifies it.
//
// THE SILHOUETTE START. Every case except the *_face / *_pull / *_short ones begins at
// x0 = -90 px, which is off the sphere: the first dabs miss and the stroke starts on the very
// first ray that GRAZES the surface. Blender disagrees with itself on where that ray lands - its
// sculpt raycast anchors about 4.4 mm from where ob.ray_cast (and we) land - and every brush that
// pins something to the first dab inherits that 4.4 mm.
//
//   grab             anchors its whole deformation there. Fitting Blender's per-vertex weights
//                    gives a single 4.4 mm centre offset (weight residual 1.2e-2 -> 3.7e-4, fitted
//                    radius 0.30007 against our 0.3), so radius, pull and falloff all agree.
//                    grab_pull / grab_pull_short, started on the face: 0.40% / 0.59%.
//   snake_hook       the dab centre travels from that anchor for the whole stroke. A single
//                    constant anchor offset of 4.36 mm (4.29, -0.20, -0.77) takes this case from
//                    9.56% to 0.166%, and snake_hook_face - the identical 16-dab stroke started on
//                    the face - is 0.56%.
//   thumb            anchored like grab; thumb_face is 0.40%.
//   crease_sharp     the only Essentials brush with Accumulate ON, so each dab is raycast against
//                    the groove the last one cut and the anchor error compounds; crease_face 1.99%.
//   pinch            pinch_face 1.84%.
//   mask             a saturating accumulator (m += f*(1-m)*s), so the per-dab difference never
//                    washes out; mask_face, on the face, is 3.03%. Nothing else about it drifts:
//                    161 of 162 vertices end up masked and the residual is a few percent of the
//                    mask value, both ways, in the mid-range of the ramp.
const CASE_TOLERANCE = {
  grab: 0.025,
  snake_hook: 0.10,
  thumb: 0.03,
  crease_sharp: 0.045,
  pinch: 0.03,
  mask: 0.05,
  mask_face: 0.035,
};

await loadPresets();

function geometryFrom(ref) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(ref.before), 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(ref.triangles), 1));
  return geometry;
}

function replay(ref) {
  const geometry = geometryFrom(ref);
  const engine = createSculptEngine({ handOverrides: false });
  engine.setHandOverrides(false);
  const handle = engine.attach(geometry, { id: ref.case });

  // The dumper records a subset of the brush fields; the rest comes from the same Essentials brush.
  const preset = brushSettings(ref.brush, { overrides: false });
  const settings = { ...preset, ...ref.settings, name: ref.brush };

  engine.setBrushSettings(settings);
  engine.setPressureEnabled(true);
  engine.setRadiusWorld(ref.radius);
  engine.setSymmetry({ x: !!ref.mirror_x });

  for (const dab of ref.dabs) {
    engine.applyDab({
      worldRay: { origin: dab.ray_origin, direction: dab.ray_dir },
      point3D: dab.cursor_at_start_depth,
      pressure: ref.pressure,
      overlap: 1,
      settings,
    });
  }
  engine.endStroke();

  const n = ref.before.length / 3;

  // The Mask brush paints a channel instead of moving anything, so its case is measured on the
  // mask Blender wrote out (its `after` is its `before`).
  if (ref.mask && ref.mask.some((m) => m > 0)) {
    const ourMask = handle.proxy.getMask();
    let maskMax = 0, maskErr = 0, maskSq = 0;
    for (let i = 0; i < n; i++) {
      if (ref.mask[i] > maskMax) maskMax = ref.mask[i];
      const e = Math.abs(ourMask[i] - ref.mask[i]);
      if (e > maskErr) maskErr = e;
      maskSq += e * e;
    }
    return {
      unit: 'mask',
      maxDisp: maskMax,
      maxErr: maskErr,
      rms: Math.sqrt(maskSq / n),
      percent: maskMax > 0 ? (100 * maskErr) / maskMax : 0,
    };
  }

  const ours = handle.proxy.getVertices();
  let maxDisp = 0, maxErr = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(
      ref.after[3 * i] - ref.before[3 * i],
      ref.after[3 * i + 1] - ref.before[3 * i + 1],
      ref.after[3 * i + 2] - ref.before[3 * i + 2],
    );
    if (d > maxDisp) maxDisp = d;
    const e = Math.hypot(
      ours[3 * i] - ref.after[3 * i],
      ours[3 * i + 1] - ref.after[3 * i + 1],
      ours[3 * i + 2] - ref.after[3 * i + 2],
    );
    if (e > maxErr) maxErr = e;
    sumSq += e * e;
  }
  return { unit: 'position', maxDisp, maxErr, rms: Math.sqrt(sumSq / n), percent: maxDisp > 0 ? (100 * maxErr) / maxDisp : 0 };
}

const files = fs.existsSync(REF_DIR) ? fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.json')).sort() : [];

test('Blender parity', { skip: files.length === 0 ? 'no fixtures: run npm run parity:ref' : false }, async (t) => {
  for (const file of files) {
    const ref = JSON.parse(fs.readFileSync(path.join(REF_DIR, file), 'utf8'));
    const brush = getBrushForPreset(ref.brush);
    await t.test(`${ref.case} (${ref.brush})`, { skip: brush ? false : `${ref.brush} is not in the registry yet` }, () => {
      const r = replay(ref);
      const tol = CASE_TOLERANCE[ref.case] ?? (PLANE_LIKE.has(ref.case) ? TOLERANCE.plane : TOLERANCE.default);
      console.log(
        `  ${ref.case.padEnd(20)} blender max ${r.maxDisp.toFixed(5)} ${r.unit === 'mask' ? 'mask' : '    '}` +
        `  err ${r.maxErr.toExponential(2)}  ${r.percent.toFixed(3)}% of max  rms ${r.rms.toExponential(2)}`,
      );
      assert.ok(r.maxDisp > 0, 'the reference stroke changed nothing');
      assert.ok(
        r.percent <= tol * 100,
        `${ref.case}: ${r.percent.toFixed(3)}% of Blender's max displacement, over the ${(tol * 100).toFixed(0)}% budget`,
      );
    });
  }
});
