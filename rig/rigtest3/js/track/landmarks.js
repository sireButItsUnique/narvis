// MediaPipe landmark layouts, and the anatomy constants the single-camera fallback needs.
// Keeping the magic indices in one place means the solver, the simulator and the tests cannot disagree.

// ---------- hand (MediaPipe Hand Landmarker, 21 points) ----------
export const HAND = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
  COUNT: 21,
};

// Bones, for drawing and for the bone-length sanity check.
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

// Average adult hand, millimetres. The mono fallback scales the whole hand so that whichever of these two
// spans looks longest in the image matches: the longer one is the one least foreshortened.
export const PALM = { wristToMiddleMcpMm: 85, indexToPinkyMcpMm: 70 };

// Ultraleap's published pinch thresholds (Apache-2.0 PinchDetector: 25 mm in, 30 mm out). Hysteresis is
// not optional — a single threshold chatters at exactly the distance people hold a pinch at.
export const PINCH = { closeMm: 25, openMm: 30, holdFrames: 2, releaseHoldMs: 200 };

// ---------- face (MediaPipe Face Landmarker, 478 points with the iris refinement) ----------
export const FACE = {
  LEFT_IRIS: 473, RIGHT_IRIS: 468,          // as they appear in the RAW (unmirrored) image
  LEFT_EYE_INNER: 362, LEFT_EYE_OUTER: 263,
  RIGHT_EYE_INNER: 133, RIGHT_EYE_OUTER: 33,
  NOSE_TIP: 1,
};
export const FACE_TRACKED = [FACE.RIGHT_IRIS, FACE.LEFT_IRIS];

// Adult interpupillary distance spans about 54-72 mm. Assuming the mean is a systematic depth error of
// about +-7% for one camera, which is why a one-off per-user calibration is worth more than a second camera.
export const IPD = { defaultMm: 63, minMm: 50, maxMm: 76 };

/** Landmarks as MediaPipe gives them (normalised 0..1) -> pixels for a frame of this size. */
export const toPixels = (lm, width, height) => lm.map(p => ({ u: p.x * width, v: p.y * height, z: p.z }));

/** A 21x3 Float32Array from an array of [x,y,z] (or nulls, which become NaN). */
export function packPoints(points) {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    out[i * 3] = p ? p[0] : NaN; out[i * 3 + 1] = p ? p[1] : NaN; out[i * 3 + 2] = p ? p[2] : NaN;
  });
  return out;
}
export const unpackPoint = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];

/** Mean bone-length error against a reference hand, mm. A cheap "is this reconstruction sane" number. */
export function boneLengthSpreadMm(points) {
  const lens = [];
  for (const [a, b] of HAND_BONES) {
    const p = points[a], q = points[b];
    if (!p || !q) continue;
    lens.push(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  if (lens.length < 4) return null;
  const m = lens.reduce((x, y) => x + y, 0) / lens.length;
  return Math.sqrt(lens.reduce((s, l) => s + (l - m) * (l - m), 0) / lens.length);
}
