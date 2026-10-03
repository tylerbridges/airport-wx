#!/usr/bin/env node
// Delay model training (README "Delay model").
//
//   node tools/train.mjs --data <dir> [--out site/data/model] [--reports <dir>] [--history <dir>]
//        [--prev <dir>] [--test-months 4] [--date YYYY-MM-DD]
//   node tools/train.mjs --fixtures [--lamp] [--out <dir>]      synthetic world (tools/train-fixtures.mjs)
//
// Reads the records from tools/train-data.mjs (<data>/dataset.jsonl.gz + meta.json), splits them in
// time (train = older months, test = the newest 4, reaching back to include a winter month), fits a
// regularised logistic regression (IRLS) with per-airport intercepts shrunk toward the global one and
// the airport x month x hour climatology as an input, calibrates it with isotonic regression on
// held-out time blocks of the training period, and verifies it on the test months against
// climatology and against the current rule levels mapped to their historical rates.
//
// Writes to --out: fallback.json (rule level -> historical rate, climatology, program rates, always),
// analogs/<IATA>.json (always), report.json (always), model-candidate.json (always) and model.json
// ONLY when the safety gate passes (test Brier skill vs climatology > 0 and better than the rule
// mapping). --reports gets model-YYYY-MM-DD.md/.json for the history branch.
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  timeSplit, climatology, buildRows, fitLogistic, predictRows, isotonicFit, scoreSet, reliability, contingency, gate,
  levelRates, buildAnalogs, programRates, median, quantile, HOUR,
} from "./train-lib.mjs";
import { aggregateBts, buildDataset, readDataset, runwayTable } from "./train-data.mjs";
import { fixtureWorld } from "./train-fixtures.mjs";
import { mergeAcc } from "./train-lib.mjs";
import { SPEC, BUCKETS, DEF, DEF_TEXT, typicalRate, logit, calibrate, modelOk, seasonOf } from "../poller/delay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

function parseArgs(argv) {
  const o = { fixtures: false, data: null, out: null, reports: null, history: null, prev: null, testMonths: 4, date: null, lamp: false, minCount: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--fixtures") o.fixtures = true;
    else if (a === "--data") o.data = resolve(v());
    else if (a === "--out") o.out = resolve(v());
    else if (a === "--reports") o.reports = resolve(v());
    else if (a === "--history") o.history = resolve(v());
    else if (a === "--prev") o.prev = resolve(v());
    else if (a === "--test-months") o.testMonths = Math.max(1, Number(v()) || 4);
    else if (a === "--date") o.date = v();
    else if (a === "--lamp") o.lamp = true;
    else if (a === "--min-count") o.minCount = Number(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.fixtures && !o.data) throw new Error("--data <dir> or --fixtures is required");
  return o;
}

// ---------- inputs ----------

async function fixtureRecords({ lamp }) {
  const world = fixtureWorld();
  const acc = new Map();
  const bts = [];
  const samples = {};
  for (const m of world.months) {
    const text = world.bts(m);
    async function* lines() { for (const l of text.split("\n")) yield l; }
    const r = await aggregateBts(lines(), new Set(world.airports.map((a) => a.iata)));
    mergeAcc(acc, r.entries);
    bts.push({ month: m, rows: r.rows, kept: r.kept });
    samples["bts-header.csv"] ||= r.sample;
  }
  const records = [];
  const rwy = await runwayTable(world.airports.map((a) => a.iata));
  const save = async (name, text) => { samples[name] ||= text.slice(0, 2000); };
  const meta = await buildDataset({
    airports: world.airports, months: world.months, acc, lamp,
    src: { taf: async (i, f, t) => world.taf(i, f, t), metar: async (i, f, t) => world.metar(i, f, t), lamp: async (i, f, t) => world.lamp(i, f, t) },
    writeLine: (r) => { records.push(r); }, saveSample: save, rwyOf: (i) => rwy[i] || null, log: () => {},
  });
  return { records, meta: { ...meta, bts, lamp, rwy, samplesText: samples, fixtures: true } };
}

async function readHistory(dir) {
  const lines = [];
  const walk = async (d) => {
    let ents = [];
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
        for await (const l of rl) { if (!l) continue; try { lines.push(JSON.parse(l)); } catch { /* skip */ } }
      }
    }
  };
  await walk(join(dir, "truth"));
  return lines;
}

// ---------- training ----------

/** Contiguous month blocks of the training months for out-of-fold calibration. */
function folds(months, k) {
  const out = [];
  const size = Math.ceil(months.length / k);
  for (let i = 0; i < months.length; i += size) out.push(new Set(months.slice(i, i + size)));
  return out;
}

export async function train(opts) {
  const now = new Date();
  const date = opts.date || now.toISOString().slice(0, 10);
  const { records, meta } = opts.fixtures ? await fixtureRecords(opts) : { records: await readDataset(opts.data), meta: JSON.parse(await readFile(join(opts.data, "meta.json"), "utf8")) };
  if (!records.length) throw new Error("no training records");
  const lamp = !!meta.lamp;
  const months = [...new Set(records.map((r) => r.ym))].sort();
  const split = timeSplit(months, { testCount: opts.testMonths });
  if (split.train.length < 3) throw new Error(`only ${split.train.length} training months; need at least 3`);
  const trainSet = new Set(split.train);
  const testSet = new Set(split.test);
  const trainRecs = records.filter((r) => trainSet.has(r.ym));

  // climatology from the training period (the model's input; also the "typical" baseline on test)
  const climoTrain = climatology(trainRecs);
  const rows = buildRows(records, { lamp });
  const V = rows.vocab.size;
  const y = new Uint8Array(rows.n);
  const xc = new Float64Array(rows.n);
  const pc = new Float64Array(rows.n);
  for (let q = 0; q < rows.n; q++) {
    const r = records[rows.rec[q]];
    y[q] = r.y;
    const t = typicalRate(climoTrain, r.a, r.mo, r.lh);
    pc[q] = t ? t.p : climoTrain.base.all;
    xc[q] = logit(pc[q]);
  }
  const idxOf = (pred) => { const a = []; for (let q = 0; q < rows.n; q++) if (pred(records[rows.rec[q]])) a.push(q); return Uint32Array.from(a); };
  const trainRows = idxOf((r) => trainSet.has(r.ym));
  const testRows = idxOf((r) => testSet.has(r.ym));
  const minCount = opts.minCount ?? (opts.fixtures ? 10 : 30);
  const cnt = new Uint32Array(V);
  for (const q of trainRows) for (let e = rows.off[q]; e < rows.off[q + 1]; e++) cnt[rows.idx[e]]++;
  const mask = new Uint8Array(V);
  for (let j = 0; j < V; j++) mask[j] = cnt[j] >= minCount ? 1 : 0;
  const X = { off: rows.off, idx: rows.idx, xc, y, V, mask };

  // out-of-fold predictions over contiguous training blocks -> lambda choice and isotonic calibration
  const fs = folds(split.train, 3);
  const lambdas = [1, 10, 100];
  let best = null;
  const t0 = Date.now();
  for (const lambda of lambdas) {
    const oof = new Float64Array(trainRows.length);
    const pos = new Map();
    trainRows.forEach((q, i) => pos.set(q, i));
    let ll = 0;
    for (const f of fs) {
      const fitRows = trainRows.filter((q) => !f.has(records[rows.rec[q]].ym));
      const holdRows = trainRows.filter((q) => f.has(records[rows.rec[q]].ym));
      if (!fitRows.length || !holdRows.length) continue;
      const fit = fitLogistic({ ...X, rows: fitRows, lambda });
      const p = predictRows({ ...X, rows: holdRows, fit });
      holdRows.forEach((q, i) => { oof[pos.get(q)] = p[i]; const v = Math.min(1 - 1e-6, Math.max(1e-6, p[i])); ll -= y[q] ? Math.log(v) : Math.log(1 - v); });
    }
    if (!best || ll < best.ll) best = { lambda, ll, oof };
  }
  const cal = isotonicFit(best.oof, Array.from(trainRows, (q) => y[q]));
  const fit = fitLogistic({ ...X, rows: trainRows, lambda: best.lambda });
  const fitSecs = (Date.now() - t0) / 1000;
  const pTrain = Array.from(predictRows({ ...X, rows: trainRows, fit }), (p) => calibrate(cal, p));
  const pTest = Array.from(predictRows({ ...X, rows: testRows, fit }), (p) => calibrate(cal, p));
  const yTest = Array.from(testRows, (q) => y[q]);

  // baselines on the test rows
  const lr = levelRates(rows, records, trainRows);
  const ruleP = (q) => lr.levels[BUCKETS[rows.b[q]].key][rows.lvl[q]] ?? climoTrain.base.all;
  const pRule = Array.from(testRows, ruleP);
  const pClimo = Array.from(testRows, (q) => pc[q]);

  // ---------- minutes: airport x predicted-probability decile ----------
  const edges = [];
  for (let k = 1; k < 10; k++) edges.push(r4(quantile(pTrain, k / 10)));
  const decileOf = (p) => { let d = 0; while (d < edges.length && p >= edges[d]) d++; return d; };
  const minAll = Array.from({ length: 10 }, () => []);
  const minAp = new Map();
  trainRows.forEach((q, i) => {
    const r = records[rows.rec[q]];
    if (!r.y || r.dm == null) return;
    const d = decileOf(pTrain[i]);
    minAll[d].push(r.dm);
    if (!minAp.has(r.a)) minAp.set(r.a, Array.from({ length: 10 }, () => []));
    minAp.get(r.a)[d].push(r.dm);
  });
  const rnd = (x) => (x == null ? null : Math.round(x));
  const minutes = { edges, all: minAll.map((a) => (a.length >= 15 ? rnd(median(a)) : null)), ap: {} };
  for (let d = 0; d < 10; d++) if (minutes.all[d] == null) minutes.all[d] = rnd(median(minAll.flat())) ?? null;
  for (const [ap, arr] of minAp) minutes.ap[ap] = arr.map((a) => (a.length >= 15 ? rnd(median(a)) : null));

  // ---------- metrics ----------
  const sub = (sel) => {
    const pm = [];
    const pcc = [];
    const pr = [];
    const yy = [];
    testRows.forEach((q, i) => { if (sel(q, records[rows.rec[q]])) { pm.push(pTest[i]); pcc.push(pClimo[i]); pr.push(pRule[i]); yy.push(yTest[i]); } });
    return { pm, pc: pcc, pr, y: yy };
  };
  const evalSet = (s) => {
    const sc = scoreSet(s.pm, s.pc, s.pr, s.y);
    const rd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r4(v)]));
    return { n: sc.n, base: r4(sc.base), brier: rd(sc.brier), bss: rd(sc.bss), auc: rd(sc.auc), meanP: r4(s.pm.reduce((a, b) => a + b, 0) / Math.max(1, s.pm.length)) };
  };
  const all = sub(() => true);
  const test = evalSet(all);
  test.reliability = reliability(all.pm, all.y).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) }));
  test.reliabilityRule = reliability(all.pr, all.y).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) }));
  test.byLead = Object.fromEntries(BUCKETS.map((b, bi) => [b.key, evalSet(sub((q) => rows.b[q] === bi))]));
  const aps = [...new Set(records.map((r) => r.a))].sort();
  test.byAirport = Object.fromEntries(aps.map((ap) => [ap, evalSet(sub((q, r) => r.a === ap))]).filter(([, v]) => v.n));
  test.bySeason = Object.fromEntries(["winter", "spring", "summer", "fall"].map((s) => [s, evalSet(sub((q, r) => seasonOf(r.mo) === s))]).filter(([, v]) => v.n));
  // catching real delay hours: model >= 50% vs the rule level High+ / Moderate+
  test.catch = {
    model50: contingency(all.pm.map((p) => p >= 0.5), all.y),
    model30: contingency(all.pm.map((p) => p >= 0.3), all.y),
    ruleHigh: contingency(Array.from(testRows, (q) => rows.lvl[q] >= 3 && rows.lvl[q] <= 4), all.y),
    ruleModerate: contingency(Array.from(testRows, (q) => rows.lvl[q] >= 2 && rows.lvl[q] <= 4), all.y),
  };
  for (const k of Object.keys(test.catch)) for (const m of ["pod", "far", "csi"]) test.catch[k][m] = r4(test.catch[k][m]);
  // compared with typical for the hour
  const groups = [["much higher than usual (2x or more)", (p, c) => p >= 2 * c], ["higher than usual (1.25-2x)", (p, c) => p >= 1.25 * c && p < 2 * c], ["about usual", (p, c) => p > 0.8 * c && p < 1.25 * c], ["lower than usual", (p, c) => p <= 0.8 * c]];
  test.vsTypical = groups.map(([label, fn]) => {
    let n = 0; let k = 0; let sp = 0; let sc = 0;
    all.pm.forEach((p, i) => { if (fn(p, all.pc[i])) { n++; k += all.y[i]; sp += p; sc += all.pc[i]; } });
    return { label, n, meanP: r4(n ? sp / n : null), rate: r4(n ? k / n : null), typical: r4(n ? sc / n : null) };
  });
  // delay minutes when delays happened: predicted vs actual
  const mm = [];
  testRows.forEach((q, i) => {
    const r = records[rows.rec[q]];
    if (!r.y || r.dm == null) return;
    const d = decileOf(pTest[i]);
    const pred = minutes.ap[r.a]?.[d] ?? minutes.all[d];
    if (pred != null) mm.push(Math.abs(pred - r.dm));
  });
  test.minutes = { n: mm.length, medianAbsError: rnd(median(mm)) };
  const g = gate(test, { minN: opts.fixtures ? 100 : 200 });

  // ---------- outputs ----------
  const outDir = opts.out || (opts.fixtures ? join(tmpdir(), "airport-wx-train-fixture") : join(ROOT, "site/data/model"));
  await mkdir(join(outDir, "analogs"), { recursive: true });
  const since = months[0];
  const through = months[months.length - 1];
  const rwy = meta.rwy || {};
  const w = {};
  for (const [name, j] of rows.vocab) if (mask[j] && Math.abs(fit.w[j]) > 1e-6) w[name] = r4(fit.w[j]);
  const model = {
    v: 1, spec: SPEC, trained: now.toISOString(), date, fixtures: !!opts.fixtures, since, through, months: months.length,
    train: { from: split.train[0], to: split.train[split.train.length - 1] }, test: { from: split.test[0], to: split.test[split.test.length - 1] },
    lamp, lambda: best.lambda, b0: r4(fit.b0), wc: r4(fit.wc), w, cal, minutes, base: climoTrain.base.all, rwy,
  };
  // fallback + climatology from every month (the best estimate of "usual" for the live page)
  const climoAll = climatology(records);
  const lrAll = levelRates(rows, records, Uint32Array.from({ length: rows.n }, (_, i) => i));
  const minLvl = [0, 1, 2, 3, 4].map((l) => {
    const a = [];
    for (let q = 0; q < rows.n; q++) { const r = records[rows.rec[q]]; if (rows.lvl[q] === l && r.y && r.dm != null) a.push(r.dm); }
    return a.length >= 15 ? rnd(median(a)) : null;
  });
  let programs = null;
  if (opts.history) programs = programRates(await readHistory(opts.history));
  else if (opts.fixtures) programs = programRates(JSON.parse(await readFile(join(HERE, "fixtures/train/history-truth.json"), "utf8")));
  const fallback = {
    v: 1, spec: SPEC, source: opts.fixtures ? "fixtures" : "train", built: now.toISOString(), since, through, months: months.length, def: DEF,
    levels: Object.fromEntries(Object.entries(lrAll.levels).map(([k, v]) => [k, v.slice(0, 5)])), levelsNoTaf: Object.fromEntries(Object.entries(lrAll.levels).map(([k, v]) => [k, v[5]])),
    minutes: minLvl, climo: climoAll.climo, base: climoAll.base, programs, rwy,
  };
  const analogs = buildAnalogs(records);
  let prevModel = null;
  if (opts.prev) { try { prevModel = JSON.parse(await readFile(join(opts.prev, "model.json"), "utf8")); } catch { /* none */ } }
  const live = g.pass ? { basis: "model", modelDate: model.trained, thisRun: true }
    : modelOk(prevModel) ? { basis: "model", modelDate: prevModel.trained, thisRun: false }
      : { basis: "fallback", modelDate: null, thisRun: false };
  const report = {
    v: 1, date, generated: now.toISOString(), fixtures: !!opts.fixtures, deployed: g.pass, gate: g, live,
    def: { ...DEF, text: DEF_TEXT },
    period: { since, through, months: months.length, train: split.train, test: split.test, winterInTest: split.winterInTest },
    counts: { records: records.length, rows: rows.n, trainRows: trainRows.length, testRows: testRows.length, airports: aps.length, realDelayHours: records.reduce((a, r) => a + r.y, 0), features: Object.keys(w).length, ...meta.counts },
    fit: { lambda: best.lambda, lambdas, oofLogLoss: r4(best.ll / Math.max(1, trainRows.length)), iterations: fit.iters, seconds: Math.round(fitSecs), calibration: { method: "isotonic", knots: cal.x.length } },
    test,
    ruleRates: lr.levels,
    lamp,
    skipped: meta.skipped || [],
    airportsUsed: meta.airportsUsed || aps,
  };
  const json = (o) => JSON.stringify(o) + "\n";
  await writeFile(join(outDir, "model-candidate.json"), json(model));
  if (g.pass) await writeFile(join(outDir, "model.json"), json(model));
  else await rm(join(outDir, "model.json"), { force: true }).catch(() => {});
  await writeFile(join(outDir, "fallback.json"), json(fallback));
  await writeFile(join(outDir, "report.json"), json(report));
  for (const [ap, b] of Object.entries(analogs)) await writeFile(join(outDir, "analogs", ap + ".json"), json({ v: 1, ap, since, through, b }));
  const files = [join(outDir, "report.json")];
  if (opts.reports) {
    await mkdir(opts.reports, { recursive: true });
    await writeFile(join(opts.reports, `model-${date}.json`), JSON.stringify(report, null, 1) + "\n");
    await writeFile(join(opts.reports, `model-${date}.md`), renderMarkdown(report) + "\n");
    if (meta.samplesText) { await mkdir(join(opts.reports, "samples"), { recursive: true }); }
    files.push(join(opts.reports, `model-${date}.md`));
  }
  return { report, model, fallback, outDir, files };
}

// ---------- markdown ----------

const pct = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
const f3 = (x) => (x == null ? "–" : x.toFixed(3));
const int = (x) => (x == null ? "–" : Math.round(x).toLocaleString("en-US"));
const row = (c) => `| ${c.join(" | ")} |`;
const sep = (n) => row(Array.from({ length: n }, () => "---"));

export function renderMarkdown(rep) {
  const L = [];
  const T = rep.test;
  L.push(`# Delay model — ${rep.date}`);
  L.push("");
  if (rep.fixtures) L.push("> **FIXTURE RUN** — numbers come from the synthetic world in tools/train-fixtures.mjs, not real data.\n");
  L.push(`- **${rep.deployed ? "Deployed" : "NOT deployed"}**${rep.gate.reasons.length ? ": " + rep.gate.reasons.join("; ") : " (passed the safety gate)"}. Live basis: ${rep.live.basis}${rep.live.modelDate ? " (model trained " + rep.live.modelDate.slice(0, 10) + ")" : ""}.`);
  L.push(`- Data: ${rep.period.since} to ${rep.period.through} (${rep.period.months} months); train ${rep.period.train[0]}..${rep.period.train[rep.period.train.length - 1]}, test ${rep.period.test.join(", ")}${rep.period.winterInTest ? " (includes winter)" : " (no winter month in the test block)"}.`);
  L.push(`- Records (airport-hours): ${int(rep.counts.records)}; rows (x lead bucket): ${int(rep.counts.rows)}; real delay hours: ${int(rep.counts.realDelayHours)}; features: ${rep.counts.features}; lambda ${rep.fit.lambda}; isotonic knots ${rep.fit.calibration.knots}.`);
  L.push(`- Real delay hour: ${rep.def.text}`);
  if (rep.skipped.length) L.push(`- Skipped / partial (${rep.skipped.length}): ${rep.skipped.slice(0, 30).map((s) => `${s.station} ${s.what}${s.month ? " " + s.month : ""}`).join("; ")}${rep.skipped.length > 30 ? " …" : ""}`);
  L.push("");
  L.push("## Test period");
  L.push("");
  L.push(row(["", "Hours", "Base rate", "Brier model", "Brier climatology", "Brier rule mapping", "Skill vs climatology", "Skill vs rule", "AUC model", "AUC climo", "AUC rule"]));
  L.push(sep(11));
  const line = (name, s) => row([name, int(s.n), pct(s.base), f3(s.brier.model), f3(s.brier.climo), f3(s.brier.rule), f3(s.bss.climo), f3(s.bss.rule), f3(s.auc.model), f3(s.auc.climo), f3(s.auc.rule)]);
  L.push(line("all", T));
  for (const [k, s] of Object.entries(T.byLead)) L.push(line(`lead ${k} h`, s));
  for (const [k, s] of Object.entries(T.bySeason)) L.push(line(k, s));
  L.push("");
  L.push("## Reliability (test)");
  L.push("");
  L.push(row(["Predicted", "Hours", "Mean predicted", "Observed", "Rule mapping: hours / observed"]));
  L.push(sep(5));
  T.reliability.forEach((b, i) => { const r = T.reliabilityRule[i]; L.push(row([`${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`, int(b.n), pct(b.meanP), pct(b.rate), `${int(r.n)} / ${pct(r.rate)}`])); });
  L.push("");
  L.push("## Catching real delay hours (test)");
  L.push("");
  L.push(row(["Warning", "POD", "FAR", "CSI"]));
  L.push(sep(4));
  for (const [k, c] of Object.entries(T.catch)) L.push(row([k, f3(c.pod), f3(c.far), f3(c.csi)]));
  L.push("");
  L.push("## Compared with typical for the hour (test)");
  L.push("");
  L.push(row(["Model said", "Hours", "Mean predicted", "Observed", "Typical"]));
  L.push(sep(5));
  for (const g of T.vsTypical) L.push(row([g.label, int(g.n), pct(g.meanP), pct(g.rate), pct(g.typical)]));
  L.push("");
  L.push(`Delay minutes when delays happened: median absolute error ${T.minutes.medianAbsError ?? "–"} min over ${int(T.minutes.n)} hours.`);
  L.push("");
  L.push("## Per airport (test)");
  L.push("");
  L.push(row(["Airport", "Hours", "Base rate", "Brier", "Skill vs climatology", "Skill vs rule", "AUC"]));
  L.push(sep(7));
  for (const [ap, s] of Object.entries(T.byAirport)) L.push(row([ap, int(s.n), pct(s.base), f3(s.brier.model), f3(s.bss.climo), f3(s.bss.rule), f3(s.auc.model)]));
  L.push("");
  return L.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { report, outDir, files } = await train(opts);
  const T = report.test;
  console.log(`${report.fixtures ? "FIXTURE " : ""}test hours ${T.n}: Brier model ${f3(T.brier.model)} climo ${f3(T.brier.climo)} rule ${f3(T.brier.rule)}; skill vs climo ${f3(T.bss.climo)}, vs rule ${f3(T.bss.rule)}; AUC ${f3(T.auc.model)}`);
  console.log(`gate: ${report.gate.pass ? "PASS — model.json written" : "FAIL — model.json not written: " + report.gate.reasons.join("; ")}`);
  console.log(`outputs in ${outDir}`);
  for (const f of files) console.log("wrote " + f);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
