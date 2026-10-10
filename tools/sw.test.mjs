// site/sw.js (README "Service worker"): routing is pure and tested here; the file's hash is pinned to its VERSION so
// a change to the worker without a version bump (= without a fresh cache and update) fails.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SW = createRequire(import.meta.url)("../site/sw.js");
const SCOPE = "https://tylerbridges.github.io/airport-wx/";
const r = (path, o = {}) => SW.route({ url: /^https?:/.test(path) ? path : SCOPE + path, scope: SCOPE, method: "GET", mode: "cors", cache: "default", range: false, ...o });

// Bump VERSION in site/sw.js on every change to it, then put the new hash here (the failure message prints it).
const PINNED = { "1": "649670c96340ce5c" };

test("sw: VERSION is bumped whenever sw.js changes", () => {
  const text = readFileSync(join(ROOT, "site/sw.js"), "utf8");
  const hash = createHash("sha256").update(text.replace(/^const VERSION = .*$/m, "")).digest("hex").slice(0, 16);
  assert.equal(PINNED[SW.VERSION], hash, `site/sw.js changed: bump VERSION (now ${SW.VERSION}) and pin { "<new version>": "${hash}" } in tools/sw.test.mjs`);
  assert.equal(SW.SHELL, "awx-shell-" + SW.VERSION);
  assert.equal(SW.DATA, "awx-data-" + SW.VERSION);
  assert.ok([SW.SHELL, SW.DATA].every((k) => SW.PREFIXES.some((p) => k.startsWith(p))) && SW.PREFIXES.every((p) => p.startsWith("awx-")));
});

test("sw: cross-origin, non-GET, range and out-of-scope requests are never intercepted", () => {
  for (const u of ["https://noaa-mrms-pds.s3.amazonaws.com/CONUS/x.grib2.gz", "https://tiles.openfreemap.org/planet/1/2/3.pbf",
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/x/1/2/3.png", "https://airport-wx-live.example.workers.dev/status?ids=MSP",
    "https://aviationweather.gov/api/data/metar", "https://tylerbridges.github.io/index.html", "https://tylerbridges.github.io/sw.js",
    "https://tylerbridges.github.io/wx-radar.js?v=3", "https://tylerbridges.github.io/airport-wxx/app.js?v=1"]) assert.equal(r(u), "pass", u);
  assert.equal(r("data/summary.json", { method: "POST" }), "pass");
  assert.equal(r("app.js?v=87", { method: "HEAD" }), "pass");
  assert.equal(r("data/summary.json", { range: true }), "pass");
  assert.equal(r("https://airport-wx-live.example.workers.dev/calendar", { method: "POST" }), "pass");
});

test("sw: page, assets and data strategies", () => {
  assert.equal(r("", { mode: "navigate" }), "nav");
  assert.equal(r("index.html", { mode: "navigate" }), "nav");
  assert.equal(r("index.html?q=MSP#map", { mode: "navigate" }), "nav");
  for (const u of ["index.html?test=all-clear", "?test=winter-storm-gdp", "index.html?nosw=1", "check.html?mock=1", "accuracy.html"]) assert.equal(r(u, { mode: "navigate" }), "pass", u);
  // checkVersion (no-store) and the refresh button (reload) always reach the network, then re-sync the saved page
  assert.equal(r("index.html", { cache: "no-store" }), "index");
  assert.equal(r("index.html", { cache: "reload" }), "index");
  assert.equal(r("app.js?v=87"), "versioned");
  assert.equal(r("radar/wx-radar.js?v=3"), "versioned");
  for (const u of ["search.js", "navui.js", "icons/icon-180.png", "manifest.webmanifest", "map/us.json", "data/airports-all.json", "data/sample.json", "data/terminals/ORD.json", "data/lounges.json", "data/map-land.json"]) assert.equal(r(u), "static", u);
  for (const u of ["data/summary.json", "data/airport/ORD.json", "data/airport/ORD.json?g=2026-10-06T17%3A33%3A41Z", "data/wx/K.json", "data/wx/index.json", "data/config.json", "data/model/model.json", "data/model/report.json"]) assert.equal(r(u, { cache: "no-cache" }), "data", u);
});

test("sw: scenarios, personal and transitional files and no-store requests are network only", () => {
  for (const u of ["data/scenarios/index.json", "data/scenarios/all-clear.json", "data/scenarios/all-clear/wx/K.json", "data/trips.json", "data/status.json",
    "data/movement.json", "data/changes.json", "data/uptime.json", "data/something-new.json", "sw.js"]) assert.equal(r(u), "pass", u);
  assert.equal(r("data/summary.json", { cache: "no-store" }), "pass");
  assert.equal(r("app.js?v=87", { cache: "no-store" }), "pass");
  assert.equal(r("data/summary.json", { cache: "reload" }), "pass");
});

test("sw: test scenarios, ?nosw=1 and the check page bypass the worker", () => {
  for (const u of ["index.html?test=all-clear", "index.html?nosw=1", "index.html?a=1&nosw=1", "check.html", "check.html?mock=1"]) assert.ok(SW.bypassPage(SCOPE + u), u);
  for (const u of ["", "index.html", "index.html?q=MSP", "index.html?nosw=0", "accuracy.html"]) assert.ok(!SW.bypassPage(SCOPE + u), u);
});

test("sw: the precache list follows index.html's scripts, links and their module imports", () => {
  const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
  const base = SCOPE + "index.html";
  const list = SW.pageAssets(html, base);
  const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => new URL(m[1], base).href);
  assert.ok(scripts.length >= 15);
  for (const s of scripts) assert.ok(list.includes(s), s);
  assert.ok(list.includes(SCOPE + "manifest.webmanifest") && list.includes(SCOPE + "icons/icon-180.png"));
  assert.ok(list.every((u) => u.startsWith(SCOPE)));
  const nav = SW.scriptImports(readFileSync(join(ROOT, "site/nav.js"), "utf8"), SCOPE + "nav.js?v=1");
  assert.ok(nav.includes(SCOPE + "search.js") && nav.includes(SCOPE + "navui.js") && nav.some((u) => u.startsWith(SCOPE + "map.js?v=")));
  const ff = SW.scriptImports(readFileSync(join(ROOT, "site/flight-features.js"), "utf8"), SCOPE + "flight-features.js?v=2");
  assert.ok(ff.some((u) => u.startsWith(SCOPE + "trips.js?v=")), "dynamic import()");
  assert.deepEqual(SW.scriptImports('import x from "https://cdn.example/x.js"; const s = "./not-an-import.js";', SCOPE + "a.js"), []);
});

test("sw: index.html registers ./sw.js with scope ./ and skips ?nosw=1 / ?test=", () => {
  const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(html, /navigator\.serviceWorker\.register\("\.\/sw\.js", \{ scope: "\.\/"/);
  assert.match(html, /\[\?&\]\(\?:nosw=1\|test=\)/);
});
