// ============================================================================================================
//  YOUR PART (OpenAI prize): the image generator behind Fable's generate_texture tool.
//  Build it with the OpenAI API, using Codex, and be ready to say in the demo how Codex helped.
// ============================================================================================================
//
// Fable calls this when a model needs a flat picture on it: a painting's canvas, a poster, a label, a book cover,
// a fabric print, a map. The plumbing around it (texture-tool.js) is done: it saves your PNG and tells Fable
// where it is, and Fable puts it on the material in Blender.
//
// Contract:
//   generateTextureImage({ prompt, size })
//     prompt  what to paint, written by Fable, e.g. "The Mona Lisa, Leonardo da Vinci, oil on poplar, front-on,
//             no frame, even lighting"
//     size    '1024x1024' | '1536x1024' | '1024x1536'  (square, landscape, portrait)
//   -> Promise<Buffer> of PNG bytes
//
// When it works, set IMPLEMENTED to true and restart the server; Fable is only offered the tool after that.
// Test it on its own first:  node scripts/try-texture.js "a red and gold persian rug, top-down"

export const IMPLEMENTED = false;

export async function generateTextureImage({ prompt, size }) {
  throw new Error('generateTextureImage() in server/textures.js is not written yet');
}
