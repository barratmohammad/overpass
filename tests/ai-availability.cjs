const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createOverlayTracker} = require('../overlay-core.js');

const source = fs.readFileSync(require.resolve('../ai.js'), 'utf8');
const ctx = new Proxy({}, {get: () => () => {}});
const element = () => {
  const node = {hidden:false, textContent:'', classes:new Set(), setAttribute(){}, addEventListener(){}, remove(){},
    getContext:()=>ctx, toDataURL:()=> 'data:image/jpeg;base64,frame'};
  node.classList = {add:name=>node.classes.add(name), remove:name=>node.classes.delete(name), contains:name=>node.classes.has(name)};
  return node;
};
const video = () => ({isConnected:true, readyState:2, paused:false, videoWidth:640, videoHeight:480,
  requestVideoFrameCallback(fn){this.callback=fn;return 1;}, cancelVideoFrameCallback(){}});
const settle = async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

// Loads ai.js against a given location so the local and hosted branches can be compared directly.
function load(location){
  const timers = new Map(), nodes = new Map(), fetched = [];
  let next = 0, intervals = 0, frames = 0;
  const sandbox = {
    window:{CycloneOverlay:{createOverlayTracker}}, location,
    document:{hidden:false, createElement:element, querySelector:s=>{if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);}},
    crypto:{randomUUID:()=>String(++next)}, performance:{now:()=>100}, AbortSignal,
    setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;}, clearTimeout:id=>timers.delete(id),
    setInterval(){intervals++;}, requestAnimationFrame(){frames++;},
    fetch:async url => {
      fetched.push(url);
      if(url.endsWith('/api/health'))return {ok:true, json:async()=>({status:'ready', device:'mps'})};
      return {ok:true, json:async()=>({frames:[], inference_ms:10})};
    }
  };
  vm.runInNewContext(source, sandbox);
  return {sandbox, nodes, timers, fetched, counts:()=>({intervals, frames})};
}

const mount = build => {
  let appended = 0;
  const container = {id:'spotlight-media', append(){appended++;}, getBoundingClientRect:()=>({width:640, height:480})};
  const element = video();
  const handle = build.sandbox.window.CycloneAI.attach(container, element, {id:'one', stream:'source'});
  return {handle, element, appended:()=>appended};
};

(async()=>{
  // A hosted build must be inert: no processor to reach, so nothing is polled, scheduled, or drawn.
  const hosted = load({hostname:'overpass.vercel.app', protocol:'https:', port:''});
  await settle();
  assert.equal(hosted.fetched.length, 0, 'hosted build never contacts a processor');
  assert.equal(hosted.counts().intervals, 0, 'hosted build starts no health polling');
  assert.equal(hosted.counts().frames, 0, 'hosted build starts no paint loop');
  assert.equal(hosted.timers.size, 0, 'hosted build schedules no analysis cycle');

  const off = mount(hosted);
  assert.equal(off.appended(), 0, 'hosted build mounts no overlay canvas over the video');
  assert.equal(off.element.callback, undefined, 'hosted build registers no video frame callback');
  off.handle.state('LIVE');
  off.handle.dispose();
  await settle();
  assert.equal(hosted.fetched.length, 0, 'a live feed still triggers no request on a hosted build');

  const status = hosted.nodes.get('#ai-status'), toggle = hosted.nodes.get('#ai-toggle'), panel = hosted.nodes.get('.ai-panel');
  assert.match(status.textContent, /local processor/, 'the panel explains that analysis is local');
  assert.equal(toggle.hidden, true, 'the pause control is hidden, not disabled');
  assert.equal(panel.classes.has('unavailable'), true, 'the panel is styled as unavailable');
  console.log('PASS: a hosted build stands down without polling, scheduling, or mounting overlays.');

  // The local path must behave exactly as before.
  const local = load({hostname:'127.0.0.1', port:'4173'});
  await settle();
  assert(local.fetched.some(url => url.endsWith('/api/health')), 'local build probes the processor');
  assert.equal(local.counts().intervals, 1, 'local build polls health');
  assert.equal(local.counts().frames, 1, 'local build runs the paint loop');
  assert([...local.timers.values()].some(t => t.delay === 100), 'local build schedules the analysis cycle');

  const on = mount(local);
  assert.equal(on.appended(), 1, 'local build mounts the overlay canvas and label');
  assert.equal(typeof on.element.callback, 'function', 'local build registers a video frame callback');
  assert.equal(local.nodes.get('#ai-toggle').hidden, false, 'the pause control stays available locally');
  assert.equal(local.nodes.has('.ai-panel'), false, 'the panel is never restyled locally');
  console.log('PASS: a local build keeps polling, scheduling, and mounting overlays.');

  // A static server on another localhost port still reaches the service on 4173.
  const otherPort = load({hostname:'localhost', port:'8000'});
  await settle();
  assert(otherPort.fetched.some(url => url === 'http://127.0.0.1:4173/api/health'), 'another localhost port still reaches the processor');
  console.log('PASS: any localhost origin still reaches the processor on 4173.');
})().catch(error=>{console.error(error);process.exitCode=1;});
