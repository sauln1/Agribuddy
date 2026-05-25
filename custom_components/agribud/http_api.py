"""Custom HTTP endpoints for Agribud card communication.

Endpoints:
  GET  /api/agribud/status                — integration health and masked config
  GET  /api/agribud/test_connection       — verifies stored Perenual key
  GET  /api/agribud/search_plants?q=...   — Perenual species-list search
  GET  /api/agribud/species/<id>          — Perenual species detail
  POST /api/agribud/update_config         — update weather entity, reload integration
  GET  /api/agribud/plots                 — list grow plots
  POST /api/agribud/plot_create           — create a grow plot
  GET  /api/agribud/plots/<plot_id>       — fetch one plot
  PUT  /api/agribud/plots/<plot_id>       — update plot name/description
  DELETE /api/agribud/plots/<plot_id>     — remove plot
"""
from __future__ import annotations

import json
import logging
import time

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .api import (
    PerenualApiClient, PerenualApiError,
    PerenualAuthError, PerenualConnectionError, PerenualRateLimitError,
)
from .const import (
    DOMAIN, CONF_API_KEY, CONF_WEATHER_ENTITY,
    PERENUAL_FREE_DAILY_LIMIT,
)

_LOGGER = logging.getLogger(__name__)

_HTTP_API_VERSION = "1.1.1"


def async_register_views(hass: HomeAssistant) -> None:
    """Register all Agribud HTTP views.

    Each view is registered in its own try/except so a single failure doesn't
    prevent later views from registering. Logs at WARNING level so the output
    is visible regardless of how the user has configured logging.
    """
    _LOGGER.warning(
        "Agribud: async_register_views called — http_api version %s",
        _HTTP_API_VERSION,
    )
    views = [
        ("AgribudStatusView",         AgribudStatusView),
        ("AgribudTestConnectionView", AgribudTestConnectionView),
        ("AgribudSearchView",         AgribudSearchView),
        ("AgribudSpeciesView",        AgribudSpeciesView),
        ("AgribudUpdateConfigView",   AgribudUpdateConfigView),
        ("AgribudPlotsView",          AgribudPlotsView),
        ("AgribudPlotCreateView",     AgribudPlotCreateView),
        ("AgribudPlotView",           AgribudPlotView),
        ("AgribudWeatherLogView",     AgribudWeatherLogView),
        ("AgribudDeletedSpeciesView", AgribudDeletedSpeciesView),
        ("AgribudSeasonView",         AgribudSeasonView),
    ]
    successes, failures = [], []
    for name, cls in views:
        try:
            hass.http.register_view(cls(hass))
            successes.append(f"{name} → {cls.url}")
        except Exception as err:
            failures.append(f"{name} → {cls.url}: {type(err).__name__}: {err}")
            _LOGGER.error(
                "Agribud: register_view(%s) failed for url=%s — %s: %s",
                name, cls.url, type(err).__name__, err,
            )
    _LOGGER.warning(
        "Agribud: HTTP view registration done — %d succeeded, %d failed.\n"
        "  Successes:\n    %s\n  Failures:\n    %s",
        len(successes), len(failures),
        "\n    ".join(successes) if successes else "(none)",
        "\n    ".join(failures)  if failures  else "(none)",
    )


def _json(data, status=200):
    from aiohttp.web import Response
    return Response(status=status, content_type="application/json", text=json.dumps(data))


def _get_api(hass: HomeAssistant) -> PerenualApiClient | None:
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "api" in v:
            return v["api"]
    return None


def _get_store(hass: HomeAssistant):
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "store" in v:
            return v["store"]
    return None


def _get_coordinator(hass: HomeAssistant):
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "coordinator" in v:
            return v["coordinator"]
    return None


def _get_entry(hass: HomeAssistant):
    entries = hass.config_entries.async_entries(DOMAIN)
    return entries[0] if entries else None


def _get_caches(hass: HomeAssistant) -> dict | None:
    """Return the integration's in-memory caches dict (set up in __init__)."""
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "species_cache" in v:
            return v
    return None


# Search results from Verdantly are very stable — plant species data
# doesn't change daily. The Verdantly Gardening API free tier on RapidAPI
# allows only 25 calls per MONTH, so we cache aggressively. Same query
# inside a 30-day window is served from cache, costing zero API calls.
SEARCH_CACHE_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def _require_admin(request) -> bool:
    """Returns True if the requesting user has admin privileges. Used for the
    /status endpoint to gate disclosure of extra config detail."""
    try:
        hass_user = request.get("hass_user")
        return bool(hass_user and getattr(hass_user, "is_admin", False))
    except Exception:
        return False


# ── Views ─────────────────────────────────────────────────────────────────────

class AgribudStatusView(HomeAssistantView):
    """GET /api/agribud/status — integration health snapshot."""
    url = "/api/agribud/status"
    name = "api:agribud:status"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        entry = _get_entry(self._hass)
        if entry is None:
            return _json({
                "configured": False,
                "message": "No config entry found — run the setup wizard first.",
                "api_provider": "verdantly",
                "rate_limit_note": (
                    "Verdantly Gardening API on RapidAPI. FREE TIER: 25 calls "
                    "per MONTH only. Search results are cached for 30 days "
                    "and full plant detail is included in each search "
                    "response — so each unique plant search costs 1 call, "
                    "and opening an added plant's card costs 0 calls."
                ),
            })
        api_key = entry.data.get(CONF_API_KEY, "")
        api_ready = _get_api(self._hass) is not None
        is_admin = _require_admin(request)
        # Pull the monthly call counter so the card can warn the user when
        # they're close to the 25-call free-tier limit.
        usage_payload = None
        try:
            for v in self._hass.data.get(DOMAIN, {}).values():
                if isinstance(v, dict) and "usage" in v and v["usage"] is not None:
                    usage_payload = v["usage"].as_dict()
                    break
        except Exception as err:
            _LOGGER.debug("Agribud: status — could not read usage tracker: %s", err)
        payload = {
            "configured":       True,
            "api_provider":     "verdantly",
            "api_key_masked":   "set" if api_key else "not set",
            "weather_entity":   entry.options.get(CONF_WEATHER_ENTITY, entry.data.get(CONF_WEATHER_ENTITY, "not set")),
            "api_client_ready": api_ready,
            "http_api_version": _HTTP_API_VERSION,
            "rate_limit_note": (
                "Verdantly Gardening API (via RapidAPI). FREE TIER: 25 calls "
                "per MONTH only — search cache is held 30 days to minimize "
                "usage. Each unique plant search costs 1 call; opening an "
                "added plant's card costs 0 calls (cached on plant record)."
            ),
            "monthly_quota":    25,
            "usage":            usage_payload,
            "message": (
                "API client is ready." if api_ready
                else "Config entry exists but API client is not loaded — check HA logs."
            ),
        }
        if is_admin:
            payload["api_key_length"] = len(api_key)
            payload["entry_id"]       = entry.entry_id
        return _json(payload)


class AgribudTestConnectionView(HomeAssistantView):
    """GET /api/agribud/test_connection — live Verdantly key test (costs 1 API call against the 25/month quota)."""
    url = "/api/agribud/test_connection"
    name = "api:agribud:test_connection"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        api = _get_api(self._hass)
        if api is None:
            return _json({
                "ok": False, "error": "not_configured",
                "message": (
                    "Agribud is not set up. Go to "
                    "Settings → Integrations → Add Integration → Agribud."
                ),
            }, 404)
        try:
            await api.validate()
            _LOGGER.info("Agribud: connection test passed — Verdantly API key is valid")
            return _json({"ok": True, "message": "Perenual API key is valid and working."})
        except PerenualAuthError as err:
            _LOGGER.error("Agribud: connection test — Verdantly rejected key: %s", err)
            return _json({
                "ok": False, "error": "invalid_auth",
                "message": f"Verdantly rejected the stored key ({err}). Re-run the setup wizard.",
            }, 401)
        except PerenualRateLimitError as err:
            _LOGGER.warning("Agribud: connection test — rate limit hit: %s", err)
            return _json({
                "ok": False, "error": "rate_limited",
                "message": str(err),
            }, 429)
        except PerenualConnectionError as err:
            _LOGGER.error("Agribud: connection test — cannot reach Verdantly: %s", err)
            return _json({
                "ok": False, "error": "cannot_connect",
                "message": f"Cannot reach Verdantly: {err}. Check your internet connection.",
            }, 502)
        except PerenualApiError as err:
            _LOGGER.error("Agribud: connection test — Verdantly API error: %s", err)
            return _json({"ok": False, "error": "api_error", "message": str(err)}, 502)
        except Exception as err:
            _LOGGER.exception("Agribud: connection test — unexpected error")
            return _json({
                "ok": False, "error": "unknown",
                "message": f"Unexpected error: {type(err).__name__}: {err}",
            }, 500)


class AgribudSearchView(HomeAssistantView):
    url = "/api/agribud/search_plants"
    name = "api:agribud:search_plants"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        q = request.rel_url.query.get("q", "").strip()
        # APIFarmer doesn't support a state filter — older cards may still send
        # the param. We accept it for compat but ignore it. The cache key
        # likewise no longer includes state.
        state_raw = request.rel_url.query.get("state", "").strip().upper()
        if state_raw:
            _LOGGER.debug(
                "Agribud: search received state=%r — ignored (APIFarmer has no state filter)",
                state_raw,
            )
        state = None  # Always None for APIFarmer

        if not q:
            return _json({"error": "missing_query", "message": "Provide a ?q= search term."}, 400)
        api = _get_api(self._hass)
        if api is None:
            return _json({
                "error": "api_unavailable",
                "message": "Agribud not ready — complete the integration setup wizard first.",
            }, 503)

        caches = _get_caches(self._hass)
        cache_key = q.lower()
        if caches is not None:
            cached = caches["search_cache"].get(cache_key)
            if cached:
                ts, results, url_used = cached
                if time.time() - ts < SEARCH_CACHE_TTL_SECONDS:
                    _LOGGER.debug(
                        "Agribud: search '%s' served from cache (%d results)",
                        q, len(results),
                    )
                    return _json({
                        "results": results,
                        "_testing_url": url_used,
                        "_from_cache": True,
                        "_backend_version": _HTTP_API_VERSION,
                    })

        try:
            results_raw, url_used = await api.search_plants(q, state=state)
            cleaned = [
                _normalize_verdantly_variety(r) for r in results_raw if isinstance(r, dict)
            ]
            _LOGGER.warning(
                "Agribud: /search_plants q=%r → %d raw, %d cleaned (URL: %s)",
                q, len(results_raw), len(cleaned), url_used,
            )
            if caches is not None:
                caches["search_cache"][cache_key] = (time.time(), cleaned, url_used)
            return _json({
                "results": cleaned,
                "_testing_url": url_used,
                "_from_cache": False,
                # Backend version marker — lets the card prove which backend
                # actually handled the request. Stale http_api.py files won't
                # set this and the card warns in console.
                "_backend_version": _HTTP_API_VERSION,
            })
        except PerenualAuthError as err:
            _LOGGER.error("Agribud: search auth error: %s", err)
            return _json({"error": "invalid_auth", "message": str(err)}, 401)
        except PerenualRateLimitError as err:
            return _json({"error": "rate_limited", "message": str(err)}, 429)
        except PerenualApiError as err:
            _LOGGER.warning("Agribud: search for '%s' failed: %s", q, err)
            return _json({"error": "api_error", "message": str(err)}, 502)
        except Exception as err:
            _LOGGER.exception("Agribud: unexpected search error for '%s'", q)
            return _json({"error": "unknown", "message": str(err)}, 500)


def _normalize_verdantly_variety(r: dict) -> dict:
    """Normalize one Verdantly variety result into the shape the card expects.

    Verdantly returns rich, deeply-nested plant detail inline in search
    responses — every result already has growingRequirements, growthDetails,
    lifecycleMilestones, species.{commonName,scientificName,taxonomy},
    ecology, safety.toxicity, etc.

    We preserve the FULL nested object (the trading card needs every nested
    field) but ALSO surface a handful of flat top-level keys so the search-
    results grid + add_plant flow can reference simple fields without
    digging through the nesting.
    """
    sp     = r.get("species")             or {}
    gr     = r.get("growingRequirements") or {}
    eco    = r.get("ecology")             or {}

    # Identifier — Verdantly's per-variety UUID. Surface under several names
    # so the card and backend find it whichever they look for.
    variety_id = r.get("id") or ""
    # Variety / cultivar name often differs from the species common name
    # (e.g. variety "Abe Lincoln Original Tomato" vs species "Garden tomato").
    # The variety name is more specific, so it's what we display by default.
    variety_name = r.get("name") or ""
    species_common = sp.get("commonName") or ""
    species_sci    = sp.get("scientificName") or ""

    # Display name: prefer variety > species common > scientific
    display_name = variety_name or species_common or species_sci

    # Build the normalized result — START with the full raw object so every
    # nested field is preserved, then layer the flat aliases on top.
    out = dict(r)
    out.update({
        # Identifier aliases
        "species_id":      variety_id,
        "id":              variety_id,
        "variety_id":      variety_id,
        # Display name (variety name takes precedence)
        "common_name":     display_name,
        "common_names":    [display_name] if display_name else [],
        "variety_name":    variety_name,
        # Scientific name — pulled UP from species.scientificName so the
        # card can read it without digging into the nesting
        "scientific_name": species_sci,
        # Image at top level — Verdantly does have `imageUrl` already, but
        # we also alias under image_url (snake_case) for our own card code.
        "image_url":       r.get("imageUrl") or None,
        # Invasive flag pulled up for the search-result badge
        "invasive_alert":  bool(eco.get("isInvasive")),
        # Light + water surfaced for the add-plant preview info grid
        "light_requirements": gr.get("sunlightRequirement") or "",
        "water_use":          gr.get("waterRequirement")    or "",
        # Hardiness zones — useful even on the search preview
        "hardiness_zone_min": gr.get("minGrowingZone"),
        "hardiness_zone_max": gr.get("maxGrowingZone"),
    })
    return out


# Legacy aliases — older code paths reference these names.
_normalize_apifarmer_species = _normalize_verdantly_variety
_normalize_flora_species     = _normalize_verdantly_variety


class AgribudSpeciesView(HomeAssistantView):
    """Returns full species detail for a known identifier — CACHE ONLY.

    Verdantly returns full plant detail inline in the search response, so
    there is no detail endpoint to call. The card ships `species_data` with
    add_plant and we cache it on the plant record at add-time. This view
    serves from cache and never makes an API call (preserving the user's
    tight 25-call/month free-tier quota).

    Tiered lookup:
      1. In-memory species cache (populated by previous searches)
      2. Existing plants' embedded `species_data`
      3. 404 with a helpful message — re-add the plant if you really need
         to re-fetch its species_data.
    """
    url = "/api/agribud/species/{species_id}"
    name = "api:agribud:species"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request, species_id: str):
        sid = str(species_id)
        caches = _get_caches(self._hass)

        # 1. In-memory cache — populated by previous searches.
        if caches is not None and caches["species_cache"].get(sid):
            _LOGGER.debug("Agribud: species id=%s served from in-memory cache", sid)
            return _json(caches["species_cache"][sid])

        # 2. On-disk plant cache — match by id, variety_id, or scientific name.
        store = _get_store(self._hass)
        if store is not None:
            for plant in store._data["plants"].values():
                psd  = plant.get("species_data") or {}
                pid  = str(plant.get("species_id") or "")
                vid  = str(psd.get("id") or "")
                sp   = psd.get("species") or {}
                psci = str(sp.get("scientificName") or "")
                if (pid == sid or vid == sid or psci == sid) and psd:
                    if caches is not None:
                        caches["species_cache"][sid] = psd
                    _LOGGER.debug(
                        "Agribud: species id=%s served from plant on-disk cache", sid,
                    )
                    return _json(psd)

        # 3. Cache miss. Verdantly has no detail endpoint we could fall back
        # on, and we want to preserve the user's 25-calls/month free-tier
        # quota — so return 404 with a clear explanation rather than burn
        # an API call.
        return _json({
            "error": "not_cached",
            "message": (
                f"No cached species_data for '{sid}'. Verdantly has no "
                "separate detail endpoint, so the card must ship "
                "species_data with add_plant. If this is a legacy plant "
                "from an older provider, remove and re-add it."
            ),
        }, 404)


class AgribudUpdateConfigView(HomeAssistantView):
    url = "/api/agribud/update_config"
    name = "api:agribud:update_config"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def post(self, request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "bad_request", "message": "Invalid JSON body."}, 400)

        entry = _get_entry(self._hass)
        if entry is None:
            return _json({
                "error": "not_configured",
                "message": "No Agribud config entry found.",
            }, 404)

        new_data = dict(entry.data)
        new_options = dict(entry.options)
        changed  = False

        if body.get("weather_entity"):
            # Mirror into BOTH data and options so the integration setup
            # form (reads data) and the options flow (reads options) stay
            # in sync regardless of which surface the user edits from.
            effective_old = entry.options.get(
                CONF_WEATHER_ENTITY,
                new_data.get(CONF_WEATHER_ENTITY, "none"),
            )
            new_value = body["weather_entity"]
            new_data[CONF_WEATHER_ENTITY] = new_value
            new_options[CONF_WEATHER_ENTITY] = new_value
            if effective_old != new_value:
                changed = True
                _LOGGER.info("Agribud: weather entity changed '%s' → '%s'",
                             effective_old, new_value)

        if not changed:
            return _json({"ok": True, "message": "Nothing to update."})

        self._hass.config_entries.async_update_entry(
            entry, data=new_data, options=new_options,
        )
        self._hass.async_create_task(
            self._hass.config_entries.async_reload(entry.entry_id)
        )
        return _json({"ok": True, "message": "Settings saved. Integration is reloading."})


class AgribudPlotsView(HomeAssistantView):
    url = "/api/agribud/plots"
    name = "api:agribud:plots"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        try:
            return _json(store.get_all_plots())
        except Exception as err:
            _LOGGER.exception("Agribud: GET /plots failed unexpectedly")
            return _json({"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500)


class AgribudPlotCreateView(HomeAssistantView):
    """POST /api/agribud/plot_create — create a grow plot.

    Lives on its own URL (not /api/agribud/plots) to avoid aiohttp routing
    edge cases when a static URL shares a prefix with a dynamic one.
    """
    url = "/api/agribud/plot_create"
    name = "api:agribud:plot_create"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def post(self, request):
        _LOGGER.info(
            "Agribud: POST /plot_create entered — content-type=%r remote=%s",
            request.headers.get("Content-Type"), request.remote,
        )
        try:
            raw = await request.text()
        except Exception as err:
            return _json({"error": "bad_request", "message": f"Could not read body: {err}"}, 400)
        if not raw or not raw.strip():
            return _json({"error": "bad_request", "message": "Empty request body."}, 400)
        try:
            body = json.loads(raw)
        except Exception as err:
            return _json({"error": "bad_request", "message": f"Invalid JSON: {err}"}, 400)
        if not isinstance(body, dict):
            return _json({"error": "bad_request", "message": "Body must be a JSON object."}, 400)
        name = (body.get("name") or "").strip()
        if not name:
            return _json({"error": "missing_name", "message": "Plot name is required."}, 400)
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        try:
            plot = await store.async_add_plot(
                name=name,
                description=str(body.get("description", "") or ""),
            )
            coord = _get_coordinator(self._hass)
            if coord:
                await coord.async_request_refresh()
            return _json({"ok": True, "plot": plot})
        except Exception as err:
            _LOGGER.exception("Agribud: POST /plot_create failed")
            return _json({"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500)


class AgribudPlotView(HomeAssistantView):
    url = "/api/agribud/plots/{plot_id}"
    name = "api:agribud:plot"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request, plot_id: str):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        plot = store.get_plot(plot_id)
        if plot is None:
            return _json({"error": "not_found", "message": "Grow plot not found."}, 404)
        return _json(plot)

    async def put(self, request, plot_id: str):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "bad_request", "message": "Invalid JSON."}, 400)
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        plot = await store.async_update_plot(plot_id, **{
            k: v for k, v in body.items() if k in {"name", "description"}
        })
        if plot is None:
            return _json({"error": "not_found"}, 404)
        coord = _get_coordinator(self._hass)
        if coord:
            await coord.async_request_refresh()
        return _json({"ok": True, "plot": plot})

    async def delete(self, request, plot_id: str):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        ok = await store.async_remove_plot(plot_id)
        if not ok:
            return _json({"error": "not_found"}, 404)
        coord = _get_coordinator(self._hass)
        if coord:
            await coord.async_request_refresh()
        return _json({"ok": True})


class AgribudWeatherLogView(HomeAssistantView):
    """GET /api/agribud/weather_log — per-date rain/snow/frost observations.

    Returns: {"YYYY-MM-DD": {"rain": bool, "snow": bool, "frost": bool,
                              "conditions": [str, ...]}, ...}
    Used by the card to draw weather icons in calendar day cells.
    """
    url           = "/api/agribud/weather_log"
    name          = "api:agribud:weather_log"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        try:
            log = store.get_weather_log()
            _LOGGER.debug("Agribud: GET /weather_log returning %d entries", len(log))
            return _json(log)
        except Exception as err:
            _LOGGER.exception("Agribud: GET /weather_log failed unexpectedly")
            return _json({"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500)


class AgribudDeletedSpeciesView(HomeAssistantView):
    """GET /api/agribud/deleted_species — list cached species_data from
    soft-deleted plants.

    Used by the card's "Recent Plants" strip to surface previously-grown
    species so the user can re-add them at zero API cost. Records are
    kept for 6 months after deletion; older entries are pruned at load.

    Response: {"results": [<raw Verdantly variety object>, ...]}
    Items are deduped by scientific name and sorted by most-recently-
    deleted first.
    """
    url           = "/api/agribud/deleted_species"
    name          = "api:agribud:deleted_species"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        try:
            results = store.get_deleted_species_cache()
            _LOGGER.debug(
                "Agribud: GET /deleted_species returning %d cached species",
                len(results),
            )
            return _json({"results": results, "count": len(results)})
        except Exception as err:
            _LOGGER.exception("Agribud: GET /deleted_species failed unexpectedly")
            return _json({"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500)


class AgribudSeasonView(HomeAssistantView):
    """GET /api/agribud/season — list every plant the user has ever started,
    grouped by season+year of start_date.

    Returns a flat array of slim plant records (the card groups them
    client-side). Each item is shaped:
      {id, name, start_date, end_date, end_status, events[], archived}
    where end_status is "growing" | "harvested" | "dead" | "removed".

    Used by the season-calendar view to show historical plantings even
    after the 6-month species-cache window has expired and the full plant
    record was archived to a slim history-only form.
    """
    url           = "/api/agribud/season"
    name          = "api:agribud:season"
    requires_auth = True

    def __init__(self, hass): self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribud not loaded."}, 503)
        try:
            results = store.get_season_view()
            _LOGGER.debug("Agribud: GET /season returning %d items", len(results))
            return _json({"results": results, "count": len(results)})
        except Exception as err:
            _LOGGER.exception("Agribud: GET /season failed unexpectedly")
            return _json({"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500)
