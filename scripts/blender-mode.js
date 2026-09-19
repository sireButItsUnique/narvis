// One command for Blender mode:  npm run blender   (add -- --left for a left-handed hand mouse)
// Starts the app server (unless it's already running), opens Blender (the Holo Modeler add-on connects by itself),
// starts the hand mouse, and opens the voice page in Edge. Ctrl+C stops the hand mouse and the server; Blender stays open.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const PORT = Number(process.env.PORT) || 8765;
const url = `http://localhost:${PORT}`;
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBlender() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH)) return process.env.BLENDER_PATH;
  const base = 'C:\\Program Files\\Blender Foundation';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'blender.exe'))) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions.at(-1), 'blender.exe') : null;
}

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
    children.push(spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, stdio: 'inherit' }));
    for (let i = 0; i < 40 && !(await get('/api/status')); i++) await sleep(250);
  }

  // 2. Blender
  if ((await get('/api/blender/status'))?.connected) {
    console.log('Blender is already open and connected.');
  } else {
    const blender = findBlender();
    if (!blender) {
      console.log('Blender not found. Install it (winget install BlenderFoundation.Blender) or set BLENDER_PATH in .env.');
    } else {
      console.log(`Opening ${blender}`);
      spawn(blender, [], { detached: true, stdio: 'ignore' }).unref();
    }
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
