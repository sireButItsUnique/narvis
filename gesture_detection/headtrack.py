"""Where the viewer's eyes are, from a face found in both of the ZED's views.

Pure numpy. No camera, no MediaPipe -- see test_headtrack.py.

HoloDesk tracks the head with a separate webcam and "the OpenCV face tracker"
and uses it for one thing: the eye position that the off-axis projection is
drawn from. This rig has no second camera, and does not need one -- the ZED at
the back of the rig already looks out at the viewer over their hands, so the
same two images that place the hand place the head, in the same frame, with
the same factory baseline. Whatever is wrong with where the camera is thought
to stand is then wrong for the hand and the eye TOGETHER, which is the error
the picture forgives most.

The eye point is the midpoint between the two eyes. Each eye is triangulated on
its own from the same landmark in the left and right image, and the distance
between them is the check: it has to come out as far apart as eyes are.

Frame: the ZED's, as everywhere in this project -- metres, left lens at the
origin, +X right, +Y up, +Z toward the camera, so a face in front has z < 0.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

__all__ = ["HeadFix", "eye_pixels", "triangulate_point", "head_from_views",
           "IRIS_RIGHT", "IRIS_LEFT", "EYE_CORNERS_RIGHT", "EYE_CORNERS_LEFT"]

# MediaPipe face mesh indices. "Right" and "left" are the SUBJECT's, so the
# right eye is the one on the left of an unmirrored image.
IRIS_RIGHT, IRIS_LEFT = 468, 473              # only in the 478-point model
EYE_CORNERS_RIGHT = (33, 133)                 # outer, inner
EYE_CORNERS_LEFT = (362, 263)                 # inner, outer

#: Adult interpupillary distance runs 54-74 mm. Wider than that either way and
#: the two views were not looking at the same eyes.
IPD_RANGE = (0.045, 0.085)


@dataclass
class HeadFix:
    """One frame's answer. `eye` is None whenever `ok` is False."""
    ok: bool
    why: str
    eye: Optional[np.ndarray] = None          # midpoint between the eyes
    eyes: Optional[np.ndarray] = None         # (2, 3): subject's right, left
    ipd: float = float("nan")


def eye_pixels(landmarks_px) -> np.ndarray:
    """(2, 2) pixel centres of the subject's right and left eye.

    The iris centres when the model has them: they are what the viewer looks
    out of, and a single regressed point is steadier than it sounds because
    the iris is the highest-contrast thing on a face. Otherwise the midpoint of
    each eye's corners, which sits within a couple of millimetres of it.
    """
    lm = np.asarray(landmarks_px, dtype=np.float64)
    if len(lm) > IRIS_LEFT:
        return np.stack([lm[IRIS_RIGHT, :2], lm[IRIS_LEFT, :2]])
    return np.stack([lm[list(EYE_CORNERS_RIGHT), :2].mean(axis=0),
                     lm[list(EYE_CORNERS_LEFT), :2].mean(axis=0)])


def triangulate_point(uv_left, uv_right, intr, baseline: float,
                      max_row_error: float = 8.0) -> Optional[np.ndarray]:
    """One point seen in both rectified views, or None if they disagree.

    Rectification puts a point on the same row in both images, so a row
    disagreement means the two pixels are not the same point; and a point in
    front of the camera is always further right in the left image.
    """
    fx, fy, cx, cy = intr
    disparity = float(uv_left[0] - uv_right[0])
    if abs(float(uv_left[1] - uv_right[1])) > max_row_error or disparity < 1.0:
        return None
    depth = fx * baseline / disparity
    return np.array([(uv_left[0] - cx) * depth / fx,
                     -(uv_left[1] - cy) * depth / fy,
                     -depth])


def head_from_views(face_left_px, face_right_px, intr, baseline: float,
                    image_height: Optional[float] = None) -> HeadFix:
    """The eye point from one face's landmarks in each view.

    Stereo or nothing. One view alone can only guess depth from how big the
    face looks, and a guessed eye is worse than a held one: the projection is
    drawn FROM this point, so an eye that is confidently 10 cm wrong swings the
    whole picture, where an eye that is a few frames old just lags.
    """
    if face_left_px is None or face_right_px is None:
        return HeadFix(False, "no face in the left view" if face_left_px is None
                       else "no face in the right view")
    rows = 8.0 if image_height is None else max(6.0, 0.012 * float(image_height))
    left, right = eye_pixels(face_left_px), eye_pixels(face_right_px)
    eyes = [triangulate_point(left[k], right[k], intr, baseline, rows) for k in (0, 1)]
    if eyes[0] is None or eyes[1] is None:
        return HeadFix(False, "the two views do not agree on where the eyes are")
    eyes = np.stack(eyes)
    ipd = float(np.linalg.norm(eyes[0] - eyes[1]))
    if not IPD_RANGE[0] < ipd < IPD_RANGE[1]:
        return HeadFix(False, f"eyes {ipd * 100:.1f} cm apart: not one face", ipd=ipd)
    return HeadFix(True, "stereo", eye=eyes.mean(axis=0), eyes=eyes, ipd=ipd)
