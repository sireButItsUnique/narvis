# Narvis

A desk-sized hologram you can reach into, and model in by voice.

A monitor hangs at 45° over a flat acrylic sheet, so a 3D image appears to float in the space **under** the sheet
(a Pepper's ghost). A ZED 2 stereo camera at the back of that space tracks your head and one hand in 3D. You say
**"Narvis, make a teapot"**, a headless Blender builds it, and it appears in the slot where your hand is - then you
move, turn, resize and sculpt it with your fingers, where it appears to be. Your real hand hides the model behind
it, because the page draws your hand in black exactly where it is.

## What is in here

| Folder | What it is |
|---|---|
| `gesture_detection/` | Python. Owns the ZED 2. Finds one hand (21 joints) in both lenses, fuses them into 3D, tracks the viewer's eyes, and streams both over a WebSocket. |
| `rig/` | The rig's own pages: an object viewer, a to-scale 3D model of the rig, and the calibration / test pages `rigtest2` and `rigtest3`. |
| `holomodel/` | Node app (by TC-al, imported with `git subtree`). Voice -> LLM -> headless Blender -> glTF in the page, six hand tools, and a JavaScript port of Blender's sculpt brushes. Also serves the rig page that hosts all of it: `public/rigtest3.html`. |

```
ZED 2 ──> gesture_detect.py --rig-bridge ──ws://127.0.0.1:8902──> rigtest3.html
                                                                   │  places hand + eye in the rig (your calibration)
                                                                   │  confidence gate, smoothing, off-axis projection
                                                                   │  draws your hand in black (occlusion)
                                                                   ▼
                                                          scene 8: Holomodel, hosted in the page
                                                                   │  voice ("Narvis, ..."), six tools, sculpting
                                                                   ▼
                                                 server.js (:8765) ──> one headless Blender 5.2
```

## The rig

- 27" monitor above, tilted 45°, facing down; a flat acrylic sheet under it; a black mat 13.5 cm under the sheet.
- ZED 2 at the **back** of the slot, under the sheet, tilted up about 15° (it stands on a 1.5" block), looking
  toward the viewer: it sees the hand in the slot and the viewer's face above it.
- The usable space is roughly 24 cm wide, the slot's height tall, and about 20 cm deep: the hand has to be in
  **both** lenses, and the panel's picture only covers the front of the slot.

Every number is typed into the page (`S`) and saved in the browser, so a rig built differently is a matter of
measuring it, not of editing code.

## What you need

- Windows PC with an NVIDIA GPU, a **ZED 2** and the **ZED SDK** with its Python API (`pyzed`).
- **Python 3.12** with `numpy`, `opencv-python` and `mediapipe`. The two MediaPipe models
  (`hand_landmarker.task`, `face_landmarker.task`) are in the repo.
- **Node 20.12+**, **Blender 5.2**, and **Microsoft Edge** (for speech recognition without an ElevenLabs key).
- `ANTHROPIC_API_KEY` in `holomodel/.env` for "make a ...". Copy `holomodel/.env.example` to `holomodel/.env`; it
  documents every key (ElevenLabs voice and the others are optional).

## Run it

Three things, in this order.

```sh
# 1. the tracker (owns the camera)
cd gesture_detection
python gesture_detect.py --rig-bridge

# 2. the server (owns Blender)
cd holomodel
npm install
npm start

# 3. the page, in Edge, on the rig's monitor
#    http://localhost:8765/rigtest3.html?bridge=1
```

Press `F` for fullscreen on the rig panel, then `8` for the modelling scene. Say **"Narvis, make a teapot"** - or
press `Y` for a test teapot that needs neither Blender nor a key.

The first time, on a new rig or a new browser: `S` to type in the rig's measurements, `P` to place the drawn hand
over your real one by eye, `Q` to set how sure the tracker must be before the hand is believed. The mat grid in
scene 5 should sit still on the real mat when you move your head; if it does, the display side is right.

## Using it

**Voice** (wake word "Narvis"): `make a red sports car` · `make the lid gold` · `delete the handle` ·
`add detail` · `give me the rotate tool` / `move tool` / `scale tool` / `sculpt tool` / `smooth tool` · `undo` ·
`export`. Narvis says what it has started ("Building a teapot now") and when it is done.

**Tools** (pinch to use; keys `1`-`6` or by voice):

| | Tool | With a pinch |
|---|---|---|
| `1` | move | carries the model with your hand, in three dimensions |
| `2` | rotate | turns it as your hand goes round it |
| `3` | zoom | brings it nearer or pushes it back |
| `4` | scale | bigger as your hand moves away from its middle |
| `5` | extrude | sculpts: pulls clay where your fingers are (`[` `]` brush size) |
| `6` | smooth | smooths the surface under your fingers |

With several objects in the scene, each is taken, moved, turned and resized on its own, and the move is written
back to Blender.

**Keys in scene 8**: `1`-`6` tools · `[` `]` brush · `←` `→` turn · `X` mirror · `K` clay · `R` back to the
middle · `V` microphone · `T` spoken replies · `/` type a command · `Ctrl+Z` undo · `Y` test teapot · `0` leave.
**Always the rig's**: `S` setup · `P` place the hand · `Q` tracking stability · `H` readout · `G` mat grid ·
`O` hand in black / as bones · `F` fullscreen.

**Other scenes**: `1` cube · `2` posts · `3` teapot · `4` a dropped `.glb` · `5` your hand only · `6` pick things
up and sort them · `7` press the sheet.

## Without the hardware

- `http://localhost:8765/` -> **Mouse mode**: Holomodel on an ordinary screen, with the mouse as the hand.
- `rig/` pages are static: `python -m http.server 8901` from the repo root, then
  `http://localhost:8901/rig/rigtest3/` (`?mouse=1` stands the mouse in for your head).
- The tracker replays a recording instead of a camera: `python gesture_detect.py --rig-bridge --replay FILE.svo2`
  (`--record FILE.svo2` makes one). `gesture_detection/devtools/` turns a recording into numbers: how often both
  lenses had the hand, how much the depth jumps, how far the joints wander.

## How the tracking works, briefly

MediaPipe finds the hand in the left and right image separately (each in a crop window that follows the hand,
because a small dark hand is lost in the full frame). Joints seen in both are triangulated; the rest come from a
hand model fitted to measured bone lengths. A constant-velocity filter carries the palm through frames where only
one lens has it, and only a real triangulation may overrule it. The pinch is measured in both views and held with
hysteresis, so a carried object is not dropped when the fingertips vanish behind it. The page refuses a hand the
tracker is not sure of and holds the last good one instead.

On an 82 s recording from the rig, this took frames with the hand in both lenses from 38% to 71%, depth jumps
from 251 to 34, and frame-to-frame palm depth noise (90th percentile) from 46 mm to 9 mm. One hand only, on
purpose.

## Tests

```sh
cd holomodel && npm test            # ~520 tests: commands, tools, sculpt engine, rig geometry, bridge protocol
cd rig/rigtest3 && node --test      # the rig page's own modules
cd gesture_detection && python test_tracking.py   # and the other test_*.py files, each run the same way
```

Two tests in `holomodel` fail for reasons of environment, not code: one times a fake Python bridge, and one needs
the global `WebSocket` that Node 22 has and Node 20 does not.

## Credits and licence

Tracker, rig and integration: sireButItsUnique. Holomodel (voice, Blender build loop, tools, sculpt port): TC-al.

`holomodel/` is **GPL-3.0-or-later** (it ports Blender's sculpt code; see `holomodel/LICENSE`, and
`holomodel/public/js/sculpt/vendor/LICENSE-SculptGL.txt` for the part taken from SculptGL).
