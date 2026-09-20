// npm run check: tries every key in .env for real, with the smallest possible request, and says what works.
// Costs well under a cent (a two-word ElevenLabs voice clip and its transcript; nothing else is billed).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const env = name => (process.env[name] || '').trim();

const results = [];
async function check(name, needs, fn) {
  if (needs && !env(needs)) { results.push([name, 'skip', `add ${needs} to .env`]); return; }
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push([name, 'ok', `${detail} (${((Date.now() - t0) / 1000).toFixed(1)}s)`]);
  } catch (err) {
    results.push([name, 'FAIL', err.message?.split('\n')[0] || String(err)]);
  }
}

await check('Anthropic (Blender builds)', 'OPENAI_API_KEY', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const model = env('BLENDER_MODEL') || 'claude-fable-5-1';
  const m = await new Anthropic({ apiKey: env('OPENAI_API_KEY') }).models.retrieve(model);
  return `${m.id} is available`;
});

await check('MongoDB Atlas (version history)', 'MONGODB_URI', async () => {
  const { AtlasStore } = await import('../server/history.js');
  const dbName = 'holomodel_check';   // a scratch database, dropped afterwards
  const store = await new AtlasStore().init(env('MONGODB_URI'), dbName);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-check-'));
  try {
    const blend = crypto.randomBytes(300 * 1024), thumb = crypto.randomBytes(2000);
    fs.writeFileSync(path.join(tmp, 'in.blend'), blend);
    const v = await store.add({ kind: 'check', prompt: 'npm run check' }, path.join(tmp, 'in.blend'), thumb);
    const [listed] = await store.list(1);
    const found = await store.find(v.n);
    const back = await store.thumb(v.id);
    const file = await store.blendPath(v.id, tmp);
    if (listed?.id !== v.id || found?.id !== v.id) throw new Error('saved a version but could not list or find it');
    if (!back?.equals(thumb)) throw new Error('the thumbnail came back different');
    if (!fs.readFileSync(file).equals(blend)) throw new Error('the GridFS snapshot came back different');
    return `saved, listed and read back a 300 KB snapshot through GridFS (${store.db.databaseName} on ${new URL(env('MONGODB_URI').replace(/^mongodb(\+srv)?:/, 'http:')).hostname})`;
  } finally {
    await store.db.dropDatabase().catch(() => {});
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('ElevenLabs (voice in and out)', 'ELEVENLABS_API_KEY', async () => {
  const { speak, transcribe } = await import('../server/voice.js');
  const chunks = [];
  for await (const c of await speak('Save version.')) chunks.push(c);
  const mp3 = Buffer.concat(chunks);
  if (mp3.length < 1000) throw new Error(`text to speech returned only ${mp3.length} bytes`);
  const heard = await transcribe(mp3, 'audio/mpeg');
  return `spoke "Save version." (${Math.round(mp3.length / 1024)} KB of audio) and Scribe heard "${heard}"`;
});

const width = Math.max(...results.map(r => r[0].length));
console.log('');
for (const [name, state, detail] of results) console.log(`${state.padEnd(4)}  ${name.padEnd(width)}  ${detail}`);
console.log('');
process.exitCode = results.some(r => r[1] === 'FAIL') ? 1 : 0;
