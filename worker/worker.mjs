// Live relay: a Cloudflare Worker (ES module) that serves fresh per-airport status for a few airports.
//   GET /health                              -> {ok, version, time}
//   GET /status?ids=ORD,MSP,KFCM[&tz=KFCM:America/Chicago]   (IATA or ICAO, up to 12)
//       -> status.json shape for those airports + {live: true, generated}; airports outside the
//          curated list come back in `wx` (the data/wx/<letter>.json shard entry shape).
// Fast, small sources are fetched live per request (AWC METAR/TAF for the ids only, AWC airsigmet,
// FAA NAS status, NWS alerts per point); slow or heavy ones (LAMP, SPC, TCF, CWA, ATCSCC) come
// from the latest GitHub Actions build (data/status.json). Levels are recomputed with the same
// poller functions (poller/core.mjs -> risk.mjs), so results match the build except for being fresher.
// Every source is independent: a failed live source falls back to the build's value (`stale: true`).
// Pure ES modules only (no node: imports); README "Live relay" has the architecture and limits.
import { assemble, computeGlobal } from "../poller/core.mjs";
import { parseFaaXml } from "../poller/lib.mjs";
import { parseMetar, parseTaf } from "../poller/taf-parse.mjs";
import { toMs } from "../poller/risk.mjs";

export const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
export const AWC = "https://aviationweather.gov/api/data";
export const FAA_URL = "https://nasstatus.faa.gov/api/airport-status-information";
export const BUILD_BASE = "https://tylerbridges.github.io/airport-wx/data/";
export const MAX_IDS = 12;
export const TTL = { live: 60e3, build: 120e3, response: 30e3, model: 6 * 3600e3 }; // model: phase3 delay model files
export const LIVE_SOURCES = ["metar", "taf", "sigmet", "faa", "nws"];
export const BUILD_SOURCES = ["spc", "lamp", "atcscc", "tcf", "cwa"];
const HOUR = 3600e3;
const TIMEOUT = { live: 8e3, build: 8e3 };

// ---------- request parsing ----------

/** "ord, MSP,kfcm" -> {ids: ["ORD","MSP","KFCM"], bad: []}; duplicates dropped, order kept. */
export function parseIds(raw) {
  const ids = [];
  const bad = [];
  for (const tok of String(raw ?? "").toUpperCase().split(/[\s,]+/)) {
    if (!tok) continue;
    if (!/^[A-Z0-9]{3,4}$/.test(tok)) bad.push(tok.slice(0, 12));
    else if (!ids.includes(tok)) ids.push(tok);
  }
  return { ids, bad };
}

const tzOk = new Map();
function validZone(z) {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(z)) return false;
  if (!tzOk.has(z)) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: z }); tzOk.set(z, true); } catch { tzOk.set(z, false); }
  }
  return tzOk.get(z);
}

/** "KFCM:America/Chicago,EGLL:Europe/London" -> {KFCM: "America/Chicago", ...} (invalid pairs dropped). */
export function parseTz(raw) {
  const out = {};
  for (const pair of String(raw ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    const id = pair.slice(0, i).trim().toUpperCase();
    const z = pair.slice(i + 1).trim();
    if (/^[A-Z0-9]{4}$/.test(id) && validZone(z)) out[id] = z;
  }
  return out;
}

/** Cache key of a /status request: sorted ids, plus the tz hints that apply to them. */
export function cacheKey(ids, tz = {}) {
  const s = [...ids].sort();
  const z = s.filter((id) => tz[id]).map((id) => `${id}:${tz[id]}`);
  return `/status?ids=${s.join(",")}${z.length ? `&tz=${z.join(",")}` : ""}`;
}

// ---------- CORS ----------

export function allowedOrigin(o) {
  return o === "https://tylerbridges.github.io" || /^http:\/\/localhost(?::\d{1,5})?$/.test(String(o || ""));
}

export function corsHeaders(origin) {
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (allowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function reply(body, status, origin, extra = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin), ...extra } });
}

// ---------- caching: per-isolate memory first, then the Cache API ----------
// The Cache API is a no-op on *.workers.dev (it needs a custom domain), so the memory layer is what
// usually keeps upstream requests to one per minute per isolate there.

const MEM = new Map(); // key -> {at, value} | {pending}
const MEM_MAX = 300;

/** Tests/bench: drop every cached value, or with "responses" only the cached /status responses. */
export function _reset(what = "all") {
  if (what === "responses") { for (const k of [...MEM.keys()]) if (k.startsWith("/status")) MEM.delete(k); }
  else MEM.clear();
}

function memPrune(now) {
  if (MEM.size <= MEM_MAX) return;
  for (const [k, v] of MEM) if (!v.pending && now - v.at > TTL.build) MEM.delete(k);
  while (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value);
}

const edgeCache = () => (typeof caches !== "undefined" && caches.default ? caches.default : null);
/** Cache API key for an upstream URL or response key: under the worker's own origin. */
export function upstreamKey(origin, key) {
  return `${origin}/__cache/${encodeURIComponent(key)}`;
}

/**
 * The parsed value of a cached text resource. load() -> text (throws on failure); parse(text) -> value.
 * Returns {ok: true, value, at} or {ok: false, error, at}. Failures aren't cached; concurrent callers share one load.
 */
async function cached(key, ttl, load, parse, env) {
  const now = Date.now();
  const hit = MEM.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && now - hit.at < ttl) return { ok: true, value: hit.value, at: hit.at };
  const pending = (async () => {
    const cache = edgeCache();
    const ck = cache && env.origin ? upstreamKey(env.origin, key) : null;
    try {
      let text = null;
      let at = Date.now();
      if (ck) {
        try {
          const r = await cache.match(ck);
          const t = r && Number(r.headers.get("X-At"));
          if (r && t && Date.now() - t < ttl) { text = await r.text(); at = t; }
        } catch { /* cache miss */ }
      }
      if (text == null) {
        text = await load();
        at = Date.now();
        if (ck) {
          const put = cache.put(ck, new Response(text, { headers: { "Cache-Control": `max-age=${Math.ceil(ttl / 1000)}`, "X-At": String(at) } })).catch(() => {});
          if (env.ctx?.waitUntil) env.ctx.waitUntil(put);
        }
      }
      const value = parse(text);
      MEM.set(key, { at, value });
      memPrune(Date.now());
      return { ok: true, value, at };
    } catch (e) {
      MEM.delete(key);
      return { ok: false, error: String(e?.message || e), at: Date.now() };
    }
  })();
  MEM.set(key, { pending });
  return pending;
}

async function http(url, { timeout, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const host = new URL(url).host;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
    return text;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`timeout after ${timeout / 1000}s (${host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const jsonList = (t) => (t.trim() ? JSON.parse(t) : []);
// phase3 hook: delay model files from the Pages site (data/model/), kept 6 h; a 404 (e.g. no
// model.json before the first trained model passes the gate) is cached as null, not retried per request.
const modelFile = (url, env) => cached(url, TTL.model, async () => {
  try { return await http(url, { timeout: TIMEOUT.build }); } catch (e) { if (/HTTP 404/.test(String(e?.message))) return "null"; throw e; }
}, JSON.parse, env);
export async function loadDelay(base, iatas, env) {
  const [model, fallback, ...an] = await Promise.all([
    modelFile(base + "model/model.json", env), modelFile(base + "model/fallback.json", env),
    ...iatas.map((i) => modelFile(`${base}model/analogs/${i}.json`, env)),
  ]);
  const analogs = {};
  iatas.forEach((i, k) => { if (an[k].ok && an[k].value) analogs[i] = an[k].value; });
  return { model: model.ok ? model.value : null, fallback: fallback.ok ? fallback.value : null, analogs };
}
const live = (url, parse, env, headers) => cached(url, TTL.live, () => http(url, { timeout: TIMEOUT.live, headers }), parse, env);
const fromBuild = (url, env) => cached(url, TTL.build, () => http(url, { timeout: TIMEOUT.build }), JSON.parse, env);

// ---------- overlay (pure) ----------

/** status.json `metar` -> the AWC JSON fields risk.mjs scores (exact for scoring: ceiling becomes one BKN layer). */
export function awcMetarFromStatus(icao, m) {
  if (!m || !m.obsTime) return null;
  return {
    icaoId: icao, obsTime: Math.round(Date.parse(m.obsTime) / 1000), rawOb: m.raw || "", fltCat: m.fltCat || null,
    wdir: m.wind?.dir ?? null, wspd: m.wind?.spd ?? null, wgst: m.gust ?? null, visib: m.visib, wxString: m.wx || null,
    clouds: m.ceiling != null ? [{ cover: "BKN", base: m.ceiling }] : [], temp: m.temp ?? null, dewp: m.dewp ?? null,
  };
}

function awcTafFromStatus(icao, t) {
  if (!t || !t.raw) return null;
  const p = parseTaf(t.raw, { issueTime: toMs(t.issued) });
  if (p) p.icaoId = icao;
  return p;
}

/**
 * Combine live sources with the build. Pure; all inputs already fetched/parsed.
 *   majors: [{iata, icao, name, city, state, tz, lat, lon}] requested curated airports
 *   others: [{icao, tz}] requested airports outside the curated list
 *   build: parsed status.json or null; shards: {letter: parsed shard} (only when a live METAR/TAF failed)
 *   src: {metar, taf, sigmet, faa, nws}: each {ok, value, at, error} or undefined (not fetched);
 *        nws.value = {IATA: alerts GeoJSON | null (that point failed)}
 * Returns {sources, airports, wx, h0}.
 */
export function overlay({ now = new Date(), majors = [], others = [], build = null, shards = {}, src = {}, delay = null }) {
  const buildBy = new Map((build?.airports || []).map((a) => [a.iata, a]));
  const ok = (n) => !!src[n]?.ok;
  const bsrc = build?.sources || {};
  const sources = {};
  const staleMeta = (n, liveError, note) => ({ ...(bsrc[n] || { ok: false, at: null, error: "build data unavailable" }), stale: true, liveError: liveError ?? null, ...(note ? { note } : {}) });

  // METAR / TAF: live records; the build's (or a shard's) where the live source failed or lacks the airport.
  const metars = ok("metar") ? [...src.metar.value] : [];
  const tafs = ok("taf") ? [...src.taf.value] : [];
  const haveM = new Set(metars.map((x) => x.icaoId));
  const haveT = new Set(tafs.map((x) => x.icaoId));
  let usedM = 0;
  let usedT = 0;
  for (const a of majors) {
    const b = buildBy.get(a.iata);
    if (!b) continue;
    if (!haveM.has(a.icao)) { const m = awcMetarFromStatus(a.icao, b.metar); if (m) { metars.push(m); usedM += ok("metar") ? 0 : 1; } }
    if (!haveT.has(a.icao)) { const t = awcTafFromStatus(a.icao, b.taf); if (t) { tafs.push(t); usedT += ok("taf") ? 0 : 1; } }
  }
  for (const a of others) {
    const e = shards[a.icao[0]]?.a?.[a.icao];
    if (!e) continue;
    if (!haveM.has(a.icao) && e.m) { const m = parseMetar(e.m, { ref: toMs(e.mt) ?? +now }); if (m) { m.icaoId = a.icao; m.rawOb = e.m; if (e.mt) m.obsTime = Math.round(Date.parse(e.mt) / 1000); metars.push(m); } }
    if (!haveT.has(a.icao) && e.t) { const t = parseTaf(e.t, { issueTime: toMs(e.ti) }); if (t) { t.icaoId = a.icao; tafs.push(t); } }
  }

  let airports = [];
  if (majors.length) {
    const faaParsed = ok("faa") ? src.faa.value : null;
    const nwsMap = ok("nws") ? src.nws.value : {};
    const stations = {};
    const adv = [];
    for (const a of majors) {
      const b = buildBy.get(a.iata);
      if (b?.lamp) stations[a.icao] = b.lamp;
      for (const x of b?.atcscc || []) adv.push(x);
    }
    let nwsFallback = 0;
    const over = (a) => {
      const b = buildBy.get(a.iata);
      // the build's per-airport ops plan ({...plan items, items}) stands in for opsPlanFor(plan)
      const o = { spc: b?.spc ?? null, tcf: b?.tcf || [], cwa: b?.cwa || [], opsplan: b?.opsplan ?? null };
      if (!faaParsed) o.faa = (b?.faa || []).map((f) => ({ ...f })); // copies: assemble may add an ops-plan end
      if (!ok("sigmet")) o.sigmets = b?.sigmets || [];
      if (!nwsMap[a.iata]) { o.alerts = b?.alerts || []; nwsFallback++; }
      return o;
    };
    // phase3 hook: delay model; hubs not requested use the build's TAF
    const icaoOf = Object.fromEntries([...(build?.airports || []), ...majors].map((a) => [a.iata, a.icao]));
    const scoring = delay && (delay.model || delay.fallback)
      ? { ...delay, icaoOf, hubTaf: (iata) => awcTafFromStatus(icaoOf[iata], buildBy.get(iata)?.taf) } : null;
    const out = assemble({
      airports: majors, now, metars, tafs, sigmets: ok("sigmet") ? src.sigmet.value : null, faaParsed,
      spc: null, nws: nwsMap, lamp: { stations }, atcscc: adv, tcf: null, cwa: null, over, delay: scoring,
    });
    // Fields the relay doesn't recompute (added to status.json later) carry over from the build.
    airports = out.map((a) => ({ ...(buildBy.get(a.iata) || {}), ...a }));
    if (!scoring) { // phase3: model files unavailable -> the build's delay numbers for the same hours
      for (const a of airports) {
        const bh = new Map((buildBy.get(a.iata)?.hours || []).map((h) => [h.t, h.delay]));
        a.hours = a.hours.map((h) => (h.delay || !bh.get(h.t) ? h : { ...h, delay: bh.get(h.t) }));
      }
    }
    if (src.nws) {
      if (!ok("nws")) sources.nws = staleMeta("nws", src.nws.error);
      else sources.nws = { ok: true, at: new Date(src.nws.at).toISOString(), error: nwsFallback ? `${nwsFallback} of ${majors.length} point requests failed; the build's alerts are shown there` : null, live: true, ...(nwsFallback ? { stale: true } : {}) };
    }
  }

  const wx = {};
  if (others.length) {
    const g = computeGlobal({ airports: others.map((a) => ({ icao: a.icao, tz: a.tz || "UTC" })), metars, tafs, now });
    for (const a of others) wx[a.icao] = g.get(a.icao) || null;
  }

  for (const n of ["metar", "taf", "sigmet", "faa"]) {
    const s = src[n];
    if (!s) continue;
    if (s.ok) sources[n] = { ok: true, at: new Date(s.at).toISOString(), error: null, live: true };
    else sources[n] = staleMeta(n, s.error, n === "metar" && usedM ? `${usedM} from the build` : n === "taf" && usedT ? `${usedT} from the build` : null);
  }
  for (const n of [...LIVE_SOURCES, ...BUILD_SOURCES]) {
    if (!sources[n]) sources[n] = bsrc[n] ? { ...bsrc[n], from: "build" } : { ok: false, at: null, error: "build data unavailable", from: "build" };
  }
  return { sources, airports, wx, h0: new Date(Math.floor(+now / HOUR) * HOUR).toISOString() };
}

// ---------- /status ----------

let metaCache = { raw: null, list: null };
/** The curated airport list: the AIRPORTS binding (airports.json, set at deploy) or else the build's airports. */
function airportMeta(env, build) {
  if (env.AIRPORTS) {
    if (metaCache.raw !== env.AIRPORTS) {
      try { metaCache = { raw: env.AIRPORTS, list: typeof env.AIRPORTS === "string" ? JSON.parse(env.AIRPORTS) : env.AIRPORTS }; } catch { metaCache = { raw: env.AIRPORTS, list: null }; }
    }
    if (Array.isArray(metaCache.list) && metaCache.list.length) return metaCache.list;
  }
  return (build?.airports || []).map(({ iata, icao, name, city, state, tz, lat, lon }) => ({ iata, icao, name, city, state, tz, lat, lon }));
}

/** ids -> {majors, others, unknown} against the curated list. */
export function resolveIds(ids, list, tz = {}) {
  const byIata = new Map(list.map((a) => [a.iata, a]));
  const byIcao = new Map(list.map((a) => [a.icao, a]));
  const majors = [];
  const others = [];
  const unknown = [];
  for (const id of ids) {
    const a = byIata.get(id) || byIcao.get(id);
    if (a) { if (!majors.includes(a)) majors.push(a); }
    else if (id.length === 4) others.push({ icao: id, tz: tz[id] || null });
    else unknown.push(id);
  }
  return { majors, others, unknown };
}

/** Fetch everything for one request and overlay it. Returns {body, allFailed}. */
export async function liveStatus({ ids, tz = {}, env = {}, now = new Date() }) {
  const base = env.BUILD_BASE || BUILD_BASE;
  const buildP = fromBuild(base + "status.json", env);
  let list = airportMeta(env, null);
  let build = null;
  if (!list.length) { build = await buildP; list = airportMeta(env, build.ok ? build.value : null); }
  const { majors, others, unknown } = resolveIds(ids, list, tz);
  const icaos = [...new Set([...majors.map((a) => a.icao), ...others.map((a) => a.icao)])].sort();

  const src = {};
  const jobs = [];
  const run = (name, p) => jobs.push(p.then((r) => { src[name] = r; }));
  if (icaos.length) {
    run("metar", live(`${AWC}/metar?ids=${icaos.join(",")}&format=json`, jsonList, env));
    run("taf", live(`${AWC}/taf?ids=${icaos.join(",")}&format=json`, jsonList, env));
  }
  if (majors.length) {
    run("sigmet", live(`${AWC}/airsigmet?format=json`, jsonList, env));
    const tzBy = Object.fromEntries(list.map((a) => [a.iata, a.tz]));
    run("faa", live(FAA_URL, (t) => parseFaaXml(t, { now, tzFor: (c) => tzBy[c] || "America/New_York" }), env));
    run("nws", (async () => {
      const res = await Promise.all(majors.map((a) =>
        live(`https://api.weather.gov/alerts/active?point=${a.lat.toFixed(4)},${a.lon.toFixed(4)}`, JSON.parse, env, { Accept: "application/geo+json" })));
      const value = {};
      let at = 0;
      let firstErr = null;
      res.forEach((r, i) => { value[majors[i].iata] = r.ok ? r.value : null; if (r.ok) at = Math.max(at, r.at); else firstErr ||= r.error; });
      return res.some((r) => r.ok) ? { ok: true, value, at } : { ok: false, error: `all ${res.length} requests failed: ${firstErr}`, at: Date.now() };
    })());
  }
  const delayP = majors.length ? loadDelay(base, majors.map((a) => a.iata), env) : null; // phase3 hook
  await Promise.all(jobs);
  if (!build) build = await buildP;
  const delay = delayP ? await delayP : null;

  // Shards only when a live METAR/TAF request failed for airports outside the curated list.
  const shards = {};
  if (others.length && (!src.metar?.ok || !src.taf?.ok)) {
    const letters = [...new Set(others.map((a) => a.icao[0]))];
    await Promise.all(letters.map(async (L) => {
      const r = await fromBuild(`${base}wx/${L}.json`, env);
      if (r.ok) shards[L] = r.value;
    }));
  }

  const o = overlay({ now, majors, others, build: build.ok ? build.value : null, shards, src, delay });
  const fetched = Object.values(src);
  const allFailed = !build.ok && fetched.every((r) => !r.ok);
  const body = {
    live: true,
    generated: now.toISOString(),
    build: build.ok ? { ok: true, generated: build.value.generated ?? null } : { ok: false, error: build.error },
    ids,
    unknown,
    sources: o.sources,
    airports: o.airports,
    wx: o.wx,
    h0: o.h0,
  };
  return { body, allFailed };
}

async function status(url, env, origin) {
  const p = parseIds(url.searchParams.get("ids"));
  if (p.bad.length) return reply({ error: `bad id(s): ${p.bad.join(", ")} (use IATA or ICAO codes)` }, 400, origin);
  if (!p.ids.length) return reply({ error: "ids required, e.g. /status?ids=ORD,MSP" }, 400, origin);
  if (p.ids.length > MAX_IDS) return reply({ error: `at most ${MAX_IDS} ids per request` }, 400, origin);
  const tz = parseTz(url.searchParams.get("tz"));
  const key = cacheKey(p.ids, tz);
  const r = await cached(key, TTL.response, async () => {
    const { body, allFailed } = await liveStatus({ ids: p.ids, tz, env, now: new Date() });
    if (allFailed) throw new Error("all sources failed (live and the build)");
    return JSON.stringify(body);
  }, (t) => t, env);
  if (!r.ok) return reply({ live: true, generated: new Date().toISOString(), error: r.error }, 502, origin, { "Cache-Control": "no-store" });
  return reply(r.value, 200, origin, { "Cache-Control": "public, max-age=30", "X-Relay-Age": String(Math.round((Date.now() - r.at) / 1000)) });
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const e = { ...env, ctx, origin: url.origin };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "GET" && request.method !== "HEAD") return reply({ error: "method not allowed" }, 405, origin, { Allow: "GET, OPTIONS" });
    if (url.pathname === "/health") return reply({ ok: true, version: env.VERSION || "dev", time: new Date().toISOString() }, 200, origin, { "Cache-Control": "no-store" });
    if (url.pathname === "/status") return status(url, e, origin);
    return reply({ error: "not found", paths: ["/health", "/status?ids=ORD,MSP"] }, 404, origin);
  },
};
