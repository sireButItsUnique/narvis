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
import {toRig, cardSize, levelDepth, rayThrough, pick, eyeState, DEFAULT_VOLUME, DEFAULT_RIG_SPEC,
        rigFromSpec, fitSlab, ghostOffsetMm, panelRectOnCanvas, onPanel, fromRig, aim, touch,
        packLevel, fitZoom, boardToRig, clampView, withinSlab, prismCorners, facesToward,
        farthestFirst, PACK, rigToBoard} from './volume.mjs';

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
// Each level is packed onto a board once; the slab is a window onto it, moved by pan and zoom.
const boards = new Map();
function boardFor(key, level) {
  const signature = level.nodes.map((n) => n.id).join(',');
  const cached = boards.get(key);
  if (cached && cached.signature === signature) return cached;
  const packed = packLevel(volume, level.nodes);
  const entry = {...packed, signature, view: {panX: 0, panY: 0, zoom: fitZoom(volume, packed.board)}};
  boards.set(key, entry);
  return entry;
}

function place(level, back, key) {
  if (!level.nodes.length) return [];
  const board = boardFor(key, level);
  const depth = levelDepth(back);
  const recede = Math.max(.45, 1 - back * .22);
  const anchor = [0, -(spec.anchor_drop_cm ?? 13), 0];
  const view = board.view;
  return board.placed.map((node) => {
    const saved = positions.get(key + '|' + node.id);
    const at = saved ? [saved.boardX ?? node.board[0], saved.boardY ?? node.board[1]] : node.board;
    const zoom = view.zoom * recede;
    return {...node,
            centre: boardToRig(volume, at, {...view, zoom}, depth, anchor),
            widthCm: node.widthCm * zoom, heightCm: node.heightCm * zoom, depthCm: node.depthCm * zoom,
            boardAt: at, boardKey: key, back};
  }).filter((node) => back > 0 || withinSlab(volume, node.centre, [node.widthCm, node.heightCm], anchor));
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
    const dim = layer.back ? .3 / layer.back : 1;
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
    // Solid boxes occlude one another, so they are drawn from the back of the slab forward.
    for (const card of farthestFirst(layer.placed, eyeCm || [0, 42, 44])) drawPrism(card, layer.back, dim);
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

// A prism, drawn as the faces turned toward the eye. The front face carries the label; the sides are
// darker, which is the only shading cue available on a black field and the thing that says "solid".
function drawPrism(card, back, dim) {
  const eye = eyeCm || [0, 42, 44];
  const corners = prismCorners(card.centre, card.widthCm, card.heightCm, card.depthCm).map(screenOf);
  if (corners.some((p) => !p)) return;
  const active = !back && card.id === hover;
  const held = !back && pinch?.id === card.id;
  const edge = held ? '#8effe0' : active ? '#64f5d0' : (STROKE[card.kind] || '#2b4654');
  for (const face of facesToward(card.centre, eye)) {
    const pts = face.corners.map((i) => corners[i]);
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
    ctx.closePath();
    ctx.fillStyle = face.name === 'front' ? (held ? '#18403a' : active ? '#123029' : '#04100f') : '#020a0b';
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.globalAlpha = dim * (face.name === 'front' ? 1 : .55);
    ctx.lineWidth = held || active ? 2 : 1;
    ctx.stroke();
    ctx.globalAlpha = dim;
  }
  // Label on the front face, sized to how big that face actually came out on the panel.
  const [tl, tr, , bl] = [corners[0], corners[1], corners[2], corners[3]];
  const boxW = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const boxH = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  if (boxW < 26 || boxH < 9) return;
  const size = Math.max(7, Math.min(15, boxH * .42));
  ctx.fillStyle = active || held ? '#aaffdc' : '#9fd0da';
  ctx.font = `${size}px system-ui`;
  const room = Math.max(3, Math.floor(boxW / (size * .58)));
  ctx.fillText(card.label.length > room ? card.label.slice(0, room - 1) + '\u2026' : card.label,
               tl[0] + size * .45, tl[1] + size * 1.15);
  if ((card.files || card.symbols) && boxH > 18) {
    ctx.font = `${Math.max(6, size * .6)}px ui-monospace,monospace`;
    ctx.fillStyle = '#46727c';
    ctx.fillText(card.kind === 'folder' ? `${card.files} files \u00b7 ${card.symbols}` : `${card.symbols}`,
                 tl[0] + size * .45, tl[1] + size * 2.15);
  }
}

function status() {
  ctx.font = '11px ui-monospace,monospace';
  ctx.fillStyle = '#35636b';
  ctx.fillText(['SYSTEM'].concat(trail.map((t) => t.split('/').pop())).join('  ›  '), 18, height - 52);
  const head = frozen ? 'FROZEN' : 'HEAD OK';
  const hand = hands.enabled ? (pinch?.id ? 'GRABBING' : hover ? (aimHow === 'touch' ? 'TOUCHING' : 'POINTING')
                                                              : 'HAND READY')
                             : (hands.reason || 'no_hands').replaceAll('_', ' ').toUpperCase();
  const board = currentBoard();
  const zoom = board ? `${Math.round(board.view.zoom * 100)}%` : '--';
  ctx.fillStyle = frozen || !hands.enabled ? '#f4b975' : '#56edd4';
  ctx.fillText(`${head} · ${hand} · ${focusKind()} · ${cards.length}/${board?.placed.length ?? 0} · ${zoom}`,
               18, height - 34);
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

// ---- gestures ---------------------------------------------------------------------------------
// Three things a pinch can mean, told apart by WHAT it closed on and HOW MANY hands are pinching:
//
//   one hand, closed on a prism      pick it up. Release without moving = open it; with = place it.
//   one hand, closed on empty space  drag the board under the slab. The level pans; nothing is edited.
//   two hands, both pinching         the board is held at two points: the span sets zoom, the midpoint
//                                    sets pan. This is the only gesture that can scale, so it cannot be
//                                    confused with the others.
//
// What a pinch grabbed is decided when the fingers CLOSE and never revisited, so a drag that drifts off
// a prism keeps the prism. The second hand closing cancels any single-hand grab rather than doing both.
const MOVE_CM = 1.6;            // motion before a pinch counts as a drag rather than a tap
// Two anchors 4 cm apart with ~10 mm of differential noise is a 25% zoom error, and the content visibly
// breathes at rest. A wider minimum and a median baseline over several frames cost nothing and fix it.
const MIN_SPAN_CM = 8.0;
const SPAN_DEADBAND_CM = 1.5;
const BASELINE_FRAMES = 5;
const HOVER_AGREE = 3;          // frames a new target must win before it steals hover
const HOVER_MARGIN_CM = 0.8;    // and by how much, so two prisms 1.6 cm apart do not flicker
const LAG_MS = 120;             // commits read the pose from before the fingers flicked open
const TRAIL_MS = 400;

let grabs = new Map();          // slot -> what that hand closed on
let both = null;                // the two-handed hold, when there is one
let hoverVote = {id: null, count: 0};
const trails = new Map();       // slot -> recent anchors, so a commit need not use the release frame

function remember(slot, anchor, at) {
  const trail = trails.get(slot) || [];
  trail.push({anchor: anchor.slice(), at});
  while (trail.length > 2 && at - trail[0].at > TRAIL_MS) trail.shift();
  trails.set(slot, trail);
  return trail;
}

// The pose from LAG_MS ago. Releasing a pinch flicks the fingers apart, which drags the anchor several
// centimetres sideways on the very frame a commit would otherwise be taken from.
function lagged(slot, fallback) {
  const trail = trails.get(slot);
  if (!trail || !trail.length) return fallback;
  const want = trail[trail.length - 1].at - LAG_MS;
  for (let i = trail.length - 1; i >= 0; i--) if (trail[i].at <= want) return trail[i].anchor;
  return trail[0].anchor;
}

// Hover only changes when a new target has won several frames running AND is clearly nearer. Without
// this the highlight flickers between neighbours whenever a fingertip sits near the gap between them.
function steadyHover(aimed) {
  const id = aimed?.id ?? null;
  if (id === hoverVote.id) hoverVote.count++;
  else hoverVote = {id, count: 1};
  if (hover === id) return hover;
  const incumbent = cards.find((c) => c.id === hover);
  const clear = !incumbent || !aimed ||
    (touch(aimed.point, [incumbent])?.distance ?? Infinity) - aimed.distance > HOVER_MARGIN_CM;
  return hoverVote.count >= HOVER_AGREE && (clear || !aimed) ? id : hover;
}

function boardOf(key) { return boards.get(key); }
function currentBoard() { return boards.get(viewKey()); }

function applyView(next) {
  const board = currentBoard();
  if (!board) return;
  board.view = clampView(volume, board.board, next);
}

function endGrabs() { grabs.clear(); pinch = null; }

function updateHands() {
  const live = hands.enabled ? hands.hands.filter((h) => h.inside) : [];
  if (!live.length || !eyeCm) {
    // Losing sight of the hands drops whatever they held rather than flinging it somewhere.
    endGrabs(); both = null; hover = null; aimHow = null;
    return;
  }
  const now = performance.now();
  for (const hand of live) remember(hand.label, hand.anchor_cm || hand.index_tip_cm, now);
  const pinching = live.filter((h) => h.pinch);

  // ---- two hands: hold the board at two points ----
  if (pinching.length === 2) {
    const [a, b] = pinching.map((h) => h.anchor_cm || h.index_tip_cm);
    const span = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const board = currentBoard();
    if (board && span >= MIN_SPAN_CM) {
      if (!both) {
        endGrabs();                                   // a second hand cancels a single-hand grab
        both = {spans: [span], span, mid, view: {...board.view}};
      } else if (both.spans.length < BASELINE_FRAMES) {
        // Settle the baseline over a few frames and take the median, so one noisy frame at the moment
        // the second hand closes cannot set the scale for the whole gesture.
        both.spans.push(span);
        const sorted = [...both.spans].sort((x, y) => x - y);
        both.span = sorted[Math.floor(sorted.length / 2)];
        both.mid = mid;
      } else {
        // A dead band above the worst-case combined two-tip noise, so a still pair of hands does not
        // slowly breathe the whole level in and out.
        const delta = span - both.span;
        const effective = Math.abs(delta) < SPAN_DEADBAND_CM ? both.span
                        : both.span + delta - Math.sign(delta) * SPAN_DEADBAND_CM;
        const zoom = both.view.zoom * (effective / both.span);
        // Pan in BOARD centimetres, so dragging feels the same however far in you are zoomed.
        applyView({zoom,
                   panX: both.view.panX + (mid[0] - both.mid[0]) / zoom,
                   panY: both.view.panY - (mid[1] - both.mid[1]) / zoom});
      }
    }
    hover = null; aimHow = 'two-hand';
    return;
  }
  if (both) both = null;

  // ---- one hand ----
  const hand = pinching[0] || live[0];
  const tip = hand.anchor_cm || hand.index_tip_cm;
  const aimed = aim(eyeCm, tip, cards);
  const held = grabs.get(hand.label);
  hover = held?.id ?? steadyHover(aimed);
  aimHow = held ? 'grab' : (aimed?.how ?? null);

  if (hand.pinch && !held) {
    const board = currentBoard();
    grabs.set(hand.label, aimed
      ? {id: aimed.card.id, target: aimed.card.target, boardKey: aimed.card.boardKey,
         offset: [aimed.card.centre[0] - tip[0], aimed.card.centre[1] - tip[1], aimed.card.centre[2] - tip[2]],
         startTip: tip.slice(), moved: false}
      : {id: null, startTip: tip.slice(), moved: false, view: board ? {...board.view} : null});
  } else if (hand.pinch && held) {
    if (Math.hypot(tip[0] - held.startTip[0], tip[1] - held.startTip[1], tip[2] - held.startTip[2]) > MOVE_CM)
      held.moved = true;
    if (!held.moved) { /* still deciding whether this is a tap or a drag */ }
    else if (held.id) {
      const card = cards.find((c) => c.id === held.id);
      const board = boardOf(card?.boardKey);
      if (card && board) {
        card.centre = [tip[0] + held.offset[0], tip[1] + held.offset[1], tip[2] + held.offset[2]];
        const at = rigToBoard(volume, card.centre, board.view, [0, -(spec.anchor_drop_cm ?? 13), 0]);
        positions.set(card.boardKey + '|' + card.id, {boardX: at[0], boardY: at[1]});
        schedulePersist();
      }
    } else if (held.view) {
      // Empty-handed drag: the board slides under the slab. Nothing is edited, so nothing is saved.
      applyView({zoom: held.view.zoom,
                 panX: held.view.panX + (tip[0] - held.startTip[0]) / held.view.zoom,
                 panY: held.view.panY - (tip[1] - held.startTip[1]) / held.view.zoom});
    }
  } else if (!hand.pinch && held) {
    if (held.id && !held.moved) go(trail.concat(held.target));
    else if (held.id) {
      // Commit from before the flick: opening the fingers throws the anchor sideways, and taking the
      // release frame lands the prism centimetres from where it was actually let go.
      const card = cards.find((c) => c.id === held.id);
      const board = boardOf(card?.boardKey);
      const settled = lagged(hand.label, tip);
      if (card && board) {
        const at = rigToBoard(volume,
          [settled[0] + held.offset[0], settled[1] + held.offset[1], settled[2] + held.offset[2]],
          board.view, [0, -(spec.anchor_drop_cm ?? 13), 0]);
        positions.set(card.boardKey + '|' + card.id, {boardX: at[0], boardY: at[1]});
      }
      schedulePersist(true);
    }
    grabs.delete(hand.label);
  }
  pinch = grabs.get(hand.label) || null;
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
    let streamDown = 0;
    const events = new EventSource('/events');
    // A refused or dropped stream must LOOK refused. Without this the page keeps drawing the last graph
    // it fetched, with no head and no hands, which is indistinguishable from the rig being broken.
    events.onerror = () => {
      streamDown = streamDown || performance.now();
      serverEye = null;
      hands = {enabled: false, hands: [], reason: 'service_unreachable'};
      if (performance.now() - streamDown > 2000) note('Lost the service stream. Retrying.');
    };
    events.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      lastState = performance.now(); streamDown = 0;
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
