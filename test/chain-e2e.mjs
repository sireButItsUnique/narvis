// End-to-end, in a real browser, with nothing plugged in: fake cameras and the real fake-ZED bridge feed
// the real solver, the solver feeds grab.js, and a model is picked up, carried and put down.
//
//   node test/chain-e2e.mjs [--keep]
//
// Ports: 8803 (page) and 8815 (bridge). It starts and stops both.
//
// The browser driving is the same headless-Edge/CDP trick as .research/tools/cdp.mjs. What this measures
// that the unit tests cannot: the page really renders, three.js really moves the model, the WebSocket
// really carries the bridge's hands, and requestAnimationFrame really paces the solve.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_PORT = 8803, BRIDGE_PORT = 8815, CDP_PORT = 9336;
const OUT = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'holo-chain-'));
fs.mkdirSync(OUT, { recursive: true });
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
                '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.css': 'text/css' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file;
    if (url.pathname.startsWith('/vendor/three/')) file = path.join(ROOT, 'node_modules/three', url.pathname.slice('/vendor/three/'.length));
    else if (url.pathname.startsWith('/test/')) file = path.join(ROOT, url.pathname.slice(1));
    else file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(PAGE_PORT, '127.0.0.1', () => r(server)));
}

async function browser(url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-chain-'));
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,860',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); break; } catch { await sleep(250); } }
  if (!targets) throw new Error('Edge did not start');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('page threw: ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__chain').catch(() => false)) break; await sleep(250); }
  return {
    evaluate, logs,
    metrics: async () => JSON.parse(await evaluate('JSON.stringify(window.__chain.metrics())')),
    shot: async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); return file; },
    close: async () => { ws.close(); edge.kill(); await sleep(400); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
}

const checks = [];
const check = (ok, what, detail = '') => { checks.push({ ok: !!ok, what, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`); };
const num = (v, n = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(n));

let server, bridgeProc, b;
try {
  server = await serve();
  bridgeProc = spawn(process.platform === 'win32' ? 'py' : 'python3',
    [path.join(ROOT, 'tools/zed-bridge/zed_bridge.py'), '--fake', '--port', String(BRIDGE_PORT),
     '--fps', '60', '--hands', '1', '--seconds', '120', '--quiet'],
    { cwd: ROOT, stdio: 'ignore' });
  await sleep(1200);

  b = await browser(`http://127.0.0.1:${PAGE_PORT}/chain.html?source=sim&noise=1.0&bridge=ws://127.0.0.1:${BRIDGE_PORT}`);
  check(await b.evaluate('!!window.__chain'), 'the page loaded and exposed its chain');

  // ---------- 1. fake cameras -> solver -> state.js ----------
  // Wait for the page to finish standing the rig up rather than guessing how long it takes. On a busy
  // machine (this file and test/cameras-e2e.mjs each drive their own headless browser on software GL)
  // a fixed sleep caught it with three of the four cameras posed and the hands still on one view.
  await sleep(2500);
  let m = await b.metrics();
  for (let i = 0; i < 30 && !(m.solver.cameras === 4 && m.handSource === 'stereo'); i++) {
    await sleep(300);
    m = await b.metrics();
  }
  console.log(`      solver says: ${m.solver.readout}`);
  check(m.solver.cameras === 4, 'four cameras are posed in the solver', `${m.solver.cameras}`);
  check(m.handSource === 'stereo', 'hands are triangulated, not guessed', m.handSource);
  // Measure the fingertip over frames from AFTER the rig is up. The accumulator starts with the page, so
  // any single-camera frame from the first second is otherwise averaged into a figure about the geometry.
  await b.evaluate('window.__chain.restartScript()');
  await sleep(1200);
  m = await b.metrics();
  check(m.eyeSource === 'stereo', 'the eye is triangulated from the two head webcams', m.eyeSource);
  check(m.inputMode === 'camera', 'input.mode is the contract the rest of the app reads', m.inputMode);
  check(m.hands[0].active, 'a hand reached input/state.js', m.hands[0].tip.join(', ') + ' cm');
  check(m.tipErrMeanMm != null && m.tipErrMeanMm < 8,
    'the published fingertip matches the truth it was generated from', `${num(m.tipErrMeanMm)} mm mean over ${m.tipErrN} frames`);
  check(Math.abs(m.eye[2]) > 30, 'the eye landed in front of the display', m.eye.join(', ') + ' cm');

  // ---------- 2. pick it up, move it, put it down ----------
  // The page's script runs a 7.5 s cycle: reach (0-1.4 s), pinch shut (1.4-1.8), carry (1.8-3.2), hold
  // still (3.2-4.6), open (4.6-5.0), withdraw. Reset the model and the clock together, then sample it.
  await b.evaluate('window.__chain.reset(); window.__chain.restartScript()');
  await sleep(200);
  const before = (await b.metrics()).bodies.find(x => x.id === 'teapot').pos;

  await sleep(2600);                                      // mid-carry
  m = await b.metrics();
  check(m.held.includes('teapot'), 'the teapot was picked up', `holding ${m.held.join(',') || 'nothing'}`);
  const carrying = m.bodies.find(x => x.id === 'teapot').pos;
  await b.shot(path.join(OUT, '1-holding.png'));

  // ---------- 3. the numbers the user feels, measured while it is actually being held ----------
  await sleep(1700);                                      // end of the still stretch, still held
  m = await b.metrics();
  console.log(`      hand -> object lag ${num(m.lagMs, 1)} ms (correlation ${num(m.lagR)}, ${m.lagSamples} held samples at ${num(m.lagDtMs, 1)} ms)`);
  console.log(`      held-object jitter ${num(m.jitterMmRms)} mm rms, worst step ${num(m.jitterMmWorst)} mm, over ${m.jitterFrames} near-still frames`);
  const feel = m;

  await sleep(2400);                                      // opened, released, settled
  m = await b.metrics();
  const after = m.bodies.find(x => x.id === 'teapot').pos;
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  console.log(`      teapot: ${before.join(', ')} -> (carried) ${carrying.join(', ')} -> ${after.join(', ')} cm`);
  check(moved > 5, 'and it ended up somewhere else', `${moved.toFixed(1)} cm from where it started`);
  const starts = m.events.filter(e => e.name === 'grabStart');
  const ends = m.events.filter(e => e.name === 'grabEnd');
  check(starts.length >= 1 && ends.length >= 1, 'one clean grab and one clean release',
    `${starts.length} grabStart, ${ends.length} grabEnd (${ends.map(e => e.reason).join(',') || '-'})`);
  check(!ends.some(e => e.reason === 'lost'), 'nothing was dropped because tracking failed');
  check(m.events.some(e => e.name === 'settleEnd' || e.name === 'settleStart'), 'it settled after being let go');
  await b.shot(path.join(OUT, '2-released.png'));

  m = feel;
  check(m.lagSamples > 40 && m.lagR > 0.5, 'the lag figure rests on enough correlated motion to mean something',
    `r = ${num(m.lagR)}, ${m.lagSamples} samples`);
  check(m.lagMs != null && m.lagMs < 120, 'the model follows the hand within a couple of frames', `${num(m.lagMs, 1)} ms`);
  check(m.jitterMmRms != null && m.jitterMmRms < 3, 'a held model barely shakes', `${num(m.jitterMmRms)} mm rms`);

  // ---------- 4. the real bridge over a real socket ----------
  await b.evaluate('window.__chain.setSource("bridge")');
  await sleep(3500);
  m = await b.metrics();
  console.log(`      bridge: ${JSON.stringify(m.bridge && { state: m.bridge.state, fps: m.bridge.fps, latency: Math.round(m.bridge.latencyMs), offset: Math.round(m.bridge.offsetMs) })}`);
  check(m.bridge?.state === 'live', 'the fake ZED bridge connected', m.bridge?.state);
  check(m.bridge?.fps > 20 && m.bridge?.latencyMs < 120, 'its rate and latency are measured and sane',
    `${m.bridge?.fps} fps, ${Math.round(m.bridge?.latencyMs)} ms`);
  check(m.handSource === 'bridge', 'the solver took the bridge over the cameras while it is fresh', m.handSource);
  check(m.hands[0].active, 'bridge hands reached input/state.js in world centimetres', m.hands[0].tip.join(', ') + ' cm');

  // The fake bridge's hands sweep their OWN volume, which has nothing to do with where the sim script left
  // the teapot. The middle of that sweep is not the answer either: the hand covers about 20 cm and pinches
  // once every 3 s, so where it averages out is regularly further from where it shuts than the 7 cm grab
  // radius allows, and this check used to fail perhaps one run in three. Ask the page to hand the teapot
  // over at the moment the fingers are already closing instead, which is the only position that matters.
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const s = await b.metrics();
    if (s.hands[0].active) seen.push(s.hands[0].tip);
    await sleep(100);
  }
  check(seen.length > 10, 'the bridge hand was seen moving', `${seen.length} samples`);
  const spread = [0, 1, 2].map(k => Math.max(...seen.map(p => p[k])) - Math.min(...seen.map(p => p[k])));
  console.log(`      bridge hand sweeps ${spread.map(v => v.toFixed(1)).join(' x ')} cm in 2 s; waiting for it to close`);
  await b.evaluate("window.__chain.placeOnNextPinch('teapot')");
  for (let i = 0; i < 50 && await b.evaluate('window.__chain.placementPending()'); i++) await sleep(100);
  check(!(await b.evaluate('window.__chain.placementPending()')), 'the teapot was put where the hand was closing',
        (await b.metrics()).bodies.find(x => x.id === 'teapot').pos.join(', ') + ' cm');

  let bridgeGrabs = [];
  for (let i = 0; i < 12 && !bridgeGrabs.length; i++) {
    await sleep(700);
    m = await b.metrics();
    bridgeGrabs = m.events.filter(e => e.name === 'grabStart' && e.source === 'bridge');
  }
  console.log(`      bridge events: ${m.events.filter(e => e.source === 'bridge').map(e => `${e.name}@${e.at}`).join(' ') || 'none'}`);
  check(bridgeGrabs.length >= 1, 'a model was grabbed from bridge data alone', `${bridgeGrabs.length} grabs`);
  await b.shot(path.join(OUT, '3-bridge.png'));

  // ---------- 5. the bridge dies: fall back to the cameras, do not freeze ----------
  await b.evaluate('window.__chain.setSource("both")');
  await sleep(1500);
  bridgeProc.kill();
  await sleep(2500);
  m = await b.metrics();
  // Poll rather than take one sample. Under load (two headless browsers on one machine) a single frame
  // can genuinely find only one eye fresh, which honestly reads as 'mono'; what this check is about is
  // whether the cameras take the hands back at all.
  for (let i = 0; i < 20 && m.handSource !== 'stereo'; i++) { await sleep(200); m = await b.metrics(); }
  check(m.handSource === 'stereo', 'a dead bridge hands the hands back to the cameras', m.handSource);
  check(/retrying|connecting/.test(m.bridge?.state || ''), 'and the client keeps retrying', m.bridge?.state);
  check(m.hands[0].active, 'tracking never stopped', `${m.hands[0].tip.join(', ')} cm`);
  await b.shot(path.join(OUT, '4-after-bridge-died.png'));

  const err = b.logs.filter(l => l.startsWith('[exception]') || /Uncaught/.test(l));
  check(err.length === 0, 'no uncaught errors in the page', err.join(' | ').slice(0, 300));
  console.log('\nscreenshots in', OUT);
  if (b.logs.length) console.log('--- page console (last 15) ---\n' + b.logs.slice(-15).join('\n'));
} catch (e) {
  check(false, 'the run finished', String(e?.stack || e));
} finally {
  await b?.close();
  bridgeProc?.kill();
  server?.close();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
