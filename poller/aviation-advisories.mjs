// Additional operational SIGMETs. Informational: aircraft altitude/route is unknown,
// so these never alter airport risk levels or calibrated delay probabilities.
import { pointNearRing } from "./lib.mjs";
import { toMs } from "./risk.mjs";

const HOUR = 3600e3;
const TITLES = { TURB: "Severe turbulence", ICE: "Severe icing", VA: "Volcanic ash" };
const feet = (x) => x == null || x === "" || !Number.isFinite(Number(x)) || Number(x) < 0 ? null : Number(x);
export function altitudeWords(base, top) {
  const f = (n) => Math.round(n).toLocaleString("en-US");
  if (base === 0 && top != null) return `surface to ${f(top)} ft`;
  if (base != null && top != null) return `${f(base)}–${f(top)} ft`;
  if (base != null) return `above ${f(base)} ft`;
  if (top != null) return `up to ${f(top)} ft`;
  return "altitude not specified";
}

export function sigmetAdvisoriesAt(lon, lat, records, now = new Date(), source = "isigmet") {
  const out = new Map();
  for (const s of Array.isArray(records) ? records : []) {
    if (!s || typeof s !== "object") continue;
    const hazard = String(s.hazard || "").toUpperCase();
    if (!TITLES[hazard]) continue;
    const raw = String(s.rawSigmet || s.rawAirSigmet || "");
    if (hazard !== "VA" && !/\b(SEV|SEVERE)\b/.test(String(s.qualifier || "").toUpperCase() + " " + raw.toUpperCase())) continue;
    const from = toMs(s.validTimeFrom), to = toMs(s.validTimeTo);
    if (from == null || to == null || from >= to || to <= +now || from >= +now + 24 * HOUR) continue;
    // These endpoints describe AREA polygons. Unsupported lines/circles remain uninterpreted.
    if (s.geom && s.geom !== "AREA" || s.geometryType && s.geometryType !== "AREA") continue;
    const coords = Array.isArray(s.coords) ? s.coords : [];
    if (coords.length < 3 || coords.some((c) => c.lat == null || c.lon == null || !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lon)) || Math.abs(Number(c.lat)) > 90 || Math.abs(Number(c.lon)) > 180)) continue;
    // Unwrap around the date line before matching: an Aleutian advisory must not
    // turn into a polygon covering most of the world.
    const ring = [];
    for (const c of coords) {
      const previous = ring.at(-1)?.[0] ?? Number(c.lon);
      ring.push([Number(c.lon) + 360 * Math.round((previous - Number(c.lon)) / 360), Number(c.lat)]);
    }
    if (new Set(ring.map((p) => p.join(","))).size < 3) continue;
    const area = ring.reduce((n, p, i) => { const q = ring[(i + 1) % ring.length]; return n + p[0] * q[1] - q[0] * p[1]; }, 0);
    if (Math.abs(area) < 1e-8) continue;
    const center = ring.reduce((n, p) => n + p[0], 0) / ring.length;
    const nearLon = lon + 360 * Math.round((center - lon) / 360);
    if (!pointNearRing(nearLon, lat, ring)) continue;
    const baseFt = feet(s.base ?? s.altitudeLow1), topFt = feet(s.top ?? s.altitudeHi1);
    if (baseFt != null && topFt != null && baseFt > topFt) continue;
    const id = [s.icaoId, s.firId, s.seriesId, s.alphaChar, hazard, from, to, baseFt, topFt, JSON.stringify(coords)].join("|");
    out.set(id, { id, source, hazard, cat: hazard === "TURB" ? "wind" : hazard === "ICE" ? "winter" : "always",
      title: TITLES[hazard], text: `${TITLES[hazard]} advisory nearby · ${altitudeWords(baseFt, topFt)}`,
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), baseFt, topFt, raw });
  }
  return [...out.values()].sort((a, b) => (a.hazard === "VA" ? 0 : 1) - (b.hazard === "VA" ? 0 : 1) || a.from.localeCompare(b.from)).slice(0, 20);
}
