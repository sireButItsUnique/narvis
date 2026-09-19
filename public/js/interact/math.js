// Plain-object vector/quaternion maths and the filters grab.js needs.
// No three.js here on purpose: grab.js is the one piece that has to run identically in the browser, in
// node --test with no DOM, and later against numbers arriving from a sensor bridge. Poses are plain
// {x,y,z} / {x,y,z,w} objects so a test can write them as literals.
// Units: metres and seconds throughout (times passed in from outside are milliseconds; see config.js).

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vcopy = a => ({ x: a.x, y: a.y, z: a.z });
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vmul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vmix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const vlen = a => Math.hypot(a.x, a.y, a.z);
export const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function vnorm(a) {
  const l = vlen(a);
  return l > 1e-12 ? vmul(a, 1 / l) : v3(0, 0, 0);
}
export const q1 = () => ({ x: 0, y: 0, z: 0, w: 1 });
export const qcopy = q => ({ x: q.x, y: q.y, z: q.z, w: q.w });
export function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function qnorm(q) {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
export function qapply(q, v) {   // v rotated by q
  const t = vmul(vcross({ x: q.x, y: q.y, z: q.z }, v), 2);
  return vadd(vadd(v, vmul(t, q.w)), vcross({ x: q.x, y: q.y, z: q.z }, t));
}
export function qFromAxisAngle(axis, angle) {
  const a = vnorm(axis), s = Math.sin(angle / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(angle / 2) };
}
// the shortest rotation taking unit vector `from` onto unit vector `to` (three.js setFromUnitVectors)
export function qFromUnitVectors(from, to) {
  const a = vnorm(from), b = vnorm(to);
  let r = vdot(a, b) + 1;
  if (r < 1e-9) {   // opposite: any perpendicular axis will do
    r = 0;
    return qnorm(Math.abs(a.x) > Math.abs(a.z) ? { x: -a.y, y: a.x, z: 0, w: 0 } : { x: 0, y: -a.z, z: a.y, w: 0 });
  }
  const c = vcross(a, b);
  return qnorm({ x: c.x, y: c.y, z: c.z, w: r });
}
export function qangle(a, b) {   // absolute angle between two orientations, radians
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------- 1 Euro filter (Casiez, Roussel, Vogel, CHI 2012), 3D, with one addition ----------
// Standard 1 Euro raises the cutoff in proportion to speed, so fast motion has little lag. Fed a hand that is
// STILL but noisy, the noise itself produces a speed estimate (8 mm of jitter at 30 Hz reads as ~0.1 m/s) and
// the filter opens up exactly when we want it shut. `speedFloor` subtracts that noise-driven speed before beta
// is applied, so a still hand gets the full minCutoff smoothing and a real reach still gets the fast path.
// The cutoff is driven by the 3D speed, not per axis, so a diagonal move is not smoothed differently from a
// sideways one (docs/v3-calibration.md makes the same point).
export class OneEuro3 {
  constructor({ minCutoff = 1.0, beta = 20, dCutoff = 1.0, speedFloor = 0 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff, speedFloor });
    this.x = null; this.dx = v3(); this.t = 0;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset(value = null, tSec = 0) { this.x = value && vcopy(value); this.dx = v3(); this.t = tSec; }
  get value() { return this.x && vcopy(this.x); }
  filter(value, tSec) {
    if (!this.x) { this.x = vcopy(value); this.t = tSec; return vcopy(this.x); }
    const dt = clamp(tSec - this.t, 1e-3, 0.25);
    this.t = tSec;
    const raw = vmul(vsub(value, this.x), 1 / dt);
    const ad = OneEuro3.alpha(this.dCutoff, dt);
    this.dx = vadd(this.dx, vmul(vsub(raw, this.dx), ad));
    const speed = Math.max(0, vlen(this.dx) - this.speedFloor);
    const a = OneEuro3.alpha(this.minCutoff + this.beta * speed, dt);
    this.x = vadd(this.x, vmul(vsub(value, this.x), a));
    return vcopy(this.x);
  }
}

// Hysteretic deadband: the output trails the input by at most `band`, and does not move at all while the
// input stays inside it. Cheap and lag-free for real motion (above the band it tracks 1:1), and it is what
// stops the last millimetre of residual filter noise from shimmering on a held object.
export function deadband(out, target, band) {
  const d = vsub(target, out), l = vlen(d);
  return l <= band ? vcopy(out) : vadd(out, vmul(d, (l - band) / l));
}

// Critically damped follow toward a target: no overshoot, so a grabbed object never wobbles past the hand.
// `hz` is the natural frequency; the closed form is stable at any dt, unlike an Euler step.
export function springStep(pos, vel, target, hz, dt) {
  if (hz <= 0) return { pos: vcopy(target), vel: v3() };
  const w = 2 * Math.PI * hz, e = Math.exp(-w * dt);
  const d = vsub(pos, target);
  // x(t) = (d + (v + w d) t) e^(-w t) for a critically damped system
  const c = vadd(vel, vmul(d, w));
  const p = vadd(target, vmul(vadd(d, vmul(c, dt)), e));
  const v = vmul(vsub(c, vmul(vadd(d, vmul(c, dt)), w)), e);
  return { pos: p, vel: v };
}

// A short ring of timestamped samples: "where was the hand 100 ms ago" and "how fast was it then".
export class PoseTrail {
  constructor(spanMs = 400) { this.spanMs = spanMs; this.items = []; }
  push(t, p) {
    this.items.push({ t, p: vcopy(p) });
    const cut = t - this.spanMs;
    while (this.items.length > 2 && this.items[0].t < cut) this.items.shift();
  }
  clear() { this.items.length = 0; }
  // linear interpolation at time t, clamped to the ends of the trail
  at(t) {
    const it = this.items;
    if (!it.length) return null;
    if (t <= it[0].t) return vcopy(it[0].p);
    if (t >= it[it.length - 1].t) return vcopy(it[it.length - 1].p);
    for (let i = it.length - 1; i > 0; i--) {
      if (it[i - 1].t <= t) {
        const span = it[i].t - it[i - 1].t;
        return vmix(it[i - 1].p, it[i].p, span > 1e-6 ? (t - it[i - 1].t) / span : 0);
      }
    }
    return vcopy(it[0].p);
  }
  // mean velocity (m/s) over [t - windowMs, t]; the window ends where you ask, not at "now", which is how
  // the flick at the moment the fingers open is kept out of a throw (Ultraleap use a 45 ms window).
  velocity(t, windowMs) {
    const a = this.at(t - windowMs), b = this.at(t);
    if (!a || !b || windowMs <= 0) return v3();
    return vmul(vsub(b, a), 1000 / windowMs);
  }
}
