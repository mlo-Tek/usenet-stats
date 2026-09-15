/* Compact calendar overlay for the v4 dashboard.
 * It never participates in layout: opening it must not move or resize the list.
 * Presets: Heute, Gestern, 7, 14, 30 Tage + custom; calendar days select one day.
 */
(() => {
  let preset14 = false;
  let applying14 = false;
  let patchQueued = false;

  function ymd(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  }

  function injectCss() {
    if (document.getElementById("v4CalendarOverlayCss")) return;
    const style = document.createElement("style");
    style.id = "v4CalendarOverlayCss";
    style.textContent = `
      #v4Calendar.v4-calendar-overlay{
        position:fixed!important;
        inset:auto!important;
        width:420px!important;
        max-width:calc(100vw - 16px)!important;
        grid-template-columns:238px 182px!important;
        z-index:5000!important;
        overflow:auto!important;
        overscroll-behavior:contain!important;
        box-shadow:0 20px 55px rgba(0,0,0,.72)!important;
      }
      #v4Calendar.v4-calendar-overlay .v4-cal-left{padding:11px 12px!important}
      #v4Calendar.v4-calendar-overlay .v4-cal-right{padding:10px 11px!important}
      #v4Calendar.v4-calendar-overlay .v4-cal-head{margin-bottom:7px!important;font-size:13px!important}
      #v4Calendar.v4-calendar-overlay .v4-cal-week{margin-bottom:3px!important}
      #v4Calendar.v4-calendar-overlay .v4-cal-day{height:27px!important;font-size:11px!important}
      #v4Calendar.v4-calendar-overlay .v4-range-choice{padding:6px 5px!important;font-size:11px!important}
      #v4Calendar.v4-calendar-overlay .v4-exact-label{font-size:10px!important;line-height:1.35!important;color:#8295a3!important}
      #v4Calendar.v4-calendar-overlay .v4-custom-range{display:none!important;grid-template-columns:1fr!important;gap:6px!important}
      #v4Calendar.v4-calendar-overlay .v4-custom-range.v4-custom-open{display:grid!important}
      #v4Calendar.v4-calendar-overlay .v4-custom-range input{font-size:11px!important;padding:7px!important}
      #v4Calendar.v4-calendar-overlay .v4-custom-apply{grid-column:1!important}
      @media(max-width:520px){
        #v4Calendar.v4-calendar-overlay{grid-template-columns:1fr!important}
        #v4Calendar.v4-calendar-overlay .v4-cal-right{border-left:0!important;border-top:1px solid #263b4c!important}
      }
    `;
    document.head.appendChild(style);
  }

  function position() {
    const pop = document.getElementById("v4Calendar");
    const button = document.getElementById("v4DateButton");
    if (!pop || !button || pop.hidden) return;

    pop.classList.add("v4-calendar-overlay");
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const width = Math.min(420, Math.max(280, window.innerWidth - margin * 2));
    const maxHeight = Math.max(180, Math.min(360, window.innerHeight - margin * 2));

    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    /* Prefer below the button. If the viewport is short, clamp the whole popup
       inside the viewport and let its own content scroll instead of placing the
       calendar partly above the visible area. */
    let top = rect.bottom + 6;
    top = Math.max(margin, Math.min(top, window.innerHeight - maxHeight - margin));

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.maxHeight = `${Math.round(maxHeight)}px`;
  }

  function add14(pop) {
    if (pop.querySelector('[data-v4-range="14"]')) return;
    const seven = pop.querySelector('[data-range="7"]');
    if (!seven) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "v4-range-choice";
    button.dataset.v4Range = "14";
    button.textContent = "Letzte 14 Tage";
    seven.insertAdjacentElement("afterend", button);

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 13);
      const fromInput = pop.querySelector("#v4From");
      const toInput = pop.querySelector("#v4To");
      const apply = pop.querySelector("#v4CustomApply");
      if (!fromInput || !toInput || !apply) return;

      applying14 = true;
      preset14 = true;
      fromInput.value = ymd(from);
      toInput.value = ymd(now);
      apply.click();
      requestAnimationFrame(() => {
        const label = document.getElementById("v4DateLabel");
        if (label) label.textContent = "Letzte 14 Tage";
        applying14 = false;
      });
    });
  }

  function markActive(pop) {
    pop.querySelectorAll(".v4-range-choice").forEach(node => node.classList.remove("active"));
    const label = document.getElementById("v4DateLabel")?.textContent?.trim() || "";
    const map = {
      "Heute":"today",
      "Gestern":"yesterday",
      "Letzte 7 Tage":"7",
      "Letzte 30 Tage":"30",
      "Benutzerdefiniert":"custom",
    };
    if (preset14 || label === "Letzte 14 Tage") pop.querySelector('[data-v4-range="14"]')?.classList.add("active");
    else if (map[label]) pop.querySelector(`[data-range="${map[label]}"]`)?.classList.add("active");
  }

  function patch() {
    patchQueued = false;
    const pop = document.getElementById("v4Calendar");
    if (!pop || pop.hidden) return;
    injectCss();
    pop.classList.add("v4-calendar-overlay");

    /* The requested preset list starts at Heute; remove the redundant rolling
       24-hour entry from this compact menu. */
    pop.querySelector('[data-range="last24"]')?.remove();
    add14(pop);

    const hint = pop.querySelector(".v4-exact-label");
    if (hint) hint.textContent = "Kalendertag anklicken = exakter Tag (letzte 30 Tage)";

    const label = document.getElementById("v4DateLabel");
    if (preset14 && label && label.textContent !== "Letzte 14 Tage") label.textContent = "Letzte 14 Tage";

    const custom = pop.querySelector(".v4-custom-range");
    if (custom) custom.classList.toggle("v4-custom-open", !preset14 && label?.textContent?.trim() === "Benutzerdefiniert");

    markActive(pop);
    position();
  }

  function queuePatch() {
    if (patchQueued) return;
    patchQueued = true;
    requestAnimationFrame(patch);
  }

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest("#v4DateButton")) queuePatch();

    if (!applying14 && (
      target.closest('#v4Calendar [data-range]:not([data-range="custom"])') ||
      target.closest("#v4Calendar [data-date]") ||
      target.closest("#v4Reset")
    )) preset14 = false;

    if (target.closest('#v4Calendar [data-range="custom"]')) {
      preset14 = false;
      queuePatch();
    }
  }, true);

  window.addEventListener("resize", queuePatch);
  window.addEventListener("scroll", queuePatch, true);

  function init() {
    injectCss();
    const pop = document.getElementById("v4Calendar");
    if (!pop) return;
    new MutationObserver(queuePatch).observe(pop, {childList:true, attributes:true, attributeFilter:["hidden"]});

    const label = document.getElementById("v4DateLabel");
    if (label) new MutationObserver(() => {
      if (preset14 && !applying14 && label.textContent !== "Letzte 14 Tage") label.textContent = "Letzte 14 Tage";
    }).observe(label, {childList:true, characterData:true, subtree:true});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();