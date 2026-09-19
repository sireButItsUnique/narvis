"""Holo Modeler bridge: lets the Holo Modeler app on this computer build and edit models in the open Blender.

The app connects to 127.0.0.1 (port in ~/.holomodel/bridge.json, with a per-session token) and sends one JSON
request per line. Requests run on Blender's main thread, one at a time:
  ping, scene            what's open and what's in it
  exec {code, label}     run AI-written modelling code (bpy/bmesh/mathutils/numpy only), as one undo step
  render {views, objects, size}   PNG previews so the AI can look at what it built
  undo, redo, mode, brush, brush_size, symmetry, focus, delete   voice commands
"""
import base64
import builtins
import contextlib
import io
import json
import math
import os
import queue
import random
import re
import secrets
import socket
import tempfile
import threading
import time
import traceback

import bmesh
import bpy
import mathutils

PORT = 9876
BRIDGE_FILE = os.path.join(os.path.expanduser('~'), '.holomodel', 'bridge.json')

# ---------------------------------------------------------------- sandbox for AI-written code
# Not a security boundary against a determined attacker (the only author is the user's own request); it stops
# modelling code from touching files, the network, the OS or Blender's settings by mistake.
ALLOWED_IMPORTS = {'bpy', 'bmesh', 'mathutils', 'math', 'random', 'numpy', 'colorsys', 'itertools', 'functools',
                   'collections', 'dataclasses', 'typing', 're', 'string', 'bpy_extras', 'statistics', 'copy', 'enum'}
BLOCKED = [
    (r'\bbpy\.ops\.(wm|preferences|extensions|script|screen\.userpref_show)\b', 'window-manager, preferences and script operators'),
    (r'\bbpy\.app\.(handlers|timers)\b', 'handlers and timers'),
    (r'\bbpy\.(utils|data\.libraries)\b', 'bpy.utils and library loading'),
    (r'__(subclasses|globals|builtins|code|import|loader|spec|bases|mro|dict)__', 'Python internals'),
    (r'\b(os|sys|subprocess|shutil|ctypes|pathlib|importlib|urllib|http|requests)\b\s*\.', 'OS, file and network modules'),
]
_NO_BUILTINS = {'open', 'exec', 'eval', 'compile', 'input', 'breakpoint', '__import__', 'exit', 'quit', 'help',
                'globals', 'locals', 'vars', 'memoryview', '__loader__', '__spec__'}


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name.split('.')[0] not in ALLOWED_IMPORTS:
        raise ImportError(f"'{name}' isn't available here. Allowed: {', '.join(sorted(ALLOWED_IMPORTS))}")
    return builtins.__import__(name, globals, locals, fromlist, level)


SAFE_BUILTINS = {k: getattr(builtins, k) for k in dir(builtins) if k not in _NO_BUILTINS}
SAFE_BUILTINS['__import__'] = _safe_import


def _blocked(code):
    for pattern, what in BLOCKED:
        m = re.search(pattern, code)
        if m:
            return f'{what} ("{m.group(0)}")'
    return None


# ---------------------------------------------------------------- helpers
def _view3d_override():
    """Context for operators that need a window and 3D viewport (mode switching, view framing, undo)."""
    wm = bpy.context.window_manager
    for win in wm.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                region = next((r for r in area.regions if r.type == 'WINDOW'), None)
                return {'window': win, 'screen': win.screen, 'area': area, 'region': region}
    return {'window': wm.windows[0]} if wm.windows else {}


def _r(v, n=3):
    return [round(x, n) for x in v]


def _describe(o):
    d = {'name': o.name, 'type': o.type, 'location': _r(o.location), 'dimensions': _r(o.dimensions),
         'collection': o.users_collection[0].name if o.users_collection else None,
         'parent': o.parent.name if o.parent else None}
    if o.type == 'MESH':
        d.update(verts=len(o.data.vertices), faces=len(o.data.polygons))
    if o.modifiers:
        d['modifiers'] = [f'{m.name} ({m.type})' for m in o.modifiers]
    mats = [s.material.name for s in getattr(o, 'material_slots', []) if s.material]
    if mats:
        d['materials'] = mats
    return d


def _scene_summary(limit=80):
    objs = [o for o in bpy.context.scene.objects if not o.name.startswith('_holo_')]
    return {'object_count': len(objs), 'mode': bpy.context.mode,
            'active': bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,
            'objects': [_describe(o) for o in objs[:limit]], 'truncated': max(0, len(objs) - limit)}


def _short_traceback(code):
    """Just the frames inside the AI's code, with the offending source line."""
    lines = code.splitlines()
    tb = traceback.extract_tb(__import__('sys').exc_info()[2])
    parts = []
    for fr in tb:
        if fr.filename == '<holomodel>':
            src = lines[fr.lineno - 1].strip() if 0 < fr.lineno <= len(lines) else ''
            parts.append(f'line {fr.lineno}: {src}')
    etype, evalue = __import__('sys').exc_info()[:2]
    if isinstance(evalue, SyntaxError) and evalue.lineno:
        parts.append(f'line {evalue.lineno}: {(evalue.text or "").strip()}')
    exc = traceback.format_exception_only(etype, evalue)[-1].strip()
    return '\n'.join(parts[-6:] + [exc])


def _undo_push(label):
    try:
        with bpy.context.temp_override(**_view3d_override()):
            bpy.ops.ed.undo_push(message=label)
    except Exception:
        pass


def _target_mesh():
    """The mesh voice commands act on: the active one, else the selected one, else the newest."""
    vl = bpy.context.view_layer
    ob = vl.objects.active
    if ob and ob.type == 'MESH':
        return ob
    sel = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    if sel:
        return sel[0]
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('_holo_')]
    return meshes[-1] if meshes else None


# ---------------------------------------------------------------- commands
def cmd_ping(req):
    return {'ok': True, 'blender': bpy.app.version_string, 'file': bpy.data.filepath or '(unsaved)',
            'objects': len(bpy.context.scene.objects)}


def cmd_scene(req):
    return {'ok': True, **_scene_summary()}


def cmd_exec(req):
    code, label = str(req.get('code', '')), str(req.get('label') or 'Holo Modeler')[:60]
    bad = _blocked(code)
    if bad:
        return {'ok': False, 'error': f'Not allowed here: {bad}. Build with bpy/bmesh/mathutils/numpy only; '
                                      'no files, network, OS or Blender settings.'}
    if bpy.context.mode != 'OBJECT':   # modelling code expects object mode
        with bpy.context.temp_override(**_view3d_override()):
            try:
                bpy.ops.object.mode_set(mode='OBJECT')
            except Exception:
                pass
    before = set(bpy.data.objects.keys())
    out = io.StringIO()
    ns = {'__builtins__': SAFE_BUILTINS, '__name__': '__main__', 'bpy': bpy, 'bmesh': bmesh,
          'mathutils': mathutils, 'math': math, 'random': random, 'Vector': mathutils.Vector,
          'Matrix': mathutils.Matrix, 'Euler': mathutils.Euler, 'Color': mathutils.Color}
    ok, err = True, None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out), \
                bpy.context.temp_override(**_view3d_override()):
            exec(compile(code, '<holomodel>', 'exec'), ns)
    except Exception:
        ok, err = False, _short_traceback(code)
    new = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
    _undo_push(f'Holo: {label}')
    return {'ok': ok, 'error': err, 'output': out.getvalue()[-4000:],
            'new_objects': [_describe(o) for o in new][:60], 'scene': _scene_summary(40)}


VIEWS = {
    'front': (0, -1, 0.18), 'three_quarter': (1, -1, 0.7), 'side': (1, 0, 0.18), 'left': (-1, 0, 0.18),
    'back': (0, 1, 0.18), 'top': (0, -0.001, 1),
}
RENDERABLE = {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'CURVES', 'POINTCLOUD', 'VOLUME', 'GREASEPENCIL'}


def cmd_render(req):
    """Render PNG previews of the model from a few angles with a temporary camera (and lights, if the scene has none)."""
    views = [v for v in (req.get('views') or ['three_quarter']) if v in VIEWS][:4] or ['three_quarter']
    size = int(min(1024, max(256, int(req.get('size') or 640))))
    names = set(req.get('objects') or [])
    scene = bpy.context.scene
    objs = [o for o in scene.objects if o.type in RENDERABLE and o.visible_get() and not o.name.startswith('_holo_')
            and (not names or o.name in names)]
    if not objs:
        return {'ok': False, 'error': 'nothing visible to render' + (f' named {sorted(names)}' if names else '')}
    corners = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box]
    lo = mathutils.Vector([min(c[i] for c in corners) for i in range(3)])
    hi = mathutils.Vector([max(c[i] for c in corners) for i in range(3)])
    centre, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1e-3)

    r = scene.render
    saved = {'engine': r.engine, 'x': r.resolution_x, 'y': r.resolution_y, 'pct': r.resolution_percentage,
             'path': r.filepath, 'fmt': r.image_settings.file_format, 'depth': r.image_settings.color_depth,
             'media': getattr(r.image_settings, 'media_type', None), 'camera': scene.camera,
             'transparent': r.film_transparent, 'world': scene.world}
    samples = getattr(scene.eevee, 'taa_render_samples', None)
    made = []   # temporary datablocks to remove afterwards
    cam_data = bpy.data.cameras.new('_holo_cam')
    cam = bpy.data.objects.new('_holo_cam', cam_data)
    scene.collection.objects.link(cam)
    made += [cam, cam_data]
    if not any(o.type == 'LIGHT' and o.visible_get() for o in scene.objects):
        for name, energy, rot in (('_holo_key', 3.5, (0.8, 0.2, 0.6)), ('_holo_fill', 1.2, (1.1, 0.0, -2.4))):
            ld = bpy.data.lights.new(name, 'SUN')
            ld.energy = energy
            lo_ = bpy.data.objects.new(name, ld)
            lo_.rotation_euler = rot
            scene.collection.objects.link(lo_)
            made += [lo_, ld]
    if scene.world is None:
        w = bpy.data.worlds.new('_holo_world')
        w.color = (0.2, 0.2, 0.22)
        scene.world = w
        made.append(w)

    images = []
    try:
        r.engine = 'BLENDER_EEVEE'
        r.resolution_x = r.resolution_y = size
        r.resolution_percentage = 100
        if saved['media'] is not None:   # a video or multilayer-EXR output can't be switched straight to PNG
            r.image_settings.media_type = 'IMAGE'
        r.image_settings.file_format = 'PNG'
        r.film_transparent = False
        if samples is not None:
            scene.eevee.taa_render_samples = 16
        cam_data.lens = 50
        cam_data.clip_start = radius * 0.001
        cam_data.clip_end = radius * 100 + 10
        scene.camera = cam
        dist = radius / math.sin(cam_data.angle / 2) * 1.08
        for view in views:
            d = mathutils.Vector(VIEWS[view]).normalized()
            cam.location = centre + d * dist
            cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
            fd, path = tempfile.mkstemp(suffix='.png')
            os.close(fd)
            try:
                r.filepath = path
                bpy.ops.render.render(write_still=True)
                with open(path, 'rb') as f:
                    images.append({'view': view, 'png': base64.b64encode(f.read()).decode()})
            finally:
                os.remove(path)
    finally:
        r.engine, r.resolution_x, r.resolution_y = saved['engine'], saved['x'], saved['y']
        r.resolution_percentage, r.filepath = saved['pct'], saved['path']
        if saved['media'] is not None:
            r.image_settings.media_type = saved['media']
        r.image_settings.file_format, r.film_transparent = saved['fmt'], saved['transparent']
        r.image_settings.color_depth = saved['depth']   # after the format, which is what makes the depth valid
        scene.camera, scene.world = saved['camera'], saved['world']
        if samples is not None:
            scene.eevee.taa_render_samples = samples
        for block in made:   # objects first, then their data (a sun is a SunLight, hence isinstance)
            for kind, coll in ((bpy.types.Object, bpy.data.objects), (bpy.types.Camera, bpy.data.cameras),
                               (bpy.types.Light, bpy.data.lights), (bpy.types.World, bpy.data.worlds)):
                if isinstance(block, kind):
                    coll.remove(block)
                    break
    return {'ok': True, 'images': images, 'framed': [o.name for o in objs][:40]}


def cmd_undo(req):
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.ed.undo() if req.get('cmd') == 'undo' else bpy.ops.ed.redo()
    return {'ok': True}


def cmd_mode(req):
    mode = {'object': 'OBJECT', 'edit': 'EDIT', 'sculpt': 'SCULPT'}.get(str(req.get('mode')).lower())
    ob = _target_mesh()
    if not mode or not ob:
        return {'ok': False, 'error': 'nothing to switch' if not ob else f"unknown mode {req.get('mode')}"}
    with bpy.context.temp_override(**_view3d_override()):
        if bpy.context.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        for o in bpy.context.selected_objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode=mode)
    return {'ok': True, 'object': ob.name, 'mode': mode.lower()}


def cmd_brush(req):
    name = str(req.get('name'))
    if bpy.context.mode != 'SCULPT':
        res = cmd_mode({'mode': 'sculpt'})
        if not res['ok']:
            return res
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.brush.asset_activate(asset_library_type='ESSENTIALS',
                                     relative_asset_identifier=f'brushes/essentials_brushes-mesh_sculpt.blend/Brush/{name}')
    b = bpy.context.tool_settings.sculpt.brush
    return {'ok': True, 'brush': b.name if b else name}


def cmd_brush_size(req):
    sculpt = bpy.context.tool_settings.sculpt
    b = sculpt.brush
    if not b:
        return {'ok': False, 'error': 'no sculpt brush active (say "sculpt mode" first)'}
    ups = getattr(sculpt, 'unified_paint_settings', None)
    owner = ups if ups is not None and ups.use_unified_size else b   # whichever size is actually in effect
    owner.size = int(min(500, max(5, round(owner.size * float(req.get('factor', 1))))))
    return {'ok': True, 'size': owner.size}


def cmd_symmetry(req):
    ob = _target_mesh()
    if not ob:
        return {'ok': False, 'error': 'no mesh to mirror'}
    ob.data.use_mirror_x = bool(req.get('on'))   # what mesh sculpting (and edit mode) actually uses
    return {'ok': True, 'on': ob.data.use_mirror_x, 'object': ob.name}


def cmd_focus(req):
    with bpy.context.temp_override(**_view3d_override()):
        if bpy.context.selected_objects or bpy.context.mode != 'OBJECT':
            bpy.ops.view3d.view_selected()
        else:
            bpy.ops.view3d.view_all()
    return {'ok': True}


def cmd_delete(req):
    with bpy.context.temp_override(**_view3d_override()):
        if bpy.context.mode == 'EDIT_MESH':   # delete the selected geometry, not the whole object
            v, e, f = bpy.context.tool_settings.mesh_select_mode
            bpy.ops.mesh.delete(type='FACE' if f else 'EDGE' if e else 'VERT')
            names = [bpy.context.edit_object.name + ' (selection)']
        else:
            if bpy.context.mode != 'OBJECT':
                bpy.ops.object.mode_set(mode='OBJECT')
            names = [o.name for o in bpy.context.selected_objects]
            if names:
                bpy.ops.object.delete()
    if names:
        _undo_push('Holo: delete ' + ', '.join(names)[:48])
    return {'ok': True, 'deleted': names}


def cmd_add(req):
    """"add a cube": a plain primitive at the 3D cursor, sized to what's already in the scene."""
    shape = str(req.get('shape'))
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('_holo_')]
    s = 0.35 * max((max(o.dimensions) for o in objs), default=0) or 1.0
    at = bpy.context.scene.cursor.location
    make = {
        'box': lambda: bpy.ops.mesh.primitive_cube_add(size=s, location=at),
        'sphere': lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=s / 2, location=at),
        'capsule': lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=s / 3, location=at, scale=(1, 1, 1.8)),
        'cylinder': lambda: bpy.ops.mesh.primitive_cylinder_add(radius=s / 2, depth=s, location=at),
        'cone': lambda: bpy.ops.mesh.primitive_cone_add(radius1=s / 2, depth=s, location=at),
        'torus': lambda: bpy.ops.mesh.primitive_torus_add(major_radius=s * 0.4, minor_radius=s * 0.12, location=at),
    }.get(shape)
    if not make:
        return {'ok': False, 'error': f'unknown shape {shape}'}
    with bpy.context.temp_override(**_view3d_override()):
        if bpy.context.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        make()
    _undo_push(f'Holo: add {shape}')
    return {'ok': True, 'object': bpy.context.view_layer.objects.active.name}


COMMANDS = {'ping': cmd_ping, 'scene': cmd_scene, 'exec': cmd_exec, 'render': cmd_render, 'undo': cmd_undo,
            'redo': cmd_undo, 'mode': cmd_mode, 'brush': cmd_brush, 'brush_size': cmd_brush_size,
            'symmetry': cmd_symmetry, 'focus': cmd_focus, 'delete': cmd_delete, 'add': cmd_add}


def handle(req):
    cmd = req.get('cmd') if isinstance(req, dict) else None
    fn = COMMANDS.get(cmd) if isinstance(cmd, str) else None
    if not fn:
        return {'ok': False, 'error': f'unknown command {cmd!r}'}
    try:
        return fn(req)
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


# ---------------------------------------------------------------- server: socket thread -> main-thread timer
_jobs = queue.Queue()
_state = {'sock': None, 'token': None, 'running': False}


def _pump():
    """Runs on Blender's main thread: bpy is only safe to use here."""
    try:
        _state['ping'] = cmd_ping({})   # answered straight from the socket thread, even while a job runs
    except Exception:
        pass
    wm = bpy.context.window_manager
    if any(w.modal_operators for w in wm.windows):   # a sculpt stroke, drag or orbit is in progress: wait for it
        return 0.05
    while True:
        try:
            req, reply = _jobs.get_nowait()
        except queue.Empty:
            break
        deadline = req.get('deadline') if isinstance(req, dict) else None
        if isinstance(deadline, (int, float)) and time.time() * 1000 > deadline:
            reply.put({'ok': False, 'error': 'expired: the app stopped waiting'})
            continue
        try:
            reply.put(handle(req))
        except Exception as e:   # handle() catches command errors; this is the last line of defence
            reply.put({'ok': False, 'error': f'{type(e).__name__}: {e}'})
    return 0.05


def _serve_client(conn):
    with conn:
        f = conn.makefile('rwb')
        for line in f:
            req = None
            try:
                req = json.loads(line)
            except ValueError:
                resp = {'ok': False, 'error': 'bad JSON'}
            else:
                if not isinstance(req, dict) or req.get('token') != _state['token']:
                    resp = {'ok': False, 'error': 'bad token'}
                elif req.get('cmd') == 'ping' and _state.get('ping'):
                    resp = dict(_state['ping'])   # don't queue behind a long build just to say hello
                else:
                    reply = queue.Queue()
                    _jobs.put((req, reply))
                    try:
                        resp = reply.get(timeout=600)
                    except queue.Empty:
                        resp = {'ok': False, 'error': 'Blender took too long'}
            resp['id'] = req.get('id') if isinstance(req, dict) else None
            f.write((json.dumps(resp) + '\n').encode())
            f.flush()


def _accept_loop(sock):
    while _state['running']:
        try:
            conn, _ = sock.accept()
        except OSError:
            break
        threading.Thread(target=_serve_client, args=(conn,), daemon=True).start()


def _other_bridge_alive(own_port):
    """Is bridge.json advertising a different Blender that still answers?"""
    try:
        with open(BRIDGE_FILE) as f:
            info = json.load(f)
        # our own file, or its port is the one we just bound (so whoever wrote it is gone)
        if info.get('pid') == os.getpid() or int(info['port']) == own_port:
            return False
        socket.create_connection(('127.0.0.1', int(info['port'])), timeout=0.3).close()
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _start_server():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    port = PORT
    for port in range(PORT, PORT + 10):   # another Blender may already have the first port
        try:
            sock.bind(('127.0.0.1', port))
            break
        except OSError:
            continue
    sock.listen(4)
    _state.update(sock=sock, token=secrets.token_hex(16), running=True)
    os.makedirs(os.path.dirname(BRIDGE_FILE), exist_ok=True)
    if _other_bridge_alive(port):
        print('Holo Modeler bridge: another Blender already has the connection; this one stays unlisted')
    else:
        with open(BRIDGE_FILE, 'w') as f:
            json.dump({'port': port, 'token': _state['token'], 'pid': os.getpid(), 'blender': bpy.app.version_string}, f)
    threading.Thread(target=_accept_loop, args=(sock,), daemon=True).start()
    print(f'Holo Modeler bridge listening on 127.0.0.1:{port}')


def register():
    if bpy.app.background:   # command-line Blender (installs, batch renders) can't serve requests
        return
    # the hand mouse moves the real cursor: stop Blender warping it back to the other side of the screen mid-drag
    _state['prev_continuous'] = bpy.context.preferences.inputs.use_mouse_continuous
    bpy.context.preferences.inputs.use_mouse_continuous = False
    _start_server()
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, persistent=True)


def unregister():
    prev = _state.pop('prev_continuous', None)
    if prev is not None:
        bpy.context.preferences.inputs.use_mouse_continuous = prev
    _state['running'] = False
    if _state['sock']:
        _state['sock'].close()
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    try:
        with open(BRIDGE_FILE) as f:
            ours = json.load(f).get('pid') == os.getpid()
        if ours:   # (Windows can't delete a file that's still open, so close it first)
            os.remove(BRIDGE_FILE)
    except (OSError, ValueError):
        pass
