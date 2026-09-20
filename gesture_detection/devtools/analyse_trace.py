"""What a captured trace says about the tracking: rates, where depth came from, jumps, shake, bones, confidence.

    python analyse_trace.py TRACE.pkl [--events]
"""
import pickle
import sys

import numpy as np

import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from handmodel import BONES                      # noqa: E402

PALM = [0, 5, 9, 13, 17]
tr = pickle.load(open(sys.argv[1], "rb"))
F, meta = tr["frames"], tr["meta"]
n = len(F)
t = np.array([f["t"] for f in F])
dt = np.diff(t)
print(f"{n} frames over {t[-1] - t[0]:.1f} s of recording  ->  recorded at {n / (t[-1] - t[0]):.1f} fps "
      f"(median frame gap {np.median(dt) * 1000:.0f} ms, worst {dt.max() * 1000:.0f} ms); replay took "
      f"{np.median([f['wall_ms'] for f in F]):.0f} ms per frame; mean image level {np.mean([f['lum'] for f in F]):.0f}/255")

has_l = np.array([f.get("raw", {}).get("left") is not None for f in F])
has_r = np.array([f.get("raw", {}).get("right") is not None for f in F])
sent = np.array([f["sent"] is not None for f in F])
views = np.array([(f["quality"] or {}).get("views", 0) if f["sent"] is not None else 0 for f in F])
ntri = np.array([(f["quality"] or {}).get("tri", 0) if f["sent"] is not None else 0 for f in F])
conf = np.array([(f["quality"] or {}).get("conf", np.nan) if f["sent"] is not None else np.nan for f in F])
same = np.array([f.get("same_hand") for f in F], dtype=object)
print(f"\nhand found   left view {has_l.mean():.0%}   right view {has_r.mean():.0%}   both {np.mean(has_l & has_r):.0%}   neither {np.mean(~has_l & ~has_r):.0%}")
print(f"hand SENT to the rig {sent.mean():.0%} of frames;  of those: both lenses {np.mean(views[sent] == 2):.0%}, one lens {np.mean(views[sent] == 1):.0%}")
both = has_l & has_r
asked = np.array([s is not None for s in same])
print(f"pairing check: asked on {asked.sum()} frames, REFUSED {np.mean([not s for s in same[asked]]):.0%} of them")
print(f"joints triangulated when paired: median {np.median(ntri[views == 2]):.0f}/21, under 15 on {np.mean(ntri[views == 2] < 15):.0%} of paired frames")
q = np.nanpercentile(conf, [5, 25, 50, 75, 95])
print(f"confidence (what the page's Q gate sees): 5% {q[0]:.2f}  25% {q[1]:.2f}  median {q[2]:.2f}  75% {q[3]:.2f}  95% {q[4]:.2f}"
      f"   | frames under 0.45: {np.nanmean(conf < 0.45):.0%}, under 0.55: {np.nanmean(conf < 0.55):.0%}")
for side in ("left", "right"):
    sc = np.array([f["raw"][side]["score"] for f in F if f.get("raw", {}).get(side)])
    print(f"  landmarker score, {side}: median {np.median(sc):.2f}, 5% {np.percentile(sc, 5):.2f}")

# ---- palm, and where it jumps
palm = np.full((n, 3), np.nan)
for i, f in enumerate(F):
    if f["sent"] is not None:
        palm[i] = f["sent"][PALM].mean(axis=0)
depth = -palm[:, 2]
print(f"\npalm distance from the lens: 5% {np.nanpercentile(depth, 5) * 100:.0f} cm, median {np.nanmedian(depth) * 100:.0f} cm, 95% {np.nanpercentile(depth, 95) * 100:.0f} cm")

# a JUMP: the palm's depth changes by more than the 2D landmarks can explain. 2D motion of the palm in the
# view that was used says how fast the hand is really going; depth cannot change much faster than that.
events = []
for i in range(1, n):
    if not (sent[i] and sent[i - 1]) or t[i] - t[i - 1] > 0.2:
        continue
    step = palm[i] - palm[i - 1]
    lateral = float(np.hypot(step[0], step[1]))
    dz = float(abs(step[2]))
    if dz > 0.012 and dz > 2.5 * lateral:
        events.append((i, dz, lateral))
print(f"DEPTH JUMPS (palm moves >12 mm along the lens axis in one frame, far more than it moved sideways): {len(events)}"
      f"  = one every {(t[-1] - t[0]) / max(len(events), 1):.1f} s;  median size {np.median([e[1] for e in events]) * 1000 if events else 0:.0f} mm,"
      f" largest {max([e[1] for e in events], default=0) * 1000:.0f} mm")
why = {"lens count changed": 0, "pairing verdict changed": 0, "view used changed": 0, "triangulated joints changed by 5+": 0, "none of these": 0}
for i, dz, lat in events:
    a, b = F[i - 1], F[i]
    hit = False
    if views[i] != views[i - 1]:
        why["lens count changed"] += 1; hit = True
    if a.get("same_hand") != b.get("same_hand"):
        why["pairing verdict changed"] += 1; hit = True
    ra, rb = a["raw"], b["raw"]
    if (ra.get("left") is None) != (rb.get("left") is None):
        why["view used changed"] += 1; hit = True
    if abs(int(ntri[i]) - int(ntri[i - 1])) >= 5:
        why["triangulated joints changed by 5+"] += 1; hit = True
    if not hit:
        why["none of these"] += 1
print("  what changed on the frame of each jump:", why)
if "--events" in sys.argv:
    for i, dz, lat in events[:40]:
        print(f"    t {t[i]:6.2f}  dz {dz * 1000:5.0f} mm  lateral {lat * 1000:4.0f} mm  lenses {views[i - 1]}->{views[i]}  tri {ntri[i - 1]}->{ntri[i]}"
              f"  same {F[i - 1].get('same_hand')}->{F[i].get('same_hand')}  depth {depth[i - 1] * 100:.0f}->{depth[i] * 100:.0f} cm")

# ---- dropouts: the hand is there one frame, gone the next, back soon after
gaps = []
i = 0
while i < n:
    if not sent[i] and i > 0 and sent[i - 1]:
        j = i
        while j < n and not sent[j]:
            j += 1
        if j < n:
            gaps.append(t[j] - t[i - 1])
        i = j
    else:
        i += 1
gaps = np.array(gaps)
print(f"\nDROPOUTS (hand sent, then not, then sent again): {len(gaps)};  under 0.3 s: {np.sum(gaps < 0.3)},  0.3-1 s: {np.sum((gaps >= 0.3) & (gaps < 1))},  longer: {np.sum(gaps >= 1)}")

# ---- shake while still: windows where the 2D landmarks barely move
raw_c = np.full((n, 2), np.nan)
for i, f in enumerate(F):
    d = f["raw"].get("left") or f["raw"].get("right")
    if d is not None:
        side = "left" if f["raw"].get("left") else "right"
        raw_c[i] = f["px"][side][PALM].mean(axis=0) if f.get("px", {}).get(side) is not None else d["lm"][PALM, :2].mean(axis=0) * meta["size"]
W = 12
still = []
for i in range(0, n - W, W // 2):
    s = slice(i, i + W)
    if sent[s].all() and np.nanmax(np.ptp(raw_c[s], axis=0)) < 6.0:        # under 6 px of palm travel in ~0.7 s
        J = np.stack([F[k]["sent"] for k in range(i, i + W)])
        r = J - J.mean(axis=0)
        still.append((np.sqrt((r[..., :2] ** 2).sum(-1).mean(0)), np.sqrt((r[..., 2] ** 2).mean(0)), views[s].mean()))
if still:
    lat = np.array([s[0] for s in still]) * 1000
    dep = np.array([s[1] for s in still]) * 1000
    print(f"\nSHAKE WHILE STILL ({len(still)} windows of ~0.7 s where the hand's image moved under 6 px), rms per joint:")
    print(f"  across the view  palm {np.median(lat[:, PALM]):.1f} mm   fingertips {np.median(lat[:, [4, 8, 12, 16, 20]]):.1f} mm   worst window {lat.max():.1f} mm")
    print(f"  toward the lens  palm {np.median(dep[:, PALM]):.1f} mm   fingertips {np.median(dep[:, [4, 8, 12, 16, 20]]):.1f} mm   worst window {dep.max():.1f} mm")

# ---- bones: a hand is rigid
L = np.array([[np.linalg.norm(f["sent"][a] - f["sent"][b]) for a, b in BONES] for f in F if f["sent"] is not None])
med = np.median(L, axis=0)
dev = np.abs(L / med - 1)
print(f"\nBONES: a bone's length strays from its own median by {np.median(dev) * 100:.1f}% typically, {np.percentile(dev, 95) * 100:.0f}% at the 95th percentile"
      f"  ({np.median(np.abs(L - med)) * 1000:.1f} mm / {np.percentile(np.abs(L - med), 95) * 1000:.1f} mm)")

# ---- the solver: how often does a joint end up far from its own measurement, or on the near clip
far, clipped, meas = 0, 0, 0
for f in F:
    s = f.get("solve")
    if not s:
        continue
    ok = np.isfinite(s["data"])
    meas += ok.sum()
    far += np.sum(np.abs(s["out"][ok] - s["data"][ok]) > 0.01)
    clipped += np.sum(s["out"] < 0.0255)
print(f"\nSOLVER: of {meas} measured joint-depths, {far / max(meas, 1):.1%} were moved more than 1 cm by the solve; {clipped} joints ended on the near clip")

# ---- the SHAPE: a joint leaping relative to the palm, by more than its image moved
PX_TO_M = None
shape_jumps, big = 0, []
frames_checked = 0
for i in range(1, n):
    if not (sent[i] and sent[i - 1]) or t[i] - t[i - 1] > 0.2:
        continue
    side = "left" if F[i]["raw"].get("left") and F[i - 1]["raw"].get("left") else "right" if F[i]["raw"].get("right") and F[i - 1]["raw"].get("right") else None
    if side is None or F[i].get("px", {}).get(side) is None or F[i - 1].get("px", {}).get(side) is None:
        continue
    frames_checked += 1
    a, b = F[i - 1]["sent"], F[i]["sent"]
    rel = (b - b[PALM].mean(0)) - (a - a[PALM].mean(0))
    pa, pb = F[i - 1]["px"][side], F[i]["px"][side]
    relpx = (pb - pb[PALM].mean(0)) - (pa - pa[PALM].mean(0))
    mm_per_px = float(depth[i]) / meta["intr"][0] * 1000.0
    moved_img = np.linalg.norm(relpx, axis=1) * mm_per_px          # how far each joint's IMAGE moved, in mm at the hand
    leap = np.linalg.norm(rel, axis=1) * 1000.0
    bad = leap > np.maximum(12.0, 3.0 * moved_img)
    if bad.any():
        shape_jumps += 1
        big.append(float(leap[bad].max()))
print()
print(f"SHAPE JUMPS (a joint leaps >12 mm relative to the palm in one frame, 3x more than its image moved): {shape_jumps} of {frames_checked} frame pairs"
      f" = {shape_jumps / max(frames_checked, 1):.1%};  median leap {np.median(big) if big else 0:.0f} mm, 90th pct {np.percentile(big, 90) if big else 0:.0f} mm")

# ---- ROUGHNESS: the second difference. Real motion is smooth from frame to frame; jitter is not. Needs no
# choice of "still" windows, so it compares one version of the pipeline with another on the same recording.
acc_pl, acc_pd, acc_rl, acc_rd = [], [], [], []
for i in range(2, n):
    if not (sent[i] and sent[i - 1] and sent[i - 2]) or t[i] - t[i - 2] > 0.3:
        continue
    J = [F[i - 2]["sent"], F[i - 1]["sent"], F[i]["sent"]]
    P = [j[PALM].mean(0) for j in J]
    a = P[2] - 2 * P[1] + P[0]
    acc_pl.append(np.hypot(a[0], a[1])); acc_pd.append(abs(a[2]))
    R = [j - p for j, p in zip(J, P)]
    ar = R[2] - 2 * R[1] + R[0]
    acc_rl.append(np.hypot(ar[:, 0], ar[:, 1])); acc_rd.append(np.abs(ar[:, 2]))
acc_rl, acc_rd = np.array(acc_rl), np.array(acc_rd)
print(f"\nROUGHNESS (second difference, mm; lower is steadier)   median / 90th pct / 99th pct")
print(f"  palm, across the view       {np.median(acc_pl)*1000:5.1f} / {np.percentile(acc_pl, 90)*1000:5.1f} / {np.percentile(acc_pl, 99)*1000:5.1f}")
print(f"  palm, toward the lens       {np.median(acc_pd)*1000:5.1f} / {np.percentile(acc_pd, 90)*1000:5.1f} / {np.percentile(acc_pd, 99)*1000:5.1f}")
print(f"  joints vs palm, across      {np.median(acc_rl)*1000:5.1f} / {np.percentile(acc_rl, 90)*1000:5.1f} / {np.percentile(acc_rl, 99)*1000:5.1f}")
print(f"  joints vs palm, toward lens {np.median(acc_rd)*1000:5.1f} / {np.percentile(acc_rd, 90)*1000:5.1f} / {np.percentile(acc_rd, 99)*1000:5.1f}")
print(f"  frames in the comparison: {len(acc_pl)}")
