// Delay model scorer (Phase 3): "is this likely to cause a real delay?" per airport hour.
// Pure ES module, no I/O and no node: imports, so poller/poll.mjs, the live relay (worker/worker.mjs
// through core.mjs) and the browser can all use it. Training (tools/train*.mjs) builds its features
// with the same functions, so a live hour and a training hour are described identically.
//
//   scoreHours({iata, tz, now, hours, taf, metar, hubTafs, lamp, faa, atcscc, opsplan, model, fallback, analogs})
//     -> [{p, pTypical, minutes, analog: {n, k, median, text} | null, basis: "model"|"fallback", lead, override?}]
//
// README "Delay model" documents the target, the features, validation and the safety gate.
import { tafHourParts, tafHour, levelOf, assessConditions, parseVisib, ceilingOf, parseWx, toMs, faaSpan, closureSpan, flightCategory } from "./risk.mjs";

/** Feature spec version: model.json files built for another spec are ignored (fallback is used). */
export const SPEC = 1;
const HOUR = 3600e3;
export const BUCKETS = [
  { key: "0-3", lo: 0, hi: 3 },
  { key: "3-6", lo: 3, hi: 6 },
  { key: "6-12", lo: 6, hi: 12 },
  { key: "12-24", lo: 12, hi: 24 },
];
export function bucketOf(leadH) {
  for (const b of BUCKETS) if (leadH < b.hi) return b.key;
  return BUCKETS[BUCKETS.length - 1].key;
}

/**
 * "Real delay hour" (README): in that local hour at least 25% of scheduled departures, or of
 * scheduled arrivals, were 15+ min late with weather or NAS (air traffic system) delay minutes, or
 * at least 5% of them were cancelled for weather/NAS (code B or C). A side counts only with >= 5 flights;
 * an hour with neither side at 5 flights is skipped.
 */
export const DEF = { minFlights: 5, delayShare: 0.25, cxlShare: 0.05, lateMin: 15 };
export const DEF_TEXT = "At least a quarter of the hour's departures or arrivals left or landed 15+ minutes late because of weather or air traffic control (FAA/BTS weather and NAS delay causes), or at least 5% were cancelled for those reasons. Hours with fewer than 5 flights are left out.";

/**
 * Optional feature families (model.json `feats`; a model without `feats` uses none of them, so models
 * trained before they existed score exactly as before): lamp (IEM LAMP thunder/convection chances and
 * ceiling/visibility categories), programs (FAA ground stop / GDP / possible program / staffing state when
 * the forecast is made, "pg:none" where no record exists), hubs (conditions and TAF rule level at the
 * airport's top connecting hubs, model.hubs), daytype (federal holidays and the days around Thanksgiving,
 * Christmas and July 4), volume (scheduled flights for the hour vs the airport's usual, model.vol).
 * TODO(movement): poller/movement.mjs's movement index is live-only. Don't train on it until the history
 * branch has 4+ weeks of movement/ logs to backtest it against BTS.
 */
export const FEATS = ["lamp", "programs", "hubs", "daytype", "volume"];

/** Main connecting hub(s) per airport for the hub-cascade features (weather there delays flights here). */
export const HUBS = {
  ATL: ["ORD"], DFW: ["ORD"], DEN: ["ORD"], ORD: ["EWR"], LAX: ["SFO"], JFK: ["ATL"], LAS: ["DEN"], MCO: ["ATL"],
  MIA: ["ATL"], CLT: ["EWR"], SEA: ["SFO"], PHX: ["DEN"], EWR: ["ORD"], SFO: ["LAX"], IAH: ["DFW"], BOS: ["EWR"],
  FLL: ["ATL"], MSP: ["ORD"], LGA: ["ORD"], DTW: ["ORD"], PHL: ["EWR"], SLC: ["DEN"], DCA: ["EWR"], SAN: ["LAX"],
  BWI: ["EWR"], TPA: ["ATL"], AUS: ["DFW"], IAD: ["EWR"], BNA: ["ATL"], MDW: ["ORD"], HNL: ["LAX"], ANC: ["SEA"],
};

// ---------- local time ----------

const dtfs = new Map();
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** {y, mo (1-12), d, h (0-23), dw (0 Sun - 6 Sat)} of ms in tz. */
export function localParts(ms, tz) {
  let f = dtfs.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", weekday: "short", hourCycle: "h23" });
    dtfs.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, dw: WD[o.weekday] ?? 0 };
}

// ---------- condition summaries (shared by training and live scoring) ----------

export const PX = { RA: 1, SN: 2, FZ: 4, PL: 8, SNH: 16 };
const CATS = ["VFR", "MVFR", "IFR", "LIFR"];
const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

function precipBits(wxString, vis) {
  let p = 0;
  for (const w of parseWx(wxString)) {
    if (w.intensity === "VC") continue;
    const has = (c) => w.codes.includes(c);
    if (has("FZ") && (has("RA") || has("DZ"))) p |= PX.FZ;
    else if (has("RA") || has("DZ")) p |= PX.RA;
    if (has("PL")) p |= PX.PL;
    if (has("SN")) {
      p |= PX.SN;
      if (w.intensity === "+" || (vis != null && vis <= 0.5)) p |= PX.SNH;
    }
  }
  return p;
}
/** 0 none, 1 VCTS, 2 TS, plus heavy flag. */
function thunderOf(wxString, clouds) {
  let t = 0;
  let heavy = 0;
  for (const w of parseWx(wxString)) {
    if (!w.codes.includes("TS")) continue;
    if (w.intensity === "VC") t = Math.max(t, 1);
    else { t = 2; if (w.intensity === "+") heavy = 1; }
  }
  return { t, heavy };
}

/** Smallest crosswind (kt) over the runways for wind from dir at spd; null when unknown. */
export function crosswind(dir, spd, rwys) {
  if (!spd) return 0;
  if (dir == null || dir === "VRB" || !Number.isFinite(Number(dir))) return null;
  if (!Array.isArray(rwys) || !rwys.length) return null;
  let best = Infinity;
  for (const h of rwys) {
    const x = Math.abs(spd * Math.sin(((Number(dir) - h) * Math.PI) / 180));
    if (x < best) best = x;
  }
  return Math.round(best);
}

/**
 * One set of conditions (METAR, or a TAF state) -> {l, fc, c, v, t, th, g, s, x, p}:
 * risk level, flight category index (0 VFR … 3 LIFR), ceiling ft, visibility sm (cap 10),
 * thunder 0/1 (VC)/2, heavy thunder, gust kt, wind kt, crosswind kt, precip bits (PX).
 */
export function condSummary(cond, rwys) {
  if (!cond) return null;
  const v0 = parseVisib(cond.visib);
  const v = v0 == null ? null : Math.min(10, Math.round(v0 * 100) / 100);
  const c = ceilingOf(cond.clouds);
  const { t, heavy } = thunderOf(cond.wxString, cond.clouds);
  const s = num(cond.wspd) ?? 0;
  const g = num(cond.wgst) ?? 0;
  const x = crosswind(cond.wdir, Math.max(s, g), rwys);
  return {
    l: levelOf(assessConditions(cond)), fc: CATS.indexOf(flightCategory(v, c)), c, v,
    t, th: heavy, g, s, x, p: precipBits(cond.wxString, v),
  };
}

/**
 * A TAF's hour [t0, t0+1h) -> {l, fc, c, v, t, th, g, gp, s, x, p, pp, it} or null (not covered):
 * l = the risk.mjs TAF level (tafHour); fc/c/v/s = prevailing state; t = thunder 0 none, 1 PROB group,
 * 2 TEMPO group, 3 prevailing VCTS, 4 prevailing TS; th = heavy (+TS, not in PROB); g/x/p = worst of the
 * prevailing state and TEMPO groups; gp/pp = PROB groups only; it = worst flight category in overlays.
 */
export function tafSummary(taf, t0, rwys) {
  if (!taf) return null;
  const parts = tafHourParts(taf, t0, t0 + HOUR);
  if (!parts) return null;
  const th = tafHour(taf, t0, t0 + HOUR);
  const base = condSummary(parts.state, rwys);
  const o = { l: th ? levelOf(th.items) : 0, fc: base.fc, c: base.c, v: base.v, t: base.t === 2 ? 4 : base.t === 1 ? 3 : 0, th: base.th, g: base.g, gp: 0, s: base.s, x: base.x, p: base.p, pp: 0, it: 0 };
  for (const ov of parts.overlays) {
    const s = condSummary(ov.cond, rwys);
    const prob = ov.prob != null && ov.prob > 0;
    o.it = Math.max(o.it, s.fc);
    if (prob) {
      if (s.t && !o.t) o.t = 1;
      o.gp = Math.max(o.gp, s.g);
      o.pp |= s.p & ~o.p;
    } else {
      if (s.t && o.t < 2) o.t = 2;
      if (s.th) o.th = 1;
      o.g = Math.max(o.g, s.g);
      if (s.x != null) o.x = Math.max(o.x ?? 0, s.x);
      o.p |= s.p;
    }
  }
  o.pp &= ~o.p;
  return o;
}

/** Hub-cascade bits from a hub's TAF summary: 1 TS, 2 PROB TS, 4 IFR/LIFR, 8 snow/ice, 16 gust 25+, 32 level High+. */
export function hubBits(w) {
  if (!w) return null;
  let b = 0;
  if (w.t >= 2) b |= 1;
  else if (w.t === 1) b |= 2;
  if (w.fc >= 2) b |= 4;
  if (w.p & (PX.SN | PX.FZ | PX.PL)) b |= 8;
  if (w.g >= 25) b |= 16;
  if (w.l >= 3) b |= 32;
  return b;
}

/**
 * LAMP thunder (LP1, LP2) and convection (CP1) chances for the hour starting t0 (status.json lamp.hours
 * shape), plus the ceiling (cig 1-8) and visibility (vis 1-7) categories forecast for the end of the hour.
 */
export function lampAt(lamp, t0) {
  let lp = null;
  let cp = null;
  let lc = null;
  let lv = null;
  for (const x of lamp?.hours || []) {
    const t = toMs(x.t);
    if (t === t0 + HOUR) { lc = lampCat(x.cig, 8); lv = lampCat(x.vis, 7); }
    if (t == null || !(t > t0 && t <= t0 + (num(x.probHrs) || 1) * HOUR)) continue;
    if (num(x.tstmProb) != null && (lp == null || x.tstmProb > lp)) lp = Number(x.tstmProb);
    if (num(x.convProb) != null && (cp == null || x.convProb > cp)) cp = Number(x.convProb);
  }
  return { lp, cp, lc, lv };
}
/** A LAMP category (1..max) or null. */
export const lampCat = (x, max) => { const v = num(x); return v != null && Number.isInteger(v) && v >= 1 && v <= max ? v : null; };

/** Hub TAF summary -> packed int: hubBits | rule level << 8 (null when the hub's TAF doesn't cover the hour). */
export const hubPack = (w) => (w ? hubBits(w) | ((w.l || 0) << 8) : null);
/**
 * Hub cascade over the top connecting hubs (packed values, null = no TAF for that hub):
 * [hubs with a TAF, with thunder, with PROB thunder, IFR, snow/ice, gusts 25+, highest rule level] or null.
 */
export function cascadeOf(packed) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const v of packed || []) {
    if (v == null) continue;
    c[0]++;
    if (v & 1) c[1]++;
    if (v & 2) c[2]++;
    if (v & 4) c[3]++;
    if (v & 8) c[4]++;
    if (v & 16) c[5]++;
    c[6] = Math.max(c[6], v >> 8);
  }
  return c[0] ? c : null;
}

/**
 * FAA program state for the hour starting H, as known at time `at` (the poll the forecast is made from):
 * ground stop / GDP in effect (NAS status, active ATCSCC advisory, or an active ops-plan program covering H),
 * an ops-plan "possible" GS/GDP covering H, and staffing (an ops-plan staffing trigger not yet expired, or a
 * program with a staffing cause). entry = {faa, atcscc, opsplan} as in status.json / the history truth log.
 */
export function programState({ faa = [], atcscc = [], opsplan = null } = {}, H, at) {
  const o = { gs: false, gdp: false, poss: false, staff: false };
  for (const f of faa || []) {
    if (f.type === "ground_stop") o.gs = true;
    else if (f.type === "ground_delay") o.gdp = true;
    else continue;
    if (f.cause === "staffing") o.staff = true;
  }
  for (const a of atcscc || []) {
    if (!a.active) continue;
    if (a.type === "GS") o.gs = true;
    else if (a.type === "GDP") o.gdp = true;
    else continue;
    if (a.cause === "staffing") o.staff = true;
  }
  for (const p of opsplan?.programs || []) {
    const from = toMs(p.from) ?? -Infinity;
    const to = toMs(p.until) ?? at + 6 * HOUR;
    if (!(H < to && H + HOUR > from)) continue;
    if (p.status === "active") { if (p.program === "GS") o.gs = true; else o.gdp = true; } else if (p.status === "possible") o.poss = true;
    if (p.cause === "staffing") o.staff = true;
  }
  for (const s of opsplan?.staffing || []) if (H < (toMs(s.until) ?? at + 6 * HOUR)) o.staff = true;
  return o;
}

// ---------- day type ----------

const dayNum = (y, mo, d) => Math.round(Date.UTC(y, mo - 1, d) / 864e5);
function nthWeekday(y, mo, dow, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); return 1 + ((dow - first + 7) % 7) + (n - 1) * 7; }
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return last - ((new Date(Date.UTC(y, mo - 1, last)).getUTCDay() - dow + 7) % 7);
}
const holCache = new Map();
/** US federal holidays of year y (day numbers, observed dates included) and the big travel holidays (actual dates). */
function holidaysOf(y) {
  if (holCache.has(y)) return holCache.get(y);
  const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]];
  const floating = [[1, 1, 3], [2, 1, 3], [5, 1, -1], [9, 1, 1], [10, 1, 2], [11, 4, 4]]; // MLK, Presidents, Memorial, Labor, Columbus, Thanksgiving
  const hol = new Set();
  for (const [mo, d] of fixed) {
    const n = dayNum(y, mo, d);
    hol.add(n);
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd === 6) hol.add(n - 1); else if (wd === 0) hol.add(n + 1); // observed Friday / Monday
  }
  for (const [mo, dow, k] of floating) hol.add(dayNum(y, mo, nthWeekday(y, mo, dow, k)));
  const big = [dayNum(y, 11, nthWeekday(y, 11, 4, 4)), dayNum(y, 12, 25), dayNum(y, 7, 4)];
  const v = { hol, big };
  holCache.set(y, v);
  return v;
}
/**
 * Day type of a local date: {hol: federal holiday (or its observed day), pk: -1 one or two days before
 * Thanksgiving / Christmas / July 4, +1 one or two days after, else 0}. null for a bad date.
 */
export function dayType(y, mo, d) {
  if (!(y > 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const n = dayNum(y, mo, d);
  let hol = false;
  let pk = 0;
  for (const yy of [y - 1, y, y + 1]) {
    const H = holidaysOf(yy);
    if (H.hol.has(n)) hol = true;
    for (const b of H.big) { const k = n - b; if (k >= -2 && k <= -1) pk = -1; else if (k >= 1 && k <= 2) pk = 1; }
  }
  return { hol, pk };
}

// ---------- schedule volume ----------

/** Hour of week (0 = Sunday 00 local). */
export const hourOfWeek = (dw, lh) => dw * 24 + lh;
/** Scheduled-flights ratio vs the usual for the hour -> bin name or null (0.9-1.1 = usual). */
export function volRatioBin(r) {
  if (r == null || !Number.isFinite(r)) return null;
  return r < 0.7 ? "lo2" : r < 0.9 ? "lo" : r > 1.3 ? "hi2" : r > 1.1 ? "hi" : null;
}
/**
 * Live volume inputs from model.vol ({IATA: {q: "168 digits", f: [12 month factors]}}): q = how busy this
 * hour of the week usually is at the airport (0 quiet … 3 peak bank), r = the month's expected schedule vs usual.
 */
export function volumeAt(vol, iata, mo, dw, lh) {
  const v = vol?.[iata];
  if (!v || typeof v.q !== "string" || v.q.length !== 168) return { vq: null, vr: null };
  const q = Number(v.q[hourOfWeek(dw, lh)]);
  const f = Array.isArray(v.f) ? num(v.f[mo - 1]) : null;
  return { vq: Number.isInteger(q) && q >= 0 && q <= 3 ? q : null, vr: f };
}

// ---------- encoding ----------

const TOD = (h) => (h >= 5 && h <= 11 ? "morning" : h >= 12 && h <= 16 ? "afternoon" : h >= 17 && h <= 21 ? "evening" : "night");
export const todOf = TOD;
export const seasonOf = (mo) => (mo === 12 || mo <= 2 ? "winter" : mo <= 5 ? "spring" : mo <= 8 ? "summer" : "fall");

/**
 * Feature names for one (airport, hour, lead bucket): calendar, airport, lead, the TAF hour summary
 * (w), the persistence observation (o), hub bits (h) and the optional families (FEATS; off unless set):
 * lamp (lp, cp, lc, lv), programs (pg: programState or null = no record), hubs (hc: cascadeOf),
 * daytype (y, mo, d local date), volume (vq 0-3, vr ratio). The climatology logit is a separate
 * continuous input. Names unknown to a model weigh 0.
 */
export function encode(f, b, { lamp = false, programs = false, hubs = false, daytype = false, volume = false } = {}) {
  const n = ["lead:" + b, "hr:" + f.lh, "dow:" + f.dw, "mon:" + f.mo, "ap:" + f.ap];
  const w = f.w;
  if (!w) n.push("taf:none");
  else {
    if (w.l) n.push("lvl:" + w.l, "lvl:" + w.l + "|" + b);
    if (w.c != null) { if (w.c < 500) n.push("ceil:lifr"); else if (w.c < 1000) n.push("ceil:ifr"); else if (w.c <= 3000) n.push("ceil:mvfr"); }
    if (w.v != null) { if (w.v < 1) n.push("vis:lt1"); else if (w.v < 3) n.push("vis:lt3"); else if (w.v <= 5) n.push("vis:le5"); }
    if (w.it >= 2 && w.it > w.fc) n.push("tempo:ifr");
    if (w.t) { n.push("ts:" + w.t, "ts:" + w.t + "|" + b); if (w.t >= 2) n.push("ts|" + TOD(f.lh)); }
    if (w.th) n.push("ts:heavy");
    if (w.g >= 35) n.push("gust:35"); else if (w.g >= 25) n.push("gust:25"); else if (w.g >= 15) n.push("gust:15");
    if (w.gp >= 25 && w.g < 25) n.push("gustProb:25");
    if (w.s >= 20) n.push("wind:20");
    if (w.x != null) { if (w.x >= 25) n.push("xw:25"); else if (w.x >= 15) n.push("xw:15"); else if (w.x >= 10) n.push("xw:10"); }
    for (const [k, bit] of Object.entries(PX)) {
      if (w.p & bit) n.push("wx:" + k);
      if (w.pp & bit) n.push("wxProb:" + k);
    }
    if (w.p & (PX.SN | PX.FZ | PX.PL)) n.push("winter|" + b);
  }
  const o = f.o;
  if (!o) n.push("obs:none");
  else {
    if (o.l) n.push("obs:l" + o.l + "|" + b);
    if (o.t) n.push("obs:ts|" + b);
    if (o.fc >= 2) n.push("obs:ifr|" + b);
    if (o.p & (PX.SN | PX.FZ | PX.PL)) n.push("obs:winter|" + b);
    if (o.g >= 25) n.push("obs:g25|" + b);
    if (o.x != null && o.x >= 15) n.push("obs:xw|" + b);
  }
  if (f.h == null) n.push("hub:none");
  else {
    const H = ["ts", "tsp", "ifr", "winter", "g25", "l3"];
    H.forEach((k, i) => { if (f.h & (1 << i)) n.push("hub:" + k); });
  }
  if (lamp) {
    if (f.lp == null) n.push("lp:none");
    else if (f.lp >= 40) n.push("lp:40");
    else if (f.lp >= 20) n.push("lp:20");
    else if (f.lp >= 10) n.push("lp:10");
    if (f.cp != null && f.cp >= 50) n.push("cp:50");
    // LAMP categories: CIG 1-3 = under 1000 ft, 4-5 = 1000-3000 ft; VIS 1-3 = under 3 mi, 4-5 = 3-5 mi
    if (f.lc != null) { if (f.lc <= 3) n.push("lcig:ifr"); else if (f.lc <= 5) n.push("lcig:mvfr"); }
    if (f.lv != null) { if (f.lv <= 3) n.push("lvis:ifr"); else if (f.lv <= 5) n.push("lvis:mvfr"); }
  }
  if (programs) {
    const g = f.pg;
    if (!g) n.push("pg:none");
    else {
      if (g.gs) n.push("pg:gs|" + b);
      if (g.gdp) n.push("pg:gdp|" + b);
      if (g.poss) n.push("pg:poss", "pg:poss|" + b);
      if (g.staff) n.push("pg:staff");
    }
  }
  if (hubs) {
    const c = f.hc;
    if (!c) n.push("hc:none");
    else {
      if (c[1]) n.push("hc:ts", "hc:ts|" + b);
      if (c[1] >= 2) n.push("hc:ts2");
      if (c[2]) n.push("hc:tsp");
      if (c[3]) n.push("hc:ifr");
      if (c[3] >= 2) n.push("hc:ifr2");
      if (c[4]) n.push("hc:win");
      if (c[5]) n.push("hc:g25");
      if (c[6] >= 3) n.push("hc:l3", "hc:l3|" + b);
      else if (c[6] === 2) n.push("hc:l2");
    }
  }
  if (daytype) {
    const t = dayType(f.y, f.mo, f.d);
    if (t?.hol) n.push("day:hol");
    if (t?.pk < 0) n.push("day:pre");
    if (t?.pk > 0) n.push("day:post");
  }
  if (volume) {
    if (f.vq == null) n.push("vol:none");
    else {
      n.push("vol:q" + f.vq);
      const r = volRatioBin(f.vr);
      if (r) n.push("volr:" + r);
      if (f.vq === 3 && w) {
        if (w.fc >= 2 || w.it >= 2) n.push("vol:q3|ifr");
        if (w.t >= 2) n.push("vol:q3|ts");
        if (w.g >= 25 || (w.x != null && w.x >= 15)) n.push("vol:q3|wind");
      }
    }
  }
  return [...new Set(n)];
}

export const logit = (p) => { const q = Math.min(0.995, Math.max(0.005, p)); return Math.log(q / (1 - q)); };
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Isotonic map {x: [...], y: [...]} (increasing): linear between knots, flat outside. */
export function calibrate(cal, p) {
  if (!cal || !Array.isArray(cal.x) || !cal.x.length) return p;
  const { x, y } = cal;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= p) lo = m; else hi = m; }
  const f = x[hi] === x[lo] ? 0 : (p - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + f * (y[hi] - y[lo]);
}

/** Climatological rate for airport x month x local hour (fallback.json climo), else the airport's rate. */
export function typicalRate(fb, ap, mo, lh) {
  const row = fb?.climo?.[ap];
  if (Array.isArray(row) && row.length === 288 && row[(mo - 1) * 24 + lh] != null) return { p: row[(mo - 1) * 24 + lh], scope: "hour" };
  const b = fb?.base?.[ap];
  if (b != null) return { p: b, scope: "airport" };
  return fb?.base?.all != null ? { p: fb.base.all, scope: "pooled" } : null;
}

/** Raw model probability (before calibration). */
export function modelRaw(model, names, climo) {
  let z = model.b0 || 0;
  if (model.wc && climo != null) z += model.wc * logit(climo);
  for (const k of names) z += model.w[k] || 0;
  return sigmoid(z);
}

/** Expected delay minutes when delays happen: airport x predicted-probability decile median. */
export function minutesFor(model, ap, p) {
  const m = model?.minutes;
  if (!m || !Array.isArray(m.edges)) return null;
  let d = 0;
  while (d < m.edges.length && p >= m.edges[d]) d++;
  const v = m.ap?.[ap]?.[d] ?? m.all?.[d];
  return v == null ? null : v;
}

// ---------- historical comparison (analogs) ----------

/** Coarse condition signature of a TAF hour summary: {hz, sev}. */
export function hazardOf(w) {
  if (!w) return { hz: "clear", sev: 0 };
  if (w.t >= 1) return { hz: "storms", sev: w.th ? 3 : w.t === 4 || w.t === 2 ? 2 : 1 };
  if (w.p & (PX.SN | PX.FZ | PX.PL)) return { hz: "winter", sev: w.p & (PX.FZ | PX.SNH) ? 3 : w.p & PX.PL || w.fc >= 2 ? 2 : 1 };
  if (w.fc >= 1) return { hz: "lowcloud", sev: w.fc };
  if (w.g >= 25 || (w.x != null && w.x >= 15)) return { hz: "wind", sev: w.g >= 35 || (w.x != null && w.x >= 25) ? 2 : 1 };
  return { hz: "clear", sev: 0 };
}
/** Analog bucket keys, finest first: hazard|sev|time of day|season, hazard|sev|*|season, hazard|sev|*|*. */
export function analogKeys(w, lh, mo) {
  const { hz, sev } = hazardOf(w);
  return [`${hz}|${sev}|${TOD(lh)}|${seasonOf(mo)}`, `${hz}|${sev}|*|${seasonOf(mo)}`, `${hz}|${sev}|*|*`];
}
export const ANALOG_MIN = 15;
const TOD_WORD = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "overnight" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ym || ""));
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : "";
}
const fmtN = (n) => Number(n).toLocaleString("en-US");

/**
 * The historical comparison for one hour: the finest bucket with >= 15 hours.
 * analogs: {ap, since, b: {key: [n, k, median, cxShare]}}. -> {n, k, median, text} | null (coarser
 * buckets drop the time of day: "hours with similar conditions").
 */
export function analogFor(analogs, iata, w, lh, mo) {
  if (!analogs?.b) return null;
  const keys = analogKeys(w, lh, mo);
  for (let i = 0; i < keys.length; i++) {
    const v = analogs.b[keys[i]];
    if (!v || v[0] < ANALOG_MIN) continue;
    const [n, k, median] = v;
    return { n, k, median: median ?? null, text: analogText({ n, k, median, iata, since: analogs.since, tod: i === 0 ? TOD(lh) : null }) };
  }
  return null;
}

/** "In 214 similar evening hours at ORD since Aug 2024, 131 (61%) had delays of 15+ min; median 38 min." */
export function analogText({ n, k, median, iata, since, tod }) {
  const pct = n ? Math.round((100 * k) / n) : 0;
  const where = `at ${iata}${since ? " since " + monthLabel(since) : ""}`;
  const head = tod ? `In ${fmtN(n)} similar ${TOD_WORD[tod]} hours ${where}` : `In ${fmtN(n)} hours with similar conditions ${where}`;
  if (!k) return `${head}, none had delays of 15+ min.`;
  return `${head}, ${fmtN(k)} (${pct}%) had delays of 15+ min${median != null ? `; median ${Math.round(median)} min` : ""}.`;
}

// ---------- FAA overrides ----------

/** "49m", "1h 52m", "1 hr 5 min" -> minutes. */
export function durMin(s) {
  const t = String(s ?? "");
  const h = /(\d+)\s*h/i.exec(t);
  const m = /(\d+)\s*m(?!a)/i.exec(t);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}
/** FAA general delay detail "Departures 16–30m, increasing; Arrivals 31–45m" -> {min, mid} (minutes) or null. */
export function delayRange(detail) {
  const parts = String(detail ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  const pick = parts.find((p) => /^Departures|^Arrivals\/Departures|^Delays/.test(p)) || parts[0];
  if (!pick) return null;
  const m = /(\d+(?:h(?: \d+m)?|m)?)\s*[–-]\s*(\d+(?:h(?: \d+m)?|m))/.exec(pick);
  if (m) {
    const hi = durMin(m[2]);
    const lo = /[hm]/.test(m[1]) ? durMin(m[1]) : /h/.test(m[2]) ? +m[1] * 60 : +m[1];
    return lo != null && hi != null ? { min: lo, mid: Math.round((lo + hi) / 2) } : null;
  }
  const one = durMin(pick);
  return one != null ? { min: one, mid: one } : null;
}

/**
 * FAA overrides per hour. A full airport closure -> p = 1 ("closure") over its whole window (risk.mjs
 * closureSpan: start through reopening or NOTAM end; hour 0 only with no known end); it wins over any
 * program in the same hour. Active ground stop / GDP (NAS status, active ATCSCC advisory, or an active
 * ops-plan program) -> p = 1 over its hours (until its end; 3 h / 5 h with no end, as the risk rules);
 * minutes = the FAA's stated average delay when given. A general FAA delay of 15+ min -> p = 1 in hour 0,
 * and through its end when the FAA gives one.
 * An ops-plan "possible" GS/GDP raises p to at least the program's historical rate (fallback.programs,
 * from our history log), else 0.5, until its time.
 */
export function overrides({ hours, now, faa = [], atcscc = [], opsplan = null, programs = null }) {
  const out = hours.map(() => null);
  const set = (i, o) => {
    const cur = out[i];
    if (cur && cur.override === "closure") return; // a closed airport stays "closure"
    if (!cur || o.p > cur.p || (o.p === cur.p && cur.minutes == null && o.minutes != null)) out[i] = o;
  };
  const t0s = hours.map((h) => +new Date(h.t));
  for (const f of faa || []) {
    const span = closureSpan(f, now);
    if (!span) continue;
    t0s.forEach((t, i) => {
      if ((i === 0 && span.from <= +now) || (t + HOUR > span.from && span.to != null && t < span.to)) out[i] = { p: 1, override: "closure", minutes: null };
    });
  }
  for (const f of faa || []) {
    if (f.type === "ground_stop" || f.type === "ground_delay") {
      const end = faaSpan(f, now);
      const avg = f.type === "ground_delay" ? durMin(/avg ([^,]+)/.exec(f.detail || "")?.[1]) : null;
      t0s.forEach((t, i) => { if (i === 0 || t < end) set(i, { p: 1, override: f.type, minutes: avg }); });
    } else if (f.type === "delay") {
      const r = delayRange(f.detail);
      const end = toMs(f.end);
      if (r && r.min >= 15) t0s.forEach((t, i) => { if (i === 0 || (end != null && t < end)) set(i, { p: 1, override: "delay", minutes: r.mid }); });
    }
  }
  for (const a of atcscc || []) {
    if (!a.active || (a.type !== "GS" && a.type !== "GDP")) continue;
    const end = toMs(a.end) ?? +now + 3 * HOUR;
    t0s.forEach((t, i) => { if (i === 0 || t < end) set(i, { p: 1, override: a.type === "GS" ? "ground_stop" : "ground_delay", minutes: null }); });
  }
  for (const pr of opsplan?.programs || []) {
    const to = toMs(pr.until) ?? Infinity;
    const from = toMs(pr.from) ?? -Infinity;
    const kind = pr.program === "GS" ? "ground_stop" : "ground_delay";
    t0s.forEach((t, i) => {
      if (!(t < to && t + HOUR > from)) return;
      if (pr.status === "active") set(i, { p: 1, override: kind, minutes: null });
      else {
        const r = programs?.[pr.program]?.rate;
        set(i, { p: r != null ? r : 0.5, override: "possible_" + kind, floor: true, rateFrom: r != null ? "history" : "default" });
      }
    });
  }
  return out;
}

// ---------- live scoring ----------

/** True when model.json can be used with this scorer. */
export const modelOk = (m) => !!(m && m.spec === SPEC && m.w && typeof m.b0 === "number" && Object.entries(m.feats || {}).every(([k, v]) => !v || FEATS.includes(k)));
/** encode() options for a model: its feature families (older models: only `lamp`). */
export const featsOf = (m) => ({ lamp: !!(m?.feats?.lamp ?? m?.lamp), programs: !!m?.feats?.programs, hubs: !!m?.feats?.hubs, daytype: !!m?.feats?.daytype, volume: !!m?.feats?.volume });
export const fallbackOk = (fb) => !!(fb && fb.levels && typeof fb.levels === "object");

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r5 = (x) => (x == null ? null : Math.max(15, Math.round(x / 5) * 5));

/**
 * Delay objects for an airport's hours (risk.mjs buildHours rows: {t, level, items}).
 * metar: the current METAR (AWC shape) or null. hubTafs: TAFs of HUBS[iata] (missing ones skipped).
 * tafOf(IATA) -> TAF | null (optional): any airport's TAF, for a model with the hub cascade (model.hubs);
 * without it, hub TAFs are looked up in hubTafs by station and hubs not found count as having no TAF.
 * Returns an array (same length) of delay objects, or nulls when neither a model nor a fallback is loaded.
 */
export function scoreHours({
  iata, tz, now = new Date(), hours, taf = null, metar = null, hubTafs = [], lamp = null,
  faa = [], atcscc = [], opsplan = null, model = null, fallback = null, analogs = null, tafOf = null,
}) {
  const useModel = modelOk(model);
  if (!useModel && !fallbackOk(fallback)) return hours.map(() => null);
  const rwys = (useModel ? model.rwy?.[iata] : null) || fallback?.rwy?.[iata] || null;
  const o = metar ? condSummary(metar, rwys) : null;
  const ov = overrides({ hours, now, faa, atcscc, opsplan, programs: fallback?.programs || model?.programs || null });
  const fo = useModel ? featsOf(model) : {};
  const cascadeTafs = fo.hubs
    ? (model.hubs?.[iata] || []).map((h) => {
      const t = typeof tafOf === "function" ? tafOf(h) : null;
      return t || (hubTafs || []).find((x) => { const s = String(x?.icaoId || x?.station || ""); return s.slice(1) === h || s === h; }) || null;
    })
    : [];
  return hours.map((hr, i) => {
    const t0 = +new Date(hr.t);
    const leadH = Math.max(0, (t0 - +now) / HOUR);
    const b = bucketOf(leadH);
    const lp = localParts(t0, tz);
    const w = taf ? tafSummary(taf, t0, rwys) : null;
    let h = null;
    for (const ht of hubTafs || []) { const x = hubBits(tafSummary(ht, t0, null)); if (x != null) h = (h ?? 0) | x; }
    const typ = typicalRate(fallback, iata, lp.mo, lp.h);
    let p;
    let minutes;
    if (useModel) {
      const L = fo.lamp ? lampAt(lamp, t0) : { lp: null, cp: null, lc: null, lv: null };
      const f = { ap: iata, lh: lp.h, dw: lp.dw, mo: lp.mo, y: lp.y, d: lp.d, w, o, h, lp: L.lp, cp: L.cp, lc: L.lc, lv: L.lv };
      if (fo.hubs) f.hc = cascadeOf(cascadeTafs.map((t) => (t ? hubPack(tafSummary(t, t0, null)) : null)));
      if (fo.programs) f.pg = programState({ faa, atcscc, opsplan }, t0, +now);
      if (fo.volume) Object.assign(f, volumeAt(model.vol, iata, lp.mo, lp.dw, lp.h));
      p = calibrate(model.cal, modelRaw(model, encode(f, b, fo), typ?.p ?? model.base ?? 0.15));
      minutes = minutesFor(model, iata, p);
    } else {
      const lvl = w ? w.l : hr.level;
      const row = fallback.levels[b] || fallback.levels.all;
      p = Array.isArray(row) ? row[Math.max(0, Math.min(4, lvl))] : null;
      minutes = fallback.minutes?.[Math.max(0, Math.min(4, lvl))] ?? null;
    }
    const d = {
      p: r2(p), pTypical: typ ? r2(typ.p) : null, minutes: r5(minutes),
      analog: analogFor(analogs, iata, w, lp.h, lp.mo), basis: useModel ? "model" : "fallback", lead: b,
      modelCoverage: (useModel ? model.airports?.includes(iata) || Object.hasOwn(model.w || {}, `ap:${iata}`) : typ && typ.scope !== "pooled") ? "airport" : "pooled",
    };
    if (typ && typ.scope !== "hour") d.typicalScope = typ.scope;
    const x = ov[i];
    if (x) {
      if (x.floor) {
        if (d.p == null || x.p > d.p) { d.p = r2(x.p); d.override = x.override; d.rateFrom = x.rateFrom; }
      } else {
        d.p = 1;
        d.override = x.override;
        if (x.minutes != null) { d.minutes = r5(x.minutes); d.minutesFrom = "faa"; }
      }
    }
    return d;
  });
}

/** Summary of what scored the hours, for status.json `delayModel`. */
export function modelInfo(model, fallback) {
  const d = (x) => (x ? String(x).slice(0, 10) : null); // date only
  if (modelOk(model)) return { basis: "model", updated: d(model.trained), since: model.since || null, months: model.months || null, through: model.through || null };
  if (fallbackOk(fallback)) return { basis: "fallback", updated: d(fallback.built), since: fallback.since || null, months: fallback.months || null, through: fallback.through || null, source: fallback.source || null };
  return null;
}
