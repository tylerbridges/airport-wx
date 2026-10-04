import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const O = createRequire(import.meta.url)("../site/outlook.js");
const now = Date.parse("2026-10-04T14:15:00Z"), H = 3600000;
const sources = Object.fromEntries(["faa", "atcscc", "metar", "taf", "nws"].map((k) => [k, { ok: true }]));
const base = () => ({ iata: "ORD", metar: { obsTime: "2026-10-04T14:00:00Z" }, taf: { issued: "2026-10-04T12:00:00Z" }, faa: [], atcscc: [], hours: Array.from({ length: 24 }, (_, i) => ({ t: new Date(now - 15 * 60000 + i * H).toISOString(), level: 0, reasons: [] })) });
const options = (more = {}) => ({ now, generated: new Date(now).toISOString(), sources, ...more });
test("outlook: a last-known active restriction remains visible without forecast hours", () => {
  const a = base(); a.hours = []; a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  const o = O.evaluate(a, options({ offline: true, generated: new Date(now - H).toISOString() }));
  assert.equal(o.kind, "active"); assert.equal(o.level, 4); assert.equal(o.headline, "Ground Stop"); assert.match(o.quality, /Offline/);
  assert.match(o.impacts[0].value, /Held before departure/);
});
test("outlook: quiet status, absent forecast, missing and stale data remain distinct", () => {
  assert.equal(O.evaluate(base(), options()).headline, "Operating normally");
  assert.equal(O.evaluate(base(), options({ at: now + 24 * H })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ generated: new Date(now - H).toISOString() })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ sources: { ...sources, faa: { ok: false } } })).kind, "unknown");
  assert.equal(O.evaluate(base(), options({ hidden: true })).headline, "No issues in your selected categories");
});
test("outlook: scheduled end and FAA extension are not a forecast recovery time", () => {
  const a = base(); a.faa = [{ type: "ground_stop", end: new Date(now + H).toISOString() }];
  a.atcscc = [{ type: "GS", active: true, start: new Date(now - H).toISOString(), end: new Date(now + H).toISOString(), issued: new Date(now - H).toISOString(), extension: "high" }];
  const o = O.evaluate(a, options());
  assert.equal(o.kind, "active"); assert.equal(o.level, 4); assert.equal(o.extension, "high"); assert.equal(o.scheduledEnd, now + H); assert.equal(o.recovery, null);
  assert.match(o.impacts[0].value, /Held before departure/);
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
