// Deterministic synthetic world for `node tools/train.mjs --fixtures` (and the training tests):
// hourly "true" weather at a few airports, TAFs that forecast it with lead-dependent skill (and the
// real TAFs' habit of over-warning thunder with PROB30/TEMPO groups), METARs, and flights whose
// delays depend on the weather at both ends and at the hub. Everything is emitted in the real
// formats (IEM taf.py row-per-group CSV, IEM asos.py CSV, BTS On-Time CSV, an assumed IEM mos.py
// LAMP CSV) so the real parsers run end to end, plus a history-branch truth log (FAA programs, ops-plan
// "possible" programs and staffing triggers) for its last months. Not real data: reports built from it
// say FIXTURE.
import { dayType } from "../poller/delay.mjs";

const HOUR = 3600e3;
export const FIX_AIRPORTS = [
  { iata: "ORD", icao: "KORD", tz: "America/Chicago" },
  { iata: "MSP", icao: "KMSP", tz: "America/Chicago" },
  { iata: "DEN", icao: "KDEN", tz: "America/Denver" },
  { iata: "EWR", icao: "KEWR", tz: "America/New_York" },
];
export const FIX_HUBS = { ORD: ["EWR"], MSP: ["ORD"], DEN: ["ORD"], EWR: ["ORD"] };
export const FIX_MONTHS = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const S = { CLEAR: 0, LOW: 1, FOG: 2, STORM: 3, SNOW: 4, WIND: 5 };
const dtf = new Map();
function local(ms, tz) {
  let f = dtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); dtf.set(tz, f); }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, h: +o.hour % 24, hm: `${o.hour}${o.minute}`.replace(/^24/, "00"), mo: +o.month };
}
const p2 = (x) => String(x).padStart(2, "0");
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const ddhh = (ms) => p2(new Date(ms).getUTCDate()) + p2(new Date(ms).getUTCHours());
const ddhhEnd = (ms) => (new Date(ms).getUTCHours() === 0 ? p2(new Date(ms - HOUR).getUTCDate()) + "24" : ddhh(ms));

const COND = {
  [S.CLEAR]: { m: "27010KT 10SM FEW050", t: "27010KT P6SM FEW050", vis: 10, wx: "", sky: [["FEW", 5000]], spd: 10, dir: 270, gust: null },
  [S.LOW]: { m: "18008KT 4SM BR OVC008", t: "18008KT 4SM BR OVC008", vis: 4, wx: "BR", sky: [["OVC", 800]], spd: 8, dir: 180, gust: null },
  [S.FOG]: { m: "00000KT 1/2SM FG VV002", t: "00000KT 1/2SM FG VV002", vis: 0.5, wx: "FG", sky: [["VV", 200]], spd: 0, dir: 0, gust: null },
  [S.STORM]: { m: "24015G30KT 2SM +TSRA BKN020CB", t: "24015G30KT 2SM TSRA BKN020CB", vis: 2, wx: "+TSRA", sky: [["BKN", 2000]], spd: 15, dir: 240, gust: 30 },
  [S.SNOW]: { m: "35015G22KT 1SM SN OVC010", t: "35015G22KT 1SM SN OVC010", vis: 1, wx: "SN", sky: [["OVC", 1000]], spd: 15, dir: 350, gust: 22 },
  [S.WIND]: { m: "31026G40KT 10SM SCT040", t: "31026G40KT P6SM SCT040", vis: 10, wx: "", sky: [["SCT", 4000]], spd: 26, dir: 310, gust: 40 },
};

/** Hourly true weather per airport over [start, end): {iata: Uint8Array}. */
function simulateWeather(airports, start, end, rand) {
  const n = Math.round((end - start) / HOUR);
  const out = {};
  const day = new Float64Array(Math.ceil(n / 24) + 2);
  for (let d = 0; d < day.length; d++) day[d] = rand() < 0.3 ? 3 : 0.4; // convective days (shared)
  for (const a of airports) {
    const s = new Uint8Array(n);
    let cur = S.CLEAR;
    for (let i = 0; i < n; i++) {
      const t = start + i * HOUR;
      const L = local(t, a.tz);
      const summer = L.mo >= 6 && L.mo <= 8;
      const winter = L.mo === 12 || L.mo <= 2;
      const shoulder = !summer && !winter;
      if (cur !== S.CLEAR) {
        const endP = { [S.LOW]: 0.15, [S.FOG]: 0.3, [S.STORM]: 0.4, [S.SNOW]: 0.1, [S.WIND]: 0.15 }[cur];
        if (rand() < endP) cur = S.CLEAR;
      } else {
        const aft = L.h >= 13 && L.h <= 20;
        const storm = (summer ? (aft ? 0.03 : 0.006) : shoulder ? (aft ? 0.012 : 0.002) : 0.0005) * day[Math.floor(i / 24)];
        const snow = winter ? 0.012 : L.mo === 3 || L.mo === 11 ? 0.004 : 0;
        const fog = (L.h >= 2 && L.h <= 9 ? 0.012 : 0.002) * (winter || L.mo >= 10 ? 1.5 : 1);
        const low = 0.01;
        const wind = L.mo >= 3 && L.mo <= 5 ? 0.008 : 0.004;
        const r = rand();
        let acc = 0;
        for (const [st, p] of [[S.STORM, storm], [S.SNOW, snow], [S.FOG, fog], [S.LOW, low], [S.WIND, wind]]) {
          acc += p;
          if (r < acc) { cur = st; break; }
        }
      }
      s[i] = cur;
    }
    out[a.iata] = s;
  }
  return out;
}

// ---------- METAR (IEM asos.py CSV) ----------

function metarCsv(a, wx, start, from, to) {
  const lines = ["station,valid,drct,sknt,gust,vsby,skyc1,skyl1,skyc2,skyl2,skyc3,skyl3,wxcodes,metar"];
  const id = a.icao.slice(1);
  for (let t = from; t < to; t += HOUR) {
    const i = Math.round((t - start) / HOUR);
    if (i < 0 || i >= wx.length) continue;
    const c = COND[wx[i]];
    const ob = t + 53 * 60e3;
    const d = new Date(ob);
    const raw = `${a.icao} ${p2(d.getUTCDate())}${p2(d.getUTCHours())}53Z ${c.m} 20/15 A2992 RMK AO2`;
    lines.push([id, iso(ob), c.dir, c.spd, c.gust ?? "M", c.vis.toFixed(2), c.sky[0][0], c.sky[0][1], "M", "M", "M", "M", c.wx || "M", raw].join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------- TAF (IEM taf.py row-per-group CSV, as reports/samples/iem-taf.csv) ----------

const TAF_HEAD = "station,valid,fx_valid,raw,is_tempo,fx_valid_end,sknt,drct,gust,visibility,presentwx,skyc,skyl,ws_level,ws_drct,ws_sknt,product_id,ftype,is_amendment";
const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);

/** Forecast state for hour i at lead leadH: right with skill falling with lead; else a miss or a false alarm. */
function forecastState(truth, i, leadH, L, rand) {
  const skill = Math.max(0.45, 0.9 - 0.02 * leadH);
  if (rand() < skill) return truth;
  if (truth !== S.CLEAR) return rand() < 0.6 ? S.CLEAR : truth;
  const summerAft = L.mo >= 6 && L.mo <= 8 && L.h >= 12 && L.h <= 21;
  const r = rand();
  if (summerAft && r < 0.25) return S.STORM;
  if ((L.mo === 12 || L.mo <= 2) && r < 0.1) return S.SNOW;
  if (r < 0.05) return S.LOW;
  return S.CLEAR;
}

function tafRows(a, wx, start, issue, rand, rowsOut) {
  const vFrom = Math.ceil(issue / HOUR) * HOUR;
  const vTo = vFrom + 30 * HOUR;
  const pid = `${new Date(issue).toISOString().replace(/[-:T]/g, "").slice(0, 12)}-XXXX-FTUS00-TAF${a.iata}`;
  const fc = [];
  for (let t = vFrom; t < vTo; t += HOUR) {
    const i = Math.round((t - start) / HOUR);
    const truth = i >= 0 && i < wx.length ? wx[i] : S.CLEAR;
    fc.push(forecastState(truth, i, (t - issue) / HOUR, local(t, a.tz), rand));
  }
  // smooth to 3-hour blocks: prevailing = most common non-storm state; storms become TEMPO / PROB30
  const groups = [];
  for (let k = 0; k < fc.length; k += 3) {
    const blk = fc.slice(k, k + 3);
    const storm = blk.includes(S.STORM);
    const prev = blk.filter((s) => s !== S.STORM);
    const counts = new Map();
    for (const s of prev) counts.set(s, (counts.get(s) || 0) + 1);
    let main = S.CLEAR;
    let best = 0;
    for (const [s, c] of counts) if (c > best) { best = c; main = s; }
    groups.push({ from: vFrom + k * HOUR, to: Math.min(vTo, vFrom + (k + 3) * HOUR), main, storm: storm ? (blk.filter((s) => s === S.STORM).length >= 2 ? "TEMPO" : "PROB30") : null });
  }
  const row = (fxValid, raw, tempo, fxEnd, ftype) => rowsOut.push([a.icao, iso(issue), iso(fxValid), q(raw), tempo ? "True" : "False", fxEnd ? iso(fxEnd) : "", "", "", "", "", "[]", "[]", "[]", "", "", "", pid, ftype, "False"].join(","));
  let last = null;
  groups.forEach((g, gi) => {
    if (gi === 0) row(issue, COND[g.main].t, false, null, "Observation");
    else if (g.main !== last) row(g.from, `FM${ddhh(g.from)}00 ${COND[g.main].t}`, false, null, "Forecast");
    last = g.main;
    if (g.storm) {
      const span = `${ddhh(g.from)}/${ddhhEnd(g.to)}`;
      if (g.storm === "TEMPO") row(g.from, `TEMPO ${span} 3SM TSRA BKN030CB`, true, g.to, "Temporary");
      else row(g.from, `PROB30 ${span} 4SM TSRA BKN030CB`, false, g.to, "Probability 30");
    }
  });
}

function tafCsv(a, wx, start, from, to, rand) {
  const rows = [TAF_HEAD];
  // routine issues at 23:20, 05:20, 11:20, 17:20 UTC for TAFs starting in [from - 30 h, to)
  for (let t = Math.floor((from - 30 * HOUR) / (6 * HOUR)) * 6 * HOUR; t < to; t += 6 * HOUR) {
    const issue = t - 40 * 60e3;
    if (issue < from - 30 * HOUR || issue >= to) continue;
    tafRows(a, wx, start, issue, rand, rows);
  }
  return rows.join("\n") + "\n";
}

// ---------- LAMP (assumed IEM mos.py CSV) ----------

const LAMP_CAT = { [S.CLEAR]: [7, 7], [S.LOW]: [3, 5], [S.FOG]: [1, 2], [S.STORM]: [5, 5], [S.SNOW]: [4, 3], [S.WIND]: [6, 7] };
function lampCsv(a, wx, start, from, to, rand) {
  const lines = ["station,model,runtime,ftime,lp1,cp1,cig,vis"];
  for (let run = from; run < to; run += 3 * HOUR) {
    for (let k = 1; k <= 24; k++) {
      const ft = run + k * HOUR;
      const i = Math.round((ft - HOUR - start) / HOUR);
      const st = i >= 0 && i < wx.length ? wx[i] : S.CLEAR;
      const lp = Math.min(95, Math.max(0, Math.round((st === S.STORM ? 45 : 3) + (rand() - 0.5) * 30 - k)));
      const [cig, vis] = rand() < 0.8 - k * 0.01 ? LAMP_CAT[st] : LAMP_CAT[S.CLEAR];
      lines.push([a.icao, "LAV", iso(run), iso(ft), lp, Math.min(99, lp + 10), cig, vis].join(","));
    }
  }
  return lines.join("\n") + "\n";
}

// ---------- BTS On-Time CSV ----------

const BTS_HEAD = '"Year","Quarter","Month","DayofMonth","DayOfWeek","FlightDate","Reporting_Airline","Flight_Number_Reporting_Airline","Origin","OriginCityName","Dest","DestCityName","CRSDepTime","DepTime","DepDelay","DepDel15","CRSArrTime","ArrTime","ArrDelay","Cancelled","CancellationCode","Diverted","CarrierDelay","WeatherDelay","NASDelay","SecurityDelay","LateAircraftDelay",';
const SEV = { [S.CLEAR]: 0, [S.LOW]: 0.12, [S.FOG]: 0.3, [S.STORM]: 0.42, [S.SNOW]: 0.35, [S.WIND]: 0.16 };

/** Staffing triggers per airport: [{from, to}] (about one every 12 days, 3-5 h; NAS delays while they last). */
function staffingEvents(airports, start, end, rand) {
  const out = {};
  for (const a of airports) {
    const ev = [];
    for (let t = start; t < end; t += HOUR) if (rand() < 1 / (12 * 24)) { const to = t + (3 + Math.floor(rand() * 3)) * HOUR; ev.push({ from: t, to }); t = to; }
    out[a.iata] = ev;
  }
  return out;
}
const inEvent = (list, t) => (list || []).some((e) => t >= e.from && t < e.to);

function btsCsv(airports, wx, start, month, rand, staff) {
  const [y, m] = month.split("-").map(Number);
  const from = Date.UTC(y, m - 1, 1) - 12 * HOUR;
  const to = Date.UTC(y, m, 1) + 12 * HOUR;
  const lines = [BTS_HEAD];
  let fl = 100;
  const state = (iata, t) => { const i = Math.round((Math.floor(t / HOUR) * HOUR - start) / HOUR); return i >= 0 && i < wx[iata].length ? wx[iata][i] : S.CLEAR; };
  for (const a of airports) {
    for (let t = from; t < to; t += HOUR) {
      const L = local(t, a.tz);
      if (L.date.slice(0, 7) !== month || L.h < 5) continue;
      const dty = dayType(+L.date.slice(0, 4), +L.date.slice(5, 7), +L.date.slice(8, 10));
      const busy = dty?.pk ? 1.35 : dty?.hol ? 0.8 : 1;
      const nDep = Math.round((5 + Math.floor(rand() * 4) + (L.h >= 7 && L.h <= 9 ? 3 : 0) + (L.h >= 16 && L.h <= 19 ? 3 : 0)) * busy);
      const staffed = inEvent(staff[a.iata], t);
      for (let k = 0; k < nDep; k++) {
        const dest = airports[(airports.indexOf(a) + 1 + Math.floor(rand() * (airports.length - 1))) % airports.length];
        const dep = t + Math.floor(rand() * 60) * 60e3;
        const arr = dep + (100 + Math.floor(rand() * 60)) * 60e3;
        const so = state(a.iata, dep);
        const sd = state(dest.iata, arr);
        const hubStorm = (FIX_HUBS[a.iata] || []).some((h) => state(h, dep) === S.STORM);
        // volume: busy hours turn bad weather into more delays; peak travel days and staffing add NAS delays
        const pWx = 0.05 + SEV[so] + SEV[sd] * 0.5 + (hubStorm ? 0.12 : 0) + (nDep >= 11 && so !== S.CLEAR ? 0.08 : 0) + (dty?.pk ? 0.05 : 0) + (staffed ? 0.2 : 0);
        let cancelled = 0;
        let code = "";
        if (so === S.SNOW && rand() < 0.08) { cancelled = 1; code = "B"; } else if (so === S.STORM && rand() < 0.04) { cancelled = 1; code = "C"; } else if (rand() < 0.004) { cancelled = 1; code = "A"; }
        let depDelay = Math.round(rand() * 14 - 6);
        let wxDelay = "";
        let nasDelay = "";
        let carrier = "";
        const isWx = rand() < pWx;
        if (isWx) depDelay = 15 + Math.round(-Math.log(1 - rand()) * (20 + 40 * Math.max(SEV[so], SEV[sd])));
        else if (rand() < 0.07) depDelay = 15 + Math.round(rand() * 45);
        const arrDelay = depDelay + Math.round(rand() * 16 - 8);
        if (arrDelay >= 15) {
          if (isWx) { if (rand() < 0.3) wxDelay = arrDelay; else nasDelay = arrDelay; } else carrier = arrDelay;
        }
        const Ld = local(dep, a.tz);
        const La = local(arr, dest.tz);
        const dd = Ld.date;
        const dt = new Date(dd + "T00:00:00Z");
        lines.push([
          dt.getUTCFullYear(), Math.floor(dt.getUTCMonth() / 3) + 1, dt.getUTCMonth() + 1, dt.getUTCDate(), ((dt.getUTCDay() + 6) % 7) + 1, dd,
          '"XX"', fl++, `"${a.iata}"`, '"City, ST"', `"${dest.iata}"`, '"City, ST"', `"${Ld.hm}"`, cancelled ? "" : `"${Ld.hm}"`,
          cancelled ? "" : depDelay.toFixed(2), cancelled ? "" : depDelay >= 15 ? "1.00" : "0.00", `"${La.hm}"`, cancelled ? "" : `"${La.hm}"`,
          cancelled ? "" : arrDelay.toFixed(2), cancelled ? "1.00" : "0.00", code, "0.00",
          carrier === "" ? "" : carrier.toFixed(2), wxDelay === "" ? (arrDelay >= 15 && !cancelled ? "0.00" : "") : wxDelay.toFixed(2),
          nasDelay === "" ? (arrDelay >= 15 && !cancelled ? "0.00" : "") : nasDelay.toFixed(2), arrDelay >= 15 && !cancelled ? "0.00" : "", arrDelay >= 15 && !cancelled ? "0.00" : "", "",
        ].join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * History-branch truth lines (poller/record.mjs shape) every 20 min from `from`: FAA ground stops in
 * storms and GDPs in snow/fog (NAS status), ops plans every 6 h with "possible" ground stops where storms
 * come within 6 h (and some false alarms) and the staffing triggers; the FAA source is down now and then.
 */
function historyLines(airports, wx, start, from, end, staff, rand) {
  const lines = [];
  const st = (iata, t) => { const i = Math.floor((t - start) / HOUR); return i >= 0 && i < wx[iata].length ? wx[iata][i] : S.CLEAR; };
  const isoS = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";
  for (let t = from; t < end; t += 20 * 60e3) {
    const L = { t: isoS(t), airports: {} };
    if (rand() < 0.01) L.down = ["faa"];
    const plan = t % (6 * HOUR) === 0;
    for (const a of airports) {
      const x = {};
      const now = st(a.iata, t);
      const staffed = inEvent(staff[a.iata], t);
      if (!L.down && now === S.STORM && rand() < 0.7) x.faa = [{ type: "ground_stop", cause: "weather", reason: "WX:Thunderstorms" }];
      else if (!L.down && (now === S.SNOW || now === S.FOG) && rand() < 0.6) x.faa = [{ type: "ground_delay", cause: "weather", reason: "WX:Low ceilings", detail: "avg 45m" }];
      else if (!L.down && staffed && rand() < 0.5) x.faa = [{ type: "ground_delay", cause: "staffing", reason: "Staffing" }];
      if (plan) {
        const op = {};
        let storm = false;
        for (let k = 1; k <= 6; k++) if (st(a.iata, t + k * HOUR) === S.STORM) storm = true;
        if ((storm && rand() < 0.7) || rand() < 0.03) op.programs = [{ codes: [a.iata], program: "GS", status: "possible", until: isoS(t + 6 * HOUR), raw: `${a.iata} GS POSSIBLE` }];
        const ev = (staff[a.iata] || []).find((e) => e.to > t && e.from < t + 6 * HOUR);
        if (ev) op.staffing = [{ kind: "trigger", facility: a.iata, until: isoS(ev.to), cause: "staffing", raw: `${a.iata} STAFFING TRIGGER` }];
        if (Object.keys(op).length) x.opsplan = op;
      }
      if (Object.keys(x).length) L.airports[a.iata] = x;
    }
    if (plan) L.opsplan = { plan: { advisory: "ATCSCC ADVZY 001 DCC OPERATIONS PLAN", issued: isoS(t) } };
    lines.push(L);
  }
  return lines;
}

/**
 * The synthetic world. Returns providers keyed like the live sources:
 *   taf(icao, from, to) -> CSV text, metar(id, from, to) -> CSV text, lamp(icao, from, to) -> CSV text,
 *   bts(month) -> CSV text, history() -> truth lines (the last `historyMonths` months); plus {airports, hubs, months}.
 */
export function fixtureWorld({ seed = 20260922, months = FIX_MONTHS, historyMonths = 7 } = {}) {
  const rand = rng(seed);
  const [y0, m0] = months[0].split("-").map(Number);
  const [y1, m1] = months[months.length - 1].split("-").map(Number);
  const start = Date.UTC(y0, m0 - 1, 1) - 2 * 24 * HOUR;
  const end = Date.UTC(y1, m1, 1) + 2 * 24 * HOUR;
  const wx = simulateWeather(FIX_AIRPORTS, start, end, rand);
  const byIcao = Object.fromEntries(FIX_AIRPORTS.map((a) => [a.icao, a]));
  const byId = Object.fromEntries(FIX_AIRPORTS.map((a) => [a.icao.slice(1), a]));
  const seeded = (k) => rng(seed ^ [...k].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const staff = staffingEvents(FIX_AIRPORTS, start, end, seeded("staff"));
  const hm = months[Math.max(0, months.length - historyMonths)].split("-").map(Number);
  const histFrom = Date.UTC(hm[0], hm[1] - 1, 1);
  return {
    airports: FIX_AIRPORTS, hubs: FIX_HUBS, months, start, end,
    taf: (icao, from, to) => (byIcao[icao] ? tafCsv(byIcao[icao], wx[byIcao[icao].iata], start, from, to, seeded("taf" + icao + from)) : TAF_HEAD + "\n"),
    metar: (id, from, to) => (byId[id] ? metarCsv(byId[id], wx[byId[id].iata], start, from, to) : "station,valid,metar\n"),
    lamp: (icao, from, to) => (byIcao[icao] ? lampCsv(byIcao[icao], wx[byIcao[icao].iata], start, from, to, seeded("lamp" + icao + from)) : "station,model,runtime,ftime,lp1,cp1\n"),
    bts: (month) => btsCsv(FIX_AIRPORTS, wx, start, month, seeded("bts" + month), staff),
    history: () => historyLines(FIX_AIRPORTS, wx, start, histFrom, end, staff, seeded("history")),
  };
}
