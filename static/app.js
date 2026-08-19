let DATA=null,TAB="movies",METRIC="count",CUSTOM_RANGE=null,CURRENT=[];

const el=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const bytes=n=>{if(!n)return"0 B";const u=["B","KB","MB","GB","TB"];let i=0,v=Number(n);while(v>=1024&&i<u.length-1){v/=1024;i++}return`${v.toFixed(i<2?0:1)} ${u[i]}`};
const compactBytes=n=>{if(!n)return"0";const u=["B","K","M","G","T"];let i=0,v=Number(n);while(v>=1024&&i<u.length-1){v/=1024;i++}return`${v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(1)}${u[i]}`};
const fmtDate=d=>d?new Intl.DateTimeFormat("de-DE",{dateStyle:"medium",timeStyle:"short"}).format(new Date(d)):"–";
const dayKey=d=>{d=new Date(d);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`};

function rangeBounds(){
  if(CUSTOM_RANGE)return CUSTOM_RANGE;
  const days=Number(el("days").value||30),to=new Date();
  return{from:new Date(to.getTime()-days*86400000),to};
}
function inRange(x){const r=rangeBounds(),t=new Date(x.date).getTime();return t>=r.from.getTime()&&t<=r.to.getTime()}
function periodData(){
  if(!DATA)return{movies:[],episodes:[],failed:[],grabs:[]};
  return{movies:(DATA.movies||[]).filter(inRange),episodes:(DATA.episodes||[]).filter(inRange),failed:(DATA.failed||[]).filter(inRange),grabs:(DATA.grabs||[]).filter(inRange)};
}

async function load(force=false){
  el("error").hidden=true;el("refresh").disabled=true;
  try{const r=await fetch(`/api/stats${force?"?refresh=1":""}`),j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);DATA=j;populateFilters();renderAll()}
  catch(e){el("error").textContent="Fehler: "+e.message;el("error").hidden=false}
  finally{el("refresh").disabled=false}
}

function populateSelect(id,values,label){
  const s=el(id),old=s.value;const vals=[...new Set(values.filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),"de"));
  s.innerHTML=`<option value="">${label}</option>`+vals.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if(vals.includes(old))s.value=old;
}
function populateFilters(){
  const all=[...(DATA.movies||[]),...(DATA.episodes||[])];
  populateSelect("indexer",all.map(x=>x.indexer),"Alle Indexer");populateSelect("quality",all.map(x=>x.quality),"Alle Qualitäten");
  populateSelect("group",all.map(x=>x.releaseGroup),"Alle Groups");populateSelect("client",all.map(x=>x.downloadClient),"Alle Clients");populateSelect("library",all.map(x=>x.library),"Alle Libraries");
}

function renderAll(){renderSummary();renderChart();renderTab();}
function countBy(items,key){const m={};for(const x of items){const v=x[key]||"Unbekannt";m[v]=(m[v]||0)+1}return Object.entries(m).sort((a,b)=>b[1]-a[1])}
function renderSummary(){
  const p=periodData(),mb=p.movies.reduce((s,x)=>s+(x.size||0),0),eb=p.episodes.reduce((s,x)=>s+(x.size||0),0);
  el("movieCount").textContent=p.movies.length;el("episodeCount").textContent=p.episodes.length;el("seriesCount").textContent=new Set(p.episodes.map(x=>x.seriesId||x.title)).size;
  el("movieSize").textContent=bytes(mb);el("episodeSize").textContent=bytes(eb);el("totalSize").textContent=bytes(mb+eb);el("generated").textContent="Stand "+fmtDate(DATA.generatedAt);
  el("movieTabCount").textContent=`(${p.movies.length})`;el("episodeTabCount").textContent=`(${p.episodes.length})`;el("failedTabCount").textContent=`(${p.failed.length})`;
  el("indexerTabCount").textContent=`(${new Set(p.grabs.map(x=>x.indexer||"Unbekannt")).size})`;
  const all=[...p.movies,...p.episodes],topI=countBy(all,"indexer")[0],topG=countBy(all,"releaseGroup")[0];
  el("topIndexer").textContent=topI?`${topI[0]} · ${topI[1]}`:"–";el("topGroup").textContent=topG?`${topG[0]} · ${topG[1]}`:"–";
  el("upgradeCount").textContent=all.filter(x=>x.isUpgrade).length;el("packCount").textContent=new Set(p.episodes.filter(x=>x.releaseType==="season_pack").map(x=>x.grabKey||x.originalRelease)).size;
}

function renderChart(){
  const p=periodData(),items=[...p.movies,...p.episodes],r=rangeBounds(),days=Math.max(1,Math.ceil((r.to-r.from)/86400000)+1),vals={};
  for(let i=0;i<days;i++){const d=new Date(r.from);d.setDate(d.getDate()+i);vals[dayKey(d)]=0}
  for(const x of items){const k=dayKey(x.date);if(k in vals)vals[k]+=METRIC==="bytes"?(x.size||0):1}
  const max=Math.max(1,...Object.values(vals));
  el("chartTitle").textContent=METRIC==="bytes"?"Datenvolumen pro Tag":"Downloads pro Tag";
  el("chartSubtitle").textContent=METRIC==="bytes"?"Importiertes Datenvolumen im gewählten Zeitraum":"Importierte Dateien im gewählten Zeitraum";
  el("chart").innerHTML=Object.entries(vals).map(([d,n])=>{const label=new Intl.DateTimeFormat("de-DE",{day:"2-digit",month:"2-digit"}).format(new Date(d+"T12:00:00"));const shown=METRIC==="bytes"?compactBytes(n):String(n);const tip=METRIC==="bytes"?`${label}: ${bytes(n)}`:`${label}: ${n} Downloads`;return`<div class="bar-wrap" data-tip="${tip}">${n?`<span class="bar-value">${shown}</span>`:""}<div class="bar" style="height:${n?Math.max(3,n/max*100):2}%"></div></div>`}).join("");
}

function baseFiltered(items){
  const q=el("search").value.trim().toLowerCase(),ix=el("indexer").value,qual=el("quality").value,grp=el("group").value,cli=el("client").value,lib=el("library").value,up=el("upgrade").value,typ=el("seriesType").value;
  return items.filter(x=>{
    if(q&&![x.title,x.episodeCode,x.episodeTitle,x.originalRelease,x.targetFolder,x.targetFile,x.releaseGroup,x.indexer,x.downloadClient].join(" ").toLowerCase().includes(q))return false;
    if(ix&&x.indexer!==ix)return false;if(qual&&x.quality!==qual)return false;if(grp&&x.releaseGroup!==grp)return false;if(cli&&x.downloadClient!==cli)return false;if(lib&&x.library!==lib)return false;
    if(up==="yes"&&!x.isUpgrade)return false;if(up==="no"&&x.isUpgrade)return false;if(TAB==="episodes"&&typ&&x.releaseType!==typ)return false;return true;
  });
}
function sortItems(items){const s=el("sort").value;return items.sort((a,b)=>s==="oldest"?a.timestamp-b.timestamp:s==="size"?(b.size||0)-(a.size||0):s==="title"?a.title.localeCompare(b.title,"de"):s==="titleDesc"?b.title.localeCompare(a.title,"de"):b.timestamp-a.timestamp)}
function groupSeriesItems(items){
  const groups=new Map();for(const x of items){const k=x.seriesId||x.title;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)}
  return [...groups.values()].map(g=>{const newest=[...g].sort((a,b)=>b.timestamp-a.timestamp)[0];return{...newest,grouped:true,episodeCount:g.length,size:g.reduce((s,x)=>s+(x.size||0),0),sizeText:bytes(g.reduce((s,x)=>s+(x.size||0),0)),originalRelease:`${g.length} Episoden im Zeitraum`,releaseType:g.some(x=>x.releaseType==="season_pack")?"season_pack":"episode"}})
}

function renderTab(){
  const indexerMode=TAB==="indexers";el("indexerPage").hidden=!indexerMode;el("mediaFilters").hidden=indexerMode;el("list").hidden=indexerMode;el("empty").hidden=true;
  if(indexerMode){renderIndexerPage();return}renderList();
}
function renderList(){
  const p=periodData();let items=TAB==="movies"?[...p.movies]:TAB==="episodes"?[...p.episodes]:[...p.failed];
  if(TAB!=="failed")items=baseFiltered(items);else{const q=el("search").value.trim().toLowerCase();if(q)items=items.filter(x=>[x.title,x.originalRelease,x.indexer,x.reason].join(" ").toLowerCase().includes(q))}
  if(TAB==="episodes"&&el("groupSeries").checked)items=groupSeriesItems(items);sortItems(items);CURRENT=items;el("empty").hidden=items.length!==0;
  el("list").innerHTML=items.map(cardHtml).join("");renderChips();
}
function cardHtml(x){
  const img=x.poster?`<img class="poster" src="${esc(x.poster)}" loading="lazy">`:`<div class="poster"></div>`;
  if(x.kind==="failed")return`<article class="item failed-item">${img}<div><a class="title-link title" href="${esc(x.arrUrl||"#")}" target="_blank">${esc(x.title)}</a><div class="meta">${esc(x.year||"")}</div><span class="badge fail">Fehlgeschlagen</span>${x.indexer?`<span class="badge indexer">${esc(x.indexer)}</span>`:""}</div><div><div class="label">Release</div><div class="release">${esc(x.originalRelease||"–")}</div></div><div><div class="label">Grund</div><div class="reason">${esc(x.reason||"–")}</div></div><div class="right"><div class="date">${fmtDate(x.date)}</div></div></article>`;
  const subtitle=x.kind==="movie"?esc(x.year||""):x.grouped?`${x.episodeCount} Episoden`: `${esc(x.episodeCode||"")}${x.episodeTitle?" · "+esc(x.episodeTitle):""}`;
  return`<article class="item">${img}<div><a class="title-link title" href="${esc(x.arrUrl||"#")}" target="_blank">${esc(x.title)}</a><div class="meta">${subtitle}</div>${x.quality?`<span class="badge">${esc(x.quality)}</span>`:""}${x.releaseGroup?`<span class="badge">${esc(x.releaseGroup)}</span>`:""}${x.indexer?`<span class="badge indexer">${esc(x.indexer)}</span>`:""}${x.releaseType==="season_pack"?`<span class="badge pack">Season Pack</span>`:""}${x.isUpgrade?`<span class="badge upgrade">Upgrade</span>`:""}</div><div><div class="label">Original Release</div><div class="release">${esc(x.originalRelease||"–")}</div>${x.downloadClient?`<div class="label secondary-label">Download Client</div><div class="release">${esc(x.downloadClient)}</div>`:""}</div><div><div class="label">Zielordner auf Unraid</div><div class="path">${esc(x.targetFolder||"–")}</div>${x.targetFile?`<div class="path path-file">${esc(x.targetFile)}</div>`:""}</div><div class="right"><div class="size">${esc(x.sizeText||bytes(x.size))}</div><div class="date-block"><div class="date-label">Grab</div><div class="date">${fmtDate(x.grabDate||x.date)}</div></div><div class="date-block import-time"><div class="date-label">Import</div><div class="date">${fmtDate(x.importDate)}</div></div><button class="details-btn" onclick='showDetails(${JSON.stringify(JSON.stringify(x))})'>Details</button></div></article>`;
}

function indexerStats(){
  const p=periodData(),grabMap=new Map();for(const g of p.grabs){if(!grabMap.has(g.grabKey))grabMap.set(g.grabKey,g)}
  const imports=[...p.movies,...p.episodes],importByGrab=new Map();for(const x of imports){if(!importByGrab.has(x.grabKey))importByGrab.set(x.grabKey,[]);importByGrab.get(x.grabKey).push(x)}
  const names=[...new Set([...grabMap.values()].map(g=>g.indexer||"Unbekannt"))];
  return names.map(name=>{
    const grabs=[...grabMap.values()].filter(g=>(g.indexer||"Unbekannt")===name),keys=new Set(grabs.map(g=>g.grabKey)),successful=[...keys].filter(k=>importByGrab.has(k));
    const rows=successful.flatMap(k=>importByGrab.get(k)||[]),movies=rows.filter(x=>x.kind==="movie"),eps=rows.filter(x=>x.kind==="episode");
    return{name,grabs:grabs.length,downloads:successful.length,rate:grabs.length?successful.length/grabs.length*100:0,movies:new Set(movies.map(x=>x.movieId||x.title)).size,series:new Set(eps.map(x=>x.seriesId||x.title)).size,episodes:eps.length,packs:new Set(eps.filter(x=>x.releaseType==="season_pack").map(x=>x.grabKey)).size,volume:rows.reduce((s,x)=>s+(x.size||0),0)};
  });
}
function renderIndexerPage(){
  let stats=indexerStats();const q=el("indexerSearch").value.trim().toLowerCase();if(q)stats=stats.filter(x=>x.name.toLowerCase().includes(q));const s=el("indexerSort").value;
  stats.sort((a,b)=>s==="downloads"?b.downloads-a.downloads:s==="rate"?b.rate-a.rate:s==="volume"?b.volume-a.volume:s==="name"?a.name.localeCompare(b.name,"de"):b.grabs-a.grabs);
  const totalGrabs=stats.reduce((n,x)=>n+x.grabs,0),totalDownloads=stats.reduce((n,x)=>n+x.downloads,0);el("allGrabs").textContent=totalGrabs;el("allDownloads").textContent=totalDownloads;el("allSuccessRate").textContent=totalGrabs?`${(totalDownloads/totalGrabs*100).toFixed(1)} %`:"–";el("activeIndexerCount").textContent=stats.length;
  const r=rangeBounds();el("indexerPeriod").textContent=`${new Intl.DateTimeFormat("de-DE").format(r.from)} – ${new Intl.DateTimeFormat("de-DE").format(r.to)}`;
  el("indexerTableBody").innerHTML=stats.map(x=>`<tr><td><strong>${esc(x.name)}</strong></td><td>${x.grabs}</td><td>${x.downloads}</td><td><span class="rate-pill">${x.rate.toFixed(1)} %</span></td><td>${x.movies}</td><td>${x.series}</td><td>${x.episodes}</td><td>${x.packs}</td><td>${bytes(x.volume)}</td></tr>`).join("");
}

function renderChips(){const defs=[["indexer","Indexer"],["quality","Qualität"],["group","Group"],["client","Client"],["library","Library"],["seriesType","Typ"],["upgrade","Upgrade"]],chips=[];for(const[id,l]of defs){const v=el(id).value;if(v)chips.push(`${l}: ${v}`)}if(CUSTOM_RANGE)chips.push("Eigener Zeitraum");el("activeFilters").innerHTML=chips.map(x=>`<span class="chip">${esc(x)}</span>`).join("")}
function clearFilters(){for(const id of["search","indexer","quality","group","client","library","seriesType","upgrade"])el(id).value="";el("sort").value="newest";CUSTOM_RANGE=null;el("dateFrom").value="";el("dateTo").value="";renderAll()}
function setQuick(which){const now=new Date(),start=new Date(now),end=new Date(now);if(which==="today"){start.setHours(0,0,0,0);end.setHours(23,59,59,999)}else if(which==="yesterday"){start.setDate(start.getDate()-1);start.setHours(0,0,0,0);end.setDate(end.getDate()-1);end.setHours(23,59,59,999)}else{const day=(now.getDay()+6)%7;start.setDate(now.getDate()-day);start.setHours(0,0,0,0);end.setHours(23,59,59,999)}CUSTOM_RANGE={from:start,to:end};renderAll()}
function applyDates(){if(!el("dateFrom").value||!el("dateTo").value)return;CUSTOM_RANGE={from:new Date(el("dateFrom").value+"T00:00:00"),to:new Date(el("dateTo").value+"T23:59:59")};renderAll()}
function showDetails(raw){const x=JSON.parse(raw),fields=[["Titel",x.title],["Release",x.originalRelease],["Indexer",x.indexer],["Download Client",x.downloadClient],["Qualität",x.quality],["Release Group",x.releaseGroup],["Grab",fmtDate(x.grabDate||x.date)],["Import",fmtDate(x.importDate)],["Zielordner",x.targetFolder],["Zieldatei",x.targetFile],["Größe",x.sizeText||bytes(x.size)]];el("detailsBody").innerHTML=`<h2>${esc(x.title)}</h2><dl>${fields.filter(x=>x[1]).map(([k,v])=>`<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join("")}</dl>${x.arrUrl?`<a class="arr-button" target="_blank" href="${esc(x.arrUrl)}">In ${x.kind==="movie"?"Radarr":"Sonarr"} öffnen ↗</a>`:""}`;el("details").showModal()}
window.showDetails=showDetails;
function exportData(type){const data=CURRENT;if(type==="json"){downloadBlob(JSON.stringify(data,null,2),"usenet-stats.json","application/json");return}const cols=["kind","title","year","episodeCode","originalRelease","indexer","quality","releaseGroup","downloadClient","targetFolder","targetFile","size","grabDate","importDate"];const csv=[cols.join(";")].concat(data.map(x=>cols.map(c=>`"${String(x[c]??"").replaceAll('"','""')}"`).join(";"))).join("\n");downloadBlob(csv,"usenet-stats.csv","text/csv;charset=utf-8")}
function downloadBlob(content,name,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

for(const b of document.querySelectorAll(".tab"))b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));b.classList.add("active");TAB=b.dataset.tab;renderTab()});
for(const b of document.querySelectorAll(".metric"))b.addEventListener("click",()=>{document.querySelectorAll(".metric").forEach(x=>x.classList.remove("active"));b.classList.add("active");METRIC=b.dataset.metric;renderChart()});
for(const id of["search","indexer","quality","group","client","library","seriesType","upgrade","sort","groupSeries"])el(id).addEventListener("input",renderList);
el("compact").addEventListener("change",()=>document.body.classList.toggle("compact",el("compact").checked));el("days").addEventListener("change",()=>{CUSTOM_RANGE=null;renderAll()});el("refresh").addEventListener("click",()=>load(true));
document.querySelectorAll(".quick").forEach(b=>b.addEventListener("click",()=>setQuick(b.dataset.range)));el("applyDates").addEventListener("click",applyDates);el("clearFilters").addEventListener("click",clearFilters);el("preset4k").addEventListener("click",()=>{const q=[...el("quality").options].find(o=>/2160/i.test(o.value));if(q)el("quality").value=q.value;el("search").value="WEB";renderList()});el("exportCsv").addEventListener("click",()=>exportData("csv"));el("exportJson").addEventListener("click",()=>exportData("json"));el("closeDetails").addEventListener("click",()=>el("details").close());el("indexerSearch").addEventListener("input",renderIndexerPage);el("indexerSort").addEventListener("change",renderIndexerPage);
load(false);
