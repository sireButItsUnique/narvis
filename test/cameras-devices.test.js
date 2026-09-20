import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCamera, isSbsSize, zedModeFor, planRoles, mergePrefs, matchSaved, focalPxFromDiagFov, loadPrefs, savePrefs }
  from '../public/js/input/devices.js';

const dev = (label, deviceId = label, groupId = 'g') => ({ label, deviceId, groupId });

test('a ZED is recognised from its label, however Windows spells it', () => {
  for (const label of ['ZED', 'ZED 2i', 'ZED-M', 'ZED Mini', 'ZED 2 (2b03:f780)', 'Stereolabs ZED X']) {
    assert.equal(classifyCamera(dev(label)).kind, 'zed', label);
  }
  assert.equal(classifyCamera(dev('ZED 2i')).model, 'ZED 2i');
  assert.equal(classifyCamera(dev('ZED Mini')).model, 'ZED Mini');
});

test('an unnamed camera is recognised from a side-by-side frame instead', () => {
  const c = classifyCamera(dev('USB Camera'), { width: 2560, height: 720 });
  assert.equal(c.kind, 'zed');
  assert.equal(c.mode, 'HD');
  assert.equal(c.why, 'side-by-side frame');
});

test('ordinary webcams are not mistaken for a ZED', () => {
  for (const [label, seen] of [['HD Pro Webcam C920', { width: 1920, height: 1080 }],
                               ['Integrated Camera', { width: 640, height: 480 }],
                               ['Brio 4K', { width: 3840, height: 2160 }]]) {
    assert.equal(classifyCamera(dev(label), seen).kind, 'webcam', label);
  }
});

test('side-by-side sizes: every published ZED mode, and nothing 16:9', () => {
  assert.ok(isSbsSize(4416, 1242) && isSbsSize(3840, 1080) && isSbsSize(2560, 720) && isSbsSize(1344, 376));
  assert.ok(!isSbsSize(1920, 1080) && !isSbsSize(1280, 720) && !isSbsSize(640, 480) && !isSbsSize(0, 0));
  assert.equal(zedModeFor(2560, 720).name, 'HD');
  assert.equal(zedModeFor(1920, 1080), null);   // that is one eye's size, not a stereo frame
});

test('focal length from a quoted diagonal field of view', () => {
  // a C920 is 78 deg diagonal at 1920x1080 -> about 1360 px
  assert.ok(Math.abs(focalPxFromDiagFov(1920, 1080, 78) - 1360) < 15);
  assert.ok(focalPxFromDiagFov(1920, 1080, 90) < focalPxFromDiagFov(1920, 1080, 78));
});

test('one webcam keeps today\'s behaviour, and says so', () => {
  const plan = planRoles([dev('Integrated Camera')]);
  assert.equal(plan.legacy, true);
  assert.equal(plan.mode, 'legacy');
  assert.equal(plan.sources[0].role, 'both');
});

test('no cameras is mouse mode, unless a bridge is supplying hands', () => {
  assert.equal(planRoles([]).mode, 'mouse');
  assert.equal(planRoles([], { bridge: true }).mode, 'bridge');
});

test('a ZED takes the hands and the webcams watch the head', () => {
  const plan = planRoles([dev('ZED 2i'), dev('C920'), dev('C922')]);
  const byLabel = Object.fromEntries(plan.sources.map(s => [s.label, s.role]));
  assert.deepEqual(byLabel, { 'ZED 2i': 'hands', C920: 'head', C922: 'head' });
  assert.equal(plan.handViews, 2);     // both eyes of the one side-by-side frame
  assert.equal(plan.headViews, 2);
  assert.equal(plan.legacy, false);
});

test('a lone ZED does both jobs', () => {
  const plan = planRoles([dev('ZED 2i')]);
  assert.equal(plan.sources[0].role, 'both');
  assert.equal(plan.legacy, false);    // a ZED is never the legacy single-webcam path
});

test('two webcams: the first does everything, the second adds a second view of the hands', () => {
  const plan = planRoles([dev('C920'), dev('C922')]);
  assert.deepEqual(plan.sources.map(s => s.role), ['both', 'hands']);
  assert.equal(plan.handViews, 2);
});

test('a saved preference overrides the automatic job, and "off" removes the camera', () => {
  const cams = [{ ...dev('C920'), pref: { role: 'hands' } }, { ...dev('C922'), pref: { role: 'off' } }];
  const plan = planRoles(cams);
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].role, 'hands');
});

test('the user can say what a camera is, and that beats the label', () => {
  // Windows often calls a ZED "USB Camera", and a 32:9 webcam would otherwise be mistaken for one
  const forced = classifyCamera(dev('USB Camera'), null, { kind: 'zed' });
  assert.equal(forced.kind, 'zed');
  assert.equal(forced.why, 'you said so');
  assert.equal(classifyCamera(dev('ZED 2i'), { width: 2560, height: 720 }, { kind: 'webcam' }).kind, 'webcam');
  const plan = planRoles([{ ...dev('USB Camera'), pref: { kind: 'zed' } }, dev('C920')]);
  assert.equal(plan.sources[0].role, 'hands');
  assert.equal(plan.sources[1].role, 'head');
});

test('a remembered camera is found again after its deviceId changes', () => {
  const saved = { deviceId: 'old-id', groupId: 'g1', label: 'HD Pro Webcam C920' };
  const present = [dev('Integrated Camera', 'a', 'g0'), dev('HD Pro Webcam C920', 'new-id', 'g1')];
  assert.equal(matchSaved(saved, present).deviceId, 'new-id');
  assert.equal(matchSaved({ deviceId: 'x', groupId: 'g0', label: '' }, present).deviceId, 'a');
  assert.equal(matchSaved(null, present), null);
  assert.equal(matchSaved({ deviceId: 'x', groupId: 'z', label: 'gone' }, present), null);
});

test('preferences attach to the right camera', () => {
  const prefs = { 'HD Pro Webcam C920': { key: { label: 'HD Pro Webcam C920' }, role: 'hands', dfovDeg: 90 } };
  const merged = mergePrefs(prefs, [dev('HD Pro Webcam C920', 'fresh'), dev('Integrated Camera', 'b')]);
  assert.equal(merged[0].pref.role, 'hands');
  assert.equal(merged[1].pref, null);
});

test('two cameras can never be handed the same preference entry', () => {
  // The rig's head tracker is two webcams of the SAME model, and Chromium gives them the identical label
  // (friendly name + vid:pid, no uniquifier). If both resolve to one entry they get one camera's pose, the
  // two stereo rays start from the same point, and the triangulated head sits on that lens for ever while
  // everything reports healthy stereo tracking. So matching has to be injective, not just plausible.
  const label = 'HD Pro Webcam C920 (046d:082d)';
  const twins = [dev(label, 'id-A', 'g-A'), dev(label, 'id-B', 'g-B')];

  // an exact deviceId match must beat an EARLIER entry's label match, whatever the iteration order
  const both = { 'cam-A': { key: { deviceId: 'id-A', label }, role: 'head' },
                 'cam-B': { key: { deviceId: 'id-B', label }, role: 'head' } };
  const m = mergePrefs(both, twins);
  assert.equal(m[0].prefKey, 'cam-A');
  assert.equal(m[1].prefKey, 'cam-B', 'the label fallback must not swallow the second camera');

  // and with only ONE entry to go round, exactly one device gets it and the other gets its own identity
  const one = mergePrefs({ 'cam-A': { key: { deviceId: 'id-B', label }, role: 'head' } }, twins);
  assert.notEqual(one[0].prefKey, one[1].prefKey);
  assert.equal(one.filter(d => d.pref).length, 1, 'claimed once');
  assert.equal(one[1].prefKey, 'cam-A', 'by exact deviceId, not by whichever came first');
  assert.equal(one[0].pref, null);
  assert.equal(one[0].prefKey, 'id-A', 'a device with no entry is keyed by its own id, not its shared label');

  // the replug fallbacks still work when there is nothing better: a changed deviceId still finds its entry
  const replugged = mergePrefs({ mine: { key: { deviceId: 'old', label: 'Integrated Camera' }, role: 'hands' } },
                               [dev('Integrated Camera', 'brand-new')]);
  assert.equal(replugged[0].pref.role, 'hands');
});

test('preferences survive a store that throws (private browsing)', () => {
  const store = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadPrefs(store), {});
  assert.equal(savePrefs({ a: 1 }, store), false);
  const mem = new Map();
  const ok = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(savePrefs({ a: { role: 'head' } }, ok), true);
  assert.deepEqual(loadPrefs(ok), { a: { role: 'head' } });
});
