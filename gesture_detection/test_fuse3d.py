#!/usr/bin/env python3
"""Tests for fuse3d.py -- no camera required.

Run:  python test_fuse3d.py

The headline test is test_fusion_beats_every_single_source: the point of
solving all the inputs together is that the answer is better than any of them
alone, and that claim should fail loudly if it stops being true.
"""

from __future__ import annotations

import sys

import numpy as np

from fuse3d import (BoneCalibration, ScaleCalibration, depthmap_sigma,
                    fuse_measurements, hand_reference, near_surface,
                    palm_triangulation, points_from_depths, rays_from_pixels,
                    same_hand, size_depth, solve_depths, triangulate_depths,
                    triangulation_sigma)
from handmodel import BONES, PALM_IDX, bone_lengths

FX = FY = 523.825
CX, CY = 662.354, 377.168
INTR = (FX, FY, CX, CY)
BASELINE = 0.120075
TIPS = (4, 8, 12, 16, 20)


def synthetic_hand(palm_d=0.80, rng=None):
    """21 joints in front of the camera; depth is positive, z = -depth."""
    rng = rng or np.random.default_rng(0)
    d = np.zeros(21)
    xy = np.zeros((21, 2))
    d[0] = palm_d
    for k, base in enumerate((1, 5, 9, 13, 17)):
        x = (k - 2) * 0.018
        xy[base] = [x, 0.035]
        d[base] = palm_d - 0.004 * k
        for s in range(1, 4):
            xy[base + s] = xy[base + s - 1] + [x * 0.15, 0.030]
            d[base + s] = d[base + s - 1] - 0.014
    pts = np.zeros((21, 3))
    pts[:, 0] = xy[:, 0]
    pts[:, 1] = xy[:, 1]
    pts[:, 2] = -d
    return pts, d


def project_left(p):
    d = -p[:, 2]
    return np.stack([CX + p[:, 0] * FX / d, CY - p[:, 1] * FY / d], axis=1)


def project_right(p):
    d = -p[:, 2]
    return np.stack([CX + (p[:, 0] - BASELINE) * FX / d, CY - p[:, 1] * FY / d], axis=1)


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def test_rays_and_depths_round_trip():
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    assert np.abs(points_from_depths(rays, d) - truth).max() < 1e-9


def test_triangulation_is_exact_without_noise():
    truth, d = synthetic_hand()
    got = triangulate_depths(project_left(truth), project_right(truth), FX, BASELINE)
    assert np.abs(got - d).max() < 1e-9, np.abs(got - d).max()


def test_triangulation_rejects_a_row_mismatch():
    """Two views disagreeing about the row are not looking at the same joint."""
    truth, _ = synthetic_hand()
    pr = project_right(truth)
    pr[8, 1] += 40.0
    got = triangulate_depths(project_left(truth), pr, FX, BASELINE)
    assert np.isnan(got[8]) and np.isfinite(got[0])


def test_triangulation_rejects_nonpositive_disparity():
    truth, _ = synthetic_hand()
    pr = project_right(truth)
    pr[4, 0] = project_left(truth)[4, 0] + 5.0      # right of the left pixel
    got = triangulate_depths(project_left(truth), pr, FX, BASELINE)
    assert np.isnan(got[4])


def test_triangulation_sigma_grows_quadratically():
    near = triangulation_sigma(np.array([0.8]), FX, BASELINE)[0]
    far = triangulation_sigma(np.array([1.6]), FX, BASELINE)[0]
    assert abs(far / near - 4.0) < 0.01
    assert 0.01 < near < 0.03, near


# --------------------------------------------------------------------------
# fusion
# --------------------------------------------------------------------------

def test_fusion_prefers_the_precise_source():
    a = np.array([1.00, np.nan])
    b = np.array([1.10, 1.30])
    d, s = fuse_measurements([a, b], [np.full(2, 0.005), np.full(2, 0.050)])
    assert abs(d[0] - 1.001) < 0.002, d[0]          # pulled almost entirely to a
    assert abs(d[1] - 1.30) < 1e-9                  # only b available
    assert s[0] < 0.005                             # combining beats either alone


def test_fusion_reports_nan_where_nothing_was_measured():
    nan2 = np.full(2, np.nan)
    d, s = fuse_measurements([nan2], [nan2])
    assert np.isnan(d).all() and np.isnan(s).all()


# --------------------------------------------------------------------------
# picking the near surface
# --------------------------------------------------------------------------

def patch(hand_d, other_d, hand_frac, n=100, seed=3):
    """A depth patch straddling the hand and something behind it."""
    rng = np.random.default_rng(seed)
    k = int(n * hand_frac)
    return np.concatenate([hand_d + rng.normal(0, 0.006, k),
                           other_d + rng.normal(0, 0.010, n - k)])


def test_near_surface_is_unbiased_on_a_clean_patch():
    """Whatever it does about occlusion must not cost accuracy normally."""
    rng = np.random.default_rng(1)
    clean = 0.80 + rng.normal(0, 0.006, 120)
    d, sd = near_surface(clean)
    assert abs(d - 0.80) < 0.002, d
    assert sd < 0.010


def test_near_surface_ignores_an_arm_just_behind_the_hand():
    """The reported failure: hand through the middle, elbow directly behind.

    The forearm sits a few centimetres back -- inside every plausibility
    window there is -- so the only thing that separates it from the hand is
    that the hand occludes it.
    """
    for gap in (0.05, 0.08, 0.15, 0.30):
        for frac in (0.75, 0.6, 0.45):
            d, _ = near_surface(patch(0.80, 0.80 + gap, frac))
            assert abs(d - 0.80) < 0.010, (
                f"gap {gap * 100:.0f} cm, hand {frac:.0%} of patch -> "
                f"{d:.4f}, off by {(d - 0.80) * 1000:.1f} mm")


def test_near_surface_beats_the_median_it_replaced():
    mix = patch(0.80, 0.88, 0.6)
    assert abs(near_surface(mix)[0] - 0.80) < abs(float(np.median(mix)) - 0.80) / 3


def test_near_surface_does_not_chase_a_single_close_outlier():
    """Seeded from a percentile, not the minimum, so one bad pixel cannot
    define the surface."""
    rng = np.random.default_rng(2)
    d = np.concatenate([0.80 + rng.normal(0, 0.006, 80), [0.55]])
    assert abs(near_surface(d)[0] - 0.80) < 0.005


def test_near_surface_survives_a_mostly_forearm_patch():
    """A patch near the wrist is mostly forearm, not hand.

    That is why the anchor now uses the four knuckles and not the wrist -- but
    the estimator should cope even so, because a fingertip crossing the arm
    hits the same thing.
    """
    for frac in (0.30, 0.20, 0.12, 0.09):
        d, _ = near_surface(patch(0.80, 0.88, frac, seed=7))
        assert abs(d - 0.80) < 0.010, f"hand {frac:.0%} of patch -> {d:.4f}"


def test_near_surface_reports_nothing_when_there_is_nothing():
    nan, _ = near_surface(np.array([np.nan, np.nan]))
    assert not np.isfinite(nan)
    assert not np.isfinite(near_surface(np.array([0.8]))[0])   # too few pixels


# --------------------------------------------------------------------------
# where the hand is, without the depth map
# --------------------------------------------------------------------------

def posed(palm_d=0.80, pitch=0.0, swing=0.0):
    """The synthetic hand tipped toward the camera, then swung round it."""
    truth, _ = synthetic_hand(palm_d=0.0)
    a, b = np.radians(pitch), np.radians(swing)
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    return (truth @ rx.T + [0.0, 0.0, -palm_d]) @ ry.T


def mediapipe_world(p, scale=1.0):
    """Metres about the centroid, x right, y DOWN, z AWAY -- as MediaPipe has it."""
    c = p - p.mean(axis=0)
    return np.stack([c[:, 0], -c[:, 1], -c[:, 2]], axis=1) * scale


def one_bone_depth(px, world):
    """The estimate size_depth replaced: palm length in metres over pixels."""
    return FX * np.linalg.norm(world[0] - world[9]) / np.linalg.norm(px[0] - px[9])


def _size_error(p, world=None):
    got = size_depth(rays_from_pixels(project_left(p), INTR),
                     mediapipe_world(p) if world is None else world)
    return got / float(-p[:, 2].mean()) - 1.0


def test_size_depth_places_the_hand_at_any_distance():
    """Within 3% from arm's length out. What is left is perspective -- this
    hand's fingers all reach toward the camera, which magnifies them -- so it
    reads near, and less so with distance."""
    errs = [_size_error(posed(palm_d)) for palm_d in (0.4, 0.8, 1.5, 2.5)]
    assert all(abs(e) < 0.03 for e in errs[1:]), errs
    assert abs(errs[0]) < 0.06, errs
    assert all(e < 0 for e in errs) and errs == sorted(errs), errs


def test_size_depth_survives_a_hand_pointing_at_the_camera():
    """One bone foreshortens to nothing and reads as a hand across the room.
    The spread of the whole hand, against a model that knows the pose, holds."""
    for pitch in (40, 70, -60):
        p = posed(0.8, pitch=pitch)
        px, world = project_left(p), mediapipe_world(p)
        true = float(-p[:, 2].mean())
        assert abs(_size_error(p)) < 0.05, f"pitch {pitch}: {_size_error(p):+.1%}"
        assert abs(one_bone_depth(px, world) / true - 1.0) > 0.25, (
            f"pitch {pitch}: the scene should defeat the one-bone estimate")


def test_size_depth_holds_off_axis():
    """The landmarker describes the hand as seen along its own viewing ray, so
    apparent size has to be measured about that ray. In the image plane the
    same hand 30 degrees off-axis looks 7% bigger, and reads 7% nearer."""
    world = mediapipe_world(posed(0.8, pitch=20))        # what the crop shows
    on_axis = _size_error(posed(0.8, pitch=20), world)
    for swing in (15, 30, 45):
        p = posed(0.8, pitch=20, swing=swing)
        assert abs(_size_error(p, world) - on_axis) < 0.005, (
            f"swung {swing} degrees: {_size_error(p, world):+.1%} against {on_axis:+.1%}")
    rays = rays_from_pixels(project_left(p), INTR)
    true = float(-p[:, 2].mean())
    flat = rays[:, :2] - rays[:, :2].mean(axis=0)
    in_plane = np.sqrt(((world[:, :2] - world[:, :2].mean(axis=0)) ** 2).sum() / (flat ** 2).sum())
    assert abs(in_plane / true - 1.0) > 0.10, "45 degrees should defeat the image plane"


def test_size_depth_is_blind_to_rotation_and_mirroring():
    """Nothing may depend on the model's axes lining up with the image's."""
    p = posed(0.8, pitch=30)
    rays, world = rays_from_pixels(project_left(p), INTR), mediapipe_world(p)
    a = np.radians(40)
    turned, mirrored = world.copy(), world.copy()
    turned[:, :2] = world[:, :2] @ np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]).T
    mirrored[:, 0] *= -1
    base = size_depth(rays, world)
    assert abs(size_depth(rays, turned) - base) < 1e-9
    assert abs(size_depth(rays, mirrored) - base) < 1e-9


def test_size_depth_reports_nothing_rather_than_nonsense():
    p = posed(0.8)
    rays, world = rays_from_pixels(project_left(p), INTR), mediapipe_world(p)
    assert np.isnan(size_depth(rays, np.zeros((21, 3))))             # no size at all
    assert np.isnan(size_depth(rays, world * 50))                    # a 4 m hand
    assert np.isnan(size_depth(np.full((21, 3), np.nan), world))
    holes = world.copy()
    holes[:6] = np.nan                                               # a few missing is fine
    assert abs(size_depth(rays, holes) / 0.8 - 1.0) < 0.1


def test_scale_calibration_learns_this_persons_hand():
    """MediaPipe's hand is generic. A real one 15% bigger reads 13% too near
    until the ratio is learned, and the uncertainty says so until it is."""
    rng = np.random.default_rng(8)
    cal = ScaleCalibration()
    assert cal.ratio == 1.0 and not cal.ready
    _, before = cal.correct(0.70)
    for _ in range(60):
        true = rng.uniform(0.5, 1.2)
        cal.observe(true + rng.normal(0, 0.015), true * 0.87)
    depth, after = cal.correct(0.87 * 0.80)
    assert cal.ready and abs(cal.ratio - 1 / 0.87) < 0.02, cal.ratio
    assert abs(depth - 0.80) < 0.015, depth
    assert after < before / 2, (before, after)


def test_scale_calibration_cannot_be_moved_by_a_flipping_surface():
    """The failure it guards against -- a reading that lands on the wall one
    frame in three -- is exactly the kind a median ignores."""
    rng = np.random.default_rng(9)
    cal = ScaleCalibration()
    for i in range(90):
        true = 0.8
        measured = true + (0.25 if i % 3 == 0 else 0.0) + rng.normal(0, 0.01)
        cal.observe(measured, true)
    assert abs(cal.ratio - 1.0) < 0.03, cal.ratio


def test_scale_calibration_ignores_the_impossible():
    cal = ScaleCalibration()
    for _ in range(40):
        cal.observe(0.8, 0.8)
        cal.observe(3.0, 0.8)                       # no hand is 3.75x a hand
        cal.observe(float("nan"), 0.8)
        cal.observe(0.8, 0.0)
    assert abs(cal.ratio - 1.0) < 1e-9
    assert np.isnan(cal.correct(float("nan"))[0])


def test_palm_triangulation_is_a_median_over_the_palm():
    d = np.full(21, np.nan)
    s = np.full(21, np.nan)
    d[list(PALM_IDX)] = [0.80, 0.81, 0.35, 0.79, 0.80]    # one joint matched elsewhere
    s[list(PALM_IDX)] = 0.015
    d[8], s[8] = 2.5, 0.015                               # a fingertip is not the palm
    depth, sigma = palm_triangulation(d, s)
    assert abs(depth - 0.80) < 0.011 and abs(sigma - 0.015) < 1e-9
    d[[0, 5, 9]] = np.nan
    assert np.isnan(palm_triangulation(d, s)[0]), "two joints are not a palm"
    assert palm_triangulation(np.full(21, 0.3), np.full(21, 0.001))[1] == 0.010   # floor


def test_reference_is_triangulation_with_a_sanity_bound():
    """Agreeing, they combine by precision -- which means triangulation."""
    depth, sigma = hand_reference(0.80, 0.015, 0.84, 0.04)
    assert abs(depth - 0.805) < 0.003, depth
    assert sigma < 0.015


def test_reference_drops_a_triangulation_that_size_contradicts():
    """Right-view landmarks matched to the wrong thing triangulate to a
    confident 35 cm. A hand cannot be 2.3 times the size of a hand."""
    assert hand_reference(0.35, 0.003, 0.80, 0.04) == (0.80, 0.04)
    # and uncalibrated size, being vague, contradicts much less
    depth, _ = hand_reference(0.62, 0.010, 0.80, 0.12)
    assert abs(depth - 0.62) < 0.01


def test_reference_with_one_source_or_none():
    nan = float("nan")
    assert hand_reference(0.8, 0.015, nan, nan) == (0.8, 0.015)
    assert hand_reference(nan, nan, 0.9, 0.05) == (0.9, 0.05)
    assert all(np.isnan(hand_reference(nan, nan, nan, nan)))
    assert hand_reference(0.8, 0.0, 0.9, 0.05) == (0.9, 0.05)       # sigma 0 is no measurement


# --------------------------------------------------------------------------
# is the right view looking at the same hand?
# --------------------------------------------------------------------------

def other_hand(p, dx):
    """The person's other hand: a mirror image, `dx` metres to the side."""
    q = p.copy()
    q[:, 0] = -(p[:, 0] - p[:, 0].mean()) + p[:, 0].mean() + dx
    return q


def test_same_hand_recognises_one_hand_in_two_views():
    rng = np.random.default_rng(12)
    for palm_d in (0.4, 0.8, 1.5, 2.5):
        for pitch in (0, 40, -40):
            p = posed(palm_d, pitch=pitch)
            for _ in range(20):
                pl = project_left(p) + rng.normal(0, 1.5, (21, 2))
                pr = project_right(p) + rng.normal(0, 1.5, (21, 2))
                assert same_hand(pl, pr, FX, BASELINE, palm_d), (palm_d, pitch)
                assert same_hand(pl, pr, FX, BASELINE), "and with no idea of the depth"


def test_same_hand_refuses_the_persons_other_hand():
    """Each view's landmarker has picked a different hand, level with each
    other. Rows agree and every disparity is positive -- the old row check
    passes this -- and what it triangulates to is 21 depths that agree with
    each other perfectly and are all wrong. Shape is what tells them apart."""
    p = posed(0.8, pitch=10)
    for dx in (0.10, 0.25, 0.40):
        q = other_hand(p, -dx)                       # further left, so disparity > 0
        pl, pr = project_left(p), project_right(q)
        assert np.isfinite(triangulate_depths(pl, pr, FX, BASELINE)).sum() >= 11, (
            "the scene must get past the row check to mean anything")
        assert not same_hand(pl, pr, FX, BASELINE), f"other hand {dx * 100:.0f} cm away"


def test_same_hand_accepts_fingers_pointing_at_the_lens_from_rig_distance():
    """The rig: a hand 20-35 cm from the lens, reaching in, so its fingers
    point at the camera. Depth relief is most of its distance, the disparities
    scatter by 15-25%, and the old scatter-only rule refused the right view on
    every frame -- while every joint in it triangulated perfectly."""
    rng = np.random.default_rng(13)
    for palm_d, pitch in ((0.35, 70), (0.25, 45), (0.25, 70), (0.25, 85), (0.20, 45)):
        p = posed(palm_d, pitch=pitch)
        for _ in range(10):
            pl = project_left(p) + rng.normal(0, 2.0, (21, 2))
            pr = project_right(p) + rng.normal(0, 2.0, (21, 2))
            disparity = pl[:, 0] - pr[:, 0]
            scatter = np.median(np.abs(disparity - np.median(disparity))) / np.median(disparity)
            assert same_hand(pl, pr, FX, BASELINE, max_row_error=40.0), (palm_d, pitch, scatter)
    assert scatter > 0.12, "the scene should be one the scatter rule alone would refuse"


def test_same_hand_still_refuses_the_other_hand_up_close():
    p = posed(0.25, pitch=45)
    pl, pr = project_left(p), project_right(other_hand(p, -0.02))
    assert not same_hand(pl, pr, FX, BASELINE, max_row_error=40.0)


def test_same_hand_refuses_a_depth_the_hands_size_rules_out():
    """Somebody else's hand, the same shape, so shape cannot tell.

    A quarter of a metre to the side, the disparity puts "the hand" 25 cm from
    the lens, where it would measure 1.5 cm across: refused on its own
    evidence. Only 12 cm to the side it would be a small but possible hand at
    40 cm, and it takes knowing that this hand is at 80 to refuse it.
    """
    p = posed(0.8)
    far = project_right(p + [-0.25, 0.0, 0.0])
    near = project_right(p + [-0.12, 0.0, 0.0])
    pl = project_left(p)
    assert not same_hand(pl, far, FX, BASELINE)
    assert same_hand(pl, near, FX, BASELINE), "nothing in the pixels rules this one out"
    assert not same_hand(pl, near, FX, BASELINE, expected_depth=0.8)


def test_same_hand_refuses_different_rows_and_behind_the_camera():
    p = posed(0.8)
    pl, pr = project_left(p), project_right(p)
    assert not same_hand(pl, pr + [0.0, 40.0], FX, BASELINE)
    assert not same_hand(pr, pl, FX, BASELINE), "negative disparity is no hand at all"
    few = pr.copy()
    few[:12, 1] += 40.0                              # only 9 joints still line up
    assert not same_hand(pl, few, FX, BASELINE)


# --------------------------------------------------------------------------
# bone calibration
# --------------------------------------------------------------------------

def test_bone_calibration_converges_on_the_truth():
    """Per-frame bone estimates are noisy; the hand is not."""
    truth, _ = synthetic_hand()
    true_len = bone_lengths(truth)
    rng = np.random.default_rng(5)
    cal = BoneCalibration()
    assert not cal.ready
    for _ in range(60):
        cal.observe(true_len * (1.0 + rng.normal(0, 0.08, len(true_len))))
    assert cal.ready
    # 60 samples of 8% noise put the standard error of each median near 1.3%,
    # so the worst of 21 bones lands around 3-4%; tighter than 5% would be
    # asserting on the seed rather than on the estimator
    err = np.abs(cal.lengths() / true_len - 1.0)
    assert err.max() < 0.05, err.max()


def test_bone_calibration_ignores_impossible_lengths():
    cal = BoneCalibration()
    for _ in range(40):
        cal.observe(np.full(len(BONES), 0.04))
        cal.observe(np.full(len(BONES), 9.9))       # nonsense, must be dropped
    assert abs(float(np.median(cal.lengths())) - 0.04) < 1e-9


# --------------------------------------------------------------------------
# the solver
# --------------------------------------------------------------------------

def biased_model(d, scale=1.12):
    """What MediaPipe actually supplies: a coherent hand of slightly wrong size.

    The solver tests pass this rather than the truth, because a prior that is
    already correct would be doing the solver's job for it.
    """
    anchor = float(np.median(d[list(PALM_IDX)]))
    return anchor + (d - anchor) * scale


def test_solver_is_a_no_op_on_perfect_data():
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    got = solve_depths(rays, d, d, np.full(21, 0.005), bone_lengths(truth))
    assert np.abs(got - d).max() < 1e-4, np.abs(got - d).max()


def test_bones_rescue_a_joint_with_no_measurement_at_all():
    """A fingertip the depth map missed and the right view did not see."""
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    data = d.copy()
    sigma = np.full(21, 0.006)
    for tip in TIPS:
        data[tip] = np.nan
        sigma[tip] = np.nan
    got = solve_depths(rays, np.where(np.isfinite(data), data, 0.8), data, sigma,
                       bone_lengths(truth), prior_d=biased_model(d))
    err = np.abs(got[list(TIPS)] - d[list(TIPS)])
    assert err.max() < 0.006, f"unmeasured tips off by {err.max() * 1000:.1f} mm"


def test_bones_outvote_a_wrong_measurement():
    """The live failure: one joint reads the background 20 cm behind."""
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    data = d.copy()
    data[8] += 0.20
    sigma = np.full(21, 0.006)
    sigma[8] = 0.02                                  # and it looks plausible
    got = solve_depths(rays, data, data, sigma, bone_lengths(truth),
                       prior_d=biased_model(d))
    assert abs(got[8] - d[8]) < 0.02, f"off by {abs(got[8] - d[8]) * 100:.1f} cm"


def test_precise_measurements_survive_a_prior_that_is_centimetres_out():
    """The rig, and the bug it found. A hand 25 cm from the lens, fingers
    pointing at it: triangulation there is good to a millimetre, and the model
    prior -- a generic hand 20% too big, with 17 cm of depth relief to be 20%
    wrong about -- is out by up to 4 cm.

    "Does this reading fight the prior" used to be asked in units of the
    READING's sigma alone. Every exact measurement was tens of sigma from the
    prior, was started at the prior, and was then dropped as an outlier for
    being tens of sigma from where it had been started. The hand came out AT
    the prior: 15% off about the lens, every movement magnified to match.
    """
    p = posed(0.25, pitch=70)
    d = -p[:, 2]
    rays = rays_from_pixels(project_left(p), INTR)
    data = triangulate_depths(project_left(p), project_right(p), FX, BASELINE, max_row_error=40.0)
    sigma = triangulation_sigma(data, FX, BASELINE)
    assert sigma.max() < 0.003, "the scene should be one where triangulation is millimetre-good"
    prior = biased_model(d, scale=1.2)
    assert np.abs(prior - d).max() > 0.015, "and the prior centimetres out"
    for bones in (None, bone_lengths(p) * 1.2):              # the model's bones are 20% out too
        got = solve_depths(rays, data, data, sigma, bones, prior_d=prior)
        err = np.linalg.norm(points_from_depths(rays, got) - p, axis=1)
        assert np.median(err) < 0.002, f"median {np.median(err) * 1000:.1f} mm: the measurements were not believed"
        assert abs(got.mean() / d.mean() - 1.0) < 0.02, f"hand scaled x{got.mean() / d.mean():.2f} about the lens"


def test_fingertips_nearer_than_eight_centimetres_are_solved_where_they_are():
    """Reaching into the slot end-on with the palm 12-15 cm from the lens puts
    the fingertips at 5-7 cm. The solver used to clip every depth at 8 cm: those
    tips were pinned there, deaf to motion, and their exact triangulations then
    dropped for disagreeing with the clamp."""
    p = posed(0.20, pitch=60)            # this file's hand is long-fingered: 14 cm of relief
    d = -p[:, 2]
    assert d.min() < 0.075, f"the scene should put a fingertip inside the old clip, nearest is {d.min():.3f}"
    rays = rays_from_pixels(project_left(p), INTR)
    data = triangulate_depths(project_left(p), project_right(p), FX, BASELINE, max_row_error=80.0)
    sigma = triangulation_sigma(data, FX, BASELINE)
    got = solve_depths(rays, data, data, sigma, bone_lengths(p), prior_d=biased_model(d, scale=1.1))
    err = np.abs(got - d)
    assert err.max() < 0.003, f"worst joint {err.max() * 1000:.1f} mm out, at true depth {d[err.argmax()]:.3f} m"
    assert not np.isclose(got, 0.08).any(), "nothing sits on the old clip"


def test_recent_scale_bridges_the_frames_triangulation_misses():
    """The second lens drops out for a few frames. The palm used to step from
    its triangulated depth to the person-calibrated size depth and back --
    centimetres, in one frame. It now carries what size was worth a moment ago."""
    from fuse3d import RecentScale
    recent, true_d = RecentScale(), 0.25
    size_reads = 0.88                                   # this POSE reads 12% near; the person's median is 1.0
    t = 0.0
    for _ in range(12):                                 # paired frames
        recent.observe(true_d, true_d * size_reads, t)
        t += 1 / 30
    d, sigma = recent.correct(true_d * size_reads, t)
    assert abs(d - true_d) < 0.002, f"hand-over step {abs(d - true_d) * 1000:.1f} mm (was {true_d * (1 - size_reads) * 1000:.0f})"
    assert 0.003 < sigma < 0.01
    # the hand moves 4 cm toward the lens while unpaired: apparent size says so, and it is followed
    d2, _ = recent.correct(0.21 * size_reads, t + 0.1)
    assert abs(d2 - 0.21) < 0.003
    # the claim fades, then stops: after a second the person-level calibration is on its own again
    assert recent.correct(true_d * size_reads, t + 0.5)[1] > 3 * sigma
    assert recent.correct(true_d * size_reads, t + 1.5) is None
    # and it does not learn from a pairing that implies an impossible hand
    fresh = RecentScale()
    fresh.observe(0.25, 0.05, 0.0)
    assert fresh.correct(0.05, 0.01) is None
    fresh.observe(float("nan"), 0.25, 0.0)
    assert fresh.correct(0.25, 0.01) is None


def test_solver_without_bones_still_returns_something_sane():
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    got = solve_depths(rays, d, d, np.full(21, 0.006), None)
    assert np.isfinite(got).all() and (got > 0.08).all()


def test_solver_survives_all_measurements_missing():
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    nan21 = np.full(21, np.nan)
    got = solve_depths(rays, np.full(21, 0.8), nan21, nan21, bone_lengths(truth),
                       prior_d=np.full(21, 0.8))
    assert np.isfinite(got).all() and (got > 0.08).all()


def test_solver_does_not_stretch_bones():
    truth, d = synthetic_hand()
    rays = rays_from_pixels(project_left(truth), INTR)
    rng = np.random.default_rng(7)
    data = d + rng.normal(0, 0.02, 21)
    data[[4, 12, 20]] += 0.25                        # several background latches
    got = solve_depths(rays, data, data, np.full(21, 0.01), bone_lengths(truth),
                       prior_d=biased_model(d))
    ratio = bone_lengths(points_from_depths(rays, got)) / bone_lengths(truth)
    assert ratio.max() < 1.1 and ratio.min() > 0.9, (ratio.min(), ratio.max())


# --------------------------------------------------------------------------
# the claim the whole module exists to make
# --------------------------------------------------------------------------

def test_fusion_beats_every_single_source():
    """Solving all inputs together must beat any one of them on its own.

    Each source is given its real failure mode: the depth map drops fingertips
    and occasionally reads the surface behind them, triangulation is noisy and
    degrades with distance, and the model prior is biased but complete.
    """
    rng = np.random.default_rng(11)
    errs = {"depth map": [], "triangulation": [], "model only": [], "fused": []}

    for _ in range(120):
        truth, d = synthetic_hand(palm_d=0.7 + 0.5 * rng.random())
        pl = project_left(truth)
        rays = rays_from_pixels(pl, INTR)
        true_len = bone_lengths(truth)

        # depth map: good on the palm, missing or wrong on the fingers
        d_map = d + rng.normal(0, 0.006, 21)
        d_sig = np.full(21, 0.006)
        for i in range(21):
            if i in TIPS:
                r = rng.random()
                if r < 0.45:
                    d_map[i], d_sig[i] = np.nan, np.nan
                elif r < 0.70:
                    d_map[i] += rng.uniform(0.10, 0.40)   # the wall behind
                    d_sig[i] = 0.02

        # triangulation: pixel noise in both views, quadratic in depth
        pr = project_right(truth) + rng.normal(0, 1.2, (21, 2))
        d_tri = triangulate_depths(pl + rng.normal(0, 1.2, (21, 2)), pr, FX, BASELINE)
        t_sig = triangulation_sigma(np.where(np.isfinite(d_tri), d_tri, 1.0),
                                    FX, BASELINE)

        # model prior: complete, coherent, but biased
        palm_anchor = float(np.nanmedian(d_map[list(PALM_IDX)]))
        rel = d - d[list(PALM_IDX)].mean()
        d_model = palm_anchor + rel * 1.15 + rng.normal(0, 0.004, 21)

        fused, fsig = fuse_measurements([d_map, d_tri], [d_sig, t_sig])
        solved = solve_depths(rays, np.where(np.isfinite(fused), fused, d_model),
                              fused, fsig, true_len, prior_d=d_model)

        def err(depths):
            return np.linalg.norm(points_from_depths(rays, depths) - truth, axis=1)

        errs["depth map"].append(err(np.where(np.isfinite(d_map), d_map, palm_anchor)))
        errs["triangulation"].append(err(np.where(np.isfinite(d_tri), d_tri, palm_anchor)))
        errs["model only"].append(err(d_model))
        errs["fused"].append(err(solved))

    stats = {k: np.concatenate(v) for k, v in errs.items()}
    fused = stats["fused"]
    for name in ("depth map", "triangulation", "model only"):
        for label, q in (("median", 50), ("p90", 90)):
            a = float(np.percentile(fused, q))
            b = float(np.percentile(stats[name], q))
            assert a < b, (f"fused {label} {a * 1000:.1f} mm is not better than "
                           f"{name} {b * 1000:.1f} mm")

    # The gross errors are the point. The depth map alone puts its worst 1% of
    # joints a third of a metre out; fusing has to collapse that, not merely
    # improve the average, because a single flung joint is what is visible.
    assert float(np.percentile(fused, 99)) < float(
        np.percentile(stats["depth map"], 99)) / 5.0
    assert float(np.percentile(fused, 99)) < 0.030
    assert float(fused.max()) < 0.060


# --------------------------------------------------------------------------

def _run() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
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
