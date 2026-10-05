import test from "node:test";
import assert from "node:assert/strict";
import {
  opsPlanItems, parseVisib, fmtVis, ceilingOf, flightCategory, parseWx, assessConditions, assessFaa, assessAlert, alertLevel,
  spcLevel, spcText, assessAtcscc, assessCwa, cwaKind, lampThunderLevel, lampConvLevel, tcfLevel, uniqueItems, buildHours, summarize, tafHour, levelOf, nextUtcHour, fmtClock, fmtRange, tzAbbr, compareAirports, hoursOutput, observedHours, condOf,
} from "./risk.mjs";

const lvl = (c) => levelOf(assessConditions(c));
const texts = (c) => assessConditions(c).map((i) => i.text);
const NOW = new Date("2026-10-03T19:20:00Z"); // 3:20 PM EDT, 2:20 PM CDT
const H = 3600;
const hr = (n) => Math.floor(+NOW / 1000 / H) * H + n * H; // epoch seconds, top of hour + n
const taf = (fcsts) => ({ validTimeFrom: hr(-1), validTimeTo: hr(30), fcsts });
const vfr = { fcstChange: null, timeFrom: hr(-1), timeTo: hr(30), wdir: 240, wspd: 8, wgst: null, visib: "6+", wxString: null, clouds: [{ cover: "SCT", base: 5000 }] };

test("visibility parsing and formatting", () => {
  assert.equal(parseVisib("10+"), 10);
  assert.equal(parseVisib("6+"), 6);
  assert.equal(parseVisib("1/2"), 0.5);
  assert.equal(parseVisib("1 1/2"), 1.5);
  assert.equal(parseVisib("M1/4"), 0.25);
  assert.equal(parseVisib(3), 3);
  assert.equal(parseVisib(null), null);
  assert.equal(parseVisib(""), null);
  assert.equal(fmtVis(0.5), "1/2");
  assert.equal(fmtVis(1.5), "1 1/2");
  assert.equal(fmtVis(4), "4");
});

test("ceiling uses only BKN/OVC/VV and takes the lowest", () => {
  assert.equal(ceilingOf([{ cover: "FEW", base: 200 }, { cover: "SCT", base: 300 }]), null);
  assert.equal(ceilingOf([{ cover: "SCT", base: 300 }, { cover: "BKN", base: 2500 }, { cover: "OVC", base: 800 }]), 800);
  assert.equal(ceilingOf([{ cover: "VV", base: 200 }]), 200);
  assert.equal(ceilingOf(null), null);
});

test("flight categories", () => {
  assert.equal(flightCategory(10, null), "VFR");
  assert.equal(flightCategory(5, 3000), "MVFR");
  assert.equal(flightCategory(2.9, 5000), "IFR");
  assert.equal(flightCategory(10, 999), "IFR");
  assert.equal(flightCategory(0.75, 5000), "LIFR");
  assert.equal(flightCategory(10, 400), "LIFR");
});

test("wx parsing keeps intensity and splits codes", () => {
  assert.deepEqual(parseWx("+TSRA BR"), [{ intensity: "+", codes: ["TS", "RA"] }, { intensity: "", codes: ["BR"] }]);
  assert.deepEqual(parseWx("VCTS"), [{ intensity: "VC", codes: ["TS"] }]);
  assert.deepEqual(parseWx(null), []);
  assert.deepEqual(parseWx("RETS"), []);
});

test("benign conditions score None", () => {
  assert.equal(lvl({ wxString: null, visib: "10+", clouds: [{ cover: "FEW", base: 4500 }], wspd: 8, wgst: null }), 0);
  assert.equal(lvl({ wxString: null, visib: 6, clouds: [{ cover: "SCT", base: 5000 }], wspd: 20, wgst: 24 }), 0);
});

test("Severe: heavy TS, TS with gust >= 45, freezing rain", () => {
  assert.equal(lvl({ wxString: "+TSRA" }), 4);
  assert.equal(lvl({ wxString: "TSRA", wgst: 45 }), 4);
  assert.equal(lvl({ wxString: "TSRA", wgst: 44 }), 3);
  assert.equal(lvl({ wxString: "FZRA" }), 4);
  assert.equal(lvl({ wxString: "-FZRA" }), 4);
  assert.equal(lvl({ wxString: "VCTS", wgst: 50 }), 3); // VCTS is not "TS over the airport": plain gust rule
});

test("High: TS, VCTS, LIFR, gusts >= 35, heavy or low-vis snow, FZDZ, PL", () => {
  assert.equal(lvl({ wxString: "TSRA" }), 3);
  assert.equal(lvl({ wxString: "VCTS" }), 3);
  assert.equal(lvl({ visib: 10, clouds: [{ cover: "OVC", base: 400 }] }), 3);
  assert.equal(lvl({ visib: 0.75, clouds: [] }), 3);
  assert.equal(lvl({ wgst: 35 }), 3);
  assert.equal(lvl({ wxString: "+SN", visib: 3 }), 3);
  assert.equal(lvl({ wxString: "SN", visib: 0.5 }), 3);
  assert.equal(lvl({ wxString: "SN", visib: 1 }), 2);
  assert.equal(lvl({ wxString: "FZDZ" }), 3);
  assert.equal(lvl({ wxString: "PL" }), 3);
  assert.ok(texts({ visib: 10, clouds: [{ cover: "OVC", base: 400 }] }).includes("Ceiling 400 ft"));
});

test("Moderate: IFR, gusts >= 25, snow", () => {
  assert.equal(lvl({ visib: 10, clouds: [{ cover: "BKN", base: 800 }] }), 2);
  assert.equal(lvl({ visib: 2, clouds: [] }), 2);
  assert.equal(lvl({ wgst: 25 }), 2);
  assert.equal(lvl({ wgst: 34 }), 2);
  assert.equal(lvl({ wxString: "-SN", visib: 5 }), 2);
});

test("Low: MVFR, rain, drizzle, mist", () => {
  assert.equal(lvl({ visib: 4, clouds: [] }), 1);
  assert.equal(lvl({ visib: 10, clouds: [{ cover: "BKN", base: 2500 }] }), 1);
  assert.equal(lvl({ wxString: "RA" }), 1);
  assert.equal(lvl({ wxString: "-DZ" }), 1);
  assert.equal(lvl({ wxString: "BR", visib: 10 }), 1);
});

test("FAA programs", () => {
  assert.equal(assessFaa({ type: "ground_stop", detail: "until 5:30 PM ET" }).text, "Ground stop until 5:30 PM ET");
  assert.equal(assessFaa({ type: "ground_stop" }).level, 4);
  assert.equal(assessFaa({ type: "closure" }).level, 4);
  assert.equal(assessFaa({ type: "ground_delay", detail: "avg 52m" }).level, 3);
  assert.equal(assessFaa({ type: "delay", detail: "Departures 16–30m" }).level, 2);
  assert.equal(assessFaa({ type: "nope" }), null);
});

test("NWS alert levels", () => {
  for (const e of ["Tornado Warning", "Blizzard Warning", "Ice Storm Warning", "Hurricane Warning", "Extreme Wind Warning"]) assert.equal(alertLevel(e), 4, e);
  for (const e of ["Severe Thunderstorm Warning", "Winter Storm Warning", "Tropical Storm Warning", "High Wind Warning"]) assert.equal(alertLevel(e), 3, e);
  for (const e of ["Winter Weather Advisory", "Wind Advisory", "Dense Fog Advisory"]) assert.equal(alertLevel(e), 2, e);
  assert.equal(alertLevel("Excessive Heat Warning"), 0);
  assert.equal(alertLevel("Tornado Watch"), 0);
});

test("SPC levels", () => {
  assert.deepEqual(["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH", null].map(spcLevel), [0, 1, 2, 3, 4, 4, 0]);
  assert.equal(spcText("SLGT"), "Slight risk of severe storms");
  assert.equal(spcText("HIGH"), "High risk of severe storms");
  assert.equal(spcText("TSTM"), "General thunderstorms possible in the area (no severe risk)");
  // TSTM never colours the timeline
  assert.ok(buildHours({ now: NOW, tz: "America/New_York", spc: "TSTM" }).every((h) => h.level === 0 && !h.items.length));
});

test("time formatting in airport zones", () => {
  assert.equal(fmtClock(NOW, "America/Chicago"), "2:20 PM");
  assert.equal(fmtClock("2026-10-03T21:00:00Z", "America/New_York"), "5 PM");
  assert.equal(fmtClock("2026-10-04T13:00:00Z", "America/New_York", NOW), "Sun 9 AM");
  assert.equal(fmtRange("2026-10-03T20:00:00Z", "2026-10-03T23:00:00Z", "America/New_York"), "4–7 PM");
  assert.equal(fmtRange("2026-10-03T14:00:00Z", "2026-10-03T19:00:00Z", "America/New_York"), "10 AM – 3 PM");
  // across midnight / noon: keep AM/PM and the day
  assert.equal(fmtRange("2026-10-04T03:00:00Z", "2026-10-04T17:00:00Z", "America/New_York", NOW), "11 PM – 1 PM tomorrow");
  assert.equal(fmtRange("2026-10-04T03:00:00Z", "2026-10-04T05:00:00Z", "America/New_York", NOW), "11 PM – 1 AM tomorrow");
  assert.equal(fmtRange("2026-10-03T15:00:00Z", "2026-10-03T17:00:00Z", "America/New_York", NOW), "11 AM – 1 PM");
  assert.equal(fmtRange("2026-10-04T13:00:00Z", "2026-10-04T15:00:00Z", "America/New_York", NOW), "Sun 9–11 AM");
  assert.equal(fmtRange("2026-10-05T03:00:00Z", "2026-10-05T05:00:00Z", "America/New_York", NOW), "Sun 11 PM – 1 AM Mon");
  assert.equal(tzAbbr(NOW, "America/Chicago"), "CT");
  assert.equal(tzAbbr(NOW, "America/Phoenix"), "MT");
});

test("TAF: FM replaces, BECMG merges at timeBec else timeFrom", () => {
  const t = taf([
    vfr,
    { fcstChange: "FM", timeFrom: hr(3), timeTo: hr(30), wdir: 250, wspd: 10, wgst: null, visib: 2, wxString: "-RA", clouds: [{ cover: "OVC", base: 900 }] },
    { fcstChange: "BECMG", timeFrom: hr(6), timeTo: hr(30), timeBec: hr(8), wdir: null, wspd: null, wgst: null, visib: "6+", wxString: null, clouds: [{ cover: "SCT", base: 4000 }] },
  ]);
  const at = (n) => tafHour(t, hr(n) * 1000, hr(n + 1) * 1000);
  assert.equal(levelOf(at(0).items), 0);
  assert.equal(at(2).fltCat, "VFR");
  assert.equal(at(3).fltCat, "IFR"); // FM at hr(3) starts at the hour; midpoint is after it
  assert.equal(levelOf(at(3).items), 2);
  assert.equal(at(6).fltCat, "IFR"); // BECMG not yet effective at timeFrom (timeBec wins)
  assert.equal(at(7).fltCat, "IFR");
  assert.equal(at(8).fltCat, "VFR");
  assert.equal(at(8).items.length, 0 + at(8).items.filter((i) => i.text === "Rain").length); // wx carried over (-RA) since BECMG didn't clear it
});

test("TAF: BECMG without timeBec takes effect at timeFrom", () => {
  const t = taf([vfr, { fcstChange: "BECMG", timeFrom: hr(5), timeTo: hr(30), visib: 2, clouds: [] }]);
  assert.equal(tafHour(t, hr(4) * 1000, hr(5) * 1000).fltCat, "VFR");
  assert.equal(tafHour(t, hr(5) * 1000, hr(6) * 1000).fltCat, "IFR");
});

test("TAF: TEMPO at full level, PROB one lower with Chance of prefix", () => {
  const t = taf([
    vfr,
    { fcstChange: "TEMPO", timeFrom: hr(2), timeTo: hr(5), visib: 3, wxString: "TSRA", clouds: [], wspd: null, wgst: null },
    { fcstChange: "PROB", probability: 30, timeFrom: hr(8), timeTo: hr(10), wxString: "TSRA", visib: null, clouds: [], wspd: null, wgst: null },
    { fcstChange: "PROB", probability: 40, timeFrom: hr(12), timeTo: hr(14), wxString: "+TSRA", visib: null, clouds: [], wspd: null, wgst: null },
    { fcstChange: "PROB", probability: 30, timeFrom: hr(16), timeTo: hr(17), wxString: "RA", visib: null, clouds: [], wspd: null, wgst: null },
  ]);
  const at = (n) => tafHour(t, hr(n) * 1000, hr(n + 1) * 1000);
  assert.equal(levelOf(at(1).items), 0);
  assert.equal(levelOf(at(2).items), 3);
  assert.equal(levelOf(at(4).items), 3);
  assert.equal(levelOf(at(5).items), 0);
  assert.equal(levelOf(at(8).items), 2);
  assert.ok(at(8).items.some((i) => i.text === "Chance of thunderstorms"));
  assert.equal(levelOf(at(12).items), 3); // +TSRA severe minus one
  assert.ok(at(12).items.some((i) => i.text === "Chance of heavy thunderstorms"));
  assert.equal(levelOf(at(16).items), 0); // low minus one drops out
});

test("TAF: hours outside validity have no TAF items", () => {
  const t = { validTimeFrom: hr(0), validTimeTo: hr(4), fcsts: [vfr] };
  assert.equal(tafHour(t, hr(-3) * 1000, hr(-2) * 1000), null);
  assert.equal(tafHour(t, hr(4) * 1000, hr(5) * 1000), null);
  assert.ok(tafHour(t, hr(1) * 1000, hr(2) * 1000));
});

test("buildHours: 24 rows from the top of the hour; hour 0 takes METAR, FAA, SIGMET", () => {
  const hours = buildHours({
    now: NOW, tz: "America/Chicago", taf: taf([vfr]),
    metar: { wxString: "-RA", visib: 6, clouds: [{ cover: "BKN", base: 3500 }], wspd: 10, wgst: null, fltCat: "MVFR" },
    faa: [{ type: "ground_stop", detail: "until 5:30 PM CT", end: "2026-10-03T22:30:00Z" }], sigmet: true,
  });
  assert.equal(hours.length, 24);
  assert.equal(hours[0].t.toISOString(), "2026-10-03T19:00:00.000Z");
  assert.equal(hours[0].level, 4);
  assert.equal(hours[0].fltCat, "MVFR");
  assert.ok(hours[0].items.some((i) => i.text === "Convective SIGMET over airport"));
  // the ground stop holds until its end (22:30Z); the SIGMET is hour 0 only
  assert.deepEqual(hours.slice(0, 5).map((h) => h.level), [4, 4, 4, 4, 0]);
  assert.ok(!hours[1].items.some((i) => /SIGMET/.test(i.text)));
  assert.equal(hours[1].fltCat, "VFR");
});

test("hour 0: the observation wins over TAF conditions", () => {
  const rainyTaf = taf([{ ...vfr, wxString: "-RA BR", clouds: [{ cover: "OVC", base: 800 }] }]);
  const metar = { wxString: null, visib: "10+", clouds: [{ cover: "OVC", base: 1300 }], wspd: 8, fltCat: "MVFR" };
  const hours = buildHours({ now: NOW, tz: "America/Chicago", taf: rainyTaf, metar });
  assert.deepEqual(hours[0].items.map((i) => i.text), ["Ceiling 1,300 ft"]);
  assert.equal(hours[0].fltCat, "MVFR");
  assert.ok(hours[1].items.some((i) => i.text === "Ceiling 800 ft"), "later hours still use the TAF");
  // no current METAR: the TAF covers hour 0
  assert.ok(buildHours({ now: NOW, tz: "America/Chicago", taf: rainyTaf }).at(0).items.some((i) => i.text === "Ceiling 800 ft"));
});

test("FAA programs hold until their end; open-ended ones 3 h (5 h when increasing), worded until further notice", () => {
  const gdp = { type: "ground_delay", reason: "wind", cause: "weather", detail: "avg 49m, max 2h 18m" };
  assert.equal(assessFaa(gdp).text, "Ground delay program — weather (wind), avg 49m, max 2h 18m, until further notice");
  const lv = (faa) => buildHours({ now: NOW, tz: "America/Los_Angeles", faa }).slice(0, 7).map((h) => h.level);
  assert.deepEqual(lv([gdp]), [3, 3, 3, 3, 0, 0, 0]); // 19:20Z + 3 h
  const dl = { type: "delay", reason: "RWY:Construction", detail: "Departures 31–45m, increasing", trend: "increasing" };
  assert.deepEqual(lv([dl]), [2, 2, 2, 2, 2, 2, 0]); // + 5 h
  assert.deepEqual(lv([{ ...gdp, end: "2026-10-04T00:59:00Z" }]), [3, 3, 3, 3, 3, 3, 0]);
  assert.equal(assessFaa({ ...gdp, end: "2026-10-04T00:59:00Z" }).text, "Ground delay program — weather (wind), avg 49m, max 2h 18m");
  // closures stay hour 0
  assert.deepEqual(lv([{ type: "closure", scope: "runway", runways: ["7L/25R"] }]), [1, 0, 0, 0, 0, 0, 0]);
});

test("buildHours: NWS alerts only cover hours between onset and ends", () => {
  const hours = buildHours({
    now: NOW, tz: "America/New_York",
    alerts: [{ event: "Winter Storm Warning", onset: new Date(+NOW + 3 * 3600e3).toISOString(), ends: new Date(+NOW + 7 * 3600e3).toISOString() }],
  });
  const lv = hours.map((h) => h.level).join("");
  assert.equal(lv.slice(0, 3), "000");
  assert.equal(hours[3].level, 3);
  assert.equal(hours[6].level, 3);
  assert.equal(hours[7].level, 3); // ends at 7:20 into hour 7
  assert.equal(hours[8].level, 0);
  const s = summarize(hours, "America/New_York");
  assert.equal(s.now.level, 0);
  assert.equal(s.peak.level, 3);
  assert.match(s.peak.reasons[0], /^Winter Storm Warning \d/);
});

test("buildHours: SPC applies until 12Z next day", () => {
  const hours = buildHours({ now: NOW, tz: "America/Chicago", spc: "ENH" });
  // 19Z now -> 12Z next day is hour index 17 (exclusive)
  assert.equal(hours[16].level, 3);
  assert.equal(hours[17].level, 0);
  assert.equal(nextUtcHour(new Date("2026-10-03T08:00:00Z"), 12), Date.parse("2026-10-03T12:00:00Z"));
  assert.equal(nextUtcHour(new Date("2026-10-03T12:00:00Z"), 12), Date.parse("2026-10-04T12:00:00Z"));
});

test("summarize: peak is the earliest hour of the max; reasons get windows", () => {
  const t = taf([
    vfr,
    { fcstChange: "FM", timeFrom: hr(3), timeTo: hr(30), wdir: 250, wspd: 10, wgst: null, visib: 3, wxString: "TSRA", clouds: [] },
    { fcstChange: "FM", timeFrom: hr(6), timeTo: hr(30), wdir: 250, wspd: 10, wgst: null, visib: "6+", wxString: null, clouds: [] },
  ]);
  const hours = buildHours({ now: NOW, tz: "America/New_York", taf: t });
  const s = summarize(hours, "America/New_York");
  assert.equal(s.now.level, 0);
  assert.deepEqual(s.now.reasons, []);
  assert.equal(s.peak.level, 3);
  assert.equal(s.peak.at, "2026-10-03T22:00:00.000Z");
  assert.equal(s.peak.reasons[0], "Thunderstorms forecast 6–9 PM");
});

test("summarize: a reason that began before the peak hour spans its whole run", () => {
  const t = taf([
    vfr,
    { fcstChange: "FM", timeFrom: hr(0), timeTo: hr(30), wdir: 250, wspd: 10, wgst: null, visib: 5, wxString: null, clouds: [] },
    { fcstChange: "FM", timeFrom: hr(3), timeTo: hr(30), wdir: 250, wspd: 10, wgst: null, visib: "6+", wxString: null, clouds: [] },
  ]);
  const s = summarize(buildHours({ now: NOW, tz: "America/New_York", taf: t }), "America/New_York");
  assert.equal(s.peak.level, 1);
  assert.equal(s.peak.reasons[0], "Visibility 5 sm forecast until 6 PM");
});

test("hoursOutput and sort order", () => {
  const out = hoursOutput(buildHours({ now: NOW, tz: "America/New_York", spc: "SLGT" }));
  assert.equal(out.length, 24);
  assert.deepEqual(Object.keys(out[0]), ["t", "level", "reasons", "fltCat"]);
  const list = [
    { iata: "B", now: { level: 1 }, peak: { level: 2 } },
    { iata: "A", now: { level: 1 }, peak: { level: 2 } },
    { iata: "C", now: { level: 3 }, peak: { level: 2 } },
    { iata: "D", now: { level: 0 }, peak: { level: 4 } },
  ];
  assert.deepEqual(list.sort(compareAirports).map((a) => a.iata), ["D", "C", "A", "B"]);
});

test("assessAlert text: current and upcoming", () => {
  const cur = assessAlert({ event: "Wind Advisory", onset: +NOW - 3600e3, ends: +NOW + 3600e3 }, NOW, "America/New_York");
  assert.equal(cur.text, "Wind Advisory until 4:20 PM");
  const fut = assessAlert({ event: "Wind Advisory", onset: +NOW + 3 * 3600e3, ends: +NOW + 6 * 3600e3 }, NOW, "America/New_York");
  assert.equal(fut.text, "Wind Advisory 6:20 PM to 9:20 PM");
  assert.equal(assessAlert({ event: "Heat Advisory" }, NOW, "America/New_York"), null);
});

test("FAA programs score by type whatever the cause; reasons name the cause", () => {
  const gs = (reason, cause) => assessFaa({ type: "ground_stop", reason, cause, detail: "until 7:30 PM ET" });
  assert.equal(gs("STAFFING / ATC ZERO").text, "Ground stop — air traffic control staffing (ATC zero), until 7:30 PM ET");
  assert.equal(gs("COMPANY REQUEST / IT OUTAGE").text, "Ground stop — airline request (IT outage), until 7:30 PM ET");
  assert.equal(gs("thunderstorms", "weather").text, "Ground stop — weather (thunderstorms), until 7:30 PM ET");
  for (const r of ["STAFFING", "SECURITY", "VIP MOVEMENT", "SPACE LAUNCH", "EQUIPMENT / OUTAGE", "VOLUME / VOLUME", "WEATHER / WIND"]) assert.equal(gs(r).level, 4, r);
  assert.equal(assessFaa({ type: "ground_delay", reason: "VOLUME / VOLUME", detail: "avg 52m" }).text, "Ground delay program — high traffic volume, avg 52m, until further notice");
  assert.equal(assessFaa({ type: "ground_delay", reason: "SECURITY", detail: "avg 52m" }).level, 3);
  assert.equal(assessFaa({ type: "delay", reason: "volume", detail: "Arrivals 31–45m; Departures 16–30m" }).text, "Delays — high traffic volume, arrivals 31–45m; departures 16–30m, until further notice");
  assert.equal(assessFaa({ type: "closure", reason: "snow removal", scope: "full", detail: "until 9 PM ET" }).text, "Airport closed — weather (snow removal), until 9 PM ET");
});

test("ATCSCC ground stops / GDPs: active only, deduped against NAS status", () => {
  const gs = { type: "GS", active: true, end: "2026-10-03T20:30:00Z", cause: "staffing", causeText: "STAFFING / STAFFING" };
  const it = assessAtcscc(gs, [], "America/New_York", NOW);
  assert.equal(it.level, 4);
  assert.equal(it.text, "Ground stop — air traffic control staffing, until 4:30 PM ET (ATCSCC)");
  assert.equal(assessAtcscc(gs, [{ type: "ground_stop" }], "America/New_York", NOW), null);
  assert.equal(assessAtcscc({ ...gs, active: false }, [], "America/New_York", NOW), null);
  assert.equal(assessAtcscc({ ...gs, type: "GDP" }, [], "America/New_York", NOW).level, 3);
  assert.equal(assessAtcscc({ ...gs, type: "GDP" }, [{ type: "ground_delay" }], "America/New_York", NOW), null);
  assert.equal(assessAtcscc({ ...gs, type: "AFP" }, [], "America/New_York", NOW), null);
  const hours = buildHours({ now: NOW, tz: "America/New_York", atcscc: [gs] });
  assert.deepEqual(hours.slice(0, 3).map((h) => h.level), [4, 4, 0]); // until its end, 20:30Z
});

test("LAMP thunder (LP1): >= 40 High, 20-39 Moderate, for the hour ending at the column time", () => {
  assert.deepEqual([null, 0, 19, 20, 39, 40, 90].map(lampThunderLevel), [0, 0, 0, 2, 2, 3, 3]);
  const t = (h) => new Date(Math.floor(+NOW / 3600e3) * 3600e3 + h * 3600e3).toISOString();
  const lamp = { hours: [{ t: t(2), tstmProb: 25, probHrs: 1 }, { t: t(3), tstmProb: 5, probHrs: 1 }, { t: t(6), tstmProb: 45, probHrs: 1 }] };
  const hours = buildHours({ now: NOW, tz: "America/New_York", lamp });
  assert.deepEqual(hours.slice(0, 7).map((h) => h.level), [0, 2, 0, 0, 0, 3, 0]);
  assert.equal(hours[5].items[0].text, "Thunder chance 45% (LAMP)");
});

test("LAMP convection (CP1) >= 50: Moderate 'Storms likely nearby' only when the thunder chance is lower", () => {
  assert.deepEqual([null, 49, 50, 90].map(lampConvLevel), [0, 0, 2, 2]);
  const t = (h) => new Date(Math.floor(+NOW / 3600e3) * 3600e3 + h * 3600e3).toISOString();
  const lamp = { hours: [
    { t: t(1), tstmProb: 5, convProb: 65, probHrs: 1 },
    { t: t(2), tstmProb: 25, convProb: 70, probHrs: 1 },
    { t: t(3), tstmProb: 45, convProb: 80, probHrs: 1 },
    { t: t(4), tstmProb: 1, convProb: 49, probHrs: 1 },
  ] };
  const hours = buildHours({ now: NOW, tz: "America/New_York", lamp });
  assert.deepEqual(hours.slice(0, 5).map((h) => h.level), [2, 2, 3, 0, 0]);
  assert.deepEqual(hours[0].items.map((i) => i.text), ["Storms likely nearby (LAMP)"]);
  assert.deepEqual(hours[1].items.map((i) => i.text), ["Thunder chance 25% (LAMP)"]);
  assert.deepEqual(hours[2].items.map((i) => i.text), ["Thunder chance 45% (LAMP)"]);
});

test("LAMP LP2 (2-hour) still works when that is the only row", () => {
  const t = (h) => new Date(Math.floor(+NOW / 3600e3) * 3600e3 + h * 3600e3).toISOString();
  const lamp = { hours: [{ t: t(2), tstmProb: 25, probHrs: 2 }, { t: t(3), tstmProb: null, probHrs: 2 }, { t: t(6), tstmProb: 45, probHrs: 2 }] };
  const hours = buildHours({ now: NOW, tz: "America/New_York", lamp });
  assert.deepEqual(hours.slice(0, 7).map((h) => h.level), [2, 2, 0, 0, 3, 3, 0]);
  assert.equal(hours[4].items[0].text, "Thunder chance 45% (LAMP)");
  const s = summarize(hours, "America/New_York");
  assert.equal(s.peak.reasons[0], "Thunder chance 45% (LAMP) forecast 7–9 PM");
});

test("TCF: high coverage High, medium Moderate, within an hour of the valid time", () => {
  assert.deepEqual(["high", "medium", "low", null].map(tcfLevel), [3, 2, 0, 0]);
  const v = new Date(Math.floor(+NOW / 3600e3) * 3600e3 + 4 * 3600e3).toISOString();
  const hours = buildHours({ now: NOW, tz: "America/Chicago", tcf: [{ valid: v, coverage: "high" }, { valid: v, coverage: "medium" }] });
  assert.deepEqual(hours.slice(2, 6).map((h) => h.level), [0, 3, 3, 0]);
  assert.ok(hours[3].items.some((i) => i.text === "Thunderstorms, high coverage (TCF)"));
});

test("CWA: convection or IFR -> Moderate during its validity; other hazards nothing", () => {
  assert.equal(cwaKind({ hazard: "TS" }), "convection");
  assert.equal(cwaKind({ hazard: "IFR" }), "ifr");
  assert.equal(cwaKind({ hazard: "LIFR" }), "ifr");
  assert.equal(cwaKind({ hazard: "TURB", raw: "TURB ASSOC WITH TS" }), null);
  assert.equal(cwaKind({ raw: "AREA SCT TSTMS MOV FROM 24025KT" }), "convection");
  assert.equal(cwaKind({ raw: "AREA IFR CIG BLW 010" }), "ifr");
  assert.equal(cwaKind({ raw: "MOD TURB" }), null);
  const c = { hazard: "TS", validFrom: new Date(+NOW + 2 * 3600e3).toISOString(), validTo: new Date(+NOW + 4 * 3600e3).toISOString() };
  const it = assessCwa(c, NOW, "America/New_York");
  assert.equal(it.text, "Center weather advisory: thunderstorms 5:20 PM to 7:20 PM");
  const hours = buildHours({ now: NOW, tz: "America/New_York", cwa: [c] });
  assert.deepEqual(hours.slice(0, 6).map((h) => h.level), [0, 0, 2, 2, 2, 0]);
  assert.equal(assessCwa({ hazard: "ICE" }, NOW, "America/New_York"), null);
});

test("reasons: one Visibility/Ceiling/Gusts per box (highest, observed on a tie), no duplicates", () => {
  const items = [
    { level: 1, text: "Visibility 5 sm", fc: true },
    { level: 1, text: "Visibility 4 sm", fc: false },
    { level: 3, text: "Ceiling 400 ft", fc: true },
    { level: 1, text: "Ceiling 2,500 ft", fc: false },
    { level: 1, text: "Rain", fc: true },
    { level: 1, text: "Rain", fc: false },
  ];
  assert.deepEqual(uniqueItems(items).map((i) => i.text), ["Ceiling 400 ft", "Visibility 4 sm", "Rain"]);
  const hours = buildHours({
    now: NOW, tz: "America/New_York", taf: taf([{ ...vfr, visib: 5 }]),
    metar: { wxString: null, visib: 5, clouds: [], wspd: 5, wgst: null },
  });
  const s = summarize(hours, "America/New_York");
  assert.deepEqual(s.now.reasons, ["Visibility 5 sm"]);
  assert.equal(s.peak.reasons.length, 1);
});

test("build2b: hours carry the prevailing conditions (METAR in hour 0, TAF state later)", () => {
  const hours = hoursOutput(buildHours({
    now: NOW, tz: "America/Chicago", taf: taf([{ ...vfr, wgst: 22 }]),
    metar: { wxString: "-RA", visib: 6, clouds: [{ cover: "BKN", base: 3500 }], wdir: 200, wspd: 10, wgst: null, temp: 14, fltCat: "MVFR" },
  }));
  assert.deepEqual({ ...hours[0], t: 0, reasons: 0 }, { t: 0, level: 1, reasons: 0, fltCat: "MVFR", cig: 3500, vis: 6, wdir: 200, wspd: 10, wx: "-RA", temp: 14 });
  assert.equal(hours[1].vis, 6);
  assert.equal(hours[1].wgst, 22);
  assert.equal(hours[1].cig, undefined, "SCT is no ceiling");
  assert.deepEqual(condOf({ wdir: "VRB", wspd: 3, visib: "10+", clouds: [] }), { vis: 10, wdir: "VRB", wspd: 3 });
});

test("build2b: observedHours files METARs by hour, max level, latest conditions, highest gust", () => {
  const at = (min) => Math.round((+NOW + min * 60e3) / 1000);
  const obs = observedHours([
    { obsTime: at(-10), visib: "10+", clouds: [], wspd: 5 }, // current hour: left out
    { obsTime: at(-30), visib: 2, wxString: "TSRA", clouds: [{ cover: "BKN", base: 800 }], wspd: 20, wgst: 30, temp: 20 },
    { obsTime: at(-45), visib: "10+", clouds: [], wspd: 8, wgst: 36, temp: 21 },
    { obsTime: at(-200), visib: "10+", clouds: [], wspd: 4 },
    { obsTime: at(-26 * 60), visib: "1/4", wxString: "FG", clouds: [] }, // older than 24 h
  ], NOW);
  assert.deepEqual(obs.map((x) => x.t), ["2026-10-03T16:00:00.000Z", "2026-10-03T18:00:00.000Z"]);
  const h = obs[1];
  assert.equal(h.level, 3);
  assert.ok(h.reasons.includes("Thunderstorms"));
  assert.equal(h.fltCat, "IFR");
  assert.equal(h.wgst, 36);
  assert.equal(h.wx, "TSRA", "latest report's conditions");
  assert.equal(obs[0].level, 0);
  assert.deepEqual(observedHours(null, NOW), []);
});

test("FAA possible narrative is qualified rather than presented as confirmed delays", () => {
  const items = opsPlanItems({notes:[{airports:["ATL"],possible:true,raw:"ATL POSSIBLE HOLDING"}],plan:{}}, {now:new Date("2026-10-04T18:00:00Z")});
  assert.equal(items[0].text,"FAA reports possible delays at ATL");
});
