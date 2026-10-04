// Delay model training (tools/train-lib.mjs, tools/train-data.mjs): BTS and IEM parsing, the target,
// the logistic fit, isotonic calibration, metrics, the time split, program rates and the safety gate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  btsIndex2, btsAdd2, truthFromAcc, sideReal, mergeAcc, accEntries, fitLogistic, predictRows, isotonicFit, brier, auc, reliability, gate,
  timeSplit, programRates, lampFromIemCsv, lampLookup, climatology, airportRecords, buildRows, buildAnalogs, median,
  TOP_HUBS, programIndex, volumeTable, volumeFor, validationBlock, familyOf, calibrationSummary, groupOf, AIRPORT_GROUPS,
} from "./train-lib.mjs";
import { aggregateBts, chunks } from "./train-data.mjs";
import { parseCsv, parseCsvLine, tafsFromIemCsv } from "./backtest-lib.mjs";
import { tafSummary, calibrate, dayType, encode, hubPack, cascadeOf, hourOfWeek, FEATS, modelOk } from "../poller/delay.mjs";
import { TOP_ROUTES } from "../poller/hubs.mjs";
import { fixtureWorld } from "./train-fixtures.mjs";
import { train, renderMarkdown, currentModelCheck, parseFeatures } from "./train.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures/train");
const HOUR = 3600e3;
const HEAD = '"FlightDate","Origin","Dest","CRSDepTime","DepDelay","CRSArrTime","ArrDelay","Cancelled","CancellationCode","Diverted","CarrierDelay","WeatherDelay","NASDelay"';
async function* linesOf(text) { for (const l of text.split("\n")) yield l; }

test("BTS: the real On-Time header has every column; departures and arrivals are both kept", async () => {
  const text = await readFile(join(FX, "bts-sample.csv"), "utf8");
  const r = await aggregateBts(linesOf(text), new Set(["DTW", "MKE"]));
  assert.equal(r.rows, 2);
  assert.equal(r.kept, 4); // each flight: a departure and an arrival
  const keys = r.entries.map((e) => e[0]).sort();
  assert.deepEqual(keys, ["DTW|2026-06-16|19", "DTW|2026-06-17|15", "MKE|2026-06-16|16", "MKE|2026-06-17|16"]);
  await assert.rejects(aggregateBts(linesOf('"FlightDate","Origin"\n2026-06-01,MSP\n'), new Set(["MSP"])), /columns missing/);
});

test("BTS: late, weather/NAS-caused, cancellations B/C, next-day arrival", () => {
  const { idx, missing } = btsIndex2(parseCsvLine(HEAD));
  assert.deepEqual(missing, []);
  const acc = new Map();
  const rows = [
    "2026-01-05,ORD,MSP,1705,45.00,1830,50.00,0.00,,0.00,,10.00,40.00", // late with weather+NAS
    "2026-01-05,ORD,MSP,1710,20.00,1835,22.00,0.00,,0.00,22.00,0.00,0.00", // late, carrier only
    "2026-01-05,ORD,MSP,1715,-3.00,1840,-8.00,0.00,,0.00,,,", // on time
    "2026-01-05,ORD,MSP,1720,,1845,,1.00,B,0.00,,,", // weather cancellation
    "2026-01-05,ORD,MSP,1725,,1850,,1.00,A,0.00,,,", // carrier cancellation: counted, not weather
    "2026-01-05,ORD,DEN,2350,5.00,0105,3.00,0.00,,0.00,,,", // arrives next day
    "2026-01-05,XXX,YYY,1000,5.00,1100,0.00,0.00,,0.00,,,", // neither airport wanted
  ];
  let kept = 0;
  for (const l of rows) kept += btsAdd2(acc, parseCsvLine(l), idx, new Set(["ORD", "MSP", "DEN"]));
  assert.equal(kept, 12);
  const dep = acc.get("ORD|2026-01-05|17").d;
  assert.deepEqual(dep.slice(0, 6), [5, 2, 1, 1, 65, 3]); // n, late, late wx/NAS, wx cancels, sum delay, operated
  assert.deepEqual(dep[6], [45, 20]);
  assert.ok(acc.get("DEN|2026-01-06|1").a, "23:50 departure arriving 01:05 lands the next day");
  // merging month files keeps the minutes
  const m = mergeAcc(new Map(), accEntries(acc));
  mergeAcc(m, accEntries(acc));
  assert.equal(m.get("ORD|2026-01-05|17").d[0], 10);
});

test("target: >= 25% late with weather/NAS cause or >= 5% weather/NAS cancellations; < 5 flights skipped", () => {
  assert.equal(sideReal({ n: 8, lateWx: 0.25, cx: 0 }), true);
  assert.equal(sideReal({ n: 8, lateWx: 0.24, cx: 0 }), false);
  assert.equal(sideReal({ n: 20, lateWx: 0, cx: 0.05 }), true);
  assert.equal(sideReal({ n: 4, lateWx: 1, cx: 1 }), null);
  const { idx } = btsIndex2(parseCsvLine(HEAD));
  const acc = new Map();
  const add = (l) => btsAdd2(acc, parseCsvLine(l), idx, new Set(["ORD", "MSP"]));
  for (let k = 0; k < 6; k++) add(`2026-07-14,ORD,MSP,1600,${k < 2 ? 40 : 0}.00,1730,${k < 2 ? 42 : 0}.00,0.00,,0.00,,0.00,${k < 2 ? 42 : 0}.00`);
  for (let k = 0; k < 3; k++) add("2026-07-14,ORD,MSP,1100,0.00,1230,0.00,0.00,,0.00,,,"); // too few flights
  const t = truthFromAcc(acc, { ORD: "America/Chicago", MSP: "America/Chicago" });
  const ord = t.get(`ORD|${Date.UTC(2026, 6, 14, 21)}`);
  assert.equal(ord.y, 1); // 2 of 6 departures late with NAS cause = 33%
  assert.equal(ord.dm, 40);
  assert.equal(ord.dep.n, 6);
  assert.equal(t.get(`ORD|${Date.UTC(2026, 6, 14, 16)}`), undefined);
  const msp = t.get(`MSP|${Date.UTC(2026, 6, 14, 22)}`); // arrivals 17:30 local
  assert.equal(msp.arr.n, 6);
  assert.equal(msp.y, 1);
});

test("IEM taf.py row-per-group CSV (real sample) -> TAFs valid 30 h, scored per hour", async () => {
  const text = await readFile(join(FX, "iem-taf-rows.csv"), "utf8");
  const r = tafsFromIemCsv(text, { station: "KATL" });
  assert.equal(r.tafs.length, 2);
  const t = r.tafs[0];
  assert.equal(t.validTimeFrom * 1000, Date.UTC(2026, 4, 30, 19));
  assert.equal(t.validTimeTo * 1000, Date.UTC(2026, 4, 31, 19) + 6 * HOUR); // 30 h, not cut at the last TEMPO/PROB end
  const w = tafSummary(t, Date.UTC(2026, 4, 30, 21), null); // TEMPO 3020/3023 TSRA
  assert.equal(w.t, 2);
  const late = tafSummary(t, Date.UTC(2026, 4, 31, 12), null); // FM311100 BKN005 (after the last PROB group)
  assert.ok(late && late.c === 500 && late.fc === 2);
  assert.equal(tafSummary(t, Date.UTC(2026, 4, 30, 23), null).t, 0, "PROB30 starts at 00Z");
  assert.equal(tafSummary(t, Date.UTC(2026, 4, 31, 1), null).t, 1);
});

test("LAMP (assumed IEM mos.py columns): latest run at or before the forecast time", () => {
  const rows = parseCsv("station,model,runtime,ftime,lp1,cp1\nKORD,LAV,2026-07-14 12:00,2026-07-14 18:00,20,40\nKORD,LAV,2026-07-14 15:00,2026-07-14 18:00,45,60\nKORD,LAV,2026-07-14 15:00,2026-07-14 19:00,M,M\n");
  const { byTime, diag } = lampFromIemCsv(rows);
  assert.equal(diag.used, 2);
  assert.deepEqual(lampLookup(byTime, Date.UTC(2026, 6, 14, 17), Date.UTC(2026, 6, 14, 16)), { lp: 45, cp: 60, lc: null, lv: null });
  assert.deepEqual(lampLookup(byTime, Date.UTC(2026, 6, 14, 17), Date.UTC(2026, 6, 14, 13)), { lp: 20, cp: 40, lc: null, lv: null });
  assert.equal(lampLookup(byTime, Date.UTC(2026, 6, 14, 18), Date.UTC(2026, 6, 14, 16)), null);
  assert.equal(lampFromIemCsv(parseCsv("a,b\n1,2\n")).byTime.size, 0);
});

test("logistic fit recovers known coefficients on synthetic data (incl. a continuous input)", () => {
  let s = 12345;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const truth = { b0: -1.5, wc: 0.8, w: [1.2, -0.7, 0.5] };
  const N = 40000;
  const off = new Uint32Array(N + 1);
  const idx = [];
  const xc = new Float64Array(N);
  const y = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let z = truth.b0;
    xc[i] = rand() * 2 - 1;
    z += truth.wc * xc[i];
    for (let j = 0; j < 3; j++) if (rand() < 0.3) { idx.push(j); z += truth.w[j]; }
    off[i + 1] = idx.length;
    y[i] = rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0;
  }
  const rows = Uint32Array.from({ length: N }, (_, i) => i);
  const fit = fitLogistic({ off, idx: Uint16Array.from(idx), xc, y, rows, V: 3, lambda: 0.01 });
  assert.ok(Math.abs(fit.b0 - truth.b0) < 0.1, `b0 ${fit.b0}`);
  assert.ok(Math.abs(fit.wc - truth.wc) < 0.1, `wc ${fit.wc}`);
  fit.w.forEach((v, j) => assert.ok(Math.abs(v - truth.w[j]) < 0.1, `w${j} ${v}`));
  // a strong penalty shrinks toward 0 (airport intercepts shrink toward the global one)
  const shrunk = fitLogistic({ off, idx: Uint16Array.from(idx), xc, y, rows, V: 3, lambda: 1e5 });
  assert.ok(Math.abs(shrunk.w[0]) < 0.2);
  const p = predictRows({ off, idx: Uint16Array.from(idx), xc, rows, fit });
  assert.ok(auc(p, y) > 0.65);
});

test("isotonic calibration is monotone and calibrated in-sample", () => {
  let s = 7;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const p = [];
  const y = [];
  for (let i = 0; i < 20000; i++) { const x = rand(); p.push(x); y.push(rand() < x * x ? 1 : 0); } // over-confident raw scores
  const cal = isotonicFit(p, y, { maxKnots: 40 });
  assert.ok(cal.x.length <= 40);
  for (let k = 1; k < cal.x.length; k++) { assert.ok(cal.x[k] > cal.x[k - 1]); assert.ok(cal.y[k] >= cal.y[k - 1]); }
  let prev = -1;
  for (let v = 0; v <= 1; v += 0.005) { const c = calibrate(cal, v); assert.ok(c >= prev - 1e-12); prev = c; }
  assert.ok(Math.abs(calibrate(cal, 0.5) - 0.25) < 0.05);
  const after = p.map((v) => calibrate(cal, v));
  assert.ok(brier(after, y) < brier(p, y));
});

test("metrics: brier, auc (ties), reliability bins", () => {
  assert.equal(brier([0, 1], [0, 1]), 0);
  assert.equal(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(auc([0.5, 0.5], [0, 1]), 0.5);
  assert.equal(auc([0.5, 0.6], [1, 1]), null);
  const r = reliability([0.05, 0.15, 0.95], [0, 1, 1]);
  assert.equal(r.length, 10);
  assert.deepEqual([r[0].n, r[1].rate, r[9].k], [1, 1, 1]);
  assert.equal(median([3, 1, 2, 10]), 2.5);
});

test("time split: newest 4 months, reaching back to include a winter month", () => {
  const ms = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) ms.push(`${y}-${String(m).padStart(2, "0")}`);
  const upToJul = ms.filter((m) => m >= "2024-08" && m <= "2026-07");
  const s = timeSplit(upToJul);
  assert.deepEqual(s.test, ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  assert.equal(s.train[s.train.length - 1], "2026-01");
  assert.ok(s.winterInTest);
  const upToJan = ms.filter((m) => m >= "2024-02" && m <= "2026-01");
  assert.deepEqual(timeSplit(upToJan).test, ["2025-10", "2025-11", "2025-12", "2026-01"]);
  const short = timeSplit(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
  assert.equal(short.winterInTest, false);
  assert.ok(short.train.length >= 3);
});

test("safety gate: deploy only with skill over climatology AND better than the rule mapping", () => {
  const t = (bm, bc, br, n = 5000) => ({ n, brier: { model: bm, climo: bc, rule: br }, bss: { climo: 1 - bm / bc } });
  assert.equal(gate(t(0.12, 0.14, 0.13)).pass, true);
  const noSkill = gate(t(0.15, 0.14, 0.16));
  assert.equal(noSkill.pass, false);
  assert.match(noSkill.reasons.join(" "), /climatology/);
  const loses = gate(t(0.13, 0.14, 0.125));
  assert.equal(loses.pass, false);
  assert.match(loses.reasons.join(" "), /rule-level mapping/);
  assert.equal(gate(t(0.12, 0.14, 0.13, 50)).pass, false);
  assert.equal(gate(null).pass, false);
});

test("program rates from the history log: possible ground stops that became real ones", async () => {
  const lines = JSON.parse(await readFile(join(FX, "history-truth.json"), "utf8"));
  const r = programRates(lines);
  assert.deepEqual(r.GS, { n: 5, k: 3, rate: 0.6 });
  assert.equal(r.GDP.rate, null); // fewer than 5 cases
});

test("records, climatology, rows and analogs from the synthetic world", async () => {
  const world = fixtureWorld({ months: ["2025-07"] });
  const text = world.bts("2025-07");
  const agg = await aggregateBts(linesOf(text), new Set(["ORD", "MSP", "DEN", "EWR"]));
  const acc = mergeAcc(new Map(), agg.entries);
  const truth = truthFromAcc(acc, { ORD: "America/Chicago", MSP: "America/Chicago", DEN: "America/Denver", EWR: "America/New_York" });
  const ordTruth = new Map([...truth].filter(([k]) => k.startsWith("ORD|")).map(([k, v]) => [Number(k.split("|")[1]), v]));
  const from = Date.UTC(2025, 6, 1);
  const to = Date.UTC(2025, 7, 1);
  const tafs = tafsFromIemCsv(world.taf("KORD", from, to), { station: "KORD" }).tafs;
  assert.ok(tafs.length > 100);
  const recs = airportRecords({ iata: "ORD", tz: "America/Chicago", tafs, obs: [], truth: ordTruth, start: from, end: to });
  assert.ok(recs.length > 300);
  assert.ok(recs.every((r) => r.f.length === 4 && (r.y === 0 || r.y === 1)));
  const c = climatology(recs);
  assert.equal(c.climo.ORD.length, 288);
  const rows = buildRows(recs);
  assert.ok(rows.n >= recs.length && rows.vocab.has("ap:ORD"));
  const an = buildAnalogs(recs);
  assert.ok(Object.values(an.ORD).every((v) => v[0] >= 15));
  assert.deepEqual(chunks(["2025-01", "2025-02", "2025-03", "2025-04"], 3).map((x) => x.label), ["2025-01..2025-03", "2025-04"]);
});

// ---------- model2: optional feature families, validation-block calibration, deployed-model gate ----------

test("day type: federal holidays (observed dates) and the days around Thanksgiving, Christmas, July 4", () => {
  const dt = (s) => dayType(...s.split("-").map(Number));
  assert.deepEqual(dt("2025-11-27"), { hol: true, pk: 0 }); // Thanksgiving
  assert.deepEqual([dt("2025-11-25").pk, dt("2025-11-26").pk, dt("2025-11-28").pk, dt("2025-11-29").pk, dt("2025-11-30").pk], [-1, -1, 1, 1, 0]);
  assert.equal(dt("2026-07-03").hol, true); // July 4 2026 is a Saturday: observed Friday
  assert.equal(dt("2026-07-03").pk, -1);
  assert.equal(dt("2027-12-31").hol, true); // Jan 1 2028 is a Saturday: observed the year before
  assert.equal(dt("2026-01-19").hol, true); // MLK: third Monday
  assert.equal(dt("2026-05-25").hol, true); // Memorial Day: last Monday
  assert.equal(dt("2026-10-12").hol, true); // Columbus Day: second Monday
  assert.deepEqual(dt("2026-03-11"), { hol: false, pk: 0 });
  assert.equal(dayType(2026, 13, 1), null);
  const names = encode({ ap: "ORD", lh: 17, dw: 3, mo: 11, y: 2025, d: 26, w: null, o: null, h: null }, "0-3", { daytype: true });
  assert.ok(names.includes("day:pre") && !names.includes("day:hol"));
});

test("hub cascade: packed hub TAF states -> counts and highest level; records carry f.hc", () => {
  assert.equal(cascadeOf([null, null]), null);
  const ts = hubPack({ t: 2, fc: 0, p: 0, g: 0, l: 3 });
  const ifr = hubPack({ t: 0, fc: 2, p: 0, g: 30, l: 2 });
  assert.deepEqual(cascadeOf([ts, ifr, null]), [2, 1, 0, 1, 0, 1, 3]);
  const n = encode({ ap: "MSP", lh: 15, dw: 2, mo: 7, w: null, o: null, h: null, hc: cascadeOf([ts, ts]) }, "3-6", { hubs: true });
  assert.ok(["hc:ts", "hc:ts|3-6", "hc:ts2", "hc:l3", "hc:l3|3-6"].every((k) => n.includes(k)));
  assert.ok(encode({ ap: "MSP", lh: 15, dw: 2, mo: 7, w: null, o: null, h: null, hc: null }, "0-3", { hubs: true }).includes("hc:none"));
  assert.deepEqual(TOP_HUBS.MSP, TOP_ROUTES.MSP.slice(0, 3), "the shared table (poller/hubs.mjs), top 3");
  assert.ok(Object.values(TOP_HUBS).every((l) => l.length <= 3));
  // airportRecords: cascadeMaps -> hc per bucket; HUBS bits stay the low 6 bits
  const H = Date.UTC(2025, 6, 10, 20);
  const truth = new Map([[H, { y: 1, md: 30, dm: 40, cx: 0, n: 20 }]]);
  const obs = [{ t: H - HOUR, cond: { visib: "10", clouds: [], wxString: "", wspd: 5 } }];
  const hub = new Map([[H, [ts, ts, null, null]]]);
  const recs = airportRecords({ iata: "MSP", tz: "America/Chicago", tafs: [], obs, truth, hubMaps: [hub], cascadeMaps: [hub, null], start: H - HOUR, end: H + HOUR });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].f[0].h, ts & 63);
  assert.deepEqual(recs[0].f[0].hc, [1, 1, 0, 0, 0, 0, 3]);
  assert.equal(recs[0].d, 10);
  // without cascadeMaps there is no hc at all (old datasets)
  assert.equal("hc" in airportRecords({ iata: "MSP", tz: "America/Chicago", tafs: [], obs, truth, hubMaps: [hub], start: H - HOUR, end: H + HOUR })[0].f[0], false);
});

test("FAA programs from the history log: state when the forecast is made, missing without a record", () => {
  const T = (s) => `2026-10-0${s}Z`;
  const lines = [
    { t: T("5T12:00"), airports: { EWR: { faa: [{ type: "ground_stop", cause: "weather" }], opsplan: { programs: [{ program: "GS", status: "possible", until: T("5T20:00") }], staffing: [{ facility: "N90", until: T("5T15:00"), cause: "staffing" }] } } }, opsplan: { plan: { advisory: "1" } } },
    { t: T("5T12:20"), airports: {} },
    { t: T("5T12:40"), down: ["faa"], airports: {} },
    { t: T("5T14:00"), airports: { ORD: { atcscc: [{ type: "GDP", active: true, cause: "staffing" }] } } },
    { t: T("6T15:00"), airports: {} },
  ];
  const idx = programIndex(lines);
  const at = (s) => Date.parse(T(s));
  const H = (s) => Date.parse(T(s));
  assert.deepEqual(idx.at("EWR", at("5T12:10"), H("5T14:00")), { gs: true, gdp: false, poss: true, staff: true });
  assert.deepEqual(idx.at("EWR", at("5T12:30"), H("5T16:00")), { gs: false, gdp: false, poss: true, staff: false }); // plan carried forward; staffing expired by 16Z
  assert.equal(idx.at("EWR", at("5T12:45"), H("5T14:00")), null, "FAA status down -> missing");
  assert.equal(idx.at("EWR", at("5T13:30"), H("5T14:00")), null, "no poll within 30 min -> missing");
  assert.equal(idx.at("EWR", at("5T11:00"), H("5T14:00")), null, "before the log starts -> missing");
  assert.deepEqual(idx.at("ORD", at("5T14:05"), H("5T15:00")), { gs: false, gdp: true, poss: false, staff: true });
  assert.deepEqual(idx.at("EWR", at("6T15:10"), H("6T16:00")), { gs: false, gdp: false, poss: false, staff: false }, "plan older than 24 h is dropped");
  assert.equal(idx.coverage.lines, 5);
  const names = (pg) => encode({ ap: "EWR", lh: 9, dw: 1, mo: 10, w: null, o: null, h: null, pg }, "0-3", { programs: true });
  assert.ok(names(null).includes("pg:none"));
  assert.ok(["pg:gs|0-3", "pg:poss", "pg:poss|0-3", "pg:staff"].every((k) => names({ gs: true, gdp: false, poss: true, staff: true }).includes(k)));
  assert.ok(!names({ gs: false, gdp: false, poss: false, staff: false }).some((k) => k.startsWith("pg:")));
});

test("schedule volume: usual flights per hour of week, actual ratio for training, month factor for test/live", () => {
  const recs = [];
  for (let wk = 0; wk < 8; wk++) {
    for (let h = 6; h <= 22; h++) {
      const peak = h === 17;
      recs.push({ a: "SFO", ym: "2025-07", mo: 7, dw: 5, lh: h, n: (peak ? 40 : 10) + (wk === 7 && peak ? 20 : 0) });
      recs.push({ a: "SFO", ym: "2025-12", mo: 12, dw: 5, lh: h, n: Math.round((peak ? 40 : 10) * 0.8) });
    }
  }
  const t = volumeTable(recs, new Set(["2025-07", "2025-12"]));
  const how = hourOfWeek(5, 17);
  assert.equal(t.SFO.q.length, 168);
  assert.equal(t.SFO.q[how], "3");
  assert.equal(t.SFO.q[hourOfWeek(5, 8)], "0");
  assert.equal(t.SFO.f[6], 1.11); // July runs above the usual (the median of both months)
  assert.ok(t.SFO.f[11] < 0.95);
  const surge = { a: "SFO", mo: 7, dw: 5, lh: 17, n: 60 };
  assert.ok(volumeFor(t, surge).vr > 1.3);
  assert.equal(volumeFor(t, surge, { actual: false }).vr, t.SFO.f[6]);
  assert.deepEqual(volumeFor(t, { a: "XXX", dw: 0, lh: 0 }), { vq: null, vr: null });
  const n = encode({ ap: "SFO", lh: 17, dw: 5, mo: 7, w: { l: 2, fc: 2, it: 0, t: 0, g: 0, s: 5, x: 0, p: 0, pp: 0, c: 800, v: 3, th: 0, gp: 0 }, o: null, h: null, vq: 3, vr: 1.4 }, "0-3", { volume: true });
  assert.ok(["vol:q3", "volr:hi2", "vol:q3|ifr"].every((k) => n.includes(k)));
  assert.ok(encode({ ap: "SFO", lh: 3, dw: 5, mo: 7, w: null, o: null, h: null, vq: null }, "0-3", { volume: true }).includes("vol:none"));
});

test("LAMP parser is tolerant of column names and case; categories and bad values", () => {
  const rows = parseCsv("STATION,MODEL,RUNTIME,FTIME,LTG,CNV1,CIG,VIS\nKORD,LAV,2026-07-14 15:00,2026-07-14 18:00,35,50,3,6\nKORD,LAV,2026-07-14 15:00,2026-07-14 19:00,140,M,0,9\n");
  const { byTime, diag } = lampFromIemCsv(rows);
  assert.equal(diag.columns.lp, 4);
  assert.equal(diag.used, 1); // the second row has nothing valid (140%, cig 0, vis 9)
  assert.deepEqual(lampLookup(byTime, Date.UTC(2026, 6, 14, 17), Date.UTC(2026, 6, 14, 16)), { lp: 35, cp: 50, lc: 3, lv: 6 });
  const n = encode({ ap: "ORD", lh: 12, dw: 2, mo: 7, w: null, o: null, h: null, lp: 35, cp: 50, lc: 3, lv: 6 }, "0-3", { lamp: true });
  assert.ok(["lp:20", "cp:50", "lcig:ifr"].every((k) => n.includes(k)) && !n.some((k) => k.startsWith("lvis")));
});

test("encode: without options the names are exactly the base features; each family adds only its own names", () => {
  const f = {
    ap: "ORD", lh: 17, dw: 3, mo: 11, y: 2025, d: 26, w: { l: 3, fc: 2, it: 0, t: 2, g: 30, s: 15, x: 20, p: 1, pp: 0, c: 800, v: 2, th: 0, gp: 0 },
    o: { l: 2, t: 1, fc: 2, p: 0, g: 25, x: 10 }, h: 1, lp: 30, cp: 60, lc: 2, lv: 2, pg: { gs: true, gdp: false, poss: true, staff: false }, hc: [2, 1, 0, 1, 0, 0, 3], vq: 3, vr: 0.6,
  };
  const base = encode(f, "0-3");
  assert.deepEqual(base, encode(f, "0-3", { lamp: false, programs: false, hubs: false, daytype: false, volume: false }));
  assert.ok(base.every((k) => familyOf(k) == null));
  for (const fam of FEATS) {
    const extra = encode(f, "0-3", { [fam]: true }).filter((k) => !base.includes(k));
    assert.ok(extra.length > 0, fam);
    assert.ok(extra.every((k) => familyOf(k) === fam), `${fam}: ${extra.join(",")}`);
  }
  // buildRows takes the families and the training-time extras
  const rec = { a: "ORD", H: 0, lh: 17, dw: 3, mo: 11, d: 26, ym: "2025-11", y: 1, f: [{ w: f.w, o: f.o, h: 1 }, null, null, null] };
  const rows = buildRows([rec], { programs: true, volume: true }, () => ({ pg: null, vq: 2, vr: 1 }));
  assert.ok(rows.vocab.has("pg:none") && rows.vocab.has("vol:q2") && !rows.vocab.has("day:pre"));
});

test("calibration block: the last 2 training months; isotonic fitted there fixes a drifted base rate", () => {
  assert.deepEqual(validationBlock(["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"]), { fit: ["2025-01", "2025-02", "2025-03"], val: ["2025-04", "2025-05"] });
  assert.deepEqual(validationBlock(["2025-01", "2025-02", "2025-03"]), { fit: ["2025-01", "2025-02"], val: ["2025-03"] });
  // raw scores that are right in the old months but 1.5x too high recently: calibrating on the recent block
  // beats calibrating on the old block for recent-like data
  let s = 3;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const make = (k) => { const p = []; const y = []; for (let i = 0; i < 20000; i++) { const x = rand() * 0.8; p.push(x); y.push(rand() < x * k ? 1 : 0); } return { p, y }; };
  const old = make(1);
  const recent = make(1 / 1.5);
  const future = make(1 / 1.5);
  const calOld = isotonicFit(old.p, old.y);
  const calRecent = isotonicFit(recent.p, recent.y);
  const bs = (cal) => brier(future.p.map((v) => calibrate(cal, v)), future.y);
  assert.ok(bs(calRecent) < bs(calOld));
  assert.ok(calibrationSummary(future.p.map((v) => calibrate(calRecent, v)), future.y).ece < calibrationSummary(future.p.map((v) => calibrate(calOld, v)), future.y).ece);
});

test("calibration summary and airport groups", () => {
  const c = calibrationSummary([0.1, 0.6, 0.7, 0.9], [0, 1, 0, 1]);
  assert.equal(c.n, 4);
  assert.equal(c.rate, 0.5);
  assert.equal(c.mid.n, 2);
  assert.ok(Math.abs(c.mid.meanP - 0.65) < 1e-9 && c.mid.rate === 0.5);
  assert.equal(groupOf("SFO"), "West");
  assert.equal(groupOf("ZZZ"), "Other");
  const all = Object.values(AIRPORT_GROUPS).flat();
  assert.equal(new Set(all).size, all.length, "each airport in one group");
  assert.ok(Object.keys(TOP_HUBS).every((ap) => all.includes(ap)));
});

test("gate: must also beat the deployed model on the same test hours", () => {
  const t = (bm, bk) => ({ n: 5000, brier: { model: bm, climo: 0.16, rule: 0.165, current: bk }, bss: { climo: 1 - bm / 0.16 } });
  const ok = { usable: true, comparable: true };
  assert.equal(gate(t(0.150, 0.153), { current: ok }).pass, true);
  const worse = gate(t(0.154, 0.153), { current: ok });
  assert.equal(worse.pass, false);
  assert.match(worse.reasons.join(" "), /deployed model/);
  assert.equal(gate(t(0.153, 0.153), { current: ok }).pass, false, "a tie doesn't replace the deployed model");
  const notFair = gate(t(0.150, null), { current: { usable: true, comparable: false, why: "needs LAMP" } });
  assert.equal(notFair.pass, false);
  assert.match(notFair.reasons.join(" "), /can't be compared.*LAMP/);
  assert.equal(gate(t(0.150, null), { current: { usable: false, comparable: false } }).pass, true, "no usable deployed model: the old rules decide");
  assert.equal(gate(t(0.150, null)).pass, true);
});

test("deployed-model check: usable, and comparable only when this run has its inputs", () => {
  const avail = { lamp: false, hubs: true, history: false };
  assert.equal(currentModelCheck(null, { avail }).usable, false);
  assert.equal(currentModelCheck({ spec: 99, b0: 0, w: {} }, { avail }).usable, false);
  assert.equal(currentModelCheck({ spec: 1, b0: 0, w: {}, feats: { teleport: true } }, { avail }).usable, false);
  assert.deepEqual(currentModelCheck({ spec: 1, b0: 0, w: {}, lamp: false }, { avail }).comparable, true);
  const c = currentModelCheck({ spec: 1, b0: 0, w: {}, lamp: true, feats: { lamp: true, programs: true } }, { avail });
  assert.equal(c.comparable, false);
  assert.match(c.why, /LAMP.*history/);
  assert.equal(currentModelCheck({ spec: 1, b0: 0, w: {}, feats: { hubs: true }, hubs: { MSP: ["ORD"] } }, { avail, topHubs: { MSP: ["ORD", "DEN"] } }).comparable, false);
  assert.match(parseFeatures("all").join(","), /lamp,programs,hubs,daytype,volume/);
  assert.deepEqual(parseFeatures("hub_cascade, day_type"), ["hubs", "daytype"]);
  assert.deepEqual(parseFeatures(""), []);
  assert.throws(() => parseFeatures("teleport"), /unknown feature/);
});

test("fixture training end to end: with every family and with none (calibrated on the 2 months before the test)", async () => {
  const months = ["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"];
  const out = join(tmpdir(), `awx-train-test-${process.pid}`);
  try {
    const on = await train({ fixtures: true, fixtureMonths: months, features: [...FEATS], ablation: false, out, date: "2026-10-04" });
    const R = on.report;
    assert.deepEqual(R.period.test, ["2025-09", "2025-10", "2025-11", "2025-12"]);
    assert.deepEqual(R.period.calibration, ["2025-07", "2025-08"]);
    assert.deepEqual(R.fit.calibration.on, ["2025-07", "2025-08"]);
    assert.deepEqual(R.features.used, [...FEATS]);
    assert.ok(R.features.programsRowsCovered > 0 && R.features.programsRowsCovered < 1);
    assert.equal(R.ablation, null);
    assert.ok(R.test.calibrationByGroup.all.model.n === R.test.n);
    assert.ok(on.model.feats.volume && on.model.vol.ORD.q.length === 168 && Array.isArray(on.model.hubs.MSP));
    assert.ok(modelOk(on.model));
    const md = renderMarkdown(R);
    assert.match(md, /FIXTURE RUN/);
    assert.match(md, /## Calibration by airport group/);
    assert.match(md, /## Compared with the deployed model/);
    const two = await train({ fixtures: true, fixtureMonths: months, features: ["daytype", "volume"], out, date: "2026-10-04" });
    assert.deepEqual(two.report.ablation.map((a) => a.label), ["base features only", "base + daytype", "base + volume", "all (daytype, volume)", "all without daytype", "all without volume"]);
    assert.ok(two.report.ablation.every((a) => a.bss != null && a.auc > 0.5));
    assert.match(renderMarkdown(two.report), /## Feature ablation[\s\S]*\| base \+ volume \|/);
    const off = await train({ fixtures: true, fixtureMonths: months, features: [], out, date: "2026-10-04" });
    assert.equal(off.report.ablation, null);
    assert.deepEqual(off.report.features.used, []);
    assert.ok(!Object.keys(off.model.w).some((k) => familyOf(k)));
    assert.ok(off.report.test.n > 1000);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
