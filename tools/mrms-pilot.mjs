// Bounded manual research collector; one shared MRMS grid per invocation, no automatic runs.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { PRODUCT, QUALITY_PRODUCT, MAX_AGE_MS, decodeMrms, summarizeFrame, qualityBuffer } from "./mrms-lib.mjs";

export const ORIGIN = "https://noaa-mrms-pds.s3.amazonaws.com";
const dateKey = (t) => new Date(t).toISOString().slice(0, 10).replaceAll("-", "");
const timeKey = (t) => new Date(t).toISOString().slice(11, 19).replaceAll(":", "");
const unxml = (s) => s.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");

/** Built-in HTTPS client, including inherited HTTP CONNECT proxy and CA trust. No redirects/retries. */
export function getBytes(url, { maxBytes = 4_000_000, timeoutMs = 30_000, proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY } = {}) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return Promise.reject(new Error("MRMS collector only requests the NOAA bucket"));
  return new Promise((resolveRequest, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    let connectReq = null, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); agent.destroy(); connectReq?.destroy();
      if (error) reject(error); else resolveRequest(result);
    };
    if (proxy) {
      const p = new URL(proxy);
      agent.createConnection = (_opts, cb) => {
        if (p.protocol !== "http:" && p.protocol !== "https:") { cb(new Error("unsupported proxy protocol")); return; }
        const headers = { Host: `${u.hostname}:443` };
        if (p.username || p.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}`;
        connectReq = (p.protocol === "https:" ? https : http).request(p, { method: "CONNECT", path: `${u.hostname}:443`, headers });
        connectReq.once("connect", (res, socket, head) => {
          if (res.statusCode !== 200 || head.length) { socket.destroy(); cb(new Error(`proxy CONNECT HTTP ${res.statusCode}`)); return; }
          const secure = tls.connect({ socket, servername: u.hostname });
          secure.once("secureConnect", () => cb(null, secure));
          secure.once("error", (e) => finish(e));
        });
        connectReq.once("error", (e) => cb(e)); connectReq.end();
      };
    }
    const req = https.get(u, { agent, headers: { "User-Agent": "airport-wx MRMS research pilot (github.com/tylerbridges/airport-wx)", "Accept-Encoding": "identity" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(new Error(`NOAA HTTP ${res.statusCode}`)); return; }
      if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); finish(new Error("MRMS response exceeds byte budget")); return; }
      let n = 0; const parts = [];
      res.on("data", (b) => { n += b.length; if (n > maxBytes) { res.destroy(); finish(new Error("MRMS response exceeds byte budget")); } else parts.push(b); });
      res.once("error", (e) => finish(e));
      res.once("end", () => finish(null, { bytes: Buffer.concat(parts), headers: res.headers, receivedAt: new Date().toISOString() }));
    });
    req.once("error", (e) => finish(e));
    const timer = setTimeout(() => { req.destroy(); finish(new Error("MRMS request timeout")); }, timeoutMs);
  });
}

export function objectsFromXml(xml, product = PRODUCT) {
  if (![PRODUCT, QUALITY_PRODUCT].includes(product)) throw new Error("unsupported MRMS product");
  const objects = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const field = (n) => unxml(m[1].match(new RegExp(`<${n}>([^<]*)<\/${n}>`))?.[1] || "");
    const key = field("Key"), match = key.match(new RegExp(`^CONUS/${product}/(\\d{8})/MRMS_${product}_(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})\\.grib2\\.gz$`));
    if (!match) continue;
    const validAt = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}Z`;
    const publishedAt = field("LastModified"), size = Number(field("Size"));
    if (!Number.isFinite(Date.parse(validAt)) || !Number.isFinite(Date.parse(publishedAt)) || !(size > 0)) continue;
    objects.push({ key, validAt, publishedAt, size, etag: field("ETag").replaceAll('"', "") });
  }
  return objects;
}
export function chooseObject(objects, at, { maxBytes = 4_000_000 } = {}) {
  return objects.filter((o) => Date.parse(o.validAt) <= at && Date.parse(o.publishedAt) <= at && Date.parse(o.publishedAt) >= Date.parse(o.validAt) && at - Date.parse(o.validAt) <= MAX_AGE_MS && o.size <= maxBytes).sort((a, b) => Date.parse(b.validAt) - Date.parse(a.validAt))[0] || null;
}
export async function collect({ at = Date.now(), airports, previous = null, quality = false, fetcher = getBytes, maxBytes = 4_000_000 } = {}) {
  if (!Number.isFinite(at) || !Array.isArray(airports) || !airports.length || airports.length > 32 || airports.some((a) => !a.iata || !Number.isFinite(a.lat) || Math.abs(a.lat) > 85 || !Number.isFinite(a.lon) || Math.abs(a.lon) > 180)) throw new Error("invalid collector time/airports");
  const oldest = at - MAX_AGE_MS, dates = [...new Set([dateKey(oldest), dateKey(at)])];
  const find = async (product) => {
  const objects = [];
  for (const d of dates) {
    const prefix = `CONUS/${product}/${d}/`;
    const start = `${prefix}MRMS_${product}_${dateKey(oldest)}-${timeKey(oldest)}`;
    const query = new URLSearchParams({ "list-type": "2", prefix, "start-after": start, "max-keys": "32" });
    const listing = await fetcher(`${ORIGIN}/?${query}`, { maxBytes: 100_000 });
    const xml = listing.bytes.toString("utf8");
    if (!/<ListBucketResult\b/.test(xml)) throw new Error("MRMS listing invalid");
    const found = objectsFromXml(xml, product);
    // Historical listings can include later publications. Only fail if the bounded
    // result ends before the requested cutoff; chooseObject never uses future data.
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && (!found.length || Date.parse(found.at(-1).validAt) < at)) throw new Error("MRMS listing exceeds bounded cutoff window");
    objects.push(...found);
  }
  return objects;
  };
  const object = chooseObject(await find(PRODUCT), at, { maxBytes });
  if (!object) return { v: 1, researchOnly: true, product: PRODUCT, asOf: new Date(at).toISOString(), source: { status: "unknown", reason: "No published, fresh MRMS frame within byte budget", receivedAt: new Date().toISOString() }, airports: airports.map((a) => ({ iata: a.iata, near: { status: "unknown" }, surrounding: { status: "unknown" }, recentChange: null })) };
  const load = async (object, quality = false) => {
  const url = `${ORIGIN}/${object.key}`, fetched = await fetcher(url, { maxBytes });
  const grid = decodeMrms(fetched.bytes, { quality });
  if (Date.parse(grid.validAt) !== Date.parse(object.validAt)) throw new Error("MRMS filename/GRIB source time differs");
  const modified = fetched.headers["last-modified"];
  if (!modified || Date.parse(modified) !== Date.parse(object.publishedAt)) throw new Error("MRMS object changed after listing");
  const source = { url, key: object.key, publishedAt: object.publishedAt, receivedAt: fetched.receivedAt, bytes: fetched.bytes.length, sha256: createHash("sha256").update(fetched.bytes).digest("hex"), etag: object.etag, availabilityBasis: "S3 LastModified; actual receiver time recorded separately" };
  return { grid, source };
  };
  const { grid, source } = await load(object);
  const result = summarizeFrame(grid, airports, source, { previous, now: at });
  if (quality) {
    try {
      const o = chooseObject((await find(QUALITY_PRODUCT)).filter((o) => Math.abs(Date.parse(o.validAt) - Date.parse(grid.validAt)) <= 2 * 60e3), at, { maxBytes });
      if (!o) throw new Error("No published quality grid aligned within two minutes");
      const q = await load(o, true);
      if (["nx", "ny", "lat0", "lon0", "dx", "dy"].some((k) => q.grid[k] !== grid[k])) throw new Error("MRMS quality geometry differs");
      result.qualitySource = { ...q.source, validAt: q.grid.validAt, status: "available", product: QUALITY_PRODUCT, role: "diagnostic; missing reflectivity stays unknown" };
      for (let i = 0; i < airports.length; i++) result.airports[i].radarQuality = { near: qualityBuffer(q.grid, airports[i], 25), surrounding: qualityBuffer(q.grid, airports[i], 50) };
    } catch (e) { result.qualitySource = { status: "unknown", reason: e.message, product: QUALITY_PRODUCT }; }
  }
  return result;
}

async function main() {
  let at = Date.now(), out = null, codes = ["ORD", "MSP", "SFO"], previous = null, quality = false;
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i], v = () => process.argv[++i];
    if (k === "--at") at = Date.parse(v());
    else if (k === "--out") out = resolve(v());
    else if (k === "--airports") codes = v().split(",").map((s) => s.trim().toUpperCase());
    else if (k === "--previous") previous = JSON.parse(await readFile(resolve(v()), "utf8"));
    else if (k === "--quality") quality = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!out) throw new Error("usage: mrms-pilot.mjs --out file.json [--at ISO] [--airports ORD,MSP,SFO] [--previous file.json]");
  if (!Number.isFinite(at)) throw new Error("--at must be a valid ISO timestamp");
  const all = JSON.parse(await readFile(new URL("../airports.json", import.meta.url), "utf8"));
  const airports = codes.map((code) => { const a = all.find((x) => x.iata === code); if (!a) throw new Error(`unknown airport ${code}`); return a; });
  let result;
  try { result = await collect({ at, airports, previous, quality }); }
  catch (e) {
    result = { v: 1, researchOnly: true, product: PRODUCT, asOf: new Date(at).toISOString(), source: { status: "unknown", reason: e.message, receivedAt: new Date().toISOString() }, airports: airports.map((a) => ({ iata: a.iata, near: { status: "unknown" }, surrounding: { status: "unknown" }, recentChange: null })) };
  }
  await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(result) + "\n");
  console.log(JSON.stringify({ out, source: result.source, airports: result.airports }, null, 2));
  if (result.source.status !== "available") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
