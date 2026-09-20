"""Hands inside the rig's working volume. Interaction gating only; no safety claim.

The flat-panel path (gestures.GestureGate) works in image-normalized coordinates and a homography onto a
projector plane. That cannot describe a hand INSIDE a hologram, so this is the volume equivalent: the
tracker hands over landmarks already triangulated into RIG centimetres, and this decides what they mean.

What it keeps from the flat path, because the reasons still hold:
  - the service derives pinch and never trusts an upstream pinch boolean
  - two thresholds with hysteresis, never one, so a pinch does not chatter on the boundary
  - a settling count before gestures arm, so a freshly acquired hand cannot grab on its first frame
  - staleness expires the whole gesture rather than leaving a stale cursor on the desk

What is new, because centimetres are not image fractions:
  - pinch is a real distance in centimetres between thumb tip and index tip, not an image fraction
  - a hand outside the working volume is reported but disarmed: you cannot grab what you are not near
"""
import math
import time
from synapsedesk.contracts import validate_hands

THUMB_TIP, INDEX_TIP, WRIST = 4, 8, 0
PINCH_CLOSE_CM = 2.2      # fingers this close start a pinch
PINCH_OPEN_CM = 3.6       # and must separate this far to end it
# Settling is a DURATION, not a frame count. Three frames is 100 ms at 30 Hz and 250 ms at 12 Hz, so a
# tracker having a slow moment silently changed how long the desk took to arm.
SETTLE_MS = 100.0
SETTLE_FRAMES = 3         # floor, so a fast tracker still has to agree with itself more than once
MAX_AGE_S = .25
REACH_MARGIN_CM = 8.0     # how far outside the slab a hand may be and still be tracked


class VolumeHands:
    def __init__(self, volume=None):
        self.volume = dict(volume or dict(width_cm=21.1, depth_cm=10.0, height_cm=11.9))
        self.anchor = [0., -13., 0.]
        self.packet = None
        self.received = 0.
        self.frame_age = 0.
        self.good = 0
        self.settled_ms = 0.
        self.last_seen = None
        self.pinched = {}
        self.slots = {}
        self.inferred_labels = False
        self.reason = "no_hands"

    def set_volume(self, volume, anchor=None):
        self.volume = dict(volume)
        if anchor is not None:
            self.anchor = [float(v) for v in anchor]

    def _inside(self, point):
        half = (self.volume["width_cm"] / 2 + REACH_MARGIN_CM,
                self.volume["height_cm"] / 2 + REACH_MARGIN_CM,
                self.volume["depth_cm"] / 2 + REACH_MARGIN_CM)
        return all(abs(point[i] - self.anchor[i]) <= half[i] for i in range(3))

    @staticmethod
    def _slots(hands):
        """A stable key per hand.

        Labels are optional in the contract and default to "unknown", so two unlabelled hands both arrive
        as "unknown" and the second silently overwrote the first in every per-hand dict here — the pinching
        hand's state was replaced by the open one's and two-handed gestures could never arm. When labels
        do not distinguish the hands, order them left to right as seen from the seat, which at least is
        deterministic, and say that it was inferred.
        """
        labels = [h["label"] for h in hands]
        if len(set(labels)) == len(labels) and "unknown" not in labels:
            return {id(h): h["label"] for h in hands}, False
        order = sorted(hands, key=lambda h: h["landmarks_cm"][INDEX_TIP][0])
        names = ("left", "right") if len(order) == 2 else ("unknown",)
        return {id(h): names[i] for i, h in enumerate(order)}, True

    def ingest(self, packet, now=None, frame=None):
        packet = validate_hands(packet, frame)
        now = time.monotonic() if now is None else now
        # A gap in delivery disarms, exactly as it does on the flat panel: a gesture may not survive a
        # silence and resume mid-grab somewhere else.
        if self.packet and now - self.received + self.frame_age > MAX_AGE_S:
            self.good, self.settled_ms, self.pinched = 0, 0., {}
        self.received, self.frame_age, self.packet = now, packet["age_ms"] / 1000, packet
        if not packet["hands"]:
            self.good, self.settled_ms, self.pinched, self.reason = 0, 0., {}, "no_hands"
        elif self.frame_age > .2:
            self.good, self.settled_ms, self.pinched, self.reason = 0, 0., {}, "stale"
        elif not any(self._inside(h["landmarks_cm"][INDEX_TIP]) for h in packet["hands"]):
            self.good, self.settled_ms, self.pinched, self.reason = 0, 0., {}, "outside_volume"
        else:
            self.good += 1
            self.settled_ms += 1000 * max(0., now - (self.last_seen or now))
            self.last_seen = now
            armed = self.good >= SETTLE_FRAMES and self.settled_ms >= SETTLE_MS
            self.reason = "ready" if armed else "acquiring"
            slots, inferred = self._slots(packet["hands"])
            self.inferred_labels = inferred
            fresh = {}
            for hand in packet["hands"]:
                slot = slots[id(hand)]
                a, b = hand["landmarks_cm"][THUMB_TIP], hand["landmarks_cm"][INDEX_TIP]
                gap = math.dist(a, b)
                threshold = PINCH_OPEN_CM if self.pinched.get(slot) else PINCH_CLOSE_CM
                fresh[slot] = armed and gap < threshold
            self.pinched = fresh
            self.slots = slots
        return self.snapshot(now)

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        stale = self.packet is None or now - self.received + self.frame_age > MAX_AGE_S
        if stale:
            self.good, self.settled_ms, self.pinched = 0, 0., {}
        enabled = not stale and self.reason == "ready"
        hands = []
        if self.packet and not stale:
            for hand in self.packet["hands"]:
                tip = hand["landmarks_cm"][INDEX_TIP]
                thumb = hand["landmarks_cm"][THUMB_TIP]
                slot = self.slots.get(id(hand), hand["label"])
                # The cursor is the MIDPOINT of thumb and index, not the index tip. Closing a pinch swings
                # the index a centimetre or more toward the thumb, so an index-tip cursor lurches sideways
                # at the exact moment a gesture begins; the midpoint barely moves.
                anchor = [(tip[i] + thumb[i]) / 2 for i in range(3)]
                hands.append({"label": slot,
                              "landmarks_cm": hand["landmarks_cm"],
                              "index_tip_cm": tip,
                              "thumb_tip_cm": thumb,
                              "anchor_cm": anchor,
                              "pinch": bool(enabled and self.pinched.get(slot, False)),
                              "inside": self._inside(anchor)})
        return {"version": 1, "frame": "rig_cm", "enabled": enabled,
                "reason": "stale" if stale and self.packet else self.reason,
                "simulated": self.packet["simulated"] if self.packet else False,
                "hands": hands, "labels_inferred": self.inferred_labels,
                "age_ms": round(1000 * (now - self.received + self.frame_age)) if self.packet else None}
