// ---------- settings (all lengths in cm unless noted) ----------
export const DEFAULTS = { diagIn: 14, camAboveCm: 0.8, camXCm: 0, ipdMm: 63, hfovDeg: 60, eyeYNudgeCm: 0,
                          knownDistCm: 50, eye: 'center', hands: true, popout: false, mic: true };
export const S = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('htw-settings') || '{}') }; }
  catch (e) { return { ...DEFAULTS }; }
}
export function saveSettings() { try { localStorage.setItem('htw-settings', JSON.stringify(S)); } catch (e) {} }

// ---------- 1 Euro filter (Casiez et al., CHI 2012) ----------
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.05, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(value, tSec) {
    if (this.x === null) { this.x = value; this.t = tSec; return value; }
    const dt = Math.max(1e-3, tSec - this.t); this.t = tSec;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
export const makeFilter3 = (mc, b) => [new OneEuro(mc, b), new OneEuro(mc, b), new OneEuro(mc, b)];
