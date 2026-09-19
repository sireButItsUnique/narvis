"""py -m unittest discover handmouse   (from the holomodel folder). Synthetic hands, no camera, no real mouse."""
import unittest

from gestures import Config, HandMouse

W, H = 640, 480          # camera frame
SW, SH = 1920, 1080      # screen
OPEN = [(0, 0), (-.35, -.2), (-.55, -.4), (-.7, -.6), (-.8, -.8),        # wrist, thumb
        (-.25, -.9), (-.28, -1.3), (-.3, -1.55), (-.32, -1.8),             # index
        (0, -1.0), (0, -1.45), (0, -1.75), (0, -2.0),                     # middle
        (.22, -.92), (.25, -1.3), (.27, -1.55), (.28, -1.75),             # ring
        (.42, -.8), (.48, -1.05), (.52, -1.25), (.55, -1.4)]              # pinky
PALM_OFFSET = (sum(OPEN[i][0] for i in (0, 5, 9, 13, 17)) / 5, sum(OPEN[i][1] for i in (0, 5, 9, 13, 17)) / 5)


def hand(u, v, pose='open', size=80):
    """A hand whose palm centre sits at (u, v) as fractions of the camera frame."""
    pts = [list(p) for p in OPEN]
    if pose in ('index', 'middle', 'ring'):
        tip = {'index': 8, 'middle': 12, 'ring': 16}[pose]
        pts[4] = [pts[tip][0] + .05, pts[tip][1]]
    elif pose == 'fist':
        for tip in (8, 12, 16, 20):
            pts[tip] = [pts[tip][0] * .5, -.5]
    cx, cy = u * W - PALM_OFFSET[0] * size, v * H - PALM_OFFSET[1] * size
    return [(cx + x * size, cy + y * size, 0.0) for x, y in pts]


class HandMouseTest(unittest.TestCase):
    def setUp(self):
        self.cfg = Config()
        self.hm = HandMouse(self.cfg, SW, SH)
        self.t = 0.0

    def step(self, right=None, left=None, dt=1 / 30):
        self.t += dt
        return self.hm.update({'Right': right, 'Left': left}, self.t, W, H)

    def box_centre(self):
        x0, x1, y0, y1 = self.cfg.box
        return (x0 + x1) / 2, (y0 + y1) / 2

    def test_palm_in_the_middle_of_the_box_puts_the_cursor_mid_screen(self):
        u, v = self.box_centre()
        out = self.step(right=hand(u, v))
        self.assertEqual(out[0][0], 'move')
        self.assertAlmostEqual(out[0][1], SW / 2, delta=3)
        self.assertAlmostEqual(out[0][2], SH / 2, delta=3)

    def test_moving_the_hand_right_moves_the_cursor_right(self):
        u, v = self.box_centre()
        a = self.step(right=hand(u, v))[0][1]
        for _ in range(10):
            last = self.step(right=hand(u + 0.1, v))
        self.assertGreater(last[0][1], a + 200)

    def test_pinch_is_a_left_click_and_drag(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        out = self.step(right=hand(u, v, 'index'))
        self.assertIn(('down', 'left'), out)
        self.assertEqual(self.step(right=hand(u, v, 'index')).count(('down', 'left')), 0, 'no repeat presses while held')
        for _ in range(15):   # past the click freeze, the cursor drags
            out = self.step(right=hand(u + 0.1, v, 'index'))
        self.assertEqual(out[0][0], 'move')
        self.assertIn('left', self.hm.buttons)
        self.assertIn(('up', 'left'), self.step(right=hand(u + 0.1, v)))

    def test_cursor_holds_still_as_the_pinch_starts(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        out = self.step(right=hand(u + 0.05, v, 'index'))   # pinching tugs the hand a little
        self.assertNotIn('move', [a[0] for a in out], 'the click lands where you were pointing')

    def test_middle_pinch_is_a_right_click(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        self.assertIn(('down', 'right'), self.step(right=hand(u, v, 'middle')))
        self.assertIn(('up', 'right'), self.step(right=hand(u, v)))

    def test_fist_pauses_and_lets_go(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        self.step(right=hand(u, v, 'index'))
        out = self.step(right=hand(u + 0.2, v, 'fist'))
        self.assertIn(('up', 'left'), out)
        self.assertNotIn('move', [a[0] for a in out])
        self.assertEqual(self.hm.state, 'paused (fist)')

    def test_losing_the_hand_releases_the_button(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        self.step(right=hand(u, v, 'index'))
        self.step(right=None, dt=0.1)
        self.assertIn('left', self.hm.buttons, 'a brief dropout keeps the drag')
        self.assertIn(('up', 'left'), self.step(right=None, dt=0.3))

    def test_other_hand_pinch_drag_is_a_middle_drag(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v), left=hand(0.3, 0.4))
        out = self.step(right=hand(u, v), left=hand(0.3, 0.4, 'index'))
        self.assertIn(('down', 'middle'), out)
        start = self.hm.cursor
        out = self.step(right=hand(u, v), left=hand(0.35, 0.4, 'index'))
        self.assertGreater(self.hm.cursor[0], start[0] + 50, 'cursor follows the other hand while orbiting')
        self.assertIn(('up', 'middle'), self.step(right=hand(u, v), left=hand(0.35, 0.4)))

    def test_other_hand_middle_pinch_is_shift_middle_drag(self):
        u, v = self.box_centre()
        out = self.step(right=hand(u, v), left=hand(0.3, 0.4, 'middle'))
        self.assertIn(('key_down', 'shift'), out)
        self.assertIn(('down', 'middle'), out)
        out = self.step(right=hand(u, v), left=hand(0.3, 0.4))
        self.assertIn(('up', 'middle'), out)
        self.assertIn(('key_up', 'shift'), out)

    def test_other_hand_ring_pinch_scrolls(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v), left=hand(0.3, 0.5, 'ring'))
        out = self.step(right=hand(u, v), left=hand(0.3, 0.4, 'ring'))   # hand up
        notches = sum(a[1] for a in out if a[0] == 'wheel')
        self.assertGreater(notches, 0, 'up scrolls up (zoom in)')

    def test_ending_an_orbit_lets_go_before_the_cursor_jumps_back(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v), left=hand(0.3, 0.4, 'index'))
        for _ in range(5):
            self.step(right=hand(u, v), left=hand(0.4, 0.4, 'index'))
        out = self.step(right=hand(u, v), left=hand(0.4, 0.4))   # other hand opens
        self.assertLess(out.index(('up', 'middle')), [a[0] for a in out].index('move'),
                        'middle must be released before the cursor returns, or Blender undoes the orbit')

    def test_other_hand_orbits_even_outside_the_cursor_box(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v), left=hand(0.10, 0.4, 'index'))   # left of the box
        start = self.hm.cursor
        for _ in range(10):
            self.step(right=hand(u, v), left=hand(0.20, 0.4, 'index'))
        self.assertGreater(self.hm.cursor[0], start[0] + 50)

    def test_a_half_closed_hand_after_a_fist_doesnt_re_press(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v))
        self.step(right=hand(u, v, 'index'))
        self.step(right=hand(u, v, 'fist'))
        half = hand(u, v, 'index')
        half[4] = (half[4][0] + 25, half[4][1], 0.0)   # thumb near but not touching: between the on and off thresholds
        out = self.step(right=half)
        self.assertNotIn(('down', 'left'), out)

    def test_release_all_lets_go_of_everything(self):
        u, v = self.box_centre()
        self.step(right=hand(u, v, 'index'), left=hand(0.3, 0.4, 'middle'))
        out = self.hm.release_all()
        self.assertEqual(set(out), {('up', 'left'), ('up', 'middle'), ('key_up', 'shift')})
        self.assertFalse(self.hm.buttons or self.hm.keys)


if __name__ == '__main__':
    unittest.main()
