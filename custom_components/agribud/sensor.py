"""Sensor entities for Agribud.

Weather mirror sensors (one per Agribud config entry) — read native units
directly from the configured HA weather entity, no conversion.

Per-plant sensors (created dynamically) — one per plant, with all
species-derived attributes (sunlight, watering frequency, hardiness, etc.)
exposed for use in HA automations.
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass, SensorEntity, SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, EVENT_HARVESTED, EVENT_DEAD
from .coordinator import AgribudCoordinator

_LOGGER = logging.getLogger(__name__)


def _device(entry: ConfigEntry) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Agribud", manufacturer="Agribud",
        model="Perenual plant database", sw_version="0.1.0",
    )


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coord: AgribudCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        WeatherMirror(coord, entry, "temperature",   "Temperature",   SensorDeviceClass.TEMPERATURE),
        WeatherMirror(coord, entry, "humidity",      "Humidity",      SensorDeviceClass.HUMIDITY),
        WeatherMirror(coord, entry, "wind_speed",    "Wind speed",    SensorDeviceClass.WIND_SPEED),
        WeatherMirror(coord, entry, "precipitation", "Precipitation", SensorDeviceClass.PRECIPITATION),
    ])
    mgr = PlantSensorManager(hass, coord, entry, async_add_entities)
    coord.async_add_listener(mgr.refresh)


class WeatherMirror(CoordinatorEntity[AgribudCoordinator], SensorEntity):
    """Mirrors a field from the configured HA weather entity, preserving the
    native unit so HA does no automatic conversion."""
    _attr_has_entity_name = True
    _attr_state_class = SensorStateClass.MEASUREMENT

    _UNIT_KEY_MAP = {
        "temperature":   "temperature_unit",
        "humidity":      "humidity_unit",
        "wind_speed":    "wind_speed_unit",
        "precipitation": "precipitation_unit",
    }

    def __init__(self, coord, entry, field, name, device_class):
        super().__init__(coord)
        self._field = field
        self._attr_name = name
        self._attr_device_class = device_class
        self._attr_unique_id = f"{entry.entry_id}_{field}"
        self._attr_device_info = _device(entry)

    @property
    def native_value(self):
        return self.coordinator.get_weather().get(self._field)

    @property
    def native_unit_of_measurement(self):
        unit_key = self._UNIT_KEY_MAP.get(self._field)
        return self.coordinator.get_weather().get(unit_key) if unit_key else None

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "source_entity": self.coordinator.weather_entity,
            "native_unit":   self.native_unit_of_measurement,
        }


class PlantSensor(CoordinatorEntity[AgribudCoordinator], SensorEntity):
    """One sensor per plant.

    Status values (the sensor state):
      - "scheduled"  — start_date is in the future, plant not yet planted
      - "healthy"    — alive, watered, no frost risk
      - "thirsty"    — overdue for water (days_since_watered ≥ watering_min_days)
      - "danger"     — incoming frost within the forecast window
      - "harvested"  — user logged a harvest event; sticky until plant removed

    "harvested" is a TERMINAL state: once a harvest event exists on the plant,
    the sensor stays in "harvested" regardless of other conditions, until the
    plant is deleted. Other transitions are computed fresh each refresh.

    State color hints (rendered as icon color in the front-end):
      healthy   → green   (mdi:sprout)
      thirsty   → orange  (mdi:water-alert)
      danger    → red     (mdi:snowflake-alert)
      harvested → grey    (mdi:basket-check)
      scheduled → blue    (mdi:calendar-clock)
    """
    _attr_has_entity_name = False  # We want the plant's display name to be the full entity name
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["scheduled", "healthy", "thirsty", "danger", "harvested", "dead"]
    _attr_translation_key = "plant_status"

    def __init__(self, coord, entry, plant_id, plant_name: str = ""):
        super().__init__(coord)
        self._pid = plant_id
        self._attr_unique_id = f"{entry.entry_id}_plant_{plant_id}"
        self._attr_device_info = _device(entry)
        # Suggested object id derived from the plant's display name. HA will
        # auto-suffix `_2`, `_3`, etc. if multiple plants share the same name
        # so users don't have to manually disambiguate. Only used at first
        # entity creation; renames after creation won't shift the entity id.
        if plant_name:
            self._attr_suggested_object_id = _slugify_plant_name(plant_name)

    @property
    def _plant(self) -> dict | None:
        return next((p for p in self.coordinator.get_plants() if p["id"] == self._pid), None)

    @property
    def name(self) -> str:
        p = self._plant
        return (p.get("name") if p else None) or f"Plant {self._pid[:8]}"

    @property
    def icon(self) -> str:
        state = self.native_value
        return {
            "scheduled": "mdi:calendar-clock",
            "healthy":   "mdi:sprout",
            "thirsty":   "mdi:water-alert",
            "danger":    "mdi:snowflake-alert",
            "harvested": "mdi:basket-check",
            "dead":      "mdi:leaf-off",
        }.get(state, "mdi:sprout")

    @property
    def native_value(self) -> str:
        p = self._plant
        if not p:
            # Coordinator hasn't finished its first refresh yet — default to
            # "healthy" rather than "unknown" so the entity always shows a
            # green/normal state during initial load instead of the alarming
            # "unknown" icon. Will resolve to the real state on next refresh.
            return "healthy"

        # ── 1. Terminal: harvested or dead (sticky until plant removed) ──
        # Scan persisted events for any harvest or death entry. Both states
        # are terminal — once present, they override every other condition
        # until the user deletes the plant. Dead trumps harvested if both
        # somehow appear (a dead plant can't be "harvested" after the fact).
        events = p.get("events") or p.get("events_sorted") or []
        has_harvested = False
        for e in events:
            et = (e.get("type") or "").lower()
            if et == EVENT_DEAD:
                return "dead"
            if et == EVENT_HARVESTED:
                has_harvested = True
        if has_harvested:
            return "harvested"

        # ── 2. Scheduled: planted in the future ───────────────────────────
        if p.get("is_scheduled"):
            return "scheduled"

        # ── 3. Frost danger: coordinator's frost forecast flag ────────────
        # The coordinator surfaces `frost_tonight` at the top level of its
        # data snapshot (alongside `rain_today`). Frost overrides "thirsty"
        # because frost can kill the plant outright — it's the more urgent
        # alert. Wrapped in try/except since coordinator.data may be None
        # during very early startup before the first refresh completes.
        try:
            if (self.coordinator.data or {}).get("frost_tonight"):
                return "danger"
        except Exception:
            pass

        # ── 4. Thirsty: overdue for water ─────────────────────────────────
        threshold = p.get("watering_min_days") or 3
        days_w = p.get("days_since_watered")
        if days_w is not None and days_w >= threshold:
            return "thirsty"

        # ── 5. Default: healthy ───────────────────────────────────────────
        return "healthy"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        p = self._plant
        if not p:
            return {}
        return {
            # Identity
            "plant_id":           p["id"],
            "plant_name":         p.get("name"),
            "species_id":         p.get("species_id"),
            "image_url":          p.get("image_url"),
            "description":        p.get("description"),
            # Tracking
            "start_type":            p.get("start_type"),
            "start_date":            p.get("start_date"),
            "location":              p.get("location"),
            "days_growing":          p.get("days_growing"),
            "days_until_planting":   p.get("days_until_planting"),
            "is_scheduled":          p.get("is_scheduled", False),
            "days_since_watered":    p.get("days_since_watered"),
            "days_since_fertilized": p.get("days_since_fertilized"),
            "last_watered":          p.get("last_watered"),
            "last_fertilized":       p.get("last_fertilized"),
            "last_water_source":     p.get("last_water_source"),  # "manual" | "rain" | None
            "never_watered":         p.get("never_watered", False),
            # Convenience boolean for automations: true when overdue for water
            "needs_water": (
                (not p.get("is_scheduled", False))
                and p.get("days_since_watered") is not None
                and p.get("days_since_watered") >= (p.get("watering_min_days") or 3)
            ),
            # Verdantly species data — exposed for automations
            "common_name":            p.get("common_name"),
            "scientific_name":        p.get("scientific_name"),
            "sunlight":               p.get("sunlight"),
            "light_requirements":     p.get("light_requirements"),
            "water_use":              p.get("water_use"),
            "watering_min_days":      p.get("watering_min_days"),
            "watering_max_days":      p.get("watering_max_days"),
            "watering_benchmark":     p.get("watering_benchmark_value"),
            "watering_benchmark_unit": p.get("watering_benchmark_unit"),
            "hardiness_zone_min":     p.get("hardiness_zone_min"),
            "hardiness_zone_max":     p.get("hardiness_zone_max"),
            "soil_preference":        p.get("soil_preference"),
            "spacing_requirement":    p.get("spacing_requirement"),
            "growth_period":          p.get("growth_period"),
            "toxicity_display":       p.get("toxicity_display"),
            "invasive_alert":         p.get("invasive_alert"),
            # History
            "recent_events": (p.get("events_sorted") or [])[:20],
        }


def _slugify_plant_name(name: str) -> str:
    """Convert a plant name into a safe entity-id object suffix.

    HA's entity ids must be lowercase alphanumeric + underscore. We strip
    everything else and collapse runs of underscores. Names like "Cherry
    Tomato — east bed" become "cherry_tomato_east_bed". HA auto-suffixes
    "_2", "_3" when collisions occur, so multiple plants with the same
    display name get distinct entity ids automatically.
    """
    if not name:
        return ""
    import re
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "plant"


class PlantSensorManager:
    """Watches the coordinator and reconciles per-plant sensors with the
    current set of plants — creates entities for newly-added plants and
    removes entities from the HA registry when plants disappear
    (soft-delete: gone from `coord.get_plants()` but still in storage).
    """

    def __init__(self, hass, coord, entry, add_entities):
        self._hass = hass
        self._coord = coord
        self._entry = entry
        self._add = add_entities
        self._known: set = set()

    @callback
    def refresh(self):
        current_ids = {p["id"] for p in self._coord.get_plants()}
        # Add sensors for newly-seen plants
        new_ids = current_ids - self._known
        if new_ids:
            current_by_id = {p["id"]: p for p in self._coord.get_plants()}
            entities = [
                PlantSensor(self._coord, self._entry, pid,
                            plant_name=current_by_id[pid].get("name") or "")
                for pid in new_ids
            ]
            self._add(entities)
            self._known.update(new_ids)
            _LOGGER.info("Agribud: created %d new plant sensor(s)", len(entities))
        # Remove sensors for plants no longer visible (soft-deleted or
        # hard-deleted by 6-month prune). Pulls from HA's entity registry
        # using the deterministic unique_id pattern set in PlantSensor.
        removed_ids = self._known - current_ids
        if removed_ids:
            from homeassistant.helpers import entity_registry as er
            registry = er.async_get(self._hass)
            for pid in list(removed_ids):
                unique_id = f"{self._entry.entry_id}_plant_{pid}"
                ent_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
                if ent_id:
                    registry.async_remove(ent_id)
                    _LOGGER.info(
                        "Agribud: removed sensor for deleted plant id=%s (entity %s)",
                        pid, ent_id,
                    )
                self._known.discard(pid)
