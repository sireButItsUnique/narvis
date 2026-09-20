import test from 'node:test';
import assert from 'node:assert/strict';
import {toRig, fromRig, cardQuad, levelDepth, rayThrough, rayCard, pick, eyeState, cardSize,
        EYE_MAX_AGE_MS, DEFAULT_VOLUME, DEFAULT_RIG_SPEC, panelCm, ghostOffsetMm, fitSlab,
        rigFromSpec, panelRectOnCanvas, onPanel, LEVEL_STEP, touch, aim,
        TOUCH_CM} from '../web_ar_canvas/public/volume.mjs';
import {makeRig, rigCamera, projectToMonitor, rigCheck, DEFAULT_EYE} from '../web_ar_canvas/public/rig-geometry.mjs';

const VOLUME = DEFAULT_VOLUME;
const ANCHOR = [0, -13, 0];

test('the slab is centred on the rig anchor and round-trips', () => {
  assert.deepEqual(toRig(VOLUME, {x: .5, y: .5, z: .5}), ANCHOR);
  const corner = toRig(VOLUME, {x: 1, y: 1, z: 1});
  assert.ok(Math.abs(corner[0] - (ANCHOR[0] + VOLUME.width_cm / 2)) < 1e-9);
  assert.ok(Math.abs(corner[1] - (ANCHOR[1] - VOLUME.height_cm / 2)) < 1e-9, 'normalized y runs down');
  assert.ok(Math.abs(corner[2] - (ANCHOR[2] + VOLUME.depth_cm / 2)) < 1e-9, '+Z is toward the viewer');
  for (const p of [{x: 0, y: 0, z: 0}, {x: .3, y: .8, z: .1}, {x: 1, y: 1, z: 1}]) {
    const back = fromRig(VOLUME, toRig(VOLUME, p));
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(back[k] - p[k]) < 1e-9, k);
  }
});

test('content stays under the sheet, which is what makes it a hologram', () => {
  for (const y of [0, .5, 1]) {
    const point = toRig(VOLUME, {x: .5, y, z: .5});
    assert.ok(point[1] < 0, `y=${y} must stay below the sheet plane, got ${point[1]}`);
  }
});

test('missing or non-finite coordinates fall back to the slab centre', () => {
  assert.deepEqual(toRig(VOLUME, {}), ANCHOR);
  assert.deepEqual(toRig(VOLUME, {x: NaN, y: Infinity, z: 'near'}), ANCHOR);
  assert.deepEqual(toRig(VOLUME, {x: .5, y: .5}), ANCHOR, 'a 2D position is simply mid-depth');
});

test('ancestor levels recede and never leave the slab', () => {
  assert.ok(levelDepth(0) < 1 && levelDepth(0) > .5,
            'the current level sits forward but clear of the front face, where hands go');
  assert.ok(levelDepth(1) < levelDepth(0));
  assert.ok(levelDepth(2) < levelDepth(1));
  for (const back of [0, 1, 2, 3, 40]) {
    const d = levelDepth(back);
    assert.ok(d >= 0 && d <= 1, `depth ${d} for ${back} levels back is outside the slab`);
  }
});

test('a card is an upright quad facing the viewer', () => {
  const quad = cardQuad([0, -13, 2], 8, 3);
  assert.equal(quad.length, 4);
  assert.ok(quad.every((p) => p[2] === 2), 'all four corners share one depth');
  assert.equal(quad[0][1] - quad[3][1], 3, 'height spans the quad');
  assert.equal(quad[1][0] - quad[0][0], 8, 'width spans the quad');
  assert.ok(cardSize('folder')[0] > cardSize('external')[0], 'folders read from further away');
});

test('the eye-through-fingertip ray lands where the viewer is pointing', () => {
  const eye = [0, 20, 40];
  const card = {centre: [0, -13, 0], widthCm: 8, heightCm: 3, id: 'a'};
  // A fingertip on the straight line from the eye to the card centre must hit the centre.
  const onLine = [eye[0] * .5, (eye[1] + card.centre[1]) / 2, (eye[2] + card.centre[2]) / 2];
  const hit = rayCard(rayThrough(eye, onLine), card.centre, card.widthCm, card.heightCm);
  assert.ok(hit, 'a fingertip between the eye and the card must hit it');
  assert.ok(Math.hypot(hit.point[0] - card.centre[0], hit.point[1] - card.centre[1]) < 1e-6);
  // Well off to the side, it must miss rather than snap.
  assert.equal(rayCard(rayThrough(eye, [40, 0, 20]), card.centre, card.widthCm, card.heightCm), null);
});

test('pointing picks the nearest card, not merely any card', () => {
  const near = {centre: [0, -13, 6], widthCm: 8, heightCm: 3, id: 'near'};
  const far = {centre: [0, -13, -6], widthCm: 8, heightCm: 3, id: 'far'};
  const ray = rayThrough([0, 20, 40], [0, 0, 20]);
  assert.equal(pick(ray, [far, near]).id, 'near');
  assert.equal(pick(ray, [near, far]).id, 'near', 'order must not decide it');
  assert.equal(pick(ray, []), null);
});

test('a ray cannot select something behind the eye', () => {
  const behind = {centre: [0, -13, 80], widthCm: 40, heightCm: 40, id: 'behind'};
  const ray = rayThrough([0, 20, 40], [0, 0, 20]);   // pointing away from +Z
  assert.equal(pick(ray, [behind]), null);
});

test('degenerate rays are refused instead of producing a direction', () => {
  assert.equal(rayThrough([0, 0, 0], [0, 0, 0]), null);
  assert.equal(rayThrough([0, 0, 0], [NaN, 0, 1]), null);
  assert.equal(rayCard(null, [0, 0, 0], 1, 1), null);
  // A ray parallel to the card plane never crosses it.
  assert.equal(rayCard({origin: [0, 0, 0], dir: [1, 0, 0]}, [0, 0, 5], 10, 10), null);
});

test('a head position that cannot be trusted freezes the volume', () => {
  const now = 10_000;
  assert.equal(eyeState(null, now).usable, false);
  assert.equal(eyeState({position_cm: [0, 1]}, now).reason, 'no_head_tracking');
  assert.equal(eyeState({position_cm: [0, 20, 40], received_ms: now}, now).usable, true);
  assert.equal(eyeState({position_cm: [0, 20, 40], received_ms: now - EYE_MAX_AGE_MS - 1}, now).reason,
               'stale_head_tracking');
  assert.equal(eyeState({position_cm: [0, 5000, 0], received_ms: now}, now).reason, 'head_out_of_range');
  assert.equal(eyeState({position_cm: [0, 20, 40], received_ms: now, simulated: true}, now).reason,
               'simulated_head');
});

test('the slab projects onto the panel through the real rig geometry', () => {
  const rig = makeRig();
  const camera = rigCamera(rig, DEFAULT_EYE);
  const centre = projectToMonitor(rig, camera, toRig(VOLUME, {x: .5, y: .5, z: .5}));
  assert.ok(centre.inside, 'the slab centre must land on the panel');
  assert.ok(!centre.behind);
  // Depth has to do something: the same x,y nearer the viewer must project differently.
  const near = projectToMonitor(rig, camera, toRig(VOLUME, {x: .5, y: .5, z: 1}));
  assert.ok(Math.hypot(near.u - centre.u, near.v - centre.v) > 1e-4, 'depth must change the projection');
});

test('moving the head moves the picture, which is the whole point', () => {
  const rig = makeRig();
  const point = toRig(VOLUME, {x: .3, y: .4, z: .7});
  const left = projectToMonitor(rig, rigCamera(rig, [-12, 42, 44]), point);
  const right = projectToMonitor(rig, rigCamera(rig, [12, 42, 44]), point);
  assert.ok(Math.abs(left.u - right.u) > 1e-3, 'a point must be drawn elsewhere when the eye moves');
});

test('the configured rig reports no geometry warnings for a seated viewer', () => {
  // This is the guard that matters. Narrowing the sheet from 4:3 to 16:9 took 4.5 inches of depth out of
  // it, and at the original 6 inch monitor drop two of the four image corners then reflected off the back
  // edge — a hologram with its corners cut off, from a change nothing else would have flagged.
  const check = rigCheck(rigFromSpec(DEFAULT_RIG_SPEC, makeRig), DEFAULT_EYE);
  assert.deepEqual(check.warnings, [], 'the vendored geometry must agree the configured rig is sane');
  assert.equal(check.ok, true);
});

test('a sheet too shallow for the panel is caught, not silently cropped', () => {
  const shallow = {...DEFAULT_RIG_SPEC, monitor_drop_cm: 15.24};   // the original 6 inch drop
  const check = rigCheck(rigFromSpec(shallow, makeRig), DEFAULT_EYE);
  assert.ok(check.warnings.some((w) => w.includes('edge of the sheet')),
            'the geometry must notice when the reflection runs off the sheet');
});

test('the panel is sized from its diagonal, which everything else scales off', () => {
  const [w, h] = panelCm(DEFAULT_RIG_SPEC);
  assert.ok(Math.abs(w - 59.77) < .05 && Math.abs(h - 33.62) < .05, `27" 16:9 is 59.77 x 33.62, got ${w} x ${h}`);
  // Entering the same rig as 24 inches is the mistake rigtest2's README warns about: ~12% out.
  const [w24] = panelCm({...DEFAULT_RIG_SPEC, panel_diagonal_in: 24});
  assert.ok(Math.abs(1 - w24 / w) > .10, 'a wrong diagonal must visibly change the scale, not be absorbed');
});

test('a two-surface beam splitter ghosts, and the sheet thickness says by how much', () => {
  const offset = ghostOffsetMm(DEFAULT_RIG_SPEC.sheet_thickness_mm);
  assert.ok(offset > 1.4 && offset < 1.7, `2 mm acrylic at 45 deg ghosts ~1.55 mm, got ${offset}`);
  assert.ok(ghostOffsetMm(6) > ghostOffsetMm(2), 'thicker acrylic ghosts further');
  assert.ok(ghostOffsetMm(0.2) < .2, 'a thin first-surface splitter barely ghosts');
});

test('the default volume is what the measured rig actually allows', () => {
  const rig = rigFromSpec(DEFAULT_RIG_SPEC, makeRig);
  const camera = rigCamera(rig, DEFAULT_EYE);
  const fitted = fitSlab(rig, DEFAULT_EYE, (p) => projectToMonitor(rig, camera, p));
  for (const axis of ['width_cm', 'height_cm', 'depth_cm'])
    assert.ok(Math.abs(fitted[axis] - VOLUME[axis]) < .3,
              `${axis}: the rig allows ${fitted[axis]} but the default says ${VOLUME[axis]}`);
});

test('every corner of the default slab lands on the panel', () => {
  const rig = rigFromSpec(DEFAULT_RIG_SPEC, makeRig);
  const camera = rigCamera(rig, DEFAULT_EYE);
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) {
    const p = projectToMonitor(rig, camera, toRig(VOLUME, {x, y, z}));
    assert.ok(p.inside, `corner ${x},${y},${z} falls off the panel at u=${p.u.toFixed(3)} v=${p.v.toFixed(3)}`);
  }
});

test('depth is a requirement, and the face it costs is a deliberate trade', () => {
  const rig = rigFromSpec(DEFAULT_RIG_SPEC, makeRig);
  const camera = rigCamera(rig, DEFAULT_EYE);
  const project = (p) => projectToMonitor(rig, camera, p);
  const greedy = fitSlab(rig, DEFAULT_EYE, project, {minDepthCm: 0});
  assert.ok(greedy.depth_cm < 4, 'filling the panel first really does starve the depth');
  // Every extra centimetre of depth costs face, monotonically. With this sheet the curve is steep:
  // 10 cm of depth costs about half the width. That is a choice, so it is asserted as one.
  let previous = Infinity;
  for (const want of [2, 4, 6, 8, 10, 12]) {
    const slab = fitSlab(rig, DEFAULT_EYE, project, {minDepthCm: want});
    assert.ok(slab.depth_cm >= want, `asked for ${want} cm of depth, got ${slab.depth_cm}`);
    assert.ok(slab.width_cm <= previous, 'more depth must never somehow buy more face');
    previous = slab.width_cm;
  }
  const chosen = fitSlab(rig, DEFAULT_EYE, project, {minDepthCm: 10});
  assert.ok(Math.abs(chosen.width_cm - VOLUME.width_cm) < .3, 'the default volume is a point on that curve');
  // Level separation has to be perceptible or the depth is wasted: LEVEL_STEP of the slab, in cm.
  assert.ok(VOLUME.depth_cm * LEVEL_STEP > 1.5,
            `levels would sit ${(VOLUME.depth_cm * LEVEL_STEP).toFixed(1)} cm apart, too close to read as depth`);
});

test('a level holds a readable number of cards, which is why the drill-down exists', () => {
  const [w, h] = cardSize('folder');
  const across = Math.floor(VOLUME.width_cm / (w * 1.05));
  const down = Math.floor(VOLUME.height_cm / (h * 1.25));
  const fits = across * down;
  // A 600-node graph cannot go in a slab this size; a level can. The 27 inch panel buys about 24 cards,
  // where a 24 inch one bought nine — which is exactly why the volume is measured and not assumed.
  assert.ok(fits >= 8 && fits <= 40, `a level fits ${fits} cards; outside 8-40 the level model needs rethinking`);
  assert.ok(fits < 60, 'a level must never try to be the whole graph again');
});

test('the level planes are square-on enough to read', () => {
  const rig = rigFromSpec(DEFAULT_RIG_SPEC, makeRig);
  const camera = rigCamera(rig, DEFAULT_EYE);
  const at = (x, y, z) => projectToMonitor(rig, camera, toRig(VOLUME, {x, y, z}));
  const z = levelDepth(0);
  const topSpan = at(1, 0, z).u - at(0, 0, z).u;
  const bottomSpan = at(1, 1, z).u - at(0, 1, z).u;
  // Some keystone is the point; a plane that tapers by more than a third is unreadable at the edges.
  const taper = Math.abs(1 - bottomSpan / topSpan);
  assert.ok(taper < .34, `the current level tapers by ${(taper * 100).toFixed(0)}%, too much to read`);
  // And it should sit around the middle of the panel rather than jammed against one edge.
  const v = at(.5, .5, z).v;
  assert.ok(v > .2 && v < .8, `the level centres at v=${v.toFixed(2)}, off the middle of the panel`);
});

test('the panel letterboxes into the canvas instead of stretching', () => {
  // A 16:9 panel in a 4:3 window: the image must keep its shape and sit in a band, not fill and distort.
  const rect = panelRectOnCanvas(800, 600, 59.77, 33.62);
  assert.ok(Math.abs(rect.w / rect.h - 59.77 / 33.62) < 1e-6, 'the drawn rectangle keeps the panel aspect');
  assert.equal(rect.w, 800, 'the wider axis fills');
  assert.ok(rect.y > 0 && Math.abs(rect.y * 2 + rect.h - 600) < 1e-6, 'and it is centred');
  // A taller window letterboxes the other way.
  const tall = panelRectOnCanvas(600, 900, 16, 9);
  assert.equal(tall.w, 600);
  assert.ok(tall.x === 0 && tall.y > 0);
  // On the rig itself the page is fullscreen on the panel, so there is no band at all.
  const exact = panelRectOnCanvas(2560, 1440, 16, 9);
  assert.deepEqual([exact.x, exact.y, exact.w, exact.h], [0, 0, 2560, 1440]);
  assert.deepEqual(onPanel(exact, .5, .25), [1280, 360]);
});

test('a finger among the cards touches, rather than sighting past them', () => {
  const card = {id: 'a', centre: [0, -13, 1.5], widthCm: 6, heightCm: 2};
  const eye = [0, 43, 43];
  // A fingertip resting on the card is a touch, whatever the eye is doing.
  assert.equal(touch([0, -13, 1.5], [card])?.id, 'a');
  assert.equal(touch([2.5, -13.5, 2.5], [card])?.id, 'a', 'near the face still counts');
  assert.equal(touch([0, -13, 1.5 + TOUCH_CM + 1], [card]), null, 'but not from any distance');
  // A finger held low, where the eye-ray would land above the card, must still pick it by touch.
  const low = [0, -13, 1.5];
  assert.equal(aim(eye, low, [card]).how, 'touch');
  // Out of reach entirely, the ray takes over.
  const far = {id: 'far', centre: [0, -4.7, 1.5], widthCm: 30, heightCm: 6};
  const aimed = aim(eye, [0, -10, -3], [far]);
  assert.equal(aimed?.how, 'ray', 'a card you cannot reach is still pointable');
});

test('touch prefers the nearest card when several are in reach', () => {
  const near = {id: 'near', centre: [0, -13, 1.5], widthCm: 4, heightCm: 2};
  const far = {id: 'far', centre: [0, -13, 3.5], widthCm: 4, heightCm: 2};
  assert.equal(touch([0, -13, 1.6], [far, near]).id, 'near');
  assert.equal(touch([0, -13, 3.4], [near, far]).id, 'far');
});
