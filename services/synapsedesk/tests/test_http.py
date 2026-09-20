import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from synapsedesk.server import Server
from synapsedesk.state import State
from laptop_hand_tracking.simulator import packet

class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.state=State(cls.temp.name)
        cls.server=Server(0,cls.state)
        cls.thread=threading.Thread(target=cls.server.serve_forever,kwargs={'poll_interval':.02},daemon=True)
        cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.state.stop.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def get(self,path):
        with urlopen(self.url+path,timeout=2) as response:
            return json.load(response)

    def post(self,path,value,token=True,headers=None):
        h={'Content-Type':'application/json'}
        if token:h['X-Synapse-Token']=self.state.token
        h.update(headers or {})
        req=Request(self.url+path,json.dumps(value).encode(),h)
        with urlopen(req,timeout=2) as response:return json.load(response)

    def test_health_assets_and_sse(self):
        self.assertEqual(self.get('/api/health')['status'],'ok')
        with urlopen(self.url+'/',timeout=2) as response:
            self.assertIn(b'SynapseDesk',response.read())
            self.assertIn("script-src 'self'",response.headers['Content-Security-Policy'])
        with urlopen(self.url+'/events',timeout=2) as response:
            self.assertEqual(response.readline(),b'event: state\n')
            data=json.loads(response.readline().decode()[6:])
            self.assertIn('tracking',data)
            self.assertIn('spatial',data)

    def test_mutation_auth_and_cross_origin(self):
        with self.assertRaises(HTTPError) as missing:
            self.post('/api/analyze',{'source':'does-not-matter'},token=False)
        self.assertEqual(missing.exception.code,403)
        with self.assertRaises(HTTPError) as origin:
            self.post('/api/analyze',{'source':'does-not-matter'},headers={'Origin':'https://untrusted.example'})
        self.assertEqual(origin.exception.code,403)
        request=Request(self.url+'/api/session',headers={'Sec-Fetch-Site':'cross-site'})
        with self.assertRaises(HTTPError) as cross_site:urlopen(request,timeout=2)
        self.assertEqual(cross_site.exception.code,403)

    def test_tracking_validation_and_derived_pinch(self):
        for i in range(1,4):self.post('/api/tracking',packet(i,2.1))
        result=self.get('/api/state')['tracking']
        self.assertTrue(result['enabled'])
        self.assertTrue(result['pinch'])
        with self.assertRaises(HTTPError) as replay:self.post('/api/tracking',packet(3,2.1))
        self.assertEqual(replay.exception.code,400)
        bad=packet(4,2.1);bad['landmarks']=[[0,0,0]]
        with self.assertRaises(HTTPError):self.post('/api/tracking',bad)

    def test_analysis_dispatch_and_wiring(self):
        source=str(Path(__file__).parent/'fixtures'/'messy_repo')
        self.post('/api/analyze',{'source':source})
        self.state.analysis.join(timeout=5)
        data=self.get('/api/graph')
        self.assertGreater(len(data['graph']['nodes']),0)
        source,target=[n['id'] for n in data['graph']['nodes'][:2]]
        self.post('/api/wires',dict(source=source,target=target,revision=data['revision']))
        self.assertTrue(any(e['kind']=='proposed' for e in self.get('/api/graph')['graph']['edges']))
        with self.assertRaises(HTTPError):self.post('/api/wires',dict(source=source,target=target,revision=data['revision']))
        self.assertTrue(Path(self.temp.name,'pipeline.json').exists())

    def test_bad_body_depth_and_bounds(self):
        request=Request(self.url+'/api/bounds',b'[]',{'Content-Type':'application/json','X-Synapse-Token':self.state.token})
        with self.assertRaises(HTTPError) as result:urlopen(request,timeout=2)
        self.assertEqual(result.exception.code,400)
        with self.assertRaises(HTTPError):self.post('/api/bounds',dict(xmin=.8,xmax=.2,ymin=0,ymax=1))
        self.post('/api/spatial',dict(version=1,frame='desk_normalized_xy_z_m',age_ms=0,points=[[.1,.1,.1]]*3))
        self.assertEqual(len(self.get('/api/state')['spatial']['obstacles']),1)

if __name__=='__main__':unittest.main()
