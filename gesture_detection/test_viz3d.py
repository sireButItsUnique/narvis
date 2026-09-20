#!/usr/bin/env python3
"""Tests for viz3d.py -- no camera, no window.

Run:  python test_viz3d.py
"""

from __future__ import annotations

import sys

import numpy as np

from viz3d import HAND_BONES, OrbitCamera, Viewer3D

W, H = 720, 560


def test_target_projects_to_the_centre():
    """Whatever the orbit angle, the point being orbited stays centred."""
    cam = OrbitCamera()
    for az, el in ((0, 0), (37, 21), (180, -45), (300, 80)):
        cam.azimuth, cam.elevation = az, el
        px, vis, _ = cam.project([cam.target], W, H)
        assert vis[0], (az, el)
        assert abs(px[0][0] - W / 2) <= 1 and abs(px[0][1] - H / 2) <= 1, (az, el, px)


def test_eye_stays_at_the_orbit_distance():
    cam = OrbitCamera()
    for az, el, d in ((0, 0, 1.0), (95, 30, 2.5), (250, -60, 0.6)):
        cam.azimuth, cam.elevation, cam.distance = az, el, d
        assert abs(np.linalg.norm(cam.eye - cam.target) - d) < 1e-9


def test_orbit_changes_the_viewpoint_not_the_subject():
    cam = OrbitCamera()
    before = cam.eye.copy()
    target_before = cam.target.copy()
    cam.orbit(40, 10)
    assert np.linalg.norm(cam.eye - before) > 0.1
    assert np.allclose(cam.target, target_before)


def test_elevation_clamps_short_of_the_pole():
    """At +-90 the up vector is parallel to the view and the basis collapses."""
    cam = OrbitCamera()
    cam.orbit(0, 500)
    assert cam.elevation <= 89.0
    r, u, f = cam.basis()
    for v in (r, u, f):
        assert np.isfinite(v).all() and abs(np.linalg.norm(v) - 1.0) < 1e-6
    cam.orbit(0, -1000)
    assert cam.elevation >= -89.0
    assert np.isfinite(np.array(cam.basis())).all()


def test_zoom_is_bounded():
    cam = OrbitCamera()
    for _ in range(80):
        cam.zoom(0.88)
    assert cam.distance == cam.min_distance
    for _ in range(200):
        cam.zoom(1 / 0.88)
    assert cam.distance == cam.max_distance


def test_zooming_in_magnifies():
    """Two points a fixed distance apart must span more pixels when closer."""
    cam = OrbitCamera()
    pair = [[-0.1, 0.0, -0.9], [0.1, 0.0, -0.9]]
    far, _, _ = cam.project(pair, W, H)
    span_far = abs(far[1][0] - far[0][0])
    cam.zoom(0.5)
    near, _, _ = cam.project(pair, W, H)
    assert abs(near[1][0] - near[0][0]) > span_far * 1.5


def test_points_behind_the_eye_are_masked():
    """Behind the camera, the perspective divide mirrors a point to the front;
    drawing it would put a phantom hand on screen."""
    cam = OrbitCamera()
    behind = cam.eye + (cam.eye - cam.target)      # opposite side from the target
    _, vis, depth = cam.project([behind], W, H)
    assert not vis[0] and depth[0] < 0


def test_pan_moves_the_target_across_the_view():
    cam = OrbitCamera()
    before = cam.target.copy()
    cam.pan(120, 0)
    moved = cam.target - before
    assert np.linalg.norm(moved) > 1e-4
    _, _, forward = cam.basis()
    # a horizontal drag should not push the target away along the view axis
    assert abs(float(moved @ forward)) < np.linalg.norm(moved) * 0.2


def test_reset_restores_the_default_view():
    cam = OrbitCamera()
    defaults = (cam.azimuth, cam.elevation, cam.distance, cam.target.copy())
    cam.orbit(123, -40)
    cam.zoom(0.3)
    cam.pan(200, -90)
    cam.reset()
    assert (cam.azimuth, cam.elevation, cam.distance) == defaults[:3]
    assert np.allclose(cam.target, defaults[3])


def test_render_produces_an_image_without_hands():
    v = Viewer3D(W, H)
    img = v.render([])
    assert img.shape == (H, W, 3) and img.dtype == np.uint8
    assert img.std() > 1.0, "grid and camera frustum should be visible"


def test_render_draws_a_hand():
    v = Viewer3D(W, H)
    joints = np.array([[0.0, 0.0, -0.9]] * 21)
    for i, (a, b) in enumerate(HAND_BONES):
        joints[b] = joints[a] + np.array([0.02, 0.02, 0.0])
    empty = v.render([])
    drawn = v.render([{"label": "Right", "joints": joints, "palm": joints[0],
                       "pinched": False, "velocity": np.array([0.3, 0.0, 0.0]),
                       "trail": [joints[0] + np.array([d * 0.01, 0, 0]) for d in range(8)]}])
    assert np.abs(drawn.astype(int) - empty.astype(int)).sum() > 0


def test_render_survives_missing_and_broken_data():
    """A hand with no depth, or a NaN joint, must not crash the viewer."""
    v = Viewer3D(W, H)
    bad = np.full((21, 3), np.nan)
    for hand in ({"label": "Left", "joints": None, "palm": None},
                 {"label": "Left", "joints": bad, "palm": np.array([np.nan] * 3)},
                 {}):
        img = v.render([hand])
        assert img.shape == (H, W, 3)


def test_mouse_drag_orbits_and_wheel_zooms():
    import cv2
    v = Viewer3D(W, H)
    az, dist = v.cam.azimuth, v.cam.distance
    v.on_mouse(cv2.EVENT_LBUTTONDOWN, 300, 300, 0)
    v.on_mouse(cv2.EVENT_MOUSEMOVE, 360, 300, 0)
    v.on_mouse(cv2.EVENT_LBUTTONUP, 360, 300, 0)
    assert v.cam.azimuth != az
    v.on_mouse(cv2.EVENT_MOUSEWHEEL, 0, 0, 120 << 16)
    assert v.cam.distance < dist
    v.on_mouse(cv2.EVENT_MOUSEWHEEL, 0, 0, (-120 << 16))
    assert abs(v.cam.distance - dist) < 1e-9


def test_keyboard_fallback():
    """Some OpenCV builds never deliver wheel events."""
    v = Viewer3D(W, H)
    d = v.cam.distance
    assert v.on_key(ord("+")) and v.cam.distance < d
    assert v.on_key(ord("-")) and abs(v.cam.distance - d) < 1e-9
    assert v.on_key(ord("0"))
    assert not v.on_key(ord("z")), "unhandled keys must fall through to the app"


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
