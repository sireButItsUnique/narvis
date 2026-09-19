"""Checks the bridge inside a real (background) Blender:
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b --factory-startup --python blender\\test_bridge.py
Prints PASS/FAIL lines and exits non-zero on failure."""
import base64
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import holomodel_bridge as hb

failures = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))
    if not cond:
        failures.append(name)


# a clean scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# exec: builds geometry, reports new objects, prints go to output
r = hb.handle({'cmd': 'exec', 'label': 'mug', 'code': '''
import bpy, bmesh, math
from mathutils import Vector
coll = bpy.data.collections.new("Mug"); bpy.context.scene.collection.children.link(coll)
bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=0.1, location=(0, 0, 0.05))
body = bpy.context.active_object; body.name = "mug_body"
for c in body.users_collection: c.objects.unlink(body)
coll.objects.link(body)
body.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.004
mat = bpy.data.materials.new("glaze"); mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.2, 0.2, 1)
body.data.materials.append(mat)
print("built", body.name, len(body.data.vertices))
'''})
check('exec runs modelling code', r['ok'], r.get('error'))
check('exec reports the new object', any(o['name'] == 'mug_body' for o in r['new_objects']), r['new_objects'])
check('exec captures print output', 'built mug_body' in r['output'], r['output'])
check('exec lists modifiers', any('Solidify' in m for o in r['new_objects'] for m in o.get('modifiers', [])))

# errors come back as a short traceback pointing at the AI's line
r = hb.handle({'cmd': 'exec', 'code': 'x = 1\ny = undefined_name + 2\n'})
check('errors are reported, not raised', not r['ok'] and 'line 2' in r['error'] and 'NameError' in r['error'], r.get('error'))

# sandbox: no files, OS, network or Blender settings
for code, why in [('open("C:/temp/x.txt", "w")', 'open'), ('import os\nos.remove("x")', 'import os'),
                  ('import subprocess', 'subprocess'), ('bpy.ops.wm.quit_blender()', 'quit'),
                  ('().__class__.__bases__[0].__subclasses__()', 'subclasses'), ('eval("1+1")', 'eval'),
                  ('bpy.ops.wm.save_mainfile()', 'save')]:
    r = hb.handle({'cmd': 'exec', 'code': code})
    check(f'sandbox blocks {why}', not r['ok'], r)
r = hb.handle({'cmd': 'exec', 'code': 'import numpy as np, colorsys\nprint(np.arange(3).sum())'})
check('sandbox allows numpy', r['ok'] and '3' in r['output'], r)

# review fixes: normal modelling code isn't blocked, main-guard scripts run, syntax errors say where
r = hb.handle({'cmd': 'exec', 'code': 'mat = bpy.data.materials.new("m"); mat.use_nodes = True\n'
               'socket = mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"]\nsocket.default_value = (1, 0, 0, 1)'})
check('a variable called socket is fine', r['ok'], r.get('error'))
r = hb.handle({'cmd': 'exec', 'code': 'def main():\n    print("ran main")\nif __name__ == "__main__":\n    main()'})
check('scripts with a main guard run', r['ok'] and 'ran main' in r['output'], r)
r = hb.handle({'cmd': 'exec', 'code': 'x = 1\nif x > 0\n    print(x)'})
check('syntax errors report their line', not r['ok'] and 'line 2' in r['error'], r.get('error'))
r = hb.handle('not a dict')
check('a malformed request gets an error reply', r['ok'] is False, r)

# voice commands: brush size follows the size in effect, mirror uses the mesh's own flag
bpy.context.view_layer.objects.active = bpy.data.objects['mug_body']
r = hb.handle({'cmd': 'brush', 'name': 'Clay Strips'})
check('brush switches into sculpt mode', r['ok'] and bpy.context.mode == 'SCULPT', r)
ups = bpy.context.tool_settings.sculpt.unified_paint_settings
before_size = ups.size if ups.use_unified_size else bpy.context.tool_settings.sculpt.brush.size
r = hb.handle({'cmd': 'brush_size', 'factor': 2})
check('bigger brush changes the size actually used', r['ok'] and r['size'] == min(500, before_size * 2), (r, before_size))
r = hb.handle({'cmd': 'symmetry', 'on': True})
check('mirror sets the mesh X-mirror', r['ok'] and bpy.data.objects['mug_body'].data.use_mirror_x, r)
hb.handle({'cmd': 'mode', 'mode': 'object'})

# scene summary
r = hb.handle({'cmd': 'scene'})
check('scene lists objects', r['ok'] and any(o['name'] == 'mug_body' for o in r['objects']), r)

# render: PNGs from several views, and no temporary objects left behind
before = set(bpy.data.objects.keys()) | set(bpy.data.cameras.keys()) | set(bpy.data.lights.keys())
t = time.time()
r = hb.handle({'cmd': 'render', 'views': ['front', 'three_quarter'], 'size': 320})
took = time.time() - t
check('render returns images', r['ok'] and len(r['images']) == 2, r.get('error'))
if r['ok']:
    png = base64.b64decode(r['images'][0]['png'])
    check('render images are PNGs', png[:8] == b'\x89PNG\r\n\x1a\n')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test_render_front.png'), 'wb') as f:
        f.write(png)
after = set(bpy.data.objects.keys()) | set(bpy.data.cameras.keys()) | set(bpy.data.lights.keys())
check('render cleans up its camera and lights', before == after, after - before)
print(f'INFO first render (2 views, 320px, includes shader compile) took {took:.1f}s')
t = time.time()
r = hb.handle({'cmd': 'render', 'views': ['three_quarter', 'side', 'front'], 'size': 640})
print(f'INFO next render (3 views, 640px) took {time.time() - t:.1f}s')
check('a second render works too', r['ok'] and len(r['images']) == 3, r.get('error'))

# the socket server + token, pumped by hand (background Blender has no timer loop)
hb._start_server()
with open(hb.BRIDGE_FILE) as f:
    info = json.load(f)
answers = {}


def client(token, key):
    s = socket.create_connection(('127.0.0.1', info['port']), timeout=10)
    s.sendall((json.dumps({'id': 7, 'token': token, 'cmd': 'ping'}) + '\n').encode())
    answers[key] = json.loads(s.makefile('rb').readline())
    s.close()


for token, key in ((info['token'], 'good'), ('wrong', 'bad')):
    th = threading.Thread(target=client, args=(token, key))
    th.start()
    for _ in range(200):
        hb._pump()
        if key in answers:
            break
        time.sleep(0.01)
    th.join(2)
check('socket request with the token works', answers.get('good', {}).get('ok') and answers['good'].get('id') == 7, answers.get('good'))
# ping is answered straight from the socket thread once the main thread has taken a snapshot
hb._pump()
th = threading.Thread(target=client, args=(info['token'], 'fast'))
th.start(); th.join(3)
check('ping answers without waiting for the main thread', answers.get('fast', {}).get('ok'), answers.get('fast'))
# a job whose deadline passed while queued is dropped, not run
reply = __import__('queue').Queue()
hb._jobs.put(({'token': info['token'], 'cmd': 'add', 'shape': 'box', 'deadline': time.time() * 1000 - 1}, reply))
n_before = len(bpy.data.objects)
hb._pump()
r = reply.get(timeout=1)
check('expired jobs are dropped', not r['ok'] and 'expired' in r['error'] and len(bpy.data.objects) == n_before, r)
check('socket request with a wrong token is refused', answers.get('bad', {}).get('error') == 'bad token', answers.get('bad'))
hb.unregister()
check('unregister removes the connection file', not os.path.exists(hb.BRIDGE_FILE))

print(f'RESULT {"OK" if not failures else "FAILED: " + ", ".join(failures)}')
sys.exit(1 if failures else 0)
