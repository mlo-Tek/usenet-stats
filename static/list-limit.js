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
  let controls = null;
  let summary = null;
  let previous = null;
  let next = null;

  function ensureControls() {
    if (controls) return;

    controls = document.createElement("section");
    controls.id = "listLimitControls";
    controls.className = "list-limit";
    controls.hidden = true;
    controls.innerHTML = `
      <div class="list-limit-summary" id="listLimitSummary"></div>
      <div class="list-limit-actions">
        <button id="listPagePrevious" type="button">← Vorherige 50</button>
        <button id="listPageNext" type="button">Nächste 50 →</button>
      </div>
    `;

    const list = el("list");
    list.parentNode.insertBefore(controls, list.nextSibling);
    summary = el("listLimitSummary");
    previous = el("listPagePrevious");
    next = el("listPageNext");

    previous.addEventListener("click", () => {
      if (currentPage <= 0) return;
      currentPage -= 1;
      applyPage(false);
      controls.scrollIntoView({behavior:"smooth", block:"nearest"});
    });

    next.addEventListener("click", () => {
      const pageCount = Math.max(1, Math.ceil(allNodes.length / PAGE_SIZE));
      if (currentPage >= pageCount - 1) return;
      currentPage += 1;
      applyPage(false);
      controls.scrollIntoView({behavior:"smooth", block:"nearest"});
    });
  }

  function visibleItemNodes() {
    return [...el("list").children].filter(node => node.classList?.contains("item"));
  }

  function applyPage(capture = true) {
    ensureControls();

    if (TAB === "indexers" || el("list").hidden) {
      controls.hidden = true;
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

    controls.hidden = total === 0;
    if (total > 0) {
      summary.textContent = `${start + 1}–${end} von ${total} Einträgen · Seite ${currentPage + 1} von ${pageCount}`;
    } else {
      summary.textContent = "";
    }

    previous.hidden = currentPage === 0;
    next.hidden = currentPage >= pageCount - 1;

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
