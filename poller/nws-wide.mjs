// One national alert snapshot; zone geometries are shared and cached between polls.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pointInGeometry, pool } from "./lib.mjs";
// State FIPS codes: https://www2.census.gov/geo/docs/reference/state.txt
const SAME_STATES = Object.fromEntries("01:AL 02:AK 04:AZ 05:AR 06:CA 08:CO 09:CT 10:DE 11:DC 12:FL 13:GA 15:HI 16:ID 17:IL 18:IN 19:IA 20:KS 21:KY 22:LA 23:ME 24:MD 25:MA 26:MI 27:MN 28:MS 29:MO 30:MT 31:NE 32:NV 33:NH 34:NJ 35:NM 36:NY 37:NC 38:ND 39:OH 40:OK 41:OR 42:PA 44:RI 45:SC 46:SD 47:TN 48:TX 49:UT 50:VT 51:VA 53:WA 54:WV 55:WI 56:WY 60:AS 66:GU 69:MP 72:PR 74:UM 78:VI".split(" ").map(x => x.split(":")));
// SAME is PSSCCC; resolve only whole counties (P=0), never widen a partial-county alert.
// https://www.weather.gov/nwr/sameenz
function alertZones(alert) {
  const p = alert.properties || {};
  if (p.affectedZones?.length) return p.affectedZones;
  const same = p.geocode?.SAME;
  if (!Array.isArray(same) || !same.length) return [];
  const zones = same.map(code => {
    if (typeof code !== "string" || !/^0\d{5}$/.test(code) || code.slice(3) === "000") return null;
    const state = SAME_STATES[code.slice(1, 3)];
    return state ? `https://api.weather.gov/zones/county/${state}C${code.slice(3)}` : null;
  });
  // A partly unresolved alert must still fail coverage, rather than silently dropping a location.
  return zones.every(Boolean) ? zones : [];
}
function validGeometry(g) {
  if (g?.type === "GeometryCollection") return Array.isArray(g.geometries) && g.geometries.length > 0 && g.geometries.every(validGeometry);
  const polygons = g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : null;
  return Array.isArray(polygons) && polygons.length > 0 && polygons.every(p => Array.isArray(p) && p.length > 0 && p.every(r => Array.isArray(r) && r.length >= 4 && r.every(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)));
}
function contains(lon,lat,g) {
  return g.type === "GeometryCollection" ? g.geometries.some(x=>contains(lon,lat,x)) : pointInGeometry(lon,lat,g);
}
function footprint(g) {
  const points = g.type === "GeometryCollection" ? g.geometries.flatMap(x=>footprint(x).points)
    : g.type === "Polygon" ? g.coordinates.flat() : g.coordinates.flat(2);
  let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
  for (const [lon,lat] of points) {west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);}
  return {points, west,east,south,north,geometry:g};
}
export async function mapNationalAlerts({ airports, snapshot, getZone, cacheDir = ".cache/nws-zones" }) {
  if (!Array.isArray(snapshot?.features)) throw new Error("NWS active alerts response has no features");
  if (snapshot.pagination?.next) throw new Error("NWS active alerts response is incomplete (pagination)");
  const alerts = snapshot.features;
  if (alerts.some(x => x.geometry && !validGeometry(x.geometry))) throw new Error("NWS alert geometry is invalid");
  const zonesByAlert = new Map(alerts.filter(x => !x.geometry).map(x => [x, alertZones(x)]));
  const zoneUrls = [...new Set([...zonesByAlert.values()].flat())];
  const geometries = new Map();
  await mkdir(cacheDir, { recursive:true });
  await pool(zoneUrls, 4, async url => {
    if (!/^https:\/\/api\.weather\.gov\/zones\/(forecast|county|fire)\/[A-Z]{2}[CZ]\d{3}$/.test(url)) throw new Error("Unsupported NWS alert zone URL");
    const key = url.split("/").slice(-2).join("-") + ".json", path = join(cacheDir,key);
    let geometry;
    try { const cached = JSON.parse(await readFile(path,"utf8")); const age = Date.now() - cached.at; if (Number.isFinite(age) && age >= 0 && age < 30*86400000 && validGeometry(cached.geometry)) geometry = cached.geometry; } catch {}
    if (!geometry) {
      const zone = await getZone(url);
      geometry = zone?.geometry;
      if (!validGeometry(geometry)) throw new Error("NWS alert zone geometry unavailable");
      await writeFile(path, JSON.stringify({at:Date.now(),geometry}));
    }
    geometries.set(url,geometry);
  });
  const footprints = alerts.map(alert => ({alert, geometries:(alert.geometry ? [alert.geometry] : (zonesByAlert.get(alert) || []).map(url=>geometries.get(url))).map(footprint)}));
  if (footprints.some(x=>!x.geometries.length)) throw new Error("NWS alert has no geographic coverage");
  return Object.fromEntries(airports.map(a=>[a.iata,{features:footprints.filter(x=>x.geometries.some(g=>a.lon>=g.west && a.lon<=g.east && a.lat>=g.south && a.lat<=g.north && contains(a.lon,a.lat,g.geometry))).map(x=>x.alert)}]));
}
