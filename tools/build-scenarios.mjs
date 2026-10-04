#!/usr/bin/env node
// Builds the test scenarios: runs the real poller in fixture mode once per scenario and writes
//   site/data/scenarios/<name>.json           status.json for the scenario (+ a "scenario" block)
//   site/data/scenarios/<name>/wx/*.json      global METAR/TAF shards for the scenario
//   site/data/scenarios/<name>/trips.json     calendar trips for the scenario (from its trips.ics, if any)
//   site/data/scenarios/<name>/movement.json  ADS-B movement for the scenario (README "Movement" shape)
//   site/data/scenarios/<name>/config.json    the page config the scenario runs with ({liveUrl})
//   site/data/scenarios/<name>/changes.json   the change log (brief hook: poller/changes.mjs fixture flow; the
//                                             scenario's changes-prev.json, if any, sets the simulated previous state)
//   site/data/scenarios/index.json            every scenario's title, group, description and assertions
// Usage: node tools/build-scenarios.mjs [name ...]
//
// Fixture sets live in poller/scenarios/: _base/ is a complete, quiet fixture set (same file
// layout as poller/fixtures/, plus movement.json, the movement seed); each scenario dir holds
// scenario.json plus only the files that differ. Merging: metar.json and taf.json are merged
// record-by-record on icaoId, nws.json and movement.json key-by-key; any other file replaces the
// base file. Fixture files are templates ({{+90}} etc., poller/lib.mjs expandTemplate) plus two
// tokens expanded here: {{hhmm+90}} "HHMM" UTC (ops plan "UNTIL 2130") and {{notam+90}}
// "YYMMDDHHMM" UTC (NOTAM effective times).
//
// scenario.json:
//   title, blurb (one line for the menu), description, group (menu group, a GROUPS key),
//   assert [...] (check.html?mock=1 runs them; README "Test scenarios")
//   omit: [files]         removes files so that source fails (e.g. FAA down)
//   lagMin                makes the data that many minutes old when the page loads it
//   at: ISO time          the poller's "now" for this build. Pinned so the delay model (which uses the
//                         local hour, weekday and month) scores the same on every rebuild; the page
//                         (site/testmode.js) shifts every time in the output so it always looks current
//   model: "fallback"     score delays without model.json, as before the first training run
//   config: {liveUrl}     the page config for this scenario (default {"liveUrl": null}); a liveUrl makes
//                         the page run its live-relay path against that URL (site/testmode.js)
//   delayOverride: [{iata, from, to, p, why}]  only when the real scorer can't produce the intended
//                         words: sets hours[from..to].delay.p after scoring; the banner says so
import { readFile, writeFile, mkdir, readdir, rm, mkdtemp, cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCN = join(ROOT, "poller/scenarios");
const OUT = join(ROOT, "site/data/scenarios");
const MODEL = join(ROOT, "site/data/model");
/** Menu groups (site/testmode.js lists the scenarios under these headings, in this order). */
export const GROUPS = { delays: "Delays & programs", weather: "Weather", nonweather: "Non-weather", trips: "Trips", system: "System health" };
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Merge a scenario file over the base file text. Returns the merged text. */
export function mergeFile(name, baseText, overText) {
  if (baseText == null) return overText;
  // Templates hold unquoted {{..}} tokens, so quote them for JSON.parse and unquote after.
  const protect = (s) => s.replace(/(:\s*)(\{\{[^}]+\}\})/g, '$1"@@$2@@"');
  const restore = (s) => s.replace(/"@@(\{\{[^}]+\}\})@@"/g, "$1");
  if (name === "metar.json" || name === "taf.json") {
    const base = JSON.parse(protect(baseText));
    const over = JSON.parse(protect(overText));
    const ids = new Set(over.map((r) => r.icaoId));
    const merged = [...base.filter((r) => !ids.has(r.icaoId)), ...over];
    return restore("[\n" + merged.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n]\n");
  }
  if (name === "nws.json" || name === "movement.json") {
    return JSON.stringify({ ...JSON.parse(baseText), ...JSON.parse(overText) }, null, 1) + "\n";
  }
  return overText;
}

/** Tokens the poller doesn't know: {{hhmm+N}} "HHMM" UTC and {{notam+N}} "YYMMDDHHMM" UTC, N minutes from now. */
export function expandExtra(text, now) {
  const p2 = (x) => String(x).padStart(2, "0");
  return text.replace(/\{\{(hhmm|notam)([+-]\d+)\}\}/g, (_, kind, n) => {
    const d = new Date(+now + Number(n) * MIN);
    const hm = p2(d.getUTCHours()) + p2(d.getUTCMinutes());
    return kind === "hhmm" ? hm : p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + hm;
  });
}

async function readMaybe(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

export async function scenarioNames() {
  return (await readdir(SCN, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name).sort();
}

/** A copy of the model folder without model.json: the scorer then uses fallback.json (status.json delayModel.basis "fallback"). */
async function fallbackModelDir(tmp) {
  const dir = join(tmp, "model");
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(MODEL, { withFileTypes: true })) {
    if (f.name !== "model.json") await cp(join(MODEL, f.name), join(dir, f.name), { recursive: true });
  }
  return dir;
}

/** Applies a scenario's documented delayOverride after scoring. Returns what was changed (for the banner). */
export function applyDelayOverride(status, list) {
  const done = [];
  for (const o of list || []) {
    const a = (status.airports || []).find((x) => x.iata === o.iata);
    if (!a) throw new Error(`delayOverride: no airport ${o.iata}`);
    const from = o.from ?? 0;
    const to = Math.min(o.to ?? from, a.hours.length - 1);
    for (let i = from; i <= to; i++) {
      const d = a.hours[i].delay;
      if (!d) throw new Error(`delayOverride: ${o.iata} hour ${i} has no delay numbers`);
      d.p = o.p;
      d.scenarioOverride = true;
    }
    done.push({ iata: o.iata, from, to, p: o.p, why: o.why || "" });
  }
  return done;
}

async function buildOne(name) {
  const dir = join(SCN, name);
  const meta = JSON.parse(await readFile(join(dir, "scenario.json"), "utf8"));
  if (meta.group && !GROUPS[meta.group]) throw new Error(`${name}: unknown group "${meta.group}" (have: ${Object.keys(GROUPS).join(", ")})`);
  const at = meta.at ? new Date(meta.at) : new Date();
  if (!Number.isFinite(+at)) throw new Error(`${name}: bad "at" time ${meta.at}`);
  const tmp = await mkdtemp(join(tmpdir(), `awx-scn-${name}-`));
  const fx = join(tmp, "fixtures");
  await mkdir(fx);
  const baseFiles = await readdir(join(SCN, "_base"));
  const overFiles = (await readdir(dir)).filter((f) => f !== "scenario.json");
  let seed = null;
  for (const f of new Set([...baseFiles, ...overFiles])) {
    if ((meta.omit || []).includes(f)) continue;
    const base = await readMaybe(join(SCN, "_base", f));
    const over = await readMaybe(join(dir, f));
    const text = expandExtra(over != null ? mergeFile(f, base, over) : base, at);
    if (f === "movement.json") { seed = JSON.parse(text); continue; } // the movement seed, not a poller source
    await writeFile(join(fx, f), text);
  }
  const out = join(OUT, `${name}.json`);
  const sub = join(OUT, name);
  await rm(sub, { recursive: true, force: true });
  await mkdir(sub, { recursive: true });
  const env = {
    ...process.env, FIXTURES_DIR: fx, GLOBAL_WX_OUT: join(sub, "wx"),
    TRIPS_OUT: join(sub, "trips.json"), FLIGHTY_ICS_URL: "", // trips hook: <name>/trips.json (from the scenario's trips.ics)
    DELAY_MODEL_DIR: meta.model === "fallback" ? await fallbackModelDir(tmp) : MODEL,
  };
  const job = { out, at: at.toISOString(), seed, movementOut: join(sub, "movement.json"), changesOut: join(sub, "changes.json") }; // brief hook: changesOut
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", JSON.stringify(job)], { env, encoding: "utf8" });
  await rm(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`${name}: poller exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  const status = JSON.parse(await readFile(out, "utf8"));
  const override = meta.delayOverride ? applyDelayOverride(status, meta.delayOverride) : null;
  status.scenario = { name, title: meta.title, builtAt: status.generated, lagMin: meta.lagMin || 0, ...(override ? { delayOverride: override } : {}) };
  await writeFile(out, JSON.stringify(status) + "\n");
  await writeFile(join(sub, "config.json"), JSON.stringify({ liveUrl: null, ...(meta.config || {}) }) + "\n");
  const lines = r.stdout.trim().split("\n");
  console.log(`${name}: ${lines.filter((x) => /^wrote /.test(x)).pop() || lines[lines.length - 1]}`);
  for (const l of lines.filter((x) => /^FAIL|^global:|movement:|changes:/.test(x))) console.log(`  ${l}`); // brief hook: changes
  return {
    name, title: meta.title, group: meta.group || null, blurb: meta.blurb || "", description: meta.description || "", file: `${name}.json`, wx: `${name}/wx/`,
    lagMin: meta.lagMin || 0, live: !!(meta.config && meta.config.liveUrl), model: meta.model || null,
    delayOverride: !!override, assert: meta.assert || [],
  };
}

export async function buildScenarios(names) {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT,"fixtures"),{recursive:true});
  await cp(join(HERE,"fixtures/airports-all.json"),join(OUT,"fixtures/airports-all.json"));
  const all = await scenarioNames();
  const pick = names && names.length ? names : all;
  for (const n of pick) if (!all.includes(n)) throw new Error(`unknown scenario ${n} (have: ${all.join(", ")})`);
  const prev = JSON.parse((await readMaybe(join(OUT, "index.json"))) || '{"scenarios":[]}');
  const byName = new Map(prev.scenarios.map((s) => [s.name, s]));
  for (const n of pick) byName.set(n, await buildOne(n));
  const scenarios = all.filter((n) => byName.has(n)).map((n) => byName.get(n));
  // site/testmode.js has to know synchronously which scenarios run the live-relay path
  const lp = /LIVE_PATH = \{([^}]*)\}/.exec(await readFile(join(ROOT, "site/testmode.js"), "utf8"));
  const listed = lp ? [...lp[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]).sort().join(",") : "";
  const wanted = scenarios.filter((s) => s.live).map((s) => s.name).sort().join(",");
  if (listed !== wanted) throw new Error(`site/testmode.js LIVE_PATH lists [${listed}] but the scenarios with config.liveUrl are [${wanted}]`);
  await writeFile(join(OUT, "index.json"), JSON.stringify({ generated: new Date().toISOString(), groups: GROUPS, scenarios }, null, 1) + "\n");
  console.log(`wrote ${scenarios.length} scenarios to ${OUT}`);
  return scenarios;
}

// ---------- child process: one poller run at the scenario's "now" ----------

/**
 * Movement for a scenario, built the way poller/movement.mjs fixtureRun() builds its fixture (the
 * ORD-prev/ORD-now snapshots moved to every airport plus a seeded history) but from the scenario's
 * seed, then scored by the real computeMovement(). Seed: {days, elev: {IATA: ft}, baseDep: {default,
 * IATA}, mult: {IATA: departures now ÷ normal}, multArr: {IATA: arrivals now ÷ normal}, empty: [IATA]
 * (no aircraft seen, e.g. a closed airport), learning: [IATA], airline: {CODE: {hubs: {IATA: normal dep/hr}, now: share of normal in the last 2 hours}}}.
 */
export async function movementRun(airports, nowMs, seed) {
  const M = await import(pathToFileURL(join(ROOT, "poller/movement.mjs")).href);
  const FIX = join(ROOT, "poller/fixtures/movement");
  const nowJ = JSON.parse(await readFile(join(FIX, "ORD-now.json"), "utf8"));
  const prevJ = JSON.parse(await readFile(join(FIX, "ORD-prev.json"), "utf8"));
  const ord = airports.find((a) => a.iata === "ORD");
  const from = { lat: ord.lat, lon: ord.lon, elev: seed.elev.ORD };
  const elev = Object.fromEntries(airports.map((a) => [a.iata, [seed.elev[a.iata] ?? 0, "fixture"]]));
  const hourKey = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13) + "Z";
  const since = new Date(nowMs - (seed.days ?? 21) * DAY).toISOString().slice(0, 16) + "Z";
  const st = { since, ap: {} };
  const base = { since, ap: {} };
  const curHour = Math.floor(nowMs / HOUR) * HOUR;
  const mult = seed.mult || {};
  const multArr = seed.multArr || {};
  const airline = seed.airline || {};
  const empty = new Set(seed.empty || []);
  const snap = (j, iata) => (empty.has(iata) ? { ...j, ac: [] } : j);
  const alAt = (iata, now) => {
    const o = {};
    for (const [code, sp] of Object.entries(airline)) {
      const b = sp.hubs && sp.hubs[iata];
      if (b != null) o[code] = Math.round(b * (now ? sp.now ?? 1 : 1));
    }
    return o;
  };
  for (const a of airports) {
    const to = { lat: a.lat, lon: a.lon, elev: elev[a.iata][0] };
    const { state } = M.stepAirport({ recent: [], hrs: [] }, M.parseFeed(M.translateFixture(snap(prevJ, a.iata), from, to)), to, nowMs - 5 * MIN);
    const dep0 = seed.baseDep[a.iata] ?? seed.baseDep.default;
    const md = mult[a.iata] ?? 1;
    const ma = multArr[a.iata] ?? md;
    // 10 synthetic earlier snapshots; the two fixture snapshots add ~5 of each
    const nd = Math.max(0, Math.round(dep0 * md) - 5);
    const na = Math.max(0, Math.round(dep0 * ma) - 5);
    const share = (n, i) => Math.floor(n / 10) + (i < n % 10 ? 1 : 0);
    const synth = [];
    for (let i = 0; i < 10; i++) {
      const t = Math.floor((nowMs - (55 - 5 * i) * MIN) / 1000);
      synth.push([t, Array.from({ length: share(nd, i) }, (_, j) => `s${i}x${j}d`), Array.from({ length: share(na, i) }, (_, j) => `s${i}x${j}a`), {}]);
    }
    state.recent = [...synth, ...state.recent.map((x) => [x[0], [], [], {}])];
    state.hrs = [2, 1].map((k) => {
      const ms = curHour - k * HOUR;
      return { h: hourKey(ms), how: M.hourOfWeek(ms, a.tz), n: 12, cov: 1, dep: Math.round(dep0 * md), arr: Math.round(dep0 * ma), al: alAt(a.iata, true) };
    });
    state.last = hourKey(curHour - HOUR); // the finished hours are already in hrs
    st.ap[a.iata] = state;
    if ((seed.learning || []).includes(a.iata)) continue;
    const b = {};
    for (let how = 0; how < 168; how++) {
      b[how] = [3, 2, 1].map((w) => [dep0 + w - 2, dep0 + w - 2, alAt(a.iata, false), new Date(nowMs - w * 7 * DAY).toISOString().slice(0, 10)]);
    }
    base.ap[a.iata] = b;
  }
  const snaps = {};
  for (const a of airports) {
    snaps[a.iata] = { list: M.parseFeed(M.translateFixture(snap(nowJ, a.iata), from, { lat: a.lat, lon: a.lon, elev: elev[a.iata][0] })), src: "adsbfi", at: new Date(nowMs).toISOString() };
  }
  const col = { snaps, errors: {}, attempted: airports.length, covered: airports.length, next: 0, ms: 0, outOfTime: false, used: { adsbfi: airports.length } };
  return M.computeMovement({ airports, col, state: st, baseline: base, bts: null, nowMs, elev }).movement;
}

async function child(job) {
  const { run } = await import(pathToFileURL(join(ROOT, "poller/poll.mjs")).href);
  const { runGlobal } = await import(pathToFileURL(join(ROOT, "poller/global.mjs")).href);
  const now = new Date(job.at);
  const { status, okCount, total, out } = await run({ fixtures: true, out: job.out, now, rawDir: null });
  await runGlobal({ fixtures: true, now, rawDir: null }); // build2a hook: <name>/wx/ (GLOBAL_WX_OUT)
  for (const [n, s] of Object.entries(status.sources)) console.log(`${s.ok ? "ok  " : "FAIL"} ${n}${s.error ? ": " + s.error : ""}`);
  if (job.seed) {
    const airports = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
    const m = await movementRun(airports, +now, job.seed);
    await writeFile(job.movementOut, JSON.stringify(m) + "\n");
    const off = Object.entries(m.airports).filter(([, e]) => e.index != null && (e.index < 0.7 || e.index > 1.3)).map(([k, e]) => `${k} ${e.index}`);
    console.log(`ok   movement: ${Object.keys(m.airports).length} airports${off.length ? ", off normal: " + off.join(" ") : ""}${m.airlineAlerts.length ? `; airline alerts: ${m.airlineAlerts.map((x) => x.name).join(", ")}` : ""}`);
  }
  // brief hook: <name>/changes.json from a simulated previous state (poller/changes.mjs fixtureChanges; the
  // scenario's optional changes-prev.json overrides airports, the first run's time and earlier events)
  {
    const C = await import(pathToFileURL(join(ROOT, "poller/changes.mjs")).href);
    const { expandTemplate } = await import(pathToFileURL(join(ROOT, "poller/lib.mjs")).href);
    const prevText = await readMaybe(join(process.env.FIXTURES_DIR, "changes-prev.json"));
    const movement = job.seed ? JSON.parse(await readFile(job.movementOut, "utf8")) : null;
    const ch = C.fixtureChanges({ status, movement, likelihood: await C.loadLikelihood(), over: prevText ? JSON.parse(expandTemplate(prevText, now)) : null });
    await writeFile(job.changesOut, JSON.stringify(ch) + "\n");
    console.log(`ok   changes: ${ch.events.length} events`);
  }
  const top = status.airports.filter((a) => a.peak.level >= 3).length;
  console.log(`wrote ${out}: ${status.airports.length} airports, ${top} at High/Severe peak, ${okCount}/${total} sources ok`);
  if (okCount === 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ci = process.argv.indexOf("--child");
  if (ci >= 0) child(JSON.parse(process.argv[ci + 1])).catch((e) => { console.error(e.stack || e); process.exit(1); });
  else buildScenarios(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1); });
}
