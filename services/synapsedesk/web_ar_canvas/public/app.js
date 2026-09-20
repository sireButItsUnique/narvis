import {solveHomography,project,IDENTITY} from './homography.mjs';
const $=id=>document.getElementById(id), canvas=$('desk'),ctx=canvas.getContext('2d');
// /display carries no editor chrome: every control binding below must tolerate a missing element.
const DISPLAY=location.pathname==='/display';
const on=(id,event,handler)=>{const el=$(id);if(el)el[event]=handler;return el;};
const set=(id,prop,value)=>{const el=$(id);if(el)el[prop]=value;};
let width=innerWidth,height=innerHeight,token='',graph={nodes:[],edges:[]},revision=-1,fetching=false;
let positions=new Map(),placed=new Set(),tracking=null,lastEvent=0,lastPinch=false,drag=null,hover=null,wireMode=false,wireSource=null,selectedId=null;
let allNodes=[],allEdges=[],fileSet=new Set();
// The desk shows one level at a time. trail is the path down: [] is the whole system,
// then directories, then a file, then a single symbol. Every level is derived from the
// same validated graph; nothing here invents nodes the analyzer did not publish.
let trail=[],pushingView=false;
const scoped=k=>k.includes('|');
try{const saved=JSON.parse(localStorage.getItem('synapsedesk.positions')||'{}');for(const [k,v] of Object.entries(saved))if(scoped(k))positions.set(k,v);}catch{}
let saveTimer=null;
function persistPositions(){if(DISPLAY)return;const payload=Object.fromEntries([...positions].filter(([k])=>scoped(k)));try{localStorage.setItem('synapsedesk.positions',JSON.stringify(payload));}catch{}clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(!token)return;fetch('/api/positions',{method:'POST',headers:{'Content-Type':'application/json','X-Synapse-Token':token},body:JSON.stringify({positions:payload})}).catch(()=>{});},800);}
let pointerDown=false,calibration=null,homography=IDENTITY.slice(),calibrationSize=null,noticeTimer;
let obstacles=[];
try{const stored=JSON.parse(localStorage.getItem('synapsedesk.calibration'));if(stored?.h?.length===9&&stored.h.every(Number.isFinite)){homography=stored.h;calibrationSize=stored.size;}}catch{}
function notify(message,sticky=false){const el=$('notice');if(!el)return;el.textContent=message;el.style.display='block';clearTimeout(noticeTimer);if(!sticky)noticeTimer=setTimeout(()=>el.style.display='none',4500);}
async function api(path,data){const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Synapse-Token':token},body:JSON.stringify(data)});const body=await res.json();if(!res.ok)throw Error(body.error||'Request failed');return body;}
function resize(){width=innerWidth;height=innerHeight;const dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(calibrationSize&&(calibrationSize[0]!==width||calibrationSize[1]!==height))notify('Display size changed. Recalibrate on the projector.');if(graph.nodes.length)relayout();}
function relayout(){const prefix=viewKey()+'|';for(const id of [...positions.keys()])if(id.startsWith(prefix)&&!placed.has(id))positions.delete(id);rebuild();}
addEventListener('resize',resize);resize();
function point(x,y){const p=project(homography,x,y);return p?[p[0]*width,p[1]*height]:null;}
function release(){drag=null;lastPinch=false;}

// ---- level model -------------------------------------------------------------
// Each level keeps its own layout, so placing nodes inside a file does not disturb
// the system view you came from.
function viewKey(){return trail.join('>')||'~';}
function posKey(id){return viewKey()+'|'+id;}
function at(id){return positions.get(posKey(id));}
function fileOf(node){return node.kind==='module'?(node.evidence?.path||''):(node.scope?.module||'');}
function focus(){return trail[trail.length-1]||'';}
function focusKind(){const f=focus();return !f?'system':f.startsWith('s:')?'symbol':fileSet.has(f)?'file':'folder';}

// A container is the repository root or a directory: its children are the immediate
// subdirectories and the files sitting directly inside it.
function containerView(dir){
 const prefix=dir?dir+'/':'';
 const children=new Map(),owner=new Map();
 const claim=(path)=>{
  if(!path||!path.startsWith(prefix))return null;
  const rest=path.slice(prefix.length),cut=rest.indexOf('/');
  const isDir=cut>=0,key=isDir?prefix+rest.slice(0,cut):path;
  if(!children.has(key))children.set(key,{id:isDir?'d:'+key:'f:'+key,target:key,label:isDir?rest.slice(0,cut)+'/':rest,
    kind:isDir?'folder':'file',files:0,symbols:0,language:''});
  return children.get(key);
 };
 for(const node of allNodes){
  const path=fileOf(node);
  const child=claim(path);
  if(!child)continue;
  owner.set(node.id,child.id);
  if(node.kind==='module'){child.files++;child.language=child.language||node.language||'';}
  else if(node.kind!=='external')child.symbols++;
 }
 const weights=new Map();
 for(const edge of allEdges){
  if(edge.kind!=='imports'&&edge.kind!=='calls'&&edge.kind!=='proposed')continue;
  const a=owner.get(edge.source),b=owner.get(edge.target);
  if(!a||!b||a===b)continue;
  const key=JSON.stringify([a,b]);
  weights.set(key,(weights.get(key)||0)+1);
 }
 const edges=[...weights].map(([key,weight])=>{const [source,target]=JSON.parse(key);
  return {id:'agg:'+key,source,target,kind:'rollup',weight};});
 return {nodes:[...children.values()].sort((a,b)=>a.kind===b.kind?a.label.localeCompare(b.label):a.kind==='folder'?-1:1),edges};
}

// A file shows the classes and functions it defines, plus the outside references they reach for.
function fileView(path){
 const members=allNodes.filter(n=>n.kind!=='external'&&n.kind!=='module'&&fileOf(n)===path);
 const ids=new Set(members.map(n=>n.id));
 const moduleNode=allNodes.find(n=>n.kind==='module'&&fileOf(n)===path);
 const byId=new Map(allNodes.map(n=>[n.id,n]));
 const outside=new Map(),edges=[];
 const include=(node)=>{if(!outside.has(node.id))outside.set(node.id,{id:node.id,target:node.id,label:node.label,
   kind:node.kind==='external'?'external':'elsewhere',kind_real:node.kind,
   where:node.kind==='external'?'unresolved':fileOf(node)});return node.id;};
 for(const edge of allEdges){
  const inSource=ids.has(edge.source),inTarget=ids.has(edge.target);
  if(edge.kind==='calls'&&inSource&&inTarget){edges.push({...edge,weight:1});continue;}
  if(edge.kind==='calls'&&inSource){const t=byId.get(edge.target);if(t)edges.push({...edge,target:include(t),weight:1});continue;}
  if(edge.kind==='imports'&&moduleNode&&edge.source===moduleNode.id){const t=byId.get(edge.target);if(t)edges.push({...edge,source:null,target:include(t),weight:1});}
 }
 const nodes=members.map(n=>({id:n.id,target:n.id,label:n.label,kind:n.kind,evidence:n.evidence,language:n.language}))
   .concat([...outside.values()]);
 return {nodes,edges:edges.filter(e=>e.source)};
}

// A single symbol with everything that calls it and everything it calls, across files.
function symbolView(id){
 const byId=new Map(allNodes.map(n=>[n.id,n]));
 const centre=byId.get(id);
 if(!centre)return {nodes:[],edges:[]};
 const keep=new Map([[id,{id,target:id,label:centre.label,kind:centre.kind,evidence:centre.evidence,centre:true}]]);
 const edges=[];
 for(const edge of allEdges){
  if(edge.kind!=='calls'&&edge.kind!=='proposed')continue;
  const other=edge.source===id?edge.target:edge.target===id?edge.source:null;
  if(!other)continue;
  const node=byId.get(other);
  if(!node)continue;
  if(!keep.has(other))keep.set(other,{id:other,target:other,label:node.label,
    kind:node.kind==='external'?'external':node.kind,where:fileOf(node)||'unresolved',evidence:node.evidence});
  edges.push({...edge,weight:1});
 }
 return {nodes:[...keep.values()],edges};
}

function deriveView(){
 const kind=focusKind();
 if(kind==='symbol')return symbolView(focus());
 if(kind==='file')return fileView(focus());
 return containerView(focus());
}

const SIZES={folder:[196,66],file:[176,56],function:[150,52],class:[150,52],elsewhere:[142,48],external:[132,44]};
function sizeOf(node){return SIZES[node.kind]||SIZES.function;}

function layout(nodes){
 const clean=document.body.classList.contains('projection');
 const left=clean?90:Math.min(width-90,width<=800?370:440),right=width-90;
 const available=Math.max(1,right-left);
 const step=Math.max(...nodes.map(n=>sizeOf(n)[0]),150)+26;
 const columns=Math.max(1,Math.min(Math.ceil(Math.sqrt(nodes.length*1.4)),Math.floor(available/step)+1));
 const rows=Math.ceil(nodes.length/columns)||1;
 const gap=Math.min(84,Math.max(58,(height-160)/Math.max(rows,1)));
 nodes.forEach((n,i)=>{
  const key=posKey(n.id);
  if(positions.has(key))return;
  positions.set(key,{x:(columns===1?(left+right)/2:left+(i%columns)*available/(columns-1))/width,
                     y:(height/2+(Math.floor(i/columns)-(rows-1)/2)*gap)/height});
 });
 return nodes;
}

function rebuild(){
 const derived=deriveView();
 graph={nodes:layout(derived.nodes),edges:derived.edges};
 release();wireSource=null;
 breadcrumb();
}
function hit(p){
 if(!p)return null;
 return [...graph.nodes].reverse().find(n=>{const q=at(n.id);if(!q)return null;const [w,h]=sizeOf(n);
  return Math.abs(p[0]-q.x*width)<w/2&&Math.abs(p[1]-q.y*height)<h/2;})?.id||null;
}

function descend(nodeId){
 const node=graph.nodes.find(n=>n.id===nodeId);
 if(!node)return;
 const kind=focusKind();
 if(kind==='symbol')return;                       // deepest level
 if(node.kind==='external'){notify(`${node.label} is an unresolved external reference — nothing indexed below it.`);return;}
 if(node.kind==='elsewhere'){goTo(trailTo(node.where).concat(node.target));return;}
 if(node.kind==='folder'||node.kind==='file'){goTo(trail.concat(node.target));return;}
 goTo(trail.concat(node.target));                 // a class or function inside a file
}
function ascend(){if(trail.length)goTo(trail.slice(0,-1));}
// A file path becomes the full trail of directories above it, so jumping from search
// or from a cross-file reference leaves a breadcrumb you can climb back up.
function trailTo(path){
 if(!path||path==='unresolved')return [];
 const parts=path.split('/'),out=[];
 for(let i=0;i<parts.length-1;i++)out.push(parts.slice(0,i+1).join('/'));
 if(fileSet.has(path))out.push(path);
 return out;
}
function goTo(next){
 trail=next.slice(0,8);
 selectedId=null;
 rebuild();
 publishView();
}
function publishView(){
 if(DISPLAY||!token||pushingView)return;
 pushingView=true;
 api('/api/view',{trail}).catch(()=>{}).finally(()=>{pushingView=false;});
}
function labelFor(entry){
 if(entry.startsWith('s:')){const n=allNodes.find(x=>x.id===entry);return n?n.label:'symbol';}
 return entry.split('/').pop()||entry;
}
function breadcrumb(){
 const counts=$('counts');
 if(counts)counts.textContent=`${graph.nodes.length} on desk · ${graph.edges.length} links · ${allNodes.length} indexed · rev ${revision}`;
 set('focusKind','textContent',focusKind().toUpperCase());
 const box=$('breadcrumb');
 if(!box)return;
 box.replaceChildren();
 const crumbs=[{label:'SYSTEM',depth:0}].concat(trail.map((entry,i)=>({label:labelFor(entry),depth:i+1})));
 crumbs.forEach((crumb,i)=>{
  if(i)box.append(Object.assign(document.createElement('span'),{className:'sep',textContent:'›'}));
  const b=document.createElement('button');
  b.textContent=crumb.label;
  b.className='crumb'+(i===crumbs.length-1?' current':'');
  b.onclick=()=>goTo(trail.slice(0,crumb.depth));
  box.append(b);
 });
}

function toggleProjection(){document.body.classList.toggle('projection');relayout();}

function findings(items,reasoning){const box=$('findings');if(!box)return;box.replaceChildren();set('findingCount','textContent',items.length);for(const item of items.slice(0,80)){const div=document.createElement('div');div.className='finding '+(item.severity==='info'?'info':'');const title=document.createElement('strong');title.textContent=item.kind.replaceAll('_',' ');const message=document.createElement('div');message.textContent=item.message;const evidence=document.createElement('small');evidence.textContent=(item.evidence||[]).map(e=>`${e.path}:${e.line}`).join(' · ');div.append(title,message,evidence);if((item.evidence||[])[0]?.path)div.onclick=()=>jumpTo(item.evidence[0].path);box.append(div);}if(reasoning){const div=document.createElement('div');div.className='finding info';div.textContent=reasoning.error?`Local model unavailable: ${reasoning.error}`:`Model suggestion (unverified): ${reasoning.summary}`;box.prepend(div);}if(!items.length&&!reasoning)box.textContent='No conflicts found within the analyzer’s coverage.';}
function jumpTo(path){const t=trailTo(path);if(!t.length){notify(`${path} is not an indexed file.`);return;}goTo(t);notify(`Opened ${path}`);}

async function refreshGraph(){if(fetching)return;fetching=true;try{const res=await fetch('/api/graph');if(!res.ok)throw Error('Graph unavailable');const data=await res.json();allNodes=data.graph.nodes;allEdges=data.graph.edges;fileSet=new Set(allNodes.filter(n=>n.kind==='module').map(n=>fileOf(n)).filter(Boolean));revision=data.revision;
 // A trail into a file that a rescan removed would strand the desk on an empty level.
 trail=trail.filter(entry=>entry.startsWith('s:')?allNodes.some(n=>n.id===entry):fileSet.has(entry)||[...fileSet].some(p=>p.startsWith(entry+'/')));
 rebuild();const rev=$('rev');if(rev)rev.textContent=`rev ${revision}`;findings(data.graph.findings||[],data.graph.reasoning);}catch(e){notify(e.message);}finally{fetching=false;}}
async function connectNode(id){if(!id)return;const node=graph.nodes.find(n=>n.id===id);if(node&&!String(node.target).match(/^[a-z]:/)&&(node.kind==='folder'||node.kind==='file')){notify('Wiring joins indexed nodes; open a file to wire its symbols.');return;}if(!wireSource){wireSource=id;notify('Source selected. Pinch or click a destination.');return;}if(wireSource===id){wireSource=null;return;}const source=wireSource;wireSource=null;try{await api('/api/wires',{source,target:id,revision});notify('Proposed connection saved to pipeline.json');}catch(e){notify(e.message);}}
function startCalibration(){calibration={source:[],target:[[.12,.15],[.88,.15],[.88,.85],[.12,.85]]};release();notify('Calibration 1/4: place index fingertip on the cross, then press Space. Esc cancels.',true);}
function recordCalibration(){if(!calibration)return;if(!tracking?.enabled||!tracking.landmarks?.[8]||performance.now()-lastEvent>250){notify('A stable live hand is required for calibration.',true);return;}const p=tracking.landmarks[8];calibration.source.push([p[0],p[1]]);if(calibration.source.length===4){try{homography=solveHomography(calibration.source,calibration.target);calibrationSize=[width,height];localStorage.setItem('synapsedesk.calibration',JSON.stringify({h:homography,size:calibrationSize}));notify('Calibration saved for this display.');}catch(e){notify(e.message);}calibration=null;}else notify(`Calibration ${calibration.source.length+1}/4: place index fingertip on the cross, then press Space.`,true);}
async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(e){notify(e.message);}}
function toggleWire(){if(DISPLAY)return;wireMode=!wireMode;wireSource=null;release();$('wire')?.classList.toggle('active',wireMode);set('selection','textContent',wireMode?'Pinch source, release, then pinch destination. Proposed connections are saved.':'Pinch to drag. Pinch and release without moving to open. Esc goes back up.');}
on('analyze','onsubmit',async e=>{e.preventDefault();try{trail=[];await api('/api/analyze',{source:$('source').value});}catch(error){notify(error.message);}});
on('bounds','onsubmit',async e=>{e.preventDefault();try{const data=Object.fromEntries([...new FormData(e.target)].map(([k,v])=>[k,Number(v)]));await api('/api/bounds',data);release();notify('Interaction workspace updated.');}catch(error){notify(error.message);}});
on('fault','onchange',()=>api('/api/demo',{fault:$('fault').value}).catch(e=>notify(e.message)));
on('calibrate','onclick',startCalibration);on('fullscreen','onclick',toggleFullscreen);on('wire','onclick',toggleWire);
on('projector','onclick',toggleProjection);on('up','onclick',ascend);
on('resetCalibration','onclick',()=>{homography=IDENTITY.slice();calibrationSize=null;localStorage.removeItem('synapsedesk.calibration');notify('Calibration reset.');});
addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
 if(e.code==='Space'&&calibration){e.preventDefault();recordCalibration();}
 else if(e.key==='Escape'||e.key==='Backspace'){e.preventDefault();
  if(calibration||wireSource){calibration=null;wireSource=null;release();notify('Interaction cancelled.');}
  else if(trail.length)ascend();}
 else if(e.key==='Enter'&&selectedId)descend(selectedId);
 else if(e.key.toLowerCase()==='c')startCalibration();else if(e.key.toLowerCase()==='f')toggleFullscreen();
 else if(e.key.toLowerCase()==='w')toggleWire();else if(e.key.toLowerCase()==='h')toggleProjection();});
// A click that does not move opens the node; a click that drags moves it. Same for a pinch.
let pressAt=null,pressMoved=false;
canvas.onpointerdown=e=>{if(calibration)return;pointerDown=true;canvas.setPointerCapture(e.pointerId);const id=hit([e.clientX,e.clientY]);selectedId=id||selectedId;pressAt=[e.clientX,e.clientY];pressMoved=false;if(wireMode)connectNode(id);else drag=id;};
canvas.onpointermove=e=>{if(!pointerDown)return;if(pressAt&&Math.hypot(e.clientX-pressAt[0],e.clientY-pressAt[1])>6)pressMoved=true;
 if(drag&&pressMoved){const q=at(drag);if(!q)return;q.x=Math.max(.06,Math.min(.94,e.clientX/width));q.y=Math.max(.1,Math.min(.9,e.clientY/height));placed.add(posKey(drag));}};
canvas.onpointerup=canvas.onpointercancel=()=>{pointerDown=false;if(drag&&pressMoved)persistPositions();else if(drag&&!wireMode)descend(drag);pressAt=null;release();};
addEventListener('blur',()=>{pointerDown=false;release();});
const links=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const STROKE={folder:'#4a8f7d',file:'#397887',class:'#6b6fa8',function:'#2b4654',elsewhere:'#5b6f52',external:'#6a5a44'};
let pinchAt=null,pinchMoved=false;
function draw(time){ctx.clearRect(0,0,width,height);ctx.fillStyle='#020608';ctx.fillRect(0,0,width,height);
 ctx.fillStyle='#153139';for(let x=24;x<width;x+=36)for(let y=24;y<height;y+=36){ctx.beginPath();ctx.arc(x,y,.65,0,Math.PI*2);ctx.fill();}
 const fresh=performance.now()-lastEvent<250,enabled=fresh&&tracking?.enabled;
 if(!fresh&&!pointerDown)release();
 const cursor=enabled&&tracking.landmarks[8]?point(...tracking.landmarks[8]):null;
 hover=hit(cursor);
 if(!pointerDown&&!calibration){const pinch=enabled&&tracking.pinch;
  if(pinch&&!lastPinch){pinchAt=cursor;pinchMoved=false;if(wireMode)connectNode(hover);else{drag=hover;selectedId=hover||selectedId;}}
  if(pinch&&cursor&&pinchAt&&Math.hypot(cursor[0]-pinchAt[0],cursor[1]-pinchAt[1])>24)pinchMoved=true;
  if(!pinch&&drag){if(pinchMoved)persistPositions();else if(!wireMode)descend(drag);drag=null;pinchAt=null;}
  if(drag&&cursor&&pinchMoved){const p=at(drag);if(p){p.x=Math.max(.06,Math.min(.94,cursor[0]/width));p.y=Math.max(.1,Math.min(.9,cursor[1]/height));placed.add(posKey(drag));}}
  lastPinch=!!pinch;}
 for(const edge of graph.edges){const a=at(edge.source),b=at(edge.target);if(!a||!b)continue;
  const weight=edge.weight||1;
  ctx.lineWidth=edge.kind==='rollup'?Math.min(5,.9+Math.log2(weight)*.9):1.3;
  ctx.setLineDash(edge.kind==='rollup'?[]:[5,8]);ctx.lineDashOffset=-time/80;
  ctx.strokeStyle=edge.kind==='proposed'?'#eabb78':edge.kind==='rollup'?'#2f6b72':'#24535e';
  ctx.globalAlpha=edge.kind==='rollup'?Math.min(1,.35+weight/12):.85;
  ctx.beginPath();ctx.moveTo(a.x*width,a.y*height);ctx.bezierCurveTo((a.x+.07)*width,a.y*height,(b.x-.07)*width,b.y*height,b.x*width,b.y*height);ctx.stroke();}
 ctx.setLineDash([]);ctx.globalAlpha=1;
 for(const node of graph.nodes){const p=at(node.id);if(!p)continue;
  const [w,h]=sizeOf(node),x=p.x*width,y=p.y*height;
  const active=node.id===hover||node.id===drag||node.id===wireSource||node.id===selectedId;
  ctx.fillStyle=active?'#153832':node.centre?'#12262b':'#0b1b22';
  ctx.strokeStyle=active?'#64f5d0':(STROKE[node.kind]||'#2b4654');
  ctx.lineWidth=active?2:node.centre?2:1;
  ctx.beginPath();ctx.roundRect(x-w/2,y-h/2,w,h,5);ctx.fill();ctx.stroke();
  ctx.font='9px ui-monospace,monospace';ctx.fillStyle='#5e9eab';
  const tag=node.kind==='folder'?'FOLDER':node.kind==='file'?(node.language||'FILE').toUpperCase():node.kind.toUpperCase();
  ctx.fillText(tag,x-w/2+12,y-h/2+16);
  if(node.kind==='folder'||node.kind==='file'){ctx.textAlign='right';ctx.fillStyle='#46727c';
   ctx.fillText(node.kind==='folder'?`${node.files} files · ${node.symbols}`:`${node.symbols} symbols`,x+w/2-12,y-h/2+16);ctx.textAlign='left';}
  ctx.font='11px system-ui';ctx.fillStyle=active?'#aaffdc':'#b8d6df';
  const room=Math.floor((w-24)/6.2);
  ctx.fillText(node.label.length>room?node.label.slice(0,room-1)+'…':node.label,x-w/2+12,y+(node.where?0:6));
  if(node.where){ctx.font='9px ui-monospace,monospace';ctx.fillStyle='#4e7c89';
   const tail=node.where.split('/').pop()||node.where;
   ctx.fillText(tail.length>24?'…'+tail.slice(-23):tail,x-w/2+12,y+h/2-9);}
 }
 if(!graph.nodes.length){ctx.textAlign='center';ctx.fillStyle='#4e7c89';ctx.font='16px system-ui';
  ctx.fillText(allNodes.length?'Nothing indexed at this level.':'Your codebase, laid out in space.',width*.65,height*.48);ctx.font='12px system-ui';
  ctx.fillText(allNodes.length?'Press Esc to go back up.':'Analyze a repository to begin.',width*.65,height*.53);ctx.textAlign='left';}
 if(fresh&&tracking?.landmarks.length===21){const points=tracking.landmarks.map(p=>point(...p));ctx.strokeStyle=enabled?'#5dffd7':'#efb879';ctx.lineWidth=2;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=10;for(const [a,b] of links){if(!points[a]||!points[b])continue;ctx.beginPath();ctx.moveTo(...points[a]);ctx.lineTo(...points[b]);ctx.stroke();}for(const p of points){if(!p)continue;ctx.beginPath();ctx.arc(...p,3,0,Math.PI*2);ctx.fillStyle='#d8fff4';ctx.fill();}ctx.shadowBlur=0;if(cursor){ctx.beginPath();ctx.arc(...cursor,tracking.pinch?15:10,0,Math.PI*2);ctx.stroke();}}
 for(const obstacle of obstacles){const a=point(obstacle.xmin,obstacle.ymin),b=point(obstacle.xmax,obstacle.ymax);if(!a||!b)continue;ctx.strokeStyle='#eabb78';ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
 if(calibration){const p=calibration.target[calibration.source.length],x=p[0]*width,y=p[1]*height;ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x-20,y);ctx.lineTo(x+20,y);ctx.moveTo(x,y-20);ctx.lineTo(x,y+20);ctx.stroke();ctx.beginPath();ctx.arc(x,y,30,0,Math.PI*2);ctx.stroke();}
 if(document.body.classList.contains('projection')){ctx.font='11px ui-monospace,monospace';
  ctx.fillStyle='#46727c';ctx.fillText(['SYSTEM'].concat(trail.map(labelFor)).join('  ›  '),20,height-38);
  ctx.fillStyle=enabled?'#56edd4':'#f4b975';
  ctx.fillText(`${tracking?.simulated?'SIMULATED · ':''}${fresh?(tracking?.reason||'waiting'):'disconnected'} · H controls`,20,height-20);}
 requestAnimationFrame(draw);
}
function wireSearchAndAgent(){
 const go=$('searchGo');
 if(go)go.onclick=()=>{
  const q=($('search').value||'').toLowerCase();const box=$('searchResults');
  if(!q){box.textContent='';return;}
  const hits=allNodes.filter(n=>n.kind!=='external'&&((n.label||'').toLowerCase().includes(q)||fileOf(n).toLowerCase().includes(q))).slice(0,8);
  box.replaceChildren();
  if(!hits.length){box.textContent='No matches in indexed components.';return;}
  for(const h of hits){const b=document.createElement('button');b.className='hit';
   b.textContent=`${h.kind} ${h.label}`;
   // Search is navigation: land on the level that actually holds the match.
   b.onclick=()=>{const path=fileOf(h);
    if(h.kind==='module')goTo(trailTo(path));
    else goTo(trailTo(path).concat(h.id));
    selectedId=h.kind==='module'?null:h.id;
    notify(`${h.label} · ${h.evidence?.path||path}:${h.evidence?.line||1}`);};
   box.append(b);}
 };
 const ex=$('agentExplain');
 if(ex)ex.onclick=async()=>{try{
  const node=selectedId?graph.nodes.find(n=>n.id===selectedId):null;
  const target=node&&!String(node.id).startsWith('d:')&&!String(node.id).startsWith('f:')?node.id:null;
  if(!target){const level=focusKind();
   $('agentOut').textContent=`${level} · ${focus()||'repository root'} · ${graph.nodes.length} children, ${graph.edges.length} links. Open a class or function for cited evidence.`;
   return;}
  const r=await api('/api/agent/explain',{node_id:target});
  $('agentOut').textContent=`${r.node.label} · cites ${(r.citations||[]).map(c=>`${c.path}:${c.line}`).join(' · ')||'no path'} · ${r.incoming.length} in / ${r.outgoing.length} out`;}catch(e){notify(e.message);}};
 const run=$('agentRun');
 if(run)run.onclick=async()=>{try{const src=$('source').value;if(!src)throw Error('Set repository first');
  const scope=focus()||'the repository root';
  const described=$('agentDesc').value||'scoped change';
  const r=await api('/api/agent/tasks',{source:src,description:`[${focusKind()} ${scope}] ${described}`,node_id:selectedId&&!selectedId.startsWith('d:')&&!selectedId.startsWith('f:')?selectedId:''});
  $('agentOut').textContent=`Task ${r.id} running against ${scope}`;}catch(e){notify(e.message);}};
 const ts=$('agentTasks');
 if(ts)ts.onclick=async()=>{try{const r=await fetch('/api/agent/tasks');const j=await r.json();$('agentOut').textContent=j.tasks.map(t=>`#${t.id} ${t.status}${t.detail?.error?' · '+t.detail.error.slice(0,80):''}`).join(' | ')||'No tasks';}catch(e){notify(e.message);}};
}
async function syncPositions(force=false){try{const p=await fetch('/api/positions');if(!p.ok)return;const pj=await p.json();for(const [k,v] of Object.entries(pj.positions||{})){if(!scoped(k))continue;if(force||!positions.has(k))positions.set(k,v);placed.add(k);}}catch{}}
async function boot(){try{const res=await fetch('/api/session');if(!res.ok)throw Error('Session unavailable');const session=await res.json();token=session.token;set('demo','hidden',!session.demo);set('mode','textContent',session.demo?'SIMULATED HAND':'LOCAL CAMERA');await syncPositions();if(DISPLAY)setInterval(()=>syncPositions(true),1500);try{const ps=await fetch('/api/provider/status');if(ps.ok){const st=await ps.json();const el=$('providerState');if(el)el.textContent=st.live?`${st.name} · live`:'stub · blocked';}}catch{}
wireSearchAndAgent();const events=new EventSource('/events');events.addEventListener('state',e=>{const data=JSON.parse(e.data);tracking=data.tracking;lastEvent=performance.now();if(data.demo_fault)set('fault','value',data.demo_fault);obstacles=data.spatial?.obstacles||[];set('tracking','textContent',tracking.reason.replaceAll('_',' ').toUpperCase());const ind=$('indicator');if(ind)ind.style.background=tracking.enabled?'#56edd4':'#f4b975';set('job','textContent',data.job.message);const go=$('analyze')?.querySelector('button');if(go)go.disabled=data.job.status==='running';
 // The projector follows whichever level the editor is looking at.
 if(DISPLAY&&Array.isArray(data.view)&&data.view.join('>')!==trail.join('>')){trail=data.view.slice(0,8);rebuild();}
 if(data.revision!==revision){refreshGraph();if(DISPLAY)syncPositions(true);}});events.onerror=()=>{set('tracking','textContent','SERVICE DISCONNECTED');release();};}catch(e){notify(e.message,true);}}
boot();requestAnimationFrame(draw);
