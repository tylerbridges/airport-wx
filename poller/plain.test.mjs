import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  plainMetar, plainTafHour, travelerImpact, plainSigmet, plainCwa, plainAlert, aviationLines, decodeWxCodes, towardName, mph,
} from "./plain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-03T19:20:00Z"); // Sat 2:20 PM CDT
// Real-style AWC JSON METARs (fields as aviationweather.gov/api/data/metar?format=json returns them)
const M = (rawOb, o) => ({ rawOb, wdir: 240, wspd: 8, wgst: null, visib: "10+", wxString: null, clouds: [], temp: 15, dewp: 8, ...o });

test("plainMetar: everyday traveler sentences", () => {
  const cases = [
    [M("KORD 031851Z 22014KT 4SM RA OVC008 14/12 A2992", { wxString: "RA", visib: 4, clouds: [{ cover: "OVC", base: 800 }] }), "Rain and low clouds"],
    [M("KORD 031851Z 25025G45KT 2SM +TSRA BKN025CB 24/21", { wdir: 250, wspd: 25, wgst: 45, wxString: "+TSRA", visib: 2, clouds: [{ cover: "BKN", base: 2500, type: "CB" }] }), "Thunderstorms with heavy rain — visibility 2 miles. Gusts to 52 mph"],
    [M("KDFW 031853Z 19016KT 10SM +TSRA BKN040CB", { wxString: "+TSRA", visib: "10+", clouds: [{ cover: "BKN", base: 4000, type: "CB" }] }), "Thunderstorms with heavy rain"],
    [M("KDEN 031853Z 36022G35KT 10SM FEW050", { wdir: 360, wspd: 22, wgst: 35, clouds: [{ cover: "FEW", base: 5000 }] }), "Gusts to 40 mph"],
    [M("KSFO 031456Z 00000KT 1/4SM FG VV002", { wspd: 0, wxString: "FG", visib: 0.25, clouds: [{ cover: "VV", base: 200 }] }), "Fog — visibility under 1 mile"],
    [M("KSEA 031853Z 18008KT 4SM -RA BR BKN035", { wxString: "-RA BR", visib: 4, clouds: [{ cover: "BKN", base: 3500 }] }), "Light rain and mist"],
    [M("KMSP 031853Z 34018G28KT 1/2SM +SN FZFG VV004", { wspd: 18, wgst: 28, wxString: "+SN FZFG", visib: 0.5, clouds: [{ cover: "VV", base: 400 }] }), "Heavy snow and freezing fog — visibility under 1 mile. Gusts to 32 mph"],
    [M("KATL 031852Z 24008KT 10SM FEW045 18/08", { clouds: [{ cover: "FEW", base: 4500 }] }), "Mostly clear"],
    [M("KPHX 031851Z 27005KT 10SM CLR 38/02", { clouds: [{ cover: "CLR", base: null }] }), "Clear"],
    [M("KBOS 031854Z 29012KT 10SM OVC045", { clouds: [{ cover: "OVC", base: 4500 }] }), "Overcast"],
    [M("KCLE 031851Z 20010KT 2SM FZRA OVC006", { wxString: "FZRA", visib: 2, clouds: [{ cover: "OVC", base: 600 }] }), "Freezing rain and low clouds — visibility 2 miles"],
    [M("KTUL 031852Z 18012KT 10SM VCTS SCT050CB", { wxString: "VCTS", clouds: [{ cover: "SCT", base: 5000, type: "CB" }] }), "Thunderstorms nearby"],
    [M("KOKC 031852Z 18012KT 3SM TSGR BKN030CB", { wxString: "TSGR", visib: 3, clouds: [{ cover: "BKN", base: 3000, type: "CB" }] }), "Thunderstorms with hail"],
    [M("KLAX 031853Z 25006KT 5SM BR BKN004", { wxString: "BR", visib: 5, clouds: [{ cover: "BKN", base: 400 }] }), "Mist and very low clouds"],
    [M("KBUF 031854Z 27015KT 1SM -SHSN BLSN OVC015", { wxString: "-SHSN BLSN", visib: 1, clouds: [{ cover: "OVC", base: 1500 }] }), "Light snow showers and blowing snow — visibility 1 mile"],
  ];
  for (const [m, want] of cases) assert.equal(plainMetar(m), want, m.rawOb);
});

test("plainMetar accepts the status.json metar shape and a missing report", () => {
  assert.equal(plainMetar({ wind: { dir: 220, spd: 14 }, gust: 24, visib: 0.75, ceiling: 300, wx: "FG" }), "Fog — visibility under 1 mile");
  assert.equal(plainMetar({ wind: { dir: 300, spd: 16 }, gust: 30, visib: 10, ceiling: null, wx: null }), "Gusts to 35 mph");
  assert.equal(plainMetar(null), "No current weather report");
});

test("plainTafHour words TEMPO and PROB groups", () => {
  assert.equal(plainTafHour({ fcstChange: "PROB", probability: 30, wxString: "TSRA", visib: 3, clouds: [{ cover: "BKN", base: 3000 }] }), "30% chance of thunderstorms with rain");
  assert.equal(plainTafHour({ fcstChange: "TEMPO", wxString: "-SHRA", visib: "6+", clouds: [{ cover: "BKN", base: 4000 }] }), "At times light rain showers");
  assert.equal(plainTafHour({ fcstChange: "FM", wxString: "+SN", visib: 0.5, clouds: [{ cover: "OVC", base: 400 }], wspd: 22, wgst: 34 }), "Heavy snow and very low clouds — visibility under 1 mile. Gusts to 39 mph");
  assert.equal(plainTafHour({ fcstChange: null, wxString: null, visib: "6+", clouds: [{ cover: "SCT", base: 5000 }] }), "Partly cloudy");
});

test("travelerImpact is measured and picks the most disruptive cause", () => {
  assert.equal(travelerImpact(3, { wxString: "FG", visib: 0.25, clouds: [{ cover: "VV", base: 100 }] }), "Arrivals are often slowed in these conditions; delays of 30+ min possible");
  assert.equal(travelerImpact(4, { wxString: "+TSRA", wgst: 50 }), "Storms can pause departures and arrivals (ground stops) — expect delays");
  assert.equal(travelerImpact(3, { wgst: 38, wspd: 25 }), "Strong crosswinds may cause delays or diversions");
  assert.equal(travelerImpact(4, { wxString: "FZRA" }), "De-icing and slower operations — delays likely");
  assert.equal(travelerImpact(2, { wxString: "-SN" }), "De-icing and slower operations — delays likely");
  assert.equal(travelerImpact(0, { clouds: [{ cover: "FEW", base: 5000 }] }), "Flights operating normally");
  assert.match(travelerImpact(4, { faa: [{ type: "ground_stop", cause: "staffing" }] }), /ground stop/);
  assert.match(travelerImpact(4, { faa: [{ type: "closure", scope: "full" }] }), /closed/);
  // a GA-only closure is not an airport closure for travelers
  assert.equal(travelerImpact(0, { faa: [{ type: "closure", scope: "limited" }] }), "Flights operating normally");
  for (const lvl of [0, 1, 2, 3, 4]) {
    for (const c of [{}, { wxString: "TS" }, { wgst: 40 }, { faa: [{ type: "ground_delay" }] }]) {
      assert.doesNotMatch(travelerImpact(lvl, c), /\bwill\b|\bcertain/i);
    }
  }
});

test("plainSigmet: convective SIGMET in local time", () => {
  const s = {
    hazard: "CONVECTIVE", validTimeTo: Date.parse("2026-10-04T02:00:00Z") / 1000,
    rawAirSigmet: "CONVECTIVE SIGMET 31C\nVALID UNTIL 040200Z\nKS OK\nFROM 30NW ICT-40SE ICT\nAREA SEV EMBD TS MOV FROM 27022KT. TOPS TO FL450.",
  };
  assert.equal(plainSigmet(s, { tz: "America/Chicago" }), "Area of severe thunderstorms moving east at 25 mph, tops to 45,000 ft, until 9 PM");
  const line = { hazard: "CONVECTIVE", validTimeTo: Date.parse("2026-10-03T21:55:00Z"), rawAirSigmet: "CONVECTIVE SIGMET 24E\nLINE TS 25 NM WIDE MOV FROM 24030KT. TOPS ABV FL450.\nTORNADOES...HAIL TO 1 IN...WIND GUSTS TO 55KT POSS." };
  assert.equal(plainSigmet(line, { tz: "America/New_York" }), "Line of thunderstorms moving northeast at 35 mph, tops above 45,000 ft, hail up to 1 in, gusts to 63 mph and tornadoes possible, until 5:55 PM");
  assert.equal(plainSigmet({ hazard: "TURB", validTimeTo: null, rawAirSigmet: "SIGMET NOVEMBER 3 VALID UNTIL..." }), "Severe turbulence area");
  assert.equal(towardName(270), "east");
  assert.equal(mph(22), 25);
});

test("plainCwa decodes a CWA", () => {
  const c = { cwsu: "ZAU", hazard: "TS", validTimeTo: "2026-10-03T21:00:00Z", cwaText: "ZAU CWA 101 VALID UNTIL 032100\nFROM 20NW ORD-30SE ORD\nAREA SCT TS MOV FROM 25020KT. TOPS TO FL400." };
  assert.equal(plainCwa(c, { tz: "America/Chicago" }), "Scattered thunderstorms moving east at 23 mph, tops to 40,000 ft, until 4 PM");
  assert.equal(plainCwa({ hazard: "IFR", validTimeTo: null, cwaText: "IFR CIGS BLW 010" }), "Area of low clouds and poor visibility");
});

test("plainAlert shortens NWS headlines to event + local window", () => {
  const tz = "America/Chicago";
  assert.equal(plainAlert({ event: "Wind Advisory", onset: "2026-10-03T19:00:00Z", ends: "2026-10-04T01:00:00Z", headline: "Wind Advisory issued October 3 at 9:41AM CDT until October 3 at 8:00PM CDT by NWS Chicago IL" }, { tz, now: Date.parse("2026-10-03T15:00:00Z") }), "Wind Advisory, 2–8 PM");
  assert.equal(plainAlert({ event: "Winter Storm Warning", onset: "2026-10-03T13:00:00Z", ends: "2026-10-04T12:00:00Z" }, { tz: "America/Denver", now: NOW }), "Winter Storm Warning until Sun 6 AM");
  assert.equal(plainAlert({ event: "Severe Thunderstorm Warning", onset: "2026-10-03T19:10:00Z", ends: "2026-10-03T20:15:00Z" }, { tz, now: NOW }), "Severe Thunderstorm Warning until 3:15 PM");
  assert.equal(plainAlert({ event: "Flood Watch", onset: "2026-10-04T03:00:00Z", ends: "2026-10-04T17:00:00Z" }, { tz, now: NOW }), "Flood Watch, 10 PM–Sun 12 PM");
  assert.equal(plainAlert({ event: "Dense Fog Advisory", headline: "Dense Fog Advisory issued October 3 at 3:05AM CDT until October 3 at 10:00AM CDT by NWS" }, { tz, now: NOW }), "Dense Fog Advisory until October 3, 10 AM");
});

test("aviationLines: pilot-facing decode", () => {
  const m = M("KDEN 031853Z 35018G28KT 1 1/2SM -SN OVC008 M02/M03", { wdir: 350, wspd: 18, wgst: 28, visib: 1.5, wxString: "-SN", clouds: [{ cover: "OVC", base: 800 }], temp: -2, dewp: -3 });
  assert.deepEqual(aviationLines(m), [
    "Flight category: IFR",
    "Ceiling: 800 ft AGL",
    "Visibility: 1 1/2 sm",
    "Wind: 350° at 18 kt, gusts 28 kt",
    "Weather: -SN (light snow)",
    "Clouds: OVC 800 ft",
    "Temp/dew point: -2/-3 °C",
  ]);
  const g = aviationLines({ fcstChange: "TEMPO", wdir: "VRB", wspd: 5, visib: "6+", wxString: "VCTS", clouds: [{ cover: "BKN", base: 3500, type: "CB" }] });
  assert.equal(g[0], "Group: TEMPO");
  assert.ok(g.includes("Visibility: 6+ sm"));
  assert.ok(g.includes("Wind: variable at 5 kt"));
  assert.ok(g.includes("Clouds: BKN 3,500 ft CB"));
  assert.equal(aviationLines({ fcstChange: "PROB", probability: 30, wspd: 0 })[0], "Group: PROB30");
  assert.equal(decodeWxCodes("+TSRA BR"), "+TSRA (heavy thunderstorm rain), BR (mist)");
});

test("traveler strings carry no raw coded tokens", () => {
  const coded = /\b(CLSD|BKN\d{3}|OVC\d{3}|TEMPO|PROB30|NOSIG|\d{4}Z)\b/;
  const samples = [
    plainMetar(M("x", { wxString: "+TSRA", clouds: [{ cover: "BKN", base: 800 }] })),
    plainTafHour({ fcstChange: "TEMPO", probability: 30, wxString: "TSRA" }),
    plainSigmet({ hazard: "CONVECTIVE", rawAirSigmet: "AREA TS MOV FROM 26015KT. TOPS TO FL420.", validTimeTo: NOW / 1000 }),
  ];
  for (const s of samples) assert.doesNotMatch(s, coded, s);
});

test("site/plain.js is a byte-identical copy of poller/plain.mjs", () => {
  assert.equal(readFileSync(join(HERE, "../site/plain.js"), "utf8"), readFileSync(join(HERE, "plain.mjs"), "utf8"));
});
