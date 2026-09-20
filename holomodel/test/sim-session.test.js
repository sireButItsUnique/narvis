// The whole thing end to end: synthetic rig -> synthetic cameras -> the real solver -> millimetres.
// These are the numbers to quote, and they are all printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RIG, rigGeometry, buildLayout, runSession, coverageSlice, compareLayouts, summarize,
         offAxisFrustum, parallaxGain, handPose, truthAt, eyePoints, LAYOUTS } from '../public/js/sim/rig-sim.js';
import { HAND } from '../public/js/track/landmarks.js';
import { dist, mean } from '../public/js/track/linalg.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

test('the rig geometry is the rig the user described', () => {
  const g = rigGeometry();
  // A 24 inch 16:9 panel: 531 x 299 mm. Portrait, so 299 wide and 531 tall.
  near(g.panel.widthMm, 298.9, 1, 'portrait width is the panel short side');
  near(g.panel.heightMm, 531.4, 1, 'portrait height is the panel long side');
  // The active area is the full width by 75% of the height, which is 4:3 in portrait (3 wide : 4 tall).
  near(g.active.widthMm, g.panel.widthMm, 1e-9, 'active area uses the full short side');
  near(g.active.heightMm, g.panel.heightMm * 0.75, 1e-9, 'and 75% of the long side');
  near(g.active.heightMm / g.active.widthMm, 4 / 3, 0.01, 'which is a 4:3 portrait rectangle');
  console.log(`  panel ${g.panel.widthMm.toFixed(0)}x${g.panel.heightMm.toFixed(0)} mm portrait, ` +
              `active area ${g.active.widthMm.toFixed(0)}x${g.active.heightMm.toFixed(0)} mm (${(g.active.heightMm / g.active.widthMm).toFixed(2)}:1)`);

  // The floating image is the active area mirrored in the sheet, so it hangs below it where the hands are.
  assert.ok(g.screen.centre[1] > 0, 'the real screen is above the sheet');
  assert.ok(g.virtualScreen.centre[1] < 0, 'the floating image is below it');
  near(g.virtualScreen.centre[1], -g.screen.centre[1], 1e-9, 'and exactly as far below as the screen is above');
  near(dist(g.virtualScreen.topLeft, [g.screen.bottomLeft[0], -g.screen.bottomLeft[1], g.screen.bottomLeft[2]]), 0, 1e-9,
    'corners mirror, and top/bottom swap because a mirror flips the image');
  assert.ok(g.handVolume.centre[1] < 0, 'the hands work under the sheet');
});

test('the off-axis frustum follows the eye and stays asymmetric', () => {
  const g = rigGeometry();
  const centred = offAxisFrustum(g.virtualScreen.centre.map((v, i) => v + [0, 400, 600][i]), g.virtualScreen);
  assert.ok(centred, 'a frustum was produced');
  // Looking straight on, left and right are symmetric; stepping sideways makes them not.
  near(centred.left + centred.right, 0, 1e-6, 'symmetric when centred');
  const offset = offAxisFrustum(g.virtualScreen.centre.map((v, i) => v + [200, 400, 600][i]), g.virtualScreen);
  assert.ok(Math.abs(offset.left + offset.right) > 0.5, 'and asymmetric when the head moves across');
  console.log(`  centred frustum L/R ${centred.left.toFixed(2)}/${centred.right.toFixed(2)}, ` +
              `stepped 200 mm across ${offset.left.toFixed(2)}/${offset.right.toFixed(2)}`);

  // Why head tracking has to be steady rather than accurate.
  const gain = parallaxGain([0, 260, 520], g.virtualScreen, 150);
  console.log(`  a 20 mm eye error moves the floating image by ${(20 * gain).toFixed(1)} mm (gain ${gain.toFixed(2)})`);
  assert.ok(gain < 0.5, 'an eye error is seen at well under full size');
});

test('the synthetic hand is anatomically sane and its pinch closes', () => {
  const open = handPose({ centre: [0, -200, 0], pinch01: 1 });
  const shut = handPose({ centre: [0, -200, 0], pinch01: 0 });
  const gap = p => dist(p[HAND.THUMB_TIP], p[HAND.INDEX_TIP]);
  console.log(`  thumb-to-index: open ${gap(open).toFixed(0)} mm, pinched ${gap(shut).toFixed(0)} mm ` +
              `(threshold ${25} mm in / ${30} mm out)`);
  assert.ok(gap(open) > 60, 'an open hand is nowhere near a pinch');
  assert.ok(gap(shut) < 20, 'a closed pinch is well inside the threshold');
  near(dist(open[HAND.WRIST], open[HAND.MIDDLE_MCP]), 85, 8, 'wrist to middle knuckle is adult-hand sized');
  assert.equal(open.filter(Boolean).length, 21, 'all 21 landmarks exist');
});

test('a 300-frame session: eye under 5 mm and fingertip under 3 mm', () => {
  const { stats, records } = runSession({ layout: 'zed-hands', frames: 300, hz: 60, seed: 5,
                                          noisePx: 1.0, dropRate: 0.02 });
  console.log(`  ${stats.frames} frames, ${(stats.trackedFraction * 100).toFixed(0)}% tracked, source ${stats.source}`);
  console.log(`  eye      mean ${stats.eyeMeanMm.toFixed(2)} mm   p95 ${stats.eyeP95Mm.toFixed(2)} mm   max ${stats.eyeMaxMm.toFixed(2)} mm`);
  console.log(`  fingertip mean ${stats.tipMeanMm.toFixed(2)} mm   p95 ${stats.tipP95Mm.toFixed(2)} mm   max ${stats.tipMaxMm.toFixed(2)} mm`);
  console.log(`  pinch point mean ${stats.gripMeanMm.toFixed(2)} mm  (unfiltered fingertip ${stats.rawTipMeanMm.toFixed(2)} mm)`);
  console.log(`  frame-to-frame jitter ${stats.jitterMm.toFixed(2)} mm, pinch state correct ${(stats.pinchAccuracy * 100).toFixed(1)}% of frames`);
  // The worst frame is always the first: until the second head camera has fired there is only one view, so
  // the eye comes from the single-camera guess. It settles within a few frames and it is worth seeing.
  const settled = summarize(records.slice(10));
  console.log(`  after the first 10 frames: eye max ${settled.eyeMaxMm.toFixed(2)} mm, fingertip max ${settled.tipMaxMm.toFixed(2)} mm ` +
              `(frame 0-9 includes the single-camera startup, eye ${Math.max(...records.slice(0, 10).map(r => r.eyeErrMm || 0)).toFixed(0)} mm)`);
  assert.ok(settled.eyeMaxMm < 12, `no steady-state eye spike (${settled.eyeMaxMm.toFixed(1)} mm)`);

  assert.ok(stats.trackedFraction > 0.9, `the hand was tracked in ${(stats.trackedFraction * 100).toFixed(0)}% of frames`);
  assert.ok(stats.eyeMeanMm < 5, `eye error ${stats.eyeMeanMm.toFixed(2)} mm must be under 5 mm`);
  assert.ok(stats.tipMeanMm < 3, `fingertip error ${stats.tipMeanMm.toFixed(2)} mm must be under 3 mm`);
  assert.ok(stats.pinchAccuracy > 0.9, `pinch state agreed with the truth in ${(stats.pinchAccuracy * 100).toFixed(0)}% of frames`);
  // Filtering must help, not just look smooth.
  assert.ok(stats.tipMeanMm < stats.rawTipMeanMm, 'the 3D filter reduces error rather than adding lag for nothing');
  assert.ok(records.some(r => r.pinch), 'the hand did pinch at some point');
});

test('one webcam still works, just worse — the app degrades instead of breaking', () => {
  const mono = runSession({ layout: 'one-webcam-hands', frames: 200, hz: 30, seed: 5, noisePx: 1.0 }).stats;
  const head = runSession({ layout: 'one-webcam-head', frames: 200, hz: 30, seed: 5, noisePx: 1.0 }).stats;
  const stereo = runSession({ layout: 'zed-hands', frames: 200, hz: 60, seed: 5, noisePx: 1.0 }).stats;
  console.log(`  one webcam on the hands: fingertip ${mono.tipMeanMm.toFixed(1)} mm (${mono.source}), tracked ${(mono.trackedFraction * 100).toFixed(0)}%`);
  console.log(`  one webcam on the head:  eye ${head.eyeMeanMm.toFixed(1)} mm (${head.quality || 'mono'})`);
  console.log(`  the planned kit:         fingertip ${stereo.tipMeanMm.toFixed(1)} mm, eye ${stereo.eyeMeanMm.toFixed(1)} mm`);
  assert.equal(mono.source, 'mono', 'the single-camera path really is the one being used');
  assert.ok(mono.trackedFraction > 0.8, 'it keeps tracking');
  assert.ok(mono.tipMeanMm > stereo.tipMeanMm * 2, 'and it is clearly worse, which is the honest result');
  // Head-only with one camera: depth comes from eye spacing, so it is worse than a pair but still usable,
  // and it is the half of the job that matters most if only one camera can be had.
  assert.ok(head.eyeMeanMm < 40, `single-camera eye error ${head.eyeMeanMm.toFixed(1)} mm`);
});

test('the ZED SDK bridge lands in the same place as the local path', () => {
  const { stats } = runSession({ layout: 'zed-bridge', frames: 200, hz: 60, seed: 3, latencyMs: 35 });
  console.log(`  bridge: fingertip ${stats.tipMeanMm.toFixed(2)} mm, eye ${stats.eyeMeanMm.toFixed(2)} mm, ` +
              `latency ${stats.latencyMs.toFixed(0)} ms, source ${stats.source}`);
  assert.equal(stats.source, 'bridge');
  assert.ok(stats.tipMeanMm < 25, 'already-3D input still lands near the truth');
  assert.ok(stats.eyeMeanMm < 5, 'and the head is still solved locally from the two webcams');
});

test('unsynchronised shutters bend the geometry, and lining the frames up in time fixes most of it', () => {
  // GEOMETRY error only here (against the truth at the instant the cameras fired), so that pipeline lag
  // does not muddy the comparison.
  const run = (unsyncZed, overrides, handSpeed) =>
    runSession({ layout: 'zed-hands', frames: 250, seed: 8, handSpeed, unsyncZed, overrides }).stats;
  const WAIT = { interpolate: true, extrapolateMs: 0 }, NAIVE = { interpolate: false };
  for (const handSpeed of [1, 3]) {
    const synced = run(false, WAIT, handSpeed);
    const naive = run(true, NAIVE, handSpeed);
    const lined = run(true, WAIT, handSpeed);
    console.log(`  hand speed x${handSpeed}: one exposure ${synced.geomTipMeanMm.toFixed(2)} mm | ` +
                `free-running eyes, newest frame each ${naive.geomTipMeanMm.toFixed(2)} mm | ` +
                `free-running, lined up in time ${lined.geomTipMeanMm.toFixed(2)} mm`);
    assert.ok(naive.geomTipMeanMm > synced.geomTipMeanMm, 'free-running eyes cost accuracy');
    assert.ok(lined.geomTipMeanMm < naive.geomTipMeanMm, 'interpolating to a common instant wins it back');
  }
  const fast = run(true, NAIVE, 3), slow = run(true, NAIVE, 1);
  console.log(`  the cost of losing sync grows with speed: ${slow.geomTipMeanMm.toFixed(2)} mm at x1 -> ` +
              `${fast.geomTipMeanMm.toFixed(2)} mm at x3 — which is why the hands go on the ZED (one ` +
              `exposure for both eyes) and only the slow-moving head goes on two free-running webcams`);
  assert.ok(fast.geomTipMeanMm > slow.geomTipMeanMm, 'and it is worse the faster the hand moves');
});

test('once there are three cameras, latency is the error — not geometry', () => {
  // The finding that decides how frames are reconciled. Waiting for the slowest camera gives the best
  // possible geometry and the WORST total error, because the user sees the answer late. Pulling the
  // laggards forward instead trades a little geometry for a lot of lag, and wins outright.
  const run = (overrides, handSpeed) =>
    runSession({ layout: 'zed-plus-side', frames: 300, seed: 5, handSpeed, overrides }).stats;
  for (const handSpeed of [1, 2]) {
    const wait = run({ interpolate: true, extrapolateMs: 0 }, handSpeed);
    const pull = run({ interpolate: true, extrapolateMs: 20 }, handSpeed);
    console.log(`  hand x${handSpeed} — wait for the slowest: geometry ${wait.geomTipMeanMm.toFixed(2)} mm, ` +
                `lag ${wait.sampleLagMs.toFixed(0)} ms, what the user sees ${wait.tipMeanMm.toFixed(2)} mm`);
    console.log(`            pull laggards forward: geometry ${pull.geomTipMeanMm.toFixed(2)} mm, ` +
                `lag ${pull.sampleLagMs.toFixed(0)} ms, what the user sees ${pull.tipMeanMm.toFixed(2)} mm`);
    assert.ok(wait.geomTipMeanMm < pull.geomTipMeanMm, 'waiting really does give better geometry');
    assert.ok(pull.tipMeanMm < wait.tipMeanMm, 'and still loses, because latency is the bigger error');
    assert.ok(pull.sampleLagMs < wait.sampleLagMs, 'which is exactly the lag it saves');
  }
});

test('a third view of the hand volume is the biggest single win on geometry', () => {
  const cov = {};
  for (const name of ['zed-hands', 'zed-plus-side']) {
    const layout = buildLayout(name);
    cov[name] = coverageSlice(layout.cameras, layout.geometry);
  }
  console.log(`  predicted error across the volume: ZED pair ${cov['zed-hands'].medianMm.toFixed(2)} mm median, ` +
              `with a side view ${cov['zed-plus-side'].medianMm.toFixed(2)} mm ` +
              `(coverage ${(cov['zed-hands'].coveredFraction * 100).toFixed(0)}% -> ${(cov['zed-plus-side'].coveredFraction * 100).toFixed(0)}%)`);
  assert.ok(cov['zed-plus-side'].medianMm < cov['zed-hands'].medianMm,
    'a wide third view beats a narrow pair');

  // And the running solver delivers what the static map promises, which is the check that matters: a
  // prediction nobody verifies is just a drawing.
  const pair = runSession({ layout: 'zed-hands', frames: 300, seed: 5 }).stats;
  const three = runSession({ layout: 'zed-plus-side', frames: 300, seed: 5,
                             overrides: { extrapolateMs: 0 } }).stats;
  console.log(`  and the solver delivers it: geometry error ${pair.geomTipMeanMm.toFixed(2)} mm with two views ` +
              `-> ${three.geomTipMeanMm.toFixed(2)} mm with three (predicted ${cov['zed-plus-side'].medianMm.toFixed(2)} mm)`);
  assert.ok(three.geomTipMeanMm < pair.geomTipMeanMm / 2, 'the third view more than halves the geometry error');
  assert.ok(three.geomTipMeanMm < cov['zed-plus-side'].medianMm * 2.5, 'and it lands near what was predicted');
});

test('every layout runs, and the comparison table is printed', () => {
  const rows = compareLayouts({ frames: 150, hz: 60, seed: 4 });
  console.log('  layout                fingertip   eye      tracked  coverage');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(20)} ${r.stats.tipMeanMm.toFixed(2).padStart(7)} mm ` +
                `${r.stats.eyeMeanMm.toFixed(2).padStart(6)} mm ` +
                `${(r.stats.trackedFraction * 100).toFixed(0).padStart(6)}% ` +
                `${(r.coverage.median ? r.coverage.median.toFixed(2) : '  -').padStart(8)} mm`);
    assert.ok(r.stats.frames === 150, `${r.name} produced frames`);
  }
  assert.equal(rows.length, Object.keys(LAYOUTS).length);
});
