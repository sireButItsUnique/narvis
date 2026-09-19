// What public/rigtest2.html has to get right before anybody stands in front of the rig.
//
// The page itself is a shell: the maths lives in public/js/rig/rigtest2.js (the page's own logic) on top of
// public/js/rig/geometry.js (the projection). Everything checked here is pure, so it runs under node --test
// with no browser, no WebGL and no cameras.
//
// The one that matters most is "a fixed point projects to the same monitor pixel from several eye
// positions": it is the whole claim of the page - the picture changes as you move so that the THING does
// not - and it is checked by tracing the light independently of the projection matrices, so the two ways of
// getting the answer have nothing in common but the rig.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETUP, mergeSetup, loadSetup, saveSetup, SETUP_KEY, INCH_CM, toCm, fromCm,
  rigFromSetup, monitorSizeCm, minimumSheetCm, baseYCm, rigBaseY,
  pairCameras, trackerOriginRig, eyeToRig, rigToTracker, aimPair,
  headSource, letterboxViewport, monitorUVToCanvas, predictMonitorUV, predictedScreenPos,
  screenPos, flipTransform, viewingArc, usableVolume, postLayout, postMarks, sightMark, probePoint,
  mouseEye, readoutLines,
} from '../public/js/rig/rigtest2.js';
import {
  rigCamera, virtualScreen, panelRect, rectUV, rectPoint, plane, rayPlane, reflectPoint,
  add, sub, scale, unit, dist, projectToMonitor, rigCheck,
} from '../public/js/rig/geometry.js';

const setup = () => mergeSetup(null);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// ---------------------------------------------------------------- the defaults describe THIS rig

test('the defaults describe the rig the user measured', () => {
  const s = DEFAULT_SETUP;
  assert.equal(s.rig.tiltDeg, 45, 'monitor above at 45 degrees');
  near(s.rig.monitorDropCm, 6 * INCH_CM, 1e-9, 'sheet 6 inches below the monitor');
  near(s.rig.baseDropCm, 6 * INCH_CM, 1e-9, 'black paper 6 inches below the sheet');
  near(s.pair.baselineCm, 40 * INCH_CM, 1e-9, 'webcams 40 inches apart');
  assert.equal(s.pair.heightCm, 0, 'the pair sits at sheet height, and the sheet is the rig origin');
  assert.equal(s.rig.fullScreen, true, 'the whole screen is used');
  assert.ok(s.rig.flipAxis === 'x' || s.rig.flipAxis === 'y', 'the picture is sent flipped');
  assert.deepEqual(s.trimCm, [0, 0, 0], 'no trim until the user dials one in');

  // 16:9, landscape, and the derived rig agrees with all of it
  const m = monitorSizeCm(s.rig);
  near(m.widthCm / m.heightCm, 16 / 9, 1e-9, '16:9');
  assert.ok(m.widthCm > m.heightCm, 'landscape');
  const rig = rigFromSetup(s);
  near(rig.monitor.centre[1], 6 * INCH_CM, 1e-9, 'panel centre above the sheet');
  near(rig.sheet.point[1], 0, 1e-9, 'the sheet is the origin');
  near(rigBaseY(rig), -6 * INCH_CM, 1e-9, 'the base is 6 inches under the sheet');
  near(baseYCm(s), -6 * INCH_CM, 1e-9, 'and baseYCm says the same');

  // the panel faces down and toward the viewer, or its reflection points at the ceiling
  assert.ok(panelRect(rig).normal[1] < 0, 'the panel faces down');
  assert.ok(panelRect(rig).normal[2] > 0, 'and toward the viewer');
  assert.equal(virtualScreen(rig).mirrored, true, 'one reflection, so the picture must be flipped');
});

test('the rig it builds is one you can actually sit at', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  for (const eye of viewingArc(s, 5)) {
    const c = rigCheck(rig, eye);
    assert.deepEqual(c.warnings, [], `rigCheck at eye ${eye.map(n => n.toFixed(0))}`);
  }
});

test('inches and centimetres are one stored number, so switching units cannot rescale the rig', () => {
  near(toCm(40, 'in'), 101.6, 1e-9, '40 inches');
  near(toCm(40, 'cm'), 40, 1e-9, '40 cm stays 40');
  near(fromCm(101.6, 'in'), 40, 1e-9, 'and back');
  const a = mergeSetup({ units: 'in' }), b = mergeSetup({ units: 'cm' });
  assert.deepEqual(rigFromSetup(a).monitor.centre, rigFromSetup(b).monitor.centre);
  near(pairCameras(a)[1].posCm[0], pairCameras(b)[1].posCm[0], 1e-12, 'the pair does not move either');
});

test('a saved setup from an older build opens with the new defaults filled in', () => {
  const merged = mergeSetup({ units: 'cm', pair: { baselineCm: 90 }, trimCm: [1, 2] });
  assert.equal(merged.pair.baselineCm, 90, 'what was saved wins');
  assert.equal(merged.pair.toeInDeg, DEFAULT_SETUP.pair.toeInDeg, 'what was missing is filled in');
  assert.deepEqual(merged.trimCm, [0, 0, 0], 'a malformed trim is dropped, not half-applied');
  assert.equal(merged.rig.tiltDeg, 45);

  // and it survives a round trip through a localStorage stand-in
  const store = new Map();
  const fake = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const s = setup();
  s.trimCm = [0.5, -1, 2];
  assert.equal(saveSetup(s, fake), true);
  assert.deepEqual(loadSetup(fake).trimCm, [0.5, -1, 2]);
  assert.ok(store.has(SETUP_KEY));
  assert.deepEqual(loadSetup({ getItem: () => 'not json' }).trimCm, [0, 0, 0], 'a corrupt save falls back to the defaults');
});

// ---------------------------------------------------------------- tracker space -> rig space

test('a tracker-frame eye becomes a rig-frame eye from the pair geometry and the trim', () => {
  const s = setup();
  s.pair.heightCm = -4;            // the pair slung a little under the sheet
  s.pair.depthCm = 12;             // and forward of it
  s.trimCm = [0.5, -1.5, 2];

  // the pair measures from between its own two lenses; the rig measures from the sheet centre
  assert.deepEqual(trackerOriginRig(s), [0, -4, 12]);
  assert.deepEqual(eyeToRig([0, 0, 0], s), [0.5, -5.5, 14]);
  assert.deepEqual(eyeToRig([10, 30, 40], s), [10.5, 24.5, 54]);

  // and it inverts, which is what lets the page draw a target where the tracker will see it
  const p = [3, 41, 47];
  const back = rigToTracker(p, s);
  for (let i = 0; i < 3; i++) near(eyeToRig(back, s)[i], p[i], 1e-12, 'round trip');

  // the two terms are independent: trim moves the eye, the pair's position moves the eye, nothing else does
  const noTrim = mergeSetup({ pair: s.pair });
  assert.deepEqual(eyeToRig([1, 2, 3], noTrim), [1, -2, 15]);
});

test('the cameras are placed symmetrically about the rig centre, toed in, facing the viewer', () => {
  const s = setup();
  const [L, R] = pairCameras(s);
  near(L.posCm[0], -s.pair.baselineCm / 2, 1e-12, 'left camera half a baseline to the left');
  near(R.posCm[0], s.pair.baselineCm / 2, 1e-12, 'right camera the same the other way');
  assert.deepEqual(L.posCm.slice(1), [0, 0], 'height and depth live in the tracker origin, not here');
  assert.equal(L.rotDeg[2], 180, 'a camera looking back at the viewer');
  near(L.rotDeg[1], -R.rotDeg[1], 1e-12, 'toed in symmetrically');
  assert.ok(R.rotDeg[1] > 0, 'the +X camera swings its lens toward -X, i.e. inward');
  assert.equal(L.rotDeg[0], R.rotDeg[0], 'and both tipped up by the same amount');

  // the ext handed to cameras.js has to be what stereo.js reads
  for (const c of [L, R]) {
    assert.equal(c.posCm.length, 3);
    assert.equal(c.rotDeg.length, 3);
    assert.ok(c.posCm.every(Number.isFinite) && c.rotDeg.every(Number.isFinite));
  }
});

test('aiming the pair at the head spot gives angles that really point there', () => {
  const s = setup();
  s.head.positionCm = [0, 44, 52];
  const { toeInDeg, tiltUpDeg } = aimPair(s);
  Object.assign(s.pair, { toeInDeg, tiltUpDeg });
  const [, R] = pairCameras(s);

  // rebuild the forward vector exactly the way stereo.js rotateVec does for [rx, ry, rz] on [0, 0, 1]
  const [rx, ry, rz] = R.rotDeg.map(a => a * Math.PI / 180);
  const fwd = [Math.cos(rz) * Math.sin(ry) * Math.cos(rx) + Math.sin(rz) * Math.sin(rx),
               Math.sin(rz) * Math.sin(ry) * Math.cos(rx) - Math.cos(rz) * Math.sin(rx),
               Math.cos(ry) * Math.cos(rx)];
  const from = add(R.posCm, trackerOriginRig(s));
  const want = unit(sub(s.head.positionCm, from));
  // aimPair rounds to a tenth of a degree, because the number goes straight into a field the user reads and
  // can retype; a tenth of a degree is 1.7e-3 radians, so that is the tolerance the rounding has earned.
  for (let i = 0; i < 3; i++) near(fwd[i], want[i], 2e-3, `the right camera points at the head (axis ${i})`);
});

// ---------------------------------------------------------------- the point that stays put

// An independent ray trace, written out here rather than imported, so this test does not lean on the module
// it is checking. Where does a floating point's light leave the PANEL? It must come from the panel pixel
// whose mirror image in the sheet lies on the line from the eye to the point. So: reflect a candidate panel
// point into the sheet and ask whether it is on that line - or, solved directly, reflect the EYE through the
// sheet and intersect the line from the mirrored eye to the mirrored point with the panel itself.
function tracePanelUV(rig, eye, point) {
  const sheet = plane(rig.sheet.point, rig.sheet.normal);
  const mon = panelRect(rig);
  const e = reflectPoint(sheet, eye), p = reflectPoint(sheet, point);
  const d = sub(p, e);
  const t = rayPlane(e, d, plane(mon.centre, mon.normal));
  if (t === null) return null;
  return rectUV(mon, add(e, scale(d, t)));
}

test('a fixed point in the volume lands on the SAME monitor pixel from every eye position', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const vol = usableVolume(rig, viewingArc(s, 5));
  const points = [probePoint(vol), [vol.halfX * 0.6, vol.baseY + 2, -vol.halfZ * 0.5],
                  [0, vol.baseY + vol.height / 2, 0], rig.model.anchor];

  for (const p of points) {
    for (const eye of viewingArc(s, 7, 60)) {
      const rc = rigCamera(rig, eye);
      const drawn = projectToMonitor(rig, rc, p);            // the projection the GPU will use
      const traced = tracePanelUV(rig, eye, p);              // the light, followed by hand
      assert.ok(traced, 'the light reaches the panel');
      near(drawn.u, traced.u, 1e-9, `u for ${p} from ${eye}`);
      near(drawn.v, traced.v, 1e-9, `v for ${p} from ${eye}`);

      // and the point really is where the viewer thinks it is: the panel pixel's mirror image, seen from
      // this eye, points straight back at it
      const img = reflectPoint(plane(rig.sheet.point, rig.sheet.normal),
                               rectPoint(panelRect(rig), drawn.u, drawn.v));
      const a = unit(sub(img, eye)), b = unit(sub(p, eye));
      near(dist(a, b), 0, 1e-9, 'the reconstructed ray is the ray to the point');
    }
  }
});

test('the picture moves as the eye moves, which is the entire point of the exercise', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const vol = usableVolume(rig, viewingArc(s, 5));
  const p = probePoint(vol);
  const eyes = viewingArc(s, 5, 60);
  const xs = eyes.map(e => predictMonitorUV(rig, e, p).u);
  const sweep = (Math.max(...xs) - Math.min(...xs)) * rig.monitor.pixelW;
  assert.ok(sweep > 200, `the probe point should sweep a long way across the panel, got ${sweep.toFixed(0)} px`);
  // monotonic: move your head one way and the picture moves one way
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] !== xs[i - 1], 'no dead spots along the arc');
  assert.ok(xs.every((x, i) => i === 0 || (xs[1] - xs[0] > 0 ? x > xs[i - 1] : x < xs[i - 1])), 'and it moves one way');

  // a point ON the virtual screen is the control case: it cannot move, whatever the eye does
  const onScreen = rectPoint(virtualScreen(rig), 0.42, 0.61);
  const fixed = eyes.map(e => predictMonitorUV(rig, e, onScreen));
  for (const f of fixed) { near(f.u, 0.42, 1e-9, 'u'); near(f.v, 0.61, 1e-9, 'v'); }
});

// ---------------------------------------------------------------- the flip, exactly once

test('the flip happens exactly once between the render and the glass', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const rc = rigCamera(rig, s.head.positionCm);
  assert.equal(virtualScreen(rig).reflections, 1, 'one mirror: the sheet');
  assert.equal(rc.flipX || rc.flipY, true, 'so the render must be mirrored on its way out');
  assert.equal(rc.flipX && rc.flipY, false, 'in one axis, not both');
  assert.equal(flipTransform(rc), rc.flipY ? 'scaleY(-1)' : 'scaleX(-1)');

  const vol = usableVolume(rig, viewingArc(s, 5));
  const W = 1280, H = 900;
  const vp = letterboxViewport(rig.monitor.widthCm, rig.monitor.heightCm, W, H);
  for (const p of [probePoint(vol), [0, vol.baseY + 1, 0], [vol.halfX * 0.5, vol.topY, -vol.halfZ * 0.6]]) {
    for (const eye of viewingArc(s, 5, 60)) {
      const cam = rigCamera(rig, eye, { viewport: vp });
      const drawn = screenPos(cam, p, W, H);                            // matrices, then the page's one flip
      const traced = predictedScreenPos(rig, eye, p, vp, W, H);         // the light, followed independently
      near(drawn.x, traced.x, 2e-6, 'x on the glass');
      near(drawn.y, traced.y, 2e-6, 'y on the glass');

      // and it only agrees BECAUSE of that flip: leaving it out, or doing it twice, is visibly wrong
      const unflipped = { x: W - drawn.x, y: drawn.y };
      const twice = cam.flipY ? { x: drawn.x, y: H - drawn.y } : unflipped;
      assert.ok(Math.hypot(twice.x - traced.x, twice.y - traced.y) > 20,
        'flipping twice (a page-level flip as well as the canvas one) must not accidentally agree');
    }
  }
});

test('the canvas is told which part of the panel it covers instead of stretching the picture', () => {
  const rig = rigFromSetup(setup());
  assert.equal(letterboxViewport(rig.monitor.widthCm, rig.monitor.heightCm, 1920, 1080), null,
    'a canvas the shape of the panel needs no viewport at all');
  const vp = letterboxViewport(rig.monitor.widthCm, rig.monitor.heightCm, 1280, 900);
  near(vp.v0, 0, 1e-9, 'a squarer window loses width, not height');
  near(vp.v1, 1, 1e-9);
  near((vp.u1 - vp.u0) / 1, (1280 / 900) / (rig.monitor.widthCm / rig.monitor.heightCm), 1e-9, 'aspect preserved');
  near((vp.u0 + vp.u1) / 2, 0.5, 1e-12, 'centred');

  const uv = { u: 0.5, v: 0.5 };
  const c = monitorUVToCanvas(uv, vp, 1280, 900);
  near(c.x, 640, 1e-9); near(c.y, 450, 1e-9);
  assert.equal(monitorUVToCanvas({ u: 0.01, v: 0.5 }, vp, 1280, 900).inside, false, 'outside the window it says so');
  assert.equal(monitorUVToCanvas(null, vp, 1280, 900), null);
});

// ---------------------------------------------------------------- one camera is refused, never guessed

test('a missing second camera is refused, not guessed around', () => {
  const both = { chosen: 2, cameras: 2, seeingHead: 2, eyeSource: 'stereo' };
  assert.equal(headSource(both).ok, true);

  const refusals = [
    [{ ...both, chosen: 1 }, 'need-two'],
    [{ ...both, chosen: 0 }, 'need-two'],
    [{ ...both, cameras: 1 }, 'one-camera'],
    [{ ...both, cameras: 0 }, 'one-camera'],
    [{ ...both, eyeSource: 'mono' }, 'mono'],       // cameras.js CAN do this on its own; we will not use it
    [{ ...both, eyeSource: 'legacy' }, 'waiting'],  // webcam.js, the one-camera tracker: also not a head source
    [{ ...both, seeingHead: 1 }, 'one-sees'],
    [{ ...both, seeingHead: 0 }, 'one-sees'],
    [{}, 'need-two'],
  ];
  for (const [state, reason] of refusals) {
    const r = headSource(state);
    assert.equal(r.ok, false, `must refuse ${JSON.stringify(state)}`);
    assert.equal(r.usable, false, 'and say the eye is not usable, so the page keeps the last one');
    assert.equal(r.reason, reason, JSON.stringify(state));
    assert.ok(r.message.length > 20, 'with something a tired person can act on');
  }
  // the refusals a person has to fix say WHY one camera is not enough, rather than just "no"
  for (const s of [{ ...both, chosen: 1 }, { ...both, cameras: 1 }])
    assert.match(headSource(s).message, /guess|spacing/i);
  assert.match(headSource({ ...both, cameras: 1 }).message, /mouse stand-in/i,
    'and point at the stand-in, which is labelled development only');
});

// ---------------------------------------------------------------- the test content

test('the three posts stand inside the volume and their sight marks land on the base inside it too', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const vol = usableVolume(rig, viewingArc(s, 5));
  const posts = postLayout(vol);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map(p => p.heightCm)).size, 3, 'three different heights');

  for (const p of posts) {
    assert.ok(Math.abs(p.x) <= vol.halfX + 1e-9 && Math.abs(p.z) <= vol.halfZ + 1e-9, `${p.id} stands inside`);
    near(p.foot[1], vol.baseY, 1e-12, `${p.id} stands ON the base`);
    near(p.top[1], vol.baseY + p.heightCm, 1e-12, `${p.id} top`);
    assert.ok(p.heightCm < vol.height, `${p.id} fits under the sheet`);
  }

  const eyes = viewingArc(s, 3, 60);
  const marks = postMarks(posts, eyes, vol.baseY);
  assert.equal(marks.length, 9, 'three posts times three named viewing spots');
  for (const m of marks) {
    near(m.at[1], vol.baseY, 1e-9, 'a mark is painted on the base');
    assert.ok(Math.abs(m.at[0]) <= vol.halfX && Math.abs(m.at[2]) <= vol.halfZ,
      `mark ${m.post}/${m.label} at ${m.at.map(n => n.toFixed(1))} has to be somewhere we can draw`);
  }
  assert.deepEqual([...new Set(marks.map(m => m.label))], ['L', 'C', 'R']);
  // an eye level with, or below, a post top has no mark: the line never reaches the base, and drawing a
  // cross at the far end of a ray that misses would be a confident lie
  assert.equal(sightMark([0, -10, 0], [0, -10, 40], -15), null, 'level');
  assert.equal(sightMark([0, -10, 0], [0, -18, 40], -15), null, 'looking up at it');

  // the claim the marks make: stand at that spot and the post's top covers its cross
  for (const m of marks) {
    const post = posts.find(p => p.id === m.post);
    const a = unit(sub(post.top, m.eye)), b = unit(sub(m.at, m.eye));
    near(dist(a, b), 0, 1e-9, `${m.post} top covers its ${m.label} cross from the ${m.label} spot`);
    // and from a different spot it does NOT, or the check would pass for a broken rig
    const other = eyes.find(e => e[0] !== m.eye[0]);
    const c = unit(sub(m.at, other));
    assert.ok(dist(unit(sub(post.top, other)), c) > 0.02, 'and misses it from anywhere else');
  }
});

test('the usable volume is the part of the air that is drawable from the whole arc', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const eyes = viewingArc(s, 5);
  const vol = usableVolume(rig, eyes);
  assert.ok(vol.halfX > 3 && vol.halfZ > 2, `a volume worth putting a model in, got ${JSON.stringify(vol)}`);
  near(vol.baseY, rigBaseY(rig), 1e-12, 'it sits on the base');
  assert.ok(vol.topY <= 0, 'and stops under the sheet');

  for (const eye of eyes) {
    const rc = rigCamera(rig, eye);
    for (const x of [-vol.halfX, vol.halfX]) for (const z of [-vol.halfZ, vol.halfZ]) for (const y of [vol.baseY, vol.topY])
      assert.equal(projectToMonitor(rig, rc, [x, y, z]).inside, true,
        `corner ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} from eye ${eye.map(n => n.toFixed(0))}`);
  }
  // a box 40% bigger would not be: the search really is finding a limit, not a constant
  const rc = rigCamera(rig, eyes[0]);
  const big = [vol.halfX * 1.4, vol.topY, vol.halfZ * 1.4];
  assert.equal(projectToMonitor(rig, rc, big).inside, false, 'and it is the LARGEST such box, near enough');
});

test('the viewing arc is a 60 cm sweep at head height, centred on where the head sits', () => {
  const s = setup();
  const eyes = viewingArc(s, 5, 60);
  assert.equal(eyes.length, 5);
  for (const e of eyes) near(e[1], s.head.positionCm[1], 1e-12, 'head height');
  const r = Math.hypot(s.head.positionCm[0], s.head.positionCm[2]);
  for (const e of eyes) near(Math.hypot(e[0], e[2]), r, 1e-9, 'a swing about the rig, not a slide');
  const swept = Math.abs(Math.atan2(eyes[4][0], eyes[4][2]) - Math.atan2(eyes[0][0], eyes[0][2])) * r;
  near(swept, 60, 1e-9, '60 cm of ARC');
  near(dist(eyes[0], eyes[4]), 2 * r * Math.sin(60 / r / 2), 1e-9, 'and the chord that implies, which is shorter');
  assert.deepEqual(viewingArc(s, 1)[0].map(n => Math.round(n)), s.head.positionCm.map(n => Math.round(n)));
});

test('the sheet is sized from the sight cone, so the default rig does not greet you with a warning', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const need = minimumSheetCm(rig, viewingArc(s, 7));
  assert.ok(rig.sheet.widthCm >= need.widthCm - 1e-6 && rig.sheet.depthCm >= need.depthCm - 1e-6,
    `built sheet ${rig.sheet.widthCm}x${rig.sheet.depthCm} must cover the needed ${need.widthCm}x${need.depthCm}`);
  // a sheet the user measured is used as given, warning or not: it is their acrylic, not ours
  const mine = mergeSetup({ rig: { sheetWidthCm: 30, sheetDepthCm: 20 } });
  assert.equal(rigFromSetup(mine).sheet.widthCm, 30);
  assert.ok(rigCheck(rigFromSetup(mine), mine.head.positionCm).warnings.length > 0, 'and it says the sheet is small');
});

// ---------------------------------------------------------------- the mouse stand-in

test('the mouse stand-in sweeps the eye across the arc, and is never mistaken for tracking', () => {
  const s = setup();
  const mid = mouseEye(0.5, 0.5, s);
  assert.deepEqual(mid, s.head.positionCm);
  const left = mouseEye(0, 0.5, s), right = mouseEye(1, 0.5, s);
  near(left[0], s.head.positionCm[0] - s.head.sweepXCm, 1e-12, 'full left');
  near(right[0], s.head.positionCm[0] + s.head.sweepXCm, 1e-12, 'full right');
  near(right[0] - left[0], 2 * s.head.sweepXCm, 1e-12, 'a 60 cm sweep by default');
  near(mouseEye(0.5, 0, s)[1], s.head.positionCm[1] + s.head.sweepYCm, 1e-12, 'up the screen is up');
  near(mouseEye(0.5, 1, s)[1], s.head.positionCm[1] - s.head.sweepYCm, 1e-12);
  assert.equal(mouseEye(0.2, 0.3, s)[2], s.head.positionCm[2], 'depth is left alone: the mouse has none');

  // it is a stand-in, not a head source: headSource() knows nothing about it and still refuses
  assert.equal(headSource({ chosen: 2, cameras: 1, seeingHead: 1, eyeSource: 'none' }).ok, false);
});

test('the readout says where the eye is, where the trim is and what is wrong', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  s.trimCm = [0.5, 0, -1];
  const lines = readoutLines({
    setup: s, rig, eyeRig: [1, 40, 45], source: headSource({ chosen: 2, cameras: 2, seeingHead: 2, eyeSource: 'stereo' }),
    status: { solver: 'track/solve.js triangulate',
              sources: [{ seesHead: true, views: [{ fps: 30, latencyMs: 42 }] }, { seesHead: false, views: [{ fps: 29, latencyMs: 51 }] }] },
    fps: 58.7, check: rigCheck(rig, [1, 40, 45]), mouse: true,
  });
  const text = lines.join('\n');
  assert.match(text, /eye  rig/);
  assert.match(text, /MOUSE STAND-IN, not tracking/, 'the stand-in is labelled in the readout too');
  assert.match(text, /trim .*tracker origin/, 'and the trim says what it trims');
  assert.match(text, /cameras 2/);
  assert.match(text, /30 fps 42 ms/, 'per-camera fps and latency');
  assert.match(text, /59 fps/, 'render fps');
  assert.match(text, /track\/solve\.js/, 'and which triangulator the pair is actually going through');
});
