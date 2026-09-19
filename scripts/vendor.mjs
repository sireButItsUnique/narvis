// npm run vendor: copies three.js and MediaPipe out of node_modules into public/vendor, so the page loads nothing
// from the internet (a venue's Wi-Fi can't break the demo). Without it the server sends the page to jsDelivr instead.
// The two MediaPipe models (face and hand, about 11 MB) aren't on npm: `npm run vendor -- --download` fetches them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, MODELS } from '../server/vendor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
const download = process.argv.includes('--download');

const sizeOf = f => {
  const st = fs.statSync(f);
  return st.isDirectory() ? fs.readdirSync(f).reduce((n, g) => n + sizeOf(path.join(f, g)), 0) : st.size;
};
const mb = n => (n / 1048576).toFixed(1);

for (const p of PACKAGES) {
  const src = path.join(root, 'node_modules', ...p.pkg.split('/'));
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version; } catch {}
  if (version !== p.version) {
    // the server's online fallback is pinned to p.version, so a different local copy would mix two versions
    console.error(`${p.pkg}@${p.version} isn't installed (found ${version || 'nothing'}). Run "npm install" first.`);
    process.exit(1);
  }
  const dest = path.join(out, p.dir);
  fs.rmSync(dest, { recursive: true, force: true });   // nothing left over from an older version
  for (const f of p.files) fs.cpSync(path.join(src, f), path.join(dest, f), { recursive: true });
  console.log(`${p.pkg}@${p.version} -> public/vendor/${p.dir} (${mb(sizeOf(dest))} MB)`);
}

fs.mkdirSync(path.join(out, 'models'), { recursive: true });
const missing = [];
for (const [name, url] of Object.entries(MODELS)) {
  const file = path.join(out, 'models', name);
  if (fs.existsSync(file)) { console.log(`models/${name} is there (${mb(sizeOf(file))} MB)`); continue; }
  if (!download) { missing.push([name, url]); continue; }
  const res = await fetch(url);
  if (!res.ok) { console.error(`Couldn't download ${url}: HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + '.part', file);   // a cut-off download never looks like a finished model
  console.log(`models/${name} downloaded (${mb(sizeOf(file))} MB)`);
}
if (missing.length) {
  console.log(`\nMissing ${missing.map(([n]) => n).join(' and ')}; until it's here the webcam page loads it from Google.`);
  console.log('Run "npm run vendor -- --download", or save it yourself:');
  for (const [name, url] of missing) console.log(`  ${url}\n    -> public/vendor/models/${name}`);
}
