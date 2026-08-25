import re
from urllib.parse import urlparse

import source_enrichment

server = source_enrichment.server
core = server.core


def _http_url(value):
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        parsed = urlparse(value)
    except Exception:
        return ""
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return value


def indexer_url_from_history_record(record):
    """Return the indexer's human-facing release/detail URL from an Arr history record."""
    data = record.get("data") or {}

    # nzbInfoUrl is the canonical Arr history field and normally points to the
    # release/details page at the original indexer (also when the indexer is
    # configured through Prowlarr).
    for key in (
        "nzbInfoUrl",
        "indexerUrl",
        "infoUrl",
        "detailsUrl",
        "detailUrl",
    ):
        url = _http_url(data.get(key) or record.get(key))
        if url:
            return url

    return ""


# Enrich the existing grab rows without touching the heavy Radarr/Sonarr scan.
_original_grab_rows = core.grab_rows


def grab_rows_with_indexer_url(history, entities, id_key, media_kind):
    rows = _original_grab_rows(history, entities, id_key, media_kind)
    grab_records = [
        rec for rec in history
        if str(rec.get("eventType", "")).lower() == "grabbed"
        and core.is_usenet(rec)
    ]

    # core.grab_rows iterates the same filtered history in the same order.
    for row, rec in zip(rows, grab_records):
        row["indexerUrl"] = indexer_url_from_history_record(rec)

    return rows


core.grab_rows = grab_rows_with_indexer_url


# For SAB/rePollo-only jobs there may be no Arr grab. Preserve a human-facing
# details/info URL from SAB metadata if one exists. Deliberately do NOT use a
# generic NZB download URL, because clicking the badge must open the indexer
# page rather than start another NZB download.
_slot_indexer_urls = {}
_original_indexer_from_slot = server.indexer_from_slot


def _urls_from_info_value(value):
    found = []
    if isinstance(value, str):
        direct = _http_url(value)
        if direct:
            found.append(direct)
        for candidate in re.findall(r'https?://[^\s<>"\']+', value, flags=re.I):
            url = _http_url(candidate.rstrip(".,);]"))
            if url:
                found.append(url)
    elif isinstance(value, dict):
        # Only inspect fields whose names imply a browser-facing information
        # page. A plain `url` field can be an API/NZB download endpoint.
        for key, child in value.items():
            key_l = str(key).lower()
            if any(token in key_l for token in ("info", "detail", "indexer", "site", "web")):
                found.extend(_urls_from_info_value(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            found.extend(_urls_from_info_value(child))
    return found


def indexer_url_from_sab_slot(slot):
    for key in (
        "nzbInfoUrl",
        "indexerUrl",
        "infoUrl",
        "detailsUrl",
        "detailUrl",
        "url_info",
    ):
        for url in _urls_from_info_value(slot.get(key)):
            return url

    meta = slot.get("meta")
    if isinstance(meta, dict):
        for key, value in meta.items():
            key_l = str(key).lower()
            if any(token in key_l for token in ("info", "detail", "indexer", "site", "web")):
                for url in _urls_from_info_value(value):
                    return url

    return ""


def tracking_indexer_from_slot(slot):
    nzo_id = str(slot.get("nzo_id") or slot.get("nzoId") or "").strip()
    url = indexer_url_from_sab_slot(slot)
    if nzo_id and url:
        _slot_indexer_urls[nzo_id] = url
    return _original_indexer_from_slot(slot)


server.indexer_from_slot = tracking_indexer_from_slot

_original_build_sab_downloads = server.build_sab_downloads


def sab_downloads_with_indexer_urls(payload):
    rows = _original_build_sab_downloads(payload)

    grab_urls_by_download_id = {}
    grab_urls_by_key = {}
    for grab in payload.get("grabs") or []:
        url = str(grab.get("indexerUrl") or "").strip()
        if not url:
            continue
        did = str(grab.get("downloadId") or "").strip()
        if did:
            grab_urls_by_download_id[did] = url
        key = str(grab.get("grabKey") or "").strip()
        if key:
            grab_urls_by_key[key] = url

    for row in rows:
        did = str(row.get("downloadId") or row.get("nzoId") or "").strip()
        row["indexerUrl"] = (
            grab_urls_by_download_id.get(did)
            or grab_urls_by_key.get(str(row.get("grabKey") or ""))
            or _slot_indexer_urls.get(str(row.get("nzoId") or "").strip())
            or row.get("indexerUrl")
            or ""
        )

    return rows


server.build_sab_downloads = sab_downloads_with_indexer_urls


@server.app.after_request
def inject_indexer_link_frontend(response):
    content_type = response.headers.get("Content-Type", "")
    if "text/html" not in content_type.lower():
        return response

    try:
        body = response.get_data(as_text=True)
        marker = '<script src="/static/indexer-links.js"></script>'
        if marker not in body and "</body>" in body:
            body = body.replace("</body>", marker + "\n</body>")
            response.set_data(body)
            response.headers["Content-Length"] = str(len(response.get_data()))
    except Exception:
        pass

    return response
