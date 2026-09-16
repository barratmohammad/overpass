/* Per-frame overlay motion model. Pure code shared by the browser and node tests. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CycloneOverlay=factory();
})(typeof self!=='undefined'?self:globalThis,function(){
  function createOverlayTracker({horizon=.6,coast=.3,tau=.07,maxVelocity=3,minHits=1}={}){
    const tracks=new Map();
    let last=null,lastResultTime=-Infinity;
    const reset=()=>{tracks.clear();lastResultTime=-Infinity;};
    return {
      present(mediaTime){
        const jump=last!==null&&(mediaTime<last-.01||mediaTime-last>1.5);
        if(jump)reset();
        last=mediaTime;return jump;
      },
      update(result){
        if(!(result.timestamp>=lastResultTime))return false;
        for(const track of result.tracks){
          let state=tracks.get(track.id);
          if(!state){state={id:track.id,shown:null,shownAt:0,offset:[0,0,0,0],previous:null};tracks.set(track.id,state);}
          else if(!state.previous)state.previous={det:state.det,vel:state.vel,detTime:state.detTime,hits:state.hits};
          state.label=track.label;state.det=track.box.slice();state.detTime=result.timestamp;state.lastSeen=result.timestamp;
          state.vel=Array.isArray(track.velocity)?track.velocity.slice():[0,0];state.hits=track.hits??1;
        }
        lastResultTime=result.timestamp;return true;
      },
      render(presentTime,wallNow){
        const predict=(det,vel,detTime,hits)=>{
          const h=Math.min(horizon,Math.max(0,presentTime-detTime));
          const trusted=hits>=minHits&&vel.every(Number.isFinite)&&Math.hypot(vel[0],vel[1])<=maxVelocity;
          const dx=trusted?vel[0]*h:0,dy=trusted?vel[1]*h:0;
          return [det[0]+dx,det[1]+dy,det[2]+dx,det[3]+dy];
        };
        const output=[];
        for(const [id,state] of tracks){
          if(presentTime-state.lastSeen>coast){tracks.delete(id);continue;}
          const predicted=predict(state.det,state.vel,state.detTime,state.hits);
          if(state.previous){
            // A correction jumps the prediction; carry the jump as an offset that decays, so motion itself is never smoothed.
            const before=predict(state.previous.det,state.previous.vel,state.previous.detTime,state.previous.hits);
            state.offset=state.offset.map((value,i)=>value+before[i]-predicted[i]);state.previous=null;
            // Never smooth so far behind the evidence that the box loses the vehicle.
            const limits=[Math.abs(predicted[2]-predicted[0])*.2,Math.abs(predicted[3]-predicted[1])*.2];
            state.offset=state.offset.map((value,i)=>Math.max(-limits[i%2],Math.min(limits[i%2],value)));
          }
          if(state.shown){const keep=Math.exp(-Math.max(0,wallNow-state.shownAt)/1000/tau);state.offset=state.offset.map(value=>value*keep);}
          state.shown=predicted.map((value,i)=>value+state.offset[i]);state.shownAt=wallNow;
          output.push({id,label:state.label,box:state.shown.slice(),coasting:presentTime-state.lastSeen>.001});
        }
        return output;
      },
      setCoast(seconds){coast=seconds;},
      reset,
      size(){return tracks.size;}
    };
  }
  return {createOverlayTracker};
});
