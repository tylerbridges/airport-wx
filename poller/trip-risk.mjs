// Trip concerns: what may affect each upcoming flight, from the airports' status.json entries.
// Pure ES module with no imports; site/trip-risk.js is a byte-identical copy used by the page
// (after editing: cp poller/trip-risk.mjs site/trip-risk.js; a test fails if they differ).
//
//   tripStatus(trip, byIata, {now}) -> {status, label, level, top, concerns, legs, sides, unknown}
//     trip: {legs: [{from, to, dep, arr}]} (ISO or ms); byIata(code) -> status.json airport or null.
//
// Per leg (README "Trips"):
//   - departure airport around the departure time (±1 h) and arrival airport around the arrival time
//     (±1 h): weather level and reasons, plus the delay chance when hours[i].delay exists (Phase 3);
//   - FAA programs that hit this flight: a ground delay program or ground stop at the ARRIVAL airport
//     holds the flight at its origin (checked at the departure time); a ground stop, closure,
//     departure delays, a possible ground stop or delay program, staffing or FAA-reported delays at
//     the departure airport at the departure time; arrival delays, closure, possible programs and
//     staffing at the arrival airport at the arrival time;
//   - connections: a tight connection (< 60 min domestic, < 90 international) is flagged when the
//     connecting airport is Moderate or worse around the arrival, or has a delay program.
// Each concern is one plain sentence with a level (0–4); concerns are ordered by severity.
// Status: "On track" (≤ Minor), "Possible delays" (Moderate), "Delays likely" (High), "Disruption"
// (Severe); "Too early to tell" when no flight time is inside the airports' 24-hour forecasts yet.

const HOUR = 3600e3;
const MIN = 60e3;
export const LEVEL_LABELS = ["Clear", "Minor", "Moderate", "High", "Severe"];
export const STATUS = {
  ok: { label: "On track", cls: "l0" },
  possible: { label: "Possible delays", cls: "l2" },
  likely: { label: "Delays likely", cls: "l3" },
  disruption: { label: "Disruption", cls: "l4" },
  early: { label: "Too early to tell", cls: "off" },
  done: { label: "Arrived", cls: "off" },
};
export const TIGHT_DOMESTIC_MIN = 60;
export const TIGHT_INTL_MIN = 90;
const US = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "GU", "VI", "AS", "MP", "US"]);

const toMs = (v) => (v == null ? null : typeof v === "number" ? v : Date.parse(v));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// lowercase the first letter mid-sentence, except names: "FAA …", "Winter Storm Warning …"
const lower = (s) => (s && !/^[A-Z]{2,}|\b(Warning|Advisory|Watch|Statement)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// ---------- time words ----------

const fmtCache = new Map();
function fmt(tz, opts, key) {
  const k = (tz || "UTC") + key;
  if (!fmtCache.has(k)) {
    let f;
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", ...opts }); } catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }); }
    fmtCache.set(k, f);
  }
  return fmtCache.get(k);
}
const tidy = (s) => s.replace(/[  ]/g, " ");
/** "6:05 PM", "7 PM". */
export function clockText(ms, tz) {
  return tidy(fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "hm").format(ms)).replace(":00 ", " ");
}
const dayKey = (ms, tz) => fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(ms);
/** "6:05 PM" within 18 hours (or the same day), "Mon 6:05 PM" within a week, else "Oct 12 6:05 PM" — in the airport's zone. */
export function whenText(ms, tz, now) {
  const c = clockText(ms, tz);
  if (Math.abs(ms - now) < 18 * HOUR || dayKey(ms, tz) === dayKey(now, tz)) return c;
  if (Math.abs(ms - now) < 6 * 24 * HOUR) return fmt(tz, { weekday: "short" }, "wd").format(ms) + " " + c;
  return tidy(fmt(tz, { month: "short", day: "numeric" }, "md").format(ms)) + " " + c;
}
/** "6:30–7:15 PM", "11:30 PM–12:15 AM". */
export function rangeText(a, b, tz) {
  const x = clockText(a, tz), y = clockText(b, tz);
  return x.slice(-2) === y.slice(-2) ? x.slice(0, -3) + "–" + y : x + "–" + y;
}
/** "1 hr 10 min", "45 min". */
export function minutesText(m) {
  const n = Math.round(m);
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} hr${n % 60 ? " " + (n % 60) + " min" : ""}`;
}

// ---------- reasons ----------

const mph = (kt) => Math.round((Number(kt) * 1.15) / 5) * 5;
function visNum(v) {
  let n = 0;
  for (const p of String(v).trim().split(/\s+/)) {
    if (p.includes("/")) { const [x, y] = p.split("/").map(Number); n += y ? x / y : 0; } else n += Number(p) || 0;
  }
  return n;
}
/** A coded risk reason in traveler words (same mapping as the page); null when not worth showing. */
export function plainReason(r) {
  let s = String(r || "");
  if (/^Convective SIGMET over airport/.test(s)) return "Thunderstorms over the airport";
  const c = /^(Chance of )?[Cc]eiling ([\d,]+) ft(.*)$/.exec(s);
  if (c) {
    const ft = Number(c[2].replace(/,/g, ""));
    if (ft >= 1000) return null;
    const w = ft < 500 ? "very low clouds" : "low clouds";
    return (c[1] ? "Chance of " + w : cap(w)) + c[3];
  }
  s = s.replace(/\b([Vv])isibility ((?:\d+ )?\d+(?:\/\d+)?) sm\b/g, (all, V, v) =>
    visNum(v) < 1 ? (V === "V" ? "Poor visibility" : "poor visibility") : `${V}isibility about ${v} ${visNum(v) === 1 ? "mile" : "miles"}`);
  s = s.replace(/\bThunderstorm gusts (\d+) kt\b/g, (all, n) => `Thunderstorm wind gusts to ${mph(n)} mph`);
  s = s.replace(/\b([Gg])usts (\d+) kt\b/g, (all, G, n) => `${G === "G" ? "Wind gusts" : "wind gusts"} to ${mph(n)} mph`);
  s = s.replace(/^Mist\b/, "Light fog / haze");
  s = s.replace(/^Center weather advisory: IFR conditions/, "Center weather advisory: low clouds or poor visibility");
  s = s.replace(/^Thunderstorms, (\w+) coverage \(TCF\)/, "Thunderstorms forecast, $1 coverage");
  s = s.replace(/ \((LAMP|TCF|ATCSCC)\)/g, "");
  s = s.replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/\b(\d+)h\b/g, "$1 hr").replace(/(\d)m\b/g, "$1 min");
  return s;
}

// FAA program reasons as risk.mjs writes them, with the level each scores.
const PROGRAM_RES = [
  [/^Ground stop\b/, "gs", 4],
  [/^Airport closed\b/, "closed", 4],
  [/^Ground delay program\b/, "gdp", 3],
  [/^Delays\b/, "delay", 2],
  [/^FAA plans a possible\b/, "possible", 2],
  [/^Air traffic control staffing shortage\b/, "staffing", 2],
  [/^FAA reports delays\b/, "note", 2],
];
/** {kind, level} when the reason is an FAA program (ground stop, GDP, delays, possible program, staffing). */
export function programOf(reason) {
  for (const [re, kind, level] of PROGRAM_RES) if (re.test(String(reason || ""))) return { kind, level };
  return null;
}

/** Level of one non-program reason (README "Risk levels"); "Chance of …" (PROB groups) counts one lower. */
export function reasonLevel(reason) {
  let s = String(reason || "");
  let drop = 0;
  if (/^Chance of /i.test(s)) { drop = 1; s = s.replace(/^Chance of /i, ""); s = cap(s); }
  let n = 1;
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1].replace(/,/g, "")) : null; };
  const ceil = num(/[Cc]eiling ([\d,]+) ft/);
  const vis = /[Vv]isibility ((?:\d+ )?\d+(?:\/\d+)?) sm/.exec(s);
  const gust = num(/[Gg]usts (\d+) kt/);
  const thunder = num(/Thunder chance (\d+)%/);
  if (/^(Heavy thunderstorms|Thunderstorm gusts|Freezing rain)|\b(Tornado|Blizzard|Ice Storm|Hurricane|Extreme Wind) Warning|^(Moderate|High) risk of severe/i.test(s)) n = 4;
  else if (/^(Thunderstorms|Heavy snow|Snow, visibility|Freezing drizzle|Ice pellets|Convective SIGMET)|^Enhanced risk|high coverage|\b(Severe Thunderstorm|Winter Storm|Tropical Storm|High Wind) Warning/i.test(s)) n = 3;
  else if (/^(Snow|Storms likely)|^Slight risk|medium coverage|^Center weather advisory|\b(Winter Weather|Wind|Dense Fog) Advisory/i.test(s)) n = 2;
  if (ceil != null) n = Math.max(n, ceil < 500 ? 3 : ceil < 1000 ? 2 : 1);
  if (vis) { const v = visNum(vis[1]); n = Math.max(n, v < 1 ? 3 : v < 3 ? 2 : 1); }
  if (gust != null) n = Math.max(n, gust >= 45 ? 4 : gust >= 35 ? 3 : gust >= 25 ? 2 : 1);
  if (thunder != null) n = Math.max(n, thunder >= 40 ? 3 : thunder >= 20 ? 2 : 1);
  return Math.max(1, n - drop);
}

/** Phase 3 delay model on an hour (hours[i].delay = {p 0..1, minutes, override?}, or a bare number); else null. */
export function delayOf(hr) {
  const d = hr && hr.delay;
  if (d == null) return null;
  const p = typeof d === "number" ? d : typeof d === "object" ? (d.p ?? d.chance ?? d.prob ?? null) : null;
  if (p == null || !Number.isFinite(Number(p))) return null;
  const pp = Number(p) > 1 ? Number(p) / 100 : Number(p);
  return { p: Math.max(0, Math.min(1, pp)), minutes: typeof d === "object" ? d.minutes ?? null : null, override: typeof d === "object" ? d.override ?? null : null };
}

/** Weather-only level of one hour: the hour's level unless FAA programs set it, then the strongest weather reason (capped). */
function hourWx(hr) {
  const reasons = hr.reasons || [];
  const progs = reasons.map(programOf).filter(Boolean);
  const wx = reasons.filter((r) => !programOf(r));
  const progLevel = Math.max(0, ...progs.map((p) => p.level));
  const wxLevel = hr.level > progLevel ? hr.level : Math.min(hr.level, Math.max(0, ...wx.map(reasonLevel)));
  return { wx, wxLevel, progs };
}

/**
 * The airport around [t0, t1] (an hour either side of a flight time): {level (all rules), wxLevel,
 * reasons (plain weather reasons, strongest first), programs, delay, hours} or null when no hour of
 * the airport's 24-hour forecast covers it.
 */
export function windowAt(a, t0, t1 = t0) {
  if (!a || !Array.isArray(a.hours) || !a.hours.length) return null;
  const lo = t0 - HOUR, hi = t1 + HOUR;
  const rows = a.hours.filter((h) => { const s = Date.parse(h.t); return s < hi && s + HOUR > lo; });
  if (!rows.length) return null;
  let level = 0, wxLevel = 0, delay = null;
  const scored = [];
  rows.forEach((h, i) => {
    level = Math.max(level, h.level | 0);
    const w = hourWx(h);
    wxLevel = Math.max(wxLevel, w.wxLevel);
    w.wx.forEach((r, k) => scored.push({ r, lv: Math.min(w.wxLevel || 1, reasonLevel(r)), i, k }));
    const d = delayOf(h);
    if (d && (!delay || d.p > delay.p)) delay = d;
  });
  scored.sort((x, y) => y.lv - x.lv || x.i - y.i || x.k - y.k);
  const reasons = [];
  for (const x of scored) { const p = plainReason(x.r); if (p && !reasons.includes(p)) reasons.push(p); }
  return { level, wxLevel, reasons, delay, hours: rows };
}

// ---------- FAA programs at a time ----------

const PROGRAM_NAME = { gs: "ground stop", gdp: "ground delay program", closed: "closure" };
/** "avg 52m" / "avg 1h 10m" -> minutes. */
function avgMinutes(detail) {
  const m = /avg ([^,]+)/.exec(detail || "");
  if (!m) return null;
  const h = /(\d+)\s*h/.exec(m[1]);
  const mm = /(\d+)\s*m/.exec(m[1]);
  const n = (h ? +h[1] * 60 : 0) + (mm ? +mm[1] : 0);
  return n || null;
}
/** The programs (from hour reasons) in force at time t at airport a, with details from a.faa / a.atcscc / a.opsplan. */
export function programsAt(a, t) {
  if (!a || !Array.isArray(a.hours) || !a.hours.length) return [];
  let hr = a.hours.find((h) => { const s = Date.parse(h.t); return t >= s && t < s + HOUR; });
  if (!hr && t < Date.parse(a.hours[0].t)) hr = a.hours[0];
  if (!hr) return [];
  const out = [];
  for (const r of hr.reasons || []) {
    const p = programOf(r);
    if (!p || out.some((x) => x.kind === p.kind)) continue;
    const x = { kind: p.kind, level: p.level, reason: r, until: null, avg: null, detail: null };
    const faaType = { gs: "ground_stop", gdp: "ground_delay", delay: "delay", closed: "closure" }[p.kind];
    const f = (a.faa || []).find((f) => f.type === faaType);
    const adv = (a.atcscc || []).find((v) => v.active && v.type === (p.kind === "gs" ? "GS" : p.kind === "gdp" ? "GDP" : ""));
    const item = ((a.opsplan && a.opsplan.items) || []).find((i) => i.text === r || (i.level > 0 && i.kind === "program" && r.startsWith(i.text)));
    x.until = toMs((f && f.end) || (adv && adv.end) || (item && item.until)) ?? null;
    if (f) { x.detail = f.detail || null; x.avg = avgMinutes(f.detail); }
    out.push(x);
  }
  return out;
}

/** " until 8 PM" (from the program's end, in the airport's zone), "" when open-ended. */
function untilText(p, tz, now) {
  if (p.until == null) {
    const m = /until ([^,]+?)(?: [A-Z]{1,4}T)?(?:,|$| —)/.exec(p.reason || "");
    return m && !/further notice/.test(m[1]) ? ` until ${m[1]}` : "";
  }
  return ` until ${whenText(p.until, tz, now)}`;
}
/** "Departures 16–30m, increasing; Arrivals 31–45m" -> {dep: "16–30 min", arr: "31–45 min"} (either may be null). */
function delayParts(detail) {
  const out = { dep: null, arr: null };
  for (const part of String(detail || "").split(/;\s*/)) {
    const m = /^(Arrivals\/Departures|Arrivals|Departures|Delays)\s*([\d–-]+\s*(?:h\s*)?\d*m?)?/.exec(part.trim());
    if (!m) continue;
    const span = m[2] ? m[2].replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/(\d)m\b/g, "$1 min").trim() : "";
    if (/Departures|Delays/.test(m[1])) out.dep = out.dep || span || "some";
    if (/Arrivals|Delays/.test(m[1])) out.arr = out.arr || span || "some";
  }
  return out;
}

// ---------- concerns ----------

function isIntl(a) { return !!(a && a.state && !US.has(a.state)); }

/**
 * Concerns and status for one trip. byIata(code) -> status.json airport (or null). now: ms.
 * Returns {status, label, cls, level, top, concerns: [{level, text, short, kind, side, iata, leg}],
 *          legs: [{from, to, dep, arr, depAt, arrAt, conn}], sides: {dep, arr, conn}, unknown: [...], missing: [...]}.
 */
export function tripStatus(trip, byIata, { now = Date.now() } = {}) {
  const legs = (trip.legs || []).map((l) => ({ from: l.from, to: l.to, dep: toMs(l.dep), arr: toMs(l.arr) })).sort((x, y) => x.dep - y.dep);
  const get = typeof byIata === "function" ? byIata : (c) => (byIata && byIata[c]) || null;
  const concerns = [];
  const unknown = [];
  const missing = [];
  const seen = new Set();
  const add = (c) => {
    const key = c.key || c.text;
    if (seen.has(key)) return;
    seen.add(key);
    concerns.push(c);
  };
  const tzOf = (code) => (get(code) && get(code).tz) || "UTC";
  const legOut = [];
  const done = legs.length && legs[legs.length - 1].arr < now - 30 * MIN;
  let known = 0;

  legs.forEach((leg, i) => {
    const F = get(leg.from), X = get(leg.to);
    const prev = legs[i - 1], next = legs[i + 1];
    const connIn = !!(prev && prev.to === leg.from);
    const connOut = !!(next && next.from === leg.to);
    const departed = leg.dep < now - 15 * MIN;
    const landed = leg.arr < now - 15 * MIN;
    const depWin = F ? windowAt(F, leg.dep) : null;
    const arrWin = X ? windowAt(X, leg.arr) : null;
    const out = {
      from: leg.from, to: leg.to, dep: leg.dep, arr: leg.arr, departed, landed,
      depAt: depWin ? { level: depWin.level, reason: depWin.reasons[0] || null, delay: depWin.delay } : null,
      arrAt: arrWin ? { level: arrWin.level, reason: arrWin.reasons[0] || null, delay: arrWin.delay } : null,
      conn: null,
    };
    legOut.push(out);
    if (!F && !missing.includes(leg.from)) missing.push(leg.from);
    if (!X && !missing.includes(leg.to)) missing.push(leg.to);
    if (landed) return;
    const depClock = F ? whenText(leg.dep, F.tz, now) : null;
    const arrClock = X ? whenText(leg.arr, X.tz, now) : null;
    const route = `${leg.from}→${leg.to}`;

    // weather around the departure (a connection's departure is covered by the connection window)
    if (F && !departed && !connIn) {
      if (depWin) { known++; weather(F, depWin, `around your ${depClock} departure`, "dep", i); }
      else unknown.push({ iata: leg.from, at: leg.dep, what: "departure" });
    }
    // weather around the arrival, or across the connection
    if (X && !connOut) {
      if (arrWin) { known++; weather(X, arrWin, `around your ${arrClock} arrival`, "arr", i); }
      else unknown.push({ iata: leg.to, at: leg.arr, what: "arrival" });
    }
    if (X && connOut) {
      const w = windowAt(X, leg.arr, next.dep);
      const span = rangeText(leg.arr, next.dep, X.tz);
      if (w) { known++; weather(X, w, `during your connection (${span})`, "conn", i); }
      else unknown.push({ iata: leg.to, at: leg.arr, what: "connection" });
    }

    // FAA programs that hit this flight
    if (!departed) {
      // at the arrival airport, at the departure time: flights to it are held at their origin
      if (X) for (const p of programsAt(X, leg.dep)) {
        const until = untilText(p, X.tz, now);
        if (p.kind === "gdp") {
          add({ level: 3, kind: "program", side: "dep", iata: leg.to, leg: i, key: `gdp-${leg.to}-${i}`, short: `${leg.to} ground delay program`,
            text: `${leg.to} ground delay program: flights to ${leg.to} are held — your ${depClock} ${route} departure may wait${p.avg ? " ~" + minutesText(p.avg) : " at the gate"}.` });
        } else if (p.kind === "gs") {
          add({ level: 4, kind: "program", side: "dep", iata: leg.to, leg: i, key: `gs-${leg.to}-${i}`, short: `${leg.to} ground stop`,
            text: `${leg.to} ground stop${until}: flights to ${leg.to} are held at their departure airports — your ${depClock} ${route} departure may not leave until it lifts.` });
        } else if (p.kind === "possible") {
          const m = /^FAA plans a possible (.+?)( until [^(]+)?\s*(\([^)]*\))?$/.exec(p.reason);
          add({ level: 2, kind: "program", side: "dep", iata: leg.to, leg: i, key: `possible-${leg.to}-${i}`, short: `possible ${m ? m[1] : "ground stop"} at ${leg.to}`,
            text: `FAA plans a possible ${m ? m[1] : "ground stop"} at ${leg.to}${m && m[2] ? m[2].trimEnd() : ""}${m && m[3] ? " " + m[3] : ""} — your ${depClock} ${route} flight could be held before takeoff.` });
        }
      }
      // at the departure airport, at the departure time
      if (F) for (const p of programsAt(F, leg.dep)) {
        const until = untilText(p, F.tz, now);
        const side = connIn ? "conn" : "dep";
        if (p.kind === "gs") {
          add({ level: 4, kind: "program", side, iata: leg.from, leg: i, key: `gsdep-${leg.from}-${i}`, short: `${leg.from} ground stop`,
            text: `${leg.from} ground stop${until} — flights at ${leg.from} are disrupted and your ${depClock} departure may be delayed.` });
        } else if (p.kind === "closed") {
          add({ level: 4, kind: "program", side, iata: leg.from, leg: i, key: `closed-${leg.from}`, short: `${leg.from} closed`,
            text: `${leg.from} is closed — your ${depClock} departure may be delayed or cancelled.` });
        } else if (p.kind === "delay") {
          const d = delayParts(p.detail || p.reason.replace(/^Delays[^,]*,\s*/, ""));
          if (d.dep) add({ level: 2, kind: "program", side, iata: leg.from, leg: i, key: `depdelay-${leg.from}`, short: `departure delays at ${leg.from}`,
            text: `Departure delays at ${leg.from}${d.dep !== "some" ? " (" + d.dep + ")" : ""} — your ${depClock} departure may leave late.` });
        } else if (p.kind === "gdp") {
          add({ level: 1, kind: "program", side, iata: leg.from, leg: i, key: `gdpdep-${leg.from}`, short: `${leg.from} ground delay program`,
            text: `${leg.from} has a ground delay program for arriving flights — departures usually aren't held, but your plane may arrive late for your ${depClock} departure.` });
        } else if (p.kind === "possible") {
          const m = /^FAA plans a possible (.+?)( until [^(]+)?\s*(\([^)]*\))?$/.exec(p.reason);
          add({ level: 2, kind: "program", side, iata: leg.from, leg: i, key: `possibledep-${leg.from}`, short: `possible ${m ? m[1] : "ground stop"} at ${leg.from}`,
            text: `FAA plans a possible ${m ? m[1] : "ground stop"} at ${leg.from}${m && m[2] ? m[2].trimEnd() : ""}${m && m[3] ? " " + m[3] : ""} — your ${depClock} departure could be delayed.` });
        } else if (p.kind === "staffing") {
          add({ level: 2, kind: "program", side, iata: leg.from, leg: i, key: `staff-${leg.from}`, short: `air traffic control staffing at ${leg.from}`,
            text: `Air traffic control staffing shortage at ${leg.from}${until} — your ${depClock} departure may be delayed.` });
        } else if (p.kind === "note") {
          add({ level: 2, kind: "program", side, iata: leg.from, leg: i, key: `note-${leg.from}`, short: `FAA-reported delays at ${leg.from}`,
            text: `FAA reports delays at ${leg.from} — your ${depClock} departure may be delayed.` });
        }
      }
    }
    // at the arrival airport, at the arrival time
    if (X) for (const p of programsAt(X, leg.arr)) {
      const side = connOut ? "conn" : "arr";
      if (p.kind === "closed") {
        add({ level: 4, kind: "program", side, iata: leg.to, leg: i, key: `closed-${leg.to}`, short: `${leg.to} closed`,
          text: `${leg.to} is closed — your ${arrClock} arrival may be diverted or cancelled.` });
      } else if (p.kind === "delay") {
        const d = delayParts(p.detail || p.reason.replace(/^Delays[^,]*,\s*/, ""));
        if (d.arr) add({ level: 2, kind: "program", side, iata: leg.to, leg: i, key: `arrdelay-${leg.to}`, short: `arrival delays at ${leg.to}`,
          text: `Arrival delays at ${leg.to}${d.arr !== "some" ? " (" + d.arr + ")" : ""} — your ${arrClock} arrival may be late.` });
      } else if (p.kind === "staffing") {
        add({ level: 2, kind: "program", side, iata: leg.to, leg: i, key: `staff-${leg.to}`, short: `air traffic control staffing at ${leg.to}`,
          text: `Air traffic control staffing shortage at ${leg.to}${untilText(p, X.tz, now)} — your ${arrClock} arrival may be delayed.` });
      } else if (p.kind === "note") {
        add({ level: 2, kind: "program", side, iata: leg.to, leg: i, key: `note-${leg.to}`, short: `FAA-reported delays at ${leg.to}`,
          text: `FAA reports delays at ${leg.to} — your ${arrClock} arrival may be late.` });
      } else if (departed && (p.kind === "gs" || p.kind === "gdp")) {
        // already in the air: the program no longer holds this flight, but arrivals are being metered
        add({ level: 2, kind: "program", side, iata: leg.to, leg: i, key: `airborne-${leg.to}-${i}`, short: `${leg.to} ${PROGRAM_NAME[p.kind]}`,
          text: `${leg.to} ${PROGRAM_NAME[p.kind]} in effect — arrivals are slowed, so your ${arrClock} arrival may be late.` });
      }
    }

    // connection
    if (connOut && X) {
      const connMin = Math.round((next.dep - leg.arr) / MIN);
      const intl = isIntl(F) || isIntl(X) || isIntl(get(next.to));
      const tight = intl ? TIGHT_INTL_MIN : TIGHT_DOMESTIC_MIN;
      const w = windowAt(X, leg.arr);
      const progs = [...programsAt(X, leg.dep), ...programsAt(X, leg.arr)].filter((p) => p.kind === "gs" || p.kind === "gdp" || p.kind === "delay" || p.kind === "closed");
      out.conn = { iata: leg.to, minutes: connMin, tight: connMin < tight, level: w ? w.level : null };
      const nextClock = whenText(next.dep, X.tz, now);
      if (connMin < tight && ((w && w.level >= 2) || progs.length)) {
        const p = progs.sort((x, y) => y.level - x.level)[0];
        const why = p ? `${leg.to} has ${p.kind === "delay" ? "delays" : p.kind === "closed" ? "a closure" : "a " + PROGRAM_NAME[p.kind]} in effect`
          : `${leg.to} is at ${LEVEL_LABELS[w.level]} risk around then${w.reasons[0] ? " (" + lower(w.reasons[0]) + ")" : ""}`;
        const level = p && (p.kind === "gs" || p.kind === "closed") ? 4 : (p && p.kind === "gdp") || (w && w.level >= 3) ? 3 : 2;
        add({ level, kind: "connection", side: "conn", iata: leg.to, leg: i, key: `conn-${i}`, short: `tight connection at ${leg.to}`,
          text: `Tight connection at ${leg.to}: ${connMin} min to make your ${nextClock} flight to ${next.to}, and ${why} — a late arrival could mean a missed connection.` });
      } else if (connMin < tight / 2 && connMin >= 0) {
        add({ level: 1, kind: "connection", side: "conn", iata: leg.to, leg: i, key: `conn-${i}`, short: `short connection at ${leg.to}`,
          text: `Short connection at ${leg.to}: ${connMin} min to make your ${nextClock} flight to ${next.to}.` });
      }
    }
  });

  function weather(A, w, when, side, legIdx) {
    const d = w.delay && !w.delay.override && w.delay.p >= 0.2 ? w.delay : null;
    const pct = d ? Math.round(d.p * 100) : null;
    if (w.wxLevel >= 1) {
      const reason = w.reasons[0] || (w.wxLevel ? "Minor weather" : "");
      add({ level: w.wxLevel, kind: "weather", side, iata: A.iata, leg: legIdx, key: `wx-${A.iata}-${side}-${legIdx}`, short: `${lower(reason)} at ${A.iata}`,
        text: `${cap(reason)} at ${A.iata} ${when}${pct != null ? ` — about ${pct}% chance of delays` : ""}.` });
    } else if (pct != null && pct >= 35) {
      add({ level: pct >= 50 ? 2 : 1, kind: "weather", side, iata: A.iata, leg: legIdx, key: `wx-${A.iata}-${side}-${legIdx}`, short: `delays possible at ${A.iata}`,
        text: `About ${pct}% chance of delays at ${A.iata} ${when}.` });
    }
  }

  const order = { program: 0, connection: 1, weather: 2, note: 3 };
  concerns.sort((x, y) => y.level - x.level || (order[x.kind] ?? 9) - (order[y.kind] ?? 9) || x.leg - y.leg);
  for (const code of missing) {
    concerns.push({ level: 0, kind: "note", side: null, iata: code, leg: -1, short: `no data for ${code}`,
      text: `No FAA or weather data for ${code} in this update yet.` });
  }
  const level = Math.max(0, ...concerns.map((c) => c.level));
  let key = level >= 4 ? "disruption" : level === 3 ? "likely" : level === 2 ? "possible" : "ok";
  if (done) key = "done";
  else if (!known && level < 2 && legs.length) key = "early";
  const first = legs[0];
  const top = done ? "This trip has landed."
    : concerns[0] && concerns[0].level >= 1 ? concerns[0].text
    : key === "early" ? `Airport forecasts cover the next 24 hours — check back after ${first ? whenText(first.dep - 24 * HOUR, tzOf(first.from), now) : "tomorrow"}.`
    : unknown.length ? `No issues expected so far; the forecast for your ${unknown[0].what} at ${unknown[0].iata} isn't out yet.`
    : "No weather or FAA issues expected around your flight times.";
  const side = (s) => Math.max(0, ...concerns.filter((c) => c.side === s).map((c) => c.level));
  return {
    status: key, label: STATUS[key].label, cls: STATUS[key].cls, level, top,
    short: concerns[0] && concerns[0].level >= 1 ? concerns[0].short : null,
    concerns, legs: legOut, unknown, missing,
    sides: { dep: side("dep"), arr: side("arr"), conn: legs.length > 1 ? side("conn") : null },
  };
}

/** Where an airport sits in a trip: [{role: "dep"|"arr"|"conn", leg, at, other}] (other = the far end). */
export function rolesAt(trip, iata) {
  const legs = (trip.legs || []).map((l) => ({ ...l, dep: toMs(l.dep), arr: toMs(l.arr) })).sort((x, y) => x.dep - y.dep);
  const out = [];
  legs.forEach((l, i) => {
    const next = legs[i + 1];
    const prev = legs[i - 1];
    if (l.from === iata && !(prev && prev.to === iata)) out.push({ role: "dep", leg: i, at: l.dep, other: l.to });
    if (l.to === iata && next && next.from === iata) out.push({ role: "conn", leg: i, at: l.arr, until: next.dep, other: next.to });
    else if (l.to === iata) out.push({ role: "arr", leg: i, at: l.arr, other: l.from });
  });
  return out;
}

/** "Your 6:05 PM departure to ORD: delays likely — ORD ground delay program" for an airport sheet. */
export function flightLine(trip, result, iata, tz, now) {
  return rolesAt(trip, iata).map((r) => {
    const when = whenText(r.at, tz, now);
    const what = r.role === "dep" ? `Your ${when} departure to ${r.other}`
      : r.role === "arr" ? `Your ${when} arrival from ${r.other}`
      : `Your connection here (${rangeText(r.at, r.until, tz)}) to ${r.other}`;
    const state = result.status === "ok" ? "on track" : result.label.toLowerCase();
    return { ...r, text: `${what}: ${state}${result.short && result.status !== "ok" && result.status !== "early" ? " — " + result.short : ""}` };
  });
}

// ---------- privacy (check page + tests) ----------

// Strings that must never appear in the published trips.json.
export const PRIVACY_RE = {
  flightNo: /(?:^|[^A-Za-z0-9])(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}[A-Z]?(?![A-Za-z0-9:])/,
  email: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
};

/**
 * Privacy check for a trips.json object: only the allowed keys, airport codes, ISO times, hex ids
 * and short status words; no flight-number pattern, email or free text (names). Returns a list of problems.
 */
export function privacyProblems(doc) {
  const bad = [];
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/;
  const TOP = new Set(["generated", "configured", "ok", "error", "source", "trips", "count", "flights"]);
  for (const [k, v] of Object.entries(doc || {})) {
    if (!TOP.has(k)) bad.push(`unexpected key ${k}`);
    if (k === "error" && v != null && (typeof v !== "string" || v.length > 120 || PRIVACY_RE.email.test(v) || /https?:|webcal:|icloud|\/published\//i.test(v))) bad.push("error text looks unsafe");
    if (k === "source" && v != null && !/^(calendar|fixture)$/.test(v)) bad.push("unexpected source");
  }
  for (const t of doc?.trips || []) {
    for (const k of Object.keys(t)) if (k !== "id" && k !== "legs") bad.push(`trip key ${k}`);
    if (!/^[0-9a-f]{8,64}$/.test(String(t.id))) bad.push("trip id isn't a hex hash");
    for (const l of t.legs || []) {
      for (const [k, v] of Object.entries(l)) {
        if (k === "from" || k === "to") { if (!/^[A-Z]{3}$/.test(v)) bad.push(`leg ${k} isn't an airport code`); }
        else if (k === "dep" || k === "arr") { if (!ISO.test(v)) bad.push(`leg ${k} isn't an ISO time`); }
        else bad.push(`leg key ${k}`);
      }
    }
  }
  // the whole file as text, minus ISO times and hex ids (checked above): no flight number or email anywhere
  const text = JSON.stringify(doc ?? null, (k, v) => (typeof v === "string" && (ISO.test(v) || (k === "id" && /^[0-9a-f]+$/.test(v))) ? "" : v));
  if (PRIVACY_RE.email.test(text)) bad.push("email address");
  if (PRIVACY_RE.flightNo.test(text)) bad.push("flight-number pattern");
  return [...new Set(bad)];
}
