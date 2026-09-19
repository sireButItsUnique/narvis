// One command for Blender mode:  npm run blender   (add -- --left for a left-handed hand mouse)
// Starts the app server (unless it's already running), opens Blender (the Holo Modeler add-on connects by itself),
// starts the hand mouse, and opens the voice page in Edge. Ctrl+C stops the hand mouse and the server; Blender stays open.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBlender, addonUpToDate, installAddon } from './install-addon.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const PORT = Number(process.env.PORT) || 8765;
const url = `http://localhost:${PORT}`;
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = p => fetch(`${url}${p}`).then(r => (r.ok ? r.json() : null)).catch(() => null);

async function main() {
  // 1. the app server
  if (await get('/api/status')) {
    if (!(await get('/api/blender/status'))) {
      console.log(`An older version of the server is still running at ${url} (from an earlier "npm start").\n`
        + 'Stop it (Ctrl+C in its terminal, or close that terminal) and run "npm run blender" again.');
      return 1;
    }
    console.log(`Server already running at ${url}`);
  } else {
    const instrument = pathToFileURL(path.join(root, 'server', 'instrument.js')).href;   // Sentry, when SENTRY_DSN is set
    children.push(spawn(process.execPath, ['--import', instrument, path.join(root, 'server.js')], { cwd: root, stdio: 'inherit' }));
    for (let i = 0; i < 40 && !(await get('/api/status')); i++) await sleep(250);
  }

  // 2. Blender, with this repo's version of the add-on
  const blender = findBlender();
  const connected = (await get('/api/blender/status'))?.connected;
  if (blender && !addonUpToDate(blender)) {
    console.log('Updating the Holo Modeler add-on in Blender...');
    try {
      installAddon(blender);
      if (connected) console.log('Updated. Restart Blender (save your work first) so it loads the new add-on.');
    } catch (err) {
      console.log(err.message);
    }
  }
  if (connected) {
    console.log('Blender is already open and connected.');
  } else if (!blender) {
    console.log('Blender not found. Install it (winget install BlenderFoundation.Blender) or set BLENDER_PATH in .env.');
  } else {
    console.log(`Opening ${blender}`);
    spawn(blender, [], { detached: true, stdio: 'ignore' }).unref();
  }

  // 3. the voice page (Edge has the speech recognition)
  spawn('cmd', ['/c', 'start', '', 'msedge', `${url}/#blender`], { detached: true, stdio: 'ignore' }).unref();

  // 4. the hand mouse (owns the webcam; the page doesn't use it in Blender mode)
  const hand = spawn('py', [path.join(root, 'handmouse', 'handmouse.py'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  children.push(hand);
  hand.on('exit', code => console.log(`Hand mouse stopped${code ? ` (exit ${code})` : ''}. Ctrl+C to stop the server too.`));
  process.on('SIGINT', () => {
    // the hand mouse gets the same Ctrl+C and lets go of every button on its way out; only force it if it hangs
    for (const c of children) if (c !== hand && c.exitCode === null) c.kill();
    setTimeout(() => { if (hand.exitCode === null) hand.kill(); }, 3000).unref();
    process.exitCode = 0;
  });
  return 0;
}

process.exitCode = await main();
