#!/usr/bin/env node
// Polls aviation weather sources server-side and writes site/data/status.json.
//   node poller/poll.mjs               live (network)
//   node poller/poll.mjs --fixtures    read poller/fixtures/ instead, times shifted to "now"
//   --out <path>                       output file (default site/data/status.json)
// Exits 0 unless every source failed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildHours, summarize, hoursOutput, compareAirports, parseVisib, ceilingOf, flightCategory, toMs,
} from "./risk.mjs";
import {
  parseFaaXml, spcCategoryAt, convectiveSigmetsAt, normalizeAlerts, expandTemplate, pool, latestBy,
} from "./lib.mjs";
import { runGlobal } from "./global.mjs"; // build2a hook: global METAR/TAF shards for searched airports

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const TIMEOUT_MS = 20_000;
const AWC = "https://aviationweather.gov/api/data";

async function http(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout after ${TIMEOUT_MS / 1000}s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const parseJson = (t) => (t.trim() ? JSON.parse(t) : []);

/** Runs a source; never throws. */
async function runSource(fn) {
  try {
    const data = await fn();
    return { meta: { ok: true, at: new Date().toISOString(), error: null }, data };
  } catch (e) {
    return { meta: { ok: false, at: new Date().toISOString(), error: String(e?.message || e) }, data: null };
  }
}

export async function loadAirports() {
  return JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
}

// ---------- input providers (live vs fixtures) ----------

function liveProviders(airports) {
  const icaos = airports.map((a) => a.icao).join(",");
  return {
    metar: async () => parseJson(await http(`${AWC}/metar?ids=${icaos}&format=json`)),
    taf: async () => parseJson(await http(`${AWC}/taf?ids=${icaos}&format=json`)),
    sigmet: async () => parseJson(await http(`${AWC}/airsigmet?format=json`)),
    faa: async () => http("https://nasstatus.faa.gov/api/airport-status-information"),
    spc: async () => JSON.parse(await http("https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson")),
    nws: async () => {
      let failures = 0;
      let firstErr = null;
      const results = await pool(airports, 6, async (a) => {
        try {
          const url = `https://api.weather.gov/alerts/active?point=${a.lat.toFixed(4)},${a.lon.toFixed(4)}`;
          return [a.iata, JSON.parse(await http(url, { Accept: "application/geo+json" }))];
        } catch (e) {
          failures++;
          firstErr ||= String(e.message || e);
          return [a.iata, null];
        }
      });
      if (failures === airports.length) throw new Error(`all ${failures} requests failed: ${firstErr}`);
      return { map: Object.fromEntries(results), partial: failures ? `${failures} of ${airports.length} requests failed: ${firstErr}` : null };
    },
  };
}

function fixtureProviders(airports, now) {
  const dir = process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : join(HERE, "fixtures"); // build2a hook: scenario fixture sets
  const read = async (name) => expandTemplate(await readFile(join(dir, name), "utf8"), now);
  return {
    metar: async () => JSON.parse(await read("metar.json")),
    taf: async () => JSON.parse(await read("taf.json")),
    sigmet: async () => JSON.parse(await read("airsigmet.json")),
    faa: async () => read("faa.xml"),
    spc: async () => JSON.parse(await read("spc.geojson")),
    nws: async () => {
      let single = null;
      try { single = JSON.parse(await read("nws.json")); } catch { /* try per-airport files */ }
      const map = {};
      for (const a of airports) {
        if (single) { map[a.iata] = single[a.iata] || { features: [] }; continue; }
        try { map[a.iata] = JSON.parse(await read(`nws-${a.iata}.json`)); } catch { map[a.iata] = { features: [] }; }
      }
      return { map, partial: null };
    },
  };
}

// ---------- assembly ----------

export function assemble({ airports, now, metars, tafs, sigmets, faaParsed, spc, nws }) {
  const metarBy = latestBy(metars, "icaoId", "obsTime");
  const tafBy = latestBy(tafs, "icaoId", "issueTime");
  const out = [];
  for (const a of airports) {
    let m = metarBy.get(a.icao) || null;
    const obsMs = m ? toMs(m.obsTime) : null;
    if (m && obsMs != null && +now - obsMs > 2 * 3600e3) m = null; // stale
    let t = tafBy.get(a.icao) || null;
    if (t && toMs(t.validTimeTo) != null && toMs(t.validTimeTo) < +now) t = null;

    const faa = (faaParsed?.byAirport[a.iata] || []).map(({ type, reason, detail, badge }) => ({ type, reason, detail, badge }));
    const alertsFull = nws ? normalizeAlerts(nws[a.iata], now) : [];
    const sigs = sigmets ? convectiveSigmetsAt(a.lon, a.lat, sigmets, now) : [];
    const spcCat = spc ? spcCategoryAt(a.lon, a.lat, spc) : null;

    const hours = buildHours({
      now, tz: a.tz, taf: t, metar: m, faa, sigmet: sigs.length > 0,
      alerts: alertsFull.map((x) => ({ event: x.event, onset: x.onset, ends: x.ends })), spc: spcCat,
    });
    const { now: nowS, peak } = summarize(hours, a.tz);

    out.push({
      iata: a.iata, icao: a.icao, name: a.name, city: a.city, state: a.state, tz: a.tz, lat: a.lat, lon: a.lon,
      now: nowS, peak, hours: hoursOutput(hours),
      metar: m
        ? {
            raw: m.rawOb || "",
            obsTime: obsMs != null ? new Date(obsMs).toISOString() : null,
            fltCat: m.fltCat || flightCategory(parseVisib(m.visib), ceilingOf(m.clouds)),
            wind: { dir: m.wdir ?? null, spd: m.wspd ?? null },
            gust: m.wgst ?? null,
            visib: parseVisib(m.visib),
            ceiling: ceilingOf(m.clouds),
            wx: m.wxString || null,
            temp: m.temp ?? null,
            dewp: m.dewp ?? null,
          }
        : null,
      taf: t ? { raw: t.rawTAF || "", issued: toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null } : null,
      faa,
      alerts: alertsFull.slice(0, 10).map(({ event, severity, headline, ends }) => ({ event, severity, headline, ends })),
      spc: spcCat,
      sigmets: sigs,
    });
  }
  out.sort(compareAirports);
  return out;
}

export async function run({ fixtures = false, out = join(ROOT, "site/data/status.json"), now = new Date() } = {}) {
  const airports = await loadAirports();
  const p = fixtures ? fixtureProviders(airports, now) : liveProviders(airports);
  const names = ["metar", "taf", "sigmet", "faa", "nws", "spc"];
  const res = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await runSource(p[n])])));

  const tzByIata = Object.fromEntries(airports.map((a) => [a.iata, a.tz]));
  let faaParsed = null;
  if (res.faa.meta.ok) {
    try {
      faaParsed = parseFaaXml(res.faa.data, { now, tzFor: (c) => tzByIata[c] || "America/New_York" });
    } catch (e) {
      res.faa.meta = { ok: false, at: new Date().toISOString(), error: "parse error: " + e.message };
    }
  }
  if (res.nws.meta.ok && res.nws.data.partial) res.nws.meta.error = res.nws.data.partial;

  const status = {
    generated: now.toISOString(),
    sources: Object.fromEntries(names.map((n) => [n, res[n].meta])),
    airports: assemble({
      airports, now,
      metars: res.metar.data, tafs: res.taf.data, sigmets: res.sigmet.data,
      faaParsed, spc: res.spc.data, nws: res.nws.data?.map ?? null,
    }),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(status) + "\n");
  const okCount = names.filter((n) => status.sources[n].ok).length;
  return { status, okCount, total: names.length, out };
}

async function main() {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const { status, okCount, total, out } = await run({
    fixtures: args.includes("--fixtures"),
    out: oi >= 0 ? resolve(args[oi + 1]) : undefined,
  });
  await runGlobal({ fixtures: args.includes("--fixtures") }); // build2a hook: writes site/data/wx/ (never throws)
  for (const [n, s] of Object.entries(status.sources)) console.log(`${s.ok ? "ok  " : "FAIL"} ${n}${s.error ? ": " + s.error : ""}`);
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
