#!/usr/bin/env python3
"""Tests for headtrack.py and the close-range row tolerance -- no camera required.

Run:  python test_headtrack.py
"""

from __future__ import annotations

import sys

import numpy as np

from fuse3d import row_tolerance, same_hand, triangulate_depths
from headtrack import IRIS_LEFT, IRIS_RIGHT, eye_pixels, head_from_views, triangulate_point

FX = FY = 523.825
CX, CY = 640.0, 360.0
INTR = (FX, FY, CX, CY)
BASELINE = 0.120075


def left_view(p):
    p = np.atleast_2d(p)
    d = -p[:, 2]
    return np.stack([CX + p[:, 0] * FX / d, CY - p[:, 1] * FY / d], axis=1)


def right_view(p):
    return left_view(np.atleast_2d(p) - [BASELINE, 0.0, 0.0])


def face(eye_mid, ipd=0.063, n=478):
    """478 face landmarks scattered about the head, with the irises where they
    belong. Subject's right eye is at -X: the camera faces them."""
    rng = np.random.default_rng(1)
    pts = np.asarray(eye_mid) + rng.normal(0, 0.04, (n, 3))
    pts[IRIS_RIGHT] = np.asarray(eye_mid) + [-ipd / 2, 0, 0]
    pts[IRIS_LEFT] = np.asarray(eye_mid) + [+ipd / 2, 0, 0]
    return pts


def test_a_point_round_trips_through_both_views():
    for p in ([0.0, 0.3, -0.7], [-0.2, 0.45, -0.55], [0.15, 0.1, -1.2]):
        got = triangulate_point(left_view(p)[0], right_view(p)[0], INTR, BASELINE)
        assert np.abs(got - p).max() < 1e-9, (p, got)


def test_the_eye_point_is_the_midpoint_between_the_irises():
    """A head where this rig puts one: up and out from a camera under the sheet."""
    mid = np.array([0.04, 0.42, -0.62])
    pts = face(mid)
    fix = head_from_views(left_view(pts), right_view(pts), INTR, BASELINE, 720)
    assert fix.ok and fix.why == "stereo"
    assert np.abs(fix.eye - mid).max() < 1e-9
    assert abs(fix.ipd - 0.063) < 1e-9


def test_a_pixel_of_noise_is_spent_along_the_line_of_sight():
    """Stereo's weak direction is range (z^2 / fB per pixel), and range runs
    along the camera's line of sight to the head -- up and out, on this rig, so
    it shows in Y as well as Z. It is also the direction the projection
    forgives: an eye slid along a sightline barely changes the picture. ACROSS
    the sightline is what shows, and across is a millimetre."""
    rng = np.random.default_rng(2)
    mid = np.array([0.0, 0.40, -0.65])
    pts = face(mid)
    ray = mid / np.linalg.norm(mid)
    along, across = [], []
    for _ in range(200):
        fix = head_from_views(left_view(pts) + rng.normal(0, 0.5, (478, 2)),
                              right_view(pts) + rng.normal(0, 0.5, (478, 2)), INTR, BASELINE, 720)
        assert fix.ok
        e = fix.eye - mid
        along.append(abs(e @ ray))
        across.append(np.linalg.norm(e - (e @ ray) * ray))
    assert np.percentile(across, 95) < 0.0015, np.percentile(across, 95)
    assert np.percentile(along, 95) < 0.015, np.percentile(along, 95)


def test_no_stereo_no_head():
    """One view can only guess depth, and a guessed eye swings the whole
    picture. Held is better than wrong."""
    pts = face([0.0, 0.4, -0.65])
    assert not head_from_views(None, right_view(pts), INTR, BASELINE).ok
    assert not head_from_views(left_view(pts), None, INTR, BASELINE).ok


def test_two_views_of_different_faces_are_refused():
    a, b = face([0.0, 0.4, -0.65]), face([0.0, 0.4, -0.65], ipd=0.063)
    shifted = right_view(b) + [0.0, 40.0]                     # rows disagree
    assert not head_from_views(left_view(a), shifted, INTR, BASELINE, 720).ok
    wide = right_view(b).copy()
    wide[IRIS_LEFT, 0] -= 25.0                                # one eye matched elsewhere
    fix = head_from_views(left_view(a), wide, INTR, BASELINE, 720)
    assert not fix.ok and "apart" in fix.why, fix.why


def test_eye_corners_stand_in_when_the_model_has_no_irises():
    pts = face([0.0, 0.4, -0.65])[:468]
    pts[[33, 133]] = pts[[33, 133]].mean(0) + [[-0.012, 0, 0], [0.012, 0, 0]]
    got = eye_pixels(left_view(pts))
    assert np.allclose(got[0], left_view(pts[[33, 133]]).mean(axis=0))


# --------------------------------------------------------------------------
# a hand 25 cm from the lens
# --------------------------------------------------------------------------

def close_hand(depth=0.25):
    rng = np.random.default_rng(3)
    p = np.zeros((21, 3))
    p[:, 0] = rng.uniform(-0.05, 0.05, 21)
    p[:, 1] = np.linspace(-0.08, 0.08, 21)
    p[:, 2] = -depth + rng.uniform(-0.03, 0.03, 21)
    return p


def test_row_tolerance_grows_with_the_hand():
    far = left_view(close_hand(0.80))
    near = left_view(close_hand(0.25))
    assert row_tolerance(far) == 12.0
    assert 18.0 < row_tolerance(near) < 30.0, row_tolerance(near)
    assert row_tolerance(np.full((21, 2), np.nan)) == 12.0


def test_a_close_hand_keeps_its_joints():
    """The same landmarker error, as a fraction of the hand, is three times as
    many pixels at rig distance. With the old fixed 12 most joints were thrown
    away as "not the same point" and the hand lost its second view."""
    rng = np.random.default_rng(4)
    p = close_hand(0.25)
    kept_fixed = kept_scaled = paired = 0
    for _ in range(50):
        pl = left_view(p) + rng.normal(0, 7.0, (21, 2))       # ~2.5% of a 300 px hand
        pr = right_view(p) + rng.normal(0, 7.0, (21, 2))
        rows = row_tolerance(pl)
        kept_fixed += np.isfinite(triangulate_depths(pl, pr, FX, BASELINE)).sum()
        kept_scaled += np.isfinite(triangulate_depths(pl, pr, FX, BASELINE, max_row_error=rows)).sum()
        paired += same_hand(pl, pr, FX, BASELINE, 0.25, max_row_error=rows)
    assert kept_fixed < 0.80 * 21 * 50, kept_fixed
    assert kept_scaled > 0.95 * 21 * 50, kept_scaled
    assert paired >= 48, paired


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
