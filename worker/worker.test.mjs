// Live relay tests: the worker's fetch handler runs in Node with a stubbed global fetch fed from
// poller/fixtures (worker/dev.mjs). Covers id parsing, CORS, cache keys, the overlay on the build,
// source failures falling back to the build (stale), and the flattened upload bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as W from "./worker.mjs";
import { fixtureWorld, stubFetch, ENV, BUILD_BASE } from "./dev.mjs";
import { pack, specifiers } from "./pack.mjs";

const NOW = new Date();
const world = await fixtureWorld(NOW);
const realFetch = globalThis.fetch;

/** One request through the handler with a fresh cache. opts: {fail, origin, env, keep (don't reset caches)} */
async function call(path, { fail = [], origin = null, env = ENV(world), keep = false, method = "GET" } = {}) {
  if (!keep) W._reset();
  const log = [];
  globalThis.fetch = stubFetch(world, { fail: new Set(fail), log });
  try {
    const headers = origin ? { Origin: origin } : {};
    const res = await W.default.fetch(new Request("https://relay.test" + path, { method, headers }), env, {});
    const text = await res.text();
    return { res, status: res.status, body: text ? JSON.parse(text) : null, log };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const built = JSON.parse(world.statusText); // as served (undefined fields dropped)
const buildAp = (iata) => built.airports.find((a) => a.iata === iata);

// ---------- ids ----------

test("parseIds: case, separators, duplicates, bad tokens", () => {
  assert.deepEqual(W.parseIds(" ord,msp, ORD kfcm"), { ids: ["ORD", "MSP", "KFCM"], bad: [] });
  assert.deepEqual(W.parseIds("OR,K-FCM,ABCDE").bad, ["OR", "K-FCM", "ABCDE"]);
  assert.deepEqual(W.parseIds(null), { ids: [], bad: [] });
});

test("resolveIds: IATA or ICAO for curated airports, ICAO for others, 3-letter others unknown", () => {
  const r = W.resolveIds(["ORD", "KMSP", "KFCM", "XYZ", "MSP"], world.airports, { KFCM: "America/Chicago" });
  assert.deepEqual(r.majors.map((a) => a.iata), ["ORD", "MSP"]);
  assert.deepEqual(r.others, [{ icao: "KFCM", tz: "America/Chicago" }]);
  assert.deepEqual(r.unknown, ["XYZ"]);
});

test("/status rejects bad, missing and too many ids", async () => {
  assert.equal((await call("/status")).status, 400);
  assert.equal((await call("/status?ids=OR-D")).status, 400);
  const many = world.airports.slice(0, 13).map((a) => a.iata).join(",");
  const r = await call("/status?ids=" + many);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at most 12/);
  assert.equal((await call("/status?ids=" + world.airports.slice(0, 12).map((a) => a.iata).join(","))).status, 200);
});

// ---------- CORS ----------

test("CORS: only the site's origin and http://localhost:*", async () => {
  for (const o of ["https://tylerbridges.github.io", "http://localhost:8000", "http://localhost"]) assert.equal(W.allowedOrigin(o), true, o);
  for (const o of ["https://evil.example", "http://localhost.evil.example", "https://localhost:8000", "https://tylerbridges.github.io.evil.example", null, "null"]) assert.equal(W.allowedOrigin(o), false, String(o));
  const pre = await call("/status?ids=MSP", { method: "OPTIONS", origin: "http://localhost:8000" });
  assert.equal(pre.status, 204);
  assert.equal(pre.res.headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
  assert.equal(pre.res.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  const ok = await call("/health", { origin: "https://tylerbridges.github.io" });
  assert.equal(ok.res.headers.get("Access-Control-Allow-Origin"), "https://tylerbridges.github.io");
  assert.equal(ok.res.headers.get("Vary"), "Origin");
  const bad = await call("/health", { origin: "https://evil.example" });
  assert.equal(bad.res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await call("/status?ids=MSP", { method: "POST" })).status, 405);
});

test("/health returns version and time; unknown paths 404", async () => {
  const r = await call("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.version, "dev");
  assert.ok(Math.abs(Date.parse(r.body.time) - Date.now()) < 5000);
  assert.equal((await call("/nope")).status, 404);
});

// ---------- overlay ----------

test("same inputs as the build -> the build's airports exactly (levels, hours, reasons, programs)", async () => {
  const ids = ["MSP", "ORD", "DFW", "DEN", "JFK", "EWR", "LAS", "MCO", "SFO", "LAX", "ATL", "SEA"];
  const r = await call("/status?ids=" + ids.join(","));
  assert.equal(r.status, 200);
  assert.equal(r.body.live, true);
  assert.ok(Date.parse(r.body.generated) >= +NOW);
  assert.equal(r.body.airports.length, 12);
  for (const a of r.body.airports) {
    const b = buildAp(a.iata);
    // the relay's clock is a little later than the build's; everything else must match
    assert.deepEqual(a.now, b.now, a.iata + " now");
    assert.deepEqual(a.peak, b.peak, a.iata + " peak");
    assert.deepEqual(a.hours, b.hours, a.iata + " hours");
    for (const k of ["metar", "taf", "faa", "atcscc", "alerts", "spc", "sigmets", "lamp", "tcf", "cwa", "opsplan"]) assert.deepEqual(a[k], b[k], `${a.iata} ${k}`);
  }
  for (const n of W.LIVE_SOURCES) assert.equal(r.body.sources[n].live, true, n);
  for (const n of W.BUILD_SOURCES) assert.equal(r.body.sources[n].from, "build", n);
});

test("a newer live METAR changes the level; slow sources stay the build's", async () => {
  const s = Math.floor(Date.now() / 1000);
  const saved = world.metars;
  world.metars = [{ icaoId: "KMSP", obsTime: s - 60, rawOb: "KMSP 0000Z 27030G48KT 1/2SM +TSRA OVC004", wdir: 270, wspd: 30, wgst: 48, visib: "1/2", wxString: "+TSRA", clouds: [{ cover: "OVC", base: 400 }], temp: 20, dewp: 18 }, ...saved];
  try {
    const r = await call("/status?ids=MSP");
    const a = r.body.airports[0];
    assert.equal(a.now.level, 4);
    assert.match(a.now.reasons.join(" "), /Heavy thunderstorms/);
    assert.equal(a.metar.gust, 48);
    assert.equal(a.metar.raw, world.metars[0].rawOb);
    const b = buildAp("MSP");
    assert.deepEqual(a.lamp, b.lamp);
    assert.deepEqual(a.tcf, b.tcf);
    assert.equal(a.spc, b.spc);
  } finally {
    world.metars = saved;
  }
});

test("fields the relay doesn't compute carry over from the build", () => {
  const b = { ...buildAp("ORD"), opsPlanFutureField: { x: 1 } };
  const meta = world.airports.find((a) => a.iata === "ORD");
  const o = W.overlay({ now: NOW, majors: [meta], build: { ...world.status, airports: [b] }, src: {} });
  assert.deepEqual(o.airports[0].opsPlanFutureField, { x: 1 });
});

test("airports outside the curated list: shard-shaped entries from live METAR/TAF (same as the build's shard)", async () => {
  const r = await call("/status?ids=KFCM,EGLL,Y49&tz=KFCM:America/Chicago,EGLL:Europe/London");
  assert.equal(r.status, 200);
  const shardK = JSON.parse(world.shards.K).a.KFCM;
  const shardE = JSON.parse(world.shards.E).a.EGLL;
  assert.deepEqual(r.body.wx.KFCM, shardK);
  assert.deepEqual(r.body.wx.EGLL, shardE);
  assert.equal(r.body.wx.Y49, undefined); // 3 characters, not curated: can't be resolved without the airport list
  assert.deepEqual(r.body.unknown, ["Y49"]);
  assert.ok(!r.log.some((u) => u.includes("/wx/")), "no shard fetch while live METAR/TAF work");
  assert.ok(!r.log.some((u) => u.includes("nasstatus") || u.includes("airsigmet")), "FAA/SIGMETs only for curated airports");
});

// ---------- failures ----------

test("a failed live source falls back to the build's value and is marked stale", async () => {
  const r = await call("/status?ids=MSP,ORD,DFW", { fail: ["metar", "faa", "nws", "sigmet"] });
  assert.equal(r.status, 200);
  for (const n of ["metar", "faa", "nws", "sigmet"]) {
    const s = r.body.sources[n];
    assert.equal(s.stale, true, n);
    assert.equal(s.ok, true, n + " (the build had it)");
    assert.match(s.liveError, /HTTP 503/, n);
  }
  assert.equal(r.body.sources.taf.live, true);
  for (const a of r.body.airports) {
    const b = buildAp(a.iata);
    assert.deepEqual(a.metar, b.metar, a.iata + " metar from the build");
    assert.deepEqual(a.faa, b.faa, a.iata + " faa from the build");
    assert.deepEqual(a.alerts, b.alerts, a.iata + " alerts from the build");
    assert.deepEqual(a.hours.map((h) => h.level), b.hours.map((h) => h.level), a.iata + " levels");
  }
  assert.ok(r.body.airports.find((a) => a.iata === "ORD").faa.length > 0);
});

test("failed live METAR/TAF for a non-curated airport: the build's shard is used", async () => {
  const r = await call("/status?ids=KFCM&tz=KFCM:America/Chicago", { fail: ["metar", "taf"] });
  assert.equal(r.status, 200);
  assert.ok(r.log.some((u) => u === BUILD_BASE + "wx/K.json"));
  const shard = JSON.parse(world.shards.K).a.KFCM;
  assert.equal(r.body.wx.KFCM.m, shard.m);
  assert.equal(r.body.wx.KFCM.n, shard.n);
  assert.equal(r.body.sources.metar.stale, true);
});

test("build down: live data still served, build-only sources reported unavailable", async () => {
  const r = await call("/status?ids=MSP", { fail: ["build"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.build.ok, false);
  assert.equal(r.body.airports[0].iata, "MSP");
  assert.ok(r.body.airports[0].metar);
  for (const n of W.BUILD_SOURCES) assert.equal(r.body.sources[n].ok, false, n);
  // without the AIRPORTS binding the curated list comes from the build: nothing can be resolved or fetched
  const r2 = await call("/status?ids=MSP", { fail: ["build"], env: { BUILD_BASE } });
  assert.equal(r2.status, 502);
});

test("everything down -> 502, never cached", async () => {
  const all = ["metar", "taf", "sigmet", "faa", "nws", "build", "shard"];
  const r = await call("/status?ids=MSP,KFCM", { fail: all });
  assert.equal(r.status, 502);
  assert.equal(r.res.headers.get("Cache-Control"), "no-store");
  const again = await call("/status?ids=MSP,KFCM", { keep: true });
  assert.equal(again.status, 200);
});

// ---------- caching ----------

test("cacheKey: sorted ids, tz hints only for requested ids", () => {
  assert.equal(W.cacheKey(["ORD", "MSP"]), "/status?ids=MSP,ORD");
  assert.equal(W.cacheKey(["MSP", "ORD"]), W.cacheKey(["ORD", "MSP"]));
  assert.equal(W.cacheKey(["KFCM", "ORD"], W.parseTz("KFCM:America/Chicago,EGLL:Europe/London,KXYZ:Not/AZone")), "/status?ids=KFCM,ORD&tz=KFCM:America/Chicago");
  assert.equal(W.upstreamKey("https://r.workers.dev", "https://aviationweather.gov/api/data/metar?ids=KMSP&format=json"),
    "https://r.workers.dev/__cache/https%3A%2F%2Faviationweather.gov%2Fapi%2Fdata%2Fmetar%3Fids%3DKMSP%26format%3Djson");
});

test("cache: same ids in any order are served from cache; upstreams are reused for 60 s", async () => {
  const a = await call("/status?ids=ORD,MSP");
  assert.ok(a.log.length >= 6);
  const b = await call("/status?ids=msp,ord", { keep: true });
  assert.equal(b.log.length, 0, "response cache hit");
  assert.equal(b.body.generated, a.body.generated);
  const c = await call("/status?ids=ORD,MSP,DEN", { keep: true });
  // new id set: METAR/TAF for the new list and DEN's alerts point; SIGMETs, FAA, the build and ORD/MSP's points are reused
  assert.deepEqual(c.log.map((u) => new URL(u).pathname).sort(), ["/alerts/active", "/api/data/metar", "/api/data/taf"]);
  assert.match(c.log.find((u) => u.includes("/metar")), /ids=KDEN,KMSP,KORD&/);
});

test("cache: upstream text goes to the Cache API under the worker's origin; failures aren't stored", async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k)?.clone(), put: async (k, r) => { store.set(k, r); } } };
  try {
    const r = await call("/status?ids=MSP", { fail: ["faa"] });
    assert.equal(r.status, 200);
    const keys = [...store.keys()];
    assert.ok(keys.every((k) => k.startsWith("https://relay.test/__cache/")));
    const raw = keys.map((k) => decodeURIComponent(k.slice("https://relay.test/__cache/".length)));
    assert.ok(raw.includes("https://aviationweather.gov/api/data/metar?ids=KMSP&format=json"));
    assert.ok(raw.includes(BUILD_BASE + "status.json"));
    assert.ok(raw.includes("/status?ids=MSP"));
    assert.ok(!raw.includes("https://nasstatus.faa.gov/api/airport-status-information"));
    assert.equal(store.get(W.upstreamKey("https://relay.test", "/status?ids=MSP")).headers.get("Cache-Control"), "max-age=30");
    // a new isolate (empty memory) reads the Cache API instead of the network
    const again = await call("/status?ids=MSP");
    assert.equal(again.log.length, 0);
  } finally {
    delete globalThis.caches;
  }
});

// ---------- upload bundle ----------

test("pack: flat ES modules, no node: imports, and the flattened bundle runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-pack-"));
  try {
    const r = await pack(dir, { version: "test123" });
    assert.equal(r.metadata.main_module, "worker.mjs");
    assert.equal(r.metadata.compatibility_date, "2026-09-01");
    assert.equal(r.modules[0], "worker.mjs");
    assert.ok(r.modules.includes("core.mjs") && r.modules.includes("risk.mjs"));
    for (const m of r.modules) {
      const src = await readFile(join(dir, m), "utf8");
      for (const s of specifiers(src)) assert.match(s, /^\.\/[\w-]+\.mjs$/, `${m} imports ${s}`);
      assert.ok(!/from\s+["']node:/.test(src), m);
    }
    assert.equal((await readFile(join(dir, "parts.txt"), "utf8")).trim().split("\n").length, r.modules.length);
    const mod = await import(pathToFileURL(join(dir, "worker.mjs")).href);
    mod._reset();
    globalThis.fetch = stubFetch(world);
    const env = Object.fromEntries(r.metadata.bindings.map((b) => [b.name, b.text]));
    const res = await mod.default.fetch(new Request("https://relay.test/status?ids=MSP,ORD"), { ...env, BUILD_BASE }, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).airports.length, 2);
    const h = await (await mod.default.fetch(new Request("https://relay.test/health"), env, {})).json();
    assert.equal(h.version, "test123");
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("specifiers: import/export-from forms, comments ignored", () => {
  const src = `import { a } from "./a.mjs";\nimport {\n b,\n} from '../b.mjs';\nexport { c } from "./c.mjs";\nimport "./d.mjs";\n// import x from "./no.mjs"\n`;
  assert.deepEqual(specifiers(src), ["./a.mjs", "../b.mjs", "./c.mjs", "./d.mjs"]);
});
