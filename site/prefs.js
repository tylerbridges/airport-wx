// Settings state (build2b). One small ES module shared by app.js (through window.AWXPrefs, since app.js is
// a classic script loaded after this module), the settings UI (site/settings.js) and check.js.
//
//   getPrefs()            -> a copy of the current settings
//   setPref(key, value)   -> validates, saves to localStorage "awx-settings", notifies; returns the new copy
//   onPrefs(fn)           -> fn(prefs, key) after every change (also changes made in another tab); returns an unsubscribe
//   DEFAULTS, CATEGORIES
//
// Keys:
//   mode     "traveler" | "aviation"
//   show     {category: bool} for CATEGORIES (setPref merges into the current object). Ground stops and full
//            airport closures aren't a category: they can never be hidden.
//   theme    "auto" | "light" | "dark"
//   clock    12 | 24
//   codes    "iata" | "icao"
//   timeRef  "airport" (each airport's local time) | "mine" (the device's time zone)
export const KEY = "awx-settings";
export const CATEGORIES = ["storms", "winter", "wind", "fog", "heat", "faa", "atc", "runways", "vip", "space", "tstm"];
export const DEFAULTS = Object.freeze({
  mode: "traveler",
  show: Object.freeze(Object.fromEntries(CATEGORIES.map((k) => [k, true]))),
  theme: "auto",
  clock: 12,
  codes: "iata",
  timeRef: "airport",
});

const ONE_OF = { mode: ["traveler", "aviation"], theme: ["auto", "light", "dark"], codes: ["iata", "icao"], timeRef: ["airport", "mine"] };

function clean(v, base = DEFAULTS) {
  const p = { mode: base.mode, show: { ...base.show }, theme: base.theme, clock: base.clock, codes: base.codes, timeRef: base.timeRef };
  if (!v || typeof v !== "object") return p;
  for (const k of Object.keys(ONE_OF)) if (ONE_OF[k].includes(v[k])) p[k] = v[k];
  if (Number(v.clock) === 12 || Number(v.clock) === 24) p.clock = Number(v.clock);
  if (v.show && typeof v.show === "object") for (const c of CATEGORIES) if (typeof v.show[c] === "boolean") p.show[c] = v.show[c];
  // settings saved by an early build2b page ({hide: {cat: true}, tz: "mine"})
  if (v.hide && typeof v.hide === "object" && !v.show) for (const c of CATEGORIES) if (v.hide[c] === true) p.show[c] = false;
  if (v.tz === "mine" && !v.timeRef) p.timeRef = "mine";
  return p;
}

function read() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return clean(null); }
}

let cur = read();
const subs = new Set();
const copy = () => ({ ...cur, show: { ...cur.show } });
function notify(key) {
  const p = copy();
  for (const fn of [...subs]) { try { fn(p, key); } catch (e) { console.error(e); } }
}

export function getPrefs() {
  return copy();
}

export function setPref(key, value) {
  if (!(key in DEFAULTS)) throw new Error("unknown setting: " + key);
  const next = clean({ ...cur, [key]: key === "show" ? { ...cur.show, ...(value || {}) } : value }, cur);
  if (JSON.stringify(next) === JSON.stringify(cur)) return copy();
  cur = next;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage blocked: the change still applies to this page */ }
  notify(key);
  return copy();
}

export function onPrefs(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// another tab changed the settings
addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  cur = read();
  notify(null);
});

// app.js is a classic (non-module) script: it reads the same functions from here
window.AWXPrefs = { getPrefs, setPref, onPrefs, DEFAULTS, CATEGORIES, KEY };
