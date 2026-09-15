/* Download-source UI layer.
 * Distinguishes the downloader/initiator from the later Arr importer.
 * rePollo is authoritative when SABnzbd category metadata says repollo.
 */
(() => {
  function canonicalSource(value, item = null) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "repollo" || normalized === "reppollo") return "rePollo";
    if (normalized === "kryo" || normalized === "kryo manager" || normalized === "kryo-manager") return "Kryo Manager";
    if (normalized === "radarr") return "Radarr";
    if (normalized === "sonarr") return "Sonarr";
    if (normalized === "sabnzbd" || normalized === "sab") return "SABnzbd";
    if (item?.kind === "movie") return "Radarr";
    if (item?.kind === "episode") return "Sonarr";
    return "SABnzbd";
  }

  function effectiveDownloadSource(item) {
    /*
     * The v4 UI bundles Sonarr episodes into synthetic `kind: season` rows.
     * Those rows do not necessarily carry an explicit `source`, even though
     * every child episode can still be classified correctly.  Falling through
     * to canonicalSource() used to classify such seasons as SABnzbd, which in
     * turn prevented RocketHD lookups.  Resolve the aggregate from the child
     * episodes first.
     */
    if (item?.kind === "season" && Array.isArray(item.children) && item.children.length) {
      const sources = [...new Set(item.children.map(child => canonicalSource(child?.source, child)))];
      if (sources.length === 1) return sources[0];

      /* A season may contain episodes fetched at different times/sources. For
       * the compact row, ARR takes precedence because those are precisely the
       * releases that still need a RocketHD existence check. rePollo/Kryo
       * releases are already known to exist on RHD. */
      if (sources.some(source => source === "Radarr" || source === "Sonarr")) return "Sonarr";
      if (sources.includes("Kryo Manager")) return "Kryo Manager";
      if (sources.includes("rePollo")) return "rePollo";
      return "SABnzbd";
    }
    return canonicalSource(item?.source, item);
  }

  function sourceClassName(value) {
    const source = canonicalSource(value);
    if (source === "rePollo") return "source-reppollo";
    if (source === "Kryo Manager") return "source-kryo";
    if (source === "Radarr") return "source-radarr";
    if (source === "Sonarr") return "source-sonarr";
    return "source-sab";
  }

  window.effectiveDownloadSource = effectiveDownloadSource;

  /* sab-extension.js uses this function dynamically when rendering SAB cards. */
  sourceClass = sourceClassName;

  const basePopulateFilters = populateFilters;
  populateFilters = function() {
    basePopulateFilters();
    const all = [
      ...(DATA?.movies || []),
      ...(DATA?.episodes || []),
      ...(DATA?.sabDownloads || []),
    ];
    const sources = all.map(effectiveDownloadSource);
    populateSelect(
      "source",
      ["Radarr", "Sonarr", "Kryo Manager", "rePollo", "SABnzbd", ...sources],
      "Alle Quellen"
    );
  };

  const baseFilteredOriginal = baseFiltered;
  baseFiltered = function(items) {
    const filtered = baseFilteredOriginal(items);
    const rawWanted = el("source")?.value || "";
    if (!rawWanted) return filtered;
    const wanted = canonicalSource(rawWanted);
    return filtered.filter(item => effectiveDownloadSource(item) === wanted);
  };

  const baseCardHtml = cardHtml;
  cardHtml = function(item) {
    let html = baseCardHtml(item);
    if (item?.kind === "failed") return html;

    const source = effectiveDownloadSource(item);
    const badge = `<span class="badge source-badge ${sourceClassName(source)}">${esc(source)}</span>`;
    return html.replace(/(<div class="meta">[\s\S]*?<\/div>)/, `$1${badge}`);
  };

  const baseShowDetails = showDetails;
  showDetails = function(raw) {
    const item = JSON.parse(raw);
    if (item.kind === "usenet") {
      baseShowDetails(raw);
      return;
    }

    const source = effectiveDownloadSource(item);
    const fields = [
      ["Titel", item.title],
      ["Download-Quelle", source],
      ["Release", item.originalRelease],
      ["Indexer", item.indexer],
      ["Download Client", item.downloadClient],
      ["Qualität", item.quality],
      ["Release Group", item.releaseGroup],
      ["Grab", fmtDate(item.grabDate || item.date)],
      ["Import", fmtDate(item.importDate)],
      ["Zielordner", item.targetFolder],
      ["Zieldatei", item.targetFile],
      ["Größe", item.sizeText || bytes(item.size)],
    ];

    el("detailsBody").innerHTML = `<h2>${esc(item.title)}</h2><dl>${fields
      .filter(v => v[1])
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`)
      .join("")}</dl>${item.arrUrl ? `<a class="arr-button" target="_blank" href="${esc(item.arrUrl)}">In ${item.kind === "movie" ? "Radarr" : "Sonarr"} öffnen ↗</a>` : ""}`;
    el("details").showModal();
  };
  window.showDetails = showDetails;
})();