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
