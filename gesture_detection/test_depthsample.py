#!/usr/bin/env python3
"""Tests for depthsample.py -- no camera required.

Run:  python test_depthsample.py

Unlike the patch tests in test_fuse3d.py, which hand near_surface a bag of
depths, these render a hand into an actual depth image -- fingers a few pixels
wide in front of a wall, edges smeared the way a stereo matcher smears them,
holes where it gave up -- because the failures this module exists for are
about WHERE in the image a patch lands, and a bag of depths has no where.

`naive_joint_depths` is the sampler as it was, kept here as the thing to beat:
a test that the new one is accurate says little unless the old one, on the
same scene, is not.
"""

from __future__ import annotations

import sys

import numpy as np

from depthsample import (JOINT_HALF_WIDTH, PALM_HALF_WIDTH, SAMPLE_TOWARD,
                         at_sample_points, gate_half_width, joint_tolerance,
                         locate_palm, patch_depths, patch_radius,
                         sample_joint_depths, sample_palm_depth,
                         sample_unbiased)
from fuse3d import (ScaleCalibration, depthmap_sigma, fuse_measurements,
                    near_surface, points_from_depths, rays_from_pixels,
                    solve_depths, triangulate_depths, triangulation_sigma)
from handmodel import (BONES, PALM_IDX, DepthSignEstimator, bone_lengths,
                       model_relative_depth)

FX = 523.825                       # HD720 on the ZED 2
SHAPE = (480, 640)
CX, CY = 320.0, 240.0
INTR = (FX, FX, CX, CY)
BASELINE = 0.120075
TIPS = (4, 8, 12, 16, 20)


# --------------------------------------------------------------------------
# a hand, and a depth image of it
# --------------------------------------------------------------------------

def hand(palm_d=0.80, pitch=0.0, roll=0.0):
    """21 joints, camera frame (+X right, +Y up, +Z toward the camera).

    Real proportions, because the patches are sized against them: a 9 cm
    palm, knuckles 2 cm apart, fingers 8.5 cm. `pitch` tips the fingers toward
    the camera, `roll` turns the hand about its long axis.
    """
    j = np.zeros((21, 3))
    j[1] = [-0.030, 0.025, 0.0]
    j[2] = [-0.055, 0.050, 0.005]
    j[3] = [-0.070, 0.078, 0.008]
    j[4] = [-0.080, 0.100, 0.010]
    for k, base in enumerate((5, 9, 13, 17)):
        x = (k - 1.5) * 0.020
        j[base] = [x, 0.090 - 0.004 * abs(k - 1), 0.0]
        for s, (length, dz) in enumerate(((0.040, 0.004), (0.025, 0.006),
                                          (0.020, 0.006)), start=1):
            j[base + s] = j[base + s - 1] + [x * 0.12, length, dz]
    a, b = np.radians(pitch), np.radians(roll)
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    return j @ (rx @ ry).T + [0.0, -0.06, -palm_d]


def project(j, fx=FX):
    d = -j[:, 2]
    return np.stack([CX + j[:, 0] * fx / d, CY - j[:, 1] * fx / d], axis=1)


def model_rel(j):
    """What handmodel.model_relative_depth gives for a perfect model."""
    return j[:, 2] - np.mean(j[list(PALM_IDX), 2])


def palm_truth(j):
    return float(np.mean(j[list(PALM_IDX), 2]))


def capsule(dm, a, b, da, db, hw, cut=None):
    """A bone as a rounded bar, nearest surface winning. `cut` squares off the
    far end that many pixels past `b` instead of a full half-width."""
    h, w = dm.shape
    x0, x1 = int(max(0, min(a[0], b[0]) - hw - 1)), int(min(w, max(a[0], b[0]) + hw + 2))
    y0, y1 = int(max(0, min(a[1], b[1]) - hw - 1)), int(min(h, max(a[1], b[1]) + hw + 2))
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1]
    ab = np.asarray(b, float) - np.asarray(a, float)
    along = np.clip(((xs - a[0]) * ab[0] + (ys - a[1]) * ab[1]) / max(float(ab @ ab), 1e-9), 0, 1)
    dist = np.hypot(xs - (a[0] + along * ab[0]), ys - (a[1] + along * ab[1]))
    depth = da + along * (db - da)
    sub = dm[y0:y1, x0:x1]
    hit = (dist <= hw) & (depth < sub)
    if cut is not None:
        length = max(float(np.linalg.norm(ab)), 1e-9)
        hit &= ((xs - a[0]) * ab[0] + (ys - a[1]) * ab[1]) / length <= length + cut
    sub[hit] = depth[hit]


def triangle(dm, p, d):
    """A flat facet of the palm. NOT z-buffered: the palm is one surface, so
    inside it the plane is the truth and its rim must not show through."""
    h, w = dm.shape
    p = np.asarray(p, float)
    x0, y0 = np.maximum(np.floor(p.min(0)).astype(int), 0)
    x1, y1 = np.minimum(np.ceil(p.max(0)).astype(int) + 1, (w, h))
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1]
    t = np.array([p[1] - p[0], p[2] - p[0]]).T
    if abs(np.linalg.det(t)) < 1e-9:
        return
    inv = np.linalg.inv(t)
    l1 = inv[0, 0] * (xs - p[0, 0]) + inv[0, 1] * (ys - p[0, 1])
    l2 = inv[1, 0] * (xs - p[0, 0]) + inv[1, 1] * (ys - p[0, 1])
    inside = (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
    depth = d[0] + l1 * (d[1] - d[0]) + l2 * (d[2] - d[0])
    dm[y0:y1, x0:x1][inside] = depth[inside]


#: How far inside the fingertip's outline its landmark sits. An assumption,
#: and the one these scenes lean on most: MediaPipe marks the tip of the
#: finger, not the middle of its last pad.
TIP_INSET = 0.003

PALM_TRIS = [(0, 1, 5), (0, 5, 9), (0, 9, 13), (0, 13, 17)]
PALM_RIM = [(0, 1), (1, 5), (5, 9), (9, 13), (13, 17), (0, 17)]


def render(j, wall=2.0, fx=FX, extra=()):
    """Depth image (positive metres) of the hand in front of a wall.

    `extra` is other things in the scene, as (pixel a, pixel b, depth a,
    depth b, half-width in pixels).
    """
    px, d = project(j, fx), -j[:, 2]
    dm = np.full(SHAPE, float(wall))
    finger = 0.008 * fx / float(d.mean())
    for a, b in PALM_RIM:
        capsule(dm, px[a], px[b], d[a], d[b], finger)
    for tri in PALM_TRIS:
        triangle(dm, px[list(tri)], d[list(tri)])
    for a, b in BONES:
        if (a, b) in PALM_RIM or (a, b) == (0, 5):
            continue
        # A bar's round end reaches a half-width past its last joint, which
        # would bury the tip landmark 8 mm inside the finger. MediaPipe puts
        # it at the fingertip, so the finger is cut off TIP_INSET past it.
        cut = TIP_INSET * fx / float(d[b]) if b in TIPS else None
        capsule(dm, px[a], px[b], d[a], d[b], finger, cut)
    for a, b, da, db, hw in extra:
        capsule(dm, a, b, da, db, hw)
    return dm


def erode(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out &= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def degrade(dm, wall, rng, smear=2, dropout=0.4, noise=0.004):
    """What a stereo matcher does to it: noise, holes, and -- the one that
    matters -- a band along every outline where the depth is neither surface
    but somewhere between the two."""
    out = dm + rng.normal(0, noise, dm.shape)
    on_hand = dm < wall - 1e-6
    band = (on_hand & ~erode(on_hand, smear)) | (~on_hand & ~erode(~on_hand, smear))
    mix = rng.random(dm.shape)
    near = np.where(on_hand, dm, float(dm[on_hand].mean()))
    out[band] = (near * (1 - mix) + wall * mix)[band]
    out[rng.random(dm.shape) < dropout] = np.nan
    return out


def cloud(dm):
    """Depth image -> the XYZRGBA layout the ZED hands over, Z negative."""
    pc = np.full(dm.shape + (4,), np.nan, dtype=np.float32)
    pc[..., 2] = -dm
    return pc


def naive_joint_depths(pc, px, palm_z, rel, radius=4, tol=0.05):
    """The sampler as it was: centred on the landmark, radius fixed in pixels."""
    out = np.full(21, np.nan)
    for i in range(21):
        z = patch_depths(pc, px[i], radius)
        near = z[np.abs(z - (palm_z + rel[i])) <= tol]
        if len(near) >= 3:
            depth, _ = near_surface(-near, window=0.015)
            if np.isfinite(depth):
                out[i] = -depth
    return out


# --------------------------------------------------------------------------
# where to look
# --------------------------------------------------------------------------

def hand_fraction(dm, wall, uv, radius):
    u, v = int(round(uv[0])), int(round(uv[1]))
    return float((dm[v - radius:v + radius + 1, u - radius:u + radius + 1] < wall - 1e-6).mean())


def test_a_patch_on_the_landmark_is_part_wall_and_a_sample_point_is_not():
    """The whole problem, and the first third of the answer, in one picture."""
    j = hand()
    dm, px = render(j), project(j)
    at = at_sample_points(px)
    for tip in TIPS:
        on_landmark = hand_fraction(dm, 2.0, px[tip], 4)
        on_sample = hand_fraction(dm, 2.0, at[tip], 4)
        assert on_landmark < 0.85, f"tip {tip}: {on_landmark:.0%} hand on the landmark"
        assert on_sample > 0.95, f"tip {tip}: only {on_sample:.0%} hand at the sample point"


def test_joints_on_the_centreline_are_read_in_place():
    px = project(hand())
    at = at_sample_points(px)
    for i in range(21):
        if i not in SAMPLE_TOWARD:
            assert np.allclose(at[i], px[i]), i
        else:
            assert np.linalg.norm(at[i] - px[i]) > 2.0, i


def test_no_sample_point_moves_toward_a_less_reliable_joint():
    """Every move is inward: toward the palm, never toward a fingertip."""
    for joint, (to, frac) in SAMPLE_TOWARD.items():
        assert 0.0 < frac < 0.5, (joint, frac)
        assert to in PALM_IDX or to == joint - 1, (joint, to)


# --------------------------------------------------------------------------
# per-joint depth
# --------------------------------------------------------------------------

def test_every_joint_is_recovered_whatever_the_pose():
    """Reading part-way along a bone must cost nothing once carried back."""
    for pose in ({}, {"pitch": 40}, {"pitch": -30}, {"roll": 35},
                 {"pitch": 25, "roll": -25}):
        j = hand(**pose)
        got = sample_joint_depths(cloud(render(j)), project(j), palm_truth(j), model_rel(j))
        assert np.isfinite(got).all(), (pose, np.flatnonzero(~np.isfinite(got)))
        err = np.abs(got - j[:, 2])
        assert err.max() < 0.004, f"{pose}: joint {err.argmax()} off by {err.max() * 1000:.1f} mm"


def test_a_reading_is_carried_back_to_its_joint():
    """A finger pointing at the camera: its sample point is 5 mm behind its tip.

    The second call has a flat model, which carries nothing back, to show the
    scene would catch a reading left where it was taken.
    """
    j = hand(pitch=60)
    pc, px = cloud(render(j)), project(j)
    carried = sample_joint_depths(pc, px, palm_truth(j), model_rel(j))
    for tip in TIPS:
        left = sample_joint_depths(pc, px, j[tip, 2], np.zeros(21))
        assert abs(carried[tip] - j[tip, 2]) < 0.002, tip
        assert abs(left[tip] - j[tip, 2]) > 0.0035, f"tip {tip}: the shift should show uncorrected"


def _tips_against_a_close_wall(fx, trials=40, seed=0):
    rng = np.random.default_rng(seed)
    new, old, missing = [], [], [0, 0]
    for _ in range(trials):
        j = hand(pitch=rng.uniform(-10, 30))
        wall = 0.84                                  # inside the 5 cm window
        pc = cloud(degrade(render(j, wall=wall, fx=fx), wall, rng))
        px = project(j, fx) + rng.normal(0, fx / FX, (21, 2))    # landmark jitter
        radius = patch_radius(0.80, fx, JOINT_HALF_WIDTH, 2, 8, 4)
        for k, got in enumerate((
                sample_joint_depths(pc, px, palm_truth(j), model_rel(j), radius=radius),
                naive_joint_depths(pc, px, palm_truth(j), model_rel(j)))):
            e = np.abs(got - j[:, 2])[list(TIPS)]
            (new, old)[k].extend(e[np.isfinite(e)])
            missing[k] += int(np.isnan(e).sum())
    return np.array(new), np.array(old), missing


def test_fingertips_against_a_close_wall_at_hd720():
    """A wall 4 cm behind the palm passes every plausibility window, the
    outline is smeared between the two surfaces, and 40% of pixels are holes."""
    new, old, missing = _tips_against_a_close_wall(FX)
    assert missing[0] == 0, f"{missing[0]} fingertips with no reading"
    assert np.median(new) < 0.0015 and new.max() < 0.006, (np.median(new), new.max())
    assert np.median(new) < np.median(old) * 0.5, (np.median(new), np.median(old))
    assert np.percentile(new, 90) < np.percentile(old, 90) * 0.6
    assert new.max() < old.max() * 0.6


def test_fingertips_against_a_close_wall_at_vga():
    """Where a fixed radius hurts: at VGA a finger is 5 pixels across and the
    old 9-pixel patch is wider than the finger it is reading.

    Sized to the finger and read inside it: 6.9 mm median against 11.0, and
    half as many tips more than a centimetre out. Better, and still not good
    -- with two pixels of smear either side, one column of a VGA finger is
    clean, and one tip in seven now gets no reading at all -- which is what
    the solver's bones and the second camera are for. Asserted as a comparison
    because the absolute figure is this scene's, not the camera's.
    """
    new, old, missing = _tips_against_a_close_wall(FX / 2)
    assert np.median(new) < np.median(old) * 0.75, (np.median(new), np.median(old))
    assert np.mean(new > 0.010) < np.mean(old > 0.010) * 0.7
    assert np.percentile(new, 90) < np.percentile(old, 90)
    assert missing[0] < 0.20 * 40 * 5, missing


def test_only_the_fingertips_move_and_the_reason_still_holds():
    """A moved reading is carried back with the MODEL's depths, so the model's
    pose error leaks into it in proportion to the bone's length.

    With the model 20 degrees out, fingertips are still better off moved -- a
    2 cm bone leaks little and their patch really is part wall. The wrist and
    knuckles hang off 9 cm bones and have no mixed patch to escape: moved 30%
    toward the palm, the wrist read 8.6 mm out here instead of 1.3. If someone
    adds them back to SAMPLE_TOWARD, the last assertion is what they will meet.
    """
    assert set(SAMPLE_TOWARD) == set(TIPS)
    rng = np.random.default_rng(3)
    new, old, palm = [], [], []
    for _ in range(30):
        pitch = rng.uniform(-20, 30)
        j, wrong = hand(pitch=pitch), hand(pitch=pitch + 20 * rng.choice([-1, 1]))
        wall = 0.84
        pc = cloud(degrade(render(j, wall=wall), wall, rng))
        px = project(j) + rng.normal(0, 1.0, (21, 2))
        got = np.abs(sample_joint_depths(pc, px, palm_truth(j), model_rel(wrong)) - j[:, 2])
        was = np.abs(naive_joint_depths(pc, px, palm_truth(j), model_rel(wrong)) - j[:, 2])
        new.extend(got[list(TIPS)])
        old.extend(was[list(TIPS)])
        palm.extend(got[list(PALM_IDX)])
    assert np.nanmedian(new) < np.nanmedian(old) * 0.8, (np.nanmedian(new), np.nanmedian(old))
    assert np.nanpercentile(palm, 90) < 0.003, np.nanpercentile(palm, 90)


# --------------------------------------------------------------------------
# the palm anchor
# --------------------------------------------------------------------------

def test_palm_depth_means_the_same_thing_at_any_tilt():
    for pose in ({}, {"pitch": 40}, {"pitch": -30}, {"roll": 40}, {"roll": -40}):
        j = hand(**pose)
        got = sample_palm_depth(cloud(render(j)), project(j), model_rel=model_rel(j))
        assert got is not None and abs(got - palm_truth(j)) < 0.003, (
            f"{pose}: off by {(got - palm_truth(j)) * 1000:.1f} mm")


def test_a_rolled_palm_pools_into_one_surface():
    """Rolled 55 degrees the knuckles span 5 cm of depth, more than
    near_surface's window. Pooled raw that is several surfaces, and
    nearest-first answers with the nearest knuckles."""
    j = hand(roll=55)
    pc, px = cloud(render(j)), project(j)
    raw = sample_palm_depth(pc, px)
    referred = sample_palm_depth(pc, px, model_rel=model_rel(j))
    assert abs(referred - palm_truth(j)) < 0.005, referred - palm_truth(j)
    assert abs(raw - palm_truth(j)) > 2 * abs(referred - palm_truth(j))


def test_the_gate_refuses_a_wall_showing_through_the_hand():
    """The latch. Skin is low-texture, and a matcher that cannot find the hand
    matches the wall through it: the patch is one clean, coherent surface and
    it is the wrong one. Nothing about the pixels says so -- only knowing
    where the hand is from somewhere else."""
    j = hand()
    dm = render(j)
    dm[dm < 1.9] = 1.05                              # the hand reads as the wall
    pc, px = cloud(dm), project(j)
    assert abs(sample_palm_depth(pc, px) - (-1.05)) < 0.01, "ungated, it IS the wall"
    got, (pool, kept) = sample_palm_depth(pc, px, ref=-0.80, ref_sigma=0.015,
                                          with_counts=True)
    assert got is None, "nothing here is the hand, and it must say so"
    assert pool > 100 and kept == 0


def test_the_gate_outranks_the_previous_answer():
    """How the latch used to hold: once the anchor was the wall, the wall was
    the prior, and the prior was the only gate there was."""
    j = hand()
    dm = render(j)
    dm[dm < 1.9] = 1.05
    got = sample_palm_depth(cloud(dm), project(j), ref=-0.80, ref_sigma=0.015,
                            prior=-1.05)
    assert got is None


def test_the_gate_refuses_something_in_front_of_the_hand():
    """The case nearest-first gets wrong by construction."""
    j = hand()
    px = project(j)
    bar = [(px[5] + [-40.0, 8.0], px[17] + [40.0, 8.0], 0.55, 0.55, 5.0)]
    pc = cloud(render(j, extra=bar))
    ungated = sample_palm_depth(pc, px, model_rel=model_rel(j))
    gated = sample_palm_depth(pc, px, ref=-0.81, ref_sigma=0.015, model_rel=model_rel(j))
    assert abs(ungated - (-0.55)) < 0.01, "ungated, nearest-first takes the bar"
    assert abs(gated - palm_truth(j)) < 0.004, gated


def test_a_loose_reference_does_not_cost_a_good_reading():
    """Apparent size before it is calibrated: 10% out and saying so."""
    j = hand()
    got = sample_palm_depth(cloud(render(j)), project(j), ref=-0.88, ref_sigma=0.12,
                            model_rel=model_rel(j))
    assert got is not None and abs(got - palm_truth(j)) < 0.003


def test_the_previous_answer_still_steadies_a_wide_gate():
    """Two surfaces inside a loose gate, and holes in the nearer one: without
    the prior the anchor would follow whichever had more pixels this frame."""
    rng = np.random.default_rng(4)
    j = hand()
    px = project(j)
    for _ in range(20):
        dm = render(j, wall=0.98)
        holes = rng.random(dm.shape) < 0.93
        dm[(dm < 0.9) & holes] = 0.98                # most of the hand shows wall
        got = sample_palm_depth(cloud(dm), px, ref=-0.85, ref_sigma=0.12, prior=-0.80,
                                model_rel=model_rel(j))
        assert got is not None and abs(got - palm_truth(j)) < 0.01, got


def test_gate_width_follows_the_reference():
    assert gate_half_width(0.015) < 0.08             # both cameras: excludes a torso
    assert gate_half_width(0.12) == 0.30             # uncalibrated size: capped
    assert gate_half_width(0.001) == 0.06            # never narrower than a palm's relief
    assert gate_half_width(float("nan")) == 0.30


def test_joint_tolerance_covers_the_anchor_it_hangs_from():
    assert joint_tolerance(True, 0.10) == 0.05       # on the map: the old window
    assert joint_tolerance(False, 0.015) == 0.05
    assert joint_tolerance(False, 0.06) == 0.12      # on a loose reference: wider
    assert joint_tolerance(False, 0.50) == 0.20
    assert joint_tolerance(False, float("nan")) == 0.05


# --------------------------------------------------------------------------
# how wide
# --------------------------------------------------------------------------

def test_patch_radius_is_metres_on_the_hand_not_pixels():
    assert patch_radius(0.80, FX, JOINT_HALF_WIDTH, 2, 8, 4) == 4      # as before, here
    assert patch_radius(0.80, FX, PALM_HALF_WIDTH, 3, 12, 6) == 6
    assert patch_radius(0.80, FX / 2, JOINT_HALF_WIDTH, 2, 8, 4) == 2  # VGA
    assert patch_radius(0.40, FX, JOINT_HALF_WIDTH, 2, 8, 4) == 8      # close up
    assert patch_radius(3.00, FX, JOINT_HALF_WIDTH, 2, 8, 4) == 2      # floor
    assert patch_radius(float("nan"), FX, JOINT_HALF_WIDTH, 2, 8, 4) == 4
    assert patch_radius(None, FX, JOINT_HALF_WIDTH, 2, 8, 4) == 4


def test_patch_depths_handles_the_frame_edge_and_garbage():
    pc = cloud(np.full(SHAPE, 0.8))
    pc[10, 10, 2] = np.inf
    pc[10, 11, 2] = 0.5                              # behind the camera
    assert len(patch_depths(pc, (-5, 10), 4)) == 0
    assert len(patch_depths(pc, (0, 0), 2)) == 9     # clipped to the corner
    assert len(patch_depths(pc, (10.4, 9.6), 1)) == 7


# --------------------------------------------------------------------------
# the sign estimator's feed
# --------------------------------------------------------------------------

def _mediapipe_z(j, sign):
    """World-landmark z for the hand: `sign` -1 is the documented convention,
    larger meaning further from the camera."""
    return sign * (j[:, 2] - j[:, 2].mean())


def _feed(sign, frames=80, seed=9):
    rng = np.random.default_rng(seed)
    est = DepthSignEstimator()
    for _ in range(frames):
        j = hand(pitch=rng.uniform(20, 45), roll=rng.uniform(-20, 20))
        wall = 0.95
        pc = cloud(degrade(render(j, wall=wall), wall, rng))
        mp_z = _mediapipe_z(j, sign)
        est.observe(at_sample_points(mp_z - np.mean(mp_z[list(PALM_IDX)])),
                    sample_unbiased(pc, project(j), palm_truth(j), 4) - palm_truth(j))
    return est


def test_the_sign_estimator_is_actually_fed():
    """It never was. The old sampler read five fingertips and the estimator
    counts a frame only with six joints, so every frame was discarded and the
    "runtime detection" was the documented default, unexamined."""
    j = hand(pitch=30)
    got = sample_unbiased(cloud(render(j)), project(j), palm_truth(j), 4)
    assert int(np.isfinite(got).sum()) >= DepthSignEstimator().min_joints
    assert _feed(-1.0, frames=5).samples == 5


def test_the_sign_is_confirmed_from_the_depth_map():
    est = _feed(-1.0)
    assert est.confident and est.sign == -1.0, est.evidence


def test_the_sign_is_overturned_when_the_documentation_is_wrong():
    est = _feed(+1.0)
    assert est.confident and est.sign == +1.0, est.evidence


def test_unbiased_readings_lean_neither_way_against_a_wall():
    """The median this replaced read the wall at thin joints, which is a
    standing vote that fingers point away from the camera."""
    rng = np.random.default_rng(5)
    bias = []
    for _ in range(30):
        j = hand(pitch=rng.uniform(-30, 30))
        wall = 0.90
        pc = cloud(degrade(render(j, wall=wall), wall, rng))
        got = sample_unbiased(pc, project(j), palm_truth(j), 4)
        truth = at_sample_points(j[:, 2])
        bias.extend((got - truth)[list(TIPS)])
    bias = np.array(bias)
    assert np.isfinite(bias).mean() > 0.9
    assert abs(np.nanmean(bias)) < 0.002, f"tips read {np.nanmean(bias) * 1000:+.1f} mm"


# --------------------------------------------------------------------------
# the whole chain, wired the way gesture_detect.py wires it
# --------------------------------------------------------------------------
#
# Everything above tests a part. These run one frame the way the main loop
# does -- triangulate, locate the palm, sample the joints, fuse, solve -- with
# the real model_relative_depth, because the places this can still be wrong
# are the joins: a depth that should have been negated, a model offset added
# with the wrong sign.

def mediapipe_world(j, scale=1.0):
    """The hand as MediaPipe reports it: metres, origin at the centroid, x
    right, y DOWN, z AWAY from the camera -- and `scale`, because its hand is
    a generic one and this person's is not."""
    c = j - j.mean(axis=0)
    return np.stack([c[:, 0], -c[:, 1], -c[:, 2]], axis=1) * scale


def project_right(j):
    d = -j[:, 2]
    return np.stack([CX + (j[:, 0] - BASELINE) * FX / d, CY - j[:, 1] * FX / d], axis=1)


def track(j, pc, scale_cal, rng, right=True, model_scale=0.9, prior=None):
    """One frame. Returns the solved joints and how the palm was anchored."""
    px = project(j) + rng.normal(0, 0.7, (21, 2))
    rays = rays_from_pixels(px, INTR)
    world = mediapipe_world(j, model_scale)
    rel = model_relative_depth(world, -1.0)
    d_tri = sig_tri = np.full(21, np.nan)
    if right:
        d_tri = triangulate_depths(px, project_right(j) + rng.normal(0, 0.7, (21, 2)),
                                   FX, BASELINE)
        sig_tri = triangulation_sigma(d_tri, FX, BASELINE)
    fix = locate_palm(pc, px, rays, world, rel, d_tri, sig_tri, scale_cal, FX, prior)
    z_map, spread = sample_joint_depths(pc, px, fix.z, rel, radius=fix.r_joint,
                                        tol=joint_tolerance(fix.anchored, fix.ref_sigma),
                                        with_spread=True)
    sig_map = np.where(np.isfinite(z_map), depthmap_sigma(spread), np.nan)
    d_fused, sig_fused = fuse_measurements([-z_map, d_tri], [sig_map, sig_tri])
    d_model = -fix.z - rel
    solved = solve_depths(rays, np.where(np.isfinite(d_fused), d_fused, d_model),
                          d_fused, sig_fused, bone_lengths(j), prior_d=d_model)
    return points_from_depths(rays, solved), fix


def palm_of(joints):
    return joints[list(PALM_IDX)].mean(axis=0)


def wall_through(j, wall=1.05):
    """The hand's pixels reading as the wall behind it."""
    dm = render(j, wall=wall)
    dm[dm < wall - 1e-6] = wall
    return cloud(dm)


def test_end_to_end_on_a_good_frame():
    rng = np.random.default_rng(21)
    for pose in ({}, {"pitch": 35}, {"pitch": -25, "roll": 30}):
        j = hand(**pose)
        wall = 1.3
        joints, fix = track(j, cloud(degrade(render(j, wall=wall), wall, rng)),
                            ScaleCalibration(), rng)
        err = np.linalg.norm(joints - j, axis=1)
        assert fix.source == "map", (pose, fix)
        assert err.max() < 0.012, f"{pose}: joint {err.argmax()} off by {err.max() * 1000:.1f} mm"


def test_end_to_end_when_the_wall_shows_through_the_hand():
    """The latch, through the whole pipeline. Ungated, the anchor goes to the
    wall and takes the hand with it: 25 cm in one frame."""
    rng = np.random.default_rng(22)
    j = hand()
    pc = wall_through(j)
    assert abs(sample_palm_depth(pc, project(j)) - (-1.05)) < 0.01, "the scene must latch ungated"
    joints, fix = track(j, pc, ScaleCalibration(), rng)
    assert fix.source == "reference" and fix.gated == 0, fix
    off = np.linalg.norm(palm_of(joints) - palm_of(j))
    assert off < 0.03, f"palm off by {off * 100:.1f} cm"


def test_end_to_end_the_hand_does_not_jump_when_its_depth_comes_and_goes():
    """What 7.9 m/s swipes were: the anchor changing surface between frames.

    A still hand whose depth drops out on alternate frames. Frame-to-frame
    movement of the palm is all that swipe detection sees, so that is what is
    bounded: under 2 cm, where following the map would make it 25.
    """
    rng = np.random.default_rng(23)
    j = hand()
    good, bad = cloud(render(j, wall=1.05)), wall_through(j)
    cal, prior, palms, sources = ScaleCalibration(), None, [], []
    for frame in range(40):
        joints, fix = track(j, bad if frame % 2 else good, cal, rng, prior=prior)
        prior = fix.z if fix.anchored else prior
        palms.append(palm_of(joints))
        sources.append(fix.source)
    assert set(sources) == {"map", "reference"}, set(sources)
    step = np.linalg.norm(np.diff(np.array(palms), axis=0), axis=1)
    assert step.max() < 0.02, f"palm jumped {step.max() * 100:.1f} cm between frames"


def test_end_to_end_a_hand_coming_at_the_camera_through_a_dropout():
    """Why the fallback is the reference and not the last map reading.

    On a still hand the two are as good as each other. On one moving at 1 m/s
    whose depth drops out for a sixth of a second, the last reading is 16 cm
    stale by the end -- and TOWARD is one of the swipes.
    """
    rng = np.random.default_rng(26)
    cal, prior, worst = ScaleCalibration(), None, 0.0
    for frame in range(20):
        j = hand(palm_d=0.95 - frame / 60.0)
        lost = frame >= 10
        joints, fix = track(j, wall_through(j, wall=1.4) if lost else cloud(render(j, wall=1.4)),
                            cal, rng, prior=prior)
        prior = fix.z if fix.anchored else prior
        assert fix.source == ("reference" if lost else "map"), (frame, fix)
        if lost:
            worst = max(worst, abs(palm_of(joints)[2] - palm_of(j)[2]))
    assert worst < 0.03, f"palm depth {worst * 100:.1f} cm behind the hand"


def test_end_to_end_with_one_camera_the_scale_is_learned_then_used():
    """--no-right-view: no triangulation, so the reference is apparent size.

    The model's hand is 12% small, so size alone starts 12% out and says so
    with a wide gate. It calibrates against the gated map, and by the time the
    wall shows through it is good enough to hold the hand on its own.
    """
    rng = np.random.default_rng(24)
    cal = ScaleCalibration()
    for _ in range(25):
        j = hand(palm_d=rng.uniform(0.6, 1.0), pitch=rng.uniform(-10, 30))
        _, fix = track(j, cloud(render(j, wall=1.6)), cal, rng, right=False, model_scale=0.88)
        assert fix.source == "map" and not np.isfinite(fix.tri_d)
    assert cal.ready and abs(cal.ratio - 1 / 0.88) < 0.03, cal.ratio
    j = hand(palm_d=0.75, pitch=15)
    joints, fix = track(j, wall_through(j), cal, rng, right=False, model_scale=0.88)
    assert fix.source == "reference", fix
    off = np.linalg.norm(palm_of(joints) - palm_of(j))
    assert off < 0.04, f"palm off by {off * 100:.1f} cm"


def test_end_to_end_something_in_front_of_the_knuckles():
    rng = np.random.default_rng(25)
    j = hand()
    px = project(j)
    bar = [(px[5] + [-40.0, 8.0], px[17] + [40.0, 8.0], 0.55, 0.55, 5.0)]
    joints, fix = track(j, cloud(render(j, extra=bar)), ScaleCalibration(), rng)
    assert fix.source == "map" and fix.gated < fix.pool, fix
    off = np.linalg.norm(palm_of(joints) - palm_of(j))
    assert off < 0.01, f"palm off by {off * 100:.1f} cm"


def test_the_palm_does_not_step_when_the_second_lens_drops_out():
    """End to end through locate_palm, depth map blank as it is on the rig: a
    run of paired frames, then the pairing is lost. Without the recent scale
    the palm steps to the size estimate; with it, it stays put."""
    from fuse3d import RecentScale, ScaleCalibration, rays_from_pixels, triangulate_depths, triangulation_sigma
    j = hand(palm_d=0.26, pitch=60)
    px, world = project(j), mediapipe_world(j, 1.12)          # a model 12% off in scale: size reads wrong
    rays = rays_from_pixels(px, INTR)
    blank = np.full(SHAPE + (4,), np.nan, dtype=np.float32)
    d_tri = triangulate_depths(px, project_right(j), INTR[0], BASELINE, max_row_error=60.0)
    sig = triangulation_sigma(d_tri, INTR[0], BASELINE)
    none = np.full(21, np.nan)
    rel = np.zeros(21)

    def run(recent):
        cal, t, out = ScaleCalibration(), 0.0, []
        for k in range(14):
            paired = k < 8
            fix = locate_palm(blank, px, rays, world, rel, d_tri if paired else none, sig if paired else none,
                              cal, INTR[0], None, recent=recent, t=t)
            out.append(-fix.z)
            t += 1 / 30
        return np.array(out)

    before, after = run(None), run(RecentScale())
    step_before, step_after = abs(before[8] - before[7]), abs(after[8] - after[7])
    assert step_before > 0.005, f"the scene should reproduce the step: {step_before * 1000:.1f} mm"
    assert step_after < 0.002, f"still steps {step_after * 1000:.1f} mm when the second lens drops out"
    assert np.abs(np.diff(after)).max() < 0.002


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
