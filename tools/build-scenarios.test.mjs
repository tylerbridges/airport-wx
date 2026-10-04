import test from "node:test";
import assert from "node:assert/strict";
import { mergeFile } from "./build-scenarios.mjs";

test("scenario files merge over the base by icaoId / key, templates kept intact", () => {
  const base = '[\n  {"icaoId":"KORD","obsTime":{{-8}},"rawOb":"KORD {{z-8}}Z calm"},\n  {"icaoId":"KMDW","obsTime":{{-9}},"rawOb":"KMDW"}\n]\n';
  const over = '[\n  {"icaoId":"KORD","obsTime":{{-6}},"rawOb":"KORD {{z-6}}Z +TSRA"}\n]\n';
  const m = mergeFile("metar.json", base, over);
  assert.match(m, /"icaoId":"KMDW","obsTime":\{\{-9\}\}/);
  assert.match(m, /"icaoId":"KORD","obsTime":\{\{-6\}\},"rawOb":"KORD \{\{z-6\}\}Z \+TSRA"/);
  assert.doesNotMatch(m, /calm/);
  assert.deepEqual(Object.keys(JSON.parse(mergeFile("nws.json", '{"ORD":{"features":[]},"DEN":{}}', '{"DEN":{"x":1}}'))), ["ORD", "DEN"]);
  assert.equal(mergeFile("faa.xml", "<a/>", "<b/>"), "<b/>");
});

test("scenario extra tokens, movement seed merge, delayOverride", async () => {
  const { expandExtra, applyDelayOverride } = await import("./build-scenarios.mjs");
  const now = new Date("2026-07-16T20:30:00Z");
  assert.equal(expandExtra("UNTIL {{hhmm+75}} -EWR GROUND STOP", now), "UNTIL 2145 -EWR GROUND STOP");
  assert.equal(expandExtra("UNTIL {{hhmm+240}}", now), "UNTIL 0030");
  assert.equal(expandExtra("AD AP CLSD {{notam-180}}-{{notam+510}}", now), "AD AP CLSD 2607161730-2607170500");
  assert.equal(expandExtra("{{+90}} {{z-5}}", now), "{{+90}} {{z-5}}", "poller tokens are left alone");
  const seed = JSON.parse(mergeFile("movement.json", '{"days":21,"mult":{},"baseDep":{"default":30}}', '{"mult":{"EWR":0.3}}'));
  assert.deepEqual(seed, { days: 21, mult: { EWR: 0.3 }, baseDep: { default: 30 } });
  const st = { airports: [{ iata: "MSP", hours: [{ delay: { p: 0.2 } }, { delay: { p: 0.3 } }, { delay: { p: 0.1 } }] }] };
  const done = applyDelayOverride(st, [{ iata: "MSP", from: 1, to: 2, p: 0.4, why: "test" }]);
  assert.deepEqual(st.airports[0].hours.map((h) => h.delay.p), [0.2, 0.4, 0.4]);
  assert.equal(st.airports[0].hours[1].delay.scenarioOverride, true);
  assert.deepEqual(done, [{ iata: "MSP", from: 1, to: 2, p: 0.4, why: "test" }]);
  assert.throws(() => applyDelayOverride(st, [{ iata: "XXX", p: 1 }]), /no airport XXX/);
});

test("every scenario has a known menu group, a title and assertions", async () => {
  const { scenarioNames, GROUPS } = await import("./build-scenarios.mjs");
  const { readFile } = await import("node:fs/promises");
  const names = await scenarioNames();
  assert.ok(names.length >= 23, `${names.length} scenarios`);
  for (const n of names) {
    const meta = JSON.parse(await readFile(new URL(`../poller/scenarios/${n}/scenario.json`, import.meta.url), "utf8"));
    assert.ok(meta.title && GROUPS[meta.group], `${n}: title and group`);
    assert.ok(Array.isArray(meta.assert) && meta.assert.length, `${n}: assertions`);
    if (meta.at) assert.ok(Number.isFinite(Date.parse(meta.at)), `${n}: at`);
  }
});
