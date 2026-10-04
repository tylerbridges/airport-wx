// brief hook: site/brief.js helpers in Node, and every scenario's changes.json is well-formed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { changeProblems, KINDS } from "../site/brief.js";
import * as C from "../poller/changes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("brief: changeProblems flags malformed change logs", () => {
  const ok = { v: 1, generated: "2026-10-04T12:00:00.000Z", events: [{ t: "2026-10-04T11:00:00.000Z", iata: "ORD", kind: "level", from: 1, to: 2, sentence: "Risk up to Moderate" }] };
  assert.deepEqual(changeProblems(ok, new Set(["ORD"])), []);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], sentence: "Delays 45%" }] })[0], /bad sentence/);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], kind: "nope" }] })[0], /unknown kind/);
  assert.match(changeProblems(ok, new Set(["MSP"]))[0], /unknown airport/);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], t: "2026-10-02T11:00:00.000Z" }] })[0], /older than 36 h/);
  assert.deepEqual(changeProblems(null), ["not a changes.json (v 1 with events[])"]);
});

test("brief: every scenario's changes.json is well-formed and matches its status", async () => {
  const dir = join(ROOT, "site/data/scenarios");
  const idx = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  let total = 0;
  for (const sc of idx.scenarios) {
    const st = JSON.parse(await readFile(join(dir, sc.file), "utf8"));
    const ch = JSON.parse(await readFile(join(dir, sc.name, "changes.json"), "utf8"));
    assert.deepEqual(changeProblems(ch, new Set(st.airports.map((a) => a.iata))), [], sc.name);
    assert.equal(ch.generated, st.generated, `${sc.name}: built from its own status`);
    total += ch.events.length;
  }
  assert.ok(total > 0);
  assert.deepEqual(new Set(KINDS), new Set(["level", "program_start", "program_end", "program_extend", "closure_start", "closure_end", "warning", "word", "plan_gs_add", "plan_gs_drop", "movement"]));
  assert.ok(C.KEEP_MS === 36 * 3600e3);
});
