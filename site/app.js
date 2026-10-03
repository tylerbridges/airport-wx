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

  const fmtCache = new Map();
  function fmt(tz, opts, key) {
    const k = tz + key;
    if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, opts)));
    return fmtCache.get(k);
  }
  const tidy = (s) => s.replace(/[  ]/g, " ");
  function clock(ms, tz) {
    return tidy(fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "hm").format(ms)).replace(":00 ", " ");
  }
  function hourLabel(ms, tz) {
    return tidy(fmt(tz, { hour: "numeric", hour12: true }, "h").format(ms));
  }
  function dayClock(ms, tz) {
    return tidy(fmt(tz, { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }, "wh").format(ms)).replace(":00 ", " ");
  }
  function tzAbbr(ms, tz) {
    const p = fmt(tz, { timeZoneName: "short" }, "z").formatToParts(ms).find((x) => x.type === "timeZoneName");
    const n = p ? p.value : "";
    const map = { EDT: "ET", EST: "ET", CDT: "CT", CST: "CT", MDT: "MT", MST: "MT", PDT: "PT", PST: "PT", AKDT: "AKT", AKST: "AKT" };
    return map[n] || n;
  }

  function ago(ms) {
    const m = Math.floor(ms / 60e3);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + " hr" + (m % 60 ? " " + (m % 60) + " min" : "") + " ago";
    return Math.floor(hrs / 24) + " d ago";
  }

  const refNow = () => (state.sample && state.data ? Date.parse(state.data.generated) : Date.now());

  // ---------- plain wording (the data keeps aviation codes for history; the page shows plain English) ----------

  const mph = (kt) => Math.round((Number(kt) * 1.15) / 5) * 5;
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
      return "Thunderstorms over the airport" + (ends.length ? " until " + clock(Math.max(...ends), a.tz) : "");
    }
    const c = /^(Chance of )?[Cc]eiling ([\d,]+) ft(.*)$/.exec(s);
    if (c) {
      const ft = Number(c[2].replace(/,/g, ""));
      if (ft >= 1000) return null;
      const w = ft < 500 ? "very low clouds" : "low clouds";
      return (c[1] ? "Chance of " + w : cap(w)) + c[3];
    }
    s = s.replace(/\b([Vv])isibility ((?:\d+ )?\d+(?:\/\d+)?) sm\b/g, (all, V, v) =>
      visNum(v) < 1 ? (V === "V" ? "Poor visibility" : "poor visibility") : `${V}isibility about ${v} ${visNum(v) === 1 ? "mile" : "miles"}`);
    s = s.replace(/\bThunderstorm gusts (\d+) kt\b/g, (all, n) => `Thunderstorm wind gusts to ${mph(n)} mph`);
    s = s.replace(/\b([Gg])usts (\d+) kt\b/g, (all, G, n) => `${G === "G" ? "Wind gusts" : "wind gusts"} to ${mph(n)} mph`);
    s = s.replace(/^Mist\b/, "Light fog / haze").replace(/\bmist\b/g, "light fog / haze");
    s = s.replace(/^Center weather advisory: IFR conditions/, "Center weather advisory: low clouds or poor visibility");
    s = s.replace(/^Thunderstorms, (\w+) coverage \(TCF\)/, "Thunderstorms forecast, $1 coverage");
    s = s.replace(/ \((LAMP|TCF|ATCSCC)\)/g, "");
    s = s.replace(/\b(\d+)h (\d+)m\b/g, "$1 hr $2 min").replace(/\b(\d+)h\b/g, "$1 hr").replace(/(\d)m\b/g, "$1 min");
    return s;
  }
  const plainList = (arr, a) => uniq((arr || []).map((r) => plainReason(r, a)).filter(Boolean));
  /** Badge words: "GDP avg 49m" -> "Arrival delays ~49 min". */
  function badgeText(b) {
    const s = String(b || "");
    const g = /^GDP(?: avg (.+))?$/i.exec(s);
    if (g) return g[1] ? "Arrival delays ~" + g[1].replace(/(\d+)h(\d+)m/, "$1 hr $2 min").replace(/(\d+)m$/, "$1 min").replace(/(\d+)h$/, "$1 hr") : "Arrival delays";
    return { "GROUND STOP": "Ground stop", DELAYS: "Delays", CLOSED: "Closed", "RUNWAY CLOSED": "Runway closed" }[s.toUpperCase()] || s;
  }
  const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));

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
      setTimeout(() => $("refresh").classList.remove("spin"), manual ? 500 : 0);
      render();
    }
  }

  // ---------- rendering ----------

  function render() {
    renderHeader();
    renderSeg();
    renderBanner();
    renderList();
    renderNotes();
    if (state.openIata) renderSheet(true);
    if (window.AWXExtra) window.AWXExtra.render(); // build2a hook: search + searched/starred non-major airports (site/searched.js)
    if (window.AWXTrips) window.AWXTrips.render(); // trips hook: "Your trips" (site/trips.js)
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

  function visibleAirports() {
    const all = ((state.data && state.data.airports) || []).filter((a) => !a.trip || state.favs.includes(a.iata)); // trips hook: trip-only airports stay off the lists
    if (state.filter === "mine") return all.filter((a) => state.favs.includes(a.iata));
    if (state.filter === "risk") return all.filter((a) => a.peak.level >= 2);
    return all;
  }

  function renderSeg() {
    const all = ((state.data && state.data.airports) || []).filter((a) => !a.trip || state.favs.includes(a.iata)); // trips hook
    const counts = {
      mine: all.filter((a) => state.favs.includes(a.iata)).length,
      all: all.length,
      risk: all.filter((a) => a.peak.level >= 2).length,
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
    const mvAlert = window.AWXMovement && state.data ? AWXMovement.alerts() : null; if (mvAlert) kids.push(mvAlert); // movement hook: airline alerts (into #natstrip instead when it exists)
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
    list.replaceChildren(...items.map(card));
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
  /** "3 AM", "tomorrow 6 PM", "Mon 6 PM" relative to the reference time, in the airport's zone. */
  function whenLabel(ms, tz) {
    const day = (x) => fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(x);
    const ref = refNow();
    if (day(ms) === day(ref)) return clock(ms, tz);
    if (day(ms) === day(ref + 24 * HOUR)) return "tomorrow " + clock(ms, tz);
    return fmt(tz, { weekday: "short" }, "wd").format(ms) + " " + clock(ms, tz);
  }
  /** End of the run of hours at the current level. */
  function levelEnd(a) {
    const l0 = a.hours[0].level;
    let j = 0;
    while (j + 1 < a.hours.length && a.hours[j + 1].level === l0) j++;
    return Date.parse(a.hours[j].t) + HOUR;
  }
  /** "4–7 PM" (or "tomorrow 2–5 AM") for the run of peak-level hours starting at the peak. */
  function peakRange(a) {
    const tz = a.tz;
    let p = a.hours.findIndex((x) => x.t === a.peak.at);
    if (p < 0) p = 0;
    let q = p;
    while (q + 1 < a.hours.length && a.hours[q + 1].level === a.peak.level) q++;
    const start = Date.parse(a.hours[p].t);
    const end = Date.parse(a.hours[q].t) + HOUR;
    const day = (x) => fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(x);
    const sa = clock(start, tz), sb = clock(end, tz);
    const w = whenLabel(start, tz);
    const prefix = w.indexOf(" ") > 0 && !/^\d/.test(w) ? w.slice(0, w.indexOf(" ")) + " " : "";
    // compress "4–7 PM" only on the same day and the same AM/PM half; else "11 PM – 1 AM tomorrow"
    if (day(start) === day(end) && sa.split(" ").pop() === sb.split(" ").pop()) return prefix + sa.slice(0, sa.lastIndexOf(" ")) + "–" + sb;
    if (day(start) === day(end)) return prefix + sa + " – " + sb;
    const wb = whenLabel(end, tz);
    return prefix + sa + " – " + (/^\d/.test(wb) ? wb : wb.slice(wb.indexOf(" ") + 1) + " " + wb.slice(0, wb.indexOf(" ")));
  }
  const uniq = (arr) => [...new Set(arr || [])];

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
  /** Flight category from LAMP ceiling (1-8) and visibility (1-7) categories. */
  function lampCat(x) {
    const c = x.cig == null ? 9 : x.cig, v = x.vis == null ? 9 : x.vis;
    if (c <= 2 || v <= 2) return "LIFR";
    if (c <= 3 || v <= 4) return "IFR";
    if (c <= 5 || v <= 5) return "MVFR";
    return x.cig == null && x.vis == null ? null : "VFR";
  }

  function timeline(a, big, onPick) {
    const hours = a.hours;
    const tz = a.tz;
    const t0 = Date.parse(hours[0].t);
    const frac = Math.max(0, Math.min(1, (refNow() - t0) / (hours.length * HOUR)));
    const segs = hours.map((hr, i) => {
      const top = plainList(hr.reasons, a)[0];
      const label = hourLabel(Date.parse(hr.t), tz) + ": " + LEVELS[hr.level].label + (top ? " — " + top : "");
      if (big) {
        return h("button", { type: "button", class: "s " + lv(hr.level), "aria-label": label, "aria-pressed": "false", "data-i": i,
          onclick: (e) => onPick && onPick(i, e.currentTarget) });
      }
      return h("span", { class: "s " + lv(hr.level) });
    });
    const tl = h("div", { class: "tl" + (big ? " big" : ""), role: big ? "group" : "img", "aria-label": big ? "Hourly risk, next 24 hours" : timelineLabel(a) }, segs,
      h("span", { class: "nowm", style: `left:${(frac * 100).toFixed(2)}%` }));
    const ticks = h("div", { class: "ticks", "aria-hidden": "true" });
    for (let i = 0; i < hours.length; i += 6) {
      ticks.append(h("span", { style: `left:${(i / hours.length) * 100}%` }, i === 0 ? "Now" : hourLabel(Date.parse(hours[i].t), tz)));
    }
    ticks.append(h("span", { class: "tz" }, tzAbbr(t0, tz)));
    return h("div", { class: "tl-wrap" }, tl, ticks);
  }

  function timelineLabel(a) {
    const worst = a.peak.level;
    return `Next 24 hours at ${a.iata}: peak ${LEVELS[worst].label}`;
  }

  function card(a) {
    const fav = state.favs.includes(a.iata);
    const later = laterPeak(a);
    const reason = plainList(later ? a.peak.reasons : a.now.reasons, a)[0] || (a.peak.level ? "Minor weather conditions" : "No significant weather");
    const nowDiffers = later;
    const el = h("div", {
      class: "card", role: "button", tabindex: "0", "data-iata": a.iata,
      "aria-label": `${a.iata}, ${a.city}. ${LEVELS[a.peak.level].label} risk. ${reason}`,
      onclick: () => openSheet(a.iata),
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); openSheet(a.iata); } },
    },
      h("div", { class: "top" },
        h("div", { class: "code" }, a.iata),
        h("div", { class: "right" },
          pill(a.peak.level),
          h("button", {
            type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + a.iata + (fav ? " from" : " to") + " my airports",
            onclick: (e) => { e.stopPropagation(); toggleFav(a.iata); },
            onkeydown: (e) => e.stopPropagation(),
          }, starSvg()))),
      h("div", { class: "aname" }, a.name),
      h("div", { class: "where" }, `${a.city}, ${a.state}`),
      h("div", { class: "reason" }, reason),
      window.AWXMovement ? AWXMovement.line(a) : null, // movement hook: "Departures running 38% below normal" (site/movement.js)
      window.AWXDelay ? AWXDelay.delayLine(a) : null, // phase3 hook: chance of a real delay (site/delay.js)
      nowDiffers ? h("div", { class: "sub" }, "Now: " + LEVELS[a.now.level].label) : null,
      cardPrograms(a).length ? h("div", { class: "badges" }, faaBadges(a)) : null,
      timeline(a, false));
    return el;
  }

  function starSvg() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M12 3.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z");
    p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
    return svg;
  }
  function closeSvg() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M3 3l10 10M13 3L3 13");
    p.setAttribute("stroke-linecap", "round");
    svg.append(p);
    return svg;
  }

  // ---------- bottom sheet ----------

  let lastFocus = null;
  function openSheet(iata) {
    state.openIata = iata;
    lastFocus = document.activeElement;
    const wrap = $("sheetWrap");
    wrap.hidden = false;
    document.documentElement.classList.add("lock");
    renderSheet(false);
    void wrap.offsetHeight; // reflow so the transition runs
    wrap.classList.add("open");
    const c = wrap.querySelector(".close");
    if (c) c.focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!state.openIata) return;
    state.openIata = null;
    const wrap = $("sheetWrap");
    const sheet = $("sheet");
    wrap.classList.remove("open");
    sheet.style.transform = "";
    sheet.style.transition = "";
    document.documentElement.classList.remove("lock");
    const done = () => { if (!state.openIata) wrap.hidden = true; };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
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

  const f1 = (c) => Math.round((c * 9) / 5 + 32);

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
    add("Visibility", m.visib != null ? (m.visib >= 10 ? "10+" : String(Math.round(m.visib * 100) / 100)) + " sm" : "—");
    add("Ceiling", m.ceiling != null ? m.ceiling.toLocaleString("en-US") + " ft" : "None");
    add("Weather", decodeWx(m.wx));
    add("Temp / dew", m.temp != null ? `${m.temp}° / ${m.dewp ?? "—"}°C (${f1(m.temp)}° / ${m.dewp != null ? f1(m.dewp) : "—"}°F)` : "—");
    return rows;
  }

  function section(title, ...kids) {
    return h("div", { class: "sec" }, h("h3", {}, title), ...kids);
  }
  const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
  const FAA_CLS = { ground_stop: "l4", closure: "l4", ground_delay: "l3", delay: "l2" };

  function rawToggle(text) {
    return h("details", { class: "rawt" }, h("summary", {}, "Show raw"), h("pre", { class: "raw" }, text));
  }

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

  function faaItem(f, a) {
    if (f.type === "closure") {
      const info = f.scope === "limited" || f.active === false;
      const cls = f.scope === "runway" ? "l1" : "l4";
      return h("div", { class: "item" + (info ? " info" : "") },
        !info && f.badge ? h("span", { class: "badge " + cls }, badgeText(f.badge)) : null,
        h("div", { class: info ? "muted" : "", style: info ? "" : "margin-top:4px" }, f.plain || [f.reason, f.detail].filter(Boolean).join(" · ")),
        f.reason ? rawToggle(f.reason) : null);
    }
    const why = plainCause(f);
    const until = /until [^,]+$/.exec(f.detail || "");
    let text;
    if (f.type === "delay") text = delayText(f.detail) + (why ? ` (${why})` : "");
    else if (f.type === "ground_delay") {
      const avg = /avg ([^,]+)/.exec(f.detail || ""), max = /max ([^,]+)/.exec(f.detail || "");
      const d = (x) => x.replace(/\b(\d+)h (\d+)m\b/, "$1 hr $2 min").replace(/(\d)m\b/, "$1 min").replace(/(\d)h\b/, "$1 hr");
      text = "Flights to " + a.iata + " are held before departure" + (avg ? `: about ${d(avg[1])} on average` : "") + (max ? `, up to ${d(max[1])}` : "") + (why ? ` (${why})` : "");
    } else text = "Flights to " + a.iata + " are held at their departure airports" + (why ? ` (${why})` : "");
    const end = f.end ? "until " + whenLabel(Date.parse(f.end), a.tz) : until ? until[0] : "until further notice";
    return h("div", { class: "item" },
      h("span", { class: "badge " + (FAA_CLS[f.type] || "l2") }, badgeText(f.badge || f.type)),
      h("div", { style: "margin-top:4px" }, text + ", " + end + "."),
      f.reason ? rawToggle("FAA: " + f.reason + (f.detail ? "\n" + f.detail : "")) : null);
  }

  function advItem(x, tz) {
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
      x.title ? rawToggle(x.title) : null);
  }

  /** The FAA Command Center operations plan's items for this airport, as plain sentences with the original line. */
  function planItems(a) {
    const op = a.opsplan;
    if (!op || !(op.items || []).length) return [];
    const order = { program: 0, note: 1, staffing: 2, constraint: 3, sir: 4 };
    const items = [...op.items].sort((x, y) => (y.level - x.level) || ((order[x.kind] ?? 9) - (order[y.kind] ?? 9)));
    const lead = h("div", { class: "muted small", style: "margin:0 0 2px" },
      "From the FAA Command Center" + (op.plan && op.plan.issued ? " · plan issued " + whenLabel(Date.parse(op.plan.issued), a.tz) : ""));
    return [lead, ...items.map((x) => h("div", { class: "item" + (x.level ? "" : " info") },
      x.level ? h("span", { class: "badge " + lv(x.level) }, LEVELS[x.level].label) : null,
      h("div", { class: x.level ? "" : "muted", style: x.level ? "margin-top:4px" : "" },
        x.text + (x.ifr ? " — can slow landings in low clouds or poor visibility" : "") + "." + (x.dup ? " Also in Delays & closures above." : "")),
      x.raw ? rawToggle(x.raw) : null))];
  }

  function lampTable(a) {
    const tz = a.tz;
    const t0 = Date.parse(a.hours[0].t);
    const hrs = (a.lamp.hours || []).filter((x) => { const t = Date.parse(x.t); return t >= t0 && t < t0 + 24 * HOUR; });
    if (!hrs.length) return null;
    const notable = hrs.some((x) => (x.tstmProb || 0) >= 10 || (x.convProb || 0) >= 30 || (x.pPrecip || 0) >= 30 || (x.gust || 0) >= 20 || (lampCat(x) && lampCat(x) !== "VFR"));
    if (!notable) return null;
    const short = (ms) => hourLabel(ms, tz).replace(" AM", "a").replace(" PM", "p");
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
    }
    const when = state.sample ? "sample data" : d ? ago(Math.max(0, Date.now() - Date.parse(d.generated))) : "";
    return h("div", { class: "checked" },
      warn.map((w) => h("p", { class: "warn" }, w)),
      any ? h("p", { class: "muted" }, `Checked FAA delays and NOAA weather${when ? " · " + when : ""}`) : null);
  }

  /** Coded aviation detail, collapsed at the bottom of the sheet (until the aviation view exists). */
  function pilotDetails(a) {
    const kids = [];
    const sub = (t) => h("h4", { class: "pd-h" }, t);
    if (a.metar) {
      kids.push(sub("Current METAR"),
        h("div", { class: "box" }, h("dl", { class: "kv", style: "margin:0" }, metarRows(a.metar))),
        a.metar.obsTime ? h("div", { class: "muted small", style: "margin:6px 4px 0" }, "Observed " + ago(Math.max(0, refNow() - Date.parse(a.metar.obsTime)))) : null,
        h("pre", { class: "raw", style: "margin-top:10px" }, a.metar.raw));
    }
    if (a.taf) kids.push(sub("TAF" + (a.taf.issued ? " · issued " + clock(Date.parse(a.taf.issued), a.tz) : "")), h("pre", { class: "raw" }, a.taf.raw));
    const lt = a.lamp ? lampTable(a) : null;
    if (lt) kids.push(sub("LAMP guidance · issued " + clock(Date.parse(a.lamp.issued), a.tz)), ...lt);
    if (a.sigmets && a.sigmets.length) kids.push(sub("Convective SIGMETs"), ...a.sigmets.map((x) => h("pre", { class: "raw", style: "margin-top:6px" }, x.raw)));
    if (a.cwa && a.cwa.length) kids.push(sub("Center weather advisories"), ...a.cwa.map((x) => h("div", { class: "item" },
      h("b", {}, x.hazard ? "CWA · " + x.hazard : "CWA"),
      x.validTo ? h("span", { class: "muted" }, " · until " + whenLabel(Date.parse(x.validTo), a.tz)) : null,
      x.raw ? h("pre", { class: "raw", style: "margin-top:6px" }, x.raw) : null)));
    if (a.tcf && a.tcf.length) kids.push(sub("TFM convective forecast"), ...a.tcf.map((x) => h("div", { class: "item" },
      h("b", {}, cap(x.coverageRaw || x.coverage || "Unknown") + " coverage"),
      h("span", { class: "muted" }, [x.valid && " · valid " + whenLabel(Date.parse(x.valid), a.tz), x.confidence && " · confidence " + String(x.confidence).toLowerCase(), x.tops && " · tops " + x.tops].filter(Boolean).join("")))));
    if (!kids.length) return null;
    return h("details", { class: "sec pilot" }, h("summary", {}, "Pilot details"), h("div", { class: "pd" }, ...kids));
  }

  let sheetPick = null; // hour index selected in the detail timeline
  function renderSheet(keepScroll) {
    const a = state.data && state.data.airports.find((x) => x.iata === state.openIata);
    const sheet = $("sheet");
    if (!a) { closeSheet(); return; }
    const top = sheet.scrollTop;
    const tz = a.tz;
    const t0 = Date.parse(a.hours[0].t);
    const fav = state.favs.includes(a.iata);
    // Now + Peak side by side; picking an hour swaps them for one full-width hour card.
    const boxWrap = h("div", { class: "boxwrap", "aria-live": "polite" });
    const reasonsList = (arr, level) => {
      const rs = plainList(arr, a);
      return rs.length ? h("ul", { class: "reasons" }, rs.map((r) => h("li", {}, r)))
        : h("div", { class: "muted", style: "font-size:14px" }, level ? "Minor weather conditions" : "No significant weather");
    };
    const nowBox = () => h("div", { class: "box" },
      h("h4", {}, "Now ", pill(a.now.level, true)),
      h("div", { class: "muted small", style: "margin:-2px 0 6px" }, "through " + whenLabel(levelEnd(a), tz)),
      reasonsList(a.now.reasons, a.now.level));
    const peakBox = () => {
      if (laterPeak(a)) {
        return h("div", { class: "box" }, h("h4", {}, "Peak ", pill(a.peak.level, true)),
          h("div", { class: "muted small", style: "margin:-2px 0 6px" }, peakRange(a)),
          reasonsList(a.peak.reasons, a.peak.level));
      }
      // The peak is now: say so and what comes after, instead of repeating the Now reasons.
      const endMs = levelEnd(a);
      const nxt = a.hours.find((x) => Date.parse(x.t) >= endMs);
      return h("div", { class: "box" }, h("h4", {}, "Peak ", pill(a.peak.level, true)),
        h("div", { class: "muted small", style: "margin:-2px 0 6px" }, a.peak.level ? "Now" : "Next 24 hours"),
        h("div", { style: "font-size:14px" },
          !a.peak.level ? "Nothing expected"
            : nxt ? (nxt.level ? "Highest right now. Eases to " + LEVELS[nxt.level].label + " after " : "Highest right now. Clear after ") + whenLabel(endMs, tz)
            : "Highest right now, through the next 24 hours"));
    };
    const showBoxes = () => {
      sheetPick = null;
      sheet.querySelectorAll(".tl.big .s").forEach((b) => b.setAttribute("aria-pressed", "false"));
      boxWrap.replaceChildren(window.AWXDelay ? AWXDelay.delayBlock(a, null) : "", h("div", { class: "two" }, nowBox(), peakBox())); // phase3 hook: "Will it cause delays?" above Now/Peak
    };
    const showHour = (i, btn) => {
      if (sheetPick === i && btn && btn.getAttribute("aria-pressed") === "true") { showBoxes(); return; }
      sheetPick = i;
      sheet.querySelectorAll(".tl.big .s").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const hr = a.hours[i];
      const th = lampThunderAt(a, Date.parse(hr.t));
      boxWrap.replaceChildren(window.AWXDelay ? AWXDelay.delayBlock(a, i) : "", h("div", { class: "box hourbox" }, // phase3 hook: delay block for the picked hour
        h("div", { class: "hb-top" },
          h("h4", {}, h("span", { class: "hb-time" }, cap(whenLabel(Date.parse(hr.t), tz)))),
          h("button", { type: "button", class: "backnow", onclick: showBoxes, "aria-label": "Back to now and peak" }, "Back to now")),
        h("div", { class: "hb-lvl" }, pill(hr.level, true),
          th != null && th > 0 ? h("span", { class: "muted small" }, `Thunder chance ${th}%`) : null),
        reasonsList(hr.reasons, hr.level)));
    };
    showBoxes();

    const secs = [];
    const add = (cond, fn) => { if (cond) secs.push(fn()); };
    add(a.faa && a.faa.length, () => section("Delays & closures", ...a.faa.map((f) => faaItem(f, a))));
    const notices = [...[...(a.atcscc || [])].sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0)).map((x) => advItem(x, tz)), ...planItems(a)];
    add(notices.length, () => section("FAA traffic notices", ...notices));
    const mvCard = window.AWXMovement ? AWXMovement.card(a) : null; // movement hook: "Traffic right now" (site/movement.js)
    if (mvCard) secs.push(mvCard); // movement hook
    add(a.alerts && a.alerts.length, () => section("Weather warnings", ...a.alerts.map((x) => h("div", { class: "item" }, h("b", {}, x.event),
      x.ends ? h("span", { class: "muted" }, " · until " + dayClock(Date.parse(x.ends), tz)) : null,
      x.headline ? h("div", { class: "muted", style: "font-size:13px;margin-top:2px" }, x.headline) : null))));
    add(a.sigmets && a.sigmets.length, () => section("Thunderstorms", h("div", { class: "item" }, plainReason("Convective SIGMET over airport", a) + ", or within 10 nautical miles.")));
    add(a.spc, () => section("Storm outlook",
      a.spc === "TSTM"
        ? h("div", { class: "muted", style: "font-size:15px" }, "General thunderstorms possible in the area (no severe risk)")
        : h("div", { style: "font-size:15px;font-weight:600" }, (SPC_NAMES[a.spc] || a.spc) + " risk of severe storms",
            h("span", { class: "muted", style: "font-weight:400" }, " · today's outlook"))));
    add(a.tcf && a.tcf.length, () => section("Storm forecast", ...a.tcf.map((x) => h("div", { class: "item" },
      h("b", {}, "Thunderstorms, " + ({ high: "widespread", medium: "scattered", low: "isolated" }[x.coverage] || "some") + " coverage"),
      x.valid ? h("span", { class: "muted" }, " · around " + whenLabel(Date.parse(x.valid), tz)) : null,
      x.confidence ? h("div", { class: "muted small" }, "Forecaster confidence " + String(x.confidence).toLowerCase()) : null))));
    const pd = pilotDetails(a);
    if (pd) secs.push(pd);

    sheet.replaceChildren(
      h("div", { class: "grab", "aria-hidden": "true" }),
      h("div", { class: "sh-head" },
        h("div", { class: "sh-code", id: "sheetTitle" }, a.iata),
        h("div", { class: "right", style: "gap:6px" },
          h("button", { type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + a.iata + (fav ? " from" : " to") + " my airports", onclick: () => toggleFav(a.iata) }, starSvg()),
          h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeSheet }, closeSvg()))),
      h("div", { class: "aname sh-aname" }, a.name),
      h("div", { class: "where sh-where" }, `${a.city}, ${a.state}`),
      boxWrap,
      section("Next 24 hours (" + tzAbbr(t0, tz) + ")", timeline(a, true, showHour),
        h("div", { class: "muted small", style: "margin-top:8px" }, "Tap an hour for details. Tap it again to go back.")),
      ...secs,
      checkedLine()
    );
    if (window.AWXTrips) window.AWXTrips.decorateSheet(sheet, a); // trips hook: "Your flight" row + plane markers
    if (keepScroll) {
      sheet.scrollTop = top;
      if (sheetPick != null && a.hours[sheetPick]) showHour(sheetPick, sheet.querySelector(`.tl.big .s[data-i="${sheetPick}"]`));
    } else sheetPick = null;
  }

  // swipe down to close (from the top of the sheet)
  (function wireSwipe() {
    const sheet = $("sheet");
    let d = null;
    sheet.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { d = null; return; }
      d = { y: e.touches[0].clientY, t: Date.now(), dy: 0, on: false, ok: sheet.scrollTop <= 0 };
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (!d || !d.ok) return;
      const dy = e.touches[0].clientY - d.y;
      if (!d.on && dy > 8) { d.on = true; sheet.style.transition = "none"; }
      if (d.on) {
        d.dy = Math.max(0, dy);
        sheet.style.transform = `translateY(${d.dy}px)`;
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    const end = () => {
      if (!d) return;
      const { on, dy, t } = d;
      d = null;
      if (!on) return;
      sheet.style.transition = "";
      const v = dy / Math.max(1, Date.now() - t);
      if (dy > 110 || v > 0.6) closeSheet();
      else sheet.style.transform = "";
    };
    sheet.addEventListener("touchend", end);
    sheet.addEventListener("touchcancel", end);
  })();

  $("backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  $("refresh").addEventListener("click", () => load(true));

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

  window.AWXApp = { state, openSheet, toggleFav, render }; // build2a hook: used by site/searched.js
  window.AWXApp.setFavs = (list) => { state.favs = list.filter((x) => typeof x === "string"); saveFavs(); render(); }; // nav hook: Settings → Your airports (site/settings.js)
  if (!testMode()) liveConfig(); // live relay: read data/config.json on load
  render();
  load(false);
})();
