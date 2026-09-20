// What you see of your hands: a cursor on the glass and a beam into the box per hand, a ghost copy of each
// hand at the end of its beam (so a pinch visibly grabs the surface), and the brush ring while sculpting.
import * as THREE from 'three';
import { scene } from './view.js';

const HAND_COLORS = [0x35d0ff, 0x7cff9b];
const PINCH_COLOR = 0xffb23e;
const GHOST_SCALE = 0.5;
// MediaPipe hand skeleton
const BONES = [0, 1, 1, 2, 2, 3, 3, 4, 0, 5, 5, 6, 6, 7, 7, 8, 5, 9, 9, 10, 10, 11, 11, 12,
               9, 13, 13, 14, 14, 15, 15, 16, 13, 17, 0, 17, 17, 18, 18, 19, 19, 20];

// toneMapped: false everywhere here: these are UI colours, not lit surfaces
const vis = HAND_COLORS.map(color => {
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.65, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
  cursor.renderOrder = 10;
  const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, toneMapped: false }));
  const ghostGeo = new THREE.BufferGeometry();
  ghostGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(21 * 3), 3));
  ghostGeo.setIndex(BONES);
  // drawn over the model (no depth test) so you can always see where your hand is, even inside the clay
  const bones = new THREE.LineSegments(ghostGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, depthTest: false, toneMapped: false }));
  const joints = new THREE.Points(ghostGeo, new THREE.PointsMaterial({ color, size: 0.35, transparent: true, opacity: 0.7, depthTest: false, toneMapped: false }));
  bones.renderOrder = joints.renderOrder = 9;
  for (const o of [cursor, beam, bones, joints]) { o.visible = false; o.frustumCulled = false; scene.add(o); }
  return { color, cursor, beam, bones, joints };
});

const brushRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide, toneMapped: false }));
brushRing.renderOrder = 11;
brushRing.visible = false;
scene.add(brushRing);

const Z = new THREE.Vector3(0, 0, 1);

// pointers: [{ active, dir, pinch, end (world point the beam reaches), hand (input hand or null) }]
// brush: { point, normal, radius } in world units, or null
// On the rig the hand is not drawn as bones: the real hand is right there under the glass, and what the
// picture owes it is OCCLUSION (rig/hands.js makeHandMask, driven from main.js). The cursor, the beam and
// the brush ring stay - they say what the hand is pointing at, which the real hand cannot.
let bonesOn = true;
export function setBonesVisible(on) { bonesOn = !!on; }
export function updateViz(pointers, eye, brush) {
  vis.forEach((v, i) => {
    const p = pointers[i];
    const show = !!p && p.active && p.dir.z < -1e-3;
    v.cursor.visible = v.beam.visible = show;
    v.bones.visible = v.joints.visible = bonesOn && show && !!p.hand?.jointsWorld;
    if (!show) return;
    const onGlass = eye.clone().addScaledVector(p.dir, -eye.z / p.dir.z);
    v.cursor.position.set(onGlass.x, onGlass.y, 0.05);
    v.cursor.material.color.set(p.pinch ? PINCH_COLOR : v.color);
    v.beam.geometry.setFromPoints([onGlass, p.end]);
    if (v.bones.visible) {
      // the real hand, shrunk, with its pinch point sitting where the beam ends
      const src = p.hand.jointsWorld, g = p.hand.gripRaw, arr = v.bones.geometry.attributes.position.array;
      for (let j = 0; j < 21; j++) {
        arr[j * 3]     = p.end.x + (src[j * 3]     - g.x) * GHOST_SCALE;
        arr[j * 3 + 1] = p.end.y + (src[j * 3 + 1] - g.y) * GHOST_SCALE;
        arr[j * 3 + 2] = p.end.z + (src[j * 3 + 2] - g.z) * GHOST_SCALE;
      }
      v.bones.geometry.attributes.position.needsUpdate = true;
      v.bones.material.color.set(p.pinch ? PINCH_COLOR : v.color);
    }
  });

  brushRing.visible = !!brush;
  if (brush) {
    brushRing.position.copy(brush.point).addScaledVector(brush.normal, 0.05);
    brushRing.quaternion.setFromUnitVectors(Z, brush.normal);
    brushRing.scale.setScalar(brush.radius);
  }
}
