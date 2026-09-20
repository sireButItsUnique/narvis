import copy
import json
from pathlib import Path
import tempfile
import unittest
from laptop_hand_tracking.gestures import GestureGate
from laptop_hand_tracking.simulator import packet
from laptop_hand_tracking.spatial import SpatialFilter
from repo_triage_agent.analyze import analyze
from repo_triage_agent.reasoner import validate_review
from synapsedesk.contracts import validate_graph
from synapsedesk.state import State

FIXTURE=Path(__file__).parent/'fixtures'/'messy_repo'

class GateTests(unittest.TestCase):
    def test_acquisition_hysteresis_stale_and_reacquire(self):
        gate=GestureGate()
        for seq in range(1,4):
            result=gate.ingest(packet(seq,2.1),now=10+seq*.03)
        self.assertTrue(result['pinch'])
        self.assertTrue(result['enabled'])
        self.assertFalse(gate.snapshot(now=11)['enabled'])
        self.assertFalse(gate.snapshot(now=11)['pinch'])
        result=gate.ingest(packet(4,2.1),now=11.01)
        self.assertEqual(result['reason'],'acquiring')

    def test_hysteresis_and_frame_age(self):
        gate=GestureGate()
        for seq in range(1,4): gate.ingest(packet(seq,2.1),now=seq*.01)
        p=packet(4,2.1);p['landmarks'][4][0]+=.045
        self.assertTrue(gate.ingest(p,now=.04)['pinch'])
        p=packet(5,2.1);p['landmarks'][4][0]+=.065
        self.assertFalse(gate.ingest(p,now=.05)['pinch'])
        self.assertEqual(gate.ingest(packet(6,2.1,'stale'),now=.06)['reason'],'stale')

    def test_reacquire_after_gap_without_snapshot(self):
        gate=GestureGate()
        for seq in range(1,4): gate.ingest(packet(seq,2.1),now=seq*.01)
        result=gate.ingest(packet(4,2.1),now=1)
        self.assertFalse(result['enabled'])
        self.assertEqual(result['reason'],'acquiring')

    def test_invalid_replay_and_boundary(self):
        gate=GestureGate();p=packet(1,2)
        gate.ingest(p,now=1)
        with self.assertRaises(ValueError): gate.ingest(p,now=1.01)
        p=packet(2,2);p['landmarks'][0][0]=float('nan')
        with self.assertRaises(ValueError): gate.ingest(p,now=1.02)
        self.assertFalse(gate.ingest(packet(3,2,'boundary'),now=1.03)['enabled'])
        self.assertEqual(gate.ingest(packet(4,2,'lost'),now=1.04)['reason'],'hand_lost')

    def test_stream_ownership(self):
        gate=GestureGate();gate.ingest(packet(1,0),now=1)
        other=packet(1,0);other['stream']='another'
        with self.assertRaises(ValueError):gate.ingest(other,now=1.2)
        gate.ingest(other,now=2)
        self.assertEqual(gate.stream,'another')

    def test_bounds_reset_gestures(self):
        gate=GestureGate()
        for seq in range(1,4):gate.ingest(packet(seq,2.1),now=1+seq*.01)
        gate.set_bounds(dict(xmin=.1,xmax=.2,ymin=.1,ymax=.2))
        self.assertFalse(gate.snapshot(now=1.04)['enabled'])
        with self.assertRaises(ValueError):gate.set_bounds(dict(xmin=.5,xmax=.4,ymin=0,ymax=1))

class AgentTests(unittest.TestCase):
    def test_ast_conflicts_cycles_and_call_resolution(self):
        graph=analyze(FIXTURE)
        kinds={f['kind'] for f in graph['findings']}
        self.assertIn('circular_dependency',kinds)
        self.assertIn('unmatched_documented_route',kinds)
        # Universal tiers: client.ts gets real symbols (tree-sitter when installed,
        # heuristic otherwise) instead of a bare coverage finding.
        parsers={(n.get('evidence') or {}).get('parser') for n in graph['nodes']}
        self.assertTrue('ts-treesitter' in parsers or 'heuristic' in parsers)
        labels={n['id']:n['label'] for n in graph['nodes']}
        calls={(labels[e['source']],labels[e['target']]) for e in graph['edges'] if e['kind']=='calls'}
        self.assertIn(('get_users','list_users'),calls)
        self.assertIn(('list_users','fetch_users'),calls)
        self.assertEqual(graph,analyze(FIXTURE))

    def test_bad_python_does_not_abort_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp,'bad.py').write_text('def invalid(:')
            Path(tmp,'good.py').write_text('def valid():\n return 1\n')
            graph=analyze(tmp)
            self.assertTrue(any(n['label']=='valid' for n in graph['nodes']))
            self.assertTrue(any(f['kind']=='parse_error' for f in graph['findings']))

    def test_relative_imports_and_route_parameters(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg=Path(tmp,'pkg');pkg.mkdir()
            (pkg/'__init__.py').write_text('')
            (pkg/'api.py').write_text('from .data import load\n@app.get("/users/{user_id}")\ndef endpoint():\n return load()\n')
            (pkg/'data.py').write_text('def load():\n return 1\n')
            Path(tmp,'README.md').write_text('GET /users/:id')
            graph=analyze(tmp)
            self.assertFalse(any(f['kind']=='unmatched_documented_route' for f in graph['findings']))
            labels={n['id']:n['label'] for n in graph['nodes']}
            self.assertTrue(any(labels[e['source']]=='endpoint' and labels[e['target']]=='load' for e in graph['edges']))

    def test_graph_and_llm_cannot_invent_references(self):
        graph=analyze(FIXTURE)
        broken=copy.deepcopy(graph);broken['edges'][0]['target']='missing'
        with self.assertRaises(ValueError):validate_graph(broken)
        with self.assertRaises(ValueError):validate_review(dict(summary='test',reviews=[dict(finding=999,recommendation='invented')]),graph['findings'])
        review=validate_review(dict(summary='Review docs',reviews=[dict(finding=0,recommendation='Inspect source')]),graph['findings'])
        self.assertFalse(review['verified'])

    def test_meaningful_actions_persist_graph_and_wire(self):
        with tempfile.TemporaryDirectory() as tmp:
            state=State(tmp);state.start_analysis(str(FIXTURE));state.analysis.join(timeout=5)
            self.assertEqual(state.job['status'],'complete')
            self.assertTrue(Path(tmp,'triage-report.json').exists())
            a,b=[n['id'] for n in state.graph['nodes'][:2]]
            revision=state.revision
            state.wire(a,b,revision)
            pipeline=json.loads(Path(tmp,'pipeline.json').read_text())
            self.assertEqual(pipeline['edges'][0]['kind'],'proposed')
            with self.assertRaises(ValueError):state.wire(a,b,revision)
            state.start_analysis(str(FIXTURE));state.analysis.join(timeout=5)
            self.assertEqual(json.loads(Path(tmp,'pipeline.json').read_text())['edges'],[])

class SpatialTests(unittest.TestCase):
    def test_noise_clusters_and_staleness(self):
        depth=SpatialFilter()
        depth.ingest(dict(version=1,frame='desk_normalized_xy_z_m',age_ms=0,
                          points=[[.21,.21,.10],[.22,.22,.12],[.23,.23,.11],[.8,.8,.5],[.2,.2,.001]]),now=10)
        self.assertEqual(len(depth.snapshot(now=10.1)['obstacles']),1)
        self.assertEqual(depth.snapshot(now=10.1)['obstacles'][0]['height_m'],.11)
        self.assertEqual(depth.snapshot(now=11)['obstacles'],[])
        with self.assertRaises(ValueError):depth.ingest(dict(version=1,frame='camera_raw',age_ms=0,points=[]))

if __name__=='__main__':unittest.main()
