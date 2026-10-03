// FAA closure text (NOTAM-style) helpers: closure scope, effective times, plain English.
// Pure; unit-tested in notam.test.mjs.
//
// The FAA NAS status "Airport Closures" list carries the NOTAM text as its Reason, e.g.
//   "!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ... 2605271826-2705281600"
// which closes LAX to private flights only. Scope decides the risk level (see risk.mjs assessFaa).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Effective times "YYMMDDHHMM-YYMMDDHHMM" (end may be "PERM", or carry "EST"). */
export function notamTimes(text) {
  const m = /\b(\d{10})\s*-\s*(\d{10}|PERM)(\s*EST)?\b/i.exec(String(text ?? ""));
  if (!m) return null;
  const at = (s) => {
    const n = s.match(/\d\d/g).map(Number);
    if (n[1] < 1 || n[1] > 12 || n[2] < 1 || n[2] > 31 || n[3] > 23 || n[4] > 59) return null;
    return Date.UTC(2000 + n[0], n[1] - 1, n[2], n[3], n[4]);
  };
  const perm = /^PERM$/i.test(m[2]);
  return { start: at(m[1]), end: perm ? null : at(m[2]), perm, est: !!m[3] };
}

/** Strip the "!LAX 05/277 LAX" header and the trailing time group. */
export function notamBody(text) {
  return String(text ?? "")
    .replace(/^\s*!\S+\s+\d+\/\d+\s+\S+\s+/, "")
    .replace(/\s*\b\d{10}\s*-\s*(\d{10}|PERM)(\s*EST)?\b\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const RWY = "(\\d{1,2}[LCR]?(?:\\/\\d{1,2}[LCR]?)?)";

/** Runway ids closed by the text: ["7L/25R"]. */
export function closedRunways(text) {
  const out = [];
  const re = new RegExp(`\\bRWY\\s+${RWY}\\b[^.]*?\\bCLSD\\b`, "gi");
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const id = m[1].toUpperCase().replace(/(^|\/)0(\d)/g, "$1$2");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * full     airport (or all runways) closed: "AD AP CLSD", "AP CLSD", "RWY ALL CLSD", or text that
 *          isn't a NOTAM at all (e.g. "snow removal": the FAA listed the airport as closed)
 * runway   particular runways closed: "RWY 7L/25R CLSD"
 * limited  closed only to some users or with exceptions: "CLSD TO NON SKED TRANSIENT GA", "EXC PPR",
 *          or only taxiways/aprons closed
 */
export function closureScope(text) {
  const s = notamBody(text).toUpperCase();
  const fullAd = /\b(AD\s+AP|AD|AP)\s+CLSD\b/.test(s);
  const allRwy = /\bRWY\s+ALL\b[^.]*\bCLSD\b|\bALL\s+RWYS?\b[^.]*\bCLSD\b/.test(s);
  const qualified = /\bCLSD\s+TO\b|\bEXC\b|\bEXCEPT\b|\bPPR\b/.test(s);
  if (!fullAd && !allRwy && closedRunways(s).length) return "runway";
  if (fullAd || allRwy) return qualified ? "limited" : "full";
  if (/\b(TWY|APRON|RAMP)\b[^.]*\bCLSD\b/.test(s)) return "limited";
  if (/\bCLSD\b/.test(s) && qualified) return "limited";
  return "full";
}

const PHRASES = [
  [/\bAD\s+AP\s+CLSD\b/g, "airport closed"],
  [/\bAP\s+CLSD\b/g, "airport closed"],
  [/\bAD\s+CLSD\b/g, "airport closed"],
  [/\bNON\s+SKED\b/g, "non-scheduled"],
  [/\b(\d+)\s*HR\s+PPR\b/g, "prior permission required $1 hours ahead"],
  [/\bU\/S\b/g, "unserviceable"],
];
const WORDS = {
  AD: "airport", AP: "airport", RWY: "runway", RWYS: "runways", TWY: "taxiway", TWYS: "taxiways", CLSD: "closed",
  EXC: "except", PPR: "prior permission required", TRANSIENT: "transient", GA: "general aviation", ACFT: "aircraft",
  CTC: "contact", SKED: "scheduled", DLY: "daily", BTN: "between", OTS: "out of service", WIP: "work in progress",
  ILS: "ILS", TO: "to", OR: "or", AND: "and", FOR: "for", ALL: "all", WITH: "with", IN: "in", ON: "on", OF: "of",
};

/** Expand common NOTAM contractions; anything unknown is kept as written. */
export function translateNotam(text) {
  let s = notamBody(text);
  if (!s) return "";
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  s = s
    .split(" ")
    .map((tok) => {
      if (/^RWY$/i.test(tok)) return "runway";
      return Object.prototype.hasOwnProperty.call(WORDS, tok) ? WORDS[tok] : tok;
    })
    .join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const dtfCache = new Map();
function parts(ms, tz) {
  const k = tz;
  if (!dtfCache.has(k)) {
    dtfCache.set(k, new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }));
  }
  const o = {};
  for (const p of dtfCache.get(k).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
const ZONE = { EDT: "ET", EST: "ET", CDT: "CT", CST: "CT", MDT: "MT", MST: "MT", PDT: "PT", PST: "PT", AKDT: "AKT", AKST: "AKT" };

/**
 * "until 9 AM PT" when the end falls on today's local date, else "through May 28, 2027"
 * (year only when it differs from now's). est adds "about".
 */
export function endPhrase(endMs, tz, now = new Date(), est = false) {
  if (endMs == null) return "";
  const e = parts(endMs, tz);
  const n = parts(+now, tz);
  const about = est ? "about " : "";
  if (e.year === n.year && e.month === n.month && e.day === n.day) {
    const min = e.minute === "00" ? "" : ":" + e.minute;
    return `until ${about}${e.hour}${min} ${String(e.dayPeriod || "").toUpperCase()} ${ZONE[e.timeZoneName] || e.timeZoneName}`.replace(/\s+/g, " ");
  }
  return `through ${about}${MONTHS[Number(e.month) - 1]} ${e.day}${e.year !== n.year ? ", " + e.year : ""}`;
}

/**
 * Everything the app needs for one FAA closure entry.
 * Returns {scope, active, start, end, perm, detail, plain, runways}.
 * detail: "until 9 AM PT" / "through May 28, 2027" / "permanently" / fallback ("until <Reopen>").
 */
export function describeClosure(text, { tz = "America/New_York", now = new Date(), reopen = "" } = {}) {
  const scope = closureScope(text);
  const t = notamTimes(text);
  const runways = closedRunways(text);
  const end = t?.end ?? null;
  let detail = "";
  if (t?.perm) detail = "permanently";
  else if (end != null) detail = endPhrase(end, tz, now, t.est);
  else if (reopen) detail = `until ${reopen}`;
  const active = (t?.start == null || t.start <= +now) && (end == null || end > +now);
  const when = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) + "." : "";
  const body = notamBody(text).toUpperCase();
  let plain;
  if (scope === "limited" && /\b(GA|NON\s+SKED|TRANSIENT|PRIVATE)\b/.test(body)) {
    const ppr = /\b(\d+)\s*HR\s+PPR\b/.exec(body);
    const unless = ppr ? ` unless approved ${ppr[1]} hours ahead` : /\bPPR\b/.test(body) ? " unless approved in advance" : "";
    plain = `Closed to private (non-scheduled, general aviation) flights${unless}. Airline flights aren't affected.`;
  } else if (scope === "runway") {
    const ids = runways.join(", ");
    const rest = translateNotam(text).replace(/^Runway\s+\S+\s+closed\s*/i, "").trim();
    plain = `${runways.length > 1 ? "Runways" : "Runway"} ${ids} closed${rest ? " " + rest : ""}.`;
  } else if (scope === "full" && /\bCLSD\b/.test(body)) {
    const rest = translateNotam(text).replace(/^Airport closed\s*/i, "").trim();
    plain = `Airport closed${rest ? " " + rest : ""}.`;
  } else if (scope === "full") {
    plain = "Airport closed" + (String(text ?? "").trim() ? ` (${String(text).trim()})` : "") + ".";
  } else {
    plain = translateNotam(text).replace(/\.?$/, ".");
  }
  plain = [plain, when].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return { scope, active, start: t?.start ?? null, end, perm: !!t?.perm, detail, plain, runways };
}
