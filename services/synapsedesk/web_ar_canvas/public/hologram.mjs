// The hologram view: the current graph level drawn into the rig's working volume, from where the
// viewer's eye actually is.
//
// There is no three.js here on purpose. The content is cards and links — flat quads and lines — so the
// off-axis projection from rig-geometry.mjs can be applied per corner and the result drawn with canvas 2D.
// That keeps the CSP at script-src 'self', keeps the no-npm and offline promises, and leaves the geometry
// in one tested place instead of two.
//
// The image is mirrored once for the sheet. rigCamera() already folds that into its flip flags, so the
// projection comes out the right way round and the canvas is NOT flipped again.
import {makeRig, rigCamera, projectToMonitor, rigCheck, DEFAULT_EYE} from './rig-geometry.mjs';
import {toRig, cardQuad, cardSize, levelDepth, rayThrough, pick, eyeState,
        DEFAULT_VOLUME, DEFAULT_RIG_SPEC, rigFromSpec, fitSlab, ghostOffsetMm,
        panelRectOnCanvas, onPanel, fromRig, aim, touch} from './volume.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('desk'), ctx = canvas.getContext('2d');
let width = innerWidth, height = innerHeight;
let volume = {...DEFAULT_VOLUME}, spec = {...DEFAULT_RIG_SPEC};
let rig = rigFromSpec(spec, makeRig), camera = rigCamera(rig, DEFAULT_EYE);
let allNodes = [], allEdges = [], fileSet = new Set(), trail = [], revision = -1, fetching = false;
let positions = new Map(), serverEye = null, lastState = 0, warnings = [];
let mouseEye = null, frozen = true, hover = null, cards = [];
// Hands live in the same rig centimetres as the cards, so pointing is a ray and grabbing is a distance.
let hands = {enabled: false, hands: [], reason: 'no_hands'}, pinch = null, eyeCm = null, aimHow = null;
let saveTimer = null;

const fileOf = (n) => n.kind === 'module' ? (n.evidence?.path || '') : (n.scope?.module || '');
const viewKey = () => trail.join('>') || '~';
const focus = () => trail[trail.length - 1] || '';
const focusKind = () => {const f = focus();
  return !f ? 'system' : f.startsWith('s:') ? 'symbol' : fileSet.has(f) ? 'file' : 'folder';};

function resize() {
  width = innerWidth; height = innerHeight;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

// ---- levels ---------------------------------------------------------------------------------
// The same derivation the flat canvas uses, reduced to what the volume needs: which nodes belong to a
// level and which links cross between them. No node is invented; the analyzer's graph is the only source.
function containerLevel(dir) {
  const prefix = dir ? dir + '/' : '';
  const children = new Map(), owner = new Map();
  for (const node of allNodes) {
    const path = fileOf(node);
    if (!path || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length), cut = rest.indexOf('/');
    const isDir = cut >= 0, key = isDir ? prefix + rest.slice(0, cut) : path;
    if (!children.has(key))
      children.set(key, {id: (isDir ? 'd:' : 'f:') + key, target: key,
                        label: isDir ? rest.slice(0, cut) + '/' : rest,
                        kind: isDir ? 'folder' : 'file', files: 0, symbols: 0});
    const child = children.get(key);
    owner.set(node.id, child.id);
    if (node.kind === 'module') child.files++;
    else if (node.kind !== 'external') child.symbols++;
  }
  return {nodes: [...children.values()], edges: rollup(owner)};
}

function rollup(owner) {
  const weights = new Map();
  for (const edge of allEdges) {
    if (edge.kind !== 'imports' && edge.kind !== 'calls' && edge.kind !== 'proposed') continue;
    const a = owner.get(edge.source), b = owner.get(edge.target);
    if (!a || !b || a === b) continue;
    const key = JSON.stringify([a, b]);
    weights.set(key, (weights.get(key) || 0) + 1);
  }
  return [...weights].map(([key, weight]) => {
    const [source, target] = JSON.parse(key);
    return {source, target, weight};
  });
}

function fileLevel(path) {
  const members = allNodes.filter((n) => n.kind !== 'external' && n.kind !== 'module' && fileOf(n) === path);
  const ids = new Set(members.map((n) => n.id));
  const edges = allEdges.filter((e) => e.kind === 'calls' && ids.has(e.source) && ids.has(e.target))
                        .map((e) => ({source: e.source, target: e.target, weight: 1}));
  return {nodes: members.map((n) => ({id: n.id, target: n.id, label: n.label, kind: n.kind, symbols: 0})), edges};
}

function symbolLevel(id) {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const centre = byId.get(id);
  if (!centre) return {nodes: [], edges: []};
  const keep = new Map([[id, {id, target: id, label: centre.label, kind: centre.kind, centre: true}]]);
  const edges = [];
  for (const edge of allEdges) {
    if (edge.kind !== 'calls' && edge.kind !== 'proposed') continue;
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
    if (!other) continue;
    const node = byId.get(other);
    if (!node) continue;
    if (!keep.has(other))
      keep.set(other, {id: other, target: other, label: node.label,
                       kind: node.kind === 'external' ? 'external' : node.kind});
    edges.push({source: edge.source, target: edge.target, weight: 1});
  }
  return {nodes: [...keep.values()], edges};
}

function levelFor(path) {
  if (!path) return containerLevel('');
  if (path.startsWith('s:')) return symbolLevel(path);
  if (fileSet.has(path)) return fileLevel(path);
  return containerLevel(path);
}

// ---- placement ------------------------------------------------------------------------------
// The level you are on sits at the front of the slab; the levels you came through recede behind it, so
// the way down is visible as depth rather than remembered.
function place(level, back, key) {
  const nodes = level.nodes;
  if (!nodes.length) return [];
  const columns = Math.max(1, Math.min(Math.ceil(Math.sqrt(nodes.length * 1.3)), 5));
  const rows = Math.ceil(nodes.length / columns);
  const z = levelDepth(back);
  return nodes.map((node, i) => {
    const saved = positions.get(key + '|' + node.id);
    const norm = saved ? {x: saved.x, y: saved.y, z}
                       : {x: columns === 1 ? .5 : .12 + (i % columns) * (.76 / (columns - 1)),
                          y: rows === 1 ? .5 : .16 + Math.floor(i / columns) * (.68 / (rows - 1)),
                          z};
    const [w, h] = cardSize(node.kind);
    const scale = Math.max(.45, 1 - back * .22);
    return {...node, centre: toRig(volume, norm), widthCm: w * scale, heightCm: h * scale, back};
  });
}

function build() {
  const stack = [];
  for (let back = 0; back < 3; back++) {
    const at = trail.slice(0, trail.length - back);
    if (back && !at.length && back > 0 && trail.length - back < 0) break;
    if (trail.length - back < 0) break;
    const level = levelFor(at[at.length - 1] || '');
    const placed = place(level, back, at.join('>') || '~');
    if (!placed.length) continue;
    stack.push({placed, edges: level.edges, back});
    if (!at.length) break;
  }
  cards = stack.length ? stack[0].placed : [];
  return stack;
}

// ---- drawing --------------------------------------------------------------------------------
const STROKE = {folder: '#4a8f7d', file: '#397887', class: '#6b6fa8', function: '#2b4654',
                elsewhere: '#5b6f52', external: '#6a5a44'};

let panel = {x: 0, y: 0, w: 1, h: 1};
function screenOf(point) {
  const p = projectToMonitor(rig, camera, point);
  if (p.behind) return null;
  return onPanel(panel, p.u, p.v);
}

function drawQuad(corners, fill, stroke, lineWidth) {
  const pts = corners.map(screenOf);
  if (pts.some((p) => !p)) return null;
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  if (fill) {ctx.fillStyle = fill; ctx.fill();}
  if (stroke) {ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();}
  return pts;
}

function draw() {
  // Plain acrylic reflects 4-5%, so black is transparent and only bright pixels become hologram.
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  panel = panelRectOnCanvas(width, height, rig.monitor.widthCm, rig.monitor.heightCm);
  // Outside the panel rectangle is not hologram: keep it black and show where the panel edge is.
  ctx.strokeStyle = '#0d2126'; ctx.lineWidth = 1;
  ctx.strokeRect(panel.x + .5, panel.y + .5, panel.w - 1, panel.h - 1);
  const stack = build();
  // Back to front, so nearer levels overdraw the ones they came from.
  for (const layer of [...stack].reverse()) {
    const byId = new Map(layer.placed.map((c) => [c.id, c]));
    const dim = layer.back ? .28 / layer.back : 1;
    ctx.globalAlpha = dim;
    for (const edge of layer.edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const pa = screenOf(a.centre), pb = screenOf(b.centre);
      if (!pa || !pb) continue;
      ctx.strokeStyle = '#2f6b72';
      ctx.lineWidth = Math.min(4, .8 + Math.log2(edge.weight || 1) * .8);
      ctx.beginPath(); ctx.moveTo(...pa); ctx.lineTo(...pb); ctx.stroke();
    }
    for (const card of layer.placed) {
      const active = !layer.back && card.id === hover;
      const pts = drawQuad(cardQuad(card.centre, card.widthCm, card.heightCm),
                           active ? '#123029' : '#04100f',
                           active ? '#64f5d0' : (STROKE[card.kind] || '#2b4654'),
                           active ? 2 : 1);
      if (!pts) continue;
      const left = Math.min(pts[0][0], pts[3][0]), top = Math.min(pts[0][1], pts[1][1]);
      const boxW = Math.max(pts[1][0], pts[2][0]) - left;
      const size = Math.max(7, Math.min(16, boxW / 11));
      ctx.fillStyle = active ? '#aaffdc' : '#9fd0da';
      ctx.font = `${size}px system-ui`;
      const room = Math.max(4, Math.floor(boxW / (size * .58)));
      ctx.fillText(card.label.length > room ? card.label.slice(0, room - 1) + '…' : card.label,
                   left + size * .6, top + size * 1.6);
      if (card.files || card.symbols) {
        ctx.font = `${Math.max(6, size * .62)}px ui-monospace,monospace`;
        ctx.fillStyle = '#46727c';
        ctx.fillText(card.kind === 'folder' ? `${card.files} files · ${card.symbols}` : `${card.symbols}`,
                     left + size * .6, top + size * 2.9);
      }
    }
  }
  ctx.globalAlpha = 1;
  drawHands();
  status();
  requestAnimationFrame(draw);
}

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

// The hand is drawn thin and dim on purpose. It is real and it is already in the volume; a bright
// skeleton would light up the acrylic and sit in front of the very card it is reaching for.
function drawHands() {
  if (!hands.hands?.length) return;
  for (const hand of hands.hands) {
    const pts = hand.landmarks_cm.map(screenOf);
    ctx.globalAlpha = hand.inside ? .55 : .25;
    ctx.strokeStyle = hand.pinch ? '#64f5d0' : '#3d7f88';
    ctx.lineWidth = 1;
    for (const [a, b] of BONES) {
      if (!pts[a] || !pts[b]) continue;
      ctx.beginPath(); ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); ctx.stroke();
    }
    const tip = pts[8];
    if (tip) {
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(tip[0], tip[1], hand.pinch ? 9 : 5, 0, Math.PI * 2); ctx.stroke();
      // Where the eye-through-fingertip ray lands: the thing you are actually pointing at.
      if (eyeCm && !pinch && aimHow === 'ray') {
        const got = pick(rayThrough(eyeCm, hand.index_tip_cm), cards);
        if (got) {
          const at = screenOf(got.point);
          if (at) {
            ctx.strokeStyle = '#64f5d0'; ctx.globalAlpha = .5;
            ctx.beginPath(); ctx.moveTo(...tip); ctx.lineTo(...at); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.arc(at[0], at[1], 3, 0, Math.PI * 2); ctx.stroke();
          }
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

function status() {
  ctx.font = '11px ui-monospace,monospace';
  ctx.fillStyle = '#35636b';
  ctx.fillText(['SYSTEM'].concat(trail.map((t) => t.split('/').pop())).join('  ›  '), 18, height - 52);
  const head = frozen ? 'FROZEN' : 'HEAD OK';
  const hand = hands.enabled ? (pinch?.id ? 'GRABBING' : hover ? (aimHow === 'touch' ? 'TOUCHING' : 'POINTING')
                                                              : 'HAND READY')
                             : (hands.reason || 'no_hands').replaceAll('_', ' ').toUpperCase();
  ctx.fillStyle = frozen || !hands.enabled ? '#f4b975' : '#56edd4';
  ctx.fillText(`${head} · ${hand} · ${focusKind()} · ${cards.length} cards`, 18, height - 34);
  if (warnings.length) {
    ctx.fillStyle = '#f4b975';
    ctx.fillText(warnings[0].slice(0, 110), 18, height - 16);
  }
}

// ---- input ----------------------------------------------------------------------------------
// No head tracker yet: the mouse stands in for the eye so the geometry can be judged without cameras.
// It is labelled SIMULATED and never silently substitutes for a real head position.
addEventListener('pointermove', (e) => {
  mouseEye = [(e.clientX / width - .5) * 60, 42 - (e.clientY / height - .5) * 34, 44];
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Backspace') {e.preventDefault(); if (trail.length) go(trail.slice(0, -1));}
  else if (e.key.toLowerCase() === 'm') {mouseEye = null; note('Mouse stand-in released.');}
  else if (e.key.toLowerCase() === 'f') document.documentElement.requestFullscreen?.().catch(() => {});
});
canvas.addEventListener('pointerdown', () => {if (hover) go(trail.concat(targetOf(hover)));});

const targetOf = (id) => cards.find((c) => c.id === id)?.target || id;
let token = '';
function go(next) {
  trail = next.slice(0, 8);
  if (token) fetch('/api/view', {method: 'POST', headers: {'Content-Type': 'application/json',
    'X-Synapse-Token': token}, body: JSON.stringify({trail})}).catch(() => {});
}
function note(message) {
  const el = $('notice'); if (!el) return;
  el.textContent = message; el.style.display = 'block';
  setTimeout(() => {el.style.display = 'none';}, 3000);
}

// The eye drives both the projection and the pointer: a ray from the eye through the fingertip lands
// where the viewer perceives they are pointing, which is what makes pointing work in a Pepper's ghost.
// The rig is measurements, so rebuild the optics whenever they change rather than at load only.
function applyRig() {
  rig = rigFromSpec(spec, makeRig);
  camera = rigCamera(rig, DEFAULT_EYE);
  const fitted = fitSlab(rig, DEFAULT_EYE, (p) => projectToMonitor(rig, camera, p));
  if (fitted.width_cm > 0 &&
      Math.abs(fitted.width_cm - volume.width_cm) > Math.max(2, volume.width_cm * .08))
    note(`Rig allows ${fitted.width_cm}x${fitted.height_cm}x${fitted.depth_cm} cm; volume says ` +
         `${volume.width_cm}x${volume.height_cm}x${volume.depth_cm}. Check the panel diagonal.`);
}

// One pinch at a time, and what it grabbed is decided when the fingers CLOSE, not continuously: a pinch
// that drifts off a card mid-drag must keep the card it picked up.
function updateHands() {
  const hand = hands.enabled ? hands.hands.find((h) => h.inside) : null;
  if (!hand || !eyeCm) {
    if (pinch) pinch = null;          // losing the hand drops what it held rather than flinging it
    hover = null;
    return;
  }
  const tip = hand.index_tip_cm;
  const aimed = aim(eyeCm, tip, cards);
  hover = pinch ? pinch.id : (aimed?.id ?? null);
  aimHow = aimed?.how ?? null;
  if (hand.pinch && !pinch) {
    const got = aimed;
    if (got) {
      const card = got.card;
      pinch = {id: card.id, target: card.target, startTip: tip.slice(),
               offset: [card.centre[0] - tip[0], card.centre[1] - tip[1], card.centre[2] - tip[2]],
               moved: false};
    } else {
      pinch = {id: null, startTip: tip.slice(), moved: false};
    }
  } else if (hand.pinch && pinch) {
    if (Math.hypot(tip[0] - pinch.startTip[0], tip[1] - pinch.startTip[1],
                   tip[2] - pinch.startTip[2]) > 1.6) pinch.moved = true;
    if (pinch.id && pinch.moved) {
      const card = cards.find((c) => c.id === pinch.id);
      if (card) {
        card.centre = [tip[0] + pinch.offset[0], tip[1] + pinch.offset[1], tip[2] + pinch.offset[2]];
        const norm = fromRig(volume, card.centre, [0, -spec.anchor_drop_cm, 0]);
        positions.set(viewKey() + '|' + card.id,
                      {x: clamp(norm.x), y: clamp(norm.y), z: clamp(norm.z)});
        schedulePersist();
      }
    }
  } else if (!hand.pinch && pinch) {
    // Released. A pinch that never moved is "open this"; one that moved was a placement.
    if (pinch.id && !pinch.moved) go(trail.concat(pinch.target));
    else if (pinch.id) schedulePersist(true);      // a placement is finished; write it now
    pinch = null;
  }
}

const clamp = (v) => Math.max(0, Math.min(1, v));

// A plain debounce never fires while a hand is moving, because a tracked hand is never quite still: every
// frame pushed the save further out and a drag that lasted longer than the delay saved nothing at all.
// So: debounce for smoothness, but never wait longer than SAVE_MAX_MS, and flush the moment a grab ends.
const SAVE_QUIET_MS = 350, SAVE_MAX_MS = 1200;
let saveDue = 0;
function sendPositions() {
  if (!token) return;
  saveDue = 0;
  fetch('/api/positions', {method: 'POST', headers: {'Content-Type': 'application/json',
    'X-Synapse-Token': token}, body: JSON.stringify({positions: Object.fromEntries(positions)})})
    .catch(() => {});
}
function schedulePersist(flush = false) {
  clearTimeout(saveTimer);
  if (flush) return sendPositions();
  if (!saveDue) saveDue = performance.now() + SAVE_MAX_MS;
  const wait = Math.max(0, Math.min(SAVE_QUIET_MS, saveDue - performance.now()));
  saveTimer = setTimeout(sendPositions, wait);
}

function updateEye() {
  const live = eyeState(serverEye, performance.now());
  const eye = live.usable ? serverEye.position_cm : (mouseEye || null);
  frozen = !live.usable && !mouseEye;
  if (!eye) {eyeCm = null; hover = null; pinch = null; return;}
  eyeCm = eye;
  camera = rigCamera(rig, eye);
  warnings = rigCheck(rig, eye).warnings;
  updateHands();
}

async function syncPositions() {
  try {
    const res = await fetch('/api/positions');
    if (!res.ok) return;
    const saved = (await res.json()).positions || {};
    positions = new Map(Object.entries(saved).filter(([k]) => k.includes('|')));
  } catch {}
}

async function refreshGraph() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) return;
    const data = await res.json();
    allNodes = data.graph.nodes; allEdges = data.graph.edges;
    fileSet = new Set(allNodes.filter((n) => n.kind === 'module').map(fileOf).filter(Boolean));
    revision = data.revision;
  } catch {} finally {fetching = false;}
}

async function boot() {
  try {
    const session = await (await fetch('/api/session')).json();
    token = session.token;
    spec = await (await fetch('/api/rig')).json();
    volume = await (await fetch('/api/volume')).json();
    applyRig();
    // Deliberate placements only, from the service. localStorage holds the EDITOR's automatic layout,
    // which reserves the left third of its window for the control panel — the rig has no panel, so
    // inheriting that would push the whole hologram to one side of the slab.
    await syncPositions();
    await refreshGraph();
    const events = new EventSource('/events');
    events.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      lastState = performance.now();
      if (data.volume) volume = data.volume;
      if (data.rig && JSON.stringify(data.rig) !== JSON.stringify(spec)) {spec = data.rig; applyRig();}
      if (data.eye) serverEye = {...data.eye, received_ms: performance.now() - (data.eye.age_ms || 0)};
      else serverEye = null;
      if (data.hands) hands = data.hands;
      if (Array.isArray(data.view) && data.view.join('>') !== trail.join('>')) trail = data.view.slice(0, 8);
      if (data.revision !== revision) {refreshGraph(); syncPositions();}
      updateEye();
    });
  } catch (e) {note(e.message);}
}
setInterval(updateEye, 1000 / 30);
boot();
requestAnimationFrame(draw);
