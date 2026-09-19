// What the user sees while grabbing, drawn for the rig rather than for a monitor.
//
// Two facts about a Pepper's-ghost rig decide everything here:
//   1. Black is transparent. The acrylic reflects 4-5%, so anything dark simply is not there. A drop SHADOW is
//      therefore impossible — you cannot draw darker than nothing. The depth cue has to be a bright ground RING
//      on the table plane plus a bright stem down to it, and the ring has to grow and dim with height the way a
//      shadow would, so the brain reads it as contact.
//   2. Only 4-5% of the light survives. Thin lines and dim greys vanish. Everything here is high-value colour
//      on chunky geometry (tubes and discs, never THREE.Line), additive, tone mapping off.
// And one fact about hands: any flicker reads as a tracking fault. Every response is a single eased ramp with
// no oscillation and no loop; the "take" pulse fires once and is over.

import * as THREE from 'three';

export const FEEDBACK_LOOKS = {
  hover: { color: 0x35d0ff, base: 0.06, rim: 0.95 },   // cool: you could take this
  held: { color: 0xffb23e, base: 0.14, rim: 1.35 },    // warm: you have it
  contact: 0xdff2ff,
  ground: 0x35d0ff,
  groundHeld: 0xffb23e,
};

const shellVert = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const shellFrag = `
uniform vec3 color;
uniform float base;
uniform float rim;
uniform float gain;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
  gl_FragColor = vec4(color * (base + rim * f) * gain, 1.0);
}`;

function shellMaterial(look) {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(look.color) },
      base: { value: look.base }, rim: { value: look.rim }, gain: { value: 0 },
    },
    vertexShader: shellVert, fragmentShader: shellFrag,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    depthFunc: THREE.LessEqualDepth,   // same geometry, same depth: it draws exactly over the part
    side: THREE.DoubleSide, toneMapped: false,
  });
}

const additive = (color, intensity = 1, depthTest = true) => new THREE.MeshBasicMaterial({
  color: new THREE.Color(color).multiplyScalar(intensity),
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest, toneMapped: false,
});

const ease = (a, b, dt, tau) => a + (b - a) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

/**
 * createFeedback({ scene, config, camera })
 *   update({ state, bodies, camera, now, dt })   state is grab.state() or the report update() returned
 * Bodies may carry `.object3d`; those get a highlight shell and a ground ring. Ones that do not are skipped.
 */
export function createFeedback({ scene, config, unitsPerMetre = 1 } = {}) {
  const u = unitsPerMetre;                         // so the sizes below stay readable in millimetres
  const mm = n => (n / 1000) * u;
  const group = new THREE.Group();
  group.name = 'grab-feedback';
  group.renderOrder = 10;
  if (scene) scene.add(group);

  const shells = new Map();       // bodyId -> { mesh, mat, gain, target, pulse }
  const grounds = new Map();      // bodyId -> { ring, stem, mats }
  const cursors = new Map();      // handId -> { dot, ring, mats }
  const disposables = [];
  const keep = o => { disposables.push(o); return o; };

  const ringGeo = keep(new THREE.TorusGeometry(1, 0.085, 8, 40));       // unit radius; scaled per use
  const discGeo = keep(new THREE.SphereGeometry(1, 16, 12));
  const stemGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true));

  // the shell shares the part's own geometry, so it fits whatever shape the part is; a body whose object3d is a
  // group (a loaded GLB, say) gets the shell on its first mesh
  function meshOf(object) {
    if (!object) return null;
    if (object.isMesh) return object;
    let found = null;
    object.traverse(o => { if (!found && o.isMesh && !o.userData.grabShell) found = o; });
    return found;
  }

  function shellFor(body) {
    let s = shells.get(body.id);
    const host = meshOf(body.object3d);
    const geo = host?.geometry;
    if (!geo) return null;
    if (!s || s.host !== host) {
      s?.mesh.parent?.remove(s.mesh);
      const mat = s?.mat || shellMaterial(FEEDBACK_LOOKS.hover);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.grabShell = true;
      mesh.raycast = () => {};
      mesh.renderOrder = 11;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      host.add(mesh);
      s = { mesh, mat, host, gain: s?.gain || 0, target: 0, pulse: 0, look: s?.look || 'hover' };
      shells.set(body.id, s);
      if (!disposables.includes(mat)) disposables.push(mat);
    }
    if (s.mesh.geometry !== geo) s.mesh.geometry = geo;   // the part may have been given new geometry since
    return s;
  }

  function groundFor(body) {
    let g = grounds.get(body.id);
    if (!g) {
      const ringMat = additive(FEEDBACK_LOOKS.ground, 0);
      const stemMat = additive(FEEDBACK_LOOKS.ground, 0);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      const stem = new THREE.Mesh(stemGeo, stemMat);
      ring.visible = stem.visible = false;
      group.add(ring, stem);
      g = { ring, stem, ringMat, stemMat, gain: 0 };
      grounds.set(body.id, g);
      disposables.push(ringMat, stemMat);
    }
    return g;
  }

  function cursorFor(id) {
    let c = cursors.get(id);
    if (!c) {
      // depthTest off: your fingers are usually inside or behind the model when you take hold of it, and a
      // cursor you cannot see is worse than one that floats. On the rig nothing occludes anything anyway —
      // it is all additive light through a half-silvered sheet.
      const dotMat = additive(FEEDBACK_LOOKS.contact, 0, false);
      const ringMat = additive(FEEDBACK_LOOKS.contact, 0, false);
      const dot = new THREE.Mesh(discGeo, dotMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      dot.visible = ring.visible = false;
      group.add(dot, ring);
      c = { dot, ring, dotMat, ringMat };
      cursors.set(id, c);
      disposables.push(dotMat, ringMat);
    }
    return c;
  }

  const setColor = (mat, hex, k) => mat.color.set(hex).multiplyScalar(Math.max(0, k));

  function update({ state, bodies = [], camera = null, dt = 1 / 60 } = {}) {
    if (!state) return;
    const held = new Set(state.holds.map(h => h.bodyId));
    const hovered = new Set(state.hands.filter(h => h.live && h.hoverId).map(h => h.hoverId));
    const floorY = (config?.floorY ?? 0);
    const volumeH = Math.max(1e-6, (config?.volume?.maxY ?? floorY + 0.3 * u) - floorY);

    for (const body of bodies) {
      const isHeld = held.has(body.id);
      const isHover = !isHeld && hovered.has(body.id);
      const s = shellFor(body);
      if (s) {
        const look = isHeld ? FEEDBACK_LOOKS.held : FEEDBACK_LOOKS.hover;
        if ((isHeld ? 'held' : 'hover') !== s.look) {
          s.look = isHeld ? 'held' : 'hover';
          s.mat.uniforms.color.value.set(look.color);
          s.mat.uniforms.base.value = look.base;
          s.mat.uniforms.rim.value = look.rim;
          if (isHeld) s.pulse = 1;     // one-shot: it takes hold, it does not blink
        }
        s.target = isHeld ? 1 : isHover ? 0.65 : 0;
        // rising fast (a grab must feel instant), falling slower (no flicker as a hover wobbles)
        s.gain = ease(s.gain, s.target, dt, s.target > s.gain ? 0.045 : 0.13);
        s.pulse = Math.max(0, s.pulse - dt / 0.18);
        const p = Math.sin(s.pulse * Math.PI) * 0.04;          // 0 -> 4% -> 0, once
        s.mat.uniforms.gain.value = s.gain * (1 + p * 3);
        s.mesh.scale.setScalar(1 + p);
        s.mesh.visible = s.gain > 0.01;
      }

      // the ground ring: the only depth cue that survives a black rig
      const g = groundFor(body);
      const want = isHeld ? 1 : isHover ? 0.35 : 0;
      g.gain = ease(g.gain, want, dt, want > g.gain ? 0.06 : 0.16);
      if (g.gain <= 0.01) {
        g.ring.visible = g.stem.visible = false;
      } else {
        const c = body.center || body.pose.position;
        // the stem has to reach the model's real underside, not the bottom of its pick sphere, or it hangs
        // in the air and reads as a second object
        const bottom = body.pose.position.y - (body.restOffset || 0);
        const h = Math.max(0, bottom - floorY);
        const lift = Math.min(1, h / volumeH);
        const r = (body.radius || mm(30)) * (0.85 + 0.75 * lift);   // spreads with height, like a shadow would
        const fade = g.gain / (1 + 2.2 * lift);
        const hex = isHeld ? FEEDBACK_LOOKS.groundHeld : FEEDBACK_LOOKS.ground;
        g.ring.position.set(c.x, floorY + mm(0.5), c.z);
        g.ring.scale.set(r, r, Math.max(mm(1.2), r * 0.06) / 0.085);
        setColor(g.ringMat, hex, fade * 0.9);
        g.ring.visible = true;
        // the stem says how high, and which ring belongs to which body when there are several
        g.stem.position.set(c.x, floorY + h / 2, c.z);
        g.stem.scale.set(mm(1.1), Math.max(mm(1), h), mm(1.1));
        setColor(g.stemMat, hex, fade * 0.35);
        g.stem.visible = h > mm(4);
      }
    }
    for (const [id, s] of shells) if (!bodies.some(b => b.id === id)) { s.mesh.visible = false; }
    for (const [id, g] of grounds) if (!bodies.some(b => b.id === id)) { g.ring.visible = g.stem.visible = false; }

    // the contact indicator: a ring that closes as the fingers close, and a dot that lights when it takes
    for (const h of state.hands) {
      const c = cursorFor(h.id);
      if (!h.live || !h.point) { c.dot.visible = c.ring.visible = false; continue; }
      const p = h.point;
      const amt = h.pinched ? 1 : h.pinchAmount;
      const r = mm(22) - mm(14) * amt;      // the ring closes as the fingers do: the gesture is legible early
      c.ring.position.set(p.x, p.y, p.z);
      c.ring.scale.set(r, r, mm(1.6) / 0.085);
      if (camera) c.ring.quaternion.copy(camera.quaternion);   // face the viewer: a torus edge-on disappears
      setColor(c.ringMat, FEEDBACK_LOOKS.contact, 0.14 + 0.6 * amt);
      c.ring.visible = true;
      c.dot.position.set(p.x, p.y, p.z);
      c.dot.scale.setScalar(mm(2.6) + mm(2.2) * (h.holdId ? 1 : 0));
      setColor(c.dotMat, h.holdId ? FEEDBACK_LOOKS.groundHeld : FEEDBACK_LOOKS.contact, 0.25 + 0.75 * amt);
      c.dot.visible = true;
    }
    for (const [id, c] of cursors) {
      if (!state.hands.some(h => h.id === id)) c.dot.visible = c.ring.visible = false;
    }
  }

  function dispose() {
    for (const s of shells.values()) s.mesh.parent?.remove(s.mesh);
    group.parent?.remove(group);
    for (const d of disposables) d.dispose?.();
    shells.clear(); grounds.clear(); cursors.clear();
  }

  return { group, update, dispose, shells, grounds, cursors };
}
