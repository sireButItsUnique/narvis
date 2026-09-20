"""Turning noisy landmarks and patchy depth into a coherent 3D hand.

Pure numpy. No camera, no MediaPipe -- see test_handmodel.py.

The problem this solves: sampling the depth map at each landmark independently
produces a hand whose joints fly apart. A fingertip sits exactly on the
hand/background boundary, so a patch around it contains two surfaces metres
apart, and any per-joint statistic will sometimes pick the wrong one. No
amount of smoothing repairs that afterwards -- a joint 1.5 m behind the hand
is not noise to be averaged away, it is a different object.

The approach here is to stop treating joints as independent measurements:

  * MediaPipe already produces an anatomically coherent metric hand
    (`hand_world_landmarks`). That model has no idea *where* the hand is, but
    it knows what a hand is shaped like.
  * The depth map knows where the hand is -- reliably at the palm, which is
    broad and fronto-parallel, and unreliably at the fingers.
  * X and Y from the pixel are accurate everywhere.

So: anchor the model at the measured palm depth, and accept a measured joint
depth only when it agrees with where the model says that joint should be.
A joint that disagrees is rejected rather than averaged, because the
alternative -- the model's own estimate -- is anatomically right by
construction even when it is not perfectly accurate.
"""

from __future__ import annotations

import math
from typing import Optional, Sequence, Tuple

import numpy as np

__all__ = [
    "MultiOneEuro", "DepthSignEstimator", "model_relative_depth",
    "reconstruct_hand", "bone_lengths", "PALM_IDX", "BONES",
]

PALM_IDX = (0, 5, 9, 13, 17)

BONES = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
]


class MultiOneEuro:
    """One Euro filter over an array of shape (N, K), component-wise.

    Used for the 21 landmark pixels and again for the 21 reconstructed 3D
    joints. Filtering the landmarks *before* they are turned into 3D matters
    more than filtering afterwards: pixel jitter becomes depth error through
    the projection, so smoothing late means smoothing something that has
    already been corrupted.
    """

    def __init__(self, shape: Tuple[int, int], min_cutoff: float = 1.0,
                 beta: float = 0.0, d_cutoff: float = 1.0, max_dt: float = 0.15,
                 together: bool = False):
        # together: ONE gain for every element, set by how fast the points are moving as a group,
        # instead of one per coordinate. Per-coordinate gains give the two ends of a bone different
        # lags whenever they move differently, so a filtered hand telescopes as it turns or curls --
        # 5% of a bone's length typically and 40% at worst on a recording of the rig. With one gain
        # the output is a blend of two hands by one weight, and a hand that only moved stays a hand.
        self.together = together
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.max_dt = max_dt
        self.shape = shape
        self._x: Optional[np.ndarray] = None
        self._dx = np.zeros(shape)
        self._t: Optional[float] = None

    def reset(self) -> None:
        self._x = None
        self._t = None
        self._dx = np.zeros(self.shape)

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2.0 * math.pi * np.maximum(cutoff, 1e-6))
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x: np.ndarray, t: float) -> np.ndarray:
        x = np.asarray(x, dtype=np.float64)
        if self._x is None or self._t is None:
            self._x, self._t = x.copy(), t
            return x
        dt = t - self._t
        if dt <= 0.0 or dt > self.max_dt:
            self._x, self._t, self._dx = x.copy(), t, np.zeros(self.shape)
            return x
        a_d = self._alpha(self.d_cutoff, dt)
        dx = (x - self._x) / dt
        self._dx = a_d * dx + (1.0 - a_d) * self._dx
        if self.together:
            speed = float(np.median(np.linalg.norm(self._dx, axis=-1)))
            a = self._alpha(self.min_cutoff + self.beta * speed, dt)
        else:
            a = self._alpha(self.min_cutoff + self.beta * np.abs(self._dx), dt)
        self._x = a * x + (1.0 - a) * self._x
        self._t = t
        return self._x.copy()


class DepthShapeFilter:
    """Steadies each joint's depth RELATIVE TO THE PALM, and nothing else.

    A joint's position is its ray times its depth. The ray comes from one
    landmark in one image and is good to a fraction of a millimetre; the depth
    comes from the DIFFERENCE between two landmarkers' opinions, or from a model,
    and is the noisy number by an order of magnitude. On a recording of the rig,
    four frames in ten had some joint leap 2-5 cm relative to the palm with no
    matching movement in the image -- and eight tenths of each leap lay along
    the lens axis. Filtering the finished 3D point treats both directions alike:
    hard enough to stop those leaps, it smears sideways motion that was never
    wrong.

    So the depth is filtered before the point is made. The palm's own depth is
    left alone (it has a tracker: palmtrack.PalmTracker); each joint's offset from
    it goes through a three-frame median, which a single wild frame cannot move,
    and then a One Euro filter slow enough to hold a resting finger still and
    quick enough to follow one that is really curling toward the lens.
    """

    def __init__(self, n: int = 21, min_cutoff: float = 1.0, beta: float = 12.0, max_dt: float = 0.25):
        self._euro = MultiOneEuro((n, 1), min_cutoff=min_cutoff, beta=beta, max_dt=max_dt)
        self._last: list = []
        self._t: Optional[float] = None
        self.max_dt = max_dt

    def reset(self) -> None:
        self._euro.reset()
        self._last, self._t = [], None

    def __call__(self, depths: np.ndarray, t: float, palm_idx=PALM_IDX) -> np.ndarray:
        d = np.asarray(depths, dtype=np.float64)
        palm = float(np.mean(d[list(palm_idx)]))
        rel = d - palm
        if self._t is None or t - self._t > self.max_dt or t <= self._t:
            self._last = []
            self._euro.reset()
        self._t = t
        self._last = (self._last + [rel])[-3:]
        med = np.median(np.stack(self._last), axis=0) if len(self._last) == 3 else rel
        return palm + self._euro(med[:, None], t)[:, 0]


class DepthSignEstimator:
    """Works out which way MediaPipe's world-landmark z axis points.

    The documented convention is that larger z is further from the camera,
    the opposite of this project's +Z-toward-camera frame, so the model's
    depths need negating. Getting that backwards would turn every hand
    inside out -- fingers behind the palm instead of in front -- which is
    exactly the kind of silent, systematic error worth measuring rather than
    assuming. So the sign is decided by correlating the model's relative
    depths against measured ones, and the documented value is only the
    starting assumption.
    """

    def __init__(self, min_joints: int = 6, confident_after: float = 20.0):
        self.min_joints = min_joints
        self.confident_after = confident_after
        self.evidence = 0.0
        self.samples = 0

    def observe(self, model_rel: np.ndarray, measured_rel: np.ndarray) -> None:
        ok = np.isfinite(model_rel) & np.isfinite(measured_rel)
        if int(ok.sum()) < self.min_joints:
            return
        a, b = model_rel[ok], measured_rel[ok]
        a, b = a - a.mean(), b - b.mean()
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na < 1e-6 or nb < 1e-6:
            return
        corr = float(a @ b / (na * nb))
        self.evidence = self.evidence * 0.98 + corr      # decays, so it adapts
        self.samples += 1

    @property
    def sign(self) -> float:
        # Nothing short of confidence overturns the documentation. Evidence is
        # a decaying sum, so on correlations that are pure noise it wanders a
        # few units either side of zero indefinitely -- any lower bar is one
        # it will eventually cross, and crossing it turns the hand inside out.
        if not self.confident:
            return -1.0                                  # documented convention
        return 1.0 if self.evidence > 0 else -1.0

    @property
    def confident(self) -> bool:
        return abs(self.evidence) >= self.confident_after


def model_relative_depth(world_landmarks: np.ndarray, sign: float = -1.0) -> np.ndarray:
    """Per-joint depth offset from the palm, in metres, in this project's frame.

    `world_landmarks` is MediaPipe's metric hand: anatomically coherent, origin
    near the hand's centre, no idea where the hand actually is.
    """
    w = np.asarray(world_landmarks, dtype=np.float64)
    palm_z = float(np.mean(w[list(PALM_IDX), 2]))
    return sign * (w[:, 2] - palm_z)


def bone_lengths(joints: np.ndarray) -> np.ndarray:
    j = np.asarray(joints, dtype=np.float64)
    return np.array([np.linalg.norm(j[b] - j[a]) for a, b in BONES])


def reconstruct_hand(pixels: Sequence, intr, palm_z: float,
                     measured_z: Optional[np.ndarray],
                     model_rel_z: Optional[np.ndarray],
                     depth_tol: float = 0.045) -> np.ndarray:
    """(21, 3) joints in the camera frame.

    `measured_z` may contain NaN for joints the depth map could not resolve,
    which is normal and expected. A measured depth is used only when it lands
    within `depth_tol` of where the model says the joint should be; 45 mm is
    wider than this camera's depth noise on a hand and far narrower than the
    metre-scale errors a background latch produces.

    X and Y always come from the pixel ray, which is accurate regardless of
    how the depth was decided.
    """
    fx, fy, cx, cy = intr
    px = np.asarray(pixels, dtype=np.float64)
    n = len(px)

    expected = np.full(n, float(palm_z))
    if model_rel_z is not None:
        rel = np.asarray(model_rel_z, dtype=np.float64)
        expected = expected + np.where(np.isfinite(rel), rel, 0.0)

    z = expected.copy()
    if measured_z is not None:
        m = np.asarray(measured_z, dtype=np.float64)
        use = np.isfinite(m) & (np.abs(m - expected) <= depth_tol)
        z = np.where(use, m, expected)

    d = -z
    bad = d <= 0.05
    d = np.where(bad, max(-float(palm_z), 0.05), d)
    z = np.where(bad, float(palm_z), z)

    out = np.empty((n, 3), dtype=np.float64)
    out[:, 0] = (px[:, 0] - cx) * d / fx
    out[:, 1] = -(px[:, 1] - cy) * d / fy
    out[:, 2] = z
    return out


def palm_anchor(measured_z: np.ndarray,
                fallback: Optional[float] = None) -> Optional[float]:
    """Depth to hang the model on: the median of whichever palm joints resolved.

    The palm is used rather than the whole hand because it is broad and roughly
    fronto-parallel -- the one part of a hand a stereo matcher handles well.
    """
    m = np.asarray(measured_z, dtype=np.float64)[list(PALM_IDX)]
    m = m[np.isfinite(m)]
    if len(m) == 0:
        return fallback
    return float(np.median(m))
