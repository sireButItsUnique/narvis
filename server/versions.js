// Saving and going back to versions of the Blender scene (the storage itself is in history.js).
// A version is a full snapshot of the scene plus a thumbnail, saved after every build or when you say "save version".
// Each remembers which version it grew from, so "go back" follows your actual path, like undo across builds.
import fs from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/node';
import { bridge } from './blender.js';
import { history, SNAPSHOT_DIR, WORKING_DIR } from './history.js';

export class VersionError extends Error {}

let current = null;   // the version the scene is at: set on save and restore; unknown after a server restart

async function currentVersion(store) {
  if (current) return current;
  const [latest] = await store.list(1);
  return latest || null;
}

export function saveVersion(meta) {
  return Sentry.startSpan({ op: 'holomodel.version.save', name: 'save version' }, async () => {
    const store = await history();
    const parent = await currentVersion(store);
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const tmp = path.join(SNAPSHOT_DIR, `snap-${Date.now()}.blend`);
    const snap = await bridge('snapshot', { path: tmp }, { timeout: 60000 });
    if (!snap.ok) throw new VersionError(`Couldn't save the scene: ${snap.error}`);
    try {
      const shot = await bridge('render', { views: ['three_quarter'], size: 256 }, { timeout: 60000 }).catch(() => null);
      const thumb = shot?.ok ? Buffer.from(shot.images[0].png, 'base64') : null;   // an empty scene has none
      const v = await store.add({ kind: 'build', ...meta, parent: parent?.n ?? null, objects: snap.objects,
                                  bytes: snap.bytes, fingerprint: snap.fingerprint, store: store.kind }, tmp, thumb);
      current = v;
      return v;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
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

// Opens a saved version in Blender. The scene you're leaving is saved first (as a checkpoint), so nothing is lost.
export function restoreVersion(which) {
  return Sentry.startSpan({ op: 'holomodel.version.restore', name: 'restore version' }, async () => {
    const store = await history();
    const v = await resolve(store, which);
    if (!v) throw new VersionError(`There's no version ${which}.`);
    const src = await store.blendPath(v.id);
    if (!src) throw new VersionError(`Version ${v.n}'s snapshot is missing.`);

    // keep what's in Blender now, unless it's empty or exactly the version it was last saved/opened as
    const now = await bridge('fingerprint', {}, { timeout: 30000 });
    const at = await currentVersion(store);
    const unchanged = now.ok && at?.fingerprint && now.fingerprint === at.fingerprint;
    const checkpoint = now.objects && !unchanged
      ? await saveVersion({ kind: 'checkpoint', prompt: `before going back to version ${v.n}` })
      : null;

    // Blender opens a working copy, so saving in Blender (Ctrl+S) never overwrites the history itself
    fs.mkdirSync(WORKING_DIR, { recursive: true });
    const work = path.join(WORKING_DIR, `version-${v.n}.blend`);
    fs.copyFileSync(src, work);
    const r = await bridge('restore', { path: work }, { timeout: 60000 });
    if (!r.ok) throw new VersionError(`Blender couldn't open version ${v.n}: ${r.error}`);
    current = v;
    return { version: v, checkpoint };
  });
}

export async function listVersions(limit = 50) {
  const store = await history();
  const now = await currentVersion(store);
  return { versions: await store.list(limit), current: now?.n ?? null };
}

export async function versionThumb(id) {
  return (await history()).thumb(id);
}
