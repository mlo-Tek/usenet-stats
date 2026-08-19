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
AUTO_REFRESH_SECONDS = max(60, int(os.getenv("AUTO_REFRESH_SECONDS", "900")))
STARTUP_REFRESH_DELAY = max(0, int(os.getenv("STARTUP_REFRESH_DELAY", "2")))

_state_lock = threading.Lock()
_state = {
    "refreshing": False,
    "loadedFromDisk": False,
    "lastError": "",
    "lastRefreshStarted": None,
    "lastRefreshFinished": None,
}

# Reuse HTTP connections to the local *arr instances. This makes repeated
# history/metadata requests noticeably cheaper than opening a new TCP
# connection for every request.
_session = requests.Session()


def pooled_api_get(base, key, endpoint, params=None):
    r = _session.get(
        f"{base}/api/v3/{endpoint.lstrip('/')}",
        headers={"X-Api-Key": key},
        params=params,
        timeout=core.REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


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
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_FILE.with_suffix(CACHE_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, CACHE_FILE)


def refresh_worker():
    try:
        payload = core.build_payload(force=True)
        save_disk_cache(payload)
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

    # Never make the browser wait for a complete 90-day rebuild. Serve the
    # last known data immediately and refresh in the background.
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


# Replace the original synchronous endpoints while keeping the same URLs.
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


load_disk_cache()
threading.Thread(target=maintenance_loop, name="stats-maintenance", daemon=True).start()
