import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { calendarUrl, readCalendar } from "./calendar.mjs";
import { privacyProblems } from "../poller/trip-risk.mjs";
import { default as worker } from "./worker.mjs";
import { loadConnection, saveConnection, fetchCalendar } from "../site/calendar-link.js";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const url = "https://p123-caldav.icloud.com/published/2/private-calendar-token";
const airports = [{ iata: "MSP", tz: "America/Chicago" }, { iata: "LHR", tz: "Europe/London" }];
const origin = "https://tylerbridges.github.io";
const calendarAt = Date.now(); // Stable schedule across requests; personal fields alone should change.
function calendar(summary = "Jane Doe DL 1234 · MSP → LHR", cancelled = false) {
  const dep = new Date(calendarAt + 3600e3).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
  const arr = new Date(calendarAt + 9 * 3600e3).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
  return `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:private-person@example.com\nSUMMARY:${summary}\nDESCRIPTION:Confirmation SECRET123 Seat 2A\nDTSTART:${dep}\nDTEND:${arr}\n${cancelled ? 'STATUS:CANCELLED\n' : ''}END:VEVENT\nEND:VCALENDAR`;
}
const request = (link = url, options = {}) => new Request("https://relay.test/calendar", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ url: link }), ...options });
async function read(stub, link = url) {
  const before = globalThis.fetch; globalThis.fetch = stub;
  try { return await readCalendar(request(link), airports, origin, {}); }
  finally { globalThis.fetch = before; }
}

test("calendar links allow known subscription providers and reject arbitrary destinations, credentials and share pages", () => {
  assert.equal(calendarUrl(url.replace("https:", "webcal:")), url);
  assert.equal(calendarUrl("https://calendar.google.com/calendar/ical/test%40gmail.com/public/basic.ics"), "https://calendar.google.com/calendar/ical/test%40gmail.com/public/basic.ics");
  for (const link of ["http://p123-caldav.icloud.com/published/2/x", "https://127.0.0.1/secret", "https://p123-caldav.icloud.com.evil.test/published/2/x", "https://p123-caldav.icloud.com:8443/published/2/x", "https://user:pass@p123-caldav.icloud.com/published/2/x", "https://flighty.app/share/secret", url + "#secret"]) assert.equal(calendarUrl(link), null, link);
});
test("private calendar response strips identifiers, remains uncached and reflects schedule removals", async () => {
  const first = await read(async (_, opts) => { assert.equal(opts.redirect, "manual"); return new Response(calendar()); });
  assert.equal(first.headers.get("Cache-Control"), "private, no-store");
  const doc = await first.json(); assert.equal(doc.flights, 1); assert.deepEqual(privacyProblems(doc), []);
  const serialized = JSON.stringify(doc); for (const secret of ["Jane", "SECRET123", "example.com", "private-calendar-token", "DL 1234", "2A"]) assert.equal(serialized.includes(secret), false);
  const renamed = await (await read(async () => new Response(calendar("Someone Else UA 999 · MSP → LHR")))).json();
  assert.equal(renamed.trips[0].id, doc.trips[0].id, "stable identity does not use personal calendar UID or text");
  const cancelled = await (await read(async () => new Response(calendar(undefined, true)))).json(); assert.equal(cancelled.flights, 0);
});
test("calendar relay blocks cross-origin reads and bounds request/upstream size, redirects, and errors", async () => {
  const denied = await worker.fetch(request(url, { headers: { "Content-Type": "application/json", Origin: "https://evil.test" } })); assert.equal(denied.status, 403);
  const preflight = await worker.fetch(new Request("https://relay.test/calendar", { method: "OPTIONS", headers: { Origin: origin } })); assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
  const redirect = await read(async () => new Response(null, { status: 302, headers: { Location: "http://localhost/private" } })); assert.equal(redirect.status, 502);
  const tooBig = await read(async () => new Response("x".repeat(1024 * 1024 + 1))); assert.equal(tooBig.status, 502);
  const html = await read(async () => new Response("<html>Private Name</html>")); assert.equal(html.status, 422);
  const failed = await read(async () => { throw new Error(url); }); assert.equal(JSON.stringify(await failed.json()).includes(url), false);
  const bad = await readCalendar(request(url, { body: "x".repeat(4097) }), airports, origin, {}); assert.equal(bad.status, 400);
});
test("device connections isolate URLs from public requests and retain only sanitized schedules", async () => {
  const stored = new Map(), storage = { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) };
  const doc = await (await read(async () => new Response(calendar()))).json();
  assert.equal(saveConnection({ url, doc }, storage), true); assert.equal(loadConnection(storage).url, url);
  const calls = [];
  await fetchCalendar(url, { fetcher: async (input, opts) => {
    calls.push({ input, opts });
    return new Response(JSON.stringify(calls.length === 1 ? { liveUrl: "https://relay.test" } : doc));
  } });
  assert.equal(calls[1].input, "https://relay.test/calendar"); assert.equal(calls[1].opts.method, "POST"); assert.equal(calls[1].opts.credentials, "omit"); assert.equal(calls[1].opts.referrerPolicy, "no-referrer"); assert.equal(calls.some(x => x.input.includes(url)), false);
  saveConnection({ url, doc: { ...doc, owner: "Jane" } }, storage); assert.equal(loadConnection(storage), null);
  saveConnection(null, storage); assert.equal(loadConnection(storage), null);
});
