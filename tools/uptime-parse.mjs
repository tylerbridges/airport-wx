#!/usr/bin/env node
// Helpers for .github/workflows/uptime.yml (the HTTP calls are curl in the workflow).
//   node tools/uptime-parse.mjs check <dom.html> <status.json> [nowISO]
//       -> prints JSON {ok, head, pageOk, freshOk, ageMin, report}; exit 0 either way
//   node tools/uptime-parse.mjs verdict <attempts.json> <status.json> [nowISO]
//       -> attempts.json = [{text, error?}, …] (the #result text from each Playwright attempt, null on timeout);
//          prints JSON {verdict: pass|fail|inconclusive, ok, head, report, …}; exit 0 either way
//   node tools/uptime-parse.mjs find-issue <issues.json>         -> open "Uptime: check failing" issue number, or ""
//   node tools/uptime-parse.mjs last-activity <issue.json> <comments.json>  -> epoch ms of the issue's latest bot activity
//   node tools/uptime-parse.mjs body <text-file>                 -> {"body": "..."} JSON for the REST API
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "Uptime: check failing";
export const FRESH_MAX_MIN = 20;
export const COMMENT_EVERY_MS = 6 * 3600e3;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeHtml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Text of <pre id="result"> from a --dump-dom page, or null. */
export function resultText(dom) {
  const m = /<pre\b[^>]*\bid=["']?result["']?[^>]*>([\s\S]*?)<\/pre>/i.exec(String(dom || ""));
  return m ? unescapeHtml(m[1]).trim() : null;
}

/** {ok, head, report} from the dumped check page. Anything but a first line "CHECK PASS…" fails. */
export function parsePage(dom) {
  const t = resultText(dom);
  if (t == null) return { ok: false, head: "check page has no #result (page didn't load?)", report: "" };
  const head = t.split("\n")[0];
  if (/^CHECK PASS\b/.test(head)) return { ok: true, head, report: t };
  if (/^CHECK FAIL \d+/.test(head)) return { ok: false, head, report: t };
  return { ok: false, head: `check page did not finish (${head.slice(0, 60)})`, report: t };
}

/** Independent freshness check of data/status.json. */
export function freshness(statusText, now = Date.now()) {
  try {
    const gen = Date.parse(JSON.parse(statusText).generated);
    if (!Number.isFinite(gen)) return { ok: false, ageMin: null, why: "status.json has no generated time" };
    const ageMin = Math.round((now - gen) / 6e4);
    return { ok: ageMin <= FRESH_MAX_MIN, ageMin, why: `status.json generated ${ageMin} min ago` };
  } catch {
    return { ok: false, ageMin: null, why: "status.json missing or not JSON" };
  }
}

export function evaluate(dom, statusText, now = Date.now()) {
  const page = parsePage(dom);
  const fr = freshness(statusText, now);
  const ok = page.ok && fr.ok;
  const head = ok ? `${page.head}; ${fr.why}` : [!page.ok ? page.head : null, !fr.ok ? `FRESHNESS FAIL: ${fr.why} (limit ${FRESH_MAX_MIN} min)` : null].filter(Boolean).join("; ");
  return { ok, head, pageOk: page.ok, freshOk: fr.ok, ageMin: fr.ageMin, report: page.report };
}

/** One Playwright attempt: the #result text (null when it never appeared) -> {state: pass|fail|inconclusive, head, report}.
 *  "CHECK RUNNING", an empty page or a timeout is inconclusive, never a failure by itself. */
export function classifyAttempt(text, error) {
  const t = text == null ? "" : String(text).trim();
  const head = t.split("\n")[0];
  if (/^CHECK PASS\b/.test(head)) return { state: "pass", head, report: t };
  if (/^CHECK FAIL\b/.test(head)) return { state: "fail", head, report: t };
  const why = /CHECK RUNNING/.test(head) ? "check page still running at the time limit" : error ? `check page didn't load (${String(error).slice(0, 80)})` : "check page gave no result in time";
  return { state: "inconclusive", head: why, report: t };
}

/** Retry rule over the attempts (each {text, error?}) plus the independent status.json freshness.
 *  - any attempt PASS (and status.json fresh)        -> pass   (FAIL then PASS is recovered: no issue)
 *  - every attempt FAIL                              -> fail   (issue)
 *  - otherwise (inconclusive, or FAIL + inconclusive) -> fail only when status.json is stale, else inconclusive (no issue)
 *  A PASS with stale status.json is a fail, as before. */
export function verdictOf(attempts, statusText, now = Date.now()) {
  const list = (Array.isArray(attempts) ? attempts : []).map((a) => classifyAttempt(a && a.text, a && a.error));
  const fr = freshness(statusText, now);
  const stale = `FRESHNESS FAIL: ${fr.why} (limit ${FRESH_MAX_MIN} min)`;
  const trail = list.map((a, i) => `attempt ${i + 1}: ${a.head}`).join("; ");
  const last = list[list.length - 1] || { head: "no attempts ran", report: "" };
  const pass = list.find((a) => a.state === "pass");
  let verdict;
  let head;
  if (pass) {
    verdict = fr.ok ? "pass" : "fail";
    head = fr.ok ? `${pass.head}; ${fr.why}` : stale;
  } else if (list.length && list.every((a) => a.state === "fail")) {
    verdict = "fail";
    head = trail + (fr.ok ? "" : `; ${stale}`);
  } else if (!fr.ok) {
    verdict = "fail";
    head = `${trail || last.head}; ${stale}`;
  } else {
    verdict = "inconclusive";
    head = `${trail || last.head}; ${fr.why}`;
  }
  const report = (list.filter((a) => a.state === "fail").pop() || pass || last).report;
  return { verdict, ok: verdict === "pass", head, pageOk: !!pass, freshOk: fr.ok, ageMin: fr.ageMin, attempts: list.map((a) => a.state), report };
}

export function findIssue(issues) {
  const hit = (Array.isArray(issues) ? issues : []).find((i) => i && i.title === ISSUE_TITLE && i.state === "open" && !i.pull_request);
  return hit ? String(hit.number) : "";
}

/** Latest of the issue's creation and comments by the workflow's bot. */
export function lastActivity(issue, comments) {
  let t = Date.parse(issue?.created_at) || 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (c?.user?.login === "github-actions[bot]" || c?.user?.type === "Bot") t = Math.max(t, Date.parse(c.created_at) || 0);
  }
  return t;
}

/** What to do: {action: none|open|comment|close} */
export function decide({ ok, verdict, issueNumber, lastMs, now = Date.now() }) {
  if (verdict === "inconclusive") return { action: "none" }; // not a failure, not a recovery: leave any open issue alone
  if (verdict ? verdict === "pass" : ok) return { action: issueNumber ? "close" : "none" };
  if (!issueNumber) return { action: "open" };
  return { action: now - lastMs >= COMMENT_EVERY_MS ? "comment" : "none" };
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  if (cmd === "check") {
    console.log(JSON.stringify(evaluate(read(a), read(b), c ? Date.parse(c) : Date.now())));
  } else if (cmd === "verdict") {
    let at = [];
    try { at = JSON.parse(read(a)); } catch { /* none */ }
    console.log(JSON.stringify(verdictOf(at, read(b), c ? Date.parse(c) : Date.now())));
  } else if (cmd === "find-issue") {
    let j = [];
    try { j = JSON.parse(read(a)); } catch { /* none */ }
    console.log(findIssue(j));
  } else if (cmd === "last-activity") {
    let i = {};
    let cs = [];
    try { i = JSON.parse(read(a)); } catch { /* none */ }
    try { cs = JSON.parse(read(b)); } catch { /* none */ }
    console.log(String(lastActivity(i, cs)));
  } else if (cmd === "body") {
    console.log(JSON.stringify({ body: read(a).slice(0, 60000) }));
  } else {
    console.error("usage: uptime-parse.mjs check|verdict|find-issue|last-activity|body …");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
