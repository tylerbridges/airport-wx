import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessConditions } from "../poller/risk.mjs";
import {
  HOUR, parseCsv, parseCsvLine, findCol, parseTime, localToUtc, localHourOf, phenomena, scores, newCt, addCt, ctOf,
  climoCt, metarsFromIemCsv, hourlyTruth, tafsFromIemCsv, btsIndex, btsAdd, btsTruth, isDisrupted, replayAirport, bundle,
} from "./backtest-lib.mjs";
import { run, lastCompleteMonths } from "./backtest.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("CSV: quotes, escaped quotes, embedded commas/newlines, trailing comma, comments", () => {
  assert.deepEqual(parseCsvLine('"a","b, c",3,,"x""y",'), ["a", "b, c", "3", "", 'x"y', ""]);
  assert.deepEqual(parseCsvLine("a,b"), ["a", "b"]);
  assert.deepEqual(parseCsvLine('"0600"'), ["0600"]);
  const rows = parseCsv('#DEBUG line\nstation,valid,raw\r\nKMSP,2026-07-14 11:20,"TAF KMSP 141120Z\n  FM141800 x"\n\n');
  assert.deepEqual(rows, [["station", "valid", "raw"], ["KMSP", "2026-07-14 11:20", "TAF KMSP 141120Z\n  FM141800 x"]]);
  assert.equal(findCol([" Station ", "VALID"], ["valid"]), 1);
  assert.equal(findCol(["a"], ["b"]), -1);
});

test("time parsing and local hour <-> UTC across DST", () => {
  assert.equal(parseTime("2026-07-14 11:20"), Date.parse("2026-07-14T11:20:00Z"));
  assert.equal(parseTime("2026-07-14 11:20:00+00"), Date.parse("2026-07-14T11:20:00Z"));
  assert.equal(parseTime("2026-07-14T11:20:00Z"), Date.parse("2026-07-14T11:20:00Z"));
  assert.equal(parseTime("M"), null);
  assert.equal(localToUtc("2026-07-14", 15, "America/Chicago"), Date.parse("2026-07-14T20:00:00Z")); // CDT
  assert.equal(localToUtc("2026-01-14", 15, "America/Chicago"), Date.parse("2026-01-14T21:00:00Z")); // CST
  assert.equal(localToUtc("2026-07-14", 6, "America/Phoenix"), Date.parse("2026-07-14T13:00:00Z"));
  assert.equal(localToUtc("2026-07-14", 6, "Pacific/Honolulu"), Date.parse("2026-07-14T16:00:00Z"));
  assert.equal(localToUtc("2026-03-08", 6, "America/New_York"), Date.parse("2026-03-08T10:00:00Z")); // after spring-forward
  assert.equal(localHourOf(Date.parse("2026-07-14T20:00:00Z"), "America/Chicago"), 15);
  assert.deepEqual(lastCompleteMonths(2, new Date("2026-10-03T00:00:00Z")), ["2026-08", "2026-09"]);
  assert.deepEqual(lastCompleteMonths(1, new Date("2026-01-15T00:00:00Z")), ["2025-12"]);
});

test("contingency scores: POD, FAR, CSI, bias", () => {
  const s = scores({ a: 30, b: 10, c: 20, d: 40 });
  close(s.pod, 30 / 50);
  close(s.far, 10 / 40);
  close(s.csi, 30 / 60);
  close(s.bias, 40 / 50);
  close(s.base, 50 / 100);
  assert.equal(s.n, 100);
  const none = scores(newCt());
  assert.equal(none.pod, null);
  assert.equal(none.csi, null);
  const ct = newCt();
  addCt(ct, true, true); addCt(ct, true, false); addCt(ct, false, true); addCt(ct, false, false); addCt(ct, false, false);
  assert.deepEqual(ct, { a: 1, b: 1, c: 1, d: 2 });
  assert.deepEqual(ctOf([1, 2, 3, 4], (x) => x >= 3, (x) => x % 2 === 0), { a: 1, b: 1, c: 1, d: 1 });
});

test("climatology = expected scores of a random forecast at each stratum's frequency", () => {
  // stratum A: 4 records, 1 event (p = .25); stratum B: 2 records, 0 events
  const recs = [
    { ap: "X", lh: 1, e: true }, { ap: "X", lh: 1, e: false }, { ap: "X", lh: 1, e: false }, { ap: "X", lh: 1, e: false },
    { ap: "X", lh: 2, e: false }, { ap: "X", lh: 2, e: false },
  ];
  const ct = climoCt(recs, (r) => r.e);
  close(ct.a, 0.25); close(ct.b, 0.75); close(ct.c, 0.75); close(ct.d, 2.25 + 2);
  const s = scores(ct);
  close(s.pod, 0.25); close(s.bias, 1); close(s.csi, 0.25 / 1.75);
});

test("phenomena() matches every risk.mjs reason text it relies on", () => {
  const ph = (c) => phenomena(assessConditions(c));
  assert.equal(ph({ wxString: "VCTS" }).ts, true);
  assert.equal(ph({ wxString: "+TSRA", wgst: 50 }).g35, true);
  assert.equal(ph({ wxString: "-FZRA" }).fz, true);
  assert.equal(ph({ wxString: "FZDZ" }).fz, true);
  assert.equal(ph({ wxString: "PL" }).fz, true);
  assert.equal(ph({ wxString: "FZFG" }).fz, false);
  assert.equal(ph({ wxString: "-SN" }).sn, true);
  assert.equal(ph({ wxString: "SN", visib: 0.25 }).ifr, true);
  assert.equal(ph({ visib: 2.5 }).ifr, true);
  assert.equal(ph({ visib: 3 }).ifr, false);
  assert.equal(ph({ visib: "1 1/2" }).ifr, true);
  assert.equal(ph({ clouds: [{ cover: "OVC", base: 900 }] }).ifr, true);
  assert.equal(ph({ clouds: [{ cover: "BKN", base: 1000 }] }).ifr, false);
  assert.equal(ph({ clouds: [{ cover: "OVC", base: 1000 }], visib: 4 }).ifr, false);
  assert.deepEqual([ph({ wgst: 25 }).g25, ph({ wgst: 25 }).g35, ph({ wgst: 24 }).g25, ph({ wgst: 36 }).g35], [true, false, false, true]);
  assert.equal(phenomena([{ text: "Chance of ceiling 400 ft", level: 2 }]).ifr, true);
  assert.equal(phenomena([{ text: "Chance of thunderstorms", level: 2 }]).ts, true);
});

const METAR_CSV = `station,valid,vsby,sknt,gust,skyc1,skyc2,skyc3,skyl1,skyl2,skyl3,wxcodes,metar
MSP,2026-07-14 20:13,2.00,18,38,SCT,BKN,M,2500,4000,M,+TSRA BR,SPECI KMSP 142013Z 27018G38KT 2SM +TSRA BR SCT025 BKN040 24/19 A2990 RMK AO2
MSP,2026-07-14 20:53,10.00,9,M,FEW,M,M,5000,M,M,M,KMSP 142053Z 18009KT 10SM FEW050 24/19 A2990 RMK AO2 TSE40
MSP,2026-07-14 21:53,M,9,M,M,M,M,M,M,M,M,KMSP 142153Z 18009KT 1/2SM FG VV002 24/19 A2990
`;

test("IEM METAR CSV -> observations and hourly truth (max over the hour)", () => {
  const { obs, diag } = metarsFromIemCsv(METAR_CSV);
  assert.equal(obs.length, 3);
  assert.deepEqual(diag.stations, ["MSP"]);
  assert.equal(obs[0].lvl, 4); // +TS
  assert.equal(obs[1].lvl, 0); // TSE40 is a remark, not current weather
  assert.equal(obs[2].cond.visib, 0.5); // from the raw METAR when vsby is missing
  assert.equal(obs[2].ph.ifr, true);
  const tr = hourlyTruth(obs);
  const h20 = tr.get(Date.parse("2026-07-14T20:00:00Z"));
  assert.deepEqual([h20.lvl, h20.n, h20.ph.ts, h20.ph.g35], [4, 2, true, true]);
  assert.equal(tr.get(Date.parse("2026-07-14T21:00:00Z")).lvl, 3);
});

test("IEM TAF CSV: whole-TAF rows, per-group rows without header, and decoded-column fallback", () => {
  const whole = 'station,valid,raw\nKMSP,2026-07-14 11:20,"TAF KMSP 141120Z 1412/1518 18010KT P6SM SCT050\n FM141800 20015G25KT P6SM BKN040"\n';
  const a = tafsFromIemCsv(whole);
  assert.equal(a.tafs.length, 1);
  assert.equal(a.tafs[0].issueMs, Date.parse("2026-07-14T11:20:00Z"));
  assert.equal(a.tafs[0].fcsts.length, 2);

  const groups = [
    "station,valid,fx_valid,raw,is_tempo,end_valid",
    "KDFW,2026-07-14 11:20,2026-07-14 12:00,17012KT P6SM SCT045,false,2026-07-15 18:00",
    "KDFW,2026-07-14 11:20,2026-07-14 20:00,TEMPO 1420/1424 3SM TSRA BKN030CB,true,2026-07-15 18:00",
    "KDFW,2026-07-14 11:20,2026-07-15 03:00,FM150300 16010KT P6SM BKN012,false,2026-07-15 18:00",
    "KDFW,2026-07-14 17:20,2026-07-14 18:00,17012KT P6SM SCT045,false,2026-07-16 00:00",
  ].join("\n");
  const b = tafsFromIemCsv(groups);
  assert.equal(b.tafs.length, 2);
  const t = b.tafs[0];
  assert.deepEqual(t.fcsts.map((f) => f.fcstChange), [null, "TEMPO", "FM"]);
  assert.equal(t.validTimeFrom, Date.parse("2026-07-14T11:00:00Z") / 1000);
  assert.equal(t.validTimeTo, Date.parse("2026-07-15T18:00:00Z") / 1000);
  assert.equal(b.tafs[1].validTimeTo, Date.parse("2026-07-16T00:00:00Z") / 1000);
  assert.equal(b.diag.fromRaw, 2);

  const cols = [
    "station,valid,fx_valid,fx_valid_end,is_tempo,sknt,drct,gust,visibility,presentwx,skyc,skyl",
    'KORD,2026-07-14 11:20,2026-07-14 12:00,2026-07-15 18:00,false,10,180,,6,,"{SCT}","{5000}"',
    'KORD,2026-07-14 11:20,2026-07-14 20:00,2026-07-14 23:00,true,,,,2,"{TSRA}","{BKN}","{2500}"',
  ].join("\n");
  const c = tafsFromIemCsv(cols);
  assert.equal(c.diag.fromColumns, 1);
  assert.deepEqual(c.tafs[0].fcsts.map((f) => f.fcstChange), [null, "TEMPO"]);
  assert.equal(c.tafs[0].fcsts[1].wxString, "TSRA");
  assert.deepEqual(c.tafs[0].fcsts[1].clouds, [{ cover: "BKN", base: 2500, type: null }]);
});

test("BTS: disruption rule per local scheduled hour", () => {
  const header = parseCsvLine('"FlightDate","Origin","Dest","CRSDepTime","DepDelay","ArrDelay","Cancelled","CancellationCode","WeatherDelay","NASDelay",');
  const { idx, missing } = btsIndex(header);
  assert.deepEqual(missing, []);
  const acc = new Map();
  const wanted = new Set(["MSP"]);
  const add = (line) => btsAdd(acc, parseCsvLine(line), idx, wanted);
  // 15:xx local: 10 departures, 2 delayed with NAS minutes (20%) -> disrupted
  for (let k = 0; k < 8; k++) add(`2026-07-14,"MSP","ORD","15${k}0",-2.00,-5.00,0.00,,,,`);
  add('2026-07-14,"MSP","ORD","1510",40.00,35.00,0.00,,0.00,35.00,');
  add('2026-07-14,"MSP","ORD","1520",40.00,35.00,0.00,,0.00,35.00,');
  // 16:xx: 10 departures, 1 delayed by weather (10%) and a carrier-delayed one -> not disrupted
  for (let k = 0; k < 8; k++) add(`2026-07-14,"MSP","ORD","16${k}0",0.00,0.00,0.00,,,,`);
  add('2026-07-14,"MSP","ORD","1610",30.00,30.00,0.00,,30.00,0.00,');
  add('2026-07-14,"MSP","ORD","1620",30.00,30.00,0.00,,0.00,0.00,');
  // 17:xx: 19 departures, 1 weather cancellation (5.3%) -> disrupted
  for (let k = 0; k < 18; k++) add(`2026-07-14,"MSP","ORD","17${String(k).padStart(2, "0")}",0.00,0.00,0.00,,,,`);
  add('2026-07-14,"MSP","ORD","1759",,,1.00,"B",,,');
  // 18:xx: 4 departures only -> ignored; other airport ignored
  for (let k = 0; k < 4; k++) add(`2026-07-14,"MSP","ORD","18${k}0",90.00,90.00,0.00,,90.00,0.00,`);
  assert.equal(add('2026-07-14,"ORD","MSP","1500",90.00,90.00,0.00,,90.00,0.00,'), false);
  const tr = btsTruth(acc, { MSP: "America/Chicago" });
  const at = (h) => tr.get(`MSP|${Date.parse(`2026-07-14T${h}:00:00Z`)}`);
  assert.equal(at(20).disrupted, true);
  assert.equal(at(21).disrupted, false);
  assert.equal(at(22).disrupted, true);
  assert.equal(at(23), undefined);
  assert.equal(isDisrupted({ n: 4, dly: 4, cxlWx: 0 }), null);
});

test("replay picks the latest TAF issued at or before H - lead and scores bundles", () => {
  const mk = (iss, raw) => tafsFromIemCsv(`station,valid,raw\nKMSP,${iss},"${raw}"\n`).tafs[0];
  const tafs = [
    mk("2026-07-14 05:20", "TAF KMSP 140520Z 1406/1512 18010KT P6SM SCT050"),
    mk("2026-07-14 11:20", "TAF KMSP 141120Z 1412/1518 18010KT 2SM -SN OVC008"),
  ];
  const { obs } = metarsFromIemCsv(METAR_CSV);
  const truth = hourlyTruth(obs);
  const start = Date.parse("2026-07-14T00:00:00Z");
  const recs = replayAirport({ iata: "MSP", tz: "America/Chicago", tafs, obs, truth, disruption: null, start, end: start + 48 * HOUR });
  const r20 = recs.filter((r) => r.H === Date.parse("2026-07-14T20:00:00Z"));
  const by = Object.fromEntries(r20.map((r) => [r.b, r]));
  close(by["0-3"].leadH, 8 + 40 / 60); // 11:20 TAF
  assert.equal(by["0-3"].fLvl, 2);
  close(by["12-24"].leadH, 14 + 40 / 60); // 05:20 TAF (latest issued <= 08:00)
  assert.equal(by["12-24"].fLvl, 0);
  assert.equal(by["0-3"].pLvl, null); // no METAR within 3 h before 11:20
  const B = bundle(recs.filter((r) => r.b === "0-3"));
  assert.equal(B.level.n, 2);
  assert.equal(B.level.confusion[2][4], 1); // forecast Moderate, observed Severe
  assert.equal(B.level.confusion[2][3], 1);
  assert.equal(B.level.ge2.taf.pod, 1);
  assert.equal(B.disruption.n, 0);
});

test("fixture run writes the report, JSON and samples", async () => {
  const out = await mkdtemp(join(tmpdir(), "bt-"));
  try {
    const { report, files } = await run({ fixtures: true, months: null, monthsCount: 2, bts: [], airports: "all", out, date: "2026-10-03" });
    assert.deepEqual(report.airportsUsed, ["DFW", "MSP"]);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.bts.available, true);
    assert.ok(report.counts.records > 400);
    assert.equal(report.counts.tafFailed, 0);
    const md = await readFile(files[0], "utf8");
    assert.match(md, /FIXTURE RUN/);
    assert.match(md, /Reliability/);
    const json = JSON.parse(await readFile(files[1], "utf8"));
    assert.ok(json.metrics.buckets["0-3"].overall.level.ge2.taf.csi > 0);
    for (const s of ["iem-taf.csv", "iem-metar.csv", "bts-header.csv"]) assert.ok((await readFile(join(out, "samples", s), "utf8")).length > 50);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
