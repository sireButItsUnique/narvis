import * as THREE from 'three';

// The one shared input object. Input sources write here (webcam and mouse now, a Kinect later);
// interaction and modeling code only ever read from here, so a new source needs no changes there.
// World frame: origin at the centre of the physical display, x right, y up, z out of the screen toward you, cm.
export const input = {
  mode: 'none',                        // 'camera' | 'mouse'
  eye: new THREE.Vector3(0, 0, 55),    // the viewer's eye
  faceSeenAt: -1e9,
  hands: [
    { active: false, tip: new THREE.Vector3(0, 0, 25), pinch: false, pinchRatio: 1, joints: null, seenAt: -1e9 },
  ],
};
