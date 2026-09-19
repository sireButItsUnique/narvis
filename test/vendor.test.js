import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PACKAGES, MODELS, onlineUrl } from '../server/vendor.js';

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

test('vendored versions match package.json, so the online fallback serves the same code', () => {
  const deps = JSON.parse(read('../package.json')).dependencies;
  for (const p of PACKAGES) assert.equal(deps[p.pkg], p.version, p.pkg);
});

test('missing vendor files map to the same file online', () => {
  assert.equal(onlineUrl('three/build/three.module.js'), 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js');
  assert.equal(onlineUrl('three/examples/jsm/loaders/GLTFLoader.js'), 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js');
  assert.equal(onlineUrl('mediapipe/wasm/vision_wasm_internal.wasm'), 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm');
  assert.equal(onlineUrl('mediapipe/vision_bundle.mjs'), 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs');
  assert.equal(onlineUrl('models/face_landmarker.task'), MODELS['face_landmarker.task']);
});

test('anything else under /vendor stays a 404', () => {
  for (const rel of ['three/src/Three.js', 'three/package.json', 'models/other.task', 'nope/x.js', 'three/examples/jsm/../../../x',
                     'three//build/three.module.js', 'three/build/three.module.js%0d%0aX: y', 'three/build/three.module.js\r\nX: y', ''])
    assert.equal(onlineUrl(rel), null, JSON.stringify(rel));
});

test('the import map points three at /vendor, which the server can always answer', () => {
  const map = JSON.parse(read('../public/index.html').match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  assert.equal(map.three, '/vendor/three/build/three.module.js');
  assert.equal(map['three/addons/'], '/vendor/three/examples/jsm/');
  assert.ok(onlineUrl(map.three.slice('/vendor/'.length)));
  assert.ok(onlineUrl(map['three/addons/'].slice('/vendor/'.length) + 'utils/BufferGeometryUtils.js'));
});

test('the vendored Sculptor mesh loads on its own (no three import to map)', async () => {
  const { SculptorMesh } = await import('../public/js/sculpt/vendor/SculptorMesh.js');
  assert.equal(typeof SculptorMesh, 'function');
  assert.doesNotMatch(read('../public/js/sculpt/vendor/SculptorMesh.js') + read('../public/js/sculpt/vendor/SculptorUtils.js'), /from\s+'three/);
});
