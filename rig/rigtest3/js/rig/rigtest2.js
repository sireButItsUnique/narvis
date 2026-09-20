// SPDX-License-Identifier: GPL-3.0-or-later
// The logic behind public/rigtest2.html: rigtest showed that something appears under the sheet; rigtest2
// has to make it look SOLID from different angles, which means drawing every frame from where the viewer's
// eye actually is.
//
// Everything here is pure: no DOM, no WebGL, no three.js, so test/rigtest2.test.js can check the geometry
// without a browser. The page is the thin shell around it. The projection itself is NOT here - that is
// rig/geometry.js (Kooima off-axis through the monitor's mirror image), which this only feeds and checks.
//
// Frames, and there are three, so they are named every time:
//   RIG      centimetres, origin at the centre of the acrylic sheet, +X the viewer's right, +Y up,
//            +Z toward the viewer. rig/geometry.js works in this. The base (black paper) is at -baseDropCm.
//   TRACKER  what the stereo pair measures: same axes, origin at the MIDPOINT between the two webcams.
//            The pair is mounted level and symmetric about the rig centre, so the two frames differ by a
//            translation only - which is why eyeToRig() is a shift and not a pose fit.
//   MONITOR  pixel fractions u (from the left) and v (DOWN from the top) of the whole panel.
//
// The head comes from the two webcams and nothing else. Single-webcam head tracking guesses depth from the
// spacing of the eyes in the image; the user has dropped it, and headSource() below refuses rather than
// quietly substituting it, because a depth guess that is 4 cm out moves the hologram several centimetres
// and reads as "the rig is broken", not "the tracker is guessing".

import {
  makeRig, rigCamera, projectPoint, virtualScreen, plane, rayPlane, rectUV,
  add, sub, scale, v3, dot, cross, unit, DEG,
} from './geometry.js';

export const INCH_CM = 2.54;
export const toCm = (value, units) => units === 'in' ? value * INCH_CM : value;
export const fromCm = (cm, units) => units === 'in' ? cm / INCH_CM : cm;
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

// ---------------------------------------------------------------- the setup
// Lengths are stored in CENTIMETRES whatever the user typed; `units` only says how to show them, so a
// switch between inches and cm can never quietly rescale the rig.
//
// The defaults ARE this rig, as the user measured it (2026-09-20, tape measure on the built frame): a 27"
// 16:9 panel above at 42 degrees facing down and toward them, its BOTTOM edge 13.5 cm above the acrylic,
// the acrylic 13.5 cm above the mat, the whole screen used, the picture sent flipped; and the head tracker
// is the one ZED 2 standing under the panel on a 1.5 inch block.
//
// Only monitorDropCm is derived rather than measured, because the form asks for the panel CENTRE and a
// tape measure can only reach the bottom edge: centre = bottom + (h/2)*sin(tilt), which for this panel is
// 13.5 + 16.81*sin(42) = 24.75. Same step gives the top edge (36.0) that the head position is quoted from.
//
// monitorForwardCm and pair.depthCm are the two numbers NOBODY HAS MEASURED: every length on this rig was
// taken vertically, and nothing fixes where the panel and the camera sit ALONG the viewer's line of sight.
// They are left at the shipped "centred over the sheet" reading. It is not a harmless default - sweeping it
// from -6 to +6 cm takes the drawable volume from 20x10 cm to nothing at all - so it is marked here rather
// than buried: measure the acrylic's depth and how far behind its front edge the panel's bottom edge sits,
// and these two stop being guesses.
export const SETUP_VERSION = 7;
export const DEFAULT_SETUP = {
  version: SETUP_VERSION,
  units: 'cm',
  rig: {
    monitorDiagIn: 27,          // 16:9; the only monitor number most people can actually read off the box
    pixelW: 1920, pixelH: 1080,
    tiltDeg: 45,                // stated by the rig's owner: 0 would face straight down, 45 faces down and at the viewer
    monitorDropCm: 25.39,       // panel centre THIS far above the sheet: bottom edge 13.5 + (33.62 / 2) * sin(45)
    monitorForwardCm: 0,        // and this far toward the viewer; 0 = straight above the sheet centre. UNMEASURED.
    baseDropCm: 13.5,           // the mat below the sheet
    // The acrylic is not quite level: 2 degrees, front edge low. A mirror tilted by t turns its reflection
    // by 2t, so this is 4 degrees of pitch on the whole virtual image - about 2 cm across the volume, which
    // is more than step 4's trim is meant to mop up and is a rotation trim cannot express anyway.
    sheetTiltDeg: 0,            // "essentially flat". It was entered as 2 once; a mirror's tilt counts double, so ask again if it swims
    sheetWidthCm: 0, sheetDepthCm: 0,   // 0 = "as big as the panel's footprint" (sheetSizeCm below)
    fullScreen: true,
    // The picture must be mirrored once for the sheet; WHICH axis is not a free parameter and is not a
    // user setting. rigCamera derives the parity from virtualScreen().mirrored, and the two axes differ
    // only by a 180 degree roll that the matching CSS flip cancels exactly - so the hologram is identical
    // either way and only the OVERLAY TEXT changes, for the worse. overlayFlip() derives the text's mirror
    // from the optics instead. The real physical degree of freedom is rot180: the panel mounted the other
    // way up, which is a different picture, not a different axis.
    flipAxis: 'y',
    rot180: false,              // the panel itself mounted upside down (it is not, on this rig)
    modelFitCm: 11,
  },
  pair: {
    // On this rig the "pair" is the ZED's own two eyes, so the baseline is a factory number and the height
    // and depth are where the one camera stands. index.html overwrites baselineCm from the placement anyway.
    baselineCm: 12,             // ZED 2, factory
    // Lens centre in RIG coordinates, so negative is below the acrylic: the ZED stands on a 1.5 in block
    // (3.81 cm) on the mat and its lenses sit ~1.5 cm up its own 3 cm body, so 5.31 cm above the mat and
    // 13.5 - 5.31 = 8.19 cm below the sheet.
    heightCm: -8.19,
    depthCm: -12.5,             // under the panel's bottom edge. UNMEASURED - see monitorForwardCm above.
    // The toe-in is DERIVED, not measured (null = "work it out"): storing it as an independent constant is
    // what let the shipped 14/12 contradict a 40-inch baseline and a head 45 cm away - the triangulator then
    // decoded that head 159 cm too far away while the page reported healthy tracking.
    //
    // The TILT is a fact about this rig and is stated: 15, propped up on its block at the back of the slot.
    // A page that believes anything else puts every hand and every head it is told about in the wrong place
    // - by the sine of the difference times the distance: at 0 instead of 15, a hand 25 cm out lands 6.5 cm
    // too LOW and a head 75 cm out 19 cm too low, and no offset undoes a rotation. Deriving it ("whatever
    // points the lens at the head", about 39 degrees here) described a camera nobody built. 15 also happens
    // to be the angle that holds the slot and a leaning viewer's face in the frame together.
    toeInDeg: null, tiltUpDeg: 15, aimManual: true,
    dfovDeg: 78,                // Logitech 1080p (C920-family) diagonal field of view
    // The MEASURED relative pose (rig/paircalib.js solvePair), when the user has run step 5. It beats both
    // the derived and the typed angles, because it is the only one of the three that came from data: the
    // two cameras watching the user's own face from hundreds of head positions. Kept on file even when it
    // is switched off, so "go back to the typed angles" and "use the measurement again" are both one press.
    solved: null, useSolved: true,
  },
  // Where a seated viewer's eye sits, quoted from the panel's TOP edge (y 36.0, z monitorForwardCm+12.49):
  // 3.5 cm above it and 33 cm out. The z therefore carries monitorForwardCm's guess with it.
  head: { positionCm: [0, 39.5, 45.49], sweepXCm: 30, sweepYCm: 12 },
  trimCm: [0, 0, 0],            // the nudge from step 4: it corrects the TRACKER's origin, not the rig
  handTune: { offsetCm: [0, 0, 0], scale: 1 },   // manual placement of the drawn hand (P); see rig/hands.js
  // The demo's grab (rig/demo.js makeGrab): the pinch gap, as a fraction of the palm, below which it takes
  // hold and above which it lets go. People's pinches differ, so it is tunable on the glass (; and ').
  demo: { grabClose: 0.40, grabOpen: 0.62 },
  // Which frames of the hand to believe (rig/hands.js makeHandGate; tuned on the glass with Q): below minConf
  // the hand is held where it last was, for up to holdMs. detect/track are MediaPipe's own thresholds, sent to
  // the bridge when it connects; null leaves the bridge's command line in charge.
  stability: { minConf: 0.45, holdMs: 1000, detect: null, track: null },
  cameras: { left: null, right: null },   // { deviceId, label, groupId } chosen in step 1
};

// Deep-ish merge so a saved setup from an older version still opens with the new defaults filled in.
export function mergeSetup(saved) {
  const out = { ...DEFAULT_SETUP, ...(saved || {}) };
  for (const k of ['rig', 'pair', 'head', 'cameras'])
    out[k] = { ...DEFAULT_SETUP[k], ...((saved || {})[k] || {}) };
  const t = (saved || {}).trimCm;
  out.trimCm = Array.isArray(t) && t.length === 3 ? t.map(Number) : [0, 0, 0];
  const h = (saved || {}).handTune;
  out.handTune = h && Array.isArray(h.offsetCm) && h.offsetCm.length === 3 && h.offsetCm.every(Number.isFinite)
    && Number.isFinite(h.scale) && h.scale > 0.3 && h.scale < 3
    ? { offsetCm: h.offsetCm.map(Number), scale: +h.scale } : { offsetCm: [0, 0, 0], scale: 1 };
  const st = (saved || {}).stability, unit = v => (Number.isFinite(v) && v >= 0.05 && v <= 0.95 ? +v : null);
  out.stability = st && Number.isFinite(st.minConf) && st.minConf >= 0 && st.minConf <= 1 && Number.isFinite(st.holdMs)
    && st.holdMs >= 0 && st.holdMs <= 60000
    ? { minConf: +st.minConf, holdMs: +st.holdMs, detect: unit(st.detect), track: unit(st.track) } : { ...DEFAULT_SETUP.stability };
  const d = (saved || {}).demo;
  out.demo = d && Number.isFinite(d.grabClose) && Number.isFinite(d.grabOpen) && d.grabClose >= 0.15
    && d.grabOpen <= 1.2 && d.grabOpen > d.grabClose + 0.05
    ? { grabClose: +d.grabClose, grabOpen: +d.grabOpen } : { ...DEFAULT_SETUP.demo };
  if (!Array.isArray(out.head.positionCm) || out.head.positionCm.length !== 3)
    out.head.positionCm = DEFAULT_SETUP.head.positionCm.slice();
  // Versions before 3 stored hand-picked pair angles that nothing kept in step with the baseline or the
  // head spot. They are not evidence of anything the user chose, so they are dropped rather than carried
  // forward as if they had been typed.
  if (!(Number((saved || {}).version) >= 3)) {
    out.pair.toeInDeg = null; out.pair.tiltUpDeg = null; out.pair.aimManual = false;
  }
  // Before version 5 the tilt was derived or A-measured against a camera assumed to be propped at the face.
  // The camera sits flat, so a tilt saved under that assumption is a stale guess, not a measurement.
  if (!(Number((saved || {}).version) >= 5)) {
    out.pair.tiltUpDeg = DEFAULT_SETUP.pair.tiltUpDeg; out.pair.aimManual = true;
  }
  // Version 6: the owner restated the rig - monitor 45, sheet flat, camera up 15. A saved setup from before
  // carries the old angles, and a hand placement (P) that was dialled in to fight them; both are stale.
  if (!(Number((saved || {}).version) >= 6)) {
    out.rig.tiltDeg = DEFAULT_SETUP.rig.tiltDeg; out.rig.monitorDropCm = DEFAULT_SETUP.rig.monitorDropCm;
    out.rig.sheetTiltDeg = DEFAULT_SETUP.rig.sheetTiltDeg;
    out.pair.tiltUpDeg = DEFAULT_SETUP.pair.tiltUpDeg; out.pair.aimManual = true;
    out.handTune = { offsetCm: [0, 0, 0], scale: 1 };
  }
  // Version 7: EVERYTHING measured. Until now each new measurement went into DEFAULT_SETUP and reached only
  // a browser that had never opened the page; one that had kept its saved copy of the page's OLD guesses,
  // which the merge above prefers because a saved number looks like a typed one. On the owner's rig that was
  // a 24 inch panel (a 10 cm square drew 11.2), the mat 6 inches down, and the ZED at the FRONT edge of the
  // sheet (z +22) when it stands at the back (z -12.5): head and hand both placed 34 cm too near the viewer,
  // so the drawn hand sat 12-17 degrees below the real one, fell off the picture with the hand in the slot,
  // and moved 1.3x as far. Versions 5 and 6 each reset the two or three numbers then under suspicion and
  // left the rest; this resets the lot. Nothing typed is lost that was not also said out loud: the defaults
  // ARE the owner's measurements. Only the camera choice, which describes the PC and not the rig, is kept.
  if (!(Number((saved || {}).version) >= 7)) {
    const fresh = JSON.parse(JSON.stringify(DEFAULT_SETUP));
    for (const k of Object.keys(out)) if (k !== 'cameras') delete out[k];
    Object.assign(out, fresh, { cameras: out.cameras });
  }
  // A solved pose that is not shaped like one is dropped here rather than being handed to the triangulator
  // to decode into nonsense. localStorage is editable by anything, and a half-written pose is not evidence.
  if (!validPose(out.pair.solved)) out.pair.solved = null;
  out.pair.useSolved = out.pair.useSolved !== false;
  out.version = SETUP_VERSION;
  return out;
}

export const SETUP_KEY = 'holo-rigtest2';
export function loadSetup(store = globalThis.localStorage) {
  try { return mergeSetup(JSON.parse(store?.getItem(SETUP_KEY) || 'null')); } catch { return mergeSetup(null); }
}
export function saveSetup(setup, store = globalThis.localStorage) {
  try { store?.setItem(SETUP_KEY, JSON.stringify(setup)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- setup -> rig

// 16:9 from the diagonal. sqrt(16^2 + 9^2) = 18.3576, so a 24" panel is 53.13 x 29.89 cm.
export function monitorSizeCm({ monitorDiagIn }) {
  const d = monitorDiagIn * INCH_CM, k = Math.hypot(16, 9);
  return { widthCm: d * 16 / k, heightCm: d * 9 / k };
}
export const baseYCm = (setup) => -setup.rig.baseDropCm;

function buildRig(setup, sheet) {
  const r = setup.rig, m = monitorSizeCm(r), baseY = -r.baseDropCm;
  return makeRig({
    monitor: { widthCm: m.widthCm, heightCm: m.heightCm, pixelW: r.pixelW, pixelH: r.pixelH,
               centre: [0, r.monitorDropCm, r.monitorForwardCm], tiltDeg: r.tiltDeg,
               yawDeg: 0, rollDeg: 0, rot180: !!r.rot180, corners: null },
    // The sheet is a mirror, not scenery, so its tilt is optics: geometry.js reflects through whatever
    // plane this is. Front edge low (the viewer's side) tips the normal toward +Z, which is +sheetTiltDeg.
    sheet: { point: [0, 0, 0], normal: [0, Math.cos((r.sheetTiltDeg || 0) * DEG), Math.sin((r.sheetTiltDeg || 0) * DEG)],
             widthCm: sheet.widthCm, depthCm: sheet.depthCm },
    // the model sits ON the base, not floating in the middle of nowhere: that is what the test scenes show
    model: { anchor: [0, baseY + r.modelFitCm / 2, 0], fitCm: r.modelFitCm, yawDeg: 0 },
    flipAxis: r.flipAxis,
    near: 1, far: 400,
  });
}

export function rigFromSetup(setup) {
  const r = setup.rig;
  if (r.sheetWidthCm && r.sheetDepthCm) return buildRig(setup, { widthCm: r.sheetWidthCm, depthCm: r.sheetDepthCm });
  // The user has not measured their acrylic yet. The sheet size changes no projection at all - it only
  // decides whether rigCheck warns that the image falls off the edge - so it is safe to build the rig
  // once with a sheet big enough not to warn, ask the geometry how big it actually has to be, and use that.
  // Guessing smaller would greet them with a warning about a sheet nobody has measured.
  const provisional = buildRig(setup, { widthCm: 400, depthCm: 400 });
  return buildRig(setup, minimumSheetCm(provisional, viewingArc(setup, 7)));
}

// How big the sheet has to be: where the lines of sight from every eye on the arc to the four corners of
// the image cross the sheet plane. Anything smaller and a corner of the hologram is cut off from the side.
export function minimumSheetCm(rig, eyes, marginCm = 1) {
  const V = virtualScreen(rig), sheet = plane(rig.sheet.point, rig.sheet.normal);
  let mx = 0, mz = 0;
  for (const e of eyes) for (const c of [V.tl, V.tr, V.br, V.bl]) {
    const d = sub(c, v3(e)), t = rayPlane(v3(e), d, sheet);
    if (t === null) continue;
    const h = add(v3(e), scale(d, t));
    mx = Math.max(mx, Math.abs(h[0])); mz = Math.max(mz, Math.abs(h[2]));
  }
  return { widthCm: round(2 * mx + 2 * marginCm, 1), depthCm: round(2 * mz + 2 * marginCm, 1) };
}

// ---------------------------------------------------------------- the webcam pair

// The two cameras as public/js/input/cameras.js wants them: `ext` is { posCm, rotDeg } per camera, and
// cameras.js turns pixels into world rays with it (stereo.js camToWorld: world = Rz*Ry*Rx * cam + posCm,
// with the camera's own axes x right in the image, y down, z out of the lens).
//
// rotDeg is [rx, ry, rz]. rz = 180 is a camera facing the viewer: the viewer's right hand lands on the
// image's left and image-y runs down. ry then turns it about the vertical - positive swings the lens toward
// -X - so the camera on the +X side toes in with +toeIn and the one on -X with -toeIn. rx tips it up at the
// face. The positions are in the TRACKER frame, whose origin is the midpoint between the two, so the pair's
// height and depth live in eyeToRig() instead of being baked in here.
export function pairCameras(setup) {
  // A measured pose wins: it is per CAMERA, so it can describe a pair that is not quite symmetric, which
  // the two shared angles below cannot.
  const solved = solvedPose(setup);
  if (solved) return [
    { side: 'left', posCm: solved.left.posCm.slice(), rotDeg: solved.left.rotDeg.slice() },
    { side: 'right', posCm: solved.right.posCm.slice(), rotDeg: solved.right.rotDeg.slice() },
  ];
  const half = setup.pair.baselineCm / 2, { toeInDeg: toe, tiltUpDeg: tilt } = pairAngles(setup);
  return [
    { side: 'left', posCm: [-half, 0, 0], rotDeg: [tilt, -toe, 180] },
    { side: 'right', posCm: [half, 0, 0], rotDeg: [tilt, toe, 180] },
  ];
}

// Is this thing a pose, or is it whatever was in localStorage? Nothing downstream re-checks, because by
// then it is numbers in a rotation matrix.
const num3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
export function validPose(p) {
  return !!p && typeof p === 'object' && p.version === 1
    && !!p.left && !!p.right && num3(p.left.posCm) && num3(p.left.rotDeg)
    && num3(p.right.posCm) && num3(p.right.rotDeg) && Number.isFinite(p.baselineCm);
}

// The pose on file, and whether it is the one in use. It stops being usable when the rig it describes has
// changed underneath it: the solve fixes the pair's ANGLES from the pictures but takes the SCALE from the
// tape measure, so re-measuring the baseline invalidates the positions it wrote. Saying "stale" and
// falling back is the honest answer; quietly using metre-apart cameras that are now 90 cm apart is not.
export const POSE_BASELINE_TOL_CM = 0.5;
// The lens fov is the other input the solve cannot see afterwards. It is not decoration: it sets the
// toe-in about as hard as the baseline sets the positions - two degrees of diagonal FOV moves the solved
// toe by well over one - so a pose fitted at one fov and decoded at another is describing a different pair
// of cameras, exactly like a baseline that has been re-measured. Poses saved before this was recorded
// carry no fov and cannot be checked; they are left alone rather than condemned.
export const POSE_DFOV_TOL_DEG = 0.25;
export function poseStatus(setup) {
  const p = setup.pair.solved;
  if (!validPose(p)) return { pose: null, inUse: false, stale: false, reason: p ? 'the saved pose is not usable' : '' };
  const drift = Math.abs(p.baselineCm - setup.pair.baselineCm);
  if (drift > POSE_BASELINE_TOL_CM)
    return { pose: p, inUse: false, stale: true,
             reason: `the pair was measured at a baseline of ${round(p.baselineCm, 1)} cm and step 2 now says `
               + `${round(setup.pair.baselineCm, 1)} cm — calibrate again, or put the baseline back` };
  const fovs = Array.isArray(p.dfovDeg) ? p.dfovDeg : (Number.isFinite(p.dfovDeg) ? [p.dfovDeg] : []);
  const offFov = fovs.filter(Number.isFinite).find(d => Math.abs(d - setup.pair.dfovDeg) > POSE_DFOV_TOL_DEG);
  if (offFov != null)
    return { pose: p, inUse: false, stale: true,
             reason: `the pair was measured with a ${round(offFov, 1)} degree lens and step 2 now says `
               + `${round(setup.pair.dfovDeg, 1)} — the fov sets the toe-in, so calibrate again, or put the `
               + 'lens fov back' };
  if (setup.pair.useSolved === false)
    return { pose: p, inUse: false, stale: false, reason: 'switched off: the typed angles are in use' };
  return { pose: p, inUse: true, stale: false, reason: '' };
}
export const solvedPose = (setup) => (poseStatus(setup).inUse ? setup.pair.solved : null);

/** Put a fresh solve in the setup. The caller saves; this only decides what the pair is. */
export function applySolvedPose(setup, pose) {
  if (!validPose(pose)) return false;
  setup.pair.solved = pose;
  setup.pair.useSolved = true;
  return true;
}

// The angles actually used, and where they came from. Three sources, best first:
//   measured  solved from the user's face (step 5). Per camera, so it can be asymmetric.
//   typed     the user measured an angle with a protractor and typed it.
//   aimed     derived from the baseline and where the user says their head sits - a guess, and the reason
//             step 5 exists.
// These angles ARE the triangulation extrinsics (cameras.js -> stereo.viewsForCamera), not decoration.
export function pairAngles(setup) {
  const p = setup.pair, aimed = aimPair(setup), solved = solvedPose(setup);
  if (solved) return {
    toeInDeg: round((solved.right.rotDeg[1] - solved.left.rotDeg[1]) / 2, 1),
    tiltUpDeg: round((solved.right.rotDeg[0] + solved.left.rotDeg[0]) / 2, 1),
    aimed, manual: false, source: 'measured', solved,
  };
  const manual = !!p.aimManual;
  const pick = (v, fallback) => (manual && Number.isFinite(v) ? v : fallback);
  return { toeInDeg: pick(p.toeInDeg, aimed.toeInDeg), tiltUpDeg: pick(p.tiltUpDeg, aimed.tiltUpDeg),
           aimed, manual, source: manual ? 'typed' : 'aimed', solved: null };
}
// Where the pair's own origin sits in the rig frame.
export const trackerOriginRig = (setup) => [0, setup.pair.heightCm, setup.pair.depthCm];

// A tracker-frame eye (what the pair triangulates) as a rig-frame eye, which is the only thing
// rig/geometry.js will accept. Two terms and nothing else:
//   + the pair's own position, because the pair measures from between its own two lenses;
//   + the trim from step 4, which is the user saying "the tracker thinks its origin is HERE, it is really
//     a bit over THERE". Trim is about the tracker, never about the rig: if the hologram is in the wrong
//     PLACE the rig numbers are wrong, and nudging trim to hide that makes it swim again from another angle.
export function eyeToRig(eyeTracker, setup) {
  return add(add(v3(eyeTracker), trackerOriginRig(setup)), v3(setup.trimCm));
}
export const rigToTracker = (eyeRig, setup) =>
  sub(sub(v3(eyeRig), trackerOriginRig(setup)), v3(setup.trimCm));

// Toe-in and tilt that point both cameras at one spot (the head position), so the user can aim the pair by
// saying where their head goes rather than by measuring an angle off the desk with a protractor.
export function aimPair(setup, headRig = setup.head.positionCm) {
  const half = setup.pair.baselineCm / 2;
  const from = [half, setup.pair.heightCm, setup.pair.depthCm];       // the +X camera; the other is mirrored
  const d = sub(v3(headRig), from), flat = Math.hypot(d[0], d[2]);
  // A head directly above the lens has no aim to work out; 0/90 is the only honest answer, and never the
  // stored angle, which is what this function exists to replace.
  if (flat < 1e-6) return { toeInDeg: 0, tiltUpDeg: d[1] >= 0 ? 90 : -90 };
  return { toeInDeg: round(Math.atan2(-d[0], d[2]) / DEG, 1),
           tiltUpDeg: round(Math.atan2(d[1], flat) / DEG, 1) };
}

// Where a pair set to these angles is actually LOOKING: both optical axes are mirror images about the
// centre line, so they cross it at one point. Follow the +X camera's forward vector (Rz180*Ry(toe)*Rx(tilt)
// on [0,0,1], the same convention stereo.js uses) until x reaches 0.
export function convergeRig(setup, angles = pairAngles(setup)) {
  const half = setup.pair.baselineCm / 2;
  const toe = angles.toeInDeg * DEG, tilt = angles.tiltUpDeg * DEG;
  const across = Math.sin(toe) * Math.cos(tilt);        // how fast the axis closes on the centre line
  if (!(Math.abs(across) > 1e-9)) return null;          // parallel axes: they never meet
  const t = half / across;
  if (t < 0) return null;                               // toed OUT: they cross behind the cameras
  return [0, setup.pair.heightCm + t * Math.sin(tilt), setup.pair.depthCm + t * Math.cos(toe) * Math.cos(tilt)];
}

// Do the angles in use agree with where the user says their head sits? Step 1 makes them physically aim
// each camera at their own face, so a disagreement here means the software's extrinsics and the hardware's
// aim are different pairs of cameras - and the triangulated head comes out somewhere else entirely, with
// nothing on screen saying so. A tenth of a degree is aimPair's rounding (0.17 cm at this range) and one
// degree of toe error is 1.7 cm of eye error, so two degrees is the most that can be called agreement.
export const AIM_TOLERANCE_DEG = 2;
// Once the pair has been MEASURED, "do the angles agree with where you say you sit" is the wrong question:
// the head spot was only ever a stand-in for a protractor, and the measurement replaced it. What is still
// worth saying is that the measured lenses cross somewhere you could not possibly be - that means the
// cameras have been knocked since, or the seat has moved, and either way the measurement is out of date.
export const MEASURED_MISS_CM = 40;
export function aimCheck(setup) {
  const used = pairAngles(setup), aimed = used.aimed;
  if (used.source === 'measured') {
    const at = convergeRig(setup, used), head = v3(setup.head.positionCm);
    const missCm = at ? Math.hypot(at[0] - head[0], at[1] - head[1], at[2] - head[2]) : Infinity;
    const ok = missCm <= MEASURED_MISS_CM;
    return { ok, used, aimed, dToe: round(used.toeInDeg - aimed.toeInDeg, 2),
             dTilt: round(used.tiltUpDeg - aimed.tiltUpDeg, 2), convergeRig: at, missCm,
             message: ok ? '' :
               `The pair was MEASURED, and the measurement says both lenses cross ${missCm === Infinity ? 'nowhere'
                 : `${missCm.toFixed(0)} cm from where you said your head sits`}. The pose is not a guess, so `
               + 'either a camera has been knocked since you calibrated, or your seat has moved: re-aim them '
               + 'and calibrate again in step 5, or update where your head sits in step 2.' };
  }
  const dToe = used.toeInDeg - aimed.toeInDeg, dTilt = used.tiltUpDeg - aimed.tiltUpDeg;
  const ok = Math.abs(dToe) <= AIM_TOLERANCE_DEG && Math.abs(dTilt) <= AIM_TOLERANCE_DEG;
  const at = convergeRig(setup, used), head = v3(setup.head.positionCm);
  const missCm = at ? Math.hypot(at[0] - head[0], at[1] - head[1], at[2] - head[2]) : Infinity;
  const say = (n) => n.toFixed(0);
  const message = ok ? '' :
    `The cameras are told they are toed in ${used.toeInDeg} deg and tipped up ${used.tiltUpDeg} deg, which aims `
    + `them at a spot ${at ? say(Math.hypot(at[0], at[2])) + ' cm away' : 'they never both reach'} — but you said `
    + `your head sits ${say(Math.hypot(head[0], head[2]))} cm away. Aiming at where your head sits needs `
    + `${aimed.toeInDeg} / ${aimed.tiltUpDeg} deg. As it stands the tracker will report your head about `
    + `${say(missCm)} cm from where it really is. Press "work the angles out" in step 2.`;
  return { ok, used, aimed, dToe: round(dToe, 2), dTilt: round(dTilt, 2), convergeRig: at, missCm, message };
}

// ---------------------------------------------------------------- is the head really tracked?

// The one gate between "two webcams agree about where your eye is" and "something made a number up".
// cameras.js can fall back to one-camera depth-from-eye-spacing on its own; this is what refuses it.
//
// Two results, because they are two different questions:
//   usable  may this frame read input.eye? Only a believed stereo fuse ever earns that.
//   ok      should the page shout? A single dropped frame must not: MediaPipe misses faces all the time,
//           and a full red panel thrown into the volume for 100 ms, blaming an aim that is fine, is worse
//           than useless. So the refusal waits STEREO_GRACE_MS for stereo to come back, while the eye
//           simply holds still. The grace never lets a guessed eye through - only silence.
export const STEREO_GRACE_MS = 500;
// How far from the seat the tracked eye may be before it stops being a head and starts being a decoding
// error. The viewing arc is 60 cm wide, so this has to clear it comfortably.
export const EYE_PLAUSIBLE_CM = 60;

export function headSource({ cameras = 0, seeingHead = 0, eyeSource = 'none', chosen = 0,
                             msSinceStereo = Infinity, residualCm = null, swapHint = false,
                             eyeRig = null, headRig = null, plausibleCm = EYE_PLAUSIBLE_CM } = {}) {
  const no = (reason, message) => ({ ok: false, reason, message, usable: false });
  if (chosen < 2)
    return no('need-two', 'Pick TWO cameras in setup. One webcam cannot measure how far away your head is - '
      + 'it can only guess from how far apart your eyes look, and that guess is not good enough for this rig.');
  if (cameras < 2)
    return no('one-camera', 'Only one camera is running. Head tracking needs both: one camera would have to '
      + 'guess your distance from the spacing of your eyes, and this page will not do that. '
      + 'Plug the second webcam back in, or press M for the mouse stand-in (development only).');
  // These two are configuration errors the pair itself detected. They are reported before anything else,
  // because every later message would send the user off to fix the wrong thing.
  if (eyeSource === 'bad-extrinsics')
    return no('same-place', 'Both cameras are configured in the SAME place, so there is no baseline to '
      + 'triangulate from and the "tracked" eye would sit on one lens and never move. '
      + 'Re-pick the two cameras in step 1 — if they are the same model they share a name, so mark them one at a time.');
  if (eyeSource === 'bad-rays')
    return no('rays-miss', `The two cameras disagree about where your head is${residualCm != null ? ` by ${residualCm.toFixed(1)} cm` : ''}`
      + `, so their answer is not a measurement. `
      + (swapHint ? 'They look marked the wrong way round: swap left and right in step 1.'
                  : 'Check the baseline and the angles in step 2 against the real rig.'));
  if (eyeSource === 'stereo' && eyeRig && headRig) {
    const d = Math.hypot(eyeRig[0] - headRig[0], eyeRig[1] - headRig[1], eyeRig[2] - headRig[2]);
    if (d > plausibleCm)
      return no('implausible', `The pair says your head is ${d.toFixed(0)} cm from where you said you sit. `
        + 'Two cameras cannot be that wrong about a face they can both see, so the numbers describing them '
        + 'are wrong: check the baseline and the angles in step 2.');
  }
  // A mono fuse is only worth shouting about once the grace has run out; inside it, it is one dropped
  // frame. `seeingHead` needs no grace of its own - it is already a 500 ms window over lastFaceAt.
  if (eyeSource === 'mono' && msSinceStereo >= STEREO_GRACE_MS)
    return no('mono', 'The tracker fell back to one camera (the other one cannot see your face). '
      + 'That is a depth guess, so the head is not being used. Re-aim the cameras in setup.');
  if (seeingHead < 2)
    return no('one-sees', 'Only one camera can see your face. Both must, or there is nothing to triangulate. '
      + 'Move into the middle, or re-aim the cameras in setup.');
  if (eyeSource === 'stereo') return { ok: true, reason: 'stereo', message: '', usable: true };
  // Stereo was believed a moment ago. Hold the last eye and say nothing: this is a blink, not a fault.
  if (msSinceStereo < STEREO_GRACE_MS)
    return { ok: true, reason: 'blink', message: '', usable: false };
  return no('waiting', 'Looking for your face in both cameras…');
}

// ---------------------------------------------------------------- what the user is told

// rigCheck warnings come in two kinds. These are the ones that mean the picture on the glass is not a
// hologram at all, so they belong on the always-visible banner rather than in a readout that starts hidden.
const HARD_WARNING = [/behind the virtual screen/i, /under the sheet/i, /No light path/i, /blocks the line of sight/i];
export const hardWarnings = (warnings = []) => warnings.filter(w => HARD_WARNING.some(re => re.test(w)));

// The one banner, chosen once, in the order a person would have to fix things. Pure so the choice can be
// tested: getting this order wrong is how "make the sheet bigger" ends up on screen while the real fault is
// two cameras pointed at a spot two metres away.
export function bannerFor({ volume = null, warnings = [], aim = null, source = null, mouse = false } = {}) {
  if (volume?.empty)
    return { kind: 'bad', title: 'Nothing can be drawn here', text: volume.message };
  const hard = hardWarnings(warnings);
  if (hard.length)
    return { kind: 'bad', title: 'The rig numbers do not describe a working rig', text: hard.join(' ') };
  if (aim && !aim.ok)
    // the check may name its own fault: "the angles do not match" is only one of the things it can find
    return { kind: 'warn', title: aim.title || 'The camera angles do not match where your head sits', text: aim.message };
  if (mouse) return null;                       // the stand-in has its own flag; it is not a fault
  if (source && !source.ok)
    return { kind: source.reason === 'waiting' ? 'warn' : 'bad',
             title: source.reason === 'waiting' ? 'Waiting for both cameras' : 'Head tracking is not running',
             text: source.message };
  return null;
}

// ---------------------------------------------------------------- the canvas as a window on the panel

// On the rig the canvas IS the panel, and rigCamera needs no viewport. On a desktop (or in the headless
// test browser) it is a window of a different shape, and stretching a 16:9 frustum across it would tilt
// every line in the picture. So tell rigCamera which part of the panel this canvas stands for: the biggest
// centred rectangle of the canvas's shape that fits on the panel.
export function letterboxViewport(panelWCm, panelHCm, canvasW, canvasH) {
  if (!(panelWCm > 0 && panelHCm > 0 && canvasW > 0 && canvasH > 0)) return null;
  const panel = panelWCm / panelHCm, canvas = canvasW / canvasH;
  if (Math.abs(panel - canvas) < 1e-4) return null;
  const w = canvas > panel ? 1 : canvas / panel;       // fractions of the panel
  const h = canvas > panel ? panel / canvas : 1;
  return { u0: (1 - w) / 2, v0: (1 - h) / 2, u1: (1 + w) / 2, v1: (1 + h) / 2 };
}
export function monitorUVToCanvas(uv, viewport, canvasW, canvasH) {
  if (!uv) return null;
  const vp = viewport || { u0: 0, v0: 0, u1: 1, v1: 1 };
  const u = (uv.u - vp.u0) / (vp.u1 - vp.u0), v = (uv.v - vp.v0) / (vp.v1 - vp.v0);
  return { x: u * canvasW, y: v * canvasH, u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

// ---------------------------------------------------------------- the independent check

// Where a floating point is REALLY drawn, worked out by following the light instead of the matrices.
//
// The viewer sees the point along the line eye -> point. That light did not come from the point (there is
// nothing there); it came from the monitor, bounced off the sheet, and therefore appears to come from the
// monitor's mirror image - the virtual screen. So the line eye -> point crosses the virtual screen at
// exactly one place, and the virtual screen carries the panel's pixel grid with it.
//
// This deliberately never calls rigCamera, projectToMonitor or ndcToMonitorUV. It is the second opinion:
// if it and the rendered picture disagree, one of them is wrong, and the test says which.
export function predictMonitorUV(rig, eyeRig, pointRig) {
  const V = virtualScreen(rig);
  const eye = v3(eyeRig), d = sub(v3(pointRig), eye);
  const t = rayPlane(eye, d, plane(V.centre, V.normal));
  if (t === null) return null;
  const q = add(eye, scale(d, t));
  const uv = rectUV(V, q);
  return { u: uv.u, v: uv.v, point: q, t, behind: t <= 0 };
}
export function predictedScreenPos(rig, eyeRig, pointRig, viewport, canvasW, canvasH) {
  return monitorUVToCanvas(predictMonitorUV(rig, eyeRig, pointRig), viewport, canvasW, canvasH);
}

// Where that point lands on screen by the page's OWN path: the projection matrices the GPU uses, and then
// the single CSS flip on the canvas.
//
// One reflection in the sheet mirrors the picture, so exactly one flip belongs between the render and the
// panel. rigCamera builds its camera basis from swapped screen corners (that is what keeps the maths valid
// when the virtual screen's pixel frame is left-handed) and reports which way the result must be mirrored;
// the page's canvas transform does the mirroring. Do it twice - a page-level flip as well, the way
// rigtest.html flips its whole document - and the two cancel, and the hologram comes out reversed with
// every line still in a plausible-looking place. Hence a test for exactly once.
//
// ndcToMonitorUV() is not used here on purpose: it already knows about the flip, so using it would be
// geometry.js checking geometry.js.
export const flipTransform = (rc) => rc.flipX ? 'scaleX(-1)' : rc.flipY ? 'scaleY(-1)' : '';

// The OTHER flip, and it is a different question. rigCamera's two mirrored branches differ by a 180 degree
// roll of the camera basis AND by which flip they report, and those cancel exactly: flipX o R180 = flipY,
// so the hologram is identical whichever axis is chosen (measured: the monitor uv agrees to 0). The text
// on the glass is NOT identical - one of them leaves every word rotated 180 degrees - so which axis the
// OVERLAY is mirrored in has to come from the optics, not from a key the user presses at the rig.
//
// Follow a line of text: CSS reading direction is +x on the panel (pixel u), glyph-up is -y (against pixel
// v). Carry both through the sheet onto the virtual screen and compare with the seated viewer's own right
// and up. Whichever axis comes back negative is the one to mirror. On this rig that is v, i.e. scaleY(-1);
// on a folded or vertical-sheet rig it will honestly say something else.
export function overlayFlip(rig, eyeRig) {
  const V = virtualScreen(rig);
  const uDir = unit(sub(V.tr, V.tl)), vDir = unit(sub(V.bl, V.tl));
  const fwd = unit(sub(V.centre, v3(eyeRig)));
  const up0 = [0, 1, 0];
  const up = unit(sub(up0, scale(fwd, dot(fwd, up0))));     // the viewer's up, with the view direction taken out
  const right = cross(fwd, up);
  const readsRight = dot(uDir, right) > 0;                  // text already runs left to right
  const readsUp = dot(scale(vDir, -1), up) > 0;             // and its glyphs already stand up
  if (readsRight && readsUp) return '';
  if (readsRight) return 'scaleY(-1)';
  if (readsUp) return 'scaleX(-1)';
  return 'rotate(180deg)';                                  // both axes reversed: a roll, not a mirror
}
export function screenPos(rc, pointRig, canvasW, canvasH) {
  const pr = projectPoint(rc, pointRig);
  let x = (pr.ndc[0] + 1) / 2 * canvasW;        // the framebuffer, before the canvas transform
  let y = (1 - pr.ndc[1]) / 2 * canvasH;
  if (rc.flipX) x = canvasW - x;                // the one flip
  if (rc.flipY) y = canvasH - y;
  return { x, y, behind: pr.behind, ndc: pr.ndc };
}

// ---------------------------------------------------------------- the viewing arc and the usable volume

// The eye positions the user's head really moves through: a 60 cm arc (by default) swung about the rig
// centre at head height, which is what "look at it from different angles" means on a rig this size.
export function viewingArc(setup, n = 5, spanCm = 60) {
  const h = v3(setup.head.positionCm);
  const radius = Math.hypot(h[0], h[2]) || 45;
  const half = spanCm / 2 / radius;                                  // radians: arc length over radius
  const mid = Math.atan2(h[0], h[2]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = mid + (n === 1 ? 0 : (-half + (2 * half * i) / (n - 1)));
    out.push([radius * Math.sin(a), h[1], radius * Math.cos(a)]);
  }
  return out;
}

// The box under the sheet where a point is actually drawn for EVERY eye on the arc. It has to be worked out
// rather than declared: the panel is a finite rectangle seen through a finite sheet, so what fits depends on
// where you stand, and the honest answer is the intersection over the arc. Shrink a candidate box until all
// eight corners are inside the picture from all of them.
// `viewport` is the part of the panel the canvas actually covers (null when it covers all of it): a window
// narrower than the panel really can draw less, and an outline that promised the whole panel would hang off
// the edge of the picture on a desktop.
// An empty answer is a real answer and has to say so: a box smaller than this is nothing you could put a
// model in, and returning 0 without a word is how the page ends up drawing a single stray line on black
// while the readout reports 60 fps and no warnings.
export const MIN_VOLUME_CM = 1;

function volumeSearch(rig, eyes, marginCm, steps, viewport) {
  const baseY = rigBaseY(rig);
  const top = -marginCm;                                             // just under the sheet
  const cams = eyes.map(e => rigCamera(rig, e, { viewport }));
  const fits = (hx, hz) => {
    for (const rc of cams) for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [baseY, top]) {
      const pr = projectPoint(rc, [x, y, z]);
      if (pr.behind) return false;
      const n = pr.ndc;
      if (!(n[0] >= -1 && n[0] <= 1 && n[1] >= -1 && n[1] <= 1)) return false;
    }
    return true;
  };
  // Grow one half-extent at a time and alternate: the widest box and the deepest box are different boxes,
  // and a single scale on a fixed aspect would quietly pick whichever the seed happened to favour.
  const limit = Math.max(rig.monitor.widthCm, rig.monitor.heightCm);
  const grow = (fixed, along) => {
    let lo = 0, hi = limit;
    for (let i = 0; i < steps; i++) {
      const mid = (lo + hi) / 2;
      if (along === 'x' ? fits(mid, fixed) : fits(fixed, mid)) lo = mid; else hi = mid;
    }
    return lo;
  };
  let hx = grow(0.1, 'x') * 0.7, hz = grow(hx, 'z');
  // finish on a `grow(hx, 'z')` so the pair that comes out is a box that really fits
  for (let pass = 0; pass < 3; pass++) { hx = grow(hz, 'x'); hz = grow(hx, 'z'); }
  return { halfX: hx, halfZ: hz, baseY, topY: top, height: top - baseY };
}

export function usableVolume(rig, eyes, { marginCm = 1, steps = 16, viewport = null } = {}) {
  const v = volumeSearch(rig, eyes, marginCm, steps, viewport);
  v.empty = !(v.halfX >= MIN_VOLUME_CM && v.halfZ >= MIN_VOLUME_CM);
  v.reason = null; v.message = '';
  if (!v.empty) return v;
  // Two very different faults land here and they want opposite advice, so ask which one it is: re-run the
  // search with the whole panel. If THAT fits something, the rig is fine and this window is the wrong
  // shape; if it does not, no window would help and the rig numbers are what is wrong.
  const full = viewport ? volumeSearch(rig, eyes, marginCm, steps, null) : v;
  const panelAspect = rig.monitor.widthCm / rig.monitor.heightCm;
  if (viewport && full.halfX >= MIN_VOLUME_CM && full.halfZ >= MIN_VOLUME_CM) {
    const w = (viewport.u1 - viewport.u0) * rig.monitor.widthCm;
    const h = (viewport.v1 - viewport.v0) * rig.monitor.heightCm;
    v.reason = 'window-shape';
    v.message = `This window covers a ${(w / h).toFixed(1)}:1 strip of a ${panelAspect.toFixed(2)}:1 panel, and `
      + 'nothing in the volume is visible from the whole viewing arc through a strip that shape. '
      + 'Maximise the window (or press F for fullscreen), or undock the devtools. '
      + `Fullscreen this rig has ${(full.halfX * 2).toFixed(0)} x ${(full.halfZ * 2).toFixed(0)} cm to draw in.`;
  } else {
    v.reason = 'rig-numbers';
    // Naming the diagonal and the tilt alone sends people to re-measure the two numbers they are most
    // likely to have got RIGHT. What the search is really sensitive to is where the panel sits relative to
    // the sheet: its height sets how far below the sheet the image starts, and its offset along the line of
    // sight slides the image out from under the viewing arc. On this rig the same panel draws 17 x 13 cm or
    // nothing at all depending on that offset alone, so it is named here rather than left to be guessed.
    v.message = 'These rig numbers leave nothing drawable from any window: at this tilt and panel size no '
      + 'part of the space under the sheet is in the picture from the whole viewing arc. '
      + 'Check, in step 3 (press S): the monitor diagonal, the tilt, how high the panel sits above the '
      + 'sheet, and how far along your line of sight it sits - that last one moves this the hardest.';
  }
  return v;
}
// The base plane: the black paper, `baseDropCm` under the sheet. Stored on the rig only through the model
// anchor, so it is read back the way rigFromSetup wrote it.
export function rigBaseY(rig) { return rig.model.anchor[1] - (rig.model.fitCm || 0) / 2; }

// ---------------------------------------------------------------- the three-post parallax scene

// Three posts of different heights at known spots, each standing in a ring painted on the base. The ring is
// the check anyone can make in one second: a post drawn from the wrong eye position slides out of its own
// ring as you move, and a post drawn from the right one never does, from any angle.
// The three feet sit near the FRONT of the volume on purpose. The viewer looks down at about 40 degrees, so
// the top of a post appears to fall roughly 7 cm BEHIND its own foot; put the posts in the middle and every
// sight mark lands off the back of the usable volume, where nothing can be drawn.
export function postLayout(vol) {
  const hx = vol.halfX, hz = vol.halfZ * 0.85, h = vol.height * 0.35;
  return [
    { id: 'L', x: -hx * 0.6, z: hz, heightCm: h },
    { id: 'M', x: 0, z: hz, heightCm: h * 1.7 },
    { id: 'R', x: hx * 0.6, z: hz, heightCm: h * 1.25 },
  ].map(p => ({ ...p, foot: [p.x, vol.baseY, p.z], top: [p.x, vol.baseY + p.heightCm, p.z] }));
}

// The second check, the one with a number on it: from ONE named eye position, the top of a post appears to
// touch the base at exactly one spot - carry on down the line eye -> top until it hits the base plane. Paint
// a cross there and the top lands on it when, and only when, the eye is really at that position.
export function sightMark(topRig, eyeRig, baseY) {
  const eye = v3(eyeRig), d = sub(v3(topRig), eye);
  if (d[1] >= -1e-9) return null;                 // looking level or up: the line never reaches the base
  const t = (baseY - eye[1]) / d[1];
  if (t < 1) return null;                         // the base is nearer than the post top: nothing to mark
  return add(eye, scale(d, t));
}
// One cross per post per named eye position, labelled so the user knows which to stand at.
export function postMarks(posts, eyes, baseY, labels = ['L', 'C', 'R']) {
  const out = [];
  posts.forEach(p => eyes.forEach((e, i) => {
    const at = sightMark(p.top, e, baseY);
    if (at) out.push({ post: p.id, label: labels[i] ?? String(i), eye: v3(e), at });
  }));
  return out;
}

// The point the headless test watches: high at the front of the volume, which is as far from the virtual
// screen's own plane as anything in the volume gets, and therefore where the parallax is biggest. A point
// ON that plane would hold still whatever the eye did and would prove nothing.
export const probePoint = (vol) => [0, vol.topY - vol.height * 0.06, vol.halfZ * 0.9];

// ---------------------------------------------------------------- the mouse stand-in

// A key swaps the eye for the mouse so the maths can be proved with no hardware at all - and so the page's
// own headless test can put the eye in five known places. It is NOT a fallback at the rig: a mouse cannot
// know where your head is, and a hologram drawn for the wrong head is exactly the failure this page exists
// to catch. The page says so on screen the whole time it is on.
export function mouseEye(nx, ny, setup) {
  const h = setup.head, p = v3(h.positionCm);
  return [p[0] + (nx - 0.5) * 2 * h.sweepXCm, p[1] + (0.5 - ny) * 2 * h.sweepYCm, p[2]];
}

// ---------------------------------------------------------------- readout

export function readoutLines({ setup, rig, eyeRig, source, status, fps, check, mouse, volume, aim }) {
  const f = (n, d = 1) => (n >= 0 ? ' ' : '') + n.toFixed(d);
  const s = status || {};
  const views = (s.sources || []).flatMap(c => c.views || []);
  const ang = pairAngles(setup);
  const lines = [
    `eye  rig ${eyeRig.map(n => f(n).padStart(6)).join(' ')} cm${mouse ? '   MOUSE STAND-IN, not tracking' : ''}`,
    `trim     ${setup.trimCm.map(n => f(n).padStart(6)).join(' ')} cm  (tracker origin)`,
    `head from ${source?.reason || 'none'}  ·  cameras ${(s.sources || []).length}` +
      `  ·  seeing head ${(s.sources || []).filter(c => c.seesHead).length}` +
      // the eye's own error bar: a stereo eye with no residual beside it is a number nobody has checked
      (s.eyeResidualCm != null ? `  ·  rays miss ${s.eyeResidualCm.toFixed(2)} cm` : '') +
      (s.solver ? `  ·  ${s.solver}` : ''),
    views.length ? `views    ${views.map(v => `${v.fps} fps ${v.latencyMs} ms`).join('  ·  ')}` : 'views    none',
    `pair     ${round(setup.pair.baselineCm / INCH_CM, 1)}" apart  ·  toe ${ang.toeInDeg} tilt ${ang.tiltUpDeg} deg`
      + ` (${{ measured: 'MEASURED from your face', typed: 'typed', aimed: 'aimed at the head spot' }[ang.source]})`
      // "residual" read as "accurate to a millimetre". It is the epipolar fit against itself, it is capped
      // by the inlier threshold, and the accuracy number is the ray miss two lines up.
      + (ang.source === 'measured' && ang.solved.report?.residualMm != null
         ? `  ·  ${ang.solved.report.residualMm} mm epipolar fit (not accuracy)` : ''),
    `render   ${fps.toFixed(0)} fps`
      + (volume ? `  ·  volume ${(volume.halfX * 2).toFixed(1)} x ${(volume.halfZ * 2).toFixed(1)} cm` : ''),
  ];
  if (volume?.empty) lines.push(`EMPTY    ${volume.message}`);
  if (aim && !aim.ok) lines.push(`AIM      ${aim.message}`);
  for (const w of (check?.warnings || [])) lines.push(`WARN     ${w}`);
  return lines;
}
