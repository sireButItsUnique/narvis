"""Hand mouse: your webcam turns your hand into the real Windows mouse, so any app (Blender!) can be driven by hand.

    py handmouse\\handmouse.py              (from the holomodel folder)
    py handmouse\\handmouse.py --left       left hand drives the cursor
    py handmouse\\handmouse.py --dry-run    show what it would do without touching the mouse

F8 (anywhere) or P in the preview window pauses and resumes. Esc in the preview window quits.
Gestures are listed in gestures.py and in the preview window.
"""
import argparse
import os
import sys
import time

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

import win32input
from gestures import Config, HandMouse, palm_center

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'models', 'hand_landmarker.task')
MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
WINDOW = 'Hand mouse'
BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
LEGEND = ['main hand: move = cursor, pinch = click/drag,', '  middle pinch = right click, fist = pause',
          'other hand: pinch-drag = orbit, middle = pan,', '  ring pinch up/down = zoom      F8 pause  Esc quit']


def ensure_model():
    if not os.path.exists(MODEL):
        import urllib.request
        os.makedirs(os.path.dirname(MODEL), exist_ok=True)
        print('Downloading the hand-tracking model (8 MB)...')
        tmp = MODEL + '.part'   # only a complete download gets the real name, so a broken one is retried next time
        try:
            urllib.request.urlretrieve(MODEL_URL, tmp)
            os.replace(tmp, MODEL)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)


def read_hands(result, w, h):
    """MediaPipe result -> {'Left': [(x, y, z) px...] or None, 'Right': ...}.
    The frame is mirrored, so MediaPipe's handedness labels match the user's real hands."""
    hands = {'Left': None, 'Right': None}
    found = []
    for lms, handed in zip(result.hand_landmarks, result.handedness):
        pts = [(p.x * w, p.y * h, p.z * w) for p in lms]
        found.append((handed[0].category_name, pts))
    if len(found) == 2 and found[0][0] == found[1][0]:   # both labelled the same: go by position instead
        found.sort(key=lambda f: palm_center(f[1])[0])
        found = [('Left', found[0][1]), ('Right', found[1][1])]
    for name, pts in found:
        hands[name] = pts
    return hands


def draw(frame, hands, hm, enabled, cfg, fps):
    h, w = frame.shape[:2]
    x0, x1, y0, y1 = cfg.box
    cv2.rectangle(frame, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (90, 90, 90), 1)
    for name, pts in hands.items():
        if pts is None:
            continue
        colour = (255, 208, 53) if name == cfg.main_hand else (155, 255, 124)
        for a, b in BONES:
            cv2.line(frame, (int(pts[a][0]), int(pts[a][1])), (int(pts[b][0]), int(pts[b][1])), colour, 2)
        cx, cy = palm_center(pts)
        cv2.circle(frame, (int(cx), int(cy)), 6, (62, 178, 255), -1)
    state = hm.state if enabled else 'PAUSED (F8 to resume)'
    cv2.rectangle(frame, (0, 0), (w, 30), (20, 12, 7), -1)
    cv2.putText(frame, f'{state}   {fps:.0f} fps', (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (62, 178, 255) if enabled else (80, 80, 255), 2)
    for i, line in enumerate(LEGEND):
        cv2.putText(frame, line, (8, h - 12 - (len(LEGEND) - 1 - i) * 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (230, 230, 230), 1)


def main():
    ap = argparse.ArgumentParser(description='Control the mouse with your hand.')
    ap.add_argument('--left', action='store_true', help='left hand drives the cursor')
    ap.add_argument('--camera', type=int, default=0, help='webcam number (default 0)')
    ap.add_argument('--dry-run', action='store_true', help="print mouse actions instead of doing them")
    args = ap.parse_args()

    ensure_model()
    cfg = Config(main_hand='Left' if args.left else 'Right')
    sw, sh = win32input.screen_size()
    hm = HandMouse(cfg, sw, sh)

    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_FPS, 30)
    if not cap.isOpened():
        sys.exit(f"Couldn't open webcam {args.camera}. Close other apps using it (the browser page?) or try --camera 1.")

    landmarker = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL), running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=0.6, min_hand_presence_confidence=0.6, min_tracking_confidence=0.5))

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, 400, 300)
    cv2.moveWindow(WINDOW, sw - 420, sh - 380)
    cv2.setWindowProperty(WINDOW, cv2.WND_PROP_TOPMOST, 1)

    act = print if args.dry_run else win32input.perform
    enabled, f8_was_down, t0, fps, last = True, False, time.perf_counter(), 0.0, time.perf_counter()
    fail_since = None
    print('Hand mouse running. F8 pauses, Esc (in the preview window) quits.')
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                # camera unplugged or blocked: let go of any held button (after the usual grace period),
                # and keep F8 and the preview window responsive
                now = time.perf_counter()
                fail_since = fail_since or now
                if now - fail_since > cfg.lost_release:
                    for a in hm.release_all():
                        act(a)
                    hm.state = 'no camera'
                f8 = win32input.key_is_down('f8')
                if f8 and not f8_was_down:
                    enabled = not enabled
                f8_was_down = f8
                key = cv2.waitKey(10) & 0xFF
                if key == 27 or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                    break
                continue
            fail_since = None
            frame = cv2.flip(frame, 1)   # mirror: move your hand right, the cursor goes right
            now = time.perf_counter()
            h, w = frame.shape[:2]
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), int((now - t0) * 1000))
            hands = read_hands(result, w, h)

            f8 = win32input.key_is_down('f8')
            if f8 and not f8_was_down:
                enabled = not enabled
            f8_was_down = f8
            if enabled:
                if not args.dry_run and not hm.aux:   # an orbit/pan starts from wherever the pointer really is
                    x, y = win32input.cursor_pos()
                    hm.cursor = (min(sw - 1, max(0, x)), min(sh - 1, max(0, y)))
                actions = hm.update(hands, now, w, h)
            else:
                actions = hm.release_all()
                hm.state = 'paused'
            for a in actions:
                act(a)

            fps = 0.9 * fps + 0.1 / max(1e-3, now - last)
            last = now
            draw(frame, hands, hm, enabled, cfg, fps)
            cv2.imshow(WINDOW, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == 27 or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if key in (ord('p'), ord('P')):
                enabled = not enabled
    finally:
        for a in hm.release_all():   # never leave a button stuck down
            act(a)
        cap.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
