import test from "node:test";
import assert from "node:assert/strict";
import {
  lampCycles, lampUrl, parseLamp, lampBlocks, htmlToText, atcsccLinks, advType, parsePeriod, resolveDdhhmm,
  parseAdvisory, inlineAdvisories, finalizeAtcscc, collectAtcscc, shapeContains, tcfCoverage, tcfAt, cwaAt,
} from "./sources.mjs";

const NOW = new Date("2026-10-03T19:20:00Z");

// ---------- LAMP ----------

const cols = (vals) => vals.map((v) => String(v ?? "").padStart(3, " ")).join("");
const hrs = (from, n) => Array.from({ length: n }, (_, i) => String((from + i) % 24).padStart(2, "0"));
function block(id, header, utc, rows) {
  return [` ${id}   GFS LAMP GUIDANCE   ${header} UTC`, ` UTC ${cols(utc)}`, ...Object.entries(rows).map(([k, v]) => ` ${k} ${cols(v)}`.trimEnd())].join("\n");
}

test("LAMP cycles step back hourly across midnight; URL uses the cycle's own date", () => {
  const c = lampCycles(new Date("2026-10-04T00:10:00Z"), 3);
  assert.deepEqual(c.map((d) => d.toISOString()), ["2026-10-03T23:30:00.000Z", "2026-10-03T22:30:00.000Z", "2026-10-03T21:30:00.000Z", "2026-10-03T20:30:00.000Z"]);
  assert.equal(lampCycles(new Date("2026-10-04T00:31:00Z"), 0)[0].toISOString(), "2026-10-04T00:30:00.000Z");
  assert.equal(lampUrl(c[0]), "https://nomads.ncep.noaa.gov/pub/data/nccf/com/lmp/prod/lmp.20261003/lmp.t2330z.lavtxt.ascii");
});

test("LAMP: columns aligned on the UTC row, sparse LP2, NG gusts, merged 100s, date rollover", () => {
  const utc = hrs(22, 6); // 22 23 00 01 02 03
  const text = [
    "random preamble line",
    block("KMSP", "10/03/2026  2130", utc, {
      TMP: [50, 49, 48, 47, 46, 45],
      WGS: ["NG", 25, "NG", 31, "NG", "NG"],
      PPO: [5, 10, 100, 100, 40, 2],
      LP2: [null, 12, null, 45, null, 3],
      POZ: [0, 0, 10, 20, 30, 40],
      TYP: ["R", "R", "S", "Z", "", "R"],
      CIG: [8, 7, 3, 2, 1, 8],
      VIS: [7, 7, 5, 4, 1, 7],
      XYZ: [1, 2, 3, 4, 5, 6],
    }),
    block("KABE", "10/03/2026  2130", utc, { LP2: [null, 99, null, 99, null, 99] }),
  ].join("\n");
  assert.ok(text.includes("100100"), "fixture really has merged values");
  const r = parseLamp(text, new Set(["KMSP"]));
  assert.equal(r.blocks, 2);
  assert.deepEqual(Object.keys(r.stations), ["KMSP"]);
  const s = r.stations.KMSP;
  assert.equal(s.issued, "2026-10-03T21:30:00.000Z");
  assert.deepEqual(s.hours.map((h) => h.t.slice(5, 13)), ["10-03T22", "10-03T23", "10-04T00", "10-04T01", "10-04T02", "10-04T03"]);
  assert.deepEqual(s.hours.map((h) => h.gust), [0, 25, 0, 31, 0, 0]);
  assert.deepEqual(s.hours.map((h) => h.pPrecip), [5, 10, 100, 100, 40, 2]);
  assert.deepEqual(s.hours.map((h) => h.tstmProb), [null, 12, null, 45, null, 3]);
  assert.deepEqual(s.hours.map((h) => h.typ), ["R", "R", "S", "Z", null, "R"]);
  assert.deepEqual(s.hours.map((h) => h.cig), [8, 7, 3, 2, 1, 8]);
  assert.deepEqual(s.hours.map((h) => h.vis), [7, 7, 5, 4, 1, 7]);
  assert.deepEqual(s.hours.map((h) => h.pFrz), [0, 0, 10, 20, 30, 40]);
  assert.equal(parseLamp(text).stations.KABE.hours[1].tstmProb, 99);
  assert.ok(lampBlocks(text, new Set(["KABE"])).startsWith(" KABE"));
});

test("LAMP: 2330 cycle starts on the next day; missing rows give nulls", () => {
  const r = parseLamp(block("KORD", "10/03/2026  2330", hrs(0, 3), { TMP: [1, 2, 3] }));
  assert.deepEqual(r.stations.KORD.hours.map((h) => h.t), ["2026-10-04T00:00:00.000Z", "2026-10-04T01:00:00.000Z", "2026-10-04T02:00:00.000Z"]);
  assert.equal(r.stations.KORD.hours[0].tstmProb, null);
  assert.equal(r.stations.KORD.hours[0].gust, null);
});

test("LAMP parser tolerates garbage and blocks without dates", () => {
  assert.deepEqual(parseLamp("").stations, {});
  assert.deepEqual(parseLamp("<html>404 Not Found</html>").stations, {});
  assert.deepEqual(parseLamp(null).stations, {});
  const r = parseLamp(" KXYZ   GFS LAMP GUIDANCE   sometime\n UTC  01 02");
  assert.equal(r.blocks, 1);
  assert.deepEqual(r.stations, {});
});

// ---------- ATCSCC ----------

const GS = `ATCSCC ADVZY 050 ORD/ZAU 10/03/2026 CDM GROUND STOP

CTL ELEMENT: ORD
ELEMENT TYPE: APT
ADL TIME: 1855Z
GROUND STOP PERIOD: 03/1855Z – 03/2045Z
IMPACTING CONDITION: WEATHER / THUNDERSTORMS
COMMENTS:
EFFECTIVE TIME: 031855 - 032100
SIGNATURE: 26/10/03 18:55`;

test("advisory: ground stop fields, period, signature, id", () => {
  const a = parseAdvisory(GS, { now: NOW });
  assert.equal(a.id, "2026-10-03#050");
  assert.equal(a.type, "GS");
  assert.equal(a.airport, "ORD");
  assert.equal(a.cnx, false);
  assert.equal(a.issued, "2026-10-03T18:55:00.000Z");
  assert.equal(a.start, "2026-10-03T18:55:00.000Z");
  assert.equal(a.end, "2026-10-03T20:45:00.000Z"); // the GS period wins over EFFECTIVE TIME
  assert.equal(a.cause, "weather");
  assert.equal(a.causeText, "WEATHER / THUNDERSTORMS");
  assert.match(a.title, /CDM GROUND STOP$/);
});

test("advisory: GDP, CNX, AFP, REASON field, K-prefixed element, title-only fallback", () => {
  const gdp = parseAdvisory("ATCSCC ADVZY 052 SFO/ZOA 10/03/2026 CDM GROUND DELAY PROGRAM\nCTL ELEMENT: KSFO\nCUMULATIVE PROGRAM PERIOD: 03/1800Z - 04/0300Z\nREASON: VOLUME / VOLUME\nSIGNATURE: 26/10/03 17:40", { now: NOW });
  assert.equal(gdp.type, "GDP");
  assert.equal(gdp.airport, "SFO");
  assert.equal(gdp.cause, "volume");
  assert.equal(gdp.end, "2026-10-04T03:00:00.000Z");
  const cnx = parseAdvisory("ATCSCC ADVZY 053 EWR/ZNY 10/03/2026 CDM GS CNX\nCTL ELEMENT: EWR", { now: NOW });
  assert.equal(cnx.type, "GS");
  assert.equal(cnx.cnx, true);
  const afp = parseAdvisory("ATCSCC ADVZY 054 FCAA08 10/03/2026 CDM AIRSPACE FLOW PROGRAM\nCTL ELEMENT: FCAA08\nIMPACTING CONDITION: WEATHER / THUNDERSTORMS", { now: NOW });
  assert.equal(afp.type, "AFP");
  assert.equal(afp.airport, null);
  assert.equal(afp.ctl, "FCAA08");
  const t = parseAdvisory("Advisory not found", { title: "ATCSCC ADVZY 060 MIA/ZMA 10/03/2026 CDM GROUND STOP", href: "x", now: NOW });
  assert.equal(t.type, "GS");
  assert.equal(t.airport, "MIA");
  assert.equal(t.cause, "unknown");
  assert.equal(advType("ROUTE RQD"), "other");
});

test("periods: DD/HHMMZ or DDHHMM, month-end rollover, near now", () => {
  assert.deepEqual(parsePeriod("031855 - 032100", NOW), { start: Date.parse("2026-10-03T18:55:00Z"), end: Date.parse("2026-10-03T21:00:00Z") });
  const n = new Date("2026-10-31T23:00:00Z");
  assert.deepEqual(parsePeriod("31/2300Z – 01/0300Z", n), { start: Date.parse("2026-10-31T23:00:00Z"), end: Date.parse("2026-11-01T03:00:00Z") });
  assert.equal(resolveDdhhmm(30, 12, 0, new Date("2026-10-01T00:00:00Z")), Date.parse("2026-09-30T12:00:00Z"));
  assert.equal(parsePeriod("nothing", NOW), null);
});

test("advisory list: links (relative, title param, onclick), scripts ignored", () => {
  const html = `<script>var s = "<a href='bogus'>GROUND STOP</a>";</script>
  <a href="adv_otherdis.jsp?advn=50&amp;title=X">ATCSCC ADVZY 050 ORD/ZAU 10/03/2026 CDM GROUND STOP</a>
  <a href="/adv/adv_otherdis.jsp?advn=51&amp;title=ATCSCC%20ADVZY%20051%20JFK%2FZNY%20CDM%20GROUND%20DELAY%20PROGRAM"></a>
  <a href="javascript:void(0)" onclick="window.open('adv_otherdis.jsp?advn=52')">ADVZY 052</a>
  <a href="/ois/">NAS status</a>`;
  const links = atcsccLinks(html, "https://www.fly.faa.gov/adv/advADB.jsp");
  assert.deepEqual(links.map((l) => l.href), [
    "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=50&title=X",
    "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=51&title=ATCSCC%20ADVZY%20051%20JFK%2FZNY%20CDM%20GROUND%20DELAY%20PROGRAM",
    "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=52",
  ]);
  assert.equal(links[1].title, "ATCSCC ADVZY 051 JFK/ZNY CDM GROUND DELAY PROGRAM");
  assert.equal(htmlToText("<p>a&nbsp;b<br>c</p><td>x</td><td>y</td>").trim(), "a b\nc\nx y");
});

test("inline advisories on a page need field lines (titles alone aren't advisories)", () => {
  const page = `<pre>${GS}</pre><p>ATCSCC ADVZY 051 JFK/ZNY 10/03/2026 ROUTE RQD</p>`;
  const inl = inlineAdvisories(page, NOW);
  assert.equal(inl.length, 1);
  assert.equal(inl[0].airport, "ORD");
});

test("finalize: latest per airport+type decides; CNX and expired are inactive; no end = inactive", () => {
  const mk = (id, o) => ({ id, type: "GS", airport: "ORD", cnx: false, issued: "2026-10-03T18:00:00Z", start: "2026-10-03T18:00:00Z", end: "2026-10-03T20:00:00Z", ...o });
  let out = finalizeAtcscc([mk("a"), mk("b", { issued: "2026-10-03T19:00:00Z", cnx: true })], NOW);
  assert.ok(out.every((x) => !x.active));
  out = finalizeAtcscc([mk("a"), mk("a"), mk("c", { airport: "JFK" })], NOW);
  assert.equal(out.length, 2);
  assert.ok(out.every((x) => x.active));
  assert.equal(finalizeAtcscc([mk("d", { end: "2026-10-03T19:00:00Z" })], NOW)[0].active, false);
  assert.equal(finalizeAtcscc([mk("e", { end: null })], NOW)[0].active, false);
  assert.equal(finalizeAtcscc([mk("f", { start: "2026-10-03T21:00:00Z", end: "2026-10-03T23:00:00Z" })], NOW)[0].active, false);
});

test("collectAtcscc follows program links only, survives failing pages, reports counts", async () => {
  const list = `<a href="adv?advn=1">ATCSCC ADVZY 001 ORD/ZAU 10/03/2026 CDM GROUND STOP</a>
    <a href="adv?advn=2">ATCSCC ADVZY 002 DCC 10/03/2026 ROUTE RQD</a>
    <a href="adv?advn=3">ATCSCC ADVZY 003 JFK/ZNY 10/03/2026 CDM GROUND DELAY PROGRAM</a>`;
  const seen = [];
  const r = await collectAtcscc(list, async (url) => {
    seen.push(url);
    if (url.endsWith("=3")) throw new Error("HTTP 500");
    return `<pre>${GS}</pre>`;
  }, { base: "https://www.fly.faa.gov/adv/advADB.jsp", now: NOW });
  assert.deepEqual(seen.map((u) => u.slice(-1)), ["1", "3"]);
  assert.equal(r.links, 3);
  assert.equal(r.followed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.firstError, "HTTP 500");
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].active, true);
  // no program titles: falls back to the first advisory links
  const r2 = await collectAtcscc(`<a href="adv?advn=9">ADVZY 009</a>`, async () => `<pre>${GS}</pre>`, { now: NOW });
  assert.equal(r2.followed, 1);
  assert.equal(r2.list.length, 1);
  const r3 = await collectAtcscc("<html>nothing</html>", async () => "", { now: NOW });
  assert.deepEqual([r3.links, r3.list.length], [0, 0]);
});

// ---------- TCF / CWA ----------

const sq = (lat, lon, d = 0.5) => [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];

test("shapes: GeoJSON, {lat,lon} lists, [lat,lon] pairs, nested rings", () => {
  assert.ok(shapeContains(-95, 30, { geometry: { type: "Polygon", coordinates: [sq(30, -95)] } }));
  assert.ok(shapeContains(-95, 30, { coords: [{ lat: 29, lon: -96 }, { lat: 29, lon: -94 }, { lat: 31, lon: -94 }, { lat: 31, lon: -96 }] }));
  assert.ok(shapeContains(-95, 30, { coords: [[29, -96], [29, -94], [31, -94], [31, -96]] }));
  assert.ok(shapeContains(-95, 30, { properties: { coordinates: [sq(30, -95)] } }));
  assert.ok(!shapeContains(-95, 30, { geometry: { type: "LineString", coordinates: [[-96, 29], [-94, 31]] } }));
  assert.ok(!shapeContains(-95, 30, null));
});

test("TCF coverage words and numbers", () => {
  assert.deepEqual(["High", "HIGH CVG", "Medium", "MED", "sparse", "Low", 3, 2, 1, 45, 30, 10, "?", null].map(tcfCoverage),
    ["high", "high", "medium", "medium", "low", "low", "high", "medium", "low", "high", "medium", "low", null, null]);
});

test("TCF: point in polygon, tolerant property names, expired dropped, empty ok", () => {
  const fc = { features: [
    { properties: { validTime: "2026-10-03T23:00:00Z", coverage: "High", confidence: "High", tops: "FL350-390" }, geometry: { type: "Polygon", coordinates: [sq(30, -95)] } },
    { properties: { VALID_TIME: "2026-10-04T01:00:00Z", CVG: "MED", CONF: "LOW", TOPS_FL: "FL300" }, geometry: { type: "Polygon", coordinates: [sq(30, -95, 1)] } },
    { properties: { validTime: "2026-10-03T17:00:00Z", coverage: "High" }, geometry: { type: "Polygon", coordinates: [sq(30, -95)] } },
    { properties: { validTime: "2026-10-03T23:00:00Z", coverage: "High" }, geometry: { type: "Polygon", coordinates: [sq(40, -80)] } },
  ] };
  const out = tcfAt(-95, 30, fc, NOW);
  assert.deepEqual(out.map((x) => [x.valid, x.coverage, x.confidence, x.tops]), [
    ["2026-10-03T23:00:00.000Z", "high", "High", "FL350-390"],
    ["2026-10-04T01:00:00.000Z", "medium", "LOW", "FL300"],
  ]);
  assert.equal(out[0].props.coverage, "High");
  assert.deepEqual(tcfAt(-95, 30, { features: [] }, NOW), []);
  assert.deepEqual(tcfAt(-95, 30, [], NOW), []);
  assert.deepEqual(tcfAt(-95, 30, "garbage", NOW), []);
});

test("CWA: AWC JSON with coords, GeoJSON features, expired dropped", () => {
  const list = [
    { hazard: "TS", validTimeFrom: Date.parse("2026-10-03T19:00:00Z") / 1000, validTimeTo: Date.parse("2026-10-03T21:00:00Z") / 1000, cwaText: "ZAU CWA 101 TS", coords: [{ lat: 41, lon: -89 }, { lat: 41, lon: -87 }, { lat: 43, lon: -87 }, { lat: 43, lon: -89 }] },
    { hazard: "IFR", validTimeFrom: "2026-10-03T17:00:00Z", validTimeTo: "2026-10-03T18:00:00Z", cwaText: "old", coords: [{ lat: 41, lon: -89 }, { lat: 41, lon: -87 }, { lat: 43, lon: -87 }] },
  ];
  assert.deepEqual(cwaAt(-87.9, 41.97, list, NOW), [{ hazard: "TS", validFrom: "2026-10-03T19:00:00.000Z", validTo: "2026-10-03T21:00:00.000Z", raw: "ZAU CWA 101 TS" }]);
  const gj = { type: "FeatureCollection", features: [{ type: "Feature", properties: { hazard: "IFR", validTimeTo: "2026-10-03T22:00:00Z", rawText: "CWA IFR" }, geometry: { type: "Polygon", coordinates: [sq(42, -88, 1)] } }] };
  assert.equal(cwaAt(-87.9, 41.97, gj, NOW)[0].hazard, "IFR");
  assert.equal(cwaAt(-87.9, 41.97, gj, NOW)[0].raw, "CWA IFR");
  assert.deepEqual(cwaAt(-87.9, 41.97, null, NOW), []);
});
