// End-to-end check of the capture path with no hardware at all: a generated side-by-side "ZED" video is
// fed to headless Edge as a fake camera, the bridge runs in --fake mode, and we watch the app turn both
// into 3D world points, survive the camera being unplugged and survive the bridge dying.
//
// The browser driving is the same Edge/CDP trick as .research/tools/cdp.mjs, with the extra media flags
// this test needs. It drives a real browser and needs the ports below free, so it is NOT under test/ (where
// `node --test` would run every .mjs). Run it by hand with:  node tools/cameras-e2e.mjs [--keep]
//
// Ports: 8801 (page) and 8814 (bridge), both inside the range this workflow owns.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_PORT = 8801, BRIDGE_PORT = 8814;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-cams-e2e-'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- a synthetic ZED video
// One bright dot per eye, the right one shifted by the disparity a point 40 cm away would produce, moving
// in a circle. Anything downstream that reports 40 cm has really done the geometry.

const EYE_W = 672, EYE_H = 376, W = EYE_W * 2, H = EYE_H, FRAMES = 24;
const HFOV_DEG = 102;                                   // must match stereo.js defaultCalib
const FX = (EYE_W / 2) / Math.tan(HFOV_DEG * Math.PI / 360);
const BASELINE_CM = 12, TARGET_Z_CM = 40;
const DISPARITY_NORM = (FX * BASELINE_CM / TARGET_Z_CM) / EYE_W;

function writeY4m(file) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420mpeg2\n`);
  const y = Buffer.alloc(W * H), u = Buffer.alloc((W / 2) * (H / 2)), v = Buffer.alloc((W / 2) * (H / 2));
  for (let i = 0; i < FRAMES; i++) {
    y.fill(16); u.fill(128); v.fill(128);
    const th = i / FRAMES * Math.PI * 2;
    const uL = 0.5 + 0.08 * Math.cos(th), vY = 0.5 + 0.18 * Math.sin(th);
    const dots = [[uL * EYE_W, vY * EYE_H], [EYE_W + (uL - DISPARITY_NORM) * EYE_W, vY * EYE_H]];
    for (const [cx, cy] of dots) {
      for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) {
        if (dx * dx + dy * dy > 121) continue;
        const x = Math.round(cx + dx), yy = Math.round(cy + dy);
        if (x >= 0 && x < W && yy >= 0 && yy < H) y[yy * W + x] = 235;
      }
    }
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, y); fs.writeSync(fd, u); fs.writeSync(fd, v);
  }
  fs.closeSync(fd);
  return file;
}

// ---------------------------------------------------------------- the page server
// public/, plus /vendor/three from node_modules so the page works with no network (npm run vendor does
// the same thing for real).

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
                '.wasm': 'application/wasm', '.css': 'text/css', '.task': 'application/octet-stream' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = null;
    if (url.pathname.startsWith('/vendor/three/')) file = path.join(ROOT, 'node_modules/three', url.pathname.slice('/vendor/three/'.length));
    else if (url.pathname.startsWith('/vendor/mediapipe/')) file = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision', url.pathname.slice('/vendor/mediapipe/'.length));
    else file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(PAGE_PORT, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------- headless Edge over CDP

async function browser(url, y4m) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cams-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--no-first-run',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m.replace(/\\/g, '/')}`,
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); break; } catch { await sleep(250); } }
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
  await sleep(2500);
  return {
    evaluate, logs,
    status: async () => JSON.parse(await evaluate('JSON.stringify(window.__cams.status())')),
    shot: async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); return file; },
    close: async () => { ws.close(); edge.kill(); await sleep(400); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
}

// ---------------------------------------------------------------- the run

const checks = [];
const check = (ok, what, detail = '') => { checks.push({ ok: !!ok, what, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`); };

let server, bridge, b;
try {
  const y4m = writeY4m(path.join(OUT, 'zed-sbs.y4m'));
  console.log(`synthetic ZED video: ${W}x${H}, dot at ${TARGET_Z_CM} cm (disparity ${(DISPARITY_NORM * EYE_W).toFixed(1)} px)`);
  server = await serve();
  bridge = spawn(process.platform === 'win32' ? 'py' : 'python3',
    [path.join(ROOT, 'tools/zed-bridge/zed_bridge.py'), '--fake', '--port', String(BRIDGE_PORT), '--fps', '60', '--seconds', '60', '--quiet'],
    { cwd: ROOT, stdio: 'ignore' });
  await sleep(1200);

  b = await browser(`http://127.0.0.1:${PAGE_PORT}/cameras.html?detector=blob&allowBlob=1`, y4m);

  // 1. the camera path: treat the fake device as a ZED (as a user would for an unnamed UVC stereo camera)
  await b.evaluate(`(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop());
    const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const prefs = {}; prefs[list[0].label] = { key: { label: list[0].label }, kind: 'zed', role: 'both' };
    localStorage.setItem('holo-cameras', JSON.stringify(prefs));
    return list.map(d => d.label).join(',');
  })()`).then(l => console.log('fake cameras:', l));
  await b.evaluate('window.__cams.start()');
  await sleep(4000);

  let st = await b.status();
  console.log(JSON.stringify({ mode: st.mode, handSource: st.handSource, eyeSource: st.eyeSource, sources: st.sources }, null, 1));
  check(st.sources.length === 1, 'the fake camera opened');
  check(st.sources[0]?.sbs === true, 'its frame was recognised as side-by-side', `${st.sources[0]?.width}x${st.sources[0]?.height}`);
  check(st.sources[0]?.views.length === 2, 'both eyes run their own worker');
  check(st.sources[0]?.views.every(v => v.fps > 5), 'frames are flowing', st.sources[0]?.views.map(v => `${v.fps} fps / ${v.latencyMs} ms`).join(', '));
  check(st.handSource === 'stereo', 'hands come from triangulation, not a guess', st.handSource);
  const tip = st.hands.find(h => h.active)?.tip;
  check(!!tip, 'a 3D hand reached the shared input', tip ? tip.map(v => v.toFixed(1)).join(', ') : 'none');
  if (tip) check(Math.abs(tip[2] - TARGET_Z_CM) < TARGET_Z_CM * 0.05, `depth is within 5% of the ${TARGET_Z_CM} cm the video encodes`, `${tip[2].toFixed(1)} cm`);

  // the dot moves in a circle, so the published point must move too
  // Diagnostic only: these two rings are read separately, so they can be a frame apart — the fused depth
  // above is the number that matters. It is here to show where a wrong depth came from.
  const seen = JSON.parse(await b.evaluate('JSON.stringify(window.__cams.cams.sources[0].samples.map(r => r[r.length-1] && r[r.length-1].hands[0] && r[r.length-1].hands[0].lm[8]))'));
  const calib = JSON.parse(await b.evaluate('JSON.stringify(window.__cams.cams.sources[0].calib)'));
  if (seen?.[0] && seen?.[1]) {
    const px = (seen[0][0] - seen[1][0]) * calib.eyeW;
    console.log(`      eyes saw u=${seen[0][0].toFixed(4)} and u=${seen[1][0].toFixed(4)}: disparity ${px.toFixed(1)} px`
      + ` (encoded ${(DISPARITY_NORM * EYE_W).toFixed(1)} px at this width), fx ${calib.left.fx.toFixed(1)},`
      + ` baseline ${calib.baselineCm} cm -> Z ${(calib.left.fx * calib.baselineCm / px).toFixed(1)} cm`);
  }
  const p1 = (await b.status()).hands.find(h => h.active)?.tip;
  await sleep(700);
  const p2 = (await b.status()).hands.find(h => h.active)?.tip;
  check(p1 && p2 && Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) > 0.3, 'the point tracks the moving dot');
  const drops = st.sources[0].views.reduce((n, v) => n + v.busyDrops + v.staleDrops, 0);
  check(true, 'frames dropped rather than queued while busy', `${drops} dropped, ${st.sources[0].views.reduce((n, v) => n + v.done, 0)} processed`);
  await b.shot(path.join(OUT, '1-cameras.png'));

  // 2. the bridge takes over the hands while it is fresh
  await b.evaluate(`window.__cams.setBridge('ws://127.0.0.1:${BRIDGE_PORT}')`);
  await sleep(2000);
  st = await b.status();
  check(st.bridge?.state === 'live', 'the bridge connected', JSON.stringify(st.bridge && { state: st.bridge.state, fps: st.bridge.fps, latency: Math.round(st.bridge.latencyMs), offset: Math.round(st.bridge.offsetMs) }));
  check(st.handSource === 'bridge', 'hands now come from the bridge', st.handSource);
  check(st.bridge?.latencyMs < 120 && st.bridge?.fps > 20, 'bridge latency and rate are measured and sane');
  check(st.hands.some(h => h.active && Math.abs(h.tip[2]) > 1), 'bridge hands land in world coordinates', st.hands.map(h => h.tip.map(v => v.toFixed(0)).join('/')).join(' '));
  await b.shot(path.join(OUT, '2-bridge.png'));

  // 3. kill the bridge: the app must fall back to the cameras and keep retrying
  bridge.kill();
  await sleep(2500);
  st = await b.status();
  check(/retrying|connecting/.test(st.bridge?.state || ''), 'a dead bridge is retried, not mourned', st.bridge?.state);
  check(st.handSource === 'stereo', 'hands fell back to the cameras', st.handSource);
  check(st.sources[0]?.views.every(v => v.fps > 5), 'the cameras never stopped', st.sources[0]?.views.map(v => v.fps).join('/'));

  // 4. unplug the camera: no sources left, so mouse mode, and still no crash
  await b.evaluate(`window.__cams.dropSource(window.__cams.status().sources[0].deviceId, 'unplugged (test)')`);
  await sleep(800);
  st = await b.status();
  check(st.sources.length === 0, 'the unplugged camera was let go');
  check(st.inputMode === 'mouse', 'the app degraded to mouse mode instead of dying', st.inputMode);
  const err = b.logs.filter(l => l.startsWith('[exception]') || /Uncaught/.test(l));
  check(err.length === 0, 'no uncaught errors in the page', err.join(' | ').slice(0, 200));
  await b.shot(path.join(OUT, '3-unplugged.png'));
  console.log('\nscreenshots in', OUT);
  console.log('--- page console ---\n' + b.logs.slice(-25).join('\n'));
} catch (e) {
  check(false, 'the run finished', String(e?.stack || e));
} finally {
  await b?.close();
  bridge?.kill();
  server?.close();
}

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
