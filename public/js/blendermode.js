// Blender mode: this page is only the voice console. Blender does the modelling (Claude Fable builds in it),
// and the hand mouse (handmouse/handmouse.py) drives Blender's cursor.
const $ = id => document.getElementById(id);

import { speakable } from './speak.js';

let building = null;   // { controller }
let restoring = false;
let statusTimer = 0;
let flash = () => {};
let say = () => {};

// ---------- Blender connection ----------
async function refreshStatus() {
  try {
    const s = await (await fetch('/api/blender/status')).json();
    const conn = $('bp-conn');
    conn.dataset.on = s.connected ? '1' : '0';
    $('bp-title').textContent = s.connected
      ? `Blender ${s.blender} · ${s.objects} objects · builds with ${s.model}`
      : `Blender not connected. Open Blender (the Holo Modeler add-on starts with it).`;
    if (!s.key) $('bp-title').textContent += ' · no ANTHROPIC_API_KEY in .env, so "make ___" is off';
  } catch {
    $('bp-conn').dataset.on = '0';
    $('bp-title').textContent = 'Can\'t reach the local server. Start it with "npm start".';
  }
}

export function startBlenderMode(opts) {
  flash = opts.flash;
  say = opts.say || say;
  document.body.classList.add('blender-mode');
  $('blender-panel').hidden = false;
  refreshStatus();
  refreshVersions();
  statusTimer = setInterval(refreshStatus, 3000);
}

// ---------- version history: a snapshot after every build; "go back to version 3" ----------
let versions = [];
async function refreshVersions() {
  try {
    const h = await (await fetch('/api/history')).json();
    versions = h.versions || [];
    const strip = $('bp-versions');
    strip.hidden = !versions.length;
    $('bp-versions-where').textContent = h.kind === 'atlas' ? 'saved in MongoDB Atlas' : 'saved on this computer';
    const list = $('bp-versions-list');
    list.replaceChildren(...versions.slice().reverse().map(v => {
      const b = document.createElement('button');
      b.className = `version ${v.kind || 'build'}`;
      if (v.n === h.current) b.dataset.current = '1';
      b.title = [`Version ${v.n}${v.kind === 'checkpoint' ? ' (checkpoint)' : ''}: ${v.prompt || ''}`, v.summary || '',
                 v.usd ? `about $${v.usd.toFixed(2)}` : ''].filter(Boolean).join('\n');
      const img = document.createElement('img');
      img.src = `/api/history/${encodeURIComponent(v.id)}/thumb`;
      img.alt = '';
      img.onerror = () => img.remove();
      const label = document.createElement('span');
      label.textContent = `v${v.n}`;
      b.append(img, label);
      b.addEventListener('click', () => restoreVersion(String(v.n)));
      return b;
    }));
    list.scrollLeft = list.scrollWidth;
  } catch { /* the server is older or unreachable; the status line says so */ }
}

async function restoreVersion(which) {
  if (building || restoring) return flash('Wait for the current job to finish (or say "cancel").');
  restoring = true;
  setStatus(which === 'previous' ? 'Going back a version…' : which === 'latest' ? 'Going to the latest version…' : `Going back to version ${which}…`);
  document.body.classList.add('building');
  try {
    const r = await (await fetch(`/api/history/${encodeURIComponent(which)}/restore`, { method: 'POST' })).json();
    if (!r.ok) throw new Error(r.error || r.message || "couldn't go back");
    const text = `Back to version ${r.version.n}${r.version.prompt ? ` (${r.version.prompt})` : ''}`;
    log(text + (r.checkpoint ? `. What you had is kept as version ${r.checkpoint.n}.` : ''), 'done');
    flash(text, 3500);
    say(`Back to version ${r.version.n}.`);
  } catch (err) {
    log(err.message, 'error');
    flash(err.message, 5000);
  } finally {
    restoring = false;
    setStatus('');
    document.body.classList.remove('building');
    refreshVersions();
  }
}

async function saveVersion(label) {
  if (building || restoring) return flash('Wait for the current job to finish.');
  setStatus('Saving a version…');
  try {
    const r = await (await fetch('/api/history/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    })).json();
    if (!r.ok) throw new Error(r.error || r.message || "couldn't save");
    log(`Saved as version ${r.version.n}${label ? `: ${label}` : ''}`, 'saved');
    flash(`Saved version ${r.version.n}`);
    say(`Saved version ${r.version.n}.`);
  } catch (err) {
    log(err.message, 'error');
    flash(err.message, 5000);
  } finally {
    setStatus('');
    refreshVersions();
  }
}

function showVersions() {
  if (!versions.length) return flash('No versions yet. Each build saves one, or say "save version".');
  log(`Versions: ${versions.slice(0, 8).map(v => `v${v.n} ${v.prompt || ''}`.trim()).join(' · ')}${versions.length > 8 ? ' …' : ''}. Say "go back to version N".`, 'info');
  $('bp-versions').scrollIntoView({ block: 'nearest' });
}

// ---------- the activity log ----------
function log(text, kind = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  const list = $('bp-log');
  list.appendChild(li);
  while (list.children.length > 60) list.firstChild.remove();
  li.scrollIntoView({ block: 'end' });
}
const setStatus = text => { $('bp-status').textContent = text; };

// where Fable's research came from, as links
function logSources(items) {
  if (!items?.length) return;
  const li = document.createElement('li');
  li.className = 'sources';
  li.append('Sources: ');
  items.forEach((it, i) => {
    if (i) li.append(' · ');
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = (it.title || it.url).slice(0, 60);
    li.appendChild(a);
  });
  $('bp-log').appendChild(li);
  li.scrollIntoView({ block: 'end' });
}

// ---------- "make ___" / "make it ___": Fable builds in Blender, progress streams back ----------
async function build(prompt, mode) {
  if (building) return flash('Still building the last one. Say "cancel" to stop it.');
  if (restoring) return flash('Still going back to that version; one moment.');
  const controller = new AbortController();
  building = { controller };
  $('bp-cost').textContent = '';
  log(`“${prompt}”`, 'request');
  setStatus('Starting…');
  document.body.classList.add('building');
  try {
    const res = await fetch('/api/blender/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode }), signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `server error ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)));
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') { log('Cancelled. What was already built stays; say "undo" to remove it step by step.', 'warn'); setStatus(''); }
    else { log(err.message, 'error'); setStatus(''); flash(err.message, 6000); }
  } finally {
    building = null;
    document.body.classList.remove('building');
  }
}

function onEvent(ev) {
  switch (ev.type) {
    case 'status': return setStatus(ev.text);
    case 'thinking': return log(ev.text, 'thinking');
    case 'step':
      if (ev.state === 'running') { setStatus(`Running in Blender: ${ev.label}`); return; }
      return log(ev.state === 'done'
        ? `Built ${ev.label}${ev.created?.length ? ` (${ev.created.slice(0, 6).join(', ')}${ev.created.length > 6 ? '…' : ''})` : ''}`
        : `${ev.label} hit an error, fixing it: ${ev.error}`, ev.state === 'done' ? 'step' : 'warn');
    case 'research':
      return log(ev.action === 'search' ? `Looking up: ${ev.query}` : `Reading: ${ev.query}`, 'research');
    case 'sources': return logSources(ev.items);
    case 'look':
      setStatus('Looking at it…');
      return log(`Looking at it from the ${ev.views.join(', ').replace(/_/g, ' ') || 'front'}`, 'look');
    case 'cost': $('bp-cost').textContent = `about $${ev.usd.toFixed(2)}`; return;
    case 'done':
      setStatus('');
      log(ev.summary, 'done');
      say(speakable(ev.summary) || 'Done.');
      return flash('Done', 2500);
    case 'saved':
      setStatus('');
      log(`Saved as version ${ev.version.n}. Say "go back to version ${ev.version.n}" to return to it.`, 'saved');
      return refreshVersions();
    case 'warn':
      return log(ev.message, 'warn');
    case 'error':
      setStatus('');
      log(ev.message, 'error');
      say("That didn't work. The reason is on screen.");
      return flash(ev.message, 6000);
  }
}

// ---------- quick commands: straight to Blender, no AI ----------
async function quick(cmd, args, success) {
  try {
    const r = await (await fetch('/api/blender/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, ...args }),
    })).json();
    if (!r.ok) throw new Error(r.message || r.error || 'Blender said no');
    const text = typeof success === 'function' ? success(r) : success;
    log(text, 'step');
    flash(text);
  } catch (err) {
    log(err.message, 'error');
    flash(err.message, 5000);
  }
}

const MODE_NAMES = { move: 'object', part: 'edit', edit: 'edit', sculpt: 'sculpt' };

export function runBlenderCommand(cmd) {
  switch (cmd.type) {
    case 'make':   return build(`make ${cmd.prompt}`, 'make');   // Fable gets the whole phrase and decides new vs edit
    case 'change':
    case 'color':  return build(cmd.prompt, 'change');
    case 'cancel': return building ? building.controller.abort() : flash('Nothing to cancel');
    case 'undo':   return quick('undo', {}, 'Undone');
    case 'redo':   return quick('redo', {}, 'Redone');
    case 'mode':
      if (cmd.mode === 'smooth') return quick('brush', { name: 'Smooth' }, 'Smooth brush');
      return quick('mode', { mode: MODE_NAMES[cmd.mode] || 'object' }, r => `${r.mode[0].toUpperCase()}${r.mode.slice(1)} mode on ${r.object}`);
    case 'brush_pick': return quick('brush', { name: cmd.name }, r => `${r.brush} brush`);
    case 'brush':  return quick('brush_size', { factor: cmd.factor }, r => `Brush size ${r.size}`);
    case 'mirror': return quick('symmetry', { on: cmd.on }, r => `Symmetry ${r.on ? 'on' : 'off'}`);
    case 'focus':  return quick('focus', {}, 'Framed');
    case 'delete': return quick('delete', {}, r => (r.deleted.length ? `Deleted ${r.deleted.join(', ')}` : 'Nothing selected to delete'));
    case 'clear':  return flash('To clear, select everything in Blender (A) and say "delete"');
    case 'add':    return quick('add', { shape: cmd.shape }, r => `Added ${r.object}`);
    case 'export': return flash('Export from Blender: File > Export. (To keep this state, say "save version".)');
    case 'save_version':    return saveVersion(cmd.label);
    case 'restore_version': return restoreVersion(cmd.which);
    case 'versions':        return showVersions();
    case 'scale':  return build(`make it ${cmd.factor > 1 ? 'bigger' : 'smaller'} (scale it by ${cmd.factor.toFixed(2)})`, 'change');
    case 'duplicate': return build('duplicate the selected object and place the copy next to it', 'change');
    case 'mic':    return;   // handled by the caller
    default:       return flash('That one is for the browser model. In Blender, orbit with your other hand.');
  }
}
