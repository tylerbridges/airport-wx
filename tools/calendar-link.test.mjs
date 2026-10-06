import test from "node:test";
import assert from "node:assert/strict";
import { fetchCalendar } from "../site/calendar-link.js";

test("disabling flights aborts calendar reads before a private POST", async () => {
  const ctl = new AbortController(), calls = [];
  const request = fetchCalendar("https://example.invalid/private", { signal: ctl.signal, fetcher: async (url, opts) => {
    calls.push(url);
    assert.equal(opts.signal.aborted, false);
    ctl.abort();
    return { ok: true, json: async () => ({ liveUrl: "https://relay.invalid" }) };
  } });
  await assert.rejects(request, { name: "AbortError" });
  assert.deepEqual(calls, ["./data/config.json"]);
});

test("disabling flights aborts an already running calendar POST", async () => {
  const ctl = new AbortController();
  let started;
  const postStarted = new Promise(resolve => { started = resolve; });
  const request = fetchCalendar("https://example.invalid/private", { signal: ctl.signal, fetcher: async (url, opts) => {
    if (url === "./data/config.json") return { ok: true, json: async () => ({ liveUrl: "https://relay.invalid" }) };
    started();
    return new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
  } });
  await postStarted;
  ctl.abort();
  await assert.rejects(request, { name: "AbortError" });
});
