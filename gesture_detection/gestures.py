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
from typing import Deque, Dict, List, Optional, Tuple

import numpy as np

__all__ = [
    "OneEuroFilter", "Vec3Filter",
    "PinchEvent", "SwipeEvent", "PresenceEvent", "HandState",
    "PinchTracker", "SwipeDetector", "HandTracker", "HandRegistry",
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
                 max_dt: float = 0.15):
        self._f = [OneEuroFilter(min_cutoff, beta, d_cutoff, max_dt) for _ in range(3)]
        self._vel_tau = vel_tau
        self._max_dt = max_dt
        self._p_prev: Optional[np.ndarray] = None
        self._t_prev: Optional[float] = None
        self.position: Optional[np.ndarray] = None
        self.velocity = np.zeros(3)

    def reset(self) -> None:
        for f in self._f:
            f.reset()
        self._p_prev = None
        self._t_prev = None
        self.position = None
        self.velocity = np.zeros(3)

    def update(self, p: np.ndarray, t: float) -> Tuple[np.ndarray, np.ndarray]:
        p = np.asarray(p, dtype=np.float64)
        f = np.array([self._f[i](float(p[i]), t) for i in range(3)])
        if self._p_prev is not None and self._t_prev is not None:
            dt = t - self._t_prev
            if 0.0 < dt <= self._max_dt:
                v = (f - self._p_prev) / dt
                a = dt / (self._vel_tau + dt)
                self.velocity = a * v + (1.0 - a) * self.velocity
            else:
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
    max_speed: float = 12.0           # m/s; above this the track jumped, see feed()
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
                 mirror_x: bool = False, swipe_while_pinched: bool = True):
        self.hand = hand
        self.filt = Vec3Filter()
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

    def state(self, t: float) -> HandState:
        return HandState(
            hand=self.hand, t=t, position=self.position, velocity=self.velocity,
            speed=float(np.linalg.norm(self.velocity)),
            pinch_gap=self.pinch.gap_f, pinch_strength=self.pinch.strength,
            pinched=self.pinch.state == "closed",
        )


class HandRegistry:
    """Keeps a HandTracker per handedness label and emits presence events.

    MediaPipe gives no stable track ids, so the label is the identity. That is
    sound for two hands and breaks for two right hands in frame -- which the
    landmarker will not report anyway.
    """

    def __init__(self, lost_after: float = 0.50, **tracker_kwargs):
        self.lost_after = lost_after
        self._kwargs = tracker_kwargs
        self.trackers: Dict[str, HandTracker] = {}
        self._present: Dict[str, bool] = {}

    def get(self, label: str, t: float) -> Tuple[HandTracker, Optional[PresenceEvent]]:
        tr = self.trackers.get(label)
        ev = None
        if tr is None:
            tr = self.trackers[label] = HandTracker(label, **self._kwargs)
        if not self._present.get(label, False):
            self._present[label] = True
            ev = PresenceEvent("HAND_FOUND", label, t)
        return tr, ev

    def sweep(self, t: float) -> List[PresenceEvent]:
        out = []
        for label, tr in self.trackers.items():
            if self._present.get(label) and t - tr.last_seen > self.lost_after:
                self._present[label] = False
                out.append(PresenceEvent("HAND_LOST", label, t, tr.position))
        return out
