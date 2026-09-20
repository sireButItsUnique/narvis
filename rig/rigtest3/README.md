# rigtest3 — does it look 3D, from the ZED?

`rig/rigtest2/` answered "does it look solid from wherever I stand" with two webcams clipped to the monitor.
This is the same page, the same scenes, the same projection and the same refusals — with the head coming from
the **one ZED standing on the base**, centred, looking up at your face.

That is the camera the rig already has for the hands, so using it for the head too means one device, one
calibration, and both jobs in the same frame of reference.

Self-contained: serve this folder over http (not `file://`) and open it. three.js comes from a CDN; MediaPipe
is fetched on demand the first time you press Start.

```bash
py -m http.server 8901
```

Then `http://localhost:8901/rig/rigtest3/` on the rig monitor. `F` fullscreen, `S` setup.

## Why there is no pair to calibrate

rigtest2 had a fifth step that measured one webcam's pose against the other's from your own face, because two
webcams on a desk know nothing about each other. A ZED's two eyes share one exposure and their relative pose
is a factory measurement, so that whole step is gone.

What is left to know is where the **camera** is, which is three numbers you can take off the rig with a ruler:

| | default | |
|---|---|---|
| acrylic above the base | 6 in | step 3, "base below the sheet" |
| lens above the board | 3 cm | the ZED's own body — it is not lying on the board |
| lens forward of the sheet centre | 22 cm | just past the sheet's front edge, so it does not shoot through the acrylic |

…plus the angle it is propped at, which nobody can measure with a ruler. That one the page measures from your
own head: sit where you normally sit and **press `A` once**. The ZED knows how far away you are on its own (its
baseline is a factory number), so one known seat position pins the one unknown angle. It is HoloDesk's
"calibrate the camera against a fixed world origin", with your seat as the origin and no checkerboard.

## What the placement is worth

With the defaults — lens at rig `0, -12.2, 22` cm, tilted up about 54° — a head anywhere in the seated range
lands in **both** eyes, 58 to 63 cm away, 14 to 17° off the camera's own axis, and never closer than 180 px to
the edge of the frame. One pixel of landmark noise is worth about 4 mm of depth there, which the page prints
so you can see what the tracking is made of.

`zed-place.test.js` checks all of that without any hardware:

```bash
node --test zed-place.test.js
```

Ten tests, and the load-bearing ones are: a rig point pushed out to pixels and pulled back through the real ray
path lands within half a millimetre of where it started; the tilt sign is not free (propped the other way, your
head is not in the frame at all); and 5° of unmeasured prop moves your tracked head 4 to 15 cm, which is the
whole reason `A` exists.

## Setup, once (saved in this browser)

1. **The ZED.** Set it on the base, centred, near the front edge, and prop the front up so it looks at your
   face rather than your chest. Press Start: the page finds it by name, and shows **both halves** of its frame
   with a cross in each. Your eyes should be near both crosses.
2. **Where it stands.** The three ruler numbers above, and roughly where you sit. Height is measured from the
   acrylic, so a camera on the base is negative. The baseline is not yours to type: it is 12 cm on a ZED 2.
3. **The rig.** As rigtest2: 24" 16:9 panel at 45°, 6 in to the sheet, 6 in to the paper. **Check the monitor
   diagonal** — everything scales off it. If the sheet is smaller than the page works out, type its real size;
   a sheet deeper than the camera is forward will be flagged as standing between the lens and your face.
4. **Aim (`A`).** In the rig view, sitting normally.
5. **Trim (`T`).** If the model still swims as you move, nudge until it stops. A centimetre or two is normal.

## Judging it

Press `2` for the three posts. Each stands in a painted ring, with rings marking the left, centre and right
viewing spots. Step to the left spot and each post top should land on that post's left ring. If the tops track
the rings as you move, the geometry is right.

A ZED seen with **one** eye is refused, not averaged in: a single eye can only guess your distance, and this
rig's worst failure is a steady, plausible, completely wrong hologram. When the fuse is lost the picture holds
still and the page says why.

| Key | |
|---|---|
| `S` | setup · `V` mirrors the setup text so you can read it in the sheet |
| `A` | measure the ZED's tilt from where you are sitting |
| `1` `2` `3` `4` | cube in the volume · three posts · teapot · dropped `.glb` |
| `T` | trim the tracker origin |
| `M` | mouse stand-in (for checking the maths without a camera; not head tracking) |
| `H` | readout: eye position, trim, fps and latency per eye, warnings |
| `F` | fullscreen |

Drop your camera's `SN<serial>.conf` (from `calib.stereolabs.com/?SN=…`) anywhere on the page and the lens
numbers stop being a typical ZED's and start being **this** ZED's. Until then the readout says so.
