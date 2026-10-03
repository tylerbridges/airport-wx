// Pure assembly of per-airport results from parsed source data. No I/O and no node: imports, so
// the live relay (worker/worker.mjs, a Cloudflare Worker) can import it as well as poll.mjs and
// global.mjs. Moved here unchanged from poll.mjs (assemble) and global.mjs (computeGlobal); the
// only addition is assemble's optional `over` hook (live relay).
import {
  buildHours, summarize, hoursOutput, compareAirports, parseVisib, ceilingOf, flightCategory, toMs,
} from "./risk.mjs";
import { spcCategoryAt, convectiveSigmetsAt, normalizeAlerts, latestBy } from "./lib.mjs";
import { tcfAt, cwaAt } from "./sources.mjs";
import { classifyCause, causePhrase } from "./cause.mjs";
import { plainMetar, travelerImpact } from "./plain.mjs";

const HOUR = 3600e3;
const ADV_KEYS = ["id", "type", "airport", "issued", "cause", "causeText", "title", "active", "cnx", "start", "end"];

/**
 * status.json airports from parsed sources. over(a) (live relay) may return per-airport values that
 * replace the ones computed here: {faa, alerts, sigmets, spc, tcf, cwa} (already in output shape).
 */
export function assemble({ airports, now, metars, tafs, sigmets, faaParsed, spc, nws, lamp = null, atcscc = null, tcf = null, cwa = null, over = null }) {
  const metarBy = latestBy(metars, "icaoId", "obsTime");
  const tafBy = latestBy(tafs, "icaoId", "issueTime");
  const out = [];
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
      if (f.type === "closure") Object.assign(o, { scope: f.scope, active: f.active, plain: f.plain, runways: f.runways });
      return o;
    });
    const alertsFull = has("alerts") ? o.alerts : nws ? normalizeAlerts(nws[a.iata], now) : [];
    const sigs = has("sigmets") ? o.sigmets : sigmets ? convectiveSigmetsAt(a.lon, a.lat, sigmets, now) : [];
    const spcCat = has("spc") ? o.spc : spc ? spcCategoryAt(a.lon, a.lat, spc) : null;
    const lampSt = lamp?.stations?.[a.icao] || null;
    const adv = (atcscc || []).filter((x) => x.airport === a.iata)
      .map((x) => ({ ...Object.fromEntries(ADV_KEYS.map((k) => [k, x[k] ?? null])), causeLabel: causePhrase(x.cause, x.causeText) }));
    const tcfHere = has("tcf") ? o.tcf : tcf ? tcfAt(a.lon, a.lat, tcf, now) : [];
    const cwaHere = has("cwa") ? o.cwa : cwa ? cwaAt(a.lon, a.lat, cwa, now) : [];

    const hours = buildHours({
      now, tz: a.tz, taf: t, metar: m, faa, sigmet: sigs.length > 0,
      alerts: alertsFull.map((x) => ({ event: x.event, onset: x.onset, ends: x.ends })), spc: spcCat,
      atcscc: adv, lamp: lampSt, tcf: tcfHere, cwa: cwaHere,
    });
    const { now: nowS, peak } = summarize(hours, a.tz);

    out.push({
      iata: a.iata, icao: a.icao, name: a.name, city: a.city, state: a.state, tz: a.tz, lat: a.lat, lon: a.lon,
      now: nowS, peak, hours: hoursOutput(hours),
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
      taf: t ? { raw: t.rawTAF || "", issued: toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null } : null,
      faa,
      atcscc: adv,
      alerts: alertsFull.slice(0, 10).map(({ event, severity, headline, onset, ends }) => ({ event, severity, headline, onset, ends })),
      spc: spcCat,
      sigmets: sigs,
      lamp: lampSt,
      tcf: tcfHere,
      cwa: cwaHere,
    });
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
      e.ti = toMs(t.issueTime) != null ? new Date(toMs(t.issueTime)).toISOString() : null;
    }
    out.set(a.icao, e);
  }
  return out;
}
