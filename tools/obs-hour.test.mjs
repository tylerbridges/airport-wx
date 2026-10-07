// README "The observed next hour": a build made just before the top of the hour and seen just after it. Hour 0 of a
// build is the METAR's, hour 1 the TAF's; once hour 1 is the page's current hour, the poller's obsNext (hour 1 with
// the observation winning, risk.mjs buildObsHour) replaces it (site/outlook.js withObsHour, applied in app.js
// mergeLive), so no view says "Now · Dense fog" next to a clear report. The real case: ACV (Arcata) Oct 6 2026, build
// ~23:58Z, TAF "TEMPO 0623/0701 1/2SM FG BKN002", METAR 062353Z 10SM CLR, page at 00:04Z.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../poller/core.mjs";
import { buildHours, buildObsHour } from "../poller/risk.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);
const O = req("../site/outlook.js");
const S = req("../site/split.js");
globalThis.window ??= {};
globalThis.AWXOutlook = O;
const D = await import("../site/delay.js");
const T = await import("../site/trip-risk.js");
D.setReport(JSON.parse(readFileSync(join(ROOT, "site/data/model/report.json"), "utf8")));
const model = JSON.parse(readFileSync(join(ROOT, "site/data/model/model.json"), "utf8"));
const fallback = JSON.parse(readFileSync(join(ROOT, "site/data/model/fallback.json"), "utf8"));

const HOUR = 3600e3, MIN = 60e3;
const BUILD = Date.parse("2026-10-06T23:58:00Z");
const H0 = Date.parse("2026-10-06T23:00:00Z"), H1 = H0 + HOUR;
const sec = (ms) => Math.round(ms / 1000);
const ACV = { iata: "ACV", icao: "KACV", name: "California Redwood Coast-Humboldt County", city: "Arcata/Eureka", state: "CA", tz: "America/Los_Angeles", lat: 40.9781, lon: -124.1086 };
const metarAt = (ms, over = {}) => ({ icaoId: "KACV", obsTime: sec(ms), temp: 14, dewp: 12, wdir: 270, wspd: 4, wgst: null, visib: "10+", wxString: null,
  clouds: [{ cover: "CLR", base: null }], fltCat: "VFR", rawOb: "KACV 062353Z 27004KT 10SM CLR 14/12 A3001", ...over });
const fogGroup = (from, to) => ({ timeFrom: sec(from), timeTo: sec(to), timeBec: null, fcstChange: "TEMPO", probability: null, wdir: null, wspd: null, wgst: null, visib: "1/2", wxString: "FG", clouds: [{ type: null, cover: "BKN", base: 200 }] });
const TAF = {
  icaoId: "KACV", issueTime: sec(Date.parse("2026-10-06T20:40:00Z")), validTimeFrom: sec(Date.parse("2026-10-06T21:00:00Z")), validTimeTo: sec(Date.parse("2026-10-07T21:00:00Z")),
  rawTAF: "TAF KACV 062040Z 0621/0721 27006KT P6SM SKC TEMPO 0623/0701 1/2SM FG BKN002 TEMPO 0703/0705 1/2SM FG BKN002",
  fcsts: [
    { timeFrom: sec(Date.parse("2026-10-06T21:00:00Z")), timeTo: sec(Date.parse("2026-10-07T21:00:00Z")), timeBec: null, fcstChange: null, probability: null, wdir: 270, wspd: 6, wgst: null, visib: "6+", wxString: null, clouds: [{ type: null, cover: "SKC", base: null }] },
    fogGroup(H0, H0 + 2 * HOUR), fogGroup(H0 + 4 * HOUR, H0 + 6 * HOUR),
  ],
};
const build = (metar = metarAt(Date.parse("2026-10-06T23:53:00Z")), over = {}) => assemble({
  airports: [ACV], now: new Date(BUILD), metars: metar ? [metar] : [], tafs: [TAF], sigmets: null, faaParsed: null, spc: null, nws: null,
  delay: { model, fallback, analogs: {}, icaoOf: { ACV: "KACV" } }, ...over,
})[0];
const sources = (at) => Object.fromEntries(["faa", "atcscc", "metar", "taf", "nws", "sigmet", "spc", "lamp", "tcf", "cwa"].map((k) => [k, { ok: true, at: new Date(at).toISOString(), error: null }]));
const words = (d) => D.likelihood(d, { iata: "ACV", aviation: false });
const opts = (now) => ({ now, tz: ACV.tz, generated: new Date(BUILD).toISOString(), sources: sources(BUILD), words, notable: D.notable, plain: (r) => r });
const deep = (x) => JSON.parse(JSON.stringify(x));
const LOW = /fog|visibility|ceiling|low clouds/i;

test("observed next hour: the poller writes hour 1 with the METAR winning, delay scored as hour 1", () => {
  const a = deep(build());
  assert.equal(a.hours[0].level, 0, "hour 0 = the clear METAR");
  assert.equal(a.hours[1].t, new Date(H1).toISOString());
  assert.equal(a.hours[1].level, 3, "hour 1 = the TAF's dense fog (LIFR)");
  assert.ok(a.hours[1].reasons.some((r) => /^Visibility|^Ceiling/.test(r)));
  assert.equal(a.obsNext.t, a.hours[1].t);
  assert.equal(a.obsNext.level, 0);
  assert.deepEqual(a.obsNext.reasons, []);
  assert.equal(a.obsNext.fltCat, "VFR");
  assert.equal(a.obsNext.vis, 10);
  assert.equal(a.obsNext.cig, undefined);
  assert.deepEqual(a.obsNext.delay, a.hours[1].delay, "same delay features and lead as hour 1 (no program boundary inside the hour)");
  assert.equal(build(null).obsNext, undefined, "no METAR: no obsNext");
});

test("observed next hour: viewed at 00:04Z every consumer reads the clear observation", () => {
  const a = deep(build());
  const now = H1 + 4 * MIN;
  // the bug: without the swap the current hour is the TAF's fog
  const bug = O.evaluate(a, { ...opts(now), at: now });
  assert.equal(bug.level, 3);
  assert.match(bug.headline, LOW);
  const v = O.withObsHour(a, now);
  assert.notEqual(v, a);
  assert.equal(v.hours[1].obs, true);
  assert.deepEqual(v.hours.slice(2), a.hours.slice(2), "hour 2+ untouched");
  assert.deepEqual(v.hours[0], a.hours[0]);
  // sheet / map (app.js outlook → evaluate at refNow; map.js stateOf) and cards (outlook.js summary)
  const e = O.evaluate(v, { ...opts(now), at: now });
  assert.equal(e.level, 0);
  assert.equal(e.headline, "Operating normally");
  assert.deepEqual(e.reasons, []);
  const sm = O.summary(v, opts(now));
  assert.equal(sm.nowLevel, 0);
  assert.equal(sm.nowHour.obs, true);
  assert.ok(!LOW.test(sm.current.headline));
  assert.equal(O.levelAt(v, v.hours[1], opts(now), now, now), 0);
  // the later fog (03–05Z) stays in the forecast
  assert.equal(sm.level, 3);
  assert.equal(sm.peakAt, new Date(H0 + 4 * HOUR).toISOString());
  // the build's peak was the swapped hour: recomputed to the later fog
  assert.equal(a.peak.at, new Date(H1).toISOString());
  assert.equal(v.peak.at, new Date(H0 + 4 * HOUR).toISOString());
  assert.equal(v.peak.level, 3);
  // trips (site/trip-risk.js): a departure at 00:30Z sees no fog concern
  const trip = { id: "t1", legs: [{ from: "ACV", to: "SFO", dep: new Date(H1 + 30 * MIN).toISOString(), arr: new Date(H1 + 90 * MIN).toISOString() }] };
  const run = (x) => T.tripStatus(trip, (c) => (c === "ACV" ? x : null), { now, words: (d) => words(d)?.word, health: (y) => O.health(y, opts(now)) });
  const before = JSON.stringify(run(a)), after = JSON.stringify(run(v));
  assert.match(before, /fog|visibility|low clouds/i, "the forecast hour made a fog concern");
  assert.doesNotMatch(after, /fog|visibility|low clouds/i, after);
  // idempotent (offline snapshots and repeated merges)
  assert.equal(O.withObsHour(v, now), v);
  assert.equal(O.withObsHour(v, now + 20 * MIN), v);
});

test("observed next hour: the same build at 23:59Z is unchanged (hour 0 is the METAR's)", () => {
  const a = deep(build());
  const now = BUILD + MIN;
  assert.equal(O.withObsHour(a, now), a);
  assert.equal(O.evaluate(a, { ...opts(now), at: now }).level, 0);
});

test("observed next hour: a METAR older than OBS_NEXT_MAX keeps the forecast hour, worded as a forecast", () => {
  assert.equal(O.OBS_NEXT_MAX, 75 * MIN);
  const obs = Date.parse("2026-10-06T22:45:00Z"); // 73 min old at the build: still the poller's current METAR (< 2 h)
  const a = deep(build(metarAt(obs, { rawOb: "KACV 062245Z 27004KT 10SM CLR 14/12 A3001" })));
  assert.ok(a.obsNext, "the poller still writes it");
  const now = H1 + 4 * MIN; // 79 min old now
  const v = O.withObsHour(a, now);
  assert.equal(v.hours[1].obs, undefined);
  assert.equal(v.hours[1].fcNow, true);
  assert.equal(v.hours[1].level, 3, "the forecast hour's level is kept");
  const e = O.evaluate(v, { ...opts(now), at: now });
  assert.equal(e.level, 3);
  assert.match(e.headline, / expected$/, "stated as a forecast, never as what is happening now");
  // on the limit itself it is used
  const edge = obs + O.OBS_NEXT_MAX;
  assert.equal(O.withObsHour(a, edge).hours[1].obs, true);
});

test("observed next hour: a fresher, different METAR on the page than obsNext's qualifies instead of swapping", () => {
  const a = deep(build());
  const now = H1 + 20 * MIN;
  const v = O.withObsHour(a, now, { metar: { obsTime: new Date(H1 + 15 * MIN).toISOString(), raw: "KACV 070015Z 27004KT 1/4SM FG VV002 13/13 A3001" } });
  assert.equal(v.hours[1].fcNow, true);
  assert.equal(O.withObsHour(a, now, { metar: { obsTime: a.metar.obsTime, raw: a.metar.raw } }).hours[1].obs, true, "the same METAR: swap");
});

test("observed next hour: summary + detail restore the swapped hour from obsNext", () => {
  const full = { generated: new Date(BUILD).toISOString(), sources: sources(BUILD), airports: [deep(build())] };
  const { summary, details } = S.split(full);
  const now = H1 + 4 * MIN;
  const v = O.withObsHour(summary.airports[0], now);
  const r = S.restore(v, deep(details.ACV.airport));
  assert.deepEqual(r.hours[1], { ...full.airports[0].obsNext, obs: true });
  assert.deepEqual(r.obsNext, full.airports[0].obsNext);
});

test("buildObsHour: hour-0 items for a current hour 1, never a program that ended before it", () => {
  const now = new Date(BUILD);
  const base = { now, tz: ACV.tz, taf: TAF, metar: metarAt(Date.parse("2026-10-06T23:53:00Z")) };
  const ended = { type: "ground_stop", detail: "", reason: "WX", cause: "weather", end: new Date(BUILD + MIN).toISOString() };
  const rwy = { type: "closure", scope: "runway", active: true, reason: "RWY 12/30 CLSD", plain: "Runway 12/30 closed", runways: ["12/30"], start: null, end: null };
  const args = { ...base, faa: [ended, rwy], sigmet: true };
  const hs = buildHours(args), o = buildObsHour(args);
  const texts = (h) => h.items.map((x) => x.text);
  assert.ok(texts(hs[0]).some((t) => /^Ground stop/.test(t)), "hour 0 has the ground stop");
  assert.ok(!texts(o).some((t) => /^Ground stop/.test(t)), "it ended before hour 1");
  assert.ok(!texts(hs[1]).some((t) => /^Ground stop/.test(t)));
  assert.ok(texts(o).includes("Convective SIGMET over airport"), "the SIGMET counts as for hour 0");
  assert.ok(!texts(hs[1]).includes("Convective SIGMET over airport"));
  assert.ok(texts(hs[0]).includes("Runway 12/30 closed") && !texts(hs[1]).includes("Runway 12/30 closed"));
  assert.ok(texts(o).includes("Runway 12/30 closed"), "an item with no end counts as for hour 0");
  assert.ok(!texts(o).some((t) => /^(Visibility|Ceiling)/.test(t)), "no TAF weather");
  assert.equal(buildObsHour({ ...base, metar: null }), null);
});
