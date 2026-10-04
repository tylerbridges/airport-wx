import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calendarDraft, nextScheduled, MAX_CALENDAR_BYTES } from "../site/trip-import.js";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const airports = [{ iata: "MSP", tz: "America/Chicago", city: "Minneapolis" }, { iata: "ORD", tz: "America/Chicago", city: "Chicago" }, { iata: "SEA", tz: "America/Los_Angeles", city: "Seattle" }];
const cal = (...events) => ["BEGIN:VCALENDAR", ...events.map(e => ["BEGIN:VEVENT", ...e, "END:VEVENT"].join("\n")), "END:VCALENDAR"].join("\n");
const flight = ["UID:private-user@example.com", "SUMMARY:Jane Doe DL 1234 · MSP → SEA", "DESCRIPTION:Booking SECRET123, seat 2A", "DTSTART;TZID=America/Chicago:20261004T130000", "DTEND;TZID=America/Los_Angeles:20261004T150000"];
test("local import shares the server parser with only its browser reexport path changed", async () => {
  const server = await readFile(new URL("../poller/trips.mjs", import.meta.url), "utf8");
  const browser = await readFile(new URL("../site/trips-parser.js", import.meta.url), "utf8");
  assert.equal(browser, server.replace('from "./trip-risk.mjs";', 'from "./trip-risk.js?v=3";'));
});
test("local calendar draft preserves airport zones and schedules, discards identifying fields", () => {
  const d = calendarDraft(cal(flight), { airports, now: NOW });
  assert.equal(d.flights, 1);
  assert.equal(calendarDraft("\uFEFF" + cal(flight), { airports, now: NOW }).flights, 1, "UTF-8 calendar export BOM is accepted");
  assert.equal(d.trips[0].legs[0].dep, "2026-10-04T18:00:00.000Z");
  assert.equal(d.trips[0].legs[0].arr, "2026-10-04T22:00:00.000Z");
  assert.deepEqual(d.trips[0].tz, { MSP: "America/Chicago", SEA: "America/Los_Angeles" });
  assert.equal(d.trips[0].imported, true);
  assert.ok(!/Jane|Doe|DL 1234|example.com|SECRET123|2A|UID|SUMMARY|DESCRIPTION/.test(JSON.stringify(d)));
  const renamed = [...flight]; renamed[0] = "UID:changed-private-uid";
  assert.equal(calendarDraft(cal(renamed), { airports, now: NOW }).trips[0].id, d.trips[0].id, "local identity is based only on sanitized scheduled legs");
});
test("local import skips duplicate flights, including different event ids and saved manual/calendar trips", () => {
  const d = calendarDraft(cal(flight), { airports, now: NOW });
  const dup = calendarDraft(cal(flight, ["UID:copy", ...flight.slice(1)]), { airports, now: NOW });
  assert.equal(dup.flights, 1); assert.equal(dup.skipped, 0, "the shared parser already collapsed the duplicate event");
  const saved = calendarDraft(cal(flight), { airports, existing: d.trips, now: NOW });
  assert.equal(saved.flights, 0); assert.equal(saved.skipped, 1);
  assert.deepEqual(saved.trips, []);
  const arrivalChanged = flight.map(line => line.startsWith("DTEND") ? "DTEND;TZID=America/Los_Angeles:20261004T160000" : line);
  assert.equal(calendarDraft(cal(arrivalChanged), { airports, existing: d.trips, now: NOW }).flights, 0, "changed arrival is not imported as a second copy of the same scheduled departure");
});
test("local import is bounded, ignores non-flights/cancelled/all-day events, applies arrival retention", () => {
  assert.throws(() => calendarDraft("plain text", { airports, now: NOW }), /valid calendar/);
  assert.throws(() => calendarDraft("BEGIN:VCALENDAR\n" + "x".repeat(MAX_CALENDAR_BYTES) + "\nEND:VCALENDAR"), /under 1 MB/);
  const events = [flight, ["UID:dentist", "SUMMARY:Dentist", "DTSTART:20261004T130000Z", "DTEND:20261004T140000Z"], ["UID:cancel", ...flight.slice(1), "STATUS:CANCELLED"], ["UID:allday", "SUMMARY:MSP → SEA", "DTSTART;VALUE=DATE:20261004", "DTEND;VALUE=DATE:20261005"], ["UID:farfuture", "SUMMARY:MSP → SEA", "DTSTART:20261020T130000Z", "DTEND:20261020T170000Z"]];
  assert.equal(calendarDraft(cal(...events), { airports, now: NOW }).flights, 1);
  const long = ["UID:long", "SUMMARY:MSP → SEA", "DTSTART:20261003T100000Z", "DTEND:20261004T110000Z"];
  assert.equal(calendarDraft(cal(long), { airports, now: NOW }).flights, 1, "retains by recent scheduled arrival, not assumed takeoff");
});
test("next scheduled flight selects a future connection without claiming prior flight progress", () => {
  const trip = { id: "conn", legs: [{ from: "MSP", to: "ORD", dep: "2026-10-04T09:00:00Z", arr: "2026-10-04T11:00:00Z" }, { from: "ORD", to: "SEA", dep: "2026-10-04T13:00:00Z", arr: "2026-10-04T17:00:00Z" }] };
  const later = { id: "later", legs: [{ from: "MSP", to: "SEA", dep: "2026-10-05T13:00:00Z", arr: "2026-10-05T17:00:00Z" }] };
  const n = nextScheduled([later, trip], NOW);
  assert.equal(n.trip.id, "conn"); assert.equal(n.leg.from, "ORD"); assert.equal(n.future, true);
  const recent = nextScheduled([trip], Date.parse("2026-10-04T18:00:00Z"));
  assert.equal(recent.future, false); assert.equal(recent.trip.id, "conn");
  assert.equal(nextScheduled([], NOW), null);
});
