"""Custom HTTP endpoints for Agribuddy card communication.

Endpoints:
  GET  /api/agribuddy/status                — integration health and masked config
  GET  /api/agribuddy/test_connection       — verifies stored Verdantly key
  GET  /api/agribuddy/search_plants?q=...   — Verdantly species-list search
  GET  /api/agribuddy/species/<id>          — Verdantly species detail
  POST /api/agribuddy/update_config         — update weather entity, reload integration
  GET  /api/agribuddy/plots                 — list grow plots
  POST /api/agribuddy/plot_create           — create a grow plot
  GET  /api/agribuddy/plots/<plot_id>       — fetch one plot
  PUT  /api/agribuddy/plots/<plot_id>       — update plot name/description
  DELETE /api/agribuddy/plots/<plot_id>     — remove plot
"""

from __future__ import annotations

import json
import logging
import time

from aiohttp.web import Response
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .api import (
    VerdantlyApiClient,
    VerdantlyApiError,
    VerdantlyAuthError,
    VerdantlyConnectionError,
    VerdantlyRateLimitError,
)
from .const import (
    CONF_API_KEY,
    CONF_LAYOUT,
    CONF_WEATHER_ENTITY,
    CONF_ZONE_HIGH,
    CONF_ZONE_LOW,
    DEFAULT_LAYOUT,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

_HTTP_API_VERSION = "1.2.3"


def async_register_views(hass: HomeAssistant) -> None:
    """Register all Agribuddy HTTP views.

    Each view is registered in its own try/except so a single failure doesn't
    prevent later views from registering. Logs at WARNING level so the output
    is visible regardless of how the user has configured logging.
    """
    _LOGGER.warning(
        "Agribuddy: async_register_views called — http_api version %s",
        _HTTP_API_VERSION,
    )
    views = [
        ("AgribuddyStatusView", AgribuddyStatusView),
        ("AgribuddyTestConnectionView", AgribuddyTestConnectionView),
        ("AgribuddySearchView", AgribuddySearchView),
        ("AgribuddySpeciesView", AgribuddySpeciesView),
        ("AgribuddyBackfillView", AgribuddyBackfillView),
        ("AgribuddyUpdateConfigView", AgribuddyUpdateConfigView),
        ("AgribuddyPlotsView", AgribuddyPlotsView),
        ("AgribuddyPlotCreateView", AgribuddyPlotCreateView),
        ("AgribuddyPlotView", AgribuddyPlotView),
        ("AgribuddyWeatherLogView", AgribuddyWeatherLogView),
        ("AgribuddyDeletedSpeciesView", AgribuddyDeletedSpeciesView),
        ("AgribuddySeasonView", AgribuddySeasonView),
    ]
    successes, failures = [], []
    for name, cls in views:
        try:
            hass.http.register_view(cls(hass))
            successes.append(f"{name} → {cls.url}")
        except Exception as err:
            failures.append(f"{name} → {cls.url}: {type(err).__name__}: {err}")
            _LOGGER.exception(
                "Agribuddy: register_view(%s) failed for url=%s — %s: %s",
                name,
                cls.url,
                type(err).__name__,
                err,
            )
    _LOGGER.warning(
        "Agribuddy: HTTP view registration done — %d succeeded, %d failed.\n"
        "  Successes:\n    %s\n  Failures:\n    %s",
        len(successes),
        len(failures),
        "\n    ".join(successes) if successes else "(none)",
        "\n    ".join(failures) if failures else "(none)",
    )


def _json(data, status=200):

    return Response(
        status=status, content_type="application/json", text=json.dumps(data)
    )


def _get_api(hass: HomeAssistant) -> VerdantlyApiClient | None:
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


class AgribuddyStatusView(HomeAssistantView):
    """GET /api/agribuddy/status — integration health snapshot."""

    url = "/api/agribuddy/status"
    name = "api:agribuddy:status"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        entry = _get_entry(self._hass)
        if entry is None:
            return _json(
                {
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
                }
            )
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
            _LOGGER.debug("Agribuddy: status — could not read usage tracker: %s", err)
        payload = {
            "configured": True,
            "api_provider": "verdantly",
            "api_key_masked": "set" if api_key else "not set",
            "weather_entity": entry.options.get(
                CONF_WEATHER_ENTITY, entry.data.get(CONF_WEATHER_ENTITY, "not set")
            ),
            # v1.2.0 — user-entered hardiness zone range (options-first, with
            # data fallback). The card renders "Zone {low}–{high}" or "Zone –".
            "hardiness_zone_low": entry.options.get(
                CONF_ZONE_LOW, entry.data.get(CONF_ZONE_LOW, "")
            ),
            "hardiness_zone_high": entry.options.get(
                CONF_ZONE_HIGH, entry.data.get(CONF_ZONE_HIGH, "")
            ),
            # v1.2.2 — persisted card layout ("landscape"/"portrait").
            "card_layout": entry.options.get(
                CONF_LAYOUT, entry.data.get(CONF_LAYOUT, DEFAULT_LAYOUT)
            ),
            "api_client_ready": api_ready,
            "http_api_version": _HTTP_API_VERSION,
            "rate_limit_note": (
                "Verdantly Gardening API (via RapidAPI). FREE TIER: 25 calls "
                "per MONTH only — search cache is held 30 days to minimize "
                "usage. Each unique plant search costs 1 call; opening an "
                "added plant's card costs 0 calls (cached on plant record)."
            ),
            "monthly_quota": 25,
            "usage": usage_payload,
            "message": (
                "API client is ready."
                if api_ready
                else "Config entry exists but API client is not loaded — check HA logs."
            ),
        }
        if is_admin:
            payload["api_key_length"] = len(api_key)
            payload["entry_id"] = entry.entry_id
        return _json(payload)


class AgribuddyTestConnectionView(HomeAssistantView):
    """GET /api/agribuddy/test_connection — live Verdantly key test (costs 1 API call against the 25/month quota)."""

    url = "/api/agribuddy/test_connection"
    name = "api:agribuddy:test_connection"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        api = _get_api(self._hass)
        if api is None:
            return _json(
                {
                    "ok": False,
                    "error": "not_configured",
                    "message": (
                        "Agribuddy is not set up. Go to "
                        "Settings → Integrations → Add Integration → Agribuddy."
                    ),
                },
                404,
            )
        try:
            await api.validate()
            _LOGGER.info("Agribuddy: connection test passed — Verdantly API key is valid")
            return _json(
                {"ok": True, "message": "Verdantly API key is valid and working."}
            )
        except VerdantlyAuthError as err:
            _LOGGER.exception(
                "Agribuddy: connection test — Verdantly rejected key: %s", err
            )
            return _json(
                {
                    "ok": False,
                    "error": "invalid_auth",
                    "message": f"Verdantly rejected the stored key ({err}). Re-run the setup wizard.",
                },
                401,
            )
        except VerdantlyRateLimitError as err:
            _LOGGER.warning("Agribuddy: connection test — rate limit hit: %s", err)
            return _json(
                {
                    "ok": False,
                    "error": "rate_limited",
                    "message": str(err),
                },
                429,
            )
        except VerdantlyConnectionError as err:
            _LOGGER.exception(
                "Agribuddy: connection test — cannot reach Verdantly: %s", err
            )
            return _json(
                {
                    "ok": False,
                    "error": "cannot_connect",
                    "message": f"Cannot reach Verdantly: {err}. Check your internet connection.",
                },
                502,
            )
        except VerdantlyApiError as err:
            _LOGGER.exception("Agribuddy: connection test — Verdantly API error: %s", err)
            return _json({"ok": False, "error": "api_error", "message": str(err)}, 502)
        except Exception as err:
            _LOGGER.exception("Agribuddy: connection test — unexpected error")
            return _json(
                {
                    "ok": False,
                    "error": "unknown",
                    "message": f"Unexpected error: {type(err).__name__}: {err}",
                },
                500,
            )


class AgribuddySearchView(HomeAssistantView):
    url = "/api/agribuddy/search_plants"
    name = "api:agribuddy:search_plants"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        q = request.rel_url.query.get("q", "").strip()
        # APIFarmer doesn't support a state filter — older cards may still send
        # the param. We accept it for compat but ignore it. The cache key
        # likewise no longer includes state.
        state_raw = request.rel_url.query.get("state", "").strip().upper()
        if state_raw:
            _LOGGER.debug(
                "Agribuddy: search received state=%r — ignored (APIFarmer has no state filter)",
                state_raw,
            )
        state = None  # Always None for APIFarmer

        if not q:
            return _json(
                {"error": "missing_query", "message": "Provide a ?q= search term."}, 400
            )
        api = _get_api(self._hass)
        if api is None:
            return _json(
                {
                    "error": "api_unavailable",
                    "message": "Agribuddy not ready — complete the integration setup wizard first.",
                },
                503,
            )

        caches = _get_caches(self._hass)
        cache_key = q.lower()
        if caches is not None:
            cached = caches["search_cache"].get(cache_key)
            if cached:
                ts, results, url_used = cached
                if time.time() - ts < SEARCH_CACHE_TTL_SECONDS:
                    _LOGGER.debug(
                        "Agribuddy: search '%s' served from cache (%d results)",
                        q,
                        len(results),
                    )
                    return _json(
                        {
                            "results": results,
                            "_testing_url": url_used,
                            "_from_cache": True,
                            "_backend_version": _HTTP_API_VERSION,
                        }
                    )

        try:
            results_raw, url_used = await api.search_plants(q, state=state)
            cleaned = [
                _normalize_verdantly_variety(r)
                for r in results_raw
                if isinstance(r, dict)
            ]
            _LOGGER.warning(
                "Agribuddy: /search_plants q=%r → %d raw, %d cleaned (URL: %s)",
                q,
                len(results_raw),
                len(cleaned),
                url_used,
            )
            if caches is not None:
                caches["search_cache"][cache_key] = (time.time(), cleaned, url_used)
            return _json(
                {
                    "results": cleaned,
                    "_testing_url": url_used,
                    "_from_cache": False,
                    # Backend version marker — lets the card prove which backend
                    # actually handled the request. Stale http_api.py files won't
                    # set this and the card warns in console.
                    "_backend_version": _HTTP_API_VERSION,
                }
            )
        except VerdantlyAuthError as err:
            _LOGGER.exception("Agribuddy: search auth error: %s", err)
            return _json({"error": "invalid_auth", "message": str(err)}, 401)
        except VerdantlyRateLimitError as err:
            return _json({"error": "rate_limited", "message": str(err)}, 429)
        except VerdantlyApiError as err:
            _LOGGER.warning("Agribuddy: search for '%s' failed: %s", q, err)
            return _json({"error": "api_error", "message": str(err)}, 502)
        except Exception as err:
            _LOGGER.exception("Agribuddy: unexpected search error for '%s'", q)
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
    sp = r.get("species") or {}
    gr = r.get("growingRequirements") or {}
    eco = r.get("ecology") or {}

    # Identifier — Verdantly's per-variety UUID. Surface under several names
    # so the card and backend find it whichever they look for.
    variety_id = r.get("id") or ""
    # Variety / cultivar name often differs from the species common name
    # (e.g. variety "Abe Lincoln Original Tomato" vs species "Garden tomato").
    # The variety name is more specific, so it's what we display by default.
    variety_name = r.get("name") or ""
    species_common = sp.get("commonName") or ""
    species_sci = sp.get("scientificName") or ""

    # Display name: prefer variety > species common > scientific
    display_name = variety_name or species_common or species_sci

    # Build the normalized result — START with the full raw object so every
    # nested field is preserved, then layer the flat aliases on top.
    out = dict(r)
    out.update(
        {
            # Identifier aliases
            "species_id": variety_id,
            "id": variety_id,
            "variety_id": variety_id,
            # Display name (variety name takes precedence)
            "common_name": display_name,
            "common_names": [display_name] if display_name else [],
            "variety_name": variety_name,
            # Scientific name — pulled UP from species.scientificName so the
            # card can read it without digging into the nesting
            "scientific_name": species_sci,
            # Image at top level — Verdantly does have `imageUrl` already, but
            # we also alias under image_url (snake_case) for our own card code.
            "image_url": r.get("imageUrl") or None,
            # Invasive flag pulled up for the search-result badge
            "invasive_alert": bool(eco.get("isInvasive")),
            # Light + water surfaced for the add-plant preview info grid
            "light_requirements": gr.get("sunlightRequirement") or "",
            "water_use": gr.get("waterRequirement") or "",
            # Hardiness zones — useful even on the search preview
            "hardiness_zone_min": gr.get("minGrowingZone"),
            "hardiness_zone_max": gr.get("maxGrowingZone"),
            # v1.2.0 — fields the radar chart + care dropdowns consume. These
            # come from the richer /name endpoint. Surfaced flat so the card
            # doesn't have to dig, but the full nested object is preserved in
            # `out` (= dict(r)) too, which is what gets cached as species_data.
            "growing_zone_range": gr.get("growingZoneRange") or "",
            "mature_height": (r.get("growthDetails") or {}).get("matureHeight"),
            "mature_height_unit": (r.get("growthDetails") or {}).get("unit") or "",
            "growth_type": (r.get("growthDetails") or {}).get("growthType") or "",
            "growth_period": (r.get("growthDetails") or {}).get("growthPeriod") or "",
        }
    )
    return out


# Legacy aliases — older code paths reference these names.
_normalize_apifarmer_species = _normalize_verdantly_variety
_normalize_flora_species = _normalize_verdantly_variety


class AgribuddySpeciesView(HomeAssistantView):
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

    url = "/api/agribuddy/species/{species_id}"
    name = "api:agribuddy:species"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request, species_id: str):
        sid = str(species_id)
        caches = _get_caches(self._hass)

        # 1. In-memory cache — populated by previous searches.
        if caches is not None and caches["species_cache"].get(sid):
            _LOGGER.debug("Agribuddy: species id=%s served from in-memory cache", sid)
            return _json(caches["species_cache"][sid])

        # 2. On-disk plant cache — match by id, variety_id, or scientific name.
        store = _get_store(self._hass)
        if store is not None:
            for plant in store._data["plants"].values():  # noqa: SLF001
                psd = plant.get("species_data") or {}
                pid = str(plant.get("species_id") or "")
                vid = str(psd.get("id") or "")
                sp = psd.get("species") or {}
                psci = str(sp.get("scientificName") or "")
                if (sid in (pid, vid, psci)) and psd:
                    if caches is not None:
                        caches["species_cache"][sid] = psd
                    _LOGGER.debug(
                        "Agribuddy: species id=%s served from plant on-disk cache",
                        sid,
                    )
                    return _json(psd)

        # 3. Cache miss. Verdantly has no detail endpoint we could fall back
        # on, and we want to preserve the user's 25-calls/month free-tier
        # quota — so return 404 with a clear explanation rather than burn
        # an API call.
        return _json(
            {
                "error": "not_cached",
                "message": (
                    f"No cached species_data for '{sid}'. Verdantly has no "
                    "separate detail endpoint, so the card must ship "
                    "species_data with add_plant. If this is a legacy plant "
                    "from an older provider, remove and re-add it."
                ),
            },
            404,
        )


def _species_data_is_stale(sd: dict) -> bool:
    """True if a plant's cached species_data lacks the richer fields the
    v1.2.0 radar chart + care dropdowns need.

    Plants added before v1.2.0 came from the /search endpoint, which didn't
    return the top-level careInstructions object or growthDetails.matureHeight/
    growthType. We detect "old shape" by the absence of those fields and let
    the card trigger a one-time lazy backfill from /name.
    """
    if not sd:
        return False  # nothing to refresh (no cached data at all)
    # Custom (user-created) plants have no Verdantly counterpart to backfill
    # from — their data is whatever the user entered. Never mark them stale,
    # or the card would fire a pointless backfill that can't succeed.
    if sd.get("is_custom"):
        return False
    care = sd.get("careInstructions")
    gd = sd.get("growthDetails") or {}
    has_care_obj = isinstance(care, dict) and bool(care)
    has_growth = gd.get("matureHeight") is not None or bool(gd.get("growthType"))
    return not (has_care_obj or has_growth)


class AgribuddyBackfillView(HomeAssistantView):
    """Lazy, on-demand refresh of one plant's species_data from the richer
    /name endpoint.

    v1.2.0 switched the search endpoint to /v1/plants/varieties/name, which
    carries fields the radar chart + care dropdowns need. Plants added under
    earlier versions have stale species_data. Rather than a mass refresh
    (which could blow the 25-call/month quota), the card calls this endpoint
    the first time it opens a plant whose cached data is stale. It costs ONE
    API call, only for that plant, only once (afterwards the data is no longer
    stale so the card won't ask again).

    POST body: {"plant_id": "<uuid>"}
    Returns: {"refreshed": bool, "species_data": {...}} or an error.
    """

    url = "/api/agribuddy/backfill_species"
    name = "api:agribuddy:backfill_species"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def post(self, request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "bad_json", "message": "Invalid JSON body."}, 400)
        plant_id = str((body or {}).get("plant_id") or "").strip()
        if not plant_id:
            return _json(
                {"error": "missing_plant_id", "message": "Provide plant_id."}, 400
            )

        store = _get_store(self._hass)
        api = _get_api(self._hass)
        if store is None or api is None:
            return _json(
                {"error": "api_unavailable", "message": "Agribuddy not ready."}, 503
            )

        plant = store._data["plants"].get(plant_id)  # noqa: SLF001
        if not plant:
            return _json(
                {"error": "not_found", "message": f"No plant {plant_id}."}, 404
            )

        sd = plant.get("species_data") or {}
        # Guard: only spend an API call if the data is actually stale. The card
        # also checks, but double-checking here prevents a misbehaving caller
        # from burning quota.
        if not _species_data_is_stale(sd):
            return _json({"refreshed": False, "species_data": sd, "reason": "fresh"})

        # Re-search by the plant's display/variety name and pick the best match
        # (prefer an exact id match, then exact name, else the first result).
        query = (
            plant.get("name")
            or sd.get("name")
            or (sd.get("species") or {}).get("commonName")
            or ""
        ).strip()
        if not query:
            return _json(
                {"error": "no_query", "message": "Plant has no name to search by."},
                422,
            )

        try:
            results_raw, _url = await api.search_plants(query)
        except VerdantlyAuthError as err:
            return _json({"error": "invalid_auth", "message": str(err)}, 401)
        except VerdantlyRateLimitError as err:
            return _json({"error": "rate_limited", "message": str(err)}, 429)
        except VerdantlyApiError as err:
            return _json({"error": "api_error", "message": str(err)}, 502)
        except Exception as err:
            _LOGGER.exception("Agribuddy: backfill search failed for %s", plant_id)
            return _json({"error": "unknown", "message": str(err)}, 500)

        results = [r for r in (results_raw or []) if isinstance(r, dict)]
        if not results:
            return _json(
                {"error": "no_results", "message": f"No matches for '{query}'."}, 404
            )

        want_id = str(plant.get("species_id") or sd.get("id") or "")
        chosen = None
        if want_id:
            chosen = next((r for r in results if str(r.get("id")) == want_id), None)
        if chosen is None:
            chosen = next(
                (
                    r
                    for r in results
                    if (r.get("name") or "").strip().lower() == query.lower()
                ),
                None,
            )
        if chosen is None:
            chosen = results[0]

        normalized = _normalize_verdantly_variety(chosen)
        await store.async_update_plant(plant_id, species_data=normalized)
        caches = _get_caches(self._hass)
        if caches is not None and normalized.get("id"):
            caches["species_cache"][str(normalized["id"])] = normalized
        _LOGGER.info(
            "Agribuddy: backfilled species_data for plant %s from /name", plant_id
        )
        return _json({"refreshed": True, "species_data": normalized})


class AgribuddyUpdateConfigView(HomeAssistantView):
    url = "/api/agribuddy/update_config"
    name = "api:agribuddy:update_config"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def post(self, request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "bad_request", "message": "Invalid JSON body."}, 400)

        entry = _get_entry(self._hass)
        if entry is None:
            return _json(
                {
                    "error": "not_configured",
                    "message": "No Agribuddy config entry found.",
                },
                404,
            )

        new_data = dict(entry.data)
        new_options = dict(entry.options)
        changed = False
        # Track whether a reload is actually required. Weather-entity changes
        # need a reload (the coordinator re-resolves the entity); zone changes
        # are display-only and don't, so we avoid the disruptive reload for
        # zone-only edits.
        needs_reload = False

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
                needs_reload = True
                _LOGGER.info(
                    "Agribuddy: weather entity changed '%s' → '%s'",
                    effective_old,
                    new_value,
                )

        # v1.2.0 — hardiness zone range (two free-text values). Either may be
        # present in the body; an empty string is a valid "cleared" value, so
        # we check membership, not truthiness. Mirrored into data + options
        # like the weather entity. No reload needed (display-only).
        for key in (CONF_ZONE_LOW, CONF_ZONE_HIGH):
            if key in body:
                new_value = str(body.get(key) or "").strip()
                effective_old = entry.options.get(
                    key, new_data.get(key, "")
                )
                new_data[key] = new_value
                new_options[key] = new_value
                if effective_old != new_value:
                    changed = True

        # v1.2.2 — card layout ("landscape"/"portrait"). No reload (display-only).
        if CONF_LAYOUT in body:
            lay = str(body.get(CONF_LAYOUT) or "").strip().lower()
            if lay not in ("landscape", "portrait"):
                lay = DEFAULT_LAYOUT
            effective_old = entry.options.get(
                CONF_LAYOUT, new_data.get(CONF_LAYOUT, DEFAULT_LAYOUT)
            )
            new_data[CONF_LAYOUT] = lay
            new_options[CONF_LAYOUT] = lay
            if effective_old != lay:
                changed = True

        if not changed:
            return _json({"ok": True, "message": "Nothing to update."})

        self._hass.config_entries.async_update_entry(
            entry,
            data=new_data,
            options=new_options,
        )
        if needs_reload:
            self._hass.async_create_task(
                self._hass.config_entries.async_reload(entry.entry_id)
            )
            return _json(
                {"ok": True, "message": "Settings saved. Integration is reloading."}
            )
        return _json({"ok": True, "message": "Settings saved."})


class AgribuddyPlotsView(HomeAssistantView):
    url = "/api/agribuddy/plots"
    name = "api:agribuddy:plots"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        try:
            return _json(store.get_all_plots())
        except Exception as err:
            _LOGGER.exception("Agribuddy: GET /plots failed unexpectedly")
            return _json(
                {"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500
            )


class AgribuddyPlotCreateView(HomeAssistantView):
    """POST /api/agribuddy/plot_create — create a grow plot.

    Lives on its own URL (not /api/agribuddy/plots) to avoid aiohttp routing
    edge cases when a static URL shares a prefix with a dynamic one.
    """

    url = "/api/agribuddy/plot_create"
    name = "api:agribuddy:plot_create"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def post(self, request):
        _LOGGER.info(
            "Agribuddy: POST /plot_create entered — content-type=%r remote=%s",
            request.headers.get("Content-Type"),
            request.remote,
        )
        try:
            raw = await request.text()
        except Exception as err:
            return _json(
                {"error": "bad_request", "message": f"Could not read body: {err}"}, 400
            )
        if not raw or not raw.strip():
            return _json(
                {"error": "bad_request", "message": "Empty request body."}, 400
            )
        try:
            body = json.loads(raw)
        except Exception as err:
            return _json(
                {"error": "bad_request", "message": f"Invalid JSON: {err}"}, 400
            )
        if not isinstance(body, dict):
            return _json(
                {"error": "bad_request", "message": "Body must be a JSON object."}, 400
            )
        name = (body.get("name") or "").strip()
        if not name:
            return _json(
                {"error": "missing_name", "message": "Plot name is required."}, 400
            )
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
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
            _LOGGER.exception("Agribuddy: POST /plot_create failed")
            return _json(
                {"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500
            )


class AgribuddyPlotView(HomeAssistantView):
    url = "/api/agribuddy/plots/{plot_id}"
    name = "api:agribuddy:plot"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request, plot_id: str):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
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
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        plot = await store.async_update_plot(
            plot_id,
            **{k: v for k, v in body.items() if k in {"name", "description", "indoor"}},
        )
        if plot is None:
            return _json({"error": "not_found"}, 404)
        coord = _get_coordinator(self._hass)
        if coord:
            await coord.async_request_refresh()
        # Notify the card so the plot view re-renders with the new indoor flag.
        self._hass.bus.async_fire(f"{DOMAIN}_data_changed", {})
        return _json({"ok": True, "plot": plot})

    async def delete(self, request, plot_id: str):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        ok = await store.async_remove_plot(plot_id)
        if not ok:
            return _json({"error": "not_found"}, 404)
        coord = _get_coordinator(self._hass)
        if coord:
            await coord.async_request_refresh()
        return _json({"ok": True})


class AgribuddyWeatherLogView(HomeAssistantView):
    """GET /api/agribuddy/weather_log — per-date rain/snow/frost observations.

    Returns: {"YYYY-MM-DD": {"rain": bool, "snow": bool, "frost": bool,
                              "conditions": [str, ...]}, ...}
    Used by the card to draw weather icons in calendar day cells.
    """

    url = "/api/agribuddy/weather_log"
    name = "api:agribuddy:weather_log"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        try:
            log = store.get_weather_log()
            _LOGGER.debug("Agribuddy: GET /weather_log returning %d entries", len(log))
            return _json(log)
        except Exception as err:
            _LOGGER.exception("Agribuddy: GET /weather_log failed unexpectedly")
            return _json(
                {"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500
            )


class AgribuddyDeletedSpeciesView(HomeAssistantView):
    """GET /api/agribuddy/deleted_species — list cached species_data from
    soft-deleted plants.

    Used by the card's "Recent Plants" strip to surface previously-grown
    species so the user can re-add them at zero API cost. Records are
    kept for 6 months after deletion; older entries are pruned at load.

    Response: {"results": [<raw Verdantly variety object>, ...]}
    Items are deduped by scientific name and sorted by most-recently-
    deleted first.
    """

    url = "/api/agribuddy/deleted_species"
    name = "api:agribuddy:deleted_species"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        try:
            results = store.get_deleted_species_cache()
            _LOGGER.debug(
                "Agribuddy: GET /deleted_species returning %d cached species",
                len(results),
            )
            return _json({"results": results, "count": len(results)})
        except Exception as err:
            _LOGGER.exception("Agribuddy: GET /deleted_species failed unexpectedly")
            return _json(
                {"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500
            )


class AgribuddySeasonView(HomeAssistantView):
    """GET /api/agribuddy/season — list every plant the user has ever started,
    grouped by season+year of start_date.

    Returns a flat array of slim plant records (the card groups them
    client-side). Each item is shaped:
      {id, name, start_date, end_date, end_status, events[], archived}
    where end_status is "growing" | "harvested" | "dead" | "removed".

    Used by the season-calendar view to show historical plantings even
    after the 6-month species-cache window has expired and the full plant
    record was archived to a slim history-only form.
    """

    url = "/api/agribuddy/season"
    name = "api:agribuddy:season"
    requires_auth = True

    def __init__(self, hass):
        self._hass = hass

    async def get(self, request):
        store = _get_store(self._hass)
        if store is None:
            return _json({"error": "not_ready", "message": "Agribuddy not loaded."}, 503)
        try:
            results = store.get_season_view()
            _LOGGER.debug("Agribuddy: GET /season returning %d items", len(results))
            return _json({"results": results, "count": len(results)})
        except Exception as err:
            _LOGGER.exception("Agribuddy: GET /season failed unexpectedly")
            return _json(
                {"error": "internal", "message": f"{type(err).__name__}: {err}"}, 500
            )
