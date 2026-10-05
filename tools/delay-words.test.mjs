// build2b: site/delay.js likelihood() — plain, conservative delay words from the calibrated observed rate.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {}; // delay.js only touches the DOM when window.document exists
const D = await import("../site/delay.js");

const bins = (rows) => rows.map(([lo, meanP, rate, n]) => ({ lo, hi: lo + 0.1, meanP, rate, n, k: Math.round(rate * n) }));
// identity-ish calibration with plenty of test hours, except the 0.8–0.9 bin (small) and 0.9–1 (empty)
const REPORT = {
  test: {
    reliability: bins([[0, 0.05, 0.05, 5000], [0.1, 0.15, 0.15, 5000], [0.2, 0.25, 0.25, 5000], [0.3, 0.35, 0.35, 5000], [0.4, 0.45, 0.45, 5000],
      [0.5, 0.55, 0.55, 5000], [0.6, 0.65, 0.65, 5000], [0.7, 0.75, 0.78, 5000], [0.8, 0.85, 0.86, 150], [0.9, null, null, 0]]),
    byAirport: { ORD: { bss: { climo: 0.12 } }, SFO: { bss: { climo: 0.01 } } },
  },
};
const W = (p, extra = {}, opts = {}) => D.likelihood({ p, ...extra }, { report: REPORT, aviation: false, iata: "ORD", ...opts });

test("delay words: mapping table on the calibrated rate", () => {
  assert.equal(W(0.05).word, "Delays unlikely");
  assert.equal(W(0.18).word, "Small chance of delays");
  assert.equal(W(0.18, { pTypical: 0.17 }).word, "Usual delays", "within ±25% of typical");
  assert.equal(W(0.18, { pTypical: 0.3 }).word, "Small chance of delays");
  assert.equal(W(0.35).word, "Delays possible");
  assert.equal(W(0.55).word, "Delays likely");
  assert.equal(W(0.76).word, "Delays very likely", "bin rate >= 70% over >= 200 hours");
});

test("delay words: test outcomes never remap the validation-calibrated probability", () => {
  const real = { test: { reliability: bins([[0.5, 0.55, 0.47, 13000], [0.6, 0.65, 0.53, 9700], [0.7, 0.75, 0.63, 6700]]) } };
  const L = D.likelihood({ p: 0.65 }, { report: real, aviation: false });
  assert.equal(L.rate, 0.65);
  assert.equal(L.word, "Delays likely");
  assert.equal(D.likelihood({ p: 0.75 }, { report: real, aviation: false }).word, "Delays likely", "observed 63%: not very likely");
  assert.equal(D.calibrate(0.75, real).rate, 0.75);
  // no report: the already calibrated score
  assert.equal(D.likelihood({ p: 0.3 }, { report: null, aviation: false }).word, "Delays possible");
});

test("delay words: a bin with fewer than 200 test hours steps down one word", () => {
  assert.equal(W(0.86).word, "Delays likely", "very likely stepped down (150 hours)");
  assert.equal(W(0.95).word, "Delays likely", "empty bin: no very likely");
  const thin = { test: { reliability: bins([[0.3, 0.35, 0.35, 120], [0.4, 0.45, 0.45, 5000]]) } };
  assert.equal(D.likelihood({ p: 0.36 }, { report: thin, aviation: false }).word, "Small chance of delays", "possible stepped down (120 hours)");
});

test("delay words: low-skill airports are capped at 'Delays possible'", () => {
  assert.equal(W(0.76, {}, { iata: "SFO" }).word, "Delays possible");
  assert.equal(W(0.55, {}, { iata: "SFO" }).word, "Delays possible");
  assert.equal(W(0.18, {}, { iata: "SFO" }).word, "Small chance of delays", "lower words unchanged");
});

test("unvalidated airports never borrow calibrated confidence or a usual-airport comparison", () => {
  for (const p of [0.05, 0.55, 0.8]) {
    const L = W(p, { modelCoverage: "pooled", pTypical: 0.2 });
    assert.equal(L.key, "unknown");
    assert.equal(L.word, "Delay forecast uncertain");
    assert.equal(L.cue, "");
    assert.equal(L.size, "");
  }
  assert.equal(W(0.55, {}, { iata: "BZN" }).key, "unknown");
  assert.equal(W(0.55, { typicalScope: "pooled", pTypical: 0.2 }).cue, "");
  assert.equal(W(1, { override: "ground_stop", modelCoverage: "pooled" }).key, "now", "confirmed FAA programs remain visible");
});

test("delay words: an FAA program in effect wins, with the FAA average", () => {
  const L = D.likelihood({ p: 1, override: "ground_stop", minutes: 49, minutesFrom: "faa" }, { report: REPORT, aviation: false, iata: "SFO" });
  assert.equal(L.key, "now");
  assert.equal(L.sentence, "Delays happening now · FAA average about 49 min");
  assert.equal(D.likelihood({ p: 1, override: "possible_ground_stop" }, { report: REPORT, aviation: false }).key, "likely", "a possible program is scored like any other chance (empty top bin: not very likely)");
});

test("delay words: relative cue, size range, no % except Aviation mode", () => {
  assert.equal(W(0.55, { pTypical: 0.2 }).sentence, "Delays likely · higher than usual");
  assert.equal(W(0.15, { pTypical: 0.3 }).sentence, "Small chance of delays · lower than usual");
  assert.equal(W(0.35, { pTypical: 0.33 }).cue, "");
  assert.equal(W(0.35, { minutes: 38 }).size, "typically 30–50 min");
  assert.equal(D.minutesRange(12), "typically 5–20 min");
  for (const p of [0.02, 0.18, 0.35, 0.55, 0.76, 0.86]) assert.ok(!/%/.test(W(p, { pTypical: 0.2, minutes: 30 }).sentence));
  assert.equal(D.likelihood({ p: 0.55 }, { report: REPORT, aviation: true, iata: "ORD" }).word, "Delays likely (55%)");
  assert.equal(D.analogWords({ n: 214, k: 131, text: "In 214 similar evening hours at ORD since Aug 2024, 131 (61%) had delays of 15+ min; median 38 min." }),
    "In 214 similar evening hours at ORD since Aug 2024, about 6 in 10 had delays of 15+ min; median 38 min.");
});

test("delay words: the analog is shown only when it agrees with the words (same band or one apart)", () => {
  const likely = W(0.55);
  assert.equal(D.analogAgrees({ n: 57, k: 11 }, likely), false, "19% vs 'Delays likely' contradicts");
  assert.equal(D.analogAgrees({ n: 57, k: 20 }, likely), true, "35% is one band below");
  assert.equal(D.analogAgrees({ n: 57, k: 33 }, likely), true);
  assert.equal(D.analogAgrees({ n: 0, k: 0 }, likely), false);
});

test("detail outlook: routine delay rates stay quiet; active or elevated risk stays visible", () => {
  const routine = { p: 0.55, pTypical: 0.5 };
  assert.equal(D.notable(routine, 0, W(routine.p, routine)), false);
  const elevated = { p: 0.55, pTypical: 0.2 };
  assert.equal(D.notable(elevated, 0, W(elevated.p, elevated)), true);
  const smallIncrease = { p: 0.3, pTypical: 0.1 };
  assert.equal(D.notable(smallIncrease, 0, W(smallIncrease.p, smallIncrease)), false);
  assert.equal(D.notable(smallIncrease, 2, W(smallIncrease.p, smallIncrease)), true);
  for (const override of ["ground_stop", "ground_delay", "delay", "possible_ground_stop"]) {
    const d = { p: override.startsWith("possible_") ? 0.5 : 1, pTypical: 0.5, override };
    assert.equal(D.notable(d, 0, W(d.p, d)), true, override);
  }
});

test("routine line: the strongest band over the rest of the local day, in words, size only from 'possible'", () => {
  D.setReport(REPORT);
  const now = Date.parse("2026-07-16T19:30:00Z"); // 2:30 PM in Chicago; the local day ends at 05Z
  const ap = (f) => ({ iata: "ORD", tz: "America/Chicago", hours: Array.from({ length: 24 }, (_, i) => {
    const t = Date.parse("2026-07-16T19:00:00Z") + i * 3600e3;
    return { t: new Date(t).toISOString(), level: 0, delay: { p: 0.05, minutes: 25, ...f(new Date(t).getUTCHours()) } };
  }) });
  assert.equal(D.routineOutlook(ap(() => ({})), now).text, "Delays unlikely today");
  // 5–9 PM usual; a higher chance after local midnight doesn't count
  const ev = D.routineOutlook(ap((h) => (h >= 22 || h <= 1 ? { p: 0.18, pTypical: 0.17 } : h === 6 ? { p: 0.6 } : {})), now);
  assert.equal(ev.text, "Usual delays this evening");
  assert.equal(ev.key, "usual");
  const pm = D.routineOutlook(ap((h) => (h === 20 || h === 21 ? { p: 0.35 } : {})), now);
  assert.equal(pm.text, "Delays possible this afternoon · typically 15–35 min");
  assert.ok(!/%/.test(pm.text));
  assert.equal(D.routineOutlook(ap((h) => (h === 19 ? { p: 1, override: "ground_stop" } : {})), now), null, "an FAA program in effect: no routine line");
  assert.equal(D.routineOutlook({ iata: "ORD", tz: "America/Chicago", hours: [] }, now), null);
  D.setReport(null);
});

test("routine line: day-part phrases", () => {
  const tz = "America/Chicago";
  const at = (hhZ, day = 16) => Date.parse(`2026-07-${day}T${String(hhZ).padStart(2, "0")}:00:00Z`);
  assert.equal(D.dayPartPhrase(at(22), at(2, 17), tz), "this evening"); // 5–9 PM
  assert.equal(D.dayPartPhrase(at(17), at(23), tz), "this afternoon and evening"); // 12–6 PM
  assert.equal(D.dayPartPhrase(at(23), at(5, 17), tz, true), "tonight"); // 6 PM – midnight, the rest of the day
  assert.equal(D.dayPartPhrase(at(15), at(5, 17), tz, true), "today"); // 10 AM – midnight
  assert.equal(D.dayPartPhrase(at(3, 17), at(4, 17), tz), "tonight"); // 10–11 PM
  assert.equal(D.dayPartPhrase(at(14), at(16), tz), "this morning");
});


test("delay words: pre-test support controls caps independently of test outcomes", () => {
  const frozen = { reliability: bins([[0.7, 0.75, 0.78, 5000]]), byAirport: { ORD: { bss: { climo: 0.12 } } } };
  const a = { displaySupport: frozen, test: { reliability: bins([[0.7, 0.75, 0.1, 1]]), byAirport: { ORD: { bss: { climo: -0.1 } } } } };
  const b = { displaySupport: frozen, test: { reliability: bins([[0.7, 0.75, 0.95, 5000]]), byAirport: { ORD: { bss: { climo: 0.8 } } } } };
  const opts = { iata: "ORD", aviation: false };
  assert.deepEqual(D.likelihood({ p: 0.75 }, { ...opts, report: a }), D.likelihood({ p: 0.75 }, { ...opts, report: b }));
  assert.equal(D.likelihood({ p: 0.75 }, { ...opts, report: a }).word, "Delays very likely");
});

test("pooled airport More details keeps uncertainty without an undefined routine headline", () => {
  const now = Date.parse("2026-10-04T18:00:00Z");
  const a = { iata: "BZN", tz: "America/Denver", hours: [{ t: new Date(now).toISOString(), level: 0, delay: { p: 0.05, modelCoverage: "pooled", typicalScope: "pooled" } }] };
  assert.equal(D.routineOutlook(a, now), null);
  const o = D.outlookHour(a, now);
  assert.equal(o.L.word, "Delay forecast uncertain");
  assert.equal(o.from, "now");
});

test("delay window: hours that have ended (t + 1 h <= now) and hours with no forecast never lead the card window", () => {
  D.setReport(REPORT);
  const now = Date.parse("2026-07-16T19:30:00Z");
  const t0 = Date.parse("2026-07-16T17:00:00Z"); // hours 0–1 ended, hour 2 holds now
  const a = { iata: "ORD", tz: "America/Chicago", hours: Array.from({ length: 24 }, (_, i) => ({
    t: new Date(t0 + i * 3600e3).toISOString(), level: i === 6 ? null : i === 0 || i === 4 ? 1 : 0,
    delay: { p: i === 0 ? 0.9 : i === 4 ? 0.6 : i === 6 ? 0.95 : 0.05, minutes: 40 } })) };
  const o = D.outlookHour(a, now);
  assert.equal(o.from, "card");
  assert.equal(o.i, 4, "the ended 0.9 hour and the uncovered 0.95 hour are skipped");
  assert.equal(o.s, 4); assert.equal(o.e, 4); assert.equal(o.started, false);
  D.setReport(null);
});
