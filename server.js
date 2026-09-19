// Local server: serves public/ and turns "make a ___" into a part list with whichever AI key is in .env.
// Run with `npm start`, then open http://localhost:8765 in Edge.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerInfo, generateModel, NoKeyError } from './server/ai.js';
import { bridge, buildInBlender, blenderModel, BridgeError } from './server/blender.js';
import { sanitizeSpec } from './public/js/spec.js';

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
  const emit = ev => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const t0 = Date.now();
  try {
    const { usd = 0 } = await buildInBlender({ prompt, mode: body.mode === 'change' ? 'change' : 'make', emit, signal: controller.signal });
    console.log(`[blender] "${prompt}" done in ${((Date.now() - t0) / 1000).toFixed(0)}s, about $${usd.toFixed(2)}`);
  } catch (err) {
    if (!controller.signal.aborted) {
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
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  serveStatic(pathname, res);
}).listen(PORT, '127.0.0.1', () => {
  const ai = providerInfo();
  console.log(`serving on http://localhost:${PORT}  (open it in Edge for voice)`);
  console.log(ai.provider ? `AI: ${ai.provider} (${ai.model})` : 'AI: no key in .env yet, so "make a ___" is off; local commands still work');
  console.log(`Blender mode builds with ${blenderModel()}`);
});
