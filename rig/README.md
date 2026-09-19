# Rig tools

Two standalone pages for the Pepper's-ghost rig: a monitor mounted above at 45° facing down, a flat acrylic
sheet under it, and the floating image under the sheet where your hands go.

Serve this folder and open the pages (they need a server, not `file://`, because they load three.js as modules):

```bash
py -m http.server 8900
```

Then `http://localhost:8900/rig/rigtest.html` and `http://localhost:8900/rig/rigsim.html`.

## rigtest.html — object viewer

Put this on the rig monitor (drag the window there, press `F`). Pure black with one bright object, sent upside
down because the sheet flips what it reflects. Use it to answer: does it float, which way round does the
picture need to be, which part of the screen lands in the open space above the base, how bright does a model
have to be, and does a "10 cm" model look 10 cm.

| Key | |
|---|---|
| drag / wheel / arrows | turn, resize, move |
| `1` `2` `3` `4` | cube, torus knot, sphere, rings |
| drop a `.glb` | show your own model |
| `T` | true size (centimetres on the sheet) |
| `I` | set the monitor's diagonal, so true size is right |
| `R` | 10 cm ruler |
| `P` | move to the screen edge nearest the sheet |
| `W` `C` `B` | wireframe, colour, brightness |
| `X` `Y` | mirror left-right, flip upside down |
| `G` | frame and centre cross |
| `H` `F` `0` | help and readout, fullscreen, reset |

The readout (`H`) shows window size, monitor size and pixel scale. A warning appears when the window is not
covering the monitor, which is the usual reason things look off-centre.

## rigsim.html — rig model

A to-scale 3D model of the rig for working out the layout: black base, acrylic, the 45° monitor, and the
mirror image of the screen that you actually see floating. Orbit it, or press "Your view" to sit at eye
level, and "Only what you'd see" to hide everything but the floating image.

Sliders: sheet height above the base, monitor height above the sheet, monitor size and tilt, ZED tilt.

Two things it makes obvious:

- Whatever you spend between monitor and sheet, you lose below the sheet. With 6" and 6" the whole image
  lands at or under the base; dropping the monitor to about 1.5" above the sheet floats roughly 11 cm of it.
- A camera at the monitor's lower edge pointing straight ahead looks over the sheet, not under it. Tilt it
  down about 35-45° to cover the hand space.
