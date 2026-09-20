import test from 'node:test';
import assert from 'node:assert/strict';
import {solveHomography,project} from '../web_ar_canvas/public/homography.mjs';
const source=[[0,0],[1,0],[1,1],[0,1]];
function near(a,b){assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);}
test('identity and interior projection',()=>{const h=solveHomography(source,source);const p=project(h,.4,.6);near(p[0],.4);near(p[1],.6);});
test('perspective calibration maps all four points',()=>{const target=[[.1,.2],[.85,.1],[.95,.95],[.05,.8]];const h=solveHomography(source,target);source.forEach((p,i)=>project(h,...p).forEach((v,j)=>near(v,target[i][j])));});
test('reject collinear and nonfinite input',()=>{assert.throws(()=>solveHomography([[0,0],[.3,0],[.6,0],[1,0]],source));assert.throws(()=>solveHomography([[NaN,0],...source.slice(1)],source));});
test('points on homography horizon cannot enter canvas',()=>{assert.equal(project([1,0,0,0,1,0,1,0,-1],1,.5),null);});
