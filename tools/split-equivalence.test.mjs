// Summary / detail split (site/split.js, README "status.json"): "Map and details must agree". For every airport in
// the committed sample, every scenario and (when present) the local copy of the live build site/data/status.json,
// everything the home list, map, national strip, At risk and trips compute from the SUMMARY airport must equal what
// they compute from the FULL airport: outlook.js summary / evaluate (now and every hour) / levelAt / windowFor /
// health, cats.js restLayout and filterHour, delay.js words (likelihood, notable, routineOutlook, outlookHour) and
// trip-risk.js tripStatus for the scenarios' trips. The summary + the airport's detail file must restore the full
// airport exactly (what the sheet reads), and the poller's live run writes those files.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);
const S = req("../site/split.js");
const O = req("../site/outlook.js");
const C = req("../site/cats.js");
globalThis.window ??= {}; // delay.js only touches the DOM when window.document exists
globalThis.AWXOutlook = O; // delay.js quiet hours
const D = await import("../site/delay.js");
const T = await import("../site/trip-risk.js");
const REPORT = JSON.parse(readFileSync(join(ROOT, "site/data/model/report.json"), "utf8"));
D.setReport(REPORT);

const HOUR = 3600e3;
const SCN = join(ROOT, "site/data/scenarios");
const files = [
  ["sample", join(ROOT, "site/data/sample.json")],
  ...readdirSync(SCN).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => [f.replace(/\.json$/, ""), join(SCN, f)]),
];
const LIVE = join(ROOT, "site/data/status.json"); // git-ignored copy of a live build, when present
if (existsSync(LIVE)) files.push(["live status.json", LIVE]);

const deep = (x) => JSON.parse(JSON.stringify(x)); // as served (undefined fields dropped)
const tOf = (h) => (h && typeof h === "object" ? h.t ?? null : h ?? null);
/** Strip only the hour objects summary/evaluate hand back (their full fields differ by design) to their time. */
function normSummary(sm) {
  const r = { ...sm, nowHour: tOf(sm.nowHour), peakHour: tOf(sm.peakHour), byT: [...sm.byT], current: normEval(sm.current) };
  return r;
}
function normEval(o) {
  return o && { ...o, window: o.window ? { ...o.window, hour: tOf(o.window.hour) } : o.window };
}
/** Delay numbers as the summary carries them (the explanation fields are detail-only by design). */
const slimDelay = (d) => (d && typeof d === "object" ? S.slimHour({ delay: d }, true).delay : d);
const normTrip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === "delay" ? slimDelay(v) : v)));

function noticesDown(data) {
  const t = data.noticeSources && data.noticeSources.tfr;
  return !!t && !t.ok;
}

function compareAirport(name, data, F, Sl, nows) {
  const where = `${name} ${F.iata}`;
  const opts0 = {
    tz: F.tz, generated: data.generated, sources: data.sources, sample: false, offline: false, noticesDown: noticesDown(data), hidden: 0,
    plain: (r) => r, words: (d) => D.likelihood(d, { iata: F.iata, aviation: false }), notable: D.notable,
  };
  let checks = 0;
  const F0 = F, Sl0 = Sl;
  for (const now of nows) {
    const opts = { ...opts0, now };
    const eq = (a, b, what) => { assert.deepStrictEqual(a, b, `${where} @${new Date(now).toISOString()} ${what}`); checks++; };
    // README "The observed next hour": the page swaps in obsNext once hour 1 is current (app.js mergeLive); the
    // summary must carry it so both sides swap alike, and the swapped hour restores from the detail's obsNext
    F = O.withObsHour(F0, now); Sl = O.withObsHour(Sl0, now);
    eq(Sl !== Sl0, F !== F0, "observed hour swapped alike");
    if (Sl !== Sl0) {
      const { hubResearch: _h, ...want } = deep(F);
      eq(S.restore(Sl, deep(F0)), want, "summary + detail = the full airport after the swap");
      if (Sl.hours.some((h) => h.obs)) obsSwaps++;
    }
    eq(O.health(Sl, opts), O.health(F, opts), "health");
    const sF = O.summary(F, opts), sS = O.summary(Sl, opts);
    eq(normSummary(sS), normSummary(sF), "summary");
    eq(C.restLayout(sS.nowLevel, sS.level, sS.later), C.restLayout(sF.nowLevel, sF.level, sF.later), "restLayout");
    eq(normEval(O.evaluate(Sl, { ...opts, at: now })), normEval(O.evaluate(F, { ...opts, at: now })), "evaluate now");
    const after = O.windowFor(Sl, opts, now), afterF = O.windowFor(F, opts, now);
    eq(after && { ...after, hour: tOf(after.hour) }, afterF && { ...afterF, hour: tOf(afterF.hour) }, "windowFor");
    F.hours.forEach((hF, i) => {
      const hS = Sl.hours[i];
      const at = Math.max(Date.parse(hF.t), now);
      eq(normEval(O.evaluate(Sl, { ...opts, at })), normEval(O.evaluate(F, { ...opts, at })), `evaluate ${hF.t}`);
      eq(O.levelAt(Sl, hS, opts, at, now), O.levelAt(F, hF, opts, at, now), `levelAt ${hF.t}`);
      const sc = (x) => { const r = O.score(x, opts); return { ...r }; };
      eq(sc(hS), sc(hF), `score ${hF.t}`);
      const LS = hS.delay ? D.likelihood(hS.delay, { iata: F.iata, aviation: false }) : null;
      const LF = hF.delay ? D.likelihood(hF.delay, { iata: F.iata, aviation: false }) : null;
      eq(LS, LF, `delay words ${hF.t}`);
      eq(D.notable(hS.delay, hS.level, LS), D.notable(hF.delay, hF.level, LF), `notable ${hF.t}`);
    });
    eq(D.routineOutlook(Sl, now), D.routineOutlook(F, now), "routineOutlook");
    eq(D.outlookHour(Sl, now), D.outlookHour(F, now), "outlookHour");
  }
  F = F0; Sl = Sl0;
  // Settings → Show these disruptions: hidden categories recompute each hour from its reasons (app.js view)
  const hide = { fog: true, storms: true, wind: true };
  const filtered = (a) => {
    const fh = (h) => ({ ...h, ...C.filterHour(h, hide), dropped: undefined });
    return { ...a, hours: a.hours.map(fh), observed: (a.observed || []).map(fh) };
  };
  const vF = filtered(F), vS = filtered(Sl);
  vF.hours.forEach((h, i) => { assert.equal(vS.hours[i].level, h.level, `${where} hidden ${h.t}`); assert.deepEqual(vS.hours[i].reasons, h.reasons); });
  vF.observed.forEach((h, i) => { assert.equal(vS.observed[i].level, h.level, `${where} hidden observed ${h.t}`); assert.deepEqual(vS.observed[i].reasons, h.reasons); });
  const opts = { ...opts0, now: nows[0], hidden: 1 };
  assert.deepStrictEqual(normSummary(O.summary(vS, opts)), normSummary(O.summary(vF, opts)), `${where} summary with hidden categories`);
  // the card's past hours: observed levels and reasons (timeline, map slider)
  assert.deepStrictEqual((Sl.observed || []).map((h) => [h.t, h.level, h.reasons]), (F.observed || []).map((h) => [h.t, h.level, h.reasons]), `${where} observed`);
  for (const now of nows) for (const h of F.hours) if (O.score(h, { ...opts0, now }).raised) raisedHours++;
  return checks + 2;
}
let raisedHours = 0; // hours whose level the delay words raise: the comparisons above must cover some
let obsSwaps = 0; // airport evaluations whose current hour was the observed hour 1: the comparisons above must cover some

for (const [name, file] of files) {
  test(`split equivalence: ${name}`, () => {
    const full = deep(JSON.parse(readFileSync(file, "utf8")));
    const { summary, details } = S.split(full);
    assert.equal(summary.split, S.VERSION);
    assert.equal(summary.airports.length, full.airports.length);
    assert.ok(!JSON.stringify(summary).includes('"hubResearch"'), "no research fields in the summary");
    const g = Date.parse(full.generated);
    const nows = [g, g + 55 * 60e3, g + 3 * HOUR]; // the build's time, across the hour, and later (nowHour moves on)
    let checks = 0;
    for (const F of full.airports) {
      const Sl = summary.airports.find((x) => x.iata === F.iata);
      const d = deep(details[F.iata]);
      assert.equal(d.generated, full.generated, `${F.iata} detail carries the summary's generated`);
      assert.ok(!("hubResearch" in d.airport), `${F.iata} detail without research fields`);
      const { hubResearch, ...want } = F;
      assert.deepStrictEqual(S.restore(Sl, d.airport), want, `${name} ${F.iata}: summary + detail = the full airport`);
      checks += compareAirport(name, full, F, Sl, nows);
    }
    // trips (README "Trips"): the scenario's trips scored against the summary airports = against the full ones
    const tripsFile = join(SCN, name, "trips.json");
    if (existsSync(tripsFile)) {
      const trips = JSON.parse(readFileSync(tripsFile, "utf8")).trips || [];
      const byF = new Map(full.airports.map((a) => [a.iata, a])), byS = new Map(summary.airports.map((a) => [a.iata, a]));
      for (const trip of trips) {
        for (const now of nows) {
          const run = (by) => T.tripStatus(trip, (c) => (by.get(c) ? O.withObsHour(by.get(c), now) : null), { now, words: (dl, iata) => D.likelihood(dl, { iata, aviation: false })?.word,
            health: (a) => O.health(a, { now, generated: full.generated, sources: full.sources }) });
          assert.deepStrictEqual(normTrip(run(byS)), normTrip(run(byF)), `${name} trip ${trip.id} @${new Date(now).toISOString()}`);
          checks++;
        }
      }
    }
    assert.ok(checks > full.airports.length, `${checks} comparisons`);
  });
}

test("split equivalence covered hours raised by delay words", (t) => {
  t.diagnostic(`${raisedHours} hour evaluations raised by delay words`);
  assert.ok(raisedHours > 0, `${raisedHours} raised hours`);
});

test("split equivalence covered the observed next hour", (t) => {
  t.diagnostic(`${obsSwaps} airport evaluations on the observed hour 1`);
  assert.ok(obsSwaps > 0, `${obsSwaps} swaps`);
});

test("split: obsNext stays in the summary like the first hour, and a swapped hour never takes the forecast's conditions", () => {
  const full = deep(JSON.parse(readFileSync(join(SCN, "metar-clears-forecast-fog.json"), "utf8")));
  const { summary, details } = S.split(full);
  const F = full.airports.find((a) => a.iata === "SFO"), Sl = summary.airports.find((a) => a.iata === "SFO");
  assert.ok(F.obsNext && Sl.obsNext, "obsNext in both files");
  assert.equal(Sl.obsNext.vis, F.obsNext.vis, "conditions kept");
  assert.ok(S.DELAY_DETAIL.every((k) => !(k in Sl.obsNext.delay)), "delay explanation detail-only");
  const now = Date.parse(full.generated) + 6 * 60e3;
  const v = O.withObsHour(Sl, now);
  const r = S.restore(v, deep(details.SFO.airport));
  assert.equal(r.hours[1].obs, true);
  assert.equal(r.hours[1].cig, undefined, "no ceiling from the forecast hour at that time");
  assert.equal(r.hours[1].vis, 10);
  assert.deepEqual(r.hours[1].delay, F.obsNext.delay, "delay explanation restored from obsNext");
});

test("split: smaller summary, details restore what was removed, mismatched polls keep the summary's own fields", () => {
  const full = deep(JSON.parse(readFileSync(join(ROOT, "site/data/sample.json"), "utf8")));
  const { summary, details } = S.split(full);
  const a = full.airports.find((x) => x.lamp && x.taf);
  const s = summary.airports.find((x) => x.iata === a.iata);
  assert.equal(s.lamp, undefined);
  assert.deepEqual(Object.keys(s.taf), ["issued"]);
  assert.ok(s.hours.slice(1).every((h) => S.COND.every((k) => !(k in h))), "conditions only in the first hour");
  assert.ok(s.hours.every((h) => !h.delay || S.DELAY_DETAIL.every((k) => !(k in h.delay))));
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length);
  // another poll's detail: hour times that match get their conditions, the summary's levels and reasons win
  const other = deep(details[a.iata].airport);
  other.hours = other.hours.map((h, i) => ({ ...h, level: 4, reasons: ["Other poll"], t: i === 1 ? new Date(Date.parse(h.t) + HOUR / 2).toISOString() : h.t }));
  const r = S.restore(s, other);
  assert.deepEqual(r.hours.map((h) => h.level), s.hours.map((h) => h.level));
  assert.equal(r.hours[1].wdir, undefined, "an hour the other poll doesn't have at that time keeps no conditions");
  assert.equal(r.lamp, other.lamp);
  assert.equal(S.restore(s, null), s);
  // a new airport field stays in the summary by default
  const { summary: s2 } = S.split({ ...full, airports: [{ ...a, futureField: { x: 1 } }] });
  assert.deepEqual(s2.airports[0].futureField, { x: 1 });
});

test("split: the live poll writes summary.json and one detail file per airport (not for --out runs)", async () => {
  const { run } = await import("../poller/poll.mjs");
  const dir = await mkdtemp(join(tmpdir(), "awx-split-"));
  try {
    const now = new Date("2026-10-06T16:07:00Z");
    await run({ fixtures: true, out: join(dir, "status.json"), now, rawDir: null, split: true });
    const full = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
    const names = (await readdir(join(dir, "airport"))).sort();
    assert.deepEqual(names, full.airports.map((a) => a.iata + ".json").sort());
    assert.equal(summary.generated, full.generated);
    for (const a of full.airports) {
      const d = JSON.parse(await readFile(join(dir, "airport", a.iata + ".json"), "utf8"));
      assert.equal(d.generated, full.generated);
      const { hubResearch, ...want } = a;
      assert.deepStrictEqual(S.restore(summary.airports.find((x) => x.iata === a.iata), d.airport), want);
    }
    assert.ok(full.airports.some((a) => a.hubResearch), "history still gets hubResearch from the full status.json");
    const dir2 = await mkdtemp(join(tmpdir(), "awx-split-"));
    try {
      await run({ fixtures: true, out: join(dir2, "sample.json"), now, rawDir: null });
      assert.ok(!existsSync(join(dir2, "summary.json")) && !existsSync(join(dir2, "airport")), "--out runs write only the full file");
    } finally { await rm(dir2, { recursive: true, force: true }); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
