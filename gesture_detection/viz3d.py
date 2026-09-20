"""Orbiting 3D view of the tracked hands.

Pure numpy + OpenCV drawing, no ZED or MediaPipe imports, so the camera maths
is testable without hardware (see test_viz3d.py).

A software renderer rather than OpenGL: the scene is two hands, a grid and a
frustum -- a few hundred line segments. Projecting those by hand costs
microseconds and avoids a second windowing toolkit fighting the OpenCV event
loop the rest of the program already runs.

World convention matches the rest of the project (ZED RIGHT_HANDED_Y_UP):
    +X right, +Y up, +Z toward the camera, so the scene in front of the
    camera has negative Z and the camera itself sits at the origin.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

__all__ = ["OrbitCamera", "Viewer3D", "HAND_BONES"]

HAND_BONES = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
]

_BG = (24, 24, 28)
_GRID = (52, 52, 60)
_GRID_AXIS = (80, 80, 92)
_TEXT = (190, 190, 195)
_DIM = (120, 120, 128)
HAND_COLORS = {"Left": (120, 200, 255), "Right": (140, 255, 170)}
_PINCH = (60, 120, 255)


def _norm(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


@dataclass
class OrbitCamera:
    """Spherical camera around a target point.

    Angles in degrees because they are shown on screen and typed into tests;
    elevation is clamped short of the poles, where the up vector degenerates
    and the view flips.
    """

    target: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0, -0.9]))
    distance: float = 1.9
    azimuth: float = 28.0
    elevation: float = 18.0
    fov: float = 55.0
    min_distance: float = 0.25
    max_distance: float = 12.0

    def reset(self) -> None:
        self.target = np.array([0.0, 0.0, -0.9])
        self.distance, self.azimuth, self.elevation = 1.9, 28.0, 18.0

    @property
    def eye(self) -> np.ndarray:
        az, el = math.radians(self.azimuth), math.radians(self.elevation)
        offset = np.array([math.cos(el) * math.sin(az),
                           math.sin(el),
                           math.cos(el) * math.cos(az)])
        return self.target + self.distance * offset

    def orbit(self, d_az: float, d_el: float) -> None:
        self.azimuth = (self.azimuth + d_az) % 360.0
        # stop just short of vertical: at +-90 the up vector and the view
        # direction are parallel and the basis collapses
        self.elevation = max(-89.0, min(89.0, self.elevation + d_el))

    def zoom(self, factor: float) -> None:
        self.distance = max(self.min_distance,
                            min(self.max_distance, self.distance * factor))

    def pan(self, dx: float, dy: float) -> None:
        """Slide the target across the view plane, scaled by distance so the
        drag feels the same however far out you are."""
        right, up, _ = self.basis()
        self.target = self.target + (-dx * right + dy * up) * self.distance * 0.0015

    def basis(self) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        forward = _norm(self.target - self.eye)
        world_up = np.array([0.0, 1.0, 0.0])
        right = _norm(np.cross(forward, world_up))
        up = np.cross(right, forward)
        return right, up, forward

    def project(self, points: Sequence, width: int, height: int):
        """(pixels Nx2 int, visible mask N, view depth N).

        Points behind the eye project to a mirrored position in front of it,
        so the caller must honour the mask rather than just drawing.
        """
        pts = np.atleast_2d(np.asarray(points, dtype=np.float64))
        right, up, forward = self.basis()
        rel = pts - self.eye
        x, y, z = rel @ right, rel @ up, rel @ forward
        focal = 0.5 * height / math.tan(math.radians(self.fov) * 0.5)
        safe = np.maximum(z, 1e-6)
        px = width * 0.5 + focal * x / safe
        py = height * 0.5 - focal * y / safe
        visible = z > 0.05
        # keep coordinates finite for cv2 even where invisible
        px = np.clip(np.nan_to_num(px, nan=0.0), -1e5, 1e5)
        py = np.clip(np.nan_to_num(py, nan=0.0), -1e5, 1e5)
        return np.stack([px, py], axis=1).astype(np.int32), visible, z


class Viewer3D:
    """Renders hands into an image and turns mouse input into camera moves."""

    def __init__(self, width: int = 720, height: int = 560):
        self.width, self.height = width, height
        self.cam = OrbitCamera()
        self._drag: Optional[Tuple[int, int, int]] = None   # x, y, button
        # the grid and the frustum never move in world space, so build their
        # geometry once
        self._grid = self._build_grid()
        self._frustum = self._build_camera()

    # -- input ----------------------------------------------------------
    def on_mouse(self, event, x, y, flags, _param=None) -> None:
        if event == cv2.EVENT_LBUTTONDOWN:
            self._drag = (x, y, 0)
        elif event == cv2.EVENT_RBUTTONDOWN or event == cv2.EVENT_MBUTTONDOWN:
            self._drag = (x, y, 1)
        elif event in (cv2.EVENT_LBUTTONUP, cv2.EVENT_RBUTTONUP, cv2.EVENT_MBUTTONUP):
            self._drag = None
        elif event == cv2.EVENT_MOUSEMOVE and self._drag is not None:
            x0, y0, button = self._drag
            dx, dy = x - x0, y - y0
            if button == 0:
                self.cam.orbit(-dx * 0.4, dy * 0.4)
            else:
                self.cam.pan(dx, dy)
            self._drag = (x, y, button)
        elif event == cv2.EVENT_MOUSEWHEEL:
            # the wheel delta lives in the high word of flags, sign included
            self.cam.zoom(0.88 if (flags >> 16) > 0 else 1 / 0.88)

    def on_key(self, key: int) -> bool:
        """Keyboard fallback -- some OpenCV builds never deliver wheel events."""
        if key in (ord("+"), ord("=")):
            self.cam.zoom(0.88)
        elif key in (ord("-"), ord("_")):
            self.cam.zoom(1 / 0.88)
        elif key == ord("0"):
            self.cam.reset()
        elif key == 81 or key == ord("a"):          # left arrow
            self.cam.orbit(-6, 0)
        elif key == 83 or key == ord("s"):          # right arrow
            self.cam.orbit(6, 0)
        else:
            return False
        return True

    # -- drawing --------------------------------------------------------
    def _line(self, img, a3, b3, color, thickness=1):
        pts, vis, _ = self.cam.project([a3, b3], self.width, self.height)
        if vis[0] and vis[1]:
            cv2.line(img, tuple(pts[0]), tuple(pts[1]), color, thickness, cv2.LINE_AA)

    def _segments(self, img, ends: np.ndarray, colors, widths) -> None:
        """Draw many world-space segments with ONE projection call.

        Projecting per segment measured 5.5 ms for the static grid alone --
        most of it numpy call overhead on two-point arrays, not arithmetic.
        Batching the endpoints makes the grid essentially free.
        """
        flat = ends.reshape(-1, 3)
        pts, vis, _ = self.cam.project(flat, self.width, self.height)
        pts, vis = pts.reshape(-1, 2, 2), vis.reshape(-1, 2)
        for i in range(len(pts)):
            if vis[i, 0] and vis[i, 1]:
                cv2.line(img, tuple(pts[i, 0]), tuple(pts[i, 1]),
                         colors[i], widths[i], cv2.LINE_AA)

    def _build_grid(self, half=1.6, step=0.2, y=-0.45):
        """A floor plane under the working volume, for depth reference.

        Placed relative to the camera rather than a detected floor: the camera
        does not know where the floor is, and a plane at a known offset is more
        honest than a guessed one.
        """
        ends, colors, widths = [], [], []
        n = int(half / step)
        for i in range(-n, n + 1):
            d = i * step
            axis = (i == 0)
            col = _GRID_AXIS if axis else _GRID
            ends.append([[d, y, -0.1 - half * 2], [d, y, -0.1]])
            ends.append([[-half, y, -0.1 - half - d], [half, y, -0.1 - half - d]])
            colors += [col, col]
            widths += [1 + axis, 1 + axis]
        return np.array(ends, dtype=np.float64), colors, widths

    def _build_camera(self):
        """The ZED itself, at the origin, looking down -Z, plus an axis triad."""
        d, w, h = 0.16, 0.10, 0.06
        corners = [[w, h, -d], [-w, h, -d], [-w, -h, -d], [w, -h, -d]]
        body = (100, 140, 180)
        ends, colors, widths = [], [], []
        for i, c in enumerate(corners):
            ends.append([[0, 0, 0], c])
            ends.append([corners[i], corners[(i + 1) % 4]])
            colors += [body, body]
            widths += [1, 1]
        for vec, col in (([0.12, 0, 0], (90, 90, 235)),
                         ([0, 0.12, 0], (90, 235, 90)),
                         ([0, 0, 0.12], (235, 160, 90))):
            ends.append([[0, 0, 0], vec])
            colors.append(col)
            widths.append(2)
        return np.array(ends, dtype=np.float64), colors, widths

    def _draw_axis_labels(self, img):
        vecs = np.array([[0.13, 0, 0], [0, 0.13, 0], [0, 0, 0.13]])
        pts, vis, _ = self.cam.project(vecs, self.width, self.height)
        for i, (lab, col) in enumerate((("X", (90, 90, 235)), ("Y", (90, 235, 90)),
                                        ("Z", (235, 160, 90)))):
            if vis[i]:
                cv2.putText(img, lab, tuple(pts[i] + 3), cv2.FONT_HERSHEY_SIMPLEX,
                            0.35, col, 1, cv2.LINE_AA)

    def _draw_hand(self, img, hand: dict, slot: int = 0):
        joints = hand.get("joints")
        color = HAND_COLORS.get(hand.get("label"), (200, 200, 200))
        if hand.get("pinched"):
            color = _PINCH

        if joints is not None:
            pts, vis, depth = self.cam.project(joints, self.width, self.height)
            for a, b in HAND_BONES:
                if vis[a] and vis[b]:
                    cv2.line(img, tuple(pts[a]), tuple(pts[b]), color, 2, cv2.LINE_AA)
            # Joints are markers on the bones, not the subject. Drawn at the
            # obvious "big dot per joint" size they merge into one white blob
            # and hide the skeleton they are supposed to clarify, so they stay
            # small and take the hand's colour, with only the fingertips picked
            # out in white.
            joint_col = tuple(min(255, int(c * 0.55 + 110)) for c in color)
            for i in range(len(pts)):
                if not vis[i]:
                    continue
                tip = i in (4, 8, 12, 16, 20)
                r = int(np.clip(1.7 / max(depth[i], 0.2), 1, 3)) + (1 if tip else 0)
                cv2.circle(img, tuple(pts[i]), r,
                           (245, 245, 245) if tip else joint_col, -1, cv2.LINE_AA)
            if vis[4] and vis[8]:
                cv2.line(img, tuple(pts[4]), tuple(pts[8]), _PINCH, 1, cv2.LINE_AA)

        palm = hand.get("palm")
        if palm is not None:
            # a dropped line to the floor plane, so the hand has a position and
            # not just a shape
            self._line(img, palm, [palm[0], -0.45, palm[2]], (70, 70, 80), 1)
            pts, vis, _ = self.cam.project([palm], self.width, self.height)
            if vis[0]:
                cv2.circle(img, tuple(pts[0]), 4, color, -1, cv2.LINE_AA)
                label = (f"{hand.get('label','?')}  "
                         f"{palm[0]:+.2f} {palm[1]:+.2f} {palm[2]:+.2f}")
                # stagger by slot: two hands close together in space put their
                # labels on top of each other and neither can be read
                anchor = tuple(pts[0] + np.array([9, -9 - slot * 15]))
                cv2.putText(img, label, anchor, cv2.FONT_HERSHEY_SIMPLEX,
                            0.4, (20, 20, 24), 3, cv2.LINE_AA)
                cv2.putText(img, label, anchor, cv2.FONT_HERSHEY_SIMPLEX,
                            0.4, color, 1, cv2.LINE_AA)

        trail = hand.get("trail")
        if trail is not None and len(trail) > 1:
            pts, vis, _ = self.cam.project(list(trail), self.width, self.height)
            for i in range(1, len(pts)):
                if vis[i] and vis[i - 1]:
                    f = i / len(pts)
                    cv2.line(img, tuple(pts[i - 1]), tuple(pts[i]),
                             tuple(int(c * f) for c in color), 1, cv2.LINE_AA)

        vel = hand.get("velocity")
        if palm is not None and vel is not None and np.linalg.norm(vel) > 0.05:
            self._line(img, palm, np.asarray(palm) + np.asarray(vel) * 0.25,
                       (255, 190, 70), 2)

    def render(self, hands: List[dict], note: str = "") -> np.ndarray:
        img = np.full((self.height, self.width, 3), _BG, dtype=np.uint8)
        self._segments(img, *self._grid)
        self._segments(img, *self._frustum)
        self._draw_axis_labels(img)
        # farthest first, so a nearer hand overlaps a farther one
        order = sorted(range(len(hands)),
                       key=lambda i: -float(np.linalg.norm(
                           np.asarray(hands[i].get("palm", [0, 0, 0]),
                                      dtype=np.float64) - self.cam.eye))
                       if hands[i].get("palm") is not None else 0.0)
        for slot, i in enumerate(order):
            self._draw_hand(img, hands[i], slot)

        cam = self.cam
        cv2.putText(img, f"az {cam.azimuth:5.1f}  el {cam.elevation:+5.1f}  "
                         f"dist {cam.distance:4.2f} m",
                    (12, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, _TEXT, 1, cv2.LINE_AA)
        cv2.putText(img, "drag orbit   right-drag pan   wheel/+- zoom   0 reset",
                    (12, self.height - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                    _DIM, 1, cv2.LINE_AA)
        if note:
            cv2.putText(img, note, (12, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                        _DIM, 1, cv2.LINE_AA)
        return img
