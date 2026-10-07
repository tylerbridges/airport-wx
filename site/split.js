// Summary / detail split of a build (README "status.json"). Pure; no DOM, no fetching. Shared by the poller
// (poller/poll.mjs writes data/summary.json + data/airport/<IATA>.json), the page (app.js splits sample, scenario
// and other full files in memory and restores an airport's details when its sheet opens), the check page and tests.
//   summary.json            the build with every airport slimmed to what the home list, map, national strip,
//                           At risk, trips and outlook.js read for all airports (split: 1 marks it)
//   airport/<IATA>.json     {generated, sources, airport}: that airport's full object (the same poll), for its
//                           sheet / detail pages and the live relay
// Detail-only parts are REMOVED from the summary by name, so a field added later stays in the summary by default:
// lamp, taf.raw/periods (taf keeps issued), forecast-hour conditions after the first hour (wx stays: outlook.js
// conditionHeadline reads it; the first hour keeps everything: app.js nowWords falls back to it), the delay
// explanation fields (analog, basis, lead, rateFrom), observed-hour conditions. obsNext (the observed hour 1, README
// "The observed next hour") stays like the first hour: it becomes the current hour after the top of the hour. hubResearch (research only, recorded
// to history from the unpublished full file) is in neither file.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = 1;
  const COND = ["fltCat", "cig", "vis", "wdir", "wspd", "wgst", "temp"]; // read only by the sheet's hour cards, Weather page and Pilot details
  const DELAY_DETAIL = ["analog", "basis", "lead", "rateFrom"]; // read only by "Why this outlook" / the Aviation delay card
  const OBS_DETAIL = [...COND, "wx"];
  const DROP = ["hubResearch"]; // research only: never published
  const omit = (o, keys) => { const r = { ...o }; for (const k of keys) delete r[k]; return r; };

  function slimHour(h, first) {
    if (!h || typeof h !== "object") return h;
    const r = first ? { ...h } : omit(h, COND);
    if (h.delay && typeof h.delay === "object") r.delay = omit(h.delay, DELAY_DETAIL);
    return r;
  }
  /** One airport as the summary carries it. */
  function slimAirport(a) {
    const r = omit(a, ["lamp", ...DROP]);
    if (a.taf && typeof a.taf === "object") r.taf = omit(a.taf, ["raw", "periods"]);
    if (Array.isArray(a.hours)) r.hours = a.hours.map((h, i) => slimHour(h, i === 0));
    if (a.obsNext && typeof a.obsNext === "object") r.obsNext = slimHour(a.obsNext, true);
    if (Array.isArray(a.observed)) r.observed = a.observed.map((h) => (h && typeof h === "object" ? omit(h, OBS_DETAIL) : h));
    return r;
  }
  /** The published airport file: the airport's full object (without research fields) and the build it came from. */
  function detailOf(status, a) {
    return { v: VERSION, generated: status.generated, sources: status.sources || {}, airport: omit(a, DROP) };
  }
  /** Full build -> {summary, details: {IATA: detail}}. */
  function split(status) {
    const { airports = [], ...top } = status || {};
    const summary = { ...top, split: VERSION, airports: airports.map(slimAirport) };
    const details = {};
    for (const a of airports) if (a && a.iata) details[a.iata] = detailOf(status, a);
    return { summary, details };
  }
  const isSummary = (data) => !!(data && data.split);

  /**
   * A slim airport with its detail-only parts put back from `full` (a detail file's airport). Everything the summary
   * has wins (so the sheet's headline, levels and timeline stay those of the summary in use); hours and observed hours
   * are matched by their time. With the same build this reproduces the full airport exactly.
   */
  function restore(slim, full) {
    if (!full) return slim;
    const out = { ...slim };
    if ("lamp" in full) out.lamp = full.lamp;
    if (slim.taf && typeof slim.taf === "object" && full.taf && typeof full.taf === "object") out.taf = { ...full.taf, ...slim.taf };
    const byT = (list) => new Map((Array.isArray(list) ? list : []).filter((h) => h && h.t).map((h) => [h.t, h]));
    const one = (h, f) => {
      if (!f) return h;
      const r = { ...f, ...h };
      if (f.delay && h.delay) r.delay = { ...f.delay, ...h.delay };
      else if (!("delay" in h)) delete r.delay; // the summary's hour has no delay numbers: none
      return r;
    };
    // an hour the page replaced with the observed hour 1 (obs: true, site/outlook.js withObsHour) takes its details from
    // the detail file's obsNext, never from the forecast hour at that time (whose ceiling/visibility would leak in)
    const fObs = full.obsNext && typeof full.obsNext === "object" ? full.obsNext : null;
    if (Array.isArray(slim.hours)) {
      const fh = byT(full.hours);
      out.hours = slim.hours.map((h) => (h && h.obs ? one(h, fObs && fObs.t === h.t ? fObs : null) : one(h, h && fh.get(h.t))));
    }
    if (slim.obsNext && typeof slim.obsNext === "object") out.obsNext = one(slim.obsNext, fObs && fObs.t === slim.obsNext.t ? fObs : null);
    if (Array.isArray(slim.observed)) {
      const fo = byT(full.observed);
      out.observed = slim.observed.map((h) => { const f = h && fo.get(h.t); return f ? { ...f, ...h } : h; });
    }
    return out;
  }
  return { VERSION, COND, DELAY_DETAIL, OBS_DETAIL, slimAirport, slimHour, detailOf, split, isSummary, restore };
});
