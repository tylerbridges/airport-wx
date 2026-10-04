// Hub cascade warnings (README "Hub cascade"). Pure ES module, no I/O and no node: imports (core.mjs
// imports it, so the live relay runs it too).
//
// When a carrier hub has a ground stop, a ground delay program, a full closure, or its delay chance is
// "Delays likely" or worse in some hour — hours[].delay.p >= 0.45 (the "likely" cut-off of site/delay.js
// likelihood(); FAA overrides are p = 1) and, as site/delay.js notable(), not a routine rate: an FAA
// override, a risk level of Low or more, or 1.25x the hour's usual rate — every airport with heavy
// service to that hub (TOP_ROUTES) gets a
// cascade note in the 1–4 hours after it: "ORD ground stop may delay flights to and from Chicago".
// Airports in the same TRACON as the hub (e.g. JFK/LGA/EWR) get no note from it: they share the
// weather and the airspace, and have no flights between them.
// The note may raise an airport's hour level by at most one step and never above Moderate:
//   ground stop / ground delay program / closure: base None -> Low ("some flights"), Low -> Moderate,
//   Moderate or worse unchanged; hub "Delays likely": Low ("some flights"), never raises past Low.
// It never touches the delay chance, so it never makes an hour "Delays happening now".

/**
 * US carrier hubs (mainline hubs and focus cities with the largest banks, approximate, 2026). Only
 * hubs that are also among the 32 airports in airports.json can trigger a note (PDX, DAL and HOU are
 * listed for completeness).
 */
export const CARRIER_HUBS = {
  AA: ["DFW", "CLT", "ORD", "PHL", "MIA", "PHX", "DCA", "LGA", "JFK", "LAX"],
  DL: ["ATL", "DTW", "MSP", "SLC", "JFK", "LGA", "BOS", "SEA", "LAX"],
  UA: ["ORD", "DEN", "IAH", "EWR", "SFO", "IAD", "LAX"],
  WN: ["MDW", "DEN", "LAS", "PHX", "BWI", "DAL", "HOU", "MCO"],
  AS: ["SEA", "PDX", "ANC"],
  B6: ["JFK", "BOS", "FLL"],
};
export const HUBS = new Set(Object.values(CARRIER_HUBS).flat());

/**
 * Major TRACONs (terminal radar approach controls) that serve more than one large airport. Airports in
 * one group share arrival/departure airspace; a hub never cascades to another airport in its group.
 */
export const TRACONS = {
  N90: ["JFK", "LGA", "EWR"], // New York
  C90: ["ORD", "MDW"], // Chicago
  PCT: ["DCA", "IAD", "BWI"], // Potomac (Washington/Baltimore)
  SCT: ["LAX", "SAN"], // Southern California
  NCT: ["SFO"], // Northern California (OAK, SJC not tracked)
  MIA: ["MIA", "FLL"], // Miami
  D10: ["DFW", "DAL"], // Dallas–Fort Worth
  I90: ["IAH", "HOU"], // Houston
};
const TRACON_OF = new Map(Object.entries(TRACONS).flatMap(([k, list]) => list.map((c) => [c, k])));
export const sameTracon = (a, b) => a !== b && TRACON_OF.has(a) && TRACON_OF.get(a) === TRACON_OF.get(b);

/**
 * Top 5 hub connections per airport, by scheduled flights. APPROXIMATE: compiled by hand from BTS
 * T-100 domestic segment rankings and published airline schedules (2025–2026); no BTS route-volume file
 * is shipped with the app (site/data/model has none). Same-TRACON hubs are left out. Review yearly.
 */
export const TOP_ROUTES = {
  ATL: ["LGA", "DFW", "ORD", "DCA", "MCO"],
  DFW: ["ORD", "LAX", "LGA", "ATL", "CLT"],
  DEN: ["LAS", "PHX", "ORD", "LAX", "DFW"],
  ORD: ["LGA", "DFW", "ATL", "DEN", "LAX"],
  LAX: ["SFO", "JFK", "LAS", "SEA", "DEN"],
  JFK: ["LAX", "SFO", "ATL", "MCO", "BOS"],
  LAS: ["DEN", "LAX", "PHX", "SEA", "SFO"],
  MCO: ["ATL", "EWR", "BWI", "JFK", "PHL"],
  MIA: ["ATL", "LGA", "JFK", "ORD", "DFW"],
  CLT: ["LGA", "ORD", "DFW", "PHL", "BOS"],
  SEA: ["ANC", "LAX", "SFO", "DEN", "LAS"],
  PHX: ["DEN", "LAX", "LAS", "DFW", "SEA"],
  EWR: ["ORD", "MCO", "ATL", "SFO", "IAH"],
  SFO: ["LAX", "SEA", "LAS", "JFK", "DEN"],
  IAH: ["DFW", "DEN", "ORD", "EWR", "ATL"],
  BOS: ["DCA", "LGA", "ORD", "ATL", "PHL"],
  FLL: ["ATL", "JFK", "LGA", "EWR", "BWI"],
  MSP: ["ORD", "DEN", "ATL", "DTW", "DFW"],
  LGA: ["ORD", "ATL", "BOS", "MIA", "CLT"],
  DTW: ["ATL", "ORD", "LGA", "MSP", "BOS"],
  PHL: ["ATL", "ORD", "CLT", "BOS", "DFW"],
  SLC: ["DEN", "LAX", "PHX", "SEA", "LAS"],
  DCA: ["BOS", "ATL", "ORD", "LGA", "CLT"],
  SAN: ["SFO", "DEN", "SEA", "LAS", "PHX"],
  BWI: ["ATL", "MCO", "BOS", "DEN", "CLT"],
  TPA: ["ATL", "CLT", "EWR", "ORD", "BWI"],
  AUS: ["DFW", "DEN", "ATL", "ORD", "PHX"],
  IAD: ["SFO", "LAX", "DEN", "ORD", "ATL"],
  BNA: ["ATL", "ORD", "DFW", "CLT", "DEN"],
  MDW: ["DEN", "LAS", "BWI", "MCO", "PHX"],
  HNL: ["LAX", "SFO", "SEA", "LAS", "DEN"],
  ANC: ["SEA", "PDX", "DEN", "MSP", "ORD"],
};

/** Hours after a hub's trouble that a note covers: the 1st through the 4th. */
export const CASCADE_FROM = 1;
export const CASCADE_TO = 4;
/** Delay chance at the hub that counts as "Delays likely" (site/delay.js likelihood cut-off). */
export const LIKELY_P = 0.45;

// kinds, strongest first
const KINDS = ["closure", "ground stop", "ground delay program", "delays"];
const VERB = { closure: "may disrupt", "ground stop": "may delay", "ground delay program": "may delay", delays: "may spread to" };

/** The hub's trouble in one status.json hour ({reasons, delay}): a KINDS entry, or null. */
export function hubTrouble(hr) {
  const rs = (hr && hr.reasons) || [];
  if (rs.some((r) => /^Airport closed\b/.test(r))) return "closure";
  if (rs.some((r) => /^Ground stop\b/.test(r))) return "ground stop";
  if (rs.some((r) => /^Ground delay program\b/.test(r))) return "ground delay program";
  const d = hr && hr.delay;
  const p = d && d.p != null ? Number(d.p) : null;
  if (p == null || !(p >= LIKELY_P)) return null;
  const typ = d.pTypical != null ? Number(d.pTypical) : null;
  // the hour's own risk: a level of Low or more from reasons other than cascade notes (a build's hours, read by
  // the live relay, already carry their notes) and the informational general-thunderstorm outlook
  const own = (hr.level | 0) >= 1 && rs.some((r) => !CASCADE_RE.test(r) && !/^General thunderstorms possible/.test(r));
  return d.override || own || (typ > 0 && p >= 1.25 * typ) ? "delays" : null; // routine busy-hour rates don't cascade
}

/**
 * The cascade reason for an hour whose level (before the note) is `base`: {level, text}.
 * "ORD ground stop may delay flights to and from Chicago" (Moderate) or "... may delay some flights ..." (Low).
 */
export function cascadeReason(hub, city, kind, base) {
  const strong = kind !== "delays" && base >= 1;
  const level = kind === "delays" ? 1 : Math.min(2, base + 1);
  return { level, text: `${hub} ${kind} ${VERB[kind]} ${strong ? "" : "some "}flights to and from ${city || hub}` };
}

/** Reads a cascade reason back: {hub, kind, level, city} or null. */
export const CASCADE_RE = /^([A-Z]{3}) (closure|ground stop|ground delay program|delays) may (?:disrupt|delay|spread to) (some )?flights to and from (.+)$/;
export function parseCascade(text) {
  const m = CASCADE_RE.exec(String(text || ""));
  return m ? { hub: m[1], kind: m[2], level: m[3] ? 1 : 2, city: m[4] } : null;
}

/**
 * Which hubs reach which airports in which hours. airports: status.json-like entries [{iata, city, hours:
 * [{t, reasons, delay}]}] (hour i of every airport is the same clock hour). Returns Map(iata -> [{i, hub,
 * kind, city}]) — per affected hour, one entry per hub (its strongest trouble in hours i-4 … i-1).
 */
export function cascades(airports) {
  const by = new Map((airports || []).map((a) => [a.iata, a]));
  const trouble = new Map();
  for (const a of airports || []) {
    if (!HUBS.has(a.iata)) continue;
    const t = (a.hours || []).map(hubTrouble);
    if (t.some(Boolean)) trouble.set(a.iata, t);
  }
  const out = new Map();
  for (const a of airports || []) {
    const n = (a.hours || []).length;
    for (const hub of TOP_ROUTES[a.iata] || []) {
      if (hub === a.iata || sameTracon(hub, a.iata) || !trouble.has(hub)) continue;
      const t = trouble.get(hub);
      const t0 = Date.parse(a.hours[0]?.t);
      const h0 = Date.parse(by.get(hub).hours[0]?.t);
      const shift = Number.isFinite(t0) && Number.isFinite(h0) ? Math.round((t0 - h0) / 3600e3) : 0; // hub hour j = this airport's j - shift
      for (let i = 0; i < n; i++) {
        let best = null;
        for (let k = CASCADE_FROM; k <= CASCADE_TO; k++) {
          const kind = t[i - k + shift];
          if (kind && (best == null || KINDS.indexOf(kind) < KINDS.indexOf(best))) best = kind;
        }
        if (!best) continue;
        if (!out.has(a.iata)) out.set(a.iata, []);
        out.get(a.iata).push({ i, hub, kind: best, city: by.get(hub).city || hub });
      }
    }
  }
  return out;
}

/**
 * Applies cascade notes to one airport's internal risk rows (risk.mjs buildHours: {t, items, level}) in
 * place, and returns the status.json summary [{hub, kind, from, to, text}]: runs of consecutive hours per
 * hub that raised at least one hour's level (a note that changed nothing stays in the hour's reasons only),
 * strongest kind first, then earliest; text = the run's strongest note as written in its hours, for the
 * card/sheet line.
 */
export function applyCascade(hours, notes) {
  const runs = [];
  const base = hours.map((h) => h.level);
  for (const x of notes || []) {
    const h = hours[x.i];
    if (!h) continue;
    const r = cascadeReason(x.hub, x.city, x.kind, base[x.i]);
    if (!h.items.some((it) => it.text === r.text)) h.items.push({ level: r.level, text: r.text, fixed: true });
    h.level = Math.max(h.level, r.level);
    const raised = r.level > base[x.i];
    const last = runs.find((u) => u.hub === x.hub && u.end === x.i - 1);
    if (last) {
      last.end = x.i;
      last.raised = last.raised || raised;
      if (KINDS.indexOf(x.kind) < KINDS.indexOf(last.kind) || (x.kind === last.kind && r.level > last.level)) Object.assign(last, { kind: x.kind, level: r.level, text: r.text });
    } else runs.push({ hub: x.hub, kind: x.kind, level: r.level, text: r.text, start: x.i, end: x.i, raised });
  }
  for (const h of hours) h.items.sort((a, b) => b.level - a.level);
  const HOUR = 3600e3;
  return runs
    .filter((u) => u.raised)
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.start - b.start)
    .map((u) => ({
      hub: u.hub, kind: u.kind,
      from: new Date(+new Date(hours[u.start].t)).toISOString(),
      to: new Date(+new Date(hours[u.end].t) + HOUR).toISOString(),
      text: u.text,
    }));
}
