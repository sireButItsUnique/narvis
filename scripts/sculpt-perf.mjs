// SPDX-License-Identifier: GPL-3.0-or-later
// Per-dab cost of every registered brush on a ~150k-triangle part, which is the plan's budget
// case: a dab has to fit inside a 6 ms frame WITH auto-smooth and one mirror pass, because that is
// what a hand actually does to the model.
//
// Usage: node scripts/sculpt-perf.mjs [triangles]
//
// The stroke is driven through applyDab(), which is one dab exactly as given - no spacing and no
// stabiliser - so a number here is the cost of one dab and not of one hand sample. The symmetry
// passes and the auto-smooth pass both run inside it, so they are included in the measurement.

import * as THREE from 'three';
import { createSculptEngine } from '../public/js/sculpt/index.js';
import { installSetB } from '../public/js/sculpt/brushes/set-b.js';
import { brushKeys, getBrush } from '../public/js/sculpt/brushes/registry.js';
import { loadPresets, brushSettings } from '../public/js/sculpt/presets.js';

const TARGET_TRIS = Number(process.argv[2] || 150000);
const RADIUS_M = 0.025;   // the hand brush's default 2.5 cm
const BALL_R = 0.15;      // a 30 cm model, the size the box fits things to
const DABS = 40;

await loadPresets();

// A UV sphere, so the weld has a real seam to collapse and the proxy is not a best case.
const seg = Math.max(8, Math.round(Math.sqrt(TARGET_TRIS / 4)));
const geometry = new THREE.SphereGeometry(BALL_R, seg * 2, seg);
geometry.deleteAttribute('uv');
const tris = geometry.getIndex().count / 3;

const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
mesh.updateMatrixWorld(true);

const t0 = performance.now();
const engine = installSetB(createSculptEngine({ handOverrides: false }));
engine.setHandOverrides(false);
const handle = engine.attach(mesh, { id: 'perf' });
const buildMs = performance.now() - t0;

console.log(
  `part: ${tris.toLocaleString()} triangles -> proxy ${handle.proxy.getNbVertices().toLocaleString()} verts,`
  + ` ${handle.proxy.getNbFaces().toLocaleString()} faces   (weld + octree ${buildMs.toFixed(0)} ms)`,
);
console.log(`brush radius ${RADIUS_M * 100} cm, ${DABS} dabs, mirror X on, auto-smooth forced on\n`);

/** A dab aimed at the ball from +Z, walking across the front face. */
function dabAt(i) {
  const x = -0.05 + (0.1 * i) / (DABS - 1);
  const y = 0.01 * Math.sin((i / DABS) * Math.PI * 2);
  const origin = [x, y, 1];
  return {
    worldRay: { origin, direction: [0, 0, -1] },
    point3D: [x, y, BALL_R],
    pressure: 1,
    overlap: 1,
  };
}

const quantile = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

const rows = [];
for (const key of brushKeys()) {
  const brush = getBrush(key);
  const preset = brush.presets?.[0];
  // Force auto-smooth on for every brush that allows it, so the number is the worst honest case
  // rather than whatever the Essentials preset happens to ship.
  const settings = { ...brushSettings(preset, { overrides: false }), name: preset };
  if (!brush.noAutoSmooth) {
    settings.auto_smooth_factor = Math.max(settings.auto_smooth_factor ?? 0, 0.25);
    settings.use_inverse_smooth_pressure = false;
    settings.use_smooth_pressure = false;
  }

  engine.setBrushSettings(settings, key);
  engine.setRadiusWorld(RADIUS_M);
  engine.setPressureEnabled(false);
  engine.setSymmetry({ x: true });   // main pass + one mirror pass

  // A discarded warm-up stroke first. The very first dab on a fresh part pays for the octree
  // filling in and for V8 seeing these code paths for the first time (29 ms against a 2 ms
  // steady state for Draw), and neither is what a frame in the middle of a stroke costs.
  const run = () => {
    const costs = [];
    let moved = 0, dirty = 0;
    for (let i = 0; i < DABS; i++) {
      const t = performance.now();
      const ok = engine.applyDab({ ...dabAt(i), settings, brush }, handle);
      costs.push(performance.now() - t);
      if (ok) moved++;
    }
    const record = engine.endStroke();
    // A whole-part record drops the index array, so its size is in `after` instead.
    if (record) { dirty = record.whole ? record.after.length / 3 : (record.idx?.length ?? 0); engine.applyHistory(record, 'undo'); }
    // Mask moves no positions, so applyDab reports "nothing moved". Count what it actually did and
    // reset the channel instead (its record is a mask record, which applyHistory has just undone).
    if (brush.key === 'mask') {
      const m = handle.proxy.getMask();
      for (let i = 0; i < m.length; i++) if (m[i] > 0) { dirty++; m[i] = 0; }
      moved = DABS;
    }
    return { costs, moved, dirty };
  };
  run();
  const { costs, moved, dirty } = run();

  rows.push({
    key,
    preset,
    dabs: moved,
    median: quantile(costs, 0.5),
    p90: quantile(costs, 0.9),
    max: Math.max(...costs),
    first: costs[0],
    verts: dirty,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('brush', 14)}${pad('dabs', 6)}${pad('verts', 9)}${pad('median', 9)}${pad('p90', 9)}${pad('max', 9)}first`);
let worstMedian = 0, worstP90 = 0, worstKey = '';
for (const r of rows) {
  console.log(
    pad(r.key, 14) + pad(r.dabs, 6) + pad(r.verts.toLocaleString(), 9)
    + pad(r.median.toFixed(2), 9) + pad(r.p90.toFixed(2), 9) + pad(r.max.toFixed(2), 9) + r.first.toFixed(2),
  );
  if (r.median > worstMedian) { worstMedian = r.median; worstKey = r.key; }
  if (r.p90 > worstP90) worstP90 = r.p90;
}
console.log(`\nworst median ${worstMedian.toFixed(2)} ms (${worstKey}), worst p90 ${worstP90.toFixed(2)} ms, budget 6.00 ms`);
console.log(worstP90 <= 6 ? 'PASS: every brush is inside the frame budget at p90' : 'OVER BUDGET');
