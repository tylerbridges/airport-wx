// Flight calendar (ICS) -> trips. Pure ES module: no I/O, no node: modules (imports only ./trip-risk.mjs).
//
// The user's flight-tracking app syncs flights into an iPhone calendar that is shared publicly; the
// poller fetches that ICS (poller/trips-poll.mjs) and keeps ONLY airports and times:
//   trips: [{id, legs: [{from, to, dep, arr}]}]   (IATA codes, ISO UTC times)
// Flight numbers, names, confirmation codes, seats and notes are read only to recognise flights and
// are never returned. `id` is a salted hash of the event UID (not reversible without the salt).
//
// The exact event format of the flight app is unverified, so detection is tolerant (README "Trips"):
//   - a pair of 3-letter airport codes joined by → -> - – — "to" ✈ (e.g. "✈ DL 1234 · MSP → ATL");
//   - else a flight marker ("Flight", ✈ or a flight number such as "DL 1234") plus a departure
//     airport from LOCATION (a code in it, else an airport name/city) and a destination from
//     "to <city or code>" in SUMMARY or a second code anywhere in the event.
// Departure = DTSTART, arrival = DTEND (or DTSTART + DURATION), each in its TZID (Z = UTC; a
// floating time or an unknown TZID uses the airport's own zone). All-day events, cancelled events
// and recurrences (RRULE: only the first instance; RECURRENCE-ID overrides are skipped) are ignored.

const HOUR = 3600e3;
export const CONNECT_MAX_MS = 8 * HOUR; // consecutive legs closer than this (same airport) form one trip
export const KEEP_PAST_MS = 6 * HOUR; // keep trips departing from 6 h ago ...
export const KEEP_AHEAD_MS = 7 * 24 * HOUR; // ... to 7 days ahead

// ---------- RFC 5545 lexing ----------

/** Unfold continuation lines (a line starting with a space or tab continues the previous one). */
export function unfold(text) {
  const out = [];
  for (const line of String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.length);
}

/** Split at `sep` outside double quotes. */
function splitOutsideQuotes(s, sep, max = Infinity) {
  const parts = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    if (c === sep && !q && parts.length < max - 1) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** "DTSTART;TZID=America/Chicago:20261004T180500" -> {name, params: {TZID}, value}. */
export function parseLine(line) {
  const [head, ...rest] = splitOutsideQuotes(line, ":", 2);
  if (!rest.length) return null;
  const [name, ...ps] = splitOutsideQuotes(head, ";");
  const params = {};
  for (const p of ps) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: rest[0] };
}

/** TEXT value unescaping: \n \N \, \; \\. */
export function unescapeText(v) {
  return String(v ?? "").replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

/**
 * ICS text -> {calendar: {props, tz}, events: [{props: [{name, params}], uid, summary, location,
 * description, status, start, end, duration, rrule, recurrenceId}]} where start/end are raw
 * {value, params} (resolved later, once the airports and their zones are known).
 */
export function parseIcs(text) {
  const lines = unfold(text);
  const events = [];
  const calendar = { props: [], tz: null };
  const stack = [];
  let ev = null;
  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT" && stack.length <= 2) ev = { props: [], uid: null, summary: "", location: "", description: "", status: null, start: null, end: null, duration: null, rrule: null, recurrenceId: null };
      continue;
    }
    if (p.name === "END") {
      const comp = stack.pop();
      if (comp === "VEVENT" && ev && !stack.includes("VEVENT")) { events.push(ev); ev = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === "VCALENDAR") {
      calendar.props.push({ name: p.name, params: Object.keys(p.params) });
      if (p.name === "X-WR-TIMEZONE") calendar.tz = p.value.trim();
      continue;
    }
    if (top !== "VEVENT" || !ev) continue; // VALARM, VTIMEZONE …
    ev.props.push({ name: p.name, params: Object.keys(p.params) });
    switch (p.name) {
      case "UID": ev.uid = p.value.trim(); break;
      case "SUMMARY": ev.summary = unescapeText(p.value); break;
      case "LOCATION": ev.location = unescapeText(p.value); break;
      case "DESCRIPTION": ev.description = unescapeText(p.value); break;
      case "STATUS": ev.status = p.value.trim().toUpperCase(); break;
      case "DTSTART": ev.start = { value: p.value.trim(), params: p.params }; break;
      case "DTEND": ev.end = { value: p.value.trim(), params: p.params }; break;
      case "DURATION": ev.duration = p.value.trim(); break;
      case "RRULE": ev.rrule = p.value.trim(); break;
      case "RECURRENCE-ID": ev.recurrenceId = p.value.trim(); break;
      default: break;
    }
  }
  return { calendar, events };
}

// ---------- times ----------

const zoneOk = new Map();
export function validZone(z) {
  if (!z || typeof z !== "string") return false;
  if (!zoneOk.has(z)) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: z }); zoneOk.set(z, true); } catch { zoneOk.set(z, false); }
  }
  return zoneOk.get(z);
}
/** "/mozilla.org/20050126_1/America/Chicago" or '"America/Chicago"' -> "America/Chicago" when valid. */
export function cleanZone(z) {
  const s = String(z ?? "").replace(/^"|"$/g, "").trim();
  if (validZone(s)) return s;
  const m = /([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(s);
  return m && validZone(m[1]) ? m[1] : null;
}

const dtfCache = new Map();
function partsIn(ms, tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
  }
  const o = {};
  for (const x of dtfCache.get(tz).formatToParts(new Date(ms))) if (x.type !== "literal") o[x.type] = Number(x.value);
  return o;
}
/** Offset (ms) of tz from UTC at instant ms. */
export function zoneOffset(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock time in tz -> UTC ms (DST gaps resolve forward, overlaps to the first instant). */
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz || tz === "UTC") return wall;
  let t = wall - zoneOffset(wall, tz);
  const t2 = wall - zoneOffset(t, tz);
  if (t2 !== t) t = Math.min(t, t2);
  return t;
}

/**
 * Raw DTSTART/DTEND {value, params} -> {ms, allDay} or null. zoneFallback: the zone for floating
 * times and unknown TZIDs (the airport's own zone, else the calendar's X-WR-TIMEZONE, else UTC).
 */
export function icsTime(prop, zoneFallback = "UTC") {
  if (!prop || !prop.value) return null;
  const v = prop.value;
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || String(prop.params?.VALUE || "").toUpperCase() === "DATE") {
    const m = d || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return m ? { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), allDay: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const [y, mo, da, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, da, h, mi, s), allDay: false, zone: "UTC" };
  const zone = cleanZone(prop.params?.TZID) || cleanZone(zoneFallback) || "UTC";
  return { ms: zonedToUtc(y, mo, da, h, mi, s, zone), allDay: false, zone };
}

/** "PT2H30M", "P1DT2H" -> ms (null if unreadable). */
export function durationMs(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 24 + (+m[3] || 0) * 24 + (+m[4] || 0)) * HOUR + (+m[5] || 0) * 60e3 + (+m[6] || 0) * 1e3;
  return m[1] === "-" ? -ms : ms;
}

// ---------- airport lookup ----------

/** Lowercase, no accents or punctuation: "Minneapolis–St. Paul" -> "minneapolis st paul". */
export function norm(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[.'’]/g, "").replace(/\bsaint\b/g, "st").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Lookup over airports: list of {iata, name, city, tz} (curated airports first, so "Chicago" ->
 * ORD rather than MDW). Returns {has(code), tz(code), byText(text) -> code|null}.
 */
export function makeLookup(list) {
  const codes = new Map();
  const cities = new Map();
  const names = [];
  for (const a of list || []) {
    if (!a || !/^[A-Z]{3}$/.test(a.iata || "")) continue;
    if (!codes.has(a.iata)) codes.set(a.iata, a);
    const c = norm(a.city);
    if (c && !cities.has(c)) cities.set(c, a.iata);
    const n = norm(a.name).replace(/\b(international|intl|airport|regional|municipal|field)\b/g, " ").replace(/\s+/g, " ").trim();
    if (n.length >= 4) names.push([n, a.iata]);
  }
  return {
    has: (c) => codes.has(c),
    tz: (c) => codes.get(c)?.tz || null,
    /** A place name ("Atlanta", "Minneapolis–St Paul International") -> code. */
    byText(text) {
      const t = norm(text).replace(/\b(international|intl|airport|regional|municipal|field)\b/g, " ").replace(/\s+/g, " ").trim();
      if (!t) return null;
      if (cities.has(t)) return cities.get(t);
      for (const [n, code] of names) if (n === t || (t.length >= 5 && n.startsWith(t)) || (n.length >= 6 && t.includes(n))) return code;
      // first word(s) of the text as a city: "Minneapolis St Paul" -> "minneapolis"
      const words = t.split(" ");
      for (let k = Math.min(3, words.length); k >= 1; k--) {
        const c = words.slice(0, k).join(" ");
        if (cities.has(c)) return cities.get(c);
      }
      return null;
    },
  };
}

// ---------- flight detection ----------

const PAIR = /(?:^|[^A-Za-z])([A-Z]{3})\s*(?:→|->|⇒|➝|➔|➜|–|—|-|>|✈\uFE0F?|\bto\b|\bTO\b)\s*([A-Z]{3})(?![A-Za-z])/gu;
// Flight number: airline designator (2 letters, letter+digit or digit+letter) + 1–4 digits. Detection only.
export const FLIGHT_NO = /(?:^|[^A-Za-z0-9])(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}[A-Z]?(?![A-Za-z0-9])/;
const MARKER = /\bflights?\b|✈/iu;

function knownCodes(s, lookup) {
  const out = [];
  for (const m of String(s ?? "").matchAll(/(?:^|[^A-Za-z])([A-Z]{3})(?![A-Za-z])/g)) if (lookup.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * {summary, location, description} -> {from, to, how} or null.
 * how: "pair" (codes joined by an arrow/dash/"to") or "place" (marker + LOCATION + destination).
 */
export function detectFlight(ev, lookup) {
  const fields = [ev.summary, ev.location, ev.description];
  for (const f of fields) {
    for (const m of String(f ?? "").matchAll(PAIR)) {
      const [from, to] = [m[1], m[2]];
      if (from !== to && lookup.has(from) && lookup.has(to)) return { from, to, how: "pair" };
    }
  }
  const marked = MARKER.test(ev.summary || "") || FLIGHT_NO.test(ev.summary || "") || MARKER.test(ev.location || "");
  if (!marked) return null;
  // departure: a code in LOCATION ("Minneapolis–St Paul (MSP)"), else an airport name or city there
  const locCodes = knownCodes(ev.location, lookup);
  let from = locCodes[0] || null;
  if (!from && ev.location) from = lookup.byText(String(ev.location).split(/[,\n]/)[0]);
  // "Flight from Minneapolis to Atlanta"
  const fm = /\bfrom\s+([^()\n·|,•]+?)\s+to\s+/i.exec(ev.summary || "");
  if (!from && fm) from = /^[A-Z]{3}$/.test(fm[1].trim()) && lookup.has(fm[1].trim()) ? fm[1].trim() : lookup.byText(fm[1]);
  // destination: "to <place>" in SUMMARY ("Flight to Atlanta (DL1234)"), else another code anywhere
  let to = null;
  const tm = /\bto\s+([^()\n·|,•–—-]+?)\s*(?:\(|$|·|\||,|•|–|—|-|\bon\b|\bvia\b)/i.exec(ev.summary || "");
  if (tm) {
    const place = tm[1].trim();
    to = /^[A-Z]{3}$/.test(place) && lookup.has(place) ? place : lookup.byText(place);
  }
  if (!to) to = [...knownCodes(ev.summary, lookup), ...locCodes.slice(1), ...knownCodes(ev.description, lookup)].find((c) => c !== from) || null;
  // "✈ Denver": what's left of the summary without the marker and flight number, as a place
  if (!to) {
    const rest = String(ev.summary || "").replace(/✈️?|\bflights?\b/giu, " ").replace(new RegExp(FLIGHT_NO.source, "g"), " ").replace(/[()·|•:]/g, " ").trim();
    const c = rest ? lookup.byText(rest) : null;
    if (c && c !== from) to = c;
  }
  if (!from) from = [...knownCodes(ev.summary, lookup), ...knownCodes(ev.description, lookup)].find((c) => c !== to) || null;
  return from && to && from !== to ? { from, to, how: "place" } : null;
}

// ---------- hashing (salted, not reversible without the salt) ----------

/** 64-bit FNV-1a as 16 hex chars (two 32-bit lanes). Pure; the poller passes a SHA-256 instead. */
export function fnvHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e37), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------- events -> legs -> trips ----------

/**
 * Parsed calendar -> {legs: [{from, to, dep, arr (ms), uid}], stats}. Never returns text fields.
 * calendarTz: X-WR-TIMEZONE (floating-time fallback after the airport's own zone).
 */
export function flightLegs(cal, lookup) {
  const stats = { events: cal.events.length, flights: 0, allDay: 0, cancelled: 0, notFlight: 0, noEnd: 0, recurrenceOverride: 0, recurring: 0, how: { pair: 0, place: 0 } };
  const legs = [];
  const seen = new Set();
  for (const ev of cal.events) {
    if (ev.status === "CANCELLED" || /^\s*cancell?ed\b/i.test(ev.summary || "")) { stats.cancelled++; continue; }
    if (ev.recurrenceId) { stats.recurrenceOverride++; continue; }
    if (ev.rrule) stats.recurring++;
    const s0 = icsTime(ev.start, "UTC");
    if (!s0) { stats.notFlight++; continue; }
    if (s0.allDay) { stats.allDay++; continue; }
    const f = detectFlight(ev, lookup);
    if (!f) { stats.notFlight++; continue; }
    const fb = (code) => lookup.tz(code) || cal.calendar.tz || "UTC";
    const dep = icsTime(ev.start, fb(f.from));
    let arr = ev.end ? icsTime(ev.end, fb(f.to)) : null;
    if (!arr && ev.duration != null && durationMs(ev.duration) != null) arr = { ms: dep.ms + durationMs(ev.duration), allDay: false };
    if (!arr || arr.allDay || !(arr.ms > dep.ms)) { stats.noEnd++; continue; }
    const key = `${f.from}${f.to}${dep.ms}`;
    if (seen.has(key)) continue; // same flight twice (e.g. two calendars merged)
    seen.add(key);
    stats.flights++;
    stats.how[f.how]++;
    legs.push({ from: f.from, to: f.to, dep: dep.ms, arr: arr.ms, uid: ev.uid || key });
  }
  legs.sort((a, b) => a.dep - b.dep);
  return { legs, stats };
}

/** Consecutive legs with a gap under 8 h where the arrival airport is the next departure airport form one trip. */
export function groupTrips(legs) {
  const trips = [];
  let cur = null;
  for (const l of [...legs].sort((a, b) => a.dep - b.dep)) {
    const prev = cur && cur[cur.length - 1];
    const gap = prev ? l.dep - prev.arr : Infinity;
    if (prev && prev.to === l.from && gap >= 0 && gap < CONNECT_MAX_MS) cur.push(l);
    else { cur = [l]; trips.push(cur); }
  }
  return trips;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * ICS text -> {trips: [{id, legs: [{from, to, dep, arr}]}], stats, cal}.
 * Keeps trips whose first departure is at most 7 days ahead and whose last departure is at most 6 h ago.
 * opts: {now, lookup (makeLookup), salt, hash (string -> hex)}.
 */
export function tripsFromIcs(text, { now = new Date(), lookup, salt = "", hash = fnvHash } = {}) {
  const cal = parseIcs(text);
  const { legs, stats } = flightLegs(cal, lookup || makeLookup([]));
  const t = +now;
  const trips = groupTrips(legs)
    .filter((g) => g[0].dep <= t + KEEP_AHEAD_MS && g[g.length - 1].dep >= t - KEEP_PAST_MS)
    .map((g) => ({
      id: hash(salt + "\u0000" + g[0].uid).slice(0, 16),
      legs: g.map((l) => ({ from: l.from, to: l.to, dep: iso(l.dep), arr: iso(l.arr) })),
    }));
  stats.trips = trips.length;
  stats.upcomingFlights = trips.reduce((n, x) => n + x.legs.length, 0);
  return { trips, stats, cal };
}

// ---------- privacy ----------

// Words kept in the redacted sample (they describe the format, not the traveller).
const KEEP_WORDS = new Set(("flight flights to from depart departs departure departing arrive arrives arrival arriving terminal gate seat " +
  "confirmation conf booking record locator pnr trip via on at the and of in by with airline airport international intl local time " +
  "duration aircraft delayed canceled cancelled scheduled status nonstop connection layover operated am pm utc h hr hrs m min mins " +
  "boarding baggage claim belt check tracked tracking more info details").split(" "));

/**
 * Masks a text for the format sample: digits -> "#", letters of every word that isn't a known
 * airport code or a format word -> "x"/"X" (names, cities, confirmation codes, emails, notes).
 * Punctuation, arrows and separators are kept so the format can be checked.
 */
export function maskText(s, lookup, max = 240) {
  const out = String(s ?? "").replace(/[A-Za-z\u00C0-\u024F]+|\d/g, (w) => {
    if (/^\d$/.test(w)) return "#";
    if (/^[A-Z]{3}$/.test(w) && lookup && lookup.has(w)) return w;
    if (KEEP_WORDS.has(w.toLowerCase())) return w;
    return w.replace(/[A-Z\u00C0-\u00DE]/g, "X").replace(/[a-z\u00DF-\u024F]/g, "x");
  });
  return out.length > max ? out.slice(0, max) + "…" : out;
}

/** Time value shape without the time: "TZID=America/Chicago:YYYYMMDDTHHMMSS", "UTC:…Z", "VALUE=DATE:YYYYMMDD". */
function timeShape(p) {
  if (!p) return null;
  const v = String(p.value || "").replace(/\d/g, "#");
  const ps = Object.entries(p.params || {}).map(([k, x]) => (k === "TZID" || k === "VALUE" ? `${k}=${x}` : `${k}=…`));
  return [...ps, v].join(":");
}

/**
 * A structural sample of the calendar for checking the format (history branch raw folder):
 * property names, time shapes and the first few events' SUMMARY/LOCATION/DESCRIPTION masked.
 * Contains no digits, names, flight numbers or confirmation codes.
 */
export function redactedSample(cal, stats, lookup, { max = 6 } = {}) {
  const evs = cal.events;
  const flightsFirst = [...evs].sort((a, b) => (detectFlight(b, lookup) ? 1 : 0) - (detectFlight(a, lookup) ? 1 : 0));
  return {
    calendarProps: [...new Set(cal.calendar.props.map((p) => p.name + (p.params.length ? ";" + p.params.join(";") : "")))],
    calendarTz: cal.calendar.tz ? (cleanZone(cal.calendar.tz) || "unrecognised") : null,
    eventProps: [...new Set(evs.flatMap((e) => e.props.map((p) => p.name + (p.params.length ? ";" + p.params.join(";") : ""))))].sort(),
    stats,
    events: flightsFirst.slice(0, max).map((e) => {
      const f = detectFlight(e, lookup);
      return {
        props: e.props.map((p) => p.name),
        start: timeShape(e.start),
        end: timeShape(e.end),
        duration: e.duration ? e.duration.replace(/\d/g, "#") : null,
        status: e.status,
        rrule: !!e.rrule,
        summary: maskText(e.summary, lookup),
        location: maskText(e.location, lookup),
        description: maskText(e.description, lookup, 400),
        detected: f ? f.how : null,
      };
    }),
  };
}

// Privacy check of trips.json lives in trip-risk.mjs (shared with the check page).
export { PRIVACY_RE, privacyProblems } from "./trip-risk.mjs";
