#!/usr/bin/env node
// Baseline accuracy backtest for the airport risk model (TAF rules in poller/risk.mjs).
// Historical TAFs and METARs come from the Iowa Environmental Mesonet (IEM); flight
// disruption truth from BTS On-Time Performance CSVs downloaded by the workflow.
//
//   node tools/backtest.mjs [--months 2026-06,2026-07 | --months-count 2]
//        [--bts file.csv[,file2.csv]] [--airports all|MSP,DEN] [--out reports] [--date YYYY-MM-DD]
//   node tools/backtest.mjs --fixtures          read tools/fixtures/ instead of the network
//
// Writes <out>/baseline-<date>.md, <out>/baseline-<date>.json and <out>/samples/ (first 50 KB of
// the first IEM TAF CSV, IEM METAR CSV and the BTS header + 2 rows). Never exits non-zero
// because a source failed: failures are listed in the report.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOUR, CAVEATS, tafsFromIemCsv, metarsFromIemCsv, mergeTafs, hourlyTruth, parseCsvLine, btsIndex, btsAdd,
  btsTruth, replayAirport, computeMetrics, renderMarkdown,
} from "./backtest-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURES = join(HERE, "fixtures");
const UA = "airport-wx backtest (github.com/tylerbridges/airport-wx)";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request";
const SAMPLE_BYTES = 50 * 1024;

// ---------- args ----------

function parseArgs(argv) {
  const o = { fixtures: false, months: null, monthsCount: 2, bts: [], airports: "all", out: null, date: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--fixtures") o.fixtures = true;
    else if (a === "--months") o.months = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--months-count") o.monthsCount = Math.max(1, Number(v()) || 2);
    else if (a === "--bts") o.bts.push(...v().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--airports") o.airports = v().trim() || "all";
    else if (a === "--out") o.out = resolve(v());
    else if (a === "--date") o.date = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
/** The `count` complete months before `now`, oldest first. */
export function lastCompleteMonths(count, now = new Date()) {
  const out = [];
  for (let k = count; k >= 1; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    out.push(ym(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return out;
}
const monthStart = (m) => { const [y, mo] = m.split("-").map(Number); return Date.UTC(y, mo - 1, 1); };
const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return Date.UTC(y, mo, 1); };
const isoZ = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

// ---------- fetching ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
/** GET with <= 1 request/second overall and retries on 429/5xx/network errors. */
async function iemGet(url) {
  const delays = [5, 15, 45, 90];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const wait = lastRequest + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 180e3);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
      const text = await res.text();
      if (res.ok) return text;
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
      if (!(res.status === 429 || res.status >= 500)) throw lastErr;
      const ra = Number(res.headers.get("retry-after"));
      if (attempt < delays.length) await sleep(Math.max(delays[attempt], Number.isFinite(ra) ? Math.min(ra, 120) : 0) * 1000);
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e.name === "AbortError" ? new Error("timeout after 180 s") : e;
      if (attempt < delays.length) await sleep(delays[attempt] * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function checkCsv(text, what) {
  const head = text.slice(0, 300).trim();
  if (!head) throw new Error(`empty ${what} response`);
  if (/^[<{]/.test(head)) throw new Error(`${what} response is not CSV: ${head.slice(0, 120).replace(/\s+/g, " ")}`);
  const first = head.split("\n")[0];
  if (!first.includes(",")) throw new Error(`${what} response has no CSV header: ${first.slice(0, 120)}`);
  return text;
}

function sources(opts) {
  if (opts.fixtures) {
    const rd = async (name) => {
      try { return await readFile(join(FIXTURES, name), "utf8"); } catch { throw new Error(`no fixture ${name}`); }
    };
    return {
      taf: (icao, m) => rd(`iem-taf-${icao}-${m}.csv`).then((t) => ({ text: t, url: `fixture:iem-taf-${icao}-${m}.csv` })),
      metar: (id, m) => rd(`iem-metar-${id}-${m}.csv`).then((t) => ({ text: t, url: `fixture:iem-metar-${id}-${m}.csv` })),
    };
  }
  return {
    taf: async (icao, m) => {
      const url = `${IEM}/taf.py?station=${icao}&sts=${isoZ(monthStart(m) - 30 * HOUR)}&ets=${isoZ(monthEnd(m))}&fmt=csv`;
      return { text: checkCsv(await iemGet(url), "TAF"), url };
    },
    metar: async (id, m) => {
      const q = ["metar", "vsby", "skyc1", "skyl1", "skyc2", "skyl2", "skyc3", "skyl3", "gust", "sknt", "wxcodes"].map((d) => `data=${d}`).join("&");
      const url = `${IEM}/asos.py?station=${id}&${q}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&report_type=3&report_type=4&sts=${isoZ(monthStart(m) - 3 * HOUR)}&ets=${isoZ(monthEnd(m))}`;
      return { text: checkCsv(await iemGet(url), "METAR"), url };
    },
  };
}

// ---------- BTS ----------

async function readBts(path, wanted, acc) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let idx = null;
  let rows = 0;
  let kept = 0;
  const sample = [];
  let header = null;
  for await (const line of rl) {
    if (!idx) {
      header = parseCsvLine(line.replace(/^﻿/, ""));
      sample.push(line);
      const r = btsIndex(header);
      if (r.missing.length) { rl.close(); throw new Error(`BTS columns missing: ${r.missing.join(", ")}`); }
      idx = r.idx;
      continue;
    }
    if (!line) continue;
    if (sample.length < 3) sample.push(line);
    rows++;
    if (btsAdd(acc, parseCsvLine(line), idx, wanted)) kept++;
  }
  if (!idx) throw new Error("BTS file is empty");
  return { rows, kept, header, sample: sample.join("\n") + "\n" };
}

// ---------- main ----------

export async function run(opts) {
  const now = new Date();
  const date = opts.date || now.toISOString().slice(0, 10);
  const all = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
  let months = opts.months;
  let wantList = opts.airports;
  if (opts.fixtures) {
    const files = await readdir(FIXTURES);
    const fx = files.map((f) => /^iem-taf-([A-Z0-9]{4})-(\d{4}-\d{2})\.csv$/.exec(f)).filter(Boolean);
    if (!months) months = [...new Set(fx.map((m) => m[2]))].sort();
    if (wantList === "all") wantList = [...new Set(fx.map((m) => m[1]))].join(",");
    if (!opts.bts.length) opts.bts = files.filter((f) => /^bts-.*\.csv$/.test(f)).map((f) => join(FIXTURES, f));
  }
  if (!months || !months.length) months = lastCompleteMonths(opts.monthsCount, now);
  months = [...new Set(months)].sort();
  const want = wantList === "all" ? null : new Set(wantList.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const airports = all.filter((a) => !want || want.has(a.iata) || want.has(a.icao));
  const out = opts.out || (opts.fixtures ? join(tmpdir(), "airport-wx-backtest-fixture") : join(ROOT, "reports"));
  await mkdir(join(out, "samples"), { recursive: true });

  const start = monthStart(months[0]);
  const end = Math.min(monthEnd(months[months.length - 1]), Math.floor(+now / HOUR) * HOUR);
  const src = sources(opts);
  const skipped = [];
  const samples = {};
  const diag = { taf: {}, metar: {} };
  const counts = { tafs: 0, tafFromRaw: 0, tafFromColumns: 0, tafFailed: 0, metars: 0, records: 0 };
  const saveSample = async (name, text, url) => {
    if (samples[name]) return;
    samples[name] = { file: `samples/${name}`, url };
    await writeFile(join(out, "samples", name), Buffer.from(text, "utf8").subarray(0, SAMPLE_BYTES));
  };

  // BTS first (local files, fast) so a failure is known early.
  const bts = { available: false, files: [], rows: 0, hours: 0, reason: null };
  const acc = new Map();
  const wantedIata = new Set(airports.map((a) => a.iata));
  for (const p of opts.bts) {
    const m = /(\d{4})_(\d{1,2})|(\d{4}-\d{2})/.exec(basename(p));
    const month = m ? (m[3] || ym(m[1], m[2])) : null;
    try {
      await stat(p);
      const r = await readBts(p, wantedIata, acc);
      bts.files.push({ path: basename(p), month, rows: r.rows, kept: r.kept, header: r.header });
      bts.rows += r.rows;
      await saveSample("bts-header.csv", r.sample, basename(p));
      console.log(`BTS ${basename(p)}: ${r.rows} rows, ${r.kept} departures at selected airports`);
    } catch (e) {
      skipped.push({ station: "BTS", what: "on-time file", month, error: String(e.message || e) });
      console.log(`BTS ${p} failed: ${e.message || e}`);
    }
  }
  const tzByIata = Object.fromEntries(airports.map((a) => [a.iata, a.tz]));
  let disruption = null;
  if (acc.size) {
    disruption = btsTruth(acc, tzByIata);
    bts.available = true;
    bts.hours = disruption.size;
  } else bts.reason = opts.bts.length ? "BTS files could not be read" : "no BTS months published in the probe window (or download failed)";

  const recs = [];
  const used = [];
  for (const a of airports) {
    const metarIds = a.icao.startsWith("K") ? [a.icao.slice(1), a.icao] : [a.icao, a.icao.slice(1)];
    const tafLists = [];
    const obsAll = [];
    for (const m of months) {
      try {
        const { text, url } = await src.taf(a.icao, m);
        await saveSample("iem-taf.csv", text, url);
        const r = tafsFromIemCsv(text, { station: a.icao, ref: monthStart(m) + 15 * 24 * HOUR });
        diag.taf[`${a.icao} ${m}`] = { rows: r.diag.rows, fromRaw: r.diag.fromRaw, fromColumns: r.diag.fromColumns, failed: r.diag.failed, cancelled: r.diag.cancelled };
        diag.tafHeader ||= r.diag.header;
        diag.tafColumns ||= r.diag.columns;
        counts.tafFromRaw += r.diag.fromRaw;
        counts.tafFromColumns += r.diag.fromColumns;
        counts.tafFailed += r.diag.failed;
        if (!r.tafs.length) throw new Error(`no TAFs parsed from ${r.diag.rows} rows`);
        tafLists.push(r.tafs);
      } catch (e) {
        skipped.push({ station: a.icao, what: "TAF", month: m, error: String(e.message || e).slice(0, 200) });
      }
      let ok = false;
      let lastErr = null;
      for (const id of metarIds) {
        if (opts.fixtures && id !== metarIds[0]) break;
        try {
          const { text, url } = await src.metar(id, m);
          const r = metarsFromIemCsv(text);
          diag.metar[`${id} ${m}`] = { rows: r.diag.rows, used: r.diag.used, bad: r.diag.bad, stations: r.diag.stations };
          if (!r.obs.length) {
            if (!samples["iem-metar.csv"]) await saveSample("iem-metar-empty.csv", text, url);
            lastErr = new Error(`no reports for station id ${id} (${r.diag.rows} rows${r.diag.error ? ", " + r.diag.error : ""})`);
            continue;
          }
          await saveSample("iem-metar.csv", text, url);
          diag.metarHeader ||= r.diag.header;
          obsAll.push(...r.obs);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!ok) skipped.push({ station: a.icao, what: "METAR", month: m, error: String(lastErr?.message || lastErr).slice(0, 200) });
    }
    const tafs = mergeTafs(tafLists);
    if (!tafs.length) { console.log(`${a.iata}: no TAFs, skipped`); continue; }
    obsAll.sort((x, y) => x.t - y.t);
    const obs = obsAll.filter((o, i) => i === 0 || o.t !== obsAll[i - 1].t || o.raw !== obsAll[i - 1].raw);
    const truth = hourlyTruth(obs);
    const r = replayAirport({ iata: a.iata, tz: a.tz, tafs, obs, truth, disruption, start, end });
    counts.tafs += tafs.length;
    counts.metars += obs.length;
    counts.records += r.length;
    if (r.length) used.push(a.iata);
    recs.push(...r);
    console.log(`${a.iata}: ${tafs.length} TAFs, ${obs.length} METARs, ${truth.size} observed hours, ${r.length} replay records`);
  }

  const metrics = computeMetrics(recs);
  const report = {
    date,
    generated: now.toISOString(),
    fixtures: opts.fixtures,
    period: { months, start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    airportsRequested: airports.map((a) => a.iata),
    airportsUsed: used,
    skipped,
    bts,
    counts,
    caveats: CAVEATS,
    thresholds: {
      leadBuckets: "latest TAF issued <= H - lo; buckets 0-3, 3-6, 6-12, 12-24 h; TAFs older than 30 h ignored",
      disruption: ">= 20% of departures DepDelay >= 15 with WeatherDelay > 0 or NASDelay > 0, or >= 5% cancelled code B; >= 5 departures",
      persistenceMaxAgeH: 3,
    },
    samples,
    diagnostics: diag,
    metrics,
  };
  const base = join(out, `baseline-${date}`);
  await writeFile(base + ".json", JSON.stringify(report, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v), 1) + "\n");
  await writeFile(base + ".md", renderMarkdown(report) + "\n");
  return { report, out, files: [base + ".md", base + ".json"] };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { report, files } = await run(opts);
  const o = report.metrics.allLeads;
  console.log(`airports used ${report.airportsUsed.length}/${report.airportsRequested.length}, skipped/partial ${report.skipped.length}, records ${report.counts.records}`);
  console.log(`level >=Moderate CSI (all leads) ${o.level.ge2.taf.csi?.toFixed(2) ?? "–"}; disruption >=Moderate CSI ${o.disruption.ge2.taf.csi?.toFixed(2) ?? "–"}`);
  for (const f of files) console.log("wrote " + f);
  if (!report.airportsUsed.length) {
    // Report and samples are written (the workflow uploads them), but don't publish an empty baseline.
    console.error("no airport produced any replay records; see the skipped list in the report");
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
