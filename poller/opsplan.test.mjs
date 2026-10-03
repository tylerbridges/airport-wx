import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpsPlan, opsPlanFor, opsPlanNational, facilityAirports, untilHhmm, mdyTime, parseSir, programKind } from "./opsplan.mjs";
import { opsPlanItems, buildHours, constraintPhrase } from "./risk.mjs";
import { expandTemplate } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// The fixture is the real advADB.jsp page captured 2026-10-03T22:17Z; at this time its tokens expand to the original.
const CAPTURED = new Date("2026-10-03T22:18:00Z");
const realPage = async () => expandTemplate(await readFile(join(HERE, "fixtures/atcscc.html"), "latin1"), CAPTURED);

test("ops plan (real page): header, issue time, event time, remarks", async () => {
  const html = await realPage();
  assert.match(html, /ATCSCC&nbsp;ADVZY&nbsp;072&nbsp;DCC&nbsp;10\/03\/2026&nbsp;OPERATIONS PLAN/);
  assert.match(html, /26\/10\/03 21:28 {2}DCCOPS/);
  const p = parseOpsPlan(html);
  assert.equal(p.advisory, "072");
  assert.equal(p.date, "2026-10-03");
  assert.equal(p.issued, "2026-10-03T21:28:00.000Z");
  assert.equal(p.eventTime, "2026-10-03T22:00:00.000Z");
  assert.equal(p.eventText, "03/2200 - AND LATER");
  assert.equal(p.validEnd, "2026-10-03T23:59:00.000Z");
  assert.match(p.remarks, /^WEATHER IS IMPROVING THROUGHOUT THE NAS .* SEA HAS BEEN REMOVED FROM THE TERMINAL PORTION OF THE PLAN\.$/);
  // counts per section in the real sample
  assert.deepEqual(
    [p.staffing.length, p.constraints.length, p.programs.length, p.sirs.length, p.enroute.constraints.length, p.enroute.active.length, p.enroute.planned.length, p.cdrs.length, p.afp.active.length, p.afp.planned.length, p.launches.length],
    [3, 4, 5, 15, 3, 1, 4, 4, 0, 0, 3],
  );
});

test("ops plan (real page): staffing triggers roll past midnight; centers are national", async () => {
  const p = parseOpsPlan(await realPage());
  const bna = p.staffing.find((x) => x.facility === "BNA");
  assert.deepEqual([bna.airports, bna.detail, bna.until, bna.kind, bna.cause], [["BNA"], "OPERATIONS", "2026-10-04T01:00:00.000Z", "staffing", "staffing"]);
  assert.equal(bna.raw, "UNTIL 0100 -BNA OPERATIONS");
  const phl = p.staffing.find((x) => x.facility === "PHL");
  assert.deepEqual([phl.airports, phl.detail, phl.until], [["PHL"], "AREA C", "2026-10-04T03:00:00.000Z"]);
  const zoa = p.staffing.find((x) => x.facility === "ZOA");
  assert.deepEqual(zoa.airports, []);
  assert.equal(opsPlanNational(p, CAPTURED).staffing[0].facility, "ZOA");
});

test("ops plan (real page): terminal constraints per airport, TRACONs mapped", async () => {
  const p = parseOpsPlan(await realPage());
  const vcts = p.constraints.find((x) => x.reason === "VCTS");
  assert.deepEqual(vcts.airports, ["CLT", "ATL", "MCO", "TPA", "IAH", "HOU"]);
  assert.equal(vcts.cause, "weather");
  const n90 = p.constraints.find((x) => x.codes[0] === "N90");
  assert.deepEqual([n90.airports, n90.reason], [["JFK", "LGA", "EWR"], "WIND"]);
  assert.deepEqual(p.constraints.find((x) => x.reason === "LOW CIGS").airports, ["DFW", "SEA"]);
  for (const a of ["JFK", "LGA", "EWR"]) assert.equal(opsPlanFor(p, a, CAPTURED).constraints[0].reason, "WIND");
});

test("ops plan (real page): active and possible programs", async () => {
  const p = parseOpsPlan(await realPage());
  const san = p.programs.find((x) => x.airports.includes("SAN"));
  assert.deepEqual([san.program, san.status, san.until], ["GDP", "active", "2026-10-04T00:59:00.000Z"]);
  const mcoTpa = p.programs.find((x) => x.airports.includes("MCO"));
  assert.deepEqual([mcoTpa.airports, mcoTpa.program, mcoTpa.status, mcoTpa.until], [["MCO", "TPA"], "GS", "possible", "2026-10-03T23:00:00.000Z"]);
  assert.equal(opsPlanFor(p, "TPA", CAPTURED).programs[0].until, "2026-10-03T23:00:00.000Z");
  const atl = p.programs.find((x) => x.airports.includes("ATL"));
  assert.deepEqual([atl.program, atl.status], ["GS/GDP", "possible"]);
  assert.deepEqual(p.programs.find((x) => x.airports.includes("FLL")).airports, ["MIA", "FLL"]);
  assert.deepEqual(["GROUND STOP POSSIBLE", "GROUND DELAY PROGRAM", "GROUND STOP/DELAY PROGRAM POSSIBLE", "CDRS"].map(programKind), ["GS", "GDP", "GS/GDP", null]);
});

test("ops plan (real page): SIRs with 2- and 4-digit years, statuses, centers national", async () => {
  const p = parseOpsPlan(await realPage());
  const den = p.sirs.find((x) => x.facility === "DEN");
  assert.deepEqual([den.airports, den.runways, den.status, den.until, den.cause], [["DEN"], ["16R/34L"], "closed", "2026-11-05T00:00:00.000Z", "runway"]);
  const by = (f, re) => p.sirs.find((x) => x.facility === f && re.test(x.item));
  assert.deepEqual([by("BWI", /RWY/).runways, by("BWI", /RWY/).until], [["10/28", "15R/33L"], "2026-10-10T09:00:00.000Z"]);
  const phl = by("PHL", /GS/);
  assert.deepEqual([phl.status, phl.what, phl.runways, phl.cause, phl.until], ["out of service", "glideslope", ["27R"], "equipment", "2026-10-15T23:59:00.000Z"]);
  const bos = by("BOS", /09\/27/);
  assert.deepEqual([bos.status, bos.until], ["limited", "2026-10-31T09:00:00.000Z"]);
  const twy = by("MIA", /TWY/);
  assert.deepEqual([twy.status, twy.what, twy.runways], ["closed", "taxiway", []]);
  const sfo = by("SFO", /CONSTRUCTION/);
  assert.deepEqual([sfo.status, sfo.runways, sfo.taxiway], ["construction", ["01R/19L"], true]);
  const zma = by("ZMA", /RCAG/);
  assert.deepEqual([zma.airports, zma.status, zma.cause], [[], "maintenance", "equipment"]);
  assert.equal(opsPlanNational(p, CAPTURED).sirs[0].facility, "ZMA");
  assert.equal(by("DFW", /18L/).until, "2027-05-15T04:00:00.000Z");
  assert.equal(parseSir("garbage"), null);
});

test("ops plan (real page): launches and en route items", async () => {
  const p = parseOpsPlan(await realPage());
  const sx = p.launches[0];
  assert.deepEqual([sx.name, sx.site, sx.cause], ["SPACEX SDA-T1A", "VANDENBERG SFB, CA", "space"]);
  assert.deepEqual(sx.primary, { start: "2026-10-05T08:06:00.000Z", end: "2026-10-05T09:11:00.000Z" });
  assert.deepEqual(sx.backup, { start: "2026-10-06T07:59:00.000Z", end: "2026-10-06T09:04:00.000Z" });
  assert.deepEqual([p.launches[1].name, p.launches[1].site], ["NASA CREW-12 REENTRY", null]);
  assert.equal(p.launches[2].name, "NORTHROP GRUMMAN MK21-2B");
  assert.match(p.enroute.constraints[1].text, /^ZNY - L453 IS CLOSED/);
  assert.deepEqual(p.enroute.active[0], { text: "OHIO_VALLEY_TO_FLORIDA_2", until: "2026-10-03T23:00:00.000Z", from: null, raw: "UNTIL 2300 -OHIO_VALLEY_TO_FLORIDA_2" });
  const nat = opsPlanNational(p, CAPTURED);
  assert.equal(nat.launches.length, 3);
  assert.equal(nat.plan.advisory, "072");
  assert.deepEqual(nat.afp, { active: [], planned: [] });
});

test("ops plan: helpers, expiry, not-a-plan pages", () => {
  const base = Date.parse("2026-10-03T21:28:00Z");
  assert.equal(new Date(untilHhmm("2300", base)).toISOString(), "2026-10-03T23:00:00.000Z");
  assert.equal(new Date(untilHhmm("0059", base)).toISOString(), "2026-10-04T00:59:00.000Z");
  assert.equal(new Date(untilHhmm("2110", base)).toISOString(), "2026-10-03T21:10:00.000Z"); // within 30 min before: same day
  assert.equal(new Date(mdyTime("10/31/2026 0900Z")).toISOString(), "2026-10-31T09:00:00.000Z");
  assert.equal(new Date(mdyTime("01/01/27 2359Z")).toISOString(), "2027-01-01T23:59:00.000Z");
  assert.deepEqual(facilityAirports("N90"), ["JFK", "LGA", "EWR"]);
  assert.deepEqual(facilityAirports("ZNY"), []);
  assert.deepEqual(facilityAirports("MIA"), ["MIA"]);
  assert.deepEqual(facilityAirports("MIA", { staffing: true }), ["MIA", "FLL"]);
  assert.equal(parseOpsPlan("<html>ATCSCC ADVZY 050 ORD/ZAU 10/03/2026 CDM GROUND STOP</html>"), null);
  assert.equal(parseOpsPlan(""), null);
  assert.equal(parseOpsPlan(null), null);
});

test("ops plan: expired items are dropped per airport", async () => {
  const p = parseOpsPlan(await realPage());
  const later = new Date("2026-10-04T02:00:00Z");
  assert.equal(opsPlanFor(p, "MCO", later).programs.length, 0); // until 2300Z
  assert.equal(opsPlanFor(p, "BNA", later).staffing.length, 0); // until 0100Z
  assert.equal(opsPlanFor(p, "DEN", later).sirs.length, 1);
  assert.equal(opsPlanFor(p, "PHX", later), null);
});

// ---------- risk rules ----------

const NOW = CAPTURED; // 6:18 PM EDT, 3:18 PM PDT

test("ops plan risk: possible GS Moderate until its time with the constraint's cause", async () => {
  const p = parseOpsPlan(await realPage());
  const items = opsPlanItems(opsPlanFor(p, "MCO", NOW), { tz: "America/New_York", now: NOW }).filter((x) => x.kind === "program");
  assert.deepEqual(items.map((x) => [x.kind, x.level, x.text, x.cause]), [["program", 2, "FAA plans a possible ground stop until 7 PM (storms)", "weather"]]);
  const hours = buildHours({ now: NOW, tz: "America/New_York", opsplan: opsPlanFor(p, "MCO", NOW) });
  const gs = (h) => h.items.some((i) => /possible ground stop/.test(i.text));
  assert.deepEqual(hours.slice(0, 2).map(gs), [true, false]); // 22Z hour yes, 23Z no (until 2300Z)
  // no terminal constraint: "conditions"
  assert.equal(opsPlanItems(opsPlanFor(p, "FLL", NOW), { tz: "America/New_York", now: NOW })[0].text, "FAA plans a possible ground stop until 7 PM (conditions)");
  assert.equal(opsPlanItems(opsPlanFor(p, "ATL", NOW), { tz: "America/New_York", now: NOW })[0].text, "FAA plans a possible ground stop or delay program until 7 PM (storms)");
});

test("ops plan risk: staffing Moderate until its time; constraint alone Low; SIR closure Low", async () => {
  const p = parseOpsPlan(await realPage());
  const bna = opsPlanItems(opsPlanFor(p, "BNA", NOW), { tz: "America/Chicago", now: NOW });
  assert.deepEqual(bna.map((x) => [x.level, x.text]), [
    [2, "Air traffic control staffing shortage until 8 PM — delays possible"],
    [1, "Runway 13/31 closed until Jan 1"],
  ]);
  const h = buildHours({ now: NOW, tz: "America/Chicago", opsplan: opsPlanFor(p, "BNA", NOW) });
  assert.deepEqual(h.slice(0, 5).map((x) => x.level), [2, 2, 2, 0, 0]); // 22Z, 23Z, 00Z; staffing ends 01Z
  assert.ok(!h[1].items.some((i) => /Runway/.test(i.text)), "SIR closures score hour 0 only");
  const jfk = opsPlanItems(opsPlanFor(p, "JFK", NOW), { tz: "America/New_York", now: NOW });
  assert.deepEqual(jfk.map((x) => [x.level, x.text, x.cause]), [[1, "FAA reports wind affecting arrivals", "weather"]]);
  const den = opsPlanItems(opsPlanFor(p, "DEN", NOW), { tz: "America/Denver", now: NOW });
  assert.deepEqual(den.map((x) => [x.level, x.text]), [[1, "Runway 16R/34L closed until Nov 4"]]); // 2026-11-05T00:00Z = Nov 4, 6 PM MST
  assert.deepEqual(constraintPhrase("LOW CIGS"), { long: "low clouds", short: "low clouds" });
  assert.deepEqual(constraintPhrase("VCTS"), { long: "nearby storms", short: "storms" });
});

test("ops plan risk: active GDP High unless NAS status / ATCSCC already has it", async () => {
  const p = parseOpsPlan(await realPage());
  const san = opsPlanFor(p, "SAN", NOW);
  const alone = opsPlanItems(san, { tz: "America/Los_Angeles", now: NOW });
  assert.deepEqual(alone.map((x) => [x.level, x.text]), [[3, "Ground delay program until 5:59 PM"]]);
  const h = buildHours({ now: NOW, tz: "America/Los_Angeles", opsplan: san });
  assert.deepEqual(h.slice(0, 4).map((x) => x.level), [3, 3, 3, 0]);
  // NAS status lists the same GDP (the real faa.xml did): keep only the NAS one
  const faa = [{ type: "ground_delay", reason: "wind", detail: "avg 49m, max 2h 18m", cause: "weather" }];
  const withNas = opsPlanItems(san, { faa, tz: "America/Los_Angeles", now: NOW });
  assert.deepEqual(withNas.map((x) => [x.level, x.dup]), [[0, true]]);
  const h2 = buildHours({ now: NOW, tz: "America/Los_Angeles", faa, opsplan: san });
  assert.deepEqual(h2[0].items.filter((i) => /round delay/.test(i.text)).map((i) => i.text), ["Ground delay program — weather (wind), avg 49m, max 2h 18m, until further notice"]);
  assert.equal(h2[3].level, 3); // the NAS GDP has no end: held 3 h
  assert.equal(h2[4].level, 0);
  const adv = [{ type: "GDP", active: true }];
  assert.equal(opsPlanItems(san, { atcscc: adv, tz: "America/Los_Angeles", now: NOW })[0].dup, true);
});

test("ops plan risk: glideslope out of service / limited ops are info unless the hour is IFR", async () => {
  const p = parseOpsPlan(await realPage());
  const phl = opsPlanFor(p, "PHL", NOW);
  const gs = opsPlanItems(phl, { tz: "America/New_York", now: NOW }).find((x) => x.kind === "sir");
  assert.deepEqual([gs.level, gs.ifr, gs.text, gs.cause], [0, true, "Runway 27R glideslope out of service until Oct 15", "equipment"]);
  const vfr = { rawOb: "KPHL", visib: "10+", clouds: [{ cover: "FEW", base: 5000 }], fltCat: "VFR" };
  const ifr = { ...vfr, visib: "2", fltCat: "IFR" };
  const hv = buildHours({ now: NOW, tz: "America/New_York", metar: vfr, opsplan: phl });
  assert.ok(!hv[0].items.some((i) => /glideslope/.test(i.text)));
  const hi = buildHours({ now: NOW, tz: "America/New_York", metar: ifr, opsplan: phl });
  assert.ok(hi[0].items.some((i) => i.level === 1 && i.text === "Runway 27R glideslope out of service until Oct 15"));
  const bos = opsPlanItems(opsPlanFor(p, "BOS", NOW), { tz: "America/New_York", now: NOW });
  assert.deepEqual(bos.map((x) => [x.level, x.text]), [[0, "Runway 9/27 limited operations until Oct 31"], [0, "Runway 15R/33L limited operations until Nov 1"]]);
  // a SIR closure already in NAS status (NOTAM) is not scored twice
  const mia = opsPlanFor(p, "MIA", NOW);
  const dup = opsPlanItems(mia, { faa: [{ type: "closure", runways: ["8L/26R"] }], tz: "America/New_York", now: NOW }).find((x) => /8L\/26R/.test(x.text));
  assert.deepEqual([dup.level, dup.dup], [0, true]);
  const twy = opsPlanItems(mia, { tz: "America/New_York", now: NOW }).find((x) => /Taxiway/.test(x.text));
  assert.deepEqual([twy.level, twy.text], [0, "Taxiway closures until Nov 8"]);
});

test("ops plan narrative (real page): delays at MCO/TPA expected to continue -> Moderate for both", async () => {
  const p = parseOpsPlan(await realPage());
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0].text, /^ZJX REPORTS THAT TPA AND MCO ARE STILL EXPERIENCING SOME DEVIATIONS/);
  for (const a of ["MCO", "TPA"]) {
    const op = opsPlanFor(p, a, NOW);
    assert.deepEqual(op.notes.map((n) => [n.airports, n.continuing]), [[["MCO", "TPA"], true]]);
    const items = opsPlanItems(op, { tz: "America/New_York", now: NOW });
    const note = items.find((x) => x.kind === "note");
    assert.deepEqual([note.level, note.text], [2, "FAA reports delays at MCO/TPA expected to continue"]);
    const h = buildHours({ now: NOW, tz: "America/New_York", opsplan: op });
    assert.ok(h[1].items.some((i) => i.text === note.text), "until the plan's valid end (23:59Z)");
    assert.ok(!h[2].items.some((i) => i.text === note.text));
  }
  // "SEA HAS BEEN REMOVED FROM THE TERMINAL PORTION OF THE PLAN." has no delay words; THE/NAS/ARE aren't airports
  assert.equal(opsPlanFor(p, "SEA", NOW).notes.length, 0);
  assert.equal(opsPlanFor(p, "ATL", NOW).notes.length, 0);
});
