import os
import threading
import time
from datetime import datetime, timedelta, timezone

import direct_indexer_links

server = direct_indexer_links.server
core = server.core
app = server.app

FAST_REFRESH_SECONDS = max(30, int(os.getenv("FAST_REFRESH_SECONDS", "60")))
INCREMENTAL_LOOKBACK_HOURS = max(2, int(os.getenv("INCREMENTAL_LOOKBACK_HOURS", "12")))
FULL_REFRESH_SECONDS = max(3600, int(os.getenv("FULL_REFRESH_SECONDS", "86400")))
FAST_SCHEMA_VERSION = 7

# The existing maintenance thread in server.py reads this global dynamically.
# Lowering it here turns it into the fast incremental scheduler without adding
# another competing background loop.
server.AUTO_REFRESH_SECONDS = FAST_REFRESH_SECONDS

with server._state_lock:
    server._state.setdefault("refreshPhase", "")
    server._state.setdefault("lastRefreshDurationSeconds", None)
    server._state.setdefault("lastRefreshMode", "")
    server._state.setdefault("lastRefreshAdded", {})
    server._state.setdefault("lastFullRefresh", None)


def _number(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _row_ts(row):
    ts = _number(row.get("timestamp"), 0)
    if ts:
        return ts
    dt = core.parse_dt(row.get("date"))
    return dt.timestamp() if dt else 0


def _cutoff_epoch():
    return time.time() - core.MAX_DAYS * 86400


def _movie_key(x):
    return (
        str(x.get("downloadId") or "").strip()
        or f"movie:{x.get('movieId')}:{x.get('targetFile') or ''}:{x.get('originalRelease') or ''}"
    )


def _episode_key(x):
    # One SAB season pack can create several episode imports with the same
    # downloadId, so the target file / episode code must participate in the key.
    did = str(x.get("downloadId") or "").strip()
    return f"{did}|{x.get('targetFile') or x.get('episodeCode') or ''}" if did else (
        f"episode:{x.get('seriesId')}:{x.get('episodeCode') or ''}:{x.get('targetFile') or ''}:{x.get('originalRelease') or ''}"
    )


def _grab_key(x):
    return str(x.get("grabKey") or x.get("downloadId") or "").strip() or (
        f"grab:{x.get('mediaKind')}:{x.get('entityId')}:{x.get('originalRelease') or ''}:{x.get('date') or ''}"
    )


def _failed_key(x):
    return f"failed:{x.get('mediaKind')}:{x.get('title')}:{x.get('originalRelease')}:{x.get('date')}"


def _sab_key(x):
    return str(x.get("nzoId") or x.get("downloadId") or "").strip() or (
        f"sab:{x.get('originalRelease') or ''}:{x.get('timestamp') or 0}"
    )


def _merge(old, fresh, key_fn):
    cutoff = _cutoff_epoch()
    merged = {}
    for item in [*(old or []), *(fresh or [])]:
        if _row_ts(item) and _row_ts(item) < cutoff:
            continue
        merged[key_fn(item)] = item
    return sorted(merged.values(), key=_row_ts, reverse=True)


def _keyset(rows, key_fn):
    return {key_fn(x) for x in (rows or [])}


def _recent_sab_history(cutoff):
    sab_url, sab_key = server.resolved_sab_config()
    if not sab_url or not sab_key:
        return []

    start = 0
    rows = []
    while True:
        payload = server.sab_api_history_page(start)
        history = payload.get("history") or {}
        slots = history.get("slots") or []
        if not slots:
            break

        reached_cutoff = False
        for slot in slots:
            completed = server.slot_completed_epoch(slot)
            if completed and completed < cutoff:
                reached_cutoff = True
                break
            if str(slot.get("status", "")).strip().lower() != "completed":
                continue
            rows.append(slot)

        if reached_cutoff or len(slots) < server.SAB_HISTORY_PAGE_SIZE:
            break
        start += len(slots)

    return rows


def _recent_sab_downloads(payload, cutoff):
    # Reuse the complete SAB enrichment stack (rePollo detection, indexer URL,
    # Arr matching), but feed it only the recent portion of SAB history.
    original_fetch = server.fetch_sab_history
    server.fetch_sab_history = lambda: _recent_sab_history(cutoff)
    try:
        return server.build_sab_downloads(payload)
    finally:
        server.fetch_sab_history = original_fetch


def _initial_full_timestamp(previous):
    existing = _number(previous.get("_lastFullRefreshEpoch"), 0)
    if existing:
        return existing
    generated = server.payload_timestamp(previous)
    return generated or time.time()


def fast_refresh():
    previous = core._cache.get("payload") or {}
    now = time.time()
    since = datetime.now(timezone.utc) - timedelta(hours=INCREMENTAL_LOOKBACK_HOURS)
    since_epoch = since.timestamp()

    old_movies = previous.get("movies") or []
    old_episodes = previous.get("episodes") or []
    old_grabs = previous.get("grabs") or []
    old_failed = previous.get("failed") or []
    old_sab = previous.get("sabDownloads") or []

    movie_items = movie_failed = movie_grabs = []
    series_items = series_failed = series_grabs = []

    if core.RADARR_API_KEY:
        movie_items, movie_failed, movie_grabs = core.radarr_data(since)
    if core.SONARR_API_KEY:
        series_items, series_failed, series_grabs = core.sonarr_data(since)

    movies = _merge(old_movies, movie_items, _movie_key)
    episodes = _merge(old_episodes, series_items, _episode_key)
    grabs = _merge(old_grabs, [*movie_grabs, *series_grabs], _grab_key)
    failed = _merge(old_failed, [*movie_failed, *series_failed], _failed_key)

    payload = dict(previous)
    payload.update({
        "movies": movies,
        "episodes": episodes,
        "grabs": grabs,
        "failed": failed,
        "arr": {"radarr": core.RADARR_URL, "sonarr": core.SONARR_URL},
        "maxDays": core.MAX_DAYS,
    })

    sab_error = ""
    sab_url, sab_key = server.resolved_sab_config()
    if sab_url and sab_key:
        try:
            recent_sab = _recent_sab_downloads(payload, since_epoch)
            payload["sabDownloads"] = _merge(old_sab, recent_sab, _sab_key)
        except Exception as exc:
            sab_error = f"{type(exc).__name__}: {exc}"
            payload["sabDownloads"] = old_sab
    else:
        payload["sabDownloads"] = old_sab
        sab_error = "SABnzbd konnte nicht ermittelt werden."

    payload["sabConfigured"] = bool(sab_url and sab_key)
    payload["sabUrl"] = sab_url
    payload["sabConfigSource"] = server._sab_runtime.get("source") or ""
    payload["generatedAt"] = datetime.now(timezone.utc).isoformat()
    payload["_lastFastRefreshEpoch"] = now
    payload["_lastFullRefreshEpoch"] = _initial_full_timestamp(previous)
    payload["_schemaVersion"] = max(FAST_SCHEMA_VERSION, int(previous.get("_schemaVersion", 0) or 0))

    before = {
        "movies": _keyset(old_movies, _movie_key),
        "episodes": _keyset(old_episodes, _episode_key),
        "sabDownloads": _keyset(old_sab, _sab_key),
    }
    after = {
        "movies": _keyset(payload.get("movies"), _movie_key),
        "episodes": _keyset(payload.get("episodes"), _episode_key),
        "sabDownloads": _keyset(payload.get("sabDownloads"), _sab_key),
    }
    added = {name: len(after[name] - before[name]) for name in after}

    core._cache["payload"] = payload
    core._cache["expires"] = time.time() + core.CACHE_SECONDS
    try:
        server.save_disk_cache(payload)
    except Exception:
        pass

    with server._state_lock:
        server._state["sabError"] = sab_error

    return payload, added


def _full_due(payload):
    last_full = _number((payload or {}).get("_lastFullRefreshEpoch"), 0)
    if not last_full:
        return False
    return time.time() - last_full >= FULL_REFRESH_SECONDS


def incremental_refresh_worker(force_full=False):
    started = time.time()
    mode = "fast"
    added = {}
    try:
        previous = core._cache.get("payload")

        if previous is None:
            mode = "full"
            with server._state_lock:
                server._state["refreshPhase"] = f"Erster Vollabgleich · {core.MAX_DAYS} Tage"
            payload = core.build_payload(force=True)
            payload["_lastFullRefreshEpoch"] = time.time()
            payload["_lastFastRefreshEpoch"] = time.time()
            core._cache["payload"] = payload
            try:
                server.save_disk_cache(payload)
            except Exception:
                pass
        else:
            with server._state_lock:
                server._state["refreshPhase"] = f"Schnellscan · letzte {INCREMENTAL_LOOKBACK_HOURS} h"

            payload, added = fast_refresh()

            # Publish and persist the fast result before an occasional full
            # reconciliation. The UI therefore sees new downloads immediately.
            if force_full or _full_due(payload):
                mode = "fast+full"
                with server._state_lock:
                    server._state["refreshPhase"] = f"Neue Daten sichtbar · Vollabgleich {core.MAX_DAYS} Tage"
                full_payload = core.build_payload(force=True)
                full_payload["_lastFullRefreshEpoch"] = time.time()
                full_payload["_lastFastRefreshEpoch"] = time.time()
                core._cache["payload"] = full_payload
                try:
                    server.save_disk_cache(full_payload)
                except Exception:
                    pass

        with server._state_lock:
            server._state["lastError"] = ""
            server._state["lastRefreshFinished"] = time.time()
            server._state["lastRefreshMode"] = mode
            server._state["lastRefreshAdded"] = added
            server._state["lastRefreshDurationSeconds"] = round(time.time() - started, 2)
            if mode in ("full", "fast+full"):
                server._state["lastFullRefresh"] = time.time()
    except Exception as exc:
        with server._state_lock:
            server._state["lastError"] = f"{type(exc).__name__}: {exc}"
            server._state["lastRefreshFinished"] = time.time()
            server._state["lastRefreshDurationSeconds"] = round(time.time() - started, 2)
    finally:
        with server._state_lock:
            server._state["refreshing"] = False
            server._state["refreshPhase"] = ""


def trigger_refresh(force_full=False):
    with server._state_lock:
        if server._state["refreshing"]:
            return False
        server._state["refreshing"] = True
        server._state["lastRefreshStarted"] = time.time()
        server._state["refreshPhase"] = "Schnellscan wird gestartet"

    threading.Thread(
        target=incremental_refresh_worker,
        kwargs={"force_full": force_full},
        name="stats-incremental-refresh",
        daemon=True,
    ).start()
    return True


def meta(cold_start=False):
    with server._state_lock:
        snapshot = dict(server._state)

    payload = core._cache.get("payload")
    age = server.payload_age(payload)
    elapsed = 0
    if snapshot.get("refreshing") and snapshot.get("lastRefreshStarted"):
        elapsed = max(0, time.time() - snapshot["lastRefreshStarted"])

    return {
        "refreshing": bool(snapshot.get("refreshing")),
        "refreshPhase": snapshot.get("refreshPhase") or "",
        "refreshElapsedSeconds": round(elapsed, 1),
        "loadedFromDisk": bool(snapshot.get("loadedFromDisk")),
        "lastError": snapshot.get("lastError") or "",
        "sabError": snapshot.get("sabError") or "",
        "sabConfigured": bool(server._sab_runtime.get("url") and server._sab_runtime.get("apiKey")),
        "sabConfigSource": server._sab_runtime.get("source") or "",
        "cacheAgeSeconds": age,
        "autoRefreshSeconds": FAST_REFRESH_SECONDS,
        "fastRefreshSeconds": FAST_REFRESH_SECONDS,
        "fullRefreshSeconds": FULL_REFRESH_SECONDS,
        "incrementalLookbackHours": INCREMENTAL_LOOKBACK_HOURS,
        "lastRefreshDurationSeconds": snapshot.get("lastRefreshDurationSeconds"),
        "lastRefreshMode": snapshot.get("lastRefreshMode") or "",
        "lastRefreshAdded": snapshot.get("lastRefreshAdded") or {},
        "lastRefreshFinished": snapshot.get("lastRefreshFinished"),
        "nextRefreshSeconds": max(0, FAST_REFRESH_SECONDS - (age or 0)) if payload else 0,
        "coldStart": cold_start,
    }


def stats_view():
    force = server.request.args.get("refresh") == "1"
    force_full = server.request.args.get("full") == "1"
    payload = core._cache.get("payload")

    if payload is None:
        trigger_refresh(force_full=True)
        return server.jsonify(server.response_payload(None, cold_start=True))

    age = server.payload_age(payload)
    if force:
        trigger_refresh(force_full=force_full)
    elif age is None or age >= FAST_REFRESH_SECONDS:
        trigger_refresh(force_full=False)

    return server.jsonify(server.response_payload(payload))


server.trigger_refresh = trigger_refresh
server.refresh_worker = incremental_refresh_worker
server.meta = meta
server.AUTO_REFRESH_SECONDS = FAST_REFRESH_SECONDS
app.view_functions["stats"] = stats_view
