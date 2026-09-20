# Tuning the tracker on real frames

Everything about the hand tracking that was ever measured on the actual rig was measured with these two scripts,
on a recording made with `python gesture_detect.py --rig-bridge --record hand_test.svo2`.

```bash
python devtools/capture_trace.py hand_test.svo2 trace.pkl     # replays the recording through the REAL main loop (~1 min)
python devtools/analyse_trace.py trace.pkl [--events]         # rates, lens use, depth jumps, shape jumps, roughness, bones
```

`capture_trace.py` changes nothing in the pipeline: it wraps the landmarkers, `same_hand`, `locate_palm`,
`triangulate_depths`, `solve_depths` and the bridge, and keeps what each did on every frame. Extra arguments are passed
to gesture_detect (`--no-windows`, `--depth-mode NEURAL_LIGHT`, ...), and `--blank-map` hands the fusion an empty depth
map. Compare two versions of the code by capturing a trace with each and reading the ROUGHNESS block (second
differences: it needs no choice of "still" windows) and the two JUMPS lines.

What the first recording showed (82 s, one hand, 17 fps live): both lenses had the hand on only 53% of frames; a third
of the frames that did were refused by the pairing check; with one lens the distance came from apparent size, which
swings by a quarter from frame to frame (251 depth jumps, up to 37 cm); triangulation and MediaPipe's model disagree
about each joint's depth by a median 24 mm, so joints leapt whenever their source changed; MediaPipe's knuckle-to-knuckle
bones are a third to a half too short; and the SDK's depth map, at this range, made things worse. See viewwindow.py,
palmtrack.py, fuse3d.MetricBones / disparity_noise and handmodel.DepthShapeFilter for what each of those became.
