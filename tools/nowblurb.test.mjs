import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const B = createRequire(import.meta.url)("../site/nowblurb.js");

const H = 3600000;
const now = Date.parse("2026-10-06T22:10:00Z"); // 4:10 PM in Denver (MDT), 5:10 PM in Chicago
const tz = "America/Chicago";
const hourStart = Math.floor(now / H) * H;
const levels = (...lv) => lv.map((level, i) => ({ t: new Date(hourStart + i * H).toISOString(), level }));
const base = (more = {}) => ({ aviation: false, now, tz, level: 0, kind: "normal", headline: "Operating normally", reasons: [], warnings: [], storms: null,
  cond: { windMph: 8, gustMph: null, visMi: 10, ceilingFt: null }, levels: levels(...Array(24).fill(0)), events: [], ...more });
const all = [];
const build = (x) => { const r = B.build(x); all.push({ x, r }); return r; };

test("nowblurb: a clear, quiet airport adds no routine commentary", () => {
  const r = build(base());
  assert.equal(r.specifics, "");
  const w = build(base({ level: 1, kind: "forecast", headline: "Strong winds", reasons: ["Wind gusts to 30 mph"], warnings: ["Wind Advisory"], levels: levels(1, 1, 0) }));
  assert.equal(w.specifics, "Wind gusts to 30 mph. Wind Advisory in effect.");
  assert.equal(w.trend, "Expected to clear after about 7 PM.");
  assert.equal(r.trend, "");
  assert.equal(r.improvement, false);
});

test("nowblurb: quiet status keeps concrete warnings and changes, without generic storm commentary", () => {
  assert.equal(build(base({ storms: { spc: "TSTM" } })).specifics, "");
  assert.equal(build(base({ warnings: ["Wind Advisory"] })).specifics, "Wind Advisory in effect.");
  assert.match(build(base({ levels: levels(0, 0, 3, 3) })).trend, /May get worse/);
  assert.match(build(base({ aviation: true })).specifics, /Light winds and good visibility/);
});

test("nowblurb: storms with a nearby alert, the severe-storm outlook and the air-traffic storm forecast", () => {
  const r = build(base({ level: 3, kind: "forecast", headline: "Storms near the airport", reasons: ["Storms near the airport until 5 PM", "Thunderstorm wind gusts to 50 mph"],
    storms: { near: true, until: now + 82 * 60000, spc: "ENH", tcf: [{ coverage: "medium", valid: new Date(hourStart + 2 * H).toISOString() }] },
    warnings: ["Severe Thunderstorm Warning"], levels: levels(3, 3, 1, 1, 0, 0, 0, 0), recovery: hourStart + 2 * H }));
  assert.equal(r.specifics, "Thunderstorm advisory near the airport until 6:32 PM; severe storms possible today (enhanced risk)."); // the gusts are in the conditions line
  assert.doesNotMatch(r.specifics, /Storms near the airport/); // the headline isn't repeated
  assert.equal(r.trend, "Expected to improve after about 7 PM.");
  assert.equal(r.improvement, true);
  const av = build({ ...all[all.length - 1].x, aviation: true });
  assert.match(av.specifics, /Convective SIGMET over or within 10 nm until 6:32 PM; SPC Enhanced risk \(level 3 of 5\)/);
  assert.equal(av.trend, "Forecast drops to Low or Clear after 7 PM.");
});

test("nowblurb: a ground stop with a scheduled end eases when its hours end", () => {
  const r = build(base({ level: 4, kind: "active", headline: "Ground Stop", programText: "Arrivals are held at their departure airports (thunderstorms)",
    reasons: ["Heavy thunderstorms"], levels: levels(4, 4, 4, 2, 2, 1, 0), events: [{ t: new Date(now - 70 * 60000).toISOString(), kind: "level", from: 2, to: 4 }] }));
  assert.equal(r.specifics, "Arrivals are held at their departure airports (thunderstorms). Heavy thunderstorms.");
  assert.equal(r.trend, "Worse since 4:00 PM; expected to ease to Moderate after about 8 PM.");
});

test("nowblurb: a ground stop without an end time never promises one", () => {
  const r = build(base({ level: 4, kind: "active", headline: "Ground Stop", programText: "Arrivals are held at their departure airports (equipment)", open: true, weatherCause: false,
    levels: levels(4, 0, 0, 0) }));
  assert.equal(r.trend, "");
  assert.equal(r.improvement, false);
  const w = build(base({ level: 4, kind: "active", headline: "Ground Stop", programText: "Arrivals are held at their departure airports (thunderstorms)", open: true, weatherCause: true,
    recovery: hourStart + 3 * H, levels: levels(4, 3, 3, 0) }));
  assert.equal(w.trend, "Weather expected to improve after about 8 PM.");
});

test("nowblurb: High fog that is improving says since when and what comes next", () => {
  const r = build(base({ level: 2, kind: "forecast", headline: "Dense fog", reasons: ["Dense fog", "Very low clouds"], cond: { windMph: 3, visMi: 0.25, ceilingFt: 200 },
    levels: levels(2, 2, 2, 0, 0), recovery: hourStart + 3 * H, events: [{ t: new Date(now - 32 * 60000).toISOString(), kind: "level", from: 3, to: 2 }] }));
  assert.equal(r.specifics, "Very low clouds."); // "Dense fog" is the headline itself
  assert.equal(r.trend, "Improving since 4:38 PM; expected to improve after about 8 PM.");
});

test("nowblurb: steady forecasts add no commentary; meaningful worsening stays visible", () => {
  const r = build(base({ level: 3, kind: "forecast", headline: "Winter weather", reasons: ["Heavy snow, poor visibility"], levels: levels(...Array(24).fill(3)) }));
  assert.equal(r.trend, "");
  const worse = build(base({ level: 2, kind: "forecast", headline: "Winter weather", reasons: ["Snow"], levels: levels(2, 2, 3, 3, 2) }));
  assert.equal(worse.trend, "May get worse after about 7 PM.");
  const split = build(base({ level: 1, kind: "forecast", headline: "Disruption possible", reasons: ["Light snow"], laterPeak: true, levels: levels(1, 1, 3, 3) }));
  assert.equal(split.trend, "May get worse later."); // the window itself is in Looking ahead
});

test("nowblurb: stale data and a missing forecast are stated, never a quiet all good", () => {
  const stale = build(base({ level: null, kind: "unknown", headline: "Status may be outdated", quality: "Data may be outdated", stale: true }));
  assert.equal(stale.trend, "");
  assert.match(stale.specifics, /may be outdated/);
  assert.doesNotMatch(stale.specifics, /no FAA delays/);
  const missing = build(base({ level: null, kind: "unknown", headline: "No disruptions reported", quality: "Storm data unavailable" }));
  assert.match(missing.specifics, /^Storm reports couldn't be checked/);
  assert.equal(missing.trend, "");
});

test("nowblurb: forecast coverage that stops is said, never read as clear", () => {
  const r = build(base({ level: 0, levels: levels(0, 0, 0, null, null) }));
  assert.equal(r.trend, "No forecast beyond 8 PM.");
  const none = build(base({ level: null, kind: "unknown", headline: "Forecast unavailable for this time", noForecast: true, levels: levels(null, null) }));
  assert.equal(none.trend, "");
  const far = build(base({ level: 0, levels: levels(...Array(20).fill(0), null) }));
  assert.equal(far.trend, ""); // the last hours of the window aren't news
  const farHigh = build(base({ level: 4, kind: "forecast", headline: "Storms near the airport", reasons: ["Heavy thunderstorms"], levels: levels(...Array(14).fill(4), null) }));
  assert.equal(farHigh.trend, ""); // an unknown hour is never an improvement
  const tmw = build(base({ level: 3, kind: "forecast", headline: "Winter weather", reasons: ["Heavy snow"], recovery: hourStart + 20 * H, levels: levels(...Array(20).fill(3), 0, 0) }));
  assert.equal(tmw.trend, "Expected to improve after tomorrow 1 PM."); // never "after about tomorrow"
  const av = build(base({ aviation: true, level: 0, levels: levels(0, 0, null) }));
  assert.equal(av.trend, "TAF coverage ends 7 PM.");
});

test("nowblurb: long specifics drop whole low-priority fragments, never cut mid-sentence", () => {
  const r = build(base({ level: 3, kind: "active", headline: "Arrivals delayed", programText: "Arrivals are held at their departure airports: about 1 hr 10 min on average (snow and ice)",
    reasons: ["Heavy snow, poor visibility", "Very low clouds", "Wind gusts to 35 mph"], warnings: ["Winter Storm Warning", "Wind Advisory"],
    storms: { spc: "SLGT", tcf: [{ coverage: "low" }] }, levels: levels(3, 3, 3) }));
  const snow = build({ ...all[all.length - 1].x, programText: "Arrivals are held at their departure airports (snow and ice)", storms: null, warnings: [] });
  assert.equal(snow.specifics, "Arrivals are held at their departure airports (snow and ice). Heavy snow, poor visibility.");
  assert.ok(r.specifics.length <= 105, r.specifics);
  assert.match(r.specifics, /^Arrivals are held at their departure airports: about 1 hr 10 min on average \(snow and ice\)\.( |$)/); // the program, then whole fragments
  assert.match(r.specifics, /\.$/);
});

test("nowblurb: Traveler strings carry no raw codes, no % and no certainty words", () => {
  const trav = all.filter((c) => !c.x.aviation);
  assert.ok(trav.length >= 10);
  for (const { r } of trav) {
    for (const s of [r.specifics, r.trend]) {
      assert.doesNotMatch(s, B.CODES, s);
      assert.doesNotMatch(s, /%/, s);
      assert.doesNotMatch(s, B.CERTAIN, s);
      assert.doesNotMatch(s, /\b\d{1,2}:?\d\dZ\b/, s);
    }
  }
  // Aviation mode may name the products
  assert.ok(all.some((c) => c.x.aviation && /SIGMET|SPC|TCF|TAF/.test(c.r.specifics + c.r.trend)));
});
