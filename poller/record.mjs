#!/usr/bin/env node
// Appends this poll's observed outcomes and (hourly) predictions to a checkout of the `history`
// branch, and refreshes the raw response samples there.
//   node poller/record.mjs <historyDir> [--status site/data/status.json] [--raw .cache/raw]
//
// Layout (all times UTC; see HISTORY_README below, which is written to <historyDir>/README.md):
//   truth/YYYY/MM/DD.jsonl      one line per poll
//   forecast/YYYY/MM/DD.jsonl   one line per UTC hour
//   raw/latest/                 first 200 KB of each source's latest raw response + sources.json
import { readFile, writeFile, mkdir, appendFile, readdir, copyFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOUR = 3600e3;

export const HISTORY_README = `# airport-wx history

Written by \`poller/record.mjs\` from the "Poll and deploy" workflow on \`main\` (every ~10 minutes).
Every file is UTC. Lines are compact JSON (JSON Lines): null, empty strings, empty arrays and empty
objects are left out, and timestamps are ISO 8601 shortened ("2026-10-03T22:00Z", "2026-10-03T22:04:24Z").

## truth/YYYY/MM/DD.jsonl — observed outcomes, one line per poll

    {t, down?: [sources that failed this poll],
     airports: {IATA: {
       metar?: {obsTime, raw, fltCat, visib, ceiling, wx, wspd, wgst},
       faa?: [{type: ground_stop|ground_delay|delay|closure, cause, reason, detail, scope?, active?}],
       atcscc?: [{id, type: GS|GDP|AFP|other, issued, cause, causeText, title, active, cnx, start, end}]}}}

- \`metar\` is left out when its obsTime equals the last one recorded for that airport (no new report).
- \`faa\` is the FAA NAS status program state at that poll; no \`faa\` key = no programs (unless "faa" is in \`down\`).
- \`atcscc\` lists advisories that are active, or were issued since the previous line.
- \`cause\` classes: weather, volume, equipment, staffing, runway, security, airline, vip, space, other, unknown.
- Closures carry \`scope\`: full (airport closed), runway (some runways), limited (closed only to some users, e.g. GA).

## forecast/YYYY/MM/DD.jsonl — predictions, one line per UTC hour

    {t, issuedHour, down?, airports: {IATA: {
       taf?: {issued, raw}, lamp?: {issued, hours: [{t, gust, tstmProb, cig, vis, typ, pFrz, pPrecip}]},
       spc?, tcf?: [{valid, coverage, confidence, tops}], cwa?: [{hazard, validFrom, validTo, raw}],
       alerts?: [{event, onset, ends}],
       hours: [24 x {t, level, reasons?}]}}}

- Written by the first poll of each UTC hour. \`hours\` are the site's rule-based risk levels
  (0 None … 4 Severe) for the 24 hours from issuedHour; \`reasons\` are the texts shown on the site.
- LAMP: gust in kt (0 = "NG", no gust), tstmProb = LP2 (2-h thunder probability ending at t, every other hour),
  cig category 1–8 (1 <200 ft … 8 >12,000 ft/unlimited), vis category 1–7 (1 <1/2 mi … 7 >6 mi), typ R/S/Z,
  pFrz = POZ %, pPrecip = PPO %.

## raw/latest/ — format check

The first 200 KB of each source's latest successful raw response (metar.json, taf.json, airsigmet.json, faa.xml,
nws.json = one point's alerts, spc.geojson, lamp.txt + lamp-airports.txt, atcscc.html + atcscc-detail.html,
tcf.json, cwa.json), overwritten every poll. \`sources.json\` has, per source: ok, error, http status, bytes,
url, files and fileAt (when the files were captured; a source that failed keeps its previous files).
`;

// ---------- pure helpers (tested) ----------

const ISO_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::(\d\d)(?:\.\d+)?)?Z$/;
/** "2026-10-03T22:00:00.000Z" -> "2026-10-03T22:00Z"; "…22:04:24.965Z" -> "…22:04:24Z". */
export function shortIso(s) {
  const m = ISO_RE.exec(s);
  if (!m) return s;
  return !m[2] || m[2] === "00" ? `${m[1]}Z` : `${m[1]}:${m[2]}Z`;
}

/** Drop null/undefined/""/[]/{} recursively and shorten ISO timestamps. Returns undefined if empty. */
export function compact(v) {
  if (v == null || v === "") return undefined;
  if (typeof v === "string") return shortIso(v);
  if (Array.isArray(v)) {
    const a = v.map(compact).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

const p2 = (n) => String(n).padStart(2, "0");
export function dayFile(base, kind, ms) {
  const d = new Date(ms);
  return join(base, kind, String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), `${p2(d.getUTCDate())}.jsonl`);
}

const secs = (s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** From truth lines (oldest first): previous t and the last recorded METAR obsTime per airport. */
export function truthState(lines) {
  const lastObs = {};
  let t = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if (t == null && j.t) t = j.t;
    for (const [iata, a] of Object.entries(j.airports || {})) {
      if (a?.metar?.obsTime && !(iata in lastObs)) lastObs[iata] = secs(a.metar.obsTime);
    }
  }
  return { t, lastObs };
}

const downOf = (status) => Object.entries(status.sources || {}).filter(([, s]) => !s.ok).map(([n]) => n);

/** The truth line for a status.json, given truthState() of what's already recorded. */
export function truthLine(status, prev = { t: null, lastObs: {} }) {
  const prevT = prev.t ? Date.parse(prev.t) : null;
  const airports = {};
  for (const a of status.airports || []) {
    const o = {};
    const m = a.metar;
    if (m && m.obsTime && secs(m.obsTime) !== prev.lastObs?.[a.iata]) {
      o.metar = { obsTime: m.obsTime, raw: m.raw, fltCat: m.fltCat, visib: m.visib, ceiling: m.ceiling, wx: m.wx, wspd: m.wind?.spd, wgst: m.gust };
    }
    o.faa = (a.faa || []).map((f) => ({ type: f.type, cause: f.cause, reason: f.reason, detail: f.detail, scope: f.scope, active: f.active }));
    o.atcscc = (a.atcscc || [])
      .filter((x) => x.active || prevT == null || (Date.parse(x.issued) || 0) > prevT)
      .map(({ id, type, issued, cause, causeText, title, active, cnx, start, end }) => ({ id, type, issued, cause, causeText, title, active, cnx, start, end }));
    const c = compact(o);
    if (c) airports[a.iata] = c;
  }
  return compact({ t: status.generated, down: downOf(status), airports }) || { t: shortIso(status.generated) };
}

export function issuedHourOf(status) {
  return shortIso(new Date(Math.floor(Date.parse(status.generated) / HOUR) * HOUR).toISOString());
}

/** The hourly forecast line for a status.json. */
export function forecastLine(status) {
  const airports = {};
  for (const a of status.airports || []) {
    const o = {
      taf: a.taf ? { issued: a.taf.issued, raw: a.taf.raw } : null,
      lamp: a.lamp || null,
      spc: a.spc || null,
      tcf: (a.tcf || []).map(({ valid, coverage, confidence, tops }) => ({ valid, coverage, confidence, tops })),
      cwa: (a.cwa || []).map(({ hazard, validFrom, validTo, raw }) => ({ hazard, validFrom, validTo, raw })),
      alerts: (a.alerts || []).map(({ event, onset, ends }) => ({ event, onset, ends })),
      hours: (a.hours || []).map(({ t, level, reasons }) => ({ t, level, reasons })),
    };
    const c = compact(o);
    if (c) airports[a.iata] = c;
  }
  return compact({ t: status.generated, issuedHour: issuedHourOf(status), down: downOf(status), airports });
}

// ---------- file steps ----------

async function readText(file) {
  try { return await readFile(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; }
}
const linesOf = (text) => text.split("\n").filter((l) => l.trim());

async function appendLine(file, obj) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(obj) + "\n");
}

export async function recordTruth(dir, status) {
  const t = Date.parse(status.generated);
  const file = dayFile(dir, "truth", t);
  let lines = linesOf(await readText(file));
  if (!lines.length) lines = linesOf(await readText(dayFile(dir, "truth", t - 24 * HOUR)));
  const prev = truthState(lines);
  if (prev.t && secs(prev.t) === secs(status.generated)) return { file, skipped: "already recorded" };
  const line = truthLine(status, prev);
  await appendLine(file, line);
  return { file, airports: Object.keys(line.airports || {}).length, metars: Object.values(line.airports || {}).filter((a) => a.metar).length };
}

export async function recordForecast(dir, status) {
  const file = dayFile(dir, "forecast", Date.parse(status.generated));
  const hour = issuedHourOf(status);
  if ((await readText(file)).includes(`"issuedHour":"${hour}"`)) return { file, skipped: `already have ${hour}` };
  await appendLine(file, forecastLine(status));
  return { file, issuedHour: hour };
}

/**
 * Copy this run's raw samples (rawDir, written by poll.mjs) into <dir>/raw/latest. A source with no
 * new files keeps its previous ones (fileAt says when they were captured).
 */
export async function recordRaw(dir, rawDir, status) {
  const dest = join(dir, "raw", "latest");
  const fresh = JSON.parse(await readFile(join(rawDir, "sources.json"), "utf8"));
  let old = {};
  try { old = JSON.parse(await readFile(join(dest, "sources.json"), "utf8")).sources || {}; } catch { /* first run */ }
  await mkdir(dest, { recursive: true });
  const at = status.generated;
  const sources = {};
  const keep = new Set(["sources.json"]);
  for (const [name, meta] of Object.entries(fresh)) {
    const files = meta.files || [];
    if (files.length) {
      for (const f of files) {
        await copyFile(join(rawDir, f), join(dest, f));
        keep.add(f);
      }
      sources[name] = { ...meta, fileAt: at };
    } else {
      const prevFiles = (old[name]?.files || []).filter(Boolean);
      const still = [];
      for (const f of prevFiles) {
        try { await stat(join(dest, f)); still.push(f); keep.add(f); } catch { /* gone */ }
      }
      sources[name] = { ...meta, files: still, fileAt: still.length ? old[name]?.fileAt ?? null : null };
    }
  }
  for (const f of await readdir(dest)) if (!keep.has(f)) await rm(join(dest, f), { force: true });
  await writeFile(join(dest, "sources.json"), JSON.stringify({ generated: at, sources }, null, 1) + "\n");
  return { files: keep.size - 1 };
}

export async function record({ dir, statusFile = join(ROOT, "site/data/status.json"), rawDir = join(ROOT, ".cache/raw") }) {
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  if (!status.generated || !Array.isArray(status.airports)) throw new Error(`${statusFile} is not a status.json`);
  await mkdir(dir, { recursive: true });
  const out = {};
  const errors = [];
  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); }
  };
  await step("readme", async () => {
    const f = join(dir, "README.md");
    if (await readText(f)) return { skipped: "exists" };
    await writeFile(f, HISTORY_README);
    return { written: true };
  });
  await step("truth", () => recordTruth(dir, status));
  await step("forecast", () => recordForecast(dir, status));
  await step("raw", () => recordRaw(dir, rawDir, status));
  return { out, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const positional = args.filter((a, i) => !a.startsWith("--") && !["--status", "--raw"].includes(args[i - 1]));
  if (!positional[0]) {
    console.error("usage: node poller/record.mjs <historyDir> [--status file] [--raw dir]");
    process.exit(2);
  }
  const { out, errors } = await record({
    dir: resolve(positional[0]),
    statusFile: opt("--status") ? resolve(opt("--status")) : undefined,
    rawDir: opt("--raw") ? resolve(opt("--raw")) : undefined,
  });
  for (const [k, v] of Object.entries(out)) console.log(`${k}: ${JSON.stringify(v)}`);
  for (const e of errors) console.error(`FAIL ${e}`);
  if (errors.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
