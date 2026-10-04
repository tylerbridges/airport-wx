#!/usr/bin/env node
// Manual, bounded research collection. This command does not change app data or models.
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceObject, parseIndex, chooseFields, gribMessage, airportValues, joinTrainingHours, featureHour, PILOT_AIRPORTS } from "./noaa-forecast-lib.mjs";

const MB = 1000000;
export const LIMITS = { bytes: 16 * MB, messageBytes: 2 * MB, indexBytes: 200000, requests: 16, timeoutMs: 20000, runtimeMs: 180000 };
const UA = "airport-wx NOAA forecast research (github.com/tylerbridges/airport-wx)";
function assert(ok, message) { if (!ok) throw new Error(message); }
export async function boundedGet(url, { start = null, end = null, maxBytes, budget, fetcher = fetch } = {}) {
  assert(budget.requests < LIMITS.requests && budget.bytes < LIMITS.bytes && Date.now() - budget.started < LIMITS.runtimeMs, "Collection budget exhausted");
  const headers = { "User-Agent": UA };
  if (start != null) { assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end - start + 1 <= maxBytes, "Range exceeds field budget"); headers.Range = `bytes=${start}-${end}`; }
  budget.requests++;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(Math.min(LIMITS.timeoutMs, LIMITS.runtimeMs - (Date.now() - budget.started))) });
  const expected = start == null ? 200 : 206;
  if (response.status !== expected) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}, expected ${expected}`); }
  if (start != null) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
    if (!m || +m[1] !== start || +m[2] !== end) { await response.body?.cancel(); throw new Error("Range response does not match requested bytes"); }
  }
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes || budget.bytes + length > LIMITS.bytes) { await response.body?.cancel(); throw new Error("Response exceeds collection byte budget"); }
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      size += r.value.length; budget.bytes += r.value.length;
      if (size > maxBytes || budget.bytes > LIMITS.bytes) { await reader.cancel(); throw new Error("Stream exceeds collection byte budget"); }
      chunks.push(Buffer.from(r.value));
    }
  } finally { reader.releaseLock(); }
  assert(start == null || size === end - start + 1, "Truncated Range response");
  const lastModified = response.headers.get("last-modified");
  assert(Number.isFinite(Date.parse(lastModified)), "Missing usable S3 Last-Modified");
  return { bytes: Buffer.concat(chunks), lastModified: new Date(lastModified).toISOString(), etag: response.headers.get("etag"), fetchedAt: new Date().toISOString() };
}
function quantity(model, field, m) {
  const definitions = { GUST: [2, 22, "m/s"], VIS: [19, 0, "m"], LTNG: [17, 192, "NOAA local lightning proxy; units not interpreted"], TSTM: [19, 2, "% thunderstorm forecast, not flight-delay probability"] };
  const d = definitions[field];
  assert(d && m.discipline === 0 && m.category === d[0] && m.parameter === d[1], "Index field and GRIB parameter disagree");
  assert(field !== "LTNG" || model === "hrrr", "Local lightning proxy is HRRR-specific");
  assert(field !== "TSTM" || model === "nbm" && m.productTemplate === 8 && m.interval?.hours === 1, "Only one-hour NBM thunderstorm forecasts are supported");
  return d[2];
}
export async function collect({ cycles, models = ["hrrr", "nbm"], lead = 3, out, dataset = null, fetcher = fetch }) {
  assert(Array.isArray(cycles) && cycles.length >= 1 && cycles.length <= 2, "Collect one or two explicit cycles");
  assert(models.length >= 1 && models.length <= 2 && new Set(models).size === models.length, "Collect one or two distinct models");
  assert(out && !resolve(out).includes(`${resolve(fileURLToPath(new URL("..", import.meta.url)))}/site`), "Research output must be outside site/");
  await mkdir(out, { recursive: true }); await mkdir(join(out, "messages"), { recursive: true });
  const budget = { requests: 0, bytes: 0, started: Date.now() }, rows = [], objects = [], errors = [];
  for (const cycle of cycles) for (const model of models) {
    let source;
    try {
      source = sourceObject(model, cycle, lead);
      const index = await boundedGet(`${source.url}.idx`, { maxBytes: LIMITS.indexBytes, budget, fetcher });
      const selected = chooseFields(parseIndex(index.bytes.toString("utf8")), model);
      assert(selected.every((r) => r.cycle === source.cycle), "Index cycle does not match request");
      const name = `${model}-${source.cycle.slice(0, 13).replaceAll(/[-:T]/g, "")}-f${lead}`;
      await writeFile(join(out, "messages", `${name}.idx`), index.bytes);
      for (const field of selected) {
        try {
          const data = await boundedGet(source.url, { start: field.offset, end: field.end, maxBytes: LIMITS.messageBytes, budget, fetcher });
          const m = gribMessage(data.bytes);
          assert(m.cycle === source.cycle && Date.parse(m.valid) === Date.parse(source.cycle) + lead * 3600000, "GRIB cycle/valid time disagrees with requested forecast");
          const units = quantity(model, field.field, m);
          const values = airportValues(m);
          const artifact = `${name}-${field.field}.grib2`;
          await writeFile(join(out, "messages", artifact), data.bytes);
          const provenance = { model, field: field.field, cycle: m.cycle, valid: m.valid, forecastHour: m.leadHours, interval: m.interval, units, url: source.url, start: field.offset, end: field.end, bytes: data.bytes.length, sha256: createHash("sha256").update(data.bytes).digest("hex"), etag: data.etag, indexEtag: index.etag, objectLastModified: data.lastModified, indexLastModified: index.lastModified, fetchedAt: data.fetchedAt, publicationLagMinutes: (Math.max(Date.parse(data.lastModified), Date.parse(index.lastModified)) - Date.parse(m.cycle)) / 60000, gridTemplate: 30, packingTemplate: 3, artifact };
          objects.push(provenance); rows.push(...values.map((v) => ({ ...provenance, ...v })));
          console.log(`${model} ${m.cycle} ${field.field}: ${data.bytes.length} bytes, ${values.filter((v) => v.value != null).length}/${values.length} points`);
        } catch (e) { errors.push({ model, cycle, field: field.field, error: e.message }); }
      }
    } catch (e) { errors.push({ model, cycle, error: e.message }); }
  }
  const training = dataset ? await summarizeTraining(dataset, rows, out) : null;
  const report = { v: 1, generated: new Date().toISOString(), artifactOnly: true, activeModelChanged: false, sources: ["https://registry.opendata.aws/noaa-hrrr-pds/", "https://registry.opendata.aws/noaa-nbm/"], availabilityBasis: "maximum object/index S3 Last-Modified, with receipt required for live joins; historical first-publication times are not guaranteed", limits: LIMITS, budget: { requests: budget.requests, bytes: budget.bytes, elapsedMs: Date.now() - budget.started }, objects, rows, errors, training, conclusion: "Access and extraction evidence only. No incremental prediction-skill claim; no flight, gate or inbound-aircraft inference." };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
export async function summarizeTraining(dataset, rows, out) {
  const hours = new Set(rows.map(featureHour).filter((h) => h != null)), airports = new Set(PILOT_AIRPORTS.map((a) => a.iata)), records = [];
  let totalRecords = 0, totalForecastRows = 0;
  const source = createReadStream(dataset), input = createGunzip();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const complete = pipeline(source, input);
  complete.catch(() => lines.close());
  try {
    for await (const line of lines) {
      if (!line.trim()) continue; const r = JSON.parse(line); totalRecords++;
      totalForecastRows += r.f.filter((f) => f != null).length;
      if (hours.has(r.H) && airports.has(r.a)) records.push(r);
    }
    await complete;
  } finally { lines.close(); source.destroy(); input.destroy(); }
  const joined = joinTrainingHours(records, rows);
  const present = joined.filter((r) => Object.values(r.features).some((f) => f != null));
  await writeFile(join(out, "training-join.jsonl"), joined.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { totalRecords, totalForecastRows, candidateRecords: records.length, joinedRows: joined.length, rowsWithAnyFeature: present.length, coverage: totalForecastRows ? present.length / totalForecastRows : 0, byBucket: [0, 1, 2, 3].map((bucket) => ({ bucket, rows: present.filter((r) => r.bucket === bucket).length })), scoreStatus: "not-evaluated: sparse extraction pilot cannot establish incremental skill", deployedReference: { modelDate: "2026-10-03", fullCohortBrier: 0.1534, note: "Reference only, not a matched pilot-cohort comparison" }, metrics: { priorBrier: null, candidateBrier: null, climatologyBrier: null, ruleBrier: null, airportMetrics: null, calibration: null }, promotionEligible: false, promotionRequirements: ["Representative causal archive covering airports, seasons and all lead buckets", "Strictly untouched test rows shared with deployed model, climatology and rules", "Better Brier than all three comparators with sound calibration", "Airport, lead and missing-input breakdowns", "Displayed words verified independently of training/calibration data"] };
}
export async function replay(reportPath, dataset = null) {
  const out = dirname(resolve(reportPath)), report = JSON.parse(await readFile(reportPath, "utf8")), rows = [];
  assert(report.artifactOnly === true && Array.isArray(report.objects), "Not a NOAA pilot artifact report");
  for (const source of report.objects) {
    assert(source.artifact === basename(source.artifact), "Unsafe artifact path");
    const raw = await readFile(join(out, "messages", source.artifact));
    assert(createHash("sha256").update(raw).digest("hex") === source.sha256, "Saved GRIB message checksum differs");
    const m = gribMessage(raw);
    assert(m.cycle === source.cycle && m.valid === source.valid, "Saved GRIB cycle/valid differs");
    source.forecastHour = m.leadHours;
    source.units = quantity(source.model, source.field, m);
    source.interval = m.interval;
    rows.push(...airportValues(m).map((point) => ({ ...source, ...point })));
  }
  report.rows = rows;
  report.replayedAt = new Date().toISOString();
  report.replayNetworkRequests = 0;
  if (dataset) report.training = await summarizeTraining(dataset, rows, out);
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i].startsWith("--") && args[i + 1] && ["--cycles", "--models", "--lead", "--out", "--dataset", "--replay"].includes(args[i]), `Unknown or incomplete option ${args[i]}`);
    opts[args[i].slice(2)] = args[i + 1];
  }
  assert(opts.replay || opts.cycles && opts.out, "Usage: node tools/noaa-forecast-pilot.mjs --cycles UTC-CYCLE[,UTC-CYCLE] --out OUTSIDE-SITE [--models hrrr,nbm] [--lead 3] [--dataset dataset.jsonl.gz]; or --replay report.json [--dataset dataset.jsonl.gz]");
  const report = opts.replay ? await replay(opts.replay, opts.dataset) : await collect({ cycles: opts.cycles.split(","), models: opts.models?.split(","), lead: opts.lead == null ? 3 : Number(opts.lead), out: resolve(opts.out), dataset: opts.dataset });
  console.log(JSON.stringify({ bytes: report.budget.bytes, requests: report.budget.requests, airportValues: report.rows.length, failures: report.errors.length, training: report.training }));
  if (report.errors.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
