(() => {
  "use strict";
  // live relay: self-update compares this with index.html's app.js?v=
  const APP_V = (/[?&]v=(\d+)/.exec((document.currentScript && document.currentScript.src) || "") || [])[1] | 0;

  const LEVELS = [
    { name: "None", label: "Clear" },
    { name: "Low", label: "Minor" },
    { name: "Moderate", label: "Moderate" },
    { name: "High", label: "High" },
    { name: "Severe", label: "Severe" },
  ];
  // plain names for failures ("FAA delay info unavailable") and what may be missing then
  const SOURCE_NAMES = {
    faa: "FAA delay info", atcscc: "FAA traffic notices", nws: "Weather warnings", spc: "Storm outlook", metar: "Current weather",
    taf: "Airport forecast", sigmet: "Thunderstorm alerts", isigmet: "Flight weather advisories", lamp: "Hourly storm chances", tcf: "Storm forecast", cwa: "Center weather advisories",
  };
  const SOURCE_MISSING = {
    faa: "delays may be missing", atcscc: "ground stops may be missing", nws: "warnings may be missing",
    spc: "severe-storm risk may be missing", metar: "current conditions may be missing", taf: "forecast hours may be missing",
    sigmet: "thunderstorm alerts may be missing", isigmet: "flight weather advisories may be missing", lamp: "thunder chances may be missing", tcf: "storm forecasts may be missing",
    cwa: "center weather advisories may be missing",
  };
  // restrictions hook: FAA TFRs (status.noticeSources); when the source failed, quiet statuses say so
  const NOTICES_DOWN = "Nearby flight restrictions unavailable right now";
  function noticesDown() {
    const ns = (state.data && state.data.noticeSources) || {};
    return ["tfr"].some((k) => ns[k] && (!ns[k].ok || ns[k].error || ns[k].stale));
  }
  const SPC_NAMES = { MRGL: "Marginal", SLGT: "Slight", ENH: "Enhanced", MDT: "Moderate", HIGH: "High" };
  const FAV_KEY = "awx-favs";
  const DEFAULT_FAVS = ["MSP", "ORD", "DEN", "ATL"];
  const HOUR = 3600e3;
  const REFRESH_MS = 120e3;
  const STALE_MS = 30 * 60e3;
  const CATS = window.AWXCats;
  const USER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } })();
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    data: null,
    sample: false,
    offline: false,
    filter: "mine",
    favs: loadFavs(),
    fetchedAt: 0,
    fetchError: null,
    loaded: false,
    openIata: null,
    build: null, // live relay: the build's status.json; `data` is it with live airports merged in
    liveWx: {}, // live relay: fresh shard-shaped entries for starred non-major airports (site/searched.js)
  };

  // ---------- settings (build2b: the state lives in site/prefs.js, window.AWXPrefs) ----------

  const PREFS = window.AWXPrefs || memoryPrefs();
  /** Fallback when prefs.js didn't load (module scripts blocked): defaults, kept for this page only. */
  function memoryPrefs() {
    const keys = CATS.KEYS;
    let p = { mode: "traveler", show: Object.fromEntries(keys.map((k) => [k, true])), theme: "auto", clock: 12, codes: "iata", timeRef: "airport" };
    const subs = new Set();
    return {
      getPrefs: () => Object.assign({}, p, { show: Object.assign({}, p.show) }),
      setPref: (k, v) => { p = Object.assign({}, p, { [k]: k === "show" ? Object.assign({}, p.show, v) : v }); subs.forEach((f) => f(p, k)); return p; },
      onPrefs: (f) => { subs.add(f); return () => subs.delete(f); },
    };
  }
  // internal view of the prefs: hide = categories switched off; tz "mine" = timeRef "mine"
  const S = { mode: "traveler", hide: {}, theme: "auto", clock: "12", codes: "iata", tz: "local" };
  function syncPrefs() {
    const p = PREFS.getPrefs();
    S.mode = p.mode === "aviation" ? "aviation" : "traveler";
    S.theme = p.theme || "auto";
    S.clock = String(p.clock) === "24" ? "24" : "12";
    S.codes = p.codes === "icao" ? "icao" : "iata";
    S.tz = p.timeRef === "mine" ? "mine" : "local";
    S.hide = {};
    for (const k of CATS.KEYS) if (p.show && p.show[k] === false) S.hide[k] = true;
  }
  syncPrefs();
  PREFS.onPrefs(() => {
    syncPrefs();
    fmtCache.clear();
    viewCache = new WeakMap();
    render();
  });
  const aviation = () => S.mode === "aviation";
  // the theme (data-theme on :root) is applied by index.html's pre-paint script and the nav shell (site/nav.js)

  // ---------- helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  /** Small stroke icon from path data (24×24). */
  function icon(d, cls) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "ico" + (cls ? " " + cls : ""));
    for (const p of [].concat(d)) {
      const e = document.createElementNS(NS, "path");
      e.setAttribute("d", p);
      svg.append(e);
    }
    return svg;
  }
  const ICONS = {
    clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7v5l3 2"],
    tower: ["M9 21l1.5-11h3L15 21", "M7 10h10", "M8 6.5a4 4 0 0 1 8 0", "M5.5 4a7 7 0 0 1 13 0"],
    alert: ["M12 3.5L2.8 19.5h18.4z", "M12 10v4.5", "M12 17.2v.3"],
    bolt: ["M13 2.5L5 13.5h6l-1 8 8-11h-6z"],
    cloud: ["M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"],
    radar: ["M12 21a9 9 0 1 1 9-9", "M12 16a4 4 0 1 1 4-4", "M12 12l7-7"],
    plane: ["M21 15.5v-2l-8-5V3.5a1 1 0 0 0-2 0v5l-8 5v2l8-2.5v5l-2.2 1.6V21l3.2-1 3.2 1v-1.4L13 18v-5z"],
    gear: ["M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z", "M19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.6.9L15.4 20h-3.6l-.3-2a7 7 0 0 1-1.6-.9l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-1.9L6.2 10.4 8 7.3l1.9.7a7 7 0 0 1 1.6-.9l.3-2h3.6l.3 2a7 7 0 0 1 1.6.9l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 1.9z"],
    ops: ["M4 19h16", "M6 19V9h3v10", "M11 19V5h3v14", "M16 19v-7h3v7"],
    sun: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"],
    next: ["M4 12h13", "M13 6l6 6-6 6"],
    grip: ["M5 8h14", "M5 12h14", "M5 16h14"],
    trash: ["M5 7h14", "M10 7V4.5h4V7", "M7 7l1 13h8l1-13"],
  };

  function loadFavs() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw != null) {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
      }
    } catch (e) { /* storage blocked or corrupt */ }
    return DEFAULT_FAVS.slice();
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favs)); } catch (e) { /* ignore */ }
  }
  function toggleFav(iata) {
    const i = state.favs.indexOf(iata);
    if (i >= 0) state.favs.splice(i, 1);
    else state.favs.push(iata);
    saveFavs();
    render();
  }
  // ---------- time (build2b: display zone, 12/24-hour, US zone abbreviations) ----------

  const fmtCache = new Map();
  function fmt(tz, opts, key) {
    const k = tz + "|" + key + "|" + S.clock;
    if (!fmtCache.has(k)) {
      let f;
      const o = Object.assign({ timeZone: tz }, opts);
      if (o.hour) { delete o.hour12; o.hourCycle = S.clock === "24" ? "h23" : "h12"; }
      try { f = new Intl.DateTimeFormat("en-US", o); } catch (e) { f = new Intl.DateTimeFormat("en-US", Object.assign(o, { timeZone: "UTC" })); }
      fmtCache.set(k, f);
    }
    return fmtCache.get(k);
  }
  const tidy = (s) => s.replace(/[  ]/g, " ");
  /** Zone used to show an airport's times: its own, or the device's ("My time zone"). */
  const dispTz = (a) => (S.tz === "mine" ? USER_TZ : (a && a.tz) || "UTC");
  function clock(ms, tz, full = false) {
    const s = tidy(fmt(tz, { hour: "numeric", minute: "2-digit" }, "hm").format(ms));
    return S.clock === "24" ? s.replace(/^24:/, "00:") : full ? s : s.replace(":00 ", " ");
  }
  function hourLabel(ms, tz) {
    if (S.clock === "24") return clock(ms, tz).replace(/:\d\d$/, ":00");
    return tidy(fmt(tz, { hour: "numeric" }, "h").format(ms));
  }
  /** Tick label: "12a", "6p" (24-hour: "00", "18"). */
  function tickLabel(ms, tz) {
    const s = hourLabel(ms, tz);
    if (S.clock === "24") return s.slice(0, 2);
    return s.replace(" AM", "a").replace(" PM", "p");
  }
  function dayClock(ms, tz) {
    return fmt(tz, { weekday: "short" }, "wd").format(ms) + " " + clock(ms, tz);
  }
  const dayKey = (ms, tz) => fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(ms);
  /** Minutes east of UTC for tz at ms. */
  function tzOffset(ms, tz) {
    const p = {};
    for (const x of fmt(tz, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }, "full24x").formatToParts(ms)) p[x.type] = x.value;
    let hr = Number(p.hour) % 12;
    if (S.clock !== "24" && /PM/i.test(p.dayPeriod || "")) hr += 12;
    if (S.clock === "24") hr = Number(p.hour) % 24;
    const u = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hr, Number(p.minute), Number(p.second));
    return Math.round((u - Math.floor(ms / 1000) * 1000) / 60e3);
  }
  /** Instant of a local wall-clock time in tz. */
  function localToUtc(y, mo, d, hr, mi, tz) {
    const g = Date.UTC(y, mo - 1, d, hr, mi);
    const o1 = tzOffset(g, tz);
    let t = g - o1 * 60e3;
    const o2 = tzOffset(t, tz);
    if (o2 !== o1) t = g - o2 * 60e3;
    return t;
  }
  function ymd(ms, tz) {
    const p = {};
    for (const x of fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymdp").formatToParts(ms)) p[x.type] = Number(x.value);
    return p;
  }
  /** Local midnight (dayOff days from the day of ms) in tz. */
  function localMidnight(ms, tz, dayOff = 0) {
    const p = ymd(ms, tz);
    return localToUtc(p.year, p.month, p.day + dayOff, 0, 0, tz);
  }
  const US_ZONE = { 240: "A", 300: "E", 360: "C", 420: "M", 480: "P", 540: "AK", 600: "H" };
  /** "CDT", "EST", "HST" for US zones (offset + DST), else Intl's short name ("GMT+1"). */
  function zoneAbbr(ms, tz) {
    try {
      if (/^(America|US|Pacific\/Honolulu|Pacific\/Johnston)/.test(tz)) {
        const y = new Date(ms).getUTCFullYear();
        const jan = tzOffset(Date.UTC(y, 0, 15), tz), jul = tzOffset(Date.UTC(y, 6, 15), tz);
        const std = Math.min(jan, jul);
        const L = US_ZONE[-std];
        if (L) return L + (tzOffset(ms, tz) > std ? "DT" : "ST");
      }
      if (tz === "Pacific/Guam" || tz === "Pacific/Saipan") return "ChST";
      if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
      const p = fmt(tz, { timeZoneName: "short" }, "z").formatToParts(ms).find((x) => x.type === "timeZoneName");
      return p ? p.value : "";
    } catch (e) { return ""; }
  }

  function ago(ms) {
    const m = Math.floor(ms / 60e3);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + " hr" + (m % 60 ? " " + (m % 60) + " min" : "") + " ago";
    return Math.floor(hrs / 24) + " d ago";
  }
  /** Monospace source-line age: "3M AGO", "1H 5M AGO", "JUST NOW". */
  function agoShort(ms) {
    const m = Math.floor(Math.max(0, ms) / 60e3);
    if (m < 1) return "JUST NOW";
    if (m < 60) return m + "M AGO";
    const hr = Math.floor(m / 60);
    return hr < 24 ? hr + "H" + (m % 60 ? " " + (m % 60) + "M" : "") + " AGO" : Math.floor(hr / 24) + "D AGO";
  }

  const refNow = () => (state.sample && state.data ? Date.parse(state.data.generated) : Date.now());
  /** The time the reasons' texts were written relative to (their "until 7 PM" is after this). */
  const dataRef = () => (state.data && Date.parse(state.data.live || state.data.generated)) || refNow();

  /** "3 AM", "tomorrow 6 PM", "Mon 6 PM" relative to now, in tz. */
  function whenLabel(ms, tz) {
    const ref = refNow();
    if (dayKey(ms, tz) === dayKey(ref, tz)) return clock(ms, tz);
    if (dayKey(ms, tz) === dayKey(ref + 24 * HOUR, tz)) return "tomorrow " + clock(ms, tz);
    return fmt(tz, { weekday: "short" }, "wd").format(ms) + " " + clock(ms, tz);
  }
  /** Start of the display-zone hour holding ms: forecasts are hourly, so their windows read "7–9 PM", never "7:22–9:22 PM". */
  function hourFloor(ms, tz) {
    const m = Number(fmt(tz, { minute: "numeric" }, "mi").format(ms)) || 0;
    return ms - m * 60e3 - (((ms % 60e3) + 60e3) % 60e3);
  }
  /** An FAA program's end as the FAA gives it, the one format for the card, the sheet and the log: "7:06 PM", "tomorrow 6:15 AM". */
  const faaUntil = (ms, a) => whenLabel(ms, dispTz(a));

  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const TIME_RE = /\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(\d{1,2})(?::(\d\d))?(?:–(\d{1,2})(?::(\d\d))?)? (AM|PM)\b(?: (ET|CT|MT|PT|AKT|HT|[A-Z]{1,2}[SD]T))?( tomorrow)?/g;
  /**
   * Times written into reason texts by the poller are the airport's local 12-hour clock ("until 7:40 PM CT",
   * "forecast 4–7 PM", "Sun 2:05 AM to Sun 10:05 AM"). Rewrites them for the display settings: zone suffix as
   * "CDT"; with "My time zone" or 24-hour clock each time is resolved to an instant and written again.
   */
  // A time written with another zone than the airport's ("7:45 PM EDT" at SFO) is read in the zone it states.
  const ZONE_TZ = { ET: "America/New_York", CT: "America/Chicago", MT: "America/Denver", PT: "America/Los_Angeles", AKT: "America/Anchorage", HT: "Pacific/Honolulu",
    HST: "Pacific/Honolulu", EST: "Etc/GMT+5", EDT: "Etc/GMT+4", CST: "Etc/GMT+6", CDT: "Etc/GMT+5", MST: "Etc/GMT+7", MDT: "Etc/GMT+6", PST: "Etc/GMT+8", PDT: "Etc/GMT+7",
    AKST: "Etc/GMT+9", AKDT: "Etc/GMT+8" };
  function retime(text, a) {
    const s = String(text || "");
    if (!a || !/\d (AM|PM)\b/.test(s)) return s;
    const src = a.tz || "UTC";
    const tz = dispTz(a);
    const ref = dataRef();
    const base = ymd(ref, src);
    const foreignZone = (zone) => {
      const z = zone && ZONE_TZ[zone];
      return z && localToUtc(base.year, base.month, base.day, 12, 0, z) !== localToUtc(base.year, base.month, base.day, 12, 0, src) ? z : null;
    };
    const resolve = (h12, mi, ap, wd, tomorrow, after, zsrc = src) => {
      const hr = (Number(h12) % 12) + (ap === "PM" ? 12 : 0);
      const cands = [];
      const zb = zsrc === src ? base : ymd(ref, zsrc);
      for (let d = -1; d <= 7; d++) cands.push({ d, t: localToUtc(zb.year, zb.month, zb.day + d, hr, Number(mi || 0), zsrc) });
      if (wd) {
        const c = cands.find((x) => fmt(src, { weekday: "short" }, "wd").format(x.t) === wd && x.t >= ref - 24 * HOUR);
        if (c) return c.t;
      }
      if (tomorrow) return cands.find((x) => x.d === 1).t;
      const min = after != null ? after : ref - 3 * HOUR;
      return (cands.find((x) => x.t >= min) || cands[1]).t;
    };
    return s.replace(TIME_RE, (all, wd, h1, m1, h2, m2, ap, zone, tmw) => {
      const zsrc = foreignZone(zone) || src;
      const convert = S.clock === "24" || tz !== src || zsrc !== src;
      if (!convert) {
        if (!zone) return all;
        const t = resolve(h2 || h1, h2 ? m2 : m1, ap, wd, !!tmw);
        return all.replace(" " + zone, " " + zoneAbbr(t, src));
      }
      const end = resolve(h2 || h1, h2 ? m2 : m1, ap, wd, !!tmw, undefined, zsrc);
      let start = null;
      if (h2) {
        start = resolve(h1, m1, ap, wd, !!tmw, undefined, zsrc);
        if (start > end) start -= 24 * HOUR;
      }
      const one = (t) => (dayKey(t, tz) === dayKey(refNow(), tz) ? clock(t, tz) : whenLabel(t, tz));
      let out;
      if (start != null) {
        const a1 = one(start), b1 = one(end);
        const same = dayKey(start, tz) === dayKey(end, tz) && S.clock !== "24" && a1.slice(-2) === b1.slice(-2) && !/ /.test(a1.slice(0, -3));
        out = same ? a1.slice(0, -3) + "–" + b1 : a1 + " – " + b1;
      } else out = one(end);
      if (zone && tz === src) out += " " + zoneAbbr(end, src);
      return out;
    }).replace(/ – tomorrow (\d)/g, " – $1").replace(/(\d{1,2}(?::\d\d)? [AP]M) tomorrow tomorrow/g, "$1 tomorrow");
  }

  // ---------- plain wording (the data keeps aviation codes for history; the page shows plain English) ----------

  const mph = (kt) => Math.round((Number(kt) * 1.15) / 5) * 5;
  const mph1 = (kt) => Math.round(Number(kt) * 1.15);
  function visNum(v) {
    let n = 0;
    for (const p of String(v).trim().split(/\s+/)) {
      if (p.includes("/")) { const [x, y] = p.split("/").map(Number); n += y ? x / y : 0; } else n += Number(p) || 0;
    }
    return n;
  }
  /** One risk reason in traveler wording; null when it isn't worth showing (ceilings of 1,000 ft and up). */
  function plainReason(r, a) {
    let s = String(r || "");
    if (/^Convective SIGMET over airport/.test(s)) {
      const ends = ((a && a.sigmets) || []).map((x) => Date.parse(x.validTo)).filter(Number.isFinite);
      return "Storms near the airport" + (ends.length ? " until " + clock(Math.max(...ends), dispTz(a)) : "");
    }
    const c = /^(Chance of )?[Cc]eiling ([\d,]+) ft(.*)$/.exec(s);
    if (c) {
      const ft = Number(c[2].replace(/,/g, ""));
      if (ft >= 1000) return null;
      const w = ft < 500 ? "very low clouds" : "low clouds";
      return retime((c[1] ? "Chance of " + w : cap(w)) + c[3], a);
    }
    s = s.replace(/\b([Vv])isibility ((?:\d+ )?\d+(?:\/\d+)?) sm\b/g, (all, V, v) =>
      visNum(v) < 1 ? (V === "V" ? "Poor visibility" : "poor visibility") : `${V}isibility about ${v} ${visNum(v) === 1 ? "mile" : "miles"}`);
    s = s.replace(/\bThunderstorm gusts (\d+) kt\b/g, (all, n) => `Thunderstorm wind gusts to ${mph(n)} mph`);
    s = s.replace(/\b([Gg])usts (\d+) kt\b/g, (all, G, n) => `${G === "G" ? "Wind gusts" : "wind gusts"} to ${mph(n)} mph`);
    if (!aviation()) s = s.replace(/^Thunder chance (\d+)%/, (all, p) => thunderWords(p)); // Aviation mode keeps the LAMP number
    s = s.replace(/^Mist\b/, "Light fog / haze").replace(/\bmist\b/g, "light fog / haze").replace(/\blow ceilings\b/g, "low clouds"); // one name per condition
    s = s.replace(/^Center weather advisory: IFR conditions/, "Low clouds or poor visibility advisory").replace(/^Center weather advisory: thunderstorms/, "Thunderstorm advisory");
    s = s.replace(/^Thunderstorms, (\w+) coverage \(TCF\)/, "Thunderstorms forecast, $1 coverage");
    s = s.replace(/ \((LAMP|TCF|ATCSCC)\)/g, "");
    s = s.replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/\b(\d+)h\b/g, "$1 hr").replace(/(\d)m\b/g, "$1 min");
    return retime(s, a);
  }
  /** Thunder chance in Traveler words (poller/plain.mjs thunderWords: the same cut-offs). */
  function thunderWords(p) {
    const n = Number(p);
    return n >= 60 ? "Thunderstorms likely" : n >= 30 ? "Chance of thunderstorms" : "Slight chance of thunderstorms";
  }
  const plainList = (arr, a) => oneEach(uniq((arr || []).map((r) => plainReason(r, a)).filter(Boolean)));
  /**
   * One name per condition: "Heavy snow" + "Snow, poor visibility" -> "Heavy snow, poor visibility"; "Light fog / haze"
   * drops when another reason already names the clouds, fog or visibility, and a bare visibility line when another
   * names the visibility or fog (the more specific reason stays).
   */
  function oneEach(list) {
    let out = [...list];
    const snow = out.findIndex((r) => /^(Heavy |Light )?snow$/i.test(r)), more = out.findIndex((r) => /^Snow, /.test(r));
    if (snow >= 0 && more >= 0) { out[snow] += out[more].slice(4); out.splice(more, 1); }
    const named = (re, r0) => out.some((r) => r !== r0 && re.test(r));
    out = out.filter((r) => !(/^Light fog \/ haze$/.test(r) && named(/clouds|visibility|fog/i, r)));
    return out.filter((r) => !(/^(Poor visibility|Visibility about [^,]*)$/.test(r) && named(/visibility|fog/i, r)));
  }
  /**
   * A reason inside a card that already states its time window: drop the repeated time phrase ("Very low clouds
   * forecast Sun 6 AM – 12 PM" -> "Very low clouds"; "Rain until 8 PM" -> "Rain"). Warnings and programs keep their
   * own end times; only "forecast …" is dropped from them.
   */
  function shortRaw(r) {
    let t = String(r || "").replace(/\s+forecast\b.*$/, "");
    if (!CATS.reason(r).src) t = t.replace(/\s+(until|from)\s.*$/, "").replace(/\s+for the next \d+ hours$/, "");
    else if (!/^(Ground stop|Ground delay program|Delays\b|Airport closed)/.test(t)) t = t.replace(/\s+until\s[^(]*?(?=\s*\(|$)/, "").replace(/\s+\S{3} \d.*? to .*$/, "");
    return t.replace(/^FAA plans a possible /, "Possible ").replace(/^Possible ground stop or delay program/, "Possible ground stop or delay program");
  }
  const shortList = (arr, a) => plainList((arr || []).map(shortRaw), a);
  /** Badge words: "GDP avg 49m" -> "Arrival delays ~49 min". */
  function badgeText(b) {
    const s = String(b || "");
    const g = /^GDP(?: avg (.+))?$/i.exec(s);
    if (g) return g[1] ? "Arrival delays ~" + g[1].replace(/(\d+)h(\d+)m/, "$1 hr $2 min").replace(/(\d+)m$/, "$1 min").replace(/(\d+)h$/, "$1 hr") : "Arrival delays";
    return { "GROUND STOP": "Ground Stop", DELAYS: "Delays", CLOSED: "Closed", "RUNWAY CLOSED": "Runway closed" }[s.toUpperCase()] || s;
  }
  const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));
  const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
  const uniq = (arr) => [...new Set(arr || [])];
  const f1 = (c) => Math.round((c * 9) / 5 + 32);
  /** Code shown for an airport: IATA (default) or ICAO (settings). */
  const codeOf = (a) => (S.codes === "icao" && a.icao ? a.icao : a.iata || a.code || a.icao);

  /** Short plain conditions for the lens label and the summary: "Light rain, low clouds", "Partly cloudy". */
  function shortCond(c, raw) {
    if (!c) return "";
    const parts = [];
    for (const tok of String(c.wx || "").trim().split(/\s+/).filter(Boolean)) {
      const m = /^(\+|-|VC)?([A-Z]+)$/.exec(tok);
      if (!m || m[2].startsWith("RE")) continue;
      const k = m[2], i = m[1] || "";
      const deg = i === "+" ? "Heavy " : i === "-" ? "Light " : "";
      let p = null;
      if (/TS/.test(k)) p = i === "VC" ? "Storms nearby" : (i === "+" ? "Heavy thunderstorms" : "Thunderstorms");
      else if (/FZRA/.test(k)) p = "Freezing rain";
      else if (/FZDZ/.test(k)) p = "Freezing drizzle";
      else if (/FZFG/.test(k)) p = "Freezing fog";
      else if (/SN/.test(k)) p = deg + "snow";
      else if (/PL/.test(k)) p = "Sleet";
      else if (/SHRA/.test(k)) p = i === "VC" ? "Showers nearby" : deg + "showers";
      else if (/RA/.test(k)) p = deg + "rain";
      else if (/DZ/.test(k)) p = deg + "drizzle";
      else if (/FG/.test(k)) p = i === "VC" ? "Fog nearby" : "Fog";
      else if (/BR/.test(k)) p = "Light fog / haze"; // the reasons' name (plainReason)
      else if (/HZ/.test(k)) p = "Haze";
      else if (/FU/.test(k)) p = "Smoke";
      if (p && !parts.includes(cap(p.trim()))) parts.push(cap(p.trim()));
    }
    const cig = c.cig != null ? c.cig : c.ceiling;
    if (cig != null && cig < 1000) parts.push(cig < 500 ? "very low clouds" : "low clouds");
    if (!parts.length) {
      const covers = (String(raw || "").match(/\b(FEW|SCT|BKN|OVC|VV)\d{3}/g) || []).map((x) => x.slice(0, 3));
      parts.push(covers.includes("OVC") || covers.includes("VV0") ? "Overcast" : covers.includes("BKN") ? "Mostly cloudy" : covers.includes("SCT") ? "Partly cloudy"
        : covers.includes("FEW") ? "Mostly clear" : cig != null ? "Cloudy" : raw ? "Clear" : "No significant weather");
    }
    const g = c.wgst != null ? c.wgst : c.gust;
    if (g != null && g >= 25) parts.push("gusty");
    return cap(parts.slice(0, 3).map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p)).join(", "));
  }
  /** status.json metar -> the hour-condition shape {cig, vis, wdir, wspd, wgst, wx, temp}. */
  const metarCond = (m) => (m ? { cig: m.ceiling, vis: m.visib, wdir: m.wind && m.wind.dir, wspd: m.wind && m.wind.spd, wgst: m.gust, wx: m.wx, temp: m.temp } : null);

  // ---------- data ----------

  async function getJson(url, meta) {
    const res = await fetch(url, { cache: "no-cache" }); // revalidate (ETag -> 304 when unchanged) instead of re-downloading status.json every open/refresh
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    if (meta) meta.fallback = res.headers.get("X-AWX-SW") === "fallback"; // sw.js: the network failed, this is the device's saved copy
    return res.json();
  }

  // ---------- live relay (Cloudflare Worker, README "Live relay") ----------
  const LIVE_MAX = 12;
  const live = { url: undefined, data: null, failed: false, cfg: null };
  const testMode = () => !!(window.AWXTest && AWXTest.name);
  function liveConfig() {
    if (!live.cfg) {
      live.cfg = getJson("./data/config.json")
        .then((c) => (c && typeof c.liveUrl === "string" && /^https?:\/\//.test(c.liveUrl) ? c.liveUrl.replace(/\/+$/, "") : null))
        .catch(() => null)
        .then((u) => (live.url = u));
    }
    return live.cfg;
  }
  /** The open sheet's airport first (README "The observed next hour"), then starred airports (non-majors via
   * site/searched.js, with their zone), then the visible list; at most 12. */
  function liveQuery() {
    const majors = new Set(((state.build && state.build.airports) || []).map((a) => a.iata));
    const ids = [];
    const tz = [];
    const add = (c) => { if (c && ids.length < LIVE_MAX && !ids.includes(c)) ids.push(c); };
    if (majors.has(state.openIata)) add(state.openIata); // an airport opened from At risk, the Map or search gets relay-recomputed hours too
    for (const c of (window.AWXTrips && AWXTrips.liveIds ? AWXTrips.liveIds() : [])) if (majors.has(c)) add(c); // trips hook: trip airports first
    for (const c of state.favs) if (majors.has(c)) add(c);
    const extra = (window.AWXExtra && AWXExtra.liveIds && AWXExtra.liveIds()) || [];
    for (const x of extra) if (ids.length < LIVE_MAX && x.icao && !ids.includes(x.icao)) { add(x.icao); if (x.tz) tz.push(x.icao + ":" + x.tz); }
    for (const a of visibleAirports()) add(a.iata);
    return ids.length ? "ids=" + encodeURIComponent(ids.join(",")) + (tz.length ? "&tz=" + encodeURIComponent(tz.join(",")) : "") : null;
  }
  async function loadLive() {
    if (testMode() || state.sample || state.offline || !(await liveConfig())) return;
    const q = liveQuery();
    if (!q) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(live.url + "/status?" + q, { cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      if (!d || !d.live || !Array.isArray(d.airports) || !d.sources) throw new Error("bad live data");
      live.data = d;
      live.failed = false;
    } catch (e) {
      live.failed = true; // silent: the build is shown, and the header says so
    } finally {
      clearTimeout(timer);
    }
  }
  // Old offline snapshots or a relay still deploying may contain the parked heuristic.
  function withoutLegacySpillover(a) {
    const re = /^[A-Z]{3} (?:closure|ground stop|ground delay program|delays) may (?:disrupt|delay|spread to) (?:some )?flights to and from /;
    const clean = h => {
      const reasons = (h?.reasons || []).filter(r => !re.test(r));
      if (reasons.length === (h?.reasons || []).length) return h;
      const levels = reasons.map(r => CATS.reason(r).level);
      const level = levels.some(l => l == null) ? h.level : Math.min(h.level, Math.max(0, ...levels));
      return Object.assign({}, h, { reasons, level });
    };
    const hours = (a.hours || []).map(clean), now = clean(a.now);
    if (!a.cascade && now === a.now && hours.every((h, i) => h === a.hours[i])) return a;
    let peak = a.peak;
    if (hours.length) {
      const best = hours.reduce((x, h) => h.level > x.level ? h : x, hours[0]);
      peak = { level: best.level, at: best.t, reasons: best.reasons };
    }
    return Object.assign({}, a, { hours, now, peak, cascade: undefined });
  }
  /**
   * state.data = the build with the live airports (and sources) over it, unless the last live call failed; then each
   * airport's current hour is the observed one when the build's hour 1 has become current (site/outlook.js
   * withObsHour, README "The observed next hour"). Every view (cards, sheet, Map, At risk, national strip, trips,
   * offline snapshot) reads these hours.
   */
  function mergeLive() {
    mergeLive0();
    const d = state.data;
    if (d && Array.isArray(d.airports) && window.AWXOutlook && AWXOutlook.withObsHour) {
      const now = refNow();
      const wx = state.liveWx || {};
      const airports = d.airports.map((a) => {
        const e = a.icao && wx[a.icao]; // a fresher METAR the page has for this airport, if any
        return safeCall(() => AWXOutlook.withObsHour(a, now, e && e.mt ? { metar: { obsTime: e.mt, raw: e.m || "" } } : {})) || a;
      });
      if (airports.some((a, i) => a !== d.airports[i])) state.data = Object.assign({}, d, { airports });
    }
    hourTick();
  }
  // the build's hour 1 becomes current at the top of the hour: re-assemble then, without waiting for the next refresh
  let hourTimer = 0;
  function hourTick() {
    clearTimeout(hourTimer);
    if (state.sample) return; // sample data's clock stands still (refNow = its build time)
    const now = Date.now();
    hourTimer = setTimeout(() => { if (!loading && state.data) { mergeLive(); render(); } else hourTick(); }, Math.floor(now / HOUR) * HOUR + HOUR - now + 1500);
  }
  // an airport sheet opened for an airport the last relay answer didn't cover: ask the relay again (debounced), with
  // that airport first, so its hours are recomputed from the live METAR (README "The observed next hour")
  let liveOpenTimer = 0;
  function liveForOpen(iata) {
    clearTimeout(liveOpenTimer);
    if (!iata || det.live.has(iata) || !det.majors.has(iata) || testMode() || state.sample || state.offline) return;
    liveOpenTimer = setTimeout(async () => {
      if (loading || state.openIata !== iata || det.live.has(iata)) return;
      await loadLive();
      if (loading || !live.data || live.failed) return;
      mergeLive();
      render();
    }, 400);
  }
  function mergeLive0() {
    const b = state.build && Object.assign({}, state.build, { airports: state.build.airports.map(withoutLegacySpillover) });
    const L = live.data;
    state.liveWx = {};
    viewCache = new WeakMap();
    det.gen = b ? b.generated : null; // airport details: the build whose detail files the sheets read
    det.majors = new Set(((b && b.airports) || []).map((a) => a.iata));
    det.live = new Set();
    for (const [k, e] of det.by) if (e.gen !== det.gen) det.by.delete(k);
    if (!b || state.sample || state.offline || live.failed || !L || !(Date.parse(L.generated) >= Date.parse(b.generated))) { state.data = b; return; }
    const by = new Map(L.airports.map((a) => [a.iata, a]));
    for (const a of L.airports) if (det.majors.has(a.iata)) det.live.add(a.iata); // the relay's airports carry everything but LAMP
    const airports = b.airports.map((a) => {
      const fresh = by.get(a.iata);
      return Object.assign({}, withoutLegacySpillover(fresh || a), { coverage: { generated: fresh ? L.generated : b.generated, sources: fresh ? Object.assign({}, b.sources, L.sources) : b.sources } });
    })
      .sort((x, y) => y.peak.level - x.peak.level || y.now.level - x.now.level || x.iata.localeCompare(y.iata));
    state.data = Object.assign({}, b, { airports, sources: Object.assign({}, b.sources, L.sources), live: L.generated });
    state.liveWx = L.wx || {};
    state.liveH0 = L.h0;
  }
  // ---------- airport details (README "status.json": data/summary.json + data/airport/<IATA>.json) ----------
  // The home list, map, strip, At risk and trips read the slim summary. An airport's sheet opens at once from it and
  // its detail file (the same poll's full airport: hourly conditions, TAF text, LAMP, delay explanations) fills in the
  // rest; until then those parts say they're loading, and a failed or mismatched detail is stated, never shown as
  // normal. Full files (sample, test scenarios) are split in memory, so their details are ready at once.
  const det = { gen: null, local: null, by: new Map(), majors: new Set(), live: new Set(), reloadFor: null, prefetched: null };
  const detInfo = new WeakMap(); // airport object handed to the sheet -> {status, have, mismatch}
  const HAVE_ALL = { cond: true, taf: true, lamp: true, why: true };
  const HAVE_LAMP = { cond: true, taf: true, lamp: false, why: true }; // a live relay airport: everything but LAMP
  const HAVE_NONE = { cond: false, taf: false, lamp: false, why: false };
  /** The build to show: a summary as it is; a full file (sample, scenario) split, its details kept in memory. */
  function adoptBuild(data) {
    if (!window.AWXSplit || AWXSplit.isSummary(data)) { det.local = null; return data; }
    const { summary, details } = AWXSplit.split(data);
    det.local = details;
    return summary;
  }
  /** null (the object is complete: a searched or weather-only airport), "all" (a summary airport) or "lamp" (live relay). */
  function detailKind(a) {
    if (!a || !window.AWXSplit || !det.majors.has(a.iata)) return null;
    return det.live.has(a.iata) ? "lamp" : "all";
  }
  async function fetchDetail(iata, gen) {
    const url = "./data/airport/" + encodeURIComponent(iata) + ".json";
    const ok = (d) => !!(d && d.airport && d.airport.iata === iata);
    let d = await getJson(url);
    if (!ok(d)) throw new Error("bad airport details");
    if (gen && d.generated !== gen) { // another poll than the summary in use: ask once more past any cache
      try { const d2 = await getJson(url + "?g=" + encodeURIComponent(gen)); if (ok(d2)) d = d2; } catch { /* keep the first */ }
    }
    return d;
  }
  /** The detail entry for iata under the current build ({status: loading | ok | failed, airport, dGen, p}); starts a fetch when needed. */
  function detailEntry(iata) {
    const gen = det.gen;
    if (det.local) {
      const d = det.local[iata];
      return d ? { status: "ok", airport: d.airport, dGen: d.generated, gen } : { status: "failed", gen };
    }
    const key = iata + "@" + gen; // one entry per airport and build: a refresh never mixes them
    let e = det.by.get(key);
    if (e && (e.status !== "failed" || Date.now() - e.at < 30e3)) return e;
    e = { gen, status: "loading", airport: null, dGen: null, at: Date.now() };
    det.by.set(key, e);
    e.p = fetchDetail(iata, gen).then((d) => {
      Object.assign(e, { status: "ok", airport: d.airport, dGen: d.generated, at: Date.now() });
      // a newer poll than the summary: refresh the summary once (then they match); otherwise the sheet says so
      if (d.generated !== gen && Date.parse(d.generated) > Date.parse(gen) && det.reloadFor !== d.generated && !testMode()) { det.reloadFor = d.generated; setTimeout(() => load(false), 0); }
    }, () => { Object.assign(e, { status: "failed", at: Date.now() }); })
      .then(() => {
        if (e.gen === det.gen && state.openIata === iata) renderSheet(true);
        if (e.gen === det.gen && md.iata === iata) renderDetails(true);
        return e;
      });
    return e;
  }
  /** Resolves once iata's details have loaded or failed (check page). */
  const detailReady = (iata) => { const e = detailEntry(iata); return e.p ? e.p.then(() => detailEntry(iata)) : Promise.resolve(e); };
  const merged = new WeakMap(); // summary/live airport -> {src (detail airport), out}
  /** {a, status, have, mismatch}: the airport with its details restored when they're here (site/split.js restore). */
  function withDetail(a0) {
    const kind = detailKind(a0);
    if (!kind) { const r = { a: a0, status: "none", have: HAVE_ALL, mismatch: null }; detInfo.set(a0, r); return r; }
    const e = detailEntry(a0.iata);
    if (e.status !== "ok") { const r = { a: a0, status: e.status, have: kind === "lamp" ? HAVE_LAMP : HAVE_NONE, mismatch: null }; detInfo.set(a0, r); return r; }
    let m = merged.get(a0);
    if (!m || m.src !== e.airport) {
      m = { src: e.airport, out: kind === "lamp" ? Object.assign({}, a0, { lamp: e.airport.lamp ?? null }) : AWXSplit.restore(a0, e.airport) };
      merged.set(a0, m);
    }
    // a live airport's own data is the relay's; LAMP comes from the build either way
    const r = { a: m.out, status: "ok", have: HAVE_ALL, mismatch: kind === "all" && e.dGen !== det.gen ? e.dGen : null };
    detInfo.set(m.out, r);
    return r;
  }
  const detailOf = (a) => (a && detInfo.get(a)) || { status: "none", have: HAVE_ALL, mismatch: null };
  /** Neutral placeholder for a part that waits for the airport's details (or says they couldn't load). */
  function detailWait(a, what) {
    const failed = detailOf(a).status === "failed";
    return h("p", { class: "muted det-wait" }, failed ? "Some details unavailable — " + what + " couldn't load right now." : "Loading " + what + "…");
  }
  /** Starred (and today's trip) airports' details, fetched when idle after a render so their sheets open complete. */
  function prefetchMine() {
    if (det.local || state.offline || !det.gen || det.prefetched === det.gen) return;
    det.prefetched = det.gen;
    const run = () => { for (const c of myAirportIds()) if (det.majors.has(c)) detailEntry(c); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 }); else setTimeout(run, 1500);
  }

  // self-update: reload when the deployed index.html points at a newer app.js
  let versionAt = 0;
  async function checkVersion() {
    if (!APP_V || Date.now() - versionAt < 10e3) return;
    versionAt = Date.now();
    try {
      const res = await fetch("./index.html", { cache: "no-store" });
      const m = res.ok && /app\.js\?v=(\d+)/.exec(await res.text());
      if (m && Number(m[1]) > APP_V) location.reload();
    } catch (e) { /* offline */ }
  }

  function cachedStatus() { try { return window.AWXOffline?.load(localStorage) || null; } catch { return null; } }
  // Offline snapshot: cleaned + serialised off the load path (idle, else ~1 s timer); always saves the newest data.
  let saveQueued = false;
  function saveStatus(data) {
    saveStatus.latest = data;
    if (saveQueued) return;
    saveQueued = true;
    const run = () => { saveQueued = false; try { window.AWXOffline?.save(localStorage, saveStatus.latest); } catch { /* storage blocked */ } };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1000);
  }

  let loading = false;
  let reloading = false; // the refresh button is reloading the page: keep the spinner
  async function load(manual) {
    if (loading) return;
    loading = true;
    $("refresh").classList.add("spin");
    if (manual) checkVersion(); // live relay
    const liveP = state.build ? loadLive() : null; // live relay: in parallel with the build once the airport list is known
    let openP = null; // airport details: an open sheet's airport for a new build, fetched before the build is swapped in
    try {
      let data, sample = false;
      const meta = {}; // sw.js: was the summary the device's saved copy (network failed)?
      try {
        data = window.AWXTest && AWXTest.name ? AWXTest.rebase(await getJson(AWXTest.url)) : await getJson("./data/summary.json", meta); // build2a hook: ?test=<scenario> (site/testmode.js)
      } catch (e) {
        if (e.status !== 404) throw e;
        if (!testMode() && cachedStatus()) throw e;
        data = await getJson("./data/sample.json");
        sample = true;
      }
      if (!data || !Array.isArray(data.airports)) throw new Error("bad data");
      data = adoptBuild(data);
      if (!det.local && data.generated !== det.gen && (state.openIata || md.iata)) {
        const prev = det.gen, ids = [...new Set([state.openIata, md.iata].filter((c) => c && data.airports.some((x) => x.iata === c)))];
        det.gen = data.generated;
        openP = Promise.all(ids.map((c) => detailEntry(c).p)).catch(() => null);
        det.gen = prev; // the entries are keyed to the new build; the old one stays in use until it's swapped in
      }
      state.build = data; // live relay (merged into state.data below)
      state.sample = sample;
      state.offline = !!meta.fallback && !testMode(); // a saved copy reads "Offline · last checked …" with its age, like the snapshot
      state.fetchError = null;
      state.fetchedAt = Date.now();
    } catch (e) {
      state.fetchError = manual || !state.data ? "Couldn't load data" : "Couldn't refresh";
      if (!testMode()) {
        const cached = cachedStatus();
        if (state.data && !state.sample) state.build = state.data;
        else if (cached) { state.build = cached; state.sample = false; det.local = null; }
        if (state.build && !state.sample) state.offline = true;
      }
    } finally {
      await Promise.all([liveP || loadLive(), openP]); // live relay: the refresh button waits for fresh data
      mergeLive();
      if (!testMode() && !state.sample && !state.offline && state.data) saveStatus(state.data);
      loading = false;
      state.loaded = true;
      setTimeout(() => { if (!reloading) $("refresh").classList.remove("spin"); }, manual ? 500 : 0);
      render();
      prefetchMine(); // airport details for starred airports, when idle
    }
  }

  // ---------- disruption filter (build2b: Settings → Show these disruptions) ----------

  let viewCache = new WeakMap();
  const anyHidden = () => CATS.KEYS.some((k) => S.hide[k]);
  const isHidden = (cat) => CATS.hidden(cat, S.hide);
  /**
   * The airport as shown under the current settings: reasons, programs, alerts and notices in hidden
   * categories removed, hour levels recomputed from what is left (site/cats.js), now/peak recomputed.
   * Ground stops and full closures are never removed. `hiddenCats` lists the categories that removed something.
   */
  function view(a) {
    const sig = JSON.stringify(S.hide);
    const c = viewCache.get(a);
    if (c && c.sig === sig) return c.v;
    const hiddenCats = new Set();
    const note = (cat) => hiddenCats.add(cat);
    let v;
    if (!anyHidden()) v = Object.assign({}, a, { hiddenCats });
    else {
      const fh = (hr) => {
        const f = CATS.filterHour(hr, S.hide);
        if (f.dropped) for (const r of hr.reasons || []) { const k = CATS.reason(r).cat; if (isHidden(k)) note(k); }
        return Object.assign({}, hr, { level: f.level, reasons: f.reasons });
      };
      const hours = a.hours.map(fh);
      const observed = (a.observed || []).map(fh);
      let pi = 0;
      hours.forEach((x, i) => { if (x.level > hours[pi].level) pi = i; });
      const peak = hours[pi].t === a.peak.at
        ? { level: hours[pi].level, at: a.peak.at, reasons: fh(a.peak).reasons }
        : { level: hours[pi].level, at: hours[pi].t, reasons: hours[pi].reasons };
      const keep = (arr, catOf) => (arr || []).filter((x) => { const k = catOf(x); if (isHidden(k)) { note(k); return false; } return true; });
      const spcCat = a.spc === "TSTM" ? "tstm" : a.spc ? "storms" : null;
      const op = a.opsplan ? Object.assign({}, a.opsplan, { items: keep(a.opsplan.items, CATS.planItem) }) : null;
      v = Object.assign({}, a, {
        hours, observed, peak,
        now: { level: hours[0].level, reasons: fh(a.now).reasons },
        faa: keep(a.faa, CATS.faa),
        atcscc: keep(a.atcscc, CATS.adv),
        alerts: keep(a.alerts, (x) => CATS.alert(x.event)),
        spc: isHidden(spcCat) ? (note(spcCat), null) : a.spc,
        aviationAdvisories: keep(a.aviationAdvisories, (x) => x.cat),
        sigmets: isHidden("storms") && (a.sigmets || []).length ? (note("storms"), []) : a.sigmets,
        tcf: isHidden("storms") && (a.tcf || []).length ? (note("storms"), []) : a.tcf,
        cwa: keep(a.cwa, (x) => (/^(TS|CONV|THUNDER|CB)/i.test(x.hazard || "") ? "storms" : "fog")),
        opsplan: op,
        hiddenCats,
      });
    }
    v._src = a;
    viewCache.set(a, { sig, v });
    return v;
  }

  // ---------- rendering ----------

  function render() {
    renderHeader();
    renderSeg();
    renderBanner();
    renderNational();
    renderList();
    renderNotes();
    if (state.openIata) renderSheet(true);
    if (md.iata) renderDetails(true);
    if (window.AWXExtra) window.AWXExtra.render(); // build2a hook: search + searched/starred non-major airports (site/searched.js)
    if (window.AWXTrips) window.AWXTrips.render(); // trips hook: "Your trips" (site/trips.js)
    if (window.AWXBrief) safeCall(() => window.AWXBrief.render()); // brief hook: refresh airport changes (site/brief.js)
    if (panel.kind === "national") renderNationalPanel();
    document.dispatchEvent(new CustomEvent("awx:render"));
  }

  // stale data (README "Stale data"): over 20 min since the data shown was fetched (the live relay's time, else the build's)
  const STALE_TAG_MS = 20 * 60e3;
  function dataAge() {
    const d = state.data;
    if (!d || state.sample) return null;
    const t = Date.parse(d.live || d.generated);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
  }
  const isStale = () => (dataAge() || 0) > STALE_TAG_MS;
  /** Small muted "May be outdated" next to a card's status while the data is stale. */
  const staleTag = () => (isStale() ? h("span", { class: "stale-tag" }, "May be outdated") : null);

  function renderHeader() {
    const el = $("updated");
    const d = state.data;
    el.classList.remove("stale");
    if (!d) { el.textContent = state.loaded ? "Not updated" : "Loading…"; return; }
    if (state.sample) { el.textContent = "Sample data"; return; }
    if (state.offline) { el.textContent = "Offline · last checked " + ago(Math.max(0, Date.now() - Date.parse(d.live || d.generated))); el.classList.add("stale"); return; }
    el.classList.remove("livefail"); // live relay
    if (d.live) { const s = Math.max(0, Date.now() - Date.parse(d.live)); el.textContent = "Live · " + (s < 60e3 ? Math.round(s / 1e3) + " s ago" : ago(s)); return; }
    const age = Date.now() - Date.parse(d.generated);
    el.textContent = live.failed ? "Live updates unavailable — showing the latest build" + (age > STALE_TAG_MS ? " (" + ago(age) + ")" : "") : "Updated " + ago(age);
    if (live.failed) el.classList.add("livefail");
    if (age > STALE_MS) el.classList.add("stale");
  }

  /** My airports in the favourites' order; All / At risk sorted by level under the current settings. */
  /** Airports for the lists and counts: trip-only airports stay off unless starred (trips hook). */
  const myAirportIds = () => [...new Set([...state.favs, ...(window.AWXTrips?.todayAirportIds?.() || [])])];
  let tripDayKey = "";
  document.addEventListener("awx:trips", () => {
    const key = (window.AWXTrips?.todayAirportIds?.() || []).join(",");
    if (key !== tripDayKey && state.data) { tripDayKey = key; renderSeg(); renderList(); }
  });
  const listed = () => { const mine = new Set(myAirportIds()); return ((state.data && state.data.airports) || []).filter((a) => !a.trip || mine.has(a.iata)); };
  function visibleAirports() {
    const all = listed();
    if (state.filter === "mine") {
      const by = new Map(all.map((a) => [a.iata, a]));
      return myAirportIds().map((c) => by.get(c)).filter(Boolean);
    }
    const sorted = all.slice().sort((x, y) => levelOf(y) - levelOf(x) || summary(y).nowLevel - summary(x).nowLevel || x.iata.localeCompare(y.iata));
    if (state.filter === "risk") return sorted.filter((a) => levelOf(a) >= 2);
    return sorted;
  }

  function renderSeg() {
    const all = listed(); // trips hook
    const counts = {
      mine: all.filter((a) => myAirportIds().includes(a.iata)).length,
      risk: all.filter((a) => levelOf(a) >= 2).length,
    };
    const tabs = [["mine", "My airports"], ["risk", "At risk · next 24h"]];
    const seg = $("seg");
    seg.replaceChildren(
      ...tabs.map(([k, label]) =>
        h("button", {
          type: "button", role: "tab", "aria-selected": String(state.filter === k),
          onclick: () => { state.filter = k; render(); },
        }, label, state.data ? h("span", { class: "n" }, counts[k]) : null)
      )
    );
  }

  function renderBanner() {
    const b = $("banner");
    const kids = [];
    if (state.sample) kids.push(h("div", { class: "banner" }, h("b", {}, "Sample data. "), "Live data isn't available yet; this is a frozen example snapshot."));
    if (window.AWXTest && AWXTest.name) kids.push(h("div", { class: "banner" }, h("b", {}, "Test scenario: " + ((state.data && state.data.scenario && state.data.scenario.title) || AWXTest.name) + " "), "(not live)")); // build2a hook
    const src = state.data?.sources;
    if (src) {
      const missing = ["faa", "atcscc", "metar", "taf", "nws"].filter(k => !src[k]?.ok || src[k].error || src[k].stale);
      if (missing.length) kids.push(h("div", { class: "banner coverage-warning", role: "status" },
        h("b", {}, "Coverage incomplete. "), missing.map(k => SOURCE_NAMES[k]).join(", ") + " unavailable or limited. Disruptions may be missing from At risk."));
    }
    b.replaceChildren(...kids);
  }

  function renderList() {
    const list = $("list");
    timelineObserver?.disconnect();
    if (!state.data) {
      list.replaceChildren(
        h("div", { class: "empty" }, state.fetchError ? [state.fetchError + ".", h("br"), h("button", { type: "button", onclick: () => load(true) }, "Try again")] : "Loading airports…")
      );
      return;
    }
    const items = visibleAirports();
    if (!items.length) {
      const msg = state.filter === "mine"
        ? "No saved airports yet. Search for an airport and tap its star to save it here."
        : listed().some(a => { const q = AWXOutlook.health(a, outlookOpts(a, view(a))); return q.incomplete || q.outdated; })
          ? "No disruptions identified in the next 24 hours with available data. Coverage is incomplete; some disruptions may be missing."
          : "No elevated airport-wide disruption risk identified in the next 24 hours.";
      list.replaceChildren(h("div", { class: "empty" }, msg));
      return;
    }
    list.classList.toggle("mine", state.filter === "mine");
    list.replaceChildren(...items.map((a, i) => card(a, i, items.length)));
    for (const slot of list.querySelectorAll(".tl-pending")) {
      if (timelineObserver) timelineObserver.observe(slot.closest(".card")); else mountTimeline(slot);
    }
    scheduleLenses();
  }

  function renderNotes() {
    const n = $("notes");
    const kids = [];
    const d = state.data;
    if (d && !state.sample) {
      const down = Object.keys(SOURCE_NAMES).filter((k) => d.sources && d.sources[k] && !d.sources[k].ok);
      for (const k of down) kids.push(h("p", {}, SOURCE_NAMES[k] + " unavailable"));
      const part = Object.keys(SOURCE_NAMES).filter((k) => d.sources && d.sources[k] && d.sources[k].ok && d.sources[k].error);
      for (const k of part) kids.push(h("p", {}, SOURCE_NAMES[k] + " partly unavailable"));
      const stale = Object.keys(SOURCE_NAMES).filter((k) => d.live && d.sources && d.sources[k] && d.sources[k].ok && d.sources[k].stale && !d.sources[k].error);
      for (const k of stale) kids.push(h("p", {}, SOURCE_NAMES[k] + ": live update failed, showing the last build")); // live relay
    }
    if (state.fetchError && d) kids.push(h("p", {}, state.fetchError + "; showing the last data"));
    if (d && anyHidden()) kids.push(h("p", {}, "Some disruption types are hidden in Settings: " + CATS.KEYS.filter((k) => S.hide[k]).map((k) => CATS.LABELS[k]).join(", ") + ". Ground stops and airport closures are always shown."));
    n.replaceChildren(...kids);
  }

  function pill(level, small, prefix = "") {
    return h("span", { class: "pill " + lv(level) + (small ? " sm" : "") }, prefix + LEVELS[level].label);
  }

  // Programs that affect airline flights. GA-only (limited) and runway closures stay in the sheet.
  function cardPrograms(a) {
    return (a.faa || []).filter((f) => f.badge && (f.type !== "closure" || ((f.scope || "full") === "full" && f.active !== false)));
  }

  function faaBadges(a) {
    const order = { ground_stop: 0, closure: 1, ground_delay: 2, delay: 3 };
    const cls = { ground_stop: "l4", closure: "l4", ground_delay: "l3", delay: "l2" };
    return cardPrograms(a)
      .sort((x, y) => (order[x.type] ?? 9) - (order[y.type] ?? 9))
      .map((f) => h("span", { class: "badge " + (cls[f.type] || "l2") }, badgeText(f.badge || f.type)));
  }

  // ---------- level spans ----------

  /** The peak is shown on its own only when it is later than now and higher. */
  function laterPeak(a) {
    return a.peak.level > a.now.level && a.peak.at !== a.hours[0].t;
  }
  /** End of the run of hours at the current level. */
  function levelEnd(a) {
    const l0 = a.hours[0].level;
    let j = 0;
    while (j + 1 < a.hours.length && a.hours[j + 1].level === l0) j++;
    return Date.parse(a.hours[j].t) + HOUR;
  }
  /** "4–7 PM" (or "tomorrow 2–5 AM") for the run of peak-level hours starting at the peak, in the display zone. */
  function peakRange(a) {
    const tz = dispTz(a);
    let p = a.hours.findIndex((x) => x.t === a.peak.at);
    if (p < 0) p = 0;
    let q = p;
    while (q + 1 < a.hours.length && a.hours[q + 1].level === a.peak.level) q++;
    const start = Date.parse(a.hours[p].t);
    const end = Date.parse(a.hours[q].t) + HOUR;
    const sa = clock(start, tz), sb = clock(end, tz);
    const w = whenLabel(start, tz);
    const prefix = w.indexOf(" ") > 0 && !/^\d/.test(w) ? w.slice(0, w.indexOf(" ")) + " " : "";
    // compress "4–7 PM" only on the same day and the same AM/PM half; else "11 PM – 1 AM tomorrow"
    if (dayKey(start, tz) === dayKey(end, tz) && S.clock !== "24" && sa.split(" ").pop() === sb.split(" ").pop()) return prefix + sa.slice(0, sa.lastIndexOf(" ")) + "–" + sb;
    if (dayKey(start, tz) === dayKey(end, tz)) return prefix + sa + " – " + sb;
    const wb = whenLabel(end, tz);
    return prefix + sa + " – " + (/^\d/.test(wb) ? wb : wb.slice(wb.indexOf(" ") + 1) + " " + wb.slice(0, wb.indexOf(" ")));
  }

  // ---------- LAMP ----------

  /** LAMP thunder probability (LP1: the hour ending at t; LP2: 2 hours) covering the hour starting at ms. */
  function lampThunderAt(a, ms) {
    let p = null;
    for (const x of (a.lamp && a.lamp.hours) || []) {
      const t = Date.parse(x.t);
      if (x.tstmProb == null || !(t > ms && t <= ms + (x.probHrs || 1) * HOUR)) continue;
      if (p == null || x.tstmProb > p) p = x.tstmProb;
    }
    return p;
  }
  function lampAt(a, ms) {
    return ((a.lamp && a.lamp.hours) || []).find((x) => { const t = Date.parse(x.t); return t > ms && t <= ms + HOUR; }) || null;
  }
  /** Flight category from LAMP ceiling (1-8) and visibility (1-7) categories. */
  function lampCat(x) {
    const c = x.cig == null ? 9 : x.cig, v = x.vis == null ? 9 : x.vis;
    if (c <= 2 || v <= 2) return "LIFR";
    if (c <= 3 || v <= 4) return "IFR";
    if (c <= 5 || v <= 5) return "MVFR";
    return x.cig == null && x.vis == null ? null : "VFR";
  }

  // ---------- timeline: rolling context + forecast (build2b) ----------

  /**
   * Default: 12 elapsed hours before the current hour, then 24 forecast hours. Tomorrow remains a
   * calendar-day view. Past hours come from `observed` (METAR history), the current and later
   * hours from the forecast `hours`. kind: obs | now | fc | none (past, no report) | na (no forecast yet).
   */
  function daySlots(a, dayOff = 0) {
    const v = view(a);
    const tz = dispTz(a);
    const now = refNow();
    const midnight = localMidnight(now, tz);
    const currentHour = midnight + Math.floor((now - midnight) / HOUR) * HOUR;
    const start = dayOff ? localMidnight(now, tz, dayOff) : currentHour - 12 * HOUR;
    const end = dayOff ? localMidnight(now, tz, dayOff + 1) : currentHour + 24 * HOUR;
    // data hours by their offset from the list's first hour; slots map to data hours through the hour that holds
    // now (test scenarios shift every time by the same amount, so their hours aren't on the clock hour)
    const index = (list) => {
      const t0 = list.length ? Date.parse(list[0].t) : 0;
      const m = new Map(list.map((x) => [Math.round((Date.parse(x.t) - t0) / HOUR), x]));
      return (t) => m.get(Math.round((t - t0) / HOUR)) || null;
    };
    const fcAt = index(v.hours);
    const obsAt = index(v.observed || []);
    const nowSlot = Math.floor((now - start) / HOUR);
    const k = v.hours.findIndex((x) => Date.parse(x.t) <= now && now < Date.parse(x.t) + HOUR);
    const anchor = k >= 0 ? Date.parse(v.hours[k].t) : start + nowSlot * HOUR;
    const out = [];
    for (let t = start, j = 0; t < end - 60e3; t += HOUR, j++) {
      const dt = anchor + (j - nowSlot) * HOUR; // the data hour shown in this slot
      let s;
      if (j < nowSlot) {
        const o = obsAt(dt);
        const f = o ? null : fcAt(dt);
        const x = o || (f && Date.parse(f.t) < now ? f : null);
        s = x && x.level != null ? { kind: "obs", level: x.level, reasons: x.reasons, h: x, observed: !!o } : { kind: "none", level: null, reasons: [], h: null };
      } else {
        const f = fcAt(dt);
        // forecast hours: the display level (weather/FAA raised by the delay chance) and, when that raised it, why
        const L = f && f.level != null ? hourLevel(a, f, j === nowSlot) : null;
        s = f && f.level != null ? { kind: j === nowSlot ? "now" : "fc", level: L, reasons: hourReasons(a, f, L), h: f } : { kind: "na", level: null, reasons: [], h: null };
      }
      s.t = t;
      s.key = s.h ? Date.parse(s.h.t) : dt;
      s.i = out.length;
      out.push(s);
    }
    return { slots: out, start, end, tz, cur: nowSlot >= 0 && nowSlot < out.length ? nowSlot : -1 };
  }

  function timelineDay(ms, tz) {
    const now = refNow();
    const key = dayKey(ms, tz);
    for (const [offset, label] of [[0, "Today"], [-1, "Yesterday"], [1, "Tomorrow"]]) {
      if (key === dayKey(localMidnight(now, tz, offset), tz)) return label;
    }
    return fmt(tz, { weekday: "short" }, "wd").format(ms);
  }

  /** "Now · Light rain, low clouds" for the lens label at rest. */
  function nowWords(a) {
    const cascadeText = (a.cascade || []).some((c) => a.nowText && a.nowText.indexOf(c.hub + " ") === 0);
    if (a.nowText && !cascadeText) return "Now · " + a.nowText;
    // the sheet's wording: the current hour's first weather condition, as its reasons name it
    const v = a.hours && a.hours.length ? view(a) : null;
    const nh = v ? safeCall(() => nowHourOf(a, v, summary(a))) : null;
    const cond = nh ? safeCall(() => shortList(nh.reasons.filter((r) => !CATS.reason(r).src && !/^Chance of /.test(r)), a)[0]) : null;
    // a current hour still read from the forecast (outlook.js withObsHour fcNow) says so, never as observed
    if (cond) return "Now · " + (nh.x && nh.x.fcNow ? "Forecast · " : "") + cond;
    const c = a.metar ? metarCond(a.metar) : a.hours[0];
    const w = shortCond(c, a.metar && a.metar.raw);
    return "Now · " + (w || LEVELS[view(a).now.level].label);
  }
  /** "9 PM · High · Very low clouds" (past hours: "9 AM · Observed · Minor · Rain"). */
  function slotText(s, a) {
    const tz = dispTz(a);
    const when = (dayKey(s.t, tz) === dayKey(refNow(), tz) ? "" : timelineDay(s.t, tz) + " ") + hourLabel(s.t, tz);
    if (s.kind === "none") return when + " · No report";
    if (s.kind === "na") return when + " · No forecast";
    if (s.level === 0 && s.kind !== "obs" && AWXOutlook.health(a, outlookOpts(a, view(a))).quality) return when + " · Status unconfirmed";
    const top = plainList(s.reasons, a)[0];
    return [s.kind === "now" ? "Now" : when, s.kind === "obs" ? (s.observed ? "Observed" : "Earlier forecast") : s.kind === "fc" ? "Forecast" : null, LEVELS[s.level].label, top, s.kind === "fc" && AWXOutlook.quietHour(s.t, a.tz) ? "Few flights" : null].filter(Boolean).join(" · ");
  }

  function conciseSlotText(s, a) {
    const tz = dispTz(a), day = dayKey(s.t, tz) === dayKey(refNow(), tz) ? "" : timelineDay(s.t, tz) + " ";
    const when = s.kind === "now" ? "Now" : day + hourLabel(s.t, tz);
    if (s.kind === "none") return when + " · No report";
    if (s.kind === "na") return when + " · No forecast";
    if (s.level === 0) return when + " · " + (AWXOutlook.health(a, outlookOpts(a, view(a))).quality ? "Status unconfirmed" : s.kind === "fc" && AWXOutlook.quietHour(s.t, a.tz) ? "Few flights" : "Low risk");
    const r = (s.reasons || []).join(" ");
    const topic = (s.reasons || []).some(x => /^Airport closed\b/i.test(x)) ? "Airport closed" : (s.reasons || []).some(x => /^Ground stop\b/i.test(x)) ? "Ground Stop"
      : /Ground delay|Delay program|Delays|FAA reports/i.test(r) ? "Delays"
      : /Thunder|Convective/i.test(r) ? "Storms" : /Fog/i.test(r) ? "Fog" : /Visibility/i.test(r) ? "Poor visibility"
      : /Ceiling|Low clouds/i.test(r) ? "Low clouds" : /Gust|Wind/i.test(r) ? "Strong winds"
      : /Snow|Freezing|Ice|Winter/i.test(r) ? "Winter weather" : /VIP|restrictions/i.test(r) ? "Restrictions"
      : /Space launch/i.test(r) ? "Space launch" : "Disruption";
    return when + " · " + LEVELS[s.level].label + ": " + topic;
  }
  function conciseNowWords(a, slot) {
    const text = nowWords(a).split(",")[0];
    return text.length <= 34 ? text : conciseSlotText(slot, a);
  }

  /**
   * Timeline element. Touch previews share a brief hold everywhere; vertical gestures scroll.
   * The lens sits on the current hour at rest.
   */
  function timeline(a, opts = {}) {
    const big = !!opts.big;
    const day = daySlots(a, opts.dayOff || 0);
    const { slots, tz } = day;
    const n = slots.length;
    // Future colors show the existing hourly forecast; an open FAA program is qualified in text.
    const sm = safeCall(() => summary(a)) || {};
    const qualified = !!AWXOutlook.health(a, outlookOpts(a, view(a))).quality;
    const segs = slots.map((s) => h("span", {
      class: "s " + (s.level == null || qualified && s.level === 0 && s.kind !== "obs" ? "nd" : lv(s.level)) + (s.kind === "obs" || s.kind === "none" ? " past" : "") + (s.i === day.cur ? " cur" : "") + (AWXOutlook.quietHour(s.t, a.tz) ? " quiet" : ""),
      "data-i": s.i, "data-l": s.level == null ? null : String(s.level), "data-t": String(s.key),
    }));
    const lensSeg = h("span", { class: "lens-seg" });
    const lens = h("span", { class: "lens", "aria-hidden": "true" }, lensSeg);
    const tl = h("div", { class: "tl" + (big ? " big" : ""), style: `grid-template-columns:repeat(${n},minmax(0,1fr))` }, segs, lens);
    const ticks = h("div", { class: "ticks", "aria-hidden": "true" });
    // ticks every 6 hours, none within 5 slots of the end label (no "6a" over "10a"); a day word only when it changes
    let lastDay = null;
    slots.forEach((s, i) => {
      const parts = fmt(tz, { hour: "numeric" }, "H24n").formatToParts(s.t);
      const hour = Number(parts.find((x) => x.type === "hour").value);
      const lh = S.clock === "24" ? hour % 24 : hour % 12 + (parts.some((x) => x.type === "dayPeriod" && /PM/i.test(x.value)) ? 12 : 0);
      if (lh === 0) tl.append(h("span", { class: "midnight-mark", style: `left:${(i / n) * 100}%`, "aria-hidden": "true" }));
      if (lh % 6 === 0 && i <= n - 5) {
        const dw = lh === 0 ? timelineDay(s.t, tz) : null;
        const showDay = dw && dw !== lastDay;
        if (dw) lastDay = dw;
        ticks.append(h("span", { style: `left:${(i / n) * 100}%`, class: i < 2 ? "first" : "" }, tickLabel(s.t, tz), showDay ? h("small", { class: "tick-day" }, dw) : null));
      }
    });
    const endDay = timelineDay(day.end, tz);
    ticks.append(h("span", { class: "last", style: "left:100%" }, tickLabel(day.end, tz), endDay !== lastDay ? h("small", { class: "tick-day" }, endDay) : null));
    const label = h("div", { class: "lenslabel", "aria-hidden": "true" });
    const na = slots.findIndex((x, i) => x.kind === "na" && slots.slice(i).every((y) => y.kind === "na"));
    const naNote = na >= 0 ? h("div", { class: "nanote" }, "No forecast yet from " + whenLabel(slots[na].t, tz)) : null;
    const wrap = h("div", {
      class: "tl-wrap" + (big ? " bigwrap" : " cardwrap"), tabindex: "0", role: "slider",
      "aria-label": "Hourly risk at " + codeOf(a) + ", " + (opts.dayOff ? "tomorrow" : "past 12 hours and next 24 hours"),
      "aria-description": "Hold and slide to preview an hour. Release to return to Now. Swipe to scroll.",
      "aria-valuemin": "0", "aria-valuemax": String(n - 1), "aria-valuenow": String(Math.max(0, day.cur)),
      "aria-valuetext": day.cur >= 0 ? slotText(slots[day.cur], a) : slotText(slots[0], a),
      "data-start": String(day.start), "data-tz": tz,
    }, !opts.dayOff ? h("div", { class: "timeline-context", "aria-hidden": "true" }, h("span", {}, "Past 12h"), h("span", {}, "Now → forecast 24h")) : null,
      label, tl, ticks, naNote, big ? h("div", { class: "tl-cap" }, h("div", { class: "tl-key", "aria-label": "Colour key: Clear, Low, Moderate, High, Severe" },
      LEVELS.map(({ label: w }, i) => h("span", { class: "tk" }, h("i", { class: "tk-dot l" + i, "aria-hidden": "true" }), w))),
      sm.open ? h("div", { class: "tl-note" }, "Future hours are forecast estimates; FAA end time is unknown.") : null) : null);
    const T = { wrap, tl, lens, lensSeg, label, segs, slots, day, a, rest: day.cur, big, opts };
    wrap._tl = T;
    wireBigScrub(T);
    return wrap;
  }

  // Card timelines are built just ahead of scrolling, rather than for every airport at once.
  function mountTimeline(slot) {
    if (!slot?._airport || !slot.isConnected) return;
    const a = slot._airport;
    timelineObserver?.unobserve(slot.closest(".card"));
    slot.replaceWith(timeline(a, {}));
  }
  function cardTimeline(a) {
    const slot = h("div", { class: "tl-pending", "aria-hidden": "true" });
    slot._airport = a;
    return slot;
  }
  const timelineObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) mountTimeline(e.target.querySelector(".tl-pending"));
    scheduleLenses();
  }, { rootMargin: "600px 0px" }) : null;
  function ensureCardTimeline(card) {
    const slot = card?.querySelector(".tl-pending");
    if (slot) mountTimeline(slot);
  }

  function timelineLabel(a) {
    return `Past 12 hours and next 24 hours at ${codeOf(a)}: peak ${LEVELS[levelOf(a)].label}`;
  }

  /** Puts the lens (and its label) over slot i; i < 0 hides it. scrub: the grown magnifier. */
  function placeLens(T, i, scrub) {
    const { wrap, lens, lensSeg, label, segs } = T;
    const W = wrap.clientWidth;
    if (!W) return;
    if (i == null || i < 0 || !segs[i]) {
      lens.hidden = true;
      label.textContent = "";
      label.hidden = true;
      if (T.wrap.getAttribute("role") === "slider") {
        wrap.setAttribute("aria-valuenow", "0");
        wrap.setAttribute("aria-valuetext", "No hour selected. Hold and slide to preview.");
      }
      return;
    }
    const seg = segs[i];
    const sw = seg.offsetWidth;
    const cx = seg.offsetLeft + sw / 2;
    lens.hidden = false;
    lens.style.left = cx + "px";
    lens.style.width = sw + (T.big ? 14 : 10) + "px";
    lensSeg.className = "lens-seg " + (seg.classList.contains("nd") ? "nd" : lv(T.slots[i].level)) + (seg.classList.contains("past") ? " past" : "");
    lensSeg.style.cssText = seg.style.cssText.replace(/(^|;)\s*width[^;]*/g, "") + ";width:" + sw + "px";
    wrap.classList.toggle("scrub", !!scrub);
    label.hidden = false;
    label.textContent = scrub || i !== T.rest || T.slots[i].kind === "na" ? conciseSlotText(T.slots[i], T.a) : conciseNowWords(T.a, T.slots[i]);
    const lw = Math.min(W, label.offsetWidth);
    label.style.left = Math.max(0, Math.min(W - lw, cx - lw / 2)) + "px";
    if (T.wrap.getAttribute("role") === "slider") {
      wrap.setAttribute("aria-valuenow", String(i));
      wrap.setAttribute("aria-valuetext", slotText(T.slots[i], T.a));
    }
  }
  // Batch reads before writes. A read after each label change used to reflow the entire list.
  function placeLenses() {
    const plans = [];
    for (const w of document.querySelectorAll(".tl-wrap")) {
      const T = w._tl;
      if (!T || w.classList.contains("scrub")) continue;
      const cardEl = w.closest(".card");
      if (cardEl) {
        if (state.openIata || document.body.dataset.tab && document.body.dataset.tab !== "airports") continue;
        const r = cardEl.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
      }
      const W = w.clientWidth, i = T.shown != null ? T.shown : T.rest, seg = T.segs[i];
      if (!W) continue;
      if (i == null || i < 0 || !seg) { plans.push({ T, hidden: true }); continue; }
      const sw = seg.offsetWidth, cx = seg.offsetLeft + sw / 2;
      plans.push({ T, W, i, seg, sw, cx });
    }
    for (const p of plans) {
      const {T, i, seg, sw, cx} = p;
      if (p.hidden) { T.lens.hidden = T.label.hidden = true; continue; }
      T.lens.hidden = false;
      T.lens.style.left = cx + "px";
      T.lens.style.width = sw + (T.big ? 14 : 10) + "px";
      T.lensSeg.className = "lens-seg " + (seg.classList.contains("nd") ? "nd" : lv(T.slots[i].level)) + (seg.classList.contains("past") ? " past" : "");
      T.lensSeg.style.cssText = seg.style.cssText.replace(/(^|;)\s*width[^;]*/g, "") + ";width:" + sw + "px";
      T.label.hidden = false;
      T.label.textContent = i !== T.rest || T.slots[i].kind === "na" ? conciseSlotText(T.slots[i], T.a) : conciseNowWords(T.a, T.slots[i]);
      if (T.wrap.getAttribute("role") === "slider") { T.wrap.setAttribute("aria-valuenow", String(i)); T.wrap.setAttribute("aria-valuetext", slotText(T.slots[i], T.a)); }
    }
    for (const p of plans) if (!p.hidden) p.lw = Math.min(p.W, p.T.label.offsetWidth);
    for (const p of plans) if (!p.hidden) p.T.label.style.left = Math.max(0, Math.min(p.W - p.lw, p.cx - p.lw / 2)) + "px";
  }
  let lensesPending = false;
  function scheduleLenses() {
    if (lensesPending) return;
    lensesPending = true;
    requestAnimationFrame(() => { lensesPending = false; placeLenses(); });
  }
  addEventListener("resize", scheduleLenses);
  document.addEventListener("scroll", scheduleLenses, { capture: true, passive: true });
  /** Segment index under clientX. */
  function slotAt(T, x) {
    const r = T.tl.getBoundingClientRect();
    return Math.max(0, Math.min(T.segs.length - 1, Math.floor(((x - r.left) / Math.max(1, r.width)) * T.segs.length)));
  }
  function tickSeg(T, i) {
    const s = T.segs[i];
    if (!s || reduced()) return;
    s.classList.remove("tick");
    void s.offsetWidth;
    s.classList.add("tick");
  }
  /** Lens back to the current hour (spring unless reduced motion). */
  function springBack(T) {
    T.wrap.classList.remove("scrub");
    T.wrap.classList.toggle("spring", !reduced());
    T.shown = null;
    placeLens(T, T.rest, false);
    setTimeout(() => T.wrap.classList.remove("spring"), 450);
  }

  let swallowClick = 0, swallowCard = null;
  document.addEventListener("click", (e) => { if (Date.now() < swallowClick && (!swallowCard || e.target.closest(".card") === swallowCard)) { e.stopPropagation(); e.preventDefault(); } }, true);

  /** Cards activate on a horizontal drag or 240 ms hold; vertical swipes keep scrolling. */
  function wireBigScrub(T) {
    const bar = T.tl;
    let g = null, raf = 0, holdTimer = 0;
    const heldKeys = new Set();
    const keys = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);
    const show = (i) => {
      if (T.shown !== i) tickSeg(T, i);
      T.shown = i;
      placeLens(T, i, true);
      if (T.opts.onPreview) T.opts.onPreview(i);
    };
    const activate = () => {
      if (!g || g.cancelled || !bar.isConnected) return;
      clearTimeout(holdTimer);
      g.active = true;
      try { bar.setPointerCapture(g.id); } catch (x) { /* ignore */ }
      show(slotAt(T, g.x));
    };
    const finish = () => {
      const pointer = g;
      clearTimeout(holdTimer);
      holdTimer = 0;
      g = null;
      heldKeys.clear();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (pointer && bar.hasPointerCapture(pointer.id)) bar.releasePointerCapture(pointer.id);
      if ((pointer?.active || pointer?.cancelled) && !T.big) { swallowClick = Date.now() + 350; swallowCard = T.wrap.closest(".card"); }
      if (T.opts.onRelease) T.opts.onRelease();
      springBack(T);
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || g) return;
      heldKeys.clear();
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, active: false };
      if (e.pointerType === "mouse" && T.big) { activate(); e.preventDefault(); }
      else holdTimer = setTimeout(activate, 240);
    });
    bar.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      if (e.pointerType !== "mouse" || !T.big) {
        const dx = Math.abs(e.clientX - g.startX), dy = Math.abs(e.clientY - g.y);
        if (g.cancelled) return;
        if (dx > 8 && dx > dy) {
          g.horizontal = true;
          g.x = e.clientX;
          if (!g.active) activate();
        }
        if (!g.horizontal && dy > 8 && dy > dx) {
          if (g.active) finish();
          else { clearTimeout(holdTimer); g.cancelled = true; }
          return;
        }
        if (!g.active) return;
      }
      g.x = e.clientX;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (g) show(slotAt(T, g.x));
      });
    });
    // Safari must not hand an established horizontal scrub back to page scrolling.
    bar.addEventListener("touchmove", (e) => {
      if (g?.active && g.horizontal && e.cancelable) e.preventDefault();
    }, { passive: false });
    const up = (e) => { if (g && e.pointerId === g.id) finish(); };
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    bar.addEventListener("lostpointercapture", up);
    T.wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Backspace") { finish(); e.preventDefault(); return; }
      if (!keys.has(e.key) || g) return;
      e.preventDefault();
      heldKeys.add(e.key);
      let i = T.shown != null ? T.shown : Math.max(0, T.rest);
      if (e.key === "ArrowRight") i = Math.min(T.segs.length - 1, i + 1);
      else if (e.key === "ArrowLeft") i = Math.max(0, i - 1);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = T.segs.length - 1;
      show(i);
    });
    T.wrap.addEventListener("keyup", (e) => {
      if (!heldKeys.delete(e.key)) return;
      e.preventDefault();
      if (!heldKeys.size) finish();
    });
    T.wrap.addEventListener("blur", finish);
  }

  // ---------- home cards ----------

  /**
   * hubs hook: one short line for the airport's first hub cascade note (status.json `cascade`, poller/hubs.mjs),
   * only while it is ahead, when its category is shown and the reasons on screen don't already say it.
   */
  function cascadeLine(v, shown, cls) {
    const c = (v.cascade || []).find((x) => Date.parse(x.to) > refNow());
    if (!c || isHidden(CATS.reason(c.text).cat)) return null;
    if ((shown || []).some((r) => String(r || "").indexOf(c.hub + " ") === 0)) return null;
    const tz = dispTz(v);
    const from = Math.max(Date.parse(c.from), refNow());
    const when = dayKey(from, tz) === dayKey(refNow(), tz) ? "later today" : dayKey(from, tz) === dayKey(refNow() + 24 * HOUR, tz) ? "tomorrow" : "on " + fmt(tz, { weekday: "long" }, "wdl").format(from);
    return h("div", { class: cls }, c.text + " " + when);
  }

  const PROG_RE = /^(Ground stop|Ground delay program|Delay program|Delays\b|Airport closed)/;
  /** The cause in a program reason: "Ground stop — airline request (IT outage), until 11 AM ET" -> "Airline request (IT outage)". */
  function programCause(reasons) {
    for (const r of reasons || []) {
      const m = PROG_RE.test(r) && /—\s*([^,]+?)(?:,|$)/.exec(String(r));
      if (m && !/^conditions$/i.test(m[1].trim())) return cap(m[1].trim());
    }
    return null;
  }
  function card(a, idx, count) {
    const open = () => openSheet(a.iata);
    const v = view(a);
    const sm = summary(a);
    const health = AWXOutlook.health(a, outlookOpts(a, v));
    const headlineLevel = sm.current?.kind === "unknown" ? null : (sm.current?.level ?? sm.nowLevel);
    const unknown = headlineLevel == null;
    const fav = state.favs.includes(a.iata);
    const progs = cardPrograms({ faa: sm.current?.programs || [] });
    // Active programs lead with their badge; the cause and FAA timing share one context line.
    const rsn = (rs) => shortList((rs || []).filter((r) => !(progs.length && PROG_RE.test(r))), a);
    // the sheet's Now card headline leads (the same outlook() evaluation, so they can't drift); the weather condition is the secondary line
    const head = ((x) => (/^(No disruptions reported) · /.exec(x) || [null, x])[1])(sm.current?.headline || "No airport-wide disruptions reported");
    let cond = headlineLevel > 0 ? rsn(((n) => hourReasons(a, n.x, headlineLevel, n.reasons))(nowHourOf(a, v, sm)))[0] || (progs.length ? programCause(v.now.reasons) : null) : null;
    const badges = progs.length ? faaBadges({ faa: progs }) : [];
    const currentProgram = progs[0] || null;
    const badgeHeadline = !!currentProgram && badges.length > 0;
    const consolidatedHeadline = (headlineLevel == null ? "Unknown" : LEVELS[headlineLevel].label) + ": " + (badgeHeadline ? badges.map(b => b.textContent).join(" · ") : head);
    const programEnd = !currentProgram ? null : sm.open ? NO_END : sm.current.scheduledEnd
      ? (currentProgram.type === "closure" ? "Reopens " : "Until ") + faaUntil(sm.current.scheduledEnd, a) + zoneTag(a) : null;
    if (cond && cond.toLowerCase().startsWith(head.toLowerCase())) {
      const rest = cond.slice(head.length).trim();
      if (!rest || /^(until|through|from|expected)\b/i.test(rest)) cond = cap(rest) || null;
    }

    const upcoming = sm.later && sm.level >= 2 ? outlook(a, sm.start) : null;
    const forecastHeadline = upcoming && /^Flight delays/.test(upcoming.headline) && sm.peakHour?.level >= 2
      ? upcoming.headline + " · " + AWXOutlook.conditionHeadline(sm.peakHour, false) : upcoming?.headline;
    const forecastText = upcoming ? rangeText(sm.start, sm.end, dispTz(a)) + ": " + forecastHeadline : "";
    const reason = (badgeHeadline ? badges.map(b => b.textContent).join(". ") : head) + (programEnd ? ". " + programEnd : "") + (cond ? ". " + cond : "");
    const mine = state.filter === "mine" && fav;
    if (mine) { const saved = visibleAirports().filter(x => state.favs.includes(x.iata)); idx = saved.findIndex(x => x.iata === a.iata); count = saved.length; }
    const code = codeOf(a);
    const el = h("div", {
      class: "card", role: "button", tabindex: "0", "data-iata": a.iata, "data-level": headlineLevel == null ? "unknown" : String(headlineLevel),
      "aria-label": `${code}, ${a.city}. ${unknown ? "Status unconfirmed" : LEVELS[headlineLevel].label + " risk"}. ${reason}${forecastText ? ". Upcoming " + forecastText : ""}${health.quality ? ". " + health.quality : ""}`,
      onclick: open,
      onkeydown: (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); open(); }
        if (mine && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target === el) { e.preventDefault(); moveMine(a.iata, e.key === "ArrowUp" ? -1 : 1, true); }
      },
    },
      h("div", { class: "top" },
        h("div", { class: "code" }, code),
        h("div", { class: "right" },
          staleTag(),
          h("button", {
            type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + code + (fav ? " from" : " to") + " my airports",
            onclick: (e) => { e.stopPropagation(); toggleFav(a.iata); },
            onkeydown: (e) => e.stopPropagation(),
          }, starSvg()))),
      h("div", { class: "where" }, `${a.city}, ${a.state}`),
      !fav && (window.AWXTrips?.todayAirportIds?.() || []).includes(a.iata) ? h("div", { class: "sub" }, "In your trip today") : null,
      h("div", { class: "badges card-headline" }, h("span", { class: "badge " + (headlineLevel == null ? "off" : lv(headlineLevel)), "data-level": headlineLevel, "data-phase": "current" }, consolidatedHeadline)),
      programEnd ? h("div", { class: "sub card-context" }, h("b", {}, programEnd), cond ? ": " + cond : "")
        : cond ? h("div", { class: "sub" }, cond) : null,
      upcoming ? h("div", { class: "card-forecast" }, h("b", {}, rangeText(sm.start, sm.end, dispTz(a)) + ": "), forecastHeadline) : null,
      health.quality ? h("div", { class: "muted small" }, health.quality) : null,
      window.AWXMovement ? safeCall(() => AWXMovement.line(a)) : null, // movement hook: "Departures far below normal" (site/movement.js)
      !badgeHeadline && badges.length ? h("div", { class: "badges" }, badges) : null,
      cardTimeline(a),
      mine && count > 1 ? h("div", { class: "sr-move" },
        idx > 0 ? h("button", { type: "button", class: "sr", onclick: (e) => { e.stopPropagation(); moveMine(a.iata, -1, true); }, onkeydown: (e) => e.stopPropagation() }, `Move ${code} up`) : null,
        idx < count - 1 ? h("button", { type: "button", class: "sr", onclick: (e) => { e.stopPropagation(); moveMine(a.iata, 1, true); }, onkeydown: (e) => e.stopPropagation() }, `Move ${code} down`) : null) : null);
    el.addEventListener("focusin", () => { ensureCardTimeline(el); scheduleLenses(); });
    if (mine) wireReorder(el);
    return el;
  }

  /** Move a major airport one place up/down among the cards shown on My airports (non-majors keep their slots). */
  function moveMine(iata, dir, refocus) {
    const shown = visibleAirports().filter(a => state.favs.includes(a.iata)).map((a) => a.iata);
    const i = shown.indexOf(iata);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shown.length) return;
    [shown[i], shown[j]] = [shown[j], shown[i]];
    setMineOrder(shown);
    if (refocus) {
      const c = document.querySelector(`#list .card[data-iata="${iata}"]`);
      if (c) c.focus({ preventScroll: false });
      announce(`${iata} moved to position ${j + 1} of ${shown.length}`);
    }
  }
  /** New order of the majors shown on My airports -> favourites, with other entries left in their slots. */
  function setMineOrder(order) {
    order = order.filter(c => state.favs.includes(c));
    const set = new Set(order);
    let k = 0;
    state.favs = state.favs.map((c) => (set.has(c) ? order[k++] : c));
    saveFavs();
    render();
  }
  function announce(msg) {
    const el = $("announce");
    if (el) { el.textContent = ""; setTimeout(() => { el.textContent = msg; }, 30); }
  }

  /**
   * Hold-to-reorder on My airports: press and hold a card for 400 ms (outside its timeline row).
   * The card lifts and follows the finger, the others move aside; dropping saves the order in the favourites.
   * A move before 400 ms is a normal scroll.
   */
  function wireReorder(el) {
    let g = null;
    const cards = () => [...$("list").querySelectorAll(":scope > .card")].filter(c => state.favs.includes(c.dataset.iata));
    const lift = () => {
      const list = cards();
      const rects = list.map((c) => c.getBoundingClientRect());
      g.list = list;
      g.rects = rects;
      g.from = list.indexOf(el);
      g.to = g.from;
      g.on = true;
      el.classList.add("lifted");
      $("list").classList.add("reordering");
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (e) { /* ignore */ }
    };
    const move = (y) => {
      const dy = y - g.y;
      el.style.transform = `translateY(${dy}px) scale(1.03)`;
      const mid = g.rects[g.from].top + g.rects[g.from].height / 2 + dy;
      let to = g.from;
      g.rects.forEach((r, i) => {
        if (i < g.from && mid < r.top + r.height / 2) to = Math.min(to, i);
        if (i > g.from && mid > r.top + r.height / 2) to = Math.max(to, i);
      });
      g.to = to;
      const H = g.rects[g.from].height + 12;
      g.list.forEach((c, i) => {
        if (c === el) return;
        let s = 0;
        if (g.from < to && i > g.from && i <= to) s = -H;
        if (g.from > to && i < g.from && i >= to) s = H;
        c.style.transform = s ? `translateY(${s}px)` : "";
      });
    };
    const finish = () => {
      if (!g) return;
      clearTimeout(g.timer);
      const was = g;
      g = null;
      if (!was.on) return;
      swallowClick = Date.now() + 400;
      swallowCard = null;
      for (const c of was.list) { c.style.transform = ""; }
      el.classList.remove("lifted");
      $("list").classList.remove("reordering");
      if (was.to !== was.from) {
        const order = was.list.map((c) => c.dataset.iata);
        const [x] = order.splice(was.from, 1);
        order.splice(was.to, 0, x);
        setMineOrder(order);
        announce(`${x} moved to position ${was.to + 1} of ${order.length}`);
      }
    };
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || e.target.closest(".tl-wrap, .star, .sr-move")) { g = null; return; }
      const t = e.touches[0];
      g = { x: t.clientX, y: t.clientY, on: false };
      g.timer = setTimeout(() => { if (g) lift(); }, 400);
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (!g) return;
      const t = e.touches[0];
      if (!g.on) {
        if (Math.abs(t.clientX - g.x) > 8 || Math.abs(t.clientY - g.y) > 8) { clearTimeout(g.timer); g = null; } // a normal swipe scrolls
        return;
      }
      if (e.cancelable) e.preventDefault();
      move(t.clientY);
    }, { passive: false });
    el.addEventListener("touchend", finish);
    el.addEventListener("touchcancel", finish);
    el.addEventListener("contextmenu", (e) => { if (g || el.classList.contains("lifted")) e.preventDefault(); });
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".tl-wrap, .star, .sr-move")) return;
      g = { x: e.clientX, y: e.clientY, on: false, mouse: true };
      g.timer = setTimeout(() => { if (g) lift(); }, 400);
      const mm = (ev) => {
        if (!g) return;
        if (!g.on) { if (Math.abs(ev.clientX - g.x) > 8 || Math.abs(ev.clientY - g.y) > 8) { clearTimeout(g.timer); g = null; } return; }
        move(ev.clientY);
      };
      const mu = () => { removeEventListener("mousemove", mm); removeEventListener("mouseup", mu); finish(); };
      addEventListener("mousemove", mm);
      addEventListener("mouseup", mu);
    });
  }

  function starSvg() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M12 3.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z");
    p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
    return svg;
  }
  function closeSvg() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M3 3l10 10M13 3L3 13");
    p.setAttribute("stroke-linecap", "round");
    svg.append(p);
    return svg;
  }

  // ---------- national summary strip (build2b) ----------

  const REGION = {
    Northeast: ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA", "DE", "MD", "DC", "VA"],
    Southeast: ["NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "WV", "PR", "VI"],
    Midwest: ["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"],
    South: ["TX", "OK", "AR", "LA"],
    West: ["NM", "AZ", "CO", "UT", "NV", "WY", "MT", "ID", "CA", "OR", "WA"],
    Alaska: ["AK"], Hawaii: ["HI"],
  };
  const regionOf = (st) => Object.keys(REGION).find((k) => REGION[k].includes(st)) || null;
  const CENTERS = {
    ZAB: "Albuquerque", ZAN: "Anchorage", ZAU: "Chicago", ZBW: "Boston", ZDC: "Washington", ZDV: "Denver", ZFW: "Fort Worth", ZHU: "Houston",
    ZID: "Indianapolis", ZJX: "Jacksonville", ZKC: "Kansas City", ZLA: "Los Angeles", ZLC: "Salt Lake City", ZMA: "Miami", ZME: "Memphis",
    ZMP: "Minneapolis", ZNY: "New York", ZOA: "Oakland", ZOB: "Cleveland", ZSE: "Seattle", ZTL: "Atlanta", ZHN: "Honolulu",
  };
  const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Sfb|Afb|Ca|Fl|Tx|Nasa|Spacex|Ula|Ii)\b/g, (m) => m.toUpperCase());
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  /** Everything the strip and its sheet need, under the current settings. */
  function nationalSummary() {
    const d = state.data;
    if (!d) return null;
    const stops = [], closed = [], gdps = [], delays = [], storms = [];
    for (const a of listed()) {
      const v = view(a);
      const has = (t) => (v.faa || []).some((f) => f.type === t && (t !== "closure" || ((f.scope || "full") === "full" && f.active !== false)));
      const advGS = (v.atcscc || []).some((x) => x.type === "GS" && x.active);
      if (has("ground_stop") || advGS) stops.push(a);
      if (has("closure")) closed.push(a);
      if (has("ground_delay") || (v.atcscc || []).some((x) => x.type === "GDP" && x.active)) gdps.push(a);
      if (has("delay")) delays.push(a);
      const st = v.hours.some((x) => x.reasons.some((r) => CATS.reason(r).cat === "storms" && CATS.reason(r).level >= 2));
      if (st) storms.push(a);
    }
    const regions = {};
    for (const a of storms) { const r = regionOf(a.state); if (r) (regions[r] = regions[r] || []).push(a); }
    const stormRegions = Object.keys(regions).filter((r) => regions[r].length >= 2 || storms.length === 1).sort((x, y) => regions[y].length - regions[x].length);
    // national ops-plan items
    const op = d.opsplan || {};
    const items = [];
    const ref = refNow();
    const tz = USER_TZ;
    if (!isHidden("storms")) {
      for (const c of (op.enroute && op.enroute.constraints) || []) {
        const raw = String(c.raw || c.text || "");
        if (!/THUNDER|TSTM|\bTS\b|CONVECT/i.test(raw)) continue;
        const cs = uniq((raw.match(/\bZ[A-Z]{2}\b/g) || []).map((z) => CENTERS[z]).filter(Boolean));
        items.push({ cat: "storms", text: "Thunderstorms slowing flights en route" + (cs.length ? " near " + cs.slice(0, -1).join(", ") + (cs.length > 1 ? " and " : "") + cs[cs.length - 1] : ""), raw });
      }
    }
    if (!isHidden("atc")) {
      for (const s of op.staffing || []) {
        const name = CENTERS[s.facility] ? CENTERS[s.facility] + " Center" : null;
        if (!name) continue;
        items.push({ cat: "atc", text: `Air traffic control staffing shortage at ${name}` + (s.until ? " until " + whenLabel(Date.parse(s.until), tz) : "") + " — delays possible", raw: s.raw });
      }
    }
    if (!isHidden("space")) {
      for (const l of op.launches || []) {
        const p = l.primary || {};
        const end = Date.parse(p.end);
        if (!Number.isFinite(end) || end < ref || Date.parse(p.start) - ref > 36 * HOUR) continue;
        const what = /REENTRY|RE-ENTRY/i.test(l.name || "") ? "Space reentry" : "Space launch";
        items.push({ cat: "space", text: `${what}: ${titleCase(String(l.name || "").replace(/\s*(REENTRY|RE-ENTRY)\s*/i, " ").trim())}${l.site ? " from " + titleCase(l.site) : ""}, ${whenLabel(Date.parse(p.start), tz)} – ${clock(end, tz)} — some flights may be rerouted`, raw: l.raw });
      }
    }
    const parts = [];
    if (closed.length) parts.push(plural(closed.length, "airport closed", "airports closed"));
    if (stops.length) parts.push(plural(stops.length, "ground stop", "ground stops"));
    if (gdps.length) parts.push(plural(gdps.length, "delay program", "delay programs"));
    if (delays.length) parts.push(plural(delays.length, "airport with delays", "airports with delays"));
    const tail = [];
    if (stormRegions.length) tail.push("storms in " + (/^(Alaska|Hawaii)$/.test(stormRegions[0]) ? "" : "the ") + stormRegions[0]);
    const launches = items.filter((x) => x.cat === "space").length;
    if (launches) tail.push(plural(launches, "space launch", "space launches"));
    const line = [parts.join(", "), ...tail].filter(Boolean).join(" · ");
    return { line, stops, closed, gdps, delays, storms, regions, stormRegions, items };
  }

  function renderNational() {
    const box = $("national");
    const s = nationalSummary();
    const strip = h("div", { class: "natbox", id: "natstrip" }); // movement.js puts airline alerts in #natstrip
    if (s && s.line) {
      const lvl = s.closed.length || s.stops.length ? 4 : s.gdps.length ? 3 : 2;
      strip.append(h("button", { type: "button", class: "natline", onclick: openNational, "aria-haspopup": "dialog" },
        h("span", { class: "dot " + lv(lvl), "aria-hidden": "true" }),
        h("span", { class: "nat-t" }, h("b", {}, "U.S.: "), s.line),
        h("span", { class: "chev", "aria-hidden": "true" }, "›")));
    }
    box.replaceChildren(strip);
    if (window.AWXMovement && state.data) safeCall(() => AWXMovement.alerts()); // movement hook: airline alerts
    box.hidden = !strip.children.length;
  }

  // ---------- bottom sheet ----------

  // build2b: drag to dismiss (header at any scroll position, content at the top), back gesture, scroll lock (site/sheet.js)
  const noSheet = { opened() {}, closed() {}, isOpen: () => false };
  const sheetCtl = window.AWXSheet ? AWXSheet.makeSheet($("sheet"), {
    onClose: () => closeSheet(), header: ".grab, .sh-head", backdrop: $("backdrop"), noPull: ".lamp, .cw-bar",
  }) : noSheet;
  const panelCtl = window.AWXSheet ? AWXSheet.makeSheet($("panel"), { onClose: () => closePanel(), header: ".pn-head", backdrop: $("panelBackdrop") }) : noSheet;

  let lastFocus = null;
  function openSheet(iata) {
    if (panel.kind) {
      if (window.AWXSheet?.transfer) return AWXSheet.transfer(() => closePanel(true), () => openSheet(iata));
      closePanel(true);
    }
    const fresh = !state.openIata;
    state.openIata = iata;
    sheetDay = 0;
    lastFocus = document.activeElement;
    // a popup that set the sheet inert (details page, terminal map, radar, report info) belongs to the last airport:
    // a freshly opened sheet must never stay untappable
    if (fresh && !md.iata) $("sheet").inert = false;
    const wrap = $("sheetWrap");
    wrap.hidden = false;
    document.documentElement.classList.add("lock");
    renderSheet(false);
    liveForOpen(iata); // live relay: this airport's hours from the live METAR when the last answer didn't include it
    sheetCtl.opened();
    void wrap.offsetHeight; // reflow so the transition runs
    wrap.classList.add("open");
    const c = wrap.querySelector(".close");
    if (c) c.focus({ preventScroll: true });
    scheduleLenses();
  }

  function closeSheet() {
    closeReportInfo();
    if (!state.openIata) return;
    closeDetails();
    if (window.AWXRadarCard) safeCall(() => window.AWXRadarCard.close()); // radar hook: stop the radar, free its workers
    if (window.AWXTerminals && AWXTerminals.close) safeCall(() => window.AWXTerminals.close()); // terminals hook: its map viewer closes with the sheet (it set the sheet inert)
    state.openIata = null;
    const wrap = $("sheetWrap");
    const sheet = $("sheet");
    wrap.classList.remove("open");
    sheet.style.transform = "";
    sheet.style.transition = "";
    if (!panel.kind) document.documentElement.classList.remove("lock");
    sheetCtl.closed();
    const done = () => { if (!state.openIata) wrap.hidden = true; };
    if (reduced()) done();
    else setTimeout(done, 300);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function decodeWx(wx) {
    if (!wx) return "None";
    if (wx.trim() === "NSW") return "No significant weather";
    const W = { TS: "thunderstorm", RA: "rain", SN: "snow", DZ: "drizzle", FZ: "freezing", SH: "showers", BR: "mist", FG: "fog", HZ: "haze", PL: "ice pellets", GR: "hail", GS: "small hail", SG: "snow grains", IC: "ice crystals", UP: "unknown precip", BL: "blowing", DR: "drifting", FU: "smoke", DU: "dust", SA: "sand", SQ: "squalls", FC: "funnel cloud", VA: "volcanic ash", PY: "spray", MI: "shallow", BC: "patchy", PR: "partial" };
    return wx.trim().split(/\s+/).map((tok) => {
      const m = /^(\+|-|VC)?([A-Z]+)$/.exec(tok);
      if (!m) return tok;
      const codes = m[2].match(/.{1,2}/g) || [];
      let words = codes.map((c) => W[c] || c);
      if (codes[0] === "SH" && codes.length > 1) words = words.slice(1).concat("showers");
      let s = words.join(" ");
      if (m[1] === "+") s = "heavy " + s;
      else if (m[1] === "-") s = "light " + s;
      else if (m[1] === "VC") s = s + " nearby";
      return s.charAt(0).toUpperCase() + s.slice(1);
    }).join(", ");
  }

  const windKt = (c) => {
    if (!c || c.wspd == null) return null;
    if (c.wspd === 0) return "Calm";
    const dir = c.wdir === "VRB" || c.wdir == null ? "VRB" : String(c.wdir).padStart(3, "0") + "°";
    return `${dir} ${c.wspd}${c.wgst != null ? "G" + c.wgst : ""} kt`;
  };
  const visTxt = (v) => (v == null ? "—" : (v >= 10 ? "10+" : String(Math.round(v * 100) / 100)) + " sm");

  function metarRows(m) {
    const rows = [];
    const add = (k, v) => rows.push(h("dt", {}, k), h("dd", {}, v));
    add("Category", m.fltCat ? h("span", { class: "fc " + m.fltCat }, m.fltCat) : "—");
    const w = m.wind || {};
    let wind = "—";
    if (w.spd === 0) wind = "Calm";
    else if (w.spd != null) wind = (w.dir === "VRB" || w.dir == null ? "Variable" : String(w.dir).padStart(3, "0") + "°") + " at " + w.spd + " kt";
    add("Wind", wind);
    add("Gusts", m.gust != null ? m.gust + " kt" : "None");
    add("Visibility", m.visib != null ? visTxt(m.visib) : "—");
    add("Ceiling", m.ceiling != null ? m.ceiling.toLocaleString("en-US") + " ft" : "None");
    add("Weather", decodeWx(m.wx));
    add("Temp / dew", m.temp != null ? `${m.temp}° / ${m.dewp ?? "—"}°C (${f1(m.temp)}° / ${m.dewp != null ? f1(m.dewp) : "—"}°F)` : "—");
    return rows;
  }

  // Traveler source labels stay brief; raw source text is visible only in Aviation mode.
  const SEC_SRC = {
    faa: "FAA NAS STATUS", atcscc: "FAA COMMAND CENTER", nws: "NWS ALERTS", spc: "NOAA STORM PREDICTION CENTER",
    tcf: "AVIATIONWEATHER.GOV STORM FORECAST", sigmet: "AVIATIONWEATHER.GOV ADVISORIES",
  };
  function srcLine(key, raw) {
    if (!aviation()) return null;
    const s = state.data && state.data.sources && state.data.sources[key];
    const when = s && s.at ? " · UPDATED " + agoShort(refNow() - Date.parse(s.at)) : "";
    const text = "SOURCE: " + (SEC_SRC[key] || key.toUpperCase()) + when;
    const r = (raw || []).filter(Boolean).join("\n\n");
    return h("div", { class: "srcl" }, text, aviation() && r ? h("pre", { class: "raw" }, r) : null);
  }
  const SEC_META = { faa: "FAA", atcscc: "FAA", nws: "NWS", spc: "SPC", tcf: "NWS", sigmet: "NWS", metar: "Observed" };
  /**
   * A detail section (build2b, weather-site pattern): small uppercase header row (icon, title, dotted rule, meta on
   * the right) over one rounded card holding the content, ending with the monospace source line.
   */
  const REPORT_HELP = {
    METAR: "METAR is the airport’s weather observation: wind, visibility, clouds and temperature measured at the report time. It describes observed conditions, not a forecast.",
    TAF: "TAF is the airport’s aviation weather forecast. Each period describes expected wind, visibility, clouds and weather. Temporary changes come and go within their window; chance groups describe possible conditions. These weather chances are separate from the chance of a flight delay."
  };
  const reportPopup = { wrap: null, ctl: null, type: null, last: null, parent: null };
  function closeReportInfo() {
    if (!reportPopup.type) return;
    const { wrap, last, parent } = reportPopup;
    const type = reportPopup.type;
    reportPopup.type = null;
    wrap.classList.remove("open");
    wrap.hidden = true;
    reportPopup.ctl?.closed();
    if (parent) parent.inert = false;
    const target = last?.isConnected ? last : parent?.querySelector(`[aria-label="About ${type}"]`);
    target?.focus({ preventScroll: true });
  }
  function openReportInfo(type, button) {
    if (reportPopup.type) closeReportInfo();
    if (!reportPopup.wrap) {
      const card = h("div", { class: "sheet report-info-card", id: "reportInfoCard", role: "dialog", "aria-modal": "true", "aria-labelledby": "reportInfoTitle" });
      const backdrop = h("div", { class: "backdrop", onclick: closeReportInfo });
      reportPopup.wrap = h("div", { class: "sheet-wrap report-info-wrap", hidden: true }, backdrop, card);
      document.body.append(reportPopup.wrap);
      card.addEventListener("keydown", ev => {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeReportInfo(); }
        else popupFocus(card, ev);
      });
      reportPopup.ctl = window.AWXSheet?.makeSheet(card, { onClose: closeReportInfo, header: ".report-info-head", backdrop });
    }
    reportPopup.type = type;
    reportPopup.last = button;
    reportPopup.parent = button.closest('[role="dialog"]');
    const card = reportPopup.wrap.querySelector(".report-info-card");
    card.replaceChildren(
      h("div", { class: "report-info-head" }, h("h2", { id: "reportInfoTitle" }, "About " + type),
        h("button", { type: "button", class: "close", "aria-label": "Close report information", onclick: closeReportInfo }, closeSvg())),
      h("p", { class: "report-info-copy" }, REPORT_HELP[type]));
    reportPopup.wrap.hidden = false;
    if (reportPopup.parent) reportPopup.parent.inert = true;
    reportPopup.ctl?.opened();
    void card.offsetHeight;
    reportPopup.wrap.classList.add("open");
    card.querySelector(".close").focus({ preventScroll: true });
  }
  function reportHelp(type) {
    const button = h("button", { type: "button", class: "report-info", "aria-label": "About " + type, "aria-haspopup": "dialog",
      onclick: () => openReportInfo(type, button) }, h("span", { "aria-hidden": "true" }, "ⓘ"));
    return { button };
  }
  function reportHeading(text, type) {
    const help = reportHelp(type);
    return h("div", { class: "report-heading" }, h("div", { class: "report-title" }, h("h4", { class: "pd-h" }, text), help.button));
  }
  function tafForecast(a, opts = {}) {
    if (!a.taf) return null;
    const tz = dispTz(a), now = refNow();
    const periods = (a.taf.periods || []).filter(p => Date.parse(p.to) > now);
    const rows = periods.map(p => {
      const c = p.cond || {}, wind = c.wind || {};
      const label = p.kind === "TEMPO" ? "Temporary changes" : p.kind === "BECMG" ? "Gradually changing to" : p.kind === "PROB" ?
        (Number.isFinite(p.probability) && p.probability > 0 ? (aviation() ? p.probability + "% chance" : p.probability / 10 + " in 10 chance") : "Possible conditions") : "";
      const span = whenLabel(Date.parse(p.from), tz) + " – " + whenLabel(Date.parse(p.to), tz);
      const kv = [
        ["Wind", wind.spd == null ? "Not specified" : wind.spd === 0 ? "Calm" : (wind.dir == null || wind.dir === "VRB" ? "Variable" : "From " + compass(wind.dir)) + " " + mph1(wind.spd) + " mph"],
        ["Gusts", c.gust == null ? "None forecast" : mph1(c.gust) + " mph"],
        ["Visibility", c.visib == null ? "Not specified" : c.visibilityAbove ? "More than " + c.visib + " miles" : visWords(c.visib)],
        ["Cloud ceiling", c.ceiling == null ? "No ceiling specified" : c.ceiling.toLocaleString("en-US") + " ft above the airport"],
        ["Weather", c.wx ? decodeWx(c.wx) : "No significant weather forecast"]
      ];
      if (aviation() && c.fltCat) kv.unshift(["Flight category", fcChip(c.fltCat)]);
      return h("div", { class: "taf-period", "data-kind": p.kind }, h("div", { class: "taf-time" }, span), label ? h("b", {}, label) : null,
        h("dl", { class: "kv2" }, kv.map(([k,val]) => h("div", {}, h("dt", {}, k), h("dd", {}, val)))));
    });
    const issued = (a.taf.issued ? "Issued " + whenLabel(Date.parse(a.taf.issued), tz) + " · " : "") + zoneAbbr(now, tz);
    const old = a.taf.issued && now - Date.parse(a.taf.issued) > 12 * HOUR;
    return section(aviation() ? "TAF forecast" : "Airport forecast", "sun", [
      old ? h("p", { class: "warn" }, "This forecast may be outdated.") : null,
      ...rows,
      !rows.length ? h("p", { class: "muted" }, "Decoded forecast periods are unavailable right now.") : null,
      opts.raw && a.taf.raw ? h("pre", { class: "raw" }, a.taf.raw) : null
    ], null, { cls: "taf-forecast", meta: issued, help: "TAF" });
  }
  function section(title, ico, kids, src, opts = {}) {
    const help = opts.help ? reportHelp(opts.help) : null;
    const s = src && state.data && state.data.sources && state.data.sources[src.key];
    const meta = opts.meta || (src ? (SEC_META[src.key] || "") + (s && s.at ? " · " + ago(Math.max(0, refNow() - Date.parse(s.at))).replace(" ago", "") : "") : "");
    return h("section", { class: "sec", id: opts.id || null },
      h("div", { class: "sec-h" }, ico ? icon(ICONS[ico]) : null, h("h3", {}, title), help?.button, h("span", { class: "rule", "aria-hidden": "true" }), meta ? h("span", { class: "meta" }, meta) : null),
      h("div", { class: "scard" + (opts.cls ? " " + opts.cls : "") }, ...kids, src ? srcLine(src.key, src.raw) : null));
  }
  function rawToggle(text) {
    return aviation() && text ? h("pre", { class: "raw rawt" }, text) : null;
  }
  /** Does raw text carry anything (a code, number or word) its plain line doesn't? Aviation raw blocks show only then. */
  function rawAdds(raw, plain) {
    const NOISE = /^(faa|wx|until|issued|avg|max|the|and|for|of|at|by|am|pm|h|m|(c|e|m|p|ak|h)[sd]?t)$/;
    const SAME = { ceilings: "clouds", ceiling: "clouds" };
    const toks = (t) => String(t || "").toLowerCase().match(/[a-z]+|\d+/g) || [];
    const have = new Set(toks(plain).map((w) => (/^\d+$/.test(w) ? String(Number(w)) : w)));
    return toks(raw).some((w) => !NOISE.test(w) && !have.has(/^\d+$/.test(w) ? String(Number(w)) : w) && !have.has(SAME[w]));
  }
  const SRC_TRAVELER = { TAF: "Forecast", LAMP: "Hourly model", METAR: "Observed" };
  const srcName = (s) => (s === "METAR" ? "Observed" : aviation() ? s : SRC_TRAVELER[s] || s);
  const CONF = { high: "High", medium: "Medium", low: "Low" };
  /** "FAA · High confidence" chip (placeholder confidence until Build 3 calibrates it). */
  function confChip(src, conf) {
    return h("span", { class: "cchip " + (conf || "medium"), "data-src": src, title: `${srcName(src)} · ${CONF[conf] || "Medium"} confidence (by source type)` },
      h("i", { class: "cdot", "aria-hidden": "true" }), h("b", {}, srcName(src)), h("span", { class: "cw2" }, " · " + (CONF[conf] || "Medium") + " confidence"));
  }

  const FAA_CLS = { ground_stop: "l4", closure: "l4", ground_delay: "l3", delay: "l2" };

  /** Short plain cause for a NAS status reason: "RWY:Construction" -> "runway construction", "wind" -> "wind". */
  function plainCause(f) {
    const r = String(f.reason || "");
    const detail = (r.split(/[/:]/).pop() || "").trim().toLowerCase().replace(/\b(it|atc|ils|vip|tfr|gps|faa|nas)\b/g, (x) => x.toUpperCase()); // "IT outage"
    if (f.cause === "runway" && detail && !/runway/.test(detail)) return "runway " + detail.replace(/^rwy\s*/, "");
    const lab = f.causeLabel || "";
    const m = /\(([^)]+)\)$/.exec(lab);
    return (m ? m[1] : lab || detail).replace(/\blow ceilings\b/i, "low clouds"); // one name per condition
  }
  /** "Departures 31–45m, increasing; Arrivals 16–30m" -> "Departure delays 31–45 min, increasing; arrival delays 16–30 min". */
  function delayText(detail) {
    return String(detail || "").split("; ").map((part, i) => {
      const m = /^(Arrivals\/Departures|Arrivals|Departures|Delays)\s*(.*)$/.exec(part);
      if (!m) return part;
      const who = { "Arrivals/Departures": "Arrival and departure delays", Arrivals: "Arrival delays", Departures: "Departure delays", Delays: "Delays" }[m[1]];
      const rest = m[2].replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/(\d)m\b/g, "$1 min");
      const t = (who + (rest ? " " + rest : "")).trim();
      return i ? t.charAt(0).toLowerCase() + t.slice(1) : t;
    }).join("; ");
  }
  /** "Departures 31–45 min, increasing ↑" lines for the summary's "Delays right now". */
  function delaysNow(v) {
    const out = [];
    for (const f of v.faa || []) {
      if (f.type !== "delay") continue;
      for (const part of String(f.detail || "").split("; ")) {
        const m = /^(Arrivals\/Departures|Arrivals|Departures|Delays)\s*(.*)$/.exec(part);
        if (!m) continue;
        const rest = m[2].replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/(\d)m\b/g, "$1 min");
        const arrow = /increasing/.test(rest) ? " ↑" : /decreasing/.test(rest) ? " ↓" : /steady/.test(rest) ? " →" : "";
        out.push((m[1] === "Arrivals/Departures" ? "Arrivals and departures" : m[1]) + " " + rest + arrow);
      }
    }
    return out;
  }
  const durTxt = (x) => x.replace(/\b(\d+)h (\d+)m\b/, "$1 hr $2 min").replace(/(\d)m\b/, "$1 min").replace(/(\d)h\b/, "$1 hr");
  /** End of an FAA program for display: its end, or the hours it is held without one (risk.mjs faaSpan). */
  function programEnd(f) {
    const e = Date.parse(f.end);
    return Number.isFinite(e) ? e : null;
  }
  /** FAA programs (and active Command Center GS/GDP not in the NAS status) covering the hour starting at t. */
  function programsAt(v, t, isNow) {
    const now = refNow();
    const out = [];
    for (const f of v.faa || []) {
      if (f.type === "closure") { // closures hook: a full closure covers its window (start through reopening; risk.mjs closureSpan)
        if ((f.scope || "full") !== "full") continue;
        const s = Date.parse(f.start), e = f.perm ? Infinity : Date.parse(f.end);
        if (!Number.isNaN(e)) { if (e > now && t < e && t + HOUR > (Number.isFinite(s) ? s : -Infinity)) out.push(f); }
        else if (isNow && f.active !== false) out.push(f);
        continue;
      }
      const end = programEnd(f) ?? now + (f.trend === "increasing" ? 5 : 3) * HOUR;
      if (t < end && t + HOUR > now - HOUR) out.push(f);
    }
    for (const x of v.atcscc || []) {
      if (!x.active || (x.type !== "GS" && x.type !== "GDP")) continue;
      const type = x.type === "GS" ? "ground_stop" : "ground_delay";
      if (out.some((f) => f.type === type)) continue;
      const end = Date.parse(x.end);
      if (!Number.isFinite(end) || t < end) out.push({ type, end: x.end, detail: "", atcscc: true });
    }
    return out;
  }
  /** "Ground stop until 7:30 PM" / "Delay program until 9 PM, avg 49 min" / "Delays: departures 16–30 min". */
  function programLine(f, a) {
    const tz = dispTz(a);
    const end = programEnd(f);
    const until = end ? "until " + faaUntil(end, a) : /until /.test(f.detail || "") ? retime(/until [^,]+/.exec(f.detail)[0], a) : "until further notice";
    const avg = /avg ([^,]+)/.exec(f.detail || "");
    if (f.type === "closure") return "Airport closed" + (end ? " until " + whenLabel(end, tz) : ""); // closures hook
    if (f.type === "ground_stop") return "Ground stop " + until;
    if (f.type === "ground_delay") return "Delay program " + until + (avg ? ", avg " + durTxt(avg[1]) : "");
    return "Delays: " + delayText(f.detail).replace(/^Delays /, "").replace(/^./, (c) => c.toLowerCase());
  }

  function faaItem(f, a, compact = false, current = true) {
    const chip = aviation() ? h("div", { class: "chips" }, confChip("FAA", "high")) : null;
    if (f.type === "closure") {
      const info = f.scope === "limited" || f.active === false;
      const cls = f.scope === "runway" ? "l1" : "l4";
      return h("div", { class: "item" + (info ? " info" : "") },
        !info && f.badge ? h("span", { class: "badge " + cls }, badgeText(f.badge)) : null,
        h("div", { class: info ? "muted" : "", style: info ? "" : "margin-top:4px" }, retime(f.plain || [f.reason, f.detail].filter(Boolean).join(" · "), a)),
        info ? null : chip, rawAdds(f.reason, f.plain || [f.reason, f.detail].join(" ")) ? rawToggle(f.reason) : null);
    }
    const text = faaText(f, compact, current);
    const until = /until [^,]+$/.exec(f.detail || "");
    const end = f.end ? "until " + faaUntil(Date.parse(f.end), a) : until ? retime(until[0], a) : "until further notice";
    return h("div", { class: "item" },
      compact ? null : h("span", { class: "badge " + (FAA_CLS[f.type] || "l2") }, badgeText(f.badge || f.type)),
      h("div", { style: "margin-top:4px" }, text + (compact ? "." : ", " + end + ".")),
      chip, rawAdds(faaRaw(f), text + " " + end) ? rawToggle(faaRaw(f)) : null); // raw only when it adds to the plain line
  }
  /** An FAA program's impact in plain words: "Arrivals are held at their departure airports: about 49 min on average (low clouds)". */
  function faaText(f, compact = false, current = true, brief = false) {
    if (f.type === "closure") return String(f.plain || [f.reason, f.detail].filter(Boolean).join(" · "));
    const why = plainCause(f);
    let text;
    if (f.type === "delay") text = delayText(f.detail) + (why ? ` (${why})` : "");
    else if (f.type === "ground_delay") {
      const avg = /avg ([^,]+)/.exec(f.detail || ""), max = /max ([^,]+)/.exec(f.detail || "");
      text = "Arrivals are held at their departure airports" + (avg ? `: about ${durTxt(avg[1])} on average` : "") + (max && !brief ? `, up to ${durTxt(max[1])}` : "") + (why ? ` (${why})` : "");
    } else text = "Arrivals are held at their departure airports" + (why ? ` (${why})` : "");
    if (compact && !current) text = text.replace("are held", "are scheduled to be held");
    return text;
  }
  const faaRaw = (f) => (f.type === "closure" ? f.reason : "FAA: " + f.reason + (f.detail ? "\n" + f.detail : ""));

  function advItem(x, a) {
    const tz = dispTz(a);
    const now = refNow();
    const end = x.end ? Date.parse(x.end) : null;
    const start = x.start ? Date.parse(x.start) : null;
    const status = x.cnx ? "Cancelled" : x.active ? (end ? "Active until " + whenLabel(end, tz) : "Active")
      : end != null && end < now ? "Ended" : start != null && start > now ? "Starts " + whenLabel(start, tz) : "Superseded";
    const cls = x.active ? ({ GS: "l4", GDP: "l3", AFP: "l2" }[x.type] || "l1") : "off";
    const name = { GS: "Ground Stop", GDP: "Ground delay program", AFP: "Airspace flow program" }[x.type] || "Advisory";
    return h("div", { class: "item" },
      h("span", { class: "badge " + cls }, name), h("span", { class: "muted" }, " " + status),
      x.causeLabel || x.causeText ? h("div", { style: "margin-top:4px" }, cap(x.causeLabel || x.causeText)) : null,
      x.issued ? h("div", { class: "muted small" }, "Issued " + whenLabel(Date.parse(x.issued), tz)) : null,
      aviation() && x.active ? h("div", { class: "chips" }, confChip("FAA", "high")) : null,
      rawToggle(x.title));
  }

  /** The FAA Command Center operations plan's items for this airport, as plain sentences. */
  function planItems(v, a, opts = {}) {
    const op = v.opsplan;
    if (!op || !(op.items || []).length) return [];
    const order = { program: 0, note: 1, staffing: 2, constraint: 3, sir: 4 };
    const items = [...op.items].sort((x, y) => (y.level - x.level) || ((order[x.kind] ?? 9) - (order[y.kind] ?? 9)));
    const lead = h("div", { class: "muted small", style: "margin:0 0 2px" },
      "From the FAA Command Center" + (op.plan && op.plan.issued ? " · plan issued " + whenLabel(Date.parse(op.plan.issued), dispTz(a)) : ""));
    return [lead, ...items.map((x) => h("div", { class: "item" + (x.level ? "" : " info") },
      x.level ? h("span", { class: "badge " + lv(x.level) }, LEVELS[x.level].label) : null,
      h("div", { class: x.level ? "" : "muted", style: x.level ? "margin-top:4px" : "" },
        retime(x.text, a) + (x.ifr ? " — can slow landings in low clouds or poor visibility" : "") + "." + (x.dup ? opts.dupNote || " Also in Delays & closures above." : "")
        + (opts.constraints && x.constraint ? " The plan's terminal constraint: " + x.constraint + "." : "")), // technical detail only (More details → FAA plan)
      aviation() && x.level ? h("div", { class: "chips" }, confChip("FAA", CATS.reason(x.text).conf || "high")) : null,
      opts.raw === false ? null : rawToggle(x.raw)))];
  }

  function lampTable(a, all) {
    const tz = dispTz(a);
    const t0 = Date.parse(a.hours[0].t);
    const hrs = (a.lamp.hours || []).filter((x) => { const t = Date.parse(x.t); return t >= t0 && t < t0 + 24 * HOUR; });
    if (!hrs.length) return null;
    const notable = hrs.some((x) => (x.tstmProb || 0) >= 10 || (x.convProb || 0) >= 30 || (x.pPrecip || 0) >= 30 || (x.gust || 0) >= 20 || (lampCat(x) && lampCat(x) !== "VFR"));
    if (!notable && !all) return null;
    const short = (ms) => tickLabel(ms, tz);
    const cell = (v, cls) => h("td", { class: cls || null }, v == null ? "" : String(v));
    const row = (label, f) => h("tr", {}, h("th", {}, label), hrs.map(f));
    const tcls = (p) => (p == null ? null : p >= 40 ? "l3 hot" : p >= 20 ? "l2 hot" : null);
    const table = h("table", { class: "lt" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), hrs.map((x) => h("th", {}, short(Date.parse(x.t)))))),
      h("tbody", {},
        hrs.some((x) => x.tstmProb != null) ? row("Thunder %", (x) => cell(x.tstmProb, tcls(x.tstmProb))) : null,
        hrs.some((x) => x.convProb != null) ? row("Storm %", (x) => cell(x.convProb)) : null,
        row("Precip %", (x) => cell(x.pPrecip)),
        row("Gust kt", (x) => cell(x.gust ? x.gust : null)),
        row("Category", (x) => { const c = lampCat(x); return h("td", {}, c ? h("span", { class: "fcd " + c, title: c }, c[0]) : ""); })));
    const two = hrs.some((x) => x.probHrs === 2);
    const note = hrs.some((x) => x.tstmProb != null)
      ? `Thunder %: chance of lightning in the ${two ? "2 hours" : "hour"} ending at that time. Storm %: chance of thunderstorms nearby.`
      : "No thunder chances are issued for this airport.";
    return [h("div", { class: "lamp" }, table), h("div", { class: "muted small", style: "margin:6px 4px 0" }, note)];
  }

  function checkedLine(a, details = false) {
    const d = state.data;
    const src = a?.coverage?.sources || (d && d.sources) || {};
    const warn = [];
    let any = false;
    for (const k of Object.keys(SOURCE_NAMES)) {
      const x = src[k];
      if (!x) continue;
      if (!x.ok) { warn.push(`${SOURCE_NAMES[k]} unavailable — ${SOURCE_MISSING[k]}`); continue; }
      any = true;
      if (x.error) warn.push(`${SOURCE_NAMES[k]} partly unavailable — ${SOURCE_MISSING[k]}`);
      else if (x.stale) warn.push(`${SOURCE_NAMES[k]}: live update unavailable — showing the last known data`);
    }
    if (noticesDown()) warn.push("Nearby flight restrictions unavailable"); // restrictions hook
    const when = state.sample ? "sample data" : d ? ago(Math.max(0, Date.now() - Date.parse(d.generated))) : "";
    if (d && !state.sample && refNow() - Date.parse(d.generated) > STALE_MS) warn.unshift("Data is " + when + " — status may have changed");
    const quality = a ? AWXOutlook.health(a, outlookOpts(a, view(a))) : null;
    if (state.offline) warn.unshift("Offline — last-known restrictions and weather; check your airline before travelling");
    if (quality?.missingWeather) warn.push("Recent weather observation unavailable for this airport");
    if (quality?.missingForecast) warn.push("Airport forecast unavailable or outdated");
    const dt = detailOf(a); // airport details: a failed or other-poll detail file is said, never shown as complete
    if (dt.status === "failed") warn.push(dt.have.cond ? "Some details unavailable — hourly storm chances couldn't load" : "Some details unavailable — hourly conditions, forecast text and delay explanations couldn't load");
    else if (dt.mismatch) warn.push("Some details are from another update (" + ago(Math.max(0, refNow() - Date.parse(dt.mismatch))) + ") than the status above");
    if (quality?.advisoriesAge && !quality.incomplete) warn.push("FAA Command Center advisories last updated " + ago(quality.advisoriesAge) + " — planned programs may have changed; current FAA delays are live");
    const airportAge = quality?.checked != null ? ago(Math.max(0, refNow() - quality.checked)) : when;
    const full = details || aviation();
    if (!full && !warn.length) return null;
    return h("div", { class: "checked" },
      warn.map((w) => h("p", { class: "warn" }, w)),
      full && any ? h("p", { class: "muted" }, (() => {
        const good = k => src[k]?.ok && !src[k].error && !src[k].stale;
        const checked = [good("faa") ? "FAA delay status" : null,
          ["metar", "taf", "nws"].every(good) ? "NOAA weather" : good("metar") ? "weather observations" : null].filter(Boolean);
        return checked.length ? "Checked " + checked.join(" and ") + (airportAge ? " · " + airportAge : "") : "Source coverage incomplete";
      })()) : null,
      full && quality ? h("p", { class: "muted" }, [quality.observed ? "Weather observed " + ago(Math.max(0, refNow() - quality.observed)) : null,
        quality.forecastIssued ? "Forecast issued " + ago(Math.max(0, refNow() - quality.forecastIssued)) : null].filter(Boolean).join(" · ")) : null);
  }

  /** Technical data is visible in Aviation mode, without expandable cards; the More details page shows it in both modes (opts.force, with the LAMP table even on quiet days). */
  function pilotDetails(a, opts = {}) {
    if (!aviation() && !opts.force) return null;
    const kids = [];
    const tz = dispTz(a);
    const zl = (ms) => clock(ms, tz) + " " + zoneAbbr(ms, tz);
    const sub = (t) => h("h4", { class: "pd-h" }, t);
    if (a.metar) {
      kids.push(reportHeading("Current METAR", "METAR"),
        h("div", { class: "box" }, h("dl", { class: "kv", style: "margin:0" }, metarRows(a.metar))),
        a.metar.obsTime ? h("div", { class: "muted small", style: "margin:6px 4px 0" }, "Observed " + ago(Math.max(0, refNow() - Date.parse(a.metar.obsTime))) + " · " + zl(Date.parse(a.metar.obsTime))) : null,
        h("pre", { class: "raw", style: "margin-top:10px" }, a.metar.raw));
    }
    const have = detailOf(a).have; // airport details: TAF text and LAMP come with the detail file
    if (a.taf) kids.push(have.taf ? tafForecast(a, { raw: true }) : detailWait(a, "the TAF"));
    const lt = have.lamp && a.lamp ? lampTable(a, opts.force) : null;
    if (lt) kids.push(sub("LAMP guidance · issued " + zl(Date.parse(a.lamp.issued))), ...lt);
    else if (!have.lamp) kids.push(detailWait(a, "LAMP guidance"));
    if (a.sigmets && a.sigmets.length) kids.push(sub("Convective SIGMETs"), ...a.sigmets.map((x) => h("pre", { class: "raw", style: "margin-top:6px" }, x.raw)));
    if (a.cwa && a.cwa.length) kids.push(sub("Center weather advisories"), ...a.cwa.map((x) => h("div", { class: "item" },
      h("b", {}, x.hazard ? "CWA · " + x.hazard : "CWA"),
      x.validTo ? h("span", { class: "muted" }, " · until " + whenLabel(Date.parse(x.validTo), tz)) : null,
      x.raw ? h("pre", { class: "raw", style: "margin-top:6px" }, x.raw) : null)));
    if (a.tcf && a.tcf.length) kids.push(sub("TFM convective forecast"), ...a.tcf.map((x) => h("div", { class: "item" },
      h("b", {}, cap(x.coverageRaw || x.coverage || "Unknown") + " coverage"),
      h("span", { class: "muted" }, [x.valid && " · valid " + whenLabel(Date.parse(x.valid), tz), x.confidence && " · confidence " + String(x.confidence).toLowerCase(), x.tops && " · tops " + x.tops].filter(Boolean).join("")))));
    if (!kids.length) return null;
    return section(opts.title || "Pilot details", "plane", [h("div", { class: "pd" }, ...kids)], null, { cls: "pilot" });
  }

  // ---------- Now / Peak / Hour cards (one structure, build2b) ----------

  const FC_EXPLAIN = {
    VFR: "Skies and visibility are clear enough for normal operations. Flights are usually unaffected.",
    MVFR: "Visibility is good but not totally clear. Flights are usually unaffected.",
    IFR: "Low clouds or poor visibility. Arrivals may be slowed and delays are possible.",
    LIFR: "Very low clouds or very poor visibility. Arrivals are often slowed; delays are likely.",
  };
  const fcChip = (c) => (c ? h("span", { class: "fc " + c }, c) : null);
  function precipWord(c, lamp) {
    const wx = String((c && c.wx) || "");
    if (/TS/.test(wx) && !/VCTS/.test(wx)) return "Thunderstorms";
    if (/FZRA|FZDZ/.test(wx)) return "Freezing rain";
    if (/PL/.test(wx)) return "Sleet";
    if (/SN/.test(wx)) return "Snow";
    if (/RA|SH/.test(wx)) return "Rain";
    if (/DZ/.test(wx)) return "Drizzle";
    if (lamp && (lamp.pPrecip || 0) >= 30) return { R: "Rain likely", S: "Snow likely", Z: "Freezing rain likely" }[lamp.typ] || "Precipitation likely";
    return null;
  }
  /** Facts row: temperature, wind/gusts mph, precip type, thunder chance (+ category, ceiling, visibility, wind kt in Aviation mode). */
  function factsRow(c, a, t, past, compact) {
    const f = [];
    const lamp = past ? null : lampAt(a, t);
    if (c && c.temp != null) f.push(h("span", {}, f1(c.temp) + "°F"));
    if (c && c.wspd != null) f.push(h("span", {}, c.wspd === 0 ? "Calm" : "Wind " + mph1(c.wspd) + (c.wgst != null ? "–" + mph1(c.wgst) : "") + " mph"));
    const p = precipWord(c, compact ? null : lamp); // compact: observed / forecast precipitation only
    if (p) f.push(h("span", {}, p));
    const th = past || compact ? null : lampThunderAt(a, t);
    if (th != null && th > 0) f.push(h("span", {}, "Thunder chance " + (th >= 40 ? "high" : th >= 20 ? "some" : "low")));
    if (aviation() && c) {
      const cat = c.fltCat || null;
      if (cat) f.push(fcChip(cat));
      f.push(h("span", { class: "mono" }, c.cig != null ? c.cig.toLocaleString("en-US") + " ft" : "No ceiling"));
      if (c.vis != null) f.push(h("span", { class: "mono" }, visTxt(c.vis)));
      const w = windKt(c);
      if (w) f.push(h("span", { class: "mono" }, w));
    }
    return f.length ? h("div", { class: "facts" }, f) : null;
  }
  /** Distinct sources (with their best confidence) behind a card's reasons and facts. */
  function cardSources(reasons, kind) {
    const rank = { low: 0, medium: 1, high: 2 };
    const m = new Map();
    const add = (src, conf) => { if (!m.has(src) || rank[conf] > rank[m.get(src)]) m.set(src, conf); };
    for (const r of reasons || []) {
      const c = CATS.reason(r);
      if (c.src) add(c.src, c.conf || "medium");
      else if (kind === "obs" || kind === "now") add("METAR", "high");
      else add("TAF", /^Chance of /.test(r) ? "low" : "medium");
    }
    if (!m.size) add(kind === "obs" || kind === "now" ? "METAR" : "TAF", kind === "obs" || kind === "now" ? "high" : "medium");
    return [...m.entries()];
  }
  /** One state card (Now, Peak, Now · Peak, or an hour): label + pill, time line, delay chance, reasons, FAA status, impact, facts, chips. */
  function stateCard(o) {
    const a = o.a;
    const max = o.full ? 3 : 2;
    const progTxt = o.programs && o.programs.length ? uniq(o.programs.map((f) => programLine(f, a))) : [];
    const others = o.programs && o.programs.length ? o.reasons.filter((r) => !/^(Ground stop|Ground delay program|Delays\b|Airport closed)/.test(r)) : o.reasons;
    const rs = uniq(o.simple ? [...progTxt, ...others] : others).slice(0, max);
    const L = o.delay && o.delay.p != null && window.AWXDelay && AWXDelay.likelihood ? safeCall(() => AWXDelay.likelihood(o.delay, { iata: a.iata })) : null;
    const meaningful = L && (aviation() || AWXDelay.notable(o.delay, o.level, L));
    const normal = o.level === 0 && !progTxt.length && !meaningful && !o.empty;
    const shared = o.outlook;
    // a quiet status with missing data: a short headline ("No disruptions reported"); its qualifier is said once, in the small line above
    const qual = shared && shared.kind === "unknown" ? /^(No disruptions reported) · (.+)$/.exec(shared.headline) : null;
    const status = qual ? qual[1] : shared ? shared.headline : normal ? o.normalNote || (o.kind === "hour" && o.past ? "No disruption reported" : o.kind === "peak" || o.kind === "hour" && !o.isNow ? "No disruption expected" : "No airport-wide disruptions reported")
      : meaningful ? L.word : o.level > 0 ? o.level === 1 ? "Minor flight disruption possible" : "Disruption possible" : null;
    // the sheet's headline (o.big): the status in large level-coloured type; the delay outlook (o.lead) joins it
    // when it says the same thing ("Flight delays likely" + "5–9 PM"), else follows as a "Later" line
    const lead = o.lead;
    const separateAhead = o.detachAhead === true;
    const bare = (x) => String(x || "").replace(/ \(\d+%\)$/, ""); // Aviation words carry the chance: "Flight delays likely (62%)"
    const merged = lead && bare(status) === lead.word;
    const headLevel = shared?.kind === "unknown" ? null : shared?.level ?? o.level;
    const hcls = (o.big ? " sc-big" : "") + (headLevel != null ? " lv" + Math.max(0, Math.min(4, headLevel)) : "");
    const delay = status ? h("div", { class: "sc-head" + hcls, "data-level": headLevel }, h("span", { class: "sc-delay" }, status), !separateAhead && merged && lead.when ? h("span", { class: "sc-hwhen" }, lead.when) : null) : null;
    const leadSub = lead ? cap([lead.cue, lead.size ? "When disrupted: " + lead.size : ""].filter(Boolean).join(" · ")) : "";
    // "Looking ahead": one compact list under the current status — the delay outlook (when it isn't already the
    // headline), then improvements, scheduled ends and FAA extension outlooks; each bullet's dot carries its colour
    const leadNotes = lead ? [aviation() ? leadSub : lead.size ? "When disrupted: " + lead.size : null, ...lead.notes].filter(Boolean) : [];
    const primaryProgram = !aviation() && o.simple && shared?.programs.length === 1 && shared.programs[0].type !== "closure";
    const cause = primaryProgram ? plainCause(shared.programs[0]).toLowerCase() : "";
    const extraReasons = primaryProgram ? shortList(others, a).filter((r) => !cause || !r.toLowerCase().includes(cause) || /\d/.test(r)).slice(0, max) : [];
    // The Now card adds details only for disruptions, specific alerts, data warnings or meaningful changes.
    const blurb = o.blurb && window.AWXNowBlurb ? safeCall(() => AWXNowBlurb.build({ ...o.blurb, headline: status, kind: shared ? shared.kind : o.level > 0 ? "forecast" : "normal",
      level: headLevel, quality: shared ? shared.quality : "",
      programText: primaryProgram ? faaText(shared.programs[0], true, shared.current, true) : progTxt.map((t) => t.replace(/ until further notice/, "")).join("; "), // the header already says "FAA gives no end time"
      reasons: primaryProgram ? extraReasons : shortList(others, a).slice(0, 3) })) : null;
    const blurbEl = blurb && (blurb.specifics || blurb.trend) ? h("div", { class: "sc-blurb" }, blurb.specifics ? h("p", { class: "sc-spec" }, blurb.specifics) : null, blurb.trend ? h("p", { class: "sc-trend" }, blurb.trend) : null) : null;
    const ahead = [];
    // a later, higher risk window (o.peak) comes first; the delay outlook joins it when they say the same thing
    const pk = o.peak;
    const pkMerged = pk && lead && !merged && bare(pk.headline) === lead.word;
    if (pk) ahead.push(h("li", { class: "la-i", "data-when": pk.when || "Forecast" }, h("span", { class: "la-dot la-lv" + pk.level, "aria-hidden": "true" }),
      h("span", {}, h("b", { class: "la-lv" + pk.level, "data-level": pk.level }, pk.headline), !separateAhead && pk.when ? " " + pk.when : "",
        pk.reasons.length ? h("span", { class: "la-sub" }, pk.reasons.join(" · ")) : null,
        ...(pkMerged ? leadNotes : []).map((n) => h("span", { class: "la-sub" }, n)))));
    if (lead && (separateAhead || !merged) && !pkMerged) ahead.push(h("li", { class: "la-i", "data-when": lead.when || "Forecast" }, h("span", { class: "la-dot " + lead.cls, "aria-hidden": "true" }),
      h("span", {}, h("b", { class: lead.cls }, lead.word), !separateAhead && lead.when ? " " + lead.when : "", ...leadNotes.map((n) => h("span", { class: "la-sub" }, n)))));
    const AHEAD = { "Forecast improvement": (v) => v, "Scheduled end": (v) => "FAA scheduled end " + v, "FAA extension outlook": (v) => "FAA extension outlook: " + v };
    for (const r of (o.rows || []).filter((r) => !(blurb && blurb.improvement && r.label === "Forecast improvement"))) ahead.push(h("li", { class: "la-i", "data-when": ({ "Forecast improvement": "Forecast", "Scheduled end": "FAA end", "FAA extension outlook": "Outlook" })[r.label] || r.label }, h("span", { class: "la-dot" + (r.label === "Forecast improvement" ? " la-good" : ""), "aria-hidden": "true" }),
      h("span", {}, (AHEAD[r.label] || ((v) => r.label + ": " + v))(r.value))));
    const leadEl = !separateAhead && merged && leadNotes.length ? h("div", { class: "sc-lead" }, leadNotes.map((n) => h("div", { class: "sc-lsub" }, n))) : null;
    const aheadEl = ahead.length ? h("div", { class: "sc-ahead" }, h("div", { class: "la-h" }, "Looking ahead"), h("ul", { class: "la-list" }, ahead)) : null;
    const list = blurbEl ? blurbEl : primaryProgram ? h("div", {}, faaItem(shared.programs[0], a, true, shared.current), extraReasons.length ? h("p", { class: "rline" }, extraReasons.join(" · ")) : null) : normal ? null : rs.length
      ? o.full ? h("p", { class: "rline" }, rs.join(" · ")) : h("ul", { class: "reasons" }, rs.map((r) => h("li", {}, r)))
      : o.empty ? h("div", { class: "none" }, o.empty) : null;
    // program status and the departure/arrival impact share one line; with source chips only in full-width cards
    const prog = o.programs && o.programs.length ? o.programs.map((f) => programLine(f, a)).join(" · ") : "";
    const imp = o.impact && prog ? o.impact.replace(/ \([^)]*\)$/, "") : o.impact;
    const progLine = o.simple ? null : o.full && (prog || imp) ? h("div", { class: "sc-prog" }, prog, prog && imp ? h("span", { class: "sc-imp" }, " · " + imp) : !prog ? h("span", { class: "sc-imp" }, imp) : null)
      : !o.full && prog ? h("div", { class: "sc-prog" }, prog) : null;
    const programStart = primaryProgram && !shared.current && Date.parse(shared.programs[0].start);
    const startText = Number.isFinite(programStart) ? "From " + faaUntil(programStart, a) + " · " : "";
    const low = (x) => (/^[A-Z][a-z]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
    const qualWhen = qual ? cap(uniq([low(String(o.when || "").replace(/^Nearby flight/, "flight")), low(qual[2])].filter(Boolean)).join(" · ")) : null;
    const when = primaryProgram ? startText + (shared.scheduledEnd ? "Until " + faaUntil(shared.scheduledEnd, a) + " · may change" : NO_END) : qualWhen || o.when;
    const card = h("div", { class: "box sc" + (o.full ? " full" : ""), "data-kind": o.kind, "data-layout": o.layout },
      h("div", { class: "sc-h" },
        h("h4", {}, h("span", { class: "sc-label" }, o.label), (o.full || o.simple) && when ? h("span", { class: "sc-when in" }, when) : null)),
      !o.full && !o.simple && o.when ? h("div", { class: "sc-when" }, o.when) : null,
      delay,
      list,
      leadEl,
      o.big ? o.cur : null, // current conditions under the Now status, mid-screen where they're easy to tap
      separateAhead ? null : aheadEl,
      progLine,
      o.simple ? null : o.facts);
    if (separateAhead && ahead.length) {
      const rows = ahead.map(row => {
        const dot = row.firstElementChild, content = row.lastElementChild;
        dot.remove();
        row.classList.remove("la-i");
        row.replaceChildren(h("div", { class: "lg-entry" },
          h("span", { class: "lg-t" }, row.dataset.when),
          h("span", { class: "lg-s" }, content)));
        return row;
      });
      card._aheadSection = section("Looking ahead", "clock", [h("ul", { class: "sh-log" }, rows)], null, { id: "lookingAhead", cls: "logcard ahead-card" });
    }
    return card;
  }

  const outlookOpts = (a, v) => ({ now: refNow(), tz: a.tz, generated: state.data?.generated, sources: state.data?.sources, sample: state.sample, offline: state.offline, noticesDown: noticesDown(),
    hidden: v.hiddenCats?.size, plain: (r) => plainReason(shortRaw(r), a),
    words: (d) => window.AWXDelay?.likelihood(d, { iata: a.iata, aviation: aviation() }), notable: window.AWXDelay?.notable });
  function outlook(a, at = refNow()) {
    const v = a.hours?.length ? view(a) : a;
    return AWXOutlook.evaluate(v, { ...outlookOpts(a, v), at });
  }
  /**
   * The airport's one level (site/outlook.js summary): the home card's pill and text, the sheet's headline, the
   * national panel, the lists' sorting and At risk, the brief and trips all read it, so they never disagree.
   * Cached per view and minute.
   */
  let sumCache = new WeakMap();
  function summary(a) {
    const v = a.hours?.length ? view(a) : a;
    const k = Math.floor(refNow() / 60e3) + "|" + S.mode + "|" + (state.data && state.data.generated) + "|" + (window.AWXDelay?.revision || 0) + "|" + !!state.offline + "|" + !!state.sample + "|" + !!noticesDown();
    const c = sumCache.get(v);
    if (c && c.k === k) return c.s;
    const sm = AWXOutlook.summary(v, outlookOpts(a, v));
    sumCache.set(v, { k, s: sm });
    return sm;
  }
  const levelOf = (a) => summary(a).level || 0;
  /**
   * The display level of one forecast hour x (an entry of the airport's hours): weather/FAA level raised by its delay
   * words and FAA restrictions (outlook.js levelAt), the same number the headline, map and brief use.
   */
  function hourLevel(a, x, isNow) {
    if (!x) return null;
    const sm = summary(a);
    const hit = sm.byT && sm.byT.get(x.t);
    if (hit != null) return hit;
    const v = a.hours?.length ? view(a) : a;
    const now = refNow();
    return AWXOutlook.levelAt(v, x, outlookOpts(a, v), isNow ? now : Math.max(Date.parse(x.t), now), now);
  }
  /** The hour holding now and its reasons (the poller's `now` while its first hour is still current). */
  function nowHourOf(a, v, sm) {
    const x = sm.nowHour || v.hours[0];
    return { x, reasons: x === v.hours[0] ? v.now.reasons : x.reasons };
  }
  /** Local hour 0–23 of ms in tz. */
  function localHour(ms, tz) {
    const parts = fmt(tz, { hour: "numeric" }, "H24n").formatToParts(ms);
    const hour = Number(parts.find((x) => x.type === "hour").value);
    return S.clock === "24" ? hour % 24 : hour % 12 + (parts.some((x) => x.type === "dayPeriod" && /PM/i.test(x.value)) ? 12 : 0);
  }
  const PART_WORD = (hr) => (hr >= 5 && hr < 12 ? "Busy morning" : hr >= 12 && hr < 17 ? "Busy afternoon" : hr >= 17 && hr < 21 ? "Busy evening" : hr >= 21 ? "Busy night" : "Busy late night");
  const RAISE_WORD = { possible: "delays possible", likely: "delays likely", very: "delays very likely" };
  const NOW_WORD = { ground_stop: "FAA ground stop in effect", ground_delay: "FAA delay program in effect", delay: "FAA-reported delays in effect", closure: "Airport closed" };
  /**
   * An hour's reasons with its cause said when the delay chance, not the weather, sets its colour (or nothing else
   * explains it): "Busy evening — delays likely", "Delays at ORD may spread here", "FAA ground stop in effect".
   * A coloured hour never reads "No significant weather".
   */
  function hourReasons(a, x, level, reasons) {
    const rs = reasons || (x && x.reasons) || [];
    if (!x || !level) return rs;
    const v = a.hours?.length ? view(a) : a;
    const sc = AWXOutlook.score(x, outlookOpts(a, v));
    const plain = plainList(rs, a);
    if (plain.length && !sc.raised) return rs;
    const now = refNow();
    const prog = AWXOutlook.restrictions(v, Math.max(Date.parse(x.t), now), now)[0];
    let why = null;
    if (sc.L && sc.L.key === "now") why = NOW_WORD[x.delay && x.delay.override] || "FAA-reported delays in effect";
    else if (prog && !plain.length) why = NOW_WORD[prog.type] || "FAA-reported delays in effect";
    else {
      const hub = (v.cascade || []).find((c) => rs.some((r) => String(r || "").indexOf(c.hub + " ") === 0));
      if (hub) why = "Delays at " + hub.hub + " may spread here";
      else if (sc.L && RAISE_WORD[sc.L.key]) {
        why = PART_WORD(localHour(Date.parse(x.t), a.tz || "UTC")) + " — " + RAISE_WORD[sc.L.key];
      } else if (!plain.length) why = "Minor weather conditions";
    }
    return why ? [why, ...rs.filter((r) => r !== why)] : rs;
  }
  /** Words for a level window, the same as the sheet's headline: "Flight delays likely", "Delays happening now". */
  function levelWords(level, words, hour) {
    if (words) return words.key === "now" ? words.word : words.word.replace(/^Delays/, "Flight delays");
    return level > 0 ? AWXOutlook.conditionHeadline(hour) : "";
  }
  /** " EDT" when the airport's display zone isn't the device's, else "" (card and brief times). */
  function zoneTag(a, ms = refNow()) {
    const tz = dispTz(a);
    const z = zoneAbbr(ms, tz);
    return z && z !== zoneAbbr(ms, USER_TZ) ? " " + z : "";
  }
  /**
   * One range helper for the card, the sheet and the brief: "4–7 PM", "tomorrow 2–5 AM", "11 PM – 1 AM tomorrow",
   * and "through 9 PM" when the window has already started.
   */
  function rangeText(start, end, tz) {
    start = hourFloor(start, tz); end = hourFloor(end, tz); // forecast hours: on the hour
    if (start <= refNow()) return "through " + whenLabel(end, tz);
    const sa = clock(start, tz), sb = clock(end, tz);
    const w = whenLabel(start, tz);
    const prefix = w.endsWith(sa) ? w.slice(0, w.length - sa.length) : "";
    const half = (x) => x.split(" ").pop();
    const endDay = dayKey(end - 1, tz); // a window ending at midnight stays on its day ("7 PM – 12 AM")
    if (dayKey(start, tz) === endDay && S.clock !== "24" && / [AP]M$/.test(sa) && half(sa) === half(sb)) return prefix + sa.slice(0, sa.lastIndexOf(" ")) + "–" + sb;
    if (dayKey(start, tz) === endDay) return prefix + sa + " – " + sb;
    const wb = whenLabel(end, tz); // "tomorrow 1 AM", "Mon 1 AM"
    return prefix + sa + " – " + (/^\d/.test(wb) ? wb : sb + " " + wb.slice(0, wb.indexOf(" ")));
  }
  /** "FAA gives no end time" when an FAA program in force has none (its 3–5 hour hold in the hour levels isn't an end). */
  const NO_END = "FAA gives no end time";
  /** The outlook's what-happens-next rows ({label, value}): direction impacts, scheduled end, FAA extension outlook, forecast improvement. */
  function travelRows(a, lead = null) {
    // the forecast improvement never falls inside the delay window shown above it (lead: AWXDelay.outlookLead)
    const v = a.hours?.length ? view(a) : a;
    const o = AWXOutlook.evaluate(v, { ...outlookOpts(a, v), at: refNow(), notBefore: lead && Number.isFinite(lead.end) ? lead.end : undefined });
    const covered = o.programs.length === 1 && o.programs[0].type !== "closure"; // its end and average are already in the card
    const rows = covered ? [] : o.impacts.map((r) => ({ label: r.label, value: r.value }));
    if (o.scheduledEnd && !covered) rows.push({ label: "Scheduled end", value: faaUntil(o.scheduledEnd, a) + " · may change" });
    if (o.extension) rows.push({ label: "FAA extension outlook", value: cap(o.extension) });
    rows.eval = o; // the Now card's trend reads the same recovery/eases (site/nowblurb.js)
    if (o.recovery) rows.push({ label: "Forecast improvement", value: "Lower disruption risk forecast after " + whenLabel(hourFloor(o.recovery, dispTz(a)), dispTz(a)) });
    else if (o.eases) rows.push({ label: "Forecast improvement", value: "Eases to " + LEVELS[o.eases.level].label + " after " + whenLabel(hourFloor(o.eases.at, dispTz(a)), dispTz(a)) });
    return rows;
  }

  let sheetDay = 0; // 0 rolling window, 1 tomorrow
  function renderSheet(keepScroll) {
    const a0 = state.data && state.data.airports.find((x) => x.iata === state.openIata);
    const sheet = $("sheet");
    if (!a0) { closeSheet(); return; }
    const D = withDetail(a0); // airport details: hour conditions wait for the detail file (never shown as "no weather")
    const a = D.a;
    const top = sheet.scrollTop;
    const focusedDetail = keepScroll && sheet.contains(document.activeElement) ? document.activeElement.dataset.detail : null;
    const v = view(a);
    const tz = dispTz(a);
    const fav = state.favs.includes(a.iata);
    const code = codeOf(a);
    const t0 = Date.parse(v.hours[0].t);
    const nowCond = Object.assign({}, v.hours[0], a.metar ? metarCond(a.metar) : {}, { fltCat: (a.metar && a.metar.fltCat) || v.hours[0].fltCat });
    const sm = summary(a); // the card's level and window: the headline here always matches it
    const later = sm.later;
    const layout = CATS.restLayout(sm.nowLevel, sm.level, later);
    const lastMs = Date.parse(v.hours[v.hours.length - 1].t) + HOUR;
    const nowPrograms = programsAt(v, t0, true);
    const health = AWXOutlook.health(a, outlookOpts(a, v));
    const incomplete = health.incomplete;
    const stale = health.outdated;
    const normalNote = state.offline ? "Offline · status unconfirmed" : stale ? "Status may be outdated" : incomplete ? "No disruptions reported · some data unavailable"
      : v.hiddenCats && v.hiddenCats.size ? "No issues in your selected categories" : noticesDown() ? "No disruptions reported · flight restrictions unavailable" : null;
    // the current run: "through 3 PM, then Clear" — or, for an FAA program with no stated end, "— FAA gives no end time"
    const nowWhen = () => (sm.open ? "— " + NO_END : "through " + whenLabel(hourFloor(sm.nowEnd || lastMs, tz), tz) + (sm.next != null ? ", then " + LEVELS[sm.next].label : ""));

    // the headline: the delay outlook and what happens next sit in the top card, not in cards further down
    const lead = window.AWXDelay && typeof AWXDelay.outlookLead === "function" ?safeCall(() => AWXDelay.outlookLead(a)) : null; // phase3 hook
    const nextRows = safeCall(() => travelRows(a, lead)) || [];
    // each fact once: reasons with their own card further down (Weather warnings, FAA traffic notices) or said by the blurb's storm part stay out of the Now card's reasons
    const planTexts = new Set(((v.opsplan && v.opsplan.items) || []).filter((x) => aviation() || x.level > 0 && !x.dup).map((x) => String(x.text || "").replace(/\.$/, "")));
    const ownCard = (r) => {
      const s = String(r || "");
      if ((v.alerts || []).some((x) => x.event && s.indexOf(x.event) === 0)) return true;
      if (a.metar && /^Visibility\b/i.test(s)) return true; // the current-conditions line already gives the visibility
      if ((v.sigmets || []).length && /^Convective SIGMET\b/.test(s) || v.spc && CATS.reason(s).src === "SPC" || (v.tcf || []).length && /\(TCF\)/.test(s)) return true; // the blurb's storm part says them
      return planTexts.has(s.replace(/\.$/, ""));
    };
    const notOwn = (rs) => (rs || []).filter((r) => !ownCard(r));
    // the Now card's blurb (site/nowblurb.js): everything it words is already computed here
    const m0 = a.metar, obs0 = m0 && Date.parse(m0.obsTime);
    const metarOk = !!m0 && Number.isFinite(obs0) && refNow() - obs0 <= 2 * HOUR && obs0 - refNow() <= 10 * 60000;
    const ev0 = nextRows.eval || null;
    const blurbIn = (nowO) => ({ aviation: aviation(), now: refNow(), tz, stale: !!(stale || state.offline), noForecast: nowO.kind === "unknown" && /^Forecast unavailable/.test(nowO.headline),
      cond: metarOk ? { windMph: m0.wind && m0.wind.spd != null ? mph1(m0.wind.spd) : null, gustMph: m0.gust != null ? mph1(m0.gust) : null,
        visMi: m0.visib != null ? visNum(String(m0.visib).replace("+", "")) : null, ceilingFt: m0.ceiling != null ? m0.ceiling : null } : null,
      storms: { near: (v.sigmets || []).length > 0, until: stormEnd(v), spc: v.spc || null, tcf: v.tcf || [] },
      warnings: (v.alerts || []).map((x) => x.event), recovery: ev0 && ev0.recovery, eases: ev0 && ev0.eases, open: !!sm.open,
      weatherCause: nowO.programs.length > 0 && nowO.programs.every((f) => f.cause === "weather"), laterPeak: layout === "split", levels: sm.levels,
      events: window.AWXBrief && typeof AWXBrief.todayEvents === "function" ? (safeCall(() => AWXBrief.todayEvents(a)) || []).filter((e) => e.kind === "level") : [],
      fmt: { when: (ms) => whenLabel(ms, tz), clock: (ms) => clock(ms, tz, true), floor: (ms) => hourFloor(ms, tz) } });
    let lookingAhead = null;
    const restCard = options => {
      const card = stateCard({ ...options, detachAhead: true });
      lookingAhead = card._aheadSection || null;
      return card;
    };
    // rest state: one full-width "Now" card; a later, higher risk ("split" in CATS.restLayout) leads its Looking ahead list
    const restCards = () => {
      if (layout === "split") {
        const pk = sm.peakHour || v.hours[0];
        const pt = Date.parse(pk.t);
        const nowO = outlook(a);
        const pkO = outlook(a, pt);
        const peak = { headline: pkO.headline, level: sm.level, when: rangeText(sm.start, sm.end, tz),
          reasons: shortList(notOwn(hourReasons(a, pk, sm.level)), a).filter((r) => r !== pkO.headline && !/^(Ground stop|Ground delay program|Delays\b|Airport closed)/.test(r)).slice(0, 2) };
        return restCard({ a, layout, kind: "nowpeak", full: true, simple: true, big: true, cur: safeCall(() => currentLine(a)), lead, peak, rows: nextRows, label: "Now", outlook: nowO, level: sm.nowLevel, blurb: blurbIn(nowO),
          when: nowO.kind === "unknown" ? nowO.quality || "Forecast unavailable" : sm.open ? NO_END : aviation() || nowO.level > 0 ? "through " + whenLabel(hourFloor(sm.nowEnd, tz), tz) : "", delay: v.hours[0].delay,
          normalNote, reasons: shortList(notOwn(((n) => hourReasons(a, n.x, sm.nowLevel, n.reasons))(nowHourOf(a, v, sm))), a), programs: nowPrograms, impact: CATS.impact(v.now.reasons, nowPrograms), facts: factsRow(nowCond, a, t0, false, true),
          chips: cardSources(v.now.reasons, "now"), empty: null });
      }
      const currentOutlook = outlook(a);
      // "Clear through" the end of forecast coverage: hours no forecast covers are unknown, never Clear
      const gap = sm.levels.findIndex((x) => x.level == null);
      const clearEnd = gap > 0 ? Date.parse(sm.levels[gap].t) : lastMs;
      let when = layout === "clear" ? (aviation() ? "Clear through " + whenLabel(hourFloor(clearEnd, tz), tz) : "") : nowWhen();
      if (currentOutlook.kind === "unknown") when = currentOutlook.quality || "Forecast unavailable";
      else if (layout === "clear" && currentOutlook.kind !== "normal") when = "This hour";
      return restCard({ a, layout, kind: "nowpeak", full: true, simple: true, big: true, cur: safeCall(() => currentLine(a)), lead, rows: nextRows, label: "Now", outlook: currentOutlook, level: sm.nowLevel, blurb: blurbIn(currentOutlook), when, delay: v.hours[0].delay,
        normalNote, reasons: shortList(notOwn(((n) => hourReasons(a, n.x, sm.nowLevel, n.reasons))(nowHourOf(a, v, sm))), a), programs: nowPrograms, impact: CATS.impact(v.now.reasons, nowPrograms), facts: factsRow(nowCond, a, t0, false, true),
        chips: cardSources(v.now.reasons, "now"), empty: null });
    };
    const hourCard = (s) => {
      const isNow = s.kind === "now";
      const past = s.kind === "obs" || s.kind === "none";
      const c = s.h ? (isNow ? nowCond : D.have.cond ? s.h : null) : null;
      const label = cap(whenLabel(s.t, tz));
      const zulu = aviation() ? " · " + new Date(s.t).toISOString().slice(11, 13) + "00Z" : "";
      const when = (s.kind === "obs" ? (s.observed ? "Observed" : "Earlier forecast") : s.kind === "none" ? "No report" : s.kind === "na" ? "No forecast" : isNow ? "Now" : "Forecast") + zulu;
      const progs = past || s.kind === "na" ? [] : programsAt(v, s.key, isNow);
      const unsure = !past && !isNow && sm.uncertainFrom != null && s.key >= sm.uncertainFrom && s.level != null && s.level < sm.openLevel;
      return stateCard({ a, kind: "hour", past, normalNote: isNow ? normalNote : unsure ? NO_END + " — the program may still be in place" : null, isNow, full: true, simple: !aviation(), max: 3, label, level: s.level, when, delay: !past && s.h ? s.h.delay : null,
        reasons: shortList(s.reasons, a), programs: progs, impact: s.level == null ? null : CATS.impact(s.reasons, progs),
        facts: c ? factsRow(c, a, s.key, past, true) : null, chips: s.level == null ? [] : cardSources(s.reasons, s.kind),
        empty: s.kind === "none" ? "No weather report for this hour" : s.kind === "na" ? "No forecast for this hour" : null });
    };

    const boxWrap = h("div", { class: "boxwrap", "aria-live": "polite" });
    let tlEl = null;
    let previewSlots = new Map();
    const setLayer = (i, live) => {
      boxWrap.classList.toggle("live", !!live);
      if (i != null && !boxWrap.querySelector(`[data-i="${i}"]`)) {
        const slot = previewSlots.get(i);
        if (slot) boxWrap.append(h("div", { class: "bx-layer", "data-i": String(i), "aria-hidden": "true" }, hourCard(slot)));
      }
      for (const L of boxWrap.children) {
        const on = i == null ? L.dataset.layer === "rest" : L.dataset.i === String(i);
        L.classList.toggle("on", on);
        L.setAttribute("aria-hidden", String(!on));
        if (on && i != null) L.scrollTop = 0;
      }
    };
    const buildLayers = (slots) => {
      previewSlots = new Map(slots.map(s => [s.i, s]));
      boxWrap.replaceChildren(h("div", { class: "bx-layer on", "data-layer": "rest" }, restCards()),
        ...(aviation() ? slots.map((s) => h("div", { class: "bx-layer", "data-i": String(s.i), "aria-hidden": "true" }, hourCard(s))) : []));
    };
    const onRelease = () => setLayer(null, false);
    const onPreview = (i) => setLayer(i, true);
    const makeTl = () => {
      tlEl = timeline(a, { big: true, dayOff: sheetDay, onRelease, onPreview });
      buildLayers(tlEl._tl.slots);
      if (sheetDay) tlEl._tl.rest = -1;
      return tlEl;
    };
    const tlHolder = h("div", { class: "tlhold" }, makeTl());
    const dayBtn = h("button", { type: "button", class: "daybtn", "aria-pressed": String(sheetDay === 1),
      onclick: () => {
        sheetDay = sheetDay ? 0 : 1;
        tlHolder.replaceChildren(makeTl());
        dayBtn.textContent = sheetDay ? "‹ Now" : "Tomorrow ›";
        dayBtn.setAttribute("aria-pressed", String(sheetDay === 1));
        tlTitle.textContent = sheetDay ? "Tomorrow" : "Past 12 h · Next 24 h";
        if (window.AWXTrips) safeCall(() => window.AWXTrips.decorateSheet(sheet, a)); // trips hook: plane markers on the shown day
        scheduleLenses();
      } }, sheetDay ? "‹ Now" : "Tomorrow ›");
    const tlTitle = h("span", {}, sheetDay ? "Tomorrow" : "Past 12 h · Next 24 h");

    // detail cards (build2b), each only when it has content
    const secs = [];
    const add = (cond, fn) => { if (cond) secs.push(fn()); };
    const primary = outlook(a).programs;
    const covered = !aviation() && primary.length === 1 && primary[0].type !== "closure" ? primary : [];
    const sameProgram = (f) => covered.some((p) => p.type === f.type && (p.end || null) === (f.end || null) && f.active !== false && f.scope !== "limited" && f.scope !== "runway");
    const extraFaa = (v.faa || []).filter((f) => !sameProgram(f));
    add(extraFaa.length, () => section("Delays & closures", "clock", extraFaa.map((f) => faaItem(f, a)), { key: "faa" }));
    const extraAdvisory = (x) => {
      if (aviation()) return true;
      if (x.cnx || !x.active && !(Date.parse(x.start) > refNow())) return false;
      const type = { GS: "ground_stop", GDP: "ground_delay" }[x.type] || x.type;
      const repeated = x.active && sameProgram({ type, end: x.end });
      const cause = x.causeLabel || x.causeText || "";
      return !repeated || !!cause && cause.toLowerCase() !== plainCause(covered[0]).toLowerCase();
    };
    const notices = [...[...(v.atcscc || [])].filter(extraAdvisory).sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0)).map((x) => advItem(x, a)),
      ...planItems(aviation() ? v : { ...v, opsplan: v.opsplan ? { ...v.opsplan, items: (v.opsplan.items || []).filter((x) => x.level > 0 && !x.dup) } : null }, a)];
    add(notices.length, () => section("FAA traffic notices", "tower", notices, { key: "atcscc" }));
    const noticeContext = { h, section, aviation: aviation(), retime: (t) => retime(t, a), hidden: isHidden, now: refNow(), sources: state.data.noticeSources || {} };
    const informationalNotices = window.AWXNotices ? AWXNotices.visible(v.notices, noticeContext).some((x) => x.peak === 0 && x.cat !== "always") : false;
    const primaryNotices = v.notices ? { ...v.notices, items: (v.notices.items || []).filter((x) => x.peak !== 0 || x.cat === "always") } : null;
    if (primaryNotices) primaryNotices.count = primaryNotices.items.length + Math.max(0, (v.notices.count || 0) - (v.notices.items || []).length);
    const nts = window.AWXNotices ? safeCall(() => AWXNotices.section({ ...v, notices: primaryNotices }, a, noticeContext)) : null; // restrictions hook: material notices stay visible
    const ntsDown = noticesDown() && !(outlook(a).kind === "unknown" && !nts) ? h("p", { class: "ntc-down muted" }, NOTICES_DOWN) : null; // never silently missing (a quiet Now card already says it)
    if (nts) { secs.push(nts); if (ntsDown) nts.querySelector(".scard").append(ntsDown); }
    else if (ntsDown) secs.push(ntsDown);

    // a warning's description without its repeated title: "Severe Thunderstorm Warning issued for Cook and DuPage Counties" -> "Cook and DuPage Counties"
    const alertDesc = (x) => {
      const hl = String(x.headline || ""), rest = x.event && hl.indexOf(x.event) === 0 ? hl.slice(x.event.length) : null;
      if (rest == null) return hl;
      const m = /^\s*issued\b.*?\bfor (.+)$/.exec(rest);
      return m ? cap(m[1].replace(/^the /i, "")) : /^\s*(issued\b.*)?$/.test(rest) ? "" : hl;
    };
    const alertEnd = (x) => (x.ends ? " · until " + whenLabel(Date.parse(x.ends), tz) : "");
    add(v.alerts && v.alerts.length, () => section("Weather warnings", "alert", v.alerts.map((x) => h("div", { class: "item" }, h("b", {}, x.event),
      x.ends ? h("span", { class: "muted" }, alertEnd(x)) : null,
      alertDesc(x) ? h("div", { class: "muted", style: "font-size:13px;margin-top:2px" }, retime(alertDesc(x), a)) : null,
      aviation() ? h("div", { class: "chips" }, confChip("NWS", /Warning/.test(x.event) ? "high" : "medium")) : null)),
      { key: "nws", raw: v.alerts.map((x) => [x.event, x.headline].filter(Boolean).join("\n")).filter((r, i) => rawAdds(r, v.alerts[i].event + alertEnd(v.alerts[i]) + " " + alertDesc(v.alerts[i]))) }));
    // storms (thunderstorm alerts near the field, the severe-storm outlook, the storm forecast for air traffic) have no
    // section of their own: the Now card's blurb says them in plain words, More details → FAA plan & storm detail
    // keeps the detail and Pilot details the raw alert text
    const extraAdvisories = (v.aviationAdvisories || []).filter((x) => Date.parse(x.to) > refNow() && Date.parse(x.from) < refNow() + 24 * 3600e3);
    if (extraAdvisories.length) secs.push(section("Flight weather", "plane", [
      ...extraAdvisories.slice(0, 5).map((x) => h("div", { class: "item info" },
        h("div", {}, x.text),
        h("div", { class: "muted small" }, Date.parse(x.from) > refNow() ? "From " + whenLabel(Date.parse(x.from), tz) + " to " + whenLabel(Date.parse(x.to), tz) : "Until " + whenLabel(Date.parse(x.to), tz)),
        aviation() && x.raw ? h("pre", { class: "raw rawt" }, x.raw) : null)),
      extraAdvisories.length > 5 ? h("div", { class: "muted small" }, "+" + (extraAdvisories.length - 5) + " more") : null,
      h("div", { class: "muted small" }, "Routing changes are possible. An advisory alone does not confirm airport delays.")
    ], null, { meta: "NOAA", id: "flight-weather" }));
    // movement hook: "Traffic right now" (site/movement.js), its card body inside a build2b section card
    const mv = window.AWXMovement && typeof AWXMovement.card === "function" ? safeCall(() => AWXMovement.card(a)) : null;
    // Aviation mode: the delay outlook's reasoning lives in More details → Why this outlook; dl only decides whether the routine line shows
    // the reasoning for the headline's own hour: the outlook's hour, else the current one while delays are happening now
    const active = outlook(a).kind === "active";
    const peakT = layout === "split" && sm.peakHour ? sm.peakHour.t : null; // the Looking ahead risk line's hour
    const whyT = lead ? lead.t : peakT || (active ? v.hours[0].t : null);
    const whyAt = whyT ? (a.hours || []).findIndex((x) => x.t === whyT) : -1; // delayBlock indexes a.hours
    const dl = aviation() && window.AWXDelay && typeof AWXDelay.delayBlock === "function" ? safeCall(() => AWXDelay.delayBlock(a, whyAt >= 0 ? whyAt : null,
      { coveredHours: [lead && lead.t, peakT, active && v.hours[0].t].filter(Boolean) })) : null; // phase3 hook
    // below the timeline: a short log of what already changed today (the full list opens from Today's changes)
    // events the sheet already shows stay out of it: a warning in the Weather warnings card, the headline's own program starting
    const headProg = outlook(a).kind === "active" ? outlook(a).programs[0] : null;
    const onSheet = (e) => e.kind === "warning" && (v.alerts || []).some((x) => x.event === e.to)
      || !!headProg && (e.kind === "program_start" && e.to === headProg.type || e.kind === "closure_start" && headProg.type === "closure");
    const log = window.AWXBrief && typeof AWXBrief.todayEvents === "function" ? safeCall(() => logSection(a, onSheet)) : null; // brief hook
    const hiddenNote = v.hiddenCats && v.hiddenCats.size
      ? h("p", { class: "hidnote" }, "Hidden by your settings: " + [...v.hiddenCats].map((k) => CATS.LABELS[k]).join(", ") + ". Ground stops and airport closures are always shown.")
      : null;
    const zoneLine = S.tz === "mine" ? "Times in " + zoneAbbr(refNow(), USER_TZ) : zoneAbbr(refNow(), a.tz);
    // routine conditions (the Delay outlook card is left out): one short line under the Now / Coming up card
    const dlShown = !!(dl && (dl.nodeType ? dl.childNodes.length || dl.nodeType === 1 : true));
    const routine = routineLine(a, dlShown);

    sheet.replaceChildren(...[
      h("div", { class: "grab", "aria-hidden": "true" }),
      h("div", { class: "sh-head" },
        h("div", { class: "sh-code", id: "sheetTitle" }, code),
        h("div", { class: "right", style: "gap:6px" },
          h("button", { type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + code + (fav ? " from" : " to") + " my airports", onclick: () => toggleFav(a.iata) }, starSvg()),
          h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeSheet }, closeSvg()))),
      h("div", { class: "sh-where" }, h("b", { class: "sh-aname" }, a.name), h("span", { class: "muted" }, " · " + `${a.city}, ${a.state}` + (S.tz === "mine" ? " · " + zoneLine : ""))),
      // stale data: the first line says so (README "Stale data")
      isStale() ? h("p", { class: "stale-line" }, "Last updated " + ago(dataAge()) + " — may be outdated") : null,
      // above the timeline: only the header, the Now / Peak (or single) card and the timeline itself
      boxWrap,
      h("section", { class: "sec tlsec" },
        h("div", { class: "sec-h" }, icon(ICONS.clock), h("h3", {}, tlTitle), h("span", { class: "rule", "aria-hidden": "true" }), dayBtn),
        tlHolder),
      lookingAhead,
      sm.level >= 2 || sm.current?.programs?.length ? section("What this means for your trip", "plane", [
        h("p", { class: "trip-advice" }, AWXOutlook.travelAdvice(a, sm, AWXOutlook.health(a, outlookOpts(a, view(a))))),
      ]) : null,
      routine, // Aviation baseline detail follows the timeline.
      log,
      ...secs,
      aviation() ? pilotDetails(a, { title: "Aviation details" }) : null,
      section("Airport details", "plane", [h("div", { class: "ad-menu" },
        detailRow("Weather", "Current conditions and storm outlook", "weather", () => openDetails(a.iata, "weather")),
        window.AWXRadarCard && AWXRadarCard.covered(a) ? detailRow("Radar", "Live rain and snow", "radar", () => AWXRadarCard.open(a)) : null,
        informationalNotices ? detailRow("Flight restrictions", "Nearby airspace restrictions", "notices", () => openDetails(a.iata, "notices")) : null,
        mv ? detailRow("Traffic right now", "Aircraft movements and coverage", "traffic", () => openDetails(a.iata, "traffic")) : null,
        h("button", { type: "button", class: "md-row ad-row trip-check", onclick: () => {
          AWXSheet.transfer(closeSheet, () => window.AWXNav?.openSettings(window.AWXPrefs?.getPrefs().flights ? "trips" : "root"));
        } }, h("span", {}, h("span", { class: "ad-title" }, "Check my trip")), h("span", { class: "chev", "aria-hidden": "true" }, "›")),
        detailRow("More details", "Outlook, sources and aviation reports", "technical", () => openDetails(a.iata)))], null, { cls: "ad-card" }),
      hiddenNote,
      checkedLine(a),
    ].filter(Boolean));
    // each decorator on its own: one failing must not skip the others, the menu check or the scroll/focus restore below
    if (window.AWXTrips) safeCall(() => window.AWXTrips.decorateSheet(sheet, a)); // trips hook: "Your flight" row + plane markers
    if (window.AWXBrief) safeCall(() => window.AWXBrief.decorateSheet(sheet, a)); // brief hook: "Today" card (site/brief.js)
    if (window.AWXTerminals) safeCall(() => window.AWXTerminals.decorateSheet(sheet, a)); // terminals hook: "Terminal map" + "Lounges" cards (site/terminals.js)
    safeCall(() => healMenu(sheet, a));
    sheet.scrollTop = keepScroll ? top : 0; // a newly opened sheet starts at the top; live refreshes keep the place
    if (focusedDetail) sheet.querySelector('[data-detail="' + focusedDetail + '"]')?.focus({ preventScroll: true });
    scheduleLenses();
    fillCrosswind(a);
  }

  /**
   * The Airport details menu must always offer at least Weather and More details (an iPhone once showed its header
   * with no rows). Rebuilds missing rows right after the decorators; a frame later, a menu laid out at zero height
   * gets explicit block/flex layout. Each problem is reported once in the console.
   */
  const menuWarned = new Set();
  function healMenu(sheet, a) {
    const warn = (k, msg) => { if (!menuWarned.has(k)) { menuWarned.add(k); console.warn("Airport details menu: " + msg); } };
    let menu = sheet.querySelector(".ad-menu");
    if (!menu) {
      menu = h("div", { class: "ad-menu" });
      const sec = section("Airport details", "plane", [menu], null, { cls: "ad-card" });
      const tail = sheet.querySelector(".hidnote") || sheet.lastElementChild;
      if (tail && tail.parentNode === sheet) tail.before(sec); else sheet.append(sec);
      warn("missing", "rebuilt the missing menu");
    }
    if (menu.querySelectorAll(".ad-row").length < 2) {
      if (!menu.querySelector('[data-detail="weather"]')) menu.prepend(detailRow("Weather", "Current conditions and storm outlook", "weather", () => openDetails(a.iata, "weather")));
      if (!menu.querySelector('[data-detail="technical"]')) menu.append(detailRow("More details", "Outlook, sources and aviation reports", "technical", () => openDetails(a.iata)));
      warn("rows", "rebuilt missing rows");
    }
    requestAnimationFrame(() => {
      if (!menu.isConnected || $("sheetWrap").hidden || !sheet.offsetHeight) return;
      if (menu.getBoundingClientRect().height < 1 || [...menu.querySelectorAll(".ad-row")].some((r) => r.getBoundingClientRect().height < 1)) {
        menu.style.display = "block";
        for (const r of menu.querySelectorAll(".ad-row")) { r.style.display = "flex"; r.style.minHeight = "52px"; }
        warn("height", "rows had no height; forced block layout");
      }
    });
  }

  /** "Today so far": the newest three of the airport's events today (site/brief.js), newest first; events already shown elsewhere on the sheet (skip) go last, so three show whenever there are three changes today; null when there are none. */
  const LOG_MAX = 3;
  function logSection(a, skip = () => false) {
    const all = AWXBrief.todayEvents(a);
    if (!all.length) return null;
    const tz = dispTz(a);
    const fresh = all.filter((e) => !skip(e)), dup = all.filter((e) => skip(e));
    const shown = fresh.concat(dup).slice(0, LOG_MAX).sort((x, y) => all.indexOf(x) - all.indexOf(y));
    const more = all.length - shown.length;
    const open = () => openDetails(a.iata, "today");
    return section("Today so far", "clock", [h("ul", { class: "sh-log" },
      shown.map((e) => h("li", {}, h("button", { type: "button", class: "lg-entry", "data-detail": "today", "aria-haspopup": "dialog", onclick: open },
        h("span", { class: "lg-t" }, clock(Date.parse(e.t), tz, true)),
        h("span", { class: "lg-s" }, e.kind === "program_extend" && Date.parse(e.to) ? e.sentence.replace(/until .*$/, "until " + faaUntil(Date.parse(e.to), a)) : e.sentence.replace(/\blow ceilings\b/g, "low clouds")),
        h("span", { class: "chev", "aria-hidden": "true" }, "›"))))),
      h("button", { type: "button", class: "lg-more", "data-detail": "today", "aria-haspopup": "dialog", onclick: open }, more > 0 ? `All changes · ${more} earlier ›` : "All changes ›")], null, { cls: "logcard" });
  }

  function safeCall(fn) {
    try { return fn(); } catch (e) { console.warn(e); return null; }
  }

  /**
   * phase3 hook: Aviation mode's routine delay line. Shown only when the Delay outlook card is left out, the
   * outlook isn't unknown (stale / missing data) or an active FAA restriction, and the rest of the local day has
   * delay numbers. Words only (site/delay.js likelihood), no %.
   */
  function routineLine(a, dlShown) {
    if (!aviation() || dlShown || !window.AWXDelay || typeof AWXDelay.routineOutlook !== "function") return null;
    const o = safeCall(() => outlook(a));
    if (!o || o.kind === "unknown" || o.kind === "active") return null;
    const r = safeCall(() => AWXDelay.routineOutlook(a, refNow()));
    return r ? h("p", { class: "dl-routine" }, r.text) : null;
  }

  // ---------- More details page (a full-height sheet over the airport sheet; site/sheet.js makeSheet) ----------

  function detailRow(title, subtitle, key, action) {
    return h("button", { type: "button", class: "md-row ad-row", "data-detail": key, "aria-haspopup": "dialog", onclick: action },
      h("span", {}, h("span", { class: "ad-title" }, title), subtitle ? h("span", { class: "ad-sub" }, subtitle) : null),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }
  function popupFocus(el, ev) {
    if (ev.key !== "Tab") return;
    const controls = [...el.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((x) => x.getClientRects().length && !x.hidden);
    const first = controls[0], last = controls[controls.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
  }
  const md = { iata: null, page: "technical", wrap: null, ctl: noSheet, last: null };
  function mdWrap() {
    if (md.wrap) return md.wrap;
    md.wrap = h("div", { class: "sheet-wrap md-wrap", id: "mdWrap", hidden: true },
      h("div", { class: "backdrop", onclick: () => closeDetails() }),
      h("div", { class: "sheet md-sheet", id: "mdSheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "mdTitle" }));
    document.body.append(md.wrap);
    md.wrap.querySelector(".sheet").addEventListener("keydown", (ev) => popupFocus(md.wrap.querySelector(".sheet"), ev));
    if (window.AWXSheet) md.ctl = AWXSheet.makeSheet(md.wrap.querySelector(".sheet"), { onClose: () => closeDetails(), header: ".grab, .sh-head", backdrop: md.wrap.querySelector(".backdrop"), noPull: ".lamp, .awr-box" });
    return md.wrap;
  }
  function openDetails(iata, page = "technical") {
    const w = mdWrap();
    md.iata = iata;
    md.page = page;
    md.last = document.activeElement;
    md.lastDetail = md.last && md.last.dataset.detail;
    renderDetails(false);
    if (!md.iata) return;
    w.hidden = false;
    $("sheet").inert = true;
    document.documentElement.classList.add("lock");
    md.ctl.opened();
    void w.offsetHeight;
    w.classList.add("open");
    const c = w.querySelector(".close");
    if (c) c.focus({ preventScroll: true });
  }
  function closeDetails() {
    closeReportInfo();
    if (!md.iata) return;
    if (md.page === "weather") window.AWXRadarCard?.close();
    md.iata = null;
    $("sheet").inert = false;
    const w = md.wrap;
    const sh = w.querySelector(".sheet");
    w.classList.remove("open");
    sh.style.transform = "";
    sh.style.transition = "";
    if (!state.openIata && !panel.kind) document.documentElement.classList.remove("lock");
    md.ctl.closed();
    const done = () => { if (!md.iata) w.hidden = true; };
    if (reduced()) done(); else setTimeout(done, 300);
    const focus = md.last && md.last.isConnected ? md.last : md.lastDetail ? $("sheet").querySelector('[data-detail="' + md.lastDetail + '"]') : null;
    if (focus) focus.focus({ preventScroll: true });
  }
  const mdSrc = (text) => h("div", { class: "md-src" }, text);
  const srcAge = (key) => {
    const s = state.data && state.data.sources && state.data.sources[key];
    return s && s.at ? " · updated " + ago(Math.max(0, refNow() - Date.parse(s.at))) : "";
  };
  const srcDown = (key) => { const s = state.data && state.data.sources && state.data.sources[key]; return !!s && !s.ok; };
  // launch sites named in the ops plan's PLANNED LAUNCH/REENTRY section (lat, lon); "nearby" = within 300 km
  const LAUNCH_SITES = [
    [/CANAVERAL|KENNEDY|\bKSC\b|\bCCSFS\b/i, 28.49, -80.58], [/VANDENBERG/i, 34.74, -120.57], [/WALLOPS/i, 37.94, -75.47],
    [/STARBASE|BOCA CHICA/i, 25.99, -97.16], [/KODIAK/i, 57.44, -152.34], [/SPACEPORT AMERICA/i, 32.99, -106.97], [/MOJAVE/i, 35.06, -118.15],
  ];
  const kmBetween = (la1, lo1, la2, lo2) => {
    const r = Math.PI / 180, dl = (la2 - la1) * r, dn = (lo2 - lo1) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dn / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  /** Space launches/reentries in the national ops plan from a known site within 300 km of the airport, not yet over. */
  function launchesNear(a) {
    const out = [];
    const ref = refNow();
    for (const l of (state.data && state.data.opsplan && state.data.opsplan.launches) || []) {
      const site = LAUNCH_SITES.find(([re]) => re.test(l.site || "") || re.test(l.name || ""));
      if (!site || a.lat == null || kmBetween(a.lat, a.lon, site[1], site[2]) > 300) continue;
      const p = l.primary || {}, b = l.backup || {};
      const s = Date.parse(p.start), e = Date.parse(p.end), bs = Date.parse(b.start), be = Date.parse(b.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      if (e < ref && !(Number.isFinite(be) && be > ref)) continue;
      out.push({ l, s, e, bs, be });
    }
    return out;
  }
  const CWA_HAZ = { TS: "thunderstorms", CONV: "thunderstorms", CB: "thunderstorms", THUNDER: "thunderstorms", IFR: "low clouds or poor visibility", LIFR: "low clouds or poor visibility",
    TURB: "turbulence", ICE: "icing", LLWS: "low-level wind shear", WS: "wind shear", PCPN: "precipitation", SN: "snow", VA: "volcanic ash", DU: "dust", FG: "fog" };
  const cwaHazard = (x) => { const k = String(x || "").toUpperCase().replace(/[^A-Z].*$/, ""); return CWA_HAZ[k] || (k ? "weather hazard" : ""); };
  const SPC_LEVEL = { MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 5 };

  /** Latest end (ms) of the thunderstorm alerts (Convective SIGMETs) over or near the airport, or null. */
  function stormEnd(v) {
    const ends = (v.sigmets || []).map((g) => Date.parse(g.validTo)).filter(Number.isFinite);
    return ends.length ? Math.max(...ends) : null;
  }
  /** Advisory validity is exact; its expiry is not a promise that storms or delays end. */
  function stormLine(v, tz) {
    const end = stormEnd(v);
    if (aviation()) return "Convective SIGMET over or within 10 nm of the airport" + (end ? " until " + whenLabel(end, tz) : "");
    return "Thunderstorm advisory near the airport" + (end ? " until " + whenLabel(end, tz) : "");
  }
  /** "FAA plan & storm detail": the Command Center plan for this airport, nearby launches, SPC, TCF and CWA in plain words. */
  function planStormCard(a, v) {
    const tz = dispTz(a);
    const kids = [];
    const sub = (t) => h("div", { class: "subt md-sub" }, t);
    // FAA Command Center operations plan: every item for this airport (programs, staffing, constraints, SIRs with end dates)
    const items = planItems(v, a, { raw: false, dupNote: " Also in the FAA airport status.", constraints: true });
    const launches = launchesNear(a);
    kids.push(sub("FAA Command Center plan"));
    if (items.length) kids.push(...items);
    else kids.push(h("div", { class: "item muted" }, srcDown("atcscc") ? "The FAA Command Center plan couldn't be read right now." : `Nothing in today's FAA plan for ${codeOf(a)}.`));
    for (const x of launches) {
      const what = /REENTRY|RE-ENTRY/i.test(x.l.name || "") ? "Space reentry" : "Space launch";
      const name = titleCase(String(x.l.name || "").replace(/\s*(REENTRY|RE-ENTRY)\s*/i, " ").trim());
      kids.push(h("div", { class: "item" }, h("b", {}, what + " nearby"),
        h("div", {}, `${name}${x.l.site ? " from " + titleCase(x.l.site) : ""}, ${whenLabel(x.s, tz)} – ${clock(x.e, tz)}` + (Number.isFinite(x.bs) ? ` (backup ${whenLabel(x.bs, tz)})` : "") + " — some flights may be rerouted.")));
    }
    kids.push(mdSrc("Source: FAA Command Center operations plan" + (v.opsplan && v.opsplan.plan && v.opsplan.plan.issued ? " · issued " + whenLabel(Date.parse(v.opsplan.plan.issued), tz) : srcAge("atcscc"))));
    // Thunderstorm alerts near the field (Convective SIGMETs; raw text in Pilot details), storm outlook (SPC), storm forecast for air traffic (TCF), center weather advisories (CWA)
    kids.push(sub("Thunderstorms near the airport"));
    kids.push(h("div", { class: "item" + ((v.sigmets || []).length ? "" : " muted") }, (v.sigmets || []).length ? stormLine(v, tz)
      : srcDown("sigmet") ? "Thunderstorm alerts couldn't be read right now." : `No thunderstorm alerts over or near ${codeOf(a)}.`));
    kids.push(mdSrc("Source: aviationweather.gov thunderstorm alerts" + srcAge("sigmet")));
    const spcRow = v.spc ? (v.spc === "TSTM" ? "General thunderstorms possible in the area (no severe risk)"
      : `${SPC_NAMES[v.spc] || cap(String(v.spc).toLowerCase())} risk of severe storms${SPC_LEVEL[v.spc] ? ` (level ${SPC_LEVEL[v.spc]} of 5)` : ""} in today's outlook`) : null;
    const tcf = v.tcf || [];
    const cwa = v.cwa || [];
    kids.push(sub("Severe-storm outlook"));
    kids.push(h("div", { class: "item" + (spcRow ? "" : " muted") }, spcRow || (srcDown("spc") ? "The storm outlook couldn't be read right now." : "No severe-storm risk in today's outlook.")));
    kids.push(mdSrc("Source: NOAA Storm Prediction Center" + srcAge("spc")));
    kids.push(sub("Storm forecast for air traffic"));
    if (tcf.length) {
      for (const x of tcf) kids.push(h("div", { class: "item" },
        h("b", {}, "Thunderstorms, " + ({ high: "widespread", medium: "scattered", low: "isolated" }[x.coverage] || "some") + " coverage"),
        x.valid ? h("span", { class: "muted" }, " · around " + whenLabel(Date.parse(x.valid), tz)) : null,
        x.confidence ? h("div", { class: "muted small" }, "Forecaster confidence " + String(x.confidence).toLowerCase()) : null));
    } else kids.push(h("div", { class: "item muted" }, srcDown("tcf") ? "The storm forecast couldn't be read right now." : `No thunderstorms forecast near ${codeOf(a)} for air traffic planning.`));
    kids.push(mdSrc("Source: aviationweather.gov convective forecast" + srcAge("tcf")));
    kids.push(sub("Weather advisories for pilots"));
    if (cwa.length) {
      for (const x of cwa) {
        const hz = cwaHazard(x.hazard);
        kids.push(h("div", { class: "item" }, h("b", {}, "Center weather advisory" + (hz ? ": " + hz : "")),
          x.validTo ? h("span", { class: "muted" }, " · until " + whenLabel(Date.parse(x.validTo), tz)) : null));
      }
    } else kids.push(h("div", { class: "item muted" }, srcDown("cwa") ? "Center weather advisories couldn't be read right now." : `No center weather advisories over ${codeOf(a)}.`));
    kids.push(mdSrc("Source: aviationweather.gov center weather advisories" + srcAge("cwa")));
    return section("FAA plan & storm detail", "tower", kids, null, { cls: "md-plan" });
  }

  function renderDetails(keepScroll) {
    const a0 = state.data && md.iata && state.data.airports.find((x) => x.iata === md.iata);
    if (!a0) { if (md.iata) closeDetails(); return; }
    const D = withDetail(a0);
    const a = D.a;
    const sheet = mdWrap().querySelector(".sheet");
    const top = sheet.scrollTop;
    const focusedLabel = keepScroll && sheet.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
    const controlSelector = 'button, summary, a[href], input, select, textarea, [tabindex="0"]';
    const perOpen = keepScroll && !!sheet.querySelector("details.wxf-per[open]"); // Weather page: Aviation "Forecast periods" stays open through a refresh
    const focusedControl = keepScroll ? [...sheet.querySelectorAll(controlSelector)].indexOf(document.activeElement) : -1;
    const v = view(a);
    const code = codeOf(a);
    const mark = (sec, key) => { if (sec) sec.dataset.md = key; return sec; };
    const why = !D.have.why ? detailWait(a, "the delay explanation") : window.AWXDelay && typeof AWXDelay.whyBlock === "function" ? safeCall(() => AWXDelay.whyBlock(a, refNow())) : null;
    const pd = pilotDetails(a, { force: true }) || section("Pilot details", "plane", [h("p", { class: "muted", style: "margin:0" }, "No reports for this airport right now.")], null, { cls: "pilot" });
    const hiddenNote = v.hiddenCats && v.hiddenCats.size
      ? h("p", { class: "hidnote" }, "Hidden by your settings: " + [...v.hiddenCats].map((k) => CATS.LABELS[k]).join(", ") + ".")
      : null;
    const titles = { technical: "More details", weather: "Weather", traffic: "Traffic right now", lounges: "Lounges", today: "Today’s changes", terminal: "Terminal map", notices: "Flight restrictions" };
    const title = titles[md.page] || titles.technical;
    let content;
    if (md.page === "weather") {
      // The primary sheet retains warnings; this page carries the full conditions and outlook.
      // One forecast section (Today / Tomorrow); the storm outlook, storm forecast and warnings sit in their day's row.
      const parts = [];
      if (a.metar) parts.push(currentWeather(a));
      parts.push(safeCall(() => window.AWXRadarCard?.section(a, section)));
      if (a.taf ? D.have.taf : D.have.cond) parts.push(safeCall(() => wxForecast(a, v)));
      else parts.push(section("Forecast", null, [detailWait(a, a.taf ? "the airport forecast" : "the hourly forecast")], null, { cls: "taf-forecast wxf" }));
      content = parts.filter(Boolean).length ? parts.filter(Boolean) : [h("p", { class: "muted" }, "Weather reports are unavailable right now.")];
    } else if (md.page === "traffic") {
      const traffic = window.AWXMovement ? safeCall(() => AWXMovement.card(a)) : null;
      content = [traffic || h("p", { class: "muted" }, "Aircraft movement data is unavailable right now.")];
    } else if (md.page === "lounges") content = [window.AWXTerminals?.detail(a, "lounges") || h("p", { class: "muted" }, "Lounge information is unavailable right now.")];
    else if (md.page === "today") content = [window.AWXBrief?.todaySection(a) || h("p", { class: "muted" }, "No changes recorded today.")];
    else if (md.page === "terminal") content = [h("p", { class: "muted" }, "The terminal map could not load right now. Try again from Airport details.")];
    else if (md.page === "notices") content = [window.AWXNotices ? AWXNotices.section(v, a, { h, section, aviation: aviation(), retime: (t) => retime(t, a), hidden: isHidden, now: refNow(), sources: state.data.noticeSources || {} }) : null];
    else content = [
      mark(section("Why this outlook", "clock", [h("div", { class: "coverage-note muted small" },
        h("p", {}, "Airport-wide weather and FAA outlook · individual flight status not checked."),
        h("p", {}, `${state.data?.airports?.length || "—"} airports monitored · ${window.AWXDelay?.validatedAirports ?? "unknown number of"} airports in model validation. Coverage varies by airport.`),
        AWXOutlook.forecastQuality(a) ? h("p", { class: "forecast-quality" }, AWXOutlook.forecastQuality(a)) : null), why || h("p", { class: "muted", style: "margin:0" }, "Delay numbers aren't available right now.")], null, { cls: "md-why" }), "why"),
      mark(pd, "pilot"), mark(safeCall(() => planStormCard(a, v)), "plan")];
    sheet.classList.toggle("md-wx", md.page === "weather"); // Weather page look (index.html "Weather page")
    sheet.setAttribute("aria-label", code + " " + title.toLowerCase());
    sheet.setAttribute("aria-labelledby", "mdTitle mdPageTitle");
    sheet.replaceChildren(...[
      h("div", { class: "grab", "aria-hidden": "true" }),
      h("div", { class: "sh-head md-page-head" },
        h("div", { class: "md-nav" },
          h("button", { type: "button", class: "ad-back", "aria-label": "Back to airport", onclick: () => closeDetails() }, `‹ ${code} overview`),
          h("button", { type: "button", class: "close", "aria-label": "Close " + title.toLowerCase(), onclick: () => closeDetails() }, closeSvg())),
        h("h1", { class: "md-page-title", id: "mdPageTitle" }, title)),
      h("div", { class: "sh-where" }, h("b", { id: "mdTitle" }, code), " · ", h("span", { class: "sh-aname" }, a.name)),
      ...content,
      hiddenNote,
      checkedLine(a, true),
    ].filter(Boolean));
    if (perOpen) { const d = sheet.querySelector("details.wxf-per"); if (d) d.open = true; }
    sheet.scrollTop = keepScroll ? top : 0;
    const focus = focusedLabel ? [...sheet.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === focusedLabel) : focusedControl >= 0 ? sheet.querySelectorAll(controlSelector)[focusedControl] : null;
    focus?.focus({ preventScroll: true });
    if (md.page === "weather") fillCrosswind(a);
  }

  // ---------- Current weather card ----------

  /** Position 0..1 on a LIFR | IFR | MVFR | VFR scale (equal quarters). */
  function scalePos(val, b) {
    if (val == null) return 1;
    const [x1, x2, x3, top] = b;
    if (val < x1) return (val / x1) * 0.25;
    if (val < x2) return 0.25 + ((val - x1) / (x2 - x1)) * 0.25;
    if (val <= x3) return 0.5 + ((val - x2) / (x3 - x2)) * 0.25;
    return Math.min(1, 0.75 + ((val - x3) / (top - x3)) * 0.25);
  }
  function catScale(label, valueText, pos) {
    return h("div", { class: "cw-scale" },
      h("div", { class: "cw-sl" }, h("span", {}, label), h("b", {}, valueText)),
      h("div", { class: "cw-bar" }, ["LIFR", "IFR", "MVFR", "VFR"].map((c) => h("span", { class: "seg " + c }, h("i", {}, c))),
        h("span", { class: "mark", style: `left:${(pos * 100).toFixed(1)}%` })));
  }
  function tickBar(label, kt, max, cls) {
    const n = kt == null ? 0 : kt;
    return h("div", { class: "cw-wind" + (cls ? " " + cls : "") },
      h("div", { class: "cw-sl" }, h("span", {}, label), h("b", {}, kt == null ? "None" : kt + " kt")),
      h("div", { class: "ticks-bar", style: `--f:${Math.min(1, n / max).toFixed(3)}` }));
  }
  /** Raw METAR with hazard groups highlighted: TS, FZ, +, BKN/OVC/VV below 1000 ft, visibility below 3 sm. */
  function metarMarked(raw) {
    const toks = String(raw || "").split(/\s+/);
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let hz = false;
      if (i > 1) {
        if (/^(\+|-|VC)?[A-Z]*TS[A-Z]*$/.test(t) && !/^TS[A-Z]{0,1}$/.test("") && /TS/.test(t) && !/^RMK$/.test(t)) hz = /^(\+|-|VC)?(TS|[A-Z]{2})*$/.test(t);
        if (/^(\+|-)?FZ[A-Z]+$/.test(t)) hz = true;
        if (/^\+[A-Z]{2,}$/.test(t)) hz = true;
        const c = /^(BKN|OVC|VV)(\d{3})/.exec(t);
        if (c && Number(c[2]) * 100 < 1000) hz = true;
        const vm = /^M?(\d+\/\d+|\d+)SM$/.exec(t);
        if (vm) {
          let val = visNum(vm[1]);
          if (/^\d+\/\d+SM$/.test(t) && /^\d+$/.test(toks[i - 1] || "")) val += Number(toks[i - 1]);
          if (val < 3) { hz = true; if (/^\d+$/.test(toks[i - 1] || "") && out.length) { const prev = out.pop(); out.push(h("mark", {}, prev.textContent || prev)); out.push(" "); } }
        }
      }
      if (t === "RMK") { out.push(toks.slice(i).join(" ")); break; }
      out.push(hz ? h("mark", {}, t) : t);
      if (i < toks.length - 1) out.push(" ");
    }
    return out;
  }
  /** Visibility in plain words: "Good (10+ miles)", "Poor (2 miles)". */
  function visMiles(v) {
    return v >= 10 ? "10+ miles" : v < 1 ? "under 1 mile" : (Math.round(v * 4) / 4) + (v === 1 ? " mile" : " miles");
  }
  function visWords(v) {
    if (v == null) return "—";
    const mi = visMiles(v);
    return (v > 5 ? "Good" : v >= 3 ? "Moderate" : v >= 1 ? "Poor" : "Very poor") + " (" + mi + ")";
  }
  const WXD = () => window.AWXWxDays;
  /** One name per thing in a condition line: "Heavy snow, snow, freezing fog" -> "Heavy snow, freezing fog". */
  const oneCond = (s) => { const p = String(s || "").split(", "); return cap(p.filter((x, i) => !p.some((o, j) => j !== i && o.toLowerCase().endsWith(" " + x.toLowerCase()))).join(", ")); };
  /** The observation's emoji (shared with the Now card's pill and the forecast rows: wxdays.js), "" when it isn't fresh. */
  function obsEmoji(a, m, fresh) {
    if (!fresh || !WXD()) return "";
    const at = Date.parse(m.obsTime);
    return WXD().emoji(WXD().kind(metarCond(m), WXD().coversOf(m.raw)), WXD().nightAt(a.lat, a.lon, Number.isFinite(at) ? at : refNow(), a.tz));
  }
  const obsFresh = (m) => { const t = m && Date.parse(m.obsTime); return Number.isFinite(t) && refNow() - t <= 2 * HOUR && t - refNow() <= 10 * 60000; }; // outlook.js health's rule
  /** "S 8 mph", "Calm", "Variable 5 mph" (null when no wind was reported). */
  const windAbbr = (w) => (!w || w.spd == null ? null : w.spd === 0 ? "Calm" : (w.dir == null || w.dir === "VRB" ? "Variable" : compassAbbr(w.dir)) + " " + mph1(w.spd) + " mph");
  /** Weather page hero: emoji, big temperature, condition, observation age, then stat tiles with only what was reported. */
  function currentWeather(a) {
    const m = a.metar;
    if (!m) return null;
    const fresh = obsFresh(m);
    const cond = oneCond(shortCond(metarCond(m), m.raw).replace(/, gusty$/, m.gust != null ? "" : ", gusty")); // the Gusts tile says it
    const cat = m.fltCat;
    const emo = obsEmoji(a, m, fresh);
    const w = m.wind || {};
    const tiles = [];
    const tile = (k, val, cls) => { if (val != null) tiles.push(h("div", { class: "wxt" + (cls ? " " + cls : "") }, h("span", {}, k), h("b", {}, val))); };
    if (aviation() && cat) tile("Flight category", fcChip(cat));
    tile("Wind", windAbbr(w));
    if (m.gust != null) tile("Gusts", mph1(m.gust) + " mph", mph1(m.gust) >= 25 ? "gh" : "");
    if (m.visib != null) tile("Visibility", cap(visMiles(m.visib).replace(/ miles?$/, " mi")));
    if (m.ceiling != null && m.ceiling < 5000) tile("Lowest clouds", m.ceiling.toLocaleString("en-US") + " ft");
    if (aviation() && m.temp != null) tile("Temp / dew", `${m.temp}° / ${m.dewp ?? "—"}°C`);
    const obs = m.obsTime ? "Observed " + ago(Math.max(0, refNow() - Date.parse(m.obsTime))) : "Observation time unknown";
    const help = reportHelp("METAR");
    help.button.classList.add("wxh-help");
    const kids = [help.button,
      h("div", { class: "wxh-top" }, emo ? h("span", { class: "wxh-e", "aria-hidden": "true" }, emo) : null,
        h("div", { class: "wxh-temp" }, m.temp != null ? f1(m.temp) + "°" : "—", aviation() && m.temp != null ? h("span", { class: "cw-c" }, m.temp + "°C") : null)),
      h("div", { class: "wxh-cond" }, cond),
      h("div", { class: "wxh-obs" + (fresh ? "" : " late") }, obs),
      tiles.length ? h("div", { class: "wxt-grid" + (tiles.length % 2 ? " odd" : "") }, tiles) : null];
    if (aviation()) {
      const age = m.obsTime ? agoShort(refNow() - Date.parse(m.obsTime)) : "";
      const maxW = Math.max(40, Math.ceil(((m.gust || 0) + 5) / 10) * 10);
      kids.push(cat ? h("p", { class: "cw-expl" }, FC_EXPLAIN[cat]) : null,
        catScale("Ceiling", m.ceiling != null ? m.ceiling.toLocaleString("en-US") + " ft" : "None", scalePos(m.ceiling, [500, 1000, 3000, 12000])),
        catScale("Visibility", visTxt(m.visib), scalePos(m.visib, [1, 3, 5, 10])),
        tickBar("Wind " + (w.dir != null ? (w.dir === "VRB" ? "variable" : String(w.dir).padStart(3, "0") + "°") : ""), w.spd, maxW),
        tickBar("Gusts", m.gust, maxW, "gust"),
        h("div", { class: "cw-xw", "data-icao": a.icao }, "Crosswind: checking runways…"),
        h("div", { class: "srcl metar" }, "METAR · REPORTED " + age, h("pre", { class: "raw" }, metarMarked(m.raw))));
    }
    return h("section", { class: "sec wxh-sec", "aria-label": "Current weather" }, h("div", { class: "scard cw wxh" + (aviation() ? " av" : "") }, ...kids));
  }
  const compass = (d) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((Number(d) % 360) + 360) % 360 / 45) % 8];
  const compassAbbr = (d) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((Number(d) % 360) + 360) % 360 / 45) % 8];
  /** "N 12 mph" / "Calm" / "Variable 8 mph", plus ", gusts 24" only when the gust is above the sustained wind (both in kt). */
  function windShort(dir, spd, gust) {
    if (spd == null) return "";
    if (spd === 0) return "Calm";
    const g = gust != null && mph1(gust) > mph1(spd) ? ", gusts " + mph1(gust) : "";
    return (dir == null || dir === "VRB" ? "Variable" : compassAbbr(dir)) + " " + mph1(spd) + " mph" + g;
  }
  /**
   * The Now card's current-conditions line: "75° · Heavy thunderstorms · W 29 mph, gusts 52 · Vis 2 mi", built from the same
   * observation and functions as the Weather page's Current weather card. A button that opens that page; with no observation
   * in the last 2 hours it says so instead (outlook.js health, the same rule as the sheet's qualification).
   */
  function currentLine(a) {
    const m = a.metar;
    const obs = m && Date.parse(m.obsTime);
    if (!m || !Number.isFinite(obs) || refNow() - obs > 2 * HOUR || obs - refNow() > 10 * 60000) return h("p", { class: "cl-none muted" }, "Current weather unavailable");
    const w = m.wind || {};
    const cond = oneCond(shortCond(metarCond(m), m.raw).replace(/, gusty$/, ""));
    const parts = [m.temp != null ? f1(m.temp) + "°" : null, cond, windShort(w.dir, w.spd, m.gust),
      m.visib != null ? "Vis " + visMiles(m.visib).replace(/ miles?$/, " mi") : null].filter(Boolean);
    // Pill (Dark Sky–like): emoji, temperature, condition; wind (+ gust) and visibility below 6 miles as quieter segments
    const gust = m.gust != null && w.spd != null && mph1(m.gust) > mph1(w.spd) ? mph1(m.gust) : null;
    const wind = windAbbr(w);
    const emo = obsEmoji(a, m, true);
    return h("button", { type: "button", class: "cur-line", "data-detail": "weather", "aria-haspopup": "dialog",
      "aria-label": "Current weather: " + parts.join(", ") + ". Open weather details.", onclick: () => openDetails(a.iata, "weather") },
      emo ? h("span", { class: "cl-e", "aria-hidden": "true" }, emo) : null,
      m.temp != null ? h("b", { class: "cl-temp" }, f1(m.temp) + "°") : null,
      h("span", { class: "cl-t" }, cond),
      h("span", { class: "cl-sec" }, h("i", { class: "cl-z" }), // segments that don't fit wrap onto a hidden second line (visibility first, then wind)
        wind ? h("span", { class: "cl-s cl-w" }, wind.replace(/ mph$/, ""), gust != null ? h("span", { class: "cl-g" + (gust >= 25 ? " gh" : "") }, " G " + gust) : null, wind === "Calm" ? null : h("small", {}, " mph")) : null,
        m.visib != null && m.visib < 6 ? h("span", { class: "cl-s cl-v" }, visMiles(m.visib).replace(/ miles?$/, " mi")) : null),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }
  /** Visibility as a short fraction: "½ mi", "1¾ mi", "under ¼ mi", "10+ mi". */
  function visFrac(v) {
    if (v >= 10) return "10+ mi";
    if (v < 0.25) return "under ¼ mi";
    const F = { 0: "", 0.125: "⅛", 0.25: "¼", 0.375: "⅜", 0.5: "½", 0.625: "⅝", 0.75: "¾", 0.875: "⅞" };
    let whole = Math.floor(v + 1e-9), r = Math.round((v - whole) * 8) / 8;
    if (r === 1) { whole += 1; r = 0; }
    return (whole || "") + F[r] + " mi";
  }
  const TCF_COVER = { high: "widespread", medium: "scattered", low: "isolated" };
  /** A day row's call-outs: the severe-storm outlook (today), storm forecasts around a time, and weather warnings (first day they touch). */
  function dayCallouts(a, v, days) {
    const tz = dispTz(a);
    const out = days.map(() => []);
    if (v.spc) out[0].push(v.spc === "TSTM" ? "Thunderstorms in the area, below severe levels" : `${SPC_NAMES[v.spc] || "Elevated"} risk of severe storms` + (aviation() && SPC_LEVEL[v.spc] ? ` (SPC level ${SPC_LEVEL[v.spc]} of 5)` : ""));
    for (const x of v.tcf || []) {
      const t = Date.parse(x.valid);
      const i = Number.isFinite(t) ? days.findIndex((d) => t < d.end) : 0;
      if (i >= 0) out[i].push("Thunderstorms, " + (TCF_COVER[x.coverage] || "some") + " coverage" + (Number.isFinite(t) ? " around " + clock(t, tz) : ""));
    }
    for (const x of v.alerts || []) {
      const on = Date.parse(x.onset), end = Date.parse(x.ends);
      const i = days.findIndex((d) => !(Number.isFinite(on) && on >= d.end) && !(Number.isFinite(end) && end <= d.start));
      if (i >= 0 && x.event) out[i].push(x.event + (Number.isFinite(end) ? " until " + whenLabel(end, tz) : ""));
    }
    return out;
  }
  /**
   * Weather page "Forecast": the airport forecast rolled into Today and Tomorrow rows (wxdays.js days(): TAF periods with
   * their exact windows, the app's hours only where no TAF period covers), each with its emoji, plain summary, ranges
   * and the day's call-outs. Aviation adds categories, the decoded periods and the raw TAF behind "Forecast periods".
   */
  function wxForecast(a, v) {
    const tz = dispTz(a), now = refNow();
    const periods = (a.taf && a.taf.periods) || [];
    const days = WXD().days({ now, tz: a.tz || "UTC", periods, hours: v.hours, lat: a.lat, lon: a.lon });
    const calls = dayCallouts(a, v, days);
    const hourLevel = (t) => { const x = (v.hours || []).find((y) => Date.parse(y.t) <= t && t < Date.parse(y.t) + HOUR); return x && x.level != null ? x.level : 0; };
    const rows = days.map((d, i) => {
      const cov = d.none ? [] : [d.from ? "from " + clock(d.from, tz) : null, d.until ? "through " + clock(d.until, tz) : null,
        ...d.gaps.map((g) => "no forecast " + clock(g.from, tz) + "–" + clock(g.to, tz))].filter(Boolean);
      const lvl = Math.max(0, ...(d.hot || []).map(hourLevel));
      const meta = [];
      if (d.wind) meta.push(h("span", {}, d.wind.text));
      if (d.gust != null) meta.push(h("span", { class: d.gust >= 25 ? "gh" : "" }, "gusts to " + d.gust));
      if (d.vis != null && d.vis < 6) meta.push(h("span", {}, "vis down to " + visFrac(d.vis)));
      if (d.cig != null && d.cig < 3000) meta.push(h("span", {}, "clouds as low as " + d.cig.toLocaleString("en-US") + " ft"));
      const summary = d.none ? (d.noAfter != null ? "No forecast after " + whenLabel(d.noAfter, tz) : "No forecast") : d.summary;
      return h("div", { class: "wxd" + (d.none ? " none" : ""), "data-day": d.key },
        h("span", { class: "wxd-e", "aria-hidden": "true" }, d.none ? "" : d.emoji),
        h("div", { class: "wxd-b" },
          h("div", { class: "wxd-h" }, h("b", {}, d.label), cov.length ? h("span", { class: "wxd-cov" }, cov.join(" · ")) : null, aviation() && d.fltCat ? fcChip(d.fltCat) : null),
          h("div", { class: "wxd-s" }, lvl > 0 ? h("i", { class: "wxd-dot " + lv(lvl), "aria-hidden": "true" }) : null, summary),
          meta.length ? h("div", { class: "wxd-m" }, meta) : null,
          ...calls[i].map((t) => h("div", { class: "wxd-x" }, t))));
    });
    const issued = a.taf && a.taf.issued ? "Issued " + whenLabel(Date.parse(a.taf.issued), tz) + " " + zoneAbbr(Date.parse(a.taf.issued), tz) : zoneAbbr(now, tz);
    const hs = AWXOutlook.health(a, outlookOpts(a, v));
    let extra = null;
    if (aviation() && (periods.length || a.taf?.raw)) {
      const per = periods.filter((p) => Date.parse(p.to) > now).map((p) => {
        const c = p.cond || {};
        const k = p.kind === "prevailing" ? "" : p.kind === "PROB" ? "PROB" + (Number.isFinite(p.probability) ? p.probability : "") : p.kind;
        const clouds = (c.clouds || []).map((x) => String(x.cover || "") + (x.base != null ? String(Math.round(x.base / 100)).padStart(3, "0") : "") + (x.type || "")).join(" ");
        const bits = [windKt({ wdir: c.wind && c.wind.dir, wspd: c.wind && c.wind.spd, wgst: c.gust }), c.visib == null ? null : c.visibilityAbove ? "P" + c.visib + "SM" : visTxt(c.visib),
          clouds || null, c.wx || null].filter(Boolean).join(" · ");
        return h("div", { class: "taf-period wxp", "data-kind": p.kind },
          h("div", { class: "wxp-h" }, h("span", {}, whenLabel(Date.parse(p.from), tz) + " – " + whenLabel(Date.parse(p.to), tz)), k ? h("b", {}, k) : null, fcChip(c.fltCat)),
          bits ? h("div", { class: "wxp-d" }, bits) : null);
      });
      extra = h("details", { class: "wxf-per" }, h("summary", {}, "Forecast periods"), ...per, a.taf?.raw ? h("pre", { class: "raw" }, a.taf.raw) : null);
    }
    return section("Forecast", null, [
      a.taf && hs.missingForecast ? h("p", { class: "warn" }, "This forecast may be outdated.") : null,
      !a.taf ? h("p", { class: "muted small wxf-note" }, "This airport has no airport forecast; hourly conditions only.") : null,
      ...rows, extra], null, { cls: "taf-forecast wxf", meta: issued, help: a.taf ? "TAF" : null });
  }
  /** Crosswind/headwind for the best-aligned runway (headings from data/airports-all.json via site/searched.js). */
  async function fillCrosswind(a) {
    const el = document.querySelector(`.cw-xw[data-icao="${a.icao}"]`);
    if (!el) return;
    const m = a.metar;
    const w = m && m.wind;
    if (!w || w.spd == null) { el.textContent = "Crosswind: no wind reported"; return; }
    if (w.spd === 0) { el.textContent = "Calm wind — no crosswind on any runway"; return; }
    const sp = (kt) => (aviation() ? Math.round(kt) + " kt" : mph1(kt) + " mph"); // Traveler mode: mph, never kt
    if (w.dir === "VRB" || w.dir == null) { el.textContent = `Variable wind ${sp(w.spd)} — crosswind can come from any side`; return; }
    let rws = null;
    try { rws = window.AWXExtra && AWXExtra.runways ? await AWXExtra.runways(a.icao, a.iata) : null; } catch (e) { rws = null; }
    if (!document.body.contains(el)) return;
    if (!rws || !rws.length) { el.textContent = "Crosswind: runway headings unavailable"; return; }
    let best = null;
    for (const r of rws) {
      const ends = String(r.ids || "").split("/");
      const n1 = parseInt(ends[0], 10);
      const h1 = r.headingTrue != null ? Number(r.headingTrue) : Number.isFinite(n1) ? n1 * 10 : null;
      if (h1 == null) continue;
      ends.forEach((id, k) => {
        const hd = (h1 + (k ? 180 : 0)) % 360;
        const d = ((Number(w.dir) - hd) * Math.PI) / 180;
        const head = w.spd * Math.cos(d), cross = w.spd * Math.sin(d);
        const gx = m.gust != null ? Math.abs(m.gust * Math.sin(d)) : null;
        if (!best || head > best.head + 0.5 || (Math.abs(head - best.head) <= 0.5 && Math.abs(cross) < Math.abs(best.cross))) best = { id, head, cross, gx };
      });
    }
    if (!best) { el.textContent = "Crosswind: runway headings unavailable"; return; }
    const xc = Math.round(Math.abs(best.cross)), hw = Math.round(best.head);
    el.textContent = `Runway ${best.id}: ${sp(Math.abs(best.cross))} crosswind${xc ? " from the " + (best.cross > 0 ? "right" : "left") : ""}, ${sp(Math.abs(best.head))} ${hw >= 0 ? "headwind" : "tailwind"}` + (best.gx != null && Math.round(best.gx) > xc ? ` (gusts ${sp(best.gx)} across)` : "");
  }

  // ---------- panel: the national list (Settings is the nav shell's site/settings.js) ----------

  const panel = { kind: null };
  function openPanel(kind) {
    panel.kind = kind;
    const wrap = $("panelWrap");
    wrap.hidden = false;
    document.documentElement.classList.add("lock");
    renderNationalPanel();
    $("panel").scrollTop = 0;
    panelCtl.opened();
    void wrap.offsetHeight;
    wrap.classList.add("open");
    const c = $("panel").querySelector(".close");
    if (c) c.focus({ preventScroll: true });
  }
  function closePanel(keepLock) {
    if (!panel.kind) return;
    panel.kind = null;
    const wrap = $("panelWrap");
    wrap.classList.remove("open");
    $("panel").style.transform = "";
    if (!keepLock && !state.openIata) document.documentElement.classList.remove("lock");
    panelCtl.closed();
    const done = () => { if (!panel.kind) wrap.hidden = true; };
    if (reduced()) done(); else setTimeout(done, 300);
  }
  const panelHead = (title) => h("div", { class: "pn-head" }, h("h2", { id: "panelTitle" }, title),
    h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => closePanel() }, closeSvg()));

  function openNational() { openPanel("national"); }
  function renderNationalPanel() {
    const s = nationalSummary();
    const p = $("panel");
    if (!s) { p.replaceChildren(panelHead("Across the U.S.")); return; }
    const row = (a, what) => h("button", { type: "button", class: "nrow", onclick: () => openSheet(a.iata) },
      h("span", { class: "ncode" }, codeOf(a)), h("span", { class: "ntext" }, h("span", {}, a.city + ", " + a.state), h("span", { class: "muted" }, what)), pill(levelOf(a), true));
    const grp = (title, list, what) => (list.length ? h("div", { class: "ngrp" }, h("h3", {}, title), h("div", { class: "glist" }, list.map((a) => row(a, what(a))))) : null);
    const progText = (a, t) => { const f = (view(a).faa || []).find((x) => x.type === t); return f ? programLine(f, a) : t === "ground_stop" ? "Ground stop" : "Delay program"; };
    p.replaceChildren(...[panelHead("Across the U.S."),
      grp("Airports closed", s.closed, () => "Airport closed"),
      grp("Ground stops", s.stops, (a) => progText(a, "ground_stop")),
      grp("Delay programs", s.gdps, (a) => progText(a, "ground_delay")),
      grp("Delays", s.delays, (a) => delaysNow(view(a)).join(" · ") || "Delays"),
      ...s.stormRegions.map((r) => grp("Storms in " + (/^(Alaska|Hawaii)$/.test(r) ? "" : "the ") + r, s.regions[r], (a) => plainList(view(a).peak.reasons, a)[0] || "Thunderstorms")),
      s.items.length ? h("div", { class: "ngrp" }, h("h3", {}, "National FAA notices"), h("div", { class: "glist" }, s.items.map((x) => h("div", { class: "nrow static" }, h("span", { class: "ntext" }, x.text)))),
        srcLine("atcscc", s.items.map((x) => x.raw))) : null,
      !s.line ? h("p", { class: "muted" }, "Nothing affecting flights nationally right now.") : null].filter(Boolean));
  }

  // ---------- wiring ----------

  $("backdrop").addEventListener("click", closeSheet);
  $("panelBackdrop").addEventListener("click", () => closePanel());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (reportPopup.type) closeReportInfo(); else if (md.iata) closeDetails(); else if (panel.kind) closePanel(); else closeSheet(); } });
  // Refresh = a full page reload, like the browser's: refetch index.html past the HTTP cache first so the reload
  // (and checkVersion) see any new version; the icon spins until the page goes. The 2-minute background refresh stays.
  $("refresh").addEventListener("click", () => {
    reloading = true;
    $("refresh").classList.add("spin");
    const go = () => location.reload();
    const t = setTimeout(go, 2500);
    fetch("./index.html", { cache: "reload" }).catch(() => null).then(() => { clearTimeout(t); go(); });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkVersion(); // live relay
      renderHeader();
      if (Date.now() - state.fetchedAt > 20e3) load(false);
    }
  });
  setInterval(() => { if (document.visibilityState === "visible") load(false); }, REFRESH_MS);
  setInterval(renderHeader, 30e3);
  setInterval(() => { if (state.data && state.data.live && document.visibilityState === "visible") renderHeader(); }, 10e3); // live relay: "Live · 40 s ago"
  setInterval(() => { if (document.visibilityState === "visible") checkVersion(); }, 10 * 60e3); // live relay: self-update

  window.AWXApp = {
    state, openSheet, closeSheet, toggleFav, render, tafForecast, // build2a hook: used by site/searched.js
    // build2b: for site/searched.js, the settings UI and check.js
    openDetails, closeDetails, detailRow, popupFocus, refreshDetails: () => { if (md.iata) renderDetails(true); }, // Airport details pages
    ensureCardTimeline, prefs: PREFS, codeOf, view, outlook, summary, hourLevel, slotText, refNow, whenLabel, dispTz, zoneAbbr, clock, hourLabel, daySlots, openNational, closePanel, placeLenses, retime,
    timeline: (a) => timeline(a, {}), // a status.json-shaped airport (searched.js builds one from a shard entry)
    fullAirport: (a) => withDetail(a).a, detailReady, // airport details (check.js)
    version: APP_V,
  };
  window.AWXApp.brief = { shortList, nationalSummary, programsAt, programLine, localMidnight, dayKey, refNow, whenLabel, LEVELS, icon, ICONS, rangeText, zoneTag, hourLevel, hourReasons }; // brief hook: helpers for site/brief.js
  window.AWXApp.setFavs = (list) => { state.favs = list.filter((x) => typeof x === "string"); saveFavs(); render(); }; // nav hook: Settings → Your airports (site/settings.js)
  if (!testMode()) liveConfig(); // live relay: read data/config.json on load
  render();
  load(false);
})();
