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

from gestures import (SMOOTHING_PRESETS, HandTracker, OneHand, PinchEvent,
                      SwipeEvent, Vec3Filter)

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

def test_single_bad_depth_sample_is_rejected():
    """One impulse must not move the reported hand.

    One Euro on its own cannot do this: a spike is indistinguishable from fast
    motion, so the filter widens its cutoff and passes it straight through.
    """
    f = Vec3Filter()
    truth = np.array([0.1, 0.0, -0.9])
    for i in range(40):
        f.update(truth + RNG.normal(0, 0.002, 3), i / FPS)
    before = f.position.copy()
    f.update(truth + np.array([0.0, 0.0, -0.9]), 40 / FPS)   # depth doubles for a frame
    moved = np.linalg.norm(f.position - before)
    assert moved < 0.01, f"impulse moved the hand {moved * 100:.1f} cm"


def test_resting_hand_reports_zero_velocity():
    """Noise integrated into velocity reads as slow drift that never stops."""
    f = Vec3Filter()
    for i in range(120):
        f.update(np.array([0.1, 0.0, -0.9]) + RNG.normal(0, 0.003, 3), i / FPS)
    assert f.speed == 0.0, f"{f.speed:.4f} m/s at rest"


def test_every_smoothing_preset_still_detects_a_swipe():
    """Smoothing attenuates motion, so the heaviest preset is the risk: it must
    not quietly stop the gesture it is meant to clean up."""
    for name in SMOOTHING_PRESETS:
        tr = HandTracker("Right", smoothing=name)
        path = (stationary([0, 0, -0.8], 0.5)
                + linear([0, 0, -0.8], [0.30, 0, -0.8], 0.25)
                + stationary([0.30, 0, -0.8], 0.5))
        ev = swipes(feed(tr, path))
        assert len(ev) == 1, f"{name}: {len(ev)} swipes"
        assert ev[0].direction == "RIGHT", f"{name}: {ev[0].direction}"


def test_smoothing_actually_reduces_jitter():
    """Pins the benefit down, so a future tuning pass cannot silently undo it."""
    truth = np.array([0.1, 0.0, -0.9])
    rms = {}
    for name in ("responsive", "steady"):
        f = HandTracker("R", smoothing=name).filt
        errs = []
        rng = np.random.default_rng(5)
        for i in range(240):
            s = truth + rng.normal(0, (0.002, 0.002, 0.008))
            if rng.random() < 0.05:
                s = s + rng.normal(0, 0.20, 3)          # a bad depth sample
            p, _ = f.update(s, i / FPS)
            errs.append(p - truth)
        rms[name] = float(np.sqrt((np.array(errs) ** 2).mean()))
    assert rms["steady"] < rms["responsive"] * 0.5, rms


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
# one hand at a time
# --------------------------------------------------------------------------
#
# OneHand sees what the main loop sees: per frame, a rough lateral position in
# metres, the landmarker's handedness label and its score. `follow` runs a
# sequence of those the way the loop does -- claim, update the tracker if it
# was claimed, sweep -- and returns everything that came out.

def follow(hand, frames, z=-0.8, g=0.9):
    """frames: (t, [(xy, label), ...]) -- the detections offered that frame, in
    order. Returns (events, accepted) where accepted[i] is the index claimed in
    frame i, or None."""
    events, accepted = [], []
    for t, offers in frames:
        taken = None
        for k, (xy, label) in enumerate(offers):
            mine, found = hand.claim(xy, label, t, 0.9)
            if found:
                events.append(found)
            if mine:
                taken = k
                events.extend(hand.tracker.update(
                    np.array([xy[0], xy[1], z]) + RNG.normal(0, NOISE, 3), g, t))
                break
        accepted.append(taken)
        events.extend(hand.sweep(t))
    return events, accepted


def kinds(events):
    return [(e.kind, e.hand) for e in events]


def still(xy, label, t0, dur):
    return [(t0 + i / FPS, [(np.asarray(xy, float), label)]) for i in range(int(dur * FPS))]


def test_one_hand_is_found_once_and_lost_once():
    hand = OneHand()
    frames = still((0.1, 0.0), "Right", 0.0, 1.0)
    frames += [(1.0 + i / FPS, []) for i in range(FPS)]            # it leaves
    events, accepted = follow(hand, frames)
    assert kinds(events) == [("HAND_FOUND", "Right"), ("HAND_LOST", "Right")], kinds(events)
    assert all(a == 0 for a in accepted[:FPS]) and not hand.present


def test_a_flickering_label_is_still_one_hand():
    """The old identity WAS the label, so this hand was two hands: two
    trackers, two HAND_FOUNDs, and half a trajectory each."""
    hand = OneHand()
    frames = []
    for i in range(2 * FPS):
        label = "Left" if i % 7 in (2, 3) else "Right"              # wrong 2 frames in 7
        frames.append((i / FPS, [(np.array([0.1, 0.0]), label)]))
    first = None
    events = []
    for frame in frames:
        ev, accepted = follow(hand, [frame])
        events += ev
        assert accepted == [0], "a label alone must never cost the hand a frame"
        first = first or hand.tracker
        assert hand.tracker is first and hand.tracker.hand == "Right"
    assert kinds(events) == [("HAND_FOUND", "Right")], kinds(events)


def test_a_swipe_survives_the_label_flickering_through_it():
    """What the split cost in practice: each tracker saw half the swipe."""
    hand = OneHand()
    path = stationary((-0.2, 0, -0.8), 0.4) + linear((-0.2, 0, -0.8), (0.2, 0, -0.8), 0.25) \
        + stationary((0.2, 0, -0.8), 0.4)
    frames = [(i / FPS, [(p[:2], "Left" if i % 3 == 0 else "Right")]) for i, p in enumerate(path)]
    events, _ = follow(hand, frames)
    swipes = [e for e in events if isinstance(e, SwipeEvent)]
    assert len(swipes) == 1 and swipes[0].direction == "RIGHT", kinds(events)
    assert not swipes[0].bridged
    assert [k for k, _ in kinds(events)].count("HAND_FOUND") == 1


def test_a_wrong_first_label_is_corrected_without_losing_the_hand():
    hand = OneHand()
    frames = still((0.0, 0.0), "Left", 0.0, 2 / FPS) + still((0.0, 0.0), "Right", 2 / FPS, 1.0)
    events, accepted = follow(hand, frames)
    assert kinds(events) == [("HAND_FOUND", "Left")], kinds(events)
    assert all(a == 0 for a in accepted)
    assert hand.tracker.hand == hand.tracker.pinch.hand == hand.tracker.swipe.hand == "Right"


def test_a_second_hand_is_ignored_while_the_first_is_there():
    hand = OneHand()
    a, b = np.array([-0.2, 0.0]), np.array([0.2, 0.0])
    frames = [(i / FPS, [(b, "Left"), (a, "Right")] if i % 2 else [(a, "Right"), (b, "Left")])
              for i in range(2 * FPS)]
    events, accepted = follow(hand, frames)
    assert kinds(events) == [("HAND_FOUND", "Right")], kinds(events)
    # whichever order they are offered in, it is always hand A that is taken
    assert accepted == [1 if i % 2 else 0 for i in range(2 * FPS)]


def test_hopping_to_the_other_hand_is_not_a_swipe():
    """The danger of a single track. The landmarker drops hand A and picks up
    hand B 40 cm away on the very next frame: fed into one trajectory that is
    a 40 cm move in 17 ms, and to the gap-bridge it is a textbook swipe."""
    hand = OneHand()
    frames = still((-0.2, 0.0), "Right", 0.0, 1.0) + still((0.2, 0.0), "Left", 1.0, 1.5)
    events, accepted = follow(hand, frames)
    assert not [e for e in events if isinstance(e, SwipeEvent)], kinds(events)
    assert kinds(events) == [("HAND_FOUND", "Right"), ("HAND_LOST", "Right"),
                             ("HAND_FOUND", "Left")], kinds(events)
    waited = accepted[FPS:].index(0) / FPS
    assert 0.45 < waited < 0.60, f"the second hand waited {waited:.2f} s"


def test_a_second_hand_arriving_late_is_still_a_second_hand():
    """B turns up a third of a second after A went. "Close by" must not have
    grown to reach it in the meantime: an unseen hand could be anywhere by
    then, but so could somebody else's, and only the label can say which."""
    hand = OneHand()
    frames = still((-0.2, 0.0), "Right", 0.0, 1.0) + still((0.2, 0.0), "Left", 1.35, 1.0)
    events, _ = follow(hand, frames)
    assert not [e for e in events if isinstance(e, SwipeEvent)], kinds(events)
    assert kinds(events)[-2:] == [("HAND_LOST", "Right"), ("HAND_FOUND", "Left")]


def test_a_rival_whose_label_flickers_is_still_the_rival():
    """Why the rival is remembered and not just refused frame by frame. Hand B
    is mislabelled "Right" now and then, and on those frames it is a Right hand
    within reach of where the Right hand was: label and distance both say yes.
    What says no is that it has been standing there, refused, all along."""
    hand = OneHand()
    frames = still((-0.2, 0.0), "Right", 0.0, 1.0)
    frames += [(1.0 + i / FPS, [(np.array([0.2, 0.0]), "Right" if i % 5 == 4 else "Left")])
               for i in range(int(1.5 * FPS))]
    events, accepted = follow(hand, frames)
    assert not [e for e in events if isinstance(e, SwipeEvent)], kinds(events)
    assert [k for k, _ in kinds(events)] == ["HAND_FOUND", "HAND_LOST", "HAND_FOUND"], kinds(events)
    assert 0.45 < accepted[FPS:].index(0) / FPS < 0.60


def test_a_swipe_that_blurs_out_is_still_the_same_hand():
    """The gap-bridge must survive: the hand vanishes mid-swipe and comes back
    35 cm away, and that is one hand and one swipe, not a rival."""
    hand = OneHand()
    frames = still((-0.18, 0.0), "Right", 0.0, 0.6) + still((0.17, 0.0), "Right", 0.8, 0.6)
    events, accepted = follow(hand, frames)
    swipes = [e for e in events if isinstance(e, SwipeEvent)]
    assert all(a == 0 for a in accepted)
    assert len(swipes) == 1 and swipes[0].bridged and swipes[0].direction == "RIGHT", kinds(events)
    assert [k for k, _ in kinds(events)].count("HAND_FOUND") == 1


def test_a_fast_hand_is_never_mistaken_for_a_second_one():
    """3 m/s at 15 fps is 20 cm a frame -- further than two hands need be apart."""
    hand = OneHand()
    frames = [(i / 15, [(np.array([-0.6 + 3.0 * i / 15, 0.0]), "Right")]) for i in range(7)]
    _, accepted = follow(hand, frames)
    assert all(a == 0 for a in accepted), accepted


def test_a_new_hand_gets_a_new_tracker():
    """Nothing of the last hand -- a half-made pinch, a trajectory -- carries over."""
    hand = OneHand()
    follow(hand, still((0.0, 0.0), "Right", 0.0, 0.5), g=0.2)       # leaves pinched
    old = hand.tracker
    assert old.pinch.state == "closed"
    events, _ = follow(hand, [(0.5 + i / FPS, []) for i in range(FPS)]
                       + still((0.3, 0.1), "Right", 1.5, 0.5))
    assert hand.tracker is not old and hand.tracker.pinch.state == "open"
    assert not [e for e in events if isinstance(e, PinchEvent)], kinds(events)


# --------------------------------------------------------------------------
# the pinch as measured: two views and a referee
# --------------------------------------------------------------------------

def _hand_with(index_gap_m: float, middle_gap_m: float) -> np.ndarray:
    """21 landmarks with a 10 cm palm, the thumb tip at the origin's right and
    the index / middle tips a chosen distance from it."""
    p = np.zeros((21, 3))
    p[9] = [0.0, 0.10, 0.0]                      # middle knuckle: palm length 0.10
    p[4] = [0.03, 0.12, 0.0]                     # thumb tip
    p[8] = p[4] + [index_gap_m, 0.0, 0.0]
    p[12] = p[4] + [0.0, middle_gap_m, 0.0]
    return p


def test_pinch_gaps_are_fractions_of_the_palm_and_grab_takes_the_nearer_finger():
    from gestures import pinch_gaps
    pinch, grab = pinch_gaps(_hand_with(0.06, 0.02))
    assert abs(pinch - 0.6) < 1e-9 and abs(grab - 0.2) < 1e-9, (pinch, grab)
    pinch, grab = pinch_gaps(_hand_with(0.015, 0.05))
    assert abs(pinch - 0.15) < 1e-9 and abs(grab - 0.15) < 1e-9, (pinch, grab)
    # the same hand twice as far away (or in other units) reads the same
    a, b = pinch_gaps(_hand_with(0.03, 0.04)), pinch_gaps(_hand_with(0.03, 0.04) * 2.0)
    assert np.allclose(a, b)
    # and a hand that is not all there is no measurement, not a closed pinch
    broken = _hand_with(0.0, 0.0)
    broken[8] = np.nan
    assert all(np.isnan(g) for g in pinch_gaps(broken))
    assert all(np.isnan(g) for g in pinch_gaps(np.zeros((5, 3))))


def test_two_views_halve_the_noise_and_the_reconstruction_only_referees():
    from gestures import fuse_gaps
    assert fuse_gaps([0.30]) == 0.30
    assert abs(fuse_gaps([0.30, 0.40]) - 0.35) < 1e-12
    # one view lost the fingertip behind the thumb and reads wide open: with
    # the reconstruction agreeing with the other view, the outlier is outvoted
    assert abs(fuse_gaps([0.22, 0.95], solved=0.27) - 0.27) < 1e-12
    # the reconstruction alone cannot drag one good view about...
    assert fuse_gaps([0.22], solved=0.90) == 0.22
    # ...and is used only when it is all there is
    assert fuse_gaps([], solved=0.4) == 0.4
    assert fuse_gaps([float("nan")], solved=0.4) == 0.4
    assert np.isnan(fuse_gaps([], solved=float("nan")))
    rng = np.random.default_rng(3)
    one = [fuse_gaps([0.3 + rng.normal(0, 0.05)]) for _ in range(4000)]
    two = [fuse_gaps([0.3 + rng.normal(0, 0.05), 0.3 + rng.normal(0, 0.05)]) for _ in range(4000)]
    assert np.std(two) < 0.78 * np.std(one), (np.std(one), np.std(two))


def test_confidence_is_the_landmarkers_score_times_where_the_depth_came_from():
    from gestures import tracking_confidence as conf
    # both lenses, every joint triangulated: the landmarker's own (averaged) score
    assert abs(conf(0.96, 0.90, 21) - 0.93) < 1e-9
    # one lens: the distance is a guess from the hand's size, so never above a half
    assert abs(conf(0.96) - 0.48) < 1e-9 and conf(1.0) == 0.5
    assert conf(0.96, float("nan"), 21) == conf(0.96), "a view that reported nothing is not a view"
    # paired, but few joints agreed between the views: part way
    assert abs(conf(1.0, 1.0, 0) - 0.5) < 1e-9 and 0.5 < conf(1.0, 1.0, 10) < conf(1.0, 1.0, 21) == 1.0
    # more triangulated joints never lowers it, a lower score never raises it
    assert all(conf(0.9, 0.9, n) <= conf(0.9, 0.9, n + 1) for n in range(21))
    assert conf(0.6, 0.6, 21) < conf(0.9, 0.9, 21)
    # and it is always a number in range, whatever arrives
    for bad in (float("nan"), -1.0, 7.0):
        assert 0.0 <= conf(bad, 0.9, 21) <= 1.0 and 0.0 <= conf(bad) <= 1.0


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
