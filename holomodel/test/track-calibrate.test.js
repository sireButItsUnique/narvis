// Calibration: recovering a known relative pose from noisy correspondences, the similarity fit to the rig
// frame, the spread guard, bundle adjustment, and the save/export path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCamera, PinholeCamera } from '../public/js/track/camera.js';
import { relativePoseRansac, umeyamaFit, umeyamaRansac, applySimilarity, invertSimilarity,
         spreadCheck, bundleAdjust, decomposeEssential, essentialFrom8Point, sampsonError,
         makeCalibration, saveCalibration, loadCalibration, exportCalibration, importCalibration,
         calibrationReport, calibrationCameras, fitRigFromTouches } from '../public/js/track/calibrate.js';
import { dist, matVec, transpose, sub, add, scale, norm, normalize, rodrigues, mean, mulberry32, gaussian,
         matMul, dot } from '../public/js/track/linalg.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);
const angleBetweenDeg = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))))) * 180 / Math.PI;
// Angle of the rotation that takes A to B — how far apart two orientations are.
function rotationErrorDeg(A, B) {
  const D = matMul(A, transpose(B));
  const c = Math.min(1, Math.max(-1, (D[0] + D[4] + D[8] - 1) / 2));
  return Math.acos(c) * 180 / Math.PI;
}

function scatter(rng, n, centre, spread) {
  return Array.from({ length: n }, () => centre.map((c, i) => c + (rng() - 0.5) * spread[i]));
}

test('the essential matrix recovers a known relative pose from noisy correspondences', () => {
  const rng = mulberry32(3);
  const a = makeCamera({ id: 'a', position: [-150, 200, 400], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  const b = makeCamera({ id: 'b', position: [150, 190, 380], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  // A fingertip waved through the volume: the correspondences are one moving point over time.
  const pts = scatter(rng, 60, [0, -100, 0], [300, 250, 250]);
  const pairs = [];
  for (const p of pts) {
    const pa = a.project(p), pb = b.project(p);
    if (!pa.inFrame || !pb.inFrame) continue;
    pairs.push({ a: { u: pa.u + gaussian(rng) * 0.7, v: pa.v + gaussian(rng) * 0.7 },
                 b: { u: pb.u + gaussian(rng) * 0.7, v: pb.v + gaussian(rng) * 0.7 } });
  }
  assert.ok(pairs.length > 30, `enough usable pairs (${pairs.length})`);
  const sol = relativePoseRansac(a, b, pairs, { thresholdPx: 2 });
  assert.ok(sol, 'a solution was found');

  // Truth: the rotation from a to b, and the direction of b's centre seen from a.
  // X_b = R X_a + t, so R = R_b R_a^T and t = R_b (C_a - C_b) — in camera B's axes, not A's.
  const Rtrue = matMul(b.R, transpose(a.R));
  const tTrue = matVec(b.R, sub(a.position, b.position));     // direction only; scale is not observable
  console.log(`  inliers ${sol.inliers.length}/${pairs.length}, sampson ${sol.sampsonRmsPx.toFixed(2)} px, ` +
              `rotation off by ${rotationErrorDeg(sol.R, Rtrue).toFixed(2)} deg, ` +
              `baseline direction off by ${Math.min(angleBetweenDeg(sol.t, tTrue), angleBetweenDeg(scale(sol.t, -1), tTrue)).toFixed(2)} deg`);
  assert.ok(sol.inlierRatio > 0.8, `inlier ratio ${sol.inlierRatio}`);
  assert.ok(rotationErrorDeg(sol.R, Rtrue) < 2, 'rotation recovered');
  const tErr = Math.min(angleBetweenDeg(sol.t, tTrue), angleBetweenDeg(scale(sol.t, -1), tTrue));
  assert.ok(tErr < 3, `baseline direction recovered (${tErr} deg)`);
  near(norm(sol.t), 1, 1e-9, 'translation comes back as a unit vector: scale is unobservable');
});

test('a fingertip waved in one plane is refused, not answered badly', () => {
  const rng = mulberry32(21);
  const a = makeCamera({ id: 'a', position: [-150, 200, 400], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  const b = makeCamera({ id: 'b', position: [150, 190, 380], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  const Rtrue = matMul(b.R, transpose(a.R));
  // A lemniscate traced in a plane, with a controllable amount of motion OUT of that plane. The 8-point
  // algorithm is degenerate on coplanar points and fails silently: the pose comes back tens of degrees
  // wrong with a Sampson RMS that looks exactly like a good fit, so the diagnostics cannot be trusted and
  // the degeneracy has to be tested for.
  const wave = (depthMm) => {
    const pairs = [];
    for (let i = 0; i < 160; i++) {
      const s = (i / 160) * Math.PI * 2;
      const p = [140 * Math.sin(2 * s), -100 + 110 * Math.sin(s), depthMm * Math.sin(3 * s)];
      const pa = a.project(p), pb = b.project(p);
      if (!pa.inFrame || !pb.inFrame) continue;
      pairs.push({ a: { u: pa.u + gaussian(rng) * 0.7, v: pa.v + gaussian(rng) * 0.7 },
                   b: { u: pb.u + gaussian(rng) * 0.7, v: pb.v + gaussian(rng) * 0.7 } });
    }
    return pairs;
  };
  const flat = relativePoseRansac(a, b, wave(0), { thresholdPx: 2 });
  console.log(`  flat wave: ok=${flat.ok}${flat.ok ? `, rotation off by ${rotationErrorDeg(flat.R, Rtrue).toFixed(1)} deg` : `, refused: ${flat.reason}`}`);
  assert.equal(flat.ok, false, 'a coplanar wave is refused');
  assert.equal(flat.degenerate, true);
  assert.match(flat.reason, /plane/);
  // ...and the same gesture with real depth in it still solves.
  const deep = relativePoseRansac(a, b, wave(90), { thresholdPx: 2 });
  assert.equal(deep.ok, true, `90 mm of out-of-plane motion solves (${deep.reason || ''})`);
  const err = rotationErrorDeg(deep.R, Rtrue);
  console.log(`  90 mm out of plane: rotation off by ${err.toFixed(2)} deg, ${deep.inliers.length} inliers`);
  assert.ok(err < 3, `rotation recovered (${err.toFixed(2)} deg)`);
  // and the refusal reaches the user rather than sitting in a return value nobody reads
  const rep = calibrationReport({ triangulationMm: 4, relativePose: flat });
  assert.equal(rep.poseDegenerate, true);
  assert.ok(rep.warnings.some(w => /plane/.test(w)), rep.warnings.join(' | '));
});

test('gross outliers do not move the essential-matrix answer', () => {
  const rng = mulberry32(11);
  const a = makeCamera({ id: 'a', position: [-150, 200, 400], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  const b = makeCamera({ id: 'b', position: [150, 190, 380], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 });
  const pairs = [];
  for (const p of scatter(rng, 70, [0, -100, 0], [300, 250, 250])) {
    const pa = a.project(p), pb = b.project(p);
    if (!pa.inFrame || !pb.inFrame) continue;
    pairs.push({ a: { u: pa.u, v: pa.v }, b: { u: pb.u, v: pb.v } });
  }
  const clean = relativePoseRansac(a, b, pairs, { thresholdPx: 2 });
  for (let i = 0; i < 8; i++) pairs[i * 4].b.u += 120 + rng() * 200;       // a fifth of the matches are wrong
  const dirty = relativePoseRansac(a, b, pairs, { thresholdPx: 2 });
  console.log(`  with ${8} bad matches in ${pairs.length}: ${dirty.inliers.length} inliers, ` +
              `rotation drift ${rotationErrorDeg(dirty.R, clean.R).toFixed(2)} deg`);
  assert.ok(rotationErrorDeg(dirty.R, clean.R) < 1.5, 'RANSAC held the line');
});

test('Umeyama recovers a known rotation, translation and scale', () => {
  const rng = mulberry32(5);
  const R = rodrigues([0.2, -0.45, 0.1]), t = [120, -35, 80], s = 1.037;
  const src = scatter(rng, 12, [0, 0, 0], [400, 300, 300]);
  const dst = src.map(p => add(scale(matVec(R, p), s), t));
  const fit = umeyamaFit(src, dst);
  near(fit.scale, s, 1e-9, 'scale');
  near(dist(fit.t, t), 0, 1e-6, 'translation');
  near(rotationErrorDeg(fit.R, R), 0, 1e-4, 'rotation');
  near(fit.rmsMm, 0, 1e-6, 'residual on exact data');

  // With scale locked off, a 3.7% scale error must show up as a residual rather than be hidden.
  const rigid = umeyamaFit(src, dst, { withScale: false });
  assert.ok(rigid.rmsMm > 5, `a rigid fit cannot absorb the scale (${rigid.rmsMm.toFixed(1)} mm)`);
  console.log(`  similarity residual ${fit.rmsMm.toExponential(1)} mm vs rigid ${rigid.rmsMm.toFixed(1)} mm`);
});

test('the similarity inverse round trips', () => {
  const tr = { R: rodrigues([0.3, 0.2, -0.1]), t: [10, -20, 30], scale: 1.2 };
  const inv = invertSimilarity(tr);
  for (const p of [[0, 0, 0], [100, -50, 25]]) near(dist(applySimilarity(inv, applySimilarity(tr, p)), p), 0, 1e-9);
});

test('a bad touch is thrown out by RANSAC', () => {
  const rng = mulberry32(9);
  const R = rodrigues([0.05, 0.3, -0.02]), t = [15, 200, -60];
  const src = scatter(rng, 10, [0, 0, 0], [300, 200, 250]);
  const dst = src.map(p => add(matVec(R, p), t));
  dst[4] = add(dst[4], [70, -60, 55]);                  // the user touched the wrong spot once
  const plain = umeyamaFit(src, dst), robust = umeyamaRansac(src, dst, { thresholdMm: 12 });
  console.log(`  with one bad touch: plain fit ${plain.rmsMm.toFixed(1)} mm, RANSAC ${robust.rmsMm.toFixed(2)} mm`);
  assert.ok(robust.rmsMm < plain.rmsMm / 3, 'RANSAC is much tighter');
  assert.ok(robust.outliers.includes(4), 'and it names the bad point');
});

test('clustered calibration points are refused before they can lie', () => {
  const rng = mulberry32(13);
  const spread = scatter(rng, 8, [0, -150, 0], [300, 200, 200]);
  const clustered = scatter(rng, 8, [0, -150, 0], [40, 30, 30]);
  assert.equal(spreadCheck(spread).ok, true);
  const bad = spreadCheck(clustered);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /spread them/);
  console.log(`  spread points: smallest axis ${spreadCheck(spread).minAxisMm.toFixed(0)} mm; ` +
              `clustered: ${bad.minAxisMm.toFixed(0)} mm`);
});

test('bundle adjustment pulls a disturbed camera back to where it belongs', () => {
  const rng = mulberry32(17);
  const truth = [
    makeCamera({ id: 'c0', position: [-200, 150, 400], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 }),
    makeCamera({ id: 'c1', position: [200, 150, 400], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 }),
    makeCamera({ id: 'c2', position: [0, 320, 120], target: [0, -100, 0], fovDeg: 78, width: 1920, height: 1080 }),
  ];
  const pts = scatter(rng, 25, [0, -100, 0], [280, 220, 220]);
  const observations = [];
  for (let ci = 0; ci < truth.length; ci++) for (let pi = 0; pi < pts.length; pi++) {
    const q = truth[ci].project(pts[pi]);
    if (!q.inFrame) continue;
    observations.push({ cam: ci, point: pi, u: q.u + gaussian(rng) * 0.3, v: q.v + gaussian(rng) * 0.3 });
  }
  // c0 and c1 are the two ZED eyes: their relative pose comes from the factory file, so both are anchored,
  // which is also what removes the scale gauge. Only c2 and the points are unknown.
  const start = truth.map((c, i) => c.clone({ id: c.id }));
  start[2].position = add(start[2].position, [gaussian(rng) * 25, gaussian(rng) * 25, gaussian(rng) * 25]);
  start[2].R = matMul(rodrigues([gaussian(rng) * 0.025, gaussian(rng) * 0.025, gaussian(rng) * 0.025]), start[2].R);
  const startPts = pts.map(p => add(p, [gaussian(rng) * 20, gaussian(rng) * 20, gaussian(rng) * 20]));
  const posErrBefore = dist(start[2].position, truth[2].position);

  const out = bundleAdjust({ cameras: start, points: startPts, observations, fixed: [0, 1], iterations: 40 });
  const posErrAfter = dist(out.cameras[2].position, truth[2].position);
  const ptErr = mean(out.points.map((p, i) => dist(p, pts[i])));
  console.log(`  reprojection ${out.before.toFixed(1)} px -> ${out.rmsPx.toFixed(2)} px in ${out.iterations} iterations; ` +
              `free camera ${posErrBefore.toFixed(1)} mm -> ${posErrAfter.toFixed(1)} mm; points ${ptErr.toFixed(1)} mm`);
  assert.ok(out.rmsPx < 1, `reprojection came down to ${out.rmsPx} px`);
  assert.ok(posErrAfter < posErrBefore / 5, 'the free camera moved back to where it belongs');
  assert.ok(ptErr < 3, 'and the points are metric, because two cameras were anchored');
});

test('touch calibration puts triangulated points into the rig frame', () => {
  const rng = mulberry32(23);
  // The cameras believe they are in a frame that is rotated, shifted and 2% off scale from the rig.
  const wrong = { R: rodrigues([0.03, 0.12, -0.02]), t: [40, 90, -25], scale: 1.02 };
  const cams = [makeCamera({ id: 'L', position: [-60, 120, 320], target: [0, -150, 0], fovDeg: 110, width: 1280, height: 720 }),
                makeCamera({ id: 'R', position: [60, 120, 320], target: [0, -150, 0], fovDeg: 110, width: 1280, height: 720 })];
  const targets = [[-120, -80, -90], [120, -80, -90], [-120, -80, 90], [120, -80, 90],
                   [-120, -220, -90], [120, -220, -90], [-120, -220, 90], [120, -220, 90]];
  const touches = targets.map(expected => {
    const seen = applySimilarity(wrong, expected);        // where the cameras actually see that fingertip
    const jitter = [gaussian(rng) * 3, gaussian(rng) * 3, gaussian(rng) * 3];   // the user's own touch error
    const p = add(seen, jitter);
    return { expected, views: cams.map(c => { const q = c.project(p); return { camId: c.id, u: q.u, v: q.v }; }) };
  });
  const out = fitRigFromTouches({ cameras: cams, touches });
  assert.ok(out.ok, 'a fit was produced');
  assert.equal(out.spread.ok, true, 'the touched points are well spread');
  console.log(`  ${out.count} touches -> ${out.report.headline}, scale ${out.fit.scale.toFixed(4)}`);
  assert.ok(out.fit.rmsMm < 8, `residual ${out.fit.rmsMm} mm is about the size of the touch error`);
  near(out.fit.scale, 1 / wrong.scale, 0.02, 'the scale error is absorbed');
  assert.equal(out.report.grade, 'good');
});

test('a calibration saves, exports, imports and refuses a foreign file', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v),
                    removeItem: k => store.delete(k) };
  const cams = [makeCamera({ id: 'zed-l', position: [0, 100, 300], target: [0, -150, 0], fovDeg: 110 })];
  const calib = makeCalibration({ cameras: cams, ipdMm: 64.5, notes: 'bench',
                                  report: calibrationReport({ touchFit: { rmsMm: 5.2, maxMm: 8, scale: 1.0 } }) });
  assert.equal(saveCalibration(calib, storage), true);
  const back = loadCalibration(storage);
  assert.equal(back.ipdMm, 64.5);
  assert.equal(back.report.grade, 'good');
  const rebuilt = calibrationCameras(back);
  near(dist(rebuilt[0].position, cams[0].position), 0, 1e-9, 'camera pose survives the round trip');
  near(rebuilt[0].fx, cams[0].fx, 1e-9, 'and so do the intrinsics');
  const again = importCalibration(exportCalibration(calib));
  assert.equal(again.notes, 'bench');
  assert.throws(() => importCalibration('{"version":99,"cameras":[]}'), /version/);
  // A missing localStorage (Node, or a private window) must not throw.
  assert.equal(loadCalibration(undefined), null);
  assert.equal(saveCalibration(calib, undefined), false);
});

test('the report warns when the two calibration routes disagree', () => {
  const r = calibrationReport({ touchFit: { rmsMm: 18, maxMm: 22, scale: 1.0 }, crossCheckMm: 14,
                                bundle: { rmsPx: 5 } });
  assert.equal(r.grade, 'poor');
  assert.equal(r.warnings.length, 2);
  assert.match(r.headline, /18\.0 mm/);
});
