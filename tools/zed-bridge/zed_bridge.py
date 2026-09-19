#!/usr/bin/env python3
"""Holomodel ZED bridge: stream 3D hand landmarks to the app over a LAN WebSocket.

Runs on the machine that has the ZED and an NVIDIA GPU; the app runs anywhere else on the same network.
The app itself is GPL-3.0; this helper talks to the proprietary ZED SDK in its OWN process and shares
nothing but a socket, so no GPL code ever links against the SDK.

    py zed_bridge.py --fake                 # no camera, no CUDA: synthetic hands, for building and testing
    py zed_bridge.py                        # real ZED, MediaPipe landmarks lifted to 3D with ZED depth
    py zed_bridge.py --mode body            # real ZED, SDK body tracking (only 4 points per hand: no pinch)
    py zed_bridge.py --replay recording.jsonl

The WebSocket server is stdlib only (no pip install) so --fake works on a bare Python. See README.md.
"""

import argparse
import base64
import hashlib
import json
import math
import re
import socket
import struct
import sys
import threading
import time

WIRE_VERSION = 1
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_PORT = 8810


# --------------------------------------------------------------------------------------------------
# A very small RFC 6455 server. We only ever send short text frames and only ever read control frames
# plus the app's ping, so this stays well inside what is reasonable to hand-roll, and it keeps the
# friend's laptop free of pip installs for the fake mode.
# --------------------------------------------------------------------------------------------------

class WsClient:
    def __init__(self, conn, addr):
        self.conn = conn
        self.addr = addr
        self.lock = threading.Lock()
        self.alive = True
        self.sent = 0
        self.dropped = 0

    def send_text(self, text):
        data = text.encode("utf-8")
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(n)
        elif n < (1 << 16):
            header.append(126)
            header += struct.pack(">H", n)
        else:
            header.append(127)
            header += struct.pack(">Q", n)
        with self.lock:
            if not self.alive:
                return False
            try:
                self.conn.sendall(bytes(header) + data)
                self.sent += 1
                return True
            except OSError:
                self.alive = False
                return False

    def close(self):
        self.alive = False
        try:
            self.conn.close()
        except OSError:
            pass


def _recv_exactly(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf += chunk
    return buf


def _handshake(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        data += chunk
        if len(data) > 64 * 1024:
            return None
    head = data.decode("latin-1")
    m = re.search(r"Sec-WebSocket-Key:\s*(\S+)", head, re.I)
    if not m:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        return None
    accept = base64.b64encode(hashlib.sha1((m.group(1) + GUID).encode()).digest()).decode()
    conn.sendall((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    ).encode())
    return True


def _read_frame(conn):
    """Returns (opcode, payload) or None on close. Handles the client's mask and fragmentation."""
    b0, b1 = _recv_exactly(conn, 2)
    fin = b0 & 0x80
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exactly(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exactly(conn, 8))[0]
    if length > 1 << 20:
        raise ConnectionError("frame too large")
    mask = _recv_exactly(conn, 4) if masked else b""
    payload = _recv_exactly(conn, length) if length else b""
    if masked:
        payload = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
    if not fin:  # continuation: keep reading until FIN
        op2, rest = _read_frame(conn)
        payload += rest
    return opcode, payload


class WsServer:
    def __init__(self, host, port, on_message=None, log=print):
        self.host, self.port = host, port
        self.clients = []
        self.lock = threading.Lock()
        self.on_message = on_message
        self.log = log
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(8)
        self.running = True
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while self.running:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                return
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            threading.Thread(target=self._client, args=(conn, addr), daemon=True).start()

    def _client(self, conn, addr):
        try:
            if not _handshake(conn):
                conn.close()
                return
        except OSError:
            conn.close()
            return
        client = WsClient(conn, addr)
        with self.lock:
            self.clients.append(client)
        self.log(f"[bridge] client connected: {addr[0]}:{addr[1]} ({len(self.clients)} now)")
        try:
            while client.alive:
                opcode, payload = _read_frame(conn)
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    with client.lock:
                        conn.sendall(bytes([0x8A, len(payload)]) + payload)
                    continue
                if opcode == 0x1 and self.on_message:
                    self.on_message(client, payload.decode("utf-8", "replace"))
        except (OSError, ConnectionError, struct.error):
            pass
        finally:
            client.close()
            with self.lock:
                if client in self.clients:
                    self.clients.remove(client)
            self.log(f"[bridge] client gone: {addr[0]}:{addr[1]} ({len(self.clients)} left)")

    def broadcast(self, text):
        with self.lock:
            targets = list(self.clients)
        for c in targets:
            c.send_text(text)
        return len(targets)

    def stop(self):
        self.running = False
        with self.lock:
            for c in self.clients:
                c.close()
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------------------------------
# Sources of hands. Each yields a list of {"handedness", "score", "lm": [[x, y, z] * 21]} in metres,
# right-handed, Y up, camera looking down -Z (ZED's RIGHT_HANDED_Y_UP), which is what the app expects.
# --------------------------------------------------------------------------------------------------

# MediaPipe's 21-landmark order, as a rest-pose template in metres relative to the wrist.
TEMPLATE = [
    (0.000, 0.000, 0.000), (0.022, 0.020, 0.010), (0.040, 0.042, 0.016), (0.052, 0.062, 0.020), (0.060, 0.080, 0.022),
    (0.022, 0.085, 0.000), (0.026, 0.115, -0.002), (0.028, 0.135, -0.004), (0.030, 0.150, -0.006),
    (0.004, 0.090, 0.000), (0.005, 0.122, -0.002), (0.006, 0.143, -0.004), (0.007, 0.160, -0.006),
    (-0.014, 0.088, 0.000), (-0.017, 0.118, -0.002), (-0.019, 0.137, -0.004), (-0.021, 0.152, -0.006),
    (-0.032, 0.080, 0.000), (-0.040, 0.104, -0.002), (-0.045, 0.119, -0.004), (-0.049, 0.132, -0.006),
]


class FakeSource:
    """Synthetic hands so the whole chain can be built and tested with no camera and no CUDA.

    One hand reaches back and forth through the volume and pinches once every 3 s; the second hand
    (with --hands 2) mirrors it more slowly, so slot assignment and two-handed code get exercised too.
    """

    name = "fake"

    def __init__(self, hands=1, fps=60):
        self.hands = hands
        self.fps = fps
        self.t0 = time.time()

    def read(self):
        t = time.time() - self.t0
        out = []
        for i in range(self.hands):
            phase = t * (1.0 if i == 0 else 0.6) + i * 1.7
            cx = 0.10 * math.sin(phase * 2 * math.pi / 6) + (0.12 if i else -0.02)
            cy = -0.04 + 0.05 * math.sin(phase * 2 * math.pi / 4)
            cz = -0.45 + 0.08 * math.sin(phase * 2 * math.pi / 5)
            # pinch: thumb tip travels from 60 mm to 8 mm from the index tip and back, once every 3 s
            open_amt = 0.5 + 0.5 * math.cos(phase * 2 * math.pi / 3)
            lm = []
            for k, (x, y, z) in enumerate(TEMPLATE):
                px, py, pz = x, y, z
                if k in (1, 2, 3, 4):  # thumb chain closes toward the index tip
                    grab = (1 - open_amt) * (k / 4.0)
                    tipx, tipy, tipz = TEMPLATE[8]
                    px += (tipx - x) * grab * 0.95
                    py += (tipy - y) * grab * 0.95
                    pz += (tipz - z) * grab * 0.95
                sx = -px if i else px  # the second hand is the other way round
                lm.append([cx + sx, cy + py, cz + pz])
            out.append({"handedness": "left" if i else "right", "score": 0.95, "lm": lm})
        return out

    def close(self):
        pass


class ReplaySource:
    """Replays a .jsonl recording (one {"hands": [...]} per line), looping, at the requested rate."""

    name = "replay"

    def __init__(self, path, fps=60):
        self.frames = []
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                hands = msg.get("hands")
                if isinstance(hands, list):
                    self.frames.append(hands)
        if not self.frames:
            raise SystemExit(f"no frames in {path}")
        self.i = 0

    def read(self):
        hands = self.frames[self.i % len(self.frames)]
        self.i += 1
        return hands

    def close(self):
        pass


class ZedSource:
    """Real ZED. MediaPipe finds the 21 landmarks in the left image; the ZED point cloud gives each one a
    metric position (5x5 median, because a single pixel on a fingertip edge is often a depth hole).
    This is the combination the published work uses; the SDK's own body tracking is the --mode body path
    and gives only four points per hand, which cannot express a pinch."""

    name = "zed"

    def __init__(self, resolution="HD720", fps=60, conf=50):
        import pyzed.sl as sl  # noqa: E402  (only when a camera is actually wanted)
        import mediapipe as mp
        import numpy as np
        self.sl, self.np = sl, np
        self.zed = sl.Camera()
        init = sl.InitParameters()
        init.camera_resolution = getattr(sl.RESOLUTION, resolution, sl.RESOLUTION.HD720)
        init.camera_fps = fps
        init.coordinate_units = sl.UNIT.METER                      # default is mm; the app wants metres
        init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP   # = three.js/OpenGL convention
        init.depth_mode = sl.DEPTH_MODE.NEURAL if hasattr(sl.DEPTH_MODE, "NEURAL") else sl.DEPTH_MODE.ULTRA
        status = self.zed.open(init)
        if status != sl.ERROR_CODE.SUCCESS:
            raise SystemExit(f"ZED open failed: {status}")
        self.runtime = sl.RuntimeParameters()
        self.image = sl.Mat()
        self.cloud = sl.Mat()
        self.hands = mp.solutions.hands.Hands(static_image_mode=False, max_num_hands=2,
                                              min_detection_confidence=conf / 100.0,
                                              min_tracking_confidence=conf / 100.0)

    def _xyz(self, cloud, u, v, w, h):
        """Median of a 5x5 window, skipping the NaNs that fingertips sit on."""
        np = self.np
        x0, x1 = max(0, u - 2), min(w, u + 3)
        y0, y1 = max(0, v - 2), min(h, v + 3)
        patch = cloud[y0:y1, x0:x1, :3].reshape(-1, 3)
        good = patch[np.isfinite(patch).all(axis=1)]
        if len(good) == 0:
            return None
        return [float(c) for c in np.median(good, axis=0)]

    def read(self):
        sl, np = self.sl, self.np
        if self.zed.grab(self.runtime) != sl.ERROR_CODE.SUCCESS:
            return []
        self.zed.retrieve_image(self.image, sl.VIEW.LEFT)
        self.zed.retrieve_measure(self.cloud, sl.MEASURE.XYZ)
        bgra = self.image.get_data()
        cloud = self.cloud.get_data()          # one numpy view per frame: get_value in a loop leaks
        rgb = np.ascontiguousarray(bgra[:, :, :3][:, :, ::-1])
        h, w = rgb.shape[:2]
        res = self.hands.process(rgb)
        out = []
        for idx, hand in enumerate(res.multi_hand_landmarks or []):
            label = "right"
            if res.multi_handedness and idx < len(res.multi_handedness):
                label = res.multi_handedness[idx].classification[0].label.lower()
            lm, missing = [], 0
            for p in hand.landmark:
                u = min(w - 1, max(0, int(p.x * w)))
                v = min(h - 1, max(0, int(p.y * h)))
                xyz = self._xyz(cloud, u, v, w, h)
                if xyz is None:
                    missing += 1
                    xyz = [0.0, 0.0, 0.0]
                lm.append(xyz)
            if missing > 6:          # too many depth holes to trust this hand
                continue
            out.append({"handedness": label, "score": 1.0 - missing / 21.0, "lm": lm})
        return out

    def close(self):
        try:
            self.hands.close()
        finally:
            self.zed.close()


class ZedBodySource:
    """SDK body tracking. BODY_38 carries four keypoints per hand (thumb 4, index 1, middle 4, pinky 1),
    so a pinch cannot be measured from it: it is here as a fallback when MediaPipe will not install."""

    name = "zed-body"
    # BODY_38 indices -> the MediaPipe slot we put them in, so the app sees one shape of message
    LEFT = {30: 4, 31: 8, 32: 12, 33: 20}
    RIGHT = {34: 4, 35: 8, 36: 12, 37: 20}

    def __init__(self, resolution="HD720", fps=60, conf=40):
        import pyzed.sl as sl
        self.sl = sl
        self.zed = sl.Camera()
        init = sl.InitParameters()
        init.camera_resolution = getattr(sl.RESOLUTION, resolution, sl.RESOLUTION.HD720)
        init.camera_fps = fps
        init.coordinate_units = sl.UNIT.METER
        init.coordinate_system = sl.COORDINATE_SYSTEM.RIGHT_HANDED_Y_UP
        if self.zed.open(init) != sl.ERROR_CODE.SUCCESS:
            raise SystemExit("ZED open failed")
        self.zed.enable_positional_tracking(sl.PositionalTrackingParameters())
        params = sl.BodyTrackingParameters()
        params.enable_tracking = True
        params.enable_body_fitting = True
        params.body_format = sl.BODY_FORMAT.BODY_38
        params.detection_model = sl.BODY_TRACKING_MODEL.HUMAN_BODY_ACCURATE
        if self.zed.enable_body_tracking(params) != sl.ERROR_CODE.SUCCESS:
            raise SystemExit("body tracking failed to start (needs an IMU camera: ZED 2/2i/Mini/X)")
        self.rt = sl.BodyTrackingRuntimeParameters()
        self.rt.detection_confidence_threshold = conf
        self.bodies = sl.Bodies()
        print("[bridge] WARNING: body mode gives 4 points per hand; pinch will not work", file=sys.stderr)

    def read(self):
        sl = self.sl
        if self.zed.grab() != sl.ERROR_CODE.SUCCESS:
            return []
        self.zed.retrieve_bodies(self.bodies, self.rt)
        out = []
        for body in self.bodies.body_list:
            kp = body.keypoint
            for label, table in (("left", self.LEFT), ("right", self.RIGHT)):
                lm = [[0.0, 0.0, 0.0] for _ in range(21)]
                seen = 0
                for src, dst in table.items():
                    if src < len(kp) and all(math.isfinite(float(c)) for c in kp[src]):
                        lm[dst] = [float(c) for c in kp[src]]
                        seen += 1
                if seen < 2:
                    continue
                lm[0] = lm[12]                      # wrist slot: the middle knuckle is the closest thing
                out.append({"handedness": label, "score": 0.5, "lm": lm})
        return out

    def close(self):
        self.zed.close()


# --------------------------------------------------------------------------------------------------


def lan_ips():
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except socket.gaierror:
        pass
    try:  # the address actually used to reach the outside world, which is the one the app should use
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in ips:
            ips.insert(0, ip)
    except OSError:
        pass
    return ips


def make_source(args):
    if args.replay:
        return ReplaySource(args.replay, args.fps)
    if args.fake:
        return FakeSource(hands=args.hands, fps=args.fps)
    if args.mode == "body":
        return ZedBodySource(args.resolution, args.fps, args.confidence)
    return ZedSource(args.resolution, args.fps, args.confidence)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Stream ZED hand landmarks to Holomodel over a WebSocket")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 to let the app's machine reach it")
    ap.add_argument("--fake", action="store_true", help="synthetic hands: no camera, no CUDA, no installs")
    ap.add_argument("--replay", help="replay a .jsonl recording instead of a camera")
    ap.add_argument("--hands", type=int, default=2, help="how many fake hands")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--mode", choices=["mediapipe", "body"], default="mediapipe")
    ap.add_argument("--resolution", default="HD720", help="HD2K, HD1080, HD720 or VGA")
    ap.add_argument("--confidence", type=int, default=50)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (tests)")
    args = ap.parse_args(argv)

    log = (lambda *a, **k: None) if args.quiet else print
    source = make_source(args)

    def on_message(client, text):
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            return
        if msg.get("t") == "ping":  # 4-timestamp clock sync; our clock is time.time() in ms
            client.send_text(json.dumps({"t": "pong", "c0": msg.get("c0"), "s": time.time() * 1000.0}))

    server = WsServer(args.host, args.port, on_message=on_message, log=log)
    hello = json.dumps({"t": "hello", "version": WIRE_VERSION, "source": source.name,
                        "fps": args.fps, "frame": "zed_y_up", "unit": "m"})
    log(f"[bridge] {source.name} source, ws://{args.host}:{args.port}")
    for ip in lan_ips():
        log(f"[bridge] the app should connect to  ws://{ip}:{args.port}")
    sys.stdout.flush()

    seq = 0
    seen = set()
    period = 1.0 / max(1, args.fps)
    t_end = time.time() + args.seconds if args.seconds else None
    next_t = time.time()
    try:
        while True:
            if t_end and time.time() > t_end:
                break
            with server.lock:
                clients = list(server.clients)
            for c in clients:  # greet each new client so it knows what it is talking to
                if id(c) not in seen:
                    seen.add(id(c))
                    c.send_text(hello)
            hands = source.read() if clients else []
            if clients:
                seq += 1
                server.broadcast(json.dumps({"t": "hands", "seq": seq, "ts": time.time(), "hands": hands}))
            next_t += period
            sleep = next_t - time.time()
            if sleep > 0:
                time.sleep(sleep)
            else:
                next_t = time.time()  # fell behind: skip ahead rather than send a burst of stale frames
    except KeyboardInterrupt:
        pass
    finally:
        source.close()
        server.stop()
        log("[bridge] stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
