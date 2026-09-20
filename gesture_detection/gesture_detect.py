#!/usr/bin/env python3
"""
Hand tracking and gesture detection on a ZED camera.

    left + right images       ->  MediaPipe HandLandmarker on each, 21 joints
    where each detection is   ->  which one is THE hand: one track, never two
    landmarks                 ->  One Euro filtered in 2D, before any 3D work
    left pixels               ->  one viewing ray per joint
    left vs right disparity   ->  per-joint depth, no dense matcher involved
    disparity + apparent size ->  where the hand is, without the depth map
    depth map                 ->  per-joint depth, read inside the hand and only
                                  from pixels that reference says are the hand
    MediaPipe world landmarks ->  metric hand shape, and bone lengths over time
    all of the above          ->  one solve for 21 depths (fuse3d.solve_depths)
    palm centroid             ->  position + velocity
    thumb/index gap           ->  PINCH_IN / PINCH_OUT
    palm trajectory           ->  SWIPE LEFT/RIGHT/UP/DOWN/TOWARD/AWAY

Joints are never estimated independently. A depth patch around a fingertip
straddles the hand and whatever is behind it, and a median over it returns
whichever has more pixels -- on a thin finger, regularly the wall. Because a
joint's pixel already fixes its ray, a hand is 21 unknowns rather than 63, and
every input constrains them jointly: two independent depth measurements per
joint, a metric shape prior, and bone lengths that cannot change. A fingertip
with no depth is pinned by the bones to knuckles that have one; a fingertip
with wrong depth is outvoted and then dropped outright.

Simulated against backgrounds 8-50 cm behind the hand, per-joint sampling put
15% of joints more than 5 cm out of place and stretched 18% of bones by over a
quarter. The solve leaves 0% of either. Against each input on its own it is
better at both the median and the 90th percentile, and it collapses the worst
1% of errors from 354 mm (depth map alone) to 25 mm.

The preview window is resizable. Camera settings can be changed without
restarting -- [r] resolution, [f] frame rate, [d] depth mode -- each of which
closes and reopens the camera, freezing the window for about two seconds.

Detection logic lives in gestures.py, depth sampling in depthsample.py and the
solve in fuse3d.py; all three are unit-tested without hardware.

Setup
    pip install mediapipe opencv-python numpy
    python "C:/Program Files (x86)/ZED SDK/get_python_api.py"
    curl.exe -L -O https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

Usage
    python gesture_detect.py                       # overlay window
    python gesture_detect.py --json --no-display   # events as JSON lines
    python gesture_detect.py --stream-hz 30        # add continuous pose output
    python gesture_detect.py --world               # positions in a fixed world frame
    python gesture_detect.py --resolution VGA --fps 100   # low latency
    python gesture_detect.py --depth-mode NEURAL_PLUS     # most accurate depth
    python gesture_detect.py --list-modes                 # what this camera supports
    python gesture_detect.py --no-right-view              # left camera only, faster
    python gesture_detect.py --rig-bridge                 # feed the Pepper's-ghost rig:
                                                          #   hands AND head, see rig_bridge.py

Probed on the attached ZED 2 (--list-modes reports this for any camera):
    VGA      672x376     up to 100 fps
    HD720   1280x720     up to  60 fps
    HD1080  1920x1080    up to  30 fps
    HD2K    2208x1242    up to  15 fps
An unsupported frame rate is clamped by the SDK rather than rejected, so what
was actually granted is printed at startup.

Depth modes measured on the same camera at HD720@60, static scene:
    mode           fps    valid depth
    PERFORMANCE   58.4         58.3%
    NEURAL_LIGHT  58.0         55.7%
    ULTRA         59.3         46.2%
    NEURAL        59.3         39.6%
    NEURAL_PLUS   29.1         38.3%
Coverage is not accuracy -- the neural modes return fewer points but place
them better, and coverage swings with scene texture. It does matter here
though: palm depth dropouts are what break swipe tracking, and NEURAL_PLUS
halves the frame rate while covering less than NEURAL_LIGHT.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import cv2
import numpy as np

from gestures import SMOOTHING_PRESETS, OneHand, fuse_gaps, pinch_gaps, tracking_confidence
from depthsample import (at_sample_points, joint_tolerance, locate_palm,
                         sample_joint_depths, sample_unbiased)
from fuse3d import (BoneCalibration, MetricBones, RecentScale, ScaleCalibration, depthmap_sigma,
                    disparity_noise,
                    fuse_measurements, points_from_depths, rays_from_pixels,
                    row_tolerance, same_hand, size_depth, solve_depths,
                    triangulate_depths, triangulation_sigma)
from handmodel import (MultiOneEuro, DepthShapeFilter, DepthSignEstimator, bone_lengths,
                       model_relative_depth)
from palmtrack import PalmTracker, ShapeMemory
from viewwindow import ViewWindow, disparity_shift
from viz3d import Viewer3D

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
# camera modes
# --------------------------------------------------------------------------

# Taken from the installed SDK rather than hardcoded, so the choices always
# match what this pyzed build can actually do. CUSTOM/LAST are internal and
# NONE would switch depth off entirely, which this program needs.
DEPTH_MODES = [m for m in ("NEURAL_LIGHT", "NEURAL", "NEURAL_PLUS",
                           "PERFORMANCE", "QUALITY", "ULTRA", "NONE")
               if hasattr(sl.DEPTH_MODE, m)]

# Ordered small to large. Which ones a given camera supports depends on the
# model, so --list-modes probes rather than guesses.
RESOLUTIONS = [r for r in ("VGA", "SVGA", "HD720", "HD1080", "HD1200",
                           "HD1536", "QHDPLUS", "HD2K", "HD4K")
               if hasattr(sl.RESOLUTION, r)]


#: Frame rates the SDK accepts, filtered per resolution by MAX_FPS below.
FPS_LADDER = (15, 30, 60, 100)

#: Ceilings probed on a ZED 2. Only a starting point -- a session corrects an
#: entry the moment the SDK grants something lower than was asked for, so an
#: unlisted resolution or a different camera model self-corrects on first use.
MAX_FPS = {"VGA": 100, "SVGA": 60, "HD720": 60, "HD1080": 30, "HD2K": 15}


def fps_choices(resolution: str):
    return [f for f in FPS_LADDER if f <= MAX_FPS.get(resolution, 100)] or [15]


class CameraSession:
    """Owns the ZED handle and the settings that require reopening it.

    Resolution, frame rate and depth mode are all InitParameters, so changing
    any of them means closing the camera and opening it again -- roughly two
    seconds during which the window is frozen. Keeping that behind one object
    means the reopen path and the startup path are the same code, so a setting
    changed at runtime cannot drift from one set at the command line.
    """

    def __init__(self, resolution: str, fps: int, depth_mode: str, world: bool,
                 confidence: int, texture_confidence: int,
                 right_view: bool = False, replay: str = "", record: str = "",
                 exposure: Optional[int] = None, gain: Optional[int] = None,
                 led: Optional[bool] = None):
        self.right_view = right_view
        self.replay, self.record = replay, record
        self.exposure, self.gain, self.led = exposure, gain, led
        self.notes: list = []
        self.baseline = 0.0
        self.resolution = resolution
        self.fps = fps
        self.depth_mode = depth_mode
        self.world = world
        self.zed = sl.Camera()
        self.runtime = sl.RuntimeParameters()
        self.runtime.enable_fill_mode = False     # prefer NaN over invented depth
        self.runtime.confidence_threshold = confidence
        self.runtime.texture_confidence_threshold = texture_confidence
        self.granted_fps = 0.0
        self.granted_depth_mode = depth_mode
        self.width = self.height = 0
        self.intr = (0.0, 0.0, 0.0, 0.0)

    def _init_params(self) -> sl.InitParameters:
        init = sl.InitParameters()
        init.camera_resolution = getattr(sl.RESOLUTION, self.resolution)
        init.camera_fps = self.fps
        init.depth_mode = getattr(sl.DEPTH_MODE, self.depth_mode)
        init.coordinate_units = sl.UNIT.METER
        init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP
        init.depth_minimum_distance = 0.3
        # the *_RIGHT measures do not exist unless this is set before opening
        init.enable_right_side_measure = self.right_view and self.depth_mode != "NONE"
        if self.replay:
            # A recording instead of the device: the same frames, through the same loop, as often as it
            # takes. NOT in real time - every frame is processed, however long the loop takes over it.
            init.set_from_svo_file(self.replay)
            init.svo_real_time_mode = False
        return init

    def _apply_video_settings(self) -> None:
        """Exposure, gain and the front LED, where asked for. The rig is dark on purpose and the ZED's
        auto-exposure answers a dark scene with a LONG exposure - up to ~11 ms at 60 fps, which smears a
        hand moving at 0.3 m/s by ~7 px at rig range, several times the landmark noise the fusion assumes.
        A short fixed exposure with more gain trades that smear for grain, which the landmarker minds
        less. Each value is read back, because the SDK clamps silently."""
        if self.replay:
            return                                # a recording has the exposure it was recorded with
        wanted = [("EXPOSURE", self.exposure), ("GAIN", self.gain),
                  ("LED_STATUS", None if self.led is None else int(self.led))]
        for name, value in wanted:
            if value is None:
                continue
            try:
                setting = getattr(sl.VIDEO_SETTINGS, name)
                err = self.zed.set_camera_settings(setting, int(value))
                got = self.zed.get_camera_settings(setting)
                got = got[1] if isinstance(got, tuple) else got
                self.notes.append(f"camera {name.lower()} asked {value}, running {got} ({err})")
            except Exception as e:                # noqa: BLE001 - an SDK that lacks the setting is not fatal
                self.notes.append(f"camera {name.lower()} could not be set: {e}")

    def _start_recording(self) -> None:
        if not self.record or self.replay:
            return
        params = sl.RecordingParameters()
        params.video_filename = self.record
        params.compression_mode = sl.SVO_COMPRESSION_MODE.H264      # small; H264_LOSSLESS if the disk can take it
        err = self.zed.enable_recording(params)
        self.notes.append(f"recording to {self.record}: {err}")

    def open(self):
        status = self.zed.open(self._init_params())
        if status != sl.ERROR_CODE.SUCCESS:
            return status
        if self.world:
            self.zed.enable_positional_tracking(sl.PositionalTrackingParameters())

        cc = self.zed.get_camera_information().camera_configuration
        self.granted_fps = float(cc.fps)
        self.width, self.height = cc.resolution.width, cc.resolution.height

        # The SDK substitutes silently as well as clamping: NEURAL_PLUS is not
        # available at VGA/SVGA and quietly becomes NEURAL. Reporting the
        # requested mode would make the HUD lie, so read back what is running.
        self.granted_depth_mode = str(
            self.zed.get_init_parameters().depth_mode).rsplit(".", 1)[-1]
        # Intrinsics change with resolution, so they must be re-read on every
        # open. Reusing HD720's fx at VGA would put every reprojected hand in
        # the wrong place, silently.
        lc = cc.calibration_parameters.left_cam
        self.intr = (lc.fx, lc.fy, lc.cx, lc.cy)
        self.baseline = float(cc.calibration_parameters.get_camera_baseline())

        if self.fps and self.granted_fps < self.fps - 0.5 and not self.replay:
            # the SDK clamps rather than failing, so learn the real ceiling
            MAX_FPS[self.resolution] = int(self.granted_fps)
        self._apply_video_settings()
        self._start_recording()
        return None

    def close(self):
        if self.record and not self.replay:
            try:
                self.zed.disable_recording()
            except Exception:                     # noqa: BLE001
                pass
        if self.world:
            self.zed.disable_positional_tracking()
        self.zed.close()

    def reopen(self, **changes):
        """Apply setting changes, reverting them if the camera will not open."""
        previous = {k: getattr(self, k) for k in changes}
        for k, v in changes.items():
            setattr(self, k, v)
        self.close()
        status = self.open()
        if status is None:
            return None
        for k, v in previous.items():             # put it back and recover
            setattr(self, k, v)
        self.close()
        return status if self.open() is not None else status

    def describe(self) -> str:
        mode = self.granted_depth_mode
        if mode != self.depth_mode:
            mode = f"{mode} (asked {self.depth_mode})"
        return (f"{self.resolution} {self.width}x{self.height}@"
                f"{self.granted_fps:.0f}  {mode}")


class Track:
    """What belongs to the hand being followed, and must not outlive it.

    A new hand starts clean: filters with another hand's history in them would
    drag it toward where that hand was. What belongs to the PERSON rather than
    the track -- bone lengths, hand scale -- is kept outside and survives.
    """

    def __init__(self):
        self.px_filt = MultiOneEuro((21, 2), min_cutoff=1.2, beta=0.010)
        self.rx_filt = MultiOneEuro((21, 2), min_cutoff=1.2, beta=0.010)
        self.j_filt = MultiOneEuro((21, 3), min_cutoff=1.0, beta=2.0, together=True)
        self.seen = -1e9
        self.from_right = False
        self.last_z = None                     # (z, timestamp)
        self.recent_scale = RecentScale()      # bridges frames the second lens misses
        self.palm = PalmTracker()              # the palm's distance, carried frame to frame
        self.shape = ShapeMemory()             # ...and each joint's depth relative to it
        self.d_filt = DepthShapeFilter()       # depth is the noisy direction: steadied on its own
        self.trail: deque = deque(maxlen=28)
        self.trail3d: deque = deque(maxlen=60)

    def reset_filters(self) -> None:
        self.px_filt.reset()
        self.rx_filt.reset()
        self.j_filt.reset()
        self.d_filt.reset()


WINDOW = "ZED gestures"
VIZ_WINDOW = "ZED hands 3D"

#: Resolutions offered by the [r] key. Starts as the ones a USB ZED plausibly
#: supports and shrinks when one refuses to open, so cycling never gets stuck
#: on a mode this camera does not have.
CYCLABLE = {"VGA", "SVGA", "HD720", "HD1080", "HD2K"}


def settings_for_key(key: int, cam: "CameraSession") -> dict:
    """Map a keypress to the camera settings it should change, or {}."""
    if key == ord("r"):
        opts = [r for r in RESOLUTIONS if r in CYCLABLE]
        if not opts:
            return {}
        nxt = opts[(opts.index(cam.resolution) + 1) % len(opts)
                   if cam.resolution in opts else 0]
        # carry the frame rate over, but not past what the new mode allows --
        # otherwise every resolution change silently lands on a clamped rate
        return {"resolution": nxt, "fps": min(cam.fps or 60, max(fps_choices(nxt)))}
    if key == ord("f"):
        opts = fps_choices(cam.resolution)
        cur = int(cam.granted_fps)
        return {"fps": opts[(opts.index(cur) + 1) % len(opts)] if cur in opts else opts[0]}
    if key == ord("d"):
        i = DEPTH_MODES.index(cam.depth_mode)
        return {"depth_mode": DEPTH_MODES[(i + 1) % len(DEPTH_MODES)]}
    return {}


def list_modes() -> int:
    """Probe the attached camera for the resolutions and frame rates it grants.

    The SDK silently clamps an unsupported frame rate to the nearest supported
    one instead of failing, so asking for 100 fps and reading back what you got
    is the only honest way to learn the ceiling.
    """
    print(f"depth modes: {', '.join(DEPTH_MODES)}")
    print()
    print(f"{'resolution':<12} {'granted':<14} max fps")
    for name in RESOLUTIONS:
        init = sl.InitParameters()
        init.camera_resolution = getattr(sl.RESOLUTION, name)
        init.camera_fps = 100                      # ask high, see what is given
        init.depth_mode = sl.DEPTH_MODE.NONE       # no depth work just to probe
        cam = sl.Camera()
        if cam.open(init) != sl.ERROR_CODE.SUCCESS:
            print(f"{name:<12} {'unsupported':<14} -")
            continue
        cc = cam.get_camera_information().camera_configuration
        print(f"{name:<12} {str(cc.resolution.width) + 'x' + str(cc.resolution.height):<14} "
              f"{cc.fps:.0f}")
        cam.close()
    return 0


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
               f"{ev.peak_speed:.2f} m/s" + ("  [bridged]" if ev.bridged else ""))
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
    cam.add_argument("--resolution", default="HD720", choices=RESOLUTIONS,
                     help="run --list-modes to see what this camera grants")
    cam.add_argument("--fps", type=int, default=60,
                     help="the SDK clamps an unsupported rate to the nearest "
                          "supported one rather than failing, so the rate "
                          "actually granted is reported at startup")
    cam.add_argument("--depth-mode", default=None, choices=DEPTH_MODES,
                     help="the SDK's dense depth map. Default NEURAL_LIGHT -- except with --rig-bridge, where "
                          "it is NONE: at the rig's 20-45 cm the map mostly shows the forearm or nothing, and "
                          "on a recording of the rig the hand was steadier WITHOUT it (a third fewer depth "
                          "jumps) and every frame 15-20 ms cheaper. The hand's distance then comes from the two "
                          "lenses alone. Measured here at HD720@60: NEURAL_LIGHT 58 fps/55.7%% "
                          "valid depth, NEURAL 59/39.6%%, NEURAL_PLUS 29/38.3%%. "
                          "NEURAL_PLUS places points more accurately but halves "
                          "the frame rate and covers less")
    cam.add_argument("--record", default="", metavar="FILE.svo2",
                     help="also record the camera's frames to this file while running. A recording can be "
                          "replayed through this same program as often as wanted (--replay), which is how "
                          "tracking gets tuned on YOUR hand in YOUR rig instead of on a simulation")
    cam.add_argument("--replay", default="", metavar="FILE.svo2",
                     help="run on a recording instead of the camera: every frame, not in real time")
    cam.add_argument("--exposure", type=int, default=None, metavar="0-100",
                     help="fix the exposure (percent of the frame time) instead of auto. In a dark rig auto "
                          "means long, and long means a moving hand is smeared. Try 25 with --gain 70; the "
                          "value the camera is really running is printed at start-up")
    cam.add_argument("--gain", type=int, default=None, metavar="0-100",
                     help="fix the gain instead of auto; pair with --exposure")
    cam.add_argument("--led", choices=("on", "off"), default=None,
                     help="the ZED's front LED: a point light a hand's width from the acrylic. Off is kinder to the ghost")
    cam.add_argument("--no-windows", dest="windows", action="store_false",
                     help="give each landmarker the WHOLE frame, as it used to be, instead of a window onto "
                          "the hand (viewwindow.py). On the rig the hand is small in a dark frame and the "
                          "palm detector keeps losing it; the window is what keeps both lenses on the hand")
    cam.add_argument("--list-modes", action="store_true",
                     help="probe the camera for supported resolutions and frame "
                          "rates, then exit")
    cam.add_argument("--confidence", type=int, default=100,
                     help="ZED depth confidence; LOWER discards more depth. "
                          "Measured on this rig: 50 keeps 23%% of pixels, "
                          "95 keeps 30%%, 100 keeps 41%%")
    cam.add_argument("--texture-confidence", type=int, default=100,
                     help="lower values discard low-texture depth; 90 already "
                          "costs two thirds of the depth map")
    cam.add_argument("--no-right-view", dest="right_view", action="store_false",
                     default=True,
                     help="when the left view finds no hand, look in the right "
                          "one too. The two views disagree about occlusion and "
                          "about which detections fail, so this recovers frames "
                          "the left alone loses. It costs a second landmarker "
                          "pass only on frames the left view missed, and only "
                          "at full rate while a hand is known to be around; "
                          "otherwise it just polls, so an empty scene is nearly "
                          "free")
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
    o.add_argument("--viz3d", action="store_true",
                   help="open a second window showing the tracked hands in 3D "
                        "space; drag to orbit, wheel or +/- to zoom. Toggle at "
                        "runtime with [v]")
    o.add_argument("--smoothing", default="balanced",
                   choices=sorted(SMOOTHING_PRESETS),
                   help="position smoothing. Measured RMS jitter on a still "
                        "hand: responsive 14 mm, balanced 0.6 mm (+17 ms lag), "
                        "steady 0.6 mm (+50 ms). All three still detect swipes; "
                        "steady buys little here beyond the lag")
    o.add_argument("--flip-handedness", action="store_true",
                   help="swap the Left/Right labels. MediaPipe documents its "
                        "handedness as assuming a mirrored selfie view, which "
                        "suggested the world-facing ZED needed a flip -- but on "
                        "this rig that produced swapped hands, so the raw label "
                        "is correct and flipping is now opt-in")
    o.add_argument("--lost-after", type=float, default=0.50,
                   help="seconds before reporting HAND_LOST; below the swipe "
                        "gap-bridge limit this reports dropouts as lost hands")
    o.add_argument("--detection-confidence", type=float, default=0.5)
    o.add_argument("--tracking-confidence", type=float, default=0.3,
                   help="deliberately low: a hand moving fast enough to swipe "
                        "motion-blurs, and a strict threshold drops the track "
                        "exactly mid-gesture")
    o.add_argument("--debug-swipe", action="store_true",
                   help="print why each frame did not produce a swipe, plus "
                        "palm-depth dropout rate")
    o.add_argument("--rig-bridge", type=int, nargs="?", const=8902, default=0, metavar="PORT",
                   help="stream the hand's 21 joints AND the viewer's eye point to "
                        "the rig page (rig/rigtest3/?bridge=1) over a WebSocket, so "
                        "it can draw the hand where the real one is, from where the "
                        "head is. This process then owns the ZED: the page must not "
                        "open it too")
    o.add_argument("--face-model", default="face_landmarker.task",
                   help="MediaPipe face landmarker, for the head. Only used with "
                        "--rig-bridge")
    o.add_argument("--debug-depth", action="store_true",
                   help="print where the palm's depth came from, five times a "
                        "second: the reference (triangulated and from apparent "
                        "size, with its learned scale), the depth map's answer, "
                        "and how many patch pixels passed the reference's gate. "
                        "REFERENCE means the map had nothing the gate accepted")
    o.add_argument("--duration", type=float, default=0.0,
                   help="stop after N seconds (0 = run until q/Esc/Ctrl-C)")
    return ap


def main() -> int:
    args = build_parser().parse_args()

    if args.list_modes:
        return list_modes()
    if args.depth_mode is None:
        args.depth_mode = "NONE" if args.rig_bridge and "NONE" in DEPTH_MODES else "NEURAL_LIGHT"

    if not os.path.exists(args.model):
        sys.exit(f"Model not found: {args.model}\n"
                 "curl.exe -L -O https://storage.googleapis.com/mediapipe-models/"
                 "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task")

    # ---- ZED --------------------------------------------------------------
    cam = CameraSession(args.resolution, args.fps, args.depth_mode, args.world,
                        args.confidence, args.texture_confidence,
                        right_view=args.right_view, replay=args.replay, record=args.record,
                        exposure=args.exposure, gain=args.gain,
                        led=None if args.led is None else args.led == "on")
    status = cam.open()
    if status is not None:
        sys.exit(f"ZED open failed: {status}\n"
                 "If it says CAMERA NOT DETECTED while the camera is plugged in, "
                 "close ZED Explorer / ZEDfu / any other app holding the stream.")

    zed, runtime = cam.zed, cam.runtime
    print(f"opened {cam.describe()}" + (f"  <- replaying {args.replay}" if args.replay else ""),
          file=sys.stderr)
    for note in cam.notes:
        print(f"  {note}", file=sys.stderr)
    if args.fps and abs(cam.granted_fps - args.fps) > 0.5:
        print(f"  note: {args.fps} fps is not supported at {args.resolution}; "
              f"the SDK gave {cam.granted_fps:.0f}", file=sys.stderr)
    if not args.no_display:
        print("keys: [r] resolution  [f] fps  [d] depth mode  [q] quit",
              file=sys.stderr)

    # ---- MediaPipe --------------------------------------------------------
    def make_landmarker():
        return vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=args.model),
                running_mode=vision.RunningMode.VIDEO,
                # One hand per view, and one track overall (gestures.OneHand).
                # Asking for more makes the landmarker invent a marginal
                # second hand; a second real one simply waits its turn.
                num_hands=1,
                min_hand_detection_confidence=args.detection_confidence,
                min_hand_presence_confidence=args.tracking_confidence,
                min_tracking_confidence=args.tracking_confidence,
            )
        )

    landmarker = make_landmarker()

    bridge = None
    if args.rig_bridge:
        from rig_bridge import RigBridge, report
        bridge = RigBridge(args.rig_bridge, args.face_model, fps=cam.granted_fps)
        bridge.server.describe_camera(cam.intr, (cam.width, cam.height), cam.baseline, cam.granted_fps)
        bridge.server.describe_landmarker(args.detection_confidence, args.tracking_confidence)
        if not args.right_view:
            bridge.notes.append("--no-right-view: the head needs both views, so there "
                                "will be no head tracking")
        if bridge.start():
            print(f"rig bridge on ws://127.0.0.1:{args.rig_bridge}  ->  open "
                  f"rig/rigtest3/?bridge=1", file=sys.stderr)
        report(bridge.notes)

    track: Optional[Track] = None          # the hand being followed, if any
    bone_cal = BoneCalibration()           # the person's, so kept between hands
    metric_bones = MetricBones()           # ...and their lengths as the two lenses measure them
    scale_cal = ScaleCalibration()
    depth_sign = DepthSignEstimator()

    viewer = Viewer3D()
    viz_on = args.viz3d and not args.no_display
    if args.viz3d and args.no_display:
        print("  note: --viz3d needs a window, ignoring it under --no-display",
              file=sys.stderr)
    viz_open = False

    hand = OneHand(
        lost_after=args.lost_after,
        close=args.close, open_=args.open_,
        max_transition=args.max_transition, pinch_refractory=args.pinch_refractory,
        swipe_window=args.swipe_window, min_speed=args.min_speed,
        min_travel=args.min_travel, swipe_refractory=args.swipe_refractory,
        mirror_x=args.mirror_x, swipe_while_pinched=args.swipe_while_pinched,
        smoothing=args.smoothing,
    )

    img_mat, pc_mat, pose = sl.Mat(), sl.Mat(), sl.Pose()
    img_r_mat, pc_r_mat = sl.Mat(), sl.Mat()
    landmarker_r = None                    # built lazily, on the first frame
    right_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="right-view")
    win_l = win_r = None                   # each view's window onto the hand; built with the first frame
    no_map = None                          # the blank cloud used when the SDK computes no depth
    last_palm_d = None                     # (depth, t) of the palm last time it was placed
    recovered = {"frames": 0, "by_right": 0, "right_passes": 0}
    next_debug = next_debug_depth = 0.0
    last_event = None
    last_ts_ms, t0 = -1, None
    next_stream = 0.0
    frames, fps_t, fps = 0, time.time(), 0.0
    total_frames, wall_start = 0, time.time()

    def emit(ev) -> None:
        if args.json:
            print(json.dumps(ev.to_dict()), flush=True)
        elif ev.kind == "SWIPE":
            how = "  (bridged a dropout)" if ev.bridged else ""
            print(f"[{ev.t:7.2f}] SWIPE {ev.direction:<7} {ev.hand:<5} "
                  f"{ev.distance * 100:5.1f} cm  {ev.peak_speed:4.2f} m/s  "
                  f"straight {ev.straightness:.2f}{how}", flush=True)
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

    if not args.no_display:
        # WINDOW_NORMAL makes the window user-resizable and scales the frame to
        # fit, which also means a resolution change does not resize the window
        # out from under you. KEEPRATIO stops the image stretching.
        cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO)
        scale = min(1.0, 1280 / max(cam.width, 1), 720 / max(cam.height, 1))
        cv2.resizeWindow(WINDOW, int(cam.width * scale), int(cam.height * scale))

    print("Running. q / Esc / Ctrl-C to quit.", file=sys.stderr)

    try:
        while True:
            grabbed = zed.grab(runtime)
            if grabbed != sl.ERROR_CODE.SUCCESS:
                if args.replay and grabbed == sl.ERROR_CODE.END_OF_SVOFILE_REACHED:
                    break
                continue

            zed.retrieve_image(img_mat, sl.VIEW.LEFT)
            bgra = img_mat.get_data()
            if cam.depth_mode == "NONE":
                # no map at all: everything downstream already copes with a map that is blank on
                # the hand (it is, inside the ZED's minimum distance), so hand it one that is
                if no_map is None or no_map.shape[:2] != bgra.shape[:2]:
                    no_map = np.full(bgra.shape[:2] + (4,), np.nan, dtype=np.float32)
                pc = no_map
            else:
                zed.retrieve_measure(pc_mat, sl.MEASURE.XYZRGBA)
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
            if win_l is None or (win_l.width, win_l.height) != (rgb.shape[1], rgb.shape[0]):
                win_l = ViewWindow(rgb.shape[1], rgb.shape[0])       # first frame, or the camera was reopened
                win_r = ViewWindow(rgb.shape[1], rgb.shape[0])
            if not args.windows:
                win_l.reset()
                win_r.reset()
            # The right view's landmarker runs WHILE the left one does: two instances, two images,
            # nothing shared, and MediaPipe lets go of the GIL while it works. One after the other they
            # were ~25 ms of a 33 ms frame; side by side, ~13. Everything after this line sees exactly
            # what it saw before - the same two results for the same two images.
            right_job, rgb_r = None, None
            if args.right_view:
                if landmarker_r is None:
                    landmarker_r = make_landmarker()
                zed.retrieve_image(img_r_mat, sl.VIEW.RIGHT)
                rgb_r = cv2.cvtColor(img_r_mat.get_data(), cv2.COLOR_BGRA2RGB)
                right_job = right_pool.submit(
                    landmarker_r.detect_for_video,
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=win_r.crop(rgb_r)), ts_ms)
            res = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=win_l.crop(rgb)), ts_ms)

            h, w = rgb.shape[:2]
            frame = None if args.no_display else bgra[:, :, :3].copy()
            stream_due = args.stream_hz > 0 and t >= next_stream

            def first(result, win):
                """The view's one detection as (pixels, world, label, score).
                Pixels are in the FULL image, whatever window the view was given."""
                if not result.hand_landmarks:
                    return None
                handed = result.handedness[0][0]
                lab = handed.category_name
                if args.flip_handedness:
                    lab = "Left" if lab == "Right" else "Right"
                return (win.to_full([[l.x, l.y] for l in result.hand_landmarks[0]]),
                        np.array([[l.x, l.y, l.z] for l in result.hand_world_landmarks[0]]),
                        lab, float(handed.score))

            # Both views, every frame. The right image is not a fallback for
            # when the left misses -- its landmarks are a second, fully
            # independent measurement of every joint, and triangulating against
            # the left ones does not touch the dense matcher at all. That costs
            # a second landmarker pass on every frame, which accuracy is worth.
            left, right = first(res, win_l), None
            if right_job is not None:
                right = first(right_job.result(), win_r)
                recovered["right_passes"] += 1

            # Next frame's windows. A view that has the hand follows it; one that has lost it is pointed
            # at where the OTHER view says the hand is: the same rows, shifted by the disparity its
            # distance implies -- the distance it was last placed at, give or take, or anywhere in the
            # slot if that is not known. The left view sees the hand further RIGHT than the right one.
            if args.windows:
                if last_palm_d is not None and t - last_palm_d[1] < 1.0:
                    near, far = 0.7 * last_palm_d[0], 1.4 * last_palm_d[0]
                else:
                    near, far = 0.15, 0.80
                d_near = disparity_shift(cam.intr[0], cam.baseline, near)
                d_far = disparity_shift(cam.intr[0], cam.baseline, far)
                if left is not None:
                    win_l.saw(left[0])
                else:
                    win_l.missed(None if right is None else right[0], (d_far, d_near))
                if args.right_view:
                    if right is not None:
                        win_r.saw(right[0])
                    else:
                        win_r.missed(None if left is None else left[0], (-d_near, -d_far))
            recovered["frames"] += 1

            # verified on this camera: the right point cloud is expressed in the
            # right camera's frame, and shifting by the baseline along +X lands
            # within 4 mm of the left frame's own answer for the same point
            right_offset = np.array([cam.baseline, 0.0, 0.0])

            def rough_xy(det, in_right):
                """Roughly where a detection is, in metres across the left
                camera's view. Identity is decided on this, before depth is."""
                r = rays_from_pixels(det[0], cam.intr)
                d = size_depth(r, det[1])
                xy = r[list(PALM), :2].mean(axis=0) * (d if np.isfinite(d) else 0.8)
                return xy + right_offset[:2] if in_right else xy

            # ONE hand. Which detection is it? A detection that is not the tracked
            # hand is a second hand, and is left alone until the first has gone.
            #
            # The view that placed the hand LAST frame is asked first. It used to
            # be "the left view whenever it has one", so a left view flickering in
            # and out -- one frame in nine, on a recording of the rig -- dragged the
            # hand from one lens's idea of it to the other's and back: 19 mm
            # sideways at each change, against 2 mm on any other frame.
            chosen = found = None
            order = ((left, False), (right, True))
            if track is not None and track.from_right:
                order = order[::-1]
            for det, in_right in order:
                if det is not None:
                    mine, found = hand.claim(rough_xy(det, in_right), det[2], t, det[3])
                    if mine:
                        chosen = (det, in_right)
                        break
            if found is not None:
                track = Track()

            viz_hands: list = []
            sent_joints, sent_label, sent_score, sent_pinch, sent_quality = None, "right", 0.0, None, None
            if chosen is not None:
                (raw_px, world_np, _, _), from_right = chosen
                tr = hand.tracker
                label = tr.hand                # the track's name, not this frame's
                other = left if from_right else right      # whichever view it is, the other one pairs with it
                src_pc, offset = pc, None
                if from_right:
                    if cam.depth_mode == "NONE":
                        src_pc, offset = pc, right_offset
                    else:
                        zed.retrieve_measure(pc_r_mat, sl.MEASURE.XYZRGBA_RIGHT)
                        src_pc, offset = pc_r_mat.get_data(), right_offset
                    recovered["by_right"] += 1

                # Filter the landmarks BEFORE anything derives 3D from them.
                # Pixel jitter becomes depth error through the projection, so
                # smoothing only the result means smoothing something already
                # corrupted -- and the 2D overlay was never filtered at all.
                if t - track.seen > 0.25:
                    track.reset_filters()            # reappeared: no stale history
                track.seen, track.from_right = t, from_right
                # one pixel filter per VIEW (not per role), so the views can swap roles without
                # either filter being handed pixels a disparity away from its own history
                view_filt = (track.rx_filt, track.px_filt) if from_right else (track.px_filt, track.rx_filt)
                smooth_px = view_filt[0](raw_px, t)
                pts = [(int(round(u)), int(round(v))) for u, v in smooth_px]

                # Pinch is judged on MediaPipe's metric hand rather than on
                # depth-sampled fingertips. It is a ratio of two lengths on the
                # same hand, so it needs no absolute depth at all -- and the
                # depth map is least trustworthy exactly at the fingertips the
                # old version measured.
                gap_w = float(np.linalg.norm(world_np[THUMB_TIP] - world_np[INDEX_TIP]))
                view_gaps = [pinch_gaps(world_np)]   # (pinch, grab) per view of this hand

                # Everything from here on works in positive depth along the
                # ray, which is what the solver's unknowns are.
                rays = rays_from_pixels(smooth_px, cam.intr)
                model_rel = model_relative_depth(world_np, depth_sign.sign)

                # the second view: an independent depth for every joint that
                # never touches the dense matcher
                d_tri = np.full(len(pts), np.nan)
                sig_tri = np.full(len(pts), np.nan)
                # ...provided it is a view of the SAME hand. With two hands in
                # frame nothing makes the two landmarkers pick the same one, and
                # their labels are no judge of it: see fuse3d.same_hand.
                rows = row_tolerance(raw_px)
                paired_score = None            # the other view's score, if it saw THIS hand
                smooth_other = None
                # same_hand and triangulation are written (left view, right view)
                in_order = (lambda a, b: (b, a)) if from_right else (lambda a, b: (a, b))
                if other is not None and same_hand(
                        *in_order(raw_px, other[0]), cam.intr[0], cam.baseline,
                        scale_cal.correct(size_depth(rays, world_np))[0],
                        max_row_error=rows):
                    # the same fingers, seen from 12 cm to the side: a second
                    # opinion on the pinch that costs nothing (gestures.fuse_gaps)
                    view_gaps.append(pinch_gaps(other[1]))
                    paired_score = other[3]
                    # Every joint with a sane disparity is triangulated; how far each is BELIEVED
                    # is measured from this frame's rows (fuse3d.disparity_noise), so a joint the
                    # two views disagree on is weighed down instead of thrown out at a threshold --
                    # a threshold it used to cross back and forth, a centimetre each way.
                    smooth_other = view_filt[1](other[0], t)
                    pair = in_order(smooth_px, smooth_other)
                    d_tri = triangulate_depths(*pair, cam.intr[0], cam.baseline,
                                               max_row_error=4.0 * rows)
                    sig_tri = triangulation_sigma(d_tri, cam.intr[0], cam.baseline,
                                                  pixel_noise=disparity_noise(*pair))

                # Where the palm is: decided from the landmarks alone, then
                # refined by whatever the depth map has inside that gate. See
                # depthsample.locate_palm for why the order matters.
                prev = track.last_z
                prior_z = prev[0] if (prev is not None and t - prev[1] < 0.3) else None
                fix = locate_palm(src_pc, smooth_px, rays, world_np, model_rel,
                                  d_tri, sig_tri, scale_cal, cam.intr[0], prior_z,
                                  recent=track.recent_scale, t=t, tracker=track.palm)
                palm_z = fix.z
                if fix.anchored:
                    track.last_z = (palm_z, t)

                if args.debug_depth and t >= next_debug_depth:
                    map_d = -palm_z if fix.anchored else float("nan")
                    print(f"[{t:6.2f}] {label:<5} ref {fix.ref_d:5.3f} +-{fix.ref_sigma:5.3f}  "
                          f"tri {fix.tri_d:5.3f}  size {fix.size_d:5.3f} "
                          f"x{scale_cal.ratio:4.2f}{'' if scale_cal.ready else '?'}  "
                          f"map {map_d:5.3f}  pool {fix.pool:3d}->{fix.gated:3d} px  "
                          f"r {fix.r_palm}/{fix.r_joint}  <- {fix.source}",
                          file=sys.stderr, flush=True)

                joints = tip_mid = p_depth = None
                if palm_z is not None:
                    was_confident = depth_sign.confident
                    # both sides at the sample points: the unbiased readings
                    # cannot be carried back to the joints without the model
                    depth_sign.observe(
                        at_sample_points(world_np[:, 2]
                                         - float(np.mean(world_np[list(PALM), 2]))),
                        sample_unbiased(src_pc, smooth_px, palm_z, fix.r_joint) - palm_z)
                    if depth_sign.confident and not was_confident:
                        print(f"model depth sign resolved to {depth_sign.sign:+.0f} "
                              f"(documented convention is -1)",
                              file=sys.stderr, flush=True)
                    palm_d = -palm_z
                    # the model's hand about the palm, corrected by what triangulation last said of
                    # each joint (palmtrack.ShapeMemory): the prior is then continuous with the last
                    # paired frame instead of a second opinion the joints flip to and from
                    track.shape.observe(d_tri, sig_tri, -model_rel, t)
                    d_model, prior_sigma = track.shape.prior(palm_d, -model_rel, t)

                    z_map, spread = sample_joint_depths(
                        src_pc, smooth_px, palm_z, model_rel, radius=fix.r_joint,
                        tol=joint_tolerance(fix.anchored, fix.ref_sigma),
                        with_spread=True)
                    d_map = -z_map
                    sig_map = np.where(np.isfinite(d_map),
                                       depthmap_sigma(spread), np.nan)

                    bone_cal.observe(bone_lengths(world_np))   # lengths are frame-agnostic
                    metric_bones.observe(rays, d_tri, sig_tri)

                    d_fused, sig_fused = fuse_measurements([d_map, d_tri],
                                                           [sig_map, sig_tri])
                    d_start = np.where(np.isfinite(d_fused), d_fused, d_model)
                    d_solved = solve_depths(rays, d_start, d_fused, sig_fused,
                                            metric_bones.lengths(bone_cal.lengths()),
                                            prior_d=d_model, prior_sigma=prior_sigma)
                    d_final = track.d_filt(d_solved, t)
                    joints = points_from_depths(rays, d_final)
                    if offset is not None:
                        # built from right-view pixels, so it lands in the right
                        # camera frame until shifted
                        joints = joints + offset
                    if smooth_other is not None:
                        # Both views have the hand: a joint is put MIDWAY between where each view's
                        # ray says it is at the solved depth (depth is shared: the views are
                        # rectified). The two landmarkers disagree about a joint by a centimetre
                        # at this range, and placing by one view alone made the hand jump by that
                        # much whenever the placing view changed. The midpoint does not care which
                        # view is called "chosen", and halves each landmarker's own error.
                        twin = points_from_depths(rays_from_pixels(smooth_other, cam.intr), d_final)
                        twin = twin + (right_offset if not from_right else 0.0)
                        joints = 0.5 * (joints + twin)
                    joints = track.j_filt(joints, t)
                    p_depth = joints[list(PALM)].mean(axis=0)
                    last_palm_d = (float(-p_depth[2]), t)
                    tip_mid = (joints[THUMB_TIP] + joints[INDEX_TIP]) * 0.5

                sent_joints, sent_label, sent_score = joints, label, chosen[0][3]
                gap_m = (float(np.linalg.norm(joints[THUMB_TIP] - joints[INDEX_TIP]))
                         if joints is not None else gap_w)
                palm = to_world(p_depth)

                solved_gaps = pinch_gaps(joints) if joints is not None else (np.nan, np.nan)
                norm_gap = fuse_gaps([g[0] for g in view_gaps], solved_gaps[0])
                grab_gap = fuse_gaps([g[1] for g in view_gaps], solved_gaps[1])
                if not np.isfinite(norm_gap):        # no landmarks to judge it on:
                    norm_gap = grab_gap = 1.0        # an open hand, not a poisoned filter

                new_events = tr.update(palm, norm_gap, t,
                                       gap_m=gap_m, tip_mid=to_world(tip_mid))
                # what the rig page picks things up with: the raw fused gaps (it
                # keeps its own hold logic, tunable there) and this tracker's view
                sent_pinch = {"gap": norm_gap, "grab": grab_gap,
                              "closed": tr.pinch.state == "closed",
                              "strength": tr.pinch.strength, "views": len(view_gaps)}
                # ...and how far to believe this frame at all, for the page to gate on
                n_tri = int(np.isfinite(d_tri).sum())
                sent_quality = {"conf": tracking_confidence(chosen[0][3], paired_score, n_tri),
                                "score": chosen[0][3], "other": paired_score,
                                "views": 1 if paired_score is None else 2, "tri": n_tri}
                if found:
                    found.position = tr.position   # known only after the update
                    emit(found)
                    last_event = found
                for ev in new_events:
                    emit(ev)
                    last_event = ev

                if viz_on:
                    # the same reconstruction the gestures were judged on, so
                    # the 3D view cannot disagree with the tracking
                    t3 = track.trail3d
                    if tr.position is not None:
                        t3.append(tr.position.copy())
                    viz_hands.append({
                        "label": label, "joints": joints,
                        "palm": tr.position if tr.position is not None else p_depth,
                        "pinched": tr.pinch.state == "closed",
                        "velocity": tr.velocity, "trail": list(t3),
                    })

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

                draw_pts = pts
                if from_right and p_depth is not None:
                    # The overlay is the LEFT image, so right-view landmarks sit
                    # one disparity to the left of where the hand appears here.
                    # One shift for the whole hand is an approximation -- the
                    # fingers are not all at the palm's depth -- but it is only
                    # for display; the 3D used by the gestures is exact.
                    shift = int(round(cam.intr[0] * cam.baseline / max(-p_depth[2], 1e-3)))
                    draw_pts = [(u + shift, v) for u, v in pts]

                # a right-view hand with no depth cannot be placed in the left
                # image at all, so drawing it would put a skeleton one disparity
                # away from the hand it belongs to
                drawable = not (from_right and p_depth is None)

                trail = track.trail
                if drawable:
                    trail.append(tuple(np.mean([draw_pts[i] for i in PALM],
                                               axis=0).astype(int)))
                if frame is not None and drawable:
                    draw_hand(frame, draw_pts, tr, trail)
                    if from_right:
                        cv2.putText(frame, "right view",
                                    (draw_pts[WRIST][0] - 45, draw_pts[WRIST][1] + 80),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (120, 220, 255),
                                    1, cv2.LINE_AA)

            if stream_due:
                next_stream = t + 1.0 / args.stream_hz
            if args.debug_swipe and t >= next_debug:
                next_debug = t + 0.2
            if args.debug_depth and t >= next_debug_depth:
                next_debug_depth = t + 0.2

            for ev in hand.sweep(t):
                emit(ev)
                last_event = ev
                track = None

            if bridge is not None:
                # every frame, hand or not: an empty list is how the page
                # learns the hand has gone, and the head is wanted regardless
                bridge.frame(rgb, rgb_r, ts_ms, t, cam.intr, cam.baseline,
                             sent_joints, sent_label, sent_score, pinch=sent_pinch,
                             quality=sent_quality)
                # The landmarker's own thresholds, changed from the page (its Q panel).
                # They are fixed when a landmarker is built, so changing one means
                # building both again: a hitch of a frame or two, and a fresh start
                # for MediaPipe's tracking, which is what a new threshold wants anyway.
                wanted = bridge.server.take_config()
                if wanted:
                    det = float(np.clip(wanted.get("detect", args.detection_confidence), 0.05, 0.95))
                    trk = float(np.clip(wanted.get("track", args.tracking_confidence), 0.05, 0.95))
                    if (det, trk) != (args.detection_confidence, args.tracking_confidence):
                        args.detection_confidence, args.tracking_confidence = det, trk
                        landmarker.close()
                        landmarker = make_landmarker()
                        if landmarker_r is not None:
                            landmarker_r.close()
                            landmarker_r = None          # rebuilt on the next frame
                        print(f"landmarker thresholds now: detection {det:.2f}, "
                              f"presence/tracking {trk:.2f}", file=sys.stderr, flush=True)
                    bridge.server.describe_landmarker(args.detection_confidence,
                                                      args.tracking_confidence)

            frames += 1
            total_frames += 1
            if time.time() - fps_t >= 0.5:
                fps = frames / (time.time() - fps_t)
                frames, fps_t = 0, time.time()

            if frame is not None:
                if last_event is not None:
                    draw_banner(frame, last_event, t - last_event.t)
                hud = (f"{fps:4.1f} fps   {cam.describe()}   "
                       f"{'world' if args.world else 'camera'} frame")
                cv2.putText(frame, hud, (16, frame.shape[0] - 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200),
                            1, cv2.LINE_AA)
                cv2.putText(frame, "[r] resolution   [f] fps   [d] depth   [q] quit",
                            (16, frame.shape[0] - 16), cv2.FONT_HERSHEY_SIMPLEX,
                            0.5, (150, 150, 150), 1, cv2.LINE_AA)
                cv2.imshow(WINDOW, frame)

                if viz_on:
                    if not viz_open:
                        cv2.namedWindow(VIZ_WINDOW, cv2.WINDOW_NORMAL)
                        cv2.resizeWindow(VIZ_WINDOW, viewer.width, viewer.height)
                        cv2.setMouseCallback(VIZ_WINDOW, viewer.on_mouse)
                        viz_open = True
                    note = f"{len(viz_hands)} hand(s)   {cam.describe()}"
                    cv2.imshow(VIZ_WINDOW, viewer.render(viz_hands, note))
                elif viz_open:
                    cv2.destroyWindow(VIZ_WINDOW)
                    viz_open = False

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                if key == ord("v"):
                    viz_on = not viz_on
                    print(f"3D view {'on' if viz_on else 'off'}",
                          file=sys.stderr, flush=True)
                    continue
                # the viewer consumes its own keys and reports whether it did,
                # so camera shortcuts keep working while it is open
                if viz_on and viewer.on_key(key):
                    continue
                changes = settings_for_key(key, cam)
                if changes:
                    # a reopen blocks for ~2 s and changes the intrinsics, so
                    # everything derived from the old stream has to go: stale
                    # trajectories would otherwise surface as a phantom swipe
                    cv2.putText(frame, "reopening camera...", (16, 80),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 190, 70), 2)
                    cv2.imshow(WINDOW, frame)
                    cv2.waitKey(1)
                    err = cam.reopen(**changes)
                    if err is not None:
                        print(f"  cannot open {changes}: {err}", file=sys.stderr)
                        if "resolution" in changes:
                            CYCLABLE.discard(changes["resolution"])
                    if bridge is not None:       # another mode is another set of intrinsics
                        bridge.server.describe_camera(cam.intr, (cam.width, cam.height),
                                                      cam.baseline, cam.granted_fps)
                    if hand.tracker is not None:
                        hand.tracker.filt.reset()
                        hand.tracker.swipe.reset()
                    if track is not None:
                        track = Track()
                    last_event = None
                    print(f"now {cam.describe()}", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        elapsed = time.time() - wall_start
        if elapsed > 0 and total_frames:
            print(f"processed {total_frames} frames in {elapsed:.1f} s "
                  f"= {total_frames / elapsed:.1f} fps", file=sys.stderr)
        if args.right_view and recovered["frames"]:
            n = recovered["frames"]
            print(f"right view: ran on {recovered['right_passes']} of {n} frames; "
                  f"{recovered['by_right']} had a hand the left view missed "
                  f"({recovered['by_right'] / n:.1%})", file=sys.stderr)
        right_pool.shutdown(wait=True)
        landmarker.close()
        if bridge is not None:
            bridge.close()
        cam.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
