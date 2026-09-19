// Model -> .glb download. Blender: File > Import > glTF 2.0; each part arrives as its own editable mesh.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildModelGroup, disposeGroup } from './builder.js';

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

// glTF is in metres and parts are in cm, so the export copy is built at 1/100 scale (a 10 cm mug stays 10 cm).
export async function glbBytes(spec) {
  const root = buildModelGroup(spec, { unit: 0.01, forExport: true });
  try { return await new GLTFExporter().parseAsync(root, { binary: true, trs: true }); }   // trs: plain location/rotation in Blender
  finally { disposeGroup(root); }
}

export async function exportGlb(spec) {
  const filename = `${slug(spec.name)}.glb`;
  const url = URL.createObjectURL(new Blob([await glbBytes(spec)], { type: 'model/gltf-binary' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}
