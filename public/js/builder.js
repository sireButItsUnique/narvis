// Part list (spec.js) -> three.js meshes. The same code builds the on-screen model and the export copy.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const DEG = Math.PI / 180;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// `u` scales every length: 1 keeps centimetres, 0.01 gives metres for glTF.
function geometryFor(part, u) {
  const d = part.dims.map(v => v * u);
  switch (part.shape) {
    case 'box':      return new THREE.BoxGeometry(d[0], d[1], d[2]);
    case 'sphere':   return new THREE.SphereGeometry(d[0], 32, 16);
    case 'cylinder': return new THREE.CylinderGeometry(d[0], d[1], d[2], 32);
    case 'cone':     return new THREE.ConeGeometry(d[0], d[1], 32);
    case 'torus':    return new THREE.TorusGeometry(d[0], d[1], 16, 48, part.dims[2] * DEG);   // arc is degrees, not a length
    case 'capsule':  return new THREE.CapsuleGeometry(d[0], d[1], 8, 24);
    case 'lathe':    return new THREE.LatheGeometry(part.points.map(([x, y]) => new THREE.Vector2(x * u, y * u)), 48);
    case 'extrude':  return extrude(part, u, 1);
  }
  throw new Error(`unknown shape ${part.shape}`);
}

function extrude(part, u, steps) {
  const depth = part.dims[0] * u;
  const outline = new THREE.Shape(part.points.map(([x, y]) => new THREE.Vector2(x * u, y * u)));
  const g = new THREE.ExtrudeGeometry(outline, { depth, steps, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);   // centre the thickness on the part's position
  return g;
}

// ---------- sculpt resolution ----------
// Profile points spaced at most `step` apart, so lathed surfaces have rings to pull on.
function densify(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(a.distanceTo(b) / step));
    for (let k = 1; k <= n; k++) out.push(a.clone().lerp(b, k / n));
  }
  return out;
}

function capsuleProfile(r, len, step) {
  const pts = [], arc = 16;
  for (let i = 0; i <= arc; i++) { const a = -Math.PI / 2 + (i / arc) * Math.PI / 2; pts.push(new THREE.Vector2(r * Math.cos(a), -len / 2 + r * Math.sin(a))); }
  for (let i = 0; i <= arc; i++) { const a = (i / arc) * Math.PI / 2; pts.push(new THREE.Vector2(r * Math.cos(a), len / 2 + r * Math.sin(a))); }
  return densify(pts, step);
}

// Welding collapses the triangles that touch a lathe's pole into slivers with two identical corners; drop them.
function dropDegenerate(g) {
  const idx = g.index.array, keep = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a !== b && b !== c && c !== a) keep.push(a, b, c);
  }
  g.setIndex(keep);
  return g;
}

// Midpoint subdivision: every triangle becomes four, shared edges stay shared (no cracks).
function subdivide(g) {
  const pos = g.attributes.position.array, idx = g.index.array, nV = pos.length / 3;
  const out = Array.from(pos), edges = new Map(), tris = [];
  const mid = (a, b) => {
    const key = a < b ? a * nV + b : b * nV + a;
    let m = edges.get(key);
    if (m === undefined) {
      m = out.length / 3; edges.set(key, m);
      out.push((pos[3 * a] + pos[3 * b]) / 2, (pos[3 * a + 1] + pos[3 * b + 1]) / 2, (pos[3 * a + 2] + pos[3 * b + 2]) / 2);
    }
    return m;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    tris.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const s = new THREE.BufferGeometry();
  s.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  s.setIndex(tris);
  return s;
}

// A dense, evenly spaced, watertight version of a part (in cm) for sculpting.
// Deterministic: the same part always gives the same vertex count and order, so a sculpt can be stored as
// just its vertex positions and rebuilt later.
export function sculptGeometry(part) {
  const d = part.dims;
  const size = Math.max(...d, ...part.points.flat().map(Math.abs), 1e-3);
  let g;
  switch (part.shape) {
    case 'box': {
      const cell = Math.max(d[0], d[1], d[2]) / 20, n = v => clampInt(v / cell, 1, 40);
      g = new THREE.BoxGeometry(d[0], d[1], d[2], n(d[0]), n(d[1]), n(d[2]));
      break;
    }
    case 'sphere':   g = new THREE.SphereGeometry(d[0], 64, 32); break;
    case 'cylinder': g = new THREE.CylinderGeometry(d[0], d[1], d[2], 64, clampInt(d[2] / (2 * Math.PI * Math.max(d[0], d[1]) / 64), 1, 64)); break;
    case 'cone':     g = new THREE.ConeGeometry(d[0], d[1], 64, clampInt(d[1] / (2 * Math.PI * d[0] / 64), 1, 64)); break;
    case 'torus':    g = new THREE.TorusGeometry(d[0], d[1], 24, 96, d[2] * DEG); break;
    case 'capsule':  g = new THREE.LatheGeometry(capsuleProfile(d[0], d[1], (d[1] + 2 * d[0]) / 48), 64); break;
    case 'lathe': {
      const pts = part.points.map(([x, y]) => new THREE.Vector2(x, y));
      const r = Math.max(...pts.map(p => p.x), 1e-3);
      g = new THREE.LatheGeometry(densify(pts, Math.max(2 * Math.PI * r / 64, size / 80)), 64);
      break;
    }
    case 'extrude':  g = extrude(part, 1, clampInt(d[0] / (size / 20), 1, 32)); break;
    default: throw new Error(`unknown shape ${part.shape}`);
  }
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g = dropDegenerate(mergeVertices(g, size * 1e-5));   // weld seams so pulling never tears the surface
  for (let level = 0; level < 4 && g.attributes.position.count < 2000; level++) g = subdivide(g);
  g.computeVertexNormals();
  return g;
}

// lathe profiles and partial tori are open surfaces, so show their inside too
const isOpen = part => part.shape === 'lathe' || (part.shape === 'torus' && part.dims[2] < 360);

function material(part, forExport, shared) {
  const side = isOpen(part) ? THREE.DoubleSide : THREE.FrontSide;
  if (!forExport) {
    // one material per mesh, so a single part can be highlighted or recoloured
    return new THREE.MeshStandardMaterial({ color: part.color, emissive: part.color, emissiveIntensity: 0.12,
                                            roughness: 0.45, metalness: 0.1, side });
  }
  // export: one material per colour, so Blender gets a short, tidy material list
  const key = `${part.color}${side === THREE.DoubleSide ? '_2s' : ''}`;
  if (!shared.has(key)) {
    shared.set(key, new THREE.MeshStandardMaterial({ name: `color_${part.color.slice(1)}`, color: part.color,
                                                     roughness: 0.5, metalness: 0, side }));
  }
  return shared.get(key);
}

// Sculpted parts come back from their stored vertex positions (cm, part-local); everything else from its primitive.
function partGeometry(part, unit, sculpt) {
  if (sculpt) {
    const g = sculptGeometry(part);
    if (g.attributes.position.array.length === sculpt.length) {
      g.attributes.position.array.set(sculpt);
      if (unit !== 1) g.scale(unit, unit, unit);
      g.computeVertexNormals();
      return { geo: g, sculptable: true };
    }
    console.warn(`sculpt data for ${part.name} no longer fits its shape; using the plain shape`);
    g.dispose();
  }
  return { geo: geometryFor(part, unit), sculptable: false };
}

// Returns a Group named after the model with one child mesh per part, shifted so the model's
// bounding box sits on y = 0 and is centred in x and z. `sculpts` maps part name -> Float32Array.
export function buildModelGroup(spec, { unit = 1, forExport = false, sculpts = null } = {}) {
  const root = new THREE.Group();
  root.name = spec.name;
  const shared = new Map();
  for (const part of spec.parts) {
    const { geo, sculptable } = partGeometry(part, unit, sculpts?.get(part.name));
    geo.name = part.name;
    const mesh = new THREE.Mesh(geo, material(part, forExport, shared));
    mesh.name = part.name;
    mesh.userData.sculptable = sculptable;
    mesh.position.fromArray(part.position).multiplyScalar(unit);
    mesh.rotation.set(part.rotation[0] * DEG, part.rotation[1] * DEG, part.rotation[2] * DEG, 'XYZ');
    if (!forExport) { mesh.castShadow = true; mesh.receiveShadow = true; }
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const shift = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  for (const mesh of root.children) mesh.position.add(shift);
  root.updateMatrixWorld(true);
  root.userData.shift = shift.divideScalar(unit);   // spec position = mesh position - shift (in cm)
  const size = box.getSize(new THREE.Vector3());
  root.userData.height = Math.max(size.y, 1e-3);
  root.userData.radius = Math.max(Math.hypot(size.x, size.z) / 2, 1e-3);   // footprint radius around the spin axis
  return root;
}

export function disposeGroup(root) {
  root.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
}
