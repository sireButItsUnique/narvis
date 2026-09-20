// Placing a graph level inside the rig's working volume.
//
// The service publishes normalized positions (x, y, z in 0..1) and a volume in centimetres; this turns
// the pair into RIG-frame points that rig-geometry.mjs can project. Nothing here knows about the monitor,
// the sheet or the eye — that is rig-geometry's job, and keeping the split means this file can be tested
// with `node --test` and reused by any renderer.
//
// RIG frame (rig-geometry.mjs owns it): centimetres, origin at the centre of the acrylic sheet,
// +X the viewer's right, +Y up, +Z toward the viewer. Content floats BELOW the sheet, so the slab is
// centred on the rig's model anchor rather than on the origin.
//
// Normalized frame (the 2D canvas owns it): x right, y DOWN, z toward the viewer, each 0..1. y runs down
// because that is what the flat canvas already uses, and one convention beats two.

// Card sizes in centimetres of floating image. The slab is only ~33 x 10 cm, so these are what decide
// how many cards a level can show at all: about nine. That is the constraint the drill-down exists for.
export const CARD_CM = { folder: [6.2, 2.1], file: [5.9, 1.9], class: [5.4, 1.8],
                         function: [5.4, 1.8], elsewhere: [5.0, 1.6], external: [4.6, 1.5] };
export const DEFAULT_VOLUME = { version: 1, width_cm: 21.1, depth_cm: 10.0, height_cm: 11.9 };
export const DEFAULT_RIG_SPEC = { version: 1, panel_diagonal_in: 27, panel_aspect_w: 16, panel_aspect_h: 9,
  sheet_width_cm: 60.96, sheet_depth_cm: 34.29, sheet_thickness_mm: 2.03,
  monitor_drop_cm: 24, monitor_forward_cm: -18, base_drop_cm: 15.24, tilt_deg: 40,
  anchor_drop_cm: 13 };

// The measured rig -> the descriptor rig-geometry.mjs wants. Everything scales off the panel diagonal,
// which is why it is a measurement and not a constant: a 27 inch panel entered as 24 puts the image
// about 12% out and no trimming fixes it (rig/rigtest2/README.md).
export function panelCm(spec) {
  const diag = Math.hypot(spec.panel_aspect_w, spec.panel_aspect_h);
  const cm = spec.panel_diagonal_in * 2.54;
  return [cm * spec.panel_aspect_w / diag, cm * spec.panel_aspect_h / diag];
}

// Two surfaces of a beam splitter make two reflections. For a plate of thickness t at 45 degrees the
// second one lands this far from the first, so thin bright strokes ghost by about this much.
export function ghostOffsetMm(thicknessMm, n = 1.49) {
  const i = Math.PI / 4, r = Math.asin(Math.sin(i) / n);
  return 2 * thicknessMm * Math.tan(r) * Math.cos(i);
}

// The measured spec -> the rig descriptor, in one place so the page and the tests cannot disagree.
export function rigFromSpec(spec, makeRig) {
  const [widthCm, heightCm] = panelCm(spec);
  return makeRig({
    monitor: { widthCm, heightCm, pixelW: 2560, pixelH: 1440,
               centre: [0, spec.monitor_drop_cm, spec.monitor_forward_cm ?? -18],
               tiltDeg: spec.tilt_deg },
    sheet: { point: [0, 0, 0], normal: [0, 1, 0],
             widthCm: spec.sheet_width_cm, depthCm: spec.sheet_depth_cm },
    model: { anchor: [0, -(spec.anchor_drop_cm ?? 13), 0], fitCm: 18, yawDeg: 0 },
  });
}

// Where the monitor sits fore and aft decides where its reflection lands on the panel. Left at the
// geometry's default the image sits high and to one side and most of the panel goes unused, so solve for
// the offset that puts the anchor — the point hands reach for — in the middle of the picture.
export function solveForward(spec, eye, makeRig, rigCamera, projectToMonitor, range = 40) {
  let best = null;
  for (let forward = -range; forward <= range; forward += .5) {
    const rig = rigFromSpec({...spec, monitor_forward_cm: forward}, makeRig);
    const camera = rigCamera(rig, eye);
    const p = projectToMonitor(rig, camera, rig.model.anchor);
    if (!p.inside) continue;
    const off = Math.hypot(p.u - .5, p.v - .5);
    if (!best || off < best.off) best = {forward: +forward.toFixed(1), off, u: p.u, v: p.v};
  }
  return best;
}

// The largest slab centred on the model anchor whose every corner still lands on the panel. Derived, not
// remembered, so changing the monitor changes the volume instead of quietly mis-scaling the hologram.
export function fitSlab(rig, eye, project, { margin = 0.96, step = 0.5, max = 120, minDepthCm = 10 } = {}) {
  const anchor = rig.model.anchor;
  const inside = (w, h, d) => {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const p = [anchor[0] + sx * w / 2, anchor[1] + sy * h / 2, anchor[2] + sz * d / 2];
      if (!project(p).inside) return false;
    }
    return true;
  };
  // Depth is the entire reason for a hologram, so it is a REQUIREMENT, not what is left over: grow the
  // face only as far as it can go while still carrying minDepthCm, then take any depth still going spare.
  // Maximising the face first fills the panel and leaves about 2 cm of depth, which reads as a flat picture.
  const [pw, ph] = [rig.monitor.widthCm, rig.monitor.heightCm];
  let best = { width_cm: 0, height_cm: 0, depth_cm: 0 };
  for (let w = step; w <= max; w += step) {
    const h = w * (ph / pw);
    if (!inside(w * margin, h * margin, minDepthCm)) break;
    best = { width_cm: +(w * margin).toFixed(1), height_cm: +(h * margin).toFixed(1), depth_cm: minDepthCm };
  }
  if (!best.width_cm) return { version: 1, width_cm: 0, height_cm: 0, depth_cm: 0 };
  for (let d = minDepthCm; d <= max; d += step) {
    if (!inside(best.width_cm, best.height_cm, d)) break;
    best.depth_cm = +d.toFixed(1);
  }
  return { version: 1, ...best };
}
export const cardSize = (kind) => CARD_CM[kind] || CARD_CM.function;

// Where each level sits through the depth of the slab. The level you are on is forward and the ones you
// came through recede behind it, so the way down is visible as depth instead of remembered.
//
// The current level is NOT at the very front. The front face of the slab projects into the top half of
// the panel with the strongest keystone, and it is also where hands will be, so content there would be
// both distorted and occluded by the fingers reaching for it. Two thirds back is square-on and clear.
export const LEVEL_FRONT = 0.65;
export const LEVEL_STEP = 0.22;

export function levelDepth(back) {
  return Math.max(0, LEVEL_FRONT - LEVEL_STEP * Math.max(0, back));
}

// Normalized point -> RIG centimetres, inside a slab centred on the rig's model anchor.
export function toRig(volume, p, anchor = [0, -13, 0]) {
  const x = num(p.x, .5), y = num(p.y, .5), z = num(p.z, .5);
  return [anchor[0] + (x - .5) * volume.width_cm,
          anchor[1] + (.5 - y) * volume.height_cm,
          anchor[2] + (z - .5) * volume.depth_cm];
}

export function fromRig(volume, point, anchor = [0, -13, 0]) {
  return {x: (point[0] - anchor[0]) / volume.width_cm + .5,
          y: .5 - (point[1] - anchor[1]) / volume.height_cm,
          z: (point[2] - anchor[2]) / volume.depth_cm + .5};
}

// A card stands upright facing the viewer: a quad in the rig's X-Y plane at one depth.
export function cardQuad(centre, widthCm, heightCm) {
  const hw = widthCm / 2, hh = heightCm / 2;
  return [[centre[0] - hw, centre[1] + hh, centre[2]],
          [centre[0] + hw, centre[1] + hh, centre[2]],
          [centre[0] + hw, centre[1] - hh, centre[2]],
          [centre[0] - hw, centre[1] - hh, centre[2]]];
}

// The panel's pixel rectangle inside whatever canvas we have. On the rig the page is fullscreen on the
// panel and this is the whole canvas; anywhere else it letterboxes. Mapping u,v straight onto the window
// instead would stretch the hologram by the ratio of the two aspects — a 16:9 image on a 4:3 window comes
// out a third too tall, and a distorted hologram is not a hologram.
export function panelRectOnCanvas(canvasW, canvasH, panelW, panelH) {
  const want = panelW / panelH, have = canvasW / canvasH;
  const w = have > want ? canvasH * want : canvasW;
  const h = have > want ? canvasH : canvasW / want;
  return {x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h};
}

export const onPanel = (rect, u, v) => [rect.x + u * rect.w, rect.y + v * rect.h];

// ---- pointing -------------------------------------------------------------------------------
// In a Pepper's ghost the eye position is already tracked, so a ray from the eye through the fingertip
// lands where the viewer PERCEIVES they are pointing. That is the only definition of pointing that
// matters here, and it needs no gaze tracker.

export function rayThrough(eyeCm, fingertipCm) {
  const d = [fingertipCm[0] - eyeCm[0], fingertipCm[1] - eyeCm[1], fingertipCm[2] - eyeCm[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  if (!(n > 1e-9) || ![...eyeCm, ...fingertipCm].every(Number.isFinite)) return null;
  return {origin: eyeCm.slice(), dir: [d[0] / n, d[1] / n, d[2] / n]};
}

// Where a ray crosses a card's plane (cards are axis-aligned at constant Z), and whether it lands on it.
export function rayCard(ray, centre, widthCm, heightCm) {
  if (!ray || Math.abs(ray.dir[2]) < 1e-9) return null;
  const t = (centre[2] - ray.origin[2]) / ray.dir[2];
  if (!(t > 0)) return null;                                   // the card is behind the eye
  const hit = [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, centre[2]];
  const dx = Math.abs(hit[0] - centre[0]), dy = Math.abs(hit[1] - centre[1]);
  if (dx > widthCm / 2 || dy > heightCm / 2) return null;
  return {t, point: hit};
}

// The nearest card the ray lands on. Cards carry {centre, widthCm, heightCm, id}.
export function pick(ray, cards) {
  let best = null;
  for (const card of cards) {
    const hit = rayCard(ray, card.centre, card.widthCm, card.heightCm);
    if (hit && (!best || hit.t < best.t)) best = {...hit, id: card.id, card};
  }
  return best;
}

// Reaching for a card, rather than sighting along it. The image floats within arm's reach, so the natural
// gesture is to put a finger ON a card — and a ray from the eye through a fingertip held BELOW the content
// lands above it, which feels broken however correct it is. So touch decides when the hand is among the
// cards, and the ray only takes over when it is not: pointing at something across the desk you cannot reach.
export const TOUCH_CM = 3.2;

export function touch(fingertipCm, cards, reach = TOUCH_CM) {
  let best = null;
  for (const card of cards) {
    const dx = Math.max(0, Math.abs(fingertipCm[0] - card.centre[0]) - card.widthCm / 2);
    const dy = Math.max(0, Math.abs(fingertipCm[1] - card.centre[1]) - card.heightCm / 2);
    const dz = Math.abs(fingertipCm[2] - card.centre[2]);
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= reach && (!best || distance < best.distance))
      best = {id: card.id, card, distance, point: fingertipCm.slice(), how: 'touch'};
  }
  return best;
}

// What the hand is indicating: whichever of the two applies, touch first.
export function aim(eyeCm, fingertipCm, cards, reach = TOUCH_CM) {
  const near = touch(fingertipCm, cards, reach);
  if (near) return near;
  const got = pick(rayThrough(eyeCm, fingertipCm), cards);
  return got ? {...got, how: 'ray'} : null;
}

// ---- degraded input -------------------------------------------------------------------------
// The rig refuses to draw a confident hologram from a bad head position. The same rule applies to the
// graph: an eye that is stale, missing or implausible freezes the volume rather than moving it wrongly.
export const EYE_MAX_AGE_MS = 250;
export const EYE_REACH_CM = 200;

export function eyeState(eye, nowMs) {
  if (!eye || !Array.isArray(eye.position_cm) || eye.position_cm.length !== 3 ||
      !eye.position_cm.every(Number.isFinite))
    return {usable: false, reason: 'no_head_tracking'};
  const age = nowMs - (eye.received_ms ?? -Infinity);
  if (!(age >= 0) || age > EYE_MAX_AGE_MS)
    return {usable: false, reason: 'stale_head_tracking', age_ms: age};
  if (Math.hypot(...eye.position_cm) > EYE_REACH_CM)
    return {usable: false, reason: 'head_out_of_range'};
  return {usable: true, reason: eye.simulated ? 'simulated_head' : 'tracking', age_ms: age};
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
