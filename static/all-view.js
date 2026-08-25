/* Default mixed media view: movies + series together, clearly differentiated. */
(() => {
  const baseRenderList = renderList;
  const baseRenderSummary = renderSummary;

  function mediaType(item) {
    if (item.kind === "movie") {
      return {label:"🎬 Film", cls:"type-movie", card:"media-movie", source:"Radarr"};
    }
    if (item.releaseType === "season_pack") {
      return {label:"📺 Serie", subtype:"📦 Season Pack", cls:"type-series", subtypeCls:"type-pack", card:"media-series", source:"Sonarr"};
    }
    return {label:"📺 Serie", subtype:"Folge", cls:"type-series", subtypeCls:"type-episode", card:"media-series", source:"Sonarr"};
  }

  function allItems() {
    const p = periodData();
    return [
      ...(p.movies || []).map(x => ({...x, source:x.source || "Radarr"})),
      ...(p.episodes || []).map(x => ({...x, source:x.source || "Sonarr"})),
    ];
  }

  function allFiltered(items) {
    const q = el("search").value.trim().toLowerCase();
    const src = el("source")?.value || "";
    const ix = el("indexer").value;
    const qual = el("quality").value;
    const grp = el("group").value;
    const cli = el("client").value;
    const lib = el("library").value;
    const up = el("upgrade").value;
    const typ = el("seriesType").value;

    return items.filter(x => {
      const derivedSource = x.kind === "movie" ? "Radarr" : "Sonarr";
      const hay = [
        x.title,x.year,x.episodeCode,x.episodeTitle,x.originalRelease,
        x.targetFolder,x.targetFile,x.releaseGroup,x.indexer,
        x.downloadClient,x.library,derivedSource
      ].join(" ").toLowerCase();

      if (q && !hay.includes(q)) return false;
      if (src && derivedSource !== src && x.source !== src) return false;
      if (ix && x.indexer !== ix) return false;
      if (qual && x.quality !== qual) return false;
      if (grp && x.releaseGroup !== grp) return false;
      if (cli && x.downloadClient !== cli) return false;
      if (lib && x.library !== lib) return false;
      if (up === "yes" && !x.isUpgrade) return false;
      if (up === "no" && x.isUpgrade) return false;

      if (typ) {
        if (x.kind === "movie") return false;
        if (x.releaseType !== typ) return false;
      }
      return true;
    });
  }

  function allCardHtml(x) {
    const type = mediaType(x);
    const img = x.poster
      ? `<img class="poster" src="${esc(x.poster)}" loading="lazy">`
      : `<div class="poster"></div>`;

    const subtitle = x.kind === "movie"
      ? `${esc(x.year || "")}`
      : x.grouped
        ? `${x.episodeCount} Episoden`
        : `${esc(x.episodeCode || "")}${x.episodeTitle ? " · " + esc(x.episodeTitle) : ""}`;

    const subtype = type.subtype
      ? `<span class="badge media-type ${type.subtypeCls}">${type.subtype}</span>`
      : "";

    return `<article class="item all-media-item ${type.card}">
      ${img}
      <div>
        <a class="title-link title" href="${esc(x.arrUrl || "#")}" target="_blank">${esc(x.title)}</a>
        <div class="meta">${subtitle}</div>
        <span class="badge media-type ${type.cls}">${type.label}</span>
        ${subtype}
        ${x.quality ? `<span class="badge">${esc(x.quality)}</span>` : ""}
        ${x.releaseGroup ? `<span class="badge">${esc(x.releaseGroup)}</span>` : ""}
        ${x.indexer ? `<span class="badge indexer">${esc(x.indexer)}</span>` : ""}
        ${x.isUpgrade ? `<span class="badge upgrade">Upgrade</span>` : ""}
        <div class="media-origin">${type.source}</div>
      </div>
      <div>
        <div class="label">Original Release</div>
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
        <button class="details-btn" onclick='showDetails(${JSON.stringify(JSON.stringify(x))})'>Details</button>
      </div>
    </article>`;
  }

  function renderAllMediaList() {
    let items = allFiltered(allItems());

    if (el("groupSeries")?.checked) {
      const movies = items.filter(x => x.kind === "movie");
      const episodes = items.filter(x => x.kind === "episode");
      items = [...movies, ...groupSeriesItems(episodes)];
    }

    sortItems(items);
    CURRENT = items;
    el("empty").hidden = items.length !== 0;
    el("list").innerHTML = items.map(allCardHtml).join("");
    renderChips();
  }

  renderList = function() {
    if (TAB === "all") {
      renderAllMediaList();
      return;
    }
    baseRenderList();
  };

  renderSummary = function() {
    baseRenderSummary();
    const p = periodData();
    const count = (p.movies?.length || 0) + (p.episodes?.length || 0);
    const target = document.getElementById("allTabCount");
    if (target) target.textContent = `(${count})`;
  };

  function activateAllTab() {
    TAB = "all";
    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.tab === "all");
    });
    if (DATA) renderAll();
  }

  /* All is the dashboard's default landing view. Because this script is loaded
   * after the existing feature layers, it also becomes the final renderList
   * implementation without disturbing SAB/indexer/refresh behavior. */
  activateAllTab();
})();
