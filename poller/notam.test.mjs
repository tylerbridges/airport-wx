import test from "node:test";
import assert from "node:assert/strict";
import { notamTimes, notamBody, closureScope, closedRunways, translateNotam, endPhrase, describeClosure } from "./notam.mjs";
import { parseFaaXml } from "./lib.mjs";
import { assessFaa } from "./risk.mjs";

const NOW = new Date("2026-10-03T19:20:00Z");
const LAX = "!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 OR SIGNATURE AVIATION 310-410-9605 2605271826-2705281600";
const FULL = "!BUF 10/045 BUF AD AP CLSD 2610031800-2610032300";
const RWY = "!LAX 10/101 LAX RWY 07L/25R CLSD 2610011200-2610312359";

test("NOTAM times: YYMMDDHHMM range, PERM, EST", () => {
  assert.deepEqual(notamTimes(LAX), { start: Date.parse("2026-05-27T18:26:00Z"), end: Date.parse("2027-05-28T16:00:00Z"), perm: false, est: false });
  assert.deepEqual(notamTimes("!X 1/1 X AD AP CLSD 2610031800-PERM"), { start: Date.parse("2026-10-03T18:00:00Z"), end: null, perm: true, est: false });
  assert.equal(notamTimes("!X 1/1 X RWY 4 CLSD 2610031800-2610032000EST").est, true);
  assert.equal(notamTimes("snow removal"), null);
  assert.equal(notamBody(LAX), "AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 OR SIGNATURE AVIATION 310-410-9605");
});

test("closure scope: limited (LAX GA NOTAM), full, runway", () => {
  assert.equal(closureScope(LAX), "limited");
  assert.equal(closureScope(FULL), "full");
  assert.equal(closureScope("!X 1/1 X AP CLSD"), "full");
  assert.equal(closureScope("!X 1/1 X RWY ALL CLSD"), "full");
  assert.equal(closureScope("snow removal"), "full");
  assert.equal(closureScope(RWY), "runway");
  assert.equal(closureScope("!X 1/1 X RWY 16L/34R CLSD EXC TAX"), "runway");
  assert.equal(closureScope("!X 1/1 X AD AP CLSD EXC PPR"), "full"); // PPR-only exemption: closed for travelers
  assert.equal(closureScope("!X 1/1 X TWY B CLSD"), "limited");
  assert.deepEqual(closedRunways(RWY), ["7L/25R"]);
  assert.deepEqual(closedRunways("RWY 4L/22R CLSD. RWY 4R/22L CLSD"), ["4L/22R", "4R/22L"]);
});

test("LAX GA-only closure: plain English, informational, dated end", () => {
  const d = describeClosure(LAX, { tz: "America/Los_Angeles", now: NOW, reopen: "9 AM PT" });
  assert.equal(d.scope, "limited");
  assert.equal(d.active, true);
  assert.equal(d.detail, "through May 28, 2027"); // NOTAM end wins over the Reopen field
  assert.equal(d.plain, "Closed to private (non-scheduled, general aviation) flights unless approved 24 hours ahead. Airline flights aren't affected. Through May 28, 2027.");
  assert.equal(assessFaa({ type: "closure", reason: LAX, ...d }), null);
});

test("full closure stays Severe; runway closure is Low with 'Runway 7L/25R closed'", () => {
  const f = describeClosure(FULL, { tz: "America/New_York", now: NOW });
  assert.equal(f.scope, "full");
  assert.equal(f.detail, "until 7 PM ET");
  assert.equal(f.plain, "Airport closed. Until 7 PM ET.");
  const fi = assessFaa({ type: "closure", reason: FULL, ...f });
  assert.equal(fi.level, 4);
  assert.equal(fi.text, "Airport closed until 7 PM ET");
  const r = describeClosure(RWY, { tz: "America/Los_Angeles", now: NOW });
  assert.equal(r.scope, "runway");
  assert.equal(r.plain, "Runway 7L/25R closed. Through Oct 31.");
  const ri = assessFaa({ type: "closure", reason: RWY, ...r });
  assert.equal(ri.level, 1);
  assert.equal(ri.text, "Runway 7L/25R closed");
});

test("closures that haven't started or have ended don't score", () => {
  const future = describeClosure("!X 1/1 X AD AP CLSD 2610101200-2610101800", { tz: "America/New_York", now: NOW });
  assert.equal(future.active, false);
  assert.equal(assessFaa({ type: "closure", ...future }), null);
  const perm = describeClosure("!X 1/1 X AD AP CLSD 2601011200-PERM", { tz: "America/New_York", now: NOW });
  assert.equal(perm.detail, "permanently");
  assert.equal(perm.active, true);
});

test("NOTAM translator expands common contractions and keeps unknown tokens", () => {
  assert.equal(translateNotam("!X 1/1 X RWY 4 CLSD BTN 0600-1400 DLY WIP"), "Runway 4 closed between 0600-1400 daily work in progress");
  assert.equal(translateNotam("!X 1/1 X ILS RWY 22L U/S"), "ILS runway 22L unserviceable");
  assert.equal(translateNotam("!X 1/1 X TWY C OTS EXC ACFT CTC FOO"), "Taxiway C out of service except aircraft contact FOO");
  assert.equal(translateNotam("!X 1/1 X AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR"),
    "Airport closed to non-scheduled transient general aviation aircraft except prior permission required 24 hours ahead");
  assert.equal(translateNotam("!X 1/1 X SKED ZZZ"), "Scheduled ZZZ");
});

test("end phrase: today -> clock, other days -> date (year only if different)", () => {
  assert.equal(endPhrase(Date.parse("2026-10-03T23:00:00Z"), "America/New_York", NOW), "until 7 PM ET");
  assert.equal(endPhrase(Date.parse("2026-10-05T23:00:00Z"), "America/New_York", NOW), "through Oct 5");
  assert.equal(endPhrase(Date.parse("2027-05-28T16:00:00Z"), "America/Los_Angeles", NOW), "through May 28, 2027");
  assert.equal(endPhrase(Date.parse("2026-10-03T23:30:00Z"), "America/New_York", NOW, true), "until about 7:30 PM ET");
});

test("FAA XML: the live LAX closure parses as limited with no CLOSED badge", () => {
  const xml = `<AIRPORT_STATUS_INFORMATION><Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>${LAX}</Reason><Start>May 27 at 18:26 UTC.</Start><Reopen>9:00 am PDT</Reopen></Airport><Airport><ARPT>BUF</ARPT><Reason>${FULL}</Reason></Airport></Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;
  const r = parseFaaXml(xml, { now: NOW, tzFor: (c) => (c === "LAX" ? "America/Los_Angeles" : "America/New_York") });
  const lax = r.byAirport.LAX[0];
  assert.equal(lax.scope, "limited");
  assert.equal(lax.badge, null);
  assert.equal(lax.detail, "through May 28, 2027");
  assert.match(lax.plain, /^Closed to private/);
  assert.equal(r.byAirport.BUF[0].badge, "CLOSED");
  assert.equal(r.byAirport.BUF[0].scope, "full");
});

test("size-limited closures (live PHL NOTAM) aren't called general aviation", () => {
  const PHL = "!PHL 09/263 PHL AD AP CLSD TO NON SKED ACFT WINGSPAN MORE THAN 214FT AND TAIL HGT MORE THAN 66FT. 2609301806-2610311200";
  const d = describeClosure(PHL, { tz: "America/New_York", now: new Date("2026-10-03T22:17:00Z") });
  assert.equal(d.scope, "limited");
  assert.equal(d.plain, "Closed to very large non-scheduled aircraft (747-8/A380 size). Airline flights aren't affected. Through Oct 31.");
  assert.doesNotMatch(d.plain, /general aviation/);
  const small = describeClosure("!X 1/1 X AD AP CLSD TO ACFT WINGSPAN MORE THAN 118FT 2609301806-2610311200", { now: new Date("2026-10-03T22:17:00Z") });
  assert.equal(small.plain, "Closed to large aircraft (wingspan over 118 ft). Through Oct 31.");
  // NON SKED alone is not general aviation either
  const ns = describeClosure("!X 1/1 X AD AP CLSD TO NON SKED ACFT EXC PPR 2609301806-2610311200", { now: new Date("2026-10-03T22:17:00Z") });
  assert.equal(ns.plain, "Closed to non-scheduled flights unless approved in advance. Scheduled airline flights aren't affected. Through Oct 31.");
});

test("closures exempting only emergency/medevac/PPR flights are full; narrowing subsets stay limited", () => {
  const MED = "!MIA 10/012 MIA AD AP CLSD EXC MEDEVAC AND EMERG ACFT 2610031800-2610051200";
  const ALL = "!MIA 10/013 MIA AD AP CLSD TO ALL ACFT EXC HURRICANE EVAC AND RELIEF FLT PPR 2610031800-2610051200";
  assert.equal(closureScope(MED), "full");
  assert.equal(closureScope(ALL), "full");
  assert.equal(closureScope("!X 1/1 X AD AP CLSD EXC MIL ACFT"), "full");
  assert.equal(closureScope("!X 1/1 X AD AP CLSD EXC SKED AIR CARRIER OPS"), "limited");
  assert.equal(closureScope("!X 1/1 X AD AP CLSD TO TRANSIENT ACFT"), "limited");
  assert.equal(closureScope("!X 1/1 X AD AP CLSD TO ACFT MORE THAN 100000 LBS"), "limited");
  const m = describeClosure(MED, { tz: "America/New_York", now: NOW });
  assert.equal(m.plain, "Airport closed except emergency and medical flights. Through Oct 5.");
  const a = describeClosure(ALL, { tz: "America/New_York", now: NOW });
  assert.equal(a.plain, "Airport closed except relief and evacuation flights and flights approved in advance. Through Oct 5.");
  for (const d of [m, a]) assert.doesNotMatch(d.plain, /\b(MEDEVAC|EMERG|FLT|ACFT|EXC|PPR|CLSD)\b/);
  const fi = assessFaa({ type: "closure", reason: MED, ...m });
  assert.equal(fi.level, 4);
  assert.match(fi.text, /^Airport closed/);
});
