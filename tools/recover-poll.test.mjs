import test from "node:test";
import assert from "node:assert/strict";
import { recoverPoll } from "./recover-poll.mjs";

const now = Date.parse("2026-10-06T12:00:00Z");
const run = (id, age, branch = "main") => ({ id, head_branch: branch, created_at: new Date(now - 240 * 60000).toISOString(), updated_at: new Date(now - age * 60000).toISOString() });
const gate = (extra = {}) => [{ environment: { name: "github-pages" }, wait_timer: 0, reviewers: [], ...extra }];
test("only stalled main Pages gates without approval or wait rules are cancelled", async () => {
  const calls = [];
  const runs = [run(1, 190), run(2, 5), run(3, 40, "history"), run(4, 40), run(5, 40), run(6, 40), run(7, 40), run(8, 40)];
  const gates = { 1: gate(), 4: gate({ reviewers: [{ type: "User" }] }), 5: gate({ wait_timer: 60 }), 6: [], 7: gate({ environment: { name: "production" } }), 8: gate({ reviewers: undefined }) };
  const result = await recoverPoll({ now, log() {}, api: async (path, opts) => {
    calls.push([path, opts?.method]);
    if (path.includes("workflows")) return { workflow_runs: runs };
    if (path.endsWith("/cancel")) return null;
    return gates[Number(path.split("/")[2])];
  } });
  assert.deepEqual(result, [1]);
  assert.deepEqual(calls.filter(c => c[1] === "POST"), [["actions/runs/1/cancel", "POST"]]);
  assert.ok(!calls.some(c => /runs\/[23]\//.test(c[0])));
});
test("no waiting polls require no mutations", async () => {
  let calls = 0;
  assert.deepEqual(await recoverPoll({ now, api: async () => { calls++; return { workflow_runs: [] }; } }), []);
  assert.equal(calls, 1);
});
