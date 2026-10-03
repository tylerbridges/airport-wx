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

/** "4–7 PM" or "11 AM–2 PM" for [start, end). */
export function fmtRange(start, end, tz) {
  const a = fmtClock(start, tz);
  const b = fmtClock(end, tz);
  const ma = a.split(" ").pop();
  const mb = b.split(" ").pop();
  return ma === mb ? `${a.slice(0, a.lastIndexOf(" "))}–${b}` : `${a}–${b}`;
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
export function assessFaa(f) {
  const cause = f.type === "closure" ? closureCause(f) : causePhrase(f.cause, f.reason);
  const join = (name, detail) => [name + (cause ? " — " + cause : ""), detail].filter(Boolean).join(", ");
  switch (f.type) {
    case "ground_stop":
      return { level: 4, text: cause ? join("Ground stop", f.detail) : `Ground stop${f.detail ? " " + f.detail : ""}`, fixed: true };
    case "closure": {
      if (f.active === false || f.scope === "limited") return null;
      if (f.scope === "runway") {
        const ids = (f.runways || []).join(", ");
        return { level: 1, text: ids ? `${(f.runways || []).length > 1 ? "Runways" : "Runway"} ${ids} closed` : "Runway closed", fixed: true };
      }
      return { level: 4, text: cause ? join("Airport closed", f.detail) : `Airport closed${f.detail ? " " + f.detail : ""}`, fixed: true };
    }
    case "ground_delay":
      return { level: 3, text: cause ? join("Ground delay program", f.detail) : `Ground delay program${f.detail ? " (" + f.detail + ")" : ""}`, fixed: true };
    case "delay":
      return { level: 2, text: cause ? join("Delays", lowerFirstChar(f.detail)) : `Delays${f.detail ? ": " + f.detail : ""}`, fixed: true };
    default:
      return null;
  }
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

/** LAMP 2-hour thunderstorm probability (%) -> level: >= 40 High, 20-39 Moderate. */
export function lampThunderLevel(p) {
  const n = num(p);
  return n == null ? 0 : n >= 40 ? 3 : n >= 20 ? 2 : 0;
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
export function tafHour(taf, t0, t1) {
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
  const baseItems = assessConditions(state).map((i) => ({ ...i, fc: true }));
  const have = new Set(baseItems.map((i) => i.text));
  const items = [...baseItems];
  for (const { g, kind } of groups) {
    if (kind !== "TEMPO" && kind !== "PROB") continue;
    const gf = toMs(g.timeFrom);
    const gt = toMs(g.timeTo);
    if (gf == null || gt == null || !(gf < t1 && gt > t0)) continue;
    const prob = num(g.probability) != null && Number(g.probability) > 0;
    for (const it of assessConditions(merge(state, g))) {
      if (have.has(it.text)) continue;
      if (prob) {
        const level = it.level - 1;
        if (level > 0) items.push({ level, text: "Chance of " + lowerFirst(it.text), fc: true });
      } else items.push({ ...it, fc: true });
    }
  }
  return { items: dedupe(items), fltCat: flightCategory(parseVisib(state.visib), ceilingOf(state.clouds)) };
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
export function buildHours({
  now = new Date(), tz, taf = null, metar = null, faa = [], sigmet = false, alerts = [], spc = null,
  atcscc = [], lamp = null, tcf = [], cwa = [], count = 24,
}) {
  const start = Math.floor(+now / HOUR) * HOUR;
  const spcEnd = nextUtcHour(now, 12);
  const alertItems = alerts.map((a) => assessAlert(a, now, tz)).filter(Boolean);
  const cwaItems = (cwa || []).map((c) => assessCwa(c, now, tz)).filter(Boolean);
  const spcLvl = spcLevel(spc);
  // LAMP LP2 is a 2-hour probability for the period ending at its column time.
  const thunder = [];
  for (const x of lamp?.hours || []) {
    const t = toMs(x.t);
    if (t != null && num(x.tstmProb) != null) thunder.push({ from: t - 2 * HOUR, to: t, p: Number(x.tstmProb) });
  }
  const tcfItems = [];
  for (const x of tcf || []) {
    const t = toMs(x.valid);
    const level = tcfLevel(x.coverage);
    if (t == null || !level) continue;
    tcfItems.push({ from: t - HOUR, to: t + HOUR, level, text: `Thunderstorms, ${x.coverage} coverage (TCF)` });
  }
  const hours = [];
  for (let i = 0; i < count; i++) {
    const t0 = start + i * HOUR;
    const t1 = t0 + HOUR;
    let items = [];
    let fltCat = null;
    if (taf) {
      const th = tafHour(taf, t0, t1);
      if (th) { items.push(...th.items); fltCat = th.fltCat; }
    }
    if (i === 0) {
      if (metar) {
        items.push(...assessConditions(metar).map((x) => ({ ...x, fc: false })));
        fltCat = metar.fltCat || flightCategory(parseVisib(metar.visib), ceilingOf(metar.clouds));
      }
      for (const f of faa) {
        const it = assessFaa(f);
        if (it) items.push(it);
      }
      for (const a of atcscc || []) {
        const it = assessAtcscc(a, faa, tz, now);
        if (it) items.push(it);
      }
      if (sigmet) items.push({ level: 3, text: "Convective SIGMET over airport", fixed: true });
    }
    for (const a of alertItems) if (a.from < t1 && a.to > t0) items.push({ level: a.level, text: a.text, fixed: true });
    for (const c of cwaItems) if (c.from < t1 && c.to > t0) items.push({ level: c.level, text: c.text, fixed: true });
    if (spcLvl && t0 < spcEnd) items.push({ level: spcLvl, text: spcText(spc), fixed: true });
    let p = null;
    for (const x of thunder) if (x.from < t1 && x.to > t0 && (p == null || x.p > p)) p = x.p;
    const tl = lampThunderLevel(p);
    if (tl) items.push({ level: tl, text: `Thunder chance ${p}% (LAMP)`, fc: true });
    for (const x of tcfItems) if (x.from < t1 && x.to > t0) items.push({ level: x.level, text: x.text, fc: true });
    items = dedupe(items);
    hours.push({ t: new Date(t0), items, level: levelOf(items), fltCat });
  }
  return hours;
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
  return `${item.text} forecast ${fmtRange(hours[a].t, end, tz)}`;
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

export function hoursOutput(hours) {
  return hours.map((h) => ({ t: h.t.toISOString(), level: h.level, reasons: uniqueItems(h.items).map((i) => i.text), fltCat: h.fltCat }));
}

export function compareAirports(a, b) {
  return b.peak.level - a.peak.level || b.now.level - a.now.level || a.iata.localeCompare(b.iata);
}
