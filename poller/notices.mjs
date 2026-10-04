// Notices (README "Notices"): an airport's NOTAMs and nearby TFRs as plain-English items, deduped
// against the FAA NAS status and the ops plan, and their effect on each forecast hour. Pure (no network,
// no node: imports): core.mjs assemble() uses it for the build and the live relay. Tested in notams.test.mjs.
//
//   noticesFor({a, notams, tfrs, runways, faa, opsplan, now}) -> {items, runways, count} | null
//   applyNotices(hours, notices, {faa, opsplan, tz, now})   adds reasons to risk.mjs buildHours() rows
//
// Rules (README "Risk levels"):
//   runway closure    Low; Moderate in hours when more than half the runways are closed, or when the closed
//                     runways include every runway lined up with the wind (wind 10 kt+ or gusts 15 kt+)
//   airport closed    Severe (all runways / "AD AP CLSD" without qualifiers), as the NAS status closure
//   ILS/glideslope    Low only in IFR/LIFR hours
//   VIP TFR           Moderate ("VIP movement — brief ground holds possible 2–4 PM") within 30 nm
//   space operations  Low within 30 nm
//   other TFRs, taxiways, construction, lighting, de-icing, other NOTAMs: information only
// A NOTAM the NAS status or the ops plan already reports (same runway closure, same ILS, a full closure) is
// marked dup and adds no Low reason; it still counts for the Moderate runway rules.
import { notamsFor, notamItem, activeIn, stretchEnd, untilWords, runwayNames } from "./notams.mjs";
import { tfrNear, TFR_CAT, TFR_CAUSE } from "./tfr.mjs";
import { fmtRange, fmtClock, toMs } from "./risk.mjs";

const HOUR = 3600e3;
export const TFR_NM = 30;
export const MAX_ITEMS = 20;
const ORDER = { closure: 0, vip: 1, runway: 2, space: 3, ils: 4, security: 5, stadium: 5, taxiway: 6, deice: 7, construction: 8, lighting: 9, hazards: 10, airshow: 10, special: 10, limited: 11, other: 12 };
const normRwy = (r) => String(r || "").toUpperCase().replace(/(^|\/)0(\d)/g, "$1$2");
/** Runway pair ids "4L/22R" -> its two ends. */
const ends = (id) => normRwy(id).split("/").filter(Boolean);

/** "2–4 PM" for a TFR window in the airport's zone ("until 4 PM" when it started already, "from 2 PM" open-ended). */
function windowWords(from, to, tz, now) {
  const f = from ?? -Infinity, t = to ?? Infinity;
  if (f <= +now && Number.isFinite(t)) return t - +now <= 24 * HOUR ? `until ${fmtClock(t, tz, now)}` : untilWords(t, tz, now).trim();
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

/**
 * The airport's notices, or null when neither source produced data for it. notams: normalised records
 * (notams.mjs) for any airports, or null (source down); tfrs: parsed TFRs or null; runways: [[ids, heading]].
 */
export function noticesFor({ a, notams = null, tfrs = null, runways = null, faa = [], opsplan = null, now = new Date() }) {
  if (notams == null && tfrs == null) return null;
  const tz = a.tz || "UTC";
  const items = [];
  for (const r of notams ? notamsFor(notams, a) : []) {
    const it = notamItem(r, { tz, now });
    if (it) items.push(it);
  }
  for (const t of tfrs || []) {
    const it = tfrItem(t, a, { tz, now });
    if (it) items.push(it);
  }
  // dedupe against the NAS status and the ops plan
  const nasFull = (faa || []).some((f) => f.type === "closure" && (f.scope || "full") === "full" && f.active !== false);
  const nasRwy = new Set((faa || []).filter((f) => f.type === "closure").flatMap((f) => f.runways || []).flatMap(ends));
  const sirRwy = new Set((opsplan?.sirs || []).filter((s) => s.what === "runway" && (s.status === "closed" || s.status === "construction")).flatMap((s) => s.runways || []).flatMap(ends));
  const sirIls = new Set((opsplan?.sirs || []).filter((s) => s.what === "glideslope" || s.what === "ils").flatMap((s) => s.runways || []).flatMap(ends));
  const limitedNas = (faa || []).some((f) => f.type === "closure" && f.scope === "limited");
  for (const it of items) {
    let dup = false;
    if (it.kind === "closure") dup = nasFull;
    else if (it.kind === "runway") dup = (it.runways || []).every((r) => ends(r).some((e) => nasRwy.has(e) || sirRwy.has(e)));
    else if (it.kind === "ils") dup = (it.runways || []).length > 0 && it.runways.every((r) => sirIls.has(normRwy(r)));
    else if (it.kind === "limited" && !(it.runways || []).length) dup = limitedNas;
    if (dup) it.dup = true;
  }
  // the same runway closed by two NOTAMs (e.g. one per runway end) shows once
  const seen = new Set();
  const out = items.filter((it) => {
    const k = it.kind === "runway" || it.kind === "ils" ? `${it.kind}|${(it.runways || []).join(",")}|${it.sched ? JSON.stringify(it.sched) : ""}` : it.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.sort(compareNotices(now));
  // "other" NOTAMs (obstacles, procedures, frequencies…) are only counted; the rest is capped so status.json stays small
  const kept = out.filter((x) => x.kind !== "other");
  return { items: kept.slice(0, MAX_ITEMS), runways: runways || [], count: kept.length, other: out.length - kept.length };
}

/** Most important first: level, then what (closures, VIP, runways …), then active before upcoming. */
export function compareNotices(now = new Date()) {
  const act = (x) => (toMs(x.from) ?? -Infinity) <= +now;
  return (x, y) => (y.peak ?? y.level) - (x.peak ?? x.level) || (ORDER[x.kind] ?? 20) - (ORDER[y.kind] ?? 20) || (act(y) ? 1 : 0) - (act(x) ? 1 : 0) || (toMs(x.from) ?? 0) - (toMs(y.from) ?? 0);
}

/** Smallest angle (deg) between a wind direction and a runway's axis (either direction). */
function axisAngle(wdir, hdg) {
  const d = Math.abs((((wdir - hdg) % 180) + 180) % 180);
  return Math.min(d, 180 - d);
}

/**
 * Runways best lined up with a wind: the runway pairs within 10° of the best alignment (and within 45°).
 * runways: [[ids, headingTrue]]. Returns [] when the wind is light or variable.
 */
export function alignedRunways(runways, wdir, wspd, wgst) {
  if (!Array.isArray(runways) || !runways.length || wdir == null || wdir === "VRB" || !Number.isFinite(Number(wdir))) return [];
  if (!((Number(wspd) || 0) >= 10 || (Number(wgst) || 0) >= 15)) return [];
  const ang = runways.map(([id, h]) => ({ id: normRwy(id), a: Number.isFinite(Number(h)) ? axisAngle(Number(wdir), Number(h)) : 99 }));
  const best = Math.min(...ang.map((x) => x.a));
  if (best > 45) return [];
  return ang.filter((x) => x.a <= best + 10).map((x) => x.id);
}

const pairClosed = (pairId, closedEnds) => ends(pairId).some((e) => closedEnds.has(e));

/**
 * Adds the notices' reasons to the internal hour rows of risk.mjs buildHours ({t, items, level, fltCat,
 * cond}) and records on each item the highest level it scored (peak) and why (why: "wind" | "most").
 * faa/opsplan: the airport's NAS status entries and ops-plan slice (their runway closures count toward
 * "more than half closed").
 */
export function applyNotices(hours, notices, { faa = [], opsplan = null, tz = "UTC", now = new Date() } = {}) {
  if (!notices || !(notices.items || []).length) return hours;
  const items = notices.items;
  const all = notices.runways || [];
  for (const it of items) { it.peak = 0; delete it.why; delete it.of; }
  const nasEnds = new Set((faa || []).filter((f) => f.type === "closure" && f.active !== false).flatMap((f) => f.runways || []).flatMap(ends));
  const nasFull = (faa || []).some((f) => f.type === "closure" && (f.scope || "full") === "full" && f.active !== false);
  const sirEnds = new Set((opsplan?.sirs || []).filter((s) => s.what === "runway" && s.status === "closed").flatMap((s) => s.runways || []).flatMap(ends));
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    const t0 = +new Date(h.t);
    const t1 = t0 + HOUR;
    const add = (level, text) => { if (text) h.items.push({ level, text, fixed: true }); if (level > h.level) h.level = level; };
    // runway closures, together
    const rw = items.filter((x) => x.at === "rwy" && activeIn(x, t0, t1));
    if (rw.length) {
      const closed = new Set([...rw.flatMap((x) => (x.runways || []).flatMap(ends)), ...nasEnds, ...(i === 0 ? sirEnds : [])]);
      const n = all.length;
      const nClosed = n ? all.filter(([id]) => pairClosed(id, closed)).length : 0;
      const c = h.cond || {};
      const aligned = alignedRunways(all, c.wdir, c.wspd, c.wgst);
      const every = n >= 1 && nClosed === n; // every runway closed = the airport is closed (Severe), unless the NAS status says so already
      const most = !every && n >= 2 && nClosed * 2 > n;
      const wind = !every && !most && aligned.length > 0 && aligned.every((id) => pairClosed(id, closed)) && rw.some((x) => (x.runways || []).some((r) => aligned.some((id) => ends(id).some((e) => ends(r).includes(e)))));
      const level = every ? (nasFull ? 0 : 4) : most || wind ? 2 : 1;
      const fresh = rw.filter((x) => !x.dup);
      const shown = level > 1 ? rw : level === 1 ? fresh : [];
      if (shown.length) {
        const ids = [...new Set(shown.flatMap((x) => x.runways || []))];
        const endAt = Math.min(...shown.map((x) => stretchEnd(x, t0) ?? Infinity));
        const until = shown.length === 1 || every ? untilWords(Number.isFinite(endAt) ? endAt : null, tz, now, shown.length === 1 && !shown[0].to && /PERM/.test(shown[0].raw || "")) : "";
        const tail = most ? ` — ${nClosed} of ${n} runways` : wind ? " — the runway best lined up with the wind" : "";
        add(level, every ? `Airport closed — all runways closed${until}` : `${runwayNames(ids)} closed${until}${tail}`);
        for (const x of shown) {
          if (level > (x.peak || 0)) x.peak = level;
          if (level > 1) x.why = every ? "all" : most ? "most" : "wind";
          if (most) x.of = `${nClosed} of ${n}`;
        }
      }
    }
    for (const x of items) {
      if (x.at === "rwy" || x.at === "none" || x.dup) continue;
      if (!activeIn(x, t0, t1)) continue;
      if (x.at === "span") {
        const text = x.kind === "closure" ? `Airport closed${untilWords(stretchEnd(x, t0), tz, now)}` : x.reason;
        add(x.level, text);
        if (x.level > (x.peak || 0)) x.peak = x.level;
      } else if (x.at === "ifr" && (h.fltCat === "IFR" || h.fltCat === "LIFR")) {
        add(1, x.reason);
        if (1 > (x.peak || 0)) x.peak = 1;
      }
    }
  }
  items.sort(compareNotices(now));
  return hours;
}
