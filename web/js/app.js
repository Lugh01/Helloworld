// Dashboard UI: rendering, charts, polling and button handlers.
"use strict";
// ======================================================================
//  App state
// ======================================================================
let api = Live, demo = false, cloud = false, pollTimer = null, S = null, H = null, failCount = 0, chartKind = "soil", manualMin = 5, settingsLoaded = false;
const $ = s => document.querySelector(s);
const fmt = (v,d=0) => (v==null||isNaN(v)) ? "—" : (+v).toFixed(d);
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function hhmm(epoch, tz){ if(!epoch) return "—"; const d=new Date((epoch+tz*60)*1000); return d.toISOString().substr(11,5); }
function dur(s){ s=Math.max(0,Math.round(s)); const m=Math.floor(s/60), r=s%60; return m? m+" min "+String(r).padStart(2,"0")+" s" : r+" s"; }

let toastT;
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("show"),2600); }

async function send(params, okMsg){
  if(cloud) toast("Sending to the farm…");
  try{ const r = await api.cmd(params); toast(cloud ? (r.msg || "Done") : (okMsg || r.msg || "Done")); await poll(); }
  catch(e){ if(e.auth) return showLogin(e.message); toast(e.message || "Could not reach the controller"); }
}

// ======================================================================
//  Rendering
// ======================================================================
function arcPath(cx,cy,r,a0,a1){
  const p=a=>[cx+r*Math.cos(a*Math.PI/180), cy+r*Math.sin(a*Math.PI/180)];
  const [x0,y0]=p(a0),[x1,y1]=p(a1); const large=(a1-a0)>180?1:0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const ang = v => 150 + clamp(v,0,100)*2.4;
function drawGauge(v, c, eff){
  const cx=110, cy=110, r=88;
  const seg=(a,b,col,w)=>`<path d="${arcPath(cx,cy,r,ang(a),ang(b))}" stroke="${col}" stroke-width="${w}" fill="none" stroke-linecap="butt"/>`;
  let s = seg(0,100,"var(--surface-2)",18);
  s += seg(0,c.criticalPct,"var(--bad-soft)",18);
  s += seg(c.startPct,eff,"var(--accent-soft)",18);
  if(v!=null && !isNaN(v)) s += `<path d="${arcPath(cx,cy,r,ang(0),ang(Math.max(.5,v)))}" stroke="var(--water)" stroke-width="8" fill="none" stroke-linecap="round"/>`;
  const tick=(val,col,lab)=>{ const a=ang(val)*Math.PI/180, x1=cx+(r-14)*Math.cos(a), y1=cy+(r-14)*Math.sin(a), x2=cx+(r+12)*Math.cos(a), y2=cy+(r+12)*Math.sin(a);
    const lx=cx+(r+22)*Math.cos(a), ly=cy+(r+22)*Math.sin(a);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2"/><text x="${lx}" y="${ly+3}" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="var(--font-data)">${lab}</text>`; };
  s += tick(c.startPct,"var(--warn)",Math.round(c.startPct)) + tick(eff,"var(--accent)",Math.round(eff));
  s += `<text x="${cx+r*Math.cos(ang(0)*Math.PI/180)}" y="${cy+r*Math.sin(ang(0)*Math.PI/180)+22}" text-anchor="middle" font-size="10" fill="var(--muted)">0</text>`;
  s += `<text x="${cx+r*Math.cos(ang(100)*Math.PI/180)}" y="${cy+r*Math.sin(ang(100)*Math.PI/180)+22}" text-anchor="middle" font-size="10" fill="var(--muted)">100</text>`;
  $("#gauge").innerHTML = s;
}

function soilWords(v,c,eff){
  if(v==null||isNaN(v)) return ["No reading","var(--bad)","No soil sensor is giving a valid reading. Check the sensor cables."];
  if(v<c.criticalPct) return ["Very dry","var(--bad)",`Below the critical ${c.criticalPct}%. The pump runs at full speed even outside watering hours.`];
  if(v<c.startPct) return ["Dry: needs water","var(--warn)",`Below the start level of ${c.startPct}%. Watering starts in the next watering window.`];
  if(v<eff) return ["Moist: OK","var(--accent)",`Between start (${c.startPct}%) and target (${Math.round(eff)}%). No watering needed now.`];
  if(v<90) return ["Well watered","var(--water)",`At or above the ${Math.round(eff)}% target. The crop has enough water.`];
  return ["Saturated","var(--water)","Soil is fully wet. Avoid watering to prevent root rot."];
}

const STATE = {
  watering:["run","Watering · auto"], soaking:["soak","Soaking pause"], idle:["idle","Standby · auto"],
  hold:["warn","Auto paused"], manual:["run","Manual run"], "manual-idle":["idle","Manual mode"],
  alarm:["bad","Alarm"], lockout:["bad","Battery lockout"]
};

function render(){
  if(!S) return;
  const c=S.settings, eff=S.soil.effTarget ?? c.targetPct, tz=S.tzMin ?? 390;
  // header
  $("#clock").textContent = S.time ? hhmm(S.time,tz) : "Clock not set";
  const stale = cloud && S.ageSec > 45;
  const conn=$("#conn"); conn.className="conn "+(demo?"demo":(failCount||stale)?"lost":"live");
  conn.lastElementChild.textContent = demo?"Demo data":failCount?"Connection lost":cloud?(stale?"Farm offline":"Cloud · live"):"Live";

  // banners
  let b="";
  if(demo) b+=`<div class="banner demo"><div><b>Demo mode: simulated data</b>Connect your phone to the <b>SolarIrrigation</b> Wi-Fi and open <b>192.168.4.1</b> to see the real field. Here the soil dries about 20× faster so you can watch the controller work.</div></div>`;
  if(!demo && failCount) b+=cloud ? `<div class="banner warn"><div><b>Can't reach the cloud</b>Check your phone's internet connection. The controller keeps watering on its own.</div></div>`
    : `<div class="banner warn"><div><b>Connection lost</b>The controller keeps watering on its own. Rejoin the SolarIrrigation Wi-Fi or move closer.</div></div>`;
  if(stale && !failCount) b+=`<div class="banner warn"><div><b>Farm controller offline</b>Last update ${agoText(S.ageSec)}. The readings below are from then. The controller keeps watering on its own; check its power and internet connection.</div></div>`;
  if(S.alarm) b+=`<div class="banner bad"><div><b>Alarm</b>${esc(S.alarm)}</div><button class="btn sm act" data-act="clearAlarm">Reset alarm</button></div>`;
  if(S.power.lowBattery) b+=`<div class="banner bad"><div><b>Battery low: pump locked out</b>Battery at ${fmt(S.power.batV,2)} V. The pump is allowed again above ${c.batResumeV} V.</div></div>`;
  const bad=S.soil.sensors.map((s,i)=>s.ok?null:i+1).filter(Boolean);
  if(bad.length) b+=`<div class="banner warn"><div><b>Sensor ${bad.join(", ")} not responding</b>Check the cable and plug. ${bad.length===S.soil.sensors.length?"Auto watering is stopped. Use Manual mode.":"The other sensors are still used."}</div></div>`;
  if(!demo && !cloud && !S.time) b+=`<div class="banner warn"><div><b>Clock not set</b>Watering hours and the solar tracker need the time.</div><button class="btn sm act" data-act="sync">Set clock now</button></div>`;
  $("#banners").innerHTML=b;

  // soil
  const v=S.soil.avg; drawGauge(v,c,eff);
  const [word,col,expl]=soilWords(v,c,eff);
  $("#soilBig").innerHTML=`${fmt(v)}<small>%</small>`;
  $("#soilState").textContent=word; $("#soilState").style.color=col; $("#soilExplain").textContent=expl;
  $("#cropLabel").textContent=PRESETS[c.crop].name+" profile";
  $("#sensorBars").innerHTML=S.soil.sensors.map((s,i)=>`<div class="sensor-row"><span>Sensor ${i+1}</span>
    <div class="bar"><span style="width:${s.ok?clamp(s.pct,0,100):0}%;${s.ok?"":"background:var(--bad)"}"></span></div>
    <span class="num" style="text-align:right;${s.ok?"":"color:var(--bad);font-weight:700"}">${s.ok?fmt(s.pct)+"%":"fault"}</span></div>`).join("");

  // pump
  const p=S.pump, running=p.speed>0||p.target>0;
  const [cls,label]=STATE[p.state]||["idle",p.state];
  const chip=$("#pumpChip"); chip.className="chip "+cls; chip.lastElementChild.textContent=label;
  $("#pumpSpeed").innerHTML=`${p.speed}<small>% speed · ${fmt(c.pumpLpm*p.speed/100,1)} L/min</small>`;
  $("#pumpBar").style.width=p.speed+"%";
  $("#pumpReason").textContent=p.reason;
  let timer="";
  if(p.manualLeft) timer=`Stops in ${dur(p.manualLeft)}`;
  else if(p.state==="watering"&&p.pulseLeft) timer=`Soak pause in ${dur(p.pulseLeft)}`;
  else if(p.soakLeft) timer=`Watering resumes in ${dur(p.soakLeft)} if still below target`;
  else if(p.holdLeft) timer=`Auto resumes in ${dur(p.holdLeft)} · <button class="btn sm" data-act="resume">Resume auto now</button>`;
  $("#pumpTimer").innerHTML=timer;
  const btn=$("#pumpBtn");
  btn.classList.toggle("stop",running);
  btn.disabled=!running && S.power.lowBattery;
  $("#pumpBtnText").textContent = running ? "Stop pump" : S.power.lowBattery ? "Locked" : "Run pump";
  $("#modeAuto").setAttribute("aria-pressed",S.mode==="auto"); $("#modeManual").setAttribute("aria-pressed",S.mode==="manual");
  [...document.querySelectorAll("#mMinutes button")].forEach(x=>x.hidden=+x.dataset.min>c.manualMaxMin);
  updateEstimate();

  // tiles
  const pw=S.power, a=S.air, hot=a.temp>35;
  const dir = S.tracker.angle<60?"facing east":S.tracker.angle>120?"facing west":"facing up";
  const tiles=[
    ["Air temperature",fmt(a.temp,1),"°C", hot?["warn","Hot: target +5 %"]:a.temp==null?["bad","DHT22 not responding"]:["ok","Normal"],"DHT22"],
    ["Air humidity",fmt(a.hum),"%", a.hum<35?["warn","Very dry air"]:["ok","Normal"],"Relative humidity"],
    ["Battery",fmt(pw.batV,2),"V", pw.lowBattery?["bad","Low: pump off"]:pw.batPct<40?["warn",fmt(pw.batPct)+" % charge"]:["ok",fmt(pw.batPct)+" % charge"],
      `<div class="bar" style="height:5px;margin-top:2px"><span style="width:${pw.batPct||0}%;background:${pw.lowBattery?"var(--bad)":pw.batPct<40?"var(--warn)":"var(--ok)"}"></span></div>`],
    ["Solar power",fmt(pw.solarW,1),"W", pw.solarW>1?["ok","Charging"]:["", "No sun"], `${fmt(pw.solarV,1)} V · ${fmt(pw.solarA,2)} A`],
    ["Panel angle",fmt(S.tracker.angle),"°", S.tracker.manual?["warn","Manual angle"]:["ok","Tracking"], dir],
    ["Water today",fmt(S.today.liters,0),"L", S.today.liters>=c.dailyLimitL?["warn","Daily limit reached"]:["",""], `${fmt(S.today.pumpMin,0)} min pumping · ${fmt(S.today.solarWh,0)} Wh solar`]
  ];
  $("#tiles").innerHTML=tiles.map(([k,val,u,[fc,ft],sub])=>`<div class="tile"><span class="label">${k}</span>
    <span class="v num">${val}<small>${u}</small></span>${ft?`<span class="flag ${fc}">${ft}</span>`:""}<span class="sub">${sub||""}</span></div>`).join("");

  // events
  $("#events").innerHTML=S.events.map(e=>`<li class="${e.l}"><time>${S.time?hhmm(e.t,tz):Math.round(e.t/60)+"m"}</time><span class="dot"></span><span>${esc(e.m)}</span></li>`).join("") || `<li><span></span><span></span><span class="muted">No events yet.</span></li>`;

  renderControl();
  if(!settingsLoaded){ fillSettings(c); settingsLoaded=true; }
}

function agoText(s){ s=Math.round(s); if(s<90) return s+" seconds ago"; if(s<5400) return Math.round(s/60)+" minutes ago"; if(s<172800) return Math.round(s/3600)+" hours ago"; return Math.round(s/86400)+" days ago"; }

function updateEstimate(){
  const sp=+$("#mSpeed").value; $("#mSpeedOut").textContent=sp+"%";
  const lpm=S?S.settings.pumpLpm:8; $("#mEstimate").textContent="≈ "+Math.round(lpm*sp/100*manualMin)+" L";
}

// ---------- Tracker / calibration / system ----------
function renderControl(){
  const t=S.tracker, ang=t.angle;
  $("#trkMode").textContent=t.manual?"Manual angle":"Automatic (time based)";
  $("#trkAuto").setAttribute("aria-pressed",!t.manual); $("#trkManual").setAttribute("aria-pressed",t.manual);
  $("#trkManualBox").hidden=!t.manual;
  // sun-path drawing: 0deg = east (left), 180 = west (right)
  const cx=140, cy=140, r=110, rad=a=>Math.PI*(1-a/180);
  const px=cx+r*Math.cos(rad(ang)), py=cy-r*Math.sin(rad(ang));
  const hourLabel=[[15,"06:00"],[90,"12:00"],[165,"18:00"]].map(([a,l])=>{const x=cx+(r+14)*Math.cos(rad(a)), y=cy-(r+14)*Math.sin(rad(a));
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="var(--font-data)">${l}</text>`;}).join("");
  const nx=Math.cos(rad(ang)), ny=-Math.sin(rad(ang)); // normal direction
  const tx=-ny, ty=nx; // panel direction
  $("#trackerSvg").innerHTML=`
    <path d="M${cx-r} ${cy} A${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="4 5"/>
    ${hourLabel}
    <circle cx="${px}" cy="${py}" r="11" fill="var(--sun)"/>
    <line x1="${cx}" y1="${cy}" x2="${cx+nx*70}" y2="${cy+ny*70}" stroke="var(--sun)" stroke-width="1.5" stroke-dasharray="3 4"/>
    <line x1="${cx-tx*38}" y1="${cy-ty*38}" x2="${cx+tx*38}" y2="${cy+ty*38}" stroke="var(--water)" stroke-width="7" stroke-linecap="round"/>
    <rect x="${cx-4}" y="${cy}" width="8" height="24" fill="var(--muted)"/>
    <line x1="20" y1="${cy+24}" x2="260" y2="${cy+24}" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
    <text x="20" y="${cy+18}" font-size="10" fill="var(--muted)">E</text><text x="254" y="${cy+18}" font-size="10" fill="var(--muted)">W</text>
    <text x="${cx}" y="${cy-30}" text-anchor="middle" font-size="16" font-weight="700" fill="var(--ink)" font-family="var(--font-display)">${Math.round(ang)}°</text>`;

  const c=S.settings;
  $("#calBody").innerHTML=S.soil.sensors.map((s,i)=>`<tr>
    <td><b>Sensor ${i+1}</b></td><td class="num">${s.raw}</td><td class="num">${s.ok?fmt(s.pct)+" %":"—"}</td>
    <td class="num">${c.dryRaw[i]}</td><td class="num">${c.wetRaw[i]}</td>
    <td>${s.ok?'<span class="flag ok">OK</span>':'<span class="flag bad">Fault</span>'}</td>
    <td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-cal="${i}" data-point="dry">Save as dry</button><button class="btn sm" data-cal="${i}" data-point="wet">Save as wet</button></div></td></tr>`).join("");

  $("#signOut").hidden=!cloud; $("#syncClock").hidden=cloud;
  const up=S.uptime, tz=S.tzMin;
  $("#sysInfo").innerHTML=[
    ["Firmware",S.fw],["Uptime",Math.floor(up/86400)+" d "+Math.floor(up%86400/3600)+" h "+Math.floor(up%3600/60)+" min"],
    ["Clock",S.time?new Date((S.time+tz*60)*1000).toISOString().replace("T"," ").substr(0,16)+" (UTC"+(tz>=0?"+":"-")+Math.floor(Math.abs(tz)/60)+":"+String(Math.abs(tz)%60).padStart(2,"0")+")":"not set"],
    ["Hotspot",S.wifi.ap+" · 192.168.4.1"],["Router",S.wifi.sta?S.wifi.sta+" ("+S.wifi.rssi+" dBm)":"not connected"],
    ["Mode",S.mode.toUpperCase()],["Alarm",S.alarm||"none"],
    ["Data source",demo?"Demo simulator":cloud?"Cloud ("+(window.CLOUD_CONFIG.devicePath||"farm1")+"), updated "+agoText(S.ageSec):"Controller on this network"]
  ].map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
}

// ---------- Settings form ----------
const NUM_FIELDS=["startPct","targetPct","criticalPct","minSpeed","pumpLpm","dailyLimitL","manualMaxMin","w1Start","w1End","w2Start","w2End","batCutoffV","batResumeV","noRiseMin"];
function fillSettings(c){
  $("#s_crop").value=c.crop; NUM_FIELDS.forEach(k=>$("#s_"+k).value=c[k]);
  $("#s_pulseRunMin").value=+(c.pulseRunSec/60).toFixed(1); $("#s_soakMin").value=+(c.soakSec/60).toFixed(1);
  $("#s_hotBoost").checked=c.hotBoost; $("#s_useWindows").checked=c.useWindows; $("#s_sensorCount").value=c.sensorCount;
  updateBand();
}
function updateBand(){
  const st=+$("#s_startPct").value, tg=+$("#s_targetPct").value, cr=+$("#s_criticalPct").value;
  $("#bandPreview").innerHTML=`<span style="left:0;width:${cr}%;background:var(--bad-soft)"></span>
    <span style="left:${cr}%;width:${Math.max(0,st-cr)}%;background:var(--warn-soft)"></span>
    <span style="left:${st}%;width:${Math.max(0,tg-st)}%;background:var(--accent-soft)"></span>
    <b style="left:${tg}%"></b>`;
  $("#cropHint").textContent=PRESETS[$("#s_crop").value].hint;
}

// ---------- Chart ----------
const CHARTS={
  soil:{left:{min:0,max:100,step:25,unit:"%"},series:[
    {i:6,div:1,name:"Pump speed",color:"var(--water)",kind:"bars",unit:"%",axis:"l"},
    {i:1,div:10,name:"Soil moisture",color:"var(--accent)",kind:"line",unit:"%",axis:"l"}],
    bands:true},
  air:{left:{min:10,max:45,step:5,unit:"°C"},right:{min:0,max:100,step:20,unit:"%"},series:[
    {i:2,div:10,name:"Temperature",color:"var(--sun)",kind:"line",unit:"°C",axis:"l"},
    {i:3,div:10,name:"Humidity",color:"var(--water)",kind:"line",unit:"%",axis:"r"}]},
  power:{left:{min:0,max:70,step:10,unit:"W"},right:{min:10.5,max:14.5,step:1,unit:"V"},series:[
    {i:5,div:10,name:"Solar power",color:"var(--sun)",kind:"area",unit:"W",axis:"l"},
    {i:4,div:100,name:"Battery",color:"var(--accent)",kind:"line",unit:"V",axis:"r"}]}
};
function drawChart(){
  if(!H||!S) return;
  const svg=$("#chart"), W=Math.max(280,svg.clientWidth||600), Hh=210, def=CHARTS[chartKind];
  const rows=H.rows.slice();
  // append live point
  if(S.time||!H.timeValid){ const t=S.time||H.now; if(!rows.length||t>rows[rows.length-1][0]) rows.push([t,Math.round((S.soil.avg??-.1)*10),Math.round((S.air.temp??-99.9)*10),Math.round((S.air.hum??-.1)*10),Math.round((S.power.batV??-.01)*100),Math.round((S.power.solarW??-.1)*10),S.pump.speed]); }
  if(rows.length<2){ svg.innerHTML=""; return; }
  const L=40, R=def.right?42:14, T=10, B=24, w=W-L-R, h=Hh-T-B;
  const t1=rows[rows.length-1][0], t0=Math.min(rows[0][0], t1-3600);
  const x=t=>L+(t-t0)/(t1-t0)*w;
  const yS=(ax,v)=>T+h-(clamp(v,ax.min,ax.max)-ax.min)/(ax.max-ax.min)*h;
  let s=`<g class="grid">`;
  for(let v=def.left.min; v<=def.left.max+1e-9; v+=def.left.step) s+=`<line x1="${L}" x2="${L+w}" y1="${yS(def.left,v)}" y2="${yS(def.left,v)}"/>`;
  s+=`</g><g class="axis">`;
  for(let v=def.left.min; v<=def.left.max+1e-9; v+=def.left.step) s+=`<text x="${L-6}" y="${yS(def.left,v)+3.5}" text-anchor="end">${+v.toFixed(1)}${v===def.left.max?def.left.unit:""}</text>`;
  if(def.right) for(let v=def.right.min; v<=def.right.max+1e-9; v+=def.right.step) s+=`<text x="${L+w+6}" y="${yS(def.right,v)+3.5}">${+v.toFixed(1)}${Math.abs(v-def.right.max)<1e-6?def.right.unit:""}</text>`;
  // x ticks every 6 hours (local time of controller)
  const tz=(S.tzMin??0)*60, six=21600;
  if(S.time){ for(let t=Math.ceil((t0+tz)/six)*six-tz; t<=t1; t+=six) s+=`<text x="${x(t)}" y="${Hh-6}" text-anchor="middle">${hhmm(t,S.tzMin)}</text><line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T+h}" stroke="var(--line)" stroke-dasharray="2 4"/>`; }
  else s+=`<text x="${L}" y="${Hh-6}">${Math.round((t1-t0)/3600)} h ago</text><text x="${L+w}" y="${Hh-6}" text-anchor="end">now</text>`;
  s+=`</g>`;
  if(def.bands){ const c=S.settings; s+=`<rect x="${L}" width="${w}" y="${yS(def.left,c.targetPct)}" height="${yS(def.left,c.startPct)-yS(def.left,c.targetPct)}" fill="var(--accent-soft)" opacity=".7"/>`; }
  for(const se of def.series){
    const ax=se.axis==="r"?def.right:def.left;
    const pts=rows.map(r=>[r[0], r[se.i]<0&&se.i!==2 || r[se.i]<=-990 ? null : r[se.i]/se.div]);
    if(se.kind==="bars"){
      const bw=Math.max(1.5,w/(rows.length)*.9);
      pts.forEach(([t,v])=>{ if(v>0) s+=`<rect x="${x(t)-bw/2}" y="${yS(ax,v)}" width="${bw}" height="${T+h-yS(ax,v)}" fill="${se.color}" opacity=".35"/>`; });
      continue;
    }
    let d="", open=false, area="";
    pts.forEach(([t,v])=>{ if(v==null){open=false;return;} d+=(open?"L":"M")+x(t).toFixed(1)+" "+yS(ax,v).toFixed(1); open=true; });
    if(se.kind==="area"){ const valid=pts.filter(p=>p[1]!=null); if(valid.length) area=`<path d="${d} L${x(valid[valid.length-1][0])} ${T+h} L${x(valid[0][0])} ${T+h}Z" fill="${se.color}" opacity=".18"/>`; }
    s+=area+`<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round"/>`;
    const last=pts.filter(p=>p[1]!=null).pop();
    if(last) s+=`<circle cx="${x(last[0])}" cy="${yS(ax,last[1])}" r="4" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  s+=`<line id="cursor" x1="0" x2="0" y1="${T}" y2="${T+h}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`;
  svg.setAttribute("viewBox",`0 0 ${W} ${Hh}`); svg.innerHTML=s;
  $("#chartLegend").innerHTML=def.series.map(se=>`<span><i style="background:${se.color}"></i>${se.name} (${se.unit})</span>`).join("")+(def.bands?`<span><i style="background:var(--accent-soft)"></i>Start–stop band</span>`:"");
  svg._rows=rows; svg._x=x; svg._t=[t0,t1,L,w];
}
function chartHover(ev){
  const svg=$("#chart"); if(!svg._rows) return;
  const rect=svg.getBoundingClientRect(), W=+svg.getAttribute("viewBox").split(" ")[2];
  const px=(ev.clientX-rect.left)/rect.width*W, [t0,t1,L,w]=svg._t;
  const t=t0+(px-L)/w*(t1-t0);
  let best=svg._rows[0]; for(const r of svg._rows) if(Math.abs(r[0]-t)<Math.abs(best[0]-t)) best=r;
  const cur=svg.querySelector("#cursor"); cur.setAttribute("x1",svg._x(best[0])); cur.setAttribute("x2",svg._x(best[0])); cur.setAttribute("visibility","visible");
  const def=CHARTS[chartKind];
  $("#chartRead").textContent=(S.time?hhmm(best[0],S.tzMin):"")+"  ·  "+def.series.map(se=>`${se.name} ${best[se.i]<0&&se.i!==2?"—":(best[se.i]/se.div).toFixed(se.div>=100?2:se.div>1?1:0)} ${se.unit}`).join("  ·  ");
}

// ======================================================================
//  Polling
// ======================================================================
let lastHist=0, clockSynced=false;
async function poll(){
  try{
    S = await api.status(); failCount=0;
    if(!demo && !cloud && !S.time && !clockSynced){ clockSynced=true; api.cmd({do:"time",epoch:Math.floor(Date.now()/1000),tz:-new Date().getTimezoneOffset()}).catch(()=>{}); }
    if(!H || Date.now()-lastHist>60000){ H=await api.history(); lastHist=Date.now(); }
  }catch(e){
    if(e.auth) return showLogin(e.message);
    failCount++;
    if(!S) $("#banners").innerHTML=`<div class="banner warn"><div><b>Waiting for the controller</b>${esc(e.message||"No data yet")}</div></div>`;
  }
  render(); drawChart();
}

function startPolling(ms){ clearInterval(pollTimer); pollTimer=setInterval(poll, ms); }

// Where does the data come from?
//  1. Page opened from the ESP32 (hotspot or router)  -> Live, local API
//  2. Hosted page with Firebase configured             -> Cloud (sign-in)
//  3. Otherwise, or with ?demo in the address          -> Demo simulator
async function boot(){
  const wantDemo=/[?&]demo\b/.test(location.search);
  if(location.protocol!=="file:" && !wantDemo){
    try{ S=await Live.status(); }catch(e){ S=null; }
  }
  if(S){ await poll(); return startPolling(2000); }
  if(Cloud.configured() && !wantDemo){
    cloud=true; api=Cloud;
    if(Cloud.stored()){ try{ await Cloud.ensure(); return startCloud(); }catch(e){} }
    return showLogin();
  }
  startDemo();
}
async function startCloud(){ $("#login").hidden=true; S=null; H=null; settingsLoaded=false; await poll(); startPolling(4000); }
async function startDemo(){ clearInterval(pollTimer); cloud=false; demo=true; api=new Sim(); $("#login").hidden=true; S=null; H=null; settingsLoaded=false; await poll(); startPolling(2000); }
function showLogin(msg){
  clearInterval(pollTimer);
  $("#login").hidden=false; $("#loginErr").textContent = msg && msg!=="Please sign in" ? msg : "";
  setTimeout(()=>{ try{ $("#lEmail").focus(); }catch(e){} }, 50);
}
$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const b=$("#loginBtn"); b.disabled=true; b.textContent="Signing in…"; $("#loginErr").textContent="";
  try{ await Cloud.signIn($("#lEmail").value.trim(), $("#lPass").value); $("#lPass").value=""; await startCloud(); }
  catch(err){ $("#loginErr").textContent=err.message; }
  finally{ b.disabled=false; b.textContent="Sign in"; }
});
$("#loginDemo").addEventListener("click",()=>startDemo());
$("#signOut").addEventListener("click",()=>{ Cloud.signOut(); S=null; H=null; showLogin(); });

// ======================================================================
//  Events
// ======================================================================
function showView(name){
  if(!["overview","control","setup","guide"].includes(name)) name="overview";
  document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!=="view-"+name);
  document.querySelectorAll(".tab").forEach(t=>t.setAttribute("aria-selected",t.dataset.view===name));
  if(name==="overview") requestAnimationFrame(drawChart);
}
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{ showView(t.dataset.view); try{ history.replaceState(null,"","#"+t.dataset.view); }catch(e){ location.hash=t.dataset.view; } }));
window.addEventListener("hashchange",()=>showView(location.hash.slice(1)));

$("#pumpBtn").addEventListener("click",()=>{
  if(!S) return;
  const running=S.pump.speed>0||S.pump.target>0;
  if(running) send({do:"stop"},"Pump stopped");
  else send({do:"run",speed:$("#mSpeed").value,minutes:manualMin},`Pump running for ${manualMin} min`);
});
$("#modeAuto").addEventListener("click",()=>send({do:"mode",value:"auto"},"Auto mode on"));
$("#modeManual").addEventListener("click",()=>send({do:"mode",value:"manual"},"Manual mode on: the pump only runs when you press Run"));
$("#mSpeed").addEventListener("input",updateEstimate);
$("#mMinutes").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return; manualMin=+b.dataset.min;
  document.querySelectorAll("#mMinutes button").forEach(x=>x.setAttribute("aria-pressed",x===b)); updateEstimate(); });
document.addEventListener("click",e=>{
  const a=e.target.closest("[data-act]"); if(a){ const act=a.dataset.act;
    if(act==="sync") send({do:"time",epoch:Math.floor(Date.now()/1000),tz:-new Date().getTimezoneOffset()},"Clock set from this phone");
    else send({do:act}); }
  const cal=e.target.closest("[data-cal]"); if(cal) send({do:"calibrate",sensor:cal.dataset.cal,point:cal.dataset.point});
});
document.querySelectorAll("[data-chart]").forEach(b=>b.addEventListener("click",()=>{ chartKind=b.dataset.chart;
  document.querySelectorAll("[data-chart]").forEach(x=>x.setAttribute("aria-pressed",x===b)); $("#chartRead").textContent="Touch or hover the chart to read values."; drawChart(); }));
$("#chart").addEventListener("pointermove",chartHover);
$("#chart").addEventListener("pointerdown",chartHover);
window.addEventListener("resize",()=>drawChart());

$("#trkAuto").addEventListener("click",()=>send({do:"tracker",manual:"0"},"Tracker back to automatic"));
$("#trkManual").addEventListener("click",()=>send({do:"tracker",manual:"1",angle:$("#trkAngle").value},"Tracker in manual mode"));
$("#trkAngle").addEventListener("input",e=>$("#trkAngleOut").textContent=e.target.value+"°");
$("#trkMove").addEventListener("click",()=>send({do:"tracker",manual:"1",angle:$("#trkAngle").value},"Panel moving to "+$("#trkAngle").value+"°"));
$("#syncClock").addEventListener("click",()=>send({do:"time",epoch:Math.floor(Date.now()/1000),tz:-new Date().getTimezoneOffset()},"Clock set from this phone"));
$("#clearAlarm").addEventListener("click",()=>send({do:"clearAlarm"}));

$("#s_crop").addEventListener("change",e=>{ const p=PRESETS[e.target.value]; if(p.startPct!=null){ $("#s_startPct").value=p.startPct; $("#s_targetPct").value=p.targetPct; $("#s_criticalPct").value=p.criticalPct; } updateBand(); });
["s_startPct","s_targetPct","s_criticalPct"].forEach(id=>$("#"+id).addEventListener("input",()=>{ $("#s_crop").value=3; updateBand(); }));
$("#setReload").addEventListener("click",()=>{ if(S){ fillSettings(S.settings); toast("Settings reloaded from controller"); } });
$("#setForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const p={crop:$("#s_crop").value, pulseRunSec:Math.round($("#s_pulseRunMin").value*60), soakSec:Math.round($("#s_soakMin").value*60),
    hotBoost:$("#s_hotBoost").checked?"1":"0", useWindows:$("#s_useWindows").checked?"1":"0", sensorCount:$("#s_sensorCount").value};
  NUM_FIELDS.forEach(k=>p[k]=$("#s_"+k).value);
  try{ const r=await api.saveSettings(p); toast(r.msg||"Settings saved"); await poll(); fillSettings(S.settings); }
  catch(err){ toast(err.message||"Could not save settings"); }
});
$("#wifiForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try{ const r=await api.wifi({ssid:$("#wSsid").value,pass:$("#wPass").value}); toast(r.msg); }catch(err){ toast(err.message); }
});

showView(location.hash.slice(1)||"overview");
boot();
