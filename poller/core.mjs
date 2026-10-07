// Pure assembly of per-airport results from parsed source data. No I/O and no node: imports, so
// the live relay (worker/worker.mjs, a Cloudflare Worker) can import it as well as poll.mjs and
// global.mjs. Moved here unchanged from poll.mjs (assemble) and global.mjs (computeGlobal); the
// only addition is assemble's optional `over` hook (live relay).
import {
  buildHours, buildObsHour, summarize, hoursOutput, compareAirports, parseVisib, ceilingOf, flightCategory, toMs, fmtClock, tzAbbr, opsPlanItems,
} from "./risk.mjs";
import { spcCategoryAt, convectiveSigmetsAt, normalizeAlerts, latestBy } from "./lib.mjs";
import { tcfAt, cwaAt } from "./sources.mjs";
import { classifyCause, causePhrase } from "./cause.mjs";
import { plainMetar, travelerImpact } from "./plain.mjs";
import { opsPlanFor } from "./opsplan.mjs";
import { scoreHours, HUBS } from "./delay.mjs"; // phase3 hook: delay model (README "Delay model")
import { cascades, TOP_ROUTES, sameTracon } from "./hubs.mjs"; // hubs hook: hub cascade warnings (README "Hub cascade")
import { sigmetAdvisoriesAt } from "./aviation-advisories.mjs";
import { noticesFor, applyNotices } from "./notices.mjs"; // restrictions hook: FAA TFRs (README "Notices")

import { tafPeriods } from "./taf-periods.mjs";

const HOUR = 3600e3;
const ADV_KEYS = ["id", "type", "airport", "issued", "cause", "causeText", "title", "active", "cnx", "start", "end"];

/**
 * status.json airports from parsed sources. over(a) (live relay) may return per-airport values that
 * replace the ones computed here: {faa, alerts, sigmets, spc, tcf, cwa, opsplan} (already in output shape).
 * delay (phase3, optional): {model, fallback, analogs: {IATA: table}, icaoOf: {IATA: ICAO}, hubTaf(iata)}
 * adds hours[].delay (poller/delay.mjs scoreHours); hub TAFs come from `tafs`, else delay.hubTaf.
 * hubsFrom (hubs hook, optional): status.json airports (e.g. the last build) used as hub-cascade sources
 * for hubs not in `airports` (the live relay assembles only the requested airports).
 * notices (restrictions hook, optional): {tfrs: parsed | null}
 * adds airports[].notices (poller/notices.mjs); over(a).notices (the build's) replaces it.
 */
export function assemble({ airports, now, metars, tafs, sigmets, isigmets = null, faaParsed, spc, nws, lamp = null, atcscc = null, tcf = null, cwa = null, plan = null, over = null, delay = null, hubsFrom = null, notices = null }) {
  const metarBy = latestBy(metars, "icaoId", "obsTime");
  const tafBy = latestBy(tafs, "icaoId", "issueTime");
  const validTaf = (x) => (x && !(toMs(x.validTimeTo) != null && toMs(x.validTimeTo) < +now) ? x : null);
  const out = [];
  const known = new Set(airports.map((a) => a.iata));
  for (const a of airports) {
    const o = (over && over(a)) || {}; // live relay
    const has = (k) => o[k] !== undefined;
    let m = metarBy.get(a.icao) || null;
    const obsMs = m ? toMs(m.obsTime) : null;
    if (m && obsMs != null && +now - obsMs > 2 * 3600e3) m = null; // stale
    let t = tafBy.get(a.icao) || null;
    if (t && toMs(t.validTimeTo) != null && toMs(t.validTimeTo) < +now) t = null;

    const faa = has("faa") ? o.faa : (faaParsed?.byAirport[a.iata] || []).map((f) => {
      const cause = classifyCause(f.reason);
      // closures' reasons are NOTAM text: the page shows their plain-English summary instead
      const o = { type: f.type, reason: f.reason, detail: f.detail, badge: f.badge, cause, causeLabel: f.type === "closure" ? "" : causePhrase(cause, f.reason) };
      if (f.type === "closure") Object.assign(o, { scope: f.scope, active: f.active, plain: f.plain, runways: f.runways, start: f.start ?? null, end: f.end ?? null, ...(f.perm ? { perm: true } : {}) });
      else Object.assign(o, { end: f.end ?? null, trend: f.trend ?? null });
      return o;
    });
    const alertsFull = has("alerts") ? o.alerts : nws ? normalizeAlerts(nws[a.iata], now) : [];
    const sigs = has("sigmets") ? o.sigmets : sigmets ? convectiveSigmetsAt(a.lon, a.lat, sigmets, now) : [];
    const aviationAdvisories = has("aviationAdvisories") ? (o.aviationAdvisories || []).filter((x) => toMs(x.to) > +now && toMs(x.from) < +now + 24 * 3600e3) : [...sigmetAdvisoriesAt(a.lon, a.lat, sigmets, now, "sigmet"), ...sigmetAdvisoriesAt(a.lon, a.lat, isigmets, now)];
    const spcCat = has("spc") ? o.spc : spc ? spcCategoryAt(a.lon, a.lat, spc) : null;
    const lampSt = lamp?.stations?.[a.icao] || null;
    const adv = (atcscc || []).filter((x) => x.airport === a.iata)
      .map((x) => ({ ...Object.fromEntries(ADV_KEYS.map((k) => [k, x[k] ?? null])), causeLabel: causePhrase(x.cause, x.causeText) }));
    const tcfHere = has("tcf") ? o.tcf : tcf ? tcfAt(a.lon, a.lat, tcf, now) : [];
    const cwaHere = has("cwa") ? o.cwa : cwa ? cwaAt(a.lon, a.lat, cwa, now) : [];
    const op = has("opsplan") ? o.opsplan : opsPlanFor(plan, a.iata, now, known);
    // NAS status wins over the ops plan for the same program; when NAS gives no end, take the plan's
    for (const f of faa) {
      if (f.end || !(f.type === "ground_stop" || f.type === "ground_delay")) continue;
      const want = f.type === "ground_stop" ? "GS" : "GDP";
      const p = (op?.programs || []).find((x) => x.status === "active" && x.program === want && x.until);
      if (p) {
        f.end = p.until;
        f.endFrom = "opsplan";
        f.detail = [f.detail, `until ${fmtClock(p.until, a.tz, now)} ${tzAbbr(p.until, a.tz)}`].filter(Boolean).join(", ");
      }
    }

    const hourArgs = {
      now, tz: a.tz, taf: t, metar: m, faa, sigmet: sigs.length > 0,
      alerts: alertsFull.map((x) => ({ event: x.event, onset: x.onset, ends: x.ends })), spc: spcCat,
      atcscc: adv, lamp: lampSt, tcf: tcfHere, cwa: cwaHere, opsplan: op,
    };
    const hours = buildHours(hourArgs);
    // hour 1 with the observation winning (README "The observed next hour"): shown by the page in place of hours[1]
    // once that hour has begun and the METAR is still fresh, so a build seen after the top of the hour never says
    // "Now · Dense fog" from the TAF next to a clear observation
    const obs = buildObsHour(hourArgs);
    // restrictions hook: nearby TFRs (README "Notices") add their reasons to the hours
    const nt = has("notices") ? (o.notices ? { ...o.notices, items: (o.notices.items || []).filter((x) => x.src === "tfr").map((x) => ({ ...x })) } : null)
      : notices ? noticesFor({ a, tfrs: notices.tfrs, faa, opsplan: op, now }) : null;
    if (nt) applyNotices(obs ? [...hours, obs] : hours, nt, { faa, opsplan: op, tz: a.tz, now }); // obs has hour 1's window: same peaks
    // plain-English items for the sheet ("From the FAA Command Center"), same texts as the risk reasons
    const opOut = op
      ? { ...op, items: opsPlanItems(op, { faa, atcscc: adv, tz: a.tz, now }).map(({ kind, level, text, cause, until, raw, dup, ifr, constraint }) => ({ kind, level, text, cause, until, raw, dup, ifr, constraint })) }
      : null;
    const { now: nowS, peak } = summarize(hours, a.tz);
    // phase3 hook: chance of a real delay per hour (FAA programs override; README "Delay model")
    const delayArgs = delay ? {
      iata: a.iata, tz: a.tz, now, taf: t, metar: m, lamp: lampSt, faa, atcscc: adv, opsplan: op,
      hubTafs: (HUBS[a.iata] || []).map((h) => validTaf(tafBy.get(delay.icaoOf?.[h])) || validTaf(delay.hubTaf?.(h))).filter(Boolean),
      model: delay.model, fallback: delay.fallback, analogs: delay.analogs?.[a.iata] || null,
    } : null;
    const dl = delayArgs ? scoreHours({ ...delayArgs, hours }) : null;
    const hoursOut = hoursOutput(hours);
    if (dl) hoursOut.forEach((h, i) => { if (dl[i]) h.delay = dl[i]; });
    // the observed hour 1 is scored at index 1 (as hour 1, not as hour 0: delay.mjs overrides() treats index 0 as
    // "happening now" whatever a program's end), with the same features as hours[1]
    let obsNext = null;
    if (obs) {
      obsNext = hoursOutput([obs])[0];
      const od = delayArgs && hours.length > 1 ? scoreHours({ ...delayArgs, hours: [hours[0], obs] })[1] : null;
      if (od) obsNext.delay = od;
    }

    out.push({
      iata: a.iata, icao: a.icao, name: a.name, city: a.city, state: a.state, tz: a.tz, lat: a.lat, lon: a.lon,
      now: nowS, peak, hours: hoursOut,
      ...(obsNext ? { obsNext } : {}),
      metar: m
        ? {
            raw: m.rawOb || "",
            obsTime: obsMs != null ? new Date(obsMs).toISOString() : null,
            fltCat: m.fltCat || flightCategory(parseVisib(m.visib), ceilingOf(m.clouds)),
            wind: { dir: m.wdir ?? null, spd: m.wspd ?? null },
            gust: m.wgst ?? null,
            visib: parseVisib(m.visib),
            ceiling: ceilingOf(m.clouds),
            wx: m.wxString || null,
            temp: m.temp ?? null,
            dewp: m.dewp ?? null,
          }
        : null,
      taf: t ? { periods: tafPeriods(t), raw: t.rawTAF || "", issued: toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null } : null,
      faa,
      atcscc: adv,
      alerts: alertsFull.slice(0, 10).map(({ event, severity, headline, onset, ends }) => ({ event, severity, headline, onset, ends })),
      spc: spcCat,
      sigmets: sigs,
      aviationAdvisories,
      lamp: lampSt,
      tcf: tcfHere,
      cwa: cwaHere,
      opsplan: opOut,
      ...(nt ? { notices: { items: nt.items.filter((x) => x.src === "tfr"), count: nt.items.filter((x) => x.src === "tfr").length } } : {}), // restrictions hook
    });
  }
  // hubs hook: research-only network exposure; keep live levels and probability estimates unchanged
  const mine = new Set(out.map((e) => e.iata));
  const from = new Map((hubsFrom || []).filter((b) => b && Array.isArray(b.hours) && b.hours.length).map((b) => [b.iata, b]));
  // without delay scoring here (relay without model files) a hub's delay numbers come from hubsFrom, as the relay shows them
  const withDelay = (e) => {
    const b = from.get(e.iata);
    if (!b || e.hours.every((h) => h.delay)) return e;
    const bd = new Map(b.hours.map((h) => [h.t, h.delay]));
    return { ...e, hours: e.hours.map((h) => (h.delay || !bd.get(h.t) ? h : { ...h, delay: bd.get(h.t) })) };
  };
  const researchAirports = [...out.map(withDelay), ...[...from.values()].filter((b) => !mine.has(b.iata))];
  const researchBy = new Map(researchAirports.map(a => [a.iata, a]));
  const notes = cascades(researchAirports);
  // Research only: archive exposures and negative cases without changing any live risk or delay score.
  for (const e of out) {
    const candidates = (TOP_ROUTES[e.iata] || []).filter(hub => hub !== e.iata && !sameTracon(hub, e.iata));
    if (!candidates.length) continue;
    e.hubResearch = {
      version: 1, routeBasis: "approximate-top-routes", lagHours: [1, 4],
      hubs: candidates.map(hub => {
        const a = researchBy.get(hub);
        return { hub, available: !!a?.hours?.length,
          metarAt: a?.metar?.obsTime ?? null, tafIssued: a?.taf?.issued ?? null };
      }),
      signalCount: (notes.get(e.iata) || []).length,
      signals: (notes.get(e.iata) || []).map(({ i, hub, kind }) => ({ t: e.hours[i].t, hub, kind })),
    };
  }
  out.sort(compareAirports);
  return out;
}

// ---------- global shards (searched airports) ----------

const METAR_MAX_AGE = 2 * HOUR;

function latest(list, key, timeKey) {
  const m = new Map();
  for (const r of list) {
    const k = r[key];
    if (!k) continue;
    const prev = m.get(k);
    if (!prev || (toMs(r[timeKey]) ?? 0) >= (toMs(prev[timeKey]) ?? 0)) m.set(k, r);
  }
  return m;
}

/**
 * airports: [{icao, tz}] -> Map(icao -> compact entry)
 *   {n: now level, p: peak level, pt: peak hour ISO, h: "0123…" (24 hourly levels, "-" = no data), r: top reason,
 *    pl: plain-English now, im: traveler impact, c: flight category,
 *    m: METAR raw, mt: METAR time ISO, t: TAF raw, ti: TAF issue ISO}
 */
export function computeGlobal({ airports, metars, tafs, now = new Date() }) {
  const mBy = latest(metars || [], "icaoId", "obsTime");
  const tBy = latest(tafs || [], "icaoId", "issueTime");
  const out = new Map();
  for (const a of airports) {
    if (!a.icao || out.has(a.icao)) continue;
    let m = mBy.get(a.icao) || null;
    const obsMs = m ? toMs(m.obsTime) : null;
    if (m && (obsMs == null || +now - obsMs > METAR_MAX_AGE)) m = null;
    let t = tBy.get(a.icao) || null;
    if (t && toMs(t.validTimeTo) != null && toMs(t.validTimeTo) < +now) t = null;
    if (!m && !t) continue;
    const tz = a.tz || "UTC";
    let hours;
    try {
      hours = buildHours({ now, tz, taf: t, metar: m });
    } catch {
      continue; // unknown zone name or malformed report: skip rather than fail the run
    }
    const s = summarize(hours, tz);
    const e = {
      n: s.now.level,
      p: s.peak.level,
      pt: s.peak.at,
      h: hours.map((x) => (x.fltCat ? x.level : "-")).join(""), // "-" = hour not covered by a METAR or TAF
      r: s.peak.reasons[0] || "",
      c: m ? flightCategory(parseVisib(m.visib), ceilingOf(m.clouds)) : hours[0].fltCat || null,
    };
    if (m) {
      e.pl = plainMetar(m);
      e.im = travelerImpact(s.now.level, m);
      e.m = m.rawOb;
      e.mt = new Date(obsMs).toISOString();
    }
    if (t) {
      e.t = t.rawTAF;
      e.tp = tafPeriods(t);
      e.ti = toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null;
    }
    out.set(a.icao, e);
  }
  return out;
}
