"""Async client for the Verdantly Gardening API, hosted on RapidAPI.

Auth requires TWO headers (RapidAPI's standard):
    x-rapidapi-key:  <user's RapidAPI subscription key>
    x-rapidapi-host: verdantly-gardening-api.p.rapidapi.com

Endpoint we use:
    GET /v1/plants/varieties/search?q=<term>&page=1&sortOrder=asc
        (more params accepted; we keep it minimal)

Response envelope:
    {
      "data": [ {plant-detail-object}, ... ],
      "meta": { "totalCount": N, "page": 1, "perPage": 10, "pages": N, "nextCursor": null }
    }

Each search result is a FULL plant-detail object — there's no separate
/detail-by-id endpoint to call. This means add_plant costs exactly ONE
API call (the search itself), and re-opening a plant's trading card is
free (data comes from the cached species_data on the plant record).

Reference: https://rapidapi.com/verdantly-team-verdantly-team-default/api/verdantly-gardening-api
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlencode

import aiohttp

from .const import (
    VERDANTLY_BASE_URL,
    VERDANTLY_HOST,
    VERDANTLY_SEARCH_ENDPOINT,
)

_LOGGER = logging.getLogger(__name__)
TIMEOUT = 20  # seconds — RapidAPI proxy adds some latency
DEFAULT_PAGE_SIZE = 10  # Verdantly's default; can be raised but we paginate anyway


class VerdantlyAuthError(Exception):
    """Invalid, expired, or unsubscribed RapidAPI key."""


class VerdantlyConnectionError(Exception):
    """Cannot reach the Verdantly API host."""


class VerdantlyRateLimitError(Exception):
    """Hit the Verdantly / RapidAPI rate limit or monthly quota."""


class VerdantlyNotFoundError(Exception):
    """Verdantly returned 404 — typically a malformed identifier."""


class VerdantlyApiError(Exception):
    """Other Verdantly error (5xx, parse error, etc.)."""


class VerdantlyApiClient:
    """Async client for the Verdantly Gardening API on RapidAPI.

    Public surface kept compatible with the previous API clients so the
    rest of the integration doesn't need sweeping changes:
      * validate()                          → key works?
      * search_plants(query, state=None)    → list of plant detail objects.
                                              `state` is accepted but ignored
                                              (Verdantly has no state filter).
      * get_species_detail(identifier)      → no-op shim. Verdantly returns
                                              full detail inline in search
                                              responses, so this just returns
                                              an empty dict.

    `on_request` is an optional callback invoked before each outbound HTTP
    request — used by ApiUsageTracker to count daily API hits.
    """

    def __init__(
        self,
        key: str,
        session: aiohttp.ClientSession,
        on_request=None,
    ) -> None:
        self._key = key
        self._session = session
        self._on_request = on_request

    async def _get(self, endpoint: str, params: dict | None = None) -> tuple[Any, str]:
        """Issue a GET to a Verdantly endpoint. Returns (parsed_json, safe_url).

        safe_url is the request URL without the API key, suitable for logs.
        """
        all_params = dict(params or {})
        url = f"{VERDANTLY_BASE_URL}{endpoint}"
        safe_url = f"{url}?{urlencode(all_params)}" if all_params else url
        headers = {
            "x-rapidapi-key":  self._key,
            "x-rapidapi-host": VERDANTLY_HOST,
            "Accept":          "application/json",
            "Content-Type":    "application/json",
        }
        if self._on_request:
            try:
                self._on_request(endpoint)
            except Exception as err:
                _LOGGER.debug("Agribud: api-usage callback raised: %s", err)
        try:
            async with asyncio.timeout(TIMEOUT):
                async with self._session.get(url, params=all_params, headers=headers) as r:
                    return await self._handle(r, safe_url), safe_url
        except asyncio.TimeoutError as e:
            raise VerdantlyConnectionError(
                f"Timeout reaching Verdantly API ({safe_url})"
            ) from e
        except aiohttp.ClientConnectionError as e:
            raise VerdantlyConnectionError(
                f"Network error reaching Verdantly: {e}"
            ) from e

    @staticmethod
    async def _handle(r: aiohttp.ClientResponse, safe_url: str) -> Any:
        if r.status == 401 or r.status == 403:
            # RapidAPI returns 401 for missing/bad key and 403 for
            # not-subscribed-to-this-API; treat both as auth errors.
            txt = await r.text()
            raise VerdantlyAuthError(
                "Verdantly rejected the key. Make sure your RapidAPI key is "
                "valid AND you're subscribed to the Verdantly Gardening API. "
                f"Response: {txt[:200]}"
            )
        if r.status == 404:
            raise VerdantlyNotFoundError(
                f"Verdantly returned 404 for {safe_url}."
            )
        if r.status == 429:
            raise VerdantlyRateLimitError(
                "Verdantly / RapidAPI rate limit exceeded — monthly quota "
                "reached or burst limit hit."
            )
        if not r.ok:
            txt = await r.text()
            raise VerdantlyApiError(
                f"Verdantly HTTP {r.status} for {safe_url}: {txt[:200]}"
            )
        try:
            return await r.json()
        except Exception as e:
            raise VerdantlyApiError(
                f"Could not parse Verdantly JSON response: {e}"
            ) from e

    # ── Public methods ────────────────────────────────────────────────────────

    async def validate(self) -> bool:
        """Validate the key with a single cheap search call.
        Costs one API request against the user's RapidAPI quota."""
        params = {"q": "tomato", "page": 1, "sortOrder": "asc"}
        await self._get(VERDANTLY_SEARCH_ENDPOINT, params)
        return True

    async def search_plants(
        self, query: str, state: str | None = None,
    ) -> tuple[list[dict], str]:
        """Search plant varieties by name (matches against common name,
        scientific name, and variety/cultivar name).

        Returns (results, url_used). `url_used` is the safe URL (no key) for
        diagnostic display. Each item in `results` is a complete
        plant-detail object — no follow-up calls needed.

        `state` is accepted for API compatibility with the previous Flora
        client but ignored — Verdantly doesn't filter by US state.
        """
        if state:
            _LOGGER.debug(
                "Verdantly: state=%r supplied but ignored (Verdantly has no "
                "state filter)", state,
            )
        params: dict[str, Any] = {
            "q": query,
            "page": 1,
            "sortOrder": "asc",
        }
        _LOGGER.debug("Verdantly search: q=%r", query)
        resp, url_used = await self._get(VERDANTLY_SEARCH_ENDPOINT, params)

        results: list[dict] = []
        if isinstance(resp, dict):
            data = resp.get("data")
            if isinstance(data, list):
                results = [r for r in data if isinstance(r, dict)]
                meta = resp.get("meta") or {}
                _LOGGER.info(
                    "Verdantly: q=%r → %d results (page %s of %s, total %s)",
                    query, len(results),
                    meta.get("page"), meta.get("pages"), meta.get("totalCount"),
                )
            elif isinstance(data, dict):
                # Defensive — Verdantly is documented to return a list, but
                # if it ever wraps a single result as a dict we still cope.
                results = [data]
                _LOGGER.info("Verdantly: q=%r → 1 result (single-dict shape)", query)
            else:
                _LOGGER.warning(
                    "Verdantly: unexpected response shape for q=%r — top-level "
                    "keys: %s",
                    query, list(resp.keys()),
                )
        elif isinstance(resp, list):
            # Even more defensive — accept a bare array if the API ever
            # returns one without the envelope.
            results = [r for r in resp if isinstance(r, dict)]

        # Log the first result's top-level keys so anyone debugging knows
        # what fields are available without needing to dump the whole
        # payload to the log.
        if results:
            _LOGGER.debug(
                "Verdantly first-result top-level keys: %s",
                sorted(results[0].keys()),
            )
        return results, url_used

    async def get_species_detail(self, identifier: int | str) -> dict:
        """No-op shim. Verdantly returns full detail inline in the search
        response, so there's no separate detail endpoint to call. The
        backend caches the search hit on each plant record at add-time,
        and the species view serves from that cache.

        Kept for API compatibility with the previous Flora/APIFarmer clients
        (which DID have detail endpoints). Always returns empty.
        """
        _LOGGER.debug(
            "Verdantly: get_species_detail called for %s — Verdantly has no "
            "detail endpoint, returning {}. The card should pass species_data "
            "directly via add_plant to avoid this path.",
            identifier,
        )
        return {}


# Provider-agnostic aliases — kept so existing imports keep working through
# the API swap without sweeping rename churn.
ApifarmerApiClient        = VerdantlyApiClient
ApifarmerAuthError        = VerdantlyAuthError
ApifarmerConnectionError  = VerdantlyConnectionError
ApifarmerRateLimitError   = VerdantlyRateLimitError
ApifarmerApiError         = VerdantlyApiError
ApifarmerNotFoundError    = VerdantlyNotFoundError
FloraApiClient        = VerdantlyApiClient
FloraAuthError        = VerdantlyAuthError
FloraConnectionError  = VerdantlyConnectionError
FloraRateLimitError   = VerdantlyRateLimitError
FloraApiError         = VerdantlyApiError
PerenualApiClient        = VerdantlyApiClient
PerenualAuthError        = VerdantlyAuthError
PerenualConnectionError  = VerdantlyConnectionError
PerenualRateLimitError   = VerdantlyRateLimitError
PerenualApiError         = VerdantlyApiError
