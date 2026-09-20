// SPDX-License-Identifier: GPL-3.0-or-later
// Holomodel as a SCENE of rigtest3: models made by voice, the six tools, sculpting - inside the rig page that
// is already calibrated, drawn by ITS renderer, behind ITS black hand.
//
// Holomodel's features are not a library: they are a page (index.html + main.js) wired to forty elements of its
// own, reading one object (input/state.js) and filling one THREE.Scene (view.js). So rather than take that page
// apart, this mounts it whole and unseen - its markup in a box nobody can see, its main.js running, its voice
// listening - and connects the two ends that matter:
//
//   in    rigtest3 already has the hand and the eye: placed in the rig, gated on confidence, smoothed. Each
//         frame it hands them over (feed) and they are written into input/state.js the way input/bridge.js
//         writes them. Holomodel opens no socket and no camera of its own.
//   out   Holomodel's scene is handed back (scene) and rigtest3 draws it, with its own renderer and the rig's
//         off-axis camera. Holomodel's own renderer is given nothing to draw.
//
// Holomodel's world is a box behind "the display"; here the box is a stage in the slot (input/bridge.js STAGE),
// one translation from the rig frame, so the camera that draws its scene is the rig camera moved by that much.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyRigCamera } from './rig/geometry.js';

export async function mountHolomodel({ renderer, grab = {}, ownFrame = null }) {
  // ONE loop, not two. Holomodel's main.js runs itself off requestAnimationFrame; left to that, its tick and
  // this page's frame would interleave in whatever order the browser chose, a frame of lag between the hand
  // being fed and being used. So its frame function is caught as it registers, never handed to the browser
  // again, and called by the host (tick) exactly once per drawn frame: feed, tick, draw.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let theirFrame = null, catching = true;
  window.requestAnimationFrame = cb => {
    if (cb === theirFrame) return 0;
    if (catching && !theirFrame && cb !== ownFrame && cb.name === 'frame') { theirFrame = cb; return 0; }
    return nativeRaf(cb);
  };
  // their page's body, where main.js expects to find it; out of sight, and without the canvas we already have
  const doc = new DOMParser().parseFromString(await (await fetch('/index.html')).text(), 'text/html');
  const box = document.createElement('div');
  box.id = 'holo-ui';
  box.style.cssText = 'position:fixed;left:-200vw;top:0;width:1280px;height:720px;overflow:hidden;visibility:hidden;pointer-events:none';
  for (const el of [...doc.body.children]) {
    if (el.tagName === 'SCRIPT' || el.id === 'htw-view') continue;
    box.appendChild(document.importNode(el, true));
  }
  document.body.appendChild(box);

  const [{ S }, V, B, { input }, M, HV] = await Promise.all([
    import('./settings.js'), import('./view.js'), import('./input/bridge.js'), import('./input/state.js'),
    import('./model.js'), import('./handviz.js')]);
  S.diagIn = B.STAGE.diagIn;                    // the stage's front face, not a monitor
  V.useStage(true);
  await import('./main.js');
  catching = false;
  document.getElementById('btn-mouse').click();   // begin(): the start that asks nothing of any camera
  V.views.length = 0;                           // their renderer draws nothing; ours draws their scene
  V.setRoomVisible(false);                      // the box's walls are not hologram
  HV.setBonesVisible(false);                    // the hand is rigtest3's black one
  // their environment map lives in THEIR renderer's GL context; light the same scene for ours
  V.scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  V.scene.background = null;

  const writer = B.makeHandWriter(grab);
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  const text = id => (document.getElementById(id)?.textContent || '').trim();

  return {
    scene: V.scene, camera, grabOptions: writer.grab.options,
    // once a frame, before drawing: the eye and hand rigtest3 is using, in rig centimetres
    feed({ eyeRig, tracked, handRig, pinch, now }) {
      input.mode = 'camera';                    // hands, whatever key anyone pressed
      input.source = 'host';
      B.writeEye(eyeRig, tracked, now);
      B.writeHand(writer, handRig, pinch, now);
    },
    // Holomodel's own per-frame work (its tools acting on what was just fed), driven from here
    tick(now) { theirFrame?.(now); },
    // the rig camera `rc` (geometry.js rigCamera), moved into Holomodel's frame
    aim(rc) { return applyRigCamera(camera, rc, B.WORLD_FROM_RIG); },
    // what their page is saying, for rigtest3 to put on the glass the right way round
    status() {
      return { tool: text('tool-name'), hint: text('tool-hint'), heard: text('heard'), banner: text('htw-banner'),
               hasModel: !!M.model.group, pinch: input.hands[0].pinch, handActive: input.hands[0].active };
    },
    // a model to hold before Blender has made one
    async loadFixture(name = 'teapot.glb') {
      const { fetchScene } = await import('./scene/load.js');
      M.showScene(await fetchScene(`/fixtures/${name}`));
    },
  };
}
