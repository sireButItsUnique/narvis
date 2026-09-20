"""The rig's sensor: one ZED, hands and head, streamed to the page that draws.

    python gesture_detect.py --rig-bridge          # then open rig/rigtest3/?bridge=1

Why this exists. The Pepper's-ghost page (rig/rigtest3) used to open the ZED
itself, as a webcam, to find the viewer's head. The hand tracker opens the same
ZED through the SDK. A camera has one owner, so the two could never run
together -- and the picture needs both at once: the eye to draw FROM, and the
hand to draw. So the camera gets a single owner, this process, and the page
stops opening cameras and listens instead.

What is sent is deliberately raw: points in the ZED's own frame (metres, left
lens at the origin, +Y up, -Z out of the lens), exactly as measured. Where the
camera stands in the rig, and how far it is tipped up, stay the page's
business, because that is where they are calibrated (its A and T keys). One
consequence is the point of the design: head and hand go through the SAME
camera pose, so an error in it moves them together instead of against each
other.

Wire format -- JSON text frames, the one rig/rigtest3/js/input/zed-client.js
already speaks, plus `head`:

    {"t":"hello","version":1,"source":"ZED 2","fps":60,"frame":"zed_y_up","unit":"m",
     "intr":[fx,fy,cx,cy],"size":[w,h],"baseline":0.12}      the running camera, one rectified eye
    {"t":"hands","seq":12,"ts":<s>,"hands":[{"handedness":"right","score":0.9,"lm":[[x,y,z] x21]}]}
    {"t":"head","seq":12,"ts":<s>,"eye":[x,y,z]|null,"ipd":0.063,"src":"stereo"|"<why not>"}
    {"t":"pong","c0":<client ms>,"s":<bridge ms>}          in reply to {"t":"ping","c0":...}

`ts` is the capture time on this machine's clock. An empty `hands` list is sent
on purpose: it is how the page knows to stop drawing a hand that has gone.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from typing import Optional

import numpy as np

from handmodel import MultiOneEuro
from headtrack import HeadFix, head_from_views

__all__ = ["BridgeServer", "FaceTracker", "RigBridge", "FACE_MODEL_URL"]

WIRE_VERSION = 1
FACE_MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
                  "face_landmarker/float16/1/face_landmarker.task")


class BridgeServer:
    """A WebSocket broadcaster on its own thread.

    The capture loop must never wait on a browser, so `publish` only hands the
    message to the server's event loop and returns. Each client has a short
    queue that drops its OLDEST entry when full: a page that falls behind gets
    the newest hand, not a growing backlog of where the hand used to be.
    """

    def __init__(self, port: int = 8902, host: str = "127.0.0.1",
                 source: str = "ZED 2", fps: float = 0.0):
        self.port, self.host = port, host
        self._hello = {"t": "hello", "version": WIRE_VERSION, "source": source,
                       "fps": fps, "frame": "zed_y_up", "unit": "m"}
        self.hello = json.dumps(self._hello)
        self.clients: set = set()
        self.error: Optional[str] = None
        self._config: dict = {}                  # what a page has asked for; see take_config
        self._config_lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="rig-bridge", daemon=True)

    def start(self, timeout: float = 5.0) -> bool:
        self._thread.start()
        self._ready.wait(timeout)
        return self.error is None and self._loop is not None

    def _run(self) -> None:
        try:
            asyncio.run(self._serve())
        except Exception as e:                               # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            self._ready.set()

    async def _serve(self) -> None:
        from websockets.asyncio.server import serve
        self._loop = asyncio.get_running_loop()
        self._stop = asyncio.Event()
        try:
            server = await serve(self._client, self.host, self.port)
        except OSError as e:
            self.error = f"cannot listen on {self.host}:{self.port} ({e})"
            self._ready.set()
            return
        self._ready.set()
        async with server:
            await self._stop.wait()

    async def _client(self, conn) -> None:
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        self.clients.add(queue)

        async def writer():
            await conn.send(self.hello)
            while True:
                await conn.send(await queue.get())

        task = asyncio.ensure_future(writer())
        try:
            async for raw in conn:
                try:
                    m = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(m, dict) and m.get("t") == "ping":
                    self._offer(queue, json.dumps({"t": "pong", "c0": m.get("c0"),
                                                   "s": time.time() * 1000.0}))
                elif isinstance(m, dict) and m.get("t") == "config":
                    # the one thing a page may ask of the tracker: the landmarker's
                    # own confidence thresholds. Numbers only, clamped by the taker.
                    asked = {k: float(m[k]) for k in ("detect", "track")
                             if isinstance(m.get(k), (int, float)) and np.isfinite(m[k])}
                    with self._config_lock:
                        self._config.update(asked)
        except Exception:                                    # noqa: BLE001 - a client going away
            pass
        finally:
            task.cancel()
            self.clients.discard(queue)

    def describe_camera(self, intr, size, baseline: float, fps: float = 0.0) -> None:
        """What the page's checks should believe about the camera: the SDK's own numbers for the mode
        that is running. Sent in `hello`, so call it again after the camera is reopened in another mode."""
        self._hello.update(intr=[float(v) for v in intr], size=[int(size[0]), int(size[1])],
                           baseline=float(baseline), fps=float(fps) or self._hello["fps"])
        self.hello = json.dumps(self._hello)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._broadcast, self.hello)

    def describe_landmarker(self, detect: float, track: float) -> None:
        """The hand landmarker's thresholds as they are RUNNING, in `hello`: the page shows these, not
        what it last asked for, so a request that was clamped or never arrived cannot look applied."""
        self._hello.update(landmarker={"detect": round(float(detect), 3), "track": round(float(track), 3)})
        self.hello = json.dumps(self._hello)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._broadcast, self.hello)

    def take_config(self) -> dict:
        """Whatever pages have asked for since the last call (latest wins), and forget it. Called from
        the capture thread once a frame; empty almost always."""
        with self._config_lock:
            asked, self._config = self._config, {}
        return asked

    @staticmethod
    def _offer(queue: asyncio.Queue, text: str) -> None:
        if queue.full():
            try:
                queue.get_nowait()                           # newest wins
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(text)

    def _broadcast(self, text: str) -> None:
        for queue in list(self.clients):
            self._offer(queue, text)

    def publish(self, message: dict) -> None:
        if self._loop is None or not self.clients:
            return
        self._loop.call_soon_threadsafe(self._broadcast, json.dumps(message))

    def stop(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)


class FaceTracker:
    """MediaPipe FaceLandmarker on each view; landmarks come back in pixels."""

    def __init__(self, model_path: str):
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        self._mp = mp

        def make():
            return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=model_path),
                running_mode=vision.RunningMode.VIDEO, num_faces=1,
                min_face_detection_confidence=0.5, min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5))

        self._views = (make(), make())

    def detect(self, rgb_left, rgb_right, ts_ms: int):
        out = []
        for landmarker, rgb in zip(self._views, (rgb_left, rgb_right)):
            h, w = rgb.shape[:2]
            res = landmarker.detect_for_video(
                self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb), ts_ms)
            out.append(np.array([[p.x * w, p.y * h] for p in res.face_landmarks[0]])
                       if res.face_landmarks else None)
        return out

    def close(self) -> None:
        for v in self._views:
            v.close()


class RigBridge:
    """What gesture_detect.py talks to: give it each frame, it does the rest."""

    def __init__(self, port: int, face_model: str, fps: float = 0.0,
                 face_tracker=None, server: Optional[BridgeServer] = None):
        self.server = server or BridgeServer(port, fps=fps)
        self.faces = face_tracker
        self.notes: list = []
        if self.faces is None:
            if os.path.exists(face_model):
                self.faces = FaceTracker(face_model)
            else:
                self.notes.append(
                    f"no head tracking: {face_model} not found. The page will hold a fixed eye.\n"
                    f"    curl.exe -L -o {face_model} {FACE_MODEL_URL}")
        # Light when still, quick when moving: the projection is drawn FROM this
        # point, so lag shows as the picture trailing the head and jitter as the
        # whole picture shivering. 3 mm of depth noise at rest must not get
        # through; a 30 cm/s lean must, within a frame or two.
        self._eye_filter = MultiOneEuro((1, 3), min_cutoff=2.0, beta=20.0)
        self._seq = 0
        self.last_head = HeadFix(False, "not run yet")

    def start(self) -> bool:
        ok = self.server.start()
        if not ok:
            self.notes.append(f"rig bridge did not start: {self.server.error}")
        return ok

    def head(self, rgb_left, rgb_right, ts_ms: int, t: float, intr, baseline) -> HeadFix:
        if self.faces is None:
            return HeadFix(False, "no face model")
        if rgb_right is None:
            return HeadFix(False, "no right view (--no-right-view): a head needs both eyes")
        left, right = self.faces.detect(rgb_left, rgb_right, ts_ms)
        fix = head_from_views(left, right, intr, baseline, rgb_left.shape[0])
        if fix.ok:
            fix.eye = self._eye_filter(fix.eye[None, :], t)[0]
        return fix

    def frame(self, rgb_left, rgb_right, ts_ms: int, t: float, intr, baseline,
              joints=None, handedness: str = "right", score: float = 1.0,
              pinch: Optional[dict] = None, quality: Optional[dict] = None) -> None:
        """One captured frame: find the head, publish it and the hand."""
        now = time.time()
        self._seq += 1
        hands = []
        if joints is not None and np.isfinite(joints).all():
            hands.append({"handedness": handedness.lower(), "score": round(float(score), 3),
                          "lm": np.round(np.asarray(joints, dtype=np.float64), 5).tolist()})
            if pinch is not None:
                hands[-1]["pinch"] = wire_pinch(pinch)
            if quality is not None:
                hands[-1]["q"] = wire_quality(quality)
        # The hand goes out BEFORE the face is looked for. Finding the head costs two more neural passes
        # (5-15 ms), the hand needs none of it, and the hand is what the eye is comparing with a real one.
        self.server.publish({"t": "hands", "seq": self._seq, "ts": now, "hands": hands})
        self.last_head = fix = self.head(rgb_left, rgb_right, ts_ms, t, intr, baseline)
        self.server.publish({"t": "head", "seq": self._seq, "ts": now,
                             "eye": np.round(fix.eye, 5).tolist() if fix.ok else None,
                             "ipd": round(fix.ipd, 4) if np.isfinite(fix.ipd) else None,
                             "src": fix.why})

    def close(self) -> None:
        if self.faces is not None:
            self.faces.close()
        self.server.stop()


def wire_pinch(pinch: dict) -> dict:
    """The pinch as it goes on the wire: numbers or null, never NaN (which is
    not JSON, and one NaN would cost the page the whole message)."""
    num = lambda v: round(float(v), 4) if v is not None and np.isfinite(v) else None  # noqa: E731
    return {"gap": num(pinch.get("gap")), "grab": num(pinch.get("grab")),
            "closed": bool(pinch.get("closed")), "strength": num(pinch.get("strength")),
            "views": int(pinch.get("views") or 0)}


def wire_quality(q: dict) -> dict:
    """How far to believe this frame's hand (gestures.tracking_confidence), with what went into it."""
    num = lambda v: round(float(v), 3) if v is not None and np.isfinite(v) else None  # noqa: E731
    return {"conf": num(q.get("conf")), "score": num(q.get("score")), "other": num(q.get("other")),
            "views": int(q.get("views") or 1), "tri": int(q.get("tri") or 0)}


def report(notes, file=sys.stderr) -> None:
    for n in notes:
        print(f"  note: {n}", file=file, flush=True)
