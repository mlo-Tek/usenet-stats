let DATA = null;
let TAB = "movies";

const el = id => document.getElementById(id);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));

const bytes = n => {
  if (!n) return "0 B";
  const u=["B","KB","MB","GB","TB"];
  let i=0,v=Number(n);
  while(v>=1024 && i<u.length-1){v/=1024;i++}
  return `${v.toFixed(i<2?0:1)} ${u[i]}`;
};

const fmtDate = d => d ? new Intl.DateTimeFormat("de-DE",{
  dateStyle:"medium",
  timeStyle:"short"
}).format(new Date(d)) : "–";

function currentDays(){ return Number(el("days").value); }
function cutoffTimestamp(days){ return Date.now() - days * 86400000; }

function periodData(){
  if(!DATA) return {movies:[], episodes:[]};
  const cutoff = cutoffTimestamp(currentDays());
  return {
    movies: DATA.movies.filter(x => new Date(x.date).getTime() >= cutoff),
    episodes: DATA.episodes.filter(x => new Date(x.date).getTime() >= cutoff)
  };
}

async function load(force=false){
  el("error").hidden=true;
  el("refresh").disabled=true;
  try{
    const r=await fetch(`/api/stats${force?"?refresh=1":""}`);
    const j=await r.json();
    if(!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    DATA=j;
    renderAll();
  }catch(e){
    el("error").textContent="Fehler: "+e.message;
    el("error").hidden=false;
  }finally{
    el("refresh").disabled=false;
  }
}

function renderAll(){
  renderSummary();
  renderChart();
  renderList();
}

function renderSummary(){
  const p=periodData();
  const movieBytes=p.movies.reduce((s,x)=>s+(x.size||0),0);
  const episodeBytes=p.episodes.reduce((s,x)=>s+(x.size||0),0);
  const seriesCount=new Set(p.episodes.map(x=>x.title)).size;

  el("movieCount").textContent=p.movies.length;
  el("episodeCount").textContent=p.episodes.length;
  el("seriesCount").textContent=seriesCount;
  el("movieSize").textContent=bytes(movieBytes);
  el("episodeSize").textContent=bytes(episodeBytes);
  el("totalSize").textContent=bytes(movieBytes+episodeBytes);
  el("generated").textContent="Stand "+fmtDate(DATA.generatedAt);
  el("movieTabCount").textContent=`(${p.movies.length})`;
  el("episodeTabCount").textContent=`(${p.episodes.length})`;
}

function renderChart(){
  const p=periodData();
  const days=currentDays();
  const counts={};

  for(let i=days-1;i>=0;i--){
    const d=new Date();
    d.setHours(0,0,0,0);
    d.setDate(d.getDate()-i);
    const y=d.getFullYear();
    const m=String(d.getMonth()+1).padStart(2,"0");
    const day=String(d.getDate()).padStart(2,"0");
    counts[`${y}-${m}-${day}`]=0;
  }

  [...p.movies,...p.episodes].forEach(x=>{
    const d=new Date(x.date);
    const y=d.getFullYear();
    const m=String(d.getMonth()+1).padStart(2,"0");
    const day=String(d.getDate()).padStart(2,"0");
    const k=`${y}-${m}-${day}`;
    if(k in counts) counts[k]++;
  });

  const vals=Object.values(counts);
  const max=Math.max(1,...vals);

  el("chart").innerHTML=Object.entries(counts).map(([d,n])=>{
    const label=new Intl.DateTimeFormat("de-DE",{
      day:"2-digit",month:"2-digit"
    }).format(new Date(d+"T12:00:00"));

    return `<div class="bar-wrap" data-tip="${label}: ${n}">
      <div class="bar" style="height:${Math.max(2,n/max*100)}%"></div>
    </div>`;
  }).join("");
}

function renderList(){
  if(!DATA) return;

  const p=periodData();
  let items=[...(TAB==="movies"?p.movies:p.episodes)];

  const q=el("search").value.trim().toLowerCase();
  const qual=el("quality").value;

  if(q){
    items=items.filter(x=>[
      x.title,x.episodeCode,x.episodeTitle,x.originalRelease,
      x.targetFolder,x.targetFile,x.releaseGroup,x.indexer,x.downloadClient
    ].join(" ").toLowerCase().includes(q));
  }

  if(qual){
    items=items.filter(x=>
      (x.quality||"").includes(qual) ||
      (x.originalRelease||"").includes(qual)
    );
  }

  const sort=el("sort").value;

  items.sort((a,b)=>
    sort==="oldest" ? a.timestamp-b.timestamp :
    sort==="size" ? b.size-a.size :
    sort==="title" ? a.title.localeCompare(b.title,"de") :
    b.timestamp-a.timestamp
  );

  el("empty").hidden=items.length!==0;

  el("list").innerHTML=items.map(x=>{
    const subtitle=x.kind==="movie"
      ? `${esc(x.year||"")}`
      : `${esc(x.episodeCode)}${x.episodeTitle?" · "+esc(x.episodeTitle):""}`;

    const img=x.poster
      ? `<img class="poster" src="${esc(x.poster)}" loading="lazy">`
      : `<div class="poster"></div>`;

    return `<article class="item">
      ${img}

      <div>
        <div class="title">${esc(x.title)}</div>
        <div class="meta">${subtitle}</div>

        ${x.quality?`<span class="badge">${esc(x.quality)}</span>`:""}
        ${x.releaseGroup?`<span class="badge">${esc(x.releaseGroup)}</span>`:""}
        ${x.indexer?`<span class="badge indexer">Indexer: ${esc(x.indexer)}</span>`:""}
        ${x.isUpgrade?`<span class="badge upgrade">Upgrade</span>`:""}
      </div>

      <div>
        <div class="label">Original Release</div>
        <div class="release">${esc(x.originalRelease||"–")}</div>
        ${x.downloadClient?`
          <div class="label secondary-label">Download Client</div>
          <div class="release">${esc(x.downloadClient)}</div>
        `:""}
      </div>

      <div>
        <div class="label">Zielordner auf Unraid</div>
        <div class="path">${esc(x.targetFolder||"–")}</div>
        ${x.targetFile?`<div class="path path-file">${esc(x.targetFile)}</div>`:""}
      </div>

      <div class="right">
        <div class="size">${esc(x.sizeText||bytes(x.size))}</div>

        <div class="date-block">
          <div class="date-label">Grab</div>
          <div class="date">${fmtDate(x.grabDate || x.date)}</div>
        </div>

        <div class="date-block import-time">
          <div class="date-label">Import</div>
          <div class="date">${fmtDate(x.importDate)}</div>
        </div>
      </div>
    </article>`;
  }).join("");
}

document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  TAB=b.dataset.tab;
  renderList();
}));

["search","quality","sort"].forEach(id=>
  el(id).addEventListener("input",renderList)
);

el("days").addEventListener("change",renderAll);
el("refresh").addEventListener("click",()=>load(true));

load(false);
