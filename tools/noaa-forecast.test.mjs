import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { sourceObject, parseIndex, chooseFields, gribMessage, unpack53, nearestPoint, airportValues, availability, selectForHour, joinTrainingHours, featureHour } from "./noaa-forecast-lib.mjs";
import { boundedGet, collect, replay, summarizeTraining, LIMITS } from "./noaa-forecast-pilot.mjs";

const fixture = gunzipSync(Buffer.from(await readFile(new URL("./fixtures/noaa/hrrr-2026070100-f03-ltng.grib2.gz.b64", import.meta.url), "utf8"), "base64"));
const reference = JSON.parse(await readFile(new URL("./fixtures/noaa/hrrr-2026070100-f03-ltng.json", import.meta.url), "utf8"));
const message = gribMessage(fixture);
const basePacking = { template: 3, count: 6, reference: 0, binaryScale: 0, decimalScale: 0, referenceBits: 2, originalType: 0, splitting: 1, missing: 0, groups: 2, widthReference: 2, widthBits: 0, lengthReference: 3, lengthIncrement: 1, lastLength: 3, lengthBits: 0, order: 1, descriptorBytes: 1 };
function packed(descriptors, refs, data) {
  const bits = data.map((x) => x.toString(2).padStart(2, "0")).join("").padEnd(Math.ceil(data.length * 2 / 8) * 8, "0");
  return Buffer.from([...descriptors, refs, ...bits.match(/.{8}/g).map((s) => parseInt(s, 2))]);
}
const provenance = { iata: "ORD", model: "nbm", field: "GUST", value: 9.1, cycle: "2026-07-01T00:00:00Z", valid: "2026-07-01T03:00:00Z", objectLastModified: "2026-07-01T01:07:10Z", indexLastModified: "2026-07-01T01:07:15Z", fetchedAt: "2026-10-04T21:30:00Z" };

test("NOAA source paths and index select bounded deterministic fields", () => {
  assert.match(sourceObject("hrrr", "2026-07-01T00:00:00Z", 3).url, /hrrr\.20260701\/conus\/hrrr\.t00z\.wrfsfcf03\.grib2$/);
  assert.match(sourceObject("nbm", "2026-07-01T00:00:00Z", 3).url, /blend\.20260701\/00\/core\/blend\.t00z\.core\.f003\.co\.grib2$/);
  assert.throws(() => sourceObject("hrrr", "2026-07-01T00:30:00Z", 3), /whole hour/);
  assert.throws(() => sourceObject("hrrr", "2026-07-01T00:00:00Z", 48), /1–18/);
  const rows = parseIndex("1:0:d=2026070100:GUST:10 m above ground:3 hour fcst:\n2:10:d=2026070100:GUST:10 m above ground:3 hour fcst:ens std dev\n3:20:d=2026070100:VIS:surface:3 hour fcst:\n4:30:d=2026070100:TSTM:surface:2-3 hour acc fcst:probability forecast\n5:40:d=2026070100:TMP:2 m above ground:3 hour fcst:");
  assert.deepEqual(chooseFields(rows, "nbm").map((r) => [r.field, r.offset, r.end]), [["GUST", 0, 9], ["VIS", 20, 29], ["TSTM", 30, 39]]);
  assert.throws(() => parseIndex("1:10:d=2026070100:VIS:surface:x\n2:10:d=2026070100:GUST:surface:x"), /offsets/);
  assert.throws(() => parseIndex("<html>Robot check</html>"), /index line/);
});

test("complex packing restores hand-calculated first and second differences and scales", () => {
  assert.deepEqual([...unpack53(basePacking, packed([10, 130], 16, [0, 3, 0, 1, 2, 3]))], [10, 11, 9, 9, 10, 12]);
  const p = { ...basePacking, order: 2, reference: 1, binaryScale: 1, decimalScale: 1 };
  const actual = [...unpack53(p, packed([10, 11, 130], 16, [0, 0, 2, 0, 2, 1]))];
  [2.1, 2.3, 2.5, 2.5, 2.7, 2.9].forEach((x, i) => assert.ok(Math.abs(x - actual[i]) < 1e-12));
});

test("missing grid points preserve differencing over nonmissing values", () => {
  const p = { ...basePacking, order: 2, missing: 1 };
  const actual = [...unpack53(p, packed([10, 11, 130], 16, [0, 3, 0, 0, 2, 3]))];
  assert.deepEqual(actual, [10, NaN, 11, 11, 12, NaN]);
});

test("complex packing rejects malformed lengths, truncated bits and unsupported options", () => {
  assert.throws(() => unpack53({ ...basePacking, lastLength: 2 }, packed([10, 130], 16, [0, 3, 0, 1, 2, 3])), /Group lengths/);
  assert.throws(() => unpack53(basePacking, Buffer.from([10, 130, 16])), /Group lengths/);
  assert.throws(() => unpack53({ ...basePacking, widthBits: 32 }, Buffer.alloc(100)), /descriptor/);
  assert.throws(() => unpack53({ ...basePacking, order: 3 }, Buffer.alloc(100)), /bounds/);
  assert.throws(() => unpack53({ ...basePacking, missing: 4 }, Buffer.alloc(100)), /options/);
});

test("real HRRR field matches NOAA reference decoding, including nonzero storm pixels", () => {
  assert.equal(createHash("sha256").update(fixture).digest("hex"), reference.sha256);
  assert.equal(message.cycle, "2026-07-01T00:00:00.000Z");
  assert.equal(message.valid, "2026-07-01T03:00:00.000Z");
  assert.equal(message.grid.points, 1905141);
  const values = unpack53(message.packing, message.packed);
  reference.points.forEach((p) => assert.ok(Math.abs(values[p.index] - p.value) <= Math.max(1e-6, Math.abs(p.value) * 1e-6)));
  assert.ok(values[1134356] > 20);
  assert.deepEqual(airportValues(message).map((r) => [r.iata, r.quality, r.value]), [["ORD", "available", 0], ["MSP", "available", 0], ["SFO", "available", 0]]);
});

test("Lambert point lookup preserves origins, alternate row order and out-of-grid coverage", () => {
  const g = message.grid;
  assert.equal(nearestPoint(g, g.lat1, g.lon1).index, 0);
  const ord = nearestPoint(g, 41.9786, -87.9048);
  assert.equal(ord.index, 1210092);
  const alternate = nearestPoint({ ...g, scan: g.scan | 16 }, 44.882, -93.2218);
  assert.equal(alternate.index, alternate.j * g.nx + g.nx - 1 - alternate.i);
  assert.equal(nearestPoint(g, 60, -160), null);
});

test("real NBM field validates alternate scanning, thunder interval and reference values", async () => {
  const raw = gunzipSync(Buffer.from(await readFile(new URL("./fixtures/noaa/nbm-2026070100-f03-tstm.grib2.gz.b64", import.meta.url), "utf8"), "base64"));
  const ref = JSON.parse(await readFile(new URL("./fixtures/noaa/nbm-2026070100-f03-tstm.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), ref.sha256);
  const m = gribMessage(raw), values = unpack53(m.packing, m.packed);
  assert.equal(m.grid.scan, 80); assert.equal(m.productTemplate, 8);
  assert.deepEqual(m.interval, { processing: 1, hours: 1 });
  ref.points.forEach((p) => assert.equal(Number.isFinite(values[p.index]) ? values[p.index] : null, p.value));
  assert.deepEqual(airportValues(m).map((r) => r.value), [2, 1, 0]);
  assert.equal(featureHour(m), Date.parse("2026-07-01T02:00:00Z"));
});

test("unsupported GRIB bitmap and scan and incomplete data fail explicitly", () => {
  assert.throws(() => gribMessage(fixture.subarray(0, fixture.length - 1)), /Incomplete/);
  const bitmap = Buffer.from(fixture), scan = Buffer.from(fixture);
  let pos = 16;
  while (pos < fixture.length - 4) {
    const n = fixture.readUInt32BE(pos), s = fixture[pos + 4];
    if (s === 6) bitmap[pos + 5] = 0;
    if (s === 3) scan[pos + 64] |= 32;
    pos += n;
  }
  assert.throws(() => gribMessage(bitmap), /Bitmap/);
  assert.throws(() => gribMessage(scan), /scan mode/);
});

test("historical joins use conservative publication times, live joins also require receipt", () => {
  assert.equal(availability(provenance, "2026-07-01T00:00:00Z").eligible, false);
  assert.equal(availability(provenance, "2026-07-01T01:07:10Z").eligible, false);
  assert.equal(availability(provenance, "2026-07-01T03:00:00Z").eligible, true);
  assert.equal(availability(provenance, "2026-07-01T03:00:00Z", { mode: "live" }).eligible, false);
  assert.equal(availability({ ...provenance, indexLastModified: null }, "2026-07-01T03:00:00Z").reason, "missing-availability-provenance");
  assert.equal(availability(provenance, "2026-07-02T03:00:00Z").reason, "stale-or-future-cycle");
});

test("causal selection rejects future runs, missing values and wrong valid hours", () => {
  const old = { ...provenance, cycle: "2026-06-30T21:00:00Z", objectLastModified: "2026-06-30T22:00:00Z", indexLastModified: "2026-06-30T22:01:00Z" };
  assert.equal(selectForHour([old, provenance], { iata: "ORD", model: "nbm", field: "GUST", predictionTime: "2026-07-01T00:00:00Z", validTime: provenance.valid }), old);
  assert.equal(selectForHour([{ ...old, value: null }], { iata: "ORD", model: "nbm", field: "GUST", predictionTime: "2026-07-01T00:00:00Z", validTime: provenance.valid }), null);
  const rows = joinTrainingHours([{ a: "ORD", H: Date.parse(provenance.valid), y: 1, f: [{}, {}, {}, null] }], [old, provenance]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].features.nbm_gust.value, 9.1);
  assert.equal(rows[1].features.nbm_gust.cycle, old.cycle);
  assert.equal(rows[2].features.nbm_gust, null);
});

test("accumulated thunder forecasts join their covered hour, not the following hour", () => {
  const row = { ...provenance, field: "TSTM", interval: { processing: 1, hours: 1 } };
  const query = { iata: "ORD", model: "nbm", field: "TSTM", predictionTime: "2026-07-01T02:00:00Z" };
  assert.equal(selectForHour([row], { ...query, validTime: "2026-07-01T02:00:00Z" }), row);
  assert.equal(selectForHour([row], { ...query, validTime: "2026-07-01T03:00:00Z" }), null);
  assert.equal(featureHour({ ...row, interval: { processing: 1, hours: 3 } }), null);
});

const budget = () => ({ requests: 0, bytes: 0, started: Date.now() });
test("HTTP collection rejects ignored or truncated ranges and oversized streamed responses", async () => {
  const last = "Wed, 01 Jul 2026 00:55:09 GMT";
  const response = (status, bytes, range) => new Response(bytes, { status, headers: { "Last-Modified": last, "Content-Range": range } });
  await assert.rejects(boundedGet("https://example.test", { start: 0, end: 3, maxBytes: 4, budget: budget(), fetcher: async () => response(200, "abcd", "bytes 0-3/4") }), /expected 206/);
  await assert.rejects(boundedGet("https://example.test", { start: 0, end: 3, maxBytes: 4, budget: budget(), fetcher: async () => response(206, "abc", "bytes 0-3/4") }), /Truncated/);
  await assert.rejects(boundedGet("https://example.test", { maxBytes: 4, budget: budget(), fetcher: async () => response(200, "abcde", null) }), /Stream exceeds/);
  const got = await boundedGet("https://example.test", { start: 0, end: 3, maxBytes: 4, budget: budget(), fetcher: async () => response(206, "abcd", "bytes 0-3/4") });
  assert.equal(got.bytes.toString(), "abcd");
  assert.equal(got.lastModified, "2026-07-01T00:55:09.000Z");
  await assert.rejects(boundedGet("https://example.test", { maxBytes: 4, budget: { ...budget(), requests: LIMITS.requests } }), /budget/);
});

test("failed sources produce an artifact report with no fabricated airport values", async () => {
  const out = await mkdtemp(join(tmpdir(), "noaa-failure-"));
  try {
    const report = await collect({ cycles: ["2026-07-01T00:00:00Z"], models: ["hrrr"], out, fetcher: async () => new Response("Unavailable", { status: 503 }) });
    assert.equal(report.rows.length, 0);
    assert.equal(report.errors.length, 1);
    assert.equal(report.activeModelChanged, false);
    assert.match(report.conclusion, /No incremental prediction-skill claim/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("offline replay preserves receipt times, verifies saved bytes and joins the same usable lead rows", async () => {
  const out = await mkdtemp(join(tmpdir(), "noaa-replay-"));
  try {
    await mkdir(join(out, "messages"));
    const source = { ...provenance, model: "hrrr", field: "LTNG", cycle: message.cycle, valid: message.valid, artifact: "field.grib2", sha256: reference.sha256 };
    await writeFile(join(out, "messages", source.artifact), fixture);
    await writeFile(join(out, "report.json"), JSON.stringify({ artifactOnly: true, objects: [source] }));
    const dataset = join(out, "data.jsonl.gz");
    await writeFile(dataset, gzipSync(JSON.stringify({ a: "ORD", H: Date.parse(message.valid), y: 1, f: [{}, {}, {}, null] }) + "\n"));
    const report = await replay(join(out, "report.json"), dataset);
    assert.equal(report.replayNetworkRequests, 0);
    assert.equal(report.rows.length, 3);
    assert.equal(report.rows[0].fetchedAt, provenance.fetchedAt);
    assert.equal(report.training.totalForecastRows, 3);
    assert.equal(report.training.rowsWithAnyFeature, 1);
    assert.equal(report.training.metrics.candidateBrier, null);
    assert.equal(report.training.promotionEligible, false);
    await writeFile(join(out, "messages", source.artifact), fixture.subarray(0, -1));
    await assert.rejects(replay(join(out, "report.json")), /checksum/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("missing and corrupted training streams reject instead of producing misleading coverage", async () => {
  const out = await mkdtemp(join(tmpdir(), "noaa-bad-data-"));
  try {
    await assert.rejects(summarizeTraining(join(out, "missing.gz"), [], out), /ENOENT/);
    await writeFile(join(out, "corrupt.gz"), "not gzip");
    await assert.rejects(summarizeTraining(join(out, "corrupt.gz"), [], out), /header|gzip/i);
  } finally { await rm(out, { recursive: true, force: true }); }
});
