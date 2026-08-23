/* SABnzbd / rePollo frontend extension.
 * Loaded after app.js and intentionally reuses the dashboard's existing
 * global state/functions.
 */
(() => {
  const basePeriodData = periodData;
  const basePopulateFilters = populateFilters;
  const baseRenderSummary = renderSummary;
  const baseRenderChart = renderChart;
  const baseRenderTab = renderTab;

  function normalizeSource(value) {
    const v = String(value || "");
    return /reppollo|repollo/i.test(v) ? "rePollo" : (v || "SABnzbd");
  }

  periodData = function () {
    const p = basePeriodData();
    p.usenet = (DATA?.sabDownloads || []).filter(inRange).map(x => ({
      ...x,
      source: normalizeSource(x.source),
    }));
    return p;
  };

  populateFilters = function () {
    basePopulateFilters();
    const all = [
      ...(DATA?.movies || []),
      ...(DATA?.episodes || []),
      ...(DATA?.sabDownloads || []),
    ];
    populateSelect("indexer", all.map(x => x.indexer), "Alle Indexer");
    populateSelect("quality", all.map(x => x.quality), "Alle Qualitäten");
    populateSelect("group", all.map(x => x.releaseGroup), "Alle Groups");
    populateSelect("client", all.map(x => x.downloadClient), "Alle Clients");
    populateSelect("library", all.map(x => x.library), "Alle Libraries");

    const sourceSelect = document.getElementById("source");
    if (sourceSelect) {
      const old = sourceSelect.value;
      const values = [...new Set((DATA?.sabDownloads || []).map(x => normalizeSource(x.source)))].sort((a,b)=>a.localeCompare(b,"de"));
      sourceSelect.innerHTML = `<option value="">Alle Quellen</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      if (values.includes(old)) sourceSelect.value = old;
    }
  };

  renderSummary = function () {
    baseRenderSummary();
    const p = periodData();
    if (p.usenet?.length) {
      const totalBytes = p.usenet.reduce((s,x)=>s+(Number(x.size)||0),0);
      el("totalSize").textContent = bytes(totalBytes);
    }
    const count = document.getElementById("usenetTabCount");
    if (count) count.textContent = `(${p.usenet?.length || 0})`;
  };

  renderChart = function () {
    const p = periodData();
    if (!p.usenet?.length) {
      baseRenderChart();
      return;
    }

    const items = p.usenet;
    const r = rangeBounds();
    const days = Math.max(1, Math.ceil((r.to-r.from)/86400000)+1);
    const vals = {};
    for (let i=0;i<days;i++) {
      const d = new Date(r.from); d.setDate(d.getDate()+i); vals[dayKey(d)] = 0;
    }
    for (const x of items) {
      const k = dayKey(x.date);
      if (k in vals) vals[k] += METRIC === "bytes" ? (Number(x.size)||0) : 1;
    }
    const max = Math.max(1,...Object.values(vals));
    el("chartTitle").textContent = METRIC === "bytes" ? "Usenet-Datenvolumen pro Tag" : "Erfolgreiche Usenet-Downloads pro Tag";
    el("chartSubtitle").textContent = "SABnzbd Completed · inklusive rePollo";
    el("chart").innerHTML = Object.entries(vals).map(([d,n]) => {
      const label = new Intl.DateTimeFormat("de-DE",{day:"2-digit",month:"2-digit"}).format(new Date(d+"T12:00:00"));
      const shown = METRIC === "bytes" ? compactBytes(n) : String(n);
      const tip = METRIC === "bytes" ? `${label}: ${bytes(n)}` : `${label}: ${n} Downloads`;
      const h = n ? Math.max(4,(n/max)*88) : 1.5;
      return `<div class="bar-wrap" data-tip="${tip}">${n?`<span class="bar-value" style="bottom:calc(${h}% + 6px)">${shown}</span>`:""}<div class="bar" style="height:${h}%"></div></div>`;
    }).join("");
  };

  function filteredUsenet(items) {
    const q = el("search").value.trim().toLowerCase();
    const ix = el("indexer").value;
    const qual = el("quality").value;
    const grp = el("group").value;
    const cli = el("client").value;
    const lib = el("library").value;
    const src = document.getElementById("source")?.value || "";

    return items.filter(x => {
      if (q && ![
        x.title,x.originalRelease,x.targetFolder,x.targetFile,x.releaseGroup,
        x.indexer,x.downloadClient,x.source,x.category
      ].join(" ").toLowerCase().includes(q)) return false;
      if (ix && x.indexer !== ix) return false;
      if (qual && x.quality !== qual) return false;
      if (grp && x.releaseGroup !== grp) return false;
      if (cli && x.downloadClient !== cli) return false;
      if (lib && x.library !== lib) return false;
      if (src && normalizeSource(x.source) !== src) return false;
      return true;
    });
  }

  function usenetCard(x) {
    const source = normalizeSource(x.source);
    const img = x.poster ? `<img class="poster" src="${esc(x.poster)}" loading="lazy">` : `<div class="poster"></div>`;
    const title = x.arrUrl
      ? `<a class="title-link title" href="${esc(x.arrUrl)}" target="_blank">${esc(x.title || x.originalRelease)}</a>`
      : `<div class="title">${esc(x.title || x.originalRelease || "Unbekannter Download")}</div>`;
    const sourceClass = source === "rePollo" ? "source-repollo" : source === "Radarr" ? "source-radarr" : source === "Sonarr" ? "source-sonarr" : "";

    return `<article class="item usenet-item">
      ${img}
      <div>
        ${title}
        <div class="meta">${esc(x.category || "SABnzbd")}</div>
        <span class="badge ${sourceClass}">Quelle: ${esc(source)}</span>
        <span class="badge indexer">Indexer: ${esc(x.indexer || "Unbekannt")}</span>
        ${x.quality?`<span class="badge">${esc(x.quality)}</span>`:""}
        ${x.releaseGroup?`<span class="badge">${esc(x.releaseGroup)}</span>`:""}
      </div>
      <div>
        <div class="label">Original Release</div>
        <div class="release">${esc(x.originalRelease || "–")}</div>
        ${x.indexerSource?`<div class="label secondary-label">Indexer ermittelt über</div><div class="meta">${esc(x.indexerSource)}</div>`:""}
      </div>
      <div>
        <div class="label">Ziel in SABnzbd / Unraid</div>
        <div class="path">${esc(x.targetFolder || "–")}</div>
        ${x.targetFile?`<div class="path path-file">${esc(x.targetFile)}</div>`:""}
      </div>
      <div class="right">
        <div class="size">${esc(x.sizeText || bytes(x.size))}</div>
        <div class="date-block"><div class="date-label">Completed</div><div class="date">${fmtDate(x.completedDate || x.date)}</div></div>
        ${x.downloadTime?`<div class="date-block import-time"><div class="date-label">Download</div><div class="date">${Number(x.downloadTime)} s</div></div>`:""}
      </div>
    </article>`;
  }

  function renderUsenetList() {
    const p = periodData();
    let items = filteredUsenet([...(p.usenet || [])]);
    sortItems(items);
    CURRENT = items;
    el("empty").hidden = items.length !== 0;
    el("list").innerHTML = items.map(usenetCard).join("");
    renderChips();
  }

  renderTab = function () {
    if (TAB === "usenet") {
      el("indexerPage").hidden = true;
      el("mediaFilters").hidden = false;
      el("list").hidden = false;
      el("empty").hidden = true;
      renderUsenetList();
      return;
    }
    baseRenderTab();
  };

  function injectUi() {
    const tabs = document.querySelector(".tabs");
    if (tabs && !document.querySelector('[data-tab="usenet"]')) {
      const b = document.createElement("button");
      b.className = "tab";
      b.dataset.tab = "usenet";
      b.innerHTML = `📦 Alle Usenet <span id="usenetTabCount"></span>`;
      tabs.prepend(b);
      b.addEventListener("click",()=>{
        document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
        b.classList.add("active"); TAB = "usenet"; renderTab();
      });
    }

    const primary = document.querySelector(".primary-filters");
    if (primary && !document.getElementById("source")) {
      const select = document.createElement("select");
      select.id = "source";
      select.innerHTML = `<option value="">Alle Quellen</option>`;
      primary.appendChild(select);
      select.addEventListener("change",()=>{ if (TAB === "usenet") renderUsenetList(); });
    }

    const style = document.createElement("style");
    style.textContent = `
      .badge.source-repollo{border-color:color-mix(in srgb,var(--purple) 50%,var(--border));color:var(--purple);background:color-mix(in srgb,var(--purple) 10%,transparent)}
      .badge.source-radarr{border-color:color-mix(in srgb,var(--blue) 50%,var(--border));color:var(--blue);background:color-mix(in srgb,var(--blue) 10%,transparent)}
      .badge.source-sonarr{border-color:color-mix(in srgb,var(--teal) 50%,var(--border));color:var(--teal);background:color-mix(in srgb,var(--teal) 10%,transparent)}
    `;
    document.head.appendChild(style);

    populateFilters();
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectUi);
  else injectUi();
})();
