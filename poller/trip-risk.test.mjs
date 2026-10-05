// Trip concern rules (poller/trip-risk.mjs; site/trip-risk.js is a byte-identical copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { tripStatus, windowAt, programOf, reasonLevel, plainReason, flightLine, rolesAt, delayOf, whenText } from "./trip-risk.mjs";

const H = 3600e3;
// 4:00 PM CDT on a Sunday
const NOW = Date.parse("2026-10-04T21:00:00Z");
const T0 = Math.floor(NOW / H) * H;

/** A status.json-like airport: hours[i] = [level, reasons] for i = 0.. (the rest Clear); extra fields merged. */
function ap(iata, tz, spec = {}, extra = {}) {
  const hours = Array.from({ length: 24 }, (_, i) => {
    const [level, reasons, delay] = spec[i] || [0, []];
    return { t: new Date(T0 + i * H).toISOString(), level, reasons, fltCat: "VFR", ...(delay != null ? { delay } : {}) };
  });
  return { iata, tz, state: "MN", hours, faa: [], atcscc: [], opsplan: null, ...extra };
}
const span = (from, to, v) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, k) => [from + k, v]));
const at = (h, m = 0) => new Date(NOW + h * H + m * 60e3).toISOString();
const by = (...aps) => Object.fromEntries(aps.map((a) => [a.iata, a]));

test("GDP at the destination: flights there are held at the origin", () => {
  const gdp = "Ground delay program — weather (wind), avg 45m, max 1h 30m, until further notice";
  const ORD = ap("ORD", "America/Chicago", span(0, 4, [3, [gdp, "Gusts 28 kt"]]), {
    faa: [{ type: "ground_delay", reason: "wind", detail: "avg 45m, max 1h 30m", cause: "weather", end: null }],
  });
  const MSP = ap("MSP", "America/Chicago");
  // 6:05 PM CDT departure, 7:35 PM arrival
  const trip = { legs: [{ from: "MSP", to: "ORD", dep: at(2, 5), arr: at(3, 35) }] };
  const r = tripStatus(trip, by(ORD, MSP), { now: NOW });
  assert.equal(r.label, "Delays likely");
  assert.equal(r.top, "ORD ground delay program: ORD arrivals are held at their departure airports — your 6:05 PM MSP→ORD departure may wait ~45 min.");
  assert.equal(r.concerns[0].side, "dep", "the wait happens at the departure airport");
  assert.equal(r.sides.dep, 3);
  // the GDP isn't repeated as an ORD weather concern; the wind is, at its own (Moderate) level
  const wx = r.concerns.find((c) => c.kind === "weather" && c.iata === "ORD");
  assert.equal(wx.level, 2);
  assert.match(wx.text, /^Wind gusts to 30 mph at ORD around your 7:35 PM arrival\.$/);
  assert.ok(!r.concerns.some((c) => c.kind === "weather" && /Ground delay/.test(c.text)));
  // the sheet line
  const [line] = flightLine(trip, r, "MSP", "America/Chicago", NOW);
  assert.equal(line.text, "Your scheduled 6:05 PM departure to ORD: delays likely — ORD ground delay program");
  // The scheduled departure passing does not establish takeoff.
  const scheduled = tripStatus(trip, by(ORD, MSP), { now: NOW + 2.5 * H });
  assert.ok(scheduled.concerns.some((c) => /are held/.test(c.text)));
  assert.equal(scheduled.status, "likely");
  assert.equal(scheduled.legs[0].scheduledDepPassed, true);
  assert.equal(scheduled.legs[0].departed, undefined);
});

test("an arrival ground stop at the origin does not establish an outbound restriction", () => {
  const MSP = ap("MSP", "America/Chicago", span(0, 3, [4, ["Ground stop — equipment outage, until 8 PM CT", "Rain"]]), {
    faa: [{ type: "ground_stop", reason: "equipment", detail: "until 8 PM CT", cause: "equipment", end: at(4) }],
  });
  const ATL = ap("ATL", "America/New_York");
  const r = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(1, 30), arr: at(4) }] }, by(MSP, ATL), { now: NOW });
  assert.equal(r.label, "On track");
  assert.equal(r.status, "ok");
  assert.ok(r.concerns.some(c => c.level === 0 && /arrival ground stop/.test(c.text)));
  assert.ok(!r.concerns.some(c => c.kind === "program" && c.side === "dep"));
  // the rain is its own, lower concern
  assert.ok(r.concerns.some((c) => c.kind === "weather" && c.level === 1 && /^Rain at MSP/.test(c.text)));
  assert.deepEqual(r.concerns.map((c) => c.level), [...r.concerns.map((c) => c.level)].sort((a, b) => b - a), "ordered by severity");
});

test("weather severity alone does not claim delays likely or confirmed disruption", () => {
  const flight = { legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4) }] };
  const ATL = ap("ATL", "America/New_York");
  const low = ap("MSP", "America/Chicago", span(0, 4, [3, ["Ceiling 400 ft"], { p: 0.1 }]));
  const r = tripStatus(flight, by(low, ATL), { now: NOW, words: () => "Delays unlikely" });
  assert.equal(r.label, "Weather concerns");
  assert.equal(r.level, 3, "retain weather severity");
  assert.match(r.top, /Very low clouds/);
  assert.equal(tripStatus(flight, by(low, ATL), { now: NOW }).label, "Weather concerns");
  low.hours.forEach(h => { h.delay = { p: 0.7 }; });
  assert.equal(tripStatus(flight, by(low, ATL), { now: NOW, words: () => "Delays likely" }).label, "Delays likely");
  assert.equal(tripStatus(flight, by(low, ATL), { now: NOW, words: () => "Delays possible" }).label, "Weather concerns", "respect calibrated caps");
});

test("destination program scope and exact expiry constrain the affected trip", () => {
  const flight = { legs: [{ from: "MSP", to: "ORD", dep: at(2, 30), arr: at(4) }] };
  const MSP = ap("MSP", "America/Chicago");
  const ORD = ap("ORD", "America/Chicago", span(0, 4, [4, ["Ground stop until 8 PM"]]), {
    faa: [{ type: "ground_stop", end: at(4) }],
    atcscc: [{ type: "GS", active: true, start: at(0), end: at(4), departureScope: { airports: ["JFK"], all: false } }],
  });
  let r = tripStatus(flight, by(MSP, ORD), { now: NOW });
  assert.ok(!r.concerns.some(c => c.kind === "program" && c.iata === "ORD"));
  ORD.atcscc[0].departureScope.airports.push("MSP");
  assert.equal(tripStatus(flight, by(MSP, ORD), { now: NOW }).label, "Disruption");
  ORD.atcscc[0].end = ORD.faa[0].end = at(2, 15);
  assert.ok(!tripStatus(flight, by(MSP, ORD), { now: NOW }).concerns.some(c => c.kind === "program"), "expired mid-hour does not apply");
  ORD.atcscc = []; ORD.faa[0].end = at(4);
  r = tripStatus(flight, by(MSP, ORD), { now: NOW });
  assert.ok(r.concerns.some(c => /scope has not been verified/.test(c.text)), "unknown facility/airline scope remains qualified");
});

test("tight connection at an airport with Moderate risk", () => {
  const MSP = ap("MSP", "America/Chicago");
  const ORD = ap("ORD", "America/Chicago", span(2, 5, [2, ["Thunder chance 25% (LAMP)"]]));
  const ATL = ap("ATL", "America/New_York");
  const legs = (connMin) => [{ from: "MSP", to: "ORD", dep: at(1), arr: at(2, 30) }, { from: "ORD", to: "ATL", dep: at(2, 30 + connMin), arr: at(5) }];
  const r = tripStatus({ legs: legs(45) }, by(MSP, ORD, ATL), { now: NOW });
  assert.equal(r.label, "Possible delays");
  const c = r.concerns.find((x) => x.kind === "connection");
  assert.equal(c.level, 2);
  assert.equal(c.text, "Tight connection at ORD: 45 min to make your 7:15 PM flight to ATL, and ORD is at Moderate risk around then (slight chance of thunderstorms) — a late arrival could mean a missed connection.");
  assert.equal(r.legs[0].conn.minutes, 45);
  assert.equal(r.legs[0].conn.tight, true);
  // weather during the connection is one concern, not separate arrival/departure ones
  assert.equal(r.concerns.filter((x) => x.kind === "weather" && x.iata === "ORD").length, 1);
  assert.match(r.concerns.find((x) => x.kind === "weather" && x.iata === "ORD").text, /during your connection \(6:30–7:15 PM\)/);
  // a 90-minute connection isn't tight
  const r2 = tripStatus({ legs: legs(90) }, by(MSP, ORD, ATL), { now: NOW });
  assert.ok(!r2.concerns.some((x) => x.kind === "connection"));
  // tight but all clear: no flag (only a note when under 30 min)
  const clear = by(MSP, ap("ORD", "America/Chicago"), ATL);
  assert.ok(!tripStatus({ legs: legs(45) }, clear, { now: NOW }).concerns.some((x) => x.kind === "connection"));
  assert.equal(tripStatus({ legs: legs(25) }, clear, { now: NOW }).concerns.find((x) => x.kind === "connection").level, 1);
  // a delay program at the connection makes it High
  const gdpOrd = ap("ORD", "America/Chicago", span(0, 5, [3, ["Ground delay program until 9 PM"]]), { faa: [{ type: "ground_delay", detail: "avg 30m", end: at(5) }] });
  const r3 = tripStatus({ legs: legs(45) }, by(MSP, gdpOrd, ATL), { now: NOW });
  assert.equal(r3.concerns.find((x) => x.kind === "connection").level, 3);
  assert.match(r3.concerns.find((x) => x.kind === "connection").text, /ORD has a ground delay program in effect/);
});

test("all clear", () => {
  const r = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4, 30) }] }, by(ap("MSP", "America/Chicago"), ap("ATL", "America/New_York")), { now: NOW });
  assert.equal(r.label, "On track");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.concerns, []);
  assert.equal(r.top, "No weather or FAA issues expected around your flight times.");
  assert.equal(r.legs[0].depAt.level, 0);
  assert.equal(r.legs[0].arrAt.level, 0);
});

test("delay chance (Phase 3 hours[i].delay) is used when present and ignored otherwise", () => {
  const MSP = ap("MSP", "America/Chicago", span(1, 3, [2, ["Ceiling 800 ft"], { p: 0.45, minutes: 30, basis: "model" }]));
  const r = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4) }] }, by(MSP, ap("ATL", "America/New_York")), { now: NOW });
  assert.equal(r.concerns[0].text, "Low clouds at MSP around your 6 PM departure — delays likely.");
  // the page's calibrated words (site/delay.js likelihood) replace the built-in mapping; never a percentage
  const r2 = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4) }] }, by(MSP, ap("ATL", "America/New_York")), { now: NOW, words: () => "Delays possible" });
  assert.equal(r2.concerns[0].text, "Low clouds at MSP around your 6 PM departure — delays possible.");
  assert.ok(!/%/.test(r.top + r.concerns.map((c) => c.text).join(" ")));
  assert.equal(r.legs[0].depAt.delay.p, 0.45);
  const plain = ap("MSP", "America/Chicago", span(1, 3, [2, ["Ceiling 800 ft"]]));
  assert.equal(tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4) }] }, by(plain, ap("ATL", "America/New_York")), { now: NOW }).concerns[0].text,
    "Low clouds at MSP around your 6 PM departure.");
  assert.deepEqual(delayOf({ delay: 0.3 }), { p: 0.3, minutes: null, override: null });
  assert.equal(delayOf({ delay: null }), null);
  assert.equal(delayOf({}), null);
});

test("beyond the 24-hour forecasts: too early to tell", () => {
  const r = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(50), arr: at(52) }] }, by(ap("MSP", "America/Chicago"), ap("ATL", "America/New_York")), { now: NOW });
  assert.equal(r.label, "Too early to tell");
  assert.match(r.top, /^Airport forecasts cover the next 24 hours — check back after Mon 6 PM\.$/);
  // airports missing from the data are stated
  const m = tripStatus({ legs: [{ from: "MSP", to: "XYZ", dep: at(2), arr: at(4) }] }, by(ap("MSP", "America/Chicago")), { now: NOW });
  assert.deepEqual(m.missing, ["XYZ"]);
  assert.ok(m.concerns.some((c) => c.text === "No FAA or weather data for XYZ in this update yet."));
});

test("ops plan: possible ground stop at the destination and staffing at the origin", () => {
  const ORD = ap("ORD", "America/Chicago", span(0, 4, [2, ["FAA plans a possible ground stop until 7 PM (storms)"]]), {
    opsplan: { items: [{ kind: "program", level: 2, text: "FAA plans a possible ground stop until 7 PM (storms)", until: at(3) }] },
  });
  const MSP = ap("MSP", "America/Chicago", span(0, 3, [2, ["Air traffic control staffing shortage until 8 PM — delays possible"]]), {
    opsplan: { items: [{ kind: "staffing", level: 2, text: "Air traffic control staffing shortage until 8 PM — delays possible", until: at(4) }] },
  });
  const r = tripStatus({ legs: [{ from: "MSP", to: "ORD", dep: at(1), arr: at(2, 20) }] }, by(ORD, MSP), { now: NOW });
  const texts = r.concerns.map((c) => c.text);
  assert.ok(texts.includes("FAA plans a possible ground stop at ORD until 7 PM (storms) — your 5 PM MSP→ORD flight could be held before takeoff."), texts.join("\n"));
  assert.ok(texts.includes("Air traffic control staffing shortage at MSP until 8 PM — your 5 PM departure may be delayed."), texts.join("\n"));
  assert.equal(r.label, "Possible delays");
  assert.ok(!r.concerns.some((c) => c.kind === "weather"), "program reasons aren't repeated as weather");
});

test("reason helpers", () => {
  assert.deepEqual(programOf("Ground stop — weather (thunderstorms), until 8 PM CT"), { kind: "gs", level: 4 });
  assert.deepEqual(programOf("Delays — weather (wind), arrivals 31–45m"), { kind: "delay", level: 2 });
  assert.equal(programOf("Thunderstorms"), null);
  assert.equal(reasonLevel("Heavy thunderstorms"), 4);
  assert.equal(reasonLevel("Thunderstorms nearby"), 3);
  assert.equal(reasonLevel("Chance of thunderstorms"), 2);
  assert.equal(reasonLevel("Ceiling 400 ft"), 3);
  assert.equal(reasonLevel("Visibility 2 sm"), 2);
  assert.equal(reasonLevel("Gusts 38 kt"), 3);
  assert.equal(reasonLevel("Winter Storm Warning until Sun 7:25 AM"), 3);
  assert.equal(reasonLevel("Mist"), 1);
  assert.equal(plainReason("Ceiling 2,800 ft"), null);
  assert.equal(plainReason("Gusts 38 kt"), "Wind gusts to 45 mph");
  assert.equal(plainReason("Thunder chance 45% (LAMP)"), "Chance of thunderstorms");
  assert.equal(plainReason("Thunder chance 65% (LAMP) forecast 5–7 PM"), "Thunderstorms likely forecast 5–7 PM");
  assert.equal(plainReason("Thunder chance 20% (LAMP)"), "Slight chance of thunderstorms");
  const w = windowAt(ap("DEN", "America/Denver", { 3: [3, ["Heavy snow", "Mist"]] }), NOW + 3 * H);
  assert.equal(w.level, 3);
  assert.deepEqual(w.reasons, ["Heavy snow", "Light fog / haze"]);
  assert.equal(windowAt(ap("DEN", "America/Denver"), NOW + 40 * H), null);
  assert.equal(whenText(NOW + 2 * H, "America/Chicago", NOW), "6 PM");
  assert.deepEqual(rolesAt({ legs: [{ from: "A", to: "B", dep: 1, arr: 2 }, { from: "B", to: "C", dep: 3, arr: 4 }] }, "B").map((x) => x.role), ["conn"]);
});

test("site/trip-risk.js is a byte-identical copy of poller/trip-risk.mjs", async () => {
  const a = await readFile(new URL("./trip-risk.mjs", import.meta.url), "utf8");
  const b = await readFile(new URL("../site/trip-risk.js", import.meta.url), "utf8");
  assert.equal(b, a, "run: cp poller/trip-risk.mjs site/trip-risk.js");
});

const Outlook = createRequire(import.meta.url)("../site/outlook.js");
const healthySources = Object.fromEntries(["faa", "atcscc", "metar", "taf", "nws"].map((k) => [k, { ok: true }]));
const healthFor = (more = {}) => (a) => Outlook.health(a, { now: NOW, generated: at(0), sources: healthySources, ...more });
const healthyAirport = (code) => ap(code, "America/Chicago", {}, { metar: { obsTime: at(0) }, taf: { issued: at(0) } });
const quietTrip = { legs: [{ from: "MSP", to: "ATL", dep: at(2), arr: at(4) }] };

test("shared airport health: complete fresh Trips stay green, stale or failed sources do not", () => {
  const airports = by(healthyAirport("MSP"), healthyAirport("ATL"));
  assert.equal(tripStatus(quietTrip, airports, { now: NOW, health: healthFor() }).status, "ok");
  for (const opts of [{ generated: at(-1) }, { generated: "invalid" }, { sample: true }, ...["faa", "atcscc", "metar", "taf", "nws"].flatMap((k) => [
    { sources: { ...healthySources, [k]: { ok: false } } },
    { sources: { ...healthySources, [k]: { ok: true, error: "Partial fetch failure" } } },
    { sources: { ...healthySources, [k]: { ok: true, stale: true } } },
  ])]) {
    const r = tripStatus(quietTrip, airports, { now: NOW, health: healthFor(opts) });
    assert.equal(r.status, "unknown", JSON.stringify(opts));
    assert.equal(r.cls, "off");
    assert.ok(r.quality);
    assert.equal(r.legs[0].depAt.level, null);
    assert.equal(r.sides.dep, null);
    assert.ok(!/No weather or FAA issues expected/.test(r.top));
  }
});

test("shared airport health: FAA advisories may lag up to 3 h while the live FAA status is fresh", () => {
  const airports = by(healthyAirport("MSP"), healthyAirport("ATL"));
  const src = (adv, faa = at(0)) => ({ sources: { ...healthySources, faa: { ok: true, at: faa }, atcscc: { ok: true, at: adv } } });
  assert.equal(tripStatus(quietTrip, airports, { now: NOW, health: healthFor(src(at(-2))) }).status, "ok");
  assert.ok(Outlook.health(healthyAirport("MSP"), { now: NOW, generated: at(0), ...src(at(-2)) }).advisoriesAge >= 2 * 3600e3 - 1);
  assert.equal(tripStatus(quietTrip, airports, { now: NOW, health: healthFor(src(at(-4))) }).status, "unknown");
  assert.equal(tripStatus(quietTrip, airports, { now: NOW, health: healthFor(src(at(-2), at(-1))) }).status, "unknown"); // FAA status itself stale
});

test("shared airport health: observation gaps affect the relevant airport, not every airport", () => {
  for (const metar of [null, { obsTime: "invalid" }, { obsTime: at(-3) }]) {
    const r = tripStatus(quietTrip, by(healthyAirport("MSP"), { ...healthyAirport("ATL"), metar }), { now: NOW, health: healthFor() });
    assert.equal(r.status, "unknown");
    assert.deepEqual(r.qualifications.map((q) => q.iata), ["ATL"]);
    assert.equal(r.legs[0].depAt.level, 0);
    assert.equal(r.legs[0].arrAt.level, null);
    assert.equal(r.sides.arr, null);
    assert.equal(r.sides.dep, 0);
  }
});

test("shared airport health: known disruption and weather survive stale/source qualifications", () => {
  const airport = ap("MSP", "America/Chicago", span(0, 4, [4, ["Airport closed until 8 PM CT", "Rain"]]), {
    metar: { obsTime: at(0) }, taf: { issued: at(0) }, faa: [{ type: "closure", detail: "until 8 PM CT", end: at(4) }],
  });
  for (const opts of [{ generated: at(-1) }, { sources: { ...healthySources, taf: { ok: false } } }]) {
    const r = tripStatus(quietTrip, by(airport, healthyAirport("ATL")), { now: NOW, health: healthFor(opts) });
    assert.equal(r.status, "disruption");
    assert.equal(r.level, 4);
    assert.equal(r.sides.dep, 4);
    assert.equal(r.legs[0].depAt.level, 4);
    assert.match(r.top, /closed/);
    assert.ok(r.concerns.some((c) => c.kind === "weather"));
    assert.ok(r.concerns.some((c) => c.kind === "note" && c.quality));
  }
});

test("partial airport and flight-hour coverage never imply an all-clear trip", () => {
  const missing = tripStatus(quietTrip, by(healthyAirport("MSP")), { now: NOW, health: healthFor() });
  assert.equal(missing.status, "unknown");
  assert.deepEqual(missing.missing, ["ATL"]);
  const edge = { legs: [{ from: "MSP", to: "ATL", dep: at(22), arr: at(24) }] };
  const r = tripStatus(edge, by(healthyAirport("MSP"), healthyAirport("ATL")), { now: NOW, health: healthFor() });
  assert.equal(r.status, "unknown", "a neighbouring hour isn't coverage for the scheduled flight hour");
  assert.equal(r.legs[0].arrAt.level, null);
  assert.equal(r.sides.arr, null);
  assert.match(r.top, /no forecast/);
});

test("optional notice source failures qualify quiet Trips; absent notice source keys do not", () => {
  const airports = by(healthyAirport("MSP"), healthyAirport("ATL"));
  assert.equal(tripStatus(quietTrip, airports, { now: NOW, health: healthFor() }).status, "ok");
  const r = tripStatus(quietTrip, airports, { now: NOW, health: healthFor({ noticesDown: true }) });
  assert.equal(r.status, "unknown");
  assert.match(r.concerns[0].text, /flight restrictions unavailable/);
});

test("real source-outage and stale-data scenarios qualify Trips just like the airport sheet", async () => {
  for (const name of ["source-outage", "stale-data"]) {
    const d = JSON.parse(await readFile(new URL(`../site/data/scenarios/${name}.json`, import.meta.url), "utf8"));
    const now = Date.parse(d.generated) + (name === "stale-data" ? 50 * 60000 : 0);
    const get = by(...d.airports);
    const trip = { legs: [{ from: "MSP", to: "SEA", dep: now + H, arr: now + 2 * H }] };
    const health = (a) => Outlook.health(a, { now, generated: d.generated, sources: d.sources });
    const r = tripStatus(trip, get, { now, health });
    assert.equal(r.status, "unknown", name);
    assert.notEqual(r.cls, "l0");
    assert.equal(r.qualifications[0].quality, Outlook.evaluate(get.MSP, { now, generated: d.generated, sources: d.sources }).quality);
  }
});

test("scheduled departure and arrival passing never confirms progress or suppresses covered disruption", () => {
  const MSP = ap("MSP", "America/Chicago", span(0, 5, [4, ["Airport closed until 9 PM CT"]]));
  const ATL = ap("ATL", "America/New_York");
  const trip = { legs: [{ from: "MSP", to: "ATL", dep: at(1), arr: at(3) }] };
  for (const h of [0, 1, 1.5, 3, 3.75, 6]) {
    const r = tripStatus(trip, by(MSP, ATL), { now: NOW + h * H });
    assert.equal(r.status, "disruption", `at schedule+${h}h`);
    assert.match(r.top, /MSP is closed/);
    assert.equal(r.legs[0].scheduledDepPassed, h >= 1);
    assert.equal(r.legs[0].scheduledArrPassed, h >= 3);
    assert.equal(r.legs[0].landed, undefined);
    assert.equal(r.legs[0].departed, undefined);
    assert.match(r.scheduleNote, /[Aa]ctual flight status.*unavailable/);
    assert.ok(!/This trip has landed|Arrived|Landed|Departed/.test(r.label + r.top));
  }
});

test("quiet recent schedules are unconfirmed, days-old schedules are neutral and archived", () => {
  const trip = { legs: [{ from: "MSP", to: "ATL", dep: at(1), arr: at(3) }] };
  const aps = by(ap("MSP", "America/Chicago"), ap("ATL", "America/New_York"));
  assert.equal(tripStatus(trip, aps, { now: NOW }).status, "ok");
  for (const h of [1, 1.5, 3, 4]) {
    const r = tripStatus(trip, aps, { now: NOW + h * H });
    assert.equal(r.status, "scheduled");
    assert.equal(r.label, "Flight status unconfirmed");
    assert.equal(r.cls, "off");
    assert.match(r.top, /actual flight progress is unconfirmed/);
  }
  const expired = tripStatus(trip, { MSP: ap("MSP", "America/Chicago", {}, { hours: [] }), ATL: ap("ATL", "America/New_York", {}, { hours: [] }) }, { now: NOW + 4 * H });
  assert.equal(expired.status, "unknown");
  assert.match(expired.top, /coverage.*expired/);
  assert.ok(!/check back after/.test(expired.top));
  const old = tripStatus(trip, by(ap("MSP", "America/Chicago", span(0, 5, [4, ["Ground stop until 9 PM"]])), aps.ATL), { now: NOW + 28 * H });
  assert.equal(old.status, "past");
  assert.equal(old.level, 0);
  assert.match(old.top, /actual arrival is unconfirmed/);
  assert.deepEqual(old.concerns, []);
  assert.equal(old.legs[0].depAt, null);
});

test("past scheduled times cannot inherit a program first reported in later forecast hours", () => {
  const ORD = ap("ORD", "America/Chicago", span(0, 5, [4, ["Ground stop until 9 PM"]]));
  const r = tripStatus({ legs: [{ from: "MSP", to: "ORD", dep: at(-4), arr: at(-2) }] }, by(ap("MSP", "America/Chicago"), ORD), { now: NOW });
  assert.equal(r.status, "unknown");
  assert.ok(!r.concerns.some((c) => c.kind === "program"));
});


test("connection remains a schedule-based assessment after its planned arrival/departure", () => {
  const legs = [{ from: "MSP", to: "ORD", dep: at(1), arr: at(2, 30) }, { from: "ORD", to: "ATL", dep: at(3, 15), arr: at(5) }];
  const aps = by(ap("MSP", "America/Chicago"), ap("ORD", "America/Chicago", span(2, 4, [2, ["Snow"]])), ap("ATL", "America/New_York"));
  const r = tripStatus({ legs }, aps, { now: NOW + 4 * H });
  assert.equal(r.legs[0].scheduledArrPassed, true);
  assert.equal(r.legs[1].scheduledDepPassed, true);
  assert.equal(r.legs[0].conn.minutes, 45, "connection minutes remain a difference of schedules, not measured remaining time");
  assert.equal(r.status, "possible");
  assert.match(r.concerns.find(c => c.kind === "connection").text, /a late arrival could mean a missed connection/);
  const line = flightLine({ legs }, r, "ORD", "America/Chicago", NOW + 4 * H)[0];
  assert.match(line.text, /^Your scheduled connection/);
  assert.match(r.scheduleNote, /Actual flight status is unavailable/);
});

test("advisory-only storms do not claim an overhead observation", () => {
 assert.equal(plainReason("Convective SIGMET over airport until 9 PM"), "Storms near the airport");
});
