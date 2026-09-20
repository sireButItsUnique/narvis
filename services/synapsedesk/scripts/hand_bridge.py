"""Reference bridge: your hand tracker -> SynapseDesk's working volume.

You already have tracking. This is the whole seam, and it is deliberately short: get the token once, POST
the fingertips at whatever rate you track at, stop. Everything else — pinch, hysteresis, settling, what a
grab MEANS — happens in the service, so two trackers behave identically on the desk.

    python scripts/hand_bridge.py --demo                 # a circling hand, to prove the wiring
    python scripts/hand_bridge.py --calibrate            # print the frame your numbers imply
    # or import post_hands() and call it from your own tracker's loop

THE ONE THING TO GET RIGHT is the frame. The service works in RIG centimetres: origin at the centre of the
acrylic sheet, +X your right, +Y up, +Z toward you. Your tracker almost certainly works somewhere else.
Rather than converting in your code, tell the service once:

    POST /api/hand-frame
    {"version": 1, "units": "m", "axes": ["x", "y", "-z"], "scale": [1,1,1], "offset": [0,-13,0]}

  units   cm | m | mm | in      what your numbers are in
  axes    which of YOUR axes becomes rig X, Y, Z; a leading minus flips it
  scale   per-axis multiplier applied after the unit conversion (usually 1,1,1)
  offset  centimetres added last: where your origin sits in the rig

After that, POST your raw numbers forever and the service registers them. If a point lands more than 3 m
from the desk the packet is rejected with a message saying to check the frame, rather than dropping a hand
somewhere absurd and leaving you to wonder why nothing is grabbable.
"""
import argparse
import json
import math
import time
from urllib.request import Request, urlopen

DEFAULT_URL = "http://127.0.0.1:8770"


def session(url=DEFAULT_URL, timeout=3):
    with urlopen(url + "/api/session", timeout=timeout) as response:
        return json.load(response)


def post(url, path, token, payload, timeout=1):
    request = Request(url + path, json.dumps(payload).encode(),
                      {"Content-Type": "application/json", "X-Synapse-Token": token})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def set_frame(url, token, units="cm", axes=("x", "y", "z"), scale=(1, 1, 1), offset=(0, 0, 0)):
    """Call once, or whenever the cameras move."""
    return post(url, "/api/hand-frame", token,
                dict(version=1, units=units, axes=list(axes), scale=list(scale), offset=list(offset)))


def post_hands(url, token, hands, age_ms=0.0, simulated=False):
    """hands: [{"label": "right", "thumb_tip": [x,y,z], "index_tip": [x,y,z]}, ...]

    Or pass "landmarks": [[x,y,z] * 21] in MediaPipe order if you have the whole hand — the extra joints
    are only drawn, never interpreted, so the two fingertips are genuinely enough.
    """
    return post(url, "/api/hands", token,
                dict(version=1, age_ms=age_ms, simulated=simulated, hands=hands))


def circling(elapsed, radius_cm=7.0, drop_cm=13.0):
    """A right hand circling the anchor, pinching for two seconds in every six."""
    tip = [radius_cm * math.sin(elapsed * .8), -drop_cm + 3.0 * math.cos(elapsed * .5),
           radius_cm * .6 * math.cos(elapsed * .8)]
    pinching = int(elapsed) % 6 in (2, 3)
    thumb = list(tip) if pinching else [tip[0] - 3.2, tip[1] - 1.0, tip[2]]
    return [dict(label="right", thumb_tip=thumb, index_tip=tip)]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--demo", action="store_true", help="post a circling hand instead of a real one")
    parser.add_argument("--calibrate", action="store_true", help="set the hand frame from the flags below")
    parser.add_argument("--units", default="cm", choices=("cm", "m", "mm", "in"))
    parser.add_argument("--axes", default="x,y,z", help="e.g. 'x,-z,y' to swap and flip")
    parser.add_argument("--offset", default="0,0,0", help="centimetres, applied last")
    parser.add_argument("--scale", default="1,1,1")
    args = parser.parse_args()

    info = session(args.url)
    token = info["token"]
    if args.calibrate:
        frame = set_frame(args.url, token, args.units, args.axes.split(","),
                          [float(v) for v in args.scale.split(",")],
                          [float(v) for v in args.offset.split(",")])
        print("hand frame set:", json.dumps(frame))
        return
    if not args.demo:
        print(__doc__)
        print("Nothing to send: import post_hands() from your tracker's loop, or pass --demo.")
        return
    if info.get("demo"):
        raise SystemExit("The service is in demo mode and simulates its own hand. "
                         "Restart it without --demo before bridging a real tracker.")
    print(f"Posting a simulated hand to {args.url}. Ctrl+C stops.")
    start = time.monotonic()
    while True:
        frame_start = time.monotonic()
        try:
            post_hands(args.url, token, circling(frame_start - start),
                       age_ms=(time.monotonic() - frame_start) * 1000, simulated=True)
        except OSError as exc:
            print(f"delivery failed: {exc}", flush=True)
            time.sleep(.25)
        time.sleep(max(0.0, 1 / 60 - (time.monotonic() - frame_start)))


if __name__ == "__main__":
    main()
