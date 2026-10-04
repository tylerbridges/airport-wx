#!/usr/bin/env node
// Polls aviation weather and traffic-management sources server-side and writes site/data/status.json.
//   node poller/poll.mjs               live (network)
//   node poller/poll.mjs --fixtures    read poller/fixtures/ instead, times shifted to "now"
//   --out <path>                       output file (default site/data/status.json)
//   --raw <dir>                        raw response samples (default .cache/raw; "--raw none" to skip)
// Exits 0 unless every source failed.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFaaXml, expandTemplate, pool } from "./lib.mjs";
import { lampCycles, lampUrl, parseLamp, lampBlocks, ATCSCC_URL, collectAtcscc } from "./sources.mjs";
import { parseOpsPlan, opsPlanNational } from "./opsplan.mjs";
import { assemble } from "./core.mjs"; // live relay: pure assembly shared with worker/worker.mjs
import { runGlobal } from "./global.mjs"; // build2a hook: global METAR/TAF shards for searched airports
import { observedHours } from "./risk.mjs"; // build2b hook: observed past hours for the timeline
import { modelInfo } from "./delay.mjs"; // phase3 hook: delay model
import { prepareTrips } from "./trips-poll.mjs"; // trips hook: flight calendar -> trips.json + trip airports
import { startMovement } from "./movement.mjs"; // movement hook: ADS-B departure/arrival rates -> site/data/movement.json
import { fetchNotices } from "./notices-poll.mjs"; // restrictions hook: FAA TFRs (README "Notices")

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const TIMEOUT_MS = 20_000;
const AWC = "https://aviationweather.gov/api/data";
const RAW_MAX = 200 * 1024;
export const SOURCE_NAMES = ["metar", "taf", "sigmet", "faa", "nws", "spc", "lamp", "atcscc", "tcf", "cwa"];
export const DEFAULT_RAW_DIR = join(ROOT, ".cache/raw");

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** GET url -> {status, text}; throws HttpError (with .status) on non-2xx, Error on timeout. */
async function http(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, text.slice(0, 300));
    return { status: res.status, text };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout after ${TIMEOUT_MS / 1000}s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const parseJson = (t) => (t.trim() ? JSON.parse(t) : []);

/** Collects the first 200 KB of raw responses plus per-source fetch notes for sources.json. */
export function makeRaw() {
  const files = {};
  const meta = {};
  const note = (name, o) => { meta[name] = { ...(meta[name] || {}), ...o }; };
  // main = this file is the source's primary response (its full size goes in `bytes`)
  const save = (name, file, text, extra = {}, main = true) => {
    const buf = Buffer.from(String(text ?? ""), "utf8");
    files[file] = buf.subarray(0, RAW_MAX);
    note(name, { ...(main ? { bytes: buf.length } : {}), ...extra, files: [...new Set([...(meta[name]?.files || []), file])] });
  };
  return { files, meta, note, save };
}

/** Runs a source; never throws. */
async function runSource(name, fn, raw) {
  try {
    const data = await fn();
    return { meta: { ok: true, at: new Date().toISOString(), error: null }, data };
  } catch (e) {
    if (e instanceof HttpError) raw.note(name, { http: e.status, errorBody: e.body || undefined });
    return { meta: { ok: false, at: new Date().toISOString(), error: String(e?.message || e) }, data: null };
  }
}

export async function loadAirports() {
  return JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
}

/**
 * phase3: the delay model files (site/data/model, or DELAY_MODEL_DIR): model.json (only once a trained
 * model passed the safety gate), fallback.json (rule level -> historical rate, climatology) and
 * analogs/<IATA>.json. Missing files are fine: no model -> fallback; neither -> no `delay` fields.
 */
export async function loadDelayModel(airports, dir = process.env.DELAY_MODEL_DIR ? resolve(process.env.DELAY_MODEL_DIR) : join(ROOT, "site/data/model")) {
  const rd = async (f) => { try { return JSON.parse(await readFile(join(dir, f), "utf8")); } catch { return null; } };
  const analogs = {};
  for (const a of airports) { const x = await rd(`analogs/${a.iata}.json`); if (x) analogs[a.iata] = x; }
  return { model: await rd("model.json"), fallback: await rd("fallback.json"), analogs, icaoOf: Object.fromEntries(airports.map((a) => [a.iata, a.icao])) };
}

// ---------- input providers (live vs fixtures) ----------

function liveProviders(airports, now, raw) {
  const icaos = airports.map((a) => a.icao).join(",");
  const want = new Set(airports.map((a) => a.icao));
  /** One request whose body is the raw sample for the source. */
  const get = async (name, file, url, headers) => {
    raw.note(name, { url });
    const r = await http(url, headers);
    raw.save(name, file, r.text, { http: r.status });
    return r.text;
  };
  return {
    metar: async () => parseJson(await get("metar", "metar.json", `${AWC}/metar?ids=${icaos}&format=json`)),
    taf: async () => parseJson(await get("taf", "taf.json", `${AWC}/taf?ids=${icaos}&format=json`)),
    sigmet: async () => parseJson(await get("sigmet", "airsigmet.json", `${AWC}/airsigmet?format=json`)),
    faa: async () => get("faa", "faa.xml", "https://nasstatus.faa.gov/api/airport-status-information"),
    spc: async () => JSON.parse(await get("spc", "spc.geojson", "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson")),
    nws: async () => {
      let failures = 0;
      let firstErr = null;
      let sampled = false;
      const results = await pool(airports, 6, async (a) => {
        const url = `https://api.weather.gov/alerts/active?point=${a.lat.toFixed(4)},${a.lon.toFixed(4)}`;
        try {
          const r = await http(url, { Accept: "application/geo+json" });
          const j = JSON.parse(r.text);
          if (!sampled && (j?.features || []).length) {
            sampled = true;
            raw.save("nws", "nws.json", r.text, { http: r.status, url });
          }
          return [a.iata, j];
        } catch (e) {
          failures++;
          firstErr ||= String(e.message || e);
          return [a.iata, null];
        }
      });
      if (failures === airports.length) throw new Error(`all ${failures} requests failed: ${firstErr}`);
      raw.note("nws", { requests: airports.length, failed: failures, sample: sampled ? "first response with alerts" : "none had alerts" });
      return { map: Object.fromEntries(results), partial: failures ? `${failures} of ${airports.length} requests failed: ${firstErr}` : null };
    },
    lamp: async () => {
      const tries = [];
      for (const cyc of lampCycles(now, 3)) {
        const url = lampUrl(cyc);
        try {
          const r = await http(url);
          const parsed = parseLamp(r.text, want);
          tries.push({ url, http: r.status, blocks: parsed.blocks });
          if (!parsed.blocks) continue; // empty or not a LAMP bulletin: try the previous cycle
          raw.save("lamp", "lamp.txt", r.text, { http: r.status, url });
          raw.save("lamp", "lamp-airports.txt", lampBlocks(r.text, want), {}, false);
          raw.note("lamp", { tries, stations: Object.keys(parsed.stations).length });
          return { ...parsed, url };
        } catch (e) {
          tries.push({ url, http: e.status ?? null, error: String(e.message || e) });
          if (e.status !== 404) { raw.note("lamp", { tries }); throw e; }
        }
      }
      raw.note("lamp", { tries });
      throw new Error(`no LAMP bulletin in the last ${tries.length} cycles (${tries.map((t) => t.http ?? t.error).join(", ")})`);
    },
    atcscc: async () => {
      const html = await get("atcscc", "atcscc.html", ATCSCC_URL);
      return atcsccFrom(html, async (url) => (await http(url)).text, now, raw);
    },
    tcf: async () => {
      const url = `${AWC}/tcf?format=geojson`;
      raw.note("tcf", { url });
      const r = await http(url);
      raw.save("tcf", "tcf.json", r.text, { http: r.status });
      return r.status === 204 || !r.text.trim() ? { features: [] } : JSON.parse(r.text);
    },
    cwa: async () => parseJson(await get("cwa", "cwa.json", `${AWC}/cwa?format=json`)),
    // build2b hook: the last 24 hours of METARs (observed past hours); not a status source, failure = no `observed`
    metarHistory: async () => parseJson((await http(`${AWC}/metar?ids=${icaos}&format=json&hours=24`)).text),
  };
}

async function atcsccFrom(html, getText, now, raw) {
  const r = await collectAtcscc(html, getText, { now });
  if (r.firstDetail != null) raw.save("atcscc", "atcscc-detail.html", r.firstDetail, {}, false);
  // The page is "The Most Recent ATCSCC Advisory": usually the DCC operations plan.
  let plan = null;
  try { plan = parseOpsPlan(html); } catch { /* not a plan */ }
  raw.note("atcscc", {
    links: r.links, followed: r.followed, failed: r.failed, parsed: r.list.length,
    opsplan: plan ? { advisory: plan.advisory, issued: plan.issued, staffing: plan.staffing.length, constraints: plan.constraints.length, programs: plan.programs.length, sirs: plan.sirs.length, launches: plan.launches.length } : null,
  });
  if (r.followed && r.failed === r.followed && !r.list.length) throw new Error(`all ${r.failed} advisory pages failed: ${r.firstError}`);
  return { list: r.list, plan, partial: r.failed ? `${r.failed} of ${r.followed} advisory pages failed: ${r.firstError}` : null };
}

function fixtureProviders(airports, now, raw) {
  const dir = process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : join(HERE, "fixtures"); // build2a hook: scenario fixture sets
  const want = new Set(airports.map((a) => a.icao));
  const read = async (name) => expandTemplate(await readFile(join(dir, name), "utf8"), now);
  const fx = async (source, file, rawFile = file) => {
    const text = await read(file);
    raw.save(source, rawFile, text, { url: `fixture:${file}` });
    return text;
  };
  return {
    metar: async () => JSON.parse(await fx("metar", "metar.json")),
    taf: async () => JSON.parse(await fx("taf", "taf.json")),
    sigmet: async () => JSON.parse(await fx("sigmet", "airsigmet.json")),
    faa: async () => fx("faa", "faa.xml"),
    spc: async () => JSON.parse(await fx("spc", "spc.geojson")),
    nws: async () => {
      let single = null;
      try { single = JSON.parse(await fx("nws", "nws.json")); } catch { /* try per-airport files */ }
      const map = {};
      for (const a of airports) {
        if (single) { map[a.iata] = single[a.iata] || { features: [] }; continue; }
        try { map[a.iata] = JSON.parse(await read(`nws-${a.iata}.json`)); } catch { map[a.iata] = { features: [] }; }
      }
      return { map, partial: null };
    },
    lamp: async () => {
      const text = await fx("lamp", "lamp.txt");
      raw.save("lamp", "lamp-airports.txt", lampBlocks(text, want), {}, false);
      return { ...parseLamp(text, want), url: "fixture:lamp.txt" };
    },
    atcscc: async () => {
      const html = await fx("atcscc", "atcscc.html");
      const getText = async (url) => {
        const n = /advn=(\d+)/i.exec(url)?.[1];
        if (!n) throw new Error("no fixture for " + url);
        return read(`atcscc-adv-${Number(n)}.html`);
      };
      return atcsccFrom(html, getText, now, raw);
    },
    tcf: async () => JSON.parse(await fx("tcf", "tcf.json")),
    cwa: async () => JSON.parse(await fx("cwa", "cwa.json")),
    metarHistory: async () => JSON.parse(await read("metar-history.json")), // build2b hook
  };
}

// ---------- assembly ----------

// assemble() lives in core.mjs (pure, shared with the live relay worker).
export { assemble };

/** Replace dir with this run's raw samples and sources.json. */
async function writeRaw(dir, raw, sources) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [file, buf] of Object.entries(raw.files)) await writeFile(join(dir, file), buf);
  const meta = Object.fromEntries(Object.entries(sources).map(([n, s]) => [n, { ...s, ...(raw.meta[n] || {}) }]));
  await writeFile(join(dir, "sources.json"), JSON.stringify(meta, null, 1) + "\n");
}

export async function run({ fixtures = false, out = join(ROOT, "site/data/status.json"), now = new Date(), rawDir = null } = {}) {
  const trips = await prepareTrips({ fixtures, now }); // trips hook: reads the calendar (env FLIGHTY_ICS_URL), never throws
  const airports = await trips.addAirports(await loadAirports()); // trips hook: trip airports join the full pipeline for this run
  const raw = makeRaw();
  const p = fixtures ? fixtureProviders(airports, now, raw) : liveProviders(airports, now, raw);
  const names = SOURCE_NAMES;
  const histP = p.metarHistory().then((v) => ({ v }), (e) => ({ e })); // build2b hook: in parallel with the sources
  const noticesP = fetchNotices({ airports, fixtures, now, raw }); // restrictions hook: in parallel with the sources, never throws
  const res = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await runSource(n, p[n], raw)])));

  const tzByIata = Object.fromEntries(airports.map((a) => [a.iata, a.tz]));
  let faaParsed = null;
  if (res.faa.meta.ok) {
    try {
      faaParsed = parseFaaXml(res.faa.data, { now, tzFor: (c) => tzByIata[c] || "America/New_York" });
    } catch (e) {
      res.faa.meta = { ok: false, at: new Date().toISOString(), error: "parse error: " + e.message };
    }
  }
  for (const n of ["nws", "atcscc"]) if (res[n].meta.ok && res[n].data.partial) res[n].meta.error = res[n].data.partial;

  const delay = await loadDelayModel(airports); // phase3 hook
  const notices = await noticesP; // restrictions hook
  const status = {
    generated: now.toISOString(),
    sources: Object.fromEntries(names.map((n) => [n, res[n].meta])),
    noticeSources: notices.sources, // restrictions hook: {tfr} kept apart from core sources
    delayModel: modelInfo(delay.model, delay.fallback), // phase3 hook
    airports: assemble({
      airports, now,
      metars: res.metar.data, tafs: res.taf.data, sigmets: res.sigmet.data,
      faaParsed, spc: res.spc.data, nws: res.nws.data?.map ?? null,
      lamp: res.lamp.data, atcscc: res.atcscc.data?.list ?? null, tcf: res.tcf.data, cwa: res.cwa.data,
      plan: res.atcscc.data?.plan ?? null,
      delay, // phase3 hook
      notices: notices.data, // restrictions hook
    }),
    opsplan: opsPlanNational(res.atcscc.data?.plan ?? null, now),
  };
  // build2b hook: observed[] per airport from the 24-hour METAR history (left out when that request fails)
  const hist = await histP;
  if (hist.e) console.log("observed history unavailable: " + (hist.e.message || hist.e));
  else {
    const by = new Map();
    for (const m of hist.v || []) if (m && m.icaoId) (by.get(m.icaoId) || by.set(m.icaoId, []).get(m.icaoId)).push(m);
    for (const a of status.airports) a.observed = observedHours(by.get(a.icao) || [], now);
  }
  trips.markAirports(status.airports); // trips hook: airports added for trips carry trip: true
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(status) + "\n");
  if (rawDir) {
    try { await writeRaw(rawDir, raw, { ...status.sources, ...status.noticeSources }); } catch (e) { console.error("raw samples not written: " + e.message); } // restrictions hook: TFR samples too
  }
  await trips.finish({ out, rawDir }); // trips hook: site/data/trips.json (airports and times only) + redacted format sample
  const okCount = names.filter((n) => status.sources[n].ok).length;
  return { status, okCount, total: names.length, out, raw, metars: res.metar.data /* movement hook: field elevations */ };
}

async function main() {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const ri = args.indexOf("--raw");
  const rawArg = ri >= 0 ? args[ri + 1] : null;
  const movement = oi >= 0 ? null : startMovement({ fixtures: args.includes("--fixtures") }); // movement hook: collects alongside the sources (skipped with --out, e.g. scenario builds); never throws
  const { status, okCount, total, out, metars } = await run({
    fixtures: args.includes("--fixtures"),
    out: oi >= 0 ? resolve(args[oi + 1]) : undefined,
    rawDir: rawArg === "none" ? null : rawArg ? resolve(rawArg) : DEFAULT_RAW_DIR,
  });
  if (movement) await movement.finish({ metars }); // movement hook
  await runGlobal({ fixtures: args.includes("--fixtures"), rawDir: rawArg === "none" ? null : rawArg ? resolve(rawArg) : DEFAULT_RAW_DIR }); // build2a hook: writes site/data/wx/ (never throws)
  for (const [n, s] of Object.entries(status.sources)) console.log(`${s.ok ? "ok  " : "FAIL"} ${n}${s.error ? ": " + s.error : ""}`);
  for (const [n, s] of Object.entries(status.noticeSources || {})) console.log(`${s.ok ? "ok  " : "warn"} ${n}${s.error ? ": " + s.error : ""}`); // restrictions hook
  const top = status.airports.filter((a) => a.peak.level >= 3).length;
  console.log(`wrote ${out}: ${status.airports.length} airports, ${top} at High/Severe peak, ${okCount}/${total} sources ok`);
  if (okCount === 0) {
    console.error("all sources failed");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
