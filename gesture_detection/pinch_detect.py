#!/usr/bin/env python3
"""
Pinch-in / pinch-out detection with a ZED 2i stereo camera.

Pipeline
    ZED left rectified image  ->  MediaPipe HandLandmarker (21 joints, 2D)
    ZED XYZ point cloud       ->  metric 3D for each joint
    thumb-tip / index-tip gap ->  One Euro filter -> hysteresis state machine

The gap is normalised by the hand's own size (wrist -> middle MCP), so the
thresholds hold for any user at any distance from the camera.

Events
    PINCH_IN   fingers closed together faster than --max-transition seconds
    PINCH_OUT  fingers separated again, same timing constraint

Setup
    pip install mediapipe opencv-python numpy
    # ZED SDK + its Python API (pyzed) from stereolabs.com
    curl -O https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

Usage
    python pinch_detect.py
    python pinch_detect.py --json --no-display          # headless, events on stdout
    python pinch_detect.py --close 0.30 --open 0.60     # tighter / looser pinch
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

try:
    import pyzed.sl as sl
except ImportError:
    sys.exit("pyzed not found. Install the ZED SDK and run its get_python_api.py.")

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
except ImportError:
    sys.exit("mediapipe not found.  pip install mediapipe")


# --------------------------------------------------------------------------
# landmark layout
# --------------------------------------------------------------------------

WRIST, THUMB_TIP, INDEX_MCP, INDEX_TIP, MIDDLE_MCP = 0, 4, 5, 8, 9

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),            # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),            # index
    (5, 9), (9, 10), (10, 11), (11, 12),       # middle
    (9, 13), (13, 14), (14, 15), (15, 16),     # ring
    (13, 17), (17, 18), (18, 19), (19, 20),    # pinky
    (0, 17),                                   # palm base
]


# --------------------------------------------------------------------------
# One Euro filter -- adaptive low-pass, steady when still, low-lag when moving
# --------------------------------------------------------------------------

class OneEuroFilter:
    def __init__(self, min_cutoff: float = 1.2, beta: float = 0.08, d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
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
        if dt <= 0.0 or dt > 0.5:          # first frame after a dropout: restart
            self._x_prev, self._t_prev, self._dx_prev = x, t, 0.0
            return x
        dx = (x - self._x_prev) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1.0 - a_d) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = self._alpha(cutoff, dt)
        x_hat = a * x + (1.0 - a) * self._x_prev
        self._x_prev, self._dx_prev, self._t_prev = x_hat, dx_hat, t
        return x_hat


# --------------------------------------------------------------------------
# per-hand pinch state machine
# --------------------------------------------------------------------------

@dataclass
class PinchEvent:
    kind: str                         # "PINCH_IN" | "PINCH_OUT"
    hand: str                         # "Left" | "Right"
    t: float                          # seconds, camera clock
    duration: float                   # how long the open<->closed transition took
    gap_mm: float                     # thumb-tip to index-tip distance at the event
    position: Optional[np.ndarray]    # 3D midpoint of the two tips, metres


@dataclass
class PinchTracker:
    hand: str
    close_thresh: float = 0.35
    open_thresh: float = 0.55
    max_transition: float = 0.60
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
        """Feed one normalised gap sample. Returns an event kind, or None."""
        if t - self._last_seen_t > self.stale_after:
            # hand reappeared after being lost -- start clean, do not fire
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

        # markers update *after* the crossing test, so a transition is timed
        # from the last frame that was unambiguously in the previous state
        if g > self.open_thresh:
            self._last_open_t = t
        if g < self.close_thresh:
            self._last_closed_t = t
        return kind

    @property
    def strength(self) -> float:
        """0 = fully open, 1 = fully pinched. Useful for continuous control."""
        span = self.open_thresh - self.close_thresh
        return float(np.clip((self.open_thresh - self.gap_f) / span, 0.0, 1.0))


# --------------------------------------------------------------------------
# 2D landmark -> metric 3D via the ZED point cloud
# --------------------------------------------------------------------------

def point_at(pc: np.ndarray, uv, radius: int = 3) -> Optional[np.ndarray]:
    """Median XYZ over a small patch. Fingertips sit on depth discontinuities,
    so a single-pixel lookup returns NaN or the depth of the wall behind."""
    u, v = uv
    h, w = pc.shape[:2]
    if not (0 <= u < w and 0 <= v < h):
        return None
    u0, u1 = max(0, u - radius), min(w, u + radius + 1)
    v0, v1 = max(0, v - radius), min(h, v + radius + 1)
    patch = pc[v0:v1, u0:u1, :3].reshape(-1, 3)
    patch = patch[np.isfinite(patch).all(axis=1)]
    if len(patch) < 3:
        return None
    return np.median(patch, axis=0).astype(np.float64)


def gap_and_scale(pts, world_lms, pc):
    """Return (tip gap in metres, hand scale in metres, 3D pinch midpoint).

    Prefers the ZED's metric point cloud; falls back to MediaPipe's own world
    landmarks when stereo depth drops out on the fingers, which it regularly
    does -- thumb and index tips are thin, fast and close together, the worst
    case for a block matcher.
    """
    p_thumb = point_at(pc, pts[THUMB_TIP])
    p_index = point_at(pc, pts[INDEX_TIP])
    p_wrist = point_at(pc, pts[WRIST], radius=5)
    p_mmcp = point_at(pc, pts[MIDDLE_MCP], radius=5)

    gap = None
    midpoint = None
    if p_thumb is not None and p_index is not None:
        g = float(np.linalg.norm(p_thumb - p_index))
        if g < 0.25:                        # sanity: a hand is not 25 cm across
            gap = g
            midpoint = (p_thumb + p_index) * 0.5

    scale = None
    if p_wrist is not None and p_mmcp is not None:
        s = float(np.linalg.norm(p_wrist - p_mmcp))
        if 0.04 < s < 0.20:                 # plausible palm length
            scale = s

    if gap is None or scale is None:
        wa = np.array([[l.x, l.y, l.z] for l in world_lms], dtype=np.float64)
        if gap is None:
            gap = float(np.linalg.norm(wa[THUMB_TIP] - wa[INDEX_TIP]))
        if scale is None:
            scale = float(np.linalg.norm(wa[WRIST] - wa[MIDDLE_MCP]))

    return gap, max(scale, 1e-4), midpoint


# --------------------------------------------------------------------------
# drawing
# --------------------------------------------------------------------------

def draw_hand(img, pts, tr: PinchTracker) -> None:
    pinched = tr.state == "closed"
    col = (40, 120, 255) if pinched else (60, 220, 60)
    for a, b in HAND_CONNECTIONS:
        cv2.line(img, pts[a], pts[b], col, 2, cv2.LINE_AA)
    for p in pts:
        cv2.circle(img, p, 3, (240, 240, 240), -1, cv2.LINE_AA)

    a, b = pts[THUMB_TIP], pts[INDEX_TIP]
    cv2.line(img, a, b, (40, 120, 255) if pinched else (200, 200, 60), 3, cv2.LINE_AA)
    mid = ((a[0] + b[0]) // 2, (a[1] + b[1]) // 2)
    cv2.circle(img, mid, int(4 + 10 * tr.strength), (40, 120, 255), 2, cv2.LINE_AA)

    cv2.putText(img, f"{tr.hand} {tr.gap_f:.2f} {tr.strength:.0%}",
                (pts[WRIST][0] - 40, pts[WRIST][1] + 26),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)


def draw_banner(img, ev: PinchEvent, age: float) -> None:
    alpha = max(0.0, 1.0 - age / 0.9)
    if alpha <= 0.0:
        return
    txt = f"{ev.kind}  {ev.hand}  {ev.gap_mm:.0f} mm  in {ev.duration * 1000:.0f} ms"
    overlay = img.copy()
    cv2.rectangle(overlay, (0, 0), (img.shape[1], 54), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.65 * alpha, img, 1.0 - 0.65 * alpha, 0, img)
    cv2.putText(img, txt, (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (80, 160, 255) if ev.kind == "PINCH_IN" else (120, 255, 160),
                2, cv2.LINE_AA)


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Pinch-in / pinch-out detection on a ZED 2i.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="hand_landmarker.task")
    ap.add_argument("--resolution", default="HD720", choices=["VGA", "HD720", "HD1080"])
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--depth-mode", default="NEURAL_LIGHT",
                    choices=["PERFORMANCE", "QUALITY", "ULTRA", "NEURAL_LIGHT", "NEURAL"])
    ap.add_argument("--hands", type=int, default=2)
    ap.add_argument("--close", type=float, default=0.35,
                    help="normalised gap below which the hand counts as pinched")
    ap.add_argument("--open", dest="open_", type=float, default=0.55,
                    help="normalised gap above which it counts as open")
    ap.add_argument("--max-transition", type=float, default=0.60,
                    help="seconds; slower than this is a pose change, not a gesture")
    ap.add_argument("--refractory", type=float, default=0.35,
                    help="seconds of silence after an event")
    ap.add_argument("--no-flip-handedness", action="store_true",
                    help="MediaPipe labels hands assuming a mirrored selfie view; "
                         "the ZED is world-facing, so labels are flipped by default")
    ap.add_argument("--json", action="store_true",
                    help="emit one JSON object per event on stdout")
    ap.add_argument("--no-display", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        sys.exit(f"Model not found: {args.model}\n"
                 "curl -O https://storage.googleapis.com/mediapipe-models/"
                 "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task")

    # ---- ZED --------------------------------------------------------------
    init = sl.InitParameters()
    init.camera_resolution = getattr(sl.RESOLUTION, args.resolution)
    init.camera_fps = args.fps
    init.depth_mode = getattr(sl.DEPTH_MODE, args.depth_mode)
    init.coordinate_units = sl.UNIT.METER
    init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP
    init.depth_minimum_distance = 0.3

    zed = sl.Camera()
    status = zed.open(init)
    if status != sl.ERROR_CODE.SUCCESS:
        sys.exit(f"ZED open failed: {status}")

    runtime = sl.RuntimeParameters()
    runtime.enable_fill_mode = False          # prefer NaN over invented depth
    runtime.confidence_threshold = 50
    runtime.texture_confidence_threshold = 100

    # ---- MediaPipe --------------------------------------------------------
    landmarker = vision.HandLandmarker.create_from_options(
        vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=args.model),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=args.hands,
            min_hand_detection_confidence=0.6,
            min_hand_presence_confidence=0.6,
            min_tracking_confidence=0.6,
        )
    )

    img_mat, pc_mat = sl.Mat(), sl.Mat()
    trackers: dict = {}
    last_event: Optional[PinchEvent] = None
    last_ts_ms = -1
    t0 = None
    frames, fps_t, fps = 0, time.time(), 0.0

    print("Running. Pinch thumb and index together, then apart. q / Esc / Ctrl-C to quit.",
          file=sys.stderr)

    try:
        while True:
            if zed.grab(runtime) != sl.ERROR_CODE.SUCCESS:
                continue

            zed.retrieve_image(img_mat, sl.VIEW.LEFT)
            zed.retrieve_measure(pc_mat, sl.MEASURE.XYZRGBA)
            bgra = img_mat.get_data()
            pc = pc_mat.get_data()

            ts_ms = int(zed.get_timestamp(sl.TIME_REFERENCE.IMAGE).get_milliseconds())
            ts_ms = max(ts_ms, last_ts_ms + 1)     # detect_for_video needs monotonic ms
            last_ts_ms = ts_ms
            if t0 is None:
                t0 = ts_ms / 1000.0
            t = ts_ms / 1000.0 - t0

            rgb = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGB)   # ZED is BGRA, not BGR
            res = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)

            h, w = rgb.shape[:2]
            frame = None if args.no_display else bgra[:, :, :3].copy()

            for lms, world_lms, handed in zip(res.hand_landmarks,
                                              res.hand_world_landmarks,
                                              res.handedness):
                label = handed[0].category_name
                if not args.no_flip_handedness:
                    label = "Left" if label == "Right" else "Right"

                pts = [(int(l.x * w), int(l.y * h)) for l in lms]
                gap_m, scale_m, midpoint = gap_and_scale(pts, world_lms, pc)
                norm = gap_m / scale_m

                tr = trackers.get(label)
                if tr is None:
                    tr = trackers[label] = PinchTracker(
                        hand=label, close_thresh=args.close, open_thresh=args.open_,
                        max_transition=args.max_transition, refractory=args.refractory)

                kind = tr.update(norm, t)
                if kind:
                    ev = PinchEvent(kind, label, t, tr.transition, gap_m * 1000.0, midpoint)
                    last_event = ev
                    if args.json:
                        print(json.dumps({
                            "event": ev.kind,
                            "hand": ev.hand,
                            "t": round(ev.t, 4),
                            "duration_ms": round(ev.duration * 1000.0, 1),
                            "gap_mm": round(ev.gap_mm, 1),
                            "xyz_m": None if ev.position is None
                                     else [round(float(c), 4) for c in ev.position],
                        }), flush=True)
                    else:
                        pos = "" if ev.position is None else (
                            f"  at ({ev.position[0]:+.2f}, {ev.position[1]:+.2f}, "
                            f"{ev.position[2]:+.2f}) m")
                        print(f"[{ev.t:7.2f}] {ev.kind:<10} {ev.hand:<5} "
                              f"gap {ev.gap_mm:5.1f} mm  {ev.duration * 1000:5.0f} ms{pos}",
                              flush=True)

                if frame is not None:
                    draw_hand(frame, pts, tr)

            frames += 1
            if time.time() - fps_t >= 0.5:
                fps = frames / (time.time() - fps_t)
                frames, fps_t = 0, time.time()

            if frame is not None:
                if last_event is not None:
                    draw_banner(frame, last_event, t - last_event.t)
                cv2.putText(frame, f"{fps:4.1f} fps",
                            (frame.shape[1] - 110, frame.shape[0] - 16),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1, cv2.LINE_AA)
                cv2.imshow("ZED pinch", frame)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        landmarker.close()
        zed.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
