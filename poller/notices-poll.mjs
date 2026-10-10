// Fetches FAA TFRs, live or from fixtures. Keeps source quality explicit.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTemplate } from "./lib.mjs";
import { parseTfrList, parseTfrDetail, tfrDetailUrl } from "./tfr.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const TIMEOUT_MS = 20_000;
const MIN = 60e3;
export const TFR_LIST = "https://tfr.faa.gov/tfrapi/exportTfrList";
export const KEEP_MS = 180 * MIN;
const TFR_DETAIL_MS = 60 * MIN;
const MAX_TFR_DETAILS = 60;

async function request(url, { method = "GET", headers = {}, body = null, fetchFn = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method, headers: { "User-Agent": UA, ...headers }, body, signal: ctl.signal });
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

/** JSON or a clear source error. */
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

const cacheFile = () => process.env.NOTICE_CACHE ? resolve(process.env.NOTICE_CACHE) : join(ROOT, ".cache/notices/cache.json");
async function readCache() {
  try { const j = JSON.parse(await readFile(cacheFile(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
async function writeCache(c) {
  try { await mkdir(dirname(cacheFile()), { recursive: true }); await writeFile(cacheFile(), JSON.stringify(c) + "\n"); } catch { /* cache is best-effort */ }
}

// ---------- live TFRs ----------

const DETAIL_TYPES = new Set(["VIP", "SPACE", "SECURITY", "SPECIAL", "STADIUM", "AIRSHOW"]);

function eligibleDetails(list, airports) {
  const states = new Set(airports.map((a) => a.state).filter(Boolean));
  return list.filter((t) => DETAIL_TYPES.has(t.type) || (t.type === "HAZARDS" && (!t.state || states.has(t.state))))
    .sort((x, y) => (x.type === "VIP" ? 0 : x.type === "SPACE" ? 1 : 2) - (y.type === "VIP" ? 0 : y.type === "SPACE" ? 1 : 2));
}
function accounting(list, want) {
  return { listed: list.length, excluded: list.length - want.length, eligible: want.length,
    attempted: 0, parsed: 0, cached: 0, cacheHits: 0, skipped: 0, capSkipped: 0, budgetSkipped: 0, failed: 0 };
}
function detail(xml, t) {
  const d = parseTfrDetail(xml, { typeText: t.typeText });
  if (!d || (d.id && d.id !== t.id)) throw new Error(`invalid TFR detail (${t.id})`);
  return { ...d, id: t.id, type: t.type !== "SPECIAL" ? t.type : d.type };
}
function result(counts, tfrs, firstErr) {
  // Skips covered by a current, unchanged cached detail need no missing-coverage warning.
  const incomplete = tfrs.length < counts.eligible || counts.failed > 0;
  return { meta: { ok: !counts.eligible || tfrs.length > 0, ...counts, tfrs: tfrs.length, incomplete,
    error: incomplete ? `TFR coverage incomplete: ${tfrs.length} of ${counts.eligible} eligible details available; ${counts.skipped} skipped, ${counts.failed} failed${firstErr ? `: ${firstErr}` : ""}` : null },
    tfrs: counts.eligible && !tfrs.length ? null : tfrs };
}

/** Bounded detail polling; injected transport/clock also exercise every fallback deterministically. */
export async function liveTfrs(airports, now, raw, cache, { fetchFn = fetch, clock = Date.now } = {}) {
  const store = (cache.tfr ||= {}), started = clock();
  raw.note("tfr", { url: TFR_LIST });
  let list;
  try {
    const r = await request(TFR_LIST, { headers: { Accept: "application/json" }, fetchFn });
    raw.save("tfr", "tfr-list.json", r.text, { http: r.status });
    list = parseTfrList(jsonOrWhy(r.text, "The FAA TFR list"));
  } catch (e) {
    if (e.status) raw.note("tfr", { http: e.status, errorBody: e.body || undefined });
    return { meta: { ok: false, error: String(e.message || e) }, tfrs: null };
  }
  const want = eligibleDetails(list, airports), counts = accounting(list, want);
  const t0 = clock(), current = () => +now + Math.max(0, clock() - started);
  let firstErr = null, sampled = false;
  const tfrs = [];
  function cached(t, limit = KEEP_MS) {
    const c = store[t.id], age = current() - c?.at;
    // An absent modification token cannot establish that a fallback is unchanged.
    return c?.tfr?.id === t.id && t.modified != null && String(t.modified).trim() && c.modified === t.modified &&
      Number.isFinite(age) && age >= 0 && age < limit ? c.tfr : null;
  }
  function fallback(t) { const c = cached(t); if (c) { tfrs.push(c); counts.cached++; } }
  for (const t of want.slice(MAX_TFR_DETAILS)) { counts.skipped++; counts.capSkipped++; fallback(t); }
  await pool(want.slice(0, MAX_TFR_DETAILS), 4, async (t) => {
    const c = cached(t, TFR_DETAIL_MS);
    if (c) { tfrs.push(c); counts.cached++; counts.cacheHits++; return; }
    if (clock() - t0 >= 30_000) { counts.skipped++; counts.budgetSkipped++; fallback(t); return; }
    counts.attempted++;
    try {
      const r = await request(tfrDetailUrl(t.id), { headers: { Accept: "application/xml,text/xml" }, fetchFn });
      if (!sampled) { sampled = true; raw.save("tfr", "tfr-detail.xml", r.text, { detailUrl: tfrDetailUrl(t.id) }, false); }
      const tfr = detail(r.text, t);
      store[t.id] = { at: current(), modified: t.modified, tfr };
      tfrs.push(tfr); counts.parsed++;
    } catch (e) {
      counts.failed++; firstErr ||= String(e.message || e); fallback(t);
    }
  });
  const ids = new Set(list.map(t => t.id));
  for (const k of Object.keys(store)) if (!ids.has(k)) delete store[k];
  const out = result(counts, tfrs, firstErr);
  raw.note("tfr", { details: Math.min(want.length, MAX_TFR_DETAILS), ...out.meta });
  return out;
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
  const out = { sources: {}, data: { tfrs: null } };
  const at = now.toISOString();
  try {
    const text = await read("tfr-list.json");
    raw.save("tfr", "tfr-list.json", text, { url: "fixture:tfr-list.json" });
    const list = parseTfrList(JSON.parse(text));
    const want = eligibleDetails(list, airports), counts = accounting(list, want), tfrs = [];
    let firstErr = null;
    counts.skipped = counts.capSkipped = Math.max(0, want.length - MAX_TFR_DETAILS);
    for (const t of want.slice(0, MAX_TFR_DETAILS)) {
      counts.attempted++;
      try { tfrs.push(detail(await read(`tfr-detail-${t.id.replace(/\//g, "_")}.xml`), t)); counts.parsed++; }
      catch (e) { counts.failed++; firstErr ||= e.code === "ENOENT" ? `missing TFR fixture (${t.id})` : String(e.message || e); }
    }
    const r = result(counts, tfrs, firstErr);
    out.data.tfrs = r.tfrs;
    out.sources.tfr = { at, ...r.meta };
  } catch (e) {
    out.sources.tfr = { ok: false, at, error: e.code === "ENOENT" ? "no TFR fixture" : String(e.message || e) };
  }
  return out;
}

/** FAA flight restrictions for this run; a failed source remains unknown. */
export async function fetchNotices({ airports, fixtures = false, now = new Date(), raw }) {
  try {
    if (fixtures) return await fixtureNotices(airports, now, raw);
    const cache = await readCache();
    delete cache.notam; // Discard legacy airport NOTAM cache entries.
    const t = await liveTfrs(airports, now, raw, cache);
    await writeCache(cache);
    return { sources: { tfr: { at: new Date().toISOString(), ...t.meta } }, data: { tfrs: t.tfrs } };
  } catch (e) {
    return { sources: { tfr: { ok: false, at: new Date().toISOString(), error: String(e.message || e) } }, data: { tfrs: null } };
  }
}
