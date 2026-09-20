"""A hand moving through the rig's working volume, for rehearsing without the cameras.

The flat-panel simulator drives image-normalized landmarks; this drives RIG centimetres, so the hologram
can be judged — reach, pinch, occlusion, how big a card has to be before you can hit it — before the stereo
pair is wired up. Everything it produces is marked simulated, and the service refuses real volume hand
packets while demo mode is on, so the two can never be confused.
"""
import math
import time

# Offsets from the index fingertip, in centimetres, roughly a right hand held palm-down over the desk.
# MediaPipe order: wrist, then thumb, index, middle, ring, little, four joints each.
# The thumb has to open WIDE. An open pose closer than PINCH_OPEN_CM never releases the gate's
# hysteresis, so the first pinch latches forever and every later gesture lands on whatever it grabbed.
# A real open hand holds thumb and index tip about 7 cm apart; anything much less is not an open hand.
HAND_CM = [(0.4, -0.6, -8.4),
           (-3.4, -0.5, -7.0), (-4.8, -0.3, -5.6), (-5.6, -0.2, -4.4), (-5.8, 0.4, -3.6),
           (-1.2, -0.2, -5.4), (-0.9, -0.1, -3.4), (-0.5, 0.0, -1.6), (0.0, 0.0, 0.0),
           (0.6, -0.2, -5.6), (0.9, -0.1, -3.4), (1.1, 0.0, -1.5), (1.2, 0.0, 0.2),
           (2.2, -0.2, -5.4), (2.6, -0.1, -3.4), (2.8, 0.0, -1.8), (2.9, 0.0, -0.4),
           (3.7, -0.3, -5.0), (4.2, -0.2, -3.4), (4.4, -0.1, -2.2), (4.5, 0.0, -1.2)]
THUMB_TIP, INDEX_TIP = 4, 8
# Mirrors LEVEL_FRONT in web_ar_canvas/public/volume.mjs: where the level you are on sits in the slab.
LEVEL_FRONT = 0.65


def _hand(tip, pinching, label):
    points = [[tip[0] + dx, tip[1] + dy, tip[2] + dz] for dx, dy, dz in HAND_CM]
    if label == "left":
        points = [[2 * tip[0] - p[0], p[1], p[2]] for p in points]   # mirror about the fingertip
    if pinching:
        # Closing the pinch moves the THUMB to the index tip, never the other way round: the cursor is the
        # index fingertip and it must not jump sideways at the moment the gesture starts.
        points[THUMB_TIP] = list(points[INDEX_TIP])
    return dict(label=label, landmarks_cm=points)


def packet(elapsed, volume, anchor=(0., -13., 0.), fault="none"):
    """One or two hands working the slab.

    The cycle deliberately exercises every branch of the gesture machine: one hand touching and pinching,
    then both hands pinching and drawing apart, which is the only gesture that can zoom. A simulator that
    only ever shows one hand cannot tell you whether the two-handed path works.
    """
    w, h, d = volume["width_cm"], volume["height_cm"], volume["depth_cm"]
    # Sweep the plane the current level actually occupies (LEVEL_FRONT in volume.mjs), not the whole slab:
    # a hand wandering in free space never comes within touching distance of a card, so a demo built on
    # one shows the tracking working and the interaction doing nothing.
    tip = [anchor[0] + .40 * w * math.sin(elapsed * .55),
           anchor[1] + .34 * h * math.cos(elapsed * .37),
           anchor[2] + (LEVEL_FRONT - .5) * d + 1.2 * math.sin(elapsed * .9)]
    if fault == "boundary":
        tip[0] = anchor[0] + w * 3
    phase = elapsed % 18.0
    two_handed = 11.0 <= phase < 16.0
    if two_handed:
        # Both hands close, then draw apart: the span grows, which is a zoom.
        spread = 5.0 + 4.5 * (phase - 11.0) / 5.0
        right_tip = [tip[0] + spread, tip[1], tip[2]]
        left_tip = [tip[0] - spread, tip[1], tip[2]]
        hands = [_hand(right_tip, True, "right"), _hand(left_tip, True, "left")]
    else:
        hands = [_hand(tip, int(elapsed) % 6 in (2, 3), "right")]
    return dict(version=1, frame="rig_cm", age_ms=400. if fault == "stale" else 0.,
                simulated=True, hands=[] if fault == "lost" else hands)


def head(elapsed, fault="none"):
    """A head that keeps moving, because a hologram that never moves proves nothing.

    Without this the demo has hands but no eye, and the volume stays frozen — which is correct behaviour
    and completely useless for rehearsing. A seated viewer swaying a few centimetres is enough to show
    the parallax the whole rig exists for.
    """
    return dict(version=1, frame="rig_cm", simulated=True,
                age_ms=400. if fault == "stale" else 0.,
                position_cm=[9.0 * math.sin(elapsed * .21),
                             42.0 + 2.5 * math.sin(elapsed * .13),
                             44.0 + 3.0 * math.cos(elapsed * .17)])


def run(state, stop):
    start = time.monotonic()
    while not stop.wait(1 / 30):
        elapsed = time.monotonic() - start
        with state.lock:
            anchor = (0., -state.rig["anchor_drop_cm"], 0.)
            state.hands.ingest(packet(elapsed, state.volume, anchor, state.demo_fault))
            # "lost" and "boundary" are about the hand; the head keeps working so the difference between
            # "I cannot see your hand" and "I cannot see you" stays visible on the desk.
            state.set_eye(head(elapsed, state.demo_fault))
