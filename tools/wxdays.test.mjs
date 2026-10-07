// Weather page Today / Tomorrow rows (site/wxdays.js days()): coverage from the TAF itself, gaps, TEMPO/PROB folding,
// ranges and the airport's local midnight.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const W = createRequire(import.meta.url)("../site/wxdays.js");
const H = 3600000;
const iso = (t) => new Date(t).toISOString();
const cond = (o = {}) => ({ wind: { dir: o.dir ?? 180, spd: o.spd ?? 10 }, gust: o.gust ?? null, visib: o.vis ?? 6, visibilityAbove: o.vis == null,
  ceiling: o.cig ?? null, wx: o.wx ?? null, clouds: o.clouds ?? [{ cover: "FEW", base: 5000 }], fltCat: o.cat ?? "VFR" });
const per = (from, to, o, kind = "prevailing", probability) => ({ from: iso(from), to: iso(to), kind, ...(probability != null ? { probability } : {}), cond: cond(o) });
// 24 hourly hours from the current hour; the app marks hours past the TAF's end level null
const hoursTo = (now, end) => Array.from({ length: 24 }, (_, i) => { const t = Math.floor(now / H) * H + i * H; return { t: iso(t), level: t < end ? 0 : null, wspd: 5 }; });

test("wxdays: the airport's local midnight splits Today and Tomorrow (Los Angeles, Honolulu)", () => {
  const now = Date.parse("2026-10-07T05:30:00Z"); // 10:30 PM PDT Oct 6; 7:30 PM HST Oct 6
  const periods = [per(now - H, now + 26 * H, {})];
  const la = W.days({ now, tz: "America/Los_Angeles", periods });
  assert.equal(la[0].label, "Today"); assert.equal(la[0].end, Date.parse("2026-10-07T07:00:00Z"));
  assert.equal(la[1].start, Date.parse("2026-10-07T07:00:00Z")); assert.equal(la[1].end, Date.parse("2026-10-08T07:00:00Z"));
  assert.equal(la[0].hours, 2); // 10:30 PM slot and 11 PM
  const hnl = W.days({ now, tz: "Pacific/Honolulu", periods });
  assert.equal(hnl[0].end, Date.parse("2026-10-07T10:00:00Z")); assert.equal(hnl[1].end, Date.parse("2026-10-08T10:00:00Z"));
  assert.equal(hnl[0].hours, 5);
  // the TAF ends 07:30 UTC Oct 8 = 12:30 AM PDT Oct 8 (after LA's tomorrow) but 9:30 PM HST Oct 7 (inside Honolulu's)
  assert.equal(la[1].until, null); assert.equal(hnl[1].until, now + 26 * H);
});

test("wxdays: a TAF past the app's 24-hour window still covers tomorrow (the MSP bug)", () => {
  const now = Date.parse("2026-10-07T00:10:00Z"); // 7:10 PM CDT
  const end = Date.parse("2026-10-08T06:00:00Z"); // Thu 1 AM CDT
  const periods = [per(Date.parse("2026-10-07T00:00:00Z"), Date.parse("2026-10-07T16:00:00Z"), { spd: 6 }),
    per(Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T02:00:00Z"), { spd: 10, gust: 22, dir: 300 }),
    per(Date.parse("2026-10-08T02:00:00Z"), end, { spd: 6, dir: 300 })];
  const hours = hoursTo(now, now + 24 * H).map((x, i) => (i >= 20 ? { ...x, level: null } : x)); // hours past the window's end unknown
  const [today, tomorrow] = W.days({ now, tz: "America/Chicago", periods, hours });
  assert.equal(today.none, undefined); assert.equal(today.until, null);
  assert.equal(tomorrow.none, undefined);
  assert.equal(tomorrow.until, null, "the TAF reaches past tomorrow's midnight (1 AM Thu), so tomorrow is fully covered");
  assert.deepEqual(tomorrow.gaps, []);
  assert.doesNotMatch(tomorrow.summary, /unavailable|No forecast/);
  // a TAF ending before tomorrow's midnight: covered "through" its real end
  const short = W.days({ now, tz: "America/Chicago", periods: periods.slice(0, 2), hours })[1];
  assert.equal(short.until, Date.parse("2026-10-08T02:00:00Z"));
  // nothing covers tomorrow: "No forecast", with the TAF end when it ended before tomorrow began
  const none = W.days({ now, tz: "America/Chicago", periods: [per(now - H, Date.parse("2026-10-07T04:00:00Z"), {})] })[1];
  assert.equal(none.none, true); assert.equal(none.noAfter, Date.parse("2026-10-07T04:00:00Z"));
});

test("wxdays: a gap between TAF periods is reported with its exact window, not filled", () => {
  const now = Date.parse("2026-10-07T15:00:00Z"); // 10 AM CDT
  const periods = [per(now - H, now + 3 * H, {}), per(now + 5 * H, now + 30 * H, {})];
  const [today] = W.days({ now, tz: "America/Chicago", periods, hours: hoursTo(now, now + 3 * H) });
  assert.deepEqual(today.gaps, [{ from: now + 3 * H, to: now + 5 * H }]);
  // hourly conditions fill only time no TAF period covers (here the app has them for the gap)
  const filled = W.days({ now, tz: "America/Chicago", periods, hours: hoursTo(now, now + 24 * H) })[0];
  assert.deepEqual(filled.gaps, []);
});

test("wxdays: TEMPO and PROB fold into the summary; ranges are min–max over covered hours", () => {
  const now = Date.parse("2026-10-07T14:00:00Z"); // 9 AM CDT
  const m1 = Date.parse("2026-10-08T05:00:00Z"); // local midnight
  const periods = [
    per(now - H, now + 6 * H, { spd: 8, dir: 200, clouds: [{ cover: "SCT", base: 4000 }] }),
    per(now + 4 * H, now + 6 * H, { spd: 8, dir: 200, gust: 30, vis: 1, wx: "TSRA", cig: 1500, cat: "IFR", clouds: [{ cover: "BKN", base: 1500, type: "CB" }] }, "TEMPO"),
    per(now + 6 * H, now + 30 * H, { spd: 15, dir: 290, clouds: [] }),
    per(m1 - 2 * H, m1, { spd: 15, dir: 290, vis: 0.25, wx: "FG", cig: 200, cat: "LIFR", clouds: [{ cover: "VV", base: 200 }] }, "PROB", 30),
  ];
  const [today] = W.days({ now, tz: "America/Chicago", periods });
  assert.equal(today.summary, "Partly cloudy, then clear, at times thunderstorms in the afternoon, chance of fog overnight");
  assert.equal(today.wind.text, "S to W 9–17 mph");
  assert.equal(today.gust, 35); // TEMPO gust 30 kt
  assert.equal(today.vis, 1, "TEMPO visibility counts; the PROB group's 1/4 mile does not");
  assert.equal(today.cig, 1500);
  assert.equal(today.fltCat, "IFR");
  assert.equal(today.kind, "thunder"); assert.equal(today.emoji, "⛈️");
  assert.ok(today.hot.length >= 2);
  assert.doesNotMatch(today.summary, /%|TEMPO|PROB|possible|likely/);
});

test("wxdays: classifier and emoji (night versions; wind only when otherwise quiet)", () => {
  assert.equal(W.kind({ wx: "+TSRA" }, []), "thunder");
  assert.equal(W.kind({ wx: "-FZRA" }, ["OVC"]), "freezing");
  assert.equal(W.kind({ wx: "-SN BR" }, ["OVC"]), "snow");
  assert.equal(W.kind({ wx: "VCSH" }, ["SCT"]), "showers");
  assert.equal(W.kind({ wx: "BR", vis: 4 }, ["OVC"]), "fog");
  assert.equal(W.kind({ wgst: 25 }, ["FEW"]), "wind");
  assert.equal(W.kind({}, W.coversOf("METAR KORD 062351Z 20007KT 10SM FEW250 21/06 A2990 RMK AO2")), "few");
  assert.equal(W.kind({}, W.coversOf("METAR X 10SM CLR")), "clear");
  assert.equal(W.emoji("clear", true), "🌙"); assert.equal(W.emoji("clear", false), "☀️"); assert.equal(W.emoji("sct", false), "⛅");
  assert.equal(W.wxWords("+SN BLSN FZFG"), "Heavy snow, freezing fog");
  // sun: Chicago at local noon is day, at local midnight is night
  assert.equal(W.nightAt(41.98, -87.9, Date.parse("2026-10-07T17:00:00Z"), "America/Chicago"), false);
  assert.equal(W.nightAt(41.98, -87.9, Date.parse("2026-10-07T05:00:00Z"), "America/Chicago"), true);
});
