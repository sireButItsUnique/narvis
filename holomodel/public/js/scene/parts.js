// The Part registry: one entry per Blender object, keyed by holo_id. Never by name: three renames objects
// ("Teapot Body" -> "Teapot_Body", "Cube.001" -> "Cube001") and Blender names aren't unique over time.
// Parts are direct children of `root`, which stands for the glTF scene: metres, Y up, Blender's world frame.
// Pure three.js (no DOM), so node --test can check it.
import * as THREE from 'three';

export function makePart({ id, name, mesh, materials, ghash = null, mhash = null, meta = {} }) {
  mesh.userData.holo_id = id;
  return {
    id, name, mesh, materials,
    proxy: null, binding: null,   // the sculpt proxy arrives in M2
    dirty: { mesh: false, xform: false, material: false },
    vidok: !!meta.vidok, ghash, mhash, meta,
  };
}

// 12 hex chars, like Blender's holo_id, for parts made here (duplicates) until Blender gives them one
export function localId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

const trisOf = g => (g.index ? g.index.count : g.attributes.position.count) / 3;

function texturesOf(materials, out = new Set()) {
  for (const m of materials) for (const v of Object.values(m)) if (v?.isTexture) out.add(v);
  return out;
}

export function createParts() {
  const root = new THREE.Group();
  root.name = 'holo_root';
  const byId = new Map();
  const hidden = new Set();   // ids; a view setting, so it survives reloads
  let look = null;            // one material shown instead of every part's own (clay view)

  const dress = part => {
    part.mesh.material = look || (part.materials.length === 1 ? part.materials[0] : part.materials);
    part.mesh.visible = !hidden.has(part.id);
  };
  function attach(part) {
    byId.set(part.id, part);
    root.add(part.mesh);
    dress(part);
  }
  function detach(part) {
    if (byId.get(part.id) === part) byId.delete(part.id);
    root.remove(part.mesh);
  }
  // GPU memory: geometry, the part's own material clones, and textures nothing live still uses
  function dispose(list) {
    const live = texturesOf([...byId.values()].flatMap(p => p.materials));
    for (const part of list) {
      part.mesh.geometry.dispose();
      for (const t of texturesOf(part.materials)) if (!live.has(t)) t.dispose();
      for (const m of part.materials) m.dispose();
    }
  }

  const reg = {
    root,
    get size() { return byId.size; },
    list: () => [...byId.values()],
    get: id => byId.get(id) || null,
    ofMesh: mesh => { const p = mesh && byId.get(mesh.userData.holo_id); return p && p.mesh === mesh ? p : null; },
    meshes: () => [...byId.values()].filter(p => p.mesh.visible).map(p => p.mesh),   // what can be pointed at
    // THINGS: parts that were built together (load.js thingId). A scene with one thing in it is handled as it
    // always was; with several, a hand takes hold of ONE of them.
    thingOf: part => { const k = part?.meta?.thingId ?? part?.id; return [...byId.values()].filter(p => (p.meta?.thingId ?? p.id) === k); },
    thingCount: () => new Set([...byId.values()].map(p => p.meta?.thingId ?? p.id)).size,
    findByName(words) {
      const w = String(words).toLowerCase().trim();
      const all = [...byId.values()];
      return all.find(p => p.name.toLowerCase() === w) || all.find(p => p.name.toLowerCase().includes(w)) || null;
    },
    stats() {
      let tris = 0;
      for (const p of byId.values()) tris += trisOf(p.mesh.geometry);
      return { parts: byId.size, tris };
    },

    // A new rev from Blender. Only parts whose hashes changed are replaced, so untouched parts keep their mesh
    // (and, from M2, their sculpt proxy and undo history):
    //   same ghash + mhash: keep the live part; mhash only: swap in the new materials; ghash: replace the part.
    // New ids are added, missing ids removed. A part edited here (dirty) is replaced: until sync arrives (M4)
    // Blender's copy is the truth.
    swap(incoming) {
      const report = { kept: [], restyled: [], replaced: [], added: [], removed: [] };
      const seen = new Set(), trash = [];
      for (const np of incoming) {
        seen.add(np.id);
        const old = byId.get(np.id);
        const clean = old && !old.dirty.mesh && !old.dirty.xform && !old.dirty.material;
        if (!old) { attach(np); report.added.push(np.id); continue; }
        if (clean && np.ghash && old.ghash === np.ghash) {
          old.name = np.name;
          old.meta = { ...np.meta };
          if (np.mhash && old.mhash === np.mhash) {
            trash.push(np);
            report.kept.push(np.id);
          } else {
            trash.push({ mesh: np.mesh, materials: old.materials });   // old materials go, new geometry isn't needed
            old.materials = np.materials;
            old.mhash = np.mhash;
            dress(old);
            report.restyled.push(np.id);
            np.materials = [];
          }
          continue;
        }
        detach(old);
        trash.push(old);
        attach(np);
        report.replaced.push(np.id);
      }
      for (const old of [...byId.values()]) {
        if (seen.has(old.id)) continue;
        detach(old);
        trash.push(old);
        report.removed.push(old.id);
      }
      dispose(trash);
      for (const id of hidden) if (!byId.has(id)) hidden.delete(id);
      return report;
    },

    clear() {
      const all = [...byId.values()];
      for (const p of all) detach(p);
      dispose(all);
      hidden.clear();
    },

    // ---------- view ops ----------
    hide(part) { hidden.add(part.id); dress(part); },
    isolate(part) {
      for (const p of byId.values()) { if (p === part) hidden.delete(p.id); else hidden.add(p.id); dress(p); }
    },
    showAll() {
      const n = hidden.size;
      hidden.clear();
      for (const p of byId.values()) dress(p);
      return n;
    },
    get hiddenCount() { return hidden.size; },
    setLook(material) {
      look = material || null;
      for (const p of byId.values()) dress(p);
    },
    // true when the new colour is actually on screen: clay view shows one shared material instead of these,
    // so a recolour under it changes nothing visible until the look goes back
    recolor(part, hex) {
      for (const m of part.materials) if (m.color) m.color.set(hex);
      part.dirty.material = true;
      return !look;
    },
    // "quick metal": metalness/roughness (and glass's transparency) on the part's own clones. Same return.
    setFinish(part, finish) {
      for (const m of part.materials) {
        for (const [k, v] of Object.entries(finish)) if (k in m) m[k] = v;
        m.needsUpdate = true;   // transparency changes which shader three compiles
      }
      part.dirty.material = true;
      return !look;
    },

    // ---------- local edits: in this view only until sync.js sends them to Blender (M4) ----------
    remove(part) {
      detach(part);
      return part;
    },
    restore(part) {
      attach(part);
      return part;
    },
    duplicate(part) {
      const src = part.mesh;
      const materials = part.materials.map(m => m.clone());
      const mesh = new THREE.Mesh(src.geometry.clone(), materials.length === 1 ? materials[0] : materials);
      mesh.position.copy(src.position);
      mesh.quaternion.copy(src.quaternion);
      mesh.scale.copy(src.scale);
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = src.receiveShadow;
      const width = reg.bounds([part]).getSize(new THREE.Vector3()).x;
      mesh.position.x += width * 1.1;   // beside the original, in the root frame
      let name = `${part.name} copy`;
      for (let k = 2; [...byId.values()].some(p => p.name === name); k++) name = `${part.name} copy ${k}`;
      const id = localId();
      mesh.name = name;
      mesh.userData = { ...src.userData, holo_id: id, holo_name: name };
      const copy = makePart({ id, name, mesh, materials, mhash: part.mhash, meta: { ...part.meta, local: true, dupOf: part.id } });
      copy.dirty.mesh = copy.dirty.xform = true;
      attach(copy);
      return copy;
    },
    dispose: list => dispose(list),

    // The parts' box in the root frame (metres); all parts, or just `list`.
    bounds(list = null) {
      const box = new THREE.Box3(), b = new THREE.Box3();
      for (const p of list || byId.values()) {
        const g = p.mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        p.mesh.updateMatrix();
        box.union(b.copy(g.boundingBox).applyMatrix4(p.mesh.matrix));
      }
      return box;
    },
  };
  return reg;
}
