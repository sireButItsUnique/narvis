// Tiny static server for public/rig-demo.html and its imports: it serves the repo root, so the page can
// reach both /js/rig/*.js and /node_modules/three/*. Dev only; port 8790 (never 8765, the app's own).
// Usage: node scripts/serve-rig.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] || 8790);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
                '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wasm': 'application/wasm' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = path.join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/') p = path.join(root, 'public/rig-demo.html');
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(d);
  });
}).listen(port, '127.0.0.1', () => console.log(`rig demo on http://127.0.0.1:${port}/public/rig-demo.html`));
