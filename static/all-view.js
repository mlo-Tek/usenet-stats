/* Default mixed media view with automatic complete-season folding. */
(() => {
  const baseRenderList = renderList;
  const baseRenderSummary = renderSummary;

  function mediaType(item) {
    if (item.kind === "movie") return {label:"🎬 Film", cls:"type-movie", card:"media-movie", importer:"Radarr"};
    if (item.seasonBundle || item.releaseType === "season_pack") {
      return {label:"📺 Serie", subtype:"📦 Staffel", cls:"type-series", subtypeCls:"type-pack", card:"media-series", importer:"Sonarr"};
    }
    return {label:"📺 Serie", subtype:"Folge", cls:"type-series", subtypeCls:"type-episode", card:"media-series", importer:"Sonarr"};
  }

  function downloadSource(item) {
    if (typeof window.effectiveDownloadSource === "function") return window.effectiveDownloadSource(item);
    return item.source || (item.kind === "movie" ? "Radarr" : "Sonarr");
  }

  function sourceClassName(source) {
    const normalized = String(source || "").toLowerCase();
    if (normalized === "repollo" || normalized === "reppollo") return "source-reppollo";
    if (normalized === "kryo manager" || normalized === "kryo-manager" || normalized === "kryo") return "source-kryo";
    if (normalized === "radarr") return "source-radarr";
    if (normalized === "sonarr") return "source-sonarr";
    return "source-sab";
  }

  function norm(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function releaseTechTail(name) {
    const text = String(name || "");
    const match = text.match(/(?:^|[. _-])(?:2160|1080|720|576|480)[pi](?=$|[. _-])/i);
    if (!match) return "";
    return norm(text.slice(match.index).replace(/^[. _-]+/, ""));
  }

  function technicalFingerprint(item) {
    return [
      item.quality,
      item.releaseGroup,
      item.indexer,
      downloadSource(item),
      item.downloadClient,
      item.library,
      releaseTechTail(item.originalRelease),
      item.isUpgrade ? "upgrade" : "normal",
    ].map(norm).join("|");
  }

  function seasonKey(item) {
    return `${item.seriesId ?? item.title}::${Number(item.seasonNumber)}`;
  }

  function foldCompleteSeasons(items) {
    const groups = new Map();
    const untouched = [];

    for (const item of items) {
      const season = Number(item.seasonNumber);
      const episode = Number(item.episodeNumber);
      const expected = Number(item.seasonEpisodeCount);
      if (
        item.kind !== "episode" ||
        item.releaseType === "season_pack" ||
        !Number.isInteger(season) || season <= 0 ||
        !Number.isInteger(episode) || episode <= 0 ||
        !Number.isInteger(expected) || expected <= 0
      ) {
        untouched.push(item);
        continue;
      }
      const key = seasonKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const folded = [...untouched];
    for (const group of groups.values()) {
      const expected = Number(group[0].seasonEpisodeCount);
      const byEpisode = new Map();
      let duplicate = false;
      for (const item of group) {
        const number = Number(item.episodeNumber);
        if (byEpisode.has(number)) duplicate = true;
        byEpisode.set(number, item);
      }

      const numbers = [...byEpisode.keys()].sort((a,b)=>a-b);
      const complete = !duplicate && numbers.length === expected && numbers.every((n, i) => n === i + 1);
      const fingerprints = new Set(group.map(technicalFingerprint));

      if (!complete || fingerprints.size !== 1) {
        folded.push(...group);
        continue;
      }

      const children = [...group].sort((a,b)=>Number(a.episodeNumber)-Number(b.episodeNumber));
      const newest = [...group].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0))[0];
      const totalSize = group.reduce((sum,item)=>sum+(Number(item.size)||0),0);
      const season = Number(newest.seasonNumber);
      folded.push({
        ...newest,
        seasonBundle:true,
        grouped:true,
        children,
        episodeCount:expected,
        size:totalSize,
        sizeText:bytes(totalSize),
        episodeCode:`Staffel ${String(season).padStart(2,"0")}`,
        episodeTitle:`${expected} Folgen · vollständig`,
        originalRelease:`${expected} identische Einzelfolgen → vollständige Staffel`,
        targetFile:"",
        releaseType:"season_pack_virtual",
      });
    }
    return folded;
  }

  function allItems() {
    const p = periodData();
    return [
      ...(p.movies || []).map(x => ({...x, source:downloadSource(x)})),
      ...(p.episodes || []).map(x => ({...x, source:downloadSource(x)})),
    ];
  }

  function filtered(items) {
    const q = el("search").value.trim().toLowerCase();
    const src = el("source")?.value || "";
    const ix = el("indexer").value;
    const qual = el("quality").value;
    const grp = el("group").value;
    const cli = el("client").value;
    const lib = el("library").value;
    const up = el("upgrade").value;

    return items.filter(x => {
      const actualSource = downloadSource(x);
      const hay = [x.title,x.year,x.episodeCode,x.episodeTitle,x.originalRelease,x.targetFolder,x.targetFile,x.releaseGroup,x.indexer,x.downloadClient,x.library,actualSource].join(" ").toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (src && actualSource !== src) return false;
      if (ix && x.indexer !== ix) return false;
      if (qual && x.quality !== qual) return false;
      if (grp && x.releaseGroup !== grp) return false;
      if (cli && x.downloadClient !== cli) return false;
      if (lib && x.library !== lib) return false;
      if (up === "yes" && !x.isUpgrade) return false;
      if (up === "no" && x.isUpgrade) return false;
      return true;
    });
  }

  function applySeriesType(items) {
    const typ = el("seriesType").value;
    if (!typ) return items;
    return items.filter(item => {
      if (item.kind === "movie") return false;
      if (typ === "season_pack") return item.releaseType === "season_pack" || item.seasonBundle;
      return item.releaseType === typ;
    });
  }

  function childHtml(x) {
    return `<div class="season-child">
      <div class="season-child-title"><strong>${esc(x.episodeCode || "")}</strong><span>${esc(x.episodeTitle || "")}</span></div>
      <div class="season-child-release">${esc(x.originalRelease || "–")}</div>
      <div class="season-child-meta"><span>${esc(x.sizeText || bytes(x.size))}</span><span>${fmtDate(x.grabDate || x.date)}</span><button type="button" class="season-child-details" onclick='showDetails(${JSON.stringify(JSON.stringify(x))})'>Details</button></div>
    </div>`;
  }

  window.toggleSeasonBundle = function(id, button) {
    const box = document.getElementById(id);
    if (!box) return;
    const open = box.hidden;
    box.hidden = !open;
    button.textContent = open ? "Folgen ausblenden" : `Folgen anzeigen (${button.dataset.count})`;
    button.setAttribute("aria-expanded", open ? "true" : "false");
  };

  function allCardHtml(x) {
    const type = mediaType(x);
    const source = downloadSource(x);
    const img = x.poster ? `<img class="poster" src="${esc(x.poster)}" loading="lazy">` : `<div class="poster"></div>`;
    const subtitle = x.kind === "movie"
      ? esc(x.year || "")
      : x.seasonBundle
        ? `${esc(x.episodeCode)} · ${x.episodeCount} Folgen`
        : x.grouped
          ? `${x.episodeCount} Episoden`
          : `${esc(x.episodeCode || "")}${x.episodeTitle ? " · " + esc(x.episodeTitle) : ""}`;
    const subtype = type.subtype ? `<span class="badge media-type ${type.subtypeCls}">${type.subtype}</span>` : "";
    const bundleId = x.seasonBundle ? `season-${String(x.seriesId ?? x.title).replace(/[^a-z0-9_-]/gi,"-")}-${x.seasonNumber}-${Math.abs(Number(x.timestamp||0))}` : "";

    return `<article class="item all-media-item ${type.card}${x.seasonBundle ? " season-bundle" : ""}">
      ${img}
      <div>
        <a class="title-link title" href="${esc(x.arrUrl || "#")}" target="_blank">${esc(x.title)}</a>
        <div class="meta">${subtitle}</div>
        <span class="badge media-type ${type.cls}">${type.label}</span>
        ${subtype}
        ${x.seasonBundle ? `<span class="badge pack">${x.episodeCount} Folgen</span>` : ""}
        <span class="badge source-badge ${sourceClassName(source)}">${esc(source)}</span>
        ${x.quality ? `<span class="badge">${esc(x.quality)}</span>` : ""}
        ${x.releaseGroup ? `<span class="badge">${esc(x.releaseGroup)}</span>` : ""}
        ${x.indexer ? `<span class="badge indexer">${esc(x.indexer)}</span>` : ""}
        ${x.isUpgrade ? `<span class="badge upgrade">Upgrade</span>` : ""}
        <div class="media-origin">Importeur: ${type.importer}</div>
      </div>
      <div>
        <div class="label">${x.seasonBundle ? "Staffel-Zusammenfassung" : "Original Release"}</div>
        <div class="release">${esc(x.originalRelease || "–")}</div>
        ${x.downloadClient ? `<div class="label secondary-label">Download Client</div><div class="release">${esc(x.downloadClient)}</div>` : ""}
      </div>
      <div>
        <div class="label">Zielordner auf Unraid</div>
        <div class="path">${esc(x.targetFolder || "–")}</div>
        ${x.targetFile ? `<div class="path path-file">${esc(x.targetFile)}</div>` : ""}
      </div>
      <div class="right">
        <div class="size">${esc(x.sizeText || bytes(x.size))}</div>
        <div class="date-block"><div class="date-label">Grab</div><div class="date">${fmtDate(x.grabDate || x.date)}</div></div>
        <div class="date-block import-time"><div class="date-label">Import</div><div class="date">${fmtDate(x.importDate)}</div></div>
        ${x.seasonBundle ? `<button class="details-btn season-toggle" type="button" data-count="${x.episodeCount}" aria-expanded="false" onclick="toggleSeasonBundle('${bundleId}',this)">Folgen anzeigen (${x.episodeCount})</button>` : `<button class="details-btn" onclick='showDetails(${JSON.stringify(JSON.stringify(x))})'>Details</button>`}
      </div>
      ${x.seasonBundle ? `<div class="season-children" id="${bundleId}" hidden>${x.children.map(childHtml).join("")}</div>` : ""}
    </article>`;
  }

  function prepare(items) {
    let result = filtered(items);
    result = foldCompleteSeasons(result);
    result = applySeriesType(result);
    sortItems(result);
    return result;
  }

  function renderAllMediaList() {
    const items = prepare(allItems());
    CURRENT = items;
    el("empty").hidden = items.length !== 0;
    el("list").innerHTML = items.map(allCardHtml).join("");
    renderChips();
  }

  function renderEpisodeList() {
    const p = periodData();
    const items = prepare([...(p.episodes || [])].map(x=>({...x,source:downloadSource(x)})));
    CURRENT = items;
    el("empty").hidden = items.length !== 0;
    el("list").innerHTML = items.map(allCardHtml).join("");
    renderChips();
  }

  renderList = function() {
    if (TAB === "all") { renderAllMediaList(); return; }
    if (TAB === "episodes") { renderEpisodeList(); return; }
    baseRenderList();
  };

  renderSummary = function() {
    baseRenderSummary();
    const p = periodData();
    const count = (p.movies?.length || 0) + (p.episodes?.length || 0);
    const target = document.getElementById("allTabCount");
    if (target) target.textContent = `(${count})`;
  };

  const style = document.createElement("style");
  style.textContent = `
    .season-bundle{border-color:color-mix(in srgb,var(--purple) 34%,var(--border))}
    .season-children{grid-column:1/-1;margin:2px -2px -2px;padding:12px 14px 2px 84px;border-top:1px solid var(--border)}
    .season-children[hidden]{display:none}
    .season-child{display:grid;grid-template-columns:minmax(170px,.8fr) minmax(320px,2fr) auto;gap:18px;align-items:center;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--border) 75%,transparent)}
    .season-child:last-child{border-bottom:0}
    .season-child-title{display:flex;gap:9px;align-items:baseline;min-width:0}.season-child-title strong{color:var(--teal);white-space:nowrap}.season-child-title span{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .season-child-release{font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);word-break:break-all}
    .season-child-meta{display:flex;align-items:center;justify-content:flex-end;gap:14px;color:var(--muted);font-size:11px;white-space:nowrap}.season-child-details{min-height:30px;height:30px;padding:0 9px;font-size:11px}
    .season-toggle{white-space:nowrap}
    @media(max-width:900px){.season-children{padding-left:12px}.season-child{grid-template-columns:1fr}.season-child-meta{justify-content:flex-start;flex-wrap:wrap}}
  `;
  document.head.appendChild(style);

  function activateAllTab() {
    TAB = "all";
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === "all"));
    if (DATA) renderAll();
  }

  activateAllTab();
})();
