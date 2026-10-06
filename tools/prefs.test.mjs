// build2b: site/prefs.js (settings state shared by app.js, settings.js and check.js).
import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const store = {};
globalThis.localStorage ??= { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const P = createRequire(import.meta.url)("../site/prefs.js"); // classic script, require()-able

test("prefs: defaults, validation, persistence, notifications", () => {
  assert.deepEqual(P.getPrefs(), { ...P.DEFAULTS, show: { ...P.DEFAULTS.show } });
  assert.ok(Object.values(P.DEFAULTS.show).every((x) => x === true));
  const seen = [];
  const off = P.onPrefs((p, k) => seen.push([k, p[k]]));
  P.setPref("mode", "aviation");
  P.setPref("show", { wind: false });
  P.setPref("clock", "24");
  P.setPref("timeRef", "nonsense"); // ignored
  P.setPref("theme", "dark");
  off();
  P.setPref("codes", "icao"); // not seen: unsubscribed
  const p = P.getPrefs();
  assert.equal(p.mode, "aviation");
  assert.equal(p.show.wind, false);
  assert.equal(p.show.storms, true);
  assert.equal(p.clock, 24);
  assert.equal(p.timeRef, "airport");
  assert.deepEqual(seen.map((x) => x[0]), ["mode", "show", "clock", "theme"]);
  assert.deepEqual(JSON.parse(localStorage.getItem("awx-settings")), p);
  assert.throws(() => P.setPref("bogus", 1));
  p.show.storms = false; // copies only
  assert.equal(P.getPrefs().show.storms, true);
  assert.ok(!("ground_stop" in P.DEFAULTS.show) && !P.CATEGORIES.includes("always"), "ground stops are not a category");
});

test("prefs: flights require explicit boolean opt-in and persist opt-out", () => {
  assert.equal(P.DEFAULTS.flights, false);
  for (const value of ["true", 1, null, {}]) { P.setPref("flights", value); assert.equal(P.getPrefs().flights, false); }
  P.setPref("flights", true);
  assert.equal(JSON.parse(localStorage.getItem(P.KEY)).flights, true);
  P.setPref("flights", false);
  assert.equal(JSON.parse(localStorage.getItem(P.KEY)).flights, false);
});

 test("prefs: an existing installation with no opt-in stays disabled", () => {
  const sandbox = { localStorage: { getItem: () => JSON.stringify({ mode: "aviation", theme: "dark" }) }, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(new URL("../site/prefs.js", import.meta.url), "utf8"), sandbox);
  assert.equal(sandbox.module.exports.getPrefs().flights, false);
  assert.equal(sandbox.module.exports.getPrefs().mode, "aviation");
});
