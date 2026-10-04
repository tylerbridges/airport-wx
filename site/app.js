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
    taf: "Airport forecast", sigmet: "Thunderstorm alerts", lamp: "Hourly storm chances", tcf: "Storm forecast", cwa: "Center weather advisories",
  };
  const SOURCE_MISSING = {
    faa: "delays may be missing", atcscc: "ground stops may be missing", nws: "warnings may be missing",
    spc: "severe-storm risk may be missing", metar: "current conditions may be missing", taf: "forecast hours may be missing",
    sigmet: "thunderstorm alerts may be missing", lamp: "thunder chances may be missing", tcf: "storm forecasts may be missing",
    cwa: "center weather advisories may be missing",
  };
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
  function clock(ms, tz) {
    const s = tidy(fmt(tz, { hour: "numeric", minute: "2-digit" }, "hm").format(ms));
    return S.clock === "24" ? s.replace(/^24:/, "00:") : s.replace(":00 ", " ");
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

  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const TIME_RE = /\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(\d{1,2})(?::(\d\d))?(?:–(\d{1,2})(?::(\d\d))?)? (AM|PM)\b(?: (ET|CT|MT|PT|AKT|HT|[A-Z]{1,2}[SD]T))?( tomorrow)?/g;
  /**
   * Times written into reason texts by the poller are the airport's local 12-hour clock ("until 7:40 PM CT",
   * "forecast 4–7 PM", "Sun 2:05 AM to Sun 10:05 AM"). Rewrites them for the display settings: zone suffix as
   * "CDT"; with "My time zone" or 24-hour clock each time is resolved to an instant and written again.
   */
  function retime(text, a) {
    const s = String(text || "");
    if (!a || !/\d (AM|PM)\b/.test(s)) return s;
    const src = a.tz || "UTC";
    const tz = dispTz(a);
    const convert = S.clock === "24" || tz !== src;
    const ref = dataRef();
    const base = ymd(ref, src);
    const resolve = (h12, mi, ap, wd, tomorrow, after) => {
      const hr = (Number(h12) % 12) + (ap === "PM" ? 12 : 0);
      const cands = [];
      for (let d = -1; d <= 7; d++) cands.push({ d, t: localToUtc(base.year, base.month, base.day + d, hr, Number(mi || 0), src) });
      if (wd) {
        const c = cands.find((x) => fmt(src, { weekday: "short" }, "wd").format(x.t) === wd && x.t >= ref - 24 * HOUR);
        if (c) return c.t;
      }
      if (tomorrow) return cands.find((x) => x.d === 1).t;
      const min = after != null ? after : ref - 3 * HOUR;
      return (cands.find((x) => x.t >= min) || cands[1]).t;
    };
    return s.replace(TIME_RE, (all, wd, h1, m1, h2, m2, ap, zone, tmw) => {
      if (!convert) {
        if (!zone) return all;
        const t = resolve(h2 || h1, h2 ? m2 : m1, ap, wd, !!tmw);
        return all.replace(" " + zone, " " + zoneAbbr(t, src));
      }
      const end = resolve(h2 || h1, h2 ? m2 : m1, ap, wd, !!tmw);
      let start = null;
      if (h2) {
        start = resolve(h1, m1, ap, wd, !!tmw);
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
      return "Thunderstorms over the airport" + (ends.length ? " until " + clock(Math.max(...ends), dispTz(a)) : "");
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
    s = s.replace(/^Mist\b/, "Light fog / haze").replace(/\bmist\b/g, "light fog / haze");
    s = s.replace(/^Center weather advisory: IFR conditions/, "Low clouds or poor visibility advisory").replace(/^Center weather advisory: thunderstorms/, "Thunderstorm advisory");
    s = s.replace(/^Thunderstorms, (\w+) coverage \(TCF\)/, "Thunderstorms forecast, $1 coverage");
    s = s.replace(/ \((LAMP|TCF|ATCSCC)\)/g, "");
    s = s.replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/\b(\d+)h\b/g, "$1 hr").replace(/(\d)m\b/g, "$1 min");
    return retime(s, a);
  }
  const plainList = (arr, a) => uniq((arr || []).map((r) => plainReason(r, a)).filter(Boolean));
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
    return { "GROUND STOP": "Ground stop", DELAYS: "Delays", CLOSED: "Closed", "RUNWAY CLOSED": "Runway closed" }[s.toUpperCase()] || s;
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
      else if (/BR/.test(k)) p = "Mist";
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

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
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
  /** Starred airports first (non-majors via site/searched.js, with their zone), then the visible list; at most 12. */
  function liveQuery() {
    const majors = new Set(((state.build && state.build.airports) || []).map((a) => a.iata));
    const ids = [];
    const tz = [];
    const add = (c) => { if (c && ids.length < LIVE_MAX && !ids.includes(c)) ids.push(c); };
    for (const c of (window.AWXTrips && AWXTrips.liveIds ? AWXTrips.liveIds() : [])) if (majors.has(c)) add(c); // trips hook: trip airports first
    for (const c of state.favs) if (majors.has(c)) add(c);
    const extra = (window.AWXExtra && AWXExtra.liveIds && AWXExtra.liveIds()) || [];
    for (const x of extra) if (ids.length < LIVE_MAX && x.icao && !ids.includes(x.icao)) { add(x.icao); if (x.tz) tz.push(x.icao + ":" + x.tz); }
    for (const a of visibleAirports()) add(a.iata);
    return ids.length ? "ids=" + encodeURIComponent(ids.join(",")) + (tz.length ? "&tz=" + encodeURIComponent(tz.join(",")) : "") : null;
  }
  async function loadLive() {
    if (testMode() || state.sample || !(await liveConfig())) return;
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
  /** state.data = the build with the live airports (and sources) over it, unless the last live call failed. */
  function mergeLive() {
    const b = state.build;
    const L = live.data;
    state.liveWx = {};
    viewCache = new WeakMap();
    if (!b || state.sample || live.failed || !L || !(Date.parse(L.generated) >= Date.parse(b.generated))) { state.data = b; return; }
    const by = new Map(L.airports.map((a) => [a.iata, a]));
    const airports = b.airports.map((a) => by.get(a.iata) || a)
      .sort((x, y) => y.peak.level - x.peak.level || y.now.level - x.now.level || x.iata.localeCompare(y.iata));
    state.data = Object.assign({}, b, { airports, sources: Object.assign({}, b.sources, L.sources), live: L.generated });
    state.liveWx = L.wx || {};
    state.liveH0 = L.h0;
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

  let loading = false;
  let reloading = false; // the refresh button is reloading the page: keep the spinner
  async function load(manual) {
    if (loading) return;
    loading = true;
    $("refresh").classList.add("spin");
    if (manual) checkVersion(); // live relay
    const liveP = state.build ? loadLive() : null; // live relay: in parallel with the build once the airport list is known
    try {
      let data, sample = false;
      try {
        data = window.AWXTest && AWXTest.name ? AWXTest.rebase(await getJson(AWXTest.url)) : await getJson("./data/status.json"); // build2a hook: ?test=<scenario> (site/testmode.js)
      } catch (e) {
        if (e.status !== 404) throw e;
        data = await getJson("./data/sample.json");
        sample = true;
      }
      if (!data || !Array.isArray(data.airports)) throw new Error("bad data");
      state.build = data; // live relay (merged into state.data below)
      state.sample = sample;
      state.fetchError = null;
      state.fetchedAt = Date.now();
    } catch (e) {
      state.fetchError = manual || !state.data ? "Couldn't load data" : "Couldn't refresh";
    } finally {
      await (liveP || loadLive()); // live relay: the refresh button waits for fresh data
      mergeLive();
      loading = false;
      state.loaded = true;
      setTimeout(() => { if (!reloading) $("refresh").classList.remove("spin"); }, manual ? 500 : 0);
      render();
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
    if (window.AWXExtra) window.AWXExtra.render(); // build2a hook: search + searched/starred non-major airports (site/searched.js)
    if (window.AWXTrips) window.AWXTrips.render(); // trips hook: "Your trips" (site/trips.js)
    if (panel.kind === "national") renderNationalPanel();
  }

  function renderHeader() {
    const el = $("updated");
    const d = state.data;
    el.classList.remove("stale");
    if (!d) { el.textContent = state.loaded ? "Not updated" : "Loading…"; return; }
    if (state.sample) { el.textContent = "Sample data"; return; }
    el.classList.remove("livefail"); // live relay
    if (d.live) { const s = Math.max(0, Date.now() - Date.parse(d.live)); el.textContent = "Live · " + (s < 60e3 ? Math.round(s / 1e3) + " s ago" : ago(s)); return; }
    const age = Date.now() - Date.parse(d.generated);
    el.textContent = (live.failed ? "Live data unavailable — showing data from " : "Updated ") + ago(age);
    if (live.failed) el.classList.add("livefail");
    if (age > STALE_MS) el.classList.add("stale");
  }

  /** My airports in the favourites' order; All / At risk sorted by level under the current settings. */
  /** Airports for the lists and counts: trip-only airports stay off unless starred (trips hook). */
  const listed = () => ((state.data && state.data.airports) || []).filter((a) => !a.trip || state.favs.includes(a.iata));
  function visibleAirports() {
    const all = listed();
    if (state.filter === "mine") {
      const by = new Map(all.map((a) => [a.iata, a]));
      return state.favs.map((c) => by.get(c)).filter(Boolean);
    }
    const sorted = all.slice().sort((x, y) => view(y).peak.level - view(x).peak.level || view(y).now.level - view(x).now.level || x.iata.localeCompare(y.iata));
    if (state.filter === "risk") return sorted.filter((a) => view(a).peak.level >= 2);
    return sorted;
  }

  function renderSeg() {
    const all = listed(); // trips hook
    const counts = {
      mine: all.filter((a) => state.favs.includes(a.iata)).length,
      all: all.length,
      risk: all.filter((a) => view(a).peak.level >= 2).length,
    };
    const tabs = [["mine", "My airports"], ["all", "All"], ["risk", "At risk"]];
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
    b.replaceChildren(...kids);
  }

  function renderList() {
    const list = $("list");
    if (!state.data) {
      list.replaceChildren(
        h("div", { class: "empty" }, state.fetchError ? [state.fetchError + ".", h("br"), h("button", { type: "button", onclick: () => load(true) }, "Try again")] : "Loading airports…")
      );
      return;
    }
    const items = visibleAirports();
    if (!items.length) {
      const msg = state.filter === "mine"
        ? "No saved airports yet. Open All and tap the star on an airport to add it here."
        : "No airports at risk right now.";
      list.replaceChildren(h("div", { class: "empty" }, msg));
      return;
    }
    list.classList.toggle("mine", state.filter === "mine");
    list.replaceChildren(...items.map((a, i) => card(a, i, items.length)));
    requestAnimationFrame(placeLenses);
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

  function pill(level, small) {
    return h("span", { class: "pill " + lv(level) + (small ? " sm" : "") }, LEVELS[level].label);
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
        s = f && f.level != null ? { kind: j === nowSlot ? "now" : "fc", level: f.level, reasons: f.reasons, h: f } : { kind: "na", level: null, reasons: [], h: null };
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
    if (a.nowText) return "Now · " + a.nowText;
    const c = a.metar ? metarCond(a.metar) : a.hours[0];
    const w = shortCond(c, a.metar && a.metar.raw);
    return "Now · " + (w || LEVELS[view(a).now.level].label);
  }
  /** "9 PM · High · Very low clouds" (past hours: "9 AM · Observed · Minor · Rain"). */
  function slotText(s, a) {
    const tz = dispTz(a);
    const when = (dayKey(s.t, tz) === dayKey(refNow(), tz) ? "" : timelineDay(s.t, tz) + " ") + hourLabel(s.t, tz);
    if (s.kind === "none") return when + " · No report";
    if (s.kind === "na") return when + " · Forecast not available yet";
    const top = plainList(s.reasons, a)[0];
    return [s.kind === "now" ? "Now" : when, s.kind === "obs" ? (s.observed ? "Observed" : "Earlier forecast") : null, LEVELS[s.level].label, top].filter(Boolean).join(" · ");
  }

  /**
   * Timeline element. Cards are read-only; opts.big enables held previews in the detail sheet.
   * The lens sits on the current hour at rest.
   */
  function timeline(a, opts = {}) {
    const big = !!opts.big;
    const day = daySlots(a, opts.dayOff || 0);
    const { slots, tz } = day;
    const n = slots.length;
    const segs = slots.map((s) => h("span", {
      class: "s " + (s.level == null ? "nd" : lv(s.level)) + (s.kind === "obs" || s.kind === "none" ? " past" : "") + (s.i === day.cur ? " cur" : ""),
      "data-i": s.i,
    }));
    const lensSeg = h("span", { class: "lens-seg" });
    const lens = h("span", { class: "lens", "aria-hidden": "true" }, lensSeg);
    const tl = h("div", { class: "tl" + (big ? " big" : ""), style: `grid-template-columns:repeat(${n},minmax(0,1fr))` }, segs, lens);
    const ticks = h("div", { class: "ticks", "aria-hidden": "true" });
    slots.forEach((s, i) => {
      const parts = fmt(tz, { hour: "numeric" }, "H24n").formatToParts(s.t);
      const hour = Number(parts.find((x) => x.type === "hour").value);
      const lh = S.clock === "24" ? hour % 24 : hour % 12 + (parts.some((x) => x.type === "dayPeriod" && /PM/i.test(x.value)) ? 12 : 0);
      if (lh === 0) tl.append(h("span", { class: "midnight-mark", style: `left:${(i / n) * 100}%`, "aria-hidden": "true" }));
      if (lh % 6 === 0 && i <= n - 3) ticks.append(h("span", { style: `left:${(i / n) * 100}%`, class: i < 2 ? "first" : "" }, tickLabel(s.t, tz),
        lh === 0 ? h("small", { class: "tick-day" }, timelineDay(s.t, tz)) : null));
    });
    ticks.append(h("span", { class: "last", style: "left:100%" }, tickLabel(day.end, tz),
      h("small", { class: "tick-day" }, timelineDay(day.end, tz))));
    const label = h("div", { class: "lenslabel", "aria-hidden": "true" });
    const na = slots.findIndex((x, i) => x.kind === "na" && slots.slice(i).every((y) => y.kind === "na"));
    const naNote = na >= 0 ? h("div", { class: "nanote" }, "Forecast not available yet from " + timelineDay(slots[na].t, tz) + " " + hourLabel(slots[na].t, tz)) : null;
    const wrap = h("div", {
      class: "tl-wrap" + (big ? " bigwrap" : " cardwrap"), tabindex: big ? "0" : null, role: big ? "slider" : "img",
      "aria-label": big ? "Hourly risk, " + (opts.dayOff ? "tomorrow" : "past 12 hours and next 24 hours") : timelineLabel(a),
      "aria-description": big ? "Hold and slide to preview an hour. Release to return to the normal view." : null,
      "aria-valuemin": big ? "0" : null, "aria-valuemax": big ? String(n - 1) : null, "aria-valuenow": big ? String(Math.max(0, day.cur)) : null,
      "aria-valuetext": big ? (day.cur >= 0 ? slotText(slots[day.cur], a) : slotText(slots[0], a)) : null,
      "data-start": String(day.start), "data-tz": tz,
    }, label, tl, ticks, naNote);
    const T = { wrap, tl, lens, lensSeg, label, segs, slots, day, a, rest: day.cur, big, opts };
    wrap._tl = T;
    if (big) wireBigScrub(T);
    return wrap;
  }

  function timelineLabel(a) {
    return `Past 12 hours and next 24 hours at ${codeOf(a)}: peak ${LEVELS[view(a).peak.level].label}`;
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
      if (T.big) {
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
    lensSeg.style.width = sw + "px";
    lensSeg.className = "lens-seg " + (T.slots[i].level == null ? "nd" : lv(T.slots[i].level)) + (seg.classList.contains("past") ? " past" : "");
    wrap.classList.toggle("scrub", !!scrub);
    label.hidden = false;
    label.textContent = scrub || i !== T.rest || T.slots[i].kind === "na" ? slotText(T.slots[i], T.a) : nowWords(T.a);
    const lw = Math.min(W, label.offsetWidth);
    label.style.left = Math.max(0, Math.min(W - lw, cx - lw / 2)) + "px";
    if (T.big) {
      wrap.setAttribute("aria-valuenow", String(i));
      wrap.setAttribute("aria-valuetext", slotText(T.slots[i], T.a));
    }
  }
  function placeLenses() {
    for (const w of document.querySelectorAll(".tl-wrap")) if (w._tl && !w.classList.contains("scrub")) placeLens(w._tl, w._tl.shown != null ? w._tl.shown : w._tl.rest, false);
  }
  addEventListener("resize", () => requestAnimationFrame(placeLenses));
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

  let swallowClick = 0;
  document.addEventListener("click", (e) => { if (Date.now() < swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  /** Detail timelines preview only while a pointer or navigation key is held. */
  function wireBigScrub(T) {
    const bar = T.tl;
    let g = null, raf = 0;
    const heldKeys = new Set();
    const keys = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);
    const show = (i) => {
      if (T.shown !== i) tickSeg(T, i);
      T.shown = i;
      placeLens(T, i, true);
      if (T.opts.onPreview) T.opts.onPreview(i);
    };
    const finish = () => {
      const pointer = g;
      g = null;
      heldKeys.clear();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (pointer && bar.hasPointerCapture(pointer.id)) bar.releasePointerCapture(pointer.id);
      if (T.opts.onRelease) T.opts.onRelease();
      springBack(T);
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || g) return;
      heldKeys.clear();
      g = { id: e.pointerId, x: e.clientX };
      try { bar.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      show(slotAt(T, g.x));
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      g.x = e.clientX;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (g) show(slotAt(T, g.x));
      });
    });
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

  function card(a, idx, count) {
    const v = view(a);
    const fav = state.favs.includes(a.iata);
    const later = laterPeak(v);
    const reason = plainList(later ? v.peak.reasons : v.now.reasons, a)[0] || (v.peak.level ? "Minor weather conditions" : "No significant weather");
    const mine = state.filter === "mine";
    const code = codeOf(a);
    const el = h("div", {
      class: "card", role: "button", tabindex: "0", "data-iata": a.iata,
      "aria-label": `${code}, ${a.city}. ${LEVELS[v.peak.level].label} risk. ${reason}`,
      onclick: () => openSheet(a.iata),
      onkeydown: (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); openSheet(a.iata); }
        if (mine && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target === el) { e.preventDefault(); moveMine(a.iata, e.key === "ArrowUp" ? -1 : 1, true); }
      },
    },
      h("div", { class: "top" },
        h("div", { class: "code" }, code),
        h("div", { class: "right" },
          pill(v.peak.level),
          h("button", {
            type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + code + (fav ? " from" : " to") + " my airports",
            onclick: (e) => { e.stopPropagation(); toggleFav(a.iata); },
            onkeydown: (e) => e.stopPropagation(),
          }, starSvg()))),
      h("div", { class: "aname" }, a.name),
      h("div", { class: "where" }, `${a.city}, ${a.state}`),
      h("div", { class: "reason" }, reason),
      window.AWXMovement ? safeCall(() => AWXMovement.line(a)) : null, // movement hook: "Departures running 38% below normal" (site/movement.js)
      window.AWXDelay ? safeCall(() => AWXDelay.delayLine(a)) : null, // phase3 hook: chance of a real delay (site/delay.js)
      later ? h("div", { class: "sub" }, "Now: " + LEVELS[v.now.level].label) : null,
      cardPrograms(v).length ? h("div", { class: "badges" }, faaBadges(v)) : null,
      timeline(a, {}),
      mine && count > 1 ? h("div", { class: "sr-move" },
        idx > 0 ? h("button", { type: "button", class: "sr", onclick: (e) => { e.stopPropagation(); moveMine(a.iata, -1, true); }, onkeydown: (e) => e.stopPropagation() }, `Move ${code} up`) : null,
        idx < count - 1 ? h("button", { type: "button", class: "sr", onclick: (e) => { e.stopPropagation(); moveMine(a.iata, 1, true); }, onkeydown: (e) => e.stopPropagation() }, `Move ${code} down`) : null) : null);
    if (mine) wireReorder(el);
    return el;
  }

  /** Move a major airport one place up/down among the cards shown on My airports (non-majors keep their slots). */
  function moveMine(iata, dir, refocus) {
    const shown = visibleAirports().map((a) => a.iata);
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
    const cards = () => [...$("list").querySelectorAll(":scope > .card")];
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
    onClose: () => closeSheet(), header: ".grab, .sh-head", backdrop: $("backdrop"), noPull: ".tl.big, .tl-wrap, .lamp, .cw-bar",
  }) : noSheet;
  const panelCtl = window.AWXSheet ? AWXSheet.makeSheet($("panel"), { onClose: () => closePanel(), header: ".pn-head", backdrop: $("panelBackdrop") }) : noSheet;

  let lastFocus = null;
  function openSheet(iata) {
    if (panel.kind) closePanel(true);
    state.openIata = iata;
    sheetDay = 0;
    lastFocus = document.activeElement;
    const wrap = $("sheetWrap");
    wrap.hidden = false;
    document.documentElement.classList.add("lock");
    renderSheet(false);
    sheetCtl.opened();
    void wrap.offsetHeight; // reflow so the transition runs
    wrap.classList.add("open");
    const c = wrap.querySelector(".close");
    if (c) c.focus({ preventScroll: true });
    requestAnimationFrame(placeLenses);
  }

  function closeSheet() {
    if (!state.openIata) return;
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
  function section(title, ico, kids, src, opts = {}) {
    const s = src && state.data && state.data.sources && state.data.sources[src.key];
    const meta = opts.meta || (src ? (SEC_META[src.key] || "") + (s && s.at ? " · " + ago(Math.max(0, refNow() - Date.parse(s.at))).replace(" ago", "") : "") : "");
    return h("section", { class: "sec", id: opts.id || null },
      h("div", { class: "sec-h" }, ico ? icon(ICONS[ico]) : null, h("h3", {}, title), h("span", { class: "rule", "aria-hidden": "true" }), meta ? h("span", { class: "meta" }, meta) : null),
      h("div", { class: "scard" + (opts.cls ? " " + opts.cls : "") }, ...kids, src ? srcLine(src.key, src.raw) : null));
  }
  function rawToggle(text) {
    return aviation() && text ? h("pre", { class: "raw rawt" }, text) : null;
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
    const detail = (r.split(/[/:]/).pop() || "").trim().toLowerCase();
    if (f.cause === "runway" && detail && !/runway/.test(detail)) return "runway " + detail.replace(/^rwy\s*/, "");
    const lab = f.causeLabel || "";
    const m = /\(([^)]+)\)$/.exec(lab);
    return m ? m[1] : lab || detail;
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
      if (f.type === "closure") { if (isNow && (f.scope || "full") === "full" && f.active !== false) out.push(f); continue; }
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
    const until = end ? "until " + whenLabel(end, tz) : /until /.test(f.detail || "") ? retime(/until [^,]+/.exec(f.detail)[0], a) : "until further notice";
    const avg = /avg ([^,]+)/.exec(f.detail || "");
    if (f.type === "closure") return "Airport closed";
    if (f.type === "ground_stop") return "Ground stop " + until;
    if (f.type === "ground_delay") return "Delay program " + until + (avg ? ", avg " + durTxt(avg[1]) : "");
    return "Delays: " + delayText(f.detail).replace(/^Delays /, "").replace(/^./, (c) => c.toLowerCase());
  }

  function faaItem(f, a) {
    const chip = aviation() ? h("div", { class: "chips" }, confChip("FAA", "high")) : null;
    if (f.type === "closure") {
      const info = f.scope === "limited" || f.active === false;
      const cls = f.scope === "runway" ? "l1" : "l4";
      return h("div", { class: "item" + (info ? " info" : "") },
        !info && f.badge ? h("span", { class: "badge " + cls }, badgeText(f.badge)) : null,
        h("div", { class: info ? "muted" : "", style: info ? "" : "margin-top:4px" }, retime(f.plain || [f.reason, f.detail].filter(Boolean).join(" · "), a)),
        info ? null : chip, rawToggle(f.reason));
    }
    const why = plainCause(f);
    let text;
    if (f.type === "delay") text = delayText(f.detail) + (why ? ` (${why})` : "");
    else if (f.type === "ground_delay") {
      const avg = /avg ([^,]+)/.exec(f.detail || ""), max = /max ([^,]+)/.exec(f.detail || "");
      text = "Flights to " + codeOf(a) + " are held before departure" + (avg ? `: about ${durTxt(avg[1])} on average` : "") + (max ? `, up to ${durTxt(max[1])}` : "") + (why ? ` (${why})` : "");
    } else text = "Flights to " + codeOf(a) + " are held at their departure airports" + (why ? ` (${why})` : "");
    const until = /until [^,]+$/.exec(f.detail || "");
    const end = f.end ? "until " + whenLabel(Date.parse(f.end), dispTz(a)) : until ? retime(until[0], a) : "until further notice";
    return h("div", { class: "item" },
      h("span", { class: "badge " + (FAA_CLS[f.type] || "l2") }, badgeText(f.badge || f.type)),
      h("div", { style: "margin-top:4px" }, text + ", " + end + "."),
      chip, rawToggle(faaRaw(f)));
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
    const name = { GS: "Ground stop", GDP: "Ground delay program", AFP: "Airspace flow program" }[x.type] || "Advisory";
    return h("div", { class: "item" },
      h("span", { class: "badge " + cls }, name), h("span", { class: "muted" }, " " + status),
      x.causeLabel || x.causeText ? h("div", { style: "margin-top:4px" }, cap(x.causeLabel || x.causeText)) : null,
      x.issued ? h("div", { class: "muted small" }, "Issued " + whenLabel(Date.parse(x.issued), tz)) : null,
      aviation() && x.active ? h("div", { class: "chips" }, confChip("FAA", "high")) : null,
      rawToggle(x.title));
  }

  /** The FAA Command Center operations plan's items for this airport, as plain sentences. */
  function planItems(v, a) {
    const op = v.opsplan;
    if (!op || !(op.items || []).length) return [];
    const order = { program: 0, note: 1, staffing: 2, constraint: 3, sir: 4 };
    const items = [...op.items].sort((x, y) => (y.level - x.level) || ((order[x.kind] ?? 9) - (order[y.kind] ?? 9)));
    const lead = h("div", { class: "muted small", style: "margin:0 0 2px" },
      "From the FAA Command Center" + (op.plan && op.plan.issued ? " · plan issued " + whenLabel(Date.parse(op.plan.issued), dispTz(a)) : ""));
    return [lead, ...items.map((x) => h("div", { class: "item" + (x.level ? "" : " info") },
      x.level ? h("span", { class: "badge " + lv(x.level) }, LEVELS[x.level].label) : null,
      h("div", { class: x.level ? "" : "muted", style: x.level ? "margin-top:4px" : "" },
        retime(x.text, a) + (x.ifr ? " — can slow landings in low clouds or poor visibility" : "") + "." + (x.dup ? " Also in Delays & closures above." : "")),
      aviation() && x.level ? h("div", { class: "chips" }, confChip("FAA", CATS.reason(x.text).conf || "high")) : null,
      rawToggle(x.raw)))];
  }

  function lampTable(a) {
    const tz = dispTz(a);
    const t0 = Date.parse(a.hours[0].t);
    const hrs = (a.lamp.hours || []).filter((x) => { const t = Date.parse(x.t); return t >= t0 && t < t0 + 24 * HOUR; });
    if (!hrs.length) return null;
    const notable = hrs.some((x) => (x.tstmProb || 0) >= 10 || (x.convProb || 0) >= 30 || (x.pPrecip || 0) >= 30 || (x.gust || 0) >= 20 || (lampCat(x) && lampCat(x) !== "VFR"));
    if (!notable) return null;
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

  function checkedLine() {
    const d = state.data;
    const src = (d && d.sources) || {};
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
    const when = state.sample ? "sample data" : d ? ago(Math.max(0, Date.now() - Date.parse(d.generated))) : "";
    if (d && !state.sample && refNow() - Date.parse(d.generated) > STALE_MS) warn.unshift("Data is " + when + " — status may have changed");
    return h("div", { class: "checked" },
      warn.map((w) => h("p", { class: "warn" }, w)),
      any ? h("p", { class: "muted" }, `Checked FAA delays and NOAA weather${when ? " · " + when : ""}`) : null);
  }

  /** Technical data is visible in Aviation mode, without expandable cards. */
  function pilotDetails(a) {
    if (!aviation()) return null;
    const kids = [];
    const tz = dispTz(a);
    const zl = (ms) => clock(ms, tz) + " " + zoneAbbr(ms, tz);
    const sub = (t) => h("h4", { class: "pd-h" }, t);
    if (a.metar) {
      kids.push(sub("Current METAR"),
        h("div", { class: "box" }, h("dl", { class: "kv", style: "margin:0" }, metarRows(a.metar))),
        a.metar.obsTime ? h("div", { class: "muted small", style: "margin:6px 4px 0" }, "Observed " + ago(Math.max(0, refNow() - Date.parse(a.metar.obsTime))) + " · " + zl(Date.parse(a.metar.obsTime))) : null,
        h("pre", { class: "raw", style: "margin-top:10px" }, a.metar.raw));
    }
    if (a.taf) kids.push(sub("TAF" + (a.taf.issued ? " · issued " + zl(Date.parse(a.taf.issued)) : "")), h("pre", { class: "raw" }, a.taf.raw));
    const lt = a.lamp ? lampTable(a) : null;
    if (lt) kids.push(sub("LAMP guidance · issued " + zl(Date.parse(a.lamp.issued))), ...lt);
    if (a.sigmets && a.sigmets.length) kids.push(sub("Convective SIGMETs"), ...a.sigmets.map((x) => h("pre", { class: "raw", style: "margin-top:6px" }, x.raw)));
    if (a.cwa && a.cwa.length) kids.push(sub("Center weather advisories"), ...a.cwa.map((x) => h("div", { class: "item" },
      h("b", {}, x.hazard ? "CWA · " + x.hazard : "CWA"),
      x.validTo ? h("span", { class: "muted" }, " · until " + whenLabel(Date.parse(x.validTo), tz)) : null,
      x.raw ? h("pre", { class: "raw", style: "margin-top:6px" }, x.raw) : null)));
    if (a.tcf && a.tcf.length) kids.push(sub("TFM convective forecast"), ...a.tcf.map((x) => h("div", { class: "item" },
      h("b", {}, cap(x.coverageRaw || x.coverage || "Unknown") + " coverage"),
      h("span", { class: "muted" }, [x.valid && " · valid " + whenLabel(Date.parse(x.valid), tz), x.confidence && " · confidence " + String(x.confidence).toLowerCase(), x.tops && " · tops " + x.tops].filter(Boolean).join("")))));
    if (!kids.length) return null;
    return section("Pilot details", "plane", [h("div", { class: "pd" }, ...kids)], null, { cls: "pilot" });
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
    const status = normal ? o.normalNote || (o.kind === "hour" && o.past ? "No disruption reported" : o.kind === "peak" || o.kind === "hour" && !o.isNow ? "No disruption expected" : "Operating normally")
      : meaningful ? L.word : o.level > 0 ? o.level === 1 ? "Minor disruption possible" : "Disruption possible" : null;
    const delay = status ? h("div", { class: "sc-delay" }, status) : null;
    const list = normal ? null : rs.length
      ? o.full ? h("p", { class: "rline" }, rs.join(" · ")) : h("ul", { class: "reasons" }, rs.map((r) => h("li", {}, r)))
      : o.empty ? h("div", { class: "none" }, o.empty) : null;
    // program status and the departure/arrival impact share one line; with source chips only in full-width cards
    const prog = o.programs && o.programs.length ? o.programs.map((f) => programLine(f, a)).join(" · ") : "";
    const imp = o.impact && prog ? o.impact.replace(/ \([^)]*\)$/, "") : o.impact;
    const progLine = o.simple ? null : o.full && (prog || imp) ? h("div", { class: "sc-prog" }, prog, prog && imp ? h("span", { class: "sc-imp" }, " · " + imp) : !prog ? h("span", { class: "sc-imp" }, imp) : null)
      : !o.full && prog ? h("div", { class: "sc-prog" }, prog) : null;
    return h("div", { class: "box sc" + (o.full ? " full" : ""), "data-kind": o.kind },
      h("div", { class: "sc-h" },
        h("h4", {}, h("span", { class: "sc-label" }, o.label), o.level != null ? pill(o.level, true) : null, (o.full || o.simple) && o.when ? h("span", { class: "sc-when in" }, o.when) : null)),
      !o.full && !o.simple && o.when ? h("div", { class: "sc-when" }, o.when) : null,
      delay,
      list,
      progLine,
      o.simple ? null : o.facts);
  }

  let sheetDay = 0; // 0 rolling window, 1 tomorrow
  function renderSheet(keepScroll) {
    const a = state.data && state.data.airports.find((x) => x.iata === state.openIata);
    const sheet = $("sheet");
    if (!a) { closeSheet(); return; }
    const top = sheet.scrollTop;
    const v = view(a);
    const tz = dispTz(a);
    const fav = state.favs.includes(a.iata);
    const code = codeOf(a);
    const t0 = Date.parse(v.hours[0].t);
    const nowCond = Object.assign({}, v.hours[0], a.metar ? metarCond(a.metar) : {}, { fltCat: (a.metar && a.metar.fltCat) || v.hours[0].fltCat });
    const later = laterPeak(v);
    const layout = CATS.restLayout(v.now.level, v.peak.level, later);
    const endMs = levelEnd(v);
    const lastMs = Date.parse(v.hours[v.hours.length - 1].t) + HOUR;
    const nowPrograms = programsAt(v, t0, true);
    const sources = state.data.sources || {};
    const incomplete = state.sample || !a.metar || refNow() - Date.parse(a.metar.obsTime) > 2 * HOUR || ["faa", "atcscc", "metar", "taf"].some((k) => !sources[k] || !sources[k].ok || sources[k].error || sources[k].stale);
    const stale = refNow() - Date.parse(state.data.generated) > STALE_MS;
    const normalNote = stale ? "Status may be outdated" : incomplete ? "No disruptions reported · some data unavailable"
      : v.hiddenCats && v.hiddenCats.size ? "No issues in your selected categories" : null;

    // rest state: Now | Peak, or one full-width "Now · Peak" / clear card
    const restCards = () => {
      if (layout === "split") {
        const pk = v.hours.find((x) => x.t === v.peak.at) || v.hours[0];
        const pt = Date.parse(pk.t);
        return h("div", { class: "two" },
          stateCard({ a, kind: "now", simple: true, label: "Now", level: v.now.level, when: "through " + whenLabel(endMs, tz), delay: v.hours[0].delay,
            normalNote, reasons: shortList(v.now.reasons, a), programs: nowPrograms, impact: CATS.impact(v.now.reasons, nowPrograms), facts: factsRow(nowCond, a, t0, false, true), chips: cardSources(v.now.reasons, "now") }),
          stateCard({ a, kind: "peak", simple: true, label: "Coming up", level: v.peak.level, when: peakRange(v), delay: pk.delay,
            reasons: shortList(pk.reasons, a), programs: programsAt(v, pt, false), impact: CATS.impact(pk.reasons, programsAt(v, pt, false)), facts: factsRow(pk, a, pt, false, true), chips: cardSources(pk.reasons, "fc") }));
      }
      let when;
      if (layout === "clear") when = "Clear through " + whenLabel(lastMs, tz);
      else {
        const nxt = v.hours.find((x) => Date.parse(x.t) >= endMs);
        when = "through " + whenLabel(endMs, tz);
        if (nxt) {
          let j = v.hours.indexOf(nxt);
          while (j + 1 < v.hours.length && v.hours[j + 1].level === nxt.level) j++;
          const e2 = Date.parse(v.hours[j].t) + HOUR;
          when += ", then " + LEVELS[nxt.level].label;
        }
      }
      return stateCard({ a, kind: "nowpeak", full: true, simple: true, label: "Now", level: v.now.level, when, delay: v.hours[0].delay,
        normalNote, reasons: shortList(v.now.reasons, a), programs: nowPrograms, impact: CATS.impact(v.now.reasons, nowPrograms), facts: factsRow(nowCond, a, t0, false, true),
        chips: cardSources(v.now.reasons, "now"), empty: null });
    };
    const hourCard = (s) => {
      const isNow = s.kind === "now";
      const past = s.kind === "obs" || s.kind === "none";
      const c = s.h ? (isNow ? nowCond : s.h) : null;
      const label = cap(whenLabel(s.t, tz));
      const zulu = aviation() ? " · " + new Date(s.t).toISOString().slice(11, 13) + "00Z" : "";
      const when = (s.kind === "obs" ? (s.observed ? "Observed" : "Earlier forecast") : s.kind === "none" ? "No report" : s.kind === "na" ? "Forecast not available yet" : isNow ? "Now" : "Forecast") + zulu;
      const progs = past || s.kind === "na" ? [] : programsAt(v, s.key, isNow);
      return stateCard({ a, kind: "hour", past, normalNote: isNow ? normalNote : null, isNow, full: true, max: 3, label, level: s.level, when, delay: !past && s.h ? s.h.delay : null,
        reasons: shortList(s.reasons, a), programs: progs, impact: s.level == null ? null : CATS.impact(s.reasons, progs),
        facts: c ? factsRow(c, a, s.key, past, true) : null, chips: s.level == null ? [] : cardSources(s.reasons, s.kind),
        empty: s.kind === "none" ? "No weather report for this hour" : s.kind === "na" ? "Forecast not available yet" : null });
    };

    const boxWrap = h("div", { class: "boxwrap", "aria-live": "polite" });
    let tlEl = null;
    const setLayer = (i, live) => {
      boxWrap.classList.toggle("live", !!live);
      for (const L of boxWrap.children) {
        const on = i == null ? L.dataset.layer === "rest" : L.dataset.i === String(i);
        L.classList.toggle("on", on);
        L.setAttribute("aria-hidden", String(!on));
      }
    };
    const buildLayers = (slots) => {
      boxWrap.replaceChildren(h("div", { class: "bx-layer on", "data-layer": "rest" }, restCards()),
        ...slots.map((s) => h("div", { class: "bx-layer", "data-i": String(s.i), "aria-hidden": "true" }, hourCard(s))));
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
        tlTitle.textContent = sheetDay ? "Tomorrow" : "Next 24 hours";
        if (window.AWXTrips) window.AWXTrips.decorateSheet(sheet, a); // trips hook: plane markers on the shown day
        requestAnimationFrame(placeLenses);
      } }, sheetDay ? "‹ Now" : "Tomorrow ›");
    const tlTitle = h("span", {}, sheetDay ? "Tomorrow" : "Next 24 hours");

    // detail cards (build2b), each only when it has content
    const secs = [];
    const add = (cond, fn) => { if (cond) secs.push(fn()); };
    add(v.faa && v.faa.length, () => section("Delays & closures", "clock", v.faa.map((f) => faaItem(f, a)), { key: "faa" }));
    const notices = [...[...(v.atcscc || [])].filter((x) => aviation() || !x.cnx && (x.active || Date.parse(x.start) > refNow())).sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0)).map((x) => advItem(x, a)),
      ...planItems(aviation() ? v : { ...v, opsplan: v.opsplan ? { ...v.opsplan, items: (v.opsplan.items || []).filter((x) => x.level > 0 && !x.dup) } : null }, a)];
    add(notices.length, () => section("FAA traffic notices", "tower", notices, { key: "atcscc" }));
    const nts = window.AWXNotices ? safeCall(() => AWXNotices.section(v, a, { h, section, aviation: aviation(), retime: (t) => retime(t, a), hidden: isHidden, now: refNow(), sources: state.data.noticeSources || {} })) : null; // notams hook: "Notices" (site/notices.js)
    if (nts) secs.push(nts);
    add(a.metar, () => currentWeather(a));
    add(v.alerts && v.alerts.length, () => section("Weather warnings", "alert", v.alerts.map((x) => h("div", { class: "item" }, h("b", {}, x.event),
      x.ends ? h("span", { class: "muted" }, " · until " + dayClock(Date.parse(x.ends), tz)) : null,
      x.headline ? h("div", { class: "muted", style: "font-size:13px;margin-top:2px" }, retime(x.headline, a)) : null,
      aviation() ? h("div", { class: "chips" }, confChip("NWS", /Warning/.test(x.event) ? "high" : "medium")) : null)), { key: "nws", raw: v.alerts.map((x) => [x.event, x.headline].filter(Boolean).join("\n")) }));
    // Storms: thunderstorms over the airport, the severe-storm outlook and the aviation storm forecast as sub-rows
    const storms = [];
    if (v.sigmets && v.sigmets.length) storms.push(h("div", { class: "item" }, h("div", { class: "subt" }, "Thunderstorms"),
      h("div", {}, plainReason("Convective SIGMET over airport", v) + ", or within 10 nautical miles."), aviation() ? h("div", { class: "chips" }, confChip("NWS", "high")) : null));
    if (v.spc) storms.push(h("div", { class: "item" }, h("div", { class: "subt" }, "Storm outlook"),
      v.spc === "TSTM" ? h("div", { class: "muted" }, "General thunderstorms possible in the area (no severe risk)")
        : h("div", { style: "font-weight:600" }, (SPC_NAMES[v.spc] || v.spc) + " risk of severe storms", h("span", { class: "muted", style: "font-weight:400" }, " · today's outlook")),
      aviation() ? h("div", { class: "chips" }, confChip("SPC", "medium")) : null));
    if (v.tcf && v.tcf.length) storms.push(h("div", { class: "item" }, h("div", { class: "subt" }, "Storm forecast"), ...v.tcf.map((x) => h("div", {},
      h("b", {}, "Thunderstorms, " + ({ high: "widespread", medium: "scattered", low: "isolated" }[x.coverage] || "some") + " coverage"),
      x.valid ? h("span", { class: "muted" }, " · around " + whenLabel(Date.parse(x.valid), tz)) : null,
      x.confidence ? h("div", { class: "muted small" }, "Forecaster confidence " + String(x.confidence).toLowerCase()) : null)),
      aviation() ? h("div", { class: "chips" }, confChip("NWS", "medium")) : null));
    add(storms.length, () => section("Storms", "bolt", storms, null, { meta: [v.sigmets && v.sigmets.length && "NWS", v.spc && "SPC", v.tcf && v.tcf.length && "NWS"].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join(" · "),
      raw: null }));
    if (storms.length) secs[secs.length - 1].querySelector(".scard").append(srcLine(v.sigmets && v.sigmets.length ? "sigmet" : v.spc ? "spc" : "tcf", (v.sigmets || []).map((x) => x.raw)));
    // movement hook: "Traffic right now" (site/movement.js), its card body inside a build2b section card
    const mv = window.AWXMovement && typeof AWXMovement.card === "function" ? safeCall(() => AWXMovement.card(a)) : null;
    if (mv) {
      const box = mv.nodeType ? mv.querySelector(".mv-card") : null;
      if (box) box.classList.remove("card");
      secs.push(section("Traffic right now", "plane", [box || (mv.nodeType ? mv : String(mv))], null, { meta: "ADS-B" }));
    }
    const pd = pilotDetails(a);
    if (pd) secs.push(pd);
    // Show a meaningful delay outlook directly below the timeline.
    const dl = window.AWXDelay && typeof AWXDelay.delayBlock === "function" ? safeCall(() => AWXDelay.delayBlock(a, null)) : null; // phase3 hook
    const hiddenNote = v.hiddenCats && v.hiddenCats.size
      ? h("p", { class: "hidnote" }, "Hidden by your settings: " + [...v.hiddenCats].map((k) => CATS.LABELS[k]).join(", ") + ". Ground stops and airport closures are always shown.")
      : null;
    const zoneLine = S.tz === "mine" ? "Times in " + zoneAbbr(refNow(), USER_TZ) : zoneAbbr(refNow(), a.tz);

    sheet.replaceChildren(...[
      h("div", { class: "grab", "aria-hidden": "true" }),
      h("div", { class: "sh-head" },
        h("div", { class: "sh-code", id: "sheetTitle" }, code),
        h("div", { class: "right", style: "gap:6px" },
          h("button", { type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + code + (fav ? " from" : " to") + " my airports", onclick: () => toggleFav(a.iata) }, starSvg()),
          h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeSheet }, closeSvg()))),
      h("div", { class: "sh-where" }, h("b", { class: "sh-aname" }, a.name), h("span", { class: "muted" }, " · " + `${a.city}, ${a.state}` + (S.tz === "mine" ? " · " + zoneLine : ""))),
      // above the timeline: only the header, the Now / Peak (or single) card and the timeline itself
      boxWrap,
      h("section", { class: "sec tlsec" },
        h("div", { class: "sec-h" }, icon(ICONS.clock), h("h3", {}, tlTitle), h("span", { class: "rule", "aria-hidden": "true" }), dayBtn),
        tlHolder),
      dl && (dl.nodeType ? dl.childNodes.length || dl.nodeType === 1 : true) ? section("Delay outlook", "clock", [dl.nodeType ? dl : String(dl)], null, { cls: "dlcard" }) : null, // phase3 hook
      ...secs,
      hiddenNote,
      checkedLine(),
    ].filter(Boolean));
    if (window.AWXTrips) window.AWXTrips.decorateSheet(sheet, a); // trips hook: "Your flight" row + plane markers
    if (keepScroll) sheet.scrollTop = top;
    requestAnimationFrame(placeLenses);
    fillCrosswind(a);
  }

  function safeCall(fn) {
    try { return fn(); } catch (e) { console.warn(e); return null; }
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
  function visWords(v) {
    if (v == null) return "—";
    const mi = v >= 10 ? "10+ miles" : v < 1 ? "under 1 mile" : (Math.round(v * 4) / 4) + (v === 1 ? " mile" : " miles");
    return (v > 5 ? "Good" : v >= 3 ? "Moderate" : v >= 1 ? "Poor" : "Very poor") + " (" + mi + ")";
  }
  function currentWeather(a) {
    const m = a.metar;
    if (!m) return null;
    const cond = shortCond(metarCond(m), m.raw);
    const cat = m.fltCat;
    const temp = m.temp != null ? f1(m.temp) + "°" : "—";
    const head = h("div", { class: "cw-top" },
      h("div", { class: "cw-temp" }, temp, aviation() && m.temp != null ? h("span", { class: "cw-c" }, m.temp + "°C") : null),
      h("div", { class: "cw-cond" }, cond));
    const w = m.wind || {};
    const kv = [
      ["Temperature", m.temp != null ? `${f1(m.temp)}°F` + (aviation() ? ` · ${m.temp}°C` : "") : "—"],
      ["Wind", w.spd == null ? "—" : w.spd === 0 ? "Calm" : (w.dir == null || w.dir === "VRB" ? "Variable" : "From " + compass(w.dir)) + " " + mph1(w.spd) + " mph"],
      ["Gusts", m.gust != null ? mph1(m.gust) + " mph" : "None"],
      ["Visibility", visWords(m.visib)],
    ];
    if (aviation() && cat) kv.push(["Flight category", fcChip(cat)]);
    const grid = h("dl", { class: "kv2" }, kv.map(([k, val]) => h("div", {}, h("dt", {}, k), h("dd", {}, val))));
    const obs = m.obsTime ? "Observed " + ago(Math.max(0, refNow() - Date.parse(m.obsTime))) : "";
    if (!aviation()) {
      const rows = kv.filter(([k]) => k !== "Temperature" && (k !== "Gusts" || m.gust != null));
      return section("Current weather", "sun", [head, h("dl", { class: "kv2" }, rows.map(([k, val]) => h("div", {}, h("dt", {}, k), h("dd", {}, val))))], null, { cls: "cw", meta: obs });
    }
    const age = m.obsTime ? agoShort(refNow() - Date.parse(m.obsTime)) : "";
    const maxW = Math.max(40, Math.ceil(((m.gust || 0) + 5) / 10) * 10);
    return section("Current weather", "sun", [head,
      cat ? h("div", { class: "cw-cat" }, fcChip(cat), h("span", {}, " — " + FC_EXPLAIN[cat])) : null,
      grid,
      catScale("Ceiling", m.ceiling != null ? m.ceiling.toLocaleString("en-US") + " ft" : "None", scalePos(m.ceiling, [500, 1000, 3000, 12000])),
      catScale("Visibility", visTxt(m.visib), scalePos(m.visib, [1, 3, 5, 10])),
      tickBar("Wind " + (w.dir != null ? (w.dir === "VRB" ? "variable" : String(w.dir).padStart(3, "0") + "°") : ""), w.spd, maxW),
      tickBar("Gusts", m.gust, maxW, "gust"),
      h("div", { class: "cw-xw", "data-icao": a.icao }, "Crosswind: checking runways…"),
      h("div", { class: "srcl metar" }, "METAR · REPORTED " + age,
        h("pre", { class: "raw" }, metarMarked(m.raw)))], null, { cls: "cw av", meta: obs });
  }
  const compass = (d) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((Number(d) % 360) + 360) % 360 / 45) % 8];
  /** Crosswind/headwind for the best-aligned runway (headings from data/airports-all.json via site/searched.js). */
  async function fillCrosswind(a) {
    const el = document.querySelector(`.cw-xw[data-icao="${a.icao}"]`);
    if (!el) return;
    const m = a.metar;
    const w = m && m.wind;
    if (!w || w.spd == null) { el.textContent = "Crosswind: no wind reported"; return; }
    if (w.spd === 0) { el.textContent = "Calm wind — no crosswind on any runway"; return; }
    if (w.dir === "VRB" || w.dir == null) { el.textContent = `Variable wind ${w.spd} kt — crosswind can come from any side`; return; }
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
    el.textContent = `Runway ${best.id}: ${xc} kt crosswind${xc ? " from the " + (best.cross > 0 ? "right" : "left") : ""}, ${Math.abs(hw)} kt ${hw >= 0 ? "headwind" : "tailwind"}` + (best.gx != null && Math.round(best.gx) > xc ? ` (gusts ${Math.round(best.gx)} kt across)` : "");
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
    const row = (a, what) => h("button", { type: "button", class: "nrow", onclick: () => { closePanel(true); openSheet(a.iata); } },
      h("span", { class: "ncode" }, codeOf(a)), h("span", { class: "ntext" }, h("span", {}, a.city + ", " + a.state), h("span", { class: "muted" }, what)), pill(view(a).peak.level, true));
    const grp = (title, list, what) => (list.length ? h("div", { class: "ngrp" }, h("h3", {}, title), h("div", { class: "glist" }, list.map((a) => row(a, what(a))))) : null);
    const progText = (a, t) => { const f = (view(a).faa || []).find((x) => x.type === t); return f ? programLine(f, a) : t === "ground_stop" ? "Ground stop" : "Delay program"; };
    p.replaceChildren(...[panelHead("Across the U.S."),
      grp("Airports closed", s.closed, () => "Airport closed"),
      grp("Ground stops", s.stops, (a) => progText(a, "ground_stop")),
      grp("Delay programs", s.gdps, (a) => progText(a, "ground_delay")),
      grp("Delays", s.delays, (a) => delaysNow(view(a)).join(" · ") || "Delays"),
      ...s.stormRegions.map((r) => grp("Storms in the " + r, s.regions[r], (a) => plainList(view(a).peak.reasons, a)[0] || "Thunderstorms")),
      s.items.length ? h("div", { class: "ngrp" }, h("h3", {}, "National FAA notices"), h("div", { class: "glist" }, s.items.map((x) => h("div", { class: "nrow static" }, h("span", { class: "ntext" }, x.text)))),
        srcLine("atcscc", s.items.map((x) => x.raw))) : null,
      !s.line ? h("p", { class: "muted" }, "Nothing affecting flights nationally right now.") : null].filter(Boolean));
  }

  // ---------- wiring ----------

  $("backdrop").addEventListener("click", closeSheet);
  $("panelBackdrop").addEventListener("click", () => closePanel());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (panel.kind) closePanel(); else closeSheet(); } });
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
    state, openSheet, closeSheet, toggleFav, render, // build2a hook: used by site/searched.js
    // build2b: for site/searched.js, the settings UI and check.js
    prefs: PREFS, codeOf, view, dispTz, zoneAbbr, clock, hourLabel, daySlots, openNational, closePanel, placeLenses,
    timeline: (a) => timeline(a, {}), // a status.json-shaped airport (searched.js builds one from a shard entry)
    version: APP_V,
  };
  window.AWXApp.setFavs = (list) => { state.favs = list.filter((x) => typeof x === "string"); saveFavs(); render(); }; // nav hook: Settings → Your airports (site/settings.js)
  if (!testMode()) liveConfig(); // live relay: read data/config.json on load
  render();
  load(false);
})();
