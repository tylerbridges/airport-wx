// FAA ATCSCC "OPERATIONS PLAN" (DCC advisory) parser. Pure (no network); unit-tested in opsplan.test.mjs
// against a real page (poller/fixtures/atcscc.html, captured Oct 3 2026).
//
// fly.faa.gov/adv/advADB.jsp shows "The Most Recent ATCSCC Advisory". Most of the time that is the
// Command Center's operations plan: a <TH> header "ATCSCC ADVZY 072 DCC 10/03/2026 OPERATIONS PLAN"
// and, after "RAW TEXT:", a <PRE> body with sections headed by lines ending in ":" (STAFFING
// TRIGGER(S):, TERMINAL CONSTRAINTS:, TERMINAL ACTIVE:, TERMINAL PLANNED:, EN ROUTE …, CDRS/SWAP/…:,
// RUNWAY/EQUIPMENT/POSSIBLE SYSTEM IMPACT REPORTS(SIRs):, AIRSPACE FLOW PROGRAM(S) ACTIVE/PLANNED:,
// PLANNED LAUNCH/REENTRY:, …). When the most recent advisory is something else, parseOpsPlan returns null.
import { htmlToText } from "./sources.mjs";
import { classifyCause } from "./cause.mjs";

const HOUR = 3600e3;
const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

/**
 * TRACON (and a few other facility) ids -> the major airports they serve. Staffing triggers and
 * terminal constraints often name the TRACON ("N90 - WIND"). A 3-letter code that isn't listed here
 * and doesn't start with Z is taken as an airport ("BNA OPERATIONS", "PHL AREA C", "MCO/TPA").
 * Centers (Z + 2 letters: ZNY, ZJX, ZOA …) map to no airport and go to the national lists.
 */
export const FACILITY_AIRPORTS = {
  N90: ["JFK", "LGA", "EWR"], // New York TRACON
  A80: ["ATL"], // Atlanta
  C90: ["ORD", "MDW"], // Chicago
  NCT: ["SFO", "OAK", "SJC"], // NorCal
  SCT: ["LAX", "SAN", "SNA", "BUR", "ONT", "LGB"], // SoCal
  D10: ["DFW", "DAL"], // Dallas–Fort Worth
  I90: ["IAH", "HOU"], // Houston
  PCT: ["DCA", "IAD", "BWI"], // Potomac
  A90: ["BOS"], // Boston
  D01: ["DEN"], // Denver
  L30: ["LAS"], // Las Vegas
  P50: ["PHX"], // Phoenix
  M98: ["MSP"], // Minneapolis
  S46: ["SEA"], // Seattle
  F11: ["MCO"], // Central Florida
  A11: ["ANC"], // Anchorage
  HCF: ["HNL"], // Honolulu
};
// In staffing triggers a code names a facility, so these TRACONs that share an airport's code cover more airports.
const STAFFING_TRACON = { MIA: ["MIA", "FLL"] };

const isCenter = (c) => /^Z[A-Z]{2}$/.test(c);

/** Airports a facility/airport code stands for ([] for centers and unknown facility ids). */
export function facilityAirports(code, { staffing = false } = {}) {
  const c = String(code ?? "").trim().toUpperCase().replace(/^K(?=[A-Z]{3}$)/, "");
  if (staffing && STAFFING_TRACON[c]) return STAFFING_TRACON[c].slice();
  if (FACILITY_AIRPORTS[c]) return FACILITY_AIRPORTS[c].slice();
  if (isCenter(c) || !/^[A-Z]{3}$/.test(c)) return [];
  return [c];
}
const airportsOf = (codes, opt) => [...new Set(codes.flatMap((c) => facilityAirports(c, opt)))];

// ---------- times ----------

/** "0100" (UTC) -> ms: the first such time not more than 30 min before the base time (rolls past midnight). */
export function untilHhmm(hhmm, base) {
  const m = /^(\d{2})(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m || base == null) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 24 || mm > 59) return null;
  const d = new Date(base);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
  if (t < base - 30 * 60e3) t += 24 * HOUR;
  return t;
}

/** "10/10/26 0900Z" or "10/31/2026 0900Z" -> ms. */
export function mdyTime(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s+(\d{2})(\d{2})Z?/.exec(String(s ?? ""));
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const t = Date.UTC(y, Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : null;
}

/** "10/05/26 0806Z-0911Z" -> {start, end} (end rolls past midnight). */
function window(s) {
  const m = /(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))\s+(\d{4})Z?\s*-\s*(\d{4})Z?/.exec(String(s ?? ""));
  if (!m) return null;
  const start = mdyTime(`${m[1]} ${m[2]}`);
  let end = mdyTime(`${m[1]} ${m[3]}`);
  if (start != null && end != null && end <= start) end += 24 * HOUR;
  return { start: iso(start), end: iso(end) };
}

// ---------- sections ----------

const HEADER = /^([A-Z][A-Za-z0-9 ()/&,.'-]*?)\s*:$/; // "RUNWAY/EQUIPMENT/POSSIBLE SYSTEM IMPACT REPORTS(SIRs):"
const SECTION_KEYS = [
  ["staffing", /^STAFFING/i],
  ["terminalConstraints", /^TERMINAL CONSTRAINTS?/i],
  ["terminalActive", /^TERMINAL ACTIVE/i],
  ["terminalPlanned", /^TERMINAL PLANNED/i],
  ["enrouteConstraints", /^EN ?ROUTE CONSTRAINTS?/i],
  ["enrouteActive", /^EN ?ROUTE ACTIVE/i],
  ["enroutePlanned", /^EN ?ROUTE PLANNED/i],
  ["cdrs", /^CDRS|^SWAP/i],
  ["sirs", /^RUNWAY\/EQUIPMENT|SYSTEM IMPACT|\bSIRS?\b/i],
  ["afpActive", /^AIRSPACE FLOW PROGRAMS?(\(S\))? ACTIVE/i],
  ["afpPlanned", /^AIRSPACE FLOW PROGRAMS?(\(S\))? PLANNED/i],
  ["launches", /LAUNCH|REENTRY/i],
];
const sectionKey = (h) => (SECTION_KEYS.find(([, re]) => re.test(h)) || [null])[0];

/** "UNTIL 0100 -BNA OPERATIONS" -> {until (hhmm), from (hhmm), rest}. Also "AFTER 2200 -…" and "2200-0200 -…". */
function timed(line) {
  let m = /^UNTIL\s+(\d{4})Z?\s*-?\s*(.*)$/.exec(line);
  if (m) return { until: m[1], from: null, rest: m[2].trim() };
  m = /^AFTER\s+(\d{4})Z?\s*-?\s*(.*)$/.exec(line);
  if (m) return { until: null, from: m[1], rest: m[2].trim() };
  m = /^(\d{4})Z?\s*-\s*(\d{4})Z?\s+-?\s*(.*)$/.exec(line);
  if (m) return { until: m[2], from: m[1], rest: m[3].trim() };
  return { until: null, from: null, rest: line.replace(/^-\s*/, "").trim() };
}

/** GS | GDP | GS/GDP | null from "GROUND STOP POSSIBLE", "GROUND DELAY PROGRAM", "GROUND STOP/DELAY PROGRAM POSSIBLE". */
export function programKind(s) {
  const t = String(s ?? "").toUpperCase();
  const gs = /GROUND STOP|\bGS\b/.test(t);
  const gdp = /DELAY PROGRAM|\bGDP\b/.test(t);
  return gs && gdp ? "GS/GDP" : gs ? "GS" : gdp ? "GDP" : null;
}

const SIR_STATUS = [
  ["out of service", /\b(OTS|OUT OF SERVICE|U\/S|INOP)\b/],
  ["limited", /\bLIMITED\b|\bLTD\b/],
  ["construction", /\bCONSTRUCTION\b|\bCONST\b|\bWIP\b/],
  ["maintenance", /\bMAINT\w*\b/],
  ["closed", /\bCLOSED\b|\bCLSD\b|\bCLOSURES?\b/],
];
const RWY_ID = /\b(\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?)\b/g;
const normRwy = (r) => r.toUpperCase().replace(/(^|\/)0(\d)/g, "$1$2");

/** "BWI - RWY 10/28 - 15R/33L CLOSED UNTIL 10/10/26 0900Z" -> SIR record (or null). */
export function parseSir(line) {
  const m = /^([A-Z0-9]{2,4})\s*-\s*(.+?)(?:\s+UNTIL\s+(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\s+\d{4}Z?))?\s*$/.exec(line);
  if (!m) return null;
  const facility = m[1];
  const body = m[2].trim();
  const status = (SIR_STATUS.find(([, re]) => re.test(body)) || ["other"])[0];
  // runway ids only from the part that names runways ("RWY 01R/19L/TWY W" -> 01R/19L)
  const rwyPart = /\bRWYS?\b(.*?)(?:\bTWYS?\b|$)/.exec(body)?.[1] || "";
  const runways = [];
  let r;
  RWY_ID.lastIndex = 0;
  while ((r = RWY_ID.exec(rwyPart))) if (!runways.includes(r[1])) runways.push(r[1]);
  const taxiway = /\bTWYS?\b/.test(body);
  const what = /\bGS\b|GLIDE ?SLOPE/.test(body) ? "glideslope" : /\bILS\b/.test(body) ? "ils" : runways.length ? "runway" : taxiway ? "taxiway" : "other";
  const cause = status === "out of service" || status === "maintenance" || what === "glideslope" || what === "ils" ? "equipment"
    : what === "runway" || what === "taxiway" ? "runway" : classifyCause(body);
  return {
    facility, airports: facilityAirports(facility), item: body, status, what, runways, taxiway,
    until: iso(mdyTime(m[3])), cause, raw: line,
  };
}

function parseLaunches(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (!l) { cur = null; continue; }
    const w = /^(PRIMARY|BACKUP)\s*:?\s*(.*)$/.exec(l);
    if (w && cur) {
      cur[w[1].toLowerCase()] = window(w[2]);
      cur.raw += "\n" + l;
      continue;
    }
    if (/^NONE\b/.test(l)) continue;
    const [name, ...site] = l.split(",").map((x) => x.trim());
    cur = { name, site: site.join(", ") || null, primary: null, backup: null, cause: "space", raw: l };
    out.push(cur);
  }
  return out;
}

/**
 * Parse the operations plan from the advADB page (HTML or text). Returns null when the page isn't an
 * operations plan. Times are ISO strings (UTC); "UNTIL hhmm" times roll past midnight relative to the
 * advisory's issue time (its signature line, else the advisory date + EVENT TIME).
 */
export function parseOpsPlan(input) {
  const text = /<[a-z!/][^>]*>/i.test(String(input ?? "")) ? htmlToText(input) : String(input ?? "").replace(/&nbsp;/gi, " ");
  const head = /ATCSCC\s+ADVZY\s+(\d+)\s+(\S+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+OPERATIONS\s+PLAN/i.exec(text);
  if (!head) return null;
  const [, num, from, mo, dd, yyyy] = head;
  let body = text.slice(head.index + head[0].length);
  const rt = body.search(/RAW TEXT:/i);
  if (rt >= 0) body = body.slice(rt + "RAW TEXT:".length);
  const lines = body.split("\n").map((l) => l.replace(/[\t ]+/g, " ").trim());

  const date = Date.UTC(Number(yyyy), Number(mo) - 1, Number(dd));
  let issued = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const sig = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):?(\d{2})\b/.exec(lines[i]);
    if (sig) { issued = Date.UTC(2000 + Number(sig[1]), Number(sig[2]) - 1, Number(sig[3]), Number(sig[4]), Number(sig[5])); break; }
  }
  const ev = lines.map((l) => /^EVENT TIME:\s*(.*)$/i.exec(l)).find(Boolean);
  let eventTime = null;
  const evm = ev && /(\d{2})\/(\d{2})(\d{2})/.exec(ev[1]);
  if (evm) {
    const d = new Date(date);
    eventTime = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Number(evm[1]), Number(evm[2]), Number(evm[3]));
    if (eventTime < date - 15 * 24 * HOUR) eventTime = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Number(evm[1]), Number(evm[2]), Number(evm[3]));
  }
  const base = issued ?? eventTime ?? date;
  const valid = lines.map((l) => /^(\d{2})(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})(\d{2})$/.exec(l)).find(Boolean);
  let validEnd = null;
  if (valid) {
    validEnd = untilHhmm(valid[5] + valid[6], base);
  }

  // remarks: the text between the first two rules of underscores
  const rules = lines.map((l, i) => (/^_{10,}$/.test(l) ? i : -1)).filter((i) => i >= 0);
  const remarks = rules.length >= 2 ? lines.slice(rules[0] + 1, rules[1]).filter(Boolean).join(" ").replace(/\s+/g, " ") : null;
  // narrative sentences about delays or deviations, with the 3-letter codes they name ("TPA AND MCO …")
  const notes = (remarks || "").split(/(?<=\.)\s+/).filter((x) => /\bDELAY|\bDEVIAT/.test(x))
    .map((x) => ({ text: x.trim(), codes: [...new Set(x.match(/\b[A-Z][A-Z0-9]{2}\b/g) || [])], continuing: /\bCONTINU|\bSOME TIME\b|\bLATER\b/.test(x), raw: x.trim() }));

  const sections = {};
  let key = null;
  for (const l of lines) {
    const h = HEADER.exec(l);
    if (h && !/^(PRIMARY|BACKUP|UNTIL|AFTER)\b/.test(l)) { key = sectionKey(h[1]); if (key) sections[key] = []; continue; }
    // the event time, rules, and the trailer (valid period "032128-032359", signature "26/10/03 21:28 …") end a section
    if (/^EVENT TIME:|^_{10,}$|^\d{6}\s*-\s*\d{6}$|^\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\b/.test(l)) { key = null; continue; }
    if (key) sections[key].push(l);
  }
  const content = (k) => (sections[k] || []).filter((l) => l && !/^NONE\b/.test(l));
  const timedItems = (k) => content(k).map((l) => {
    const t = timed(l);
    return { text: t.rest, until: iso(untilHhmm(t.until, base)), from: iso(untilHhmm(t.from, base)), raw: l };
  });

  const staffing = content("staffing").map((l) => {
    const t = timed(l);
    const [facility, ...detail] = t.rest.split(/\s+/);
    return {
      kind: "staffing", facility, detail: detail.join(" ") || null, airports: facilityAirports(facility, { staffing: true }),
      until: iso(untilHhmm(t.until, base)), cause: "staffing", raw: l,
    };
  });

  const constraints = content("terminalConstraints").map((l) => {
    const m = /^([A-Z0-9/ ]+?)\s*-\s*(.+)$/.exec(l);
    if (!m) return null;
    const codes = m[1].split("/").map((c) => c.trim()).filter(Boolean);
    const reason = m[2].replace(/\.$/, "").trim();
    return { codes, airports: airportsOf(codes), reason, cause: classifyCause(reason), raw: l };
  }).filter(Boolean);

  const programs = [];
  for (const [k, status0] of [["terminalActive", "active"], ["terminalPlanned", "possible"]]) {
    for (const l of content(k)) {
      const t = timed(l);
      const m = /^([A-Z0-9]{3}(?:\/[A-Z0-9]{3})*)\s+(.*)$/.exec(t.rest);
      const codes = m ? m[1].split("/") : [];
      const what = m ? m[2].trim() : t.rest;
      const status = status0 === "active" && !/POSSIBLE|PROBABLE|EXPECTED|LIKELY/.test(what) ? "active" : "possible";
      programs.push({
        codes, airports: airportsOf(codes), program: programKind(what) || "other", status, text: what,
        until: iso(untilHhmm(t.until, base)), from: iso(untilHhmm(t.from, base)), raw: l,
      });
    }
  }

  const sirs = content("sirs").map(parseSir).filter(Boolean);

  return {
    advisory: num.padStart(3, "0"), from, date: iso(date).slice(0, 10), issued: iso(issued), eventTime: iso(eventTime),
    eventText: ev ? ev[1].trim() : null, validEnd: iso(validEnd), remarks, notes,
    staffing, constraints, programs, sirs,
    enroute: { constraints: content("enrouteConstraints").map((l) => ({ text: l, raw: l })), active: timedItems("enrouteActive"), planned: timedItems("enroutePlanned") },
    cdrs: timedItems("cdrs"),
    afp: { active: timedItems("afpActive"), planned: timedItems("afpPlanned") },
    launches: parseLaunches(sections.launches || []),
  };
}

const live = (x, now) => x.until == null || Date.parse(x.until) > +now;
const strip = ({ airports, ...x }) => x;

/** Airport codes the plan itself uses in its structured lines (to tell "MCO" from "THE" in narrative text). */
function planAirports(plan) {
  return new Set([...plan.staffing, ...plan.constraints, ...plan.programs, ...plan.sirs].flatMap((x) => x.airports || []));
}

/**
 * The plan's items for one airport (expired ones dropped): {plan: {advisory, issued, validEnd}, staffing,
 * constraints, programs, sirs, notes}, or null when nothing names the airport. notes: narrative sentences
 * about delays/deviations naming the airport ({text, airports, continuing, raw}); `known` adds codes
 * (e.g. every airport we track) to the ones the plan uses for recognising airports in that text.
 */
export function opsPlanFor(plan, iata, now = new Date(), known = null) {
  if (!plan) return null;
  const has = (x) => (x.airports || []).includes(iata);
  const codes = planAirports(plan);
  for (const k of known || []) codes.add(k);
  codes.add(iata);
  const out = {
    plan: { advisory: plan.advisory, issued: plan.issued, validEnd: plan.validEnd },
    staffing: plan.staffing.filter((x) => has(x) && live(x, now)).map(strip),
    constraints: plan.constraints.filter(has).map(strip),
    programs: plan.programs.filter((x) => has(x) && x.program !== "other" && live(x, now)).map(strip),
    sirs: plan.sirs.filter((x) => has(x) && live(x, now)).map(strip),
    notes: (plan.notes || []).filter((n) => n.codes.includes(iata))
      .map((n) => ({ text: n.text, airports: n.codes.filter((c) => codes.has(c) && !/^Z[A-Z]{2}$/.test(c)).sort(), continuing: n.continuing, raw: n.raw })),
  };
  return out.staffing.length || out.constraints.length || out.programs.length || out.sirs.length || out.notes.length ? out : null;
}

/**
 * Nationwide items for a future "national summary": {plan, remarks, staffing (lines naming no airport,
 * e.g. center areas), enroute {constraints, active, planned}, cdrs, launches, afp {active, planned},
 * sirs (center/facility reports such as "ZMA - GDT RCAG MAINTENANCE")}.
 */
export function opsPlanNational(plan, now = new Date()) {
  if (!plan) return null;
  const nowhere = (x) => !(x.airports || []).length;
  return {
    plan: { advisory: plan.advisory, issued: plan.issued, eventTime: plan.eventTime, eventText: plan.eventText, validEnd: plan.validEnd },
    remarks: plan.remarks,
    staffing: plan.staffing.filter((x) => nowhere(x) && live(x, now)).map(strip),
    enroute: {
      constraints: plan.enroute.constraints,
      active: plan.enroute.active.filter((x) => live(x, now)),
      planned: plan.enroute.planned.filter((x) => live(x, now)),
    },
    cdrs: plan.cdrs.filter((x) => live(x, now)),
    launches: plan.launches.filter((x) => { const e = x.backup?.end || x.primary?.end; return !e || Date.parse(e) > +now; }),
    afp: { active: plan.afp.active.filter((x) => live(x, now)), planned: plan.afp.planned.filter((x) => live(x, now)) },
    sirs: plan.sirs.filter((x) => nowhere(x) && live(x, now)).map(strip),
  };
}
