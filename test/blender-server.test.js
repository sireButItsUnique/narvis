// The server's side of the hidden Blender: the process manager, the bridge, the working scene and versions.
// Real Blender is covered by blender/test_bridge.py; here a stand-in speaks the same protocol, so these run in a
// second: this file re-runs itself with --fake-blender to be that stand-in (a helper .js under test/ would be
// picked up by node --test as a test file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- the stand-in Blender
// A "scene" is a JSON list of object names; .blend files are that JSON. Commands the tests need to go wrong:
// exec 'crash' exits mid-command, exec 'hang' never answers, FAKE_DIE_ONCE=<file> dies on the first export while
// that file exists (and removes it).
function fakeBlender() {
  const token = process.env.HOLO_BRIDGE_TOKEN || '';
  if (token.length < 16) process.exit(2);
  if (process.argv.includes('--exit-now')) process.exit(4);
  let objects = [];
  const fp = () => `fp:${objects.join(',')}`;
  const commands = {
    ping: () => ({ ok: true, blender: 'fake', objects: objects.length,
                   env: { anthropic: 'ANTHROPIC_API_KEY' in process.env, home: process.env.HOLOMODEL_HOME,
                          pyc: process.env.PYTHONDONTWRITEBYTECODE, port: process.env.HOLO_BRIDGE_PORT },
                   argvHasToken: process.argv.some(a => a.includes(token)) }),
    scene: () => ({ ok: true, object_count: objects.length, objects: objects.map(name => ({ name })) }),
    fingerprint: () => ({ ok: true, fingerprint: fp(), objects: objects.length }),
    exec: req => {
      if (req.code === 'crash') process.exit(3);
      if (req.code === 'hang') return null;
      objects.push(req.code);
      return { ok: true, output: '', new_objects: [{ name: req.code }], scene: { object_count: objects.length } };
    },
    restore: req => {
      try { objects = JSON.parse(fs.readFileSync(req.path, 'utf8')); } catch { return { ok: false, error: 'no such snapshot' }; }
      return { ok: true, objects: objects.length, fingerprint: fp() };
    },
    snapshot: req => { fs.writeFileSync(req.path, JSON.stringify(objects)); return { ok: true, bytes: 10, fingerprint: fp(), objects: objects.length }; },
    save_working: req => { fs.mkdirSync(path.dirname(req.path), { recursive: true }); fs.writeFileSync(req.path, JSON.stringify(objects)); return { ok: true, bytes: 10 }; },
    clear_scene: () => { objects = []; return { ok: true, objects: 0 }; },
    warm_up: () => ({ ok: true, ms: 1 }),
    render: () => ({ ok: true, images: [{ view: 'three_quarter', png: Buffer.from('\x89PNG fake').toString('base64') }] }),
    export_glb: req => {
      const once = process.env.FAKE_DIE_ONCE;
      if (once && fs.existsSync(once)) { fs.rmSync(once); process.exit(3); }
      const sym = { x: false, y: false, z: objects.length > 1 };
      const deadlineIn = req.deadline ? req.deadline - Date.now() : null;   // how much budget this call was given
      if (!objects.length) return { ok: true, empty: true, parts: [], tris: 0, sym, fingerprint: fp(), deadlineIn };
      const body = Buffer.from(`glTF ${req.mode} rev ${req.rev} ${objects.join(',')}`);
      fs.writeFileSync(req.path, body);
      const parts = objects.map((name, i) => ({ id: (i + 1).toString(16).padStart(12, '0'), name, tris: 12, sculpted: false,
                                                textured: false, ghash: `g-${name}`, mhash: 'm' }));
      return { ok: true, empty: false, bytes: body.length, mode: req.mode, rev: req.rev, parts, tris: 12 * parts.length,
               sym, fingerprint: fp(), deadlineIn };
    },
  };
  const server = net.createServer(sock => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const fn = commands[req.cmd];
      const resp = req.token !== token ? { ok: false, error: 'bad token' } : fn ? fn(req) : { ok: false, error: `unknown command ${req.cmd}` };
      if (resp) sock.end(JSON.stringify({ ...resp, id: req.id }) + '\n');
    });
  });
  server.listen(0, '127.0.0.1', () => {
    console.log('some Blender chatter');
    console.log(`HOLO_READY ${JSON.stringify({ port: server.address().port, pid: process.pid, blender: 'fake' })}`);
  });
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => { console.log('HOLO_BYE'); process.exit(0); });   // the life-link
}

// a manager in a process of its own, so a test can kill that process and watch its Blender go
async function ownerProcess() {
  const { BlenderProcess } = await import('../server/blender-process.js');
  const b = new BlenderProcess({ exe: process.execPath, args: [SELF, '--fake-blender'], reopen: null, warmUp: false, log: () => {} });
  b.start();
  const info = await b.ready();
  console.log(JSON.stringify({ blender: info.pid }));
  setInterval(() => {}, 1000);
}

if (process.argv.includes('--fake-blender')) fakeBlender();
else if (process.argv.includes('--owner')) await ownerProcess();
else await tests();

// ---------------------------------------------------------------- the tests
async function tests() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-server-test-'));
  process.env.HOLOMODEL_HOME = HOME;   // before the imports: history.js reads it once
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-for-blender';
  delete process.env.MONGODB_URI;
  const { BlenderProcess, blender } = await import('../server/blender-process.js');
  const { bridge, BridgeError } = await import('../server/blender.js');
  const scene = await import('../server/scene.js');
  const versions = await import('../server/versions.js');
  const { history, pruneHistory, WORKING_DIR, CURRENT_BLEND, LOCAL_DIR } = await import('../server/history.js');
  scene.watchBlender();   // as server.js does: check the scene after every (re)start

  const quiet = { log: () => {} };
  const fake = (extra = {}) => ({ exe: process.execPath, args: [SELF, '--fake-blender'], backoffMs: 50, warmUp: false, ...quiet, ...extra });
  const waitFor = async (cond, ms = 10000) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await new Promise(r => setTimeout(r, 20));
    }
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test('the manager starts Blender with the token in its environment only, and no API keys', async t => {
    const b = new BlenderProcess(fake({ reopen: null }));
    t.after(() => b.stop());
    assert.equal(b.state().state, 'starting');
    b.start();
    const info = await b.ready({ timeout: 10000 });
    assert.equal(b.state().state, 'ready');
    assert.match(info.token, /^[0-9a-f]{32}$/);
    const { callBlender } = await import('../server/blender-process.js');
    const r = await callBlender(info, 'ping', {}, 5000);
    assert.equal(r.argvHasToken, false);
    assert.deepEqual(r.env, { anthropic: false, home: HOME, pyc: '1', port: '0' });
    assert.equal((await callBlender({ ...info, token: 'x'.repeat(32) }, 'ping', {}, 5000)).error, 'bad token');
  });

  test('a Blender that dies is restarted with backoff, and each start is a new generation', async t => {
    const b = new BlenderProcess(fake({ reopen: null }));
    t.after(() => b.stop());
    b.start();
    const first = await b.ready();
    const states = [];
    b.on('state', s => states.push(s.state));
    process.kill(first.pid);
    const second = await b.ready({ after: first.gen, timeout: 10000 });
    assert.ok(second.gen > first.gen && second.pid !== first.pid && second.port !== first.port);
    assert.deepEqual(states, ['restarting', 'ready']);
    assert.equal(b.state().restarts, 1);
    assert.ok(b.logTail().some(l => l.includes('some Blender chatter')), 'its output is kept in the log ring');
  });

  test('after too many failed starts in a row it gives up and says why', async () => {
    const b = new BlenderProcess(fake({ args: [SELF, '--fake-blender', '--exit-now'], maxRestarts: 2, reopen: null }));
    b.start();
    await assert.rejects(b.ready({ timeout: 10000 }), /gave up after 2 restarts/);
    assert.equal(b.state().state, 'failed');
    assert.match(b.state().message, /exit code 4/);
    await assert.rejects(b.ready({ revive: false }), /gave up/);
    await b.stop();
  });

  test('a missing Blender is a clear failure, not a crash', async () => {
    const b = new BlenderProcess(fake({ exe: path.join(HOME, 'no-blender.exe'), reopen: null }));
    b.start();
    await assert.rejects(b.ready({ timeout: 5000 }), /Couldn't start Blender/);
    assert.equal(b.state().state, 'failed');
  });

  test('stop() closes its stdin and it exits by itself', async () => {
    const b = new BlenderProcess(fake({ reopen: null }));
    b.start();
    const info = await b.ready();
    await b.stop();
    assert.equal(alive(info.pid), false);
    assert.ok(b.logTail().some(l => l.includes('exited with code 0')));
  });

  test('if the server process dies, its Blender follows (stdin life-link)', async () => {
    const { spawn } = await import('node:child_process');
    const owner = spawn(process.execPath, [SELF, '--owner'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((resolve, reject) => {
      let buf = '';
      owner.stdout.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.split('\n')[0]); });
      owner.on('exit', () => reject(new Error('owner exited early')));
    });
    const { blender: pid } = JSON.parse(line);
    assert.ok(alive(pid));
    owner.kill('SIGKILL');   // no goodbyes (TerminateProcess on Windows)
    await waitFor(() => !alive(pid), 5000);
  });

  test('the working autosave is reopened before anyone gets the port', async t => {
    const file = path.join(HOME, 'reopen-test.blend');
    fs.writeFileSync(file, JSON.stringify(['Teapot Body', 'Teapot Lid']));
    const b = new BlenderProcess(fake({ reopen: file }));
    t.after(() => b.stop());
    b.start();
    const info = await b.ready();
    assert.equal(info.reopened, true);
    const { callBlender } = await import('../server/blender-process.js');
    assert.equal((await callBlender(info, 'ping', {}, 5000)).objects, 2);
  });

  // ---------------------------------------------------------------- the server's own Blender, through bridge()
  blender.configure(fake());
  blender.start();

  test('bridge() waits for Blender to be ready, then talks to it', async () => {
    const r = await bridge('ping', {}, { timeout: 10000 });
    assert.equal(r.ok, true);
    assert.equal(r.blender, 'fake');
  });

  test('an idempotent command is retried once on the restarted Blender', async () => {
    const flag = path.join(HOME, 'die-once');
    fs.writeFileSync(flag, '');
    process.env.FAKE_DIE_ONCE = flag;   // read by the next spawn
    const gen = blender.generation;
    blender.restart('pick up FAKE_DIE_ONCE');
    await blender.ready({ after: gen });
    const out = path.join(HOME, 'retry.glb');
    // a budget shorter than the restart takes: the retry must still get all of it
    const r = await bridge('export_glb', { path: out, mode: 'final', rev: 1 }, { timeout: 2000 });
    delete process.env.FAKE_DIE_ONCE;
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(flag), false, 'the first Blender died on it');
    assert.ok(blender.generation >= gen + 2, 'and the answer came from the one after');
    // the seconds spent restarting must not come off the retry's own budget, or a slow command times out at once
    // and looks like a stuck Blender, which kills the one that just came back
    assert.ok(r.deadlineIn > 1500, `the retry kept its budget (got ${r.deadlineIn} ms of 2 s)`);
  });

  test('exec is never retried: the step reports that Blender stopped', async () => {
    const gen = blender.generation;
    await assert.rejects(bridge('exec', { code: 'crash' }, { timeout: 10000 }), err => err instanceof BridgeError && /stopped in the middle/.test(err.message));
    await blender.ready({ after: gen, timeout: 10000 });
    assert.equal((await bridge('scene', {}, { timeout: 10000 })).object_count, 0, 'the crashed exec did not run again');
  });

  test('a command that hangs past its timeout gets Blender restarted', async () => {
    const gen = blender.generation;
    await assert.rejects(bridge('exec', { code: 'hang' }, { timeout: 400 }), /didn't finish that step in time/);
    const info = await blender.ready({ after: gen, timeout: 10000 });
    assert.ok(info.gen > gen);
  });

  // ---------------------------------------------------------------- the working scene and versions
  const res = () => {
    const chunks = [];
    const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    w.writeHead = (status, headers) => { w.status = status; w.headers = headers; };
    const end = w.end.bind(w);
    w.end = (body, ...rest) => { if (body) chunks.push(Buffer.from(body)); return end(...rest); };
    w.done = new Promise(resolve => w.on('finish', resolve));
    w.body = () => Buffer.concat(chunks);
    w.json = () => JSON.parse(w.body().toString('utf8'));
    return w;
  };
  const get = async (pathname, method = 'GET') => {
    const r = res();
    scene.sceneRoute({ method }, r, pathname);
    await r.done;
    return r;
  };
  const makeVersion = async (names, meta = {}, withGlb = false) => {
    const blend = path.join(HOME, `v-${Date.now()}.blend`);
    fs.writeFileSync(blend, JSON.stringify(names));
    const store = await history();
    const files = withGlb ? { blend, glb: blend } : blend;   // a bare path: a version from before GLBs
    return store.add({ kind: 'build', prompt: names.join(' '), ...meta }, files, null);
  };

  test('GET /api/scene starts empty, in the shape the page expects', async () => {
    await blender.ready();
    const r = await get('/api/scene');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    const s = r.json();
    assert.deepEqual(Object.keys(s).sort(), ['blender', 'building', 'glb', 'parts', 'rev', 'sym', 'version']);
    assert.deepEqual({ ...s, blender: s.blender.state }, { rev: 0, glb: null, parts: [], sym: { x: false, y: false, z: false },
                                                           building: false, version: null, blender: 'ready' });
    assert.equal((await get('/api/scene/0.glb')).status, 404);
  });

  test('going back to a version saved before GLBs opens its .blend and publishes a new rev', async () => {
    const v = await makeVersion(['Teapot Body', 'Teapot Lid']);
    const r = await versions.restoreVersion(String(v.n));
    assert.equal(r.version.id, v.id);
    assert.equal(r.checkpoint, null, 'nothing to keep: Blender was empty');
    assert.equal(r.rev, 1);
    const s = (await get('/api/scene')).json();
    assert.equal(s.rev, 1);
    assert.equal(s.glb, '/api/scene/1.glb');
    assert.equal(s.version, v.n);
    assert.deepEqual(s.sym, { x: false, y: false, z: true });
    assert.deepEqual(s.parts.map(p => p.name), ['Teapot Body', 'Teapot Lid']);
    assert.deepEqual(Object.keys(s.parts[0]).sort(), ['ghash', 'id', 'mhash', 'name', 'sculpted', 'textured', 'tris']);
    const glb = await get('/api/scene/1.glb');
    assert.equal(glb.status, 200);
    assert.equal(glb.headers['Content-Type'], 'model/gltf-binary');
    assert.match(glb.headers['Cache-Control'], /immutable/);
    assert.equal(glb.body().toString(), 'glTF final rev 1 Teapot Body,Teapot Lid');
    const head = await get('/api/scene/1.glb', 'HEAD');
    assert.equal(head.headers['Content-Length'], glb.body().length);
    assert.equal(head.body().length, 0);
    assert.equal((await get('/api/scene/9.glb')).status, 404);
    assert.equal((await get('/api/scene/1.glb', 'POST')).status, 405);
    // what Blender reopens after a restart is the scene the page was given
    assert.deepEqual(JSON.parse(fs.readFileSync(CURRENT_BLEND, 'utf8')), ['Teapot Body', 'Teapot Lid']);
    const state = JSON.parse(fs.readFileSync(path.join(WORKING_DIR, 'state.json'), 'utf8'));
    assert.equal(state.rev, 1);
    assert.equal(state.version, v.n);
  });

  test('saving a version keeps the scene GLB with its .blend', async () => {
    const v = await versions.saveVersion({ kind: 'manual', prompt: 'saved by voice' });
    assert.equal(v.parent, (await history().then(s => s.list(2)))[1].n);
    assert.ok(v.glbBytes > 0);
    assert.equal(fs.readFileSync(await versions.versionGlb(v.id), 'utf8'), 'glTF final rev 1 Teapot Body,Teapot Lid');
    assert.equal(await versions.versionGlb('1'), null, 'versions from before GLBs have none');
    assert.equal(scene.sceneVersion(), v.n);
    assert.ok(fs.existsSync(path.join(LOCAL_DIR, `${v.id}.blend`)));
    assert.equal(fs.readdirSync(path.join(HOME, 'snapshots')).length, 0, 'temporary files are cleaned up');
  });

  test('"export" can also fetch the working .blend, which the GLB flattens away', async () => {
    const r = await get('/api/scene/current.blend');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'application/x-blender');
    assert.equal(r.headers['Cache-Control'], 'no-store', 'the autosave is rewritten every publish');
    assert.match(r.headers['Content-Disposition'], /^attachment; filename="[\w-]+\.blend"$/);
    assert.equal(r.body().length, r.headers['Content-Length']);
    assert.equal((await get('/api/scene/current.blend', 'POST')).status, 405);
  });

  test('going back to another version checkpoints a changed scene first, and old GLBs are pruned', async () => {
    await bridge('exec', { code: 'Hand Sculpt' });   // the scene moves on from the saved version
    const target = await makeVersion(['Mug'], {}, true);
    const r = await versions.restoreVersion(target.id);
    assert.ok(r.checkpoint, 'the changed scene was saved first');
    assert.equal(r.checkpoint.prompt, `before going back to version ${target.n}`);
    assert.equal(r.checkpoint.glbBytes > 0, true, "the checkpoint's GLB was exported fresh (the page never had it)");
    assert.equal(r.rev, 2);
    assert.equal(scene.sceneVersion(), target.n);
    for (let i = 0; i < 5; i++) await scene.publish('test');
    const glbs = fs.readdirSync(WORKING_DIR).filter(f => f.endsWith('.glb'));
    assert.deepEqual(glbs.sort(), ['scene-4.glb', 'scene-5.glb', 'scene-6.glb', 'scene-7.glb']);
    assert.equal((await get('/api/scene')).json().glb, '/api/scene/7.glb');
    assert.equal((await get('/api/scene/2.glb')).status, 404);
  });

  test('a restarted Blender reopens the autosave and the rev stays put', async () => {
    const before = (await get('/api/scene')).json();
    const gen = blender.generation;
    blender.restart('test');
    const info = await blender.ready({ after: gen, timeout: 10000 });
    assert.equal(info.reopened, true);
    await new Promise(r => setTimeout(r, 200));   // let the reconcile check run
    const after = (await get('/api/scene')).json();
    assert.equal(after.rev, before.rev);
    assert.deepEqual((await bridge('scene', {})).objects.map(o => o.name), ['Mug']);
  });

  test('the scene lock lets one build or version change in at a time', () => {
    const release = scene.lock('build');
    assert.ok(release);
    assert.equal(scene.lock('version'), null);
    assert.equal(scene.busyWith(), 'build');
    assert.equal(scene.sceneInfo().building, true);
    release();
    assert.equal(scene.sceneInfo().building, false);
    const again = scene.lock('version');
    assert.ok(again);
    assert.equal(scene.sceneInfo().building, false, 'a version change is not a build');
    again();
  });

  test('old versions are pruned with their files, keeping the way back from where the scene is', async () => {
    const store = await history();
    const made = [];
    for (let i = 0; i < 6; i++) made.push(await makeVersion([`Prune ${i}`], { parent: made.at(-1)?.n ?? null }, true));
    const at = made[1];   // the scene sits on an old one, so it and its parent have to survive
    const dropped = await pruneHistory(store, { keep: 3, at: at.n });
    const left = (await store.list(100)).map(v => v.n);
    assert.ok(dropped > 0, 'something was pruned');
    assert.ok(left.includes(at.n) && left.includes(made[0].n), 'the version the scene is at, and its parent, stay');
    for (const v of made.slice(-3)) assert.ok(left.includes(v.n), `version ${v.n} is one of the newest`);
    assert.ok(!left.includes(made[2].n), 'an old version off the path back goes');
    for (const ext of ['blend', 'glb']) {
      assert.equal(fs.existsSync(path.join(LOCAL_DIR, `${made[2].id}.${ext}`)), false, `the ${ext} goes with it`);
    }
    // numbering comes from the highest n, not the count, so a pruned number is never handed out twice
    const next = await makeVersion(['After Pruning']);
    assert.equal(next.n, Math.max(...left) + 1);
  });

  test('an empty scene publishes glb null', async () => {
    await bridge('clear_scene', {});
    const s = await scene.publish('cleared');
    assert.equal(s.glb, null);
    const info = (await get('/api/scene')).json();
    assert.equal(info.glb, null);
    assert.deepEqual(info.parts, []);
  });

  test('cleanup', async () => {
    await blender.stop();
    fs.rmSync(HOME, { recursive: true, force: true });
  });
}
