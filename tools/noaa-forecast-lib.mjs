// Artifact-only NOAA forecast research helpers. Nothing here is used by the live scorer.
// Format references: NCEP GRIB2 templates 3.30, 4.0/4.8 and 5.3/7.3.
// Unsupported formats throw; unavailable values are null, never an invented zero.
export const NOAA_MODELS = ["hrrr", "nbm"];
export const PILOT_AIRPORTS = [
  { iata: "ORD", lat: 41.9786, lon: -87.9048 },
  { iata: "MSP", lat: 44.8820, lon: -93.2218 },
  { iata: "SFO", lat: 37.6213, lon: -122.3790 },
];
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const sm = (buf, pos, bytes) => {
  const value = buf.readUIntBE(pos, bytes);
  const sign = 2 ** (bytes * 8 - 1);
  return value >= sign ? -(value - sign) : value;
};
function isoDate(year, month, day, hour, minute, second) {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  check(value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day && hour < 24 && minute < 60 && second < 60, "Invalid GRIB date");
  return value.toISOString();
}
export function sourceObject(model, cycle, lead) {
  check(NOAA_MODELS.includes(model), "Unknown NOAA model");
  const t = new Date(cycle);
  check(Number.isFinite(+t) && t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0 && t.getUTCMilliseconds() === 0, "Cycle must be a UTC whole hour");
  check(Number.isInteger(lead) && lead >= 1 && lead <= 18, "Pilot lead must be 1–18 hours");
  const day = t.toISOString().slice(0, 10).replaceAll("-", "");
  const h = t.toISOString().slice(11, 13);
  const path = model === "hrrr" ? `hrrr.${day}/conus/hrrr.t${h}z.wrfsfcf${String(lead).padStart(2, "0")}.grib2`
    : `blend.${day}/${h}/core/blend.t${h}z.core.f${String(lead).padStart(3, "0")}.co.grib2`;
  const host = model === "hrrr" ? "noaa-hrrr-bdp-pds" : "noaa-nbm-grib2-pds";
  return { model, cycle: t.toISOString(), lead, url: `https://${host}.s3.amazonaws.com/${path}` };
}
export function parseIndex(text) {
  check(typeof text === "string" && text.length <= 200000, "Index exceeds bounded size");
  const lines = text.trim().split(/\r?\n/);
  const rows = lines.map((line) => {
    const m = /^(\d+):(\d+):d=(\d{10}):([^:]+):([^:]*):(.*)$/.exec(line);
    check(m, "Unsupported NOAA index line");
    return { number: +m[1], offset: +m[2], cycle: `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6, 8)}T${m[3].slice(8)}:00:00.000Z`, field: m[4], level: m[5], detail: m[6], line };
  });
  check(rows.length > 0, "Empty index");
  rows.forEach((r, i) => {
    check(Number.isSafeInteger(r.offset) && r.offset >= 0 && (!i || r.offset > rows[i - 1].offset), "Index offsets must increase");
    r.end = rows[i + 1] ? rows[i + 1].offset - 1 : null;
  });
  return rows;
}
export function chooseFields(rows, model) {
  const wanted = ["GUST", "VIS", model === "hrrr" ? "LTNG" : "TSTM"];
  return wanted.map((field) => {
    const r = rows.find((x) => x.field === field && !/ens std dev|prob </.test(x.detail));
    check(r, `No supported ${field} in index`);
    check(r.end != null, `Unbounded final ${field} message`);
    return r;
  });
}
export function gribMessage(buf, { maxPoints = 5000000 } = {}) {
  check(Buffer.isBuffer(buf) && buf.length >= 20 && buf.subarray(0, 4).toString() === "GRIB" && buf[7] === 2, "Not a complete GRIB2 message");
  check(buf.readBigUInt64BE(8) === BigInt(buf.length) && buf.subarray(-4).toString() === "7777", "Incomplete GRIB2 range");
  const sections = new Map();
  let pos = 16;
  while (pos < buf.length - 4) {
    check(pos + 5 <= buf.length - 4, "Truncated GRIB section header");
    const length = buf.readUInt32BE(pos), kind = buf[pos + 4];
    check(length >= 5 && pos + length <= buf.length - 4 && kind >= 1 && kind <= 7 && !sections.has(kind), "Invalid or repeated GRIB section");
    sections.set(kind, buf.subarray(pos, pos + length)); pos += length;
  }
  check(pos === buf.length - 4, "GRIB sections do not fill message");
  for (const k of [1, 3, 4, 5, 6, 7]) check(sections.has(k), `Missing GRIB section ${k}`);
  const s1 = sections.get(1), s3 = sections.get(3), s4 = sections.get(4), s5 = sections.get(5), s6 = sections.get(6);
  check(s1.length >= 21 && s3.length >= 81 && s4.length >= 34 && s5.length >= 49 && s6.length === 6, "Unsupported GRIB section sizes");
  check(s3.readUInt16BE(12) === 30 && s3[10] === 0, "Only regular Lambert grid 3.30 is supported");
  const nx = s3.readUInt32BE(30), ny = s3.readUInt32BE(34), points = s3.readUInt32BE(6);
  check(nx > 1 && ny > 1 && points === nx * ny && points <= maxPoints, "Invalid or excessive grid point count");
  const shape = s3[14];
  check(shape === 6 || shape === 1, `Unsupported earth shape ${shape}`);
  const radius = shape === 6 ? 6371229 : s3.readUInt32BE(16) * 10 ** -sm(s3, 15, 1);
  check(radius > 6300000 && radius < 6500000, "Invalid spherical earth radius");
  const scan = s3[64];
  check((scan & 0x2f) === 0, `Unsupported grid scan mode ${scan}`);
  const grid = { nx, ny, points, radius, lat1: sm(s3, 38, 4) / 1e6, lon1: sm(s3, 42, 4) / 1e6, lad: sm(s3, 47, 4) / 1e6, lov: sm(s3, 51, 4) / 1e6, dx: s3.readUInt32BE(55) / 1000, dy: s3.readUInt32BE(59) / 1000, latin1: sm(s3, 65, 4) / 1e6, latin2: sm(s3, 69, 4) / 1e6, scan };
  check(s3[63] === 0 && grid.dx > 0 && grid.dy > 0 && grid.latin1 > 0 && grid.latin1 === grid.latin2, "Only northern tangent Lambert is supported");
  const cycle = isoDate(s1.readUInt16BE(12), s1[14], s1[15], s1[16], s1[17], s1[18]);
  const productTemplate = s4.readUInt16BE(7);
  check(productTemplate === 0 || productTemplate === 8, `Unsupported product template 4.${productTemplate}`);
  check(s4[17] === 1, "Only forecast hours are supported");
  const leadHours = s4.readUInt32BE(18);
  let valid = new Date(Date.parse(cycle) + leadHours * 3600000).toISOString(), interval = null;
  if (productTemplate === 8) {
    check(s4.length === 58 && s4[41] === 1 && s4[48] === 1, "Only one hourly statistical range is supported");
    valid = isoDate(s4.readUInt16BE(34), s4[36], s4[37], s4[38], s4[39], s4[40]);
    interval = { processing: s4[46], hours: s4.readUInt32BE(49) };
  }
  check(s5.readUInt16BE(9) === 3 && s5.readUInt32BE(5) === points, "Only complete-grid packing 5.3 is supported");
  check(s6[5] === 255, "Bitmap encoding is unsupported; values remain unavailable");
  const packing = { template: 3, count: points, reference: s5.readFloatBE(11), binaryScale: sm(s5, 15, 2), decimalScale: sm(s5, 17, 2), referenceBits: s5[19], originalType: s5[20], splitting: s5[21], missing: s5[22], groups: s5.readUInt32BE(31), widthReference: s5[35], widthBits: s5[36], lengthReference: s5.readUInt32BE(37), lengthIncrement: s5[41], lastLength: s5.readUInt32BE(42), lengthBits: s5[46], order: s5[47], descriptorBytes: s5[48] };
  return { discipline: buf[6], category: s4[9], parameter: s4[10], surfaceType: s4[22], productTemplate, cycle, valid, leadHours, interval, grid, packing, packed: sections.get(7).subarray(5) };
}
class Bits {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) {
    check(n >= 0 && n <= 32 && this.pos + n <= this.buf.length * 8, "Truncated or excessive packed value");
    let v = 0;
    while (n) {
      const room = 8 - this.pos % 8, take = Math.min(room, n);
      v = v * 2 ** take + (this.buf[Math.floor(this.pos / 8)] >> (room - take) & (2 ** take - 1));
      this.pos += take; n -= take;
    }
    return v;
  }
  align() { this.pos = Math.ceil(this.pos / 8) * 8; check(this.pos <= this.buf.length * 8, "Truncated group descriptors"); }
}
export function unpack53(p, packed) {
  check(p.template === 3 && p.splitting === 1 && p.originalType === 0 && [0, 1, 2].includes(p.missing), "Unsupported complex packing options");
  check(p.count > 0 && p.count <= 5000000 && p.groups > 0 && p.groups <= p.count && [1, 2].includes(p.order) && p.descriptorBytes >= 1 && p.descriptorBytes <= 4, "Invalid complex packing bounds");
  check(Number.isFinite(p.reference) && Math.abs(p.binaryScale) <= 64 && Math.abs(p.decimalScale) <= 20, "Invalid value scale");
  check(p.referenceBits <= 32 && p.widthBits <= 5 && p.widthReference <= 32 && p.lengthBits <= 32 && p.lengthReference <= p.count && p.lengthIncrement > 0 && p.lengthIncrement <= 255 && p.lastLength <= p.count, "Excessive group descriptor");
  const bits = new Bits(packed), descriptorBits = p.descriptorBytes * 8;
  const initial = Array.from({ length: p.order }, () => bits.read(descriptorBits));
  const negative = bits.read(1), minimum = bits.read(descriptorBits - 1) * (negative ? -1 : 1);
  const refs = Uint32Array.from({ length: p.groups }, () => bits.read(p.referenceBits)); bits.align();
  const widths = Uint8Array.from({ length: p.groups }, () => bits.read(p.widthBits) + p.widthReference); bits.align();
  const lengths = Uint32Array.from({ length: p.groups }, () => { const n = bits.read(p.lengthBits) * p.lengthIncrement + p.lengthReference; check(n <= p.count, "Excessive group length"); return n; }); bits.align();
  lengths[p.groups - 1] = p.lastLength;
  let count = 0, valueBits = 0;
  for (let i = 0; i < p.groups; i++) { check(widths[i] <= 32 && lengths[i] <= p.count, "Invalid group bounds"); count += lengths[i]; valueBits += widths[i] * lengths[i]; }
  check(count === p.count && bits.pos + valueBits <= packed.length * 8, "Group lengths or bits do not cover field");
  const values = new Float64Array(p.count); values.fill(NaN);
  let j = 0, seen = 0, previous = 0, previous2 = 0;
  const scale = 2 ** p.binaryScale, decimal = 10 ** -p.decimalScale;
  for (let g = 0; g < p.groups; g++) {
    const w = widths[g], ref = refs[g], allOnes = 2 ** (w || p.referenceBits) - 1;
    for (let k = 0; k < lengths[g]; k++, j++) {
      const packedValue = w ? bits.read(w) : ref;
      if (p.missing && (packedValue === allOnes || p.missing === 2 && packedValue === allOnes - 1)) continue;
      let integer = seen < p.order ? initial[seen] : packedValue + (w ? ref : 0) + minimum + (p.order === 1 ? previous : 2 * previous - previous2);
      check(Number.isSafeInteger(integer), "Decoded integer exceeds safe precision");
      const value = (p.reference + integer * scale) * decimal;
      check(Number.isFinite(value), "Decoded value is nonfinite");
      values[j] = value; previous2 = previous; previous = integer; seen++;
    }
  }
  check(seen >= p.order, "Insufficient nonmissing differencing values");
  return values;
}
function project(g, lat, lon) {
  const rad = Math.PI / 180, phi = lat * rad, phi1 = g.latin1 * rad;
  const n = Math.sin(phi1), f = Math.cos(phi1) * Math.tan(Math.PI / 4 + phi1 / 2) ** n / n;
  const rho = g.radius * f / Math.tan(Math.PI / 4 + phi / 2) ** n;
  const delta = ((lon - g.lov + 540) % 360 - 180) * rad * n;
  return [rho * Math.sin(delta), -rho * Math.cos(delta)];
}
export function nearestPoint(grid, lat, lon) {
  check(Number.isFinite(lat) && lat > -90 && lat < 90 && Number.isFinite(lon), "Invalid airport coordinate");
  const a = project(grid, grid.lat1, grid.lon1), b = project(grid, lat, lon);
  const x = (b[0] - a[0]) / grid.dx * (grid.scan & 128 ? -1 : 1), y = (b[1] - a[1]) / grid.dy * (grid.scan & 64 ? 1 : -1);
  const i = Math.round(x), j = Math.round(y);
  if (i < 0 || i >= grid.nx || j < 0 || j >= grid.ny) return null;
  const rowI = grid.scan & 16 && j % 2 ? grid.nx - 1 - i : i;
  return { index: j * grid.nx + rowI, i, j, distanceM: Math.hypot(x - i, y - j) * Math.max(grid.dx, grid.dy) };
}
export function airportValues(message, airports = PILOT_AIRPORTS) {
  const values = unpack53(message.packing, message.packed);
  return airports.map((a) => {
    const point = nearestPoint(message.grid, a.lat, a.lon);
    const value = point && values[point.index];
    return { iata: a.iata, lat: a.lat, lon: a.lon, point, value: Number.isFinite(value) ? value : null, quality: !point ? "outside-grid" : Number.isFinite(value) ? "available" : "missing-grid-value" };
  });
}
// Historical S3 Last-Modified is a conservative archive availability proxy, not a
// guaranteed first-publication log. A late rewrite makes an old object ineligible.
export function availability(row, predictionTime, { mode = "historical", maxCycleAgeHours = 12 } = {}) {
  check(["historical", "live"].includes(mode), "Unknown availability mode");
  const pred = Date.parse(predictionTime), cycle = Date.parse(row.cycle), valid = Date.parse(row.valid);
  const objectAt = Date.parse(row.objectLastModified), indexAt = Date.parse(row.indexLastModified), receipt = Date.parse(row.fetchedAt);
  if (![pred, cycle, valid, objectAt, indexAt, receipt].every(Number.isFinite)) return { eligible: false, reason: "missing-availability-provenance" };
  if (objectAt < cycle || indexAt < cycle) return { eligible: false, reason: "publication-before-cycle" };
  if (receipt < Math.max(objectAt, indexAt)) return { eligible: false, reason: "receipt-before-publication" };
  const availableAt = Math.max(objectAt, indexAt, mode === "live" ? receipt : -Infinity);
  if (availableAt > pred) return { eligible: false, reason: "not-yet-available", availableAt: new Date(availableAt).toISOString() };
  if (cycle > pred || pred - cycle > maxCycleAgeHours * 3600000) return { eligible: false, reason: "stale-or-future-cycle" };
  return { eligible: true, reason: "available", availableAt: new Date(availableAt).toISOString(), cycleAgeHours: (pred - cycle) / 3600000, publicationLagMinutes: (Math.max(objectAt, indexAt) - cycle) / 60000 };
}
export function selectForHour(rows, { iata, model, field, predictionTime, validTime, mode = "historical" }) {
  const candidates = rows.filter((r) => r.iata === iata && r.model === model && r.field === field && featureHour(r) === Date.parse(validTime) && Number.isFinite(r.value) && availability(r, predictionTime, { mode }).eligible);
  candidates.sort((a, b) => Date.parse(b.cycle) - Date.parse(a.cycle));
  return candidates[0] || null;
}
// A one-hour accumulation ending at H describes [H-1h,H), not [H,H+1h).
// Instantaneous fields describe the value at the airport-hour's start.
export function featureHour(row) {
  const end = Date.parse(row.valid);
  if (!Number.isFinite(end)) return null;
  if (!row.interval) return end;
  if (row.interval.processing !== 1 || row.interval.hours !== 1) return null;
  return end - 3600000;
}
export function joinTrainingHours(records, rows, { models = NOAA_MODELS, fields = ["GUST", "VIS", "LTNG", "TSTM"] } = {}) {
  const leads = [0, 3, 6, 12];
  return records.flatMap((r) => leads.flatMap((lead, bucket) => {
    if (r.f?.[bucket] === null) return [];
    const predictionTime = new Date(r.H - lead * 3600000).toISOString(), validTime = new Date(r.H).toISOString();
    const features = {};
    for (const model of models) for (const field of fields) {
      const hit = selectForHour(rows, { iata: r.a, model, field, predictionTime, validTime });
      features[`${model}_${field.toLowerCase()}`] = hit ? { value: hit.value, cycle: hit.cycle, sourceValid: hit.valid, interval: hit.interval || null, availability: availability(hit, predictionTime) } : null;
    }
    return { iata: r.a, H: r.H, bucket, predictionTime, validTime, label: r.y, features };
  }));
}
