// Picking the model up, moving it and putting it down, from noisy hand tracking.
//
// The whole job of this file is to make a grab feel SOLID when the numbers underneath are not: the sensors give
// 3-7 mm of fingertip error, drop hands for a few frames at a time, and flick the pinch point several
// centimetres sideways at the moment the fingers open. So:
//   - two pinch thresholds, never one, plus a minimum hold time
//   - what you grabbed is decided from where your hand was a moment BEFORE the fingers closed
//   - the object keeps its offset from the hand instead of snapping to it
//   - the hand is 1-Euro filtered, and the held body follows through a deadband and a critically damped spring
//   - a hand may vanish for 200 ms without dropping what it holds, and re-grips where the body actually is
//   - release uses the pose from ~100 ms earlier, so the flick as the fingers open is not part of the gesture
//   - dropping settles the body onto the working volume's floor; no physics engine, just gravity and drag
//   - both hands on one body rotate and resize it
//
// Deliberately free of three.js and of the DOM: plain {x,y,z} numbers in, plain poses out, so node --test can
// drive it and a sensor bridge can feed it. bodies.js adapts it to three.js objects.
// Units: whatever the config is in (metres by default). Times are milliseconds.

import { GRAB_CONFIG, cloneConfig } from './config.js';
import {
  v3, vcopy, vadd, vsub, vmul, vmix, vlen, vdist, vnorm, clamp,
  q1, qcopy, qconj, qmul, qapply, qFromUnitVectors, OneEuro3, PoseTrail, deadband, springStep,
} from './math.js';

const clonePose = p => ({ position: vcopy(p.position), quaternion: qcopy(p.quaternion || q1()), scale: p.scale ?? 1 });
const centreOf = b => b.center || b.pose.position;
const midpoint = (a, b) => vmix(a, b, 0.5);

let nextRecordId = 1;

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  live, mutable tuning object (see config.js)
 *
 * update({ hands, bodies, now }):
 *   hands:  [{ id, active, seenAt, thumb, index, grip?, pinch? }]  pinch as a boolean skips the distance test
 *   bodies: [{ id, pose:{position,quaternion,scale}, radius, center?, restOffset?, locked? }]
 *           grab writes a NEW pose object onto every body it is driving; it never mutates one in place.
 *   now:    milliseconds, monotonic
 */
export function createGrab({ config = cloneConfig(GRAB_CONFIG) } = {}) {
  const cfg = config;
  const listeners = new Map();
  const hands = new Map();      // handId -> per-hand state
  const holds = new Map();      // bodyId -> hold
  const settles = new Map();    // bodyId -> settle
  const undos = [];
  let lastNow = null;

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
    return () => off(name, fn);
  }
  function off(name, fn) {
    const l = listeners.get(name);
    const i = l ? l.indexOf(fn) : -1;
    if (i >= 0) l.splice(i, 1);
  }
  function emit(name, payload) {
    for (const fn of listeners.get(name) || []) fn(payload);
  }

  function handState(id) {
    let h = hands.get(id);
    if (!h) {
      h = {
        id,
        live: false, lostAt: null, seenAt: null, seenEver: false, resumed: false,
        point: null, raw: null,
        filter: new OneEuro3(cfg.point),
        trail: new PoseTrail(Math.max(400, cfg.releaseLagMs + cfg.velocityWindowMs + 100)),
        gap: Infinity, pinchAmount: 0, firmAt: null,
        pinched: false, edgeWant: false, edgeSince: 0,
        justClosed: false, justOpened: false,
        intent: null,          // { bodyId, t }  what the open hand meant to take
        challenger: null,      // { bodyId, since }
        hoverId: null, holdId: null,
        lockout: new Map(),    // bodyId -> time until this hand may take it again
      };
      hands.set(id, h);
    }
    return h;
  }

  // ---------- per-frame: read one hand ----------
  function readHand(raw, now) {
    const h = handState(raw.id);
    h.justClosed = h.justOpened = h.resumed = false;
    // Remember WHEN the sensor last actually saw this hand. The hold-through window is measured from
    // that, not from the frame we first decided the hand was gone — otherwise the upstream staleness
    // grace and this one run in series and the model stays glued to a dead hand for twice as long as
    // dropoutMs says (450 ms through the real solver, against the 200 ms this file documents).
    if (raw.seenAt != null) h.seenAt = raw.seenAt;
    const live = raw.active !== false && (raw.seenAt == null || now - raw.seenAt <= cfg.dropoutMs);
    if (!live) {
      if (h.live) h.lostAt = now;      // keep the last point; the hold is ended later, once dropoutMs is up
      h.live = false;
      return h;
    }
    h.resumed = !h.live && h.seenEver;
    h.live = true;
    h.seenEver = true;

    const grip = raw.grip ? vcopy(raw.grip) : midpoint(raw.thumb, raw.index);
    h.raw = grip;
    // the filter's parameters change with the phase (steadier while holding) but its state carries over,
    // so there is no step at the moment of the grab
    Object.assign(h.filter, h.holdId ? cfg.hold : cfg.point);
    // Coming back from a dropout, seed the filter with the last FILTERED point, not the first raw sample: one
    // raw sample carries the tracker's full 8 mm of noise, and anything we anchor to it keeps that error for
    // good. Seeded this way the hand converges over ~100 ms with no step, and a held body simply follows.
    //
    // EXCEPT in a two-hand hold, where update() is about to re-take the basis from this very point: seeding
    // with the pre-gap point would hand it a position that is still a gap's worth of travel behind, and bake
    // that into the new basis. There the fresh sample is the right answer.
    if (h.resumed) {
      const inTwo = h.holdId != null && holds.get(h.holdId)?.kind === 'two';
      h.filter.reset(inTwo ? grip : (h.point || grip), now / 1000);
    }
    h.point = h.filter.filter(grip, now / 1000);
    h.trail.push(now, h.point);

    // pinch: hysteresis (two thresholds), stickiness once closed, and a minimum hold time on both edges
    const gap = typeof raw.pinch === 'boolean' ? (raw.pinch ? 0 : Infinity) : vdist(raw.thumb, raw.index);
    h.gap = gap;
    const span = Math.max(cfg.pinchOff * 2, cfg.pinchOn + 1e-6);
    h.pinchAmount = clamp((span - gap) / (span - cfg.pinchOn), 0, 1);
    if (gap < cfg.pinchOn) h.firmAt = now;   // the last moment the pinch was firmly shut: see endHold()
    const eff = h.pinched ? gap * cfg.pinchStick : gap;
    const want = h.pinched ? eff <= cfg.pinchOff : eff < cfg.pinchOn;
    if (want !== h.edgeWant) { h.edgeWant = want; h.edgeSince = now; }
    if (want !== h.pinched && now - h.edgeSince >= (want ? cfg.pinchHoldMs : cfg.releaseHoldMs)) {
      h.pinched = want;
      if (want) h.justClosed = true; else h.justOpened = true;
    }
    return h;
  }

  // ---------- choosing what you grabbed ----------

  /**
   * How far the pinch point is from a body's pick volume — the ONE ranking, used by both bestTarget and
   * the intent memory, because ranking them differently means the highlight and the grab disagree.
   *
   * It is the distance to the part's own oriented box when bodies.js measured one. The old measure was
   * (distance to centre - bounding-sphere radius), and bodies.js set that radius to half the bounding-box
   * DIAGONAL, so size was a pure bonus with no upper bound: a 30 x 2 x 30 cm base slab beat the 5 cm ball
   * sitting on it even when the hand was dead centre on the ball, and any model with one large or flat
   * part had exactly one grabbable part. A sphere fallback is kept for bodies built by hand (the tests,
   * and anything that is really a ball).
   */
  function pickScore(point, b) {
    const c = centreOf(b);
    const h = b.half;
    if (!h) return vdist(point, c) - (b.radius || 0);
    const d = vsub(point, c);
    const q = b.quaternion || b.pose?.quaternion;
    const p = q ? qapply(qconj(q), d) : d;          // into the part's own axes
    const dx = Math.max(0, Math.abs(p.x) - h.x);
    const dy = Math.max(0, Math.abs(p.y) - h.y);
    const dz = Math.max(0, Math.abs(p.z) - h.z);
    return Math.hypot(dx, dy, dz);
  }

  /**
   * The nearest takeable body, and whether the nearest body of all is one this hand may not take yet.
   * Those are two different questions and conflating them was the bug: the re-grab lockout skipped the
   * body it had just dropped and then handed the grab to the NEXT nearest one, so for 620 ms after every
   * release a re-pinch on the same spot took the neighbouring part instead — and the hover highlight
   * moved with it.
   */
  function bestTarget(point, bodies, h, now, { ignoreLockout = false } = {}) {
    let best = null, bestD = Infinity, lockedOut = false;
    for (const b of bodies) {
      if (b.locked) continue;
      const d = pickScore(point, b);
      if (d >= bestD) continue;
      const until = h.lockout.get(b.id);
      const blocked = !ignoreLockout && until != null && now < until;
      bestD = d; best = b; lockedOut = blocked;
    }
    if (!best || bestD > cfg.grabRadius) return null;
    return { body: best, dist: bestD, lockedOut };
  }

  const intentValid = (h, bodies, now) =>
    !!h.intent && now - h.intent.t <= cfg.intentMs && bodies.some(b => b.id === h.intent.bodyId && !b.locked);

  // Intent memory: what the OPEN hand was nearest. Closing the fingers moves the pinch point by centimetres, so
  // "what am I nearest now" is the wrong question at the exact moment it is asked. A challenger has to be nearer
  // by a margin, and stay that way, before it takes over: one jittery frame cannot steal the grab.
  function updateIntent(h, bodies, now) {
    const near = h.point ? bestTarget(h.point, bodies, h, now) : null;
    // The nearest body is one this hand just dropped: the honest answer is "nothing yet", not "the one
    // behind it". Leave the intent where it is and show no hover, so the highlight cannot promise a part
    // the grab will not take.
    if (near && near.lockedOut) { h.challenger = null; h.hoverId = null; return; }
    if (!near) {
      h.challenger = null;
      h.hoverId = intentValid(h, bodies, now) ? h.intent.bodyId : null;
      return;
    }
    const stale = !h.intent || now - h.intent.t > cfg.intentMs || !bodies.some(b => b.id === h.intent.bodyId);
    if (stale || near.body.id === h.intent.bodyId) {
      h.intent = { bodyId: near.body.id, t: now };
      h.challenger = null;
    } else {
      const cur = bodies.find(b => b.id === h.intent.bodyId);
      const curD = pickScore(h.point, cur);
      if (near.dist < curD - cfg.intentStealMargin) {
        if (!h.challenger || h.challenger.bodyId !== near.body.id) h.challenger = { bodyId: near.body.id, since: now };
        if (now - h.challenger.since >= cfg.intentSwitchMs) { h.intent = { bodyId: near.body.id, t: now }; h.challenger = null; }
      } else {
        h.challenger = null;
        h.intent.t = now;   // still in reach of what we meant: keep it fresh
      }
    }
    h.hoverId = h.intent.bodyId;
  }

  // ---------- holds ----------
  function newRecord(hold) {
    return {
      id: nextRecordId++, bodyId: hold.bodyId, kind: hold.kind, handIds: [...hold.handIds],
      startedAt: hold.startedAt, endedAt: null, reason: null,
      before: clonePose(hold.startPose), after: clonePose(hold.startPose),
      releaseVelocity: v3(), settled: false,
    };
  }

  function startHold(h, body, now) {
    settles.delete(body.id);
    const pose = clonePose(body.pose);
    const hold = {
      bodyId: body.id, kind: 'one', handIds: [h.id], startedAt: now,
      startPose: pose,
      offset: vsub(pose.position, h.point),        // the anchor: what keeps the body off the fingertips
      quat: qcopy(pose.quaternion), scale: pose.scale,
      out: vcopy(pose.position), vel: v3(), db: vcopy(pose.position),
      two: null,
    };
    hold.record = newRecord(hold);
    holds.set(body.id, hold);
    h.holdId = body.id;
    emit('grabStart', { bodyId: body.id, handIds: [h.id], kind: 'one', pose: clonePose(pose), at: now });
    return hold;
  }

  // second hand joins a body already held: rotate + resize + move, anchored on the CURRENT pose so nothing jumps
  function makeTwoBasis(hold, a, b, pose) {
    return {
      span0: Math.max(1e-6, vdist(a.point, b.point)),
      axis0: vnorm(vsub(b.point, a.point)),
      mid0: midpoint(a.point, b.point),
      pos0: vcopy(pose.position), q0: qcopy(pose.quaternion || q1()), s0: pose.scale ?? 1,
      rot: q1(), ratio: 1,
    };
  }

  function upgradeToTwo(hold, a, b, body, now) {
    hold.kind = 'two';
    hold.handIds = [a.id, b.id].sort((x, y) => x - y);
    const [ha, hb] = hold.handIds.map(id => hands.get(id));
    hold.two = makeTwoBasis(hold, ha, hb, { position: hold.out, quaternion: hold.quat, scale: hold.scale });
    a.holdId = b.holdId = body.id;
    hold.record.kind = 'two';
    hold.record.handIds = [...hold.handIds];
    emit('grabStart', { bodyId: body.id, handIds: [...hold.handIds], kind: 'two', pose: clonePose(body.pose), at: now });
  }

  // Re-take the offset from where the body actually is. Used when one hand of a two-hand grab lets go, and when
  // a hand comes back after a dropout: the body stays put instead of snapping to wherever the hand now is.
  function reanchor(hold) {
    const live = hold.handIds.map(id => hands.get(id)).filter(h => h && h.live && h.point);
    const pose = { position: vcopy(hold.out), quaternion: qcopy(hold.quat), scale: hold.scale };
    if (live.length >= 2) {
      hold.kind = 'two';
      hold.two = makeTwoBasis(hold, live[0], live[1], pose);
    } else if (live.length === 1) {
      hold.kind = 'one';
      hold.handIds = [live[0].id];
      hold.two = null;
      hold.offset = vsub(hold.out, live[0].point);
    }
    hold.db = vcopy(hold.out);
    hold.vel = v3();
  }

  function driveHold(hold, body, now, dt) {
    const hs = hold.handIds.map(id => hands.get(id)).filter(h => h && h.live && h.point);
    let desired = hold.out, quat = hold.quat, scale = hold.scale;

    // A two-hand hold with only one hand reporting keeps the pose it has. It must NOT fall back to the
    // one-hand offset: that offset was taken before the second hand joined and would jump the model the
    // instant the tracker blinked. reanchor() takes a fresh one if the hold really does demote.
    if (hold.kind === 'two' && hs.length === 2 && hold.two) {
      const t = hold.two, [a, b] = hs;
      const d = vsub(b.point, a.point), span = vlen(d);
      if (span >= cfg.twoHandMinSpan) {                      // a short span gives a noisy axis: hold the last one
        t.rot = qFromUnitVectors(t.axis0, vnorm(d));
        let k = span / t.span0;
        const db = cfg.scaleDeadband;
        k = k > 1 + db ? k - db : k < 1 - db ? k + db : 1;    // a pure rotate must not also resize
        t.ratio = clamp(t.s0 * k, cfg.scaleMin, cfg.scaleMax) / t.s0;
      }
      desired = vadd(midpoint(a.point, b.point), qapply(t.rot, vmul(vsub(t.pos0, t.mid0), t.ratio)));
      quat = qmul(t.rot, t.q0);
      scale = t.s0 * t.ratio;
    } else if (hold.kind === 'one' && hs.length) {
      desired = vadd(hs[0].point, hold.offset);
    }
    desired = clampToVolume(desired);

    // the deadband kills the last millimetre of filter noise; the spring stops the body stepping frame to frame
    hold.db = deadband(hold.db, desired, cfg.holdDeadband);
    const st = springStep(hold.out, hold.vel, hold.db, cfg.holdFollowHz, dt);
    hold.out = st.pos; hold.vel = st.vel;
    hold.quat = quat; hold.scale = scale;

    const pose = { position: vcopy(hold.out), quaternion: qcopy(quat), scale };
    body.pose = pose;
    hold.record.after = clonePose(pose);
    emit('grabMove', { bodyId: body.id, handIds: [...hold.handIds], kind: hold.kind, pose: clonePose(pose), at: now });
  }

  // Release: the pose from BEFORE the fingers started to open, and the velocity over the window ending there,
  // so the lurch the pinch midpoint makes as they separate is in neither.
  //
  // "Before they started to open" is not the same as "a fixed time ago": the gap has to travel from 25 mm to
  // 30 mm and then hold for releaseHoldMs, and all of that happens while the hand is already lurching. So the
  // reference is the last frame the pinch was FIRMLY shut (gap under pinchOn), backed off by releasePreMs —
  // with now - releaseLagMs as a floor, for input that never reports a gap at all (mouse, scripted).
  function endHold(hold, body, now, reason) {
    holds.delete(hold.bodyId);
    for (const h of hands.values()) if (h.holdId === hold.bodyId) h.holdId = null;

    const h = hands.get(hold.handIds[0]);
    const firm = h && h.firmAt != null ? h.firmAt - cfg.releasePreMs : Infinity;
    const tPre = Math.min(now - cfg.releaseLagMs, firm);
    const pose = clonePose(body.pose);
    let vel = v3();
    // Only a DELIBERATE one-hand release rolls back and throws. A hold that ended because the hand
    // vanished is not a gesture: rolling back put the model where the hand was ~250 ms ago, and handing
    // the settle that velocity flung it across the volume — a tracking blink was indistinguishable from
    // the user throwing the model. Two hands never roll back either: two flicks, no single anchor, and
    // the pose is a rotation and a scale as well as a point.
    if (reason === 'released' && h && hold.kind === 'one' && h.trail.items.length > 1) {
      const pre = h.trail.at(tPre);
      if (pre) pose.position = clampToVolume(vadd(pre, hold.offset));
      vel = h.trail.velocity(tPre, cfg.velocityWindowMs);
      const s = vlen(vel);
      if (s > cfg.maxSpeed) vel = vmul(vel, cfg.maxSpeed / s);
    }
    body.pose = pose;

    const rec = hold.record;
    rec.endedAt = now;
    rec.after = clonePose(pose);
    rec.releaseVelocity = vcopy(vel);
    rec.reason = reason;
    undos.push(rec);

    for (const id of hold.handIds) hands.get(id)?.lockout.set(hold.bodyId, now + cfg.regrabLockoutMs);
    emit('grabEnd', { bodyId: body.id, handIds: [...hold.handIds], pose: clonePose(pose), velocity: vcopy(vel), reason, record: rec, at: now });

    // A lost hand does not drop the model on the floor either. Gating only the velocity still let gravity
    // carry it ~90 mm down, which is what the user would actually see after a 200 ms occlusion: it left
    // where it was and landed somewhere else. Close the record immediately instead, so undo still works.
    if (reason !== 'released') {
      rec.settled = true;
      emit('settleEnd', { bodyId: body.id, pose: clonePose(pose), record: rec, at: now });
      return;
    }
    settles.set(body.id, { bodyId: body.id, vel: vmul(vel, cfg.throwGain), startedAt: now, record: rec });
    emit('settleStart', { bodyId: body.id, pose: clonePose(pose), at: now });
  }

  // ---------- drop: fall to the floor of the working volume. Not physics, just enough to read as "set down". ----------
  function stepSettle(s, body, now, dt) {
    const rest = cfg.floorY + (body.restOffset || 0);
    const box = cfg.volume;
    let v = { x: s.vel.x * Math.exp(-cfg.settleDrag * dt), y: s.vel.y - cfg.settleGravity * dt,
              z: s.vel.z * Math.exp(-cfg.settleDrag * dt) };
    const np = vadd(body.pose.position, vmul(v, dt));
    if (np.y <= rest) {
      np.y = rest;
      v = Math.abs(v.y) > cfg.settleRestSpeed * 4 ? { x: v.x, y: -v.y * cfg.settleBounce, z: v.z } : { x: v.x, y: 0, z: v.z };
    }
    if (cfg.clampToVolume) {
      if (np.x < box.minX || np.x > box.maxX) { np.x = clamp(np.x, box.minX, box.maxX); v.x = 0; }
      if (np.z < box.minZ || np.z > box.maxZ) { np.z = clamp(np.z, box.minZ, box.maxZ); v.z = 0; }
      np.y = clamp(np.y, rest, Math.max(rest, box.maxY));
    }
    s.vel = v;
    body.pose = { position: np, quaternion: qcopy(body.pose.quaternion || q1()), scale: body.pose.scale ?? 1 };

    // done when it has stopped on the floor — or when there is nothing left to fall to (gravity turned off)
    const resting = vlen(v) < cfg.settleRestSpeed && (np.y <= rest + 1e-9 || cfg.settleGravity <= 0);
    const timedOut = now - s.startedAt > cfg.settleMaxMs;
    if (resting || timedOut) {
      // a timeout stops the settle where the body is; it never teleports it to the floor, which would be a
      // worse surprise than a model that has come to rest slightly in the air
      s.record.after = clonePose(body.pose);
      s.record.settled = true;
      settles.delete(s.bodyId);
      emit('settleEnd', { bodyId: body.id, pose: clonePose(body.pose), record: s.record, at: now });
    } else {
      s.record.after = clonePose(body.pose);
      emit('grabMove', { bodyId: body.id, handIds: [], kind: 'settle', pose: clonePose(body.pose), at: now });
    }
  }

  function clampToVolume(p) {
    if (!cfg.clampToVolume) return vcopy(p);
    const b = cfg.volume;
    return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY), z: clamp(p.z, b.minZ, b.maxZ) };
  }

  // ---------- the frame ----------
  function update({ hands: rawHands = [], bodies = [], now = 0 }) {
    const dt = lastNow == null ? 1 / 60 : clamp((now - lastNow) / 1000, 1e-3, 0.25);
    lastNow = now;
    const byId = new Map(bodies.map(b => [b.id, b]));

    // a body that vanished takes its hold and its settle with it
    for (const id of [...holds.keys()]) {
      if (byId.has(id)) continue;
      for (const h of hands.values()) if (h.holdId === id) h.holdId = null;
      holds.delete(id);
    }
    for (const id of [...settles.keys()]) if (!byId.has(id)) settles.delete(id);

    const seen = new Set();
    for (const raw of rawHands) { seen.add(raw.id); readHand(raw, now); }
    for (const h of hands.values()) {
      if (seen.has(h.id)) continue;
      if (h.live) h.lostAt = now;
      h.live = false; h.justClosed = h.justOpened = h.resumed = false;
    }

    // a hand that has been gone longer than the dropout window drops what it holds
    for (const h of hands.values()) {
      if (h.live || !h.holdId) continue;
      if (h.lostAt != null && now - (h.seenAt ?? h.lostAt) <= cfg.dropoutMs) continue;
      const hold = holds.get(h.holdId);
      h.holdId = null;
      if (!hold) continue;
      hold.handIds = hold.handIds.filter(id => id !== h.id);
      const others = hold.handIds.filter(id => hands.get(id)?.live);
      if (others.length) reanchor(hold);
      else if (byId.has(hold.bodyId)) { hold.handIds = [h.id]; endHold(hold, byId.get(hold.bodyId), now, 'lost'); }
      else holds.delete(hold.bodyId);
    }
    // A hand that came back inside the hold-through window must re-take the two-hand basis. span0/axis0/
    // mid0/pos0 are defined RELATIVE TO THE OTHER HAND, which kept moving while this one was gone, so
    // reusing them made the model sit still for the whole gap and then snap 50-100 mm and tens of degrees
    // in a single frame. A ONE-hand hold is the opposite case: its offset is meant to survive the gap
    // untouched, and re-taking it there makes the grip slide.
    for (const h of hands.values()) {
      if (!h.resumed || !h.holdId) continue;
      const hold = holds.get(h.holdId);
      if (hold && hold.kind === 'two') reanchor(hold);
    }

    // hover / intent for hands that are not holding
    for (const h of hands.values()) {
      if (!h.live) { h.hoverId = null; continue; }
      if (h.holdId) { h.hoverId = h.holdId; h.challenger = null; continue; }
      updateIntent(h, bodies, now);
    }

    // rising edges: take something
    for (const h of ordered()) {
      if (!h.live || !h.justClosed || h.holdId) continue;
      let body = intentValid(h, bodies, now) ? byId.get(h.intent.bodyId) : null;
      const until = body && h.lockout.get(body.id);
      if (until != null && now < until) body = null;
      if (!body) {
        // Decide what the hand is nearest FIRST, then ask whether it may take it. If the winner is
        // locked out, take nothing this frame — never the runner-up.
        const near = bestTarget(h.point, bodies, h, now, { ignoreLockout: true });
        if (!near) continue;
        const lock = h.lockout.get(near.body.id);
        if (lock != null && now < lock) continue;
        body = near.body;
      }
      if (!body) continue;
      const existing = holds.get(body.id);
      if (!existing) { startHold(h, body, now); continue; }
      const other = hands.get(existing.handIds[0]);
      if (existing.kind === 'one' && other && other.id !== h.id && other.live) upgradeToTwo(existing, other, h, body, now);
    }

    // falling edges: let go
    for (const h of ordered()) {
      if (!h.justOpened || !h.holdId) continue;
      const hold = holds.get(h.holdId);
      h.holdId = null;
      if (!hold) continue;
      hold.handIds = hold.handIds.filter(id => id !== h.id);
      const others = hold.handIds.filter(id => hands.get(id)?.live && hands.get(id).pinched);
      if (others.length) reanchor(hold);
      else if (byId.has(hold.bodyId)) { hold.handIds = [h.id]; endHold(hold, byId.get(hold.bodyId), now, 'released'); }
      else holds.delete(hold.bodyId);
    }

    for (const hold of holds.values()) driveHold(hold, byId.get(hold.bodyId), now, dt);
    for (const s of [...settles.values()]) stepSettle(s, byId.get(s.bodyId), now, dt);

    for (const h of hands.values()) for (const [id, t] of h.lockout) if (now > t) h.lockout.delete(id);
    return frame(now);
  }

  const ordered = () => [...hands.values()].sort((a, b) => a.id - b.id);

  function frame(now) {
    return {
      now,
      hands: ordered().map(h => ({
        id: h.id, live: h.live, point: h.point && vcopy(h.point), raw: h.raw && vcopy(h.raw),
        gap: h.gap, pinchAmount: h.pinchAmount, pinched: h.pinched,
        hoverId: h.hoverId, holdId: h.holdId,
        lostMs: !h.live && h.lostAt != null ? now - h.lostAt : 0,
      })),
      holds: [...holds.values()].map(h => ({ bodyId: h.bodyId, kind: h.kind, handIds: [...h.handIds], startedAt: h.startedAt })),
      settling: [...settles.keys()],
    };
  }

  return {
    config: cfg,
    on, off,
    update,
    get undos() { return undos; },
    takeUndos: () => undos.splice(0, undos.length),
    heldBy: handId => hands.get(handId)?.holdId ?? null,
    isHeld: bodyId => holds.has(bodyId),
    holdOf: bodyId => holds.get(bodyId) || null,
    isSettling: bodyId => settles.has(bodyId),
    state: () => frame(lastNow ?? 0),
    reset() { hands.clear(); holds.clear(); settles.clear(); undos.length = 0; lastNow = null; },
  };
}

// Apply an undo record: put the body back where it was before the manipulation (or forward again).
export function applyRecord(body, rec, direction = 'undo') {
  const p = direction === 'undo' ? rec.before : rec.after;
  body.pose = clonePose(p);
  return body.pose;
}
