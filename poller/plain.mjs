// Plain-English translator: METAR/TAF/SIGMET/CWA/NWS alert -> traveler sentences, plus
// pilot-facing lines for aviation mode. Pure ESM with no imports, so the same file runs in
// Node (poller) and in the browser. The site uses a byte-identical copy at site/plain.js
// (refresh it with `cp poller/plain.mjs site/plain.js`; plain.test.mjs fails if they differ).
//
// Inputs are aviationweather.gov JSON records (metar: wxString, visib, clouds, wdir, wspd, wgst,
// temp, dewp, fltCat; TAF fcst groups: the same plus fcstChange, probability, timeFrom/To)
// or the status.json metar shape ({wind: {dir, spd}, gust, visib, ceiling, wx}).
// Traveler text uses mph, miles and plain cloud words and never claims certainty
// ("possible", "likely"); aviation lines use kt, sm and ft AGL.

const KT_MPH = 1.15078;
export const mph = (kt) => Math.round(Number(kt) * KT_MPH);

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

// ---------- shared parsing (duplicated from risk.mjs on purpose: this file has no imports) ----------

export function parseVisib(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().toUpperCase().replace(/SM$/, "").trim();
  if (s.startsWith("P")) s = s.slice(1) + "+";
  if (s.startsWith("M")) s = s.slice(1);
  if (s.endsWith("+")) s = s.slice(0, -1);
  if (!s.trim()) return null;
  let total = 0;
  for (const p of s.trim().split(/\s+/)) {
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

function ceilingOf(clouds) {
  let best = null;
  for (const c of Array.isArray(clouds) ? clouds : []) {
    const cover = String(c?.cover || "").toUpperCase();
    if (!["BKN", "OVC", "VV", "OVX"].includes(cover)) continue;
    const base = num(c.base);
    if (base == null) continue;
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

const FRAC = { 0.125: "1/8", 0.25: "1/4", 0.375: "3/8", 0.5: "1/2", 0.625: "5/8", 0.75: "3/4", 0.875: "7/8" };
function fmtVis(v) {
  if (v == null) return "";
  if (v >= 3) return String(Math.round(v * 10) / 10);
  const whole = Math.floor(v);
  const r = Math.round((v - whole) * 8) / 8;
  if (r === 0) return String(whole);
  if (r === 1) return String(whole + 1);
  return (whole ? whole + " " : "") + FRAC[r];
}

/** Any accepted input shape -> one normalized conditions object. */
function norm(o) {
  o = o || {};
  const clouds = Array.isArray(o.clouds) ? o.clouds : [];
  const ceiling = o.ceiling !== undefined && !Array.isArray(o.clouds) ? num(o.ceiling) : ceilingOf(clouds);
  const visRaw = o.visib;
  return {
    wx: (o.wxString ?? o.wx ?? "") || "",
    vis: parseVisib(visRaw),
    visPlus: typeof visRaw === "string" && /\+|^P/i.test(visRaw.trim()),
    clouds,
    ceiling,
    wdir: o.wdir ?? o.wind?.dir ?? null,
    wspd: num(o.wspd ?? o.wind?.spd),
    wgst: num(o.wgst ?? o.gust),
    temp: num(o.temp),
    dewp: num(o.dewp),
    fltCat: o.fltCat || null,
  };
}

/** "+TSRA" -> {int: "+", desc: ["TS"], ph: ["RA"]} */
function wxTokens(wx) {
  const out = [];
  for (const tok of String(wx || "").toUpperCase().trim().split(/\s+/)) {
    const m = /^(\+|-|VC)?([A-Z]+)$/.exec(tok);
    if (!m || m[2].startsWith("RE") || m[2] === "NSW") continue;
    const codes = m[2].match(/.{1,2}/g) || [];
    const DESC = ["MI", "PR", "BC", "DR", "BL", "SH", "TS", "FZ"];
    out.push({ int: m[1] || "", desc: codes.filter((c) => DESC.includes(c)), ph: codes.filter((c) => !DESC.includes(c)) });
  }
  return out;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const low = (s) => (s && !/^[A-Z]{2}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
function listJoin(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return p[0] || "";
  return p.slice(0, -1).join(", ") + " and " + p[p.length - 1];
}

const PRECIP = { RA: "rain", SN: "snow", DZ: "drizzle", PL: "sleet", GR: "hail", GS: "small hail", SG: "snow grains", IC: "ice crystals", UP: "precipitation" };
const OBSC = { FG: "fog", BR: "mist", HZ: "haze", FU: "smoke", DU: "dust", SA: "sand", VA: "volcanic ash", PY: "spray", SQ: "squalls", PO: "dust whirls", SS: "sandstorm", DS: "duststorm" };

/** One weather token -> traveler phrase ("Thunderstorms with heavy rain"). */
function wxPhrase(t) {
  const has = (c) => t.desc.includes(c) || t.ph.includes(c);
  const heavy = t.int === "+";
  const light = t.int === "-";
  const near = t.int === "VC";
  const precip = t.ph.filter((c) => PRECIP[c]);
  if (has("TS")) {
    if (near) return "Thunderstorms nearby";
    const rain = precip.filter((c) => c !== "GR" && c !== "GS").map((c) => PRECIP[c]);
    let s = "Thunderstorms";
    if (rain.length) s += " with " + (heavy ? "heavy " : light ? "light " : "") + listJoin(rain);
    else if (heavy) s = "Severe thunderstorms";
    if (has("GR")) s += (rain.length ? " and" : " with") + " hail";
    else if (has("GS")) s += (rain.length ? " and" : " with") + " small hail";
    return s;
  }
  if (has("FC")) return heavy ? "Tornado reported" : "Funnel cloud reported";
  if (has("FZ")) {
    if (has("FG")) return "Freezing fog";
    const what = has("RA") ? "freezing rain" : has("DZ") ? "freezing drizzle" : "freezing precipitation";
    return cap((heavy ? "heavy " : light ? "light " : "") + what);
  }
  if (near && has("SH")) return "Showers nearby";
  if (near && has("FG")) return "Fog nearby";
  if (has("BL") || has("DR")) {
    const what = t.ph.map((c) => PRECIP[c] || OBSC[c]).filter(Boolean)[0] || "snow";
    return cap((has("BL") ? "blowing " : "drifting ") + what);
  }
  if (has("FG")) return has("MI") || has("BC") || has("PR") ? "Patchy fog" : "Fog";
  if (precip.length) {
    const words = listJoin(precip.map((c) => PRECIP[c]));
    const s = (heavy ? "heavy " : light ? "light " : "") + words + (has("SH") ? " showers" : "");
    return cap(near ? s + " nearby" : s);
  }
  if (has("SH")) return near ? "Showers nearby" : "Showers";
  const ob = t.ph.map((c) => OBSC[c]).filter(Boolean);
  if (ob.length) return cap(listJoin(ob) + (near ? " nearby" : ""));
  return "";
}

function visPhrase(v) {
  if (v == null || v >= 3) return "";
  if (v < 0.25) return "visibility near zero";
  if (v < 1) return "visibility under 1 mile";
  if (v === 1) return "visibility 1 mile";
  return `visibility ${fmtVis(v)} miles`;
}

function skyWord(c) {
  const covers = c.clouds.map((x) => String(x?.cover || "").toUpperCase());
  if (c.ceiling != null && c.ceiling < 500) return "Very low clouds";
  if (c.ceiling != null && c.ceiling < 1000) return "Low clouds";
  if (covers.includes("OVC") || covers.includes("VV")) return "Overcast";
  if (covers.includes("BKN")) return "Mostly cloudy";
  if (covers.includes("SCT")) return "Partly cloudy";
  if (covers.includes("FEW")) return "Mostly clear";
  return "Clear";
}
const BENIGN = new Set(["Clear", "Mostly clear", "Partly cloudy"]);

function windPhrase(c) {
  if (c.wgst != null && c.wgst >= 25) return `Gusts to ${mph(c.wgst)} mph`;
  if (c.wspd != null && c.wspd >= 20) return `Windy, ${mph(c.wspd)} mph`;
  return "";
}

/** Conditions -> one traveler sentence. */
function sentence(c) {
  const toks = wxTokens(c.wx);
  const wx = toks.map(wxPhrase).filter(Boolean);
  const fog = toks.some((t) => t.ph.includes("FG"));
  let sky = skyWord(c);
  const lowCloud = sky === "Very low clouds" || sky === "Low clouds";
  const parts = [...new Set(wx)];
  if (parts.length) {
    if (lowCloud && !fog) parts.push(low(sky));
  } else parts.push(sky);
  let main = cap(listJoin(parts.map((p, i) => (i ? low(p) : p))));
  const vp = visPhrase(c.vis);
  if (vp) main += " — " + vp;
  const wind = windPhrase(c);
  if (wind && !wx.length && BENIGN.has(sky) && !vp) return wind;
  return wind ? `${main}. ${wind}` : main;
}

/** Current conditions from a METAR -> "Rain and low clouds", "Fog — visibility under 1 mile". */
export function plainMetar(metar) {
  if (!metar) return "No current weather report";
  return sentence(norm(metar));
}

/** One TAF forecast group -> sentence; TEMPO and PROB groups are worded as "at times" / "chance". */
export function plainTafHour(fcst) {
  if (!fcst) return "No forecast";
  const s = sentence(norm(fcst));
  const p = num(fcst.probability);
  if (p) return `${p}% chance of ${low(s)}`;
  if (String(fcst.fcstChange || "").toUpperCase() === "TEMPO") return `At times ${low(s)}`;
  return s;
}

/**
 * Traveler words for a thunder chance (LAMP "Thunder chance 45%"): 60+ "Thunderstorms likely", 30–59 "Chance of
 * thunderstorms", under 30 "Slight chance of thunderstorms". Aviation mode keeps the number; Traveler mode never
 * shows a "%". The same table is in app.js plainReason() and trip-risk.mjs plainReason().
 */
export function thunderWords(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return "Chance of thunderstorms";
  return n >= 60 ? "Thunderstorms likely" : n >= 30 ? "Chance of thunderstorms" : "Slight chance of thunderstorms";
}

// ---------- traveler impact ----------

/**
 * What the conditions mean for flights. level: 0-4 (risk.mjs scale). conditions: a METAR/TAF
 * group/status.json metar, optionally with faa: [{type, scope?, cause?}] and alerts: [{event}].
 * Returns one measured sentence (never certain).
 */
export function travelerImpact(level, conditions = {}) {
  const c = norm(conditions);
  const faa = Array.isArray(conditions?.faa) ? conditions.faa : [];
  const types = new Set(faa.filter((f) => !(f.type === "closure" && (f.scope === "limited" || f.scope === "runway" || f.active === false))).map((f) => f.type));
  if (types.has("closure")) return "The airport is closed — expect cancellations or diversions until it reopens";
  if (types.has("ground_stop")) return "Arrivals are being held at their departure airports (ground stop) — delays likely";
  if (types.has("ground_delay")) return "Arrivals are being delayed at their departure airports (ground delay program) — delays likely";
  const toks = wxTokens(c.wx);
  const has = (code, nearOk = false) => toks.some((t) => (nearOk || t.int !== "VC") && (t.desc.includes(code) || t.ph.includes(code)));
  if (has("TS") || has("FC")) return "Storms can pause departures and arrivals (ground stops) — expect delays";
  // falling snow only: blowing or drifting snow (BLSN/DRSN) alone is wind lifting snow already on the ground
  const falling = (code) => toks.some((t) => t.int !== "VC" && t.ph.includes(code) && !t.desc.includes("BL") && !t.desc.includes("DR"));
  if (toks.some((t) => t.desc.includes("FZ") && !t.ph.includes("FG")) || has("PL") || falling("SN") || falling("SG")) {
    return "De-icing and slower operations — delays likely";
  }
  // gusts alone say nothing about which runway is in use, so no crosswind claim
  if (c.wgst != null && c.wgst >= 35) return "Strong gusty winds may cause delays or diversions";
  if ((c.ceiling != null && c.ceiling < 500) || (c.vis != null && c.vis < 1) || has("FG")) {
    return "Arrivals are often slowed in these conditions; delays of 30+ min possible";
  }
  if (types.has("delay")) return "The FAA reports delays here — allow extra time";
  if (has("TS", true)) return "Storms nearby could slow flights — some delays possible";
  if ((c.ceiling != null && c.ceiling < 1000) || (c.vis != null && c.vis < 3)) return "Low clouds can slow arrivals — some delays possible";
  if (c.wgst != null && c.wgst >= 25) return "Gusty winds — a bumpy ride, minor delays possible";
  const lv = num(level) ?? 0;
  if (lv >= 3) return "Significant disruption possible — check with your airline";
  if (lv === 2) return "Some delays possible";
  if (lv === 1) return "Minor weather — little effect on flights expected";
  return "Flights operating normally";
}

// ---------- SIGMET / CWA ----------

const POINTS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
/** Direction a storm moves TOWARD, from the "MOV FROM ddd" bearing. */
export function towardName(fromDeg) {
  const d = (((Number(fromDeg) + 180) % 360) + 360) % 360;
  return POINTS[Math.round(d / 45) % 8];
}

function clockIn(ms, tz) {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", minute: "2-digit", hour12: true })
      .format(new Date(ms)).replace(/[  ]/g, " ").replace(":00 ", " ");
    return tz ? s : s + " UTC";
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}
function dayIn(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ms));
}
function wdIn(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", weekday: "short" }).format(new Date(ms));
}
/** Clock with a weekday prefix when the local date differs from ref. */
function clockDay(ms, tz, refMs) {
  const s = clockIn(ms, tz);
  return refMs != null && dayIn(ms, tz) !== dayIn(refMs, tz) ? `${wdIn(ms, tz)} ${s}` : s;
}
function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  if (/^\d+(\.\d+)?$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const feet = (fl) => (Number(fl) * 100).toLocaleString("en-US");

/** Decode the free text of a convective SIGMET / CWA into a traveler phrase (without time). */
function convectiveText(raw) {
  const t = String(raw || "").toUpperCase().replace(/\s+/g, " ");
  const sev = /\bSEV(ERE)?\b/.test(t);
  let shape = "Area of";
  if (/\bLINE\b/.test(t)) shape = "Line of";
  else if (/\bISOL(ATED)?\b/.test(t)) shape = "Isolated";
  else if (/\b(SCT|SCATTERED)\b/.test(t)) shape = "Scattered";
  else if (/\b(NMRS|NUMEROUS)\b/.test(t)) shape = "Numerous";
  const what = (sev ? "severe " : "") + "thunderstorms";
  let s = `${shape} ${what}`;
  const mv = /\bMOV FROM (\d{3})(\d{2,3})KT\b/.exec(t);
  if (mv) s += ` moving ${towardName(mv[1])} at ${mph(mv[2])} mph`;
  else if (/\bMOV LTL\b/.test(t)) s += " nearly stationary";
  const top = /\bTOPS (ABV|TO|ABOVE) FL(\d{3})\b/.exec(t);
  if (top) s += `, tops ${top[1] === "TO" ? "to" : "above"} ${feet(top[2])} ft`;
  const extras = [];
  const hail = /\bHAIL TO (\d+(?:\/\d+)?|\d*\.\d+) ?IN\b/.exec(t);
  if (hail) extras.push(`hail up to ${hail[1]} in`);
  const gust = /\bWIND GUSTS? TO (\d{2,3}) ?KT\b/.exec(t);
  if (gust) extras.push(`gusts to ${mph(gust[1])} mph`);
  if (/\bTORNADOES?\b/.test(t)) extras.push("tornadoes possible");
  if (extras.length) s += `, ${listJoin(extras)}`;
  return s;
}

const HAZARD = {
  TURB: "Severe turbulence area", ICE: "Severe icing area", IFR: "Area of low clouds and poor visibility",
  "MTN OBSCN": "Mountains obscured by clouds", ASH: "Volcanic ash area", VA: "Volcanic ash area", TC: "Tropical cyclone",
};

function untilText(to, tz) {
  return to != null ? `, until ${clockIn(to, tz)}` : "";
}

/** Convective or other SIGMET (AWC airsigmet JSON) -> "Area of severe thunderstorms moving east at 25 mph, tops to 45,000 ft, until 9 PM". */
export function plainSigmet(s, { tz = null } = {}) {
  if (!s) return "";
  const raw = s.rawAirSigmet ?? s.raw ?? "";
  const hz = String(s.hazard || "").toUpperCase();
  const to = toMs(s.validTimeTo);
  let body;
  if (hz === "CONVECTIVE" || hz === "TS" || /\bTS\b|THUNDERSTORM|CONVECTIVE SIGMET/.test(String(raw).toUpperCase())) body = convectiveText(raw);
  else body = HAZARD[hz] || "Hazardous weather area";
  return body + untilText(to, tz);
}

/**
 * Center Weather Advisory (AWC /cwa JSON; text field name unverified: cwaText, rawText, text or raw)
 * -> traveler sentence like plainSigmet.
 */
export function plainCwa(c, { tz = null } = {}) {
  if (!c) return "";
  const raw = c.cwaText ?? c.rawText ?? c.text ?? c.raw ?? "";
  const hz = String(c.hazard || "").toUpperCase();
  const to = toMs(c.validTimeTo);
  let body;
  if (/^(TS|CONVECTIVE|TSTM)/.test(hz) || (!hz && /\bTS\b|TSTM|THUNDERSTORM/.test(String(raw).toUpperCase()))) body = convectiveText(raw);
  else body = HAZARD[hz] || "Hazardous weather area";
  return body + untilText(to, tz);
}

// ---------- NWS alerts ----------

/** {event, headline, onset, ends, expires} -> "Winter Storm Warning until Sat 6 AM", "Wind Advisory, 2–8 PM". */
export function plainAlert(a, { tz = null, now = Date.now() } = {}) {
  if (!a) return "";
  const event = String(a.event || "").trim() || String(a.headline || "").replace(/\s+(issued|in effect)\b.*$/i, "").trim() || "Weather alert";
  const nowMs = +now;
  const from = toMs(a.onset ?? a.effective);
  const to = toMs(a.ends ?? a.expires);
  if (from != null && from > nowMs + 5 * 60e3) {
    const fs = clockDay(from, tz, nowMs);
    if (to == null) return `${event} from ${fs}`;
    const ts = clockDay(to, tz, from); // weekday only when it ends on a later day
    const same = dayIn(from, tz) === dayIn(to, tz) && fs.split(" ").pop() === ts.split(" ").pop();
    return `${event}, ${same ? fs.slice(0, fs.lastIndexOf(" ")) : fs}–${ts}`; // "2–8 PM"
  }
  if (to != null) return `${event} until ${clockDay(to, tz, nowMs)}`;
  const m = /\buntil ([A-Z][a-z]+ \d{1,2}) at (\d{1,2}):(\d{2})\s*([AP]M)/i.exec(a.headline || "");
  if (m) return `${event} until ${m[1]}, ${Number(m[2])}${m[3] === "00" ? "" : ":" + m[3]} ${m[4].toUpperCase()}`;
  return event;
}

// ---------- aviation mode ----------

const WXW = {
  TS: "thunderstorm", RA: "rain", SN: "snow", DZ: "drizzle", FZ: "freezing", SH: "showers", BR: "mist", FG: "fog", HZ: "haze",
  PL: "ice pellets", GR: "hail", GS: "small hail", SG: "snow grains", IC: "ice crystals", UP: "unknown precip", BL: "blowing",
  DR: "drifting", FU: "smoke", DU: "dust", SA: "sand", SQ: "squalls", FC: "funnel cloud", VA: "volcanic ash", PY: "spray",
  MI: "shallow", BC: "patches", PR: "partial", PO: "dust whirls", SS: "sandstorm", DS: "duststorm",
};
/** "-SN BR" -> "-SN (light snow), BR (mist)" */
export function decodeWxCodes(wx) {
  return String(wx || "").trim().split(/\s+/).filter(Boolean).map((tok) => {
    const m = /^(\+|-|VC)?([A-Z]+)$/.exec(tok.toUpperCase());
    if (!m) return tok;
    const codes = m[2].match(/.{1,2}/g) || [];
    let words = codes.map((c) => WXW[c] || c);
    if (codes[0] === "SH" && codes.length > 1) words = words.slice(1).concat("showers");
    let s = words.join(" ");
    if (m[1] === "+") s = "heavy " + s;
    else if (m[1] === "-") s = "light " + s;
    else if (m[1] === "VC") s += " in vicinity";
    return `${tok} (${s})`;
  }).join(", ");
}

/** Pilot-facing lines for a METAR or TAF group: category, ceiling, visibility, wind, weather, clouds. */
export function aviationLines(x) {
  if (!x) return [];
  const c = norm(x);
  const lines = [];
  const chg = String(x.fcstChange || "").toUpperCase();
  const p = num(x.probability);
  if (chg || p) lines.push(`Group: ${p ? `PROB${p}` : ""}${p && chg && chg !== "PROB" ? " " : ""}${chg && chg !== "PROB" ? chg : ""}`);
  const cat = c.fltCat || flightCategory(c.vis, c.ceiling);
  lines.push(`Flight category: ${cat}`);
  lines.push(`Ceiling: ${c.ceiling != null ? c.ceiling.toLocaleString("en-US") + " ft AGL" : "none"}`);
  if (c.vis != null) lines.push(`Visibility: ${c.visPlus || c.vis >= 10 ? Math.floor(c.vis) + "+" : fmtVis(c.vis)} sm`);
  if (c.wspd != null) {
    let w;
    if (c.wspd === 0) w = "calm";
    else {
      const dir = c.wdir === "VRB" || c.wdir == null ? "variable" : String(c.wdir).padStart(3, "0") + "°";
      w = `${dir} at ${c.wspd} kt`;
    }
    if (c.wgst != null) w += `, gusts ${c.wgst} kt`;
    lines.push(`Wind: ${w}`);
  }
  if (c.wx) lines.push(`Weather: ${decodeWxCodes(c.wx)}`);
  const layers = c.clouds.filter((l) => l && l.cover).map((l) => {
    const cv = String(l.cover).toUpperCase();
    return l.base != null ? `${cv} ${num(l.base).toLocaleString("en-US")} ft${l.type ? " " + l.type : ""}` : cv;
  });
  if (layers.length) lines.push(`Clouds: ${layers.join(", ")}`);
  if (c.temp != null) lines.push(`Temp/dew point: ${c.temp}/${c.dewp ?? "—"} °C`);
  return lines;
}
