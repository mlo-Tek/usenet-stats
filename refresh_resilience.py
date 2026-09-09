import threading

import incremental_refresh as refresh

server = refresh.server
core = server.core
app = server.app

_context = threading.local()
_original_radarr_data = core.radarr_data
_original_sonarr_data = core.sonarr_data
_original_fast_refresh = refresh.fast_refresh
_original_meta = refresh.meta
_original_worker = refresh.incremental_refresh_worker

with server._state_lock:
    server._state.setdefault("refreshWarnings", [])


def _short_error(label, exc):
    name = type(exc).__name__
    text = str(exc).strip().replace("\n", " ")
    if len(text) > 140:
        text = text[:137] + "..."
    return f"{label}: {name}" + (f" · {text}" if text else "")


def _warnings():
    if not hasattr(_context, "warnings"):
        _context.warnings = []
    return _context.warnings


def _safe_radarr(since):
    try:
        return _original_radarr_data(since)
    except Exception as exc:
        if getattr(_context, "fast", False):
            _warnings().append(_short_error("Radarr", exc))
            return [], [], []
        raise


def _safe_sonarr(since):
    try:
        return _original_sonarr_data(since)
    except Exception as exc:
        if getattr(_context, "fast", False):
            _warnings().append(_short_error("Sonarr", exc))
            return [], [], []
        raise


core.radarr_data = _safe_radarr
core.sonarr_data = _safe_sonarr


def resilient_fast_refresh():
    _context.fast = True
    _context.warnings = []
    try:
        result = _original_fast_refresh()
        warnings = list(_warnings())
        with server._state_lock:
            server._state["refreshWarnings"] = warnings
        return result
    finally:
        _context.fast = False


refresh.fast_refresh = resilient_fast_refresh


def resilient_worker(force_full=False):
    """Keep a successful fast refresh even if the optional full reconciliation fails."""
    if not force_full:
        return _original_worker(force_full=False)

    # Explicit full refreshes still use the original worker, because the caller
    # intentionally requested a full reconciliation and should see hard errors.
    return _original_worker(force_full=True)


def resilient_meta(cold_start=False):
    data = _original_meta(cold_start=cold_start)
    with server._state_lock:
        warnings = list(server._state.get("refreshWarnings") or [])
    data["refreshWarnings"] = warnings
    return data


refresh.meta = resilient_meta
server.meta = resilient_meta
server.refresh_worker = resilient_worker
