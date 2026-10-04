#!/usr/bin/env node
// Delay model training (README "Delay model").
//
//   node tools/train.mjs --data <dir> [--out site/data/model] [--reports <dir>] [--history <dir>]
//        [--prev <dir>] [--test-months 4] [--date YYYY-MM-DD] [--features lamp,programs,hubs,daytype,volume|all|none]
//        [--no-ablation] [--val-months 2]
//   node tools/train.mjs --fixtures [--features …] [--out <dir>]      synthetic world (tools/train-fixtures.mjs)
//
// Reads the records from tools/train-data.mjs (<data>/dataset.jsonl.gz + meta.json), splits them in
// time (train = older months, test = the newest 4, reaching back to include a winter month), fits a
// regularised logistic regression (IRLS) with per-airport intercepts shrunk toward the global one and
// the airport x month x hour climatology as an input, calibrates it with isotonic regression fitted on
// the last 2 training months (predicted by a fit on the months before them), and verifies it on the test
// months against climatology, the current rule levels mapped to their historical rates and the model
// deployed now (--prev, scored on the same test hours).
//
// Optional feature families (poller/delay.mjs FEATS; --features, default: what the data was built with
// for lamp, none of the others; --fixtures: all): lamp and hubs need the dataset built with --lamp /
// --hub-cascade; programs reads the history branch's truth log (--history; "pg:none" where it has no
// record); daytype and volume come from the records. With --ablation (default) each family is also
// fitted on/off and the report gets a table.
//
// Writes to --out: fallback.json (rule level -> historical rate, climatology, program rates, always),
// analogs/<IATA>.json (always), report.json (always), model-candidate.json (always) and model.json
// ONLY when the safety gate passes (test Brier skill vs climatology > 0, better than the rule mapping,
// and better than the deployed model on the same test hours). --reports gets model-YYYY-MM-DD.md/.json.
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  timeSplit, validationBlock, climatology, buildRows, featInput, familyOf, fitLogistic, predictRows, isotonicFit, scoreSet, reliability, contingency, gate,
  levelRates, buildAnalogs, programRates, programIndex, volumeTable, volumeFor, calibrationSummary, groupOf, AIRPORT_GROUPS, brier, auc, median, quantile, HOUR,
} from "./train-lib.mjs";
import { aggregateBts, buildDataset, readDataset, runwayTable } from "./train-data.mjs";
import { fixtureWorld } from "./train-fixtures.mjs";
import { mergeAcc } from "./train-lib.mjs";
import { likelihood } from "../site/delay.js";
import {
  SPEC, BUCKETS, DEF, DEF_TEXT, FEATS, typicalRate, logit, calibrate, modelOk, featsOf, modelRaw, encode, volumeAt, seasonOf,
} from "../poller/delay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/** "lamp,programs" | "all" | "none" | "" -> [families] (unknown names throw). */
export function parseFeatures(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "none" || s === "false") return [];
  if (s === "all") return [...FEATS];
  const list = s.split(/[,\s]+/).filter(Boolean).map((x) => ({ "faa_programs": "programs", "hub_cascade": "hubs", "day_type": "daytype" })[x] || x);
  const bad = list.filter((x) => !FEATS.includes(x));
  if (bad.length) throw new Error(`unknown feature(s) ${bad.join(", ")}; known: ${FEATS.join(", ")}`);
  return [...new Set(list)];
}

function parseArgs(argv) {
  const o = { fixtures: false, data: null, out: null, reports: null, history: null, prev: null, testMonths: 4, valMonths: 2, date: null, lamp: false, minCount: null, features: null, ablation: true };
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
    else if (a === "--val-months") o.valMonths = Math.max(1, Number(v()) || 2);
    else if (a === "--date") o.date = v();
    else if (a === "--lamp") o.lamp = true;
    else if (a === "--features") o.features = parseFeatures(v());
    else if (a === "--ablation") o.ablation = true;
    else if (a === "--no-ablation") o.ablation = false;
    else if (a === "--min-count") o.minCount = Number(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.fixtures && !o.data) throw new Error("--data <dir> or --fixtures is required");
  return o;
}

// ---------- inputs ----------

async function fixtureRecords({ lamp, hubCascade, fixtureMonths }) {
  const world = fixtureWorld(fixtureMonths ? { months: fixtureMonths } : {});
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
    airports: world.airports, months: world.months, acc, lamp, hubCascade,
    src: { taf: async (i, f, t) => world.taf(i, f, t), metar: async (i, f, t) => world.metar(i, f, t), lamp: async (i, f, t) => world.lamp(i, f, t) },
    writeLine: (r) => { records.push(r); }, saveSample: save, rwyOf: (i) => rwy[i] || null, log: () => {},
  });
  return { records, meta: { ...meta, bts, lamp, rwy, samplesText: samples, fixtures: true }, history: world.history() };
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

/** Contiguous month blocks of the training months for the lambda choice. */
function folds(months, k) {
  const out = [];
  const size = Math.ceil(months.length / k);
  for (let i = 0; i < months.length; i += size) out.push(new Set(months.slice(i, i + size)));
  return out;
}

/**
 * Can the deployed model be scored on this run's test hours as it is scored live?
 * -> {usable, comparable, why, feats}.
 */
export function currentModelCheck(prev, { avail, topHubs }) {
  if (!prev) return { usable: false, comparable: false, why: "no model.json deployed" };
  if (!modelOk(prev)) return { usable: false, comparable: false, why: `deployed model.json can't be used by this scorer (spec ${prev.spec ?? "?"})` };
  const pf = featsOf(prev);
  const missing = [];
  if (pf.lamp && !avail.lamp) missing.push("LAMP (build with --lamp)");
  if (pf.hubs) {
    if (!avail.hubs) missing.push("hub cascade (build with --hub-cascade)");
    else if (Object.entries(prev.hubs || {}).some(([ap, hs]) => topHubs?.[ap] && JSON.stringify(topHubs[ap]) !== JSON.stringify(hs))) missing.push("the same top-hub table");
  }
  if (pf.programs && !avail.history) missing.push("the history log (--history)");
  if (pf.volume && !prev.vol) missing.push("its volume table");
  return { usable: true, comparable: !missing.length, why: missing.length ? "needs " + missing.join(", ") : null, feats: pf };
}

export async function train(opts) {
  const now = new Date();
  const date = opts.date || now.toISOString().slice(0, 10);
  const fx = opts.fixtures;
  const want = opts.features ?? (fx ? [...FEATS] : null); // null: as the data was built (lamp only)
  let loaded;
  if (fx) loaded = await fixtureRecords({ lamp: opts.lamp || !!want?.includes("lamp"), hubCascade: !!want?.includes("hubs"), fixtureMonths: opts.fixtureMonths });
  else loaded = { records: await readDataset(opts.data), meta: JSON.parse(await readFile(join(opts.data, "meta.json"), "utf8")), history: null };
  const { records, meta } = loaded;
  if (!records.length) throw new Error("no training records");
  let history = loaded.history;
  if (opts.history) history = await readHistory(opts.history);
  const months = [...new Set(records.map((r) => r.ym))].sort();
  const split = timeSplit(months, { testCount: opts.testMonths });
  if (split.train.length < 3) throw new Error(`only ${split.train.length} training months; need at least 3`);
  const prog = history ? programIndex(history) : null;
  const trainMonths = new Set(split.train);
  const progInTrain = !!prog && records.some((r) => trainMonths.has(r.ym) && BUCKETS.some((b) => prog.at(r.a, r.H - b.lo * HOUR, r.H)));
  // a family is used only if the data has it (a family that would be all "missing" in training is left out)
  const why = {
    lamp: !meta.lamp ? "dataset built without --lamp" : !(meta.counts?.lampRows > 0) ? "no LAMP values parsed (see the LAMP sample in the log)" : null,
    hubs: !meta.hubCascade ? "dataset built without --hub-cascade" : null,
    programs: !prog ? "no history log (--history)" : !progInTrain ? `the history log (${prog.coverage.from?.slice(0, 10) ?? "–"}..) has no records in the training months` : null,
    daytype: null, volume: null,
  };
  const avail = { lamp: !why.lamp, hubs: !why.hubs, programs: true, daytype: true, volume: true, history: !!history };
  const requested = want ?? (meta.lamp ? ["lamp"] : []);
  const families = requested.filter((f) => !why[f]);
  const unavailable = requested.filter((f) => why[f]).map((f) => `${f} (${why[f]})`);
  const feats = Object.fromEntries(FEATS.map((f) => [f, families.includes(f)]));
  const vb = validationBlock(split.train, opts.valMonths ?? 2);
  const trainSet = new Set(split.train);
  const testSet = new Set(split.test);
  const fitSet = new Set(vb.fit);
  const valSet = new Set(vb.val);
  const trainRecs = records.filter((r) => trainSet.has(r.ym));

  // climatology from the training period (the model's input; also the "typical" baseline on test)
  const climoTrain = climatology(trainRecs);
  // The calibration predictor cannot use calibration-month outcome rates as an input.
  const climoFit = climatology(records.filter((r) => fitSet.has(r.ym)));

  // training-time inputs: FAA program state from the history log, schedule volume from BTS
  const vol = volumeTable(records, trainSet);
  const liveLike = (r) => testSet.has(r.ym) || valSet.has(r.ym); // calibration and test rows see what the live scorer sees
  const aug = (r, bi) => {
    const o = {};
    if (feats.programs) o.pg = prog ? prog.at(r.a, r.H - BUCKETS[bi].lo * HOUR, r.H) : null;
    if (feats.volume) Object.assign(o, volumeFor(vol, r, { actual: !liveLike(r) }));
    return o;
  };
  const rows = buildRows(records, feats, aug);
  const V = rows.vocab.size;
  const y = new Uint8Array(rows.n);
  const xc = new Float64Array(rows.n);
  const xcFit = new Float64Array(rows.n);
  const pc = new Float64Array(rows.n);
  for (let q = 0; q < rows.n; q++) {
    const r = records[rows.rec[q]];
    y[q] = r.y;
    const t = typicalRate(climoTrain, r.a, r.mo, r.lh);
    pc[q] = t ? t.p : climoTrain.base.all;
    xc[q] = logit(pc[q]);
    const tf = typicalRate(climoFit, r.a, r.mo, r.lh);
    xcFit[q] = logit(tf ? tf.p : climoFit.base.all);
  }
  const idxOf = (pred) => { const a = []; for (let q = 0; q < rows.n; q++) if (pred(records[rows.rec[q]])) a.push(q); return Uint32Array.from(a); };
  const trainRows = idxOf((r) => trainSet.has(r.ym));
  const fitRows = idxOf((r) => fitSet.has(r.ym));
  const valRows = idxOf((r) => valSet.has(r.ym));
  const testRows = idxOf((r) => testSet.has(r.ym));
  const minCount = opts.minCount ?? (fx ? 10 : 30);
  const cnt = new Uint32Array(V);
  for (const q of trainRows) for (let e = rows.off[q]; e < rows.off[q + 1]; e++) cnt[rows.idx[e]]++;
  const fam = new Array(V);
  for (const [name, j] of rows.vocab) fam[j] = familyOf(name);
  const maskFor = (on) => { const m = new Uint8Array(V); for (let j = 0; j < V; j++) m[j] = cnt[j] >= minCount && (fam[j] == null || on.includes(fam[j])) ? 1 : 0; return m; };
  const mask = maskFor(families);
  const X = { off: rows.off, idx: rows.idx, xc, y, V };
  const XFit = { ...X, xc: xcFit };

  // lambda: out-of-fold log loss over contiguous blocks of the training months
  const fs = folds(split.train, 3);
  const lambdas = [1, 10, 100];
  let best = null;
  const t0 = Date.now();
  for (const lambda of lambdas) {
    let ll = 0;
    for (const f of fs) {
      const fr = trainRows.filter((q) => !f.has(records[rows.rec[q]].ym));
      const hr = trainRows.filter((q) => f.has(records[rows.rec[q]].ym));
      if (!fr.length || !hr.length) continue;
      const fit = fitLogistic({ ...X, mask, rows: fr, lambda });
      const p = predictRows({ ...X, mask, rows: hr, fit });
      hr.forEach((q, i) => { const v = Math.min(1 - 1e-6, Math.max(1e-6, p[i])); ll -= y[q] ? Math.log(v) : Math.log(1 - v); });
    }
    if (!best || ll < best.ll) best = { lambda, ll };
  }

  // calibration on the validation block (the last training months), then the final fit on all training months
  const yVal = Array.from(valRows, (q) => y[q]);
  const yTest = Array.from(testRows, (q) => y[q]);
  const variant = (on) => {
    const m = on === families ? mask : maskFor(on);
    const fitV = fitLogistic({ ...XFit, mask: m, rows: fitRows, lambda: best.lambda });
    const rawVal = Array.from(predictRows({ ...XFit, mask: m, rows: valRows, fit: fitV }));
    const cal = isotonicFit(rawVal, yVal);
    const pVal = rawVal.map((p) => calibrate(cal, p));
    const fit = fitLogistic({ ...X, mask: m, rows: trainRows, lambda: best.lambda, init: fitV.beta });
    const pTest = Array.from(predictRows({ ...X, mask: m, rows: testRows, fit }), (p) => calibrate(cal, p));
    return { fit, cal, pTest, pVal, mask: m };
  };
  const main = variant(families);
  const { fit, cal, pTest } = main;
  const fitSecs = (Date.now() - t0) / 1000;
  const pTrain = Array.from(predictRows({ ...X, mask, rows: trainRows, fit }), (p) => calibrate(cal, p));

  // baselines on the test rows
  const lr = levelRates(rows, records, trainRows);
  const ruleP = (q) => lr.levels[BUCKETS[rows.b[q]].key][rows.lvl[q]] ?? climoTrain.base.all;
  const pRule = Array.from(testRows, ruleP);
  const pClimo = Array.from(testRows, (q) => pc[q]);

  // the model deployed now, scored on the same test hours the way the live scorer would
  let prevModel = null;
  const prevDir = opts.prev || (fx ? join(ROOT, "site/data/model") : null);
  if (prevDir) { try { prevModel = JSON.parse(await readFile(join(prevDir, "model.json"), "utf8")); } catch { /* none */ } }
  const current = currentModelCheck(prevModel, { avail, topHubs: meta.topHubs });
  let pCur = null;
  if (current.usable && current.comparable) {
    const pf = current.feats;
    pCur = Array.from(testRows, (q) => {
      const r = records[rows.rec[q]];
      const bi = rows.b[q];
      const f = featInput(r, bi);
      if (pf.programs) f.pg = prog ? prog.at(r.a, r.H - BUCKETS[bi].lo * HOUR, r.H) : null;
      if (pf.volume) Object.assign(f, volumeAt(prevModel.vol, r.a, r.mo, r.dw, r.lh));
      if (!pf.hubs) delete f.hc;
      return calibrate(prevModel.cal, modelRaw(prevModel, encode(f, BUCKETS[bi].key, pf), pc[q]));
    });
    current.overlap = fx ? "fixture run: the committed real model scored on synthetic hours"
      : prevModel.train?.to && prevModel.train.to >= split.test[0] ? `the deployed model was trained through ${prevModel.train.to}, inside the test period (its scores there are in-sample, which favours it)` : null;
  }
  current.trained = prevModel?.trained || null;
  current.period = prevModel ? { train: prevModel.train || null, test: prevModel.test || null } : null;

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
    const pk = [];
    const yy = [];
    testRows.forEach((q, i) => { if (sel(q, records[rows.rec[q]])) { pm.push(pTest[i]); pcc.push(pClimo[i]); pr.push(pRule[i]); if (pCur) pk.push(pCur[i]); yy.push(yTest[i]); } });
    return { pm, pc: pcc, pr, pk: pCur ? pk : null, y: yy };
  };
  const evalSet = (s) => {
    const sc = scoreSet(s.pm, s.pc, s.pr, s.y);
    if (s.pk) {
      const bk = brier(s.pk, s.y);
      sc.brier.current = bk;
      sc.bss.current = bk ? 1 - sc.brier.model / bk : null;
      sc.bss.currentVsClimo = sc.brier.climo ? 1 - bk / sc.brier.climo : null;
      sc.auc.current = auc(s.pk, s.y);
    }
    const rd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r4(v)]));
    return { n: sc.n, base: r4(sc.base), brier: rd(sc.brier), bss: rd(sc.bss), auc: rd(sc.auc), meanP: r4(s.pm.reduce((a, b) => a + b, 0) / Math.max(1, s.pm.length)) };
  };
  const all = sub(() => true);
  const test = evalSet(all);
  test.reliability = reliability(all.pm, all.y).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) }));
  test.reliabilityRule = reliability(all.pr, all.y).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) }));
  if (pCur) test.reliabilityCurrent = reliability(all.pk, all.y).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) }));
  test.byLead = Object.fromEntries(BUCKETS.map((b, bi) => [b.key, evalSet(sub((q) => rows.b[q] === bi))]));
  const aps = [...new Set(records.map((r) => r.a))].sort();
  test.byAirport = Object.fromEntries(aps.map((ap) => [ap, evalSet(sub((q, r) => r.a === ap))]).filter(([, v]) => v.n));
  // Freeze word support on the pre-test calibration block. Test outcomes evaluate it,
  // rather than selecting the displayed probability mapping or its conservative caps.
  const displaySupport = {
    on: vb.val, source: "pre-test calibration block", scoreMapping: "model isotonic only",
    reliability: reliability(main.pVal, yVal).map((b) => ({ ...b, meanP: r4(b.meanP), rate: r4(b.rate) })),
    byAirport: Object.fromEntries(aps.map((ap) => {
      const ix = Array.from(valRows.keys()).filter((i) => records[rows.rec[valRows[i]]].a === ap);
      const pm = ix.map((i) => main.pVal[i]);
      const yy = ix.map((i) => yVal[i]);
      const bc = brier(ix.map((i) => 1 / (1 + Math.exp(-xcFit[valRows[i]]))), yy);
      return [ap, { n: ix.length, bss: { climo: bc ? r4(1 - brier(pm, yy) / bc) : null } }];
    }).filter(([, v]) => v.n)),
  };
  const wordRows = new Map();
  testRows.forEach((q, i) => {
    const ap = records[rows.rec[q]].a;
    const L = likelihood({ p: pTest[i], pTypical: pc[q] }, { report: { displaySupport }, iata: ap, aviation: false });
    const b = wordRows.get(L.key) || { key: L.key, word: L.word, n: 0, k: 0, sumP: 0 };
    b.n++; b.k += yTest[i]; b.sumP += L.rate;
    wordRows.set(L.key, b);
  });
  test.displayWords = {
    supportOn: vb.val, evaluatedOn: split.test, scoreMapping: "model isotonic only", overrides: "not included in weather-only forecast rows",
    bands: [...wordRows.values()].map(({ sumP, ...b }) => ({ ...b, meanP: r4(sumP / b.n), rate: r4(b.k / b.n) })),
  };
  test.bySeason = Object.fromEntries(["winter", "spring", "summer", "fall"].map((s) => [s, evalSet(sub((q, r) => seasonOf(r.mo) === s))]).filter(([, v]) => v.n));
  // calibration by airport group (model, and the deployed model when it could be scored)
  const rc = (c) => (c ? { n: c.n, meanP: r4(c.meanP), rate: r4(c.rate), brier: r4(c.brier), ece: r4(c.ece), mid: c.mid ? { n: c.mid.n, meanP: r4(c.mid.meanP), rate: r4(c.mid.rate) } : null } : null);
  test.calibrationByGroup = Object.fromEntries([...Object.keys(AIRPORT_GROUPS), "Other", "all"].map((g) => {
    const s = sub((q, r) => g === "all" || groupOf(r.a) === g);
    return [g, { model: rc(calibrationSummary(s.pm, s.y)), current: s.pk ? rc(calibrationSummary(s.pk, s.y)) : null }];
  }).filter(([, v]) => v.model.n));
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

  // ---------- feature ablation (each family on/off; same lambda and calibration procedure) ----------
  let ablation = null;
  if (opts.ablation !== false && families.length) {
    const row = (label, on, res) => ({
      label, on, n: yTest.length, brier: r4(brier(res.pTest, yTest)), bss: r4(1 - brier(res.pTest, yTest) / brier(pClimo, yTest)), auc: r4(auc(res.pTest, yTest)),
    });
    ablation = [row("base features only", [], variant([]))];
    if (families.length > 1) for (const f of families) ablation.push(row(`base + ${f}`, [f], variant([f])));
    ablation.push(row(`all (${families.join(", ")})`, families, main));
    if (families.length > 1) for (const f of families) { const on = families.filter((x) => x !== f); ablation.push(row(`all without ${f}`, on, variant(on))); }
  }

  const g = gate(test, { minN: fx ? 100 : 200, current });

  // ---------- outputs ----------
  const outDir = opts.out || (fx ? join(tmpdir(), "airport-wx-train-fixture") : join(ROOT, "site/data/model"));
  await mkdir(join(outDir, "analogs"), { recursive: true });
  const since = months[0];
  const through = months[months.length - 1];
  const rwy = meta.rwy || {};
  const w = {};
  for (const [name, j] of rows.vocab) if (mask[j] && Math.abs(fit.w[j]) > 1e-6) w[name] = r4(fit.w[j]);
  const model = {
    v: 1, spec: SPEC, trained: now.toISOString(), date, fixtures: !!fx, since, through, months: months.length,
    train: { from: split.train[0], to: split.train[split.train.length - 1] }, test: { from: split.test[0], to: split.test[split.test.length - 1] },
    calibratedOn: { from: vb.val[0], to: vb.val[vb.val.length - 1] },
    lamp: feats.lamp, feats, lambda: best.lambda, b0: r4(fit.b0), wc: r4(fit.wc), w, cal, minutes, base: climoTrain.base.all, rwy,
  };
  if (feats.hubs) model.hubs = Object.fromEntries(aps.map((ap) => [ap, meta.topHubs?.[ap] || []]));
  if (feats.volume) model.vol = Object.fromEntries(Object.entries(vol).map(([ap, v]) => [ap, { q: v.q, f: v.f }]));
  // fallback + climatology from every month (the best estimate of "usual" for the live page)
  const climoAll = climatology(records);
  const lrAll = levelRates(rows, records, Uint32Array.from({ length: rows.n }, (_, i) => i));
  const minLvl = [0, 1, 2, 3, 4].map((l) => {
    const a = [];
    for (let q = 0; q < rows.n; q++) { const r = records[rows.rec[q]]; if (rows.lvl[q] === l && r.y && r.dm != null) a.push(r.dm); }
    return a.length >= 15 ? rnd(median(a)) : null;
  });
  let programs = null;
  if (opts.history) programs = programRates(history);
  else if (fx) programs = programRates(JSON.parse(await readFile(join(HERE, "fixtures/train/history-truth.json"), "utf8")));
  const fallback = {
    v: 1, spec: SPEC, source: fx ? "fixtures" : "train", built: now.toISOString(), since, through, months: months.length, def: DEF,
    levels: Object.fromEntries(Object.entries(lrAll.levels).map(([k, v]) => [k, v.slice(0, 5)])), levelsNoTaf: Object.fromEntries(Object.entries(lrAll.levels).map(([k, v]) => [k, v[5]])),
    minutes: minLvl, climo: climoAll.climo, base: climoAll.base, programs, rwy,
  };
  const analogs = buildAnalogs(records);
  const live = g.pass ? { basis: "model", modelDate: model.trained, thisRun: true }
    : modelOk(prevModel) ? { basis: "model", modelDate: prevModel.trained, thisRun: false }
      : { basis: "fallback", modelDate: null, thisRun: false };
  const progCov = prog ? prog.coverage : null;
  const report = {
    v: 1, date, generated: now.toISOString(), fixtures: !!fx, deployed: g.pass, gate: g, live,
    def: { ...DEF, text: DEF_TEXT },
    period: { since, through, months: months.length, train: split.train, test: split.test, winterInTest: split.winterInTest, calibration: vb.val },
    counts: { records: records.length, rows: rows.n, trainRows: trainRows.length, testRows: testRows.length, calibrationRows: valRows.length, airports: aps.length, realDelayHours: records.reduce((a, r) => a + r.y, 0), features: Object.keys(w).length, ...meta.counts },
    fit: { lambda: best.lambda, lambdas, oofLogLoss: r4(best.ll / Math.max(1, trainRows.length)), iterations: fit.iters, seconds: Math.round(fitSecs), calibration: { method: "isotonic", knots: cal.x.length, on: vb.val, rows: valRows.length } },
    features: { used: families, requested, unavailable, programsCoverage: progCov, programsRowsCovered: feats.programs ? countCovered(rows, records, prog) : null },
    current: { ...current, feats: current.feats || null },
    ablation,
    displaySupport,
    test,
    ruleRates: lr.levels,
    lamp: feats.lamp,
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
    files.push(join(opts.reports, `model-${date}.md`));
  }
  return { report, model, fallback, outDir, files };
}

/** Share of rows whose program state has a record (not "pg:none"). */
function countCovered(rows, records, prog) {
  if (!prog) return 0;
  let k = 0;
  for (let q = 0; q < rows.n; q++) { const r = records[rows.rec[q]]; if (prog.at(r.a, r.H - BUCKETS[rows.b[q]].lo * HOUR, r.H)) k++; }
  return r4(k / Math.max(1, rows.n));
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
  const F = rep.features || {};
  L.push(`- Optional features used: ${F.used?.length ? F.used.join(", ") : "none"}${F.unavailable?.length ? ` (asked for but not in the data: ${F.unavailable.join(", ")})` : ""}.${F.used?.includes("programs") ? ` FAA program records: ${F.programsCoverage?.lines ? `${int(F.programsCoverage.lines)} polls ${F.programsCoverage.from?.slice(0, 10)}..${F.programsCoverage.to?.slice(0, 10)}` : "none"}; ${pct(F.programsRowsCovered)} of rows covered, the rest "pg:none".` : ""}`);
  L.push(`- Calibration: isotonic, fitted on ${rep.period.calibration?.length ? rep.period.calibration.join(", ") : "–"} (${int(rep.fit.calibration.rows)} rows) as predicted by a fit on the months before them.`);
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
  const C = rep.current || {};
  L.push("## Compared with the deployed model (same test hours)");
  L.push("");
  if (T.brier.current != null) {
    L.push(`Deployed model trained ${C.trained?.slice(0, 10) || "?"} (train ${C.period?.train?.from || "?"}..${C.period?.train?.to || "?"}, features: ${Object.entries(C.feats || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "base"}), scored here as the live scorer would.${C.overlap ? " Note: " + C.overlap + "." : ""}`);
    L.push("");
    L.push(row(["", "Brier", "Skill vs climatology", "AUC"]));
    L.push(sep(4));
    L.push(row(["this run", f3(T.brier.model), f3(T.bss.climo), f3(T.auc.model)]));
    L.push(row(["deployed model", f3(T.brier.current), f3(T.bss.currentVsClimo), f3(T.auc.current)]));
    L.push(row(["climatology", f3(T.brier.climo), "0.000", f3(T.auc.climo)]));
    L.push(row(["rule mapping", f3(T.brier.rule), f3(T.bss.ruleVsClimo), f3(T.auc.rule)]));
  } else L.push(`Not compared: ${C.why || "no deployed model"}.`);
  L.push("");
  if (rep.ablation?.length) {
    L.push("## Feature ablation (test)");
    L.push("");
    L.push("Same lambda and calibration procedure for every row; skill is Brier skill vs climatology.");
    L.push("");
    L.push(row(["Features", "Brier", "Skill vs climatology", "AUC"]));
    L.push(sep(4));
    for (const a of rep.ablation) L.push(row([a.label, f3(a.brier), f3(a.bss), f3(a.auc)]));
    L.push("");
  }
  if (T.displayWords) {
    L.push("## Displayed delay words (untouched test)", "");
    L.push(`Probability comes directly from the pre-test isotonic model calibration. Word support and airport caps were frozen on ${T.displayWords.supportOn.join(", ")}; evaluated on ${T.displayWords.evaluatedOn.join(", ")}. FAA overrides are not represented by these weather-only rows.`, "");
    L.push(row(["Word", "Hours", "Mean predicted", "Observed disruption rate"]), sep(4));
    for (const b of T.displayWords.bands) L.push(row([b.word, int(b.n), pct(b.meanP), pct(b.rate)]));
    L.push("");
  }
  L.push("## Reliability (test)");
  L.push("");
  L.push(row(["Predicted", "Hours", "Mean predicted", "Observed", "Rule mapping: hours / observed"]));
  L.push(sep(5));
  T.reliability.forEach((b, i) => { const r = T.reliabilityRule[i]; L.push(row([`${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`, int(b.n), pct(b.meanP), pct(b.rate), `${int(r.n)} / ${pct(r.rate)}`])); });
  L.push("");
  if (T.calibrationByGroup) {
    L.push("## Calibration by airport group (test)");
    L.push("");
    L.push("ECE = hour-weighted gap between mean predicted and observed over 10 bins; \"50–80%\" = hours the model put at 50–80%.");
    L.push("");
    L.push(row(["Group", "Hours", "Mean predicted", "Observed", "Brier", "ECE", "50–80%: hours / predicted / observed", "Deployed model: mean predicted / ECE"]));
    L.push(sep(8));
    for (const [gname, v] of Object.entries(T.calibrationByGroup)) {
      const m = v.model;
      L.push(row([gname, int(m.n), pct(m.meanP), pct(m.rate), f3(m.brier), f3(m.ece), m.mid ? `${int(m.mid.n)} / ${pct(m.mid.meanP)} / ${pct(m.mid.rate)}` : "–", v.current ? `${pct(v.current.meanP)} / ${f3(v.current.ece)}` : "–"]));
    }
    L.push("");
  }
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
  const cur = T.brier.current != null;
  const d3 = (a, b) => (a == null || b == null ? "–" : (a - b >= 0 ? "+" : "") + (a - b).toFixed(3));
  L.push(row(["Airport", "Hours", "Base rate", "Mean predicted", "Brier", "Skill vs climatology", "Skill vs rule", "AUC", ...(cur ? ["Brier deployed", "Δ Brier", "AUC deployed", "Δ AUC"] : [])]));
  L.push(sep(cur ? 12 : 8));
  for (const [ap, s] of Object.entries(T.byAirport)) {
    L.push(row([ap, int(s.n), pct(s.base), pct(s.meanP), f3(s.brier.model), f3(s.bss.climo), f3(s.bss.rule), f3(s.auc.model),
      ...(cur ? [f3(s.brier.current), d3(s.brier.model, s.brier.current), f3(s.auc.current), d3(s.auc.model, s.auc.current)] : [])]));
  }
  L.push("");
  return L.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { report, outDir, files } = await train(opts);
  const T = report.test;
  console.log(`${report.fixtures ? "FIXTURE " : ""}test hours ${T.n}: Brier model ${f3(T.brier.model)} climo ${f3(T.brier.climo)} rule ${f3(T.brier.rule)}; skill vs climo ${f3(T.bss.climo)}, vs rule ${f3(T.bss.rule)}; AUC ${f3(T.auc.model)}`);
  if (T.brier.current != null) console.log(`deployed model on the same hours: Brier ${f3(T.brier.current)}, skill vs climo ${f3(T.bss.currentVsClimo)}, AUC ${f3(T.auc.current)}`);
  else console.log(`deployed model not compared: ${report.current?.why || "none"}`);
  for (const a of report.ablation || []) console.log(`ablation ${a.label}: Brier ${f3(a.brier)} skill ${f3(a.bss)} AUC ${f3(a.auc)}`);
  console.log(`gate: ${report.gate.pass ? "PASS — model.json written" : "FAIL — model.json not written: " + report.gate.reasons.join("; ")}`);
  console.log(`outputs in ${outDir}`);
  for (const f of files) console.log("wrote " + f);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
