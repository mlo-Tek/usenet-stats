/* Usenet Stats v4 — compact dashboard frontend.
 * The legacy UI remains in the DOM as the data/refresh engine; this layer owns
 * the visible dashboard so existing Radarr/Sonarr/SAB logic stays intact.
 */
(() => {
  const PAGE_SIZE = 20;
  const SIDEBAR_KEY = "usenet-stats-v4-sidebar-collapsed";
  const state = {
    initialized: false,
    view: "downloads",
    kind: "all",
    page: 1,
    search: "",
    quality: "",
    group: "",
    indexer: "",
    source: "",
    library: "",
    onlyNotRhd: false,
    range: {mode: "days", days: 7, label: "Letzte 7 Tage"},
    customFrom: "",
    customTo: "",
    calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    calendarOpen: false,
    expanded: new Set(),
    rhd: new Map(),
    rhdPending: new Set(),
    rhdConfigured: null,
  };

  const legacyRenderAll = typeof renderAll === "function" ? renderAll : null;
  if (legacyRenderAll) {
    renderAll = function(...args) {
      const result = legacyRenderAll.apply(this, args);
      if (state.initialized) queueMicrotask(renderV4);
      return result;
    };
  }

  const htmlEscape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const norm = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const number = value => Number(value || 0) || 0;

  function buildShell() {
    const root = document.createElement("div");
    root.id = "v4App";
    root.innerHTML = `
      <aside class="v4-sidebar">
        <div class="v4-brand">
          <div class="v4-brand-icon">↓</div>
          <div class="v4-brand-copy"><div class="v4-brand-title">Usenet Stats</div><div class="v4-brand-sub">Übersichtlich. Einfach. Schnell.</div></div>
        </div>
        <nav class="v4-nav">
          <button class="v4-nav-btn active" data-nav="overview"><span class="v4-nav-icon">⌂</span><span class="v4-nav-label">Übersicht</span></button>
          <button class="v4-nav-btn" data-nav="all"><span class="v4-nav-icon">⇩</span><span class="v4-nav-label">Alle Downloads</span><span class="v4-nav-count" id="v4AllCount"></span></button>
          <button class="v4-nav-btn" data-nav="movies"><span class="v4-nav-icon">▣</span><span class="v4-nav-label">Filme</span><span class="v4-nav-count" id="v4MovieCountNav"></span></button>
          <button class="v4-nav-btn" data-nav="series"><span class="v4-nav-icon">▭</span><span class="v4-nav-label">Serien</span><span class="v4-nav-count" id="v4SeriesCountNav"></span></button>
          <div class="v4-nav-sep"></div>
          <button class="v4-nav-btn" data-nav="stats"><span class="v4-nav-icon">▥</span><span class="v4-nav-label">Statistiken</span></button>
          <button class="v4-nav-btn" data-nav="settings"><span class="v4-nav-icon">⚙</span><span class="v4-nav-label">Einstellungen</span></button>
        </nav>
        <div class="v4-side-bottom">
          <button class="v4-collapse" id="v4Collapse" type="button" title="Menü ein-/ausklappen">«</button>
          <div class="v4-side-text">
            <div class="v4-online"><span class="v4-online-dot"></span><span id="v4OnlineText">Alle Systeme online</span></div>
            <div>Letztes Update</div><div id="v4Updated">–</div><div style="margin-top:7px">v0.4.0</div>
          </div>
        </div>
      </aside>
      <main class="v4-main">
        <div class="v4-main-inner">
          <section class="v4-download-page">
            <div class="v4-topline">
              <div class="v4-page-title"><h1 id="v4Heading">Downloads</h1><p id="v4Subheading">Deine Usenet Downloads</p></div>
              <div class="v4-top-actions">
                <div class="v4-search-wrap"><input id="v4Search" class="v4-search" type="search" placeholder="Titel oder Release suchen …"></div>
                <button id="v4DateButton" class="v4-control v4-date-button" type="button">▣ <span id="v4DateLabel">Letzte 7 Tage</span>⌄</button>
                <button class="v4-control" type="button" title="Es werden immer höchstens 20 Einträge angezeigt">20 pro Seite⌄</button>
                <button id="v4Reset" class="v4-control v4-reset" type="button">Filter zurücksetzen</button>
                <div id="v4Calendar" class="v4-calendar-pop" hidden></div>
              </div>
            </div>
            <div class="v4-filterbar">
              <select id="v4Quality"><option value="">Qualität</option></select>
              <select id="v4Group"><option value="">Group</option></select>
              <select id="v4Indexer"><option value="">Indexer</option></select>
              <select id="v4Source"><option value="">Quelle</option></select>
              <select id="v4Library"><option value="">Library</option></select>
              <label class="v4-rhd-only"><input id="v4OnlyNotRhd" type="checkbox"> Nur nicht auf RHD</label>
            </div>
            <div class="v4-list-wrap">
              <div class="v4-list-head"><div>Titel</div><div>Staffel</div><div>Qualität</div><div>Größe</div><div>Alter</div><div>Quelle / RHD</div></div>
              <div id="v4List"></div>
              <div id="v4Empty" class="empty" hidden>Keine passenden Einträge gefunden.</div>
              <div class="v4-pagination"><div class="v4-page-summary" id="v4PageSummary"></div><div class="v4-page-buttons" id="v4Pages"></div></div>
              <div class="v4-legend"><span>⚡ = <b>ARR</b></span><span>⚙ = <b>Kryo</b></span><span>▶ = <b>rePollo</b></span><span style="color:#25e884">●</span><span>= auf RHD</span><span style="color:#ff4055">⊘</span><span>= nicht auf RHD</span></div>
            </div>
          </section>
          <section class="v4-stats-page" id="v4StatsPage"></section>
          <section class="v4-settings-page" id="v4SettingsPage"></section>
        </div>
      </main>`;
    document.body.insertBefore(root, document.body.firstChild);
    document.body.classList.add("v4-enabled");
    if (localStorage.getItem(SIDEBAR_KEY) === "1") root.classList.add("sidebar-collapsed");
  }

  function bindUi() {
    document.querySelectorAll(".v4-nav-btn").forEach(button => button.addEventListener("click", () => navigate(button.dataset.nav)));
    document.getElementById("v4Collapse").addEventListener("click", () => {
      const root = document.getElementById("v4App");
      root.classList.toggle("sidebar-collapsed");
      localStorage.setItem(SIDEBAR_KEY, root.classList.contains("sidebar-collapsed") ? "1" : "0");
    });
    document.getElementById("v4Search").addEventListener("input", e => { state.search = e.target.value; resetPage(); });
    ["Quality","Group","Indexer","Source","Library"].forEach(name => {
      document.getElementById(`v4${name}`).addEventListener("change", e => { state[name.toLowerCase()] = e.target.value; resetPage(); });
    });
    document.getElementById("v4OnlyNotRhd").addEventListener("change", async e => {
      state.onlyNotRhd = e.target.checked;
      state.page = 1;
      if (state.onlyNotRhd) await ensureRhdStatuses(prepareItems(false).slice(0, 100));
      renderV4();
    });
    document.getElementById("v4Reset").addEventListener("click", resetFilters);
    document.getElementById("v4DateButton").addEventListener("click", e => {
      e.stopPropagation();
      state.calendarOpen = !state.calendarOpen;
      renderCalendar();
    });
    document.addEventListener("click", event => {
      if (!state.calendarOpen) return;
      const calendar = document.getElementById("v4Calendar");
      const button = document.getElementById("v4DateButton");
      if (!calendar.contains(event.target) && !button.contains(event.target)) {
        state.calendarOpen = false;
        renderCalendar();
      }
    });
    document.getElementById("v4List").addEventListener("click", event => {
      const row = event.target.closest(".v4-row");
      if (!row) return;
      if (event.target.closest("a")) return;
      const key = row.dataset.key;
      if (!key) return;
      state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
      renderDownloads();
    });
    document.getElementById("v4Pages").addEventListener("click", event => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      renderDownloads();
      document.querySelector(".v4-list-wrap")?.scrollIntoView({behavior:"smooth",block:"start"});
    });
  }

  function navigate(nav) {
    state.page = 1;
    if (nav === "stats") {
      state.view = "stats";
    } else if (nav === "settings") {
      state.view = "settings";
    } else {
      state.view = "downloads";
      state.kind = nav === "movies" ? "movies" : nav === "series" ? "series" : "all";
    }
    document.querySelectorAll(".v4-nav-btn").forEach(button => button.classList.toggle("active", button.dataset.nav === nav || (nav === "overview" && button.dataset.nav === "overview")));
    renderV4();
  }

  function resetPage() { state.page = 1; renderV4(); }
  function resetFilters() {
    state.search = state.quality = state.group = state.indexer = state.source = state.library = "";
    state.onlyNotRhd = false;
    state.range = {mode:"days",days:7,label:"Letzte 7 Tage"};
    state.page = 1;
    document.getElementById("v4Search").value = "";
    document.getElementById("v4OnlyNotRhd").checked = false;
    renderV4();
  }

  function startOfDay(value) { const d = new Date(value); d.setHours(0,0,0,0); return d; }
  function endOfDay(value) { const d = new Date(value); d.setHours(23,59,59,999); return d; }
  function addDays(value, days) { const d = new Date(value); d.setDate(d.getDate()+days); return d; }
  function dateKey(value) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
  function shortDate(value) { return new Intl.DateTimeFormat("de-DE",{day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date(value)); }

  function rangeBoundsV4() {
    const now = new Date();
    const mode = state.range.mode;
    if (mode === "last24") return {from:new Date(now.getTime()-86400000),to:now};
    if (mode === "today") return {from:startOfDay(now),to:endOfDay(now)};
    if (mode === "yesterday") { const d=addDays(now,-1); return {from:startOfDay(d),to:endOfDay(d)}; }
    if (mode === "exact") { const d=new Date(`${state.range.date}T12:00:00`); return {from:startOfDay(d),to:endOfDay(d)}; }
    if (mode === "custom" && state.customFrom && state.customTo) return {from:startOfDay(`${state.customFrom}T12:00:00`),to:endOfDay(`${state.customTo}T12:00:00`)};
    const days = Number(state.range.days || 7);
    return {from:new Date(now.getTime()-days*86400000),to:now};
  }

  function rawPeriodItems() {
    if (!DATA) return [];
    const bounds = rangeBoundsV4();
    const items = [...(DATA.movies||[]),...(DATA.episodes||[])];
    return items.filter(item => {
      const t = new Date(item.date || item.grabDate || 0).getTime();
      return Number.isFinite(t) && t >= bounds.from.getTime() && t <= bounds.to.getTime();
    });
  }

  function originOf(item) {
    const source = typeof effectiveDownloadSource === "function" ? effectiveDownloadSource(item) : (item.source || (item.kind === "movie" ? "Radarr" : "Sonarr"));
    const lower = String(source||"").toLowerCase();
    if (lower.includes("kryo")) return "Kryo";
    if (lower.includes("repollo") || lower.includes("reppollo")) return "rePollo";
    if (lower === "radarr" || lower === "sonarr") return "ARR";
    return "SAB";
  }

  function releaseTechTail(name) {
    const text = String(name || "");
    const match = text.match(/(?:^|[. _-])(?:2160|1080|720|576|480)[pi](?=$|[. _-])/i);
    if (!match) return norm(text);
    return norm(text.slice(match.index).replace(/^[. _-]+/, ""));
  }

  function fingerprint(item) {
    return [item.quality,item.releaseGroup,item.indexer,originOf(item),releaseTechTail(item.originalRelease),item.isUpgrade?"upgrade":"normal"].map(norm).join("|");
  }

  function itemTimestamp(item) { return number(item.importTimestamp || item.timestamp); }

  function seasonBundles(items) {
    const movies = items.filter(item => item.kind === "movie");
    const episodes = items.filter(item => item.kind === "episode");
    const groups = new Map();
    for (const item of episodes) {
      const season = Number(item.seasonNumber);
      const key = `${item.seriesId ?? item.title}::${Number.isFinite(season)?season:0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const bundles = [];
    for (const group of groups.values()) {
      const byEpisode = new Map();
      for (const item of group) {
        const ep = Number(item.episodeNumber);
        const current = byEpisode.get(ep);
        if (!current || itemTimestamp(item) >= itemTimestamp(current)) byEpisode.set(ep,item);
      }
      const children = [...byEpisode.values()].sort((a,b)=>Number(a.episodeNumber)-Number(b.episodeNumber));
      if (!children.length) continue;
      const newest = [...children].sort((a,b)=>itemTimestamp(b)-itemTimestamp(a))[0];
      const expectedCandidates = children.map(item=>Number(item.seasonEpisodeCount)).filter(v=>Number.isInteger(v)&&v>0);
      const expected = expectedCandidates.length ? Math.max(...expectedCandidates) : Math.max(...children.map(item=>Number(item.episodeNumber)||0));
      const numbers = children.map(item=>Number(item.episodeNumber)).filter(Number.isFinite).sort((a,b)=>a-b);
      const coherent = new Set(children.map(fingerprint)).size === 1;
      const contiguous = expected>0 && numbers.length===expected && numbers.every((value,index)=>value===index+1);
      const complete = coherent && contiguous;
      const qualityValues = [...new Set(children.map(item=>item.quality).filter(Boolean))];
      const groupValues = [...new Set(children.map(item=>item.releaseGroup).filter(Boolean))];
      const indexerValues = [...new Set(children.map(item=>item.indexer).filter(Boolean))];
      const sourceValues = [...new Set(children.map(originOf))];
      const totalSize = children.reduce((sum,item)=>sum+number(item.size),0);
      bundles.push({
        ...newest,
        kind:"season",
        seasonBundle:true,
        children,
        episodeCount:children.length,
        expectedEpisodeCount:expected,
        seasonComplete:complete,
        seasonCoherent:coherent,
        quality:qualityValues.length===1?qualityValues[0]:"Gemischt",
        releaseGroup:groupValues.length===1?groupValues[0]:"Gemischt",
        indexer:indexerValues.length===1?indexerValues[0]:"Gemischt",
        source:sourceValues.length===1?newest.source:"Gemischt",
        size:totalSize,
        sizeText:typeof bytes==="function"?bytes(totalSize):String(totalSize),
        timestamp:itemTimestamp(newest),
      });
    }
    return [...movies,...bundles];
  }

  function itemKey(item) {
    if (item.kind === "movie") return `movie:${item.movieId ?? item.title}:${item.downloadId || norm(item.originalRelease)}`;
    if (item.kind === "season") return `season:${item.seriesId ?? item.title}:${item.seasonNumber}`;
    return `item:${item.seriesId ?? item.title}:${item.episodeCode || norm(item.originalRelease)}`;
  }

  function filterItems(items) {
    const q = norm(state.search);
    return items.filter(item => {
      if (state.kind === "movies" && item.kind !== "movie") return false;
      if (state.kind === "series" && item.kind === "movie") return false;
      const hay = norm([item.title,item.originalRelease,item.releaseGroup,item.indexer,item.library,item.targetFolder,item.targetFile,...(item.children||[]).map(child=>`${child.originalRelease} ${child.episodeTitle}`)].join(" "));
      if (q && !hay.includes(q)) return false;
      if (state.quality && item.quality !== state.quality) return false;
      if (state.group && item.releaseGroup !== state.group) return false;
      if (state.indexer && item.indexer !== state.indexer) return false;
      if (state.library && item.library !== state.library) return false;
      if (state.source && originOf(item) !== state.source) return false;
      if (state.onlyNotRhd && rhdStatus(item) !== "no") return false;
      return true;
    });
  }

  function prepareItems(applyRhdFilter=true) {
    let items = seasonBundles(rawPeriodItems());
    if (!applyRhdFilter) {
      const old = state.onlyNotRhd; state.onlyNotRhd = false; items = filterItems(items); state.onlyNotRhd = old;
    } else items = filterItems(items);
    items.sort((a,b)=>number(b.timestamp)-number(a.timestamp));
    return items;
  }

  function populateOptions(id, values, label, selected) {
    const node = document.getElementById(id);
    const unique = [...new Set(values.filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),"de"));
    node.innerHTML = `<option value="">${htmlEscape(label)}</option>${unique.map(value=>`<option value="${htmlEscape(value)}">${htmlEscape(value)}</option>`).join("")}`;
    if (unique.includes(selected)) node.value = selected;
  }

  function updateFilterOptions() {
    const raw = rawPeriodItems();
    populateOptions("v4Quality",raw.map(item=>item.quality),"Qualität",state.quality);
    populateOptions("v4Group",raw.map(item=>item.releaseGroup),"Group",state.group);
    populateOptions("v4Indexer",raw.map(item=>item.indexer),"Indexer",state.indexer);
    populateOptions("v4Source",seasonBundles(raw).map(originOf),"Quelle",state.source);
    populateOptions("v4Library",raw.map(item=>item.library),"Library",state.library);
  }

  function statusPayload(item) {
    const key = itemKey(item);
    if (item.kind === "season") return {key,kind:"series",targetFolder:item.targetFolder,seasonNumber:item.seasonNumber,releases:item.children.map(child=>child.originalRelease).filter(Boolean)};
    return {key,kind:item.kind,targetFolder:item.targetFolder,seasonNumber:item.seasonNumber,release:item.originalRelease};
  }

  function rhdStatus(item) {
    const origin = originOf(item);
    if (origin === "Kryo" || origin === "rePollo") return "yes";
    return state.rhd.get(itemKey(item)) || "unknown";
  }

  async function ensureRhdStatuses(items) {
    const candidates = items.filter(item => originOf(item)==="ARR" && !state.rhd.has(itemKey(item)) && !state.rhdPending.has(itemKey(item)));
    if (!candidates.length || state.rhdConfigured === false) return;
    const batch = candidates.slice(0,100);
    batch.forEach(item=>state.rhdPending.add(itemKey(item)));
    try {
      const response = await fetch("/api/rhd-status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:batch.map(statusPayload)})});
      const payload = await response.json();
      state.rhdConfigured = !!payload.configured;
      if (!payload.configured) batch.forEach(item=>state.rhd.set(itemKey(item),"unknown"));
      else Object.entries(payload.items||{}).forEach(([key,value])=>state.rhd.set(key,value||"unknown"));
    } catch {
      batch.forEach(item=>state.rhd.set(itemKey(item),"unknown"));
    } finally {
      batch.forEach(item=>state.rhdPending.delete(itemKey(item)));
      renderDownloads();
    }
  }

  function ageText(item) {
    const ts = number(item.timestamp) * 1000 || new Date(item.date||0).getTime();
    if (!ts) return "–";
    const seconds = Math.max(0,(Date.now()-ts)/1000);
    if (seconds < 3600) return `vor ${Math.max(1,Math.round(seconds/60))} Min.`;
    if (seconds < 86400) return `vor ${Math.max(1,Math.round(seconds/3600))} Stunden`;
    const days = Math.max(1,Math.round(seconds/86400));
    return `vor ${days} ${days===1?"Tag":"Tagen"}`;
  }

  function originMarkup(item) {
    const origin = originOf(item);
    if (origin === "Kryo") return `<span class="v4-pill v4-origin kryo" title="Download durch Kryo Manager ausgelöst">⚙ Kryo</span>`;
    if (origin === "rePollo") return `<span class="v4-pill v4-origin repollo" title="Download direkt durch rePollo ausgelöst">▶ rePollo</span>`;
    if (origin === "ARR") return `<span class="v4-pill v4-origin arr" title="Download direkt durch Radarr/Sonarr ausgelöst">⚡ ARR</span>`;
    return `<span class="v4-pill v4-origin sab" title="Download-Quelle nicht eindeutig zuordenbar">SAB</span>`;
  }

  function rhdMarkup(item) {
    const status = rhdStatus(item);
    if (status === "yes") return `<span class="v4-pill v4-rhd yes" title="Release ist auf RocketHD vorhanden">●</span>`;
    if (status === "no") return `<span class="v4-pill v4-rhd no" title="Release wurde auf RocketHD nicht gefunden — Uploadversuch sinnvoll">⊘</span>`;
    if (status === "partial") return `<span class="v4-pill v4-rhd partial" title="Nur ein Teil dieser Staffel wurde auf RocketHD gefunden">◐</span>`;
    return `<span class="v4-pill v4-rhd unknown" title="RocketHD-Status noch nicht geprüft oder API nicht konfiguriert">?</span>`;
  }

  function rowHtml(item) {
    const key = itemKey(item);
    const expanded = state.expanded.has(key);
    const poster = item.poster ? `<img class="v4-poster" src="${htmlEscape(item.poster)}" loading="lazy">` : `<div class="v4-poster"></div>`;
    const subtitle = item.kind === "movie" ? `${htmlEscape(item.year||"")} · Film` : `${htmlEscape(item.year||"")} · S${String(item.seasonNumber||0).padStart(2,"0")} · TV Show`;
    const season = item.kind === "season" ? `<span class="v4-pill v4-season-pill ${item.seasonComplete?"complete":""}" title="${item.seasonCoherent?"Technische Merkmale der vorhandenen Folgen stimmen überein":"Vorhandene Folgen unterscheiden sich technisch"}">S${String(item.seasonNumber||0).padStart(2,"0")} ${item.episodeCount} / ${item.expectedEpisodeCount||"?"}</span>` : "";
    const quality = item.quality ? `<span class="v4-pill">${htmlEscape(item.quality)}</span>` : "";
    const group = item.releaseGroup && item.releaseGroup!=="Gemischt" ? `<span class="v4-pill">${htmlEscape(item.releaseGroup)}</span>` : (item.releaseGroup==="Gemischt"?`<span class="v4-pill">Gemischt</span>`:"");
    const sizeText = item.sizeText || (typeof bytes==="function"?bytes(item.size):String(item.size||""));
    return `<article class="v4-row ${expanded?"expanded":""}" data-key="${htmlEscape(key)}">
      <div class="v4-row-main">
        <div class="v4-title-cell">${poster}<div class="v4-title-stack"><a class="v4-title" href="${htmlEscape(item.arrUrl||"#")}" target="_blank" title="${htmlEscape(item.title)}">${htmlEscape(item.title)}</a><div class="v4-subtitle">${subtitle}</div></div></div>
        <div>${season}</div>
        <div class="v4-quality-cell">${quality}${group}</div>
        <div class="v4-size">${htmlEscape(sizeText)}</div>
        <div class="v4-age"><span class="v4-clock">◷</span>${htmlEscape(ageText(item))}</div>
        <div class="v4-status-group">${originMarkup(item)}${rhdMarkup(item)}<span class="v4-chevron">›</span></div>
      </div>
      <div class="v4-row-detail">${expanded?detailHtml(item):""}</div>
    </article>`;
  }

  function seasonPath(item) {
    const paths = (item.children||[]).map(child=>child.targetFile).filter(Boolean).map(path=>String(path).replace(/\/[^/]+$/, ""));
    if (!paths.length) return item.targetFolder || "";
    return paths.every(path=>path===paths[0]) ? paths[0] : (item.targetFolder||paths[0]);
  }

  function detailHtml(item) {
    if (item.kind === "season") {
      const byEpisode = new Map((item.children||[]).map(child=>[Number(child.episodeNumber),child]));
      const expected = Number(item.expectedEpisodeCount)||Math.max(0,...byEpisode.keys());
      const rows = [];
      for (let i=1;i<=expected;i++) {
        const child = byEpisode.get(i);
        const code = `S${String(item.seasonNumber||0).padStart(2,"0")}E${String(i).padStart(2,"0")}`;
        if (!child) {
          rows.push(`<div class="v4-episode v4-ep-missing"><span><i class="v4-missing-dot"></i> ${code}</span><span>Fehlt</span><span>–</span><span>–</span><span>–</span></div>`);
          continue;
        }
        rows.push(`<div class="v4-episode"><span><i class="v4-present-dot">✓</i> <b class="v4-ep-code">${code}</b></span><span class="v4-ep-title" title="${htmlEscape(child.episodeTitle||"")}">${htmlEscape(child.episodeTitle||"Episode")}</span><span class="v4-ep-release" title="${htmlEscape(child.originalRelease||"")}">${htmlEscape(child.originalRelease||"–")}</span><span>${htmlEscape(child.sizeText || (typeof bytes==="function"?bytes(child.size):""))}</span><span>${htmlEscape(typeof fmtDate==="function"?fmtDate(child.importDate||child.date):child.date||"")}</span></div>`);
      }
      return `<div class="v4-detail-panel"><div class="v4-detail-grid"><div class="v4-episodes">${rows.join("")}</div><dl class="v4-detail-meta"><dt>Speicherpfad</dt><dd class="mono" title="${htmlEscape(seasonPath(item))}">${htmlEscape(seasonPath(item)||"–")}</dd><dt>Indexer</dt><dd>${htmlEscape(item.indexer||"–")}</dd><dt>Release Group</dt><dd>${htmlEscape(item.releaseGroup||"–")}</dd><dt>Importiert</dt><dd>${htmlEscape(typeof fmtDate==="function"?fmtDate(item.importDate||item.date):item.date||"")}</dd></dl></div></div>`;
    }
    return `<div class="v4-detail-panel"><dl class="v4-detail-meta"><dt>Original Release</dt><dd class="mono" title="${htmlEscape(item.originalRelease||"")}">${htmlEscape(item.originalRelease||"–")}</dd><dt>Speicherpfad</dt><dd class="mono" title="${htmlEscape(item.targetFile||item.targetFolder||"")}">${htmlEscape(item.targetFile||item.targetFolder||"–")}</dd><dt>Indexer</dt><dd>${htmlEscape(item.indexer||"–")}</dd><dt>Release Group</dt><dd>${htmlEscape(item.releaseGroup||"–")}</dd><dt>Importiert</dt><dd>${htmlEscape(typeof fmtDate==="function"?fmtDate(item.importDate||item.date):item.date||"")}</dd></dl></div>`;
  }

  function pageButton(page,label=String(page),disabled=false,active=false) {
    return `<button class="v4-page-btn ${active?"active":""}" data-page="${page}" ${disabled?"disabled":""}>${label}</button>`;
  }

  function paginationHtml(pageCount) {
    if (pageCount<=1) return pageButton(1,"1",true,true);
    const current = state.page;
    let html = pageButton(Math.max(1,current-1),"‹",current===1,false);
    const pages = new Set([1,pageCount,current-2,current-1,current,current+1,current+2]);
    const valid = [...pages].filter(page=>page>=1&&page<=pageCount).sort((a,b)=>a-b);
    let previous = 0;
    for (const page of valid) {
      if (previous && page-previous>1) html += `<span class="v4-ellipsis">…</span>`;
      html += pageButton(page,String(page),false,page===current);
      previous = page;
    }
    html += pageButton(Math.min(pageCount,current+1),"›",current===pageCount,false);
    return html;
  }

  function renderDownloads() {
    if (!state.initialized || state.view!=="downloads") return;
    updateFilterOptions();
    let items = prepareItems(true);
    const pageCount = Math.max(1,Math.ceil(items.length/PAGE_SIZE));
    state.page = Math.min(Math.max(1,state.page),pageCount);
    const start = (state.page-1)*PAGE_SIZE;
    const pageItems = items.slice(start,start+PAGE_SIZE);
    document.getElementById("v4List").innerHTML = pageItems.map(rowHtml).join("");
    document.getElementById("v4Empty").hidden = items.length>0;
    document.getElementById("v4PageSummary").textContent = items.length ? `${start+1} – ${Math.min(start+PAGE_SIZE,items.length)} von ${items.length} Einträgen` : "0 Einträge";
    document.getElementById("v4Pages").innerHTML = paginationHtml(pageCount);
    document.getElementById("v4Heading").textContent = state.kind==="movies"?"Filme":state.kind==="series"?"Serien":"Downloads";
    document.getElementById("v4Subheading").textContent = state.kind==="movies"?"Deine Usenet-Filme":state.kind==="series"?"Deine Usenet-Serien":"Deine Usenet Downloads";
    ensureRhdStatuses(pageItems);
  }

  function setRange(mode,value=null) {
    if (mode==="exact") state.range={mode:"exact",date:value,label:shortDate(`${value}T12:00:00`)};
    else if (mode==="last24") state.range={mode,label:"Letzte 24 Stunden"};
    else if (mode==="today") state.range={mode,label:"Heute"};
    else if (mode==="yesterday") state.range={mode,label:"Gestern"};
    else if (mode==="custom") state.range={mode,label:"Benutzerdefiniert"};
    else state.range={mode:"days",days:Number(value),label:`Letzte ${value} Tage`};
    state.page=1; state.calendarOpen=false; renderV4();
  }

  function renderCalendar() {
    const pop = document.getElementById("v4Calendar");
    const button = document.getElementById("v4DateButton");
    if (!pop) return;
    pop.hidden = !state.calendarOpen;
    button.classList.toggle("active",state.calendarOpen);
    document.getElementById("v4DateLabel").textContent = state.range.label || "Zeitraum";
    if (!state.calendarOpen) return;
    const month = state.calendarMonth;
    const year = month.getFullYear(), monthIndex = month.getMonth();
    const first = new Date(year,monthIndex,1);
    const mondayOffset = (first.getDay()+6)%7;
    const start = addDays(first,-mondayOffset);
    const today = startOfDay(new Date());
    const oldest = startOfDay(addDays(today,-29));
    const selectedKey = state.range.mode==="exact" ? state.range.date : "";
    const cells = [];
    for(let i=0;i<42;i++){
      const day=addDays(start,i),key=dateKey(day),inMonth=day.getMonth()===monthIndex,allowed=day>=oldest&&day<=today;
      cells.push(`<button class="v4-cal-day ${key===selectedKey?"selected":""}" data-date="${key}" ${allowed?"":"disabled"} style="${inMonth?"":"opacity:.45"}">${day.getDate()}</button>`);
    }
    pop.innerHTML=`<div class="v4-cal-left"><div class="v4-cal-head"><button class="v4-cal-arrow" data-cal="prev">‹</button><span>${new Intl.DateTimeFormat("de-DE",{month:"long",year:"numeric"}).format(month)}</span><button class="v4-cal-arrow" data-cal="next">›</button></div><div class="v4-cal-week"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div><div class="v4-cal-grid">${cells.join("")}</div></div><div class="v4-cal-right"><button class="v4-range-choice" data-range="last24">Letzte 24 Stunden</button><button class="v4-range-choice" data-range="today">Heute</button><button class="v4-range-choice" data-range="yesterday">Gestern</button><button class="v4-range-choice" data-range="7">Letzte 7 Tage</button><button class="v4-range-choice" data-range="30">Letzte 30 Tage</button><button class="v4-range-choice" data-range="custom">Benutzerdefiniert</button><div class="v4-exact-label">▣ Exakter Tag · letzte 30 Tage</div><div class="v4-custom-range"><input id="v4From" type="date" value="${htmlEscape(state.customFrom)}"><input id="v4To" type="date" value="${htmlEscape(state.customTo)}"><button id="v4CustomApply" class="v4-custom-apply">Zeitraum anwenden</button></div></div>`;
    pop.querySelectorAll("[data-date]").forEach(btn=>btn.addEventListener("click",()=>setRange("exact",btn.dataset.date)));
    pop.querySelectorAll("[data-range]").forEach(btn=>btn.addEventListener("click",()=>{
      const value=btn.dataset.range;
      if(value==="7"||value==="30")setRange("days",Number(value));else if(value==="custom"){state.range={mode:"custom",label:"Benutzerdefiniert"};renderCalendar();}else setRange(value);
    }));
    pop.querySelector("[data-cal=prev]").addEventListener("click",()=>{state.calendarMonth=new Date(year,monthIndex-1,1);renderCalendar();});
    pop.querySelector("[data-cal=next]").addEventListener("click",()=>{state.calendarMonth=new Date(year,monthIndex+1,1);renderCalendar();});
    pop.querySelector("#v4CustomApply").addEventListener("click",()=>{state.customFrom=pop.querySelector("#v4From").value;state.customTo=pop.querySelector("#v4To").value;if(state.customFrom&&state.customTo)setRange("custom");});
  }

  function ranked(items,key,limit=5) {
    const counts=new Map();
    for(const item of items){const value=typeof key==="function"?key(item):(item[key]||"Unbekannt");counts.set(value,(counts.get(value)||0)+1)}
    return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit);
  }
  function rankHtml(rows,total) {
    const max=Math.max(1,...rows.map(row=>row[1]));
    return `<div class="v4-rank-list">${rows.map(([name,count])=>`<div class="v4-rank"><span class="v4-rank-name" title="${htmlEscape(name)}">${htmlEscape(name)}</span><span class="v4-rank-track"><span class="v4-rank-fill" style="width:${(count/max)*100}%"></span></span><span class="v4-rank-value">${count} (${total?Math.round(count/total*100):0}%)</span></div>`).join("")}</div>`;
  }

  function renderStats() {
    const target=document.getElementById("v4StatsPage");
    const raw=rawPeriodItems(),movies=raw.filter(x=>x.kind==="movie"),episodes=raw.filter(x=>x.kind==="episode");
    const totalSize=raw.reduce((sum,item)=>sum+number(item.size),0),seriesCount=new Set(episodes.map(x=>x.seriesId||x.title)).size;
    const dayCounts=new Map();for(const item of raw){const key=dateKey(item.date||item.grabDate);dayCounts.set(key,(dayCounts.get(key)||0)+1)}
    const dayRows=[...dayCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));const maxDay=Math.max(1,...dayRows.map(row=>row[1]));
    const sources=ranked(raw,originOf,10),sourceTotal=Math.max(1,raw.length);const sourceColors=["#35a7ff","#9b38ff","#ff9e2f","#25e884","#728797"];let acc=0;const segments=sources.map(([,count],i)=>{const start=acc/sourceTotal*360;acc+=count;const end=acc/sourceTotal*360;return `${sourceColors[i%sourceColors.length]} ${start}deg ${end}deg`}).join(",");
    target.innerHTML=`<div class="v4-page-title"><h1>Statistiken</h1><p>Deine Downloads im Detail · ${htmlEscape(state.range.label)}</p></div><div class="v4-stat-kpis"><div class="v4-stat-card"><span>Downloads gesamt</span><strong>${raw.length}</strong></div><div class="v4-stat-card"><span>Datenvolumen</span><strong>${typeof bytes==="function"?bytes(totalSize):totalSize}</strong></div><div class="v4-stat-card"><span>Filme</span><strong>${movies.length}</strong></div><div class="v4-stat-card"><span>Serien</span><strong>${seriesCount}</strong></div><div class="v4-stat-card"><span>Ø Größe</span><strong>${typeof bytes==="function"?bytes(raw.length?totalSize/raw.length:0):"–"}</strong></div></div><div class="v4-stats-grid"><div class="v4-stat-panel"><h3>Downloads nach Tag</h3><div class="v4-daily-bars">${dayRows.map(([day,count])=>`<div class="v4-daily-bar" style="height:${Math.max(3,count/maxDay*100)}%" data-tip="${day}: ${count}"></div>`).join("")}</div></div><div class="v4-stat-panel"><h3>Datenvolumen nach Quelle</h3><div class="v4-source-donut" style="background:conic-gradient(${segments||"#263c4c 0 360deg"})"><strong>${typeof bytes==="function"?bytes(totalSize):totalSize}</strong></div>${rankHtml(sources,raw.length)}</div><div class="v4-stat-panel"><h3>Qualitäten (Top 5)</h3>${rankHtml(ranked(raw,"quality"),raw.length)}</div></div><div class="v4-stats-lower"><div class="v4-stat-panel"><h3>Top Release Groups</h3>${rankHtml(ranked(raw,"releaseGroup"),raw.length)}</div><div class="v4-stat-panel"><h3>Top Indexer</h3>${rankHtml(ranked(raw,"indexer"),raw.length)}</div><div class="v4-stat-panel"><h3>Top Libraries</h3>${rankHtml(ranked(raw,"library"),raw.length)}</div></div>`;
  }

  function renderSettings() {
    const target=document.getElementById("v4SettingsPage");
    target.innerHTML=`<div class="v4-page-title"><h1>Einstellungen</h1><p>Status und Darstellung</p></div><div class="v4-settings-box"><h2>Integrationen</h2><div class="v4-settings-row"><span>RocketHD-Prüfung</span><strong>${DATA?.integrations?.rhdConfigured?"aktiv":"nicht konfiguriert"}</strong></div><div class="v4-settings-row"><span>Kryo Manager</span><strong>${DATA?.integrations?.kryoConfigured?"konfiguriert":"nicht konfiguriert"}</strong></div><div class="v4-settings-row"><span>Anzeige</span><strong>20 Einträge pro Seite</strong></div><div class="v4-settings-row"><span>Sidebar</span><button class="v4-control" type="button" onclick="document.getElementById('v4Collapse').click()">Ein-/ausklappen</button></div><div class="v4-settings-row"><span>Daten</span><button class="v4-control" id="v4RefreshNow" type="button">Jetzt aktualisieren</button></div></div>`;
    target.querySelector("#v4RefreshNow")?.addEventListener("click",()=>{if(typeof load==="function")load(true);});
  }

  function updateCounts() {
    const raw=rawPeriodItems();
    const grouped=seasonBundles(raw);
    const movies=grouped.filter(x=>x.kind==="movie").length,series=grouped.filter(x=>x.kind!=="movie").length;
    document.getElementById("v4AllCount").textContent=grouped.length;
    document.getElementById("v4MovieCountNav").textContent=movies;
    document.getElementById("v4SeriesCountNav").textContent=series;
    document.getElementById("v4Updated").textContent=DATA?.generatedAt?(typeof fmtDate==="function"?fmtDate(DATA.generatedAt):shortDate(DATA.generatedAt)):"–";
  }

  function renderV4() {
    if (!state.initialized) return;
    const app=document.getElementById("v4App");if(!app)return;
    app.classList.toggle("v4-view-stats",state.view==="stats");
    app.classList.toggle("v4-view-settings",state.view==="settings");
    updateCounts();
    renderCalendar();
    if(state.view==="downloads")renderDownloads();else if(state.view==="stats")renderStats();else renderSettings();
  }

  function init() {
    buildShell();bindUi();state.initialized=true;renderV4();
    const poll=setInterval(()=>{if(DATA){clearInterval(poll);renderV4()}},250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",init); else init();
})();
