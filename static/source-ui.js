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
    /* Keep all expected choices available even when one source has no rows in
     * the current cache yet. This also makes the selector usable before SAB
     * enrichment has produced its first rows. */
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

/* v4 calendar compatibility layer.
 * redesign-v4 owns the selected range. This layer only fixes the popover
 * anchoring/size and restores the requested 14-day preset without touching
 * the download/statistics data pipeline.
 */
(() => {
  let preset14Active = false;
  let applying14 = false;
  let patching = false;
  let observer = null;

  function ymd(value) {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function injectStyle() {
    if (document.getElementById("v4CalendarCompatStyle")) return;
    const style = document.createElement("style");
    style.id = "v4CalendarCompatStyle";
    style.textContent = `
      .v4-calendar-pop.v4-calendar-fixed{
        position:fixed!important;
        right:auto!important;
        top:auto!important;
        width:430px!important;
        grid-template-columns:244px 186px!important;
        overflow:hidden!important;
        z-index:2200!important;
      }
      .v4-calendar-fixed .v4-cal-left{padding:12px 13px!important}
      .v4-calendar-fixed .v4-cal-right{padding:11px 12px!important}
      .v4-calendar-fixed .v4-cal-head{margin-bottom:8px!important;font-size:13px}
      .v4-calendar-fixed .v4-cal-day{height:27px!important;font-size:11px!important}
      .v4-calendar-fixed .v4-range-choice{padding:6px 6px!important;font-size:11px!important}
      .v4-calendar-fixed .v4-exact-label{font-size:10px!important;line-height:1.35;color:#8193a1!important}
      .v4-calendar-fixed .v4-custom-range{display:none!important;grid-template-columns:1fr!important;gap:6px!important}
      .v4-calendar-fixed .v4-custom-range.calendar-fix-show{display:grid!important}
      .v4-calendar-fixed .v4-custom-range input{font-size:11px!important;padding:7px!important}
      .v4-calendar-fixed .v4-custom-apply{grid-column:1!important}
      @media(max-width:620px){
        .v4-calendar-pop.v4-calendar-fixed{width:min(410px,calc(100vw - 16px))!important;grid-template-columns:1fr!important;max-height:calc(100vh - 90px);overflow:auto!important}
        .v4-calendar-fixed .v4-cal-right{border-left:0!important;border-top:1px solid #263b4c}
      }
    `;
    document.head.appendChild(style);
  }

  function positionCalendar() {
    const pop = document.getElementById("v4Calendar");
    const button = document.getElementById("v4DateButton");
    if (!pop || !button || pop.hidden) return;

    pop.classList.add("v4-calendar-fixed");
    const rect = button.getBoundingClientRect();
    const width = Math.min(430, window.innerWidth - 16);
    const margin = 8;
    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    const measuredHeight = pop.getBoundingClientRect().height || 330;
    let top = rect.bottom + 7;
    if (top + measuredHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - measuredHeight - 7);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function markActivePreset(pop) {
    const label = document.getElementById("v4DateLabel")?.textContent?.trim() || "";
    pop.querySelectorAll(".v4-range-choice").forEach(button => button.classList.remove("active"));
    const map = {
      "Heute": "today",
      "Gestern": "yesterday",
      "Letzte 7 Tage": "7",
      "Letzte 30 Tage": "30",
    };
    if (preset14Active) {
      pop.querySelector('[data-fix-range="14"]')?.classList.add("active");
    } else if (map[label]) {
      pop.querySelector(`[data-range="${map[label]}"]`)?.classList.add("active");
    } else if (label === "Benutzerdefiniert") {
      pop.querySelector('[data-range="custom"]')?.classList.add("active");
    }
  }

  function addFourteenDayPreset(pop) {
    if (pop.querySelector('[data-fix-range="14"]')) return;
    const seven = pop.querySelector('[data-range="7"]');
    if (!seven) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "v4-range-choice";
    button.dataset.fixRange = "14";
    button.textContent = "Letzte 14 Tage";
    seven.insertAdjacentElement("afterend", button);

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const from = new Date();
      from.setHours(12, 0, 0, 0);
      from.setDate(from.getDate() - 13);
      const to = new Date();
      to.setHours(12, 0, 0, 0);

      const fromInput = pop.querySelector("#v4From");
      const toInput = pop.querySelector("#v4To");
      const apply = pop.querySelector("#v4CustomApply");
      if (!fromInput || !toInput || !apply) return;

      preset14Active = true;
      applying14 = true;
      fromInput.value = ymd(from);
      toInput.value = ymd(to);
      apply.click();
      queueMicrotask(() => {
        applying14 = false;
        patchCalendar();
      });
    });
  }

  function patchCalendar() {
    if (patching) return;
    const pop = document.getElementById("v4Calendar");
    const label = document.getElementById("v4DateLabel");
    if (!pop || !label) return;

    patching = true;
    try {
      injectStyle();

      /* The v4 preview originally had this extra item, but the requested preset
       * set is Heute, Gestern, 7, 14 and 30 Tage. */
      pop.querySelector('[data-range="last24"]')?.remove();
      addFourteenDayPreset(pop);

      const exactHint = pop.querySelector(".v4-exact-label");
      if (exactHint) exactHint.textContent = "Kalendertag anklicken = exakter Tag (letzte 30 Tage)";

      if (preset14Active) label.textContent = "Letzte 14 Tage";

      const customRange = pop.querySelector(".v4-custom-range");
      if (customRange) {
        const showCustom = !preset14Active && label.textContent.trim() === "Benutzerdefiniert";
        customRange.classList.toggle("calendar-fix-show", showCustom);
      }

      markActivePreset(pop);
      positionCalendar();
    } finally {
      patching = false;
    }
  }

  function bindGlobalEvents() {
    document.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest("#v4Reset")) preset14Active = false;

      const normalPreset = target.closest("#v4Calendar [data-range]");
      if (normalPreset && !applying14) preset14Active = false;

      const exactDay = target.closest("#v4Calendar [data-date]");
      if (exactDay && !applying14) preset14Active = false;

      if (target.closest("#v4CustomApply") && !applying14) preset14Active = false;
    }, true);

    window.addEventListener("resize", positionCalendar, {passive:true});
    window.addEventListener("scroll", positionCalendar, {passive:true});
  }

  function init() {
    injectStyle();
    bindGlobalEvents();

    observer = new MutationObserver(() => {
      if (!patching) queueMicrotask(patchCalendar);
    });
    observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:["hidden"]});
    patchCalendar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, {once:true});
  else init();
})();
