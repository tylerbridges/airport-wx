// Parsing and geometry helpers for the poller. Pure (no network), unit-tested in lib.test.mjs.
import { fmtClock, tzAbbr, toMs } from "./risk.mjs";
import { describeClosure } from "./notam.mjs";

// ---------- geometry ----------

/** Ray casting. ring: [[lon, lat], ...] */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** rings[0] is the outer ring, the rest are holes. */
export function pointInPolygon(lon, lat, rings) {
  if (!rings || !rings.length || !pointInRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(lon, lat, rings[k])) return false;
  return true;
}

export function pointInGeometry(lon, lat, g) {
  if (!g) return false;
  if (g.type === "Polygon") return pointInPolygon(lon, lat, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((p) => pointInPolygon(lon, lat, p));
  return false;
}

/** Distance in nautical miles from the point to the ring's edge (local flat-earth approximation). */
export function distToRingNm(lon, lat, ring) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const ax = (x1 - lon) * k * 60, ay = (y1 - lat) * 60, bx = (x2 - lon) * k * 60, by = (y2 - lat) * 60;
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Advisory areas (SIGMET, CWA, TCF) count an airport inside, on, or within this distance of the edge. */
export const NEAR_NM = 10;

/** Inside the ring, on it, or within nm of its edge (e.g. an airport that is a vertex of a SIGMET polygon). */
export function pointNearRing(lon, lat, ring, nm = NEAR_NM) {
  return pointInRing(lon, lat, ring) || distToRingNm(lon, lat, ring) <= nm;
}

/** pointInGeometry, widened by nm around every ring edge. */
export function pointNearGeometry(lon, lat, g, nm = NEAR_NM) {
  if (!g) return false;
  if (pointInGeometry(lon, lat, g)) return true;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((rings) => (rings || []).some((r) => Array.isArray(r) && r.length >= 2 && distToRingNm(lon, lat, r) <= nm));
}

const SPC_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };

/** Highest SPC categorical label whose polygon contains the point, or null. */
export function spcCategoryAt(lon, lat, geojson) {
  let best = null;
  for (const f of geojson?.features || []) {
    const label = String(f.properties?.LABEL || "").toUpperCase();
    if (!SPC_RANK[label]) continue;
    if (best && SPC_RANK[best] >= SPC_RANK[label]) continue;
    if (pointInGeometry(lon, lat, f.geometry)) best = label;
  }
  return best;
}

/** Currently valid CONVECTIVE (air)sigmets that contain the point (or pass within NEAR_NM of it). */
export function convectiveSigmetsAt(lon, lat, sigmets, now = new Date()) {
  const out = [];
  for (const s of Array.isArray(sigmets) ? sigmets : []) {
    if (String(s.hazard || "").toUpperCase() !== "CONVECTIVE") continue;
    const from = toMs(s.validTimeFrom);
    const to = toMs(s.validTimeTo);
    if ((from != null && from > +now) || (to != null && to < +now)) continue;
    const ring = (s.coords || []).map((c) => [Number(c.lon), Number(c.lat)]).filter((p) => p.every(Number.isFinite));
    if (ring.length < 3 || !pointNearRing(lon, lat, ring)) continue;
    out.push({ hazard: "CONVECTIVE", raw: s.rawAirSigmet || "", validTo: to != null ? new Date(to).toISOString() : null });
  }
  return out;
}

// ---------- FAA NAS status XML (tolerant, regex based) ----------

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    });
}

/** All <tag ...>body</tag> elements in xml (case-insensitive; self-closing allowed). */
export function elements(xml, tag) {
  const re = new RegExp(`<${tag}(?=[\\s>/])([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || "", body: m[2] || "" });
  return out;
}
export function textOf(xml, tag) {
  const e = elements(xml, tag)[0];
  return e ? decodeXml(e.body).replace(/\s+/g, " ").trim() : "";
}
export function attrOf(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decodeXml(m[2] ?? m[3]) : "";
}

/** "2 hours and 8 minutes" -> "2h 8m"; "52 minutes" -> "52m". */
export function compactDuration(s) {
  if (!s) return "";
  const h = /(\d+)\s*h(?:ou)?rs?/i.exec(s);
  const m = /(\d+)\s*min/i.exec(s);
  const parts = [];
  if (h) parts.push(`${h[1]}h`);
  if (m) parts.push(`${m[1]}m`);
  return parts.length ? parts.join(" ") : String(s).trim();
}

/** Offset (ms) of tz from UTC at instant t. */
function tzOffset(t, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t))) o[p.type] = p.value;
  return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour) % 24, Number(o.minute), Number(o.second)) - Math.floor(t / 1000) * 1000;
}

/**
 * An FAA clock string ("5:30 pm EDT", "2130Z", "Oct 03 at 2130 UTC") as an instant: the next such
 * clock time (at most 12 h in the past) in the airport's zone. null if there is no time.
 */
export function faaTimeMs(raw, tz, now = new Date()) {
  const s = String(raw || "").trim();
  const a = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(s);
  if (a) {
    const hh = (Number(a[1]) % 12) + (a[3].toLowerCase() === "p" ? 12 : 0);
    const off = tzOffset(+now, tz);
    const loc = new Date(+now + off);
    let t = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), hh, Number(a[2])) - off;
    if (t < +now - 12 * 3600e3) t += 24 * 3600e3;
    return t;
  }
  const u = /(\d{2}):?(\d{2})\s*(?:Z|UTC|GMT)\b/i.exec(s);
  if (u) {
    const d = new Date(+now);
    d.setUTCHours(Number(u[1]), Number(u[2]), 0, 0);
    if (+d < +now - 12 * 3600e3) d.setUTCDate(d.getUTCDate() + 1);
    return +d;
  }
  return null;
}

/**
 * Turn an FAA clock string ("5:30 pm EDT", "Oct 03 at 2130 UTC", "2130Z") into "5:30 PM ET"
 * in the airport's own zone where possible; otherwise return it tidied.
 */
export function formatFaaTime(raw, tz, now = new Date()) {
  const s = String(raw || "").trim().replace(/\.$/, "");
  if (!s) return "";
  const a = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*((?:AK|[ECMPH])[SD]?T)?/i.exec(s);
  if (a) {
    const abbr = a[4] ? { E: "ET", C: "CT", M: "MT", P: "PT", H: "HST", A: "AKT" }[a[4][0].toUpperCase()] : null;
    const zone = abbr || tzAbbr(now, tz);
    const min = a[2] === "00" ? "" : ":" + a[2];
    return `${Number(a[1])}${min} ${a[3].toUpperCase()}M ${zone}`;
  }
  const u = /(\d{2}):?(\d{2})\s*(?:Z|UTC|GMT)\b/i.exec(s);
  if (u) {
    const d = new Date(+now);
    d.setUTCHours(Number(u[1]), Number(u[2]), 0, 0);
    if (+d < +now - 12 * 3600e3) d.setUTCDate(d.getUTCDate() + 1);
    return `${fmtClock(d, tz)} ${tzAbbr(d, tz)}`;
  }
  return s;
}

function adSummary(list) {
  const parts = [];
  for (const ad of list) {
    const type = /arr/i.test(ad.type) && /dep/i.test(ad.type) ? "Arrivals/Departures" : /arr/i.test(ad.type) ? "Arrivals" : /dep/i.test(ad.type) ? "Departures" : "Delays";
    const lo = compactDuration(ad.min);
    const hi = compactDuration(ad.max);
    let range = lo && hi && lo !== hi ? (/^\d+m$/.test(lo) && /^\d+m$/.test(hi) ? `${lo.slice(0, -1)}–${hi}` : `${lo}–${hi}`) : hi || lo;
    let s = range ? `${type} ${range}` : type;
    if (ad.trend) s += `, ${ad.trend.toLowerCase()}`;
    parts.push(s);
  }
  return parts.join("; ");
}

/**
 * Parse the FAA airport-status XML.
 * Returns {updated, byAirport: {SFO: [{type, reason, detail, badge}]}}.
 * Types: ground_stop, ground_delay, delay, closure. Closures also carry {scope: full|runway|limited,
 * active, plain (plain-English summary), runways} from notam.mjs; badge is null for limited ones.
 * Program cause classes are added by the caller (classifyCause on reason).
 */
export function parseFaaXml(xml, { now = new Date(), tzFor = () => "America/New_York" } = {}) {
  const byAirport = {};
  const push = (arpt, entry) => {
    if (!arpt) return;
    (byAirport[arpt.toUpperCase()] ||= []).push(entry);
  };
  for (const dt of elements(xml, "Delay_type")) {
    const name = textOf(dt.body, "Name").toLowerCase();
    if (/closure/.test(name)) {
      for (const e of elements(dt.body, "Airport")) {
        const arpt = textOf(e.body, "ARPT");
        const tz = tzFor(arpt);
        const reason = textOf(e.body, "Reason");
        const reopen = formatFaaTime(textOf(e.body, "Reopen"), tz, now);
        // The reason is usually NOTAM text: scope (full / runway / limited) and times come from it.
        const d = describeClosure(reason, { tz, now, reopen });
        push(arpt, {
          type: "closure", reason, detail: d.detail,
          badge: d.scope === "full" ? "CLOSED" : d.scope === "runway" ? "RUNWAY CLOSED" : null,
          scope: d.scope, active: d.active, plain: d.plain, runways: d.runways,
        });
      }
    } else if (/ground stop/.test(name)) {
      for (const e of elements(dt.body, "Program")) {
        const arpt = textOf(e.body, "ARPT");
        const endRaw = textOf(e.body, "End_Time");
        const end = formatFaaTime(endRaw, tzFor(arpt), now);
        const endMs = faaTimeMs(endRaw, tzFor(arpt), now);
        push(arpt, { type: "ground_stop", reason: textOf(e.body, "Reason"), detail: end ? `until ${end}` : "", badge: "GROUND STOP", end: endMs != null ? new Date(endMs).toISOString() : null });
      }
    } else if (/ground delay/.test(name)) {
      for (const e of elements(dt.body, "Ground_Delay")) {
        const arpt = textOf(e.body, "ARPT");
        const avg = compactDuration(textOf(e.body, "Avg"));
        const max = compactDuration(textOf(e.body, "Max"));
        const detail = [avg && `avg ${avg}`, max && `max ${max}`].filter(Boolean).join(", ");
        push(arpt, { type: "ground_delay", reason: textOf(e.body, "Reason"), detail, badge: avg ? `GDP avg ${avg.replace(/ /g, "")}` : "GDP" });
      }
    } else if (/arrival|departure|delay/.test(name)) {
      for (const e of elements(dt.body, "Delay")) {
        const arpt = textOf(e.body, "ARPT");
        const list = elements(e.body, "Arrival_Departure").map((x) => ({
          type: attrOf(x.attrs, "Type"),
          min: textOf(x.body, "Min"),
          max: textOf(x.body, "Max"),
          trend: textOf(x.body, "Trend"),
        }));
        const trend = list.some((x) => /increas/i.test(x.trend)) ? "increasing" : list.some((x) => /decreas/i.test(x.trend)) ? "decreasing" : list.some((x) => x.trend) ? "steady" : null;
        push(arpt, { type: "delay", reason: textOf(e.body, "Reason"), detail: adSummary(list), badge: "DELAYS", trend });
      }
    }
  }
  return { updated: textOf(xml, "Update_Time"), byAirport };
}

// ---------- NWS alerts ----------

export function normalizeAlerts(fc, now = new Date()) {
  const seen = new Set();
  const out = [];
  for (const f of fc?.features || []) {
    const p = f.properties || {};
    if (!p.event || /^cancel$/i.test(p.messageType || "")) continue;
    const ends = p.ends || p.expires || null;
    const endMs = toMs(ends);
    if (endMs != null && endMs < +now) continue;
    const key = p.event + "|" + (p.headline || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ event: p.event, severity: p.severity || null, headline: p.headline || null, ends, onset: p.onset || p.effective || null });
  }
  return out;
}

// ---------- fixture templates ----------

/**
 * Fixture files are templates. Tokens, relative to "now":
 *   {{+90}}       epoch seconds, 90 minutes from now      ({{-12}} for the past)
 *   {{h+3}}       epoch seconds, top of the current hour + 3 hours
 *   {{iso+90}}    ISO-8601 string (no quotes added), 90 minutes from now
 *   {{clock+90 America/Chicago}}   "5:30 pm CDT" style clock text in that zone
 *   {{z-12}}      METAR/TAF style DDHHMM (UTC), minutes from now
 *   {{dh+3}}      TAF style DDHH (UTC), top of the current hour + 3 hours
 *   {{mdy+0}}     MM/DD/YYYY (UTC), minutes from now
 *   {{sig-20}}    ATCSCC signature time YY/MM/DD HH:MM (UTC), minutes from now
 *   {{lc+0}}      LAMP header "MM/DD/YYYY  HH30" of the newest HH:30 cycle at or before now, + hours
 *   {{lu+0}}      that cycle's LAMP UTC row: 25 hour columns, 3 characters each, from the next hour
 *   {{ds-18}}     DD/HHMM (UTC), minutes from now (ops plan EVENT TIME)
 *   {{tcf+3}}     YYYYMMDD_HH00 (UTC), top of the hour + hours (AWC TCF validTime/issueTime)
 */
export function expandTemplate(text, now = new Date()) {
  const HOUR = 3600e3;
  const p2 = (x) => String(x).padStart(2, "0");
  const cycle = (k) => {
    let t = Math.floor(+now / HOUR) * HOUR + 30 * 60e3;
    if (t > +now) t -= HOUR;
    return new Date(t + k * HOUR);
  };
  return text.replace(/\{\{(dh|ds|h|iso|clock|z|mdy|sig|lc|lu|tcf)?([+-]\d+)(?:\s+([A-Za-z_/]+))?\}\}/g, (_, kind, n, tz) => {
    const k = Number(n);
    // ds: "DD/HHMM" (now + k min, ops plan EVENT TIME); tcf: "YYYYMMDD_HHMM" (top of the hour + k h, AWC TCF)
    if (kind === "ds") { const d = new Date(+now + k * 60e3); return `${p2(d.getUTCDate())}/${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`; }
    if (kind === "tcf") {
      const d = new Date(Math.floor(+now / HOUR) * HOUR + k * HOUR);
      return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_${p2(d.getUTCHours())}00`;
    }
    if (kind === "dh") { const d = new Date(Math.floor(+now / HOUR) * HOUR + k * HOUR); return p2(d.getUTCDate()) + p2(d.getUTCHours()); }
    if (kind === "z") { const d = new Date(+now + k * 60e3); return p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes()); }
    if (kind === "h") return String(Math.floor((Math.floor(+now / HOUR) * HOUR + k * HOUR) / 1000));
    if (kind === "mdy") { const d = new Date(+now + k * 60e3); return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`; }
    if (kind === "sig") {
      const d = new Date(+now + k * 60e3);
      return `${p2(d.getUTCFullYear() % 100)}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    }
    if (kind === "lc") { const d = cycle(k); return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}  ${p2(d.getUTCHours())}30`; }
    if (kind === "lu") {
      const d = cycle(k);
      return Array.from({ length: 25 }, (_, i) => p2((d.getUTCHours() + 1 + i) % 24).padStart(3, " ")).join("");
    }
    const t = +now + k * 60e3;
    if (kind === "iso") return new Date(t).toISOString();
    if (kind === "clock") {
      const s = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })
        .format(new Date(t))
        .replace(/[  ]/g, " ");
      return s.replace(/ (AM|PM)/, (m, ap) => " " + ap.toLowerCase());
    }
    return String(Math.floor(t / 1000));
  });
}

// ---------- misc ----------

export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Latest record per icaoId by a numeric time field. */
export function latestBy(list, idKey, timeKey) {
  const m = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    const id = r?.[idKey];
    if (!id) continue;
    const t = toMs(r[timeKey]) ?? 0;
    const prev = m.get(id);
    if (!prev || t >= (toMs(prev[timeKey]) ?? 0)) m.set(id, r);
  }
  return m;
}
