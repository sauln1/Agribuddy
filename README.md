# Agribuddy

A Home Assistant integration + Lovelace card for tracking your garden. Plan grow plots, log waterings and harvests, and let the integration warn you when plants need attention based on weather and watering history.

<sup>* Integration developed with assistance from AI.</sup>

![Version](https://img.shields.io/badge/version-1.1.4-1D9E75)
![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2025.1%2B-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
[![HACS](https://img.shields.io/badge/HACS-default-orange.svg?style=flat-square)](https://hacs.xyz)

---

## Features

- **Plant database** — search 440,000+ plant species and 15,000+ cultivated varieties via the [Verdantly Gardening API](https://verdantly.io/docs/introduction). Includes plant data like care instructions, hardiness zones, soil and pH preferences, harvest timing, toxicity warnings, and more.
- **Grow plots** — organize plants into named beds or containers. See at a glance which plants live where.
- **Watering automation** — each plant gets a per-species watering schedule (e.g. "Moderate" = 3-7 days). Plants overdue for water surface as "Thirsty" with a 💧 badge. Rain detected on your weather entity counts as a watering automatically, so your plants don't get marked thirsty after a storm.
- **Frost protection** — plants enter a "Frost danger" state when your weather entity forecasts freezing temperatures tonight. Status icon turns red on the dashboard.
- **Plant statuses** — five states exposed on each plant's sensor entity, easily added to automations or scenes: `scheduled`, `healthy`, `thirsty`, `danger`, `harvested`, `dead`.
- **Calendar view** — week or season layouts. Week shows watering, harvest, sprout, and rain dots per day. Season shows every plant you started in Spring 2026, with its current/end status.
- **6-month soft delete + archival** — removing a plant keeps its species data for 6 months so you can re-add the same variety with zero API calls. After 6 months, a slim history record (name, dates, events) is preserved indefinitely so your seasonal history never disappears. All data stored locally.
- **User overrides** — Verdantly missing a value or just wrong for your specific plant? Override any field per-plant via the trading card's Edit details overlay. Original Verdantly data stays cached; overrides are layered on top (New plants can be suggested to Verdantly via their website).
- **Themed Lovelace card** — modern card design that matches the rest of the HA UI. Auto / portrait / landscape layout toggle. Plant image (Verdantly-supplied or emoji fallback), light/water tiles, key/value detail grid, scrollable care instructions, taxonomy footer.

---

## Requirements

- Home Assistant 2025.12 or later
- A weather entity (HA's built-in weather integration, MQTT weather sensor, template, or any entity exposing the standard weather attributes)
- A free RapidAPI account + Verdantly Gardening API subscription. See setup below. itnis highly recommended to purchase a higher tier for Verdantly API for larger gardens or setups!
---

## Installation

### Via HACS (recommended)

1. Open HACS in Home Assistant.
2. Go to **Integrations** → click the ** ⋮**menu → **Custom repositories**.
3. Add this repository URL with category **Integration**:
   `https://github.com/sauln1/agribuddy`
4. Search for "Agribuddy" in HACS and install it.
5. Restart Home Assistant.
6. Repeat steps 2–4 under HACS → **Frontend** to install the [dashboard card](https://github.com/sauln1/agribuddy-card).

### Manual install

1. Download the latest release zip from the [Releases](https://github.com/sauln1/agribuddy/releases) page and the card [Release-Agribuddy-Card](https://github.com/sauln1/agribuddy-card/releases).
2. Extract into your HA config directory so you have:
   - `config/custom_components/agribuddy/` (the integration)
   - `config/www/agribuddy-card/` (the dashboard card)
3. Add the card resource in HA: **Settings → Dashboards → ⋮ → Resources → Add resource**:
   - URL: `/local/agribuddy-card/agribuddy-card.js?v=1`
   - Resource type: **JavaScript Module**
4. Restart Home Assistant.

---

## Setup

### 1. Get a Verdantly API key (free)

1. Go to [RapidAPI's Verdantly Gardening API page](https://rapidapi.com/verdantly-team-verdantly-team-default/api/verdantly-gardening-api).
2. Sign up for a free RapidAPI account.
3. Subscribe to the **Basic (Free)** plan — 25 API calls per month, no credit card required.
4. Ensure your RapidAPI app/console is set to API "V1".
5. Copy your **X-RapidAPI-Key** from the dashboard. This is what Agribuddy needs.

### 2. Add the integration

1. Go to **Settings → Devices & Services → Add Integration**.
2. Search for **Agribuddy**.
3. Paste your RapidAPI key when prompted. Agribuddy doesn't validate the key on setup (validation would burn 1 of your 25 monthly calls) — the first plant search will surface any auth issues.
4. Pick your weather entity. Any entity works — a `weather.*` entity, a sensor that exposes temperature/precipitation attributes, a template entity, etc.

### 3. Add the card to your dashboard

1. Edit your dashboard → **+ Add Card** → search for **Agribuddy**.
2. (Optional) Set a card title and starting layout. Defaults are sensible.
3. Save.

The integration also creates one sensor entity per added plant: `sensor.<plant_name>` with state `healthy` / `thirsty` / `danger` / `harvested` / `dead` / `scheduled`. Use these directly in automations.

---

## NOTE: Free Tier API call budget (the 25/month free tier)

Verdantly's free Basic plan caps you at **25 API calls per month**. Agribuddy is built around this constraint with aggressive caching. Upgrade to a paid RapidAPI tier for more calls. The integration works agnostic of selected plan.

---

## How statuses work

Each plant's sensor reports one of six states:

| State | When | Color | Icon |
|---|---|---|---|
| `scheduled` | `start_date` is in the future | Blue | 📅 |
| `healthy` | Default — watered recently, no frost | Green | 🌱 |
| `thirsty` | `days_since_watered ≥ watering_min_days` | Orange | 💧 |
| `danger` | Frost forecast on weather entity | Red | ❄️ |
| `harvested` | Harvest event logged — terminal until plant deleted | Grey | 🧺 |
| `dead` | Dead event logged — terminal until plant deleted | Dark grey | 💀 |

Frost takes precedence over thirsty (more urgent). Dead trumps harvested (a dead plant wasn't harvested).

The watering threshold values are estimated lengths of time that derive from Verdantly's `waterRequirement` field:
- **Low** → check every 7–14 days
- **Moderate** → check every 3–7 days
- **High** → check every 1–3 days

Both bounds are per-plant overridable in the trading card's Edit details overlay.

Rain detected on your weather entity counts as a watering — Agribuddy logs a `rain_detected` event automatically and the plant's badge shows 🌧 (blue) for a few days afterward.

---
## Agribuddy Card
This integration is meant to be used with the [Agribuddy-card companion](https://github.com/sauln1/agribuddy-card)

## Layout
<img width="1316" height="427" alt="agribuddy-img" src="https://github.com/sauln1/Agribuddy/blob/b207292199051d1a201423558d7cc8fa410f1828/agribud-img.png" />

The card supports three layouts:

- **Auto** (default) — adapts based on screen width. Viewport ≤ 600px → portrait, larger → landscape.
- **Portrait** — phone-optimized. Metrics in 2×2 grid, plant table as a card stack, plant image shortened.
- **Landscape** — desktop/tablet optimized. Metrics in 4-across row, plant table horizontal, full plant.

Set via **Settings → Card display → Layout** (Bootstrap-style toggle group). Preference is per-browser (localStorage).

---

## Available services

| Service | Description |
|---|---|
| `agribuddy.add_plant` | Add a plant. Used internally by the card; can be called from automations to bulk-import. |
| `agribuddy.remove_plant` | Soft-delete a plant (keeps cache 6 months, then archives history-only forever). |
| `agribuddy.log_event` | Log an event (watered, fertilized, pest, harvested, dead, transplanted, sprouted, snow, other). |
| `agribuddy.remove_event` | Remove a previously logged event. |
| `agribuddy.update_plant` | Edit plant metadata (name, start date, location, etc.). Re-anchors the calendar's "planted" marker if start_date changes. |
| `agribuddy.update_plant_overrides` | Set per-plant Verdantly field overrides. Empty string removes an override. |

See HA's **Developer Tools → Services** for the full schema of each.

---

## Storage layout

Agribuddy stores data in `.storage/agribuddy.plants`:

```json
{
  "plants":          { "<id>": { ... full plant record ... }, ... },
  "plots":           { "<id>": { ... plot record ... }, ... },
  "archived_plants": { "<id>": { slim history record }, ... },
  "weather_log":     { "2026-05-12": {"rain": true, "snow": false, ...}, ... }
}
```

Soft-deleted plants stay in `plants` for 180 days with a `deleted_at` timestamp; their species data continues feeding the Recent Plants chip strip. After 180 days, `_archive_old_deleted_plants()` moves them to `archived_plants` as slim history records keeping only id/name/start_date/end_date/end_status/events.

API usage tracking lives in `.storage/agribuddy.api_usage` keyed by `YYYY-MM`. Resets at the start of each month.

---

## Troubleshooting

**"404 Error" code** - if you are getting a 404 error code when adding a new plant, thisnis usually due to not having the integration set up completely, make sure you complete Step 2 under Setup.

**"Verdantly rejected this key"** — the key is wrong or you haven't subscribed to the Verdantly Gardening API on RapidAPI. Double-check by visiting the API page on RapidAPI and confirming the **Subscribe** button is grey ("Subscribed").

**"⛔ quota exhausted"** — you've hit your maximum number of calls for the month. Wait for the monthly reset or upgrade to a higher RapidAPI tier. Adding plants you already have in the Recent Plants strip doesn't burn calls.

**Plant card shows blank fields** — the plant might be from before Verdantly migration. Delete it and re-add via search.

**Status entity stuck at "unknown"** — the coordinator hasn't completed its first refresh. Wait 5–10 seconds after HA startup. If it persists, check HA logs for `agribuddy` errors.

**Card version mismatch warning** — the JavaScript and Python versions don't match. Make sure you replaced BOTH the integration directory and the card file, then bump the resource URL cache-buster (`?v=N` → `?v=N+1`) and hard-refresh.

For other issues, check `Settings → System → Logs` and filter for `agribuddy`. The logger is verbose at INFO level.

---

## Privacy

Agribuddy talks to one external API: Verdantly via RapidAPI, only when you search for or add a plant. The query sent is the plant name you typed (e.g. "tomato"). No location data, no plant photos, nothing about your installation is transmitted.

Weather data is read entirely from your local HA weather entity. Plant records, events, photos, and overrides live in your HA `.storage/` directory and are never sent anywhere.

---

## Future Feature Plans
- **Add Custom Plants** - Create and add completely custom plants that are saved locally.
- **Soil Moisture Sensor Integration** - Add your soil moisture sensors to increase water need accuracy.
- **Grow Plot Planner** -  Visually manage and organize your grow plots with a build in grid.
- **Global Data** - Expand available data beyond US based plants.
- **Expanded Plant Details** - More visualizations and details for available plants.

--

## Credits

Plant data: [Verdantly Gardening API](https://verdantly.io)
Author: Nick Saul (@sauln1)

---

## License

MIT
