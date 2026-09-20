// Try your texture generator on its own:  node scripts/try-texture.js "a red and gold persian rug, top-down"
// Writes the PNG to your Downloads folder so you can look at it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const { IMPLEMENTED, generateTextureImage } = await import('../server/textures.js');

const prompt = process.argv.slice(2).join(' ') || 'The Mona Lisa, front-on, no frame, even museum lighting';
console.log(`IMPLEMENTED = ${IMPLEMENTED}`);
const t0 = Date.now();
const png = await generateTextureImage({ prompt, size: '1024x1024' });
const out = path.join(os.homedir(), 'Downloads', `texture-test-${Date.now()}.png`);
fs.writeFileSync(out, png);
console.log(`Saved ${out} (${png.length} bytes) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
