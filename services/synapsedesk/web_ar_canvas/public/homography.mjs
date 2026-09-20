// Four non-collinear camera/projector correspondences; normalized coordinates.
export function solveHomography(source, target) {
  if (source.length !== 4 || target.length !== 4 || ![...source,...target].every(p =>
      Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) throw Error('Four finite coordinate pairs required');
  const rows = [];
  for (let i=0; i<4; i++) {
    const [x,y] = source[i], [u,v] = target[i];
    rows.push([x,y,1,0,0,0,-u*x,-u*y,u], [0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  for (let col=0; col<8; col++) {
    let pivot=col;
    for (let r=col+1;r<8;r++) if(Math.abs(rows[r][col])>Math.abs(rows[pivot][col])) pivot=r;
    if(Math.abs(rows[pivot][col])<1e-9) throw Error('Degenerate calibration: spread the four points apart');
    [rows[col],rows[pivot]]=[rows[pivot],rows[col]];
    const divisor=rows[col][col];
    rows[col]=rows[col].map(v=>v/divisor);
    for(let r=0;r<8;r++) if(r!==col) {
      const factor=rows[r][col];
      rows[r]=rows[r].map((v,c)=>v-factor*rows[col][c]);
    }
  }
  const h=rows.map(r=>r[8]).concat(1);
  const det=h[0]*(h[4]*h[8]-h[5]*h[7])-h[1]*(h[3]*h[8]-h[5]*h[6])+h[2]*(h[3]*h[7]-h[4]*h[6]);
  if(Math.abs(det)<1e-9) throw Error('Singular calibration');
  return h;
}
export function project(h,x,y) {
  const w=h[6]*x+h[7]*y+h[8];
  if(!Number.isFinite(w)||Math.abs(w)<1e-8) return null;
  const p=[(h[0]*x+h[1]*y+h[2])/w,(h[3]*x+h[4]*y+h[5])/w];
  return p.every(Number.isFinite)?p:null;
}
export const IDENTITY=[1,0,0,0,1,0,0,0,1];
