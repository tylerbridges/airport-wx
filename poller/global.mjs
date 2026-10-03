// Lightweight weather risk for every airport in the searchable list (site/data/airports-all.json
// + airports-extra.json), from AWC's global bulk cache files:
//   https://aviationweather.gov/data/cache/metars.cache.csv.gz   (every METAR, ~1–10 min old)
//   https://aviationweather.gov/data/cache/tafs.cache.xml.gz     (every TAF)
// Scoring reuses risk.mjs (METAR now + TAF hourly rules; no FAA/NWS/SPC/SIGMET), so a searched
// airport always has something to show. Writes compact shards site/data/wx/<first letter>.json
// plus site/data/wx/index.json (source status). Called from poll.mjs (build2a hook); never throws.
//
// Column and element names in the cache files are unverified: only the raw report text is
// required (CSV column "raw_text", XML element <raw_text>), which is re-parsed by taf-parse.mjs,
// so the scoring doesn't depend on the other columns. A header and first record are logged and
// the first 20 KB of each file is saved to .cache/raw/ (global-metars.csv, global-tafs.xml).
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHours, summarize, toMs, flightCategory, parseVisib, ceilingOf } from "./risk.mjs";
import { parseMetar, parseTaf } from "./taf-parse.mjs";
import { expandTemplate } from "./lib.mjs";
import { plainMetar, travelerImpact } from "./plain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
export const GLOBAL_URLS = {
  metars: "https://aviationweather.gov/data/cache/metars.cache.csv.gz",
  tafs: "https://aviationweather.gov/data/cache/tafs.cache.xml.gz",
};
const HOUR = 3600e3;
const METAR_MAX_AGE = 2 * HOUR;

// ---------- parsing ----------

function splitCsvLine(line) {
  const out = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(f); f = ""; }
    else f += ch;
  }
  out.push(f.replace(/\r$/, ""));
  return out;
}

/**
 * metars.cache.csv -> [{icaoId, rawOb, obsTime (epoch s), ...conditions}]. The file starts with a few
 * status lines ("No errors", "N results") before the header row that begins with raw_text.
 */
export function parseMetarCsv(text, now = new Date()) {
  const lines = String(text).split("\n");
  let hi = lines.findIndex((l) => /^\s*"?raw_text"?\s*,/i.test(l));
  const header = hi >= 0 ? splitCsvLine(lines[hi]).map((h) => h.trim().toLowerCase()) : [];
  const col = (n) => header.indexOf(n);
  const iRaw = hi >= 0 ? col("raw_text") : 0;
  const iId = col("station_id");
  const iObs = col("observation_time");
  const out = [];
  for (let k = hi + 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line.trim()) continue;
    const r = splitCsvLine(line);
    const raw = (r[iRaw] || "").trim();
    if (!/^(METAR |SPECI )?[A-Z][A-Z0-9]{3} \d{6}Z/.test(raw)) continue;
    const p = parseMetar(raw, { ref: +now });
    const obsIso = iObs >= 0 ? toMs(r[iObs]) : null;
    out.push({
      ...p,
      icaoId: (iId >= 0 && r[iId] ? r[iId].trim() : p.icaoId || "").toUpperCase(),
      rawOb: raw,
      obsTime: obsIso != null ? Math.round(obsIso / 1000) : p.obsTime,
    });
  }
  return out;
}

const decode = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function tag(body, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(body);
  return m ? decode(m[1]).trim() : "";
}

/** tafs.cache.xml -> AWC-JSON-shaped TAFs (parsed from <raw_text>; <issue_time> used when present). */
export function parseTafXml(text, now = new Date()) {
  const out = [];
  const re = /<TAF>([\s\S]*?)<\/TAF>/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = tag(m[1], "raw_text");
    if (!raw) continue;
    const issue = toMs(tag(m[1], "issue_time"));
    const t = parseTaf(raw, issue != null ? { issueTime: issue } : { ref: +now });
    if (!t) continue;
    const sid = tag(m[1], "station_id").toUpperCase();
    if (sid) t.icaoId = sid;
    if (!t.icaoId || t.cancelled || t.nil) continue;
    out.push(t);
  }
  return out;
}

function latest(list, key, timeKey) {
  const m = new Map();
  for (const r of list) {
    const k = r[key];
    if (!k) continue;
    const prev = m.get(k);
    if (!prev || (toMs(r[timeKey]) ?? 0) >= (toMs(prev[timeKey]) ?? 0)) m.set(k, r);
  }
  return m;
}

// ---------- scoring ----------

/**
 * airports: [{icao, tz}] -> Map(icao -> compact entry)
 *   {n: now level, p: peak level, pt: peak hour ISO, h: "0123…" (24 hourly levels), r: top reason,
 *    pl: plain-English now, im: traveler impact, c: flight category,
 *    m: METAR raw, mt: METAR time ISO, t: TAF raw, ti: TAF issue ISO}
 */
export function computeGlobal({ airports, metars, tafs, now = new Date() }) {
  const mBy = latest(metars || [], "icaoId", "obsTime");
  const tBy = latest(tafs || [], "icaoId", "issueTime");
  const out = new Map();
  for (const a of airports) {
    if (!a.icao || out.has(a.icao)) continue;
    let m = mBy.get(a.icao) || null;
    const obsMs = m ? toMs(m.obsTime) : null;
    if (m && (obsMs == null || +now - obsMs > METAR_MAX_AGE)) m = null;
    let t = tBy.get(a.icao) || null;
    if (t && toMs(t.validTimeTo) != null && toMs(t.validTimeTo) < +now) t = null;
    if (!m && !t) continue;
    const tz = a.tz || "UTC";
    let hours;
    try {
      hours = buildHours({ now, tz, taf: t, metar: m });
    } catch {
      continue; // unknown zone name or malformed report: skip rather than fail the run
    }
    const s = summarize(hours, tz);
    const e = {
      n: s.now.level,
      p: s.peak.level,
      pt: s.peak.at,
      h: hours.map((x) => x.level).join(""),
      r: s.peak.reasons[0] || "",
      c: m ? flightCategory(parseVisib(m.visib), ceilingOf(m.clouds)) : hours[0].fltCat || null,
    };
    if (m) {
      e.pl = plainMetar(m);
      e.im = travelerImpact(s.now.level, m);
      e.m = m.rawOb;
      e.mt = new Date(obsMs).toISOString();
    }
    if (t) {
      e.t = t.rawTAF;
      e.ti = toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null;
    }
    out.set(a.icao, e);
  }
  return out;
}

// ---------- I/O ----------

/** Airports from the list files -> [{icao, tz}]. */
export async function loadSearchAirports(dataDir = join(ROOT, "site/data")) {
  const out = [];
  for (const f of ["airports-all.json", "airports-extra.json"]) {
    let j;
    try { j = JSON.parse(await readFile(join(dataDir, f), "utf8")); } catch { continue; }
    const fi = Object.fromEntries((j.f || []).map((k, i) => [k, i]));
    for (const r of j.a || []) {
      const icao = r[fi.icao];
      const tzI = r[fi.tz];
      if (icao) out.push({ icao, tz: tzI >= 0 ? j.tz[tzI] : null });
    }
  }
  return out;
}

async function fetchGz(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) { const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`); e.http = res.status; throw e; }
    const buf = Buffer.from(await res.arrayBuffer());
    let text;
    try { text = gunzipSync(buf).toString("utf8"); } catch { text = buf.toString("utf8"); } // already decoded by fetch
    return { text, http: res.status, bytes: buf.length, ms: Date.now() - t0 };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout after 45s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch (or read fixtures), score and write the shards. Options default from env:
 *   FIXTURES_DIR (fixture mode dir, default poller/fixtures), GLOBAL_WX_OUT (default site/data/wx),
 *   GLOBAL_WX=0 skips the step. Returns the index object; never throws.
 */
export async function runGlobal({
  fixtures = false, now = new Date(),
  fixturesDir = process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : join(HERE, "fixtures"),
  outDir = process.env.GLOBAL_WX_OUT ? resolve(process.env.GLOBAL_WX_OUT) : join(ROOT, "site/data/wx"),
  dataDir = join(ROOT, "site/data"), rawDir = join(ROOT, ".cache/raw"), log = console.log,
} = {}) {
  if (process.env.GLOBAL_WX === "0") return null;
  const index = { generated: now.toISOString(), ok: false, sources: {}, airports: 0, letters: [] };
  try {
    const airports = await loadSearchAirports(dataDir);
    const get = async (name, file) => {
      const t0 = Date.now();
      try {
        const r = fixtures
          ? { text: expandTemplate(await readFile(join(fixturesDir, file), "utf8"), now), http: null, bytes: null }
          : await fetchGz(GLOBAL_URLS[name]);
        index.sources[name] = { ok: true, at: new Date().toISOString(), error: null, http: r.http, bytes: r.bytes ?? Buffer.byteLength(r.text), ms: r.ms ?? Date.now() - t0 };
        try {
          await mkdir(rawDir, { recursive: true });
          await writeFile(join(rawDir, `global-${name}${file.slice(file.lastIndexOf("."))}`), r.text.slice(0, 20 * 1024));
        } catch { /* sample only */ }
        return r.text;
      } catch (e) {
        index.sources[name] = { ok: false, at: new Date().toISOString(), error: String(e.message || e), http: e.http ?? null };
        return null;
      }
    };
    const [mText, tText] = await Promise.all([get("metars", "metars.cache.csv"), get("tafs", "tafs.cache.xml")]);
    const metars = mText ? parseMetarCsv(mText, now) : [];
    const tafs = tText ? parseTafXml(tText, now) : [];
    if (mText) {
      const hl = mText.split("\n").find((l) => /^\s*"?raw_text/i.test(l));
      log(`global metars: header ${hl ? hl.slice(0, 160) : "(no raw_text header row found)"}; ${metars.length} parsed; first: ${metars[0]?.rawOb || "-"}`);
      if (!hl) index.sources.metars.note = "no raw_text header: METARs found by pattern";
    }
    if (tText) log(`global tafs: ${tafs.length} parsed; first: ${(tafs[0]?.rawTAF || "-").slice(0, 80)}; <raw_text> elements: ${(tText.match(/<raw_text>/gi) || []).length}`);
    if (mText && !metars.length) index.sources.metars = { ...index.sources.metars, ok: false, error: "no METARs parsed (format changed?)" };
    if (tText && !tafs.length) index.sources.tafs = { ...index.sources.tafs, ok: false, error: "no TAFs parsed (format changed?)" };

    const entries = computeGlobal({ airports, metars, tafs, now });
    const shards = new Map();
    for (const [icao, e] of entries) {
      const k = /^[A-Z0-9]/i.test(icao) ? icao[0].toUpperCase() : "_";
      if (!shards.has(k)) shards.set(k, {});
      shards.get(k)[icao] = e;
    }
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const h0 = new Date(Math.floor(+now / HOUR) * HOUR).toISOString();
    for (const [k, a] of shards) await writeFile(join(outDir, `${k}.json`), JSON.stringify({ generated: index.generated, h0, a }) + "\n");
    index.ok = index.sources.metars?.ok || index.sources.tafs?.ok || false;
    index.airports = entries.size;
    index.metars = metars.length;
    index.tafs = tafs.length;
    index.letters = [...shards.keys()].sort();
    index.h0 = h0;
    await writeFile(join(outDir, "index.json"), JSON.stringify(index) + "\n");
    log(`global: ${entries.size} of ${airports.length} listed airports scored (${metars.length} METARs, ${tafs.length} TAFs) -> ${outDir}`);
  } catch (e) {
    index.error = String(e?.message || e);
    log(`global FAILED: ${index.error}`);
    try { await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, "index.json"), JSON.stringify(index) + "\n"); } catch { /* nothing more to do */ }
  }
  return index;
}
