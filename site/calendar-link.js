// This connection stays in this browser. Only the private POST relay reads the source calendar.
import { privacyProblems } from "./trip-risk.js?v=5";
export const CALENDAR_KEY = "awx-calendar-link";
export function loadConnection(storage = localStorage) {
  try {
    const v = JSON.parse(storage.getItem(CALENDAR_KEY));
    if (typeof v?.url !== "string" || v.url.length > 3000 || !/^https?:\/\/|^webcal:\/\//i.test(v.url) || privacyProblems(v.doc).length || !Array.isArray(v.doc?.trips)) return null;
    return { url: v.url, doc: v.doc };
  } catch { return null; }
}
export function saveConnection(value, storage = localStorage) {
  try { if (value) storage.setItem(CALENDAR_KEY, JSON.stringify(value)); else storage.removeItem(CALENDAR_KEY); return true; }
  catch { return false; }
}
export async function fetchCalendar(url, { fetcher = fetch } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const cfg = await fetcher("./data/config.json", { cache: "no-store", signal: ctl.signal }).then(r => r.ok ? r.json() : null);
    if (!cfg?.liveUrl || !/^https:\/\//.test(cfg.liveUrl)) throw new Error("Calendar connection is temporarily unavailable. You can still import a calendar file.");
    const r = await fetcher(cfg.liveUrl.replace(/\/+$/, "") + "/calendar", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal,
    });
    const doc = await r.json().catch(() => null);
    if (!r.ok) throw new Error(typeof doc?.error === "string" && doc.error.length < 400 ? doc.error : "Calendar connection is temporarily unavailable. Try again later.");
    if (!doc?.ok || !Array.isArray(doc.trips) || privacyProblems(doc).length) throw new Error("Couldn't read a valid flight schedule from this calendar.");
    return doc;
  } finally { clearTimeout(timer); }
}
