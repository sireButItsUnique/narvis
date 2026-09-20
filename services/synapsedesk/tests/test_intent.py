"""What a spoken sentence is allowed to do."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from repo_triage_agent import intent as intents
from synapsedesk.server import Server
from synapsedesk.state import State
from synapsedesk.voice import ElevenLabs, VoiceError, VoiceOff, _multipart, _scrub, from_config

FIXTURE = Path(__file__).parent/'fixtures'/'messy_repo'


class GrammarTests(unittest.TestCase):
    """The deterministic half. It cannot invent, so it answers first."""

    def verb(self, said):
        parsed = intents.parse(said)
        return parsed["verb"] if parsed else None

    def test_the_things_people_say_to_a_workbench(self):
        for said, want in [
            ("go up", "ascend"), ("back", "ascend"), ("up a level", "ascend"), ("out", "ascend"),
            ("take me home", "root"), ("go to the top", "root"), ("all the way back", "root"),
            ("zoom in", "zoom"), ("zoom out", "zoom"), ("fit", "zoom"),
            ("what is this", "describe"), ("where am i", "describe"), ("describe this", "describe"),
            ("open the store", "navigate"), ("show me contracts", "navigate"), ("dive into tests", "navigate"),
            ("explain store", "explain"), ("tell me about rollback", "explain"),
            ("find elevenlabs", "search"), ("where is rollback", "search"),
            ("list tasks", "tasks"), ("cancel", "cancel"),
            ("implement a retry around the provider", "implement"),
            ("fix the flaky test", "implement"),
        ]:
            self.assertEqual(self.verb(said), want, f"{said!r} should be {want}")

    def test_go_up_is_not_read_as_go_to_up(self):
        # Order matters in the pattern list, and this is the collision that catches people out.
        self.assertEqual(self.verb("go up"), "ascend")
        self.assertEqual(self.verb("go out"), "ascend")
        self.assertEqual(self.verb("go to the store"), "navigate")

    def test_a_verb_with_nothing_to_act_on_is_not_an_instruction(self):
        self.assertIsNone(self.verb("open"))
        self.assertIsNone(self.verb("find"))
        self.assertIsNone(self.verb(""))
        self.assertIsNone(self.verb("   "))
        self.assertIsNone(self.verb("the weather in oslo"))

    def test_scoring_prefers_the_thing_that_was_actually_named(self):
        nodes = [dict(id="m", kind="module", label="synapsedesk/store.py"),
                 dict(id="c", kind="class", label="Store"),
                 dict(id="f", kind="function", label="Store.latest"),
                 dict(id="g", kind="function", label="Store.migrate_legacy_graph")]
        paths = {"m": "synapsedesk/store.py", "c": "synapsedesk/store.py",
                 "f": "synapsedesk/store.py", "g": "synapsedesk/store.py"}
        ranked = intents.resolve("store", nodes, paths)
        self.assertEqual(ranked[0]["node"]["id"], "c", "the class named Store beats its own methods")
        self.assertGreater(ranked[0]["score"], ranked[1]["score"])

    def test_a_symbol_is_not_found_by_the_name_of_its_file(self):
        """Every function in contracts.py used to score as well as contracts.py itself."""
        nodes = [dict(id="m", kind="module", label="synapsedesk/contracts.py"),
                 dict(id="n", kind="function", label="number")]
        paths = {"m": "synapsedesk/contracts.py", "n": "synapsedesk/contracts.py"}
        ranked = intents.resolve("contracts", nodes, paths)
        self.assertEqual(ranked[0]["node"]["id"], "m")
        self.assertTrue(len(ranked) == 1 or ranked[0]["score"] >= ranked[1]["score"] * 1.25)

    def test_one_letter_labels_cannot_near_match_a_real_word(self):
        """A node labelled "k" matched "pack", and the desk answered "which one: k, e, e?"."""
        nodes = [dict(id="a", kind="function", label="k"), dict(id="b", kind="function", label="e")]
        self.assertEqual(intents.resolve("pack level", nodes, {}), [])

    def test_folders_are_targets_even_though_the_graph_has_no_folder_nodes(self):
        paths = {"a": "repo_triage_agent/analyze.py", "b": "repo_triage_agent/intent.py",
                 "c": "tests/test_intent.py"}
        folders = {d["directory"] for d in intents.directories(paths)}
        self.assertEqual(folders, {"repo_triage_agent", "tests"})
        self.assertTrue(all(d["kind"] == "folder" for d in intents.directories(paths)))

    def test_a_model_intent_is_checked_before_it_is_believed(self):
        good = intents.validate_model_intent(dict(verb="navigate", argument="store", say="Opening."))
        self.assertEqual(good["source"], "model")
        for bad in (dict(verb="rm -rf", argument="", say=""), dict(verb="navigate", argument=1, say=""),
                    dict(verb="navigate", argument="x", say="y" * 700), "not an object"):
            with self.assertRaises(ValueError):
                intents.validate_model_intent(bad)


class GroundingTests(unittest.TestCase):
    """The half that touches the desk."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.state = State(cls.temp.name)
        cls.state.start_analysis(str(FIXTURE))
        cls.state.analysis.join(timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.state.stop.set()
        cls.temp.cleanup()

    def test_navigation_lands_on_something_that_exists(self):
        answer = self.state.ask("open repository")
        self.assertEqual(answer["verb"], "navigate")
        self.assertTrue(answer["trail"], "a navigation must produce a trail")
        self.assertIn("repository", answer["trail"][-1])

    def test_a_name_several_things_share_is_put_back_to_the_speaker(self):
        # This fixture has users.py, get_users and list_users. "users" names all three, and choosing one
        # would be a guess dressed as an answer.
        answer = self.state.ask("open users")
        self.assertTrue(answer.get("ambiguous"), f"expected a question, got {answer['say']!r}")
        self.assertEqual(answer["trail"], list(self.state.view), "nothing may move while it is unclear")
        self.assertGreaterEqual(len(answer["candidates"]), 2)

    def test_a_name_nothing_matches_is_refused_not_guessed(self):
        answer = self.state.ask("open the quantum flux capacitor")
        self.assertEqual(answer["trail"], [], "nothing may be opened")
        self.assertIn("nothing indexed", answer["say"].lower())

    def test_an_ambiguous_name_asks_instead_of_choosing(self):
        answer = self.state.ask("explain users")
        if answer.get("ambiguous"):
            self.assertIn("which one", answer["say"].lower())
            self.assertEqual(answer.get("trail"), list(self.state.view))
        else:
            self.assertTrue(answer.get("explain"), "an unambiguous explain must cite something")

    def test_explaining_cites_indexed_evidence_and_never_invents(self):
        node = next(n for n in self.state.graph["nodes"] if n["kind"] == "function")
        answer = self.state.ask(f"explain {node['label']}")
        if not answer.get("ambiguous"):
            self.assertIn("explain", answer)
            self.assertEqual(answer["explain"]["provenance"], "indexed_evidence")

    def test_the_spoken_loop_cannot_start_a_task(self):
        """implement writes into a working copy and runs that repository's test command.

        A microphone is not a good enough witness for that, so the verb only ever produces a proposal.
        """
        before = len(self.state.store.list_tasks())
        answer = self.state.ask("implement a retry around the provider")
        self.assertEqual(answer["verb"], "implement")
        self.assertTrue(answer["acts"])
        self.assertTrue(answer["needs_confirmation"])
        self.assertIn("proposal", answer)
        self.assertEqual(len(self.state.store.list_tasks()), before, "no task may have been created")

    def test_reading_verbs_do_run(self):
        for said in ("go up", "take me home", "zoom out", "what is this", "list tasks"):
            answer = self.state.ask(said)
            self.assertFalse(answer["needs_confirmation"], said)
            self.assertFalse(answer["acts"], said)
            self.assertTrue(answer["say"], f"{said} must say something")

    def test_an_empty_or_enormous_utterance_is_refused(self):
        for bad in ("", "   ", None, 7, "x" * 601):
            with self.assertRaises(ValueError):
                self.state.ask(bad)


class VoiceGateTests(unittest.TestCase):
    def test_voice_is_off_until_a_key_and_a_voice_are_given(self):
        import os
        os.environ.pop("SYNAPSEDESK_ELEVENLABS_API_KEY", None)
        off = from_config()
        self.assertIsInstance(off, VoiceOff)
        self.assertFalse(off.status()["live"])
        for call in (lambda: off.transcribe(b"x"), lambda: off.speak("hi"), off.voices):
            with self.assertRaises(VoiceError):
                call()
        try:
            os.environ["SYNAPSEDESK_ELEVENLABS_API_KEY"] = "test-key"
            self.assertFalse(from_config().status()["live"], "a key alone is not enough; pick a voice")
            self.assertIn("voice", from_config().status()["reason"])
            self.assertTrue(from_config("some-voice-id").status()["live"])
        finally:
            os.environ.pop("SYNAPSEDESK_ELEVENLABS_API_KEY", None)

    def test_a_disabled_voice_says_so_rather_than_looking_broken(self):
        self.assertIn("disabled", from_config(enabled=False).status()["reason"])

    def test_credentials_never_come_back_in_an_error(self):
        leaked = "upstream said sk_0123456789abcdef0123456789abcdef was invalid"
        self.assertNotIn("sk_0123456789abcdef0123456789abcdef", _scrub(leaked))
        self.assertIn("<redacted>", _scrub(leaked))

    def test_the_multipart_body_is_well_formed(self):
        body, boundary = _multipart({"model_id": "scribe_v1"}, {"file": ("a.webm", "audio/webm", b"OggS")})
        self.assertIn(b'name="model_id"', body)
        self.assertIn(b'filename="a.webm"', body)
        self.assertIn(b"OggS", body)
        self.assertTrue(body.endswith(f"--{boundary}--\r\n".encode()))

    def test_oversized_audio_is_refused_before_it_is_sent(self):
        import os
        os.environ["SYNAPSEDESK_ELEVENLABS_API_KEY"] = "test-key"
        try:
            with self.assertRaises(VoiceError) as error:
                ElevenLabs("voice").transcribe(b"x" * 2_000_001)
            self.assertIn("2 MB", str(error.exception))
            with self.assertRaises(VoiceError):
                ElevenLabs("voice").transcribe(b"")
            with self.assertRaises(VoiceError):
                ElevenLabs("").speak("hello")     # no voice chosen
        finally:
            os.environ.pop("SYNAPSEDESK_ELEVENLABS_API_KEY", None)


class AskHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.state = State(cls.temp.name)
        cls.server = Server(0, cls.state)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.state.start_analysis(str(FIXTURE))
        cls.state.analysis.join(timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.state.stop.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def post(self, path, value):
        request = Request(self.url + path, json.dumps(value).encode(),
                          {'Content-Type': 'application/json', 'X-Synapse-Token': self.state.token})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_ask_answers_over_http(self):
        answer = self.post('/api/agent/ask', {'utterance': 'take me home'})
        self.assertEqual(answer['verb'], 'root')
        self.assertEqual(answer['trail'], [])
        for bad in ({'utterance': ''}, {}, {'utterance': 'x' * 601}):
            with self.assertRaises(HTTPError) as error:
                self.post('/api/agent/ask', bad)
            self.assertEqual(error.exception.code, 400)

    def test_voice_status_is_honest_about_being_off(self):
        with urlopen(self.url + '/api/voice/status', timeout=5) as response:
            status = json.load(response)
        self.assertFalse(status['live'])
        self.assertTrue(status['reason'], 'an off switch must say what is missing')

    def test_speaking_and_listening_refuse_cleanly_while_voice_is_off(self):
        with self.assertRaises(HTTPError) as error:
            self.post('/api/voice/say', {'text': 'hello'})
        self.assertEqual(error.exception.code, 503, 'voice off is unavailable, not a bad request')
        request = Request(self.url + '/api/voice/listen', b'not-really-audio',
                          {'Content-Type': 'audio/webm', 'X-Synapse-Token': self.state.token})
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 503)

    def test_listening_bounds_its_input(self):
        for body, code in ((b'', 400), (b'x' * 2_000_001, 400)):
            request = Request(self.url + '/api/voice/listen', body,
                              {'Content-Type': 'audio/webm', 'X-Synapse-Token': self.state.token})
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=10)
            self.assertEqual(error.exception.code, code)

    def test_listening_needs_the_session_token_like_every_other_mutation(self):
        request = Request(self.url + '/api/voice/listen', b'audio', {'Content-Type': 'audio/webm'})
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
