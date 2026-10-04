#!/usr/bin/env node
// Builds the searchable airport list: site/data/airports-all.json (+ airports-extra.json).
//   node tools/build-airports.mjs              live: OurAirports CSVs + AWC station list
//   node tools/build-airports.mjs --fixtures   tools/fixtures/ourairports-*.csv + awc-stations.json
//   --out-dir <dir>                            default site/data
//
// Selection: every airport worldwide with scheduled airline service (OurAirports
// scheduled_service = "yes"), plus every US airport (incl. territories) of type
// small/medium/large_airport with an ICAO or GPS code. Heliports, seaplane bases, balloonports
// and closed airports are excluded. hasMetar/hasTaf come from AWC's worldwide station list.
//
// File format (no whitespace, short keys):
//   {v:1, generated, source, tz:[zone names], f:[field names], extra:bool, a:[rows]}
//   row = [iata, icao, name, city, country, region, lat, lon, tzIndex|-1, scheduled 0/1,
//          hasMetar 0/1, hasTaf 0/1, type "L"|"M"|"S", runways [[ids, headingTrue|null], ...]]
// If everything fits in ~1.5 MB it all goes in airports-all.json (extra:false). Otherwise
// airports-all.json is the core (scheduled + every US airport with a METAR) and the rest goes to
// airports-extra.json, which search loads only when the core has no match.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "./backtest-lib.mjs";
import { tzFor } from "./airport-tz.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
export const URLS = {
  airports: "https://davidmegginson.github.io/ourairports-data/airports.csv",
  runways: "https://davidmegginson.github.io/ourairports-data/runways.csv",
  stations: "https://aviationweather.gov/data/cache/stations.cache.json.gz",
};
export const US_AREAS = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);
export const FIELDS = ["iata", "icao", "name", "city", "country", "region", "lat", "lon", "tz", "scheduled", "hasMetar", "hasTaf", "type", "runways"];
export const SPLIT_BYTES = 1.5e6;
const TYPES = { large_airport: "L", medium_airport: "M", small_airport: "S" };

// ---------- CSV ----------

/** CSV text -> array of objects keyed by the header row. */
export function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((h) => h.trim());
  return { header, rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

// ---------- AWC station list (field names unverified: detected and logged) ----------

const ID_KEYS = ["icaoId", "id", "station_id", "stationId", "icao", "ident"];

/** Finds the station id key and how METAR/TAF capability is marked. Returns {idKey, mode, key, notes}. */
export function detectStationFields(list) {
  // Scan the whole list: the AWC cache starts with buoys/ships whose ids and siteType are empty.
  const sample = list;
  const keys = new Set(sample.flatMap((s) => Object.keys(s || {})));
  const idKey = ID_KEYS.find((k) => keys.has(k) && sample.some((s) => /^[A-Z0-9]{3,4}$/.test(String(s[k] || "")))) || null;
  // 1) an array/string field listing site types ("siteType": ["METAR", "TAF"] in the AWC API docs)
  for (const k of [...keys].sort((a, b) => Number(b === "siteType") - Number(a === "siteType"))) {
    if (/^(iata|icao|faa|wmo)?id$|station|ident|name|site$/i.test(k)) continue;
    const vals = sample.map((s) => s[k]).filter((v) => v != null);
    if (vals.some((v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,;|]+/) : []).some((x) => /^TAF$/i.test(x)))) {
      return { idKey, mode: "list", key: k, notes: `TAF marked in list field "${k}"` };
    }
  }
  // 2) a boolean-ish field whose name mentions TAF
  const tafKey = [...keys].find((k) => /taf/i.test(k));
  if (tafKey) return { idKey, mode: "flag", key: tafKey, metarKey: [...keys].find((k) => /metar/i.test(k)) || null, notes: `TAF flag field "${tafKey}"` };
  return { idKey, mode: "none", key: null, notes: "no TAF marker found: hasTaf left 0 for all" };
}

const truthy = (v) => v === true || v === 1 || /^(1|y|yes|true|t)$/i.test(String(v ?? ""));
function listHas(v, token) {
  const arr = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,;|]+/) : [];
  return arr.some((x) => x.toUpperCase() === token);
}

/** -> Map(icao -> {metar, taf}) */
export function stationIndex(list, det = detectStationFields(list)) {
  const m = new Map();
  for (const s of list) {
    const id = String(s?.[det.idKey] ?? "").toUpperCase();
    if (!id) continue;
    let metar = true;
    let taf = false;
    if (det.mode === "list") {
      metar = listHas(s[det.key], "METAR");
      taf = listHas(s[det.key], "TAF");
    } else if (det.mode === "flag") {
      taf = truthy(s[det.key]);
      metar = det.metarKey ? truthy(s[det.metarKey]) : true;
    }
    m.set(id, { metar, taf });
  }
  return m;
}

export function parseStations(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : Array.isArray(j?.features) ? j.features.map((f) => ({ ...(f.properties || {}) })) : Array.isArray(j?.data) ? j.data : [];
  return list;
}

// ---------- selection ----------

const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

/** Runways by airport ident: [[ "12L/30R", 118 ], ...] (true heading of the low end, null if unknown). */
export function runwayIndex(rows) {
  const by = new Map();
  for (const r of rows) {
    if (truthy(r.closed)) continue;
    const le = String(r.le_ident || "").trim();
    const he = String(r.he_ident || "").trim();
    if (!le || /^H\d*$/i.test(le) || /^H\d*$/i.test(he)) continue; // helipads
    const ids = he ? `${le}/${he}` : le;
    const hdg = r.le_heading_degT === "" || r.le_heading_degT == null || !Number.isFinite(Number(r.le_heading_degT)) ? null : Math.round(Number(r.le_heading_degT));
    const k = r.airport_ident;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push([ids, hdg]);
  }
  return by;
}

/**
 * OurAirports rows + station index -> {rows, core, extra, tzList}. Rows are FIELDS-ordered arrays.
 */
export function selectAirports(airports, stations, runways) {
  const tzList = [];
  const tzIdx = new Map();
  const tzi = (z) => {
    if (!z) return -1;
    if (!tzIdx.has(z)) { tzIdx.set(z, tzList.length); tzList.push(z); }
    return tzIdx.get(z);
  };
  const core = [];
  const extra = [];
  for (const a of airports) {
    const type = TYPES[a.type];
    if (!type) continue; // heliport, seaplane_base, balloonport, closed
    const country = String(a.iso_country || "").toUpperCase();
    const scheduled = a.scheduled_service === "yes";
    const code = String(a.icao_code || a.gps_code || "").trim().toUpperCase();
    const us = US_AREAS.has(country);
    if (!scheduled && !(us && code)) continue;
    const icao = code || (/^[A-Z]{4}$/.test(a.ident) ? a.ident : "");
    const st = stations.get(icao) || stations.get(String(a.ident || "").toUpperCase()) || null;
    const lat = Number(a.latitude_deg);
    const lon = Number(a.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const row = [
      String(a.iata_code || "").trim().toUpperCase(), icao, String(a.name || "").trim(), String(a.municipality || "").trim(),
      country, String(a.iso_region || "").trim(), r3(lat), r3(lon), tzi(tzFor(country, a.iso_region, lat, lon)),
      scheduled ? 1 : 0, st?.metar ? 1 : 0, st?.taf ? 1 : 0, type, runways.get(a.ident) || [],
    ];
    (scheduled || (us && st?.metar) ? core : extra).push(row);
  }
  const order = (x, y) => (x[0] || x[1]).localeCompare(y[0] || y[1]);
  core.sort(order);
  extra.sort(order);
  return { core, extra, tzList };
}

export function fileJson({ rows, tzList, generated, source, extra }) {
  return JSON.stringify({ v: 1, generated, source, tz: tzList, f: FIELDS, extra, a: rows });
}

/** Writes text unless the file already has the same content apart from "generated" (so the weekly job only commits real changes). */
async function writeIfChanged(path, text) {
  const strip = (s) => s.replace(/"generated":"[^"]*"/, "");
  try {
    if (strip(await readFile(path, "utf8")).trim() === strip(text).trim()) return false;
  } catch { /* new file */ }
  await writeFile(path, text + "\n");
  return true;
}

// ---------- I/O ----------

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return url.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

export async function build({ fixtures = false, outDir = join(ROOT, "site/data"), log = console.log } = {}) {
  const fx = join(HERE, "fixtures");
  const [aText, rText, sText] = fixtures
    ? await Promise.all(["ourairports-airports.csv", "ourairports-runways.csv", "awc-stations.json"].map((f) => readFile(join(fx, f), "utf8")))
    : await Promise.all([get(URLS.airports), get(URLS.runways), get(URLS.stations)]);

  const ap = csvObjects(aText);
  const rw = csvObjects(rText);
  for (const need of ["ident", "type", "name", "latitude_deg", "longitude_deg", "iso_country", "iso_region", "municipality", "scheduled_service", "iata_code", "gps_code"]) {
    if (!ap.header.includes(need)) throw new Error(`airports.csv: column "${need}" missing (header: ${ap.header.join(",")})`);
  }
  log(`airports.csv: ${ap.rows.length} rows; header: ${ap.header.join(",")}`);
  log(`airports.csv icao column: ${ap.header.includes("icao_code") ? "icao_code (preferred) then gps_code" : "gps_code only (no icao_code column)"}`);
  log(`runways.csv: ${rw.rows.length} rows; header: ${rw.header.join(",")}`);

  const stList = parseStations(sText);
  const det = detectStationFields(stList);
  log(`stations: ${stList.length} records; id key: ${det.idKey}; ${det.notes}`);
  log(`stations sample: ${JSON.stringify(stList[0])}`);
  if (!det.idKey) throw new Error("stations: no station id field found");
  const stations = stationIndex(stList, det);
  const nTaf = [...stations.values()].filter((s) => s.taf).length;
  const nMetar = [...stations.values()].filter((s) => s.metar).length;
  log(`stations: ${nMetar} with METAR, ${nTaf} with TAF`);
  if (!fixtures && nTaf === 0) log("WARNING: no station marked as a TAF site; check the field names above");

  const { core, extra, tzList } = selectAirports(ap.rows, stations, runwayIndex(rw.rows));
  const generated = new Date().toISOString();
  const source = fixtures ? "fixtures" : "live";
  const all = fileJson({ rows: [...core, ...extra].sort((x, y) => (x[0] || x[1]).localeCompare(y[0] || y[1])), tzList, generated, source, extra: false });
  await mkdir(outDir, { recursive: true });
  const extraPath = join(outDir, "airports-extra.json");
  if (Buffer.byteLength(all) <= SPLIT_BYTES) {
    const ch = await writeIfChanged(join(outDir, "airports-all.json"), all);
    await rm(extraPath, { force: true });
    log(`${ch ? "wrote" : "unchanged:"} airports-all.json: ${core.length + extra.length} airports, ${(Buffer.byteLength(all) / 1024).toFixed(0)} KB (no split)`);
  } else {
    const c = fileJson({ rows: core, tzList, generated, source, extra: true });
    const e = fileJson({ rows: extra, tzList, generated, source, extra: false });
    const ch = (await writeIfChanged(join(outDir, "airports-all.json"), c)) | (await writeIfChanged(extraPath, e));
    log(`${ch ? "wrote" : "unchanged:"} airports-all.json (core): ${core.length} airports, ${(Buffer.byteLength(c) / 1024).toFixed(0)} KB`);
    log(`wrote airports-extra.json: ${extra.length} airports, ${(Buffer.byteLength(e) / 1024).toFixed(0)} KB`);
  }
  const sched = core.filter((r) => r[9]).length;
  log(`scheduled-service airports: ${sched}; US airports: ${[...core, ...extra].filter((r) => US_AREAS.has(r[4])).length}; no tz: ${[...core, ...extra].filter((r) => r[8] < 0).length}`);
  return { core, extra, tzList };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out-dir");
  build({ fixtures: args.includes("--fixtures"), outDir: oi >= 0 ? resolve(args[oi + 1]) : undefined }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
