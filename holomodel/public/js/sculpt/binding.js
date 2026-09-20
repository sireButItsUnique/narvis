// SPDX-License-Identifier: GPL-3.0-or-later
// Part of holosculpt. No Blender code is paraphrased here; this is our own render binding.
//
// One Blender object = one part = one sculpt proxy. The render geometry that three.js draws keeps
// its UV seams, hard-edge normal copies and per-material primitives, so brushing it directly tears
// it apart. So we weld it once into a proxy (unique positions), sculpt the proxy, and scatter the
// result back into every render copy:
//   - weld key = the Blender vertex id (_vid attribute) when the exporter gave us one, else the
//     position quantised to 1e-6 m, and only inside one part;
//   - proxy -> render copies as a CSR map, so a dab touching k proxy vertices writes k' floats;
//   - normal groups: render copies that were exported with the same normal (a UV seam) share the
//     welded normal, copies with their own normal (a hard edge) keep a normal computed from just
//     their own faces, so a flat cube stays faceted and a seam never creases;
//   - only the touched index range is uploaded (BufferAttribute.addUpdateRange).

const DEFAULT_QUANTUM = 1e-6;
const DEFAULT_NORMAL_COS = 0.999; // ~2.5 degrees: seam copies merge, hard edges do not

function attrArray(geometry, name) {
  const a = geometry.getAttribute ? geometry.getAttribute(name) : geometry.attributes?.[name];
  return a || null;
}

function asGeometryList(source) {
  const list = [];
  const push = (o) => {
    if (!o) return;
    if (o.isBufferGeometry) list.push({ geometry: o, mesh: null });
    else if (o.isMesh) list.push({ geometry: o.geometry, mesh: o });
    else if (Array.isArray(o)) o.forEach(push);
    else if (o.geometry) list.push({ geometry: o.geometry, mesh: o.isObject3D ? o : null });
  };
  push(source);
  if (list.length === 0) throw new Error('binding: no geometry to bind');
  return list;
}

// Material id per render triangle: the geometry group's materialIndex when the part was merged,
// otherwise the primitive's own slot (GLTFLoader splits one Blender object per material).
function materialIdsForGeometry(geometry, triangleCount, fallback) {
  const ids = new Uint16Array(triangleCount).fill(fallback);
  const groups = geometry.groups || [];
  if (groups.length === 0) return ids;
  for (const g of groups) {
    const first = Math.floor(g.start / 3);
    const last = Math.min(triangleCount, Math.floor((g.start + g.count) / 3));
    for (let t = first; t < last; t++) ids[t] = g.materialIndex ?? fallback;
  }
  return ids;
}

/**
 * Weld the render geometry of one part into a sculpt proxy and keep the map back.
 *
 * @param {object} source a three.js Mesh, a BufferGeometry, or an array of either (the primitives
 *                 of one multi-material part). Positions are read as they are: bake any node scale
 *                 into the geometry before calling.
 * @param {object} [options] {vidAttribute='_vid', quantum=1e-6, normalCos=0.999}
 */
export function createBinding(source, options = {}) {
  const vidName = options.vidAttribute ?? '_vid';
  const quantum = options.quantum ?? DEFAULT_QUANTUM;
  const normalCos = options.normalCos ?? DEFAULT_NORMAL_COS;
  const geos = asGeometryList(source);

  // 1. render vertices, laid out as one global array (offset per primitive).
  const prims = [];
  let renderCount = 0;
  let renderTriCount = 0;
  for (let gi = 0; gi < geos.length; gi++) {
    const geometry = geos[gi].geometry;
    const pos = attrArray(geometry, 'position');
    if (!pos) throw new Error('binding: geometry without a position attribute');
    const index = geometry.getIndex ? geometry.getIndex() : geometry.index;
    const triCount = (index ? index.count : pos.count) / 3;
    if (!Number.isInteger(triCount)) throw new Error('binding: geometry is not triangles');
    prims.push({
      geometry,
      mesh: geos[gi].mesh,
      offset: renderCount,
      count: pos.count,
      position: pos,
      normal: attrArray(geometry, 'normal'),
      vid: attrArray(geometry, vidName),
      index,
      triOffset: renderTriCount,
      triCount,
      materialIds: materialIdsForGeometry(geometry, triCount, gi),
      dirtyMin: Infinity,
      dirtyMax: -Infinity,
      dirtyNormalMin: Infinity,
      dirtyNormalMax: -Infinity,
    });
    renderCount += pos.count;
    renderTriCount += triCount;
  }

  // 2. weld: render vertex -> proxy vertex.
  const renderToProxy = new Int32Array(renderCount).fill(-1);
  const proxyPos = [];
  const byVid = new Map();
  const byPos = new Map();
  const usedVid = prims.some((p) => p.vid);
  const inv = 1 / quantum;
  for (const p of prims) {
    const pa = p.position.array;
    const va = p.vid ? p.vid.array : null;
    for (let i = 0; i < p.count; i++) {
      const x = pa[3 * i], y = pa[3 * i + 1], z = pa[3 * i + 2];
      let key;
      if (va) key = 'v' + va[i];
      else key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      const map = va ? byVid : byPos;
      let proxyId = map.get(key);
      if (proxyId === undefined) {
        proxyId = proxyPos.length / 3;
        map.set(key, proxyId);
        proxyPos.push(x, y, z);
      }
      renderToProxy[p.offset + i] = proxyId;
    }
  }
  const proxyCount = proxyPos.length / 3;
  const positions = Float32Array.from(proxyPos);

  // 3. proxy triangles. A triangle that collapsed on welding is dropped from the proxy only; the
  //    render mesh keeps drawing it, it just never moves on its own.
  const triangles = new Uint32Array(renderTriCount * 3);
  const triRenderMap = new Uint32Array(renderTriCount);
  const faceMaterial = new Uint16Array(renderTriCount);
  const renderTriToProxyTri = new Int32Array(renderTriCount).fill(-1);
  let proxyTriCount = 0;
  for (const p of prims) {
    const ia = p.index ? p.index.array : null;
    for (let t = 0; t < p.triCount; t++) {
      const r0 = ia ? ia[3 * t] : 3 * t;
      const r1 = ia ? ia[3 * t + 1] : 3 * t + 1;
      const r2 = ia ? ia[3 * t + 2] : 3 * t + 2;
      const a = renderToProxy[p.offset + r0];
      const b = renderToProxy[p.offset + r1];
      const c = renderToProxy[p.offset + r2];
      if (a === b || b === c || c === a) continue;
      triangles[3 * proxyTriCount] = a;
      triangles[3 * proxyTriCount + 1] = b;
      triangles[3 * proxyTriCount + 2] = c;
      triRenderMap[proxyTriCount] = p.triOffset + t;
      faceMaterial[proxyTriCount] = p.materialIds[t];
      renderTriToProxyTri[p.triOffset + t] = proxyTriCount;
      proxyTriCount++;
    }
  }

  // 4. CSR proxy -> render copies.
  const csrOff = new Uint32Array(proxyCount + 1);
  for (let i = 0; i < renderCount; i++) csrOff[renderToProxy[i] + 1]++;
  for (let i = 0; i < proxyCount; i++) csrOff[i + 1] += csrOff[i];
  const csrIdx = new Uint32Array(renderCount);
  {
    const cursor = csrOff.slice(0, proxyCount);
    for (let i = 0; i < renderCount; i++) csrIdx[cursor[renderToProxy[i]]++] = i;
  }

  // 5. normal groups. Copies of one proxy vertex are clustered by their exported normal: same
  //    direction (UV seam) -> one group that ends up with every incident face, i.e. the welded
  //    normal; different direction (hard edge) -> its own group with only its own faces.
  const groupOf = new Int32Array(renderCount).fill(-1);
  const groupProxy = [];
  const groupNormals = [];
  for (let v = 0; v < proxyCount; v++) {
    const start = csrOff[v], end = csrOff[v + 1];
    const localGroups = [];
    for (let k = start; k < end; k++) {
      const r = csrIdx[k];
      const prim = primOf(prims, r);
      let nx = 0, ny = 0, nz = 0;
      if (prim.normal) {
        const li = r - prim.offset;
        const na = prim.normal.array;
        nx = na[3 * li]; ny = na[3 * li + 1]; nz = na[3 * li + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
      }
      let found = -1;
      for (let g = 0; g < localGroups.length; g++) {
        const n = localGroups[g].n;
        if (!prim.normal || n[0] * nx + n[1] * ny + n[2] * nz >= normalCos) { found = g; break; }
      }
      if (found < 0) { localGroups.push({ n: [nx, ny, nz], members: [r] }); found = localGroups.length - 1; }
      else localGroups[found].members.push(r);
    }
    for (const g of localGroups) {
      const id = groupProxy.length;
      groupProxy.push(v);
      groupNormals.push(g.n);
      for (const r of g.members) groupOf[r] = id;
    }
  }
  const groupCount = groupProxy.length;
  const groupProxyArr = Uint32Array.from(groupProxy);

  // group -> proxy faces that touch it (for the per-group normal), as CSR.
  const groupFaceCounts = new Uint32Array(groupCount);
  const addFaces = (fn) => {
    for (const p of prims) {
      const ia = p.index ? p.index.array : null;
      for (let t = 0; t < p.triCount; t++) {
        const ptri = renderTriToProxyTri[p.triOffset + t];
        if (ptri < 0) continue;
        for (let c = 0; c < 3; c++) {
          const r = p.offset + (ia ? ia[3 * t + c] : 3 * t + c);
          fn(groupOf[r], ptri);
        }
      }
    }
  };
  addFaces((g) => { groupFaceCounts[g]++; });
  const groupFaceOff = new Uint32Array(groupCount + 1);
  for (let i = 0; i < groupCount; i++) groupFaceOff[i + 1] = groupFaceOff[i] + groupFaceCounts[i];
  const groupFaces = new Uint32Array(groupFaceOff[groupCount]);
  {
    const cursor = groupFaceOff.slice(0, groupCount);
    addFaces((g, f) => { groupFaces[cursor[g]++] = f; });
  }

  // A group that carries every face of its proxy vertex is exactly the welded normal, so it can
  // just copy the proxy normal instead of recomputing (the common case, and the fast path).
  const proxyFaceCount = new Uint32Array(proxyCount);
  for (let t = 0; t < proxyTriCount; t++) {
    proxyFaceCount[triangles[3 * t]]++;
    proxyFaceCount[triangles[3 * t + 1]]++;
    proxyFaceCount[triangles[3 * t + 2]]++;
  }
  const groupWelded = new Uint8Array(groupCount);
  for (let g = 0; g < groupCount; g++) {
    const n = groupFaceOff[g + 1] - groupFaceOff[g];
    groupWelded[g] = n === proxyFaceCount[groupProxyArr[g]] ? 1 : 0;
  }

  // proxy -> its groups, so a dab can refresh only the groups it touched.
  const proxyGroupOff = new Uint32Array(proxyCount + 1);
  for (let g = 0; g < groupCount; g++) proxyGroupOff[groupProxyArr[g] + 1]++;
  for (let i = 0; i < proxyCount; i++) proxyGroupOff[i + 1] += proxyGroupOff[i];
  const proxyGroups = new Uint32Array(groupCount);
  {
    const cursor = proxyGroupOff.slice(0, proxyCount);
    for (let g = 0; g < groupCount; g++) proxyGroups[cursor[groupProxyArr[g]]++] = g;
  }

  const binding = {
    prims,
    proxyCount,
    renderCount,
    proxyTriCount,
    positions,
    triangles: triangles.subarray(0, proxyTriCount * 3),
    triRenderMap: triRenderMap.subarray(0, proxyTriCount),
    faceMaterial: faceMaterial.subarray(0, proxyTriCount),
    renderToProxy,
    csrOff,
    csrIdx,
    groupOf,
    groupProxy: groupProxyArr,
    groupFaceOff,
    groupFaces,
    groupWelded,
    proxyGroupOff,
    proxyGroups,
    usedVid,

    // Scratch for scatterNormals' one-ring expansion, reused across every refresh. The stamp
    // starts at 0 and the tick at 1, so the mark array never has to be cleared.
    _ringMark: new Int32Array(proxyCount),
    _ringList: new Uint32Array(proxyCount),
    _ringTick: 0,

    /** Copy proxy positions (and the normals of the groups around them) into the render meshes. */
    scatter(proxy, verts) {
      scatterPositions(binding, proxy, verts);
      scatterNormals(binding, proxy, verts);
    },
    scatterAll(proxy) {
      const all = new Uint32Array(proxyCount);
      for (let i = 0; i < proxyCount; i++) all[i] = i;
      binding.scatter(proxy, all);
    },
    flush() {
      flushRanges(binding);
    },
  };
  return binding;
}

function primOf(prims, renderIndex) {
  // Primitives are few (one per material), so a scan is cheaper than a lookup table.
  for (let i = prims.length - 1; i >= 0; i--) if (renderIndex >= prims[i].offset) return prims[i];
  return prims[0];
}

function scatterPositions(binding, proxy, verts) {
  const src = proxy.getVertices();
  const { csrOff, csrIdx, prims } = binding;
  for (let k = 0; k < verts.length; k++) {
    const v = verts[k];
    const x = src[3 * v], y = src[3 * v + 1], z = src[3 * v + 2];
    for (let c = csrOff[v]; c < csrOff[v + 1]; c++) {
      const r = csrIdx[c];
      const p = primOf(prims, r);
      const li = r - p.offset;
      const arr = p.position.array;
      arr[3 * li] = x; arr[3 * li + 1] = y; arr[3 * li + 2] = z;
      if (li < p.dirtyMin) p.dirtyMin = li;
      if (li > p.dirtyMax) p.dirtyMax = li;
    }
  }
}

// Recompute the normals of every group around the touched vertices. The groups of the one-ring
// neighbours change too, because their faces moved.
function scatterNormals(binding, proxy, verts) {
  const ring = proxy.getVerticesRingVert();
  // A Set plus a JS array here was the single biggest allocation of a dab on a large part
  // (Elastic Grab touches every vertex, so it built a 200k-entry Set per refresh). A stamped mark
  // array and a dense list do the same job with no garbage at all.
  const mark = binding._ringMark;
  const list = binding._ringList;
  const tick = ++binding._ringTick;
  let n = 0;
  for (let k = 0; k < verts.length; k++) {
    const v = verts[k];
    if (mark[v] !== tick) { mark[v] = tick; list[n++] = v; }
    const nb = ring[v];
    for (let j = 0; j < nb.length; j++) {
      const u = nb[j];
      if (mark[u] !== tick) { mark[u] = tick; list[n++] = u; }
    }
  }
  const stack = list.subarray(0, n);
  const proxyNormals = proxy.getRenderNormals();
  const positions = proxy.getVertices();
  const faces = proxy.getFaces();
  const faceNormals = proxy.getFaceNormals();
  const { proxyGroupOff, proxyGroups, groupWelded, groupFaceOff, groupFaces, csrOff, csrIdx, groupOf, prims } = binding;

  for (const v of stack) {
    for (let gi = proxyGroupOff[v]; gi < proxyGroupOff[v + 1]; gi++) {
      const g = proxyGroups[gi];
      let nx, ny, nz;
      if (groupWelded[g]) {
        nx = proxyNormals[3 * v]; ny = proxyNormals[3 * v + 1]; nz = proxyNormals[3 * v + 2];
      } else {
        nx = 0; ny = 0; nz = 0;
        const px = positions[3 * v], py = positions[3 * v + 1], pz = positions[3 * v + 2];
        for (let fi = groupFaceOff[g]; fi < groupFaceOff[g + 1]; fi++) {
          const f = groupFaces[fi];
          const idf = f * 4;
          const a = faces[idf], b = faces[idf + 1], c = faces[idf + 2];
          const o1 = a === v ? b : (b === v ? c : a);
          const o2 = a === v ? c : (b === v ? a : b);
          let e1x = positions[3 * o1] - px, e1y = positions[3 * o1 + 1] - py, e1z = positions[3 * o1 + 2] - pz;
          let e2x = positions[3 * o2] - px, e2y = positions[3 * o2 + 1] - py, e2z = positions[3 * o2 + 2] - pz;
          const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
          if (l1 === 0 || l2 === 0) continue;
          e1x /= l1; e1y /= l1; e1z /= l1;
          e2x /= l2; e2y /= l2; e2z /= l2;
          let cos = e1x * e2x + e1y * e2y + e1z * e2z;
          cos = cos > 1 ? 1 : (cos < -1 ? -1 : cos);
          const angle = Math.acos(cos);
          const fx = faceNormals[3 * f], fy = faceNormals[3 * f + 1], fz = faceNormals[3 * f + 2];
          const fl = Math.hypot(fx, fy, fz);
          if (fl === 0) continue;
          const w = angle / fl;
          nx += fx * w; ny += fy * w; nz += fz * w;
        }
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }
      }
      // write to the render copies of this group
      for (let c = csrOff[v]; c < csrOff[v + 1]; c++) {
        const r = csrIdx[c];
        if (groupOf[r] !== g) continue;
        const p = primOf(prims, r);
        if (!p.normal) continue;
        const li = r - p.offset;
        const arr = p.normal.array;
        arr[3 * li] = nx; arr[3 * li + 1] = ny; arr[3 * li + 2] = nz;
        if (li < p.dirtyNormalMin) p.dirtyNormalMin = li;
        if (li > p.dirtyNormalMax) p.dirtyNormalMax = li;
      }
    }
  }
}

// three.js ACCUMULATES updateRanges and merges them all in WebGLAttributes.updateBuffer, then
// clears them itself once they are on the GPU. Clearing them here instead dropped every refresh
// but the last one in a frame, and more than one dab per frame is the normal case at 30 Hz: a 2.5
// cm brush at 10% spacing steps 5 mm, so any hand faster than ~30 cm/s emits two dabs a sample,
// and the grab family flushes twice per dab anyway (restoreStrokeStart). Measured against r170's
// own updateBuffer on a 60k part, stroking across the index-major axis: 2 dabs/frame left 766
// vertices showing their old position (16.3 mm out) and 4 dabs/frame left 2475 (26.7 mm), and they
// never healed, because nothing re-uploads once the stroke ends.
function flushRanges(binding) {
  for (const p of binding.prims) {
    if (p.dirtyMax >= p.dirtyMin) {
      const a = p.position;
      if (a.addUpdateRange) a.addUpdateRange(3 * p.dirtyMin, 3 * (p.dirtyMax - p.dirtyMin + 1));
      a.needsUpdate = true;
      p.dirtyMin = Infinity; p.dirtyMax = -Infinity;
    }
    if (p.normal && p.dirtyNormalMax >= p.dirtyNormalMin) {
      const a = p.normal;
      if (a.addUpdateRange) a.addUpdateRange(3 * p.dirtyNormalMin, 3 * (p.dirtyNormalMax - p.dirtyNormalMin + 1));
      a.needsUpdate = true;
      p.dirtyNormalMin = Infinity; p.dirtyNormalMax = -Infinity;
    }
  }
}

/**
 * Merge the primitives of one multi-material part into a single indexed geometry with groups,
 * which is what load.js hands us for a Blender object exported with several materials. Written
 * here (rather than pulling in BufferGeometryUtils) so the module imports cleanly in Node too.
 */
export function mergePrimitives(THREE, meshes) {
  const geos = asGeometryList(meshes).map((g) => g.geometry);
  const names = new Set();
  for (const g of geos) for (const k of Object.keys(g.attributes)) names.add(k);
  let total = 0, totalIdx = 0;
  for (const g of geos) {
    total += g.getAttribute('position').count;
    const idx = g.getIndex();
    totalIdx += idx ? idx.count : g.getAttribute('position').count;
  }
  const merged = new THREE.BufferGeometry();
  for (const name of names) {
    const first = geos.find((g) => g.getAttribute(name));
    const itemSize = first.getAttribute(name).itemSize;
    const out = new Float32Array(total * itemSize);
    let off = 0;
    for (const g of geos) {
      const a = g.getAttribute(name);
      const count = g.getAttribute('position').count;
      if (a) out.set(a.array.subarray(0, count * itemSize), off * itemSize);
      off += count;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
  }
  const index = total > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
  let vOff = 0, iOff = 0;
  geos.forEach((g, gi) => {
    const count = g.getAttribute('position').count;
    const idx = g.getIndex();
    const n = idx ? idx.count : count;
    for (let i = 0; i < n; i++) index[iOff + i] = (idx ? idx.array[i] : i) + vOff;
    merged.addGroup(iOff, n, gi);
    vOff += count;
    iOff += n;
  });
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}
