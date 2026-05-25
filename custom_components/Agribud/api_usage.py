"""Monthly API-call counter for the Verdantly free tier.

The Verdantly Gardening API free tier on RapidAPI allows only 25 calls
per calendar month. This tracker records each outbound API call (via the
`on_request` callback wired into the API client) and persists the count
to HA storage so it survives restarts.

State shape:
    {
      "month_key": "2026-05",     # YYYY-MM of the current counting window
      "count": 7,                 # calls used so far this month
    }

When a new month rolls over (detected on next call or read), the count
resets to zero automatically.
"""
from __future__ import annotations

import datetime as _dt
import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

_LOGGER = logging.getLogger(__name__)

_STORE_KEY     = "agribud.api_usage"
_STORE_VERSION = 1

# Verdantly free-tier quota (calls per calendar month). Surfaced in the
# settings panel + setup wizard so the user knows where they stand.
VERDANTLY_FREE_MONTHLY_QUOTA = 25


def _current_month_key() -> str:
    """Return the YYYY-MM string for the current month."""
    n = _dt.datetime.now()
    return f"{n.year:04d}-{n.month:02d}"


class ApiUsageTracker:
    """Persists a monthly counter of outbound Verdantly API calls."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(hass, _STORE_VERSION, _STORE_KEY)
        self._state: dict = {"month_key": _current_month_key(), "count": 0}
        # Save batching: avoid I/O on every single call. Each record() bumps
        # the in-memory count and flushes asynchronously via the HA loop.
        self._dirty = False

    async def async_load(self) -> None:
        data = await self._store.async_load()
        if isinstance(data, dict) and "month_key" in data:
            self._state = {
                "month_key": str(data.get("month_key") or _current_month_key()),
                "count":     int(data.get("count") or 0),
            }
        self._maybe_reset_month()
        _LOGGER.debug(
            "Agribud usage tracker loaded: month=%s, count=%d/%d",
            self._state["month_key"], self._state["count"],
            VERDANTLY_FREE_MONTHLY_QUOTA,
        )

    def _maybe_reset_month(self) -> None:
        cur = _current_month_key()
        if self._state.get("month_key") != cur:
            _LOGGER.info(
                "Agribud usage tracker: new month %s (was %s) — resetting count.",
                cur, self._state.get("month_key"),
            )
            self._state = {"month_key": cur, "count": 0}
            self._dirty = True

    def record(self) -> None:
        """Record one outbound API call. Called synchronously from the API
        client's `on_request` hook. Saves asynchronously."""
        self._maybe_reset_month()
        self._state["count"] = int(self._state.get("count") or 0) + 1
        self._dirty = True
        # Fire-and-forget save — the API call itself is already in-flight
        # so this won't bottleneck the request.
        try:
            self._hass.async_create_task(self._async_save())
        except Exception as err:
            # Don't let tracking failures break the API call path.
            _LOGGER.debug("Agribud usage tracker save scheduling failed: %s", err)

    async def _async_save(self) -> None:
        if not self._dirty:
            return
        try:
            await self._store.async_save(self._state)
            self._dirty = False
        except Exception as err:
            _LOGGER.warning("Agribud usage tracker save failed: %s", err)

    def current_count(self) -> int:
        """Return the number of API calls recorded this month."""
        self._maybe_reset_month()
        return int(self._state.get("count") or 0)

    def remaining(self) -> int:
        """Return how many calls remain in the user's free-tier monthly quota."""
        return max(0, VERDANTLY_FREE_MONTHLY_QUOTA - self.current_count())

    def month_key(self) -> str:
        """Return the YYYY-MM key for the current counting window."""
        self._maybe_reset_month()
        return self._state["month_key"]

    def as_dict(self) -> dict:
        return {
            "month":     self.month_key(),
            "count":     self.current_count(),
            "remaining": self.remaining(),
            "quota":     VERDANTLY_FREE_MONTHLY_QUOTA,
        }
