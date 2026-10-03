import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  pointInRing, pointInPolygon, pointInGeometry, spcCategoryAt, convectiveSigmetsAt, decodeXml, elements, textOf,
  compactDuration, formatFaaTime, parseFaaXml, normalizeAlerts, expandTemplate, pool, latestBy,
} from "./lib.mjs";
import { assemble, run } from "./poll.mjs";

const NOW = new Date("2026-10-03T19:20:00Z");
const sq = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d], [a, b]];

test("point in polygon, holes and multipolygons", () => {
  assert.ok(pointInRing(5, 5, sq(0, 0, 10, 10)));
  assert.ok(!pointInRing(11, 5, sq(0, 0, 10, 10)));
  const donut = [sq(0, 0, 10, 10), sq(4, 4, 6, 6)];
  assert.ok(pointInPolygon(2, 2, donut));
  assert.ok(!pointInPolygon(5, 5, donut));
  const mp = { type: "MultiPolygon", coordinates: [[sq(0, 0, 1, 1)], [sq(20, 20, 30, 30)]] };
  assert.ok(pointInGeometry(25, 25, mp));
  assert.ok(!pointInGeometry(10, 10, mp));
  assert.ok(!pointInGeometry(1, 1, null));
});

test("SPC category is the highest containing polygon", () => {
  const f = (LABEL, c) => ({ properties: { LABEL }, geometry: { type: "Polygon", coordinates: [c] } });
  const gj = { features: [f("ENH", sq(-99, 31, -95, 34)), f("SLGT", sq(-100, 28, -93, 36)), f("TSTM", sq(-110, 20, -80, 45)), f("MDT", sq(0, 0, 1, 1))] };
  assert.equal(spcCategoryAt(-97, 33, gj), "ENH");
  assert.equal(spcCategoryAt(-94, 30, gj), "SLGT");
  assert.equal(spcCategoryAt(-105, 40, gj), "TSTM");
  assert.equal(spcCategoryAt(-60, 40, gj), null);
});

test("convective SIGMETs: only valid CONVECTIVE ones that contain the point", () => {
  const ring = (lat0, lat1, lon0, lon1) => [{ lat: lat0, lon: lon0 }, { lat: lat0, lon: lon1 }, { lat: lat1, lon: lon1 }, { lat: lat1, lon: lon0 }];
  const base = { hazard: "CONVECTIVE", validTimeFrom: +NOW / 1000 - 600, validTimeTo: +NOW / 1000 + 600, rawAirSigmet: "X", coords: ring(27, 29, -83, -80) };
  const list = [base, { ...base, hazard: "TURB" }, { ...base, validTimeTo: +NOW / 1000 - 5 }, { ...base, validTimeFrom: +NOW / 1000 + 5 }, { ...base, coords: ring(40, 41, -90, -89) }];
  assert.deepEqual(convectiveSigmetsAt(-81.3, 28.4, list, NOW), [{ hazard: "CONVECTIVE", raw: "X" }]);
  assert.deepEqual(convectiveSigmetsAt(-81.3, 28.4, null, NOW), []);
});

test("xml helpers", () => {
  assert.equal(decodeXml("a &amp; b &#39;c&#x21;"), "a & b 'c!");
  assert.equal(textOf("<R><A> x  y </A></R>", "A"), "x y");
  assert.equal(elements("<A/><A>1</A><A_B>2</A_B>", "A").length, 2);
  assert.equal(textOf("<a><![CDATA[1 < 2]]></a>", "a"), "1 < 2");
});

test("duration and FAA clock formatting", () => {
  assert.equal(compactDuration("52 minutes"), "52m");
  assert.equal(compactDuration("2 hours and 8 minutes"), "2h 8m");
  assert.equal(compactDuration("1 hour"), "1h");
  assert.equal(formatFaaTime("5:30 pm EDT", "America/New_York", NOW), "5:30 PM ET");
  assert.equal(formatFaaTime("5:00 pm CDT.", "America/Chicago", NOW), "5 PM CT");
  assert.equal(formatFaaTime("2130Z", "America/Chicago", NOW), "4:30 PM CT");
  assert.equal(formatFaaTime("Oct 03 at 21:30 UTC", "America/New_York", NOW), "5:30 PM ET");
  assert.equal(formatFaaTime("sometime", "America/New_York", NOW), "sometime");
  assert.equal(formatFaaTime("", "America/New_York", NOW), "");
});

const XML = `<?xml version="1.0"?>
<AIRPORT_STATUS_INFORMATION><Update_Time>Sat Oct 03 19:15:00 2026 GMT</Update_Time>
<Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List><Program><ARPT>SFO</ARPT><Reason>fog</Reason><End_Time>5:30 pm PDT</End_Time></Program></Ground_Stop_List></Delay_type>
<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>EWR</ARPT><Reason>wind</Reason><Avg>52 minutes</Avg><Max>2 hours and 8 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>
<Delay_type><Name>General Arrival/Departure Delays</Name><Arrival_Departure_Delay_List><Delay><ARPT>JFK</ARPT><Reason>volume &amp; wx</Reason><Arrival_Departure Type="Departure"><Min>16 minutes</Min><Max>30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay></Arrival_Departure_Delay_List></Delay_type>
<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>ANC</ARPT><Reason>runway</Reason><Start>1:00 pm AKDT</Start><Reopen>9:00 pm AKDT</Reopen></Airport></Airport_Closure_List></Delay_type>
<Delay_type><Name>Something New</Name><Other><ARPT>XXX</ARPT></Other></Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

test("FAA XML parser covers all four program types and ignores unknown ones", () => {
  const r = parseFaaXml(XML, { now: NOW, tzFor: () => "America/Los_Angeles" });
  assert.equal(r.updated, "Sat Oct 03 19:15:00 2026 GMT");
  assert.deepEqual(r.byAirport.SFO, [{ type: "ground_stop", reason: "fog", detail: "until 5:30 PM PT", badge: "GROUND STOP" }]);
  assert.deepEqual(r.byAirport.EWR, [{ type: "ground_delay", reason: "wind", detail: "avg 52m, max 2h 8m", badge: "GDP avg 52m" }]);
  assert.deepEqual(r.byAirport.JFK, [{ type: "delay", reason: "volume & wx", detail: "Departures 16–30m, increasing", badge: "DELAYS" }]);
  assert.equal(r.byAirport.ANC[0].type, "closure");
  assert.equal(r.byAirport.ANC[0].detail, "until 9 PM AKT");
  assert.equal(r.byAirport.XXX, undefined);
});

test("FAA parser tolerates garbage", () => {
  assert.deepEqual(parseFaaXml("", { now: NOW }).byAirport, {});
  assert.deepEqual(parseFaaXml("<html>503</html>", { now: NOW }).byAirport, {});
});

test("NWS alert normalisation drops expired, cancelled and duplicate alerts", () => {
  const f = (p) => ({ properties: p });
  const out = normalizeAlerts({ features: [
    f({ event: "Wind Advisory", headline: "h", ends: "2026-10-03T22:00:00Z", severity: "Moderate" }),
    f({ event: "Wind Advisory", headline: "h", ends: "2026-10-03T22:00:00Z" }),
    f({ event: "Old", ends: "2026-10-03T10:00:00Z" }),
    f({ event: "Gone", messageType: "Cancel" }),
    f({ event: "No end", expires: "2026-10-04T10:00:00Z" }),
  ] }, NOW);
  assert.deepEqual(out.map((a) => a.event), ["Wind Advisory", "No end"]);
  assert.equal(out[1].ends, "2026-10-04T10:00:00Z");
});

test("fixture templates expand relative to now", () => {
  const t = (s) => expandTemplate(s, NOW);
  assert.equal(t("{{+90}}"), String(Math.floor(+NOW / 1000) + 5400));
  assert.equal(t("{{-20}}"), String(Math.floor(+NOW / 1000) - 1200));
  assert.equal(t("{{h+3}}"), String(Date.parse("2026-10-03T22:00:00Z") / 1000));
  assert.equal(t("{{iso+10}}"), "2026-10-03T19:30:00.000Z");
  assert.equal(t("{{z-5}}"), "031915");
  assert.equal(t("{{dh+6}}"), "0401");
  assert.equal(t("{{clock+40 America/Chicago}}"), "3:00 pm CDT");
});

test("pool respects the concurrency limit and keeps order", async () => {
  let active = 0, max = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    active++; max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.equal(max, 3);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test("latestBy picks the newest record per id", () => {
  const m = latestBy([{ id: "A", t: 1, v: "old" }, { id: "A", t: 5, v: "new" }, { id: "B", t: 2, v: "b" }, { v: "noid" }], "id", "t");
  assert.equal(m.get("A").v, "new");
  assert.equal(m.size, 2);
});

test("assemble tolerates every source missing", () => {
  const airports = [{ iata: "ORD", icao: "KORD", name: "O'Hare", city: "Chicago", state: "IL", tz: "America/Chicago", lat: 41.97, lon: -87.9 }];
  const out = assemble({ airports, now: NOW, metars: null, tafs: null, sigmets: null, faaParsed: null, spc: null, nws: null });
  assert.equal(out.length, 1);
  assert.equal(out[0].metar, null);
  assert.equal(out[0].taf, null);
  assert.equal(out[0].now.level, 0);
  assert.equal(out[0].hours.length, 24);
});

test("fixture run writes a schema-shaped status.json", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(process.env.TMPDIR || "/tmp", `awx-test-${process.pid}.json`);
  const { status, okCount } = await run({ fixtures: true, out, now: NOW });
  assert.equal(okCount, 6);
  const disk = JSON.parse(await readFile(out, "utf8"));
  assert.equal(disk.generated, NOW.toISOString());
  assert.deepEqual(Object.keys(disk.sources).sort(), ["faa", "metar", "nws", "sigmet", "spc", "taf"]);
  for (const s of Object.values(disk.sources)) assert.deepEqual(Object.keys(s).sort(), ["at", "error", "ok"]);
  assert.equal(disk.airports.length, 32);
  const by = Object.fromEntries(disk.airports.map((a) => [a.iata, a]));
  for (const a of disk.airports) {
    assert.equal(a.hours.length, 24);
    assert.equal(a.peak.level, Math.max(...a.hours.map((h) => h.level)));
    assert.equal(a.now.level, a.hours[0].level);
  }
  // levels sorted by peak, then now, then iata
  for (let i = 1; i < disk.airports.length; i++) {
    const p = disk.airports[i - 1], q = disk.airports[i];
    assert.ok(p.peak.level > q.peak.level || (p.peak.level === q.peak.level && (p.now.level > q.now.level || (p.now.level === q.now.level && p.iata < q.iata))));
  }
  assert.equal(by.ORD.now.level, 4);
  assert.equal(by.ORD.faa[0].type, "ground_stop");
  assert.equal(by.DEN.metar.fltCat, "IFR");
  assert.equal(by.DFW.spc, "ENH");
  assert.equal(by.DFW.alerts[0].event, "Severe Thunderstorm Warning");
  assert.equal(by.MCO.sigmets.length, 1);
  assert.equal(by.MIA.now.level, 1);
  assert.equal(by.MIA.peak.level, 3);
  assert.equal(by.BOS.now.level, 3);
  assert.equal(by.EWR.faa[0].badge, "GDP avg 52m");
  assert.equal(by.PHX.now.level, 0);
  assert.ok(status.airports.length === 32);
  assert.ok(here);
});
