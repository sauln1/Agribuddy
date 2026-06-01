"""Binary sensor entities for Agribuddy.

Per-plot "all thirsty" sensors (created dynamically) — one per real grow
plot. State is on (True) only when the plot has at least one plant AND every
plant in it is thirsty (overdue for water). Otherwise off (False). The
virtual "Unassigned" plot is excluded.

These are exposed for automations, e.g. "if binary_sensor.agribuddy_<plot>
_all_thirsty is on, notify me / run irrigation".
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, EVENT_DEAD, EVENT_HARVESTED
from .coordinator import AgribuddyCoordinator
from .sensor import plant_is_thirsty

_LOGGER = logging.getLogger(__name__)

# The virtual plot id used by the store for plants with no plot assignment.
# Excluded from all-thirsty sensors per design.
_UNASSIGNED_PLOT_ID = "_unassigned"


def _device(entry: ConfigEntry) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Agribuddy",
        manufacturer="Agribuddy",
        model="Verdantly plant database",
        sw_version="0.1.0",
    )


def _is_terminal(p: dict) -> bool:
    """True if the plant has a harvested or dead event (terminal state)."""
    for e in p.get("events") or p.get("events_sorted") or []:
        et = (e.get("type") or "").lower()
        if et in (EVENT_DEAD, EVENT_HARVESTED):
            return True
    return False


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coord: AgribuddyCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    mgr = PlotBinarySensorManager(hass, coord, entry, async_add_entities)
    coord.async_add_listener(mgr.refresh)
    # Initial reconcile in case the first refresh already happened before
    # this platform finished loading.
    mgr.refresh()


class PlotAllThirsty(CoordinatorEntity[AgribuddyCoordinator], BinarySensorEntity):
    """True when every plant in a grow plot is thirsty (and the plot is
    non-empty). Off otherwise. One entity per real grow plot."""

    _attr_has_entity_name = True
    # No device_class — a plain on/off boolean, per design (not surfaced as
    # a "problem").

    def __init__(
        self,
        coord: AgribuddyCoordinator,
        entry: ConfigEntry,
        plot_id: str,
        plot_name: str,
    ) -> None:
        super().__init__(coord)
        self._entry = entry
        self._plot_id = plot_id
        self._plot_name = plot_name or plot_id
        self._attr_unique_id = f"{entry.entry_id}_plot_{plot_id}_all_thirsty"
        self._attr_device_info = _device(entry)

    @property
    def name(self) -> str:
        return f"{self._plot_name} all thirsty"

    @property
    def icon(self) -> str:
        return "mdi:water-alert" if self.is_on else "mdi:water-check"

    def _plot(self) -> dict | None:
        for pl in self.coordinator.get_plots():
            if pl.get("id") == self._plot_id:
                return pl
        return None

    def _waterable(self, plot: dict) -> list[dict]:
        """Plants in the plot that are active and waterable — excludes
        terminal (harvested/dead) and scheduled plants."""
        return [
            p
            for p in (plot.get("plants") or [])
            if not p.get("is_scheduled") and not _is_terminal(p)
        ]

    @property
    def is_on(self) -> bool:
        plot = self._plot()
        if not plot:
            return False
        waterable = self._waterable(plot)
        if not waterable:
            # Empty (or only terminal/scheduled) plot → default False.
            return False
        return all(plant_is_thirsty(p) for p in waterable)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        plot = self._plot()
        if not plot:
            return {"plot_id": self._plot_id, "plot_name": self._plot_name}
        waterable = self._waterable(plot)
        thirsty = [p for p in waterable if plant_is_thirsty(p)]
        return {
            "plot_id": self._plot_id,
            "plot_name": plot.get("name") or self._plot_name,
            "plant_count": len(plot.get("plants") or []),
            "waterable_count": len(waterable),
            "thirsty_count": len(thirsty),
            "thirsty_plants": [p.get("name") for p in thirsty],
        }


class PlotBinarySensorManager:
    """Reconciles per-plot binary sensors with the current set of real grow
    plots — creates entities for new plots, removes them from the registry
    when a plot is deleted. Mirrors PlantSensorManager. The virtual
    Unassigned plot is never given an entity.
    """

    def __init__(self, hass, coord, entry, add_entities):
        self._hass = hass
        self._coord = coord
        self._entry = entry
        self._add = add_entities
        self._known: set = set()

    def _real_plots(self) -> dict[str, dict]:
        return {
            pl["id"]: pl
            for pl in self._coord.get_plots()
            if pl.get("id")
            and pl["id"] != _UNASSIGNED_PLOT_ID
            and not pl.get("virtual")
        }

    @callback
    def refresh(self):
        current = self._real_plots()
        current_ids = set(current)

        new_ids = current_ids - self._known
        if new_ids:
            entities = [
                PlotAllThirsty(
                    self._coord,
                    self._entry,
                    pid,
                    plot_name=current[pid].get("name") or "",
                )
                for pid in new_ids
            ]
            self._add(entities)
            self._known.update(new_ids)
            _LOGGER.info(
                "Agribuddy: created %d new plot binary sensor(s)", len(entities)
            )

        removed_ids = self._known - current_ids
        if removed_ids:
            registry = er.async_get(self._hass)
            for pid in list(removed_ids):
                unique_id = f"{self._entry.entry_id}_plot_{pid}_all_thirsty"
                ent_id = registry.async_get_entity_id(
                    "binary_sensor", DOMAIN, unique_id
                )
                if ent_id:
                    registry.async_remove(ent_id)
                    _LOGGER.info(
                        "Agribuddy: removed binary sensor for deleted plot "
                        "id=%s (entity %s)",
                        pid,
                        ent_id,
                    )
                self._known.discard(pid)
