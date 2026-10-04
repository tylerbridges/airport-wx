// Artifact-only causal MRMS research evaluation. Never writes a deployable model.
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT, MAX_AGE_MS } from "./mrms-lib.mjs";
import { readDataset } from "./train-data.mjs";
import { timeSplit, validationBlock, climatology, featInput, fitLogistic, predictRows, isotonicFit, brier, auc, reliability, calibrationSummary, contingency } from "./train-lib.mjs";
import { BUCKETS, encode, modelRaw, modelOk, featsOf, calibrate, typicalRate, logit } from "../poller/delay.mjs";

const HOUR = 3600e3;
const round = (v) => v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
export const SUPPORT_POLICY = Object.freeze({ minPhaseCoverage: 0.8, minDistinctDates: 8, minObservedStormRows: 20, minObservedNonstormRows: 20 });
export function comparisonGate(metrics) {
  const reasons = [];
  for (const k of ["baseRefitWithoutPilot", "deployed", "climatology", "rule"]) if (!(metrics.pilot.brier < metrics[k].brier)) reasons.push(`pilot does not beat ${k} Brier on the same held-out rows`);
  const ece = metrics.pilot.calibration.ece, references = ["deployed", "baseRefitWithoutPilot"];
  if (!Number.isFinite(ece) || references.some((k) => !Number.isFinite(metrics[k].calibration.ece))) reasons.push("calibration ECE comparison unavailable");
  else {
    for (const k of references) if (ece > metrics[k].calibration.ece + 1e-6) reasons.push(`pilot calibration ECE ${round(ece)} worsens versus ${k} ${round(metrics[k].calibration.ece)}`);
    if (!references.some((k) => ece < metrics[k].calibration.ece - 1e-6)) reasons.push("pilot must improve calibration ECE versus deployed or control, without worsening either");
  }
  return { pass: !reasons.length, reasons };
}
export function frameIndex(frames) {
  const index = new Map(), seen = new Set();
  for (const frame of frames) {
    if (frame.product !== PRODUCT || frame.source?.status !== "available" || !Number.isFinite(Date.parse(frame.source.validAt)) || !Number.isFinite(Date.parse(frame.source.publishedAt))) continue;
    for (const airport of frame.airports || []) {
    const key = `${airport.iata}|${frame.source?.key}|${frame.source?.validAt}|${frame.source?.publishedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = index.get(airport.iata) || []; list.push({ frame, airport }); index.set(airport.iata, list);
    }
  }
  for (const list of index.values()) list.sort((a, b) => Date.parse(a.frame.source?.validAt) - Date.parse(b.frame.source?.validAt));
  return index;
}
/** Both publication and valid time must precede prediction. Source age expires after 15 minutes. */
export function causalFrame(frames, iata, prediction) {
  let best = null;
  const list = frames instanceof Map ? frames.get(iata) || [] : frames.map((frame) => ({ frame, airport: frame.airports?.find((a) => a.iata === iata) }));
  let end = list.length;
  if (frames instanceof Map) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (Date.parse(list[m].frame.source?.validAt) <= prediction) lo = m + 1; else hi = m; }
    end = lo;
  }
  for (let i = end - 1; i >= 0; i--) {
    const { frame: f, airport: a } = list[i];
    const valid = Date.parse(f.source?.validAt), published = Date.parse(f.source?.publishedAt);
    if (frames instanceof Map && prediction - valid > MAX_AGE_MS) break;
    if (f.product !== PRODUCT || !f.researchOnly || f.source?.status !== "available" || !Number.isFinite(valid) || !Number.isFinite(published) || published < valid || published > prediction || valid > prediction || prediction - valid > MAX_AGE_MS || !a || a.near?.status !== "available" || a.surrounding?.status !== "available") continue;
    if (!best || valid > Date.parse(best.frame.source.validAt)) best = { frame: f, airport: a };
  }
  return best;
}
export function pilotNames(a) {
  const names = [];
  for (const [prefix, b] of [["near", a.near], ["surround", a.surrounding]]) {
    if (b.status !== "available" || !(b.coverage >= 0.8 && b.coverage <= 1) || ![b.maxDbz, b.fraction35, b.fraction45].every(Number.isFinite) || b.fraction35 < 0 || b.fraction35 > 1 || b.fraction45 < 0 || b.fraction45 > b.fraction35 || b.maxDbz < -40 || b.maxDbz > 100) throw new Error("MRMS pilot features require known coverage");
    for (const n of [35, 45, 55]) if (b.maxDbz >= n) names.push(`${prefix}:max${n}`);
    for (const n of [0.05, 0.2, 0.5]) if (b.fraction35 >= n) names.push(`${prefix}:f35:${n}`);
    if (b.fraction45 >= 0.05) names.push(`${prefix}:f45`);
  }
  if (!a.recentChange) names.push("change:missing");
  else if (a.recentChange.fraction35 >= 0.05) names.push("change:rising");
  else if (a.recentChange.fraction35 <= -0.05) names.push("change:falling");
  return names;
}
async function frameFiles(dir) {
  const out = [];
  async function walk(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const p = resolve(path, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json") && (await stat(p)).size <= 200_000) {
        const f = JSON.parse(await readFile(p, "utf8"));
        if (f.product === PRODUCT && f.researchOnly && f.source && Array.isArray(f.airports)) out.push(f);
        if (out.length > 5000) throw new Error("pilot exceeds 5000 compact frame budget");
      }
    }
  }
  await walk(dir); return out;
}
const score = (p, y) => ({ n: y.length, brier: round(brier(p, y)), auc: round(auc(p, y)), calibration: calibrationSummary(p, y), reliability: reliability(p, y), falseAlarmsAtHalf: contingency(p.map((p) => p >= 0.5), y) });

export async function evaluate({ records, frames, model, leadHours = [0, 3], sampleHours = Array.from({ length: 24 }, (_, i) => i), minRows = 200 } = {}) {
  if (!modelOk(model) || Object.values(featsOf(model)).some(Boolean)) throw new Error("pilot currently requires a usable base-only deployed comparator; other families need audited matching inputs");
  if (leadHours.some((h) => h !== 0 && h !== 3)) throw new Error("packed dataset supports exact prediction cutoffs at 0 and 3 hours only, not 1/2 hour forecasts");
  if (!sampleHours.length || sampleHours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) throw new Error("sampling hours must be prespecified UTC hours 0–23");
  const months = [...new Set(records.map((r) => r.ym))].sort(), split = timeSplit(months, { testCount: 4 }), vb = validationBlock(split.train, 2);
  const fitMonths = new Set(vb.fit), valMonths = new Set(vb.val), trainMonths = new Set(split.train), testMonths = new Set(split.test);
  const climo = climatology(records.filter((r) => trainMonths.has(r.ym)));
  const ruleRates = new Map();
  for (const r of records) if (trainMonths.has(r.ym)) for (const lead of leadHours) {
    const bi = lead === 0 ? 0 : 1, key = `${bi}|${r.f[bi]?.w?.l ?? "missing"}`, s = ruleRates.get(key) || [0, 0];
    s[0] += r.y; s[1]++; ruleRates.set(key, s);
  }
  const rows = [], coverage = { records: records.length, attempted: 0, matched: 0, byAirport: {}, byLead: {} };
  const indexed = frameIndex(frames);
  const cohortAirports = new Set(frames.flatMap((f) => (f.airports || []).map((a) => a.iata)));
  const phaseAttempts = { fit: 0, calibration: 0, test: 0 };
  for (const r of records) for (const lead of leadHours) {
    const bi = lead === 0 ? 0 : 1;
    if (!r.f[bi]) continue;
    coverage.attempted++;
    const cohort = cohortAirports.has(r.a) && sampleHours.includes(new Date(r.H).getUTCHours());
    if (cohort) { const phase = fitMonths.has(r.ym) ? "fit" : valMonths.has(r.ym) ? "calibration" : testMonths.has(r.ym) ? "test" : null; if (phase) phaseAttempts[phase]++; }
    const ap = coverage.byAirport[r.a] ||= { attempted: 0, matched: 0 }, lb = coverage.byLead[lead] ||= { attempted: 0, matched: 0 }; ap.attempted++; lb.attempted++;
    const joined = causalFrame(indexed, r.a, r.H - lead * HOUR);
    if (!joined || !cohort) continue;
    const f = featInput(r, bi), typical = typicalRate(climo, r.a, r.mo, r.lh), pc = typical?.p ?? climo.base.all;
    const base = calibrate(model.cal, modelRaw(model, encode(f, BUCKETS[bi].key, featsOf(model)), pc));
    const rr = ruleRates.get(`${bi}|${r.f[bi]?.w?.l ?? "missing"}`);
    rows.push({ r, lead, base, pc, rule: rr ? rr[0] / rr[1] : climo.base.all, names: pilotNames(joined.airport), frameKey: joined.frame.source.key || joined.frame.source.validAt });
    coverage.matched++; ap.matched++; lb.matched++;
  }
  const partition = (set) => rows.map((r, i) => set.has(r.r.ym) ? i : -1).filter((i) => i >= 0);
  const fit = partition(fitMonths), val = partition(valMonths), train = partition(trainMonths), test = partition(testMonths);
  const support = Object.fromEntries([["fit", fit], ["calibration", val], ["test", test]].map(([k, ix]) => [k, { n: ix.length, positive: ix.filter((i) => rows[i].r.y).length, negative: ix.filter((i) => !rows[i].r.y).length, uniqueAirportHours: new Set(ix.map((i) => `${rows[i].r.a}|${rows[i].r.H}`)).size, distinctDates: new Set(ix.map((i) => new Date(rows[i].r.H).toISOString().slice(0, 10))).size, observedStorm: ix.filter((i) => rows[i].names.includes("near:max35")).length, observedNonstorm: ix.filter((i) => !rows[i].names.includes("near:max35")).length, cohortAttempts: phaseAttempts[k], cohortCoverage: phaseAttempts[k] ? round(ix.length / phaseAttempts[k]) : 0, months: [...new Set(ix.map((i) => rows[i].r.ym))].sort() }]));
  const limits = ["MRMS publication uses S3 LastModified, not actual historical receipt; missing reflectivity is never clear.", "Sparse/storm-only coverage can bias this research subset; all-condition coverage must be audited before deployment.", "Exact cutoffs 0 and 3 hours only; packed dataset does not establish forecasts at 1/2 hours.", "Historical holdout was used in earlier model selection; this is a reused historical comparison, not prospective evidence.", "BTS airport-hour weather/NAS disruption proxy; repeated leads share outcomes.", "No model is deployable from this evaluator; production needs full coverage, untouched future validation and existing model gate."];
  const report = { v: 1, researchOnly: true, product: PRODUCT, generated: new Date().toISOString(), frames: frames.length, uniqueFrameTimes: new Set(frames.map((f) => f.source?.validAt).filter((t) => Number.isFinite(Date.parse(t)))).size, period: { train: split.train, calibration: vb.val, test: split.test }, leadHours, sampling: { airports: [...cohortAirports].sort(), verifyingHoursUTC: sampleHours, requirement: "declare systematic sampling hours before feature collection/evaluation; do not select storms or outcomes" }, supportPolicy: SUPPORT_POLICY, coverage, support, limitations: limits, gate: { pass: false, reasons: [] }, status: "insufficient-data" };
  for (const [part, s] of Object.entries(support)) if (s.n < minRows || s.positive < 20 || s.negative < 20) report.gate.reasons.push(`${part}: need >= ${minRows} matched rows and >= 20 outcomes of each class; have ${s.n}/${s.positive}/${s.negative}`);
  for (const [part, s] of Object.entries(support)) {
    if (s.cohortCoverage < SUPPORT_POLICY.minPhaseCoverage) report.gate.reasons.push(`${part}: cohort numeric coverage ${s.cohortCoverage} below frozen ${SUPPORT_POLICY.minPhaseCoverage}`);
    if (s.distinctDates < SUPPORT_POLICY.minDistinctDates || s.observedStorm < SUPPORT_POLICY.minObservedStormRows || s.observedNonstorm < SUPPORT_POLICY.minObservedNonstormRows) report.gate.reasons.push(`${part}: insufficient distinct dates or observed storm/nonstorm support`);
  }
  if (report.gate.reasons.length) return report;
  // Prespecified lambda and feature thresholds; neither is selected on test outcomes.
  const vocab = new Map([...new Set(rows.flatMap((r) => r.names))].sort().map((k, i) => [k, i]));
  const off = new Uint32Array(rows.length + 1), indices = [];
  rows.forEach((r, i) => { off[i] = indices.length; for (const n of r.names) indices.push(vocab.get(n)); }); off[rows.length] = indices.length;
  const X = { off, idx: Uint32Array.from(indices), xc: Float64Array.from(rows, (r) => logit(r.base)), y: Uint8Array.from(rows, (r) => r.r.y), V: vocab.size };
  const variant = (pilot) => {
    const mask = new Uint8Array(vocab.size).fill(pilot ? 1 : 0);
    const fv = fitLogistic({ ...X, mask, rows: Uint32Array.from(fit), lambda: 100 });
    const cal = isotonicFit(Array.from(predictRows({ ...X, mask, rows: Uint32Array.from(val), fit: fv })), val.map((i) => rows[i].r.y));
    const final = fitLogistic({ ...X, mask, rows: Uint32Array.from(train), lambda: 100, init: fv.beta });
    return Array.from(predictRows({ ...X, mask, rows: Uint32Array.from(test), fit: final }), (p) => calibrate(cal, p));
  };
  const y = test.map((i) => rows[i].r.y), base = test.map((i) => rows[i].base), pilot = variant(true), control = variant(false), pc = test.map((i) => rows[i].pc), rule = test.map((i) => rows[i].rule);
  const metrics = { pilot: score(pilot, y), baseRefitWithoutPilot: score(control, y), deployed: score(base, y), climatology: score(pc, y), rule: score(rule, y) };
  report.status = "evaluated"; report.metrics = metrics; report.gate = comparisonGate(metrics);
  report.testRows = test.map((i, j) => ({ iata: rows[i].r.a, verifyingAt: new Date(rows[i].r.H).toISOString(), leadHours: rows[i].lead, y: y[j], pilot: round(pilot[j]), deployed: round(base[j]), frameKey: rows[i].frameKey }));
  report.byLead = Object.fromEntries(leadHours.map((lead) => {
    const ix = test.map((i, j) => rows[i].lead === lead ? j : -1).filter((i) => i >= 0), yy = ix.map((i) => y[i]);
    return [lead, { pilot: score(ix.map((i) => pilot[i]), yy), deployed: score(ix.map((i) => base[i]), yy) }];
  }));
  report.byAirport = Object.fromEntries([...new Set(test.map((i) => rows[i].r.a))].map((iata) => {
    const ix = test.map((i, j) => rows[i].r.a === iata ? j : -1).filter((i) => i >= 0), yy = ix.map((i) => y[i]);
    return [iata, { pilot: score(ix.map((i) => pilot[i]), yy), deployed: score(ix.map((i) => base[i]), yy) }];
  }));
  return report;
}
async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i], v = () => process.argv[++i];
    if (k === "--data" || k === "--frames" || k === "--out" || k === "--model") args[k.slice(2)] = resolve(v());
    else if (k === "--sample-hours") args.sampleHours = v().split(",").map(Number);
    else throw new Error(`unknown argument ${k}`);
  }
  if (!args.data || !args.frames || !args.out) throw new Error("usage: mrms-evaluate.mjs --data dir --frames compact-json-dir --out report.json [--model model.json]");
  const records = await readDataset(args.data), frames = await frameFiles(args.frames), model = JSON.parse(await readFile(args.model || new URL("../site/data/model/model.json", import.meta.url), "utf8"));
  const report = await evaluate({ records, frames, model, ...(args.sampleHours ? { sampleHours: args.sampleHours } : {}) });
  await mkdir(dirname(args.out), { recursive: true }); await writeFile(args.out, JSON.stringify(report) + "\n");
  console.log(JSON.stringify({ out: args.out, status: report.status, frames: report.frames, coverage: report.coverage, support: report.support, gate: report.gate }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
