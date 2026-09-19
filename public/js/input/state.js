import * as THREE from 'three';

// The one shared input object. Input sources write here (webcam and mouse now, a Kinect later);
// interaction and modeling code only ever read from here, so a new source needs no changes there.
// World frame: origin at the centre of the physical display, x right, y up, z out of the screen toward you, cm.
const hand = () => ({
  active: false,                         // seen in the last 300 ms
  tip: new THREE.Vector3(0, 0, 25),      // index fingertip (filtered): what you point with
  grip: new THREE.Vector3(0, 0, 25),     // between thumb and index tip (filtered): what a pinch holds
  pinch: false,
  pinchRatio: 1,
  gripRaw: new THREE.Vector3(0, 0, 25),  // unfiltered grip, matching jointsWorld
  jointsWorld: null,                     // Float32Array(21 * 3), all hand landmarks in world cm (unfiltered)
  seenAt: -1e9,
});

export const input = {
  mode: 'none',                        // 'camera' | 'mouse'
  eye: new THREE.Vector3(0, 0, 55),    // the viewer's eye
  faceSeenAt: -1e9,
  hands: [hand(), hand()],             // slot 0 starts as the hand further left; slots then follow each hand
};
