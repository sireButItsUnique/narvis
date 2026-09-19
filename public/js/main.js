// Wiring: start screen, calibration panel, keys, voice + typed commands, the scene from the hidden Blender,
// Fable builds, versions, HUD and the frame loop.
import * as THREE from 'three';
import { S, saveSettings } from './settings.js';
import { renderer, scene, camera, rect, buildRoom, applyOffAxis, renderViews, clayMaterial } from './view.js';
import { input } from './input/state.js';
import { startCamera, track, drawDebug, eyeFilt, cam } from './input/webcam.js';
import { updateInteraction, pointedPart, tool, TOOLS, setBrush, setNotify, SCULPT_SOON } from './interaction.js';
import { model, parts, showScene, clearScene, scaleBy, setSpin, turnBy, undo, resetPlacement, focusPart,
         deletePart, duplicatePart, quickColor, quickFinish, layout, update as updateModel } from './model.js';
import { fetchScene } from './scene/load.js';
import { initBuild, build, cancelBuild, work, toggleLog } from './scene/build.js';
import { initVersions, refreshVersions, noteCurrent, restoreVersion, saveVersion, showVersions } from './scene/versions.js';
import { highlighted } from './scene/highlight.js';
import { parseCommand, parseTyped } from './commands.js';
import { createVoice, createCloudVoice } from './voice.js';
import { createSpeaker } from './speak.js';
import { startSentry, tag } from './observability.js';
import { downloadScene, downloadBlend } from './export.js';

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
setNotify(msg => flash(msg, 3500));

// ---------- start ----------
let started = false;
let clayOn = false;   // "clay view": every part in one matte material
function begin() {
  $('htw-start').hidden = true;
  buildRoom(); layout();
  started = true;
  $('voice-bar').hidden = false;
  $('tool-badge').hidden = false;
  showTool();
  showSceneState();
  refreshVersions();
  if (S.mic) voice.start();
}

// ---------- tool badge: what a pinch does right now ----------
const TOOL_HINT = {
  move: 'pinch to move it · two hands: turn and resize',
  sculpt: 'sculpting arrives in the next build',
  smooth: 'sculpting arrives in the next build',
  part: 'pinch a part to move just that part (this view only for now)',
};
function showTool() {
  const brush = tool.mode === 'sculpt' || tool.mode === 'smooth';
  $('tool-name').textContent = tool.mode.toUpperCase() +
    (brush ? ` · brush ${tool.brush.toFixed(1)} cm${tool.mirror ? ' · mirror' : ''}` : '') +
    (clayOn ? ' · clay view' : '');
  $('tool-hint').textContent = TOOL_HINT[tool.mode];
}
function setTool(mode) {
  tool.mode = mode;
  showTool();
  flash(mode === 'sculpt' || mode === 'smooth' ? SCULPT_SOON : `${mode[0].toUpperCase()}${mode.slice(1)} mode`, 3500);
}
$('btn-cam').addEventListener('click', async () => {
  const v = parseFloat($('s-diag').value); if (v > 5) { S.diagIn = v; saveSettings(); }
  try {
    await startCamera(status);
    tag('mode', 'camera');
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
  tag('mode', 'mouse');
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
function showMic(state) {
  const el = $('mic-state');
  el.textContent = (MIC_TEXT[state] || state) + (state === 'listening' && voice?.engine === 'elevenlabs' ? ' (ElevenLabs)' : '');
  el.dataset.state = state;
}

let heardTimer = 0;
function showHeard(text, kind) {
  const el = $('heard');
  el.textContent = !text ? '' : kind === 'ignored' ? `“${text}” (not a command)` : `“${text}”`;
  el.className = kind;
  clearTimeout(heardTimer);
  if (kind !== 'interim') heardTimer = setTimeout(() => el.classList.add('stale'), 5000);
}

const voiceHandlers = {
  onState: s => showMic(s),
  onInterim: text => { if (text) showHeard(text, 'interim'); },
  onFinal: text => {
    const cmd = parseCommand(text);
    showHeard(text, cmd ? 'command' : 'ignored');
    if (cmd) runCommand(cmd);
  },
};
let voice = createVoice(voiceHandlers);   // Edge's recogniser until /api/config says ElevenLabs is set up
showMic(voice.state);

// the reply voice; the mic ignores what it hears while this talks
let speaker = createSpeaker({ onTalking: on => voice.mute(on) });
const say = text => { if (S.talk) speaker.say(text); };

function useVoiceEngine(kind) {
  if (voice.engine === kind) return;
  const wasOn = voice.wanted;
  voice.stop();
  voice = kind === 'elevenlabs'
    ? createCloudVoice({ ...voiceHandlers, onFail: err => {
        flash(`ElevenLabs voice failed (${err.message}), so using the browser's`, 6000);
        useVoiceEngine('browser');
      } })
    : createVoice(voiceHandlers);
  showMic(voice.state);
  if (wasOn) voice.start();
}

// which integrations the server has keys for: ElevenLabs voice, Sentry, where version history is kept
fetch('/api/config').then(r => r.json()).then(config => {
  if (config.voice === 'elevenlabs') {
    useVoiceEngine('elevenlabs');
    speaker = createSpeaker({ engine: 'elevenlabs', onTalking: on => voice.mute(on) });
  }
  startSentry(config).catch(err => console.warn(err.message));
}).catch(() => {});

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

// ---------- the scene: the hidden Blender exports a GLB per rev; poll the cheap JSON, load the GLB on a new rev ----------
const POLL_MS = 2000;
let sceneInfo = null;    // the last GET /api/scene reply
let connError = '';      // why /api/scene can't be read
let loadError = '';      // why the current rev's GLB wouldn't load
let loadingRev = null;   // the rev being fetched
let failedRev = null;    // a rev whose GLB wouldn't load: not retried until the rev moves on
let polling = null, pollAgain = false, pollTimer = 0;

function refreshScene() {
  if (polling) { pollAgain = true; return polling; }
  clearTimeout(pollTimer);
  polling = pollScene().finally(() => {
    polling = null;
    showSceneState();
    if (pollAgain) { pollAgain = false; refreshScene(); } else pollTimer = setTimeout(refreshScene, POLL_MS);
  });
  return polling;
}

async function pollScene() {
  try {
    const r = await fetch('/api/scene', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'this server has no /api/scene (restart it with "npm start")' : `server error ${r.status}`);
    sceneInfo = await r.json();
    connError = '';
  } catch (err) {
    connError = err.name === 'TypeError' ? 'Can\'t reach the local server; start it with "npm start"' : err.message;
    return;
  }
  const s = sceneInfo;
  noteCurrent(s.version);
  if (s.rev === model.rev || s.rev === failedRev) return;
  loadingRev = s.rev;
  try {
    if (!s.glb) clearScene();
    else showScene({ ...(await fetchScene(s.glb)), rev: s.rev });
    model.rev = s.rev;
    loadError = '';
  } catch (err) {
    // a 404 means that rev was pruned meanwhile and the next poll gets the newer one; other network or server
    // trouble is retried next poll; a file that won't parse isn't fetched again until the rev moves on
    if (err.status !== 404) {
      loadError = `Couldn't load the model: ${err.message}`;
      if (!err.retry) { failedRev = s.rev; console.error(err); }
    }
  } finally {
    loadingRev = null;
  }
}

// The manager's own message already reads as a sentence ("Starting Blender…", "Blender stopped (exit code 1);
// restarting in 1 s"), so it replaces the friendly wording rather than being appended to it.
const BLENDER_TEXT = {
  starting: 'Blender is starting in the background…',
  restarting: 'Blender is restarting…',
  failed: 'Blender failed to start',
};
function sceneText() {
  if (connError || loadError) return connError || loadError;
  if (!sceneInfo) return 'Connecting…';
  const b = sceneInfo.blender || {};
  if (b.state && b.state !== 'ready') return b.message || BLENDER_TEXT[b.state] || `Blender: ${b.state}`;
  if (loadingRev !== null) return 'Loading the model…';
  if (sceneInfo.building && !work.job) return 'Blender is busy with a build…';
  return '';
}
function showSceneState() {
  const problem = sceneText();
  const { parts: n, tris } = parts.stats();
  // clay view replaces every material, so say so here: otherwise a colour change (quick or from Fable) lands
  // invisibly and looks like it didn't happen
  $('ai-line').textContent = problem
    || (model.group ? `Blender is ready. On screen: ${model.name || 'the model'}, ${n} part${n === 1 ? '' : 's'}, ${tris.toLocaleString()} triangles.`
        + (clayOn ? ' Clay view is on, so colours are hidden.' : '')
    : 'Blender is ready with an empty scene. Say "make a ___".');
  const chip = $('scene-state');
  chip.textContent = problem;
  chip.hidden = !started || !problem;
}

// ---------- Fable builds and versions ----------
initBuild({ flash, say, reload: refreshScene, refreshVersions });
initVersions({ flash, say, reload: refreshScene });

// Fable can't see where you point, so "make that gold" names the part in words. Only when the words point:
// "make the lid gold" said with the mouse resting on the body means the lid.
const POINTING_WORDS = /\b(?:that|this|it|these|those|here)\b/;
function withFocus(prompt) {
  const part = pointedPart();
  return part && POINTING_WORDS.test(prompt) ? `${prompt} (I'm pointing at the part named "${part.name}")` : prompt;
}
function partFor(cmd) { return cmd.target ? parts.findByName(cmd.target) : pointedPart(); }
const LOCAL = '(this view only until sync arrives)';

// ---------- commands ----------
function setClay(on) {
  clayOn = on;
  parts.setLook(on ? clayMaterial : null);
  showTool();
  showSceneState();
  flash(on ? 'Clay view: form only' : 'Materials back');
}

function runCommand(cmd) {
  if (!started) return;
  switch (cmd.type) {
    case 'make':   return build(`make ${cmd.prompt}`, 'make');   // a new model: the server keeps the old one as a version, then empties Blender
    case 'change': return build(withFocus(cmd.prompt), 'change');
    case 'color':  return build(withFocus(cmd.prompt), 'change');   // looks go to Fable; "quick red" is instant
    case 'quick_color': {
      const part = pointedPart();
      if (!part) return flash('Point at a part, then say "quick red"');
      // "quick <colour>" is the one instant edit here, so it has to be visible: clay view paints every part in
      // one matte material, which would swallow it silently
      const wasClay = clayOn;
      if (clayOn) setClay(false);
      quickColor(part, cmd.color);
      return flash(`${part.name}: ${cmd.name}${wasClay ? ', clay view off to show it' : ''} ${LOCAL}`, 3500);
    }
    case 'quick_finish': {
      const part = pointedPart();
      if (!part) return flash('Point at a part, then say "quick metal"');
      const wasClay = clayOn;
      if (clayOn) setClay(false);
      quickFinish(part, cmd.finish);
      return flash(`${part.name}: ${cmd.name}${wasClay ? ', clay view off to show it' : ''} ${LOCAL}`, 3500);
    }
    case 'quick_unknown':
      return flash('Quick does colours (red, gold, blue…) and finishes (metal, shiny, matte, glass).'
        + (cmd.word ? ` Say "make it ${cmd.word}" to send that to Fable.` : ''), 5000);
    case 'add':
      if (cmd.fresh) return build(`make a ${cmd.word}`, 'make');
      return flash(`Ask Fable: say "add a ${cmd.word} to it". Instant shapes come in a later build.`, 5000);
    case 'delete': {
      const part = pointedPart();
      if (!part) return flash('Point at a part, then say "delete that"');
      deletePart(part);
      return flash(`Deleted ${part.name} ${LOCAL}`, 3500);
    }
    case 'duplicate': {
      const part = pointedPart();
      if (!part) return flash('Point at a part, then say "duplicate that"');
      return flash(`Added ${duplicatePart(part).name} ${LOCAL}`, 3500);
    }
    case 'hide': case 'isolate': {
      const part = partFor(cmd);
      if (!part) return flash(cmd.target ? `No part called "${cmd.target}"` : `Point at a part, then say "${cmd.type} that"`);
      if (cmd.type === 'hide') parts.hide(part); else parts.isolate(part);
      return flash(`${cmd.type === 'hide' ? 'Hid' : 'Only showing'} ${part.name}. "Show all" brings everything back.`, 3500);
    }
    case 'show_all': {
      const n = parts.showAll(), focused = !!model.focusId;
      if (focused) focusPart(null);
      return flash(n || focused ? 'Showing everything' : 'Everything is already showing');
    }
    case 'focus': {
      const part = partFor(cmd);
      if (!part) return flash(cmd.target ? `No part called "${cmd.target}"` : 'Point at a part, then say "focus on that"');
      focusPart(part);
      return flash(`Focused on ${part.name}. "Zoom out" shows the whole model.`, 3500);
    }
    case 'unfocus': return flash(model.focusId && focusPart(null) ? 'Whole model' : 'Already showing the whole model');
    case 'clay':   return setClay(cmd.on);
    case 'mode':   return setTool(cmd.mode === 'edit' ? 'part' : cmd.mode);
    case 'brush_pick': return flash('Blender brushes arrive in the next build', 3500);
    case 'redo':   return flash('Redo arrives in the next build', 3500);
    case 'save_version':    return saveVersion(cmd.label);
    case 'restore_version': return restoreVersion(cmd.which);
    case 'versions':        return showVersions();
    case 'mirror': tool.mirror = cmd.on; showTool(); return flash(`Mirror ${cmd.on ? 'on: sculpting copies across the middle' : 'off'}`);
    case 'brush':  setBrush(tool.brush * cmd.factor); showTool(); return flash(`Brush ${tool.brush.toFixed(1)} cm`);
    case 'turn':   return flash(turnBy(cmd.deg) ? `Turned ${cmd.deg === 180 ? 'around' : cmd.deg < 0 ? 'left' : 'right'}` : 'Nothing to turn');
    case 'clear':  return flash('Say "make ___" to start a new model, or "go back a version"', 4000);
    case 'undo':   return flash(undo() ? 'Undone' : 'Nothing to undo here. "Go back a version" undoes a build.', 3500);
    case 'scale':  return flash(scaleBy(cmd.factor) ? (cmd.factor > 1 ? 'Bigger' : 'Smaller') : 'Nothing to resize');
    case 'spin':   setSpin(cmd.on); return flash(cmd.on ? 'Spinning' : 'Stopped spinning');
    case 'export': return doExport();
    case 'cancel': return cancelBuild() || flash(work.job ? 'That can\'t be cancelled, one moment' : 'Nothing to cancel');
    case 'mic':    voice.stop(); S.mic = false; saveSettings(); return;
  }
}

async function doExport() {
  if (!model.group || model.rev === null) return flash('Nothing to export yet');
  const url = sceneInfo?.rev === model.rev && sceneInfo.glb ? sceneInfo.glb : `/api/scene/${model.rev}.glb`;
  try {
    const glb = await downloadScene({ url, name: model.name, rev: model.rev });
    // the .blend is the parametric one (modifiers, node trees); the browser asks before this second file
    const blend = await downloadBlend({ name: model.name, rev: model.rev })
      .catch(err => { console.warn('no .blend to download:', err.message); return null; });
    flash(`Saved ${glb}${blend ? ` and ${blend}` : ' (no .blend yet)'} to your downloads`, 4500);
  } catch (err) { console.error(err); flash(`Export failed: ${err.message}`, 6000); }
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
  else if (k === 't') { S.talk = !S.talk; saveSettings(); if (!S.talk) speaker.stop(); flash(`Spoken replies ${S.talk ? 'on' : 'off'}`); }
  else if (k === 'l') { if (started) toggleLog(); }
  else if (k === 'k') { if (started) runCommand({ type: 'clay', on: !clayOn }); }
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
  if (!started) { renderViews(); return; }

  updateInteraction();
  updateModel(dt);
  applyOffAxis(input.eye);
  renderViews();
  drawDebug($('htw-cam'));

  frames++;
  if (now - fpsT0 > 500) { fps = frames * 1000 / (now - fpsT0); frames = 0; fpsT0 = now; }
  if (!$('htw-hud').hidden) {
    const eye = input.eye, cameraMode = input.mode === 'camera';
    const faceOk = now - input.faceSeenAt < 300;
    const handLine = (h, i) => `hand ${i + 1} ` + (!cameraMode ? '-' : !S.hands ? 'off' : now - h.seenAt >= 300 ? 'not seen'
      : `${h.pinch ? 'PINCH ' : 'open  '} ratio ${h.pinchRatio.toFixed(2)}  tip ${h.tip.x.toFixed(1)} ${h.tip.y.toFixed(1)} ${h.tip.z.toFixed(1)} cm`);
    const st = parts.stats(), b = sceneInfo?.blender;
    $('htw-hud').textContent =
      `mode   ${input.mode}   ${fps.toFixed(0)} fps   tool ${tool.mode}\n` +
      `eye    x ${eye.x.toFixed(1)}  y ${eye.y.toFixed(1)}  z ${eye.z.toFixed(1)} cm\n` +
      `face   ${cameraMode ? (faceOk ? 'tracking' : 'LOST') : '-'}   ipd ${(cam.ipdHistory.at(-1) || 0).toFixed(1)} px\n` +
      `${input.hands.map(handLine).join('\n')}\n` +
      `screen ${rect.W.toFixed(1)} x ${rect.H.toFixed(1)} cm   fov ${S.hfovDeg.toFixed(1)}°   ${document.fullscreenElement ? 'fullscreen' : 'WINDOWED'}\n` +
      `voice  ${voice.state}\n` +
      `blender ${b ? b.state : '-'}   rev ${model.rev ?? '-'}   version ${sceneInfo?.version ?? '-'}\n` +
      `model  ${model.group ? `${model.name}, ${st.parts} parts, ${st.tris} tris, x${model.userScale.toFixed(2)}${model.focusId ? ', focused' : ''}` : '-'}`;
  }

  const busy = $('ai-busy');
  busy.hidden = !work.job;
  if (work.job) $('ai-busy-text').textContent = `${work.job.label} · ${((now - work.job.t0) / 1000).toFixed(0)}s` +
    (work.job.kind === 'build' ? ' · say "cancel" to stop' : '');

  const banner = $('htw-banner');
  let msg = '';
  if (now < flashUntil) msg = flashMsg;
  else if (!document.fullscreenElement) msg = 'Press F for fullscreen, the 3D is only exact when the page fills the screen';
  else if (input.mode === 'camera' && now - input.faceSeenAt > 1000) msg = 'Face not found, sit in front of the webcam';
  banner.textContent = msg; banner.hidden = !msg;
}

// handy in the devtools console: htw.run('make a lamp'), htw.parts.list(); tests drive htw.tick() with fake hands
window.htw = {
  THREE, scene, camera, renderer, model, parts, input, S, tool, rect: () => rect,
  run: text => { const cmd = parseTyped(text); if (cmd) runCommand(cmd); return cmd; },
  reload: () => refreshScene(),
  pointed: () => pointedPart()?.name ?? null,
  highlighted: () => [...highlighted().keys()].map(m => parts.ofMesh(m)?.name ?? m.name),
  tick: now => tick(now ?? performance.now()),
};

syncPanel();
renderer.setSize(innerWidth, innerHeight, false);
refreshScene();
requestAnimationFrame(frame);
