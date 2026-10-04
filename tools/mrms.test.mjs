import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync, gzipSync } from "node:zlib";
import { crc32, decodePng16, decodePngGray, decodeMrms, summarizeBuffer, summarizeFrame, reflectivityState, qualityBuffer, PRODUCT } from "./mrms-lib.mjs";
import { chooseObject, objectsFromXml, collect } from "./mrms-pilot.mjs";
import { causalFrame, frameIndex, pilotNames, evaluate, comparisonGate } from "./mrms-evaluate.mjs";
import { SPEC } from "../poller/delay.mjs";

const T = Date.parse("2026-07-01T00:00:41Z");
const chunk = (type, data) => {
  const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b;
};
function png(values, width, height, filter = 0, bits = 16) {
  const bp = bits / 8, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = bits;
  const raw = Buffer.alloc((width * bp + 1) * height); let old = Buffer.alloc(width * bp);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * bp), offset = y * (width * bp + 1); raw[offset] = filter;
    for (let x = 0; x < width; x++) { if (bits === 16) row.writeUInt16BE(values[y * width + x], x * bp); else row[x] = values[y * width + x]; }
    for (let x = 0; x < row.length; x++) {
      const a = x >= bp ? row[x - bp] : 0, b = old[x], c = x >= bp ? old[x - bp] : 0, p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      raw[offset + x + 1] = (row[x] - (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth)) & 255;
    }
    old = row;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function grib({ values = [9990, 10345, 10500, 9000], bitmap = null, quality = false } = {}) {
  const section = (n, length) => { const b = Buffer.alloc(length); b.writeUInt32BE(length); b[4] = n; return b; };
  const t = section(1, 21); t.writeUInt16BE(2026, 12); t[14] = 7; t[15] = 1; t[18] = 41;
  const g = section(3, 72); g.writeUInt32BE(4, 6); g.writeUInt32BE(2, 30); g.writeUInt32BE(2, 34); g.writeUInt32BE(1, 38); g.writeUInt32BE(1e6, 42); g.writeUInt32BE(42000000, 46); g.writeUInt32BE(272000000, 50); g.writeUInt32BE(41990000, 55); g.writeUInt32BE(272010000, 59); g.writeUInt32BE(10000, 63); g.writeUInt32BE(10000, 67);
  const pd = section(4, 34); pd[9] = quality ? 8 : 10;
  const p = section(5, 21); p.writeUInt32BE(values.length, 5); p.writeUInt16BE(41, 9); p.writeFloatBE(quality ? -30 : -9990, 11); p.writeUInt16BE(1, 17); p[19] = quality ? 8 : 16;
  const bm = section(6, bitmap == null ? 6 : 7); bm[5] = bitmap == null ? 255 : 0; if (bitmap != null) bm[6] = bitmap;
  const image = png(values, bitmap == null ? 2 : values.length, bitmap == null ? 2 : 1, 0, quality ? 8 : 16), data = section(7, image.length + 5); image.copy(data, 5);
  const header = Buffer.alloc(16); header.write("GRIB"); header[6] = 209; header[7] = 2;
  const full = Buffer.concat([header, t, g, pd, p, bm, data, Buffer.from("7777")]); full.writeBigUInt64BE(BigInt(full.length), 8); return full;
}
const airport = { iata: "ORD", lat: 42, lon: -88 };
const frame = (valid = T, changes = {}) => ({ researchOnly: true, product: PRODUCT, source: { status: "available", validAt: new Date(valid).toISOString(), publishedAt: new Date(valid + 30e3).toISOString(), key: String(valid) }, airports: [{ iata: "ORD", near: { radiusKm: 25, status: "available", coverage: 1, maxDbz: 40, fraction35: 0.5, fraction45: 0 }, surrounding: { status: "available", coverage: 1, maxDbz: 40, fraction35: 0.5, fraction45: 0 }, recentChange: null }], ...changes });

test("real MRMS derived crop matches independently decoded numeric pixels", async () => {
  const m = JSON.parse(await readFile(new URL("fixtures/mrms/real-den-crop.json", import.meta.url), "utf8"));
  const d = decodePng16(await readFile(new URL("fixtures/mrms/real-den-crop.png", import.meta.url)));
  assert.equal(d.width, 9); assert.equal(d.height, 9); assert.deepEqual([...d.values], m.crop.packed);
  assert.equal((d.values[40] + m.packing.reference) / 10, 35.5);
});
test("PNG: all filters, both verified grayscale depths, CRC and byte/point bounds", () => {
  const values = [0, 0x12ff, 0xffff, 100, 500, 9000];
  for (let f = 0; f < 5; f++) assert.deepEqual([...decodePng16(png(values, 3, 2, f)).values], values);
  assert.deepEqual([...decodePngGray(png([0, 10, 255, 100], 2, 2, 4, 8), { expectedBits: 8 }).values], [0, 10, 255, 100]);
  const bad = png(values, 3, 2); bad[bad.length - 5] ^= 1; assert.throws(() => decodePng16(bad), /CRC/);
  assert.throws(() => decodePng16(png(values, 3, 2), { maxPoints: 5 }), /dimensions/);
  assert.throws(() => decodePng16(png([0], 1, 1, 0, 8)), /encoding/);
});
test("GRIB: gzip, scale, bitmap missing cells, quality product, unsupported/truncated fail", () => {
  const g = decodeMrms(gzipSync(grib())); assert.equal(g.validAt, new Date(T).toISOString()); assert.equal(g.values[1], 35.5); assert.equal(g.values[3], -99);
  const masked = decodeMrms(grib({ bitmap: 0xb0, values: [9990, 10345, 10500] })); assert.ok(Number.isNaN(masked.values[1])); assert.equal(masked.values[2], 35.5);
  const quality = decodeMrms(grib({ quality: true, values: [30, 40, 0, 20] }), { quality: true }); assert.deepEqual([...quality.values], [0, 1, -3, -1]);
  assert.throws(() => decodeMrms(grib({ quality: true, values: [30, 40, 0, 20] })), /packing/);
  assert.throws(() => decodeMrms(grib().subarray(0, -1)), /envelope/);
  const unsupported = grib(); unsupported.writeUInt16BE(40, 16 + 21 + 72 + 34 + 9); assert.throws(() => decodeMrms(unsupported), /packing/);
  const scaled = grib({ values: [0, 2, 4, 6] }); const p = 16 + 21 + 72 + 34; scaled.writeFloatBE(0, p + 11); scaled.writeUInt16BE(0x8001, p + 15); scaled.writeUInt16BE(0x8001, p + 17); assert.deepEqual([...decodeMrms(scaled).values], [0, 10, 20, 30], "GRIB uses sign-magnitude scale factors");
});
test("missing reflectivity, bitmap gaps and water/outside grid remain unknown, not clear", () => {
  for (const v of [-99, NaN, 101]) assert.equal(reflectivityState(v), "missing"); assert.equal(reflectivityState(-999), "uncovered"); assert.equal(reflectivityState(0), "valid");
  const g = decodeMrms(grib()); assert.equal(summarizeBuffer(g, airport, 25).status, "unknown");
  const missing = summarizeBuffer({ ...g, values: new Float32Array(4).fill(-99) }, airport, 25); assert.equal(missing.fraction35, null); assert.equal(missing.coverage, 0); assert.deepEqual(missing.fraction35Bounds, [0, 1]);
  const q = qualityBuffer({ ...g, values: new Float32Array(4).fill(-3) }, airport, 25); assert.equal(q.meanQuality, null);
});
test("source publication cutoff, expiry and held recent change cannot use future/missing data", () => {
  const g = { ...decodeMrms(grib()), nx: 101, ny: 101, lat0: 42.5, lon0: -88.5, values: new Float32Array(101 * 101).fill(40) };
  const source = { publishedAt: new Date(T + 30e3).toISOString(), receivedAt: new Date(T + 45e3).toISOString() };
  assert.equal(summarizeFrame(g, [airport], source, { now: T + 29e3 }).source.status, "unknown");
  assert.equal(summarizeFrame(g, [airport], source, { now: T + 16 * 60e3 }).airports[0].near.maxDbz, null);
  const previous = summarizeFrame({ ...g, validAt: new Date(T - 15 * 60e3).toISOString(), values: new Float32Array(101 * 101).fill(0) }, [airport], { publishedAt: new Date(T - 14 * 60e3).toISOString() }, { now: T - 13 * 60e3 });
  assert.equal(summarizeFrame(g, [airport], source, { now: T + 45e3, previous }).airports[0].recentChange.fraction35, 1);
  previous.source.status = "unknown"; assert.equal(summarizeFrame(g, [airport], source, { now: T + 45e3, previous }).airports[0].recentChange, null);
});
test("S3 causal object selection handles publication lag, size budget and no source", async () => {
  const key = `CONUS/${PRODUCT}/20260701/MRMS_${PRODUCT}_20260701-000041.grib2.gz`;
  const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><Size>10</Size><LastModified>2026-07-01T00:01:28Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents></ListBucketResult>`;
  const objects = objectsFromXml(xml); assert.equal(objects[0].etag, "abc"); assert.equal(chooseObject(objects, T + 46e3), null); assert.ok(chooseObject(objects, T + 47e3)); assert.equal(chooseObject(objects, T + 47e3, { maxBytes: 5 }), null);
  const r = await collect({ at: T + 46e3, airports: [airport], fetcher: async () => ({ bytes: Buffer.from(xml), headers: {}, receivedAt: new Date().toISOString() }) }); assert.equal(r.source.status, "unknown"); assert.equal(r.airports[0].near.status, "unknown");
});
test("causal joins reject future publications, expired frames, unknown coverage and duplicates", () => {
  const f = frame(); assert.equal(causalFrame([f], "ORD", T + 29e3), null); assert.ok(causalFrame([f], "ORD", T + 30e3)); assert.equal(causalFrame([f], "ORD", T + 16 * 60e3), null);
  f.airports[0].near.status = "unknown"; assert.equal(causalFrame([f], "ORD", T + 30e3), null);
  const okay = frame(); const index = frameIndex([okay, okay, { product: PRODUCT, source: { status: "unknown" } }]); assert.equal(index.get("ORD").length, 1); assert.ok(causalFrame(index, "ORD", T + 30e3)); assert.throws(() => pilotNames(f.airports[0]), /known coverage/);
});
test("evaluation refuses sparse real-like inputs and evaluates supported synthetic rows without publishing", async () => {
  const model = { v: 1, spec: SPEC, b0: Math.log(0.6 / 0.4), wc: 0, w: {}, cal: { x: [0, 1], y: [0, 1] } }, records = [], frames = [];
  for (let k = 0; k < 24; k++) for (let j = 0; j < 120; j++) {
    const H = Date.UTC(2024, 7 + k, 1, j), d = new Date(H), y = j % 2;
    const r = { a: "ORD", H, ym: d.toISOString().slice(0, 7), lh: d.getUTCHours(), dw: d.getUTCDay(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), y, f: [{ w: { l: 0, t: 0, g: 0, fc: 0, p: 0 }, o: null, h: null }, null, null, null] }; records.push(r);
    const f = frame(H - 60e3); for (const b of [f.airports[0].near, f.airports[0].surrounding]) Object.assign(b, { maxDbz: y ? 50 : 0, fraction35: y ? 0.8 : 0, fraction45: y ? 0.5 : 0 }); frames.push(f);
  }
  const empty = await evaluate({ records, frames: [], model, leadHours: [0] }); assert.equal(empty.status, "insufficient-data"); assert.equal(empty.gate.pass, false);
  const r = await evaluate({ records, frames, model, leadHours: [0], minRows: 50 }); assert.equal(r.status, "evaluated"); assert.ok(r.metrics.pilot.brier < r.metrics.deployed.brier); assert.equal(r.gate.pass, true); assert.equal(r.metrics.pilot.falseAlarmsAtHalf.b, 0); assert.equal(r.metrics.pilot.n, r.support.test.n); assert.ok(r.byAirport.ORD && r.byLead[0]);
  const partial = await evaluate({ records, frames: frames.filter((_, i) => i % 4 === 0), model, leadHours: [0], minRows: 20 }); assert.equal(partial.gate.pass, false); assert.match(partial.gate.reasons.join(" "), /coverage/);
});
test("research gate rejects better Brier with worse calibration or no calibration gain", () => {
  const m = (brier, ece) => ({ brier, calibration: { ece } });
  const baseline = { deployed: m(0.2, 0.03), baseRefitWithoutPilot: m(0.19, 0.02), climatology: m(0.21, 0.01), rule: m(0.22, 0.04) };
  assert.equal(comparisonGate({ ...baseline, pilot: m(0.18, 0.04) }).pass, false);
  assert.equal(comparisonGate({ ...baseline, pilot: m(0.18, 0.025) }).pass, false, "cannot worsen the control");
  assert.equal(comparisonGate({ ...baseline, pilot: m(0.18, 0.02) }).pass, true, "improves deployed without worsening already-better control");
  assert.equal(comparisonGate({ ...baseline, deployed: m(0.2, 0.02), pilot: m(0.18, 0.02) }).pass, false, "equal ECE for both references is not calibration improvement");
});
