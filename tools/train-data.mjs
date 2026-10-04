#!/usr/bin/env node
// Training data for the delay model (README "Delay model"). Two steps, so the workflow can stream
// each BTS month straight out of its zip without keeping 24 unzipped months on disk:
//
//   node tools/train-data.mjs bts --month 2025-01 --file <csv|-> --out <dir>
//        BTS On-Time CSV (file or stdin) -> <dir>/bts/2025-01.json.gz: per airport x local date x hour,
//        departures (Origin, CRSDepTime) and arrivals (Dest, CRSArrTime): flights, late 15+, late 15+
//        with weather/NAS cause, weather/NAS cancellations, delay minutes of late flights.
//   node tools/train-data.mjs build --out <dir> [--airports all|ORD,MSP] [--lamp] [--hub-cascade] [--chunk-months 3]
//        [--lamp-budget-min 150]
//        BTS aggregates -> truth per airport-hour; IEM TAFs (taf.py) and METARs (asos.py) per airport
//        (<= 1 request/s, retries with backoff, cached in <dir>/cache for the run) and optionally IEM
//        LAMP (mos.py, model=LAV) -> <dir>/dataset.jsonl.gz (one record per airport-hour, features
//        for each lead bucket), <dir>/meta.json and <dir>/samples/ (first 50 KB of every raw format).
//        --hub-cascade adds the top-hub cascade (TOP_HUBS in train-lib.mjs) to every record (f[i].hc).
//
// tools/train.mjs --fixtures runs the same code against tools/train-fixtures.mjs in memory.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGzip, gunzipSync, gzipSync, createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsvLine, parseCsv, tafsFromIemCsv, metarsFromIemCsv, mergeTafs } from "./backtest-lib.mjs";
import {
  btsIndex2, btsAdd2, accEntries, mergeAcc, truthFromAcc, hubBitsMap, airportRecords, lampFromIemCsv, lampLookup, LAMP_ARCHIVE_TIMING, HOUR, TOP_HUBS,
} from "./train-lib.mjs";
import { HUBS } from "../poller/delay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx delay-model training (github.com/tylerbridges/airport-wx)";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request";
const SAMPLE_BYTES = 50 * 1024;

const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const monthStart = (m) => { const [y, mo] = m.split("-").map(Number); return Date.UTC(y, mo - 1, 1); };
const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return Date.UTC(y, mo, 1); };
const isoZ = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

// ---------- BTS step ----------

/** Lines (async iterable) of one BTS month -> accumulator entries for the wanted airports. */
export async function aggregateBts(lines, wanted) {
  const acc = new Map();
  let idx = null;
  let header = null;
  let rows = 0;
  let kept = 0;
  const sample = [];
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, "");
    if (!idx) {
      header = parseCsvLine(line);
      sample.push(line);
      const r = btsIndex2(header);
      if (r.missing.length) throw new Error(`BTS columns missing: ${r.missing.join(", ")}`);
      idx = r.idx;
      continue;
    }
    if (!line) continue;
    if (sample.length < 3) sample.push(line);
    rows++;
    kept += btsAdd2(acc, parseCsvLine(line), idx, wanted);
  }
  if (!idx) throw new Error("BTS file is empty");
  return { entries: accEntries(acc), rows, kept, header, sample: sample.join("\n") + "\n" };
}

async function loadAirports(list = "all") {
  const all = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
  if (list === "all") return all;
  const want = new Set(list.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  return all.filter((a) => want.has(a.iata) || want.has(a.icao));
}

async function btsStep(opts) {
  const airports = await loadAirports(opts.airports);
  const wanted = new Set(airports.map((a) => a.iata));
  const input = !opts.file || opts.file === "-" ? process.stdin : createReadStream(opts.file);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const r = await aggregateBts(rl, wanted);
  await mkdir(join(opts.out, "bts"), { recursive: true });
  await mkdir(join(opts.out, "samples"), { recursive: true });
  await writeFile(join(opts.out, "bts", `${opts.month}.json.gz`), gzipSync(JSON.stringify({ month: opts.month, rows: r.rows, kept: r.kept, header: r.header, entries: r.entries })));
  const sampleFile = join(opts.out, "samples", "bts-header.csv");
  try { await stat(sampleFile); } catch { await writeFile(sampleFile, r.sample); }
  console.log(`BTS ${opts.month}: ${r.rows} rows, ${r.kept} departure/arrival sides at ${wanted.size} airports, ${r.entries.length} airport-hours`);
}

// ---------- IEM ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
export const iemStats = { requests: 0, cached: 0, retries: 0, failed: 0 };
/** GET with <= 1 request/second overall, retries with backoff on 429/5xx/network errors, cached per run. */
async function iemGet(url, cacheDir) {
  const file = cacheDir ? join(cacheDir, createHash("sha1").update(url).digest("hex") + ".txt") : null;
  if (file) { try { const t = await readFile(file, "utf8"); iemStats.cached++; return t; } catch { /* miss */ } }
  const delays = [5, 15, 45, 90, 180];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const wait = lastRequest + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    iemStats.requests++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 300e3);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
      const text = await res.text();
      if (res.ok) {
        if (file) await writeFile(file, text);
        return text;
      }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
      if (!(res.status === 429 || res.status >= 500)) throw lastErr;
      const ra = Number(res.headers.get("retry-after"));
      if (attempt < delays.length) { iemStats.retries++; await sleep(Math.max(delays[attempt], Number.isFinite(ra) ? Math.min(ra, 300) : 0) * 1000); }
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e.name === "AbortError" ? new Error("timeout after 300 s") : e;
      if (attempt < delays.length) { iemStats.retries++; await sleep(delays[attempt] * 1000); }
    } finally {
      clearTimeout(timer);
    }
  }
  iemStats.failed++;
  throw lastErr;
}

function checkCsv(text, what) {
  const head = text.slice(0, 300).trim();
  if (!head) throw new Error(`empty ${what} response`);
  if (/^[<{]/.test(head)) throw new Error(`${what} response is not CSV: ${head.slice(0, 120).replace(/\s+/g, " ")}`);
  if (!head.split("\n")[0].includes(",")) throw new Error(`${what} response has no CSV header: ${head.split("\n")[0].slice(0, 120)}`);
  return text;
}

/** Live IEM providers: (station, fromMs, toMs) -> CSV text. */
export function iemSources(cacheDir) {
  return {
    taf: async (icao, from, to) => checkCsv(await iemGet(`${IEM}/taf.py?station=${icao}&sts=${isoZ(from - 30 * HOUR)}&ets=${isoZ(to)}&fmt=csv`, cacheDir), "TAF"),
    metar: async (id, from, to) => {
      const q = ["metar", "drct", "sknt", "gust", "vsby", "skyc1", "skyl1", "skyc2", "skyl2", "skyc3", "skyl3", "wxcodes"].map((d) => `data=${d}`).join("&");
      return checkCsv(await iemGet(`${IEM}/asos.py?station=${id}&${q}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&report_type=3&report_type=4&sts=${isoZ(from - 3 * HOUR)}&ets=${isoZ(to)}`, cacheDir), "METAR");
    },
    lamp: async (icao, from, to) => checkCsv(await iemGet(`${IEM}/mos.py?station=${icao}&model=LAV&sts=${isoZ(from - 7 * HOUR)}&ets=${isoZ(to)}&format=csv`, cacheDir), "LAMP"),
  };
}

/** Month chunks of `size` months: [{from, to, label}]. */
export function chunks(months, size) {
  const out = [];
  for (let i = 0; i < months.length; i += size) {
    const part = months.slice(i, i + size);
    out.push({ from: monthStart(part[0]), to: monthEnd(part[part.length - 1]), label: part.length > 1 ? `${part[0]}..${part[part.length - 1]}` : part[0], months: part });
  }
  return out;
}

// ---------- build step ----------

/**
 * Build the dataset. src: {taf, metar, lamp} providers (live or fixture); acc: merged BTS accumulator;
 * writeLine(record) receives each record. Returns meta (counts, skipped, samples, diagnostics).
 */
export async function buildDataset({
  airports, months, acc, src, writeLine, lamp = false, hubCascade = false, topHubs = TOP_HUBS, lampBudgetMs = Infinity,
  chunkMonths = 3, saveSample = async () => {}, rwyOf = () => null, log = console.log,
}) {
  const tzByIata = Object.fromEntries(airports.map((a) => [a.iata, a.tz]));
  const truthAll = truthFromAcc(acc, tzByIata);
  const truth = new Map();
  for (const [k, v] of truthAll) {
    const i = k.indexOf("|");
    const ap = k.slice(0, i);
    if (!truth.has(ap)) truth.set(ap, new Map());
    truth.get(ap).set(Number(k.slice(i + 1)), v);
  }
  const start = monthStart(months[0]) - 14 * HOUR;
  const end = monthEnd(months[months.length - 1]) + 14 * HOUR;
  const parts = chunks(months, chunkMonths);
  const monthSet = new Set(months);
  const skipped = [];
  const diag = { taf: {}, metar: {}, lamp: {} };
  const counts = { truthHours: truthAll.size, realDelayHours: 0, tafs: 0, metars: 0, records: 0, lampRows: 0 };
  for (const v of truthAll.values()) counts.realDelayHours += v.y;

  const byIata = new Map(airports.map((a) => [a.iata, a]));
  const tafCache = new Map();
  const getTafs = async (a) => {
    if (tafCache.has(a.icao)) return tafCache.get(a.icao);
    const lists = [];
    const fetchPart = async (p) => {
      const text = await src.taf(a.icao, p.from, p.to);
      await saveSample("iem-taf.csv", text);
      const r = tafsFromIemCsv(text, { station: a.icao, ref: p.from + 15 * 24 * HOUR });
      diag.taf[`${a.icao} ${p.label}`] = { rows: r.diag.rows, fromRaw: r.diag.fromRaw, fromColumns: r.diag.fromColumns, failed: r.diag.failed };
      diag.tafHeader ||= r.diag.header;
      if (!r.tafs.length) throw new Error(`no TAFs parsed from ${r.diag.rows} rows`);
      lists.push(r.tafs);
    };
    for (const p of parts) {
      try { await fetchPart(p); } catch (e) {
        if (p.months.length > 1) { // retry month by month
          for (const m of p.months) {
            try { await fetchPart({ from: monthStart(m), to: monthEnd(m), label: m, months: [m] }); } catch (e2) { skipped.push({ station: a.icao, what: "TAF", month: m, error: String(e2.message || e2).slice(0, 200) }); }
          }
        } else skipped.push({ station: a.icao, what: "TAF", month: p.label, error: String(e.message || e).slice(0, 200) });
      }
    }
    const tafs = mergeTafs(lists);
    tafCache.set(a.icao, tafs);
    return tafs;
  };
  const getObs = async (a) => {
    const ids = a.icao.startsWith("K") ? [a.icao.slice(1), a.icao] : [a.icao, a.icao.slice(1)];
    const all = [];
    const fetchPart = async (p) => {
      let lastErr = null;
      for (const id of ids) {
        try {
          const text = await src.metar(id, p.from, p.to);
          const r = metarsFromIemCsv(text);
          diag.metar[`${id} ${p.label}`] = { rows: r.diag.rows, used: r.diag.used, bad: r.diag.bad };
          if (!r.obs.length) { lastErr = new Error(`no reports for ${id}`); continue; }
          await saveSample("iem-metar.csv", text);
          diag.metarHeader ||= r.diag.header;
          all.push(...r.obs);
          return;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    };
    for (const p of parts) {
      try { await fetchPart(p); } catch (e) {
        if (p.months.length > 1) {
          for (const m of p.months) {
            try { await fetchPart({ from: monthStart(m), to: monthEnd(m), label: m, months: [m] }); } catch (e2) { skipped.push({ station: a.icao, what: "METAR", month: m, error: String(e2?.message || e2).slice(0, 200) }); }
          }
        } else skipped.push({ station: a.icao, what: "METAR", month: p.label, error: String(e?.message || e).slice(0, 200) });
      }
    }
    all.sort((x, y) => x.t - y.t);
    return all.filter((o, i) => i === 0 || o.t !== all[i - 1].t || o.raw !== all[i - 1].raw);
  };
  // LAMP (real IEM midnight and 06Z replies are fixtures): columns and the first row are logged once; a chunk
  // that fails is retried month by month; after lampBudgetMs the remaining chunks are skipped ("lp:none").
  const lampT0 = Date.now();
  let lampFormat = null; // set when a response's header has no usable columns: the rest is skipped
  const getLamp = async (a) => {
    const byTime = new Map();
    const fetchPart = async (p) => {
      const text = await src.lamp(a.icao, p.from, p.to);
      await saveSample("iem-lamp.csv", text);
      const r = lampFromIemCsv(parseCsv(text));
      diag.lamp[`${a.icao} ${p.label}`] = { rows: r.diag.rows, used: r.diag.used };
      if (!diag.lampHeader) {
        diag.lampHeader = r.diag.header;
        diag.lampColumns = r.diag.columns;
        log(`LAMP sample (${a.icao} ${p.label}): header ${JSON.stringify(r.diag.header)}; columns ${JSON.stringify(r.diag.columns)}; first row ${JSON.stringify(r.diag.firstRow)}`);
      }
      const c = r.diag.columns;
      if (r.diag.rows && (c.run < 0 || c.ft < 0 || (c.lp < 0 && c.cp < 0 && c.lc < 0 && c.lv < 0))) {
        lampFormat = `LAMP format not recognised (header ${JSON.stringify(r.diag.header).slice(0, 200)}); LAMP skipped`;
        log(lampFormat);
        throw new Error(lampFormat);
      }
      if (r.diag.rows && !r.diag.used) throw new Error(`no LAMP values parsed from ${r.diag.rows} rows (header ${JSON.stringify(r.diag.header).slice(0, 150)})`);
      counts.lampRows += r.diag.used;
      for (const [k, v] of r.byTime) byTime.set(k, (byTime.get(k) || []).concat(v).sort((x, y) => x.run - y.run));
    };
    for (const p of parts) {
      if (lampFormat) { skipped.push({ station: a.icao, what: "LAMP", month: p.label, error: lampFormat }); continue; }
      if (Date.now() - lampT0 > lampBudgetMs) { skipped.push({ station: a.icao, what: "LAMP", month: p.label, error: "LAMP time budget used up" }); continue; }
      try { await fetchPart(p); } catch (e) {
        if (p.months.length > 1 && !lampFormat) {
          for (const m of p.months) {
            if (lampFormat) break;
            try { await fetchPart({ from: monthStart(m), to: monthEnd(m), label: m, months: [m] }); } catch (e2) { skipped.push({ station: a.icao, what: "LAMP", month: m, error: String(e2.message || e2).slice(0, 200) }); }
          }
        } else skipped.push({ station: a.icao, what: "LAMP", month: p.label, error: String(e.message || e).slice(0, 200) });
      }
    }
    return byTime;
  };

  // hub bits first (hubs are curated airports; their TAFs stay cached for their own records)
  const allHours = [];
  for (let H = Math.floor(start / HOUR) * HOUR; H < end; H += HOUR) allHours.push(H);
  const hubMaps = new Map();
  const hubsNeeded = [...new Set(airports.flatMap((a) => [...(HUBS[a.iata] || []), ...(hubCascade ? topHubs[a.iata] || [] : [])]))].filter((h) => byIata.has(h));
  for (const h of hubsNeeded) {
    const tafs = await getTafs(byIata.get(h));
    hubMaps.set(h, hubBitsMap(tafs, allHours));
    log(`hub ${h}: ${tafs.length} TAFs`);
  }
  const used = [];
  for (const a of airports) {
    const tr = truth.get(a.iata);
    if (!tr || !tr.size) { skipped.push({ station: a.iata, what: "BTS", error: "no BTS hours with >= 5 flights" }); continue; }
    const tafs = await getTafs(a);
    const obs = await getObs(a);
    const L = lamp ? await getLamp(a) : null;
    tafCache.delete(a.icao); // hub bits are already computed; free the memory
    const recs = airportRecords({
      iata: a.iata, tz: a.tz, tafs, obs, truth: tr, start, end, rwys: rwyOf(a.iata),
      hubMaps: (HUBS[a.iata] || []).map((h) => hubMaps.get(h)).filter(Boolean),
      cascadeMaps: hubCascade ? (topHubs[a.iata] || []).map((h) => hubMaps.get(h) || null) : null,
      lampFn: L ? (H, pred) => lampLookup(L, H, pred) : null,
    });
    let kept = 0;
    for (const r of recs) if (monthSet.has(r.ym)) { await writeLine(r); kept++; } // local month inside the period
    counts.tafs += tafs.length;
    counts.metars += obs.length;
    counts.records += kept;
    if (kept) used.push(a.iata);
    log(`${a.iata}: ${tafs.length} TAFs, ${obs.length} METARs, ${tr.size} BTS hours, ${kept} records`);
  }
  return { counts, skipped, diagnostics: diag, lampTiming: lamp ? { ...LAMP_ARCHIVE_TIMING, actualReceiptArchived: false, archiveCyclesUTC: [0, 6, 12, 18] } : null, airportsUsed: used, hubCascade: !!hubCascade, topHubs: hubCascade ? Object.fromEntries(airports.map((a) => [a.iata, (topHubs[a.iata] || []).filter((h) => byIata.has(h))])) : null, period: { months, start: new Date(start).toISOString(), end: new Date(end).toISOString() } };
}

/** Runway headings (true) per IATA from site/data/airports-all.json. */
export async function runwayTable(iatas) {
  try {
    const j = JSON.parse(await readFile(join(ROOT, "site/data/airports-all.json"), "utf8"));
    const fi = j.f.indexOf("iata");
    const fr = j.f.indexOf("runways");
    const want = new Set(iatas);
    const out = {};
    for (const r of j.a) if (want.has(r[fi]) && Array.isArray(r[fr]) && r[fr].length) out[r[fi]] = [...new Set(r[fr].map((x) => Math.round(Number(x[1]) % 180)).filter(Number.isFinite))];
    return out;
  } catch { return {}; }
}

async function buildStep(opts) {
  const airports = await loadAirports(opts.airports);
  const btsDir = join(opts.out, "bts");
  const files = (await readdir(btsDir).catch(() => [])).filter((f) => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort();
  if (!files.length) throw new Error(`no BTS aggregates in ${btsDir} (run the bts step first)`);
  const acc = new Map();
  const bts = [];
  for (const f of files) {
    const j = JSON.parse(gunzipSync(await readFile(join(btsDir, f))).toString("utf8"));
    mergeAcc(acc, j.entries);
    bts.push({ month: j.month, rows: j.rows, kept: j.kept });
  }
  const months = opts.months || bts.map((b) => b.month);
  const cacheDir = join(opts.out, "cache");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(opts.out, "samples"), { recursive: true });
  const samples = {};
  const saveSample = async (name, text) => {
    if (samples[name]) return;
    samples[name] = `samples/${name}`;
    await writeFile(join(opts.out, "samples", name), Buffer.from(text, "utf8").subarray(0, SAMPLE_BYTES));
  };
  const gz = createGzip();
  const outFile = createWriteStream(join(opts.out, "dataset.jsonl.gz"));
  gz.pipe(outFile);
  const writeLine = (r) => (gz.write(JSON.stringify(r) + "\n") ? null : new Promise((res) => gz.once("drain", res)));
  const rwy = await runwayTable(airports.map((a) => a.iata));
  const meta = await buildDataset({
    airports, months, acc, src: iemSources(cacheDir), writeLine, lamp: opts.lamp, hubCascade: opts.hubCascade, lampBudgetMs: opts.lampBudgetMin * 60e3,
    chunkMonths: opts.chunkMonths, saveSample, rwyOf: (i) => rwy[i] || null,
  });
  gz.end();
  await new Promise((r) => outFile.on("finish", r));
  const full = { ...meta, generated: new Date().toISOString(), lamp: !!opts.lamp, bts, samples, iem: iemStats, rwy };
  await writeFile(join(opts.out, "meta.json"), JSON.stringify(full, null, 1) + "\n");
  console.log(`dataset: ${meta.counts.records} records from ${meta.airportsUsed.length} airports; IEM ${iemStats.requests} requests (${iemStats.cached} cached, ${iemStats.retries} retries, ${iemStats.failed} failed); skipped ${meta.skipped.length}`);
  if (!meta.counts.records) process.exitCode = 3;
}

/** Read <dir>/dataset.jsonl.gz -> records (array). */
export async function readDataset(dir) {
  const rl = createInterface({ input: createReadStream(join(dir, "dataset.jsonl.gz")).pipe(createGunzip()), crlfDelay: Infinity });
  const out = [];
  for await (const line of rl) if (line) out.push(JSON.parse(line));
  return out;
}

function parseArgs(argv) {
  const o = { step: argv[0], month: null, file: null, out: null, airports: "all", lamp: false, hubCascade: false, lampBudgetMin: 150, chunkMonths: 3, months: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--month") o.month = v();
    else if (a === "--file") o.file = v();
    else if (a === "--out") o.out = resolve(v());
    else if (a === "--airports") o.airports = v() || "all";
    else if (a === "--lamp") o.lamp = true;
    else if (a === "--hub-cascade") o.hubCascade = true;
    else if (a === "--lamp-budget-min") o.lampBudgetMin = Math.max(1, Number(v()) || 150);
    else if (a === "--chunk-months") o.chunkMonths = Math.max(1, Number(v()) || 3);
    else if (a === "--months") o.months = v().split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error("--out <dir> is required");
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const o = parseArgs(process.argv.slice(2));
  const job = o.step === "bts" ? (o.month ? btsStep(o) : Promise.reject(new Error("--month YYYY-MM is required"))) : o.step === "build" ? buildStep(o) : Promise.reject(new Error("usage: train-data.mjs bts|build …"));
  job.catch((e) => { console.error(e); process.exit(1); });
}

export { ym, monthStart, monthEnd };
