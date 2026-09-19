// Pinhole camera with optional radial/tangential distortion, posed in the rig frame.
//
// Units: the rig frame is MILLIMETRES, Y up, X right, Z toward the viewer, origin at the centre of the
// acrylic sheet (see sim/rig-sim.js). Image coordinates are pixels, +x right and +y DOWN, which is what
// MediaPipe gives us once its normalised coordinates are multiplied by the frame size.
//
// Camera axes follow OpenCV: +Z forward (out of the lens), +X right, +Y down. That makes the intrinsics,
// the distortion model and any calibration file we read from OpenCV or Stereolabs line up without sign fixes.

import { sub, matVec, transpose, normalize, lookRotation, orthonormalize, I3 } from './linalg.js';

// Focal length in pixels from a field of view. Webcam datasheets quote the DIAGONAL fov (the Logitech
// C920's "78 degrees" is diagonal), so that is the default; getting this wrong scales every depth.
export function intrinsicsFromFov({ width, height, fovDeg, fovAxis = 'diagonal', cx, cy }) {
  const span = fovAxis === 'horizontal' ? width : fovAxis === 'vertical' ? height : Math.hypot(width, height);
  const f = (span / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
  return { width, height, fx: f, fy: f, cx: cx ?? width / 2, cy: cy ?? height / 2 };
}

export const fovFromFocal = (f, span) => 2 * Math.atan(span / (2 * f)) * 180 / Math.PI;

const ZERO_DIST = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };

export class PinholeCamera {
  constructor(opts = {}) {
    const { id = 'cam', label = id, width = 1280, height = 720, fx, fy, cx, cy, dist,
            position = [0, 0, 0], R, target, up = [0, 1, 0], role = 'both' } = opts;
    this.id = id;
    this.label = label;
    this.role = role;                       // 'hands' | 'head' | 'both' — what this camera is meant to watch
    this.width = width; this.height = height;
    this.fx = fx ?? width; this.fy = fy ?? fx ?? width;
    this.cx = cx ?? width / 2; this.cy = cy ?? height / 2;
    this.dist = { ...ZERO_DIST, ...(dist || {}) };
    this.position = position.slice();
    this.R = R ? orthonormalize(R.slice()) : (target ? lookRotation(position, target, up) : I3());
    this.latencyMs = opts.latencyMs ?? 0;   // capture-to-available delay, used by the simulator
    this.fps = opts.fps ?? 30;
    this.noisePx = opts.noisePx ?? 1.0;     // expected landmark noise, used for weights and the coverage map
  }

  setPose({ position, R, target, up = [0, 1, 0] }) {
    if (position) this.position = position.slice();
    if (R) this.R = orthonormalize(R.slice());
    else if (target) this.R = lookRotation(this.position, target, up);
    return this;
  }

  // Pose as the calibration files store it: R maps world -> camera, t = -R * position.
  get t() { const Rc = matVec(this.R, this.position); return [-Rc[0], -Rc[1], -Rc[2]]; }
  setPoseFromRt(R, t) {
    this.R = orthonormalize(R.slice());
    const Rt = transpose(this.R), c = matVec(Rt, t);
    this.position = [-c[0], -c[1], -c[2]];
    return this;
  }

  get forward() { return [this.R[6], this.R[7], this.R[8]]; }
  get right() { return [this.R[0], this.R[1], this.R[2]]; }
  get down() { return [this.R[3], this.R[4], this.R[5]]; }

  worldToCam(p) { return matVec(this.R, sub(p, this.position)); }
  camToWorld(p) { const w = matVec(transpose(this.R), p); return [w[0] + this.position[0], w[1] + this.position[1], w[2] + this.position[2]]; }

  // Brown-Conrady, OpenCV order, on normalised (pinhole) coordinates.
  distortNormalized(x, y) {
    const { k1, k2, k3, p1, p2 } = this.dist;
    if (!k1 && !k2 && !k3 && !p1 && !p2) return [x, y];
    const r2 = x * x + y * y, radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
            y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
  }

  // Fixed-point inverse of the above. Converges in a handful of steps for sane lenses.
  undistortNormalized(xd, yd, iters = 14) {
    const { k1, k2, k3, p1, p2 } = this.dist;
    if (!k1 && !k2 && !k3 && !p1 && !p2) return [xd, yd];
    let x = xd, y = yd;
    for (let i = 0; i < iters; i++) {
      const r2 = x * x + y * y, radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x), dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
      x = (xd - dx) / radial; y = (yd - dy) / radial;
    }
    return [x, y];
  }

  // World point -> pixels. depth is the camera-space Z in mm; inFront is false behind the lens.
  project(p) {
    const c = this.worldToCam(p);
    const inFront = c[2] > 1e-6;
    const z = inFront ? c[2] : 1e-6;
    const [xd, yd] = this.distortNormalized(c[0] / z, c[1] / z);
    const u = this.fx * xd + this.cx, v = this.fy * yd + this.cy;
    return { u, v, depth: c[2], inFront,
             inFrame: inFront && u >= 0 && v >= 0 && u < this.width && v < this.height,
             cam: c };
  }

  // Pixels -> the normalised, undistorted image coordinates the geometry code works in.
  normalized(u, v) { return this.undistortNormalized((u - this.cx) / this.fx, (v - this.cy) / this.fy); }

  // Pixels -> a world-space ray from the lens centre.
  ray(u, v) {
    const [x, y] = this.normalized(u, v);
    const d = matVec(transpose(this.R), [x, y, 1]);
    return { o: this.position.slice(), d: normalize(d) };
  }

  // Pixels + a known camera-space depth -> the world point. unproject(project(p).u, .v, .depth) === p.
  unproject(u, v, depth) {
    const [x, y] = this.normalized(u, v);
    return this.camToWorld([x * depth, y * depth, depth]);
  }

  // 3x4 projection for NORMALISED coordinates (K omitted): rows of [R | t]. Used by the DLT.
  get RT() {
    const t = this.t;
    return [[this.R[0], this.R[1], this.R[2], t[0]],
            [this.R[3], this.R[4], this.R[5], t[1]],
            [this.R[6], this.R[7], this.R[8], t[2]]];
  }

  // Angular size of one pixel at the image centre, in radians — the unit the coverage map reasons in.
  get radPerPx() { return 1 / this.fx; }

  clone(overrides = {}) { return new PinholeCamera({ ...this.toJSON(), ...overrides }); }

  toJSON() {
    return { id: this.id, label: this.label, role: this.role, width: this.width, height: this.height,
             fx: this.fx, fy: this.fy, cx: this.cx, cy: this.cy, dist: { ...this.dist },
             position: this.position.slice(), R: this.R.slice(),
             latencyMs: this.latencyMs, fps: this.fps, noisePx: this.noisePx };
  }
  static fromJSON(j) { return new PinholeCamera(j); }
}

// A camera that looks at a target, the way the simulator and the presets place them.
export function makeCamera({ id, label, role, position, target, up, fovDeg, fovAxis, width = 1280, height = 720, ...rest }) {
  const K = intrinsicsFromFov({ width, height, fovDeg: fovDeg ?? 70, fovAxis: fovAxis ?? 'diagonal' });
  return new PinholeCamera({ id, label, role, position, target, up, ...K, ...rest });
}
