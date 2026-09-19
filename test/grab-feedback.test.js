// The visual layer, checked without a GPU: three.js builds scene objects fine in node as long as nothing
// renders, so the rules that matter on the rig (bright on black, one-shot responses, a ground ring instead of
// an impossible shadow) can be asserted here rather than eyeballed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGrab } from '../public/js/interact/grab.js';
import { createFeedback, FEEDBACK_LOOKS } from '../public/js/interact/feedback.js';
import { bindBody } from '../public/js/interact/bodies.js';
import { GRAB_CONFIG, cloneConfig } from '../public/js/interact/config.js';
import { handFrame } from '../public/js/interact/replay.js';

function bench() {
  const config = cloneConfig(GRAB_CONFIG);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1.6, 0.05, 6);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshStandardMaterial());
  mesh.position.set(0, 0.12, 0);
  scene.add(mesh);
  const binding = bindBody(mesh, { id: 'b' });
  const grab = createGrab({ config });
  const feedback = createFeedback({ scene, config });
  const step = (grip, gap, now) => {
    const state = grab.update({ hands: [handFrame(0, grip, gap, now)], bodies: [binding.body], now });
    binding.apply();
    feedback.update({ state, bodies: [binding.body], camera, dt: 1 / 60 });
    return state;
  };
  return { config, scene, camera, mesh, binding, grab, feedback, step };
}

const run = (b, grip, gap, t0, ms) => {
  for (let t = t0; t <= t0 + ms; t += 1000 / 60) b.step(grip, gap, t);
  return t0 + ms;
};

test('every material the feedback draws is additive, unlit and writes no depth', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.012, 0, 600);
  const mats = [
    ...[...b.feedback.shells.values()].map(s => s.mat),
    ...[...b.feedback.grounds.values()].flatMap(g => [g.ringMat, g.stemMat]),
    ...[...b.feedback.cursors.values()].flatMap(c => [c.dotMat, c.ringMat]),
  ];
  assert.ok(mats.length >= 5, `found ${mats.length} materials`);
  for (const m of mats) {
    assert.equal(m.blending, THREE.AdditiveBlending, 'black must stay black: nothing may paint over it');
    assert.equal(m.depthWrite, false);
    assert.equal(m.toneMapped, false, 'tone mapping would pull the highlights down into the noise floor');
  }
});

test('hovering lights the part; taking hold lights it more, and warm instead of cool', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.070, 0, 500);          // open hand, over the part
  const shell = b.feedback.shells.get('b');
  assert.ok(shell, 'a hovered part gets a highlight shell');
  assert.ok(shell.mesh.visible);
  const hoverGain = shell.mat.uniforms.gain.value;
  assert.ok(hoverGain > 0.3 && hoverGain < 0.9, `hover gain ${hoverGain.toFixed(2)}`);
  assert.equal(shell.mat.uniforms.color.value.getHex(), FEEDBACK_LOOKS.hover.color);

  run(b, { x: 0, y: 0.12, z: 0 }, 0.012, 600, 500);         // pinch
  assert.equal(b.grab.isHeld('b'), true);
  assert.ok(shell.mat.uniforms.gain.value > hoverGain, 'held reads stronger than hover');
  assert.equal(shell.mat.uniforms.color.value.getHex(), FEEDBACK_LOOKS.held.color);
});

test('the grab response is a single pulse, not a flicker', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.070, 0, 400);
  const shell = b.feedback.shells.get('b');
  const scales = [];
  for (let t = 500; t <= 1600; t += 1000 / 60) { b.step({ x: 0, y: 0.12, z: 0 }, 0.012, t); scales.push(shell.mesh.scale.x); }
  const peak = Math.max(...scales);
  assert.ok(peak > 1.005 && peak < 1.06, `pulse peaked at ${((peak - 1) * 100).toFixed(1)}%`);
  // it rises once and comes back, and never rises again
  const peakAt = scales.indexOf(peak);
  for (let i = peakAt + 1; i < scales.length; i++) {
    assert.ok(scales[i] <= scales[i - 1] + 1e-9, `scale went back up at frame ${i}: that is a flicker`);
  }
  assert.ok(scales[scales.length - 1] < 1.0005, 'and it settles back to nothing');
});

test('a held part gets a ground ring and a stem that reaches its underside', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.012, 0, 700);
  const g = b.feedback.grounds.get('b');
  assert.ok(g.ring.visible, 'the depth cue on a black rig is a bright ring, never a shadow');
  assert.ok(Math.abs(g.ring.position.y - b.config.floorY) < 0.002, 'the ring sits on the floor plane');
  assert.ok(Math.abs(g.ring.position.x - b.binding.body.pose.position.x) < 1e-6, 'directly under the part');
  assert.ok(g.stem.visible);
  const top = g.stem.position.y + g.stem.scale.y / 2;
  const bottom = b.binding.body.pose.position.y - b.binding.body.restOffset;
  assert.ok(Math.abs(top - bottom) < 0.003, `stem top ${top.toFixed(3)} vs part underside ${bottom.toFixed(3)}`);
});

test('the ring spreads and dims with height, the way a shadow would', () => {
  const b = bench();
  run(b, { x: 0, y: 0.06, z: 0 }, 0.012, 0, 700);
  const g = b.feedback.grounds.get('b');
  const lowR = g.ring.scale.x, lowBright = g.ringMat.color.r;
  run(b, { x: 0, y: 0.26, z: 0 }, 0.012, 800, 900);
  assert.ok(g.ring.scale.x > lowR * 1.1, `ring grew from ${lowR.toFixed(3)} to ${g.ring.scale.x.toFixed(3)}`);
  assert.ok(g.ringMat.color.r < lowBright * 0.85, 'and dimmed');
});

test('the contact ring closes as the fingers close', () => {
  const b = bench();
  run(b, { x: 0.09, y: 0.12, z: 0 }, 0.070, 0, 300);
  const c = b.feedback.cursors.get(0);
  const open = c.ring.scale.x;
  run(b, { x: 0.09, y: 0.12, z: 0 }, 0.030, 400, 200);
  const half = c.ring.scale.x;
  run(b, { x: 0.09, y: 0.12, z: 0 }, 0.012, 700, 200);
  const shut = c.ring.scale.x;
  assert.ok(open > half && half > shut, `${open.toFixed(4)} > ${half.toFixed(4)} > ${shut.toFixed(4)}`);
  assert.ok(c.dot.visible && c.ring.visible);
  // the cursor must stay visible when the hand is inside the model
  assert.equal(c.ringMat.depthTest, false);
});

test('a hand that is gone takes its cursor with it', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.070, 0, 300);
  const c = b.feedback.cursors.get(0);
  assert.ok(c.ring.visible);
  for (let t = 400; t <= 1200; t += 1000 / 60) {
    const state = b.grab.update({ hands: [], bodies: [b.binding.body], now: t });
    b.feedback.update({ state, bodies: [b.binding.body], camera: b.camera, dt: 1 / 60 });
  }
  assert.equal(c.ring.visible, false);
  assert.equal(c.dot.visible, false);
});

test('the shell rides the part it belongs to, so it never drifts off the model', () => {
  const b = bench();
  run(b, { x: 0, y: 0.12, z: 0 }, 0.012, 0, 500);
  const shell = b.feedback.shells.get('b');
  assert.equal(shell.mesh.parent, b.mesh, 'it is a child of the part, not a free object');
  assert.equal(shell.mesh.geometry, b.mesh.geometry, 'and shares its geometry, so it fits any shape');
});
