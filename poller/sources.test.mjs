import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTemplate } from "./lib.mjs";
import {
  awcTime, lampCycles, lampUrl, parseLamp, lampBlocks, htmlToText, atcsccLinks, atcsccListUrl, isAdvisoryList, advType, parsePeriod, resolveDdhhmm,
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

// The real bulletin's 32 airport blocks (+1 other) captured 2026-10-03 (2130Z cycle); expands to the original at this time.
const LAMP_CAPTURED = new Date("2026-10-03T22:17:00Z");
const realLamp = async () => expandTemplate(await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/lamp.txt"), "utf8"), LAMP_CAPTURED);

test("LAMP (real bulletin): LP1 -> tstmProb, CP1 -> convProb, hourly; P06 alignment; no-probability blocks", async () => {
  const text = await realLamp();
  assert.match(text, /^ KMSP {3}GFS LAMP GUIDANCE {2}10\/03\/2026 {2}2130 UTC/m);
  assert.match(text, /^ LP1 {3}0 {2}2 {2}0 {2}0 {2}0 {2}1/m);
  const all = parseLamp(text);
  assert.equal(all.blocks, 33);
  const r = parseLamp(text, new Set(["KMSP", "PHNL", "KIAH", "KCLT"]));
  assert.deepEqual(Object.keys(r.stations).sort(), ["KCLT", "KIAH", "KMSP", "PHNL"]);
  const msp = r.stations.KMSP;
  assert.equal(msp.issued, "2026-10-03T21:30:00.000Z");
  assert.equal(msp.hours.length, 25);
  assert.equal(msp.hours[0].t, "2026-10-03T22:00:00.000Z");
  assert.equal(msp.hours[24].t, "2026-10-04T22:00:00.000Z");
  assert.deepEqual(msp.hours.slice(0, 8).map((h) => h.tstmProb), [0, 2, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(msp.hours.slice(0, 6).map((h) => h.convProb), [21, 14, 20, 0, 0, 1]);
  assert.ok(msp.hours.every((h) => h.tstmProb != null && h.convProb != null && h.probHrs === 1));
  assert.deepEqual(msp.hours.slice(0, 5).map((h) => h.pPrecip), [13, 38, 38, 33, 8]);
  assert.deepEqual(msp.hours.slice(20, 25).map((h) => h.gust), [0, 0, 0, 19, 0]);
  assert.deepEqual(msp.hours.slice(0, 5).map((h) => h.cig), [7, 7, 6, 6, 7]);
  const iah = r.stations.KIAH.hours;
  assert.equal(Math.max(...iah.map((h) => h.tstmProb)), 22);
  assert.equal(Math.max(...iah.map((h) => h.convProb)), 51);
  // Hawaii: no P01/LP1/CP1 rows at all
  const hnl = r.stations.PHNL;
  assert.equal(hnl.hours.length, 25);
  assert.ok(hnl.hours.every((h) => h.tstmProb === null && h.convProb === null && h.probHrs === null));
  assert.deepEqual(hnl.hours.slice(0, 6).map((h) => h.gust), [20, 19, 19, 20, 20, 0]);
});

test("LAMP: LP2/CP2 used only when LP1/CP1 are missing", () => {
  const utc = hrs(22, 4);
  const both = parseLamp(block("KXXX", "10/03/2026  2130", utc, { LP1: [5, 6, 7, 8], LP2: [null, 90, null, 90], CP1: [50, 0, 0, 0] })).stations.KXXX.hours;
  assert.deepEqual(both.map((h) => [h.tstmProb, h.convProb, h.probHrs]), [[5, 50, 1], [6, 0, 1], [7, 0, 1], [8, 0, 1]]);
  const old = parseLamp(block("KXXX", "10/03/2026  2130", utc, { LP2: [null, 30, null, 45], CP2: [null, 60, null, 10] })).stations.KXXX.hours;
  assert.deepEqual(old.map((h) => [h.tstmProb, h.convProb, h.probHrs]), [[null, null, 2], [30, 60, 2], [null, null, 2], [45, 10, 2]]);
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

test("ATCSCC departure scope retains explicit airports and qualifies center-only coverage", () => {
  const one = parseAdvisory(GS + "\nDEP AIRPORTS INCLUDED: KMSP JFK\n", { now: NOW });
  assert.deepEqual(one.departureScope.airports, ["MSP", "JFK"]);
  const centers = parseAdvisory(GS + "\nDEP FACILITIES INCLUDED: ZNY ZBW\n", { now: NOW });
  assert.equal(centers.departureScope.airports, null);
  assert.equal(centers.departureScope.all, false);
  assert.equal(parseAdvisory(GS + "\nDEP AIRPORTS INCLUDED: ALL\n", { now: NOW }).departureScope.airports, null);
  assert.equal(parseAdvisory(GS + "\nFLIGHTS INCLUDED: ALL FLIGHTS\n", { now: NOW }).departureScope.all, true);
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

test("TCF (real AWC format): YYYYMMDD_HHMM times, sparse coverage", () => {
  assert.equal(awcTime("20261004_0100"), Date.parse("2026-10-04T01:00:00Z"));
  assert.equal(awcTime("2026-10-04T01:00:00Z"), Date.parse("2026-10-04T01:00:00Z"));
  assert.equal(awcTime(null), null);
  // a feature exactly as served on 2026-10-03 (issued 2100Z), around Houston
  const fc = { type: "FeatureCollection", validTimes: ["20261004_0100"], issueTime: "20261003_2100", canTimes: [], features: [
    { type: "Feature", properties: { validTime: "20261004_0100", issueTime: "20261003_2100", coverage: "sparse", confidence: "high", tops: "390", labelpos: [-98.6, 30.1], data: "tcf" },
      geometry: { type: "Polygon", coordinates: [[[-96.7, 30.3], [-96.2, 30.6], [-95.1, 30.8], [-93.9, 31.4], [-92.3, 31.6], [-91.7, 31.3], [-91.8, 30.9], [-92.7, 31], [-93.5, 30.8], [-94.1, 30], [-94.8, 29.2], [-95.8, 28.9], [-97, 29.2], [-96.9, 29.7], [-96.7, 30.3]]] } },
  ] };
  const out = tcfAt(-95.34, 29.98, fc, new Date("2026-10-03T22:17:00Z")); // IAH
  assert.deepEqual(out.map((x) => [x.valid, x.coverage, x.coverageRaw, x.confidence, x.tops]), [["2026-10-04T01:00:00.000Z", "low", "sparse", "high", "390"]]);
  assert.equal(out[0].props.labelpos, undefined);
});

test("CWA (real AWC format): string coords, epoch-second times, rawText", () => {
  const rec = { cwsu: "ZJX", name: "Jacksonville", receiptTime: "2026-10-03T22:07:20.864Z", validTimeFrom: 1791065220, validTimeTo: 1791072420, seriesId: "502", hazard: "TS", qualifier: "EMBD", base: null, top: 38000, geom: null,
    coords: [{ lat: "34.641", lon: "-80.160" }, { lat: "33.200", lon: "-77.287" }, { lat: "31.328", lon: "-81.110" }, { lat: "31.892", lon: "-82.926" }, { lat: "34.641", lon: "-80.160" }],
    rawText: "FAUS25 KZJX 032207\nZJX5 CWA 032207 \nZJX CWA 502 VALID UNTIL 040007" };
  const out = cwaAt(-81.2, 32.13, [rec], new Date("2026-10-03T22:17:00Z")); // Savannah, inside
  assert.deepEqual(out, [{ hazard: "TS", validFrom: "2026-10-03T22:07:00.000Z", validTo: "2026-10-04T00:07:00.000Z", raw: rec.rawText }]);
  assert.deepEqual(cwaAt(-80.94, 35.21, [rec], new Date("2026-10-03T22:17:00Z")), []); // CLT, outside
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

test("advisory extension outlook: preserve published words, never infer a percentage", () => {
  for (const [raw, expected] of [["HIGH", "high"], ["medium (30-60%)", "medium"], ["LOW", "low"], ["NONE", "none"], ["30-60%", null], ["UNKNOWN", null]]) {
    assert.equal(parseAdvisory(GS + "\nPROBABILITY OF EXTENSION: " + raw, { now: NOW }).extension, expected);
  }
  assert.equal(parseAdvisory(GS, { now: NOW }).extension, null);
});

// Real PHJH block (history branch raw/latest/lamp-airports.txt, 2026-10-05 2230Z) with missing values written as 9s:
// "22999999…" in WGS used to read as a 999-kt gust.
test("LAMP (real bulletin): missing-value sentinels (99/999) are null, never a 999-kt gust", async () => {
  const text = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/lamp-missing.txt"), "utf8");
  const h = parseLamp(text).stations.PHJH.hours;
  assert.deepEqual(h.map((x) => x.gust), [24, 23, 24, 24, 22, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, 0, 0, 0, 0, 0]);
  assert.ok(h.every((x) => x.gust == null || x.gust < 99));
  assert.deepEqual(h.slice(0, 3).map((x) => x.pPrecip), [1, 1, 2]);
  assert.ok(h.every((x) => x.cig === 8 && x.vis === 7));
  // every numeric row: a 999 cell and out-of-range categories are null; a real 99% probability stays
  const blk = [" KXYZ   GFS LAMP GUIDANCE  10/05/2026  2230 UTC", " UTC  23 00 01", " WGS  99999 25", " PPO 999 99100", " CIG  99  8  0", " VIS  99  7 12", " LP1 999 40  5"].join("\n");
  const x = parseLamp(blk).stations.KXYZ.hours;
  assert.deepEqual(x.map((r) => r.gust), [null, null, 25]);
  assert.deepEqual(x.map((r) => r.pPrecip), [null, 99, 100]);
  assert.deepEqual(x.map((r) => r.cig), [null, 8, null]);
  assert.deepEqual(x.map((r) => r.vis), [null, 7, null]);
  assert.deepEqual(x.map((r) => r.tstmProb), [null, 40, 5]);
});

// ATCSCC (Oct 5 live samples): advADB.jsp now shows only the most recent advisory (the operations plan) with one
// link, "Advisories Database Selection Form" (followed 0, parsed 0). Its form submits GET /adv/adv_list.
const fx = (f) => readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", f), "utf8");
test("ATCSCC: the advisory list (adv_list) is read row by row; the newest program per airport is followed; the real detail parses", async () => {
  const LIVE = new Date("2026-10-05T20:00:00Z");
  assert.match(atcsccListUrl(LIVE), /^https:\/\/www\.fly\.faa\.gov\/adv\/adv_list\?whichAdvisories=ATCSCC&advisoryCategory=NotAll&date=2026-10-05&gStop=true/);
  const list = await fx("atcscc-list-real.html");
  assert.equal(isAdvisoryList(list), true);
  const links = atcsccLinks(list, "https://www.fly.faa.gov/adv/adv_list");
  const bos = links.find((l) => /advn=64\b/.test(l.href));
  assert.equal(bos.href, "https://www.fly.faa.gov/adv/adv_otherdis?adv_date=10052026&advn=64");
  assert.match(bos.title, /^064 BOS\/ZBW 10\/05\/26 CDM GROUND STOP 10\/05\/26 19:43$/);
  const detail = await fx("atcscc-detail-real.html");
  const seen = [];
  const r = await collectAtcscc("<html>most recent advisory</html>", async (url) => { seen.push(url); return /advn=64\b/.test(url) ? detail : "<html></html>"; },
    { base: "https://www.fly.faa.gov/adv/adv_list", lists: [list], now: LIVE });
  assert.equal(r.listed, 1); assert.equal(r.degraded, false);
  assert.ok(seen.some((u) => /advn=64\b/.test(u)));
  assert.ok(!seen.some((u) => /advn=43\b/.test(u)), "DEN's older ground stop: only the newest (its CNX) is followed");
  assert.ok(!links.filter((l) => /PROPOSED/.test(l.title)).some((l) => seen.includes(l.href)), "proposed programs are not followed");
  const gs = r.list.find((a) => a.airport === "BOS" && a.type === "GS");
  assert.equal(gs.cause, "runway"); assert.equal(gs.causeText, "RWY-TAXI / CONSTRUCTION");
  assert.equal(gs.end, "2026-10-05T20:45:00.000Z"); assert.equal(gs.active, true);
  assert.equal(advType("CDM PROPOSED GROUND DELAY PROGRAM"), "other");
});
test("ATCSCC: a page with no followable advisories and no recognised list is degraded; a quiet list is not", async () => {
  const page = await fx("atcscc.html");
  const r = await collectAtcscc(page, async () => "", { now: NOW });
  assert.deepEqual([r.followed, r.list.length, r.listed, r.degraded], [0, 0, 0, true]);
  const quiet = await collectAtcscc(page, async () => "", { now: NOW, lists: [await fx("atcscc-list.html")] });
  assert.deepEqual([quiet.followed, quiet.listed, quiet.degraded], [0, 1, false]);
  const failedList = await collectAtcscc(page, async () => "", { now: NOW, lists: [null, "<html>Service unavailable</html>"] });
  assert.equal(failedList.degraded, true);
});
