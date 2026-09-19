# Holomodel

Say what you want and Claude models it in a hidden Blender; then sculpt it in the browser with your hands, the
way Blender sculpts.

You say "make a victorian teapot". Claude Fable writes Blender Python and runs it in a Blender that the server
keeps running in the background, with no window. The finished model arrives in the page as a glTF file and sits in
a 3D box behind your screen: the webcam tracks your eyes so the box looks deep, and your hands reach in and hold
it. Say "make the lid gold" and Fable changes that part while everything you sculpted stays as you left it.

## Quick start

```sh
npm install
npm start          # then open http://localhost:8765 in Microsoft Edge
```

Pick **Mouse mode** if you have no webcam. Everything local — looking at the model, turning and resizing it,
`quick red`, `quick metal`, the version strip, `export` — works with no API key at all.

## What you need

- **Node 20.12 or newer.** No build step: the page is plain ES modules.
- **Microsoft Edge**, for the speech recognition the page uses when there's no ElevenLabs key.
- **Blender 5.2**, for `make a ___`. The server starts it itself, headless (`-b --factory-startup`), and you never
  see its window. Install it in the usual place or point `BLENDER_PATH` at it in `.env`; without it the log says
  `Blender not found. Install Blender 5.2 or set BLENDER_PATH in .env.`
- **`ANTHROPIC_API_KEY` in `.env`**, also for `make a ___`. Without it the server says so at startup and only the
  local commands work. Copy `.env.example` to `.env`: it documents every key the app can use (Anthropic, ElevenLabs
  voice, MongoDB Atlas for version history, Sentry, OpenAI for generated textures). None of the others are needed.

Optional: `npm run vendor -- --download` copies three.js and MediaPipe into `public/vendor` so the app runs with
the network unplugged. Skipping it breaks nothing — the server redirects `/vendor/*` to jsDelivr.

## How it works

Three processes:

- **The browser** holds the model as a tree of parts keyed by `holo_id`, lit with an environment map so gold looks
  like gold. Hands (MediaPipe) and voice (ElevenLabs Scribe, or Edge's own) drive it. `public/js/sculpt/` is
  Blender's own stroke engine and brushes, ported to JavaScript and checked against real Blender by
  `npm run parity:ref`.
- **The Node server** (`server.js`) owns exactly one headless Blender (`server/blender-process.js`): it spawns it,
  restarts it in about 3 seconds if it dies, and reopens the working autosave so nothing is lost. `server/scene.js`
  exports the Blender scene as a GLB per rev for the page; `server/blender.js` runs the Fable build loop;
  `server/versions.js` keeps a `.blend` + GLB + thumbnail per version.
- **Blender itself** runs `blender/headless.py`, which loads the bridge add-on in `blender/holomodel_bridge/`.
  It is never opened with a window.

Blender's `.blend` is the truth for anything parametric (modifiers, node trees); the page holds a live, editable
copy and sends hand edits back. `export` downloads both: the GLB and the working `.blend`.

## Tests

```sh
npm test                                                     # node --test
npm run test:blender                                         # the bridge inside real headless Blender
npm run parity:ref && npm test                               # regenerate the Blender brush fixtures, then compare
```

## Licence

GPL-3.0-or-later, and the repository is public, because `public/js/sculpt/` is derived from Blender's own
(GPL-2.0-or-later) sculpt code and serving that JavaScript counts as distribution. See [LICENSE](LICENSE), and
[NOTICE](NOTICE) for the third-party parts and their own licences (three.js, Sculptor/SculptGL, MediaPipe, all MIT).
