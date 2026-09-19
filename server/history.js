// Version history of Blender mode: every build (and every "save version") is kept with the request, what Fable
// did, its sources, the cost, a thumbnail and a full snapshot of the scene, so you can jump back to any version,
// even after closing Blender.
// Stored in MongoDB Atlas when MONGODB_URI is set: metadata + thumbnails in the "versions" collection, scene
// snapshots in GridFS ("snapshots" bucket). Until then, the same thing in local files under ~/.holomodel/history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const HOME = process.env.HOLOMODEL_HOME || path.join(os.homedir(), '.holomodel');   // HOLOMODEL_HOME: tests use their own
export const LOCAL_DIR = path.join(HOME, 'history');
const CACHE_DIR = path.join(HOME, 'history-cache');   // Atlas snapshots downloaded for Blender to open
export const SNAPSHOT_DIR = path.join(HOME, 'snapshots');   // where Blender writes a fresh snapshot
export const WORKING_DIR = path.join(HOME, 'working');      // copies Blender opens when you go back to a version

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const PUBLIC = ({ _id, id, thumb, blendFileId, ...rest }) => ({ id: String(id ?? _id), ...rest });

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

  async add(meta, blendPath, thumbPng) {
    const all = this.#read();
    const id = newId();
    fs.copyFileSync(blendPath, path.join(LOCAL_DIR, `${id}.blend`));
    if (thumbPng) fs.writeFileSync(path.join(LOCAL_DIR, `${id}.png`), thumbPng);
    const doc = { id, n: all.length + 1, ...meta, createdAt: new Date().toISOString() };
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

  async blendPath(id) {
    const p = path.join(LOCAL_DIR, `${id}.blend`);
    return fs.existsSync(p) ? p : null;
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

  async add(meta, blendPath, thumbPng) {
    const id = newId();
    const upload = this.bucket.openUploadStream(`${id}.blend`, { metadata: { versionId: id } });
    await pipeline(fs.createReadStream(blendPath), upload);
    const { Binary } = await import('mongodb');
    const last = await this.versions.find({}, { projection: { n: 1 } }).sort({ n: -1 }).limit(1).next();
    const doc = { id, n: (last?.n || 0) + 1, ...meta, createdAt: new Date(), blendFileId: upload.id,
                  thumb: thumbPng ? new Binary(thumbPng) : null };
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

  async blendPath(id, dir = CACHE_DIR) {
    const doc = await this.versions.findOne({ id }, { projection: { blendFileId: 1 } });
    if (!doc?.blendFileId) return null;
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${id}.blend`);
    if (!fs.existsSync(out)) await pipeline(this.bucket.openDownloadStream(doc.blendFileId), fs.createWriteStream(out));
    return out;
  }

  close() { return this.client.close(); }
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
