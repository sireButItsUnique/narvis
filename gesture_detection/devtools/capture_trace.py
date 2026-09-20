"""Replay a recording through the REAL gesture_detect.main() and keep everything it did, per frame:
the landmarkers' raw answers for both views, every same_hand verdict, every palm fix, the solver's exact inputs
and output, and what was sent to the rig. Nothing in the pipeline is changed; its functions are wrapped.

    python capture_trace.py REC.svo2 OUT.pkl
"""
import os
import pickle
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC_OUT = [os.path.abspath(a) for a in sys.argv[1:3]]     # resolved BEFORE the chdir below
sys.path.insert(0, ROOT)
os.chdir(ROOT)

import gesture_detect as g          # noqa: E402
import rig_bridge                   # noqa: E402

REC, OUT = REC_OUT
frames = []                         # one dict per processed frame
cur = {}


def wrap_landmarkers():
    real_create = g.vision.HandLandmarker.create_from_options
    made = [0]

    class Tap:
        def __init__(self, inner, side):
            self.inner, self.side = inner, side

        def detect_for_video(self, image, ts_ms):
            res = self.inner.detect_for_video(image, ts_ms)
            det = None
            if res.hand_landmarks:
                h = res.handedness[0][0]
                det = {"lm": np.array([[l.x, l.y, l.z] for l in res.hand_landmarks[0]], dtype=np.float32),
                       "world": np.array([[l.x, l.y, l.z] for l in res.hand_world_landmarks[0]], dtype=np.float32),
                       "label": h.category_name, "score": float(h.score)}
            cur.setdefault("raw", {})[self.side] = det
            cur["ts_ms"] = ts_ms
            return res

        def close(self):
            self.inner.close()

    def create(opts):
        side = "left" if made[0] % 2 == 0 else "right"
        made[0] += 1
        return Tap(real_create(opts), side)

    g.vision.HandLandmarker.create_from_options = create


def wrap(name, record):
    real = getattr(g, name)

    def tapped(*a, **kw):
        out = real(*a, **kw)
        record(a, kw, out)
        return out
    setattr(g, name, tapped)


wrap("same_hand", lambda a, kw, out: cur.__setitem__("same_hand", bool(out)))
wrap("locate_palm", lambda a, kw, out: cur.__setitem__("fix", {
    "z": out.z, "source": out.source, "ref_d": out.ref_d, "ref_sigma": out.ref_sigma,
    "tri_d": out.tri_d, "size_d": out.size_d}))
wrap("triangulate_depths", lambda a, kw, out: cur.__setitem__("d_tri", np.array(out, dtype=np.float32)))
wrap("solve_depths", lambda a, kw, out: cur.__setitem__("solve", {
    "rays": np.array(a[0], dtype=np.float32), "start": np.array(a[1], dtype=np.float32),
    "data": np.array(a[2], dtype=np.float32), "sigma": np.array(a[3], dtype=np.float32),
    "bones": None if a[4] is None else np.array(a[4], dtype=np.float32),
    "prior": None if kw.get("prior_d") is None else np.array(kw["prior_d"], dtype=np.float32),
    "out": np.array(out, dtype=np.float32)}))


class Recorder:
    """Stands where RigBridge stands: takes what would have gone to the page."""

    class _Server:
        def describe_camera(self, intr, size, baseline, fps=0.0):
            meta.update(intr=[float(v) for v in intr], size=[int(size[0]), int(size[1])], baseline=float(baseline), fps=float(fps))

        def describe_landmarker(self, *a, **kw):
            pass

        def take_config(self):
            return {}

    def __init__(self, *a, **kw):
        self.server, self.notes, self.last = Recorder._Server(), [], time.perf_counter()

    def start(self):
        return True

    def close(self):
        pass

    def frame(self, rgb, rgb_r, ts_ms, t, intr, baseline, joints=None, handedness="right", score=1.0, pinch=None, quality=None):
        global cur
        now = time.perf_counter()
        cur.update(t=float(t), sent=None if joints is None else np.array(joints, dtype=np.float32), label=handedness,
                   pinch=pinch, quality=quality, wall_ms=(now - self.last) * 1000.0,
                   lum=float(rgb[::8, ::8].mean()))
        self.last = now
        frames.append(cur)
        cur = {}
        if len(frames) % 300 == 0:
            print(f"  ... {len(frames)} frames, t = {t:.1f} s", file=sys.stderr, flush=True)


BLANK = "--blank-map" in sys.argv
if BLANK:
    sys.argv.remove("--blank-map")
    _nan = {}
    for _name in ("locate_palm", "sample_joint_depths", "sample_unbiased"):
        def _mk(real):
            def f(pc, *a, **kw):
                key = pc.shape
                if key not in _nan:
                    _nan[key] = np.full(pc.shape, np.nan, dtype=np.float32)
                return real(_nan[key], *a, **kw)
            return f
        setattr(g, _name, _mk(getattr(g, _name)))

meta = {"recording": REC}
wrap_landmarkers()

# full-image pixels per view, whatever window the view was given: tap ViewWindow.to_full
_made = [0]
_real_init, _real_full = g.ViewWindow.__init__, g.ViewWindow.to_full


def _init(self, *a, **kw):
    _real_init(self, *a, **kw)
    self._side = "left" if _made[0] % 2 == 0 else "right"
    _made[0] += 1


def _full(self, xy):
    out = _real_full(self, xy)
    cur.setdefault("px", {})[self._side] = np.array(out, dtype=np.float32)
    cur.setdefault("win", {})[self._side] = self.rect
    return out


g.ViewWindow.__init__, g.ViewWindow.to_full = _init, _full
rig_bridge.RigBridge = Recorder
sys.argv = ["gesture_detect.py", "--no-display", "--rig-bridge", "8999", "--replay", REC] + sys.argv[3:]
t0 = time.time()
code = g.main()
meta["seconds_to_process"] = time.time() - t0
pickle.dump({"meta": meta, "frames": frames}, open(OUT, "wb"))
print(f"{len(frames)} frames -> {OUT}  ({meta['seconds_to_process']:.0f} s)  exit {code}")
