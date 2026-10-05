// Check page. check.html            -> checks the live data (data/status.json, data/wx/, airport list)
//             check.html?mock=1     -> runs every test scenario (data/scenarios/index.json) instead
//             &render=0             -> skip the render tests (hidden iframes)
// Writes "CHECK PASS" or "CHECK FAIL n" plus one line per row into <pre id="result"> so headless
// Chrome (--dump-dom) and the uptime workflow can read it. Warnings don't fail the check.
import { loadAirports, rank, decodeList } from "./search.js";
import { navChecks } from "./navcheck.js?v=5"; // nav hook
import { tripChecks } from "./check-trips.js?v=8"; // trips hook
import { dataAsserts, pageAsserts, openDetailsPage, detailsPlainText, consistencyChecks } from "./check-scenarios.js?v=8"; // scenarios hook; More details page helpers

const P = new URLSearchParams(location.search);
const MOCK = P.get("mock") === "1";
const RENDER = P.get("render") !== "0";
const MIN = 60e3;
const HOUR = 3600e3;
const FRESH_WARN = 15 * MIN;
const FRESH_FAIL = 20 * MIN;
const METAR_MAX = 2 * HOUR;
const SHARD_MIN_SHARE = 0.95; // live: share of hasMetar airports that must have a fresh shard entry
// Raw coded aviation text that must not reach traveler-facing strings.
export const CODED = /\b(CLSD|(?:FEW|SCT|BKN|OVC)\d{3}|TEMPO|PROB[34]0|NOSIG|\d{4}Z)\b/;
const SOURCE_LABEL = {
  metar: "METAR", taf: "TAF", sigmet: "Convective SIGMETs", isigmet: "Additional SIGMETs", faa: "FAA NAS status", nws: "NWS alerts", spc: "SPC outlook", lamp: "LAMP",
  atcscc: "ATCSCC advisories", tcf: "TCF", cwa: "CWAs", metars: "Global METAR cache", tafs: "Global TAF cache",
};

const groups = []; // {title, rows: [{status, label, detail}]}
function group(title) {
  const g = { title, rows: [] };
  groups.push(g);
  return (status, label, detail = "") => { g.rows.push({ status, label, detail: String(detail) }); return status; };
}

async function getJson(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, ms: performance.now() - t0 };
    return { ok: true, status: r.status, data: JSON.parse(text), bytes: text.length, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e), ms: performance.now() - t0 };
  }
}

const ago = (ms) => (ms < MIN ? "just now" : ms < HOUR ? `${Math.round(ms / MIN)} min ago` : `${(ms / HOUR).toFixed(1)} h ago`);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/;
function shift(v, d) {
  if (typeof v === "string") return ISO.test(v) ? new Date(Date.parse(v) + d).toISOString() : v;
  if (Array.isArray(v)) return v.map((x) => shift(x, d));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x, d)]));
  return v;
}

// ---------- generic checks on one status.json (+ its shards) ----------

/**
 * Returns [{id, status, label, detail}]. ctx: {now, byIcao (airport list by ICAO), list, wxBase, wxShift}
 */
async function checkData(data, ctx) {
  const out = [];
  const r = (id, status, label, detail = "") => out.push({ id, status, label, detail });
  const now = ctx.now;

  // freshness
  const gen = Date.parse(data.generated);
  const age = now - gen;
  r("freshness", !Number.isFinite(gen) || age > FRESH_FAIL ? "fail" : age > FRESH_WARN ? "warn" : "pass",
    "Freshness", Number.isFinite(gen) ? `generated ${ago(age)} (${data.generated}); warn > 15 min, fail > 20 min` : "no generated time");

  // sources
  const src = data.sources || {};
  const down = [];
  const partial = [];
  for (const [k, s] of Object.entries(src)) {
    const bits = [s.ok ? "ok" : "error"];
    const http = s.http ?? s.status;
    if (http != null) bits.push(`HTTP ${http}`);
    if (s.bytes != null) bits.push(`${(s.bytes / 1024).toFixed(1)} KB`);
    const ms = s.ms ?? s.elapsedMs ?? s.durationMs;
    if (ms != null) bits.push(`${Math.round(ms)} ms`);
    if (s.error) bits.push(s.error);
    if (!s.ok) down.push(SOURCE_LABEL[k] || k);
    else if (s.error) partial.push(SOURCE_LABEL[k] || k);
    r(`source:${k}`, s.ok ? (s.error ? "warn" : "pass") : "fail", `Source: ${SOURCE_LABEL[k] || k}`, bits.join(" · "));
  }
  r("sources", down.length ? "fail" : partial.length ? "warn" : Object.keys(src).length ? "pass" : "fail", "All sources",
    down.length ? `unavailable: ${down.join(", ")}` : partial.length ? `partly unavailable: ${partial.join(", ")}` : `${Object.keys(src).length} ok`);
  // restrictions hook: TFR source (README "Notices"). Kept out of "All sources": they warn, never fail, because
  // Optional TFR coverage warns separately from the core feeds.
  const ns = data.noticeSources;
  const nsBits = (s) => [s.ok ? "ok" : "error",
    s.tfrs != null ? `${s.tfrs} TFRs parsed of ${s.listed ?? "?"} listed` : null, s.error].filter(Boolean).join(" · ");
  if (!ns) r("notices", "warn", "Flight restrictions", "not in this build");
  else {
    for (const [k, label] of [["tfr", "TFR source"]]) {
      const s = ns[k];
      r(`notices:${k}`, s && s.ok ? (s.error ? "warn" : "pass") : "warn", label, s ? nsBits(s) : "missing");
    }
  }

  // airports: METAR < 2 h, TAF where hasTaf
  const aps = data.airports || [];
  const monitoring = data.monitoring;
  const validMonitoring = !!(monitoring && monitoring.count === aps.length && Array.isArray(monitoring.baseline) && monitoring.baseline.length >= 32 && new Set(monitoring.baseline).size === monitoring.baseline.length && monitoring.baseline.every(c=>/^[A-Z0-9]{3}$/.test(c) && aps.some(a=>a.iata === c)));
  r("monitoring", validMonitoring ? "pass" : "fail", "Monitored airport coverage metadata", validMonitoring ? `${aps.length} monitored; ${monitoring.baseline.length} baseline airports` : "missing or invalid baseline/count metadata");
  const baseline = new Set(validMonitoring ? monitoring.baseline : aps.map(a=>a.iata));
  const noMetar = [];
  const noTaf = [];
  const tafUnknown = [];
  for (const a of aps.filter((x) => !x.trip)) { // trips hook: trip-only airports are checked in the Trips group
    const obs = a.metar && Date.parse(a.metar.obsTime);
    if (!a.metar || !Number.isFinite(obs) || now - obs > METAR_MAX) noMetar.push(a.iata);
    const info = ctx.byIcao.get(a.icao);
    if (!a.taf) (info ? (info.hasTaf ? noTaf : null) : tafUnknown)?.push(a.iata);
  }
  r("metar", noMetar.some(c=>baseline.has(c)) ? "fail" : noMetar.length ? "warn" : "pass", "METAR under 2 h old at every airport", noMetar.length ? `missing/old: ${noMetar.join(", ")}` : `${aps.length} airports`);
  r("taf", noTaf.some(c=>baseline.has(c)) ? "fail" : noTaf.length || tafUnknown.length ? "warn" : "pass", "TAF where the airport issues one",
    noTaf.length ? `missing: ${noTaf.join(", ")}` : tafUnknown.length ? `not in the airport list (TAF expected?): ${tafUnknown.join(", ")}` : "all present");

  // plausibility
  const bad = [];
  for (const a of aps) {
    const m = a.metar;
    if (!m) continue;
    const chk = (v, lo, hi, what) => { if (v != null && !(Number(v) >= lo && Number(v) <= hi)) bad.push(`${a.iata} ${what} ${v}`); };
    chk(m.temp, -60, 60, "temp °C");
    chk(m.dewp, -80, 60, "dew point °C");
    chk(m.wind && m.wind.spd, 0, 150, "wind kt");
    chk(m.gust, 0, 150, "gust kt");
    chk(m.visib, 0, 100, "visibility sm");
    chk(m.ceiling, 0, 99999, "ceiling ft");
  }
  r("plausible", bad.length ? "fail" : "pass", "Values plausible (temp −60..60 °C, wind 0..150 kt, visibility ≥ 0, ceiling ≥ 0)", bad.join("; ") || "ok");

  // FAA cause classes
  const noCause = [];
  const unknown = [];
  let programs = 0;
  for (const a of aps) for (const f of a.faa || []) {
    programs++;
    if (!f.cause) noCause.push(`${a.iata} ${f.type}`);
    else if (f.cause === "unknown") unknown.push(`${a.iata} ${f.type}`);
  }
  r("faaCause", noCause.length ? "fail" : unknown.length ? "warn" : "pass", "Every FAA program has a cause class",
    noCause.length ? `no cause: ${noCause.join(", ")}` : unknown.length ? `cause unknown: ${unknown.join(", ")}` : `${programs} programs`);

  // raw coded text in traveler-facing strings
  const coded = [];
  const scan = (s, where) => { if (typeof s === "string" && CODED.test(s)) coded.push(`${where}: "${s.slice(0, 80)}"`); };
  for (const a of aps) {
    (a.now?.reasons || []).forEach((s) => scan(s, `${a.iata} now`));
    (a.peak?.reasons || []).forEach((s) => scan(s, `${a.iata} peak`));
    (a.hours || []).forEach((h) => (h.reasons || []).forEach((s) => scan(s, `${a.iata} hour`)));
    (a.faa || []).forEach((f) => { scan(f.plain, `${a.iata} faa.plain`); scan(f.causeLabel, `${a.iata} faa.causeLabel`); });
    for (const k of ["plain", "impact", "traveler", "summary"]) scan(a[k], `${a.iata} ${k}`);
  }
  r("coded", coded.length ? "fail" : "pass", "No raw coded text in traveler fields", coded.slice(0, 6).join("; ") || "clean");

  // global shards
  const wxi = await getJson(ctx.wxBase + "index.json");
  if (!wxi.ok) {
    r("wxIndex", "fail", "Global weather run (data/wx/index.json)", `HTTP ${wxi.status || wxi.error}`);
  } else {
    const idx = ctx.wxShift(wxi.data);
    r("wxIndex", idx.ok ? "pass" : "fail", "Global weather run", idx.ok ? `${idx.airports} airports, ${idx.metars} METARs, ${idx.tafs} TAFs` : idx.error || "not ok");
    const wAge = now - Date.parse(idx.generated);
    r("wxFreshness", !(wAge <= FRESH_FAIL) ? "fail" : wAge > FRESH_WARN ? "warn" : "pass", "Global weather freshness", `generated ${ago(wAge)}`);
    for (const [k, s] of Object.entries(idx.sources || {})) {
      const bits = [s.ok ? "ok" : "error", s.http != null ? `HTTP ${s.http}` : null, s.bytes != null ? `${(s.bytes / 1024).toFixed(0)} KB` : null, s.ms != null ? `${s.ms} ms` : null, s.error].filter(Boolean);
      r(`wxsource:${k}`, s.ok ? "pass" : "fail", `Source: ${SOURCE_LABEL[k] || k}`, bits.join(" · "));
    }
  }
  const capable = ctx.list.filter((a) => a.hasMetar && a.icao);
  const reporting = wxi.ok && Array.isArray(wxi.data.metarStations) ? new Set(wxi.data.metarStations) : null;
  if (!ctx.mock) r("wxStations", reporting?.size ? "pass" : "fail", "Global weather snapshot identifies reporting stations", reporting ? `${reporting.size} listed stations reporting within 2 h` : "metarStations metadata missing");
  const want = reporting ? capable.filter(a=>reporting.has(a.icao)) : capable;
  if (!ctx.mock && reporting) {
    const inactive = capable.length-want.length;
    r("wxInactive", inactive ? "warn" : "pass", "Configured stations without a recent report", `${inactive} of ${capable.length}; their weather outlook stays unavailable`);
  }
  if (want.length) {
    const letters = [...new Set(want.map((a) => a.icao[0].toUpperCase()))];
    const shards = {};
    await Promise.all(letters.map(async (L) => { const s = await getJson(ctx.wxBase + L + ".json"); shards[L] = s.ok ? ctx.wxShift(s.data).a || {} : {}; }));
    const missing = want.filter((a) => {
      const e = shards[a.icao[0].toUpperCase()][a.icao];
      return !e || !e.mt || now - Date.parse(e.mt) > METAR_MAX;
    }).map((a) => a.icao);
    const share = 1 - missing.length / want.length;
    const min = ctx.mock ? 1 : SHARD_MIN_SHARE;
    r("shards", share < min ? "fail" : missing.length ? "warn" : "pass", "Airports with a METAR have a shard entry under 2 h old",
      `${want.length - missing.length} of ${want.length} (${(share * 100).toFixed(1)}%; need ${(min * 100).toFixed(0)}%)${missing.length ? "; missing: " + missing.slice(0, 12).join(", ") + (missing.length > 12 ? "…" : "") : ""}`);
  }
  return out;
}

// ---------- render test ----------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Loads url in a hidden 390px iframe, waits for cards, returns {ok, errors, doc-based checks}; then(win, doc) runs before the frame goes. */
async function renderPage(url, expect = [], then = null) {
  const holder = document.getElementById("frames");
  const f = document.createElement("iframe");
  f.src = url;
  holder.append(f);
  const t0 = Date.now();
  let doc = null;
  let ready = false;
  while (Date.now() - t0 < 15000) {
    await sleep(100);
    try { doc = f.contentDocument; } catch { doc = null; }
    if (!doc) continue;
    const list = doc.getElementById("list");
    if (list && list.querySelector(".card, .empty") && !/Loading airports/.test(list.textContent)) { ready = true; break; }
  }
  await sleep(600); // let searched.js and late errors land
  const matches = x => doc && (x.selector ? !!doc.querySelector(x.selector) : x.text ? (doc.body.innerText || doc.body.textContent || "").includes(x.text) : false);
  // Optional modules finish after the first cards; wait for requested visible content, bounded.
  for (let n = 0; n < 20 && expect.some(x => !matches(x)); n++) await sleep(100);
  const errors = ((f.contentWindow && f.contentWindow.__awxErrors) || []).map((e) => `${e.kind}: ${e.msg}`);
  const results = expect.map((x) => {
    if (!doc) return { x, ok: false };
    if (x.selector) return { x, ok: !!doc.querySelector(x.selector) };
    if (x.text) return { x, ok: (doc.body.innerText || doc.body.textContent || "").includes(x.text) };
    return { x, ok: false };
  });
  const cards = doc ? doc.querySelectorAll("#list .card").length : 0;
  if (then && ready) { // scenarios hook: page assertions, and any errors they cause
    const n = ((f.contentWindow && f.contentWindow.__awxErrors) || []).length;
    try { await then(f.contentWindow, doc); } catch (e) { errors.push("check: " + (e && e.message || e)); }
    errors.push(...((f.contentWindow && f.contentWindow.__awxErrors) || []).slice(n).map((e) => `${e.kind}: ${e.msg}`));
  }
  f.remove();
  return { ready, errors, results, cards };
}

// ---------- build2b: app UI checks (settings, filters, modes, timeline) ----------

/** Loads url in a hidden 390 px frame, waits for cards, runs fn(win, doc), removes the frame. */
async function withPage(url, fn, size) {
  const holder = document.getElementById("frames");
  const f = document.createElement("iframe");
  if (size) { f.style.width = size[0] + "px"; f.style.height = size[1] + "px"; }
  f.src = url;
  holder.append(f);
  const t0 = Date.now();
  let doc = null;
  try {
    while (Date.now() - t0 < 15000) {
      await sleep(100);
      try { doc = f.contentDocument; } catch { doc = null; }
      const list = doc && doc.getElementById("list");
      if (list && list.querySelector(".card") && f.contentWindow.AWXApp && f.contentWindow.AWXApp.state.loaded) break;
    }
    await sleep(300);
    return await fn(f.contentWindow, doc);
  } finally {
    f.remove();
  }
}
const frameSleep = (w, ms) => new Promise((r) => w.setTimeout(r, ms));
// One compact day-of entry opens the scheduled trip and only relevant airport concerns.
async function flightBriefChecks(add, w, doc) {
  for (let n = 0; n < 30 && !w.AWXTrips; n++) await sleep(100);
  const T = w.AWXTrips;
  if (!T) { add("fail", "Flight brief module loads", "unavailable"); return; }
  await T.ready();
  w.AWXNav?.go("airports");
  const trigger = doc.querySelector(".thome");
  add(!doc.getElementById("brief") && !doc.getElementById("briefWrap") ? "pass" : "fail", "No unrelated standalone airport brief");
  add(!!trigger === T.hasTodayFlight() ? "pass" : "fail", "Home brief appears only for departure-day flights");
  if (!trigger) return;
  trigger.focus(); trigger.click();
  const sheet = doc.getElementById("tripSheet");
  const trip = T._state().trips.find(t => sheet?.textContent.includes(t.legs[0].from) && sheet?.textContent.includes(t.legs.at(-1).to));
  const route = new Set(trip?.legs.flatMap(l => [l.from, l.to]) || []);
  const groups = [...sheet.querySelectorAll(".timpact")];
  add(sheet.textContent.includes("Today's flight brief") && !!sheet.querySelector(".tstat") && /scheduled|schedule/i.test(sheet.querySelector(".tstat")?.textContent || "") ? "pass" : "fail", "Brief presents overall outlook with schedule qualification");
  add(groups.every(g => route.has(g.dataset.impactIata) && !!g.querySelector("p") && !!g.querySelector("button")) && (!trip || !trip.concerns.length || !!groups.length) ? "pass" : "fail", "Airport concerns stay grouped within the itinerary");
  add(sheet.getAttribute("role") === "dialog" && sheet.getAttribute("aria-modal") === "true" && sheet.contains(doc.activeElement) ? "pass" : "fail", "Flight brief opens an accessible dialog");
  sheet.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frameSleep(w, 450);
  add(doc.getElementById("tripWrap")?.hidden && doc.activeElement === trigger ? "pass" : "fail", "Escape closes flight brief and restores focus");
}

// Aviation codes that must not reach Traveler mode outside Pilot details: flight categories, coded weather groups,
// TAF change groups, Zulu times, knots, and the report names.
export const AVIATION_CODES = /\b(VFR|MVFR|IFR|LIFR|METAR|TAF|SIGMET|LAMP|TCF|CWA|TEMPO|PROB[34]0|BECMG|NOSIG|CLSD|(?:FEW|SCT|BKN|OVC)\d{3}|\d{4}Z|\d{3}°?\s?\d+G?\d*\s?kt|kt)\b/;

// The settings every assertion expects (Traveler mode, each airport's own time, 12-hour clock, IATA codes, every
// disruption type shown). main() pins them for the whole run and puts the user's settings back afterwards, so a
// check never depends on what was left in this browser; checks that need another setting set it explicitly.
const SETTINGS_KEY = "awx-settings";
const BASELINE = Object.freeze({ mode: "traveler", timeRef: "airport", clock: 12, codes: "iata" });
const baseline = (o = {}) => Object.assign({}, BASELINE, o);
const dropTestOverlays = () => { // site/testmode.js keeps a scenario page's writes in sessionStorage ("awx-test:awx-…")
  try { for (const k of Object.keys(sessionStorage)) if (k.indexOf("awx-test:awx-settings") === 0) sessionStorage.removeItem(k); } catch { /* storage blocked */ }
};
/** Pins BASELINE (keeping the theme); returns a function that restores the saved settings. */
function pinSettings() {
  let saved = null;
  try { saved = localStorage.getItem(SETTINGS_KEY); } catch { return () => {}; }
  let theme;
  try { theme = (JSON.parse(saved || "null") || {}).theme; } catch { /* corrupt */ }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(baseline(theme ? { theme } : {})));
  dropTestOverlays();
  return () => {
    try { if (saved == null) localStorage.removeItem(SETTINGS_KEY); else localStorage.setItem(SETTINGS_KEY, saved); } catch { /* ignore */ }
    dropTestOverlays();
  };
}
/** In a loaded frame: Traveler mode, airport time, 12-hour clock and IATA codes, whatever the frame started with. */
function frameBaseline(w) {
  const P = w && (w.AWXPrefs || (w.AWXNav && w.AWXNav.prefs && w.AWXNav.prefs()));
  if (!P || !P.getPrefs || !P.setPref) return;
  const p = P.getPrefs();
  for (const [k, v] of Object.entries(BASELINE)) if (String(p[k]) !== String(v)) P.setPref(k, v);
}

async function uiChecks(add, scenario) {
  const KEY = SETTINGS_KEY;
  const saved = localStorage.getItem(KEY);
  const savedFavs = localStorage.getItem("awx-favs");
  const url = scenario ? `./index.html?test=${scenario}` : "./index.html";
  const set = (o) => { localStorage.setItem(KEY, JSON.stringify(baseline(o))); dropTestOverlays(); };
  try {
    // settings persist (written through prefs.js in one page load, read back in the next)
    set({});
    await withPage(url, async (w) => { w.AWXPrefs.setPref("mode", "aviation"); w.AWXPrefs.setPref("show", { wind: false }); w.AWXPrefs.setPref("clock", 24); w.AWXPrefs.setPref("timeRef", "mine"); });
    await withPage(url, async (w) => {
      const p = w.AWXPrefs.getPrefs();
      const ok = p.mode === "aviation" && p.show.wind === false && p.show.storms === true && p.clock === 24 && p.timeRef === "mine";
      add(ok ? "pass" : "fail", "Settings persist across reloads (localStorage awx-settings via prefs.js)", ok ? "mode, show, clock, timeRef" : JSON.stringify(p));
    });

    // a hidden category never hides a ground stop: every category off
    set({ show: Object.fromEntries(["storms", "winter", "wind", "fog", "heat", "faa", "atc", "runways", "vip", "space", "tstm"].map((k) => [k, false])) });
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const gs = A.state.data.airports.filter((a) => (a.faa || []).some((f) => f.type === "ground_stop") || (a.atcscc || []).some((x) => x.type === "GS" && x.active));
      if (!gs.length) { add("info", "Hidden categories never hide a ground stop", "no ground stop in this data"); return; }
      const bad = [];
      for (const a of gs) {
        const v = A.view(a);
        if (v.now.level < 4 || !v.now.reasons.some((r) => /^Ground stop/.test(r))) bad.push(`${a.iata} level ${v.now.level}`);
        A.openSheet(a.iata);
        await frameSleep(w, 50);
        const t = doc.getElementById("sheet").innerText;
        if (!/Ground stop/i.test(t)) bad.push(`${a.iata} sheet has no ground stop`);
        const o = w.AWXOutlook.evaluate(a, { now: Date.now() });
        if (o.programs.length === 1 && o.programs[0].type === "ground_stop") {
          const sh = doc.getElementById("sheet");
          if (sh.querySelector(".sc-delay")?.textContent !== "Ground Stop") bad.push(`${a.iata} missing simple Ground Stop label`);
          if (!/departure airports/.test(t)) bad.push(`${a.iata} missing flight impact`);
          if ([...sh.querySelectorAll("h3")].some((e) => e.textContent === "Delays & closures")) bad.push(`${a.iata} repeats its only restriction`);
        }
        A.closeSheet();
      }
      add(bad.length ? "fail" : "pass", "With every disruption type hidden, ground stops still show and still set Severe", bad.join("; ") || gs.map((a) => a.iata).join(", "));
    });

    // Traveler mode: no aviation codes outside Pilot details (home cards and every sheet)
    set({ mode: "traveler" });
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const hits = [];
      const scan = (text, where) => { const m = AVIATION_CODES.exec(text); if (m) hits.push(`${where}: "${m[0]}" in "${text.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " ")}"`); };
      A.state.filter = "all";
      A.render();
      await frameSleep(w, 50);
      scan(doc.getElementById("list").innerText, "home");
      for (const a of A.state.data.airports) {
        A.openSheet(a.iata);
        await frameSleep(w, 20);
        const sh = doc.getElementById("sheet").cloneNode(true);
        sh.querySelectorAll(".pilot, details:not([open]) > :not(summary), .bx-layer:not(.on)").forEach((e) => e.remove());
        scan(sh.textContent, a.iata);
        // the More details page: plain words outside its Pilot details card
        if (await openDetailsPage(w, doc, a.iata)) scan(detailsPlainText(doc), a.iata + " More details");
        else hits.push(`${a.iata}: More details didn't open`);
        A.closeSheet();
      }
      add(hits.length ? "fail" : "pass", "Traveler mode shows no aviation codes outside Pilot details (sheets and More details)", hits.slice(0, 4).join("; ") || `home + ${A.state.data.airports.length} sheets and their More details pages`);
      // an FAA time written in another zone ("7:45 PM EDT" for SFO) is read in that zone and shown in the airport's
      const sfo = { tz: "America/Los_Angeles" };
      const other = A.retime ? A.retime("Ground stop until 7:45 PM EDT", sfo) : "";
      const same = A.retime ? A.retime("Ground stop until 7:45 PM PT", sfo) : "";
      const zoneOk = /until [34]:45 PM P[DS]T$/.test(other) && /until 7:45 PM P[DS]T$/.test(same);
      add(zoneOk ? "pass" : "fail", "FAA times with a stated zone are converted to the airport's local time", zoneOk ? other : `${other} / ${same}`);
    });

    await withPage(url, async (w, doc) => {
      const A = w.AWXApp, panel = doc.querySelector("#navAirports"), bad = [];
      const wheel = (el, dy) => {
        const e = new w.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: dy });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      };
      A.openSheet(A.state.data.airports[0].iata);
      await frameSleep(w, 50);
      const sheet = doc.getElementById("sheet");
      if (!doc.documentElement.classList.contains("awx-sheet-lock") || w.getComputedStyle(panel).overflowY !== "hidden") bad.push("background panel isn't locked");
      sheet.scrollTop = sheet.scrollHeight;
      if (!wheel(sheet, 100) || !wheel(panel, 100)) bad.push("bottom/background wheel escaped");
      sheet.scrollTop = 0;
      if (sheet.scrollHeight > sheet.clientHeight && wheel(sheet, 100)) bad.push("normal sheet scrolling blocked");
      A.openDetails(A.state.openIata, "weather");
      if (!wheel(sheet, 100)) bad.push("parent sheet scrolls behind detail page");
      A.closeDetails();
      if (!doc.documentElement.classList.contains("awx-sheet-lock")) bad.push("nested close unlocked the background");
      A.closeSheet();
      if (doc.documentElement.classList.contains("awx-sheet-lock") || wheel(panel, 100)) bad.push("background stayed locked after close");
      add(bad.length ? "fail" : "pass", "Sheets contain bottom-edge scrolling and keep background panels locked through nested pages", bad.join("; ") || "wheel boundary, active sheet, nested close and final unlock checked");
    });

    // Aviation mode shows a flight category
    set({ mode: "aviation" });
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const a = A.state.data.airports.find((x) => x.metar && x.metar.fltCat) || A.state.data.airports[0];
      A.openSheet(a.iata);
      await frameSleep(w, 50);
      const fc = [...doc.querySelectorAll("#sheet .boxwrap .fc, #sheet .cw .fc")].map((e) => e.textContent).filter((t) => /^(VFR|MVFR|IFR|LIFR)$/.test(t));
      A.openDetails(a.iata);
      await frameSleep(w, 50);
      const pilotVisible = !!doc.querySelector("#mdSheet .pilot .pd");
      add(fc.length && pilotVisible ? "pass" : "fail", "Aviation mode shows flight categories and opens technical details", `${a.iata}: ${fc.slice(0, 3).join(", ") || "none"}; Pilot details ${pilotVisible ? "available in More details" : "missing"}`);
    });

    // Timeline: 12 past + 24 forecast hours, dimmed history, lens on now, stable sheet layout
    set({});
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      for (const card of doc.querySelectorAll("#list .card")) A.ensureCardTimeline?.(card);
      const wraps = [...doc.querySelectorAll("#list .tl-wrap")];
      const wrongWindow = wraps.filter((el) => {
        const T = el._tl;
        const now = A.state.sample ? Date.parse(A.state.data.generated) : Date.now();
        return T.slots.length !== 36 || T.day.cur !== 12 || T.day.end - T.day.start !== 36 * HOUR ||
          now < T.day.start + 12 * HOUR || now >= T.day.start + 13 * HOUR;
      });
      add(wraps.length && !wrongWindow.length ? "pass" : "fail", "Rolling timelines: 12 past hours, 24 forecast hours, Now one-third across", `${wraps.length - wrongWindow.length} of ${wraps.length}`);
      for (const el of wraps) {
        el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        el.dispatchEvent(new w.KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      }
      add(wraps.every((el) => el.getAttribute("role") === "slider" && el.getAttribute("tabindex") === "0" && el._tl.shown == null && !el.classList.contains("scrub")) ? "pass" : "fail",
        "Main timeline previews return on release", "Keyboard previews restore Now; touch previews wait for a hold");
      if (wraps[0]) {
        const el = wraps[0], card = el.closest(".card"), bar = el.querySelector(".tl");
        card.style.contentVisibility = "visible";
        card.scrollIntoView({ block: "center" });
        const rect = bar.getBoundingClientRect(), x = rect.left + rect.width * .7, y = rect.top + 5;
        const pointer = (type, dx = 0) => bar.dispatchEvent(new w.PointerEvent(type, { pointerId: 7, button: 0, clientX: x + dx, clientY: y, bubbles: true }));
        pointer("pointerdown");
        const waits = el._tl.shown == null;
        await sleep(300);
        const previews = el._tl.shown != null;
        pointer("pointerup");
        bar.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
        add(waits && previews && el._tl.shown == null && !A.state.openIata ? "pass" : "fail", "Main timeline: hold then release", "Preview waits for the hold; release restores Now without opening the card");
        pointer("pointerdown");
        bar.dispatchEvent(new w.PointerEvent("pointermove", { pointerId: 7, button: 0, clientX: x, clientY: y + 20, bubbles: true }));
        await sleep(300);
        const cancelled = el._tl.shown == null;
        pointer("pointerup", 20);
        add(cancelled ? "pass" : "fail", "Main timeline: vertical swipes cancel the pending hold", "Vertical scrolling before activation never selects an hour");
        pointer("pointerdown");
        bar.dispatchEvent(new w.PointerEvent("pointermove", { pointerId: 7, button: 0, clientX: rect.left + 1, clientY: y + 2, bubbles: true }));
        await sleep(30);
        const pastSelected = el._tl.shown === 0 && el._tl.shown < el._tl.rest;
        pointer("pointerup");
        add(pastSelected && el._tl.shown == null ? "pass" : "fail", "Main timeline: drag into the past", "Horizontal drag selects the earliest hour before the hold timer; release restores Now");
      }
      const undim = wraps.filter((el) => {
        const segs = [...el.querySelectorAll(".tl .s")];
        const cur = segs.findIndex((s) => s.classList.contains("cur"));
        // past = every hour before the current one: marked and drawn below full strength (lower than the same level later)
        return cur < 0 || segs.slice(0, cur).some((s) => {
          const op = Number(w.getComputedStyle(s).opacity);
          const twin = segs.slice(cur).find((x) => x.className.replace(/ (cur|tick)/g, "") === s.className.replace(" past", ""));
          return !s.classList.contains("past") || op >= 1 || (twin && op >= Number(w.getComputedStyle(twin).opacity));
        });
      });
      add(!undim.length ? "pass" : "fail", "Past hours are dimmed", undim.length ? `${undim.length} timelines with undimmed past hours` : "all past hours dimmed");
      await sleep(450); // Release animates the lens back to Now before measuring its settled position.
      if (A.placeLenses) A.placeLenses(); // (virtual-time runs may not have run the animation frame yet)
      const off = wraps.map((el) => {
        const card = el.closest(".card");
        card.style.contentVisibility = "visible";
        card.scrollIntoView({ block: "center" });
        A.placeLenses();
        const cur = el.querySelector(".tl .s.cur"), lens = el.querySelector(".lens");
        if (!cur || !lens || lens.hidden) return 99;
        const a = cur.getBoundingClientRect(), b = lens.getBoundingClientRect();
        return Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
      });
      add(off.length && Math.max(...off) <= 1.5 ? "pass" : "fail", "The lens is centred on the current hour", `max offset ${Math.max(...off).toFixed(2)} px`);
      const tzText = wraps.filter((el) => /\b(ET|CT|MT|PT|AKT|HT)\b/.test(el.querySelector(".ticks").textContent));
      add(!tzText.length ? "pass" : "fail", "No ET/CT-style zone label in the timeline", tzText.length ? `${tzText.length} timelines` : "none");
      // Held previews and their release leave the next section unchanged.
      const a = A.state.data.airports[0];
      A.openSheet(a.iata);
      await frameSleep(w, 450);
      const sheetEl = doc.getElementById("sheet");
      const rect = () => { const n = doc.querySelector("#sheet .boxwrap").nextElementSibling; return `${n.offsetTop},${n.offsetHeight},${sheetEl.scrollTop}`; };
      const bar = doc.querySelector("#sheet .bigwrap");
      bar.focus({ preventScroll: true });
      const r0 = rect();
      const shifts = [];
      for (let i = 0; i < 6; i++) {
        bar.dispatchEvent(new w.KeyboardEvent("keydown", { key: i < 3 ? "ArrowRight" : "ArrowLeft", bubbles: true }));
        await frameSleep(w, 30);
        if (rect() !== r0) shifts.push(rect());
      }
      const shown = doc.querySelector("#sheet .bx-layer.on").dataset.layer !== "rest";
      bar.dispatchEvent(new w.KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      bar.dispatchEvent(new w.KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
      await frameSleep(w, 30);
      if (rect() !== r0) shifts.push("after release " + rect());
      const restored = doc.querySelector("#sheet .bx-layer.on").dataset.layer === "rest" && bar._tl.shown == null;
      add(shown && restored && !doc.querySelector("#sheet .backnow") && !shifts.length ? "pass" : "fail", "Held hour previews return on release without a Back to now button or layout shift", shifts.join("; ") || `${r0} unchanged`);
      // Quiet/active/later-risk cards remain compact, with no expandable content.
      const counts = { split: 0, single: 0, clear: 0 };
      const wrong = [];
      let expandable = 0;
      for (const x of A.state.data.airports) {
        A.openSheet(x.iata);
        await frameSleep(w, 10);
        const sm = A.summary(x); // the display levels (weather/FAA raised by the delay chance), as the sheet and card show
        const want = w.AWXCats.restLayout(sm.nowLevel, sm.level, sm.later);
        const rest = doc.querySelector('#sheet .bx-layer[data-layer="rest"]');
        const lay = rest.querySelector(".sc").dataset.layout;
        const got = lay === "split" && rest.querySelector(".sc-ahead .la-i") ? "split" : lay === "clear" ? "clear" : "single";
        counts[got]++;
        expandable += doc.querySelectorAll("#sheet details, #sheet .morebtn, #sheet [aria-expanded]").length;
        if (got !== want) wrong.push(`${x.iata} ${got} (want ${want})`);
      }
      add(expandable ? "fail" : "pass", "Airport details have no expandable cards", `${expandable} expanders`);
      A.closeSheet();
      add(wrong.length ? "fail" : "pass", "Sheet shows one Now card (a later, higher risk under Looking ahead) or a normal status as the levels say", wrong.join("; ") || `split ${counts.split}, single ${counts.single}, clear ${counts.clear}`);
    });

    // iPhone first screen: at 390×700 in Traveler mode the sheet's timeline is visible without scrolling (busy + quiet airport)
    set({ mode: "traveler" });
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const aps = A.state.data.airports;
      const busy = aps.find((x) => (x.faa || []).some((f) => f.type === "ground_stop")) || aps[0];
      const quiet = aps.find((x) => x.peak.level === 0) || aps[aps.length - 1];
      const out = [];
      const atl = aps.find((x) => x.iata === "ATL");
      for (const a of [busy, quiet, atl].filter((x, i, arr) => x && arr.indexOf(x) === i)) {
        A.openSheet(a.iata);
        await frameSleep(w, 60);
        // where the bar ends once the sheet has slid up (the sheet sits on the bottom edge), whatever its animation state
        const sh = doc.getElementById("sheet");
        const tl = doc.querySelector("#sheet .bigwrap .tl").getBoundingClientRect();
        const bottom = w.innerHeight - sh.offsetHeight + (tl.bottom - sh.getBoundingClientRect().top);
        out.push({ iata: a.iata, bottom: Math.round(bottom), ok: bottom <= w.innerHeight && sh.scrollTop === 0 });
        A.closeSheet();
        await frameSleep(w, 30);
      }
      add(out.every((x) => x.ok) ? "pass" : "fail", "Traveler: the sheet's timeline is on the first screen at 390×700 (busy, quiet, ATL)",
        out.map((x) => `${x.iata} bar ends at ${x.bottom} px`).join(", ") + " (viewport 700)");
    }, [390, 700]);

    // no percentages in Traveler-mode delay text (cards, Now/Peak/hour cards, the delay card, trips)
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const hits = [];
      const scan = (root, where) => {
        for (const el of root.querySelectorAll(".dl-line, .dl-block, .dl-routine, .sc-delay, #trips, .tflight, .mv-line, .mv-sum")) if (/\d\s?%/.test(el.textContent)) hits.push(`${where}: "${el.textContent.trim().slice(0, 60)}"`);
      };
      A.state.filter = "all";
      A.render();
      await frameSleep(w, 80);
      scan(doc, "home");
      let routines = 0;
      for (const a of A.state.data.airports) {
        A.openSheet(a.iata);
        await frameSleep(w, 15);
        scan(doc.getElementById("sheet"), a.iata);
        routines += doc.querySelectorAll("#sheet .dl-routine").length;
        if (await openDetailsPage(w, doc, a.iata)) { const t = detailsPlainText(doc); const m = /\d\s?%/.exec(t); if (m) hits.push(`${a.iata} More details: "${t.slice(Math.max(0, m.index - 50), m.index + 5)}"`); }
        A.closeSheet();
      }
      const n = doc.querySelectorAll(".dl-line, .sc-delay").length;
      add(routines ? "fail" : "pass", "Traveler sheets omit routine delay commentary", `${routines} routine lines`);
      add(hits.length ? "fail" : "pass", "Traveler: delay chances in words, no % (cards, sheets, routine lines, More details, trips)", hits.slice(0, 4).join("; ") || `${n} delay lines, ${routines} routine lines and every More details page checked`);
    });

    // our own name and identity: the title is "Airports"; no "Flighty" in visible UI text outside setup-instruction lists
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const hits = [];
      const scan = (where) => {
        const c = doc.body.cloneNode(true);
        c.querySelectorAll("ol, script, style, code").forEach((e) => e.remove()); // numbered setup steps may name it
        if (/\bFlighty\b/.test(c.innerText || c.textContent)) hits.push(where); // case-sensitive: "Your flight" + "Your 9 PM…" would match /flighty/i
      };
      scan("home");
      for (const a of A.state.data.airports.slice(0, 8)) { A.openSheet(a.iata); await frameSleep(w, 15); scan(a.iata); A.closeSheet(); }
      if (w.AWXNav) {
        for (const pg of [null, "trips", "data", "airports"]) { w.AWXNav.openSettings(pg || undefined); await frameSleep(w, 60); scan("Settings " + (pg || "root")); const done = [...doc.querySelectorAll(".awx-done")].pop(); if (done) done.click(); await frameSleep(w, 30); }
        w.location.hash = "#trips"; await frameSleep(w, 200); scan("Trips tab"); w.location.hash = "";
      }
      const title = doc.title;
      add(title === "Airports" && !hits.length ? "pass" : "fail", "App identity: title \"Airports\", no \"Flighty\" in visible UI text",
        `title "${title}"` + (hits.length ? `; "Flighty" visible in ${hits.join(", ")}` : "; clean outside setup steps"));
    });

    // switching the Times setting changes the labels
    await withPage(url, async (w, doc) => {
      const A = w.AWXApp;
      const mine = w.Intl.DateTimeFormat().resolvedOptions().timeZone;
      const off = (tz) => new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      const a = A.state.data.airports.find((x) => off(x.tz) !== off(mine));
      if (!a) { add("info", "Times setting changes the labels", "every airport is in this device's zone"); return; }
      const read = () => { A.openSheet(a.iata); const t = doc.querySelector("#sheet .sh-where").textContent + " | " + doc.querySelector("#sheet .bigwrap").dataset.start + " | " + doc.querySelector('#sheet .bx-layer[data-layer="rest"] .sc-when').textContent; A.closeSheet(); return t; };
      frameBaseline(w); // airport time, 12-hour clock: explicitly, before reading the labels
      await frameSleep(w, 50);
      const before = read();
      w.AWXPrefs.setPref("timeRef", "mine");
      await frameSleep(w, 50);
      const after = read();
      w.AWXPrefs.setPref("timeRef", "airport");
      const ok = before !== after && /Times in /.test(after);
      add(ok ? "pass" : "fail", "Switching Times to My time zone changes the timeline and labels", `${a.iata}: ${before} → ${after}`);
    });
  } catch (e) {
    add("fail", "App UI checks ran", String((e && e.stack) || e));
  } finally {
    if (saved == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, saved);
    if (savedFavs == null) localStorage.removeItem("awx-favs"); else localStorage.setItem("awx-favs", savedFavs);
  }
}

// ---------- scenario assertions ----------

function evalAssert(x, data, checks, shards) {
  const ap = (iata) => (data.airports || []).find((a) => a.iata === iata);
  const cmp = (v, op, w) => (op === "==" ? v === w : op === "<=" ? v <= w : op === ">=" ? v >= w : op === "<" ? v < w : v > w);
  switch (x.t) {
    case "level": {
      const a = ap(x.iata);
      const v = a && a[x.of || "now"] ? a[x.of || "now"].level : null;
      return { ok: v != null && cmp(v, x.op, x.v), label: `${x.iata} ${x.of || "now"} level ${x.op} ${x.v}`, got: `got ${v}` };
    }
    case "faa": {
      const a = ap(x.iata);
      const hit = (a?.faa || []).find((f) => f.type === x.type && (!x.cause || f.cause === x.cause));
      return { ok: !!hit, label: `${x.iata} has ${x.type}${x.cause ? ` with cause "${x.cause}"` : ""}`, got: `got ${JSON.stringify((a?.faa || []).map((f) => [f.type, f.cause]))}` };
    }
    case "reason":
    case "noReason": {
      const a = ap(x.iata);
      const all = [...(a?.now?.reasons || []), ...(a?.peak?.reasons || [])];
      const has = all.some((s) => new RegExp(x.re).test(s));
      return { ok: x.t === "reason" ? has : !has, label: `${x.iata} reasons ${x.t === "reason" ? "include" : "don't include"} /${x.re}/`, got: `got ${JSON.stringify(all.slice(0, 3))}` };
    }
    case "source": {
      const s = (data.sources || {})[x.name];
      return { ok: !!s && !!s.ok === x.ok, label: `source ${x.name} ${x.ok ? "ok" : "unavailable"}`, got: `got ${s ? (s.ok ? "ok" : "error: " + s.error) : "missing"}` };
    }
    case "check": {
      const c = checks.find((k) => k.id === x.id);
      return { ok: !!c && c.status === x.expect, label: `check "${x.id}" reports ${x.expect}`, got: `got ${c ? c.status : "no such check"}` };
    }
    case "allLevels": {
      const over = (data.airports || []).filter((a) => a.now.level > x.max || a.peak.level > x.max).map((a) => `${a.iata} ${a.now.level}/${a.peak.level}`);
      return { ok: !over.length, label: `every airport level ≤ ${x.max}`, got: over.length ? `got ${over.join(", ")}` : "" };
    }
    case "shard":
    case "noShard": {
      const e = shards[x.icao[0]]?.[x.icao];
      if (x.t === "noShard") return { ok: !e, label: `${x.icao} has no shard entry (no reports)`, got: e ? "got an entry" : "" };
      const ok = !!e && (x.has || []).every((k) => e[k]) && (x.lacks || []).every((k) => !e[k]);
      return { ok, label: `${x.icao} shard entry has ${(x.has || []).join("+")}${x.lacks ? ", lacks " + x.lacks.join("+") : ""}`, got: e ? `got keys ${Object.keys(e).join(",")}` : "got no entry" };
    }
    default:
      return null; // "rendered" handled by the render test
  }
}

// ---------- runs ----------

async function airportList() {
  try {
    const list = await loadAirports("./data/");
    return { list, byIcao: new Map(list.filter((a) => a.icao).map((a) => [a.icao, a])) };
  } catch (e) {
    return { list: [], byIcao: new Map(), error: String(e.message || e) };
  }
}

function searchChecks(add, list, error) {
  if (error || !list.length) { add("fail", "Airport list loads (data/airports-all.json)", error || "empty"); return; }
  add("pass", "Airport list loads", `${list.length} airports in the core file`);
  const has = (c) => list.some((a) => a.code === c);
  const tests = [
    ["ORD", (r) => r[0]?.code === "ORD", "exact IATA first"],
    ["KORD", (r) => r[0]?.code === "ORD", "exact ICAO first"],
    ["nyc", (r) => ["JFK", "LGA", "EWR"].filter(has).every((c) => r.slice(0, 3).some((a) => a.code === c)), "alias NYC → JFK/LGA/EWR"],
    ["chicago", (r) => r.slice(0, 2).every((a) => ["ORD", "MDW"].includes(a.code)), "Chicago → ORD, MDW first"],
    ["hagatna", (r) => !has("GUM") || r.some((a) => a.code === "GUM"), "accent-insensitive (Hagåtña → GUM)"],
    ["london", (r) => !has("LHR") || r[0]?.code === "LHR", "London → LHR first"],
  ];
  for (const [q, ok, what] of tests) {
    const r = rank(q, list);
    add(ok(r) ? "pass" : "fail", `Search "${q}": ${what}`, r.slice(0, 5).map((a) => a.code).join(", ") || "no results");
  }
}

// live relay: the Cloudflare Worker named in data/config.json (README "Live relay"). Not configured is a warning.
const LIVE_MAX_AGE = 3 * MIN;
async function liveRelay(add) {
  const cfg = await getJson("./data/config.json");
  const url = cfg.ok && cfg.data && typeof cfg.data.liveUrl === "string" ? cfg.data.liveUrl.replace(/\/+$/, "") : null;
  if (!url) { add("warn", "Live relay", "not configured (data/config.json has no liveUrl: add the Cloudflare secrets, README \"Live relay\")"); return; }
  const h = await getJson(url + "/health");
  add(h.ok && h.data && h.data.ok ? "pass" : "fail", "Live relay /health", h.ok ? `${url} · version ${h.data.version} · ${Math.round(h.ms)} ms` : `${url}: HTTP ${h.status || h.error}`);
  const s = await getJson(url + "/status?ids=MSP");
  if (!s.ok) { add("fail", "Live relay /status?ids=MSP", `HTTP ${s.status || s.error}`); return; }
  const m = (s.data.sources || {}).metar;
  const ap = (s.data.airports || []).find((a) => a.iata === "MSP");
  const age = m && m.at ? Date.now() - Date.parse(m.at) : null;
  const ok = !!(m && m.ok && m.live && !m.stale && age != null && age < LIVE_MAX_AGE && ap && ap.metar);
  add(ok ? "pass" : "fail", "Live relay: MSP METAR fetched under 3 min ago",
    !m ? "no metar source in the reply" : m.stale ? `live METAR failed (${m.liveError}); showing the build's` : `fetched ${age == null ? "?" : ago(age)}${ap && ap.metar ? `, observed ${ap.metar.obsTime}` : ", no METAR for MSP"} · ${Math.round(s.ms)} ms`);
}

async function runLive() {
  const add = group("Live data");
  const now = Date.now();
  const st = await getJson("./data/status.json");
  const { list, byIcao, error } = await airportList();
  if (!st.ok) {
    add("fail", "status.json loads", st.status === 404 ? "404: the poller hasn't deployed data (the app shows sample data)" : `HTTP ${st.status || st.error}`);
  } else {
    add("pass", "status.json loads", `${(st.bytes / 1024).toFixed(0)} KB in ${Math.round(st.ms)} ms, ${st.data.airports?.length ?? 0} airports`);
    for (const c of await checkData(st.data, { now, byIcao, list, wxBase: "./data/wx/", wxShift: (d) => d, mock: false })) add(c.status, c.label, c.detail);
  }
  searchChecks(group("Search"), list, error);
  await liveRelay(group("Live relay")); // live relay
  await tripChecks(group("Trips"), { url: "./data/trips.json", data: st.ok ? st.data : null }); // trips hook
  try { await (await import("./brief.js")).checkRow(group("Change log"), { data: st.ok ? st.data : null }); } catch (e) { group("Change log")("warn", "Change log", "check failed: " + (e.message || e)); } // brief hook
  try { await (await import("./movement.js")).checkRow(group("Movement feed")); } catch (e) { group("Movement feed")("warn", "Movement feed", "check failed: " + (e.message || e)); } // movement hook
  try { await (await import("./terminals.js")).checkRow(group("Terminal maps & lounges"), { majors: st.ok && Array.isArray(st.data.airports) ? st.data.monitoring?.baseline?.length >= 32 ? st.data.monitoring.baseline : st.data.airports.filter((a) => !a.trip).map((a) => a.iata) : null }); } catch (e) { group("Terminal maps & lounges")("warn", "Terminal maps & lounges", "check failed: " + (e.message || e)); } // terminals hook
  // radar hook: one MRMS frame for MSP decoded in a hidden frame (warning if NOAA can't be reached). The uptime
  // monitor (check.html?ts=…) skips it to stay inside its 30-second budget.
  if (P.has("ts")) group("Radar")("info", "Radar: MSP frame", "skipped for the uptime monitor");
  else try { await (await import("./radar/card.js")).checkRow(group("Radar")); } catch (e) { group("Radar")("warn", "Radar", "check failed: " + (e.message || e)); }

  const up = group("Uptime");
  const u = await getJson("./data/uptime.json");
  if (!u.ok) up("info", "Uptime by source", "not yet available");
  else {
    for (const [k, s] of Object.entries(u.data.sources || {})) {
      const pct = (w) => (w && w.total ? `${((100 * w.ok) / w.total).toFixed(1)}% (${w.ok}/${w.total})` : w != null && typeof w === "number" ? `${w}%` : "n/a");
      up("info", `${SOURCE_LABEL[k] || k}`, `24 h ${pct(s.d1 ?? s.pct24h)} · 7 d ${pct(s.d7 ?? s.pct7d)}`);
    }
  }

  if (RENDER) {
    const rr = group("Render test (390 px, hidden frame)");
    const idx = await getJson("./data/scenarios/index.json");
    const pages = [["index.html", "./index.html"], ...((idx.ok && idx.data.scenarios) || []).map((s) => [`?test=${s.name}`, `./index.html?test=${s.name}`])];
    for (const [label, url] of pages) {
      const r = await renderPage(url, [], label === "index.html" ? (w, doc) => consistencyChecks(rr, w, doc, " (live data)") : null);
      rr(r.ready && !r.errors.length ? "pass" : "fail", `Render ${label}`, !r.ready ? "cards never appeared" : r.errors.length ? r.errors.join(" | ") : `${r.cards} cards, no errors`);
    }
    await navChecks(group("Navigation (390 px, hidden frame)"), "./index.html"); // nav hook
    // build2b: the app UI checks run in mock mode; live only with &ui=1 (they double the run time, and the uptime
    // monitor dumps this page under a 30 s virtual-time budget)
    if (P.get("ui") === "1") await uiChecks(group("App: settings, modes, timeline (390 px, hidden frame)"), null);
  }
}

async function runMock() {
  const now = Date.now();
  if (RENDER) await uiChecks(group("App: settings, modes, timeline (thunderstorm-ground-stop, 390 px)"), "thunderstorm-ground-stop"); // build2b
  const idx = await getJson("./data/scenarios/index.json");
  const { list, error } = await airportList();
  searchChecks(group("Search"), list, error);
  const fixtureCatalog = await getJson("./data/scenarios/fixtures/airports-all.json");
  if (!fixtureCatalog.ok) { group("Scenarios")("fail","Fixture airport catalog loads",fixtureCatalog.error || `HTTP ${fixtureCatalog.status}`); return; }
  const fixtureList=decodeList(fixtureCatalog.data), byIcao=new Map(fixtureList.filter(a=>a.icao).map(a=>[a.icao,a]));
  try { await (await import("./terminals.js")).checkRow(group("Terminal maps & lounges"), {}); } catch (e) { group("Terminal maps & lounges")("fail", "Terminal maps & lounges", "check failed: " + (e.message || e)); } // terminals hook
  if (!idx.ok) { group("Scenarios")("fail", "data/scenarios/index.json loads", `HTTP ${idx.status || idx.error}`); return; }
  if (RENDER) await navChecks(group("Navigation (390 px, hidden frame)"), "./index.html?test=all-clear"); // nav hook
  if (RENDER) { try { await (await import("./map/check.js?v=1")).mapChecks(group("Map (thunderstorm-ground-stop, 390 px)"), "./index.html?test=thunderstorm-ground-stop"); } catch (e) { group("Map (thunderstorm-ground-stop, 390 px)")("fail", "Map checks load", String(e.message || e)); } } // map hook: site/map/check.js
  if (RENDER) try { await (await import("./radar/card.js")).checkRow(group("Radar card (all-clear, 390 px)"), { mock: true }); } catch (e) { group("Radar card (all-clear, 390 px)")("fail", "Radar card", "check failed: " + (e.message || e)); } // radar hook
  for (const sc of idx.data.scenarios) {
    const add = group(`Scenario: ${sc.name} — ${sc.title}`);
    const got = await getJson(`./data/scenarios/${sc.file}`);
    if (!got.ok) { add("fail", "scenario data loads", `HTTP ${got.status}`); continue; }
    const meta = got.data.scenario || {};
    const delta = now - Date.parse(meta.builtAt || got.data.generated) - (meta.lagMin || 0) * MIN;
    const data = shift(got.data, delta);
    const wxBase = `./data/scenarios/${sc.wx}`;
    const checks = await checkData(data, { now, byIcao, list:fixtureList, wxBase, wxShift: (d) => shift(d, delta), mock: true });
    const expected = new Map((sc.assert || []).filter((x) => x.t === "check").map((x) => [x.id, x.expect]));
    for (const c of checks) {
      if (expected.has(c.id)) continue; // reported by its assertion below
      if (c.id.startsWith("source:") || c.id.startsWith("wxsource:")) { if (c.status === "fail" && !expected.has("sources")) add("fail", c.label, c.detail); continue; }
      add(c.status, c.label, c.detail);
    }
    const shards = {};
    for (const L of [...new Set((sc.assert || []).filter((x) => x.icao).map((x) => x.icao[0]))]) {
      const s = await getJson(`${wxBase}${L}.json`);
      shards[L] = s.ok ? s.data.a : {};
    }
    for (const x of sc.assert || []) {
      const r = evalAssert(x, data, checks, shards);
      if (!r) continue;
      add(r.ok ? "pass" : "fail", `Expect: ${r.label}`, [r.ok ? "" : r.got, x.note && !r.ok ? `(${x.note})` : ""].filter(Boolean).join(" "));
    }
    await dataAsserts(add, { sc, data, delta, shift }); // scenarios hook: delay words, badges, ops plan, movement, model…
    await tripChecks(add, { url: `./data/scenarios/${sc.name}/trips.json`, data, shift: (d) => shift(d, delta), asserts: sc.assert, mock: true }); // trips hook
    try { await (await import("./brief.js")).checkRow(add, { url: `./data/scenarios/${sc.name}/changes.json`, shift: (d) => shift(d, delta), mock: true, data }); } catch (e) { add("fail", "Change log", "check failed: " + (e.message || e)); } // brief hook
    if (RENDER) {
      const expect = (sc.assert || []).filter((x) => x.t === "rendered");
      const r = await renderPage(`./index.html?test=${sc.name}${(sc.group === "trips" || sc.name === "hurricane-closure") ? "#trips" : ""}`, expect, async (w, doc) => { await pageAsserts(add, w, doc, sc.assert); await consistencyChecks(add, w, doc); if (["all-clear", "trip-all-clear", "trip-misconnect", "trip-weather-concerns"].includes(sc.name)) await flightBriefChecks(add, w, doc); }); // scenarios hook; one level, words = colours, no null/% everywhere
      add(r.ready && !r.errors.length ? "pass" : "fail", `Render ?test=${sc.name} at 390 px`, !r.ready ? "cards never appeared" : r.errors.length ? r.errors.join(" | ") : `${r.cards} cards, no errors`);
      for (const { x, ok } of r.results) add(ok ? "pass" : "fail", `Expect on page: ${x.selector ? `element ${x.selector}` : `text "${x.text}"`}`, ok ? "" : "not found");
    }
  }
}

// ---------- output ----------

function report() {
  const all = groups.flatMap((g) => g.rows.map((r) => ({ ...r, g: g.title })));
  const fails = all.filter((r) => r.status === "fail").length;
  const warns = all.filter((r) => r.status === "warn").length;
  const head = fails ? `CHECK FAIL ${fails}` : "CHECK PASS";
  const lines = [`${head} (${MOCK ? "scenarios" : "live"}, ${new Date().toISOString()}, ${all.length} checks, ${warns} warnings)`];
  const order = { fail: 0, warn: 1, pass: 2, info: 3 };
  for (const r of [...all].sort((a, b) => order[a.status] - order[b.status])) {
    lines.push(`${r.status.toUpperCase().padEnd(4)} [${r.g}] ${r.label}${r.detail ? " — " + r.detail : ""}`);
  }
  return { text: lines.join("\n"), fails, warns };
}

function draw() {
  const root = document.getElementById("groups");
  root.replaceChildren(...groups.map((g) => {
    const box = document.createElement("section");
    const h2 = document.createElement("h2");
    h2.textContent = g.title;
    const list = document.createElement("div");
    list.className = "group";
    for (const r of g.rows) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="st ${r.status}"></span><div><div class="lbl"></div><div class="det"></div></div>`;
      row.querySelector(".st").textContent = r.status.toUpperCase();
      row.querySelector(".lbl").textContent = r.label;
      row.querySelector(".det").textContent = r.detail;
      list.append(row);
    }
    box.append(h2, list);
    return box;
  }));
}

async function main() {
  const restoreSettings = pinSettings(); // the checks run on BASELINE settings, then the user's come back
  document.getElementById("mode").textContent = MOCK ? "Test scenarios (not live data)" : "Live data";
  const tg = document.getElementById("toggle");
  tg.textContent = MOCK ? "Check live data" : "Run scenarios";
  tg.href = MOCK ? "check.html" : "check.html?mock=1";
  try {
    if (MOCK) await runMock(); else await runLive();
  } catch (e) {
    group("Check page")("fail", "Check page ran to the end", String(e && e.stack || e));
  } finally {
    restoreSettings();
  }
  draw();
  const { text, fails, warns } = report();
  const sum = document.getElementById("summary");
  sum.textContent = fails ? `${fails} failing check${fails > 1 ? "s" : ""}` : warns ? `All checks pass (${warns} warning${warns > 1 ? "s" : ""})` : "All checks pass";
  sum.className = "summary " + (fails ? "fail" : warns ? "warn" : "pass");
  document.getElementById("result").textContent = text;
  document.getElementById("copy").onclick = async (ev) => {
    const b = ev.currentTarget;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy report"; }, 1500);
  };
}

main();
