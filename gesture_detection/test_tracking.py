"""Tests for what was built against a recording of the rig: the view windows,
the palm tracker and shape memory, measured bones, measured triangulation noise,
hand-level pairing, and the depth-shape filter.

    python test_tracking.py

Pure numpy; no camera, no MediaPipe. Every number in the docstrings was measured
on that recording (gesture_detection/hand_test.svo2, 82 s of one hand in the
slot); the tests pin the BEHAVIOUR each fix was for.
"""

from __future__ import annotations

import sys

import numpy as np

from fuse3d import (BONES, MetricBones, disparity_noise, rays_from_pixels, same_hand,
                    triangulate_depths, triangulation_sigma)
from handmodel import DepthShapeFilter, MultiOneEuro, bone_lengths
from palmtrack import PalmTracker, ShapeMemory
from test_fuse3d import BASELINE, FX, INTR, posed, project_left, project_right
from viewwindow import ViewWindow, disparity_shift

RNG = np.random.default_rng(7)
W, H = 1280, 720


def hand_px(cx=700.0, cy=380.0, size=220.0):
    """21 landmarks filling a box `size` px across, centred at (cx, cy)."""
    g = np.stack(np.meshgrid(np.linspace(-0.5, 0.5, 7), np.linspace(-0.5, 0.5, 3)), -1).reshape(-1, 2)
    return g * size + [cx, cy]


# --------------------------------------------------------------------------
# view windows
# --------------------------------------------------------------------------

def test_window_follows_the_hand_and_maps_landmarks_back_to_the_full_image():
    win = ViewWindow(W, H)
    assert win.rect is None and win.crop(np.zeros((H, W, 3))).shape == (H, W, 3)
    px = hand_px()
    win.saw(px)
    a, b, c, d = win.rect
    assert c - a == d - b == 660, "three hand-sizes across"
    assert a <= px[:, 0].min() and c >= px[:, 0].max() and b <= px[:, 1].min() and d >= px[:, 1].max()
    crop = win.crop(np.zeros((H, W, 3), dtype=np.uint8))
    assert crop.shape == (d - b, c - a, 3) and crop.flags["C_CONTIGUOUS"]
    # a landmark the landmarker reports in CROP coordinates lands where it really is
    norm = (px - [a, b]) / [c - a, d - b]
    assert np.allclose(win.to_full(norm), px)


def test_window_stays_put_while_the_hand_is_comfortable_in_it():
    """MediaPipe tracks in the coordinates of the image it is given: a window
    that moves pulls the hand out from under that memory. So it does not move
    for small motions, and does once the hand nears its edge or changes size."""
    win = ViewWindow(W, H)
    win.saw(hand_px())
    first = win.rect
    for dx in (10, 40, 90, -60):
        win.saw(hand_px(cx=700 + dx))
        assert win.rect == first, f"moved for a {dx} px shift"
    win.saw(hand_px(cx=700 + 260))
    assert win.rect != first, "the hand reached the edge: the window has to follow"
    win.saw(hand_px(cx=960, size=90))
    assert (win.rect[2] - win.rect[0]) < 660, "a hand that shrank gets a smaller window"


def test_a_view_that_lost_the_hand_is_pointed_at_it_by_the_other_view():
    """On the recording, a lost view handed a crop found the hand again 90-94%
    of the time; a fresh detector on the full frame, 17-30%."""
    right = ViewWindow(W, H)
    left_px = hand_px(cx=760)
    near, far = disparity_shift(FX, BASELINE, 0.20), disparity_shift(FX, BASELINE, 0.45)
    right.missed(left_px, (-near, -far))
    a, b, c, d = right.rect
    for depth in (0.20, 0.30, 0.45):
        x = left_px[:, 0] - disparity_shift(FX, BASELINE, depth)
        assert a <= x.min() and x.max() <= c, f"a hand at {depth} m falls outside the predicted window"
    assert b <= left_px[:, 1].min() and left_px[:, 1].max() <= d, "same rows: the views are rectified"
    # nobody knows where the hand is: wait a few frames where it was, then open up
    for _ in range(3):
        right.missed()
        assert right.rect is not None
    for _ in range(3):
        right.missed()
    assert right.rect is None


def test_a_hand_filling_the_frame_gets_the_whole_frame():
    win = ViewWindow(W, H)
    win.saw(hand_px(cx=640, cy=360, size=400))
    assert win.rect is None


# --------------------------------------------------------------------------
# the palm's distance as a state
# --------------------------------------------------------------------------

def test_the_palm_holds_still_through_frames_that_only_have_a_guess():
    """Apparent size on real frames: 29 cm, 47 cm, 40 cm for a hand that had not
    moved. A third of frames had nothing better, and the hand leapt with it."""
    tr, t, out = PalmTracker(), 0.0, []
    for k in range(80):
        blind = 20 <= k < 60
        guess = 0.27 * (1 + 0.25 * float(np.clip(RNG.standard_normal(), -2.5, 2.5)))
        d, _ = tr.update(t, hard=None if blind else (0.27 + 0.001 * RNG.standard_normal(), 0.004),
                         soft=[(guess, 0.5 * max(guess, 0.27))])
        out.append(d)
        t += 0.05
    out = np.array(out)
    steps = np.abs(np.diff(out[20:60]))
    assert steps.max() < 0.012, f"leapt {steps.max() * 1000:.0f} mm on a guess"
    assert np.abs(out[20:60] - 0.27).max() < 0.03
    assert abs(out[60] - 0.27) < 0.004, "and the second lens coming back puts it right at once"


def test_a_precise_reading_is_followed_without_lag():
    tr, t = PalmTracker(), 0.0
    for k in range(40):                                  # pushing in at 0.3 m/s
        true = 0.85 - 0.3 * t
        d, _ = tr.update(t, hard=(true, 0.004))
        t += 0.05
    assert abs(d - true) < 0.004, f"trails a moving hand by {abs(d - true) * 1000:.1f} mm"


def test_one_wild_reading_is_refused_but_a_persistent_one_wins():
    tr, t = PalmTracker(), 0.0
    for _ in range(20):
        tr.update(t, hard=(0.27, 0.004)); t += 0.05
    d, _ = tr.update(t, hard=(0.45, 0.004)); t += 0.05       # a mis-paired frame
    assert abs(d - 0.27) < 0.01
    d, _ = tr.update(t, hard=(0.27, 0.004)); t += 0.05
    assert abs(d - 0.27) < 0.005
    for _ in range(8):                                   # ...but the hand really is somewhere else now
        d, _ = tr.update(t, hard=(0.45, 0.004)); t += 0.05
    assert abs(d - 0.45) < 0.01, "0.3 s of insisting overturns the state"
    # the depth map may agree, but never overturn: past 30 cm it is as likely the forearm
    tr2, t = PalmTracker(), 0.0
    for _ in range(20):
        tr2.update(t, hard=(0.27, 0.004)); t += 0.05
    for _ in range(12):
        d, _ = tr2.update(t, soft=[(0.34, 0.008)]); t += 0.05
    assert abs(d - 0.27) < 0.015, f"the map dragged the palm to {d:.3f}"


def test_the_tracker_forgets_after_a_second_of_nothing_believable():
    tr = PalmTracker()
    tr.update(0.0, hard=(0.27, 0.004))
    assert tr.predict(0.5) is not None and tr.predict(2.0) is None
    d, _ = tr.update(3.0, hard=(0.40, 0.004))
    assert abs(d - 0.40) < 1e-9


# --------------------------------------------------------------------------
# the shape, remembered
# --------------------------------------------------------------------------

def test_a_joint_stays_where_triangulation_put_it_when_its_triangulation_goes():
    """Triangulation and MediaPipe's model disagreed by a median 24 mm per joint
    on the recording, steadily; joints flipped between the two answers and leapt
    2-5 cm relative to the palm on four frames in ten."""
    mem, t = ShapeMemory(), 0.0
    model_far = np.linspace(-0.06, 0.02, 21)             # the model's relief about the palm
    model_far -= model_far[[0, 5, 9, 13, 17]].mean()
    truth_far = 1.4 * model_far + 0.01                   # what the two lenses say: same pose, different numbers
    truth_far -= np.median(truth_far[[0, 5, 9, 13, 17]])
    palm = 0.27
    sig = np.full(21, 0.006)
    for _ in range(10):
        mem.observe(palm + truth_far, sig, model_far, t); t += 0.05
    prior, sigma = mem.prior(palm, model_far, t)
    assert np.abs(prior - (palm + truth_far)).max() < 0.002, "the prior is where triangulation last put each joint"
    assert sigma.max() < 0.01
    # the finger curls 1 cm (the model sees it) while triangulation is away: the joint follows the model's CHANGE
    prior2, _ = mem.prior(palm, model_far + 0.01, t + 0.1)
    assert np.allclose(prior2 - prior, 0.01, atol=1e-6)
    # and with nothing refreshing it, the memory fades back to the bare model
    late, sigma_late = mem.prior(palm, model_far, t + 3.0)
    assert np.allclose(late, palm + model_far) and np.allclose(sigma_late, 0.030)
    # a joint triangulated too poorly to believe teaches it nothing
    fresh = ShapeMemory()
    fresh.observe(palm + truth_far, np.full(21, 0.05), model_far, 0.0)
    assert np.allclose(fresh.prior(palm, model_far, 0.01)[0], palm + model_far)


# --------------------------------------------------------------------------
# bones, measured
# --------------------------------------------------------------------------

def test_bones_are_learned_from_the_lenses_where_they_lie_across_the_view():
    """MediaPipe's knuckle-to-knuckle bones were a third to a half shorter than
    the two lenses measured; a bone too short for its rays flattens the palm."""
    p = posed(0.27, pitch=20)
    true = bone_lengths(p)
    rays = rays_from_pixels(project_left(p), INTR)
    d = -p[:, 2]
    mb = MetricBones()
    model = true * 0.8                                   # a generic hand, 20% small
    model[[8, 12]] *= 0.6                                # ...and much too narrow across the palm
    assert mb.lengths(None) is None and np.allclose(mb.lengths(model), model)
    for _ in range(40):
        mb.observe(rays, d + RNG.normal(0, 0.002, 21), np.full(21, 0.004))
    got = mb.lengths(model)
    seen = np.isfinite(mb.measured())
    assert seen[[8, 12, 16]].all(), "the across-the-palm bones are exactly the ones this can see"
    assert np.abs(got[seen] / true[seen] - 1).max() < 0.08
    # bones it could not measure (pointing at the lens) take the model's proportions at the measured scale
    assert (~seen).any() and np.abs(got[~seen] / true[~seen] - 1).max() < 0.12
    # frames too noisy to trust teach nothing
    quiet = MetricBones()
    quiet.observe(rays, d, np.full(21, 0.05))
    assert not np.isfinite(quiet.measured()).any()


# --------------------------------------------------------------------------
# pairing and its noise, measured
# --------------------------------------------------------------------------

def test_disparity_noise_is_read_off_the_rows():
    p = posed(0.27, pitch=40)
    left, right = project_left(p), project_right(p)
    clean = disparity_noise(left, right)
    assert np.allclose(clean, 1.5), "no disagreement: the floor"
    noisy_r = right + RNG.normal(0, 6.0, right.shape)
    sigma = disparity_noise(left, noisy_r)
    assert 4.0 < np.median(sigma) < 12.0, f"6 px of landmark noise read as {np.median(sigma):.1f}"
    one_bad = right.copy()
    one_bad[8, 1] += 40.0
    s = disparity_noise(left, one_bad)
    assert s[8] > 30 and np.delete(s, 8).max() < 3.0, "a joint the views disagree on is weighed down, alone"
    # a whole-hand vertical offset is a crop or rectification fault, not landmark noise
    assert np.allclose(disparity_noise(left, right + [0.0, 9.0]), 1.5)
    # and it feeds the depth sigma
    d = triangulate_depths(left, noisy_r, FX, BASELINE, max_row_error=200)
    assert np.nanmedian(triangulation_sigma(d, FX, BASELINE, pixel_noise=sigma)) > 3 * np.nanmedian(triangulation_sigma(d, FX, BASELINE))


def test_pairing_is_judged_on_the_hand_not_joint_by_joint():
    """The old rule wanted 11 joints each within 5% of the hand's size of its
    twin's row, and refused a third of real frames of one hand."""
    p = posed(0.27, pitch=50)
    left, right = project_left(p), project_right(p)
    extent = float(np.linalg.norm(left.max(0) - left.min(0)))
    shaky = right + RNG.normal(0, 0.06 * extent, right.shape) * [0.3, 1.0]      # rows off by ~6% of the hand
    assert same_hand(left, shaky, FX, BASELINE), "one hand, two unsure landmarkers"
    assert not same_hand(left, right + [0.0, 0.35 * extent], FX, BASELINE), "a hand a third of a hand higher is another hand"


# --------------------------------------------------------------------------
# filters
# --------------------------------------------------------------------------

def test_depth_shape_filter_stops_a_joint_leaping_along_its_ray_and_leaves_the_palm_alone():
    f, t = DepthShapeFilter(), 0.0
    base = np.full(21, 0.27) + np.linspace(-0.05, 0.02, 21)
    out = []
    for k in range(40):
        d = base.copy()
        if k == 20:
            d[8] += 0.04                                  # one wild frame on the index tip
        if k >= 30:
            d = d - 0.03                                  # the whole hand moves 3 cm nearer: NOT this filter's business
        out.append(f(d, t))
        t += 0.05
    out = np.array(out)
    assert abs(out[20, 8] - base[8]) < 0.003 and abs(out[21, 8] - base[8]) < 0.003, "the wild frame never shows"
    assert np.allclose(out[30] - out[29], -0.03, atol=0.002), "the palm's own motion passes straight through"


def test_one_gain_for_the_whole_hand_keeps_bones_the_length_they_were():
    p0 = posed(0.27, pitch=30)
    true = bone_lengths(p0)
    worst = {}
    for together in (False, True):
        f, t, dev = MultiOneEuro((21, 3), min_cutoff=1.0, beta=2.0, together=together), 0.0, 0.0
        for k in range(60):
            p = p0 + [0.15 * np.sin(k / 6.0), 0.05 * np.cos(k / 9.0), 0.0] + RNG.normal(0, 0.0001, p0.shape)
            p[8] += [0.0, 0.0, 0.02 * np.sin(k / 3.0)]   # the index tip is also busy in depth
            out = f(p, t)
            t += 0.05
            if k > 5:
                dev = max(dev, float(np.abs(np.delete(bone_lengths(out) / true - 1, 7)).max()))
        worst[together] = dev
    assert worst[True] < 0.75 * worst[False], f"per-coordinate {worst[False]:.1%} vs together {worst[True]:.1%}"
    assert worst[True] < 0.03


# --------------------------------------------------------------------------

def _run() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
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
