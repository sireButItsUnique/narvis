// Local server: serves public/ and turns "make a ___" into a part list with whichever AI key is in .env.
// Run with `npm start`, then open http://localhost:8765 in Edge.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerInfo, generateModel, NoKeyError } from './server/ai.js';
import * as Sentry from '@sentry/node';
import { bridge, buildInBlender, blenderModel, BridgeError } from './server/blender.js';
import { sanitizeSpec } from './public/js/spec.js';
import { saveVersion, restoreVersion, listVersions, versionThumb, VersionError } from './server/versions.js';
import { history, historyInfo, LOCAL_DIR } from './server/history.js';
import { voiceAvailable, transcribe, speak, warmUp } from './server/voice.js';
import { textureToolAvailable } from './server/texture-tool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch {}   // .env is optional; without it only local commands work

const root = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
                '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };

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

async function handleModel(req, res) {
  let body;
  try { body = await readJson(req); }
  catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 600) : '';
  if (!prompt) return sendJson(res, 400, { error: 'bad_request', message: 'say what to make' });
  const current = body.current ? sanitizeSpec(body.current).spec : null;
  const sculpted = current && Array.isArray(body.sculpted)
    ? body.sculpted.filter(n => typeof n === 'string' && current.parts.some(p => p.name === n)).slice(0, 80) : [];

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // the page cancelled or went away
  const t0 = Date.now();
  try {
    const { spec, warnings, provider } = await generateModel({ prompt, current, sculpted, signal: ac.signal });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[ai] ${provider}: "${prompt}" -> ${spec.name}, ${spec.parts.length} parts, ${secs}s` +
                (warnings.length ? ` (fixed: ${warnings.join('; ')})` : ''));
    sendJson(res, 200, { model: spec, warnings });
  } catch (err) {
    if (ac.signal.aborted) return;
    if (err instanceof NoKeyError) return sendJson(res, 503, { error: 'no_key', message: err.message });
    Sentry.captureException(err);
    console.error('[ai] failed:', err);
    sendJson(res, 502, { error: 'ai_failed', message: err.message || String(err) });
  }
}

// ---------- Blender mode ----------
let building = null;   // one build at a time: { controller }

async function blenderStatus(res) {
  const base = { model: blenderModel(), key: !!(process.env.ANTHROPIC_API_KEY || '').trim(), building: !!building };
  try {
    const r = await bridge('ping', {}, { timeout: 3000 });
    sendJson(res, 200, { ...base, connected: !!r.ok, blender: r.blender, file: r.file, objects: r.objects });
  } catch (err) {
    sendJson(res, 200, { ...base, connected: false, message: err.message });
  }
}

// Streams progress as server-sent events while Fable builds in Blender.
async function blenderBuild(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 600) : '';
  if (!prompt) return sendJson(res, 400, { error: 'bad_request', message: 'say what to make' });
  if (building) return sendJson(res, 409, { error: 'busy', message: 'Still building the last one. Say "cancel" to stop it.' });

  const controller = new AbortController();
  building = { controller };
  res.on('close', () => {   // the page cancelled or went away: stop, and free the lock right away
    if (!res.writableEnded) { controller.abort(); if (building?.controller === controller) building = null; }
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = ev => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const steps = [], sources = new Map();   // kept with the version
  const emit = ev => {
    if (ev.type === 'step' && ev.state === 'done') steps.push(ev.label);
    if (ev.type === 'sources') for (const s of ev.items) if (s.url && sources.size < 12) sources.set(s.url, s.title || s.url);
    send(ev);
  };
  const t0 = Date.now();
  const mode = body.mode === 'change' ? 'change' : 'make';
  try {
    const { usd = 0, summary = '', turns = 0 } = await buildInBlender({ prompt, mode, emit, signal: controller.signal });
    const durationMs = Date.now() - t0;
    console.log(`[blender] "${prompt}" done in ${(durationMs / 1000).toFixed(0)}s, about $${usd.toFixed(2)}`);
    if (!controller.signal.aborted) {
      send({ type: 'status', text: 'Saving this version…' });
      try {
        const v = await saveVersion({ prompt, mode, summary, usd: Number(usd.toFixed(4)), durationMs, turns,
                                      model: blenderModel(), steps, sources: [...sources].map(([url, title]) => ({ url, title })) });
        send({ type: 'saved', version: v });
      } catch (err) {
        Sentry.captureException(err);
        console.error('[history] save failed:', err.message);
        send({ type: 'status', text: '' });
        send({ type: 'warn', message: `Built, but couldn't save a version: ${err.message}` });
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      Sentry.captureException(err);
      console.error('[blender] failed:', err.message);
      emit({ type: 'error', message: err instanceof BridgeError ? err.message : `Couldn't build it: ${err.message}` });
    } else {
      console.log(`[blender] "${prompt}" cancelled`);
    }
  } finally {
    if (building?.controller === controller) building = null;
    res.end();
  }
}

const QUICK = new Set(['undo', 'redo', 'mode', 'brush', 'brush_size', 'symmetry', 'focus', 'delete', 'scene', 'add']);
async function blenderCommand(req, res) {
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: 'bad_request', message: err.message }); }
  if (!QUICK.has(body.cmd)) return sendJson(res, 400, { error: 'bad_request', message: `unknown command ${body.cmd}` });
  if (building && body.cmd !== 'scene') return sendJson(res, 409, { error: 'busy', message: 'Wait for the build to finish (or say "cancel").' });
  try {
    const { cmd, ...args } = body;
    sendJson(res, 200, await bridge(cmd, args, { timeout: 20000 }));
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err.message });
  }
}

// ---------- version history (MongoDB Atlas, or local files until MONGODB_URI is set) ----------
async function historyRoute(req, res, pathname) {
  const m = pathname.match(/^\/api\/history(?:\/([\w.-]{1,40})(?:\/(thumb|restore))?)?$/);
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
    if (req.method !== 'POST' || (action !== 'restore' && id !== 'checkpoint') || (id === 'checkpoint' && action)) {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const body = await readJson(req).catch(() => ({}));
    if (building) return sendJson(res, 409, { error: 'busy', message: 'Wait for the build to finish (or say "cancel").' });
    building = { controller: new AbortController() };
    try {
      if (id === 'checkpoint') {
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : 'saved by voice';
        return sendJson(res, 200, { ok: true, version: await saveVersion({ kind: 'manual', prompt: label }) });
      }
      return sendJson(res, 200, { ok: true, ...(await restoreVersion(id)) });
    } finally {
      building = null;
    }
  } catch (err) {
    if (!(err instanceof VersionError || err instanceof BridgeError)) { Sentry.captureException(err); console.error('[history]', err); }
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
    Sentry.captureException(err);
    console.error('[voice]', err.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'voice_failed', message: err.message });
    else res.destroy();
  }
}

// what the page needs to know at startup; the Sentry DSN is public by design (it's only for sending events)
function config(res) {
  sendJson(res, 200, {
    sentryDsn: (process.env.SENTRY_DSN || '').trim() || null,
    voice: voiceAvailable() ? 'elevenlabs' : 'browser',
    history: historyInfo().kind,
    textures: textureToolAvailable(),
  });
}

function serveStatic(pathname, res) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { p = ''; }
  if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); };
  if (!p || !f.startsWith(root + path.sep)) return notFound();
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return notFound();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/status') return sendJson(res, 200, providerInfo());
  if (pathname === '/api/model') {
    return req.method === 'POST' ? handleModel(req, res) : sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
  }
  if (pathname === '/api/blender/status') return blenderStatus(res);
  if (pathname === '/api/blender/build' || pathname === '/api/blender/command') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
    return pathname.endsWith('build') ? blenderBuild(req, res) : blenderCommand(req, res);
  }
  if (pathname === '/api/history' || pathname.startsWith('/api/history/')) return historyRoute(req, res, pathname);
  if (pathname.startsWith('/api/voice/')) return voiceRoute(req, res, pathname);
  if (pathname === '/api/config') return config(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  serveStatic(pathname, res);
}).listen(PORT, '127.0.0.1', () => {
  const ai = providerInfo();
  console.log(`serving on http://localhost:${PORT}  (open it in Edge for voice)`);
  console.log(ai.provider ? `AI: ${ai.provider} (${ai.model})` : 'AI: no key in .env yet, so "make a ___" is off; local commands still work');
  console.log(`Blender mode builds with ${blenderModel()}`);
  console.log(`Voice: ${voiceAvailable() ? 'ElevenLabs (Scribe v2 in, Flash voice out)' : "the browser's (add ELEVENLABS_API_KEY for ElevenLabs)"}`);
  console.log(`Sentry: ${(process.env.SENTRY_DSN || '').trim() ? 'on' : 'off (add SENTRY_DSN)'}`);
  warmUp();
  history().then(s => { if (s.kind === 'local') console.log(`History: local files in ${LOCAL_DIR} (add MONGODB_URI for Atlas)`); })
    .catch(err => console.error('History:', err.message));
});
