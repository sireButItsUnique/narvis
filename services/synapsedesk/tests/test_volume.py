"""The rig, the working volume, and hands inside it."""
import contextlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from laptop_hand_tracking.volume_hands import (VolumeHands, PINCH_CLOSE_CM, PINCH_OPEN_CM,
                                               SETTLE_FRAMES, SETTLE_MS)
from laptop_hand_tracking.volume_simulator import packet as sim_packet
from synapsedesk.contracts import (DEFAULT_HAND_FRAME, DEFAULT_RIG, DEFAULT_VOLUME, register_point,
                                   validate_eye, validate_hand_frame, validate_hands, validate_rig)
from synapsedesk.server import Server
from synapsedesk.state import State

VOL = dict(DEFAULT_VOLUME)


@contextlib.contextmanager
def own_server():
    """A server of one's own, for tests that consume a shared bounded resource."""
    with tempfile.TemporaryDirectory() as tmp:
        state = State(tmp)
        server = Server(0, state)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        thread.start()
        try:
            yield server.server_port, state
        finally:
            state.stop.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def open_stream(port):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    conn.request('GET', '/events')
    response = conn.getresponse()
    body = response.read() if response.status != 200 else b''
    return response.status, body, conn


def hand(thumb, index, label="right"):
    return dict(label=label, thumb_tip=list(thumb), index_tip=list(index))


def frame(hands, age_ms=0.0, simulated=False):
    return dict(version=1, age_ms=age_ms, simulated=simulated, hands=hands)


class HandFrameTests(unittest.TestCase):
    """The tracker keeps its own coordinates; the service is told once how to read them."""

    def test_identity_frame_is_already_rig_centimetres(self):
        self.assertEqual(register_point([1, 2, 3], DEFAULT_HAND_FRAME), [1, 2, 3])

    def test_units_axes_and_offset_compose_in_that_order(self):
        f = validate_hand_frame(dict(version=1, units="m", axes=["x", "y", "-z"], offset=[0, -13, 0]))
        self.assertEqual(register_point([0.025, 0.01, 0.03], f), [2.5, -12.0, -3.0])
        swapped = validate_hand_frame(dict(version=1, units="cm", axes=["-z", "x", "y"]))
        self.assertEqual(register_point([1, 2, 3], swapped), [-3, 1, 2])
        self.assertEqual(register_point([10, 0, 0], validate_hand_frame(dict(version=1, units="mm"))), [1, 0, 0])

    def test_a_frame_that_cannot_be_a_frame_is_refused(self):
        for bad in (dict(version=2), dict(version=1, units="furlongs"), dict(version=1, axes=["x", "x", "z"]),
                    dict(version=1, axes=["x", "y"]), dict(version=1, scale=[0, 1, 1]),
                    dict(version=1, offset=[0, 0, "far"])):
            with self.assertRaises(ValueError):
                validate_hand_frame(bad)

    def test_an_uncalibrated_tracker_is_told_so_rather_than_dropped_off_the_desk(self):
        with self.assertRaises(ValueError) as error:
            validate_hands(frame([hand([5000, 0, 0], [5000, 0, 0])]))
        self.assertIn("hand frame", str(error.exception))


class HandPacketTests(unittest.TestCase):
    def test_two_fingertips_are_enough(self):
        result = validate_hands(frame([hand([1, 2, 3], [1.4, 2, 3])]))
        self.assertEqual(len(result["hands"][0]["landmarks_cm"]), 21)
        self.assertEqual(result["hands"][0]["landmarks_cm"][4], [1, 2, 3])
        self.assertEqual(result["hands"][0]["landmarks_cm"][8], [1.4, 2, 3])

    def test_full_mediapipe_landmarks_are_accepted_unchanged(self):
        points = [[i * .1, -13, 0] for i in range(21)]
        result = validate_hands(frame([dict(label="left", landmarks=points)]))
        self.assertEqual(result["hands"][0]["landmarks_cm"][20], [2.0, -13, 0])

    def test_upstream_pinch_is_not_accepted_at_any_spelling(self):
        # The service derives pinch. A tracker claiming it must not be able to change what the desk does.
        result = validate_hands(frame([dict(label="right", pinch=True, pinch_strength=1.0,
                                            thumb_tip=[0, -13, 0], index_tip=[9, -13, 0])]))
        self.assertNotIn("pinch", result["hands"][0])

    def test_malformed_packets_are_refused(self):
        for bad in (dict(version=2, age_ms=0, hands=[]),
                    dict(version=1, age_ms=-1, hands=[]),
                    dict(version=1, age_ms=0, hands="two"),
                    dict(version=1, age_ms=0, hands=[{}, {}, {}]),
                    frame([dict(label="third", thumb_tip=[0, 0, 0], index_tip=[0, 0, 0])]),
                    frame([dict(label="right", landmarks=[[0, 0, 0]] * 5)]),
                    frame([dict(label="right", thumb_tip=[0, 0], index_tip=[0, 0, 0])])):
            with self.assertRaises(ValueError):
                validate_hands(bad)


class VolumeGateTests(unittest.TestCase):
    """Same discipline as the flat panel, in centimetres."""

    def gate(self):
        g = VolumeHands(VOL)
        g.set_volume(VOL, [0., -13., 0.])
        return g

    def test_pinch_needs_settling_then_holds_with_hysteresis(self):
        g = self.gate()
        closed = [0, -13, 0]
        # Settling is a DURATION: three frames arriving in 20 ms is a tracker having a fast moment, not a
        # hand that has held still, so it must not arm yet.
        for i in range(SETTLE_FRAMES):
            snap = g.ingest(frame([hand(closed, closed)]), now=10 + i * .01)
            self.assertFalse(snap["hands"][0]["pinch"], "must not grab before SETTLE_MS has passed")
        snap = g.ingest(frame([hand(closed, closed)]), now=10 + SETTLE_MS / 1000 + .02)
        self.assertTrue(snap["hands"][0]["pinch"])
        # Between the two thresholds the pinch HOLDS rather than chattering.
        between = [(PINCH_CLOSE_CM + PINCH_OPEN_CM) / 2, -13, 0]
        self.assertTrue(g.ingest(frame([hand([0, -13, 0], between)]), now=10.13)["hands"][0]["pinch"])
        beyond = [PINCH_OPEN_CM + .5, -13, 0]
        self.assertFalse(g.ingest(frame([hand([0, -13, 0], beyond)]), now=10.16)["hands"][0]["pinch"])

    def test_a_silence_disarms_instead_of_resuming_mid_grab(self):
        g = self.gate()
        closed = [0, -13, 0]
        for i in range(6):
            g.ingest(frame([hand(closed, closed)]), now=10 + i * .04)
        self.assertTrue(g.snapshot(now=10.22)["enabled"])
        self.assertFalse(g.snapshot(now=11)["enabled"], "a stale hand must not keep its grip")
        again = g.ingest(frame([hand(closed, closed)]), now=11.01)
        self.assertEqual(again["reason"], "acquiring")
        self.assertFalse(again["hands"][0]["pinch"])

    def test_two_unlabelled_hands_do_not_collide(self):
        """The contract defaults a missing label to "unknown" and permits two of them.

        Every per-hand dict here was keyed by that label, so the second unlabelled hand overwrote the
        first: a pinching hand's state was replaced by an open one's, and two-handed gestures could never
        arm for any tracker that does not label its hands.
        """
        g = self.gate()
        closed, open_ = [-5, -13, 0], [12, -13, 0]
        packet = dict(version=1, age_ms=0, simulated=True, hands=[
            dict(thumb_tip=closed, index_tip=closed),        # pinching
            dict(thumb_tip=[5, -13, 0], index_tip=open_)])   # open
        for i in range(6):
            snap = g.ingest(packet, now=10 + i * .04)
        labels = [h["label"] for h in snap["hands"]]
        self.assertEqual(sorted(labels), ["left", "right"], "two hands must get two slots")
        self.assertTrue(snap["labels_inferred"], "and it must admit the labels were inferred")
        pinches = {h["label"]: h["pinch"] for h in snap["hands"]}
        self.assertTrue(pinches["left"], "the pinching hand is the left one, by x")
        self.assertFalse(pinches["right"], "and the open one must not inherit its state")

    def test_explicit_labels_are_believed_and_not_reordered(self):
        g = self.gate()
        packet = dict(version=1, age_ms=0, simulated=True, hands=[
            dict(label="left", thumb_tip=[6, -13, 0], index_tip=[6, -13, 0]),
            dict(label="right", thumb_tip=[-6, -13, 0], index_tip=[-6, -13, 0])])
        for i in range(6):
            snap = g.ingest(packet, now=10 + i * .04)
        self.assertFalse(snap["labels_inferred"])
        self.assertEqual([h["label"] for h in snap["hands"]], ["left", "right"],
                         "a tracker that labels its hands is believed, even if they have crossed")

    def test_the_cursor_is_the_midpoint_not_the_index_tip(self):
        """Closing a pinch swings the index a centimetre toward the thumb.

        An index-tip cursor therefore lurches sideways at the exact moment a gesture starts, which is the
        moment it must not move. The midpoint of the two barely shifts.
        """
        g = self.gate()
        open_hand = hand([-3, -13, 0], [1, -13, 0])
        snap = g.ingest(frame([open_hand]), now=10)
        self.assertEqual(snap["hands"][0]["anchor_cm"], [-1, -13, 0])
        # Now the fingers close onto the thumb: the index moved 4 cm, the anchor only 2.
        closed = hand([-3, -13, 0], [-3, -13, 0])
        snap = g.ingest(frame([closed]), now=10.04)
        self.assertEqual(snap["hands"][0]["anchor_cm"], [-3, -13, 0])
        self.assertEqual(snap["hands"][0]["index_tip_cm"], [-3, -13, 0])

    def test_a_hand_outside_the_slab_is_seen_but_disarmed(self):
        g = self.gate()
        far = [VOL["width_cm"] * 3, -13, 0]
        snap = g.ingest(frame([hand(far, far)]), now=10)
        self.assertEqual(snap["reason"], "outside_volume")
        self.assertFalse(snap["enabled"])

    def test_no_hands_and_stale_frames_are_distinguished(self):
        g = self.gate()
        self.assertEqual(g.ingest(frame([]), now=10)["reason"], "no_hands")
        self.assertEqual(g.ingest(frame([hand([0, -13, 0], [0, -13, 0])], age_ms=400), now=10.1)["reason"],
                         "stale")

    def test_the_simulated_hand_actually_opens_again(self):
        """An open pose inside the release threshold latches the first pinch forever.

        That bug is invisible in a screenshot — the hand looks open, the tracker looks healthy — and every
        gesture after it lands on whatever the first one grabbed. It is cheap to assert and impossible to
        spot by eye, so it is asserted.
        """
        import math
        opened = sim_packet(0.5, VOL)["hands"][0]["landmarks_cm"]
        closed = sim_packet(2.5, VOL)["hands"][0]["landmarks_cm"]
        self.assertLess(math.dist(closed[4], closed[8]), PINCH_CLOSE_CM)
        self.assertGreater(math.dist(opened[4], opened[8]), PINCH_OPEN_CM,
                           "the open hand must clear the release threshold, not merely look open")

    def test_a_pinch_that_starts_on_nothing_releases_on_its_own(self):
        g = self.gate()
        # Pinch, hold, then open: the gate must report the release, not stay latched.
        for i in range(6):
            g.ingest(sim_packet(2.5, VOL), now=10 + i * .04)
        self.assertTrue(g.snapshot(now=10.22)["hands"][0]["pinch"])
        for i in range(6):
            snap = g.ingest(sim_packet(0.5, VOL), now=10.25 + i * .04)
        self.assertFalse(snap["hands"][0]["pinch"], "opening the hand must end the pinch")

    def test_the_simulator_drives_the_gate_it_will_face(self):
        g = self.gate()
        for i in range(5):
            snap = g.ingest(sim_packet(2.5, VOL), now=10 + i * .03)   # inside the pinch window
        self.assertTrue(snap["enabled"])
        self.assertTrue(snap["hands"][0]["pinch"])
        self.assertTrue(snap["simulated"])
        self.assertEqual(g.ingest(sim_packet(2.5, VOL, fault="lost"), now=10.2)["reason"], "no_hands")


class RigConfigTests(unittest.TestCase):
    def test_rig_round_trips_and_bounds_every_measurement(self):
        self.assertEqual(validate_rig(DEFAULT_RIG)["panel_diagonal_in"], 27.0)
        for bad in (dict(DEFAULT_RIG, panel_diagonal_in=0), dict(DEFAULT_RIG, tilt_deg=91),
                    dict(DEFAULT_RIG, sheet_width_cm=1e6), dict(DEFAULT_RIG, anchor_drop_cm=0),
                    dict(version=2)):
            with self.assertRaises(ValueError):
                validate_rig(bad)

    def test_rig_and_hand_frame_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = State(tmp)
            first.set_rig(dict(DEFAULT_RIG, panel_diagonal_in=32.0, anchor_drop_cm=11.0))
            first.set_hand_frame(dict(version=1, units="m", axes=["x", "y", "-z"], offset=[0, -11, 0]))
            first.store.db.close()
            second = State(tmp)
            self.assertEqual(second.rig["panel_diagonal_in"], 32.0)
            self.assertEqual(second.hand_frame["units"], "m")
            # The reach test has to follow the anchor, or hands land outside a volume that moved.
            self.assertEqual(second.hands.anchor, [0., -11.0, 0.])

    def test_eye_packets_must_already_be_registered(self):
        good = dict(version=1, frame="rig_cm", position_cm=[0, 40, 40], age_ms=5, simulated=False)
        self.assertEqual(validate_eye(good)["position_cm"], [0, 40, 40])
        for bad in (dict(good, frame="camera"), dict(good, position_cm=[0, 40]),
                    dict(good, position_cm=[0, 40, 1e6]), dict(good, simulated="yes"), dict(good, version=2)):
            with self.assertRaises(ValueError):
                validate_eye(bad)


class VolumeHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.state = State(cls.temp.name)
        cls.server = Server(0, cls.state)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.state.stop.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def get(self, path):
        with urlopen(self.url + path, timeout=5) as response:
            return json.load(response)

    def post(self, path, value):
        request = Request(self.url + path, json.dumps(value).encode(),
                          {'Content-Type': 'application/json', 'X-Synapse-Token': self.state.token})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_the_whole_seam_a_tracker_has_to_implement(self):
        # One call to say what your numbers mean...
        self.post('/api/hand-frame', dict(version=1, units="m", axes=["x", "y", "-z"], offset=[0, -13, 0]))
        self.assertEqual(self.get('/api/hand-frame')['units'], 'm')
        # ...then post raw tracker numbers, at whatever rate you track at.
        for _ in range(8):
            self.post('/api/hands', frame([hand([0.02, 0.01, 0.03], [0.025, 0.01, 0.03])], age_ms=5))
            time.sleep(.02)
        state = self.get('/api/state')['hands']
        self.assertTrue(state['enabled'])
        got = state['hands'][0]
        self.assertEqual([round(v, 2) for v in got['index_tip_cm']], [2.5, -12.0, -3.0])
        self.assertTrue(got['pinch'], 'fingertips 0.5 cm apart is a pinch')
        self.assertTrue(got['inside'])

    def test_an_uncalibrated_tracker_gets_told_which_knob_to_turn(self):
        self.post('/api/hand-frame', dict(DEFAULT_HAND_FRAME))
        with self.assertRaises(HTTPError) as error:
            self.post('/api/hands', frame([hand([5000, 0, 0], [5000, 0, 0])]))
        self.assertEqual(error.exception.code, 400)
        self.assertIn('hand frame', json.loads(error.exception.read())['error'])

    def test_eye_and_hands_appear_in_the_stream_the_hologram_reads(self):
        self.post('/api/eye', dict(version=1, frame="rig_cm", position_cm=[0, 42, 44],
                                   age_ms=5, simulated=True))
        state = self.get('/api/state')
        self.assertEqual(state['eye']['position_cm'], [0, 42, 44])
        self.assertGreaterEqual(state['eye']['age_ms'], 5)
        for key in ('rig', 'volume', 'hands', 'eye', 'view'):
            self.assertIn(key, state, f'{key} must reach the hologram over the existing stream')

    def test_rig_and_volume_endpoints_validate(self):
        self.assertEqual(self.post('/api/rig', dict(DEFAULT_RIG, tilt_deg=35.0))['tilt_deg'], 35.0)
        for path, bad in (('/api/rig', dict(DEFAULT_RIG, tilt_deg=120)),
                          ('/api/volume', dict(version=1, width_cm=0, depth_cm=1, height_cm=1)),
                          ('/api/hand-frame', dict(version=1, axes=['x', 'x', 'z'])),
                          ('/api/eye', dict(version=1, frame="camera", position_cm=[0, 0, 0],
                                            age_ms=0, simulated=False))):
            with self.assertRaises(HTTPError) as error:
                self.post(path, bad)
            self.assertEqual(error.exception.code, 400, path)

    def test_the_three_rig_views_can_all_hold_a_stream_at_once(self):
        """Editor, projector display and hologram is three streams before anything has gone wrong.

        The cap was four, and a browser that navigates away can hold its slot until the kernel notices,
        so the fourth client was refused and — because nothing surfaced the refusal — simply looked frozen.

        Its own server: stream slots are a shared, slow-to-release resource, so a test that counts them
        cannot share one with a test that deliberately exhausts them.
        """
        with own_server() as (port, _):
            held = []
            try:
                for i in range(3):
                    status, _body, conn = open_stream(port)
                    self.assertEqual(status, 200, f'stream {i + 1} of 3 was refused')
                    held.append(conn)
            finally:
                for conn in held:
                    conn.close()

    def test_a_refused_stream_says_what_to_do_about_it(self):
        with own_server() as (port, _):
            held, refused = [], None
            try:
                for _ in range(12):
                    status, body, conn = open_stream(port)
                    if status == 503:
                        refused = json.loads(body)
                        break
                    held.append(conn)
                self.assertIsNotNone(refused, 'the cap must eventually refuse rather than accept forever')
                self.assertIn('close a browser tab', refused['error'],
                              'a refusal has to tell you what to do about it')
            finally:
                for conn in held:
                    conn.close()

    def test_demo_mode_refuses_a_real_tracker(self):
        with tempfile.TemporaryDirectory() as tmp:
            demo = State(tmp, demo=True)
            server = Server(0, demo)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
            thread.start()
            try:
                request = Request(f'http://127.0.0.1:{server.server_port}/api/hands',
                                  json.dumps(frame([hand([0, -13, 0], [0, -13, 0])])).encode(),
                                  {'Content-Type': 'application/json', 'X-Synapse-Token': demo.token})
                with self.assertRaises(HTTPError) as error:
                    urlopen(request, timeout=5)
                self.assertEqual(error.exception.code, 400)
                self.assertIn('demo mode', json.loads(error.exception.read())['error'])
            finally:
                demo.stop.set(); server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
