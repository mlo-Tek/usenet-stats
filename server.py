import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import jsonify, request

import app as core

app = core.app

CACHE_FILE = Path(os.getenv("PERSISTENT_CACHE_FILE", "/config/stats-cache.json"))
METADATA_CACHE_FILE = Path(os.getenv("METADATA_CACHE_FILE", "/config/api-metadata-cache.json"))
AUTO_REFRESH_SECONDS = max(60, int(os.getenv("AUTO_REFRESH_SECONDS", "900")))
METADATA_CACHE_SECONDS = max(900, int(os.getenv("METADATA_CACHE_SECONDS", "21600")))
STARTUP_REFRESH_DELAY = max(0, int(os.getenv("STARTUP_REFRESH_DELAY", "2")))

SABNZBD_URL = os.getenv("SABNZBD_URL", "").rstrip("/")
SABNZBD_API_KEY = os.getenv("SABNZBD_API_KEY", "")
SAB_HISTORY_PAGE_SIZE = max(50, int(os.getenv("SAB_HISTORY_PAGE_SIZE", "250")))
REPPOLLO_CATEGORIES = {
    x.strip().lower()
    for x in os.getenv("REPPOLLO_CATEGORIES", "reppollo").split(",")
    if x.strip()
}

SAB_PATH_MAPPINGS = []
for mapping in os.getenv(
    "SAB_PATH_MAPPINGS", "/data/usenet=/mnt/user/data/usenet"
).split(";"):
    if "=" in mapping:
        src, dst = mapping.split("=", 1)
        SAB_PATH_MAPPINGS.append((src.rstrip("/"), dst.rstrip("/")))

_state_lock = threading.Lock()
_state = {
    "refreshing": False,
    "loadedFromDisk": False,
    "lastError": "",
    "lastRefreshStarted": None,
    "lastRefreshFinished": None,
    "sabError": "",
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


def sab_host_path(path):
    if not path:
        return ""
    for src, dst in SAB_PATH_MAPPINGS:
        if path == src or path.startswith(src + "/"):
            return dst + path[len(src):]
    return path


def slot_completed_epoch(slot):
    value = slot.get("completed") or slot.get("completed_ts") or slot.get("completed_time")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        try:
            return float(text)
        except ValueError:
            dt = core.parse_dt(text)
            return dt.timestamp() if dt else 0.0
    return 0.0


def slot_bytes(slot):
    for key in ("bytes", "bytes_downloaded", "bytes_total"):
        value = slot.get(key)
        try:
            if value not in (None, ""):
                return int(float(value))
        except (TypeError, ValueError):
            pass
    return 0


def indexer_from_slot(slot):
    for key in ("indexer", "indexer_name"):
        value = slot.get(key)
        if value:
            return str(value)
    url = slot.get("url") or slot.get("nzb_url") or ""
    try:
        host = (urlparse(url).hostname or "").lower()
        if host:
            return host.removeprefix("www.")
    except Exception:
        pass
    return "Unbekannt"


def sab_api_history_page(start):
    if not SABNZBD_URL or not SABNZBD_API_KEY:
        return {}
    r = _session.get(
        f"{SABNZBD_URL}/api",
        params={
            "mode": "history",
            "start": start,
            "limit": SAB_HISTORY_PAGE_SIZE,
            "output": "json",
            "apikey": SABNZBD_API_KEY,
        },
        timeout=core.REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def fetch_sab_history():
    if not SABNZBD_URL or not SABNZBD_API_KEY:
        return []

    cutoff = time.time() - core.MAX_DAYS * 86400
    start = 0
    rows = []

    while True:
        payload = sab_api_history_page(start)
        history = payload.get("history") or {}
        slots = history.get("slots") or []
        if not slots:
            break

        reached_cutoff = False
        for slot in slots:
            completed = slot_completed_epoch(slot)
            if completed and completed < cutoff:
                reached_cutoff = True
                break
            if str(slot.get("status", "")).strip().lower() != "completed":
                continue
            rows.append(slot)

        if reached_cutoff or len(slots) < SAB_HISTORY_PAGE_SIZE:
            break
        start += len(slots)

    return rows


def detect_reppollo(slot):
    category = str(slot.get("category") or "").strip().lower()
    script = str(slot.get("script") or "").strip().lower()
    name = str(slot.get("name") or slot.get("nzb_name") or "").lower()
    if category and category in REPPOLLO_CATEGORIES:
        return True
    return "reppollo" in script or "reppollo" in name


def sab_media_kind(category):
    c = (category or "").lower()
    if any(x in c for x in ("tv", "series", "serie")):
        return "series"
    if any(x in c for x in ("movie", "film")):
        return "movie"
    return "unknown"


def build_sab_downloads(payload):
    slots = fetch_sab_history()

    arr_by_download_id = {}
    for item in [*(payload.get("movies") or []), *(payload.get("episodes") or [])]:
        did = str(item.get("downloadId") or "").strip()
        if did:
            arr_by_download_id.setdefault(did, []).append(item)

    result = []
    for slot in slots:
        nzo_id = str(slot.get("nzo_id") or slot.get("nzoId") or "").strip()
        matched = arr_by_download_id.get(nzo_id, []) if nzo_id else []
        primary = matched[0] if matched else {}
        completed = slot_completed_epoch(slot)
        name = str(slot.get("name") or slot.get("nzb_name") or "Unbekannter Download")
        category = str(slot.get("category") or "")
        storage = sab_host_path(str(slot.get("storage") or slot.get("path") or ""))

        if matched:
            kinds = {x.get("kind") for x in matched}
            source = "Radarr" if "movie" in kinds else "Sonarr"
            media_kind = "movie" if "movie" in kinds else "series"
        elif detect_reppollo(slot):
            source = "RepPollo"
            media_kind = sab_media_kind(category)
        else:
            source = "SABnzbd"
            media_kind = sab_media_kind(category)

        size = slot_bytes(slot)
        date_iso = ""
        if completed:
            date_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(completed))

        result.append({
            "kind": "usenet",
            "date": date_iso,
            "completedDate": date_iso,
            "timestamp": completed,
            "title": primary.get("title") or name,
            "year": primary.get("year") or "",
            "originalRelease": name,
            "targetFolder": primary.get("targetFolder") or storage,
            "targetFile": primary.get("targetFile") or "",
            "quality": primary.get("quality") or "",
            "releaseGroup": primary.get("releaseGroup") or core.release_group_from_name(name),
            "indexer": primary.get("indexer") or indexer_from_slot(slot),
            "downloadClient": "SABnzbd",
            "size": size,
            "sizeText": core.human_size(size),
            "poster": primary.get("poster") or "",
            "isUpgrade": bool(primary.get("isUpgrade")),
            "library": primary.get("library") or category or "Other",
            "source": source,
            "category": category,
            "mediaKind": media_kind,
            "releaseType": primary.get("releaseType") or "",
            "arrUrl": primary.get("arrUrl") or "",
            "downloadId": nzo_id,
            "nzoId": nzo_id,
            "status": "Completed",
            "downloadTime": slot.get("download_time") or 0,
            "postprocTime": slot.get("postproc_time") or 0,
            "script": slot.get("script") or "",
        })

    result.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    return result


_original_build_payload = core.build_payload


def build_payload_with_sab(force=False):
    previous = core._cache.get("payload") or {}
    payload = _original_build_payload(force=force)
    sab_error = ""

    if SABNZBD_URL and SABNZBD_API_KEY:
        try:
            payload["sabDownloads"] = build_sab_downloads(payload)
        except Exception as exc:
            sab_error = f"{type(exc).__name__}: {exc}"
            payload["sabDownloads"] = previous.get("sabDownloads", [])
    else:
        payload["sabDownloads"] = previous.get("sabDownloads", [])

    payload["sabConfigured"] = bool(SABNZBD_URL and SABNZBD_API_KEY)
    payload["sabUrl"] = SABNZBD_URL
    payload["_schemaVersion"] = 3
    core._cache["payload"] = payload
    core._cache["expires"] = time.time() + core.CACHE_SECONDS

    with _state_lock:
        _state["sabError"] = sab_error

    return payload


core.build_payload = build_payload_with_sab


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
        "sabError": snapshot["sabError"],
        "sabConfigured": bool(SABNZBD_URL and SABNZBD_API_KEY),
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
            "sabDownloads": [],
            "sabConfigured": bool(SABNZBD_URL and SABNZBD_API_KEY),
        }
    out = dict(payload)
    out["_meta"] = meta(cold_start=cold_start)
    return out


def stats_view():
    force = request.args.get("refresh") == "1"
    payload = core._cache.get("payload")

    if payload is None:
        trigger_refresh()
        return jsonify(response_payload(None, cold_start=True))

    age = payload_age(payload)
    needs_sab_schema = bool(SABNZBD_URL and SABNZBD_API_KEY) and "sabDownloads" not in payload
    if force or needs_sab_schema or age is None or age >= AUTO_REFRESH_SECONDS:
        trigger_refresh()

    return jsonify(response_payload(payload))


def health_view():
    payload = core._cache.get("payload")
    return jsonify({
        "ok": True,
        "cached": payload is not None,
        "generatedAt": payload.get("generatedAt") if payload else None,
        **meta(cold_start=payload is None),
    })


app.view_functions["stats"] = stats_view
app.view_functions["health"] = health_view


def maintenance_loop():
    time.sleep(STARTUP_REFRESH_DELAY)
    while True:
        payload = core._cache.get("payload")
        age = payload_age(payload)
        needs_sab_schema = bool(SABNZBD_URL and SABNZBD_API_KEY) and (
            payload is None or "sabDownloads" not in payload
        )
        if payload is None or needs_sab_schema or age is None or age >= AUTO_REFRESH_SECONDS:
            trigger_refresh()
        time.sleep(min(60, max(15, AUTO_REFRESH_SECONDS // 4)))


load_metadata_cache()
load_disk_cache()
threading.Thread(target=maintenance_loop, name="stats-maintenance", daemon=True).start()
