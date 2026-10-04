// Research-only MRMS composite extractor. No live scoring, model features or UI hooks.
import { gunzipSync, inflateSync } from "node:zlib";

export const PRODUCT = "MergedReflectivityQCComposite_00.50";
export const QUALITY_PRODUCT = "RadarQualityIndex_00.00";
export const MAX_POINTS = 25_000_000;
export const MAX_GRID_BYTES = 80_000_000;
export const MAX_AGE_MS = 15 * 60e3;
export const MIN_COVERAGE = 0.8;
const fail = (s) => { throw new Error(`MRMS: ${s}`); };
const signed = (n, bits = 32) => (n >= 2 ** (bits - 1) ? -(n - 2 ** (bits - 1)) : n); // GRIB sign-magnitude
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(b) {
  let n = 0xffffffff;
  for (const x of b) n = crcTable[(n ^ x) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
const paeth = (a, b, c) => {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
};

/** Restricted, validated GRIB PNG payload: non-interlaced 16-bit grayscale only. */
export function decodePngGray(png, { maxPoints = MAX_POINTS, expectedBits = 16 } = {}) {
  if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail("PNG signature");
  let pos = 8, width = 0, height = 0, ended = false, idatSeen = false;
  const parts = [];
  while (pos < png.length) {
    if (pos + 12 > png.length) fail("truncated PNG chunk");
    const n = png.readUInt32BE(pos), type = png.toString("ascii", pos + 4, pos + 8);
    if (n > png.length - pos - 12) fail("PNG chunk length");
    const b = png.subarray(pos + 8, pos + 8 + n);
    if (crc32(png.subarray(pos + 4, pos + 8 + n)) !== png.readUInt32BE(pos + 8 + n)) fail("PNG CRC");
    if (type === "IHDR") {
      if (width || pos !== 8 || n !== 13) fail("PNG header order");
      width = b.readUInt32BE(0); height = b.readUInt32BE(4);
      if (!width || !height || width * height > maxPoints || ![8, 16].includes(expectedBits) || b[8] !== expectedBits || b[9] !== 0 || b[10] || b[11] || b[12]) fail("unsupported PNG dimensions/encoding");
    } else if (type === "IDAT") {
      if (!width || ended) fail("PNG data order");
      idatSeen = true; parts.push(b);
    } else if (type === "IEND") {
      if (n || !idatSeen || pos + 12 !== png.length) fail("PNG end");
      ended = true; break;
    } else if (!(type.charCodeAt(0) & 32)) fail(`unsupported PNG critical chunk ${type}`);
    pos += n + 12;
  }
  if (!ended) fail("PNG lacks end");
  const bytesPerPixel = expectedBits / 8, stride = width * bytesPerPixel, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  if (raw.length !== expected) fail("PNG inflated length");
  const out = new Uint16Array(width * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start], row = new Uint8Array(stride);
    if (filter > 4) fail("PNG row filter");
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0, b = previous[x], c = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      row[x] = (raw[start + 1 + x] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c))) & 255;
    }
    for (let x = 0; x < width; x++) out[y * width + x] = bytesPerPixel === 2 ? row[2 * x] * 256 + row[2 * x + 1] : row[x];
    previous = row;
  }
  return { width, height, values: out };
}
export const decodePng16 = (png, opts = {}) => decodePngGray(png, { ...opts, expectedBits: 16 });

/** One field, edition 2, product 209/10/0, grid 3.0, PNG 5.41; fail on other templates. */
export function decodeMrms(input, { quality = false } = {}) {
  const b = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: MAX_GRID_BYTES }) : input;
  if (b.length < 20 || b.length > MAX_GRID_BYTES || b.toString("ascii", 0, 4) !== "GRIB" || b[7] !== 2 || b.readBigUInt64BE(8) !== BigInt(b.length) || b.toString("ascii", b.length - 4) !== "7777") fail("GRIB envelope");
  const s = new Map(); let lastSection = 0;
  for (let i = 16; i < b.length - 4;) {
    if (i + 5 > b.length - 4) fail("GRIB section header");
    const n = b.readUInt32BE(i), num = b[i + 4];
    if (n < 5 || i + n > b.length - 4 || num < 1 || num > 7 || num <= lastSection || s.has(num)) fail("GRIB section/order/length");
    lastSection = num;
    s.set(num, b.subarray(i, i + n)); i += n;
  }
  for (const n of [1, 3, 4, 5, 6, 7]) if (!s.has(n)) fail(`missing GRIB section ${n}`);
  const g = s.get(3), p = s.get(5), t = s.get(1), product = s.get(4), bm = s.get(6);
  if (g.length !== 72 || g.readUInt16BE(12) !== 0 || g[71] !== 0) fail("unsupported grid/scan");
  const angle = g.readUInt32BE(38), divisions = g.readUInt32BE(42);
  if (angle !== 0 && !(angle === 1 && divisions === 1_000_000)) fail("unsupported grid angle");
  if (p.length !== 21 || p.readUInt16BE(9) !== 41 || p[19] !== (quality ? 8 : 16) || p[20] !== 0) fail("unsupported packing");
  if (b[6] !== 209 || product.length < 34 || product.readUInt16BE(7) !== 0 || product[9] !== (quality ? 8 : 10) || product[10] !== 0 || product.readUInt32BE(18) !== 0) fail("wrong MRMS product/forecast offset");
  if (t.length !== 21) fail("unsupported identification section");
  const issued = Date.UTC(t.readUInt16BE(12), t[14] - 1, t[15], t[16], t[17], t[18]);
  const date = new Date(issued);
  if (!Number.isFinite(issued) || date.getUTCFullYear() !== t.readUInt16BE(12) || date.getUTCMonth() + 1 !== t[14] || date.getUTCDate() !== t[15] || t[16] > 23 || t[17] > 59 || t[18] > 59) fail("invalid source time");
  const nx = g.readUInt32BE(30), ny = g.readUInt32BE(34), points = g.readUInt32BE(6);
  if (!nx || !ny || nx * ny !== points || points > MAX_POINTS) fail("grid dimensions");
  const lat0 = signed(g.readUInt32BE(46)) / 1e6;
  let lon0 = g.readUInt32BE(50) / 1e6; if (lon0 > 180) lon0 -= 360;
  const dx = g.readUInt32BE(63) / 1e6, dy = g.readUInt32BE(67) / 1e6;
  if (!(dx > 0 && dy > 0) || Math.abs(lat0) > 90 || Math.abs(lon0) > 180) fail("grid coordinates");
  const latEnd = signed(g.readUInt32BE(55)) / 1e6;
  let lonEnd = g.readUInt32BE(59) / 1e6; if (lonEnd > 180) lonEnd -= 360;
  if (Math.abs(lat0 - (ny - 1) * dy - latEnd) > 1e-5 || Math.abs(lon0 + (nx - 1) * dx - lonEnd) > 1e-5 || Math.abs(latEnd) > 90) fail("grid endpoints");
  const packed = decodePngGray(s.get(7).subarray(5), { expectedBits: quality ? 8 : 16 });
  const count = p.readUInt32BE(5);
  if (packed.values.length !== count) fail("PNG/packing point count");
  let bitmap = null;
  if (bm[5] === 0) {
    if (bm.length !== 6 + Math.ceil(points / 8)) fail("bitmap length");
    bitmap = bm.subarray(6);
    let present = 0; for (let i = 0; i < points; i++) present += (bitmap[i >> 3] >> (7 - (i & 7))) & 1;
    if (present !== count) fail("bitmap point count");
  } else if (bm[5] !== 255 || bm.length !== 6 || count !== points) fail("unsupported/missing bitmap");
  const ref = p.readFloatBE(11), scale = 2 ** signed(p.readUInt16BE(15), 16), decimal = 10 ** signed(p.readUInt16BE(17), 16);
  if (![ref, scale, decimal].every(Number.isFinite) || !decimal) fail("packing scale");
  const values = new Float32Array(points);
  let j = 0;
  for (let i = 0; i < points; i++) values[i] = bitmap && !(bitmap[i >> 3] & (1 << (7 - (i & 7)))) ? NaN : (ref + packed.values[j++] * scale) / decimal;
  return { nx, ny, lat0, lon0, dx, dy, values, validAt: new Date(issued).toISOString(), discipline: 209, category: quality ? 8 : 10, parameter: 0, gridTemplate: 0, packingTemplate: 41 };
}

export function qualityBuffer(grid, airport, radiusKm) {
  let total = 0, valid = 0, sum = 0;
  const latSpan = radiusKm / 110.5, lonSpan = radiusKm / Math.max(1, 110.5 * Math.cos(rad(airport.lat)));
  for (let y = Math.floor((grid.lat0 - airport.lat - latSpan) / grid.dy); y <= Math.ceil((grid.lat0 - airport.lat + latSpan) / grid.dy); y++) {
    for (let x = Math.floor((airport.lon - lonSpan - grid.lon0) / grid.dx); x <= Math.ceil((airport.lon + lonSpan - grid.lon0) / grid.dx); x++) {
      if (distanceKm(airport.lat, airport.lon, grid.lat0 - y * grid.dy, grid.lon0 + x * grid.dx) > radiusKm) continue;
      total++;
      if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) continue;
      const v = grid.values[y * grid.nx + x];
      if (!Number.isFinite(v) || v < 0 || v > 1) continue;
      valid++; sum += v;
    }
  }
  return { radiusKm, validCells: valid, cells: total, coverage: total ? Math.round(valid / total * 1e4) / 1e4 : 0, meanQuality: valid ? Math.round(sum / valid * 1e4) / 1e4 : null, interpretation: "Quality diagnostic only; does not establish that missing reflectivity is clear" };
}

const rad = (n) => n * Math.PI / 180;
export function distanceKm(a, b, c, d) {
  const p = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(p), Math.sqrt(Math.max(0, 1 - p)));
}
/** NOAA table labels -99 Missing and -999 No Coverage. Neither is treated as clear/zero. */
export function reflectivityState(v) {
  if (!Number.isFinite(v)) return "missing";
  if (Math.abs(v + 999) < 0.01) return "uncovered";
  if (Math.abs(v + 99) < 0.01 || v < -40 || v > 100) return "missing";
  return "valid";
}
export function summarizeBuffer(grid, airport, radiusKm, { minCoverage = MIN_COVERAGE } = {}) {
  const { nx, ny, lat0, lon0, dx, dy, values } = grid;
  const latSpan = radiusKm / 110.5, lonSpan = radiusKm / Math.max(1, 110.5 * Math.cos(rad(airport.lat)));
  const x0 = Math.floor((airport.lon - lonSpan - lon0) / dx), x1 = Math.ceil((airport.lon + lonSpan - lon0) / dx);
  const y0 = Math.floor((lat0 - airport.lat - latSpan) / dy), y1 = Math.ceil((lat0 - airport.lat + latSpan) / dy);
  let total = 0, valid = 0, missing = 0, uncovered = 0, maxDbz = null, above35 = 0, above45 = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (distanceKm(airport.lat, airport.lon, lat0 - y * dy, lon0 + x * dx) > radiusKm) continue;
    total++;
    if (x < 0 || y < 0 || x >= nx || y >= ny) { uncovered++; continue; }
    const v = values[y * nx + x], state = reflectivityState(v);
    if (state !== "valid") { if (state === "missing") missing++; else uncovered++; continue; }
    valid++; maxDbz = maxDbz == null ? v : Math.max(maxDbz, v); above35 += v >= 35; above45 += v >= 45;
  }
  const coverage = total ? valid / total : 0, usable = total > 0 && coverage >= minCoverage;
  const round = (x) => x == null ? null : Math.round(x * 1e4) / 1e4;
  return { radiusKm, status: usable ? "available" : "unknown", cells: total, validCells: valid, missingCells: missing, uncoveredCells: uncovered, coverage: round(coverage), maxDbz: usable ? round(maxDbz) : null, fraction35: usable ? round(above35 / valid) : null, fraction45: usable ? round(above45 / valid) : null, observedMaxDbz: round(maxDbz), fraction35Bounds: total ? [round(above35 / total), round((above35 + missing + uncovered) / total)] : null, knownStormCells35: above35 };
}
export function summarizeFrame(grid, airports, source, { previous = null, now = Date.now() } = {}) {
  const valid = Date.parse(grid.validAt), published = Date.parse(source.publishedAt);
  const age = now - valid, temporal = Number.isFinite(valid) && Number.isFinite(published) && published >= valid && published <= now && age >= 0 && age <= MAX_AGE_MS;
  const entries = airports.map((a) => {
    const near = summarizeBuffer(grid, a, 25), surrounding = summarizeBuffer(grid, a, 50);
    if (!temporal) for (const b of [near, surrounding]) Object.assign(b, { status: "unknown", maxDbz: null, fraction35: null, fraction45: null });
    const old = previous?.airports?.find((x) => x.iata === a.iata), deltaMs = valid - Date.parse(previous?.source?.validAt);
    const comparable = temporal && previous?.product === PRODUCT && previous.source?.status === "available" && old?.near?.radiusKm === 25 && old.near.status === "available" && near.status === "available" && deltaMs >= 5 * 60e3 && deltaMs <= 30 * 60e3 && Date.parse(previous.source.publishedAt) >= Date.parse(previous.source.validAt) && Date.parse(previous.source.publishedAt) <= now;
    return { iata: a.iata, near, surrounding, recentChange: comparable ? { minutes: Math.round(deltaMs / 60e3), fraction35: Math.round((near.fraction35 - old.near.fraction35) * 1e4) / 1e4, maxDbz: Math.round((near.maxDbz - old.near.maxDbz) * 10) / 10 } : null };
  });
  return { v: 1, researchOnly: true, product: PRODUCT, asOf: new Date(now).toISOString(), source: { ...source, validAt: grid.validAt, expiresAt: new Date(valid + MAX_AGE_MS).toISOString(), publicationLagSeconds: Number.isFinite(published) ? Math.round((published - valid) / 1000) : null, status: temporal ? "available" : "unknown", grid: { nx: grid.nx, ny: grid.ny, gridTemplate: grid.gridTemplate, packingTemplate: grid.packingTemplate } }, policy: { minCoverage: MIN_COVERAGE, maxAgeMinutes: MAX_AGE_MS / 60e3, buffersKm: [25, 50], missing: "-99 and bitmap gaps unknown", uncovered: "-999 and outside grid unknown", upwind: "not estimated without contemporaneous wind; 50 km surrounding buffer only", publication: "S3 LastModified is an archive publication proxy, not a historical receiver timestamp" }, airports: entries };
}
