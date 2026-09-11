/* Result list limiter.
 * Keeps stats, chart and tab counters based on the full selected period while
 * only a compact slice of result cards stays visible in the DOM.
 */
(() => {
  const DEFAULT_LIMIT = 50;
  const LOAD_STEP = 50;
  const OPTIONS = [25, 50, 100, "all"];

  let selectedLimit = DEFAULT_LIMIT;
  let visibleCount = DEFAULT_LIMIT;
  let storedNodes = [];
  let applying = false;
  let scheduled = false;
  let ignoreOwnMutation = false;
  let controls = null;
  let summary = null;
  let select = null;
  let more = null;

  function ensureControls() {
    if (controls) return;

    controls = document.createElement("section");
    controls.id = "listLimitControls";
    controls.className = "list-limit";
    controls.hidden = true;
    controls.innerHTML = `
      <div class="list-limit-summary" id="listLimitSummary"></div>
      <div class="list-limit-actions">
        <label class="list-limit-select">Sichtbar
          <select id="listLimitSelect" aria-label="Sichtbare Einträge">
            ${OPTIONS.map(value => {
              const label = value === "all" ? "Alle" : String(value);
              const selected = value === DEFAULT_LIMIT ? " selected" : "";
              return `<option value="${value}"${selected}>${label}</option>`;
            }).join("")}
          </select>
        </label>
        <button id="listLimitMore" type="button">Weitere 50 laden</button>
      </div>
    `;

    const list = el("list");
    list.parentNode.insertBefore(controls, list);
    summary = el("listLimitSummary");
    select = el("listLimitSelect");
    more = el("listLimitMore");

    select.addEventListener("change", () => {
      selectedLimit = select.value === "all" ? "all" : Number(select.value);
      visibleCount = selectedLimit === "all" ? Number.MAX_SAFE_INTEGER : selectedLimit;
      applyLimit();
    });

    more.addEventListener("click", () => {
      visibleCount += LOAD_STEP;
      applyLimit();
    });
  }

  function currentLimit() {
    return selectedLimit === "all" ? Number.MAX_SAFE_INTEGER : visibleCount;
  }

  function restoreNodes() {
    if (!storedNodes.length) return;
    const list = el("list");
    const fragment = document.createDocumentFragment();
    for (const node of storedNodes) fragment.appendChild(node);
    storedNodes = [];
    list.appendChild(fragment);
  }

  function syncSelect() {
    if (!select) return;
    select.value = selectedLimit === "all" ? "all" : String(selectedLimit);
  }

  function applyLimit() {
    ensureControls();
    if (TAB === "indexers" || el("list").hidden) {
      controls.hidden = true;
      return;
    }

    applying = true;
    ignoreOwnMutation = true;
    restoreNodes();

    const list = el("list");
    const nodes = [...list.children].filter(node => node.classList?.contains("item"));
    const total = nodes.length;
    const limit = currentLimit();
    const shown = Math.min(total, limit);

    storedNodes = nodes.slice(shown);
    for (const node of storedNodes) node.remove();

    controls.hidden = total === 0;
    summary.textContent = total === 1
      ? "1 Eintrag sichtbar"
      : `${shown} von ${total} Einträgen sichtbar`;
    more.hidden = shown >= total || selectedLimit === "all";
    syncSelect();

    applying = false;
    queueMicrotask(() => { ignoreOwnMutation = false; });
  }

  function scheduleLimit() {
    if (applying || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyLimit();
    });
  }

  function resetListLimit() {
    selectedLimit = DEFAULT_LIMIT;
    visibleCount = DEFAULT_LIMIT;
    storedNodes = [];
    syncSelect();
    scheduleLimit();
  }

  function patchRender(name) {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = function(...args) {
      const result = original.apply(this, args);
      scheduleLimit();
      return result;
    };
  }

  function bindResetEvents() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", resetListLimit);
    });

    ["days", "search", "source", "indexer", "quality", "group", "client", "library", "seriesType", "upgrade", "sort", "groupSeries"].forEach(id => {
      const node = el(id);
      node?.addEventListener("input", resetListLimit);
      node?.addEventListener("change", resetListLimit);
    });

    document.querySelectorAll(".quick").forEach(button => {
      button.addEventListener("click", resetListLimit);
    });

    ["applyDates", "clearFilters", "preset4k"].forEach(id => {
      el(id)?.addEventListener("click", resetListLimit);
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
      scheduleLimit();
    });
    observer.observe(el("list"), {childList: true});

    resetListLimit();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
