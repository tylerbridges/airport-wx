// Radar card helpers (site/radar/geo.js) and the copied engine (site/radar/wx-radar.js, wx-vmap.js).
// geo.js is browser ESM; imported through a data: URL so Node treats it as a module.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const G = await import("data:text/javascript;base64," + Buffer.from(read("site/radar/geo.js")).toString("base64"));
const sample = JSON.parse(read("site/data/sample.json"));

test("radar: every curated airport is on a NOAA MRMS grid (CONUS, Alaska, Hawaii)", () => {
  for (const a of sample.airports) assert.ok(G.covered(a), a.iata);
  const dom = (iata) => { const a = sample.airports.find((x) => x.iata === iata); return G.domFor(a.lat, a.lon).k; };
  assert.equal(dom("MSP"), "CONUS");
  assert.equal(dom("ANC"), "ALASKA");
  assert.equal(dom("HNL"), "HAWAII");
});

test("radar: U.S. territories show, foreign airports (even with a state-like code) don't", () => {
  assert.equal(G.covered({ iata: "SJU", state: "PR", tz: "America/Puerto_Rico", lat: 18.4394, lon: -66.0018 }), true);
  assert.equal(G.domFor(18.4394, -66.0018).k, "CARIB");
  assert.equal(G.covered({ iata: "GUM", state: "GU", tz: "Pacific/Guam", lat: 13.4834, lon: 144.796 }), true);
  assert.equal(G.domFor(13.4834, 144.796).k, "GUAM");
  // trip airports carry the country code in `state`: Toronto ("CA"), Frankfurt ("DE"), Cancún ("MX")
  assert.equal(G.covered({ iata: "YYZ", state: "CA", tz: "America/Toronto", lat: 43.6777, lon: -79.6248 }), false);
  assert.equal(G.covered({ iata: "FRA", state: "DE", tz: "Europe/Berlin", lat: 50.0379, lon: 8.5622 }), false);
  assert.equal(G.covered({ iata: "CUN", state: "MX", tz: "America/Cancun", lat: 21.0365, lon: -86.877 }), false);
  assert.equal(G.covered({ iata: "LHR", country: "GB", lat: 51.47, lon: -0.4543 }), false);
  assert.equal(G.covered({ iata: "BOS", country: "US", lat: 42.3656, lon: -71.0096 }), true);
  assert.equal(G.covered({ iata: "XXX", state: "MN", tz: "America/Chicago" }), false); // no position
  assert.equal(G.covered(null), false);
});

test("radar: the card spans about 66 nm (zoom ~8) and the rings are labelled per mode", () => {
  const z = G.zoomFor(358, 44.88);
  assert.ok(z > 7.5 && z < 8.6, String(z));
  // width in nm at that zoom
  const nm = (358 * 40075016.686 * Math.cos((44.88 * Math.PI) / 180)) / (256 * 2 ** z) / G.NM;
  assert.ok(Math.abs(nm - G.SPAN_NM) < 1, String(nm));
  assert.ok(G.SPAN_NM > 2 * Math.max(...G.RINGS_NM), "the outer ring fits across the card");
  assert.deepEqual(G.RINGS_NM, [10, 30]);
  assert.equal(G.ringLabel(10, false), "12 mi");
  assert.equal(G.ringLabel(30, false), "35 mi");
  assert.equal(G.ringLabel(30, true), "30 nm");
  assert.ok(G.zoomFor(0, 61) >= 6 && G.zoomFor(5000, 0) <= 10);
});

test("radar: geo.js grids match the engine's DOMS", () => {
  const src = read("site/radar/wx-radar.js");
  const m = /var DOMS = (\[[\s\S]*?\]);/.exec(src);
  assert.ok(m, "DOMS in wx-radar.js");
  const doms = vm.runInNewContext(m[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(doms)), JSON.parse(JSON.stringify(G.DOMS)));
});

test("radar: engine copies parse, credit their source commit and keep the worker branch", () => {
  for (const f of ["site/radar/wx-radar.js", "site/radar/wx-vmap.js"]) {
    const src = read(f);
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
    assert.match(src.slice(0, 600), /tylerbridges\.github\.io[\s\S]{0,120}commit[\s/]+d4f012bd19231412be944e30a3ac8a2e9f8fa97b/, f + " header names the source commit");
    assert.match(src, /INW = typeof document === "undefined", SELF = !INW && document\.currentScript/, f + " worker branch");
  }
  const radar = read("site/radar/wx-radar.js");
  assert.doesNotMatch(radar, /navigator\.geolocation|localStorage\./, "no location following or saved style");
  assert.match(radar, /"awx-mrms-1"/);
  // the card's engine version and the probe page load the same files
  assert.match(read("site/radar/card.js"), /ENGINE_V = "\d+"/);
});

test("radar: the worker branch decodes nothing on load and answers an unknown frame with an error", async () => {
  // run wx-radar.js as a worker would (no document): it must install onmessage without touching the DOM
  const posted = [];
  const ctx = { postMessage: (m) => posted.push(m), Promise, Math, Date, Uint8Array, Float64Array, Uint32Array, DataView, String, Error, Object, Array, Number, setTimeout, clearTimeout };
  ctx.self = ctx;
  vm.runInNewContext(read("site/radar/wx-radar.js").replace(/\}\)\(this\);\s*$/, "})(self);"), ctx);
  assert.equal(typeof ctx.onmessage, "function");
  ctx.onmessage({ data: { kind: "probe", id: 7, t: 123, pts: [[44.88, -93.22]] } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ id: 7, err: true, msg: "frame not loaded" }]);
});
