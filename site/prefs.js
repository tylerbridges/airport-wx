// Settings storage (STUB written by the nav shell until Build 2b's site/prefs.js lands; keep theirs).
// Classic script, loaded in <head> before app.js; also require()-able in Node.
//
//   AWXPrefs.getPrefs()            -> a copy of the current settings, defaults filled in
//   AWXPrefs.setPref(key, value)   -> saves one key ("show" takes the whole map; "show.storms" one category)
//   AWXPrefs.onPrefs(fn)           -> fn(prefs, key) after every change (also from other tabs); returns unsubscribe
//   AWXPrefs.DEFAULTS
//
// localStorage key "awx-settings". Unknown or invalid values fall back to the defaults.
(function (root) {
  "use strict";
  var KEY = "awx-settings";
  var DEFAULTS = {
    mode: "traveler", // traveler | aviation
    show: { storms: true, winter: true, wind: true, fog: true, heat: true, faa: true, atc: true, runways: true, vip: true, space: true, tstm: true },
    theme: "auto", // auto | light | dark
    clock: "12", // 12 | 24
    codes: "iata", // iata | icao
    timeRef: "airport", // airport | mine
  };
  var ALLOWED = { mode: ["traveler", "aviation"], theme: ["auto", "light", "dark"], clock: ["12", "24"], codes: ["iata", "icao"], timeRef: ["airport", "mine"] };
  var listeners = [];

  function clean(v) {
    var p = JSON.parse(JSON.stringify(DEFAULTS));
    if (!v || typeof v !== "object") return p;
    for (var k in ALLOWED) if (v[k] != null && ALLOWED[k].indexOf(String(v[k])) >= 0) p[k] = String(v[k]);
    if (v.show && typeof v.show === "object") for (var c in p.show) if (typeof v.show[c] === "boolean") p.show[c] = v.show[c];
    return p;
  }
  function read() {
    try { return clean(JSON.parse(root.localStorage.getItem(KEY) || "null")); } catch (e) { return clean(null); }
  }
  function getPrefs() { return read(); }
  function setPref(key, value) {
    var p = read();
    var m = /^show\.(\w+)$/.exec(key);
    if (m) { if (m[1] in p.show) p.show[m[1]] = !!value; }
    else if (key === "show") { if (value && typeof value === "object") for (var c in p.show) if (typeof value[c] === "boolean") p.show[c] = value[c]; }
    else if (ALLOWED[key] && ALLOWED[key].indexOf(String(value)) >= 0) p[key] = String(value);
    else return p;
    try { root.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: applies until reload */ }
    emit(p, m ? "show" : key);
    return p;
  }
  function emit(p, key) {
    listeners.slice().forEach(function (fn) { try { fn(p, key); } catch (e) { setTimeout(function () { throw e; }); } });
  }
  function onPrefs(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
  }
  if (root.addEventListener) root.addEventListener("storage", function (e) { if (e.key === KEY) emit(read(), null); });

  var api = { getPrefs: getPrefs, setPref: setPref, onPrefs: onPrefs, DEFAULTS: DEFAULTS, KEY: KEY };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXPrefs = api;
})(typeof window !== "undefined" ? window : globalThis);
