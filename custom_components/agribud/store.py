"""Persistent plant + event storage for Agribud (Verdantly edition).

Plant record shape::

    {
        "id":            str (uuid),
        "name":          str,
        "species_id":    int   — Verdantly species id
        "start_type":    "seed" | "transplant",
        "start_date":    "YYYY-MM-DD",
        "location":      str,
        "plot_id":       str | None,
        "events":        [ ... ],
        "species_data":  dict — cached Verdantly /species/details/<id> response
        "created_at":    ISO timestamp,
    }

`species_data` is fetched once when the plant is added and never refreshed
automatically — only on user action. Deleting the plant deletes the cache
along with it. This minimises API usage per Verdantly's free-tier 100/day cap.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta as _td

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import (
    STORAGE_KEY,
    STORAGE_VERSION,
    EVENT_WATERED,
    EVENT_FERTILIZED,
    EVENT_RAIN_DETECTED,
    EVENT_PLANTED,
    EVENT_HARVESTED,
    EVENT_DEAD,
)

_LOGGER = logging.getLogger(__name__)


def _today() -> str:
    return date.today().isoformat()


def _now() -> str:
    return datetime.utcnow().isoformat()


def _days_since(iso: str | None) -> int | None:
    """Return calendar days since `iso`. Negative for future dates (intentional —
    used to support 'days until planting' for scheduled plants)."""
    if not iso:
        return None
    try:
        return (date.today() - date.fromisoformat(iso[:10])).days
    except ValueError, TypeError:
        return None


def _watering_min_days(species_data: dict | None) -> int | None:
    """Legacy helper preserved for backward compat with any callers that still
    reference it. The Flora-aware version lives next to `_enrich()` as
    `_water_use_to_min_days` and operates on the categorical `water_use` field
    instead of Verdantly's `watering_general_benchmark.value`.
    """
    return None


class PlantStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        # Data shape: {"plants": {id: plant}, "plots": {id: plot}}
        self._data: dict = {"plants": {}, "plots": {}}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        self._data = stored or {
            "plants": {},
            "plots": {},
            "weather_log": {},
            "archived_plants": {},
        }
        self._data.setdefault("plots", {})
        self._data.setdefault("plants", {})
        # weather_log is a per-day record of observed conditions, keyed by ISO
        # date (YYYY-MM-DD). Used by the card to draw rain/snow/frost icons in
        # calendar day cells. Shape: {"2026-05-12": {"rain": true, "snow": false,
        # "frost": false, "conditions": ["rainy", "cloudy"]}, ...}
        self._data.setdefault("weather_log", {})
        # archived_plants: slim historical records kept FOREVER, keyed by
        # plant id. Populated when a soft-deleted plant ages past the
        # 6-month species-cache TTL — instead of hard-deleting we archive
        # the bare minimum (name, dates, end status, event log) so the
        # season view can still display the plant's history.
        self._data.setdefault("archived_plants", {})
        # Prune soft-deleted plants older than 6 months. Plants with a
        # `deleted_at` ISO timestamp stay in `plants` for 6 months so
        # re-adding the same species is API-free; after that they get
        # moved to `archived_plants` (slim history) to keep the species
        # cache from growing unbounded while preserving season-view data.
        archived = self._archive_old_deleted_plants()
        _LOGGER.debug(
            "Agribud: loaded %d plants (%d soft-deleted, kept for Recent), "
            "%d plots, %d archived (history only), %d weather-log entries, "
            "archived %d this load",
            len(self._data["plants"]),
            sum(1 for p in self._data["plants"].values() if p.get("deleted_at")),
            len(self._data["plots"]),
            len(self._data["archived_plants"]),
            len(self._data["weather_log"]),
            archived,
        )

    def _archive_old_deleted_plants(self) -> int:
        """Move soft-deleted plants whose `deleted_at` is older than 6 months
        from the full `plants` dict into the slim `archived_plants` dict.
        Returns the count archived this run. Called once at load time.

        Archival preserves: id, name, start_date, end_date, end_status,
        events. Drops everything else (species_data, image_url, overrides,
        etc.). The slim record is enough to render the plant in the
        season view and show its event log on drill-down.
        """
        cutoff = (datetime.now() - _td(days=180)).isoformat(timespec="seconds")
        to_archive = [
            pid
            for pid, p in self._data["plants"].items()
            if p.get("deleted_at") and p["deleted_at"] < cutoff
        ]
        for pid in to_archive:
            p = self._data["plants"][pid]
            slim = self._make_archive_record(p)
            self._data["archived_plants"][pid] = slim
            del self._data["plants"][pid]
            _LOGGER.info(
                "Agribud: archived expired plant id=%s name=%r (status=%s, end=%s)",
                pid,
                slim.get("name"),
                slim.get("end_status"),
                slim.get("end_date"),
            )
        return len(to_archive)

    def _make_archive_record(self, plant: dict) -> dict:
        """Build a slim historical record from a full plant dict. Used both
        at load-time pruning and on-demand when listing archived data.

        Determines the plant's end state by scanning its events for the
        latest harvest/dead entry; falls back to "removed" using the
        `deleted_at` timestamp if neither exists.
        """
        events = plant.get("events") or []
        # Find the most recent end-of-life event
        end_status = None
        end_date = None
        for e in sorted(events, key=lambda x: x.get("date") or "", reverse=True):
            et = (e.get("type") or "").lower()
            if et in (EVENT_DEAD, EVENT_HARVESTED):
                end_status = et
                end_date = e.get("date")
                break
        if not end_status:
            # No explicit harvest/dead — the plant was just removed by the user
            end_status = "removed"
            # deleted_at is an ISO datetime — slice the date portion
            da = plant.get("deleted_at") or ""
            end_date = da.split("T")[0] if "T" in da else (da[:10] if da else None)
        return {
            "id": plant.get("id"),
            "name": plant.get("name"),
            "start_date": plant.get("start_date"),
            "end_date": end_date,
            "end_status": end_status,  # "harvested" | "dead" | "removed"
            "events": list(events),
            "archived_at": datetime.now().isoformat(timespec="seconds"),
            "archived": True,  # flag the card can read to route drill-down
        }

    def _active_plants(self):
        """Yield only non-deleted plants. Use this everywhere the user-facing
        plant list is built — plot views, sensors, main card, calendar."""
        return (p for p in self._data["plants"].values() if not p.get("deleted_at"))

    def get_season_view(self) -> list[dict]:
        """Return all plants (active + soft-deleted + archived) grouped by
        the season+year of their start_date. Powers the card's season-view
        rendering. Each item is a slim dict:
          {id, name, start_date, end_date, end_status, events, archived}
        where end_status is one of:
          - "growing"   : plant is active and has no terminal event
          - "harvested" : plant has a harvest event
          - "dead"      : plant has a dead event
          - "removed"   : plant was soft-deleted with no terminal event
        and end_date is the date of the terminal event (or deleted_at for
        "removed", or None for "growing").

        Active plants are also included so the user can see the current
        season's plantings alongside historical ones. The card decides
        how to render each (drill-down may show the trading card for
        plants still having species_data, or just the event log for
        archived ones).
        """
        items: list[dict] = []
        # Active plants (still alive in the user's garden)
        for p in self._data["plants"].values():
            if p.get("deleted_at"):
                # Soft-deleted but still in cache window — treat as ended
                slim = self._make_archive_record(p)
                slim["archived"] = False  # still has species_data; not yet archived
                items.append(slim)
            else:
                # Active plant — compute current end_status (harvested/dead
                # if a terminal event exists, else "growing")
                events = p.get("events") or []
                end_status = "growing"
                end_date = None
                for e in sorted(
                    events, key=lambda x: x.get("date") or "", reverse=True
                ):
                    et = (e.get("type") or "").lower()
                    if et in (EVENT_DEAD, EVENT_HARVESTED):
                        end_status = et
                        end_date = e.get("date")
                        break
                items.append(
                    {
                        "id": p.get("id"),
                        "name": p.get("name"),
                        "start_date": p.get("start_date"),
                        "end_date": end_date,
                        "end_status": end_status,
                        "events": list(events),
                        "archived": False,
                    }
                )
        # Archived plants (post-6-month, slim records)
        for p in self._data["archived_plants"].values():
            items.append({**p, "archived": True})  # noqa: PERF401
        return items

    def get_deleted_species_cache(self) -> list[dict]:
        """Return the species_data of every soft-deleted plant, deduped by
        scientific name (where possible) and sorted by most-recently-deleted
        first. Powers the Recent Plants strip's expanded "previously grown"
        section so users can re-add a species after deletion at zero API cost.
        """
        seen = set()
        out = []
        # Sort by deleted_at desc so newer deletions surface first
        deleted = sorted(
            (p for p in self._data["plants"].values() if p.get("deleted_at")),
            key=lambda p: p.get("deleted_at") or "",
            reverse=True,
        )
        for p in deleted:
            sd = p.get("species_data") or {}
            if not sd:
                continue
            sp = sd.get("species") or {}
            key = (
                (
                    sp.get("scientificName")
                    or sd.get("name")
                    or p.get("common_name")
                    or ""
                )
                .strip()
                .lower()
            )
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(sd)
        return out

    async def _save(self) -> None:
        await self._store.async_save(self._data)

    # ── Grow plot CRUD ────────────────────────────────────────────────────────

    def get_all_plots(self) -> list[dict]:
        plots = list(self._data["plots"].values())
        out = []
        for plot in plots:
            plot_copy = dict(plot)
            plot_copy["plants"] = [
                self._enrich(p)
                for p in self._active_plants()
                if p.get("plot_id") == plot["id"]
                or p.get("location", "").strip().lower() == plot["name"].strip().lower()
            ]
            plot_copy["plant_count"] = len(plot_copy["plants"])
            out.append(plot_copy)
        unassigned = [
            self._enrich(p)
            for p in self._active_plants()
            if not p.get("plot_id") and not p.get("location")
        ]
        if unassigned:
            out.append(
                {
                    "id": "_unassigned",
                    "name": "Unassigned",
                    "description": "Plants not yet assigned to a grow plot",
                    "plants": unassigned,
                    "plant_count": len(unassigned),
                    "virtual": True,
                }
            )
        return out

    def get_plot(self, plot_id: str) -> dict | None:
        if plot_id == "_unassigned":
            return next(
                (p for p in self.get_all_plots() if p["id"] == "_unassigned"), None
            )
        plot = self._data["plots"].get(plot_id)
        if not plot:
            return None
        plot_copy = dict(plot)
        plot_copy["plants"] = [
            self._enrich(p)
            for p in self._active_plants()
            if p.get("plot_id") == plot_id
            or p.get("location", "").strip().lower() == plot["name"].strip().lower()
        ]
        plot_copy["plant_count"] = len(plot_copy["plants"])
        return plot_copy

    async def async_add_plot(self, name: str, description: str = "") -> dict:
        plot_id = str(uuid.uuid4())
        plot = {
            "id": plot_id,
            "name": name,
            "description": description,
            "created_at": _now(),
        }
        self._data["plots"][plot_id] = plot
        await self._save()
        _LOGGER.info("Agribud: added grow plot id=%s name='%s'", plot_id, name)
        return plot

    async def async_remove_plot(self, plot_id: str) -> bool:
        if plot_id not in self._data["plots"]:
            return False
        for p in self._data["plants"].values():
            if p.get("plot_id") == plot_id:
                p["plot_id"] = None
        del self._data["plots"][plot_id]
        await self._save()
        _LOGGER.info("Agribud: removed grow plot id=%s", plot_id)
        return True

    async def async_update_plot(self, plot_id: str, **kwargs) -> dict | None:
        plot = self._data["plots"].get(plot_id)
        if not plot:
            return None
        for k, v in kwargs.items():
            if k in {"name", "description"}:
                plot[k] = v
        await self._save()
        return plot

    # ── Plant CRUD ────────────────────────────────────────────────────────────

    def get_all_plants(self) -> list[dict]:
        return [self._enrich(p) for p in self._active_plants()]

    def get_plant(self, plant_id: str) -> dict | None:
        p = self._data["plants"].get(plant_id)
        # Soft-deleted plants return None from the public getter so they
        # behave as if removed from the user's perspective. Internal code
        # (like the species-cache scan) goes through self._data directly.
        if not p or p.get("deleted_at"):
            return None
        return self._enrich(p)

    async def async_add_plant(
        self,
        name: str,
        species_id: int | str,
        start_type: str = "seed",
        start_date: str | None = None,
        location: str = "",
        plot_id: str | None = None,
        species_data: dict | None = None,
    ) -> dict:
        pid = str(uuid.uuid4())
        plant = {
            "id": pid,
            "name": name,
            "species_id": species_id,
            "start_type": start_type,
            "start_date": start_date or _today(),
            "location": location,
            "plot_id": plot_id,
            "events": [],
            "species_data": species_data or {},
            "created_at": _now(),
        }
        self._data["plants"][pid] = plant
        await self._save()
        _LOGGER.info(
            "Agribud: added plant id=%s name='%s' species_id=%s plot=%s start=%s "
            "(species_data cached: %s)",
            pid,
            name,
            species_id,
            plot_id or location or "(none)",
            plant["start_date"],
            "yes" if species_data else "no",
        )
        return self._enrich(plant)

    async def async_update_plant(self, plant_id: str, **kwargs) -> dict | None:
        plant = self._data["plants"].get(plant_id)
        if not plant:
            return None
        allowed = {
            "name",
            "species_id",
            "start_type",
            "start_date",
            "location",
            "plot_id",
            "species_data",
        }
        for k, v in kwargs.items():
            if k in allowed:
                plant[k] = v
        await self._save()
        return self._enrich(plant)

    async def async_reanchor_planted_event(self, plant_id: str, new_date: str) -> bool:
        """When a user edits a plant's start_date, the synthetic 'planted'
        event we created at add-time is still anchored to the original date.
        This re-dates the most recent 'planted' event on the plant to match
        the new start_date so the history view + watering calculations align.
        Returns True if an event was re-anchored, False otherwise.
        """
        plant = self._data["plants"].get(plant_id)
        if not plant or not new_date:
            return False
        events = plant.get("events") or []
        # Find the most recent EVENT_PLANTED entry and update its date
        for e in sorted(events, key=lambda x: x.get("date") or "", reverse=True):
            if e.get("type") == EVENT_PLANTED:
                if e.get("date") != new_date:
                    e["date"] = new_date
                    await self._save()
                    _LOGGER.info(
                        "Agribud: re-anchored planted event for %s to %s",
                        plant_id,
                        new_date,
                    )
                return True
        return False

    async def async_update_overrides(
        self, plant_id: str, overrides: dict
    ) -> dict | None:
        """Merge user-supplied field overrides onto a plant.

        Overrides are user-edited values that take precedence over the
        Flora API species_data when rendering the trading card. Sending an
        empty string for a key removes that override (falls back to the
        Flora value). Sending None for an override doesn't write the value.
        """
        plant = self._data["plants"].get(plant_id)
        if not plant:
            return None
        current = plant.get("user_overrides") or {}
        # Allowed override keys — restrict to known display fields so a
        # malformed service call can't pollute the plant dict. These match
        # the Verdantly field set surfaced on the trading card.
        allowed_keys = {
            # Identity / display
            "common_name",
            "scientific_name",
            # Light / Water (categorical + numeric min/max days)
            "light_requirements",
            "water_use",  # categorical (Low/Moderate/High)
            "watering_min_days",  # numeric override for needs_water threshold
            "watering_max_days",  # numeric override (display only)
            # Soil + spacing + growth
            "soil_preference",
            "spacing_requirement",
            "growth_period",
            "soil_ph_min",
            "soil_ph_max",
            # Hardiness zones
            "hardiness_zone_min",
            "hardiness_zone_max",
            # Harvest window
            "days_to_harvest_min",
            "days_to_harvest_max",
            # Ecology flag (user can flag a plant as invasive)
            "invasive_alert",
            # Free-text fields
            "care_instructions",
            "description",
            "habitat",
            # Image
            "image_url",
        }
        for k, v in (overrides or {}).items():
            if k not in allowed_keys:
                continue
            if v is None:
                # Don't mutate; explicit removal uses empty string
                continue
            if v == "":
                # Empty string means "remove this override, use Verdantly's value"
                current.pop(k, None)
            else:
                current[k] = v
        plant["user_overrides"] = current
        await self._save()
        _LOGGER.info(
            "Agribud: plant %s overrides updated (%d active keys)",
            plant_id,
            len(current),
        )
        return self._enrich(plant)

    async def async_remove_plant(self, plant_id: str) -> bool:
        """Soft-delete a plant: mark it with a `deleted_at` ISO timestamp
        and hide it from normal views. The plant record (and its cached
        species_data) stays in storage for 6 months so re-adding the same
        kind of plant costs 0 API calls. Plants older than 6 months are
        pruned automatically the next time the store loads.

        Note: the plant's HA sensor will disappear too because get_plants()
        filters out soft-deleted records — the entity manager only creates
        sensors for plants it currently sees, and HA will mark stale ones
        as unavailable until the user removes them from the entity registry.
        """
        plant = self._data["plants"].get(plant_id)
        if not plant:
            return False
        if plant.get("deleted_at"):
            # Already soft-deleted — nothing to do
            return True
        event_count = len(plant.get("events", []))
        had_cache = bool(plant.get("species_data"))
        plant_name = plant.get("name", "(unnamed)")
        plant["deleted_at"] = datetime.now().isoformat(timespec="seconds")
        await self._save()
        _LOGGER.info(
            "Agribud: soft-deleted plant id=%s name=%r (%d event(s), "
            "species_data %s). Kept in cache for 6 months.",
            plant_id,
            plant_name,
            event_count,
            "kept" if had_cache else "absent",
        )
        return True

    # ── Events ────────────────────────────────────────────────────────────────

    async def async_log_event(
        self,
        plant_id: str,
        event_type: str,
        note: str = "",
        event_date: str | None = None,
        auto: bool = False,
    ) -> dict | None:
        plant = self._data["plants"].get(plant_id)
        if not plant:
            _LOGGER.warning("Agribud: log_event — plant id=%s not found", plant_id)
            return None
        event = {
            "id": str(uuid.uuid4()),
            "type": event_type,
            "note": note,
            "date": event_date or _today(),
            "auto": auto,
            "created_at": _now(),
        }
        plant["events"].append(event)
        await self._save()
        return event

    async def async_remove_event(self, plant_id: str, event_id: str) -> bool:
        plant = self._data["plants"].get(plant_id)
        if not plant:
            _LOGGER.warning("Agribud: remove_event — plant id=%s not found", plant_id)
            return False
        before = len(plant["events"])
        plant["events"] = [e for e in plant["events"] if e.get("id") != event_id]
        if len(plant["events"]) == before:
            return False
        await self._save()
        return True

    async def async_log_rain_all(self, mm: float) -> None:
        note = f"{mm:.1f}mm detected" if mm > 0 else "Rain detected"
        for pid in list(self._data["plants"]):
            await self.async_log_event(pid, "rain_detected", note=note, auto=True)

    # ── Weather log (per-date observations for calendar icons) ───────────────

    async def async_record_weather(
        self,
        *,
        date_str: str,
        rain: bool = False,
        snow: bool = False,
        frost: bool = False,
        condition: str = "",
    ) -> bool:
        """Record an observation for a date. Returns True if anything actually
        changed (so the caller knows whether to fire a bus event or log new
        rain-watering events).

        Multiple calls for the same date are OR-merged for the booleans so
        we never overwrite an earlier "yes it rained today" with a later
        "now it's sunny" — once it rained that day, that day stays marked.
        """
        log = self._data["weather_log"]
        prev = log.get(date_str, {})
        new_rain = bool(prev.get("rain")) or rain
        new_snow = bool(prev.get("snow")) or snow
        new_frost = bool(prev.get("frost")) or frost
        conditions = list(prev.get("conditions", []))
        if condition and condition not in conditions:
            conditions.append(condition)
            if len(conditions) > 5:
                conditions = conditions[-5:]
        changed = (
            new_rain != prev.get("rain", False)
            or new_snow != prev.get("snow", False)
            or new_frost != prev.get("frost", False)
            or conditions != prev.get("conditions", [])
        )
        if not changed:
            return False
        log[date_str] = {
            "rain": new_rain,
            "snow": new_snow,
            "frost": new_frost,
            "conditions": conditions,
        }
        # Keep the log from growing unbounded — trim entries older than 90 days
        cutoff = (date.today() - _td(days=90)).isoformat()
        for k in list(log.keys()):
            if k < cutoff:
                del log[k]
        await self._save()
        _LOGGER.info(
            "Agribud: weather log for %s — rain=%s snow=%s frost=%s "
            "condition=%r (changed)",
            date_str,
            new_rain,
            new_snow,
            new_frost,
            condition,
        )
        return True

    def get_weather_log(self) -> dict:
        """Return the full weather log {date: {rain, snow, frost, conditions}}."""
        return dict(self._data.get("weather_log", {}))

    # ── Enrichment ────────────────────────────────────────────────────────────

    def _enrich(self, plant: dict) -> dict:
        p = dict(plant)
        evts = p.get("events", [])

        # Days growing — may be negative for future-dated plants
        p["days_growing"] = _days_since(p.get("start_date"))
        dg = p["days_growing"]
        p["days_until_planting"] = max(0, -dg) if dg is not None else None
        p["is_scheduled"] = bool(dg is not None and dg < 0)

        # ── Watering tracking ──────────────────────────────────────────────
        # last_watered is the most recent date the plant received water,
        # whether by manual log, an auto rain_detected event, OR an observed
        # rain entry in the weather_log (in case the coordinator wrote the
        # weather log but didn't get a chance to fan out rain_detected events
        # — e.g. plant added AFTER a recent rain).
        #
        # Resolution order, most recent date wins:
        #   1. Most recent EVENT_WATERED or EVENT_RAIN_DETECTED on plant
        #   2. Most recent weather_log entry with rain=True, but only for
        #      days on/after the plant's start_date and on/before today
        #   3. If neither, fall back to the plant's start_date — i.e. the
        #      plant has been "dry" since it was planted. This makes
        #      needs_water actually fire for plants that have never been
        #      manually watered.
        weather_log = self._data.get("weather_log") or {}
        start_date_str = p.get("start_date") or ""
        # Step 1: scan plant events
        last_w_evt = last_f = None
        for e in reversed(evts):
            if not last_w_evt and e["type"] in (EVENT_WATERED, EVENT_RAIN_DETECTED):
                last_w_evt = e["date"]
            if not last_f and e["type"] == EVENT_FERTILIZED:
                last_f = e["date"]
            if last_w_evt and last_f:
                break
        # Step 2: scan weather_log for rain on days within the plant's lifetime.
        # Only consider days >= start_date (rain BEFORE the plant existed
        # doesn't water it) and <= today (no future rain).
        today_iso = date.today().isoformat()
        last_w_rain = None
        if weather_log and start_date_str:
            # Only look at days that could have watered this plant
            rain_days = [
                ds
                for ds, w in weather_log.items()
                if (
                    isinstance(w, dict)
                    and w.get("rain")
                    and ds >= start_date_str
                    and ds <= today_iso
                )
            ]
            if rain_days:
                last_w_rain = max(rain_days)
        # Pick the most recent of event-based or weather-log-based watering
        last_w = max(filter(None, [last_w_evt, last_w_rain]), default=None)
        # Step 3: fall back to start_date for the "never been watered" case.
        # We expose this under a separate flag so the UI can show "never
        # watered" rather than implying the start day was a watering day.
        never_watered = last_w is None
        baseline = last_w or start_date_str or None

        p["last_watered"] = last_w  # actual most-recent water event (None if never)
        p["last_fertilized"] = last_f
        # days_since_watered uses the baseline (start_date fallback) so that
        # plants planted in the past with no watering yet correctly trigger
        # needs_water. This is the value the needs_water sensor compares
        # against watering_min_days.
        p["days_since_watered"] = _days_since(baseline) if baseline else None
        p["days_since_fertilized"] = _days_since(last_f)
        p["never_watered"] = bool(never_watered and start_date_str)
        # Surface whether the most recent watering came from rain (so the UI
        # can show a 🌧 indicator instead of just "needs water")
        if last_w_rain and last_w_rain == last_w:
            p["last_water_source"] = "rain"
        elif last_w_evt and last_w_evt == last_w:
            # Check whether that event was specifically a rain_detected
            for e in evts:
                if e.get("date") == last_w_evt and e.get("type") == EVENT_RAIN_DETECTED:
                    p["last_water_source"] = "rain"
                    break
            else:
                p["last_water_source"] = "manual"
        else:
            p["last_water_source"] = None

        sorted_evts = sorted(evts, key=lambda e: e["date"], reverse=True)
        p["events_sorted"] = sorted_evts
        p["recent_events"] = sorted_evts[:100]

        # ── Verdantly-derived convenience fields ──────────────────────────
        # `species_data` is the raw Verdantly variety object (one element from
        # the search response's `data` array). It carries everything we need
        # inline — growingRequirements.*, species.*, taxonomy.*, ecology.*,
        # lifecycleMilestones.*, safety.toxicity.*, growthDetails.*, etc.
        # Below we flatten it into top-level plant attributes so the card and
        # sensors don't have to dig through the nested shape.
        sd = p.get("species_data") or {}
        ov = p.get("user_overrides") or {}

        # Nested-section shorthand for the most-referenced sub-objects
        gr = sd.get("growingRequirements") or {}
        gd = sd.get("growthDetails") or {}
        lm = sd.get("lifecycleMilestones") or {}
        sp = sd.get("species") or {}
        tx = sp.get("taxonomy") or {}
        eco = sd.get("ecology") or {}
        safety = sd.get("safety") or {}
        tox = safety.get("toxicity") or {}

        def pick(key, *path_or_default, default=None):
            """Return the user override for `key` if set, otherwise look up
            from a dotted path inside `sd`. Empty / None / empty-list always
            fall through to the default.

            Two call styles supported:
              pick("common_name", default="")             — only override + flat lookup
              pick("light_requirements", gr, "sunlightRequirement", default="")
                — override, else gr["sunlightRequirement"], else default
            """
            # 1. user override wins
            if key in ov:
                v = ov[key]
                if v not in (None, "", []):
                    return v
            # 2. nested path lookup (if a section dict was passed)
            if path_or_default and isinstance(path_or_default[0], dict):
                section = path_or_default[0]
                field = path_or_default[1] if len(path_or_default) > 1 else key
                v = section.get(field)
                if v not in (None, ""):
                    return v
                return default
            # 3. flat lookup on sd
            v = sd.get(key)
            if v not in (None, "", []):
                return v
            return default

        # ── Naming ────────────────────────────────────────────────────────
        # Verdantly returns common name + scientific name under `species`,
        # PLUS a per-variety `name` field at the top level (often the
        # cultivar/variety name like "Abe Lincoln Original Tomato").
        # We prefer the variety name when present since it's more specific.
        species_common = sp.get("commonName") or ""
        species_sci = sp.get("scientificName") or ""
        variety_name = sd.get("name") or ""
        p["common_name"] = (
            ov.get("common_name") or variety_name or species_common or species_sci
        )
        p["scientific_name"] = ov.get("scientific_name") or species_sci or ""
        p["common_names"] = [p["common_name"]] if p["common_name"] else []
        # Variety / cultivar name surfaced for the trading card subtitle
        p["variety_name"] = variety_name or ""
        # Symbol field kept for backward compat with the v0.3.0 card markup
        # (used to hold APIFarmer's short code). Empty for Verdantly.
        p["symbol"] = ""

        # ── Light requirements ────────────────────────────────────────────
        # Verdantly's `growingRequirements.sunlightRequirement` is a string
        # like "Full Sun", "Partial Shade". Used directly with no mapping.
        p["light_requirements"] = (
            ov.get("light_requirements") or gr.get("sunlightRequirement") or ""
        )
        p["sunlight"] = [p["light_requirements"]] if p["light_requirements"] else []

        # ── Water needs (categorical) + min/max day projection ────────────
        # Verdantly's `growingRequirements.waterRequirement` is a categorical
        # string ("Low" / "Moderate" / "High"). We project to a (min, max)
        # days range so the existing needs_water plumbing keeps working.
        # User can override watering_min_days / watering_max_days per plant.
        water_req_raw = ov.get("water_use") or gr.get("waterRequirement") or ""
        p["water_use"] = water_req_raw
        p["water_requirement"] = water_req_raw  # alias for the new API name
        default_min, default_max = _water_requirement_to_day_range(water_req_raw)
        ov_min = ov.get("watering_min_days")
        ov_max = ov.get("watering_max_days")
        p["watering_min_days"] = (
            _coerce_int(ov_min) if _coerce_int(ov_min) is not None else default_min
        )
        p["watering_max_days"] = (
            _coerce_int(ov_max) if _coerce_int(ov_max) is not None else default_max
        )
        # Defaults surfaced so the override-form placeholders can show them
        p["watering_default_min_days"] = default_min
        p["watering_default_max_days"] = default_max
        # Friendly display value e.g. "3-7" or "3"
        if p["watering_min_days"] is not None and p["watering_max_days"] is not None:
            p["watering_benchmark_value"] = (
                f"{p['watering_min_days']}-{p['watering_max_days']}"
            )
        elif p["watering_min_days"] is not None:
            p["watering_benchmark_value"] = str(p["watering_min_days"])
        else:
            p["watering_benchmark_value"] = None
        p["watering_benchmark_unit"] = "days"

        # ── Hardiness zones (now back, from growingRequirements) ──────────
        hz_min = pick("hardiness_zone_min", gr, "minGrowingZone")
        hz_max = pick("hardiness_zone_max", gr, "maxGrowingZone")
        p["hardiness_zone_min"] = hz_min
        p["hardiness_zone_max"] = hz_max
        # Pre-composed range string for display
        if hz_min is not None and hz_max is not None and hz_min != hz_max:
            p["hardiness_zone_range"] = f"{hz_min}–{hz_max}"
        elif hz_min is not None:
            p["hardiness_zone_range"] = str(hz_min)
        elif hz_max is not None:
            p["hardiness_zone_range"] = str(hz_max)
        else:
            p["hardiness_zone_range"] = ""

        # ── Soil preference, spacing, growth period, care instructions ────
        p["soil_preference"] = pick("soil_preference", gr, "soilPreference", default="")
        p["spacing_requirement"] = pick(
            "spacing_requirement", gr, "spacingRequirement", default=""
        )
        p["growth_period"] = pick("growth_period", gd, "growthPeriod", default="")
        p["care_instructions"] = pick(
            "care_instructions", gr, "careInstructions", default=""
        )

        # ── pH range ──────────────────────────────────────────────────────
        ph_min = pick("soil_ph_min", eco, "soilPhMin")
        ph_max = pick("soil_ph_max", eco, "soilPhMax")
        p["soil_ph_min"] = ph_min
        p["soil_ph_max"] = ph_max
        if ph_min is not None and ph_max is not None and ph_min != ph_max:
            p["soil_ph_range"] = f"{ph_min}–{ph_max}"
        elif ph_min is not None:
            p["soil_ph_range"] = str(ph_min)
        elif ph_max is not None:
            p["soil_ph_range"] = str(ph_max)
        else:
            p["soil_ph_range"] = ""

        # ── Harvest range (days to harvest) ───────────────────────────────
        h_min = pick("days_to_harvest_min", lm, "daysToHarvestMin")
        h_max = pick("days_to_harvest_max", lm, "daysToHarvestMax")
        p["days_to_harvest_min"] = h_min
        p["days_to_harvest_max"] = h_max
        if h_min is not None and h_max is not None and h_min != h_max:
            p["harvest_range"] = f"{h_min}–{h_max} days"
        elif h_min is not None:
            p["harvest_range"] = f"{h_min} days"
        elif h_max is not None:
            p["harvest_range"] = f"{h_max} days"
        else:
            p["harvest_range"] = ""

        # ── Toxicity ──────────────────────────────────────────────────────
        # `safety.toxicity` is keyed by species name (humans, horses, cats,
        # dogs, etc.). Each value is an object with `level` ("mild",
        # "moderate", "severe", "non-toxic", etc.). We surface:
        #   - toxicity_species: the full list of species keys (unfiltered),
        #     useful for automations that want to flag ANY toxicity entry.
        #   - toxicity_display: a user-facing string that EXCLUDES species
        #     marked "non-toxic" or "mild" (per user spec — these aren't
        #     concerning enough to warn about). When everything was filtered
        #     out (or no toxicity data at all), display "Non-toxic" so the
        #     card doesn't show a dash for what's actually safety info.
        tox_keys = list(tox.keys()) if isinstance(tox, dict) else []
        p["toxicity_species"] = tox_keys
        # Levels we treat as "not worth warning about" — per user request,
        # filtered out of the display string. Anything else (moderate,
        # severe, toxic, highly toxic, unknown level) is shown.
        benign_levels = {"non-toxic", "nontoxic", "none", "mild", "low", ""}
        if tox_keys:
            concerning = []
            for k in tox_keys:
                level = ""
                v = tox.get(k)
                if isinstance(v, dict):
                    level = (v.get("level") or "").strip().lower()
                if level in benign_levels:
                    continue
                concerning.append(f"{k} ({level})" if level else k)
            p["toxicity_display"] = ", ".join(concerning) if concerning else "Non-toxic"
        else:
            p["toxicity_display"] = "Non-toxic"

        # ── Invasive alert (ecology.isInvasive can be null/true/false) ────
        # Override allowed so the user can flag a plant invasive themselves.
        if "invasive_alert" in ov:
            p["invasive_alert"] = bool(ov["invasive_alert"])
        else:
            p["invasive_alert"] = bool(eco.get("isInvasive"))

        # ── Taxonomy footer (family | genus | species) ────────────────────
        p["taxonomy_family"] = tx.get("family") or ""
        p["taxonomy_genus"] = tx.get("genus") or ""
        p["taxonomy_species"] = tx.get("species") or ""
        # Compose a "family | genus | species" display string, skipping
        # empty parts so we don't show "Solanaceae | Solanum | "
        tax_parts = [
            t
            for t in (p["taxonomy_family"], p["taxonomy_genus"], p["taxonomy_species"])
            if t
        ]
        p["taxonomy_display"] = " | ".join(tax_parts)

        # ── Image ─────────────────────────────────────────────────────────
        # Verdantly puts the image URL at the top level. User override wins.
        p["image_url"] = ov.get("image_url") or sd.get("imageUrl") or None
        p["image_attribution"] = sd.get("imageAttribution") or ""
        p["image_license"] = sd.get("imageLicense") or ""

        # ── Description (replaced by care_instructions on the card) ───────
        p["description"] = ov.get("description") or sd.get("description") or ""

        # ── Fields we no longer surface but keep present for back-compat ──
        # APIFarmer/Flora era leftovers — empty strings/Nones so the card
        # doesn't throw on `.toLowerCase()` etc.
        p["active_growth_period"] = ""
        p["plant_type"] = ""
        p["fruiting_period"] = ""
        p["root_depth_inches"] = None
        p["cold_stratification"] = ""
        p["growth_rate"] = ""
        p["habitat"] = pick("habitat", default="")
        p["soil_moisture"] = ""
        p["moisture_use"] = water_req_raw  # alias for the watering form
        p["flowering_seasons"] = []
        p["flowering_season"] = None
        p["harvest_season"] = None
        p["noxious"] = None
        p["noxious_flag"] = False
        p["poisonous_to_pets"] = "cats" in tox or "dogs" in tox
        p["poisonous_to_humans"] = "humans" in tox
        p["hardiness_map_url"] = None
        p["hardiness_map_iframe"] = None

        # Surface the override dict so the card can pre-fill the edit form
        p["user_overrides"] = dict(ov)

        return p


def _coerce_int(v) -> int | None:
    """Best-effort int conversion; returns None on failure or empty."""
    if v is None or v == "":
        return None
    try:
        return int(v)
    except ValueError, TypeError:
        try:
            return int(float(v))
        except ValueError, TypeError:
            return None


def _water_requirement_to_day_range(water_req: str) -> tuple[int | None, int | None]:
    """Project Verdantly's `waterRequirement` to a (min, max) watering
    interval in days. Used as the default threshold for the needs_water
    sensor + automations when no per-plant override is set.

    Verdantly's enum (observed values): Low / Moderate / High. We also
    accept "Medium" since some downstream callers / overrides may use it.

    Mapping:
      - Low      → (7, 14)    drought-tolerant
      - Moderate → (3, 7)     standard garden plant
      - Medium   → (3, 7)     alias for Moderate
      - High     → (1, 3)     thirsty / aquatic
      - other    → (None, None)  caller decides default
    """
    if not water_req:
        return (None, None)
    key = str(water_req).strip().lower()
    if key == "low":
        return (7, 14)
    if key in ("moderate", "medium", "average"):
        return (3, 7)
    if key == "high":
        return (1, 3)
    return (None, None)


# Legacy helper aliases — older callers may still reference these names
def _moisture_use_to_day_range(v):
    return _water_requirement_to_day_range(v)
