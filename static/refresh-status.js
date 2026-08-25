/* Clear refresh feedback for the incremental refresh pipeline. */
(() => {
  const original = window.renderSyncStatus;

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  function recentFinished(meta) {
    const ts = Number(meta?.lastRefreshFinished || 0);
    return ts && (Date.now() / 1000 - ts) < 30;
  }

  window.renderSyncStatus = function(meta = {}, generatedAt = null, source = "server") {
    const box = document.getElementById("syncStatus");
    const text = document.getElementById("syncText");
    const button = document.getElementById("refresh");

    if (!box || !text || !button) {
      if (typeof original === "function") original(meta, generatedAt, source);
      return;
    }

    box.classList.remove("refreshing", "error");

    if (meta.lastError) {
      box.classList.add("error");
      text.textContent = `Aktualisierung fehlgeschlagen · Cache bleibt aktiv`;
      button.disabled = false;
      button.innerHTML = "↻ Aktualisieren";
      return;
    }

    if (meta.refreshing) {
      box.classList.add("refreshing");
      const elapsed = Number(meta.refreshElapsedSeconds || 0).toFixed(0);
      const phase = meta.refreshPhase || "Schnellscan läuft";
      text.textContent = `${phase} · ${elapsed} s`;
      button.innerHTML = `<span class="refresh-spinner" aria-hidden="true"></span> Aktualisiere…`;

      // app.js releases the disabled state in its fetch-finally block. Re-apply
      // it one tick later while the backend explicitly says a refresh is active.
      button.disabled = true;
      setTimeout(() => { if (meta.refreshing) button.disabled = true; }, 0);
      return;
    }

    button.disabled = false;
    button.innerHTML = "↻ Aktualisieren";

    if (recentFinished(meta)) {
      const duration = Number(meta.lastRefreshDurationSeconds || 0);
      const added = meta.lastRefreshAdded || {};
      const downloads = Number(added.sabDownloads || 0);
      const media = Number(added.movies || 0) + Number(added.episodes || 0);
      let suffix = "";
      if (downloads > 0) suffix = ` · +${downloads} ${plural(downloads, "Download", "Downloads")}`;
      else if (media > 0) suffix = ` · +${media} ${plural(media, "Medieneintrag", "Medieneinträge")}`;
      text.textContent = `Aktualisiert in ${duration.toFixed(duration < 10 ? 1 : 0)} s${suffix}`;
      return;
    }

    if (generatedAt) {
      text.textContent = `Aktuell · Stand ${fmtTime(generatedAt)} · Auto alle ${Math.round(Number(meta.fastRefreshSeconds || meta.autoRefreshSeconds || 60) / 60)} Min.`;
      return;
    }

    if (source === "browser") {
      text.textContent = `Sofortansicht aus Cache`;
      return;
    }

    box.classList.add("refreshing");
    text.textContent = "Daten werden geladen";
  };

  const style = document.createElement("style");
  style.textContent = `
    .refresh-spinner{
      display:inline-block;
      width:13px;
      height:13px;
      margin-right:6px;
      vertical-align:-2px;
      border:2px solid currentColor;
      border-right-color:transparent;
      border-radius:50%;
      animation:usenetSpin .7s linear infinite;
    }
    #refresh:disabled{cursor:progress;opacity:.82}
    @keyframes usenetSpin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(style);
})();
