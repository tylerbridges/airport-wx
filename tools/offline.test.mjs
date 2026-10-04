import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const O = createRequire(import.meta.url)("../site/offline.js");
const now = Date.parse("2026-10-04T21:00:00Z");
const airport = { iata: "MSP", hours: [{ t: new Date(now).toISOString(), level: 4, reasons: ["Ground stop"] }], now: { level: 4 }, peak: { level: 4 }, faa: [{ type: "ground_stop", end: new Date(now + 3600000).toISOString() }], metar: { obsTime: new Date(now).toISOString(), raw: "raw weather" }, notices: { items: [] } };
const data = () => ({ generated: new Date(now).toISOString(), sources: { faa: { ok: true } }, airports: [airport] });
const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test("offline cache keeps restrictions but excludes calendar/trip details and identifying nested fields", () => {
  const st = storage(), d = data();
  Object.assign(d, { trips: [{ id: "private-flight-id", flightNumber: "DL123" }], calendarUrl: "https://private.invalid/calendar" });
  d.airports.push({ ...airport, iata: "BZN", trip: true });
  d.airports[0] = { ...airport, flightNumber: "DL123", faa: [{ ...airport.faa[0], id: "identifier", raw: "private raw report", url: "https://private.invalid" }] };
  assert.equal(O.save(st, d, now), true);
  const raw = st.getItem(O.KEY);
  for (const forbidden of ["private", "identifier", "DL123", "calendar", "raw weather", "BZN"]) assert.ok(!raw.includes(forbidden), forbidden);
  const result = O.load(st, now + 60000);
  assert.equal(result.airports[0].faa[0].type, "ground_stop");
  assert.equal(result.airports[0].hours[0].level, 4);
  assert.equal(result.airports.length, 1);
});

test("offline cache expires after six hours and rejects oversized, malformed or future snapshots", () => {
  const st = storage();
  assert.ok(O.save(st, data(), now));
  assert.equal(O.load(st, now + O.MAX_AGE + 1), null);
  assert.equal(st.getItem(O.KEY), undefined);
  assert.equal(O.snapshot({ ...data(), generated: new Date(now + 3600000).toISOString() }, now), null);
  st.setItem(O.KEY, "invalid"); assert.equal(O.load(st, now), null);
  st.setItem(O.KEY, "x".repeat(O.MAX_BYTES + 1)); assert.equal(O.load(st, now), null);
  assert.equal(O.save({ setItem() { throw Error("quota"); } }, data(), now), false);
});
