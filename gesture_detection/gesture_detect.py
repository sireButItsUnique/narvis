#!/usr/bin/env python3
"""
Hand tracking and gesture detection on a ZED stereo camera.

    ZED left rectified image  ->  MediaPipe HandLandmarker (21 joints, 2D)
    ZED XYZ point cloud       ->  metric 3D per joint
    palm centroid             ->  position + velocity (One Euro filtered)
    thumb/index gap           ->  PINCH_IN / PINCH_OUT
    palm trajectory           ->  SWIPE LEFT/RIGHT/UP/DOWN/TOWARD/AWAY

Detection logic lives in gestures.py and is unit-tested without hardware.

Setup
    pip install mediapipe opencv-python numpy
    python "C:/Program Files (x86)/ZED SDK/get_python_api.py"
    curl.exe -L -O https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

Usage
    python gesture_detect.py                       # overlay window
    python gesture_detect.py --json --no-display   # events as JSON lines
    python gesture_detect.py --stream-hz 30        # add continuous pose output
    python gesture_detect.py --world               # positions in a fixed world frame
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import deque
from typing import Optional

import cv2
import numpy as np

from gestures import HandRegistry

try:
    import pyzed.sl as sl
except ImportError:
    sys.exit("pyzed not found. Run: python \"C:/Program Files (x86)/ZED SDK/get_python_api.py\"")

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
except ImportError:
    sys.exit("mediapipe not found.  pip install mediapipe")


# --------------------------------------------------------------------------
# landmark layout
# --------------------------------------------------------------------------

WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_MCP = 0, 4, 8, 9
PALM = (0, 5, 9, 13, 17)              # wrist + the four finger knuckles

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
]

EVENT_COLORS = {
    "PINCH_IN": (80, 160, 255), "PINCH_OUT": (120, 255, 160),
    "SWIPE": (255, 190, 70),
    "HAND_FOUND": (180, 180, 180), "HAND_LOST": (120, 120, 120),
}


# --------------------------------------------------------------------------
# 2D landmark -> metric 3D via the ZED point cloud
# --------------------------------------------------------------------------

def point_at(pc: np.ndarray, uv, radius: int = 3) -> Optional[np.ndarray]:
    """Median XYZ over a small patch. A single-pixel lookup on a fingertip
    returns NaN or the depth of the wall behind it -- tips sit exactly on the
    discontinuity the stereo matcher handles worst."""
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


def palm_pixel(pts) -> np.ndarray:
    return np.mean([pts[i] for i in PALM], axis=0)


def palm_point(pc: np.ndarray, pts, intr=None, last_z: Optional[float] = None):
    """(palm position or None, whether it came from real stereo depth).

    Centroid of the palm landmarks that have usable depth.

    The palm is a broad, roughly fronto-parallel surface, so stereo depth is
    far more reliable there than on the fingers -- which is why position and
    swipe track the palm and not the wrist joint or a fingertip.

    When depth fails anyway -- and on a hand moving fast enough to swipe it
    often does, which is precisely the worst moment to lose the trajectory --
    fall back to reprojecting the palm pixel at the hand's last known depth.
    A swipe is mostly lateral, so holding Z fixed for a few frames costs very
    little, and an interrupted trajectory costs the whole gesture.
    """
    got = [p for p in (point_at(pc, pts[i], radius=6) for i in PALM) if p is not None]
    if len(got) >= 2:
        arr = np.array(got)
        # drop outliers: a knuckle that latched onto the background would
        # otherwise drag the centroid metres away
        med = np.median(arr, axis=0)
        keep = arr[np.linalg.norm(arr - med, axis=1) < 0.12]
        return (keep if len(keep) else arr).mean(axis=0), True

    if intr is None or last_z is None:
        return None, False
    fx, fy, cx, cy = intr
    u, v = palm_pixel(pts)
    d = -last_z                            # metres in front of the camera
    if d <= 0.1:
        return None, False
    # verified against the ZED point cloud: exact to well under a millimetre
    return np.array([(u - cx) * d / fx, -(v - cy) * d / fy, last_z]), False


def depth_from_size(pts, scale_m: float, intr) -> Optional[float]:
    """Estimate hand depth from how large it appears.

    The reprojection fallback needs *some* depth, and a hand that has never had
    valid stereo depth has no previous value to reuse -- observed live as ten
    straight seconds of "no palm depth", unrecoverable because the fallback
    itself was waiting on a depth it would never get. Apparent size breaks the
    deadlock: palm length is known in metres from the monocular landmarks, so
    d = f * size_m / size_px.
    """
    fx, _, _, _ = intr
    px = float(np.linalg.norm(np.array(pts[WRIST], float) - np.array(pts[MIDDLE_MCP], float)))
    if px < 5.0 or scale_m <= 0.0:
        return None
    d = fx * scale_m / px
    return -d if 0.25 < d < 3.0 else None        # -Z is in front of the camera


def gap_and_scale(pts, world_lms, pc):
    """(tip gap m, hand scale m, 3D midpoint between the tips).

    Prefers ZED metric depth, falls back to MediaPipe's monocular world
    landmarks when the fingers drop out of the depth map -- which happens
    often, thumb and index tips being thin, fast and adjacent.
    """
    p_thumb = point_at(pc, pts[THUMB_TIP])
    p_index = point_at(pc, pts[INDEX_TIP])
    p_wrist = point_at(pc, pts[WRIST], radius=5)
    p_mmcp = point_at(pc, pts[MIDDLE_MCP], radius=5)

    gap = midpoint = None
    if p_thumb is not None and p_index is not None:
        g = float(np.linalg.norm(p_thumb - p_index))
        if g < 0.25:                        # a hand is not 25 cm across
            gap, midpoint = g, (p_thumb + p_index) * 0.5

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

def draw_hand(img, pts, tr, trail) -> None:
    pinched = tr.pinch.state == "closed"
    col = (40, 120, 255) if pinched else (60, 220, 60)
    for a, b in HAND_CONNECTIONS:
        cv2.line(img, pts[a], pts[b], col, 2, cv2.LINE_AA)
    for p in pts:
        cv2.circle(img, p, 3, (240, 240, 240), -1, cv2.LINE_AA)

    a, b = pts[THUMB_TIP], pts[INDEX_TIP]
    cv2.line(img, a, b, col if pinched else (200, 200, 60), 3, cv2.LINE_AA)
    mid = ((a[0] + b[0]) // 2, (a[1] + b[1]) // 2)
    cv2.circle(img, mid, int(4 + 10 * tr.pinch.strength), (40, 120, 255), 2, cv2.LINE_AA)

    # motion trail, fading into the past
    for i in range(1, len(trail)):
        f = i / len(trail)
        cv2.line(img, trail[i - 1], trail[i],
                 (int(60 + 80 * f), int(140 + 60 * f), int(255 * f)),
                 max(1, int(1 + 3 * f)), cv2.LINE_AA)

    palm_px = tuple(np.mean([pts[i] for i in PALM], axis=0).astype(int))
    cv2.circle(img, palm_px, 5, (255, 190, 70), -1, cv2.LINE_AA)

    # velocity arrow; +Y is up in 3D but down in pixels, hence the negated vy
    v = tr.velocity
    if np.linalg.norm(v[:2]) > 0.05:
        tip = (int(palm_px[0] + v[0] * 120), int(palm_px[1] - v[1] * 120))
        cv2.arrowedLine(img, palm_px, tip, (255, 190, 70), 2, cv2.LINE_AA, tipLength=0.3)

    lines = [f"{tr.hand}  pinch {tr.pinch.strength:.0%}"]
    if tr.position is not None:
        x, y, z = tr.position
        lines.append(f"{x:+.2f} {y:+.2f} {z:+.2f} m")
        lines.append(f"{np.linalg.norm(tr.velocity):.2f} m/s")
    for i, s in enumerate(lines):
        cv2.putText(img, s, (palm_px[0] - 45, palm_px[1] + 26 + 18 * i),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA)


def draw_banner(img, ev, age: float) -> None:
    alpha = max(0.0, 1.0 - age / 1.1)
    if alpha <= 0.0:
        return
    if ev.kind == "SWIPE":
        txt = (f"SWIPE {ev.direction}  {ev.hand}  {ev.distance * 100:.0f} cm  "
               f"{ev.peak_speed:.2f} m/s")
    elif ev.kind.startswith("PINCH"):
        txt = f"{ev.kind}  {ev.hand}  {ev.gap_mm:.0f} mm  in {ev.duration * 1000:.0f} ms"
    else:
        txt = f"{ev.kind}  {ev.hand}"
    overlay = img.copy()
    cv2.rectangle(overlay, (0, 0), (img.shape[1], 54), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.65 * alpha, img, 1.0 - 0.65 * alpha, 0, img)
    cv2.putText(img, txt, (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                EVENT_COLORS.get(ev.kind, (230, 230, 230)), 2, cv2.LINE_AA)


# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Hand position, pinch and swipe detection on a ZED camera.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)

    cam = ap.add_argument_group("camera")
    cam.add_argument("--model", default="hand_landmarker.task")
    cam.add_argument("--resolution", default="HD720", choices=["VGA", "HD720", "HD1080"])
    cam.add_argument("--fps", type=int, default=60)
    cam.add_argument("--depth-mode", default="NEURAL_LIGHT",
                     choices=["PERFORMANCE", "QUALITY", "ULTRA", "NEURAL_LIGHT", "NEURAL"])
    cam.add_argument("--hands", type=int, default=2)
    cam.add_argument("--confidence", type=int, default=100,
                     help="ZED depth confidence; LOWER discards more depth. "
                          "Measured on this rig: 50 keeps 23%% of pixels, "
                          "95 keeps 30%%, 100 keeps 41%%")
    cam.add_argument("--texture-confidence", type=int, default=100,
                     help="lower values discard low-texture depth; 90 already "
                          "costs two thirds of the depth map")
    cam.add_argument("--world", action="store_true",
                     help="enable positional tracking and report positions in a "
                          "fixed world frame, so a moving camera does not look "
                          "like a moving hand")

    p = ap.add_argument_group("pinch")
    p.add_argument("--close", type=float, default=0.35,
                   help="normalised gap below which the hand counts as pinched")
    p.add_argument("--open", dest="open_", type=float, default=0.55,
                   help="normalised gap above which it counts as open")
    p.add_argument("--max-transition", type=float, default=0.35,
                   help="seconds; slower than this is a pose change, not a gesture")
    p.add_argument("--pinch-refractory", type=float, default=0.35)

    s = ap.add_argument_group("swipe")
    s.add_argument("--swipe-window", type=float, default=0.35,
                   help="seconds of trajectory examined")
    s.add_argument("--min-speed", type=float, default=0.55, help="m/s, peak")
    s.add_argument("--min-travel", type=float, default=0.14, help="metres, net")
    s.add_argument("--swipe-refractory", type=float, default=0.50)
    s.add_argument("--no-swipe-while-pinched", dest="swipe_while_pinched",
                   action="store_false", default=True,
                   help="suppress swipes while the hand is pinched. Off by "
                        "default: gating it silently kills every swipe made "
                        "with a relaxed or curled hand")
    s.add_argument("--mirror-x", action="store_true",
                   help="name LEFT/RIGHT from the subject's point of view "
                        "instead of the camera's")

    o = ap.add_argument_group("output")
    o.add_argument("--json", action="store_true", help="one JSON object per event")
    o.add_argument("--stream-hz", type=float, default=0.0,
                   help="also emit continuous position/velocity at this rate")
    o.add_argument("--no-display", action="store_true")
    o.add_argument("--no-flip-handedness", action="store_true",
                   help="MediaPipe labels hands assuming a mirrored selfie view; "
                        "the ZED is world-facing, so labels are flipped by default")
    o.add_argument("--debug-swipe", action="store_true",
                   help="print why each frame did not produce a swipe, plus "
                        "palm-depth dropout rate")
    o.add_argument("--duration", type=float, default=0.0,
                   help="stop after N seconds (0 = run until q/Esc/Ctrl-C)")
    return ap


def main() -> int:
    args = build_parser().parse_args()

    if not os.path.exists(args.model):
        sys.exit(f"Model not found: {args.model}\n"
                 "curl.exe -L -O https://storage.googleapis.com/mediapipe-models/"
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
        sys.exit(f"ZED open failed: {status}\n"
                 "If it says CAMERA NOT DETECTED while the camera is plugged in, "
                 "close ZED Explorer / ZEDfu / any other app holding the stream.")

    if args.world:
        zed.enable_positional_tracking(sl.PositionalTrackingParameters())

    runtime = sl.RuntimeParameters()
    runtime.enable_fill_mode = False          # prefer NaN over invented depth
    runtime.confidence_threshold = args.confidence
    runtime.texture_confidence_threshold = args.texture_confidence

    calib = zed.get_camera_information().camera_configuration.calibration_parameters.left_cam
    intr = (calib.fx, calib.fy, calib.cx, calib.cy)

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

    registry = HandRegistry(
        close=args.close, open_=args.open_,
        max_transition=args.max_transition, pinch_refractory=args.pinch_refractory,
        swipe_window=args.swipe_window, min_speed=args.min_speed,
        min_travel=args.min_travel, swipe_refractory=args.swipe_refractory,
        mirror_x=args.mirror_x, swipe_while_pinched=args.swipe_while_pinched,
    )

    img_mat, pc_mat, pose = sl.Mat(), sl.Mat(), sl.Pose()
    trails: dict = {}
    last_z: dict = {}                      # per hand: (z, timestamp)
    next_debug = 0.0
    last_event = None
    last_ts_ms, t0 = -1, None
    next_stream = 0.0
    frames, fps_t, fps = 0, time.time(), 0.0

    def emit(ev) -> None:
        if args.json:
            print(json.dumps(ev.to_dict()), flush=True)
        elif ev.kind == "SWIPE":
            print(f"[{ev.t:7.2f}] SWIPE {ev.direction:<7} {ev.hand:<5} "
                  f"{ev.distance * 100:5.1f} cm  {ev.peak_speed:4.2f} m/s  "
                  f"straight {ev.straightness:.2f}", flush=True)
        elif ev.kind.startswith("PINCH"):
            pos = "" if ev.position is None else (
                f"  at ({ev.position[0]:+.2f}, {ev.position[1]:+.2f}, {ev.position[2]:+.2f}) m")
            print(f"[{ev.t:7.2f}] {ev.kind:<10} {ev.hand:<5} gap {ev.gap_mm:5.1f} mm  "
                  f"{ev.duration * 1000:5.0f} ms{pos}", flush=True)
        else:
            print(f"[{ev.t:7.2f}] {ev.kind:<10} {ev.hand}", flush=True)

    def to_world(p: Optional[np.ndarray]) -> Optional[np.ndarray]:
        if p is None or not args.world:
            return p
        try:
            zed.get_position(pose, sl.REFERENCE_FRAME.WORLD)
            R = pose.get_rotation_matrix().r
            t = pose.get_translation().get()
            return np.asarray(R) @ p + np.asarray(t)
        except Exception:
            return p                      # tracking not ready: camera frame is fine

    print("Running. q / Esc / Ctrl-C to quit.", file=sys.stderr)

    try:
        while True:
            if zed.grab(runtime) != sl.ERROR_CODE.SUCCESS:
                continue

            zed.retrieve_image(img_mat, sl.VIEW.LEFT)
            zed.retrieve_measure(pc_mat, sl.MEASURE.XYZRGBA)
            bgra = img_mat.get_data()
            pc = pc_mat.get_data()

            ts_ms = int(zed.get_timestamp(sl.TIME_REFERENCE.IMAGE).get_milliseconds())
            ts_ms = max(ts_ms, last_ts_ms + 1)   # detect_for_video needs monotonic ms
            last_ts_ms = ts_ms
            if t0 is None:
                t0 = ts_ms / 1000.0
            t = ts_ms / 1000.0 - t0
            if args.duration and t > args.duration:
                break

            rgb = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGB)     # ZED is BGRA, not BGR
            res = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)

            h, w = rgb.shape[:2]
            frame = None if args.no_display else bgra[:, :, :3].copy()
            stream_due = args.stream_hz > 0 and t >= next_stream

            seen_labels = set()
            for lms, world_lms, handed in zip(res.hand_landmarks,
                                              res.hand_world_landmarks,
                                              res.handedness):
                label = handed[0].category_name
                if not args.no_flip_handedness:
                    label = "Left" if label == "Right" else "Right"
                if label in seen_labels:
                    # two detections sharing one label would drive the same
                    # tracker twice at one timestamp, producing a zero dt
                    continue
                seen_labels.add(label)

                pts = [(int(l.x * w), int(l.y * h)) for l in lms]
                gap_m, scale_m, tip_mid = gap_and_scale(pts, world_lms, pc)

                # a recent real depth is the best hint; past that the hand may
                # have moved in Z, so fall back to apparent size
                z_hint = None
                prev = last_z.get(label)
                if prev is not None and t - prev[1] < 0.5:
                    z_hint = prev[0]
                if z_hint is None:
                    z_hint = depth_from_size(pts, scale_m, intr)

                palm_cam, from_depth = palm_point(pc, pts, intr, z_hint)
                if palm_cam is not None and from_depth:
                    last_z[label] = (float(palm_cam[2]), t)
                palm = to_world(palm_cam)

                tr, found = registry.get(label, t)
                new_events = tr.update(palm, gap_m / scale_m, t,
                                       gap_m=gap_m, tip_mid=to_world(tip_mid))
                if found:
                    found.position = tr.position   # known only after the update
                    emit(found)
                    last_event = found
                for ev in new_events:
                    emit(ev)
                    last_event = ev

                if stream_due:
                    emit_state = tr.state(t)
                    if args.json:
                        print(json.dumps(emit_state.to_dict()), flush=True)

                if args.debug_swipe and t >= next_debug:
                    st = tr.swipe.stats
                    drop = tr.frames_no_depth / max(tr.frames, 1)
                    detail = (f"travel {st['travel'] * 100:5.1f}cm  "
                              f"peak {st['peak']:4.2f}m/s  "
                              f"straight {st['straight']:4.2f}  "
                              f"dom {st['dominance']:4.1f}" if st else "-")
                    print(f"[{t:6.2f}] {label:<5} {detail}  "
                          f"no-depth {drop:4.0%}  <- {tr.swipe.reject or 'FIRED'}",
                          file=sys.stderr, flush=True)

                trail = trails.setdefault(label, deque(maxlen=28))
                trail.append(tuple(np.mean([pts[i] for i in PALM], axis=0).astype(int)))
                if frame is not None:
                    draw_hand(frame, pts, tr, trail)

            if stream_due:
                next_stream = t + 1.0 / args.stream_hz
            if args.debug_swipe and t >= next_debug:
                next_debug = t + 0.2

            for ev in registry.sweep(t):
                emit(ev)
                last_event = ev
                trails.pop(ev.hand, None)
                last_z.pop(ev.hand, None)

            frames += 1
            if time.time() - fps_t >= 0.5:
                fps = frames / (time.time() - fps_t)
                frames, fps_t = 0, time.time()

            if frame is not None:
                if last_event is not None:
                    draw_banner(frame, last_event, t - last_event.t)
                hud = f"{fps:4.1f} fps  {'world' if args.world else 'camera'} frame"
                cv2.putText(frame, hud, (frame.shape[1] - 230, frame.shape[0] - 16),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1, cv2.LINE_AA)
                cv2.imshow("ZED gestures", frame)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        landmarker.close()
        if args.world:
            zed.disable_positional_tracking()
        zed.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
