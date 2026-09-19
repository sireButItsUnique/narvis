// Point from your eye through your fingertip (or the mouse), pinch to grab the model, push toward the screen to send it deeper.
import * as THREE from 'three';
import { scene, canvas, rect, boxDepth } from './view.js';
import { input } from './input/state.js';
import { model, beginGrab, endGrab, clampPosition, highlight } from './model.js';

const raycaster = new THREE.Raycaster();
let hovered = null, grabbed = null, wasPinch = false;
// last part under the open-hand pointer: pinching drags the index tip off target, so a fresh pinch grabs this
const aim = { obj: null, dist: 0, t: -1e9 };
const grab = { dist: 0, offset: new THREE.Vector3(), handZ0: 0 };
const mouse = { x: 0.5, y: 0.5, down: false, onScreen: false };

// pointing cursor (drawn on the glass) + beam into the box
const cursor = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.65, 32),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.9, depthTest: false }));
cursor.renderOrder = 10; cursor.visible = false;
const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.6 }));
beam.visible = false; beam.frustumCulled = false;
scene.add(cursor, beam);

// the part you're pointing at right now, for "delete that"
export const hoveredPart = () => hovered;

function pointerRay() {
  const eye = input.eye;
  if (input.mode === 'mouse') {   // ray from the (simulated) eye through the mouse point on the glass
    const p = new THREE.Vector3(rect.x0 + mouse.x * rect.w, rect.y1 - mouse.y * rect.h, 0);
    return { dir: p.sub(eye).normalize(), active: mouse.onScreen, pinch: mouse.down, handZ: 0 };
  }
  const hand = input.hands[0];
  return { dir: hand.tip.clone().sub(eye).normalize(), active: hand.active, pinch: hand.pinch, handZ: hand.tip.z };
}

function release() { grabbed = null; endGrab(); }

export function updateInteraction() {
  const { dir, active, pinch, handZ } = pointerRay();
  const eye = input.eye;
  const onset = pinch && !wasPinch; wasPinch = pinch;
  if (grabbed && grabbed !== model.group) release();   // the model was rebuilt or cleared mid-grab
  const targets = model.meshes;

  if (!active || dir.z > -1e-3) {
    cursor.visible = beam.visible = false; hovered = null;
    if (grabbed && !pinch) release();
    highlight(null, !!grabbed);
    return;
  }
  const tGlass = -eye.z / dir.z;
  const onGlass = eye.clone().addScaledVector(dir, tGlass);
  cursor.position.set(onGlass.x, onGlass.y, 0.05);
  cursor.material.color.set(pinch ? 0xffb23e : 0x35d0ff);
  raycaster.set(eye, dir);
  const hits = grabbed || !targets.length ? [] : raycaster.intersectObjects(targets, false);
  hovered = grabbed ? null : (hits[0]?.object || null);

  const tNow = performance.now();
  if (!pinch && hits.length) { aim.obj = hits[0].object; aim.dist = hits[0].distance; aim.t = tNow; }
  // on pinch onset, grab what was highlighted just before the fingers closed
  const useAim = onset && !grabbed && input.mode === 'camera' && aim.obj && tNow - aim.t < 400 && targets.includes(aim.obj);

  if (pinch && !grabbed && model.group && (hits.length || useAim)) {
    grabbed = model.group;
    grab.dist = useAim ? aim.dist : hits[0].distance;
    grab.offset.copy(grabbed.position).sub(eye.clone().addScaledVector(dir, grab.dist));
    grab.handZ0 = handZ;
    beginGrab();
  } else if (!pinch && grabbed) {
    release();
  }

  let endT = (eye.z + boxDepth) / -dir.z;   // default: beam reaches the back wall
  if (grabbed) {
    // push your hand toward the screen to send the model deeper
    const t = grab.dist + (grab.handZ0 - handZ) * 2.0;
    const target = clampPosition(eye.clone().addScaledVector(dir, t).add(grab.offset));
    grabbed.position.lerp(target, 0.5);
    endT = eye.distanceTo(grabbed.position.clone().sub(grab.offset));
  } else if (hits.length) {
    endT = hits[0].distance;
  }
  highlight(hovered, !!grabbed);
  const end = eye.clone().addScaledVector(dir, endT);
  beam.geometry.setFromPoints([onGlass, end]);
  cursor.visible = beam.visible = true;
}

// ---------- mouse mode: mouse = your head; drag = grab ----------
addEventListener('pointermove', e => {
  mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; mouse.onScreen = true;
  if (input.mode === 'mouse' && !mouse.down) {
    input.eye.x = rect.cx + (mouse.x - 0.5) * rect.w * 1.6;
    input.eye.y = rect.cy - (mouse.y - 0.5) * rect.h * 1.6;
  }
});
addEventListener('pointerleave', () => { mouse.onScreen = false; });
addEventListener('pointerdown', e => { if (e.target === canvas) mouse.down = true; });
addEventListener('pointerup', () => { mouse.down = false; });
addEventListener('wheel', e => { if (input.mode === 'mouse') input.eye.z = THREE.MathUtils.clamp(input.eye.z + e.deltaY * 0.03, 15, 150); }, { passive: true });
