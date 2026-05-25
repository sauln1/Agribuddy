"""Config flow for Agribud — Verdantly Gardening API key (via RapidAPI)
+ HA weather entity."""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.selector import EntitySelector, EntitySelectorConfig

from .const import (
    DOMAIN, CONF_API_KEY, CONF_WEATHER_ENTITY,
    CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL, DEFAULT_NAME,
    VERDANTLY_SIGNUP_URL,
)

_LOGGER = logging.getLogger(__name__)


# Any-entity picker — covers the full domain space (weather, sensor, MQTT,
# template, etc.) so users can pick whatever entity surfaces current weather.
_ENTITY_SELECTOR = EntitySelector(EntitySelectorConfig())


class AgribudConfigFlow(ConfigFlow, domain=DOMAIN):
    # VERSION 4: Verdantly Gardening API migration (via RapidAPI).
    # Existing entries from APIFarmer (v3), Flora (v2), or Perenual (v1)
    # all need to be re-added since the key shape and host differ.
    VERSION = 4

    def __init__(self) -> None:
        self._api_key: str = ""
        self._weather_entity: str = ""

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Step 1: Verdantly Gardening API key (from RapidAPI).

        IMPORTANT: We do NOT validate the key here, because validation would
        cost 1 API call against the user's 25-call/month free-tier quota.
        We trust the user to copy the key correctly; the first real search
        will surface any auth issue with a clear error message.
        """
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        errors: dict[str, str] = {}
        if user_input is not None:
            key = (user_input.get(CONF_API_KEY) or "").strip()
            if not key:
                errors["base"] = "api_key_empty"
            else:
                self._api_key = key
                return await self.async_step_weather()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_API_KEY): str}),
            errors=errors,
            description_placeholders={
                "signup_url": VERDANTLY_SIGNUP_URL,
            },
        )

    async def async_step_weather(self, user_input: dict | None = None) -> FlowResult:
        """Step 2: Pick any entity that represents the current weather.

        The chosen entity is polled for its state (used for rain/snow
        detection) and its attributes (precipitation, forecast for tonight's
        low → frost detection). Any entity type works.
        """
        if user_input is not None:
            self._weather_entity = user_input[CONF_WEATHER_ENTITY]
            return self.async_create_entry(
                title=DEFAULT_NAME,
                data={
                    CONF_API_KEY:        self._api_key,
                    CONF_WEATHER_ENTITY: self._weather_entity,
                },
                options={CONF_UPDATE_INTERVAL: DEFAULT_UPDATE_INTERVAL},
            )
        return self.async_show_form(
            step_id="weather",
            data_schema=vol.Schema({
                vol.Required(CONF_WEATHER_ENTITY): _ENTITY_SELECTOR,
            }),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return AgribudOptionsFlow(config_entry)


class AgribudOptionsFlow(OptionsFlow):
    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry

    async def async_step_init(self, user_input: dict | None = None) -> FlowResult:
        if user_input is not None:
            # Mirror the weather entity into entry.data too so the card's
            # status endpoint (which historically reads data) and the options
            # flow (which writes options) stay in sync. The integration's
            # async_setup_entry reads options-first with a data fallback.
            new_weather = user_input.get(CONF_WEATHER_ENTITY)
            if new_weather and new_weather != self._entry.data.get(CONF_WEATHER_ENTITY):
                merged_data = dict(self._entry.data)
                merged_data[CONF_WEATHER_ENTITY] = new_weather
                self.hass.config_entries.async_update_entry(
                    self._entry, data=merged_data,
                )
            return self.async_create_entry(title="", data=user_input)
        current_interval = self._entry.options.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL)
        current_weather  = self._entry.options.get(
            CONF_WEATHER_ENTITY,
            self._entry.data.get(CONF_WEATHER_ENTITY, ""),
        )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(CONF_UPDATE_INTERVAL, default=current_interval):
                    vol.All(vol.Coerce(int), vol.Range(min=60, max=10080)),
                vol.Required(CONF_WEATHER_ENTITY, default=current_weather):
                    _ENTITY_SELECTOR,
            }),
        )

