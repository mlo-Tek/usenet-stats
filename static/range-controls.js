/* Range control consistency.
 * Quick ranges (Heute/Gestern/Diese Woche) must not leave the visible
 * 7/30/90-days selector on a stale value. Otherwise selecting "30 Tage"
 * again does not fire a change event and CUSTOM_RANGE remains active.
 */
(() => {
  const days = document.getElementById("days");
  const quickButtons = [...document.querySelectorAll(".quick")];
  if (!days || !quickButtons.length) return;

  const QUICK_VALUE = "__quick__";
  let quickOption = [...days.options].find(o => o.value === QUICK_VALUE);
  if (!quickOption) {
    quickOption = document.createElement("option");
    quickOption.value = QUICK_VALUE;
    quickOption.disabled = true;
    quickOption.hidden = true;
    quickOption.textContent = "Zeitraum";
    days.insertBefore(quickOption, days.firstChild);
  }

  function clearQuickVisuals() {
    quickButtons.forEach(b => b.classList.remove("active-range"));
  }

  function setQuickVisual(which) {
    clearQuickVisuals();
    const button = quickButtons.find(b => b.dataset.range === which);
    button?.classList.add("active-range");

    const labels = {
      today: "Heute",
      yesterday: "Gestern",
      week: "Diese Woche",
    };
    quickOption.textContent = labels[which] || "Zeitraum";
    quickOption.hidden = false;
    days.value = QUICK_VALUE;
  }

  /* Existing quick-button listeners call setQuick dynamically, so replacing
   * the global function here fixes them without touching the base app. */
  const baseSetQuick = setQuick;
  setQuick = function(which) {
    baseSetQuick(which);
    setQuickVisual(which);
  };

  /* Selecting 7/30/90 days must always cancel any quick/custom period. */
  days.addEventListener("change", () => {
    if (days.value === QUICK_VALUE) return;
    CUSTOM_RANGE = null;
    clearQuickVisuals();
    quickOption.hidden = true;
    el("dateFrom").value = "";
    el("dateTo").value = "";
    renderAll();
  });

  /* Custom date ranges are another exclusive period mode. The original
   * applyDates handler runs first; this listener only synchronizes the UI. */
  document.getElementById("applyDates")?.addEventListener("click", () => {
    if (!el("dateFrom").value || !el("dateTo").value) return;
    clearQuickVisuals();
    quickOption.textContent = "Eigener Zeitraum";
    quickOption.hidden = false;
    days.value = QUICK_VALUE;
  });

  document.getElementById("clearFilters")?.addEventListener("click", () => {
    clearQuickVisuals();
    quickOption.hidden = true;
    days.value = "7";
    CUSTOM_RANGE = null;
    renderAll();
  });

  const style = document.createElement("style");
  style.textContent = `
    .quick.active-range{
      background:color-mix(in srgb,var(--blue) 17%,var(--surface-strong));
      border-color:color-mix(in srgb,var(--blue) 45%,var(--border));
      box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--blue) 16%,transparent);
    }
  `;
  document.head.appendChild(style);
})();
