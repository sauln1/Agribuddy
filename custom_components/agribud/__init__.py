"""Agribud integration setup."""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    PerenualApiClient, PerenualAuthError, PerenualConnectionError,
    PerenualApiError, PerenualRateLimitError,
)
from .api_usage import ApiUsageTracker
from .const import (
    DOMAIN, CONF_API_KEY, CONF_WEATHER_ENTITY,
    CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL,
    SERVICE_ADD_PLANT, SERVICE_REMOVE_PLANT, SERVICE_LOG_EVENT, SERVICE_REMOVE_EVENT,
    SERVICE_UPDATE_OVERRIDES, SERVICE_UPDATE_PLANT,
    ATTR_PLANT_ID, ATTR_PLANT_NAME, ATTR_SPECIES_ID,
    ATTR_START_TYPE, ATTR_START_DATE, ATTR_LOCATION,
    ATTR_EVENT_ID, ATTR_EVENT_TYPE, ATTR_EVENT_NOTE, ATTR_EVENT_DATE,
    MANUAL_EVENT_TYPES, START_TYPES,
    EVENT_PLANTED,
)
from .coordinator import AgribudCoordinator
from .http_api import async_register_views
from .store import PlantStore

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


# ── Service schemas ───────────────────────────────────────────────────────────

_ADD_PLANT_SCHEMA = vol.Schema({
    vol.Required(ATTR_PLANT_NAME): cv.string,
    vol.Required(ATTR_SPECIES_ID): vol.Any(cv.string, vol.Coerce(int)),
    vol.Optional(ATTR_START_TYPE, default="seed"): vol.In(START_TYPES),
    vol.Optional(ATTR_START_DATE): cv.date,
    vol.Optional(ATTR_LOCATION, default=""): cv.string,
    vol.Optional("plot_id"): cv.string,
    # Optional pre-fetched species detail. When the card already has the full
    # APIFarmer response (from the search call), it includes it here so the backend
    # doesn't need to make any additional API call to cache the species.
    vol.Optional("species_data"): dict,
})

_REMOVE_PLANT_SCHEMA = vol.Schema({vol.Required(ATTR_PLANT_ID): cv.string})

_LOG_EVENT_SCHEMA = vol.Schema({
    vol.Required(ATTR_PLANT_ID): cv.string,
    vol.Required(ATTR_EVENT_TYPE): vol.In(MANUAL_EVENT_TYPES),
    vol.Optional(ATTR_EVENT_NOTE, default=""): cv.string,
    vol.Optional(ATTR_EVENT_DATE): cv.date,
})

_REMOVE_EVENT_SCHEMA = vol.Schema({
    vol.Required(ATTR_PLANT_ID): cv.string,
    vol.Required(ATTR_EVENT_ID): cv.string,
})

_UPDATE_OVERRIDES_SCHEMA = vol.Schema({
    vol.Required(ATTR_PLANT_ID): cv.string,
    # Dict of display-field overrides. Empty string for a key removes that
    # override (falls back to APIFarmer's value). None / missing keys are ignored.
    vol.Required("overrides"): dict,
})

# ── update_plant: edit the core plant record (display name, start date,
# location, etc.) — distinct from update_plant_overrides which only edits
# species_data display fields. All ATTR_* fields are optional; only those
# supplied get updated. The card's "Plant settings" overlay calls this.
_UPDATE_PLANT_SCHEMA = vol.Schema({
    vol.Required(ATTR_PLANT_ID): cv.string,
    vol.Optional(ATTR_PLANT_NAME): cv.string,
    vol.Optional(ATTR_START_TYPE): vol.In(START_TYPES),
    vol.Optional(ATTR_START_DATE): cv.date,
    vol.Optional(ATTR_LOCATION): cv.string,
    vol.Optional("plot_id"): vol.Any(cv.string, None),
})


# ── Lifecycle ─────────────────────────────────────────────────────────────────

async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    async_register_views(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    session = async_get_clientsession(hass)
    # IMPORTANT: Verdantly's free tier on RapidAPI allows only 25 calls per
    # MONTH. Calling api.validate() on every HA startup would burn one call
    # against the quota each time the user reboots — quickly draining their
    # budget. We skip startup validation entirely. The first real search
    # will surface any auth issue with a clear error to the user.
    tracker = ApiUsageTracker(hass)
    await tracker.async_load()
    api = PerenualApiClient(
        entry.data[CONF_API_KEY], session,
        on_request=lambda endpoint: tracker.record(),
    )
    _LOGGER.info(
        "Agribud: API client initialized (validation skipped to preserve "
        "the 25-call/month Verdantly quota). Monthly calls used so far: %d",
        tracker.current_count(),
    )

    store = PlantStore(hass)
    await store.async_load()

    update_min = entry.options.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL)
    # Weather entity may be edited via the options flow (entry.options) OR
    # the integration's setup wizard (entry.data). options-first so changes
    # made in Settings → Devices & Services → Agribud → Configure take
    # effect on the next reload; falls back to data for the initial setup
    # value or when options haven't been touched.
    weather_entity = entry.options.get(
        CONF_WEATHER_ENTITY, entry.data.get(CONF_WEATHER_ENTITY, ""),
    )
    coord = AgribudCoordinator(
        hass, api, store,
        weather_entity=weather_entity,
        update_interval_minutes=update_min,
    )
    await coord.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = {
        "api":         api,
        "store":       store,
        "coordinator": coord,
        "usage":       tracker,
        # In-memory caches to minimize Verdantly API calls. The species
        # cache is also mirrored on disk per-plant inside the store so
        # plants always have their data even after a restart.
        "species_cache": {},   # species_id (str) → full detail dict
        "search_cache":  {},   # query (str)     → (timestamp, results list)
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_services(hass)
    entry.async_on_unload(entry.add_update_listener(_options_updated))
    _LOGGER.info("Agribud: setup complete (entry_id=%s)", entry.entry_id)
    return True


async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return ok


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_store(hass: HomeAssistant) -> PlantStore | None:
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "store" in v:
            return v["store"]
    return None


def _get_api(hass: HomeAssistant) -> PerenualApiClient | None:
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "api" in v:
            return v["api"]
    return None


def _get_caches(hass: HomeAssistant) -> dict | None:
    """Return the integration's in-memory caches dict, or None if not set up.

    Caches are { 'species_cache': {id: detail}, 'search_cache': {q: (ts, results)} }.
    """
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "species_cache" in v:
            return v
    return None


async def _refresh_all(hass: HomeAssistant) -> None:
    """Force an immediate, awaited coordinator refresh so HA state attributes
    update before the bus event fires."""
    for v in hass.data.get(DOMAIN, {}).values():
        if isinstance(v, dict) and "coordinator" in v:
            await v["coordinator"].async_refresh()


def _fire_data_changed(hass: HomeAssistant, kind: str, **extra) -> None:
    """Fire a bus event so the Lovelace card can react immediately."""
    payload = {"kind": kind, **extra}
    hass.bus.async_fire(f"{DOMAIN}_data_changed", payload)
    _LOGGER.debug("Agribud: fired %s_data_changed kind=%s", DOMAIN, kind)


def _service_unavailable_notification(hass: HomeAssistant) -> None:
    hass.async_create_task(hass.services.async_call(
        "persistent_notification", "create", {
            "title":   "Agribud — service unavailable",
            "message": (
                "Agribud is not loaded. Go to Settings → Devices & Services "
                "→ Agribud and check that the integration is healthy."
            ),
            "notification_id": f"{DOMAIN}_service_unavailable",
        }
    ))


# ── Services ──────────────────────────────────────────────────────────────────

def _register_services(hass: HomeAssistant) -> None:

    async def handle_add_plant(call: ServiceCall):
        store = _get_store(hass)
        api   = _get_api(hass)
        if not store or not api:
            _LOGGER.error("Agribud: add_plant called but store/api not loaded")
            _service_unavailable_notification(hass)
            return
        d = call.data.get(ATTR_START_DATE)
        species_id = call.data[ATTR_SPECIES_ID]
        sid_str = str(species_id)
        # Prefer species_data supplied directly by the caller (the card has
        # this from its earlier search call). This skips any cache or fallback
        # logic and means add_plant costs ZERO Flora API calls.
        supplied = call.data.get("species_data")
        species_data: dict = {}
        cache = _get_caches(hass)
        if isinstance(supplied, dict) and supplied:
            species_data = supplied
            if cache:
                cache["species_cache"][sid_str] = species_data
            _LOGGER.info(
                "Agribud: add_plant using species_data supplied by caller "
                "(species_id=%s, %d keys, no APIFarmer call needed)",
                species_id, len(species_data),
            )
        # Fallback chain — only run if the caller didn't supply species_data.
        # 1. In-memory species cache (populated by previous searches)
        if not species_data and cache and cache["species_cache"].get(sid_str):
            species_data = cache["species_cache"][sid_str]
            _LOGGER.info(
                "Agribud: add_plant reusing in-memory cached species data for id=%s",
                species_id,
            )
        # 2. Already-added plants of the same species
        if not species_data:
            for existing in store._data["plants"].values():
                if str(existing.get("species_id")) == sid_str and existing.get("species_data"):
                    species_data = dict(existing["species_data"])
                    if cache:
                        cache["species_cache"][sid_str] = species_data
                    _LOGGER.info(
                        "Agribud: add_plant reusing species data for id=%s from existing plant",
                        species_id,
                    )
                    break
        # 3. Last resort — try the API directly
        # currently returns {} and is essentially a no-op safety net. Logged
        # at INFO so it's visible if the card ever stops supplying species_data.
        if not species_data:
            try:
                species_data = await api.get_species_detail(species_id)
                if species_data and cache:
                    cache["species_cache"][sid_str] = species_data
                _LOGGER.info(
                    "Agribud: add_plant fetched species id=%s via api fallback "
                    "(%d keys)",
                    species_id, len(species_data or {}),
                )
            except PerenualRateLimitError as err:
                _LOGGER.warning(
                    "Agribud: rate limit hit when fetching species id=%s — plant "
                    "added with empty species cache. User will need to re-search. (%s)",
                    species_id, err,
                )
            except (PerenualApiError, PerenualAuthError, PerenualConnectionError) as err:
                _LOGGER.warning(
                    "Agribud: could not fetch species id=%s during add_plant: %s. "
                    "Plant added without cached data — search for it again to repopulate.",
                    species_id, err,
                )

        plant = await store.async_add_plant(
            name=call.data[ATTR_PLANT_NAME],
            species_id=species_id,
            start_type=call.data.get(ATTR_START_TYPE, "seed"),
            start_date=d.isoformat() if d else None,
            location=call.data.get(ATTR_LOCATION, ""),
            plot_id=call.data.get("plot_id"),
            species_data=species_data,
        )
        # Log a "planted" event on the start_date so it shows up on the
        # calendar and in the plant's History tab. This is informational —
        # it gives users a visible marker for the planting day, especially
        # when they back-date the plant.
        try:
            start_type = plant.get("start_type", "seed")
            note = f"Planted from {start_type}"
            await store.async_log_event(
                plant_id=plant["id"],
                event_type=EVENT_PLANTED,
                note=note,
                event_date=plant["start_date"],
                auto=True,
            )
        except Exception as err:
            _LOGGER.warning(
                "Agribud: could not log planted event for %s — %s",
                plant["id"], err,
            )
        await _refresh_all(hass)
        _fire_data_changed(hass, kind="plant_added", plant_id=plant["id"])

    async def handle_remove_plant(call: ServiceCall):
        store = _get_store(hass)
        if not store:
            _service_unavailable_notification(hass)
            return
        pid = call.data[ATTR_PLANT_ID]
        ok = await store.async_remove_plant(pid)
        if not ok:
            _LOGGER.warning("Agribud: remove_plant — plant id=%s not found", pid)
            return
        await _refresh_all(hass)
        _fire_data_changed(hass, kind="plant_removed", plant_id=pid)

    async def handle_log_event(call: ServiceCall):
        store = _get_store(hass)
        if not store:
            _service_unavailable_notification(hass)
            return
        d = call.data.get(ATTR_EVENT_DATE)
        event = await store.async_log_event(
            plant_id=call.data[ATTR_PLANT_ID],
            event_type=call.data[ATTR_EVENT_TYPE],
            note=call.data.get(ATTR_EVENT_NOTE, ""),
            event_date=d.isoformat() if d else None,
        )
        if event is None:
            _LOGGER.warning(
                "Agribud: log_event for plant %s failed (plant not found?)",
                call.data[ATTR_PLANT_ID],
            )
            return
        await _refresh_all(hass)
        _fire_data_changed(
            hass, kind="event_logged",
            plant_id=call.data[ATTR_PLANT_ID],
            event_id=event["id"],
            event_type=event["type"],
        )

    async def handle_remove_event(call: ServiceCall):
        store = _get_store(hass)
        if not store:
            _service_unavailable_notification(hass)
            return
        pid = call.data[ATTR_PLANT_ID]
        eid = call.data[ATTR_EVENT_ID]
        ok = await store.async_remove_event(pid, eid)
        if not ok:
            _LOGGER.warning(
                "Agribud: remove_event — could not remove event id=%s on plant %s",
                eid, pid,
            )
            return
        await _refresh_all(hass)
        _fire_data_changed(hass, kind="event_removed", plant_id=pid, event_id=eid)

    async def handle_update_overrides(call: ServiceCall):
        """Apply user-supplied override values to a plant.

        Overrides are display-only — they don't change the cached Flora
        species_data, just what the trading card shows. An empty string for
        any field removes that override (falls back to APIFarmer's value).
        """
        store = _get_store(hass)
        if not store:
            _service_unavailable_notification(hass)
            return
        pid = call.data[ATTR_PLANT_ID]
        overrides = call.data.get("overrides") or {}
        result = await store.async_update_overrides(pid, overrides)
        if result is None:
            _LOGGER.warning(
                "Agribud: update_plant_overrides — no plant with id=%s", pid,
            )
            return
        await _refresh_all(hass)
        _fire_data_changed(hass, kind="plant_overrides_updated", plant_id=pid)

    async def handle_update_plant(call: ServiceCall):
        """Update the core fields of an existing plant (name, start date,
        start type, location, plot assignment).

        Distinct from update_plant_overrides — overrides only affect display
        fields sourced from species_data. update_plant edits the plant
        record itself. Sending a key with a value updates it; omitted keys
        are left as-is.
        """
        store = _get_store(hass)
        if not store:
            _service_unavailable_notification(hass)
            return
        pid = call.data[ATTR_PLANT_ID]
        # Build kwargs by mapping schema attr names → store kwarg names.
        # Only include keys the caller actually provided so we don't
        # accidentally clear fields by sending None.
        kw = {}
        if ATTR_PLANT_NAME in call.data:
            kw["name"] = call.data[ATTR_PLANT_NAME]
        if ATTR_START_TYPE in call.data:
            kw["start_type"] = call.data[ATTR_START_TYPE]
        if ATTR_START_DATE in call.data:
            d = call.data[ATTR_START_DATE]
            kw["start_date"] = d.isoformat() if d else None
        if ATTR_LOCATION in call.data:
            kw["location"] = call.data[ATTR_LOCATION]
        if "plot_id" in call.data:
            kw["plot_id"] = call.data["plot_id"]
        if not kw:
            _LOGGER.debug("Agribud: update_plant for %s — no fields supplied", pid)
            return
        result = await store.async_update_plant(pid, **kw)
        if result is None:
            _LOGGER.warning("Agribud: update_plant — no plant with id=%s", pid)
            return
        # If start_date changed, the synthetic "planted" event we created at
        # add-time is now stale (still on the old date). Re-anchor it.
        if "start_date" in kw and kw["start_date"]:
            try:
                await store.async_reanchor_planted_event(pid, kw["start_date"])
            except Exception as err:
                _LOGGER.debug("Agribud: could not re-anchor planted event: %s", err)
        await _refresh_all(hass)
        _fire_data_changed(hass, kind="plant_updated", plant_id=pid)

    hass.services.async_register(DOMAIN, SERVICE_ADD_PLANT,        handle_add_plant,        schema=_ADD_PLANT_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_REMOVE_PLANT,     handle_remove_plant,     schema=_REMOVE_PLANT_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_LOG_EVENT,        handle_log_event,        schema=_LOG_EVENT_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_REMOVE_EVENT,     handle_remove_event,     schema=_REMOVE_EVENT_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_UPDATE_OVERRIDES, handle_update_overrides, schema=_UPDATE_OVERRIDES_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_UPDATE_PLANT,     handle_update_plant,     schema=_UPDATE_PLANT_SCHEMA)
