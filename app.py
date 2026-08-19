import os
import re
import time
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

RADARR_URL = os.getenv("RADARR_URL", "http://10.20.20.9:7878").rstrip("/")
RADARR_API_KEY = os.getenv("RADARR_API_KEY", "")
SONARR_URL = os.getenv("SONARR_URL", "http://10.20.20.10:8989").rstrip("/")
SONARR_API_KEY = os.getenv("SONARR_API_KEY", "")

USENET_CLIENT_NAMES = [
    x.strip().lower()
    for x in os.getenv("USENET_CLIENT_NAMES", "SABnzbd,SAB,NZBGet").split(",")
    if x.strip()
]

PATH_MAPPINGS = []
for mapping in os.getenv("PATH_MAPPINGS", "/data/media=/mnt/user/data/media").split(";"):
    if "=" in mapping:
        src, dst = mapping.split("=", 1)
        PATH_MAPPINGS.append((src.rstrip("/"), dst.rstrip("/")))

CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "900"))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "20"))
MAX_DAYS = int(os.getenv("MAX_DAYS", "90"))

_cache = {"expires": 0, "payload": None}


def api_get(base, key, endpoint, params=None):
    r = requests.get(
        f"{base}/api/v3/{endpoint.lstrip('/')}",
        headers={"X-Api-Key": key},
        params=params,
        timeout=REQUEST_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def host_path(path):
    if not path:
        return ""
    for src, dst in PATH_MAPPINGS:
        if path == src or path.startswith(src + "/"):
            return dst + path[len(src):]
    return path


def parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def quality_label(record):
    q = record.get("quality") or {}
    if isinstance(q, dict):
        quality = q.get("quality") or {}
        if isinstance(quality, dict) and quality.get("name"):
            return quality["name"]
        if q.get("name"):
            return q["name"]
    return ""


def is_usenet(record):
    data = record.get("data") or {}

    if data.get("nzbInfoUrl") or data.get("nzbInfoUrlBase"):
        return True
    if data.get("torrentInfoHash") or data.get("torrentInfoHashV2"):
        return False

    values = []
    for key in (
        "downloadClient",
        "downloadClientName",
        "downloadClientType",
        "indexer",
        "protocol",
    ):
        value = data.get(key)
        if value is not None:
            values.append(str(value).lower())

    joined = " ".join(values)

    if "torrent" in joined or "qbittorrent" in joined or "transmission" in joined:
        return False
    if "usenet" in joined or "nzb" in joined:
        return True
    if any(name in joined for name in USENET_CLIENT_NAMES):
        return True

    return False


def history_since(base, key, since):
    page = 1
    page_size = 1000
    out = []

    while True:
        payload = api_get(
            base,
            key,
            "history",
            {
                "page": page,
                "pageSize": page_size,
                "sortKey": "date",
                "sortDirection": "descending",
            },
        )
        records = payload.get("records", payload if isinstance(payload, list) else [])
        if not records:
            break

        reached_cutoff = False
        for rec in records:
            dt = parse_dt(rec.get("date"))
            if dt and dt < since:
                reached_cutoff = True
                break
            out.append(rec)

        if reached_cutoff or len(records) < page_size:
            break
        page += 1

    return out


def release_group_from_name(name):
    if not name:
        return ""
    m = re.search(r"-([A-Za-z0-9][A-Za-z0-9._]{1,40})$", name)
    return m.group(1) if m else ""


def human_size(num):
    try:
        n = float(num or 0)
    except Exception:
        return ""
    if n <= 0:
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


def get_download_id(rec):
    data = rec.get("data") or {}
    return (
        rec.get("downloadId")
        or data.get("downloadId")
        or data.get("downloadClientId")
        or ""
    )


def get_indexer(rec):
    data = rec.get("data") or {}
    return (
        data.get("indexer")
        or data.get("indexerName")
        or data.get("indexerFlags")
        or ""
    )


def build_grab_indexes(history, id_key):
    by_download_id = {}
    by_title = {}

    for rec in history:
        if str(rec.get("eventType", "")).lower() != "grabbed":
            continue
        if not is_usenet(rec):
            continue

        did = get_download_id(rec)
        if did:
            by_download_id[str(did)] = rec

        data = rec.get("data") or {}
        source = rec.get("sourceTitle") or data.get("sourceTitle") or ""
        entity_id = rec.get(id_key)
        if source and entity_id is not None:
            key = (entity_id, source.strip().lower())
            by_title.setdefault(key, rec)

    return by_download_id, by_title


def match_grab(import_rec, by_download_id, by_title, id_key):
    did = get_download_id(import_rec)
    if did and str(did) in by_download_id:
        return by_download_id[str(did)]

    data = import_rec.get("data") or {}
    source = (
        import_rec.get("sourceTitle")
        or data.get("sourceTitle")
        or data.get("droppedPath")
        or ""
    )
    entity_id = import_rec.get(id_key)

    if source and entity_id is not None:
        return by_title.get((entity_id, source.strip().lower()))

    return None


def radarr_data(since):
    movies = {m["id"]: m for m in api_get(RADARR_URL, RADARR_API_KEY, "movie")}
    history = history_since(RADARR_URL, RADARR_API_KEY, since)
    grabbed_by_id, grabbed_by_title = build_grab_indexes(history, "movieId")

    items = []
    seen = set()

    for rec in history:
        if str(rec.get("eventType", "")).lower() != "downloadfolderimported":
            continue
        if not is_usenet(rec):
            continue

        data = rec.get("data") or {}
        movie = movies.get(rec.get("movieId"), {})
        grab = match_grab(rec, grabbed_by_id, grabbed_by_title, "movieId")
        grab_data = (grab or {}).get("data") or {}

        imported = data.get("importedPath") or data.get("destinationPath") or ""
        source = (
            rec.get("sourceTitle")
            or data.get("sourceTitle")
            or data.get("droppedPath")
            or ""
        )

        identity = (rec.get("id"), imported, source)
        if identity in seen:
            continue
        seen.add(identity)

        mf = movie.get("movieFile") or {}
        size = data.get("size") or data.get("fileSize") or mf.get("size") or 0
        folder = movie.get("path") or (os.path.dirname(imported) if imported else "")

        poster = ""
        for img in movie.get("images") or []:
            if img.get("coverType") == "poster":
                poster = img.get("remoteUrl") or img.get("url") or ""
                break

        import_dt = parse_dt(rec.get("date"))
        grab_dt = parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt

        items.append(
            {
                "kind": "movie",
                "date": display_dt.isoformat() if display_dt else rec.get("date"),
                "grabDate": (grab or {}).get("date") or "",
                "importDate": rec.get("date") or "",
                "timestamp": display_dt.timestamp() if display_dt else 0,
                "importTimestamp": import_dt.timestamp() if import_dt else 0,
                "title": movie.get("title") or "Unbekannter Film",
                "year": movie.get("year") or "",
                "originalRelease": source,
                "targetFolder": host_path(folder),
                "targetFile": host_path(imported),
                "quality": quality_label(rec) or mf.get("quality", {}).get("quality", {}).get("name", ""),
                "releaseGroup": data.get("releaseGroup") or release_group_from_name(source),
                "indexer": get_indexer(grab or {}) or get_indexer(rec),
                "downloadClient": (
                    grab_data.get("downloadClient")
                    or grab_data.get("downloadClientName")
                    or data.get("downloadClient")
                    or data.get("downloadClientName")
                    or ""
                ),
                "size": int(size or 0),
                "sizeText": human_size(size),
                "poster": poster,
                "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true",
            }
        )

    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items


def sonarr_data(since):
    series_list = api_get(SONARR_URL, SONARR_API_KEY, "series")
    series = {s["id"]: s for s in series_list}
    history = history_since(SONARR_URL, SONARR_API_KEY, since)
    grabbed_by_id, grabbed_by_title = build_grab_indexes(history, "seriesId")

    import_records = [
        rec for rec in history
        if str(rec.get("eventType", "")).lower() == "downloadfolderimported"
        and is_usenet(rec)
    ]

    affected_series_ids = sorted({
        rec.get("seriesId") for rec in import_records if rec.get("seriesId")
    })

    episode_by_id = {}
    for series_id in affected_series_ids:
        try:
            eps = api_get(SONARR_URL, SONARR_API_KEY, "episode", {"seriesId": series_id})
            if isinstance(eps, list):
                for ep in eps:
                    if ep.get("id") is not None:
                        episode_by_id[ep["id"]] = ep
        except Exception:
            pass

    items = []
    seen = set()

    for rec in import_records:
        data = rec.get("data") or {}
        ser = series.get(rec.get("seriesId"), {})
        episode = episode_by_id.get(rec.get("episodeId"), {})
        grab = match_grab(rec, grabbed_by_id, grabbed_by_title, "seriesId")
        grab_data = (grab or {}).get("data") or {}

        imported = data.get("importedPath") or data.get("destinationPath") or ""
        source = (
            rec.get("sourceTitle")
            or data.get("sourceTitle")
            or data.get("droppedPath")
            or ""
        )

        identity = (rec.get("id"), rec.get("episodeId"), imported, source)
        if identity in seen:
            continue
        seen.add(identity)

        size = data.get("size") or data.get("fileSize") or 0
        folder = ser.get("path") or (os.path.dirname(imported) if imported else "")

        poster = ""
        for img in ser.get("images") or []:
            if img.get("coverType") == "poster":
                poster = img.get("remoteUrl") or img.get("url") or ""
                break

        season = episode.get("seasonNumber")
        number = episode.get("episodeNumber")
        episode_code = ""
        if season is not None and number is not None:
            episode_code = f"S{int(season):02d}E{int(number):02d}"

        import_dt = parse_dt(rec.get("date"))
        grab_dt = parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt

        items.append(
            {
                "kind": "episode",
                "date": display_dt.isoformat() if display_dt else rec.get("date"),
                "grabDate": (grab or {}).get("date") or "",
                "importDate": rec.get("date") or "",
                "timestamp": display_dt.timestamp() if display_dt else 0,
                "importTimestamp": import_dt.timestamp() if import_dt else 0,
                "title": ser.get("title") or "Unbekannte Serie",
                "year": ser.get("year") or "",
                "episodeCode": episode_code,
                "episodeTitle": episode.get("title") or "",
                "originalRelease": source,
                "targetFolder": host_path(folder),
                "targetFile": host_path(imported),
                "quality": quality_label(rec),
                "releaseGroup": data.get("releaseGroup") or release_group_from_name(source),
                "indexer": get_indexer(grab or {}) or get_indexer(rec),
                "downloadClient": (
                    grab_data.get("downloadClient")
                    or grab_data.get("downloadClientName")
                    or data.get("downloadClient")
                    or data.get("downloadClientName")
                    or ""
                ),
                "size": int(size or 0),
                "sizeText": human_size(size),
                "poster": poster,
                "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true",
            }
        )

    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items


def build_payload(force=False):
    now = time.time()
    if not force and _cache["payload"] is not None and _cache["expires"] > now:
        return _cache["payload"]

    since = datetime.now(timezone.utc) - timedelta(days=MAX_DAYS)

    movies = radarr_data(since) if RADARR_API_KEY else []
    episodes = sonarr_data(since) if SONARR_API_KEY else []

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "maxDays": MAX_DAYS,
        "movies": movies,
        "episodes": episodes,
    }

    _cache["payload"] = payload
    _cache["expires"] = now + CACHE_SECONDS
    return payload


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stats")
def stats():
    force = request.args.get("refresh") == "1"
    try:
        return jsonify(build_payload(force))
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "cached": _cache["payload"] is not None})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8780")))
