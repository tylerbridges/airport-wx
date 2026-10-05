// Private, stateless calendar reads. Never enter the status cache or the public build.
import { makeLookup, tripsFromIcs } from "../poller/trips.mjs";
const LIMIT = 1024 * 1024;
export const CALENDAR_HELP = "Use the public calendar subscription link from your calendar app. For Flighty, enable Calendar Export in Calendar Sync, then share that calendar. Flight and friend share pages are not supported by this connection.";

export function calendarUrl(raw) {
  if (typeof raw !== "string" || raw.length > 3000) return null;
  try {
    const u = new URL(raw.trim().replace(/^webcal:\/\//i, "https://"));
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return null;
    const icloud = /^p\d+-caldav\.icloud\.com$/.test(u.hostname) && /^\/published\/2\/[^/]+$/.test(u.pathname);
    const google = u.hostname === "calendar.google.com" && /^\/calendar\/ical\/.+\/(?:public|private-[a-zA-Z0-9]+)\/basic\.ics$/.test(u.pathname);
    return icloud || google ? u.href : null;
  } catch { return null; }
}

async function limitedText(stream, limit) {
  if (!stream) throw new Error("empty calendar");
  const reader = stream.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(out);
}

export async function readCalendar(request, airports, origin, cors) {
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", ...cors,
  } });
  if (!origin) return respond({ error: "Open Airports to connect your calendar." }, 403);
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return respond({ error: "Use the calendar connection form." }, 415);
  let body;
  try { body = JSON.parse(await limitedText(request.body, 4096)); }
  catch { return respond({ error: "Paste a calendar subscription link." }, 400); }
  let url = calendarUrl(body?.url);
  if (!url) return respond({ error: CALENDAR_HELP }, 400);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
  try {
    let res;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetch(url, { redirect: "manual", headers: { Accept: "text/calendar" }, signal: ctl.signal });
      if (res.status < 300 || res.status >= 400) break;
      const next = calendarUrl(new URL(res.headers.get("Location") || "", url).href);
      await res.body?.cancel();
      if (!next) throw new Error("unsupported redirect");
      url = next;
    }
    if (!res.ok) throw new Error("calendar unavailable");
    const text = await limitedText(res.body, LIMIT);
    if (!/^\uFEFF?BEGIN:VCALENDAR\s*$/mi.test(text) || !/^END:VCALENDAR\s*$/mi.test(text)) return respond({ error: CALENDAR_HELP }, 422);
    const now = new Date();
    const parsed = tripsFromIcs(text, { now, lookup: makeLookup(airports) });
    const trips = await Promise.all(parsed.trips.map(async t => {
      // Stable route/time IDs contain no event UID or upstream link.
      const bytes = new TextEncoder().encode(JSON.stringify(t.legs));
      const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), x => x.toString(16).padStart(2, "0")).join("");
      return { id, legs: t.legs };
    }));
    return respond({ generated: now.toISOString(), configured: true, ok: true, source: "calendar", trips, count: trips.length, flights: trips.reduce((n, t) => n + t.legs.length, 0) });
  } catch { return respond({ error: "Couldn't read this calendar. Check that sharing is enabled and try again." }, 502); }
  finally { clearTimeout(timer); }
}
