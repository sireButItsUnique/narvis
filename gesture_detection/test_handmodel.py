#!/usr/bin/env python3
"""Tests for handmodel.py -- no camera required.

Run:  python test_handmodel.py

The interesting cases are the failure modes seen live: a fingertip whose depth
patch caught the background, a hand whose measured depths are entirely missing,
and MediaPipe's world-landmark z pointing the other way.
"""

from __future__ import annotations

import sys

import numpy as np

from handmodel import (BONES, PALM_IDX, DepthSignEstimator, MultiOneEuro,
                       bone_lengths, model_relative_depth, palm_anchor,
                       reconstruct_hand)

INTR = (523.825, 523.825, 662.354, 377.168)
FPS = 60


def synthetic_hand(palm_z=-0.8, spread=0.05):
    """A plausible 21-joint hand in the camera frame, fingers toward the camera."""
    rng = np.random.default_rng(4)
    j = np.zeros((21, 3))
    j[0] = [0.0, 0.0, palm_z]
    for k, base in enumerate((1, 5, 9, 13, 17)):
        x = (k - 2) * 0.018
        j[base] = [x, 0.035, palm_z + 0.004 * k]
        for s in range(1, 4):
            j[base + s] = j[base + s - 1] + [x * 0.15, spread, 0.012]
    return j + rng.normal(0, 0.0005, j.shape)


def project(joints, intr=INTR):
    fx, fy, cx, cy = intr
    j = np.asarray(joints, float)
    d = -j[:, 2]
    return np.stack([cx + j[:, 0] * fx / d, cy - j[:, 1] * fy / d], axis=1)


# --------------------------------------------------------------------------
# reconstruction
# --------------------------------------------------------------------------

def test_perfect_inputs_round_trip():
    truth = synthetic_hand()
    px = project(truth)
    rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    got = reconstruct_hand(px, INTR, palm_anchor(truth[:, 2]), truth[:, 2], rel)
    assert np.abs(got - truth).max() < 1e-6, np.abs(got - truth).max()


def test_background_latch_is_rejected():
    """The live failure: a fingertip's depth patch catches the wall behind.

    The joint must land where the hand model says, not 1.5 m away.
    """
    truth = synthetic_hand()
    px = project(truth)
    rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    measured = truth[:, 2].copy()
    for tip in (4, 8, 12, 16, 20):
        measured[tip] = -2.3                     # the wall
    got = reconstruct_hand(px, INTR, palm_anchor(measured), measured, rel)
    err = np.abs(got[:, 2] - truth[:, 2])
    assert err.max() < 0.01, f"worst joint off by {err.max() * 100:.1f} cm"


def test_missing_depth_still_gives_a_whole_hand():
    """Most fingertips have no depth most of the time; the hand must survive."""
    truth = synthetic_hand()
    px = project(truth)
    rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    measured = np.full(21, np.nan)
    measured[list(PALM_IDX)] = truth[list(PALM_IDX), 2]
    got = reconstruct_hand(px, INTR, palm_anchor(measured), measured, rel)
    assert np.isfinite(got).all()
    assert np.abs(got - truth).max() < 0.01


def test_without_a_model_the_hand_is_flat_but_sane():
    """No world landmarks: every joint falls back to the palm's depth.

    Shape in X/Y must still be right -- that comes from the pixels -- and no
    joint may end up behind the camera.
    """
    truth = synthetic_hand()
    px = project(truth)
    got = reconstruct_hand(px, INTR, -0.8, None, None)
    assert np.allclose(got[:, 2], -0.8)
    assert np.isfinite(got).all() and (got[:, 2] < 0).all()
    # relative X/Y layout preserved
    assert np.corrcoef(got[:, 0], truth[:, 0])[0, 1] > 0.99


def test_bone_lengths_stay_anatomical_under_bad_depth():
    """The point of the whole exercise: garbage depth must not stretch bones."""
    truth = synthetic_hand()
    px = project(truth)
    rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    rng = np.random.default_rng(1)
    measured = truth[:, 2].copy()
    hit = rng.random(21) < 0.4
    measured[hit] = -2.0 - rng.random(int(hit.sum()))    # scattered background
    got = reconstruct_hand(px, INTR, palm_anchor(measured), measured, rel)
    ratio = bone_lengths(got) / bone_lengths(truth)
    assert ratio.max() < 1.25 and ratio.min() > 0.8, (ratio.min(), ratio.max())


def test_a_joint_never_lands_behind_the_camera():
    px = project(synthetic_hand())
    got = reconstruct_hand(px, INTR, -0.6, None, np.full(21, 5.0))
    assert (got[:, 2] < 0).all() and np.isfinite(got).all()


# --------------------------------------------------------------------------
# palm anchor
# --------------------------------------------------------------------------

def test_palm_anchor_uses_only_palm_joints():
    m = np.full(21, np.nan)
    m[list(PALM_IDX)] = [-0.80, -0.81, -0.79, -0.80, -0.80]
    m[8] = -3.0                                   # a wild fingertip
    assert abs(palm_anchor(m) - (-0.80)) < 0.01


def test_palm_anchor_falls_back_when_nothing_resolved():
    assert palm_anchor(np.full(21, np.nan)) is None
    assert palm_anchor(np.full(21, np.nan), fallback=-0.9) == -0.9


def test_palm_anchor_survives_one_bad_palm_joint():
    m = np.full(21, np.nan)
    m[list(PALM_IDX)] = [-0.80, -0.81, -2.40, -0.80, -0.79]
    assert abs(palm_anchor(m) - (-0.80)) < 0.02, palm_anchor(m)


# --------------------------------------------------------------------------
# model depth sign
# --------------------------------------------------------------------------

def test_sign_defaults_to_the_documented_convention():
    assert DepthSignEstimator().sign == -1.0


def test_sign_is_learned_from_agreement():
    """MediaPipe z away from camera, ours toward: relative depths anticorrelate."""
    est = DepthSignEstimator()
    truth = synthetic_hand()
    measured_rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    mp_rel = -measured_rel                        # opposite convention
    for _ in range(40):
        est.observe(mp_rel, measured_rel)
    assert est.sign == -1.0 and est.confident


def test_sign_flips_when_the_convention_agrees():
    est = DepthSignEstimator()
    truth = synthetic_hand()
    measured_rel = truth[:, 2] - np.mean(truth[list(PALM_IDX), 2])
    for _ in range(40):
        est.observe(measured_rel, measured_rel)   # same convention
    assert est.sign == 1.0 and est.confident


def test_sign_is_not_overturned_by_noise():
    """Evidence is a decaying sum, so on correlations that mean nothing it
    wanders a few units either side of zero for ever. The old bar was 1, which
    noise clears about a quarter of the time -- it only never happened because
    the estimator was never fed."""
    rng = np.random.default_rng(6)
    est = DepthSignEstimator()
    peak = 0.0
    for _ in range(5000):
        est.observe(rng.normal(0, 1, 21), rng.normal(0, 1, 21))
        peak = max(peak, abs(est.evidence))
        assert est.sign == -1.0
    assert peak > 1.0, "the walk should at least clear the old bar, or this proves nothing"


def test_sign_ignores_thin_evidence():
    est = DepthSignEstimator()
    rel = np.full(21, np.nan)
    rel[:3] = [0.01, 0.02, 0.03]
    est.observe(rel, rel)
    assert est.samples == 0, "fewer than min_joints must not count"


def test_model_relative_depth_is_palm_centred():
    w = np.zeros((21, 3))
    w[:, 2] = np.linspace(-0.05, 0.05, 21)
    rel = model_relative_depth(w, sign=-1.0)
    assert abs(float(np.mean(rel[list(PALM_IDX)]))) < 1e-12


# --------------------------------------------------------------------------
# filtering
# --------------------------------------------------------------------------

def test_multi_one_euro_reduces_jitter():
    rng = np.random.default_rng(2)
    truth = np.tile(np.array([[100.0, 200.0]]), (21, 1))
    f = MultiOneEuro((21, 2), min_cutoff=1.0, beta=0.01)
    raw_err, filt_err = [], []
    for i in range(200):
        noisy = truth + rng.normal(0, 2.0, truth.shape)
        out = f(noisy, i / FPS)
        raw_err.append(np.abs(noisy - truth).mean())
        filt_err.append(np.abs(out - truth).mean())
    assert np.mean(filt_err[20:]) < np.mean(raw_err[20:]) * 0.35


def test_multi_one_euro_tracks_motion():
    f = MultiOneEuro((21, 2), min_cutoff=1.0, beta=0.02)
    out = None
    for i in range(120):
        x = np.tile(np.array([[100.0 + 4.0 * i, 200.0]]), (21, 1))
        out = f(x, i / FPS)
    assert abs(out[0, 0] - (100.0 + 4.0 * 119)) < 30.0, out[0, 0]


def test_multi_one_euro_restarts_after_a_gap():
    f = MultiOneEuro((21, 2))
    a = np.zeros((21, 2))
    f(a, 0.0)
    f(a, 1 / FPS)
    jumped = f(a + 500.0, 5.0)                    # long gap, hand reappears
    assert np.allclose(jumped, a + 500.0), "stale history must not drag it back"


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
