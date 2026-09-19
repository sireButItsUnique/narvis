import * as THREE from 'three';
import { S } from './settings.js';

// ---------- physical geometry ----------
// World frame: origin at the centre of the physical display, x right, y up, z out of the screen toward you.
export function displayCm() {
  const aspect = screen.width / screen.height;
  const diag = S.diagIn * 2.54;
  const W = diag * aspect / Math.hypot(aspect, 1);
  return { W, H: W / aspect, cmPerPx: W / screen.width };
}
// The canvas rectangle in world coordinates (the "window" we look through).
export function canvasRect() {
  const { W, H, cmPerPx } = displayCm();
  let leftPx = 0, topPx = 0;
  if (!document.fullscreenElement) {   // rough estimate when windowed; fullscreen is exact
    const border = Math.max(0, (outerWidth - innerWidth) / 2);
    leftPx = (screenX - (screen.availLeft || 0)) + border;
    topPx = (screenY - (screen.availTop || 0)) + Math.max(0, outerHeight - innerHeight - border);
  }
  const w = innerWidth * cmPerPx, h = innerHeight * cmPerPx;
  const cx = (leftPx + innerWidth / 2 - screen.width / 2) * cmPerPx;
  const cy = (screen.height / 2 - (topPx + innerHeight / 2)) * cmPerPx;
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2, cx, cy, w, h, W, H };
}
export const webcamPos = () => new THREE.Vector3(S.camXCm, displayCm().H / 2 + S.camAboveCm, 0);
export const focalPx = (vw) => (vw / 2) / Math.tan(S.hfovDeg * Math.PI / 360);

// ---------- three.js setup ----------
export const canvas = document.getElementById('htw-view');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x04060b);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera();   // projection is set manually every frame (off-axis)
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a0f18, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

let room = new THREE.Group(); scene.add(room);
export let rect = canvasRect();
export let boxDepth = 30;

function gridLines(origin, u, v, uLen, vLen, step, pts) {
  const nu = Math.max(1, Math.round(uLen / step)), nv = Math.max(1, Math.round(vLen / step));
  for (let i = 0; i <= nu; i++) {
    const a = origin.clone().addScaledVector(u, uLen * i / nu);
    pts.push(a, a.clone().addScaledVector(v, vLen));
  }
  for (let j = 0; j <= nv; j++) {
    const a = origin.clone().addScaledVector(v, vLen * j / nv);
    pts.push(a, a.clone().addScaledVector(u, uLen));
  }
}

// The box behind the screen: grid walls, a floor and back wall that catch shadows, and the window frame.
export function buildRoom() {
  scene.remove(room);
  room.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  room = new THREE.Group(); scene.add(room);

  rect = canvasRect();
  const { x0, x1, y0, y1, cx, cy, w, h } = rect;
  const D = boxDepth = THREE.MathUtils.clamp(w * 0.9, 15, 90);
  const step = w / 10;

  // grid walls: floor, ceiling, left, right, back
  const pts = [];
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Zm = new THREE.Vector3(0, 0, -1);
  gridLines(new THREE.Vector3(x0, y0, 0), X, Zm, w, D, step, pts);   // floor
  gridLines(new THREE.Vector3(x0, y1, 0), X, Zm, w, D, step, pts);   // ceiling
  gridLines(new THREE.Vector3(x0, y0, 0), Y, Zm, h, D, step, pts);   // left
  gridLines(new THREE.Vector3(x1, y0, 0), Y, Zm, h, D, step, pts);   // right
  gridLines(new THREE.Vector3(x0, y0, -D), X, Y, w, h, step, pts);   // back
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x1f6f99, transparent: true, opacity: 0.75 }));
  room.add(grid);

  // solid floor + back wall to catch shadows
  const surf = new THREE.MeshStandardMaterial({ color: 0x0a1826, roughness: 1, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, D), surf);
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, y0 - 0.02, -D / 2); floor.receiveShadow = true;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), surf.clone());
  back.position.set(cx, cy, -D - 0.02); back.receiveShadow = true;
  room.add(floor, back);

  // the "window frame" at the screen plane
  const frame = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0 + 0.15, y0 + 0.15, 0), new THREE.Vector3(x1 - 0.15, y0 + 0.15, 0),
    new THREE.Vector3(x1 - 0.15, y1 - 0.15, 0), new THREE.Vector3(x0 + 0.15, y1 - 0.15, 0)]),
    new THREE.LineBasicMaterial({ color: 0x35d0ff }));
  room.add(frame);

  // light from above and slightly in front, shadows fall on floor/back wall
  sun.position.set(cx - w * 0.2, y1 + h * 1.5, 25);
  sun.target.position.set(cx, y0, -D / 2);
  const sc = sun.shadow.camera, ext = Math.max(w, h, D) * 1.2;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 400;
  sc.updateProjectionMatrix();
}

// ---------- off-axis ("window") projection ----------
export function applyOffAxis(e) {
  const n = 1, f = 1000;
  const ez = Math.max(e.z, 5);
  const l = (rect.x0 - e.x) * n / ez, r = (rect.x1 - e.x) * n / ez;
  const b = (rect.y0 - e.y) * n / ez, t = (rect.y1 - e.y) * n / ez;
  camera.position.set(e.x, e.y, ez);
  camera.quaternion.identity();                     // screen is the z=0 plane, so the view stays straight ahead
  camera.projectionMatrix.makePerspective(l, r, t, b, n, f);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  // never call camera.updateProjectionMatrix() — it would overwrite this
}
