import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage, freshness, evaluate, findIssue, lastActivity, decide, resultText, classifyAttempt, verdictOf, ISSUE_TITLE } from "./uptime-parse.mjs";

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

// Playwright attempts: {text} is the #result text, null when it never appeared.
const PASS = { text: "CHECK PASS (live)\nPASS [Live data] Freshness" };
const FAIL = { text: "CHECK FAIL 2\nFAIL [Live data] something" };
const RUNNING = { text: "CHECK RUNNING" };
const TIMEOUT = { text: null, error: "Timeout 120000ms exceeded" };
const issueFor = (v, lastMs = 0) => decide({ verdict: v.verdict, issueNumber: "", lastMs, now: NOW }).action === "open";

test("attempt classification: running and timeouts are inconclusive, not failures", () => {
  assert.equal(classifyAttempt(PASS.text).state, "pass");
  assert.equal(classifyAttempt(FAIL.text).state, "fail");
  assert.equal(classifyAttempt(RUNNING.text).state, "inconclusive");
  assert.match(classifyAttempt(RUNNING.text).head, /still running/);
  assert.equal(classifyAttempt(null, "Timeout").state, "inconclusive");
  assert.equal(classifyAttempt("").state, "inconclusive");
});

test("retry rule: PASS on the first attempt", () => {
  const v = verdictOf([PASS], status(5), NOW);
  assert.deepEqual([v.verdict, v.ok, issueFor(v)], ["pass", true, false]);
  assert.match(v.head, /^CHECK PASS/);
});

test("retry rule: FAIL then PASS opens no issue", () => {
  const v = verdictOf([FAIL, PASS], status(5), NOW);
  assert.deepEqual([v.verdict, v.ok, issueFor(v)], ["pass", true, false]);
  // and it closes an open issue as recovered
  assert.equal(decide({ verdict: v.verdict, issueNumber: "7", lastMs: 0, now: NOW }).action, "close");
});

test("retry rule: FAIL, FAIL opens an issue", () => {
  const v = verdictOf([FAIL, FAIL], status(5), NOW);
  assert.deepEqual([v.verdict, v.ok, issueFor(v)], ["fail", false, true]);
  assert.match(v.head, /attempt 1: CHECK FAIL 2; attempt 2: CHECK FAIL 2/);
  assert.match(v.report, /^CHECK FAIL/);
  assert.equal(decide({ verdict: v.verdict, issueNumber: "7", lastMs: NOW - 1 * 3600e3, now: NOW }).action, "none"); // 6 h comment throttle
  assert.equal(decide({ verdict: v.verdict, issueNumber: "7", lastMs: NOW - 7 * 3600e3, now: NOW }).action, "comment");
});

test("retry rule: RUNNING, RUNNING with fresh data opens no issue and leaves an open one alone", () => {
  for (const pair of [[RUNNING, RUNNING], [TIMEOUT, RUNNING], [FAIL, RUNNING]]) {
    const v = verdictOf(pair, status(8), NOW);
    assert.deepEqual([v.verdict, v.ok, issueFor(v)], ["inconclusive", false, false]);
    assert.equal(decide({ verdict: v.verdict, issueNumber: "7", lastMs: 0, now: NOW }).action, "none");
  }
});

test("retry rule: RUNNING, RUNNING with stale data opens an issue", () => {
  const v = verdictOf([RUNNING, RUNNING], status(35), NOW);
  assert.deepEqual([v.verdict, v.ok, issueFor(v)], ["fail", false, true]);
  assert.match(v.head, /FRESHNESS FAIL: status.json generated 35 min ago/);
  assert.equal(verdictOf([TIMEOUT, TIMEOUT], "", NOW).verdict, "fail"); // status.json unreadable counts as stale
});

test("a PASS with stale status.json is still a failure", () => {
  assert.equal(verdictOf([PASS], status(35), NOW).verdict, "fail");
});
