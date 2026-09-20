"""Interaction gating only. This code makes no physical safety guarantees."""
import math
import time
from synapsedesk.contracts import validate_tracking, validate_bounds


class GestureGate:
    def __init__(self):
        self.bounds = dict(xmin=0., xmax=1., ymin=0., ymax=1.)
        self.stream = None
        self.seq = 0
        self.received = 0.
        self.frame_age = 0.
        self.good = 0
        self.pinched = False
        self.packet = None
        self.reason = "no_camera"

    def set_bounds(self, bounds):
        self.bounds = validate_bounds(bounds)
        self.good = 0
        self.pinched = False
        self.reason = "bounds_changed"

    def ingest(self, packet, now=None):
        validate_tracking(packet)
        now = time.monotonic() if now is None else now
        if self.stream != packet["stream"]:
            # Prevent two active capture workers from fighting over a cursor.
            if self.stream and now - self.received < .5:
                raise ValueError("another tracking stream is active")
            self.stream, self.seq, self.good, self.pinched = packet["stream"], 0, 0, False
        if packet["seq"] <= self.seq:
            raise ValueError("duplicate or reordered frame")
        if self.packet and now - self.received + self.frame_age > .25:
            self.good, self.pinched = 0, False
        self.seq, self.received = packet["seq"], now
        self.frame_age = packet["age_ms"] / 1000
        self.packet = packet
        if not packet["present"]:
            self.good, self.pinched, self.reason = 0, False, "hand_lost"
        elif self.frame_age > .2:
            self.good, self.pinched, self.reason = 0, False, "stale"
        elif any(not (self.bounds["xmin"] <= p[0] <= self.bounds["xmax"] and
                      self.bounds["ymin"] <= p[1] <= self.bounds["ymax"]) for p in packet["landmarks"]):
            self.good, self.pinched, self.reason = 0, False, "outside_workspace"
        else:
            self.good += 1
            self.reason = "ready" if self.good >= 3 else "acquiring"
            a, b = packet["landmarks"][4], packet["landmarks"][8]
            # x and z use image-width units; compensate y for aspect ratio.
            distance = math.sqrt((a[0]-b[0])**2 + ((a[1]-b[1])/packet["aspect"])**2 + (a[2]-b[2])**2)
            self.pinched = self.good >= 3 and distance < (.055 if self.pinched else .035)
        return self.snapshot(now)

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        stale = self.packet is None or now - self.received + self.frame_age > .25
        if stale:
            self.pinched, self.good = False, 0
        enabled = not stale and self.reason == "ready"
        return {"version": 1, "seq": self.seq, "enabled": enabled,
                "pinch": bool(enabled and self.pinched),
                "reason": "stale" if stale and self.packet else self.reason,
                "simulated": self.packet["simulated"] if self.packet else False,
                "landmarks": self.packet["landmarks"] if self.packet and not stale else [],
                "bounds": self.bounds, "age_ms": round(1000*(now-self.received+self.frame_age)) if self.packet else None}
