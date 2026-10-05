import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shortIso, compact, dayFile, truthState, truthLine, forecastLine, issuedHourOf, recordTruth, recordForecast, recordRaw, record,
} from "./record.mjs";
import { run } from "./poll.mjs";

const NOW = new Date("2026-10-03T19:20:00Z");

test("shortIso and compact", () => {
  assert.equal(shortIso("2026-10-03T22:00:00.000Z"), "2026-10-03T22:00Z");
  assert.equal(shortIso("2026-10-03T22:04:24.965Z"), "2026-10-03T22:04:24Z");
  assert.equal(shortIso("not a date"), "not a date");
  assert.deepEqual(compact({ a: null, b: "", c: [], d: {}, e: 0, f: false, g: [null, 1], h: { i: undefined }, t: "2026-10-03T22:00:00.000Z" }),
    { e: 0, f: false, g: [1], t: "2026-10-03T22:00Z" });
  assert.equal(compact({}), undefined);
  assert.equal(dayFile("/h", "truth", Date.parse("2026-01-05T23:59:00Z")), "/h/truth/2026/01/05.jsonl");
});

const status = (generated, obs, extra = {}) => ({
  generated,
  sources: { metar: { ok: true }, faa: { ok: false, error: "x" } },
  airports: [
    {
      iata: "ORD", metar: { obsTime: obs, raw: "KORD 031851Z ...", fltCat: "VFR", visib: 10, ceiling: null, wx: null, wind: { dir: 220, spd: 11 }, gust: null, temp: 14 },
      faa: [{ type: "ground_stop", reason: "STAFFING / ATC ZERO", cause: "staffing", detail: "until 4 PM CT", badge: "GROUND STOP" }],
      atcscc: [
        { id: "a", type: "GS", issued: "2026-10-03T19:00:00Z", active: true, cause: "staffing" },
        { id: "b", type: "GDP", issued: "2026-10-03T12:00:00Z", active: false, cause: "weather" },
      ],
      taf: { raw: "TAF KORD ...", issued: "2026-10-03T17:40:00.000Z" },
      lamp: { issued: "2026-10-03T18:30:00.000Z", hours: [{ t: "2026-10-03T19:00:00.000Z", gust: 0, tstmProb: null, cig: 8, vis: 7, typ: "R", pFrz: 0, pPrecip: 5 }] },
      spc: "MRGL", tcf: [], cwa: [],
      alerts: [{ event: "Wind Advisory", severity: "Moderate", headline: "h", onset: "2026-10-03T18:00:00Z", ends: "2026-10-03T23:00:00Z" }],
      hours: [{ t: "2026-10-03T19:00:00.000Z", level: 4, reasons: ["Ground stop"], fltCat: "VFR" }, { t: "2026-10-03T20:00:00.000Z", level: 0, reasons: [], fltCat: null }],
      ...extra,
    },
    { iata: "PHX", metar: null, faa: [], atcscc: [], hours: [] },
  ],
});

test("truth line: METAR fields, program state with cause, failed sources; duplicate METARs skipped", () => {
  const s = status("2026-10-03T19:20:00.000Z", "2026-10-03T18:51:00.000Z");
  const l = truthLine(s);
  assert.equal(l.t, "2026-10-03T19:20Z");
  assert.deepEqual(l.down, ["faa"]);
  assert.deepEqual(l.airports.ORD.metar, { obsTime: "2026-10-03T18:51Z", raw: "KORD 031851Z ...", fltCat: "VFR", visib: 10, wspd: 11 });
  assert.deepEqual(l.airports.ORD.faa, [{ type: "ground_stop", cause: "staffing", reason: "STAFFING / ATC ZERO", detail: "until 4 PM CT" }]);
  assert.deepEqual(l.airports.ORD.atcscc.map((a) => a.id), ["a", "b"]); // first line: everything
  assert.equal(l.airports.PHX, undefined);
  const prev = truthState([JSON.stringify(l)]);
  assert.equal(prev.lastObs.ORD, Date.parse("2026-10-03T18:51:00Z") / 1000);
  const l2 = truthLine(status("2026-10-03T19:30:00.000Z", "2026-10-03T18:51:00.000Z"), prev);
  assert.equal(l2.airports.ORD.metar, undefined);
  assert.ok(l2.airports.ORD.faa, "program state is recorded every poll");
  assert.deepEqual(l2.airports.ORD.atcscc.map((a) => a.id), ["a"]); // inactive and not new
});

test("forecast line: compact, hourly key", () => {
  const s = status("2026-10-03T19:20:00.000Z", "2026-10-03T18:51:00.000Z");
  assert.equal(issuedHourOf(s), "2026-10-03T19:00Z");
  const f = forecastLine(s);
  assert.equal(f.issuedHour, "2026-10-03T19:00Z");
  const o = f.airports.ORD;
  assert.deepEqual(o.taf, { issued: "2026-10-03T17:40Z", raw: "TAF KORD ..." });
  assert.deepEqual(o.lamp.hours[0], { t: "2026-10-03T19:00Z", gust: 0, cig: 8, vis: 7, typ: "R", pFrz: 0, pPrecip: 5 });
  assert.deepEqual(o.alerts, [{ event: "Wind Advisory", onset: "2026-10-03T18:00Z", ends: "2026-10-03T23:00Z" }]);
  assert.deepEqual(o.hours, [{ t: "2026-10-03T19:00Z", level: 4, reasons: ["Ground stop"] }, { t: "2026-10-03T20:00Z", level: 0 }]);
  assert.equal(o.spc, "MRGL");
  assert.equal(o.tcf, undefined);
  assert.equal(f.airports.PHX, undefined);
});

test("record: truth every poll (idempotent), forecast once per hour, raw kept on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-hist-"));
  const raw = await mkdtemp(join(tmpdir(), "awx-raw-"));
  try {
    const s1 = status("2026-10-03T19:20:00.000Z", "2026-10-03T18:51:00.000Z");
    const s2 = status("2026-10-03T19:30:00.000Z", "2026-10-03T18:51:00.000Z");
    const s3 = status("2026-10-03T20:01:00.000Z", "2026-10-03T19:51:00.000Z");
    await recordTruth(dir, s1);
    assert.equal((await recordTruth(dir, s1)).skipped, "already recorded");
    await recordTruth(dir, s2);
    await recordTruth(dir, s3);
    const truth = (await readFile(join(dir, "truth/2026/10/03.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(truth.map((l) => !!l.airports.ORD.metar), [true, false, true]);
    await recordForecast(dir, s1);
    assert.match((await recordForecast(dir, s2)).skipped, /already have 2026-10-03T19:00Z/);
    await recordForecast(dir, s3);
    const fc = (await readFile(join(dir, "forecast/2026/10/03.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).issuedHour);
    assert.deepEqual(fc, ["2026-10-03T19:00Z", "2026-10-03T20:00Z"]);

    // raw: run 1 has lamp, run 2 lamp failed (no files) -> previous lamp sample kept with its time
    await writeFile(join(raw, "lamp.txt"), "LAMP v1");
    await writeFile(join(raw, "metar.json"), "[1]");
    await writeFile(join(raw, "sources.json"), JSON.stringify({ lamp: { ok: true, files: ["lamp.txt"] }, metar: { ok: true, files: ["metar.json"] } }));
    await recordRaw(dir, raw, s1);
    await rm(join(raw, "lamp.txt"));
    await writeFile(join(raw, "metar.json"), "[2]");
    await writeFile(join(raw, "sources.json"), JSON.stringify({ lamp: { ok: false, error: "HTTP 404", http: 404 }, metar: { ok: true, files: ["metar.json"] } }));
    await mkdir(join(dir, "raw/latest"), { recursive: true });
    await writeFile(join(dir, "raw/latest/stale.txt"), "x");
    await recordRaw(dir, raw, s2);
    const latest = join(dir, "raw/latest");
    assert.deepEqual((await readdir(latest)).sort(), ["lamp.txt", "metar.json", "sources.json"]);
    assert.equal(await readFile(join(latest, "lamp.txt"), "utf8"), "LAMP v1");
    assert.equal(await readFile(join(latest, "metar.json"), "utf8"), "[2]");
    const src = JSON.parse(await readFile(join(latest, "sources.json"), "utf8"));
    assert.equal(src.generated, s2.generated);
    assert.deepEqual(src.sources.lamp, { ok: false, error: "HTTP 404", http: 404, files: ["lamp.txt"], fileAt: s1.generated });
    assert.equal(src.sources.metar.fileAt, s2.generated);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(raw, { recursive: true, force: true });
  }
});

test("record end to end from a fixture poll (README, truth, forecast, raw samples)", async () => {
  const work = await mkdtemp(join(tmpdir(), "awx-e2e-"));
  try {
    await run({ fixtures: true, out: join(work, "status.json"), now: NOW, rawDir: join(work, "raw") });
    const { out, errors } = await record({ dir: join(work, "history"), statusFile: join(work, "status.json"), rawDir: join(work, "raw") });
    assert.deepEqual(errors, []);
    assert.equal(out.readme.written, true);
    assert.match(await readFile(join(work, "history/README.md"), "utf8"), /truth\/YYYY\/MM\/DD\.jsonl/);
    const raw = (await readdir(join(work, "history/raw/latest"))).sort();
    for (const f of ["metar.json", "taf.json", "airsigmet.json", "faa.xml", "nws.json", "spc.geojson", "lamp.txt", "lamp-airports.txt", "atcscc.html", "tcf.json", "cwa.json", "sources.json"]) {
      assert.ok(raw.includes(f), f);
    }
    const truth = JSON.parse((await readFile(join(work, "history/truth/2026/10/03.jsonl"), "utf8")).trim());
    // the ops plan is recorded on the first line that has it: nationally and per airport
    assert.equal(truth.opsplan.plan.advisory, "072");
    assert.equal(truth.opsplan.launches[0].name, "SPACEX SDA-T1A");
    assert.equal(truth.airports.BNA.opsplan.staffing[0].cause, "staffing");
    assert.equal(truth.airports.BNA.opsplan.staffing[0].until, "2026-10-04T01:00Z");
    assert.equal(truth.airports.DEN.opsplan.sirs[0].until, "2026-11-05T00:00Z");
    assert.deepEqual(truth.airports.MCO.opsplan.programs.map((p) => [p.program, p.status]), [["GS", "possible"]]);
    assert.equal(truth.airports.ORD.faa[0].cause, "weather");
    assert.equal(truth.airports.AUS.hubResearch.version, 1);
    assert.ok(truth.hubStates.ORD);
    assert.equal(truth.airports.LAX.faa[0].scope, "limited");
    const fc = JSON.parse((await readFile(join(work, "history/forecast/2026/10/03.jsonl"), "utf8")).trim());
    assert.equal(fc.airports.ATL.hours.length, 24);
    assert.equal(fc.airports.AUS.hubResearch.version, 1);
    assert.ok(fc.airports.ATL.lamp.hours.length > 20);
    assert.equal(fc.airports.ATL.lamp.hours[0].probHrs, 1);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("truth line: the ops plan is written once per plan (advisory + issue time)", () => {
  const op = { plan: { advisory: "072", issued: "2026-10-03T21:28:00.000Z" }, launches: [{ name: "SPACEX" }] };
  const mk = (generated, opsplan) => ({ ...status(generated, "2026-10-03T18:51:00.000Z"), opsplan,
    airports: [{ iata: "BNA", faa: [], atcscc: [], hours: [], opsplan: { staffing: [{ facility: "BNA", until: "2026-10-04T01:00:00.000Z" }], items: [{ text: "x" }] } }] });
  const l1 = truthLine(mk("2026-10-03T22:00:00.000Z", op));
  assert.equal(l1.opsplan.plan.advisory, "072");
  assert.deepEqual(l1.airports.BNA.opsplan, { staffing: [{ facility: "BNA", until: "2026-10-04T01:00Z" }] }); // items (display text) not recorded
  const prev = truthState([JSON.stringify(l1)]);
  assert.equal(prev.lastPlan, "072|2026-10-03T21:28Z");
  const l2 = truthLine(mk("2026-10-03T22:05:00.000Z", op), prev);
  assert.equal(l2.opsplan, undefined);
  assert.equal(l2.airports?.BNA?.opsplan, undefined);
  const l3 = truthLine(mk("2026-10-03T23:30:00.000Z", { ...op, plan: { advisory: "074", issued: "2026-10-03T23:28:00.000Z" } }), prev);
  assert.equal(l3.opsplan.plan.advisory, "074");
});


test("hub research: positive and negative exposures, missing coverage and baseline forecasts survive recording", () => {
  const research = { version: 1, routeBasis: "approximate-top-routes", lagHours: [1, 4],
    hubs: [{hub: "ORD", available: true}, {hub: "DFW", available: false}], signalCount: 0, signals: [] };
  const s = status("2026-10-03T19:20:00.000Z", "2026-10-03T18:51:00.000Z", { hubResearch: research });
  s.delayModel = { basis: "model", updated: "2026-10-03" };
  s.airports[0].hours[0].delay = { p: .3, minutes: 25 };
  s.airports.push({ iata: "AUS", hours: [{ t: s.airports[0].hours[0].t, level: 0, reasons: [] }],
    hubResearch: { ...research, signalCount: 1, signals: [{ t: "2026-10-03T20:00:00.000Z", hub: "ORD", kind: "ground stop" }] } });
  const truth = truthLine(s), forecast = forecastLine(s);
  assert.deepEqual(truth.delayModel, s.delayModel);
  assert.deepEqual(forecast.delayModel, s.delayModel);
  assert.equal(truth.airports.ORD.hubResearch.signalCount, 0);
  assert.equal(truth.airports.ORD.hubResearch.hubs[1].available, false);
  assert.equal(truth.airports.AUS.hubResearch.signals[0].t, "2026-10-03T20:00Z");
  assert.deepEqual(truth.hubStates.ORD.delay, {p: .3, minutes: 25});
  assert.deepEqual(forecast.airports.ORD.hours[0].delay, {p: .3, minutes: 25});
  assert.equal(forecast.airports.AUS.hours[0].level, 0);
  assert.deepEqual(truth.down, ["faa"]);
});
