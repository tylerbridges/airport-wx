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

test("delay words: calibration reads the reliability table (predicted 60–70% -> observed 53%)", () => {
  const real = { test: { reliability: bins([[0.5, 0.55, 0.47, 13000], [0.6, 0.65, 0.53, 9700], [0.7, 0.75, 0.63, 6700]]) } };
  const L = D.likelihood({ p: 0.65 }, { report: real, aviation: false });
  assert.ok(Math.abs(L.rate - 0.53) < 1e-9);
  assert.equal(L.word, "Delays likely");
  assert.equal(D.likelihood({ p: 0.75 }, { report: real, aviation: false }).word, "Delays likely", "observed 63%: not very likely");
  // no report: the raw score
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
