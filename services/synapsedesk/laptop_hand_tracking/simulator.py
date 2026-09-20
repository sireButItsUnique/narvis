import math
import time

# Wrist and four joints per finger, in MediaPipe order.
HAND = [(0,.09),(-.04,.065),(-.07,.035),(-.09,.005),(-.10,-.025),
        (-.035,.01),(-.04,-.04),(-.04,-.075),(-.04,-.11),
        (0,0),(0,-.055),(0,-.095),(0,-.13),
        (.035,.01),(.04,-.04),(.04,-.075),(.04,-.10),
        (.065,.035),(.08,0),(.09,-.03),(.095,-.055)]


def packet(seq, elapsed, fault="none"):
    x, y = .5 + .22*math.sin(elapsed*.65), .55 + .12*math.cos(elapsed*.4)
    points = [[x+dx,y+dy,0.] for dx,dy in HAND]
    if int(elapsed) % 6 in (2,3):
        points[4] = list(points[8])
    if fault == "boundary":
        points[8][0] = 1.1
    return dict(version=1, stream="demo", seq=seq, age_ms=400 if fault == "stale" else 0,
                aspect=4/3, present=fault != "lost", simulated=True,
                landmarks=[] if fault == "lost" else points)


def run(state, stop):
    start, seq = time.monotonic(), 0
    while not stop.wait(1/30):
        seq += 1
        with state.lock:
            value = packet(seq, time.monotonic()-start, state.demo_fault)
            state.gate.ingest(value)
