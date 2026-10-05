// Tolerant parsers for the phase-1 sources: NWS LAMP text bulletins, FAA ATCSCC advisories,
// AWC TFM Convective Forecast (TCF) and Center Weather Advisories (CWA), plus program-cause
// classification. Pure (no network); unit-tested in sources.test.mjs.
//
// Several of these formats were written from documentation without seeing a live response
// (the dev sandbox can't reach the hosts). Every parser returns empty results rather than
// throwing on unexpected input; the poller saves raw samples so formats can be checked.
import { pointNearRing, pointNearGeometry, decodeXml, attrOf } from "./lib.mjs";
import { toMs } from "./risk.mjs";
import { classifyCause } from "./cause.mjs";

const HOUR = 3600e3;
const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

export { classifyCause } from "./cause.mjs";

// ---------- NWS LAMP text bulletin ----------

export const LAMP_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/lmp/prod";
const p2 = (n) => String(n).padStart(2, "0");

/** LAMP cycles (HH:30 UTC) at or before now, newest first: back + 1 of them. */
export function lampCycles(now = new Date(), back = 3) {
  let t = Math.floor(+now / HOUR) * HOUR + 30 * 60e3;
  if (t > +now) t -= HOUR;
  return Array.from({ length: back + 1 }, (_, i) => new Date(t - i * HOUR));
}

export function lampUrl(cycle) {
  const d = new Date(cycle);
  const ymd = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  return `${LAMP_BASE}/lmp.${ymd}/lmp.t${p2(d.getUTCHours())}30z.lavtxt.ascii`;
}

const LAMP_HEAD = /^\s*([A-Z][A-Z0-9]{3})\s+.*\bLAMP\b/i;
const LAMP_DATE = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2})(\d{2})\s*UTC/i;

function lampInt(s) {
  return /^\d{1,3}$/.test(s) ? Number(s) : null;
}

/**
 * Parse a LAMP bulletin (concatenated per-station blocks, e.g. " KMSP   GFS LAMP GUIDANCE  10/03/2026  2130 UTC").
 * Columns are located from the UTC row by character position: each value is the 3 characters ending
 * where that row's hour number ends (right-justified fixed width, so "100100" is two values and
 * sparse rows such as P06, which only has a value every 6th column, line up). Unknown rows are ignored.
 * Real CONUS blocks have hourly P01/PC1/LP1/LC1/CP1/CC1 rows; some (e.g. Hawaii) have no probability
 * rows at all, and there is no LP2/CP2 row. LP1/CP1 are used; LP2/CP2 only when LP1/CP1 are missing.
 * want: optional Set of ICAO ids to keep. Returns {stations: {ICAO: {issued, hours}}, blocks}.
 * hours: [{t, gust (kt, 0 = "NG"), tstmProb (LP1 lightning %, else LP2), convProb (CP1 convection %,
 *          else CP2), probHrs (1 for LP1/CP1, 2 for LP2/CP2: the period ending at t), cig (1-8),
 *          vis (1-7), typ (R/S/Z), pFrz (POZ), pPrecip (PPO)}]; a field is null where the row is blank.
 */
export function parseLamp(text, want = null) {
  const lines = String(text ?? "").split(/\r?\n/);
  const stations = {};
  let blocks = 0;
  let i = 0;
  while (i < lines.length) {
    const h = LAMP_HEAD.exec(lines[i]);
    if (!h) { i++; continue; }
    blocks++;
    const id = h[1].toUpperCase();
    const dm = LAMP_DATE.exec(lines[i]);
    const rows = {};
    i++;
    while (i < lines.length && !LAMP_HEAD.exec(lines[i])) {
      const m = /^(\s*)([A-Z][A-Z0-9]{2})/.exec(lines[i]);
      if (m && !rows[m[2]]) rows[m[2]] = { line: lines[i], start: m[0].length };
      i++;
    }
    if (want && !want.has(id)) continue;
    if (!dm || !rows.UTC) continue;
    try {
      const issued = Date.UTC(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]), Number(dm[4]), Number(dm[5]));
      if (!Number.isFinite(issued)) continue;
      const cols = [];
      const re = /\d{1,2}/g;
      const u = rows.UTC;
      re.lastIndex = u.start;
      let mm;
      while ((mm = re.exec(u.line))) cols.push({ hour: Number(mm[0]), end: mm.index + mm[0].length });
      if (!cols.length) continue;
      let w = 3;
      for (let k = 1; k < cols.length; k++) w = Math.min(w, cols[k].end - cols[k - 1].end);
      w = Math.max(2, w);
      const cell = (label, k) => {
        const r = rows[label];
        if (!r) return "";
        const end = cols[k].end;
        return r.line.slice(Math.max(r.start, end - w), end).trim().toUpperCase();
      };
      let prev = issued - 2 * HOUR;
      const hours = [];
      for (let k = 0; k < cols.length; k++) {
        if (cols[k].hour > 23) break;
        const day = new Date(prev);
        let t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), cols[k].hour);
        while (t <= prev) t += 24 * HOUR;
        prev = t;
        const wgs = cell("WGS", k);
        const typ = cell("TYP", k);
        const one = !!(rows.LP1 || rows.CP1);
        hours.push({
          t: iso(t),
          gust: wgs === "NG" ? 0 : lampInt(wgs),
          tstmProb: lampInt(cell(rows.LP1 ? "LP1" : "LP2", k)),
          convProb: lampInt(cell(rows.CP1 ? "CP1" : "CP2", k)),
          probHrs: one ? 1 : rows.LP2 || rows.CP2 ? 2 : null,
          cig: lampInt(cell("CIG", k)),
          vis: lampInt(cell("VIS", k)),
          typ: /^[A-Z]$/.test(typ) ? typ : null,
          pFrz: lampInt(cell("POZ", k)),
          pPrecip: lampInt(cell("PPO", k)),
        });
      }
      stations[id] = { issued: iso(issued), hours };
    } catch {
      /* skip a malformed block */
    }
  }
  return { stations, blocks };
}

/** Raw text of the blocks for the wanted stations (for the raw sample). */
export function lampBlocks(text, want) {
  const out = [];
  let keep = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h = LAMP_HEAD.exec(line);
    if (h) keep = want.has(h[1].toUpperCase());
    if (keep) out.push(line);
  }
  return out.join("\n");
}

// ---------- FAA ATCSCC advisories ----------

export const ATCSCC_URL = "https://www.fly.faa.gov/adv/advADB.jsp";

/** Rough HTML -> text: drops scripts/styles/tags, keeps line structure. */
export function htmlToText(html) {
  return decodeXml(
    String(html ?? "")
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|pre|h\d|table|td|th)\s*>/gi, (m, t) => (/^t[dh]$/i.test(t) ? " " : "\n"))
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
  )
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Links on the advisory list page: [{href (absolute), title}]. */
export function atcsccLinks(html, base = ATCSCC_URL) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const page = String(html ?? "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  let m;
  while ((m = re.exec(page))) {
    let href = attrOf(m[1], "href");
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) {
      const oc = /['"]([^'"]*\.jsp[^'"]*)['"]/i.exec(attrOf(m[1], "onclick"));
      href = oc ? oc[1] : "";
    }
    if (!href) continue;
    let abs;
    try { abs = new URL(href, base).href; } catch { continue; }
    let title = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    if (!title) {
      try { title = new URL(abs).searchParams.get("title") || ""; } catch { /* ignore */ }
    }
    if (!/adv/i.test(abs) && !/ADVZY/i.test(title)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ href: abs, title });
  }
  return out;
}

export function advType(s) {
  const t = String(s ?? "").toUpperCase();
  if (/GROUND STOP|\bGS\b/.test(t)) return "GS";
  if (/GROUND DELAY|\bGDP\b/.test(t)) return "GDP";
  if (/AIRSPACE FLOW|\bAFP\b/.test(t)) return "AFP";
  return "other";
}
const isCnx = (s) => /\bCNX\b|CANCEL/i.test(String(s ?? ""));
const PROGRAM_RE = /GROUND STOP|GROUND DELAY|\bGDP\b|\bGS\b|AIRSPACE FLOW|\bAFP\b/i;

/** "DD HH MM" near now (picks the month that puts it closest to now). */
export function resolveDdhhmm(dd, hh, mm, now = new Date()) {
  const n = new Date(now);
  let best = null;
  for (const off of [-1, 0, 1]) {
    const t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + off, dd, hh, mm);
    if (new Date(t).getUTCDate() !== dd) continue;
    if (best == null || Math.abs(t - +now) < Math.abs(best - +now)) best = t;
  }
  return best;
}

/** "03/2010Z – 03/2115Z" or "032012 - 032130" -> {start, end} (ms). */
export function parsePeriod(s, now = new Date()) {
  const m = /(\d{2})\/?(\d{2})(\d{2})Z?\s*[-–—]+\s*(\d{2})\/?(\d{2})(\d{2})Z?/.exec(String(s ?? ""));
  if (!m) return null;
  const n = m.slice(1).map(Number);
  if (n[1] > 23 || n[2] > 59 || n[4] > 23 || n[5] > 59) return null;
  const start = resolveDdhhmm(n[0], n[1], n[2], now);
  let end = resolveDdhhmm(n[3], n[4], n[5], now);
  if (start != null && end != null && end < start) end = resolveDdhhmm(n[3], n[4], n[5], new Date(start + 15 * 24 * HOUR));
  return { start, end };
}

/** One advisory's text (from "ATCSCC ADVZY ..." on). Returns an advisory or null. */
export function parseAdvisory(text, { title = "", href = "", now = new Date() } = {}) {
  let s = String(text ?? "");
  const at = s.search(/ATCSCC\s+ADVZY/i);
  if (at >= 0) s = s.slice(at);
  const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length && !title) return null;
  const header = at >= 0 ? lines[0] : title || lines[0] || "";
  const fields = {};
  for (const l of lines) {
    const f = /^([A-Z][A-Z0-9 /().-]{1,40}?)\s*:\s*(.*)$/.exec(l);
    if (f && !(f[1].trim() in fields)) fields[f[1].trim()] = f[2].trim();
  }
  const get = (...keys) => { for (const k of keys) if (fields[k]) return fields[k]; return ""; };
  const name = header || title;
  const type = advType(name) !== "other" ? advType(name) : advType(title);
  const num = /ADVZY\s+(\d+)/i.exec(name)?.[1] || /ADVZY\s+(\d+)/i.exec(title)?.[1] || null;
  const dmy = /(\d{2})\/(\d{2})\/(\d{4})/.exec(name) || /(\d{2})\/(\d{2})\/(\d{4})/.exec(title);

  const ctl = get("CTL ELEMENT", "CTL ELEMENTS", "CONTROL ELEMENT").toUpperCase();
  let airport = null;
  const c = /^K?([A-Z0-9]{3})$/.exec(ctl);
  if (c) airport = c[1];
  else {
    const t = /\b([A-Z0-9]{3})\/Z[A-Z]{2}\b/.exec(name) || /\b([A-Z0-9]{3})\/Z[A-Z]{2}\b/.exec(title);
    if (t) airport = t[1];
  }

  const causeText = get("IMPACTING CONDITION", "IMPACTING CONDITIONS", "REASON", "CAUSE").replace(/[.\s]+$/, "");
  let period = null;
  for (const k of ["GROUND STOP PERIOD", "CUMULATIVE PROGRAM PERIOD", "ARRIVALS ESTIMATED FOR", "PROGRAM PERIOD", "EFFECTIVE TIME", "VALID"]) {
    if (fields[k] && (period = parsePeriod(fields[k], now))) break;
  }
  if (!period) period = parsePeriod(s, now);

  let issued = null;
  const sig = /(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):?(\d{2})/.exec(get("SIGNATURE"));
  if (sig) issued = Date.UTC(2000 + Number(sig[1]), Number(sig[2]) - 1, Number(sig[3]), Number(sig[4]), Number(sig[5]));
  if (issued == null && dmy) {
    const adl = /(\d{2})(\d{2})Z?/.exec(get("ADL TIME"));
    if (adl) issued = Date.UTC(Number(dmy[3]), Number(dmy[1]) - 1, Number(dmy[2]), Number(adl[1]), Number(adl[2]));
  }
  if (issued == null && period?.start != null) issued = period.start;

  const id = num && dmy ? `${dmy[3]}-${dmy[1]}-${dmy[2]}#${num.padStart(3, "0")}` : href || name.slice(0, 120);
  if (!id) return null;
  return {
    id, type, cnx: isCnx(name) || isCnx(title), airport, ctl: ctl || null,
    departureScope: (() => {
      const airports = get("DEP AIRPORTS INCLUDED", "DEPARTURE AIRPORTS INCLUDED");
      const text = airports || get("DEP FACILITIES INCLUDED", "FLIGHTS INCLUDED");
      if (!text) return null;
      const tokens = airports.toUpperCase().split(/[\s,]+/).filter(Boolean);
      const list = tokens.length && tokens.every(x => /^K?[A-Z]{3}$/.test(x)) ? tokens.map(x => x.replace(/^K(?=[A-Z]{3}$)/, "")) : null;
      return { text: text.slice(0, 500), airports: /^(ALL|ALL FLIGHTS|ALL AIRPORTS)$/i.test(text.trim()) ? null : list || null, all: /^(ALL|ALL FLIGHTS|ALL AIRPORTS)$/i.test(text.trim()) };
    })(),
    issued: iso(issued), start: iso(period?.start ?? null), end: iso(period?.end ?? null),
    cause: classifyCause(causeText), causeText: causeText || null,
    extension: ({ LOW: "low", MEDIUM: "medium", MODERATE: "medium", HIGH: "high", NONE: "none", NIL: "none" })[/^(LOW|MEDIUM|MODERATE|HIGH|NONE|NIL)\b/i.exec(get("PROBABILITY OF EXTENSION"))?.[1]?.toUpperCase()] || null,
    title: (name || title).replace(/\s+/g, " ").slice(0, 160), active: false,
  };
}

/** Advisory texts printed directly on a page (blocks starting "ATCSCC ADVZY" with field lines). */
export function inlineAdvisories(html, now = new Date()) {
  const text = htmlToText(html);
  const out = [];
  for (const chunk of text.split(/(?=ATCSCC\s+ADVZY)/i)) {
    if (!/^ATCSCC\s+ADVZY/i.test(chunk)) continue;
    if (!/\n\s*(CTL ELEMENT|IMPACTING CONDITION|REASON|EFFECTIVE TIME|GROUND STOP PERIOD)\s*:/i.test(chunk)) continue;
    const a = parseAdvisory(chunk, { now });
    if (a) out.push(a);
  }
  return out;
}

/**
 * Dedupe by id and set `active`: per control element + type, only the latest advisory counts;
 * it is active when it isn't a cancellation, its period has started and its end is after now.
 * An advisory without a parseable end time is never active.
 */
export function finalizeAtcscc(list, now = new Date()) {
  const byId = new Map();
  for (const a of list || []) {
    if (!a || !a.id) continue;
    const prev = byId.get(a.id);
    const score = (x) => Object.values(x).filter((v) => v != null && v !== "").length;
    if (!prev || score(a) > score(prev)) byId.set(a.id, { ...a });
  }
  const all = [...byId.values()];
  const groups = new Map();
  for (const a of all) {
    a.active = false;
    const key = (a.airport || a.ctl || a.id) + "|" + a.type;
    (groups.get(key) || groups.set(key, []).get(key)).push(a);
  }
  for (const g of groups.values()) {
    g.sort((x, y) => (toMs(x.issued) ?? 0) - (toMs(y.issued) ?? 0) || String(x.id).localeCompare(String(y.id)));
    const last = g[g.length - 1];
    const start = toMs(last.start);
    const end = toMs(last.end);
    last.active = !last.cnx && end != null && end > +now && (start == null || start <= +now);
  }
  return all.sort((x, y) => (toMs(y.issued) ?? 0) - (toMs(x.issued) ?? 0));
}

/**
 * Gather advisories: those printed on the list page, plus the program advisories (GS/GDP/AFP)
 * linked from it (or, if no link title names a program, the first `fallback` advisory links).
 * getText(url) -> page text. Returns {list, links, followed, failed, firstError, firstDetail}.
 */
export async function collectAtcscc(html, getText, { base = ATCSCC_URL, now = new Date(), max = 40, fallback = 30, budgetMs = 45e3, concurrency = 4 } = {}) {
  const t0 = Date.now();
  const found = inlineAdvisories(html, now);
  const links = atcsccLinks(html, base);
  const label = (l) => { try { return l.title + " " + decodeURIComponent(l.href); } catch { return l.title + " " + l.href; } };
  let follow = links.filter((l) => PROGRAM_RE.test(label(l)));
  if (!follow.length) follow = links.filter((l) => /ADVZY|advn=/i.test(label(l))).slice(0, fallback);
  follow = follow.slice(0, max);
  let failed = 0;
  let firstError = null;
  let firstDetail = null;
  let next = 0;
  const worker = async () => {
    while (next < follow.length) {
      const l = follow[next++];
      if (Date.now() - t0 > budgetMs) { failed++; firstError ||= "time budget used up"; continue; }
      try {
        const page = await getText(l.href);
        if (firstDetail == null) firstDetail = page;
        const inl = inlineAdvisories(page, now);
        if (inl.length) found.push(...inl);
        else {
          const a = parseAdvisory(htmlToText(page), { title: l.title, href: l.href, now });
          if (a) found.push(a);
        }
      } catch (e) {
        failed++;
        firstError ||= String(e?.message || e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, follow.length) }, worker));
  return { list: finalizeAtcscc(found, now), links: links.length, followed: follow.length, failed, firstError, firstDetail };
}

// ---------- geometry for TCF / CWA ----------

function ringFromCoords(coords) {
  if (!Array.isArray(coords)) return null;
  const ring = [];
  for (const c of coords) {
    let lon, lat;
    if (Array.isArray(c)) {
      const [a, b] = c.map(Number);
      // GeoJSON order is [lon, lat]; accept [lat, lon] when the signs make it obvious (US: lat > 0, lon < 0)
      if (a > 0 && b < 0) [lat, lon] = [a, b];
      else [lon, lat] = [a, b];
    } else if (c && typeof c === "object") {
      lat = Number(c.lat ?? c.latitude);
      lon = Number(c.lon ?? c.lng ?? c.longitude);
    }
    if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lon, lat]);
  }
  return ring.length >= 3 ? ring : null;
}

/**
 * Does a feature / record (GeoJSON geometry, or coords as [{lat,lon}] or [[lon,lat]]) contain the point?
 * Inside, on the edge, or within NEAR_NM (10 NM) of it counts, as for SIGMETs.
 */
export function shapeContains(lon, lat, item) {
  if (!item || typeof item !== "object") return false;
  const g = item.geometry || (item.type && item.coordinates ? item : null);
  if (g) {
    if (g.type === "Polygon" || g.type === "MultiPolygon") return pointNearGeometry(lon, lat, g);
    return false;
  }
  const p = item.properties || item;
  const coords = p.coords || p.coordinates || item.coords;
  if (Array.isArray(coords) && coords.length && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
    const ring = ringFromCoords(coords[0]);
    return !!ring && pointNearRing(lon, lat, ring);
  }
  const ring = ringFromCoords(coords);
  return !!ring && pointNearRing(lon, lat, ring);
}

function features(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return data.features || data.data || data.items || [];
  return [];
}

function pickProp(p, names, re) {
  for (const n of names) if (p[n] != null && p[n] !== "") return p[n];
  if (re) for (const [k, v] of Object.entries(p)) if (re.test(k) && v != null && v !== "") return v;
  return null;
}

function scalars(p, max = 12) {
  const o = {};
  let n = 0;
  for (const [k, v] of Object.entries(p || {})) {
    if (n >= max) break;
    if (v == null || typeof v === "object") continue;
    o[k] = typeof v === "string" ? v.slice(0, 120) : v;
    n++;
  }
  return o;
}

// ---------- AWC TFM Convective Forecast ----------

/** AWC TCF times are "YYYYMMDD_HHMM" (UTC), e.g. "20261004_0100"; ISO strings and epochs also accepted. */
export function awcTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})Z?$/.exec(String(v ?? "").trim());
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return toMs(v);
}

/** high | medium | low | null from a TCF coverage value ("High", "MED", 40, ...). */
export function tcfCoverage(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n <= 3) return [null, "low", "medium", "high"][Math.round(n)] ?? null;
    return n >= 40 ? "high" : n >= 25 ? "medium" : "low";
  }
  const s = String(v).toLowerCase();
  if (/high|dense|solid/.test(s)) return "high";
  if (/med|moderate/.test(s)) return "medium";
  if (/low|sparse|spars/.test(s)) return "low";
  return null;
}

/**
 * TCF areas containing the point, not yet expired: [{valid, coverage, confidence, tops, props}].
 * Live AWC GeoJSON (Oct 2026): properties {validTime: "20261004_0100", issueTime: "20261003_2100",
 * coverage: "sparse", confidence: "high", tops: "390" | ">400", labelpos: [lon, lat], data: "tcf"}.
 */
export function tcfAt(lon, lat, data, now = new Date()) {
  const out = [];
  for (const f of features(data)) {
    try {
      if (!shapeContains(lon, lat, f)) continue;
      const p = f.properties || f;
      const validRaw = pickProp(p, ["validTime", "valid", "validTimeTo", "validTimeFrom", "fcstTime", "time"], /valid/i);
      const validMs = awcTime(validRaw);
      if (validMs != null && validMs < +now - HOUR) continue;
      const covRaw = pickProp(p, ["coverage", "cvg", "cov", "Coverage"], /cov|cvg/i);
      out.push({
        valid: iso(validMs),
        coverage: tcfCoverage(covRaw),
        coverageRaw: covRaw == null ? null : String(covRaw),
        confidence: pickProp(p, ["confidence", "conf", "Confidence"], /conf/i),
        tops: pickProp(p, ["tops", "top", "topsFL", "Tops"], /top/i),
        props: scalars(p),
      });
    } catch { /* skip malformed feature */ }
  }
  return out.sort((a, b) => (toMs(a.valid) ?? 0) - (toMs(b.valid) ?? 0));
}

// ---------- AWC Center Weather Advisories ----------

/** CWAs containing the point and not expired: [{hazard, validFrom, validTo, raw}]. */
export function cwaAt(lon, lat, data, now = new Date()) {
  const out = [];
  for (const item of features(data)) {
    try {
      if (!shapeContains(lon, lat, item)) continue;
      const p = item.properties || item;
      const from = toMs(pickProp(p, ["validTimeFrom", "validFrom", "issueTime"], /valid.*from|from/i));
      const to = toMs(pickProp(p, ["validTimeTo", "validTo", "expires", "expireTime"], /valid.*to$|until|expir/i));
      if (to != null && to < +now) continue;
      out.push({
        hazard: pickProp(p, ["hazard", "hazardType", "qualifier", "phenomenon"], /hazard/i),
        validFrom: iso(from),
        validTo: iso(to),
        raw: String(pickProp(p, ["cwaText", "rawCWA", "rawText", "text", "raw"], /text|raw/i) ?? "").slice(0, 2000),
      });
    } catch { /* skip malformed record */ }
  }
  return out;
}
