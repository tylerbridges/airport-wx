// Full closures and FAA programs hold their whole window (risk.mjs closureSpan / buildHours, delay.mjs
// overrides, site/delay.js likelihood, trip-risk.mjs), and the FAA XML carries the closure's times.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHours, closureSpan, hoursOutput } from "./risk.mjs";
import { overrides } from "./delay.mjs";
import { parseFaaXml } from "./lib.mjs";
import { tripStatus } from "./trip-risk.mjs";

globalThis.window ??= {};
const D = await import("../site/delay.js");

const H = 3600e3;
const NOW = new Date("2026-09-10T18:30:00Z"); // 2:30 PM EDT
const T0 = Date.parse("2026-09-10T18:00:00Z");
const TZ = "America/New_York";
const closure = (startH, endH, extra = {}) => ({
  type: "closure", scope: "full", active: startH <= 0, reason: "!MIA 09/101 MIA AD AP CLSD", detail: "",
  start: startH == null ? null : new Date(+NOW + startH * H).toISOString(), end: endH == null ? null : new Date(+NOW + endH * H).toISOString(), ...extra,
});
const reasonsOf = (hours) => hours.map((h) => h.items.map((i) => i.text).find((t) => /^Airport closed/.test(t)) || null);

test("closureSpan: start through reopening; permanent; no end -> hour 0; over or limited -> none", () => {
  assert.deepEqual(closureSpan(closure(-3, 8.5), NOW), { from: +NOW - 3 * H, to: +NOW + 8.5 * H });
  assert.deepEqual(closureSpan(closure(null, null, { perm: true, end: null }), NOW), { from: -Infinity, to: Infinity });
  assert.deepEqual(closureSpan(closure(null, null), NOW), { from: -Infinity, to: null });
  assert.equal(closureSpan(closure(-5, -1, { active: false }), NOW), null);
  assert.equal(closureSpan(closure(-3, 8, { scope: "limited" }), NOW), null);
  assert.equal(closureSpan(closure(-3, 8, { scope: "runway" }), NOW), null);
});

test("a full closure scores every hour of its window: 'Airport closed until <time>', Severe", () => {
  const hours = buildHours({ now: NOW, tz: TZ, faa: [closure(-3, 8.5)] }); // reopens 11 PM EDT
  const rs = reasonsOf(hours);
  for (let i = 0; i <= 8; i++) {
    assert.equal(rs[i], "Airport closed until 11 PM ET", `hour ${i}`);
    assert.equal(hours[i].level, 4);
  }
  assert.equal(rs[9], null); // 11 PM onwards: open
  assert.equal(hours[9].level, 0);
  // across midnight: the weekday is named
  assert.equal(reasonsOf(buildHours({ now: NOW, tz: TZ, faa: [closure(-1, 16)] }))[0], "Airport closed until Fri 6:30 AM ET");
  // a cause stays in the text
  assert.equal(reasonsOf(buildHours({ now: NOW, tz: TZ, faa: [closure(-1, 3, { reason: "snow removal", cause: "weather" })] }))[0], "Airport closed — weather (snow removal), until 5:30 PM ET");
});

test("a closure that starts later scores from its start; no known end scores hour 0 only; permanent all day", () => {
  const later = buildHours({ now: NOW, tz: TZ, faa: [closure(3, 6)] });
  assert.deepEqual(later.slice(0, 8).map((h) => h.level), [0, 0, 0, 4, 4, 4, 4, 0]); // 5:30–8:30 PM -> hours 3–6 (5–9 PM)
  const open = buildHours({ now: NOW, tz: TZ, faa: [closure(null, null, { detail: "until further notice" })] });
  assert.deepEqual(open.slice(0, 3).map((h) => h.level), [4, 0, 0]);
  const perm = buildHours({ now: NOW, tz: TZ, faa: [closure(null, null, { perm: true, detail: "permanently" })] });
  assert.ok(perm.every((h) => h.level === 4));
  assert.equal(reasonsOf(perm)[0], "Airport closed permanently");
});

test("delay words: 'Delays happening now' for every hour of the closure, never 'very likely'", () => {
  const hours = hoursOutput(buildHours({ now: NOW, tz: TZ, faa: [closure(-3, 8.5)] }));
  const ov = overrides({ hours, now: NOW, faa: [closure(-3, 8.5), { type: "ground_stop", end: new Date(+NOW + 2 * H).toISOString() }] });
  for (let i = 0; i <= 8; i++) {
    assert.deepEqual(ov[i], { p: 1, override: "closure", minutes: null }, `hour ${i}`); // the closure wins over the ground stop
    const L = D.likelihood({ p: 1, ...ov[i] }, { report: null, aviation: false });
    assert.equal(L.key, "now");
    assert.equal(L.word, "Delays happening now");
  }
  assert.equal(ov[9], null);
  // a later closure: not before it starts
  const ov2 = overrides({ hours, now: NOW, faa: [closure(3, 6)] });
  assert.deepEqual(ov2.map((x) => (x ? x.override : null)).slice(0, 7), [null, null, null, "closure", "closure", "closure", "closure"]);
  // limited (GA-only) closures change nothing
  assert.ok(overrides({ hours, now: NOW, faa: [closure(-3, 8, { scope: "limited" })] }).every((x) => x == null));
});

test("programs with a known end hold through it; without one the old holds stay", () => {
  const hours = hoursOutput(buildHours({ now: NOW, tz: TZ }));
  const end = new Date(+NOW + 4 * H).toISOString(); // 6:30 PM
  const held = (faa) => overrides({ hours, now: NOW, faa }).map((x) => (x ? x.override : null)).slice(0, 7);
  assert.deepEqual(held([{ type: "ground_stop", end }]), ["ground_stop", "ground_stop", "ground_stop", "ground_stop", "ground_stop", null, null]);
  assert.deepEqual(held([{ type: "ground_delay", detail: "avg 45m", end }]), ["ground_delay", "ground_delay", "ground_delay", "ground_delay", "ground_delay", null, null]);
  assert.deepEqual(held([{ type: "delay", detail: "Departures 31–45m", end }]), ["delay", "delay", "delay", "delay", "delay", null, null]);
  // no end: GS/GDP 3 h (5 h increasing), general delays hour 0 only
  assert.deepEqual(held([{ type: "ground_stop" }]), ["ground_stop", "ground_stop", "ground_stop", "ground_stop", null, null, null]);
  assert.deepEqual(held([{ type: "delay", detail: "Departures 31–45m" }]), ["delay", null, null, null, null, null, null]);
  // the risk rows hold the same hours
  const rs = buildHours({ now: NOW, tz: TZ, faa: [{ type: "ground_stop", detail: "until 6:30 PM EDT", end }] });
  assert.deepEqual(rs.slice(0, 7).map((h) => h.level), [4, 4, 4, 4, 4, 0, 0]);
});

test("FAA XML: a closure carries its NOTAM start/end, else the Reopen time as its end", () => {
  const xml = `<AIRPORT_STATUS_INFORMATION><Delay_type><Name>Airport Closures</Name><Airport_Closure_List>
    <Airport><ARPT>MIA</ARPT><Reason>!MIA 09/101 MIA AD AP CLSD 2609101530-2609110300</Reason><Start>Sep 10 at 11:30 am EDT</Start><Reopen>Sep 10 at 11:00 pm EDT</Reopen></Airport>
    <Airport><ARPT>FLL</ARPT><Reason>hurricane</Reason><Start>11:30 am EDT</Start><Reopen>9:00 pm EDT</Reopen></Airport>
  </Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;
  const r = parseFaaXml(xml, { now: NOW, tzFor: () => TZ });
  const mia = r.byAirport.MIA[0];
  assert.equal(mia.start, "2026-09-10T15:30:00.000Z");
  assert.equal(mia.end, "2026-09-11T03:00:00.000Z");
  const fll = r.byAirport.FLL[0];
  assert.equal(fll.start, null);
  assert.equal(fll.end, "2026-09-11T01:00:00.000Z"); // 9 PM EDT
  assert.equal(fll.scope, "full");
});

test("trips: arriving at or leaving a closed airport during the closure is a Disruption", () => {
  const hrs = (reason, from, to) => Array.from({ length: 24 }, (_, i) => ({ t: new Date(T0 + i * H).toISOString(), level: i >= from && i <= to ? 4 : 0, reasons: i >= from && i <= to ? [reason] : [] }));
  const MIA = { iata: "MIA", tz: TZ, state: "FL", hours: hrs("Airport closed until 6 PM ET", 0, 3), faa: [{ type: "closure", scope: "full", active: true, end: "2026-09-10T22:00:00Z" }], atcscc: [] };
  const ATL = { iata: "ATL", tz: TZ, state: "GA", hours: hrs("", 99, 99), faa: [], atcscc: [] };
  const at = (h, m) => new Date(T0 + h * H + m * 60e3).toISOString();
  const by = { MIA, ATL };
  const arr = tripStatus({ legs: [{ from: "ATL", to: "MIA", dep: at(0, 15), arr: at(2, 15) }] }, by, { now: +NOW });
  assert.equal(arr.label, "Disruption");
  assert.equal(arr.top, "MIA is closed until 6 PM — your 4:15 PM arrival is likely cancelled or diverted.");
  const dep = tripStatus({ legs: [{ from: "MIA", to: "ATL", dep: at(1, 0), arr: at(3, 0) }] }, by, { now: +NOW });
  assert.equal(dep.label, "Disruption");
  assert.equal(dep.top, "MIA is closed until 6 PM — your 3 PM departure is likely delayed or cancelled.");
  // after it reopens: no closure concern
  const after = tripStatus({ legs: [{ from: "ATL", to: "MIA", dep: at(3, 30), arr: at(5, 30) }] }, by, { now: +NOW });
  assert.ok(!after.concerns.some((c) => /is closed/.test(c.text)));
});
