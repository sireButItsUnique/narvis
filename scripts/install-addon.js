// Builds the Blender add-on (blender/holomodel_bridge) and installs it into Blender, enabled:  npm run addon
// "npm run blender" calls this by itself whenever the installed copy differs from the one in this repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'blender', 'holomodel_bridge');

export function findBlender() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH)) return process.env.BLENDER_PATH;
  const base = 'C:\\Program Files\\Blender Foundation';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'blender.exe'))) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions.at(-1), 'blender.exe') : null;
}

// where Blender keeps user extensions, e.g. %APPDATA%\Blender Foundation\Blender\5.2\extensions\user_default
function installedDir(blender) {
  const m = path.dirname(blender).match(/Blender (\d+\.\d+)/);
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return m ? path.join(appdata, 'Blender Foundation', 'Blender', m[1], 'extensions', 'user_default', 'holomodel_bridge') : null;
}

const read = f => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };

export function addonUpToDate(blender) {
  const dir = installedDir(blender);
  if (!dir) return true;   // an unusual install location: leave it to "npm run addon"
  return ['__init__.py', 'blender_manifest.toml'].every(f => read(path.join(dir, f)) === read(path.join(SOURCE, f)));
}

export function installAddon(blender) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'holomodel-addon-'));
  const zip = path.join(out, 'holomodel_bridge.zip');
  const run = args => spawnSync(blender, ['--factory-startup', '--command', 'extension', ...args], { encoding: 'utf8' });
  try {
    let r = run(['build', '--source-dir', SOURCE, '--output-filepath', zip]);
    if (r.status !== 0 || !fs.existsSync(zip)) throw new Error(`building the add-on failed:\n${r.stdout}${r.stderr}`);
    r = spawnSync(blender, ['--command', 'extension', 'install-file', '-r', 'user_default', '--enable', zip], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`installing the add-on failed:\n${r.stdout}${r.stderr}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const blender = findBlender();
  if (!blender) {
    console.log('Blender not found. Install it (winget install BlenderFoundation.Blender) or set BLENDER_PATH in .env.');
    process.exitCode = 1;
  } else {
    console.log(`Installing the Holo Modeler add-on into ${blender}…`);
    installAddon(blender);
    console.log(addonUpToDate(blender) ? 'Done. If Blender is open, restart it to load the new version.' : 'Installed, but the files differ from this repo; check the output above.');
  }
}
