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
  const out = { sources: {}, data: { tfrs: null } };
  const at = new Date().toISOString();
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
