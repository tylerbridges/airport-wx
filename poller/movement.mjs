#!/usr/bin/env node
// Movement: "is this airport actually moving?" from free community ADS-B feeds (README "Movement").
// Each poll takes one snapshot of the aircraft within RADIUS_NM of every airport in airports.json,
// classifies each aircraft against the field (taxiing, stationary, departing, arriving, holding),
// counts takeoffs/landings from what changed since the last snapshot, and writes
// site/data/movement.json (rates per hour vs a learned baseline). State and a compact per-run log
// live on the `history` branch under movement/.
//
//   node poller/movement.mjs [--fixtures] [--state <dir>] [--out <file>]
//        one run on its own: reads <dir>/state.json + baseline.json (default .cache/movement, which
//        the workflow fills from the history branch), writes --out (default site/data/movement.json)
//        and <dir>/out/{state,baseline,log,sample}.json
//   node poller/movement.mjs record <historyDir> [--from <dir>]
//        copies <dir>/out (default .cache/movement/out) into <historyDir>/movement/ (never throws
//        past a non-zero exit; the workflow step is continue-on-error)
//
// poll.mjs runs it alongside the other sources (startMovement, marked "movement hook").
// Pure helpers are exported for poller/movement.test.mjs. Node built-ins only.
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compact } from "./record.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

export const RADIUS_NM = 15; // snapshot radius around each airport
export const GAP_MS = 1100; // >= 1 request/s per feed (adsb.fi's documented public limit)
export const BUDGET_MS = 60_000; // whole collection; leftover airports go first next run
export const REQ_TIMEOUT_MS = 10_000;
export const EXPECTED_PER_HOUR = 12; // one snapshot every 5 minutes
export const PREV_MAX_MIN = 15; // a previous snapshot older than this isn't compared
export const FIELD_NM = 3.5; // "near the field" for ground / under-100-ft aircraft
export const LEARN_DAYS = 21;
export const MIN_SAMPLES = 3; // own-log baseline needs this many hours per hour-of-week
export const KEEP_SAMPLES = 4;
export const MIN_SAMPLE_COV = 0.5; // a finished hour joins the baseline only with this coverage

/** Feeds, in order of preference. Verified 2026-10-03 (README "Movement" has the details and URLs). */
export const FEEDS = [
  { id: "adsbfi", name: "adsb.fi", home: "https://adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}` },
  { id: "adsblol", name: "ADSB.lol", home: "https://adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
];

/** Same list as site/movement.js SOURCES (the Settings → Data & checks page reads that one). */
export const SOURCES = [
  {
    id: "adsbfi", name: "adsb.fi", role: "primary", url: "https://adsb.fi",
    api: "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}", docs: "https://github.com/adsbfi/opendata",
    terms: "Personal, non-commercial use only; 1 request per second; cite adsb.fi with a link to its home page.",
    attribution: "Aircraft positions: adsb.fi (https://adsb.fi)",
  },
  {
    id: "adsblol", name: "ADSB.lol", role: "fallback", url: "https://adsb.lol",
    api: "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}", docs: "https://github.com/adsblol/api",
    terms: "Free, no key (a key \"in the future\"); dynamic rate limits; data under ODbL 1.0.",
    license: "ODbL 1.0", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "Aircraft positions © ADSB.lol contributors, ODbL 1.0",
  },
];

/** US airlines (ICAO code → name); `hubs` are the airports their alerts look at. */
export const AIRLINES = {
  AAL: { name: "American", hubs: ["DFW", "CLT", "ORD", "PHL", "MIA", "PHX", "DCA", "LAX", "JFK"] },
  DAL: { name: "Delta", hubs: ["ATL", "DTW", "MSP", "SLC", "SEA", "LAX", "JFK", "LGA", "BOS"] },
  UAL: { name: "United", hubs: ["ORD", "DEN", "IAH", "EWR", "SFO", "IAD", "LAX"] },
  SWA: { name: "Southwest", hubs: ["MDW", "DEN", "LAS", "PHX", "BWI", "MCO", "ATL", "AUS", "BNA"] },
  JBU: { name: "JetBlue", hubs: ["JFK", "BOS", "FLL", "MCO"] },
  ASA: { name: "Alaska", hubs: ["SEA", "ANC", "SFO", "LAX", "SAN"] },
  NKS: { name: "Spirit", hubs: ["FLL", "LAS", "MCO", "DTW"] },
  FFT: { name: "Frontier", hubs: ["DEN", "MCO", "LAS", "PHL", "ATL"] },
  AAY: { name: "Allegiant", hubs: ["LAS", "MCO", "TPA"] },
  HAL: { name: "Hawaiian", hubs: ["HNL"] },
  SCX: { name: "Sun Country", hubs: ["MSP"] },
  // regionals flying for the majors (counted under their own code)
  SKW: { name: "SkyWest" }, RPA: { name: "Republic" }, ENY: { name: "Envoy" }, EDV: { name: "Endeavor" },
  JIA: { name: "PSA" }, PDT: { name: "Piedmont" }, ASH: { name: "Mesa" }, GJS: { name: "GoJet" }, QXE: { name: "Horizon" },
  // cargo
  FDX: { name: "FedEx" }, UPS: { name: "UPS" },
};

/** IATA → airline codes with a hub there. */
export const HUB_AIRLINES = {};
for (const [code, info] of Object.entries(AIRLINES)) for (const h of info.hubs || []) (HUB_AIRLINES[h] ||= []).push(code);

// ---------- geometry ----------

const RAD = Math.PI / 180;
/** Great-circle distance in nautical miles. */
export function distNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Initial bearing from point 1 to point 2, degrees 0-360. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
export const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

// ---------- feed parsing ----------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Airline ICAO prefix of a callsign ("UAL1234" → "UAL"), else "". */
export const airlineOf = (cs) => { const m = /^([A-Z]{3})\d/.exec(cs || ""); return m ? m[1] : ""; };

/**
 * ADSBexchange-v2-style reply ({ac: [...]}, or {aircraft: [...]}) → normalized aircraft.
 * Drops non-ICAO (~) addresses, surface vehicles/obstacles (C*), gliders/balloons/UAVs (B*),
 * aircraft without a position, and anything last seen over 60 s ago. Throws on an unexpected shape.
 */
export function parseFeed(j) {
  if (!j || typeof j !== "object") throw new Error("not JSON");
  const arr = Array.isArray(j.ac) ? j.ac : Array.isArray(j.aircraft) ? j.aircraft : j.ac === null || j.aircraft === null ? [] : null;
  if (!arr) throw new Error("unexpected response (no ac list)" + (j.msg ? ": " + String(j.msg).slice(0, 80) : ""));
  const out = [];
  for (const a of arr) {
    if (!a || typeof a.hex !== "string" || a.hex.startsWith("~")) continue;
    if (/^[BC]/.test(a.category || "")) continue;
    const lat = num(a.lat) ?? num(a.lastPosition?.lat);
    const lon = num(a.lon) ?? num(a.lastPosition?.lon);
    if (lat == null || lon == null) continue;
    const seen = num(a.seen_pos) ?? num(a.seen);
    if (seen != null && seen > 60) continue;
    const gnd = a.alt_baro === "ground";
    out.push({
      hex: a.hex.toLowerCase(),
      cs: typeof a.flight === "string" ? a.flight.trim() : "",
      lat, lon, gnd,
      alt: gnd ? null : num(a.alt_baro) ?? num(a.alt_geom),
      gs: num(a.gs),
      rate: num(a.baro_rate) ?? num(a.geom_rate),
      trk: num(a.track) ?? num(a.true_heading),
      trate: num(a.track_rate),
    });
  }
  return out;
}

// ---------- classification ----------

/**
 * One aircraft against one airport ({lat, lon, elev ft}). prev = this hex's record in the previous
 * snapshot ({lat, lon, trk}) and dtMin its age, used only for holding.
 * → {s, d}: s = taxi | stat | roll (on the ground near the field; gs 5-40 kt, < 5, > 40) |
 *   dep | arr | hold | air (any other airborne) | null (on the ground somewhere else).
 */
export function classify(ac, apt, prev = null, dtMin = null) {
  const d = distNm(apt.lat, apt.lon, ac.lat, ac.lon);
  // alt_baro is pressure altitude (29.92 inHg); apt.qnh (ft, from the METAR altimeter) turns it into height above sea level
  const agl = ac.gnd ? 0 : ac.alt != null ? ac.alt + (apt.qnh || 0) - (apt.elev || 0) : null;
  if (ac.gnd || (agl != null && agl < 100)) {
    if (d > FIELD_NM) return { s: null, d };
    const gs = ac.gs ?? 0;
    return { s: gs > 40 ? "roll" : gs >= 5 ? "taxi" : "stat", d };
  }
  if (agl == null) return { s: "air", d };
  const rate = ac.rate;
  if (ac.trk != null && rate != null && agl < 4000) {
    const out = bearingDeg(apt.lat, apt.lon, ac.lat, ac.lon);
    if (d <= 8 && rate > 500 && angDiff(ac.trk, out) < 90) return { s: "dep", d };
    if (d <= 12 && rate < -300 && angDiff(ac.trk, (out + 180) % 360) < 90) return { s: "arr", d };
  }
  if (d <= 40 && agl >= 4000 && agl <= 20000 && turning(ac, prev, dtMin)) return { s: "hold", d };
  return { s: "air", d };
}

/** Holding evidence: the feed's track_rate (deg/s), else a big heading change with little progress since the last snapshot. */
export function turning(ac, prev, dtMin) {
  if (ac.trate != null) return Math.abs(ac.trate) >= 1.5;
  if (!prev || prev.trk == null || ac.trk == null || ac.gs == null || prev.lat == null || !(dtMin > 0 && dtMin <= PREV_MAX_MIN)) return false;
  const moved = distNm(prev.lat, prev.lon, ac.lat, ac.lon);
  return angDiff(ac.trk, prev.trk) >= 45 && moved < 0.4 * ac.gs * (dtMin / 60);
}

const GROUND = new Set(["taxi", "stat", "roll"]);

/**
 * What changed between two snapshots of one airport (records keyed by hex: {s, d, in}).
 * Takeoff: departing or on the ground (moving, not just landed) last time → departing, airborne
 * or gone now. Landing: arriving last time → on the ground or gone now; or first seen on the
 * landing roll. A parked aircraft that disappears (transponder off) is not a takeoff.
 */
export function transitions(prevAc, curAc) {
  const takeoffs = new Set();
  const landings = new Set();
  for (const [hex, c] of Object.entries(curAc)) {
    const p = prevAc?.[hex];
    if (!p && c.s === "roll") landings.add(hex);
  }
  for (const [hex, p] of Object.entries(prevAc || {})) {
    const c = curAc[hex];
    const cs = c ? c.s : "gone";
    if (p.s === "dep") {
      if (cs === "gone" || cs === "dep" || cs === "air" || cs === "hold") takeoffs.add(hex);
    } else if (GROUND.has(p.s)) {
      const airborne = cs === "dep" || cs === "air" || cs === "hold";
      const goneMoving = cs === "gone" && p.s !== "stat" && !p.in;
      if (airborne || goneMoving) takeoffs.add(hex);
    } else if (p.s === "arr") {
      if (cs === "gone" || GROUND.has(cs)) landings.add(hex);
    }
  }
  return { takeoffs, landings };
}

// ---------- per-airport step ----------

const hourKey = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13) + "Z";
const hourMs = (key) => Date.parse(key.slice(0, 13) + ":00:00Z");
const shortIso = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

/** Hour of week in the airport's time zone: 0 = Sunday 00-01 local … 167 = Saturday 23-24. */
export function hourOfWeek(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday").value);
  return wd * 24 + (Number(parts.find((p) => p.type === "hour").value) % 24);
}

// state.json keeps each aircraft as [s, d, alt, trk, gs, in, lat, lon, airline]
const pack = (r) => [r.s, Math.round(r.d * 10) / 10, r.alt ?? null, r.trk == null ? null : Math.round(r.trk), r.gs == null ? null : Math.round(r.gs), r.in ? 1 : 0, Math.round(r.lat * 1e4) / 1e4, Math.round(r.lon * 1e4) / 1e4, r.al || ""];
const unpack = (a) => (Array.isArray(a) ? { s: a[0], d: a[1], alt: a[2], trk: a[3], gs: a[4], in: !!a[5], lat: a[6], lon: a[7], al: a[8] || "" } : a);
export function unpackAc(ac) { return Object.fromEntries(Object.entries(ac || {}).map(([k, v]) => [k, unpack(v)])); }

/**
 * Applies one snapshot (normalized aircraft list) to an airport's state.
 * apState: {t, ac, recent: [[tSec, depHexes, arrHexes, byAirline]], hrs, last}
 * → {state, run: {dep, arr, taxi, taxiOut, ground, holding, byAirline, seen}}
 */
export function stepAirport(apState, list, apt, nowMs) {
  const st = { recent: [], hrs: [], ...(apState || {}) };
  const prevT = st.t ? Date.parse(st.t) : null;
  const dtMin = prevT != null ? (nowMs - prevT) / MIN : null;
  const prevAc = dtMin != null && dtMin > 0 && dtMin <= PREV_MAX_MIN ? unpackAc(st.ac) : null;
  const cur = {};
  for (const ac of list) {
    const p = prevAc?.[ac.hex] || null;
    const { s, d } = classify(ac, apt, p, dtMin);
    if (!s) continue;
    cur[ac.hex] = { s, d, alt: ac.alt, trk: ac.trk, gs: ac.gs, lat: ac.lat, lon: ac.lon, al: airlineOf(ac.cs) || p?.al || "", in: false };
  }
  const { takeoffs, landings } = transitions(prevAc, cur);
  for (const [hex, c] of Object.entries(cur)) {
    if (!GROUND.has(c.s)) continue;
    const p = prevAc?.[hex];
    c.in = landings.has(hex) || !!(p && p.in && GROUND.has(p.s));
  }
  const counted = { dep: new Set(), arr: new Set() };
  for (const [t, dep, arr] of st.recent) {
    if (nowMs - t * 1000 >= HOUR) continue;
    dep.forEach((x) => counted.dep.add(x));
    arr.forEach((x) => counted.arr.add(x));
  }
  const dep = new Set();
  const arr = new Set();
  for (const [hex, c] of Object.entries(cur)) {
    if (c.s === "dep" && prevAc?.[hex]?.s !== "arr") dep.add(hex); // arriving → climbing away = go-around, not a departure
    if (c.s === "arr") arr.add(hex);
  }
  takeoffs.forEach((x) => dep.add(x));
  landings.forEach((x) => arr.add(x));
  const depNew = [...dep].filter((x) => !counted.dep.has(x)).sort();
  const arrNew = [...arr].filter((x) => !counted.arr.has(x)).sort();
  const byAirline = {};
  for (const hex of depNew) {
    const al = cur[hex]?.al || prevAc?.[hex]?.al || "";
    if (al) byAirline[al] = (byAirline[al] || 0) + 1;
  }
  const vals = Object.values(cur);
  const taxi = vals.filter((c) => c.s === "taxi");
  const run = {
    dep: depNew.length, arr: arrNew.length,
    taxi: taxi.length, taxiOut: taxi.filter((c) => !c.in).length,
    ground: vals.filter((c) => GROUND.has(c.s)).length,
    holding: vals.filter((c) => c.s === "hold").length,
    byAirline, seen: list.length,
  };
  const keep = {};
  for (const [hex, c] of Object.entries(cur)) if (c.s !== "air") keep[hex] = pack(c);
  st.t = shortIsoSec(nowMs);
  st.ac = keep;
  st.recent = [...st.recent.filter(([t]) => nowMs - t * 1000 < 2 * HOUR), [Math.floor(nowMs / 1000), depNew, arrNew, byAirline]];
  return { state: st, run, sets: { dep: depNew, arr: arrNew } };
}
const shortIsoSec = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

/** Coverage-scaled rate: raw count over n snapshots when `expected` were due. */
export function scaleRate(raw, n, expected = EXPECTED_PER_HOUR) {
  const coverage = Math.min(1, n / expected);
  return { coverage: Math.round(coverage * 100) / 100, rate: n > 0 ? Math.round(raw / coverage) : null };
}

/** Rolling last hour from state.recent. */
export function rolling(apState, nowMs) {
  const win = (apState?.recent || []).filter(([t]) => nowMs - t * 1000 < HOUR && t * 1000 <= nowMs);
  const depRaw = win.reduce((s, [, d]) => s + d.length, 0);
  const arrRaw = win.reduce((s, [, , a]) => s + a.length, 0);
  const d = scaleRate(depRaw, win.length);
  const a = scaleRate(arrRaw, win.length);
  return { n: win.length, coverage: d.coverage, depRaw, arrRaw, depHr: d.rate, arrHr: a.rate };
}

/**
 * Closes finished clock hours (UTC hour boundaries; hour-of-week in the airport's zone): adds each
 * to apState.hrs (last 3) and, when its coverage is at least MIN_SAMPLE_COV, a sample to the
 * airport's baseline ({how: [[dep/hr, arr/hr, {airline: dep/hr}, "YYYY-MM-DD"], ...]}).
 */
export function finalizeHours(apState, baseAp, nowMs, tz, alCodes = null) {
  const cur = hourKey(nowMs);
  const groups = new Map();
  for (const [t, dep, arr, al] of apState.recent || []) {
    const k = hourKey(t * 1000);
    if (k >= cur || (apState.last && k <= apState.last)) continue;
    if (!groups.has(k)) groups.set(k, { n: 0, dep: 0, arr: 0, al: {} });
    const g = groups.get(k);
    g.n++; g.dep += dep.length; g.arr += arr.length;
    for (const [c, v] of Object.entries(al || {})) g.al[c] = (g.al[c] || 0) + v;
  }
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k);
    const ms = hourMs(k);
    const how = hourOfWeek(ms, tz);
    const cov = Math.min(1, g.n / EXPECTED_PER_HOUR);
    const al = Object.fromEntries(Object.entries(g.al).filter(([c]) => !alCodes || alCodes.includes(c)).map(([c, v]) => [c, Math.round(v / cov)]));
    const h = { h: k, how, n: g.n, cov: Math.round(cov * 100) / 100, dep: Math.round(g.dep / cov), arr: Math.round(g.arr / cov), al };
    apState.hrs = [...(apState.hrs || []), h].slice(-3);
    apState.last = k;
    if (cov >= MIN_SAMPLE_COV) {
      const date = k.slice(0, 10);
      const list = (baseAp[how] || []).filter((s) => s[3] !== date);
      list.push([h.dep, h.arr, al, date]);
      list.sort((x, y) => (x[3] < y[3] ? -1 : 1));
      baseAp[how] = list.slice(-KEEP_SAMPLES);
    }
  }
  return apState;
}

export const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Baseline for an airport-hour, first available wins: our own log (median of at least
 * MIN_SAMPLES hours with the same hour of week) → BTS scheduled flights → null.
 */
export function baselineFor(samples, bts) {
  if (samples && samples.length >= MIN_SAMPLES) {
    return { depHr: Math.round(median(samples.map((s) => s[0]))), arrHr: Math.round(median(samples.map((s) => s[1]))), n: samples.length, source: "own" };
  }
  if (bts && bts.depHr != null) return { depHr: Math.round(bts.depHr), arrHr: bts.arrHr == null ? null : Math.round(bts.arrHr), n: bts.n ?? null, source: "bts" };
  return null;
}

/**
 * BTS scheduled flights per hour, if the Phase 3 training output has them. Tolerant: looks in
 * site/data/model/{schedule,sched,model,fallback}.json for a `sched`/`schedule`/`scheduled` object
 * {IATA: {dep: [168 or 24], arr: [...]}} or {IATA: [168 or 24 departures]} (hour of week local,
 * 0 = Sunday 00). Anything else → null (no BTS baseline).
 */
export function btsFromModel(objs) {
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    const s = o.sched || o.schedule || o.scheduled || (o.v && o.ap && o.deps ? o.deps : null);
    if (!s || typeof s !== "object") continue;
    const table = {};
    for (const [iata, v] of Object.entries(s)) {
      const dep = Array.isArray(v) ? v : Array.isArray(v?.dep) ? v.dep : null;
      const arr = Array.isArray(v?.arr) ? v.arr : null;
      if (dep && (dep.length === 168 || dep.length === 24)) table[iata] = { dep, arr: arr && arr.length === dep.length ? arr : null };
    }
    if (Object.keys(table).length) {
      return (iata, how) => {
        const t = table[iata];
        if (!t) return null;
        const i = t.dep.length === 168 ? how : how % 24;
        const d = num(t.dep[i]);
        return d == null ? null : { depHr: d, arrHr: t.arr ? num(t.arr[i]) : null, n: null };
      };
    }
  }
  return null;
}

export async function loadBts(dir = join(ROOT, "site/data/model")) {
  const objs = [];
  for (const f of ["schedule.json", "sched.json", "model.json", "fallback.json"]) {
    try { objs.push(JSON.parse(await readFile(join(dir, f), "utf8"))); } catch { /* missing or mid-write: skip */ }
  }
  try { return btsFromModel(objs); } catch { return null; }
}

/** Card-ready sentence and index. */
export function describe({ depHr, coverage, n, baseline, learnDays }) {
  if (depHr == null) return { index: null, sentence: "No recent aircraft data" };
  if (!baseline) return { index: null, sentence: `Learning normal traffic (${learnDays} of ${LEARN_DAYS} days)` };
  if (!(baseline.depHr >= 3)) return { index: null, sentence: `Departures ${depHr}/hr (quiet hour)` };
  const index = Math.round((depHr / baseline.depHr) * 100) / 100;
  if (coverage < 0.6) return { index, sentence: `Limited data this hour (${n} of ${EXPECTED_PER_HOUR} checks)` };
  if (index < 0.7 || index > 1.3) {
    const pct = Math.round(Math.abs(1 - index) * 100);
    return { index, sentence: `Departures ${depHr}/hr vs ${baseline.depHr} normal (${index < 1 ? "↓" : "↑"}${pct}%)` };
  }
  return { index, sentence: "Moving normally" };
}

const listText = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

/**
 * Airline alerts: a carrier whose departures were under 30% of its own baseline at 3+ of its hubs
 * in each of the last 2 finished clock hours (coverage >= 0.6, baseline >= 3 departures/hr).
 * stateAp: {IATA: {hrs}}; baseAp: {IATA: {how: samples}}.
 */
export function airlineAlerts(stateAp, baseAp, nowMs) {
  const want = [hourKey(nowMs - 2 * HOUR), hourKey(nowMs - HOUR)];
  const out = [];
  for (const [code, info] of Object.entries(AIRLINES)) {
    if (!info.hubs) continue;
    const low = [];
    for (const iata of info.hubs) {
      const hrs = stateAp[iata]?.hrs || [];
      const ok = want.every((k) => {
        const h = hrs.find((x) => x.h === k);
        if (!h || h.cov < 0.6) return false;
        const samples = baseAp[iata]?.[h.how] || [];
        if (samples.length < MIN_SAMPLES) return false;
        const base = median(samples.map((s) => (s[2] && s[2][code]) || 0));
        return base >= 3 && ((h.al && h.al[code]) || 0) < 0.3 * base;
      });
      if (ok) low.push(iata);
    }
    if (low.length >= 3) {
      out.push({ airline: code, name: info.name, hubs: low, sentence: `${info.name} departures far below normal at ${listText(low)} for the past 2 hours` });
    }
  }
  return out;
}

// ---------- collection ----------

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonLive(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`); e.status = res.status; throw e; }
    return { json: JSON.parse(text), text };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout after ${Math.round(timeoutMs / 1000)}s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout after ${Math.round(ms / 1000)}s`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

/**
 * Sequential snapshots, one feed request at a time, at least gapMs apart per feed, within budgetMs.
 * Starts at airports[start]; a failed primary request falls back to the next feed, and after 3
 * primary failures in a row the fallback goes first. Never throws.
 * → {snaps: {IATA: {list, src, at}}, errors: {IATA: msg}, attempted, covered, next, ms, outOfTime, used, sample}
 */
export async function collect({ airports, fetchJson = fetchJsonLive, clock = Date.now, sleep = sleepReal, budgetMs = BUDGET_MS, gapMs = GAP_MS, start = 0, feeds = FEEDS, radius = RADIUS_NM }) {
  const t0 = clock();
  const n = airports.length;
  const first = n ? ((start % n) + n) % n : 0;
  const order = airports.map((_, i) => airports[(first + i) % n]);
  const lastAt = {};
  const used = {};
  const snaps = {};
  const errors = {};
  let primaryFails = 0;
  let attempted = 0;
  let outOfTime = false;
  let sample = null;
  const left = () => budgetMs - (clock() - t0);
  const one = async (feed, a) => {
    const wait = (lastAt[feed.id] ?? -Infinity) + gapMs - clock();
    if (wait > 0) {
      if (left() - wait < 1000) throw Object.assign(new Error("time budget"), { budget: true });
      await sleep(wait);
    }
    const ms = Math.min(REQ_TIMEOUT_MS, left() - 200);
    if (ms < 800) throw Object.assign(new Error("time budget"), { budget: true });
    lastAt[feed.id] = clock();
    const url = feed.url(a.lat.toFixed(4), a.lon.toFixed(4), radius);
    const r = await withTimeout(Promise.resolve().then(() => fetchJson(url, ms)), ms + 100);
    const list = parseFeed(r.json);
    used[feed.id] = (used[feed.id] || 0) + 1;
    if (!sample && list.length) sample = { iata: a.iata, src: feed.id, url, body: String(r.text ?? JSON.stringify(r.json)).slice(0, 60_000) };
    return { list, src: feed.id, at: new Date(lastAt[feed.id]).toISOString() };
  };
  for (const a of order) {
    if (left() < 1500) { outOfTime = true; break; }
    attempted++;
    const tryOrder = primaryFails >= 3 ? [...feeds.slice(1), feeds[0]] : feeds;
    const errs = [];
    for (const feed of tryOrder) {
      try {
        snaps[a.iata] = await one(feed, a);
        if (feed === feeds[0]) primaryFails = 0;
        break;
      } catch (e) {
        if (e.budget) { outOfTime = true; break; }
        if (feed === feeds[0]) primaryFails++;
        errs.push(`${feed.name}: ${e.message || e}`);
      }
    }
    if (outOfTime && !snaps[a.iata]) { attempted--; break; }
    if (!snaps[a.iata]) errors[a.iata] = errs.join("; ");
    if (outOfTime) break;
  }
  const covered = Object.keys(snaps).length;
  return { snaps, errors, attempted, covered, next: outOfTime || attempted < n ? (first + attempted) % Math.max(1, n) : first, ms: clock() - t0, outOfTime, used, sample };
}

// ---------- one run ----------

const emptyState = () => ({ v: 1, t: null, since: null, next: 0, elev: {}, ap: {} });
const emptyBaseline = () => ({ v: 1, since: null, ap: {} });

/** Field elevation (ft): airports-all.json column if it has one → METAR elev (m) → cached → 0 ("assumed 0"). */
export function elevations(airports, { allJson = null, metars = null, cached = {} } = {}) {
  const out = {};
  let col = -1;
  const f = allJson?.f || [];
  for (const name of ["elev", "elevation", "elevation_ft", "elev_ft"]) if (f.indexOf(name) >= 0) { col = f.indexOf(name); break; }
  const fromAll = {};
  if (col >= 0) for (const r of allJson.a || []) if (r[0] && num(r[col]) != null) fromAll[r[0]] = r[col];
  const fromMetar = {};
  for (const m of Array.isArray(metars) ? metars : []) if (m && m.icaoId && num(m.elev) != null) fromMetar[m.icaoId] = Math.round(m.elev * 3.28084);
  for (const a of airports) {
    if (fromAll[a.iata] != null) out[a.iata] = [fromAll[a.iata], "airports-all"];
    else if (fromMetar[a.icao] != null) out[a.iata] = [fromMetar[a.icao], "metar"];
    else if (Array.isArray(cached[a.iata]) && cached[a.iata][1] !== "assumed 0") out[a.iata] = cached[a.iata];
    else out[a.iata] = [0, "assumed 0"];
  }
  return out;
}

/** Pressure-altitude correction per airport (ft) from METAR altimeter settings (hPa): ~27 ft per hPa off 1013.25. */
export function qnhCorrections(airports, metars) {
  const out = {};
  const byIcao = {};
  for (const m of Array.isArray(metars) ? metars : []) if (m && m.icaoId && num(m.altim) != null) byIcao[m.icaoId] = m.altim;
  for (const a of airports) {
    let h = byIcao[a.icao];
    if (h == null) continue;
    if (h < 40) h *= 33.8639; // inHg
    if (h > 900 && h < 1100) out[a.iata] = Math.round((h - 1013.25) * 27.3);
  }
  return out;
}

/**
 * Applies a collection to state + baseline. Pure apart from Intl.
 * → {movement (site/data/movement.json), state, baseline, log (history line)}
 */
export function computeMovement({ airports, col, state, baseline, bts = null, nowMs, elev, qnh = {} }) {
  const st = { ...emptyState(), ...(state || {}) };
  st.ap = { ...(st.ap || {}) };
  const base = { ...emptyBaseline(), ...(baseline || {}) };
  base.ap = { ...(base.ap || {}) };
  st.since ||= shortIso(nowMs);
  base.since ||= st.since;
  st.elev = elev;
  const daysLogged = Math.max(0, Math.floor((nowMs - Date.parse(base.since)) / DAY));
  const learnDays = Math.min(LEARN_DAYS, daysLogged);
  const logAp = {};
  const outAp = {};
  for (const a of airports) {
    const apt = { lat: a.lat, lon: a.lon, elev: elev[a.iata]?.[0] || 0, qnh: qnh[a.iata] || 0 };
    const snap = col.snaps[a.iata];
    let apState = st.ap[a.iata] ? { ...st.ap[a.iata] } : { recent: [], hrs: [] };
    let run = null;
    if (snap) {
      const r = stepAirport(apState, snap.list, apt, nowMs);
      apState = r.state;
      run = r.run;
    }
    base.ap[a.iata] = { ...(base.ap[a.iata] || {}) };
    finalizeHours(apState, base.ap[a.iata], nowMs, a.tz, HUB_AIRLINES[a.iata] || []); // airline counts kept only where that airline has a hub
    st.ap[a.iata] = apState;
    const roll = rolling(apState, nowMs);
    if (run) {
      logAp[a.iata] = { dep: run.dep, arr: run.arr, taxi: run.taxi, ground: run.ground, holding: run.holding, coverage: roll.coverage, byAirline: run.byAirline };
    }
    if (!apState.t) continue; // never seen
    const how = hourOfWeek(nowMs - 30 * MIN, a.tz);
    let bl = baselineFor(base.ap[a.iata][how], null);
    if (!bl && bts) { try { bl = baselineFor(null, bts(a.iata, how)); } catch { bl = null; } }
    const desc = describe({ depHr: roll.depHr, coverage: roll.coverage, n: roll.n, baseline: bl, learnDays });
    const acNow = unpackAc(apState.ac);
    const vals = Object.values(acNow);
    outAp[a.iata] = {
      depHr: roll.depHr, arrHr: roll.arrHr,
      taxiOut: run ? run.taxiOut : vals.filter((c) => c.s === "taxi" && !c.in).length,
      holding: run ? run.holding : vals.filter((c) => c.s === "hold").length,
      asOf: apState.t, coverage: roll.coverage, n: roll.n, raw: { dep: roll.depRaw, arr: roll.arrRaw },
      baseline: bl ? { depHr: bl.depHr, arrHr: bl.arrHr, n: bl.n, source: bl.source } : { depHr: null, arrHr: null, n: 0, source: null },
      index: desc.index, sentence: desc.sentence,
      src: snap ? snap.src : undefined, stale: !snap || undefined,
      elev: elev[a.iata]?.[1] === "assumed 0" ? "assumed 0" : undefined,
    };
  }
  const alerts = airlineAlerts(st.ap, base.ap, nowMs);
  const srcIds = Object.keys(col.used || {});
  const srcName = srcIds.map((id) => FEEDS.find((f) => f.id === id)?.name || id);
  st.t = shortIsoSec(nowMs);
  st.next = col.next;
  const errs = Object.entries(col.errors || {});
  const movement = {
    v: 1,
    generated: new Date(nowMs).toISOString(),
    run: {
      ok: col.covered >= Math.ceil(airports.length / 2), at: new Date(nowMs).toISOString(),
      airports: col.covered, of: airports.length, ms: Math.round(col.ms || 0), outOfTime: !!col.outOfTime,
      src: srcName, errors: errs.slice(0, 3).map(([k, v]) => `${k}: ${v}`), failed: errs.length,
    },
    sources: SOURCES.map(({ id, name, url, role, license, attribution }) => ({ id, name, url, role, license, attribution })),
    learning: { since: base.since, days: daysLogged, of: LEARN_DAYS },
    airports: outAp,
    airlineAlerts: alerts,
  };
  const log = compact({ t: shortIsoSec(nowMs), src: srcIds, skip: airports.filter((a) => !col.snaps[a.iata]).map((a) => a.iata), airports: logAp }) || { t: shortIsoSec(nowMs) };
  return { movement, state: st, baseline: base, log };
}

// ---------- fixtures ----------

const FIX = join(HERE, "fixtures", "movement");

/** Moves an ORD aircraft list to another airport, keeping its offsets in nm and height above the field. */
export function translateFixture(j, from, to) {
  const k1 = 60 * Math.cos(from.lat * RAD);
  const k2 = 60 * Math.cos(to.lat * RAD);
  return {
    ...j,
    ac: j.ac.map((x) => {
      if (typeof x.lat !== "number") return x;
      const dy = (x.lat - from.lat) * 60;
      const dx = (x.lon - from.lon) * k1;
      const o = { ...x, lat: Math.round((to.lat + dy / 60) * 1e5) / 1e5, lon: Math.round((to.lon + dx / k2) * 1e5) / 1e5 };
      if (typeof x.alt_baro === "number") o.alt_baro = x.alt_baro - from.elev + to.elev;
      if (typeof x.alt_geom === "number") o.alt_geom = x.alt_geom - from.elev + to.elev;
      return o;
    }),
  };
}

/**
 * Fixture run: ORD-prev.json as the snapshot 5 minutes ago, ORD-now.json now (moved to every
 * airport), and a seeded history from seed.json (11 earlier snapshots, baseline samples, airline
 * hours) so the page shows normal, below-normal (ORD), above-normal (LAS) and learning (ANC, HNL).
 */
export async function fixtureRun(airports, nowMs) {
  const seed = JSON.parse(await readFile(join(FIX, "seed.json"), "utf8"));
  const nowJ = JSON.parse(await readFile(join(FIX, "ORD-now.json"), "utf8"));
  const prevJ = JSON.parse(await readFile(join(FIX, "ORD-prev.json"), "utf8"));
  const ord = airports.find((a) => a.iata === "ORD");
  const from = { lat: ord.lat, lon: ord.lon, elev: seed.elev.ORD };
  const elev = Object.fromEntries(airports.map((a) => [a.iata, [seed.elev[a.iata] ?? 0, "fixture"]]));
  const st = emptyState();
  const base = emptyBaseline();
  st.since = base.since = shortIso(nowMs - seed.days * DAY);
  const curHour = Math.floor(nowMs / HOUR) * HOUR;
  for (const a of airports) {
    const to = { lat: a.lat, lon: a.lon, elev: elev[a.iata][0] };
    const apt = { lat: a.lat, lon: a.lon, elev: to.elev };
    const prevList = parseFeed(translateFixture(prevJ, from, to));
    const prevT = nowMs - 5 * MIN;
    const { state } = stepAirport({ recent: [], hrs: [] }, prevList, apt, prevT);
    const target = (seed.baseDep[a.iata] ?? seed.baseDep.default) * (seed.mult[a.iata] ?? 1);
    // 10 synthetic earlier snapshots + the fixture "prev" one + this run ≈ target/hr at 12/12 coverage
    const total = Math.max(0, Math.round(target) - 5);
    const synth = [];
    for (let i = 0; i < 10; i++) {
      const t = Math.floor((nowMs - (55 - 5 * i) * MIN) / 1000);
      const nd = Math.floor(total / 10) + (i < total % 10 ? 1 : 0);
      const dep = Array.from({ length: nd }, (_, j) => `f${i}${j}d`);
      const arr = Array.from({ length: nd }, (_, j) => `f${i}${j}a`);
      synth.push([t, dep, arr, {}]);
    }
    state.recent = [...synth, ...state.recent.map((r) => [r[0], [], [], {}])];
    // last two finished hours for the airline-alert fixture
    const al = (code, h) => {
      const sp = seed.airline[code];
      const b = sp?.hubs?.[a.iata];
      return b == null ? null : Math.round(b * (h ? sp.now : 1));
    };
    state.hrs = [2, 1].map((k) => {
      const ms = curHour - k * HOUR;
      const alx = {};
      for (const code of Object.keys(seed.airline)) { const v = al(code, true); if (v != null) alx[code] = v; }
      return { h: hourKey(ms), how: hourOfWeek(ms, a.tz), n: 12, cov: 1, dep: Math.round(target), arr: Math.round(target), al: alx };
    });
    state.last = hourKey(curHour - HOUR); // finished hours are already in hrs
    st.ap[a.iata] = state;
    if ((seed.learning || []).includes(a.iata)) continue;
    const b = {};
    const dep0 = seed.baseDep[a.iata] ?? seed.baseDep.default;
    for (let how = 0; how < 168; how++) {
      b[how] = [3, 2, 1].map((w) => {
        const alx = {};
        for (const code of Object.keys(seed.airline)) { const v = al(code, false); if (v != null) alx[code] = v; }
        return [dep0 + w - 2, dep0 + w - 2, alx, new Date(nowMs - w * 7 * DAY).toISOString().slice(0, 10)];
      });
    }
    base.ap[a.iata] = b;
  }
  const snaps = {};
  for (const a of airports) {
    snaps[a.iata] = { list: parseFeed(translateFixture(nowJ, from, { lat: a.lat, lon: a.lon, elev: elev[a.iata][0] })), src: "adsbfi", at: new Date(nowMs).toISOString() };
  }
  const col = { snaps, errors: {}, attempted: airports.length, covered: airports.length, next: 0, ms: 0, outOfTime: false, used: { adsbfi: airports.length }, sample: { iata: "ORD", src: "fixture", url: "fixture:ORD-now.json", body: JSON.stringify(nowJ) } };
  return { col, state: st, baseline: base, elev };
}

// ---------- files ----------

const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };
export const DEFAULT_DIR = join(ROOT, ".cache/movement");
export const DEFAULT_OUT = join(ROOT, "site/data/movement.json");

/**
 * Starts collecting right away (poll.mjs runs it next to the other sources); finish() computes and
 * writes the files. Neither throws: failures are logged and movement.json says what happened.
 */
export function startMovement({ fixtures = false, dir = DEFAULT_DIR, out = DEFAULT_OUT, now = new Date(), log = console.log } = {}) {
  const nowMs = +now;
  const started = (async () => {
    const airports = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
    if (fixtures) return { airports, ...(await fixtureRun(airports, nowMs)) };
    const state = await readJson(join(dir, "state.json"));
    const baseline = await readJson(join(dir, "baseline.json"));
    const col = await collect({ airports, start: state?.next || 0 });
    return { airports, col, state, baseline };
  })().catch((e) => ({ error: e }));

  const finish = async ({ metars = null } = {}) => {
    try {
      const s = await started;
      if (s.error) throw s.error;
      const allJson = await readJson(join(ROOT, "site/data/airports-all.json"));
      const elev = s.elev || elevations(s.airports, { allJson, metars, cached: s.state?.elev || {} });
      const bts = await loadBts();
      const qnh = s.elev ? {} : qnhCorrections(s.airports, metars);
      const r = computeMovement({ airports: s.airports, col: s.col, state: s.state, baseline: s.baseline, bts, nowMs, elev, qnh });
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(r.movement) + "\n");
      const od = join(dir, "out");
      await mkdir(od, { recursive: true });
      await writeFile(join(od, "state.json"), JSON.stringify(r.state) + "\n");
      await writeFile(join(od, "baseline.json"), JSON.stringify(r.baseline) + "\n");
      await writeFile(join(od, "log.json"), JSON.stringify(r.log) + "\n");
      if (s.col.sample) await writeFile(join(od, "sample.json"), JSON.stringify({ t: r.movement.generated, ...s.col.sample }) + "\n");
      const m = r.movement;
      const assumed = Object.entries(elev).filter(([, v]) => v[1] === "assumed 0").map(([k]) => k);
      log(`${m.run.ok ? "ok  " : "FAIL"} movement: ${m.run.airports}/${m.run.of} airports from ${m.run.src.join("+") || "no feed"} in ${(m.run.ms / 1000).toFixed(1)} s${m.run.outOfTime ? " (time budget hit; rotating)" : ""}${m.run.failed ? `, ${m.run.failed} failed: ${m.run.errors[0]}` : ""}${assumed.length ? `; field elevation assumed 0 ft for ${assumed.join(",")}` : ""}${m.airlineAlerts.length ? `; ${m.airlineAlerts.length} airline alert(s)` : ""}`);
      return { ok: m.run.ok, movement: m };
    } catch (e) {
      log(`FAIL movement: ${e && e.message ? e.message : e}`);
      try {
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, JSON.stringify({ v: 1, generated: now.toISOString(), run: { ok: false, at: now.toISOString(), airports: 0, of: 0, errors: [String(e && e.message ? e.message : e)] }, sources: SOURCES.map(({ id, name, url, role }) => ({ id, name, url, role })), airports: {}, airlineAlerts: [] }) + "\n");
      } catch { /* nothing else to do */ }
      return { ok: false, error: e };
    }
  };
  return { finish };
}

export const HISTORY_MOVEMENT_README = `# movement/ — ADS-B traffic counts (poller/movement.mjs)

- \`state.json\`: last snapshot per airport (aircraft as [state, nm, alt ft, track, gs kt, landed flag, lat, lon, airline]),
  the last ~2 h of per-run counts (\`recent\`: [unix s, new departure hexes, new arrival hexes, departures by airline]),
  the last 3 finished hours (\`hrs\`), rotation start (\`next\`) and field elevations (\`elev\`: [ft, source]).
- \`baseline.json\`: per airport and hour of week (local, 0 = Sunday 00): up to ${KEEP_SAMPLES} finished hours as
  [departures/hr, arrivals/hr, {airline: departures/hr}, date], from hours with at least ${MIN_SAMPLE_COV * 100}% coverage.
- \`YYYY/MM/DD.jsonl\`: one line per run (UTC): {t, src, skip?, airports: {IATA: {dep, arr, taxi, ground, holding, coverage, byAirline}}}.
  dep/arr = departures/arrivals first counted in that run (summing an hour's lines gives its raw count);
  coverage = snapshots in the last hour / ${EXPECTED_PER_HOUR}.
- \`sample.json\`: one raw feed response (first 60 KB), refreshed once per UTC hour, for format checks.

Aircraft data: adsb.fi (https://adsb.fi; personal, non-commercial use), fallback ADSB.lol (ODbL 1.0, © ADSB.lol contributors).
`;

/** Copies .cache/movement/out into <dir>/movement/. */
export async function recordMovement(dir, from = join(DEFAULT_DIR, "out")) {
  const st = await readFile(join(from, "state.json"), "utf8").catch(() => null);
  const line = await readJson(join(from, "log.json"));
  if (!st || !line) return { skipped: "no movement output from this run" };
  const md = join(dir, "movement");
  await mkdir(md, { recursive: true });
  await writeFile(join(md, "state.json"), st);
  const bl = await readFile(join(from, "baseline.json"), "utf8").catch(() => null);
  if (bl) await writeFile(join(md, "baseline.json"), bl);
  const readme = join(md, "README.md");
  if (!(await readFile(readme, "utf8").catch(() => ""))) await writeFile(readme, HISTORY_MOVEMENT_README);
  const t = Date.parse(line.t);
  const d = new Date(t);
  const p2 = (x) => String(x).padStart(2, "0");
  const file = join(md, String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), `${p2(d.getUTCDate())}.jsonl`);
  const prev = await readFile(file, "utf8").catch(() => "");
  let appended = false;
  if (!prev.includes(`{"t":"${line.t}"`)) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(line) + "\n");
    appended = true;
  }
  let sample = "kept";
  const smp = await readJson(join(from, "sample.json"));
  const old = await readJson(join(md, "sample.json"));
  if (smp && (!old || String(old.t).slice(0, 13) !== String(smp.t).slice(0, 13))) {
    await writeFile(join(md, "sample.json"), JSON.stringify(smp) + "\n");
    sample = "written";
  }
  return { file, appended, sample };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (args[0] === "record") {
    if (!args[1]) { console.error("usage: node poller/movement.mjs record <historyDir> [--from dir]"); process.exit(2); }
    const r = await recordMovement(resolve(args[1]), opt("--from") ? resolve(opt("--from")) : undefined);
    console.log("movement record: " + JSON.stringify(r));
    return;
  }
  const dir = opt("--state") ? resolve(opt("--state")) : DEFAULT_DIR;
  const out = opt("--out") ? resolve(opt("--out")) : DEFAULT_OUT;
  const r = await startMovement({ fixtures: args.includes("--fixtures"), dir, out }).finish();
  console.log(`wrote ${out}`);
  if (!r.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
