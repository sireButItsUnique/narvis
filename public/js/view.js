import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
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
// Lit like Blender's own renders of Fable's models (AgX, a near-black world, a 3.5 key sun and a 1.2 fill).
// Blender uses AgX, but three r170's AgX turned the teapot's teal glaze pale mint and the navy box grey;
// Khronos PBR Neutral matched Blender's render of the same teapot, so that's the tone mapper here.
// The HUD-like room parts opt out with toneMapped: false so their colours stay exact.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputColorSpace = THREE.SRGBColorSpace;

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera();   // projection is set manually every frame (off-axis)
// image-based light, so metal, gold and clearcoat reflect something (black otherwise); dim, like Blender's world
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.2;
pmrem.dispose();
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.08;   // cm; without it a strong sun draws acne stripes across smooth glazes
const fill = new THREE.DirectionalLight(0xffffff, 1);
scene.add(sun, sun.target, fill, fill.target);

// Every picture drawn per frame. One full-window view now; the Pepper's-ghost stage adds more (M7).
export const views = [{ camera, viewport: null }];   // viewport: [x, y, w, h] in CSS px from bottom left
export function renderViews() {
  for (const v of views) {
    if (v.viewport) {
      renderer.setViewport(...v.viewport);
      renderer.setScissor(...v.viewport);
      renderer.setScissorTest(true);
    }
    renderer.render(scene, v.camera);
    if (v.viewport) {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    }
  }
}

// 'clay view': one neutral matte material on every part, for reading the form without colour or gloss
export const clayMaterial = new THREE.MeshStandardMaterial({ color: 0xb9b3aa, roughness: 0.82, metalness: 0,
                                                              side: THREE.DoubleSide, name: 'clay' });

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
    new THREE.LineBasicMaterial({ color: 0x1f6f99, transparent: true, opacity: 0.75, toneMapped: false }));
  room.add(grid);

  // solid floor + back wall to catch shadows; barely lit by the environment so the box stays dark
  const surf = new THREE.MeshStandardMaterial({ color: 0x0a1826, roughness: 1, metalness: 0, envMapIntensity: 0.15 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, D), surf);
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, y0 - 0.02, -D / 2); floor.receiveShadow = true;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), surf.clone());
  back.position.set(cx, cy, -D - 0.02); back.receiveShadow = true;
  room.add(floor, back);

  // the "window frame" at the screen plane
  const frame = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0 + 0.15, y0 + 0.15, 0), new THREE.Vector3(x1 - 0.15, y0 + 0.15, 0),
    new THREE.Vector3(x1 - 0.15, y1 - 0.15, 0), new THREE.Vector3(x0 + 0.15, y1 - 0.15, 0)]),
    new THREE.LineBasicMaterial({ color: 0x35d0ff, toneMapped: false }));
  room.add(frame);

  // light from above and slightly in front, shadows fall on floor/back wall
  sun.position.set(cx - w * 0.2, y1 + h * 1.5, 25);
  sun.target.position.set(cx, y0, -D / 2);
  const sc = sun.shadow.camera, ext = Math.max(w, h, D) * 1.2;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 400;
  sc.updateProjectionMatrix();
  // fill from the front right, low, so the shadow side isn't black
  fill.position.set(cx + w, cy, 40);
  fill.target.position.set(cx, y0, -D / 2);
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
