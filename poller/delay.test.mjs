// Delay model scorer (poller/delay.mjs): features, fallback, analog sentence, FAA overrides.
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreHours, tafSummary, condSummary, crosswind, encode, calibrate, analogFor, analogText, hazardOf, overrides, durMin, delayRange,
  bucketOf, typicalRate, modelInfo, localParts, hubBits, SPEC, modelOk, featsOf, programState, lampAt, volumeAt,
} from "./delay.mjs";
import { buildHours } from "./risk.mjs";
import { parseTaf } from "./taf-parse.mjs";

const HOUR = 3600e3;
const NOW = new Date("2026-07-14T21:10:00Z"); // 4:10 PM CDT
const H0 = Date.UTC(2026, 6, 14, 21);
const TAF = parseTaf("TAF KORD 141720Z 1418/1524 24012KT P6SM SCT050 TEMPO 1422/1424 3SM TSRA BKN030CB FM150100 30015G28KT P6SM OVC008 PROB30 1504/1506 1SM SN", { issueTime: Date.UTC(2026, 6, 14, 17, 20) });
const FALLBACK = {
  v: 1, spec: SPEC, source: "train", built: "2026-09-22T00:00:00Z", since: "2024-08", months: 24,
  levels: { "0-3": [0.1, 0.15, 0.3, 0.55, 0.85], "3-6": [0.1, 0.15, 0.31, 0.56, 0.86], "6-12": [0.1, 0.15, 0.32, 0.56, 0.8], "12-24": [0.1, 0.15, 0.33, 0.54, 0.78] },
  minutes: [30, 32, 35, 41, 55], climo: { ORD: Array.from({ length: 288 }, (_, i) => (i % 24 === 16 ? 0.22 : 0.12)) }, base: { all: 0.18, ORD: 0.15 },
  programs: { GS: { n: 20, k: 13, rate: 0.65 } },
};
const hoursFor = (opts = {}) => buildHours({ now: NOW, tz: "America/Chicago", taf: TAF, count: 24, ...opts });

test("tafSummary: prevailing state, TEMPO thunder, PROB snow, gusts and crosswind", () => {
  const w = tafSummary(TAF, Date.UTC(2026, 6, 14, 22), [90, 40]); // TEMPO TSRA hour
  assert.equal(w.t, 2);
  assert.equal(w.l, 3);
  assert.equal(w.fc, 0);
  assert.ok(w.p & 1); // rain from the TEMPO group
  const w2 = tafSummary(TAF, Date.UTC(2026, 6, 15, 4), [90, 40]); // FM0100 OVC008 + PROB30 SN
  assert.equal(w2.c, 800);
  assert.equal(w2.fc, 2);
  assert.equal(w2.g, 28);
  assert.equal(w2.t, 0);
  assert.ok(w2.pp & 2, "snow only in a PROB group");
  assert.ok(!(w2.p & 2));
  assert.equal(w2.x, crosswind(300, 28, [90, 40]));
  assert.equal(tafSummary(TAF, Date.UTC(2026, 6, 20, 0), null), null, "outside validity");
});

test("crosswind: smallest over runways; calm 0; variable or unknown runways null", () => {
  assert.equal(crosswind(270, 20, [90]), 0);
  assert.equal(crosswind(360, 20, [90, 40]), 13);
  assert.equal(crosswind(360, 0, [90]), 0);
  assert.equal(crosswind("VRB", 10, [90]), null);
  assert.equal(crosswind(360, 20, null), null);
});

test("condSummary and hubBits", () => {
  const o = condSummary({ wdir: 240, wspd: 15, wgst: 30, visib: "2", wxString: "+TSRA", clouds: [{ cover: "BKN", base: 2000 }] }, [90]);
  assert.equal(o.t, 2);
  assert.equal(o.th, 1);
  assert.equal(o.l, 4);
  assert.equal(o.fc, 2);
  assert.equal(hubBits({ t: 4, fc: 2, p: 2, g: 30, l: 3 }), 1 | 4 | 8 | 16 | 32);
  assert.equal(hubBits(null), null);
});

test("encode: stable, unique feature names per lead bucket", () => {
  const w = tafSummary(TAF, Date.UTC(2026, 6, 14, 22), [90, 40]);
  const n = encode({ ap: "ORD", lh: 17, dw: 2, mo: 7, w, o: null, h: 1 }, "0-3");
  assert.ok(n.includes("lead:0-3") && n.includes("hr:17") && n.includes("ap:ORD") && n.includes("ts:2") && n.includes("ts:2|0-3") && n.includes("ts|evening"));
  assert.ok(n.includes("obs:none") && n.includes("hub:ts") && n.includes("lvl:3"));
  assert.equal(new Set(n).size, n.length);
  assert.ok(encode({ ap: "ORD", lh: 3, dw: 1, mo: 1, w: null, o: null, h: null }, "12-24").includes("taf:none"));
});

test("bucketOf, localParts, typicalRate", () => {
  assert.equal(bucketOf(0), "0-3");
  assert.equal(bucketOf(5.9), "3-6");
  assert.equal(bucketOf(30), "12-24");
  assert.deepEqual(localParts(H0, "America/Chicago"), { y: 2026, mo: 7, d: 14, h: 16, dw: 2 });
  assert.deepEqual(typicalRate(FALLBACK, "ORD", 7, 16), { p: 0.22, scope: "hour" });
  assert.deepEqual(typicalRate(FALLBACK, "MSP", 7, 16), { p: 0.18, scope: "pooled" });
  assert.deepEqual(typicalRate({ base: { all: 0.2 } }, "BZN", 7, 16), { p: 0.2, scope: "pooled" });
});

test("calibrate: interpolates between knots, flat outside, monotone", () => {
  const cal = { x: [0.1, 0.3, 0.7], y: [0.05, 0.2, 0.8] };
  assert.equal(calibrate(cal, 0.01), 0.05);
  assert.equal(calibrate(cal, 0.9), 0.8);
  assert.ok(Math.abs(calibrate(cal, 0.2) - 0.125) < 1e-9);
  let prev = -1;
  for (let p = 0; p <= 1; p += 0.01) { const v = calibrate(cal, p); assert.ok(v >= prev); prev = v; }
});

test("scorer: no model -> fallback (rule level -> historical rate), with the usual rate and lead", () => {
  const hours = hoursFor();
  const d = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK });
  assert.equal(d.length, 24);
  assert.equal(d[0].basis, "fallback");
  assert.equal(d[0].lead, "0-3");
  assert.equal(d[0].p, 0.1); // 4 PM: SCT050, level 0
  assert.equal(d[0].pTypical, 0.22);
  assert.equal(d[1].p, 0.55); // 5 PM CDT = 22Z: TEMPO TSRA -> High at lead 0-3
  assert.equal(d[1].minutes, 40); // fallback minutes for High (41) rounded to 5
  assert.equal(d[8].lead, "6-12");
  // a model for another feature spec is ignored
  const old = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, model: { spec: SPEC + 1, b0: 0, w: {} } });
  assert.equal(old[1].basis, "fallback");
  // nothing loaded -> no delay numbers at all
  assert.ok(scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF }).every((x) => x === null));
});

test("scorer: model basis applies weights, climatology and calibration", () => {
  const hours = hoursFor();
  const model = { spec: SPEC, b0: 0, wc: 1, w: { "lvl:3": 2 }, cal: null, minutes: { edges: [0.5], all: [20, 45], ap: {} }, rwy: {} };
  const d = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, model });
  assert.equal(d[0].basis, "model");
  assert.equal(d[0].p, 0.22); // only the climatology term: logit(0.22) -> 0.22
  assert.equal(d[0].minutes, 20);
  const z = Math.log(0.12 / 0.88) + 2; // 5 PM is local hour 17: climo 0.12
  assert.equal(d[1].p, Math.round((100 / (1 + Math.exp(-z)))) / 100);
  assert.equal(d[1].minutes, 45);
  assert.equal(modelInfo(model, FALLBACK).basis, "model");
  assert.equal(modelInfo(null, FALLBACK).basis, "fallback");
});

test("analogs: finest bucket with >= 15 hours; coarser buckets say 'similar conditions'", () => {
  const an = { ap: "ORD", since: "2024-10", b: { "storms|2|evening|summer": [214, 131, 38, 0.02], "storms|2|*|summer": [600, 300, 35, 0.02], "clear|0|evening|summer": [9, 1, null, 0], "clear|0|*|summer": [40, 0, null, 0] } };
  const w = { t: 2, th: 0, p: 1, fc: 0, g: 0, x: 0 };
  const a = analogFor(an, "ORD", w, 18, 7);
  assert.deepEqual(a, { n: 214, k: 131, median: 38, text: "In 214 similar evening hours at ORD since Oct 2024, 131 (61%) had delays of 15+ min; median 38 min." });
  const b = analogFor(an, "ORD", { t: 0, p: 0, fc: 0, g: 0, x: 0 }, 18, 7);
  assert.equal(b.text, "In 40 hours with similar conditions at ORD since Oct 2024, none had delays of 15+ min.");
  assert.equal(analogFor(an, "ORD", { t: 0, p: 0, fc: 3, g: 0, x: 0 }, 18, 7), null);
  assert.equal(analogText({ n: 1500, k: 300, median: null, iata: "DEN", since: null, tod: "night" }), "In 1,500 similar overnight hours at DEN, 300 (20%) had delays of 15+ min.");
  assert.deepEqual(hazardOf({ t: 0, p: 2 | 16, fc: 2, g: 0 }), { hz: "winter", sev: 3 });
  assert.deepEqual(hazardOf({ t: 0, p: 0, fc: 0, g: 36, x: 0 }), { hz: "wind", sev: 2 });
});

test("FAA override: ground stop / GDP in effect -> p = 1, the FAA's average delay as minutes", () => {
  const faa = [{ type: "ground_delay", detail: "avg 1h 12m, max 2h 30m", end: new Date(H0 + 3 * HOUR).toISOString() }];
  const hours = hoursFor({ faa });
  const d = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, faa });
  assert.equal(d[0].p, 1);
  assert.equal(d[0].override, "ground_delay");
  assert.equal(d[0].minutes, 70); // 72 min rounded to 5
  assert.equal(d[0].minutesFrom, "faa");
  assert.equal(d[2].p, 1);
  assert.notEqual(d[3].override, "ground_delay");
  const gs = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, faa: [{ type: "ground_stop", detail: "", end: null }] });
  assert.equal(gs[0].override, "ground_stop");
  assert.equal(gs[3].p, 1); // no end: held 3 h from now (4:10 -> 7:10 PM) like the risk rules
  assert.notEqual(gs[4].override, "ground_stop");
  const dl = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, faa: [{ type: "delay", detail: "Departures 31–45m, increasing" }] });
  assert.equal(dl[0].p, 1);
  assert.equal(dl[0].minutes, 40);
  assert.equal(dl[1].override, undefined);
  const small = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, faa: [{ type: "delay", detail: "Departures 1–15m" }] });
  assert.equal(small[0].override, undefined);
});

test("FAA override: possible ground stop raises p to its historical rate (else 0.5), never lowers it", () => {
  const opsplan = { programs: [{ program: "GS", status: "possible", until: new Date(H0 + 4 * HOUR).toISOString() }] };
  const hours = hoursFor();
  const d = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: FALLBACK, opsplan });
  assert.equal(d[0].p, 0.65);
  assert.equal(d[0].override, "possible_ground_stop");
  assert.equal(d[0].rateFrom, "history");
  assert.equal(d[1].p, 0.65); // 0.55 raised
  assert.equal(d[5].override, undefined);
  const noHist = scoreHours({ iata: "ORD", tz: "America/Chicago", now: NOW, hours, taf: TAF, fallback: { ...FALLBACK, programs: null }, opsplan });
  assert.equal(noHist[0].p, 0.5);
  assert.equal(noHist[0].rateFrom, "default");
  const ov = overrides({ hours, now: NOW, opsplan: { programs: [{ program: "GDP", status: "active", until: new Date(H0 + 2 * HOUR).toISOString() }] } });
  assert.equal(ov[1].p, 1);
  assert.equal(ov[2], null);
});

test("durMin / delayRange", () => {
  assert.equal(durMin("49m"), 49);
  assert.equal(durMin("1h 52m"), 112);
  assert.equal(durMin("2h"), 120);
  assert.deepEqual(delayRange("Departures 16–30m, increasing; Arrivals 31–45m"), { min: 16, mid: 23 });
  assert.deepEqual(delayRange("Arrivals 1h–1h 30m"), { min: 60, mid: 75 });
  assert.equal(delayRange(""), null);
});

test("scorer: a model with the optional families gets the same inputs live (hubs, programs, day type, volume, LAMP)", () => {
  const now = new Date("2026-07-03T15:10:00Z"); // Friday July 3 2026: observed Independence Day
  const t0 = Date.UTC(2026, 6, 3, 15);
  const hours = [0, 1, 2].map((k) => ({ t: new Date(t0 + k * HOUR).toISOString(), level: 0 }));
  const ewr = parseTaf("TAF KEWR 031120Z 0312/0418 24012KT P6SM SCT050 TEMPO 0314/0318 3SM TSRA BKN030CB", { issueTime: Date.UTC(2026, 6, 3, 11, 20) });
  const lga = parseTaf("TAF KLGA 031120Z 0312/0418 24012KT P6SM TSRA BKN030CB", { issueTime: Date.UTC(2026, 6, 3, 11, 20) });
  const base = { spec: SPEC, b0: 0, wc: 0, cal: null, minutes: null, rwy: {} };
  const p = (z) => Math.round(100 / (1 + Math.exp(-z))) / 100;
  const run = (model, extra = {}) => scoreHours({ iata: "ORD", tz: "America/Chicago", now, hours, fallback: FALLBACK, model, ...extra }).map((d) => d.p);

  // hub cascade: hubs from model.hubs; hubTafs matched by station, the others through tafOf
  const hubM = { ...base, feats: { hubs: true }, hubs: { ORD: ["EWR", "LGA"] }, w: { "hc:ts": 1, "hc:ts2": 1, "hc:none": -1 } };
  assert.deepEqual(run(hubM), [p(-1), p(-1), p(-1)], "no hub TAFs -> hc:none");
  assert.deepEqual(run(hubM, { hubTafs: [ewr] }), [p(1), p(1), p(1)]);
  assert.deepEqual(run(hubM, { hubTafs: [ewr], tafOf: (h) => (h === "LGA" ? lga : null) }), [p(2), p(2), p(2)]);
  // a model without feats ignores all of it (old models score exactly as before)
  assert.deepEqual(run({ ...base, w: { "hc:ts": 5, "day:hol": 5, "vol:q3": 5, "pg:staff": 5, "lcig:ifr": 5 } }, { hubTafs: [ewr], tafOf: () => lga }), [0.5, 0.5, 0.5]);

  // programs: an ops-plan staffing trigger until 16:30Z, an active ground stop
  const pgM = { ...base, feats: { programs: true }, w: { "pg:staff": 1, "pg:gs|0-3": 2, "pg:none": 9 } };
  const op = { staffing: [{ facility: "ORD", until: "2026-07-03T16:30Z", cause: "staffing" }] };
  assert.deepEqual(run(pgM, { opsplan: op }), [p(1), p(1), 0.5]);
  const gs = run(pgM, { faa: [{ type: "ground_stop", cause: "weather" }] });
  assert.equal(gs[0], 1); // the FAA override still wins where the program is in effect
  assert.deepEqual(programState({ faa: [{ type: "ground_stop" }] }, t0, +now), { gs: true, gdp: false, poss: false, staff: false });

  // day type: July 3 2026 is the observed holiday and the day before July 4
  assert.deepEqual(run({ ...base, feats: { daytype: true }, w: { "day:hol": 1, "day:pre": 0.5 } }), [p(1.5), p(1.5), p(1.5)]);

  // volume: model.vol (hour-of-week level digits and month factors)
  const f = Array(12).fill(1).map((x, i) => (i === 6 ? 1.4 : x)); // July schedules 1.4x the usual
  const q = "0".repeat(5 * 24 + 11) + "3" + "0".repeat(168 - 5 * 24 - 12); // Friday 11 AM local is a peak bank
  assert.deepEqual(volumeAt({ ORD: { q, f } }, "ORD", 7, 5, 11), { vq: 3, vr: 1.4 });
  assert.deepEqual(volumeAt({ ORD: { q: "12", f } }, "ORD", 7, 5, 11), { vq: null, vr: null });
  const volM = { ...base, feats: { volume: true }, vol: { ORD: { q, f } }, w: { "vol:q3": 1, "vol:q0": -1, "volr:hi2": 0.5 } };
  assert.deepEqual(run(volM), [p(-0.5), p(1.5), p(-0.5)]); // 10, 11 and 12 local (CDT)
  // LAMP: LP1/CP1 and the ceiling/visibility categories for the hour (row at t0 + 1 h)
  const lamp = { hours: [{ t: new Date(t0 + HOUR).toISOString(), tstmProb: 45, convProb: 60, probHrs: 1, cig: 3, vis: 6 }] };
  assert.deepEqual(lampAt(lamp, t0), { lp: 45, cp: 60, lc: 3, lv: 6 });
  const lampM = { ...base, lamp: true, feats: { lamp: true }, w: { "lp:40": 1, "lcig:ifr": 1, "lp:none": -1 } };
  assert.deepEqual(run(lampM, { lamp }), [p(2), p(-1), p(-1)]);

  // models naming a family this scorer doesn't know are not used
  assert.equal(modelOk({ ...base, w: {}, feats: { teleport: true } }), false);
  assert.equal(modelOk({ ...base, w: {}, feats: { teleport: false, volume: true } }), true);
  assert.deepEqual(featsOf({ lamp: true }), { lamp: true, programs: false, hubs: false, daytype: false, volume: false });
});
