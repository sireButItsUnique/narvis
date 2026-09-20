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

## Your hand, where your hand is (bridge mode)

The alignment test, and HoloDesk's premise in one picture: a skeleton drawn at the 21 joints the ZED measures
should land ON your real hand seen through the acrylic, and stay on it as your head moves.

A camera has one owner. This page used to open the ZED as a webcam to find your head; the hand tracker
(`gesture_detection/gesture_detect.py`) opens the same ZED through the SDK, so the two could never run
together. In bridge mode Python owns the camera, finds the hand AND the head in the same frames, and sends
both in the camera's own frame; this page opens no camera and places what it is sent with the ONE camera pose
it already calibrates. Head and hand going through the same pose is the point: what is still wrong with that
pose moves them together, which is the error the picture forgives most (`bridge.test.js` measures it).

```bash
cd gesture_detection
curl.exe -L -o face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
python gesture_detect.py --rig-bridge
```

…and, with the static server from above running, open **`http://localhost:8901/rig/rigtest3/?bridge=1&scene=hands`**
on the rig monitor and press `F`. `H` shows where the bridge puts your head and hand, in rig centimetres.
Do **not** press Start in setup: that opens the camera the bridge is using. `5` is the hands-only scene.

**The rig as stated (2026-09-20):** monitor 45°, sheet flat, 13.5 cm above the mat; ZED on a 1.5 in block at the
back of the slot, tilted up 15°. These are `DEFAULT_SETUP` in `js/rig/rigtest2.js`, and a setup saved before they
were stated is reset to them once (with any hand placement that was dialled in against the old ones). At 15° the
ZED holds the slot and a leaning viewer's face in frame together.

**What actually moves the overlay** (eye at the seat, hand mid-slot; how far the drawn hand misses the real one):

| if the real rig differs from these numbers by | miss |
|---|---|
| ZED forward position, 5 cm | 2.9 cm |
| monitor forward position, 5 cm | 2.8 cm |
| sheet tilt, 2° | 1.0 cm |
| monitor height, 2 cm | 0.9 cm |
| ZED height or sheet height, 1 cm | 0.5 cm |
| ZED tilt, 5° | 0.3 cm |
| monitor tilt, 3° | ~0 |

The ANGLES barely matter: head and hand go through the same camera pose, so a wrong tilt rotates them together
and the overlay hardly notices (the hand's rig coordinates are wrong, the picture is not). The two FORWARD
positions matter most, and they are the two numbers nobody has measured — every length taken off this rig so far
was vertical. Measure, from the acrylic's front edge, horizontally: the sheet's depth; back to the point below the
picture's bottom edge; back to the front of the ZED's lenses. Then step 2's "forward of the sheet centre" is
`depth/2 − (distance to the lenses)`, and step 3's monitor forward is `depth/2 − (distance to the bottom edge) + 11.9`.

**The saved setup outranks the defaults - check what the page BELIEVES.** The numbers in `rigtest2.js`
`DEFAULT_SETUP` reach only a browser that has never opened this page; one that has keeps its own saved copy. That
is how this rig ran for weeks on the shipped page's guesses after it had been measured: a 24" panel (a 10 cm
square drew 11.2), and the ZED at the FRONT edge of the sheet when it stands at the back - head and hand both
placed 34 cm too near you, which draws the hand 12-17 degrees BELOW the real one, drops it off the picture when the
hand is in the slot, and makes it move 1.3x as far. Setup version 7 discards every physical number saved by an
older page. The `H` readout now says where the page believes the camera is ("ZED 12.5 cm BEHIND the sheet centre,
8.2 cm below the sheet, tilted up 15"): read it against the rig before anything else.

**`D` copies everything to the clipboard**: the saved setup in THIS browser (which nobody else can see, and which
is often the cause), whether the page really covers the panel, the virtual image's corners, and the live head and
hand numbers. A symptom in words fits several causes; this settles in one paste what guessing does not.

**What the mat grid's two numbers mean.** The mat is horizontal, so the SIDEWAYS size of a square and its sideways
slide as you move depend only on HEIGHTS: how far below the mat the virtual image really is, how big the lit
picture really is, and how high the tracked eye is. Where the monitor and camera stand front to back does not
enter at all. Squares too BIG: the page believes a smaller picture than the real one (check the monitor diagonal
in step 3 - a saved 24" against a real 27" is exactly 11.25 cm per 10), or an eye lower than yours. Grid sliding
the SAME way as your head (under-following): the image is deeper than the page believes - the monitor is higher
above the sheet. Sliding the OPPOSITE way: shallower.

**Which half is wrong? Two checks that do not involve each other** (scene `5`):

- **The mat grid** (`G`): 5 cm squares drawn ON the mat, bright every 10, a cross under the sheet's centre. It
  involves no hand tracking. Right, it looks painted on: it stays put as you move your head, and a bright square
  is 10 cm against a ruler on the mat. If it slides over the mat as you move, the PANEL's numbers are wrong.
- **The ruler lines** (`H`): your hand's length along the bones, the width across your knuckles, and how far
  your wrist and eyes are from the lens — straight from the ZED, no rig numbers in them. Wrong, or wandering by
  centimetres while you hold still, and the fault is the TRACKING; no placement can fix that.

**Placing the hand by eye: `P`.** With your hand tracked, press `P`. A small box in the corner shows the three
numbers and the keys; everything is live, `Enter` saves, `Esc` puts it all back, `0` resets, `shift` is the fine step.

0. **The camera, front to back** (`-` `=`) before anything else. It is the number nobody has measured and the
   one the picture is most sensitive to (3 cm of miss per 5 cm), and it moves your head and hand together, as the
   real camera does. Drawn hand BELOW yours and moving too far: `-` (camera further back). Above and moving too
   little: `=`. Better still, measure it and type it in `S` step 2.
1. **Scale** (`[` `]`) next. Sweep your hand side to side: if the drawn one travels FURTHER than yours, lower
   the scale until they travel together. It scales the hand about the camera's LENS, which is exactly what an
   over-estimated distance does to it, so it fixes "too sensitive" and most of "too low" in one go.
2. **Offset** (arrows, `PgUp`/`PgDn`). Hold still and move the drawn hand onto yours. This is where the camera
   stands: the number nobody measured.
3. **Tilt** (`,` `.`). Push your hand in and pull it out: if the drawn one climbs or sinks as it goes, that is
   the camera's pitch. It moves your head too, so do it last and recheck 2.

Scale and offset apply to the HAND only (`js/rig/hands.js`); the head was judged right on its own and the
picture is far less sensitive to it. If you need a scale far from 1, the bridge is not triangulating: run it
with `--debug-depth` and look at `tri` — `nan` means the right view is not being used and the hand's distance
is only being guessed from its size.

Reading the result — HOW the skeleton misses says what is wrong:

- a **constant offset** that does not change as you lean: the camera's position. `P` and the arrows move the
  hand alone; `T` trims head and hand together. The unmeasured "lens forward of the sheet centre" shows up here.
- an offset that **changes as the hand moves in and out**: the camera's tilt. `P`, then `,` `.`
- right from one seat and **swimming** from another: the panel or the sheet, not the tracking — the panel's
  forward offset most of all, the other number nobody has measured.
- the skeleton **cut off** toward the back of the slot: that is the edge of the panel, not a tracking loss.
  From the seat, only the front half of the slot (z from about 0 to +22 cm, ±23 cm wide) lands on the panel.

Two limits that are the hardware's. At 12–35 cm the hand is inside the ZED's 30 cm depth minimum, so the depth
map has nothing on it and the hand is placed by triangulating the landmarks between the two lenses — which
needs the hand in BOTH lenses, so about 12 cm either side of centre at that range. And the camera sees the hand
from the fingertip end, which is the landmarker's hardest view of a hand; HoloDesk's Kinect looks down from above.

## How much of the tracking to believe: `Q`

Every hand the bridge sends carries a CONFIDENCE, 0 to 1 (`gestures.tracking_confidence`): the landmarker's own
score for the hand, averaged over the lenses that saw it, times where the depth came from - both lenses and
every joint triangulated is 1, and ONE lens caps the frame at 0.5, because the hand's distance is then a guess
from its size. The page gates on it (`js/rig/hands.js` `makeHandGate`):

- at or above the **threshold** the frame is drawn;
- below it the frame is NOT drawn: the hand is assumed to be exactly where it last was - the last trusted pose,
  and the last trusted pinch, so a cube in your fingers stays there. A hand that is not seen at all is treated
  the same way. After the **hold** time without a trusted frame, the hand goes.

A held hand is drawn AMBER (in the demo, the pinch cursor is), so you can see which you are looking at. A frozen
hand needs 0.04 more than the threshold to thaw, so a confidence sitting on the line does not flicker it.

Press `Q` with your hand tracked. The box shows the confidence live against the threshold, what went into it
(the score per lens, one lens or both, joints triangulated), and - the number to calibrate by - what fraction
of the last 5 s the current threshold trusts, with the lowest and the typical confidence seen.

- `up` / `down`: the threshold (`shift` = big steps). Move your hand through the positions that misbehave and
  raise it until the jumps stop. If "trusted" falls much below ~80% the hand will feel stuck: the cure then is
  light on the hand, or keeping it nearer the middle where both lenses see it, not a higher number. Above 0.5
  means "both lenses or hold still".
- `left` / `right`: the hold time, 0 to 10 s.
- `[` `]` and `,` `.`: MediaPipe's OWN thresholds, which live in the bridge - the palm DETECTOR (how sure before
  a hand is picked up at all) and the TRACKER (how sure before a hand being followed is dropped and looked for
  again). Lower lets more, shakier hands through for the gate to judge; higher makes the bridge itself lose the
  hand sooner. The bridge rebuilds its landmarkers (a frame or two) and reports what it is RUNNING, which is
  what the box shows. Saved values are sent again whenever the bridge reconnects, so they survive restarting
  `gesture_detect.py` (whose `--detection-confidence` / `--tracking-confidence` are the starting values).
- `Enter` saves, `Esc` puts everything back (the bridge too), `0` resets the threshold and hold.

`H` has the same numbers on its `trust` line, and `D` includes them.

## The demo: pick things up, press a surface (scenes `6` and `7`)

Same launch as above (`python gesture_detect.py --rig-bridge`, then `?bridge=1&scene=grab`), or press `6` / `7`.

- **`6` - a shape sorter.** A cube, a ball and a pyramid on the mat; a low platform with three outlines. Pinch a
  shape (thumb to index OR middle finger - whichever you use), carry it, let go over its outline and it is drawn
  in. They fall, land, stack, and cannot leave the mat. All three home: it pulses, and sets itself up again.
  The small dot and ring between your fingertips is where the page thinks you are pinching: the ring closes as
  your fingers do, goes YELLOW when a shape is in reach and GREEN while you hold one. The pool of light under
  each shape is where it would land - an additive display cannot draw a shadow, so that is the depth cue.
- **`7` - a stretched sheet** 6 cm above the mat. Every joint of your hand dents it; three marbles roll into the
  dents, and your fingers push them.
- **`R`** starts the scene again. **`O`** swaps how your hand is drawn: in BLACK (the default here) or as bones.
  Black is HoloDesk's trick: a Pepper's ghost only ADDS light, so a virtual cube shines straight through your
  real fingers; drawing the hand in black, with depth, turns the cube's pixels off exactly where your hand is
  in front of it, and your real hand shows there instead. It is only as good as the tracking - where it misses,
  it bites a hole out of the cube beside your fingers - so it is drawn a little thinner than a hand.
- **`;` and `'`** make the grab need a tighter / looser pinch (saved). Press `H`: the `grab` line shows what
  your pinch reads live against the two thresholds. Will not pick up: your closed pinch reads above the first
  number - press `'`. Picks up when you did not mean it, or will not let go: press `;`.

Why the grab does not drop things (`js/rig/demo.js` `makeGrab`, tested in `demo.test.js`): the pinch is
measured by the bridge on the landmarker's own metric hand in BOTH views and averaged, with the reconstructed
joints as a referee (`gestures.pinch_gaps` / `fuse_gaps`); on the page, closing must persist 40 ms, opening 110 ms
(a hand flung wide open lets go at once), and a hand that vanishes mid-carry keeps its grip for 450 ms with the
shape waiting in mid-air. The held shape follows the PALM plus a heavily smoothed fingertip offset, because the
fingertips are the shakiest joints and are hidden behind the shape while you hold it.

Every scene now draws the hand through one smoother at the display's rate (`hands.js` `makeHandSmoother`): a
still hand's shake is cut to ~40%, a moving hand trails its samples by about a centimetre, and one missed
detection no longer blinks the hand off: holding is the gate's job (`Q`, above), for as long as you choose.

Where things are is set by the camera, not taste: the ZED needs the hand in both lenses (about 12-15 cm either
side of centre at this range) and loses it closer than ~15 cm, so the demo lives in x -14..15, z 4..25.

## Why there is no pair to calibrate

rigtest2 had a fifth step that measured one webcam's pose against the other's from your own face, because two
webcams on a desk know nothing about each other. A ZED's two eyes share one exposure and their relative pose
is a factory measurement, so that whole step is gone.

What is left to know is where the **camera** is, which is three numbers you can take off the rig with a ruler:

| | this rig | |
|---|---|---|
| acrylic above the base | 13.5 cm | measured; step 3, "base below the sheet" |
| lens above the board | 5.3 cm | measured: a 1.5 in block, plus 1.5 cm up the ZED's own body |
| lens forward of the sheet centre | **−12.5 cm** | **not measured** — see below |

The third one is the hole in this rig's numbers. Every length anyone took off the frame was taken
*vertically*; nothing fixes where the panel and the camera sit **along the viewer's line of sight**, and the
defaults put both on the sheet's centre line because that is where the shipped numbers put them, not because
anyone checked. It is not a harmless guess: sweeping the panel's own forward offset from −6 to +6 cm takes
the drawable volume from 20 × 10 cm to nothing at all. Two ruler measurements close it — the acrylic's depth
front to back, and how far behind its front edge the panel's bottom edge sits.

…plus the angle it is propped at, which nobody can measure with a ruler. That one the page measures from your
own head: sit where you normally sit and **press `A` once**. The ZED knows how far away you are on its own (its
baseline is a factory number), so one known seat position pins the one unknown angle. It is HoloDesk's
"calibrate the camera against a fixed world origin", with your seat as the origin and no checkerboard.

## What the placement is worth

With this rig's numbers — lens at rig `0, -8.2, -12.5` cm, tilted up about 39° — a head anywhere in the
seated range lands in **both** eyes, 67 to 87 cm away, 5 to 27° off the camera's own axis, and never closer
than 279 px to the edge of the frame. That is further out and further off axis than the reference placement
`zed-place.js` still carries (58–63 cm, 14–17°), which is what standing the camera *behind* the sheet
instead of in front of it costs. One pixel of landmark noise is worth about 4 mm of depth there, which the
page prints so you can see what the tracking is made of.

It also means the sightline to your face goes **up through the acrylic**, which the page flags. Whether that
is real depends on the sheet's true depth — another thing the missing ruler measurement settles.

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
3. **The rig.** As built: 27" 16:9 panel at 42°, its bottom edge 13.5 cm above the sheet, the sheet 13.5 cm
   above the mat, and the sheet itself 2° off level with the front edge low. **Check the monitor
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
