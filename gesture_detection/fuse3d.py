"""Fusing left camera, right camera and depth map into one hand.

Pure numpy. No camera, no MediaPipe -- see test_fuse3d.py.

Each joint's pixel in the left image fixes a viewing ray. A point on that ray
has exactly one degree of freedom: how far along it the joint sits. So a whole
hand is 21 unknowns, not 63, and every input is a constraint on those numbers:

    depth map      a direct, noisy reading of one of them
    triangulation  another, from the same joint found in the right image
    MediaPipe      a weak prior on all of them, from its metric hand
    bone lengths   the strong one -- a hand is rigid, so the distances between
                   its joints are fixed, and they can be measured over time

Solving all of them together is what separates this from picking a winner per
joint. A fingertip with no usable depth is still pinned by the bones joining
it to knuckles that have one, and a fingertip with *wrong* depth is outvoted
rather than believed.

Convention matches the rest of the project (+X right, +Y up, +Z toward the
camera), so "depth" here is a positive distance in front and a joint's
position is depth * ray.
"""

from __future__ import annotations

from collections import deque
from typing import Optional, Sequence, Tuple

import numpy as np

from handmodel import BONES, PALM_IDX

#: The nearest a joint is allowed to be solved. It was 8 cm, which is a sensible floor for a hand a
#: metre away and a BUG on the rig: reaching into the slot end-on with the palm 12-15 cm from the lens
#: puts the fingertips at 5-7 cm, where they were pinned at exactly 0.08 -- deaf to real motion -- and
#: their perfectly good triangulations then thrown out for disagreeing with the value the solver had
#: itself clamped. 2.5 cm is closer than a fingertip can be and still be in both lenses.
NEAREST_DEPTH = 0.025

__all__ = [
    "rays_from_pixels", "points_from_depths", "triangulate_depths", "same_hand",
    "row_tolerance", "disparity_noise",
    "triangulation_sigma", "depthmap_sigma", "near_surface", "BoneCalibration", "MetricBones",
    "size_depth", "ScaleCalibration", "RecentScale", "palm_triangulation", "hand_reference",
    "fuse_measurements", "solve_depths",
]


def rays_from_pixels(pixels, intr) -> np.ndarray:
    """Direction per joint such that position = depth * ray."""
    fx, fy, cx, cy = intr
    px = np.asarray(pixels, dtype=np.float64)
    return np.stack([(px[:, 0] - cx) / fx,
                     -(px[:, 1] - cy) / fy,
                     -np.ones(len(px))], axis=1)


def points_from_depths(rays: np.ndarray, depths) -> np.ndarray:
    return np.asarray(rays, dtype=np.float64) * np.asarray(depths, dtype=np.float64)[:, None]


def row_tolerance(pixels, base: float = 12.0, frac: float = 0.05) -> float:
    """How far apart in rows the two views may put one joint.

    A landmarker's error is a fraction of the hand, not a number of pixels. At
    arm's length a hand is 120 px long and 12 px is generous; on the rig the
    hand is 25 cm from the lens and 400 px long, and the same tracker, no less
    sure of itself, misses by three times as many pixels. A fixed 12 would throw
    most of a close hand's joints away as "not the same point".
    """
    px = np.asarray(pixels, dtype=np.float64)
    px = px[np.isfinite(px).all(axis=1)]
    if len(px) < 2:
        return base
    return max(base, frac * float(np.linalg.norm(px.max(axis=0) - px.min(axis=0))))


def triangulate_depths(px_left, px_right, fx: float, baseline: float,
                       max_row_error: float = 12.0,
                       min_disparity: float = 1.0) -> np.ndarray:
    """Per-joint depth from the disparity between the views, NaN where unusable.

    Two guards. Rectification puts the same physical point on the same image
    row, so a large row disagreement means the two detections are not the same
    joint and their disparity is meaningless -- triangulation fails by
    producing a confident wrong answer, not by producing nothing. And below a
    pixel of disparity the estimate is noise rather than a distant hand.
    """
    a = np.asarray(px_left, dtype=np.float64)
    b = np.asarray(px_right, dtype=np.float64)
    disparity = a[:, 0] - b[:, 0]
    ok = (np.abs(a[:, 1] - b[:, 1]) <= max_row_error) & (disparity >= min_disparity)
    out = np.full(len(a), np.nan)
    out[ok] = fx * baseline / disparity[ok]
    return out


def disparity_noise(px_left, px_right, floor: float = 1.5) -> np.ndarray:
    """Per-joint sigma of the disparity, in pixels, MEASURED from this frame.

    The two landmarkers are wrong independently, and how wrong cannot be read off
    the x coordinates, where their disagreement IS the signal. But rectification
    puts a point on the same row in both views, so in y any disagreement is pure
    error -- the same error, statistically, that is hiding in x. So the rows say
    how good this frame's landmarks are: for the hand as a whole (the robust
    spread of the row differences) and joint by joint (each one's own).

    On a recording of the rig the row differences run at a median 6 px on frames
    that pair well and 20+ on the rest: four to fifteen times the fixed 1.5 px the
    fusion used to assume, which made every triangulated joint look millimetre-good
    and left the bones, at 3 mm, outvoted by noise. With the sigma measured, a good
    frame's joints still steer the hand and a poor frame's only place it.

    A common vertical offset is taken out first: it is a fault of rectification or
    of the landmarkers' crops, moves every joint alike, and says nothing about x.
    """
    a = np.asarray(px_left, dtype=np.float64)
    b = np.asarray(px_right, dtype=np.float64)
    rows = a[:, 1] - b[:, 1]
    ok = np.isfinite(rows)
    if not ok.any():
        return np.full(len(a), np.nan)
    resid = np.abs(rows - np.median(rows[ok]))
    hand = 1.4826 * float(np.median(resid[ok]))
    return np.sqrt(floor ** 2 + hand ** 2 + resid ** 2)


def same_hand(px_left, px_right, fx: float, baseline: float,
              expected_depth: float = float("nan"), max_row_error: float = 12.0,
              max_shape_error: float = 0.12, min_joints: int = 11,
              max_hand_rows: float = 0.12) -> bool:
    """Whether a detection in each view is one hand seen twice.

    Each view runs its own landmarker on one hand, so with two hands in frame
    nothing makes them choose the same one -- and a left hand triangulated
    against a right hand is 21 confident, mutually consistent, wrong depths,
    which is the one kind of error the solver cannot outvote. The handedness
    labels used to stand guard here, but they are the landmarker's least
    reliable output, and requiring them to match threw away the right view
    every time they disagreed about what was plainly the same hand.

    Geometry says it better. The same hand lies on the same rows in both
    views, to the right in the left one, and has the same SHAPE. A person's
    other hand is a mirror image: its disparities scatter by the width of the
    hand, and its knuckles run the other way across the picture. Last, where
    the hand's depth is already roughly known from its apparent size, the
    disparity has to imply something like it.

    Scatter ALONE is not the shape test, though it used to be, and that cost
    the rig its right view entirely. Disparity goes as one over depth, so a
    hand's own depth relief scatters it too -- by relief / distance. At arm's
    length that is a few percent and a 12% limit separates it cleanly from a
    mirrored hand's ~40%. On the rig the hand is 25 cm from the lens with its
    fingers pointing AT it: 17 cm of relief, 25% of scatter, every joint
    triangulating perfectly, and the pairing refused every frame -- leaving the
    hand to be placed by apparent size, which is uncalibrated there and scales
    the whole hand about the lens. So scatter only counts against a pairing
    when the knuckle row also runs the wrong way, which relief cannot do.
    """
    a = np.asarray(px_left, dtype=np.float64)
    b = np.asarray(px_right, dtype=np.float64)
    disparity = a[:, 0] - b[:, 0]
    # Rows are judged for the HAND, not joint by joint. Demanding that eleven joints each sit within
    # 5% of the hand's size of their twin refused a third of the real frames on the rig -- one hand,
    # plainly the same hand, seen by two landmarkers that were each a little unsure -- and a refusal
    # costs triangulation altogether. A different hand is off by a hand's HEIGHT, not by a few percent:
    # the typical row difference, as a fraction of the hand's extent, separates the two with room to
    # spare. The joints that then go into the statistics are the ones no worse than three times typical.
    rows = np.abs(a[:, 1] - b[:, 1])
    extent = float(np.linalg.norm(np.nanmax(a, axis=0) - np.nanmin(a, axis=0)))
    typical_rows = float(np.nanmedian(rows))
    if typical_rows > max(max_row_error, max_hand_rows * extent):
        return False
    ok = (rows <= max(max_row_error, 3.0 * typical_rows)) & (disparity >= 1.0)
    if int(ok.sum()) < min_joints:
        return False
    typical = float(np.median(disparity[ok]))
    scatter = float(np.median(np.abs(disparity[ok] - typical)))
    if scatter > max(max_shape_error * typical, 4.0):      # 4 px: landmark noise
        # Too scattered for a shallow hand. Relief, or the other hand? The
        # thumb base and knuckles sit at nearly one depth, so between two
        # views of one hand they keep their left-to-right order; a mirror
        # image reverses it. Edge-on the row has no order to read, and then
        # its mirror image would not scatter either -- so that is relief.
        row = [i for i in (1, 5, 9, 13, 17) if ok[i]]
        if len(row) >= 3:
            xl, xr = a[row, 0] - a[row, 0].mean(), b[row, 0] - b[row, 0].mean()
            extent = float(np.linalg.norm(a.max(axis=0) - a.min(axis=0)))
            if xl.std() > 0.04 * extent and float(xl @ xr) < 0.0:
                return False
    # The shape test is relative, so two hands far apart slip through it: their
    # disparity is huge and the tolerance grows with it. But a huge disparity
    # claims the hand is a hand's length from the lens, and at that distance
    # it would fill the frame. Whatever depth the disparity implies, the hand
    # has to come out hand-sized there: 2-11 cm RMS covers a child's fist to a
    # large open hand.
    depth = fx * baseline / typical
    size = float(np.sqrt(((a - a.mean(axis=0)) ** 2).sum(axis=1).mean())) * depth / fx
    if not 0.02 < size < 0.11:
        return False
    if np.isfinite(expected_depth) and expected_depth > 0:
        if not 0.6 < depth / expected_depth < 1.6:         # ScaleCalibration's bounds
            return False
    return True


def triangulation_sigma(depth, fx: float, baseline: float,
                        pixel_noise: float = 1.5) -> np.ndarray:
    """Depth uncertainty from disparity noise: dz = z^2 * du / (f * B).

    Quadratic in depth, which is why triangulation is excellent close up and
    poor across a room -- and why it must be weighted rather than trusted.
    """
    z = np.asarray(depth, dtype=np.float64)
    return z * z * pixel_noise / (fx * baseline)


def near_surface(depths, window: float = 0.040, seed_pct: float = 7.0,
                 min_count: int = 3):
    """(depth, spread) of the NEAREST coherent surface in a patch, or (nan, nan).

    A hand occludes whatever is behind it, so at a pixel belonging to the hand
    the true depth is the nearer surface -- never the average of two.

    This matters most in the case every "is it plausible?" test misses: an arm
    pointing at the camera puts the forearm a few centimetres behind the palm,
    well inside any sane tolerance, so the contaminating pixels pass every
    filter and drag a median backwards. Taking the near cluster instead is not
    a heuristic, it is what occlusion means.

    Seeded from a low percentile rather than the minimum, so a single
    noise-near pixel cannot define the surface, then widened to a hand's own
    thickness so the whole palm is still averaged together.

    The seed percentile sets how buried the hand may be before the seed lands
    in the wrong surface. Measured against a forearm 8 cm back: 15% survives
    down to the hand being a fifth of the patch, 7% down to a twelfth, and
    every value is equally unbiased on a clean patch -- so the low one costs
    nothing and buys tolerance.
    """
    d = np.asarray(depths, dtype=np.float64)
    d = d[np.isfinite(d)]
    if len(d) < min_count:
        return float("nan"), float("nan")
    # np.percentile's own linear interpolation, by partition: the same number
    # to the last bit at a twelfth of the cost, and this runs 40 times a frame
    pos = (len(d) - 1) * seed_pct / 100.0
    lo = int(pos)
    hi = min(lo + 1, len(d) - 1)
    part = np.partition(d, (lo, hi))
    seed = float(part[lo] + (pos - lo) * (part[hi] - part[lo]))
    near = d[np.abs(d - seed) <= window]
    if len(near) < min_count:
        return float("nan"), float("nan")
    return float(np.mean(near)), float(np.std(near))


def depthmap_sigma(spread, floor: float = 0.005) -> np.ndarray:
    """Uncertainty of a depth-map reading, from the scatter of the pixels that
    produced it. A tight cluster is one surface; a wide one means the patch
    caught an edge and the reading deserves less weight."""
    s = np.asarray(spread, dtype=np.float64)
    return np.maximum(s, floor)


class BoneCalibration:
    """Running estimate of one hand's bone lengths.

    A hand is rigid: its bones are the same length in every frame. MediaPipe
    re-estimates them per frame and is slightly wrong each time, so a median
    over a window is a far better skeleton than any single frame -- and it is
    what the solver leans on hardest, so it is worth getting right.
    """

    def __init__(self, n_bones: int = len(BONES), window: int = 90,
                 ready_after: int = 15):
        self._hist = [deque(maxlen=window) for _ in range(n_bones)]
        self.ready_after = ready_after

    def observe(self, lengths) -> None:
        for i, v in enumerate(np.asarray(lengths, dtype=np.float64)):
            if i < len(self._hist) and np.isfinite(v) and 0.005 < v < 0.20:
                self._hist[i].append(float(v))

    @property
    def count(self) -> int:
        return min((len(h) for h in self._hist), default=0)

    @property
    def ready(self) -> bool:
        return self.count >= self.ready_after

    def lengths(self) -> Optional[np.ndarray]:
        if not self.ready:
            return None
        return np.array([np.median(h) for h in self._hist])


class MetricBones:
    """This hand's bone lengths, MEASURED -- in the camera's own metres.

    BoneCalibration takes the lengths from MediaPipe's metric hand. That hand is
    a generic one, and on a recording of the rig it disagreed with what the two
    lenses actually measured by a third to a half across the palm (knuckle to
    knuckle), while the solver leaned on it harder than on anything else: bones
    at 3 mm. A bone that is too short for the rays it has to span cannot be
    satisfied by any depths at all, and the nearest the solver can get is to
    push both ends to the SAME depth -- so a palm tilted toward the lens, which
    on this rig is most of the time, was flattened square to the camera, and the
    fingers hung off it wrong.

    Triangulation knows how long the bones really are. Not on every frame and
    not for every bone: a bone pointing at the lens has its length in the
    difference of two depths, each noisy by more than the bone is long. But a
    bone lying ACROSS the view has its length in the angle between two rays
    times a distance known to a percent or two, and that is a measurement. So
    each bone is learned from the frames where it lies mostly across the view,
    and the rest are MediaPipe's proportions at this hand's measured scale.
    """

    def __init__(self, n_bones: int = len(BONES), window: int = 240, ready_after: int = 20,
                 max_slope: float = 0.6, max_sigma: float = 0.012):
        self._hist = [deque(maxlen=window) for _ in range(n_bones)]
        self.ready_after, self.max_slope, self.max_sigma = ready_after, max_slope, max_sigma

    def observe(self, rays, d_tri, sig_tri) -> None:
        """One paired frame: rays, and each joint's triangulated depth and its sigma (NaN where none)."""
        r = np.asarray(rays, dtype=np.float64)
        d = np.asarray(d_tri, dtype=np.float64)
        sg = np.asarray(sig_tri, dtype=np.float64)
        good = np.isfinite(d) & np.isfinite(sg) & (sg <= self.max_sigma)
        p = r * d[:, None]
        for i, (a, b) in enumerate(BONES):
            if not (good[a] and good[b]):
                continue
            v = p[a] - p[b]
            across, along = float(np.hypot(v[0], v[1])), abs(float(v[2]))
            if along <= self.max_slope * across and 0.005 < across < 0.20:
                self._hist[i].append(float(np.hypot(across, along)))

    def measured(self) -> np.ndarray:
        """Per bone: the measured length, NaN where there are not enough sightings yet."""
        return np.array([np.median(h) if len(h) >= self.ready_after else np.nan for h in self._hist])

    def lengths(self, model_lengths) -> Optional[np.ndarray]:
        """The skeleton to solve against: measured where it has been, the model's proportions at
        this hand's scale where it has not. `model_lengths` is BoneCalibration's (or None)."""
        if model_lengths is None:
            return None
        model = np.asarray(model_lengths, dtype=np.float64)
        got = self.measured()
        seen = np.isfinite(got) & (model > 0)
        if not seen.any():
            return model
        scale = float(np.clip(np.median(got[seen] / model[seen]), 0.8, 1.4))
        return np.where(seen, got, model * scale)


# --------------------------------------------------------------------------
# where the hand is, without asking the depth map
# --------------------------------------------------------------------------
#
# The depth map can tell precisely how far away a surface is and not at all
# whose surface it is. Choosing between the surfaces in a patch therefore
# needs an estimate that cannot land on the wall, and both of these qualify:
# each is built from landmarks, and the landmarks are on the hand.

def size_depth(rays, world_landmarks, near: float = 0.05,
               far: float = 4.0) -> float:
    """Depth of the hand from how large it appears, or NaN.

    MediaPipe's metric hand says how big the hand is and the landmarks say how
    big it looks, so depth is one over the other -- the single estimate here
    that owes nothing to the depth map OR the right view.

    Size is the RMS spread of all 21 joints about their centroid, not the
    length of one bone. A bone pointing at the camera foreshortens to nothing
    and reads as a hand far away; the model's x and y already carry the pose,
    so the ratio of spreads holds in any orientation. A spread is also blind
    to in-plane rotation and mirroring, so nothing here depends on the model's
    axes matching the image's.

    Apparent size is measured about the hand's own viewing ray, in its tangent
    plane, rather than in the image plane. The landmarker sees a crop and
    cannot know where in the frame it came from, so its model describes the
    hand as seen along that ray -- and this lens is wide enough that 30
    degrees off-axis, the image-plane version reads 7% short.

    The answer is the depth of the hand's CENTROID, and only as good as the
    model's idea of how big a hand is: off by a roughly constant factor for a
    given person, which ScaleCalibration measures.

    It is also weak-perspective, and that is left alone on purpose. Fingers
    reaching toward the camera are magnified, so the hand looks bigger and
    reads near: 2-4% at 0.8 m on the exaggerated hand in test_fuse3d.py, up to
    9% at 0.4 m, under 1% on realistic proportions. The model's z could
    correct it, but z is the landmarker's least reliable output and its sign
    is the one convention here still taken on trust -- wrong, the correction
    would double the error it was meant to remove. The error is inside the
    uncertainty this estimate is given, and with both cameras triangulation
    outweighs it seven to one.
    """
    r = np.asarray(rays, dtype=np.float64)
    w = np.asarray(world_landmarks, dtype=np.float64)[:, :2]
    ok = np.isfinite(r).all(axis=1) & np.isfinite(w).all(axis=1)
    if int(ok.sum()) < 5:
        return float("nan")
    u = r[ok] / np.linalg.norm(r[ok], axis=1, keepdims=True)
    centre = u.mean(axis=0)
    centre /= np.linalg.norm(centre)
    tangent = u / (u @ centre)[:, None] - centre
    apparent = float(np.sqrt(((tangent - tangent.mean(axis=0)) ** 2).sum()))
    metric = float(np.sqrt(((w[ok] - w[ok].mean(axis=0)) ** 2).sum()))
    if apparent < 1e-6 or metric < 1e-3:
        return float("nan")
    depth = metric / apparent * -float(centre[2])   # range along the ray -> depth
    return depth if near < depth < far else float("nan")


class ScaleCalibration:
    """Running ratio of a hand's measured depth to its size_depth.

    MediaPipe's metric hand is a generic one, so depth from apparent size is
    wrong by however much this person's hand differs from it. That is a
    constant, and a median over a window finds it -- while a surface flipping
    from frame to frame, the failure this exists to catch, cannot move a
    median at all.

    Until it is ready the ratio is 1 and the uncertainty is the spread of
    adult hand sizes, which makes for a wide gate rather than a wrong one.
    Afterwards it is what a constant cannot absorb: size_depth's perspective
    error, which moves with the pose.
    """

    def __init__(self, window: int = 90, ready_after: int = 15,
                 uncalibrated: float = 0.15, calibrated: float = 0.06):
        self._hist: deque = deque(maxlen=window)
        self.ready_after = ready_after
        self.uncalibrated = uncalibrated
        self.calibrated = calibrated

    def observe(self, measured: float, from_size: float) -> None:
        if not (np.isfinite(measured) and np.isfinite(from_size)) or from_size <= 0:
            return
        ratio = float(measured) / float(from_size)
        if 0.6 < ratio < 1.6:                  # no hand is further off than this
            self._hist.append(ratio)

    @property
    def ready(self) -> bool:
        return len(self._hist) >= self.ready_after

    @property
    def ratio(self) -> float:
        return float(np.median(self._hist)) if self.ready else 1.0

    def correct(self, from_size: float) -> Tuple[float, float]:
        """(depth, sigma) for a raw size_depth."""
        if not np.isfinite(from_size):
            return float("nan"), float("nan")
        depth = float(from_size) * self.ratio
        return depth, depth * (self.calibrated if self.ready else self.uncalibrated)


def palm_triangulation(d_tri, sig_tri, min_joints: int = 3,
                       floor: float = 0.010) -> Tuple[float, float]:
    """(depth, sigma) of the palm from the per-joint triangulated depths.

    The median of the palm joints, so one joint matched to the wrong place in
    the right image cannot move it. The sigma is NOT divided down by the
    number of joints: both views come from the same landmarker looking at
    nearly the same picture, so their errors are shared across the hand
    rather than independent per joint.
    """
    d = np.asarray(d_tri, dtype=np.float64)[list(PALM_IDX)]
    s = np.asarray(sig_tri, dtype=np.float64)[list(PALM_IDX)]
    ok = np.isfinite(d) & np.isfinite(s)
    if int(ok.sum()) < min_joints:
        return float("nan"), float("nan")
    return float(np.median(d[ok])), max(float(np.median(s[ok])), floor)


class RecentScale:
    """What the hand's apparent size was worth A MOMENT AGO, for the frames the
    second lens misses.

    ScaleCalibration is about the PERSON: a running median over seconds, which
    is right for "this hand is 8% bigger than the model's". But size_depth's
    error is mostly about the POSE -- fingers reaching at the lens read near, a
    fist reads far -- and that part is steady from one frame to the next and
    quite different from the long-run median. So when triangulation drops out
    (the hand's edge leaves one lens, the pairing check refuses a frame), the
    palm used to step from the triangulated depth to the person-calibrated size
    depth: centimetres, in one frame, and back again when the lens returned.
    Those steps, not noise, are most of what reads as jitter on the rig.

    This remembers the ratio triangulation/size over the last few paired frames
    and applies it to the size reading while triangulation is away. At the
    moment of the hand-over the two agree by construction, the hand still
    follows real motion toward and away from the lens (apparent size does
    respond to that), and the claim fades -- the sigma grows with age -- until
    after `max_age` seconds it stops answering and the person-level
    calibration takes over again.
    """

    def __init__(self, tau: float = 0.12, max_age: float = 1.0,
                 fresh: float = 0.02, growth: float = 0.15):
        self.tau, self.max_age, self.fresh, self.growth = tau, max_age, fresh, growth
        self.ratio: Optional[float] = None
        self.t = -1e9

    def reset(self) -> None:
        self.ratio, self.t = None, -1e9

    def observe(self, tri_d: float, size_d: float, t: float) -> None:
        if not (np.isfinite(tri_d) and np.isfinite(size_d) and size_d > 0 and tri_d > 0):
            return
        r = tri_d / size_d
        if not 0.5 < r < 2.0:                     # not a hand's worth of disagreement: do not learn it
            return
        if self.ratio is None or t - self.t > self.max_age:
            self.ratio = r
        else:
            k = 1.0 - float(np.exp(-max(t - self.t, 0.0) / self.tau))
            self.ratio += (r - self.ratio) * k
        self.t = t

    def correct(self, size_d: float, t: float) -> Optional[Tuple[float, float]]:
        """(depth, sigma) from this frame's apparent size, or None when the
        memory is too old to speak."""
        age = t - self.t
        if self.ratio is None or not np.isfinite(size_d) or not 0.0 <= age <= self.max_age:
            return None
        d = size_d * self.ratio
        return float(d), float(d * (self.fresh + self.growth * age))


def hand_reference(tri_d: float, tri_sigma: float, size_d: float,
                   size_sigma: float, disagree_k: float = 3.0) -> Tuple[float, float]:
    """(depth, sigma) of the palm from the two sources above, NaN with neither.

    The two fail in opposite ways, which is what makes the pair useful.
    Triangulation is precise but fragile: match the right view's landmarks to
    the wrong thing and it is confidently wrong by any amount. Apparent size
    is crude but cannot be wrong by much, because a hand cannot be twice the
    size of a hand. So size is the check on triangulation -- when they
    disagree by more than their uncertainties allow, the crude one is kept --
    and otherwise they are combined by precision, which in practice means
    triangulation with a sanity bound.
    """
    have_tri = bool(np.isfinite(tri_d) and np.isfinite(tri_sigma) and tri_sigma > 0)
    have_size = bool(np.isfinite(size_d) and np.isfinite(size_sigma) and size_sigma > 0)
    if have_tri and have_size:
        if abs(tri_d - size_d) > disagree_k * float(np.hypot(tri_sigma, size_sigma)):
            return float(size_d), float(size_sigma)
        wt, ws = 1.0 / tri_sigma ** 2, 1.0 / size_sigma ** 2
        return float((wt * tri_d + ws * size_d) / (wt + ws)), float((wt + ws) ** -0.5)
    if have_tri:
        return float(tri_d), float(tri_sigma)
    if have_size:
        return float(size_d), float(size_sigma)
    return float("nan"), float("nan")


def fuse_measurements(values: Sequence, sigmas: Sequence):
    """Inverse-variance combine of per-joint depth estimates.

    Returns (depth, sigma), NaN where nothing was measured. Weighting by
    precision rather than averaging matters because the sources differ in
    quality by an order of magnitude and differ per joint: the depth map is
    best on the palm, triangulation degrades with distance, and either can be
    absent on any given joint.
    """
    n = len(np.asarray(values[0]))
    num = np.zeros(n)
    den = np.zeros(n)
    for v, s in zip(values, sigmas):
        v = np.asarray(v, dtype=np.float64)
        s = np.asarray(s, dtype=np.float64)
        ok = np.isfinite(v) & np.isfinite(s) & (s > 0)
        w = np.where(ok, 1.0 / np.maximum(s, 1e-4) ** 2, 0.0)
        num += np.where(ok, w * v, 0.0)
        den += w
    depth = np.where(den > 0, num / np.maximum(den, 1e-12), np.nan)
    sigma = np.where(den > 0, 1.0 / np.sqrt(np.maximum(den, 1e-12)), np.nan)
    return depth, sigma


def solve_depths(rays: np.ndarray, d_init, data_d, data_sigma,
                 bone_lengths_m: Optional[np.ndarray] = None,
                 bone_sigma: float = 0.003,
                 prior_d=None, prior_sigma: float = 0.030,
                 huber_k: float = 2.5, reject_k: float = 6.0,
                 iterations: int = 10) -> np.ndarray:
    """Gauss-Newton over the joint depths, measurements against bone lengths.

    Every residual is either "this joint's depth should be what was measured"
    or "these two joints should be this far apart". The second kind is what
    lets a well-measured knuckle rescue a fingertip whose depth is missing or
    wrong, and it is why the result cannot come apart the way independent
    per-joint estimation does.

    The weak prior on every joint keeps the system non-singular when a joint
    has no measurement at all: bone constraints alone fix relative positions
    but leave an unmeasured chain free to slide along its rays.
    """
    rays = np.asarray(rays, dtype=np.float64)
    n = len(rays)
    d = np.asarray(d_init, dtype=np.float64).astype(np.float64).copy()
    d = np.where(np.isfinite(d) & (d > 0.05), d, 0.8)

    data_d = np.asarray(data_d, dtype=np.float64)
    data_sigma = np.asarray(data_sigma, dtype=np.float64)
    usable = np.isfinite(data_d) & np.isfinite(data_sigma) & (data_sigma > 0)
    data_w = np.where(usable, 1.0 / np.maximum(data_sigma, 1e-4) ** 2, 0.0)
    data_v = np.where(usable, data_d, 0.0)

    # With no independent prior, fall back to the starting depths but almost
    # without weight. Defaulting to d_init at full strength makes the prior
    # agree with whatever the measurements said, including their mistakes --
    # it stops being a prior and becomes a second vote for the same error.
    if prior_d is None:
        prior_v, prior_sigma = d.copy(), max(prior_sigma, 1.0)
    else:
        prior_v = np.asarray(prior_d, dtype=np.float64)
    prior_v = np.where(np.isfinite(prior_v), prior_v, d)
    prior_w = np.full(n, 1.0 / prior_sigma ** 2)

    # Start a joint whose measurement fights the prior from the prior instead.
    # A bone length constrains a joint's ray at TWO points -- the near and far
    # intersections with a sphere around its neighbour -- and Gauss-Newton
    # keeps whichever branch it started on. Beginning at a depth that is
    # 20 cm wrong lands on the wrong branch and stays there, however heavily
    # the bones are weighted.
    #
    # "Fights" is judged against BOTH uncertainties, the prior's as well as the
    # measurement's. Measured against the measurement's alone this rule ate the
    # rig alive: 25 cm from the lens triangulation is good to a millimetre,
    # while the model prior -- MediaPipe's idea of a hand with 17 cm of depth
    # relief, fingers pointing at the camera -- is out by centimetres. Every
    # joint "fought" the prior, was started there, stood sixty sigma from its
    # own exact measurement, and was dropped below as if it were the wall. The
    # whole hand then came out at the prior: 15% off, every movement magnified.
    # A reading that the prior cannot rule out is where to start; one that is
    # 20 cm out is still 6 of the prior's own sigmas away, and still is not.
    if prior_d is not None:
        both = np.hypot(np.maximum(data_sigma, 1e-4), prior_sigma)
        far = usable & (np.abs(d - prior_v) > 4.0 * both)
        d = np.where(far, prior_v, d)

    bone_w = (1.0 / bone_sigma ** 2) if bone_lengths_m is not None else 0.0

    for _ in range(iterations):
        jtj = np.zeros((n, n))
        jtr = np.zeros(n)

        # Robust data terms, re-weighted each iteration: Huber in the middle,
        # fully redescending past reject_k.
        #
        # A reading that disagrees with the rest of the hand by ten sigma is
        # not a heavy-tailed measurement of the finger, it is an accurate
        # measurement of the wall behind it. Down-weighting alone leaves it
        # pulling -- with a Huber taper the arithmetic works out to a couple of
        # centimetres of residual pull, which is exactly the error that was
        # visible. Dropping it entirely is the honest model of what happened.
        resid = d - data_v
        sig = np.maximum(data_sigma, 1e-4)
        ratio = np.abs(resid) / sig
        robust = np.where(ratio <= huber_k, 1.0,
                          np.where(ratio <= reject_k,
                                   huber_k / np.maximum(ratio, 1e-9), 0.0))
        w_eff = data_w * np.where(usable, robust, 0.0)

        jtj[np.diag_indices(n)] += w_eff + prior_w
        jtr += w_eff * resid + prior_w * (d - prior_v)

        if bone_w:
            for k, (a, b) in enumerate(BONES):
                if k >= len(bone_lengths_m):
                    break
                target = bone_lengths_m[k]
                if not np.isfinite(target):
                    continue
                v = d[a] * rays[a] - d[b] * rays[b]
                length = float(np.linalg.norm(v))
                if length < 1e-6:
                    continue
                g = length - float(target)
                ja = float(v @ rays[a]) / length
                jb = -float(v @ rays[b]) / length
                jtj[a, a] += bone_w * ja * ja
                jtj[b, b] += bone_w * jb * jb
                jtj[a, b] += bone_w * ja * jb
                jtj[b, a] += bone_w * ja * jb
                jtr[a] += bone_w * ja * g
                jtr[b] += bone_w * jb * g

        jtj[np.diag_indices(n)] += 1e-6                # Levenberg damping
        try:
            step = np.linalg.solve(jtj, -jtr)
        except np.linalg.LinAlgError:
            break                                      # keep the last good depths
        if not np.isfinite(step).all():
            break
        d = np.clip(d + step, NEAREST_DEPTH, 6.0)
        if np.abs(step).max() < 1e-5:
            break
    return d
