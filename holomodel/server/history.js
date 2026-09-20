// Version history: every build (and every "save version") is kept with the request, what Fable did, its sources,
// the cost, a thumbnail, the scene as a .blend (what Blender reopens, modifiers and all) and as a GLB (what the web
// shows), so you can jump back to any version. Versions from before the web viewer have only the .blend.
// Stored in MongoDB Atlas when MONGODB_URI is set: metadata + thumbnails in the "versions" collection, the .blend
// and .glb files in GridFS ("snapshots" bucket). Until then, the same thing in local files under ~/.holomodel/history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const HOME = process.env.HOLOMODEL_HOME || path.join(os.homedir(), '.holomodel');   // HOLOMODEL_HOME: tests use their own
export const LOCAL_DIR = path.join(HOME, 'history');
const CACHE_DIR = path.join(HOME, 'history-cache');   // Atlas files downloaded for Blender and the page
export const SNAPSHOT_DIR = path.join(HOME, 'snapshots');   // where Blender writes a fresh snapshot
export const WORKING_DIR = path.join(HOME, 'working');      // the scene being worked on: autosave, GLBs, state
export const CURRENT_BLEND = path.join(WORKING_DIR, 'current.blend');   // the autosave Blender reopens

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const PUBLIC = ({ _id, id, thumb, blendFileId, glbFileId, ...rest }) => ({ id: String(id ?? _id), ...rest });
// add() takes {blend, glb} paths; a bare path is a .blend (how versions were saved before the GLB)
const filesOf = files => (typeof files === 'string' ? { blend: files } : files || {});

// ---------- local files ----------
export class LocalStore {
  kind = 'local';

  constructor() {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    this.indexFile = path.join(LOCAL_DIR, 'index.json');
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { return []; }
  }

  async add(meta, files, thumbPng) {
    const { blend, glb } = filesOf(files);
    const all = this.#read();
    const id = newId();
    fs.copyFileSync(blend, path.join(LOCAL_DIR, `${id}.blend`));
    if (glb) fs.copyFileSync(glb, path.join(LOCAL_DIR, `${id}.glb`));
    if (thumbPng) fs.writeFileSync(path.join(LOCAL_DIR, `${id}.png`), thumbPng);
    // from the highest n, not the count: pruning removes old entries, and a recycled n would collide with the
    // version numbers people say out loud and with the parent chain
    const doc = { id, n: Math.max(0, ...all.map(v => Number(v.n) || 0)) + 1, ...meta,
                  ...(glb ? { glbBytes: fs.statSync(glb).size } : {}), createdAt: new Date().toISOString() };
    all.push(doc);
    fs.writeFileSync(this.indexFile, JSON.stringify(all, null, 1));
    return doc;
  }

  async list(limit = 50) {
    return this.#read().slice(-limit).reverse();
  }

  async find(idOrN) {
    return this.#read().find(v => v.id === idOrN || v.n === Number(idOrN)) || null;
  }

  async thumb(id) {
    try { return fs.readFileSync(path.join(LOCAL_DIR, `${id}.png`)); } catch { return null; }
  }

  #file(id, ext) {
    if (!/^[\w-]{1,40}$/.test(id)) return null;
    const p = path.join(LOCAL_DIR, `${id}.${ext}`);
    return fs.existsSync(p) ? p : null;
  }

  async blendPath(id) { return this.#file(id, 'blend'); }

  async glbPath(id) { return this.#file(id, 'glb'); }

  async remove(ids) {
    const gone = new Set(ids);
    fs.writeFileSync(this.indexFile, JSON.stringify(this.#read().filter(v => !gone.has(v.id)), null, 1));
    for (const id of gone) {
      for (const ext of ['blend', 'glb', 'png']) fs.rmSync(path.join(LOCAL_DIR, `${id}.${ext}`), { force: true });
    }
    return gone.size;
  }
}

// ---------- MongoDB Atlas ----------
export class AtlasStore {
  kind = 'atlas';

  async init(uri, dbName = process.env.MONGODB_DB || 'holomodel') {
    const { MongoClient, GridFSBucket } = await import('mongodb');
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'holomodel' });
    await this.client.connect();
    const db = this.db = this.client.db(dbName);
    this.versions = db.collection('versions');
    this.bucket = new GridFSBucket(db, { bucketName: 'snapshots' });
    await this.versions.createIndex({ n: 1 }, { unique: true });
    await this.versions.createIndex({ createdAt: -1 });
    return this;
  }

  async #upload(file, name, id) {
    const upload = this.bucket.openUploadStream(name, { metadata: { versionId: id } });
    await pipeline(fs.createReadStream(file), upload);
    return upload.id;
  }

  async add(meta, files, thumbPng) {
    const { blend, glb } = filesOf(files);
    const id = newId();
    const blendFileId = await this.#upload(blend, `${id}.blend`, id);
    const glbFileId = glb ? await this.#upload(glb, `${id}.glb`, id) : null;
    const { Binary } = await import('mongodb');
    const last = await this.versions.find({}, { projection: { n: 1 } }).sort({ n: -1 }).limit(1).next();
    const doc = { id, n: (last?.n || 0) + 1, ...meta, ...(glb ? { glbBytes: fs.statSync(glb).size, glbFileId } : {}),
                  createdAt: new Date(), blendFileId, thumb: thumbPng ? new Binary(thumbPng) : null };
    await this.versions.insertOne(doc);
    return PUBLIC(doc);
  }

  async list(limit = 50) {
    const docs = await this.versions.find({}, { projection: { thumb: 0 } }).sort({ n: -1 }).limit(limit).toArray();
    return docs.map(PUBLIC);
  }

  async find(idOrN) {
    const doc = await this.versions.findOne(
      { $or: [{ id: String(idOrN) }, { n: Number(idOrN) || -1 }] }, { projection: { thumb: 0 } });
    return doc ? PUBLIC(doc) : null;
  }

  async thumb(id) {
    const doc = await this.versions.findOne({ id }, { projection: { thumb: 1 } });
    return doc?.thumb ? Buffer.from(doc.thumb.value()) : null;
  }

  // downloads once into the cache; written to .part and renamed, so an interrupted download is never mistaken
  // for a finished one
  async #download(id, field, ext, dir) {
    const doc = await this.versions.findOne({ id }, { projection: { [field]: 1 } });
    if (!doc?.[field]) return null;
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${id}.${ext}`);
    if (!fs.existsSync(out)) {
      const part = `${out}.${process.pid}.part`;
      try {
        await pipeline(this.bucket.openDownloadStream(doc[field]), fs.createWriteStream(part));
        fs.renameSync(part, out);
      } finally {
        fs.rmSync(part, { force: true });
      }
    }
    return out;
  }

  blendPath(id, dir = CACHE_DIR) { return this.#download(id, 'blendFileId', 'blend', dir); }

  glbPath(id, dir = CACHE_DIR) { return this.#download(id, 'glbFileId', 'glb', dir); }

  // the documents are tiny; the 512 MB on an M0 is the GridFS files, so those have to go too
  async remove(ids) {
    const docs = await this.versions.find({ id: { $in: [...ids] } },
                                          { projection: { id: 1, blendFileId: 1, glbFileId: 1 } }).toArray();
    for (const d of docs) {
      for (const fileId of [d.blendFileId, d.glbFileId]) {
        if (fileId) await this.bucket.delete(fileId).catch(() => {});   // already gone is fine
      }
      for (const ext of ['blend', 'glb']) fs.rmSync(path.join(CACHE_DIR, `${d.id}.${ext}`), { force: true });
    }
    await this.versions.deleteMany({ id: { $in: docs.map(d => d.id) } });
    return docs.length;
  }

  close() { return this.client.close(); }
}

// ---------- pruning ----------
export const KEEP_VERSIONS = 40;   // a version is a .blend + a GLB + a thumbnail, and Atlas M0 holds 512 MB

// Drop the oldest versions once there are more than `keep`. The version the scene is at (`at`) and the parents
// "go back a version" would walk to are kept however old they are, or restoring would find no .blend.
export async function pruneHistory(store, { keep = KEEP_VERSIONS, at = null } = {}) {
  const all = await store.list(1000);   // newest first
  if (all.length <= keep || !store.remove) return 0;
  const byN = new Map(all.map(v => [v.n, v]));
  const safe = new Set();
  for (let v = byN.get(Number(at)) ?? all[0]; v && !safe.has(v.n); v = byN.get(v.parent)) safe.add(v.n);
  const old = all.slice(keep).filter(v => !safe.has(v.n));
  return old.length ? store.remove(old.map(v => v.id)) : 0;
}

// ---------- which one ----------
let store = null, opening = null, note = '';

export const history = () => (opening ||= open());   // connects once, however many callers race to it

async function open() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (uri) {
    try {
      store = await new AtlasStore().init(uri);
      console.log('History: MongoDB Atlas');
      return store;
    } catch (err) {
      note = `MongoDB Atlas unreachable (${err.message}); using local files`;
      console.warn(`History: ${note}`);
    }
  }
  store = new LocalStore();
  return store;
}

export const historyInfo = () => ({ kind: store?.kind || ((process.env.MONGODB_URI || '').trim() ? 'atlas' : 'local'), note });
