import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { liveTfrs, KEEP_MS, TFR_LIST } from "./notices-poll.mjs";
import { parseTfrDetail } from "./tfr.mjs";
import { expandTemplate } from "./lib.mjs";
const { coverage, describe, section } = createRequire(import.meta.url)("../site/notices.js");
const NOW = new Date("2026-10-10T05:00:00Z"), MIN = 60e3;
const xml = expandTemplate(await readFile(new URL("./fixtures/tfr-detail-6_4321.xml", import.meta.url), "utf8"), NOW);
const record = (n, extra = {}) => ({ notam_id: `6/${n}`, type: "VIP", mod_date: "2026-10-10T04:00:00Z", ...extra });
const cached = (n, age, modified = record(n).mod_date) => ({ at: +NOW - age, modified, tfr: { ...parseTfrDetail(xml), id: `6/${n}` } });
async function run(list, { cache = {}, fail = false, malformed = false, advance = 0 } = {}) {
  let elapsed = 0, requests = 0, active = 0, maxActive = 0;
  const fetchFn = async url => {
    if (url === TFR_LIST) return new Response(JSON.stringify(list));
    requests++; active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); elapsed += advance; active--;
    if (fail) throw new Error("mock transport failure");
    const id = /detail_(\d+)_(\d+)\.xml/.exec(url).slice(1).join("/");
    return new Response(malformed ? "<broken/>" : xml.replaceAll("6/4321", id));
  };
  const result = await liveTfrs([{ state: "DC" }], NOW, { note() {}, save() {} }, cache, { fetchFn, clock: () => elapsed });
  const s = result.meta;
  assert.equal(s.listed, s.excluded + s.eligible);
  assert.equal(s.eligible, s.attempted + s.cacheHits + s.skipped);
  assert.equal(s.attempted, s.parsed + s.failed);
  assert.equal(s.tfrs, s.parsed + s.cached);
  assert.equal(requests, s.attempted);
  assert.ok(maxActive <= 4);
  return { ...result, requests, cache };
}
test("60 parsed of 87 listed can be complete when 27 are intentionally excluded", async () => {
  const list = Array.from({ length: 87 }, (_, i) => record(1000 + i, i >= 60 ? { type: "HAZARDS", state: "ID" } : {}));
  const { meta: s, requests } = await run(list);
  assert.equal(requests, 60); assert.equal(s.excluded, 27); assert.equal(s.incomplete, false);
  assert.equal(coverage(s).down, false); assert.match(describe(s), /27 intentionally excluded/);
});
test("cap overflow retains valid notices and explicitly counts omitted details", async () => {
  const { meta: s, tfrs, requests } = await run(Array.from({ length: 87 }, (_, i) => record(1000 + i)));
  assert.equal(requests, 60); assert.equal(tfrs.length, 60); assert.equal(s.capSkipped, 27);
  assert.equal(s.incomplete, true); assert.match(coverage(s).text, /incomplete/);
});
test("budget exhaustion stops new requests, counts skips, and keeps successful details", async () => {
  const r = await run(Array.from({ length: 10 }, (_, i) => record(1000 + i)), { advance: 30_000 });
  assert.equal(r.requests, 4); assert.equal(r.meta.budgetSkipped, 6); assert.equal(r.tfrs.length, 4);
  assert.equal(r.meta.incomplete, true);
});
for (const path of ["failure", "budget", "cap"]) {
  for (const [name, age, modified, expected] of [
    ["current", 90 * MIN, record(9999).mod_date, true],
    ["expired", KEEP_MS, record(9999).mod_date, false],
    ["changed", 90 * MIN, "old modification", false],
    ["future", -10 * MIN, record(9999).mod_date, false],
    ["missing modification", 90 * MIN, null, false],
    ["missing cache", null, null, false],
  ]) test(`${path} fallback: ${name}`, async () => {
    const prefix = path === "cap" ? 60 : path === "budget" ? 4 : 0;
    const list = [...Array.from({ length: prefix }, (_, i) => record(1000 + i)), record(9999)];
    const cache = { tfr: age == null ? {} : { "6/9999": cached(9999, age, modified) } };
    const r = await run(list, { cache, fail: path === "failure", advance: path === "budget" ? 30_000 : 0 });
    assert.equal(!!r.tfrs?.some(t => t.id === "6/9999"), expected);
    assert.equal(r.meta.cached, Number(expected));
    if (expected) assert.equal(cache.tfr["6/9999"].at, +NOW - age, "fallback never extends cache lifetime");
  });
}
test("fresh matching cache avoids a request; null cache and unknown modification do not", async () => {
  const cache = { tfr: { "6/1000": cached(1000, 10 * MIN), "6/1001": { ...cached(1001, MIN), tfr: null } } };
  const r = await run([record(1000), record(1001), record(1002, { mod_date: null })], { cache });
  assert.equal(r.requests, 2); assert.equal(r.meta.cacheHits, 1); assert.equal(r.meta.parsed, 2);
});
test("malformed/null parses are failures, preserve usable cache, and qualify coverage", async () => {
  const cache = { tfr: { "6/1000": cached(1000, 90 * MIN) } };
  const r = await run([record(1000), record(1001)], { cache, malformed: true });
  assert.equal(r.meta.failed, 2); assert.equal(r.meta.parsed, 0); assert.equal(r.meta.cached, 1);
  assert.equal(r.meta.incomplete, true); assert.equal(r.tfrs.length, 1);
  assert.equal(cache.tfr["6/1000"].tfr.id, "6/1000");
  const empty = await run([record(1000)], { malformed: true });
  assert.equal(empty.meta.ok, false); assert.equal(empty.tfrs, null);
});
test("fallback freshness is checked at use time, including elapsed polling time", async () => {
  const cache = { tfr: { "6/9999": cached(9999, KEEP_MS - MIN) } };
  const r = await run([...Array.from({ length: 4 }, (_, i) => record(1000 + i)), record(9999)], { cache, advance: 30_000 });
  assert.equal(r.meta.cached, 0);
});
test("legacy availability is qualified without describing exclusions as failures", () => {
  assert.equal(coverage({ ok: true, listed: 87, tfrs: 60 }).down, true);
  assert.match(describe({ listed: 87, tfrs: 60 }), /breakdown unavailable/);
  assert.equal(coverage({ ok: true, listed: 4, tfrs: 4 }).down, false);
});
test("traveler notices retain valid content and expose partial coverage", () => {
  const h = (tag, attrs, ...kids) => ({ tag, attrs, kids });
  const n = section({ notices: { items: [{ src: "tfr", text: "VIP movement nearby", peak: 2 }] } }, {},
    { h, section: (...args) => args, retime: t => t, now: +NOW, sources: { tfr: { ok: true, incomplete: true } } });
  assert.match(JSON.stringify(n), /VIP movement nearby/);
  assert.match(JSON.stringify(n), /coverage is incomplete/);
});
test("missing modification on both list and cache cannot authorize reuse or fallback", async () => {
  const cache = { tfr: { "6/1000": cached(1000, MIN, null) } };
  const r = await run([record(1000, { mod_date: null })], { cache, fail: true });
  assert.equal(r.requests, 1); assert.equal(r.meta.cached, 0); assert.equal(r.tfrs, null);
});
test("a successful list with no usable details remains unknown, not an empty complete result", async () => {
  const r = await run(Array.from({ length: 10 }, (_, i) => record(1000 + i)), { fail: true, advance: 30_000 });
  assert.equal(r.meta.failed, 4); assert.equal(r.meta.budgetSkipped, 6);
  assert.equal(r.meta.incomplete, true); assert.equal(r.meta.ok, false); assert.equal(r.tfrs, null);
});
test("wrong-record XML is a failed detail rather than a notice for another record", async () => {
  const r = await liveTfrs([], NOW, { note() {}, save() {} }, {}, {
    clock: () => 0, fetchFn: async url => new Response(url === TFR_LIST ? JSON.stringify([record(1000)]) : xml),
  });
  assert.equal(r.meta.failed, 1); assert.equal(r.tfrs, null);
});
