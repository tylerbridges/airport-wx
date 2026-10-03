import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  pointInRing, pointInPolygon, pointInGeometry, spcCategoryAt, convectiveSigmetsAt, decodeXml, elements, textOf,
  compactDuration, formatFaaTime, faaTimeMs, distToRingNm, pointNearGeometry, parseFaaXml, normalizeAlerts, expandTemplate, pool, latestBy,
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
  assert.deepEqual(convectiveSigmetsAt(-81.3, 28.4, list, NOW), [{ hazard: "CONVECTIVE", raw: "X", validTo: new Date(+NOW + 600e3).toISOString() }]);
  assert.deepEqual(convectiveSigmetsAt(-81.3, 28.4, null, NOW), []);
  // within 10 NM of the edge counts (29.1N is 6 NM north of the 29N edge); 20 NM out does not
  assert.equal(convectiveSigmetsAt(-81.3, 29.1, [base], NOW).length, 1);
  assert.equal(convectiveSigmetsAt(-81.3, 29.34, [base], NOW).length, 0);
});

test("convective SIGMET 80E (live, Oct 3 2026): CLT is a vertex of the polygon and counts as inside", () => {
  // "FROM 30NNW CLT-20N CLT-CLT-30NNW SPA" as served by aviationweather.gov
  const s80e = { hazard: "CONVECTIVE", validTimeFrom: 1791064500, validTimeTo: 1791071700, rawAirSigmet: "CONVECTIVE SIGMET 80E\nVALID UNTIL 2355Z\nNC\nFROM 30NNW CLT-20N CLT-CLT-30NNW SPA-30NNW CLT",
    coords: [{ lon: -81.17, lat: 35.679 }, { lon: -80.93, lat: 35.553 }, { lon: -80.93, lat: 35.22 }, { lon: -82.17, lat: 35.489 }, { lon: -81.17, lat: 35.679 }] };
  const at = new Date("2026-10-03T22:17:00Z");
  assert.equal(pointInRing(-80.9431, 35.2140, s80e.coords.map((c) => [c.lon, c.lat])), false, "plain ray casting misses it");
  assert.equal(convectiveSigmetsAt(-80.9431, 35.2140, [s80e], at).length, 1); // KCLT
  assert.ok(distToRingNm(-80.9431, 35.2140, s80e.coords.map((c) => [c.lon, c.lat])) < 1);
  assert.ok(pointNearGeometry(-80.9431, 35.2140, { type: "Polygon", coordinates: [s80e.coords.map((c) => [c.lon, c.lat])] }));
  assert.equal(convectiveSigmetsAt(-84.4277, 33.6407, [s80e], at).length, 0); // ATL, far away
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
  assert.deepEqual(r.byAirport.SFO, [{ type: "ground_stop", reason: "fog", detail: "until 5:30 PM PT", badge: "GROUND STOP", end: "2026-10-04T00:30:00.000Z" }]);
  assert.deepEqual(r.byAirport.EWR, [{ type: "ground_delay", reason: "wind", detail: "avg 52m, max 2h 8m", badge: "GDP avg 52m" }]);
  assert.deepEqual(r.byAirport.JFK, [{ type: "delay", reason: "volume & wx", detail: "Departures 16–30m, increasing", badge: "DELAYS", trend: "increasing" }]);
  assert.equal(faaTimeMs("5:30 pm EDT", "America/New_York", NOW), Date.parse("2026-10-03T21:30:00Z"));
  assert.equal(faaTimeMs("1:15 am EDT", "America/New_York", NOW), Date.parse("2026-10-04T05:15:00Z")); // rolls to tomorrow
  assert.equal(faaTimeMs("2130Z", "America/Chicago", NOW), Date.parse("2026-10-03T21:30:00Z"));
  assert.equal(faaTimeMs("", "America/Chicago", NOW), null);
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
  assert.equal(t("{{mdy+0}}"), "10/03/2026");
  assert.equal(t("{{sig-25}}"), "26/10/03 18:55");
  assert.equal(t("{{lc+0}}"), "10/03/2026  1830");
  assert.equal(t("{{lu+0}}").slice(0, 12), " 19 20 21 22");
  assert.equal(t("{{lu+0}}").length, 75);
  assert.equal(expandTemplate("{{lc+0}}", new Date("2026-10-04T00:10:00Z")), "10/03/2026  2330");
  assert.equal(t("{{ds-20}}"), "03/1900");
  assert.equal(t("{{tcf+5}}"), "20261004_0000");
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
  assert.equal(okCount, 10);
  const disk = JSON.parse(await readFile(out, "utf8"));
  assert.equal(disk.generated, NOW.toISOString());
  assert.deepEqual(Object.keys(disk.sources).sort(), ["atcscc", "cwa", "faa", "lamp", "metar", "nws", "sigmet", "spc", "taf", "tcf"]);
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
  assert.equal(by.MIA.now.level, 2); // possible ground stop (ops plan); SPC TSTM itself is informational only
  assert.ok(!by.MIA.now.reasons.some((r) => /thunderstorms possible/i.test(r)));
  assert.equal(by.MIA.peak.level, 3);
  assert.equal(by.BOS.now.level, 3);
  assert.equal(by.EWR.faa[0].badge, "GDP avg 52m");
  assert.equal(by.PHX.now.level, 0);
  assert.ok(status.airports.length === 32);
  // phase-1 sources (real-format fixtures: LAMP LP1/CP1, AWC TCF times, ops plan)
  assert.equal(by.ATL.lamp.issued, "2026-10-03T18:30:00.000Z");
  assert.ok(by.ATL.lamp.hours.every((h) => h.probHrs === 1 && h.tstmProb != null && h.convProb != null));
  assert.equal(by.HNL.lamp.hours[0].tstmProb, null); // Hawaii has no probability rows
  assert.ok(by.IAH.hours.some((h) => h.reasons.some((r) => /^Thunder chance 2\d% \(LAMP\)$/.test(r))));
  assert.equal(by.MCO.lamp.hours[0].convProb, 71); // CP1, the hour ending at the first column (before hour 0 here)
  assert.equal(by.PHX.lamp.hours.length, 25);
  assert.equal(by.IAH.peak.level, 3);
  assert.match(by.IAH.peak.reasons[0], /^Thunderstorms, high coverage \(TCF\)/);
  assert.equal(by.IAH.tcf[0].valid, "2026-10-03T23:00:00.000Z");
  assert.equal(by.BNA.now.level, 2);
  assert.match(by.BNA.now.reasons[0], /^Center weather advisory: thunderstorms until/);
  assert.equal(by.DEN.cwa[0].hazard, "TURB"); // stored, but no risk
  assert.ok(!by.DEN.now.reasons.some((r) => /Center weather/.test(r)));
  assert.equal(by.ORD.now.reasons.filter((r) => /^Ground stop/.test(r)).length, 1);
  assert.match(by.ORD.now.reasons[0], /^Ground stop — weather \(thunderstorms\), until/);
  // FAA Command Center operations plan (the real page is the fixture)
  assert.equal(disk.opsplan.plan.advisory, "072");
  assert.equal(disk.opsplan.launches[0].name, "SPACEX SDA-T1A");
  assert.deepEqual(disk.opsplan.staffing.map((x) => x.facility), ["ZOA"]);
  assert.ok(by.ATL.atcscc.length === 0 && by.ATL.opsplan.items.some((x) => x.kind === "program"));
  assert.ok(by.MCO.now.reasons.includes("FAA plans a possible ground stop until 7 PM (storms)"));
  assert.ok(by.TPA.now.reasons.includes("FAA reports delays at MCO/TPA expected to continue"));
  assert.match(by.BNA.now.reasons.join("|"), /Air traffic control staffing shortage until 8 PM — delays possible/);
  assert.equal(by.SAN.now.level, 3); // ops-plan GDP (the fixture's NAS status has none at SAN)
  assert.deepEqual(by.SAN.hours.slice(0, 7).map((h) => h.level), [3, 3, 3, 3, 3, 3, 0]); // until 0059Z
  assert.ok(by.DEN.now.reasons.includes("Runway 16R/34L closed until Nov 4"));
  assert.ok(by.JFK.opsplan.constraints[0].codes.includes("N90"));
  assert.ok(by.PHL.opsplan.items.some((x) => x.ifr && /glideslope/.test(x.text)));
  // NAS programs hold: EWR's GDP has no end (3 h), JFK's delays are increasing (5 h)
  assert.ok(by.EWR.hours[3].reasons.some((r) => /^Ground delay program/.test(r)));
  assert.ok(!by.EWR.hours[4].reasons.some((r) => /^Ground delay program/.test(r)));
  assert.ok(by.JFK.hours[5].reasons.some((r) => /^Delays/.test(r)) && !by.JFK.hours[6].reasons.some((r) => /^Delays/.test(r)));
  // FAA closures: LAX is GA-only (informational), SEA a single runway (Low)
  assert.equal(by.LAX.faa[0].scope, "limited");
  assert.equal(by.LAX.faa[0].badge, null);
  assert.equal(by.LAX.now.level, 2); // unchanged by the closure
  assert.ok(!by.LAX.now.reasons.some((r) => /closed/i.test(r)));
  assert.ok(by.SEA.now.reasons.includes("Runway 16L/34R closed"));
  assert.equal(by.SEA.now.level, 1);
  assert.equal(by.JFK.faa[0].cause, "volume");
  assert.equal(by.FLL.now.level, 2); // possible ground stop (ops plan)
  assert.equal(by.FLL.spc, "TSTM");
  // reasons are deduped within a box
  for (const a of disk.airports) assert.equal(new Set(a.now.reasons).size, a.now.reasons.length);
  assert.equal(by.ORD.now.reasons.filter((r) => /^Visibility/.test(r)).length, 1);
  assert.ok(here);
});
