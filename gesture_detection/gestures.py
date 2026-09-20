"""Gesture detectors operating on metric 3D points and timestamps.

Deliberately free of camera, OpenCV and MediaPipe imports: everything here is
geometry over (position, time), which makes it testable on synthetic
trajectories without a ZED attached. See test_gestures.py.

Coordinate convention (ZED COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP):
    +X  right in the camera image
    +Y  up
    +Z  toward the camera   (so scene points in front of it have negative Z)

Swipe directions are therefore named from the *camera's* point of view:
RIGHT means "moves right in the video feed", which is the subject's left if
they are facing the camera. Pass mirror_x=True to swap them.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional, Tuple

import numpy as np

#: Position-smoothing presets, selectable with --smoothing.
#:
#: Measured on a stationary hand with anisotropic noise (2 mm in X/Y from
#: pixels, 8 mm in Z from disparity) and 5% bad-depth samples. X RMS error /
#: worst excursion / when a 250 ms swipe reaches 90% of its travel:
#:
#:   no stabilisation   52.5 mm   469 mm   250 ms
#:   responsive         14.1 mm   102 mm   250 ms
#:   balanced            0.6 mm     3 mm   267 ms
#:   steady              0.6 mm     3 mm   300 ms
#:
#: Two mechanisms, contributing separately: rejecting lone impulses does most
#: of the work (52 -> 14 mm), the median tap finishes it (14 -> 0.6 mm). All
#: three presets still detect a standard swipe, which is the constraint that
#: matters -- see test_every_smoothing_preset_still_detects_a_swipe.
SMOOTHING_PRESETS = {
    "responsive": dict(min_cutoff=1.5, beta=6.0, median_taps=1, vel_deadband=0.02),
    "balanced": dict(min_cutoff=1.0, beta=4.0, median_taps=3, vel_deadband=0.03),
    "steady": dict(min_cutoff=0.6, beta=2.0, median_taps=5, vel_deadband=0.05),
}

__all__ = [
    "OneEuroFilter", "Vec3Filter", "SMOOTHING_PRESETS",
    "PinchEvent", "SwipeEvent", "PresenceEvent", "HandState",
    "PinchTracker", "SwipeDetector", "HandTracker", "OneHand",
    "pinch_gaps", "fuse_gaps", "tracking_confidence",
]


# --------------------------------------------------------------------------
# filtering
# --------------------------------------------------------------------------

class OneEuroFilter:
    """Adaptive low-pass: steady when the signal is still, low-lag when it
    moves. A fixed-width moving average cannot do both, and hand tracking
    needs both -- a held pose must not jitter, a fast swipe must not lag."""

    # max_dt: a gap longer than this means the history is stale. At 60 Hz it is
    # nine missed frames; blending a position that old into the new one drags
    # the estimate backwards, which showed up as a bridged swipe measuring
    # 26 cm of an actual 30 cm.
    def __init__(self, min_cutoff: float = 1.2, beta: float = 0.08,
                 d_cutoff: float = 1.0, max_dt: float = 0.15):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.max_dt = max_dt
        self._x_prev: Optional[float] = None
        self._dx_prev = 0.0
        self._t_prev: Optional[float] = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def reset(self) -> None:
        self._x_prev = None
        self._t_prev = None
        self._dx_prev = 0.0

    def __call__(self, x: float, t: float) -> float:
        if self._x_prev is None or self._t_prev is None:
            self._x_prev, self._t_prev = x, t
            return x
        dt = t - self._t_prev
        if dt <= 0.0 or dt > self.max_dt:   # first frame after a dropout: restart
            self._x_prev, self._t_prev, self._dx_prev = x, t, 0.0
            return x
        a_d = self._alpha(self.d_cutoff, dt)
        dx_hat = a_d * ((x - self._x_prev) / dt) + (1.0 - a_d) * self._dx_prev
        a = self._alpha(self.min_cutoff + self.beta * abs(dx_hat), dt)
        x_hat = a * x + (1.0 - a) * self._x_prev
        self._x_prev, self._dx_prev, self._t_prev = x_hat, dx_hat, t
        return x_hat


class Vec3Filter:
    """Per-axis One Euro plus a velocity estimate.

    Velocity is differentiated from the *filtered* position and then smoothed
    again with a short exponential window; differentiating raw stereo points
    produces a signal dominated by depth noise.
    """

    # beta is in (cutoff Hz) per (m/s); with metre-scale positions it has to be
    # several units to matter at all. At 4.0 a hand moving 0.5 m/s lags 1.3 cm
    # instead of the 5.7 cm that a near-zero beta gives, while a resting hand
    # still sits at the 1 Hz minimum cutoff and stays rock steady.
    def __init__(self, min_cutoff: float = 1.0, beta: float = 4.0,
                 d_cutoff: float = 1.0, vel_tau: float = 0.06,
                 max_dt: float = 0.15, median_taps: int = 3,
                 max_step_speed: float = 5.0, vel_deadband: float = 0.03,
                 z_scale: float = 0.5):
        # Z gets a lower cutoff than X and Y. X and Y come from pixel
        # coordinates and are precise; Z comes from disparity or a depth map
        # and carries error that grows as Z^2. Filtering all three identically
        # means either X/Y lag for no reason or Z stays noisy.
        self._f = [OneEuroFilter(min_cutoff, beta, d_cutoff, max_dt),
                   OneEuroFilter(min_cutoff, beta, d_cutoff, max_dt),
                   OneEuroFilter(min_cutoff * z_scale, beta * z_scale,
                                 d_cutoff, max_dt)]
        self._vel_tau = vel_tau
        self._max_dt = max_dt
        self._median_taps = max(1, median_taps)
        self._raw: Deque[np.ndarray] = deque(maxlen=self._median_taps)
        self._max_step_speed = max_step_speed
        self._vel_deadband = vel_deadband
        self._held: Optional[np.ndarray] = None   # a rejected outlier, pending
        self._p_prev: Optional[np.ndarray] = None
        self._t_prev: Optional[float] = None
        self.position: Optional[np.ndarray] = None
        self.velocity = np.zeros(3)

    def reset(self) -> None:
        for f in self._f:
            f.reset()
        self._p_prev = None
        self._t_prev = None
        self._raw.clear()
        self._held = None
        self.position = None
        self.velocity = np.zeros(3)

    def update(self, p: np.ndarray, t: float) -> Tuple[np.ndarray, np.ndarray]:
        p = np.asarray(p, dtype=np.float64)

        gap = self._t_prev is None or (t - self._t_prev) > self._max_dt
        if gap:
            # samples from before a dropout must not be medianed with samples
            # from after it -- they describe different moments
            self._raw.clear()
            self._held = None

        # Reject a lone impulse. One Euro alone cannot: a spike looks exactly
        # like fast motion, so the filter widens its cutoff and passes it
        # through. A second jump in the same direction is real -- the hand was
        # re-acquired somewhere else -- so only the first is held back.
        if not gap and self._raw and self._t_prev is not None:
            step = float(np.linalg.norm(p - self._raw[-1])) / max(t - self._t_prev, 1e-6)
            if step > self._max_step_speed and self._held is None:
                self._held = p
                return (self.position if self.position is not None else p,
                        self.velocity)

        self._held = None
        self._raw.append(p)
        # median across the last few raw samples, per axis: kills single-frame
        # outliers before they ever reach the smoother
        src = (np.median(np.array(self._raw), axis=0)
               if len(self._raw) >= self._median_taps else p)

        f = np.array([self._f[i](float(src[i]), t) for i in range(3)])
        if self._p_prev is not None and self._t_prev is not None:
            dt = t - self._t_prev
            if 0.0 < dt <= self._max_dt:
                v = (f - self._p_prev) / dt
                a = dt / (self._vel_tau + dt)
                self.velocity = a * v + (1.0 - a) * self.velocity
            else:
                self.velocity = np.zeros(3)
        # a resting hand should read as resting, not as drifting slowly
        if float(np.linalg.norm(self.velocity)) < self._vel_deadband:
            self.velocity = np.zeros(3)
        self._p_prev, self._t_prev = f, t
        self.position = f
        return f, self.velocity

    @property
    def speed(self) -> float:
        return float(np.linalg.norm(self.velocity))


# --------------------------------------------------------------------------
# events
# --------------------------------------------------------------------------

@dataclass
class PinchEvent:
    kind: str                         # "PINCH_IN" | "PINCH_OUT"
    hand: str
    t: float
    duration: float                   # how long the open<->closed transition took
    gap_mm: float
    position: Optional[np.ndarray]    # midpoint of the two fingertips, metres

    def to_dict(self) -> dict:
        return {
            "event": self.kind, "hand": self.hand, "t": round(self.t, 4),
            "duration_ms": round(self.duration * 1000.0, 1),
            "gap_mm": round(self.gap_mm, 1),
            "xyz_m": _xyz(self.position),
        }


@dataclass
class SwipeEvent:
    kind: str                         # always "SWIPE"
    hand: str
    t: float
    direction: str                    # LEFT RIGHT UP DOWN TOWARD AWAY
    axis: int                         # 0=X 1=Y 2=Z
    distance: float                   # net displacement, metres
    peak_speed: float                 # m/s
    duration: float                   # seconds spanned by the trajectory window
    straightness: float               # net / path length, 1.0 == perfectly straight
    start: np.ndarray
    end: np.ndarray
    bridged: bool = False             # inferred across a tracking dropout

    def to_dict(self) -> dict:
        return {
            "event": self.kind, "hand": self.hand, "t": round(self.t, 4),
            "direction": self.direction,
            "distance_m": round(self.distance, 4),
            "peak_speed_mps": round(self.peak_speed, 3),
            "duration_ms": round(self.duration * 1000.0, 1),
            "straightness": round(self.straightness, 3),
            "bridged": self.bridged,
            "from_m": _xyz(self.start), "to_m": _xyz(self.end),
        }


@dataclass
class PresenceEvent:
    kind: str                         # "HAND_FOUND" | "HAND_LOST"
    hand: str
    t: float
    position: Optional[np.ndarray] = None

    def to_dict(self) -> dict:
        return {"event": self.kind, "hand": self.hand, "t": round(self.t, 4),
                "xyz_m": _xyz(self.position)}


@dataclass
class HandState:
    """Continuous per-frame state, for streaming rather than event handling."""
    hand: str
    t: float
    position: Optional[np.ndarray]
    velocity: np.ndarray
    speed: float
    pinch_gap: float                  # normalised, hand-size independent
    pinch_strength: float             # 0 open .. 1 closed
    pinched: bool

    def to_dict(self) -> dict:
        return {
            "event": "HAND_STATE", "hand": self.hand, "t": round(self.t, 4),
            "xyz_m": _xyz(self.position),
            "vel_mps": _xyz(self.velocity),
            "speed_mps": round(self.speed, 3),
            "pinch": round(self.pinch_strength, 3),
            "pinched": self.pinched,
        }


def _xyz(v) -> Optional[list]:
    if v is None:
        return None
    return [round(float(c), 4) for c in v]


# --------------------------------------------------------------------------
# pinch
# --------------------------------------------------------------------------

_WRIST, _THUMB_TIP, _INDEX_TIP, _MIDDLE_MCP, _MIDDLE_TIP = 0, 4, 8, 9, 12


def pinch_gaps(landmarks) -> Tuple[float, float]:
    """(pinch, grab): two thumb-to-fingertip gaps, each as a fraction of the
    palm's length (wrist to middle knuckle), from any 21 metric landmarks.

    `pinch` is thumb to INDEX, the gesture. `grab` is thumb to whichever of
    index and middle is nearer, for picking things up: people grab with either,
    and seen from the fingertip end -- which is where this rig's camera sits --
    one of the two is usually hiding behind the other, so the landmarker is
    guessing at it. Asking for the nearer one asks for the one it can see.

    Both are ratios of lengths on the same hand, so neither needs the hand's
    distance; nan when the landmarks are not all there.
    """
    p = np.asarray(landmarks, dtype=float)
    if p.shape != (21, 3) or not np.isfinite(p[[_WRIST, _THUMB_TIP, _INDEX_TIP,
                                                 _MIDDLE_MCP, _MIDDLE_TIP]]).all():
        return float("nan"), float("nan")
    palm = max(float(np.linalg.norm(p[_WRIST] - p[_MIDDLE_MCP])), 1e-4)
    index = float(np.linalg.norm(p[_THUMB_TIP] - p[_INDEX_TIP])) / palm
    middle = float(np.linalg.norm(p[_THUMB_TIP] - p[_MIDDLE_TIP])) / palm
    return index, min(index, middle)


def fuse_gaps(views, solved: float = float("nan")) -> float:
    """One gap from every measurement of it this frame.

    `views` are the landmarker's own metric hands, one per camera view that
    saw THIS hand: two independent looks at the same fingers, so their mean
    halves the noise, and it is rare for both to lose the same fingertip
    behind the thumb. `solved` is the gap on the reconstructed 3D joints. It
    is only ever a referee -- the median of three -- because the thresholds
    were tuned on the landmarker's hand, and the reconstruction's fingertips
    are the joints its depth is least sure of; with fewer than two views there
    is nothing for it to referee, and it is used only if there is nothing else.
    """
    v = [float(g) for g in views if g is not None and np.isfinite(g)]
    if len(v) >= 2 and np.isfinite(solved):
        return float(np.median(v + [float(solved)]))
    if v:
        return float(np.mean(v))
    return float(solved)

@dataclass
class PinchTracker:
    """Hysteresis state machine over the normalised thumb/index gap.

    Times the *transition* between states rather than time spent in a state,
    so holding a pinch for ten seconds still produces a PINCH_OUT on release,
    while a slow drift through the hysteresis band produces nothing.
    """

    hand: str
    close_thresh: float = 0.35
    open_thresh: float = 0.55
    # Measured on live ZED data: real pinches cross the hysteresis band in
    # 180-240 ms -- far slower than the 67 ms a synthetic ramp suggests, which
    # is exactly the trap of tuning on simulated input. Slowly curling the hand
    # shut over two seconds takes ~520 ms. 350 ms sits between the two.
    max_transition: float = 0.35
    refractory: float = 0.35
    stale_after: float = 0.50

    state: str = "open"
    gap_f: float = 1.0
    transition: float = 0.0
    filt: OneEuroFilter = field(default_factory=OneEuroFilter)
    _last_open_t: float = -1e9
    _last_closed_t: float = -1e9
    _last_event_t: float = -1e9
    _last_seen_t: float = -1e9

    def update(self, norm_gap: float, t: float) -> Optional[str]:
        if t - self._last_seen_t > self.stale_after:
            # reappeared after a dropout -- resync silently, do not fire
            self.filt.reset()
            self.state = "open" if norm_gap > self.close_thresh else "closed"
            self._last_open_t = self._last_closed_t = t
        self._last_seen_t = t

        g = self.filt(norm_gap, t)
        self.gap_f = g
        kind: Optional[str] = None

        if self.state == "open" and g < self.close_thresh:
            dt = t - self._last_open_t
            self.state = "closed"
            if dt <= self.max_transition and t - self._last_event_t > self.refractory:
                kind, self.transition = "PINCH_IN", dt
        elif self.state == "closed" and g > self.open_thresh:
            dt = t - self._last_closed_t
            self.state = "open"
            if dt <= self.max_transition and t - self._last_event_t > self.refractory:
                kind, self.transition = "PINCH_OUT", dt

        if kind:
            self._last_event_t = t

        # markers advance *after* the crossing test, so a transition is timed
        # from the last frame unambiguously in the previous state
        if g > self.open_thresh:
            self._last_open_t = t
        if g < self.close_thresh:
            self._last_closed_t = t
        return kind

    @property
    def strength(self) -> float:
        span = self.open_thresh - self.close_thresh
        return float(np.clip((self.open_thresh - self.gap_f) / span, 0.0, 1.0))


# --------------------------------------------------------------------------
# how far to trust this frame's hand
# --------------------------------------------------------------------------

def tracking_confidence(score: float, other_score: Optional[float] = None,
                        n_triangulated: int = 0, n_joints: int = 21) -> float:
    """One number in 0..1 for "how much should this frame's hand be believed",
    for whoever draws the hand to gate on (the rig page holds the last good
    pose while this is under its threshold).

    Two things go into it, multiplied, because either one alone can sink a frame:

      what the landmarker thinks -- its own score for the hand, averaged over
        the views that saw it. It sags toward 0.5 when the hand is half out of
        frame, blurred, or end-on enough to be ambiguous.
      where the DEPTH came from -- with both views paired, the fraction of the
        21 joints that triangulated, mapped to 0.5..1. With one view there is
        no triangulation at all and the hand's distance is a guess from its
        size, good to a few centimetres at best: that alone caps the frame at
        0.5, so a threshold above 0.5 means "both lenses or hold still".

    `other_score` is None when the other view did not see this hand.
    """
    paired = other_score is not None and np.isfinite(other_score)
    view = float(np.mean([score, other_score])) if paired else float(score)
    depth = 0.5 + 0.5 * float(np.clip(n_triangulated / max(n_joints, 1), 0.0, 1.0)) if paired else 0.5
    out = float(np.clip(view, 0.0, 1.0)) * depth
    return out if np.isfinite(out) else 0.0


# --------------------------------------------------------------------------
# swipe
# --------------------------------------------------------------------------

_DIRECTIONS = {
    (0, 1): "RIGHT", (0, -1): "LEFT",
    (1, 1): "UP", (1, -1): "DOWN",
    (2, 1): "TOWARD", (2, -1): "AWAY",
}


@dataclass
class SwipeDetector:
    """Sliding-window trajectory classifier.

    A swipe is a short burst of fast, straight, axis-dominant travel. All four
    conditions are needed: speed alone fires on a flinch, distance alone fires
    on any slow reach across the frame, and without a dominance and
    straightness test every diagonal wave becomes an ambiguous LEFT-or-UP.
    """

    hand: str
    window: float = 0.35              # seconds of trajectory considered
    min_speed: float = 0.55           # m/s, peak within the window
    # Kept at 14 cm after reviewing live logs: rejections at 11-13 cm were
    # always followed within ~50 ms by a successful fire on the same gesture,
    # so nothing was actually being missed, while 12 cm admits a 6 cm-radius
    # stirring motion as a swipe.
    min_travel: float = 0.14          # m, net displacement
    min_dominance: float = 1.5        # primary axis vs next largest
    # 0.70, not 0.75: live logs rejected genuine fast swipes at 0.73, where
    # the path noise comes from the motion itself
    min_straightness: float = 0.70    # net / path length
    refractory: float = 0.50
    rearm_speed: float = 0.25         # must slow below this to fire again
    # 5 m/s: a vigorous arm swing peaks near 4. Above it the tracked point did
    # not move, its depth estimate did -- which live produced 7.9 m/s "swipes".
    max_speed: float = 5.0            # m/s; above this the track jumped, see feed()
    # A hand that is moving fast enough to swipe is also moving fast enough to
    # motion-blur out of the landmarker's reach. The dropout is not noise, it
    # is evidence: see _try_bridge.
    gap_min: float = 0.06             # below this it is one dropped frame
    gap_max: float = 0.45             # above this, too long to assume one motion
    # A bridge compares two isolated samples, so it inherits whatever the depth
    # estimate was doing at each end. Across a dropout that estimate can change
    # source entirely (size-bootstrap to real stereo), and the jump reads as
    # motion along Z -- observed live as a 64 cm "SWIPE TOWARD" from a hand
    # that had just appeared. Bridge only in the image plane, where position
    # comes from pixels, and cap the distance at something an arm can do.
    bridge_lateral_only: bool = True
    bridge_max_travel: float = 0.60
    # A wave reverses every ~0.2 s; a person deliberately swiping again first
    # returns their hand, which takes longer. 0.45 s splits them. Longer than
    # this and testing the gesture by swiping back and forth silently
    # suppresses everything after the first stroke.
    reversal_guard: float = 0.45
    mirror_x: bool = False            # name LEFT/RIGHT from the subject's side

    _buf: Deque[Tuple[float, np.ndarray]] = field(default_factory=deque)
    _armed: bool = True
    _last_event_t: float = -1e9
    _last_dir: Optional[Tuple[int, int]] = None
    _last_dir_t: float = -1e9

    # why the most recent frame did not produce a swipe, and the numbers behind
    # it. A gesture detector that silently does nothing is undebuggable from
    # the outside -- every rejection path records which gate stopped it.
    reject: str = "no data"
    stats: dict = field(default_factory=dict)
    _bridge: Optional[Tuple[float, np.ndarray, float, np.ndarray]] = None

    def reset(self) -> None:
        self._buf.clear()
        self._armed = True
        self._last_dir = None
        self._bridge = None

    def _reversal(self, axis: int, sign: int, t: float) -> bool:
        """True if this stroke merely undoes the previous one.

        Waving is a run of alternating strokes, each of which is individually
        straight, fast and long enough to look exactly like a swipe -- no
        single-window test can separate them. What distinguishes waving is that
        it keeps reversing. Recording every *candidate*, emitted or not, means
        a sustained wave suppresses itself after its first stroke, while
        "swipe right, pause, swipe left" still yields two events.
        """
        return (self._last_dir is not None
                and self._last_dir[0] == axis
                and self._last_dir[1] == -sign
                and t - self._last_dir_t < self.reversal_guard)

    def feed(self, p: np.ndarray, t: float) -> None:
        """Extend the trajectory history without testing for a swipe. Used
        while the gesture is gated off, so that history is already warm the
        moment the gate opens again."""
        p = np.asarray(p, dtype=np.float64)
        if self._buf:
            dt = t - self._buf[-1][0]
            if dt > self.gap_min:
                if dt <= self.gap_max:
                    # the hand vanished and came back somewhere else; remember
                    # the endpoints so the motion can still be judged
                    self._bridge = (self._buf[-1][0], self._buf[-1][1].copy(),
                                    t, p.copy())
                # A dropout breaks the trajectory. Samples from before it can
                # still be inside the time window, and leaving them there lets
                # the ordinary windowed path report a gap-crossing jump as a
                # normal swipe -- with none of the bridge's safeguards, which
                # is how a depth-estimate jump became a 64 cm "SWIPE TOWARD".
                self._buf.clear()
        if self._buf and t <= self._buf[-1][0]:
            # same frame delivered twice (two detections sharing one handedness
            # label). Appending would put a zero dt in the buffer and divide a
            # real displacement by it -- once observed as a 367,805 m/s swipe.
            self._buf[-1] = (t, p)
        else:
            self._buf.append((t, p))

        # Discontinuity check, applied whichever branch ran above. A hand
        # cannot move this fast, so the tracked point did not move -- its
        # identity changed, e.g. a handedness label swapping between two
        # people's hands. Treat it as the start of a new track.
        if len(self._buf) >= 2:
            t_prev, p_prev = self._buf[-2]
            if float(np.linalg.norm(p - p_prev)) / max(t - t_prev, 1e-6) > self.max_speed:
                self._buf.clear()
                self._buf.append((t, p))
        while self._buf and t - self._buf[0][0] > self.window:
            self._buf.popleft()

    def _try_bridge(self, t: float, speed: float) -> Optional[SwipeEvent]:
        """Judge a swipe from the two samples either side of a tracking gap.

        Observed live: a swipe would motion-blur the hand out of the
        landmarker for ~0.4 s and surface as HAND_LOST / HAND_FOUND instead of
        a gesture. The sliding window cannot help -- its samples have aged out
        by the time the hand returns -- but the two endpoints still describe
        the motion, and a hand that travelled 30 cm while it was invisible was
        unambiguously swiping.

        With only two samples the path length equals the net displacement, so
        straightness is 1.0 by construction rather than by measurement. The
        event is flagged `bridged` so consumers can tell the difference.
        """
        if self._bridge is None:
            return None
        t0, p0, t1, p1 = self._bridge
        self._bridge = None

        if not self._armed or t - self._last_event_t < self.refractory:
            return None
        net = p1 - p0
        travel = float(np.linalg.norm(net))
        dt = max(t1 - t0, 1e-6)
        v = travel / dt
        if travel < self.min_travel or v < self.min_speed:
            self.reject = f"bridge: {travel * 100:.1f} cm at {v:.2f} m/s over {dt * 1000:.0f} ms"
            return None

        if travel > self.bridge_max_travel:
            self.reject = f"bridge: {travel * 100:.0f} cm is too far to be one swipe"
            return None

        order = np.argsort(np.abs(net))[::-1]
        axis = int(order[0])
        if abs(net[axis]) < self.min_dominance * max(float(abs(net[order[1]])), 1e-9):
            self.reject = "bridge: no dominant axis"
            return None
        if self.bridge_lateral_only and axis == 2:
            self.reject = "bridge: depth-dominant, most likely a depth estimate jump"
            return None

        sign = 1 if net[axis] > 0 else -1
        reversing = self._reversal(axis, sign, t)
        self._last_dir, self._last_dir_t = (axis, sign), t
        if reversing:
            self._armed = False
            self._buf.clear()
            self.reject = "bridge: reversal of the previous stroke"
            return None

        if axis == 0 and self.mirror_x:
            sign = -sign
        self.reject = ""
        self._last_event_t = t
        self._armed = False
        self._buf.clear()
        return SwipeEvent(kind="SWIPE", hand=self.hand, t=t,
                          direction=_DIRECTIONS[(axis, sign)], axis=axis,
                          distance=travel, peak_speed=v, duration=dt,
                          straightness=1.0, start=p0.copy(), end=p1.copy(),
                          bridged=True)

    def update(self, p: np.ndarray, t: float, speed: float) -> Optional[SwipeEvent]:
        self.feed(p, t)

        if not self._armed and speed < self.rearm_speed:
            self._armed = True

        bridged = self._try_bridge(t, speed)
        if bridged is not None:
            return bridged

        if len(self._buf) < 4:
            self.reject = f"only {len(self._buf)} samples"
            return None
        span = self._buf[-1][0] - self._buf[0][0]
        if span < self.window * 0.6:          # not enough history yet
            self.reject = f"window only {span * 1000:.0f} ms"
            return None

        pts = np.array([q for _, q in self._buf])
        ts = np.array([s for s, _ in self._buf])

        net = pts[-1] - pts[0]
        travel = float(np.linalg.norm(net))
        steps = np.diff(pts, axis=0)
        path = float(np.linalg.norm(steps, axis=1).sum())
        dts = np.diff(ts)
        # only steps with a real time base can bound speed; a 1 us dt turns any
        # displacement into a meaningless number
        usable = dts > 1e-3
        peak = (float((np.linalg.norm(steps[usable], axis=1) / dts[usable]).max())
                if usable.any() else travel / max(span, 1e-3))
        straightness = travel / max(path, 1e-9)
        order = np.argsort(np.abs(net))[::-1]
        axis = int(order[0])
        runner_up = float(abs(net[order[1]]))
        dominance = abs(net[axis]) / max(runner_up, 1e-9)

        self.stats = {"travel": travel, "peak": peak, "straight": straightness,
                      "dominance": dominance, "span": span, "n": len(self._buf)}

        # gates are evaluated after the metrics so the diagnostics are populated
        # even on the frames that reject
        if not self._armed:
            self.reject = f"disarmed (speed {speed:.2f} > {self.rearm_speed})"
            return None
        if t - self._last_event_t < self.refractory:
            self.reject = "refractory"
            return None
        if travel < self.min_travel:
            self.reject = f"travel {travel * 100:.1f} < {self.min_travel * 100:.0f} cm"
            return None
        if peak < self.min_speed:
            self.reject = f"peak {peak:.2f} < {self.min_speed} m/s"
            return None
        if straightness < self.min_straightness:
            self.reject = f"straightness {straightness:.2f} < {self.min_straightness}"
            return None
        if dominance < self.min_dominance:
            self.reject = f"dominance {dominance:.2f} < {self.min_dominance}"
            return None

        sign = 1 if net[axis] > 0 else -1
        reversing = self._reversal(axis, sign, t)
        self._last_dir, self._last_dir_t = (axis, sign), t
        if reversing:
            # still consume the stroke, so the follow-through does not re-fire
            self.reject = "reversal of the previous stroke"
            self._armed = False
            self._buf.clear()
            return None

        if axis == 0 and self.mirror_x:
            sign = -sign
        ev = SwipeEvent(
            kind="SWIPE", hand=self.hand, t=t,
            direction=_DIRECTIONS[(axis, sign)], axis=axis,
            distance=travel, peak_speed=peak, duration=span,
            straightness=straightness, start=pts[0].copy(), end=pts[-1].copy(),
        )
        # one gesture, one event: disarm and drop the history that produced it,
        # otherwise the sliding window re-fires on every frame of the follow-through
        self.reject = ""
        self._last_event_t = t
        self._armed = False
        self._buf.clear()
        return ev


# --------------------------------------------------------------------------
# per-hand aggregate
# --------------------------------------------------------------------------

class HandTracker:
    """Position + velocity + pinch + swipe for one hand."""

    def __init__(self, hand: str, *, close: float = 0.35, open_: float = 0.55,
                 max_transition: float = 0.35, pinch_refractory: float = 0.35,
                 swipe_window: float = 0.35, min_speed: float = 0.55,
                 min_travel: float = 0.14, swipe_refractory: float = 0.50,
                 mirror_x: bool = False, swipe_while_pinched: bool = True,
                 smoothing: str = "balanced"):
        self.hand = hand
        self.filt = Vec3Filter(**SMOOTHING_PRESETS.get(
            smoothing, SMOOTHING_PRESETS["balanced"]))
        self.pinch = PinchTracker(hand=hand, close_thresh=close, open_thresh=open_,
                                  max_transition=max_transition,
                                  refractory=pinch_refractory)
        self.swipe = SwipeDetector(hand=hand, window=swipe_window,
                                   min_speed=min_speed, min_travel=min_travel,
                                   refractory=swipe_refractory, mirror_x=mirror_x)
        self.swipe_while_pinched = swipe_while_pinched
        self.position: Optional[np.ndarray] = None
        self.velocity = np.zeros(3)
        self.last_seen: float = -1e9
        # diagnostics: how often the palm had no usable depth, and whether the
        # pinch gate is currently suppressing swipes
        self.position_ok = False
        self.gated = False
        self.frames = 0
        self.frames_no_depth = 0

    def update(self, position: Optional[np.ndarray], norm_gap: float, t: float,
               gap_m: Optional[float] = None,
               tip_mid: Optional[np.ndarray] = None) -> List:
        """One frame. `position` may be None when depth failed for the palm;
        pinch still updates, since it can fall back to monocular landmarks."""
        events: List = []

        if t - self.last_seen > 0.5:       # gap in tracking: do not fire across it
            self.filt.reset()
            self.swipe.reset()
        self.last_seen = t

        kind = self.pinch.update(norm_gap, t)
        if kind:
            # caller passes the metric gap when it has one; otherwise scale the
            # normalised gap by a nominal 95 mm palm so the figure stays readable
            mm = gap_m * 1000.0 if gap_m is not None else norm_gap * 95.0
            events.append(PinchEvent(kind, self.hand, t, self.pinch.transition,
                                     mm, tip_mid))

        self.frames += 1
        self.position_ok = position is not None
        if position is None:
            self.frames_no_depth += 1
            self.swipe.reject = "no palm depth this frame"
        else:
            p, v = self.filt.update(position, t)
            self.position, self.velocity = p, v
            self.gated = not (self.swipe_while_pinched or self.pinch.state == "open")
            if not self.gated:
                ev = self.swipe.update(p, t, self.filt.speed)
                if ev:
                    events.append(ev)
            else:
                # gated off, but keep history warm so a swipe immediately after
                # release is not judged on a half-empty window
                self.swipe.feed(p, t)
                self.swipe.reject = "gated: hand is pinched"

        return events

    def relabel(self, hand: str) -> None:
        """Rename the hand without disturbing anything it has learned."""
        self.hand = self.pinch.hand = self.swipe.hand = hand

    def state(self, t: float) -> HandState:
        return HandState(
            hand=self.hand, t=t, position=self.position, velocity=self.velocity,
            speed=float(np.linalg.norm(self.velocity)),
            pinch_gap=self.pinch.gap_f, pinch_strength=self.pinch.strength,
            pinched=self.pinch.state == "closed",
        )


class OneHand:
    """The one hand being tracked: which detection it is, what it is called,
    and whether it is there.

    There is exactly one track. MediaPipe's handedness label used to be the
    identity, a tracker per label, and that made two hands out of one in two
    ways: the label flickers, so a single hand spent its life split between
    a "Left" tracker and a "Right" one, each with half a trajectory; and the
    two camera views are labelled independently, so when they disagreed the
    same hand was tracked twice in the same frame.

    So identity is where the hand is, not what it is called. A detection is
    the tracked hand if it is where that hand could have got to:

        close by                     -> yes, whatever its label says
        further, within reach of a   -> yes if its label agrees. This is a fast
        fast arm, and not the rival     swipe, or one that blurred the hand out
                                        of the landmarker and back in elsewhere
        anything else                -> no. It becomes the RIVAL, and whatever
                                        follows on from the rival is refused
                                        too, until the tracked hand is lost

    The rival is what makes one track safe. With a tracker per label, a
    landmarker hopping between two hands fed two separate trajectories. With
    one tracker it would feed both hands into the same trajectory, and the
    jump between them is exactly what a swipe looks like -- including to the
    gap-bridge, which exists to believe a hand that vanishes and reappears
    somewhere else. A second hand therefore waits until the first has been
    gone for `lost_after`, which is longer than any gap the bridge will span,
    and then starts a new track with a new tracker.

    The label is decided by a decaying vote over the track's life, so events
    carry a steady name and a single wrong frame cannot change it. When the
    vote does settle the other way the track is renamed in place: same hand,
    same trajectory, no HAND_LOST.

    Positions here are rough lateral ones in metres -- landmarks scaled by
    apparent size -- because identity has to be decided before depth is known.
    """

    def __init__(self, lost_after: float = 0.50, near: float = 0.12,
                 slow: float = 1.0, patience: float = 0.10,
                 max_speed: float = 3.0, label_decay: float = 0.9,
                 relabel_at: float = 2.0, **tracker_kwargs):
        self.lost_after = lost_after
        self.near = near                  # m; two hands closer than this are one
        self.slow = slow                  # m/s allowed without the label agreeing,
        self.patience = patience          #   for at most this long unseen
        self.max_speed = max_speed        # m/s allowed when it does
        self.label_decay = label_decay
        self.relabel_at = relabel_at
        self._kwargs = tracker_kwargs
        self.tracker: Optional[HandTracker] = None
        self._xy: Optional[np.ndarray] = None
        self._t: float = -1e9
        self._rival_xy: Optional[np.ndarray] = None
        self._rival_t: float = -1e9
        self._vote = 0.0                  # > 0 leans Right

    @property
    def present(self) -> bool:
        return self.tracker is not None

    def _within(self, xy, ref_xy, ref_t, t, speed, patience=None) -> bool:
        dt = max(t - ref_t, 0.0)
        if patience is not None:
            dt = min(dt, patience)
        return bool(np.linalg.norm(xy - ref_xy) <= self.near + speed * dt)

    def claim(self, xy, label: str, t: float,
              score: float = 1.0) -> Tuple[bool, Optional[PresenceEvent]]:
        """Offer a detection. Returns (is it the tracked hand, HAND_FOUND or None)."""
        xy = np.asarray(xy, dtype=np.float64)[:2]
        lean = score if label == "Right" else -score

        if self.tracker is None:
            self.tracker = HandTracker(label, **self._kwargs)
            self._xy, self._t, self._vote = xy, t, lean
            self._rival_xy = None
            return True, PresenceEvent("HAND_FOUND", label, t)

        # "Close by" does not grow with absence. A hand that has not been seen
        # for a third of a second could be anywhere -- and so could another one,
        # so past a frame or two only the label can vouch for it.
        mine = self._within(xy, self._xy, self._t, t, self.slow, self.patience)
        if not mine:
            rival = (self._rival_xy is not None and t - self._rival_t <= self.lost_after
                     and self._within(xy, self._rival_xy, self._rival_t, t, self.slow,
                                      self.patience))
            mine = (not rival and label == self.tracker.hand
                    and self._within(xy, self._xy, self._t, t, self.max_speed))
        if not mine:
            self._rival_xy, self._rival_t = xy, t
            return False, None

        self._xy, self._t = xy, t
        self._vote = self._vote * self.label_decay + lean
        leans = "Right" if self._vote > 0 else "Left"
        if leans != self.tracker.hand and abs(self._vote) >= self.relabel_at:
            self.tracker.relabel(leans)
        return True, None

    def sweep(self, t: float) -> List[PresenceEvent]:
        if self.tracker is None or t - self._t <= self.lost_after:
            return []
        lost = PresenceEvent("HAND_LOST", self.tracker.hand, t, self.tracker.position)
        self.tracker = None
        return [lost]
