// SPDX-License-Identifier: GPL-3.0-or-later
// The viewer's own hand, drawn where it is.
//
// This is the rig's alignment test, and HoloDesk's whole premise in one object: if the camera is where the
// page thinks it is, and the eye is, and the panel and the sheet are, then a skeleton drawn at the 21 joints
// the ZED measured lands ON the real hand seen through the acrylic — and stays on it as the head moves. If
// any of those is wrong it slides off, and HOW it slides says which: a constant offset is the camera's
// position (trim, T), an offset that grows toward the fingertips is its tilt (A), and a skeleton that is
// right from one seat and swims from another is the panel or the sheet.
//
// Joints arrive in the ZED's frame and are placed in the rig by the SAME camera pose the head goes through
// (index.html toRig), so whatever is still wrong with that pose is wrong for both together.
//
// Unlit on purpose. A Pepper's ghost adds light to the scene behind it and cannot subtract any: a shaded
// side is simply absent, and what is left reads as a thinner hand in the wrong place.

export const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
export const TIPS = [4, 8, 12, 16, 20];

// Manual placement (index.html, P). Two corrections, for two different faults:
//   scale  - about the LENS, in the camera's frame. A hand whose distance from the camera is over-estimated
//            is drawn too far along its own sightline, and every movement it makes is magnified by the same
//            factor: "the drawn hand is more sensitive than mine". Scaling about the lens undoes exactly that.
//   offset - in rig centimetres, added after placement: where the camera is thought to stand.
// The hand only. The head goes through the same camera pose but not through these, because the picture is
// far less sensitive to the eye than to the hand and the eye was judged right on its own.
export const DEFAULT_HAND_TUNE = { offsetCm: [0, 0, 0], scale: 1 };
export const scaleAboutLens = (camCm, scale) => [camCm[0] * scale, camCm[1] * scale, camCm[2] * scale];
export function validHandTune(t) {
  const ok = t && Array.isArray(t.offsetCm) && t.offsetCm.length === 3 && t.offsetCm.every(Number.isFinite)
    && Number.isFinite(t.scale) && t.scale > 0.3 && t.scale < 3;
  return ok ? { offsetCm: t.offsetCm.map(Number), scale: +t.scale } : { offsetCm: [0, 0, 0], scale: 1 };
}

// Where a unit cylinder along +Y has to go to join a to b: its centre, its length, and the direction.
export function boneTransform(a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], len,
           dir: len > 1e-9 ? [d[0] / len, d[1] / len, d[2] / len] : [0, 1, 0] };
}

// Sizes in centimetres, like everything in the rig frame. The joints are drawn SMALLER than a knuckle on
// purpose: a sphere the size of the knuckle hides a centimetre of error behind its own outline, and the
// point of this object is to show the error.
export function makeHand(THREE, { jointCm = 0.45, tipCm = 0.6, boneCm = 0.18,
                                  color = 0x35ffd0, tipColor = 0xffffff } = {}) {
  const group = new THREE.Group();
  group.visible = false;
  const mat = c => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const jointMat = mat(color), tipMat = mat(tipColor), boneMat = mat(color);
  const joints = Array.from({ length: 21 }, (_, i) => {
    const tip = TIPS.includes(i), m = new THREE.Mesh(sphere, tip ? tipMat : jointMat);
    m.scale.setScalar(tip ? tipCm : jointCm);
    group.add(m);
    return m;
  });
  const bones = BONES.map(() => { const m = new THREE.Mesh(cyl, boneMat); group.add(m); return m; });
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();

  return {
    group,
    // Amber while the hand on show is a HELD one (makeHandGate below): it is where the hand was, not where
    // it is, and somebody calibrating the threshold has to be able to see which they are looking at.
    tint(held) { jointMat.color.setHex(held ? 0xffa23d : color); boneMat.color.setHex(held ? 0xffa23d : color); },
    // pointsRig: 21 [x, y, z] in rig centimetres, or null when there is no hand to draw.
    update(pointsRig) {
      if (!pointsRig || pointsRig.length !== 21) { group.visible = false; return; }
      group.visible = true;
      pointsRig.forEach((p, i) => joints[i].position.set(p[0], p[1], p[2]));
      BONES.forEach(([a, b], k) => {
        const t = boneTransform(pointsRig[a], pointsRig[b]), m = bones[k];
        m.position.set(t.mid[0], t.mid[1], t.mid[2]);
        m.scale.set(boneCm, Math.max(t.len, 1e-6), boneCm);
        m.quaternion.setFromUnitVectors(up, dir.set(t.dir[0], t.dir[1], t.dir[2]));
      });
    },
  };
}

// ---------------------------------------------------------------- steadier, at the display's rate
//
// The bridge sends a hand ~30 times a second and the panel is drawn 60; drawing "the latest sample" shows
// each one twice and then jumps, and every sample carries the landmarker's own shake. This runs once per
// DRAWN frame and moves each joint a fraction of the way to where the newest sample says it is. How big a
// fraction depends on how far behind it is: a joint within a few millimetres of its target is mostly noise
// and is followed slowly (tauStill), one that is centimetres behind is a hand that really moved and is
// followed almost at once (tauFast) - the One-Euro idea, keyed on the error instead of a velocity estimate,
// which a twice-repeated sample would make meaningless. The whole hand's error sets a floor for every joint,
// so a moving hand does not leave its quieter fingers trailing. With these numbers a still hand's shake is
// cut to ~40%, and a hand crossing the slot at 20-50 cm/s trails its samples by about a centimetre.
//
// A hand that stops arriving is HELD for holdMs rather than blinked off: one missed detection is far more
// common than a hand that really left, and the grab in demo.js coasts through the same gap.
export function makeHandSmoother({ tauStillMs = 120, tauFastMs = 12, errRefCm = 1.2, holdMs = 220, snapMs = 300 } = {}) {
  let pts = null, lastMs = null, lastTargetMs = -1e9;
  const centre = p => { const c = [0, 0, 0]; for (const q of p) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; } return c.map(x => x / p.length); };
  return {
    reset() { pts = null; lastMs = null; lastTargetMs = -1e9; },
    // target: 21 [x, y, z] in rig cm (the newest sample, repeated until the next one) or null. Returns what to draw.
    update(target, nowMs) {
      const ok = Array.isArray(target) && target.length === 21;
      if (!ok) {
        if (pts && nowMs - lastTargetMs > holdMs) pts = null;
        lastMs = nowMs;
        return pts;
      }
      if (!pts || nowMs - lastTargetMs > snapMs) pts = target.map(p => p.slice());     // (re)appeared: no easing in from a stale place
      else {
        const dt = Math.max(0, nowMs - (lastMs ?? nowMs));
        const a = centre(pts), b = centre(target), whole = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        pts = pts.map((p, i) => {
          const t = target[i], err = Math.max(whole, Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]));
          const k = Math.min(1, err / errRefCm), tau = tauStillMs + (tauFastMs - tauStillMs) * k;
          const f = 1 - Math.exp(-dt / tau);
          return [p[0] + (t[0] - p[0]) * f, p[1] + (t[1] - p[1]) * f, p[2] + (t[2] - p[2]) * f];
        });
      }
      lastMs = lastTargetMs = nowMs;
      return pts;
    },
  };
}

// ---------------------------------------------------------------- the hand as HoloDesk drew it: in black
//
// A Pepper's ghost cannot put a virtual cube BEHIND your real hand: the panel's light is added on top of
// whatever is under the sheet, so the cube shines straight through your fingers and the eye reads it as in
// front. HoloDesk's answer, and this: draw the hand in BLACK, with depth. Black is no light at all, so where
// the drawn hand is nearer the eye than the cube, the cube's pixels go dark and your real hand is what you
// see there - occlusion, from the only colour an additive display can subtract with.
//
// It is only as good as the tracking: where the black hand misses the real one, it bites a hand-shaped hole
// out of the cube beside your fingers. So it is drawn a little THINNER than a hand (a missing sliver of
// occlusion is far less ugly than a hole in the wrong place) and the demo can swap it for the skeleton (O).
const PALM_FAN = [[0, 1, 5], [0, 5, 9], [0, 9, 13], [0, 13, 17], [1, 2, 5]];
const PALM_BONES = new Set(['0-1', '0-5', '5-9', '9-13', '13-17', '0-17']);
export function makeHandMask(THREE, { fingerCm = 0.7, palmCm = 0.95 } = {}) {
  const group = new THREE.Group();
  group.visible = false;
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.DoubleSide });
  const sphere = new THREE.SphereGeometry(1, 12, 8), cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const joints = Array.from({ length: 21 }, (_, i) => {
    const m = new THREE.Mesh(sphere, black);
    m.scale.setScalar([0, 1, 5, 9, 13, 17].includes(i) ? palmCm : fingerCm);
    group.add(m); return m;
  });
  const bones = BONES.map(() => { const m = new THREE.Mesh(cyl, black); group.add(m); return m; });
  const palmGeo = new THREE.BufferGeometry(), palmPos = new Float32Array(PALM_FAN.length * 9);
  palmGeo.setAttribute('position', new THREE.BufferAttribute(palmPos, 3));
  const palm = new THREE.Mesh(palmGeo, black);
  palm.frustumCulled = false;                       // its bounds change every frame and are never recomputed
  group.add(palm);
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  return {
    group,
    update(pointsRig) {
      if (!pointsRig || pointsRig.length !== 21) { group.visible = false; return; }
      group.visible = true;
      pointsRig.forEach((p, i) => joints[i].position.set(p[0], p[1], p[2]));
      BONES.forEach(([a, b], k) => {
        const t = boneTransform(pointsRig[a], pointsRig[b]), m = bones[k], r = PALM_BONES.has(`${a}-${b}`) ? palmCm : fingerCm;
        m.position.set(t.mid[0], t.mid[1], t.mid[2]);
        m.scale.set(r, Math.max(t.len, 1e-6), r);
        m.quaternion.setFromUnitVectors(up, dir.set(t.dir[0], t.dir[1], t.dir[2]));
      });
      PALM_FAN.forEach((tri, k) => tri.forEach((j, c) => palmPos.set(pointsRig[j], k * 9 + c * 3)));
      palmGeo.attributes.position.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- which frames to believe
//
// Every hand the bridge sends comes with a confidence (gestures.tracking_confidence: the landmarker's own
// score, times where the depth came from - both lenses, or a guess from one). This decides what to do with
// it. At or above minConf the frame is used. Below it the frame is NOT drawn: the hand is assumed to be
// exactly where it last was, the last trusted pose - and the last trusted pinch, so a cube in the fingers
// stays in them. A hand that stops arriving altogether is treated the same way; "I am not sure" and "I
// cannot see it" get one answer. After holdMs without a trusted frame the hand goes.
//
// A frozen hand needs a slightly better frame to thaw than it took to stay thawed (hysteresis), or a
// confidence sitting on the threshold flips the hand between live and frozen thirty times a second - which
// is the instability this exists to remove.
//
// It also keeps the last few seconds of what it saw, because the threshold is a thing to be CALIBRATED: the
// panel (index.html, Q) shows what fraction of frames the current number trusts and what confidences the
// rig actually produces, which is the only honest way to choose it.
export const GATE_DEFAULTS = { minConf: 0.45, holdMs: 1000, hysteresis: 0.04, windowMs: 5000 };
export function validGate(g) {
  const ok = g && Number.isFinite(g.minConf) && g.minConf >= 0 && g.minConf <= 1 && Number.isFinite(g.holdMs) && g.holdMs >= 0 && g.holdMs <= 60000;
  return ok ? { minConf: +g.minConf, holdMs: +g.holdMs } : { minConf: GATE_DEFAULTS.minConf, holdMs: GATE_DEFAULTS.holdMs };
}
export function makeHandGate(opts = {}) {
  const o = { ...GATE_DEFAULTS, ...opts };
  let good = null, goodAt = -1e9, tracking = false, lastId = null, conf = null, state = 'gone';
  const seen = [];                                            // [ms, confidence, trusted] per distinct frame
  return {
    options: o,
    get state() { return state; },
    reset() { good = null; goodAt = -1e9; tracking = false; lastId = null; conf = null; state = 'gone'; seen.length = 0; },
    // sample: { points, pinch, conf, id } for the newest fresh frame (the same one may be handed in on several
    // drawn frames; `id` tells them apart), or null when nothing fresh has arrived.
    update(sample, nowMs) {
      let trusted = false;
      if (sample && Array.isArray(sample.points) && sample.points.length === 21) {
        conf = Number.isFinite(sample.conf) ? sample.conf : 1;       // a bridge too old to say is taken at its word
        trusted = conf >= o.minConf + (tracking ? 0 : o.hysteresis) || (!tracking && conf >= 1 - 1e-9);
        if (sample.id !== lastId || sample.id == null) { seen.push([nowMs, conf, trusted]); lastId = sample.id; }
      } else conf = null;
      while (seen.length && nowMs - seen[0][0] > o.windowMs) seen.shift();
      if (trusted) { good = { points: sample.points, pinch: sample.pinch ?? null }; goodAt = nowMs; tracking = true; state = 'tracking'; }
      else {
        tracking = false;
        if (good && nowMs - goodAt <= o.holdMs) state = sample ? 'holding-unsure' : 'holding-lost';
        else { good = null; state = 'gone'; }
      }
      return { points: good ? good.points : null, pinch: good ? good.pinch : null, state, conf, heldMs: good && state !== 'tracking' ? nowMs - goodAt : 0 };
    },
    // what the last windowMs looked like: for choosing the threshold by looking instead of guessing
    stats() {
      const c = seen.map(r => r[1]).sort((a, b) => a - b), n = c.length;
      return { frames: n, trusted: n ? seen.filter(r => r[2]).length / n : null,
               lowest: n ? c[0] : null, typical: n ? c[Math.floor(n / 2)] : null };
    },
  };
}
