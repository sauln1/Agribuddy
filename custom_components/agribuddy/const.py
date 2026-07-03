"""Constants for the Agribuddy integration (Verdantly Gardening API edition,
served via RapidAPI)."""

DOMAIN = "agribuddy"

# ── Config keys ────────────────────────────────────────────────────────────
CONF_API_KEY = "api_key"
CONF_WEATHER_ENTITY = "weather_entity"
CONF_UPDATE_INTERVAL = "update_interval"
# v1.2.0 — user-entered hardiness zone range (free text, any system: USDA
# "6a", RHS "H5", etc.). Two independent values shown as "low–high". Optional;
# when blank the card shows "Zone –".
CONF_ZONE_LOW = "hardiness_zone_low"
CONF_ZONE_HIGH = "hardiness_zone_high"

# v1.2.2 — card layout preference persisted on the backend so the user's
# choice survives HA restarts / browser refreshes (localStorage alone reset).
# One of "landscape" (default) or "portrait". ("auto" was removed.)
CONF_LAYOUT = "card_layout"
DEFAULT_LAYOUT = "landscape"

# ── Defaults ───────────────────────────────────────────────────────────────
# 24-hour interval. The coordinator only reads weather entity values —
# species data is fetched once when a plant is added (via the search API)
# and cached on the plant record. Never re-fetched on a schedule.
DEFAULT_UPDATE_INTERVAL = 1440  # minutes (24h)
DEFAULT_NAME = "Agribuddy"

# ── Verdantly Gardening API (hosted via RapidAPI) ──────────────────────────
# Auth requires TWO headers per RapidAPI's standard:
#   x-rapidapi-key:  <user's RapidAPI key>
#   x-rapidapi-host: verdantly-gardening-api.p.rapidapi.com
VERDANTLY_BASE_URL = "https://verdantly-gardening-api.p.rapidapi.com"
VERDANTLY_HOST = "verdantly-gardening-api.p.rapidapi.com"
# v1.2.0: switched from /search to /name. The /name endpoint returns the same
# nested shape PLUS the richer fields the radar chart + care-instruction
# dropdowns need (careInstructions.plantingInstructions.*, growthDetails.*).
# Query params: ?q=<term>&page=1  (no sortOrder — /name doesn't use it).
VERDANTLY_SEARCH_ENDPOINT = "/v1/plants/varieties/name"
# RapidAPI marketplace page where users subscribe + get their API key
VERDANTLY_SIGNUP_URL = "https://rapidapi.com/verdantly-team-verdantly-team-default/api/verdantly-gardening-api"

# ── Legacy aliases ─────────────────────────────────────────────────────────
# Older code paths still reference Flora/APIFarmer/Verdantly constants;
# alias them to Verdantly so existing imports keep working through the swap.
APIFARMER_BASE_URL = VERDANTLY_BASE_URL
APIFARMER_SEARCH_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
APIFARMER_DETAILS_ENDPOINT = (
    VERDANTLY_SEARCH_ENDPOINT  # Verdantly has no detail endpoint
)
APIFARMER_GROWTH_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
APIFARMER_REPRODUCTION_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
APIFARMER_STAT_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
APIFARMER_SIGNUP_URL = VERDANTLY_SIGNUP_URL
APIFARMER_DOCS_URL = VERDANTLY_SIGNUP_URL
APIFARMER_FREE_MONTHLY_LIMIT = 0
FLORA_BASE_URL = VERDANTLY_BASE_URL
FLORA_SEARCH_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
FLORA_DETAIL_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
FLORA_SIGNUP_URL = VERDANTLY_SIGNUP_URL
FLORA_DOCS_URL = VERDANTLY_SIGNUP_URL
FLORA_FREE_DAILY_LIMIT = 0
PERENUAL_BASE_URL = VERDANTLY_BASE_URL
PERENUAL_VALIDATE_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
PERENUAL_SEARCH_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
PERENUAL_DETAIL_ENDPOINT = VERDANTLY_SEARCH_ENDPOINT
PERENUAL_SIGNUP_URL = VERDANTLY_SIGNUP_URL
PERENUAL_FREE_DAILY_LIMIT = 0


# ── Plant start types ──────────────────────────────────────────────────────
START_TYPE_SEED = "seed"
START_TYPE_TRANSPLANT = "transplant"
START_TYPE_INDOOR = "indoor_start"  # v1.2.0 — started indoors before transplant
START_TYPES = [START_TYPE_SEED, START_TYPE_INDOOR, START_TYPE_TRANSPLANT]

# ── Manual event types ─────────────────────────────────────────────────────
EVENT_WATERED = "watered"
EVENT_FERTILIZED = "fertilized"
EVENT_PEST = "pest_spotted"
EVENT_BLIGHT = "blight"
EVENT_SNOW = "snow"
EVENT_HARVESTED = "harvested"
EVENT_TRANSPLANTED = "transplanted"
EVENT_INDOOR_START = "indoor_start"  # v1.2.0 — plant started indoors
EVENT_SPROUTED = "sprouted"
EVENT_PLANTED = "planted"
# v1.2.0: the terminal "plant died / was pulled" event was renamed dead→removed.
# EVENT_DEAD kept as a backwards-compat alias so any lingering import resolves;
# a one-time store migration rewrites stored "dead" events to "removed".
EVENT_REMOVED = "removed"
EVENT_DEAD = EVENT_REMOVED
EVENT_OTHER = "other"

MANUAL_EVENT_TYPES = [
    EVENT_WATERED,
    EVENT_FERTILIZED,
    EVENT_PEST,
    EVENT_BLIGHT,
    EVENT_SNOW,
    EVENT_HARVESTED,
    EVENT_TRANSPLANTED,
    EVENT_INDOOR_START,
    EVENT_SPROUTED,
    EVENT_REMOVED,
    EVENT_OTHER,
]

# ── Auto event types ───────────────────────────────────────────────────────
EVENT_RAIN_DETECTED = "rain_detected"
EVENT_FROST_ALERT = "frost_alert"

# Frost detection relies entirely on the weather entity's overnight low —
# APIFarmer doesn't expose USDA hardiness zones or temperature ranges.
DEFAULT_FROST_THRESHOLD_C = 2.0

# ── Storage ────────────────────────────────────────────────────────────────
STORAGE_VERSION = 2
STORAGE_KEY = f"{DOMAIN}.plants"

# ── Services ───────────────────────────────────────────────────────────────
SERVICE_ADD_PLANT = "add_plant"
SERVICE_REMOVE_PLANT = "remove_plant"
SERVICE_LOG_EVENT = "log_event"
SERVICE_REMOVE_EVENT = "remove_event"
SERVICE_UPDATE_OVERRIDES = "update_plant_overrides"
SERVICE_UPDATE_PLANT = "update_plant"

# Service / attribute names
ATTR_PLANT_ID = "plant_id"
ATTR_PLANT_NAME = "plant_name"
ATTR_SPECIES_ID = "species_id"  # Verdantly variety UUID (e.g. "91d05952-...")
ATTR_START_TYPE = "start_type"
ATTR_START_DATE = "start_date"
ATTR_LOCATION = "location"
ATTR_EVENT_ID = "event_id"
ATTR_EVENT_TYPE = "event_type"
ATTR_EVENT_NOTE = "note"
ATTR_EVENT_DATE = "date"
