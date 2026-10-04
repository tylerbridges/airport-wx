import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  notamsFromSearch, notamsFromApi, notamsFor, notamDate, classifyNotam, notamSchedule, activeIn, stretchEnd, notamItem, untilWords, scheduleWords,
} from "./notams.mjs";
import { noticesFor, applyNotices, alignedRunways, tfrItem } from "./notices.mjs";
import { buildHours, summarize, hoursOutput } from "./risk.mjs";
import { noticeTruth, truthLine } from "./record.mjs";
import { jsonOrWhy } from "./notices-poll.mjs";
import { tripStatus, noticeOf } from "./trip-risk.mjs";
import { expandTemplate } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-04T18:20:00Z"); // Sun 2:20 PM ET
const H = 3600e3;
const yymm = (ms) => new Date(ms).toISOString().replace(/\D/g, "").slice(2, 12);
const span = (a, b) => `${yymm(+NOW + a * H)}-${yymm(+NOW + b * H)}`;
const LGA = { iata: "LGA", icao: "KLGA", tz: "America/New_York", lat: 40.7769, lon: -73.874 };
const LGA_RWY = [["04/22", 32], ["13/31", 122]];
const DEN = { iata: "DEN", icao: "KDEN", tz: "America/Denver", lat: 39.8561, lon: -104.6737 };
const DEN_RWY = [["07/25", 91], ["08/26", 91], ["16L/34R", 181], ["16R/34L", 181], ["17L/35R", 181], ["17R/35L", 181]];
const rec = (text, extra = {}) => ({ ...notamsFromSearch({ notamList: [{ icaoId: "KLGA", facilityDesignator: "LGA", notamNumber: "10/1", traditionalMessage: text, ...extra }] })[0] });

// ---------- sources ----------

test("NOTAM Search reply: fields, MM/DD/YYYY HHMM times, PERM, cancelled, fallbacks", () => {
  const j = {
    notamList: [
      { icaoId: "KORD", facilityDesignator: "ORD", notamNumber: "10/123", traditionalMessage: "!ORD 10/123 ORD RWY 10L/28R CLSD 2610011300-2611052359", startDate: "10/01/2026 1300", endDate: "11/05/2026 2359", issueDate: "10/01/2026 1200", keyword: "RWY" },
      { icaoId: "KORD", facilityDesignator: "ORD", notamNumber: "10/124", traditionalMessageFrom4thWord: "TWY B CLSD 2610011300-PERM", endDate: "PERM" },
      { icaoId: "KORD", facilityDesignator: "ORD", notamNumber: "10/125", icaoMessage: "A1/26 NOTAMN Q) KZAU/QMXLC A) KORD B) 2610011300 C) 2610021300 E) TWY C <b>CLSD</b>" },
      { icaoId: "KORD", facilityDesignator: "ORD", notamNumber: "09/1", traditionalMessage: "!ORD 09/1 ORD RWY 4L/22R CLSD", cancelledOrExpired: true },
    ],
  };
  const r = notamsFromSearch(j);
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].id, r[0].loc, r[0].start, r[0].end, r[0].perm, r[0].issued], ["ORD 10/123", "KORD", Date.UTC(2026, 9, 1, 13), Date.UTC(2026, 10, 5, 23, 59), false, Date.UTC(2026, 9, 1, 12)]);
  assert.equal(r[1].text, "!ORD 10/124 ORD TWY B CLSD 2610011300-PERM");
  assert.equal(r[1].perm, true);
  assert.equal(r[1].end, null);
  assert.equal(r[2].text, "TWY C CLSD"); // ICAO E) text, tags stripped
  assert.equal(notamDate("PERM"), null);
  assert.deepEqual(notamsFromSearch({ error: "bad" }), []);
  assert.deepEqual(notamsFromSearch(null), []);
});

test("NOTAM API (geoJson): LOCAL_FORMAT text, ISO times, PERM; fixture parses", async () => {
  const text = expandTemplate((await readFile(join(HERE, "fixtures/notams-api.json"), "utf8")).replace(/\{\{notam([+-]\d+)\}\}/g, (_, n) => yymm(+NOW + Number(n) * 60e3)), NOW);
  const r = notamsFromApi(JSON.parse(text));
  assert.equal(r.length, 2);
  assert.equal(r[0].loc, "KMSP");
  assert.match(r[0].text, /^!MSP 10\/050 MSP RWY 12R\/30L CLSD/);
  assert.equal(r[0].end, +NOW + 600 * 60e3);
  assert.equal(r[1].perm, true);
  assert.equal(classifyNotam(r[1].text).kind, "ils");
  assert.deepEqual(notamsFromApi({ items: [{ properties: { coreNOTAMData: { notam: { type: "C", number: "1/1", location: "MSP", text: "RWY 4 CLSD" } } } }] }), []);
  assert.equal(notamsFor(r, { icao: "KMSP", iata: "MSP" }).length, 2);
  assert.equal(notamsFor(r, { icao: "KORD", iata: "ORD" }).length, 0);
});

test("a NOTAM Search robot check reads as a clear error, not a parse crash", () => {
  assert.throws(() => jsonOrWhy("<html><title>Are you human?</title>captcha</html>", "FAA NOTAM Search"), /answered with a web page instead of data \(a robot check\)/);
  assert.throws(() => jsonOrWhy("", "FAA NOTAM Search"), /empty reply/);
  assert.deepEqual(jsonOrWhy('{"notamList": []}', "x"), { notamList: [] });
});

// ---------- classification + translation ----------

test("classify: runway, closure, limited, ILS/glideslope, taxiway, construction, lighting, de-icing, other", () => {
  const k = (t) => classifyNotam(t);
  assert.deepEqual(k("!DEN 10/1 DEN RWY 16R/34L CLSD"), { kind: "runway", runways: ["16R/34L"] });
  assert.deepEqual(k("!LGA 10/1 LGA RWY 04/22 CLSD EXC TAX"), { kind: "runway", runways: ["4/22"] });
  assert.equal(k("!X 10/1 X RWY 13/31 CLSD TO ACFT WINGSPAN MORE THAN 118FT").kind, "limited");
  assert.equal(k("!BUF 10/1 BUF AD AP CLSD").kind, "closure");
  assert.equal(k("!X 10/1 X RWY ALL CLSD").kind, "closure");
  assert.equal(k("!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR").kind, "limited");
  assert.deepEqual(k("!SLC 10/1 SLC NAV ILS RWY 34R GP U/S"), { kind: "ils", runways: ["34R"], what: "glideslope" });
  assert.deepEqual(k("!SFO 10/1 SFO NAV ILS RWY 28L U/S"), { kind: "ils", runways: ["28L"], what: "ils" });
  assert.deepEqual(k("!SFO 10/1 SFO NAV ILS RWY 28L LOC/GP/DME OTS"), { kind: "ils", runways: ["28L"], what: "ils" });
  assert.equal(k("!SFO 10/1 SFO NAV ILS RWY 28L DME U/S").kind, "other"); // DME only: minor
  assert.equal(k("!SFO 10/1 SFO NAV ILS RWY 28L UNMONITORED").kind, "other");
  assert.deepEqual(k("!ORD 10/1 ORD TWY B BTN TWY B5 AND TWY B7 CLSD"), { kind: "taxiway", runways: [], taxiways: ["B"], closed: true, part: true });
  assert.deepEqual(k("!ORD 10/1 ORD TWY K, L CLSD").taxiways, ["K", "L"]);
  assert.equal(k("!PHX 10/1 PHX AD AP WIP CONST ADJ TWY C").kind, "construction");
  assert.deepEqual(k("!ORD 10/1 ORD RWY 10L/28R EDGE LGT U/S"), { kind: "lighting", runways: ["10L/28R"] });
  assert.equal(k("!ORD 10/1 ORD OBST TOWER LGT (ASR 1234567) 415800N0875400W 868FT (230FT AGL) U/S").kind, "other");
  assert.equal(k("!ATL 10/1 ATL APRON DEICE PAD 1 CLSD").kind, "deice");
  assert.equal(k("!ATL 10/1 ATL SVC FUEL NOT AVBL").kind, "other");
});

test("plain English: runway closed until a date, schedule, upcoming start, ILS, taxiway, TFR-free kinds", () => {
  const tz = "America/New_York";
  const it = (t, x) => notamItem(rec(t, x), { tz, now: NOW });
  const r = it(`!LGA 10/1 LGA RWY 04/22 CLSD ${yymm(+NOW - 2 * H)}-2611052359`);
  assert.equal(r.text, "Runway 4/22 is closed until Nov 5.");
  assert.equal(r.reason, "Runway 4/22 closed until Nov 5");
  assert.deepEqual([r.kind, r.cat, r.cause, r.level, r.at], ["runway", "runways", "runway", 1, "rwy"]);
  assert.equal(it(`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-2, 3)}`).reason, "Runway 4/22 closed until 5:20 PM");
  assert.equal(it(`!LGA 10/1 LGA RWY 13/31 CLSD DLY 0400-1000 ${span(-30, 300)}`).text, "Runway 13/31 is closed daily 12 AM – 6 AM until Oct 17.");
  assert.equal(it(`!LGA 10/1 LGA RWY 13/31 CLSD ${span(5, 9)}`).text, "Runway 13/31 is closed from 7:20 PM until 11:20 PM.");
  assert.equal(it(`!LGA 10/1 LGA RWY 13/31 CLSD ${span(50, 60)}`).text, "Runway 13/31 is closed from Oct 6 until Oct 7.");
  assert.equal(it(`!LGA 10/1 LGA NAV ILS RWY 22 U/S ${span(-1, 6)}`).text, "Runway 22 instrument landing system (ILS) out of service until 8:20 PM — can slow landings in low clouds or poor visibility.");
  assert.equal(it(`!LGA 10/1 LGA NAV ILS RWY 22 GP U/S ${span(-1, 6)}`).reason, "Runway 22 glideslope out of service until 8:20 PM");
  assert.equal(it(`!LGA 10/1 LGA TWY B BTN TWY B5 AND TWY B7 CLSD ${span(-1, 6)}`).text, "Taxiway B partly closed until 8:20 PM — can add taxi time.");
  assert.equal(it(`!LGA 10/1 LGA APRON DEICE PAD 1 CLSD ${span(-1, 60)}`).text, "De-icing area changes until Oct 7 — de-icing may take longer.");
  assert.equal(it(`!LGA 10/1 LGA RWY 4/22 EDGE LGT U/S ${span(-1, 6)}`).text, "Runway 4/22 lights out of service until 8:20 PM.");
  assert.equal(it(`!LGA 10/1 LGA AD AP CLSD ${span(-1, 2)}`).reason, "Airport closed until 4:20 PM");
  assert.equal(it(`!LGA 10/1 LGA RWY 4/22 CLSD ${span(-5, -1)}`), null); // ended
  assert.equal(it(`!LGA 10/1 LGA RWY 4/22 CLSD 2610011300-PERM`).reason, "Runway 4/22 closed until further notice");
  assert.equal(untilWords(null, tz, NOW), "");
  // no raw codes in anything a traveler reads
  for (const t of ["RWY 04/22 CLSD", "NAV ILS RWY 22 U/S", "TWY B CLSD", "AD AP WIP CONST", "APRON DEICE PAD CLSD", "RWY 4/22 EDGE LGT U/S"]) {
    const x = it(`!LGA 10/1 LGA ${t} ${span(-1, 6)}`);
    assert.doesNotMatch(x.text + " " + (x.reason || ""), /\b(CLSD|RWY|TWY|U\/S|WIP|\d{4}Z)\b/, t);
  }
});

test("schedules: DLY / day ranges, overnight windows, the active stretch's end", () => {
  assert.deepEqual(notamSchedule("!X 1/1 X RWY 4 CLSD DLY 0400-1000 2610011300-2611011300"), [{ d: null, f: 240, t: 600 }]);
  assert.deepEqual(notamSchedule("!X 1/1 X RWY 4 CLSD MON-FRI 0300-1100 2610011300-2611011300"), [{ d: [1, 2, 3, 4, 5], f: 180, t: 660 }]);
  assert.deepEqual(notamSchedule("!X 1/1 X RWY 4 CLSD SAT SUN 2200-0500 2610011300-2611011300"), [{ d: [0, 6], f: 1320, t: 300 }]);
  assert.deepEqual(notamSchedule("!X 1/1 X RWY 4 CLSD 2610011300-2611011300"), []);
  const n = { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", sched: [{ d: null, f: 1320, t: 300 }] }; // 22–05Z nightly
  const at = (iso) => Date.parse(iso);
  assert.equal(activeIn(n, at("2026-10-04T23:00:00Z"), at("2026-10-05T00:00:00Z")), true);
  assert.equal(activeIn(n, at("2026-10-05T03:00:00Z"), at("2026-10-05T04:00:00Z")), true); // after midnight UTC
  assert.equal(activeIn(n, at("2026-10-05T12:00:00Z"), at("2026-10-05T13:00:00Z")), false);
  assert.equal(stretchEnd(n, at("2026-10-05T03:30:00Z")), at("2026-10-05T05:00:00Z"));
  assert.equal(scheduleWords([{ d: [1, 2, 3, 4, 5], f: 180, t: 660 }], "America/New_York", NOW), "Mon–Fri 11 PM – 7 AM");
  assert.equal(activeIn({ from: null, to: null, win: [["2026-10-04T20:00:00Z", "2026-10-04T22:00:00Z"]] }, at("2026-10-04T18:00:00Z"), at("2026-10-04T19:00:00Z")), false);
});

// ---------- scoring ----------

const hours = (wdir = 40, wspd = 18, cat = "VFR", n = 6) => Array.from({ length: n }, (_, i) => ({ t: new Date(Math.floor(+NOW / H) * H + i * H), items: [], level: 0, fltCat: cat, cond: { wdir, wspd } }));
const score = (a, rwys, texts, { faa = [], opsplan = null, wdir, wspd, cat, tfrs = null } = {}) => {
  const notams = notamsFromSearch({ notamList: texts.map((t, i) => ({ icaoId: a.icao, facilityDesignator: a.iata, notamNumber: `10/${i + 1}`, traditionalMessage: t })) });
  const n = noticesFor({ a, notams, tfrs, runways: rwys, faa, opsplan, now: NOW });
  const hs = applyNotices(hours(wdir, wspd, cat), n, { faa, opsplan, tz: a.tz, now: NOW });
  return { n, hs, reasons: hs.map((h) => h.items.map((x) => `${x.level} ${x.text}`)) };
};

test("runway rule: 1 of N Low; more than half Moderate; all closed Severe", () => {
  const one = score(DEN, DEN_RWY, [`!DEN 10/1 DEN RWY 16R/34L CLSD ${span(-1, 3)}`], { wdir: 90, wspd: 20 });
  assert.deepEqual(one.reasons[0], ["1 Runway 16R/34L closed until 3:20 PM"]);
  assert.deepEqual(one.reasons[4], []); // ended
  const four = score(DEN, DEN_RWY, ["16L/34R", "16R/34L", "17L/35R", "17R/35L"].map((r) => `!DEN 10/1 DEN RWY ${r} CLSD ${span(-1, 3)}`));
  assert.deepEqual(four.reasons[0], ["2 Runways 16L/34R, 16R/34L, 17L/35R and 17R/35L closed until 3:20 PM — 4 of 6 runways"]);
  assert.equal(four.n.items[0].why, "most");
  const three = score(DEN, DEN_RWY, ["16L/34R", "16R/34L", "17L/35R"].map((r) => `!DEN 10/1 DEN RWY ${r} CLSD ${span(-1, 3)}`), { wspd: 5 });
  assert.equal(three.hs[0].level, 1); // exactly half: Low
  const all = score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 4/22 CLSD ${span(-1, 3)}`, `!LGA 10/2 LGA RWY 13/31 CLSD ${span(-1, 3)}`]);
  assert.deepEqual(all.reasons[0], ["4 Airport closed — all runways closed until 5:20 PM"]);
  // the NAS status already says the airport is closed: no second Severe reason
  const nas = score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 4/22 CLSD ${span(-1, 3)}`, `!LGA 10/2 LGA RWY 13/31 CLSD ${span(-1, 3)}`], { faa: [{ type: "closure", scope: "full", active: true }] });
  assert.deepEqual(nas.reasons[0], []);
});

test("runway rule: Moderate when the closed runway is the only one lined up with the wind (not with a parallel open)", () => {
  // LGA wind 040 at 18 kt: only 4/22 is lined up
  const wind = score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`], { wdir: 40, wspd: 18 });
  assert.deepEqual(wind.reasons[0], ["2 Runway 4/22 closed until 5:20 PM — the runway best lined up with the wind"]);
  assert.equal(wind.n.items[0].why, "wind");
  assert.equal(wind.n.items[0].peak, 2);
  // light wind: any runway works
  assert.equal(score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`], { wdir: 40, wspd: 6 }).hs[0].level, 1);
  // crosswind runway closed: Low
  assert.equal(score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 13/31 CLSD ${span(-1, 3)}`], { wdir: 40, wspd: 18 }).hs[0].level, 1);
  // DEN north wind: three parallels stay open
  assert.equal(score(DEN, DEN_RWY, [`!DEN 10/1 DEN RWY 16R/34L CLSD ${span(-1, 3)}`], { wdir: 350, wspd: 25 }).hs[0].level, 1);
  assert.deepEqual(alignedRunways(DEN_RWY, 350, 25, null), ["16L/34R", "16R/34L", "17L/35R", "17R/35L"]);
  assert.deepEqual(alignedRunways(LGA_RWY, "VRB", 25, null), []);
  // no runway data: Low only
  assert.equal(score(LGA, [], [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`], { wdir: 40, wspd: 18 }).hs[0].level, 1);
});

test("ILS out of service counts only in IFR/LIFR hours", () => {
  const t = [`!LGA 10/1 LGA NAV ILS RWY 22 U/S ${span(-1, 3)}`];
  assert.deepEqual(score(LGA, LGA_RWY, t, { cat: "IFR" }).reasons[0], ["1 Runway 22 ILS out of service until 5:20 PM"]);
  assert.deepEqual(score(LGA, LGA_RWY, t, { cat: "VFR" }).reasons[0], []);
  assert.deepEqual(score(LGA, LGA_RWY, t, { cat: "LIFR" }).reasons[2], ["1 Runway 22 ILS out of service until 5:20 PM"]);
});

test("dedupe: NAS runway closures, ops-plan SIRs and full closures aren't repeated (the Moderate rule still counts them)", () => {
  const nasRwy = [{ type: "closure", scope: "runway", active: true, runways: ["4/22"] }];
  const d1 = score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`], { faa: nasRwy, wspd: 5 });
  assert.equal(d1.n.items[0].dup, true);
  assert.deepEqual(d1.reasons[0], []); // the NAS status reason (risk.mjs) already says it
  const d2 = score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`], { faa: nasRwy, wdir: 40, wspd: 20 });
  assert.deepEqual(d2.reasons[0], ["2 Runway 4/22 closed until 5:20 PM — the runway best lined up with the wind"]);
  const sir = { sirs: [{ what: "runway", status: "closed", runways: ["16R/34L"] }, { what: "glideslope", status: "out of service", runways: ["34R"] }] };
  const d3 = score(DEN, DEN_RWY, [`!DEN 10/1 DEN RWY 16R/34L CLSD ${span(-1, 3)}`, `!DEN 10/2 DEN NAV ILS RWY 34R GP U/S ${span(-1, 3)}`], { opsplan: sir, cat: "IFR", wspd: 5 });
  assert.deepEqual(d3.n.items.map((x) => [x.kind, !!x.dup]), [["runway", true], ["ils", true]]);
  assert.deepEqual(d3.reasons[0], []);
  const d4 = score(LGA, LGA_RWY, [`!LGA 10/1 LGA AD AP CLSD ${span(-1, 3)}`], { faa: [{ type: "closure", scope: "full", active: true }] });
  assert.equal(d4.n.items[0].dup, true);
  assert.deepEqual(d4.reasons[0], []);
  // two NOTAMs for the same runway show once
  assert.equal(score(LGA, LGA_RWY, [`!LGA 10/1 LGA RWY 04/22 CLSD ${span(-1, 3)}`, `!LGA 10/2 LGA RWY 4/22 CLSD ${span(-1, 3)}`]).n.items.length, 1);
});

test("TFRs: VIP Moderate with its window, space Low, stadium information only, far away ignored", () => {
  const circle = (lat, lon, nm) => ({ circles: [{ lat, lon, nm }] });
  const vip = { id: "6/4321", type: "VIP", text: "!FDC 6/4321 ZDC DC..VIP", from: +NOW + 2 * H, to: +NOW + 4 * H, areas: [{ ...circle(40.70, -74.0, 10), from: +NOW + 2 * H, to: +NOW + 4 * H }] };
  const space = { id: "6/5501", type: "SPACE", text: "!FDC 6/5501 SPACE OPS", from: +NOW - H, to: +NOW + H, areas: [{ ...circle(40.9, -73.6, 20), from: null, to: null }] };
  const stadium = { id: "6/6100", type: "STADIUM", text: "!FDC 6/6100 STADIUM", from: +NOW - H, to: +NOW + 3 * H, areas: [{ ...circle(40.83, -73.93, 3) }] };
  const far = { id: "6/7000", type: "VIP", text: "far", from: +NOW, to: +NOW + 2 * H, areas: [{ ...circle(42.36, -71.0, 10) }] };
  const s = score(LGA, LGA_RWY, [], { tfrs: [vip, space, stadium, far] });
  assert.deepEqual(s.n.items.map((x) => [x.kind, x.level, x.at]), [["vip", 2, "span"], ["space", 1, "span"], ["stadium", 0, "none"]]);
  assert.equal(s.n.items[0].reason, "VIP movement — brief ground holds possible 4:20–6:20 PM");
  assert.equal(s.n.items[0].text, "VIP movement nearby: flight restrictions 4:20–6:20 PM — brief ground holds are possible.");
  assert.deepEqual(s.reasons[0], ["1 Space launch nearby — airspace restrictions until 3:20 PM"]);
  assert.deepEqual(s.reasons[2], ["2 VIP movement — brief ground holds possible 4:20–6:20 PM"]);
  assert.deepEqual(s.reasons[5], []);
  assert.equal(s.n.items[2].text, "Stadium event flight restrictions nearby until 5:20 PM — airline flights aren't affected.");
  // causes for the Settings categories
  assert.deepEqual(s.n.items.map((x) => [x.cause, x.cat]), [["vip", "vip"], ["space", "space"], ["security", "vip"]]);
  // within 30 nm of the area's edge counts; a long-standing information-only TFR doesn't
  assert.ok(tfrItem({ ...vip, areas: [{ ...circle(41.2, -73.874, 1) }] }, LGA, { now: NOW })); // ~24 nm away
  assert.equal(tfrItem({ ...vip, areas: [{ ...circle(41.5, -73.874, 1) }] }, LGA, { now: NOW }), null); // ~42 nm
  assert.equal(tfrItem({ ...stadium, to: null, areas: [{ ...circle(40.83, -73.93, 3), from: null, to: null }] }, LGA, { now: NOW }), null);
});

test("hours through buildHours/summarize: a Low closure raises a clear airport to Minor; nothing when sources are down", () => {
  const a = { ...LGA };
  const notams = notamsFromSearch({ notamList: [{ icaoId: "KLGA", facilityDesignator: "LGA", notamNumber: "10/1", traditionalMessage: `!LGA 10/1 LGA RWY 13/31 CLSD ${span(-1, 30)}` }] });
  const hs = buildHours({ now: NOW, tz: a.tz });
  applyNotices(hs, noticesFor({ a, notams, runways: LGA_RWY, now: NOW }), { tz: a.tz, now: NOW });
  const s = summarize(hs, a.tz);
  assert.equal(s.now.level, 1);
  assert.deepEqual(s.now.reasons, ["Runway 13/31 closed until Oct 5"]);
  assert.equal(hoursOutput(hs)[23].level, 1);
  assert.equal(noticesFor({ a, notams: null, tfrs: null, now: NOW }), null);
});

test("history: notices go to the truth log only when the set changes; notam/tfr failures are listed in down", () => {
  const n = { items: [{ id: "LGA 10/1", src: "notam", kind: "runway", cause: "runway", peak: 1, from: "2026-10-04T17:00:00.000Z", to: "2026-10-05T20:00:00.000Z", raw: "x", text: "y" }] };
  const status = { generated: NOW.toISOString(), sources: { metar: { ok: true } }, noticeSources: { notam: { ok: true }, tfr: { ok: false, error: "x" } }, airports: [{ iata: "LGA", notices: n }, { iata: "DCA", notices: { items: [] } }] };
  const l1 = truthLine(status, { t: null, lastObs: {} });
  assert.deepEqual(l1.down, ["tfr"]);
  assert.deepEqual(l1.airports.LGA.notices, { key: noticeTruth(n).key, items: [{ id: "LGA 10/1", src: "notam", kind: "runway", cause: "runway", level: 1, from: "2026-10-04T17:00Z", to: "2026-10-05T20:00Z" }] });
  assert.equal(l1.airports.DCA, undefined); // none before, none now
  const l2 = truthLine(status, { t: null, lastObs: {}, lastNotices: { LGA: noticeTruth(n).key } });
  assert.equal(l2.airports?.LGA, undefined);
  const l3 = truthLine({ ...status, airports: [{ iata: "LGA", notices: { items: [] } }] }, { t: null, lastObs: {}, lastNotices: { LGA: noticeTruth(n).key } });
  assert.deepEqual(l3.airports.LGA.notices, { key: "none" });
});

test("trips: a VIP movement or runway closure at a trip airport during the leg adds a concern (not a weather one)", () => {
  const t0 = Math.floor(+NOW / H) * H;
  const hrs = (reasons, level) => Array.from({ length: 24 }, (_, i) => ({ t: new Date(t0 + i * H).toISOString(), level: i >= 2 && i <= 4 ? level : 0, reasons: i >= 2 && i <= 4 ? reasons : [] }));
  const by = {
    DCA: { iata: "DCA", tz: "America/New_York", state: "DC", hours: hrs(["VIP movement — brief ground holds possible 4–7 PM"], 2) },
    ORD: { iata: "ORD", tz: "America/Chicago", state: "IL", hours: hrs(["Runway 10L/28R closed until Oct 5", "Mist"], 1) },
  };
  const trip = { legs: [{ from: "DCA", to: "ORD", dep: t0 + 3 * H, arr: t0 + 4 * H }] };
  const r = tripStatus(trip, by, { now: +NOW });
  const texts = r.concerns.map((c) => `${c.level} ${c.kind} ${c.text}`);
  assert.ok(texts.includes("2 notice VIP movement near DCA around your 5 PM departure — brief ground holds are possible."), texts.join("\n"));
  assert.ok(texts.some((t) => /^1 notice Runway 10L\/28R closed at ORD around your 5 PM arrival — usually only minor delays\.$/.test(t)), texts.join("\n"));
  assert.ok(!texts.some((t) => /weather .*VIP/.test(t)));
  assert.equal(r.status, "possible");
  assert.deepEqual(noticeOf("Runways 4L/22R and 4R/22L closed — 2 of 3 runways"), { kind: "runway", level: 2 });
  assert.equal(noticeOf("Rain"), null);
});
