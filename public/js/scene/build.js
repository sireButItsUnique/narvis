// "make ___" / "make it ___": Claude Fable builds in the hidden Blender and progress streams back as
// server-sent events. When a build ends, the server has exported the new scene, so the page reloads it.
// Also the activity log on the right, which versions.js writes to as well.
import { quip } from '../narvis.js';

const $ = id => document.getElementById(id);

// one job at a time across builds and version saves/restores: { kind, label, t0, controller? }
export const work = { job: null };
let hooks = { flash: () => {}, say: () => {}, reload: () => {}, refreshVersions: () => {} };
export function initBuild(h) { hooks = { ...hooks, ...h }; }

// ---------- the activity log ----------
const LOG_LINGER_MS = 15000;   // it stays up this long after a job, then gets out of the way (L brings it back)
let hideTimer = 0;
function showLog() {
  $('build-panel').hidden = false;
  clearTimeout(hideTimer);
  if (!work.job) hideTimer = setTimeout(() => { $('build-panel').hidden = true; }, LOG_LINGER_MS);
}
export function toggleLog() {
  const panel = $('build-panel');
  if (!panel.hidden) { panel.hidden = true; clearTimeout(hideTimer); return false; }
  panel.hidden = false;
  clearTimeout(hideTimer);
  return true;
}

export function log(text, kind = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  const list = $('bp-log');
  list.appendChild(li);
  while (list.children.length > 60) list.firstChild.remove();
  li.scrollIntoView({ block: 'end' });
  showLog();
}
export const setStatus = text => { $('bp-status').textContent = text; };

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

export function startJob(kind, label, controller = null) {
  if (work.job) return false;
  work.job = { kind, label, t0: performance.now(), controller };
  document.body.classList.add('building');
  showLog();
  return true;
}
export function endJob() {
  work.job = null;
  document.body.classList.remove('building');
  showLog();
}

// ---------- the build ----------
export async function build(prompt, mode) {
  if (work.job) return hooks.flash(work.job.kind === 'build' ? 'Still building the last one. Say "cancel" to stop it.'
                                                            : 'One moment, still busy with the last job.');
  const controller = new AbortController();
  startJob('build', `${mode === 'make' ? 'Making' : 'Changing'}: ${prompt}`, controller);
  $('bp-cost').textContent = '';
  log(`“${prompt}”`, 'request');
  setStatus('Starting…');
  let built = false;
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
        if (chunk.startsWith('data: ')) built = onEvent(JSON.parse(chunk.slice(6))) || built;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') log('Cancelled. Anything Fable already built shows up; "go back a version" undoes it.', 'warn');
    else { log(err.message, 'error'); hooks.flash(err.message, 6000); }
  } finally {
    setStatus('');
    endJob();
    // even a cancelled or failed build may have changed the scene; the rev says whether it did
    hooks.reload();
    if (built) hooks.refreshVersions();
  }
}

export function cancelBuild() {
  if (work.job?.kind !== 'build') return false;
  work.job.controller.abort();
  return true;
}

// returns true when the scene changed
function onEvent(ev) {
  switch (ev.type) {
    case 'status': setStatus(ev.text); return false;
    case 'thinking': log(ev.text, 'thinking'); return false;
    case 'step':
      if (ev.state === 'running') { setStatus(`Running in Blender: ${ev.label}`); return false; }
      log(ev.state === 'done'
        ? `Built ${ev.label}${ev.created?.length ? ` (${ev.created.slice(0, 6).join(', ')}${ev.created.length > 6 ? '…' : ''})` : ''}`
        : `${ev.label} hit an error, fixing it: ${ev.error}`, ev.state === 'done' ? 'step' : 'warn');
      return ev.state === 'done';
    case 'research':
      log(ev.action === 'search' ? `Looking up: ${ev.query}` : `Reading: ${ev.query}`, 'research');
      return false;
    case 'sources': logSources(ev.items); return false;
    case 'look':
      setStatus('Looking at it…');
      log(`Looking at it from the ${ev.views.join(', ').replace(/_/g, ' ') || 'front'}`, 'look');
      return false;
    case 'cost': $('bp-cost').textContent = `about $${ev.usd.toFixed(2)}`; return false;
    case 'scene':   // the server finished exporting: this rev is real, so load it now instead of at the next poll
      hooks.reload();
      return true;
    case 'preview': case 'model':   // M4 streams these; the scene poll picks up the rev either way
      hooks.reload();
      return true;
    case 'done':
      setStatus('');
      log(ev.summary, 'done');
      // The summary is on screen and it is accurate; the voice is a personality, not a narrator.
      hooks.say(quip('done'));
      hooks.flash('Done', 2500);
      hooks.reload();
      return true;
    case 'saved':
      setStatus('');
      // `kept` is the scene a "make" is about to clear away, saved before it goes
      log(`${ev.kept ? 'Kept what was on screen as' : 'Saved as'} version ${ev.version.n}. `
        + `Say "go back to version ${ev.version.n}" to return to it.`, 'saved');
      hooks.refreshVersions();
      return true;
    case 'warn': log(ev.message, 'warn'); return false;
    case 'error':
      setStatus('');
      log(ev.message, 'error');
      hooks.say(quip('failed'));   // the one moment it is sincere: see narvis.js
      hooks.flash(ev.message, 6000);
      return false;
  }
  return false;
}
