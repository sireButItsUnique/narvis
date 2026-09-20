// Saving and going back to versions of the scene (the storage itself is in history.js).
// A version is the scene as a .blend (Blender reopens it, modifiers and all) and a GLB (what the web shows), plus a
// thumbnail, saved after every build or when you say "save version". Each remembers which version it grew from,
// so "go back" follows your actual path, like undo across builds. Which version the scene is at survives server
// restarts (in scene.js's state.json).
import fs from 'node:fs';
import path from 'node:path';
import { bridge } from './blender.js';
import { history, pruneHistory, SNAPSHOT_DIR, WORKING_DIR } from './history.js';
import { publish, sceneVersion, sceneFingerprint, currentGlbPath, setVersion } from './scene.js';

export class VersionError extends Error {}

async function currentVersion(store) {
  const n = sceneVersion();
  if (n != null) return store.find(n);
  const [latest] = await store.list(1);   // never set in this home: assume the newest, as before
  return latest || null;
}

export function saveVersion(meta) {
  return (async () => {
    const store = await history();
    const parent = await currentVersion(store);
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = `${Date.now()}-${process.pid}`;
    const tmp = path.join(SNAPSHOT_DIR, `snap-${stamp}.blend`);
    let glbTmp = null;
    const snap = await bridge('snapshot', { path: tmp }, { timeout: 60000 });
    if (!snap.ok) throw new VersionError(`Couldn't save the scene: ${snap.error}`);
    try {
      // the page's GLB is this scene's GLB unless Blender changed since it was exported
      let glb = snap.fingerprint === sceneFingerprint() ? currentGlbPath() : null;
      if (!glb && snap.objects) {
        glbTmp = path.join(SNAPSHOT_DIR, `snap-${stamp}.glb`);
        const r = await bridge('export_glb', { path: glbTmp, mode: 'final' }, { timeout: 120000 });
        if (r.ok && !r.empty) glb = glbTmp;
      }
      // 128, not 256: the strip draws these 58 px wide, so 256 was four times the pixels nobody
      // sees and about 50 kB each. Measured on an 18-version history that was 700 kB of the page's
      // first load. 128 covers a 58 px slot on a 2x screen exactly.
      const shot = await bridge('render', { views: ['three_quarter'], size: 128 }, { timeout: 60000 }).catch(() => null);
      const thumb = shot?.ok ? Buffer.from(shot.images[0].png, 'base64') : null;   // an empty scene has none
      const v = await store.add({ kind: 'build', ...meta, parent: parent?.n ?? null, objects: snap.objects,
                                  bytes: snap.bytes, fingerprint: snap.fingerprint, store: store.kind },
                                { blend: tmp, glb }, thumb);
      setVersion(v.n);
      // storage grows by a .blend + a GLB + a thumbnail per build: keep the recent ones and the path back
      const dropped = await pruneHistory(store, { at: v.n }).catch(err => {
        console.warn(`[history] couldn't prune old versions: ${err.message}`);
        return 0;
      });
      if (dropped) console.log(`[history] pruned ${dropped} old version${dropped === 1 ? '' : 's'}`);
      return v;
    } finally {
      fs.rmSync(tmp, { force: true });
      if (glbTmp) fs.rmSync(glbTmp, { force: true });
    }
  })();
}

// Keep what's in Blender as a version before something replaces it, unless the scene is empty or is exactly the
// version it was last saved or opened as. Returns the version it saved, or null when there was nothing to keep.
export async function checkpointIfChanged(prompt) {
  const store = await history();
  const now = await bridge('fingerprint', {}, { timeout: 30000 });
  const at = await currentVersion(store);
  const unchanged = now.ok && at?.fingerprint && now.fingerprint === at.fingerprint;
  return now.objects && !unchanged ? saveVersion({ kind: 'checkpoint', prompt }) : null;
}

// which version "version 3", "previous" or an id means
async function resolve(store, which) {
  if (which === 'previous') {
    const now = await currentVersion(store);
    if (!now) throw new VersionError('There are no saved versions yet.');
    if (now.parent == null) throw new VersionError(`Version ${now.n} is the first one; there's nothing before it.`);
    return store.find(now.parent);
  }
  if (which === 'latest') return (await store.list(1))[0] || null;
  return store.find(which);
}

// Opens a saved version in Blender and publishes it to the page. The scene you're leaving is saved first (as a
// checkpoint), so nothing is lost. Works for versions saved before the GLB existed: the .blend is the truth.
export function restoreVersion(which) {
  return (async () => {
    const store = await history();
    const v = await resolve(store, which);
    if (!v) throw new VersionError(`There's no version ${which}.`);
    const src = await store.blendPath(v.id);
    if (!src) throw new VersionError(`Version ${v.n}'s snapshot is missing.`);

    const checkpoint = await checkpointIfChanged(`before going back to version ${v.n}`);

    // Blender opens a copy, so nothing it does can touch the history itself
    fs.mkdirSync(WORKING_DIR, { recursive: true });
    const work = path.join(WORKING_DIR, 'restore.blend');
    fs.copyFileSync(src, work);
    const r = await bridge('restore', { path: work }, { timeout: 60000 });
    if (!r.ok) throw new VersionError(`Blender couldn't open version ${v.n}: ${r.error}`);
    const s = await publish(`version ${v.n}`);
    setVersion(v.n);
    return { version: v, checkpoint, rev: s.rev };
  })();
}

export async function listVersions(limit = 50) {
  const store = await history();
  const now = await currentVersion(store);
  return { versions: await store.list(limit), current: now?.n ?? null };
}

export async function versionThumb(id) {
  return (await history()).thumb(id);
}

// a version's GLB (null for versions saved before there was one)
export async function versionGlb(idOrN) {
  const store = await history();
  const v = await store.find(idOrN);
  return v ? store.glbPath(v.id) : null;
}
