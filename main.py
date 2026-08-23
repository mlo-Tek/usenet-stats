import time

import server

app = server.app

_original_build_payload = server.core.build_payload


def _ledger_key(item):
    return (
        str(item.get("nzoId") or item.get("downloadId") or "").strip()
        or f"{item.get('originalRelease','')}|{item.get('timestamp',0)}"
    )


def _merge_ledger(previous, fresh):
    cutoff = time.time() - server.core.MAX_DAYS * 86400
    merged = {}

    # Old data first, fresh SAB history second so current metadata wins.
    for item in [*(previous or []), *(fresh or [])]:
        try:
            ts = float(item.get("timestamp") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts and ts < cutoff:
            continue
        merged[_ledger_key(item)] = item

    return sorted(merged.values(), key=lambda x: float(x.get("timestamp") or 0), reverse=True)


def build_payload_with_ledger(force=False):
    previous_payload = server.core._cache.get("payload") or {}
    previous_sab = previous_payload.get("sabDownloads") or []

    payload = _original_build_payload(force=force)
    payload["sabDownloads"] = _merge_ledger(
        previous_sab,
        payload.get("sabDownloads") or [],
    )

    server.core._cache["payload"] = payload
    server.core._cache["expires"] = time.time() + server.core.CACHE_SECONDS
    return payload


server.core.build_payload = build_payload_with_ledger
