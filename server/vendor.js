// What public/vendor holds and where each piece lives online. scripts/vendor.mjs fills public/vendor from
// node_modules; until it has, the server redirects the page to the online copy, so skipping it breaks nothing.
// The versions here must match package.json (test/vendor.test.js checks).
export const PACKAGES = [
  { dir: 'three', pkg: 'three', version: '0.170.0', files: ['LICENSE', 'build/three.module.js', 'examples/jsm'] },
  { dir: 'mediapipe', pkg: '@mediapipe/tasks-vision', version: '0.10.35', files: ['vision_bundle.mjs', 'wasm'] },
];

// MediaPipe's models aren't in its npm package; public/js/input/webcam.js uses these same URLs as its fallback
const GOOGLE = 'https://storage.googleapis.com/mediapipe-models';
export const MODELS = {
  'face_landmarker.task': `${GOOGLE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  'hand_landmarker.task': `${GOOGLE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
};

export const cdnBase = p => `https://cdn.jsdelivr.net/npm/${p.pkg}@${p.version}`;

// 'three/build/three.module.js' (a path under /vendor/) -> the same file online, or null if it isn't one of ours.
// The strict pattern also keeps anything odd out of the Location header.
export function onlineUrl(rel) {
  if (!/^[\w.\-/]+$/.test(rel) || rel.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  const [dir, ...rest] = rel.split('/');
  const sub = rest.join('/');
  if (dir === 'models') return MODELS[sub] || null;
  const p = PACKAGES.find(q => q.dir === dir);
  return p && p.files.some(f => sub === f || sub.startsWith(f + '/')) ? `${cdnBase(p)}/${sub}` : null;
}
