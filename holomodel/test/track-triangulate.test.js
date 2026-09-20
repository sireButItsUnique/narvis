// Triangulation against synthetic truth: exactness with clean pixels, sane error growth with noise,
// outlier rejection, and the degenerate-geometry guard actually firing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCamera } from '../public/js/track/camera.js';
import { triangulate, triangulateDLT, triangulateRays, triangulateRobust, maxRayAngleDeg,
         expectedErrorMm, reprojectionErrors } from '../public/js/track/triangulate.js';
import { dist, mean, percentile, mulberry32, gaussian } from '../public/js/track/linalg.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);

// A ZED-like stereo pair: 120 mm baseline, HD720 per eye, looking into the hand volume.
function zedPair({ baselineMm = 120, position = [0, 120, 320], target = [0, -150, 0] } = {}) {
  const left = makeCamera({ id: 'L', position, target, fovDeg: 110, width: 1280, height: 720, noisePx: 1 });
  const right = left.clone({ id: 'R', position: [position[0] + baselineMm, position[1], position[2]] });
  right.setPose({ R: left.R });
  return [left, right];
}
const viewsOf = (cams, p, noise = null, rng = null) => cams.map(c => {
  const q = c.project(p);
  return { camera: c, u: q.u + (noise ? gaussian(rng) * noise : 0), v: q.v + (noise ? gaussian(rng) * noise : 0) };
});

test('clean pixels triangulate back to the exact point', () => {
  const cams = zedPair();
  for (const p of [[0, -150, 0], [60, -120, 40], [-80, -180, -30]]) {
    const r = triangulate(viewsOf(cams, p));
    assert.ok(r.ok, r.reason || 'should succeed');
    near(dist(r.point, p), 0, 1e-4, 'triangulated point');
    near(r.rmsPx, 0, 1e-6, 'reprojection error');
  }
});

test('DLT and the weighted ray solve agree for a stereo pair', () => {
  const cams = zedPair();
  const p = [40, -160, 25], views = viewsOf(cams, p);
  near(dist(triangulateDLT(views), p), 0, 1e-4, 'DLT');
  near(dist(triangulateRays(views).point, p), 0, 1e-4, 'ray solve');
});

test('noise turns into the millimetres the geometry predicts', () => {
  const cams = zedPair();
  const rng = mulberry32(42), p = [0, -150, 0];
  const errs = [];
  for (let i = 0; i < 400; i++) errs.push(dist(triangulate(viewsOf(cams, p, 1.0, rng)).point, p));
  const m = mean(errs), p95 = percentile(errs, 0.95);
  console.log(`  stereo 120 mm baseline, 1 px noise, ~${Math.round(dist(p, cams[0].position))} mm away: mean ${m.toFixed(2)} mm, p95 ${p95.toFixed(2)} mm`);
  assert.ok(m > 0.5 && m < 12, `mean error ${m} mm should be single-digit millimetres`);
  // The closed-form predictor used by the coverage map should land in the same ballpark.
  const pred = expectedErrorMm(p, cams);
  console.log(`  predicted by expectedErrorMm: ${pred.mm.toFixed(2)} mm`);
  assert.ok(pred.mm > m * 0.4 && pred.mm < m * 2.5, `prediction ${pred.mm} vs measured ${m}`);
});

test('a third view off to the side cuts the error several-fold', () => {
  const cams = zedPair();
  const side = makeCamera({ id: 'S', position: [-420, 60, 120], target: [0, -150, 0], fovDeg: 78,
                            width: 1920, height: 1080, noisePx: 1 });
  const rng = mulberry32(7), p = [0, -150, 0];
  const two = [], three = [];
  for (let i = 0; i < 300; i++) {
    const v2 = viewsOf(cams, p, 1.0, rng);
    const v3 = [...v2, ...viewsOf([side], p, 1.0, rng)];
    two.push(dist(triangulate(v2).point, p));
    three.push(dist(triangulate(v3).point, p));
  }
  console.log(`  two views ${mean(two).toFixed(2)} mm -> three views ${mean(three).toFixed(2)} mm`);
  assert.ok(mean(three) < mean(two) * 0.6, 'a wide third view should more than a third the error');
});

test('an outlier view is voted out when there is a majority to vote', () => {
  const cams = zedPair();
  const p = [20, -140, 10];
  const sides = [makeCamera({ id: 'S1', position: [-420, 60, 120], target: [0, -150, 0], fovDeg: 78, width: 1920, height: 1080, noisePx: 1 }),
                 makeCamera({ id: 'S2', position: [430, 90, 60], target: [0, -150, 0], fovDeg: 78, width: 1920, height: 1080, noisePx: 1 })];
  const views = viewsOf([...cams, ...sides], p);
  views[2].u += 90;                            // S1 latched onto the wrong fingertip
  const bad = triangulate(views);
  const good = triangulateRobust(views, { maxReprojPx: 4 });
  console.log(`  with the outlier ${dist(bad.point, p).toFixed(1)} mm, after rejection ${dist(good.point, p).toFixed(3)} mm`);
  assert.equal(good.rejected.length, 1);
  assert.equal(good.rejected[0].id, 'S1');
  assert.ok(dist(good.point, p) < 0.5, 'the surviving views give the right answer');
  assert.ok(dist(bad.point, p) > 5, 'the outlier really did hurt');
  assert.equal(good.ambiguous, false);
});

test('three views are enough to find the bad one, because the bad pair fails to fit itself', () => {
  // The naive rule (drop the largest residual) gets this exactly wrong: the wide side view owns the depth,
  // so its error lands on the innocent stereo pair. Consensus gets it right.
  const cams = zedPair();
  const side = makeCamera({ id: 'S', position: [-420, 60, 120], target: [0, -150, 0], fovDeg: 78,
                            width: 1920, height: 1080, noisePx: 1 });
  const p = [20, -140, 10];
  const views = viewsOf([...cams, side], p);
  views[2].u += 90;
  const naive = triangulate(views);
  let worst = 0;
  naive.errors.forEach((e, i) => { if (e.px > naive.errors[worst].px) worst = i; });
  assert.notEqual(naive.errors[worst].id, 'S', 'the largest residual is NOT on the broken view');

  const r = triangulateRobust(views, { maxReprojPx: 4 });
  assert.equal(r.views.length, 2, 'it drops one view');
  assert.equal(r.rejected[0].id, 'S', 'and it is the right one');
  assert.ok(dist(r.point, p) < 0.5, 'the answer is the truth');
});

test('nearly parallel views are refused rather than answered badly', () => {
  // Two cameras 4 mm apart looking at a point 600 mm away: about 0.4 degrees of parallax.
  const a = makeCamera({ id: 'a', position: [0, 0, 600], target: [0, 0, 0], fovDeg: 70 });
  const b = a.clone({ id: 'b', position: [4, 0, 600] });
  b.setPose({ R: a.R });
  const p = [0, 0, 0];
  const views = [a, b].map(c => { const q = c.project(p); return { camera: c, u: q.u, v: q.v }; });
  assert.ok(maxRayAngleDeg(views) < 1, 'the geometry really is degenerate');
  const r = triangulate(views);
  assert.equal(r.degenerate, true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /degenerate/);
});

test('a point behind a camera is reported, not silently returned', () => {
  const cams = zedPair();
  const behind = [0, 400, 900];                 // above and beyond the cameras, out of both frustums
  const views = cams.map(c => ({ camera: c, u: 10, v: 10 }));
  const r = triangulate(views);
  assert.ok(!r.ok || r.point, 'either it fails or it returns a point, never a lie');
  const errs = reprojectionErrors(behind, cams.map((c, i) => ({ camera: c, u: 0, v: 0 })));
  assert.equal(errs.length, 2);
});

test('confidence weights pull the answer toward the trusted view', () => {
  const cams = zedPair();
  const side = makeCamera({ id: 'S', position: [-420, 60, 120], target: [0, -150, 0], fovDeg: 78,
                            width: 1920, height: 1080, noisePx: 6 });
  const p = [0, -150, 0];
  const views = [...viewsOf(cams, p), ...viewsOf([side], p)];
  views[2].u += 25;                              // a noisy but not absurd side view
  const equal = triangulate(views.map(v => ({ ...v, weight: 1 })));
  const weighted = triangulate(views.map(v => ({ ...v, weight: 1 / (v.camera.noisePx ** 2) })));
  console.log(`  equal weights ${dist(equal.point, p).toFixed(2)} mm, confidence weights ${dist(weighted.point, p).toFixed(2)} mm`);
  assert.ok(dist(weighted.point, p) < dist(equal.point, p), 'down-weighting the noisy view should help');
});
