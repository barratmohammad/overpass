'use strict';
const FEED_URL = 'https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const CACHE_KEY = 'cyclone-directory-v2';
const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeURL = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let cameras = [], filtered = [], map, markerLayer, dotRenderer, selectedMarker, selectedCamera;
let wallDisposers = [], spotlightDisposer, rotateOffset = 0, loadedAt, toastTimer;
const markers = new Map();
function normalizeDirectory(data) {
  return (Array.isArray(data?.data) ? data.data : []).map(row => row.cctv).filter(c => c && String(c.inService).toLowerCase() === 'true').map(c => ({
    id: String(c.index), name: (c.location?.locationName || 'Unnamed camera').replace(/^[A-Z0-9]+\s*--\s*/, ''),
    route: c.location?.route || 'Road camera', county: c.location?.county || 'Unknown', place: c.location?.nearbyPlace || 'Bay Area',
    lat: Number(c.location?.latitude), lon: Number(c.location?.longitude),
    stream: safeURL(c.imageData?.streamingVideoURL)
  })).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.lat !== 0);
}
function showToast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}
function tickClock() { $('#clock').textContent = new Date().toISOString().slice(11,19) + ' UTC'; }
tickClock(); setInterval(tickClock,1000);
function initMap() {
  if (!window.L) { $('#map-message').hidden = false; $('#reset-map').disabled = true; return; }
  map = L.map('map', { zoomControl:false, scrollWheelZoom:false, preferCanvas:true }).setView([37.79,-122.16],9);
  L.control.zoom({position:'bottomright'}).addTo(map);
  const tiles = L.tileLayer(TILE_URL, {maxZoom:19, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://www.openstreetmap.org/fixthemap">Report an issue</a>'}).addTo(map);
  let tileErrors=0;
  tiles.on('tileerror', () => { if (++tileErrors >= 4) $('#map-message').hidden = false; });
  tiles.on('tileload', () => { tileErrors=0; $('#map-message').hidden = true; });
  markerLayer = L.layerGroup().addTo(map);
  // Camera dots render as SVG so CSS can pulse them; everything else stays on canvas.
  dotRenderer = L.svg({padding: .5});
  new ResizeObserver(() => map.invalidateSize()).observe($('#map'));
}
function plotMarkers() {
  if (!map) return;
  markerLayer.clearLayers(); markers.clear(); selectedMarker = null;
  filtered.forEach((camera, index) => {
    const marker = L.circleMarker([camera.lat,camera.lon], {radius:3.5,weight:1,color:'#91e8f7',fillColor:'#22d3ee',fillOpacity:.78,renderer:dotRenderer,className:'camera-dot'});
    const tooltip = document.createElement('span'); tooltip.textContent = camera.name;
    marker.bindTooltip(tooltip, {direction:'top'}).on('click', () => selectCamera(camera));
    marker.addTo(markerLayer); markers.set(camera.id,marker);
    // Stagger the pulse so the network breathes instead of blinking in unison.
    marker.getElement()?.style.setProperty('animation-delay', `${-(index % 24) * .1}s`);
  });
  if (selectedCamera) highlightMarker(selectedCamera);
}
function highlightMarker(camera) {
  if (selectedMarker) { selectedMarker.setStyle({radius:3.5,weight:1,color:'#91e8f7',fillColor:'#22d3ee',fillOpacity:.78}); selectedMarker.getElement()?.classList.remove('selected'); }
  selectedMarker = markers.get(camera.id);
  if (selectedMarker) { selectedMarker.setStyle({radius:7,weight:3,color:'#22d3ee',fillColor:'#ffffff',fillOpacity:1}).bringToFront(); selectedMarker.getElement()?.classList.add('selected'); }
}

// Match the provider's known outage graphic, excluding its changing timestamp strip.
const OUTAGE_SIGNATURE = Uint8Array.from(atob('///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+4dXs/v7///////////7////y6vL+/v////////////29cbvG0rzA1sDQ1MbSxcXPwrKiqNvZ/v///////////+qPhXJ/gYGIg359jniohHJ9oY6UebX/////////////8LC2ma+2tZ50o6earc+Qk67Jrr9y3v/////////////8+vr7/Pz87NH8/fr5+vv6+Pz55Lz6/////////////83Tsefs9uvx9fHr5b247+yw6MTd7Pz/////////////tb2LiIaseJWcpIGSlJCZg3WLi5J2z//////////////GioiSpYlupHCvc3+Sj4J0fIuKiHjQ//////////////jY5ufq5Nfs4/HY4Obm3tzd3enr2vb////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////7'), c => c.charCodeAt(0));
let wallGeneration = 0, wallController, wallCards = new Map(), selectionGeneration = 0;
function classifyPixels(pixels) {
  let difference=0, brightness=0, dark=0;
  const center=[];
  for(let i=0;i<OUTAGE_SIGNATURE.length;i++){
    const offset=i*4, luminance=.299*pixels[offset]+.587*pixels[offset+1]+.114*pixels[offset+2];
    difference+=Math.abs(luminance-OUTAGE_SIGNATURE[i]);brightness+=luminance;
    if(luminance<5)dark++;
    // Ignore source timestamps and corner labels: they can animate over a dead scene.
    const x=i%32,y=Math.floor(i/32);
    if(x>=3&&x<29&&y>=5&&y<22)center.push(luminance);
  }
  if(difference/OUTAGE_SIGNATURE.length<22) return 'unavailable';
  if(dark/OUTAGE_SIGNATURE.length>.985 || brightness/OUTAGE_SIGNATURE.length>250) return 'blank';
  const mean=center.reduce((sum,value)=>sum+value,0)/center.length;
  const variance=center.reduce((sum,value)=>sum+(value-mean)**2,0)/center.length;
  const sorted=center.sort((a,b)=>a-b);
  const spread=sorted[Math.floor(sorted.length*.95)]-sorted[Math.floor(sorted.length*.05)];
  // The provider's gray video failure frame is RGB(32,32,32), not near-black.
  // Reject low-detail solid colors/gradients of any brightness, including timestamp noise.
  if(variance<16 || spread<12)return 'blank';
  return 'usable';
}
function inspectImage(source) {
  try{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const width=source.videoWidth||source.naturalWidth, height=source.videoHeight||source.naturalHeight;
    if(!width||!height)return 'unverified';
    ctx.drawImage(source,0,0,width,Math.round(height*.88),0,0,32,24);
    return classifyPixels(ctx.getImageData(0,0,32,24).data);
  }catch{return 'unverified';}
}
// Live-video availability is independent of the provider's still-image service.
const streamHealth = new Map();
async function verifyStream(camera,signal) {
  if(!camera.stream || signal?.aborted)return false;
  const cached=streamHealth.get(camera.id);
  if(cached && (Date.now()-cached.checkedAt<30000 || Date.now()<(cached.retryAfter||0)))return cached.ok;
  const controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,3500);
  try{
    const response=await fetch(camera.stream,{signal:controller.signal});
    const ok=response.ok && (await response.text()).trimStart().startsWith('#EXTM3U');
    if(!signal?.aborted)streamHealth.set(camera.id,{ok,checkedAt:Date.now()});return ok;
  }catch{if(!signal?.aborted)streamHealth.set(camera.id,{ok:false,checkedAt:Date.now()});return false;}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
// Video-only player. Failed streams are replaced; no still-image paths are mounted.
function mountMedia(container,camera,onStatus=()=>{}) {
  let disposed=false,hls,timeout,frameTimer,bufferTimer,watchdog,analytics,active=true,lastTime=-1,verified=false;
  container.innerHTML='<div class="media-state"><svg><use href="#i-camera"/></svg>Connecting to live video…</div><span class="feed-badge">CONNECTING</span>';
  const badge=container.querySelector('.feed-badge'),overlay=container.querySelector('.media-state');
  const status=label=>{if(!disposed){badge.textContent=label;badge.classList.toggle('live',label==='LIVE');analytics?.state(label);onStatus(label);}};
  const video=document.createElement('video');
  video.muted=true;video.autoplay=true;video.playsInline=true;video.crossOrigin='anonymous';
  video.setAttribute('playsinline','');video.setAttribute('aria-label',camera.name+' live video');
  // Keep the element rendered during startup so browser autoplay can proceed.
  container.prepend(video);
  analytics=window.CycloneAI?.attach(container,video,camera);
  const stop=()=>{
    active=false;analytics?.dispose();clearTimeout(timeout);clearTimeout(frameTimer);clearTimeout(bufferTimer);clearInterval(watchdog);
    if(hls){hls.destroy();hls=null;}video.pause();video.removeAttribute('src');video.load();video.remove();
  };
  const fail=()=>{
    if(disposed||!active)return;stop();
    streamHealth.set(camera.id,{ok:false,checkedAt:Date.now(),retryAfter:Date.now()+300000});
    overlay.hidden=false;overlay.innerHTML='<svg><use href="#i-camera"/></svg>Finding another live stream…';
    status('UNAVAILABLE');
  };
  const confirmVideo=()=>{
    if(disposed||!active)return;
    const quality=inspectImage(video);
    if(quality==='blank'||quality==='unavailable'){fail();return;}
    if(verified&&quality==='usable'&&video.currentTime<=lastTime){
      if(!timeout)timeout=setTimeout(fail,12000);
      return;
    }
    if(quality!=='usable'||video.currentTime<=lastTime){
      overlay.hidden=false;overlay.textContent='Verifying live video…';status('VERIFYING');
      if(!timeout)timeout=setTimeout(fail,5000);
      return;
    }
    clearTimeout(timeout);clearTimeout(bufferTimer);timeout=null;lastTime=video.currentTime;verified=true;
    streamHealth.set(camera.id,{ok:true,checkedAt:Date.now()});overlay.hidden=true;status('LIVE');
  };
  video.addEventListener('playing',()=>{
    if(disposed||!active)return;
    clearTimeout(timeout);timeout=null;clearTimeout(frameTimer);clearTimeout(bufferTimer);
    if(verified){overlay.hidden=true;status('LIVE');return;}
    lastTime=video.currentTime;
    frameTimer=setTimeout(()=>{confirmVideo();if(active){clearInterval(watchdog);watchdog=setInterval(confirmVideo,2000);}},800);
  });
  video.addEventListener('error',fail);
  video.addEventListener('waiting',()=>{
    if(disposed||!active)return;
    // HLS can briefly run out of decoded frames between segments. Avoid flashing a full-screen state.
    clearTimeout(bufferTimer);
    bufferTimer=setTimeout(()=>{
      if(disposed||!active)return;
      overlay.hidden=false;overlay.textContent='Reconnecting live video…';status('BUFFERING');
    },700);
    if(!timeout)timeout=setTimeout(fail,12000);
  });
  const play=()=>video.play().catch(fail);
  timeout=setTimeout(fail,18000);
  if(!camera.stream || streamHealth.get(camera.id)?.ok===false)queueMicrotask(fail);
  else if(window.Hls?.isSupported()){
    hls=new Hls({maxBufferLength:8,maxMaxBufferLength:16,manifestLoadingTimeOut:9000,manifestLoadingMaxRetry:2,levelLoadingMaxRetry:2});
    hls.on(Hls.Events.MANIFEST_PARSED,play);hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal)fail();});
    hls.loadSource(camera.stream);hls.attachMedia(video);
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=camera.stream;play();}
  else queueMicrotask(fail);
  return ()=>{disposed=true;stop();};
}

async function selectCamera(camera, focusMap=false) {
  const generation=++selectionGeneration;
  const evidence=await verifyStream(camera);
  if(generation!==selectionGeneration)return;
  if(!evidence){showToast('This live stream is unavailable. Keeping the current video.');return;}
  selectedCamera=camera;
  if(spotlightDisposer) spotlightDisposer();
  $('#selected-route').textContent=camera.route;
  $('#selected-place').textContent=camera.place.toUpperCase();
  $('#selected-name').textContent=camera.name;
  $('#selected-coords').textContent=`${camera.lat.toFixed(4)}, ${camera.lon.toFixed(4)}`;
  spotlightDisposer=mountMedia($('#spotlight-media'),camera,label=>{
    $('#selected-status').textContent=label==='LIVE'?'Live video':label==='UNAVAILABLE'?'Finding another live stream':label;
    if(label==='UNAVAILABLE'){
      selectedCamera=null;
      const next=[...wallCards.values()].find(entry=>entry.camera.id!==camera.id && entry.state==='LIVE');
      if(next)selectCamera(next.camera);
    }
  });
  highlightMarker(camera);
  document.querySelectorAll('.camera-card').forEach(card=>{const selected=card.dataset.id===camera.id;card.classList.toggle('selected',selected);card.setAttribute('aria-pressed',String(selected));});
  if(focusMap){if(map)map.setView([camera.lat,camera.lon],11,{animate:!reducedMotion});$('#overview').scrollIntoView({behavior:reducedMotion?'instant':'smooth'});}
}
async function renderWall() {
  const generation=++wallGeneration;
  wallController?.abort();wallController=new AbortController();const signal=wallController.signal;
  wallDisposers.forEach(dispose=>dispose());wallDisposers=[];wallCards=new Map();
  const grid=$('#wall-grid');grid.replaceChildren();
  $('#result-count').textContent=filtered.length;
  $('#shuffle').disabled=true;
  if(!filtered.length){
    grid.innerHTML='<div class="empty"><p>No cameras found.</p><span>Try another road, location, or county.</span><br><button class="button" id="clear-filters">Clear filters</button></div>';
    $('#clear-filters').addEventListener('click',()=>{$('#camera-search').value='';$('#county-filter').value='';applyFilters();});
    $('#wall-status').textContent='0 cameras';return;
  }
  const loading=document.createElement('div');loading.className='empty verification-message';loading.innerHTML='<p>ACQUIRING VERIFIED FEEDS</p><span>Finding live video streams and skipping offline sources.</span>';grid.append(loading);
  const ordered=Array.from({length:filtered.length},(_,i)=>filtered[(rotateOffset+i)%filtered.length]);
  const candidates=ordered.filter(camera=>camera.stream);
  const wanted=Math.min(9,filtered.length);let index=0,checked=0,scanning=true,refilling=false;
  const states=new Map(),reserves=[];
  const current=()=>generation===wallGeneration&&!signal.aborted;
  const updateStatus=()=>{
    if(!current())return;
    const live=[...states.values()].filter(s=>s==='LIVE').length;
    if(wallCards.size>=wanted)$('#shuffle').disabled=filtered.length<=wanted;
    $('#wall-status').textContent=scanning&&wallCards.size<wanted?`Checking ${checked} sources · ${live} live`:`${live} live${wallCards.size>live?' · '+(wallCards.size-live)+' connecting':''}`;
  };
  const addCard=camera=>{
    if(!current()||wallCards.has(camera.id))return;
    loading.remove();
    const card=document.createElement('button');card.type='button';card.className='camera-card';card.dataset.id=camera.id;
    card.setAttribute('aria-label',`Inspect ${camera.name}, ${camera.county} County`);card.setAttribute('aria-pressed',String(selectedCamera?.id===camera.id));card.classList.toggle('selected',selectedCamera?.id===camera.id);
    card.innerHTML=`<div class="camera-media"></div><div class="camera-meta"><div><h3>${escapeHTML(camera.name)}</h3><p>${escapeHTML(camera.place)} · ${escapeHTML(camera.county)}</p></div><svg><use href="#i-arrow"/></svg></div>`;
    card.addEventListener('click',()=>selectCamera(camera,true));grid.append(card);
    const entry={camera,card,dispose:null,state:'CONNECTING'};wallCards.set(camera.id,entry);
    entry.dispose=mountMedia(card.querySelector('.camera-media'),camera,label=>{
      if(!current())return;
      states.set(camera.id,label);entry.state=label;
      if(label==='LIVE'&&!selectedCamera)selectCamera(camera);
      if(label==='UNAVAILABLE'){
        queueMicrotask(()=>{
          if(!current()||wallCards.get(camera.id)!==entry)return;
          entry.dispose?.();card.remove();wallCards.delete(camera.id);states.delete(camera.id);updateStatus();refill();
        });
      }
      updateStatus();
    });
    wallDisposers.push(entry.dispose);
    const route=document.createElement('span');route.className='feed-route';route.textContent=camera.route;card.querySelector('.camera-media').append(route);
    updateStatus();
  };
  const nextVerified=async()=>{
    while(current() && index<candidates.length){
      const camera=candidates[index++];
      if(wallCards.has(camera.id)||reserves.some(c=>c.id===camera.id))continue;
      const evidence=await verifyStream(camera,signal);checked++;updateStatus();
      if(!current())return null;
      if(evidence)return camera;
    }
    return null;
  };
  const finishScan=()=>{
    if(!current())return;
    scanning=false;updateStatus();$('#shuffle').disabled=filtered.length<=wanted;
    if(!wallCards.size){
      loading.innerHTML='<p>No live streams available.</p><span>The selected sources are offline. Try a different county or rotate cameras to check again.</span>';grid.append(loading);if(!selectedCamera){$('#spotlight-media').innerHTML='<div class="media-state">No live video available.<small>Try another county or check your connection.</small></div>';$('#selected-status').textContent='No live stream';}
    }
    try{localStorage.setItem('cyclone-healthy-ids',JSON.stringify([...wallCards.keys(),...reserves.map(c=>c.id)]));}catch{}
  };
  const refill=async()=>{
    if(refilling||!current())return;refilling=true;scanning=true;
    while(current()&&wallCards.size<wanted){
      let camera=reserves.shift();
      if(camera && !(await verifyStream(camera,signal)))continue;
      if(!camera)camera=await nextVerified();
      if(!camera)break;addCard(camera);
    }
    refilling=false;finishScan();
  };
  const worker=async()=>{
    while(current()&&(wallCards.size<wanted||(reserves.length<6&&checked<wanted*3))){
      const camera=await nextVerified();if(!camera)return;
      if(wallCards.size<wanted)addCard(camera);else reserves.push(camera);
    }
  };
  await Promise.all(Array.from({length:6},worker));finishScan();
}
function applyFilters() {
  const query=$('#camera-search').value.trim().toLowerCase(),county=$('#county-filter').value;
  filtered=cameras.filter(c=>(!county || c.county===county) && `${c.name} ${c.route} ${c.place} ${c.county}`.toLowerCase().includes(query));
  rotateOffset=0;plotMarkers();renderWall();
}
function useDirectory(list,cached=false,date=new Date().toISOString()) {
  cameras=list.filter(camera=>camera.stream);filtered=cameras;loadedAt=date;
  $('#camera-count').textContent=list.length.toLocaleString();
  $('#county-count').textContent=new Set(list.map(c=>c.county).filter(c=>c!=='Unknown')).size;
  $('#video-count').textContent=list.filter(c=>c.stream).length.toLocaleString();
  $('#directory-status').textContent=cached?'Saved directory · connection unavailable':'Directory connected';
  $('#directory-dot').style.background=cached?'#f59e0b':'var(--accent)';
  $('#refresh-time').textContent=new Date(date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
  $('#refresh-note').textContent=cached?`Saved ${new Date(date).toLocaleDateString()}`:'Local time · refreshed on page load';
  if(cached){$('#camera-count').closest('.metric').querySelector('.metric-label').firstChild.textContent='Saved camera directory';}
  [...new Set(cameras.map(c=>c.county))].sort().forEach(county=>{const option=new Option(county,county);$('#county-filter').add(option);});
  // Distribute the initial view across counties instead of showing a single road corridor.
  const groups=new Map();cameras.forEach(c=>{if(!groups.has(c.county))groups.set(c.county,[]);groups.get(c.county).push(c);});
  const ordered=[];while(ordered.length<cameras.length)for(const group of groups.values()){if(group.length)ordered.push(group.shift());}
  let preferred=[];try{preferred=JSON.parse(localStorage.getItem('cyclone-healthy-ids'))||[];}catch{}
  const ranks=new Map(preferred.map((id,i)=>[id,i]));
  ordered.sort((a,b)=>(ranks.get(a.id)??Infinity)-(ranks.get(b.id)??Infinity));
  cameras=ordered;filtered=ordered;plotMarkers();renderWall();
}
async function boot() {
  try{initMap();}catch(error){$('#map-message').hidden=false;console.warn('Map could not start',error);}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(FEED_URL,{signal:controller.signal});
    if(!response.ok)throw new Error(`Directory HTTP ${response.status}`);
    const list=normalizeDirectory(await response.json());
    if(!list.length)throw new Error('Directory contained no valid cameras');
    const date=new Date().toISOString();
    try{localStorage.setItem(CACHE_KEY,JSON.stringify({list,date}));}catch{/* Storage is optional. */}
    useDirectory(list,false,date);
  }catch(error){
    let cached;try{cached=JSON.parse(localStorage.getItem(CACHE_KEY));}catch{/* No valid saved directory. */}
    if(Array.isArray(cached?.list) && cached.list.length && Number.isFinite(Date.parse(cached.date))){useDirectory(cached.list,true,cached.date);}
    else{
      $('#directory-status').textContent='Directory unavailable';$('#refresh-note').textContent='Could not connect to camera network';
      $('#wall-status').textContent='Connection unavailable';$('#selected-status').textContent='Offline';
      $('#spotlight-media').innerHTML='<div class="media-state">Camera directory unavailable.<small>Check your connection and retry.</small></div>';
      $('#wall-grid').innerHTML='<div class="empty"><p>We couldn’t reach the camera network.</p><span>Check your connection, then try again.</span><br><button class="button" id="retry">Retry connection</button></div>';
      $('#retry').addEventListener('click',()=>location.reload());$('#shuffle').disabled=true;
    }
    console.warn('Camera directory unavailable',error);
  }finally{clearTimeout(timeout);}
}
$('#shuffle').addEventListener('click',()=>{rotateOffset=(rotateOffset+9)%Math.max(1,filtered.length);renderWall();});
let filterTimer;
$('#camera-search').addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(applyFilters,250);});
$('#county-filter').addEventListener('change',applyFilters);
$('#reset-map').addEventListener('click',()=>map?.setView([37.79,-122.16],9,{animate:!reducedMotion}));
function setPresenting(active){document.body.classList.toggle('presenting',active);$('#present span').textContent=active?'Exit presentation':'Present view';$('#present').setAttribute('aria-pressed',String(active));setTimeout(()=>map?.invalidateSize(),50);}
$('#present').addEventListener('click',async()=>{
  if(document.body.classList.contains('presenting')){setPresenting(false);if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});return;}
  setPresenting(true);$('#overview').scrollIntoView({behavior:'instant'});
  if(document.documentElement.requestFullscreen){try{await document.documentElement.requestFullscreen();}catch{showToast('Presentation layout enabled. Press Esc to exit.');}}
  else showToast('Presentation layout enabled. Press Esc to exit.');
});
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)setPresenting(false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape')setPresenting(false);});
const sectionObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){document.querySelectorAll('nav .nav-link').forEach(link=>link.classList.toggle('active',link.hash==='#'+entry.target.id));}},{rootMargin:'-10% 0px -65% 0px'});
['overview','wall','capabilities'].forEach(id=>sectionObserver.observe(document.getElementById(id)));
window.addEventListener('pagehide',()=>{wallController?.abort();wallDisposers.forEach(dispose=>dispose());spotlightDisposer?.();});
boot();
