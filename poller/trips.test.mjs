// Flight calendar (ICS) parsing, flight detection, trip grouping and privacy (poller/trips.mjs, trips-poll.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unfold, parseLine, unescapeText, parseIcs, icsTime, durationMs, zonedToUtc, makeLookup, detectFlight, flightLegs,
  groupTrips, tripsFromIcs, maskText, redactedSample, privacyProblems, fnvHash,
} from "./trips.mjs";
import { icsHttpsUrl, maskSecret, expandIcsTemplate, withTripAirports, prepareTrips, loadAllAirports } from "./trips-poll.mjs";

const AIRPORTS = [
  { iata: "MSP", name: "Minneapolis–Saint Paul International", city: "Minneapolis", tz: "America/Chicago" },
  { iata: "ATL", name: "Hartsfield-Jackson Atlanta International", city: "Atlanta", tz: "America/New_York" },
  { iata: "ORD", name: "Chicago O'Hare International", city: "Chicago", tz: "America/Chicago" },
  { iata: "MDW", name: "Chicago Midway International", city: "Chicago", tz: "America/Chicago" },
  { iata: "DEN", name: "Denver International", city: "Denver", tz: "America/Denver" },
  { iata: "LAX", name: "Los Angeles International", city: "Los Angeles", tz: "America/Los_Angeles" },
  { iata: "BZN", name: "Bozeman Yellowstone International Airport", city: "Bozeman", tz: "America/Denver" },
];
const LOOKUP = makeLookup(AIRPORTS);
const NOW = new Date("2026-10-04T15:00:00Z");

const cal = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n");
const ev = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

test("unfold, parseLine, unescape (RFC 5545)", () => {
  assert.deepEqual(unfold("A:1\r\n B\r\n\tC\r\nD:2"), ["A:1BC", "D:2"]);
  const p = parseLine('DTSTART;TZID="America/Chicago";X-Y=z:20261004T180500');
  assert.equal(p.name, "DTSTART");
  assert.equal(p.params.TZID, "America/Chicago");
  assert.equal(p.value, "20261004T180500");
  assert.equal(parseLine("DESCRIPTION:Gate: B12").value, "Gate: B12");
  assert.equal(unescapeText("a\\nb\\, c\\; d\\\\e"), "a\nb, c; d\\e");
});

test("times: TZID, Z, floating, VALUE=DATE, DURATION, DST", () => {
  // 6:05 PM CDT = 23:05 UTC
  assert.equal(new Date(icsTime({ value: "20261004T180500", params: { TZID: "America/Chicago" } }).ms).toISOString(), "2026-10-04T23:05:00.000Z");
  assert.equal(new Date(icsTime({ value: "20261004T230500Z", params: {} }).ms).toISOString(), "2026-10-04T23:05:00.000Z");
  // floating time and an unknown TZID use the fallback zone (the airport's)
  assert.equal(new Date(icsTime({ value: "20261004T180500", params: {} }, "America/New_York").ms).toISOString(), "2026-10-04T22:05:00.000Z");
  assert.equal(new Date(icsTime({ value: "20261004T180500", params: { TZID: "Central Standard Time" } }, "America/Chicago").ms).toISOString(), "2026-10-04T23:05:00.000Z");
  // Mozilla-style TZID prefix
  assert.equal(new Date(icsTime({ value: "20261004T180500", params: { TZID: "/mozilla.org/20050126_1/America/Denver" } }).ms).toISOString(), "2026-10-05T00:05:00.000Z");
  assert.equal(icsTime({ value: "20261004", params: { VALUE: "DATE" } }).allDay, true);
  assert.equal(durationMs("PT2H25M"), (2 * 60 + 25) * 60e3);
  assert.equal(durationMs("P1DT1H"), 25 * 3600e3);
  // winter (CST, -6) vs summer
  assert.equal(new Date(zonedToUtc(2026, 12, 1, 6, 0, 0, "America/Chicago")).toISOString(), "2026-12-01T12:00:00.000Z");
});

test("format: '✈ DL 1234 · MSP → ATL' with TZIDs", () => {
  const text = cal(ev([
    "UID:abc-1@flights", "DTSTART;TZID=America/Chicago:20261004T180500", "DTEND;TZID=America/New_York:20261004T213000",
    "SUMMARY:✈ DL 1234 · MSP → ATL", "LOCATION:Minneapolis–St Paul (MSP)", "DESCRIPTION:Jane Doe\\nConfirmation QX7Z2P\\nSeat 14C",
  ]));
  const r = tripsFromIcs(text, { now: NOW, lookup: LOOKUP, salt: "s" });
  assert.equal(r.trips.length, 1);
  assert.deepEqual(r.trips[0].legs, [{ from: "MSP", to: "ATL", dep: "2026-10-04T23:05:00.000Z", arr: "2026-10-05T01:30:00.000Z" }]);
  assert.equal(r.stats.how.pair, 1);
});

test("format: 'Flight to Atlanta (DL1234)' with LOCATION 'Minneapolis–St Paul (MSP)'", () => {
  const text = cal(ev([
    "UID:abc-2@flights", "DTSTART;TZID=America/Chicago:20261004T180500", "DTEND;TZID=America/New_York:20261004T213000",
    "SUMMARY:Flight to Atlanta (DL1234)", "LOCATION:Minneapolis–St Paul (MSP)",
  ]));
  const r = tripsFromIcs(text, { now: NOW, lookup: LOOKUP });
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].legs[0].from, "MSP");
  assert.equal(r.trips[0].legs[0].to, "ATL");
  assert.equal(r.stats.how.place, 1);
});

test("more plausible formats are detected", () => {
  const f = (summary, location = "", description = "") => detectFlight({ summary, location, description }, LOOKUP);
  assert.deepEqual(f("DL1234 MSP-ATL"), { from: "MSP", to: "ATL", how: "pair" });
  assert.deepEqual(f("MSP to DEN"), { from: "MSP", to: "DEN", how: "pair" });
  assert.deepEqual(f("Flight UA 567 ORD–DEN"), { from: "ORD", to: "DEN", how: "pair" });
  assert.deepEqual(f("MSP ✈ LAX"), { from: "MSP", to: "LAX", how: "pair" });
  assert.equal(f("Flight from Minneapolis to Denver").to, "DEN");
  assert.equal(f("Flight from Minneapolis to Denver").from, "MSP");
  assert.equal(f("✈ Denver", "Chicago O'Hare International Airport").from, "ORD");
  assert.equal(f("DL 1234", "Minneapolis (MSP)", "Arrive Atlanta ATL").to, "ATL");
  // not flights
  assert.equal(f("Trip to Atlanta"), null);
  assert.equal(f("Dinner with Ana", "Chicago"), null);
  assert.equal(f("ABC-XYZ meeting"), null); // codes that aren't airports
});

test("all-day 'Trip to Atlanta', cancelled flights, recurrences and alarms", () => {
  const text = cal(
    ev(["UID:trip", "DTSTART;VALUE=DATE:20261004", "DTEND;VALUE=DATE:20261008", "SUMMARY:Trip to Atlanta"]),
    ev(["UID:cx", "DTSTART:20261004T200000Z", "DTEND:20261004T230000Z", "SUMMARY:✈ DL 99 · MSP → LAX", "STATUS:CANCELLED"]),
    ev(["UID:cx2", "DTSTART:20261004T200000Z", "DTEND:20261004T230000Z", "SUMMARY:Canceled: ✈ DL 98 · MSP → DEN"]),
    ev(["UID:rec", "DTSTART:20261004T200000Z", "DTEND:20261004T220000Z", "SUMMARY:✈ MSP → DEN", "RRULE:FREQ=WEEKLY;COUNT=4",
      "BEGIN:VALARM", "DESCRIPTION:✈ ATL → LAX", "TRIGGER:-PT1H", "END:VALARM"]),
    ev(["UID:rec", "RECURRENCE-ID:20261011T200000Z", "DTSTART:20261011T210000Z", "DTEND:20261011T230000Z", "SUMMARY:✈ MSP → DEN"]),
  );
  const r = tripsFromIcs(text, { now: NOW, lookup: LOOKUP });
  assert.equal(r.stats.allDay, 1);
  assert.equal(r.stats.cancelled, 2);
  assert.equal(r.stats.recurrenceOverride, 1);
  assert.equal(r.trips.length, 1, "only the first instance of the recurring flight");
  assert.deepEqual(r.trips[0].legs.map((l) => l.from + l.to), ["MSPDEN"]);
});

test("DURATION and floating times use the airports' zones", () => {
  const text = cal(ev(["UID:d", "DTSTART:20261004T180000", "DURATION:PT2H30M", "SUMMARY:MSP → ATL"]));
  const r = tripsFromIcs(text, { now: NOW, lookup: LOOKUP });
  assert.equal(r.trips[0].legs[0].dep, "2026-10-04T23:00:00.000Z");
  assert.equal(r.trips[0].legs[0].arr, "2026-10-05T01:30:00.000Z");
  // no end at all: skipped
  const r2 = tripsFromIcs(cal(ev(["UID:e", "DTSTART:20261004T180000Z", "SUMMARY:MSP → ATL"])), { now: NOW, lookup: LOOKUP });
  assert.equal(r2.trips.length, 0);
  assert.equal(r2.stats.noEnd, 1);
});

test("connections: same airport and a gap under 8 h form one trip", () => {
  const H = 3600e3;
  const t = Date.parse("2026-10-04T18:00:00Z");
  const leg = (from, to, dep, arr) => ({ from, to, dep: t + dep * H, arr: t + arr * H, uid: from + to + dep });
  assert.equal(groupTrips([leg("MSP", "ORD", 0, 1.5), leg("ORD", "ATL", 2.25, 4)]).length, 1);
  assert.equal(groupTrips([leg("MSP", "ORD", 0, 1.5), leg("ORD", "ATL", 9.6, 11)]).length, 2, "9 h gap");
  assert.equal(groupTrips([leg("MSP", "ORD", 0, 1.5), leg("MDW", "ATL", 2.25, 4)]).length, 2, "different airport");
  assert.equal(groupTrips([leg("ORD", "ATL", 2.25, 4), leg("MSP", "ORD", 0, 1.5)])[0].length, 2, "order doesn't matter");
  const three = groupTrips([leg("BZN", "DEN", 0, 1.5), leg("DEN", "ORD", 2.5, 5), leg("ORD", "ATL", 6, 8), leg("ATL", "MSP", 40, 43)]);
  assert.deepEqual(three.map((g) => g.length), [3, 1]);
});

test("window: last scheduled arrival at most 24 h ago, first departure at most 7 days ahead", () => {
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const at = (h) => +NOW + h * 3600e3;
  const flight = (uid, h) => ev([`UID:${uid}`, `DTSTART:${z(at(h))}`, `DTEND:${z(at(h + 2))}`, "SUMMARY:MSP → ATL"]);
  const r = tripsFromIcs(cal(flight("a", -27), flight("b", -25), flight("c", 24 * 6.9), flight("d", 24 * 7.2)), { now: NOW, lookup: LOOKUP });
  assert.equal(r.trips.length, 2);
  assert.deepEqual(r.trips.map((x) => x.legs[0].dep), [new Date(at(-25)).toISOString(), new Date(at(24 * 6.9)).toISOString()]);
});

test("trip ids are salted hashes of the UID (stable, not the UID)", () => {
  const text = cal(ev(["UID:secret-uid-123@flights", "DTSTART:20261004T200000Z", "DTEND:20261004T220000Z", "SUMMARY:MSP → ATL"]));
  const a = tripsFromIcs(text, { now: NOW, lookup: LOOKUP, salt: "one" }).trips[0].id;
  const b = tripsFromIcs(text, { now: NOW, lookup: LOOKUP, salt: "one" }).trips[0].id;
  const c = tripsFromIcs(text, { now: NOW, lookup: LOOKUP, salt: "two" }).trips[0].id;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes("123"));
  assert.match(fnvHash("x"), /^[0-9a-f]{16}$/);
});

const PRIVATE = cal(
  ev(["UID:p1@flights", "DTSTART;TZID=America/Chicago:20261004T180500", "DTEND;TZID=America/New_York:20261004T213000",
    "SUMMARY:✈ DL 1234 · MSP → ATL", "LOCATION:Minneapolis–St Paul (MSP)",
    "DESCRIPTION:Passenger: Jane Doe\\nConfirmation: QX7Z2P\\nSeat 14C\\njane.doe@example.com\\nNotes: bring passport"]),
  ev(["UID:p2@flights", "DTSTART;TZID=America/New_York:20261004T224500", "DTEND;TZID=America/Denver:20261005T003000",
    "SUMMARY:Flight to Denver (DL5678)", "LOCATION:Hartsfield-Jackson Atlanta (ATL)"]),
);

test("privacy: trips carry only airports and times", () => {
  const r = tripsFromIcs(PRIVATE, { now: NOW, lookup: LOOKUP, salt: "s" });
  const doc = { generated: NOW.toISOString(), configured: true, ok: true, error: null, source: "calendar", count: r.trips.length, flights: 2, trips: r.trips };
  const s = JSON.stringify(doc);
  for (const bad of ["1234", "5678", "DL", "Jane", "Doe", "QX7Z2P", "14C", "example.com", "passport", "p1@flights", "Flight", "Minneapolis"]) assert.ok(!s.includes(bad), `leaked ${bad}`);
  assert.equal(r.trips.length, 1, "ATL connection under 8 h -> one trip");
  assert.deepEqual(privacyProblems(doc), []);
  // the check catches leaks
  assert.ok(privacyProblems({ ...doc, trips: [{ ...doc.trips[0], flight: "DL 1234" }] }).length);
  assert.ok(privacyProblems({ ...doc, note: "Jane" }).some((p) => /unexpected key/.test(p)));
  assert.ok(privacyProblems({ ...doc, error: "jane.doe@example.com" }).length);
  assert.ok(privacyProblems({ ...doc, trips: [{ id: "abc123", legs: [{ from: "DL1", to: "ATL", dep: "x", arr: "y" }] }] }).length);
  assert.ok(privacyProblems({ ...doc, error: "HTTP 404 at https://p01-caldav.icloud.com/published/2/abc" }).length);
});

test("privacy: the redacted format sample masks digits, names, codes and emails", () => {
  assert.equal(maskText("✈ DL 1234 · MSP → ATL", LOOKUP), "✈ XX #### · MSP → ATL");
  assert.equal(maskText("Flight to Atlanta (DL1234)", LOOKUP), "Flight to Xxxxxxx (XX####)");
  const cal0 = parseIcs(PRIVATE);
  const { stats } = flightLegs(cal0, LOOKUP);
  const sample = redactedSample(cal0, stats, LOOKUP);
  const s = JSON.stringify(sample);
  assert.ok(!/\d/.test(s.replace(/"(events|flights|allDay|cancelled|notFlight|noEnd|recurrenceOverride|recurring|pair|place)":\d+/g, "")), "no digits except counts");
  for (const bad of ["Jane", "Doe", "QX7Z2P", "example", "passport", "Minneapolis", "Atlanta", "p1@flights"]) assert.ok(!s.includes(bad), `sample leaked ${bad}`);
  assert.ok(s.includes("MSP → ATL"), "airport codes and arrows kept");
  assert.ok(sample.eventProps.includes("DTSTART;TZID"));
  assert.equal(sample.events[0].start, "TZID=America/Chicago:########T######");
  assert.equal(sample.events[0].detected, "pair");
});

// ---------- poll side ----------

test("calendar URL: webcal -> https, and masked in messages", () => {
  assert.equal(icsHttpsUrl("webcal://p01-caldav.icloud.com/published/2/TOKEN"), "https://p01-caldav.icloud.com/published/2/TOKEN");
  assert.equal(icsHttpsUrl("https://x.example/a.ics"), "https://x.example/a.ics");
  assert.equal(icsHttpsUrl("not a url"), null);
  const secret = "webcal://p01-caldav.icloud.com/published/2/TOKEN123456";
  const m = maskSecret("failed: https://p01-caldav.icloud.com/published/2/TOKEN123456 and /published/2/TOKEN123456", secret);
  assert.ok(!m.includes("TOKEN123456"));
});

test("fixture tokens expand to local, UTC and date ICS times", () => {
  const now = new Date("2026-10-04T15:02:00Z");
  assert.equal(expandIcsTemplate("{{ics+60 America/Chicago}}", now), "20261004T110000");
  assert.equal(expandIcsTemplate("{{icsz+90}}", now), "20261004T163000Z");
  assert.equal(expandIcsTemplate("{{icsd+1}}", now), "20261005");
});

test("trip airports join the pipeline, looked up in the full airport list", async () => {
  const curated = [{ iata: "MSP", icao: "KMSP", tz: "America/Chicago", lat: 44.88, lon: -93.22 }];
  const all = await loadAllAirports();
  const trips = [{ id: "a", legs: [{ from: "MSP", to: "DEN", dep: "x", arr: "y" }, { from: "DEN", to: "BZN", dep: "x", arr: "y" }] }];
  const r = withTripAirports(curated, trips, [...all.filter((a) => a.iata !== "DEN"), { iata: "DEN", icao: "KDEN", name: "Denver", city: "Denver", state: "CO", tz: "America/Denver", lat: 39.8, lon: -104.6 }]);
  assert.deepEqual(r.added, ["DEN", "BZN"]);
  const bzn = r.airports.find((a) => a.iata === "BZN");
  assert.equal(bzn.icao, "KBZN");
  assert.equal(bzn.state, "MT");
  assert.equal(bzn.trip, true);
  assert.ok(Number.isFinite(bzn.lat) && bzn.tz);
  assert.deepEqual(withTripAirports(curated, [{ legs: [{ from: "MSP", to: "ZZZ" }] }], all).missing, ["ZZZ"]);
});

test("prepareTrips: not configured, fixtures, and a failing fetch that never shows the URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-trips-"));
  try {
    const out = join(dir, "status.json");
    // not configured
    const a = await prepareTrips({ fixtures: false, now: NOW, env: {} });
    assert.equal(a.doc.configured, false);
    assert.deepEqual(a.doc.trips, []);
    await a.finish({ out });
    const written = JSON.parse(await readFile(join(dir, "trips.json"), "utf8"));
    assert.equal(written.configured, false);
    assert.deepEqual(privacyProblems(written), []);

    // fixtures: a trips.ics in the fixture dir
    const fx = join(dir, "fx");
    await mkdir(fx);
    await writeFile(join(fx, "trips.ics"), cal(ev(["UID:f1", "DTSTART;TZID=America/Chicago:{{ics+120 America/Chicago}}", "DTEND;TZID=America/Denver:{{ics+260 America/Denver}}", "SUMMARY:✈ DL 1 · MSP → BZN"])));
    const raw = join(dir, "raw");
    await mkdir(raw);
    await writeFile(join(raw, "sources.json"), JSON.stringify({ metar: { ok: true } }));
    const b = await prepareTrips({ fixtures: true, now: NOW, env: { FIXTURES_DIR: fx, TRIPS_OUT: join(dir, "t2.json") } });
    assert.equal(b.doc.count, 1);
    const aps = await b.addAirports([{ iata: "MSP", icao: "KMSP", tz: "America/Chicago", lat: 1, lon: 1 }]);
    assert.deepEqual(aps.map((x) => x.iata), ["MSP", "BZN"]);
    const marked = b.markAirports([{ iata: "MSP" }, { iata: "BZN" }]);
    assert.deepEqual(marked.map((x) => !!x.trip), [false, true]);
    await b.finish({ out, rawDir: raw });
    const t2 = JSON.parse(await readFile(join(dir, "t2.json"), "utf8"));
    assert.deepEqual(t2.trips[0].legs.map((l) => [l.from, l.to]), [["MSP", "BZN"]]);
    assert.deepEqual(privacyProblems(t2), []);
    const src = JSON.parse(await readFile(join(raw, "sources.json"), "utf8"));
    assert.deepEqual(src.trips.files, ["trips-sample.json"]);
    assert.ok(src.metar, "other sources kept");
    const sample = await readFile(join(raw, "trips-sample.json"), "utf8");
    assert.ok(sample.includes("XX # · MSP → BZN"));

    // configured, but the calendar can't be reached: stated, and the URL never appears
    const secret = "webcal://127.0.0.1:9/published/2/SECRETTOKEN987";
    const c = await prepareTrips({ fixtures: false, now: NOW, env: { FLIGHTY_ICS_URL: secret, TRIPS_OUT: join(dir, "t3.json") } });
    assert.equal(c.doc.configured, true);
    assert.equal(c.doc.ok, false);
    assert.ok(c.doc.error && !c.doc.error.includes("SECRETTOKEN987") && !c.doc.error.includes("127.0.0.1"), c.doc.error);
    await c.finish({ out });
    const t3 = await readFile(join(dir, "t3.json"), "utf8");
    assert.ok(!t3.includes("SECRETTOKEN987"));
    assert.deepEqual(privacyProblems(JSON.parse(t3)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("calendar retains long flights and delayed schedules until 24 h after scheduled arrival", () => {
  const z = (h) => new Date(+NOW + h * 3600e3).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const text = cal(ev(["UID:long-flight", `DTSTART:${z(-12)}`, `DTEND:${z(1)}`, "SUMMARY:MSP → ATL"]));
  assert.equal(tripsFromIcs(text, { now: NOW, lookup: LOOKUP }).trips.length, 1, "departure more than 6 h ago stays visible");
  assert.equal(tripsFromIcs(text, { now: new Date(+NOW + 25 * 3600e3), lookup: LOOKUP }).trips.length, 1, "24 h scheduled-arrival boundary retained");
  assert.equal(tripsFromIcs(text, { now: new Date(+NOW + 25 * 3600e3 + 1), lookup: LOOKUP }).trips.length, 0, "archives by schedule beyond boundary");
});
