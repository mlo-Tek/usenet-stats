/* Compact calendar compatibility layer for the v4 dashboard.
 * Keeps the popup anchored to the date button without shifting the list and
 * preserves the requested presets: Heute, Gestern, 7, 14, 30 Tage + custom.
 */
(() => {
  let preset14 = false;
  let patching = false;

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
        right:auto!important;
        top:auto!important;
        width:420px!important;
        grid-template-columns:238px 182px!important;
        z-index:2500!important;
        overflow:auto!important;
        box-shadow:0 20px 55px rgba(0,0,0,.68)!important;
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
        #v4Calendar.v4-calendar-overlay{width:calc(100vw - 16px)!important;grid-template-columns:1fr!important}
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
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, window.innerWidth - margin * 2);
    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const top = Math.max(margin, rect.bottom + 6);

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.maxHeight = `${Math.max(220, window.innerHeight - top - margin)}px`;
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
      if (!fromInput || !toInput) return;
      fromInput.value = ymd(from);
      toInput.value = ymd(now);
      preset14 = true;
      pop.querySelector("#v4CustomApply")?.click();
      queueMicrotask(() => {
        const label = document.getElementById("v4DateLabel");
        if (label) label.textContent = "Letzte 14 Tage";
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
    if (preset14 || label === "Letzte 14 Tage") {
      pop.querySelector('[data-v4-range="14"]')?.classList.add("active");
    } else if (map[label]) {
      pop.querySelector(`[data-range="${map[label]}"]`)?.classList.add("active");
    }
  }

  function patch() {
    if (patching) return;
    const pop = document.getElementById("v4Calendar");
    if (!pop || pop.hidden) return;
    patching = true;
    try {
      injectCss();
      pop.classList.add("v4-calendar-overlay");
      pop.querySelector('[data-range="last24"]')?.remove();
      add14(pop);
      const hint = pop.querySelector(".v4-exact-label");
      if (hint) hint.textContent = "Kalendertag anklicken = exakter Tag (letzte 30 Tage)";
      const custom = pop.querySelector(".v4-custom-range");
      if (custom) {
        const label = document.getElementById("v4DateLabel")?.textContent?.trim();
        custom.classList.toggle("v4-custom-open", label === "Benutzerdefiniert" && !preset14);
      }
      markActive(pop);
      position();
    } finally {
      patching = false;
    }
  }

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("#v4DateButton")) requestAnimationFrame(patch);
    if (target.closest('#v4Calendar [data-range]:not([data-range="custom"])') || target.closest("#v4Calendar [data-date]") || target.closest("#v4Reset")) preset14 = false;
    if (target.closest('#v4Calendar [data-range="custom"]')) {
      preset14 = false;
      requestAnimationFrame(patch);
    }
  }, true);

  window.addEventListener("resize", () => requestAnimationFrame(position));
  window.addEventListener("scroll", () => requestAnimationFrame(position), true);

  const observer = new MutationObserver(() => {
    const pop = document.getElementById("v4Calendar");
    if (pop && !pop.hidden) requestAnimationFrame(patch);
  });

  function init() {
    injectCss();
    const pop = document.getElementById("v4Calendar");
    if (pop) observer.observe(pop, {childList:true, subtree:false, attributes:true, attributeFilter:["hidden"]});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
