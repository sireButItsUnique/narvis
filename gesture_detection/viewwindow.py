"""Where in each view's image to look for the hand.

Pure numpy. No camera, no MediaPipe -- see test_viewwindow.py.

The landmarker finds a hand in two steps: a palm DETECTOR over the whole image it
is given, shrunk to 192 px, and then a landmark model on the patch the detector
(or, while tracking, the last frame's landmarks) points at. On the rig the hand is
a fifth of a 1280 px frame, in a room kept dark on purpose, often fingers-first at
the lens with no palm showing: the detector sees a 30 px smudge, and once a view
has lost the hand it rarely gets it back. Measured on a recording of the rig: the
left view had the hand on 63% of frames, the right on 79%, BOTH on only 53% -- so
most frames had no second lens, no triangulation, and a distance guessed from the
hand's apparent size, which on real frames swings by a quarter from one frame to
the next. That, more than any noise, is the jitter.

The same recording says what fixes it. Where one view had lost the hand and the
other still had it, handing the lost view a CROP around where the hand had to be
found it again 90-94% of the time; a fresh detector on the full frame, 17-30%.
Same pixels, same network -- the hand is simply big enough to see.

So each view keeps a WINDOW: a square of the image, a few hand-sizes across, that
the landmarker is given instead of the frame. It follows the hand; it is placed
from the OTHER view when this one has lost it (same rows, shifted by the disparity
the hand's distance implies); and it opens back up to the whole frame when nobody
knows where the hand is. It costs nothing: a landmarker pass costs the same on
384 px as on 1280.

The window moves as seldom as it can. MediaPipe's tracking carries last frame's
landmarks forward in the coordinates of the image it was given, so a window that
moved has moved the hand out from under that memory and the tracker stumbles for
a frame. Hence the hysteresis: the window stays put while the hand is comfortably
inside it and about the right size for it.
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

__all__ = ["ViewWindow", "disparity_shift"]

Rect = Tuple[int, int, int, int]


def disparity_shift(fx: float, baseline: float, depth: float) -> float:
    """Pixels between the two views of a point `depth` metres out."""
    return fx * baseline / max(depth, 1e-3)


class ViewWindow:
    """One view's window onto the hand. `rect` is (x0, y0, x1, y1) in full-image
    pixels, or None for the whole frame."""

    def __init__(self, width: int, height: int, scale: float = 3.0,
                 min_side: int = 320, patience: int = 4):
        self.width, self.height = int(width), int(height)
        self.scale, self.min_side, self.patience = scale, min_side, patience
        self.rect: Optional[Rect] = None
        self.misses = 0

    # ---- geometry ---------------------------------------------------------

    def _square(self, cx: float, cy: float, side: float) -> Optional[Rect]:
        side = float(np.clip(side, self.min_side, max(self.width, self.height)))
        if side >= 0.9 * self.height and side >= 0.9 * self.width:
            return None                                  # as good as the whole frame: say so
        w, h = min(side, self.width), min(side, self.height)
        x0 = float(np.clip(cx - w / 2, 0, self.width - w))
        y0 = float(np.clip(cy - h / 2, 0, self.height - h))
        return int(round(x0)), int(round(y0)), int(round(x0 + w)), int(round(y0 + h))

    @staticmethod
    def _box(px) -> Tuple[float, float, float, float, float]:
        p = np.asarray(px, dtype=np.float64)
        p = p[np.isfinite(p).all(axis=1)]
        x0, y0, x1, y1 = p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()
        return x0, y0, x1, y1, max(x1 - x0, y1 - y0, 1.0)

    # ---- what happened this frame -----------------------------------------

    def saw(self, px) -> None:
        """This view found the hand, at these full-image pixels."""
        self.misses = 0
        x0, y0, x1, y1, extent = self._box(px)
        want = self.scale * extent
        if self.rect is not None:
            a, b, c, d = self.rect
            side = max(c - a, d - b)
            margin = 0.35 * extent                       # the landmark model wants room round the hand
            inside = (x0 - margin >= a or a == 0) and (x1 + margin <= c or c == self.width) \
                and (y0 - margin >= b or b == 0) and (y1 + margin <= d or d == self.height)
            if inside and 0.55 < want / side < 1.7:
                return                                   # comfortable: leave the window where it is
        self.rect = self._square((x0 + x1) / 2, (y0 + y1) / 2, want)

    def missed(self, other_px=None, shift_px: Optional[Tuple[float, float]] = None) -> None:
        """This view found nothing. `other_px` is the hand in the OTHER view this
        frame, if it had one, and `shift_px` the (least, most) signed pixels to
        add to its x to land in this view -- the disparity range the hand's
        possible distances allow. Without them the window waits where it is for
        a few frames, then opens up to the whole frame."""
        self.misses += 1
        if other_px is not None and shift_px is not None:
            x0, y0, x1, y1, extent = self._box(other_px)
            lo, hi = sorted(shift_px)
            x0, x1 = x0 + lo, x1 + hi
            self.rect = self._square((x0 + x1) / 2, (y0 + y1) / 2,
                                     max(self.scale * extent, (x1 - x0) + 0.7 * extent))
        elif self.misses > self.patience:
            self.rect = None

    def reset(self) -> None:
        self.rect, self.misses = None, 0

    # ---- using it ----------------------------------------------------------

    def crop(self, image: np.ndarray) -> np.ndarray:
        """The part of `image` the landmarker should be given."""
        if self.rect is None:
            return image
        a, b, c, d = self.rect
        return np.ascontiguousarray(image[b:d, a:c])

    def to_full(self, normalised_xy) -> np.ndarray:
        """Landmarks normalised to the CROP -> pixels in the full image."""
        p = np.asarray(normalised_xy, dtype=np.float64)
        if self.rect is None:
            return p * [self.width, self.height]
        a, b, c, d = self.rect
        return p * [c - a, d - b] + [a, b]
