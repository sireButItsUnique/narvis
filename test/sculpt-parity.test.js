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
const CASE_TOLERANCE = { grab: 0.025 };

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
      const tol = CASE_TOLERANCE[ref.case] ?? (PLANE_LIKE.has(ref.case) ? TOLERANCE.plane : TOLERANCE.default);
      console.log(
        `  ${ref.case.padEnd(20)} blender max ${r.maxDisp.toFixed(5)}  err ${r.maxErr.toExponential(2)}` +
        `  ${r.percent.toFixed(3)}% of max  rms ${r.rms.toExponential(2)}`,
      );
      assert.ok(r.maxDisp > 0, 'the reference stroke moved nothing');
      assert.ok(
        r.percent <= tol * 100,
        `${ref.case}: ${r.percent.toFixed(3)}% of Blender's max displacement, over the ${(tol * 100).toFixed(0)}% budget`,
      );
    });
  }
});
