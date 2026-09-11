import time
from collections import defaultdict

import refresh_resilience

server = refresh_resilience.server
app = server.app
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
SCHEMA_VERSION = 10

_original_sonarr_data = server.core.sonarr_data
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


def _season_episode_counts(series_ids):
    """Return Sonarr's canonical regular-episode count per series/season."""
    counts = defaultdict(int)

    for series_id in series_ids:
        try:
            episodes = server.core.api_get(
                server.core.SONARR_URL,
                server.core.SONARR_API_KEY,
                "episode",
                {"seriesId": series_id},
            )
        except Exception:
            continue

        seen = set()
        for episode in episodes or []:
            try:
                season_number = int(episode.get("seasonNumber"))
                episode_number = int(episode.get("episodeNumber"))
            except (TypeError, ValueError):
                continue

            if season_number <= 0 or episode_number <= 0:
                continue

            identity = (series_id, season_number, episode_number)
            if identity in seen:
                continue
            seen.add(identity)
            counts[(series_id, season_number)] += 1

    return counts


def sonarr_data_with_season_counts(since):
    """Keep seasonEpisodeCount on both full and incremental Sonarr refreshes.

    incremental_refresh.py calls core.sonarr_data() directly. Enriching here is
    therefore essential: doing it only after build_payload() means the next fast
    refresh replaces the rows and silently drops seasonEpisodeCount again.
    """
    items, failed, grabs = _original_sonarr_data(since)
    if not items or not server.core.SONARR_API_KEY:
        return items, failed, grabs

    series_ids = {
        item.get("seriesId")
        for item in items
        if item.get("seriesId") is not None
    }
    counts = _season_episode_counts(series_ids)

    for item in items:
        try:
            key = (item.get("seriesId"), int(item.get("seasonNumber")))
        except (TypeError, ValueError):
            continue
        expected = counts.get(key, 0)
        if expected > 0:
            item["seasonEpisodeCount"] = expected

    return items, failed, grabs


server.core.sonarr_data = sonarr_data_with_season_counts


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


def stats_view_v10():
    payload = server.core._cache.get("payload") or {}
    if int(payload.get("_schemaVersion", 0) or 0) < SCHEMA_VERSION:
        server.trigger_refresh(force_full=True)
    return _original_stats_view()


app.view_functions["stats"] = stats_view_v10
