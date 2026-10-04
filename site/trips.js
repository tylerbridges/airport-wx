// Trips on the page (README "Trips"). Loaded as a module after app.js; talks to it only through
// window.AWXApp ({state, openSheet, render}) and is called back by three marked hooks in app.js
// ("// trips hook"): render() -> AWXTrips.render(), renderSheet() -> AWXTrips.decorateSheet(sheet, a),
// liveQuery() -> AWXTrips.liveIds().
//
//   - "Your trips" at the top of the home list (only when there are trips): route, local departure,
//     status pill, the most important concern and a departure-to-arrival mini timeline;
//   - a trip sheet with each leg, every concern, departure vs. arrival impact and links to the airports;
//   - "Your flight" rows and plane markers in the airport sheets;
//   - manual trips (stored only on this device, localStorage "awx-trips"), and the Trips settings sheet
//     (flight calendar status and how to connect it).
// Calendar trips come from data/trips.json (airports and times only); concerns from ./trip-risk.js.
import { tripStatus, flightLine, rolesAt, clockText, whenText, rangeText, LEVEL_LABELS, STATUS } from "./trip-risk.js?v=2";
import { mountSearch, loadAirports, airportsLoaded, placeLine } from "./search.js";

const KEY = "awx-trips";
const HOUR = 3600e3;
const MIN = 60e3;
const CAL_TTL = 60e3;
const T = window.AWXTest || { name: null, rebase: (d) => d };
const app = () => window.AWXApp;

const S = {
  cal: null, // data/trips.json
  calAt: 0,
  calFailed: false,
  loading: null,
  manual: loadManual(),
  view: null, // trip sheet: {kind: "trip", id} | {kind: "edit", id|null} | {kind: "settings"}
  lastFocus: null,
};

// ---------- small helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function svg(d, cls, rot) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  if (rot) s.style.transform = `rotate(${rot}deg)`;
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  s.append(p);
  return s;
}
const PLANE = "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z";
const CLOSE = "M5 5l14 14M19 5L5 19";
const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));
const tidy = (s) => s.replace(/[  ]/g, " ");
function fmt(ms, tz, opts) {
  try { return tidy(new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", ...opts }).format(ms)); } catch { return tidy(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(ms)); }
}
function tzAbbr(ms, tz) {
  let n = "";
  try { n = (new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", timeZoneName: "short" }).formatToParts(ms).find((x) => x.type === "timeZoneName") || {}).value || ""; } catch { n = "UTC"; }
  const map = { EDT: "ET", EST: "ET", CDT: "CT", CST: "CT", MDT: "MT", MST: "MT", PDT: "PT", PST: "PT", AKDT: "AKT", AKST: "AKT" };
  return map[n] || n;
}
/** "Sun, Oct 4 · 6:05 PM CT" in the airport's zone. */
const dateLine = (ms, tz) => `${fmt(ms, tz, { weekday: "short", month: "short", day: "numeric" })} · ${clockText(ms, tz)} ${tzAbbr(ms, tz)}`;
function ago(ms) {
  const m = Math.floor(ms / MIN);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? hrs + " hr" + (m % 60 ? " " + (m % 60) + " min" : "") + " ago" : Math.floor(hrs / 24) + " d ago";
}
const nowMs = () => {
  const st = app() && app().state;
  return st && st.sample && st.data ? Date.parse(st.data.generated) : Date.now();
};

// ---------- data ----------

function loadManual() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((t) => t && Array.isArray(t.legs) && t.legs.length && t.legs.every((l) => /^[A-Z]{3}$/.test(l.from) && /^[A-Z]{3}$/.test(l.to) && Date.parse(l.dep) && Date.parse(l.arr))) : [];
  } catch { return []; }
}
function saveManual() {
  try { localStorage.setItem(KEY, JSON.stringify(S.manual)); } catch { /* storage blocked */ }
}

function appReady() {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => ((app() && app().state.loaded) || Date.now() - t0 > 8000 ? res() : setTimeout(tick, 50));
    tick();
  });
}

function loadCal(force) {
  if (S.loading) return S.loading;
  if (!force && S.calAt && Date.now() - S.calAt < CAL_TTL) return Promise.resolve();
  S.loading = (async () => {
    await appReady(); // test mode: trips.json is shifted by the same amount as the scenario
    const url = T.name ? `./data/scenarios/${T.name}/trips.json` : "./data/trips.json";
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) { const d = await r.json(); S.cal = T.name ? T.rebase(d) : d; S.calFailed = false; }
      else if (r.status === 404) { S.cal = null; S.calFailed = false; }
      else S.calFailed = true;
    } catch { S.calFailed = true; }
    S.calAt = Date.now();
    S.loading = null;
    render();
  })();
  return S.loading;
}

const statusAirports = () => (app() && app().state.data && app().state.data.airports) || [];
const byIata = (code) => statusAirports().find((a) => a.iata === code) || null;
/** Zone for a code: the status data, the trip's own hints (manual trips), the search list. */
function tzFor(code, trip) {
  const a = byIata(code);
  if (a && a.tz) return a.tz;
  if (trip && trip.tz && trip.tz[code]) return trip.tz[code];
  const s = (airportsLoaded() || []).find((x) => x.iata === code);
  return (s && s.tz) || "UTC";
}

/** Calendar + manual trips that haven't landed more than an hour ago, soonest first. */
function allTrips() {
  const now = nowMs();
  const cal = ((S.cal && S.cal.trips) || []).map((t) => ({ ...t, source: "calendar" }));
  const man = S.manual.map((t) => ({ ...t, source: "manual" }));
  return [...cal, ...man]
    .map((t) => ({ ...t, legs: [...t.legs].sort((a, b) => Date.parse(a.dep) - Date.parse(b.dep)) }))
    .filter((t) => Date.parse(t.legs[t.legs.length - 1].arr) > now - HOUR)
    .sort((a, b) => Date.parse(a.legs[0].dep) - Date.parse(b.legs[0].dep));
}
// build2b hook: delay chances in plain, calibrated words (site/delay.js likelihood), never a percentage
const delayWordsFor = (d, iata) => { const L = window.AWXDelay && window.AWXDelay.likelihood ? window.AWXDelay.likelihood(d, { iata }) : null; return L ? L.word : null; };
// Trips use all known disruption categories, including those hidden on the airport list.
// Share the airport outlook's freshness/source checks rather than interpreting green hours as healthy data.
function airportHealth(a) {
  const st = app()?.state, data = st?.data;
  const ns = data?.noticeSources || {};
  const noticesDown = ["notam", "tfr"].some((k) => ns[k] && (!ns[k].ok || ns[k].error || ns[k].stale));
  return window.AWXOutlook?.health ? window.AWXOutlook.health(a, {
    now: nowMs(), generated: data?.generated, sources: data?.sources, sample: st?.sample, noticesDown,
  }) : { quality: "Some data unavailable" };
}
const resultOf = (trip) => tripStatus(trip, byIata, { now: nowMs(), words: delayWordsFor, health: airportHealth });
const findTrip = (id) => allTrips().find((t) => t.id === id) || S.manual.map((t) => ({ ...t, source: "manual" })).find((t) => t.id === id) || null;

// ---------- home: "Your trips" ----------

function routeEl(trip, big) {
  const legs = trip.legs;
  const kids = [h("span", { class: "tc" }, legs[0].from)];
  for (let i = 1; i < legs.length; i++) kids.push(h("span", { class: "ta" }, "→"), h("span", { class: "tv" }, legs[i].from));
  kids.push(h("span", { class: "ta" }, "→"), h("span", { class: "tc" }, legs[legs.length - 1].to));
  return h("div", { class: "troute" + (big ? " big" : "") }, kids);
}
function pillEl(r, small) {
  return h("span", { class: "pill " + r.cls + (small ? " sm" : "") }, r.label);
}

/** Hourly levels of airport code over [a, b): [{ms, level|null}] split at hour boundaries. */
function pieces(code, a, b) {
  const ap = byIata(code);
  const out = [];
  let t = a;
  while (t < b) {
    const next = Math.min(b, (Math.floor(t / HOUR) + 1) * HOUR);
    const hr = ap && ap.hours ? ap.hours.find((x) => { const s = Date.parse(x.t); return t >= s && t < s + HOUR; }) : null;
    // build2b hook: the page's display level (weather/FAA raised by the delay chance), as on the airport timelines
    const A = window.AWXApp;
    let level = hr ? hr.level : null;
    if (hr && A && A.hourLevel) { try { level = A.hourLevel(ap, hr); } catch { /* keep the hour's own level */ } }
    if (ap && airportHealth(ap).quality && level === 0) level = null;
    out.push({ ms: next - t, level });
    t = next;
  }
  return out;
}

/** Departure-to-arrival mini timeline: an hour at the origin, each flight, the connections, an hour at the destination. */
function miniTimeline(trip) {
  const legs = trip.legs.map((l) => ({ ...l, d: Date.parse(l.dep), a: Date.parse(l.arr) }));
  const start = legs[0].d - HOUR;
  const end = legs[legs.length - 1].a + HOUR;
  const total = end - start;
  const segs = [];
  const ground = (code, a, b) => { for (const p of pieces(code, a, b)) segs.push(h("span", { class: "s " + (p.level == null ? "nd" : lv(p.level)), style: `flex-grow:${p.ms}` })); };
  ground(legs[0].from, start, legs[0].d);
  legs.forEach((l, i) => {
    segs.push(h("span", { class: "s air", style: `flex-grow:${l.a - l.d}` }, svg(PLANE, "tpl", 90)));
    const next = legs[i + 1];
    if (next) ground(l.to, l.a, Math.max(l.a, next.d));
  });
  ground(legs[legs.length - 1].to, legs[legs.length - 1].a, end);
  const pos = (ms) => `${(((ms - start) / total) * 100).toFixed(2)}%`;
  const first = legs[0], last = legs[legs.length - 1];
  const labels = [
    h("span", { style: "left:0" }, h("b", {}, first.from), clockText(first.d, tzFor(first.from, trip))),
    h("span", { style: "right:0;text-align:right" }, h("b", {}, last.to), clockText(last.a, tzFor(last.to, trip))),
  ];
  for (let i = 0; i < legs.length - 1; i++) {
    const mid = (legs[i].a + legs[i + 1].d) / 2;
    labels.push(h("span", { class: "mid", style: `left:${pos(mid)}` }, h("b", {}, legs[i].to), Math.round((legs[i + 1].d - legs[i].a) / MIN) + " min"));
  }
  const label = `From ${first.from} at ${clockText(first.d, tzFor(first.from, trip))} to ${last.to} at ${clockText(last.a, tzFor(last.to, trip))}`;
  return h("div", { class: "tmini" }, h("div", { class: "tbar", role: "img", "aria-label": label }, segs), h("div", { class: "tlabels", "aria-hidden": "true" }, labels));
}

function tripCard(trip) {
  const r = resultOf(trip);
  const first = trip.legs[0], last = trip.legs[trip.legs.length - 1];
  const tz = tzFor(first.from, trip);
  const open = () => openTrip(trip.id);
  const el = h("div", {
    class: "card tcard", role: "button", tabindex: "0", "data-trip": trip.id,
    "aria-label": `Trip ${first.from} to ${last.to}, ${dateLine(Date.parse(first.dep), tz)}. ${r.label}. ${r.top}`,
    onclick: open,
    onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); open(); } },
  },
    routeEl(trip),
    h("div", { class: "tmeta" }, pillEl(r), h("span", { class: "tw" }, dateLine(Date.parse(first.dep), tz))),
    h("div", { class: "reason" }, r.top),
    r.quality && r.concerns.some((c) => c.level > 0) ? h("div", { class: "muted small" }, r.quality) : null,
    miniTimeline(trip));
  return el;
}

let tabBox = null; // the nav shell's Trips tab (site/nav.js calls render(container))
function render(container) {
  if (container && container.nodeType) tabBox = container;
  loadCal(false);
  if (tabBox) renderTab(tabBox);
  const box = document.getElementById("trips");
  if (!box) { refreshOpen(); return; }
  const trips = allTrips();
  if (!trips.length) { box.replaceChildren(); renderFoot(); refreshOpen(); document.dispatchEvent(new CustomEvent("awx:trips")); const a = statusAirports().find((a) => a.iata === app()?.state.openIata); if (a) decorateSheet(document.getElementById("sheet"), a); return; }
  box.replaceChildren(
    h("div", { class: "trips-h" },
      h("h2", {}, "Your trips"),
      h("div", { class: "trips-b" },
        h("button", { type: "button", class: "tadd", onclick: () => openEdit(null) }, "Add a trip"),
        h("button", { type: "button", class: "tgear", "aria-label": "Trips settings", onclick: () => openTripSettings() }, svg("M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z", "gear")))),
    h("div", { class: "tlist" }, trips.map(tripCard)));
  renderFoot();
  refreshOpen();
  document.dispatchEvent(new CustomEvent("awx:trips"));
  const sheet = document.getElementById("sheet");
  const airport = statusAirports().find((a) => a.iata === app()?.state.openIata);
  if (airport) decorateSheet(sheet, airport);
}

/** The Trips tab: every trip, "Add a trip", and the calendar line; an empty state when there are none. */
function renderTab(box) {
  const trips = allTrips();
  const cs = calStatus();
  if (!trips.length) {
    box.replaceChildren(h("div", { class: "awx-empty ttab-empty" },
      h("div", { class: "awx-empty-ico" }, svg(PLANE, "tempty", 45)),
      h("h2", {}, "No trips yet"),
      h("p", {}, cs.connected ? "Your flight calendar is connected but has no flights in the next 7 days. Add a flight to watch for disruptions at both ends."
        : "Add a flight to watch for disruptions at both ends, or connect your flight calendar to bring trips in automatically."),
      h("button", { type: "button", class: "awx-btn primary", onclick: () => openEdit(null) }, "Add a trip"),
      cs.connected ? null : h("button", { type: "button", class: "awx-btn", onclick: () => openTripSettings("connect") }, "Connect your flight calendar")));
    return;
  }
  box.replaceChildren(
    h("div", { class: "trips-h ttab-h" },
      h("span", { class: "tcal-line" + (cs.warn ? " warn" : "") }, cs.connected ? "From your flight calendar" + calAgo() : cs.warn ? cs.text : "Flight calendar not connected"),
      h("div", { class: "trips-b" },
        h("button", { type: "button", class: "tadd", onclick: () => openEdit(null) }, "Add a trip"),
        h("button", { type: "button", class: "tgear", "aria-label": "Trips settings", onclick: () => openTripSettings() }, svg("M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z", "gear")))),
    h("div", { class: "tlist" }, trips.map(tripCard)));
}
const calAgo = () => { const g = S.cal && Date.parse(S.cal.generated); return g ? " · updated " + ago(Math.max(0, nowMs() - g)) : ""; };

/** Settings → Trips & flight calendar (site/settings.js through the nav shell), else this file's own Trips sheet. */
function openTripSettings(focus) {
  if (window.AWXNav && typeof window.AWXNav.openSettings === "function") {
    if (S.view) closeTrip();
    window.AWXNav.openSettings("trips", focus ? { focus } : undefined);
    return;
  }
  openSettings();
}

/** "Trips" link at the bottom of the page when there is no nav shell (opens the Trips sheet even without trips). */
function renderFoot() {
  const foot = document.querySelector(".xfoot");
  if (!foot || foot.querySelector(".tfoot") || document.body.classList.contains("awx-nav-on")) return;
  foot.prepend(h("button", { type: "button", class: "tfoot", onclick: () => openTripSettings() }, "Trips"), " · ");
}

// ---------- airport sheet: "Your flight" + plane markers ----------

// terminals hook: TODO (future) when a leg departs from an airport with terminal data, show its gate's concourse and the nearest lounge (AWXTerminals.gateInfo in site/terminals.js). Nothing yet.
function decorateSheet(sheet, a) {
  if (!sheet || !a) return;
  sheet.querySelectorAll(".tflight, .tplane").forEach((x) => x.remove());
  const now = nowMs();
  const rows = [];
  const marks = [];
  for (const trip of allTrips()) {
    const roles = rolesAt(trip, a.iata);
    if (!roles.length) continue;
    const r = resultOf(trip);
    for (const line of flightLine(trip, r, a.iata, a.tz, now)) {
      if (line.at < now - HOUR && (line.role !== "conn" || line.until < now)) continue;
      const sm = app()?.summary?.(a); // the card's level window (site/outlook.js summary)
      const overlaps = !!sm && sm.level >= 2 && window.AWXOutlook?.overlaps({ start: sm.start, end: sm.end }, line.at, line.until);
      const inRange = a.hours?.some((hr) => Date.parse(hr.t) <= line.at && line.at < Date.parse(hr.t) + HOUR);
      const context = overlaps ? (line.role === "dep" ? "Your departure overlaps the highest-risk window here." : line.role === "arr" ? "Your arrival overlaps the highest-risk window here." : "Your connection overlaps the highest-risk window here.")
        : !inRange ? "Airport forecast not available for your travel time yet." : null;
      rows.push(h("button", { type: "button", class: "tfrow " + r.cls, "aria-label": `Your flight. ${line.text}. Open the trip`, onclick: () => openTrip(trip.id) },
        h("span", { class: "tfic" }, svg(PLANE, "tfi", line.role === "arr" ? 135 : line.role === "conn" ? 90 : 45)),
        h("span", { class: "tft" }, h("span", { class: "tfl" }, "Your flight"), line.text, context ? h("span", { class: "tfcontext" }, context) : null)));
      marks.push({ at: line.at, what: line.role === "dep" ? "departure" : line.role === "arr" ? "arrival" : "connection" });
    }
  }
  if (!rows.length) return;
  const box = h("div", { class: "tflight" }, rows);
  // build2b hook: under the timeline (above it only the header, the Now/Peak card and the timeline)
  const anchor = sheet.querySelector(".tlsec") || sheet.querySelector(".sh-where") || sheet.querySelector(".sh-head");
  if (anchor) anchor.after(box); else sheet.prepend(box);
  const tl = sheet.querySelector(".tl.big");
  if (tl && a.hours && a.hours.length) {
    // build2b hook: use the displayed timeline range (data-start on .tl-wrap, one segment per hour)
    const tw = tl.closest(".tl-wrap");
    const segs = tl.querySelectorAll(".s").length;
    const t0 = tw && tw.dataset.start ? Number(tw.dataset.start) : Date.parse(a.hours[0].t);
    const span = (tw && tw.dataset.start && segs ? segs : a.hours.length) * HOUR;
    for (const m of marks) {
      const f = (m.at - t0) / span;
      if (!(f >= 0 && f <= 1)) continue;
      tl.append(h("span", { class: "tplane", style: `left:${(f * 100).toFixed(2)}%`, title: `Your ${m.what} ${clockText(m.at, a.tz)}`, "aria-label": `Your ${m.what} at ${clockText(m.at, a.tz)}` }, svg(PLANE, null, 90)));
      tl.classList.add("tplaned");
    }
  }
}

/** Trip airports (curated ones) for the live relay call, soonest trip first. */
function liveIds() {
  const out = [];
  for (const t of allTrips()) for (const l of t.legs) for (const c of [l.from, l.to]) {
    const a = byIata(c);
    if (a && !a.trip && !out.includes(c)) out.push(c);
  }
  return out;
}

// ---------- trip sheet (own sheet, above the airport sheet) ----------

function wrap() {
  let w = document.getElementById("tripWrap");
  if (!w) {
    w = h("div", { class: "sheet-wrap twrap", id: "tripWrap", hidden: true },
      h("div", { class: "backdrop", onclick: closeTrip }),
      h("div", { class: "sheet", id: "tripSheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "tripTitle" }));
    document.body.append(w);
    // build2b hook: drag the header / pull at the top to close, back gesture, scroll lock (site/sheet.js)
    tripCtl = window.AWXSheet ? window.AWXSheet.makeSheet(w.querySelector(".sheet"), { onClose: closeTrip, header: ".grab, .sh-head", backdrop: w.querySelector(".backdrop"), noPull: "input, textarea, select" }) : null;
  }
  return w;
}
let tripCtl = null;
function show() {
  const w = wrap();
  if (w.hidden) {
    S.lastFocus = document.activeElement;
    w.hidden = false;
    document.documentElement.classList.add("lock");
    if (tripCtl) tripCtl.opened(); // build2b hook
    void w.offsetHeight;
    w.classList.add("open");
  }
  const c = w.querySelector(".close");
  if (c) c.focus({ preventScroll: true });
}
function closeTrip() {
  const w = document.getElementById("tripWrap");
  if (!w || w.hidden) return;
  S.view = null;
  w.classList.remove("open");
  if (!(app() && app().state.openIata)) document.documentElement.classList.remove("lock");
  if (tripCtl) tripCtl.closed(); // build2b hook
  const done = () => { if (!S.view) w.hidden = true; };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 300);
  if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus({ preventScroll: true });
}
const head = (title, ...right) => h("div", { class: "sh-head" },
  title,
  h("div", { class: "right", style: "gap:6px" }, ...right, h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeTrip }, svg(CLOSE, "x"))));
const sec = (title, ...kids) => h("div", { class: "sec" }, h("h3", {}, title), ...kids);

function openTrip(id) { S.view = { kind: "trip", id }; drawView(); show(); }
function openEdit(id) { S.view = { kind: "edit", id }; drawView(); show(); }
function openSettings() { S.view = { kind: "settings" }; drawView(); show(); }
/** Redraw an open trip sheet when the data refreshes (not the editor: it would lose the typing). */
function refreshOpen() { if (S.view && S.view.kind !== "edit") drawView(true); }

function drawView(keep) {
  const sheet = wrap().querySelector(".sheet");
  const top = sheet.scrollTop;
  let kids;
  if (!S.view) return;
  if (S.view.kind === "trip") {
    const trip = findTrip(S.view.id);
    if (!trip) { closeTrip(); return; }
    kids = tripView(trip);
  } else if (S.view.kind === "edit") kids = editView(S.view.id);
  else kids = settingsView();
  sheet.replaceChildren(h("div", { class: "grab", "aria-hidden": "true" }), ...kids);
  if (keep) sheet.scrollTop = top; else sheet.scrollTop = 0;
}

function sourceLine(trip) {
  if (trip.source === "manual") return "Added by you · saved on this device only";
  return "From your flight calendar" + calAgo();
}

function levelBox(title, sub, at, note) {
  return h("div", { class: "box" },
    h("h4", {}, title, at ? h("span", { class: "pill sm " + (at.level == null ? "off" : lv(at.level)) }, at.level == null ? "Unknown" : LEVEL_LABELS[at.level]) : null),
    h("div", { class: "muted small" }, sub),
    h("div", { class: "tbx" }, note || (at ? (at.level == null ? at.quality : at.reason || (at.level ? "Minor weather conditions" : "No significant weather")) : byIata(title.split(" ").pop()) ? "Forecast not out yet" : "No data for this airport yet")),
    at?.quality && at.level != null ? h("div", { class: "muted small" }, at.quality) : null,
    at && at.level != null && at.delay && at.delay.p != null ? h("div", { class: "muted small" }, delayWordsFor(at.delay, title.split(" ").pop()) || "") : null); // build2b hook: words, not %
}

function tripView(trip) {
  const r = resultOf(trip);
  const first = trip.legs[0], last = trip.legs[trip.legs.length - 1];
  const tzF = tzFor(first.from, trip);
  const legsEls = r.legs.map((l) => {
    const tf = tzFor(l.from, trip), tt = tzFor(l.to, trip);
    return h("div", { class: "tleg" },
      h("div", { class: "tleg-h" }, h("b", {}, `${l.from} → ${l.to}`),
        h("span", { class: "muted" }, ` ${clockText(l.dep, tf)} ${tzAbbr(l.dep, tf)} → ${clockText(l.arr, tt)} ${tzAbbr(l.arr, tt)}`)),
      h("div", { class: "two" },
        levelBox(`Departure ${l.from}`, whenText(l.dep, tf, nowMs()), l.departed ? null : l.depAt, l.departed ? "Departed" : null),
        levelBox(`Arrival ${l.to}`, whenText(l.arr, tt, nowMs()), l.landed ? null : l.arrAt, l.landed ? "Landed" : null)),
      l.conn ? h("div", { class: "tconn" + (l.conn.tight ? " tight" : "") },
        `Connection at ${l.conn.iata} · ${l.conn.minutes} min`, l.conn.tight ? h("span", { class: "badge l2" }, "Tight") : null) : null,
    );
  });
  const sideBox = (title, level, side) => {
    const c = r.concerns.find((x) => x.side === side && x.level >= 1);
    return h("div", { class: "box" }, h("h4", {}, title, h("span", { class: "pill sm " + (level == null ? "off" : lv(level)) }, level == null ? "Unknown" : LEVEL_LABELS[level])),
      h("div", { class: "tbx" }, c ? c.text : level == null ? r.quality || "Data incomplete" : "No issues expected"));
  };
  const items = r.concerns.length
    ? r.concerns.map((c) => h("div", { class: "item" + (c.level ? "" : " info") },
      c.level ? h("span", { class: "badge " + lv(c.level) }, LEVEL_LABELS[c.level]) : null,
      h("div", { class: c.level ? "" : "muted", style: c.level ? "margin-top:4px" : "" }, c.text)))
    : [h("div", { class: "muted", style: "font-size:14px" }, r.quality || r.status === "early" ? r.top : "Nothing expected right now. We check FAA programs and the weather at every airport on your trip.")];
  const codes = [...new Set(trip.legs.flatMap((l) => [l.from, l.to]))];
  const manual = trip.source === "manual";
  let delArmed = false;
  return [
    head(h("div", { id: "tripTitle" }, routeEl(trip, true))),
    h("div", { class: "where sh-where" }, dateLine(Date.parse(first.dep), tzF)),
    h("div", { class: "box tstat" }, pillEl(r), h("div", { class: "tbx", style: "margin-top:8px;font-weight:600" }, r.top), r.quality && r.concerns.some((c) => c.level > 0) ? h("div", { class: "muted small" }, r.quality) : null),
    sec(trip.legs.length > 1 ? "Flights" : "Flight", ...legsEls),
    sec("Departure vs. arrival", h("div", { class: "two" },
      sideBox(`At departure · ${first.from}`, r.sides.dep, "dep"),
      sideBox(`At arrival · ${last.to}`, r.sides.arr, "arr")),
      trip.legs.length > 1 ? h("div", { style: "margin-top:10px" }, sideBox("Connection", r.sides.conn, "conn")) : null,
      h("div", { class: "muted small", style: "margin-top:8px" }, "A ground delay or ground stop at your destination holds you at the departure airport, so it shows under departure.")),
    sec("What could affect this trip", ...items),
    sec("Airports", h("div", { class: "tapts" }, codes.map((c) => h("button", {
      type: "button", class: "tapt", onclick: () => openAirport(c),
    }, h("b", {}, c), h("span", { class: "muted small" }, (byIata(c) && byIata(c).city) || ""))))),
    h("div", { class: "checked" },
      h("p", { class: "muted" }, sourceLine(trip)),
      !manual && S.cal && S.cal.ok === false ? h("p", { class: "warn" }, "Your flight calendar couldn't be read on the last update — times may be out of date.") : null,
      manual ? h("div", { class: "tbtns" },
        h("button", { type: "button", class: "tbtn", onclick: () => openEdit(trip.id) }, "Edit"),
        h("button", { type: "button", class: "tbtn danger", onclick: (e) => {
          if (!delArmed) { delArmed = true; e.currentTarget.textContent = "Tap again to delete"; return; }
          S.manual = S.manual.filter((t) => t.id !== trip.id);
          saveManual();
          closeTrip();
          render();
        } }, "Delete")) : null),
  ];
}

async function openAirport(code) {
  const a = byIata(code);
  closeTrip();
  if (a) { app().openSheet(code); return; }
  let list = airportsLoaded();
  if (!list) { try { list = await loadAirports(); } catch { list = []; } }
  const x = (list || []).find((y) => y.iata === code);
  if (x && window.AWXExtra) window.AWXExtra.pick(x);
}

// ---------- manual trips: editor ----------

function zonedToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  const off = (ms) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(ms)) p[x.type] = Number(x.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(ms / 60e3) * 60e3;
  };
  let t = wall - off(wall);
  const t2 = wall - off(t);
  return t2 !== t ? Math.min(t, t2) : t;
}
const localDate = (ms, tz) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
};
const localTime = (ms, tz) => fmt(ms, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The first time after `after` that reads hh:mm in tz. */
function nextAt(after, timeStr, tz) {
  let t = zonedToUtc(localDate(after, tz), timeStr, tz);
  for (let i = 0; i < 3 && t <= after; i++) t = zonedToUtc(localDate(t + 24 * HOUR, tz), timeStr, tz);
  return t;
}

/** Airport picker: the shared search component, or the chosen airport with "Change". */
function picker(label, value, onChange, optional) {
  const box = h("div", { class: "tpick" });
  const draw = () => {
    box.replaceChildren();
    if (value) {
      box.append(h("div", { class: "tchip" }, h("b", {}, value.iata), h("span", {}, value.place || ""),
        h("button", { type: "button", class: "tchg", onclick: () => { value = null; onChange(null); draw(); setTimeout(() => { const i = box.querySelector("input"); if (i) i.focus(); }, 0); } }, optional ? "Remove" : "Change")));
    } else {
      mountSearch(box, {
        onPick: (a) => {
          if (!/^[A-Z]{3}$/.test(a.iata || "")) { box.dataset.err = "1"; const e = box.parentNode && box.parentNode.querySelector(".terr"); if (e) e.textContent = `${a.code} has no 3-letter airline code; pick an airport with airline service.`; return; }
          value = { iata: a.iata, tz: a.tz || "UTC", place: placeLine(a) || a.name };
          onChange(value);
          draw();
        },
      });
    }
  };
  draw();
  return h("div", { class: "tfield" }, h("div", { class: "tlabel" }, label), box);
}

function editView(id) {
  const ex = id ? S.manual.find((t) => t.id === id) : null;
  const place = (c) => { const a = byIata(c); return a ? `${a.city}${a.state ? ", " + a.state : ""}` : ""; };
  const ap = (c) => (c ? { iata: c, tz: (ex && ex.tz && ex.tz[c]) || tzFor(c, ex), place: place(c) } : null);
  const legs = ex ? ex.legs : [];
  const f = {
    from: ex ? ap(legs[0].from) : null,
    to: ex ? ap(legs[legs.length - 1].to) : null,
    via: ex && legs.length > 1 ? ap(legs[0].to) : null,
  };
  const tzOf = (x) => (x ? x.tz : "UTC");
  const val = (ms, tz, kind) => (ms ? (kind === "d" ? localDate(ms, tz) : localTime(ms, tz)) : "");
  const dep0 = ex ? Date.parse(legs[0].dep) : null;
  const inp = (type, value, label) => h("label", { class: "tfield" }, h("div", { class: "tlabel" }, label), h("input", { type, value: value || "", class: "tin" }));
  const date = inp("date", ex ? val(dep0, tzOf(f.from), "d") : localDate(Date.now() + 24 * HOUR, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), "Date (at departure)");
  const dep = inp("time", ex ? val(dep0, tzOf(f.from), "t") : "", "Departure time (local)");
  const arr = inp("time", ex ? val(Date.parse(legs[legs.length - 1].arr), tzOf(f.to), "t") : "", "Arrival time (local)");
  const viaArr = inp("time", ex && legs.length > 1 ? val(Date.parse(legs[0].arr), tzOf(f.via), "t") : "", "Lands at the connection (local)");
  const viaDep = inp("time", ex && legs.length > 1 ? val(Date.parse(legs[1].dep), tzOf(f.via), "t") : "", "Leaves the connection (local)");
  const viaTimes = h("div", { class: "two tvia" }, viaArr, viaDep);
  viaTimes.hidden = !f.via;
  const err = h("div", { class: "terr", role: "alert" });
  const v = (el) => el.querySelector("input").value;
  const save = () => {
    err.textContent = "";
    if (!f.from || !f.to) { err.textContent = "Pick where you're flying from and to."; return; }
    if (f.from.iata === f.to.iata) { err.textContent = "From and to are the same airport."; return; }
    if (!v(date) || !v(dep) || !v(arr)) { err.textContent = "Add the date, departure time and arrival time."; return; }
    const d0 = zonedToUtc(v(date), v(dep), f.from.tz);
    if (!Number.isFinite(d0)) { err.textContent = "That date or time isn't valid."; return; }
    let newLegs;
    if (f.via) {
      if (!v(viaArr) || !v(viaDep)) { err.textContent = "Add when you land at and leave the connection."; return; }
      const a1 = nextAt(d0, v(viaArr), f.via.tz);
      const d1 = nextAt(a1, v(viaDep), f.via.tz);
      const a2 = nextAt(d1, v(arr), f.to.tz);
      newLegs = [{ from: f.from.iata, to: f.via.iata, dep: d0, arr: a1 }, { from: f.via.iata, to: f.to.iata, dep: d1, arr: a2 }];
    } else newLegs = [{ from: f.from.iata, to: f.to.iata, dep: d0, arr: nextAt(d0, v(arr), f.to.tz) }];
    if (newLegs[newLegs.length - 1].arr - d0 > 40 * HOUR) { err.textContent = "That trip would take over 40 hours — check the times."; return; }
    const trip = {
      id: ex ? ex.id : "m" + Math.random().toString(16).slice(2, 10) + Date.now().toString(16),
      legs: newLegs.map((l) => ({ from: l.from, to: l.to, dep: new Date(l.dep).toISOString(), arr: new Date(l.arr).toISOString() })),
      tz: Object.fromEntries([f.from, f.via, f.to].filter(Boolean).map((x) => [x.iata, x.tz])),
    };
    S.manual = ex ? S.manual.map((t) => (t.id === ex.id ? trip : t)) : [...S.manual, trip];
    saveManual();
    render();
    openTrip(trip.id);
  };
  let delArmed = false;
  return [
    head(h("h2", { id: "tripTitle", class: "th2" }, ex ? "Edit trip" : "Add a trip")),
    h("div", { class: "muted small", style: "margin:0 0 12px" }, "Saved on this device only. Times are local at each airport."),
    h("form", { class: "tform", novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      picker("From", f.from, (x) => { f.from = x; }),
      picker("To", f.to, (x) => { f.to = x; }),
      picker("Connection (optional)", f.via, (x) => { f.via = x; viaTimes.hidden = !x; }, true),
      date,
      h("div", { class: "two" }, dep, arr),
      viaTimes,
      err,
      h("div", { class: "tbtns" },
        h("button", { type: "submit", class: "tbtn primary" }, "Save trip"),
        h("button", { type: "button", class: "tbtn", onclick: () => (ex ? openTrip(ex.id) : closeTrip()) }, "Cancel"),
        ex ? h("button", { type: "button", class: "tbtn danger", onclick: (e) => {
          if (!delArmed) { delArmed = true; e.currentTarget.textContent = "Tap again to delete"; return; }
          S.manual = S.manual.filter((t) => t.id !== ex.id);
          saveManual();
          closeTrip();
          render();
        } }, "Delete") : null)),
  ];
}

// ---------- settings ----------

/** Flight calendar status: {connected, ok, warn, text} ("Connected · 3 upcoming flights" / "Not connected"). */
function calStatus() {
  const c = S.cal;
  if (S.calFailed && !c) return { connected: false, ok: false, warn: true, text: "Couldn't check — trip data didn't load" };
  if (!c || !c.configured) return { connected: false, ok: false, text: "Not connected" };
  if (c.ok === false) return { connected: true, ok: false, warn: true, text: "Connected · couldn't read it on the last update" + (c.error ? ` (${c.error})` : "") };
  const now = nowMs();
  const n = (c.trips || []).reduce((k, t) => k + t.legs.filter((l) => Date.parse(l.arr) > now).length, 0);
  return { connected: true, ok: true, text: `Connected · ${n} upcoming flight${n === 1 ? "" : "s"}` };
}

function settingsView() {
  const st = calStatus();
  const g = S.cal && Date.parse(S.cal.generated);
  const man = S.manual.map((t) => ({ ...t, source: "manual" })).sort((a, b) => Date.parse(a.legs[0].dep) - Date.parse(b.legs[0].dep));
  return [
    head(h("h2", { id: "tripTitle", class: "th2" }, "Trips")),
    sec("Flight calendar",
      h("div", { class: "box" },
        h("div", { class: "tcal" + (st.ok ? " ok" : st.warn ? " warn" : "") }, st.text),
        g && S.cal.configured ? h("div", { class: "muted small" }, "Checked " + ago(Math.max(0, nowMs() - g))) : null),
      h("details", { class: "thelp", open: !st.ok || null },
        h("summary", {}, "How to connect your flight calendar"),
        h("ol", {},
          h("li", {}, "If you use Flighty, turn on its calendar sync to a dedicated calendar."),
          h("li", {}, "In the Calendar app, share that calendar as a public calendar."),
          h("li", {}, "Copy the link."),
          h("li", {}, "Add it as the FLIGHTY_ICS_URL secret on GitHub (repository Settings → Secrets and variables → Actions).")),
        h("p", { class: "muted small" }, "Only airports and flight times are published with this site. Flight numbers, names, confirmation codes, seats and notes are never shown or stored here."))),
    sec("Added on this device",
      man.length ? man.map((t) => h("div", { class: "item tman" },
        h("div", {}, h("b", {}, t.legs.map((l) => l.from).concat(t.legs[t.legs.length - 1].to).join(" → ")),
          h("div", { class: "muted small" }, dateLine(Date.parse(t.legs[0].dep), tzFor(t.legs[0].from, t)))),
        h("div", { class: "tbtns" },
          h("button", { type: "button", class: "tbtn", onclick: () => openTrip(t.id) }, "Open"),
          h("button", { type: "button", class: "tbtn", onclick: () => openEdit(t.id) }, "Edit"))))
        : h("div", { class: "muted", style: "font-size:14px" }, "No trips added on this device."),
      h("div", { class: "tbtns", style: "margin-top:12px" }, h("button", { type: "button", class: "tbtn primary", onclick: () => openEdit(null) }, "Add a trip"))),
  ];
}

// ---------- styles ----------

const CSS = `
#trips{margin-bottom:14px}
#trips:empty{display:none}
.trips-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 8px}
.trips-h h2{margin:0;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.trips-b{display:flex;align-items:center;gap:6px}
.tadd{white-space:nowrap;flex:none;min-height:36px;padding:0 14px;border-radius:999px;background:var(--card);font-size:14px;font-weight:600;color:var(--l1)}
.tgear{width:36px;height:36px;border-radius:50%;background:var(--card);display:grid;place-items:center;color:var(--muted)}
.tgear svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
.tlist{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.troute{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:2px}
.troute .tc{font-size:40px;line-height:.95;font-weight:800;letter-spacing:-.035em}
.troute.big{flex-wrap:nowrap}
.troute.big .tc{font-size:44px}
.tcard .reason{font-size:15px}
.troute .ta{font-size:22px;font-weight:600;color:var(--muted)}
.troute .tv{font-size:16px;font-weight:800;color:var(--muted);letter-spacing:.02em}
.tmeta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-top:12px}
.tmeta .tw{font-size:14px;color:var(--muted)}
.pill.off{--c:var(--muted)}
.tmini{margin-top:14px}
.tbar{display:flex;gap:2px;height:12px;align-items:center}
.tbar .s{height:12px;border-radius:3px;background:var(--c);min-width:2px;flex-basis:0}
.tbar .s.l0{opacity:.4}
.tbar .s.nd{background:var(--line)}
.tbar .s.air{background:none;height:12px;position:relative;display:flex;align-items:center;justify-content:center}
.tbar .s.air::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:2px dotted var(--muted);opacity:.7}
.tbar .tpl{position:relative;width:14px;height:14px;fill:var(--text);background:var(--card);border-radius:50%}
.tlabels{position:relative;height:32px;margin-top:6px;font-size:11.5px;color:var(--muted)}
.tlabels span{position:absolute;top:0;white-space:nowrap;line-height:1.25}
.tlabels span.mid{transform:translateX(-50%);text-align:center}
.tlabels b{display:block;color:var(--text);font-size:12.5px;font-weight:700}
.twrap{z-index:11}
.th2{margin:0;font-size:28px;font-weight:800;letter-spacing:-.02em}
.tstat .tbx{font-size:15px}
.tbx{font-size:14px;margin-top:4px}
.tleg+.tleg{margin-top:16px}
.tleg-h{font-size:15px;margin:0 2px 8px}
.tleg .box h4{margin:0 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:700;color:var(--muted)}
.tconn{margin-top:8px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.tapts{display:flex;flex-wrap:wrap;gap:8px}
.tapt{display:flex;flex-direction:column;align-items:flex-start;min-width:88px;min-height:44px;padding:8px 14px;border-radius:14px;background:var(--card-2);text-align:left}
.tapt b{font-size:20px;font-weight:800;letter-spacing:-.02em}
.tbtns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.tbtn{min-height:44px;padding:0 16px;border-radius:12px;background:var(--card-2);font-weight:600;font-size:15px}
.tbtn.primary{background:var(--l1);color:#000}
.tbtn.danger{color:var(--crit)}
.tflight{display:grid;gap:8px;margin:0 0 14px}
.tfrow{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--card-2);border-radius:16px;padding:10px 12px;min-height:44px}
.tfrow.off{--c:var(--muted)}
.tfrow .tfic{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--c) 20%,transparent)}
.tfrow .tfi{width:20px;height:20px;fill:var(--c)}
.tfrow .tft{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:1.3}
.tfrow .tfl{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tl.tplaned{margin-top:24px}
.tl .tplane{position:absolute;top:-20px;width:16px;height:16px;margin-left:-8px;pointer-events:none;z-index:1}
.tl .tplane svg{width:16px;height:16px;fill:var(--text)}
.tform{display:grid;gap:12px}
.tfield{display:block}
.tlabel{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 2px 6px}
.tin{width:100%;font:inherit;font-size:17px;color:var(--text);background:var(--card-2);border:0;border-radius:12px;padding:10px 12px;min-height:44px;-webkit-appearance:none;appearance:none;color-scheme:inherit}
.tpick .awx-s{margin:0}
.tpick .awx-s input{background:var(--card-2)}
.tchip{display:flex;align-items:center;gap:10px;background:var(--card-2);border-radius:12px;padding:6px 6px 6px 12px;min-height:44px}
.tchip b{font-size:22px;font-weight:800;letter-spacing:-.02em}
.tchip span{flex:1;min-width:0;font-size:14px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tchg{min-height:36px;padding:0 12px;border-radius:10px;font-size:14px;font-weight:600;color:var(--l1)}
.tvia[hidden]{display:none}
.terr{color:var(--crit);font-size:14px;font-weight:600;min-height:0}
.terr:empty{display:none}
.tcal{font-size:16px;font-weight:700}
.tcal.ok{color:var(--l0)}
.tcal.warn{color:var(--l2)}
.thelp{margin-top:10px;font-size:14px}
.thelp summary{cursor:pointer;font-weight:600;color:var(--l1);padding:8px 0;min-height:44px;display:flex;align-items:center}
.thelp ol{margin:4px 0 8px;padding-left:22px}
.thelp li{margin:4px 0}
.tman{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tman .tbtns{margin-top:0;flex:none}
.tfoot{color:var(--muted);font-size:13px;text-decoration:underline;padding:0}
.ttab-h{margin-top:4px}
.tcal-line{font-size:13px;color:var(--muted);min-width:0}
.tcal-line.warn{color:var(--l2);font-weight:600}
.ttab-empty .tempty{width:38px;height:38px;fill:currentColor}
@media (max-width:380px){.troute .tc{font-size:34px}.troute.big .tc{font-size:38px}}
`;

function init() {
  if (!document.getElementById("awx-trips-css")) document.head.append(h("style", { id: "awx-trips-css" }, CSS));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !S.view) return;
    if (e.target && e.target.getAttribute && e.target.getAttribute("aria-expanded") === "true") return; // the search list closes first
    e.stopImmediatePropagation(); // the airport sheet underneath stays open
    closeTrip();
  }, true);
  window.addEventListener("storage", (e) => { if (e.key === KEY) { S.manual = loadManual(); render(); } });
  window.AWXTrips = {
    render, decorateSheet, liveIds, openTrip, openEdit, openSettings: openTripSettings,
    // site/settings.js (Settings → Trips & flight calendar) and site/nav.js (Trips tab)
    openAdd: () => openEdit(null),
    calStatus,
    ready: () => (S.loading || (S.calAt ? Promise.resolve() : loadCal(true))),
    list: () => S.manual.map((t) => ({ id: t.id, from: t.legs[0].from, to: t.legs[t.legs.length - 1].to, dep: t.legs[0].dep, name: t.legs.length > 1 ? "via " + t.legs.slice(1).map((l) => l.from).join(", ") : "" })),
    routes: () => allTrips().flatMap((t) => t.legs.map((l) => ({ from: l.from, to: l.to }))),
    _state: () => ({ cal: S.cal, manual: S.manual, trips: allTrips().map((t) => ({ id: t.id, source: t.source, ...resultOf(t) })) }),
  };
  render();
  loadCal(true);
}

init();
