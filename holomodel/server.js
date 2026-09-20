// Local server: serves public/, runs a hidden Blender where Claude Fable builds what you ask for, and hands the page
// the result as a GLB. Run with `npm start`, then open http://localhost:8765 in Edge.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridge, buildInBlender, blenderModel, BridgeError } from './server/blender.js';
import { blender } from './server/blender-process.js';
import { loadScene, watchBlender, sceneRoute, sceneInfo, publish, lock, busyWith, SceneError } from './server/scene.js';
import { saveVersion, restoreVersion, checkpointIfChanged, listVersions, versionThumb, versionGlb, VersionError } from './server/versions.js';
import { history, historyInfo, LOCAL_DIR } from './server/history.js';
import { addEdit, listEdits, dropLastEdit, clearEdits, editsInfo, EditsError } from './server/edits.js';
import { voiceAvailable, transcribe, speak, warmUp } from './server/voice.js';
import { textureToolAvailable } from './server/texture-tool.js';
import { onlineUrl } from './server/vendor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch {}   // .env is optional; without it only local commands work

const root = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
                '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const hasKey = () => !!(process.env.OPENAI_API_KEY || '').trim();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

// what "make a ___" runs on: Fable, in the hidden Blender
function status(res) {
  sendJson(res, 200, { provider: hasKey() ? 'anthropic' : null, model: blenderModel(), blender: sceneInfo().blender });
}

const BUSY_MESSAGES = { build: 'Still building the last one. Say "cancel" to stop it.',
                        detail: 'Still adding detail; one moment.',
                        reconcile: 'Just catching up with Blender; one moment.' };
const busyMessage = () => BUSY_MESSAGES[busyWith()] || 'Still switching versions; one moment.';

// ---------- the hidden Blender ----------
async function blenderStatus(res) {
  const base = { model: blenderModel(), key: hasKey(), building: busyWith() === 'build', process: blender.state() };
  try {
    const r = await bridge('ping', {}, { timeout: 3000 });
    sendJson(res, 200, { ...base, connected: !!r.ok, blender: r.blender, file: r.file, objects: r.objects });
  } catch (err) {
    sendJson(res, 200, { ...base, connected: false, message: err.message });
  }
}

// "Add detail": subdivide the mesh so there is something to sculpt WITH.
//
// A model Fable builds is as coarse as it can be and still look right - a flat face is two
// triangles, because nothing about the picture needs more. Sculpting needs the opposite: the brush
// moves vertices, so a 4 cm brush on a face with a vertex every centimetre has about nineteen of
// them to work with, and pulling those nineteen a long way gives flat sails with hard creases
// instead of clay. Smoothing cannot fix that - it averages vertices, and there are none to average.
//
// So this splits every edge in two: a quad becomes four, the shape is unchanged (a linear split
// moves nothing), and the brush has four times the vertices per pass. One level at a time, with a
// ceiling, because each level quadruples the triangle count and the page has to draw it at 60 fps.
const DETAIL_CAP_TRIS = 400_000;
const DETAIL_PY = (ids) => `
ids = ${JSON.stringify(ids)}
targets = [o for o in bpy.data.objects
           if o.type == 'MESH' and (not ids or o.get('holo_id') in ids)]
total = sum(len(o.data.polygons) for o in targets)
if not targets:
    print('nothing to subdivide')
elif total * 4 > ${DETAIL_CAP_TRIS}:
    print('already dense: %d faces' % total)
else:
    for o in targets:
        me = o.data
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
        bm.to_mesh(me)
        bm.free()
        me.update()
    print('subdivided %d part(s): %d -> %d faces'
          % (len(targets), total, sum(len(o.data.polygons) for o in targets)))
`;

async function blenderDetail(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const ids = Array.isArray(body.ids) ? body.ids.filter(s => typeof s === 'string').slice(0, 40) : [];
  const release = lock('detail');
  if (!release) return sendJson(res, 409, { error: 'busy', message: busyMessage() });
  try {
    const r = await bridge('exec', { code: DETAIL_PY(ids), label: 'Add detail' }, { timeout: 120000 });
    if (!r.ok) return sendJson(res, 502, { error: 'blender', message: r.error || 'subdivide failed' });
    const note = String(r.output || '').trim().split('\n').pop() || 'detail added';
    // Nothing to export if Blender decided it was already dense enough; publishing anyway would
    // hand the page a new rev that is byte-for-byte the old one and throw away its sculpt edits.
    if (/already dense|nothing to subdivide/.test(note)) return sendJson(res, 200, { ok: true, changed: false, message: note });
    const state = await publish('detail added');
    return sendJson(res, 200, { ok: true, changed: true, message: note, rev: state.rev });
  } catch (err) {
    const status = err instanceof BridgeError || err instanceof SceneError ? 502 : 500;
    return sendJson(res, status, { error: 'blender', message: err.message });
  } finally {
    release();
  }
}

// Delete objects, in Blender, for good. The page could hide a part on its own - it did, and that was
// the problem: the thing came back on the next revision, it was still in the .blend, and it was
// still in anything exported. A delete somebody asked for out loud has to be the real one.
const DELETE_PY = (ids) => `
ids = ${JSON.stringify(ids)}
gone = []
for o in [o for o in bpy.data.objects if o.get('holo_id') in ids]:
    gone.append(o.name)
    bpy.data.objects.remove(o, do_unlink=True)
print('deleted: %s' % (', '.join(gone) if gone else 'nothing'))
`;

// One THING moved, turned or resized by hand, apart from the rest of the scene. The page sends the ids of the
// thing's parts and the change as a 4x4 in its own frame - the glTF scene: metres, Y up - and Blender applies
// it to the objects' world matrices in ITS frame (Z up; glTF's (x, y, z) is Blender's (x, -z, y)), so the next
// thing Fable builds finds the teapot where the hand left it, and the next export does not put it back.
// If every mesh under a parent Empty is part of the thing, the Empty is what moves, and the thing stays a thing.
const XFORM_PY = (ids, rows) => `
import mathutils
ids = set(${JSON.stringify(ids)})
G = mathutils.Matrix(${JSON.stringify(rows)})
C = mathutils.Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))   # Blender -> glTF
D = C.inverted() @ G @ C
chosen = [o for o in bpy.data.objects if o.get('holo_id') in ids]
inside = set(chosen)
def meshes_under(o):
    return [c for c in o.children_recursive if c.type == 'MESH']
tops = []
for o in chosen:
    top = o
    while top.parent is not None and all(m in inside for m in meshes_under(top.parent)):
        top = top.parent
    if top not in tops:
        tops.append(top)
tops = [t for t in tops if not any(t in u.children_recursive for u in tops if u is not t)]
bpy.context.view_layer.update()
for t in tops:
    t.matrix_world = D @ t.matrix_world
bpy.context.view_layer.update()
print('moved: %s' % (', '.join(t.name for t in tops) if tops else 'nothing'))
`;

async function blenderXform(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const ids = Array.isArray(body.ids) ? body.ids.filter(s => typeof s === 'string').slice(0, 80) : [];
  const m = Array.isArray(body.matrix) && body.matrix.length === 16 && body.matrix.every(Number.isFinite) ? body.matrix : null;
  if (!ids.length || !m) return sendJson(res, 400, { error: 'bad_request', message: 'ids and a 16-number column-major matrix' });
  const rows = [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => m[c * 4 + r]));      // three.js is column-major; mathutils wants rows
  const release = lock('detail');
  if (!release) return sendJson(res, 409, { error: 'busy', message: busyMessage() });
  try {
    const r = await bridge('exec', { code: XFORM_PY(ids, rows), label: 'Move' }, { timeout: 60000 });
    if (!r.ok) return sendJson(res, 502, { error: 'blender', message: r.error || 'move failed' });
    const note = String(r.output || '').trim().split('\n').pop() || '';
    if (/nothing/.test(note)) return sendJson(res, 200, { ok: true, changed: false, message: 'nothing to move' });
    const state = await publish('moved');
    return sendJson(res, 200, { ok: true, changed: true, message: note, rev: state.rev });
  } catch (err) {
    const status = err instanceof BridgeError || err instanceof SceneError ? 502 : 500;
    return sendJson(res, status, { error: 'blender', message: err.message });
  } finally {
    release();
  }
}

async function blenderDelete(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const ids = Array.isArray(body.ids) ? body.ids.filter(s => typeof s === 'string').slice(0, 40) : [];
  if (!ids.length) return sendJson(res, 400, { error: 'bad_request', message: 'which part?' });
  const release = lock('detail');
  if (!release) return sendJson(res, 409, { error: 'busy', message: busyMessage() });
  try {
    const r = await bridge('exec', { code: DELETE_PY(ids), label: 'Delete' }, { timeout: 60000 });
    if (!r.ok) return sendJson(res, 502, { error: 'blender', message: r.error || 'delete failed' });
    const note = String(r.output || '').trim().split('\n').pop() || '';
    if (/nothing/.test(note)) return sendJson(res, 200, { ok: true, changed: false, message: 'nothing to delete' });
    const state = await publish('deleted');
    return sendJson(res, 200, { ok: true, changed: true, message: note, rev: state.rev });
  } catch (err) {
    const status = err instanceof BridgeError || err instanceof SceneError ? 502 : 500;
    return sendJson(res, status, { error: 'blender', message: err.message });
  } finally {
    release();
  }
}

// The sculpt stream (server/edits.js): the only copy of a brush stroke that exists anywhere, since
// Blender never sees one. GET reads a revision's strokes back in order, POST appends one, DELETE
// takes the newest off (undo) or the lot (?all=1).
async function editsRoute(req, res) {
  const rev = Number(new URL(req.url, 'http://x').searchParams.get('rev'));
  if (!Number.isFinite(rev)) return sendJson(res, 400, { error: 'bad_request', message: 'which scene revision?' });
  try {
    if (req.method === 'GET') {
      const rows = await listEdits(rev);
      return sendJson(res, 200, { ok: true, rev, edits: rows.map(r => ({ part: r.part, type: r.type, bytes: r.bytes, payload: r.payload })), ...(await editsInfo(rev)) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req, 12 * 1024 * 1024);
      return sendJson(res, 200, { ok: true, ...(await addEdit(rev, body)) });
    }
    if (req.method === 'DELETE') {
      const all = new URL(req.url, 'http://x').searchParams.get('all') === '1';
      return sendJson(res, 200, { ok: true, ...(all ? await clearEdits(rev) : await dropLastEdit(rev)) });
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    const status = err instanceof EditsError ? 400 : 500;
    return sendJson(res, status, { error: 'edits', message: err.message });
  }
}

// Streams progress as server-sent events while Fable builds in Blender. When it's done the scene is exported for
// the page (a new rev, announced as {type:'scene'}) and saved as a version.
async function blenderBuild(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 600) : '';
  if (!prompt) return sendJson(res, 400, { error: 'bad_request', message: 'say what to make' });
  // held until the build has really stopped, so a cancelled build's last step can't overlap the next one
  const release = lock('build');
  if (!release) return sendJson(res, 409, { error: 'busy', message: busyMessage() });

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });   // the page cancelled or went away
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = ev => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const steps = [], sources = new Map();   // kept with the version
  let touched = false;   // did anything run in Blender? then the scene may have changed even if the build failed
  const emit = ev => {
    if (ev.type === 'step') touched = true;
    if (ev.type === 'step' && ev.state === 'done') steps.push(ev.label);
    if (ev.type === 'sources') for (const s of ev.items) if (s.url && sources.size < 12) sources.set(s.url, s.title || s.url);
    send(ev);
  };
  const t0 = Date.now();
  // 'add' a new object beside what is there (the default), 'replace' the lot, or 'change' what exists
  const mode = ['change', 'replace', 'add'].includes(body.mode) ? body.mode : 'add';
  let published = false;   // also "tried": a failed export is not worth a second go in the finally
  let cleared = false;     // Blender was emptied, so the page's rev is stale even if the build then did nothing
  try {
    // A "make" ADDS to the scene. Asking for a second thing and losing the first is the one outcome
    // nobody means, so the scene is only emptied when the words asked for it ("instead", "on its
    // own", "start over"), which is how people say it when they do mean it. The cost of being
    // additive is that every object shares the triangle budget, which is what the brief tells Fable.
    if (mode === 'replace') {
      send({ type: 'status', text: 'Clearing the scene…' });
      const kept = await checkpointIfChanged('before a new model');
      if (kept) send({ type: 'saved', version: kept, kept: true });
      const r = await bridge('clear_scene', {}, { timeout: 60000 });
      if (!r.ok) throw new SceneError(`Couldn't clear the scene: ${r.error}`);
      cleared = true;
    }
    const { usd = 0, summary = '', turns = 0 } = await buildInBlender({ prompt, mode, emit, signal: controller.signal });
    const durationMs = Date.now() - t0;
    console.log(`[blender] "${prompt}" done in ${(durationMs / 1000).toFixed(0)}s, about $${usd.toFixed(2)}`);
    send({ type: 'status', text: 'Getting it ready for the web…' });
    published = true;
    const s = await publish('build');
    send({ type: 'scene', rev: s.rev, glb: s.glb ? `/api/scene/${s.rev}.glb` : null });
    if (s.skipped?.length) {   // metaballs and the like: in Fable's renders and the .blend, never in the GLB
      send({ type: 'warn', message: `Not in the web view: ${s.skipped.map(o => `${o.name} (${o.type.toLowerCase()})`).join(', ')}`
             + " — glTF has no mesh for that. It's still in the .blend." });
    }
    if (!controller.signal.aborted) {
      send({ type: 'status', text: 'Saving this version…' });
      try {
        const v = await saveVersion({ prompt, mode, summary, usd: Number(usd.toFixed(4)), durationMs, turns,
                                      model: blenderModel(), steps, sources: [...sources].map(([url, title]) => ({ url, title })) });
        send({ type: 'saved', version: v });
      } catch (err) {
        console.error('[history] save failed:', err.message);
        send({ type: 'status', text: '' });
        send({ type: 'warn', message: `Built, but couldn't save a version: ${err.message}` });
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[blender] failed:', err.message);
      emit({ type: 'error', message: err instanceof BridgeError || err instanceof SceneError ? err.message : `Couldn't build it: ${err.message}` });
    } else {
      console.log(`[blender] "${prompt}" cancelled`);
    }
  } finally {
    // a failed or cancelled build may have left some of its work in Blender (or emptied it): show what's there
    if ((touched || cleared) && !published) {
      const s = await publish('build stopped').catch(err => console.warn(`[scene] ${err.message}`));
      if (s) send({ type: 'scene', rev: s.rev, glb: s.glb ? `/api/scene/${s.rev}.glb` : null });
    }
    release();
    res.end();
  }
}

// ---------- version history (MongoDB Atlas, or local files until MONGODB_URI is set) ----------
async function historyRoute(req, res, pathname) {
  const m = pathname.match(/^\/api\/history(?:\/([\w.-]{1,40})(?:\/(thumb|restore|model\.glb))?)?$/);
  if (!m) return sendJson(res, 404, { error: 'not_found' });
  const [, id, action] = m;
  try {
    if (!id && req.method === 'GET') {
      return sendJson(res, 200, { ...(await listVersions()), ...historyInfo() });
    }
    if (action === 'thumb' && req.method === 'GET') {
      const png = await versionThumb(id);
      if (!png) return sendJson(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=31536000, immutable' });
      return res.end(png);
    }
    if (action === 'model.glb' && req.method === 'GET') {   // a version's GLB never changes
      const file = await versionGlb(id);
      if (!file) return sendJson(res, 404, { error: 'not_found', message: 'that version has no GLB (it predates them)' });
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': fs.statSync(file).size,
                           'Cache-Control': 'max-age=31536000, immutable' });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method !== 'POST' || (action !== 'restore' && id !== 'checkpoint') || (id === 'checkpoint' && action)) {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const body = await readJson(req).catch(() => ({}));
    const release = lock('version');
    if (!release) return sendJson(res, 409, { error: 'busy', message: busyMessage() });
    try {
      if (id === 'checkpoint') {
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : 'saved by voice';
        return sendJson(res, 200, { ok: true, version: await saveVersion({ kind: 'manual', prompt: label }) });
      }
      return sendJson(res, 200, { ok: true, ...(await restoreVersion(id)) });
    } finally {
      release();
    }
  } catch (err) {
    const known = err instanceof VersionError || err instanceof BridgeError || err instanceof SceneError;
    if (!known) console.error('[history]', err);
    sendJson(res, err instanceof VersionError ? 400 : 502, { ok: false, error: err.message });
  }
}

// ---------- voice (ElevenLabs when ELEVENLABS_API_KEY is set; otherwise the page uses the browser's) ----------
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('recording too long')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function voiceRoute(req, res, pathname) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  if (!voiceAvailable()) return sendJson(res, 503, { error: 'no_key', message: 'No ELEVENLABS_API_KEY in .env.' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    if (pathname === '/api/voice/transcribe') {
      const audio = await readRaw(req, 8 * 1024 * 1024);
      if (audio.length < 1000) return sendJson(res, 200, { text: '' });
      return sendJson(res, 200, { text: await transcribe(audio, String(req.headers['content-type'] || 'audio/webm'), ac.signal) });
    }
    if (pathname === '/api/voice/speak') {
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
      if (!text) return sendJson(res, 400, { error: 'bad_request', message: 'nothing to say' });
      const audio = await speak(text, ac.signal);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return audio.pipe(res);
    }
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (ac.signal.aborted) return;
    console.error('[voice]', err.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'voice_failed', message: err.message });
    else res.destroy();
  }
}

// what the page needs to know at startup
function config(res) {
  sendJson(res, 200, {
    voice: voiceAvailable() ? 'elevenlabs' : 'browser',
    history: historyInfo().kind,
    textures: textureToolAvailable(),
  });
}

// test/fixtures holds the models the tests use, including Fable's teapot, and the rig pages want to put a
// real model in the volume without a Blender run or a 600 KB copy under public/. GLB only, read only.
function serveFixture(req, pathname, res) {
  const name = pathname.slice('/fixtures/'.length);
  if (!/^[\w.-]+\.glb$/.test(name) || name.includes('..'))
    return sendJson(res, 404, { error: 'not_found' });
  const f = path.join(here, 'test', 'fixtures', name);
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES['.glb'], 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

function serveStatic(req, pathname, res) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { p = ''; }
  if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); };
  if (!p || !f.startsWith(root + path.sep)) return notFound();
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) {
      // not vendored (npm run vendor wasn't run): the same file online, uncached so a later local copy wins
      const online = pathname.startsWith('/vendor/') && onlineUrl(pathname.slice('/vendor/'.length));
      if (!online) return notFound();
      res.writeHead(302, { Location: online, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream',
                         'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();   // the webcam page probes for vendored MediaPipe files this way
    fs.createReadStream(f).pipe(res);
  });
}

loadScene();
watchBlender();

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/status') return status(res);
  if (pathname === '/api/scene' || pathname.startsWith('/api/scene/')) return sceneRoute(req, res, pathname);
  if (pathname === '/api/blender/status') return blenderStatus(res);
  if (pathname === '/api/blender/build') {
    return req.method === 'POST' ? blenderBuild(req, res) : sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  }
  if (pathname === '/api/blender/detail') {
    return req.method === 'POST' ? blenderDetail(req, res) : sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  }
  if (pathname === '/api/blender/delete') {
    return req.method === 'POST' ? blenderDelete(req, res) : sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  }
  if (pathname === '/api/blender/xform') {
    return req.method === 'POST' ? blenderXform(req, res) : sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  }
  if (pathname === '/api/edits') return editsRoute(req, res);
  if (pathname === '/api/history' || pathname.startsWith('/api/history/')) return historyRoute(req, res, pathname);
  if (pathname.startsWith('/api/voice/')) return voiceRoute(req, res, pathname);
  if (pathname === '/api/config') return config(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  if (pathname.startsWith('/fixtures/')) return serveFixture(req, pathname, res);
  serveStatic(req, pathname, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving on http://localhost:${PORT}  (open it in Edge for voice)`);
  console.log(hasKey() ? `Builds: ${blenderModel()} in a hidden Blender` : 'Builds: no OPENAI_API_KEY in .env yet, so "make a ___" is off; local commands still work');
  console.log(`Voice: ${voiceAvailable() ? 'ElevenLabs (Scribe v2 in, Flash voice out)' : "the browser's (add ELEVENLABS_API_KEY for ElevenLabs)"}`);
  if (!fs.existsSync(path.join(root, 'vendor'))) console.log('Warning: no public/vendor, so three.js and MediaPipe come from jsDelivr; run "npm run vendor" to work offline');
  blender.start();
  warmUp();
  history().then(s => { if (s.kind === 'local') console.log(`History: local files in ${LOCAL_DIR} (add MONGODB_URI for Atlas)`); })
    .catch(err => console.error('History:', err.message));
});

// Blender would go anyway when our stdin pipe closes; stopping it first lets it finish what it's writing
let quitting = false;
async function quit(signal) {
  if (quitting) return;
  quitting = true;
  console.log(`${signal}: stopping Blender`);
  await blender.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => quit('SIGINT'));
process.on('SIGTERM', () => quit('SIGTERM'));
