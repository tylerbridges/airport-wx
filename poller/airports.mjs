// Live monitoring extends the fixture/training baseline using the maintained airport catalog.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const US = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);
export function monitoredAirports(baseline, catalog) {
  const out = new Map(baseline.map(a => [a.iata, a]));
  const f = Object.fromEntries(catalog.f.map((k, i) => [k, i]));
  for (const r of catalog.a) {
    if (!US.has(r[f.country]) || !r[f.scheduled] || !r[f.hasMetar] || !r[f.iata] || !/^[A-Z]{4}$/.test(r[f.icao])) continue;
    if (out.has(r[f.iata])) continue;
    const tz = catalog.tz[r[f.tz]];
    if (!tz || !Number.isFinite(r[f.lat]) || !Number.isFinite(r[f.lon])) continue;
    out.set(r[f.iata], { iata:r[f.iata], icao:r[f.icao], name:r[f.name], city:r[f.city],
      state:r[f.country] === "US" ? r[f.region].split("-")[1] : r[f.country], lat:r[f.lat], lon:r[f.lon], tz });
  }
  return [...out.values()];
}
export async function loadMonitoredAirports({ fixtures = false } = {}) {
  const baseline = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
  if (fixtures) return baseline;
  const catalog = JSON.parse(await readFile(join(ROOT, "site/data/airports-all.json"), "utf8"));
  return monitoredAirports(baseline, catalog);
}
