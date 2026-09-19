// Part list (spec.js) -> three.js meshes. The same code builds the on-screen model and the export copy.
import * as THREE from 'three';

const DEG = Math.PI / 180;

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
    case 'extrude': {
      const outline = new THREE.Shape(part.points.map(([x, y]) => new THREE.Vector2(x * u, y * u)));
      const g = new THREE.ExtrudeGeometry(outline, { depth: d[0], bevelEnabled: false });
      g.translate(0, 0, -d[0] / 2);   // centre the thickness on the part's position
      return g;
    }
  }
  throw new Error(`unknown shape ${part.shape}`);
}

// lathe profiles and partial tori are open surfaces, so show their inside too
const isOpen = part => part.shape === 'lathe' || (part.shape === 'torus' && part.dims[2] < 360);

function material(part, forExport, shared) {
  const side = isOpen(part) ? THREE.DoubleSide : THREE.FrontSide;
  if (!forExport) {
    // one material per mesh, so a single part can be highlighted
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

// Returns a Group named after the model with one child mesh per part, shifted so the model's
// bounding box sits on y = 0 and is centred in x and z.
export function buildModelGroup(spec, { unit = 1, forExport = false } = {}) {
  const root = new THREE.Group();
  root.name = spec.name;
  const shared = new Map();
  for (const part of spec.parts) {
    const geo = geometryFor(part, unit);
    geo.name = part.name;
    const mesh = new THREE.Mesh(geo, material(part, forExport, shared));
    mesh.name = part.name;
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
  // where the parts sit in the spec's own coordinates, for placing new parts next to them
  root.userData.bounds = { min: box.min.clone().divideScalar(unit), max: box.max.clone().divideScalar(unit) };
  const size = box.getSize(new THREE.Vector3());
  root.userData.height = Math.max(size.y, 1e-3);
  root.userData.radius = Math.max(Math.hypot(size.x, size.z) / 2, 1e-3);   // footprint radius around the spin axis
  return root;
}

export function disposeGroup(root) {
  root.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
}
