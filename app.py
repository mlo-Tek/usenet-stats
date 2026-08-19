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
USENET_CLIENT_NAMES = [x.strip().lower() for x in os.getenv("USENET_CLIENT_NAMES", "SABnzbd,SAB,NZBGet").split(",") if x.strip()]
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
    r = requests.get(f"{base}/api/v3/{endpoint.lstrip('/')}", headers={"X-Api-Key": key}, params=params, timeout=REQUEST_TIMEOUT)
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
    vals = [str(data.get(k, "")).lower() for k in ("downloadClient", "downloadClientName", "downloadClientType", "indexer", "protocol")]
    joined = " ".join(vals)
    if any(x in joined for x in ("torrent", "qbittorrent", "transmission")):
        return False
    return "usenet" in joined or "nzb" in joined or any(name in joined for name in USENET_CLIENT_NAMES)


def history_since(base, key, since):
    page, page_size, out = 1, 1000, []
    while True:
        payload = api_get(base, key, "history", {"page": page, "pageSize": page_size, "sortKey": "date", "sortDirection": "descending"})
        records = payload.get("records", payload if isinstance(payload, list) else [])
        if not records:
            break
        stop = False
        for rec in records:
            dt = parse_dt(rec.get("date"))
            if dt and dt < since:
                stop = True
                break
            out.append(rec)
        if stop or len(records) < page_size:
            break
        page += 1
    return out


def release_group_from_name(name):
    m = re.search(r"-([A-Za-z0-9][A-Za-z0-9._]{1,40})$", name or "")
    return m.group(1) if m else ""


def human_size(num):
    n = float(num or 0)
    if n <= 0:
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


def get_download_id(rec):
    data = rec.get("data") or {}
    return rec.get("downloadId") or data.get("downloadId") or data.get("downloadClientId") or ""


def get_indexer(rec):
    data = rec.get("data") or {}
    val = data.get("indexer") or data.get("indexerName") or ""
    return val if isinstance(val, str) else str(val or "")


def source_title(rec):
    data = rec.get("data") or {}
    return rec.get("sourceTitle") or data.get("sourceTitle") or data.get("droppedPath") or ""


def download_client(rec):
    data = rec.get("data") or {}
    return data.get("downloadClient") or data.get("downloadClientName") or ""


def build_grab_indexes(history, id_key):
    by_download_id, by_title = {}, {}
    for rec in history:
        if str(rec.get("eventType", "")).lower() != "grabbed" or not is_usenet(rec):
            continue
        did = get_download_id(rec)
        if did:
            by_download_id[str(did)] = rec
        source, entity_id = source_title(rec), rec.get(id_key)
        if source and entity_id is not None:
            by_title.setdefault((entity_id, source.strip().lower()), rec)
    return by_download_id, by_title


def match_grab(rec, by_download_id, by_title, id_key):
    did = get_download_id(rec)
    if did and str(did) in by_download_id:
        return by_download_id[str(did)]
    source, entity_id = source_title(rec), rec.get(id_key)
    return by_title.get((entity_id, source.strip().lower())) if source and entity_id is not None else None


def poster_of(entity):
    for img in entity.get("images") or []:
        if img.get("coverType") == "poster":
            return img.get("remoteUrl") or img.get("url") or ""
    return ""


def library_from_path(path):
    p = host_path(path).lower()
    for token, label in (("/movies-kids/", "Movies Kids"), ("/movies-adult/", "Movies Adult"), ("/stand-up-comedy/", "Stand-up"), ("/movies/", "Movies"), ("/tv-kids/", "TV Kids"), ("/tv/", "TV")):
        if token in p:
            return label
    return "Other"


def episode_release_type(source):
    s = source or ""
    if re.search(r"(?i)(?:^|[. _-])S\d{1,2}E\d{1,3}(?:E\d{1,3})*", s):
        return "episode"
    if re.search(r"(?i)(?:^|[. _-])S(?:eason[. _-]?)?\d{1,2}(?!E\d)", s) or re.search(r"(?i)complete[. _-]?(?:season|s\d)", s):
        return "season_pack"
    return "episode"


def failed_items(history, entities, id_key, kind):
    results = []
    for rec in history:
        et = str(rec.get("eventType", "")).lower()
        if et not in ("downloadfailed", "downloadfolderimportfailed") or not is_usenet(rec):
            continue
        entity = entities.get(rec.get(id_key), {})
        data = rec.get("data") or {}
        dt = parse_dt(rec.get("date"))
        source = source_title(rec)
        slug = entity.get("titleSlug") or ""
        arr_url = f"{RADARR_URL}/movie/{slug}" if kind == "movie" and slug else (f"{SONARR_URL}/series/{slug}" if slug else "")
        results.append({
            "kind": "failed", "mediaKind": kind, "title": entity.get("title") or "Unbekannt", "year": entity.get("year") or "",
            "date": rec.get("date") or "", "timestamp": dt.timestamp() if dt else 0, "originalRelease": source,
            "indexer": get_indexer(rec), "downloadClient": download_client(rec), "quality": quality_label(rec),
            "releaseGroup": release_group_from_name(source), "reason": data.get("message") or data.get("reason") or data.get("errorMessage") or "Download/Import fehlgeschlagen",
            "poster": poster_of(entity), "arrUrl": arr_url,
        })
    return results


def radarr_data(since):
    movies = {m["id"]: m for m in api_get(RADARR_URL, RADARR_API_KEY, "movie")}
    history = history_since(RADARR_URL, RADARR_API_KEY, since)
    grabbed_by_id, grabbed_by_title = build_grab_indexes(history, "movieId")
    items, seen = [], set()
    for rec in history:
        if str(rec.get("eventType", "")).lower() != "downloadfolderimported" or not is_usenet(rec):
            continue
        data, movie = rec.get("data") or {}, movies.get(rec.get("movieId"), {})
        grab = match_grab(rec, grabbed_by_id, grabbed_by_title, "movieId")
        imported, source = data.get("importedPath") or data.get("destinationPath") or "", source_title(rec)
        identity = (rec.get("id"), imported, source)
        if identity in seen:
            continue
        seen.add(identity)
        mf = movie.get("movieFile") or {}
        size = data.get("size") or data.get("fileSize") or mf.get("size") or 0
        folder = movie.get("path") or (os.path.dirname(imported) if imported else "")
        import_dt, grab_dt = parse_dt(rec.get("date")), parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt
        slug = movie.get("titleSlug") or ""
        items.append({
            "kind": "movie", "date": display_dt.isoformat() if display_dt else rec.get("date"), "grabDate": (grab or {}).get("date") or "", "importDate": rec.get("date") or "",
            "timestamp": display_dt.timestamp() if display_dt else 0, "importTimestamp": import_dt.timestamp() if import_dt else 0,
            "title": movie.get("title") or "Unbekannter Film", "year": movie.get("year") or "", "originalRelease": source,
            "targetFolder": host_path(folder), "targetFile": host_path(imported), "quality": quality_label(rec) or mf.get("quality", {}).get("quality", {}).get("name", ""),
            "releaseGroup": data.get("releaseGroup") or release_group_from_name(source), "indexer": get_indexer(grab or {}) or get_indexer(rec),
            "downloadClient": download_client(grab or {}) or download_client(rec), "size": int(size or 0), "sizeText": human_size(size),
            "poster": poster_of(movie), "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true", "library": library_from_path(folder),
            "arrUrl": f"{RADARR_URL}/movie/{slug}" if slug else RADARR_URL,
        })
    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items, failed_items(history, movies, "movieId", "movie")


def sonarr_data(since):
    series_list = api_get(SONARR_URL, SONARR_API_KEY, "series")
    series = {s["id"]: s for s in series_list}
    history = history_since(SONARR_URL, SONARR_API_KEY, since)
    grabbed_by_id, grabbed_by_title = build_grab_indexes(history, "seriesId")
    imports = [r for r in history if str(r.get("eventType", "")).lower() == "downloadfolderimported" and is_usenet(r)]
    episode_by_id = {}
    for series_id in sorted({r.get("seriesId") for r in imports if r.get("seriesId")}):
        try:
            for ep in api_get(SONARR_URL, SONARR_API_KEY, "episode", {"seriesId": series_id}):
                if ep.get("id") is not None:
                    episode_by_id[ep["id"]] = ep
        except Exception:
            pass
    items, seen = [], set()
    for rec in imports:
        data, ser = rec.get("data") or {}, series.get(rec.get("seriesId"), {})
        ep = episode_by_id.get(rec.get("episodeId"), {})
        grab = match_grab(rec, grabbed_by_id, grabbed_by_title, "seriesId")
        imported, source = data.get("importedPath") or data.get("destinationPath") or "", source_title(rec)
        identity = (rec.get("id"), rec.get("episodeId"), imported, source)
        if identity in seen:
            continue
        seen.add(identity)
        folder = ser.get("path") or (os.path.dirname(imported) if imported else "")
        season, number = ep.get("seasonNumber"), ep.get("episodeNumber")
        episode_code = f"S{int(season):02d}E{int(number):02d}" if season is not None and number is not None else ""
        import_dt, grab_dt = parse_dt(rec.get("date")), parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt
        size = int(data.get("size") or data.get("fileSize") or 0)
        slug = ser.get("titleSlug") or ""
        items.append({
            "kind": "episode", "date": display_dt.isoformat() if display_dt else rec.get("date"), "grabDate": (grab or {}).get("date") or "", "importDate": rec.get("date") or "",
            "timestamp": display_dt.timestamp() if display_dt else 0, "importTimestamp": import_dt.timestamp() if import_dt else 0,
            "title": ser.get("title") or "Unbekannte Serie", "year": ser.get("year") or "", "seriesId": rec.get("seriesId"),
            "seasonNumber": season, "episodeNumber": number, "episodeCode": episode_code, "episodeTitle": ep.get("title") or "", "originalRelease": source,
            "targetFolder": host_path(folder), "targetFile": host_path(imported), "quality": quality_label(rec), "releaseGroup": data.get("releaseGroup") or release_group_from_name(source),
            "indexer": get_indexer(grab or {}) or get_indexer(rec), "downloadClient": download_client(grab or {}) or download_client(rec),
            "size": size, "sizeText": human_size(size), "poster": poster_of(ser), "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true",
            "library": library_from_path(folder), "releaseType": episode_release_type(source), "arrUrl": f"{SONARR_URL}/series/{slug}" if slug else SONARR_URL,
        })
    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items, failed_items(history, series, "seriesId", "series")


def build_payload(force=False):
    now = time.time()
    if not force and _cache["payload"] is not None and _cache["expires"] > now:
        return _cache["payload"]
    since = datetime.now(timezone.utc) - timedelta(days=MAX_DAYS)
    movies, movie_failed = radarr_data(since) if RADARR_API_KEY else ([], [])
    episodes, series_failed = sonarr_data(since) if SONARR_API_KEY else ([], [])
    payload = {"generatedAt": datetime.now(timezone.utc).isoformat(), "maxDays": MAX_DAYS, "arr": {"radarr": RADARR_URL, "sonarr": SONARR_URL}, "movies": movies, "episodes": episodes, "failed": sorted(movie_failed + series_failed, key=lambda x: x["timestamp"], reverse=True)}
    _cache["payload"], _cache["expires"] = payload, now + CACHE_SECONDS
    return payload


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stats")
def stats():
    try:
        return jsonify(build_payload(request.args.get("refresh") == "1"))
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "cached": _cache["payload"] is not None})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8780")))
