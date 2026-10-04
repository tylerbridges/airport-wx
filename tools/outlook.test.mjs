import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const O = createRequire(import.meta.url)("../site/outlook.js");
const now = Date.parse("2026-10-04T14:15:00Z"), H = 3600000;
const sources = Object.fromEntries(["faa", "atcscc", "metar", "taf"].map((k) => [k, { ok: true }]));
const base = () => ({ iata: "ORD", metar: { obsTime: "2026-10-04T14:00:00Z" }, faa: [], atcscc: [], hours: Array.from({ length: 24 }, (_, i) => ({ t: new Date(now - 15 * 60000 + i * H).toISOString(), level: 0, reasons: [] })) });
const options = (more = {}) => ({ now, generated: new Date(now).toISOString(), sources, ...more });
test("outlook: quiet status, absent forecast, missing and stale data remain distinct", () => {
  assert.equal(O.evaluate(base(), options()).headline, "Operating normally");
  assert.equal(O.evaluate(base(), options({ at: now + 24 * H })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ generated: new Date(now - H).toISOString() })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ sources: { ...sources, faa: { ok: false } } })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ hidden: true })).headline, "No issues in your selected categories");
});
test("outlook: scheduled end and FAA extension are not a forecast recovery time", () => {
  const a = base(); a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  a.atcscc = [{ type: "GS", active: true, start: new Date(now - H).toISOString(), end: new Date(now + H).toISOString(), issued: new Date(now - H).toISOString(), extension: "high" }];
  const o = O.evaluate(a, options());
  assert.equal(o.kind, "active"); assert.equal(o.level, 4); assert.equal(o.extension, "high"); assert.equal(o.scheduledEnd, now + H); assert.equal(o.recovery, null);
  assert.match(o.impacts[0].value, /Held before departure/);
  assert.equal(O.evaluate(a, options({ at: now + 2 * H })).kind, "normal");
});
test("outlook: future FAA periods apply only to their valid time; cancelled and superseded stay absent", () => {
  const a = base(); a.atcscc = [{ type: "GS", active: false, start: new Date(now + 2 * H).toISOString(), end: new Date(now + 4 * H).toISOString(), issued: new Date(now - H).toISOString() }];
  assert.equal(O.evaluate(a, options()).kind, "normal");
  assert.equal(O.evaluate(a, options({ at: now + 3 * H })).headline, "Ground stop scheduled");
  a.atcscc.push({ ...a.atcscc[0], issued: new Date(now).toISOString(), cnx: true });
  assert.equal(O.evaluate(a, options({ at: now + 3 * H })).kind, "normal");
});
test("outlook: a restriction without an end is current information, not a 24-hour forecast", () => {
  const a = base(); a.faa = [{ type: "ground_stop", end: null }];
  assert.equal(O.evaluate(a, options()).kind, "active");
  assert.equal(O.evaluate(a, options({ at: now + H })).kind, "normal");
});
test("outlook: arrival/departure trends remain directional when they disagree", () => {
  const a = base(); a.faa = [{ type: "delay", detail: "Departures 16–30m, increasing; Arrivals 31–45m, decreasing" }];
  const o = O.evaluate(a, options());
  assert.deepEqual(o.impacts, [{ label: "Departures", value: "Delays 16–30 min, increasing" }, { label: "Arrivals", value: "Delays 31–45 min, decreasing" }]);
});
test("outlook: later risk and sustained forecast improvement, with exact trip overlap boundaries", () => {
  const a = base(); for (let i = 2; i <= 4; i++) { a.hours[i].level = 3; a.hours[i].reasons = ["Thunderstorms"]; }
  const o = O.evaluate(a, options()); assert.equal(o.kind, "normal");
  assert.equal(o.window.start, Date.parse(a.hours[2].t)); assert.equal(o.window.end, Date.parse(a.hours[5].t));
  assert.equal(O.overlaps(o.window, a.hours[3].t), true); assert.equal(O.overlaps(o.window, a.hours[5].t), false);
  assert.equal(O.evaluate(a, options({ at: now + 2 * H })).recovery, Date.parse(a.hours[5].t));
});
test("outlook: probability describes an airport hour and only unusual routine risk raises severity", () => {
  const a = base(); a.hours[0].delay = { p: 0.5 };
  const words = () => ({ key: "likely", word: "Delays likely", rate: 0.5, cue: "higher than usual" });
  const o = O.evaluate(a, options({ words, notable: () => true }));
  assert.equal(o.headline, "Airport disruption likely"); assert.equal(o.level, 3); assert.match(o.definition, /airport during an hour/);
  assert.equal(O.evaluate(a, options({ words, notable: () => false })).kind, "normal");
});
