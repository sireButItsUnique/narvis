"""Reading a hand's depth out of a depth map that contains everything else too.

Pure numpy. No camera, no MediaPipe -- see test_depthsample.py.

A depth sample taken near a hand is almost never a measurement of one surface.
A fingertip's landmark sits on the hand's outline, so a patch centred on it is
a quarter wall; stereo smears every outline into depths that belong to neither
side; and where the matcher loses the hand altogether it reports the wall
THROUGH it. Any statistic over such a patch answers "what do these pixels
average to" when the question was "which of them is the hand".

So the hand is picked out BEFORE any statistic is taken, three ways:

    where to look   A fingertip's sample point is pulled back along the
                    finger, so the patch starts out all finger instead of
                    three quarters. What is read there belongs to a point part-way
                    along a bone, and the hand model says how to carry it
                    back to the joint.
    how wide        The patch is sized to a finger at the hand's distance. A
                    fixed radius that fits a finger at HD720 is wider than
                    the whole finger at VGA, or across a room.
    which surface   Pixels are kept only near a reference depth that never
                    touched the depth map (fuse3d.hand_reference), and among
                    those the nearest coherent cluster wins. Nearest-first is
                    right because a hand occludes what is behind it. The gate
                    covers the two cases it gets wrong: something in FRONT of
                    the hand, and a hand with no valid pixels at all, where
                    the only coherent surface left in the patch is the wall.

Convention: the point cloud's Z is negative in front of the camera, as in the
rest of the project, and so is every depth passed in or handed back.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from fuse3d import (ScaleCalibration, hand_reference, near_surface,
                    palm_triangulation, size_depth)

__all__ = [
    "ANCHOR_IDX", "SAMPLE_TOWARD", "JOINT_HALF_WIDTH", "PALM_HALF_WIDTH",
    "at_sample_points", "patch_radius", "patch_depths", "gate_half_width",
    "joint_tolerance", "sample_palm_depth", "sample_joint_depths",
    "sample_unbiased", "PalmFix", "locate_palm",
]

# The four knuckles, deliberately without the wrist. Every joint here must sit
# on the hand itself: the wrist is where the forearm begins, so a patch around
# it contains forearm by definition, and an arm pointing at the camera then
# drags the anchor -- the one number the whole hand hangs off -- backwards.
ANCHOR_IDX = (5, 9, 13, 17)

#: Where each joint's depth is read: (joint to move toward, fraction of the
#: way). Joints not listed are read in place.
#:
#: Only the fingertips, and only a quarter of the way, and both are measured
#: decisions. Moving a sample point is not free: the reading has to be carried
#: back to the joint with the MODEL's relative depths, so whatever is wrong
#: with the model's pose leaks into the measurement, in proportion to the
#: fraction and to the bone's length.
#:
#: A fingertip's last bone is 2 cm and its patch really is a quarter wall, so
#: the trade wins: rendered against a close wall (test_depthsample.py), median
#: tip error goes 2.6 -> 0.9 mm with a perfect model, 2.6 -> 1.1 with one 10
#: degrees out, 2.5 -> 1.7 at 20, and breaks even at 30. A larger fraction does
#: slightly better with a perfect model (0.8 mm at 0.35) and is worse than not
#: moving at all by 30 degrees; a quarter is never worse.
#:
#: The wrist and knuckles hang off 9 cm bones and have no mixed patch to get
#: away from -- a forearm is continuous with the wrist, and the gaps between
#: fingers open 2 cm beyond the knuckles. Moved, they read 8.6 and 5.5 mm out
#: with the model 20 degrees off, against 1.3 and 0.6 left where they are.
SAMPLE_TOWARD = {
    4: (3, 0.25), 8: (7, 0.25), 12: (11, 0.25), 16: (15, 0.25), 20: (19, 0.25),
}

_TOWARD = np.arange(21)
_ALPHA = np.zeros(21)
for _joint, (_to, _frac) in SAMPLE_TOWARD.items():
    _TOWARD[_joint], _ALPHA[_joint] = _to, _frac

#: Half-widths of the patches, in metres on the hand. A finger is about 16 mm
#: across and a knuckle over 20, so both stay inside with room for a landmark
#: that is a pixel or two off. At HD720 and 0.8 m they come to the 4 and 6
#: pixels that were fixed before.
JOINT_HALF_WIDTH = 0.006
PALM_HALF_WIDTH = 0.009


def at_sample_points(values) -> np.ndarray:
    """A per-joint quantity carried to where that joint is actually sampled.

    Works on pixels, (21, 2), and on model depths, (21,). Linear along the
    bone, which is exact for pixels and near enough for depth over the few
    centimetres involved.
    """
    v = np.asarray(values, dtype=np.float64)
    a = _ALPHA.reshape((-1,) + (1,) * (v.ndim - 1))
    return (1.0 - a) * v + a * v[_TOWARD]


def patch_radius(depth: float, fx: float, half_width: float,
                 lo: int, hi: int, default: int) -> int:
    """Patch radius in pixels covering `half_width` metres at `depth`.

    `depth` is a positive distance here -- it comes from the reference, which
    lives in the solver's convention. Without one the old fixed radius stands.
    """
    if depth is None or not np.isfinite(depth) or depth <= 0.0:
        return default
    return int(np.clip(round(half_width * fx / depth), lo, hi))


def patch_depths(pc: np.ndarray, uv, radius: int) -> np.ndarray:
    """Every finite Z in a square patch. Negative values are in front."""
    u, v = int(round(float(uv[0]))), int(round(float(uv[1])))
    h, w = pc.shape[:2]
    if not (0 <= u < w and 0 <= v < h):
        return np.empty(0)
    z = pc[max(0, v - radius):min(h, v + radius + 1),
           max(0, u - radius):min(w, u + radius + 1), 2].ravel()
    z = z[np.isfinite(z)]
    return z[(z < -0.1) & (z > -5.0)]


def gate_half_width(sigma: float, k: float = 2.5, margin: float = 0.03,
                    lo: float = 0.06, hi: float = 0.30) -> float:
    """How far from the reference a pixel may be and still count as the hand.

    The reference's own uncertainty, plus the palm's relief and tilt. With
    both cameras on a hand at 0.8 m that is about 7 cm, which already excludes
    a torso or a wall; with nothing but uncalibrated apparent size it opens to
    the 30 cm cap and the nearest-surface rule is left to do the work.
    """
    if sigma is None or not np.isfinite(sigma):
        return hi
    return float(np.clip(k * sigma + margin, lo, hi))


def joint_tolerance(anchored: bool, ref_sigma: float, base: float = 0.05,
                    hi: float = 0.20) -> float:
    """Window around each joint's expected depth.

    The window has to cover the uncertainty of the expectation. Hung off a
    depth-map anchor that is a few millimetres and the base window is plenty;
    hung off the reference alone it is the reference's uncertainty, and a
    window narrower than that looks for the hand where it is not.
    """
    if anchored or ref_sigma is None or not np.isfinite(ref_sigma):
        return base
    return float(np.clip(2.0 * ref_sigma, base, hi))


def sample_palm_depth(pc: np.ndarray, pixels, ref: Optional[float] = None,
                      ref_sigma: Optional[float] = None,
                      prior: Optional[float] = None, model_rel=None,
                      radius: int = 6, prior_window: float = 0.15,
                      min_pixels: int = 8, with_counts: bool = False):
    """One depth for the whole palm, pooled across the four knuckles.

    Pooling beats sampling each joint separately: the palm is one broad
    surface, so every valid pixel across the patches is evidence about the
    same depth, and a few hundred samples make the estimate robust to the
    handful that caught a gap between fingers. `model_rel` refers each patch
    to the palm's centre before pooling, so a palm turned edge-on pools into
    one cluster instead of four. Below about 45 degrees of roll it changes
    nothing, because the knuckles all fit inside near_surface's window anyway;
    at 55 the raw pool reads the nearest knuckles, 9 mm short against 3.

    `ref` is where the hand is according to sources that never touched the
    depth map, and pixels outside its gate are not the hand, however coherent
    a surface they make. When nothing survives the gate this returns None
    rather than the best of what is left: the caller already holds a better
    fallback than the wrong surface, namely the reference itself. This is what
    ends the latch -- the old anchor was gated only by its own previous value,
    so once it landed on the wall the wall became the prior.

    `prior` is the previous frame's answer and still breaks ties INSIDE the
    gate. It matters when the gate is wide: if the pool holds a hand and the
    torso behind it, an unprimed pick can change surface from frame to frame
    and swing the whole hand, which showed up live as swipes at 4-8 m/s. The
    window is deliberately wide: 15 cm in one frame is 9 m/s, so real motion
    always stays inside it and only surface changes fall out.
    """
    px = at_sample_points(pixels)
    rel = (np.zeros(len(px)) if model_rel is None
           else at_sample_points(np.nan_to_num(np.asarray(model_rel, dtype=np.float64))))
    pool = np.concatenate([patch_depths(pc, px[i], radius) - rel[i]
                           for i in ANCHOR_IDX])
    n_pool = n_gated = len(pool)

    def done(z):
        return (z, (n_pool, n_gated)) if with_counts else z

    if ref is not None and np.isfinite(ref):
        pool = pool[np.abs(pool - ref) <= gate_half_width(ref_sigma)]
        n_gated = len(pool)
    if len(pool) < min_pixels:
        return done(None)
    if prior is not None:
        near = pool[np.abs(pool - prior) <= prior_window]
        if len(near) >= min_pixels:
            pool = near
    # nearest coherent surface, not the median: see fuse3d.near_surface
    depth, _ = near_surface(-pool)
    return done(-depth if np.isfinite(depth) else None)


def sample_joint_depths(pc: np.ndarray, pixels, palm_z: float,
                        model_rel: np.ndarray, radius: int = 4,
                        tol: float = 0.05, with_spread: bool = False):
    """Per-joint depth, accepting only pixels near where the joint should be.

    This is the fix for joints flung into the background. A patch around a
    fingertip straddles two surfaces metres apart; a median over it returns
    whichever has more pixels, which on a thin finger is regularly the wall.
    Selecting the pixels consistent with the model's expectation instead
    recovers the right surface even when the finger is a minority of the
    patch -- and reports nothing when none of them are, which the solver
    handles.
    """
    px = at_sample_points(pixels)
    rel = np.asarray(model_rel, dtype=np.float64)
    rel_at = at_sample_points(rel)
    out = np.full(len(px), np.nan)
    spread = np.full(len(px), np.nan)
    for i in range(len(px)):
        expect = palm_z + float(rel_at[i])
        z = patch_depths(pc, px[i], radius)
        if len(z) == 0:
            continue
        near = z[np.abs(z - expect) <= tol]
        if len(near) >= 3:
            # the nearest surface among the plausible pixels, for the same
            # reason as the anchor: a finger occludes the arm behind it, and
            # the arm is close enough to pass the plausibility window
            depth, sd = near_surface(-near, window=0.015)
            if np.isfinite(depth):
                # read part-way along the bone, so carried back to the joint
                out[i] = -depth + float(rel[i] - rel_at[i])
                # how tightly the accepted pixels agree IS the uncertainty of
                # this reading: a tight cluster is one surface, a wide one
                # means the patch still straddles an edge
                spread[i] = sd
    return (out, spread) if with_spread else out


def sample_unbiased(pc: np.ndarray, pixels, palm_z: float, radius: int = 3,
                    tol: float = 0.15) -> np.ndarray:
    """Depth at every sample point, from a window symmetric about the palm.

    Used only to decide the model's depth sign. The window carries no
    information about which way the model thinks the fingers point, so the
    correlation it feeds is not merely confirming the sign already assumed --
    which sampling with the model prior would be. For the same reason the
    readings are NOT carried back to the joints, which would take the model:
    they stay depths at the sample points, and the caller compares them with
    the model at the same points (at_sample_points).

    Nearest surface rather than the median this used to take. Against a wall
    inside the window the median reads the wall at every thin joint, which is
    not noise but a standing vote that the fingers point away.

    Every joint, not only the fingertips: DepthSignEstimator wants six joints
    before it will count a frame, and five fingertips never made six.
    """
    px = at_sample_points(pixels)
    out = np.full(len(px), np.nan)
    for i in range(len(px)):
        z = patch_depths(pc, px[i], radius)
        depth, _ = near_surface(-z[np.abs(z - palm_z) <= tol], window=0.015)
        if np.isfinite(depth):
            out[i] = -depth
    return out


@dataclass
class PalmFix:
    """Where the palm is, and how that was decided."""
    z: Optional[float]           # the anchor, negative in front; None = no idea
    source: str                  # "map", "reference", "previous" or "nothing"
    ref_d: float                 # the reference and its parts, as POSITIVE
    ref_sigma: float             #   depths -- the solver's convention -- and
    tri_d: float                 #   NaN where there was none
    size_d: float
    pool: int                    # patch pixels found, and how many of them
    gated: int                   #   the reference agreed were the hand
    r_palm: int
    r_joint: int

    @property
    def anchored(self) -> bool:
        """True when the depth map itself supplied the anchor."""
        return self.source == "map"


def locate_palm(pc: np.ndarray, pixels, rays, world_landmarks, model_rel,
                d_tri, sig_tri, scale_cal: ScaleCalibration, fx: float,
                prior: Optional[float] = None, recent=None,
                t: Optional[float] = None, tracker=None) -> PalmFix:
    """The palm's depth: decided without the depth map, then refined by it.

    The order is the point. The map says how far away a surface is and not
    whose surface, so something that cannot land on the wall has to choose
    first -- and the reference is built from landmarks, which are on the hand.
    Only then is the map asked, and only about pixels inside the reference's
    gate.

    When the map has nothing the gate accepts, the anchor is the reference and
    not the last map reading: it is current, where a stale depth freezes a
    hand that is moving toward the camera, and it is on the hand by
    construction, where the last map reading is whatever the map last said.

    `scale_cal` is updated here. From triangulation when there is any, since
    that owes the depth map nothing; with one camera, from the gated map
    reading, which is the best scale there is.

    `recent` (a fuse3d.RecentScale, with the frame's time `t`) bridges the
    frames triangulation misses: see its docstring. It belongs to the hand
    being followed, where `scale_cal` belongs to the person.

    `tracker` (a palmtrack.PalmTracker) makes the palm's distance a STATE that
    this frame's readings update, instead of something worked out afresh from
    whatever this frame happens to offer. Two things change. With no second
    lens, the map is asked about the place the palm was EXPECTED, not the
    place its apparent size suggests -- which on real frames is off by a
    quarter and lets the forearm or the background in. And the answer is the
    tracker's: a precise reading moves it at once, a guess hardly at all.
    """
    rel = np.asarray(model_rel, dtype=np.float64)
    # size_depth places the hand's centroid; the model says how far that sits
    # from the palm. Depths are positive here, and rel is +toward the camera.
    d_size = size_depth(rays, world_landmarks) + float(np.nanmean(rel))
    tri_d, tri_sigma = palm_triangulation(d_tri, sig_tri)
    size_d, size_sigma = scale_cal.correct(d_size)
    if recent is not None and t is not None:
        if np.isfinite(tri_d):
            recent.observe(tri_d, d_size, t)
        else:
            bridged = recent.correct(d_size, t)
            if bridged is not None:
                size_d, size_sigma = bridged
    expected = tracker.predict(t) if tracker is not None and t is not None else None
    if np.isfinite(tri_d) or expected is None:
        ref_d, ref_sigma = hand_reference(tri_d, tri_sigma, size_d, size_sigma)
    else:
        ref_d, ref_sigma = expected[0], float(np.hypot(expected[1], 0.01))
    ref_z = -ref_d if np.isfinite(ref_d) else None
    # learned only after it has served as the check on this frame's reading
    scale_cal.observe(tri_d, d_size)

    r_palm = patch_radius(ref_d, fx, PALM_HALF_WIDTH, 3, 12, 6)
    r_joint = patch_radius(ref_d, fx, JOINT_HALF_WIDTH, 2, 8, 4)
    map_z, (pool, gated) = sample_palm_depth(
        pc, pixels, ref=ref_z, ref_sigma=ref_sigma, prior=prior, model_rel=rel,
        radius=r_palm, with_counts=True)

    if map_z is not None:
        z, source = map_z, "map"
        if not np.isfinite(tri_d):
            scale_cal.observe(-map_z, d_size)
    elif ref_z is not None:
        z, source = ref_z, "reference"
    elif prior is not None:
        z, source = prior, "previous"
    else:
        z, source = None, "nothing"
    if tracker is not None and t is not None:
        soft = [(-map_z, 0.008)] if map_z is not None else []
        if np.isfinite(size_d):
            # what apparent size is really worth, measured on the rig: half its own value. Taken of
            # the larger of the guess and the expectation, or a guess that happens to come out SMALL
            # would also claim to be precise.
            soft.append((size_d, 0.5 * max(size_d, expected[0] if expected is not None else size_d)))
        d, _ = tracker.update(t, hard=(tri_d, tri_sigma) if np.isfinite(tri_d) else None, soft=soft)
        if d is not None:
            z = -d
            if source == "nothing":
                source = "previous"
    return PalmFix(z, source, ref_d, ref_sigma, tri_d, size_d, pool, gated,
                   r_palm, r_joint)

