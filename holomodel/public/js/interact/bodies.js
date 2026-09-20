// The adapter between grab.js (plain numbers) and three.js (Object3D). grab.js never imports three, so this is
// the only file that has to change if the scene graph around it is rearranged.
//
// Poses are in the WORLD frame, because that is the frame the hand tracker delivers hands in. If the parts hang
// off a transformed root (the M1 part registry puts them under `holo_root`), pass that root as `frame` and the
// binding converts both ways.

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _n = new THREE.Matrix4();

const toV = v => ({ x: v.x, y: v.y, z: v.z });
const toQ = q => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/**
 * @param {THREE.Object3D} object
 * @param {object} opts
 * @param {string} opts.id            stable id (the part's holo_id in the real app)
 * @param {THREE.Object3D} [opts.frame]  the space grab works in; default the world
 * @param {number} [opts.radiusScale] pick sphere as a multiple of the geometry's bounding sphere
 */
export function bindBody(object, { id = object.uuid, frame = null, radiusScale = 1.0, locked = false } = {}) {
  const baseScale = object.scale.clone();
  const body = {
    id, object3d: object, frame,
    pose: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 },
    center: { x: 0, y: 0, z: 0 }, radius: 0.05, restOffset: 0, locked,
    // half-extents of the pick box in WORLD units, and the part's orientation, so grab.js can rank by
    // distance to the actual part instead of to a sphere around it
    half: { x: 0.05, y: 0.05, z: 0.05 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    localCenter: new THREE.Vector3(), localRadius: 0.05, localBottom: 0,
    localHalf: new THREE.Vector3(0.05, 0.05, 0.05),
  };

  // the pick sphere and the "how far is the bottom below the origin" figure, from the geometry itself
  function measure() {
    const box = new THREE.Box3();
    object.traverse(o => {
      if (!o.isMesh || !o.geometry || o.userData.grabShell) return;   // the feedback shell is not part of the part
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone();
      if (o !== object) { o.updateMatrix(); b.applyMatrix4(o.matrix); }
      box.union(b);
    });
    if (box.isEmpty()) return;
    box.getCenter(body.localCenter);
    box.getSize(_v).multiplyScalar(0.5);
    body.localHalf.copy(_v);
    // Cap the pick sphere at the LARGEST HALF-EXTENT rather than the circumradius (half the bounding-box
    // diagonal). A 30 x 2 x 30 cm base slab claimed a 21 cm sphere, so it was pickable 27 cm above its
    // own 1 cm-thick top face, through empty air where nothing is drawn.
    body.localRadius = Math.min(_v.length(), Math.max(_v.x, _v.y, _v.z));
    body.localBottom = box.min.y;
    body.localBox = box.clone();
  }
  measure();

  // three -> plain: read the object's transform into body.pose (call when anything else moved it)
  function sync() {
    object.updateWorldMatrix(true, false);
    if (frame) {
      frame.updateWorldMatrix(true, false);
      _m.copy(frame.matrixWorld).invert().multiply(object.matrixWorld);
    } else {
      _m.copy(object.matrixWorld);
    }
    _m.decompose(_v, _q, _s);
    body.pose.position = toV(_v);
    body.pose.quaternion = toQ(_q);
    body.pose.scale = _s.x / (baseScale.x || 1);
    setBounds(body.pose.position, _q, _s.x);
    return body;
  }

  // plain -> three: write body.pose back onto the object
  function apply() {
    const p = body.pose;
    _v.set(p.position.x, p.position.y, p.position.z);
    _q.set(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w);
    _s.copy(baseScale).multiplyScalar(p.scale);
    _m.compose(_v, _q, _s);
    if (frame) { frame.updateWorldMatrix(true, false); _m.premultiply(frame.matrixWorld); }
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      _m.premultiply(_n.copy(object.parent.matrixWorld).invert());
    }
    _m.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
    // the pick sphere travels with it, or the next grab would aim at where it used to be
    setBounds(p.position, _q, _s.x);
    return object;
  }

  const _c = new THREE.Vector3();
  const _corner = new THREE.Vector3();
  function setBounds(pos, quat, k) {
    _c.copy(body.localCenter).applyQuaternion(quat).multiplyScalar(k);
    body.center = { x: pos.x + _c.x, y: pos.y + _c.y, z: pos.z + _c.z };
    body.radius = body.localRadius * k * radiusScale;
    body.half = { x: body.localHalf.x * k * radiusScale, y: body.localHalf.y * k * radiusScale,
                  z: body.localHalf.z * k * radiusScale };
    body.quaternion = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };
    // How far the part's LOWEST point is below its origin, with the rotation applied. Ignoring the
    // rotation rested a two-hand-rotated part in mid-air over its own ground ring — 17 mm at 60 degrees,
    // 45 mm at 90 — and feedback.js draws the contact stem from the same number, so the cue came adrift
    // from the part. Rotating the eight corners is exact for a box and conservative for anything else.
    const b = body.localBox;
    if (b) {
      let minY = Infinity;
      for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        minY = Math.min(minY, _corner.applyQuaternion(quat).y);
      }
      body.restOffset = -minY * k;
    } else {
      body.restOffset = -body.localBottom * k;
    }
  }

  sync();
  return { body, sync, apply, measure, get baseScale() { return baseScale.clone(); } };
}

// Bind several objects at once; returns { bodies, sync(), apply() } for the whole set.
export function bindBodies(entries, shared = {}) {
  const bound = entries.map(e => (e.isObject3D ? bindBody(e, shared) : bindBody(e.object, { ...shared, ...e })));
  return {
    bound,
    bodies: bound.map(b => b.body),
    sync: () => bound.forEach(b => b.sync()),
    apply: () => bound.forEach(b => b.apply()),
  };
}

// handsFromInput lives in wire.js, which imports no three.js, so a page (or a test) can read the solver's
// hands without pulling the renderer in. Re-exported here because this is where callers look for it.
export { handsFromInput } from './wire.js';
