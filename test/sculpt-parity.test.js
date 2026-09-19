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
// ones that also have to agree on a brush plane or an area centre. The budget belongs to the
// BRUSH, so it is keyed off the kernel rather than the case name and a short or dense variant of
// a case gets the same budget as the original.
const TOLERANCE = { default: 0.02, plane: 0.05 };
const PLANE_LIKE = new Set(['clay', 'clay_strips', 'plane', 'snake_hook']);

// Max-vertex-error is a worst-case metric and says nothing about how many vertices are wrong, so
// every case also has to keep its RMS error under 1% of Blender's max displacement. Nothing here
// is close to it today (the worst is clay_strips at 0.70%), which is what makes it a useful net:
// a real regression in a kernel moves the whole field, not three vertices.
const RMS_TOLERANCE = 0.01;

// One case gets its own budget, with the measurement that justifies it.
//
// `grab` starts at x0 = -90 px, so the first dabs miss the sphere and the stroke anchors on the
// very first ray that grazes the silhouette. Grab pins its whole deformation to that one point.
// Fitting Blender's own per-vertex weights says its anchor sits 4.4 mm from ours along the
// surface (a single centre offset drops the weight residual from 1.2e-2 to 3.7e-4, and the fitted
// radius comes back as 0.30007 - so the radius, the pull and the falloff all agree, only the
// anchor does not). Blender disagrees with itself there too: the same ray through ob.ray_cast
// lands where we land, 4.4 mm from where the sculpt code anchored. The two grab pulls that start
// on the face instead of the silhouette (grab_pull, grab_pull_short) come in at 0.40% and 0.59%.
//
// SET A. Three brushes need a bigger budget on their LONG strokes, and the reason is the same for
// all three, measured with cases generated for exactly this purpose (see scripts/blender-ref.py):
// a single dab is near-exact and the difference accumulates coherently, while Blender's max
// displacement barely grows because the stroke moves on.
//
//                       1 dab   2 dabs   8 dabs (on the face)   16 dabs (from the silhouette)
//   draw_sharp          0.33%   1.17%    2.67%                  3.78%
//   layer               0.46%   1.19%    2.55%                  4.52%
//   clay_strips           -     5.61%    5.88% (6 dabs)         10.11%
//
// For Draw Sharp and Layer the per-dab difference is about 0.2% of one dab's displacement and it
// is numerical, not structural: the area normal agrees with Blender's to 0.02 degrees, the
// direction of every vertex's move agrees to four decimals, and only the magnitude is ~0.18% high,
// which is a ~0.2 mm difference in where the dab's raycast lands. Refining the mesh does not help
// (draw_sharp_dense 2.61% against draw_sharp_face 2.67%), which is what says it is not resolution.
//
// Clay Strips is a different story and its own budget is the mesh, not the kernel: the square tip
// falls from full strength to nothing over tip_roundness (0.15) of a radius = 4.5 mm, which is
// HALF an edge length on the 2,562-vertex sphere, so whether a single vertex lands inside or
// outside that band swings its weight. Only 3 vertices of 2,562 are over 5% in the short case, the
// RMS is 0.24% of max, the summed factor over the whole dab matches Blender's to 0.2%, and the
// peak vertex matches to 0.2%. Doubling the mesh resolution drops the same stroke from 5.88% to
// 4.20% (clay_strips_dense), which is the test that confirms it.
//
// The well-conditioned variants of all three are held to the plan's real budgets and are NOT
// listed here.
const CASE_TOLERANCE = {
  grab: 0.025,
  clay_strips: 0.105,
  clay_strips_face: 0.06,
  clay_strips_short: 0.06,
  draw_sharp: 0.04,
  draw_sharp_face: 0.03,
  draw_sharp_dense: 0.03,
  layer: 0.05,
  layer_face: 0.03,
  layer_dense: 0.03,
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

  const ours = handle.proxy.getVertices();
  let maxDisp = 0, maxErr = 0, sumSq = 0;
  const n = ref.before.length / 3;
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
  return { maxDisp, maxErr, rms: Math.sqrt(sumSq / n), percent: maxDisp > 0 ? (100 * maxErr) / maxDisp : 0 };
}

const files = fs.existsSync(REF_DIR) ? fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.json')).sort() : [];

test('Blender parity', { skip: files.length === 0 ? 'no fixtures: run npm run parity:ref' : false }, async (t) => {
  for (const file of files) {
    const ref = JSON.parse(fs.readFileSync(path.join(REF_DIR, file), 'utf8'));
    const brush = getBrushForPreset(ref.brush);
    await t.test(`${ref.case} (${ref.brush})`, { skip: brush ? false : `${ref.brush} is not in the registry yet` }, () => {
      const r = replay(ref);
      const tol = CASE_TOLERANCE[ref.case] ?? (PLANE_LIKE.has(brush.key) ? TOLERANCE.plane : TOLERANCE.default);
      const rmsPercent = (100 * r.rms) / r.maxDisp;
      console.log(
        `  ${ref.case.padEnd(20)} blender max ${r.maxDisp.toFixed(5)}  err ${r.maxErr.toExponential(2)}` +
        `  ${r.percent.toFixed(3)}% of max  rms ${r.rms.toExponential(2)} (${rmsPercent.toFixed(2)}%)`,
      );
      assert.ok(r.maxDisp > 0, 'the reference stroke moved nothing');
      assert.ok(
        rmsPercent <= RMS_TOLERANCE * 100,
        `${ref.case}: RMS ${rmsPercent.toFixed(2)}% of Blender's max displacement, over the ${(RMS_TOLERANCE * 100).toFixed(0)}% budget`,
      );
      assert.ok(
        r.percent <= tol * 100,
        `${ref.case}: ${r.percent.toFixed(3)}% of Blender's max displacement, over the ${(tol * 100).toFixed(0)}% budget`,
      );
    });
  }
});
