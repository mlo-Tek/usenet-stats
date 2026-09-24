/* Usenet Stats v4 — standalone rePollo/Kryo reseeds.
 *
 * rePollo downloads do not have to exist in Radarr/Sonarr. SAB history with
 * category/source repollo is therefore a first-class data source. This layer
 * turns unmatched reseed rows into lightweight media records before the v4 UI
 * builds filters, season groups, pagination and statistics.
 */
(() => {
  const SYNTHETIC = "__v4StandaloneReseed";

  const norm = value => String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.nzb$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  function reseedSource(row) {
    const source = String(row?.source || "").trim().toLowerCase();
    const category = String(row?.category || "").trim().toLowerCase();
    if (source.includes("kryo")) return "Kryo Manager";
    if (source.includes("repollo") || source.includes("reppollo")) return "rePollo";
    if (["repollo", "reppollo", "reseed"].includes(category)) return "rePollo";
    return "";
  }

  function releaseParts(name) {
    const raw = String(name || "").replace(/\.nzb$/i, "");
    const episode = raw.match(/(?:^|[._ -])S(\d{1,2})E(\d{1,3})(?:$|[._ -])/i);
    const season = raw.match(/(?:^|[._ -])S(\d{1,2})(?:$|[._ -])/i);
    const year = raw.match(/(?:^|[._ -])((?:19|20)\d{2})(?:$|[._ -])/);
    const quality = raw.match(/(?:^|[._ -])(2160|1080|720|576|480)[pi](?:$|[._ -])/i);

    let cut = raw.length;
    for (const match of [episode, season, year, quality]) {
      if (match && match.index >= 0) cut = Math.min(cut, match.index);
    }
    for (const marker of [/\bGERMAN\b/i,/\bDL\b/i,/\bMULTI\b/i,/\bWEB[-_. ]?DL\b/i,/\bBLU[-_. ]?RAY\b/i]) {
      const match = raw.match(marker);
      if (match && match.index >= 0) cut = Math.min(cut, match.index);
    }

    let title = raw.slice(0, cut)
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[- ]+|[- ]+$/g, "")
      .trim();
    if (!title) title = raw.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

    return {
      raw,
      title: title || "rePollo Reseed",
      year: year ? year[1] : "",
      season: episode ? Number(episode[1]) : (season ? Number(season[1]) : null),
      episode: episode ? Number(episode[2]) : null,
      isEpisode: !!episode,
      isSeasonPack: !episode && !!season,
      resolution: quality ? `${quality[1]}p` : "",
    };
  }

  function inferQuality(row, parts) {
    if (row?.quality) return row.quality;
    const release = String(row?.originalRelease || "");
    const resolution = parts.resolution;
    if (!resolution) return "";
    if (/web[-_. ]?dl|webrip|web[._ -]/i.test(release)) return `WEBDL-${resolution}`;
    if (/blu[-_. ]?ray|bluray|bdrip|remux/i.test(release)) return `Bluray-${resolution}`;
    return resolution;
  }

  function genuineRows() {
    const movies = (DATA?.movies || []).filter(row => !row?.[SYNTHETIC]);
    const episodes = (DATA?.episodes || []).filter(row => !row?.[SYNTHETIC]);
    return [...movies, ...episodes];
  }

  function standaloneRows() {
    if (!window.DATA) return {movies: [], episodes: [], seasonPacks: new Map()};

    const genuine = genuineRows();
    const knownIds = new Set(genuine.map(row => String(row.downloadId || "").trim()).filter(Boolean));
    const knownReleases = new Set(genuine.map(row => norm(row.originalRelease || row.sourceTitle)).filter(Boolean));
    const movies = [];
    const episodes = [];
    const seasonPacks = new Map();

    for (const sab of DATA.sabDownloads || []) {
      const source = reseedSource(sab);
      if (!source) continue;

      const downloadId = String(sab.downloadId || sab.nzoId || "").trim();
      const release = String(sab.originalRelease || sab.title || "").trim();
      const releaseKey = norm(release);
      if ((downloadId && knownIds.has(downloadId)) || (releaseKey && knownReleases.has(releaseKey))) continue;

      const parts = releaseParts(release);
      const explicitKind = String(sab.mediaKind || "").toLowerCase();
      const seriesLike = explicitKind === "series" || parts.isEpisode || parts.isSeasonPack;
      const base = {
        ...sab,
        [SYNTHETIC]: true,
        standaloneReseed: true,
        source,
        originalRelease: release,
        title: parts.title,
        year: sab.year || parts.year,
        quality: inferQuality(sab, parts),
        library: sab.library || "rePollo",
        poster: sab.poster || "",
        arrUrl: "",
        date: sab.date || sab.completedDate || "",
        grabDate: sab.date || sab.completedDate || "",
        importDate: sab.completedDate || sab.date || "",
        timestamp: Number(sab.timestamp || 0),
        importTimestamp: Number(sab.timestamp || 0),
        targetFolder: sab.targetFolder || "",
        targetFile: sab.targetFile || "",
        downloadId,
        nzoId: downloadId,
      };

      if (!seriesLike) {
        movies.push({
          ...base,
          kind: "movie",
          movieId: `repollo:${downloadId || releaseKey}`,
          mediaKind: "movie",
        });
        continue;
      }

      const seasonNumber = Number.isInteger(parts.season) ? parts.season : 0;
      const seriesKey = `repollo:${norm(parts.title)}`;
      if (parts.isSeasonPack) {
        const syntheticEpisode = {
          ...base,
          kind: "episode",
          mediaKind: "series",
          seriesId: `${seriesKey}:pack:${downloadId || releaseKey}`,
          seasonNumber,
          episodeNumber: Number.NaN,
          episodeCode: `S${String(seasonNumber).padStart(2, "0")}`,
          episodeTitle: "Season Pack · rePollo Reseed",
          standaloneSeasonPack: true,
          releaseType: "season_pack",
        };
        episodes.push(syntheticEpisode);
        seasonPacks.set(`${syntheticEpisode.seriesId}::${seasonNumber}`, true);
        continue;
      }

      episodes.push({
        ...base,
        kind: "episode",
        mediaKind: "series",
        seriesId: seriesKey,
        seasonNumber,
        episodeNumber: parts.episode,
        episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${String(parts.episode).padStart(2, "0")}`,
        episodeTitle: "rePollo Reseed",
        standaloneReseedEpisode: true,
        releaseType: "episode",
      });
    }

    return {movies, episodes, seasonPacks};
  }

  function sync() {
    if (!window.DATA) return false;
    const realMovies = (DATA.movies || []).filter(row => !row?.[SYNTHETIC]);
    const realEpisodes = (DATA.episodes || []).filter(row => !row?.[SYNTHETIC]);
    DATA.movies = realMovies;
    DATA.episodes = realEpisodes;

    const extra = standaloneRows();
    DATA.movies = [...realMovies, ...extra.movies];
    DATA.episodes = [...realEpisodes, ...extra.episodes];
    window.__v4StandaloneReseedSeasonPacks = extra.seasonPacks;
    return extra.movies.length + extra.episodes.length > 0;
  }

  function decorate() {
    const packs = window.__v4StandaloneReseedSeasonPacks;
    if (!(packs instanceof Map) || !packs.size) return;
    for (const row of document.querySelectorAll("#v4List .v4-row")) {
      const key = String(row.dataset.key || "");
      if (!key.startsWith("season:")) continue;
      const body = key.slice("season:".length);
      const split = body.lastIndexOf(":");
      if (split < 0) continue;
      const seriesId = body.slice(0, split);
      const season = Number(body.slice(split + 1));
      if (!packs.has(`${seriesId}::${season}`)) continue;
      const pill = row.querySelector(".v4-season-pill");
      if (pill) {
        pill.classList.remove("complete");
        pill.textContent = `S${String(season).padStart(2, "0")} Season Pack`;
        pill.title = "Standalone rePollo Season Pack · nicht in Sonarr vorhanden";
      }
    }
  }

  if (typeof renderAll === "function") {
    const baseRenderAll = renderAll;
    renderAll = function(...args) {
      sync();
      const result = baseRenderAll.apply(this, args);
      queueMicrotask(decorate);
      return result;
    };
  }

  const observer = new MutationObserver(() => decorate());
  function start() {
    sync();
    const list = document.getElementById("v4List");
    if (list) observer.observe(list, {childList: true, subtree: true});
    decorate();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  let lastSignature = "";
  setInterval(() => {
    if (!window.DATA) return;
    const signature = `${(DATA.sabDownloads || []).length}:${DATA.generatedAt || ""}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (sync() && typeof renderAll === "function") renderAll();
    decorate();
  }, 1000);
})();