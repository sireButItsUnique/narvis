"""Optional MediaPipe Tasks worker. Camera and inference never block the HTTP service."""
import json
from pathlib import Path
import threading
import time
import uuid
from urllib.request import Request, urlopen


def post(url, token, packet):
    request = Request(url + "/api/tracking", json.dumps(packet).encode(),
                      {"Content-Type": "application/json", "X-Synapse-Token": token})
    with urlopen(request, timeout=1) as response:
        response.read()


class LatestCamera:
    """Continuously drain the capture backend; inference consumes only the latest frame."""
    def __init__(self, cv2, index, backend):
        self.cv2 = cv2
        self.capture = cv2.VideoCapture(index, backend)
        if not self.capture.isOpened():
            self.capture.release()
            raise RuntimeError("Camera unavailable. Check Windows privacy permissions and camera index.")
        self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.latest = None
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        seq = 0
        while not self.stop.is_set():
            ok, frame = self.capture.read()
            if not ok:
                self.stop.wait(.05)
                continue
            seq += 1
            with self.lock:
                self.latest = (seq, time.monotonic_ns(), frame)

    def get(self):
        with self.lock:
            return self.latest

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)
        if not self.thread.is_alive():
            self.capture.release()
        # A wedged Windows driver must not hang service shutdown; worker is daemonized.


def run(model, camera, url, token, backend="dshow", mirror=False):
    try:
        import cv2
        import mediapipe as mp
    except ImportError as exc:
        raise RuntimeError("Install tracking dependencies: python -m pip install -e '.[tracking]'") from exc
    if not Path(model).is_file():
        raise ValueError("Missing .task model; see models/README.md")
    api = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF, "auto": cv2.CAP_ANY}[backend]
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=1, min_hand_detection_confidence=.65,
        min_hand_presence_confidence=.65, min_tracking_confidence=.65)
    stream, sent, last_frame, timestamp = uuid.uuid4().hex, 0, 0, 0
    source = LatestCamera(cv2, camera, api)
    try:
        with mp.tasks.vision.HandLandmarker.create_from_options(options) as detector:
            while True:
                latest = source.get()
                if latest is None or latest[0] == last_frame:
                    time.sleep(.005)
                    continue
                last_frame, captured, frame = latest
                if mirror:
                    frame = cv2.flip(frame, 1)
                height, width = frame.shape[:2]
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                timestamp = max(timestamp + 1, captured // 1000000)
                result = detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp)
                sent += 1
                points = [[p.x, p.y, p.z] for p in result.hand_landmarks[0]] if result.hand_landmarks else []
                # Handedness score is NOT tracking confidence. Presence has already been gated by Tasks.
                packet = dict(version=1, stream=stream, seq=sent, present=bool(points), simulated=False,
                              age_ms=(time.monotonic_ns()-captured)/1e6, aspect=width/height, landmarks=points)
                try:
                    post(url, token, packet)
                except OSError as exc:
                    print(f"Tracking delivery failed: {exc}", flush=True)
                    time.sleep(.25)
    finally:
        source.close()
