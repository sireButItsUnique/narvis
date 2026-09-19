"""Holo Modeler bridge: the Holo Modeler app's way into Blender.

The app's server runs its own hidden Blender (blender -b, started by server/blender-process.js through
blender/headless.py) and talks to it over 127.0.0.1 with a token it passes in the environment. Installed as an
add-on in a normal Blender, the same bridge still starts (port in ~/.holomodel/bridge.json), but the app no
longer uses that. One JSON request per line; requests run on Blender's main thread, one at a time:
  ping, scene            what's open and what's in it
  exec {code, label}     run AI-written modelling code (bpy/bmesh/mathutils/numpy only), as one undo step
  render {views, objects, size}   PNG previews so the AI can look at what it built
  undo, redo, delete, add         small scene edits
  snapshot {path}, restore {path}, fingerprint   version history (a copy of the scene; opening one; has it changed)
  export_glb, clear_scene, save_working, warm_up   what the web gets (webio.py)
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
import types

import bmesh
import bpy
import mathutils

PORT = 9876
BRIDGE_FILE = os.path.join(os.environ.get('HOLOMODEL_HOME') or os.path.join(os.path.expanduser('~'), '.holomodel'), 'bridge.json')

# ---------------------------------------------------------------- sandbox for AI-written code
# Not a security boundary against a determined attacker (the only author is the user's own request, but web pages
# Fable reads can try to steer it); it stops modelling code from touching files, the network, the OS or Blender's
# settings by mistake.
ALLOWED_IMPORTS = {'bpy', 'bmesh', 'mathutils', 'math', 'random', 'numpy', 'colorsys', 'itertools', 'functools',
                   'collections', 'dataclasses', 'typing', 're', 'string', 'bpy_extras', 'statistics', 'copy', 'enum'}
BLOCKED = [
    (r'\bbpy\.ops\.(wm|preferences|extensions|script|file|text|sound|sequencer|ptcache|fluid|cachefile'
     r'|screen\.userpref_show)\b', 'window-manager, preferences, file and script operators'),
    (r'\bbpy\.ops\.(export_\w+|import_\w+)', 'import and export operators'),
    (r'\bbpy\.ops\.image\.(save\w*|external_edit)\b', 'saving images'),
    (r'\bbpy\.ops\.render\.(render|opengl|play_rendered_anim|view_show)\b', 'rendering'),
    (r'\.(save|save_render)\s*\(|\bfilepath_raw\b|\bsave_mode\b', 'writing image files'),
    (r'\b(np|numpy)\s*\.\s*(save\w*|load\w*|genfromtxt|fromfile|fromregex|memmap|DataSource|recfromtxt|recfromcsv)\b'
     r'|\.tofile\s*\(', 'reading and writing files with numpy'),
    (r'\bbpy\.app\.(handlers|timers)\b', 'handlers and timers'),
    (r'\bbpy\.(utils|data\.libraries)\b', 'bpy.utils and library loading'),
    (r'__(subclasses|globals|builtins|code|import|loader|spec|bases|mro|dict)__', 'Python internals'),
    (r'\b(os|sys|subprocess|shutil|ctypes|pathlib|importlib|urllib|http|requests)\b\s*\.', 'OS, file and network modules'),
]
_NO_BUILTINS = {'open', 'exec', 'eval', 'compile', 'input', 'breakpoint', '__import__', 'exit', 'quit', 'help',
                'globals', 'locals', 'vars', 'memoryview', '__loader__', '__spec__'}

# the same operator rules at run time, so `ops = bpy.ops` or getattr() can't walk around the text check
_BLOCKED_OP_MODULES = {'wm', 'preferences', 'extensions', 'script', 'file', 'text', 'sound', 'sequencer', 'ptcache',
                       'fluid', 'cachefile'}
_BLOCKED_OPS = {'image': re.compile(r'^(save\w*|external_edit)$'), 'render': re.compile(r'^(render|opengl|play_rendered_anim|view_show)$'),
                'screen': re.compile(r'^userpref_show$')}


def _no_op(name):
    raise PermissionError(f"bpy.ops.{name} isn't available here: build with bpy/bmesh/mathutils/numpy only; "
                          'no files, network, OS or Blender settings.')


class _OpsModule:
    def __init__(self, name, real):
        self._name, self._real = name, real

    def __getattr__(self, op):
        if _BLOCKED_OPS[self._name].match(op):
            _no_op(f'{self._name}.{op}')
        return getattr(self._real, op)

    def __dir__(self):
        return dir(self._real)


class _Ops:
    def __getattr__(self, name):
        if name in _BLOCKED_OP_MODULES or name.startswith(('export_', 'import_')):
            _no_op(name)
        real = getattr(bpy.ops, name)
        return _OpsModule(name, real) if name in _BLOCKED_OPS else real

    def __dir__(self):
        return dir(bpy.ops)


class _Bpy(types.ModuleType):
    """bpy as AI code sees it: everything is the real thing except bpy.ops, which goes through _Ops."""
    def __getattr__(self, name):
        return _OPS if name == 'ops' else getattr(bpy, name)

    def __dir__(self):
        return dir(bpy)


_OPS = _Ops()
_BPY = _Bpy('bpy')

# The same idea for the other modules. numpy's file helpers (savetxt, loadtxt, genfromtxt) are pure Python and look
# `open` up in numpy's own globals, not the caller's, so stripping builtins doesn't stop them; and a module's
# __builtins__ hands back the real `open` whatever the text rules say. getattr(np, 'save' + 'txt') walks around a
# name pattern, so the module object AI code gets has to be the one that refuses.
_NUMPY_FILE_IO = frozenset({'save', 'savez', 'savez_compressed', 'savetxt', 'load', 'loadtxt', 'genfromtxt',
                            'fromfile', 'fromregex', 'memmap', 'DataSource', 'recfromtxt', 'recfromcsv',
                            'ctypeslib', 'f2py', 'distutils'})
_DENIED_ATTRS = frozenset({'__builtins__', '__globals__'})
_MODULE_DENY = {'numpy': _NUMPY_FILE_IO}
_REAL = {}        # guarded module name -> the real module, kept off the wrapper so AI code can't read it back
_GUARDED = {}


class _Guarded(types.ModuleType):
    """A module as AI code sees it: names that reach the filesystem raise, and submodules come back guarded too."""

    def __getattr__(self, name):
        if name in _DENIED_ATTRS or name in _MODULE_DENY.get(self.__name__.split('.')[0], ()):
            raise PermissionError(f"{self.__name__}.{name} isn't available here: build in memory with "
                                  'bpy/bmesh/mathutils/numpy; no files, network or OS.')
        value = getattr(_REAL[self.__name__], name)
        return _guard(value) if isinstance(value, types.ModuleType) else value

    def __dir__(self):
        deny = _DENIED_ATTRS | _MODULE_DENY.get(self.__name__.split('.')[0], frozenset())
        return [n for n in dir(_REAL[self.__name__]) if n not in deny]


def _guard(module):
    name = module.__name__
    if _REAL.get(name) is not module:   # a reload would leave the old one behind
        _REAL[name] = module
        _GUARDED[name] = _Guarded(name)
    return _GUARDED[name]


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name.split('.')[0] not in ALLOWED_IMPORTS:
        raise ImportError(f"'{name}' isn't available here. Allowed: {', '.join(sorted(ALLOWED_IMPORTS))}")
    if name == 'bpy' or (name.startswith('bpy.') and not fromlist):
        return _BPY
    if name == 'bpy.ops' or name.startswith('bpy.ops.'):   # from bpy.ops import ...
        return _OPS if name == 'bpy.ops' else getattr(_OPS, name.split('.')[2])
    return _guard(builtins.__import__(name, globals, locals, fromlist, level))


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


def _object_mode():
    if bpy.context.mode != 'OBJECT':   # edit-mode changes only reach the mesh data in object mode
        with bpy.context.temp_override(**_view3d_override()):
            bpy.ops.object.mode_set(mode='OBJECT')


def pack_images():
    """Pack every image into the .blend, so snapshots and GLBs carry their textures: generate_texture writes files
    outside the scene, and numpy-painted or baked images only live in memory until packed."""
    packed = 0
    for img in bpy.data.images:
        if img.type in {'RENDER_RESULT', 'COMPOSITING'} or img.packed_file:   # (painted ones say UV_TEST)
            continue
        if img.source == 'FILE' and not os.path.exists(bpy.path.abspath(img.filepath)):
            continue
        if img.source not in {'FILE', 'GENERATED'}:
            continue
        try:
            img.pack()
            packed += 1
        except RuntimeError:
            pass   # e.g. a generated image that never got pixels
    return packed


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
    ns = {'__builtins__': SAFE_BUILTINS, '__name__': '__main__', 'bpy': _BPY, 'bmesh': bmesh,
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
    # the same objects the web gets (webio.export_set): a hide_render helper mustn't set the framing
    objs = [o for o in scene.objects if o.type in RENDERABLE and o.visible_get() and not o.hide_render
            and not o.name.startswith('_holo_') and (not names or o.name in names)]
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


_SIMPLE_PROPS = {'BOOLEAN', 'INT', 'FLOAT', 'ENUM', 'STRING'}
_RUNTIME_PROPS = {'rna_type', 'session_uid', 'users', 'tag', 'use_extra_user'}   # differ after a reload


def _hash_rna(h, struct):
    """Feed a datablock's plain settings (numbers, flags, names) into the hash."""
    for p in struct.bl_rna.properties:
        if p.type in _SIMPLE_PROPS and p.identifier not in _RUNTIME_PROPS and not p.identifier.startswith('is_'):
            try:
                v = getattr(struct, p.identifier)
            except Exception:
                continue
            h.update(repr(tuple(v) if hasattr(v, '__len__') and not isinstance(v, str) else v).encode())


def _fingerprint():
    """A short hash of what's in the scene (geometry, transforms, modifiers, materials, lights), so the app can tell
    whether anything changed since a version was saved."""
    import hashlib
    import numpy as np
    h = hashlib.sha1()
    for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if o.name.startswith('_holo_'):
            continue
        if o.mode == 'EDIT':
            o.update_from_editmode()
        h.update(f'{o.name}|{o.type}|{o.parent.name if o.parent else ""}|{o.hide_get()}|'.encode())
        h.update(np.array(o.matrix_world, dtype=np.float32).tobytes())
        for m in o.modifiers:
            _hash_rna(h, m)
        d = o.data
        if o.type == 'MESH':
            co = np.empty(len(d.vertices) * 3, dtype=np.float32)
            d.vertices.foreach_get('co', co)
            h.update(f'{len(d.vertices)}|{len(d.edges)}|{len(d.polygons)}|'.encode())
            h.update(co.tobytes())
        elif o.type == 'CURVE':
            for s in d.splines:
                for p in list(s.bezier_points) + list(s.points):
                    h.update(np.array(p.co, dtype=np.float32).tobytes())
        if d is not None:
            _hash_rna(h, d)
        for slot in o.material_slots:
            mat = slot.material
            h.update((mat.name if mat else '-').encode())
            if mat and mat.node_tree:
                for node in mat.node_tree.nodes:
                    h.update(node.name.encode())
                    for sock in node.inputs:
                        if hasattr(sock, 'default_value') and not sock.is_linked:
                            v = sock.default_value
                            h.update(repr(tuple(v) if hasattr(v, '__len__') and not isinstance(v, str) else v).encode())
    return h.hexdigest()[:16]


def cmd_fingerprint(req):
    return {'ok': True, 'fingerprint': _fingerprint(),
            'objects': len([o for o in bpy.context.scene.objects if not o.name.startswith('_holo_')])}


def cmd_snapshot(req):
    """Save a copy of the whole scene for version history. The open file and its name are untouched."""
    path = str(req.get('path') or '')
    if not path.endswith('.blend'):
        return {'ok': False, 'error': 'snapshot needs a .blend path'}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _object_mode()
    pack_images()   # a version must still have its textures after the files they came from are gone
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    return {'ok': True, 'path': path, 'bytes': os.path.getsize(path), 'fingerprint': _fingerprint(),
            'objects': len([o for o in bpy.context.scene.objects if not o.name.startswith('_holo_')])}


def cmd_restore(req):
    """Go back to a saved version: open its snapshot (keeping the current window layout)."""
    path = str(req.get('path') or '')
    if not (path.endswith('.blend') and os.path.exists(path)):
        return {'ok': False, 'error': 'no such snapshot'}
    with bpy.context.temp_override(**_view3d_override()):
        if bpy.context.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
    return {'ok': True, 'objects': len(bpy.context.scene.objects), 'fingerprint': _fingerprint()}


COMMANDS = {'snapshot': cmd_snapshot, 'restore': cmd_restore, 'fingerprint': cmd_fingerprint,
            'ping': cmd_ping, 'scene': cmd_scene, 'exec': cmd_exec, 'render': cmd_render, 'undo': cmd_undo,
            'redo': cmd_undo, 'delete': cmd_delete, 'add': cmd_add}


def handle(req):
    cmd = req.get('cmd') if isinstance(req, dict) else None
    fn = COMMANDS.get(cmd) if isinstance(cmd, str) else None
    if not fn:
        return {'ok': False, 'error': f'unknown command {cmd!r}'}
    try:
        return fn(req)
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


# ---------------------------------------------------------------- server: socket threads -> main thread
_jobs = queue.Queue()
_state = {'sock': None, 'token': None, 'running': False}


def _refresh_ping():
    try:
        _state['ping'] = cmd_ping({})   # answered straight from the socket thread, even while a job runs
    except Exception:
        pass


def _run_job(req, reply):
    deadline = req.get('deadline') if isinstance(req, dict) else None
    if isinstance(deadline, (int, float)) and time.time() * 1000 > deadline:
        reply.put({'ok': False, 'error': 'expired: the app stopped waiting'})
        return
    try:
        reply.put(handle(req))
    except Exception as e:   # handle() catches command errors; this is the last line of defence
        reply.put({'ok': False, 'error': f'{type(e).__name__}: {e}'})


def _pump():
    """Runs on Blender's main thread (a timer in a normal Blender): bpy is only safe to use here."""
    _refresh_ping()
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        if job is not None:
            _run_job(*job)
    return 0.05


def wake():
    """Makes serve_headless look at its stop flag now instead of at the next tick."""
    _jobs.put(None)


def serve_headless(stop):
    """The headless Blender's main loop: sleep until a job arrives (no polling), run it, repeat until stop is set."""
    _refresh_ping()
    while not stop.is_set():
        try:
            job = _jobs.get(timeout=0.25)
        except queue.Empty:
            continue
        if job is None:
            continue
        _run_job(*job)
        _refresh_ping()


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
                token = req.get('token') if isinstance(req, dict) else None
                if not isinstance(token, str) or not secrets.compare_digest(token.encode(), (_state['token'] or '').encode()):
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


def start_server(port=0, token=None, advertise=False):
    """Listen on 127.0.0.1 and return the port. port=0 lets the OS pick a free one (the headless Blender, which
    tells the server its port on stdout). advertise=True writes bridge.json for whoever looks for a GUI Blender;
    the headless one never does, so it can't be mistaken for (or clobber) a Blender the user opened."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    for p in (range(port, port + 10) if port else (0,)):   # another Blender may already have the first port
        try:
            sock.bind(('127.0.0.1', p))
            break
        except OSError:
            continue
    else:
        sock.close()
        raise OSError(f'no free port in {port}-{port + 9}')
    port = sock.getsockname()[1]
    sock.listen(8)
    _state.update(sock=sock, token=token or secrets.token_hex(16), running=True, port=port)
    if advertise:
        os.makedirs(os.path.dirname(BRIDGE_FILE), exist_ok=True)
        if _other_bridge_alive(port):
            print('Holo Modeler bridge: another Blender already has the connection; this one stays unlisted')
        else:
            with open(BRIDGE_FILE, 'w') as f:
                json.dump({'port': port, 'token': _state['token'], 'pid': os.getpid(),
                           'blender': bpy.app.version_string}, f)
    threading.Thread(target=_accept_loop, args=(sock,), daemon=True).start()
    return port


def stop_server():
    _state['running'] = False
    if _state['sock']:
        _state['sock'].close()
        _state['sock'] = None


def register():
    if bpy.app.background:   # command-line Blender: headless.py starts the server itself
        return
    port = start_server(PORT, advertise=True)
    print(f'Holo Modeler bridge listening on 127.0.0.1:{port}')
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, persistent=True)


def unregister():
    stop_server()
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    try:
        with open(BRIDGE_FILE) as f:
            ours = json.load(f).get('pid') == os.getpid()
        if ours:   # (Windows can't delete a file that's still open, so close it first)
            os.remove(BRIDGE_FILE)
    except (OSError, ValueError):
        pass


from . import webio   # noqa: E402  (last: it uses the helpers above)

COMMANDS.update(webio.COMMANDS)
