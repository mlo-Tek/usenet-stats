import os
import re
from urllib.parse import urlparse

import server

# Correct product spelling. Keep the legacy variable/category spelling working
# so existing Unraid containers do not break after the update.
REPOLLO_CATEGORIES = {
    x.strip().lower()
    for x in (
        os.getenv("REPOLLO_CATEGORIES")
        or os.getenv("REPPOLLO_CATEGORIES")
        or "repollo,reseed,reppollo"
    ).split(",")
    if x.strip()
}

UNKNOWN_INDEXERS = {"", "unbekannt", "unknown", "none", "null"}
SOURCE_PRIORITY = {"SABnzbd": 0, "Radarr": 1, "Sonarr": 1, "rePollo": 2}

INDEXER_HOST_ALIASES = {
    "nzbgeek.info": "NZBGeek",
    "api.nzbgeek.info": "NZBGeek",
    "drunkenslug.com": "DrunkenSlug",
    "www.drunkenslug.com": "DrunkenSlug",
    "scenenzbs.com": "SceneNZBs",
    "www.scenenzbs.com": "SceneNZBs",
    "nzbfinder.ws": "NZB Finder",
    "www.nzbfinder.ws": "NZB Finder",
    "nzb.su": "NZB.su",
    "api.nzb.su": "NZB.su",
    "nzbplanet.net": "NZBPlanet",
    "www.nzbplanet.net": "NZBPlanet",
    "althub.co.za": "altHUB",
    "www.althub.co.za": "altHUB",
    "ninjacentral.co.za": "NinjaCentral",
    "www.ninjacentral.co.za": "NinjaCentral",
    "abnzb.com": "abNZB",
    "www.abnzb.com": "abNZB",
}


def _is_unknown(value):
    return str(value or "").strip().lower() in UNKNOWN_INDEXERS


def _normalize_release(value):
    value = str(value or "").strip()
    value = re.sub(r"\.nzb$", "", value, flags=re.I)
    value = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return re.sub(r"\s+", " ", value)


def _friendly_host(host):
    host = str(host or "").strip().lower().rstrip(".")
    if not host:
        return ""
    return INDEXER_HOST_ALIASES.get(host, host.removeprefix("www."))


def _host_from_url(text):
    if not text:
        return ""
    for match in re.finditer(r"https?://[^\s<>\"']+", str(text), flags=re.I):
        try:
            host = urlparse(match.group(0)).hostname or ""
        except Exception:
            host = ""
        if host:
            return _friendly_host(host)
    return ""


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from _walk_strings(v)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _walk_strings(item)


def enhanced_indexer_from_slot(slot):
    for key in (
        "indexer", "indexer_name", "indexerName",
        "provider", "provider_name", "providerName",
        "site", "site_name", "siteName",
    ):
        value = slot.get(key)
        if value and not _is_unknown(value):
            return str(value).strip()

    meta = slot.get("meta")
    if isinstance(meta, dict):
        for key, value in meta.items():
            key_l = str(key).lower()
            if any(token in key_l for token in ("indexer", "provider", "site")):
                if value and not _is_unknown(value):
                    return str(value).strip()

    candidates = [
        slot.get("url_info"),
        slot.get("nzb_url"),
        slot.get("url"),
        slot.get("report"),
        slot.get("script_line"),
        slot.get("stage_log"),
        slot.get("meta"),
    ]
    for candidate in candidates:
        for text in _walk_strings(candidate):
            host = _host_from_url(text)
            if host:
                return host

    return "Unbekannt"


def detect_repollo(slot):
    category = str(slot.get("category") or "").strip().lower()
    script = str(slot.get("script") or "").strip().lower()
    name = str(slot.get("name") or slot.get("nzb_name") or "").lower()

    if category and category in REPOLLO_CATEGORIES:
        return True

    marker = f"{script} {name}"
    return "repollo" in marker or "reppollo" in marker


def _canonical_source(value):
    source = str(value or "").strip()
    normalized = source.lower()
    if normalized in {"repollo", "reppollo"}:
        return "rePollo"
    if normalized == "radarr":
        return "Radarr"
    if normalized == "sonarr":
        return "Sonarr"
    return "SABnzbd"


def _row_source(row):
    category = str(row.get("category") or "").strip().lower()
    if category in REPOLLO_CATEGORIES:
        return "rePollo"
    return _canonical_source(row.get("source"))


def _prefer_source(old, new):
    old = _canonical_source(old) if old else ""
    new = _canonical_source(new) if new else ""
    if not old:
        return new
    if SOURCE_PRIORITY.get(new, 0) > SOURCE_PRIORITY.get(old, 0):
        return new
    return old


server.indexer_from_slot = enhanced_indexer_from_slot
server.detect_reppollo = detect_repollo

_original_build_sab_downloads = server.build_sab_downloads


def build_release_indexer_map(payload):
    """Return only unambiguous release -> indexer mappings."""
    candidates = {}

    for row in [
        *(payload.get("grabs") or []),
        *(payload.get("movies") or []),
        *(payload.get("episodes") or []),
    ]:
        release = _normalize_release(
            row.get("originalRelease") or row.get("sourceTitle") or ""
        )
        indexer = str(row.get("indexer") or "").strip()
        if not release or _is_unknown(indexer):
            continue
        candidates.setdefault(release, set()).add(indexer)

    return {
        release: next(iter(indexers))
        for release, indexers in candidates.items()
        if len(indexers) == 1
    }


def enrich_arr_download_sources(payload, sab_rows):
    """Attach the actual trigger/source to normal Arr media rows.

    A normal SAB download does not replace the Arr trigger: Radarr/Sonarr asked
    SAB to download it, so the source remains the corresponding Arr. Only an
    authoritative rePollo SAB category may override the Arr source. Kryo Manager
    is resolved later from rePollo rows against Kryo's own history.
    """
    repollo_by_download_id = set()
    repollo_releases = set()

    for row in sab_rows:
        source = _row_source(row)
        row["source"] = source
        if source != "rePollo":
            continue

        download_id = str(row.get("downloadId") or row.get("nzoId") or "").strip()
        if download_id:
            repollo_by_download_id.add(download_id)

        release = _normalize_release(row.get("originalRelease"))
        if release:
            repollo_releases.add(release)

    for item in [*(payload.get("movies") or []), *(payload.get("episodes") or [])]:
        default_source = "Radarr" if item.get("kind") == "movie" else "Sonarr"
        download_id = str(item.get("downloadId") or "").strip()
        is_repollo = bool(download_id and download_id in repollo_by_download_id)

        if not is_repollo:
            release = _normalize_release(
                item.get("originalRelease") or item.get("sourceTitle") or ""
            )
            is_repollo = bool(release and release in repollo_releases)

        item["source"] = "rePollo" if is_repollo else default_source


def enriched_build_sab_downloads(payload):
    rows = _original_build_sab_downloads(payload)
    release_indexers = build_release_indexer_map(payload)

    for row in rows:
        row["source"] = _row_source(row)

        if _is_unknown(row.get("indexer")):
            release = _normalize_release(row.get("originalRelease"))
            inferred = release_indexers.get(release)
            if inferred:
                row["indexer"] = inferred
                row["indexerSource"] = "Release-Match aus Radarr/Sonarr"
        elif row.get("arrUrl"):
            row.setdefault("indexerSource", "Radarr/Sonarr-History")
        else:
            row.setdefault("indexerSource", "SABnzbd-Quellmetadaten")

    enrich_arr_download_sources(payload, rows)
    return rows


server.build_sab_downloads = enriched_build_sab_downloads


@server.app.after_request
def inject_sab_frontend(response):
    content_type = response.headers.get("Content-Type", "")
    if "text/html" not in content_type.lower():
        return response

    try:
        body = response.get_data(as_text=True)
        marker = '<script src="/static/sab.js"></script>'
        if marker not in body and "</body>" in body:
            body = body.replace("</body>", marker + "\n</body>")
            response.set_data(body)
            response.headers["Content-Length"] = str(len(response.get_data()))
    except Exception:
        pass

    return response
