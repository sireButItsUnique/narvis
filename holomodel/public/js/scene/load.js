// GLB from the hidden Blender -> Parts. The glTF frame is kept as is (metres, Y up); model.js puts it under a
// display parent that scales it to centimetres and fits it in the box.
//   - Every mesh node becomes one part, flattened to a transform relative to the glTF root, so brushes and
//     part moves never have to walk Fable's Empties.
//   - A Blender object with several materials arrives as a Group of one mesh per primitive: it's merged back
//     into one part, with one geometry group per material.
//   - Each part gets its own material clones, so recolouring or highlighting one part never touches another.
//   - Non-uniform (or mirrored) scale is baked into the geometry and kept as holo_bake, so brushes work in
//     undistorted part space and sync can undo the bake later.
// Pure three.js (no DOM), so node --test can check it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makePart } from './parts.js';

// Errors say whether trying again can help: `retry` for the network and the server, not for a bad file.
export async function fetchScene(url, { signal } = {}) {
  let buf;
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw Object.assign(new Error(`server said ${r.status}`), { status: r.status });
    buf = await r.arrayBuffer();
  } catch (err) {
    throw Object.assign(err, { retry: true });
  }
  return readGlb(buf);
}

export async function readGlb(buffer) {
  return partsFromGltf(await new GLTFLoader().parseAsync(buffer, ''));
}

const ONE = new THREE.Vector3(1, 1, 1);
const HEX12 = /^[0-9a-f]{12}$/;

export function partsFromGltf(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  // Blender writes scene custom props on the glTF scene; accept them on the file's root too
  const extras = { ...(gltf.userData || {}), ...(src.userData || {}) };
  const assoc = gltf.parser?.associations || null;
  const rootInv = src.matrixWorld.clone().invert();
  const parts = [], usedGeo = new Set(), ids = new Set();

  src.traverse(obj => {
    const prims = primitivesOf(obj, assoc);
    if (!prims?.length) return;
    const ud = obj.userData || {};
    const name = String(ud.holo_name ?? ud.name ?? obj.name ?? 'part');
    let id = typeof ud.holo_id === 'string' && ud.holo_id ? ud.holo_id : `name:${name}`;
    for (let k = 2; ids.has(id); k++) id = `${ud.holo_id || `name:${name}`}#${k}`;   // obj.copy() in Blender can duplicate ids
    ids.add(id);

    let geo;
    if (prims.length === 1) {
      geo = prims[0].geometry;
      if (usedGeo.has(geo)) geo = geo.clone();   // two nodes sharing one mesh: each part needs its own
      usedGeo.add(geo);
    } else {
      geo = mergePrimitives(prims.map(p => p.geometry));
    }
    const materials = prims.map(p => {
      const m = p.material.clone();
      m.userData.holo_mat = p.material.name;
      return m;
    });

    const rel = rootInv.clone().multiply(obj.matrixWorld);
    const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    rel.decompose(t, q, s);
    const bake = new THREE.Matrix4().compose(t, q, ONE).invert().multiply(rel);   // scale (and shear) in part axes
    const mesh = new THREE.Mesh(geo, materials.length === 1 ? materials[0] : materials);
    mesh.position.copy(t);
    mesh.quaternion.copy(q);
    let baked = null;
    if (isUniformScale(bake, s.x)) {
      mesh.scale.setScalar(s.x);
    } else {
      if (prims.length === 1) { geo = geo.clone(); mesh.geometry = geo; }   // another node may share the loader's copy
      geo.applyMatrix4(bake);
      if (bake.determinant() < 0) flipWinding(geo);   // a mirror turns faces inside out
      baked = bake.toArray();
    }
    mesh.name = name;
    mesh.userData = { ...ud, holo_id: id, holo_name: name, ...(baked ? { holo_bake: baked } : {}) };
    mesh.castShadow = mesh.receiveShadow = true;

    parts.push(makePart({
      id, name, mesh, materials,
      ghash: ud.holo_ghash ?? null, mhash: ud.holo_mhash ?? null,
      meta: {
        parentId: parentIdOf(obj, src, assoc),
        sculpted: !!ud.holo_sculpted, vidok: !!ud.holo_vidok, nv: ud.holo_nv ?? null,
        tris: (geo.index ? geo.index.count : geo.attributes.position.count) / 3,
        textured: materials.some(m => !!m.map), bake: baked, blenderId: HEX12.test(id),
      },
    }));
  });

  const sym = extras.holo_sym || {};
  const top = src.children.length === 1 ? src.children[0] : null;
  return {
    parts,
    sym: { x: !!sym.x, y: !!sym.y, z: !!sym.z },
    rev: extras.holo_rev ?? null,
    units: extras.holo_units || 'm',
    // never the glTF scene's own name: that's Blender's scene name, always "Scene" under --factory-startup.
    // The export says what the model is in holo_model (the root Empty, or the collection the build went into).
    name: String(extras.holo_model || (top ? (top.userData.holo_name ?? top.userData.name ?? top.name) : '') || 'model'),
  };
}

// The triangle primitives a glTF node draws, or null for objects that aren't nodes (primitives of a
// multi-material node, which its Group handles). Lines and points (loose edges) aren't parts.
function primitivesOf(obj, assoc) {
  if (!assoc) return obj.isMesh ? [obj] : [];
  const a = assoc.get(obj);
  if (a?.nodes === undefined) return null;
  if (obj.isMesh) return [obj];
  if (a.meshes === undefined) return [];   // an Empty
  return obj.children.filter(c => c.isMesh && assoc.get(c)?.nodes === undefined);
}

function parentIdOf(obj, src, assoc) {
  for (let p = obj.parent; p && p !== src; p = p.parent) {
    if ((!assoc || assoc.get(p)?.nodes !== undefined) && p.userData?.holo_id) return p.userData.holo_id;
  }
  return null;
}

function isUniformScale(m, s) {
  if (!(s > 0)) return false;
  const e = m.elements, tol = 1e-5 * s;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) if (Math.abs(e[i * 4 + j] - (i === j ? s : 0)) > tol) return false;
  }
  return true;
}

function flipWinding(g) {
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const b = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = b; }
  g.index.needsUpdate = true;
}

// One geometry from a multi-material object's primitives, one group per material. Written out rather than
// BufferGeometryUtils.mergeGeometries because Blender's primitives can differ (a COLOR_0 on one, 16- vs 32-bit
// indices), which makes that refuse to merge. Attributes a primitive lacks are filled in (colour white, else 0).
export function mergePrimitives(geos) {
  const names = new Map();
  for (const g of geos) for (const [n, a] of Object.entries(g.attributes)) names.set(n, Math.max(names.get(n) || 0, a.itemSize));
  const counts = geos.map(g => g.attributes.position.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const out = new THREE.BufferGeometry();
  const get = ['getX', 'getY', 'getZ', 'getW'];
  for (const [n, size] of names) {
    const arr = new Float32Array(total * size);
    let off = 0;
    geos.forEach((g, gi) => {
      const a = g.attributes[n];
      for (let i = 0; i < counts[gi]; i++) {
        for (let c = 0; c < size; c++) arr[(off + i) * size + c] = a && c < a.itemSize ? a[get[c]](i) : n === 'color' ? 1 : 0;
      }
      off += counts[gi];
    });
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const nIdx = geos.reduce((s, g, gi) => s + (g.index ? g.index.count : counts[gi]), 0);
  const index = total > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
  let at = 0, base = 0;
  geos.forEach((g, gi) => {
    const start = at;
    if (g.index) for (let i = 0; i < g.index.count; i++) index[at++] = base + g.index.getX(i);
    else for (let i = 0; i < counts[gi]; i++) index[at++] = base + i;
    out.addGroup(start, at - start, gi);
    base += counts[gi];
  });
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}
