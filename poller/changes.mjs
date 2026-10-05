#!/usr/bin/env node
// Change log (brief hook): what changed at each airport since the previous poll, in short sentences
// ("Ground stop started (storms)", "Ground stop lifted", "Risk up to High (storms)").
//
//   node poller/changes.mjs [--status f] [--movement f] [--state dir] [--out f]
//        compares site/data/status.json (+ site/data/movement.json) with <dir>/state.json (default
//        .cache/changes, copied from changes/state.json on the history branch by the workflow) and writes
//        site/data/changes.json (the last 36 h of events) plus <dir>/out/{state,events}.json
//   node poller/changes.mjs --fixtures [--out f]
//        the fixture flow: a simulated previous state (quiet, or poller/fixtures/changes-prev.json), then
//        two runs ten minutes apart over the current status so debounced changes confirm too
//   node poller/changes.mjs record <historyDir> [--from dir]
//        copies <dir>/out/state.json to <historyDir>/changes/state.json and appends this run's events to
//        <historyDir>/changes/YYYY/MM/DD.jsonl (by event time, UTC; a line already there isn't added again)
//
// Event: {t, iata, kind, from, to, sentence, cause?, prog?, obs?}. The sentence carries no time of its own (the page
// prefixes "3:10 PM" in the display zone); extensions say "until 5:30 PM" in the airport's zone and keep
// the new end in `to`. Kinds:
//   level            from/to = risk level (0–4); debounced: a change that reverts within 10 minutes is ignored.
//                    obs: true = backfilled from the observed hours the timeline shows (observedEvents)
//   program_start    to = ground_stop | ground_delay | delay (FAA NAS status, or an active ATCSCC GS/GDP)
//   program_end      from = the program type
//   program_extend   prog = type, from/to = old/new end (ISO)
//   closure_start / closure_end   full airport closures only (GA-only and runway closures don't count)
//   warning          to = the NWS event name ("Severe Thunderstorm Warning"); new warnings only
//   word             from/to = delay-word keys (site/delay.js likelihood) for the current and next two hours;
//                    debounced; only when one side is "Delays likely" or stronger, and never to or from
//                    "Delays happening now" (the program events say that)
//   plan_gs_add / plan_gs_drop    the FAA ops plan adds or drops a possible ground stop
//   movement         from/to = low | normal | high departures (movement.json, only fresh, well-covered data); debounced
// A source that failed this poll (FAA, ATCSCC, NWS) keeps its previous state, so an outage never reads as
// "lifted" or "ended".
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIN = 60e3;
const HOUR = 3600e3;
export const DEBOUNCE_MS = 10 * MIN;
export const KEEP_MS = 36 * HOUR;
export const EXTEND_MS = 10 * MIN; // an end moved later by at least this much is an extension
export const MOVE_FRESH_MS = 20 * MIN;
export const DEFAULT_DIR = join(ROOT, ".cache/changes");
export const DEFAULT_OUT = join(ROOT, "site/data/changes.json");

export const LEVEL_LABELS = ["Clear", "Minor", "Moderate", "High", "Severe"];
export const WORDS = { unlikely: "Delays unlikely", small: "Small chance of delays", usual: "Usual delays", possible: "Delays possible", likely: "Delays likely", very: "Delays very likely", now: "Delays happening now" };
const WORD_RANK = { unlikely: 0, small: 1, usual: 1, possible: 2, likely: 3, very: 4, now: 5 };
const PROG = {
  ground_stop: { start: "Ground stop started", end: "Ground stop lifted", name: "Ground stop" },
  ground_delay: { start: "Delay program started", end: "Delay program ended", name: "Delay program" },
  delay: { start: "FAA delays reported", end: "FAA delays cleared", name: "FAA delays" },
};
const MOVE = { low: "Departures running below normal", high: "Departures running above normal", normal: "Departures back to normal" };
/** Disruption category (site/cats.js) -> a short cause word. */
export const CAT_WORD = { storms: "storms", tstm: "storms", winter: "snow and ice", wind: "wind", fog: "low clouds", heat: "heat", runways: "runway closure", atc: "ATC staffing", vip: "VIP movement", space: "space launch" };

let CATS = null;
try { CATS = createRequire(import.meta.url)("../site/cats.js"); } catch { /* causes are left out */ }

// ---------- wording ----------

const fmts = new Map();
/** "5:30 PM", "6 PM" in tz. */
export function clock12(ms, tz) {
  const k = tz || "UTC";
  if (!fmts.has(k)) {
    let f;
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: k, hour: "numeric", minute: "2-digit", hour12: true }); } catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true }); }
    fmts.set(k, f);
  }
  return fmts.get(k).format(ms).replace(/[  ]/g, " ").replace(":00 ", " ");
}

/** Short cause from a program's cause label: "weather (thunderstorms)" -> "storms"; "air traffic control staffing" stays. */
export function causeWord(label) {
  const s = String(label || "").trim();
  if (!s) return null;
  const m = /\(([^)]+)\)\s*$/.exec(s);
  const w = (m ? m[1] : s).trim().toLowerCase();
  if (["", "weather", "other", "unknown", "conditions"].includes(w)) return null;
  return w.replace(/\bthunderstorms?\b/g, "storms").replace(/\bthunder\b/g, "storms").replace(ACRONYM_RE, (x) => x.toUpperCase());
}
/** Acronyms keep their capitals in lower-cased causes: "IT outage", "ATC zero", "ILS". */
export const ACRONYM_RE = /\b(it|atc|ils|vip|tfr|gps|faa|nas|tracon|artcc|rwy|twy)\b/g;

/** Cause of the current level from its reasons: a weather category word, else a program's cause in brackets. */
export function causeOfReasons(reasons, level) {
  let prog = null;
  for (const r of reasons || []) {
    const c = CATS ? CATS.reason(r) : null;
    if (c && level != null && c.level != null && c.level < level) continue;
    if (c && CAT_WORD[c.cat]) return CAT_WORD[c.cat];
    if (!prog) { const m = /—\s*[^,(]*\(([^)]+)\)/.exec(String(r)); if (m) prog = causeWord("(" + m[1] + ")"); }
  }
  return prog;
}

const withCause = (s, cause) => s + (cause ? ` (${cause})` : "");

export function levelSentence(from, to, cause) {
  const label = LEVEL_LABELS[to] || String(to);
  return to > from ? withCause(`Risk up to ${label}`, cause) : `Risk down to ${label}`;
}

// ---------- snapshot of one airport ----------

/** FAA NAS status programs by type: {type: {end, cause}} (the latest end wins). */
export function faaPrograms(a) {
  const out = {};
  for (const f of a.faa || []) {
    if (!PROG[f.type]) continue;
    const prev = out[f.type];
    const end = f.end || null;
    if (!prev || (end && (!prev.end || Date.parse(end) > Date.parse(prev.end)))) out[f.type] = { end, cause: causeWord(f.causeLabel) || (prev && prev.cause) || null };
  }
  return out;
}
/** Active ATCSCC ground stops / delay programs: {ground_stop|ground_delay: {end, cause}}. */
export function advPrograms(a) {
  const out = {};
  for (const x of a.atcscc || []) {
    if (!x.active || x.cnx || (x.type !== "GS" && x.type !== "GDP")) continue;
    const type = x.type === "GS" ? "ground_stop" : "ground_delay";
    out[type] = { end: x.end || null, cause: causeWord(x.causeLabel || x.causeText) };
  }
  return out;
}
export const fullClosure = (a) => (a.faa || []).some((f) => f.type === "closure" && (f.scope || "full") === "full" && f.active !== false);
export const warnings = (a) => [...new Set((a.alerts || []).map((x) => x.event).filter((e) => /Warning$/.test(e || "")))];
/** The ops plan's possible ground stop for this airport: {cause} or null. */
export function planGs(a) {
  const p = ((a.opsplan && a.opsplan.programs) || []).find((x) => x.status === "possible" && /GS/.test(x.program || ""));
  if (!p) return null;
  const item = ((a.opsplan && a.opsplan.items) || []).find((x) => x.kind === "program" && /possible ground stop/i.test(x.text || ""));
  const m = item && /\(([^)]+)\)\s*$/.exec(item.text);
  return { cause: m && m[1] !== "conditions" ? m[1] : null };
}
/**
 * The near-term delay word key (site/delay.js likelihood): "now" while FAA delays are in effect, else the word for
 * the highest chance in the current and next two hours (the 24-hour peak would change with the time of day alone).
 */
export function wordOf(a, likelihood) {
  if (!likelihood) return null;
  const hs = a.hours || [];
  const opt = { iata: a.iata, aviation: false };
  const h0 = hs[0] && hs[0].delay;
  if (h0 && h0.p != null) { const L0 = likelihood(h0, opt); if (L0 && L0.key === "now") return "now"; }
  let best = null;
  for (const h of hs.slice(0, 3)) if (h.delay && h.delay.p != null && (!best || h.delay.p > best.p)) best = h.delay;
  const L = best ? likelihood(best, opt) : null;
  return L && WORDS[L.key] ? L.key : null;
}
/** low | normal | high from a movement.json entry, or null when it isn't usable (stale, thin, no baseline). */
export function moveState(e, ms) {
  if (!e || e.index == null || !e.baseline || !e.baseline.depHr || !(e.coverage >= 0.6) || !e.asOf) return null;
  if (ms - Date.parse(e.asOf) > MOVE_FRESH_MS) return null;
  return e.index < 0.7 ? "low" : e.index > 1.3 ? "high" : "normal";
}

// ---------- diffing ----------

/**
 * One debounced value. slot = {v, p?: {t (ISO), v}}; cur null = unknown (kept). Returns {slot, change}:
 * a new value becomes pending and is confirmed (change {t: when first seen, from, to}) once it has held for
 * `wait`; going back to the old value before then drops it.
 */
export function debounce(slot, cur, t, wait = DEBOUNCE_MS) {
  if (cur == null) return { slot: slot || null, change: null };
  if (!slot || slot.v == null) return { slot: { v: cur }, change: null };
  if (cur === slot.v) return { slot: { v: slot.v }, change: null };
  const since = slot.p ? slot.p.t : t;
  if (Date.parse(t) - Date.parse(since) >= wait) return { slot: { v: cur }, change: { t: since, from: slot.v, to: cur } };
  return { slot: { v: slot.v, p: { t: since, v: cur } }, change: null };
}

const mergeProgs = (faa, adv) => ({ ...adv, ...faa });

/**
 * Diff one airport against its previous state. ctx: {t (ISO), ok: {faa, atcscc, nws, plan}, likelihood, movement}.
 * A missing previous state (or field) just starts it: no events.
 */
export function diffAirport(prev, a, ctx) {
  const t = ctx.t;
  const ms = Date.parse(t);
  const tz = a.tz || "UTC";
  const p = prev || {};
  const st = {};
  const ev = [];
  const push = (kind, from, to, sentence, extra = {}, at = t) => ev.push({ t: at, iata: a.iata, kind, from, to, sentence, ...extra });

  // programs (FAA NAS status + active ATCSCC), each source kept when it failed
  const curFaa = ctx.ok.faa || !p.faa ? faaPrograms(a) : p.faa;
  const curAdv = ctx.ok.atcscc || !p.adv ? advPrograms(a) : p.adv;
  st.faa = curFaa;
  st.adv = curAdv;
  const now = mergeProgs(curFaa, curAdv);
  let gsStarted = false;
  if (p.faa && p.adv) {
    const was = mergeProgs(p.faa, p.adv);
    for (const type of Object.keys(PROG)) {
      const x = was[type], y = now[type];
      if (y && !x) { push("program_start", null, type, withCause(PROG[type].start, y.cause), y.cause ? { cause: y.cause } : {}); if (type === "ground_stop") gsStarted = true; }
      else if (x && !y) push("program_end", type, null, PROG[type].end);
      else if (x && y && x.end && y.end && Date.parse(y.end) - Date.parse(x.end) >= EXTEND_MS) {
        push("program_extend", x.end, y.end, `${PROG[type].name} extended until ${clock12(Date.parse(y.end), tz)}`, { prog: type });
      }
    }
  }

  // full closures
  st.closed = ctx.ok.faa || p.closed == null ? fullClosure(a) : p.closed;
  if (p.closed != null && st.closed !== p.closed) push(st.closed ? "closure_start" : "closure_end", p.closed, st.closed, st.closed ? "Airport closed" : "Airport reopened");

  // new NWS warnings
  st.warn = ctx.ok.nws || !p.warn ? warnings(a) : p.warn;
  if (p.warn) for (const w of st.warn) if (!p.warn.includes(w)) push("warning", null, w, `${w} issued`);

  // the ops plan's possible ground stop
  const pg = ctx.ok.plan || p.plan === undefined ? planGs(a) : p.plan;
  st.plan = pg;
  if (p.plan !== undefined) {
    if (pg && !p.plan) push("plan_gs_add", null, "possible_ground_stop", withCause("FAA plans a possible ground stop", pg.cause), pg.cause ? { cause: pg.cause } : {});
    else if (!pg && p.plan && !gsStarted && !now.ground_stop) push("plan_gs_drop", "possible_ground_stop", null, "Possible ground stop no longer planned");
  }

  // debounced: level, delay word, movement
  const lv = debounce(p.lvl, a.now ? a.now.level : null, t);
  st.lvl = lv.slot;
  if (lv.change) {
    const cause = lv.change.to > lv.change.from ? causeOfReasons(a.now && a.now.reasons, lv.change.to) : null;
    push("level", lv.change.from, lv.change.to, levelSentence(lv.change.from, lv.change.to, cause), cause ? { cause } : {}, lv.change.t);
  }
  const wd = debounce(p.word, wordOf(a, ctx.likelihood), t);
  st.word = wd.slot;
  if (wd.change) {
    const { from, to } = wd.change;
    if (from !== "now" && to !== "now" && Math.max(WORD_RANK[from] ?? 0, WORD_RANK[to] ?? 0) >= WORD_RANK.likely) push("word", from, to, `${WORDS[from]} → ${WORDS[to]}`, {}, wd.change.t);
  }
  const mv = debounce(p.mv, moveState(ctx.movement && ctx.movement.airports && ctx.movement.airports[a.iata], ms), t);
  st.mv = mv.slot;
  if (mv.change) push("movement", mv.change.from, mv.change.to, MOVE[mv.change.to], {}, mv.change.t);
  return { state: st, events: ev };
}

/**
 * Observed backfill. The timeline's past hours come from that hour's reports (status airports[].observed: the worst
 * METAR or SPECI in the hour), while the level events above follow the poller's current level at each poll. So a
 * completed observed hour whose level differs from the hour before also gets a level event ({obs: true}, timed at
 * the hour's start) when no level event already falls between the start of the earlier hour and the end of the
 * later one: short spells (a gusty hour, a brief low ceiling) and gaps between polls (a missed or late build) still
 * reach the log, and the log ties out to the timeline. Each hour is looked at once (state obs = last hour done).
 */
export function observedEvents(a, prevObs, ms, recent) {
  const obs = (a.observed || []).filter((o) => o && o.level != null && Number.isFinite(Date.parse(o.t)) && Date.parse(o.t) + HOUR <= ms);
  if (!obs.length) return { obs: prevObs ?? null, events: [] };
  const done = prevObs ? Date.parse(prevObs) : -Infinity;
  // each logged change covers one observed change in the same direction (up or down) near it
  const mine = recent.filter((e) => e.iata === a.iata && e.kind === "level" && e.to !== e.from)
    .map((e) => ({ t: Date.parse(e.t), up: e.to > e.from })).sort((p, q) => p.t - q.t);
  const used = new Set();
  const events = [];
  for (let i = 1; i < obs.length; i++) {
    const x = obs[i - 1], y = obs[i];
    const ty = Date.parse(y.t), tx = Date.parse(x.t);
    if (x.level === y.level || ty - tx > HOUR) continue; // a missing hour isn't a change
    const up = y.level > x.level;
    const k = mine.findIndex((m, j) => !used.has(j) && m.up === up && m.t >= tx && m.t < ty + HOUR);
    if (k >= 0) { used.add(k); continue; }
    if (ty <= done) continue;
    const cause = up ? causeOfReasons(y.reasons, y.level) : null;
    events.push({ t: new Date(ty).toISOString(), iata: a.iata, kind: "level", from: x.level, to: y.level, sentence: levelSentence(x.level, y.level, cause), ...(cause ? { cause } : {}), obs: true });
  }
  return { obs: obs[obs.length - 1].t, events };
}

const okOf = (status) => {
  const s = status.sources || {};
  const ok = (k) => !s[k] || s[k].ok !== false;
  return { faa: ok("faa"), atcscc: ok("atcscc"), nws: ok("nws"), plan: ok("atcscc") && !!status.opsplan };
};

/**
 * One poll: previous state + status (+ movement) -> {state, events (this run's), changes (changes.json)}.
 * The state keeps the last 36 h of events in `recent`.
 */
export function computeChanges({ status, prev = null, movement = null, likelihood = null }) {
  const t = new Date(Date.parse(status.generated)).toISOString();
  const ms = Date.parse(t);
  const keep = (list) => (list || []).filter((e) => ms - Date.parse(e.t) <= KEEP_MS && Date.parse(e.t) <= ms + MIN)
    .sort((x, y) => Date.parse(y.t) - Date.parse(x.t) || x.iata.localeCompare(y.iata));
  if (prev && prev.t && Date.parse(prev.t) >= ms) {
    // already seen this status (or an older one): nothing new
    const recent = keep(prev.recent);
    return { state: { ...prev, recent }, events: [], changes: { v: 1, generated: t, since: prev.since || t, events: recent } };
  }
  const ctx = { t, ok: okOf(status), likelihood, movement };
  const airports = {};
  const events = [];
  for (const a of status.airports || []) {
    const pa = prev && prev.airports ? prev.airports[a.iata] : null;
    const r = diffAirport(pa, a, ctx);
    airports[a.iata] = r.state;
    events.push(...r.events);
  }
  // observed backfill (after this poll's own events, so a change it already logged isn't repeated)
  const known = [...((prev && prev.recent) || []), ...events];
  for (const a of status.airports || []) {
    if (!Array.isArray(a.observed)) { if (prev?.airports?.[a.iata]?.obs) airports[a.iata].obs = prev.airports[a.iata].obs; continue; }
    const o = observedEvents(a, prev?.airports?.[a.iata]?.obs ?? null, ms, known);
    if (o.obs) airports[a.iata].obs = o.obs;
    events.push(...o.events);
    known.push(...o.events);
  }
  const recent = keep([...((prev && prev.recent) || []), ...events]);
  const state = { v: 1, t, since: (prev && prev.since) || t, airports, recent };
  return { state, events, changes: { v: 1, generated: t, since: state.since, events: recent } };
}

// ---------- fixtures: a simulated previous state ----------

/** A quiet previous state for every airport: level 0, no programs, closures, warnings or planned stops, normal traffic. */
export function quietState(status, t) {
  const airports = {};
  for (const a of status.airports || []) airports[a.iata] = { faa: {}, adv: {}, closed: false, warn: [], plan: null, lvl: { v: 0 }, word: { v: "small" }, mv: { v: "normal" } };
  return { v: 1, t, since: t, airports, recent: [] };
}

/**
 * The fixture flow: quiet previous state (delay words unset below Moderate) (airports overridden by `over.airports`, extra `over.recent` events),
 * then the current status seen twice: at `over.at` (default 10 min before it) and at its own time, so
 * debounced changes confirm too. Returns changes.json.
 */
export function fixtureChanges({ status, movement = null, likelihood = null, over = null }) {
  const ms = Date.parse(status.generated);
  const at = over && over.at ? Date.parse(over.at) : ms - DEBOUNCE_MS;
  const first = Math.min(at, ms - DEBOUNCE_MS);
  const prev = quietState(status, new Date(first - 10 * MIN).toISOString());
  // an airport below Moderate keeps its usual delay word (the time of day alone isn't a change)
  for (const a of status.airports || []) if (!(a.now && a.now.level >= 2)) prev.airports[a.iata].word = null;
  for (const [k, v] of Object.entries((over && over.airports) || {})) if (prev.airports[k]) prev.airports[k] = { ...prev.airports[k], ...v };
  prev.recent = ((over && over.recent) || []).slice();
  const step1 = computeChanges({ status: { ...status, generated: new Date(first).toISOString() }, prev, movement, likelihood });
  return computeChanges({ status, prev: step1.state, movement, likelihood }).changes;
}

// ---------- files ----------

const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };

/** site/delay.js likelihood() with the model's calibration report; null if it can't be loaded. */
export async function loadLikelihood(modelDir = process.env.DELAY_MODEL_DIR ? resolve(process.env.DELAY_MODEL_DIR) : join(ROOT, "site/data/model")) {
  try {
    const D = await import(pathToFileURL(join(ROOT, "site/delay.js")).href);
    const report = await readJson(join(modelDir, "report.json"));
    if (report && D.setReport) D.setReport(report);
    return typeof D.likelihood === "function" ? D.likelihood : null;
  } catch { return null; }
}

/** Live run: never throws; on failure changes.json says so (and has no events). */
export async function runChanges({ statusFile = join(ROOT, "site/data/status.json"), movementFile = join(ROOT, "site/data/movement.json"), dir = DEFAULT_DIR, out = DEFAULT_OUT, log = console.log } = {}) {
  try {
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    const prev = await readJson(join(dir, "state.json"));
    const movement = await readJson(movementFile);
    const r = computeChanges({ status, prev: prev && prev.v === 1 ? prev : null, movement, likelihood: await loadLikelihood() });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(r.changes) + "\n");
    const od = join(dir, "out");
    await mkdir(od, { recursive: true });
    await writeFile(join(od, "state.json"), JSON.stringify(r.state) + "\n");
    await writeFile(join(od, "events.json"), JSON.stringify(r.events) + "\n");
    log(`ok   changes: ${r.events.length} new event(s), ${r.changes.events.length} in the last 36 h${prev ? "" : " (no previous state: started fresh)"}`);
    for (const e of r.events) log(`     ${e.iata} ${e.kind}: ${e.sentence}`);
    return { ok: true, ...r };
  } catch (e) {
    log(`FAIL changes: ${e && e.message ? e.message : e}`);
    try {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify({ v: 1, generated: new Date().toISOString(), error: String(e && e.message ? e.message : e), events: [] }) + "\n");
    } catch { /* nothing else to do */ }
    return { ok: false, error: e };
  }
}

export const HISTORY_CHANGES_README = `# changes/ — per-airport change log (poller/changes.mjs)

- \`state.json\`: the last status seen per airport (programs, closure, warnings, ops-plan possible ground stop, and
  debounced level / delay word / movement as {v, p?: pending {t, v}}) plus \`recent\`, the last 36 h of events.
- \`YYYY/MM/DD.jsonl\`: one line per event (UTC day of the event): {t, iata, kind, from, to, sentence, cause?, prog?}.
  Kinds: level, program_start, program_end, program_extend, closure_start, closure_end, warning, word,
  plan_gs_add, plan_gs_drop, movement. Level, word and movement changes count only once they have held for
  10 minutes (t = when first seen). The page shows the sentences with the time in front ("3:10 PM Ground stop started (storms)").
`;

/** Copies <from>/state.json to <dir>/changes/ and appends <from>/events.json by event day. */
export async function recordChanges(dir, from = join(DEFAULT_DIR, "out")) {
  const st = await readFile(join(from, "state.json"), "utf8").catch(() => null);
  const events = await readJson(join(from, "events.json"));
  if (!st || !Array.isArray(events)) return { skipped: "no change-log output from this run" };
  const cd = join(dir, "changes");
  await mkdir(cd, { recursive: true });
  await writeFile(join(cd, "state.json"), st);
  const readme = join(cd, "README.md");
  if (!(await readFile(readme, "utf8").catch(() => ""))) await writeFile(readme, HISTORY_CHANGES_README);
  const p2 = (x) => String(x).padStart(2, "0");
  let appended = 0;
  const files = new Set();
  for (const e of events) {
    const d = new Date(Date.parse(e.t));
    const file = join(cd, String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), `${p2(d.getUTCDate())}.jsonl`);
    const line = JSON.stringify(e);
    const have = await readFile(file, "utf8").catch(() => "");
    if (have.split("\n").includes(line)) continue;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line + "\n");
    appended++;
    files.add(file);
  }
  return { appended, files: [...files] };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (args[0] === "record") {
    if (!args[1]) { console.error("usage: node poller/changes.mjs record <historyDir> [--from dir]"); process.exit(2); }
    console.log("changes record: " + JSON.stringify(await recordChanges(resolve(args[1]), opt("--from") ? resolve(opt("--from")) : undefined)));
    return;
  }
  const out = opt("--out") ? resolve(opt("--out")) : DEFAULT_OUT;
  if (args.includes("--fixtures")) {
    const { expandTemplate } = await import("./lib.mjs");
    const status = JSON.parse(await readFile(opt("--status") ? resolve(opt("--status")) : join(ROOT, "site/data/status.json"), "utf8"));
    const movement = await readJson(opt("--movement") ? resolve(opt("--movement")) : join(ROOT, "site/data/movement.json"));
    const fx = process.env.FIXTURES_DIR ? resolve(process.env.FIXTURES_DIR) : join(HERE, "fixtures");
    const text = await readFile(join(fx, "changes-prev.json"), "utf8").catch(() => null);
    const over = text ? JSON.parse(expandTemplate(text, new Date(Date.parse(status.generated)))) : null;
    const ch = fixtureChanges({ status, movement, likelihood: await loadLikelihood(), over });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(ch) + "\n");
    console.log(`wrote ${out}: ${ch.events.length} events (fixture flow)`);
    return;
  }
  const r = await runChanges({
    statusFile: opt("--status") ? resolve(opt("--status")) : undefined,
    movementFile: opt("--movement") ? resolve(opt("--movement")) : undefined,
    dir: opt("--state") ? resolve(opt("--state")) : undefined,
    out,
  });
  if (!r.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
