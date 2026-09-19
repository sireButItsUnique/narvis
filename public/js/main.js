// Wiring: start screen, calibration panel, keys, voice + typed commands, the AI request, HUD and the frame loop.
import * as THREE from 'three';
import { S, saveSettings } from './settings.js';
import { renderer, scene, camera, rect, buildRoom, applyOffAxis } from './view.js';
import { input } from './input/state.js';
import { startCamera, track, drawDebug, eyeFilt, cam } from './input/webcam.js';
import { updateInteraction, pointedPart, tool, TOOLS, setBrush } from './interaction.js';
import { model, setModel, addPrimitive, deletePart, clearModel, scaleBy, setSpin, turnBy, undo, resetPlacement,
         recolorPart, duplicatePart, sculptedNames, layout, update as updateModel } from './model.js';
import { parseCommand, parseTyped } from './commands.js';
import { createVoice } from './voice.js';
import { exportGlb, glbBytes } from './export.js';
import { sanitizeSpec } from './spec.js';

// ---------- UI ----------
const $ = id => document.getElementById(id);
const status = msg => { $('htw-status').textContent = msg; };
const panelFields = [['p-diag', 'diagIn'], ['p-camab', 'camAboveCm'], ['p-camx', 'camXCm'], ['p-ipd', 'ipdMm'],
                     ['p-fov', 'hfovDeg'], ['p-ynudge', 'eyeYNudgeCm'], ['p-known', 'knownDistCm']];
function syncPanel() {
  for (const [id, key] of panelFields) $(id).value = +(+S[key]).toFixed(2);
  $('p-eye').value = S.eye; $('s-diag').value = S.diagIn;
}
for (const [id, key] of panelFields) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value); if (!Number.isFinite(v)) return;
    S[key] = v; saveSettings(); if (key === 'diagIn') { buildRoom(); layout(); }
  });
}
$('p-eye').addEventListener('change', () => { S.eye = $('p-eye').value; saveSettings(); });
$('s-diag').addEventListener('change', () => { const v = parseFloat($('s-diag').value); if (v > 5) { S.diagIn = v; saveSettings(); buildRoom(); layout(); } });
$('p-close').addEventListener('click', () => { $('htw-panel').hidden = true; });
$('p-cal').addEventListener('click', () => {
  if (input.mode !== 'camera' || cam.ipdHistory.length < 5 || !cam.video) { flash('Need the webcam running and your face visible'); return; }
  const med = [...cam.ipdHistory].sort((x, y) => x - y)[Math.floor(cam.ipdHistory.length / 2)];
  const fNew = S.knownDistCm * med / (S.ipdMm / 10);
  S.hfovDeg = 2 * Math.atan((cam.video.videoWidth / 2) / fNew) * 180 / Math.PI;
  saveSettings(); syncPanel(); eyeFilt.forEach(fl => fl.reset());
  flash(`Calibrated: webcam FOV ≈ ${S.hfovDeg.toFixed(1)}°`);
});

let flashUntil = 0, flashMsg = '';
function flash(msg, ms = 2500) { flashMsg = msg; flashUntil = performance.now() + ms; }

// ---------- start ----------
let started = false;
function begin() {
  $('htw-start').hidden = true;
  buildRoom(); layout();
  started = true;
  $('voice-bar').hidden = false;
  $('tool-badge').hidden = false;
  showTool();
  if (S.mic) voice.start();
}

// ---------- tool badge: what a pinch does right now ----------
const TOOL_HINT = {
  move: 'pinch to move it · two hands: turn and resize',
  sculpt: 'pinch the surface and pull like clay',
  smooth: 'pinch and rub to smooth',
  part: 'pinch a part to move just that part',
};
function showTool() {
  const brush = tool.mode === 'sculpt' || tool.mode === 'smooth';
  $('tool-name').textContent = tool.mode.toUpperCase() +
    (brush ? ` · brush ${tool.brush.toFixed(1)} cm${tool.mirror ? ' · mirror' : ''}` : '');
  $('tool-hint').textContent = TOOL_HINT[tool.mode];
}
function setTool(mode) {
  tool.mode = mode;
  showTool();
  flash(`${mode[0].toUpperCase()}${mode.slice(1)} mode`);
}
$('btn-cam').addEventListener('click', async () => {
  const v = parseFloat($('s-diag').value); if (v > 5) { S.diagIn = v; saveSettings(); }
  try {
    await startCamera(status);
    begin();
    try { await document.documentElement.requestFullscreen(); } catch (e) {}
  } catch (e) {
    console.error(e);
    status(`Couldn't start the webcam or models (${e.name || 'error'}: ${e.message || e}). Try Mouse mode, or serve this page with "npm start".`);
  }
});
$('btn-mouse').addEventListener('click', async () => {
  const v = parseFloat($('s-diag').value); if (v > 5) { S.diagIn = v; saveSettings(); }
  input.mode = 'mouse';
  begin();
  try { await document.documentElement.requestFullscreen(); } catch (e) {}
});

// ---------- voice ----------
const MIC_TEXT = {
  off: 'mic off, press V',
  listening: 'listening',
  unsupported: 'no speech recognition here: open in Edge, or press / to type',
  blocked: 'mic blocked: allow it in the address bar, then press V',
  network: 'speech service unreachable (Brave blocks it): open in Edge, or press / to type',
  error: 'voice stopped: press V to retry',
};
function showMic(state) { const el = $('mic-state'); el.textContent = MIC_TEXT[state] || state; el.dataset.state = state; }

let heardTimer = 0;
function showHeard(text, kind) {
  const el = $('heard');
  el.textContent = !text ? '' : kind === 'ignored' ? `“${text}” (not a command)` : `“${text}”`;
  el.className = kind;
  clearTimeout(heardTimer);
  if (kind !== 'interim') heardTimer = setTimeout(() => el.classList.add('stale'), 5000);
}

const voice = createVoice({
  onState: showMic,
  onInterim: text => { if (text) showHeard(text, 'interim'); },
  onFinal: text => {
    const cmd = parseCommand(text);
    showHeard(text, cmd ? 'command' : 'ignored');
    if (cmd) runCommand(cmd);
  },
});
showMic(voice.state);

// ---------- typed commands (press /) ----------
const cmdBox = $('cmd');
function openCmd() { cmdBox.hidden = false; cmdBox.value = ''; cmdBox.focus(); }
function closeCmd() { cmdBox.hidden = true; cmdBox.blur(); }
cmdBox.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') return closeCmd();
  if (e.key !== 'Enter') return;
  const text = cmdBox.value.trim();
  closeCmd();
  const cmd = parseTyped(text);
  if (!cmd) return;
  showHeard(text, 'command');
  runCommand(cmd);
});
cmdBox.addEventListener('blur', () => { cmdBox.hidden = true; });

// ---------- AI: "make a ___" / "make the handle bigger" ----------
let ai = null;        // /api/status: { provider, model }, provider null = no key yet
let pending = null;   // the request in flight: { controller, label, t0 }
function showAi() {
  $('ai-line').textContent = !ai ? ''
    : ai.offline ? 'AI: can\'t reach the local server. Start it with "npm start" and open http://localhost:8765.'
    : ai.provider ? `AI: ${ai.provider} (${ai.model}). "Make a ___" is ready.`
    : 'AI: no key yet, so "make a ___" won\'t work until one is in .env. "Add cube", "undo", "export" and the rest work now.';
}
fetch('/api/status').then(r => r.json()).then(s => { ai = s; showAi(); })
  .catch(() => { ai = { provider: null, offline: true }; showAi(); });

async function requestModel(prompt, change) {
  if (pending) { flash('Still working on the last one. Say "cancel" to stop it.'); return; }
  const current = change ? model.spec : null;   // "change" with nothing on screen just makes it
  const sculpted = current ? sculptedNames() : [];   // the AI is asked to leave hand-sculpted parts alone
  const controller = new AbortController();
  pending = { controller, label: current ? `Changing: ${prompt}` : `Designing: ${prompt}`, t0: performance.now() };
  try {
    const r = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ prompt, current, sculpted }), signal: controller.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `server error ${r.status}`);
    const { spec } = sanitizeSpec(data.model);
    if (!spec) throw new Error('the AI sent back an empty model');
    // keep sculpts only for parts that match the model as it is now (it may have been undone while we waited)
    setModel(spec, { keepPlacement: !!current, keepSculptsFrom: current && model.spec });
    flash(`${current ? 'Updated' : 'Made'} ${spec.name} (${spec.parts.length} parts)`);
  } catch (err) {
    if (err.name === 'AbortError') flash('Cancelled');
    else flash(`Couldn't do that: ${err.message}`, 7000);
  } finally {
    pending = null;
  }
}

// ---------- commands ----------
function runCommand(cmd) {
  if (!started) return;
  switch (cmd.type) {
    case 'make':   return requestModel(cmd.prompt, false);
    case 'change': return requestModel(cmd.prompt, true);
    case 'add':    return flash(`Added ${addPrimitive(cmd.shape, { word: cmd.word, fresh: cmd.fresh })}`);
    case 'delete': {
      const part = pointedPart(), label = part ? part.name : model.spec?.name;
      return flash(deletePart(part) ? `Deleted ${label}` : 'Nothing to delete');
    }
    case 'duplicate': {
      const part = pointedPart();
      if (!part) return flash('Point at a part, then say "duplicate that"');
      return flash(`Added ${duplicatePart(part)}`);
    }
    case 'color': {
      const part = pointedPart();
      if (!part) return model.spec ? requestModel(cmd.prompt, true) : flash('Nothing to colour yet');
      recolorPart(part, cmd.color);
      return flash(`Recoloured ${part.name}`);
    }
    case 'mode':   return setTool(cmd.mode);
    case 'mirror': tool.mirror = cmd.on; showTool(); return flash(`Mirror ${cmd.on ? 'on: sculpting copies across the middle' : 'off'}`);
    case 'brush':  setBrush(tool.brush * cmd.factor); showTool(); return flash(`Brush ${tool.brush.toFixed(1)} cm`);
    case 'turn':   return flash(turnBy(cmd.deg) ? `Turned ${cmd.deg === 180 ? 'around' : cmd.deg < 0 ? 'left' : 'right'}` : 'Nothing to turn');
    case 'clear':  return flash(clearModel() ? 'Cleared' : 'Already empty');
    case 'undo':   return flash(undo() ? 'Undone' : 'Nothing to undo');
    case 'scale':  return flash(scaleBy(cmd.factor) ? (cmd.factor > 1 ? 'Bigger' : 'Smaller') : 'Nothing to resize');
    case 'spin':   setSpin(cmd.on); return flash(cmd.on ? 'Spinning' : 'Stopped spinning');
    case 'export': return doExport();
    case 'cancel': return pending ? pending.controller.abort() : flash('Nothing to cancel');
    case 'mic':    voice.stop(); S.mic = false; saveSettings(); return;
  }
}

async function doExport() {
  if (!model.spec) return flash('Nothing to export yet');
  try { flash(`Saved ${await exportGlb(model.spec, model.sculpts)} to your downloads`, 4000); }
  catch (err) { console.error(err); flash(`Export failed: ${err.message}`, 6000); }
}

// ---------- keys ----------
addEventListener('keydown', async e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); runCommand({ type: 'undo' }); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === '/') { if (started) { e.preventDefault(); openCmd(); } }
  else if (k === 'f') { try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch (err) {} }
  else if (k === 'c') { syncPanel(); $('htw-panel').hidden = !$('htw-panel').hidden; }
  else if (k === 'd') { $('htw-hud').hidden = !$('htw-hud').hidden; $('htw-cam').hidden = !$('htw-cam').hidden || input.mode !== 'camera'; }
  else if (k === 'h') { S.hands = !S.hands; saveSettings(); flash(`Hands ${S.hands ? 'on' : 'off'}`); }
  else if (k === 'p') { S.popout = !S.popout; saveSettings(); layout(); flash(`Pop-out ${S.popout ? 'on: the model can come out in front of the screen' : 'off'}`); }
  else if (k === 'e') { S.eye = { center: 'left', left: 'right', right: 'center' }[S.eye]; saveSettings(); eyeFilt.forEach(fl => fl.reset()); flash(`Tracking: ${S.eye === 'center' ? 'between eyes' : S.eye + ' eye'}`); }
  else if (k === 'r') { resetPlacement(); flash('Model back in the middle'); }
  else if (k === 'v') { if (started) { S.mic = voice.toggle(); saveSettings(); } }
  else if (k >= '1' && k <= '4') { if (started) setTool(TOOLS[+k - 1]); }
  else if (k === '[' || k === ']') { if (started) runCommand({ type: 'brush', factor: k === ']' ? 1.35 : 1 / 1.35 }); }
  else if (k === 'x') { if (started) runCommand({ type: 'mirror', on: !tool.mirror }); }
  else if (k === 'arrowleft' || k === 'arrowright') { if (started) { e.preventDefault(); runCommand({ type: 'turn', deg: k === 'arrowleft' ? -30 : 30 }); } }
  else if (k === 'm') {
    if (input.mode === 'camera') { input.mode = 'mouse'; flash('Mouse mode'); }
    else if (cam.faceLm) { input.mode = 'camera'; flash('Webcam mode'); }
  }
});
const onResize = () => { renderer.setSize(innerWidth, innerHeight, false); buildRoom(); layout(); };
addEventListener('resize', onResize);
document.addEventListener('fullscreenchange', onResize);

// ---------- main loop ----------
let fps = 0, frames = 0, fpsT0 = performance.now(), lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  tick(now);
}
function tick(now) {
  const dt = Math.min(0.1, Math.max(0, now - lastT) / 1000); lastT = now;
  if (input.mode === 'camera') {
    try { track(now); }
    catch (err) { if (now > flashUntil) { console.error('tracking failed', err); flash('Tracking error (see console). Press M for mouse mode.'); } }
  }
  if (!started) { renderer.render(scene, camera); return; }

  updateInteraction();
  updateModel(dt);
  applyOffAxis(input.eye);
  renderer.render(scene, camera);
  drawDebug($('htw-cam'));

  frames++;
  if (now - fpsT0 > 500) { fps = frames * 1000 / (now - fpsT0); frames = 0; fpsT0 = now; }
  if (!$('htw-hud').hidden) {
    const eye = input.eye, cameraMode = input.mode === 'camera';
    const faceOk = now - input.faceSeenAt < 300;
    const handLine = (h, i) => `hand ${i + 1} ` + (!cameraMode ? '-' : !S.hands ? 'off' : now - h.seenAt >= 300 ? 'not seen'
      : `${h.pinch ? 'PINCH ' : 'open  '} ratio ${h.pinchRatio.toFixed(2)}  tip ${h.tip.x.toFixed(1)} ${h.tip.y.toFixed(1)} ${h.tip.z.toFixed(1)} cm`);
    $('htw-hud').textContent =
      `mode   ${input.mode}   ${fps.toFixed(0)} fps   tool ${tool.mode}\n` +
      `eye    x ${eye.x.toFixed(1)}  y ${eye.y.toFixed(1)}  z ${eye.z.toFixed(1)} cm\n` +
      `face   ${cameraMode ? (faceOk ? 'tracking' : 'LOST') : '-'}   ipd ${(cam.ipdHistory.at(-1) || 0).toFixed(1)} px\n` +
      `${input.hands.map(handLine).join('\n')}\n` +
      `screen ${rect.W.toFixed(1)} x ${rect.H.toFixed(1)} cm   fov ${S.hfovDeg.toFixed(1)}°   ${document.fullscreenElement ? 'fullscreen' : 'WINDOWED'}\n` +
      `voice  ${voice.state}\n` +
      `ai     ${ai?.provider ? `${ai.provider} ${ai.model}` : 'no key'}\n` +
      `model  ${model.spec ? `${model.spec.name}, ${model.spec.parts.length} parts, ${model.sculpts.size} sculpted, x${model.userScale.toFixed(2)}` : '-'}`;
  }

  const busy = $('ai-busy');
  busy.hidden = !pending;
  if (pending) $('ai-busy-text').textContent = `${pending.label} · ${((now - pending.t0) / 1000).toFixed(0)}s · say "cancel" to stop`;

  const banner = $('htw-banner');
  let msg = '';
  if (now < flashUntil) msg = flashMsg;
  else if (!document.fullscreenElement) msg = 'Press F for fullscreen, the 3D is only exact when the page fills the screen';
  else if (input.mode === 'camera' && now - input.faceSeenAt > 1000) msg = 'Face not found, sit in front of the webcam';
  banner.textContent = msg; banner.hidden = !msg;
}

// handy in the devtools console: htw.run('make a lamp'), htw.model; tests drive htw.tick() with fake hands
window.htw = {
  THREE, scene, model, input, S, tool, rect: () => rect,
  run: text => { const cmd = parseTyped(text); if (cmd) runCommand(cmd); return cmd; },
  glb: () => model.spec && glbBytes(model.spec, model.sculpts),
  tick: now => tick(now ?? performance.now()),
};

syncPanel();
renderer.setSize(innerWidth, innerHeight, false);
requestAnimationFrame(frame);
