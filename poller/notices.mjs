// Nearby FAA flight restrictions and their hourly effects. Pure; shared by build and relay.
import { tfrNear, TFR_CAT, TFR_CAUSE } from "./tfr.mjs";
import { fmtRange, fmtClock, toMs } from "./risk.mjs";

const HOUR = 3600e3;
export const TFR_NM = 30;
export const MAX_ITEMS = 20;
const ORDER = { vip: 0, space: 1 };

/** "2–4 PM" for a TFR window in the airport's zone ("until 4 PM" when it started already, "from 2 PM" open-ended). */
function windowWords(from, to, tz, now) {
  const f = from ?? -Infinity, t = to ?? Infinity;
  if (f <= +now && Number.isFinite(t)) return t - +now <= 24 * HOUR ? `until ${fmtClock(t, tz, now)}` : `until ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(t))}`;
  if (f > +now && Number.isFinite(t)) return fmtRange(f, t, tz, now);
  if (f > +now) return `from ${fmtClock(f, tz, now)}`;
  return "";
}

const TFR_TEXT = {
  VIP: (w) => ({ reason: `VIP movement — brief ground holds possible${w ? " " + w : ""}`, text: `VIP movement nearby: flight restrictions${w ? " " + w : ""} — brief ground holds are possible.` }),
  SPACE: (w) => ({ reason: `Space launch nearby — airspace restrictions${w ? " " + w : ""}`, text: `Space launch or reentry nearby: airspace restrictions${w ? " " + w : ""} — some flights may be rerouted.` }),
  SECURITY: (w) => ({ reason: null, text: `Security flight restrictions nearby${w ? " " + w : ""} — airline flights aren't affected.` }),
  STADIUM: (w) => ({ reason: null, text: `Stadium event flight restrictions nearby${w ? " " + w : ""} — airline flights aren't affected.` }),
  AIRSHOW: (w) => ({ reason: null, text: `Air show flight restrictions nearby${w ? " " + w : ""} — airline flights are usually not affected.` }),
  HAZARDS: (w) => ({ reason: null, text: `Flight restrictions over a hazard area nearby (such as a fire)${w ? " " + w : ""} — airline flights aren't affected.` }),
  SPECIAL: (w) => ({ reason: null, text: `Temporary flight restrictions nearby${w ? " " + w : ""} — airline flights are usually not affected.` }),
};

/** A TFR near the airport -> notice item (or null when it doesn't touch the next 24 hours or is long-standing). */
export function tfrItem(t, a, { tz = a.tz || "UTC", now = new Date(), nm = TFR_NM } = {}) {
  const near = tfrNear(a.lon, a.lat, t, nm);
  if (!near) return null;
  const end = near.windows.some((w) => w[1] == null) ? null : Math.max(...near.windows.map((w) => w[1]));
  const start = Math.min(...near.windows.map((w) => w[0] ?? -Infinity));
  if (end != null && end <= +now) return null;
  if (start > +now + 24 * HOUR) return null; // later than the forecast window
  const cur = near.windows.find((w) => (w[1] == null || w[1] > +now)) || near.windows[0];
  const level = t.type === "VIP" ? 2 : t.type === "SPACE" ? 1 : 0;
  // long-standing information-only TFRs (no end, or 90+ days) add noise: keep only the ones that affect flights
  if (!level && (end == null || end - (Number.isFinite(start) ? start : +now) > 90 * 24 * HOUR)) return null;
  const words = windowWords(cur[0], cur[1], tz, now);
  const { reason, text } = (TFR_TEXT[t.type] || TFR_TEXT.SPECIAL)(words);
  const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
  return {
    id: "TFR " + (t.id || "?"), src: "tfr", kind: t.type.toLowerCase(), cat: TFR_CAT[t.type] || "vip", cause: TFR_CAUSE[t.type] || "other",
    level, at: level ? "span" : "none", reason, text, nm: near.nm,
    from: iso(Number.isFinite(start) ? start : null), to: iso(end), win: near.windows.map(([x, y]) => [iso(x), iso(y)]),
    raw: t.text || null, type: t.typeText || t.type,
  };
}

/** Nearby flight restrictions, or null when the source is unavailable. */
export function noticesFor({ a, tfrs = null, now = new Date() }) {
  if (tfrs == null) return null;
  const items = tfrs.map((t) => tfrItem(t, a, { now })).filter(Boolean);
  const out = [...new Map(items.map((x) => [x.id, x])).values()].sort(compareNotices(now));
  return { items: out.slice(0, MAX_ITEMS), count: out.length };
}

/** Most important first: level, then what (closures, VIP, runways …), then active before upcoming. */
export function compareNotices(now = new Date()) {
  const act = (x) => (toMs(x.from) ?? -Infinity) <= +now;
  return (x, y) => (y.peak ?? y.level) - (x.peak ?? x.level) || (ORDER[x.kind] ?? 20) - (ORDER[y.kind] ?? 20) || (act(y) ? 1 : 0) - (act(x) ? 1 : 0) || (toMs(x.from) ?? 0) - (toMs(y.from) ?? 0);
}

/** Apply active VIP/space restrictions to forecast hours; information-only items never raise risk. */
export function applyNotices(hours, notices, { now = new Date() } = {}) {
  const items = (notices?.items || []).filter((x) => x.src === "tfr");
  for (const x of items) x.peak = 0;
  for (const h of hours) {
    const start = +new Date(h.t), end = start + HOUR;
    for (const x of items) {
      if (x.at !== "span" || !x.reason) continue;
      const windows = x.win?.length ? x.win : [[x.from, x.to]];
      if (!windows.some(([f, t]) => (toMs(f) ?? -Infinity) < end && (toMs(t) ?? Infinity) > start)) continue;
      h.items.push({ level: x.level, text: x.reason, fixed: true });
      h.level = Math.max(h.level, x.level);
      x.peak = Math.max(x.peak, x.level);
    }
  }
  items.sort(compareNotices(now));
  return hours;
}
