import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  parseBridgeMessage, nextBackoff, ClockSync, zedToCam, zedToWorld, ZedClient, WIRE_VERSION, MAX_AGE_MS,
} from '../public/js/input/zed-client.js';

const lm21 = (x = 0, y = 0, z = -0.5) => Array.from({ length: 21 }, (_, i) => [x + i * 0.001, y, z]);

test('a good hands message parses', () => {
  const m = parseBridgeMessage(JSON.stringify({ t: 'hands', seq: 7, ts: 1.5, hands: [{ handedness: 'Left', score: 0.9, lm: lm21() }] }));
  assert.equal(m.kind, 'hands');
  assert.equal(m.seq, 7);
  assert.equal(m.ts, 1.5);
  assert.equal(m.hands[0].handedness, 'left');
  assert.equal(m.hands[0].lm.length, 21);
});

test('a broken message is data, not a crash', () => {
  assert.equal(parseBridgeMessage('not json').kind, 'bad');
  assert.equal(parseBridgeMessage('null').kind, 'bad');
  assert.equal(parseBridgeMessage('123').kind, 'bad');
  assert.equal(parseBridgeMessage(JSON.stringify({ t: 'hands' })).kind, 'bad');
  assert.equal(parseBridgeMessage(JSON.stringify({ t: 'something-new' })).kind, 'ignored');
  // a truncated hand, a NaN and a wrong landmark count are dropped without taking the frame down
  const m = parseBridgeMessage(JSON.stringify({
    t: 'hands', hands: [{ lm: lm21().slice(0, 12) }, { lm: lm21().map((p, i) => (i === 3 ? ['x', 0, 0] : p)) }, { lm: lm21() }],
  }));
  assert.equal(m.kind, 'hands');
  assert.equal(m.hands.length, 1);
  assert.equal(parseBridgeMessage(JSON.stringify({ t: 'hands', hands: 'no' })).kind, 'bad');
});

test('hello and pong parse, and a version mismatch is visible', () => {
  const h = parseBridgeMessage(JSON.stringify({ t: 'hello', version: 1, source: 'fake', fps: 60 }));
  assert.equal(h.kind, 'hello');
  assert.equal(h.version, WIRE_VERSION);
  const p = parseBridgeMessage(JSON.stringify({ t: 'pong', c0: 5, s: 1000 }));
  assert.deepEqual([p.kind, p.c0, p.s], ['pong', 5, 1000]);
});

test('reconnect backs off from 250 ms to a 2 s cap', () => {
  const half = () => 0.5;
  assert.equal(nextBackoff(0, { rand: half }), 250);
  assert.equal(nextBackoff(1, { rand: half }), 500);
  assert.equal(nextBackoff(3, { rand: half }), 2000);
  assert.equal(nextBackoff(10, { rand: half }), 2000);
  const lo = nextBackoff(0, { rand: () => 0 }), hi = nextBackoff(0, { rand: () => 0.999 });
  assert.ok(lo >= 200 && hi <= 300 && lo < hi);   // jitter, so two clients do not retry in lockstep
});

test('the clock offset is the median of recent exchanges, so one bad round trip cannot move it', () => {
  const c = new ClockSync();
  for (let i = 0; i < 5; i++) c.add(1000 + i, 1_700_000_000_000 + 1000 + i + 5, 1010 + i);   // offset ~1.7e12, rtt 10
  const good = c.offsetMs;
  c.add(2000, 1_700_000_000_000 + 9000, 2400);                                              // one terrible sample
  assert.ok(Math.abs(c.offsetMs - good) < 5);
  assert.equal(Math.round(c.toLocal(good + 500)), 500);
  assert.equal(new ClockSync().offsetMs, 0);
});

test('ZED metres become app centimetres with the camera facing the user', () => {
  // ZED: right-handed, Y up, camera looks down -Z. A point 0.5 m in front, 10 cm up and 10 cm to the
  // camera's right is 50 cm out from the display, 10 cm up, 10 cm to the viewer's left.
  assert.deepEqual(zedToCam([0.1, 0.1, -0.5]), [10, -10, 50]);
  const w = zedToWorld([0.1, 0.1, -0.5], { posCm: [0, 0, 0], rotDeg: [0, 0, 180] });
  assert.deepEqual(w.map(v => Math.round(v * 1e6) / 1e6), [-10, 10, 50]);
});

// ---- a fake socket, to drive the client's own state machine ----

class FakeWS {
  static made = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.made.push(this); }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
}

test('the client tracks latency and refuses a hand that arrived too late', () => {
  FakeWS.made = [];
  let clock = 10_000;
  const got = [];
  const c = new ZedClient({ url: 'ws://x', WebSocket: FakeWS, now: () => clock, onHands: p => got.push(p), pingEveryMs: 1e9 });
  c.connect();
  const ws = FakeWS.made[0];
  ws.open();
  ws.deliver({ t: 'hello', version: 1, source: 'fake', fps: 60 });
  assert.equal(c.stats.source, 'fake');
  // the bridge's clock runs 1.7e12 ms ahead of ours; one ping fixes that
  const bridgeNow = () => 1_700_000_000_000 + clock;
  const c0 = JSON.parse(ws.sent[0]).c0;
  ws.deliver({ t: 'pong', c0, s: bridgeNow() });
  ws.deliver({ t: 'hands', seq: 1, ts: bridgeNow() / 1000, hands: [{ handedness: 'right', lm: lm21() }] });
  assert.equal(got.length, 1);
  assert.ok(got[0].latencyMs < 5);
  assert.equal(got[0].hands[0].world.length, 21);
  assert.ok(got[0].hands[0].world[0][2] > 0);        // in front of the display, not behind it

  clock += MAX_AGE_MS + 50;                          // the next frame was captured before that jump
  ws.deliver({ t: 'hands', seq: 2, ts: (bridgeNow() - MAX_AGE_MS - 50) / 1000, hands: [{ handedness: 'right', lm: lm21() }] });
  assert.equal(got.length, 1, 'a stale hand is worse than no hand');
  assert.equal(c.stats.stale, 1);
  c.close();
});

test('a dropped bridge reconnects on its own, and stopping it stops the retries', async () => {
  FakeWS.made = [];
  const c = new ZedClient({ url: 'ws://x', WebSocket: FakeWS, pingEveryMs: 1e9 });
  c.connect();
  FakeWS.made[0].open();
  assert.equal(c.stats.state, 'open');
  FakeWS.made[0].close();                            // the bridge laptop went away
  assert.equal(c.stats.state, 'retrying');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(FakeWS.made.length, 2, 'it tried again');
  FakeWS.made[1].open();
  assert.equal(c.stats.state, 'open');
  c.close();
  FakeWS.made[1].onclose?.();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(FakeWS.made.length, 2, 'a closed client stays closed');
});

test('a socket that will not even construct is retried, not thrown', async () => {
  let n = 0;
  class Boom { constructor() { n++; throw new Error('refused'); } }
  const c = new ZedClient({ url: 'ws://nope', WebSocket: Boom });
  c.connect();
  assert.equal(c.stats.state, 'retrying');
  await new Promise(r => setTimeout(r, 400));
  assert.ok(n >= 2);
  c.close();
});

// ---- the real bridge, in --fake mode: no camera, no CUDA, no pip install ----

const PORT = 8813;
const python = process.platform === 'win32' ? 'py' : 'python3';

test('the python bridge in --fake mode really speaks this protocol', { timeout: 30000 }, async (t) => {
  const proc = spawn(python, ['tools/zed-bridge/zed_bridge.py', '--fake', '--port', String(PORT), '--fps', '60', '--seconds', '12', '--quiet'],
    { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), stdio: 'ignore' });
  const bridgeUp = await new Promise(r => { proc.on('error', () => r(false)); setTimeout(() => r(true), 1200); });
  if (!bridgeUp) { proc.kill(); t.skip('python not available'); return; }
  try {
    const got = [];
    const client = new ZedClient({ url: `ws://127.0.0.1:${PORT}`, onHands: p => got.push(p), pingEveryMs: 200 });
    client.connect();
    await new Promise(r => setTimeout(r, 2500));
    assert.ok(got.length > 30, `only ${got.length} frames in 2.5 s`);
    assert.equal(client.stats.state, 'live');
    assert.equal(client.stats.source, 'fake');
    assert.ok(client.stats.bad === 0, 'no malformed frames');
    assert.ok(client.stats.latencyMs < 100, `latency ${client.stats.latencyMs} ms`);
    assert.ok(Math.abs(client.clock.offsetMs) > 1e6, 'the bridge clock is epoch ms and was measured, not assumed');

    const hands = got[got.length - 1].hands;
    assert.ok(hands.length >= 1);
    for (const h of hands) {
      assert.equal(h.world.length, 21);
      assert.ok(h.world.every(p => p.every(Number.isFinite)));
      assert.ok(h.world[8][2] > 20 && h.world[8][2] < 80, `fingertip depth ${h.world[8][2]} cm`);
    }
    // the fake hand pinches once every three seconds: the gap must actually change
    const gaps = got.map(p => {
      const w = p.hands[0].world;
      return Math.hypot(w[4][0] - w[8][0], w[4][1] - w[8][1], w[4][2] - w[8][2]);
    });
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 1, 'the fake hand opens and closes');

    // kill the bridge: the client must retry rather than wedge, and pick it up again when it returns
    proc.kill();
    await new Promise(r => setTimeout(r, 900));
    assert.match(client.stats.state, /retrying|connecting/);
    client.close();
  } finally {
    proc.kill();
  }
});
