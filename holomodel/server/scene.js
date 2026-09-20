// The working scene: what's in the headless Blender right now, as the GLB the page shows. Anything that changes the
// Blender scene (a build, going back to a version) ends with publish(), which exports it, autosaves the .blend
// and bumps rev. The page polls GET /api/scene (cheap JSON) and loads /api/scene/<rev>.glb when rev moves.
// This survives a server restart: HOLOMODEL_HOME/working holds state.json, the GLBs and the autosave Blender reopens.
import fs from 'node:fs';
import path from 'node:path';
import { bridge } from './blender.js';
import { blender } from './blender-process.js';
import { WORKING_DIR, CURRENT_BLEND } from './history.js';

export class SceneError extends Error {}

const STATE_FILE = path.join(WORKING_DIR, 'state.json');
const KEEP_GLBS = 4;   // at least the last 3 revs stay downloadable while the page catches up
const NO_SYM = { x: false, y: false, z: false };
const glbName = rev => `scene-${rev}.glb`;

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

let state = null;      // { rev, glb: file name | null, parts, sym, name, version, fingerprint }
let busy = null;       // { kind } while a build or version change owns the scene
let chain = Promise.resolve();   // publishes run one at a time

function leftoverRev() {   // a fresh state.json starts past old GLBs, so a cached /api/scene/<rev>.glb is never stale
  try {
    return Math.max(0, ...fs.readdirSync(WORKING_DIR).map(f => Number(f.match(/^scene-(\d+)\.glb$/)?.[1] ?? 0)));
  } catch { return 0; }
}

export function loadScene() {
  if (state) return state;
  const fresh = { rev: 0, glb: null, parts: [], sym: NO_SYM, name: '', version: null, fingerprint: null };
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (saved && Number.isInteger(saved.rev)) {
    state = { ...fresh, ...saved };
    // the GLB shows a scene only the autosave can bring back into Blender: without both, start empty
    if (state.glb && !(fs.existsSync(path.join(WORKING_DIR, state.glb)) && fs.existsSync(CURRENT_BLEND))) {
      state = { ...fresh, rev: state.rev + 1 };
      save();
    }
  } else {
    state = { ...fresh, rev: leftoverRev() };
  }
  return state;
}

function save() {
  fs.mkdirSync(WORKING_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

function prune() {
  let files;
  try { files = fs.readdirSync(WORKING_DIR).filter(f => /^scene-\d+\.glb$/.test(f)); } catch { return; }
  const old = files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])).slice(KEEP_GLBS);
  for (const f of old) {
    if (f === state.glb) continue;
    try { fs.rmSync(path.join(WORKING_DIR, f)); } catch {}   // still being downloaded: next time
  }
}

// what the page polls
export function sceneInfo() {
  const s = loadScene();
  const { state: bs, message } = blender.state();
  return { rev: s.rev, glb: s.glb ? `/api/scene/${s.rev}.glb` : null, parts: s.parts, sym: s.sym,
           building: busy?.kind === 'build', version: s.version,
           blender: { state: bs, ...(message ? { message } : {}) } };
}

export const sceneVersion = () => loadScene().version;
export const sceneFingerprint = () => loadScene().fingerprint;
export const currentGlbPath = () => (loadScene().glb ? path.join(WORKING_DIR, state.glb) : null);

export function setVersion(n) {
  loadScene();
  state = { ...state, version: n ?? null };
  save();
}

// One owner at a time for anything that changes the scene; returns release(), or null when it's taken.
export function lock(kind) {
  if (busy) return null;
  const mine = { kind };
  busy = mine;
  return () => { if (busy === mine) busy = null; };
}

export const busyWith = () => busy?.kind || null;

// Export Blender's scene as the next rev and autosave it. mode 'final' for now (the procedural bake is M5).
export function publish(reason, { mode = 'final' } = {}) {
  const run = chain.then(() => doPublish(reason, mode));
  chain = run.catch(() => {});
  return run;
}

async function doPublish(reason, mode) {
  const s = loadScene();
  const rev = s.rev + 1;
  const file = path.join(WORKING_DIR, glbName(rev));
  fs.mkdirSync(WORKING_DIR, { recursive: true });
  const t0 = Date.now();
  let r;
  try {
    r = await bridge('export_glb', { path: file, mode, rev }, { timeout: 120000 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (!r.ok) {
    fs.rmSync(file, { force: true });
    throw new SceneError(`Couldn't export the scene for the web: ${r.error}`);
  }
  // the autosave matches this rev, so a restarted Blender reopens exactly what the page shows
  const saved = await bridge('save_working', { path: CURRENT_BLEND }, { timeout: 60000 })
    .catch(err => ({ ok: false, error: err.message }));
  if (!saved.ok) console.warn(`[scene] couldn't autosave the working scene: ${saved.error}`);
  // the exports above take seconds, and setVersion() may have run meanwhile: merge into the live state, not the
  // copy this publish started from, or a version number set while exporting is written back to the old one
  state = { ...loadScene(), rev, glb: r.empty ? null : glbName(rev), parts: r.parts, sym: r.sym || NO_SYM,
            name: r.name || '', fingerprint: r.fingerprint };
  save();
  prune();
  console.log(`[scene] rev ${rev} (${reason}): ${r.parts.length} parts, ${r.tris} tris` +
              (r.empty ? ', empty' : `, ${(r.bytes / 1e6).toFixed(2)} MB`) + ` in ${Date.now() - t0} ms`);
  const skipped = r.skipped || [];
  if (skipped.length) console.warn(`[scene] glTF has no mesh for ${skipped.map(o => `${o.name} (${o.type})`).join(', ')}: not in the GLB`);
  return { ...state, skipped };   // what the page can't be shown travels with the publish, not into state.json
}

// After Blender (re)starts: if what it opened isn't what the page was last given (a server killed between export
// and autosave, an autosave with no GLB), publish what it has. Builds and restores publish for themselves.
// It owns the scene like everyone else while it looks and publishes, so a checkpoint or restore can't slip its
// own Blender calls between the fingerprint and the export.
async function reconcile() {
  const release = lock('reconcile');
  if (!release) return;
  try {
    const s = loadScene();
    const fp = await bridge('fingerprint', {}, { timeout: 30000 });
    if (!fp.ok || fp.fingerprint === s.fingerprint || (!fp.objects && !s.glb)) return;
    await publish('Blender reopened a different scene');
  } finally {
    release();
  }
}

export function watchBlender() {
  blender.on('ready', () => reconcile().catch(err => console.warn(`[scene] after Blender started: ${err.message}`)));
}

// The working .blend, as "export" offers it beside the GLB: Blender's own file, with the modifiers, node trees
// and UVs the GLB flattens or triangulates away. save_working writes it atomically (temp name, then rename), so
// a download during a publish still gets a whole file — but it's overwritten every publish, so never cached.
function sendBlend(req, res, json) {
  const s = loadScene();
  fs.stat(CURRENT_BLEND, (err, st) => {
    if (err || !st.isFile()) return json(404, { error: 'not_found', message: 'no working .blend yet' });
    const name = `${slug(s.name || 'model')}-${s.rev}.blend`;
    res.writeHead(200, { 'Content-Type': 'application/x-blender', 'Content-Length': st.size,
                         'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name}"` });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(CURRENT_BLEND).on('error', () => res.destroy()).pipe(res);
  });
}

// GET /api/scene, GET /api/scene/<rev>.glb and GET /api/scene/current.blend
export function sceneRoute(req, res, pathname) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'method_not_allowed', message: 'GET only' });
  if (pathname === '/api/scene') return json(200, sceneInfo());
  if (pathname === '/api/scene/current.blend') return sendBlend(req, res, json);
  const m = pathname.match(/^\/api\/scene\/(\d{1,12})\.glb$/);
  if (!m) return json(404, { error: 'not_found' });
  const file = path.join(WORKING_DIR, glbName(Number(m[1])));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(404, { error: 'not_found', message: `no GLB for rev ${m[1]}` });
    // a rev's GLB never changes, so the browser can keep it for good
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': st.size,
                         'Cache-Control': 'public, max-age=31536000, immutable' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}
