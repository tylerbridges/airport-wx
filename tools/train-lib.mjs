// Pure helpers for the delay model (tools/train-data.mjs, tools/train.mjs): BTS departure and
// arrival truth per airport-hour, training records from replayed TAFs/METARs, regularised logistic
// regression (IRLS), isotonic calibration, verification metrics, analogs, program rates from the
// history log and the safety gate. No I/O; unit-tested in tools/train.test.mjs.
import { findCol, parseTime, localToUtc } from "./backtest-lib.mjs";
import {
  BUCKETS, DEF, HUBS, PX, encode, tafSummary, condSummary, hubPack, cascadeOf, localParts, analogKeys, ANALOG_MIN, logit, sigmoid, calibrate, seasonOf,
  programState, lampCat, hourOfWeek,
} from "../poller/delay.mjs";
import { TOP_ROUTES } from "../poller/hubs.mjs";

export const HOUR = 3600e3;
const MAX_LEAD_H = 30;
const PERSIST_MAX_AGE = 3 * HOUR;

const num = (x) => {
  const s = String(x ?? "").trim();
  if (!s || s === "M" || s === "T") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
export function median(arr) {
  if (!arr.length) return null;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function quantile(arr, q) {
  if (!arr.length) return null;
  const a = Float64Array.from(arr).sort();
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[i];
}

// ---------- BTS: departures and arrivals per local hour ----------

export const BTS_REQUIRED = ["flightdate", "origin", "dest", "crsdeptime", "crsarrtime", "depdelay", "arrdelay", "cancelled", "cancellationcode", "weatherdelay", "nasdelay"];
export function btsIndex2(header) {
  const idx = {};
  for (const c of [...BTS_REQUIRED, "diverted", "crselapsedtime"]) idx[c] = findCol(header, [c]);
  return { idx, missing: BTS_REQUIRED.filter((c) => idx[c] < 0) };
}

function btsDate(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
const nextDate = (d) => new Date(Date.parse(d + "T00:00:00Z") + 24 * HOUR).toISOString().slice(0, 10);

const departureHours = new Map();
const arrivalDates = new Map();
const dateFormatters = new Map();
/** Resolve the arrival's local date from its schedule, not a comparison of clocks in different zones. */
export function scheduledArrivalDate(date, dep, arr, elapsed, originZone, destZone) {
  if (!originZone || !destZone || !Number.isInteger(dep) || !Number.isInteger(arr) || dep < 0 || arr < 0) return null;
  const depHour = Math.floor(dep / 100), depMin = dep % 100;
  const arrHour = Math.floor(arr / 100), arrMin = arr % 100;
  if (depHour > 24 || arrHour > 24 || depMin > 59 || arrMin > 59 || depHour === 24 && depMin || arrHour === 24 && arrMin) return null;
  const key = `${originZone}|${date}|${depHour}`;
  let start = departureHours.get(key);
  if (start == null) {
    start = localToUtc(date, depHour, originZone);
    if (departureHours.size > 20000) departureHours.clear();
    departureHours.set(key, start);
  }
  start += depMin * 60000;
  if (elapsed != null && elapsed > 0 && elapsed <= 24 * 60) {
    const end = start + elapsed * 60000;
    // US BTS airport zones have whole-hour offsets; cache by UTC hour, including DST transitions.
    const dk = `${destZone}|${Math.floor(end / HOUR)}`;
    let day = arrivalDates.get(dk);
    if (!day) {
      let fmt = dateFormatters.get(destZone);
      if (!fmt) { fmt = new Intl.DateTimeFormat("en-US", { timeZone: destZone, year: "numeric", month: "2-digit", day: "2-digit" }); dateFormatters.set(destZone, fmt); }
      const p = Object.fromEntries(fmt.formatToParts(end).map(x => [x.type, x.value]));
      day = `${p.year}-${p.month}-${p.day}`;
      if (arrivalDates.size > 20000) arrivalDates.clear();
      arrivalDates.set(dk, day);
    }
    return day;
  }
  // Legacy/synthetic rows without elapsed time: find the next scheduled destination-local time.
  for (let offset = -1; offset <= 2; offset++) {
    const day = new Date(Date.parse(date + "T00:00:00Z") + offset * 24 * HOUR).toISOString().slice(0, 10);
    const end = localToUtc(day, arrHour, destZone) + arrMin * 60000;
    if (end > start && end - start <= 24 * HOUR) return arrHour === 24 ? nextDate(day) : day;
  }
  return null;
}

/** Side accumulator: [n, late15, late15WxNas, cancelledWxNas, sumDelay(>=0), operated, [late minutes]]. */
const newSide = () => [0, 0, 0, 0, 0, 0, []];
function addSide(s, { cancelled, code, delay, wx, nas, diverted }) {
  s[0]++;
  if (cancelled) { if (code === "B" || code === "C") s[3]++; return; }
  if (diverted || delay == null) return;
  s[5]++;
  s[4] += Math.max(0, delay);
  if (delay >= DEF.lateMin) {
    s[1]++;
    s[6].push(Math.round(delay));
    if ((wx ?? 0) > 0 || (nas ?? 0) > 0) s[2]++;
  }
}

/**
 * One BTS row into acc (Map "IATA|YYYY-MM-DD|localHour" -> {d: side|undefined, a: side|undefined}):
 * the departure at Origin by CRSDepTime and the arrival at Dest by CRSArrTime (next day when the
 * schedule's elapsed time and both airport time zones). Returns the number of sides kept.
 */
export function btsAdd2(acc, row, idx, wanted, zones = null) {
  const origin = String(row[idx.origin] ?? "").trim();
  const dest = String(row[idx.dest] ?? "").trim();
  const wo = wanted.has(origin);
  const wd = wanted.has(dest);
  if (!wo && !wd) return 0;
  const date = btsDate(row[idx.flightdate]);
  const dep = num(row[idx.crsdeptime]);
  if (!date || dep == null) return 0;
  const cancelled = (num(row[idx.cancelled]) ?? 0) >= 1;
  const code = String(row[idx.cancellationcode] ?? "").trim().toUpperCase();
  const wx = num(row[idx.weatherdelay]);
  const nas = num(row[idx.nasdelay]);
  const diverted = idx.diverted >= 0 && (num(row[idx.diverted]) ?? 0) >= 1;
  let kept = 0;
  const put = (key, side, f) => {
    let e = acc.get(key);
    if (!e) { e = {}; acc.set(key, e); }
    if (!e[side]) e[side] = newSide();
    addSide(e[side], f);
    kept++;
  };
  if (wo) put(`${origin}|${dep === 2400 ? nextDate(date) : date}|${Math.min(23, Math.floor(dep / 100) % 24)}`, "d", { cancelled, code, delay: num(row[idx.depdelay]), wx, nas, diverted: false });
  const arr = num(row[idx.crsarrtime]);
  if (wd && arr != null) {
    const aDate = zones ? scheduledArrivalDate(date, dep, arr, num(row[idx.crselapsedtime]), zones[origin], zones[dest]) : arr < dep ? nextDate(date) : date;
    // An unknown origin time zone cannot supply a trustworthy arrival date.
    if (aDate) put(`${dest}|${aDate}|${Math.floor(arr / 100) % 24}`, "a", { cancelled, code, delay: num(row[idx.arrdelay]), wx, nas, diverted });
  }
  return kept;
}

const mergeSide = (a, b) => (!a ? b : !b ? a : [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6].concat(b[6])]);
/** Merge month accumulators (serialised as [[key, d, a], ...]) into one Map. */
export function mergeAcc(into, entries) {
  for (const [k, d, a] of entries) {
    const e = into.get(k) || {};
    e.d = mergeSide(e.d, d || undefined);
    e.a = mergeSide(e.a, a || undefined);
    into.set(k, e);
  }
  return into;
}
export const accEntries = (acc) => [...acc].map(([k, e]) => [k, e.d || null, e.a || null]);

function sideStats(s) {
  if (!s || !s[0]) return null;
  const [n, l15, l15c, cx, sum, ops, mins] = s;
  return { n, late: l15 / n, lateWx: l15c / n, cx: cx / n, mean: ops ? sum / ops : null, med: median(mins), p90: quantile(mins, 0.9) };
}

/** Real-delay test for one side (null when it has < DEF.minFlights flights). */
export function sideReal(st) {
  if (!st || st.n < DEF.minFlights) return null;
  return st.lateWx >= DEF.delayShare || st.cx >= DEF.cxlShare;
}

/**
 * acc -> Map "IATA|utcHourMs" -> {dep, arr, y, md, dm, cx, n}: side stats (n, share late 15+, share late
 * 15+ with weather/NAS cause, weather/NAS cancellation share, mean delay, median and 90th percentile
 * delay of late flights); y = real delay hour (README); md = mean departure delay (arrivals when no
 * departures operated); dm = median late minutes (departures when they count, else arrivals);
 * cx = weather/NAS cancellation share over both sides. Hours where neither side has 5 flights are left out.
 */
export function truthFromAcc(acc, tzByIata) {
  const utc = new Map();
  for (const [key, e] of acc) {
    const [iata, date, hour] = key.split("|");
    const tz = tzByIata[iata];
    if (!tz) continue;
    const k = `${iata}|${localToUtc(date, Number(hour), tz)}`;
    const prev = utc.get(k);
    utc.set(k, prev ? { d: mergeSide(prev.d, e.d), a: mergeSide(prev.a, e.a) } : { d: e.d, a: e.a }); // DST fall-back hour seen twice
  }
  const out = new Map();
  for (const [k, e] of utc) {
    const dep = sideStats(e.d);
    const arr = sideStats(e.a);
    const rd = sideReal(dep);
    const ra = sideReal(arr);
    if (rd == null && ra == null) continue;
    const n = (dep?.n || 0) + (arr?.n || 0);
    const cxN = (e.d ? e.d[3] : 0) + (e.a ? e.a[3] : 0);
    out.set(k, {
      dep, arr, y: rd || ra ? 1 : 0, n, cx: n ? cxN / n : 0,
      md: dep?.mean ?? arr?.mean ?? null,
      dm: (dep && dep.n >= DEF.minFlights ? dep.med : null) ?? arr?.med ?? dep?.med ?? null,
    });
  }
  return out;
}

// ---------- training records ----------

function lastAtOrBefore(arr, t, key) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** For bucket b and verifying hour H: index of the latest TAF issued at or before H - lo (within 30 h), else -1. */
export function tafFor(tafs, H, b) {
  const ti = lastAtOrBefore(tafs, H - b.lo * HOUR, "issueMs");
  if (ti < 0) return -1;
  const t = tafs[ti];
  if (t.cancelled || t.nil || (H - t.issueMs) / HOUR > MAX_LEAD_H) return -1;
  return ti;
}

/**
 * Top connecting hubs per airport for the hub-cascade features (feature family "hubs"): the first
 * CASCADE_HUBS of the shared table poller/hubs.mjs TOP_ROUTES (busiest hub connections, same-TRACON hubs
 * left out). Stored in model.json (`hubs`, only hubs that are training airports) so the live scorer asks
 * for the same hubs.
 */
export const CASCADE_HUBS = 3;
export const TOP_HUBS = Object.fromEntries(Object.entries(TOP_ROUTES).map(([ap, list]) => [ap, list.slice(0, CASCADE_HUBS)]));

/** Hub TAF state per verifying hour and bucket: Map H -> [4 x packed (hubBits | level << 8) | null]. */
export function hubBitsMap(tafs, hoursList) {
  const m = new Map();
  for (const H of hoursList) {
    const row = BUCKETS.map((b) => {
      const ti = tafFor(tafs, H, b);
      return ti < 0 ? null : hubPack(tafSummary(tafs[ti], H, null));
    });
    if (row.some((x) => x != null)) m.set(H, row);
  }
  return m;
}

/**
 * Training records for one airport: one per verifying hour with BTS truth, holding the features for
 * each lead bucket (f[i] for BUCKETS[i]: {w, o, h, lp, cp, lc, lv, hc?} or null when no TAF applies).
 * truth: Map H -> truth row; hubMaps: [Map H -> [4 packed]] (HUBS); cascadeMaps: [Map | null] for the
 * top hubs (null = not built; then f has no hc); lampFn(H, predMs) -> {lp, cp, lc, lv} | null.
 */
export function airportRecords({ iata, tz, tafs, obs, truth, hubMaps = [], cascadeMaps = null, start, end, rwys = null, lampFn = null }) {
  const out = [];
  const sumCache = new Map();
  const obsCache = new Map();
  const Hs = [...truth.keys()].filter((H) => H >= start && H < end).sort((a, b) => a - b);
  for (const H of Hs) {
    const tr = truth.get(H);
    const lp = localParts(H, tz);
    const f = BUCKETS.map((b, bi) => {
      const ti = tafFor(tafs, H, b);
      const pred = H - b.lo * HOUR;
      let w = null;
      if (ti >= 0) {
        const k = ti + "|" + H;
        if (!sumCache.has(k)) sumCache.set(k, tafSummary(tafs[ti], H, rwys));
        w = sumCache.get(k);
      }
      const oi = lastAtOrBefore(obs, pred, "t");
      let o = null;
      if (oi >= 0 && pred - obs[oi].t <= PERSIST_MAX_AGE) {
        if (!obsCache.has(oi)) obsCache.set(oi, condSummary(obs[oi].cond, rwys));
        o = obsCache.get(oi);
      }
      let h = null;
      for (const m of hubMaps) { const x = m.get(H)?.[bi]; if (x != null) h = (h ?? 0) | (x & 63); }
      if (!w && !o) return null;
      const L = lampFn ? lampFn(H, pred) : null;
      const out = { w, o, h, lp: L?.lp ?? null, cp: L?.cp ?? null };
      if (L?.lc != null) out.lc = L.lc;
      if (L?.lv != null) out.lv = L.lv;
      if (cascadeMaps) out.hc = cascadeOf(cascadeMaps.map((m) => m?.get(H)?.[bi] ?? null));
      return out;
    });
    if (f.every((x) => x == null)) continue;
    out.push({
      a: iata, H, lh: lp.h, dw: lp.dw, mo: lp.mo, d: lp.d, ym: `${lp.y}-${String(lp.mo).padStart(2, "0")}`,
      y: tr.y, md: tr.md == null ? null : Math.round(tr.md * 10) / 10, dm: tr.dm, cx: Math.round(tr.cx * 1000) / 1000, n: tr.n, f,
    });
  }
  return out;
}

// ---------- IEM LAMP archive (optional; real midnight/06Z CSV fixtures) ----------

/** Case-insensitive column lookup over several candidate names, after trimming and dropping quotes/units. */
function lampCol(h, names) {
  const norm = h.map((x) => String(x ?? "").trim().toLowerCase().replace(/^"|"$/g, "").replace(/\s*\(.*\)$/, ""));
  for (const n of names) { const i = norm.indexOf(n); if (i >= 0) return i; }
  return -1;
}

/**
 * IEM mos.py CSV (model=LAV) -> Map ftimeMs -> [{run, lp, cp, lc, lv}] sorted by run. The format is
 * verified against real midnight/06Z samples; columns are found by name, case-insensitively: run time (runtime, run, model_runtime),
 * valid time (ftime, valid, fcst_time), thunder/lightning chance (lp1, ltg1, ltg, lp2, tp1, tstm1, tsd),
 * convection chance (cp1, cnv1, cp2), ceiling category (cig, ceiling) and visibility category (vis).
 * LAMP's ceiling/visibility *probabilities* aren't in the text bulletin the live poller reads, so only the
 * categories are used (the live scorer can supply the same). Returns {byTime, diag (header, columns, rows)}.
 */
export function lampFromIemCsv(rows) {
  const h = rows[0] || [];
  const c = {
    run: lampCol(h, ["runtime", "run", "model_runtime", "runtime_utc"]), ft: lampCol(h, ["ftime", "valid", "fcst_time", "ftime_utc"]),
    lp: lampCol(h, ["lp1", "ltg1", "ltg", "lp2", "tp1", "tstm1", "tsd"]), cp: lampCol(h, ["cp1", "cnv1", "cp2"]),
    lc: lampCol(h, ["cig", "ceiling", "cig_cat"]), lv: lampCol(h, ["vis", "visibility", "vis_cat"]),
  };
  const diag = { header: h, columns: c, rows: Math.max(0, rows.length - 1), used: 0, firstRow: rows[1] || null };
  const byTime = new Map();
  if (c.run < 0 || c.ft < 0 || (c.lp < 0 && c.cp < 0 && c.lc < 0 && c.lv < 0)) return { byTime, diag };
  const pct = (v) => (v == null || v < 0 || v > 100 ? null : v);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const run = parseTime(row[c.run]);
    const ft = parseTime(row[c.ft]);
    if (run == null || ft == null) continue;
    const lp = c.lp >= 0 ? pct(num(row[c.lp])) : null;
    const cp = c.cp >= 0 ? pct(num(row[c.cp])) : null;
    const lc = c.lc >= 0 ? lampCat(row[c.lc], 8) : null;
    const lv = c.lv >= 0 ? lampCat(row[c.lv], 7) : null;
    if (lp == null && cp == null && lc == null && lv == null) continue;
    if (!byTime.has(ft)) byTime.set(ft, []);
    byTime.get(ft).push({ run, lp, cp, lc, lv });
    diag.used++;
  }
  for (const v of byTime.values()) v.sort((a, b) => a.run - b.run);
  return { byTime, diag };
}
/** IEM drops LAV's :30 issuance minutes; restore them before causal selection.
 * Actual receipt times aren't archived. Six-hour archive cycles cannot represent hourly live freshness.
 */
export const LAMP_ARCHIVE_TIMING = Object.freeze({ issueOffsetMs: 30 * 60e3, maxAgeMs: 6 * HOUR });
/** LP1/CP1 and categories for hour H, from the latest issued, non-expired archived cycle. */
export function lampLookup(byTime, H, pred, timing = LAMP_ARCHIVE_TIMING) {
  const list = byTime.get(H + HOUR);
  if (!list) return null;
  let best = null;
  for (const x of list) {
    const issued = x.run + timing.issueOffsetMs;
    if (issued <= pred && pred - issued <= timing.maxAgeMs) best = x;
  }
  return best ? { lp: best.lp, cp: best.cp, lc: best.lc ?? null, lv: best.lv ?? null } : null;
}

// ---------- FAA program state from the history log (feature family "programs") ----------

/**
 * Index of the history branch's truth/*.jsonl lines (any order) for program features:
 * at(iata, atMs, H) -> programState(...) as known at atMs for the hour starting H, or null when there is no
 * record (no poll line within maxGap before atMs, or the FAA status source was down on it). Ops-plan items
 * are carried forward from the last line that had a plan (a plan is written only when it changes), for at
 * most planMaxAge. coverage: {from, to, lines}.
 */
export function programIndex(lines, { maxGap = 30 * 60e3, planMaxAge = 24 * HOUR } = {}) {
  const polls = [];
  const plans = [];
  for (const L of lines || []) {
    const t = Date.parse(L?.t);
    if (!Number.isFinite(t)) continue;
    const down = Array.isArray(L.down) && L.down.includes("faa");
    const ap = {};
    let hasPlan = !!L.opsplan?.plan;
    for (const [k, x] of Object.entries(L.airports || {})) {
      if (x?.faa?.length || x?.atcscc?.length) ap[k] = { faa: x.faa || [], atcscc: x.atcscc || [] };
      if (x?.opsplan) hasPlan = true;
    }
    polls.push({ t, down, ap });
    if (hasPlan) plans.push({ t, ap: Object.fromEntries(Object.entries(L.airports || {}).filter(([, x]) => x?.opsplan).map(([k, x]) => [k, x.opsplan])) });
  }
  polls.sort((a, b) => a.t - b.t);
  plans.sort((a, b) => a.t - b.t);
  const last = (arr, t) => { let lo = 0; let hi = arr.length - 1; let ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  const at = (iata, atMs, H) => {
    const i = last(polls, atMs);
    if (i < 0 || atMs - polls[i].t > maxGap || polls[i].down) return null;
    const x = polls[i].ap[iata] || {};
    const j = last(plans, atMs);
    const opsplan = j >= 0 && atMs - plans[j].t <= planMaxAge ? plans[j].ap[iata] || null : null;
    return programState({ faa: x.faa, atcscc: x.atcscc, opsplan }, H, atMs);
  };
  return { at, coverage: { from: polls.length ? new Date(polls[0].t).toISOString() : null, to: polls.length ? new Date(polls[polls.length - 1].t).toISOString() : null, lines: polls.length } };
}

// ---------- FAA program rates from the history log ----------

/**
 * How often an ops-plan "possible" ground stop / GDP turned into a real one at that airport.
 * lines: parsed truth/*.jsonl objects in time order ({t, airports: {IATA: {faa, atcscc, opsplan}}}).
 * -> {GS: {n, k, rate}, GDP: {...}, "GS/GDP": {...}}; rate null with fewer than 5 cases.
 */
export function programRates(lines, { minN = 5, defaultHours = 6 } = {}) {
  const events = new Map();
  const seen = [];
  for (const L of lines) {
    const t = Date.parse(L.t);
    if (!Number.isFinite(t)) continue;
    for (const [ap, x] of Object.entries(L.airports || {})) {
      for (const p of x.opsplan?.programs || []) {
        if (p.status !== "possible" || !["GS", "GDP", "GS/GDP"].includes(p.program)) continue;
        const until = Date.parse(p.until);
        const to = Number.isFinite(until) ? until : t + defaultHours * HOUR;
        const key = `${ap}|${p.program}|${to}`;
        if (!events.has(key)) events.set(key, { ap, program: p.program, from: t, to });
      }
      const gs = (x.faa || []).some((f) => f.type === "ground_stop") || (x.atcscc || []).some((a) => a.active && a.type === "GS");
      const gdp = (x.faa || []).some((f) => f.type === "ground_delay") || (x.atcscc || []).some((a) => a.active && a.type === "GDP");
      if (gs || gdp) seen.push({ ap, t, gs, gdp });
    }
  }
  const out = {};
  for (const prog of ["GS", "GDP", "GS/GDP"]) {
    let n = 0;
    let k = 0;
    for (const e of events.values()) {
      if (e.program !== prog) continue;
      n++;
      if (seen.some((s) => s.ap === e.ap && s.t >= e.from && s.t <= e.to && (prog === "GS" ? s.gs : prog === "GDP" ? s.gdp : s.gs || s.gdp))) k++;
    }
    out[prog] = { n, k, rate: n >= minN ? Math.round((k / n) * 1000) / 1000 : null };
  }
  return out;
}

// ---------- time split ----------

const isWinter = (ym) => [12, 1, 2].includes(Number(ym.slice(5, 7)));
/**
 * Strict time split over sorted months: test = the newest `testCount` months; when none of them is a
 * winter month (Dec-Feb) the test block reaches back to the newest winter month, up to `maxTest` months.
 */
export function timeSplit(months, { testCount = 4, maxTest = 8 } = {}) {
  const ms = [...new Set(months)].sort();
  let n = Math.min(testCount, Math.max(1, ms.length - 3));
  let test = ms.slice(ms.length - n);
  if (!test.some(isWinter)) {
    for (let k = n + 1; k <= Math.min(maxTest, ms.length - 3); k++) {
      const t = ms.slice(ms.length - k);
      if (t.some(isWinter)) { test = t; n = k; break; }
    }
  }
  return { train: ms.slice(0, ms.length - test.length), test, winterInTest: test.some(isWinter) };
}

/**
 * Calibration block: the last `n` training months (the months just before the test period). The model
 * fitted on the earlier training months predicts them and the isotonic calibration is fitted there.
 * Needs >= 2 earlier months; with fewer training months the block shrinks (never below one month).
 */
export function validationBlock(trainMonths, n = 2) {
  const ms = [...trainMonths].sort();
  const k = Math.max(0, Math.min(n, ms.length - 2));
  return { fit: ms.slice(0, ms.length - k), val: ms.slice(ms.length - k) };
}

// ---------- schedule volume (feature family "volume") ----------

/**
 * Scheduled flights (departures + arrivals, incl. cancelled) per airport x local hour of week, from records
 * (r.n) of the given months: {IATA: {med: [168 medians|null], q: "168 digits", f: [12 month factors]}}.
 * q = how busy the hour usually is relative to the airport's busiest hour of the week (0 under 40%,
 * 1 under 60%, 2 under 80%, 3 = peak banks); f = the month's median of (scheduled / usual for the hour).
 */
export function volumeTable(records, monthSet) {
  const acc = new Map();
  for (const r of records) {
    if (!monthSet.has(r.ym) || !(r.n > 0)) continue;
    let a = acc.get(r.a);
    if (!a) { a = { how: Array.from({ length: 168 }, () => []), rows: [] }; acc.set(r.a, a); }
    a.how[hourOfWeek(r.dw, r.lh)].push(r.n);
    a.rows.push(r);
  }
  const out = {};
  for (const [ap, a] of acc) {
    const med = a.how.map((v) => (v.length >= 3 ? median(v) : null));
    const peak = Math.max(0, ...med.filter((x) => x != null));
    const q = med.map((m) => (m == null || !peak ? 0 : m / peak < 0.4 ? 0 : m / peak < 0.6 ? 1 : m / peak < 0.8 ? 2 : 3)).join("");
    const byMo = Array.from({ length: 12 }, () => []);
    for (const r of a.rows) { const m = med[hourOfWeek(r.dw, r.lh)]; if (m) byMo[r.mo - 1].push(r.n / m); }
    const f = byMo.map((v) => (v.length >= 20 ? Math.round(median(v) * 100) / 100 : 1));
    out[ap] = { med, q, f };
  }
  return out;
}
/**
 * Volume inputs for a record: {vq, vr}. actual = true: this hour's scheduled flights vs the usual for the
 * hour of week (training); false: the month factor, which is all the live scorer knows (test and live).
 */
export function volumeFor(table, r, { actual = true } = {}) {
  const v = table?.[r.a];
  if (!v) return { vq: null, vr: null };
  const how = hourOfWeek(r.dw, r.lh);
  const m = v.med[how];
  return { vq: Number(v.q[how]), vr: actual ? (m && r.n > 0 ? r.n / m : null) : v.f[r.mo - 1] ?? null };
}

/** Feature family of a feature name (null = a base feature). */
export function familyOf(name) {
  if (/^(lp|cp|lcig|lvis):/.test(name)) return "lamp";
  if (name.startsWith("pg:")) return "programs";
  if (name.startsWith("hc:")) return "hubs";
  if (name.startsWith("day:")) return "daytype";
  if (/^(vol|volr):/.test(name)) return "volume";
  return null;
}

// ---------- design matrix ----------

/** encode() input for record r, bucket bi (plus training-time extras from aug). */
export function featInput(r, bi, aug = null) {
  const f = r.f[bi];
  const o = { ap: r.a, lh: r.lh, dw: r.dw, mo: r.mo, y: Number(String(r.ym).slice(0, 4)), d: r.d, ...f };
  return aug ? Object.assign(o, aug(r, bi)) : o;
}

class Grow {
  constructor(T, n = 1024) { this.T = T; this.a = new T(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  done() { return this.a.subarray(0, this.n); }
}

/**
 * Records -> rows (one per record x bucket with features): {rec, b, lvl, off, idx} typed arrays plus
 * the vocabulary (name -> column). lvl = TAF rule level (5 = no TAF). feats: encode() options (FEATS);
 * aug(record, bucketIndex) -> extra encode inputs computed at training time (pg, vq, vr).
 */
export function buildRows(records, feats = {}, aug = null) {
  const vocab = new Map();
  const rec = new Grow(Uint32Array);
  const bk = new Grow(Uint8Array);
  const lvl = new Grow(Uint8Array);
  const off = new Grow(Uint32Array);
  const idx = new Grow(Uint16Array, 1 << 16);
  off.push(0);
  records.forEach((r, ri) => {
    r.f.forEach((f, bi) => {
      if (!f) return;
      const names = encode(featInput(r, bi, aug), BUCKETS[bi].key, feats);
      for (const nm of names) {
        let j = vocab.get(nm);
        if (j == null) { j = vocab.size; if (j >= 65535) throw new Error("vocabulary too large"); vocab.set(nm, j); }
        idx.push(j);
      }
      rec.push(ri);
      bk.push(bi);
      lvl.push(f.w ? f.w.l : 5);
      off.push(idx.n);
    });
  });
  return { rec: rec.done(), b: bk.done(), lvl: lvl.done(), off: off.done(), idx: idx.done(), vocab, n: rec.n };
}

// ---------- logistic regression (IRLS / Newton with L2) ----------

function cholSolve(A, b, n) {
  // A (n x n, row-major, symmetric positive definite) -> x with A x = b. A is overwritten.
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j];
    for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k];
    if (s <= 1e-12) s = 1e-12;
    const d = Math.sqrt(s);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = A[i * n + j];
      for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let t = b[i]; for (let k = 0; k < i; k++) t -= A[i * n + k] * y[k]; y[i] = t / A[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let t = y[i]; for (let k = i + 1; k < n; k++) t -= A[k * n + i] * x[k]; x[i] = t / A[i * n + i]; }
  return x;
}

/**
 * Penalised logistic regression by Newton/IRLS. X: {off, idx} sparse binary rows, xc: optional
 * continuous column (Float32Array/Float64Array), y: 0/1, rows: Uint32Array subset, V: columns,
 * mask: Uint8Array (1 = column used). Parameters: [intercept, continuous, w_0..w_{V-1}];
 * intercept and the continuous term are unpenalised, every w gets lambda (airport columns shrink
 * toward the global intercept). Returns {b0, wc, w: Float64Array, iters, ll}.
 */
export function fitLogistic({ off, idx, xc = null, y, rows, V, mask = null, lambda = 1, maxIter = 30, tol = 1e-6, init = null }) {
  const P = V + 2;
  const beta = init ? Float64Array.from(init) : new Float64Array(P);
  const used = (j) => !mask || mask[j];
  const loglik = (bt) => {
    let ll = 0;
    for (let q = 0; q < rows.length; q++) {
      const r = rows[q];
      let z = bt[0] + (xc ? bt[1] * xc[r] : 0);
      for (let e = off[r]; e < off[r + 1]; e++) { const j = idx[e]; if (used(j)) z += bt[2 + j]; }
      ll += y[r] ? -Math.log1p(Math.exp(-z)) : -Math.log1p(Math.exp(z));
    }
    let pen = 0;
    for (let j = 0; j < V; j++) pen += bt[2 + j] * bt[2 + j];
    return ll - 0.5 * lambda * pen;
  };
  let ll = loglik(beta);
  let it = 0;
  const cols = new Int32Array(64);
  for (; it < maxIter; it++) {
    const H = new Float64Array(P * P);
    const g = new Float64Array(P);
    for (let q = 0; q < rows.length; q++) {
      const r = rows[q];
      let m = 0;
      cols[m++] = 0;
      if (xc) cols[m++] = 1;
      let z = beta[0] + (xc ? beta[1] * xc[r] : 0);
      for (let e = off[r]; e < off[r + 1]; e++) { const j = idx[e]; if (!used(j)) continue; z += beta[2 + j]; cols[m++] = 2 + j; }
      const p = 1 / (1 + Math.exp(-z));
      const wt = p * (1 - p);
      const res = y[r] - p;
      const xv = xc ? xc[r] : 0;
      for (let a = 0; a < m; a++) {
        const ca = cols[a];
        const va = ca === 1 ? xv : 1;
        g[ca] += res * va;
        const wa = wt * va;
        const rowBase = ca * P;
        for (let c = a; c < m; c++) { const cb = cols[c]; H[rowBase + cb] += cb === 1 ? wa * xv : wa; }
      }
    }
    for (let a = 0; a < P; a++) for (let c = a + 1; c < P; c++) { const v = H[a * P + c] + H[c * P + a]; H[a * P + c] = v; H[c * P + a] = v; }
    // the loop above filled only a <= c: symmetrise (each pair was added once into [min][max])
    for (let j = 0; j < V; j++) { g[2 + j] -= lambda * beta[2 + j]; H[(2 + j) * P + 2 + j] += lambda; }
    if (!xc) { H[P + 1] = 1; g[1] = 0; }
    for (let j = 0; j < P; j++) H[j * P + j] += 1e-9;
    const step = cholSolve(H, g, P);
    let s = 1;
    let next = null;
    let nll = -Infinity;
    for (let h = 0; h < 8; h++) {
      next = beta.map((v, j) => v + s * step[j]);
      nll = loglik(next);
      if (nll >= ll - 1e-9) break;
      s /= 2;
    }
    let maxd = 0;
    for (let j = 0; j < P; j++) maxd = Math.max(maxd, Math.abs(next[j] - beta[j]));
    beta.set(next);
    const gain = nll - ll;
    ll = nll;
    if (maxd < tol || Math.abs(gain) < 1e-7 * Math.max(1, Math.abs(ll))) { it++; break; }
  }
  return { b0: beta[0], wc: beta[1], w: beta.subarray(2), beta, iters: it, ll };
}

/** Raw probabilities for rows from a fit. */
export function predictRows({ off, idx, xc = null, rows, fit, mask = null }) {
  const out = new Float64Array(rows.length);
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q];
    let z = fit.b0 + (xc ? fit.wc * xc[r] : 0);
    for (let e = off[r]; e < off[r + 1]; e++) { const j = idx[e]; if (!mask || mask[j]) z += fit.w[j]; }
    out[q] = 1 / (1 + Math.exp(-z));
  }
  return out;
}

// ---------- isotonic calibration ----------

/**
 * Pool-adjacent-violators on (p, y) -> {x, y} knots (block mean prediction, block event rate), both
 * non-decreasing, compressed to at most maxKnots by merging adjacent blocks (which keeps monotonicity).
 */
export function isotonicFit(p, y, { maxKnots = 60 } = {}) {
  const n = p.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  const bx = [];
  const by = [];
  const bw = [];
  for (const i of order) {
    bx.push(p[i]); by.push(y[i]); bw.push(1);
    while (by.length > 1 && by[by.length - 2] / bw[bw.length - 2] >= by[by.length - 1] / bw[bw.length - 1]) {
      const w = bw.pop(); const sy = by.pop(); const sx = bx.pop();
      bw[bw.length - 1] += w; by[by.length - 1] += sy; bx[bx.length - 1] += sx;
    }
  }
  // compress by cumulative weight
  const total = bw.reduce((a, b) => a + b, 0);
  const groups = [];
  let acc = { x: 0, y: 0, w: 0 };
  let target = total / maxKnots;
  for (let k = 0; k < bw.length; k++) {
    acc.x += bx[k]; acc.y += by[k]; acc.w += bw[k];
    if (acc.w >= target || k === bw.length - 1) { groups.push(acc); acc = { x: 0, y: 0, w: 0 }; }
  }
  const x = [];
  const yy = [];
  for (const g of groups) {
    const gx = g.x / g.w;
    const gy = g.y / g.w;
    if (x.length && gx <= x[x.length - 1]) { yy[yy.length - 1] = Math.max(yy[yy.length - 1], gy); continue; }
    x.push(Math.round(gx * 1e5) / 1e5);
    yy.push(Math.round(Math.min(0.999, Math.max(0.001, gy)) * 1e4) / 1e4);
  }
  for (let k = 1; k < yy.length; k++) if (yy[k] < yy[k - 1]) yy[k] = yy[k - 1];
  return { x, y: yy };
}

// ---------- metrics ----------

export function brier(p, y) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2;
  return p.length ? s / p.length : null;
}
/** Area under the ROC curve (ties counted half); null when only one class is present. */
export function auc(p, y) {
  const n = p.length;
  const o = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  let pos = 0;
  for (let i = 0; i < n; i++) pos += y[i] ? 1 : 0;
  const neg = n - pos;
  if (!pos || !neg) return null;
  let rankSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && p[o[j + 1]] === p[o[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[o[k]]) rankSum += r;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
export function reliability(p, y, bins = 10) {
  const out = Array.from({ length: bins }, (_, k) => ({ lo: k / bins, hi: (k + 1) / bins, n: 0, sp: 0, k: 0 }));
  for (let i = 0; i < p.length; i++) {
    const b = Math.min(bins - 1, Math.floor(p[i] * bins));
    out[b].n++; out[b].sp += p[i]; out[b].k += y[i] ? 1 : 0;
  }
  return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.n ? b.sp / b.n : null, rate: b.n ? b.k / b.n : null, k: b.k }));
}
const skill = (bs, ref) => (bs == null || !ref ? null : 1 - bs / ref);

/** Brier / skill / AUC for model vs climatology vs rule mapping on the same rows. */
export function scoreSet(pm, pc, pr, y) {
  const bm = brier(pm, y);
  const bc = brier(pc, y);
  const br = brier(pr, y);
  let k = 0;
  for (const v of y) k += v;
  return {
    n: y.length, base: y.length ? k / y.length : null,
    brier: { model: bm, climo: bc, rule: br },
    bss: { climo: skill(bm, bc), rule: skill(bm, br), ruleVsClimo: skill(br, bc) },
    auc: { model: auc(pm, y), climo: auc(pc, y), rule: auc(pr, y) },
  };
}
export function contingency(f, o) {
  let a = 0; let b = 0; let c = 0; let d = 0;
  for (let i = 0; i < f.length; i++) { if (f[i]) { if (o[i]) a++; else b++; } else if (o[i]) c++; else d++; }
  return { a, b, c, d, pod: a + c ? a / (a + c) : null, far: a + b ? b / (a + b) : null, csi: a + b + c ? a / (a + b + c) : null };
}

// ---------- safety gate ----------

/**
 * Deploy only if test Brier skill vs climatology > 0, the model beats the rule-level mapping and, when a
 * model is deployed now (test.brier.current, scored on the same test hours), it beats that model too.
 * current: {usable, comparable, why} from the training run; a deployed model that can't be compared fairly
 * (it needs inputs this run didn't build) blocks the deploy; one this scorer can't use at all doesn't count.
 */
export function gate(test, { minN = 200, current = null } = {}) {
  const reasons = [];
  if (current?.usable) {
    const bm0 = test?.brier?.model;
    const bc0 = test?.brier?.current;
    if (!current.comparable) reasons.push(`the deployed model can't be compared on these test hours (${current.why || "missing inputs"})`);
    else if (!(bm0 != null && bc0 != null && bm0 < bc0)) reasons.push(`model Brier ${bm0?.toFixed?.(4) ?? "–"} does not beat the deployed model's ${bc0?.toFixed?.(4) ?? "–"} on the same test hours`);
  }
  if (!test || !(test.n >= minN)) reasons.push(`too few test hours (${test?.n ?? 0} < ${minN})`);
  const s = test?.bss?.climo;
  if (!(s > 0)) reasons.push(`Brier skill vs climatology ${s == null ? "unknown" : s.toFixed(3)} is not above 0`);
  const bm = test?.brier?.model;
  const br = test?.brier?.rule;
  if (!(bm != null && br != null && bm < br)) reasons.push(`model Brier ${bm?.toFixed?.(4) ?? "–"} does not beat the rule-level mapping ${br?.toFixed?.(4) ?? "–"}`);
  return { pass: reasons.length === 0, reasons };
}

// ---------- calibration by airport group ----------

/** Airport groups for the calibration report. */
export const AIRPORT_GROUPS = {
  "Northeast": ["BOS", "JFK", "LGA", "EWR", "PHL", "BWI", "DCA", "IAD"],
  "Southeast & Florida": ["ATL", "CLT", "BNA", "MCO", "MIA", "FLL", "TPA"],
  "Central": ["ORD", "MDW", "DTW", "MSP", "DFW", "IAH", "AUS", "DEN"],
  "West": ["LAX", "SFO", "SAN", "SEA", "LAS", "PHX", "SLC"],
  "Alaska & Hawaii": ["ANC", "HNL"],
};
export const groupOf = (ap) => Object.keys(AIRPORT_GROUPS).find((g) => AIRPORT_GROUPS[g].includes(ap)) || "Other";

/**
 * Calibration summary: n, mean predicted, observed rate, Brier, expected calibration error over 10 bins
 * (hour-weighted |mean predicted - observed|) and the observed rate where the model said 50-80%.
 */
export function calibrationSummary(p, y) {
  const n = p.length;
  if (!n) return { n: 0, meanP: null, rate: null, brier: null, ece: null, mid: null };
  let sp = 0;
  let k = 0;
  for (let i = 0; i < n; i++) { sp += p[i]; k += y[i]; }
  const bins = reliability(p, y);
  let ece = 0;
  for (const b of bins) if (b.n) ece += (b.n / n) * Math.abs(b.meanP - b.rate);
  let mn = 0; let mk = 0; let mp = 0;
  for (let i = 0; i < n; i++) if (p[i] >= 0.5 && p[i] < 0.8) { mn++; mk += y[i]; mp += p[i]; }
  return { n, meanP: sp / n, rate: k / n, brier: brier(p, y), ece, mid: mn ? { n: mn, meanP: mp / mn, rate: mk / mn } : null };
}

// ---------- climatology & fallback tables ----------

/**
 * Smoothed real-delay rate per airport x month x local hour from records (unique hours):
 * hour rate shrunk toward the airport-hour rate (m1 = 20 hours), which is shrunk toward the airport rate (m2 = 50).
 * -> {climo: {IATA: 288 rates (month-major)}, base: {IATA: rate, all: rate}}.
 */
export function climatology(records, { m1 = 20, m2 = 50 } = {}) {
  const ap = new Map();
  let N = 0;
  let K = 0;
  for (const r of records) {
    let a = ap.get(r.a);
    if (!a) { a = { n: 0, k: 0, h: new Float64Array(48), mh: new Float64Array(576) }; ap.set(r.a, a); }
    a.n++; a.k += r.y; N++; K += r.y;
    a.h[r.lh * 2]++; a.h[r.lh * 2 + 1] += r.y;
    const c = ((r.mo - 1) * 24 + r.lh) * 2;
    a.mh[c]++; a.mh[c + 1] += r.y;
  }
  const all = N ? K / N : 0;
  const climo = {};
  const base = { all: Math.round(all * 1000) / 1000 };
  for (const [iata, a] of ap) {
    const pa = (a.k + 10 * all) / (a.n + 10);
    base[iata] = Math.round(pa * 1000) / 1000;
    const row = new Array(288);
    for (let mo = 0; mo < 12; mo++) {
      for (let h = 0; h < 24; h++) {
        const ph = (a.h[h * 2 + 1] + m2 * pa) / (a.h[h * 2] + m2);
        const c = (mo * 24 + h) * 2;
        row[mo * 24 + h] = Math.round(((a.mh[c + 1] + m1 * ph) / (a.mh[c] + m1)) * 1000) / 1000;
      }
    }
    climo[iata] = row;
  }
  return { climo, base };
}

/** Real-delay rate per lead bucket x TAF rule level (the "rule-level mapping"; index 5 = no TAF). */
export function levelRates(rows, records, sel) {
  const t = BUCKETS.map(() => Array.from({ length: 6 }, () => [0, 0]));
  for (const q of sel) {
    const c = t[rows.b[q]][rows.lvl[q]];
    c[0]++; c[1] += records[rows.rec[q]].y;
  }
  const levels = {};
  BUCKETS.forEach((b, bi) => {
    // empty or tiny cells borrow the next lower level's rate (levels sort risk)
    const rates = [];
    for (let l = 0; l < 6; l++) {
      const [n, k] = t[bi][l];
      const prior = l === 0 || l === 5 ? null : rates[l - 1];
      rates.push(n >= 20 ? k / n : n && prior != null ? (k + 20 * prior) / (n + 20) : prior ?? (n ? k / n : null));
    }
    levels[b.key] = rates.map((x) => (x == null ? null : Math.round(x * 1000) / 1000));
  });
  return { levels, counts: Object.fromEntries(BUCKETS.map((b, bi) => [b.key, t[bi].map(([n, k]) => ({ n, k }))])) };
}

// ---------- analogs ----------

/** Analog tables per airport from records (lead 0-3 h TAF summaries): {IATA: {key: [n, k, median, cxShare]}}. */
export function buildAnalogs(records, { min = ANALOG_MIN } = {}) {
  const acc = new Map();
  for (const r of records) {
    const f = r.f[0] || r.f[1];
    if (!f || !f.w) continue;
    let A = acc.get(r.a);
    if (!A) { A = new Map(); acc.set(r.a, A); }
    for (const key of analogKeys(f.w, r.lh, r.mo)) {
      let v = A.get(key);
      if (!v) { v = { n: 0, k: 0, mins: [], cx: 0 }; A.set(key, v); }
      v.n++;
      v.cx += r.cx || 0;
      if (r.y) { v.k++; if (r.dm != null) v.mins.push(r.dm); }
    }
  }
  const out = {};
  for (const [ap, A] of acc) {
    const b = {};
    for (const [key, v] of [...A].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (v.n < min) continue;
      const m = median(v.mins);
      b[key] = [v.n, v.k, m == null ? null : Math.round(m), Math.round((v.cx / v.n) * 1000) / 1000];
    }
    out[ap] = b;
  }
  return out;
}

export { seasonOf, logit, sigmoid, calibrate, HUBS, PX };
