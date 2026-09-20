"""Persistence, provider gate, working copies, and the agent HTTP surface."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from repo_triage_agent import workingcopy
from repo_triage_agent.provider import ChatCompletionsProvider, ProviderError, StubProvider, from_config
from synapsedesk.__main__ import DEFAULT_PORT, build_parser
from synapsedesk.server import Server
from synapsedesk.state import State
from synapsedesk.contracts import DEFAULT_VOLUME, validate_volume
from synapsedesk.store import Store

FIXTURE = Path(__file__).parent/'fixtures'/'messy_repo'
GRAPH = dict(version=1, nodes=[dict(id='m:a', label='a.py', kind='module', evidence=dict(path='a.py', line=1))],
             edges=[], findings=[], meta={})


class StoreTests(unittest.TestCase):
    def test_revisions_events_and_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            self.assertIsNone(store.latest())
            self.assertEqual(store.save_revision(GRAPH, dict(status='complete', message='one'), event='analysis.complete'), 1)
            self.assertEqual(store.save_revision(GRAPH, dict(status='complete', message='two'), event='graph.wire'), 2)
            latest = store.latest()
            self.assertEqual(latest['rev'], 2)
            self.assertEqual(latest['job']['message'], 'two')
            self.assertEqual([e['type'] for e in store.events_since(0)], ['analysis.complete', 'graph.wire'])
            self.assertEqual([e['type'] for e in store.events_since(1)], ['graph.wire'])
            self.assertEqual(store.events_since(2), [])

    def test_legacy_graph_migrates_once_without_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'graph.json').write_text(json.dumps(GRAPH), encoding='utf-8')
            store = Store(tmp)
            self.assertTrue(store.migrate_legacy_graph(tmp))
            self.assertEqual(store.latest()['rev'], 1)
            # Already populated: a second call is a no-op and the file survives.
            self.assertFalse(store.migrate_legacy_graph(tmp))
            self.assertTrue(Path(tmp, 'graph.json').exists())

    def test_legacy_migration_rejects_foreign_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'graph.json').write_text('{"version": 99}', encoding='utf-8')
            self.assertFalse(Store(tmp).migrate_legacy_graph(tmp))

    def test_positions_upsert_and_reject_out_of_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            store.set_positions({'m:a': {'x': .25, 'y': .5},
                                 'm:bad': {'x': 9, 'y': .5},
                                 'm:missing': {'y': .5},
                                 'm:nan': {'x': 'left', 'y': .5}})
            saved = store.get_positions()
            self.assertEqual(sorted(saved), ['m:a'])
            self.assertEqual(saved['m:a'], {'x': .25, 'y': .5, 'z': 0})
            store.set_positions({'m:a': {'x': .75, 'y': .1, 'z': 2}})
            self.assertEqual(store.get_positions()['m:a'], {'x': .75, 'y': .1, 'z': 2})

    def test_tasks_and_conversations_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            self.assertIsNone(store.get_task(1))
            task_id = store.create_task({'description': 'scoped change'})
            self.assertEqual(store.get_task(task_id)['status'], 'running')
            store.update_task(task_id, 'error', {'error': 'gate blocked'})
            self.assertEqual(store.get_task(task_id)['status'], 'error')
            self.assertEqual([t['id'] for t in store.list_tasks()], [task_id])
            self.assertEqual(store.get_conversation('task:1'), [])
            store.append_conversation('task:1', [{'role': 'user', 'content': 'a'}])
            store.append_conversation('task:1', [{'role': 'assistant', 'content': 'b'}])
            self.assertEqual([m['content'] for m in store.get_conversation('task:1')], ['a', 'b'])
            store.append_conversation('task:1', [{'role': 'user', 'content': str(i)} for i in range(5)], limit=3)
            self.assertEqual([m['content'] for m in store.get_conversation('task:1')], ['2', '3', '4'])
            with self.assertRaises(ValueError):
                store.append_conversation('task:1', 'not-a-list')

    def test_state_restores_graph_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = State(tmp)
            first.start_analysis(str(FIXTURE))
            first.analysis.join(timeout=10)
            self.assertEqual(first.job['status'], 'complete')
            revision, nodes = first.revision, len(first.graph['nodes'])
            first.store.db.close()
            second = State(tmp)
            self.assertEqual(second.revision, revision)
            self.assertEqual(len(second.graph['nodes']), nodes)
            self.assertEqual(second.job['status'], 'complete')


class VolumeTests(unittest.TestCase):
    """The rig slab the hologram draws into. The service carries it; clients map into it."""

    def test_validation_bounds_every_axis(self):
        self.assertEqual(validate_volume(DEFAULT_VOLUME)["width_cm"], DEFAULT_VOLUME["width_cm"])
        for bad in ({}, {"version": 2}, dict(DEFAULT_VOLUME, width_cm=0), dict(DEFAULT_VOLUME, depth_cm=501),
                    dict(DEFAULT_VOLUME, height_cm="tall"), dict(DEFAULT_VOLUME, height_cm=float("inf"))):
            with self.assertRaises(ValueError):
                validate_volume(bad)

    def test_volume_survives_a_restart_because_it_describes_the_desk(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = State(tmp)
            self.assertEqual(first.volume, dict(DEFAULT_VOLUME))
            self.assertEqual(first.snapshot()["volume"], dict(DEFAULT_VOLUME))
            first.set_volume(dict(version=1, width_cm=60, depth_cm=24, height_cm=18))
            first.store.db.close()
            second = State(tmp)
            self.assertEqual(second.volume["width_cm"], 60)
            self.assertEqual(second.snapshot()["volume"]["height_cm"], 18)

    def test_a_corrupt_volume_file_falls_back_to_the_rig_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "volume.json").write_text('{"version": 1, "width_cm": -5}', encoding="utf-8")
            self.assertEqual(State(tmp).volume, dict(DEFAULT_VOLUME))

    def test_positions_carry_depth_for_the_slab(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            store.set_positions({"~|m:a": {"x": .5, "y": .5, "z": .75}})
            self.assertEqual(store.get_positions()["~|m:a"]["z"], .75)


class ProviderTests(unittest.TestCase):
    def test_stub_blocks_the_live_agent_gate(self):
        stub = StubProvider()
        self.assertEqual(stub.name, 'stub')
        with self.assertRaises(ProviderError):
            stub.complete([{'role': 'user', 'content': 'hi'}])
        with self.assertRaises(ProviderError):
            stub.test_connection()

    def test_from_config_requires_endpoint_and_model(self):
        self.assertIsInstance(from_config('', ''), StubProvider)
        self.assertIsInstance(from_config('http://127.0.0.1:1/v1', ''), StubProvider)
        self.assertIsInstance(from_config('', 'a-model'), StubProvider)
        live = from_config('http://127.0.0.1:1/v1/', 'a-model')
        self.assertIsInstance(live, ChatCompletionsProvider)
        self.assertEqual(live.endpoint, 'http://127.0.0.1:1/v1')
        with self.assertRaises(ProviderError):
            ChatCompletionsProvider('', '')

    def test_key_comes_from_env_and_accepts_the_legacy_spelling(self):
        provider = ChatCompletionsProvider('http://127.0.0.1:1/v1', 'a-model')
        self.assertEqual(provider.key_env, 'SYNAPSEDESK_API_KEY')
        for name in ('SYNAPSEDESK_API_KEY', 'SYNASEDESK_API_KEY'):
            os.environ.pop(name, None)
        with self.assertRaises(ProviderError):
            provider._key()
        try:
            os.environ['SYNASEDESK_API_KEY'] = 'legacy-value'
            self.assertEqual(provider._key(), 'legacy-value')
            os.environ['SYNAPSEDESK_API_KEY'] = 'current-value'
            self.assertEqual(provider._key(), 'current-value')
        finally:
            for name in ('SYNAPSEDESK_API_KEY', 'SYNASEDESK_API_KEY'):
                os.environ.pop(name, None)

    def test_unreachable_endpoint_raises_provider_error(self):
        provider = ChatCompletionsProvider('http://127.0.0.1:1/v1', 'a-model', retries=0)
        os.environ['SYNAPSEDESK_API_KEY'] = 'test-key'
        try:
            with self.assertRaises(ProviderError):
                provider.test_connection()
        finally:
            os.environ.pop('SYNAPSEDESK_API_KEY', None)


class WorkingCopyTests(unittest.TestCase):
    def build(self, root):
        Path(root, 'pkg').mkdir()
        Path(root, 'pkg', 'app.py').write_text('def run():\n    return 1\n', encoding='utf-8')
        Path(root, 'node_modules').mkdir()
        Path(root, 'node_modules', 'junk.js').write_text('x', encoding='utf-8')
        Path(root, '.git').mkdir()
        Path(root, '.git', 'config').write_text('x', encoding='utf-8')

    def test_snapshot_excludes_generated_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp, 'src'), Path(tmp, 'snap')
            source.mkdir()
            self.build(source)
            workingcopy.snapshot_source(source, dest)
            self.assertTrue((dest/'pkg'/'app.py').is_file())
            self.assertFalse((dest/'node_modules').exists())
            self.assertFalse((dest/'.git').exists())
            # The original checkout is never touched.
            self.assertEqual((source/'pkg'/'app.py').read_text(), 'def run():\n    return 1\n')

    def test_writes_cannot_escape_the_working_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp, 'snap')
            snapshot.mkdir()
            outside = Path(tmp, 'outside.txt')
            outside.write_text('untouched', encoding='utf-8')
            with self.assertRaises(ValueError):
                workingcopy.write_file(snapshot, '../outside.txt', 'overwritten')
            self.assertEqual(outside.read_text(), 'untouched')
            with self.assertRaises(ValueError):
                workingcopy.read_file(snapshot, '../outside.txt')
            with self.assertRaises(ValueError):
                workingcopy.write_file(snapshot, 'huge.txt', 'x'*256_001)

    def test_checkpoint_records_a_diff_and_rollback_restores(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp, 'snap')
            snapshot.mkdir()
            (snapshot/'app.py').write_text('original\n', encoding='utf-8')
            edit = workingcopy.write_file(snapshot, 'app.py', 'replaced\n')
            self.assertTrue(edit['existed'])
            self.assertIn('-original', edit['diff'])
            self.assertIn('+replaced', edit['diff'])
            self.assertEqual(workingcopy.read_file(snapshot, 'app.py'), 'replaced\n')
            self.assertTrue(workingcopy.restore_checkpoint(snapshot, edit)['restored'])
            self.assertEqual((snapshot/'app.py').read_text(), 'original\n')
            created = workingcopy.write_file(snapshot, 'NEW.md', 'proposal\n')
            self.assertFalse(created['existed'])
            self.assertTrue(workingcopy.restore_checkpoint(snapshot, created)['restored'])
            self.assertFalse((snapshot/'NEW.md').exists())
            # Restoring twice is safe and reports honestly instead of raising.
            self.assertFalse(workingcopy.restore_checkpoint(snapshot, created)['restored'])
            self.assertFalse(workingcopy.restore_checkpoint(snapshot, {'diff': ''})['restored'])

    def test_checks_capture_output_and_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp, 'snap')
            snapshot.mkdir()
            results = workingcopy.run_checks(snapshot, ['echo hello', 'exit 3'])
            self.assertEqual(results[0]['returncode'], 0)
            self.assertIn('hello', results[0]['stdout'])
            self.assertEqual(results[1]['returncode'], 3)
            self.assertEqual(workingcopy.run_checks(snapshot, []), [])


class RecordingProvider:
    """Deterministic stand-in for a Chat Completions endpoint."""
    name = 'recording'
    endpoint, model = 'http://127.0.0.1:0/v1', 'test-model'

    def __init__(self, reply='# Proposal\n\nRename `list_users`.\n'):
        self.reply, self.calls = reply, []

    def test_connection(self):
        return {'ok': True, 'model': self.model, 'endpoint': self.endpoint}

    def complete(self, messages, timeout=None, retries=None):
        self.calls.append(messages)
        return self.reply


class AgentTaskTests(unittest.TestCase):
    def repo(self, root, suffix='.rb'):
        Path(root).mkdir(parents=True, exist_ok=True)
        Path(root, f'service{suffix}').write_text('def run\n  1\nend\n', encoding='utf-8')
        return str(Path(root).resolve())

    def test_source_must_be_a_local_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            for bad in ('', '   ', 'https://example.com/repo.git', str(Path(tmp, 'nope'))):
                with self.assertRaises(ValueError):
                    state.create_agent_task(bad, 'do a thing')

    def test_blocked_gate_leaves_a_recoverable_error_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            self.assertFalse(state.provider_status()['live'])
            with self.assertRaises(ValueError):
                state.test_provider()
            task_id = state.create_agent_task(self.repo(Path(tmp, 'repo')), 'scoped change')
            self.wait_for(state, task_id, {'error'})
            task = state.store.get_task(task_id)
            self.assertIn('live-agent gate blocked', task['detail']['error'])
            self.assertIn('graph_revision', task['detail']['recoverable_checkpoint'])
            # The snapshot survives the failure so the task can be inspected.
            self.assertTrue(Path(task['detail']['snapshot']).is_dir())
            self.assertNotIn(task_id, state.cancel_flags)

    def test_successful_task_writes_a_proposal_and_reindexes(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            state.provider = RecordingProvider()
            self.assertTrue(state.provider_status()['live'])
            task_id = state.create_agent_task(self.repo(Path(tmp, 'repo')), 'rename the handler')
            self.wait_for(state, task_id, {'complete'})
            detail = state.store.get_task(task_id)['detail']
            self.assertIn('Rename', detail['proposal'])
            snapshot = Path(detail['snapshot'])
            self.assertEqual((snapshot/'PROPOSAL.md').read_text(), state.provider.reply)
            self.assertEqual(detail['checkpoints'][0]['path'], 'PROPOSAL.md')
            # Ruby is the dominant language, so no Python checks were invented.
            self.assertEqual(detail['checks_adapter'], 'heuristic-v1')
            self.assertEqual(detail['test_output'], [])
            # The reindex actually ran instead of erroring on the snapshot path.
            self.assertNotIn('reindex_error', detail['graph_delta'])
            self.assertGreater(detail['graph_delta']['nodes'], 0)
            messages = state.task_conversation(task_id)['messages']
            self.assertEqual([m['role'] for m in messages], ['system', 'user', 'assistant'])

    def test_rollback_removes_the_proposal_and_reports_honestly(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            state.provider = RecordingProvider()
            task_id = state.create_agent_task(self.repo(Path(tmp, 'repo')), 'rename the handler')
            self.wait_for(state, task_id, {'complete'})
            snapshot = Path(state.store.get_task(task_id)['detail']['snapshot'])
            rolled = state.rollback_task(task_id)['detail']['rollback']
            self.assertEqual(rolled['restored'], 1)
            self.assertFalse((snapshot/'PROPOSAL.md').exists())
            # Second rollback has nothing left to undo and says so.
            self.assertEqual(state.rollback_task(task_id)['detail']['rollback']['restored'], 0)
            with self.assertRaises(ValueError):
                state.rollback_task(9999)

    def test_cancel_only_applies_to_running_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            with self.assertRaises(ValueError):
                state.cancel_task(9999)
            task_id = state.create_agent_task(self.repo(Path(tmp, 'repo')), 'scoped change')
            self.wait_for(state, task_id, {'error'})
            self.assertEqual(state.cancel_task(task_id)['status'], 'error')
            # A terminal task must not leak a cancel flag that outlives it.
            self.assertEqual(state.cancel_flags, set())

    def test_checks_follow_the_dominant_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            self.repo(Path(tmp, 'py'), suffix='.py')
            self.assertEqual(state._checks_for(Path(tmp, 'py'))[0], 'python-ast-v1')
            self.repo(Path(tmp, 'go'), suffix='.go')
            self.assertEqual(state._checks_for(Path(tmp, 'go'))[1], ['go test ./...'])
            Path(tmp, 'empty').mkdir()
            self.assertEqual(state._checks_for(Path(tmp, 'empty')), ('', []))

    def test_explain_cites_indexed_evidence_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = State(tmp)
            state.start_analysis(str(FIXTURE))
            state.analysis.join(timeout=10)
            with self.assertRaises(ValueError):
                state.explain_node('m:not-indexed')
            node = next(n for n in state.graph['nodes'] if n['kind'] == 'module')
            explained = state.explain_node(node['id'])
            self.assertEqual(explained['provenance'], 'indexed_evidence')
            self.assertEqual(explained['citations'][0]['path'], node['evidence']['path'])
            self.assertTrue(all(e['source'] == node['id'] for e in explained['outgoing']))

    def wait_for(self, state, task_id, statuses, timeout=15):
        deadline = threading.Event()
        for _ in range(int(timeout/.05)):
            task = state.store.get_task(task_id)
            if task and task['status'] in statuses:
                return task
            deadline.wait(.05)
        self.fail(f"task {task_id} never reached {statuses}: {state.store.get_task(task_id)}")


class ManifestTests(unittest.TestCase):
    """The CLI, the launchers and the docs must agree on the port they advertise."""
    ROOT = Path(__file__).resolve().parent.parent

    def test_default_port_is_consistent_and_clear_of_holomodel(self):
        parser = build_parser()
        self.assertEqual(parser.parse_args(['serve']).port, DEFAULT_PORT)
        self.assertEqual(parser.parse_args(['track']).port, DEFAULT_PORT)
        # 8765 belongs to the HoloModel server in this repository.
        self.assertNotEqual(DEFAULT_PORT, 8765)
        manifest = json.loads((self.ROOT/'config'/'service-manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['listen'], f'127.0.0.1:{DEFAULT_PORT}')
        for doc in ('README.md', 'docs/PROTOCOL.md'):
            self.assertIn(f'127.0.0.1:{DEFAULT_PORT}', (self.ROOT/doc).read_text(encoding='utf-8'), doc)
        for script in ('scripts/Start-SynapseDesk.ps1', 'scripts/Start-Tracking.ps1'):
            self.assertIn(f'$Port = {DEFAULT_PORT}', (self.ROOT/script).read_text(encoding='utf-8'), script)
        self.assertIn(f'127.0.0.1:{DEFAULT_PORT}',
                      (self.ROOT/'frontend'/'vite.config.ts').read_text(encoding='utf-8'))

    def test_port_override_is_still_honoured(self):
        self.assertEqual(build_parser().parse_args(['serve', '--port', '9111']).port, 9111)


class AgentHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.state = State(cls.temp.name)
        cls.server = Server(0, cls.state)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.state.start_analysis(str(FIXTURE))
        cls.state.analysis.join(timeout=10)

    @classmethod
    def tearDownClass(cls):
        cls.state.stop.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def get(self, path):
        with urlopen(self.url+path, timeout=5) as response:
            return json.load(response)

    def post(self, path, value, token=True):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Synapse-Token'] = self.state.token
        with urlopen(Request(self.url+path, json.dumps(value).encode(), headers), timeout=5) as response:
            return json.load(response)

    def test_display_route_serves_the_projection_page(self):
        with urlopen(self.url+'/display', timeout=5) as response:
            body = response.read().decode()
        self.assertIn('class="projection"', body)
        # The CSP forbids inline script/style, so neither may appear in the markup.
        self.assertNotIn('<script>', body)
        self.assertNotIn('style="', body)

    def test_events_feed_filters_by_revision(self):
        feed = self.get('/api/events')
        self.assertGreaterEqual(feed['revision'], 1)
        self.assertEqual(feed['events'][0]['type'], 'analysis.complete')
        self.assertEqual(self.get(f"/api/events?since={feed['revision']}")['events'], [])
        with self.assertRaises(HTTPError) as bad:
            self.get('/api/events?since=abc')
        self.assertEqual(bad.exception.code, 400)

    def test_positions_persist_and_reject_bad_payloads(self):
        node = self.get('/api/graph')['graph']['nodes'][0]['id']
        self.assertEqual(self.post('/api/positions', {'positions': {node: {'x': .3, 'y': .7}}})['saved'], 1)
        self.assertEqual(self.get('/api/positions')['positions'][node], {'x': .3, 'y': .7, 'z': 0})
        with self.assertRaises(HTTPError) as bad:
            self.post('/api/positions', {'positions': []})
        self.assertEqual(bad.exception.code, 400)
        with self.assertRaises(HTTPError) as unauthorized:
            self.post('/api/positions', {'positions': {}}, token=False)
        self.assertEqual(unauthorized.exception.code, 403)

    def test_volume_endpoint_round_trips_and_rejects_bad_geometry(self):
        self.assertEqual(self.get('/api/volume')['version'], 1)
        saved = self.post('/api/volume', dict(version=1, width_cm=53.1, depth_cm=21.1, height_cm=15.2))
        self.assertEqual(saved['width_cm'], 53.1)
        self.assertEqual(self.get('/api/state')['volume']['depth_cm'], 21.1)
        for bad in (dict(version=1, width_cm=0, depth_cm=1, height_cm=1), dict(version=9), {}):
            with self.assertRaises(HTTPError) as error:
                self.post('/api/volume', bad)
            self.assertEqual(error.exception.code, 400)

    def test_view_trail_is_shared_and_bounded(self):
        self.assertEqual(self.post('/api/view', {'trail': ['synapsedesk', 'synapsedesk/store.py']})['view'],
                         ['synapsedesk', 'synapsedesk/store.py'])
        self.assertEqual(self.get('/api/state')['view'], ['synapsedesk', 'synapsedesk/store.py'])
        for bad in ({'trail': 'not-a-list'}, {'trail': [1, 2]}, {'trail': ['x']*9}, {'trail': ['']}):
            with self.assertRaises(HTTPError) as error:
                self.post('/api/view', bad)
            self.assertEqual(error.exception.code, 400)
        self.post('/api/view', {'trail': []})

    def test_provider_status_reports_the_blocked_gate(self):
        status = self.get('/api/provider/status')
        self.assertEqual(status['name'], 'stub')
        self.assertFalse(status['live'])
        with self.assertRaises(HTTPError) as blocked:
            self.get('/api/provider/test')
        self.assertEqual(blocked.exception.code, 400)

    def test_explain_endpoint_validates_the_node(self):
        node = self.get('/api/graph')['graph']['nodes'][0]['id']
        self.assertEqual(self.post('/api/agent/explain', {'node_id': node})['node']['id'], node)
        for bad in ({'node_id': 'm:missing'}, {'node_id': 7}, {}):
            with self.assertRaises(HTTPError) as error:
                self.post('/api/agent/explain', bad)
            self.assertEqual(error.exception.code, 400)

    def test_task_routes_cover_patch_conversation_and_unknown_ids(self):
        source = str(Path(self.temp.name, 'agent-repo'))
        Path(source).mkdir(exist_ok=True)
        Path(source, 'service.rb').write_text('def run\n  1\nend\n', encoding='utf-8')
        task_id = self.post('/api/agent/tasks', {'source': source, 'description': 'scoped change'})['id']
        for _ in range(200):
            task = self.get(f'/api/agent/tasks/{task_id}')
            if task['status'] != 'running':
                break
            threading.Event().wait(.05)
        self.assertEqual(task['status'], 'error')  # stub provider blocks the gate
        self.assertIn(task_id, [t['id'] for t in self.get('/api/agent/tasks')['tasks']])
        self.assertIsInstance(self.get(f'/api/agent/tasks/{task_id}/patch')['patch'], str)
        self.assertEqual(self.get(f'/api/agent/tasks/{task_id}/conversation')['messages'], [])
        for path, code in ((f'/api/agent/tasks/{task_id}/nope', 404), ('/api/agent/tasks/99999', 404),
                           ('/api/agent/tasks/not-a-number', 400)):
            with self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code, code, path)
        with self.assertRaises(HTTPError) as error:
            self.post(f'/api/agent/tasks/{task_id}/nope', {})
        self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.post(f'/api/agent/tasks/{task_id}/rollback', {})['id'], task_id)

    def test_vendored_build_is_an_explicit_tripwire_and_blocks_traversal(self):
        for path in ('/vendored/index.html', '/vendored/../state.py', '/vendored/%2e%2e/state.py'):
            with self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code, 404, path)
            self.assertIn('not vendored', json.loads(error.exception.read())['error'])


if __name__ == '__main__':
    unittest.main()
