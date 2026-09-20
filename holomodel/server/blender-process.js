// The one Blender the server runs: headless (-b), hidden, and ours alone. It tells us its port on stdout, answers
// only to the token we put in its environment, restarts with backoff when it dies, reopens the working autosave,
// and dies with us because it watches its stdin (Windows doesn't take children down with their parent).
// `node server/blender-process.js <args>` still just runs `blender -b --factory-startup <args>` (npm run parity:ref).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, CURRENT_BLEND } from './history.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BLENDER_DIR = path.join(here, '..', 'blender');
const LOG_LINES = 200;
// Blender and the glTF exporter are chatty; these stay in the log ring but not on the console
const NOISE = [/^\s*$/, /\| INFO: /, /^INFO (Draco|MeshOptimizer) is available/, /\|\s+Saved: /, /\|\s+Read blend: /,
               /^Info: Saved copy as /, /^Blender quit$/, /^Blender \d+\.\d+/];
// the server's own keys stay out of Blender, where AI-written code runs
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|DSN|MONGODB_URI|CREDENTIAL/i;

// BLENDER_PATH, else the newest C:\Program Files\Blender Foundation\Blender x.y\blender.exe
export function findBlender() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH)) return process.env.BLENDER_PATH;
  const base = 'C:\\Program Files\\Blender Foundation';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'blender.exe'))) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions.at(-1), 'blender.exe') : null;
}

const withoutSecrets = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));

function blenderEnv(token) {
  return { ...withoutSecrets(), HOLO_BRIDGE_TOKEN: token, HOLO_BRIDGE_PORT: '0', PYTHONDONTWRITEBYTECODE: '1', HOLOMODEL_HOME: HOME };
}

function eachLine(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
  });
}

// One request to a running Blender: a JSON line out, a JSON line back. A connection that fails or closes without
// an answer rejects with err.lost (Blender probably died); no answer in time rejects with code HOLO_TIMEOUT.
export function callBlender(info, cmd, args = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(info.port, '127.0.0.1');
    let buf = '', settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => done(Object.assign(new Error(`Blender didn't answer ${cmd} in ${Math.round(timeout / 1000)} s`),
                                                      { code: 'HOLO_TIMEOUT' })), timeout);
    sock.setEncoding('utf8');
    // the deadline lets Blender drop the job if it's still queued after we've stopped waiting (same clock)
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token: info.token, cmd, ...args, deadline: Date.now() + timeout - 250 }) + '\n'));
    sock.on('data', d => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { done(null, JSON.parse(buf.slice(0, nl))); } catch (e) { done(e); }
    });
    sock.on('error', e => done(Object.assign(e, { lost: true })));
    sock.on('close', () => done(Object.assign(new Error(`Blender closed the connection during ${cmd}`), { code: 'ECLOSED', lost: true })));
  });
}

export class BlenderProcess extends EventEmitter {
  #opts = {};
  #child = null;
  #info = null;        // { port, pid, token, gen, blender, startMs, reopened } while ready
  #gen = 0;            // one per spawn, so a retry can wait for a Blender newer than the one that died
  #state = 'starting';
  #message = '';
  #restarts = 0;       // in a row; reset once one has stayed up for stableMs
  #upSince = 0;
  #reopenCrashes = 0;
  #asked = null;       // why we killed it, when we did
  #timer = null;
  #stopping = false;
  #waiters = [];
  #log = [];

  constructor(opts = {}) {
    super();
    this.configure(opts);
  }

  // exe/args replace `blender -b ... headless.py` (tests use a stand-in); reopen is the autosave to open on start
  configure(opts) {
    this.#opts = { backoffMs: 1000, maxBackoffMs: 30000, maxRestarts: 5, stableMs: 60000, readyTimeoutMs: 60000,
                   reopen: CURRENT_BLEND, warmUp: true, log: line => console.log(line), ...this.#opts, ...opts };
  }

  get generation() { return this.#gen; }

  // what GET /api/scene reports: starting | ready | restarting | failed, plus why when it isn't ready
  state() {
    return { state: this.#state, ...(this.#message && this.#state !== 'ready' ? { message: this.#message } : {}),
             ...(this.#child?.pid ? { pid: this.#child.pid } : {}), restarts: this.#restarts };
  }

  logTail(n = LOG_LINES) { return this.#log.slice(-n); }

  start() {
    if (this.#child || this.#timer) return;   // already running, starting, or waiting to restart
    this.#stopping = false;
    this.#restarts = 0;
    this.#set('starting', 'Starting Blender…');
    this.#spawn();
  }

  // Resolves {port, token, gen} once a Blender newer than generation `after` is ready. revive: a failed one gets
  // another go (a user action asking, not a status poll).
  ready({ after = 0, timeout = 60000, revive = true } = {}) {
    if (this.#info && this.#info.gen > after) return Promise.resolve(this.#info);
    if (this.#state === 'failed' && !this.#stopping) {
      if (!revive) return Promise.reject(new Error(this.#message || "Blender isn't running."));
      this.start();
    }
    if (this.#stopping) return Promise.reject(new Error('Blender is stopping.'));
    return new Promise((resolve, reject) => {
      const w = { after, resolve, reject };
      w.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(x => x !== w);
        reject(new Error(this.#state === 'failed' ? this.#message : 'Blender is still starting; try again in a moment.'));
      }, timeout);
      this.#waiters.push(w);
    });
  }

  // Kill it (a job stuck in a loop can only be stopped this way); it comes back through the normal restart.
  restart(reason) {
    if (!this.#child) return;
    this.#record(`restarting: ${reason}`);
    this.#asked = reason;
    this.#child.kill();
  }

  async stop() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#settle(new Error('Blender is stopping.'));
    const c = this.#child;
    if (!c) { this.#set('failed', 'Blender is stopped.'); return; }
    c.stdin.end();   // EOF on its stdin is the quit signal, the same one it gets if we crash
    await new Promise(resolve => {
      if (c.exitCode !== null) return resolve();
      const t = setTimeout(() => { c.kill(); resolve(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  #set(state, message = '') {
    this.#state = state;
    this.#message = message;
    this.emit('state', this.state());
  }

  #record(line, err = false) {
    this.#log.push(`${new Date().toISOString().slice(11, 23)} ${err ? '! ' : ''}${line}`);
    if (this.#log.length > LOG_LINES) this.#log.splice(0, this.#log.length - LOG_LINES);
    if (!NOISE.some(re => re.test(line))) this.#opts.log(`[blender] ${line}`);
  }

  #settle(err, info) {
    const keep = [];
    for (const w of this.#waiters) {
      if (err) { clearTimeout(w.timer); w.reject(err); }
      else if (info.gen > w.after) { clearTimeout(w.timer); w.resolve(info); }
      else keep.push(w);
    }
    this.#waiters = keep;
  }

  #spawn() {
    this.#timer = null;
    const exe = this.#opts.exe ?? findBlender();
    if (!exe) return this.#fail('Blender not found. Install Blender 5.2 or set BLENDER_PATH in .env.');
    const token = crypto.randomBytes(16).toString('hex');   // in the environment, so it's not in the process list
    const args = this.#opts.args ?? ['-b', '--factory-startup', '--python-exit-code', '3',
                                     '--python', path.join(BLENDER_DIR, 'headless.py'), '--', BLENDER_DIR];
    const gen = ++this.#gen, t0 = Date.now();
    // detached (Windows): its own process group, so Ctrl+C in the server's console doesn't hit Blender mid-save;
    // it still goes when we do, through the stdin pipe
    const child = spawn(exe, args, { env: blenderEnv(token), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                                     detached: process.platform === 'win32' });
    this.#child = child;
    child.stdin.on('error', () => {});   // EPIPE if it's already gone
    eachLine(child.stdout, line => {
      if (line.startsWith('HOLO_READY ')) {
        let hello = {};
        try { hello = JSON.parse(line.slice(11)); } catch {}
        this.#onReady(child, { port: hello.port, pid: hello.pid ?? child.pid, token, gen, blender: hello.blender,
                               startMs: Date.now() - t0 });
      } else this.#record(line);
    });
    eachLine(child.stderr, line => this.#record(line, true));
    const readyTimer = setTimeout(() => {
      if (this.#child === child && !this.#info) { this.#record(`no HOLO_READY in ${this.#opts.readyTimeoutMs / 1000} s`); child.kill(); }
    }, this.#opts.readyTimeoutMs);
    child.on('error', err => {   // it didn't start at all (e.g. a wrong BLENDER_PATH); 'exit' may not follow
      clearTimeout(readyTimer);
      if (this.#child === child && child.pid === undefined) { this.#child = null; this.#fail(`Couldn't start Blender: ${err.message}`); }
    });
    child.on('exit', (code, signal) => { clearTimeout(readyTimer); this.#onExit(child, code, signal); });
  }

  async #onReady(child, info) {
    // open the working autosave before anyone else gets the port, so nobody mistakes a fresh Blender for an empty scene
    const reopen = this.#opts.reopen;
    if (reopen && fs.existsSync(reopen)) {
      const r = await callBlender(info, 'restore', { path: reopen }, 120000).catch(err => ({ ok: false, error: err.message, lost: err.lost }));
      if (this.#child !== child) return;
      // a file Blender can't open (or dies opening, twice) would fail every restart the same way: set it aside
      // for a human and start empty
      if (r.lost && ++this.#reopenCrashes < 2) return;   // the exit handler restarts it
      if (r.ok) info.reopened = true;
      else {
        const aside = reopen.replace(/\.blend$/, `-unreadable-${Date.now()}.blend`);
        try { fs.renameSync(reopen, aside); } catch {}
        this.#record(`couldn't reopen ${reopen} (${r.error}); moved it to ${aside}`, true);
        if (r.lost) return;
      }
    }
    this.#reopenCrashes = 0;
    this.#info = info;
    this.#upSince = Date.now();
    this.#set('ready');
    this.#record(`ready on port ${info.port} (pid ${info.pid}, Blender ${info.blender}) in ${info.startMs} ms` +
                 (info.reopened ? ', working scene reopened' : ''));
    this.#settle(null, info);
    this.emit('ready', info);
    if (this.#opts.warmUp) {
      callBlender(info, 'warm_up', {}, 60000)
        .then(r => this.#record(r.ok ? `warmed up in ${r.ms} ms (export ${r.export_ms} ms, render ${r.render_ms} ms)`
                                     : `warm-up failed: ${r.error}`))
        .catch(() => {});
    }
  }

  #onExit(child, code, signal) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#info = null;
    this.#record(`exited with code ${code}${signal ? ` (${signal})` : ''}`);
    if (this.#stopping) { this.#set('failed', 'Blender is stopped.'); return; }
    this.emit('exit', { code, signal });
    this.#report(code, signal);
    if (this.#upSince && Date.now() - this.#upSince > this.#opts.stableMs) this.#restarts = 0;
    this.#upSince = 0;
    if (this.#restarts >= this.#opts.maxRestarts) {
      return this.#fail(`Blender keeps stopping (last exit code ${code}); gave up after ${this.#opts.maxRestarts} restarts in a row.`);
    }
    const wait = Math.min(this.#opts.maxBackoffMs, this.#opts.backoffMs * 2 ** this.#restarts++);
    this.#set('restarting', `Blender stopped (exit code ${code}); restarting in ${Math.round(wait / 100) / 10} s`);
    this.#timer = setTimeout(() => this.#spawn(), wait);
  }

  #fail(message) {
    this.#record(message, true);
    this.#set('failed', message);
    this.#settle(new Error(message));
  }

  #report(code, signal) {
    const asked = this.#asked;   // we killed it on purpose (a stuck job): worth knowing, but not a crash
    this.#asked = null;
    let crash = null;
    try {
      const f = path.join(os.tmpdir(), 'blender.crash.txt');   // Blender writes this one on a hard crash
      if (Date.now() - fs.statSync(f).mtimeMs < 120000) crash = fs.readFileSync(f, 'utf8').slice(0, 8000);
    } catch {}
    console[asked ? 'warn' : 'error'](
      `[blender] headless Blender exited (code ${code})${asked ? `: ${asked}` : ''}`,
      { code, signal, restarts: this.#restarts, crash: crash ? crash.slice(0, 400) : null });
    if (!asked) console.error(this.logTail(20).join('\n'));
  }
}

// the server's Blender
export const blender = new BlenderProcess();
export const start = () => blender.start();
export const stop = () => blender.stop();
export const state = () => blender.state();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(here, '..', '.env')); } catch {}   // BLENDER_PATH
  const exe = findBlender();
  if (!exe) {
    console.log('Blender not found. Install it (winget install BlenderFoundation.Blender) or set BLENDER_PATH in .env.');
    process.exitCode = 1;
  } else {
    // factory settings: the user's add-ons and preferences must not change what a script sees
    const r = spawnSync(exe, ['-b', '--factory-startup', ...process.argv.slice(2)],
                        { stdio: 'inherit', env: { ...withoutSecrets(), PYTHONDONTWRITEBYTECODE: '1' } });
    process.exitCode = r.status ?? 1;
  }
}
