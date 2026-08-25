import time

import direct_indexer_links

server = direct_indexer_links.server
app = server.app
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
SCHEMA_VERSION = 6

_original_build_payload = server.core.build_payload
_original_stats_view = app.view_functions["stats"]


def _ledger_key(item):
    return (
        str(item.get("nzoId") or item.get("downloadId") or "").strip()
        or f"{item.get('originalRelease','')}|{item.get('timestamp',0)}"
    )


def _merge_ledger(previous, fresh):
    cutoff = time.time() - server.core.MAX_DAYS * 86400
    merged = {}

    for item in [*(previous or []), *(fresh or [])]:
        try:
            ts = float(item.get("timestamp") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts and ts < cutoff:
            continue

        if str(item.get("source") or "").lower() in {"reppollo", "repollo"}:
            item = dict(item)
            item["source"] = "rePollo"

        merged[_ledger_key(item)] = item

    return sorted(
        merged.values(),
        key=lambda x: float(x.get("timestamp") or 0),
        reverse=True,
    )


def build_payload_with_ledger(force=False):
    previous_payload = server.core._cache.get("payload") or {}
    previous_sab = previous_payload.get("sabDownloads") or []

    payload = _original_build_payload(force=force)
    payload["sabDownloads"] = _merge_ledger(
        previous_sab,
        payload.get("sabDownloads") or [],
    )
    payload["_schemaVersion"] = SCHEMA_VERSION

    server.core._cache["payload"] = payload
    server.core._cache["expires"] = time.time() + server.core.CACHE_SECONDS
    return payload


server.core.build_payload = build_payload_with_ledger


def stats_view_v6():
    payload = server.core._cache.get("payload") or {}
    if int(payload.get("_schemaVersion", 0) or 0) < SCHEMA_VERSION:
        server.trigger_refresh()
    return _original_stats_view()


app.view_functions["stats"] = stats_view_v6
