# Golden reference dumper: runs REAL Blender Essentials sculpt brushes headless and writes
# input mesh + per-dab world data + brush settings + output positions, for a JS parity test.
# Usage: blender -b --factory-startup --python blender_ref.py -- <outdir>
import bpy, sys, json, math, time, os
from mathutils import Vector, noise
from bpy_extras import view3d_utils
OUT = sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'ref'
os.makedirs(OUT, exist_ok=True)
FIELDS = ["sculpt_brush_type","strength","curve_distance_falloff_preset","hardness","auto_smooth_factor","normal_radius_factor",
          "area_radius_factor","spacing","use_space_attenuation","use_accumulate","use_frontface","falloff_shape","sculpt_plane",
          "use_original_normal","use_original_plane","plane_offset","use_plane_trim","plane_trim","plane_height","plane_depth",
          "plane_inversion_mode","stabilize_normal","stabilize_plane","tip_roundness","tip_scale_x","crease_pinch_factor",
          "rake_factor","normal_weight","height","use_persistent","elastic_deform_type","elastic_deform_volume_preservation",
          "deform_target","use_grab_active_vertex","use_grab_silhouette","snake_hook_deform_type","smooth_deform_type"]
def mesh_setup(subdiv=5):
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=1.0)
    ob = bpy.context.active_object
    for v in ob.data.vertices:  # deterministic bumps so smooth/flatten/crease have work to do
        v.co *= 1.0 + 0.03 * noise.noise(v.co * 4.0)
    return ob
def case(name, brush, dx=12.0, n=16, x0=-90.0, y0=0.0, usize=0.6, mirror_x=False, pressure=1.0, subdiv=5):
    ob = mesh_setup(subdiv)
    ob.data.use_mirror_x = mirror_x
    before = [c for v in ob.data.vertices for c in v.co]
    tris = [i for p in ob.data.polygons for i in p.vertices]
    win = bpy.context.window_manager.windows[0]
    area = [a for a in win.screen.areas if a.type=='VIEW_3D'][0]
    region = [r for r in area.regions if r.type=='WINDOW'][0]
    rv3d = area.spaces.active.region_3d
    with bpy.context.temp_override(window=win, area=area, region=region):
        bpy.ops.ed.undo_push(message='init'); bpy.ops.object.mode_set(mode='SCULPT'); bpy.ops.ed.undo_push(message='s')
        bpy.ops.brush.asset_activate(asset_library_type='ESSENTIALS', relative_asset_identifier='brushes/essentials_brushes-mesh_sculpt.blend/Brush/'+brush)
        sc = bpy.context.tool_settings.sculpt; br = sc.brush
        ups = getattr(sc, 'unified_paint_settings', None)
        if ups is not None: ups.use_locked_size='SCENE'; ups.unprojected_size=usize
        br.use_locked_size='SCENE'; br.unprojected_size=usize
        c = view3d_utils.location_3d_to_region_2d(region, rv3d, Vector((0,0,0)))
        dabs, stroke, depth = [], [], None
        for i in range(n):
            m = (c.x + x0 + i*dx, c.y + y0)
            o3 = view3d_utils.region_2d_to_origin_3d(region, rv3d, m); d3 = view3d_utils.region_2d_to_vector_3d(region, rv3d, m)
            ok, hit, nrm, _ = ob.ray_cast(o3, d3)
            if depth is None and ok: depth = hit.copy()
            cursor = view3d_utils.region_2d_to_location_3d(region, rv3d, m, depth or Vector())
            dabs.append({"mouse": list(m), "ray_origin": list(o3), "ray_dir": list(d3), "hit": list(hit) if ok else None,
                         "cursor_at_start_depth": list(cursor)})
            stroke.append({"name":"", "location":(0,0,0), "mouse":m, "mouse_event":m, "pressure":pressure, "size":br.size,
                           "time":i*0.033, "is_start": i==0, "x_tilt":0.0, "y_tilt":0.0})
        settings = {f: (getattr(br, f) if not hasattr(getattr(br, f, None), '__len__') or isinstance(getattr(br,f),str) else list(getattr(br,f))) for f in FIELDS if hasattr(br, f)}
        t = time.perf_counter()
        r = bpy.ops.sculpt.brush_stroke(stroke=stroke, mode='NORMAL', override_location=True)
        ms = (time.perf_counter()-t)*1000
        bpy.ops.object.mode_set(mode='OBJECT')
    after = [c for v in ob.data.vertices for c in v.co]
    mask = None
    if '.sculpt_mask' in ob.data.attributes:
        mask = [a.value for a in ob.data.attributes['.sculpt_mask'].data]
    disp = [math.dist(before[3*k:3*k+3], after[3*k:3*k+3]) for k in range(len(before)//3)]
    view_dir = list((rv3d.view_rotation @ Vector((0,0,-1))).normalized())
    json.dump({"case": name, "brush": brush, "blender": bpy.app.version_string, "radius": usize/2, "pressure": pressure,
               "mirror_x": mirror_x, "view_dir": view_dir, "view_perspective": rv3d.view_perspective, "settings": settings,
               "dabs": dabs, "triangles": tris, "before": [round(x,7) for x in before], "after": [round(x,7) for x in after],
               "mask": mask, "result": str(r), "ms": ms}, open(os.path.join(OUT, name + '.json'), 'w'))
    print(f"{name:18s} {brush:18s} moved={sum(1 for d in disp if d>1e-7):5d} max={max(disp):.5f} {ms:6.1f} ms {r}")
CASES = [("draw","Draw"),("draw_sharp","Draw Sharp"),("clay","Clay"),("clay_strips","Clay Strips"),("layer","Layer"),
         ("inflate","Inflate/Deflate"),("blob","Blob"),("crease_sharp","Crease Sharp"),("smooth","Smooth"),
         ("flatten","Flatten/Contrast"),("scrape","Scrape/Fill"),("fill","Fill/Deepen"),("pinch","Pinch/Magnify"),
         ("grab","Grab"),("elastic_grab","Elastic Grab"),("snake_hook","Snake Hook"),("thumb","Thumb"),("nudge","Nudge"),("mask","Mask")]
for name, brush in CASES:
    try: case(name, brush)
    except Exception as e: print("FAIL", name, e)
case("draw_mirror_x", "Draw", x0=-60, n=4, dx=8.0, mirror_x=True)
case("draw_half_pressure", "Draw", pressure=0.5)
# The cases above start at x0=-90 px, which is off the sphere: the first dabs miss and the stroke
# starts right at the silhouette. That is fine for the dab brushes, but it makes Grab anchor its
# whole deformation on a ray that grazes the surface, where Blender's own two raycasts (the BVH one
# the sculpt code uses and ob.ray_cast) already disagree by about 4 mm. So we also record pulls and
# a smooth stroke that start on the face, where the anchor is well conditioned.
case("grab_pull", "Grab", n=6, x0=0.0, dx=12.0)
case("grab_pull_short", "Grab", n=2, x0=0.0, dx=12.0)
case("smooth_short", "Smooth", n=2, x0=0.0, dx=12.0)
# Set A. Short strokes that start on the FACE, so one dab's shape can be compared on its own
# instead of through nine overlapping ones. Clay Strips and the Plane family skip their first
# brush step (no stroke direction yet), so n=2 gives them exactly one deposit.
case("clay_strips_short", "Clay Strips", n=2, x0=0.0, dx=12.0)
case("clay_strips_face", "Clay Strips", n=6, x0=0.0, dx=12.0)
case("draw_sharp_short", "Draw Sharp", n=2, x0=0.0, dx=12.0)
case("layer_short", "Layer", n=2, x0=0.0, dx=12.0)
case("clay_short", "Clay", n=2, x0=0.0, dx=12.0)
case("flatten_short", "Flatten/Contrast", n=2, x0=0.0, dx=12.0)
# Single dabs. Draw Sharp and Layer both read the LIVE surface each step, so a one-dab case
# separates "is the kernel right" from "does the error feed back through the deformed surface".
case("draw_sharp_one", "Draw Sharp", n=1, x0=0.0, dx=12.0)
case("layer_one", "Layer", n=1, x0=0.0, dx=12.0)
# Long strokes that stay on the face, to tell "error grows with the number of dabs" apart from
# "the stroke anchored on a ray that grazed the silhouette".
case("draw_sharp_face", "Draw Sharp", n=8, x0=-40.0, dx=12.0)
case("layer_face", "Layer", n=8, x0=-40.0, dx=12.0)
# Clay Strips' square tip falls from full strength to nothing over tip_roundness (0.15) of a
# radius = 4.5 mm, which on the 2,562-vertex sphere is HALF an edge length: whether one vertex
# lands inside or outside that band swings its weight, and max-vertex-error sees that as a large
# number even when the surface agrees. The same stroke on a 10,242-vertex sphere resolves the band
# and is the honest test of the kernel.
case("clay_strips_dense", "Clay Strips", n=6, x0=0.0, dx=12.0, subdiv=6)
case("draw_sharp_dense", "Draw Sharp", n=8, x0=-40.0, dx=12.0, subdiv=6)
case("layer_dense", "Layer", n=8, x0=-40.0, dx=12.0, subdiv=6)
# Same reason, brush set B: every one of these pins something to the first ray that lands (Snake
# Hook's travelling dab centre, Thumb's anchor, Crease's groove that the next dab is raycast
# against, Mask's saturating paint), so the silhouette start above measures Blender's raycast
# disagreement rather than the kernel. These are the identical 16-dab strokes started on the face.
for _n, _b in [("crease_face", "Crease Sharp"), ("blob_face", "Blob"), ("pinch_face", "Pinch/Magnify"),
               ("nudge_face", "Nudge"), ("thumb_face", "Thumb"), ("snake_hook_face", "Snake Hook"),
               ("elastic_face", "Elastic Grab"), ("mask_face", "Mask")]:
    try: case(_n, _b, x0=0.0)
    except Exception as e: print("FAIL", _n, e)
