/* SABnzbd extension: SAB history is the canonical source for successful Usenet downloads. */

const _periodDataBase = periodData;
periodData = function(){
  const p = _periodDataBase();
  p.sabDownloads = (DATA?.sabDownloads || []).filter(inRange);
  return p;
};

const _populateFiltersBase = populateFilters;
populateFilters = function(){
  _populateFiltersBase();
  const sab = DATA?.sabDownloads || [];
  const all = [...(DATA?.movies||[]), ...(DATA?.episodes||[]), ...sab];
  populateSelect("indexer", all.map(x=>x.indexer), "Alle Indexer");
  populateSelect("quality", all.map(x=>x.quality), "Alle Qualitäten");
  populateSelect("group", all.map(x=>x.releaseGroup), "Alle Groups");
  populateSelect("client", all.map(x=>x.downloadClient), "Alle Clients");
  populateSelect("library", all.map(x=>x.library), "Alle Libraries");
  populateSelect("source", sab.map(x=>x.source), "Alle Quellen");
};

const _renderSummaryBase = renderSummary;
renderSummary = function(){
  _renderSummaryBase();
  const p = periodData();
  const sab = p.sabDownloads || [];
  el("usenetTabCount").textContent = `(${sab.length})`;

  if(DATA?.sabConfigured || sab.length){
    const total = sab.reduce((s,x)=>s+(x.size||0),0);
    el("totalSize").textContent = bytes(total);
    const top = countBy(sab,"indexer")[0];
    if(top) el("topIndexer").textContent = `${top[0]} · ${top[1]}`;
  }
};

renderChart = function(){
  const p=periodData();
  const sab=p.sabDownloads||[];
  const items=(DATA?.sabConfigured||sab.length)?sab:[...p.movies,...p.episodes];
  const r=rangeBounds(),days=Math.max(1,Math.ceil((r.to-r.from)/86400000)+1),vals={};
  for(let i=0;i<days;i++){const d=new Date(r.from);d.setDate(d.getDate()+i);vals[dayKey(d)]=0}
  for(const x of items){const k=dayKey(x.date);if(k in vals)vals[k]+=METRIC==="bytes"?(x.size||0):1}
  const max=Math.max(1,...Object.values(vals));
  el("chartTitle").textContent=METRIC==="bytes"?"Datenvolumen pro Tag":"Downloads pro Tag";
  el("chartSubtitle").textContent=(DATA?.sabConfigured||sab.length)
    ? (METRIC==="bytes"?"Erfolgreich von SABnzbd geladenes Datenvolumen":"Alle erfolgreichen SABnzbd-Downloads")
    : (METRIC==="bytes"?"Importiertes Datenvolumen im gewählten Zeitraum":"Importierte Dateien im gewählten Zeitraum");
  el("chart").innerHTML=Object.entries(vals).map(([d,n])=>{
    const label=new Intl.DateTimeFormat("de-DE",{day:"2-digit",month:"2-digit"}).format(new Date(d+"T12:00:00"));
    const shown=METRIC==="bytes"?compactBytes(n):String(n),tip=METRIC==="bytes"?`${label}: ${bytes(n)}`:`${label}: ${n} Downloads`;
    const h=n?Math.max(4,(n/max)*88):1.5;
    return`<div class="bar-wrap" data-tip="${tip}">${n?`<span class="bar-value" style="bottom:calc(${h}% + 6px)">${shown}</span>`:""}<div class="bar" style="height:${h}%"></div></div>`;
  }).join("");
};

function usenetFiltered(items){
  const q=el("search").value.trim().toLowerCase(),source=el("source").value,ix=el("indexer").value,
    qual=el("quality").value,grp=el("group").value,cli=el("client").value,lib=el("library").value,
    up=el("upgrade").value;
  return items.filter(x=>{
    const hay=[x.title,x.originalRelease,x.targetFolder,x.targetFile,x.releaseGroup,x.indexer,x.downloadClient,x.source,x.category,x.nzoId].join(" ").toLowerCase();
    if(q&&!hay.includes(q))return false;
    if(source&&x.source!==source)return false;
    if(ix&&x.indexer!==ix)return false;
    if(qual&&x.quality!==qual)return false;
    if(grp&&x.releaseGroup!==grp)return false;
    if(cli&&x.downloadClient!==cli)return false;
    if(lib&&x.library!==lib)return false;
    if(up==="yes"&&!x.isUpgrade)return false;
    if(up==="no"&&x.isUpgrade)return false;
    return true;
  });
}

function sourceClass(source){
  return source==="RepPollo"?"source-reppollo":source==="Radarr"?"source-radarr":source==="Sonarr"?"source-sonarr":"source-sab";
}

function usenetCard(x){
  const img=x.poster?`<img class="poster" src="${esc(x.poster)}" loading="lazy">`:`<div class="poster usenet-poster">↓</div>`;
  const title=x.arrUrl?`<a class="title-link title" href="${esc(x.arrUrl)}" target="_blank">${esc(x.title)}</a>`:`<div class="title">${esc(x.title)}</div>`;
  return `<article class="item usenet-item">
    ${img}
    <div>
      ${title}
      <div class="meta">${esc(x.category||"Ohne Kategorie")}</div>
      <span class="badge source-badge ${sourceClass(x.source)}">${esc(x.source||"SABnzbd")}</span>
      ${x.indexer?`<span class="badge indexer">${esc(x.indexer)}</span>`:""}
      ${x.quality?`<span class="badge">${esc(x.quality)}</span>`:""}
      ${x.releaseGroup?`<span class="badge">${esc(x.releaseGroup)}</span>`:""}
      ${x.isUpgrade?`<span class="badge upgrade">Upgrade</span>`:""}
    </div>
    <div>
      <div class="label">Original Release / NZB</div>
      <div class="release">${esc(x.originalRelease||"–")}</div>
      <div class="label secondary-label">SABnzbd Kategorie</div>
      <div class="release">${esc(x.category||"–")}</div>
    </div>
    <div>
      <div class="label">Zielpfad</div>
      <div class="path">${esc(x.targetFolder||"–")}</div>
      ${x.nzoId?`<div class="label secondary-label">SAB ID</div><div class="mono subtle-id">${esc(x.nzoId)}</div>`:""}
    </div>
    <div class="right">
      <div class="size">${esc(x.sizeText||bytes(x.size))}</div>
      <div class="date-block"><div class="date-label">Fertig</div><div class="date">${fmtDate(x.completedDate||x.date)}</div></div>
      <button class="details-btn" onclick='showDetails(${JSON.stringify(JSON.stringify(x))})'>Details</button>
    </div>
  </article>`;
}

function renderUsenetList(){
  let items=usenetFiltered([...(periodData().sabDownloads||[])]);
  sortItems(items);
  CURRENT=items;
  el("empty").hidden=items.length!==0;
  el("list").innerHTML=items.map(usenetCard).join("");
  renderChips();
}

const _renderListBase=renderList;
renderList=function(){
  if(TAB==="usenet"){renderUsenetList();return}
  _renderListBase();
};

const _renderTabBase=renderTab;
renderTab=function(){
  if(TAB==="usenet"){
    el("indexerPage").hidden=true;
    el("mediaFilters").hidden=false;
    el("list").hidden=false;
    el("empty").hidden=true;
    renderUsenetList();
    return;
  }
  _renderTabBase();
};

function seasonPackName(name){
  return /(?:^|[. _-])S(?:eason[. _-]?)?\d{1,2}(?!E\d)/i.test(name||"") || /complete[. _-]?(?:season|s\d)/i.test(name||"");
}

indexerStats=function(){
  const p=periodData();
  const arrGrabMap=new Map();
  for(const g of p.grabs||[]){if(!arrGrabMap.has(g.grabKey))arrGrabMap.set(g.grabKey,g)}

  const sabMap=new Map();
  for(const d of p.sabDownloads||[]){
    const k=d.nzoId||d.downloadId||`${d.originalRelease}:${d.timestamp}`;
    if(!sabMap.has(k))sabMap.set(k,d);
  }

  const syntheticGrabs=new Map(arrGrabMap);
  for(const [k,d] of sabMap){
    if(!syntheticGrabs.has(k))syntheticGrabs.set(k,{grabKey:k,indexer:d.indexer||"Unbekannt",mediaKind:d.mediaKind,title:d.title});
  }

  const names=[...new Set([
    ...[...syntheticGrabs.values()].map(x=>x.indexer||"Unbekannt"),
    ...[...sabMap.values()].map(x=>x.indexer||"Unbekannt")
  ])];

  return names.map(name=>{
    const grabs=[...syntheticGrabs.values()].filter(x=>(x.indexer||"Unbekannt")===name);
    const downloads=[...sabMap.values()].filter(x=>(x.indexer||"Unbekannt")===name);
    const movies=downloads.filter(x=>x.mediaKind==="movie");
    const series=downloads.filter(x=>x.mediaKind==="series");
    const episodeRows=(p.episodes||[]).filter(x=>(x.indexer||"Unbekannt")===name);
    return {
      name,
      grabs:grabs.length,
      downloads:downloads.length,
      rate:grabs.length?downloads.length/grabs.length*100:0,
      movies:new Set(movies.map(x=>x.title)).size,
      series:new Set(series.map(x=>x.title)).size,
      episodes:episodeRows.length,
      packs:downloads.filter(x=>x.releaseType==="season_pack"||seasonPackName(x.originalRelease)).length,
      volume:downloads.reduce((s,x)=>s+(x.size||0),0)
    };
  });
};

const _renderChipsBase=renderChips;
renderChips=function(){
  _renderChipsBase();
  const source=el("source").value;
  if(source){
    const chip=document.createElement("span");chip.className="chip";chip.textContent=`Quelle: ${source}`;el("activeFilters").prepend(chip);
  }
};

const _clearFiltersBase=clearFilters;
clearFilters=function(){el("source").value="";_clearFiltersBase()};

const _showDetailsBase=showDetails;
showDetails=function(raw){
  const x=JSON.parse(raw);
  if(x.kind!=="usenet"){_showDetailsBase(raw);return}
  const fields=[
    ["Titel",x.title],["Quelle",x.source],["Release / NZB",x.originalRelease],["Indexer",x.indexer],
    ["SAB Kategorie",x.category],["SAB ID",x.nzoId],["Qualität",x.quality],["Release Group",x.releaseGroup],
    ["Fertig",fmtDate(x.completedDate||x.date)],["Zielpfad",x.targetFolder],["Größe",x.sizeText||bytes(x.size)]
  ];
  el("detailsBody").innerHTML=`<h2>${esc(x.title)}</h2><dl>${fields.filter(v=>v[1]).map(([k,v])=>`<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join("")}</dl>${x.arrUrl?`<a class="arr-button" target="_blank" href="${esc(x.arrUrl)}">In ${x.mediaKind==="movie"?"Radarr":"Sonarr"} öffnen ↗</a>`:""}`;
  el("details").showModal();
};
window.showDetails=showDetails;

el("source")?.addEventListener("input",()=>{if(TAB==="usenet")renderUsenetList();else renderList()});
