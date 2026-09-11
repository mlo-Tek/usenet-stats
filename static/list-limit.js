/* Fixed result pagination.
 * Stats, chart and tab counters continue to use the complete selected period.
 * Only the result-card DOM is paginated and never shows more than 50 rows.
 */
(() => {
  const PAGE_SIZE = 50;

  let currentPage = 0;
  let allNodes = [];
  let applying = false;
  let scheduled = false;
  let captureScheduled = false;
  let ignoreOwnMutation = false;
  let topControls = null;
  let bottomControls = null;
  let topSummary = null;
  let bottomSummary = null;
  let topPrevious = null;
  let topNext = null;
  let bottomPrevious = null;
  let bottomNext = null;

  function scrollToListStart() {
    requestAnimationFrame(() => {
      el("list")?.scrollIntoView({behavior:"smooth", block:"start"});
    });
  }

  function controlsHtml(prefix) {
    return `
      <div class="list-limit-summary" id="${prefix}Summary"></div>
      <div class="list-limit-actions">
        <button id="${prefix}Previous" type="button">← Vorherige 50</button>
        <button id="${prefix}Next" type="button">Nächste 50 →</button>
      </div>
    `;
  }

  function goPrevious() {
    if (currentPage <= 0) return;
    currentPage -= 1;
    applyPage(false);
    scrollToListStart();
  }

  function goNext() {
    const pageCount = Math.max(1, Math.ceil(allNodes.length / PAGE_SIZE));
    if (currentPage >= pageCount - 1) return;
    currentPage += 1;
    applyPage(false);
    scrollToListStart();
  }

  function ensureControls() {
    if (topControls && bottomControls) return;

    const list = el("list");

    topControls = document.createElement("section");
    topControls.id = "listLimitControlsTop";
    topControls.className = "list-limit";
    topControls.hidden = true;
    topControls.innerHTML = controlsHtml("listPageTop");
    list.parentNode.insertBefore(topControls, list);

    bottomControls = document.createElement("section");
    bottomControls.id = "listLimitControls";
    bottomControls.className = "list-limit";
    bottomControls.hidden = true;
    bottomControls.innerHTML = controlsHtml("listPageBottom");
    list.parentNode.insertBefore(bottomControls, list.nextSibling);

    topSummary = el("listPageTopSummary");
    bottomSummary = el("listPageBottomSummary");
    topPrevious = el("listPageTopPrevious");
    topNext = el("listPageTopNext");
    bottomPrevious = el("listPageBottomPrevious");
    bottomNext = el("listPageBottomNext");

    topPrevious.addEventListener("click", goPrevious);
    bottomPrevious.addEventListener("click", goPrevious);
    topNext.addEventListener("click", goNext);
    bottomNext.addEventListener("click", goNext);
  }

  function visibleItemNodes() {
    return [...el("list").children].filter(node => node.classList?.contains("item"));
  }

  function syncControls(total, pageCount, start, end) {
    const hidden = total === 0;
    topControls.hidden = hidden;
    bottomControls.hidden = hidden;

    const text = total > 0
      ? `${start + 1}–${end} von ${total} Einträgen · Seite ${currentPage + 1} von ${pageCount}`
      : "";
    topSummary.textContent = text;
    bottomSummary.textContent = text;

    const hidePrevious = currentPage === 0;
    const hideNext = currentPage >= pageCount - 1;
    topPrevious.hidden = hidePrevious;
    bottomPrevious.hidden = hidePrevious;
    topNext.hidden = hideNext;
    bottomNext.hidden = hideNext;
  }

  function applyPage(capture = true) {
    ensureControls();

    if (TAB === "indexers" || el("list").hidden) {
      topControls.hidden = true;
      bottomControls.hidden = true;
      return;
    }

    applying = true;
    ignoreOwnMutation = true;

    const list = el("list");
    if (capture) allNodes = visibleItemNodes();

    const total = allNodes.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    currentPage = Math.min(Math.max(0, currentPage), pageCount - 1);

    for (const node of visibleItemNodes()) node.remove();

    const start = currentPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, total);
    const fragment = document.createDocumentFragment();
    for (const node of allNodes.slice(start, end)) fragment.appendChild(node);
    list.appendChild(fragment);

    syncControls(total, pageCount, start, end);

    applying = false;
    queueMicrotask(() => { ignoreOwnMutation = false; });
  }

  function schedulePage(capture = true) {
    if (applying) return;
    captureScheduled = captureScheduled || capture;
    if (scheduled) return;

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const shouldCapture = captureScheduled;
      captureScheduled = false;
      applyPage(shouldCapture);
    });
  }

  function resetPagination() {
    currentPage = 0;
    schedulePage(true);
  }

  function patchRender(name) {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = function(...args) {
      const result = original.apply(this, args);
      schedulePage(true);
      return result;
    };
  }

  function bindResetEvents() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", resetPagination);
    });

    ["days", "search", "source", "indexer", "quality", "group", "client", "library", "seriesType", "upgrade", "sort", "groupSeries"].forEach(id => {
      const node = el(id);
      node?.addEventListener("input", resetPagination);
      node?.addEventListener("change", resetPagination);
    });

    document.querySelectorAll(".quick").forEach(button => {
      button.addEventListener("click", resetPagination);
    });

    ["applyDates", "clearFilters", "preset4k"].forEach(id => {
      el(id)?.addEventListener("click", resetPagination);
    });
  }

  function init() {
    ensureControls();
    patchRender("renderList");
    patchRender("renderTab");
    patchRender("renderAll");
    bindResetEvents();

    const observer = new MutationObserver(() => {
      if (ignoreOwnMutation) return;
      schedulePage(true);
    });
    observer.observe(el("list"), {childList: true});

    resetPagination();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
