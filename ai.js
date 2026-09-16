/* Local, camera-isolated vehicle tracking over the existing live video elements. */
window.CycloneAI = (() => {
  const {createOverlayTracker} = window.CycloneOverlay;
  const entries = new Map();
  let enabled = true, ready = false, lastError = '', device = '', perImageMs = 12, overheadMs = 20;
  const completed = [], recent = {perImage:[], overhead:[]};
  const median = values => [...values].sort((a, b) => a-b)[Math.floor(values.length/2)];
  let roundTrip = 0, cycleTimer = null;
  // A hosted build has no local processor to reach, so the AI layer stands down instead of failing loudly.
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '']);
  const api = LOCAL_HOSTS.has(location.hostname) ? (location.port === '4173' || location.port === '4174' ? '' : 'http://127.0.0.1:4173') : null;
  const $ = selector => document.querySelector(selector);
  const post = async (path, body, signal) => {
    const response = await fetch(api + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal});
    const data = await response.json();
    if(!response.ok)throw new Error(typeof data.detail === 'string' ? data.detail : 'Vehicle analysis failed.');
    return data;
  };
  const encode = canvas => new Promise((resolve, reject) => {
    if(!canvas.toBlob){resolve(canvas.toDataURL('image/jpeg',.8));return;}
    canvas.toBlob(blob => {
      if(!blob){resolve(canvas.toDataURL('image/jpeg',.8));return;}
      const reader = new FileReader();reader.onload = () => resolve(reader.result);reader.onerror = () => reject(reader.error);reader.readAsDataURL(blob);
    }, 'image/jpeg', .8);
  });
  // Keep the newest pixels with their exact presented-frame timestamp. Encoding is only done for selected feeds.
  function capture(entry, timestamp){
    const {video} = entry, canvas = entry.captureCanvas;
    const width = Math.min(640, video.videoWidth), height = Math.round(width*video.videoHeight/video.videoWidth);
    if(canvas.width !== width || canvas.height !== height){canvas.width = width;canvas.height = height;}
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    entry.captureTime = timestamp;
  }
  // Tile labels appear only once there is something to say; an idle or disconnected feed shows nothing.
  function say(entry, text){entry.label.textContent = text;entry.label.hidden = false;}
  function clear(entry){
    entry.generation++;entry.captureTime = undefined;entry.result = null;entry.receivedAt = 0;entry.overlay.reset();entry.label.hidden = true;
    entry.canvas.getContext('2d').clearRect(0, 0, entry.canvas.width, entry.canvas.height);
  }
  function summary(){
    const unique = new Map();
    entries.forEach(entry => {if(entry.live)unique.set(entry.camera.id, entry);});
    const processed = [...unique.values()].filter(entry => entry.result && performance.now()-entry.receivedAt < 2500);
    const count = processed.reduce((total, entry) => total+entry.result.count, 0);
    const now = performance.now();while(completed.length && now-completed[0] > 2000)completed.shift();
    const rate = completed.length ? ` · ${(completed.length/2).toFixed(1)} Hz · ${Math.round(roundTrip)} ms · ${device || 'cpu'}` : '';
    $('#ai-status').textContent = !enabled ? 'Analysis paused' : !ready ? (lastError || 'Starting local vehicle model…') : `${processed.length}/${unique.size} feeds analyzed · ${count} vehicles tracked${rate}`;
  }
  async function health(){
    try{
      const response = await fetch(api+'/api/health', {signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error();
      const result = await response.json();
      ready = result.status === 'ready';device = result.device || device;
      lastError = result.status === 'error' ? 'Local model could not start' : result.status === 'loading' ? 'Loading vehicle model…' : '';
    }catch{ready = false;lastError = 'Local AI processor offline';}
    summary();
  }
  function updateLabel(entry){
    const result = entry.result;if(!result)return;
    const now = performance.now();if(now-entry.labelAt < 250)return;entry.labelAt = now;
    say(entry, `${result.count} vehicle${result.count === 1 ? '' : 's'} tracked`);
  }
  function eligibleEntries(){
    return [...entries.values()].filter(entry => entry.live && entry.video.isConnected && entry.video.readyState >= 2 && !entry.video.paused
      && entry.captureTime !== undefined && entry.captureTime > entry.lastSent+.001);
  }
  async function analyze(){
    if(!enabled || !ready || document.hidden)return;
    const eligible = eligibleEntries();
    if(!eligible.length)return;
    // The spotlight leads every batch; tiles fill the remaining time budget, stalest first.
    const budget = Math.max(1, Math.floor((110-overheadMs)/perImageMs));
    const size = Math.min(10, budget);
    const chosen = [...eligible.filter(e => e.spotlight), ...eligible.filter(e => !e.spotlight).sort((a, b) => (b.mediaTime-b.lastSent)-(a.mediaTime-a.lastSent))].slice(0, size);
    // All snapshots are already available. A buffering tile never delays another feed.
    const frames = chosen.map(entry => {
      try{
        const timestamp = entry.captureTime, image = encode(entry.captureCanvas);
        if(entry.lastSent >= 0)entry.sampleInterval = .8*entry.sampleInterval+.2*(timestamp-entry.lastSent);
        entry.lastSent = timestamp;
        entry.overlay.setCoast(Math.min(.8, Math.max(.3, 2*entry.sampleInterval+roundTrip/1000)));
        return {entry, timestamp, image, generation:entry.generation};
      }catch{say(entry, 'AI · frame unavailable');return null;}
    }).filter(Boolean);
    if(!frames.length)return;
    const started = performance.now();
    try{
      const images = await Promise.all(frames.map(frame => frame.image));
      const data = await post('/api/analyze', {frames:frames.map((frame, i) => ({camera_id:frame.entry.camera.id, session_id:frame.entry.id, source:frame.entry.camera.stream, timestamp:frame.timestamp, image:images[i]}))}, AbortSignal.timeout(3000));
      roundTrip = performance.now()-started;completed.push(performance.now());
      if(Number.isFinite(data.inference_ms)){
        // Medians of the last nine requests: one paging stall must not shrink the next second of batches.
        recent.perImage.push(data.inference_ms/frames.length);recent.overhead.push(Math.max(0, roundTrip-data.inference_ms));
        if(recent.perImage.length > 9){recent.perImage.shift();recent.overhead.shift();}
        perImageMs = median(recent.perImage);overheadMs = median(recent.overhead);
      }
      device = data.device || device;
      for(const result of data.frames){
        const entry = entries.get(result.session_id);
        if(!entry || !entry.live || !enabled || frames.find(frame => frame.entry.id === result.session_id)?.generation !== entry.generation)continue;
        // A result more than 1.2 s behind playback is backlog, not evidence.
        if(entry.mediaTime-result.timestamp > 1.2){clear(entry);say(entry, 'AI · processor catching up');continue;}
        entry.overlay.update(result);entry.result = result;entry.receivedAt = performance.now();
        updateLabel(entry);draw(entry);
      }
    }catch(error){
      lastError = error.message;
      if(lastError.includes('busy'))return;
      frames.forEach(frame => {clear(frame.entry);say(frame.entry, 'AI · waiting for processor');});
      // Retry a smaller batch next cycle; a transient timeout must not disable AI for five seconds.
      perImageMs = Math.max(110, perImageMs*2);overheadMs = 20;
    }finally{summary();}
  }
  async function cycle(){
    const started = performance.now();
    try{await analyze();}catch{/* The next cycle retries. */}
    finally{clearTimeout(cycleTimer);cycleTimer = setTimeout(cycle, Math.max(0, 100-(performance.now()-started)));}
  }
  function draw(entry){
    const {canvas, video} = entry;
    const rect = entry.container.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if(canvas.width !== Math.round(rect.width*dpr) || canvas.height !== Math.round(rect.height*dpr)){
      canvas.width = Math.round(rect.width*dpr);canvas.height = Math.round(rect.height*dpr);
    }
    const ctx = canvas.getContext('2d');ctx.setTransform(dpr, 0, 0, dpr, 0, 0);ctx.clearRect(0, 0, rect.width, rect.height);
    if(!enabled || !entry.live || !video.videoWidth || !entry.result || performance.now()-entry.receivedAt > 1500)return;
    const scale = Math.max(rect.width/video.videoWidth, rect.height/video.videoHeight);
    const width = video.videoWidth*scale, height = video.videoHeight*scale, offsetX = (rect.width-width)/2, offsetY = (rect.height-height)/2;
    ctx.lineWidth = 1.5;ctx.font = '11px monospace';ctx.strokeStyle = '#22d3ee';
    for(const track of entry.overlay.render(entry.mediaTime, performance.now())){
      const [x1, y1, x2, y2] = track.box;
      const x = x1*width+offsetX, y = y1*height+offsetY, w = (x2-x1)*width, h = (y2-y1)*height;
      ctx.strokeRect(x, y, w, h);
      const text = `${track.label} #${track.id}`;
      const textWidth = ctx.measureText(text).width+8, tx = Math.max(0, Math.min(x, rect.width-textWidth)), ty = Math.max(30, y-18);
      ctx.fillStyle = '#06121ee8';ctx.fillRect(tx, ty, textWidth, 17);ctx.fillStyle = ctx.strokeStyle;ctx.fillText(text, tx+4, ty+12);
    }
  }
  function onPresented(entry, mediaTime){
    if(entry.overlay.present(mediaTime)){clear(entry);entry.lastSent = -1;}
    entry.mediaTime = mediaTime;
    if(enabled && ready && entry.live && !document.hidden && entry.video.readyState >= 2
      && (entry.captureTime === undefined || mediaTime-entry.captureTime >= .066)){
      try{capture(entry, mediaTime);}catch{entry.captureTime = undefined;}
    }
    draw(entry);
  }
  function paint(){
    entries.forEach(entry => {if(!entry.video.requestVideoFrameCallback && entry.video.currentTime !== entry.mediaTime)onPresented(entry, entry.video.currentTime);});
    requestAnimationFrame(paint);
  }
  function attach(container, video, camera){
    if(api === null)return {state(){}, dispose(){}};
    const id = crypto.randomUUID(), canvas = document.createElement('canvas'), label = document.createElement('div');
    canvas.className = 'ai-overlay';canvas.setAttribute('aria-hidden', 'true');label.className = 'ai-summary';label.hidden = true;
    container.append(canvas, label);
    const entry = {id, container, video, camera, canvas, label, live:false, spotlight:container.id === 'spotlight-media', overlay:createOverlayTracker(),
      sampleInterval:.1, captureTime:undefined, generation:0, mediaTime:undefined, lastSent:-1, receivedAt:0, result:null, labelAt:0, captureCanvas:document.createElement('canvas')};
    entries.set(id, entry);
    if(video.requestVideoFrameCallback){
      const frameCallback = (_now, metadata) => {if(!entries.has(id))return;onPresented(entry, metadata.mediaTime);entry.callback = video.requestVideoFrameCallback(frameCallback);};
      entry.callback = video.requestVideoFrameCallback(frameCallback);
    }
    return {
      state(value){
        entry.live = value === 'LIVE';
        if(!entry.live)clear(entry);
        summary();
      },
      dispose(){
        entries.delete(id);if(entry.callback !== undefined)video.cancelVideoFrameCallback?.(entry.callback);
        canvas.remove();label.remove();summary();
      }
    };
  }
  // #ai-status is a live region, so the hosted build states the boundary once and never polls.
  function standDown(){
    const status = $('#ai-status'), toggle = $('#ai-toggle'), panel = $('.ai-panel');
    if(status)status.textContent = 'Vehicle analysis runs on a local processor and is not part of this hosted preview.';
    if(toggle)toggle.hidden = true;
    if(panel)panel.classList.add('unavailable');
  }
  if(api === null)standDown();
  else{
    $('#ai-toggle').addEventListener('click', () => {
      enabled = !enabled;$('#ai-toggle').setAttribute('aria-pressed', String(enabled));$('#ai-toggle').textContent = enabled ? 'Pause AI' : 'Enable AI';
      entries.forEach(entry => {clear(entry);draw(entry);});summary();
    });
    health();setInterval(health, 5000);cycle();requestAnimationFrame(paint);
  }
  return {attach};
})();
