import time

import refresh_resilience

server = refresh_resilience.server
app = server.app
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
SCHEMA_VERSION = 8

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


def _enrich_season_episode_counts(payload):
    """Attach Sonarr's expected regular-episode count to every episode row.

    The frontend uses this to fold individual downloads only when they actually
    represent a complete season. One Sonarr series request is enough because
    season statistics are already included in the series payload.
    """
    rows = payload.get("episodes") or []
    if not rows or not server.core.SONARR_API_KEY:
        return

    wanted_series = {row.get("seriesId") for row in rows if row.get("seriesId") is not None}
    if not wanted_series:
        return

    try:
        series_list = server.core.api_get(
            server.core.SONARR_URL,
            server.core.SONARR_API_KEY,
            "series",
        )
    except Exception:
        return

    counts = {}
    for series in series_list or []:
        series_id = series.get("id")
        if series_id not in wanted_series:
            continue
        for season in series.get("seasons") or []:
            season_number = season.get("seasonNumber")
            if season_number is None or int(season_number or 0) <= 0:
                continue
            stats = season.get("statistics") or {}
            expected = stats.get("totalEpisodeCount")
            if expected in (None, 0, "0"):
                expected = stats.get("episodeCount")
            try:
                expected = int(expected or 0)
            except (TypeError, ValueError):
                expected = 0
            if expected > 0:
                counts[(series_id, int(season_number))] = expected

    for row in rows:
        try:
            key = (row.get("seriesId"), int(row.get("seasonNumber")))
        except (TypeError, ValueError):
            continue
        expected = counts.get(key)
        if expected:
            row["seasonEpisodeCount"] = expected


def build_payload_with_ledger(force=False):
    previous_payload = server.core._cache.get("payload") or {}
    previous_sab = previous_payload.get("sabDownloads") or []

    payload = _original_build_payload(force=force)
    payload["sabDownloads"] = _merge_ledger(
        previous_sab,
        payload.get("sabDownloads") or [],
    )
    _enrich_season_episode_counts(payload)
    payload["_schemaVersion"] = SCHEMA_VERSION

    server.core._cache["payload"] = payload
    server.core._cache["expires"] = time.time() + server.core.CACHE_SECONDS
    return payload


server.core.build_payload = build_payload_with_ledger


def stats_view_v8():
    payload = server.core._cache.get("payload") or {}
    if int(payload.get("_schemaVersion", 0) or 0) < SCHEMA_VERSION:
        server.trigger_refresh(force_full=False)
    return _original_stats_view()


app.view_functions["stats"] = stats_view_v8
