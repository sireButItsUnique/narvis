import {solveHomography,project,IDENTITY} from './homography.mjs';
const $=id=>document.getElementById(id), canvas=$('desk'),ctx=canvas.getContext('2d');
let width=innerWidth,height=innerHeight,token='',graph={nodes:[],edges:[]},revision=-1,fetching=false;
let positions=new Map(),tracking=null,lastEvent=0,lastPinch=false,drag=null,hover=null,wireMode=false,wireSource=null,selectedId=null,allNodes=[];
try{const saved=JSON.parse(localStorage.getItem('synapsedesk.positions')||'{}');for(const [k,v] of Object.entries(saved))positions.set(k,v);}catch{}
let saveTimer=null;
function persistPositions(){try{localStorage.setItem('synapsedesk.positions',JSON.stringify(Object.fromEntries(positions)));}catch{}clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(!token)return;fetch('/api/positions',{method:'POST',headers:{'Content-Type':'application/json','X-Synapse-Token':token},body:JSON.stringify({positions:Object.fromEntries(positions)})}).catch(()=>{});},800);}
let pointerDown=false,calibration=null,homography=IDENTITY.slice(),calibrationSize=null,noticeTimer;
let obstacles=[];
try{const stored=JSON.parse(localStorage.getItem('synapsedesk.calibration'));if(stored?.h?.length===9&&stored.h.every(Number.isFinite)){homography=stored.h;calibrationSize=stored.size;}}catch{}
function notify(message,sticky=false){$('notice').textContent=message;$('notice').style.display='block';clearTimeout(noticeTimer);if(!sticky)noticeTimer=setTimeout(()=>$('notice').style.display='none',4500);}
async function api(path,data){const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Synapse-Token':token},body:JSON.stringify(data)});const body=await res.json();if(!res.ok)throw Error(body.error||'Request failed');return body;}
function resize(){width=innerWidth;height=innerHeight;const dpr=devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(calibrationSize&&(calibrationSize[0]!==width||calibrationSize[1]!==height))notify('Display size changed. Recalibrate on the projector.');if(graph.nodes.length){positions.clear();refreshGraph();}}
addEventListener('resize',resize);resize();
function point(x,y){const p=project(homography,x,y);return p?[p[0]*width,p[1]*height]:null;}
function hit(p){if(!p)return null;return [...graph.nodes].reverse().find(n=>{const q=positions.get(n.id);return q&&Math.abs(p[0]-q.x*width)<74&&Math.abs(p[1]-q.y*height)<26;})?.id||null;}
function release(){drag=null;lastPinch=false;}
function layout(nodes){
 // No truncation: every indexed component stays searchable; viewport draws what fits.
 const candidates=nodes.filter(n=>n.kind!=='external');
 const clean=document.body.classList.contains('projection');
 const left=clean?90:Math.min(width-90,width<=800?370:440),right=width-90;
 const available=Math.max(1,right-left);
 const columns=Math.max(1,Math.min(Math.ceil(Math.sqrt(candidates.length*1.4)),Math.floor(available/170)+1));
 candidates.forEach((n,i)=>{if(!positions.has(n.id))positions.set(n.id,{x:(columns===1?(left+right)/2:left+(i%columns)*available/(columns-1))/width,y:(height/2+(Math.floor(i/columns)-(Math.ceil(candidates.length/columns)-1)/2)*75)/height});});
 return candidates;
}
function toggleProjection(){document.body.classList.toggle('projection');positions.clear();refreshGraph();}

function findings(items,reasoning){const box=$('findings');box.replaceChildren();$('findingCount').textContent=items.length;for(const item of items.slice(0,80)){const div=document.createElement('div');div.className='finding '+(item.severity==='info'?'info':'');const title=document.createElement('strong');title.textContent=item.kind.replaceAll('_',' ');const message=document.createElement('div');message.textContent=item.message;const evidence=document.createElement('small');evidence.textContent=(item.evidence||[]).map(e=>`${e.path}:${e.line}`).join(' · ');div.append(title,message,evidence);box.append(div);}if(reasoning){const div=document.createElement('div');div.className='finding info';div.textContent=reasoning.error?`Local model unavailable: ${reasoning.error}`:`Model suggestion (unverified): ${reasoning.summary}`;box.prepend(div);}if(!items.length&&!reasoning)box.textContent='No conflicts found within the analyzer’s coverage.';}
async function refreshGraph(){if(fetching)return;fetching=true;try{const res=await fetch('/api/graph');if(!res.ok)throw Error('Graph unavailable');const data=await res.json();const all=data.graph.nodes;allNodes=all;const visible=layout(all);const ids=new Set(visible.map(n=>n.id));graph={nodes:visible,edges:data.graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};revision=data.revision;release();wireSource=null;const counts=$('counts');if(counts)counts.textContent=`${all.length} nodes · ${data.graph.edges.length} edges · ${visible.length} visible · rev ${revision}`;const rev=$('rev');if(rev)rev.textContent=`rev ${revision}`;findings(data.graph.findings||[],data.graph.reasoning);}catch(e){notify(e.message);}finally{fetching=false;}}
async function connectNode(id){if(!id)return;if(!wireSource){wireSource=id;notify('Source selected. Pinch or click a destination.');return;}if(wireSource===id){wireSource=null;return;}const source=wireSource;wireSource=null;try{await api('/api/wires',{source,target:id,revision});notify('Proposed connection saved to pipeline.json');}catch(e){notify(e.message);}}
function startCalibration(){calibration={source:[],target:[[.12,.15],[.88,.15],[.88,.85],[.12,.85]]};release();notify('Calibration 1/4: place index fingertip on the cross, then press Space. Esc cancels.',true);}
function recordCalibration(){if(!calibration)return;if(!tracking?.enabled||!tracking.landmarks?.[8]||performance.now()-lastEvent>250){notify('A stable live hand is required for calibration.',true);return;}const p=tracking.landmarks[8];calibration.source.push([p[0],p[1]]);if(calibration.source.length===4){try{homography=solveHomography(calibration.source,calibration.target);calibrationSize=[width,height];localStorage.setItem('synapsedesk.calibration',JSON.stringify({h:homography,size:calibrationSize}));notify('Calibration saved for this display.');}catch(e){notify(e.message);}calibration=null;}else notify(`Calibration ${calibration.source.length+1}/4: place index fingertip on the cross, then press Space.`,true);}
async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(e){notify(e.message);}}
function toggleWire(){wireMode=!wireMode;wireSource=null;release();$('wire').classList.toggle('active',wireMode);$('selection').textContent=wireMode?'Pinch source, release, then pinch destination. Proposed connections are saved.':'Pinch to pick up a node. Release to place it.';}
$('analyze').onsubmit=async e=>{e.preventDefault();try{await api('/api/analyze',{source:$('source').value});}catch(error){notify(error.message);}};
$('bounds').onsubmit=async e=>{e.preventDefault();try{const data=Object.fromEntries([...new FormData(e.target)].map(([k,v])=>[k,Number(v)]));await api('/api/bounds',data);release();notify('Interaction workspace updated.');}catch(error){notify(error.message);}};
$('fault').onchange=()=>api('/api/demo',{fault:$('fault').value}).catch(e=>notify(e.message));
$('calibrate').onclick=startCalibration;$('fullscreen').onclick=toggleFullscreen;$('wire').onclick=toggleWire;
$('projector').onclick=toggleProjection;
$('resetCalibration').onclick=()=>{homography=IDENTITY.slice();calibrationSize=null;localStorage.removeItem('synapsedesk.calibration');notify('Calibration reset.');};
addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.code==='Space'&&calibration){e.preventDefault();recordCalibration();}else if(e.key==='Escape'){calibration=null;wireSource=null;release();notify('Interaction cancelled.');}else if(e.key.toLowerCase()==='c')startCalibration();else if(e.key.toLowerCase()==='f')toggleFullscreen();else if(e.key.toLowerCase()==='w')toggleWire();else if(e.key.toLowerCase()==='h')toggleProjection();});
canvas.onpointerdown=e=>{if(calibration)return;pointerDown=true;canvas.setPointerCapture(e.pointerId);const id=hit([e.clientX,e.clientY]);selectedId=id||selectedId;if(wireMode)connectNode(id);else drag=id;};
canvas.onpointermove=e=>{if(pointerDown&&drag){const q=positions.get(drag);q.x=Math.max(.06,Math.min(.94,e.clientX/width));q.y=Math.max(.1,Math.min(.9,e.clientY/height));}};
canvas.onpointerup=canvas.onpointercancel=()=>{pointerDown=false;if(drag)persistPositions();release();};
addEventListener('blur',()=>{pointerDown=false;release();});
const links=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
function draw(time){ctx.clearRect(0,0,width,height);ctx.fillStyle='#020608';ctx.fillRect(0,0,width,height);
 ctx.fillStyle='#153139';for(let x=24;x<width;x+=36)for(let y=24;y<height;y+=36){ctx.beginPath();ctx.arc(x,y,.65,0,Math.PI*2);ctx.fill();}
 const fresh=performance.now()-lastEvent<250,enabled=fresh&&tracking?.enabled;
 if(!fresh&&!pointerDown)release();
 const cursor=enabled&&tracking.landmarks[8]?point(...tracking.landmarks[8]):null;
 hover=hit(cursor);
 if(!pointerDown&&!calibration){const pinch=enabled&&tracking.pinch;if(pinch&&!lastPinch){if(wireMode)connectNode(hover);else drag=hover;}if(!pinch)drag=null;if(drag&&cursor){const p=positions.get(drag);p.x=Math.max(.06,Math.min(.94,cursor[0]/width));p.y=Math.max(.1,Math.min(.9,cursor[1]/height));}lastPinch=!!pinch;}
 ctx.lineWidth=1.3;ctx.setLineDash([5,8]);ctx.lineDashOffset=-time/80;
 for(const edge of graph.edges){const a=positions.get(edge.source),b=positions.get(edge.target);if(!a||!b)continue;ctx.strokeStyle=edge.kind==='proposed'?'#eabb78':'#24535e';ctx.beginPath();ctx.moveTo(a.x*width,a.y*height);ctx.bezierCurveTo((a.x+.07)*width,a.y*height,(b.x-.07)*width,b.y*height,b.x*width,b.y*height);ctx.stroke();}ctx.setLineDash([]);
 for(const node of graph.nodes){const p=positions.get(node.id),x=p.x*width,y=p.y*height,active=node.id===hover||node.id===drag||node.id===wireSource;ctx.fillStyle=active?'#153832':'#0b1b22';ctx.strokeStyle=active?'#64f5d0':node.kind==='module'?'#397887':'#2b4654';ctx.lineWidth=active?2:1;ctx.beginPath();ctx.roundRect(x-74,y-26,148,52,5);ctx.fill();ctx.stroke();ctx.font='9px ui-monospace,monospace';ctx.fillStyle='#5e9eab';ctx.fillText(node.kind.toUpperCase(),x-62,y-9);ctx.font='11px system-ui';ctx.fillStyle=active?'#aaffdc':'#b8d6df';const label=node.label.length>21?node.label.slice(0,19)+'…':node.label;ctx.fillText(label,x-62,y+10);}
 if(!graph.nodes.length){ctx.textAlign='center';ctx.fillStyle='#4e7c89';ctx.font='16px system-ui';ctx.fillText('Your codebase, laid out in space.',width*.65,height*.48);ctx.font='12px system-ui';ctx.fillText('Analyze a repository to begin.',width*.65,height*.53);ctx.textAlign='left';}
 if(fresh&&tracking?.landmarks.length===21){const points=tracking.landmarks.map(p=>point(...p));ctx.strokeStyle=enabled?'#5dffd7':'#efb879';ctx.lineWidth=2;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=10;for(const [a,b] of links){if(!points[a]||!points[b])continue;ctx.beginPath();ctx.moveTo(...points[a]);ctx.lineTo(...points[b]);ctx.stroke();}for(const p of points){if(!p)continue;ctx.beginPath();ctx.arc(...p,3,0,Math.PI*2);ctx.fillStyle='#d8fff4';ctx.fill();}ctx.shadowBlur=0;if(cursor){ctx.beginPath();ctx.arc(...cursor,tracking.pinch?15:10,0,Math.PI*2);ctx.stroke();}}
 for(const obstacle of obstacles){const a=point(obstacle.xmin,obstacle.ymin),b=point(obstacle.xmax,obstacle.ymax);if(!a||!b)continue;ctx.strokeStyle='#eabb78';ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
 if(calibration){const p=calibration.target[calibration.source.length],x=p[0]*width,y=p[1]*height;ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x-20,y);ctx.lineTo(x+20,y);ctx.moveTo(x,y-20);ctx.lineTo(x,y+20);ctx.stroke();ctx.beginPath();ctx.arc(x,y,30,0,Math.PI*2);ctx.stroke();}
 if(document.body.classList.contains('projection')){ctx.fillStyle=enabled?'#56edd4':'#f4b975';ctx.font='11px ui-monospace,monospace';ctx.fillText(`${tracking?.simulated?'SIMULATED · ':''}${fresh?(tracking?.reason||'waiting'):'disconnected'} · H controls`,20,height-20);}
 requestAnimationFrame(draw);
}
function wireSearchAndAgent(){
 const go=$('searchGo');
 if(go)go.onclick=()=>{
  const q=($('search').value||'').toLowerCase();const box=$('searchResults');
  if(!q){box.textContent='';return;}
  const hits=allNodes.filter(n=>(n.label||'').toLowerCase().includes(q)||n.id.toLowerCase().includes(q)).slice(0,8);
  box.replaceChildren();
  if(!hits.length){box.textContent='No matches in indexed components.';return;}
  for(const h of hits){const b=document.createElement('button');b.textContent=`${h.kind} ${h.label}`;b.style.margin='2px';b.onclick=()=>{selectedId=h.id;const p=positions.get(h.id);if(p)notify(`${h.label} @ ${Math.round(p.x*100)}%,${Math.round(p.y*100)}% · ${h.evidence?.path||''}:${h.evidence?.line||''}`);else notify(`${h.label} · indexed but off-viewport`);};box.append(b);}
 };
 const ex=$('agentExplain');
 if(ex)ex.onclick=async()=>{try{if(!selectedId)throw Error('Select a node first');const r=await api('/api/agent/explain',{node_id:selectedId});$('agentOut').textContent=`${r.node.label} · cites ${(r.citations||[]).map(c=>`${c.path}:${c.line}`).join(' · ')||'no path'} · ${r.incoming.length} in / ${r.outgoing.length} out`;}catch(e){notify(e.message);}};
 const run=$('agentRun');
 if(run)run.onclick=async()=>{try{const src=$('source').value;if(!src)throw Error('Set repository first');const r=await api('/api/agent/tasks',{source:src,description:$('agentDesc').value||'scoped change',node_id:selectedId||''});$('agentOut').textContent=`Task ${r.id} running (snapshot, stub blocks live apply)`;}catch(e){notify(e.message);}};
 const ts=$('agentTasks');
 if(ts)ts.onclick=async()=>{try{const r=await fetch('/api/agent/tasks');const j=await r.json();$('agentOut').textContent=j.tasks.map(t=>`#${t.id} ${t.status}${t.detail?.error?' · '+t.detail.error.slice(0,80):''}`).join(' | ')||'No tasks';}catch(e){notify(e.message);}};
}
async function boot(){try{const res=await fetch('/api/session');if(!res.ok)throw Error('Session unavailable');const session=await res.json();token=session.token;const demoEl=$('demo');if(demoEl)demoEl.hidden=!session.demo;const modeEl=$('mode');if(modeEl)modeEl.textContent=session.demo?'SIMULATED HAND':'LOCAL CAMERA';try{const p=await fetch('/api/positions');if(p.ok){const pj=await p.json();for(const [k,v] of Object.entries(pj.positions||{}))if(!positions.has(k))positions.set(k,v);}}catch{}try{const ps=await fetch('/api/provider/status');if(ps.ok){const st=await ps.json();const el=$('providerState');if(el)el.textContent=st.live?`${st.name} · live`:'stub · blocked';}}catch{}
wireSearchAndAgent();const events=new EventSource('/events');events.addEventListener('state',e=>{const data=JSON.parse(e.data);tracking=data.tracking;lastEvent=performance.now();if(data.demo_fault)$('fault').value=data.demo_fault;obstacles=data.spatial?.obstacles||[];$('tracking').textContent=tracking.reason.replaceAll('_',' ').toUpperCase();$('indicator').style.background=tracking.enabled?'#56edd4':'#f4b975';$('job').textContent=data.job.message;$('analyze').querySelector('button').disabled=data.job.status==='running';if(data.revision!==revision)refreshGraph();});events.onerror=()=>{$('tracking').textContent='SERVICE DISCONNECTED';release();};}catch(e){notify(e.message,true);}}
boot();requestAnimationFrame(draw);
