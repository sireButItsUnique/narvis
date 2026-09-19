// Plumbing for Fable's generate_texture tool: offers it only when the generator in textures.js is ready,
// saves the PNG where Blender can load it, and tells Fable the path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMPLEMENTED, generateTextureImage } from './textures.js';

const DIR = path.join(process.env.HOLOMODEL_HOME || path.join(os.homedir(), '.holomodel'), 'textures');
const SIZES = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };

export const textureToolAvailable = () => IMPLEMENTED && !!(process.env.OPENAI_API_KEY || '').trim();

export const TEXTURE_TOOL = {
  name: 'generate_texture',
  description: 'Paint a flat image (a painting on a canvas, a poster, a label, a book cover, a fabric pattern, a map) '
    + 'and save it as a PNG. Returns the file path; load it in run_blender_python with bpy.data.images.load(path) '
    + 'and use it in an Image Texture node. Use it for pictures that would be impractical to model or paint with '
    + 'numpy; describe exactly what should be in the image, front-on, with no frame or background unless wanted.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short file name, e.g. "mona_lisa_canvas".' },
      prompt: { type: 'string', description: 'What the image shows, in detail.' },
      aspect: { type: 'string', enum: Object.keys(SIZES), description: 'Image shape.' },
    },
    required: ['name', 'prompt', 'aspect'],
  },
};

export async function runTextureTool(input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { content: 'Describe what the image should show.', is_error: true };
  const png = await generateTextureImage({ prompt, size: SIZES[input.aspect] || SIZES.square });
  if (!Buffer.isBuffer(png) || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return { content: 'The image generator did not return a PNG.', is_error: true };
  }
  fs.mkdirSync(DIR, { recursive: true });
  const slug = String(input.name || 'texture').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40) || 'texture';
  const file = path.join(DIR, `${slug}_${Date.now().toString(36)}.png`);
  fs.writeFileSync(file, png);
  return { content: JSON.stringify({ path: file.replace(/\\/g, '/'), bytes: png.length }), file };
}
