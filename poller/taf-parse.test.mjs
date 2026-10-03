import test from "node:test";
import assert from "node:assert/strict";
import { parseTaf, parseMetar, parseConditions, resolveDay } from "./taf-parse.mjs";
import { tafHour, levelOf, parseVisib } from "./risk.mjs";

const REF = Date.parse("2026-07-14T12:00:00Z");
const s = (iso) => Date.parse(iso) / 1000;
const kinds = (t) => t.fcsts.map((g) => g.fcstChange);

test("resolveDay picks the nearest month and handles hour 24", () => {
  assert.equal(resolveDay(14, 12, 0, REF), Date.parse("2026-07-14T12:00:00Z"));
  assert.equal(resolveDay(30, 18, 0, Date.parse("2026-07-01T02:00:00Z")), Date.parse("2026-06-30T18:00:00Z"));
  assert.equal(resolveDay(1, 6, 0, Date.parse("2026-07-31T20:00:00Z")), Date.parse("2026-08-01T06:00:00Z"));
  assert.equal(resolveDay(14, 24, 0, REF), Date.parse("2026-07-15T00:00:00Z"));
  // 31 doesn't exist in June: must not roll over to July 1
  assert.equal(resolveDay(31, 0, 0, Date.parse("2026-06-29T00:00:00Z")), Date.parse("2026-05-31T00:00:00Z"));
});

test("TAF 1: FM groups, P6SM, header times", () => {
  const raw = `TAF KMSP 141120Z 1412/1518 18010KT P6SM SCT050
  FM141800 20015G25KT P6SM BKN040
  FM150200 31008KT 5SM BR OVC008`;
  const t = parseTaf(raw, { ref: REF });
  assert.equal(t.icaoId, "KMSP");
  assert.equal(t.issueTime, s("2026-07-14T11:20:00Z"));
  assert.equal(t.validTimeFrom, s("2026-07-14T12:00:00Z"));
  assert.equal(t.validTimeTo, s("2026-07-15T18:00:00Z"));
  assert.deepEqual(kinds(t), [null, "FM", "FM"]);
  const [b, f1, f2] = t.fcsts;
  assert.equal(b.timeFrom, s("2026-07-14T12:00:00Z"));
  assert.equal(b.timeTo, s("2026-07-14T18:00:00Z"));
  assert.deepEqual([b.wdir, b.wspd, b.wgst, b.visib], [180, 10, null, "6+"]);
  assert.deepEqual(b.clouds, [{ cover: "SCT", base: 5000, type: null }]);
  assert.deepEqual([f1.wspd, f1.wgst, f1.timeTo], [15, 25, s("2026-07-15T02:00:00Z")]);
  assert.equal(f2.timeTo, s("2026-07-15T18:00:00Z"));
  assert.deepEqual([f2.visib, f2.wxString, f2.clouds[0].base], [5, "BR", 800]);
});

test("TAF 2: TEMPO with thunder and CB, scored by risk.mjs", () => {
  const raw = "TAF KDFW 141740Z 1418/1524 19012G22KT P6SM VCTS SCT040CB BKN250 TEMPO 1420/1424 3SM TSRA BKN030CB FM150300 17008KT P6SM SCT250";
  const t = parseTaf(raw, { ref: REF });
  assert.deepEqual(kinds(t), [null, "TEMPO", "FM"]);
  const tempo = t.fcsts[1];
  assert.deepEqual([tempo.timeFrom, tempo.timeTo], [s("2026-07-14T20:00:00Z"), s("2026-07-15T00:00:00Z")]);
  assert.deepEqual([tempo.visib, tempo.wxString, tempo.wdir, tempo.probability], [3, "TSRA", null, null]);
  assert.deepEqual(tempo.clouds, [{ cover: "BKN", base: 3000, type: "CB" }]);
  assert.equal(t.fcsts[0].clouds[0].type, "CB");
  assert.equal(t.validTimeTo, s("2026-07-16T00:00:00Z"));
  const h = tafHour(t, Date.parse("2026-07-14T21:00:00Z"), Date.parse("2026-07-14T22:00:00Z"));
  assert.equal(levelOf(h.items), 3);
  assert.ok(h.items.some((x) => x.text === "Thunderstorms"));
});

test("TAF 3: PROB30 TEMPO and bare PROB30 are probability groups (one level lower)", () => {
  const raw = "TAF KATL 141130Z 1412/1518 24008KT P6SM SCT040 PROB30 TEMPO 1418/1422 2SM TSRA BKN025CB FM150000 VRB04KT P6SM SCT100 PROB30 1508/1512 1SM BR OVC004";
  const t = parseTaf(raw, { ref: REF });
  assert.deepEqual(kinds(t), [null, "TEMPO", "FM", "PROB"]);
  assert.equal(t.fcsts[1].probability, 30);
  assert.equal(t.fcsts[3].probability, 30);
  assert.equal(t.fcsts[2].wdir, "VRB");
  assert.deepEqual([t.fcsts[3].timeFrom, t.fcsts[3].timeTo], [s("2026-07-15T08:00:00Z"), s("2026-07-15T12:00:00Z")]);
  const h = tafHour(t, Date.parse("2026-07-14T19:00:00Z"), Date.parse("2026-07-14T20:00:00Z"));
  assert.ok(h.items.some((x) => x.text === "Chance of thunderstorms" && x.level === 2));
});

test("TAF 4: BECMG with timeBec at the end of the change period", () => {
  const raw = "TAF KDEN 141720Z 1418/1524 36012KT P6SM BKN080 BECMG 1500/1502 02015G28KT 2SM -SN OVC015 FM151200 32010KT P6SM SCT060";
  const t = parseTaf(raw, { ref: REF });
  const b = t.fcsts[1];
  assert.equal(b.fcstChange, "BECMG");
  assert.deepEqual([b.timeFrom, b.timeBec], [s("2026-07-15T00:00:00Z"), s("2026-07-15T02:00:00Z")]);
  assert.deepEqual([b.wgst, b.visib, b.wxString], [28, 2, "-SN"]);
  // before timeBec the base still prevails; after, snow + IFR vis
  const before = tafHour(t, Date.parse("2026-07-15T00:00:00Z"), Date.parse("2026-07-15T01:00:00Z"));
  const after = tafHour(t, Date.parse("2026-07-15T03:00:00Z"), Date.parse("2026-07-15T04:00:00Z"));
  assert.equal(before.fltCat, "VFR");
  assert.equal(after.fltCat, "IFR");
  assert.ok(after.items.some((x) => x.text === "Snow"));
});

test("TAF 5: VV and fractional visibility (1 1/2SM, M1/4SM, 1/2SM)", () => {
  const raw = "TAF KSFO 140530Z 1406/1512 27008KT 1 1/2SM BR VV004 TEMPO 1408/1412 M1/4SM FG VV001 FM141600 28012KT 1/2SM FG OVC002 FM142000 29015KT P6SM SKC";
  const t = parseTaf(raw, { ref: REF });
  assert.equal(t.fcsts[0].visib, 1.5);
  assert.deepEqual(t.fcsts[0].clouds, [{ cover: "VV", base: 400, type: null }]);
  assert.equal(t.fcsts[1].visib, 0.25);
  assert.deepEqual(t.fcsts[1].clouds, [{ cover: "VV", base: 100, type: null }]);
  assert.equal(t.fcsts[2].visib, 0.5);
  assert.deepEqual(t.fcsts[3].clouds, [{ cover: "SKC", base: null, type: null }]);
  assert.equal(parseVisib(t.fcsts[3].visib), 6);
  const h = tafHour(t, Date.parse("2026-07-14T09:00:00Z"), Date.parse("2026-07-14T10:00:00Z"));
  assert.equal(h.fltCat, "LIFR"); // prevailing 1 1/2SM VV004: ceiling 400 < 500
});

test("TAF 6: AMD and COR headers, NSW in BECMG clears weather", () => {
  const amd = parseTaf("TAF AMD KORD 141502Z 1415/1518 22010KT 3SM -RA BR OVC012 BECMG 1417/1418 P6SM NSW BKN035", { ref: REF });
  assert.equal(amd.amd, true);
  assert.equal(amd.icaoId, "KORD");
  assert.equal(amd.issueTime, s("2026-07-14T15:02:00Z"));
  assert.equal(amd.fcsts[1].wxString, "NSW");
  const later = tafHour(amd, Date.parse("2026-07-14T19:00:00Z"), Date.parse("2026-07-14T20:00:00Z"));
  assert.equal(levelOf(later.items), 0);
  const cor = parseTaf("TAF COR KJFK 141140Z 1412/1518 19010KT P6SM FEW250", { ref: REF });
  assert.equal(cor.cor, true);
  assert.equal(cor.icaoId, "KJFK");
  // "KORD AMD ..." form without the leading TAF keyword
  const amd2 = parseTaf("KORD 141502Z AMD 1415/1518 22010KT P6SM SCT035", { ref: REF });
  assert.equal(amd2.icaoId, "KORD");
  assert.equal(amd2.fcsts.length, 1);
});

test("TAF 7: month rollover, hour 24 end and FM across midnight", () => {
  const ref = Date.parse("2026-07-31T23:00:00Z");
  const t = parseTaf("TAF KMIA 312340Z 0100/0124 09012KT P6SM VCSH SCT025 FM011800 10015G25KT P6SM -SHRA BKN020", { ref });
  assert.equal(t.issueTime, s("2026-07-31T23:40:00Z"));
  assert.equal(t.validTimeFrom, s("2026-08-01T00:00:00Z"));
  assert.equal(t.validTimeTo, s("2026-08-02T00:00:00Z"));
  assert.equal(t.fcsts[1].timeFrom, s("2026-08-01T18:00:00Z"));
  assert.equal(t.fcsts[0].wxString, "VCSH");
});

test("TAF 8: freezing rain / ice pellets, wind shear and AMD NOT SKED text ignored", () => {
  const raw = "TAF KBNA 141130Z 1412/1512 04012KT 2SM -FZRA PL BR OVC006 WS020/24045KT TEMPO 1412/1416 1/2SM FZRA OVC003 FM142000 05010KT 5SM -RA BR OVC010 AMD NOT SKED AFT 1417Z";
  const t = parseTaf(raw, { ref: REF });
  assert.equal(t.fcsts[0].wxString, "-FZRA PL BR");
  assert.equal(t.fcsts[0].wspd, 12); // not the wind-shear wind
  assert.equal(t.fcsts[2].wxString, "-RA BR");
  const h = tafHour(t, Date.parse("2026-07-14T13:00:00Z"), Date.parse("2026-07-14T14:00:00Z"));
  assert.equal(levelOf(h.items), 4);
});

test("TAF 9: given issue time wins; NIL and CNL", () => {
  const t = parseTaf("KLAX 1412/1518 25010KT P6SM FEW015", { issueTime: Date.parse("2026-07-14T11:30:00Z") });
  assert.equal(t.issueTime, s("2026-07-14T11:30:00Z"));
  assert.equal(t.validTimeFrom, s("2026-07-14T12:00:00Z"));
  assert.equal(parseTaf("TAF KLAX 141130Z NIL=", { ref: REF }).nil, true);
  const c = parseTaf("TAF AMD KLAX 141630Z 1416/1518 CNL", { ref: REF });
  assert.equal(c.cancelled, true);
  assert.equal(c.fcsts.length, 0);
  assert.equal(parseTaf("", { ref: REF }), null);
});

test("TAF 10: PHNL / PANC style with VRB, 2-layer clouds and TCU", () => {
  const t = parseTaf("TAF PHNL 141120Z 1412/1518 06015G25KT P6SM VCSH FEW025TCU SCT045 FM150300 05010KT P6SM FEW030", { ref: REF });
  assert.equal(t.icaoId, "PHNL");
  assert.deepEqual(t.fcsts[0].clouds, [{ cover: "FEW", base: 2500, type: "TCU" }, { cover: "SCT", base: 4500, type: null }]);
  const a = parseTaf("TAF PANC 141130Z 1412/1518 VRB05KT 6SM -SN BKN008 OVC015", { ref: REF });
  assert.equal(a.fcsts[0].visib, 6);
  assert.equal(a.fcsts[0].wdir, "VRB");
});

test("METAR body parsing ignores remarks and temperature groups", () => {
  const m = parseMetar("KMSP 141753Z 27015G32KT 1 3/4SM +TSRA BR SCT008 BKN015CB OVC040 22/20 A2992 RMK AO2 PK WND 27045/1739 TSB30 SLP130", { ref: REF });
  assert.equal(m.icaoId, "KMSP");
  assert.equal(m.obsTime, s("2026-07-14T17:53:00Z"));
  assert.deepEqual([m.wdir, m.wspd, m.wgst, m.visib, m.wxString], [270, 15, 32, 1.75, "+TSRA BR"]);
  assert.equal(m.clouds.length, 3);
  const n = parseMetar("METAR KDEN 141853Z AUTO 00000KT 10SM CLR M02/M05 A3001 RMK AO2 TSNO", { ref: REF });
  assert.deepEqual([n.wspd, n.visib, n.wxString], [0, 10, null]);
  assert.deepEqual(parseConditions(["M1/4SM", "FZFG", "VV001"]).visib, 0.25);
});
