from urllib.parse import urlparse

import indexer_links

server = indexer_links.server
core = server.core


def valid_url(value):
    value = str(value or "").strip()
    try:
        parsed = urlparse(value)
    except Exception:
        return ""
    return value if parsed.scheme in ("http", "https") and parsed.netloc else ""


def history_url(record):
    data = record.get("data") or {}
    for key in ("nzbInfoUrl", "indexerUrl", "infoUrl", "detailsUrl", "detailUrl", "guid", "indexerGuid"):
        url = valid_url(data.get(key) or record.get(key))
        if url:
            return url
    return ""


# Fill indexerUrl on grab rows even when a Prowlarr/indexer setup uses `guid`
# instead of `nzbInfoUrl` for the original release page.
_previous_grab_rows = core.grab_rows


def grab_rows(history, entities, id_key, media_kind):
    rows = _previous_grab_rows(history, entities, id_key, media_kind)
    records = [r for r in history if str(r.get("eventType", "")).lower() == "grabbed" and core.is_usenet(r)]
    for row, record in zip(rows, records):
        if not valid_url(row.get("indexerUrl")):
            row["indexerUrl"] = history_url(record)
    return rows


core.grab_rows = grab_rows


def attach(items, grabs):
    by_download = {}
    by_key = {}
    by_release = {}
    for grab in grabs or []:
        url = valid_url(grab.get("indexerUrl"))
        if not url:
            continue
        did = str(grab.get("downloadId") or "").strip()
        key = str(grab.get("grabKey") or "").strip()
        release = str(grab.get("originalRelease") or "").strip().lower()
        if did:
            by_download[did] = url
        if key:
            by_key[key] = url
        if release and release not in by_release:
            by_release[release] = url

    for item in items or []:
        did = str(item.get("downloadId") or item.get("nzoId") or "").strip()
        key = str(item.get("grabKey") or "").strip()
        release = str(item.get("originalRelease") or "").strip().lower()
        item["indexerUrl"] = valid_url(item.get("indexerUrl")) or by_download.get(did) or by_key.get(key) or by_release.get(release) or ""


_previous_radarr = core.radarr_data
_previous_sonarr = core.sonarr_data


def radarr_data(since):
    items, failed, grabs = _previous_radarr(since)
    attach(items, grabs)
    attach(failed, grabs)
    return items, failed, grabs


def sonarr_data(since):
    items, failed, grabs = _previous_sonarr(since)
    attach(items, grabs)
    attach(failed, grabs)
    return items, failed, grabs


core.radarr_data = radarr_data
core.sonarr_data = sonarr_data
