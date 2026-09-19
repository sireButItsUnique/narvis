"""What the web gets from the headless Blender. Bridge commands (registered by __init__.py):
  export_glb {path, mode, only?, rev?}   the scene as one GLB for three.js, plus what the server keeps about it
  clear_scene {}                         an empty scene (the factory Cube, camera and light go too)
  save_working {path}                    the working autosave: a compressed .blend with its images packed in
  warm_up {}                             pays the glTF exporter's import and EEVEE's shader compile up front

Modes: 'preview' is the scene as Fable left it (modifiers at viewport levels), for quick previews while it builds.
'look' and 'final' are the density the user sculpts: Subdivision at render levels, and coarse parts subdivided.
final also bakes procedural materials and look bakes them small; the bake arrives in M5 (see _bake_procedurals).

export_glb leaves nothing behind but each object's holo_id and holo_name custom properties (which the version
fingerprint ignores): every temporary modifier, level, attribute, property and the selection go back in a finally.
"""
import hashlib
import math
import os
import re
import sys
import tempfile
import time
import uuid

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree

hb = sys.modules[__package__]   # the bridge itself; everything it defines exists before this module loads

GEOMETRY = {'MESH', 'CURVE', 'SURFACE', 'FONT'}   # what glTF exports as meshes (metaballs never export)
MODES = ('preview', 'look', 'final')
DENSE_EDGE = 0.004      # look/final: a part whose mean edge is longer than this x the model's diagonal is subdivided
DENSE_MAX_LEVELS = 4
PART_TRIS = 150_000     # render levels and densify stop here, per part...
TOTAL_TRIS = 400_000    # ...and for the whole model
SYM_TOL = 0.005         # symmetric: a mirrored vertex has another vertex within this x the diagonal...
SYM_SHARE = 0.99        # ...for this share of the vertices (0.9 if a Mirror modifier on that plane agrees)
SYM_SAMPLES = 4000
_ID = re.compile(r'^[0-9a-f]{12}$')
_MISSING = object()
_sym_cache = {}


def _home():
    return os.environ.get('HOLOMODEL_HOME') or os.path.join(os.path.expanduser('~'), '.holomodel')


def export_set():
    """The model: visible and renderable objects. Fable's renders and the GLB show exactly this set (a hide_set
    helper would otherwise vanish from one and a hide_render one leak into the other)."""
    return [o for o in bpy.context.scene.objects if (o.type in GEOMETRY or o.type == 'EMPTY')
            and o.visible_get() and not o.hide_render and not o.name.startswith('_holo')]


def ensure_ids(objs):
    """Every exported object keeps a holo_id (glTF extras -> three.js userData): three.js rewrites names
    ('Teapot Body' -> 'Teapot_Body', 'Cube.001' -> 'Cube001'), so ids are how the page and server tell parts apart.
    obj.copy() copies the id along, so of two objects sharing one, the one still called what the id was recorded
    under keeps it and the copy gets a new one."""
    seen, fixed = set(), 0
    for o in sorted(objs, key=lambda o: (o.get('holo_name') != o.name, o.name)):
        hid = o.get('holo_id')
        if not isinstance(hid, str) or not _ID.match(hid) or hid in seen:
            o['holo_id'] = uuid.uuid4().hex[:12]
            fixed += 1
        if o.get('holo_name') != o.name:
            o['holo_name'] = o.name
        seen.add(o['holo_id'])
    return fixed


# ---------------------------------------------------------------- reading evaluated geometry
def _read(o, dg, want=()):
    """o's evaluated mesh: vertex, triangle and loop counts, plus on request world positions ('world'), the mean
    world edge length ('edge') and a geometry hash ('hash'). None if it has no mesh."""
    ev = o.evaluated_get(dg)
    try:
        me = ev.to_mesh()
    except RuntimeError:
        return None
    if me is None:
        return None
    try:
        nv, npoly = len(me.vertices), len(me.polygons)
        co = np.empty(nv * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        lt = np.empty(npoly, np.int32)
        me.polygons.foreach_get('loop_total', lt)
        r = {'nv': nv, 'tris': int((lt - 2).sum()), 'loops': int(lt.sum())}
        mw = np.array(o.matrix_world, np.float32)
        if 'world' in want or 'edge' in want:
            world = co @ mw[:3, :3].T + mw[:3, 3]
            if 'world' in want:
                r['world'] = world
            if 'edge' in want:
                e = np.empty(len(me.edges) * 2, np.int32)
                me.edges.foreach_get('vertices', e)
                e = e.reshape(-1, 2)
                r['edge'] = float(np.linalg.norm(world[e[:, 0]] - world[e[:, 1]], axis=1).mean()) if len(e) else 0.0
        if 'hash' in want:
            r['hash'] = _geometry_hash(me, co, lt, mw)
    finally:
        ev.to_mesh_clear()
    return r


def _geometry_hash(me, co, lt, mw):
    """What the page would see change: positions, placement, topology, material ids, hard edges, UVs, colours."""
    h = hashlib.sha1()
    h.update(f'{len(me.vertices)}|{len(me.loops)}|{len(me.polygons)}|'.encode())
    h.update(co.tobytes())
    h.update(mw.tobytes())
    h.update(lt.tobytes())
    for coll, prop in ((me.loops, 'vertex_index'), (me.polygons, 'material_index')):
        a = np.empty(len(coll), np.int32)
        coll.foreach_get(prop, a)
        h.update(a.tobytes())
    for name in ('sharp_face', 'sharp_edge'):
        attr = me.attributes.get(name)
        if attr is not None and attr.data_type == 'BOOLEAN':
            a = np.empty(len(attr.data), bool)
            attr.data.foreach_get('value', a)
            h.update(name.encode() + a.tobytes())
    uv = me.uv_layers.active
    if uv is not None:
        a = np.empty(len(uv.data) * 2, np.float32)
        uv.data.foreach_get('uv', a)
        h.update(b'uv' + a.tobytes())
    col = me.color_attributes.active_color
    if col is not None:
        a = np.empty(len(col.data) * 4, np.float32)
        col.data.foreach_get('color', a)
        h.update(b'col' + a.tobytes())
    return h.hexdigest()[:16]


def _material_hash(o):
    """What the page's materials come from: slots, node settings and wiring, images."""
    h = hashlib.sha1()
    for slot in getattr(o, 'material_slots', []):
        m = slot.material
        h.update(f'|{m.name if m else "-"}|'.encode())
        if not m:
            continue
        # (not hb._hash_rna(m): reading Material.use_nodes prints a DeprecationWarning in 5.2)
        h.update(repr((tuple(m.diffuse_color), m.metallic, m.roughness, getattr(m, 'surface_render_method', ''),
                       getattr(m, 'use_backface_culling', None))).encode())
        nt = m.node_tree
        if nt is None:
            continue
        for n in nt.nodes:
            h.update(f'{n.bl_idname}:{n.name}:'.encode())
            hb._hash_rna(h, n)
            for s in n.inputs:
                if not s.is_linked and hasattr(s, 'default_value'):
                    v = s.default_value
                    h.update(repr(tuple(v) if hasattr(v, '__len__') and not isinstance(v, str) else v).encode())
            ramp = getattr(n, 'color_ramp', None)
            if ramp is not None:
                h.update(repr([(e.position, tuple(e.color)) for e in ramp.elements]).encode())
            img = getattr(n, 'image', None)
            if img is not None:
                h.update(f'img:{img.name}:{tuple(img.size)}:{img.filepath}:'
                         f'{img.packed_file.size if img.packed_file else 0}'.encode())
        for link in nt.links:
            h.update(f'{link.from_node.name}.{link.from_socket.identifier}>'
                     f'{link.to_node.name}.{link.to_socket.identifier}'.encode())
    return h.hexdigest()[:16]


def _textured(o):
    for slot in getattr(o, 'material_slots', []):
        nt = slot.material.node_tree if slot.material else None
        if nt is not None and any(n.type == 'TEX_IMAGE' and n.image for n in nt.nodes):
            return True
    return False


def _image_format(objs):
    """JPEG keeps baked and painted colour maps small (1024 px: 42 KB against 339 KB as PNG), but it has no alpha
    and would smear a normal map, so either of those keeps the exporter's own choice."""
    seen = set()
    for o in objs:
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if m is None or m.name in seen or m.node_tree is None:
                continue
            seen.add(m.name)
            if getattr(m, 'surface_render_method', '') == 'BLENDED':
                return 'AUTO'
            for n in m.node_tree.nodes:
                if n.type == 'NORMAL_MAP':
                    return 'AUTO'
                alpha = n.inputs.get('Alpha') if n.type == 'BSDF_PRINCIPLED' else None
                if alpha is not None and (alpha.is_linked or alpha.default_value < 1):
                    return 'AUTO'
    return 'JPEG'


# ---------------------------------------------------------------- symmetry hint for the page's sculpt mirror
def _mirror_votes(geo):
    """Mirror modifiers whose plane is the world's X or Y plane (Blender axes)."""
    votes = set()
    for o in geo:
        for m in o.modifiers:
            if m.type != 'MIRROR' or not m.show_viewport:
                continue
            ref = m.mirror_object or o
            origin, rot = ref.matrix_world.translation, ref.matrix_world.to_3x3()
            for i, on in enumerate(m.use_axis):
                if not on:
                    continue
                n = (rot @ Vector([1.0 if k == i else 0.0 for k in range(3)])).normalized()
                for axis, name in ((0, 'x'), (1, 'y')):
                    if abs(n[axis]) > 0.999 and abs(origin[axis]) < 1e-4:
                        votes.add(name)
    return votes


def _symmetry(world, diag, votes):
    """Is the model its own mirror image across the world X and Y planes (Blender axes)? Answered in three.js axes:
    Blender X is three X, Blender Y is three Z (so the teapot, mirrored on Blender Y, comes out z). Up (Blender Z,
    three Y) is never a sculpt mirror. The GLB is in this world frame, so the page mirrors through its origin."""
    shares = [0.0, 0.0]
    if len(world) >= 3 and diag > 0:
        key = hashlib.sha1(world.tobytes()).hexdigest()
        shares = _sym_cache.get(key)
        if shares is None:
            tol = SYM_TOL * diag
            tree = kdtree.KDTree(len(world))
            for i, v in enumerate(world.tolist()):
                tree.insert(v, i)
            tree.balance()
            sample = world[::max(1, len(world) // SYM_SAMPLES)]
            shares = []
            for axis in (0, 1):
                m = sample.copy()
                m[:, axis] *= -1
                shares.append(sum(1 for v in m.tolist() if tree.find(v)[2] <= tol) / len(m))
            if len(_sym_cache) > 32:
                _sym_cache.clear()
            _sym_cache[key] = shares
    on = [shares[i] >= SYM_SHARE or (name in votes and shares[i] >= 0.9) for i, name in ((0, 'x'), (1, 'y'))]
    return {'x': bool(on[0]), 'y': False, 'z': bool(on[1])}


# ---------------------------------------------------------------- temporary changes for the export
def _realize_instances(geo, undo):
    """Geometry-nodes instances are dropped by the exporter (and convert() makes an empty mesh), so a temporary
    Realize Instances modifier goes at the end of each geometry-nodes stack."""
    targets = [o for o in geo if any(m.type == 'NODES' and m.show_viewport for m in o.modifiers)]
    if not targets:
        return
    ng = bpy.data.node_groups.get('_holo_realize')
    if ng is None:
        ng = bpy.data.node_groups.new('_holo_realize', 'GeometryNodeTree')
        ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
        ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
        gi, go, ri = ng.nodes.new('NodeGroupInput'), ng.nodes.new('NodeGroupOutput'), ng.nodes.new('GeometryNodeRealizeInstances')
        ng.links.new(gi.outputs[0], ri.inputs[0])
        ng.links.new(ri.outputs[0], go.inputs[0])
        undo.append(lambda: bpy.data.node_groups.remove(ng) if ng.users == 0 else None)   # runs after the removals
    for o in targets:
        m = o.modifiers.new('_holo_realize', 'NODES')
        if m is None:
            continue
        m.node_group = ng
        undo.append(lambda o=o, m=m: o.modifiers.remove(m))


def _render_levels(geo, undo):
    """Subdivision (and Multires) at render levels: what Fable chose for the final look, and the density worth
    sculpting (teapot: 31,808 -> 126,272 tris)."""
    bumped = {}
    for o in geo:
        for m in o.modifiers:
            if m.type in {'SUBSURF', 'MULTIRES'} and m.show_viewport and m.render_levels > m.levels:
                undo.append(lambda m=m, v=m.levels: setattr(m, 'levels', v))
                bumped.setdefault(o, []).append((m, m.levels))
                m.levels = m.render_levels
    return bumped


def _cap_levels(bumped, info, undo_read):
    """Take render levels back down one at a time where a part goes over PART_TRIS or the model over TOTAL_TRIS."""
    def lower(o):
        for m, orig in reversed(bumped[o]):
            if m.levels > orig:
                m.levels -= 1
                return True
        return False

    while True:
        over = [o for o in bumped if info.get(o) and info[o]['tris'] > PART_TRIS]
        if not over and sum(i['tris'] for i in info.values() if i) > TOTAL_TRIS:
            over = sorted((o for o in bumped if info.get(o)), key=lambda o: -info[o]['tris'])[:1]
        over = [o for o in over if lower(o)]
        if not over:
            return
        undo_read(over)


def _dense_tris(i, levels):
    # a SIMPLE level turns every n-gon into n quads (2 tris each), then each quad into 4
    return 2 * i['loops'] * 4 ** (levels - 1) if levels else i['tris']


def _densify(geo, info, diag, undo):
    """look/final: a SIMPLE Subdivision on unsculpted mesh parts too coarse to sculpt, i.e. whose mean edge is over
    DENSE_EDGE x diagonal, with levels = ceil(log2(edge / target)) up to 4, within the tris caps. Sculpted parts
    are left alone: they already are what the page sculpted."""
    target = DENSE_EDGE * diag
    want = {}
    for o in geo:
        i = info.get(o)
        if o.type != 'MESH' or o.get('holo_sculpted') or not i or not i['tris'] or i['edge'] <= target:
            continue
        levels = min(DENSE_MAX_LEVELS, math.ceil(math.log2(i['edge'] / target)))
        while levels and _dense_tris(i, levels) > PART_TRIS:
            levels -= 1
        if levels:
            want[o] = levels
    total = sum(i['tris'] for i in info.values() if i) + sum(_dense_tris(info[o], lv) - info[o]['tris'] for o, lv in want.items())
    while total > TOTAL_TRIS and want:
        o = min(want, key=lambda o: info[o]['edge'] / 2 ** want[o])   # give up detail where it is already finest
        total -= _dense_tris(info[o], want[o]) - _dense_tris(info[o], want[o] - 1)
        want[o] -= 1
        if not want[o]:
            del want[o]
    for o, levels in want.items():
        m = o.modifiers.new('_holo_dense', 'SUBSURF')
        m.subdivision_type = 'SIMPLE'
        m.levels = m.render_levels = levels
        undo.append(lambda o=o, m=m: o.modifiers.remove(m))
    return want


def _bake_procedurals(parts, mode, undo):
    """Plan step 6 (M5): bake procedural Principled inputs with the EMIT trick (1024 px in final, 256 px in look),
    wire the images in for the export and put the procedural links back through undo. Not yet: until then an
    unbaked procedural input exports as its plain default value."""
    return {}


def _mark_vids(parts, undo):
    """Parts with no modifiers are exported vertex for vertex, so a '_vid' point attribute (exported as _VID, read
    by three as attributes._vid) tells the page which Blender vertex each glTF vertex is. glTF splits vertices at
    UV seams and hard edges; the page welds them back by _vid, and later sends sculpted positions back by it."""
    ok = []
    for o in parts:
        if o.type != 'MESH':
            continue
        me = o.data
        attr = me.attributes.get('_vid')
        plain = not any(m.show_viewport for m in o.modifiers) and me.shape_keys is None
        if not plain:
            if attr is not None:   # a stale one would export through the modifiers as nonsense
                attr.name = 'holo_vid_off'
                undo.append(lambda me=me: setattr(me.attributes['holo_vid_off'], 'name', '_vid'))
            continue
        if attr is not None and (attr.domain != 'POINT' or attr.data_type != 'INT'):
            attr.name = 'holo_vid_off'
            undo.append(lambda me=me: setattr(me.attributes['holo_vid_off'], 'name', '_vid'))
            attr = None
        if attr is None:
            attr = me.attributes.new('_vid', 'INT', 'POINT')
            undo.append(lambda me=me: me.attributes.remove(me.attributes['_vid']))
        n = len(me.vertices)
        attr.data.foreach_set('value', np.arange(n, dtype=np.int32))
        ok.append((o, n))
    return ok


def _skipped():
    """Visible objects glTF has no mesh for, metaballs above all. They're in Fable's renders and in the .blend, so
    the web quietly missing them is worth reporting (the prompt asks for a mesh instead; audit follows in M5)."""
    return [{'name': o.name, 'type': o.type} for o in bpy.context.scene.objects
            if o.type not in GEOMETRY and o.type not in {'EMPTY', 'CAMERA', 'LIGHT'}
            and o.visible_get() and not o.hide_render and not o.name.startswith('_holo')]


def _model_name(objs, parts):
    """What to call the whole model on screen. The glTF scene name is Blender's ("Scene"), so the page needs this:
    the single root Empty everything hangs off, or the one collection the objects live in (the prompt asks Fable to
    name that collection after the thing). Several roots in several collections have no one name."""
    roots = [o for o in objs if o.parent is None]
    if len(roots) == 1 and roots[0].type == 'EMPTY':
        return roots[0].name
    cols = {c.name for o in parts for c in o.users_collection if c is not bpy.context.scene.collection}
    if len(cols) == 1:
        return next(iter(cols))
    return roots[0].name if len(roots) == 1 else ''


def _set_temp(owner, key, value, undo):
    old = owner.get(key, _MISSING)
    owner[key] = value
    undo.append(lambda: owner.__delitem__(key) if old is _MISSING else owner.__setitem__(key, old))


# ---------------------------------------------------------------- commands
def cmd_export_glb(req):
    """Write the model to req.path as GLB (plan export recipe A). Returns the parts with their ids, triangle counts
    and hashes, the symmetry hint and the scene fingerprint; {empty: true} and no file for an empty scene."""
    path = str(req.get('path') or '')
    mode = req.get('mode') or 'final'
    if not path.lower().endswith('.glb'):
        return {'ok': False, 'error': 'export_glb needs a .glb path'}
    if mode not in MODES:
        return {'ok': False, 'error': f'mode must be one of {", ".join(MODES)}'}
    only = set(req.get('only') or [])
    t0 = time.perf_counter()
    ms = {}
    hb._object_mode()
    objs = export_set()
    fixed = ensure_ids(objs)
    geo = [o for o in objs if o.type in GEOMETRY]
    parts = [o for o in geo if not only or o['holo_id'] in only]
    no_sym = {'x': False, 'y': False, 'z': False}
    skipped = _skipped()
    model_name = _model_name(objs, parts)
    if not parts:
        return {'ok': True, 'empty': True, 'mode': mode, 'parts': [], 'tris': 0, 'sym': no_sym,
                'ids_assigned': fixed, 'skipped': skipped, 'fingerprint': hb._fingerprint()}
    if only:   # the parts plus the empties above them, so they keep their place in the hierarchy
        keep = set(parts)
        for o in parts:
            p = o.parent
            while p is not None:
                keep.add(p)
                p = p.parent
        objs = [o for o in objs if o in keep]

    sc, vl = bpy.context.scene, bpy.context.view_layer
    selected, active = [o for o in vl.objects if o.select_get()], vl.objects.active
    undo = []
    densified, levels = {}, {}
    try:
        _realize_instances(geo, undo)
        # decisions (density, caps, symmetry) always look at the whole model, so a one-part export matches
        dg = bpy.context.evaluated_depsgraph_get()
        first = {o: _read(o, dg, ('world',)) for o in geo}
        world = np.concatenate([i['world'] for i in first.values() if i and len(i['world'])] or [np.zeros((0, 3), np.float32)])
        diag = float(np.linalg.norm(world.max(0) - world.min(0))) if len(world) else 0.0
        sym = _symmetry(world, diag, _mirror_votes(geo))
        ms['read'] = round((time.perf_counter() - t0) * 1000, 1)
        if mode != 'preview':
            bumped = _render_levels(geo, undo)
            dg = bpy.context.evaluated_depsgraph_get()
            info = {o: _read(o, dg, ('edge',)) for o in geo}

            def reread(objs_):
                d = bpy.context.evaluated_depsgraph_get()
                for o in objs_:
                    info[o] = _read(o, d, ('edge',))

            _cap_levels(bumped, info, reread)
            levels = {o.name: [m.levels for m, _ in mods] for o, mods in bumped.items()}
            densified = {o.name: lv for o, lv in _densify(geo, info, diag, undo).items()}
            _bake_procedurals(parts, mode, undo)
            ms['density'] = round((time.perf_counter() - t0) * 1000 - ms['read'], 1)
        vids = _mark_vids(parts, undo)
        dg = bpy.context.evaluated_depsgraph_get()
        final = {o: _read(o, dg, ('hash',)) for o in parts}
        out = []
        for o in parts:
            i = final[o] or {'tris': 0, 'hash': '0' * 16}
            p = {'id': o['holo_id'], 'name': o.name, 'tris': i['tris'], 'sculpted': bool(o.get('holo_sculpted')),
                 'textured': _textured(o), 'ghash': i['hash'], 'mhash': _material_hash(o)}
            out.append(p)
            _set_temp(o, 'holo_ghash', p['ghash'], undo)
            _set_temp(o, 'holo_mhash', p['mhash'], undo)
        for o, n in vids:
            _set_temp(o, 'holo_nv', n, undo)
            _set_temp(o, 'holo_vidok', True, undo)
        _set_temp(sc, 'holo_sym', sym, undo)
        _set_temp(sc, 'holo_rev', int(req.get('rev') or 0), undo)
        _set_temp(sc, 'holo_units', 'm', undo)
        if model_name:
            _set_temp(sc, 'holo_model', model_name, undo)
        for o in selected:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
        undo.append(lambda: [o.select_set(False) for o in objs])
        t = time.perf_counter()
        # recipe step 7, measured: the defaults give 3,980 tris for the teapot, drop the Mirror halves and include
        # the hidden Cube. No Draco or meshopt: they quantise and reorder vertices, which breaks sculpt round trips.
        # use_active_scene: a scene Fable (or look_web) added must not ride along.
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_selection=True, use_visible=True, use_renderable=True,
            use_active_scene=True, export_apply=True, export_yup=True, export_extras=True, export_attributes=True,
            export_materials='EXPORT', export_image_format=_image_format(parts),
            export_draco_mesh_compression_enable=False, export_animations=False, export_cameras=False,
            export_lights=False)
        ms['export'] = round((time.perf_counter() - t) * 1000, 1)
    finally:
        for fn in reversed(undo):
            try:
                fn()
            except Exception as e:   # keep undoing the rest; a leftover is better than a half-restored scene
                print(f'holomodel export_glb: could not undo a temporary change: {e}')
        for o in selected:
            try:
                o.select_set(True)
            except RuntimeError:
                pass
        vl.objects.active = active
    fingerprint = hb._fingerprint()
    ms['total'] = round((time.perf_counter() - t0) * 1000, 1)
    return {'ok': True, 'empty': False, 'path': path, 'bytes': os.path.getsize(path), 'mode': mode,
            'rev': int(req.get('rev') or 0), 'parts': out, 'tris': sum(p['tris'] for p in out), 'sym': sym,
            'name': model_name, 'skipped': skipped, 'ids_assigned': fixed, 'fingerprint': fingerprint,
            'levels': levels, 'densified': densified, 'ms': ms}


def clear_scene():
    """Objects, collections and every datablock they used go; the world and render settings stay."""
    hb._object_mode()
    keep = bpy.context.scene
    for sc in list(bpy.data.scenes):
        if sc != keep:
            bpy.data.scenes.remove(sc)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def cmd_clear_scene(req):
    clear_scene()
    return {'ok': True, 'objects': len(bpy.context.scene.objects)}


def cmd_save_working(req):
    """The working autosave the server reopens when Blender restarts. Blender writes it atomically (to a temp name,
    then renames), so a kill mid-save leaves the previous one."""
    path = str(req.get('path') or os.path.join(_home(), 'working', 'current.blend'))
    if not path.endswith('.blend'):
        return {'ok': False, 'error': 'save_working needs a .blend path'}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    t = time.perf_counter()
    hb._object_mode()
    packed = hb.pack_images()
    with bpy.context.temp_override(**hb._view3d_override()):
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    return {'ok': True, 'path': path, 'bytes': os.path.getsize(path), 'packed': packed,
            'ms': round((time.perf_counter() - t) * 1000, 1)}


def cmd_warm_up(req):
    """A fresh Blender's first glTF export spends ~0.5 s importing the exporter and its first EEVEE render ~1 s
    compiling shaders. Spend them now on a throwaway cube in a throwaway scene, not on the user's first build."""
    t0 = time.perf_counter()
    scene = bpy.data.scenes.new('_holo_warm')
    me = bpy.data.meshes.new('_holo_warm')
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=0.1)
    bm.to_mesh(me)
    bm.free()
    mat = bpy.data.materials.new('_holo_warm')   # nodes are on by default in 5.x: a Principled BSDF to compile
    me.materials.append(mat)
    ob = bpy.data.objects.new('warm cube', me)   # (render skips _holo_ names)
    scene.collection.objects.link(ob)
    fd, glb = tempfile.mkstemp(suffix='.glb')
    os.close(fd)
    out = {'ok': True}
    try:
        with bpy.context.temp_override(scene=scene):
            t = time.perf_counter()
            bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_active_scene=True,
                                      export_animations=False)
            out['export_ms'] = round((time.perf_counter() - t) * 1000, 1)
            t = time.perf_counter()
            r = hb.cmd_render({'views': ['three_quarter'], 'size': 256})
            out['render_ms'] = round((time.perf_counter() - t) * 1000, 1)
            if not r['ok']:
                out['render_error'] = r['error']
    finally:
        os.remove(glb)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        bpy.data.materials.remove(mat)
        bpy.data.scenes.remove(scene)
    out['ms'] = round((time.perf_counter() - t0) * 1000, 1)
    return out


COMMANDS = {'export_glb': cmd_export_glb, 'clear_scene': cmd_clear_scene, 'save_working': cmd_save_working,
            'warm_up': cmd_warm_up}
