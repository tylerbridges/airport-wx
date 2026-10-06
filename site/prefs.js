// Settings state (build2b). A classic script loaded in <head> (index.html "nav hook") so the theme applies
// before first paint and window.AWXPrefs exists before app.js, nav.js and settings.js run; require()-able in
// Node (tools/prefs.test.mjs). Shared by app.js, the nav shell's settings.js and check.js.
//
//   getPrefs()            -> a copy of the current settings
//   setPref(key, value)   -> validates, saves to localStorage "awx-settings", notifies; returns the new copy
//   onPrefs(fn)           -> fn(prefs, key) after every change (also changes made in another tab); returns an unsubscribe
//   DEFAULTS, CATEGORIES, KEY
//
// Keys:
//   mode     "traveler" | "aviation"
//   show     {category: bool} for CATEGORIES (setPref merges into the current object). Ground stops and full
//            airport closures aren't a category: they can never be hidden.
//   theme    "auto" | "light" | "dark"
//   clock    12 | 24 (a number; "12"/"24" strings are accepted)
//   codes    "iata" | "icao"
//   timeRef  "airport" (each airport's local time) | "mine" (the device's time zone)
(function (root) {
  "use strict";
  var KEY = "awx-settings";
  var CATEGORIES = ["storms", "winter", "wind", "fog", "heat", "faa", "atc", "runways", "vip", "space", "tstm"];
  var showAll = {};
  CATEGORIES.forEach(function (k) { showAll[k] = true; });
  var DEFAULTS = Object.freeze({ mode: "traveler", show: Object.freeze(showAll), theme: "auto", clock: 12, codes: "iata", timeRef: "airport", flights: false });
  var ONE_OF = { mode: ["traveler", "aviation"], theme: ["auto", "light", "dark"], codes: ["iata", "icao"], timeRef: ["airport", "mine"] };

  function copyOf(p) {
    var show = {};
    for (var k in p.show) show[k] = p.show[k];
    return { mode: p.mode, show: show, theme: p.theme, clock: p.clock, codes: p.codes, timeRef: p.timeRef, flights: p.flights };
  }
  function clean(v, base) {
    var p = copyOf(base || DEFAULTS);
    if (!v || typeof v !== "object") return p;
    for (var k in ONE_OF) if (ONE_OF[k].indexOf(v[k]) >= 0) p[k] = v[k];
    if (typeof v.flights === "boolean") p.flights = v.flights;
    if (Number(v.clock) === 12 || Number(v.clock) === 24) p.clock = Number(v.clock);
    if (v.show && typeof v.show === "object") CATEGORIES.forEach(function (c) { if (typeof v.show[c] === "boolean") p.show[c] = v.show[c]; });
    // settings saved by an early build2b page ({hide: {cat: true}, tz: "mine"})
    if (v.hide && typeof v.hide === "object" && !v.show) CATEGORIES.forEach(function (c) { if (v.hide[c] === true) p.show[c] = false; });
    if (v.tz === "mine" && !v.timeRef) p.timeRef = "mine";
    return p;
  }
  function read() {
    try { return clean(JSON.parse(root.localStorage.getItem(KEY) || "null")); } catch (e) { return clean(null); }
  }

  var cur = read();
  var subs = [];
  function notify(key) {
    var p = copyOf(cur);
    subs.slice().forEach(function (fn) { try { fn(copyOf(p), key); } catch (e) { if (root.console) console.error(e); } });
  }
  function getPrefs() { return copyOf(cur); }
  function setPref(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error("unknown setting: " + key);
    var v = copyOf(cur);
    if (key === "show") { for (var c in (value || {})) v.show[c] = value[c]; } else v[key] = value;
    var next = clean(v, cur);
    if (JSON.stringify(next) === JSON.stringify(cur)) return copyOf(cur);
    cur = next;
    try { root.localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) { /* storage blocked: the change still applies to this page */ }
    notify(key);
    return copyOf(cur);
  }
  function onPrefs(fn) {
    subs.push(fn);
    return function () { subs = subs.filter(function (x) { return x !== fn; }); };
  }
  // another tab changed the settings
  if (root.addEventListener) root.addEventListener("storage", function (e) { if (e.key === KEY) { cur = read(); notify(null); } });

  var api = { getPrefs: getPrefs, setPref: setPref, onPrefs: onPrefs, DEFAULTS: DEFAULTS, CATEGORIES: CATEGORIES, KEY: KEY };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXPrefs = api;
})(typeof window !== "undefined" ? window : globalThis);
