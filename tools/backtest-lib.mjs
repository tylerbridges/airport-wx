// Pure helpers for tools/backtest.mjs: CSV parsing, IEM TAF/METAR ingestion, BTS
// disruption truth, forecast replay with risk.mjs, verification metrics and the
// Markdown report. No I/O here; unit-tested in tools/backtest.test.mjs.
import { tafHour, levelOf, assessConditions, parseVisib, LEVEL_NAMES } from "../poller/risk.mjs";
import { parseTaf, parseMetar } from "../poller/taf-parse.mjs";

export const HOUR = 3600e3;
export const BUCKETS = [
  { key: "0-3", lo: 0, hi: 3 },
  { key: "3-6", lo: 3, hi: 6 },
  { key: "6-12", lo: 6, hi: 12 },
  { key: "12-24", lo: 12, hi: 24 },
];
export const PHEN = [
  { key: "ts", label: "Thunder (TS/VCTS)" },
  { key: "ifr", label: "IFR or worse (ceiling < 1000 ft or vis < 3 sm)" },
  { key: "g25", label: "Gusts >= 25 kt" },
  { key: "g35", label: "Gusts >= 35 kt" },
  { key: "fz", label: "Freezing precip (FZRA/FZDZ/PL)" },
  { key: "sn", label: "Snow" },
];
const MAX_LEAD_H = 30; // a TAF older than this is no forecast at all
const PERSIST_MAX_AGE = 3 * HOUR;

// ---------- CSV ----------

/** One CSV line (no embedded newlines). Handles quotes and "" escapes. */
export function parseCsvLine(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let v = "";
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += line[i++];
      }
      out.push(v);
      while (i < n && line[i] !== ",") i++;
      i++;
    } else {
      const j = line.indexOf(",", i);
      if (j < 0) { out.push(line.slice(i).replace(/\r$/, "")); break; }
      out.push(line.slice(i, j));
      i = j + 1;
      if (i === n) { out.push(""); break; }
    }
  }
  return out;
}

/** Whole CSV text -> rows (quoted fields may contain newlines). Skips blank and '#' lines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  let atLineStart = true;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (atLineStart && !q && ch === "#") { // comment line
      const j = s.indexOf("\n", i);
      i = j < 0 ? s.length : j;
      continue;
    }
    atLineStart = false;
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      atLineStart = true;
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

/** Index of the first header matching any name (exact, case-insensitive), else -1. */
export function findCol(header, names) {
  const h = header.map((x) => String(x).trim().toLowerCase());
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/** "2026-07-14 11:20", "2026-07-14T11:20:00Z", "2026-07-14 11:20:00+00" -> epoch ms (UTC if no zone). */
export function parseTime(v) {
  let s = String(v ?? "").trim();
  if (!s || s === "M") return null;
  s = s.replace(" ", "T");
  if (/[+-]\d{2}$/.test(s)) s += ":00";
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const num = (x) => {
  const s = String(x ?? "").trim();
  if (!s || s === "M" || s === "T") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ---------- time zones ----------

const dtfs = new Map();
function partsIn(ms, tz) {
  let f = dtfs.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    dtfs.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}
function tzOffset(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Local wall-clock date "YYYY-MM-DD" + hour in tz -> epoch ms (UTC) of that hour's start. */
export function localToUtc(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}
const lhCache = new Map();
export function localHourOf(ms, tz) {
  const k = tz + "|" + ms;
  let v = lhCache.get(k);
  if (v == null) { v = partsIn(ms, tz).hour; if (lhCache.size > 500000) lhCache.clear(); lhCache.set(k, v); }
  return v;
}

// ---------- phenomena from risk.mjs reason items ----------

/**
 * Phenomenon flags from risk.mjs items (forecast or observed), so forecast and observation
 * use exactly the same thresholds. Texts come from assessConditions / tafHour; a test guards them.
 */
export function phenomena(items) {
  const ph = { ts: false, ifr: false, g25: false, g35: false, fz: false, sn: false };
  for (const it of items) {
    const t = it.text;
    if (/thunderstorm/i.test(t)) ph.ts = true;
    if (/freezing rain|freezing drizzle|ice pellets/i.test(t)) ph.fz = true;
    if (/snow/i.test(t)) ph.sn = true;
    let m;
    if ((m = /gusts (\d+) kt/i.exec(t))) {
      const g = Number(m[1]);
      if (g >= 25) ph.g25 = true;
      if (g >= 35) ph.g35 = true;
    }
    if ((m = /ceiling ([\d,]+) ft/i.exec(t)) && Number(m[1].replace(/,/g, "")) < 1000) ph.ifr = true;
    if ((m = /visibility ([\d./ ]+?) sm/i.exec(t))) {
      const v = parseVisib(m[1]);
      if (v != null && v < 3) ph.ifr = true;
    }
  }
  return ph;
}

// ---------- IEM METAR CSV ----------

function cloudsFromCols(row, idx) {
  const out = [];
  for (let k = 1; k <= 4; k++) {
    const ci = idx["skyc" + k];
    if (ci == null || ci < 0) continue;
    const cover = String(row[ci] ?? "").trim().toUpperCase();
    if (!cover || cover === "M") continue;
    const base = num(row[idx["skyl" + k]]);
    out.push({ cover, base, type: null });
  }
  return out;
}

/**
 * IEM asos.py (format=onlycomma) text -> {obs: [{t, station, cond, lvl, ph}], diag}.
 * Columns located by header name; the raw METAR fills anything the columns lack.
 */
export function metarsFromIemCsv(text) {
  const rows = parseCsv(text);
  const diag = { header: rows[0] || [], rows: Math.max(0, rows.length - 1), stations: [], used: 0, bad: 0 };
  if (rows.length < 1) return { obs: [], diag };
  const h = rows[0];
  const idx = {
    station: findCol(h, ["station", "id", "icao"]),
    valid: findCol(h, ["valid", "utc_valid", "time", "obtime"]),
    metar: findCol(h, ["metar", "raw", "raw_text"]),
    vsby: findCol(h, ["vsby", "visibility"]),
    sknt: findCol(h, ["sknt"]),
    gust: findCol(h, ["gust", "gust_sknt"]),
    wxcodes: findCol(h, ["wxcodes", "presentwx"]),
  };
  for (let k = 1; k <= 4; k++) { idx["skyc" + k] = findCol(h, ["skyc" + k]); idx["skyl" + k] = findCol(h, ["skyl" + k]); }
  diag.columns = idx;
  if (idx.valid < 0) { diag.error = "no valid/time column"; return { obs: [], diag }; }
  const stations = new Set();
  const obs = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const t = parseTime(row[idx.valid]);
    if (t == null) { diag.bad++; continue; }
    if (idx.station >= 0) stations.add(String(row[idx.station]).trim());
    const raw = idx.metar >= 0 ? String(row[idx.metar] ?? "").trim() : "";
    const p = raw && raw !== "M" ? parseMetar(raw, { ref: t }) : null;
    const colWx = idx.wxcodes >= 0 ? String(row[idx.wxcodes] ?? "").trim() : "";
    const wx = new Set();
    if (colWx && colWx !== "M") for (const w of colWx.split(/\s+/)) wx.add(w);
    if (p?.wxString) for (const w of p.wxString.split(/\s+/)) wx.add(w);
    const colClouds = cloudsFromCols(row, idx);
    const cond = {
      wspd: num(row[idx.sknt]) ?? p?.wspd ?? null,
      wgst: num(row[idx.gust]) ?? p?.wgst ?? null,
      visib: num(row[idx.vsby]) ?? p?.visib ?? null,
      clouds: p && p.clouds.length > colClouds.length ? p.clouds : colClouds,
      wxString: wx.size ? [...wx].join(" ") : null,
    };
    if (cond.wspd == null && cond.visib == null && !cond.clouds.length && !cond.wxString) { diag.bad++; continue; }
    const items = assessConditions(cond);
    obs.push({ t, cond, lvl: levelOf(items), ph: phenomena(items), raw });
    diag.used++;
  }
  obs.sort((a, b) => a.t - b.t);
  diag.stations = [...stations];
  return { obs, diag };
}

/** Hourly observed truth: max level and any-phenomenon over all reports in [H, H+1h). */
export function hourlyTruth(obs) {
  const m = new Map();
  for (const o of obs) {
    const H = Math.floor(o.t / HOUR) * HOUR;
    let h = m.get(H);
    if (!h) { h = { lvl: 0, ph: { ts: false, ifr: false, g25: false, g35: false, fz: false, sn: false }, n: 0 }; m.set(H, h); }
    h.n++;
    h.lvl = Math.max(h.lvl, o.lvl);
    for (const k in o.ph) if (o.ph[k]) h.ph[k] = true;
  }
  return m;
}

// ---------- IEM TAF CSV ----------

const RAW_NAMES = ["raw", "raw_text", "rawtaf", "raw_taf", "taf", "text", "report"];
const ISSUE_NAMES = ["valid", "issued", "issue", "issue_time", "issuetime", "utc_valid", "valid_utc", "issuance"];

function pgList(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "M" || s.toLowerCase() === "null") return [];
  return s.replace(/^[{[]|[}\]]$/g, "").split(/[,\s]+/).map((x) => x.replace(/"/g, "").trim()).filter((x) => x && x.toUpperCase() !== "NULL");
}

/** Fallback when there's no usable raw text: one row per forecast group with decoded columns. */
function tafFromColumns(rows, h, issueMs, station) {
  const c = {
    from: findCol(h, ["fx_valid", "fcst_valid", "valid_from", "from"]),
    to: findCol(h, ["fx_valid_end", "valid_end", "end_valid", "to"]),
    tempo: findCol(h, ["is_tempo", "tempo"]),
    sknt: findCol(h, ["sknt"]), drct: findCol(h, ["drct"]), gust: findCol(h, ["gust"]),
    vis: findCol(h, ["visibility", "vsby"]), wx: findCol(h, ["presentwx", "wxcodes"]),
    skyc: findCol(h, ["skyc"]), skyl: findCol(h, ["skyl"]),
  };
  if (c.from < 0) return null;
  const groups = rows
    .map((r) => ({ r, from: parseTime(r[c.from]), to: c.to >= 0 ? parseTime(r[c.to]) : null, tempo: c.tempo >= 0 && /^(t|true|1|yes)$/i.test(String(r[c.tempo]).trim()) }))
    .filter((g) => g.from != null)
    .sort((a, b) => a.from - b.from);
  if (!groups.length) return null;
  const prevailing = groups.filter((g) => !g.tempo);
  const vFrom = prevailing.length ? prevailing[0].from : groups[0].from;
  const vTo = Math.max(...groups.map((g) => g.to ?? g.from), vFrom + 24 * HOUR);
  const sec = (x) => Math.round(x / 1000);
  const fcsts = groups.map((g, i) => {
    const sky = pgList(g.r[c.skyc]);
    const lvls = pgList(g.r[c.skyl]).map(Number);
    const vis = num(g.r[c.vis]);
    const nextFm = prevailing.find((p) => p.from > g.from);
    return {
      timeFrom: sec(g.from),
      timeTo: sec(g.tempo ? g.to ?? g.from + HOUR : nextFm ? nextFm.from : vTo),
      timeBec: null,
      fcstChange: g.tempo ? "TEMPO" : g === prevailing[0] ? null : "FM",
      probability: null,
      wdir: num(g.r[c.drct]), wspd: num(g.r[c.sknt]), wgst: num(g.r[c.gust]),
      visib: vis == null ? null : vis >= 6 ? "6+" : vis,
      wxString: pgList(g.r[c.wx]).join(" ") || null,
      clouds: sky.map((cv, k) => ({ cover: cv.toUpperCase(), base: Number.isFinite(lvls[k]) ? lvls[k] : null, type: null })),
      _i: i,
    };
  });
  for (const f of fcsts) delete f._i;
  return { icaoId: station, rawTAF: "", issueTime: sec(issueMs), validTimeFrom: sec(vFrom), validTimeTo: sec(vTo), amd: false, cor: false, cancelled: false, nil: false, fcsts };
}

const p2 = (x) => String(x).padStart(2, "0");
const mm = (ms) => p2(new Date(ms).getUTCMinutes());
/** DDHH (UTC); with end=true an exact midnight is written as the previous day's hour 24. */
function ddhh(ms, end = false) {
  const d = new Date(ms);
  if (end && d.getUTCHours() === 0) { const prev = new Date(ms - HOUR); return p2(prev.getUTCDate()) + "24"; }
  return p2(d.getUTCDate()) + p2(d.getUTCHours());
}

/**
 * IEM taf.py CSV -> {tafs: [AWC-shaped TAF + issueMs], diag}. Works whether a row holds a
 * whole TAF or one forecast group (rows sharing an issue time are joined in order); falls
 * back to decoded columns when no raw text can be parsed.
 */
export function tafsFromIemCsv(text, { station = null, ref = null } = {}) {
  const rows = parseCsv(text);
  const diag = { header: rows[0] || [], rows: Math.max(0, rows.length - 1), fromRaw: 0, fromColumns: 0, failed: 0, cancelled: 0 };
  if (rows.length < 2) return { tafs: [], diag };
  const h = rows[0];
  let iRaw = findCol(h, RAW_NAMES);
  if (iRaw < 0) iRaw = h.findIndex((x) => /raw/i.test(x));
  const iIssue = findCol(h, ISSUE_NAMES);
  const iStation = findCol(h, ["station", "icao", "id", "station_id"]);
  diag.columns = { raw: iRaw, issue: iIssue, station: iStation };
  // group rows by issue time (or by raw header when there's no issue column)
  const groups = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const key = iIssue >= 0 ? `${iStation >= 0 ? row[iStation] : ""}|${row[iIssue]}` : `row${r}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const tafs = [];
  for (const g of groups.values()) {
    const issueMs = iIssue >= 0 ? parseTime(g[0][iIssue]) : null;
    const st = iStation >= 0 ? String(g[0][iStation]).trim() : station;
    let taf = null;
    if (iRaw >= 0) {
      const raws = [];
      for (const row of g) {
        const v = String(row[iRaw] ?? "").replace(/\s+/g, " ").trim();
        if (v && v !== "M" && !raws.includes(v)) raws.push(v);
      }
      const full = raws.filter((r) => /\b\d{4}\/\d{4}\b/.test(r) && /(^|\s)\d{6}Z\b/.test(r)).sort((a, b) => b.length - a.length)[0];
      const text = full && raws.every((r) => full.includes(r)) ? full : raws.join(" ");
      if (text) {
        taf = parseTaf(text, issueMs != null ? { issueTime: issueMs } : { ref: ref ?? Date.now() });
        if (taf && taf.validTimeFrom == null && issueMs != null && !taf.cancelled && !taf.nil) {
          // Group rows without the TAF header: rebuild "ICAO DDHHMMZ DDHH/DDHH" from the issue
          // time (valid from the issue hour) and the latest group end column, else 30 h.
          const iEnd = findCol(h, ["end_valid", "fx_valid_end", "valid_end", "valid_to"]);
          const ends = iEnd >= 0 ? g.map((r) => parseTime(r[iEnd])).filter((x) => x != null) : [];
          const vFrom = Math.floor(issueMs / HOUR) * HOUR;
          const vTo = ends.length ? Math.max(...ends) : vFrom + 30 * HOUR;
          taf = parseTaf(`${st || "XXXX"} ${ddhh(issueMs)}${mm(issueMs)}Z ${ddhh(vFrom)}/${ddhh(vTo, true)} ${text}`, { issueTime: issueMs });
          if (taf) taf.rawTAF = text;
        }
        if (taf && !taf.cancelled && !taf.nil && !taf.fcsts.length) taf = null;
      }
      if (taf) diag.fromRaw++;
    }
    if (!taf && issueMs != null) {
      taf = tafFromColumns(g, h, issueMs, st);
      if (taf) diag.fromColumns++;
    }
    if (!taf) { diag.failed++; continue; }
    if (!taf.icaoId) taf.icaoId = st;
    if (taf.cancelled || taf.nil) diag.cancelled++;
    const iMs = issueMs ?? (taf.issueTime != null ? taf.issueTime * 1000 : null);
    if (iMs == null) { diag.failed++; continue; }
    tafs.push({ ...taf, issueMs: iMs });
  }
  tafs.sort((a, b) => a.issueMs - b.issueMs);
  return { tafs, diag };
}

/** Merge TAF lists (e.g. overlapping monthly requests); same issue time + text kept once. */
export function mergeTafs(lists) {
  const m = new Map();
  for (const l of lists) for (const t of l) m.set(t.issueMs + "|" + t.rawTAF, t);
  return [...m.values()].sort((a, b) => a.issueMs - b.issueMs);
}

// ---------- BTS ----------

export const BTS_COLS = ["flightdate", "origin", "dest", "crsdeptime", "depdelay", "arrdelay", "cancelled", "cancellationcode", "weatherdelay", "nasdelay"];

export function btsIndex(header) {
  const idx = {};
  for (const c of BTS_COLS) idx[c] = findCol(header, [c]);
  const missing = ["flightdate", "origin", "crsdeptime", "depdelay", "cancelled", "cancellationcode", "weatherdelay", "nasdelay"].filter((c) => idx[c] < 0);
  return { idx, missing };
}

function btsDate(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** Accumulate one BTS row (already split) into acc: key "IATA|YYYY-MM-DD|localHour". */
export function btsAdd(acc, row, idx, wanted) {
  const origin = String(row[idx.origin] ?? "").trim();
  if (!wanted.has(origin)) return false;
  const date = btsDate(row[idx.flightdate]);
  const crs = num(row[idx.crsdeptime]);
  if (!date || crs == null) return false;
  const hour = Math.min(23, Math.floor(crs / 100) % 24);
  const key = `${origin}|${date}|${hour}`;
  let a = acc.get(key);
  if (!a) { a = { n: 0, dly: 0, cxlWx: 0, cxl: 0 }; acc.set(key, a); }
  a.n++;
  const cancelled = (num(row[idx.cancelled]) ?? 0) >= 1;
  if (cancelled) {
    a.cxl++;
    if (String(row[idx.cancellationcode] ?? "").trim().toUpperCase() === "B") a.cxlWx++;
  } else {
    const dep = num(row[idx.depdelay]);
    const wx = num(row[idx.weatherdelay]) ?? 0;
    const nas = num(row[idx.nasdelay]) ?? 0;
    if (dep != null && dep >= 15 && (wx > 0 || nas > 0)) a.dly++;
  }
  return true;
}

export const DISRUPT = { minDeps: 5, delayShare: 0.2, wxCancelShare: 0.05 };
export function isDisrupted(a) {
  if (a.n < DISRUPT.minDeps) return null;
  return a.dly / a.n >= DISRUPT.delayShare || a.cxlWx / a.n >= DISRUPT.wxCancelShare;
}

/** acc -> Map "IATA|utcHourMs" -> {n, dly, cxlWx, disrupted} (hours with < 5 departures dropped). */
export function btsTruth(acc, tzByIata) {
  const out = new Map();
  for (const [key, a] of acc) {
    const [iata, date, hour] = key.split("|");
    const tz = tzByIata[iata];
    if (!tz) continue;
    const d = isDisrupted(a);
    if (d == null) continue;
    const H = localToUtc(date, Number(hour), tz);
    const k = `${iata}|${H}`;
    const prev = out.get(k);
    if (prev) { // DST fall-back hour seen twice: combine
      const c = { n: prev.n + a.n, dly: prev.dly + a.dly, cxlWx: prev.cxlWx + a.cxlWx };
      out.set(k, { ...c, disrupted: isDisrupted(c) });
    } else out.set(k, { n: a.n, dly: a.dly, cxlWx: a.cxlWx, disrupted: d });
  }
  return out;
}

// ---------- replay ----------

function lastAtOrBefore(arr, t, key) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Replay TAFs for one airport. For each verifying hour H and lead bucket, the latest TAF
 * issued at or before H - lo is scored for [H, H+1h) with risk.mjs tafHour (TAF rules only).
 * Persistence = level of the latest METAR at or before that TAF's issue time (<= 3 h old).
 */
export function replayAirport({ iata, tz, tafs, obs, truth, disruption, start, end }) {
  const hours = new Set();
  for (const H of truth.keys()) if (H >= start && H < end) hours.add(H);
  if (disruption) for (const [k] of disruption) {
    const [ap, H] = k.split("|");
    if (ap === iata && +H >= start && +H < end) hours.add(+H);
  }
  const recs = [];
  const tafHourCache = new Map();
  for (const H of [...hours].sort((a, b) => a - b)) {
    const tr = truth.get(H) || null;
    const d = disruption ? disruption.get(`${iata}|${H}`) : null;
    const lh = localHourOf(H, tz);
    for (const b of BUCKETS) {
      const ti = lastAtOrBefore(tafs, H - b.lo * HOUR, "issueMs");
      if (ti < 0) continue;
      const taf = tafs[ti];
      if (taf.cancelled || taf.nil) continue;
      const leadH = (H - taf.issueMs) / HOUR;
      if (leadH > MAX_LEAD_H) continue;
      const ck = ti + "|" + H;
      let f = tafHourCache.get(ck);
      if (f === undefined) {
        const th = tafHour(taf, H, H + HOUR);
        f = th ? { lvl: levelOf(th.items), ph: phenomena(th.items) } : null;
        tafHourCache.set(ck, f);
      }
      if (!f) continue;
      const oi = lastAtOrBefore(obs, taf.issueMs, "t");
      const po = oi >= 0 && taf.issueMs - obs[oi].t <= PERSIST_MAX_AGE ? obs[oi] : null;
      recs.push({
        ap: iata, b: b.key, H, lh, leadH,
        fLvl: f.lvl, fPh: f.ph,
        oLvl: tr ? tr.lvl : null, oPh: tr ? tr.ph : null,
        pLvl: po ? po.lvl : null, pPh: po ? po.ph : null,
        disr: d ? d.disrupted : null,
      });
    }
  }
  return recs;
}

// ---------- metrics ----------

export const newCt = () => ({ a: 0, b: 0, c: 0, d: 0 });
export function addCt(ct, f, o) {
  if (f) { if (o) ct.a++; else ct.b++; } else if (o) ct.c++; else ct.d++;
}
/** POD = a/(a+c), FAR = b/(a+b), CSI = a/(a+b+c), bias = (a+b)/(a+c); null when undefined. */
export function scores(ct) {
  const { a, b, c, d } = ct;
  const n = a + b + c + d;
  return {
    n, a, b, c, d,
    base: n ? (a + c) / n : null,
    pod: a + c ? a / (a + c) : null,
    far: a + b ? b / (a + b) : null,
    csi: a + b + c ? a / (a + b + c) : null,
    bias: a + c ? (a + b) / (a + c) : null,
  };
}
export function ctOf(recs, fFn, oFn) {
  const ct = newCt();
  for (const r of recs) addCt(ct, fFn(r), oFn(r));
  return ct;
}
/**
 * Climatology: expected contingency of a random yes/no forecast issued at each stratum's own
 * observed frequency p (stratum = airport x local hour of day; in-sample).
 */
export function climoCt(recs, oFn, strataFn = (r) => `${r.ap}|${r.lh}`) {
  const s = new Map();
  for (const r of recs) {
    const k = strataFn(r);
    let v = s.get(k);
    if (!v) { v = { n: 0, k: 0 }; s.set(k, v); }
    v.n++;
    if (oFn(r)) v.k++;
  }
  const ct = newCt();
  for (const { n, k } of s.values()) {
    ct.a += (k * k) / n;
    ct.b += (k * (n - k)) / n;
    ct.c += (k * (n - k)) / n;
    ct.d += ((n - k) * (n - k)) / n;
  }
  return ct;
}

function climoExact(recs) {
  const s = new Map();
  for (const r of recs) {
    const k = `${r.ap}|${r.lh}`;
    let v = s.get(k);
    if (!v) { v = { n: 0, c: [0, 0, 0, 0, 0] }; s.set(k, v); }
    v.n++;
    v.c[r.oLvl]++;
  }
  let hit = 0;
  let n = 0;
  for (const v of s.values()) { n += v.n; hit += v.c.reduce((m, x) => m + (x * x) / v.n, 0); }
  return n ? hit / n : null;
}

const triple = (all, withP, fFn, pFn, oFn) => ({
  taf: scores(ctOf(all, fFn, oFn)),
  persist: scores(ctOf(withP, pFn, oFn)),
  climo: scores(climoCt(all, oFn)),
});

/** All metrics for one set of replay records. */
export function bundle(recs) {
  const W = recs.filter((r) => r.oLvl != null);
  const WP = W.filter((r) => r.pLvl != null);
  const conf = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  let exact = 0;
  let within1 = 0;
  for (const r of W) {
    conf[r.fLvl][r.oLvl]++;
    if (r.fLvl === r.oLvl) exact++;
    if (Math.abs(r.fLvl - r.oLvl) <= 1) within1++;
  }
  const level = {
    n: W.length,
    confusion: conf,
    exact: W.length ? exact / W.length : null,
    within1: W.length ? within1 / W.length : null,
    persistExact: WP.length ? WP.filter((r) => r.pLvl === r.oLvl).length / WP.length : null,
    climoExact: climoExact(W),
    meanForecast: W.length ? W.reduce((m, r) => m + r.fLvl, 0) / W.length : null,
    meanObserved: W.length ? W.reduce((m, r) => m + r.oLvl, 0) / W.length : null,
    ge2: triple(W, WP, (r) => r.fLvl >= 2, (r) => r.pLvl >= 2, (r) => r.oLvl >= 2),
    ge3: triple(W, WP, (r) => r.fLvl >= 3, (r) => r.pLvl >= 3, (r) => r.oLvl >= 3),
  };
  const phen = {};
  for (const { key } of PHEN) phen[key] = triple(W, WP, (r) => r.fPh[key], (r) => r.pPh[key], (r) => r.oPh[key]);

  const D = recs.filter((r) => r.disr != null);
  const DP = D.filter((r) => r.pLvl != null);
  const rel = [0, 1, 2, 3, 4].map((level) => {
    const s = D.filter((r) => r.fLvl === level);
    const k = s.filter((r) => r.disr).length;
    return { level, name: LEVEL_NAMES[level], n: s.length, disrupted: k, rate: s.length ? k / s.length : null };
  });
  const disruption = {
    n: D.length,
    base: D.length ? D.filter((r) => r.disr).length / D.length : null,
    ge2: triple(D, DP, (r) => r.fLvl >= 2, (r) => r.pLvl >= 2, (r) => r.disr),
    ge3: triple(D, DP, (r) => r.fLvl >= 3, (r) => r.pLvl >= 3, (r) => r.disr),
    reliability: rel,
  };
  return {
    n: recs.length,
    meanLeadH: recs.length ? recs.reduce((m, r) => m + r.leadH, 0) / recs.length : null,
    level, phen, disruption,
  };
}

/** {buckets: {key: {overall, airports: {IATA: bundle}}}, allLeads: bundle} */
export function computeMetrics(recs) {
  const buckets = {};
  for (const b of BUCKETS) {
    const rb = recs.filter((r) => r.b === b.key);
    const airports = {};
    for (const ap of [...new Set(rb.map((r) => r.ap))].sort()) airports[ap] = bundle(rb.filter((r) => r.ap === ap));
    buckets[b.key] = { overall: bundle(rb), airports };
  }
  return { buckets, allLeads: bundle(recs) };
}

// ---------- report ----------

const f2 = (x) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(2));
const pct = (x) => (x == null || !Number.isFinite(x) ? "–" : (x * 100).toFixed(1) + "%");
const int = (x) => (x == null ? "–" : Math.round(x).toLocaleString("en-US"));
const row = (cells) => `| ${cells.join(" | ")} |`;
const sep = (n) => row(Array.from({ length: n }, () => "---"));

export function renderMarkdown(rep) {
  const L = [];
  const M = rep.metrics;
  L.push(`# Airport risk baseline backtest — ${rep.date}`);
  L.push("");
  if (rep.fixtures) L.push("> **FIXTURE RUN** — numbers below come from the small test fixtures in tools/fixtures/, not real data.\n");
  L.push(`- Period: ${rep.period.months.join(", ")} (verifying hours ${rep.period.start} to ${rep.period.end}, UTC)`);
  L.push(`- Airports with data (${rep.airportsUsed.length}): ${rep.airportsUsed.join(", ") || "none"}`);
  if (rep.skipped.length) L.push(`- Skipped / partial (${rep.skipped.length}): ${rep.skipped.map((s) => `${s.station} ${s.what}${s.month ? " " + s.month : ""} (${s.error})`).join("; ")}`);
  L.push(`- BTS On-Time: ${rep.bts.available ? `${rep.bts.files.map((f) => f.month || f.path).join(", ")}; ${int(rep.bts.rows)} rows read, ${int(rep.bts.hours)} airport-hours with >= ${DISRUPT.minDeps} departures` : "not available — " + (rep.bts.reason || "no files") + "; disruption section omitted"}`);
  L.push(`- TAFs parsed: ${int(rep.counts.tafs)} (${int(rep.counts.tafFromRaw)} from raw text, ${int(rep.counts.tafFromColumns)} from decoded columns, ${int(rep.counts.tafFailed)} unparsed); METAR/SPECI reports: ${int(rep.counts.metars)}; replay records: ${int(rep.counts.records)}`);
  L.push(`- Generated ${rep.generated} by tools/backtest.mjs`);
  L.push("");
  L.push("## Caveats");
  L.push("");
  for (const c of rep.caveats) L.push(`- ${c}`);
  L.push("");

  L.push("## Weather: forecast level vs observed level");
  L.push("");
  L.push("Binary scores treat \"level >= k\" as the event. TAF = risk.mjs on the replayed TAF; Pers = persistence; Clim = climatology (expected scores).");
  L.push("");
  L.push(row(["Lead", "Hours", "Mean lead h", "Exact", "Within 1", "Pers exact", "Clim exact", ">=Mod POD", ">=Mod FAR", ">=Mod CSI", ">=Mod bias", "Pers CSI", "Clim CSI", ">=High POD", ">=High FAR", ">=High CSI", ">=High bias", "Pers CSI", "Clim CSI"]));
  L.push(sep(19));
  const lvRow = (name, B) => {
    const v = B.level;
    return row([name, int(v.n), f2(B.meanLeadH), pct(v.exact), pct(v.within1), pct(v.persistExact), pct(v.climoExact),
      f2(v.ge2.taf.pod), f2(v.ge2.taf.far), f2(v.ge2.taf.csi), f2(v.ge2.taf.bias), f2(v.ge2.persist.csi), f2(v.ge2.climo.csi),
      f2(v.ge3.taf.pod), f2(v.ge3.taf.far), f2(v.ge3.taf.csi), f2(v.ge3.taf.bias), f2(v.ge3.persist.csi), f2(v.ge3.climo.csi)]);
  };
  for (const b of BUCKETS) L.push(lvRow(b.key + " h", M.buckets[b.key].overall));
  L.push(lvRow("all (pooled)", M.allLeads));
  L.push("");
  L.push("Observed base rates (all leads pooled): " + `>=Moderate ${pct(M.allLeads.level.ge2.taf.base)}, >=High ${pct(M.allLeads.level.ge3.taf.base)}.`);
  L.push("");

  L.push("## Weather phenomena");
  L.push("");
  L.push(row(["Phenomenon", "Lead", "Hours", "Observed rate", "POD", "FAR", "CSI", "Bias", "Pers CSI", "Pers POD", "Clim CSI"]));
  L.push(sep(11));
  for (const p of PHEN) {
    for (const b of BUCKETS) {
      const s = M.buckets[b.key].overall.phen[p.key];
      L.push(row([p.label, b.key + " h", int(s.taf.n), pct(s.taf.base), f2(s.taf.pod), f2(s.taf.far), f2(s.taf.csi), f2(s.taf.bias), f2(s.persist.csi), f2(s.persist.pod), f2(s.climo.csi)]));
    }
  }
  L.push("");

  L.push("## Level confusion matrices (rows = forecast level, columns = observed level)");
  L.push("");
  for (const b of BUCKETS) {
    const c = M.buckets[b.key].overall.level.confusion;
    L.push(`**Lead ${b.key} h**`);
    L.push("");
    L.push(row(["Forecast \\ Observed", ...LEVEL_NAMES, "Total"]));
    L.push(sep(7));
    c.forEach((r, i) => L.push(row([LEVEL_NAMES[i], ...r.map(int), int(r.reduce((a, x) => a + x, 0))])));
    L.push("");
  }

  if (rep.bts.available) {
    L.push("## Disruption (BTS departures)");
    L.push("");
    L.push(`An airport-hour (local scheduled departure hour) is disrupted when >= ${DISRUPT.delayShare * 100}% of departures left 15+ min late with weather or NAS delay minutes, or >= ${DISRUPT.wxCancelShare * 100}% were cancelled for weather (code B). Hours with < ${DISRUPT.minDeps} departures are ignored.`);
    L.push("");
    L.push(row(["Lead", "Hours", "Disrupted rate", ">=Mod POD", ">=Mod FAR", ">=Mod CSI", ">=Mod bias", "Pers CSI", "Clim CSI", ">=High POD", ">=High FAR", ">=High CSI", ">=High bias", "Pers CSI", "Clim CSI"]));
    L.push(sep(15));
    const dRow = (name, B) => {
      const v = B.disruption;
      return row([name, int(v.n), pct(v.base), f2(v.ge2.taf.pod), f2(v.ge2.taf.far), f2(v.ge2.taf.csi), f2(v.ge2.taf.bias), f2(v.ge2.persist.csi), f2(v.ge2.climo.csi),
        f2(v.ge3.taf.pod), f2(v.ge3.taf.far), f2(v.ge3.taf.csi), f2(v.ge3.taf.bias), f2(v.ge3.persist.csi), f2(v.ge3.climo.csi)]);
    };
    for (const b of BUCKETS) L.push(dRow(b.key + " h", M.buckets[b.key].overall));
    L.push(dRow("all (pooled)", M.allLeads));
    L.push("");
    L.push("### Reliability: observed disruption rate by predicted level");
    L.push("");
    L.push(row(["Predicted level", ...BUCKETS.map((b) => `${b.key} h: n / disrupted`)]));
    L.push(sep(1 + BUCKETS.length));
    for (let lv = 0; lv < 5; lv++) {
      L.push(row([LEVEL_NAMES[lv], ...BUCKETS.map((b) => {
        const r = M.buckets[b.key].overall.disruption.reliability[lv];
        return `${int(r.n)} / ${pct(r.rate)}`;
      })]));
    }
    L.push("");
  }

  L.push("## Per airport");
  L.push("");
  L.push("CSI by lead bucket (0-3 / 3-6 / 6-12 / 12-24 h).");
  L.push("");
  const head = ["Airport", "Hours (3-6 h)", "Obs >=Mod rate", ">=Mod CSI", "Thunder CSI", "IFR CSI", "Gust25 CSI"];
  if (rep.bts.available) head.push("Disrupted rate", "Disruption >=Mod CSI");
  L.push(row(head));
  L.push(sep(head.length));
  const by = (ap, fn) => BUCKETS.map((b) => { const B = M.buckets[b.key].airports[ap]; return B ? f2(fn(B)) : "–"; }).join(" / ");
  for (const ap of rep.airportsUsed) {
    const B36 = M.buckets["3-6"].airports[ap];
    const cells = [ap, int(B36?.level.n), pct(B36?.level.ge2.taf.base), by(ap, (B) => B.level.ge2.taf.csi), by(ap, (B) => B.phen.ts.taf.csi), by(ap, (B) => B.phen.ifr.taf.csi), by(ap, (B) => B.phen.g25.taf.csi)];
    if (rep.bts.available) cells.push(pct(B36?.disruption.base), by(ap, (B) => B.disruption.ge2.taf.csi));
    L.push(row(cells));
  }
  L.push("");
  L.push("Full numbers (contingency counts for every score, per airport and lead) are in the JSON file next to this report.");
  L.push("");
  return L.join("\n");
}

export const CAVEATS = [
  "Forecast = risk.mjs TAF rules only (tafHour: prevailing base/FM/BECMG state, TEMPO at full level, PROB one level lower). No FAA programs, NWS alerts, SPC outlooks or convective SIGMETs exist historically for these dates, and the live hour-0 METAR override is not applied, so the live site's levels would be at least as high as these.",
  "Lead buckets: for verifying hour H and bucket [lo, hi), the TAF used is the latest one issued at or before H - lo (AMDs included). Its actual lead can exceed hi when no newer TAF was issued; the mean actual lead is shown.",
  "Observed level = risk.mjs assessConditions applied to every METAR/SPECI in [H, H+1h), maximum taken (same thresholds as the forecast). Hours without any report are not verified. Phenomena are 'any report in the hour'.",
  "Phenomenon forecasts count TEMPO and PROB groups as 'yes' (as risk.mjs does when it raises the level); a PROB group only counts if its level after the one-level PROB reduction is above None.",
  "Persistence = level of the latest METAR at or before the TAF's issue time (at most 3 h old), carried forward. Climatology = expected scores of a random forecast issued at each airport x local-hour stratum's observed frequency over this same period (in-sample, so slightly flattering).",
  "Disruption truth uses BTS departures by scheduled local hour. BTS reports delay causes (WeatherDelay, NASDelay) only for flights arriving 15+ min late, and NAS delays include non-weather volume/equipment causes; disruptions can also come from weather at the destination or elsewhere.",
  "Two months is a small sample: rare events (freezing precip, gusts >= 35 kt, High/Severe levels) may have few or no cases, so treat their scores as indicative only.",
];
