import os
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

RADARR_URL = os.getenv("RADARR_URL", "").rstrip("/")
RADARR_API_KEY = os.getenv("RADARR_API_KEY", "")
SONARR_URL = os.getenv("SONARR_URL", "").rstrip("/")
SONARR_API_KEY = os.getenv("SONARR_API_KEY", "")
MAX_DAYS = int(os.getenv("MAX_DAYS", "90"))
CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "300"))

_cache = {"payload": None, "expires": 0}


def api_get(base, key, endpoint, params=None):
    r = requests.get(
        f"{base}/api/v3/{endpoint}",
        params=params or {},
        headers={"X-Api-Key": key},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def human_size(size):
    size = int(size or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{size} B"
        size /= 1024


def host_path(path):
    if not path:
        return ""
    mappings = [
        (os.getenv("MEDIA_CONTAINER_PREFIX", "/data/media"), os.getenv("MEDIA_HOST_PREFIX", "/mnt/user/data/media")),
    ]
    for src, dst in mappings:
        if src and path.startswith(src):
            return dst.rstrip("/") + path[len(src):]
    return path


def poster_of(entity):
    images = entity.get("images") or []
    for image in images:
        if image.get("coverType") == "poster":
            return image.get("remoteUrl") or image.get("url") or ""
    return ""


def source_title(rec):
    data = rec.get("data") or {}
    return data.get("sourceTitle") or rec.get("sourceTitle") or data.get("downloadClientName") or ""


def get_download_id(rec):
    data = rec.get("data") or {}
    return data.get("downloadId") or rec.get("downloadId") or ""


def get_indexer(rec):
    data = rec.get("data") or {}
    return data.get("indexer") or data.get("indexerName") or rec.get("indexer") or ""


def download_client(rec):
    data = rec.get("data") or {}
    return data.get("downloadClient") or data.get("downloadClientName") or rec.get("downloadClient") or ""


def quality_label(rec):
    quality = rec.get("quality") or {}
    if isinstance(quality, dict):
        q = quality.get("quality") or quality
        if isinstance(q, dict):
            return q.get("name") or ""
        if isinstance(q, str):
            return q
    data = rec.get("data") or {}
    return data.get("quality") or ""


def release_group_from_name(name):
    if not name:
        return ""
    match = re.search(r"-([A-Za-z0-9._]+)$", name)
    return match.group(1) if match else ""


def episode_release_type(name):
    text = str(name or "")
    if re.search(r"S\d{1,2}(?!E\d)", text, re.I) or re.search(r"Season[ ._-]?\d+", text, re.I):
        return "season_pack"
    return "episode"


def library_from_path(path):
    p = str(path or "").lower()
    for name in ("movies-kids", "movies-adult", "tv-kids", "stand-up-comedy", "movies", "tv"):
        if f"/{name}" in p:
            return name
    return ""


def is_usenet(rec):
    data = rec.get("data") or {}
    proto = str(data.get("protocol") or rec.get("protocol") or "").lower()
    client = str(download_client(rec)).lower()
    return proto == "usenet" or "sab" in client


def history_since(base, key, since):
    rows = []
    page = 1
    while True:
        payload = api_get(base, key, "history", {"page": page, "pageSize": 250, "sortKey": "date", "sortDirection": "descending"})
        records = payload.get("records") or []
        if not records:
            break
        stop = False
        for rec in records:
            dt = parse_dt(rec.get("date"))
            if dt and dt < since:
                stop = True
                break
            rows.append(rec)
        if stop or len(records) < 250:
            break
        page += 1
    return rows


def build_grab_indexes(history, id_key):
    by_id, by_title = {}, defaultdict(list)
    for rec in history:
        if str(rec.get("eventType", "")).lower() != "grabbed" or not is_usenet(rec):
            continue
        did = str(get_download_id(rec) or "")
        if did:
            by_id[did] = rec
        title = source_title(rec).lower()
        if title:
            by_title[(rec.get(id_key), title)].append(rec)
    return by_id, by_title


def match_grab(rec, by_id, by_title, id_key):
    did = str(get_download_id(rec) or "")
    if did and did in by_id:
        return by_id[did]
    title = source_title(rec).lower()
    candidates = by_title.get((rec.get(id_key), title), [])
    if candidates:
        return candidates[0]
    return None


def grab_rows(history, entities, id_key, media_kind):
    rows = []
    for rec in history:
        if str(rec.get("eventType", "")).lower() != "grabbed" or not is_usenet(rec):
            continue
        entity = entities.get(rec.get(id_key), {})
        dt = parse_dt(rec.get("date"))
        src = source_title(rec)
        did = str(get_download_id(rec) or "")
        fallback = f"{media_kind}:{rec.get(id_key)}:{src.lower()}:{rec.get('date')}"
        rows.append({
            "grabKey": did or fallback,
            "downloadId": did,
            "mediaKind": media_kind,
            "entityId": rec.get(id_key),
            "title": entity.get("title") or "Unbekannt",
            "year": entity.get("year") or "",
            "date": rec.get("date") or "",
            "timestamp": dt.timestamp() if dt else 0,
            "indexer": get_indexer(rec) or "Unbekannt",
            "downloadClient": download_client(rec),
            "quality": quality_label(rec),
            "releaseGroup": release_group_from_name(src),
            "originalRelease": src,
            "releaseType": episode_release_type(src) if media_kind == "series" else "movie",
        })
    return rows


def failed_items(history, entities, id_key, kind):
    results = []
    for rec in history:
        et = str(rec.get("eventType", "")).lower()
        if et not in ("downloadfailed", "downloadfolderimportfailed") or not is_usenet(rec):
            continue
        entity = entities.get(rec.get(id_key), {})
        data = rec.get("data") or {}
        dt = parse_dt(rec.get("date"))
        src = source_title(rec)
        slug = entity.get("titleSlug") or ""
        arr_url = f"{RADARR_URL}/movie/{slug}" if kind == "movie" and slug else (f"{SONARR_URL}/series/{slug}" if slug else "")
        results.append({
            "kind": "failed", "mediaKind": kind, "title": entity.get("title") or "Unbekannt", "year": entity.get("year") or "",
            "date": rec.get("date") or "", "timestamp": dt.timestamp() if dt else 0, "originalRelease": src,
            "indexer": get_indexer(rec), "downloadClient": download_client(rec), "quality": quality_label(rec),
            "releaseGroup": release_group_from_name(src), "reason": data.get("message") or data.get("reason") or data.get("errorMessage") or "Download/Import fehlgeschlagen",
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
        imported, src = data.get("importedPath") or data.get("destinationPath") or "", source_title(rec)
        identity = (rec.get("id"), imported, src)
        if identity in seen:
            continue
        seen.add(identity)
        mf = movie.get("movieFile") or {}
        size = int(data.get("size") or data.get("fileSize") or mf.get("size") or 0)
        folder = movie.get("path") or (os.path.dirname(imported) if imported else "")
        import_dt, grab_dt = parse_dt(rec.get("date")), parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt
        slug = movie.get("titleSlug") or ""
        did = str(get_download_id(grab or rec) or "")
        grab_key = did or f"movie:{rec.get('movieId')}:{src.lower()}:{(grab or rec).get('date')}"
        items.append({
            "kind": "movie", "movieId": rec.get("movieId"), "grabKey": grab_key, "downloadId": did,
            "date": display_dt.isoformat() if display_dt else rec.get("date"), "grabDate": (grab or {}).get("date") or "", "importDate": rec.get("date") or "",
            "timestamp": display_dt.timestamp() if display_dt else 0, "importTimestamp": import_dt.timestamp() if import_dt else 0,
            "title": movie.get("title") or "Unbekannter Film", "year": movie.get("year") or "", "originalRelease": src,
            "targetFolder": host_path(folder), "targetFile": host_path(imported), "quality": quality_label(rec) or mf.get("quality", {}).get("quality", {}).get("name", ""),
            "releaseGroup": data.get("releaseGroup") or release_group_from_name(src), "indexer": get_indexer(grab or {}) or get_indexer(rec) or "Unbekannt",
            "downloadClient": download_client(grab or {}) or download_client(rec), "size": size, "sizeText": human_size(size),
            "poster": poster_of(movie), "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true", "library": library_from_path(folder),
            "arrUrl": f"{RADARR_URL}/movie/{slug}" if slug else RADARR_URL,
        })
    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items, failed_items(history, movies, "movieId", "movie"), grab_rows(history, movies, "movieId", "movie")


def sonarr_data(since):
    series_list = api_get(SONARR_URL, SONARR_API_KEY, "series")
    series = {s["id"]: s for s in series_list}
    history = history_since(SONARR_URL, SONARR_API_KEY, since)
    grabbed_by_id, grabbed_by_title = build_grab_indexes(history, "seriesId")
    imports = [r for r in history if str(r.get("eventType", "")).lower() == "downloadfolderimported" and is_usenet(r)]
    episode_by_id = {}
    season_episode_counts = defaultdict(int)
    for series_id in sorted({r.get("seriesId") for r in imports if r.get("seriesId")}):
        try:
            episodes = api_get(SONARR_URL, SONARR_API_KEY, "episode", {"seriesId": series_id})
            for ep in episodes:
                if ep.get("id") is not None:
                    episode_by_id[ep["id"]] = ep
                try:
                    season_number = int(ep.get("seasonNumber"))
                    episode_number = int(ep.get("episodeNumber"))
                except (TypeError, ValueError):
                    continue
                # Specials (season 0) and non-numbered rows are intentionally ignored.
                # The count is Sonarr's current canonical episode list, so incomplete
                # or still-airing seasons do not collapse prematurely.
                if season_number > 0 and episode_number > 0:
                    season_episode_counts[(series_id, season_number)] += 1
        except Exception:
            pass
    items, seen = [], set()
    for rec in imports:
        data, ser = rec.get("data") or {}, series.get(rec.get("seriesId"), {})
        ep = episode_by_id.get(rec.get("episodeId"), {})
        grab = match_grab(rec, grabbed_by_id, grabbed_by_title, "seriesId")
        imported, src = data.get("importedPath") or data.get("destinationPath") or "", source_title(rec)
        identity = (rec.get("id"), rec.get("episodeId"), imported, src)
        if identity in seen:
            continue
        seen.add(identity)
        folder = ser.get("path") or (os.path.dirname(imported) if imported else "")
        season, number = ep.get("seasonNumber"), ep.get("episodeNumber")
        episode_code = f"S{int(season):02d}E{int(number):02d}" if season is not None and number is not None else ""
        try:
            expected_count = season_episode_counts.get((rec.get("seriesId"), int(season)), 0) if season is not None else 0
        except (TypeError, ValueError):
            expected_count = 0
        import_dt, grab_dt = parse_dt(rec.get("date")), parse_dt((grab or {}).get("date"))
        display_dt = grab_dt or import_dt
        size = int(data.get("size") or data.get("fileSize") or 0)
        slug = ser.get("titleSlug") or ""
        did = str(get_download_id(grab or rec) or "")
        grab_key = did or f"series:{rec.get('seriesId')}:{src.lower()}:{(grab or rec).get('date')}"
        items.append({
            "kind": "episode", "seriesId": rec.get("seriesId"), "grabKey": grab_key, "downloadId": did,
            "date": display_dt.isoformat() if display_dt else rec.get("date"), "grabDate": (grab or {}).get("date") or "", "importDate": rec.get("date") or "",
            "timestamp": display_dt.timestamp() if display_dt else 0, "importTimestamp": import_dt.timestamp() if import_dt else 0,
            "title": ser.get("title") or "Unbekannte Serie", "year": ser.get("year") or "", "seasonNumber": season, "episodeNumber": number,
            "seasonEpisodeCount": expected_count,
            "episodeCode": episode_code, "episodeTitle": ep.get("title") or "", "originalRelease": src,
            "targetFolder": host_path(folder), "targetFile": host_path(imported), "quality": quality_label(rec), "releaseGroup": data.get("releaseGroup") or release_group_from_name(src),
            "indexer": get_indexer(grab or {}) or get_indexer(rec) or "Unbekannt", "downloadClient": download_client(grab or {}) or download_client(rec),
            "size": size, "sizeText": human_size(size), "poster": poster_of(ser), "isUpgrade": str(data.get("isUpgrade", "")).lower() == "true",
            "library": library_from_path(folder), "releaseType": episode_release_type(src), "arrUrl": f"{SONARR_URL}/series/{slug}" if slug else SONARR_URL,
        })
    items.sort(key=lambda x: x["timestamp"], reverse=True)
    return items, failed_items(history, series, "seriesId", "series"), grab_rows(history, series, "seriesId", "series")


def build_payload(force=False):
    now = time.time()
    if not force and _cache["payload"] is not None and _cache["expires"] > now:
        return _cache["payload"]
    since = datetime.now(timezone.utc) - timedelta(days=MAX_DAYS)
    movies, movie_failed, movie_grabs = radarr_data(since) if RADARR_API_KEY else ([], [], [])
    episodes, series_failed, series_grabs = sonarr_data(since) if SONARR_API_KEY else ([], [], [])
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(), "maxDays": MAX_DAYS,
        "arr": {"radarr": RADARR_URL, "sonarr": SONARR_URL},
        "movies": movies, "episodes": episodes,
        "grabs": sorted(movie_grabs + series_grabs, key=lambda x: x["timestamp"], reverse=True),
        "failed": sorted(movie_failed + series_failed, key=lambda x: x["timestamp"], reverse=True),
    }
    _cache["payload"], _cache["expires"] = payload, now + CACHE_SECONDS
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
