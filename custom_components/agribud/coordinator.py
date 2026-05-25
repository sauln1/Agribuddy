"""DataUpdateCoordinator for Agribud.

Reads weather data from a HA weather entity. Does NOT auto-refresh species
data from Perenual — that's fetched once when a plant is added and cached on
the plant record.

The 24h `update_interval` is a periodic safety net; the real-time work happens
via `async_track_state_change_event`, which fires whenever the configured
weather entity changes state or attributes. That listener:
  - Re-reads the entity into our flat weather dict
  - Detects rain / snow / frost using `_check_rain` etc.
  - Persists today's observation to store.weather_log (for the calendar)
  - Logs `rain_detected` events on every active plant when rain is first seen
    that day (so days_since_watered resets and "needs water" indicators clear)
  - Fires the `agribud_data_changed` bus event so the card refreshes immediately
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, Event, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .api import PerenualApiClient
from .const import (
    DOMAIN,
    DEFAULT_UPDATE_INTERVAL,
    DEFAULT_FROST_THRESHOLD_C,
    EVENT_FROST_ALERT,
)
from .store import PlantStore

_LOGGER = logging.getLogger(__name__)


class AgribudCoordinator(DataUpdateCoordinator):
    """Reads the configured weather entity and emits frost/rain auto-events."""

    def __init__(
        self,
        hass: HomeAssistant,
        api: PerenualApiClient,
        store: PlantStore,
        weather_entity: str,
        update_interval_minutes: int = DEFAULT_UPDATE_INTERVAL,
    ) -> None:
        super().__init__(
            hass, _LOGGER, name=DOMAIN,
            update_interval=timedelta(minutes=update_interval_minutes),
        )
        self.api = api
        self.store = store
        self.weather_entity = weather_entity
        self._frost_alerted_date: str | None = None
        self._rain_logged_date: str | None = None
        # Listener cleanup callback set up in async_setup_listeners
        self._unsub_state_change = None
        # Set up the weather entity state-change subscription. Without this
        # we'd only react every update_interval, missing rain that happens
        # between scheduled refreshes.
        if weather_entity:
            self._unsub_state_change = async_track_state_change_event(
                hass, [weather_entity], self._on_weather_state_change,
            )
            _LOGGER.info(
                "Agribud: subscribed to state changes for weather entity %s",
                weather_entity,
            )

    @callback
    def _on_weather_state_change(self, event: Event) -> None:
        """HA bus listener — fires whenever the weather entity changes.

        Schedules an async task so this returns immediately (HA bus listeners
        should not block on awaits).
        """
        self.hass.async_create_task(self._process_weather_change(event))

    async def _process_weather_change(self, event: Event) -> None:
        """Read the entity, persist observations, and auto-log rain/frost events."""
        weather = self._read_weather_entity()
        if not weather:
            return
        today = date.today().isoformat()
        rain  = self._check_rain(weather)
        snow  = self._check_snow(weather)
        frost = self._check_frost(weather)
        condition = (weather.get("condition") or "").strip()

        _LOGGER.debug(
            "Agribud: weather state change — condition=%r precipitation=%r "
            "tonight_low=%r → rain=%s snow=%s frost=%s",
            condition, weather.get("precipitation"),
            weather.get("tonight_low"), rain, snow, frost,
        )

        if rain or snow or frost or condition:
            changed = await self.store.async_record_weather(
                date_str=today, rain=rain, snow=snow, frost=frost,
                condition=condition,
            )
            if changed:
                # Bus event so the card refreshes weather_log + plant data
                self.hass.bus.async_fire(
                    f"{DOMAIN}_data_changed",
                    {"kind": "weather_logged", "date": today,
                     "rain": rain, "snow": snow, "frost": frost},
                )

        # Auto-log rain to every plant the first time we see rain today.
        # This is what makes days_since_watered reset and "needs water"
        # indicators clear.
        if rain and self._rain_logged_date != today:
            _LOGGER.info(
                "Agribud: rain detected (condition=%r, precip=%r) — auto-logging "
                "rain event for all plants. days_since_watered will reset.",
                condition, weather.get("precipitation"),
            )
            await self.store.async_log_rain_all(0.0)
            self._rain_logged_date = today

        # Frost alert (existing behaviour, kept here so realtime state changes
        # can trigger it instead of waiting for the periodic refresh)
        if frost and self._frost_alerted_date != today:
            plants = self.store.get_all_plants()
            active = [p for p in plants if not p.get("is_scheduled", False)]
            await self._maybe_frost_alert(weather, active, today)

    async def _async_update_data(self) -> dict[str, Any]:
        weather = self._read_weather_entity()
        today = date.today().isoformat()

        plants = self.store.get_all_plants()
        # Future-scheduled plants don't trigger frost/rain logic
        active_plants = [p for p in plants if not p.get("is_scheduled", False)]

        frost_tonight = self._check_frost(weather)
        rain_today = self._check_rain(weather)

        await self._maybe_rain(rain_today, today, weather)
        if frost_tonight:
            await self._maybe_frost_alert(weather, active_plants, today)

        return {
            "weather": weather,
            "plants": plants,
            "frost_tonight": frost_tonight,
            "rain_today": rain_today,
        }

    async def async_shutdown(self) -> None:
        if self._unsub_state_change is not None:
            try:
                self._unsub_state_change()
            except Exception as err:
                _LOGGER.warning("Agribud: failed to detach state listener: %s", err)
            self._unsub_state_change = None
        await super().async_shutdown()

    # ── Weather entity reading ────────────────────────────────────────────────

    def _read_weather_entity(self) -> dict:
        if not self.weather_entity:
            return {}
        state = self.hass.states.get(self.weather_entity)
        if state is None:
            _LOGGER.warning(
                "Agribud: weather entity '%s' not found in HA. "
                "Update via card Settings or remove and re-add the integration.",
                self.weather_entity,
            )
            return {}
        attrs = state.attributes or {}
        forecast = attrs.get("forecast", []) or []
        tonight_low = None
        if forecast:
            tonight_low = forecast[0].get("templow") or forecast[0].get("temperature")
        return {
            "condition":     state.state,
            "temperature":   attrs.get("temperature"),
            "humidity":      attrs.get("humidity"),
            "pressure":      attrs.get("pressure"),
            "wind_speed":    attrs.get("wind_speed"),
            "precipitation": attrs.get("precipitation"),
            "forecast":      forecast,
            "tonight_low":   tonight_low,
            "entity_id":     self.weather_entity,
            "temperature_unit":   attrs.get("temperature_unit"),
            "wind_speed_unit":    attrs.get("wind_speed_unit"),
            "pressure_unit":      attrs.get("pressure_unit"),
            "precipitation_unit": attrs.get("precipitation_unit"),
            "humidity_unit":      "%",
        }

    @staticmethod
    def _check_frost(weather: dict) -> bool:
        """Frost detection relies on the weather entity's overnight low."""
        low = weather.get("tonight_low")
        if low is None:
            return False
        try:
            return float(low) <= float(DEFAULT_FROST_THRESHOLD_C)
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _check_rain(weather: dict) -> bool:
        """Returns True if the entity indicates rain is currently observable.

        Checks (in order):
          1. precipitation attribute > 0
          2. state string contains rain-related keywords
          3. forecast[0] indicates rain (some entities only set the condition
             on the forecast slot for the current period)
        """
        precip = weather.get("precipitation")
        if precip is not None:
            try:
                if float(precip) > 0:
                    return True
            except (ValueError, TypeError):
                pass
        cond = (weather.get("condition") or "").lower().replace("-", "_")
        rain_keywords = (
            "rain", "drizzle", "shower", "thunder", "pour", "lightning_rainy",
        )
        if any(w in cond for w in rain_keywords):
            return True
        forecast = weather.get("forecast") or []
        if forecast:
            fcast_cond = (forecast[0].get("condition") or "").lower().replace("-", "_")
            if any(w in fcast_cond for w in rain_keywords):
                return True
        return False

    @staticmethod
    def _check_snow(weather: dict) -> bool:
        """Returns True if the entity indicates snow."""
        cond = (weather.get("condition") or "").lower().replace("-", "_")
        snow_keywords = ("snow", "snowy", "sleet", "blizzard", "flurries")
        if any(w in cond for w in snow_keywords):
            return True
        forecast = weather.get("forecast") or []
        if forecast:
            fcast_cond = (forecast[0].get("condition") or "").lower().replace("-", "_")
            if any(w in fcast_cond for w in snow_keywords):
                return True
        return False

    # ── Auto-events ───────────────────────────────────────────────────────────

    async def _maybe_rain(self, rain: bool, today: str, weather: dict) -> None:
        """Called from the periodic refresh path. Auto-logs rain at most once
        per day. Realtime state changes go through _process_weather_change."""
        if not rain or self._rain_logged_date == today:
            return
        # Also record the observation so the calendar shows the rain cloud icon
        await self.store.async_record_weather(
            date_str=today, rain=True,
            condition=(weather.get("condition") or "").strip(),
        )
        _LOGGER.info("Agribud: auto-logging rain event for active plants (periodic refresh)")
        await self.store.async_log_rain_all(0.0)
        self._rain_logged_date = today
        self.hass.bus.async_fire(
            f"{DOMAIN}_data_changed",
            {"kind": "weather_logged", "date": today, "rain": True},
        )

    async def _maybe_frost_alert(self, weather: dict, plants: list, today: str) -> None:
        if self._frost_alerted_date == today or not plants:
            return
        low = weather.get("tonight_low", "?")
        for plant in plants:
            await self.store.async_log_event(
                plant["id"], EVENT_FROST_ALERT,
                note=f"Overnight low forecast: {low}°C", auto=True,
            )
        self.hass.async_create_task(
            self.hass.services.async_call("persistent_notification", "create", {
                "title":           "Agribud — Frost Alert ❄️",
                "message":         f"Frost risk tonight! Low: {low}°C. Check your plants.",
                "notification_id": f"{DOMAIN}_frost_{today}",
            })
        )
        self._frost_alerted_date = today
        _LOGGER.warning("Agribud: frost alert fired (low: %s°C)", low)

    # ── Accessors ─────────────────────────────────────────────────────────────

    def get_weather(self) -> dict:
        return (self.data or {}).get("weather", {})

    def get_plants(self) -> list:
        return (self.data or {}).get("plants", [])

    def is_frost_tonight(self) -> bool:
        return bool((self.data or {}).get("frost_tonight", False))

    def is_rain_today(self) -> bool:
        return bool((self.data or {}).get("rain_today", False))
