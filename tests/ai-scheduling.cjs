const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createOverlayTracker} = require('../overlay-core.js');
const timers = new Map(), requests = [];
let next = 0;
const ctx = new Proxy({}, {get: () => () => {}});
const element = () => ({hidden:false, textContent:'', setAttribute(){}, addEventListener(){}, remove(){},
  getContext:()=>ctx, toDataURL:()=> 'data:image/jpeg;base64,frame'});
const nodes = new Map();
const sandbox = {
  window:{CycloneOverlay:{createOverlayTracker}}, location:{hostname:'127.0.0.1',port:'4173'},
  document:{hidden:false, createElement:element, querySelector:s=>{if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);}},
  crypto:{randomUUID:()=>String(++next)}, performance:{now:()=>100}, AbortSignal,
  setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;}, clearTimeout:id=>timers.delete(id),
  setInterval(){}, requestAnimationFrame(){},
  fetch:async (url, options)=> {
    if(url.endsWith('/api/health'))return {ok:true,json:async()=>({status:'ready',device:'mps'})};
    requests.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({frames:[],inference_ms:10})};
  }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../ai.js'),'utf8'), sandbox);
const video = () => ({isConnected:true,readyState:2,paused:false,videoWidth:640,videoHeight:480,
  requestVideoFrameCallback(fn){this.callback=fn;return 1;},cancelVideoFrameCallback(){}});
const container = id => ({id,append(){},getBoundingClientRect:()=>({width:640,height:480})});
const settle = async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
(async()=>{
  await settle();
  const moving=video(), stalled=video();
  const first=sandbox.window.CycloneAI.attach(container('spotlight-media'),moving,{id:'one',stream:'source'});
  const second=sandbox.window.CycloneAI.attach(container('tile'),stalled,{id:'two',stream:'source'});
  first.state('LIVE');second.state('LIVE');
  moving.callback(100,{mediaTime:1.25});
  // The second feed never presents a frame. It must not hold the first feed's request.
  let scheduled=[...timers.entries()].find(([,t])=>t.delay===100);
  assert(scheduled,'analysis cycle scheduled');timers.delete(scheduled[0]);scheduled[1].fn();
  await settle();
  assert.equal(requests.length,1,'ready snapshot is sent without waiting for another video frame');
  assert.equal(requests[0].frames.length,1,'stalled feed does not block a ready feed');
  assert.equal(requests[0].frames[0].timestamp,1.25,'timestamp matches captured pixels');
  assert(![...timers.values()].some(t=>t.delay===500),'no half-second frame barrier');
  console.log('PASS: synchronized snapshots are sent immediately, independent of stalled feeds.');
})().catch(error=>{console.error(error);process.exitCode=1;});
