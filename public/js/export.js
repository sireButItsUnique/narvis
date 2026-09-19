// "export": download the scene exactly as the hidden Blender has it — the GLB it exported (GET /api/scene/<rev>.glb,
// with Fable's real materials) and the working .blend beside it, which keeps the modifiers, node trees and UVs the
// GLB flattens away. Blender: File > Open for the .blend, File > Import > glTF 2.0 for the GLB.
// From M4, hand edits are flushed first.
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

async function saveAs(url, filename) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? 'that copy of the scene is gone already, try again' : `server error ${r.status}`);
  const blob = await r.blob();
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  return filename;
}

export function downloadScene({ url, name, rev }) {
  return saveAs(url, `${slug(name)}-${rev}.glb`);
}

// the same scene as Blender's own file; the browser may ask before this second download
export function downloadBlend({ name, rev }) {
  return saveAs('/api/scene/current.blend', `${slug(name)}-${rev}.blend`);
}
