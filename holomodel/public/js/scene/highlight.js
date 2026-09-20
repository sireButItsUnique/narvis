// Hover and active-part highlight: an additive fresnel shell drawn over the part with the part's own geometry.
// It never touches the part's materials, so shared, textured or genuinely glowing materials stay as they are.
import * as THREE from 'three';

const vertexShader = `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const fragmentShader = `
uniform vec3 color;
uniform float base;
uniform float rim;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.5);
  gl_FragColor = vec4(color * (base + rim * f), 1.0);
}`;

function overlayMaterial(color, base, rim) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, base: { value: base }, rim: { value: rim } },
    vertexShader, fragmentShader,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    depthFunc: THREE.LessEqualDepth,   // same geometry, same depth: draws exactly over the part
    side: THREE.DoubleSide, toneMapped: false,
  });
}

export const LOOKS = {
  hover: overlayMaterial(0x35d0ff, 0.05, 0.9),
  active: overlayMaterial(0xffb23e, 0.08, 1.1),
  all: overlayMaterial(0x35d0ff, 0.02, 0.45),   // the whole model while it's being moved
};

const overlays = new WeakMap();
let shown = new Map();

function overlayOf(mesh) {
  let o = overlays.get(mesh);
  if (!o) {
    o = new THREE.Mesh(mesh.geometry, LOOKS.hover);
    o.raycast = () => {};
    o.renderOrder = 5;
    o.castShadow = o.receiveShadow = false;
    overlays.set(mesh, o);
  }
  o.geometry = mesh.geometry;   // the part may have been given new geometry since
  if (o.parent !== mesh) mesh.add(o);
  return o;
}

// meshes: the parts that can be highlighted; hovered/active: part meshes or null; all: highlight everything
export function highlight(meshes, { hovered = null, active = null, all = false } = {}) {
  const next = new Map();
  if (all) for (const m of meshes) next.set(m, LOOKS.all);
  if (hovered) next.set(hovered, LOOKS.hover);
  if (active) next.set(active, LOOKS.active);
  for (const m of shown.keys()) if (!next.has(m)) overlays.get(m).visible = false;
  for (const [m, look] of next) {
    const o = overlayOf(m);
    o.material = look;
    o.visible = true;
  }
  shown = next;
}

export const highlighted = () => new Map(shown);
