// Every number the grab behaviour depends on, in one object, so it can be tuned from the demo page's sliders
// (or a saved profile) without touching code. Lengths are METRES, times are MILLISECONDS, angles are radians.
//
// Where the numbers come from: the pinch on/off pair, the re-grab lockout, the throw window and the speed clamp
// are Ultraleap's shipped defaults (UnityPlugin, Apache-2.0 — compatible with our GPL-3.0; see NOTICE). The
// filter settings come from the rig's own error budget in docs/v3-calibration.md. The rest is ours.

export const GRAB_CONFIG = {
  // ---------- pinch detection ----------
  pinchOn: 0.025,             // thumb tip to index tip below this closes the pinch (Ultraleap PinchDetector 25 mm)
  pinchOff: 0.030,            // and must open past this to release (30 mm). Never one threshold: see TUNING_NOTES.
  pinchHoldMs: 40,            // closed this long before it counts (2-3 frames at 30-60 Hz kills single-frame blips)
  releaseHoldMs: 60,          // open this long before it counts
  pinchStick: 0.85,           // a finger already pinching has its measured gap scaled by this, so an established
                              // grab is stickier than a new one (Ultraleap GrabHelperObject does the same)

  // ---------- choosing what you grabbed ----------
  grabRadius: 0.07,           // pinch point within this of a body's pick sphere can take it
  intentMs: 400,              // a pinch takes what the open hand was nearest this recently: closing the fingers
                              // moves the pinch point several cm, which would otherwise lose the target
  intentSwitchMs: 120,        // a different body must stay the better choice this long before it steals intent
  intentStealMargin: 0.015,   // ...and be this much nearer. Together: one jittery frame cannot change your mind.
  regrabLockoutMs: 500,       // after a release, that hand ignores the body it just dropped (Ultraleap 0.5 s)

  // ---------- holding ----------
  dropoutMs: 200,             // the hand may vanish this long without dropping what it holds. It keeps its
                              // anchor offset across the gap and eases back in, so nothing snaps or drifts.
  hold: {                     // 1 Euro on the pinch point while holding: steadier than while pointing
    minCutoff: 0.8, beta: 12, dCutoff: 0.8, speedFloor: 0.10,
  },
  point: {                    // 1 Euro on the pinch point while open (hover/aim): livelier
    minCutoff: 1.2, beta: 40, dCutoff: 1.0, speedFloor: 0.06,
  },
  holdDeadband: 0.0015,       // 1.5 mm: below the tracker's own noise floor, above the eye's
  holdFollowHz: 9,            // critically damped follow of the held body toward the anchor; 0 = rigid

  // ---------- two hands ----------
  twoHandMinSpan: 0.05,       // hands closer than this give a noisy axis: hold the last rotation instead
  scaleMin: 0.15,             // limits on userScale, so a bad frame cannot shrink the model to nothing
  scaleMax: 8,
  scaleDeadband: 0.02,        // ignore the first 2% of span change, so a two-hand rotate does not also resize

  // ---------- release and settle ----------
  releaseLagMs: 100,          // release never uses a pose newer than this: the fingers opening flicks the pinch
                              // point, and the user means "let go here", not "here plus the flick"
  releasePreMs: 50,           // ...and preferably one from this long before the pinch was last FIRMLY shut,
                              // which is where the lurch really begins (see endHold in grab.js)
  velocityWindowMs: 45,       // mean velocity over this window, ending at the pre-flick time (Ultraleap 45 ms)
  maxSpeed: 10,               // m/s clamp on that velocity (Ultraleap MAX_VELOCITY_SQUARED = 100)
  throwGain: 0.3,             // how much of it the settle keeps. 0 = it just drops where you left it.
  settleGravity: 1.6,         // m/s^2. Real g feels violent in a 30 cm volume; this reads as "set down".
  settleDrag: 2.2,            // per second, horizontal
  settleBounce: 0.12,
  settleRestSpeed: 0.02,      // below this at the floor, it is at rest
  settleMaxMs: 2500,          // give up and snap to rest (a settle must never run forever on the rig)

  // ---------- the working volume, in world units ----------
  // Everything the hands can reach under the acrylic. A dropped body falls to `floorY` and stays inside the box.
  volume: { minX: -0.15, maxX: 0.15, minY: 0.0, maxY: 0.30, minZ: -0.12, maxZ: 0.12 },
  floorY: 0.0,
  clampToVolume: true,
};

// Which of these actually matter, per the research pass. Read this before turning knobs.
export const TUNING_NOTES = [
  ['pinchOn / pinchOff', 'critical',
   'Two thresholds, never one. A single threshold flutters at the boundary at the exact moment the user is ' +
   'trying to hold still. 25/30 mm are Ultraleap\'s shipped defaults and sit well clear of the 3-7 mm ' +
   'fingertip error the ZED pair gives at 0.4-0.8 m, so the margin is real, not nominal.'],
  ['dropoutMs', 'critical',
   'The single biggest difference between this and a hand tracker built for clean 120 Hz data. MediaPipe on ' +
   'stereo halves drops hands; without a hold-through window the model is released every time a hand flickers, ' +
   'and no threshold tuning fixes that. 200 ms covers a 6-frame gap at 30 Hz.'],
  ['releaseLagMs', 'critical',
   'Opening the fingers moves the pinch point by centimetres in the wrong direction. Taking the pose from ' +
   '~100 ms earlier is the difference between "put it down" and "flung it". Same idea as Ultraleap\'s throw ' +
   'smoothing and Unity XRI\'s.'],
  ['hold.minCutoff / hold.beta / speedFloor', 'critical',
   'Sets whether a held object shakes. speedFloor is ours: plain 1 Euro reads its own input noise as speed and ' +
   'opens the cutoff when the hand is still, which is when shake is most visible. Raise speedFloor to just ' +
   'above the tracker\'s measured still-hand speed.'],
  ['intentMs / intentSwitchMs / intentStealMargin', 'important',
   'Closing the fingers moves the grab point, so what you were nearest a moment ago is a better answer than ' +
   'what you are nearest now. The switch delay and margin stop a single noisy frame from handing the grab to a ' +
   'neighbouring part.'],
  ['grabRadius', 'important',
   'Must exceed the tracker\'s worst-case error (say 3x the ~7 mm p95) or grabs will miss. Too large and ' +
   'neighbouring parts fight; 70 mm is a compromise for a 30 cm volume.'],
  ['holdFollowHz / holdDeadband', 'important',
   'Cosmetic but they are what makes it read as solid. 9 Hz is above the hand\'s own bandwidth (~5 Hz) so there ' +
   'is no felt lag, while still suppressing frame-to-frame noise. Set holdFollowHz to 0 for a rigid attachment.'],
  ['regrabLockoutMs', 'nice',
   'Stops an object being caught again by the hand that just let it go. Only matters once throwGain > 0.'],
  ['settleGravity / throwGain', 'nice',
   'Feel only. Real gravity (9.81) crosses a 30 cm volume in 0.25 s and looks like a dropped brick.'],
  ['twoHandMinSpan / scaleDeadband', 'nice',
   'Only bite in two-hand mode; the span deadband is what keeps a pure rotate from also resizing.'],
];

// The config is in metres because the sensors are. A caller whose scene is in centimetres passes 100.
export function scaleConfig(cfg, unitsPerMetre) {
  const s = unitsPerMetre;
  const box = cfg.volume;
  return {
    ...cfg,
    pinchOn: cfg.pinchOn * s, pinchOff: cfg.pinchOff * s,
    grabRadius: cfg.grabRadius * s, intentStealMargin: cfg.intentStealMargin * s,
    // 1 Euro beta is Hz per unit-of-speed, so it scales the other way; minCutoff is already in Hz
    hold: { ...cfg.hold, beta: cfg.hold.beta / s, speedFloor: cfg.hold.speedFloor * s },
    point: { ...cfg.point, beta: cfg.point.beta / s, speedFloor: cfg.point.speedFloor * s },
    holdDeadband: cfg.holdDeadband * s,
    twoHandMinSpan: cfg.twoHandMinSpan * s,
    maxSpeed: cfg.maxSpeed * s, settleGravity: cfg.settleGravity * s, settleRestSpeed: cfg.settleRestSpeed * s,
    volume: { minX: box.minX * s, maxX: box.maxX * s, minY: box.minY * s, maxY: box.maxY * s,
              minZ: box.minZ * s, maxZ: box.maxZ * s },
    floorY: cfg.floorY * s,
  };
}

export const cloneConfig = cfg => structuredClone(cfg);
