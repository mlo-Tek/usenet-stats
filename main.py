import os
import re
import time
from collections import defaultdict

import requests
from flask import jsonify, request

import refresh_resilience

server = refresh_resilience.server
app = server.app
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
SCHEMA_VERSION = 12

RHD_BASE_URL = os.getenv("RHD_BASE_URL", "https://rocket-hd.cc").rstrip("/")
RHD_API_KEY = os.getenv("RHD_API_KEY", "").strip()
KRYO_MANAGER_URL = os.getenv("KRYO_MANAGER_URL", "http://kryo-manager:8080").rstrip("/")
EXTERNAL_CACHE_SECONDS = max(60, int(os.getenv("EXTERNAL_CACHE_SECONDS", "900")))

_original_sonarr_data = server.core.sonarr_data
_original_build_payload = server.core.build_payload
_original_build_sab_downloads = server.build_sab_downloads
_original_stats_view = app.view_functions["stats"]

_kryo_cache = {"expires": 0.0, "releases": set()}
_rhd_cache = {}


def _normalize_release(value):
    value = str(value or "").strip()
    value = re.sub(r"\.nzb$", "", value, flags=re.I)
    value = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return re.sub(r"\s+", " ", value)


def _ledger_key(item):
    return (
        str(item.get("nzoId") or item.get("downloadId") or "").strip()
        or f"{item.get('originalRelease','')}|{item.get('timestamp',0)}"
    )


def _merge_ledger(previous, fresh):
    cutoff = time.time() - server.core.MAX_DAYS * 86400
    merged = {}

    for item in [*(previous or []), *(fresh or [])]:
        try:
            ts = float(item.get("timestamp") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts and ts < cutoff:
            continue

        if str(item.get("source") or "").lower() in {"reppollo", "repollo"}:
            item = dict(item)
            item["source"] = "rePollo"

        merged[_ledger_key(item)] = item

    return sorted(
        merged.values(),
        key=lambda x: float(x.get("timestamp") or 0),
        reverse=True,
    )


def _season_episode_counts(series_ids):
    """Return Sonarr's canonical regular-episode count per series/season."""
    counts = defaultdict(int)

    for series_id in series_ids:
        try:
            episodes = server.core.api_get(
                server.core.SONARR_URL,
                server.core.SONARR_API_KEY,
                "episode",
                {"seriesId": series_id},
            )
        except Exception:
            continue

        seen = set()
        for episode in episodes or []:
            try:
                season_number = int(episode.get("seasonNumber"))
                episode_number = int(episode.get("episodeNumber"))
            except (TypeError, ValueError):
                continue

            if season_number <= 0 or episode_number <= 0:
                continue

            identity = (series_id, season_number, episode_number)
            if identity in seen:
                continue
            seen.add(identity)
            counts[(series_id, season_number)] += 1

    return counts


def sonarr_data_with_season_counts(since):
    """Keep seasonEpisodeCount on both full and incremental Sonarr refreshes."""
    items, failed, grabs = _original_sonarr_data(since)
    if not items or not server.core.SONARR_API_KEY:
        return items, failed, grabs

    series_ids = {
        item.get("seriesId")
        for item in items
        if item.get("seriesId") is not None
    }
    counts = _season_episode_counts(series_ids)

    for item in items:
        try:
            key = (item.get("seriesId"), int(item.get("seasonNumber")))
        except (TypeError, ValueError):
            continue
        expected = counts.get(key, 0)
        if expected > 0:
            item["seasonEpisodeCount"] = expected

    return items, failed, grabs


server.core.sonarr_data = sonarr_data_with_season_counts


def _kryo_release_names():
    if not KRYO_MANAGER_URL:
        return set()
    now = time.time()
    if _kryo_cache["expires"] > now:
        return _kryo_cache["releases"]

    releases = set()
    try:
        response = requests.get(
            f"{KRYO_MANAGER_URL}/api/dashboard",
            timeout=min(server.core.REQUEST_TIMEOUT, 8),
        )
        response.raise_for_status()
        payload = response.json()
        for job in payload.get("jobs") or []:
            for value in (job.get("release_name"), job.get("uploaded_name")):
                normalized = _normalize_release(value)
                if normalized:
                    releases.add(normalized)
    except Exception:
        # Kryo integration is optional. Do not break the statistics dashboard if
        # the companion container is unavailable or not configured.
        releases = _kryo_cache.get("releases") or set()

    _kryo_cache["releases"] = releases
    _kryo_cache["expires"] = now + EXTERNAL_CACHE_SECONDS
    return releases


def _mark_kryo_sources(payload, sab_rows=None):
    releases = _kryo_release_names()
    if not releases:
        return

    rows = list(sab_rows or [])
    rows.extend(payload.get("movies") or [])
    rows.extend(payload.get("episodes") or [])
    if sab_rows is None:
        rows.extend(payload.get("sabDownloads") or [])

    for item in rows:
        source = str(item.get("source") or "").strip().lower()
        if source not in {"repollo", "reppollo"}:
            continue
        release = _normalize_release(
            item.get("originalRelease") or item.get("sourceTitle") or ""
        )
        if release and release in releases:
            item["source"] = "Kryo Manager"


def build_sab_downloads_with_kryo(payload):
    rows = _original_build_sab_downloads(payload)
    _mark_kryo_sources(payload, rows)
    return rows


server.build_sab_downloads = build_sab_downloads_with_kryo


def _extract_media_id(path, label):
    match = re.search(rf"(?:\{{|\[)?{label}[-_= ](\d+)(?:\}}|\])?", str(path or ""), re.I)
    return int(match.group(1)) if match else 0


def _rhd_query(params):
    if not RHD_API_KEY:
        return None

    key = tuple(sorted((str(k), str(v)) for k, v in params.items()))
    cached = _rhd_cache.get(key)
    now = time.time()
    if cached and cached[0] > now:
        return cached[1]

    query = {"api_token": RHD_API_KEY, "perPage": "100", **params}
    response = requests.get(
        f"{RHD_BASE_URL}/api/torrents/filter",
        params=query,
        headers={"Accept": "application/json", "User-Agent": "UsenetStats/1.0"},
        timeout=min(server.core.REQUEST_TIMEOUT, 12),
    )
    response.raise_for_status()
    payload = response.json()
    names = set()
    for row in payload.get("data") or []:
        data = row.get("attributes", row) if isinstance(row, dict) else {}
        normalized = _normalize_release(data.get("name"))
        if normalized:
            names.add(normalized)

    _rhd_cache[key] = (now + max(EXTERNAL_CACHE_SECONDS, 1800), names)
    return names


def _rhd_group_key(item):
    folder = item.get("targetFolder") or ""
    kind = str(item.get("kind") or "")
    if kind == "movie":
        tmdb_id = _extract_media_id(folder, "tmdb")
        if tmdb_id:
            return ("movie", tmdb_id), {"tmdbId": tmdb_id}
    else:
        tvdb_id = _extract_media_id(folder, "tvdb")
        season = item.get("seasonNumber")
        if tvdb_id:
            params = {"tvdbId": tvdb_id}
            try:
                season_num = int(season)
            except (TypeError, ValueError):
                season_num = 0
            if season_num > 0:
                params["seasonNumber"] = season_num
            return ("series", tvdb_id, season_num), params

    release = str(item.get("release") or item.get("originalRelease") or "").strip()
    return ("name", _normalize_release(release)), {"name": release}


@app.route("/api/rhd-status", methods=["POST"])
def rhd_status():
    body = request.get_json(silent=True) or {}
    items = body.get("items") or []
    if not isinstance(items, list):
        return jsonify({"error": "items must be a list"}), 400
    items = items[:100]

    if not RHD_API_KEY:
        return jsonify({"configured": False, "items": {}})

    grouped = {}
    for raw in items:
        if not isinstance(raw, dict):
            continue
        key_value = str(raw.get("key") or "").strip()
        if not key_value:
            continue
        query_key, params = _rhd_group_key(raw)
        grouped.setdefault(query_key, {"params": params, "items": []})["items"].append(raw)

    result = {}
    errors = []
    for group in grouped.values():
        try:
            names = _rhd_query(group["params"])
        except Exception as exc:
            names = None
            errors.append(f"{type(exc).__name__}: {str(exc)[:160]}")

        for raw in group["items"]:
            key_value = str(raw.get("key") or "")
            releases = raw.get("releases")
            if not isinstance(releases, list):
                releases = [raw.get("release") or raw.get("originalRelease") or ""]
            wanted = [_normalize_release(value) for value in releases if _normalize_release(value)]
            if names is None or not wanted:
                result[key_value] = "unknown"
                continue
            found = sum(1 for release in wanted if release in names)
            if found == len(wanted):
                result[key_value] = "yes"
            elif found > 0:
                result[key_value] = "partial"
            else:
                result[key_value] = "no"

    return jsonify({
        "configured": True,
        "items": result,
        "error": errors[0] if errors else "",
    })


def build_payload_with_ledger(force=False):
    previous_payload = server.core._cache.get("payload") or {}
    previous_sab = previous_payload.get("sabDownloads") or []

    payload = _original_build_payload(force=force)
    payload["sabDownloads"] = _merge_ledger(
        previous_sab,
        payload.get("sabDownloads") or [],
    )
    _mark_kryo_sources(payload)
    payload["integrations"] = {
        "rhdConfigured": bool(RHD_API_KEY),
        "kryoConfigured": bool(KRYO_MANAGER_URL),
    }
    payload["_schemaVersion"] = SCHEMA_VERSION

    server.core._cache["payload"] = payload
    server.core._cache["expires"] = time.time() + server.core.CACHE_SECONDS
    return payload


server.core.build_payload = build_payload_with_ledger


def stats_view_v12():
    payload = server.core._cache.get("payload") or {}
    if int(payload.get("_schemaVersion", 0) or 0) < SCHEMA_VERSION:
        server.trigger_refresh(force_full=True)
    return _original_stats_view()


app.view_functions["stats"] = stats_view_v12
