// One national alert snapshot; zone geometries are shared and cached between polls.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pointInGeometry, pool } from "./lib.mjs";
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
  const zoneUrls = [...new Set(alerts.filter(x => !x.geometry).flatMap(x => x.properties?.affectedZones || []))];
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
  const footprints = alerts.map(alert => ({alert, geometries:(alert.geometry ? [alert.geometry] : (alert.properties?.affectedZones || []).map(url=>geometries.get(url))).map(footprint)}));
  if (footprints.some(x=>!x.geometries.length)) throw new Error("NWS alert has no geographic coverage");
  return Object.fromEntries(airports.map(a=>[a.iata,{features:footprints.filter(x=>x.geometries.some(g=>a.lon>=g.west && a.lon<=g.east && a.lat>=g.south && a.lat<=g.north && contains(a.lon,a.lat,g.geometry))).map(x=>x.alert)}]));
}
