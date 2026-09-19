"""Hand landmarks -> mouse actions. Pure logic (no camera, no Windows calls) so it can be tested.

Main hand (default: right)
  move hand             cursor follows the middle of your palm (not a fingertip, so pinching doesn't jerk it)
  thumb + index pinch   left button: hold to drag, release to let go
  thumb + middle pinch  right button
  fist                  pause: the cursor stops and buttons let go, so you can reposition like lifting a mouse
Other hand
  thumb + index pinch   middle-button drag  (Blender: orbit the view)
  thumb + middle pinch  shift + middle drag (Blender: pan)
  thumb + ring pinch    move up/down to scroll (Blender: zoom)

Landmarks are the 21 MediaPipe hand points in pixels of a mirrored camera image (x grows to the user's right).
"""
from dataclasses import dataclass, field
import math

WRIST, THUMB_TIP, INDEX_MCP, INDEX_TIP, MIDDLE_MCP, MIDDLE_TIP, RING_MCP, RING_TIP, PINKY_MCP, PINKY_TIP = 0, 4, 5, 8, 9, 12, 13, 16, 17, 20


@dataclass
class Config:
    main_hand: str = 'Right'
    # the part of the camera image (fractions) that maps onto the whole screen; smaller = less arm movement
    box: tuple = (0.22, 0.78, 0.18, 0.70)   # x0, x1, y0, y1
    pinch_on: float = 0.28       # thumb-to-fingertip distance / palm length: closer than this = pinched
    pinch_off: float = 0.45      # ... and must open past this to let go (no flicker)
    click_freeze: float = 0.15   # s the cursor holds still when a pinch starts, so the click lands where you aimed
    lost_release: float = 0.25   # s without seeing a hand before its buttons are let go
    drag_gain: float = 1.6       # other-hand drags: screen widths per camera-box width
    scroll_step: float = 0.035   # other-hand ring pinch: box heights per wheel notch
    smooth_min_cutoff: float = 1.0   # 1 Euro filter: lower = steadier when still
    smooth_beta: float = 4.0         # ... higher = less lag when moving fast


class OneEuro:
    """1 Euro filter (Casiez et al., CHI 2012): steady when slow, responsive when fast."""

    def __init__(self, min_cutoff, beta, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = self.dx = self.t = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def reset(self):
        self.x = self.dx = self.t = None

    def __call__(self, x, t):
        if self.x is None:
            self.x, self.dx, self.t = x, 0.0, t
            return x
        dt = max(1e-3, t - self.t)
        self.t = t
        self.dx += self._alpha(self.d_cutoff, dt) * ((x - self.x) / dt - self.dx)
        self.x += self._alpha(self.min_cutoff + self.beta * abs(self.dx), dt) * (x - self.x)
        return self.x


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def palm_center(lm):
    pts = [lm[i] for i in (WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)]
    return sum(p[0] for p in pts) / 5, sum(p[1] for p in pts) / 5


def palm_length(lm):
    return max(1e-6, _dist(lm[WRIST], lm[MIDDLE_MCP]))


def pinch_ratio(lm, tip):
    return _dist(lm[THUMB_TIP], lm[tip]) / palm_length(lm)


def is_fist(lm):
    """All four fingertips curled in closer to the wrist than their knuckles."""
    return all(_dist(lm[tip], lm[WRIST]) < _dist(lm[mcp], lm[WRIST]) * 1.05
               for tip, mcp in ((INDEX_TIP, INDEX_MCP), (MIDDLE_TIP, MIDDLE_MCP), (RING_TIP, RING_MCP), (PINKY_TIP, PINKY_MCP)))


class Pinch:
    """Hysteresis: turns on below pinch_on, off above pinch_off."""

    def __init__(self, cfg):
        self.cfg, self.on = cfg, False

    def update(self, ratio):
        if not self.on and ratio < self.cfg.pinch_on:
            self.on = True
        elif self.on and ratio > self.cfg.pinch_off:
            self.on = False
        return self.on


@dataclass
class HandState:
    seen_at: float = -1e9
    index: Pinch = None
    middle: Pinch = None
    ring: Pinch = None


class HandMouse:
    """Feed it the hands seen in each camera frame; it returns mouse actions:
    ('move', x, y) · ('down', button) · ('up', button) · ('key_down', key) · ('key_up', key) · ('wheel', notches)
    """

    def __init__(self, cfg: Config, screen_w: int, screen_h: int):
        self.cfg, self.w, self.h = cfg, screen_w, screen_h
        self.fx = OneEuro(cfg.smooth_min_cutoff, cfg.smooth_beta)
        self.fy = OneEuro(cfg.smooth_min_cutoff, cfg.smooth_beta)
        self.ofx = OneEuro(cfg.smooth_min_cutoff, cfg.smooth_beta)   # the other hand, for steady orbits
        self.ofy = OneEuro(cfg.smooth_min_cutoff, cfg.smooth_beta)
        self.hands = {name: HandState(index=Pinch(cfg), middle=Pinch(cfg), ring=Pinch(cfg)) for name in ('Left', 'Right')}
        self.cursor = (screen_w / 2, screen_h / 2)
        self.buttons = set()      # buttons we're holding down
        self.keys = set()         # keys we're holding down
        self.freeze_until = 0.0
        self.paused = False
        self.aux = None           # other-hand drag: {'mode', 'anchor', 'cursor', 'scrolled'}
        self.state = 'waiting for your hand'

    @property
    def other_hand(self):
        return 'Left' if self.cfg.main_hand == 'Right' else 'Right'

    # ---- helpers that also record what we're holding, so everything can be let go ----
    def _press(self, out, button):
        if button not in self.buttons:
            self.buttons.add(button)
            out.append(('down', button))

    def _release(self, out, button):
        if button in self.buttons:
            self.buttons.discard(button)
            out.append(('up', button))

    def _key(self, out, key, down):
        if down and key not in self.keys:
            self.keys.add(key)
            out.append(('key_down', key))
        elif not down and key in self.keys:
            self.keys.discard(key)
            out.append(('key_up', key))

    def release_all(self):
        out = []
        for b in list(self.buttons):
            self._release(out, b)
        for k in list(self.keys):
            self._key(out, k, False)
        self.aux = None
        self._reset_pinches('Left'); self._reset_pinches('Right')
        self.ofx.reset(); self.ofy.reset()
        return out

    def _reset_pinches(self, name):
        """After a release that wasn't a normal un-pinch (hand lost, fist, pause), a half-closed hand must pinch
        again from scratch rather than re-pressing the moment it's seen."""
        hs = self.hands[name]
        hs.index.on = hs.middle.on = hs.ring.on = False

    def _to_screen(self, px, py, frame_w, frame_h, clamp=True):
        x0, x1, y0, y1 = self.cfg.box
        u, v = (px / frame_w - x0) / (x1 - x0), (py / frame_h - y0) / (y1 - y0)
        if clamp:
            u, v = min(1.0, max(0.0, u)), min(1.0, max(0.0, v))
        return u, v

    def _end_aux(self, out):
        if not self.aux:
            return
        if self.aux['mode'] in ('orbit', 'pan'):
            self._release(out, 'middle')
        if self.aux['mode'] == 'pan':
            self._key(out, 'shift', False)
        self.aux = None

    # ---- per frame ----
    def update(self, hands, t, frame_w, frame_h):
        """hands: {'Left': landmarks or None, 'Right': landmarks or None}"""
        out, cfg = [], self.cfg
        had_aux = self.aux is not None   # an orbit/pan was running when this frame began
        main, other = hands.get(cfg.main_hand), hands.get(self.other_hand)
        for name, lm in hands.items():
            if lm is not None:
                self.hands[name].seen_at = t

        # hands gone for a moment: let go of whatever they were holding
        if main is None and t - self.hands[cfg.main_hand].seen_at > cfg.lost_release:
            for b in ('left', 'right'):
                self._release(out, b)
            self._reset_pinches(cfg.main_hand)
            self.fx.reset(); self.fy.reset()
        if other is None and t - self.hands[self.other_hand].seen_at > cfg.lost_release:
            if self.aux:
                self._end_aux(out)
            self._reset_pinches(self.other_hand)
            self.ofx.reset(); self.ofy.reset()

        # ---- other hand: orbit / pan / scroll ----
        if other is not None:
            hs = self.hands[self.other_hand]
            idx, mid, ring = (hs.index.update(pinch_ratio(other, INDEX_TIP)),
                              hs.middle.update(pinch_ratio(other, MIDDLE_TIP)),
                              hs.ring.update(pinch_ratio(other, RING_TIP)))
            # drags are relative, so don't clamp to the cursor box (the other hand usually sits outside it)
            u, v = self._to_screen(*palm_center(other), frame_w, frame_h, clamp=False)
            u, v = self.ofx(u, t), self.ofy(v, t)
            mode = 'orbit' if idx else 'pan' if mid else 'scroll' if ring else None
            if self.aux and self.aux['mode'] != mode:
                self._end_aux(out)
            if mode and not self.aux:
                self.aux = {'mode': mode, 'anchor': (u, v), 'cursor': self.cursor, 'scrolled': 0}
                if mode == 'pan':
                    self._key(out, 'shift', True)
                if mode in ('orbit', 'pan'):
                    self._press(out, 'middle')
            if self.aux:
                du, dv = u - self.aux['anchor'][0], v - self.aux['anchor'][1]
                if self.aux['mode'] == 'scroll':
                    notches = int(-dv / cfg.scroll_step - self.aux['scrolled'])   # hand up = scroll up (zoom in)
                    if notches:
                        self.aux['scrolled'] += notches
                        out.append(('wheel', notches))
                else:
                    cx, cy = self.aux['cursor']
                    self.cursor = (min(self.w - 1, max(0, cx + du * cfg.drag_gain * self.w)),
                                   min(self.h - 1, max(0, cy + dv * cfg.drag_gain * self.h)))
                    out.append(('move', round(self.cursor[0]), round(self.cursor[1])))

        # ---- main hand: point, click, drag ----
        if main is None:
            self.state = 'orbit' if self.aux else 'waiting for your hand'
            return out
        hs = self.hands[cfg.main_hand]
        if is_fist(main):
            if not self.paused:
                for b in ('left', 'right'):
                    self._release(out, b)
                self._reset_pinches(cfg.main_hand)
            self.paused = True
            self.state = 'paused (fist)'
            return out
        if self.paused:   # coming out of a fist: start the smoothing fresh so the cursor doesn't glide
            self.paused = False
            self.fx.reset(); self.fy.reset()

        left = hs.index.update(pinch_ratio(main, INDEX_TIP))
        right = hs.middle.update(pinch_ratio(main, MIDDLE_TIP)) and not left
        u, v = self._to_screen(*palm_center(main), frame_w, frame_h)
        u, v = self.fx(u, t), self.fy(v, t)

        if left and 'left' not in self.buttons:
            self.freeze_until = t + cfg.click_freeze
            self._press(out, 'left')
        elif not left:
            self._release(out, 'left')
        if right and 'right' not in self.buttons:
            self.freeze_until = t + cfg.click_freeze
            self._press(out, 'right')
        elif not right:
            self._release(out, 'right')

        if not self.aux and t >= self.freeze_until:
            self.cursor = (u * (self.w - 1), v * (self.h - 1))
            move = ('move', round(self.cursor[0]), round(self.cursor[1]))
            if had_aux:
                out.append(move)      # an orbit/pan just ended: let go of middle/shift first, or the jump undoes it
            else:
                out.insert(0, move)   # otherwise move before any button change, so clicks land where you point
        self.state = ('orbit' if self.aux and self.aux['mode'] == 'orbit' else
                      'pan' if self.aux and self.aux['mode'] == 'pan' else
                      'scroll' if self.aux else
                      'drag (left)' if 'left' in self.buttons else 'right button' if 'right' in self.buttons else 'pointing')
        return out
