import json
import os
import threading
import time
from pathlib import Path

import requests
from flask import jsonify, request

import app as core

app = core.app

CACHE_FILE = Path(os.getenv("PERSISTENT_CACHE_FILE", "/config/stats-cache.json"))
METADATA_CACHE_FILE = Path(os.getenv("METADATA_CACHE_FILE", "/config/api-metadata-cache.json"))
AUTO_REFRESH_SECONDS = max(60, int(os.getenv("AUTO_REFRESH_SECONDS", "900")))
METADATA_CACHE_SECONDS = max(900, int(os.getenv("METADATA_CACHE_SECONDS", "21600")))
STARTUP_REFRESH_DELAY = max(0, int(os.getenv("STARTUP_REFRESH_DELAY", "2")))

_state_lock = threading.Lock()
_state = {
    "refreshing": False,
    "loadedFromDisk": False,
    "lastError": "",
    "lastRefreshStarted": None,
    "lastRefreshFinished": None,
}

_metadata_lock = threading.Lock()
_metadata_cache = {}
_session = requests.Session()


def atomic_json_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def load_metadata_cache():
    global _metadata_cache
    try:
        if METADATA_CACHE_FILE.exists():
            with METADATA_CACHE_FILE.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                _metadata_cache = data
    except Exception:
        _metadata_cache = {}


def metadata_key(base, endpoint, params):
    endpoint = endpoint.strip("/").lower()
    # Sonarr's episode-by-series calls are by far the most numerous requests
    # during a 90-day rebuild, and their metadata is stable enough to reuse.
    if endpoint == "episode" and params and params.get("seriesId") is not None:
        return f"{base}|episode|seriesId={params.get('seriesId')}"
    return None


def pooled_api_get(base, key, endpoint, params=None):
    cache_key = metadata_key(base, endpoint, params)
    if cache_key:
        now = time.time()
        with _metadata_lock:
            entry = _metadata_cache.get(cache_key)
            if entry and now - float(entry.get("timestamp", 0)) < METADATA_CACHE_SECONDS:
                return entry.get("data", [])

    r = _session.get(
        f"{base}/api/v3/{endpoint.lstrip('/')}",
        headers={"X-Api-Key": key},
        params=params,
        timeout=core.REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()

    if cache_key:
        with _metadata_lock:
            _metadata_cache[cache_key] = {"timestamp": time.time(), "data": data}
            snapshot = dict(_metadata_cache)
        try:
            atomic_json_write(METADATA_CACHE_FILE, snapshot)
        except Exception:
            pass

    return data


core.api_get = pooled_api_get


def payload_timestamp(payload):
    if not payload:
        return 0.0
    dt = core.parse_dt(payload.get("generatedAt"))
    return dt.timestamp() if dt else 0.0


def payload_age(payload=None):
    payload = payload if payload is not None else core._cache.get("payload")
    ts = payload_timestamp(payload)
    return max(0, time.time() - ts) if ts else None


def load_disk_cache():
    try:
        if not CACHE_FILE.exists():
            return False
        with CACHE_FILE.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        if not isinstance(payload, dict) or "movies" not in payload or "episodes" not in payload:
            return False
        core._cache["payload"] = payload
        core._cache["expires"] = time.time() + core.CACHE_SECONDS
        with _state_lock:
            _state["loadedFromDisk"] = True
        return True
    except Exception as exc:
        with _state_lock:
            _state["lastError"] = f"Persistent cache: {type(exc).__name__}: {exc}"
        return False


def save_disk_cache(payload):
    atomic_json_write(CACHE_FILE, payload)


def refresh_worker():
    try:
        payload = core.build_payload(force=True)
        try:
            save_disk_cache(payload)
        except Exception:
            # The in-memory cache is still valid when /config is not mounted.
            pass
        with _state_lock:
            _state["lastError"] = ""
            _state["lastRefreshFinished"] = time.time()
    except Exception as exc:
        with _state_lock:
            _state["lastError"] = f"{type(exc).__name__}: {exc}"
            _state["lastRefreshFinished"] = time.time()
    finally:
        with _state_lock:
            _state["refreshing"] = False


def trigger_refresh():
    with _state_lock:
        if _state["refreshing"]:
            return False
        _state["refreshing"] = True
        _state["lastRefreshStarted"] = time.time()
    threading.Thread(target=refresh_worker, name="stats-refresh", daemon=True).start()
    return True


def meta(cold_start=False):
    with _state_lock:
        snapshot = dict(_state)
    return {
        "refreshing": snapshot["refreshing"],
        "loadedFromDisk": snapshot["loadedFromDisk"],
        "lastError": snapshot["lastError"],
        "cacheAgeSeconds": payload_age(),
        "autoRefreshSeconds": AUTO_REFRESH_SECONDS,
        "coldStart": cold_start,
    }


def response_payload(payload, cold_start=False):
    if payload is None:
        payload = {
            "generatedAt": None,
            "maxDays": core.MAX_DAYS,
            "arr": {"radarr": core.RADARR_URL, "sonarr": core.SONARR_URL},
            "movies": [],
            "episodes": [],
            "grabs": [],
            "failed": [],
        }
    out = dict(payload)
    out["_meta"] = meta(cold_start=cold_start)
    return out


def stats_view():
    force = request.args.get("refresh") == "1"
    payload = core._cache.get("payload")

    # Stale-while-revalidate: the UI gets the last known dataset immediately.
    # Expensive Radarr/Sonarr work happens only in a background thread.
    if payload is None:
        trigger_refresh()
        return jsonify(response_payload(None, cold_start=True))

    age = payload_age(payload)
    if force or age is None or age >= AUTO_REFRESH_SECONDS:
        trigger_refresh()

    return jsonify(response_payload(payload))


def health_view():
    payload = core._cache.get("payload")
    return jsonify(
        {
            "ok": True,
            "cached": payload is not None,
            "generatedAt": payload.get("generatedAt") if payload else None,
            **meta(cold_start=payload is None),
        }
    )


app.view_functions["stats"] = stats_view
app.view_functions["health"] = health_view


def maintenance_loop():
    time.sleep(STARTUP_REFRESH_DELAY)
    while True:
        payload = core._cache.get("payload")
        age = payload_age(payload)
        if payload is None or age is None or age >= AUTO_REFRESH_SECONDS:
            trigger_refresh()
        time.sleep(min(60, max(15, AUTO_REFRESH_SECONDS // 4)))


load_metadata_cache()
load_disk_cache()
threading.Thread(target=maintenance_loop, name="stats-maintenance", daemon=True).start()
