import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage, freshness, evaluate, findIssue, lastActivity, decide, resultText, ISSUE_TITLE } from "./uptime-parse.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/uptime");
const dom = (n) => readFileSync(join(FX, n), "utf8");
const NOW = Date.parse("2026-10-03T22:40:00Z");
const status = (minAgo) => JSON.stringify({ generated: new Date(NOW - minAgo * 60e3).toISOString(), sources: {}, airports: [] });

test("parses a passing check page dumped by headless Chrome", () => {
  const r = parsePage(dom("dom-pass.html"));
  assert.equal(r.ok, true);
  assert.match(r.head, /^CHECK PASS \(live/);
  assert.match(r.report, /PASS \[Live data\] Freshness/);
});

test("parses a failing page, unescaping HTML entities", () => {
  const r = parsePage(dom("dom-fail.html"));
  assert.equal(r.ok, false);
  assert.match(r.head, /^CHECK FAIL 2/);
  assert.match(r.report, /fail > 20 min/);
  assert.match(resultText(dom("dom-fail.html")), /unavailable: FAA NAS status/);
});

test("a page that never finished, or no page at all, fails", () => {
  assert.deepEqual([parsePage(dom("dom-running.html")).ok, parsePage(dom("dom-running.html")).head], [false, "check page did not finish (CHECK RUNNING)"]);
  assert.equal(parsePage("").ok, false);
  assert.match(parsePage("<html><body>404</body></html>").head, /no #result/);
});

test("independent freshness of status.json", () => {
  assert.equal(freshness(status(5), NOW).ok, true);
  assert.equal(freshness(status(20), NOW).ok, true);
  assert.equal(freshness(status(21), NOW).ok, false);
  assert.equal(freshness("", NOW).ok, false);
  assert.equal(freshness("<html>", NOW).ok, false);
  const e = evaluate(dom("dom-pass.html"), status(35), NOW);
  assert.equal(e.ok, false);
  assert.match(e.head, /FRESHNESS FAIL: status.json generated 35 min ago/);
  assert.equal(evaluate(dom("dom-pass.html"), status(3), NOW).ok, true);
});

test("issue bookkeeping: one issue, comments at most every 6 h, close on recovery", () => {
  const issues = [{ number: 3, title: "Other", state: "open" }, { number: 7, title: ISSUE_TITLE, state: "open" }, { number: 9, title: ISSUE_TITLE, state: "open", pull_request: {} }];
  assert.equal(findIssue(issues), "7");
  assert.equal(findIssue([]), "");
  const issue = { created_at: "2026-10-03T10:00:00Z" };
  const comments = [{ user: { login: "github-actions[bot]", type: "Bot" }, created_at: "2026-10-03T18:00:00Z" }, { user: { login: "tyler", type: "User" }, created_at: "2026-10-03T22:00:00Z" }];
  const last = lastActivity(issue, comments);
  assert.equal(last, Date.parse("2026-10-03T18:00:00Z"));
  assert.equal(decide({ ok: false, issueNumber: "", lastMs: 0, now: NOW }).action, "open");
  assert.equal(decide({ ok: false, issueNumber: "7", lastMs: last, now: NOW }).action, "none"); // 4 h 40 min since
  assert.equal(decide({ ok: false, issueNumber: "7", lastMs: last, now: NOW + 2 * 3600e3 }).action, "comment");
  assert.equal(decide({ ok: true, issueNumber: "7", lastMs: last, now: NOW }).action, "close");
  assert.equal(decide({ ok: true, issueNumber: "", lastMs: 0, now: NOW }).action, "none");
});
