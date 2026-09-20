// Client for tools/zed-bridge: a ZED on another machine (the one with CUDA) sends 3D hand points over a
// WebSocket on the LAN. This file owns the wire format, the clock offset, reconnection, and turning the
// bridge's metres into the app's world centimetres. It never touches the DOM, so node --test can drive it.
//
// Wire format (JSON text frames, one message per frame):
//   {"t":"hello","version":1,"source":"ZED 2i"|"fake","fps":60,"frame":"zed_y_up","unit":"m"}
//   {"t":"hands","seq":12,"ts":1737320000.123,"hands":[{"handedness":"left","score":0.9,"lm":[[x,y,z] x21]}]}
//   {"t":"head","seq":12,"ts":1737320000.123,"eye":[x,y,z]|null,"ipd":0.063,"src":"stereo"|"<why not>"}
//   {"t":"pong","c0":<client ms we sent>,"s":<bridge ms>}
// ts is the CAPTURE time on the bridge's clock, in seconds; the bridge clock is mapped onto ours by ping.

import { camToWorld, FACING_USER } from './stereo.js';

export const WIRE_VERSION = 1;
export const MAX_AGE_MS = 120;        // a hand older than this is worse than no hand (research: drop, never queue)

// ---------- pure bits ----------

const finite3 = a => Array.isArray(a) && a.length >= 3 && a.every(v => typeof v === 'number' && Number.isFinite(v));

// Returns a tagged object rather than throwing: a malformed frame from the network must never take the app down.
export function parseBridgeMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return { kind: 'bad', why: 'not JSON' }; }
  if (!m || typeof m !== 'object') return { kind: 'bad', why: 'not an object' };
  if (m.t === 'hello') {
    // Optional: the running camera's own numbers (rectified pixels, one eye), so the page can reason about
    // what that camera can see instead of what a typical ZED could.
    const four = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
    const camera = four(m.intr) && Array.isArray(m.size) && m.size.length === 2 && m.size.every(Number.isFinite)
      ? { fx: m.intr[0], fy: m.intr[1], cx: m.intr[2], cy: m.intr[3], eyeW: m.size[0], eyeH: m.size[1],
          baselineCm: Number.isFinite(m.baseline) ? m.baseline * 100 : null } : null;
    // Optional: the hand landmarker's own thresholds AS THEY ARE RUNNING (the page can ask for others: sendConfig)
    const lm = m.landmarker, landmarker = lm && Number.isFinite(lm.detect) && Number.isFinite(lm.track) ? { detect: lm.detect, track: lm.track } : null;
    return { kind: 'hello', version: m.version ?? 0, source: String(m.source || '?'), fps: Number(m.fps) || 0, frame: m.frame || 'zed_y_up', unit: m.unit || 'm', camera, landmarker };
  }
  if (m.t === 'pong') return { kind: 'pong', c0: Number(m.c0), s: Number(m.s) };
  if (m.t === 'head') {
    // eye is null whenever the bridge would not vouch for it (one view only, views disagreeing): a head
    // message with no eye is how "I looked and there is no usable head" differs from "nothing arrived".
    const ts = Number(m.ts);
    return { kind: 'head', seq: Number(m.seq) || 0, ts: Number.isFinite(ts) ? ts : null,
             eye: finite3(m.eye) ? [m.eye[0], m.eye[1], m.eye[2]] : null,
             ipd: Number.isFinite(m.ipd) ? m.ipd : null, src: String(m.src || '') };
  }
  if (m.t !== 'hands') return { kind: 'ignored', t: m.t };
  if (!Array.isArray(m.hands)) return { kind: 'bad', why: 'hands is not an array' };
  const hands = [];
  // check first and cap after, so a malformed entry does not use up one of the two hand slots
  for (const h of m.hands.slice(0, 8)) {
    if (hands.length === 2) break;
    const lm = Array.isArray(h?.lm) ? h.lm : null;
    if (!lm || lm.length !== 21 || !lm.every(finite3)) continue;   // 21 landmarks or it is not a hand we know
    hands.push({
      handedness: /left/i.test(h.handedness || '') ? 'left' : 'right',
      score: Number.isFinite(h.score) ? h.score : 1,
      lm: lm.map(p => [p[0], p[1], p[2]]),
      pinch: parsePinch(h.pinch),
      quality: parseQuality(h.q),
    });
  }
  const ts = Number(m.ts);
  return { kind: 'hands', seq: Number(m.seq) || 0, ts: Number.isFinite(ts) ? ts : null, hands };
}

// The pinch, as the bridge measured it (gestures.pinch_gaps / fuse_gaps): thumb-to-fingertip gaps as a
// fraction of the palm's length. Optional - an older bridge sends none, and the demo then measures its own
// off the joints - and every field is a number or null, because the bridge sends null for "could not tell"
// and a NaN that got through would poison the grab's filter for good.
export function parsePinch(p) {
  if (!p || typeof p !== 'object') return null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = { gap: num(p.gap), grab: num(p.grab), closed: p.closed === true, strength: num(p.strength),
                views: Number.isFinite(p.views) ? p.views : 0 };
  return out.gap === null && out.grab === null ? null : out;
}

// How far the bridge believes this frame's hand (gestures.tracking_confidence) and what went into that:
// the landmarker's score in each view that saw the hand, how many views, how many joints triangulated.
// Optional, like the pinch; the page's gate (rig/hands.js makeHandGate) falls back to `score` without it.
export function parseQuality(q) {
  if (!q || typeof q !== 'object') return null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const conf = num(q.conf);
  return conf === null ? null : { conf: Math.min(1, Math.max(0, conf)), score: num(q.score), other: num(q.other),
                                  views: q.views === 2 ? 2 : 1, tri: Number.isFinite(q.tri) ? q.tri : 0 };
}

// Reconnect delay: 250 ms doubling to a 2 s cap, with jitter so two clients do not retry in lockstep.
export function nextBackoff(attempt, { base = 250, cap = 2000, rand = Math.random } = {}) {
  const d = Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
  return Math.round(d * (0.8 + 0.4 * rand()));
}

// NTP-style 4-timestamp exchange, median of the last 9 — the bridge is a different machine with a
// different clock, and a wrong offset shows up as fake latency, not as wrong positions.
export class ClockSync {
  constructor(window = 9) { this.window = window; this.samples = []; this.rttMs = 0; }
  // c0: when we sent, s: bridge clock at reply, c1: when the reply landed (all ms)
  add(c0, s, c1) {
    if (![c0, s, c1].every(Number.isFinite)) return;
    const rtt = c1 - c0;
    this.rttMs = rtt;
    this.samples.push({ offset: s - (c0 + rtt / 2), rtt });
    if (this.samples.length > this.window) this.samples.shift();
  }
  // bridge clock minus our clock, in ms
  get offsetMs() {
    if (!this.samples.length) return 0;
    const v = this.samples.map(s => s.offset).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  }
  toLocal(bridgeMs) { return bridgeMs - this.offsetMs; }
}

// The bridge sends a right-handed, Y-up, metres frame with the camera looking down -Z (ZED SDK
// COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP). Our camera convention is OpenCV (y down, z out of the lens), so
// flip y and z, scale to cm, then place the camera in the rig with the same extrinsic every camera uses.
export function zedToCam(p) { return [p[0] * 100, -p[1] * 100, -p[2] * 100]; }
export function zedToWorld(p, ext = FACING_USER) { return camToWorld(zedToCam(p), ext); }

// ---------- the client ----------

export class ZedClient {
  constructor(opts = {}) {
    this.url = opts.url || '';
    this.ext = opts.ext || FACING_USER;
    this.WS = opts.WebSocket || globalThis.WebSocket;
    this.now = opts.now || (() => (globalThis.performance?.now?.() ?? Date.now()));
    this.onHands = opts.onHands || (() => {});
    this.onHead = opts.onHead || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.pingEveryMs = opts.pingEveryMs ?? 1000;
    this.clock = new ClockSync();
    this.ws = null; this.attempt = 0; this.timer = null; this.pingTimer = null; this.stopped = true;
    this.stats = { state: 'off', url: '', source: '?', fps: 0, latencyMs: 0, offsetMs: 0, seq: 0,
                   frames: 0, stale: 0, bad: 0, drops: 0, lastAt: -1e9, since: 0, error: '',
                   synced: false, skewMs: 0 };
    this._recent = [];
  }

  connect(url = this.url) {
    this.url = url; this.stopped = false;
    clearTimeout(this.timer);
    if (!this.WS) { this._set('error', 'this browser has no WebSocket'); return; }
    this._set('connecting');
    let ws;
    try { ws = new this.WS(url); } catch (e) { this._retry(String(e?.message || e)); return; }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this._set('open'); this.stats.since = this.now(); this._ping(); };
    ws.onmessage = ev => this._message(typeof ev.data === 'string' ? ev.data : '');
    ws.onerror = () => { this.stats.error = 'socket error'; };
    ws.onclose = () => { if (this.ws === ws) this._retry('closed'); };
  }

  // Ask the bridge to run its hand landmarker with other confidence thresholds. It answers with a fresh
  // `hello` carrying what it is now running, which is what the page shows. False if there is nobody to ask.
  sendConfig({ detect, track } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const m = { t: 'config' };
    if (Number.isFinite(detect)) m.detect = detect;
    if (Number.isFinite(track)) m.track = track;
    try { this.ws.send(JSON.stringify(m)); return true; } catch { return false; }
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer); clearTimeout(this.pingTimer);
    try { this.ws?.close(); } catch {}
    this.ws = null; this._set('off');
  }

  _set(state, error = '') {
    this.stats.state = state; this.stats.url = this.url; if (error) this.stats.error = error;
    this.onStatus(this.stats);
  }

  _retry(why) {
    this.ws = null; clearTimeout(this.pingTimer);
    if (this.stopped) return;
    const wait = nextBackoff(this.attempt++);
    this._set('retrying', why);
    this.timer = setTimeout(() => this.connect(this.url), wait);
  }

  _ping() {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify({ t: 'ping', c0: this.now() })); } catch {}
    this.pingTimer = setTimeout(() => this._ping(), this.pingEveryMs);
  }

  _message(raw) {
    const m = parseBridgeMessage(raw);
    const now = this.now();
    if (m.kind === 'bad') { this.stats.bad++; return; }
    if (m.kind === 'hello') {
      this.stats.source = m.source;
      this.stats.camera = m.camera;
      this.stats.landmarker = m.landmarker;
      if (m.version !== WIRE_VERSION) this.stats.error = `bridge speaks version ${m.version}, we speak ${WIRE_VERSION}`;
      this._set('live'); return;
    }
    if (m.kind === 'pong') { this.clock.add(m.c0, m.s, now); this.stats.offsetMs = this.clock.offsetMs; return; }
    if (m.kind !== 'hands' && m.kind !== 'head') return;

    if (m.kind === 'hands') {
      this.stats.frames++; this.stats.seq = m.seq;
      this._recent.push(now); while (this._recent.length && now - this._recent[0] > 1000) this._recent.shift();
      this.stats.fps = this._recent.length;
    }
    // Do not trust a capture time before the clock is synced. ClockSync.offsetMs is 0 until the first
    // pong lands, so toLocal() hands back the bridge's raw EPOCH milliseconds (~1.76e12) — an "age" of
    // about minus fifty years, which passes every staleness test as ultra-fresh, pins latency at 0 and
    // makes the payload impossible to expire. One burst before the first pong and the model is held for
    // ever by a hand frozen in mid-air, with the live cameras ignored.
    const synced = this.clock.samples.length > 0;
    const captureLocal = (m.ts !== null && synced) ? this.clock.toLocal(m.ts * 1000) : now;
    const age = now - captureLocal;
    this.stats.skewMs = m.ts !== null ? now - this.clock.toLocal(m.ts * 1000) : 0;   // the RAW age, unclamped
    this.stats.synced = synced;
    this.stats.latencyMs = Math.max(0, age);
    this.stats.lastAt = now;
    if (this.stats.state !== 'live') this._set('live');
    // Two-sided, and NaN-proof: anything that is not a plausible age is a clock problem, not a fresh frame.
    if (!Number.isFinite(age) || age < -MAX_AGE_MS || age > MAX_AGE_MS) { this.stats.stale++; return; }
    if (m.kind === 'head') {
      // camera-frame centimetres, NOT world: the rig page places the camera itself (and re-places it when
      // the user recalibrates), so it wants the measurement and not somebody's idea of where that puts it.
      this.onHead({ eye: m.eye ? zedToCam(m.eye) : null, ipdCm: m.ipd !== null ? m.ipd * 100 : null,
                    src: m.src, at: captureLocal, seq: m.seq, latencyMs: age });
      return;
    }
    const hands = m.hands.map(h => ({
      handedness: h.handedness, score: h.score, pinch: h.pinch, quality: h.quality,
      cam: h.lm.map(zedToCam),                              // cm, the camera's own frame
      world: h.lm.map(p => zedToWorld(p, this.ext)),        // cm, app world frame
    }));
    this.onHands({ hands, at: captureLocal, seq: m.seq, latencyMs: age, source: 'bridge' });
  }
}
