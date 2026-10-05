// build2b: site/cats.js reads each reason's category and level back from its text. For every hour in
// the committed sample and every scenario, the highest level read back must equal the poller's level.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const C = createRequire(import.meta.url)("../site/cats.js");
const files = [join(ROOT, "site/data/sample.json"),
  ...readdirSync(join(ROOT, "site/data/scenarios")).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => join(ROOT, "site/data/scenarios", f))];

test("cats: every reason in the sample and scenarios is read back with the poller's hour level", () => {
  let n = 0;
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    for (const a of d.airports) {
      for (const h of [...a.hours, ...(a.observed || [])]) {
        const lv = h.reasons.map((r) => C.reason(r));
        for (let i = 0; i < lv.length; i++) assert.notEqual(lv[i].level, null, `${f} ${a.iata}: unread reason "${h.reasons[i]}"`);
        // level null = no forecast covers the hour: only informational (level 0) reasons may sit there
        assert.equal(Math.max(0, ...lv.map((x) => x.level)), h.level ?? 0, `${f} ${a.iata} ${h.t}: ${JSON.stringify(h.reasons)}`);
        n++;
      }
      for (const x of (a.opsplan && a.opsplan.items) || []) if (x.level) assert.equal(C.reason(x.text).level, x.level, x.text);
    }
  }
  assert.ok(n > 1000);
});

test("cats: hiding every category never hides a ground stop or a full closure", () => {
  const hide = Object.fromEntries(C.KEYS.map((k) => [k, true]));
  const h = C.filterHour({ level: 4, reasons: ["Ground stop — weather (thunderstorms), until 7:40 PM CT", "Thunderstorms", "Gusts 38 kt"] }, hide);
  assert.deepEqual(h, { level: 4, reasons: ["Ground stop — weather (thunderstorms), until 7:40 PM CT"], dropped: 2 });
  assert.equal(C.filterHour({ level: 4, reasons: ["Airport closed until 9 PM"] }, hide).level, 4);
  assert.equal(C.faa({ type: "ground_stop", cause: "staffing" }), "always");
  assert.equal(C.faa({ type: "closure", scope: "full", active: true }), "always");
  assert.equal(C.faa({ type: "closure", scope: "runway" }), "runways");
  assert.equal(C.hidden("always", hide), false);
});

test("cats: categories, levels and confidence", () => {
  const r = (s) => { const x = C.reason(s); return [x.cat, x.level]; };
  assert.deepEqual(r("Ground delay program — air traffic control staffing, avg 40m"), ["atc", 3]);
  assert.deepEqual(r("Delays — high traffic volume, departures 16–30m, increasing, until further notice"), ["faa", 2]);
  assert.deepEqual(r("Chance of heavy thunderstorms"), ["storms", 3]);
  assert.deepEqual(r("Gusts 28 kt until 7 PM"), ["wind", 2]);
  assert.deepEqual(r("Ceiling 800 ft forecast 4–7 PM"), ["fog", 2]);
  assert.deepEqual(r("Winter Storm Warning until Sun 7:05 AM"), ["winter", 3]);
  assert.deepEqual(r("FAA reports nearby storms affecting arrivals"), ["storms", 1]);
  assert.deepEqual(r("Runway 27R glideslope out of service until Oct 15"), ["atc", 1]);
  assert.deepEqual(r("Rain"), [null, 1]);
  assert.equal(C.alert("Excessive Heat Warning"), "heat");
  assert.equal(C.reason("Chance of thunderstorms").conf, "low");
  assert.equal(C.reason("Thunder chance 45% (LAMP)").conf, "low");
  assert.equal(C.reason("Severe Thunderstorm Warning until 6:55 PM").conf, "high");
  // the poller's level is kept when a kept reason can't be read back
  assert.equal(C.filterHour({ level: 3, reasons: ["Something new", "Gusts 38 kt"] }, { wind: true }).level, 3);
});

test("cats: departure vs arrival impact", () => {
  assert.equal(C.impact(["Ceiling 400 ft"], []), "Arrivals likely slowed (low clouds)");
  assert.equal(C.impact(["Visibility 1/2 sm", "Ceiling 2,000 ft"], []), "Arrivals likely slowed (poor visibility)");
  assert.equal(C.impact(["Thunderstorms nearby", "Ceiling 400 ft"], []), "Departures likely held (storms)");
  assert.equal(C.impact(["Thunderstorms"], [{ type: "ground_stop" }]), "Departures held (ground stop)");
  assert.equal(C.impact(["Snow"], []), "Both directions likely slowed (de-icing, snow or ice)");
  assert.equal(C.impact(["Gusts 38 kt"], []), "Both directions likely slowed (strong crosswinds)");
  assert.equal(C.impact(["Gusts 28 kt"], []), null, "moderate gusts alone");
  assert.equal(C.impact([], [{ type: "ground_delay", detail: "avg 49m" }]), "Arrivals held at their origin (delay program)");
  assert.equal(C.impact([], [{ type: "delay", detail: "Departures 16–30m, increasing" }]), "Departures delayed (FAA)");
  assert.equal(C.impact([], [{ type: "delay", detail: "Arrivals 31–45m, steady; Departures 16–30m, decreasing" }]), "Both directions delayed (FAA)");
  assert.equal(C.impact([], [{ type: "closure" }]), "No flights in or out (airport closed)");
  assert.equal(C.impact(["Rain", "Mist"], []), null);
  assert.equal(C.impact(["Slight risk of severe storms"], []), null, "an outlook alone says nothing about operations");
  assert.equal(C.impact(["Slight risk of severe storms", "FAA reports nearby storms affecting arrivals"], []), "Arrivals likely slowed (FAA: nearby storms)");
});

test("cats: sheet rest layout — split, single (now is the peak), clear", () => {
  assert.equal(C.restLayout(1, 3, true), "split");
  assert.equal(C.restLayout(3, 3, false), "single");
  assert.equal(C.restLayout(2, 2, false), "single");
  assert.equal(C.restLayout(0, 0, false), "clear");
  assert.equal(C.restLayout(2, 2, true), "single", "a later peak that isn't higher is not split");
});
