import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tzFor } from "./airport-tz.mjs";
import { csvObjects, detectStationFields, stationIndex, parseStations, runwayIndex, selectAirports, FIELDS } from "./build-airports.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FX, f), "utf8");

test("time zones: single-zone countries, US/Canada/Australia regions, split states", () => {
  assert.equal(tzFor("GB", "GB-ENG", 51.47, -0.46), "Europe/London");
  assert.equal(tzFor("US", "US-MN", 44.88, -93.22), "America/Chicago");
  assert.equal(tzFor("US", "US-TX", 31.8, -106.38), "America/Denver"); // El Paso
  assert.equal(tzFor("US", "US-FL", 30.47, -87.19), "America/Chicago"); // Pensacola
  assert.equal(tzFor("US", "US-FL", 28.43, -81.31), "America/New_York");
  assert.equal(tzFor("US", "US-TN", 35.04, -85.2), "America/New_York"); // Chattanooga
  assert.equal(tzFor("US", "US-TN", 36.12, -86.68), "America/Chicago"); // Nashville
  assert.equal(tzFor("US", "US-ID", 47.47, -117.0), "America/Los_Angeles"); // Coeur d'Alene
  assert.equal(tzFor("US", "US-AK", 51.88, -176.65), "America/Adak");
  assert.equal(tzFor("CA", "CA-NL", 53.32, -60.42), "America/Goose_Bay");
  assert.equal(tzFor("AU", "AU-QLD", -27.38, 153.12), "Australia/Brisbane");
  assert.equal(tzFor("ES", "ES-CN", 27.93, -15.39), "Atlantic/Canary");
  assert.equal(tzFor("RU", "RU-MOW", 55.97, 37.41), "Europe/Moscow");
  assert.equal(tzFor("ZZ", "", 0, 0), null);
});

test("AWC station list: TAF marker detected (siteType list) and logged fields", () => {
  const list = parseStations(read("awc-stations.json"));
  const det = detectStationFields(list);
  assert.equal(det.idKey, "icaoId");
  assert.equal(det.mode, "list");
  assert.equal(det.key, "siteType");
  const idx = stationIndex(list, det);
  assert.deepEqual(idx.get("KFCM"), { metar: true, taf: false });
  assert.deepEqual(idx.get("EGLL"), { metar: true, taf: true });
  // alternative shapes: boolean flag field, GeoJSON features
  const flag = detectStationFields([{ station_id: "KMSP", has_taf: "Y", has_metar: "Y" }, { station_id: "KFCM", has_taf: "N", has_metar: "Y" }]);
  assert.equal(flag.mode, "flag");
  assert.deepEqual(stationIndex([{ station_id: "KFCM", has_taf: "N", has_metar: "Y" }], flag).get("KFCM"), { metar: true, taf: false });
  assert.equal(parseStations(JSON.stringify({ features: [{ properties: { id: "KMSP" } }] }))[0].id, "KMSP");
});

test("AWC capability detection never mistakes the TAF airport code for a capability", () => {
  const list = [
    { id: "DAOL", icaoId: "DAOL", iataId: "TAF", site: "TAF", siteType: ["METAR"] },
    { id: "KORD", icaoId: "KORD", iataId: "ORD", siteType: ["METAR", "TAF"] },
  ];
  const det = detectStationFields(list);
  assert.equal(det.key, "siteType");
  assert.deepEqual(stationIndex(list, det).get("KORD"), { metar: true, taf: true });
  assert.deepEqual(stationIndex(list, det).get("DAOL"), { metar: true, taf: false });
});

test("selection: scheduled worldwide + US with a code; heliports/closed excluded; runways; compact rows", () => {
  const ap = csvObjects(read("ourairports-airports.csv")).rows;
  const st = stationIndex(parseStations(read("awc-stations.json")));
  const rw = runwayIndex(csvObjects(read("ourairports-runways.csv")).rows);
  const { core, extra, tzList } = selectAirports(ap, st, rw);
  const all = [...core, ...extra];
  const get = (icao) => all.find((r) => r[1] === icao);
  const f = Object.fromEntries(FIELDS.map((k, i) => [k, i]));
  assert.ok(get("EGLL") && get("Y49") && get("KFCM"));
  assert.equal(all.some((r) => /excluded/.test(r[f.name])), false);
  assert.equal(get("EGLL")[f.country], "GB");
  assert.equal(tzList[get("EGLL")[f.tz]], "Europe/London");
  assert.deepEqual([get("KFCM")[f.hasMetar], get("KFCM")[f.hasTaf], get("KFCM")[f.scheduled]], [1, 0, 0]);
  assert.deepEqual([get("Y49")[f.hasMetar], get("Y49")[f.iata]], [0, ""]);
  assert.ok(extra.some((r) => r[1] === "Y49")); // non-scheduled, no METAR -> extra
  assert.ok(core.some((r) => r[1] === "KFCM")); // US with METAR -> core
  const ord = get("KORD")[f.runways];
  assert.equal(ord.some(([ids]) => ids === "14R/32L"), false); // closed runway dropped
  assert.deepEqual(ord[0], ["9L/27R", 89]);
  assert.equal(get("KLAX")[f.runways].some(([ids]) => /^H/.test(ids)), false); // helipad dropped
});
