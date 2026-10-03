(() => {
  "use strict";

  const LEVELS = [
    { name: "None", label: "Clear" },
    { name: "Low", label: "Minor" },
    { name: "Moderate", label: "Moderate" },
    { name: "High", label: "High" },
    { name: "Severe", label: "Severe" },
  ];
  const SOURCE_NAMES = {
    faa: "FAA status", atcscc: "ATCSCC advisories", nws: "NWS alerts", spc: "SPC outlook", metar: "METAR", taf: "TAF",
    sigmet: "SIGMETs", lamp: "LAMP guidance", tcf: "TFM convective forecast", cwa: "Center weather advisories",
  };
  // short names for the sheet's "Checked …" line, and what may be missing when a source fails
  const SOURCE_SHORT = { faa: "FAA", atcscc: "ATCSCC", nws: "NWS", spc: "SPC", metar: "METAR", taf: "TAF", sigmet: "SIGMETs", lamp: "LAMP", tcf: "TCF", cwa: "CWA" };
  const SOURCE_MISSING = {
    faa: "delays may be missing", atcscc: "ground stops may be missing", nws: "warnings may be missing",
    spc: "severe-storm risk may be missing", metar: "current conditions may be missing", taf: "forecast hours may be missing",
    sigmet: "convective SIGMETs may be missing", lamp: "thunder chances may be missing", tcf: "convective forecasts may be missing",
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
  const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));

  // ---------- data ----------

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  let loading = false;
  async function load(manual) {
    if (loading) return;
    loading = true;
    $("refresh").classList.add("spin");
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
      state.data = data;
      state.sample = sample;
      state.fetchError = null;
      state.fetchedAt = Date.now();
    } catch (e) {
      state.fetchError = manual || !state.data ? "Couldn't load data" : "Couldn't refresh";
    } finally {
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
  }

  function renderHeader() {
    const el = $("updated");
    const d = state.data;
    el.classList.remove("stale");
    if (!d) { el.textContent = state.loaded ? "Not updated" : "Loading…"; return; }
    if (state.sample) { el.textContent = "Sample data"; return; }
    const age = Date.now() - Date.parse(d.generated);
    el.textContent = "Updated " + ago(age);
    if (age > STALE_MS) el.classList.add("stale");
  }

  function visibleAirports() {
    const all = (state.data && state.data.airports) || [];
    if (state.filter === "mine") return all.filter((a) => state.favs.includes(a.iata));
    if (state.filter === "risk") return all.filter((a) => a.peak.level >= 2);
    return all;
  }

  function renderSeg() {
    const all = (state.data && state.data.airports) || [];
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
      .map((f) => h("span", { class: "badge " + (cls[f.type] || "l2") }, f.badge || f.type));
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
    const sa = clock(start, tz), sb = clock(end, tz);
    const ma = sa.split(" ").pop(), mb = sb.split(" ").pop();
    const range = ma === mb ? sa.slice(0, sa.lastIndexOf(" ")) + "–" + sb : sa + "–" + sb;
    const w = whenLabel(start, tz);
    const prefix = w.indexOf(" ") > 0 && !/^\d/.test(w) ? w.slice(0, w.indexOf(" ")) + " " : "";
    return prefix + range;
  }
  const uniq = (arr) => [...new Set(arr || [])];

  // ---------- LAMP ----------

  /** LAMP 2-hour thunder probability covering the hour starting at ms (max of the periods). */
  function lampThunderAt(a, ms) {
    let p = null;
    for (const x of (a.lamp && a.lamp.hours) || []) {
      const t = Date.parse(x.t);
      if (x.tstmProb == null || !(t > ms && t <= ms + 2 * HOUR)) continue;
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
      const label = hourLabel(Date.parse(hr.t), tz) + ": " + LEVELS[hr.level].label;
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
    const reason = (later ? a.peak.reasons[0] : a.now.reasons[0]) || (a.peak.level ? "Elevated risk" : "No significant weather");
    const nowDiffers = later;
    const el = h("div", {
      class: "card", role: "button", tabindex: "0", "data-iata": a.iata,
      "aria-label": `${a.iata}, ${a.city}. ${LEVELS[a.peak.level].label} risk. ${reason}`,
      onclick: () => openSheet(a.iata),
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); openSheet(a.iata); } },
    },
      h("div", { class: "top" },
        h("div", { style: "min-width:0" },
          h("div", { class: "code" }, a.iata),
          h("div", { class: "where" }, `${a.city}, ${a.state} · ${a.name}`)),
        h("div", { class: "right" },
          pill(a.peak.level),
          h("button", {
            type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + a.iata + (fav ? " from" : " to") + " my airports",
            onclick: (e) => { e.stopPropagation(); toggleFav(a.iata); },
            onkeydown: (e) => e.stopPropagation(),
          }, starSvg()))),
      h("div", { class: "reason" }, reason),
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

  function faaItem(f) {
    if (f.type === "closure") {
      const info = f.scope === "limited" || f.active === false;
      const cls = f.scope === "runway" ? "l1" : "l4";
      return h("div", { class: "item" + (info ? " info" : "") },
        !info && f.badge ? h("span", { class: "badge " + cls }, f.badge) : null,
        h("div", { class: info ? "muted" : "", style: info ? "" : "margin-top:4px" }, f.plain || [f.reason, f.detail].filter(Boolean).join(" · ")),
        f.reason ? rawToggle(f.reason) : null);
    }
    const why = f.causeLabel ? cap(f.causeLabel) : f.reason ? cap(f.reason) : null;
    return h("div", { class: "item" },
      h("span", { class: "badge " + (FAA_CLS[f.type] || "l2") }, f.badge || f.type),
      h("div", { style: "margin-top:4px" }, [why, f.detail].filter(Boolean).join(" · ")),
      f.reason && f.causeLabel && !f.causeLabel.toLowerCase().includes(f.reason.toLowerCase()) ? h("div", { class: "muted small" }, "FAA: " + f.reason) : null);
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
      h("span", { class: "badge " + cls }, x.type), " ", h("b", {}, name), h("span", { class: "muted" }, " · " + status),
      x.causeLabel || x.causeText ? h("div", { style: "margin-top:4px" }, cap(x.causeLabel || x.causeText)) : null,
      h("div", { class: "muted small" }, [x.title, x.issued ? "issued " + whenLabel(Date.parse(x.issued), tz) : null].filter(Boolean).join(" · ")));
  }

  function lampTable(a) {
    const tz = a.tz;
    const t0 = Date.parse(a.hours[0].t);
    const hrs = (a.lamp.hours || []).filter((x) => { const t = Date.parse(x.t); return t >= t0 && t < t0 + 24 * HOUR; });
    if (!hrs.length) return null;
    const notable = hrs.some((x) => (x.tstmProb || 0) >= 10 || (x.pPrecip || 0) >= 30 || (x.gust || 0) >= 20 || (lampCat(x) && lampCat(x) !== "VFR"));
    if (!notable) return null;
    const short = (ms) => hourLabel(ms, tz).replace(" AM", "a").replace(" PM", "p");
    const cell = (v, cls) => h("td", { class: cls || null }, v == null ? "" : String(v));
    const row = (label, f) => h("tr", {}, h("th", {}, label), hrs.map(f));
    const tcls = (p) => (p == null ? null : p >= 40 ? "l3 hot" : p >= 20 ? "l2 hot" : null);
    const table = h("table", { class: "lt" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), hrs.map((x) => h("th", {}, short(Date.parse(x.t)))))),
      h("tbody", {},
        row("Thunder %", (x) => cell(x.tstmProb, tcls(x.tstmProb))),
        row("Precip %", (x) => cell(x.pPrecip)),
        row("Gust kt", (x) => cell(x.gust ? x.gust : null)),
        row("Category", (x) => { const c = lampCat(x); return h("td", {}, c ? h("span", { class: "fcd " + c, title: c }, c[0]) : ""); })));
    return [h("div", { class: "lamp" }, table), h("div", { class: "muted small", style: "margin:6px 4px 0" }, "Thunder %: chance of thunder in the 2 hours ending at that time.")];
  }

  function checkedLine(a) {
    const d = state.data;
    const src = (d && d.sources) || {};
    const warn = [];
    const ok = [];
    for (const k of Object.keys(SOURCE_NAMES)) {
      const s = src[k];
      if (!s) continue;
      if (!s.ok) { warn.push(`${SOURCE_NAMES[k]} unavailable — ${SOURCE_MISSING[k]}`); continue; }
      ok.push(SOURCE_SHORT[k]);
      if (s.error) warn.push(`${SOURCE_NAMES[k]} partly unavailable — ${SOURCE_MISSING[k]}`);
    }
    const when = state.sample ? "sample data" : d ? ago(Math.max(0, Date.now() - Date.parse(d.generated))) : "";
    return h("div", { class: "checked" },
      warn.map((w) => h("p", { class: "warn" }, w)),
      ok.length ? h("p", { class: "muted" }, `Checked ${ok.join(", ")}${when ? " · " + when : ""}`) : null);
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
    const hourInfo = h("div", { class: "hourinfo muted", "aria-live": "polite" }, "Tap a bar for that hour.");

    const showHour = (i, btn) => {
      sheetPick = i;
      sheet.querySelectorAll(".tl.big .s").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const hr = a.hours[i];
      const th = lampThunderAt(a, Date.parse(hr.t));
      hourInfo.className = "hourinfo";
      hourInfo.replaceChildren(
        h("b", {}, hourLabel(Date.parse(hr.t), tz) + " "), pill(hr.level, true), hr.fltCat ? h("span", { class: "muted" }, " · " + hr.fltCat) : null,
        th != null ? h("span", { class: "muted" }, ` · Thunder ${th}% (LAMP)`) : null,
        h("div", { class: "muted", style: "margin-top:4px" }, hr.reasons.length ? uniq(hr.reasons).join(" · ") : "No significant weather")
      );
    };

    const reasonsList = (arr) => uniq(arr).length
      ? h("ul", { class: "reasons" }, uniq(arr).map((r) => h("li", {}, r)))
      : h("div", { class: "muted", style: "font-size:14px" }, "No significant weather");

    // One box while the level holds; a separate Peak box only when the peak is later and higher.
    const boxes = laterPeak(a)
      ? h("div", { class: "two" },
          h("div", { class: "box" }, h("h4", {}, "Now ", pill(a.now.level, true)), reasonsList(a.now.reasons)),
          h("div", { class: "box" }, h("h4", {}, "Peak " + peakRange(a) + " ", pill(a.peak.level, true)), reasonsList(a.peak.reasons)))
      : h("div", { class: "box one" },
          h("h4", {}, pill(a.now.level, true), h("span", {}, "through " + whenLabel(levelEnd(a), tz))),
          a.now.reasons.length ? reasonsList(a.now.reasons) : null);

    const secs = [];
    const add = (cond, fn) => { if (cond) secs.push(fn()); };
    add(a.faa && a.faa.length, () => section("FAA programs", ...a.faa.map(faaItem)));
    add(a.atcscc && a.atcscc.length, () => section("ATCSCC advisories",
      ...[...a.atcscc].sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0)).map((x) => advItem(x, tz))));
    add(a.alerts && a.alerts.length, () => section("NWS alerts", ...a.alerts.map((x) => h("div", { class: "item" }, h("b", {}, x.event),
      x.ends ? h("span", { class: "muted" }, " · until " + dayClock(Date.parse(x.ends), tz)) : null,
      x.headline ? h("div", { class: "muted", style: "font-size:13px;margin-top:2px" }, x.headline) : null))));
    const lt = a.lamp ? lampTable(a) : null;
    add(lt, () => section("LAMP guidance · issued " + clock(Date.parse(a.lamp.issued), tz), ...lt));
    add(a.spc, () => section("SPC convective outlook",
      a.spc === "TSTM"
        ? h("div", { class: "muted", style: "font-size:15px" }, "General thunderstorms possible in the area (no severe risk)")
        : h("div", { style: "font-size:15px;font-weight:600" }, (SPC_NAMES[a.spc] || a.spc) + " risk of severe storms",
            h("span", { class: "muted", style: "font-weight:400" }, " · SPC Day 1 outlook"))));
    add(a.tcf && a.tcf.length, () => section("TFM convective forecast", ...a.tcf.map((x) => h("div", { class: "item" },
      h("b", {}, cap(x.coverage || x.coverageRaw || "Unknown") + " coverage"),
      x.valid ? h("span", { class: "muted" }, " · valid " + whenLabel(Date.parse(x.valid), tz)) : null,
      h("div", { class: "muted small" }, [x.confidence && "Confidence " + String(x.confidence).toLowerCase(), x.tops && "Tops " + x.tops].filter(Boolean).join(" · "))))));
    add(a.sigmets && a.sigmets.length, () => section("Convective SIGMETs", ...a.sigmets.map((x) => h("div", { class: "item" }, h("b", {}, "Convective SIGMET"), h("pre", { class: "raw", style: "margin-top:6px" }, x.raw)))));
    add(a.cwa && a.cwa.length, () => section("Center weather advisories", ...a.cwa.map((x) => h("div", { class: "item" },
      h("b", {}, x.hazard ? "CWA · " + x.hazard : "CWA"),
      x.validTo ? h("span", { class: "muted" }, " · until " + whenLabel(Date.parse(x.validTo), tz)) : null,
      x.raw ? h("pre", { class: "raw", style: "margin-top:6px" }, x.raw) : null))));
    add(a.metar, () => section("Current METAR",
      h("div", { class: "box" }, h("dl", { class: "kv", style: "margin:0" }, metarRows(a.metar))),
      a.metar.obsTime ? h("div", { class: "muted", style: "font-size:12px;margin:6px 4px 0" }, "Observed " + ago(Math.max(0, refNow() - Date.parse(a.metar.obsTime)))) : null,
      h("pre", { class: "raw", style: "margin-top:10px" }, a.metar.raw)));
    add(a.taf, () => section("TAF" + (a.taf.issued ? " · issued " + clock(Date.parse(a.taf.issued), tz) : ""), h("pre", { class: "raw" }, a.taf.raw)));

    sheet.replaceChildren(
      h("div", { class: "grab", "aria-hidden": "true" }),
      h("div", { class: "sh-head" },
        h("div", { style: "min-width:0" },
          h("div", { class: "sh-code", id: "sheetTitle" }, a.iata),
          h("div", { class: "muted", style: "font-size:14px;margin-top:6px" }, `${a.name} · ${a.city}, ${a.state}`)),
        h("div", { class: "right", style: "gap:6px" },
          h("button", { type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + a.iata + (fav ? " from" : " to") + " my airports", onclick: () => toggleFav(a.iata) }, starSvg()),
          h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeSheet }, closeSvg()))),
      boxes,
      section("Next 24 hours (" + tzAbbr(t0, tz) + ")", timeline(a, true, showHour), hourInfo),
      ...secs,
      checkedLine(a)
    );
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
      renderHeader();
      if (Date.now() - state.fetchedAt > 20e3) load(false);
    }
  });
  setInterval(() => { if (document.visibilityState === "visible") load(false); }, REFRESH_MS);
  setInterval(renderHeader, 30e3);

  window.AWXApp = { state, openSheet, toggleFav, render }; // build2a hook: used by site/searched.js
  render();
  load(false);
})();
