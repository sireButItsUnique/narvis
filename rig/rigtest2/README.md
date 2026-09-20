# rigtest2 — does it look 3D?

The second rig test. `rig/rigtest.html` answered "does anything float at all". This one answers "does it look
solid from wherever I stand", by drawing the model from where your head actually is.

Self-contained: serve this folder over http (not `file://`) and open it. three.js comes from a CDN; MediaPipe
is fetched on demand the first time you start the cameras.

```bash
py -m http.server 8901
```

Then `http://localhost:8901/rig/rigtest2/` on the rig monitor. Press `F` for fullscreen, `S` for setup.

## What it needs

Two webcams watching you, as a stereo pair. One camera is refused on purpose: a single camera can only guess
your distance from how far apart your eyes look, and that guess is not good enough here. If the pair is not
running, the page says so and freezes the view rather than drawing a confident hologram from a bad position.

## Setup, once (saved in the browser)

1. **Cameras.** Start them, mark one "left" and one "right" as seen from where you sit, and aim them until the
   eye dots land on your eyes in both pictures. It tells you "2 of 2 see a face".
2. **The pair.** Baseline centre-to-centre (default 40 in), height relative to the sheet, depth in front of it.
   Then type roughly where your head sits and press the button that works the angles out for you.
3. **The rig.** Defaults describe the built rig: 24" 16:9 panel at 45 degrees, 6 in down to the sheet, 6 in
   down to the paper, whole screen, picture flipped. **Check the monitor diagonal**: everything scales off it,
   so a 27 inch panel entered as 24 puts the hologram about 12% out and no trimming will fix that.
4. **Trim (`T`).** Move your head. If the model swims, nudge with the arrow keys until it stops, then Enter.
   A centimetre or two is normal. More than about 5 cm means a number in step 2 is wrong.

## Judging it

Press `2` for the three posts. Each post stands in a painted ring, with extra rings marking the left, centre
and right viewing spots. Step to the left spot and each post top should land on that post's left ring. If the
tops track the rings as you move, the geometry is right. If they lag or overshoot, the trim or the pair
geometry is off.

| Key | |
|---|---|
| `S` | setup · `V` mirrors the setup text so you can read it in the sheet |
| `1` `2` `3` `4` | cube in the volume · three posts · teapot · dropped `.glb` |
| `T` | trim the tracker origin |
| `M` | mouse stand-in (for checking the maths without cameras; not head tracking) |
| `H` | readout: eye position, trim, camera fps and latency, warnings |
| `F` | fullscreen |
