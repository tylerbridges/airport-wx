// brief hook: the per-airport change log (poller/changes.mjs): diffing, debounce, wording, files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as C from "./changes.mjs";

const T0 = Date.parse("2026-10-04T19:00:00Z");
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const OK = { faa: true, atcscc: true, nws: true, plan: true };
/** A status.json-shaped airport. */
const ap = (o = {}) => ({ iata: "ORD", tz: "America/Chicago", now: { level: 0, reasons: [] }, hours: [], faa: [], atcscc: [], alerts: [], ...o });
const status = (min, airports, sources = {}) => ({ generated: at(min), sources, opsplan: { plan: {} }, airports });
const GS = { type: "ground_stop", reason: "WEATHER / THUNDERSTORMS", cause: "weather", causeLabel: "weather (thunderstorms)", end: at(60) };

test("changes: debounce ignores a change that reverts within 10 minutes", () => {
  let s = C.debounce(null, 2, at(0)).slot;
  assert.deepEqual(s, { v: 2 });
  let r = C.debounce(s, 3, at(5));
  assert.equal(r.change, null);
  assert.deepEqual(r.slot, { v: 2, p: { t: at(5), v: 3 } });
  r = C.debounce(r.slot, 2, at(10)); // back to 2 before 10 minutes passed
  assert.equal(r.change, null);
  assert.deepEqual(r.slot, { v: 2 });
  // a change that holds 10 minutes is confirmed, timed when first seen
  r = C.debounce(C.debounce(r.slot, 3, at(20)).slot, 3, at(30));
  assert.deepEqual(r.change, { t: at(20), from: 2, to: 3 });
  assert.deepEqual(r.slot, { v: 3 });
  // 2 -> 3 -> 4 within the window: one change 2 -> 4 from the first move
  r = C.debounce(C.debounce(C.debounce({ v: 2 }, 3, at(0)).slot, 4, at(5)).slot, 4, at(10));
  assert.deepEqual(r.change, { t: at(0), from: 2, to: 4 });
  // unknown keeps the slot
  assert.deepEqual(C.debounce({ v: 1, p: { t: at(0), v: 2 } }, null, at(5)).slot, { v: 1, p: { t: at(0), v: 2 } });
});

test("changes: level flapping produces no event; a held level change does", () => {
  const run = (prev, min, level) => C.computeChanges({ status: status(min, [ap({ now: { level, reasons: level >= 3 ? ["Thunderstorms"] : [] } })]), prev });
  let r = run(null, 0, 1);
  assert.equal(r.events.length, 0, "first run starts the state");
  r = run(r.state, 5, 3);
  r = run(r.state, 10, 1); // reverted after 5 minutes
  r = run(r.state, 15, 1);
  assert.equal(r.changes.events.length, 0);
  r = run(r.state, 20, 3);
  assert.equal(r.events.length, 0, "pending");
  r = run(r.state, 25, 3);
  assert.equal(r.events.length, 0, "5 minutes is not enough");
  r = run(r.state, 30, 3);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { t: at(20), iata: "ORD", kind: "level", from: 1, to: 3, sentence: "Risk up to High (storms)", cause: "storms" });
  r = run(r.state, 35, 0);
  r = run(r.state, 50, 0);
  assert.equal(r.events[0].sentence, "Risk down to Clear");
});

test("changes: FAA programs start, extend and end; a failed FAA feed never reads as lifted", () => {
  const prev = C.computeChanges({ status: status(0, [ap()]) }).state;
  let r = C.computeChanges({ status: status(5, [ap({ faa: [GS] })]), prev });
  assert.deepEqual(r.events.map((e) => e.sentence), ["Ground stop started (storms)"]);
  assert.equal(r.events[0].kind, "program_start");
  assert.equal(r.events[0].to, "ground_stop");
  r = C.computeChanges({ status: status(10, [ap({ faa: [{ ...GS, end: at(65) }] })]), prev: r.state });
  assert.equal(r.events.length, 0, "5 minutes later is not an extension");
  r = C.computeChanges({ status: status(15, [ap({ faa: [{ ...GS, end: at(90) }] })]), prev: r.state });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "program_extend");
  assert.equal(r.events[0].sentence, "Ground stop extended until 3:30 PM"); // 20:30Z in Chicago
  assert.equal(r.events[0].to, at(90));
  // FAA feed down: no programs in the data, but nothing ended
  r = C.computeChanges({ status: status(20, [ap()], { faa: { ok: false } }), prev: r.state });
  assert.equal(r.events.length, 0);
  r = C.computeChanges({ status: status(25, [ap({ faa: [{ type: "ground_delay", cause: "weather", causeLabel: "weather (low ceilings)", end: at(200) }] })]), prev: r.state });
  assert.deepEqual(new Set(r.events.map((e) => e.sentence)), new Set(["Ground stop lifted", "Delay program started (low ceilings)"]));
});

test("changes: an active ATCSCC ground stop counts; its cancellation lifts it", () => {
  const adv = { type: "GS", active: true, cnx: false, end: at(60), causeLabel: "weather (thunderstorms)" };
  let r = C.computeChanges({ status: status(0, [ap()]) });
  r = C.computeChanges({ status: status(5, [ap({ atcscc: [adv] })]), prev: r.state });
  assert.deepEqual(r.events.map((e) => e.sentence), ["Ground stop started (storms)"]);
  r = C.computeChanges({ status: status(10, [ap({ atcscc: [{ ...adv, active: false, cnx: true }] })]), prev: r.state });
  assert.deepEqual(r.events.map((e) => e.sentence), ["Ground stop lifted"]);
});

test("changes: closures, new warnings, ops-plan possible ground stops", () => {
  const closed = { type: "closure", scope: "full", active: true, reason: "AD AP CLSD" };
  const ga = { type: "closure", scope: "limited", active: true, reason: "CLSD TO NON SKED TRANSIENT GA" };
  const plan = { programs: [{ codes: ["ORD"], program: "GS", status: "possible" }], items: [{ kind: "program", text: "FAA plans a possible ground stop until 9 PM (storms)" }] };
  let r = C.computeChanges({ status: status(0, [ap({ faa: [ga], alerts: [{ event: "Wind Advisory" }] })]) });
  r = C.computeChanges({ status: status(5, [ap({ faa: [ga, closed], alerts: [{ event: "Wind Advisory" }, { event: "Severe Thunderstorm Warning" }], opsplan: plan })]), prev: r.state });
  assert.deepEqual(r.events.map((e) => [e.kind, e.sentence]), [
    ["closure_start", "Airport closed"], ["warning", "Severe Thunderstorm Warning issued"], ["plan_gs_add", "FAA plans a possible ground stop (storms)"]]);
  // the same warning again is not new; NWS down keeps the list; the plan's GS turning into a real one isn't "dropped"
  r = C.computeChanges({ status: status(10, [ap({ faa: [GS], alerts: [], opsplan: null })], { nws: { ok: false } }), prev: r.state });
  assert.deepEqual(r.events.map((e) => e.kind), ["program_start", "closure_end"]);
  r = C.computeChanges({ status: status(15, [ap({ faa: [GS], alerts: [{ event: "Severe Thunderstorm Warning" }] })]), prev: r.state });
  assert.equal(r.events.length, 0);
  // national plan missing (the advisory page showed something else): kept, not dropped
  const s2 = status(20, [ap({ faa: [GS] })]);
  s2.opsplan = null;
  r = C.computeChanges({ status: s2, prev: r.state });
  assert.equal(r.events.length, 0);
  r = C.computeChanges({ status: status(25, [ap({ opsplan: plan })]), prev: r.state });
  r = C.computeChanges({ status: status(30, [ap({ opsplan: { programs: [], items: [] } })]), prev: r.state });
  assert.deepEqual(r.events.map((e) => e.sentence), ["Possible ground stop no longer planned"]);
});

test("changes: delay words (near term, debounced, only around 'likely') and movement", () => {
  const like = (d) => ({ key: d.p >= 0.7 ? "very" : d.p >= 0.45 ? "likely" : d.p >= 0.25 ? "possible" : d.p >= 0.12 ? "small" : "unlikely" });
  const hrs = (...ps) => ps.map((p) => ({ delay: { p } }));
  const mv = (index, min) => ({ airports: { ORD: { index, coverage: 1, baseline: { depHr: 40 }, asOf: at(min) } } });
  const run = (prev, min, p, idx) => C.computeChanges({ status: status(min, [ap({ hours: hrs(0.05, p, 0.05, 0.99) })]), prev, likelihood: like, movement: idx == null ? null : mv(idx, min) });
  let r = run(null, 0, 0.3, 1);
  r = run(r.state, 5, 0.5, 0.5);
  r = run(r.state, 15, 0.5, 0.5);
  assert.deepEqual(r.events.map((e) => [e.kind, e.from, e.to, e.sentence]), [
    ["word", "possible", "likely", "Delays possible → Delays likely"], ["movement", "normal", "low", "Departures running below normal"]]);
  assert.equal(r.events[0].t, at(5));
  // hour 3's 0.99 is beyond the near-term window; small <-> possible isn't logged
  r = run(r.state, 20, 0.15, null); // movement unknown: kept
  r = run(r.state, 30, 0.15, null);
  assert.deepEqual(r.events.map((e) => e.sentence), ["Delays likely → Small chance of delays"]);
  r = run(r.state, 35, 0.3, 1);
  r = run(r.state, 45, 0.3, 1);
  assert.deepEqual(r.events.map((e) => e.sentence), ["Departures back to normal"]);
  // stale or thin movement data is unknown
  assert.equal(C.moveState({ index: 0.2, coverage: 0.4, baseline: { depHr: 40 }, asOf: at(0) }, T0), null);
  assert.equal(C.moveState({ index: 0.2, coverage: 1, baseline: { depHr: 40 }, asOf: at(0) }, T0 + 30 * 60e3), null);
  // "Delays happening now" comes with the program events, so it isn't a word event
  const nowLike = (d) => ({ key: d.p >= 1 ? "now" : "likely" });
  let q = C.computeChanges({ status: status(0, [ap({ hours: hrs(0.5) })]), likelihood: nowLike });
  q = C.computeChanges({ status: status(5, [ap({ hours: hrs(1) })]), prev: q.state, likelihood: nowLike });
  q = C.computeChanges({ status: status(15, [ap({ hours: hrs(1) })]), prev: q.state, likelihood: nowLike });
  assert.equal(q.events.length, 0);
});

test("changes: wording helpers", () => {
  assert.equal(C.causeWord("weather (thunderstorms)"), "storms");
  assert.equal(C.causeWord("weather (low ceilings)"), "low ceilings");
  assert.equal(C.causeWord("air traffic control staffing"), "air traffic control staffing");
  assert.equal(C.causeWord("airline request (IT outage)"), "IT outage"); // acronyms keep their capitals
  assert.equal(C.causeWord("weather"), null);
  assert.equal(C.causeWord(""), null);
  assert.equal(C.levelSentence(1, 3, "storms"), "Risk up to High (storms)");
  assert.equal(C.levelSentence(4, 2, "storms"), "Risk down to Moderate");
  assert.equal(C.clock12(Date.parse("2026-10-04T22:30:00Z"), "America/New_York"), "6:30 PM");
  assert.equal(C.clock12(Date.parse("2026-10-04T22:00:00Z"), "America/New_York"), "6 PM");
  assert.equal(C.causeOfReasons(["Delays — weather (thunderstorms), departures 16–30m"], 2), "storms");
  assert.equal(C.causeOfReasons(["Ceiling 400 ft"], 3), "low clouds");
  for (const e of [...Object.values(C.WORDS)]) assert.ok(!/%/.test(e), "no percentages");
});

test("changes: 36-hour window, idempotent reruns, first run", () => {
  const prev = { v: 1, t: at(-10), since: at(-3000), airports: {}, recent: [
    { t: at(-37 * 60), iata: "ORD", kind: "level", from: 0, to: 1, sentence: "Risk up to Minor" },
    { t: at(-60), iata: "ORD", kind: "level", from: 1, to: 0, sentence: "Risk down to Clear" }] };
  const r = C.computeChanges({ status: status(0, [ap()]), prev });
  assert.equal(r.events.length, 0, "an airport without state just starts");
  assert.deepEqual(r.changes.events.map((e) => e.sentence), ["Risk down to Clear"]);
  assert.equal(r.changes.since, at(-3000));
  const again = C.computeChanges({ status: status(0, [ap({ faa: [GS] })]), prev: r.state });
  assert.equal(again.events.length, 0, "the same status time twice adds nothing");
});

test("changes: fixture flow simulates a previous state so events exist", () => {
  const s = status(0, [ap({ iata: "EWR", tz: "America/New_York", now: { level: 2, reasons: ["Delays — weather (thunderstorms)"] }, faa: [{ type: "delay", cause: "weather", causeLabel: "weather (thunderstorms)" }] }), ap()]);
  const ch = C.fixtureChanges({ status: s, over: { at: at(-30), airports: { EWR: { lvl: { v: 4 }, faa: { ground_stop: { end: null }, delay: { end: null } } } },
    recent: [{ t: at(-95), iata: "EWR", kind: "program_start", from: null, to: "ground_stop", sentence: "Ground stop started (storms)" }] } });
  assert.deepEqual(ch.events.map((e) => [e.t, e.iata, e.sentence]), [
    [at(-30), "EWR", "Ground stop lifted"], [at(-30), "EWR", "Risk down to Moderate"], [at(-95), "EWR", "Ground stop started (storms)"]]);
  assert.equal(ch.generated, at(0));
});

test("changes: record writes the state and appends events once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-changes-"));
  const from = join(dir, "out");
  await mkdir(from);
  const ev = [{ t: at(0), iata: "ORD", kind: "program_start", from: null, to: "ground_stop", sentence: "Ground stop started" }];
  await writeFile(join(from, "state.json"), JSON.stringify({ v: 1, t: at(0) }) + "\n");
  await writeFile(join(from, "events.json"), JSON.stringify(ev) + "\n");
  const h = join(dir, "history");
  const r1 = await C.recordChanges(h, from);
  const r2 = await C.recordChanges(h, from);
  assert.equal(r1.appended, 1);
  assert.equal(r2.appended, 0);
  assert.equal((await readFile(join(h, "changes/2026/10/04.jsonl"), "utf8")).trim(), JSON.stringify(ev[0]));
  assert.ok((await readFile(join(h, "changes/state.json"), "utf8")).includes('"v":1'));
  assert.ok((await readFile(join(h, "changes/README.md"), "utf8")).startsWith("# changes/"));
  assert.deepEqual(await C.recordChanges(h, join(dir, "nothing")), { skipped: "no change-log output from this run" });
});

test("changes: runChanges writes changes.json, state and events; a broken status still writes changes.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-changes-run-"));
  const st = join(dir, "status.json");
  const out = join(dir, "changes.json");
  const logs = [];
  await writeFile(st, JSON.stringify(status(0, [ap()])));
  let r = await C.runChanges({ statusFile: st, movementFile: join(dir, "none.json"), dir: join(dir, "state"), out, log: (l) => logs.push(l) });
  assert.equal(r.ok, true);
  await mkdir(join(dir, "state2"));
  await writeFile(join(dir, "state2", "state.json"), await readFile(join(dir, "state", "out", "state.json"), "utf8"));
  await writeFile(st, JSON.stringify(status(5, [ap({ faa: [GS] })])));
  r = await C.runChanges({ statusFile: st, movementFile: join(dir, "none.json"), dir: join(dir, "state2"), out, log: (l) => logs.push(l) });
  const j = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(j.events.map((e) => e.sentence), ["Ground stop started (storms)"]);
  assert.equal(JSON.parse(await readFile(join(dir, "state2", "out", "events.json"), "utf8")).length, 1);
  await writeFile(st, "{");
  r = await C.runChanges({ statusFile: st, dir: join(dir, "state3"), out, log: (l) => logs.push(l) });
  assert.equal(r.ok, false);
  assert.ok(JSON.parse(await readFile(out, "utf8")).error);
  assert.ok(logs.some((l) => /^FAIL changes/.test(l)));
});

test("observed backfill: every observed hour change reaches the log once, in the right direction", async () => {
  const { observedEvents } = await import("./changes.mjs");
  const H = 3600e3, T = Date.parse("2026-10-05T18:00:00Z");
  const hr = (k, level, reasons = []) => ({ t: new Date(T + k * H).toISOString(), level, reasons });
  // 14Z clear, 15Z gusts (Moderate), 16Z clear, 17Z gusts; now 18:05Z (17Z complete)
  const a = { iata: "BOS", observed: [hr(-4, 0), hr(-3, 2, ["Gusts 25 kt"]), hr(-2, 0), hr(-1, 2, ["Gusts 29 kt"])] };
  const now = T + 5 * 60e3;
  let r = observedEvents(a, null, now, []);
  assert.deepEqual(r.events.map((e) => [e.t.slice(11, 16), e.from, e.to, e.obs]), [["15:00", 0, 2, true], ["16:00", 2, 0, true], ["17:00", 0, 2, true]]);
  assert.match(r.events[0].sentence, /^Risk up to Moderate/);
  assert.equal(r.obs, hr(-1, 0).t);
  // a poll-time level event already covers the 15Z rise: only the other two are added
  r = observedEvents(a, null, now, [{ t: new Date(T - 3 * H + 20 * 60e3).toISOString(), iata: "BOS", kind: "level", from: 0, to: 2 }]);
  assert.deepEqual(r.events.map((e) => e.t.slice(11, 16)), ["16:00", "17:00"]);
  // hours already looked at aren't looked at again; a missing hour isn't a change; the current hour waits
  assert.equal(observedEvents(a, hr(-1, 0).t, now, []).events.length, 0);
  assert.equal(observedEvents({ iata: "X", observed: [hr(-4, 0), hr(-2, 3)] }, null, now, []).events.length, 0);
  assert.equal(observedEvents({ iata: "X", observed: [hr(-1, 0), hr(0, 3)] }, null, now, []).events.length, 0);
});
