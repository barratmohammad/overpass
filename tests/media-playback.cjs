const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app.js'),'utf8');
const start = source.indexOf('function mountMedia('), end = source.indexOf('\nasync function selectCamera',start);
const timers = new Map(), intervals = [], events = {}, states = [];
let id=0;
const badge = {classList:{toggle(){}}}, overlay = {hidden:false};
const video = {currentTime:0,setAttribute(){},addEventListener:(name,fn)=>events[name]=fn,canPlayType:()=>true,
  play:()=>Promise.resolve(),pause(){},removeAttribute(){},load(){},remove(){}};
const context = {window:{},document:{createElement:()=>video},inspectImage:()=> 'usable',streamHealth:new Map(),queueMicrotask,
  setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:key=>timers.delete(key),
  setInterval:fn=>{intervals.push(fn);return 1;},clearInterval(){}};
vm.runInNewContext(source.slice(start,end), context);
context.mountMedia({querySelector:s=>s==='.feed-badge'?badge:overlay,prepend(){}},{id:'camera',name:'test',stream:'https://example.com/video'},s=>states.push(s));
const fire = ms=>{const pair=[...timers.entries()].find(([,t])=>t.ms===ms);assert(pair,`timer ${ms}`);timers.delete(pair[0]);pair[1].fn();};
events.playing();video.currentTime=1;fire(800);
assert.equal(states.at(-1),'LIVE');
events.waiting();
assert.equal(states.at(-1),'LIVE','short segment gap does not flash reconnecting');
assert.equal(overlay.hidden,true);
events.playing();
assert(![...timers.values()].some(t=>t.ms===700),'resuming cancels buffering indicator');
assert(![...timers.values()].some(t=>t.ms===800),'verified playback resumes without another startup delay');
intervals[0]();
assert.equal(states.at(-1),'LIVE','one unchanged watchdog sample does not toggle verification');
events.waiting();fire(700);
assert.equal(states.at(-1),'BUFFERING','sustained stalls still report buffering');
events.playing();assert.equal(states.at(-1),'LIVE');assert.equal(overlay.hidden,true);
console.log('PASS: brief buffering does not flash, sustained buffering reports, verified playback resumes immediately.');
