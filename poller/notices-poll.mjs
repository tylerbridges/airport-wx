// Fetches the notice sources for poll.mjs (README "Notices"): airport NOTAMs and FAA TFRs, live or from
// fixtures. Never throws; each source reports {ok, at, error, ...} in status.json `noticeSources`.
//
// NOTAMs: the FAA NOTAM API (external-api.faa.gov/notamapi/v1/notams, headers client_id/client_secret) when
// the repo secrets FAA_NOTAM_CLIENT_ID and FAA_NOTAM_CLIENT_SECRET exist, else (or if every API request
// failed) FAA NOTAM Search (POST notams.aim.faa.gov/notamSearch/search, no key). Each airport is refreshed at
// most every 30 minutes: replies are kept in .cache/notices/cache.json (restored between workflow runs by
// actions/cache) and reused for up to 3 hours when a refresh fails.
// TFRs: the tfr.faa.gov export list every run, plus the XML detail of each TFR whose type can affect flights
// (VIP, space operations, security, special) — details cached by id for an hour.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTemplate } from "./lib.mjs";
import { notamsFromSearch, notamsFromApi } from "./notams.mjs";
import { parseTfrList, parseTfrDetail, tfrDetailUrl } from "./tfr.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const TIMEOUT_MS = 20_000;
const MIN = 60e3;
export const NOTAM_API = "https://external-api.faa.gov/notamapi/v1/notams";
export const NOTAM_SEARCH = "https://notams.aim.faa.gov/notamSearch/search";
export const TFR_LIST = "https://tfr.faa.gov/tfrapi/exportTfrList";
export const REFRESH_MS = 30 * MIN;
export const KEEP_MS = 180 * MIN;
const TFR_DETAIL_MS = 60 * MIN;
const BUDGET_MS = 50_000;
const MAX_PAGES = 8;
const MAX_TFR_DETAILS = 60;

async function request(url, { method = "GET", headers = {}, body = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, body, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`); e.status = res.status; e.body = text.slice(0, 300); throw e; }
    return { status: res.status, text, type: res.headers.get("content-type") || "" };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`timeout after ${TIMEOUT_MS / 1000}s (${new URL(url).host})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON or a clear error (NOTAM Search may answer with a web page, e.g. a robot check). */
export function jsonOrWhy(text, what) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error(`${what} answered with an empty reply`);
  if (t[0] !== "{" && t[0] !== "[") throw new Error(`${what} answered with a web page instead of data${/captcha|robot|are you human/i.test(t) ? " (a robot check)" : ""}`);
  try { return JSON.parse(t); } catch { throw new Error(`${what} answered with malformed JSON`); }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

/** Runways per airport from site/data/airports-all.json (+ airports-extra.json): {IATA: [[ids, headingTrue]]}. */
export async function loadRunways(airports) {
  const want = new Set(airports.map((a) => a.iata));
  const out = {};
  for (const f of ["airports-all.json", "airports-extra.json"]) {
    try {
      const j = JSON.parse(await readFile(join(ROOT, "site/data", f), "utf8"));
      const fi = (j.f || []).indexOf("runways");
      const ii = (j.f || []).indexOf("iata");
      if (fi < 0 || ii < 0) continue;
      for (const r of j.a || []) if (want.has(r[ii]) && !out[r[ii]] && Array.isArray(r[fi])) out[r[ii]] = r[fi];
    } catch { /* missing file: no runway counts */ }
  }
  return out;
}

const cacheFile = () => process.env.NOTICE_CACHE ? resolve(process.env.NOTICE_CACHE) : join(ROOT, ".cache/notices/cache.json");
async function readCache() {
  try { const j = JSON.parse(await readFile(cacheFile(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
async function writeCache(c) {
  try { await mkdir(dirname(cacheFile()), { recursive: true }); await writeFile(cacheFile(), JSON.stringify(c) + "\n"); } catch { /* cache is best-effort */ }
}

// ---------- live NOTAMs ----------

/** NOTAM API for one airport (pageSize 1000). */
async function apiAirport(a, cred) {
  const url = `${NOTAM_API}?responseFormat=geoJson&icaoLocation=${encodeURIComponent(a.icao)}&pageSize=1000`;
  const r = await request(url, { headers: { client_id: cred.id, client_secret: cred.secret, Accept: "application/json" } });
  return { text: r.text, records: notamsFromApi(jsonOrWhy(r.text, "The FAA NOTAM API")), url: url.replace(/client_\w+=[^&]*/g, "") };
}

/** NOTAM Search for one airport, following offset paging (30 per page) up to MAX_PAGES. */
async function searchAirport(a) {
  const records = [];
  let first = null;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = new URLSearchParams({ searchType: "0", designatorsForLocation: a.icao, notamsOnly: "false", offset: String(offset) }).toString();
    const r = await request(NOTAM_SEARCH, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    first ??= r.text;
    const j = jsonOrWhy(r.text, "FAA NOTAM Search");
    if (j.error) throw new Error(`FAA NOTAM Search: ${String(j.error).slice(0, 120)}`);
    records.push(...notamsFromSearch(j));
    const end = Number(j.endRecordCount);
    const total = Number(j.totalNotamCount);
    if (!(end > offset) || !(end < total)) break;
    offset = end;
  }
  return { text: first, records, url: NOTAM_SEARCH };
}

async function liveNotams(airports, now, raw, cache) {
  const cred = process.env.FAA_NOTAM_CLIENT_ID && process.env.FAA_NOTAM_CLIENT_SECRET ? { id: process.env.FAA_NOTAM_CLIENT_ID, secret: process.env.FAA_NOTAM_CLIENT_SECRET } : null;
  const store = (cache.notam ||= {});
  const t0 = Date.now();
  const due = airports.filter((a) => !store[a.icao] || +now - store[a.icao].at >= REFRESH_MS)
    .sort((x, y) => (store[x.icao]?.at ?? 0) - (store[y.icao]?.at ?? 0));
  const tries = { api: 0, apiFailed: 0, search: 0, searchFailed: 0 };
  const errors = {};
  let sampled = false;
  const fetchOne = async (a, via) => {
    tries[via]++;
    try {
      const r = via === "api" ? await apiAirport(a, cred) : await searchAirport(a);
      store[a.icao] = { at: +now, via, records: r.records };
      if (!sampled) { sampled = true; raw.save("notam", `notam-${via}.json`, r.text, { url: r.url, via }); }
      return true;
    } catch (e) {
      tries[via + "Failed"]++;
      errors[via] ||= String(e.message || e);
      if (e.status) raw.note("notam", { http: e.status, errorBody: e.body || undefined });
      return false;
    }
  };
  const run = async (list, via) => pool(list, via === "api" ? 4 : 2, async (a) => { if (Date.now() - t0 > BUDGET_MS) return; await fetchOne(a, via); });
  let via = cred ? "api" : "search";
  await run(due, via);
  if (cred && tries.api && tries.apiFailed === tries.api) { via = "search"; await run(due, "search"); } // the key didn't work: try the public search
  raw.note("notam", { via, configured: !!cred, due: due.length, ...tries, errors });
  // assemble: fresh or cached (≤ 3 h) records per airport
  const records = [];
  let have = 0, stale = 0;
  for (const a of airports) {
    const e = store[a.icao];
    if (!e || +now - e.at > KEEP_MS) { delete store[a.icao]; continue; }
    have++;
    if (+now - e.at >= REFRESH_MS + 10 * MIN) stale++;
    records.push(...(e.records || []));
  }
  const failed = tries[via + "Failed"] || 0;
  const firstErr = errors[via] || errors.api || errors.search || null;
  if (!have) {
    return { meta: { ok: false, error: firstErr ? `${firstErr}${cred && via === "search" ? " (the FAA NOTAM API key failed too: " + errors.api + ")" : ""}` : "no NOTAMs could be fetched", configured: !!cred, via }, records: null };
  }
  const partial = [failed ? `${failed} of ${tries[via]} airport requests failed: ${firstErr}` : null, stale ? `${stale} airports from an earlier poll` : null, have < airports.length ? `${airports.length - have} airports have no NOTAMs yet` : null].filter(Boolean).join("; ");
  return { meta: { ok: true, error: partial || null, configured: !!cred, via, airports: have, notams: records.length }, records };
}

// ---------- live TFRs ----------

const DETAIL_TYPES = new Set(["VIP", "SPACE", "SECURITY", "SPECIAL", "STADIUM", "AIRSHOW"]);

async function liveTfrs(airports, now, raw, cache) {
  const store = (cache.tfr ||= {});
  raw.note("tfr", { url: TFR_LIST });
  let list;
  try {
    const r = await request(TFR_LIST, { headers: { Accept: "application/json" } });
    raw.save("tfr", "tfr-list.json", r.text, { http: r.status });
    list = parseTfrList(jsonOrWhy(r.text, "The FAA TFR list"));
  } catch (e) {
    if (e.status) raw.note("tfr", { http: e.status, errorBody: e.body || undefined });
    return { meta: { ok: false, error: String(e.message || e) }, tfrs: null };
  }
  const states = new Set(airports.map((a) => a.state).filter(Boolean));
  // details: types that can matter to airline flights; hazards (fires) only in states we cover
  const want = list.filter((t) => DETAIL_TYPES.has(t.type) || (t.type === "HAZARDS" && (!t.state || states.has(t.state))))
    .sort((x, y) => (x.type === "VIP" ? 0 : x.type === "SPACE" ? 1 : 2) - (y.type === "VIP" ? 0 : y.type === "SPACE" ? 1 : 2))
    .slice(0, MAX_TFR_DETAILS);
  const t0 = Date.now();
  let failed = 0, firstErr = null, sampled = false;
  const tfrs = [];
  await pool(want, 4, async (t) => {
    const c = store[t.id];
    if (c && +now - c.at < TFR_DETAIL_MS && c.modified === t.modified) { if (c.tfr) tfrs.push(c.tfr); return; }
    if (Date.now() - t0 > 30_000) { if (c?.tfr) tfrs.push(c.tfr); return; }
    try {
      const r = await request(tfrDetailUrl(t.id), { headers: { Accept: "application/xml,text/xml" } });
      if (!sampled) { sampled = true; raw.save("tfr", "tfr-detail.xml", r.text, { detailUrl: tfrDetailUrl(t.id) }, false); }
      const d = parseTfrDetail(r.text, { typeText: t.typeText });
      const tfr = d ? { ...d, id: d.id || t.id, type: t.type !== "SPECIAL" ? t.type : d.type } : null;
      store[t.id] = { at: +now, modified: t.modified, tfr };
      if (tfr) tfrs.push(tfr);
    } catch (e) {
      failed++;
      firstErr ||= String(e.message || e);
      if (c?.tfr && +now - c.at < KEEP_MS) tfrs.push(c.tfr);
    }
  });
  for (const k of Object.keys(store)) if (!list.some((t) => t.id === k)) delete store[k];
  raw.note("tfr", { listed: list.length, details: want.length, failed, parsed: tfrs.length });
  if (want.length && failed === want.length && !tfrs.length) return { meta: { ok: false, error: `all ${failed} TFR details failed: ${firstErr}` }, tfrs: null };
  return { meta: { ok: true, error: failed ? `${failed} of ${want.length} TFR details failed: ${firstErr}` : null, listed: list.length, tfrs: tfrs.length }, tfrs };
}

// ---------- fixtures ----------

/** {{notam+90}} "YYMMDDHHMM" UTC (tools/build-scenarios.mjs expands it too), then the usual template tokens. */
function expandFixture(text, now) {
  const p2 = (x) => String(x).padStart(2, "0");
  const t = text.replace(/\{\{notam([+-]\d+)\}\}/g, (_, n) => {
    const d = new Date(+now + Number(n) * MIN);
    return p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes());
  });
  return expandTemplate(t, now);
}

async function fixtureNotices(airports, now, raw) {
  const dir = process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : join(HERE, "fixtures");
  const read = async (f) => expandFixture(await readFile(join(dir, f), "utf8"), now);
  const out = { sources: {}, data: { notams: null, tfrs: null, runways: await loadRunways(airports) } };
  const at = new Date().toISOString();
  const api = !!(process.env.FAA_NOTAM_CLIENT_ID && process.env.FAA_NOTAM_CLIENT_SECRET);
  try {
    const f = api ? "notams-api.json" : "notams.json";
    const text = await read(f);
    raw.save("notam", f, text, { url: `fixture:${f}` });
    const records = api ? notamsFromApi(JSON.parse(text)) : notamsFromSearch(JSON.parse(text));
    out.data.notams = records;
    out.sources.notam = { ok: true, at, error: null, configured: api, via: api ? "api" : "search", notams: records.length };
  } catch (e) {
    out.sources.notam = { ok: false, at, error: e.code === "ENOENT" ? "no NOTAM fixture" : String(e.message || e), configured: api, via: null };
  }
  try {
    const text = await read("tfr-list.json");
    raw.save("tfr", "tfr-list.json", text, { url: "fixture:tfr-list.json" });
    const list = parseTfrList(JSON.parse(text));
    const tfrs = [];
    for (const t of list) {
      let xml;
      try { xml = await read(`tfr-detail-${t.id.replace(/\//g, "_")}.xml`); } catch { continue; }
      const d = parseTfrDetail(xml, { typeText: t.typeText });
      if (d) tfrs.push({ ...d, id: d.id || t.id, type: t.type !== "SPECIAL" ? t.type : d.type });
    }
    out.data.tfrs = tfrs;
    out.sources.tfr = { ok: true, at, error: null, listed: list.length, tfrs: tfrs.length };
  } catch (e) {
    out.sources.tfr = { ok: false, at, error: e.code === "ENOENT" ? "no TFR fixture" : String(e.message || e) };
  }
  return out;
}

/**
 * NOTAMs and TFRs for this run. raw: poll.mjs makeRaw(). Returns {sources: {notam, tfr}, data: {notams, tfrs,
 * runways}} for core.mjs assemble({notices: data}); notams/tfrs are null when that source failed.
 */
export async function fetchNotices({ airports, fixtures = false, now = new Date(), raw }) {
  try {
    if (fixtures) return await fixtureNotices(airports, now, raw);
    const cache = await readCache();
    const [n, t, runways] = await Promise.all([liveNotams(airports, now, raw, cache), liveTfrs(airports, now, raw, cache), loadRunways(airports)]);
    await writeCache(cache);
    const at = new Date().toISOString();
    return { sources: { notam: { at, ...n.meta }, tfr: { at, ...t.meta } }, data: { notams: n.records, tfrs: t.tfrs, runways } };
  } catch (e) {
    const at = new Date().toISOString();
    const err = String(e.message || e);
    return { sources: { notam: { ok: false, at, error: err }, tfr: { ok: false, at, error: err } }, data: { notams: null, tfrs: null, runways: {} } };
  }
}
