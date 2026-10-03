import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFeed, classify, transitions, stepAirport, scaleRate, rolling, baselineFor, btsFromModel, loadBts, describe,
  finalizeHours, airlineAlerts, collect, computeMovement, fixtureRun, elevations, qnhCorrections, recordMovement,
  hourOfWeek, unpackAc, airlineOf, AIRLINES, FEEDS,
} from "./movement.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "movement");
const ORD = { lat: 41.9742, lon: -87.9073, elev: 663 };
const MIN = 60e3;
const HOUR = 3600e3;
const load = async (f) => JSON.parse(await readFile(join(FIX, f), "utf8"));
const NOW = Date.parse("2026-10-05T15:02:00Z"); // Monday 10:02 CDT

test("parseFeed keeps real aircraft and drops TIS-B, vehicles, stale and position-less ones", async () => {
  const list = parseFeed(await load("ORD-now.json"));
  const hexes = list.map((a) => a.hex);
  assert.ok(!hexes.some((h) => h.startsWith("~")), "non-ICAO address dropped");
  assert.ok(!hexes.includes("a1b00c"), "C1 surface vehicle dropped");
  assert.ok(!hexes.includes("a1b00d"), "seen 120 s ago dropped");
  const u = list.find((a) => a.hex === "a1b001");
  assert.equal(u.cs, "UAL1234");
  assert.equal(u.gnd, true);
  assert.equal(u.alt, null);
  assert.equal(list.find((a) => a.hex === "a1b008").trate, 1.8);
  // legacy shape (adsb.fi v2 lat/lon) and empty replies
  assert.equal(parseFeed({ aircraft: [{ hex: "ABC123", lat: 1, lon: 2, alt_baro: 5000, geom_rate: -640 }] })[0].rate, -640);
  assert.equal(parseFeed({ aircraft: [{ hex: "ABC123", lat: 1, lon: 2 }] })[0].hex, "abc123");
  assert.deepEqual(parseFeed({ ac: null, msg: "No error" }), []);
  assert.deepEqual(parseFeed({ ac: [{ hex: "abc", category: "B6", lat: 1, lon: 1 }, { hex: "abd" }] }), []);
  assert.throws(() => parseFeed({ msg: "You have exceeded the rate limit" }), /no ac list.*rate limit/);
  assert.equal(airlineOf("UAL1234"), "UAL");
  assert.equal(airlineOf("N123AB"), "");
});

test("classification at ORD from the fixture aircraft list", async () => {
  const list = parseFeed(await load("ORD-now.json"));
  const s = Object.fromEntries(list.map((a) => [a.hex, classify(a, ORD).s]));
  assert.deepEqual(s, {
    a1b001: "taxi", // ground, 12 kt
    a1b002: "stat", // ground, 0 kt
    a1b003: "taxi",
    a1b004: "dep", // 3 nm E, 1,137 ft AGL, +2,240 fpm, heading away
    a1b005: "dep",
    a1b006: "arr", // 8 nm E, -832 fpm, heading in
    a1b007: "arr", // 11 nm W, 3,537 ft AGL
    a1b008: "hold", // 9,000 ft, track_rate 1.8 deg/s
    a1b009: "air", // cruising overflight
    a1b00a: "air", // climbing but heading toward the field
    a1b00e: null, // on the ground 13 nm away (another airport)
    a1b00f: "dep", // GA departure, no airline
    a1b010: "roll", // 37 ft AGL at 138 kt near the field
  });
  // field elevation matters: the same aircraft at a 0-ft field is too high for "arriving"
  assert.equal(classify(list.find((a) => a.hex === "a1b007"), { ...ORD, elev: 0 }).s, "air");
  // QNH correction: low pressure makes pressure altitude read high
  assert.equal(classify({ hex: "x", lat: ORD.lat, lon: ORD.lon + 0.005, alt: 780, gs: 120, gnd: false }, { ...ORD, qnh: -30 }).s, "roll");
  // holding from heading change and little progress when there's no track_rate
  const prev = { lat: 42.2, lon: -87.9, trk: 90 };
  const now = { hex: "h", lat: 42.205, lon: -87.89, alt: 12000, gs: 220, trk: 270, rate: 0, trate: null, gnd: false };
  assert.equal(classify(now, ORD, prev, 5).s, "hold");
  assert.equal(classify(now, ORD, null, null).s, "air", "no evidence → not holding");
  assert.equal(classify(now, ORD, prev, 30).s, "air", "previous snapshot too old");
});

test("takeoffs and landings across two snapshots", async () => {
  const prevList = parseFeed(await load("ORD-prev.json"));
  const nowList = parseFeed(await load("ORD-now.json"));
  const t0 = NOW - 5 * MIN;
  const first = stepAirport(null, prevList, ORD, t0);
  const second = stepAirport(first.state, nowList, ORD, NOW);
  // departures: classified now (004, 005, 00f) + gone after taxiing (020) or departing (023); 004 also taxi → dep
  assert.deepEqual(second.sets.dep, ["a1b004", "a1b005", "a1b00f", "a1b020"]);
  // a1b023 was already counted as departing in the first snapshot
  assert.deepEqual(first.sets.dep, ["a1b023"]);
  // arrivals: 010 and 022 were already counted as arriving 5 min ago; now 006 and 007 are new
  assert.deepEqual(first.sets.arr, ["a1b010", "a1b022"]);
  assert.deepEqual(second.sets.arr, ["a1b006", "a1b007"]);
  // the transitions themselves: arriving → landing roll (010) and arriving → gone (022) are landings
  const cur = Object.fromEntries(nowList.map((a) => [a.hex, classify(a, ORD)]).filter(([, c]) => c.s));
  const tr0 = transitions(unpackAc(first.state.ac), cur);
  assert.deepEqual([...tr0.landings].sort(), ["a1b010", "a1b022"]);
  assert.deepEqual([...tr0.takeoffs].sort(), ["a1b004", "a1b020", "a1b023"]);
  assert.equal(second.run.taxi, 2);
  assert.equal(second.run.taxiOut, 2);
  assert.equal(second.run.ground, 4);
  assert.equal(second.run.holding, 1);
  assert.deepEqual(second.run.byAirline, { SKW: 1, UAL: 2 });
  const ac = unpackAc(second.state.ac);
  assert.equal(ac.a1b010.in, true, "landed aircraft is flagged so its taxi-in isn't a takeoff later");
  assert.equal(ac.a1b009, undefined, "plain overflights aren't kept in state");
  // a parked aircraft that vanished (transponder off) is not a takeoff
  assert.ok(!second.sets.dep.includes("a1b024"));
  // same snapshot again 5 min later: nothing new is counted twice
  const third = stepAirport(second.state, nowList, ORD, NOW + 5 * MIN);
  assert.equal(third.run.dep, 0);
  assert.equal(third.run.arr, 0);
  // the landed aircraft taxis in and disappears: not a takeoff
  const taxiIn = parseFeed({ ac: [{ hex: "a1b010", flight: "UAL2020", alt_baro: "ground", gs: 15, track: 90, lat: 41.97, lon: -87.9 }] });
  const s4 = stepAirport(third.state, taxiIn, ORD, NOW + 10 * MIN);
  assert.equal(unpackAc(s4.state.ac).a1b010.in, true);
  const s5 = stepAirport(s4.state, [], ORD, NOW + 15 * MIN);
  assert.equal(s5.run.dep, 0);
  // go-around (arriving → climbing away) isn't a departure
  const ga1 = parseFeed({ ac: [{ hex: "b00001", alt_baro: 2000, baro_rate: -700, track: 270, gs: 150, lat: 41.9742, lon: -87.9073 + 4 * 0.0224 }] });
  const ga2 = parseFeed({ ac: [{ hex: "b00001", alt_baro: 2000, baro_rate: 1500, track: 270, gs: 150, lat: 41.9742, lon: -87.9073 - 2 * 0.0224 }] });
  const g1 = stepAirport(null, ga1, ORD, NOW);
  const g2 = stepAirport(g1.state, ga2, ORD, NOW + 5 * MIN);
  assert.equal(g2.run.dep, 0);
  // previous snapshot too old: no transitions, only what's classified now
  const old = stepAirport(first.state, nowList, ORD, t0 + 40 * MIN);
  assert.deepEqual(old.sets.dep, ["a1b004", "a1b005", "a1b00f"]);
  // transitions() directly: stationary → gone isn't counted, taxi → gone is
  const tr = transitions({ a: { s: "stat" }, b: { s: "taxi" }, c: { s: "taxi", in: true }, d: { s: "arr" } }, { d: { s: "taxi" } });
  assert.deepEqual([...tr.takeoffs], ["b"]);
  assert.deepEqual([...tr.landings], ["d"]);
});

test("rates scale by coverage", () => {
  assert.deepEqual(scaleRate(30, 12), { coverage: 1, rate: 30 });
  assert.deepEqual(scaleRate(15, 6), { coverage: 0.5, rate: 30 });
  assert.deepEqual(scaleRate(20, 16), { coverage: 1, rate: 20 }, "extra snapshots don't inflate the rate");
  assert.deepEqual(scaleRate(0, 0), { coverage: 0, rate: null });
  const recent = [];
  for (let i = 0; i < 6; i++) recent.push([Math.floor((NOW - i * 10 * MIN) / 1000), ["a", "b"], ["c"], {}]);
  recent.push([Math.floor((NOW - 70 * MIN) / 1000), ["x", "y", "z"], [], {}]); // outside the hour
  const r = rolling({ recent }, NOW);
  assert.equal(r.n, 6);
  assert.equal(r.coverage, 0.5);
  assert.equal(r.depRaw, 12);
  assert.equal(r.depHr, 24);
  assert.equal(r.arrHr, 12);
});

test("finished hours join the baseline by local hour of week, only with enough coverage", () => {
  assert.equal(hourOfWeek(NOW, "America/Chicago"), 24 + 10);
  assert.equal(hourOfWeek(NOW, "Pacific/Honolulu"), 24 + 5);
  const h1 = Date.parse("2026-10-05T13:00:00Z");
  const h2 = Date.parse("2026-10-05T14:00:00Z");
  const recent = [];
  for (let i = 0; i < 12; i++) recent.push([Math.floor((h1 + i * 5 * MIN) / 1000), ["d" + i], i % 2 ? ["a" + i] : [], { UAL: 1 }]);
  for (let i = 0; i < 4; i++) recent.push([Math.floor((h2 + i * 5 * MIN) / 1000), ["e" + i], [], {}]);
  const st = { recent, hrs: [] };
  const base = {};
  finalizeHours(st, base, NOW, "America/Chicago");
  assert.equal(st.last, "2026-10-05T14Z");
  assert.deepEqual(st.hrs.map((h) => [h.h, h.how, h.dep, h.arr, h.cov]), [["2026-10-05T13Z", 32, 12, 6, 1], ["2026-10-05T14Z", 33, 12, 0, 0.33]]);
  assert.deepEqual(base[32], [[12, 6, { UAL: 12 }, "2026-10-05"]]);
  assert.equal(base[33], undefined, "a third-covered hour isn't a baseline sample");
  finalizeHours(st, base, NOW + 10 * MIN, "America/Chicago");
  assert.equal(base[32].length, 1, "an hour is finalized once");
});

test("baseline fallbacks: own log (3+ samples) → BTS → null", async () => {
  const s3 = [[60, 58, {}, "2026-09-14"], [64, 60, {}, "2026-09-21"], [50, 55, {}, "2026-09-28"]];
  assert.deepEqual(baselineFor(s3, { depHr: 70 }), { depHr: 60, arrHr: 58, n: 3, source: "own" });
  assert.deepEqual(baselineFor(s3.slice(0, 2), { depHr: 70.4, arrHr: 66 }), { depHr: 70, arrHr: 66, n: null, source: "bts" });
  assert.equal(baselineFor(s3.slice(0, 2), null), null);
  // BTS from the Phase 3 model files, tolerant of shape
  const how = Array.from({ length: 168 }, (_, i) => i);
  const f168 = btsFromModel([null, { sched: { ORD: { dep: how, arr: how.map((x) => x + 1) } } }]);
  assert.deepEqual(f168("ORD", 34), { depHr: 34, arrHr: 35, n: null });
  assert.equal(f168("ATL", 34), null);
  const f24 = btsFromModel([{ schedule: { ORD: Array.from({ length: 24 }, (_, i) => i * 2) } }]);
  assert.equal(f24("ORD", 24 + 10).depHr, 20);
  assert.equal(btsFromModel([{ sched: { ORD: [1, 2, 3] } }, { climo: {} }, "x", 5]), null);
  // the committed model dir (seed fallback.json, no schedule) → no BTS baseline, and no throw on a missing dir
  assert.equal(await loadBts(join(HERE, "..", "site", "data", "model")), null);
  assert.equal(await loadBts(join(tmpdir(), "no-such-model-dir")), null);
  // sentences
  assert.equal(describe({ depHr: 38, coverage: 0.9, n: 11, baseline: { depHr: 61 }, learnDays: 12 }).sentence, "Departures 38/hr vs 61 normal (↓38%)");
  assert.equal(describe({ depHr: 38, coverage: 0.9, n: 11, baseline: { depHr: 61 } }).index, 0.62);
  assert.equal(describe({ depHr: 55, coverage: 1, n: 12, baseline: { depHr: 61 } }).sentence, "Moving normally");
  assert.equal(describe({ depHr: 90, coverage: 1, n: 12, baseline: { depHr: 61 } }).sentence, "Departures 90/hr vs 61 normal (↑48%)");
  assert.equal(describe({ depHr: 30, coverage: 1, n: 12, baseline: null, learnDays: 4 }).sentence, "Learning normal traffic (4 of 21 days)");
  assert.equal(describe({ depHr: 30, coverage: 0.4, n: 5, baseline: { depHr: 61 } }).sentence, "Limited data this hour (5 of 12 checks)");
  assert.equal(describe({ depHr: 1, coverage: 1, n: 12, baseline: { depHr: 2 } }).index, null, "too few flights to compare");
});

test("airline alert: under 30% of baseline at 3+ hubs for 2 consecutive hours", () => {
  const now = Date.parse("2026-10-05T15:20:00Z");
  const hrs = (al1, al2, cov = 1) => [
    { h: "2026-10-05T13Z", how: 32, n: 12, cov, al: { UAL: al1 } },
    { h: "2026-10-05T14Z", how: 33, n: 12, cov, al: { UAL: al2 } },
  ];
  const samples = (v) => [[0, 0, { UAL: v }, "a"], [0, 0, { UAL: v }, "b"], [0, 0, { UAL: v }, "c"]];
  const base = {};
  for (const h of AIRLINES.UAL.hubs) base[h] = { 32: samples(20), 33: samples(20) };
  const st = { ORD: { hrs: hrs(3, 4) }, DEN: { hrs: hrs(2, 5) }, IAH: { hrs: hrs(0, 1) }, EWR: { hrs: hrs(20, 21) } };
  const a = airlineAlerts(st, base, now);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].hubs, ["ORD", "DEN", "IAH"]);
  assert.equal(a[0].airline, "UAL");
  assert.equal(a[0].sentence, "United departures far below normal at ORD, DEN and IAH for the past 2 hours");
  // only 2 hubs low
  assert.deepEqual(airlineAlerts({ ...st, IAH: { hrs: hrs(10, 10) } }, base, now), []);
  // only the last hour low at one of them → not 2 consecutive hours
  assert.deepEqual(airlineAlerts({ ...st, IAH: { hrs: hrs(15, 1) } }, base, now), []);
  // exactly 30% is not "under 30%"
  assert.deepEqual(airlineAlerts({ ...st, IAH: { hrs: hrs(6, 6) } }, base, now), []);
  // low coverage hours don't count
  assert.deepEqual(airlineAlerts({ ...st, IAH: { hrs: hrs(0, 0, 0.5) } }, base, now), []);
  // those hours aren't the last two finished hours
  assert.deepEqual(airlineAlerts(st, base, now + 2 * HOUR), []);
  // baseline too small to judge
  const small = {};
  for (const h of AIRLINES.UAL.hubs) small[h] = { 32: samples(2), 33: samples(2) };
  assert.deepEqual(airlineAlerts(st, small, now), []);
});

const AIRPORTS = [
  { iata: "ORD", lat: 41.9742, lon: -87.9073, tz: "America/Chicago" },
  { iata: "ATL", lat: 33.6407, lon: -84.4277, tz: "America/New_York" },
  { iata: "DEN", lat: 39.8561, lon: -104.6737, tz: "America/Denver" },
];

test("collect: a time-budget overrun stops cleanly and rotates the start", async () => {
  const calls = [];
  let vt = 0; // virtual clock: each request takes 900 ms
  const fetchJson = async (url) => { calls.push(url); vt += 900; return { json: { ac: [] } }; };
  const col = await collect({ airports: AIRPORTS, fetchJson, clock: () => vt, sleep: async (ms) => { vt += ms; }, budgetMs: 3000, gapMs: 10, start: 1 });
  assert.equal(col.outOfTime, true);
  assert.equal(col.covered, 2);
  assert.ok(calls[0].includes("33.6407"), "starts at airports[start]");
  assert.equal(col.next, (1 + col.attempted) % 3);
  assert.deepEqual(col.errors, {});
  // a request that never answers is cut off by the budget instead of hanging
  const t0 = Date.now();
  const hang = await collect({ airports: AIRPORTS, fetchJson: () => new Promise(() => {}), budgetMs: 2500, gapMs: 10 });
  assert.ok(Date.now() - t0 < 6000);
  assert.ok(hang.covered === 0);
  // gap between requests to the same feed
  const times = [];
  await collect({ airports: AIRPORTS, fetchJson: async () => { times.push(Date.now()); return { json: { ac: [] } }; }, gapMs: 120, budgetMs: 10_000 });
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 110 && times[2] - times[1] >= 110, `gaps ${times[1] - times[0]}, ${times[2] - times[1]}`);
});

test("collect: falls back to the second feed, and leads with it after 3 primary failures", async () => {
  const hosts = [];
  const fetchJson = async (url) => {
    const host = new URL(url).host;
    hosts.push(host);
    if (host.includes("adsb.fi")) throw Object.assign(new Error("HTTP 429 from opendata.adsb.fi"), { status: 429 });
    return { json: { ac: [{ hex: "abc123", lat: 1, lon: 1, alt_baro: "ground" }] } };
  };
  const five = [...AIRPORTS, { iata: "LAX", lat: 33.94, lon: -118.41 }, { iata: "JFK", lat: 40.64, lon: -73.78 }];
  const col = await collect({ airports: five, fetchJson, gapMs: 5, budgetMs: 10_000 });
  assert.equal(col.covered, 5);
  assert.deepEqual(col.used, { adsblol: 5 });
  assert.equal(hosts.filter((h) => h.includes("adsb.fi")).length, 3, "after 3 failures the fallback goes first and the primary isn't needed");
  assert.match(FEEDS[0].url("41.9742", "-87.9073", 15), /^https:\/\/opendata\.adsb\.fi\/api\/v3\/lat\/41\.9742\/lon\/-87\.9073\/dist\/15$/);
  assert.match(FEEDS[1].url("41.9742", "-87.9073", 15), /^https:\/\/api\.adsb\.lol\/v2\/point\/41\.9742\/-87\.9073\/15$/);
  // both feeds failing: errors per airport, never throws
  const bad = await collect({ airports: AIRPORTS, fetchJson: async () => { throw new Error("boom"); }, gapMs: 5, budgetMs: 10_000 });
  assert.equal(bad.covered, 0);
  assert.match(bad.errors.ORD, /adsb\.fi: boom; ADSB\.lol: boom/);
});

test("elevation: airports-all column → METAR → cached → assumed 0; QNH from altimeter", () => {
  const aps = [{ iata: "ORD", icao: "KORD" }, { iata: "DEN", icao: "KDEN" }, { iata: "SLC", icao: "KSLC" }, { iata: "XXX", icao: "KXXX" }];
  const allJson = { f: ["iata", "icao", "elev"], a: [["ORD", "KORD", 668]] };
  const e = elevations(aps, { allJson, metars: [{ icaoId: "KDEN", elev: 1656 }, { icaoId: "KORD", elev: 202 }], cached: { SLC: [4227, "metar"] } });
  assert.deepEqual(e, { ORD: [668, "airports-all"], DEN: [5433, "metar"], SLC: [4227, "metar"], XXX: [0, "assumed 0"] });
  assert.deepEqual(elevations(aps.slice(0, 1), {}), { ORD: [0, "assumed 0"] });
  assert.deepEqual(qnhCorrections(aps, [{ icaoId: "KORD", altim: 1023.3 }, { icaoId: "KDEN", altim: 29.5 }]), { ORD: 274, DEN: -389 });
});

test("fixture run end to end: below-normal ORD, learning ANC, airline alert, history record", async () => {
  const airports = JSON.parse(await readFile(join(HERE, "..", "airports.json"), "utf8"));
  const f = await fixtureRun(airports, NOW);
  const r = computeMovement({ airports, col: f.col, state: f.state, baseline: f.baseline, nowMs: NOW, elev: f.elev });
  const m = r.movement;
  assert.equal(m.run.ok, true);
  assert.equal(m.run.airports, 32);
  const ord = m.airports.ORD;
  assert.equal(ord.baseline.source, "own");
  assert.ok(ord.index < 0.7, `ORD index ${ord.index}`);
  assert.match(ord.sentence, /^Departures \d+\/hr vs 61 normal \(↓\d+%\)$/);
  assert.equal(ord.coverage, 1);
  assert.equal(ord.taxiOut, 2);
  assert.equal(ord.holding, 1);
  assert.ok(m.airports.LAS.index > 1.3);
  assert.equal(m.airports.ATL.sentence, "Moving normally");
  assert.equal(m.airports.ANC.baseline.source, null);
  assert.equal(m.airports.ANC.sentence, "Learning normal traffic (12 of 21 days)");
  assert.equal(m.airlineAlerts.length, 1);
  assert.deepEqual(m.airlineAlerts[0].hubs, ["ORD", "DEN", "IAH", "EWR"]);
  assert.deepEqual(r.log.airports.ORD, { dep: 5, arr: 4, taxi: 2, ground: 4, holding: 1, coverage: 1, byAirline: { SKW: 1, UAL: 2, AAL: 1 } });
  // history record: state + baseline + one log line per run, never twice
  const tmp = await mkdtemp(join(tmpdir(), "awx-mv-"));
  const from = join(tmp, "out");
  await mkdir(from, { recursive: true });
  await writeFile(join(from, "state.json"), JSON.stringify(r.state));
  await writeFile(join(from, "baseline.json"), JSON.stringify(r.baseline));
  await writeFile(join(from, "log.json"), JSON.stringify(r.log));
  const hist = join(tmp, "history");
  const a = await recordMovement(hist, from);
  const b = await recordMovement(hist, from);
  assert.equal(a.appended, true);
  assert.equal(b.appended, false);
  const day = await readFile(join(hist, "movement", "2026", "10", "05.jsonl"), "utf8");
  assert.equal(day.trim().split("\n").length, 1);
  assert.ok(JSON.parse(await readFile(join(hist, "movement", "state.json"), "utf8")).ap.ORD.ac);
  assert.deepEqual(await recordMovement(join(tmp, "h2"), join(tmp, "missing")), { skipped: "no movement output from this run" });
  // the next run 5 minutes later with no feed at all: still writes, marks airports stale
  const none = { snaps: {}, errors: { ORD: "boom" }, attempted: 32, covered: 0, next: 0, ms: 1000, used: {} };
  const r2 = computeMovement({ airports, col: none, state: r.state, baseline: r.baseline, nowMs: NOW + 5 * MIN, elev: f.elev });
  assert.equal(r2.movement.run.ok, false);
  assert.equal(r2.movement.airports.ORD.stale, true);
  assert.equal(r2.movement.airports.ORD.asOf, r.movement.airports.ORD.asOf);
});
