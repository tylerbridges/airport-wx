// Hub cascade warnings (poller/hubs.mjs) and their wiring in core.mjs assemble / trip-risk.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  CARRIER_HUBS, HUBS, TRACONS, TOP_ROUTES, sameTracon, hubTrouble, cascadeReason, parseCascade, cascades, applyCascade,
} from "./hubs.mjs";
import { tripStatus, programOf } from "./trip-risk.mjs";

const C = createRequire(import.meta.url)("../site/cats.js");
const H = 3600e3;
const T0 = Date.parse("2026-10-04T18:00:00Z");
const AIRPORTS = (await import("node:fs")).readFileSync(new URL("../airports.json", import.meta.url), "utf8");
const MAJORS = JSON.parse(AIRPORTS).map((a) => a.iata);

/** status.json-like airport: spec[i] = {reasons, delay p}; other hours quiet. */
function ap(iata, city, spec = {}, tz = "America/Chicago") {
  const hours = Array.from({ length: 24 }, (_, i) => {
    const s = spec[i] || {};
    return { t: new Date(T0 + i * H).toISOString(), level: s.level ?? 0, reasons: s.reasons || [], ...(s.p != null ? { delay: { p: s.p } } : {}) };
  });
  return { iata, city, tz, state: "TX", hours, faa: [], atcscc: [], opsplan: null };
}
const gsHours = (from, to) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, k) => [from + k, { level: 4, reasons: ["Ground stop — weather (thunderstorms), until 9 PM CT"], p: 1 }]));
/** Internal risk rows (buildHours shape) with base levels. */
const rows = (levels) => levels.map((l, i) => ({ t: new Date(T0 + i * H), items: l ? [{ level: l, text: l === 1 ? "Ceiling 2,500 ft" : "Ceiling 800 ft", fc: true }] : [], level: l }));

test("tables: carrier hubs as documented, top routes for all 32 airports, hubs only, no same-TRACON pairs", () => {
  assert.deepEqual(CARRIER_HUBS.AA, ["DFW", "CLT", "ORD", "PHL", "MIA", "PHX", "DCA", "LGA", "JFK", "LAX"]);
  assert.deepEqual(CARRIER_HUBS.B6, ["JFK", "BOS", "FLL"]);
  assert.deepEqual(TRACONS.N90, ["JFK", "LGA", "EWR"]);
  assert.deepEqual(Object.keys(TOP_ROUTES).sort(), [...MAJORS].sort());
  for (const [iata, list] of Object.entries(TOP_ROUTES)) {
    assert.equal(list.length, 5, iata);
    assert.equal(new Set(list).size, 5, iata);
    for (const h of list) {
      assert.ok(HUBS.has(h), `${iata}: ${h} is a carrier hub`);
      assert.notEqual(h, iata);
      assert.ok(!sameTracon(h, iata), `${iata}: ${h} shares its TRACON`);
    }
  }
  assert.ok(sameTracon("JFK", "LGA") && sameTracon("EWR", "JFK") && sameTracon("ORD", "MDW") && !sameTracon("ORD", "DFW") && !sameTracon("JFK", "JFK"));
});

test("hub trouble: closure > ground stop > delay program > delays likely (p >= 0.45)", () => {
  assert.equal(hubTrouble({ reasons: ["Ground stop until 7 PM CT", "Airport closed until 9 PM CT"] }), "closure");
  assert.equal(hubTrouble({ reasons: ["Ground stop — weather (thunderstorms), until 7 PM CT"] }), "ground stop");
  assert.equal(hubTrouble({ reasons: ["Ground delay program — weather (wind), avg 45m"] }), "ground delay program");
  assert.equal(hubTrouble({ level: 3, reasons: ["Thunderstorms"], delay: { p: 0.45 } }), "delays");
  assert.equal(hubTrouble({ level: 3, reasons: ["Thunderstorms"], delay: { p: 0.44 } }), null);
  // a routine busy-hour rate on a quiet hour doesn't cascade; well above the usual rate, or an FAA override, does
  assert.equal(hubTrouble({ level: 0, reasons: [], delay: { p: 0.5, pTypical: 0.45 } }), null);
  assert.equal(hubTrouble({ level: 0, reasons: [], delay: { p: 0.6, pTypical: 0.3 } }), "delays");
  assert.equal(hubTrouble({ level: 0, reasons: [], delay: { p: 1, override: "delay" } }), "delays");
  assert.equal(hubTrouble({ reasons: ["Delays — weather, departures 16–30m"] }), null); // general delays alone: only through p
});

test("cascade reason: one step at most, never above Moderate; cats.js and trip-risk read it back", () => {
  assert.deepEqual(cascadeReason("ORD", "Chicago", "ground stop", 1), { level: 2, text: "ORD ground stop may delay flights to and from Chicago" });
  assert.deepEqual(cascadeReason("ORD", "Chicago", "ground stop", 0), { level: 1, text: "ORD ground stop may delay some flights to and from Chicago" });
  assert.equal(cascadeReason("ORD", "Chicago", "ground stop", 3).level, 2); // below the hour's level: no raise
  assert.deepEqual(cascadeReason("DFW", "Dallas–Fort Worth", "delays", 2), { level: 1, text: "DFW delays may spread to some flights to and from Dallas–Fort Worth" });
  assert.equal(cascadeReason("MIA", "Miami", "closure", 1).text, "MIA closure may disrupt flights to and from Miami");
  for (const kind of ["closure", "ground stop", "ground delay program", "delays"]) {
    for (const base of [0, 1, 2, 3, 4]) {
      const r = cascadeReason("ORD", "Chicago", kind, base);
      assert.ok(Math.max(base, r.level) <= Math.max(base, Math.min(base + 1, 2)), `${kind} on ${base}`);
      assert.deepEqual([C.reason(r.text).level, C.reason(r.text).cat], [r.level, "faa"]);
      assert.equal(parseCascade(r.text).level, r.level);
      assert.equal(programOf(r.text), null);
    }
  }
});

test("DFW ground stop: AUS, IAH and MSP get notes 1–4 hours after it; not DFW, not airports without DFW service", () => {
  const all = [
    ap("DFW", "Dallas–Fort Worth", gsHours(0, 1)), ap("AUS", "Austin"), ap("IAH", "Houston"), ap("MSP", "Minneapolis"),
    ap("SEA", "Seattle", {}, "America/Los_Angeles"),
  ];
  const n = cascades(all);
  for (const c of ["AUS", "IAH", "MSP"]) {
    assert.deepEqual(n.get(c).map((x) => x.i), [1, 2, 3, 4, 5], c); // GS hours 0–1 -> hours 1–5
    assert.ok(n.get(c).every((x) => x.hub === "DFW" && x.kind === "ground stop" && x.city === "Dallas–Fort Worth"));
  }
  assert.equal(n.has("DFW"), false);
  assert.equal(n.has("SEA"), false);
});

test("the New York airports get no notes from each other; Chicago's two neither", () => {
  const all = [ap("JFK", "New York", gsHours(0, 3)), ap("LGA", "New York"), ap("EWR", "Newark"), ap("ORD", "Chicago", gsHours(0, 3)), ap("MDW", "Chicago"), ap("BOS", "Boston"), ap("MSP", "Minneapolis")];
  const n = cascades(all);
  assert.ok(!(n.get("LGA") || []).some((x) => x.hub === "JFK"), "LGA from JFK");
  assert.ok(!(n.get("EWR") || []).some((x) => x.hub === "JFK"), "EWR from JFK");
  assert.ok(!(n.get("MDW") || []).some((x) => x.hub === "ORD"), "MDW from ORD");
  assert.ok((n.get("LGA") || []).some((x) => x.hub === "ORD"), "LGA still hears about ORD");
  assert.ok((n.get("BOS") || []).some((x) => x.hub === "ORD"));
  assert.ok((n.get("MSP") || []).some((x) => x.hub === "ORD"));
});

test("applyCascade: Low -> Moderate, None -> Low, Moderate+ unchanged; summary runs per hub", () => {
  const hours = rows([0, 1, 0, 2, 3, 1, 0, 0]);
  const notes = [1, 2, 3, 4, 5].map((i) => ({ i, hub: "DFW", kind: "ground stop", city: "Dallas–Fort Worth" }));
  const summary = applyCascade(hours, notes);
  assert.deepEqual(hours.map((h) => h.level), [0, 2, 1, 2, 3, 2, 0, 0]);
  assert.equal(hours[1].items[0].text, "DFW ground stop may delay flights to and from Dallas–Fort Worth");
  assert.equal(hours[2].items[0].text, "DFW ground stop may delay some flights to and from Dallas–Fort Worth");
  assert.ok(hours[4].items.some((x) => x.text.startsWith("DFW ground stop") && x.level === 2), "kept as a reason below a High hour");
  assert.deepEqual(summary, [{ hub: "DFW", kind: "ground stop", from: new Date(T0 + H).toISOString(), to: new Date(T0 + 6 * H).toISOString(), text: "DFW ground stop may delay flights to and from Dallas–Fort Worth" }]);
  // a run that raised nothing stays in the hours' reasons but not in the summary (no card/sheet line)
  const h3 = rows([3, 2, 3]);
  assert.deepEqual(applyCascade(h3, [0, 1, 2].map((i) => ({ i, hub: "ORD", kind: "ground stop", city: "Chicago" }))), []);
  assert.deepEqual(h3.map((h) => h.level), [3, 2, 3]);
  assert.ok(h3.every((h) => h.items.some((x) => x.text === "ORD ground stop may delay flights to and from Chicago")));
  // hub delays likely: Low, never past it
  const h2 = rows([0, 1, 2]);
  applyCascade(h2, [0, 1, 2].map((i) => ({ i, hub: "ORD", kind: "delays", city: "Chicago" })));
  assert.deepEqual(h2.map((h) => h.level), [1, 1, 2]);
});

test("assemble: hub exposure is recorded for research without changing risk", async () => {
  const { assemble } = await import("./core.mjs");
  const now = new Date("2026-10-04T18:30:00Z");
  const mk = (iata, icao, city, tz) => ({ iata, icao, name: iata, city, state: "TX", tz, lat: 30, lon: -97 });
  const airports = [mk("DFW", "KDFW", "Dallas–Fort Worth", "America/Chicago"), mk("AUS", "KAUS", "Austin", "America/Chicago")];
  const sec = (ms) => Math.floor(ms / 1000);
  const tafs = [{ icaoId: "KAUS", issueTime: sec(+now - H), validTimeFrom: sec(+now - H), validTimeTo: sec(+now + 30 * H),
    fcsts: [{ fcstChange: null, timeFrom: sec(+now - H), timeTo: sec(+now + 30 * H), wdir: 180, wspd: 8, visib: "6+", clouds: [{ cover: "BKN", base: 2500 }] }] }];
  const faaParsed = { byAirport: { DFW: [{ type: "ground_stop", reason: "thunderstorms", detail: "until 2:30 PM CDT", badge: "GROUND STOP", end: new Date(+now + 1.5 * H).toISOString() }] } };
  const out = assemble({ airports, now, metars: [], tafs, sigmets: null, faaParsed, spc: null, nws: null });
  const aus = out.find((a) => a.iata === "AUS");
  const dfw = out.find((a) => a.iata === "DFW");
  assert.deepEqual(dfw.hours.slice(0, 3).map((h) => h.level), [4, 4, null]); // DFW has no METAR/TAF here: after the stop, no forecast (null), not Clear
  assert.equal(dfw.cascade, undefined);
  assert.equal(aus.hours[0].level, 1); // the hour of the ground stop itself: no note
  assert.deepEqual(aus.hours.slice(1, 7).map(h => h.level), [1, 1, 1, 1, 1, 1]);
  assert.ok(aus.hours.every(h => !h.reasons.some(r => /may delay/.test(r))));
  assert.equal(aus.peak.level, 1);
  assert.equal(aus.cascade, undefined);
  assert.equal(aus.hubResearch.signalCount, 5);
  assert.equal(aus.hubResearch.signals[0].hub, "DFW");
  assert.equal(aus.hubResearch.hubs.find(h => h.hub === "DFW").available, true);
  assert.equal(aus.hubResearch.hubs.find(h => h.hub === "DEN").available, false);
  assert.equal(dfw.hubResearch.signalCount, 0);
  assert.ok(!aus.hours.some(h => h.delay?.override));
});

test("trips: parked spillover notes are ignored; directly applicable Ground Stops still warn", () => {
  const note = "DFW ground stop may delay flights to and from Dallas–Fort Worth";
  const MSP = ap("MSP", "Minneapolis", { 2: { level: 2, reasons: [note] }, 3: { level: 2, reasons: [note] } });
  const DFW = ap("DFW", "Dallas–Fort Worth", gsHours(0, 1));
  const ATL = ap("ATL", "Atlanta", {}, "America/New_York");
  const at = (h, m = 0) => new Date(T0 + h * H + m * 60e3).toISOString();
  const by = { MSP, DFW, ATL };
  const r = tripStatus({ legs: [{ from: "MSP", to: "DFW", dep: at(3, 10), arr: at(5, 40) }] }, by, { now: T0 + 20 * 60e3 });
  assert.equal(r.label, "On track");
  assert.ok(!r.concerns.some(c => /knock-on|DFW ground stop/.test(c.text)));
  assert.ok(!r.concerns.some((c) => c.kind === "weather"), "the note isn't a weather concern");
  // a leg that doesn't touch DFW ignores MSP's DFW note
  const r2 = tripStatus({ legs: [{ from: "MSP", to: "ATL", dep: at(3, 10), arr: at(6) }] }, by, { now: T0 + 20 * 60e3 });
  assert.equal(r2.label, "On track");
  // while the ground stop still holds the flight, the program concern wins and the cascade isn't repeated
  const MSP2 = ap("MSP", "Minneapolis", { 1: { level: 2, reasons: [note] } });
  const r3 = tripStatus({ legs: [{ from: "MSP", to: "DFW", dep: at(1, 10), arr: at(3, 40) }] }, { MSP: MSP2, DFW, ATL }, { now: T0 + 20 * 60e3 });
  assert.equal(r3.label, "Disruption");
  assert.ok(!r3.concerns.some((c) => /knock-on/.test(c.text)));
});
