// Pure risk-scoring functions. No I/O, no globals except Intl. Documented in README.
// Levels: 0 None, 1 Low, 2 Moderate, 3 High, 4 Severe.
import { causePhrase, classifyCause } from "./cause.mjs";

export const LEVEL_NAMES = ["None", "Low", "Moderate", "High", "Severe"];
const HOUR = 3600e3;

// ---------- small helpers ----------

export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v; // epoch seconds or ms
  if (/^\d+(\.\d+)?$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function parseVisib(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().toUpperCase().replace(/SM$/, "").trim();
  if (s.startsWith("M")) s = s.slice(1);
  if (s.endsWith("+")) s = s.slice(0, -1);
  s = s.trim();
  if (!s) return null;
  let total = 0;
  for (const p of s.split(/\s+/)) {
    if (p.includes("/")) {
      const [a, b] = p.split("/").map(Number);
      if (!b || !Number.isFinite(a)) return null;
      total += a / b;
    } else {
      const n = Number(p);
      if (!Number.isFinite(n)) return null;
      total += n;
    }
  }
  return total;
}

export function fmtVis(v) {
  if (v == null) return "";
  const frac = { 0.125: "1/8", 0.25: "1/4", 0.375: "3/8", 0.5: "1/2", 0.625: "5/8", 0.75: "3/4", 0.875: "7/8" };
  if (v >= 3) return String(Math.round(v * 10) / 10);
  const whole = Math.floor(v);
  const r = Math.round((v - whole) * 8) / 8;
  if (r === 0) return String(whole);
  if (r === 1) return String(whole + 1);
  return (whole ? whole + " " : "") + frac[r];
}

/** Lowest BKN/OVC/VV layer base in feet, or null. */
export function ceilingOf(clouds) {
  if (!Array.isArray(clouds)) return null;
  let best = null;
  for (const c of clouds) {
    if (!c) continue;
    const cover = String(c.cover || "").toUpperCase();
    if (!["BKN", "OVC", "VV", "OVX"].includes(cover)) continue;
    const base = Number(c.base);
    if (c.base == null || !Number.isFinite(base)) continue;
    if (best == null || base < best) best = base;
  }
  return best;
}

export function flightCategory(visSm, ceilFt) {
  const v = visSm == null ? Infinity : visSm;
  const c = ceilFt == null ? Infinity : ceilFt;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}

export function parseWx(wxString) {
  const out = [];
  if (!wxString) return out;
  for (const tok of String(wxString).trim().split(/\s+/)) {
    const m = /^(\+|-|VC)?([A-Z]+)$/.exec(tok.toUpperCase());
    if (!m || m[2].startsWith("RE")) continue; // skip recent weather (RERA) etc.
    out.push({ intensity: m[1] || "", codes: m[2].match(/.{1,2}/g) || [] });
  }
  return out;
}

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

// ---------- time formatting (airport-local) ----------

const clean = (s) => s.replace(/[  ]/g, " ");
const dtfCache = new Map();
function dtf(tz, opts, key) {
  const k = tz + "|" + key;
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }));
  return dtfCache.get(k);
}

/** "4 PM", "5:30 PM"; prefixed with "Sat " when the local date differs from ref's. */
export function fmtClock(date, tz, ref) {
  const d = new Date(date);
  let s = clean(dtf(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "hm").format(d)).replace(":00 ", " ");
  if (ref) {
    const day = (x) => dtf(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(x);
    if (day(d) !== day(new Date(ref))) s = dtf(tz, { weekday: "short" }, "wd").format(d) + " " + s;
  }
  return s;
}

export function tzAbbr(date, tz) {
  const p = dtf(tz, { timeZoneName: "short" }, "tzn").formatToParts(new Date(date)).find((x) => x.type === "timeZoneName");
  const n = p ? p.value : "";
  const map = { EDT: "ET", EST: "ET", CDT: "CT", CST: "CT", MDT: "MT", MST: "MT", PDT: "PT", PST: "PT", AKDT: "AKT", AKST: "AKT" };
  return map[n] || n;
}

const localDay = (ms, tz) => dtf(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(new Date(ms));

/**
 * [start, end) as "4–7 PM" (same day, same AM/PM half), "11 AM – 2 PM" (same day), or across days
 * "11 PM – 1 AM tomorrow" / "Sat 11 PM – 1 AM Sun". With ref, a start on another day than ref gets its weekday.
 */
export function fmtRange(start, end, tz, ref = null) {
  const a = fmtClock(start, tz, ref ?? start);
  const b = fmtClock(end, tz);
  const sameDay = localDay(start, tz) === localDay(end, tz);
  if (sameDay && a.split(" ").pop() === b.split(" ").pop()) return `${a.slice(0, a.lastIndexOf(" "))}–${b}`;
  if (sameDay) return `${a} – ${b}`;
  const r = ref ?? start;
  const tomorrow = localDay(end, tz) === localDay(+new Date(r) + 24 * HOUR, tz) && localDay(start, tz) === localDay(r, tz);
  return `${a} – ${b} ${tomorrow ? "tomorrow" : dtf(tz, { weekday: "short" }, "wd").format(new Date(end))}`;
}

// ---------- level mappings ----------

// TSTM (general thunderstorms) is informational only: it never sets a level.
export const SPC_LEVEL = { TSTM: 0, MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 4 };
const SPC_NAME = { MRGL: "Marginal", SLGT: "Slight", ENH: "Enhanced", MDT: "Moderate", HIGH: "High" };

export function spcLevel(cat) {
  return SPC_LEVEL[String(cat || "").toUpperCase()] || 0;
}
export function spcText(cat) {
  const c = String(cat).toUpperCase();
  return c === "TSTM" ? "General thunderstorms possible in the area (no severe risk)" : `${SPC_NAME[c] || c} risk of severe storms`;
}

const ALERT_LEVEL = [
  [4, /^(Tornado|Blizzard|Ice Storm|Hurricane|Extreme Wind) Warning$/i],
  [3, /^(Severe Thunderstorm|Winter Storm|Tropical Storm|High Wind) Warning$/i],
  [2, /^(Winter Weather|Wind|Dense Fog) Advisory$/i],
];
export function alertLevel(event) {
  const e = String(event || "").trim();
  for (const [lvl, re] of ALERT_LEVEL) if (re.test(e)) return lvl;
  return 0;
}

// ---------- scoring ----------

/**
 * Score one set of conditions (a METAR or a TAF state).
 * c: {wxString, visib, clouds, wspd, wgst}. Returns [{level, text}] sorted high to low.
 */
export function assessConditions(c) {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  const vis = parseVisib(c.visib);
  const ceil = ceilingOf(c.clouds);
  const gust = num(c.wgst);
  const wx = parseWx(c.wxString);
  const has = (w, code) => w.codes.includes(code);

  const ts = wx.find((w) => has(w, "TS"));
  const tsLocal = wx.find((w) => has(w, "TS") && w.intensity !== "VC");
  let precipFlag = false;
  if (ts) {
    precipFlag = true;
    if (ts.intensity === "+") add(4, "Heavy thunderstorms");
    else if (ts.intensity === "VC") add(3, "Thunderstorms nearby");
    else add(3, "Thunderstorms");
  }
  for (const w of wx) {
    if (has(w, "FZ") && has(w, "RA")) { add(4, "Freezing rain"); precipFlag = true; }
    else if (has(w, "FZ") && has(w, "DZ")) { add(3, "Freezing drizzle"); precipFlag = true; }
    if (has(w, "PL")) { add(3, "Ice pellets"); precipFlag = true; }
    if (has(w, "SN")) {
      precipFlag = true;
      if (w.intensity === "+") add(3, "Heavy snow");
      else if (vis != null && vis <= 0.5) add(3, `Snow, visibility ${fmtVis(vis)} sm`);
      else add(2, "Snow");
    }
  }
  if (!precipFlag) {
    for (const w of wx) {
      if (has(w, "RA")) add(1, "Rain");
      else if (has(w, "DZ")) add(1, "Drizzle");
      else if (has(w, "BR")) add(1, "Mist");
    }
  }

  if (gust != null) {
    if (gust >= 45 && tsLocal) add(4, `Thunderstorm gusts ${gust} kt`);
    else if (gust >= 35) add(3, `Gusts ${gust} kt`);
    else if (gust >= 25) add(2, `Gusts ${gust} kt`);
  }

  if (ceil != null) {
    const lvl = ceil < 500 ? 3 : ceil < 1000 ? 2 : ceil <= 3000 ? 1 : 0;
    if (lvl) add(lvl, `Ceiling ${ceil.toLocaleString("en-US")} ft`);
  }
  if (vis != null) {
    const lvl = vis < 1 ? 3 : vis < 3 ? 2 : vis <= 5 ? 1 : 0;
    if (lvl) add(lvl, `Visibility ${fmtVis(vis)} sm`);
  }
  return dedupe(items);
}

// "Arrivals 31–45m; Departures 16–30m" -> "arrivals 31–45m; departures 16–30m"
const lowerFirstChar = (s) => (s ? s.replace(/(^|; )([A-Z])(?=[a-z])/g, (m, a, b) => a + b.toLowerCase()) : s);

/**
 * FAA NAS status program -> reason item. The level comes from the program type alone; the cause
 * (f.cause class + f.reason text) only names it. Closures: scope "full" is Severe, "runway" Low,
 * "limited" (closed only to some users, e.g. GA) and not-yet/no-longer active ones add nothing.
 */
export function assessFaa(f, { tz = null, now = new Date() } = {}) {
  const cause = f.type === "closure" ? closureCause(f) : causePhrase(f.cause, f.reason);
  // programs without a stated end: "until further notice"
  const open = PROGRAMS.has(f.type) && toMs(f.end) == null && !/\buntil\b/i.test(f.detail || "");
  const join = (name, detail) => [name + (cause ? " — " + cause : ""), detail, open ? "until further notice" : ""].filter(Boolean).join(", ");
  switch (f.type) {
    case "ground_stop":
      return { level: 4, text: cause ? join("Ground stop", f.detail) : `Ground stop${f.detail ? " " + f.detail : open ? " until further notice" : ""}`, fixed: true };
    case "closure": {
      if (f.active === false || f.scope === "limited") return null;
      if (f.scope === "runway") {
        const ids = (f.runways || []).join(", ");
        return { level: 1, text: ids ? `${(f.runways || []).length > 1 ? "Runways" : "Runway"} ${ids} closed` : "Runway closed", fixed: true };
      }
      // with the airport's zone and a known end (NOTAM end or Reopen): "Airport closed until 6 PM ET"
      const end = f.perm ? null : toMs(f.end);
      const detail = end != null && tz ? closureUntil(end, tz, now) : f.detail;
      return { level: 4, text: cause ? join("Airport closed", detail) : `Airport closed${detail ? " " + detail : ""}`, fixed: true };
    }
    case "ground_delay":
      return { level: 3, text: cause ? join("Ground delay program", f.detail) : `Ground delay program${f.detail ? " (" + f.detail + ")" : ""}${open ? ", until further notice" : ""}`, fixed: true };
    case "delay":
      return { level: 2, text: cause ? join("Delays", lowerFirstChar(f.detail)) : `Delays${f.detail ? ": " + f.detail : ""}${open ? ", until further notice" : ""}`, fixed: true };
    default:
      return null;
  }
}

const PROGRAMS = new Set(["ground_stop", "ground_delay", "delay"]);
/** Program with no stated end: held 3 h, 5 h when its delays are increasing. */
export const OPEN_PROGRAM_HOURS = 3;
export const OPEN_PROGRAM_HOURS_INCREASING = 5;

/** Hours an active FAA program scores: [now, its end), or a default span when it has none. Closures: hour 0. */
export function faaSpan(f, now) {
  if (!PROGRAMS.has(f.type)) return null;
  const end = toMs(f.end);
  if (end != null) return Math.max(end, +now);
  return +now + (f.trend === "increasing" ? OPEN_PROGRAM_HOURS_INCREASING : OPEN_PROGRAM_HOURS) * HOUR;
}

/** "until 6 PM ET" / "until Fri 6 AM ET" within a day of now, else "until Nov 4" (the airport's local date). */
function closureUntil(end, tz, now) {
  if (end - +now <= 24 * HOUR) return `until ${fmtClock(end, tz, now)} ${tzAbbr(end, tz)}`;
  return `until ${clean(dtf(tz, { month: "short", day: "numeric" }, "md").format(new Date(end)))}`;
}

/**
 * Effective window of a full airport closure (README "Risk levels"): {from, to} in ms, from its start
 * (NOTAM start, else already in effect) to its reopening (NOTAM end, else the FAA's Reopen time; Infinity
 * when permanent; null when no end is known, which scores hour 0 only). null for limited/runway closures
 * and for closures that are over (or inactive with no known end).
 */
export function closureSpan(f, now) {
  if (!f || f.type !== "closure" || (f.scope || "full") !== "full") return null;
  const from = toMs(f.start) ?? -Infinity;
  const to = f.perm ? Infinity : toMs(f.end);
  if (to != null && to <= +now) return null;
  if (to == null && f.active === false) return null;
  return { from, to };
}

// Closure reasons are NOTAM text: name a cause only when the text says one (e.g. "snow removal").
function closureCause(f) {
  const body = String(f.reason || "").replace(/^\s*!\S+\s+\d+\/\d+\s+\S+\s+/, "");
  const c = f.cause && f.cause !== "other" && f.cause !== "unknown" ? f.cause : classifyCause(body);
  if (c === "other" || c === "unknown" || /\bCLSD\b/i.test(body)) return "";
  return causePhrase(c, body);
}

/**
 * Active ATCSCC ground stop / GDP advisory -> reason item, unless the NAS status already lists the
 * same program for the airport (faa: [{type}]). a: {type: GS|GDP, active, end, cause, causeText}.
 */
export function assessAtcscc(a, faa, tz, now = new Date()) {
  if (!a || !a.active) return null;
  const kind = a.type === "GS" ? "ground_stop" : a.type === "GDP" ? "ground_delay" : null;
  if (!kind || (faa || []).some((f) => f.type === kind)) return null;
  const cause = causePhrase(a.cause, a.causeText);
  const end = toMs(a.end);
  const until = end != null ? `until ${fmtClock(end, tz, now)} ${tzAbbr(end, tz)}` : "";
  const name = kind === "ground_stop" ? "Ground stop" : "Ground delay program";
  const text = [name + (cause ? " — " + cause : ""), until].filter(Boolean).join(", ") + " (ATCSCC)";
  return { level: kind === "ground_stop" ? 4 : 3, text, fixed: true };
}

/** LAMP thunder (LP1 1-h lightning, else LP2) probability (%) -> level: >= 40 High, 20-39 Moderate. */
export function lampThunderLevel(p) {
  const n = num(p);
  return n == null ? 0 : n >= 40 ? 3 : n >= 20 ? 2 : 0;
}

/** LAMP CP1 convection probability (%) >= 50 -> Moderate (used only when the thunder chance is lower). */
export function lampConvLevel(p) {
  const n = num(p);
  return n != null && n >= 50 ? 2 : 0;
}

// ---------- FAA Command Center operations plan ----------

const PLAN_PHRASES = [
  [/\bVCTS\b/, "nearby storms", "storms"],
  [/\b(TS|TSTMS?|TSRA|THUNDERSTORMS?|CONVECT\w*|CB)\b/, "thunderstorms", "storms"],
  [/\b(WINDS?|CROSSWINDS?|GUSTS?|WIND SHEAR)\b/, "wind", "wind"],
  [/\b(LOW CIGS?|CIGS?|CEILINGS?|LOW CLOUDS?)\b/, "low clouds", "low clouds"],
  [/\b(LOW VIS\w*|VIS|VISIBILITY|FOG)\b/, "low visibility", "low visibility"],
  [/\b(SNOW|ICE|ICING|FREEZING|DEICING|DE-ICING)\b/, "winter weather", "winter weather"],
  [/\b(VOL|VOLUME|DEMAND)\b/, "heavy traffic", "heavy traffic"],
  [/\b(RWY|RUNWAYS?|CONSTRUCTION|CONFIG\w*)\b/, "runway work", "runway work"],
  [/\b(EQUIP\w*|OUTAGE|RADAR|ILS)\b/, "an equipment outage", "equipment outage"],
];
/** Terminal-constraint reason ("VCTS", "WIND", "LOW CIGS") -> {long, short} plain words. */
export function constraintPhrase(reason) {
  const s = String(reason ?? "").toUpperCase();
  for (const [re, long, short] of PLAN_PHRASES) if (re.test(s)) return { long, short };
  const w = s.trim().toLowerCase();
  return w ? { long: w, short: w } : null;
}

const MONTH_DAY = (tz) => dtf(tz, { month: "short", day: "numeric" }, "md");
/** " until 7 PM" (within a day), " until Nov 4" (later; the airport's local date), "" if none. */
function untilText(ms, tz, now) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms - +now <= 24 * HOUR) return ` until ${fmtClock(ms, tz, now)}`;
  return ` until ${clean(MONTH_DAY(tz).format(new Date(ms)))}`;
}
const normRwy = (r) => String(r).toUpperCase().replace(/(^|\/)0(\d)/g, "$1$2");
const PROGRAM_NAME = { GS: "ground stop", GDP: "ground delay program", "GS/GDP": "ground stop or delay program" };

/**
 * Items for one airport's slice of the ATCSCC operations plan (op = opsPlanFor(...)): [{kind, level,
 * text, cause, until, raw, at, from, to, dup?, ifr?}]. `at` says which hours the item scores:
 * "now" = hour 0 only, "span" = hours before `to`, "ifr" = Low only in hours before `to` whose
 * flight category is IFR/LIFR (level 0 = informational otherwise). Rules (README "Risk levels"):
 * active GS/GDP Severe/High unless NAS status or an active ATCSCC advisory already has it (then dup,
 * level 0); possible GS/GDP Moderate; staffing trigger Moderate; terminal constraint alone Low;
 * SIR runway closure/construction Low (never more); glideslope/ILS out of service or limited ops: "ifr";
 * a narrative sentence naming the airport with DELAY/DEVIATION Moderate until the plan's valid end.
 */
export function opsPlanItems(op, { faa = [], atcscc = [], tz = "UTC", now = new Date() } = {}) {
  if (!op) return [];
  const out = [];
  const active = (t) => (faa || []).some((f) => f.type === (t === "GS" ? "ground_stop" : "ground_delay"))
    || (atcscc || []).some((a) => a.active && a.type === t);
  // the NAS status program (else the active ATCSCC advisory) of a plan program: {cause, text}
  const statusCause = (t) => {
    for (const k of t === "GS/GDP" ? ["GS", "GDP"] : [t]) {
      const f = (faa || []).find((x) => x.type === (k === "GS" ? "ground_stop" : "ground_delay"));
      if (f) return { cause: f.cause, text: f.reason };
      const a = (atcscc || []).find((x) => x.active && x.type === k);
      if (a) return { cause: a.cause, text: a.causeText };
    }
    return null;
  };
  const con = (op.constraints || [])[0];
  const ph = con ? constraintPhrase(con.reason) : null;
  const conCause = con ? classifyCause(con.reason) : "unknown";
  for (const p of op.programs || []) {
    const name = PROGRAM_NAME[p.program];
    if (!name) continue;
    const to = toMs(p.until) ?? Infinity;
    const from = toMs(p.from) ?? -Infinity;
    const until = untilText(toMs(p.until), tz, now);
    if (p.status === "active") {
      const dup = p.program === "GS/GDP" ? active("GS") || active("GDP") : active(p.program);
      // The same program in the NAS status / an active advisory: its cause wins (BOS: NAS "runway construction" vs the
      // plan's terminal constraint "wind"); the plan's constraint stays only as `constraint` for the technical detail.
      const fc = dup ? statusCause(p.program) : null;
      const fcText = fc ? causePhrase(fc.cause, fc.text) : "";
      const Name = name.charAt(0).toUpperCase() + name.slice(1);
      const text = dup && fcText ? `${Name}${until} — ${fcText}` : Name + until + (ph ? ` (${ph.short})` : "");
      const cause = dup && fc && fc.cause && fc.cause !== "unknown" ? fc.cause : conCause;
      out.push({ kind: "program", level: dup ? 0 : p.program === "GS" ? 4 : 3, text, cause, until: p.until, raw: p.raw, at: "span", from, to, ...(dup ? { dup: true } : {}), ...(dup && fcText && ph ? { constraint: ph.long } : {}) });
    } else {
      const text = `FAA plans a possible ${name}${until} (${ph ? ph.short : "conditions"})`;
      out.push({ kind: "program", level: 2, text, cause: conCause, until: p.until, raw: p.raw, at: "span", from, to });
    }
  }
  // narrative: "ZJX REPORTS THAT TPA AND MCO ARE STILL EXPERIENCING SOME DEVIATIONS …, AND DELAYS WILL CONTINUE"
  const validEnd = toMs(op.plan?.validEnd);
  for (const n of op.notes || []) {
    const where = (n.airports || []).join("/");
    const text = `FAA reports ${n.possible ? "possible delays" : "delays"}${where ? " at " + where : ""}${n.continuing ? " expected to continue" : ""}`;
    const to = validEnd != null && validEnd > +now ? validEnd : +now + 2 * HOUR;
    out.push({ kind: "note", level: 2, text, cause: classifyCause(n.raw), until: null, raw: n.raw, at: "span", from: -Infinity, to });
  }
  for (const s of op.staffing || []) {
    const text = `Air traffic control staffing shortage${untilText(toMs(s.until), tz, now)} — delays possible`;
    out.push({ kind: "staffing", level: 2, text, cause: "staffing", until: s.until, raw: s.raw, at: "span", from: -Infinity, to: toMs(s.until) ?? Infinity });
  }
  // a terminal constraint alone is Low; with a program it only names the program's cause
  if (!out.some((x) => x.kind === "program")) {
    for (const c of op.constraints || []) {
      const w = constraintPhrase(c.reason);
      out.push({ kind: "constraint", level: 1, text: `FAA reports ${w ? w.long : "conditions"} affecting arrivals`, cause: c.cause || classifyCause(c.reason), until: null, raw: c.raw, at: "now", from: -Infinity, to: Infinity });
    }
  }
  const nasRwys = new Set((faa || []).filter((f) => f.type === "closure").flatMap((f) => f.runways || []).map(normRwy));
  for (const s of op.sirs || []) {
    const to = toMs(s.until) ?? Infinity;
    const until = untilText(toMs(s.until), tz, now);
    const rw = (s.runways || []).map(normRwy);
    const rwName = rw.length > 1 ? `Runways ${rw.slice(0, -1).join(", ")} and ${rw[rw.length - 1]}` : rw.length ? `Runway ${rw[0]}` : "";
    const base = { kind: "sir", cause: s.cause, until: s.until, raw: s.raw, from: -Infinity, to };
    if (rw.length && (s.status === "closed" || s.status === "construction") && s.what === "runway") {
      const dup = rw.every((r) => nasRwys.has(r));
      const text = `${rwName} ${s.status === "closed" ? "closed" : "construction"}${until}`;
      out.push({ ...base, level: dup ? 0 : 1, text, at: "now", ...(dup ? { dup: true } : {}) });
    } else if (rw.length && (s.what === "glideslope" || s.what === "ils" || s.status === "limited" || s.status === "out of service")) {
      const what = s.what === "glideslope" ? "glideslope out of service" : s.what === "ils" ? "ILS out of service" : s.status === "limited" ? "limited operations" : "out of service";
      out.push({ ...base, level: 0, text: `${rwName} ${what}${until}`, at: "ifr", ifr: true });
    } else {
      const what = s.what === "taxiway" && !rw.length ? `Taxiway ${s.status === "closed" ? "closures" : s.status}`
        : String(s.item || "").toLowerCase().replace(/^./, (c) => c.toUpperCase());
      out.push({ ...base, level: 0, text: `${what}${until}`, at: "none" });
    }
  }
  return out;
}

/** TCF coverage over the airport: high -> High, medium -> Moderate. */
export function tcfLevel(coverage) {
  return coverage === "high" ? 3 : coverage === "medium" ? 2 : 0;
}

/**
 * convection | ifr | null for a CWA {hazard, raw}. An explicit hazard decides; only when it is
 * missing is the text searched.
 */
export function cwaKind(c) {
  const hz = String(c?.hazard ?? "").trim().toUpperCase();
  if (hz) {
    if (/^(TS|TSTMS?|CONV\w*|THUNDER\w*|CB)\b/.test(hz)) return "convection";
    if (/^L?IFR\b/.test(hz)) return "ifr";
    return null;
  }
  const t = String(c?.raw ?? "").toUpperCase();
  if (/\b(TS|TSRA|TSTMS?|THUNDERSTORMS?|CONVECTIVE|CONVECTION)\b/.test(t)) return "convection";
  if (/\bL?IFR\b/.test(t)) return "ifr";
  return null;
}

function windowText(base, from, to, now, tz) {
  if (from > +now + 5 * 60e3 && Number.isFinite(to)) return `${base} ${fmtClock(from, tz, now)} to ${fmtClock(to, tz, now)}`;
  if (from > +now + 5 * 60e3) return `${base} from ${fmtClock(from, tz, now)}`;
  if (Number.isFinite(to)) return `${base} until ${fmtClock(to, tz, now)}`;
  return base;
}

/** CWA for convection or IFR -> Moderate over its valid period. */
export function assessCwa(c, now, tz) {
  const kind = cwaKind(c);
  if (!kind) return null;
  const from = toMs(c.validFrom) ?? -Infinity;
  const to = toMs(c.validTo) ?? Infinity;
  const base = `Center weather advisory: ${kind === "convection" ? "thunderstorms" : "IFR conditions"}`;
  return { level: 2, text: windowText(base, from, to, now, tz), fixed: true, from, to };
}

/** alert: {event, onset, ends}. Returns {level, text, fixed, from, to} or null. */
export function assessAlert(a, now, tz) {
  const level = alertLevel(a.event);
  if (!level) return null;
  const from = toMs(a.onset) ?? -Infinity;
  const to = toMs(a.ends) ?? Infinity;
  return { level, text: windowText(a.event, from, to, now, tz), fixed: true, from, to };
}

// ---------- merging / sorting ----------

function dedupe(items) {
  const m = new Map();
  for (const it of items) {
    const prev = m.get(it.text);
    if (!prev) m.set(it.text, { ...it });
    else {
      prev.level = Math.max(prev.level, it.level);
      prev.fixed = prev.fixed || it.fixed;
      prev.fc = prev.fc && it.fc; // observed beats forecast
    }
  }
  return [...m.values()].sort((a, b) => b.level - a.level);
}

export const levelOf = (items) => items.reduce((m, i) => Math.max(m, i.level), 0);

function lowerFirst(s) {
  return /^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------- TAF ----------

const COND_KEYS = ["wdir", "wspd", "wgst", "visib", "wxString"];
function pick(g) {
  const o = {};
  for (const k of COND_KEYS) o[k] = g[k] ?? null;
  o.clouds = Array.isArray(g.clouds) ? g.clouds : [];
  return o;
}
function merge(a, g) {
  const o = { ...a };
  for (const k of COND_KEYS) if (g[k] != null && g[k] !== "") o[k] = g[k];
  if (Array.isArray(g.clouds) && g.clouds.length) o.clouds = g.clouds;
  return o;
}

/**
 * Conditions for the hour [t0, t1) from a TAF. Base + FM/BECMG give the prevailing
 * state at the hour's midpoint; TEMPO/PROB groups overlapping the hour are overlays.
 * Returns {items, fltCat} or null if the TAF doesn't cover the hour.
 */
/**
 * The TAF's conditions for the hour [t0, t1), before scoring: the prevailing state (base + FM/BECMG
 * at the hour's midpoint) and the TEMPO/PROB overlays overlapping the hour, each already merged onto
 * the state. Returns {state, overlays: [{kind: "TEMPO"|"PROB", prob, cond}]} or null if the TAF
 * doesn't cover the hour. Shared by tafHour and the delay model's features (poller/delay.mjs).
 */
export function tafHourParts(taf, t0, t1) {
  const vFrom = toMs(taf.validTimeFrom);
  const vTo = toMs(taf.validTimeTo);
  const mid = (t0 + t1) / 2;
  if ((vFrom != null && mid < vFrom) || (vTo != null && t0 >= vTo)) return null;
  const groups = (taf.fcsts || []).map((g, i) => ({ g, i, kind: g.fcstChange || null }));
  const base = groups.find((x) => !x.kind);
  let state = base ? pick(base.g) : pick({});
  const changes = groups
    .filter((x) => x.kind === "FM" || x.kind === "BECMG")
    .map((x) => ({ ...x, eff: x.kind === "BECMG" ? toMs(x.g.timeBec) ?? toMs(x.g.timeFrom) : toMs(x.g.timeFrom) }))
    .filter((x) => x.eff != null)
    .sort((a, b) => a.eff - b.eff || a.i - b.i);
  for (const ch of changes) {
    if (ch.eff > mid) break;
    state = ch.kind === "FM" ? pick(ch.g) : merge(state, ch.g);
  }
  const overlays = [];
  for (const { g, kind } of groups) {
    if (kind !== "TEMPO" && kind !== "PROB") continue;
    const gf = toMs(g.timeFrom);
    const gt = toMs(g.timeTo);
    if (gf == null || gt == null || !(gf < t1 && gt > t0)) continue;
    overlays.push({ kind, prob: num(g.probability), cond: merge(state, g) });
  }
  return { state, overlays };
}

export function tafHour(taf, t0, t1) {
  const parts = tafHourParts(taf, t0, t1);
  if (!parts) return null;
  const { state } = parts;
  const baseItems = assessConditions(state).map((i) => ({ ...i, fc: true }));
  const have = new Set(baseItems.map((i) => i.text));
  const items = [...baseItems];
  for (const { prob: pv, cond } of parts.overlays) {
    const prob = pv != null && pv > 0;
    for (const it of assessConditions(cond)) {
      if (have.has(it.text)) continue;
      if (prob) {
        const level = it.level - 1;
        if (level > 0) items.push({ level, text: "Chance of " + lowerFirst(it.text), fc: true });
      } else items.push({ ...it, fc: true });
    }
  }
  return { items: dedupe(items), fltCat: flightCategory(parseVisib(state.visib), ceilingOf(state.clouds)), cond: state };
}

/**
 * Prevailing conditions of a METAR or TAF state for the hour cards: {cig, vis, wdir, wspd, wgst, wx, temp}
 * (ceiling ft, visibility sm, wind deg/kt, weather codes, °C; nulls dropped).
 */
export function condOf(c) {
  if (!c) return {};
  const o = {
    cig: ceilingOf(c.clouds), vis: parseVisib(c.visib), wdir: c.wdir === "VRB" ? "VRB" : num(c.wdir), wspd: num(c.wspd), wgst: num(c.wgst),
    wx: c.wxString ? String(c.wxString) : null, temp: num(c.temp),
  };
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
}

// ---------- 24-hour build ----------

export function nextUtcHour(now, hour) {
  const d = new Date(+now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  if (+d <= +now) d.setUTCDate(d.getUTCDate() + 1);
  return +d;
}

/**
 * Build the per-hour risk rows (internal form, items kept so reasons can be summarised).
 * Inputs (all optional except tz): raw API-shaped metar & taf records, faa entries
 * [{type, detail, reason, cause, scope, active}], sigmet (bool: convective SIGMET over the airport),
 * alerts [{event, onset, ends}], spc category string, atcscc advisories [{type, active, end, cause,
 * causeText}], lamp {hours: [{t, tstmProb}]}, tcf [{valid, coverage}], cwa [{hazard, validFrom, validTo, raw}].
 */
export function buildHours(args) {
  const { count = 24 } = args;
  const row = hourRows(args);
  const hours = [];
  for (let i = 0; i < count; i++) hours.push(row(i, i === 0));
  return hours;
}

/**
 * Hour 1 as it would read with the observation winning (README "Risk levels", "The observed next hour"): the same
 * row as buildHours' hour 1 except that its weather is the METAR's (assessConditions, flight category and conditions;
 * the TAF is left out), the convective SIGMET counts, and the items that score "hour 0 only" (plan items for now, FAA
 * closures and runway items with no known end) count as they would for a poll run in that hour. Programs that end
 * before the hour still don't. null without a METAR. The page shows it in place of hours[1] once hour 1 has become
 * the current hour and the METAR is still fresh (site/outlook.js withObsHour).
 */
export function buildObsHour(args) {
  if (!args.metar) return null;
  return hourRows(args)(1, true);
}

function hourRows({
  now = new Date(), tz, taf = null, metar = null, faa = [], sigmet = false, alerts = [], spc = null,
  atcscc = [], lamp = null, tcf = [], cwa = [], opsplan = null,
}) {
  const start = Math.floor(+now / HOUR) * HOUR;
  const spcEnd = nextUtcHour(now, 12);
  const alertItems = alerts.map((a) => assessAlert(a, now, tz)).filter(Boolean);
  const cwaItems = (cwa || []).map((c) => assessCwa(c, now, tz)).filter(Boolean);
  const spcLvl = spcLevel(spc);
  // LAMP LP1/CP1 are 1-hour probabilities (LP2/CP2: 2-hour) for the period ending at the column time.
  const thunder = [];
  const conv = [];
  for (const x of lamp?.hours || []) {
    const t = toMs(x.t);
    if (t == null) continue;
    const span = (num(x.probHrs) || 1) * HOUR;
    if (num(x.tstmProb) != null) thunder.push({ from: t - span, to: t, p: Number(x.tstmProb) });
    if (num(x.convProb) != null) conv.push({ from: t - span, to: t, p: Number(x.convProb) });
  }
  const planItems = opsPlanItems(opsplan, { faa, atcscc, tz, now });
  // FAA programs and active ATCSCC GS/GDP score every hour until their end; a full closure scores every
  // hour of its window (closureSpan: start through reopening; hour 0 only when no end is known); other
  // closures hour 0 only
  const progItems = [];
  for (const f of faa) {
    const span = closureSpan(f, now);
    if (span) {
      const it = assessFaa({ ...f, active: true }, { tz, now });
      if (it) progItems.push({ ...it, from: span.from, to: span.to });
      continue;
    }
    const it = assessFaa(f, { tz, now });
    if (it) progItems.push({ ...it, from: -Infinity, to: faaSpan(f, now) });
  }
  for (const a of atcscc || []) {
    const it = assessAtcscc(a, faa, tz, now);
    if (it) progItems.push({ ...it, from: -Infinity, to: toMs(a.end) });
  }
  const tcfItems = [];
  for (const x of tcf || []) {
    const t = toMs(x.valid);
    const level = tcfLevel(x.coverage);
    if (t == null || !level) continue;
    tcfItems.push({ from: t - HOUR, to: t + HOUR, level, text: `Thunderstorms, ${x.coverage} coverage (TCF)` });
  }
  // cur: the hour is scored as the current one (hour 0; buildObsHour's hour 1): the METAR wins over the TAF, the
  // SIGMET counts, and "hour 0 only" items count. Hour 0 keeps its original rule (every started item); a later
  // current hour only takes started items with no end, so a program that ended before it never comes back.
  return (i, cur) => {
    const t0 = start + i * HOUR;
    const t1 = t0 + HOUR;
    let items = [];
    let fltCat = null;
    let cond = null;
    // hour 0: the observation wins; the TAF only fills in when there is no current METAR
    if (taf && !(cur && metar)) {
      const th = tafHour(taf, t0, t1);
      if (th) { items.push(...th.items); fltCat = th.fltCat; cond = th.cond; }
    }
    if (cur) {
      if (metar) {
        items.push(...assessConditions(metar).map((x) => ({ ...x, fc: false })));
        fltCat = metar.fltCat || flightCategory(parseVisib(metar.visib), ceilingOf(metar.clouds));
        cond = metar;
      }
    }
    // A current advisory remains relevant in every overlapping hour, not just the observation hour.
    // Legacy boolean callers have no validity window and remain current-hour only.
    const stormAdvisory = Array.isArray(sigmet) ? sigmet.some((s) => {
      const end = toMs(s.validTo), from = toMs(s.validFrom) ?? +now;
      return end == null ? cur : end > Math.max(t0, +now) && from < t1;
    }) : cur && sigmet;
    if (stormAdvisory) items.push({ level: 3, text: "Convective SIGMET over airport", fixed: true });
    const nowOnly = (x) => cur && x.from <= +now && (i === 0 || x.to == null);
    for (const x of progItems) {
      if (nowOnly(x) || (x.from < t1 && x.to != null && x.to > t0)) items.push({ level: x.level, text: x.text, fixed: true });
    }
    for (const a of alertItems) if (a.from < t1 && a.to > t0) items.push({ level: a.level, text: a.text, fixed: true });
    for (const c of cwaItems) if (c.from < t1 && c.to > t0) items.push({ level: c.level, text: c.text, fixed: true });
    if (spcLvl && t0 < spcEnd) items.push({ level: spcLvl, text: spcText(spc), fixed: true });
    let p = null;
    for (const x of thunder) if (x.from < t1 && x.to > t0 && (p == null || x.p > p)) p = x.p;
    const tl = lampThunderLevel(p);
    if (tl) items.push({ level: tl, text: `Thunder chance ${p}% (LAMP)`, fc: true });
    let cp = null;
    for (const x of conv) if (x.from < t1 && x.to > t0 && (cp == null || x.p > cp)) cp = x.p;
    const cl = lampConvLevel(cp);
    if (cl > tl) items.push({ level: cl, text: "Storms likely nearby (LAMP)", fc: true });
    for (const x of planItems) {
      if (!(x.to > t0 && x.from < t1)) continue;
      if (x.at === "now" ? cur && x.level : x.at === "span" ? x.level : false) items.push({ level: x.level, text: x.text, fixed: true });
      else if (x.at === "ifr" && (fltCat === "IFR" || fltCat === "LIFR")) items.push({ level: 1, text: x.text, fixed: true });
    }
    for (const x of tcfItems) if (x.from < t1 && x.to > t0) items.push({ level: x.level, text: x.text, fc: true });
    items = dedupe(items);
    return { t: new Date(t0), items, level: levelOf(items), fltCat, cond: condOf(cond) };
  };
}

/** Add "forecast 4–7 PM" style windows to a reason from hour idx. */
export function windowize(hours, idx, item, tz) {
  if (item.fixed) return item.text;
  const has = (h) => h.items.some((x) => x.text === item.text);
  let a = idx;
  while (a > 0 && has(hours[a - 1])) a--;
  let b = idx;
  while (b < hours.length - 1 && has(hours[b + 1])) b++;
  const end = +hours[b].t + HOUR;
  const fc = item.fc ? " forecast" : "";
  if (a === 0 && b === hours.length - 1) return `${item.text}${fc} for the next ${hours.length} hours`;
  if (a === 0) return `${item.text}${fc} until ${fmtClock(end, tz)}`;
  if (b === hours.length - 1) return `${item.text} forecast from ${fmtClock(hours[a].t, tz)}`;
  return `${item.text} forecast ${fmtRange(hours[a].t, end, tz, hours[0].t)}`;
}

// Reasons of one kind that can come from both the METAR and the TAF: show one per box.
const KIND = /^(Visibility|Ceiling|Gusts) /;

/**
 * Items for display: exact duplicates dropped, and only one Visibility / Ceiling / Gusts item
 * (the highest level; the observed one on a tie). Levels are unaffected (computed from all items).
 */
export function uniqueItems(items) {
  const sorted = [...items].sort((a, b) => b.level - a.level || (a.fc ? 1 : 0) - (b.fc ? 1 : 0));
  const texts = new Set();
  const kinds = new Set();
  const out = [];
  for (const it of sorted) {
    if (texts.has(it.text)) continue;
    const k = KIND.exec(it.text)?.[1];
    if (k && kinds.has(k)) continue;
    texts.add(it.text);
    if (k) kinds.add(k);
    out.push(it);
  }
  return out;
}

const uniqueStrings = (arr) => [...new Set(arr)];

/** now = hour 0; peak = max over hours (earliest hour of that max). */
export function summarize(hours, tz) {
  let peakIdx = 0;
  hours.forEach((h, i) => { if (h.level > hours[peakIdx].level) peakIdx = i; });
  const ph = hours[peakIdx];
  return {
    now: { level: hours[0].level, reasons: uniqueItems(hours[0].items).map((i) => i.text) },
    peak: {
      level: ph.level,
      at: ph.t.toISOString(),
      reasons: uniqueStrings(uniqueItems(ph.items).map((i) => windowize(hours, peakIdx, i, tz))),
    },
  };
}

/**
 * status.json hours. An hour no METAR or TAF covers (fltCat null: beyond the TAF's valid period, or no TAF) with
 * nothing else raising it has level null: no forecast, shown grey, never Clear. Reasons from other sources
 * (FAA programs, warnings, LAMP…) keep their level there.
 */
export function hoursOutput(hours) {
  return hours.map((h) => ({ t: h.t.toISOString(), level: h.fltCat == null && !h.level ? null : h.level, reasons: uniqueItems(h.items).map((i) => i.text), fltCat: h.fltCat, ...(h.cond || {}) }));
}

/**
 * Observed weather per past hour (build2b: the timeline's past hours) from one airport's METAR history
 * (AWC JSON records, any order): the `count` hours before the current hour, oldest first. Each METAR is
 * scored with assessConditions and filed under the hour its obsTime falls in; an hour takes the highest
 * level of its reports, their reasons (uniqueItems), its worst flight category, the conditions of its
 * latest report (condOf) and its highest gust. Hours with no
 * report are left out.
 */
export function observedHours(metars, now = new Date(), count = 24) {
  const cur = Math.floor(+now / HOUR) * HOUR;
  const by = new Map();
  const rank = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
  for (const m of metars || []) {
    const t = toMs(m && m.obsTime);
    if (t == null) continue;
    const h0 = Math.floor(t / HOUR) * HOUR;
    if (h0 >= cur || h0 < cur - count * HOUR) continue;
    const e = by.get(h0) || { items: [], fltCat: null, last: null, lastT: -Infinity, gust: null };
    e.items.push(...assessConditions(m));
    if (t >= e.lastT) { e.last = m; e.lastT = t; }
    if (num(m.wgst) != null && (e.gust == null || num(m.wgst) > e.gust)) e.gust = num(m.wgst);
    const fc = m.fltCat || flightCategory(parseVisib(m.visib), ceilingOf(m.clouds));
    if (e.fltCat == null || rank[fc] > rank[e.fltCat]) e.fltCat = fc;
    by.set(h0, e);
  }
  return [...by.keys()].sort((a, b) => a - b).map((h0) => {
    const e = by.get(h0);
    const items = dedupe(e.items);
    const cond = condOf(e.last);
    if (e.gust != null) cond.wgst = e.gust;
    return { t: new Date(h0).toISOString(), level: levelOf(items), reasons: uniqueItems(items).map((i) => i.text), fltCat: e.fltCat, ...cond };
  });
}

export function compareAirports(a, b) {
  return b.peak.level - a.peak.level || b.now.level - a.now.level || a.iata.localeCompare(b.iata);
}
