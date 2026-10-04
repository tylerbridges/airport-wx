// FAA Temporary Flight Restrictions (README "Notices"): the tfr.faa.gov list, each TFR's XML detail
// (areas, times, text) and which TFRs touch an airport. Pure (no network, no node: imports); unit-tested
// in tfr.test.mjs. Fetching is in poller/notices-poll.mjs.
//
// Sources (the sandbox couldn't reach tfr.faa.gov; written from node-red-contrib-tfr2cot 2.0.0, which reads
// the live site, and the older @faa-aviation-data-portal/tfrs; check raw/latest/tfr-*.{json,xml} on the
// history branch):
//   list    GET https://tfr.faa.gov/tfrapi/exportTfrList -> [{notam_id: "4/1234", state, type?, facility?,
//           description?, ...}] (notam_id and state confirmed; the rest unverified, read tolerantly)
//   detail  GET https://tfr.faa.gov/download/detail_4_1234.xml -> XNOTAM-Update > Group > Add > Not:
//           NotUid {txtLocalName}, dateEffective, dateExpire, txtDescrTraditional, TfrNot {codeType?,
//           TFRAreaGroup[] {aseTFRArea {txtName, ScheduleGroup {dateEffective, dateExpire}}, abdMergedArea {Avx[]
//           {geoLat "38.85N", geoLong "077.04W"}}, aseShapes {Abd {Avx[] (circles: geoLatArc, geoLongArc,
//           valRadiusArc, uomRadiusArc)}}}}. Times without a zone are UTC (NOTAM convention; unverified).
import { pointInRing, distToRingNm } from "./lib.mjs";
import { decodeXml, elements, textOf } from "./lib.mjs";

/** VIP | SECURITY | SPACE | HAZARDS | STADIUM | AIRSHOW | SPECIAL from a TFR's type text, CFR section or NOTAM text. */
export function tfrType(...texts) {
  const s = texts.filter(Boolean).join(" ").toUpperCase();
  if (/\bVIP\b|91\.141\b|PRESIDENTIAL|VICE PRESIDENT|POTUS/.test(s)) return "VIP";
  if (/SPACE\s*(OPS|OPERATIONS|FLIGHT)|91\.143\b|\bLAUNCH\b|REENTRY|RE-ENTRY/.test(s)) return "SPACE";
  if (/STADIUM|SPORTING EVENT|\bSPORTS?\b/.test(s)) return "STADIUM";
  if (/AIR\s*SHOW|AERIAL DEMONSTRATION|91\.145\b/.test(s)) return "AIRSHOW";
  if (/SECURITY|99\.7\b|NATIONAL DEFENSE/.test(s)) return "SECURITY";
  if (/HAZARD|91\.137\b|FIRE|DISASTER|FLOOD|VOLCAN/.test(s)) return "HAZARDS";
  if (/SPECIAL|91\.144\b|EMERGENCY/.test(s)) return "SPECIAL";
  return "SPECIAL";
}

/** Export list (JSON) -> [{id: "4/1234", type, state, facility, description}]. */
export function parseTfrList(json) {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.tfrs) ? json.tfrs : [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const id = String(x.notam_id ?? x.notamId ?? x.notam ?? x.NOTAM_ID ?? "").trim();
    if (!/^\d+\/\d+$/.test(id)) continue;
    const typeText = x.type ?? x.tfr_type ?? x.legal ?? x.TYPE ?? "";
    out.push({ id, typeText: String(typeText || ""), type: tfrType(typeText, x.description), state: String(x.state ?? x.STATE ?? "").trim().toUpperCase() || null, facility: x.facility ?? null, description: String(x.description ?? "").slice(0, 200) || null, modified: x.mod_date ?? x.modDate ?? x.creation_date ?? null });
  }
  return out;
}

/** "4/1234" -> "https://tfr.faa.gov/download/detail_4_1234.xml". */
export const tfrDetailUrl = (id) => `https://tfr.faa.gov/download/detail_${String(id).replace(/\//g, "_")}.xml`;

/** "38.85N" / "077.0425W" / "-77.04" -> signed degrees. */
export function geoDeg(v) {
  const s = String(v ?? "").trim().toUpperCase();
  const m = /^(-?\d+(?:\.\d+)?)([NSEW])?$/.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === "S" || m[2] === "W") n = -Math.abs(n);
  return Number.isFinite(n) ? n : null;
}

/** TFR XML time ("2026-10-06T18:00:00", ISO with Z, "202610061800") -> ms (UTC when no zone). */
export function tfrTime(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?)$/.exec(s);
  const t = Date.parse(m ? m[1] + "Z" : s);
  return Number.isFinite(t) ? t : null;
}

function ringOf(body) {
  const ring = [];
  for (const v of elements(body, "Avx")) {
    const lat = geoDeg(textOf(v.body, "geoLat"));
    const lon = geoDeg(textOf(v.body, "geoLong"));
    if (lat != null && lon != null) ring.push([lon, lat]);
  }
  return ring.length >= 3 ? ring : null;
}
function circlesOf(body) {
  const out = [];
  for (const v of elements(body, "Avx")) {
    const lat = geoDeg(textOf(v.body, "geoLatArc"));
    const lon = geoDeg(textOf(v.body, "geoLongArc"));
    let r = Number(textOf(v.body, "valRadiusArc"));
    const uom = textOf(v.body, "uomRadiusArc").toUpperCase();
    if (lat == null || lon == null || !(r > 0)) continue;
    if (uom === "KM") r /= 1.852;
    else if (uom === "M") r /= 1852;
    else if (uom === "SM" || uom === "MI") r *= 0.869;
    out.push({ lat, lon, nm: r });
  }
  return out;
}

/**
 * One TFR detail XML -> {id, type, text, from, to, areas: [{name, from, to, ring?, circles?}]} or null.
 * from/to: the TFR's overall effective time (ms, null = open); each area keeps its own schedule.
 */
export function parseTfrDetail(xml, { typeText = "" } = {}) {
  const s = String(xml ?? "");
  const not = elements(s, "Not")[0];
  if (!not) return null;
  const nb = not.body;
  const id = textOf(elements(nb, "NotUid")[0]?.body || "", "txtLocalName") || null;
  const text = decodeXml(textOf(nb, "txtDescrTraditional") || textOf(nb, "txtDescrUSNS") || "").replace(/\s+/g, " ").trim();
  const tfrNot = elements(nb, "TfrNot")[0]?.body || "";
  const code = textOf(tfrNot, "codeType") || textOf(nb, "codeType");
  // the Not element's own dates (area schedules are inside TfrNot)
  const head = nb.replace(/<TfrNot\b[\s\S]*<\/TfrNot\s*>/, "");
  const from = tfrTime(textOf(head, "dateEffective"));
  const to = tfrTime(textOf(head, "dateExpire"));
  const areas = [];
  for (const g of elements(tfrNot, "TFRAreaGroup")) {
    const area = elements(g.body, "aseTFRArea")[0]?.body || "";
    const sch = elements(area, "ScheduleGroup")[0]?.body || "";
    const merged = elements(g.body, "abdMergedArea")[0]?.body || "";
    const shapes = elements(g.body, "aseShapes")[0]?.body || "";
    const ring = ringOf(merged) || ringOf(shapes);
    const circles = ring ? [] : circlesOf(shapes);
    if (!ring && !circles.length) continue;
    areas.push({ name: textOf(area, "txtName") || null, from: tfrTime(textOf(sch, "dateEffective")) ?? from, to: tfrTime(textOf(sch, "dateExpire")) ?? to, ...(ring ? { ring } : {}), ...(circles.length ? { circles } : {}) });
  }
  if (!areas.length) return null;
  return { id, type: tfrType(code, typeText, text), typeText: code || typeText || null, text: text.slice(0, 1500), from, to, areas };
}

/** Distance (nm) from a point to an area: 0 inside, else to the edge. */
export function areaDistNm(lon, lat, area) {
  let best = Infinity;
  if (area.ring) best = pointInRing(lon, lat, area.ring) ? 0 : distToRingNm(lon, lat, area.ring);
  for (const c of area.circles || []) {
    const k = Math.cos((lat * Math.PI) / 180);
    const d = Math.hypot((c.lon - lon) * k * 60, (c.lat - lat) * 60);
    best = Math.min(best, Math.max(0, d - c.nm));
  }
  return best;
}

/** Areas of a TFR within nm of the point: {nm (closest), windows: [[from, to]]} or null. */
export function tfrNear(lon, lat, tfr, nm = 30) {
  let best = Infinity;
  const windows = [];
  for (const a of tfr.areas || []) {
    const d = areaDistNm(lon, lat, a);
    if (d > nm) continue;
    best = Math.min(best, d);
    windows.push([a.from ?? tfr.from ?? null, a.to ?? tfr.to ?? null]);
  }
  if (!windows.length) return null;
  windows.sort((x, y) => (x[0] ?? -Infinity) - (y[0] ?? -Infinity));
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && (last[1] == null || (w[0] ?? -Infinity) <= last[1])) last[1] = last[1] == null || w[1] == null ? null : Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return { nm: Math.round(best), windows: merged };
}

export const TFR_CAT = { VIP: "vip", SPACE: "space", SECURITY: "vip", STADIUM: "vip", AIRSHOW: "vip", HAZARDS: "vip", SPECIAL: "vip" };
export const TFR_CAUSE = { VIP: "vip", SPACE: "space", SECURITY: "security", STADIUM: "security", AIRSHOW: "security", HAZARDS: "other", SPECIAL: "other" };
