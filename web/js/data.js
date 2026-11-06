// Data sources: ESP32 API (Live) and the built-in simulator (Sim) used in demo mode.
"use strict";
// ======================================================================
//  Data sources: the real ESP32 API, or a built-in simulator (demo mode)
// ======================================================================
const PRESETS = {
  0:{name:"Tomato",startPct:45,targetPct:70,criticalPct:30,hint:"Even moisture prevents fruit cracking."},
  1:{name:"Chili", startPct:40,targetPct:65,criticalPct:28,hint:"Slightly drier; avoid waterlogging."},
  2:{name:"Onion", startPct:50,targetPct:75,criticalPct:35,hint:"Shallow roots: frequent, light watering."},
  3:{name:"Custom",hint:"Set your own levels below."}
};

const Live = {
  async get(path){
    const c = new AbortController(); const t = setTimeout(()=>c.abort(), 4000);
    try{ const r = await fetch(path,{signal:c.signal,cache:"no-store"}); if(!r.ok) throw new Error(r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  },
  async post(path, params){
    const r = await fetch(path,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(params)});
    let j={}; try{ j = await r.json(); }catch(e){}
    if(!r.ok || j.ok===false) throw new Error(j.msg || ("Request failed ("+r.status+")"));
    return j;
  },
  status(){ return this.get("/api/status"); },
  history(){ return this.get("/api/history"); },
  cmd(p){ return this.post("/api/cmd", p); },
  saveSettings(p){ return this.post("/api/settings", p); },
  wifi(p){ return this.post("/api/wifi", p); }
};

class Sim {
  constructor(){
    this.tz = -new Date().getTimezoneOffset();
    this.cfg = {crop:0,startPct:45,targetPct:70,criticalPct:30,minSpeed:45,pulseRunSec:300,soakSec:600,useWindows:true,
      w1Start:5,w1End:9,w2Start:16,w2End:19,batCutoffV:11.6,batResumeV:12.3,manualMaxMin:15,pumpLpm:8,dailyLimitL:400,
      hotBoost:true,noRiseMin:8,sensorCount:3,tzMin:this.tz,dryRaw:[3200,3170,3240],wetRaw:[1300,1330,1280]};
    this.mode="auto"; this.state="idle"; this.speed=0; this.src="off"; this.reason="";
    this.manualEnd=0; this.manualSpeed=80; this.holdEnd=0; this.pulseStart=0; this.soakStart=0;
    this.alarm=""; this.low=false; this.soc=.62; this.m=58; this.off=[0,-3.2,2.6];
    this.trkManual=false; this.trkManualAngle=90; this.angle=90;
    this.liters=0; this.pumpSec=0; this.wh=0; this.day=null;
    this.events=[]; this.hist=[]; this.start=Date.now()/1000;
    this.seed();
  }
  log(l,m,t){ this.events.unshift({t:Math.round(t??this.t),l,m}); this.events.length=Math.min(this.events.length,25); }
  hour(t){ const d=new Date(t*1000); return d.getHours()+d.getMinutes()/60; }
  env(t){ const h=this.hour(t), sun=Math.max(0,Math.sin(Math.PI*(h-6)/12)), w=Math.sin(2*Math.PI*(h-9)/24);
    return {h,sun,temp:30+7*w,hum:60-22*w}; }
  effTarget(temp){ return Math.min(95,this.cfg.targetPct + (this.cfg.hotBoost && temp>35 ? 5 : 0)); }
  inWin(t){ if(!this.cfg.useWindows) return true; const h=this.hour(t), c=this.cfg;
    return (h>=c.w1Start&&h<c.w1End)||(h>=c.w2Start&&h<c.w2End); }
  socToV(s){ return 10.5 + 2.23*Math.pow(Math.max(0,Math.min(1,s)),.75); }
  trackAngle(t){ const h=this.hour(t); if(h<6||h>18.5) return 15; return 15 + Math.max(0,Math.min(1,(h-6)/12))*150; }
  physics(dt,t,gain){
    const e=this.env(t); this.e=e;
    const evap=(0.6+3.5*e.sun*(e.temp/32))/3600, add=300/3600*this.speed/100;
    this.m=Math.max(8,Math.min(97,this.m+(add*Math.min(gain,4)-evap*gain)*dt));
    this.angle = this.trkManual ? this.trkManualAngle : Math.round(this.trackAngle(t));
    const gainTrk = this.trkManual ? Math.max(.2,Math.cos((this.angle-this.trackAngle(t))*Math.PI/180)) : 1;
    this.pv = 62*e.sun*gainTrk;
    const load = 2.5 + 42*this.speed/100;
    this.soc=Math.max(.04,Math.min(1,this.soc+(this.pv*.85-load)*dt*gain/(240*3600)));
    this.batV = this.socToV(this.soc) + (this.pv>load ? .35*Math.min(1,(this.pv-load)/30) : -.12*this.speed/100);
    if(!this.low && this.batV<this.cfg.batCutoffV){ this.low=true; this.log("w","Battery low ("+this.batV.toFixed(2)+" V) - pump disabled",t); }
    if(this.low && this.batV>this.cfg.batResumeV){ this.low=false; this.log("i","Battery recovered - pump allowed",t); }
  }
  control(t){
    const c=this.cfg; let want=0, src="off";
    if(this.manualEnd && t>=this.manualEnd){ this.manualEnd=0; this.log("i","Manual run finished",t); if(this.mode==="auto") this.holdEnd=t+1800; }
    if(this.manualEnd){
      if(this.m>=95){ this.manualEnd=0; this.log("i","Manual run stopped: soil saturated",t); }
      else { want=this.manualSpeed; src="manual"; this.reason="Manual run"; }
    }
    if(!this.manualEnd){
      if(this.mode==="manual"){ this.reason="Manual mode - press Run pump to water"; this.state="idle"; }
      else if(this.holdEnd>t){ this.reason="Auto paused after manual stop"; this.state="idle"; }
      else if(this.alarm){ this.reason="Alarm - check system, then reset"; this.state="idle"; }
      else if(this.liters>=c.dailyLimitL){ this.reason="Daily water limit reached"; this.state="idle"; }
      else {
        this.holdEnd=0;
        const tgt=this.effTarget(this.e.temp), allowed=this.inWin(t)||this.m<c.criticalPct;
        if(this.state==="idle"){
          if(this.m<c.startPct && allowed){ this.state="watering"; this.pulseStart=t; this.log("i","Auto watering started (soil "+Math.round(this.m)+"%)",t); }
          else this.reason = this.m<c.startPct ? "Soil dry - waiting for watering window" : "Soil moisture OK";
        }
        if(this.state==="watering"){
          if(this.m>=tgt){ this.state="idle"; this.reason="Target reached"; this.log("i","Target reached ("+Math.round(this.m)+"%) - pump stopped",t); }
          else if(!allowed){ this.state="idle"; this.reason="Outside watering window"; this.log("i","Watering window closed",t); }
          else if(t-this.pulseStart>=c.pulseRunSec){ this.state="soaking"; this.soakStart=t; }
          else { want=this.autoSpeed(this.m,tgt); src="auto"; this.reason="Watering: soil below target"; }
        } else if(this.state==="soaking"){
          this.reason="Soaking - letting water reach the roots";
          if(this.m>=tgt){ this.state="idle"; this.reason="Target reached"; }
          else if(t-this.soakStart>=c.soakSec){ this.state="watering"; this.pulseStart=t; }
        }
      }
    }
    if(want>0 && this.low){ want=0; src="off"; this.reason="Battery low - pump locked out"; }
    this.speed=want; this.src=want?src:"off";
  }
  autoSpeed(m,tgt){ const c=this.cfg; if(m<=c.criticalPct) return 100;
    const d=Math.max(0,Math.min(1,(tgt-m)/Math.max(1,tgt-c.criticalPct))); return Math.round(c.minSpeed+d*(100-c.minSpeed)); }
  totals(dt,t){
    const d=new Date(t*1000).toDateString();
    if(this.day && d!==this.day){ this.liters=0; this.pumpSec=0; this.wh=0; this.log("i","New day - counters reset",t); }
    this.day=d;
    if(this.speed>0){ this.liters+=this.cfg.pumpLpm*this.speed/100*dt/60; this.pumpSec+=dt; }
    this.wh+=this.pv*dt/3600;
  }
  record(t,pumpMax){
    const e=this.e;
    this.hist.push([Math.round(t),Math.round(this.m*10),Math.round(e.temp*10),Math.round(e.hum*10),Math.round(this.batV*100),Math.round(this.pv*10),Math.round(pumpMax)]);
    if(this.hist.length>288) this.hist.shift();
  }
  seed(){
    const now=Math.floor(Date.now()/1000); let t=now-86400;
    this.t=t; this.log("i","Controller started (fw 1.0.0)",t);
    for(; t<=now; t+=300){
      this.t=t; this.physics(300,t,1); this.control(t); this.totals(300,t);
      this.record(t,this.speed);
    }
    this.t=now; this.lastHist=now; this.lastReal=Date.now()/1000; this.pumpMax=0;
    this.mode="auto"; this.manualEnd=0;
  }
  tick(){
    const real=Date.now()/1000; let dt=Math.min(10,real-this.lastReal); this.lastReal=real;
    while(dt>0){ const s=Math.min(1,dt); dt-=s; this.t+=s;
      this.physics(s,this.t,20); this.control(this.t); this.totals(s,this.t); this.pumpMax=Math.max(this.pumpMax,this.speed);
      if(this.t-this.lastHist>=300){ this.lastHist=this.t; this.record(this.t,this.pumpMax); this.pumpMax=0; }
    }
  }
  async status(){
    this.tick(); const t=this.t, e=this.e, c=this.cfg, j=()=> (Math.random()-.5);
    const sensors=[0,1,2].slice(0,c.sensorCount).map(i=>{ const pct=Math.max(0,Math.min(100,this.m+this.off[i]+j()*.8));
      return {raw:Math.round(c.dryRaw[i]-pct/100*(c.dryRaw[i]-c.wetRaw[i])),pct:+pct.toFixed(1),ok:true}; });
    const avg=sensors.reduce((a,s)=>a+s.pct,0)/sensors.length;
    const solarV=this.pv>1?17.6+1.6*e.sun+j()*.2:+(e.sun*8).toFixed(1);
    const state=this.manualEnd?"manual":this.low?"lockout":this.alarm?"alarm":this.holdEnd>t?"hold":this.mode==="manual"?"manual-idle":this.state;
    return {fw:"1.0.0-demo",uptime:Math.round(Date.now()/1000-this.start),time:Math.round(t),tzMin:this.tz,mode:this.mode,
      pump:{speed:this.speed,target:this.speed,source:this.src,state,reason:this.reason,
        manualLeft:this.manualEnd?Math.max(0,Math.round(this.manualEnd-t)):0, holdLeft:this.holdEnd>t?Math.round(this.holdEnd-t):0,
        pulseLeft:this.state==="watering"&&!this.manualEnd?Math.max(0,Math.round(c.pulseRunSec-(t-this.pulseStart))):0,
        soakLeft:this.state==="soaking"?Math.max(0,Math.round(c.soakSec-(t-this.soakStart))):0, manualSpeed:this.manualSpeed},
      soil:{avg:+avg.toFixed(1),effTarget:this.effTarget(e.temp),sensors},
      air:{temp:+(e.temp+j()*.3).toFixed(1),hum:+(e.hum+j()).toFixed(1)},
      power:{batV:+this.batV.toFixed(2),batPct:Math.round(batPct(this.batV)),solarV:+solarV.toFixed(1),solarA:+(this.pv/Math.max(1,solarV)).toFixed(2),solarW:+this.pv.toFixed(1),lowBattery:this.low},
      tracker:{angle:this.angle,manual:this.trkManual},
      today:{liters:+this.liters.toFixed(1),pumpMin:+(this.pumpSec/60).toFixed(1),solarWh:+this.wh.toFixed(1)},
      alarm:this.alarm, wifi:{ap:"SolarIrrigation",sta:"",rssi:0}, settings:JSON.parse(JSON.stringify(c)), events:this.events.slice()};
  }
  async history(){ this.tick(); return {period:300,timeValid:true,now:Math.round(this.t),rows:this.hist.slice()}; }
  async cmd(p){
    const t=this.t;
    switch(p.do){
      case "mode": this.mode=p.value==="manual"?"manual":"auto"; this.state="idle"; this.holdEnd=0; this.log("i","Mode set to "+this.mode.toUpperCase()); return {ok:true,msg:"Mode changed"};
      case "run": if(this.low) throw new Error("Battery is low. The pump is locked out to protect the battery.");
        this.manualSpeed=Math.max(30,Math.min(100,+p.speed)); this.manualEnd=t+Math.max(1,Math.min(this.cfg.manualMaxMin,+p.minutes))*60; this.holdEnd=0;
        this.log("i","Manual run "+p.minutes+" min at "+this.manualSpeed+"%"); return {ok:true,msg:"Pump started"};
      case "stop": { const was=this.speed>0; this.manualEnd=0; if(this.mode==="auto"&&was){ this.holdEnd=t+1800; this.state="idle"; }
        this.speed=0; this.log("i","Pump stopped by user"); return {ok:true,msg:"Pump stopped"}; }
      case "resume": this.holdEnd=0; this.log("i","Auto resumed"); return {ok:true,msg:"Auto resumed"};
      case "clearAlarm": this.alarm=""; this.log("i","Alarm reset by user"); return {ok:true,msg:"Alarm reset"};
      case "time": return {ok:true,msg:"Clock set"};
      case "tracker": this.trkManual=p.manual==="1"; if(p.angle!=null) this.trkManualAngle=+p.angle; return {ok:true,msg:"Tracker updated"};
      case "calibrate": { const i=+p.sensor, raw=Math.round(this.cfg.dryRaw[i]-(this.m+this.off[i])/100*(this.cfg.dryRaw[i]-this.cfg.wetRaw[i]));
        if(p.point==="dry") this.cfg.dryRaw[i]=raw; else this.cfg.wetRaw[i]=raw; this.log("i","Sensor "+(i+1)+" "+p.point+" point = "+raw);
        return {ok:true,msg:"Calibration saved ("+raw+")"}; }
    }
    throw new Error("Unknown command");
  }
  async saveSettings(p){
    for(const [k,v] of Object.entries(p)){ if(k in this.cfg) this.cfg[k] = (v==="1"||v==="0") && typeof this.cfg[k]==="boolean" ? v==="1" : +v; }
    const c=this.cfg; if(c.targetPct<=c.startPct+5) c.targetPct=c.startPct+5; if(c.criticalPct>=c.startPct) c.criticalPct=c.startPct-5;
    if(c.batResumeV<=c.batCutoffV) c.batResumeV=+(c.batCutoffV+.4).toFixed(2);
    this.log("i","Settings saved"); return {ok:true,msg:"Settings saved"};
  }
  async wifi(){ return {ok:true,msg:"Demo: Wi-Fi settings are not saved"}; }
}

function batPct(v){ const V=[10.5,11.51,11.66,11.81,11.96,12.10,12.24,12.37,12.50,12.62,12.73];
  if(v<=V[0]) return 0; if(v>=V[10]) return 100; for(let i=1;i<=10;i++) if(v<V[i]) return (i-1)*10+10*(v-V[i-1])/(V[i]-V[i-1]); return 100; }

