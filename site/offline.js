// Bounded last-known airport status. No trips, calendar URLs, flight identifiers or raw reports. Airports are the
// summary's (site/split.js): detail-only parts (LAMP, TAF text, hour conditions) aren't kept, and offline sheets say so.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXOffline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const KEY = "awx-airport-snapshot-v2", MAX_AGE = 6 * 3600000, MAX_BYTES = 750000;
  const AIRPORT_KEYS = ["iata", "icao", "name", "city", "state", "tz", "lat", "lon", "now", "peak", "hours", "obsNext", "observed", "metar", "taf", "faa", "atcscc", "alerts", "spc", "sigmets", "aviationAdvisories", "tcf", "cwa", "opsplan", "notices", "cascade", "coverage"];
  const OMIT = /^(?:id|trip|trips|flight(?:No|Number|Id)?|nameOfTraveler|email|confirmation|seat|notes|url|calendar|ics|raw|rawTAF|rawOb)$/i;
  function clean(value, depth = 0) {
    if (depth > 8 || value == null) return null;
    if (typeof value === "string") return value.slice(0, 400);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 48).map((v) => clean(v, depth + 1));
    if (typeof value !== "object") return null;
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 64)) if (!OMIT.test(k) && !/(?:calendar|ics|flightNumber|flightNo|flightId|confirmation|email|passenger|traveler|client_secret|token)/i.test(k)) out[k] = k === "error" && v ? "Source partly unavailable" : clean(v, depth + 1);
    return out;
  }
  function sourceMap(sources) {
    return Object.fromEntries(Object.entries(sources || {}).filter(([k]) => ["faa", "atcscc", "nws", "spc", "metar", "taf", "sigmet", "isigmet", "lamp", "tcf", "cwa", "tfr"].includes(k)).slice(0, 20).map(([k, s]) => [k, {
      ok: !!s?.ok, at: typeof s?.at === "string" ? s.at : null, stale: !!s?.stale,
      error: s?.error ? "Source partly unavailable" : null,
    }]));
  }
  function snapshot(data, now = Date.now()) {
    const generated = Date.parse(data?.generated), checked = Number.isFinite(Date.parse(data?.live)) ? Date.parse(data.live) : generated;
    if (!Number.isFinite(generated) || now - checked > MAX_AGE || generated - now > 5 * 60000 || checked - now > 5 * 60000 || !Array.isArray(data.airports)) return null;
    const airports = data.airports.filter((a) => !a.trip && /^[A-Z]{3}$/.test(a.iata)).slice(0, 64).map((a) => {
      const out = {};
      for (const k of AIRPORT_KEYS) if (a[k] !== undefined) out[k] = clean(k === "hours" ? a[k].slice(0, 24) : k === "observed" ? a[k].slice(-12) : a[k]);
      if (out.notices) { out.notices.items = (out.notices.items || []).filter((x) => x.src === "tfr"); out.notices.count = out.notices.items.length; }
      return out;
    }).filter((a) => a.hours?.length && a.now && a.peak);
    if (!airports.length) return null;
    return { generated: data.generated, ...(Number.isFinite(Date.parse(data.live)) ? { live: data.live } : {}), sources: sourceMap(data.sources), noticeSources: sourceMap(data.noticeSources), airports };
  }
  function save(storage, data, now = Date.now()) {
    try {
      const safe = snapshot(data, now);
      if (!safe) return false;
      const text = JSON.stringify({ v: 1, saved: now, data: safe });
      if (text.length > MAX_BYTES) return false;
      storage.setItem(KEY, text);
      return true;
    } catch { return false; }
  }
  function load(storage, now = Date.now()) {
    try {
      const text = storage.getItem(KEY);
      if (!text || text.length > MAX_BYTES) return null;
      const doc = JSON.parse(text), safe = doc.v === 1 && Number.isFinite(doc.saved) && doc.saved <= now + 5 * 60000 && now - doc.saved <= MAX_AGE ? snapshot(doc.data, now) : null;
      if (!safe) { storage.removeItem(KEY); return null; }
      return safe;
    } catch { return null; }
  }
  return { KEY, MAX_AGE, MAX_BYTES, snapshot, save, load };
});
