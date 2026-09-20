#!/usr/bin/env python3
"""Synthetic-trajectory tests for gestures.py -- no camera required.

Run:  python test_gestures.py        (or: pytest test_gestures.py)

Each test feeds a hand-motion path through HandTracker at 60 Hz with a little
positional noise, exactly as the live runner would, and asserts on the events
that come out. The point is to pin down the false-positive cases as much as
the positive ones: a gesture detector that fires on a swipe is easy, one that
stays quiet through a wave, a reach and a slow drift is the hard part.
"""

from __future__ import annotations

import sys
from typing import List

import numpy as np

from gestures import HandTracker, PinchEvent, SwipeEvent, Vec3Filter

FPS = 60
RNG = np.random.default_rng(7)
NOISE = 0.002          # 2 mm, roughly ZED palm depth jitter at 1 m


# --------------------------------------------------------------------------
# path builders
# --------------------------------------------------------------------------

def stationary(p, dur):
    return [np.asarray(p, float)] * int(dur * FPS)


def linear(p0, p1, dur):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    n = int(dur * FPS)
    return [p0 + (p1 - p0) * (i + 1) / n for i in range(n)]


def arc(centre, radius, a0, a1, dur):
    """Curved path in the XY plane -- a wave, not a swipe."""
    n = int(dur * FPS)
    out = []
    for i in range(n):
        a = a0 + (a1 - a0) * (i + 1) / n
        out.append(np.array([centre[0] + radius * np.cos(a),
                             centre[1] + radius * np.sin(a),
                             centre[2]]))
    return out


def feed(tracker: HandTracker, path, gap=0.9, t0=0.0, noise=NOISE) -> List:
    events = []
    for i, p in enumerate(path):
        t = t0 + i / FPS
        jitter = RNG.normal(0.0, noise, 3) if noise else 0.0
        g = gap(t) if callable(gap) else gap
        events.extend(tracker.update(np.asarray(p, float) + jitter, g, t))
    return events


def swipes(evs) -> List[SwipeEvent]:
    return [e for e in evs if isinstance(e, SwipeEvent)]


def pinches(evs) -> List[PinchEvent]:
    return [e for e in evs if isinstance(e, PinchEvent)]


# --------------------------------------------------------------------------
# swipe: positives
# --------------------------------------------------------------------------

def test_swipe_right():
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.5)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.5))
    ev = swipes(feed(tr, path))
    assert len(ev) == 1, f"expected exactly one swipe, got {[e.direction for e in ev]}"
    assert ev[0].direction == "RIGHT"
    assert ev[0].distance >= 0.14
    assert ev[0].peak_speed > 0.55


def test_swipe_left():
    tr = HandTracker("Right")
    path = (stationary([0.30, 0, -0.8], 0.5)
            + linear([0.30, 0, -0.8], [0, 0, -0.8], 0.25)
            + stationary([0, 0, -0.8], 0.5))
    ev = swipes(feed(tr, path))
    assert len(ev) == 1 and ev[0].direction == "LEFT", [e.direction for e in ev]


def test_swipe_up():
    tr = HandTracker("Right")
    path = (stationary([0, -0.15, -0.8], 0.5)
            + linear([0, -0.15, -0.8], [0, 0.20, -0.8], 0.28)
            + stationary([0, 0.20, -0.8], 0.5))
    ev = swipes(feed(tr, path))
    assert len(ev) == 1 and ev[0].direction == "UP", [e.direction for e in ev]


def test_swipe_toward_camera():
    # +Z points toward the camera in RIGHT_HANDED_Y_UP
    tr = HandTracker("Right")
    path = (stationary([0, 0, -1.0], 0.5)
            + linear([0, 0, -1.0], [0, 0, -0.70], 0.25)
            + stationary([0, 0, -0.70], 0.5))
    ev = swipes(feed(tr, path))
    assert len(ev) == 1 and ev[0].direction == "TOWARD", [e.direction for e in ev]


def test_mirror_x_flips_left_right():
    tr = HandTracker("Right", mirror_x=True)
    path = (stationary([0, 0, -0.8], 0.5)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.5))
    ev = swipes(feed(tr, path))
    assert len(ev) == 1 and ev[0].direction == "LEFT", [e.direction for e in ev]


# --------------------------------------------------------------------------
# swipe: the cases that must stay quiet
# --------------------------------------------------------------------------

def test_slow_reach_is_not_a_swipe():
    """Same 30 cm of travel, taken over two seconds."""
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.4)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 2.0)
            + stationary([0.30, 0, -0.8], 0.4))
    assert swipes(feed(tr, path)) == []


def test_short_flick_is_not_a_swipe():
    """Fast but only 6 cm -- a flinch, not a gesture."""
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.4)
            + linear([0, 0, -0.8], [0.06, 0, -0.8], 0.10)
            + stationary([0.06, 0, -0.8], 0.4))
    assert swipes(feed(tr, path)) == []


def test_diagonal_is_rejected():
    """Equal X and Y travel: no dominant axis, so no unambiguous direction."""
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.4)
            + linear([0, 0, -0.8], [0.24, 0.24, -0.8], 0.25)
            + stationary([0.24, 0.24, -0.8], 0.4))
    assert swipes(feed(tr, path)) == []


def test_waving_fires_at_most_once():
    """Sustained waving must not stream swipe events.

    Each individual stroke of a wave is straight, fast and long enough to be a
    textbook swipe -- 18 cm at 1.4 m/s here -- so no single-window test can
    reject it. Only the reversal guard can, and the honest guarantee is "one
    event at the start", not zero.
    """
    tr = HandTracker("Right")
    n = int(3.0 * FPS)
    path = stationary([0, 0, -0.8], 0.4) + [
        np.array([0.09 * np.sin(2 * np.pi * 2.5 * (i / FPS)), 0.0, -0.8])
        for i in range(n)
    ]
    ev = swipes(feed(tr, path))
    assert len(ev) <= 1, f"waving produced {len(ev)} swipes: {[e.direction for e in ev]}"


def test_circular_stir_is_rejected():
    """A small stirring motion: curved, and never far enough in one direction."""
    tr = HandTracker("Right")
    path = (stationary([0.06, 0, -0.8], 0.4)
            + arc([0, 0, -0.8], 0.06, 0.0, 4 * np.pi, 1.6))
    assert swipes(feed(tr, path)) == []


def test_still_hand_with_noise_is_quiet():
    tr = HandTracker("Right")
    assert swipes(feed(tr, stationary([0, 0, -0.8], 4.0), noise=0.004)) == []


def test_swipe_fires_once_not_per_frame():
    """The sliding window must not re-fire through the follow-through."""
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.4)
            + linear([0, 0, -0.8], [0.45, 0, -0.8], 0.35)
            + stationary([0.45, 0, -0.8], 1.0))
    assert len(swipes(feed(tr, path))) == 1


def dropout(tr, before, after, hold, gap, gap_gap=0.0, tail=0.5, g=0.9):
    """Feed `hold` seconds at `before`, vanish for `gap`, reappear at `after`."""
    events = feed(tr, stationary(before, hold), gap=g)
    t_resume = hold + gap
    events += feed(tr, stationary(after, tail), gap=g, t0=t_resume)
    return events


def test_swipe_survives_a_tracking_dropout():
    """The reported failure: a swipe blurs the hand out of the landmarker and
    surfaces as HAND_LOST / HAND_FOUND instead of a gesture."""
    tr = HandTracker("Right")
    ev = swipes(dropout(tr, [0, 0, -0.8], [0.30, 0, -0.8], hold=0.6, gap=0.25))
    assert len(ev) == 1, f"expected one bridged swipe, got {len(ev)}"
    assert ev[0].direction == "RIGHT" and ev[0].bridged
    assert abs(ev[0].distance - 0.30) < 0.03


def test_dropout_without_travel_is_not_a_swipe():
    """The hand blinked out and came back where it was."""
    tr = HandTracker("Right")
    assert swipes(dropout(tr, [0, 0, -0.8], [0.04, 0, -0.8], hold=0.6, gap=0.25)) == []


def test_slow_dropout_is_not_a_swipe():
    """30 cm across a 0.9 s absence is a hand that wandered off and came back,
    not a gesture -- and the gap is past the bridge limit anyway."""
    tr = HandTracker("Right")
    assert swipes(dropout(tr, [0, 0, -0.8], [0.30, 0, -0.8], hold=0.6, gap=0.9)) == []


def test_depth_dominant_dropout_is_not_bridged():
    """Seen live as a 64 cm "SWIPE TOWARD" the instant a hand appeared.

    Across a dropout the depth estimate can change source -- size-bootstrap to
    real stereo -- and that jump is along Z. Lateral position comes from pixels
    and is trustworthy; depth across a gap is not.
    """
    tr = HandTracker("Right")
    assert swipes(dropout(tr, [0, 0, -1.4], [0, 0, -0.8], hold=0.6, gap=0.25)) == []


def test_implausibly_long_bridge_is_rejected():
    """No arm covers 90 cm in a quarter second."""
    tr = HandTracker("Right")
    assert swipes(dropout(tr, [0, 0, -0.8], [0.90, 0, -0.8], hold=0.6, gap=0.25)) == []


def test_bridged_swipe_reports_its_provenance():
    """A bridged event has no intermediate samples, so straightness is 1.0 by
    construction. Consumers must be able to tell that apart from a measured one."""
    tr = HandTracker("Right")
    bridged = swipes(dropout(tr, [0, 0, -0.8], [0.30, 0, -0.8], hold=0.6, gap=0.25))[0]
    assert bridged.bridged and bridged.to_dict()["bridged"] is True

    tr2 = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.5)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.5))
    assert swipes(feed(tr2, path))[0].bridged is False


def test_duplicate_frame_does_not_explode_speed():
    """Two detections sharing one handedness label arrive at the same timestamp.

    Seen live: the pair produced a zero time delta, and dividing a 37 cm jump
    by it reported a swipe at 367,805 m/s. Any emitted event must stay within
    what an arm can physically do.
    """
    tr = HandTracker("Right")
    feed(tr, stationary([0, 0, -0.8], 0.5))
    t = 0.5
    tr.update(np.array([0.0, 0.0, -0.8]), 0.9, t)
    for _ in range(3):                      # same t, wildly different positions
        evs = tr.update(np.array([0.37, 0.0, -0.8]), 0.9, t)
        for e in swipes(evs):
            assert e.peak_speed < 20.0, f"{e.peak_speed:.0f} m/s is not a hand"


def test_alternating_swipes_at_live_cadence():
    """Matches observed usage: strokes alternating every ~0.6 s must all fire.

    The reversal guard exists to silence waving, but tuned too long it also
    silences a person deliberately swiping back and forth, which is exactly
    how anyone tests the feature.
    """
    tr = HandTracker("Right")
    path = stationary([0, 0, -0.8], 0.4)
    a, b = [0, 0, -0.8], [0.30, 0, -0.8]
    for i in range(4):
        p0, p1 = (a, b) if i % 2 == 0 else (b, a)
        path = path + linear(p0, p1, 0.25) + stationary(p1, 0.35)
    ev = swipes(feed(tr, path))
    assert len(ev) >= 3, f"only {len(ev)} of 4 strokes fired: {[e.direction for e in ev]}"
    assert [e.direction for e in ev[:2]] == ["RIGHT", "LEFT"], [e.direction for e in ev]


def test_two_swipes_separated_in_time():
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.4)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.9)
            + linear([0.30, 0, -0.8], [0.0, 0, -0.8], 0.25)
            + stationary([0.0, 0, -0.8], 0.5))
    ev = swipes(feed(tr, path))
    assert [e.direction for e in ev] == ["RIGHT", "LEFT"], [e.direction for e in ev]


def test_swipe_gated_while_pinched_when_requested():
    """Opt-in gating, for apps where pinch-and-drag must not also swipe."""
    tr = HandTracker("Right", swipe_while_pinched=False)
    path = (stationary([0, 0, -0.8], 0.5)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.5))
    assert swipes(feed(tr, path, gap=0.1)) == []      # hand held closed


def test_closed_hand_swipes_by_default():
    """The default must not gate.

    Gating on pinch state was the default at first, and it silently swallowed
    every swipe made with a relaxed or curled hand -- which is how most people
    actually swipe. A gesture that never fires is worse than one that
    occasionally overlaps with pinch-and-drag.
    """
    tr = HandTracker("Right")
    path = (stationary([0, 0, -0.8], 0.5)
            + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
            + stationary([0.30, 0, -0.8], 0.5))
    assert len(swipes(feed(tr, path, gap=0.1))) == 1


# --------------------------------------------------------------------------
# pinch
# --------------------------------------------------------------------------

def test_pinch_in_then_out():
    tr = HandTracker("Right")

    def gap(t):
        if t < 0.5:
            return 0.90
        if t < 0.70:                      # close over 200 ms
            return 0.90 - 0.80 * (t - 0.5) / 0.20
        if t < 1.40:                      # hold
            return 0.10
        if t < 1.60:                      # release over 200 ms
            return 0.10 + 0.80 * (t - 1.40) / 0.20
        return 0.90

    ev = pinches(feed(tr, stationary([0, 0, -0.8], 2.2), gap=gap))
    assert [e.kind for e in ev] == ["PINCH_IN", "PINCH_OUT"], [e.kind for e in ev]
    assert ev[0].duration < 0.6 and ev[1].duration < 0.6


def test_long_hold_still_releases():
    """Five seconds pinched, then open: PINCH_OUT must still fire."""
    tr = HandTracker("Right")

    def gap(t):
        if t < 0.4:
            return 0.90
        if t < 0.6:
            return 0.90 - 0.80 * (t - 0.4) / 0.20
        if t < 5.6:
            return 0.10
        if t < 5.8:
            return 0.10 + 0.80 * (t - 5.6) / 0.20
        return 0.90

    ev = pinches(feed(tr, stationary([0, 0, -0.8], 6.4), gap=gap))
    assert [e.kind for e in ev] == ["PINCH_IN", "PINCH_OUT"], [e.kind for e in ev]


def test_natural_speed_pinch_fires():
    """A relaxed pinch, not a snappy one.

    Live ZED data showed real pinches crossing the hysteresis band in
    180-240 ms, against 67 ms for an idealised ramp. This models the slow end
    of that range; if it stops firing, max_transition has been tuned on
    synthetic input again and will reject real users.
    """
    tr = HandTracker("Right")

    def gap(t):
        if t < 0.4:
            return 0.90
        return max(0.10, 0.90 - 0.80 * (t - 0.4) / 0.85)

    ev = pinches(feed(tr, stationary([0, 0, -0.8], 1.6), gap=gap))
    assert [e.kind for e in ev] == ["PINCH_IN"], [e.kind for e in ev]
    assert 0.15 < ev[0].duration < 0.35, f"{ev[0].duration * 1000:.0f} ms"


def test_slow_close_is_not_a_pinch():
    """Curling the hand shut over two seconds is a pose change."""
    tr = HandTracker("Right")

    def gap(t):
        return 0.90 if t < 0.4 else max(0.10, 0.90 - 0.80 * (t - 0.4) / 2.0)

    assert pinches(feed(tr, stationary([0, 0, -0.8], 3.0), gap=gap)) == []


def test_jitter_in_the_hysteresis_band_is_quiet():
    """Gap wobbling between the thresholds must not chatter events."""
    tr = HandTracker("Right")

    def gap(t):
        return 0.45 + 0.04 * np.sin(2 * np.pi * 3.0 * t)

    assert pinches(feed(tr, stationary([0, 0, -0.8], 4.0), gap=gap)) == []


# --------------------------------------------------------------------------
# position / velocity
# --------------------------------------------------------------------------

def test_velocity_tracks_constant_motion():
    f = Vec3Filter()
    v_true = 0.5                                    # m/s along +X
    for i in range(int(1.5 * FPS)):
        t = i / FPS
        f.update(np.array([v_true * t, 0.0, -0.8]), t)
    assert abs(f.speed - v_true) < 0.05, f.speed
    # filtering costs some position lag; at beta=4.0 it measures ~1.3 cm at
    # this speed, so anything past 3 cm means the filter has been detuned
    lag = v_true * (1.5 - 1 / FPS) - f.position[0]
    assert 0.0 <= lag < 0.03, f"{lag * 100:.1f} cm of lag"


def test_position_survives_a_tracking_gap():
    """A dropout must resync silently rather than emit a phantom swipe."""
    tr = HandTracker("Right")
    feed(tr, stationary([0, 0, -0.8], 0.6))
    ev = feed(tr, stationary([0.6, 0.1, -0.9], 0.6), t0=3.0)   # reappears elsewhere
    assert swipes(ev) == []


# --------------------------------------------------------------------------

def _run() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            # reseed per test: a shared RNG stream made outcomes depend on the
            # order tests happened to run in, which is how a real failure hid
            globals()["RNG"] = np.random.default_rng(7)
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {name}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run())
