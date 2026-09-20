// SPDX-License-Identifier: GPL-3.0-or-later
// The headless exercise for rigtest2's step 5, written out as a CDP steps file.
//
// test/paircalib.test.js proves the MATHS with no browser. This proves the WIRING: that the buttons on the
// page reach the capture, that the capture reaches the solve, that the solve reaches the pair the
// triangulator actually uses, that it is saved, and that the refusals keep the typed angles. None of that
// is testable under node --test, and all of it is where this kind of feature normally breaks.
//
// The one thing stubbed is the pair of webcams: a headless browser has no cameras and no MediaPipe, so the
// page's debug hook takes fabricated landmark streams instead - a face-shaped cloud of 478 points moved
// through the working volume and projected through a rig whose pose we know, with pixel noise on top.
// Everything downstream of calib.feed() is the page's own code.
//
//   node scripts/rigtest2-calib-steps.mjs <out.json>
//   PORT=8840 node server.js &
//   node .research/tools/cdp.mjs "http://127.0.0.1:8840/rigtest2.html?setup=1" <out.json>
//
// Expected, with the truth below: the solved rotations land within about 0.2 degrees of TRUTH, the swapped
// session is refused with BASELINE, and the standing-still session is refused with SPREAD.

import fs from 'node:fs';

// The rig the fabricated cameras really have. Deliberately NOT what aimPair() derives from "my head sits
// at (0, 40, 45)", which is toe 48.5 / tilt 30.5: that gap is the error step 5 exists to measure away.
export const TRUTH = { left: [29.2, -46.4, 179.1], right: [31.4, 47.9, 180.6], baselineCm: 101.6 };

// Evaluated inside the page. NOISE is substituted per use.
const GEN = `(() => {
  const DEG = Math.PI/180;
  const rot = (rx,ry,rz) => { rx*=DEG; ry*=DEG; rz*=DEG;
    const cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
    return [cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx, sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx, -sy, cy*sx, cy*cx]; };
  const mulberry = s => () => { s=(s+0x6D2B79F5)>>>0; let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
  const rng = mulberry(20260919);
  const gauss = () => { let u=0; while(u===0) u=rng(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rng()); };
  const W=1280, H=720, F=Math.hypot(W,H)/2/Math.tan(78*DEG/2);
  const T = { left:{p:[-50.8,0,0],r:[29.2,-46.4,179.1]}, right:{p:[50.8,0,0],r:[31.4,47.9,180.6]} };
  const cam = c => { const M=rot(c.r[0],c.r[1],c.r[2]); return { p:c.p, wc:[M[0],M[3],M[6],M[1],M[4],M[7],M[2],M[5],M[8]] }; };
  const CAMS = [cam(T.left), cam(T.right)];
  const project = (c, P) => { const d=[P[0]-c.p[0],P[1]-c.p[1],P[2]-c.p[2]];
    const x=c.wc[0]*d[0]+c.wc[1]*d[1]+c.wc[2]*d[2], y=c.wc[3]*d[0]+c.wc[4]*d[1]+c.wc[5]*d[2], z=c.wc[6]*d[0]+c.wc[7]*d[1]+c.wc[8]*d[2];
    if (z<=0) return null;
    return [((F*x/z+W/2)+gauss()*NOISE)/W, ((F*y/z+H/2)+gauss()*NOISE)/H]; };
  const fr = mulberry(99), FACE=[];
  for (let i=0;i<478;i++){ const a=fr()*Math.PI*2, b=Math.acos(2*fr()-1);
    FACE.push([7*Math.sin(b)*Math.cos(a), 10*Math.cos(b), 4.5*Math.sin(b)*Math.sin(a)]); }
  FACE[468]=[-3.15,0,4.0]; FACE[473]=[3.15,0,4.0];
  const headAt = (c,yd,pd) => { const cy=Math.cos(yd*DEG),sy=Math.sin(yd*DEG),cp=Math.cos(pd*DEG),sp=Math.sin(pd*DEG);
    return FACE.map(q => { const x=q[0]*cy+q[2]*sy, z=-q[0]*sy+q[2]*cy, y=q[1]*cp-z*sp, z2=q[1]*sp+z*cp;
      return [c[0]+x, c[1]+y, c[2]+z2]; }); };
  const poses=[]; POSES;
  let t = performance.now(), fed = 0;
  for (const at of poses) {
    const world = headAt(at, at[0]*0.4, (40-at[1])*0.3);
    const a=[], b=[]; let ok=true;
    for (const P of world) { const pa=project(CAMS[0],P), pb=project(CAMS[1],P);
      if (!pa||!pb) { ok=false; break; } a.push(pa); b.push(pb); }
    if (!ok) continue;
    t += 100;
    if (rigtest2.calib.feed({ tA: t, tB: t+4, FEED }).ok) fed++;
  }
  return { fed, progress: rigtest2.calib.progress() };
})()`;

const VOLUME = 'for (const x of [-16,-8,0,8,16]) for (const y of [33,40,47]) for (const z of [36,45,54]) poses.push([x,y,z])';
const ONE_SPOT = 'for (let i=0;i<40;i++) poses.push([0.2*Math.sin(i), 40+0.2*Math.cos(i), 45])';
const gen = ({ noise = 0.5, poses = VOLUME, swap = false } = {}) =>
  GEN.replace(/NOISE/g, String(noise)).replace('POSES', poses).replace('FEED', swap ? 'a: b, b: a' : 'a, b');

const click = id => `document.getElementById('${id}').click()`;

export const steps = [
  { label: 'the page came up with its calibration hook', js: 'typeof window.rigtest2.calib' },
  { label: 'before step 5, the pair uses the DERIVED angles', js: 'JSON.stringify(rigtest2.calib.angles())' },
  { label: 'open step 5 and start capturing', js: `document.querySelector('.steps button[data-step="5"]').click(); ${click('calStart')}; 'ok'` },

  { label: 'a session: a face moved round the volume, seen by both cameras', js: gen({}) },
  { label: 'the progress the user reads', js: 'rigtest2.calib.panel().progress' },
  { label: 'the flag on the glass', js: 'rigtest2.calib.flag()' },
  { label: 'press Solve', js: `${click('calSolve')}; rigtest2.calib.panel().result` },
  { label: 'the pose that came out (truth: L 29.2,-46.4,179.1  R 31.4,47.9,180.6)', js: 'JSON.stringify(rigtest2.calib.cameras())' },
  { label: 'the angles now in use', js: 'JSON.stringify(rigtest2.calib.angles())' },
  { label: 'the readout line on the glass', js: "document.getElementById('readout').classList.remove('hidden'); 'shown'" },

  { label: 'prove it: start the hold check and stand 1.2 cm off the named spot', js: `${click('holdStart')}; 'started'` },
  { label: 'two seconds of samples', js: '(()=>{ for(let i=0;i<40;i++) rigtest2.calib.hold.feed([1.0, 40.4, 45.5], i*60); return rigtest2.calib.panel().hold; })()' },

  { label: 'revert to the typed angles with one button', js: `${click('calRevert')}; JSON.stringify(rigtest2.calib.angles())` },
  { label: 'and put the measurement back with one button', js: `${click('calUse')}; JSON.stringify(rigtest2.calib.angles())` },
  { label: 'it is saved with the rest of the setup', js: "JSON.parse(localStorage.getItem('holo-rigtest2')).pair.solved.left.rotDeg.join(',')" },

  { label: 'REFUSAL - the two cameras marked the wrong way round', js: `${click('calRevert')}; ${click('calClear')}; ${click('calStart')}; 'cleared'` },
  { label: 'feed a swapped session', js: gen({ swap: true }) },
  { label: 'solve it', js: `${click('calSolve')}; rigtest2.calib.panel().result` },
  { label: 'the typed angles are kept', js: 'JSON.stringify(rigtest2.calib.angles())' },

  { label: 'REFUSAL - a capture that never moved', js: `${click('calClear')}; ${click('calStart')}; 'cleared'` },
  { label: 'feed 40 frames of one pose', js: gen({ poses: ONE_SPOT }) },
  { label: 'the progress panel will not call that ready', js: 'JSON.stringify(rigtest2.calib.progress().ready) + " / missing: " + rigtest2.calib.progress().missing.join(", ")' },
  { label: 'solve it anyway', js: `${click('calSolve')}; rigtest2.calib.panel().result` },
  { label: 'still the typed angles', js: 'JSON.stringify(rigtest2.calib.angles())' },

  { label: 'forget the measurement', js: `window.confirm=()=>true; ${click('calForget')}; JSON.stringify(rigtest2.calib.status())` },
];

const out = process.argv[2];
if (out) { fs.writeFileSync(out, JSON.stringify(steps, null, 1)); console.log(`wrote ${steps.length} steps to ${out}`); }
