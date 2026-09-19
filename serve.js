const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname,types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'};
http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/headtrack-window.html';
const f=path.join(root,p);if(!f.startsWith(root)||!fs.existsSync(f)){r.writeHead(404);return r.end('not found');}
r.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);}).listen(8765,()=>console.log('serving on http://localhost:8765'));
