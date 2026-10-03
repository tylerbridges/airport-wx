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
import {
  buildHours, summarize, hoursOutput, compareAirports, parseVisib, ceilingOf, flightCategory, toMs,
} from "./risk.mjs";
import {
  parseFaaXml, spcCategoryAt, convectiveSigmetsAt, normalizeAlerts, expandTemplate, pool, latestBy,
} from "./lib.mjs";
import {
  lampCycles, lampUrl, parseLamp, lampBlocks, ATCSCC_URL, collectAtcscc, tcfAt, cwaAt,
} from "./sources.mjs";
import { classifyCause, causePhrase } from "./cause.mjs";

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
  };
}

async function atcsccFrom(html, getText, now, raw) {
  const r = await collectAtcscc(html, getText, { now });
  if (r.firstDetail != null) raw.save("atcscc", "atcscc-detail.html", r.firstDetail, {}, false);
  raw.note("atcscc", { links: r.links, followed: r.followed, failed: r.failed, parsed: r.list.length });
  if (r.followed && r.failed === r.followed && !r.list.length) throw new Error(`all ${r.failed} advisory pages failed: ${r.firstError}`);
  return { list: r.list, partial: r.failed ? `${r.failed} of ${r.followed} advisory pages failed: ${r.firstError}` : null };
}

function fixtureProviders(airports, now, raw) {
  const dir = join(HERE, "fixtures");
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
  };
}

// ---------- assembly ----------

const ADV_KEYS = ["id", "type", "airport", "issued", "cause", "causeText", "title", "active", "cnx", "start", "end"];

export function assemble({ airports, now, metars, tafs, sigmets, faaParsed, spc, nws, lamp = null, atcscc = null, tcf = null, cwa = null }) {
  const metarBy = latestBy(metars, "icaoId", "obsTime");
  const tafBy = latestBy(tafs, "icaoId", "issueTime");
  const out = [];
  for (const a of airports) {
    let m = metarBy.get(a.icao) || null;
    const obsMs = m ? toMs(m.obsTime) : null;
    if (m && obsMs != null && +now - obsMs > 2 * 3600e3) m = null; // stale
    let t = tafBy.get(a.icao) || null;
    if (t && toMs(t.validTimeTo) != null && toMs(t.validTimeTo) < +now) t = null;

    const faa = (faaParsed?.byAirport[a.iata] || []).map((f) => {
      const cause = classifyCause(f.reason);
      // closures' reasons are NOTAM text: the page shows their plain-English summary instead
      const o = { type: f.type, reason: f.reason, detail: f.detail, badge: f.badge, cause, causeLabel: f.type === "closure" ? "" : causePhrase(cause, f.reason) };
      if (f.type === "closure") Object.assign(o, { scope: f.scope, active: f.active, plain: f.plain, runways: f.runways });
      return o;
    });
    const alertsFull = nws ? normalizeAlerts(nws[a.iata], now) : [];
    const sigs = sigmets ? convectiveSigmetsAt(a.lon, a.lat, sigmets, now) : [];
    const spcCat = spc ? spcCategoryAt(a.lon, a.lat, spc) : null;
    const lampSt = lamp?.stations?.[a.icao] || null;
    const adv = (atcscc || []).filter((x) => x.airport === a.iata)
      .map((x) => ({ ...Object.fromEntries(ADV_KEYS.map((k) => [k, x[k] ?? null])), causeLabel: causePhrase(x.cause, x.causeText) }));
    const tcfHere = tcf ? tcfAt(a.lon, a.lat, tcf, now) : [];
    const cwaHere = cwa ? cwaAt(a.lon, a.lat, cwa, now) : [];

    const hours = buildHours({
      now, tz: a.tz, taf: t, metar: m, faa, sigmet: sigs.length > 0,
      alerts: alertsFull.map((x) => ({ event: x.event, onset: x.onset, ends: x.ends })), spc: spcCat,
      atcscc: adv, lamp: lampSt, tcf: tcfHere, cwa: cwaHere,
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
      atcscc: adv,
      alerts: alertsFull.slice(0, 10).map(({ event, severity, headline, onset, ends }) => ({ event, severity, headline, onset, ends })),
      spc: spcCat,
      sigmets: sigs,
      lamp: lampSt,
      tcf: tcfHere,
      cwa: cwaHere,
    });
  }
  out.sort(compareAirports);
  return out;
}

/** Replace dir with this run's raw samples and sources.json. */
async function writeRaw(dir, raw, sources) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [file, buf] of Object.entries(raw.files)) await writeFile(join(dir, file), buf);
  const meta = Object.fromEntries(Object.entries(sources).map(([n, s]) => [n, { ...s, ...(raw.meta[n] || {}) }]));
  await writeFile(join(dir, "sources.json"), JSON.stringify(meta, null, 1) + "\n");
}

export async function run({ fixtures = false, out = join(ROOT, "site/data/status.json"), now = new Date(), rawDir = null } = {}) {
  const airports = await loadAirports();
  const raw = makeRaw();
  const p = fixtures ? fixtureProviders(airports, now, raw) : liveProviders(airports, now, raw);
  const names = SOURCE_NAMES;
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

  const status = {
    generated: now.toISOString(),
    sources: Object.fromEntries(names.map((n) => [n, res[n].meta])),
    airports: assemble({
      airports, now,
      metars: res.metar.data, tafs: res.taf.data, sigmets: res.sigmet.data,
      faaParsed, spc: res.spc.data, nws: res.nws.data?.map ?? null,
      lamp: res.lamp.data, atcscc: res.atcscc.data?.list ?? null, tcf: res.tcf.data, cwa: res.cwa.data,
    }),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(status) + "\n");
  if (rawDir) {
    try { await writeRaw(rawDir, raw, status.sources); } catch (e) { console.error("raw samples not written: " + e.message); }
  }
  const okCount = names.filter((n) => status.sources[n].ok).length;
  return { status, okCount, total: names.length, out, raw };
}

async function main() {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const ri = args.indexOf("--raw");
  const rawArg = ri >= 0 ? args[ri + 1] : null;
  const { status, okCount, total, out } = await run({
    fixtures: args.includes("--fixtures"),
    out: oi >= 0 ? resolve(args[oi + 1]) : undefined,
    rawDir: rawArg === "none" ? null : rawArg ? resolve(rawArg) : DEFAULT_RAW_DIR,
  });
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
