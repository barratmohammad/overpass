const assert=require('node:assert/strict');
const {createOverlayTracker}=require('../overlay-core.js');
const det=(id,box,extra={})=>({id,label:'car',box,velocity:[0,0],hits:3,...extra});
const near=(a,b,eps=1e-6)=>Math.abs(a-b)<eps;

// Boxes are extrapolated by velocity to the presented frame, bounded by the horizon.
let tracker=createOverlayTracker({coast:5});
tracker.present(1);
tracker.update({timestamp:1,tracks:[det(1,[.1,.1,.2,.2],{velocity:[.1,0]})]});
let out=tracker.render(1.1,0);
assert.equal(out.length,1);assert(near(out[0].box[0],.11)&&near(out[0].box[2],.21),'box moves by velocity x elapsed media time');
assert.equal(out[0].coasting,true);
out=tracker.render(2,16);assert(near(out[0].box[0],.1+.1*.6),'extrapolation stops at the horizon');

// A first sighting moves by whatever velocity the backend gives it (the local flow), or stays put without one.
tracker=createOverlayTracker();tracker.present(1);
tracker.update({timestamp:1,tracks:[det(1,[.1,.1,.2,.2],{velocity:[0,0],hits:1}),det(2,[.5,.5,.6,.6],{velocity:[.5,0],hits:1})]});
assert(near(tracker.render(1.1,0)[0].box[0],.1),'a first sighting without velocity is not extrapolated');
assert(near(tracker.render(1.1,0)[1].box[0],.55),'a first sighting with a flow velocity is extrapolated');
tracker.update({timestamp:1.1,tracks:[det(1,[.15,.1,.25,.2],{velocity:[.5,0],hits:2})]});
let x=tracker.render(1.2,16)[0].box[0];assert(x>.1&&x<.2,'the jump to the new prediction eases in');
assert(near(tracker.render(1.2,600)[0].box[0],.2,1e-3),'a track seen twice is extrapolated');

// Corrections ease in without overshoot; new IDs appear exactly at their detection.
tracker=createOverlayTracker();tracker.present(1);
tracker.update({timestamp:1,tracks:[det(1,[.1,.1,.2,.2])]});
assert(near(tracker.render(1,0)[0].box[0],.1),'new track appears at its detection');
tracker.update({timestamp:1.1,tracks:[det(1,[.2,.1,.3,.2]),det(2,[.5,.5,.6,.6])]});
let previous=.1,wall=0;
for(let i=0;i<60;i++){wall+=16;const boxes=tracker.render(1.1,wall);const x=boxes.find(b=>b.id===1).box[0];assert(x>=previous-1e-9&&x<=.2+1e-9,'eases monotonically toward the correction');previous=x;if(i===0)assert(near(boxes.find(b=>b.id===2).box[0],.5),'second track starts at its detection');}
assert(near(previous,.2,1e-3),'converges within a second of wall time');
assert(near(tracker.render(1.1,wall+500)[0].box[0],tracker.render(1.1,wall+900)[0].box[0]),'a paused video keeps boxes still');

// Missed detections coast briefly, then drop.
tracker.update({timestamp:1.2,tracks:[det(2,[.5,.5,.6,.6])]});
out=tracker.render(1.2,wall+1000);
assert.deepEqual(out.map(b=>[b.id,b.coasting]).sort(),[[1,true],[2,false]],'missing track coasts');
out=tracker.render(1.45,wall+1400);
assert.deepEqual(out.map(b=>b.id),[2],'coasting track drops after the limit');

// Out-of-order results are ignored; seeks and stalls reset.
assert.equal(tracker.update({timestamp:1.15,tracks:[det(9,[0,0,.1,.1])]}),false,'older result ignored');
assert.equal(tracker.size(),1);
tracker.present(1.6);assert.equal(tracker.present(3),false,'1.4 s ahead is normal playback');assert.equal(tracker.present(3.02),false);
assert.equal(tracker.present(.5),true,'backwards media time resets');assert.equal(tracker.size(),0);
tracker.update({timestamp:.5,tracks:[det(1,[.1,.1,.2,.2])]});
assert.equal(tracker.present(2.1),true,'a gap over 1.5 s resets');assert.equal(tracker.size(),0);
console.log('PASS: boxes follow velocity to the presented frame, ease into corrections, coast briefly, reset on seeks.');

// A fast foreground car must not freeze while inference catches up.
tracker=createOverlayTracker();tracker.present(1);
tracker.update({timestamp:1,tracks:[det(1,[.1,.1,.14,.14],{velocity:[1.3,0]})]});
assert(near(tracker.render(1.1,0)[0].box[0],.23),'fast vehicle advances to the displayed frame');

// A corrected distant car stays within a fifth of its box size, even on first velocity acquisition.
tracker=createOverlayTracker();tracker.present(1);
tracker.update({timestamp:1,tracks:[det(1,[.1,.1,.12,.12],{hits:1})]});
tracker.render(1,0);
tracker.update({timestamp:1.1,tracks:[det(1,[.15,.1,.17,.12],{velocity:[.5,0],hits:2})]});
out=tracker.render(1.2,16);
assert(Math.abs(out[0].box[0]-.2)<=.004,'correction cannot leave the box behind the car');

// Multiple detections between paints must not accumulate an unbounded visual lag.
tracker.update({timestamp:1.2,tracks:[det(1,[.22,.1,.24,.12],{velocity:[.7,0]})]});
tracker.update({timestamp:1.3,tracks:[det(1,[.30,.1,.32,.12],{velocity:[.8,0]})]});
out=tracker.render(1.4,32);
assert(Math.abs(out[0].box[0]-.38)<=.004,'batched corrections remain attached to the car');
console.log('PASS: fast cars keep moving and corrections stay within the vehicle box.');
