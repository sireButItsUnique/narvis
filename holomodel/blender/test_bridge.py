"""Checks the bridge inside a real (background) Blender:
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b --factory-startup --python blender\\test_bridge.py
Prints PASS/FAIL lines and exits non-zero on failure. Everything it writes goes to a temporary HOLOMODEL_HOME,
so it never touches ~/.holomodel (where a GUI Blender's bridge.json may live)."""
import base64
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = tempfile.mkdtemp(prefix='holo-test-')
os.environ['HOLOMODEL_HOME'] = HOME   # before the import: the bridge reads it once
sys.path.insert(0, HERE)
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import holomodel_bridge as hb  # noqa: E402

failures = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))
    if not cond:
        failures.append(name)


def read_glb(path):
    """The JSON chunk of a GLB, plus a per-mesh triangle count from its index accessors."""
    with open(path, 'rb') as f:
        b = f.read()
    n = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + n])
    acc = j.get('accessors', [])
    tris = {m['name']: sum(acc[p['indices']]['count'] // 3 for p in m['primitives']) for m in j.get('meshes', [])}
    return j, tris


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
out_file = os.path.join(HOME, 'leak.glb').replace('\\', '/')
img_file = os.path.join(HOME, 'leak.png').replace('\\', '/')
txt_file = os.path.join(HOME, 'leak.txt').replace('\\', '/')
for code, why in [('open("C:/temp/x.txt", "w")', 'open'), ('import os\nos.remove("x")', 'import os'),
                  ('import subprocess', 'subprocess'), ('bpy.ops.wm.quit_blender()', 'quit'),
                  ('().__class__.__bases__[0].__subclasses__()', 'subclasses'), ('eval("1+1")', 'eval'),
                  ('bpy.ops.wm.save_mainfile()', 'save'),
                  (f'bpy.ops.export_scene.gltf(filepath="{out_file}")', 'glTF export'),
                  (f'bpy.ops.import_scene.gltf(filepath="{out_file}")', 'glTF import'),
                  (f'img = bpy.data.images.new("x", 4, 4)\nimg.filepath_raw = "{img_file}"\nimg.save()', 'Image.save'),
                  (f'img = bpy.data.images.new("x", 4, 4)\nimg.save_render("{img_file}")', 'Image.save_render'),
                  ('bpy.ops.render.render(write_still=True)', 'render.render'),
                  ('bpy.ops.image.save_as()', 'image.save_as'),
                  (f'ops = bpy.ops\nops.export_scene.gltf(filepath="{out_file}")', 'an aliased export'),
                  (f'getattr(bpy.ops, "export_" + "scene").gltf(filepath="{out_file}")', 'export via getattr'),
                  ('from bpy.ops import wm\nwm.read_homefile()', 'from bpy.ops import wm'),
                  ('import bpy as b\nb.ops.wm.read_factory_settings()', 'wm via an import alias'),
                  ('r = bpy.ops.render\nr.opengl()', 'an aliased render.opengl'),
                  # numpy's own IO helpers find open() in numpy's globals, not ours, so the module has to refuse
                  (f'import numpy as np\nnp.savetxt("{txt_file}", np.zeros((1, 2)))', 'numpy savetxt'),
                  (f'import numpy as np\nprint(np.loadtxt("{txt_file}", dtype=str))', 'numpy loadtxt'),
                  (f'import numpy as np\nnp.zeros(3).tofile("{txt_file}")', 'ndarray.tofile'),
                  (f'import numpy as np\ngetattr(np, "save" + "txt")("{txt_file}", np.zeros((1, 2)))',
                   'numpy savetxt built from pieces'),
                  (f'import numpy as np\nnp.lib.npyio.savetxt("{txt_file}", np.zeros((1, 2)))',
                   'numpy savetxt through a submodule'),
                  (f'import numpy as np\ngetattr(np, "__buil" + "tins__")["open"]("{txt_file}", "w")',
                   "a module's own builtins"),
                  (f'import re\ngetattr(re, "__buil" + "tins__")["open"]("{txt_file}", "w")',
                   "another module's builtins")]:
    r = hb.handle({'cmd': 'exec', 'code': code})
    check(f'sandbox blocks {why}', not r['ok'], r)
check('sandboxed code wrote no files',
      not os.path.exists(out_file) and not os.path.exists(img_file) and not os.path.exists(txt_file))
r = hb.handle({'cmd': 'exec', 'code': 'import numpy as np, colorsys\nfrom numpy import float32\n'
               'print(np.arange(3).sum(), round(float(np.linalg.norm([3, 4])), 1), np.zeros(2, float32).size)'})
check('sandbox allows numpy, its submodules and from-imports', r['ok'] and '3 5.0 2' in r['output'], r)

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

# the kind of code Fable writes: operators through bpy.ops, imports from bpy, painted and packed images
r = hb.handle({'cmd': 'exec', 'label': 'kettle', 'code': '''
import bpy, bmesh
import bpy.ops
import numpy as np
from bpy.types import Object
from bpy import context as ctx
from bpy.ops import mesh as mesh_ops
from mathutils import Vector, Matrix
root = bpy.data.objects.new("Kettle", None); ctx.scene.collection.objects.link(root)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(0.3, 0, 0.08))
pot = bpy.context.active_object; pot.name = "Kettle Pot"; pot.parent = root
bpy.ops.object.shade_smooth()
sub = pot.modifiers.new("Subdivision", "SUBSURF"); sub.levels = 1; sub.render_levels = 2
mesh_ops.primitive_cube_add(size=0.05, location=(0.3, 0, 0.2))
lid = bpy.context.active_object; lid.name = "Kettle Knob"; lid.parent = root
bev = lid.modifiers.new("Bevel", "BEVEL"); bev.width = 0.004
bpy.ops.object.modifier_apply(modifier="Bevel")
bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.02, radius2=0.01, depth=0.1)
me = bpy.data.meshes.new("spout"); bm.to_mesh(me); bm.free()
spout = bpy.data.objects.new("Kettle Spout", me); ctx.scene.collection.objects.link(spout); spout.parent = root
img = bpy.data.images.new("kettle_paint", 16, 16)
img.pixels.foreach_set(np.tile(np.array([0.9, 0.5, 0.1, 1.0], np.float32), 16 * 16))
img.pack()
mat = bpy.data.materials.new("Kettle Enamel")
tex = mat.node_tree.nodes.new("ShaderNodeTexImage"); tex.image = img
mat.node_tree.links.new(tex.outputs["Color"], mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
pot.data.materials.append(mat)
assert isinstance(pot, Object)
print("kettle", len(root.children))
'''})
check("Fable-style modelling code runs in the sandbox", r['ok'] and 'kettle 3' in r['output'], r.get('error') or r.get('output'))
hb.handle({'cmd': 'exec', 'code': 'for o in [o for o in bpy.data.objects if o.name.startswith("Kettle")]:\n'
                                  '    bpy.data.objects.remove(o)'})

# scene summary
r = hb.handle({'cmd': 'scene'})
check('scene lists objects', r['ok'] and any(o['name'] == 'mug_body' for o in r['objects']), r)
check('the GUI-only quick commands are gone', all(c not in hb.COMMANDS for c in ('mode', 'brush', 'brush_size', 'symmetry', 'focus')))

# render: PNGs from several views, and no temporary objects left behind
before = set(bpy.data.objects.keys()) | set(bpy.data.cameras.keys()) | set(bpy.data.lights.keys())
t = time.time()
r = hb.handle({'cmd': 'render', 'views': ['front', 'three_quarter'], 'size': 320})
took = time.time() - t
check('render returns images', r['ok'] and len(r['images']) == 2, r.get('error'))
if r['ok']:
    png = base64.b64decode(r['images'][0]['png'])
    check('render images are PNGs', png[:8] == b'\x89PNG\r\n\x1a\n')
    with open(os.path.join(HERE, 'test_render_front.png'), 'wb') as f:
        f.write(png)
after = set(bpy.data.objects.keys()) | set(bpy.data.cameras.keys()) | set(bpy.data.lights.keys())
check('render cleans up its camera and lights', before == after, after - before)
print(f'INFO first render (2 views, 320px, includes shader compile) took {took:.1f}s')
t = time.time()
r = hb.handle({'cmd': 'render', 'views': ['three_quarter', 'side', 'front'], 'size': 640})
print(f'INFO next render (3 views, 640px) took {time.time() - t:.1f}s')
check('a second render works too', r['ok'] and len(r['images']) == 3, r.get('error'))

# version history: snapshot the scene, change it, restore the snapshot
snap = os.path.join(HOME, 'holo_test_snapshot.blend')
r = hb.handle({'cmd': 'snapshot', 'path': snap})
check('snapshot writes a .blend', r['ok'] and os.path.getsize(snap) > 1000, r)
names_then = sorted(o.name for o in bpy.data.objects)
fp_then = r.get('fingerprint')
check('fingerprint is stable when nothing changes', hb.handle({'cmd': 'fingerprint'})['fingerprint'] == fp_then)
hb.handle({'cmd': 'exec', 'code': 'bpy.ops.mesh.primitive_monkey_add()'})
check('scene changed after the snapshot', sorted(o.name for o in bpy.data.objects) != names_then)
check('fingerprint sees a new object', hb.handle({'cmd': 'fingerprint'})['fingerprint'] != fp_then)
r = hb.handle({'cmd': 'restore', 'path': snap})
check('restore brings the snapshot back', r['ok'] and sorted(o.name for o in bpy.data.objects) == names_then,
      (r, sorted(o.name for o in bpy.data.objects)))
check('a restored snapshot has the fingerprint it was saved with', r.get('fingerprint') == fp_then, (r.get('fingerprint'), fp_then))
hb.handle({'cmd': 'exec', 'code': 'bpy.data.objects["mug_body"].data.vertices[0].co.x += 0.001'})
check('fingerprint sees a sculpt-sized edit', hb.handle({'cmd': 'fingerprint'})['fingerprint'] != fp_then)
hb.handle({'cmd': 'exec', 'code': 'bpy.data.materials["glaze"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 1, 1)'})
fp_blue = hb.handle({'cmd': 'fingerprint'})['fingerprint']
hb.handle({'cmd': 'exec', 'code': 'bpy.data.materials["glaze"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1, 0, 0, 1)'})
check('fingerprint sees a colour change', hb.handle({'cmd': 'fingerprint'})['fingerprint'] != fp_blue)
check('restore refuses a missing file', not hb.handle({'cmd': 'restore', 'path': 'C:/nope.blend'})['ok'])

# ---------------------------------------------------------------- export_glb on Fable's teapot
TEAPOT = os.path.join(HERE, 'fixtures', 'teapot.blend')   # history version 4 (mu8q0i14-0fb874), untouched
r = hb.handle({'cmd': 'restore', 'path': TEAPOT})
check('the teapot opens', r['ok'], r)
fp_teapot = r.get('fingerprint')
selected_then = sorted(o.name for o in bpy.context.view_layer.objects if o.select_get())
glb = os.path.join(HOME, 'teapot_preview.glb')
t = time.time()
pre = hb.handle({'cmd': 'export_glb', 'path': glb, 'mode': 'preview', 'rev': 3})
print(f'INFO first export (preview, includes the exporter import) took {time.time() - t:.2f}s: {pre.get("ms")}')
check('export_glb (preview) works', pre['ok'] and not pre['empty'] and os.path.getsize(glb) > 100000, pre.get('error'))
j, tris = read_glb(glb)
names = {p['name'] for p in pre['parts']}
check('preview is at viewport levels: 31,808 tris', pre['tris'] == 31808 and sum(tris.values()) == 31808, (pre['tris'], tris))
check('five teapot parts, and the hidden factory Cube is not one', names == {'Teapot Body', 'Teapot Lid', 'Teapot Spout',
      'Teapot Handle', 'Teapot Lid Seat'} and 'Cube' not in {n['name'] for n in j['nodes']}, names)
node_extras = {n['name']: n.get('extras', {}) for n in j['nodes']}
ids = {n: e.get('holo_id') for n, e in node_extras.items()}
check('every node has a 12-hex holo_id and its Blender name', all(isinstance(i, str) and len(i) == 12 and int(i, 16) >= 0
      for i in ids.values()) and all(e.get('holo_name') == n for n, e in node_extras.items()), node_extras)
check('parts carry holo_ghash and holo_mhash', all(len(node_extras[p['name']].get('holo_ghash', '')) == 16 and
      node_extras[p['name']].get('holo_mhash') == p['mhash'] for p in pre['parts']), node_extras)
check('the parent Empty is exported as a node', 'Utah Teapot' in ids and 'Utah Teapot' not in names)
sx = j['scenes'][0].get('extras', {})
check('scene extras: sym (mirrored on Blender Y = three z), rev, units',
      sx.get('holo_sym') == {'x': False, 'y': False, 'z': True} and sx.get('holo_rev') == 3 and sx.get('holo_units') == 'm', sx)
check('symmetry comes back in the reply too', pre['sym'] == {'x': False, 'y': False, 'z': True}, pre['sym'])
# the glTF scene is always called "Scene", so the model's own name travels as an extra
check('holo_model names the model after its root Empty', sx.get('holo_model') == 'Utah Teapot' and pre['name'] == 'Utah Teapot',
      (sx.get('holo_model'), pre.get('name')))
check('nothing was dropped from this export', pre['skipped'] == [], pre['skipped'])
check('parts are not sculpted or textured', not any(p['sculpted'] or p['textured'] for p in pre['parts']))
again = hb.handle({'cmd': 'export_glb', 'path': glb, 'mode': 'preview'})
check('holo_ids are stable across exports', {p['name']: p['id'] for p in again['parts']} ==
      {p['name']: p['id'] for p in pre['parts']} and again['ids_assigned'] == 0, again.get('ids_assigned'))
check('hashes are stable when nothing changed', [(p['ghash'], p['mhash']) for p in again['parts']] ==
      [(p['ghash'], p['mhash']) for p in pre['parts']])
print(f'INFO warm preview export took {again["ms"]}')

look = hb.handle({'cmd': 'export_glb', 'path': os.path.join(HOME, 'teapot_look.glb'), 'mode': 'look'})
check('export_glb (look) works', look['ok'], look.get('error'))
lj, ltris = read_glb(os.path.join(HOME, 'teapot_look.glb'))
by = {p['name']: p for p in look['parts']}
# Subdivision at render levels gives 126,272; the Lid Seat (Solidify only, 1.5 cm edges on a 41 cm teapot) is the
# one part coarser than 0.004 x diagonal, so densify gives it 4 SIMPLE levels: 320 -> 81,920 tris
check('look is at render levels: 126,272 tris before densify', look['tris'] - by['Teapot Lid Seat']['tris'] + 320 == 126272,
      look['tris'])
check('look densifies only the coarse Lid Seat', look['densified'] == {'Teapot Lid Seat': 4} and
      by['Teapot Lid Seat']['tris'] == 81920 and sum(ltris.values()) == look['tris'], (look['densified'], look['tris']))
check('look keeps the same ids', {p['name']: p['id'] for p in look['parts']} == {p['name']: p['id'] for p in pre['parts']})
check('denser geometry has a new ghash, same mhash', all(by[p['name']]['ghash'] != p['ghash'] and
      by[p['name']]['mhash'] == p['mhash'] for p in pre['parts']))
print(f'INFO look export: {look["tris"]} tris, {look["bytes"]} bytes, {look["ms"]}')
teapot = [o for o in bpy.data.objects if o.name.startswith('Teapot')]
check('export leaves the scene as it was', hb._fingerprint() == fp_teapot and
      all(m.levels == 1 for o in teapot for m in o.modifiers if m.type == 'SUBSURF') and
      not any(m.name.startswith('_holo') for o in teapot for m in o.modifiers) and
      not any('holo_ghash' in o or 'holo_nv' in o for o in bpy.data.objects) and
      not any(k.startswith('holo_') for k in bpy.context.scene.keys()) and
      '_holo_realize' not in bpy.data.node_groups, [(o.name, [m.name for m in o.modifiers]) for o in teapot])
check('export leaves the selection as it was', sorted(o.name for o in bpy.context.view_layer.objects if o.select_get()) == selected_then)

# a plain (modifier-free) part gets _vid, a copy gets its own id, only= exports one part
hb.handle({'cmd': 'exec', 'code': '''
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=0.03); me = bpy.data.meshes.new("pearl")
bm.to_mesh(me); bm.free()
pearl = bpy.data.objects.new("Pearl", me); bpy.context.scene.collection.objects.link(pearl)
pearl.location = (0, 0, 0.2); pearl.parent = bpy.data.objects["Utah Teapot"]
twin = bpy.data.objects["Teapot Lid"].copy(); twin.name = "Teapot Lid Twin"; bpy.context.scene.collection.objects.link(twin)
twin.location.x += 0.4
'''})
lid_id = by['Teapot Lid']['id']
glb2 = os.path.join(HOME, 'teapot_pearl.glb')
r = hb.handle({'cmd': 'export_glb', 'path': glb2, 'mode': 'preview'})
parts = {p['name']: p for p in r['parts']}
check('a copied part gets its own id; the original keeps its', r['ok'] and parts['Teapot Lid']['id'] == lid_id and
      parts['Teapot Lid Twin']['id'] != lid_id, {n: p['id'] for n, p in parts.items()})
j2, _ = read_glb(glb2)
pearl_node = next(n for n in j2['nodes'] if n['name'] == 'Pearl')
body_node = next(n for n in j2['nodes'] if n['name'] == 'Teapot Body')
prim = j2['meshes'][pearl_node['mesh']]['primitives'][0]
nv = len(bpy.data.objects['Pearl'].data.vertices)
check('a plain part exports _VID and holo_vidok/holo_nv', '_VID' in prim['attributes'] and
      pearl_node['extras'].get('holo_vidok') is True and pearl_node['extras'].get('holo_nv') == nv, (prim['attributes'], pearl_node.get('extras')))
check('a part with modifiers has no _VID', '_VID' not in j2['meshes'][body_node['mesh']]['primitives'][0]['attributes'] and
      'holo_vidok' not in body_node.get('extras', {}))
check('_vid and its props are gone again afterwards', '_vid' not in bpy.data.objects['Pearl'].data.attributes and
      'holo_vidok' not in bpy.data.objects['Pearl'])
one = hb.handle({'cmd': 'export_glb', 'path': os.path.join(HOME, 'one.glb'), 'mode': 'final', 'only': [parts['Pearl']['id']]})
jo, _ = read_glb(os.path.join(HOME, 'one.glb'))
check('only= exports that part (under its parent) and nothing else', one['ok'] and [p['name'] for p in one['parts']] == ['Pearl']
      and sorted(n['name'] for n in jo['nodes']) == ['Pearl', 'Utah Teapot'], [n['name'] for n in jo['nodes']])

# the working autosave keeps painted images, and clear_scene empties everything
hb.handle({'cmd': 'exec', 'code': '''
img = bpy.data.images.new("glaze_paint", 8, 8)
img.pixels.foreach_set([0.25, 0.5, 0.75, 1.0] * 64)
m = bpy.data.materials.new("Painted"); t = m.node_tree.nodes.new("ShaderNodeTexImage"); t.image = img
bpy.data.objects["Pearl"].data.materials.append(m)
'''})
work = os.path.join(HOME, 'working', 'current.blend')
r = hb.handle({'cmd': 'save_working', 'path': work})
check('save_working writes the autosave', r['ok'] and os.path.getsize(work) > 1000 and r['packed'] >= 1, r)
r = hb.handle({'cmd': 'clear_scene'})
check('clear_scene empties the scene and its data', r['ok'] and len(bpy.data.objects) == 0 and len(bpy.data.meshes) == 0
      and len(bpy.data.materials) == 0 and not [i for i in bpy.data.images if i.source != 'VIEWER'],
      [len(bpy.data.objects), len(bpy.data.meshes), len(bpy.data.materials), [i.name for i in bpy.data.images]])
r = hb.handle({'cmd': 'export_glb', 'path': os.path.join(HOME, 'empty.glb'), 'mode': 'final'})
check('an empty scene exports nothing and says so', r['ok'] and r['empty'] and r['parts'] == [] and
      r['skipped'] == [] and not os.path.exists(os.path.join(HOME, 'empty.glb')), r)

# glTF has no mesh for a metaball: it vanishes from the web while Fable's renders still show it, so say so
hb.handle({'cmd': 'exec', 'code': 'bpy.ops.object.metaball_add(location=(0, 0, 0))\n'
                                  'bpy.ops.mesh.primitive_cube_add(size=0.2, location=(1, 0, 0))'})
r = hb.handle({'cmd': 'export_glb', 'path': os.path.join(HOME, 'meta.glb'), 'mode': 'final'})
check('a metaball is reported as skipped, not silently dropped',
      r['ok'] and [p['name'] for p in r['parts']] == ['Cube'] and [s['type'] for s in r['skipped']] == ['META'], r)
hb.handle({'cmd': 'clear_scene'})
r = hb.handle({'cmd': 'restore', 'path': work})
img = bpy.data.images.get('glaze_paint')
px = list(img.pixels[:4]) if img else []
check('the autosave reopens with the painted image packed in', r['ok'] and 'Pearl' in bpy.data.objects and img is not None
      and img.packed_file is not None and abs(px[0] - 0.25) < 0.01 and abs(px[2] - 0.75) < 0.01, px)
n_scenes, n_objs = len(bpy.data.scenes), len(bpy.data.objects)
r = hb.handle({'cmd': 'warm_up'})
check('warm_up exports and renders a throwaway scene, and cleans it up', r['ok'] and 'render_error' not in r and
      len(bpy.data.scenes) == n_scenes and len(bpy.data.objects) == n_objs, r)

# ---------------------------------------------------------------- the socket server
token = 'test-token-' + 'x' * 16
port = hb.start_server(port=0, token=token, advertise=False)
check('a headless server picks a free port and writes no bridge.json', port > 0 and not os.path.exists(hb.BRIDGE_FILE))
answers = {}


def client(tok, key, cmd='ping', extra=None):
    s = socket.create_connection(('127.0.0.1', port), timeout=10)
    s.sendall((json.dumps({'id': 7, 'token': tok, 'cmd': cmd, **(extra or {})}) + '\n').encode())
    answers[key] = json.loads(s.makefile('rb').readline())
    s.close()


stop = threading.Event()


def session():
    client(token, 'good', 'scene')
    client('wrong', 'bad')
    client(token, 'fast')   # ping, from the cache
    client(token, 'expired', 'add', {'shape': 'box', 'deadline': time.time() * 1000 - 1})
    stop.set()
    hb.wake()


n_before = len(bpy.data.objects)
th = threading.Thread(target=session)
th.start()
t = time.time()
hb.serve_headless(stop)   # the headless main loop, on this (the main) thread, until session() stops it
th.join(5)
check('serve_headless answers and stops when told', not th.is_alive() and time.time() - t < 10)
check('socket request with the token works', answers.get('good', {}).get('ok') and answers['good'].get('id') == 7, answers.get('good'))
check('socket request with a wrong token is refused', answers.get('bad', {}).get('error') == 'bad token', answers.get('bad'))
check('ping answers from the cache', answers.get('fast', {}).get('ok') and 'blender' in answers['fast'], answers.get('fast'))
check('expired jobs are dropped', not answers.get('expired', {}).get('ok') and 'expired' in answers['expired'].get('error', '')
      and len(bpy.data.objects) == n_before, answers.get('expired'))
hb.stop_server()
# a normal Blender with the add-on still advertises itself in bridge.json, and cleans up after itself
port = hb.start_server(hb.PORT, advertise=True)
with open(hb.BRIDGE_FILE) as f:
    info = json.load(f)
check('an advertised server writes bridge.json', info.get('port') == port and info.get('pid') == os.getpid(), info)
hb.unregister()
check('unregister removes the connection file', not os.path.exists(hb.BRIDGE_FILE))

shutil.rmtree(HOME, ignore_errors=True)
print(f'RESULT {"OK" if not failures else "FAILED: " + ", ".join(failures)}')
sys.exit(1 if failures else 0)
