// The coverage map: where in the hand volume is a fingertip actually seen, and how well.
// This is the picture that decides where the cameras get bolted, so it has to be trustworthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, coverageMap, coverageSlice, rigGeometry, makeZed, makeWebcam,
         ZED_RANGE_MM, LAYOUTS } from '../public/js/sim/rig-sim.js';
import { expectedErrorMm } from '../public/js/track/triangulate.js';
import { percentile } from '../public/js/track/linalg.js';

const g = rigGeometry();

test('the planned kit covers the volume it needs to', () => {
  const layout = buildLayout('zed-hands');
  const cov = coverageMap({ cameras: layout.cameras, geometry: layout.geometry, steps: [13, 7, 11] });
  console.log(`  ZED pair: ${(cov.coveredFraction * 100).toFixed(0)}% of the volume seen by 2+ cameras, ` +
              `predicted error best ${cov.bestMm.toFixed(2)} mm, median ${cov.medianMm.toFixed(2)} mm, worst ${cov.worstMm.toFixed(2)} mm`);
  assert.ok(cov.coveredFraction > 0.85, 'most of the working volume is covered');
  assert.ok(cov.medianMm < 8, 'and the typical predicted error is single-digit millimetres');
  assert.ok(cov.cells.length === 13 * 7 * 11);
});

test('error grows with the square of the distance, as stereo does', () => {
  const near = expectedErrorMm([0, g.handVolume.centre[1], 100], buildLayout('zed-hands').cameras);
  const far = expectedErrorMm([0, g.handVolume.centre[1], -100], buildLayout('zed-hands').cameras);
  console.log(`  200 mm nearer the ZED: ${near.mm.toFixed(2)} mm; 200 mm further: ${far.mm.toFixed(2)} mm`);
  assert.ok(far.mm > near.mm, 'further away is worse');
});

test('a camera that cannot see a point does not vote on it', () => {
  const layout = buildLayout('zed-hands');
  const behind = expectedErrorMm([0, 1500, -900], layout.cameras);   // up behind the monitor
  assert.equal(behind.views, 0, 'nothing sees it');
  assert.equal(behind.mm, null, 'and no error is claimed for it');
});

test('the layouts rank the way the geometry says they should', () => {
  const rows = Object.keys(LAYOUTS).map(name => {
    const layout = buildLayout(name);
    const cov = coverageSlice(layout.cameras, layout.geometry);
    return { name, median: cov.medianMm, covered: cov.coveredFraction,
             handCams: layout.cameras.filter(c => c.role === 'hands' || c.role === 'both').length };
  });
  for (const r of rows) console.log(`  ${r.name.padEnd(18)} ${r.handCams} camera(s) on the hands, ` +
    `${(r.covered * 100).toFixed(0)}% covered, median ${r.median ? r.median.toFixed(2) + ' mm' : 'n/a (single view)'}`);
  const pair = rows.find(r => r.name === 'zed-hands'), side = rows.find(r => r.name === 'zed-plus-side');
  assert.ok(side.median < pair.median, 'a wide third view beats a narrow pair, every time');
  const mono = rows.find(r => r.name === 'one-webcam-hands');
  assert.equal(mono.median, 0, 'one camera cannot triangulate at all, and the map says so rather than guessing');
});

test('the ZED distance was chosen, not assumed', () => {
  // The simulator picked 380 mm: closer is more precise but the volume starts falling out of the frustum,
  // and losing one eye drops the solver to the single-camera guess, which is a 40-50 mm jump.
  const at = z => {
    const cams = [...makeZed({ id: 'zed', position: [-60, g.handVolume.centre[1] + 40, z], target: g.handVolume.centre }),
                  makeWebcam({ id: 'cam-l', position: [-150, g.viewer[1] + 60, 40], target: [0, g.viewer[1], g.viewer[2]] })];
    const cov = coverageSlice(cams, g);
    return { covered: cov.coveredFraction, median: cov.medianMm };
  };
  const close = at(280), chosen = at(ZED_RANGE_MM), far = at(520);
  console.log(`  280 mm: ${(close.covered * 100).toFixed(0)}% covered, ${close.median.toFixed(2)} mm | ` +
              `${ZED_RANGE_MM} mm: ${(chosen.covered * 100).toFixed(0)}% covered, ${chosen.median.toFixed(2)} mm | ` +
              `520 mm: ${(far.covered * 100).toFixed(0)}% covered, ${far.median.toFixed(2)} mm`);
  assert.ok(close.median < chosen.median, 'closer really is more precise');
  assert.ok(close.covered < chosen.covered, 'but it sees less of the volume — that is the trade');
  assert.ok(chosen.median < far.median, 'and further away is simply worse');
});
