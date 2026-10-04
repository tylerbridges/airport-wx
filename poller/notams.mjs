// Airport NOTAMs (README "Notices"): normalise the two FAA sources, classify each NOTAM and write it in
// plain English. Pure (no network, no node: imports: the live relay imports it through core.mjs);
// unit-tested in notams.test.mjs. The closure grammar (scope, times, runway ids) is notam.mjs's.
//
// Sources (poller/notices-poll.mjs fetches them):
//   search  FAA NOTAM Search (POST notams.aim.faa.gov/notamSearch/search): {notamList: [{icaoId,
//           facilityDesignator, notamNumber, traditionalMessage, traditionalMessageFrom4thWord, icaoMessage,
//           issueDate, startDate "MM/DD/YYYY HHMM", endDate (… or "PERM"), keyword, cancelledOrExpired}],
//           endRecordCount, totalNotamCount}. notamList/icaoMessage/issueDate/endRecordCount/totalNotamCount
//           are confirmed by avwx-engine's client; the other field names are unverified, so the NOTAM's own
//           "YYMMDDHHMM-YYMMDDHHMM" group is the fallback for times.
//   api     FAA NOTAM API (external-api.faa.gov/notamapi/v1/notams?responseFormat=geoJson): {items: [{properties:
//           {coreNOTAMData: {notam: {id, number, location, icaoLocation, issued, effectiveStart, effectiveEnd,
//           text}, notamTranslation: [{type: "LOCAL_FORMAT", simpleText}]}}}]} (unverified: written from the
//           API's documented geoJson shape; tolerant).
// Every function returns empty results rather than throwing on unexpected input.
import { notamTimes, notamBody, closedRunways } from "./notam.mjs";
import { fmtClock } from "./risk.mjs";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- normalising ----------

const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/[ \t]+/g, " ").trim();

/** "10/01/2026 1300" (UTC) -> ms; ISO strings too; "PERM" -> null. */
export function notamDate(v) {
  const s = String(v ?? "").trim();
  if (!s || /^PERM/i.test(s)) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):?(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
  const t = Date.parse(s.replace(/EST$/i, ""));
  return Number.isFinite(t) ? t : null;
}

/** ICAO-format NOTAM -> its E) text ("RWY 10L/28R CLSD"), else the input. */
function icaoE(s) {
  const m = /\bE\)\s*([\s\S]*?)(?=\s+[FG]\)|$)/.exec(String(s ?? ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : String(s ?? "").trim();
}

/** One normalised record: {id, loc, text, start, end, perm, est, issued, keyword, src}. */
function record({ id, loc, text, start, end, perm, est, issued, keyword, src }) {
  const t = notamTimes(text);
  return {
    id: String(id || "").trim() || null, loc: String(loc || "").trim().toUpperCase() || null,
    text: String(text || "").replace(/\s+/g, " ").trim(),
    start: start ?? t?.start ?? null, end: perm ? null : end ?? t?.end ?? null,
    perm: !!(perm || t?.perm), est: !!(est || t?.est), issued: issued ?? null, keyword: keyword || null, src,
  };
}

/** FAA NOTAM Search reply -> records (cancelled/expired ones dropped). */
export function notamsFromSearch(json) {
  const list = Array.isArray(json?.notamList) ? json.notamList : [];
  const out = [];
  for (const it of list) {
    try {
      if (!it || it.cancelledOrExpired === true) continue;
      const loc = it.icaoId || it.facilityDesignator || it.locID || "";
      const des = it.facilityDesignator || it.locID || String(loc).replace(/^K(?=[A-Z0-9]{3}$)/, "");
      let text = stripTags(it.traditionalMessage);
      if (!text && it.traditionalMessageFrom4thWord) text = `!${des} ${it.notamNumber || ""} ${des} ${stripTags(it.traditionalMessageFrom4thWord)}`;
      if (!text) text = icaoE(stripTags(it.icaoMessage));
      if (!text) continue;
      const perm = /^PERM/i.test(String(it.endDate || ""));
      out.push(record({
        id: `${des} ${it.notamNumber || ""}`.trim(), loc, text, start: notamDate(it.startDate), end: notamDate(it.endDate), perm,
        est: /EST$/i.test(String(it.endDate || "")), issued: notamDate(it.issueDate), keyword: it.keyword || it.featureName || null, src: "search",
      }));
    } catch { /* skip a malformed item */ }
  }
  return out;
}

/** FAA NOTAM API reply (geoJson) -> records. */
export function notamsFromApi(json) {
  const items = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
  const out = [];
  for (const it of items) {
    try {
      const core = it?.properties?.coreNOTAMData || it?.coreNOTAMData || {};
      const n = core.notam || {};
      const tr = (core.notamTranslation || []).find((x) => /LOCAL/i.test(x.type || "")) || null;
      const loc = n.icaoLocation || n.location || "";
      const des = n.location || String(loc).replace(/^K(?=[A-Z0-9]{3}$)/, "");
      const text = stripTags(tr?.simpleText) || (n.text ? `!${des} ${n.number || ""} ${des} ${n.text}` : "");
      if (!text) continue;
      if (/^C$/i.test(n.type || "")) continue; // cancellation
      const endRaw = String(n.effectiveEnd || "");
      out.push(record({
        id: `${des} ${n.number || n.id || ""}`.trim(), loc, text, start: notamDate(n.effectiveStart), end: notamDate(endRaw),
        perm: /^PERM/i.test(endRaw), est: /EST$/i.test(endRaw), issued: notamDate(n.issued), keyword: n.featureType || n.classification || null, src: "api",
      }));
    } catch { /* skip */ }
  }
  return out;
}

/** Records for one airport (matched by ICAO, or the 3-letter code the FAA uses), duplicates (same id) dropped. */
export function notamsFor(records, { icao, iata }) {
  const want = new Set([icao, iata, String(icao || "").replace(/^K(?=[A-Z0-9]{3}$)/, "")].filter(Boolean).map((x) => x.toUpperCase()));
  const seen = new Set();
  const out = [];
  for (const r of records || []) {
    const des = /^!(\S+)/.exec(r.text)?.[1]?.toUpperCase();
    if (!want.has(r.loc) && !want.has(des)) continue;
    const k = r.id || r.text;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ---------- schedules ("DLY 0400-1000", "MON-FRI 0300-1100") ----------

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAYS_RE = "(?:MON|TUE|WED|THU|FRI|SAT|SUN)";
const SCHED_RE = new RegExp(`\\b(DLY|DAILY|${DAYS_RE}(?:\\s*(?:-|THRU|,|\\s)\\s*${DAYS_RE})*)\\s+(\\d{4})\\s*-\\s*(\\d{4})\\b`, "g");

/** Daily windows in UTC minutes: [{d: [weekday 0-6] | null (every day), f, t}]; [] = no schedule. */
export function notamSchedule(text) {
  const body = notamBody(text).toUpperCase();
  const out = [];
  let m;
  SCHED_RE.lastIndex = 0;
  while ((m = SCHED_RE.exec(body))) {
    const f = +m[2].slice(0, 2) * 60 + +m[2].slice(2);
    const t = +m[3].slice(0, 2) * 60 + +m[3].slice(2);
    if (f > 24 * 60 || t > 24 * 60) continue;
    let d = null;
    if (!/^(DLY|DAILY)$/.test(m[1])) {
      const set = new Set();
      const parts = m[1].split(/\s*,\s*|\s+(?!-|THRU)/).filter(Boolean);
      for (const p of parts) {
        const r = /^(\w{3})\s*(?:-|THRU)\s*(\w{3})$/.exec(p.trim());
        if (r) {
          let i = DOW.indexOf(r[1]);
          const j = DOW.indexOf(r[2]);
          if (i < 0 || j < 0) continue;
          for (let k = 0; k < 7; k++) { set.add(i); if (i === j) break; i = (i + 1) % 7; }
        } else if (DOW.includes(p.trim())) set.add(DOW.indexOf(p.trim()));
      }
      d = [...set].sort();
      if (!d.length) continue;
    }
    out.push({ d, f, t });
  }
  return out;
}

/** Text that names a part-time period we can't model ("SR-SS", "EVERY OTHER", "HOURLY"…). */
const PART_TIME = /\b(SR\s*-\s*SS|SS\s*-\s*SR|SUNRISE|SUNSET|INTERMITTENT|INTERMITTENTLY|EVERY\s+OTHER|BTN\s+\d{4}\s+AND\s+\d{4})\b/;

/**
 * Is a notice active anywhere in [t0, t1)? n: {from, to (ISO|null), win?: [[fromISO, toISO]], sched?: notamSchedule()}.
 * from/to bound everything; win (TFR areas) and sched (daily windows) narrow it further.
 */
export function activeIn(n, t0, t1) {
  const from = n.from ? Date.parse(n.from) : -Infinity;
  const to = n.to ? Date.parse(n.to) : Infinity;
  if (!(from < t1 && to > t0)) return false;
  const a = Math.max(t0, from), b = Math.min(t1, to);
  if (Array.isArray(n.win) && n.win.length && !n.win.some(([x, y]) => Date.parse(x) < b && (y ? Date.parse(y) : Infinity) > a)) return false;
  if (Array.isArray(n.sched) && n.sched.length) {
    const day0 = Math.floor(a / DAY) * DAY - DAY;
    for (let d = day0; d < b; d += DAY) {
      for (const w of n.sched) {
        if (w.d && !w.d.includes(new Date(d).getUTCDay())) continue;
        const s = d + w.f * 60e3;
        let e = d + w.t * 60e3;
        if (e <= s) e += DAY;
        if (s < b && e > a) return true;
      }
    }
    return false;
  }
  return true;
}

/** End of the active stretch that covers t (sched window end, or the notice's end); null = open-ended. */
export function stretchEnd(n, t) {
  const to = n.to ? Date.parse(n.to) : null;
  if (Array.isArray(n.sched) && n.sched.length) {
    const day0 = Math.floor(t / DAY) * DAY - DAY;
    for (let d = day0; d <= t; d += DAY) {
      for (const w of n.sched) {
        if (w.d && !w.d.includes(new Date(d).getUTCDay())) continue;
        const s = d + w.f * 60e3;
        let e = d + w.t * 60e3;
        if (e <= s) e += DAY;
        if (s <= t && e > t) return to != null ? Math.min(e, to) : e;
      }
    }
  }
  if (Array.isArray(n.win) && n.win.length) {
    for (const [x, y] of n.win) { const s = Date.parse(x), e = y ? Date.parse(y) : null; if (s <= t && (e == null || e > t)) return e; }
  }
  return to;
}

// ---------- plain words ----------

const dtfCache = new Map();
function dtf(tz, opts, key) {
  const k = tz + "|" + key;
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }));
  return dtfCache.get(k);
}
/** " until 7 PM" (within a day; "Sat 7 PM" on another date), " until Nov 5" (later), " until further notice" (PERM), "" (unknown). */
export function untilWords(ms, tz, now, perm = false) {
  if (perm) return " until further notice";
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms - +now <= 24 * HOUR) return ` until ${fmtClock(ms, tz, now)}`;
  const p = Object.fromEntries(dtf(tz, { month: "numeric", day: "numeric" }, "md").formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return ` until ${MONTHS[Number(p.month) - 1]} ${p.day}`;
}

/** Daily windows in the airport's local clock: "daily 11 PM – 6 AM", "Mon–Fri 10 PM – 5 AM". */
export function scheduleWords(sched, tz, now = new Date()) {
  if (!sched || !sched.length) return "";
  const day = Math.floor(+now / DAY) * DAY;
  const parts = sched.slice(0, 2).map((w) => {
    const s = day + w.f * 60e3;
    let e = day + w.t * 60e3;
    if (e <= s) e += DAY;
    const days = !w.d ? "daily" : w.d.length === 5 && [1, 2, 3, 4, 5].every((x) => w.d.includes(x)) ? "Mon–Fri"
      : w.d.length === 2 && w.d.includes(0) && w.d.includes(6) ? "weekends" : w.d.map((x) => DOW[x].charAt(0) + DOW[x].slice(1).toLowerCase()).join(", ");
    return `${days} ${fmtClock(s, tz)} – ${fmtClock(e, tz)}`;
  });
  return parts.join(" and ");
}

const normRwy = (r) => String(r || "").toUpperCase().replace(/(^|\/)0(\d)/g, "$1$2");
/** "Runway 4R/22L", "Runways 4L/22R and 4R/22L", "Runways 4L/22R, 9R/27L and 10C/28C". */
export function runwayNames(ids) {
  const r = (ids || []).map(normRwy);
  if (!r.length) return "";
  return r.length > 1 ? `Runways ${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}` : `Runway ${r[0]}`;
}

// ---------- classification ----------

const OUT = /\b(U\/S|OTS|OUT OF SERVICE|UNSERVICEABLE|NOT AVBL|UNAVBL|INOP|DECOMMISSIONED)\b/;
const LIGHTS = /\b(LGT|LGTS|LIGHTS?|LIGHTING|ALS|ALSF\d?|MALS[RF]?|SSALR|ODALS|REIL|PAPI|VASI|RCLL?|CL LGT|TDZL?|HIRL|MIRL|LIRL|EDGE LGT|BCN|ROTG BCN|RWY END ID LGT)\b/;

/**
 * Classify one NOTAM text. Returns {kind, runways, what?, scope?}:
 *   closure (airport or all runways closed, no qualifier) | limited (closed only to some users/aircraft) |
 *   runway (runways closed) | ils (ILS / glideslope / localizer out of service) | taxiway | construction |
 *   lighting | deice | other.
 */
export function classifyNotam(text) {
  const b = notamBody(text).toUpperCase();
  const qualified = /\bCLSD\s+TO\b|\bEXC\b(?!\s+TAX)|\bEXCEPT\b|\bPPR\b|\bWINGSPAN\b|\bWEIGHT\b|\bACFT\s+MORE\s+THAN\b/.test(b);
  if (/\b(AD\s+AP|AD|AP)\s+CLSD\b/.test(b) || /\bRWY\s+ALL\b[^.]*\bCLSD\b|\bALL\s+RWYS?\b[^.]*\bCLSD\b/.test(b)) {
    return { kind: qualified ? "limited" : "closure", runways: [], scope: qualified ? "limited" : "full" };
  }
  // "NAV ILS RWY 28 GP U/S" (glideslope), "NAV ILS RWY 28 U/S", "… LOC/GP/DME U/S" (the whole ILS), "… DME U/S" (minor)
  const ils = /\b(ILS|LOC|LOCALIZER|GP|GS|GLIDE\s?(?:SLOPE|PATH))\b/.test(b) && OUT.test(b) && !/\bUNMONITORED\b/.test(b) && /^\s*(NAV\s+)?(ILS|LOC|RWY|GP|GS)\b/.test(b);
  if (ils) {
    const rw = /\bRWY\s+(\d{1,2}[LCR]?)\b/.exec(b);
    const parts = (/\bRWY\s+\d{1,2}[LCR]?\s+([A-Z/ ]+?)\s+(?:U\/S|OTS|OUT OF SERVICE|UNSERVICEABLE|NOT AVBL|UNAVBL|INOP)\b/.exec(b)?.[1] || "").split(/[\s/]+/).filter(Boolean);
    const loc = parts.includes("LOC") || parts.includes("LOCALIZER");
    const gp = parts.some((x) => /^(GP|GS|GLIDE)/.test(x));
    if (parts.length && !loc && !gp && parts.every((x) => /^(DME|IM|MM|OM|MKR|MARKER)$/.test(x))) return { kind: "other", runways: [] };
    return { kind: "ils", runways: rw ? [normRwy(rw[1])] : [], what: gp && !loc ? "glideslope" : "ils" };
  }
  const rws = closedRunways(b).map(normRwy);
  if (rws.length && /^\s*RWY\b/.test(b)) {
    if (qualified) return { kind: "limited", runways: rws, scope: "limited" };
    return { kind: "runway", runways: rws };
  }
  if (/\b(DEICE|DEICING|DE-ICE|DE-ICING)\b/.test(b)) return { kind: "deice", runways: [] };
  if (/^\s*(TWY|TWYS)\b/.test(b) || (/\bTWYS?\b/.test(b) && /\bCLSD\b/.test(b) && !/^\s*(APRON|RAMP)\b/.test(b))) {
    // "TWY B CLSD", "TWY B, C CLSD", "TWY B BTN TWY B5 AND TWY B7 CLSD" (part of B)
    const head = /^\s*TWYS?\s+([A-Z]{1,2}\d{0,2}(?:\s*(?:,|AND)\s*[A-Z]{1,2}\d{0,2})*)/.exec(b);
    const ids = head ? head[1].split(/\s*(?:,|AND)\s*/).filter((t) => t && !/^(BTN|ADJ|EXC|WIP|CLSD|FM|TO)$/.test(t)) : [];
    const part = /\b(BTN|FM|EAST OF|WEST OF|NORTH OF|SOUTH OF|ADJ|PARTIAL)\b/.test(b);
    return { kind: "taxiway", runways: [], taxiways: ids.slice(0, 3), closed: /\bCLSD\b/.test(b), part };
  }
  if (/^\s*OBST\b/.test(b)) return { kind: "other", runways: [] };
  if (LIGHTS.test(b) && OUT.test(b)) {
    const rw = /\bRWY\s+(\d{1,2}[LCR]?(?:\/\d{1,2}[LCR]?)?)\b/.exec(b);
    return { kind: "lighting", runways: rw ? [normRwy(rw[1])] : [] };
  }
  if (/\b(WIP|CONST\w*|CRANES?)\b/.test(b)) {
    const rw = /\bRWY\s+(\d{1,2}[LCR]?(?:\/\d{1,2}[LCR]?)?)\b/.exec(b);
    return { kind: "construction", runways: rw ? [normRwy(rw[1])] : [] };
  }
  return { kind: "other", runways: [] };
}

/** Cause class (poller/cause.mjs classes) and Settings category (site/cats.js keys) per kind. */
export const NOTAM_CAUSE = { closure: "runway", limited: "runway", runway: "runway", ils: "equipment", taxiway: "runway", construction: "runway", lighting: "equipment", deice: "runway", other: "other" };
export const NOTAM_CAT = { closure: "always", limited: "runways", runway: "runways", ils: "atc", taxiway: "runways", construction: "runways", lighting: "atc", deice: "runways", other: null };

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * One NOTAM record -> a notice item for the airport (README "Notices"), or null when it has ended or is
 * a cancellation. {id, src: "notam", kind, cat, cause, level, at, text, reason, from, to, sched?, part?,
 * runways?, raw}. level = what the item can score (runway 1 here; notices.mjs raises it per hour);
 * at: "span" (every active hour), "rwy" (runway rule), "ifr" (Low only in IFR/LIFR hours), "none" (info).
 */
export function notamItem(r, { tz = "UTC", now = new Date() } = {}) {
  if (!r || !r.text) return null;
  if (r.end != null && r.end <= +now) return null;
  const c = classifyNotam(r.text);
  const sched = notamSchedule(r.text);
  const part = !sched.length && PART_TIME.test(notamBody(r.text).toUpperCase());
  const until = untilWords(r.end, tz, now, r.perm);
  const when = sched.length ? ` ${scheduleWords(sched, tz, now)}` : part ? " at times" : "";
  const base = {
    id: r.id || r.text.slice(0, 40), src: "notam", kind: c.kind, cat: NOTAM_CAT[c.kind], cause: NOTAM_CAUSE[c.kind],
    from: r.start != null ? new Date(r.start).toISOString() : null, to: r.end != null ? new Date(r.end).toISOString() : null,
    ...(sched.length ? { sched } : {}), ...(part ? { part: true } : {}), ...(c.runways.length ? { runways: c.runways } : {}), raw: r.text,
  };
  const startWords = r.start != null && r.start > +now ? untilWords(r.start, tz, now).replace(" until ", " from ") : "";
  switch (c.kind) {
    case "closure": {
      const reason = `Airport closed${until}`;
      return { ...base, level: 4, at: part ? "none" : "span", reason, text: `The airport is closed${when}${startWords}${until}.` };
    }
    case "limited":
      return { ...base, level: 0, at: "none", reason: null, text: c.runways.length ? `${runwayNames(c.runways)} closed to some aircraft${when}${until} — airline flights are usually not affected.` : `The airport is closed to some flights${when}${until} — scheduled airline flights aren't affected.` };
    case "runway": {
      const name = runwayNames(c.runways);
      return { ...base, level: 1, at: part ? "none" : "rwy", reason: `${name} closed${until}`, text: `${name} ${c.runways.length > 1 ? "are" : "is"} closed${when}${startWords}${until}.` };
    }
    case "ils": {
      const what = c.what === "glideslope" ? "glideslope (landing guidance)" : "instrument landing system (ILS)";
      const short = c.what === "glideslope" ? "glideslope" : "ILS";
      const rw = c.runways.length ? `Runway ${c.runways[0]} ` : "";
      return { ...base, level: 1, at: "ifr", reason: `${rw}${short} out of service${until}`, text: `${cap(rw + what)} out of service${when}${startWords}${until} — can slow landings in low clouds or poor visibility.` };
    }
    case "taxiway": {
      const ids = c.taxiways || [];
      const name = ids.length ? `Taxiway${ids.length > 1 ? "s" : ""} ${ids.length > 1 ? ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1] : ids[0]}` : "Some taxiways";
      return { ...base, level: 0, at: "none", reason: null, text: `${name} ${c.closed ? (c.part ? "partly closed" : "closed") : "restricted"}${when}${until} — can add taxi time.` };
    }
    case "construction":
      return { ...base, level: 0, at: "none", reason: null, text: `Construction on the airfield${c.runways.length ? " near " + runwayNames(c.runways).replace(/^Runways?/, (x) => x.toLowerCase()) : ""}${when}${until}.` };
    case "lighting":
      return { ...base, level: 0, at: "none", reason: null, text: `${c.runways.length ? runwayNames(c.runways) + " lights" : "Some airfield lights"} out of service${when}${until}.` };
    case "deice":
      return { ...base, level: 0, at: "none", reason: null, text: `De-icing area changes${when}${until} — de-icing may take longer.` };
    default:
      return { ...base, level: 0, at: "none", reason: null, text: null };
  }
}
