// Which cameras are plugged in, what each one is, and what job it should do.
// Pure functions only (no DOM except the two thin wrappers at the bottom) so the matching rules can be
// tested with node --test, and so a fake device list can stand in for hardware nobody has plugged in yet.

// A ZED delivers both eyes in ONE side-by-side frame (32:9), one exposure, hardware synced.
// Modes are per-eye size x 2 (https://docs.stereolabs.com/docs/video/camera-controls.md).
export const ZED_MODES = [
  { name: '2K', width: 4416, height: 1242, eyeW: 2208, eyeH: 1242, fps: [15] },
  { name: 'FHD', width: 3840, height: 1080, eyeW: 1920, eyeH: 1080, fps: [30, 15] },
  { name: 'HD', width: 2560, height: 720, eyeW: 1280, eyeH: 720, fps: [60, 30, 15] },
  { name: 'VGA', width: 1344, height: 376, eyeW: 672, eyeH: 376, fps: [100, 60, 30, 15] },
];

// Known ZED USB ids, because Windows sometimes labels a camera "USB Camera (2b03:f582)" with no model name.
export const ZED_USB_VENDOR = '2b03';
const ZED_LABEL = /\bzed\b|\bzed[-\s]?(?:mini|m|2i?|x)\b|stereolabs/i;

// A side-by-side stereo frame is two 16:9 (or 16:9-ish) images glued along x, so ~32:9.
export function isSbsSize(width, height) {
  if (!width || !height) return false;
  const exact = ZED_MODES.some(m => m.width === width && m.height === height);
  return exact || (width / height > 3.3 && width / height < 3.8 && width % 2 === 0);
}

export function zedModeFor(width, height) {
  return ZED_MODES.find(m => m.width === width && m.height === height) || null;
}

// label/resolution -> what this camera is. `seen` is an optional { width, height } we actually opened it at,
// and `pref` is the user's own answer, which always wins (Windows will happily call a ZED "USB Camera").
// Returns why, so cameras.html can explain itself instead of looking like magic.
export function classifyCamera(dev, seen = null, pref = null) {
  const label = String(dev?.label || '');
  const id = String(dev?.deviceId || '');
  if (pref?.kind === 'webcam') return { kind: 'webcam', sbs: false, mode: null, model: label || 'camera', why: 'you said so' };
  const byYou = pref?.kind === 'zed';
  const byLabel = ZED_LABEL.test(label) || label.toLowerCase().includes(ZED_USB_VENDOR + ':');
  const bySize = !!seen && isSbsSize(seen.width, seen.height);
  const mode = seen ? zedModeFor(seen.width, seen.height) : null;
  if (byYou || byLabel || bySize) {
    return {
      kind: 'zed', sbs: true, mode: mode?.name || null,
      model: /mini|zed[-\s]?m\b/i.test(label) ? 'ZED Mini' : /2i/i.test(label) ? 'ZED 2i'
        : /zed[-\s]?2/i.test(label) ? 'ZED 2' : /zed[-\s]?x/i.test(label) ? 'ZED X' : 'ZED',
      why: byYou ? 'you said so' : byLabel && bySize ? 'name and side-by-side frame' : byLabel ? 'name' : 'side-by-side frame',
    };
  }
  return { kind: 'webcam', sbs: false, mode: null, model: label.split('(')[0].trim() || (id ? 'camera' : 'unknown'), why: 'not a ZED' };
}

// Logitech-style webcams quote a DIAGONAL fov; we need a horizontal focal length in pixels.
// f = (diag_px / 2) / tan(dfov / 2), which is exact for a pinhole and good enough to start a calibration from.
export function focalPxFromDiagFov(width, height, dfovDeg = 78) {
  const diag = Math.hypot(width, height);
  return (diag / 2) / Math.tan((dfovDeg * Math.PI / 180) / 2);
}

// Device ids are per-origin and change when permissions are reset or the camera moves port, so remember a
// camera by everything we know and match in order of how much that evidence is worth.
export function deviceKey(dev) {
  return { deviceId: dev.deviceId || '', groupId: dev.groupId || '', label: dev.label || '' };
}

export function matchSaved(saved, devices) {
  if (!saved) return null;
  return devices.find(d => d.deviceId && d.deviceId === saved.deviceId)
    || devices.find(d => saved.label && d.label === saved.label)
    || devices.find(d => saved.groupId && d.groupId === saved.groupId)
    || null;
}

// prefs: { [key]: { role, dfovDeg, ... } } keyed by label (stable across replug) — merged onto the live list.
export function mergePrefs(prefs = {}, devices = []) {
  const entries = Object.entries(prefs);
  return devices.map(d => {
    const hit = entries.find(([, p]) => matchSaved(p.key || {}, [d]));
    return { ...d, prefKey: hit ? hit[0] : (d.label || d.deviceId), pref: hit ? hit[1] : null };
  });
}

// Who watches what. The rig wants the ZED on the hand volume under the sheet and the webcams on the head;
// with one camera we do exactly what the app does today, so nothing regresses when no new hardware is present.
export function planRoles(cams, opts = {}) {
  const list = cams.map(c => ({ ...c, cls: c.cls || classifyCamera(c, c.seen, c.pref) }));
  const forced = list.map(c => c.pref?.role && c.pref.role !== 'auto' ? c.pref.role : null);
  const zed = list.filter((c, i) => c.cls.kind === 'zed' && forced[i] !== 'off');
  const webcams = list.filter((c, i) => c.cls.kind !== 'zed' && forced[i] !== 'off');
  const sources = [];
  list.forEach((c, i) => {
    if (forced[i] === 'off') return;
    let role = forced[i];
    if (!role) {
      if (c.cls.kind === 'zed') role = (webcams.length === 0) ? 'both' : 'hands';
      else if (zed.length) role = 'head';                      // ZED has the hands: webcams watch the head
      else role = (webcams.indexOf(c) === 0) ? 'both' : 'hands';   // no ZED: first camera does everything, a second adds a hand view
    }
    sources.push({ ...c, role });
  });
  const heads = sources.filter(s => s.role === 'head' || s.role === 'both');
  const hands = sources.filter(s => s.role === 'hands' || s.role === 'both');
  // Exactly one plain webcam doing everything IS today's app: hand it to webcam.js rather than re-implementing it.
  const legacy = !opts.bridge && sources.length === 1 && sources[0].cls.kind !== 'zed' && sources[0].role === 'both';
  return {
    sources, legacy,
    // hands need two views of the same instant to triangulate; a ZED gives both in one frame
    handViews: hands.reduce((n, s) => n + (s.cls.sbs ? 2 : 1), 0),
    headViews: heads.length,
    mode: sources.length === 0 ? (opts.bridge ? 'bridge' : 'mouse') : legacy ? 'legacy' : 'multi',
  };
}

// ---------- thin browser wrappers (everything above is testable without a browser) ----------

export async function listCameras() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter(d => d.kind === 'videoinput')
    .map(d => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
}

const PREFS_KEY = 'holo-cameras';
export function loadPrefs(store = globalThis.localStorage) {
  try { return JSON.parse(store?.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
export function savePrefs(prefs, store = globalThis.localStorage) {
  try { store?.setItem(PREFS_KEY, JSON.stringify(prefs)); return true; } catch { return false; }
}
