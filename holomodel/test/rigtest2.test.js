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
  pairCameras, pairAngles, trackerOriginRig, eyeToRig, rigToTracker, aimPair, aimCheck, convergeRig,
  AIM_TOLERANCE_DEG, headSource, STEREO_GRACE_MS, letterboxViewport, monitorUVToCanvas,
  predictMonitorUV, predictedScreenPos, screenPos, flipTransform, overlayFlip, viewingArc, usableVolume,
  postLayout, postMarks, sightMark, probePoint, mouseEye, readoutLines, bannerFor, hardWarnings,
} from '../public/js/rig/rigtest2.js';
import {
  rigCamera, virtualScreen, panelRect, rectUV, rectPoint, plane, rayPlane, reflectPoint,
  add, sub, scale, unit, dot, cross, dist, projectToMonitor, rigCheck,
} from '../public/js/rig/geometry.js';
import { mergePrefs } from '../public/js/input/devices.js';
import { viewsForCamera, triangulate, residualCm } from '../public/js/input/stereo.js';
import { focalPxFromDiagFov } from '../public/js/input/devices.js';

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

// ---------------------------------------------------------------- the defaults have to agree with THEMSELVES

// A forward projection written out here rather than imported, so this does not check stereo.js with
// stereo.js. world = Rz*Ry*Rx * cam + posCm, so cam = R^T (world - posCm); then a pinhole.
function rotRows([rx, ry, rz]) {
  const [a, b, c] = [rx, ry, rz].map(d => d * Math.PI / 180);
  const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
  return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
          [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
          [-sy, cy * sx, cy * cx]];
}
function projectInto(cam, pointTracker, W, H, f) {
  const M = rotRows(cam.rotDeg), d = sub(pointTracker, cam.posCm);
  const z = M[0][2] * d[0] + M[1][2] * d[1] + M[2][2] * d[2];
  if (z <= 0) return null;                       // behind the lens
  const x = M[0][0] * d[0] + M[1][0] * d[1] + M[2][0] * d[2];
  const y = M[0][1] * d[0] + M[1][1] * d[1] + M[2][1] * d[2];
  return [(f * x / z + W / 2) / W, (f * y / z + H / 2) / H];
}
// The pair as cameras.js really builds it, so the extrinsics under test are the ones that ship.
function pairViews(s, cameras = pairCameras(s)) {
  const W = 1280, H = 720, f = focalPxFromDiagFov(W, H, s.pair.dfovDeg);
  const intr = { fx: f, fy: f, cx: W / 2, cy: H / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  return cameras.map(c => ({ cam: c, W, H, f, intr,
    view: viewsForCamera({ width: W, height: H, sbs: false, calib: null, intr,
                           ext: { posCm: c.posCm, rotDeg: c.rotDeg }, label: c.side })[0] }));
}

test('the shipped pair angles aim at the shipped head spot, and go on doing it when the rig is remeasured', () => {
  // The defaults used to ship 14 / 12 with a 40-inch baseline and a head 45 cm away: three numbers that
  // cannot all be true. Nothing compared them, and the tracker decoded that head 159 cm too far away.
  const s = setup();
  const used = pairAngles(s), aimed = aimPair(s);
  near(used.toeInDeg, aimed.toeInDeg, 0.1, 'the toe-in in use aims at the head spot');
  near(used.tiltUpDeg, aimed.tiltUpDeg, 0.1, 'and so does the tilt');
  assert.equal(aimCheck(s).ok, true, 'and the page agrees with itself about it');
  assert.equal(used.manual, false, 'nobody typed these: they are derived');

  // the angles really do point at the head: both optical axes cross the centre line there
  const at = convergeRig(s);
  for (let i = 0; i < 3; i++) near(at[i], s.head.positionCm[i], 0.5, `the lenses meet at the head (axis ${i})`);

  // and they FOLLOW the measurements, which is the part that was missing: editing the baseline or the seat
  // used to leave the old angles behind, and the page shipped in exactly that state.
  for (const patch of [{ pair: { baselineCm: 60 } }, { head: { positionCm: [0, 30, 70] } },
                       { pair: { depthCm: 15 } }, { pair: { heightCm: -8 } }]) {
    const t = mergeSetup({ ...s, pair: { ...s.pair, ...(patch.pair || {}) },
                           head: { ...s.head, ...(patch.head || {}) } });
    assert.equal(aimCheck(t).ok, true, `re-aimed after ${JSON.stringify(patch)}`);
    const met = convergeRig(t);
    for (let i = 0; i < 3; i++) near(met[i], t.head.positionCm[i], 0.6, 'still meeting at the head');
  }

  // a saved setup from before the angles were derived does not drag its stale pair forward
  const old = mergeSetup({ version: 2, pair: { toeInDeg: 14, tiltUpDeg: 12 } });
  assert.equal(aimCheck(old).ok, true, 'version 2 angles are dropped, not inherited');
  // but an angle the user really typed is kept, and the disagreement is reported rather than silently fixed
  const typed = mergeSetup({ version: 3, pair: { toeInDeg: 14, tiltUpDeg: 12, aimManual: true } });
  const bad = aimCheck(typed);
  assert.equal(bad.ok, false, 'a typed 14/12 on this baseline is still wrong');
  assert.ok(bad.missCm > 100, `and it says how wrong: ${bad.missCm.toFixed(0)} cm`);
  assert.match(bad.message, /48\.5|work the angles out/i, 'and what the right answer is');
  assert.ok(Math.abs(bad.dToe) > AIM_TOLERANCE_DEG, 'beyond the tolerance a degree of toe error earns');
});

test('a head at the seat lands in the middle of both pictures, and decodes back to where it started', () => {
  const s = setup();
  const vs = pairViews(s);
  // step 1 has the user aim each camera at their own face, so the face must actually be near frame centre
  for (const { cam, W, H, f } of vs) {
    const uv = projectInto(cam, s.head.positionCm, W, H, f);
    assert.ok(uv, 'the head is in front of the lens at all');
    near(uv[0], 0.5, 0.02, `${cam.side} sees the head across the middle`);
    near(uv[1], 0.5, 0.02, `${cam.side} sees the head up the middle`);
  }
  // and the round trip: pixels in, the same head out, for heads all over the viewing arc
  for (const head of [...viewingArc(s, 5, 60), [12, 40, 45], [-10, 46, 52], [0, 34, 60]]) {
    const rays = vs.map(({ cam, view, W, H, f }) => {
      const uv = projectInto(cam, head, W, H, f);
      return uv && view.ray(uv[0], uv[1]);
    });
    assert.ok(rays.every(Boolean), `both cameras see a head at ${head}`);
    const p = triangulate(rays);
    for (let i = 0; i < 3; i++) near(p[i], head[i], 0.05, `decoded head axis ${i} from ${head}`);
    assert.ok(residualCm(p, rays) < 0.05, 'and the two rays really met');
  }
});

// ---------------------------------------------------------------- two cameras with the same name

test('two webcams of the same model get two poses, and the eye still moves', () => {
  // Chromium builds MediaDeviceInfo.label from the driver's friendly name plus vid:pid, with no
  // uniquifier, so the rig's two Logitechs are the SAME string. Keying anything by label collapses them
  // onto one entry; both cameras then get one camera's pose, both view origins coincide, and the normal
  // equations return that origin for any pair of pixels - a rock-steady eye sitting on a lens, reported
  // as healthy stereo tracking. That is the exact failure rigtest2 exists to detect.
  const label = 'HD Pro Webcam C920 (046d:082d)';
  const devList = [{ deviceId: 'id-A', groupId: 'g-A', label }, { deviceId: 'id-B', groupId: 'g-B', label }];
  const s = setup();
  const pc = pairCameras(s);
  const camKey = d => d.deviceId;                       // what the page does now
  const prefs = {}, ext = {};
  devList.forEach((d, i) => {
    prefs[camKey(d)] = { key: { deviceId: d.deviceId, label: d.label, groupId: d.groupId },
                         role: 'head', dfovDeg: s.pair.dfovDeg };
    ext[camKey(d)] = { posCm: pc[i].posCm, rotDeg: pc[i].rotDeg };
  });
  assert.equal(Object.keys(prefs).length, 2, 'two cameras, two pref entries');

  const merged = mergePrefs(prefs, devList);
  assert.notEqual(merged[0].prefKey, merged[1].prefKey, 'and two prefKeys, whatever the labels say');
  const W = 1280, H = 720, f = focalPxFromDiagFov(W, H, s.pair.dfovDeg);
  const intr = { fx: f, fy: f, cx: W / 2, cy: H / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
  const views = merged.map(d => viewsForCamera({ width: W, height: H, sbs: false, calib: null, intr,
                                                 ext: ext[d.prefKey], label: d.label })[0]);
  const gap = dist(views[0].origin, views[1].origin);
  near(gap, s.pair.baselineCm, 1e-6, 'the two lenses are a whole baseline apart, not zero');

  // the eye has to MOVE when the head does, which is the thing the collapse silently killed
  const seen = [];
  for (const head of [[-20, 40, 45], [0, 40, 45], [20, 40, 45]]) {
    const rays = pc.map((cam, i) => {
      const uv = projectInto(cam, head, W, H, f);
      return uv && views[i].ray(uv[0], uv[1]);
    });
    const p = triangulate(rays);
    for (let k = 0; k < 3; k++) near(p[k], head[k], 0.05, 'decoded head');
    seen.push(p);
  }
  assert.ok(dist(seen[0], seen[2]) > 35, `the eye travels with the head, got ${dist(seen[0], seen[2]).toFixed(1)} cm`);

  // the old label key really did collapse them: two cameras, ONE entry, and whichever was written last
  const collapsed = {};
  for (const d of devList) collapsed[d.label] = prefs[d.deviceId];
  assert.equal(Object.keys(collapsed).length, 1, 'keyed by label the two cameras are one entry');
  // and even handed that, matching now refuses to give both devices the same entry - which is the second
  // half of the fix, because the page alone could not have closed it: matchSaved's label fallback used to
  // let the first entry win before any later entry's exact deviceId match was tried.
  const sameMerged = mergePrefs(collapsed, devList);
  assert.notEqual(sameMerged[0].prefKey, sameMerged[1].prefKey, 'no two devices share one entry, ever');
  assert.ok(sameMerged.filter(d => d.pref).length <= 1, 'the single entry is claimed once, not twice');
});

test('a pair configured in one place, or whose rays miss, is refused instead of believed', () => {
  const live = { chosen: 2, cameras: 2, seeingHead: 2, msSinceStereo: 0 };
  const same = headSource({ ...live, eyeSource: 'bad-extrinsics' });
  assert.equal(same.ok, false); assert.equal(same.usable, false);
  assert.equal(same.reason, 'same-place');
  assert.match(same.message, /same place/i);
  assert.match(same.message, /same model|share a name|one at a time/i, 'and says why the names lie');

  const miss = headSource({ ...live, eyeSource: 'bad-rays', residualCm: 7.9, swapHint: true });
  assert.equal(miss.reason, 'rays-miss');
  assert.match(miss.message, /7\.9 cm/, 'with the number on it');
  assert.match(miss.message, /wrong way round/i, 'and the likeliest cause named');
  assert.match(headSource({ ...live, eyeSource: 'bad-rays', residualCm: 5, swapHint: false }).message,
    /baseline|angles/i, 'or the next likeliest, when a swap is not it');

  // an eye nowhere near the seat is not a head, whatever the rays did
  const far = headSource({ ...live, eyeSource: 'stereo', eyeRig: [0, 45, 204], headRig: [0, 40, 45] });
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'implausible');
  assert.match(far.message, /159 cm/, 'and says how far off it is');
  assert.equal(headSource({ ...live, eyeSource: 'stereo', eyeRig: [18, 44, 52], headRig: [0, 40, 45] }).ok, true,
    'a head that has simply moved along the arc is still a head');
});

test('one dropped frame holds the eye still; it does not throw the red panel into the volume', () => {
  const live = { chosen: 2, cameras: 2, seeingHead: 2 };
  const blink = headSource({ ...live, eyeSource: 'mono', msSinceStereo: 120 });
  assert.equal(blink.ok, true, 'no banner for a blink');
  assert.equal(blink.usable, false, 'but the guessed eye is still not used');
  assert.equal(blink.reason, 'blink');
  assert.equal(blink.message, '', 'and nothing is said');

  const gone = headSource({ ...live, eyeSource: 'mono', msSinceStereo: STEREO_GRACE_MS + 1 });
  assert.equal(gone.ok, false, 'a real loss is still refused');
  assert.equal(gone.reason, 'mono');
  assert.ok(STEREO_GRACE_MS >= 300 && STEREO_GRACE_MS <= 1000, 'a grace a person would not notice');
  // the grace never lets a guess through: usable is true for stereo and nothing else
  for (const src of ['mono', 'legacy', 'none', 'bad-rays', 'bad-extrinsics'])
    assert.equal(headSource({ ...live, eyeSource: src, msSinceStereo: 0 }).usable, false, src);
});

// ---------------------------------------------------------------- the words on the glass

test('the flip axis cannot change the hologram, so the text flip is worked out from the optics instead', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const vol = usableVolume(rig, viewingArc(s, 5));
  // 1. the two axes draw the SAME picture: they differ by a 180 degree roll that the matching flip cancels
  for (const eye of viewingArc(s, 5, 60)) {
    for (const p of [probePoint(vol), [0, vol.baseY + 1, 0], rig.model.anchor]) {
      const x = screenPos(rigCamera(rig, eye, { flipAxis: 'x' }), p, 1280, 720);
      const y = screenPos(rigCamera(rig, eye, { flipAxis: 'y' }), p, 1280, 720);
      near(x.x, y.x, 1e-6, 'x on the glass is the same either way');
      near(x.y, y.y, 1e-6, 'and so is y');
    }
  }

  // 2. so which way the TEXT is mirrored has to come from the rig. Read a line of text through the sheet:
  //    CSS reading direction is +u on the panel, glyph-up is -v.
  const readable = (transform, eye) => {
    const V = virtualScreen(rig);
    const U = unit(sub(V.tr, V.tl)), Vd = unit(sub(V.bl, V.tl));
    let read = [1, 0], up = [0, -1];                       // (u, v) components
    if (transform === 'scaleX(-1)') { read = [-read[0], read[1]]; up = [-up[0], up[1]]; }
    if (transform === 'scaleY(-1)') { read = [read[0], -read[1]]; up = [up[0], -up[1]]; }
    const world = ([a, b]) => unit(add(scale(U, a), scale(Vd, b)));
    const fwd = unit(sub(V.centre, eye));
    const vUp = unit(sub([0, 1, 0], scale(fwd, dot(fwd, [0, 1, 0]))));
    return { reads: dot(world(read), cross(fwd, vUp)), stands: dot(world(up), vUp) };
  };
  // A viewer at the end of the arc reads the glass at an angle, so "upright" is a sign question, not a
  // question of being within a few degrees of perfect: 0.5 is comfortably past 60 degrees of lean.
  const READS = 0.5;
  for (const eye of viewingArc(s, 3, 60)) {
    const chosen = overlayFlip(rig, eye);
    const r = readable(chosen, eye);
    assert.ok(r.reads > READS && r.stands > READS,
      `overlayFlip picked ${chosen || '(none)'}, which reads ${r.reads.toFixed(2)} / stands ${r.stands.toFixed(2)}`);
    // and it is the ONLY choice that reads: the axis is not a free parameter here
    for (const other of ['', 'scaleX(-1)', 'scaleY(-1)'].filter(t => t !== chosen)) {
      const o = readable(other, eye);
      assert.ok(!(o.reads > READS && o.stands > READS), `${other || '(none)'} must not also be readable`);
    }
  }
  assert.equal(overlayFlip(rig, s.head.positionCm), 'scaleY(-1)', 'on THIS rig the inverted axis is v');

  // 3. the panel mounted the other way up IS a different picture, unlike the flip axis: that is the real
  //    thing a person at the rig can be wrong about, and it is what X now toggles.
  const upside = rigFromSetup(mergeSetup({ rig: { ...s.rig, rot180: true } }));
  const a = predictMonitorUV(rig, s.head.positionCm, probePoint(vol));
  const b = predictMonitorUV(upside, s.head.positionCm, probePoint(vol));
  assert.ok(Math.hypot(a.u - b.u, a.v - b.v) > 0.05, 'rot180 really moves the picture');
});

// ---------------------------------------------------------------- an empty answer says so

test('a volume with nothing in it says which of the two faults it is', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const eyes = viewingArc(s, 5);
  const full = usableVolume(rig, eyes);
  assert.equal(full.empty, false, 'the real rig, full screen, is not empty');
  assert.equal(full.reason, null);
  assert.equal(full.message, '');

  // a short wide window (devtools docked at the bottom, or an ultrawide) collapses it
  const vp = letterboxViewport(rig.monitor.widthCm, rig.monitor.heightCm, 1400, 400);
  const thin = usableVolume(rig, eyes, { viewport: vp });
  assert.equal(thin.empty, true, 'and it really does collapse: that is the reported behaviour');
  assert.equal(thin.reason, 'window-shape', 'the RIG is fine; this window cannot show it');
  assert.match(thin.message, /fullscreen|maximise/i, 'so it says what to do about the window');
  assert.ok(thin.message.length > 40, 'in words, not just a zero');

  // rig numbers that leave nothing drawable are a different fault and get different advice
  for (const patch of [{ tiltDeg: 0 }, { monitorDiagIn: 10 }]) {
    const broken = rigFromSetup(mergeSetup({ rig: { ...s.rig, ...patch } }));
    const v = usableVolume(broken, eyes);
    assert.equal(v.empty, true, JSON.stringify(patch));
    assert.equal(v.reason, 'rig-numbers', 'no window would help');
    assert.match(v.message, /tilt|diagonal|step 3/i, 'so it points at the numbers, not the window');
  }
});

test('the banner says the thing that has to be fixed first', () => {
  const s = setup();
  const rig = rigFromSetup(s);
  const empty = usableVolume(rig, viewingArc(s, 5),
    { viewport: letterboxViewport(rig.monitor.widthCm, rig.monitor.heightCm, 1400, 400) });
  const ok = usableVolume(rig, viewingArc(s, 5));
  const refused = headSource({ chosen: 2, cameras: 2, seeingHead: 2, eyeSource: 'mono' });
  const badAim = aimCheck(mergeSetup({ version: 3, pair: { toeInDeg: 14, tiltUpDeg: 12, aimManual: true } }));

  // nothing drawn at all outranks everything: no other message can be acted on through a black screen
  assert.match(bannerFor({ volume: empty, source: refused, aim: badAim }).title, /Nothing can be drawn/);
  // the hard rigCheck warnings used to reach only the readout, which starts hidden
  const hard = bannerFor({ volume: ok, warnings: ['The eye is under the sheet.',
    '2 of 4 image corners reflect off the edge of the sheet; make the sheet bigger or move the monitor.'] });
  assert.equal(hard.kind, 'bad');
  assert.match(hard.text, /under the sheet/);
  assert.ok(!/sheet bigger/.test(hard.text), 'and only the hard ones: the soft advice stays in the readout');
  assert.equal(hardWarnings(['make the sheet bigger']).length, 0);

  // the aim mismatch beats the head-source refusal, because it CAUSES it
  assert.match(bannerFor({ volume: ok, aim: badAim, source: refused }).title, /camera angles/i);
  assert.match(bannerFor({ volume: ok, aim: aimCheck(s), source: refused }).title, /Head tracking is not running/);
  assert.equal(bannerFor({ volume: ok, aim: aimCheck(s),
    source: headSource({ chosen: 2, cameras: 2, seeingHead: 2, eyeSource: 'stereo' }) }), null,
    'and a working rig says nothing at all: every lit pixel is a ghost in the volume');
  // the mouse stand-in is not a fault, but it does not hide a broken rig either
  assert.equal(bannerFor({ volume: ok, aim: aimCheck(s), source: refused, mouse: true }), null);
  assert.match(bannerFor({ volume: empty, aim: aimCheck(s), source: refused, mouse: true }).title, /Nothing can be drawn/);
});
