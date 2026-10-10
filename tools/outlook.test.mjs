import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const O = createRequire(import.meta.url)("../site/outlook.js");
const now = Date.parse("2026-10-04T14:15:00Z"), H = 3600000;
const sources = Object.fromEntries(["faa", "atcscc", "metar", "taf", "nws", "sigmet", "spc", "lamp", "tcf", "cwa"].map((k) => [k, { ok: true }]));
const base = () => ({ iata: "ORD", metar: { obsTime: "2026-10-04T14:00:00Z" }, taf: { issued: "2026-10-04T12:00:00Z" }, faa: [], atcscc: [], hours: Array.from({ length: 24 }, (_, i) => ({ t: new Date(now - 15 * 60000 + i * H).toISOString(), level: 0, reasons: [] })) });
const options = (more = {}) => ({ now, generated: new Date(now).toISOString(), sources, ...more });
test("outlook: a last-known active restriction remains visible without forecast hours", () => {
  const a = base(); a.hours = []; a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  const o = O.evaluate(a, options({ offline: true, generated: new Date(now - H).toISOString() }));
  assert.equal(o.kind, "active"); assert.equal(o.level, 4); assert.equal(o.headline, "Ground Stop"); assert.match(o.quality, /Offline/);
  assert.match(o.impacts[0].value, /Held at their departure airports/);
});
test("outlook: quiet status, absent forecast, missing and stale data remain distinct", () => {
  assert.equal(O.evaluate(base(), options()).headline, "No airport-wide disruptions reported");
  assert.equal(O.evaluate(base(), options({ at: now + 24 * H })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ generated: new Date(now - H).toISOString() })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ sources: { ...sources, faa: { ok: false } } })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ hidden: true })).headline, "No issues in your selected categories");
});
test("recovery never precedes a still-valid storm advisory in an older build", () => {
  const a = base(); a.hours[0].level = 3;
  a.sigmets = [{ validTo: new Date(now + 100 * 60000).toISOString() }];
  assert.equal(O.evaluate(a, options()).recovery, Date.parse(a.hours[2].t));
  assert.equal(O.forecastQuality({ hours: [{ delay: { modelCoverage: "pooled" } }] }), "Delay forecast uncertain · no airport-specific accuracy history");
});

test("outlook: scheduled end and FAA extension are not a forecast recovery time", () => {
  const a = base(); a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  a.atcscc = [{ type: "GS", active: true, start: new Date(now - H).toISOString(), end: new Date(now + H).toISOString(), issued: new Date(now - H).toISOString(), extension: "high" }];
  const o = O.evaluate(a, options());
  assert.equal(o.kind, "active"); assert.equal(o.level, 4); assert.equal(o.extension, "high"); assert.equal(o.scheduledEnd, now + H); assert.equal(o.recovery, null);
  assert.match(o.impacts[0].value, /Held at their departure airports/);
  assert.equal(O.evaluate(a, options({ at: now + 2 * H })).kind, "normal");
});
test("outlook: future FAA periods apply only to their valid time; cancelled and superseded stay absent", () => {
  const a = base(); a.atcscc = [{ type: "GS", active: false, start: new Date(now + 2 * H).toISOString(), end: new Date(now + 4 * H).toISOString(), issued: new Date(now - H).toISOString() }];
  assert.equal(O.evaluate(a, options()).kind, "normal");
  assert.equal(O.evaluate(a, options({ at: now + 3 * H })).headline, "Ground Stop scheduled");
  a.atcscc.push({ ...a.atcscc[0], issued: new Date(now).toISOString(), cnx: true });
  assert.equal(O.evaluate(a, options({ at: now + 3 * H })).kind, "normal");
});
test("outlook: a restriction without an end is current information, not a 24-hour forecast", () => {
  const a = base(); a.faa = [{ type: "ground_stop", end: null }];
  assert.equal(O.evaluate(a, options()).kind, "active");
  assert.equal(O.evaluate(a, options({ at: now + H })).kind, "normal");
});
test("outlook: arrival/departure trends remain directional when they disagree", () => {
  const a = base(); a.faa = [{ type: "delay", detail: "Departures 16–30m, increasing; Arrivals 31–45m, decreasing" }];
  const o = O.evaluate(a, options());
  assert.deepEqual(o.impacts, [{ label: "Departures", value: "Delays 16–30 min, increasing" }, { label: "Arrivals", value: "Delays 31–45 min, decreasing" }]);
});
test("outlook: later risk and sustained forecast improvement, with exact trip overlap boundaries", () => {
  const a = base(); for (let i = 2; i <= 4; i++) { a.hours[i].level = 3; a.hours[i].reasons = ["Thunderstorms"]; }
  const o = O.evaluate(a, options()); assert.equal(o.kind, "normal");
  assert.equal(o.window.start, Date.parse(a.hours[2].t)); assert.equal(o.window.end, Date.parse(a.hours[5].t));
  assert.equal(O.overlaps(o.window, a.hours[3].t), true); assert.equal(O.overlaps(o.window, a.hours[5].t), false);
  assert.equal(O.evaluate(a, options({ at: now + 2 * H })).recovery, Date.parse(a.hours[5].t));
});
test("outlook: probability describes an airport hour; delay words raise its display level", () => {
  const a = base(); a.hours[0].delay = { p: 0.5 };
  const words = () => ({ key: "likely", word: "Delays likely", rate: 0.5, cue: "higher than usual" });
  const o = O.evaluate(a, options({ words }));
  assert.equal(o.headline, "Flight delays likely"); assert.equal(o.level, 2); assert.match(o.definition, /airport during an hour/);
  assert.equal(O.evaluate(a, options({ words: () => ({ key: "usual", word: "Usual delays", rate: 0.2 }) })).kind, "normal");
});

// ---------- one level everywhere (display level, summary) ----------
const W = { unlikely: 0, small: 0, usual: 0, possible: 1, likely: 2, very: 3 };
const wordsFor = (d) => d && d.k ? { key: d.k, word: { now: "Delays happening now", possible: "Delays possible", likely: "Delays likely", very: "Delays very likely" }[d.k] || "Usual delays", rate: 0.5, cue: "" } : null;
test("display level: delay words raise an hour (possible ≥ Minor, likely ≥ Moderate, very likely ≥ High, now = the program's level); routine words don't", () => {
  for (const [k, want] of Object.entries(W)) {
    const h = { t: new Date(now).toISOString(), level: 0, reasons: [], delay: { p: 0.5, k } };
    assert.equal(O.score(h, { words: wordsFor }).level, want, k);
    assert.equal(O.score({ ...h, level: 3 }, { words: wordsFor }).level, Math.max(3, want), k + " never lowers");
  }
  for (const [ov, want] of [["ground_stop", 4], ["closure", 4], ["ground_delay", 3], ["delay", 2]]) {
    assert.equal(O.score({ t: "", level: 0, delay: { p: 1, k: "now", override: ov } }, { words: wordsFor }).level, want, ov);
  }
});
test("summary: one level and window for the card, the sheet headline and the map", () => {
  const a = base();
  a.hours[1].level = 1; a.hours[1].reasons = ["Rain"];
  for (const i of [4, 5]) a.hours[i].delay = { p: 0.6, k: "likely" }; // clear skies, delays likely: Moderate 4–6
  a.hours[7].level = 2; a.hours[7].reasons = ["Low clouds"];
  const sm = O.summary(a, options({ words: wordsFor }));
  assert.equal(sm.level, 2); assert.equal(sm.nowLevel, 0); assert.equal(sm.later, true);
  assert.equal(sm.start, Date.parse(a.hours[4].t)); assert.equal(sm.end, Date.parse(a.hours[6].t)); // the first run at the top level
  assert.equal(sm.words.key, "likely");
  // the sheet's "Coming up" card (evaluate at the window) and the map's hour show the same level
  assert.equal(O.evaluate(a, options({ words: wordsFor, at: sm.start })).level, sm.level);
  // every hour named by the window is at the level; the per-hour display levels are the timeline's colours
  for (const x of sm.levels) if (Date.parse(x.t) >= sm.start && Date.parse(x.t) < sm.end) assert.equal(x.level, 2);
  assert.equal(sm.byT.get(a.hours[1].t), 1);
});
test("summary: an FAA program with no stated end is open (no made-up end time) and later hours are uncertain", () => {
  const a = base();
  a.faa = [{ type: "ground_delay", end: null, cause: "weather" }];
  for (let i = 0; i < 3; i++) { a.hours[i].level = 3; a.hours[i].reasons = ["Ground delay program — weather (low ceilings)"]; } // the poller's 3-hour hold
  const sm = O.summary(a, options());
  assert.equal(sm.level, 3); assert.ok(sm.open); assert.equal(sm.open.type, "ground_delay"); assert.equal(sm.openLevel, 3);
  assert.equal(sm.uncertainFrom, Date.parse(a.hours[3].t));
  a.faa[0].end = new Date(now + 2 * H).toISOString();
  assert.equal(O.summary(a, options()).open, null);
});
test("outlook: no forecast improvement for a program whose cause isn't weather", () => {
  const a = base();
  for (let i = 0; i < 3; i++) { a.hours[i].level = 3; a.hours[i].reasons = ["Ground delay program"]; }
  a.faa = [{ type: "ground_delay", end: new Date(now + 2 * H).toISOString(), cause: "weather" }];
  assert.equal(O.evaluate(a, options()).recovery, Date.parse(a.hours[3].t));
  for (const cause of ["volume", "staffing", "equipment", "airline", "other"]) {
    a.faa[0].cause = cause;
    assert.equal(O.evaluate(a, options()).recovery, null, cause);
  }
});
test("outlook: a quiet airport whose notices couldn't be read says so", () => {
  const o = O.evaluate(base(), options({ noticesDown: true }));
  assert.equal(o.kind, "unknown");
  assert.equal(o.headline, "No disruptions reported · flight restrictions unavailable");
});

test("airport health: missing/old airport forecasts and stale source-success timestamps qualify quiet outlooks", () => {
  for (const taf of [null, { issued: "bad" }, { issued: new Date(now - 13 * H).toISOString() }]) {
    const a = base(); a.taf = taf;
    const health = O.health(a, options());
    assert.equal(health.missingForecast, true);
    assert.equal(O.evaluate(a, options()).kind, "unknown");
  }
  const old = { ...sources, faa: { ok: true, at: new Date(now - H).toISOString() } };
  assert.equal(O.evaluate(base(), options({ sources: old })).kind, "unknown");
});

test("airport health: perairport age beats fresh global time; weather-only coverage cannot claim full operations", () => {
  const a = base(); a.coverage = { generated: new Date(now - H).toISOString(), sources };
  assert.equal(O.health(a, options()).outdated, true);
  a.coverage = { generated: new Date(now).toISOString(), sources, weatherOnly: true };
  assert.equal(O.health(a, options()).weatherOnly, true);
  assert.match(O.health(a, options()).quality, /Weather only/);
  assert.equal(O.evaluate(a, options()).kind, "unknown");
});

test("airport health: offline quiet is unknown but last-known material restrictions keep their severity", () => {
  assert.equal(O.evaluate(base(), options({ offline: true })).kind, "unknown");
  const a = base(); a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  for (const extra of [{ offline: true }, { generated: new Date(now - H).toISOString() }]) {
    const r = O.evaluate(a, options(extra));
    assert.equal(r.kind, "active");
    assert.equal(r.level, 4);
    assert.equal(r.headline, "Ground Stop");
    assert.ok(r.quality);
  }
});


test("airport health: missing, failed or stale NWS alerts qualify quiet airports while restrictions remain visible", () => {
  for (const nws of [undefined, {ok:false}, {ok:true,error:"Zone geometry unavailable"}, {ok:true,stale:true}]) {
    const opts = options({sources:{...sources,nws}});
    assert.equal(O.evaluate(base(),opts).kind,"unknown");
    const a=base();a.faa=[{type:"ground_stop",end:new Date(now+H).toISOString()}];
    const o=O.evaluate(a,opts);assert.equal(o.kind,"active");assert.equal(o.level,4);assert.ok(o.quality);
  }
});

test("severe weather with a low model chance does not imply likely delays", () => {
  const a = base(); a.hours[2].level = 3; a.hours[2].reasons = ["Fog", "Ceiling 200 ft", "Visibility 1/2 sm"]; a.hours[2].delay = { p: .1 };
  const opts = options({at: now + 2 * H, words: () => ({key:"unlikely", word:"Delays unlikely"})});
  assert.equal(O.evaluate(a, opts).headline, "Dense fog expected");
  assert.equal(O.evaluate(a, opts).level, 3);
  a.hours[2].reasons = ["Gusts 35 kt"];
  assert.equal(O.evaluate(a, opts).headline, "Strong winds expected");
  assert.equal(O.evaluate(a, {...opts, words: () => ({key:"likely", word:"Delays likely"})}).headline, "Flight delays likely");
});

// ---------- accuracy fixes (Oct 5) ----------
test("condition headline: storms and winter outrank visibility; dense fog needs fog wording and ≤ 1/2 sm; 1/8 and mixed fractions parse", () => {
  const hd = (reasons, wx) => O.conditionHeadline({ reasons, wx }, true);
  assert.equal(hd(["Snow, visibility 1/4 sm", "Visibility 1/4 sm"]), "Winter weather");
  assert.equal(hd(["Thunderstorms", "Visibility 1/2 sm"]), "Storms near the airport");
  assert.equal(hd(["Visibility 1/8 sm"], "FG"), "Dense fog");
  assert.equal(hd(["Mist", "Visibility 3/8 sm"]), "Dense fog");
  assert.equal(hd(["Visibility 1/8 sm"]), "Low visibility");
  assert.equal(hd(["Visibility 0 sm"], "HZ"), "Low visibility");
  assert.equal(hd(["Mist", "Visibility 1 1/2 sm"]), "Low visibility");
  assert.equal(hd(["Dense Fog Advisory"]), "Dense fog");
  assert.equal(O.reasonVisibility("Visibility 1 1/2 sm"), 1.5);
  assert.equal(O.reasonVisibility("Snow, visibility 1/8 sm; Visibility 3/8 sm"), 0.125);
});
test("no forecast: hours beyond the airport forecast are unknown (null), never Clear, in evaluate, summary and windows", () => {
  const a = base();
  for (let i = 20; i < 24; i++) { a.hours[i].level = null; a.hours[i].fltCat = null; }
  const o = O.evaluate(a, options({ at: Date.parse(a.hours[21].t) + 60000 }));
  assert.equal(o.kind, "unknown"); assert.equal(o.level, null); assert.equal(o.headline, "Forecast unavailable for this time");
  const sm = O.summary(a, options());
  assert.equal(sm.byT.get(a.hours[22].t), null);
  assert.equal(sm.byT.get(a.hours[5].t), 0);
  // a delay chance on an uncovered hour never opens a window
  a.hours[22].delay = { p: 0.9, k: "very" };
  assert.equal(O.windowFor(a, { words: wordsFor }, now), null);
  // an FAA restriction in force still scores an uncovered hour
  a.faa = [{ type: "ground_stop", end: new Date(now + 24 * H).toISOString() }];
  assert.equal(O.levelAt(a, a.hours[22], options(), Date.parse(a.hours[22].t), now), 4);
});
test("recovery: 'lower risk' only once the level falls to Low/Clear and stays; a one-level drop is easing; never inside the delay window", () => {
  const a = base();
  const set = (i, level) => { a.hours[i].level = level; a.hours[i].reasons = level ? ["Thunderstorms"] : []; };
  set(0, 4); set(1, 4); set(2, 3); set(3, 3); set(4, 3); set(5, 0); set(6, 0);
  let o = O.evaluate(a, options());
  assert.equal(o.recovery, Date.parse(a.hours[5].t)); assert.equal(o.eases, null);
  // stays High to the end: no recovery, eases to High after hour 2
  for (let i = 5; i < 24; i++) set(i, 3);
  o = O.evaluate(a, options());
  assert.equal(o.recovery, null); assert.deepEqual(o.eases, { at: Date.parse(a.hours[2].t), level: 3 });
  // a Low hour inside the sheet's delay window (notBefore) moves to the first confirmed hour after it
  const b = base();
  b.hours[0].level = 3; b.hours[0].reasons = ["Thunderstorms"];
  for (let i = 1; i < 24; i++) b.hours[i].level = 1;
  assert.equal(O.evaluate(b, options()).recovery, Date.parse(b.hours[1].t));
  assert.equal(O.evaluate(b, options({ notBefore: Date.parse(b.hours[3].t) })).recovery, Date.parse(b.hours[3].t));
  // uncovered hours never confirm a recovery
  for (let i = 1; i < 24; i++) b.hours[i].level = null;
  assert.equal(O.evaluate(b, options()).recovery, null);
});
test("airport health: missing or stale storm sources (SIGMET, SPC, LAMP, TCF, CWA) qualify a quiet headline", () => {
  for (const k of ["sigmet", "spc", "lamp", "tcf", "cwa"]) {
    const o = O.evaluate(base(), options({ sources: { ...sources, [k]: { ok: false } } }));
    assert.equal(o.kind, "unknown", k); assert.equal(o.headline, "No disruptions reported · storm data unavailable", k);
    assert.equal(o.quality, "Storm data unavailable", k);
  }
  const old = new Date(now - 4 * H).toISOString();
  assert.equal(O.evaluate(base(), options({ sources: { ...sources, lamp: { ok: true, at: old } } })).headline, "No disruptions reported · storm data unavailable");
  const { cwa, ...noCwa } = sources;
  assert.equal(O.evaluate(base(), options({ sources: noCwa })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ sources: { ...sources, spc: { ok: true, at: new Date(now - 2 * H).toISOString() } } })).headline, "No airport-wide disruptions reported");
  // a known disruption keeps its headline
  const a = base(); a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  assert.equal(O.evaluate(a, options({ sources: { ...sources, tcf: { ok: false } } })).headline, "Ground Stop");
});

test("trip guidance distinguishes inbound holds, closures, future risk and incomplete coverage", () => {
  for (const type of ["ground_stop", "ground_delay"]) {
    const text = O.travelAdvice({}, {current:{programs:[{type}]}}, {});
    assert.match(text, /headed to this airport.*departure airport/);
    assert.match(text, /keep your planned airport arrival time/);
  }
  assert.match(O.travelAdvice({}, {current:{programs:[{type:"closure"}]}}, {}), /Contact your airline before heading out/);
  assert.match(O.travelAdvice({}, {later:true,level:3,current:{}}, {}), /departure, connection or arrival overlaps/);
  assert.match(O.travelAdvice({}, {current:{level:0}}, {incomplete:true}), /^Coverage is incomplete.*does not guarantee/);
});

test("resolved SFO scheduled end survives summary/detail split and wins over a longer advisory", () => {
  const S = createRequire(import.meta.url)("../site/split.js");
  const end = Date.parse("2026-10-10T06:59:00Z"), frozen = Date.parse("2026-10-10T05:00:00Z");
  const a = base(); a.iata = "SFO"; a.tz = "America/Los_Angeles";
  a.hours = Array.from({ length: 24 }, (_, i) => ({ t: new Date(frozen + i * H).toISOString(), level: i < 2 ? 3 : 0, reasons: [] }));
  a.faa = [{ type: "ground_delay", end: new Date(end).toISOString(), endFrom: "nas", detail: "avg 57m" }];
  a.atcscc = [{ id: "100", airport: "SFO", type: "GDP", active: true, issued: new Date(frozen - H).toISOString(), start: new Date(frozen - 2 * H).toISOString(), end: new Date(end + H).toISOString() }];
  const slim = S.slimAirport(a);
  assert.deepEqual(slim.faa, a.faa);
  for (const airport of [a, slim]) {
    const opts = options({ now: frozen, generated: new Date(frozen).toISOString() });
    assert.equal(O.evaluate(airport, opts).scheduledEnd, end);
    assert.equal(O.evaluate(airport, { ...opts, at: frozen + H }).scheduledEnd, end);
    assert.equal(O.evaluate(airport, { ...opts, at: end }).programs.length, 0, "advisory cannot revive an ended NAS window");
    assert.equal(O.summary(airport, opts).open, null);
  }
});

test("wrong-airport and future-issued advisories never provide current restrictions", () => {
  const a = base();
  const x = { id: "100", airport: "ORD", type: "GDP", active: true, start: new Date(now - H).toISOString(), end: new Date(now + H).toISOString(), issued: new Date(now - H).toISOString() };
  for (const bad of [{ airport: "SFO" }, { issued: new Date(now + 1).toISOString() }]) {
    a.atcscc = [{ ...x, ...bad }];
    assert.equal(O.evaluate(a, options()).programs.length, 0);
  }
});
