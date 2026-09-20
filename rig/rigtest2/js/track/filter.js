// 1 Euro filter (Casiez, Roussel, Vogel, CHI 2012) driven by 3D SPEED rather than per-axis speed.
//
// Why 3D speed: filtering each axis separately lets a hand that is moving fast sideways still be heavily
// smoothed in depth, which shows up as the model lagging behind a grab. One cutoff for the whole point
// keeps the lag isotropic, so a fast move is uniformly responsive and a still hand is uniformly steady.
//
// Units here are millimetres and seconds, so beta is "Hz of extra cutoff per mm/s of speed". The web app's
// existing filters are in centimetres (settings.js), which is why the numbers look ten times smaller there.

const alpha = (cutoffHz, dt) => { const tau = 1 / (2 * Math.PI * cutoffHz); return 1 / (1 + tau / dt); };

export class OneEuro3 {
  /**
   * @param minCutoffHz  cutoff when the point is still: lower = steadier, laggier.
   * @param betaHzPerMmS extra cutoff per mm/s of speed: higher = less lag when moving, more jitter.
   * @param dCutoffHz    cutoff of the speed estimate itself.
   */
  constructor(minCutoffHz = 1.0, betaHzPerMmS = 0.04, dCutoffHz = 1.0) {
    this.minCutoff = minCutoffHz; this.beta = betaHzPerMmS; this.dCutoff = dCutoffHz;
    this.reset();
  }
  reset() { this.x = null; this.dx = [0, 0, 0]; this.speed = 0; this.t = null; }
  get initialised() { return this.x !== null; }

  /** @param p [x,y,z] mm  @param tSec capture time in seconds  @returns the filtered point (a new array) */
  filter(p, tSec) {
    if (this.x === null || !Number.isFinite(tSec)) { this.x = p.slice(); this.t = tSec; return this.x.slice(); }
    const dt = Math.min(0.2, Math.max(1e-3, tSec - this.t));   // clamp: a long gap must not blow the derivative up
    this.t = tSec;
    const aD = alpha(this.dCutoff, dt);
    for (let i = 0; i < 3; i++) this.dx[i] += aD * ((p[i] - this.x[i]) / dt - this.dx[i]);
    this.speed = Math.hypot(this.dx[0], this.dx[1], this.dx[2]);
    const a = alpha(this.minCutoff + this.beta * this.speed, dt);
    for (let i = 0; i < 3; i++) this.x[i] += a * (p[i] - this.x[i]);
    return this.x.slice();
  }
}

// Tuned starting points. The eye is allowed to be laggier than the hand: an eye error moves the floating
// image by only (float depth / eye distance) of itself, roughly a quarter, while a fingertip error is
// seen at full size.
export const EYE_FILTER = { minCutoff: 0.6, beta: 0.02 };
export const HAND_FILTER = { minCutoff: 1.2, beta: 0.04 };

export const makeEyeFilter = () => new OneEuro3(EYE_FILTER.minCutoff, EYE_FILTER.beta);
export const makeHandFilter = () => new OneEuro3(HAND_FILTER.minCutoff, HAND_FILTER.beta);

/** A bank of 21 filters for one hand's landmarks, sharing the same tuning. */
export class HandFilterBank {
  constructor(n = 21, cfg = HAND_FILTER) {
    this.filters = Array.from({ length: n }, () => new OneEuro3(cfg.minCutoff, cfg.beta));
  }
  reset() { for (const f of this.filters) f.reset(); }
  filterAll(points, tSec) { return points.map((p, i) => (p ? this.filters[i].filter(p, tSec) : null)); }
}
