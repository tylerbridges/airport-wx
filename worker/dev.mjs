#!/usr/bin/env node
// Local harness for the live relay (Node only; not uploaded to Cloudflare).
//   node worker/dev.mjs bench [--n 40]       CPU time of the /status handler on fixtures (4 and 12 airports)
//   node worker/dev.mjs serve [--port 8787] [--site 8000]
//       runs the worker's fetch handler on http://localhost:8787 with every upstream (AWC, FAA, NWS,
//       the build's airport files and wx shards) answered from poller/fixtures, and serves site/ on
//       http://localhost:8000 with data/config.json pointing at the relay and data/summary.json +
//       data/airport/<IATA>.json built from the same fixtures. Open http://localhost:8000/ to see the page use the relay.
// The fixture world (fixtureWorld/stubFetch) is shared with worker/worker.test.mjs.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandTemplate } from "../poller/lib.mjs";
import { run as runPoll } from "../poller/poll.mjs";
import { runGlobal, parseMetarCsv, parseTafXml } from "../poller/global.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FX = join(ROOT, "poller/fixtures");
const { split } = createRequire(import.meta.url)("../site/split.js");
export const BUILD_BASE = "https://build.test/airport-wx/data/";

/** Everything the upstreams would serve, built from poller/fixtures for `now`. */
export async function fixtureWorld(now = new Date()) {
  const dir = await mkdtemp(join(tmpdir(), "awx-relay-"));
  try {
    const { status } = await runPoll({ fixtures: true, out: join(dir, "status.json"), now, rawDir: null });
    const log = () => {};
    await runGlobal({ fixtures: true, now, outDir: join(dir, "wx"), dataDir: join(ROOT, "site/data"), rawDir: null, log });
    const read = async (f) => expandTemplate(await readFile(join(FX, f), "utf8"), now);
    const shards = {};
    for (const L of JSON.parse(await readFile(join(dir, "wx/index.json"), "utf8")).letters || []) shards[L] = await readFile(join(dir, `wx/${L}.json`), "utf8");
    const airports = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
    // AWC JSON for the curated airports, plus records for others from the global cache fixtures
    const metars = [...JSON.parse(await read("metar.json")), ...parseMetarCsv(await read("metars.cache.csv"), now)];
    const tafs = [...JSON.parse(await read("taf.json")), ...parseTafXml(await read("tafs.cache.xml"), now)];
    // phase3: the delay model files the build used (site/data/model), served under data/model/
    const modelDir = process.env.DELAY_MODEL_DIR ? resolve(process.env.DELAY_MODEL_DIR) : join(ROOT, "site/data/model");
    const modelFiles = {};
    const addModel = async (rel) => { try { modelFiles[rel] = await readFile(join(modelDir, rel), "utf8"); } catch { /* not present */ } };
    await addModel("model.json");
    await addModel("fallback.json");
    for (const a of airports) await addModel(`analogs/${a.iata}.json`);
    const statusText = JSON.stringify(status);
    const parts = split(JSON.parse(statusText)); // what the build publishes: summary.json + airport/<IATA>.json
    const files = { "summary.json": JSON.stringify(parts.summary) };
    for (const [iata, d] of Object.entries(parts.details)) files[`airport/${iata}.json`] = JSON.stringify(d);
    return {
      now, airports, status, statusText, files, shards, metars, tafs, modelFiles,
      sigmet: await read("airsigmet.json"), faa: await read("faa.xml"), nws: JSON.parse(await read("nws.json")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * fetch() replacement answering the relay's upstream URLs from the world.
 * opts.fail: Set of source names to fail with HTTP 503 (metar, taf, sigmet, faa, nws, build, shard);
 * "model" makes the delay model files 404.
 * opts.log: array that receives every requested URL.
 */
export function stubFetch(world, { fail = new Set(), log = null } = {}) {
  const byLatLon = new Map(world.airports.map((a) => [`${a.lat.toFixed(4)},${a.lon.toFixed(4)}`, a.iata]));
  const res = (body, status = 200, type = "application/json") => new Response(body, { status, headers: { "Content-Type": type } });
  const firstBy = (list, ids) => {
    const want = new Set(ids);
    const seen = new Set();
    return list.filter((x) => want.has(x.icaoId) && !seen.has(x.icaoId) && seen.add(x.icaoId));
  };
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    log?.push(url.href);
    const name = url.host === "aviationweather.gov" ? url.pathname.split("/").pop().replace("airsigmet", "sigmet")
      : url.host === "nasstatus.faa.gov" ? "faa" : url.host === "api.weather.gov" ? "nws"
        : url.href.startsWith(BUILD_BASE) ? (url.pathname.includes("/wx/") ? "shard" : "build") : "other";
    if (fail.has(name)) return res("upstream down", 503, "text/plain");
    const ids = (url.searchParams.get("ids") || "").split(",");
    switch (name) {
      case "metar": return res(JSON.stringify(firstBy(world.metars, ids)));
      case "taf": return res(JSON.stringify(firstBy(world.tafs, ids)));
      case "sigmet": return res(world.sigmet);
      case "faa": return res(world.faa, 200, "application/xml");
      case "nws": return res(JSON.stringify(world.nws[byLatLon.get(url.searchParams.get("point"))] || { features: [] }));
      case "build": {
        const f = /\/data\/(summary\.json|airport\/[A-Z0-9]+\.json)$/.exec(url.pathname); // the build's page files (site/split.js)
        if (f) return world.files[f[1]] != null ? res(world.files[f[1]]) : res("not found", 404, "text/plain");
        const m = /\/data\/model\/(.+)$/.exec(url.pathname); // phase3: delay model files (keys are relative to data/model/)
        if (m && !fail.has("model") && world.modelFiles?.[m[1]] != null) return res(world.modelFiles[m[1]]);
        return res("not found", 404, "text/plain");
      }
      case "shard": { const L = url.pathname.split("/").pop().replace(".json", ""); return world.shards[L] ? res(world.shards[L]) : res("not found", 404, "text/plain"); }
      default: return res("no stub for " + url.href, 404, "text/plain");
    }
  };
}

export const ENV = (world) => ({ BUILD_BASE, VERSION: "dev", AIRPORTS: JSON.stringify(world.airports) });

async function loadWorker() {
  return (await import(pathToFileURL(join(HERE, "worker.mjs")).href));
}

// ---------- bench ----------

async function bench(n) {
  const W = await loadWorker();
  const world = await fixtureWorld();
  const urls = [];
  const stub = stubFetch(world, { log: urls });
  globalThis.fetch = stub;
  const env = ENV(world);
  const sets = {
    4: ["MSP", "ORD", "DEN", "ATL"],
    12: ["MSP", "ORD", "DEN", "ATL", "DFW", "JFK", "LAX", "SFO", "SEA", "BOS", "EWR", "LGA"],
  };
  const ms = (c) => (c.user + c.system) / 1000;
  const cpu = async (ids) => {
    const c0 = process.cpuUsage();
    const r = await W.default.fetch(new Request(`https://relay.test/status?ids=${ids.join(",")}`), env, {});
    await r.text();
    const c = process.cpuUsage(c0);
    if (r.status !== 200) throw new Error("status " + r.status);
    return ms(c);
  };
  // What the stub itself costs (building and reading the fake upstream responses): not the worker's CPU.
  const stubCost = async (list) => {
    const c0 = process.cpuUsage();
    for (const u of list) await (await stub(u)).text();
    return ms(process.cpuUsage(c0));
  };
  const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { median: +s[Math.floor(s.length / 2)].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2) }; };
  const out = {};
  for (const [k, ids] of Object.entries(sets)) {
    W._reset();
    urls.length = 0;
    const first = await cpu(ids); // first request in a fresh process (cold JIT, every upstream fetched and parsed)
    const upstream = [...urls];
    for (let i = 0; i < 20; i++) { W._reset(); await cpu(ids); } // JIT warm-up
    const cold = [];
    const warm = [];
    const hit = [];
    const stubs = [];
    for (let i = 0; i < n; i++) {
      W._reset();
      cold.push(await cpu(ids)); // every cache empty: all upstreams fetched and parsed
      W._reset("responses");
      warm.push(await cpu(ids)); // upstreams cached (< 60 s), response not: e.g. another id set within the minute
      hit.push(await cpu(ids)); // response cached (< 30 s)
      stubs.push(await stubCost(upstream));
    }
    const sc = stats(stubs).median;
    const c = stats(cold);
    out[k + " airports"] = {
      upstreamRequests: upstream.length,
      firstRequestInProcessMs: +first.toFixed(2),
      allCachesEmpty: { ...c, minusStubMedian: +(c.median - sc).toFixed(2) },
      upstreamsCached: stats(warm),
      responseCached: stats(hit),
      stubOverheadMedian: sc,
    };
  }
  console.log(JSON.stringify({ node: process.version, runs: n, cpuMsPerRequest: out }, null, 1));
}

// ---------- serve ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

async function serve(port, sitePort) {
  const W = await loadWorker();
  const world = await fixtureWorld();
  globalThis.fetch = stubFetch(world);
  const env = ENV(world);
  createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await W.default.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers }), env, {});
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.stack || e));
    }
  }).listen(port, () => console.log(`relay  http://localhost:${port}/status?ids=MSP,ORD`));
  if (!sitePort) return;
  const site = join(ROOT, "site");
  createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/data/config.json")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ liveUrl: `http://localhost:${port}` })); return; }
    const f = /\/data\/(summary\.json|airport\/[A-Z0-9]+\.json)$/.exec(path);
    if (f) { const body = world.files[f[1]]; res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" }); res.end(body || "not found"); return; }
    const m = /\/data\/wx\/([A-Z0-9_]+|index)\.json$/.exec(path);
    if (m) {
      const body = m[1] === "index" ? JSON.stringify({ generated: world.now.toISOString(), ok: true, letters: Object.keys(world.shards), sources: {} }) : world.shards[m[1]];
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(body || "not found");
      return;
    }
    const file = normalize(join(site, path.endsWith("/") ? path + "index.html" : path));
    if (!file.startsWith(site)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }).listen(sitePort, () => console.log(`site   http://localhost:${sitePort}/`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
  if (args[0] === "bench") await bench(opt("--n", 40));
  else if (args[0] === "serve") await serve(opt("--port", 8787), opt("--site", 8000));
  else console.log("usage: node worker/dev.mjs bench [--n 40] | serve [--port 8787] [--site 8000]");
}
