// Delay model training (tools/train-lib.mjs, tools/train-data.mjs): BTS and IEM parsing, the target,
// the logistic fit, isotonic calibration, metrics, the time split, program rates and the safety gate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  btsIndex2, btsAdd2, truthFromAcc, sideReal, mergeAcc, accEntries, fitLogistic, predictRows, isotonicFit, brier, auc, reliability, gate,
  timeSplit, programRates, lampFromIemCsv, lampLookup, climatology, airportRecords, buildRows, buildAnalogs, median,
} from "./train-lib.mjs";
import { aggregateBts, chunks } from "./train-data.mjs";
import { parseCsv, parseCsvLine, tafsFromIemCsv } from "./backtest-lib.mjs";
import { tafSummary, calibrate } from "../poller/delay.mjs";
import { fixtureWorld } from "./train-fixtures.mjs";

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
  assert.deepEqual(lampLookup(byTime, Date.UTC(2026, 6, 14, 17), Date.UTC(2026, 6, 14, 16)), { lp: 45, cp: 60 });
  assert.deepEqual(lampLookup(byTime, Date.UTC(2026, 6, 14, 17), Date.UTC(2026, 6, 14, 13)), { lp: 20, cp: 40 });
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
