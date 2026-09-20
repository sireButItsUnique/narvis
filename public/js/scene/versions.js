// Version history strip in the workbench: a snapshot after every build, "save version", "go back to version 3".
// Restoring opens that version's .blend in the hidden Blender, which exports it as a new rev; the page then
// loads it like any other scene change.
import { work, startJob, endJob, log, setStatus } from './build.js';
import { quip } from '../narvis.js';

const $ = id => document.getElementById(id);

let versions = [];
let current = null;    // what /api/history says the scene is at
let noted;             // the last version /api/scene reported (undefined until the first poll)
let hooks = { flash: () => {}, say: () => {}, reload: () => {} };
export function initVersions(h) { hooks = { ...hooks, ...h }; }

export async function refreshVersions() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) throw new Error(`history ${r.status}`);
    const h = await r.json();
    versions = h.versions || [];
    current = h.current ?? null;
    const strip = $('versions');
    strip.hidden = !versions.length;
    $('versions-where').textContent = h.kind === 'atlas' ? 'in MongoDB Atlas' : 'on this computer';
    const list = $('versions-list');
    list.replaceChildren(...versions.slice().reverse().map(v => {
      const b = document.createElement('button');
      b.className = `version ${v.kind || 'build'}`;
      b.dataset.n = v.n;
      if (v.n === current) b.dataset.current = '1';
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
  } catch { /* the server is older or unreachable; the scene state says so */ }
}

// The scene poll says which version is on screen: refetch the strip when that value changes, not when it merely
// disagrees with the strip. An empty scene reports null while /api/history still answers with the newest version
// (that's the one a build would grow from), and refetching on every 2 s poll over that is a thumbnail treadmill.
export function noteCurrent(n) {
  if (n === undefined || n === noted) return;
  noted = n;
  if (n !== current) refreshVersions();
}

export async function restoreVersion(which) {
  if (work.job) return hooks.flash('Wait for the current job to finish (or say "cancel").');
  const label = which === 'previous' ? 'Going back a version…' : which === 'latest' ? 'Going to the latest version…'
    : `Going back to version ${which}…`;
  startJob('restore', label);
  setStatus(label);
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(which)}/restore`, { method: 'POST' });
    const r = await res.json().catch(() => ({}));
    // a 409 answers {error:'busy', message:'…'} with no ok: the sentence is the half worth showing
    if (!r.ok) throw new Error(r.message || r.error || `couldn't go back (${res.status})`);
    const text = `Back to version ${r.version.n}${r.version.prompt ? ` (${r.version.prompt})` : ''}`;
    log(text + (r.checkpoint ? `. What you had is kept as version ${r.checkpoint.n}.` : ''), 'done');
    hooks.flash(text, 3500);
    hooks.say(quip('restore_version'));
  } catch (err) {
    log(err.message, 'error');
    hooks.flash(err.message, 5000);
  } finally {
    setStatus('');
    endJob();
    hooks.reload();
    refreshVersions();
  }
}

export async function saveVersion(label) {
  if (work.job) return hooks.flash('Wait for the current job to finish.');
  startJob('save', 'Saving a version…');
  setStatus('Saving a version…');
  try {
    const res = await fetch('/api/history/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    });
    const r = await res.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.message || r.error || `couldn't save (${res.status})`);
    log(`Saved as version ${r.version.n}${label ? `: ${label}` : ''}`, 'saved');
    hooks.flash(`Saved version ${r.version.n}`);
    hooks.say(quip('save_version'));
  } catch (err) {
    log(err.message, 'error');
    hooks.flash(err.message, 5000);
  } finally {
    setStatus('');
    endJob();
    refreshVersions();
  }
}

export function showVersions() {
  if (!versions.length) return hooks.flash('No versions yet. Each build saves one, or say "save version".');
  log(`Versions: ${versions.slice(0, 8).map(v => `v${v.n} ${v.prompt || ''}`.trim()).join(' · ')}${versions.length > 8 ? ' …' : ''}. Say "go back to version N".`, 'info');
  $('versions').hidden = false;
}
