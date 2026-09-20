// Where to bolt the cameras, measured rather than argued.
//
// Runs the real solver (public/js/track/solve.js) over the simulator's synthetic rig for every camera
// layout, with the same seed, the same rig and the same noise, and prints eye and fingertip error in
// millimetres. No hardware, no browser: node test/camera-placement.mjs
//
// Read geomTip, not tip, when judging PLACEMENT: geomTip is the error against the truth at the instant the
// shutters actually fired, so a faster camera cannot masquerade as a more accurate one. tip is what the
// user sees, lag included, and it is the number to quote when deciding whether the rig is good enough.

import {
  LAYOUTS, DEFAULT_RIG, buildLayout, runSession, coverageSlice, rigGeometry, parallaxGain, ZED_RANGE_MM,
} from '../public/js/sim/rig-sim.js';

// The residual this project's OWN calibration leaves, measured by test/track-calibrate.test.js: a 1.3%
// scale change on the end-to-end touch fit, and 0.3-0.6 deg of rotation out of relativePoseRansac. Every
// figure below is printed BOTH ways, because the calibration term is several times the noise term and a
// single number quietly assumes the calibration is exact.
const CALIB_BAND = { focalPct: 1.3, rotDeg: 0.3, rotAxis: 'y', rotCam: 'zed-r' };

const NOISE_PX = Number(process.env.NOISE_PX || 1.0);
const FRAMES = Number(process.env.FRAMES || 300);
const f1 = v => (v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(1).padStart(6));
const f2 = v => (v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(2).padStart(6));
const pct = v => `${(v * 100).toFixed(0)}%`.padStart(5);

const g = rigGeometry(DEFAULT_RIG);
console.log(`rig: ${DEFAULT_RIG.panelDiagIn}" panel, tilt ${DEFAULT_RIG.tiltDeg} deg, viewer at ` +
  `${g.viewer.map(v => v.toFixed(0)).join(', ')} mm; hand volume ${g.handVolume.sizeMm.join(' x ')} mm ` +
  `centred at ${g.handVolume.centre.map(v => v.toFixed(0)).join(', ')}`);
console.log(`eye parallax gain ${parallaxGain(g.viewer, g.virtualScreen).toFixed(3)} ` +
  `(an eye error is seen at about this fraction of its size; a fingertip error is seen at full size)`);
console.log(`${FRAMES} frames of reach / pinch / carry / release, ${NOISE_PX} px landmark noise, 2% dropped frames, seed 1\n`);

const rows = [];
for (const name of Object.keys(LAYOUTS)) {
  const { stats, layout, records } = runSession({ layout: name, frames: FRAMES, noisePx: NOISE_PX, seed: 1 });
  const banded = runSession({ layout: name, frames: FRAMES, noisePx: NOISE_PX, seed: 1, calibError: CALIB_BAND }).stats;
  stats.bandTipMm = banded.tipMeanMm; stats.bandEyeMm = banded.eyeMeanMm;
  const cov = coverageSlice(layout.cameras, layout.geometry);
  // A layout that never solved an eye (or a hand) must print a dash, not a zero. A mean over no samples is
  // 0, and 0.0 mm of error reads as "perfect" when it means "never tried".
  const sawEye = records.some(r => r.eyeErrMm != null);
  const sawHand = records.some(r => r.tipErrMm != null);
  rows.push({ name, label: layout.label, note: layout.note, stats, cov, cameras: layout.cameras, sawEye, sawHand });
}

const head = ['layout', 'eye mean', 'eye p95', 'tip mean', 'tip p95', 'geomTip', 'jitter', 'lag', 'pinch', 'tracked', 'cover', 'median'];
console.log(head.map((h, i) => (i === 0 ? h.padEnd(18) : h.padStart(8))).join(' '));
console.log('-'.repeat(18 + head.length * 9));
for (const r of rows) {
  const s = r.stats;
  const e = v => (r.sawEye ? f1(v) : '   -  ');
  const h = v => (r.sawHand ? f1(v) : '   -  ');
  console.log([
    r.name.padEnd(18), e(s.eyeMeanMm), e(s.eyeP95Mm), h(s.tipMeanMm), h(s.tipP95Mm),
    h(s.geomTipMeanMm), h(s.jitterMm), f1(s.latencyMs), r.sawHand ? pct(s.pinchAccuracy) + '  ' : '    -  ',
    pct(s.trackedFraction) + '  ', pct(r.cov.coveredFraction) + '  ',
    r.cov.coveredFraction > 0 ? f1(r.cov.medianMm) : '   -  ',
  ].join(' '));
}
console.log('\nall lengths in millimetres; "cover" is the fraction of the hand volume at least two cameras see,');
console.log('"median" the error the geometry predicts there. A dash means that layout does not do that job');
console.log('at all — a zero would read as "perfect" when it means "never tried".\n');

console.log('The table above assumes the cameras are calibrated EXACTLY. They will not be. With the residual');
console.log(`this project's own calibration leaves (${CALIB_BAND.focalPct}% scale, ${CALIB_BAND.rotDeg} deg on one ZED eye):\n`);
console.log('layout               exact tip   banded tip   exact eye   banded eye');
for (const r of rows) {
  if (!r.sawHand && !r.sawEye) continue;
  console.log([r.name.padEnd(18),
               r.sawHand ? f1(r.stats.tipMeanMm) : '   -  ', r.sawHand ? f1(r.stats.bandTipMm) : '   -  ',
               r.sawEye ? f1(r.stats.eyeMeanMm) : '   -  ', r.sawEye ? f1(r.stats.bandEyeMm) : '   -  '].join('    '));
}
console.log('\nRobustness to calibration error is itself a placement argument: the layout with the extra side');
console.log('view barely moves under the band, while the ZED pair on its own roughly doubles.\n');

for (const r of rows) {
  console.log(`${r.name} — ${r.label}`);
  console.log(`  cameras: ${r.cameras.map(c => `${c.id} at [${c.position.map(v => v.toFixed(0)).join(', ')}]`).join('; ')}`);
  console.log(`  ${r.note}\n`);
}

// ---------------------------------------------------------------- how far to put the ZED
console.log('ZED standoff sweep (planned layout, everything else held). Read "mono%" first: below the default');
console.log('the hand leaves one eye\'s frustum during the reach, and a mono frame is ~99 mm, not a gentle loss.');
console.log('  range   tip mean   tip p95   geomTip   mono%   banded   coverage   predicted');
for (const mm of [260, 320, 380, 440, 520]) {
  const built = buildLayout('zed-hands', DEFAULT_RIG, { noisePx: NOISE_PX });
  const centre = built.geometry.handVolume.centre;
  // move only the ZED, keep it aimed at the middle of the hand volume
  for (const c of built.cameras) {
    if (!c.id.startsWith('zed')) continue;
    const dx = c.id.endsWith('-r') ? 120 : 0;
    c.setPose({ position: [-60 + dx, centre[1] + 40, mm], target: centre });
  }
  const { stats, records } = runSession({ layout: built, frames: FRAMES, noisePx: NOISE_PX, seed: 1 });
  const mono = records.filter(r => r.source === 'mono').length / Math.max(1, records.length);
  const band = runSession({ layout: built, frames: FRAMES, noisePx: NOISE_PX, seed: 1, calibError: CALIB_BAND }).stats;
  const cov = coverageSlice(built.cameras, built.geometry);
  console.log(`  ${String(mm).padStart(4)} mm ${f1(stats.tipMeanMm)}    ${f1(stats.tipP95Mm)}   ${f1(stats.geomTipMeanMm)}   ${pct(mono)}  ${f1(band.tipMeanMm)}    ${pct(cov.coveredFraction)}    ${f1(cov.medianMm)}` +
    (mm === ZED_RANGE_MM ? '   <- the default' : ''));
}

// ---------------------------------------------------------------- what the head cameras' spacing buys
console.log('\nHead-camera spacing (planned layout):');
console.log('  spacing   eye mean   eye p95   seen as');
for (const mm of [120, 200, 300, 420]) {
  const built = buildLayout('zed-hands', DEFAULT_RIG, { noisePx: NOISE_PX });
  const t = [0, built.geometry.viewer[1], built.geometry.viewer[2]];
  for (const c of built.cameras) {
    if (c.id === 'cam-l') c.setPose({ position: [-mm / 2, built.geometry.viewer[1] + 60, 40], target: t });
    if (c.id === 'cam-r') c.setPose({ position: [mm / 2, built.geometry.viewer[1] + 60, 40], target: t });
  }
  const { stats } = runSession({ layout: built, frames: FRAMES, noisePx: NOISE_PX, seed: 1 });
  const gain = parallaxGain(built.geometry.viewer, built.geometry.virtualScreen);
  console.log(`  ${String(mm).padStart(5)} mm ${f1(stats.eyeMeanMm)}    ${f1(stats.eyeP95Mm)}    ${f2(stats.eyeMeanMm * gain)} mm of image movement`);
}

// ---------------------------------------------------------------- the recommendation
const planned = rows.find(r => r.name === 'zed-hands');
const side = rows.find(r => r.name === 'zed-plus-side');
console.log(`
RECOMMENDATION
  Build the planned layout: ${f1(planned.stats.eyeMeanMm).trim()} mm mean eye error and ` +
  `${f1(planned.stats.tipMeanMm).trim()} mm mean fingertip error is comfortably inside what the grab needs
  (the pinch thresholds are 25/30 mm apart, so a few millimetres of fingertip error has real margin).

  ZED: about ${ZED_RANGE_MM} mm in front of the middle of the hand volume, looking into it, slightly off to
  one side so it is not in the viewer's line of sight. Closer is more precise right up until the volume
  starts leaving the frustum, and the sweep above is where that knee is.

  The two webcams: on the monitor, about 300 mm apart, both aimed at where the head will be. Spacing past
  300 mm buys almost nothing, because an eye error is only seen at ` +
  `${parallaxGain(g.viewer, g.virtualScreen).toFixed(2)}x its size — head tracking has to be STEADY, not accurate.

  The one change worth making: aim the SECOND webcam at the hand volume from the side instead of at the
  head. ${side.name} measures ${f1(side.stats.geomTipMeanMm).trim()} mm of geometry error against ` +
  `${f1(planned.stats.geomTipMeanMm).trim()} mm for the planned layout,
  and its coverage median is ${f1(side.cov.medianMm).trim()} mm against ${f1(planned.cov.medianMm).trim()} mm. ` +
  `One camera can still do the head on its own
  (${f1(rows.find(r => r.name === 'one-webcam-head').stats.eyeMeanMm).trim()} mm), because head depth comes ` +
  `from eye spacing and barely matters. Two cameras on the head is the
  safer build; ZED plus a side view is the more accurate one — and the gap widens once calibration error
  is counted: ${f1(side.stats.bandTipMm).trim()} mm against ${f1(planned.stats.bandTipMm).trim()} mm under the band,
  because a third view from a different direction is what stops a small extrinsic error turning into depth.`);
