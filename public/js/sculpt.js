// Clay tools that reshape one part's mesh in place. All brush maths happens in the model's own space
// ("root-local"), so it doesn't matter how the model is spun, scaled or placed.
// `mirrorX` is null for no mirroring, or the root-local x of the mirror plane (the model's centre line).
import * as THREE from 'three';
import { sculptGeometry } from './builder.js';

// 1 at the brush centre, fading smoothly to 0 at its edge
export const falloff = t => (t >= 1 ? 0 : (1 - t * t) ** 2);

// The first time a part is sculpted, swap its light primitive for the dense sculpt geometry.
export function ensureSculptable(mesh, part) {
  if (mesh.userData.sculptable) return;
  const old = mesh.geometry;
  mesh.geometry = sculptGeometry(part);
  mesh.geometry.name = part.name;
  old.dispose();
  mesh.userData.sculptable = true;
  mesh.userData.adjacency = null;
}

function refresh(mesh) {
  const g = mesh.geometry;
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();   // raycasting skips meshes whose bounds are stale
  g.computeBoundingBox();
}

const mirrored = v => new THREE.Vector3(-v.x, v.y, v.z);   // a direction reflected across any x-plane

// Vertices within `radius` of `center` (and of its mirror image), with brush weights.
function gather(mesh, center, radius, mirrorX) {
  mesh.updateMatrix();
  const pos = mesh.geometry.attributes.position, m = mesh.matrix, p = new THREE.Vector3();
  const plane = typeof mirrorX === 'number' ? mirrorX : null;   // anything else (null, false) = mirror off
  const other = new THREE.Vector3(2 * (plane ?? 0) - center.x, center.y, center.z);
  // a stroke right on the mirror line would pull the same vertices twice
  const useMirror = plane !== null && Math.abs(center.x - plane) > radius * 0.3;
  const idx = [], w = [], wm = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    const a = falloff(p.distanceTo(center) / radius);
    const b = useMirror ? falloff(p.distanceTo(other) / radius) : 0;
    if (a > 0 || b > 0) { idx.push(i); w.push(a); wm.push(b); }
  }
  return { idx: Int32Array.from(idx), w: Float32Array.from(w), wm: Float32Array.from(wm) };
}

// ---------- pull: pinch a spot and drag it like clay ----------
// `anchor` and later `delta` are root-local; `radius` is in root-local units too.
export function beginPull(mesh, anchor, radius, mirrorX = null) {
  const { idx, w, wm } = gather(mesh, anchor, radius, mirrorX);
  const arr = mesh.geometry.attributes.position.array, orig = new Float32Array(idx.length * 3);
  for (let k = 0; k < idx.length; k++) orig.set(arr.subarray(idx[k] * 3, idx[k] * 3 + 3), k * 3);
  // root-local directions -> the mesh's own space (undo its rotation/scale inside the model)
  const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrix).invert();
  return { mesh, idx, w, wm, orig, inv };
}

export function applyPull(s, delta) {
  const d = delta.clone().applyMatrix3(s.inv), dm = mirrored(delta).applyMatrix3(s.inv);
  const arr = s.mesh.geometry.attributes.position.array;
  for (let k = 0; k < s.idx.length; k++) {
    const i = s.idx[k] * 3, a = s.w[k], b = s.wm[k];
    arr[i]     = s.orig[k * 3]     + a * d.x + b * dm.x;
    arr[i + 1] = s.orig[k * 3 + 1] + a * d.y + b * dm.y;
    arr[i + 2] = s.orig[k * 3 + 2] + a * d.z + b * dm.z;
  }
  refresh(s.mesh);
}

// put a pull back exactly as it started (used when a two-hand gesture takes over)
export function revertPull(s) {
  const arr = s.mesh.geometry.attributes.position.array;
  for (let k = 0; k < s.idx.length; k++) arr.set(s.orig.subarray(k * 3, k * 3 + 3), s.idx[k] * 3);
  refresh(s.mesh);
}

export function restorePositions(mesh, positions) {
  mesh.geometry.attributes.position.array.set(positions);
  refresh(mesh);
}

// ---------- smooth: rub a spot to even it out ----------
function adjacency(mesh) {
  if (mesh.userData.adjacency) return mesh.userData.adjacency;
  const n = mesh.geometry.attributes.position.count, index = mesh.geometry.index.array;
  const sets = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
  }
  const offs = new Int32Array(n + 1), list = [];
  sets.forEach((s, i) => { offs[i] = list.length; list.push(...s); });
  offs[n] = list.length;
  return (mesh.userData.adjacency = { offs, list: Int32Array.from(list) });
}

// Moves each brushed vertex part of the way toward the average of its neighbours.
export function smoothAt(mesh, center, radius, mirrorX = null, strength = 0.5) {
  const { idx, w, wm } = gather(mesh, center, radius, mirrorX);
  if (!idx.length) return;
  const { offs, list } = adjacency(mesh), arr = mesh.geometry.attributes.position.array;
  const next = new Float32Array(idx.length * 3);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], t = Math.min(1, (w[k] + wm[k]) * strength);
    let x = 0, y = 0, z = 0;
    const from = offs[i], to = offs[i + 1];
    for (let j = from; j < to; j++) { const q = list[j] * 3; x += arr[q]; y += arr[q + 1]; z += arr[q + 2]; }
    const cnt = Math.max(1, to - from);
    next[k * 3]     = arr[i * 3]     + t * (x / cnt - arr[i * 3]);
    next[k * 3 + 1] = arr[i * 3 + 1] + t * (y / cnt - arr[i * 3 + 1]);
    next[k * 3 + 2] = arr[i * 3 + 2] + t * (z / cnt - arr[i * 3 + 2]);
  }
  for (let k = 0; k < idx.length; k++) arr.set(next.subarray(k * 3, k * 3 + 3), idx[k] * 3);
  refresh(mesh);
}
