"""The palm's distance from the lens, carried from frame to frame.

Pure numpy. No camera, no MediaPipe -- see test_palmtrack.py.

Until this existed the hand's distance was worked out from scratch on every
frame, from whatever that frame happened to offer, and the offers are wildly
unequal. Measured on a recording of the rig:

    both lenses, triangulated     good to a few millimetres
    the depth map, gated          as good, when it is on the hand -- and it says
                                  nothing about WHOSE surface it is reading
    the hand's apparent size      off by a quarter, and by a different quarter on
                                  the next frame: 29 cm, 47 cm, 40 cm, for a hand
                                  that had not moved

A third of the frames had only the last of these, so the hand leapt centimetres
toward and away from the lens two or three times a second -- and every leap
stretched or shrank the drawn hand, because a joint's position is its ray times
that distance. That, not pixel noise, was the jitter.

A hand cannot do that. It has mass; between two frames it is where it was, plus
where it was going. So the distance is a STATE (distance and its rate of change,
a constant-velocity Kalman filter with a little drag) and each frame's offers are
measurements of it, weighed by how good each kind really is. A precise
measurement moves it at once -- this is not a smoother, and adds almost no lag
while both lenses have the hand. A poor one barely moves it, which is exactly
"assume the hand is where it was". And one that is wildly off -- the depth map
reading the forearm, a mis-paired frame -- is refused outright... unless it keeps
insisting, in which case the state was wrong and gives way.
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

__all__ = ["PalmTracker", "ShapeMemory"]


class PalmTracker:
    """Distance of the palm (metres, positive) and its rate, from unequal measurements.

    accel      how hard a hand is assumed able to accelerate along the lens axis (m/s^2): sets how
               fast the uncertainty grows between measurements, so how readily it follows.
    blind      the same, for frames with no triangulation. Much smaller, on purpose: with only a
               guess to go on, the hand is taken to be about where it was rather than chased after
               the guess -- a quarter of a second of real motion toward the lens is lost that way,
               and several centimetres of shake with it.
    drag       seconds for the carried velocity to die away: a hand that was moving in is not
               assumed to keep moving in for a second. `blind_drag` is the same with no triangulation,
               and much shorter -- the velocity, and the doubt about it, are dropped almost at once,
               or that doubt alone lets the position's uncertainty balloon to centimetres within three
               frames and any wrong reading the map offers walks straight in.
    gate       a measurement more than this many sigmas from the prediction is refused...
    insist     ...unless that has now gone on for this long (seconds): then it is the state that
               was wrong, and it restarts from the measurement.
    max_age    with nothing at all for this long, forget: it is another hand, or another place.
    """

    def __init__(self, accel: float = 4.0, blind: float = 0.3, drag: float = 0.35, blind_drag: float = 0.06,
                 gate: float = 3.5, insist: float = 0.30, max_age: float = 1.0):
        self.accel, self.blind, self.drag, self.blind_drag = accel, blind, drag, blind_drag
        self.gate, self.insist, self.max_age = gate, insist, max_age
        self.reset()

    def reset(self) -> None:
        self.x = np.zeros(2)                       # distance, rate
        self.P = np.eye(2)
        self.t: Optional[float] = None
        self._refused_since: Optional[float] = None
        self._accepted = -1e9

    @property
    def ready(self) -> bool:
        return self.t is not None

    # ---- time ----------------------------------------------------------------

    def _advance(self, t: float, accel: float, drag: float) -> None:
        dt = float(np.clip(t - self.t, 0.0, self.max_age))
        keep = float(np.exp(-dt / drag))
        F = np.array([[1.0, dt], [0.0, keep]])
        q = accel ** 2
        Q = q * np.array([[dt ** 4 / 4, dt ** 3 / 2], [dt ** 3 / 2, dt ** 2]])
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + Q
        self.t = t

    def predict(self, t: float) -> Optional[Tuple[float, float]]:
        """(distance, sigma) expected at time t, without changing anything; None if there is no
        state or it is too old to speak."""
        if self.t is None or t - self.t > self.max_age:
            return None
        dt = max(t - self.t, 0.0)
        keep = float(np.exp(-dt / self.blind_drag))
        F = np.array([[1.0, dt], [0.0, keep]])
        q = self.blind ** 2                        # a forecast is made without knowing what will arrive
        P = F @ self.P @ F.T + q * np.array([[dt ** 4 / 4, dt ** 3 / 2], [dt ** 3 / 2, dt ** 2]])
        return float((F @ self.x)[0]), float(np.sqrt(max(P[0, 0], 0.0)))

    # ---- measurements -----------------------------------------------------------

    def _fuse(self, d: float, s: float) -> bool:
        """Fold one measurement in, unless it is more than `gate` sigmas from what was expected."""
        innov = d - self.x[0]
        S = self.P[0, 0] + s ** 2
        if innov ** 2 > self.gate ** 2 * S:
            return False
        K = self.P[:, 0] / S
        self.x = self.x + K * innov
        self.P = self.P - np.outer(K, self.P[0, :])
        return True

    def update(self, t: float, hard=None, soft=()) -> Tuple[Optional[float], float]:
        """One frame.

        hard   (distance, sigma) from TRIANGULATION, or None. The one measurement that knows it is
               looking at the hand, so the one allowed to overturn the state: refused while it is an
               outlier, obeyed once it has insisted for `insist` seconds.
        soft   [(distance, sigma), ...] from the depth map and from apparent size. They may agree with
               the state and sharpen it; they may never overturn it -- the map does not know whose
               surface it is reading (past 30 cm it is as likely the forearm), and size is a guess.

        Returns (distance, sigma) as now believed, or (None, nan) with nothing to believe.
        """
        def good(m):
            return m is not None and np.isfinite(m[0]) and np.isfinite(m[1]) and m[1] > 0 and m[0] > 0

        hard = (float(hard[0]), float(hard[1])) if good(hard) else None
        soft = [(float(d), float(s)) for d, s in soft if good((d, s))]
        if self.t is not None and (t - self.t > self.max_age or t - self._accepted > self.max_age):
            self.reset()                             # too long with nothing believable: start again
        if self.t is None:
            first = hard or (soft[0] if soft else None)
            if first is None:
                return None, float("nan")
            self.x, self.P = np.array([first[0], 0.0]), np.diag([first[1] ** 2, 0.25])
            self.t = self._accepted = t
            return first
        if hard is not None:
            self._advance(t, self.accel, self.drag)
        else:
            self._advance(t, self.blind, self.blind_drag)
        if hard is not None:
            if self._fuse(*hard):
                self._refused_since, self._accepted = None, t
            else:
                self._refused_since = t if self._refused_since is None else self._refused_since
                if t - self._refused_since >= self.insist:
                    self.x, self.P = np.array([hard[0], 0.0]), np.diag([hard[1] ** 2, 0.25])
                    self._refused_since, self._accepted = None, t
        for m in soft:
            if self._fuse(*m):
                self._accepted = t
        return float(self.x[0]), float(np.sqrt(max(self.P[0, 0], 0.0)))


class ShapeMemory:
    """Each joint's depth relative to the palm, as triangulation last measured it.

    Two things know how the fingers sit in depth. MediaPipe's metric hand knows on
    every frame, in one view, and follows the fingers as they curl. Triangulation
    knows only while both lenses have the joint -- but it is the one that is RIGHT
    about this hand on this rig. On a recording they differed by a median 24 mm
    per joint (9 cm at worst), steadily, the same way from frame to frame: not
    noise, a standing disagreement about the pose.

    The solver used to be handed both, afresh, every frame, and whichever joints
    happened to triangulate took one answer while the rest took the other. So a
    joint leapt by the size of the disagreement every time its triangulation came
    or went: 2-5 cm relative to the palm, on FOUR FRAMES IN TEN.

    This keeps the difference. While a joint triangulates well, the gap between
    the two is tracked (a short low-pass); the model's depth PLUS that remembered
    gap is then the prior the solver is given for it -- on the frames it
    triangulates (where it changes nothing much) and on the frames it does not
    (where the joint now stays where triangulation last put it, and still follows
    the model as the finger moves). A gap that has not been refreshed for a while
    fades out, and the prior's sigma widens back to "this is only the model".
    """

    def __init__(self, n: int = 21, tau: float = 0.12, fresh: float = 0.5, fade: float = 1.5,
                 max_sigma: float = 0.012, tight: float = 0.008, loose: float = 0.030):
        self.tau, self.fresh, self.fade, self.max_sigma = tau, fresh, fade, max_sigma
        self.tight, self.loose = tight, loose
        self.gap = np.zeros(n)
        self.seen = np.full(n, -1e9)

    def reset(self) -> None:
        self.gap[:] = 0.0
        self.seen[:] = -1e9

    def observe(self, d_tri, sig_tri, model_far, t: float, palm_idx=(0, 5, 9, 13, 17)) -> None:
        """A frame with triangulation. `model_far` is the model's depth of each joint relative to
        the palm, + = further from the lens."""
        d = np.asarray(d_tri, dtype=np.float64)
        sg = np.asarray(sig_tri, dtype=np.float64)
        palm = d[list(palm_idx)]
        if int(np.isfinite(palm).sum()) < 3:
            return
        rel = d - float(np.nanmedian(palm))
        good = np.isfinite(rel) & np.isfinite(sg) & (sg <= self.max_sigma)
        want = rel - np.asarray(model_far, dtype=np.float64)
        dt = np.maximum(t - self.seen, 0.0)
        k = np.where(dt > self.fade, 1.0, 1.0 - np.exp(-np.minimum(dt, 10.0) / self.tau))
        self.gap = np.where(good, self.gap + (want - self.gap) * k, self.gap)
        self.seen = np.where(good, t, self.seen)

    def prior(self, palm_d: float, model_far, t: float):
        """(prior depths, prior sigmas) for the solver: the model, corrected by what is remembered."""
        age = t - self.seen
        w = np.clip((self.fade - age) / max(self.fade - self.fresh, 1e-6), 0.0, 1.0)
        depth = palm_d + np.asarray(model_far, dtype=np.float64) + w * self.gap
        return depth, self.loose - w * (self.loose - self.tight)
