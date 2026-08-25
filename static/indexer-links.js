/* Generic indexer detail links.
 * The movie/series title keeps opening Radarr/Sonarr. The blue indexer badge
 * opens the original indexer's release/details page from Arr's nzbInfoUrl.
 */
(() => {
  function httpUrl(value) {
    try {
      const u = new URL(String(value || ""));
      return (u.protocol === "http:" || u.protocol === "https:") ? u.href : "";
    } catch {
      return "";
    }
  }

  function grabUrlMaps() {
    const byKey = new Map();
    const byDownloadId = new Map();
    const byRelease = new Map();

    for (const g of (DATA?.grabs || [])) {
      const url = httpUrl(g.indexerUrl);
      if (!url) continue;

      const key = String(g.grabKey || "").trim();
      const did = String(g.downloadId || "").trim();
      const release = String(g.originalRelease || "").trim().toLowerCase();

      if (key) byKey.set(key, url);
      if (did) byDownloadId.set(did, url);
      if (release && !byRelease.has(release)) byRelease.set(release, url);
    }

    return {byKey, byDownloadId, byRelease};
  }

  function indexerUrlForItem(item, maps) {
    if (!item) return "";

    const direct = httpUrl(item.indexerUrl);
    if (direct) return direct;

    const key = String(item.grabKey || "").trim();
    if (key && maps.byKey.has(key)) return maps.byKey.get(key);

    const did = String(item.downloadId || item.nzoId || "").trim();
    if (did && maps.byDownloadId.has(did)) return maps.byDownloadId.get(did);

    const release = String(item.originalRelease || "").trim().toLowerCase();
    if (release && maps.byRelease.has(release)) return maps.byRelease.get(release);

    return "";
  }

  function decorate() {
    const list = document.getElementById("list");
    if (!list) return;

    const cards = [...list.querySelectorAll(":scope > .item")];
    const maps = grabUrlMaps();

    cards.forEach((card, index) => {
      const item = Array.isArray(CURRENT) ? CURRENT[index] : null;
      const badge = card.querySelector(".badge.indexer");
      if (!badge) return;

      const url = indexerUrlForItem(item, maps);

      // Remove the older, incorrect Radarr/Sonarr click behavior.
      badge.classList.remove("indexer-arr-link");
      badge.removeAttribute("data-indexer-arr-url");

      if (!url) {
        badge.classList.remove("indexer-source-link");
        badge.removeAttribute("data-indexer-url");
        badge.removeAttribute("role");
        badge.removeAttribute("tabindex");
        badge.removeAttribute("title");
        return;
      }

      badge.classList.add("indexer-source-link");
      badge.dataset.indexerUrl = url;
      badge.setAttribute("role", "link");
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("title", `${item?.indexer || "Indexer"} öffnen`);
    });
  }

  function scheduleDecorate() {
    // Run after the existing render/decorator code so this behavior wins over
    // the old Radarr/Sonarr badge handler from earlier versions.
    setTimeout(decorate, 0);
    setTimeout(decorate, 60);
  }

  function openBadge(badge) {
    const url = httpUrl(badge?.dataset?.indexerUrl);
    if (!url) return false;
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  // Capture phase intentionally runs before the old delegated badge handler.
  document.addEventListener("click", event => {
    const badge = event.target.closest?.(".badge.indexer.indexer-source-link");
    if (!badge) return;
    if (!openBadge(badge)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const badge = event.target.closest?.(".badge.indexer.indexer-source-link");
    if (!badge) return;
    if (!openBadge(badge)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const style = document.createElement("style");
  style.textContent = `
    .badge.indexer.indexer-source-link{
      cursor:pointer;
      transition:transform .14s ease,box-shadow .18s ease,filter .18s ease;
    }
    .badge.indexer.indexer-source-link:hover{
      filter:brightness(1.12);
      box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 15%,transparent);
      transform:translateY(-1px);
    }
    .badge.indexer.indexer-source-link:focus-visible{
      outline:2px solid var(--blue);
      outline-offset:3px;
    }
  `;
  document.head.appendChild(style);

  const observer = new MutationObserver(scheduleDecorate);

  function init() {
    const list = document.getElementById("list");
    if (list) observer.observe(list, {childList:true, subtree:true});

    document.addEventListener("input", scheduleDecorate, true);
    document.addEventListener("change", scheduleDecorate, true);
    document.addEventListener("click", scheduleDecorate, false);
    scheduleDecorate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
