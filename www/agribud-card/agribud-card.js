/**
 * Agribud Card  v1.1.1
 * type: custom:agribud-card
 *
 * v1.1.0 — Theme toggle + section reorder + scroll containers
 *  - New Settings → Card display → Theme toggle (Light / Dark). Light uses
 *    HA theme variables so custom themes are respected; Dark uses a
 *    coordinated dark palette with a warm peach accent. Persisted per
 *    browser via localStorage (key: agribud:theme).
 *  - Main view sections reordered: Planner → Plants → Grow plots
 *    (was Planner → Grow plots).
 *  - New Plants section on the main view uses the existing trading-card
 *    table template, capped at ~5 rows visible with internal vertical
 *    scrolling for the rest. Header text shows total count.
 *  - Grow plots converted from a wrapping grid to a horizontal-scroll
 *    strip with fixed 160px tiles supporting two-word names on two lines.
 *    Edge bleed signals there's more content beyond the visible right
 *    edge; touch swipe + scrollbar drag both work.
 *  - New peach gradient alert banner appears at the top of the main view
 *    when one or more plants need watering. Lists the first 3 plant names
 *    inline ("Cherry Tomato · Sunflower · Sunflower"). Dismissible per
 *    session (resets on reload).
 *  - Dark mode pill colors brightened from v1.0.x for better legibility
 *    against dark surfaces.
 *
 * v1.0.0 — Initial public release.
 *  - Stable: Verdantly Gardening API (via RapidAPI), 25 calls/month free
 *    tier with aggressive caching (search cache 30d, full plant detail
 *    inline so add_plant is 0 extra calls, soft-deletion with 6-month
 *    species cache + slim archival after).
 *  - Trading card: modern white surface, plant image with status pill
 *    overlay, soft pastel light/water tiles, kv detail grid, scrollable
 *    care instructions, taxonomy footer. Auto / portrait / landscape
 *    layout toggle (Bootstrap-style segmented control).
 *  - Plant statuses: scheduled / healthy / thirsty / danger / harvested /
 *    dead (terminal events sticky until plant deleted). Status badge on
 *    plant icon in main list. 💧 (overdue), 🌧 (rain-watered), or none.
 *  - Calendar legend: Care + Events sections with column-stacked
 *    label-above-items so mobile doesn't collapse them onto one line.
 *  - Planner views: Week (existing) and Season (replaced Month — list
 *    of plants planted in each season+year with end-status pills).
 *  - Soft-deleted plants kept 6 months in cache (Recent Plants chip
 *    strip lets you re-add at zero API cost). After 6 months, plants
 *    are archived to a slim history-only record (name, dates, events)
 *    preserved indefinitely so the Season view never loses history.
 *  - Per-plant user overrides: every editable Verdantly field can be
 *    overridden via the Edit details overlay; empty values fall back
 *    to the Verdantly response.
 *  - Frost detection from weather entity attributes; rain detection
 *    auto-logs rain_detected events per plant.
 */

const DOMAIN   = "agribud";
const API_BASE = "/api/agribud";

/* ─── Utilities ──────────────────────────────────────────────────────────── */

const daysAgo = n =>
  n == null ? "—" : n === 0 ? "Today" : n === 1 ? "1d ago" : `${n}d ago`;

const isoDisp = iso => {
  if (!iso) return "—";
  try { return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric"}); }
  catch { return iso; }
};

const eventIcon = type => ({
  watered:"💧", fertilized:"🌿", pest_spotted:"🐛", pest:"🐛",
  harvested:"🌾", sprouted:"🌱", transplanted:"🪴", planted:"🌰",
  dead:"💀",
  rain_detected:"🌧️", frost_alert:"❄️", snow:"🌨️",
  needs_water:"💧", other:"📝",
})[type] || "📝";

const evColors = type => {
  if (type==="watered"||type==="rain_detected") return ["#E6F1FB","#185FA5"];
  if (type==="fertilized")   return ["#EAF3DE","#3B6D11"];
  if (type==="frost_alert")  return ["#FAECE7","#993C1D"];
  if (type==="snow")         return ["#E8F0F4","#2E5A7A"];
  if (type==="pest_spotted"||type==="pest") return ["#FAEEDA","#854F0B"];
  if (type==="harvested")    return ["#FFF1D6","#7A4F0A"];
  if (type==="sprouted")     return ["#E6F5DA","#2F6017"];
  if (type==="transplanted") return ["#E1F5EE","#0F6E56"];
  if (type==="planted")      return ["#E5DBC8","#5A4221"];
  if (type==="dead")         return ["#D6D6D6","#2A2A2A"];
  if (type==="needs_water")  return ["#FFF4D6","#9C7008"];
  return ["var(--secondary-background-color)","var(--primary-text-color)"];
};

// Color mapping for planner cell dots — keeps sync with the legend
const PLANNER_EVENT_COLORS = {
  watered:        "#5DCAA5",
  rain_detected:  "#9FE1CB",
  fertilized:     "#C0DD97",
  frost_alert:    "#E24B4A",
  snow:           "#A8C8DD",
  pest_spotted:   "#D4A04A",
  pest:           "#D4A04A",
  harvested:      "#E0A547",
  sprouted:       "#7BC453",
  transplanted:   "#1D9E75",
  planted:        "#8B6F47",
  dead:           "#4A4A4A",
  needs_water:    "#E0B23C",
  other:          "#B0B0B0",
};

// Human-readable event names used by the day-detail overlay & legend
const EVENT_LABELS = {
  watered: "Watered",
  fertilized: "Fertilized",
  pest_spotted: "Pest spotted",
  pest: "Pest spotted",
  harvested: "Harvested",
  sprouted: "Sprouted",
  transplanted: "Transplanted",
  planted: "Planted",
  dead: "Died",
  rain_detected: "Rain",
  frost_alert: "Frost alert",
  snow: "Snow",
  needs_water: "Due for water",
  other: "Other",
};

// Maps a Date to a season key, plus the icon to render in calendar cells.
// Boundaries per user spec.
function seasonForDate(d) {
  const m = d.getMonth(); // 0-11
  const day = d.getDate();
  // Winter: Dec 22 – Mar 20
  if ((m === 11 && day >= 22) || m === 0 || m === 1 || (m === 2 && day <= 20)) return "winter";
  // Spring: Mar 21 – Jun 20
  if ((m === 2 && day >= 21) || m === 3 || m === 4 || (m === 5 && day <= 20)) return "spring";
  // Summer: Jun 21 – Sep 22
  if ((m === 5 && day >= 21) || m === 6 || m === 7 || (m === 8 && day <= 22)) return "summer";
  // Fall: Sep 23 – Dec 21
  return "fall";
}
const SEASON_ICON = { winter: "❄", spring: "💧", summer: "☀", fall: "🍂" };

const plantEmoji = type => {
  if (!type) return "🌱";
  const t = type.toLowerCase();
  if (t.includes("tomato"))     return "🍅";
  if (t.includes("carrot"))     return "🥕";
  if (t.includes("broccoli"))   return "🥦";
  if (t.includes("lettuce"))    return "🥬";
  if (t.includes("pepper"))     return "🌶️";
  if (t.includes("cucumber"))   return "🥒";
  if (t.includes("bean"))       return "🫘";
  if (t.includes("potato"))     return "🥔";
  if (t.includes("onion"))      return "🧅";
  if (t.includes("garlic"))     return "🧄";
  if (t.includes("corn"))       return "🌽";
  if (t.includes("strawberry")) return "🍓";
  if (t.includes("squash") || t.includes("pumpkin")) return "🎃";
  if (t.includes("basil") || t.includes("herb"))     return "🌿";
  return "🌱";
};

const stageBadge = p => {
  if (p.is_scheduled) {
    const dpt = p.days_until_planting ?? 0;
    return [`Planted in ${dpt}d`, "#E6F1FB", "#185FA5"];
  }
  const days = p.days_growing || 0;
  const start = p.start_type === "transplant" ? "Transplant" : "Seed";
  const label = `${start} · Day ${days}`;
  return days < 7  ? [label, "#FAEEDA", "#854F0B"]
       : days < 21 ? [label, "#EAF3DE", "#3B6D11"]
       :             [label, "#E1F5EE", "#0F6E56"];
};

// Compute the visual water-status badge for the main-view plant list.
// Returns:
//   { badge: "<span...>" or "", overdue: bool, source: "manual"|"rain"|null }
// Badge HTML is rendered as a small icon overlayed on the plant emoji /
// thumbnail. Logic:
//   - is_scheduled (planted in future) → no badge (plant doesn't exist yet)
//   - days_since_watered >= watering_min_days → needs water (💧 red badge)
//   - last watering came from rain → 🌧 blue badge (informational, "nature
//     handled it" — only show if we want to surface the source)
//   - otherwise → no badge (plant is happy)
const plantWaterStatus = p => {
  if (p.is_scheduled) return { badge: "", overdue: false, source: null };
  const ds = p.days_since_watered;
  const threshold = p.watering_min_days || 3;
  const overdue = (ds != null) && (ds >= threshold);
  const source = p.last_water_source || null;
  let badge = "";
  if (overdue) {
    badge = `<span class="plant-status-badge plant-status-needs" title="Needs water — ${ds} day${ds===1?"":"s"} since last watered (threshold ${threshold})">💧</span>`;
  } else if (source === "rain") {
    // Show a small raindrop when the most recent watering was from rain —
    // gives the user reassurance that nature has been doing the work.
    badge = `<span class="plant-status-badge plant-status-rain" title="Last watered by rain ${ds!=null ? `(${ds} day${ds===1?"":"s"} ago)` : ""}">🌧</span>`;
  }
  return { badge, overdue, source };
};

// Health colour. Now species-aware: uses each plant's `watering_min_days`
// (parsed from Perenual's watering_general_benchmark.value) as the threshold
// for "needs water". Falls back to a generic 3-day default if not set.
//   - blue:   plant scheduled (start date in the future)
//   - green:  recently watered (or rained), nothing due
//   - yellow: due today (days_since_watered ≥ threshold)
//   - orange: overdue (days_since_watered ≥ threshold + 1)
const healthColor = p => {
  if (p.is_scheduled) return "#185FA5";
  const ds = p.days_since_watered;
  if (ds == null) return "#639922";  // never watered, but don't alarm
  const threshold = p.watering_min_days || 3;
  if (ds >= threshold + 1) return "#BA7517";  // overdue (orange)
  if (ds >= threshold)     return "#D4A04A";  // due today (yellow)
  return "#639922";  // healthy (green)
};

// True if a plant should be watered today (or is overdue).
const needsWater = p =>
  !p.is_scheduled
  && p.days_since_watered != null
  && p.days_since_watered >= (p.watering_min_days || 3);

function getWeatherEntityState(hass, entityId) {
  if (!entityId) return null;
  return hass.states[entityId] || null;
}

function extractAgribudPlants(hass) {
  const plants = [];
  for (const [id, state] of Object.entries(hass.states)) {
    const a = state.attributes || {};
    if (a.plant_id && id.startsWith("sensor.")) {
      plants.push({ entity_id: id, status: state.state, ...a });
    }
  }
  return plants;
}

const integrationReady = hass =>
  Object.keys(hass.states).some(id =>
    id.startsWith("sensor.agribud_") && hass.states[id].state !== "unavailable"
  );

/* ─── CSS ────────────────────────────────────────────────────────────────── */

const CSS = `
:host{display:block}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.card{background:var(--card-background-color,#fff);border-radius:var(--ha-card-border-radius,12px);border:1px solid var(--divider-color,#e0e0e0);padding:1rem 1.25rem;font-family:var(--paper-font-body1_-_font-family,sans-serif);color:var(--primary-text-color);position:relative;overflow:visible}
.toast-stack{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column-reverse;gap:7px;width:calc(100% - 28px);max-width:440px;pointer-events:none}
.toast{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.45;box-shadow:0 4px 18px rgba(0,0,0,.2);pointer-events:all;animation:toastIn .18s ease}
.toast-error{background:#7E1F1F;color:#fff}.toast-success{background:#1D9E75;color:#fff}.toast-info{background:#185FA5;color:#fff}
.toast-icon{font-size:15px;flex-shrink:0;margin-top:1px}.toast-body{flex:1}.toast-title{font-weight:600;margin-bottom:2px}.toast-msg{opacity:.88;font-size:12px}
.toast-close{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;opacity:.7;padding:0;align-self:flex-start;line-height:1}
@keyframes toastIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap}
.hdr-left{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.hdr-title{font-size:15px;font-weight:600}
.hdr-sub{font-size:12px;color:var(--secondary-text-color)}
.hdr-acts{display:flex;align-items:center;gap:8px}
.gear-btn{width:32px;height:32px;border-radius:50%;border:1px solid var(--divider-color);background:var(--secondary-background-color);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--secondary-text-color)}
.gear-btn:hover{background:var(--divider-color)}
.btn{font-size:12px;padding:5px 13px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);cursor:pointer;color:var(--primary-text-color);font-family:inherit;transition:opacity .12s}
.btn:hover{opacity:.78}
.btn-accent{background:#1D9E75;border-color:#0F6E56;color:#fff;font-weight:500}
.btn-danger{color:#993C1D;border-color:#993C1D}
.btn-full{width:100%;padding:9px;margin-top:4px;font-size:13px}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--divider-color);color:var(--secondary-text-color)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.metric{background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:10px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}
.metric:hover{background:var(--divider-color);border-color:var(--primary-text-color)}
.metric-val{font-size:20px;font-weight:600}
.metric-lbl{font-size:11px;color:var(--secondary-text-color);margin-top:2px}
.sec-title{font-size:11px;font-weight:500;letter-spacing:.06em;color:var(--secondary-text-color);text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.divider{border:none;border-top:1px solid var(--divider-color);margin:12px 0}
.plant-table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
.plant-table-wide{table-layout:auto}
.plant-table-wide th{padding:4px 6px 4px 0;white-space:nowrap}
.plant-table-wide td{padding:9px 6px 9px 0}
.plant-table-meta{color:var(--secondary-text-color);font-size:12px;white-space:nowrap}
.plant-table th{text-align:left;font-size:11px;font-weight:500;color:var(--secondary-text-color);padding:4px 0;border-bottom:1px solid var(--divider-color)}
.plant-table td{padding:9px 0;border-bottom:1px solid var(--divider-color);vertical-align:middle}
.plant-table tr:last-child td{border-bottom:none}
.plant-row{cursor:pointer}
.plant-row:hover td{background:var(--secondary-background-color)}
.plant-name-cell{display:flex;align-items:center;gap:7px;font-weight:500}
/* Wrapper for the plant icon/thumbnail on the main list — relative-positioned
   so we can absolutely-place a small status badge on its lower-right corner. */
.plant-icon-wrap{position:relative;width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.plant-status-badge{position:absolute;bottom:-3px;right:-5px;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;box-shadow:0 1px 3px rgba(0,0,0,.18);border:1.5px solid var(--card-background-color,#fff);cursor:help}
.plant-status-needs{background:#FCE2E7}
.plant-status-rain{background:#DCEEFB}
.badge{display:inline-block;font-size:11px;padding:2px 7px;border-radius:6px;font-weight:500}
.chev{color:var(--secondary-text-color);font-size:14px;text-align:right}
/* Plot grid */
.plot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:8px}
/* Plot strip — horizontal scrolling row of fixed-width plot tiles.
   Replaces the wrapping grid as of v1.1.0. Tiles are 160px wide so two-
   word names like "Veggie bed" can break onto two lines comfortably. The
   strip bleeds slightly off the card edges (negative margins on the
   wrapper) so the rightmost tile is visually clipped — that's the
   affordance telling users there's more content past the visible edge. */
.plot-strip-wrap{margin:0 -16px 8px;padding:0 16px 6px;overflow-x:auto;scrollbar-width:thin}
.plot-strip-wrap::-webkit-scrollbar{height:6px}
.plot-strip-wrap::-webkit-scrollbar-thumb{background:var(--divider-color);border-radius:3px}
.plot-strip{display:flex;gap:10px;min-width:max-content}
.plot-strip .plot-card{width:160px;flex-shrink:0}
/* Plants scroll container — keeps the plant table header visible while
   the rows scroll vertically. 300px = ~5 rows at ~58px each plus the
   header band; the rest scrolls inside. In portrait mode the row height
   grows (stacked-card mode), so this height accommodates roughly the
   same row count. */
.plants-scroll{max-height:320px;overflow-y:auto;background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:10px;margin-bottom:8px;scrollbar-width:thin}
.plants-scroll::-webkit-scrollbar{width:6px}
.plants-scroll::-webkit-scrollbar-thumb{background:var(--divider-color);border-radius:3px}
.plot-card{background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:10px;padding:14px;cursor:pointer;transition:border-color .12s,transform .12s}
.plot-card:hover{border-color:#1D9E75;transform:translateY(-1px)}
.plot-card-name{font-size:14px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.plot-card-count{font-size:11px;color:var(--secondary-text-color)}
.plot-card-desc{font-size:11px;color:var(--secondary-text-color);margin-top:6px;line-height:1.4}
.plot-card-add{background:transparent;border:2px dashed var(--divider-color);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--secondary-text-color);min-height:90px}
.plot-card-add:hover{border-color:#1D9E75;color:#1D9E75}
/* Initial-load skeleton — placeholder tile shown while /plots is in flight.
   Pulses subtly so the user knows it's not stalled. */
.plot-card-skeleton{
  background:var(--secondary-background-color);
  border:1px solid var(--divider-color);
  min-height:80px;
  cursor:default;pointer-events:none;
  animation:plot-skeleton-pulse 1.4s ease-in-out infinite;
}
@keyframes plot-skeleton-pulse{
  0%,100%{opacity:.55}
  50%{opacity:.85}
}
/* Plot detail header */
.plot-hdr{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--divider-color)}
.plot-back{background:none;border:none;font-size:13px;cursor:pointer;color:var(--secondary-text-color);padding:0;font-family:inherit}
.plot-back:hover{color:#1D9E75}
.plot-title{font-size:16px;font-weight:600;flex:1}
/* Inline planner */
.planner-controls{display:flex;align-items:center;gap:6px;margin-bottom:10px}
.planner-tab{font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid var(--divider-color);background:transparent;cursor:pointer;color:var(--secondary-text-color);font-family:inherit}
.planner-tab.active{background:#1D9E75;border-color:#0F6E56;color:#fff;font-weight:500}
/* Planner top bar: prev/next + period label */
.planner-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:6px 10px;background:var(--secondary-background-color);border-radius:8px}
.planner-nav-btn{background:transparent;border:1px solid var(--divider-color);color:var(--primary-text-color);font-size:14px;width:28px;height:28px;border-radius:6px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center}
.planner-nav-btn:hover{background:var(--card-background-color)}
.planner-nav-label{font-size:13px;font-weight:600;flex:1;text-align:center}
.planner-nav-today{font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid var(--divider-color);background:transparent;color:var(--secondary-text-color);cursor:pointer;font-family:inherit}
/* Week strip (existing) */
.planner-hdrs{display:flex;padding-left:90px;margin-bottom:4px}
.planner-hdr{flex:1;text-align:center;font-size:11px;color:var(--secondary-text-color)}
.planner-hdr.today{font-weight:600;color:var(--primary-text-color)}
.plan-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.plan-lbl{width:84px;flex-shrink:0;font-size:12px}
.plan-lbl-clickable{cursor:pointer;border-radius:4px;padding:2px 4px;transition:background .12s}
.plan-lbl-clickable:hover{background:var(--secondary-background-color)}
.plan-lbl-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plan-lbl-sub{font-size:10px;color:var(--secondary-text-color)}
.plan-days{flex:1;display:flex}
.plan-cell{flex:1;height:26px;display:flex;align-items:center;justify-content:center;font-size:9px}
.plan-cell.today{background:rgba(29,158,117,.08);border-radius:4px}
.plan-cell.future{opacity:.4}
/* Month calendar grid */
.cal-month{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:6px}
.cal-dow{text-align:center;font-size:10px;color:var(--secondary-text-color);font-weight:600;padding:4px 0;text-transform:uppercase;letter-spacing:.04em}
.cal-day{aspect-ratio:1;min-height:74px;background:var(--secondary-background-color);border-radius:6px;padding:5px;display:flex;flex-direction:column;gap:3px;border:1px solid var(--divider-color);position:relative;cursor:pointer;transition:border-color .1s;overflow:hidden}
.cal-day:hover{border-color:#1D9E75}
.cal-day.other-month{opacity:.35;cursor:default}
.cal-day.other-month:hover{border-color:var(--divider-color)}
.cal-day.today{border-color:#1D9E75;background:rgba(29,158,117,.08)}
.cal-day.future{opacity:.5;cursor:default}
.cal-day.future:hover{border-color:var(--divider-color)}
.cal-day.no-events{cursor:default}
.cal-day.no-events:hover{border-color:var(--divider-color)}
.cal-day-num{font-size:11px;font-weight:600;color:var(--primary-text-color);line-height:1}
.cal-day-head{display:flex;align-items:center;justify-content:space-between;gap:4px}
.cal-day-head-left{display:flex;align-items:center;gap:3px;flex-wrap:wrap;min-width:0}
.cal-day-weather{font-size:10px;line-height:1;display:inline-block}
.cal-day-weather.rain{filter:saturate(1.3)}
.cal-day-weather.frost{color:#5A8AA8}
.cal-day-weather.snow{filter:saturate(1.2)}
/* Season label at the top of each calendar cell — small, greyed-out text
   that identifies the season without competing visually with day numbers
   or event dots. Replaces the previous emoji-based season indicator (which
   was confusing because the spring 💧 looked like a watering icon). */
.cal-day-season-label{font-size:9px;line-height:1.2;text-align:center;text-transform:lowercase;letter-spacing:.04em;opacity:.55;padding:1px 0 2px;border-bottom:1px solid var(--divider-color);margin:-4px -4px 3px;color:var(--secondary-text-color)}
.cal-day-season-label.winter{color:#5A8AA8}
.cal-day-season-label.spring{color:#3F8754}
.cal-day-season-label.summer{color:#C9923B}
.cal-day-season-label.fall{color:#A65A2D}
.cal-evt-dots{display:flex;gap:3px;flex-wrap:wrap;align-items:center}
.cal-evt-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
.cal-day-plants{display:flex;flex-wrap:wrap;gap:2px;align-items:center}
.cal-plant{position:relative;width:18px;height:18px;border-radius:4px;overflow:visible;cursor:pointer;flex-shrink:0;display:inline-block}
.cal-plant img{width:18px;height:18px;border-radius:4px;object-fit:cover;display:block}
.cal-plant-emoji{width:18px;height:18px;font-size:14px;display:flex;align-items:center;justify-content:center;line-height:1}
.cal-plant:hover{transform:scale(1.15);z-index:5}
.cal-plant-status{position:absolute;bottom:-2px;right:-2px;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--secondary-background-color);box-sizing:content-box}
.cal-day.today .cal-plant-status{border-color:#E1F5EE}
.cal-plant-water{position:absolute;top:-6px;left:-6px;font-size:10px;line-height:1;background:#FFF4D6;border-radius:50%;padding:1px;border:1px solid #E0B23C;box-shadow:0 0 0 1px var(--secondary-background-color)}
.cal-plant-needs-water:hover .cal-plant-water{transform:scale(1.2)}
.cal-more{font-size:10px;color:var(--secondary-text-color);font-weight:500;padding:1px 4px}
/* Hardiness tab */
.hardy-zones{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;margin-bottom:12px;padding:12px;background:var(--secondary-background-color);border-radius:8px}
.hardy-zones-label{color:var(--secondary-text-color)}
.hardy-zones-value{font-weight:500;color:var(--primary-text-color)}
.hz-bar-label{font-size:11px;color:var(--secondary-text-color);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.hz-bar{display:grid;grid-template-columns:repeat(13,1fr);gap:3px;margin-bottom:8px}
.hz-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;border-radius:4px;background:var(--secondary-background-color);color:var(--secondary-text-color);border:1px solid var(--divider-color)}
.hz-cell-active{background:#2D5F3F;color:#fff;border-color:#1D4A2D;font-weight:700;box-shadow:0 1px 2px rgba(45,95,63,.3)}
.hz-legend{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--secondary-text-color);margin-bottom:6px}
.hardy-fallback{padding:10px 0;font-size:12px;color:var(--secondary-text-color)}
.hardy-fallback a{color:#1D9E75;text-decoration:none;font-weight:500}
.hardy-fallback a:hover{text-decoration:underline}
.hardy-empty{padding:30px 14px;text-align:center;font-size:13px;color:var(--secondary-text-color)}
/* Watering benchmark + tips display */
.tip-watering-min{display:inline-block;margin-top:6px;font-size:11px;background:var(--card-background-color);border:1px solid var(--divider-color);padding:3px 8px;border-radius:4px;color:var(--secondary-text-color)}
/* Toxicity warning chips inside tips body */
.tox-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tox-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:10px;background:#FAECE7;color:#993C1D;font-weight:500}
.tox-chip.safe{background:#EAF3DE;color:#3B6D11}
/* API key rate-limit notice */
.rate-notice{margin-top:6px;font-size:11px;padding:8px 10px;background:var(--secondary-background-color);border-left:3px solid #D4A04A;border-radius:4px;color:var(--secondary-text-color);line-height:1.4}
.rate-notice-warning{border-left-color:#E2526A;background:rgba(226,82,106,.06)}
.rate-notice a{color:#1D9E75;text-decoration:none}
/* Day detail overlay list */
.day-list{display:flex;flex-direction:column;gap:8px}
.day-row{display:flex;align-items:center;gap:10px;padding:10px;background:var(--secondary-background-color);border-radius:8px;cursor:pointer;transition:background .1s}
.day-row:hover{background:var(--divider-color)}
.day-row-thumb{width:36px;height:36px;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px;background:var(--card-background-color)}
.day-row-thumb img{width:36px;height:36px;border-radius:6px;object-fit:cover}
.day-row-info{flex:1;min-width:0}
.day-row-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.day-row-events{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.day-row-evchip{display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 7px;border-radius:10px}
.day-row-status{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.evt-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.plan-legend{display:flex;gap:12px 14px;flex-wrap:wrap}
.plan-legend-group{margin-top:12px;display:flex;flex-direction:column;gap:5px}
.leg-row-label{
  font-size:10px;font-weight:600;
  color:var(--secondary-text-color);
  text-transform:uppercase;letter-spacing:.06em;
  padding-bottom:3px;
  border-bottom:1px solid var(--divider-color);
}
.leg-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--secondary-text-color)}
.frost-banner{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--secondary-background-color);border-radius:8px;gap:12px;font-size:12px;color:var(--secondary-text-color);margin-top:10px}
/* Sparkline */
.sparkline-wrap{padding:14px 8px 6px;background:var(--secondary-background-color);border-radius:10px;margin-bottom:14px}
.sparkline-title{font-size:12px;color:var(--secondary-text-color);margin-bottom:8px;padding:0 6px}
.sparkline-now{font-size:22px;font-weight:600;padding:0 6px;margin-bottom:6px}
.sparkline-svg{width:100%;height:60px;display:block}
/* Overlays */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:9999;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto}
.overlay.open{display:flex}
.popup{background:var(--card-background-color,#fff);border:1px solid var(--divider-color);border-radius:14px;width:100%;max-width:580px;margin:auto;box-shadow:0 8px 40px rgba(0,0,0,.22);overflow:hidden}
.popup-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--divider-color);position:sticky;top:0;background:var(--card-background-color,#fff);z-index:1}
.popup-body{padding:16px;max-height:78vh;overflow-y:auto}
/* Trading-card popup variant — wider, taller, no header border, image-led layout */
.popup-card{max-width:480px}
.popup-hdr-minimal{padding:8px 12px;border-bottom:0;background:transparent}
.popup-hdr-action{background:transparent;border:0;font-size:18px;color:var(--secondary-text-color);cursor:pointer;padding:4px 8px;border-radius:6px}
.popup-hdr-action:hover{background:var(--divider-color)}
.popup-body-card{padding:0 16px 16px;max-height:85vh}
/* ── Plant detail "Modern Card" (v0.4.8) ─────────────────────────────────
   Clean white surface that matches the rest of the integration's main view
   aesthetic. Plant image on top with a status pill overlay, name/sci-name
   below, soft pastel light/water tiles, key/value detail grid, scrollable
   care-instruction block, taxonomy footer.

   IDs preserved from earlier eras (tc-image, tc-light-text, etc.) so the
   _openPlantDetail population logic continues to work unmodified — only
   the visual containers changed. */
.tc{
  background:var(--card-background-color, #fff);
  border:0.5px solid var(--divider-color);
  border-radius:14px;
  overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.06);
}
/* Plant image area — soft green gradient backdrop, status pill in
   top-right corner. Image fills the area when present; emoji is rendered
   centered when no image is available. */
.tcm-image{
  position:relative;
  height:140px;
  background:linear-gradient(135deg, #E8F5E9 0%, #A5D6A7 100%);
  display:flex;align-items:center;justify-content:center;
  overflow:hidden;
}
.tcm-image-content{
  font-size:80px;line-height:1;
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;
}
.tcm-image-content img{width:100%;height:100%;object-fit:cover;display:block}
/* Status pill (top right) — color reflects the plant's sensor state */
.tcm-status-pill{
  position:absolute;top:10px;right:10px;
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 10px 4px 8px;border-radius:14px;
  background:rgba(255,255,255,.95);
  font-size:11px;font-weight:500;
  box-shadow:0 1px 3px rgba(0,0,0,.12);
  backdrop-filter:blur(4px);
  -webkit-backdrop-filter:blur(4px);
}
.tcm-status-dot{
  width:7px;height:7px;border-radius:50%;
  background:currentColor;flex-shrink:0;
}
.tcm-status-healthy   {color:#0F6E56}
.tcm-status-thirsty   {color:#854F0B}
.tcm-status-danger    {color:#993C1D}
.tcm-status-harvested {color:#5F5E5A}
.tcm-status-dead      {color:#2A2A2A}
.tcm-status-scheduled {color:#185FA5}

/* ── Season view ──────────────────────────────────────────────────────── */
.season-list{display:flex;flex-direction:column;gap:8px;padding:4px 0}
.season-plant-card{
  background:var(--card-background-color, #fff);
  border:1px solid var(--divider-color);
  border-radius:10px;
  padding:10px 12px;
  cursor:pointer;
  transition:border-color .12s, background .12s;
}
.season-plant-card:hover{
  border-color:#1D9E75;
  background:var(--secondary-background-color);
}
.season-plant-name{
  font-size:14px;font-weight:500;
  color:var(--primary-text-color);
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
}
.season-plant-meta{
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
  margin-top:6px;
  font-size:12px;
  color:var(--secondary-text-color);
}
.season-plant-date{
  font-size:11px;color:var(--secondary-text-color);
}
.status-pill{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 9px;border-radius:10px;
  font-size:11px;font-weight:500;
}
.season-archived-tag{
  font-size:10px;font-weight:400;
  color:var(--secondary-text-color);
  background:var(--secondary-background-color);
  padding:1px 7px;border-radius:8px;
  text-transform:uppercase;letter-spacing:.04em;
}
.season-empty{
  font-size:13px;color:var(--secondary-text-color);
  text-align:center;
  padding:24px 0;
}
/* ── Archive history overlay (event log timeline) ─────────────────────── */
.hist-evt-list{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto;padding-right:4px}
.hist-evt-row{
  display:flex;align-items:center;flex-wrap:wrap;gap:8px;
  padding:8px 10px;
  background:var(--secondary-background-color);
  border:1px solid var(--divider-color);
  border-radius:6px;
  font-size:12px;
}
.hist-evt-date{
  font-family:ui-monospace,monospace;font-size:11px;
  color:var(--secondary-text-color);
  white-space:nowrap;
}
.hist-evt-type{font-weight:500;color:var(--primary-text-color)}
.hist-evt-note{
  width:100%;font-size:11px;
  color:var(--secondary-text-color);
  margin-top:4px;line-height:1.4;
  white-space:pre-wrap;
}
/* Invasive species pill — same shape as the status pill, but red and
   positioned below it. Only rendered when invasive_alert is truthy. */
.tcm-invasive-pill{
  position:absolute;top:38px;right:10px;
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 9px;border-radius:12px;
  background:rgba(252,235,235,.95);color:#791F1F;
  font-size:10px;font-weight:500;
  box-shadow:0 1px 3px rgba(0,0,0,.12);
}
/* Body — name, sci, tile row, key/value grid, care, taxonomy */
.tcm-body{padding:14px 16px 16px}
.tcm-name{
  font-size:19px;font-weight:500;
  color:var(--primary-text-color);
  line-height:1.2;margin-bottom:2px;
  word-wrap:break-word;
}
.tcm-sci{
  font-size:12px;font-style:italic;
  color:var(--secondary-text-color);
  margin-bottom:14px;line-height:1.3;
}
/* Light + water tile row — soft pastel backgrounds in amber + blue,
   faded emoji background art, value text reads first. */
.tcm-tile-row{
  display:grid;grid-template-columns:1fr 1fr;gap:8px;
  margin-bottom:14px;
}
.tcm-tile{
  position:relative;overflow:hidden;
  border-radius:10px;
  padding:10px 12px;
  text-align:center;
}
.tcm-tile-light{background:#FAEEDA}
.tcm-tile-water{background:#E6F1FB}
.tcm-tile-bg{
  position:absolute;inset:0;
  display:flex;align-items:center;justify-content:flex-end;
  padding-right:8px;
  font-size:54px;line-height:1;
  opacity:.18;filter:saturate(0) brightness(1.1);
  pointer-events:none;user-select:none;
}
.tcm-tile-label{
  position:relative;z-index:1;
  font-size:10px;text-transform:uppercase;letter-spacing:.04em;
  font-weight:500;
}
.tcm-tile-light .tcm-tile-label{color:#854F0B}
.tcm-tile-water .tcm-tile-label{color:#0C447C}
.tcm-tile-value{
  position:relative;z-index:1;
  font-size:14px;font-weight:500;margin-top:2px;
  word-wrap:break-word;line-height:1.2;
}
.tcm-tile-light .tcm-tile-value{color:#412402}
.tcm-tile-water .tcm-tile-value{color:#042C53}
/* Key/value detail grid — auto-flow two-column layout, label muted,
   value emphasized. Subtle row dividers via padding. */
.tcm-kv-grid{
  display:grid;grid-template-columns:auto 1fr;
  gap:8px 14px;
  font-size:12px;line-height:1.45;
  margin-bottom:14px;
}
.tcm-kv-label{
  color:var(--secondary-text-color);
  white-space:nowrap;
}
.tcm-kv-value{
  color:var(--primary-text-color);
  word-wrap:break-word;
  text-align:right;
}
.tcm-kv-value-warn{color:#993C1D}
.tcm-kv-value-rain{color:#1B5E8F}
.tcm-kv-value:empty::before,
.tcm-kv-value:has(>nothing)::before{content:"—";color:var(--secondary-text-color)}
/* Care instructions: divider, label, scrollable text */
.tcm-care{
  margin-top:4px;padding-top:12px;
  border-top:0.5px solid var(--divider-color);
}
.tcm-care-label{
  font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;
  color:var(--secondary-text-color);
  margin-bottom:4px;
}
.tcm-care-text{
  font-size:12px;line-height:1.55;
  color:var(--secondary-text-color);
  max-height:90px;overflow-y:auto;
  white-space:pre-wrap;
}
.tcm-care-text:empty::before{content:"—";color:var(--secondary-text-color)}
/* Taxonomy footer — center-aligned light text under everything */
.tcm-tax{
  margin-top:12px;padding-top:10px;
  border-top:0.5px solid var(--divider-color);
  text-align:center;
  font-size:10px;color:var(--secondary-text-color);
  letter-spacing:.04em;
  opacity:.7;
}
.tcm-tax:empty{display:none}
/* Invasive badge in the popup header (older fallback, kept hidden by
   default — the in-card tcm-invasive-pill is preferred). */
.tc-invasive-badge{
  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border-radius:50%;
  background:#E2526A;color:#fff;font-size:14px;font-weight:600;
  margin-right:auto;
}

/* Water override numeric inputs */
.ov-water-num{width:90px;text-align:center;font-variant-numeric:tabular-nums}
.ov-water-num::placeholder{color:var(--secondary-text-color);opacity:.55;font-style:italic}
/* Trading-card footer with collapsible action sections */
.tc-footer{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.tc-section{border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color)}
.tc-section[open]{background:var(--card-background-color,#fff)}
.tc-section-summary{font-size:13px;font-weight:500;color:var(--primary-text-color);padding:10px 12px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;user-select:none}
.tc-section-summary::-webkit-details-marker{display:none}
.tc-section-summary::after{content:"›";margin-left:auto;font-size:18px;color:var(--secondary-text-color);transition:transform .15s ease}
.tc-section[open] .tc-section-summary::after{transform:rotate(90deg)}
.tc-section[open] .tc-section-summary{border-bottom:1px solid var(--divider-color)}
.tc-section > div:not(.tc-section-summary){padding:10px 12px}
.close-btn{width:28px;height:28px;border-radius:50%;border:1px solid var(--divider-color);background:var(--secondary-background-color);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;color:var(--secondary-text-color);font-family:inherit}
.close-btn:hover{background:var(--divider-color)}
.phdr-title{font-size:14px;font-weight:600}
.phdr-sub{font-size:12px;color:var(--secondary-text-color);margin-top:1px}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.tab{font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--divider-color);background:transparent;cursor:pointer;color:var(--secondary-text-color);font-family:inherit}
.tab.active{background:#1D9E75;border-color:#0F6E56;color:#fff;font-weight:500}
.ev-item{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--divider-color)}
.ev-item:last-child{border-bottom:none}
.ev-icon{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.ev-title{font-size:13px;font-weight:500}
.ev-meta{font-size:11px;color:var(--secondary-text-color);margin-top:2px}
.ev-note{font-size:12px;color:var(--secondary-text-color);margin-top:2px;font-style:italic}
.no-items{font-size:13px;color:var(--secondary-text-color);text-align:center;padding:24px 0}
.form-row{display:flex;flex-direction:column;gap:5px;margin-bottom:13px}
.form-label{font-size:12px;color:var(--secondary-text-color)}
.form-hint{font-size:11px;color:var(--secondary-text-color);margin-top:2px}
.form-input,.form-select,.form-textarea{width:100%;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color);font-family:inherit}
.form-textarea{resize:vertical;min-height:60px}
.form-input:focus,.form-select:focus,.form-textarea:focus{outline:none;border-color:#1D9E75}
/* Search */
.search-row{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.search-row .form-input{flex:1}
.search-results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;max-height:300px;overflow-y:auto;margin-top:8px;padding:2px}
/* Recent plants chip strip — shown above the search field when at least one
   existing plant has cached species_data. Lets the user create another of
   the same kind without burning an API call. */
.recent-plants-grid{display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow-y:auto;padding:2px}
.recent-plant-chip{display:inline-flex;align-items:center;gap:6px;background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:14px;padding:4px 10px 4px 6px;cursor:pointer;font-size:12px;transition:background .15s,border-color .15s;max-width:100%}
.recent-plant-chip:hover{background:rgba(29,158,117,.10);border-color:#1D9E75}
.recent-plant-chip-emoji{font-size:14px;line-height:1;flex-shrink:0}
.recent-plant-chip-name{font-weight:500;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
.sr-card{border:1px solid var(--divider-color);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--secondary-background-color);transition:border-color .12s}
.sr-card:hover{border-color:#1D9E75}
/* APIFarmer symbol chip — small monospace badge after the scientific name */
.sr-symbol{display:inline-block;font-family:ui-monospace,monospace;font-size:10px;font-weight:700;background:rgba(29,158,117,.12);color:#0F6E56;padding:1px 5px;border-radius:3px;margin-left:4px;vertical-align:middle;letter-spacing:.04em}
/* Invasive badge on search result cards */
.sr-invasive{display:inline-block;background:#E2526A;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:4px;vertical-align:middle}
.sr-img{width:100%;height:90px;object-fit:cover;display:block;background:var(--divider-color)}
.sr-img-ph{width:100%;height:90px;display:flex;align-items:center;justify-content:center;font-size:36px;background:var(--secondary-background-color)}
.sr-body{padding:7px 8px}
.sr-name{font-size:12px;font-weight:600;line-height:1.3;margin-bottom:2px}
.sr-sci{font-size:10px;color:var(--secondary-text-color);font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-empty{font-size:13px;color:var(--secondary-text-color);text-align:center;padding:20px 0}
.plant-image{width:100%;height:160px;object-fit:cover;border-radius:10px;display:block;margin-bottom:12px}
.plant-image-placeholder{width:100%;height:100px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:52px;background:var(--secondary-background-color);margin-bottom:12px}
/* Real image plant in the search-result preview — was missing CSS, which let
   the browser render the image at its natural (Verdantly full-resolution)
   size and balloon the overlay. Constrains to the same 100px height as the
   emoji placeholder so the layout matches in both cases. */
.plant-image-wrap{
  width:100%;height:100px;
  border-radius:10px;overflow:hidden;
  background:var(--secondary-background-color);
  margin-bottom:12px;
  display:flex;align-items:center;justify-content:center;
}
.plant-image{
  width:100%;height:100%;
  object-fit:cover;display:block;
}
.plant-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.plant-info-cell{background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:9px 11px}
.plant-info-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--secondary-text-color);font-weight:500;margin-bottom:3px}
.plant-info-value{font-size:13px;line-height:1.4}
.harvest-bar-wrap{background:var(--secondary-background-color);border-radius:8px;padding:10px 12px;margin-bottom:14px}
.harvest-bar-label{font-size:12px;font-weight:500;margin-bottom:6px}
.harvest-bar-track{background:var(--divider-color);border-radius:4px;height:6px;overflow:hidden}
.harvest-bar-fill{background:#1D9E75;height:6px;border-radius:4px}
.harvest-bar-sub{font-size:11px;color:var(--secondary-text-color);margin-top:5px}
.tip-card{background:var(--secondary-background-color);border-radius:8px;padding:10px 12px;margin-bottom:8px;border-left:3px solid #1D9E75}
.tip-title{font-size:12px;font-weight:600;margin-bottom:4px}
.tip-body{font-size:13px;color:var(--secondary-text-color);line-height:1.5;white-space:pre-line}
.plant-detail-img{width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:14px;display:block}
/* Settings */
.set-section{font-size:12px;font-weight:600;color:var(--primary-text-color);margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid var(--divider-color)}

/* ── Layout toggle group (Bootstrap-style segmented control) ─────────────
   Three buttons that look like a single rounded pill, with the active
   button getting an accent fill. Used in Settings → Card display → Layout. */
.layout-toggle{
  display:inline-flex;
  border:1px solid var(--divider-color);
  border-radius:8px;
  overflow:hidden;
  background:var(--secondary-background-color);
}
.layout-toggle-btn{
  background:transparent;border:0;
  padding:7px 14px;
  font-size:12px;font-weight:500;
  color:var(--secondary-text-color);
  cursor:pointer;
  transition:background .12s,color .12s;
  font-family:inherit;
  border-right:1px solid var(--divider-color);
  display:inline-flex;align-items:center;gap:5px;
  white-space:nowrap;
}
.layout-toggle-btn:last-child{border-right:0}
.layout-toggle-btn:hover{background:var(--divider-color);color:var(--primary-text-color)}
.layout-toggle-btn.active{background:#1D9E75;color:#fff}
.layout-toggle-btn.active:hover{background:#0F6E56}
/* Theme toggle group — shares layout-toggle's container but the buttons
   have their own class so they bind to their own handlers. Visually
   identical to layout buttons. */
.theme-toggle-btn{
  background:transparent;border:0;
  padding:7px 14px;
  font-size:12px;font-weight:500;
  color:var(--secondary-text-color);
  cursor:pointer;
  transition:background .12s,color .12s;
  font-family:inherit;
  border-right:1px solid var(--divider-color);
  display:inline-flex;align-items:center;gap:5px;
  white-space:nowrap;
}
.theme-toggle-btn:last-child{border-right:0}
.theme-toggle-btn:hover{background:var(--divider-color);color:var(--primary-text-color)}
.theme-toggle-btn.active{background:#1D9E75;color:#fff}
.theme-toggle-btn.active:hover{background:#0F6E56}

/* ── Portrait layout rules ─────────────────────────────────────────────
   Applied when either:
     - The card has class 'layout-portrait' (explicit user choice), OR
     - The card has class 'layout-auto' AND the host viewport ≤ 600px wide
       (phone or small tablet portrait — auto detection)
   Landscape mode is the default existing layout — no rules needed.
   We re-flow EXISTING markup; nothing about the JS render path changes. */

/* === Helper: a single selector covers both portrait triggers === */
:host(.layout-portrait) .metrics,
:host(.layout-auto) .metrics{}
/* Use a class on the host so we don't need :host-context. We then use a
   media query inside each rule to gate the auto case. */

/* Metric row: 4-across → 2x2 grid in portrait so each tile stays a
   tap-friendly size. */
@media (max-width: 600px){
  :host(.layout-auto) .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  :host(.layout-auto) .plot-grid{grid-template-columns:1fr}
  :host(.layout-auto) .pills{flex-wrap:wrap}
  :host(.layout-auto) .planner-controls{flex-wrap:wrap;gap:4px}
  :host(.layout-auto) .planner-tab{padding:4px 9px;font-size:11px}
  /* Plant table → vertical card stack on phone. Each plant becomes a
     stacked card with name on top, then key/value rows. Hides the
     conventional table header. */
  :host(.layout-auto) .plot-table thead{display:none}
  :host(.layout-auto) .plot-table,
  :host(.layout-auto) .plot-table tbody,
  :host(.layout-auto) .plot-table tr,
  :host(.layout-auto) .plot-table td{display:block;width:100%}
  :host(.layout-auto) .plot-table tr.plant-row{
    border:1px solid var(--divider-color);
    border-radius:10px;
    margin-bottom:8px;
    padding:10px 12px;
    background:var(--card-background-color, #fff);
  }
  :host(.layout-auto) .plot-table tr.plant-row td{
    padding:3px 0;border:0;
  }
  :host(.layout-auto) .plot-table tr.plant-row td.chev{display:none}
  /* Each meta cell prefixed with its column-label via data-label attribute,
     populated by JS at render time. The label sits inline at left. */
  :host(.layout-auto) .plot-table tr.plant-row td.plant-table-meta::before{
    content:attr(data-label) ": ";
    color:var(--secondary-text-color);
    font-size:11px;
    font-weight:500;
    text-transform:uppercase;
    letter-spacing:.04em;
    margin-right:6px;
  }
  :host(.layout-auto) .plot-table tr.plant-row td.plant-table-meta{
    font-size:12px;
    display:flex;justify-content:space-between;align-items:baseline;gap:8px;
  }
  /* Trading card: shorter plant, stacked light/water tiles, single-column kv grid */
  :host(.layout-auto) .tcm-image{height:110px}
  :host(.layout-auto) .tcm-image-content{font-size:62px}
  :host(.layout-auto) .tcm-tile-row{grid-template-columns:1fr}
  :host(.layout-auto) .tcm-body{padding:12px 14px 14px}
  :host(.layout-auto) .popup-card{max-width:100%}
}

/* === Forced-portrait class === */
/* When the user explicitly picks "Portrait" we apply the same rules
   without the media query, so it works regardless of host viewport. */
:host(.layout-portrait) .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
:host(.layout-portrait) .plot-grid{grid-template-columns:1fr}
:host(.layout-portrait) .pills{flex-wrap:wrap}
:host(.layout-portrait) .planner-controls{flex-wrap:wrap;gap:4px}
:host(.layout-portrait) .planner-tab{padding:4px 9px;font-size:11px}
:host(.layout-portrait) .plot-table thead{display:none}
:host(.layout-portrait) .plot-table,
:host(.layout-portrait) .plot-table tbody,
:host(.layout-portrait) .plot-table tr,
:host(.layout-portrait) .plot-table td{display:block;width:100%}
:host(.layout-portrait) .plot-table tr.plant-row{
  border:1px solid var(--divider-color);border-radius:10px;
  margin-bottom:8px;padding:10px 12px;
  background:var(--card-background-color, #fff);
}
:host(.layout-portrait) .plot-table tr.plant-row td{padding:3px 0;border:0}
:host(.layout-portrait) .plot-table tr.plant-row td.chev{display:none}
:host(.layout-portrait) .plot-table tr.plant-row td.plant-table-meta::before{
  content:attr(data-label) ": ";
  color:var(--secondary-text-color);
  font-size:11px;font-weight:500;
  text-transform:uppercase;letter-spacing:.04em;
  margin-right:6px;
}
:host(.layout-portrait) .plot-table tr.plant-row td.plant-table-meta{
  font-size:12px;
  display:flex;justify-content:space-between;align-items:baseline;gap:8px;
}
:host(.layout-portrait) .tcm-image{height:110px}
:host(.layout-portrait) .tcm-image-content{font-size:62px}
:host(.layout-portrait) .tcm-tile-row{grid-template-columns:1fr}
:host(.layout-portrait) .tcm-body{padding:12px 14px 14px}
:host(.layout-portrait) .popup-card{max-width:100%}
.conn-status{display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:14px}
.conn-ok{background:#E1F5EE;color:#0F6E56}
.conn-err{background:#FAECE7;color:#993C1D}
.conn-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--divider-color);border-top-color:#1D9E75;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
/* Water needed list */
.water-list{display:flex;flex-direction:column;gap:8px}
.water-row{display:flex;align-items:center;gap:10px;padding:10px;background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:8px}
.water-row-info{flex:1;min-width:0}
.water-row-name{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px}
.water-row-meta{font-size:11px;color:var(--secondary-text-color);margin-top:2px}
.water-row-actions{display:flex;gap:5px}

/* ════════════════════════════════════════════════════════════════════════
   DARK THEME (v1.1.0)
   Applied when the host has class 'theme-default'. Remaps the surfaces and
   text colors to a dark palette while keeping the integration's structure
   identical. Doesn't touch HA's CSS variables globally — only the
   instances inside this card's shadow DOM.
   ════════════════════════════════════════════════════════════════════════ */

:host(.theme-default){
  --agribud-bg:          #1A1A1F;
  --agribud-surface:     #2A2A30;
  --agribud-surface-2:   #222227;
  --agribud-border:      #3A3A40;
  --agribud-text:        #F5F1E8;
  --agribud-text-muted:  #7A7770;
  --agribud-accent:      #F0997B;
  /* Brighter status pill backgrounds for dark mode (per user request) —
     more saturated than v1.0.x so they read clearly against dark surfaces. */
  --agribud-pill-healthy-bg:   #0E7559;
  --agribud-pill-healthy-fg:   #8FE8C5;
  --agribud-pill-thirsty-bg:   #7C1F1F;
  --agribud-pill-thirsty-fg:   #FFB5B5;
  --agribud-pill-danger-bg:    #8F2913;
  --agribud-pill-danger-fg:    #FFC4A8;
  --agribud-pill-rain-bg:      #14497F;
  --agribud-pill-rain-fg:      #A7D2FF;
  --agribud-pill-harvested-bg: #4A4A52;
  --agribud-pill-harvested-fg: #D0CFC8;
  --agribud-pill-dead-bg:      #3A3A40;
  --agribud-pill-dead-fg:      #C8C7C0;
  background:var(--agribud-bg);
  color:var(--agribud-text);
  border-radius:14px;
  display:block;
}
:host(.theme-default) .card-root,
:host(.theme-default) ha-card{
  background:var(--agribud-bg);color:var(--agribud-text);border:0;
}

/* Container surfaces */
:host(.theme-default) .metric,
:host(.theme-default) .plot-card:not(.plot-card-add):not(.plot-card-skeleton),
:host(.theme-default) .plant-table,
:host(.theme-default) .planner-grid,
:host(.theme-default) .water-row,
:host(.theme-default) .pill,
:host(.theme-default) .metric-val,
:host(.theme-default) .api-status-box{background:var(--agribud-surface);color:var(--agribud-text)}
:host(.theme-default) .plot-card-skeleton{background:var(--agribud-surface-2)}
:host(.theme-default) .plot-card-add{border-color:var(--agribud-border);color:var(--agribud-text-muted)}
:host(.theme-default) .plot-card-add:hover{border-color:#1D9E75;color:#1D9E75}

/* Borders + divider */
:host(.theme-default) .divider{border-top-color:var(--agribud-border)}
:host(.theme-default) .plot-card{border-color:var(--agribud-border)}

/* Text + muted */
:host(.theme-default) .sec-title,
:host(.theme-default) .metric-val,
:host(.theme-default) .plot-card-name,
:host(.theme-default) .plant-table th,
:host(.theme-default) .plant-table td,
:host(.theme-default) .form-label{color:var(--agribud-text)}
:host(.theme-default) .metric-lbl,
:host(.theme-default) .plot-card-count,
:host(.theme-default) .plot-card-desc,
:host(.theme-default) .plant-table-meta{color:var(--agribud-text-muted)}

/* Plant table */
:host(.theme-default) .plant-table{background:var(--agribud-surface);border-radius:12px;overflow:hidden}
:host(.theme-default) .plant-table thead tr{background:var(--agribud-surface-2)}
:host(.theme-default) .plant-table tbody tr{border-top-color:var(--agribud-bg)}
:host(.theme-default) .plant-row:hover td{background:#33333A !important}
:host(.theme-default) .plant-table th{color:var(--agribud-text-muted);border-bottom-color:var(--agribud-bg)}

/* Pills (the horizontal pill strip below the alert) */
:host(.theme-default) .pills .pill{background:var(--agribud-surface);color:var(--agribud-text);border:0}
:host(.theme-default) .pills .pill-healthy{background:var(--agribud-pill-healthy-bg);color:var(--agribud-pill-healthy-fg)}
:host(.theme-default) .pills .pill-thirsty{background:var(--agribud-pill-thirsty-bg);color:var(--agribud-pill-thirsty-fg)}
:host(.theme-default) .pills .pill-danger {background:var(--agribud-pill-danger-bg); color:var(--agribud-pill-danger-fg)}

/* Stage badges + status pills inside the plant rows */
:host(.theme-default) .badge{filter:saturate(1.1) brightness(1.05)}

/* Status badge backgrounds on plant icons */
:host(.theme-default) .plant-status-needs{background:var(--agribud-pill-thirsty-bg)}
:host(.theme-default) .plant-status-rain {background:var(--agribud-pill-rain-bg)}

/* Trading card surfaces (Modern Card) */
:host(.theme-default) .tc{background:var(--agribud-surface);border-color:var(--agribud-border)}
:host(.theme-default) .tcm-name,
:host(.theme-default) .tcm-kv-value{color:var(--agribud-text)}
:host(.theme-default) .tcm-sci,
:host(.theme-default) .tcm-kv-label,
:host(.theme-default) .tcm-care-text,
:host(.theme-default) .tcm-care-label,
:host(.theme-default) .tcm-tax{color:var(--agribud-text-muted)}
:host(.theme-default) .tcm-care{border-top-color:var(--agribud-border)}
:host(.theme-default) .tcm-tax{border-top-color:var(--agribud-border)}

/* Overlays / popups */
:host(.theme-default) .overlay{background:rgba(0,0,0,.62)}
:host(.theme-default) .popup,
:host(.theme-default) .popup-card{background:var(--agribud-bg);color:var(--agribud-text);border:1px solid var(--agribud-border)}
:host(.theme-default) .popup-hdr{background:var(--agribud-surface-2);border-bottom-color:var(--agribud-border)}
:host(.theme-default) .popup-body{background:var(--agribud-bg);color:var(--agribud-text)}
:host(.theme-default) .close-btn{color:var(--agribud-text)}
:host(.theme-default) .close-btn:hover{background:var(--agribud-surface)}

/* Forms */
:host(.theme-default) .form-input,
:host(.theme-default) .form-input:focus,
:host(.theme-default) input,
:host(.theme-default) select,
:host(.theme-default) textarea{background:var(--agribud-surface);color:var(--agribud-text);border-color:var(--agribud-border)}
:host(.theme-default) .form-hint{color:var(--agribud-text-muted)}
:host(.theme-default) .set-section{color:var(--agribud-text);border-bottom-color:var(--agribud-border)}

/* Buttons */
:host(.theme-default) .btn{background:var(--agribud-surface);color:var(--agribud-text);border-color:var(--agribud-border)}
:host(.theme-default) .btn:hover{background:#33333A}
:host(.theme-default) .btn-accent{background:#1D9E75;color:#fff}
:host(.theme-default) .btn-accent:hover{background:#0F6E56}

/* Toggle groups */
:host(.theme-default) .layout-toggle,
:host(.theme-default) .theme-toggle{background:var(--agribud-surface);border-color:var(--agribud-border)}
:host(.theme-default) .layout-toggle-btn,
:host(.theme-default) .theme-toggle-btn{color:var(--agribud-text-muted);border-right-color:var(--agribud-border)}
:host(.theme-default) .layout-toggle-btn:hover,
:host(.theme-default) .theme-toggle-btn:hover{background:var(--agribud-border);color:var(--agribud-text)}
:host(.theme-default) .layout-toggle-btn.active,
:host(.theme-default) .theme-toggle-btn.active{background:#1D9E75;color:#fff}

/* Calendar season label */
:host(.theme-default) .cal-day-season-label{color:var(--agribud-text-muted);border-bottom-color:var(--agribud-border)}
:host(.theme-default) .cal-day{background:var(--agribud-surface);border-color:var(--agribud-border)}
:host(.theme-default) .cal-day-num{color:var(--agribud-text)}

/* Planner grid (week + season) */
:host(.theme-default) .planner-controls .planner-tab{background:var(--agribud-surface);color:var(--agribud-text-muted);border-color:var(--agribud-border)}
:host(.theme-default) .planner-controls .planner-tab.active{background:#1D9E75;color:#fff}
:host(.theme-default) .season-plant-card{background:var(--agribud-surface);border-color:var(--agribud-border);color:var(--agribud-text)}
:host(.theme-default) .season-plant-card:hover{background:#33333A;border-color:#1D9E75}
:host(.theme-default) .season-plant-meta{color:var(--agribud-text-muted)}

/* Scrollbar thumb on plants-scroll + plot-strip */
:host(.theme-default) .plot-strip-wrap::-webkit-scrollbar-thumb,
:host(.theme-default) .plants-scroll::-webkit-scrollbar-thumb{background:var(--agribud-border)}
:host(.theme-default) .plants-scroll{background:var(--agribud-surface);border-color:var(--agribud-border)}

/* Header (top of card) — title, subtitle, gear button */
:host(.theme-default) .hdr-title{color:var(--agribud-text)}
:host(.theme-default) .hdr-sub{color:var(--agribud-text-muted)}
:host(.theme-default) .gear-btn{
  background:var(--agribud-surface);color:var(--agribud-text);
  border:0;
}
:host(.theme-default) .gear-btn:hover{background:var(--agribud-border)}

/* Overlay popups (settings, plant detail, search, etc.) — dark surfaces */
:host(.theme-default) .overlay{background:rgba(0,0,0,.65)}
:host(.theme-default) .popup,
:host(.theme-default) .popup-card{
  background:var(--agribud-bg);color:var(--agribud-text);border-color:var(--agribud-border);
}
:host(.theme-default) .popup-hdr{background:var(--agribud-surface-2);border-bottom-color:var(--agribud-border)}
:host(.theme-default) .popup-body{color:var(--agribud-text)}
:host(.theme-default) .close-btn{background:var(--agribud-surface);color:var(--agribud-text)}
:host(.theme-default) .close-btn:hover{background:var(--agribud-border)}

/* Form inputs in overlays */
:host(.theme-default) .form-input,
:host(.theme-default) input.form-input,
:host(.theme-default) select.form-input,
:host(.theme-default) textarea.form-input{
  background:var(--agribud-surface);color:var(--agribud-text);border-color:var(--agribud-border);
}
:host(.theme-default) .form-input:focus{border-color:#1D9E75;outline:none}
:host(.theme-default) .form-input::placeholder{color:var(--agribud-text-muted)}
:host(.theme-default) .form-hint{color:var(--agribud-text-muted)}

/* Recent Plants chip strip + search result cards */
:host(.theme-default) .recent-plant-chip{background:var(--agribud-surface);border-color:var(--agribud-border);color:var(--agribud-text)}
:host(.theme-default) .recent-plant-chip:hover{background:rgba(29,158,117,.18);border-color:#1D9E75}
:host(.theme-default) .recent-plant-chip-name{color:var(--agribud-text)}
:host(.theme-default) .search-results-grid > div{background:var(--agribud-surface);border-color:var(--agribud-border);color:var(--agribud-text)}
:host(.theme-default) .search-results-grid > div:hover{background:#33333A;border-color:#1D9E75}
:host(.theme-default) .plant-image-placeholder{background:var(--agribud-surface);color:var(--agribud-text)}
:host(.theme-default) .plant-image-wrap{background:var(--agribud-surface)}
:host(.theme-default) .plant-info-cell{background:var(--agribud-surface);border-color:var(--agribud-border)}
:host(.theme-default) .plant-info-label{color:var(--agribud-text-muted)}
:host(.theme-default) .plant-info-value{color:var(--agribud-text)}

/* Trading card (plant detail) — dark surface variants */
:host(.theme-default) .tc{background:var(--agribud-bg);border-color:var(--agribud-border)}
:host(.theme-default) .tcm-image{background:linear-gradient(135deg,#2A4A2A 0%,#1F3D1F 100%)}
:host(.theme-default) .tcm-name{color:var(--agribud-text)}
:host(.theme-default) .tcm-sci{color:var(--agribud-text-muted)}
:host(.theme-default) .tcm-status-pill{background:rgba(42,42,48,.95)}
:host(.theme-default) .tcm-status-healthy   {color:#7BDDB7}
:host(.theme-default) .tcm-status-thirsty   {color:#FAC775}
:host(.theme-default) .tcm-status-danger    {color:#FFB5B5}
:host(.theme-default) .tcm-status-harvested {color:#B0AFA8}
:host(.theme-default) .tcm-status-dead      {color:#888888}
:host(.theme-default) .tcm-status-scheduled {color:#A6CEF2}
:host(.theme-default) .tcm-invasive-pill{background:rgba(122,30,30,.95);color:#FFB5B5}
:host(.theme-default) .tcm-tile-light{background:#3A2A0F}
:host(.theme-default) .tcm-tile-water{background:#0F2A45}
:host(.theme-default) .tcm-tile-light .tcm-tile-label{color:#FAC775}
:host(.theme-default) .tcm-tile-light .tcm-tile-value{color:#F5E0B3}
:host(.theme-default) .tcm-tile-water .tcm-tile-label{color:#A6CEF2}
:host(.theme-default) .tcm-tile-water .tcm-tile-value{color:#D8E8F8}
:host(.theme-default) .tcm-kv-label{color:var(--agribud-text-muted)}
:host(.theme-default) .tcm-kv-value{color:var(--agribud-text)}
:host(.theme-default) .tcm-kv-value-warn{color:#FFB5B5}
:host(.theme-default) .tcm-kv-value-rain{color:#A6CEF2}
:host(.theme-default) .tcm-care{border-top-color:var(--agribud-border)}
:host(.theme-default) .tcm-care-label{color:var(--agribud-text-muted)}
:host(.theme-default) .tcm-care-text{color:#B5B3AB}
:host(.theme-default) .tcm-tax{color:var(--agribud-text-muted);border-top-color:var(--agribud-border)}

/* History overlay rows (archived plants event log) */
:host(.theme-default) .hist-evt-row{background:var(--agribud-surface)}
:host(.theme-default) .hist-evt-date{color:var(--agribud-text-muted)}
:host(.theme-default) .hist-evt-type{color:var(--agribud-text)}
:host(.theme-default) .hist-evt-note{color:var(--agribud-text-muted)}

/* Status pills used in season cards / season view drill-down */
:host(.theme-default) .status-pill{background:var(--agribud-border);color:var(--agribud-text)}

/* Settings status box + rate notice */
:host(.theme-default) #api-status-box{background:var(--agribud-surface) !important;color:var(--agribud-text)}
:host(.theme-default) .conn-ok{background:#0E7559;color:#8FE8C5}
:host(.theme-default) .conn-err{background:#7C1F1F;color:#FFB5B5}
:host(.theme-default) .rate-notice{background:var(--agribud-surface);border-left-color:#FAC775;color:var(--agribud-text-muted)}
:host(.theme-default) .rate-notice-warning{background:rgba(226,82,106,.14);border-left-color:#E2526A}
:host(.theme-default) .rate-notice a{color:#7BDDB7}

/* Plant status badges on plant icons — brighter in dark */
:host(.theme-default) .plant-status-needs{background:#7A1E1E}
:host(.theme-default) .plant-status-rain{background:#0C447C}
:host(.theme-default) .plant-status-badge{border-color:var(--agribud-surface)}

/* Buttons — base + danger */
:host(.theme-default) .btn{background:var(--agribud-surface);color:var(--agribud-text);border-color:var(--agribud-border)}
:host(.theme-default) .btn:hover{background:var(--agribud-border)}
:host(.theme-default) .btn-danger{background:#7A1E1E;color:#fff;border-color:#7A1E1E}
:host(.theme-default) .btn-danger:hover{background:#8F2828}

/* Section label + planner nav prev/next */
:host(.theme-default) .planner-nav-btn{background:var(--agribud-surface);color:var(--agribud-text);border-color:var(--agribud-border)}
:host(.theme-default) .planner-nav-btn:hover{background:var(--agribud-border)}

/* ── Peach gradient plant alert ─────────────────────────────────────────
   New in v1.1.0: when one or more plants need water, the existing
   "X plants need watering" banner gets a warm gradient treatment in BOTH
   themes (light + dark). The dark theme leans into it; light theme uses
   the same gradient but on a smaller scale since the background is
   already light. Class is applied via JS when needWater > 0. */
.alert-banner{
  background:linear-gradient(135deg,#F0997B 0%,#D85A30 60%,#993C1D 100%);
  color:#fff;
  border-radius:12px;
  padding:12px 14px;
  margin-bottom:14px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  box-shadow:0 2px 8px rgba(216,90,48,.22);
}
.alert-banner-body{display:flex;align-items:center;gap:10px;min-width:0}
.alert-banner-icon{font-size:20px;flex-shrink:0}
.alert-banner-text{min-width:0}
.alert-banner-title{font-size:14px;font-weight:500;line-height:1.25}
.alert-banner-sub{font-size:11px;opacity:.85;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-banner-dismiss{
  background:rgba(255,255,255,.22);border:0;color:#fff;
  font-size:11px;padding:5px 10px;border-radius:8px;cursor:pointer;
  white-space:nowrap;
}
.alert-banner-dismiss:hover{background:rgba(255,255,255,.32)}
`;

/* ─── Card class ─────────────────────────────────────────────────────────── */

class AgribudCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._initialized = false;
    // Navigation state — main / plot:<id> / plant:<id>
    this._view = "main";
    this._activePlot  = null;
    this._activePlant = null;
    // Cached data
    this._plotsCache = null;       // last-fetched grow plots from /plots
    this._plotsLastFetch = 0;
    this._weatherLog = {};         // last-fetched weather observations keyed by ISO date
    this._plannerScale = "week";   // week | month
    this._plannerOffset = 0;       // weeks/months from current period
    // Layout preference — one of "auto" / "portrait" / "landscape". Stored
    // in localStorage (no backend trip, no API quota burned). "auto" leans
    // on a CSS media query so the host's viewport width decides; the two
    // explicit values force one or the other regardless of viewport.
    this._layoutPref = "auto";
    try {
      const stored = window.localStorage.getItem("agribud:layout");
      if (stored === "portrait" || stored === "landscape" || stored === "auto") {
        this._layoutPref = stored;
      }
    } catch (e) { /* localStorage may throw in restricted contexts */ }
    // Theme preference — "ha" (follow Home Assistant theme) or "default"
    // (the modern dark surface design that's the integration's signature
    // look). User explicitly picks; no auto mode. Defaults to "ha" on first
    // install so users keep their existing HA aesthetic without surprise.
    // Persisted in localStorage per-browser (key: "agribud:theme").
    //
    // Migration: prior to v1.1.1 the values were "light" / "dark". We
    // remap them transparently so existing users don't have to re-pick.
    this._themePref = "ha";
    try {
      const stored = window.localStorage.getItem("agribud:theme");
      if (stored === "ha" || stored === "default") {
        this._themePref = stored;
      } else if (stored === "light") {
        this._themePref = "ha";
        window.localStorage.setItem("agribud:theme", "ha");
      } else if (stored === "dark") {
        this._themePref = "default";
        window.localStorage.setItem("agribud:theme", "default");
      }
    } catch (e) {}
    // Bus event subscription
    this._busUnsub = null;
  }

  setConfig(config) { this._config = { ...config }; }

  /**
   * Persist + apply a new layout preference. Updates localStorage so the
   * choice survives page reloads, then toggles the layout class on the
   * host so existing markup re-flows immediately — no full re-render
   * needed, no service call, no quota burn.
   *
   * Accepts "auto" / "portrait" / "landscape". Anything else is ignored.
   */
  _setLayoutPref(pref) {
    if (!["auto", "portrait", "landscape"].includes(pref)) return;
    this._layoutPref = pref;
    try { window.localStorage.setItem("agribud:layout", pref); } catch (e) {}
    this._applyLayoutClass();
  }

  /**
   * Persist + apply a new theme preference. Same model as _setLayoutPref —
   * localStorage, host-class toggle, instant CSS re-flow with no re-render.
   *
   * Light mode uses HA's theme variables (--card-background-color,
   * --primary-text-color, etc.) so custom HA themes (Material You,
   * Catppuccin, etc.) are respected. Dark mode uses hardcoded values
   * (#1A1A1F surfaces, #2A2A30 cards, peach gradient accent) because HA's
   * dark variables aren't consistent across themes.
   *
   * Accepts "light" or "dark". Anything else is ignored.
   */
  _setThemePref(pref) {
    if (!["ha", "default"].includes(pref)) return;
    this._themePref = pref;
    try { window.localStorage.setItem("agribud:theme", pref); } catch (e) {}
    this._applyThemeClass();
  }

  /**
   * Mirror the active layout preference onto the host element as a CSS
   * class so the stylesheet rules can react. Three classes are exclusive:
   * `layout-auto`, `layout-portrait`, `layout-landscape`. The CSS uses
   * `layout-auto` + a media query for the auto case, and the two explicit
   * classes win unconditionally when set.
   */
  _applyLayoutClass() {
    const host = this;  // the custom element itself
    host.classList.remove("layout-auto", "layout-portrait", "layout-landscape");
    host.classList.add(`layout-${this._layoutPref}`);
  }

  /**
   * Mirror the active theme onto the host as `theme-ha` or `theme-default`.
   * Light theme rules cascade from HA variables; dark theme rules override
   * with hardcoded surfaces.
   */
  _applyThemeClass() {
    const host = this;
    host.classList.remove("theme-ha", "theme-default");
    host.classList.add(`theme-${this._themePref}`);
  }

  static getStubConfig() {
    return { title: "My Garden", temp_unit: "auto" };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._applyLayoutClass();
      this._applyThemeClass();
      this._render();
      this._initialized = true;
      this._subscribeBusEvents();
      // Initial plots + weather_log fetches in parallel. When they complete
      // we explicitly re-render so the plot grid + weather data appear
      // immediately rather than waiting for the next bus event or HA state
      // change (which used to take 10–30s on a fresh page load). Without
      // this, the user sees an empty grow-plots row + missing weather
      // until something else nudges the card to re-paint.
      Promise.all([this._fetchPlots(), this._fetchWeatherLog()])
        .then(() => { this._render(); })
        .catch(err => console.warn("Agribud: initial fetch failed:", err));
      // Pre-warm the status cache so the add-plant overlay can render the
      // user's default state without waiting for them to open Settings first.
      this._apiFetch("/status")
        .then(({ data }) => { this._apiStatusCache = data; })
        .catch(() => {});
    } else {
      this._updateLive();
    }
  }

  disconnectedCallback() {
    if (this._busUnsub) { try { this._busUnsub(); } catch(e){} this._busUnsub = null; }
  }

  _el(id) { return this.shadowRoot.getElementById(id); }

  _authHeaders() {
    const token = this._hass?.auth?.data?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  _fmtErr(err, ctx) {
    const raw = err?.message || String(err);
    const match = raw.match(/returned error:\s*(.+)/i) || raw.match(/Error:\s*(.+)/i);
    let short = match ? match[1] : raw;
    if (short.length > 130) short = short.slice(0, 127) + "…";
    return short + (ctx ? ` — Check HA logs (search "${ctx}").` : "");
  }

  async _apiFetch(path, opts = {}) {
    const r = await fetch(API_BASE + path, { headers: this._authHeaders(), ...opts });
    const txt = await r.text();
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      // Surface the actual response so we can diagnose. HA returns plain-text
      // errors for 401/403/404/405 — the body tells us exactly what went wrong.
      const preview = (txt || "").trim().slice(0, 200) || "(empty body)";
      console.warn(
        "[Agribud] Non-JSON response from", path,
        "status:", r.status,
        "content-type:", r.headers.get("content-type"),
        "body:", preview,
      );
      data = {
        error: "invalid_response",
        message: `HTTP ${r.status}: ${preview}`,
      };
    }
    return { status: r.status, data };
  }

  /* ── Bus events: auto-refresh on data changes ──────────────────────────── */

  _subscribeBusEvents() {
    if (!this._hass?.connection?.subscribeEvents) return;
    this._hass.connection.subscribeEvents(
      async ev => {
        // The integration just updated data. Re-fetch plots + weather_log
        // and re-render. If viewing a plot, swap _activePlot for its fresh
        // version so new plants / new events show up immediately.
        await Promise.all([this._fetchPlots(), this._fetchWeatherLog()]);
        // Invalidate the season cache so the next season-view render
        // re-fetches with the latest data. Cheap — only re-fetches when
        // the season view is actually open.
        this._seasonViewCache = null;
        if (this._plannerScale === "season" && this._view === "main") {
          this._fetchSeasonView();
        }
        if (this._view.startsWith("plot:") && this._activePlot) {
          const freshPlot = (this._plotsCache || []).find(p => p.id === this._activePlot.id);
          if (freshPlot) {
            this._activePlot = freshPlot;
          } else {
            // Plot was removed (or unassigned plot now empty) — bounce back to main
            this._backToMain();
            return;
          }
        }
        this._renderCurrentView();
      },
      `${DOMAIN}_data_changed`,
    ).then(unsub => { this._busUnsub = unsub; })
     .catch(err => console.warn("Agribud: failed to subscribe to data_changed events:", err));
  }

  /* ── Toast ─────────────────────────────────────────────────────────────── */

  _toast(type, title, msg, ms) {
    const stack = this._el("toast-stack");
    if (!stack) return;
    const dur = ms ?? (type === "error" ? 9000 : 4500);
    const icon = { error: "⚠️", success: "✓", info: "ℹ️" }[type] || "•";
    const el = Object.assign(document.createElement("div"), { className: `toast toast-${type}` });
    const ico = Object.assign(document.createElement("span"), { className: "toast-icon", textContent: icon });
    const body = document.createElement("div");
    body.className = "toast-body";
    body.appendChild(Object.assign(document.createElement("div"), { className: "toast-title", textContent: title }));
    if (msg) body.appendChild(Object.assign(document.createElement("div"), { className: "toast-msg", textContent: msg }));
    const x = Object.assign(document.createElement("button"), { className: "toast-close", textContent: "✕" });
    x.onclick = () => el.remove();
    el.append(ico, body, x);
    stack.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, dur);
  }
  _err(t, m)  { this._toast("error",   t, m); }
  _ok(m)      { this._toast("success", "Done", m, 4000); }
  _info(t, m) { this._toast("info",    t, m, 6000); }

  /* ── Plots + weather log fetching ──────────────────────────────────────── */

  async _fetchPlots() {
    try {
      const { status, data } = await this._apiFetch("/plots");
      if (status === 200 && Array.isArray(data)) {
        this._plotsCache = data;
        this._plotsLastFetch = Date.now();
        return data;
      }
    } catch (e) { console.warn("Agribud: plots fetch failed:", e); }
    return this._plotsCache || [];
  }

  async _fetchWeatherLog() {
    try {
      const { status, data } = await this._apiFetch("/weather_log");
      if (status === 200 && data && typeof data === "object" && !Array.isArray(data)) {
        this._weatherLog = data;
        return data;
      }
    } catch (e) { console.warn("Agribud: weather_log fetch failed:", e); }
    return this._weatherLog || {};
  }

  _allPlants() {
    // Flatten plants from all plots, plus those still discovered via HA states
    const fromPlots = (this._plotsCache || []).flatMap(p => p.plants || []);
    if (fromPlots.length) return fromPlots;
    // Fallback: from HA sensor entities
    return extractAgribudPlants(this._hass);
  }

  /* ── Root render ────────────────────────────────────────────────────────── */

  _render() {
    const style = document.createElement("style");
    style.textContent = CSS;
    const root = document.createElement("div");
    root.className = "card";
    root.id = "card-root";
    root.innerHTML = this._tplShell();
    this.shadowRoot.innerHTML = "";
    this.shadowRoot.append(style, root);
    this._renderCurrentView();
    this._bindStaticControls();
  }

  _tplShell() {
    const title = this._config.title || "Agribud";
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    return `
      <div class="header">
        <div class="hdr-left">
          <div class="hdr-title">${title}</div>
          <div class="hdr-sub">${today}</div>
        </div>
        <div class="hdr-acts">
          <button class="gear-btn" id="open-settings-btn" title="Agribud settings">⚙</button>
        </div>
      </div>

      <div id="view-container"></div>

      <div style="margin-top:14px;font-size:10px;color:var(--secondary-text-color);opacity:.45;text-align:right;user-select:none">agribud-v1.1.1</div>

      ${this._tplPlantOverlay()}
      ${this._tplSettingsOverlay()}
      ${this._tplWaterListOverlay()}
      ${this._tplActivePlantsOverlay()}
      ${this._tplSparklineOverlay()}
      ${this._tplAddPlotOverlay()}
      ${this._tplDayDetailOverlay()}

      <div class="toast-stack" id="toast-stack"></div>
    `;
  }

  /* ── Routing ───────────────────────────────────────────────────────────── */

  _renderCurrentView() {
    const container = this._el("view-container");
    if (!container) return;
    if (this._view === "main") {
      container.innerHTML = this._tplMainView();
      this._bindMainView();
    } else if (this._view.startsWith("plot:")) {
      container.innerHTML = this._tplPlotView(this._activePlot);
      this._bindPlotView();
    }
  }

  /* ── Main view ─────────────────────────────────────────────────────────── */

  _tplMainView() {
    const weather = this._readWeatherSnapshot();
    const plants  = this._allPlants();
    const thirstyPlants = plants.filter(needsWater);
    const needWater = thirstyPlants.length;
    const plots = this._plotsCache || [];

    // Build the peach-gradient alert banner when plants need water.
    // Suppressed when (a) dismissed for this session OR (b) zero thirsty.
    // The dismiss state is held on the card instance (resets on page reload)
    // since this is more of a "hide for now" than a permanent setting.
    const alertHtml = (needWater > 0 && !this._alertDismissed)
      ? `<div class="alert-banner" id="agribud-alert-banner">
          <div class="alert-banner-body">
            <span class="alert-banner-icon">💧</span>
            <div class="alert-banner-text">
              <div class="alert-banner-title">${needWater} plant${needWater===1?"":"s"} need watering</div>
              <div class="alert-banner-sub">${this._esc(thirstyPlants.slice(0,3).map(p => p.plant_name || p.name || "?").join(" · "))}${thirstyPlants.length>3?` +${thirstyPlants.length-3} more`:""}</div>
            </div>
          </div>
          <button class="alert-banner-dismiss" id="dismiss-alert-btn">Dismiss</button>
        </div>`
      : "";

    return `
      ${this._tplPills(weather)}
      ${alertHtml}
      <div class="metrics">
        <div class="metric" data-metric="temperature" title="Click for history">
          <div class="metric-val">${this._fmtWeatherValue(weather, "temperature")}</div>
          <div class="metric-lbl">Current</div>
        </div>
        <div class="metric" data-metric="humidity" title="Click for history">
          <div class="metric-val">${this._fmtWeatherValue(weather, "humidity")}</div>
          <div class="metric-lbl">Humidity</div>
        </div>
        <div class="metric" data-metric="active-plants">
          <div class="metric-val">${plants.length}</div>
          <div class="metric-lbl">Plants active</div>
        </div>
        <div class="metric" data-metric="need-water">
          <div class="metric-val">${needWater}</div>
          <div class="metric-lbl">Need water</div>
        </div>
      </div>

      <hr class="divider">
      <div class="sec-title">
        <span>Growth planner</span>
        <div class="planner-controls">
          <button class="planner-tab ${this._plannerScale==='week'?'active':''}" data-scale="week">Week</button>
          <button class="planner-tab ${this._plannerScale==='season'?'active':''}" data-scale="season">Season</button>
        </div>
      </div>
      ${this._tplPlanner(plants, weather)}

      <hr class="divider">
      <div class="sec-title">
        <span>Plants</span>
        ${plants.length > 5
          ? `<span style="font-size:11px;color:var(--secondary-text-color);font-weight:400">${plants.length} total · scroll for more</span>`
          : ""}
      </div>
      <div class="plants-scroll">${this._tplPlantTable(plants)}</div>

      <hr class="divider">
      <div class="sec-title">
        <span>Grow plots</span>
        <span style="font-size:11px;color:var(--secondary-text-color);font-weight:400">← swipe →</span>
      </div>
      <div class="plot-strip-wrap">
        <div class="plot-strip">
          ${this._plotsCache === null
            // Initial-load skeleton: a couple of muted placeholder tiles so
            // the section doesn't look empty while the fetch is in flight.
            ? `<div class="plot-card plot-card-skeleton"></div>
               <div class="plot-card plot-card-skeleton"></div>`
            : plots.map(p => `
                <div class="plot-card" data-plot-id="${p.id}">
                  <div class="plot-card-name">📍 ${this._esc(p.name)}</div>
                  <div class="plot-card-count">${p.plant_count || 0} plant${p.plant_count===1?"":"s"}</div>
                  ${p.description ? `<div class="plot-card-desc">${this._esc(p.description)}</div>` : ""}
                </div>
              `).join("")
          }
          <div class="plot-card plot-card-add" id="add-plot-btn">
            <div style="font-size:24px;margin-bottom:4px">+</div>
            <div style="font-size:12px">Add grow plot</div>
          </div>
        </div>
      </div>
    `;
  }

  _bindMainView() {
    this.shadowRoot.querySelectorAll(".plot-card[data-plot-id]").forEach(el => {
      el.onclick = () => this._openPlot(el.dataset.plotId);
    });
    const addPlot = this._el("add-plot-btn");
    if (addPlot) addPlot.onclick = () => this._open("add-plot-overlay");

    this.shadowRoot.querySelectorAll(".metric[data-metric]").forEach(el => {
      el.onclick = () => this._handleMetricClick(el.dataset.metric);
    });

    this.shadowRoot.querySelectorAll(".planner-tab").forEach(btn => {
      btn.onclick = () => {
        this._plannerScale = btn.dataset.scale;
        this._plannerOffset = 0;  // reset to current period when switching scales
        this._renderCurrentView();
      };
    });

    const prev = this._el("planner-prev");
    if (prev) prev.onclick = () => { this._plannerOffset -= 1; this._renderCurrentView(); };
    const next = this._el("planner-next");
    if (next) next.onclick = () => { this._plannerOffset += 1; this._renderCurrentView(); };
    const todayBtn = this._el("planner-today");
    if (todayBtn) todayBtn.onclick = () => { this._plannerOffset = 0; this._renderCurrentView(); };

    const dfb = this._el("dismiss-frost-btn");
    if (dfb) dfb.onclick = () => dfb.parentNode?.remove();

    // Peach alert banner — dismiss flag persists for the rest of the
    // session (resets on reload). Hidden via _alertDismissed flag, then
    // re-rendered without the banner on next paint.
    const dab = this._el("dismiss-alert-btn");
    if (dab) dab.onclick = () => {
      this._alertDismissed = true;
      const banner = this._el("agribud-alert-banner");
      if (banner) banner.style.display = "none";
    };

    // Season view: click a plant card to drill into history. Active and
    // soft-deleted plants route to the regular trading-card overlay
    // (which has species_data); archived plants route to a slim event-
    // log overlay (no species_data, just the history timeline).
    this.shadowRoot.querySelectorAll(".season-plant-card").forEach(el => {
      el.onclick = () => {
        const pid = el.dataset.pid;
        const archived = el.dataset.archived === "1";
        if (archived) {
          this._openArchivedPlantHistory(pid);
        } else {
          this._openPlantDetail(pid);
        }
      };
    });

    // Month-view plant thumbnails: clicking a thumbnail opens the plant detail
    // popup. Stop propagation so the day cell click handler below doesn't fire.
    this.shadowRoot.querySelectorAll(".cal-plant[data-cal-pid]").forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        this._openPlantDetail(el.dataset.calPid);
      };
    });
    // Day cells with events: open the per-day overlay listing all plants
    // active on that date, each clickable to open its plant detail.
    this.shadowRoot.querySelectorAll(".cal-day[data-cal-day]").forEach(el => {
      el.onclick = () => this._openDayDetail(el.dataset.calDay);
    });
    // Growth planner row labels: clicking the plant name on a planner row
    // opens that plant's detail popup, providing a path to the plant from
    // the main view without going through grow plots.
    this.shadowRoot.querySelectorAll(".plan-lbl-clickable[data-planner-pid]").forEach(el => {
      el.onclick = () => this._openPlantDetail(el.dataset.plannerPid);
    });
  }

  _handleMetricClick(metric) {
    if (metric === "temperature" || metric === "humidity") {
      this._openSparkline(metric);
    } else if (metric === "need-water") {
      this._openWaterList();
    } else if (metric === "active-plants") {
      this._openActivePlants();
    }
  }

  /* ── Plot detail view ──────────────────────────────────────────────────── */

  _openPlot(plotId) {
    const plot = (this._plotsCache || []).find(p => p.id === plotId);
    if (!plot) return;
    this._activePlot = plot;
    this._view = `plot:${plotId}`;
    this._renderCurrentView();
  }

  _backToMain() {
    this._view = "main";
    this._activePlot = null;
    this._fetchPlots().then(() => this._renderCurrentView());
  }

  _tplPlotView(plot) {
    if (!plot) return "<p>Grow plot not found.</p>";
    const plants = plot.plants || [];
    return `
      <div class="plot-hdr">
        <button class="plot-back" id="plot-back-btn">← All plots</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:18px;font-weight:600">📍 ${this._esc(plot.name)}</div>
          ${plot.description ? `<div style="font-size:12px;color:var(--secondary-text-color);margin-top:3px">${this._esc(plot.description)}</div>` : ""}
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-accent" id="add-plant-to-plot-btn">+ Add plant</button>
          ${plot.virtual ? "" : `<button class="btn btn-danger" id="remove-plot-btn">Remove plot</button>`}
        </div>
      </div>

      <hr class="divider">
      <div class="sec-title">Plants in this plot</div>
      ${this._tplPlantTable(plants)}
    `;
  }

  _bindPlotView() {
    const back = this._el("plot-back-btn");
    if (back) back.onclick = () => this._backToMain();
    const addBtn = this._el("add-plant-to-plot-btn");
    if (addBtn) addBtn.onclick = () => this._openAddPlant(this._activePlot.id, this._activePlot.name);
    const remBtn = this._el("remove-plot-btn");
    if (remBtn) remBtn.onclick = () => this._removePlot(this._activePlot.id);
    this._bindPlantRows();
  }

  async _removePlot(plotId) {
    if (!confirm(`Remove this grow plot? Plants in it will become unassigned (not deleted).`)) return;
    try {
      const { status, data } = await this._apiFetch(`/plots/${encodeURIComponent(plotId)}`, {
        method: "DELETE",
      });
      if (data.ok) {
        this._ok("Grow plot removed.");
        this._backToMain();
      } else {
        this._err("Remove failed", data.message || `HTTP ${status}`);
      }
    } catch (e) {
      this._err("Remove failed", this._fmtErr(e, "agribud"));
    }
  }

  /* ── Plant table (used in plot view + active plants list) ──────────────── */

  _tplPlantTable(plants) {
    if (!plants.length) {
      return `<p style="font-size:13px;color:var(--secondary-text-color);padding:12px 0">No plants yet — tap "+ Add plant" to get started.</p>`;
    }
    return `
      <table class="plant-table plant-table-wide">
        <thead><tr>
          <th>Plant</th>
          <th>Planted</th>
          <th>Harvest season</th>
          <th>Last watered</th>
          <th>Fertilized</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${plants.map(p => {
            const [label, bg, color] = stageBadge(p);
            // Status indicator: 💧 if needs water (manual was the most recent
            // source), 🌧 if last watering came from rain, ✓ otherwise. Placed
            // next to the icon so users can see at a glance which plants
            // need attention without opening each card.
            const status = plantWaterStatus(p);
            const thumbInner = p.image_url
              ? `<img src="${p.image_url}" style="width:28px;height:28px;border-radius:4px;object-fit:cover" loading="lazy">`
              : `<span style="font-size:22px;line-height:1">${plantEmoji(p.plant_name || p.name)}</span>`;
            const thumb = `<div class="plant-icon-wrap">
              ${thumbInner}
              ${status.badge}
            </div>`;
            const pid = p.plant_id || p.id;
            const harvestSeason = p.harvest_season ||
                                  ((p.species_data || {}).harvest_season);
            const harvestDisp = harvestSeason
              ? this._esc(String(harvestSeason))
              : `<span style="opacity:.6">Not available</span>`;
            // Need-watered cell: show the days-since count colored red when
            // the plant is overdue, with a 🌧 indicator if the last water
            // event came from rain so the user knows nature did the watering.
            const dsw = p.days_since_watered;
            const wcell = dsw == null
              ? `<span style="opacity:.6">—</span>`
              : (status.overdue
                  ? `<span style="color:#993C1D;font-weight:600">${daysAgo(dsw)}</span>`
                  : daysAgo(dsw));
            return `
              <tr class="plant-row" data-pid="${pid}">
                <td>
                  <div class="plant-name-cell">${thumb}
                    <div>
                      <div>${this._esc(p.plant_name || p.name || p.entity_id)}</div>
                      <span class="badge" style="background:${bg};color:${color}">${label}</span>
                    </div>
                  </div>
                </td>
                <td class="plant-table-meta" data-label="Started">${isoDisp(p.start_date)}</td>
                <td class="plant-table-meta" data-label="Harvest">${harvestDisp}</td>
                <td class="plant-table-meta" data-label="Watered">${wcell}</td>
                <td class="plant-table-meta" data-label="Fertilized">${daysAgo(p.days_since_fertilized)}</td>
                <td class="chev">›</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  _bindPlantRows() {
    this.shadowRoot.querySelectorAll(".plant-row").forEach(row => {
      row.onclick = () => this._openPlantDetail(row.dataset.pid);
    });
  }

  /* ── Pills / weather formatting ─────────────────────────────────────────── */

  _tplPills(w) {
    let out = "";
    if (w.rainToday)  out += `<span class="pill"><span class="dot" style="background:#378ADD"></span>Rain today</span>`;
    if (w.frostRisk)  out += `<span class="pill"><span class="dot" style="background:#E24B4A"></span>Frost risk tonight</span>`;
    return out ? `<div class="pills">${out}</div>` : "";
  }

  _readWeatherSnapshot() {
    // Reads RAW values from the configured weather entity — no conversion.
    const entityId = this._config.weather_entity || this._guessWeatherEntity();
    const state = getWeatherEntityState(this._hass, entityId);
    if (!state) return { temperature: null, humidity: null };
    const a = state.attributes || {};
    // Frost / rain from Agribud sensors
    const frostS = Object.values(this._hass.states).find(
      s => s.entity_id?.startsWith("binary_sensor.agribud_frost_risk") &&
           !(s.attributes || {}).plant_name
    );
    const rainS = Object.values(this._hass.states).find(
      s => s.entity_id?.startsWith("binary_sensor.agribud_rain_today")
    );
    return {
      temperature:     a.temperature,
      temperature_unit: a.temperature_unit,
      humidity:        a.humidity,
      humidity_unit:   "%",
      condition:       state.state,
      weather_entity:  entityId,
      frostRisk:       frostS?.state === "on",
      rainToday:       rainS?.state === "on",
    };
  }

  _guessWeatherEntity() {
    // Auto-detect any weather.* entity if config didn't specify one
    return Object.keys(this._hass.states).find(id => id.startsWith("weather.")) || null;
  }

  _fmtWeatherValue(w, field) {
    const val = w[field];
    if (val == null) return "—";
    const unit = w[`${field}_unit`] || (field === "humidity" ? "%" : "");
    return `${Math.round(Number(val) * 10) / 10}${unit}`;
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
    }[c]));
  }

  /* ── Inline planner (week / month) ─────────────────────────────────────── */

  // Orchestrates the planner across the two scales (week, month).
  _tplPlanner(plants, weather) {
    // Stale config might still have scale="month" from older versions —
    // we replaced the month view with the season view in v0.4.8. Fall
    // back to week for any unrecognized scale.
    const scale = (this._plannerScale === "season") ? "season" : "week";
    const today = new Date();

    let body, navLabel;
    if (scale === "week") {
      const view = this._plannerWeekRange(today, this._plannerOffset);
      navLabel = view.label;
      body = this._tplPlannerWeek(plants, view, today);
    } else {
      // Season view — offset advances by full seasons (3 months) at a time
      const view = this._plannerSeasonRange(today, this._plannerOffset);
      navLabel = view.label;
      body = this._tplPlannerSeason(view, today);
    }

    const frost = weather.frostRisk
      ? `<div class="frost-banner"><span>❄️ <strong>Frost risk tonight</strong> — consider covering frost-sensitive plants</span><button class="btn" id="dismiss-frost-btn">Dismiss</button></div>`
      : "";

    return `
      <div class="planner-nav">
        <button class="planner-nav-btn" id="planner-prev" title="Previous">‹</button>
        <div class="planner-nav-label">${this._esc(navLabel)}</div>
        <div style="display:flex;gap:6px;align-items:center">
          ${this._plannerOffset !== 0 ? `<button class="planner-nav-today" id="planner-today">Today</button>` : ""}
          <button class="planner-nav-btn" id="planner-next" title="Next">›</button>
        </div>
      </div>
      ${body}
      <div class="plan-legend-group">
        <div class="leg-row-label">Care</div>
        <div class="plan-legend">
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.planted}"></span>Planted</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.transplanted}"></span>Transplanted</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.watered}"></span>Watered</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.fertilized}"></span>Fertilized</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.sprouted}"></span>Sprouted</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.harvested}"></span>Harvested</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.dead}"></span>Died</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.other}"></span>Other</div>
        </div>
      </div>
      <div class="plan-legend-group">
        <div class="leg-row-label">Events</div>
        <div class="plan-legend">
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.rain_detected}"></span>Rain</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.snow}"></span>Snow</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.frost_alert}"></span>Frost</div>
          <div class="leg-item"><span class="evt-dot" style="background:${PLANNER_EVENT_COLORS.pest}"></span>Pest</div>
        </div>
      </div>
      ${frost}`;
  }

  // Compute the week range (Mon → Sun) given an offset in weeks.
  _plannerWeekRange(today, offset) {
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7) + offset * 7);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon); d.setDate(mon.getDate() + i); return d;
    });
    const sun = days[6];
    const sameMonth = mon.getMonth() === sun.getMonth();
    const ws = mon.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const we = sun.toLocaleDateString("en-US", sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" });
    const label = `Week of ${ws}–${we}, ${sun.getFullYear()}`;
    return { days, label };
  }

  _tplPlannerWeek(plants, view, today) {
    const todayKey = today.toISOString().slice(0, 10);
    const dayLbls = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const hdrs = dayLbls.map((l, i) => {
      const isToday = view.days[i].toISOString().slice(0,10) === todayKey;
      return `<div class="planner-hdr${isToday?' today':''}">${l} <span style="opacity:.5">${view.days[i].getDate()}</span></div>`;
    }).join("");

    if (!plants.length) {
      return `<div class="planner-hdrs">${hdrs}</div>
        <p style="font-size:13px;color:var(--secondary-text-color);padding:12px 0">No plants yet — add a grow plot and plants to see the planner.</p>`;
    }

    const rows = plants.map(p => {
      const evts = this._eventsWithProjections(p);
      const cellHtml = view.days.map(d => {
        const ds = d.toISOString().slice(0, 10);
        const ev = evts.find(e => e.date === ds);
        const dot = ev ? this._evMarker(ev) : "";
        const isFuture = d > today;
        const isToday  = ds === todayKey;
        return `<div class="plan-cell${isToday?' today':''}${isFuture?' future':''}">${dot}</div>`;
      }).join("");
      return this._plannerRowFor(p, cellHtml);
    }).join("");

    return `<div class="planner-hdrs">${hdrs}</div>${rows}`;
  }

  // ── Season range: compute which season + year the offset points at ────
  // offset 0 = current season at `today`, -1 = previous season, +1 = next.
  // A "season" is a 3-month window per Northern-hemisphere convention,
  // mirrored from the existing seasonForDate() helper:
  //   winter: Dec 21 → Mar 20  (year of the Dec part)
  //   spring: Mar 21 → Jun 20
  //   summer: Jun 21 → Sep 21
  //   fall:   Sep 22 → Dec 20
  _plannerSeasonRange(today, offset) {
    const order = ["winter", "spring", "summer", "fall"];
    // Resolve today's season + year
    let curSeason = seasonForDate(today);
    let curYear = today.getFullYear();
    // Winter spans Dec → Mar — anchor it to the year of December for label
    // consistency (so Dec 2025 and Feb 2026 both show "Winter 2025").
    if (curSeason === "winter" && today.getMonth() <= 2) curYear -= 1;
    // Apply offset (each step = one full season forward/back)
    let idx = order.indexOf(curSeason) + offset;
    let year = curYear;
    while (idx < 0) { idx += 4; year -= 1; }
    while (idx >= 4) { idx -= 4; year += 1; }
    const season = order[idx];
    // Compute the start + end ISO dates of that season-year
    let startISO, endISO;
    if (season === "winter") {
      startISO = `${year}-12-21`;
      endISO   = `${year + 1}-03-20`;
    } else if (season === "spring") {
      startISO = `${year}-03-21`;
      endISO   = `${year}-06-20`;
    } else if (season === "summer") {
      startISO = `${year}-06-21`;
      endISO   = `${year}-09-21`;
    } else {
      startISO = `${year}-09-22`;
      endISO   = `${year}-12-20`;
    }
    const label = `${season.charAt(0).toUpperCase()}${season.slice(1)} ${year}`;
    return { season, year, startISO, endISO, label };
  }

  // Build the season view body — a list of plants planted within
  // [startISO, endISO]. Pulled from this._seasonViewCache (fetched async
  // on first use). Each plant card shows name, start date, end status +
  // date (or "Growing" for active plants). Tap routes to either the
  // regular trading-card (active plants) or a slim event-log view
  // (archived plants — no species_data to render).
  _tplPlannerSeason(view, today) {
    const all = this._seasonViewCache;
    if (all === undefined || all === null) {
      // Trigger the fetch in the background and show a placeholder
      this._fetchSeasonView();
      return `<div class="season-empty">Loading season history…</div>`;
    }
    // Filter to plants whose start_date falls inside this season+year
    const inSeason = (all || []).filter(p => {
      const s = p.start_date || "";
      return s && s >= view.startISO && s <= view.endISO;
    });
    if (!inSeason.length) {
      return `<div class="season-empty">No plants started in ${this._esc(view.label)}.</div>`;
    }
    // Sort newest start_date first
    inSeason.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
    const cards = inSeason.map(p => {
      const startDisp = isoDisp(p.start_date);
      // End-status pill: matches the sensor enum + adds "removed" + "growing"
      const STATUS = {
        growing:    { label: "Growing",   bg: "#E1F5EE", color: "#0F6E56" },
        harvested:  { label: "Harvested", bg: "#EAEAEA", color: "#5F5E5A" },
        dead:       { label: "Dead",      bg: "#D6D6D6", color: "#2A2A2A" },
        removed:    { label: "Removed",   bg: "#F4ECE2", color: "#7A6230" },
      };
      const sInfo = STATUS[p.end_status] || STATUS.growing;
      const endDisp = p.end_date
        ? ` <span style="opacity:.7;font-size:11px">on ${isoDisp(p.end_date)}</span>`
        : "";
      const archivedNote = p.archived
        ? ` <span class="season-archived-tag" title="6+ months old — species data no longer cached">history only</span>`
        : "";
      return `
        <div class="season-plant-card" data-pid="${this._esc(p.id)}" data-archived="${p.archived?'1':'0'}">
          <div class="season-plant-name">${this._esc(p.name || "Unnamed")}${archivedNote}</div>
          <div class="season-plant-meta">
            <span class="season-plant-date">📅 Started ${startDisp}</span>
            <span class="status-pill" style="background:${sInfo.bg};color:${sInfo.color}">
              ${sInfo.label}${endDisp}
            </span>
          </div>
        </div>`;
    }).join("");
    return `<div class="season-list">${cards}</div>`;
  }

  // Fetch the merged season view (active + soft-deleted + archived) from
  // the backend's /season endpoint. Caches the result on the card; the
  // bus event subscription invalidates the cache on plant/event changes.
  async _fetchSeasonView() {
    if (this._seasonViewFetching) return;
    this._seasonViewFetching = true;
    try {
      const { status, data } = await this._apiFetch("/season");
      if (status === 200 && data && Array.isArray(data.results)) {
        this._seasonViewCache = data.results;
        // Re-render only if we're currently looking at the season view
        if (this._plannerScale === "season" && this._view === "main") {
          this._render();
        }
      } else {
        this._seasonViewCache = [];
      }
    } catch (e) {
      console.warn("Agribud: season fetch failed:", e);
      this._seasonViewCache = [];
    } finally {
      this._seasonViewFetching = false;
    }
  }


  _evMarker(ev) {
    const color = PLANNER_EVENT_COLORS[ev.type] || PLANNER_EVENT_COLORS.other;
    return `<span class="evt-dot" style="background:${color}"></span>`;
  }

  // Returns the persisted event list for a plant. We no longer synthesize
  // harvest projections — Perenual doesn't expose days_to_harvest, so harvest
  // info is shown as a season string in the plant table and Tips, not as a
  // calendar event.
  _eventsWithProjections(p) {
    return (p.recent_events || p.events_sorted || p.events || []).slice();
  }

  _plannerRowFor(p, cellHtml) {
    const thumb = p.image_url
      ? `<img src="${p.image_url}" style="width:18px;height:18px;border-radius:3px;object-fit:cover;vertical-align:middle;margin-right:3px" loading="lazy">`
      : plantEmoji(p.plant_name || p.name);
    const dg = p.days_growing;
    const dgLabel = dg == null ? "" : (dg < 0 ? `In ${-dg}d` : `Day ${dg}`);
    const pid = p.plant_id || p.id;
    return `
      <div class="plan-row">
        <div class="plan-lbl plan-lbl-clickable" data-planner-pid="${pid}" title="Open ${this._esc(p.plant_name || p.name || "plant")}">
          <div class="plan-lbl-name">${thumb} ${this._esc(p.plant_name || p.name)}</div>
          <div class="plan-lbl-sub">${dgLabel}</div>
        </div>
        <div class="plan-days">${cellHtml}</div>
      </div>`;
  }

  /* ── Static control bindings ───────────────────────────────────────────── */

  _bindStaticControls() {
    this._el("open-settings-btn").onclick = () => this._openSettings();

    // Plant detail overlay (trading card)
    this._el("close-plant-btn").onclick = () => this._close("plant-overlay");
    this._el("plant-overlay").onclick = e => { if (e.target.id === "plant-overlay") this._close("plant-overlay"); };
    // Settings gear in the trading-card header opens the Plant settings
    // collapsible section automatically.
    const settingsBtn = this._el("open-plant-settings-btn");
    if (settingsBtn) {
      settingsBtn.onclick = () => {
        const sections = this.shadowRoot.querySelectorAll(".tc-section");
        // The settings <details> is the third one in the footer
        sections.forEach(s => { s.open = false; });
        if (sections[2]) {
          sections[2].open = true;
          sections[2].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      };
    }
    this._el("save-evt-btn").onclick = () => this._saveEvent();
    this._el("save-ps-btn").onclick = () => this._savePlantSettings();
    this._el("remove-plant-btn").onclick = () => this._removePlant();
    const saveOvBtn  = this._el("save-ov-btn");
    const clearOvBtn = this._el("clear-ov-btn");
    if (saveOvBtn)  saveOvBtn.onclick  = () => this._saveOverrides();
    if (clearOvBtn) clearOvBtn.onclick = () => this._clearOverrides();
    const ed = this._el("evt-date"); if (ed) ed.value = new Date().toISOString().slice(0, 10);

    // Settings overlay
    this._el("close-settings-btn").onclick = () => this._close("settings-overlay");
    this._el("settings-overlay").onclick = e => { if (e.target.id === "settings-overlay") this._close("settings-overlay"); };
    this._el("test-api-btn").onclick = () => this._testConnection();
    this._el("save-settings-btn").onclick = () => this._saveSettings();

    // Water list overlay
    this._el("close-water-btn").onclick = () => this._close("water-overlay");
    this._el("water-overlay").onclick = e => { if (e.target.id === "water-overlay") this._close("water-overlay"); };

    // Active plants overlay
    this._el("close-active-btn").onclick = () => this._close("active-overlay");
    this._el("active-overlay").onclick = e => { if (e.target.id === "active-overlay") this._close("active-overlay"); };

    // Sparkline overlay
    this._el("close-spark-btn").onclick = () => this._close("spark-overlay");
    this._el("spark-overlay").onclick = e => { if (e.target.id === "spark-overlay") this._close("spark-overlay"); };

    // Add plot overlay
    this._el("close-add-plot-btn").onclick = () => this._close("add-plot-overlay");
    this._el("add-plot-overlay").onclick = e => { if (e.target.id === "add-plot-overlay") this._close("add-plot-overlay"); };
    this._el("confirm-add-plot-btn").onclick = () => this._confirmAddPlot();

    // Day-detail overlay (opened by clicking a day cell in the month view)
    this._el("close-day-btn").onclick = () => this._close("day-overlay");
    this._el("day-overlay").onclick = e => { if (e.target.id === "day-overlay") this._close("day-overlay"); };
  }

  _open(id)  { this._el(id)?.classList.add("open"); }
  _close(id) { this._el(id)?.classList.remove("open"); }

  /* ── Plant detail ──────────────────────────────────────────────────────── */

  // Trading-card layout for the plant detail view. Single-view (no tabs),
  // organized top-to-bottom:
  //   • Floating header row above the image — invasive_alert badge (right)
  //   • Plant image with two circular overlay chips: light_requirements (left)
  //     and hardiness range (right)
  //   • Name block: common_name (bold) + noxious chip + scientific_name italic
  //   • Brief details grid: habitat | flowering_seasons + hardiness range
  //   • Soil + water row, then full description
  //   • Footer with collapsible History + Log event + plant settings
  // Trading-card layout (Verdantly era, v0.4.0):
  //   • Themed playing-card frame with leaf-vine border styling
  //   • Top banner: name centered, light chip top-left, water chip top-right
  //   • Plant image area in the middle (real image from imageUrl, or emoji)
  //   • Scientific name banner below image
  //   • Scrollable details panel with field grid:
  //     Soil Preference, Spacing, Growth Period, pH Range, Hardiness Zones,
  //     Toxicity, Harvest Range — followed by Care Instructions
  //   • Taxonomy footer: family | genus | species
  //   • Below the card: collapsible history / log event / edit / settings
  _tplPlantOverlay() {
    return `<div class="overlay" id="plant-overlay"><div class="popup popup-card">
      <div class="popup-hdr popup-hdr-minimal">
        <span class="tc-invasive-badge" id="tc-invasive" title="Invasive species" style="display:none">⚠</span>
        <button class="popup-hdr-action" id="open-plant-settings-btn" title="Edit plant details">⚙</button>
        <button class="close-btn" id="close-plant-btn">✕</button>
      </div>
      <div class="popup-body popup-body-card">
        <!-- Modern plant card: clean white surface, plant image with status
             pill overlay, name + sci, soft pastel light/water tiles, key/value
             grid for the data, dividers between sections, taxonomy footer. -->
        <div class="tc tc-modern">
          <!-- Plant: image area with status pill in the top-right corner -->
          <div class="tcm-image" id="tc-image-wrap">
            <div class="tcm-image-content" id="tc-image">🌱</div>
            <span class="tcm-status-pill tcm-status-healthy" id="tc-status-pill">
              <span class="tcm-status-dot"></span>
              <span id="tc-status-text">Healthy</span>
            </span>
            <span class="tcm-invasive-pill" id="tc-invasive" style="display:none" title="Invasive species">⚠ Invasive</span>
          </div>
          <div class="tcm-body">
            <!-- Name + scientific -->
            <div class="tcm-name" id="tc-common-name"></div>
            <div class="tcm-sci" id="tc-sci-name"></div>
            <!-- Light + Water tiles. Background emoji art is large + faded so
                 the value is what reads first; the icon identifies the tile. -->
            <div class="tcm-tile-row">
              <div class="tcm-tile tcm-tile-light" id="tc-light-chip" title="Light needs">
                <div class="tcm-tile-bg" aria-hidden="true">☀️</div>
                <div class="tcm-tile-label">Light</div>
                <div class="tcm-tile-value" id="tc-light-text">—</div>
              </div>
              <div class="tcm-tile tcm-tile-water" id="tc-water-chip" title="Water needs">
                <div class="tcm-tile-bg" aria-hidden="true">💧</div>
                <div class="tcm-tile-label">Water</div>
                <div class="tcm-tile-value" id="tc-water-text">—</div>
              </div>
            </div>
            <!-- Key/value detail grid -->
            <div class="tcm-kv-grid">
              <span class="tcm-kv-label">Hardiness</span>
              <span class="tcm-kv-value" id="tc-hardiness">—</span>
              <span class="tcm-kv-label">Soil pH</span>
              <span class="tcm-kv-value" id="tc-ph-range">—</span>
              <span class="tcm-kv-label">Soil preference</span>
              <span class="tcm-kv-value" id="tc-soil-pref">—</span>
              <span class="tcm-kv-label">Spacing</span>
              <span class="tcm-kv-value" id="tc-spacing">—</span>
              <span class="tcm-kv-label">Growth period</span>
              <span class="tcm-kv-value" id="tc-growth-period">—</span>
              <span class="tcm-kv-label">Harvest</span>
              <span class="tcm-kv-value" id="tc-harvest">—</span>
              <span class="tcm-kv-label">Water schedule</span>
              <span class="tcm-kv-value" id="tc-water-range">—</span>
              <span class="tcm-kv-label">Days since water</span>
              <span class="tcm-kv-value" id="tc-days-since-water">—</span>
              <span class="tcm-kv-label">Toxicity</span>
              <span class="tcm-kv-value tcm-kv-value-warn" id="tc-toxicity">—</span>
            </div>
            <!-- Care instructions: subtle divider, smaller text, scrollable -->
            <div class="tcm-care">
              <div class="tcm-care-label">Care instructions</div>
              <div class="tcm-care-text" id="tc-care">—</div>
            </div>
            <!-- Taxonomy footer (family · genus · species) -->
            <div class="tcm-tax" id="tc-taxonomy">—</div>
          </div>
        </div>
        <!-- Footer actions: history, log event, settings -->
        <div class="tc-footer">
          <details class="tc-section">
            <summary class="tc-section-summary">📜 History &amp; events</summary>
            <div id="tab-history" style="margin-top:8px"></div>
          </details>
          <details class="tc-section">
            <summary class="tc-section-summary">➕ Log a new event</summary>
            <div style="margin-top:8px">
              <div class="form-row"><span class="form-label">Event type</span>
                <select class="form-select" id="evt-type">
                  <option value="watered">Watered</option>
                  <option value="fertilized">Fertilized</option>
                  <option value="pest_spotted">Pest spotted</option>
                  <option value="snow">Snow</option>
                  <option value="sprouted">Sprouted</option>
                  <option value="harvested">Harvested</option>
                  <option value="transplanted">Transplanted / repotted</option>
                  <option value="other">Other (add custom text in note)</option>
                </select>
              </div>
              <div class="form-row"><span class="form-label">Date</span><input class="form-input" type="date" id="evt-date"></div>
              <div class="form-row"><span class="form-label">Notes (optional)</span><textarea class="form-textarea" id="evt-note"></textarea></div>
              <button class="btn btn-accent btn-full" id="save-evt-btn">Save event</button>
            </div>
          </details>
          <details class="tc-section">
            <summary class="tc-section-summary">✎ Edit plant details</summary>
            <div style="margin-top:8px">
              <p style="font-size:11px;color:var(--secondary-text-color);margin-bottom:10px;line-height:1.4">
                Override Verdantly values for this plant. Empty fields fall back to Verdantly's data.
                Overrides are stored per-plant and don't affect other plants of the same species.
              </p>
              <div class="form-row"><span class="form-label">Common name</span>
                <input class="form-input" type="text" id="ov-common-name" placeholder="(uses Verdantly value)">
              </div>
              <div class="form-row"><span class="form-label">Scientific name</span>
                <input class="form-input" type="text" id="ov-scientific-name" placeholder="(uses Verdantly value)">
              </div>
              <div class="form-row"><span class="form-label">Light</span>
                <input class="form-input" type="text" id="ov-light" placeholder="e.g. Full Sun, Partial Shade">
              </div>
              <!-- Water override — TWO numeric inputs (min, max) with greyed
                   placeholders that show the Verdantly-derived default range.
                   The min value is what the needs_water sensor + automations use. -->
              <div class="form-row">
                <span class="form-label">💧 Water (days between)</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <input class="form-input ov-water-num" type="number" min="1" max="365"
                         id="ov-water-min" placeholder="min days"
                         title="Minimum days between waterings — used as the alert threshold for automations">
                  <span style="color:var(--secondary-text-color);font-size:14px">to</span>
                  <input class="form-input ov-water-num" type="number" min="1" max="365"
                         id="ov-water-max" placeholder="max days"
                         title="Maximum days between waterings (for display only)">
                </div>
              </div>
              <div class="form-row"><span class="form-label">Water requirement</span>
                <select class="form-select" id="ov-water-use">
                  <option value="">(use Verdantly value)</option>
                  <option value="Low">Low (default 7–14 days)</option>
                  <option value="Moderate">Moderate (default 3–7 days)</option>
                  <option value="High">High (default 1–3 days)</option>
                </select>
              </div>
              <div class="form-row"><span class="form-label">Soil preference</span>
                <input class="form-input" type="text" id="ov-soil-pref" placeholder="e.g. Well-drained loam">
              </div>
              <div class="form-row"><span class="form-label">Spacing</span>
                <input class="form-input" type="text" id="ov-spacing" placeholder="e.g. 24 inches">
              </div>
              <div class="form-row"><span class="form-label">Growth period</span>
                <input class="form-input" type="text" id="ov-growth-period" placeholder="e.g. Annual, Perennial">
              </div>
              <div class="form-row"><span class="form-label">Soil pH — min</span>
                <input class="form-input" type="number" step="0.1" min="0" max="14" id="ov-ph-min" placeholder="e.g. 6.0">
              </div>
              <div class="form-row"><span class="form-label">Soil pH — max</span>
                <input class="form-input" type="number" step="0.1" min="0" max="14" id="ov-ph-max" placeholder="e.g. 6.8">
              </div>
              <div class="form-row"><span class="form-label">Hardiness zone — min</span>
                <input class="form-input" type="text" id="ov-zone-min" placeholder="e.g. 3">
              </div>
              <div class="form-row"><span class="form-label">Hardiness zone — max</span>
                <input class="form-input" type="text" id="ov-zone-max" placeholder="e.g. 11">
              </div>
              <div class="form-row"><span class="form-label">Days to harvest — min</span>
                <input class="form-input" type="number" min="1" id="ov-harvest-min" placeholder="e.g. 75">
              </div>
              <div class="form-row"><span class="form-label">Days to harvest — max</span>
                <input class="form-input" type="number" min="1" id="ov-harvest-max" placeholder="e.g. 90">
              </div>
              <div class="form-row"><span class="form-label">Invasive flag</span>
                <select class="form-select" id="ov-invasive">
                  <option value="">(use Verdantly value)</option>
                  <option value="true">Yes — show invasive badge</option>
                  <option value="false">No</option>
                </select>
              </div>
              <div class="form-row"><span class="form-label">Image URL</span>
                <input class="form-input" type="text" id="ov-image-url" placeholder="https://… (overrides Verdantly image)">
              </div>
              <div class="form-row"><span class="form-label">Care instructions</span>
                <textarea class="form-input" id="ov-care" rows="4" placeholder="(uses Verdantly care instructions)" style="resize:vertical;min-height:60px"></textarea>
              </div>
              <div style="display:flex;gap:8px;margin-top:4px">
                <button class="btn btn-accent" style="flex:1;padding:8px" id="save-ov-btn">Save overrides</button>
                <button class="btn" id="clear-ov-btn" title="Clear all overrides and revert to Verdantly values">Reset all</button>
              </div>
            </div>
          </details>
          <details class="tc-section">
            <summary class="tc-section-summary">⚙ Plant settings</summary>
            <div style="margin-top:8px">
              <div class="form-row"><span class="form-label">Display name</span><input class="form-input" type="text" id="ps-name"></div>
              <div class="form-row"><span class="form-label">Verdantly variety ID</span><input class="form-input" type="text" id="ps-slug" readonly style="opacity:.5"></div>
              <div class="form-row"><span class="form-label">Started from</span>
                <select class="form-select" id="ps-start-type"><option value="seed">Seed</option><option value="transplant">Transplant</option></select>
              </div>
              <div class="form-row"><span class="form-label">Start date</span><input class="form-input" type="date" id="ps-start-date"></div>
              <div class="form-row"><span class="form-label">Grow plot / location</span><input class="form-input" type="text" id="ps-location"></div>
              <div style="display:flex;gap:8px;margin-top:4px">
                <button class="btn btn-accent" style="flex:1;padding:8px" id="save-ps-btn">Save</button>
                <button class="btn btn-danger" id="remove-plant-btn">Remove plant</button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div></div>`;
  }

  /**
   * Open a slim history-only overlay for archived plants. Archived
   * plants have no species_data (the 6-month cache window has elapsed),
   * so the regular trading-card can't render meaningfully. Instead we
   * show: plant name, start/end dates, end status, and the full event
   * log timeline. Events are read-only (no removal — the plant itself
   * is no longer in active management).
   */
  _openArchivedPlantHistory(pid) {
    const all = this._seasonViewCache || [];
    const plant = all.find(p => p.id === pid);
    if (!plant) return;
    const STATUS = {
      growing:    { label: "Growing",   bg: "#E1F5EE", color: "#0F6E56" },
      harvested:  { label: "Harvested", bg: "#EAEAEA", color: "#5F5E5A" },
      dead:       { label: "Dead",      bg: "#D6D6D6", color: "#2A2A2A" },
      removed:    { label: "Removed",   bg: "#F4ECE2", color: "#7A6230" },
    };
    const sInfo = STATUS[plant.end_status] || STATUS.growing;
    const events = (plant.events || []).slice().sort(
      (a, b) => (b.date || "").localeCompare(a.date || "")
    );
    const eventDots = events.map(e => {
      const color = PLANNER_EVENT_COLORS[e.type] || PLANNER_EVENT_COLORS.other;
      const niceType = (e.type || "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
      return `<div class="hist-evt-row">
        <span class="evt-dot" style="background:${color};margin-right:8px"></span>
        <span class="hist-evt-date">${isoDisp(e.date)}</span>
        <span class="hist-evt-type">${this._esc(niceType)}</span>
        ${e.note ? `<div class="hist-evt-note">${this._esc(e.note)}</div>` : ""}
      </div>`;
    }).join("") || `<div style="font-size:12px;color:var(--secondary-text-color);padding:10px 0">No events recorded.</div>`;
    // Build + inject the overlay on demand. Re-injecting is fine — close
    // tears it down.
    const existing = this.shadowRoot.querySelector("#archive-history-overlay");
    if (existing) existing.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="overlay" id="archive-history-overlay">
      <div class="popup popup-card">
        <div class="popup-hdr popup-hdr-minimal">
          <button class="close-btn" id="close-archive-btn">✕</button>
        </div>
        <div class="popup-body">
          <div style="font-size:18px;font-weight:500;margin-bottom:4px">
            ${this._esc(plant.name || "Unnamed")}
          </div>
          <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:14px">
            📅 ${isoDisp(plant.start_date)}
            ${plant.end_date ? ` → ${isoDisp(plant.end_date)}` : ""}
            &nbsp;·&nbsp;
            <span class="status-pill" style="background:${sInfo.bg};color:${sInfo.color}">${sInfo.label}</span>
          </div>
          <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:8px;
                      padding:8px 10px;background:var(--secondary-background-color);
                      border-left:3px solid #C9923B;border-radius:4px;line-height:1.4">
            This plant's species data was archived after 6 months. Only the
            name, dates, and event log are preserved.
          </div>
          <div class="set-section">Event log</div>
          <div class="hist-evt-list">${eventDots}</div>
        </div>
      </div>
    </div>`;
    this.shadowRoot.appendChild(wrap.firstChild);
    this._open("archive-history-overlay");
    this._el("close-archive-btn").onclick = () => this._close("archive-history-overlay");
  }

  _openPlantDetail(pid) {
    const plant = this._allPlants().find(p => (p.plant_id || p.id) === pid);
    if (!plant) return;
    this._activePlant = plant;

    // store._enrich() has already projected every Verdantly nested field
    // onto the plant record as flat attributes (light_requirements,
    // water_use, soil_preference, hardiness_zone_range, taxonomy_display,
    // toxicity_display, harvest_range, etc.). Read directly here.
    const dash = "—";
    const v = (x) => {
      if (x === null || x === undefined) return dash;
      const s = String(x).trim();
      return s === "" ? dash : s;
    };

    // ── Status pill (top-right of Plant) ───────────────────────────────
    // Mirrors the sensor.py enum logic — keep these in sync. Five states:
    // healthy / thirsty / danger / harvested / scheduled.
    const statusInfo = this._computePlantStatus(plant);
    const pillEl = this._el("tc-status-pill");
    const pillText = this._el("tc-status-text");
    if (pillEl && pillText) {
      // Reset all status classes, apply the current one
      pillEl.classList.remove(
        "tcm-status-healthy", "tcm-status-thirsty",
        "tcm-status-danger",  "tcm-status-harvested",
        "tcm-status-dead",    "tcm-status-scheduled",
      );
      pillEl.classList.add(`tcm-status-${statusInfo.state}`);
      pillText.textContent = statusInfo.label;
    }

    // ── Invasive pill (under status pill) ─────────────────────────────
    const invEl = this._el("tc-invasive");
    if (invEl) invEl.style.display = plant.invasive_alert ? "inline-flex" : "none";

    // ── Plant image — real image if Verdantly provided one, else emoji ─
    const imgEl = this._el("tc-image");
    if (plant.image_url) {
      // Embed the image; if it fails to load, fall back to emoji.
      imgEl.innerHTML = `<img src="${this._esc(plant.image_url)}" loading="lazy"
        alt="${this._esc(plant.common_name || "")}"
        onerror="this.parentElement.textContent='${plantEmoji(plant.plant_name || plant.common_name || plant.name)}'">`;
    } else {
      imgEl.textContent = plantEmoji(plant.plant_name || plant.common_name || plant.name);
    }

    // ── Light + water chips (top banner) ──────────────────────────────
    this._el("tc-light-text").textContent = v(plant.light_requirements);
    this._el("tc-water-text").textContent = v(plant.water_use);

    // ── Name + scientific name banners ────────────────────────────────
    this._el("tc-common-name").textContent =
      plant.common_name || plant.plant_name || plant.name || "";
    this._el("tc-sci-name").textContent = plant.scientific_name || "";

    // ── Details panel: field grid ─────────────────────────────────────
    this._el("tc-soil-pref").textContent     = v(plant.soil_preference);
    this._el("tc-spacing").textContent       = v(plant.spacing_requirement);
    this._el("tc-growth-period").textContent = v(plant.growth_period);
    this._el("tc-ph-range").textContent      = v(plant.soil_ph_range);
    this._el("tc-hardiness").textContent     = v(plant.hardiness_zone_range);
    // Toxicity: backend filters out "non-toxic"/"mild" entries and returns
    // "Non-toxic" when nothing concerning is left. We only apply the red
    // warning color when there's an actual concerning level — "Non-toxic"
    // stays neutral.
    const toxEl = this._el("tc-toxicity");
    const toxText = plant.toxicity_display || "Non-toxic";
    toxEl.textContent = toxText;
    if (toxText.toLowerCase() === "non-toxic") {
      toxEl.classList.remove("tcm-kv-value-warn");
    } else {
      toxEl.classList.add("tcm-kv-value-warn");
    }
    this._el("tc-harvest").textContent       = v(plant.harvest_range);

    // Water schedule (numeric min..max days, what automations key off of)
    const wMin = plant.watering_min_days;
    const wMax = plant.watering_max_days;
    let waterRange = dash;
    if (wMin != null && wMax != null) {
      waterRange = wMin === wMax ? `every ${wMin} days` : `${wMin}–${wMax} days`;
    } else if (wMin != null) {
      waterRange = `every ${wMin} days`;
    } else if (wMax != null) {
      waterRange = `up to ${wMax} days`;
    }
    this._el("tc-water-range").textContent = waterRange;

    // Days since water — shows the integer count from days_since_watered
    // (computed in store._enrich, considers manual events AND weather log
    // rain entries since start_date). When overdue (≥ watering_min_days)
    // the value is colored red so the user can spot it at a glance. When
    // the most recent watering came from rain we append "(rain)" so it's
    // clear nature handled it. "Never watered" shown when no events AND
    // no rain since start_date.
    const dsEl = this._el("tc-days-since-water");
    const dsw = plant.days_since_watered;
    const threshold = plant.watering_min_days || 3;
    dsEl.classList.remove("tcm-kv-value-warn", "tcm-kv-value-rain");
    if (plant.never_watered) {
      dsEl.textContent = "Never watered";
      dsEl.classList.add("tcm-kv-value-warn");
    } else if (dsw == null) {
      dsEl.textContent = dash;
    } else {
      const dayLabel = dsw === 0 ? "Today" :
                       dsw === 1 ? "1 day" :
                       `${dsw} days`;
      const sourceTag = plant.last_water_source === "rain" ? " (rain)" : "";
      dsEl.textContent = `${dayLabel}${sourceTag}`;
      if (dsw >= threshold) {
        dsEl.classList.add("tcm-kv-value-warn");
      } else if (plant.last_water_source === "rain") {
        // Recent rain — subtle blue tint to distinguish from manual water
        dsEl.classList.add("tcm-kv-value-rain");
      }
    }

    // Care Instructions — replaces description per user spec
    const care = plant.care_instructions || plant.description || "";
    this._el("tc-care").textContent = care || "No care instructions available.";

    // ── Taxonomy footer (family | genus | species) ────────────────────
    const taxEl = this._el("tc-taxonomy");
    if (plant.taxonomy_display) {
      taxEl.textContent = plant.taxonomy_display;
      taxEl.style.display = "block";
    } else {
      taxEl.textContent = "";
      taxEl.style.display = "none";
    }

    // ── Plant settings inputs (in collapsible footer) ─────────────────
    this._el("ps-name").value = plant.plant_name || plant.name || "";
    this._el("ps-slug").value = plant.species_id || "";
    this._el("ps-start-type").value = plant.start_type || "seed";
    this._el("ps-start-date").value = plant.start_date || "";
    this._el("ps-location").value = plant.location || "";

    // ── Edit-details overrides pre-fill ───────────────────────────────
    this._populateOverrideForm(plant);

    // ── History ───────────────────────────────────────────────────────
    this._renderHistory(plant);

    this._open("plant-overlay");
  }

  /**
   * Compute the plant's display status mirroring the sensor.py enum.
   * Returns {state, label} where state is one of:
   *   healthy / thirsty / danger / harvested / scheduled
   *
   * Resolution order (matches backend):
   *   1. Harvested  — any harvest event present (terminal/sticky)
   *   2. Scheduled  — start_date in the future
   *   3. Danger     — frost forecast (from coordinator data)
   *   4. Thirsty    — days_since_watered ≥ watering_min_days
   *   5. Healthy    — default
   */
  _computePlantStatus(plant) {
    // 1. Terminal: dead or harvested (sticky until plant deleted).
    //    Dead trumps harvested — a dead plant wasn't harvested.
    const events = plant.events || plant.events_sorted || plant.recent_events || [];
    let hasHarvested = false;
    for (const e of events) {
      const t = (e && e.type ? String(e.type).toLowerCase() : "");
      if (t === "dead") return { state: "dead", label: "Dead" };
      if (t === "harvested" || t === "harvest") hasHarvested = true;
    }
    if (hasHarvested) return { state: "harvested", label: "Harvested" };
    // 2. Scheduled
    if (plant.is_scheduled) return { state: "scheduled", label: "Scheduled" };
    // 3. Frost danger — exposed via the agribud sensor data; we look at
    //    the matching entity's state to keep card + sensor in sync. The
    //    card already polls plot data; weather frost flag isn't directly
    //    on the plant record, so we fall back to checking the plant's
    //    matching sensor entity if available.
    const ent = this._findPlantSensorEntity(plant);
    if (ent && ent.state === "danger") return { state: "danger", label: "Frost danger" };
    // 4. Thirsty
    const dsw = plant.days_since_watered;
    const threshold = plant.watering_min_days || 3;
    if (dsw != null && dsw >= threshold) {
      return { state: "thirsty", label: "Needs water" };
    }
    // 5. Healthy
    return { state: "healthy", label: "Healthy" };
  }

  /** Locate the sensor entity that corresponds to a plant record, by
   * scanning HA states for one whose plant_id attribute matches. Returns
   * null if no matching entity is found (e.g. before HA has loaded the
   * agribud platform). Used for cross-checking frost state. */
  _findPlantSensorEntity(plant) {
    if (!this._hass || !this._hass.states) return null;
    const pid = plant.plant_id || plant.id;
    if (!pid) return null;
    for (const entId in this._hass.states) {
      if (!entId.startsWith("sensor.")) continue;
      const s = this._hass.states[entId];
      if (s && s.attributes && s.attributes.plant_id === pid) return s;
    }
    return null;
  }

  _populateOverrideForm(plant) {
    // Pre-fills the "Edit plant details" collapsible from plant.user_overrides.
    // Empty inputs fall back to Verdantly's values when the form is saved.
    const ov = plant.user_overrides || {};
    const set = (id, val) => {
      const el = this._el(id);
      if (el) el.value = (val == null) ? "" : String(val);
    };
    set("ov-common-name",       ov.common_name);
    set("ov-scientific-name",   ov.scientific_name);
    set("ov-light",             ov.light_requirements);
    set("ov-water-use",         ov.water_use);
    set("ov-water-min",         ov.watering_min_days);
    set("ov-water-max",         ov.watering_max_days);
    set("ov-soil-pref",         ov.soil_preference);
    set("ov-spacing",           ov.spacing_requirement);
    set("ov-growth-period",     ov.growth_period);
    set("ov-ph-min",            ov.soil_ph_min);
    set("ov-ph-max",            ov.soil_ph_max);
    set("ov-zone-min",          ov.hardiness_zone_min);
    set("ov-zone-max",          ov.hardiness_zone_max);
    set("ov-harvest-min",       ov.days_to_harvest_min);
    set("ov-harvest-max",       ov.days_to_harvest_max);
    set("ov-image-url",         ov.image_url);
    set("ov-care",              ov.care_instructions);
    // Invasive select — special handling since it's a tri-state (set/unset/false)
    const invEl = this._el("ov-invasive");
    if (invEl) {
      if ("invasive_alert" in ov) {
        invEl.value = ov.invasive_alert ? "true" : "false";
      } else {
        invEl.value = "";
      }
    }
    // Greyed-out placeholders for water min/max — show Verdantly defaults
    const wMinEl = this._el("ov-water-min");
    const wMaxEl = this._el("ov-water-max");
    const defMin = plant.watering_default_min_days;
    const defMax = plant.watering_default_max_days;
    if (wMinEl) wMinEl.placeholder = defMin != null ? `default: ${defMin}` : "min days";
    if (wMaxEl) wMaxEl.placeholder = defMax != null ? `default: ${defMax}` : "max days";
  }

  _renderHistory(plant) {
    // Persisted events only — there's no estimated_harvest synthesis since we
    // dropped days_to_harvest with the Perenual migration.
    const evts = this._eventsWithProjections(plant)
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const el = this._el("tab-history");
    let html = "";
    if (!evts.length) {
      html += `<div class="no-items">No events logged yet.</div>`;
    } else {
      html += evts.map(ev => {
        const [bg, tc] = evColors(ev.type);
        const lbl = EVENT_LABELS[ev.type]
          || ev.type.replace(/_/g," ").replace(/\b\w/g, c => c.toUpperCase());
        const eventId = ev.id || "";
        const metaSuffix = ev.auto ? "Auto logged" : "Manual";
        return `<div class="ev-item">
          <div class="ev-icon" style="background:${bg};color:${tc}">${eventIcon(ev.type)}</div>
          <div style="flex:1;min-width:0">
            <div class="ev-title">${lbl}</div>
            ${ev.note ? `<div class="ev-note">${this._esc(ev.note)}</div>` : ""}
            <div class="ev-meta">${isoDisp(ev.date)} · ${metaSuffix}</div>
          </div>
          ${eventId ? `<button class="ev-delete" data-evt-id="${eventId}" title="Delete this event">🗑️</button>` : ""}
        </div>`;
      }).join("");
    }
    el.innerHTML = html;
    // Wire each delete button — confirm and call the remove_event service
    el.querySelectorAll(".ev-delete[data-evt-id]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        this._confirmDeleteEvent(btn.dataset.evtId);
      };
    });
  }

  _confirmDeleteEvent(eventId) {
    if (!this._activePlant || !eventId) return;
    if (!confirm("Delete this event? This cannot be undone.")) return;
    const pid = this._activePlant.plant_id || this._activePlant.id;
    this._hass.callService(DOMAIN, "remove_event", {
      plant_id: pid, event_id: eventId,
    }).then(() => {
      this._ok("Event deleted.");
      // The bus event will re-fetch plots; we also want this open popup to
      // refresh its history immediately.
      setTimeout(() => {
        const fresh = this._allPlants().find(
          p => (p.plant_id || p.id) === pid,
        );
        if (fresh) {
          this._activePlant = fresh;
          this._renderHistory(fresh);
        }
      }, 400);
    }).catch(err => this._err("Failed to delete event", this._fmtErr(err, "agribud")));
  }


  /**
   * Collect override-form values and call the update_plant_overrides service.
   *
   * Empty inputs are sent as empty strings — the backend interprets these
   * as "remove this override, fall back to Verdantly's value". Non-empty
   * inputs become the new override.
   *
   * Numeric fields (watering min/max, ph min/max, days_to_harvest min/max)
   * are coerced to numbers before sending. Hardiness zone values may be
   * strings like "9b" so they're passed through as text.
   */
  /**
   * Save edits made in the "Plant settings" collapsible (display name,
   * start type, start date, location). Calls the update_plant service
   * which both writes the plant record and re-anchors the synthetic
   * planted-event so the calendar history reflects the new start_date.
   */
  _savePlantSettings() {
    if (!this._activePlant) return;
    const pid = this._activePlant.plant_id || this._activePlant.id;
    const name  = (this._el("ps-name")?.value      || "").trim();
    const stype = this._el("ps-start-type")?.value || "seed";
    const sdate = this._el("ps-start-date")?.value || "";
    const loc   = (this._el("ps-location")?.value  || "").trim();
    if (!name) {
      this._err("Name required", "Display name cannot be empty.");
      return;
    }
    const data = {
      plant_id:   pid,
      plant_name: name,
      start_type: stype,
      location:   loc,
    };
    // Only include start_date if non-empty — sending "" trips date schema.
    if (sdate) data.start_date = sdate;

    const btn = this._el("save-ps-btn");
    if (btn) { btn.textContent = "Saving…"; btn.disabled = true; }
    this._hass.callService(DOMAIN, "update_plant", data)
      .then(async () => {
        this._ok("Plant settings saved.");
        await this._fetchPlots();
        const fresh = this._allPlants().find(p => (p.plant_id || p.id) === pid);
        if (fresh) {
          this._activePlant = fresh;
          this._openPlantDetail(pid);
        }
        this._renderCurrentView();
      })
      .catch(e => this._err("Failed to save plant settings", this._fmtErr(e, "agribud")))
      .finally(() => {
        if (btn) { btn.textContent = "Save"; btn.disabled = false; }
      });
  }

  _saveOverrides() {
    if (!this._activePlant) return;
    const pid = this._activePlant.plant_id || this._activePlant.id;
    const v = id => (this._el(id)?.value ?? "").trim();
    const num = id => {
      const raw = v(id);
      if (raw === "") return "";
      const n = Number(raw);
      return Number.isFinite(n) ? n : "";
    };
    const intnum = id => {
      const raw = v(id);
      if (raw === "") return "";
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : "";
    };
    // Invasive tri-state: "" = no override, "true"/"false" = override on/off
    const invRaw = v("ov-invasive");
    const overrides = {
      common_name:         v("ov-common-name"),
      scientific_name:     v("ov-scientific-name"),
      light_requirements:  v("ov-light"),
      water_use:           v("ov-water-use"),
      watering_min_days:   intnum("ov-water-min"),
      watering_max_days:   intnum("ov-water-max"),
      soil_preference:     v("ov-soil-pref"),
      spacing_requirement: v("ov-spacing"),
      growth_period:       v("ov-growth-period"),
      soil_ph_min:         num("ov-ph-min"),
      soil_ph_max:         num("ov-ph-max"),
      hardiness_zone_min:  v("ov-zone-min"),
      hardiness_zone_max:  v("ov-zone-max"),
      days_to_harvest_min: intnum("ov-harvest-min"),
      days_to_harvest_max: intnum("ov-harvest-max"),
      care_instructions:   v("ov-care"),
      image_url:           v("ov-image-url"),
    };
    if (invRaw === "true")  overrides.invasive_alert = true;
    else if (invRaw === "false") overrides.invasive_alert = false;
    // empty string means "no override for invasive" — leave it out entirely
    // (sending "" would tell the backend to REMOVE the override which is fine
    // here too — the user said "no override", and removing one if it exists
    // gives the same result).
    else overrides.invasive_alert = "";

    // Cross-field validation: min ≤ max for water + pH + harvest
    if (overrides.watering_min_days !== "" && overrides.watering_max_days !== ""
        && overrides.watering_min_days > overrides.watering_max_days) {
      this._err("Invalid water range",
        "Water min days must be less than or equal to max days.");
      return;
    }
    if (overrides.soil_ph_min !== "" && overrides.soil_ph_max !== ""
        && overrides.soil_ph_min > overrides.soil_ph_max) {
      this._err("Invalid pH range",
        "Soil pH min must be less than or equal to max.");
      return;
    }
    if (overrides.days_to_harvest_min !== "" && overrides.days_to_harvest_max !== ""
        && overrides.days_to_harvest_min > overrides.days_to_harvest_max) {
      this._err("Invalid harvest range",
        "Days-to-harvest min must be less than or equal to max.");
      return;
    }

    const btn = this._el("save-ov-btn");
    if (btn) { btn.textContent = "Saving…"; btn.disabled = true; }
    this._hass.callService(DOMAIN, "update_plant_overrides",
                           { plant_id: pid, overrides })
      .then(async () => {
        this._ok("Plant details saved.");
        await this._fetchPlots();
        const fresh = this._allPlants().find(p => (p.plant_id || p.id) === pid);
        if (fresh) {
          this._activePlant = fresh;
          this._populateOverrideForm(fresh);
          this._openPlantDetail(pid);
        }
        this._renderCurrentView();
      })
      .catch(e => this._err("Failed to save overrides", this._fmtErr(e, "agribud")))
      .finally(() => {
        if (btn) { btn.textContent = "Save overrides"; btn.disabled = false; }
      });
  }

  /**
   * Clear ALL overrides on the active plant, reverting every display field
   * to whatever Verdantly returned. Empty-string semantics on the backend
   * service handle the actual removal.
   */
  _clearOverrides() {
    if (!this._activePlant) return;
    if (!confirm("Reset all overrides for this plant? "
                 + "Display fields will revert to Verdantly's values.")) return;
    const pid = this._activePlant.plant_id || this._activePlant.id;
    // Send every allowed-key field as an empty string so the backend removes
    // each one. The backend ignores unknown keys, so listing the full set
    // here is safe even if some never had overrides set.
    const overrides = {
      common_name: "", scientific_name: "",
      light_requirements: "", water_use: "",
      watering_min_days: "", watering_max_days: "",
      soil_preference: "", spacing_requirement: "", growth_period: "",
      soil_ph_min: "", soil_ph_max: "",
      hardiness_zone_min: "", hardiness_zone_max: "",
      days_to_harvest_min: "", days_to_harvest_max: "",
      invasive_alert: "",
      care_instructions: "", description: "", habitat: "",
      image_url: "",
    };
    this._hass.callService(DOMAIN, "update_plant_overrides",
                           { plant_id: pid, overrides })
      .then(async () => {
        this._ok("Overrides cleared — using Verdantly values.");
        await this._fetchPlots();
        const fresh = this._allPlants().find(p => (p.plant_id || p.id) === pid);
        if (fresh) {
          this._activePlant = fresh;
          this._openPlantDetail(pid);
        }
        this._renderCurrentView();
      })
      .catch(e => this._err("Failed to clear overrides", this._fmtErr(e, "agribud")));
  }

  _saveEvent() {
    if (!this._activePlant) return;
    const type = this._el("evt-type")?.value;
    const note = this._el("evt-note")?.value.trim() || "";
    const date = this._el("evt-date")?.value || "";
    const pid = this._activePlant.plant_id || this._activePlant.id;
    this._hass.callService(DOMAIN, "log_event", { plant_id: pid, event_type: type, note, date })
      .then(async () => {
        if (this._el("evt-note")) this._el("evt-note").value = "";
        this._ok(`${type.replace(/_/g," ")} logged.`);
        // Refresh cache + popup history directly. This ensures the new event
        // appears immediately even if the integration's bus event isn't being
        // fired (e.g. running an older __init__.py).
        await this._fetchPlots();
        const fresh = this._allPlants().find(p => (p.plant_id || p.id) === pid);
        if (fresh) {
          this._activePlant = fresh;
          this._renderHistory(fresh);
        }
        // Also re-render the underlying view so the planner picks up the event.
        if (this._view.startsWith("plot:") && this._activePlot) {
          const freshPlot = (this._plotsCache || []).find(p => p.id === this._activePlot.id);
          if (freshPlot) this._activePlot = freshPlot;
        }
        this._renderCurrentView();
      })
      .catch(e => this._err("Failed to save event", this._fmtErr(e, "agribud")));
  }

  _removePlant() {
    if (!this._activePlant) return;
    const name = this._activePlant.plant_name || this._activePlant.name;
    if (!confirm(`Remove "${name}"? This cannot be undone.`)) return;
    const pid = this._activePlant.plant_id || this._activePlant.id;
    this._hass.callService(DOMAIN, "remove_plant", { plant_id: pid })
      .then(async () => {
        this._close("plant-overlay");
        this._ok(`${name} removed.`);
        // Don't rely solely on the data_changed bus event — actively refresh
        // the plot cache and re-render so the plant disappears from the list
        // immediately even if the integration is on an older version that
        // doesn't fire the event.
        await this._fetchPlots();
        if (this._view.startsWith("plot:") && this._activePlot) {
          const fresh = (this._plotsCache || []).find(p => p.id === this._activePlot.id);
          if (fresh) this._activePlot = fresh;
          else { this._backToMain(); return; }
        }
        this._renderCurrentView();
      })
      .catch(e => this._err("Failed to remove plant", this._fmtErr(e, "agribud")));
  }

  /* ── Settings overlay ──────────────────────────────────────────────────── */

  _tplSettingsOverlay() {
    const title = this._config.title || "My Garden";
    // Allow ANY entity, not just the weather.* domain. We render a datalist
    // for autocomplete with weather/sensor entities listed first (most likely
    // candidates) and fall back to text entry so users can type any entity id.
    const allEntities = Object.keys(this._hass?.states || {});
    const weatherFirst = allEntities
      .filter(id => id.startsWith("weather."))
      .sort();
    const sensorEntities = allEntities
      .filter(id => id.startsWith("sensor.") && /weather|condition|forecast|rain|precip/i.test(id))
      .sort();
    const otherEntities = allEntities
      .filter(id => !id.startsWith("weather.") && !sensorEntities.includes(id))
      .sort();
    // Datalist: weather first, then weather-ish sensors, then everything else.
    const entityList = [...weatherFirst, ...sensorEntities, ...otherEntities];
    const currentWeather = this._config.weather_entity || weatherFirst[0] || "";
    const datalistOpts = entityList
      .map(id => `<option value="${id}"></option>`)
      .join("");
    return `<div class="overlay" id="settings-overlay"><div class="popup">
      <div class="popup-hdr">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">⚙</span>
          <div><div class="phdr-title">Agribud settings</div><div class="phdr-sub">Card and integration configuration</div></div>
        </div>
        <button class="close-btn" id="close-settings-btn">✕</button>
      </div>
      <div class="popup-body">
        <div class="set-section">Verdantly (RapidAPI) connection</div>
        <p style="font-size:12px;color:var(--secondary-text-color);margin-bottom:10px">
          Verdantly Gardening API key is set in the integration setup wizard (Settings → Integrations → Agribud).
        </p>
        <div class="rate-notice rate-notice-warning">
          <strong>⚠ Free tier: only 25 API calls per MONTH.</strong><br>
          Each unique plant search costs 1 call. Opening an already-added plant
          costs 0 calls (data cached on the plant record). Search results are
          cached for 30 days. Subscribe to a paid RapidAPI tier for more calls at
          <a href="https://rapidapi.com/verdantly-team-verdantly-team-default/api/verdantly-gardening-api"
             target="_blank" rel="noopener">rapidapi.com</a>.
        </div>
        <div id="api-status-box" style="background:var(--secondary-background-color);border-radius:8px;padding:10px 12px;margin-bottom:12px;margin-top:10px;font-size:12px;line-height:1.6">
          <span style="color:var(--secondary-text-color)">Loading status…</span>
        </div>
        <div class="conn-status conn-err" id="conn-status">
          <span class="conn-dot" id="conn-dot" style="background:#993C1D"></span>
          <span id="conn-label">Press "Test connection" to check</span>
        </div>
        <button class="btn" id="test-api-btn" style="width:100%;margin-bottom:20px">Test connection</button>

        <div class="set-section">Weather entity</div>
        <div class="form-row">
          <span class="form-label">Entity representing current weather</span>
          <input class="form-input" type="text" id="cfg-weather" list="agribud-entity-list" value="${this._esc(currentWeather)}" placeholder="weather.home or any entity id">
          <datalist id="agribud-entity-list">${datalistOpts}</datalist>
          <span class="form-hint">Any entity is allowed. Rain/snow/frost are detected from the entity's state and attributes. Saved both in the card and on the integration backend.</span>
        </div>

        <div class="set-section">Card display</div>
        <div class="form-row"><span class="form-label">Card title</span>
          <input class="form-input" type="text" id="cfg-title" value="${this._esc(title)}">
        </div>
        <div class="form-row" style="align-items:flex-start"><span class="form-label" style="padding-top:6px">Layout</span>
          <div style="flex:1">
            <div class="layout-toggle" role="group" aria-label="Layout">
              <button type="button" class="layout-toggle-btn" data-layout="auto"
                      aria-pressed="false" title="Adapts to screen size">
                <span aria-hidden="true">⤢</span> Auto
              </button>
              <button type="button" class="layout-toggle-btn" data-layout="portrait"
                      aria-pressed="false" title="Optimized for phones &amp; portrait tablets">
                <span aria-hidden="true">▯</span> Portrait
              </button>
              <button type="button" class="layout-toggle-btn" data-layout="landscape"
                      aria-pressed="false" title="Optimized for desktop &amp; tablets in landscape">
                <span aria-hidden="true">▭</span> Landscape
              </button>
            </div>
            <div style="font-size:11px;color:var(--secondary-text-color);margin-top:6px;line-height:1.4">
              Auto adapts to your screen width. Portrait stacks elements
              vertically (best for phones). Landscape uses the wider layout.
              Changes apply instantly; saved per browser.
            </div>
          </div>
        </div>
        <div class="form-row" style="align-items:flex-start"><span class="form-label" style="padding-top:6px">Theme</span>
          <div style="flex:1">
            <div class="layout-toggle" role="group" aria-label="Theme">
              <button type="button" class="theme-toggle-btn" data-theme="ha"
                      aria-pressed="false" title="Follows your Home Assistant theme">
                <span aria-hidden="true">🏠</span> Home Assistant
              </button>
              <button type="button" class="theme-toggle-btn" data-theme="default"
                      aria-pressed="false" title="Agribud's signature dark surface design">
                <span aria-hidden="true">🌿</span> Default
              </button>
            </div>
            <div style="font-size:11px;color:var(--secondary-text-color);margin-top:6px;line-height:1.4">
              Home Assistant matches your HA theme. Default uses Agribud's
              own dark surface design with warm accents. Changes apply
              instantly; saved per browser.
            </div>
          </div>
        </div>

        <button class="btn btn-accent btn-full" id="save-settings-btn">Save settings</button>
      </div>
    </div></div>`;
  }

  _openSettings() {
    this._open("settings-overlay");
    // Wire the layout toggle group. Mark the active button pressed; clicks
    // immediately apply the new layout (no need to hit "Save settings").
    const layoutButtons = this.shadowRoot.querySelectorAll(".layout-toggle-btn");
    const updatePressed = () => {
      layoutButtons.forEach(btn => {
        const active = btn.dataset.layout === this._layoutPref;
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.classList.toggle("active", active);
      });
    };
    updatePressed();
    layoutButtons.forEach(btn => {
      btn.onclick = () => {
        this._setLayoutPref(btn.dataset.layout);
        updatePressed();
      };
    });
    // Wire the theme toggle group — same pattern as layout. Applies
    // instantly via CSS class swap on the host; no re-render needed.
    const themeButtons = this.shadowRoot.querySelectorAll(".theme-toggle-btn");
    const updateThemePressed = () => {
      themeButtons.forEach(btn => {
        const active = btn.dataset.theme === this._themePref;
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.classList.toggle("active", active);
      });
    };
    updateThemePressed();
    themeButtons.forEach(btn => {
      btn.onclick = () => {
        this._setThemePref(btn.dataset.theme);
        updateThemePressed();
      };
    });
    const box = this._el("api-status-box");
    this._apiFetch("/status").then(({ data }) => {
      // Stash the status response so other UI surfaces (settings form,
      // add-plant overlay's state field pre-fill) can read default_state etc.
      this._apiStatusCache = data;
      if (!box) return;
      if (!data.configured) {
        box.innerHTML = `<span style="color:#993C1D;font-weight:600">⚠ Integration not configured</span><br>
          <span style="color:var(--secondary-text-color)">Run setup wizard.</span>`;
        return;
      }
      const ok = data.api_client_ready;
      const providerRaw = data.api_provider || "verdantly";
      // Pretty-print the provider name
      const provider = providerRaw === "verdantly" ? "Verdantly (RapidAPI)"
                     : providerRaw === "apifarmer" ? "APIFarmer"
                     : providerRaw.charAt(0).toUpperCase() + providerRaw.slice(1);
      // Build the usage warning row if the backend reports the counter.
      // Verdantly's free tier is 25 calls/month; warn at 20+ used.
      let usageRow = "";
      if (data.usage && typeof data.usage === "object") {
        const used      = Number(data.usage.count)     || 0;
        const remaining = Number(data.usage.remaining) || 0;
        const quota     = Number(data.usage.quota)     || 25;
        const month     = data.usage.month || "this month";
        let color = "var(--primary-text-color)";
        let warn = "";
        if (remaining <= 0) {
          color = "#993C1D";
          warn = " ⛔ quota exhausted";
        } else if (remaining <= 5) {
          color = "#993C1D";
          warn = " ⚠ low";
        } else if (remaining <= 10) {
          color = "#D4A04A";
        }
        usageRow = `
          <span style="color:var(--secondary-text-color)">API usage (${this._esc(month)}):</span>
          <span style="color:${color};font-weight:600">${used} / ${quota} used (${remaining} left)${warn}</span>`;
      }
      box.innerHTML = `<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:baseline">
        <span style="color:var(--secondary-text-color)">Provider:</span>
        <span>${this._esc(provider)}</span>
        <span style="color:var(--secondary-text-color)">API key:</span>
        <span style="font-family:monospace;color:${ok?"#0F6E56":"#993C1D"}">${data.api_key_masked}</span>
        <span style="color:var(--secondary-text-color)">Weather entity:</span>
        <span>${data.weather_entity}</span>
        <span style="color:var(--secondary-text-color)">API client:</span>
        <span style="color:${ok?"#0F6E56":"#993C1D"};font-weight:600">${ok ? "✓ Ready" : "✗ Not loaded"}</span>${usageRow}
        <span style="color:var(--secondary-text-color)">Backend http_api:</span>
        <span style="font-family:monospace;font-size:11px">${data.http_api_version || "(missing — file is older than v1.1.1)"}</span>
      </div>`;
      // Pre-fill the form fields from backend values when card config doesn't override
      const wsel = this._el("cfg-weather");
      if (wsel && !this._config.weather_entity && data.weather_entity) {
        wsel.value = data.weather_entity;
      }
    }).catch(e => { if (box) box.innerHTML = `<span style="color:#993C1D">Could not load status: ${e.message}</span>`; });
  }

  _setConn(ok, label) {
    const el = this._el("conn-status");
    if (!el) return;
    el.className = `conn-status ${ok?"conn-ok":"conn-err"}`;
    this._el("conn-dot").style.background = ok ? "#1D9E75" : "#993C1D";
    this._el("conn-label").textContent = label;
  }

  async _testConnection() {
    const btn = this._el("test-api-btn");
    if (btn) { btn.textContent = "Testing…"; btn.disabled = true; }
    try {
      const { status, data } = await this._apiFetch("/test_connection");
      if (data.ok) {
        this._setConn(true, "Connected — Verdantly key is valid");
        this._ok("Connection test passed.");
      } else if (status === 404) {
        this._setConn(false, "Integration not set up");
        this._err("Setup required", data.message || "Complete the setup wizard.");
      } else {
        this._setConn(false, "Connection failed");
        this._err("Connection failed", data.message || `HTTP ${status}`);
      }
    } catch (e) {
      this._setConn(false, "Error");
      this._err("Connection failed", this._fmtErr(e, "agribud"));
    } finally {
      if (btn) { btn.textContent = "Test connection"; btn.disabled = false; }
    }
  }

  async _saveSettings() {
    const weather = this._el("cfg-weather")?.value;
    const title = this._el("cfg-title")?.value.trim() || "My Garden";

    // 1. Persist card config (title + weather entity) by dispatching config-changed
    const newConfig = { ...this._config, title, weather_entity: weather, temp_unit: "auto" };
    this._config = newConfig;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true, composed: true,
    }));

    // 2. Update backend so the coordinator uses the same weather entity.
    // State filter is no longer stored — users enter it per-search.
    const btn = this._el("save-settings-btn");
    if (btn) { btn.textContent = "Saving…"; btn.disabled = true; }
    try {
      const { status, data } = await this._apiFetch("/update_config", {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          weather_entity: weather,
        }),
      });
      if (data.ok) {
        this._apiStatusCache = {
          ...(this._apiStatusCache || {}),
          weather_entity: weather,
        };
        this._close("settings-overlay");
        this._ok("Settings saved.");
        const titleEl = this.shadowRoot.querySelector(".hdr-title");
        if (titleEl) titleEl.textContent = title;
        this._renderCurrentView();
      } else if (status === 404) {
        this._err("Setup required", data.message);
      } else {
        this._err("Save failed", data.message || `HTTP ${status}`);
      }
    } catch (e) {
      this._err("Save failed", this._fmtErr(e, "agribud"));
    } finally {
      if (btn) { btn.textContent = "Save settings"; btn.disabled = false; }
    }
  }

  /* ── Water-needed list overlay ─────────────────────────────────────────── */

  _tplWaterListOverlay() {
    return `<div class="overlay" id="water-overlay"><div class="popup">
      <div class="popup-hdr">
        <div class="phdr-title">💧 Plants needing water</div>
        <button class="close-btn" id="close-water-btn">✕</button>
      </div>
      <div class="popup-body" id="water-body">
        <div class="no-items">Loading…</div>
      </div>
    </div></div>`;
  }

  _openWaterList() {
    const plants = this._allPlants().filter(needsWater);
    const body = this._el("water-body");
    if (!plants.length) {
      body.innerHTML = `<div class="no-items">All plants are good on water 🌱</div>`;
    } else {
      body.innerHTML = `<div class="water-list">${plants.map(p => {
        const pid = p.plant_id || p.id;
        const thumb = p.image_url
          ? `<img src="${p.image_url}" style="width:36px;height:36px;border-radius:6px;object-fit:cover" loading="lazy">`
          : `<span style="font-size:30px">${plantEmoji(p.plant_name || p.name)}</span>`;
        return `<div class="water-row">
          ${thumb}
          <div class="water-row-info">
            <div class="water-row-name">${this._esc(p.plant_name || p.name)}</div>
            <div class="water-row-meta">Last watered: ${daysAgo(p.days_since_watered)}${p.location?` · ${this._esc(p.location)}`:""}</div>
          </div>
          <div class="water-row-actions">
            <button class="btn btn-accent" data-water-pid="${pid}">💧 Water</button>
            <button class="btn" data-detail-pid="${pid}">Details</button>
          </div>
        </div>`;
      }).join("")}</div>`;
      body.querySelectorAll("[data-water-pid]").forEach(b => {
        b.onclick = () => this._quickWater(b.dataset.waterPid);
      });
      body.querySelectorAll("[data-detail-pid]").forEach(b => {
        b.onclick = () => { this._close("water-overlay"); this._openPlantDetail(b.dataset.detailPid); };
      });
    }
    this._open("water-overlay");
  }

  _quickWater(pid) {
    this._hass.callService(DOMAIN, "log_event", {
      plant_id: pid, event_type: "watered", date: new Date().toISOString().slice(0,10),
    }).then(() => {
      this._ok("Watering logged.");
      // Bus event will trigger refresh; also update this list optimistically
      setTimeout(() => this._openWaterList(), 600);
    }).catch(e => this._err("Failed to log", this._fmtErr(e, "agribud")));
  }

  /* ── Day-detail overlay (clicked from month calendar cell) ─────────────── */

  _tplDayDetailOverlay() {
    return `<div class="overlay" id="day-overlay"><div class="popup">
      <div class="popup-hdr">
        <div>
          <div class="phdr-title" id="day-title">Day</div>
          <div class="phdr-sub" id="day-sub"></div>
        </div>
        <button class="close-btn" id="close-day-btn">✕</button>
      </div>
      <div class="popup-body" id="day-body">
        <div class="no-items">Loading…</div>
      </div>
    </div></div>`;
  }

  // Opens the day-detail overlay listing every plant with activity on `dateStr`.
  // Each row is clickable to open the plant detail popup.
  _openDayDetail(dateStr) {
    if (!dateStr) return;
    const dateObj = new Date(dateStr + "T00:00:00");
    const titleEl = this._el("day-title");
    const subEl   = this._el("day-sub");
    const body    = this._el("day-body");
    if (titleEl) titleEl.textContent = dateObj.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });
    if (subEl) subEl.textContent = `Plants active on this day`;

    // Build the list of {plant, events[]} entries for this date
    const entries = [];
    for (const p of this._allPlants()) {
      const evts = this._eventsWithProjections(p);
      const matching = evts.filter(ev => ev.date === dateStr);
      if (matching.length) entries.push({ plant: p, events: matching });
    }

    if (!entries.length) {
      body.innerHTML = `<div class="no-items">No plant activity on this day.</div>`;
    } else {
      body.innerHTML = `<div class="day-list">${entries.map(({ plant, events }) => {
        const pid = plant.plant_id || plant.id;
        const thumb = plant.image_url
          ? `<div class="day-row-thumb"><img src="${plant.image_url}" loading="lazy"></div>`
          : `<div class="day-row-thumb">${plantEmoji(plant.plant_name || plant.name)}</div>`;
        const evChips = events.map(ev => {
          const [bg, fg] = evColors(ev.type);
          const label = ev.type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          return `<span class="day-row-evchip" style="background:${bg};color:${fg}">${eventIcon(ev.type)} ${this._esc(label)}</span>`;
        }).join("");
        return `<div class="day-row" data-day-pid="${pid}">
          ${thumb}
          <div class="day-row-info">
            <div class="day-row-name">${this._esc(plant.plant_name || plant.name || "")}</div>
            <div class="day-row-events">${evChips}</div>
          </div>
          <span class="day-row-status" style="background:${healthColor(plant)}" title="Current status"></span>
        </div>`;
      }).join("")}</div>`;
      // Wire each row to open the plant detail popup (closes the day overlay first)
      body.querySelectorAll(".day-row[data-day-pid]").forEach(row => {
        row.onclick = () => {
          this._close("day-overlay");
          this._openPlantDetail(row.dataset.dayPid);
        };
      });
    }
    this._open("day-overlay");
  }

  /* ── Active plants overlay ─────────────────────────────────────────────── */

  _tplActivePlantsOverlay() {
    return `<div class="overlay" id="active-overlay"><div class="popup">
      <div class="popup-hdr">
        <div class="phdr-title">🌱 All active plants</div>
        <button class="close-btn" id="close-active-btn">✕</button>
      </div>
      <div class="popup-body" id="active-body">
        <div class="no-items">Loading…</div>
      </div>
    </div></div>`;
  }

  _openActivePlants() {
    const plots = this._plotsCache || [];
    const body = this._el("active-body");
    if (!plots.length) {
      body.innerHTML = `<div class="no-items">No grow plots yet.</div>`;
    } else {
      body.innerHTML = plots.filter(p => p.plant_count).map(plot => `
        <div style="margin-bottom:18px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">📍 ${this._esc(plot.name)} · ${plot.plant_count} plant${plot.plant_count===1?"":"s"}</div>
          ${this._tplPlantTable(plot.plants || [])}
        </div>
      `).join("") || `<div class="no-items">No plants yet.</div>`;
      body.querySelectorAll(".plant-row").forEach(row => {
        row.onclick = () => { this._close("active-overlay"); this._openPlantDetail(row.dataset.pid); };
      });
    }
    this._open("active-overlay");
  }

  /* ── Sparkline overlay (temp/humidity history) ─────────────────────────── */

  _tplSparklineOverlay() {
    return `<div class="overlay" id="spark-overlay"><div class="popup">
      <div class="popup-hdr">
        <div class="phdr-title" id="spark-title">History</div>
        <button class="close-btn" id="close-spark-btn">✕</button>
      </div>
      <div class="popup-body" id="spark-body">
        <div class="no-items">Loading…</div>
      </div>
    </div></div>`;
  }

  async _openSparkline(metric) {
    this._open("spark-overlay");
    this._el("spark-title").textContent = metric === "temperature" ? "🌡️ Temperature — last 24h" : "💧 Humidity — last 24h";
    const body = this._el("spark-body");
    const w = this._readWeatherSnapshot();
    const entityId = `sensor.agribud_${metric}`;

    // Fetch history via HA WebSocket
    let history = [];
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 24*3600*1000);
      const resp = await this._hass.callApi("GET",
        `history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}&minimal_response`
      );
      const series = (resp || [])[0] || [];
      history = series.map(p => ({ t: new Date(p.last_changed || p.last_updated), v: parseFloat(p.state) }))
                      .filter(p => !isNaN(p.v));
    } catch (e) {
      console.warn("Agribud: history fetch failed:", e);
    }

    const unit = metric === "temperature" ? (w.temperature_unit || "") : "%";
    const cur = metric === "temperature" ? w.temperature : w.humidity;

    let svg = "";
    if (history.length >= 2) {
      const W = 500, H = 60, P = 4;
      const vals = history.map(p => p.v);
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = (max - min) || 1;
      const tMin = history[0].t.getTime();
      const tMax = history[history.length-1].t.getTime();
      const tRange = (tMax - tMin) || 1;
      const pts = history.map(p => {
        const x = P + ((p.t.getTime() - tMin) / tRange) * (W - 2*P);
        const y = H - P - ((p.v - min) / range) * (H - 2*P);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      svg = `<svg class="sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="#1D9E75" stroke-width="2" />
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--secondary-text-color);padding:0 6px;margin-top:4px">
        <span>Min ${min.toFixed(1)}${unit}</span>
        <span>Max ${max.toFixed(1)}${unit}</span>
      </div>`;
    } else {
      svg = `<div class="no-items">Not enough history yet — collecting data…</div>`;
    }
    body.innerHTML = `
      <div class="sparkline-wrap">
        <div class="sparkline-now">${cur != null ? cur + unit : "—"}</div>
        <div class="sparkline-title">Source: ${this._esc(w.weather_entity || "—")}</div>
        ${svg}
      </div>
    `;
  }

  /* ── Add grow plot overlay ─────────────────────────────────────────────── */

  _tplAddPlotOverlay() {
    return `<div class="overlay" id="add-plot-overlay"><div class="popup">
      <div class="popup-hdr">
        <div class="phdr-title">+ New grow plot</div>
        <button class="close-btn" id="close-add-plot-btn">✕</button>
      </div>
      <div class="popup-body">
        <div class="form-row">
          <span class="form-label">Plot name</span>
          <input class="form-input" type="text" id="new-plot-name" placeholder="e.g. Raised bed 1, South fence…">
        </div>
        <div class="form-row">
          <span class="form-label">Description (optional)</span>
          <textarea class="form-textarea" id="new-plot-desc" placeholder="Notes about location, soil type, sun exposure…"></textarea>
        </div>
        <button class="btn btn-accent btn-full" id="confirm-add-plot-btn">Create plot</button>
      </div>
    </div></div>`;
  }

  async _confirmAddPlot() {
    const name = this._el("new-plot-name")?.value.trim();
    const desc = this._el("new-plot-desc")?.value.trim() || "";
    if (!name) { this._err("Name required", "Enter a name for this grow plot."); return; }
    try {
      const { status, data } = await this._apiFetch("/plot_create", {
        method: "POST",
        headers: { ...this._authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc }),
      });
      if (data.ok) {
        this._close("add-plot-overlay");
        this._el("new-plot-name").value = "";
        this._el("new-plot-desc").value = "";
        this._ok(`Grow plot "${name}" created.`);
        await this._fetchPlots();
        this._renderCurrentView();
      } else {
        this._err("Failed", data.message || `HTTP ${status}`);
      }
    } catch (e) {
      this._err("Failed", this._fmtErr(e, "agribud"));
    }
  }

  /* ── Add plant flow ────────────────────────────────────────────────────── */

  _openAddPlant(plotId, plotName) {
    // Remove any existing instance of the add-plant overlay
    this._el("add-plant-overlay")?.remove();
    const div = document.createElement("div");
    div.innerHTML = this._tplAddPlantOverlayInline(plotName);
    const overlay = div.firstElementChild;
    this._el("card-root").appendChild(overlay);
    this._wireAddPlantOverlay(overlay, plotId);
  }

  _tplAddPlantOverlayInline(plotName) {
    const ready = integrationReady(this._hass);
    return `<div class="overlay open" id="add-plant-overlay"><div class="popup">
      <div class="popup-hdr">
        <div>
          <div class="phdr-title" id="add-plant-hdr-title">Add a plant to ${this._esc(plotName||"this plot")}</div>
          <div class="phdr-sub">${plotName ? "Search the Verdantly plant database below" : ""}</div>
        </div>
        <button class="close-btn" id="close-add-btn">✕</button>
      </div>
      <div class="popup-body">
        ${!ready ? `
          <div style="text-align:center;padding:30px 0">
            <div style="font-size:40px;margin-bottom:12px">🌱</div>
            <div style="font-size:14px;font-weight:600;margin-bottom:8px">Setup required</div>
            <div style="font-size:13px;color:var(--secondary-text-color)">
              Complete the Agribud integration setup first.
            </div>
          </div>
        ` : `
          <div id="add-step-search">
            <div id="recent-plants-section" style="display:none;margin-bottom:14px">
              <div class="form-label" style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
                <span>Recent plants</span>
                <span style="font-size:10px;font-weight:400;color:var(--secondary-text-color);text-transform:none;letter-spacing:0">
                  No API call — re-use a previously fetched species
                </span>
              </div>
              <div id="recent-plants-grid" class="recent-plants-grid"></div>
            </div>
            <div class="form-label" style="margin-bottom:8px">Search the Verdantly plant database</div>
            <div class="search-row">
              <input class="form-input" type="text" id="new-name" placeholder="e.g. Tomato, Penstemon, Foxglove…" autocomplete="off">
              <button class="btn btn-accent" id="search-btn">Search</button>
            </div>
            <div class="form-hint" style="margin-top:4px">
              ⚠ Free tier: 25 API calls/month. Each unique search costs 1 call.
              Repeated searches for the same term (within 30 days) are free.
            </div>
            <div id="search-spinner-wrap" style="display:none;padding:8px 0;font-size:13px;color:var(--secondary-text-color)">
              <span class="spinner"></span>Searching Verdantly…
            </div>
            <div id="search-results-wrap" style="display:none">
              <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:8px" id="search-count"></div>
              <div class="search-results-grid" id="search-results-grid"></div>
            </div>
          </div>
          <div id="add-step-form" style="display:none">
            <button class="btn" id="back-to-search-btn" style="margin-bottom:14px;font-size:11px">← Back to search</button>
            <div id="add-plant-image-wrap"></div>
            <div style="margin-bottom:14px">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:17px;font-weight:700" id="add-plant-common-name"></span>
                <span class="tc-noxious" id="add-plant-noxious" style="display:none"></span>
                <span class="tc-invasive" id="add-plant-invasive" style="display:none;width:24px;height:24px;font-size:14px" title="Invasive Species">⚠</span>
              </div>
              <div style="font-size:13px;font-style:italic;color:var(--secondary-text-color);margin-top:2px" id="add-plant-sci-name"></div>
            </div>
            <div class="plant-info-grid" id="add-plant-info-grid"></div>
            <hr class="divider">
            <div class="sec-title"><span>Plant details</span></div>
            <div class="form-row"><span class="form-label">Display name</span><input class="form-input" type="text" id="add-display-name"></div>
            <div class="form-row"><span class="form-label">Started from</span>
              <select class="form-select" id="add-start-type">
                <option value="seed">Seed</option><option value="transplant">Transplant</option>
              </select>
            </div>
            <div class="form-row"><span class="form-label">Planting date <span style="opacity:.7">(can be future)</span></span>
              <input class="form-input" type="date" id="add-start-date" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <button class="btn btn-accent btn-full" id="confirm-add-btn">Add plant to ${this._esc(plotName||"plot")}</button>
          </div>
        `}
      </div>
    </div></div>`;
  }

  _wireAddPlantOverlay(overlay, plotId) {
    overlay.querySelector("#close-add-btn").onclick = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    if (!integrationReady(this._hass)) return;

    const nameIn = overlay.querySelector("#new-name");
    const searchBtn = overlay.querySelector("#search-btn");
    const spinWrap = overlay.querySelector("#search-spinner-wrap");
    const resWrap  = overlay.querySelector("#search-results-wrap");
    const resGrid  = overlay.querySelector("#search-results-grid");
    const countEl  = overlay.querySelector("#search-count");
    const stepSearch = overlay.querySelector("#add-step-search");
    const stepForm   = overlay.querySelector("#add-step-form");

    // ── Populate the "Recent plants" chip strip ───────────────────────────
    // Pull species_data from TWO sources, dedupe by scientific name:
    //   1. Every currently-active plant in the user's garden
    //   2. Every soft-deleted plant from the last 6 months (fetched from
    //      the backend's /deleted_species endpoint)
    // Clicking a chip skips the API entirely and jumps straight to the
    // add-form step using the cached species_data. Crucial for the
    // 25-calls-per-month free tier — a user who's grown tomatoes can keep
    // adding new tomato plants forever without burning calls.
    const recentSection = overlay.querySelector("#recent-plants-section");
    const recentGrid    = overlay.querySelector("#recent-plants-grid");
    if (recentSection && recentGrid) {
      const seen = new Map();  // sci/name key -> species_data
      // Source 1: active plants
      for (const p of this._allPlants()) {
        const sd = p.species_data;
        if (!sd || typeof sd !== "object") continue;
        const sp = sd.species || {};
        const key = (sp.scientificName || sd.name || p.common_name || "")
          .toString().trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.set(key, sd);
      }
      // Source 2: previously-deleted plants (kept in cache 6 months). Fetch
      // async; render initial chips immediately, then update when the
      // backend responds. Fire-and-forget — failure just means the strip
      // shows fewer chips, no error to surface.
      const renderChips = () => {
        const entries = Array.from(seen.entries()).slice(0, 30);
        if (!entries.length) {
          recentSection.style.display = "none";
          return;
        }
        recentSection.style.display = "block";
        recentGrid.innerHTML = entries.map(([key, sd], i) => {
          const sp = sd.species || {};
          const display = sd.name || sp.commonName || sp.scientificName || "Unknown";
          const emoji = plantEmoji(display);
          return `<button class="recent-plant-chip" data-i="${i}"
                          title="${this._esc(sp.scientificName || display)}">
            <span class="recent-plant-chip-emoji">${emoji}</span>
            <span class="recent-plant-chip-name">${this._esc(display)}</span>
          </button>`;
        }).join("");
        recentGrid.querySelectorAll(".recent-plant-chip").forEach(chip => {
          chip.onclick = () => {
            const sd = entries[parseInt(chip.dataset.i, 10)][1];
            const sp = sd.species || {};
            const variety = sd.name || "";
            const displayName = variety || sp.commonName || sp.scientificName || "";
            const result = {
              ...sd,
              species_id:       sd.id || "",
              id:               sd.id || "",
              common_name:      displayName,
              common_names:     displayName ? [displayName] : [],
              variety_name:     variety,
              scientific_name:  sp.scientificName || "",
              image_url:        sd.imageUrl || null,
              invasive_alert:   !!(sd.ecology && sd.ecology.isInvasive),
              light_requirements: (sd.growingRequirements || {}).sunlightRequirement || "",
              water_use:        (sd.growingRequirements || {}).waterRequirement || "",
              hardiness_zone_min: (sd.growingRequirements || {}).minGrowingZone,
              hardiness_zone_max: (sd.growingRequirements || {}).maxGrowingZone,
            };
            this._selectSearchResult(result, overlay, stepSearch, stepForm);
          };
        });
      };
      renderChips();
      // Fetch deleted-species cache in the background and re-render once
      // we have it. No spinner — this is an enhancement, not a blocker.
      this._apiFetch("/deleted_species").then(({ status, data }) => {
        if (status !== 200 || !data || !Array.isArray(data.results)) return;
        let added = 0;
        for (const sd of data.results) {
          if (!sd || typeof sd !== "object") continue;
          const sp = sd.species || {};
          const key = (sp.scientificName || sd.name || "")
            .toString().trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.set(key, sd);
          added++;
        }
        if (added > 0) renderChips();
      }).catch(() => { /* silently ignore — strip works without it */ });
    }

    const doSearch = async () => {
      const q = nameIn.value.trim();
      if (!q) return;
      spinWrap.style.display = "block"; resWrap.style.display = "none"; resGrid.innerHTML = "";
      try {
        const url = `/search_plants?q=${encodeURIComponent(q)}`;
        const { status, data } = await this._apiFetch(url);
        spinWrap.style.display = "none";
        if (status !== 200) {
          this._err("Search failed", data.message || `HTTP ${status}`); return;
        }
        // Backend response shape: {results: [...], _testing_url: "...",
        // _from_cache: bool, _backend_version: "..."}
        const results = Array.isArray(data) ? data
                      : Array.isArray(data?.results) ? data.results
                      : [];
        const backendVer = data && typeof data === "object" ? data._backend_version : null;
        // Silent diagnostic: warn (console only) if the backend version marker
        // is missing — that means http_api.py is stale and the user didn't
        // fully redeploy. End users never see this; visible to devs only.
        if (!backendVer) {
          console.warn(
            "[Agribud] Backend response missing _backend_version. "
            + "http_api.py on disk may be stale — re-extract the latest "
            + "release zip into custom_components/agribud/ and restart HA."
          );
        }

        if (!results.length) {
          resGrid.innerHTML =
            `<div class="sr-empty">No plants found for "${this._esc(q)}". Try a different common or scientific name.</div>`;
          resWrap.style.display = "block"; return;
        }
        countEl.textContent = `${results.length} result${results.length!==1?"s":""}`;
        const cardsHtml = results.slice(0, 20).map((r, i) => {
          // Verdantly-shaped result. The normalizer surfaces common_name,
          // scientific_name, image_url, invasive_alert at top level. Variety
          // name (e.g. "Abe Lincoln Original Tomato") is on r.name — we
          // prefer it for display when it's more specific than the species.
          const commonName = r.common_name || r.name || r.scientific_name || "Unknown";
          const sci = r.scientific_name || "";
          const img = r.image_url || r.imageUrl || "";
          // Real image if Verdantly provided one, else emoji placeholder
          const thumb = img
            ? `<img class="sr-img" src="${this._esc(img)}" loading="lazy"
                  onerror="this.outerHTML='<div class=\\'sr-img-ph\\'>${plantEmoji(commonName)}</div>'">`
            : `<div class="sr-img-ph">${plantEmoji(commonName)}</div>`;
          const invasiveBadge = r.invasive_alert
            ? `<span class="sr-invasive" title="Invasive species">⚠</span>` : "";
          return `<div class="sr-card" data-i="${i}">
            ${thumb}
            <div class="sr-body">
              <div class="sr-name">${this._esc(commonName)} ${invasiveBadge}</div>
              <div class="sr-sci">${this._esc(sci)}</div>
            </div>
          </div>`;
        }).join("");
        resGrid.innerHTML = cardsHtml;
        resWrap.style.display = "block";
        resGrid.querySelectorAll(".sr-card").forEach(card => {
          card.onclick = () => this._selectSearchResult(results[parseInt(card.dataset.i,10)], overlay, stepSearch, stepForm);
        });
      } catch (e) { spinWrap.style.display = "none"; this._err("Search failed", this._fmtErr(e, "agribud")); }
    };

    if (searchBtn) searchBtn.onclick = doSearch;
    nameIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });

    overlay.querySelector("#confirm-add-btn").onclick = () => {
      const name = overlay.querySelector("#add-display-name")?.value.trim();
      const sel = this._selectedSpecies || {};
      // APIFarmer's three detail endpoints all use `scientific_name` as the
      // lookup key, so we store that as the plant's `species_id` even though
      // the search response also carries a `plant_id` like "01PD". This
      // means future detail fetches just work — no ID translation needed.
      // Fall back to plant_id if scientific_name is missing for some reason.
      let sid = sel.scientific_name || sel.plant_id || sel.species_id || sel.id || null;
      const stype = overlay.querySelector("#add-start-type")?.value || "seed";
      const sdate = overlay.querySelector("#add-start-date")?.value || "";
      if (!name) { this._err("Name required", "Enter a display name."); return; }
      if (sid == null || sid === "") {
        this._err(
          "No plant selected",
          "Search and select a plant first."
        );
        return;
      }
      // Send the full merged APIFarmer detail object with add_plant so the
      // backend doesn't need to re-call the three detail endpoints. The user
      // already paid for them when they clicked the search result.
      this._hass.callService(DOMAIN, "add_plant", {
        plant_name: name,
        species_id: String(sid),
        start_type: stype,
        start_date: sdate,
        plot_id: plotId,
        species_data: sel,
      }).then(() => {
        overlay.remove();
        this._ok(`${name} added!`);
      }).catch(e => this._err("Failed to add plant", this._fmtErr(e, "agribud")));
    };
  }

  async _selectSearchResult(result, overlay, stepSearch, stepForm) {
    stepSearch.style.display = "none"; stepForm.style.display = "block";
    overlay.querySelector("#back-to-search-btn").onclick = () => {
      stepForm.style.display = "none"; stepSearch.style.display = "block";
    };
    // Verdantly returns FULL plant detail inline in the search response —
    // we don't need to fan-out to a detail endpoint. The result object
    // already has growingRequirements.*, species.*, taxonomy.*, ecology.*,
    // safety.toxicity.*, lifecycleMilestones.*, growthDetails.*, imageUrl,
    // etc. We just read from it directly, no extra API call needed. This
    // is critical for the 25-call/month free-tier budget.
    this._selectedSpecies = result;

    // Display name preference: variety name > species common > scientific.
    // The backend normalizer surfaces `common_name` already-resolved.
    const commonName = result.common_name || result.scientific_name || "";
    const sci = result.scientific_name || "";

    // Plant image — Verdantly DOES provide images for some plants. Use the
    // real image when present; fall back to emoji placeholder otherwise.
    const imageWrap = overlay.querySelector("#add-plant-image-wrap");
    if (result.image_url) {
      imageWrap.innerHTML = `<div class="plant-image-wrap">
        <img class="plant-image" src="${this._esc(result.image_url)}" loading="lazy" alt=""
             onerror="this.parentElement.innerHTML='<div class=&quot;plant-image-placeholder&quot;>${plantEmoji(commonName)}</div>'">
      </div>`;
    } else {
      imageWrap.innerHTML = `<div class="plant-image-placeholder">${plantEmoji(commonName)}</div>`;
    }
    overlay.querySelector("#add-plant-common-name").textContent = commonName;
    overlay.querySelector("#add-plant-sci-name").textContent = sci;
    overlay.querySelector("#add-display-name").value = commonName;

    // Invasive badge — Verdantly DOES report this. Hide noxious (not used).
    const noxEl = overlay.querySelector("#add-plant-noxious");
    if (noxEl) noxEl.style.display = "none";
    const invEl = overlay.querySelector("#add-plant-invasive");
    if (invEl) invEl.style.display = result.invasive_alert ? "inline-flex" : "none";

    // Build the info grid from the Verdantly fields per user spec
    const infoGrid = overlay.querySelector("#add-plant-info-grid");
    const gr  = result.growingRequirements || {};
    const gd  = result.growthDetails       || {};
    const lm  = result.lifecycleMilestones || {};
    const eco = result.ecology             || {};
    const tox = (result.safety && result.safety.toxicity) || {};
    const sp  = result.species             || {};
    const tx  = sp.taxonomy                || {};
    const cells = [];

    if (gr.sunlightRequirement)
      cells.push({ label: "☀️ Light", value: gr.sunlightRequirement });
    if (gr.waterRequirement) {
      const wr = String(gr.waterRequirement).toLowerCase();
      let range = "";
      if (wr === "low")                       range = " (every 7–14 days)";
      else if (wr === "moderate" || wr === "medium") range = " (every 3–7 days)";
      else if (wr === "high")                 range = " (every 1–3 days)";
      cells.push({ label: "💧 Water", value: `${gr.waterRequirement}${range}` });
    }
    if (gr.minGrowingZone != null || gr.maxGrowingZone != null) {
      const zMin = gr.minGrowingZone, zMax = gr.maxGrowingZone;
      const v = (zMin != null && zMax != null && zMin !== zMax) ? `${zMin}–${zMax}`
              : (zMin != null ? `${zMin}` : `${zMax}`);
      cells.push({ label: "🗺 Hardiness", value: v });
    }
    if (gd.growthPeriod)
      cells.push({ label: "📅 Growth", value: gd.growthPeriod });
    if (gr.soilPreference)
      cells.push({ label: "🌱 Soil", value: gr.soilPreference });
    if (gr.spacingRequirement)
      cells.push({ label: "↔ Spacing", value: gr.spacingRequirement });
    if (eco.soilPhMin != null || eco.soilPhMax != null) {
      const v = (eco.soilPhMin != null && eco.soilPhMax != null && eco.soilPhMin !== eco.soilPhMax)
        ? `${eco.soilPhMin}–${eco.soilPhMax}`
        : (eco.soilPhMin != null ? `${eco.soilPhMin}` : `${eco.soilPhMax}`);
      cells.push({ label: "⚗ pH", value: v });
    }
    if (lm.daysToHarvestMin != null || lm.daysToHarvestMax != null) {
      const hMin = lm.daysToHarvestMin, hMax = lm.daysToHarvestMax;
      const v = (hMin != null && hMax != null && hMin !== hMax) ? `${hMin}–${hMax} days`
              : (hMin != null ? `${hMin} days` : `${hMax} days`);
      cells.push({ label: "🌾 Harvest", value: v });
    }
    const toxKeys = Object.keys(tox);
    if (toxKeys.length) {
      const parts = toxKeys.map(k => {
        const lvl = (tox[k] && tox[k].level) || "";
        return lvl ? `${k} (${lvl})` : k;
      });
      cells.push({ label: "☠ Toxicity", value: parts.join(", ") });
    }
    if (tx.family || tx.genus) {
      const parts = [tx.family, tx.genus, tx.species].filter(Boolean);
      cells.push({ label: "🔬 Taxonomy", value: parts.join(" | ") });
    }

    if (!cells.length) {
      infoGrid.innerHTML = `<div style="grid-column:1/-1;font-size:12px;color:var(--secondary-text-color)">Verdantly returned no care fields for this variety. You can still add the plant and fill in details manually in the trading card.</div>`;
    } else {
      infoGrid.innerHTML = cells.map(c => `
        <div class="plant-info-cell">
          <div class="plant-info-label">${c.label}</div>
          <div class="plant-info-value">${this._esc(String(c.value))}</div>
        </div>`).join("");
    }
  }

  /* ── Live update on hass change ────────────────────────────────────────── */

  _updateLive() {
    // Re-render the current view to pick up new entity values
    if (this._view === "main" || this._view.startsWith("plot:")) {
      // Throttle: only fully re-render every 5 seconds via state changes
      const now = Date.now();
      if (!this._lastLiveRender || now - this._lastLiveRender > 1500) {
        this._lastLiveRender = now;
        this._renderCurrentView();
      }
    }
  }
}

/* ─── Register ───────────────────────────────────────────────────────────── */

if (!customElements.get("agribud-card")) {
  customElements.define("agribud-card", AgribudCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "agribud-card")) {
  window.customCards.push({
    type: "agribud-card", name: "Agribud",
    description: "Garden growth tracker with grow plots, Verdantly plant database (RapidAPI), and HA weather integration.",
  });
}
console.info(
  "%c AGRIBUD CARD %c v1.1.1 ",
  "background:#1D9E75;color:#fff;font-weight:bold;padding:2px 4px;border-radius:4px 0 0 4px",
  "background:#0F6E56;color:#fff;padding:2px 4px;border-radius:0 4px 4px 0",
);
