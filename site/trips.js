// Trips on the page (README "Trips"). Loaded as a module after app.js; talks to it only through
// window.AWXApp ({state, openSheet, render}) and is called back by three marked hooks in app.js
// ("// trips hook"): render() -> AWXTrips.render(), renderSheet() -> AWXTrips.decorateSheet(sheet, a),
// liveQuery() -> AWXTrips.liveIds().
//
//   - a compact departure-day flight button on the home list; full trips and timelines in the Trips tab;
//   - a trip sheet with each leg, every concern, departure vs. arrival impact and links to the airports;
//   - "Your flight" rows and plane markers in the airport sheets;
//   - manual trips (stored only on this device, localStorage "awx-trips"), and the Trips settings sheet
//     (flight calendar status and how to connect it).
// Calendar trips come from data/trips.json (airports and times only); concerns from ./trip-risk.js.
import { tripStatus, rolesAt, clockText, whenText, rangeText, LEVEL_LABELS, STATUS, TRIP_KEEP_AFTER_ARRIVAL_MS } from "./trip-risk.js?v=9";
import { mountSearch, loadAirports, airportsLoaded, placeLine } from "./search.js";
import { calendarDraft, nextScheduled, todayScheduled, itineraryImpacts, MAX_CALENDAR_BYTES, flightKey } from "./trip-import.js?v=4";

import { CALENDAR_KEY, loadConnection, saveConnection, fetchCalendar } from "./calendar-link.js?v=6";

const KEY = "awx-trips";
const HOUR = 3600e3;
const MIN = 60e3;
const CAL_TTL = 60e3;
const T = window.AWXTest || { name: null, rebase: (d) => d };
const app = () => window.AWXApp;

const enabled = () => window.AWXPrefs?.getPrefs().flights === true;
const requests = new Set();
let refreshTimer = null, active = false, calSeq = 0;
async function requestCalendar(url) {
  const ctl = new AbortController(); requests.add(ctl);
  try { return await fetchCalendar(url, { signal: ctl.signal }); }
  finally { requests.delete(ctl); }
}
const S = {
  connection: enabled() && !T.name ? loadConnection() : null,
  connectionAt: 0, connectionLoading: null, connectionFailed: false,
  connectBusy: false, connectError: "", connectText: "", connectSeq: 0,
  cal: null, // data/trips.json
  calAt: 0,
  calFailed: false,
  loading: null,
  manual: enabled() ? loadManual() : [],
  view: null, // trip sheet: {kind: "trip", id} | {kind: "edit", id|null} | {kind: "settings"}
  lastFocus: null,
  importDraft: null,
  importError: "",
  importBusy: false,
  importSeq: 0,
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
  try { localStorage.setItem(KEY, JSON.stringify(S.manual)); return true; } catch { return false; }
}

function appReady() {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => (!enabled() || (app() && app().state.loaded) || Date.now() - t0 > 8000 ? res() : setTimeout(tick, 50));
    tick();
  });
}

function loadCal(force) {
  if (!enabled()) return Promise.resolve();
  if (S.loading) return S.loading;
  if (!force && S.calAt && Date.now() - S.calAt < CAL_TTL) return Promise.resolve();
  const seq = ++calSeq, ctl = new AbortController(); requests.add(ctl);
  S.loading = (async () => {
    try {
      await appReady();
      if (!enabled() || seq !== calSeq) return;
      const url = T.name ? `./data/scenarios/${T.name}/trips.json` : "./data/trips.json";
      const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
      const d = r.ok ? await r.json() : null;
      if (!enabled() || seq !== calSeq) return;
      if (r.ok || r.status === 404) { S.cal = T.name && d ? T.rebase(d) : d; S.calFailed = false; }
      else S.calFailed = true;
      S.calAt = Date.now();
    } catch { if (enabled() && seq === calSeq) { S.calFailed = true; S.calAt = Date.now(); } }
    finally {
      requests.delete(ctl);
      if (seq === calSeq) { S.loading = null; render(); }
    }
  })();
  return S.loading;
}

function connectedDoc() { return S.connection?.doc || S.cal; }
function refreshConnection(force = false) {
  if (!enabled() || T.name || !S.connection || S.connectionLoading || (!force && Date.now() - S.connectionAt < 10 * MIN)) return S.connectionLoading || Promise.resolve();
  const link = S.connection.url, seq = S.connectSeq;
  S.connectionAt = Date.now();
  S.connectionLoading = (async () => {
    try {
      const [doc] = await Promise.all([requestCalendar(link), loadAirports().catch(() => null)]);
      if (!enabled() || seq !== S.connectSeq || S.connection?.url !== link) return;
      const value = { url: link, doc };
      S.connection = value; S.connectionFailed = false;
      if (!saveConnection(value)) S.connectionFailed = true;
    } catch { if (seq === S.connectSeq) S.connectionFailed = true; }
    finally { if (seq === S.connectSeq) { S.connectionLoading = null; render(); } }
  })();
  return S.connectionLoading;
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

/** Calendar + manual trips retained until 24 h after scheduled arrival, soonest first. */
function allTrips() {
  if (!enabled()) return [];
  const now = nowMs();
  const cal = (connectedDoc()?.trips || []).map((t) => ({ ...t, source: "calendar" }));
  const man = S.manual.map((t) => ({ ...t, source: "manual" }));
  const seen = new Set();
  return [...man, ...cal].map(t => ({ ...t, legs: t.legs.filter(l => { const k = flightKey(l); if (seen.has(k)) return false; seen.add(k); return true; }) })).filter(t => t.legs.length)
    .map((t) => ({ ...t, legs: [...t.legs].sort((a, b) => Date.parse(a.dep) - Date.parse(b.dep)) }))
    .filter((t) => Date.parse(t.legs[t.legs.length - 1].arr) >= now - TRIP_KEEP_AFTER_ARRIVAL_MS)
    .sort((a, b) => Date.parse(a.legs[0].dep) - Date.parse(b.legs[0].dep));
}
let todayAirportsCache = { key: "", codes: [] };
function todayAirportIds() {
  const now = nowMs(), trips = allTrips();
  const key = Math.floor(now / MIN) + "|" + trips.map(t => t.legs.map(l => flightKey(l) + tzFor(l.from, t) + tzFor(l.to, t)).join(",")).join(";");
  if (todayAirportsCache.key === key) return todayAirportsCache.codes;
  const codes = new Set();
  for (const trip of trips) for (const leg of trip.legs) {
    for (const [code, time] of [[leg.from, leg.dep], [leg.to, leg.arr]]) {
      const tz = tzFor(code, trip), opts = { year: "numeric", month: "numeric", day: "numeric" };
      if (fmt(Date.parse(time), tz, opts) === fmt(now, tz, opts)) codes.add(code);
    }
  }
  todayAirportsCache = { key, codes: [...codes] };
  return todayAirportsCache.codes;
}
// build2b hook: delay chances in plain, calibrated words (site/delay.js likelihood), never a percentage
const delayWordsFor = (d, iata) => { const L = window.AWXDelay && window.AWXDelay.likelihood ? window.AWXDelay.likelihood(d, { iata }) : null; return L ? L.word : null; };
// Trips use all known disruption categories, including those hidden on the airport list.
// Share the airport outlook's freshness/source checks rather than interpreting green hours as healthy data.
function airportHealth(a) {
  const st = app()?.state, data = st?.data;
  const ns = data?.noticeSources || {};
  const noticesDown = ["tfr"].some((k) => ns[k] && (!ns[k].ok || ns[k].error || ns[k].stale));
  // noticesQualify: the airport views call unreadable nearby restrictions a minor note (still Clear); trips keep qualifying them
  return window.AWXOutlook?.health ? window.AWXOutlook.health(a, {
    now: nowMs(), generated: data?.generated, sources: data?.sources, sample: st?.sample, noticesDown, noticesQualify: true, offline: st?.offline,
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
  const label = `Scheduled from ${first.from} at ${clockText(first.d, tzFor(first.from, trip))} to ${last.to} at ${clockText(last.a, tzFor(last.to, trip))}`;
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
    h("div", { class: "muted small" }, "Scheduled times · actual flight status unavailable"),
    miniTimeline(trip));
  return el;
}

function focusedTrip(focus) {
  const card = tripCard(focus.trip);
  card.classList.add("tnext");
  card.dataset.nextTrip = focus.trip.id;
  card.prepend(h("div", { class: "tnext-label" }, focus.future ? "Next scheduled flight" : "Recent scheduled trip"));
  const meta = card.querySelector(".tmeta .tw");
  meta.textContent = `${focus.leg.from} → ${focus.leg.to} · ${dateLine(Date.parse(focus.leg.dep), tzFor(focus.leg.from, focus.trip))}`;
  const r = resultOf(focus.trip);
  card.append(h("div", { class: "tnext-action" }, r.level >= 2 || r.quality ? "Review trip outlook ›" : "View trip ›"));
  return card;
}
const todayFlight = () => todayScheduled(allTrips(), nowMs(), tzFor);
function openTodayBrief() { const focus = todayFlight(); if (focus) openTrip(focus.trip.id); }
function homeFlight(focus) {
  const { trip, leg } = focus;
  const r = resultOf(trip);
  const time = clockText(Date.parse(leg.dep), tzFor(leg.from, trip));
  return h("button", { type: "button", class: "card thome", "data-trip": trip.id,
    "aria-label": `Today's scheduled flight ${leg.from} to ${leg.to} at ${time}. ${r.label}. ${r.top}. View trip details`,
    onclick: () => openTrip(trip.id) },
    h("span", { class: "thome-heading" }, "Today's flight brief", h("span", { "aria-hidden": "true" }, "›")),
    h("span", { class: "thome-main" }, h("b", {}, [trip.legs[0].from, ...trip.legs.map(l => l.to)].join(" → ")), h("span", {}, time), pillEl(r, true)),
    h("span", { class: "thome-summary" }, r.top),
    trip.source !== "manual" && calStatus().warn ? h("span", { class: "thome-note warn" }, "Calendar update unavailable · saved times may be outdated") : null,
    h("span", { class: "thome-note" }, "Scheduled · actual flight status unconfirmed"));
}
function tripActions() {
  return h("div", { class: "trips-b" },
    h("button", { type: "button", class: "tadd", onclick: () => openEdit(null) }, "Add a trip"),
    h("button", { type: "button", class: "tadd", onclick: openConnect }, "Connect calendar"));
}

let tabBox = null; // the nav shell's Trips tab (site/nav.js calls render(container))
function render(container) {
  if (!enabled()) {
    if (container?.nodeType) tabBox = container;
    tabBox?.replaceChildren();
    const home = document.getElementById("trips");
    if (home) { home.replaceChildren(); home.hidden = true; }
    document.querySelectorAll(".tflight, .tplane, .tfoot").forEach(el => el.remove());
    document.dispatchEvent(new CustomEvent("awx:trips"));
    return;
  }
  const active = document.activeElement, focusedId = active?.dataset.trip;
  const focusedBox = active?.closest("#navTrips, #trips")?.id;
  if (container && container.nodeType) tabBox = container;
  loadCal(false);
  refreshConnection();
  if (tabBox) renderTab(tabBox);
  const box = document.getElementById("trips");
  if (!box) { refreshOpen(); return; }
  box.hidden = false;
  const trips = allTrips();
  if (!trips.length) { box.replaceChildren(); renderFoot(); refreshOpen(); document.dispatchEvent(new CustomEvent("awx:trips")); const a = statusAirports().find((a) => a.iata === app()?.state.openIata); if (a) decorateSheet(document.getElementById("sheet"), a); return; }
  const focus = todayFlight();
  box.replaceChildren(...(focus ? [homeFlight(focus)] : []));
  renderFoot();
  refreshOpen();
  document.dispatchEvent(new CustomEvent("awx:trips"));
  const sheet = document.getElementById("sheet");
  const airport = statusAirports().find((a) => a.iata === app()?.state.openIata);
  if (airport) decorateSheet(sheet, airport);
  if (focusedId && focusedBox) [...(document.getElementById(focusedBox)?.querySelectorAll("[data-trip]") || [])].find(el => el.dataset.trip === focusedId)?.focus({ preventScroll: true });
}

function testBanner() {
  if (!T.scenario && !T.name) return null;
  return h("div", { class: "msgbar" }, h("b", {}, "Test scenario: " + (T.info?.title || T.scenario || T.name) + " "), "(not live) · ",
    h("a", { href: T.exitUrl || "./", onclick: e => { e.preventDefault(); T.exit(); } }, "Exit"));
}

/** The Trips tab: every trip, "Add a trip", and the calendar line; an empty state when there are none. */
function renderTab(box) {
  const trips = allTrips();
  const cs = calStatus();
  if (!trips.length) {
    box.replaceChildren(...[testBanner(), h("div", { class: "awx-empty ttab-empty" },
      h("div", { class: "awx-empty-ico" }, svg(PLANE, "tempty", 45)),
      h("h2", {}, "Your next trip starts here"),
      h("p", {}, "Add your flight times to see the airport outlook along your trip. Saved on this device."),
      h("button", { type: "button", class: "awx-btn primary", onclick: () => openEdit(null) }, "Add a trip"),
      h("button", { type: "button", class: "awx-btn", onclick: openConnect }, "Connect flight calendar"),
      h("button", { type: "button", class: "awx-btn", onclick: openImport }, "Import a calendar file"),
      h("p", { class: "timport-note" }, "One-time .ics import · no calendar sync or upload"),
      cs.warn ? h("p", { class: "warn", role: "status" }, "Calendar update unavailable. Saved flight times may be outdated.") : cs.connected ? h("p", {}, "Your calendar has no recognized flights in the next 7 days.") : null)].filter(Boolean));
    return;
  }
  const focus = nextScheduled(trips, nowMs());
  const rest = trips.filter((t) => t.id !== focus.trip.id);
  box.replaceChildren(...[
    testBanner(),
    h("div", { class: "trips-h ttab-h" }, tripActions(),
      h("button", { type: "button", class: "tgear", "aria-label": "Trips settings", onclick: () => openTripSettings() }, svg("M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "gear"))),
    cs.warn ? h("div", { class: "tcal-line warn", role: "status" }, "Calendar update unavailable · saved times may be outdated") : null,
    focusedTrip(focus),
    rest.length ? h("div", { class: "trips-h", style: "margin-top:20px" }, h("h2", {}, "Other trips")) : null,
    rest.length ? h("div", { class: "tlist" }, rest.map(tripCard)) : null].filter(k => k != null));
}
const calAgo = () => { const g = connectedDoc() && Date.parse(connectedDoc().generated); return g ? " · updated " + ago(Math.max(0, nowMs() - g)) : ""; };

/** Settings → Trips & flight calendar (site/settings.js through the nav shell), else this file's own Trips sheet. */
function openTripSettings(focus) { if (!enabled()) return;
  if (window.AWXNav && typeof window.AWXNav.openSettings === "function") {
    const next = () => window.AWXNav.openSettings("trips", focus ? { focus } : undefined);
    if (S.view && window.AWXSheet?.transfer) AWXSheet.transfer(closeTrip, next);
    else { if (S.view) closeTrip(); next(); }
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

/** Paired airport-local scheduled times; dates remain explicit across midnight and time zones. */
function flightRoute(leg, trip, compact = false) {
  const endpoint = (code, time, label) => {
    const ms = typeof time === "number" ? time : Date.parse(time), tz = tzFor(code, trip);
    return h("span", { class: "tfendpoint" },
      compact ? null : h("span", { class: "tfrole" }, label), h("b", { class: "tfcode" }, code),
      h("span", { class: "tftime" }, `${clockText(ms, tz)} ${tzAbbr(ms, tz)}`),
      h("span", { class: "tfday" }, fmt(ms, tz, { weekday: "short", month: "short", day: "numeric" })));
  };
  return h("span", { class: "tfroute" + (compact ? " compact" : "") }, endpoint(leg.from, leg.dep, "Departure"),
    h("span", { class: "tfpath", "aria-hidden": "true" }, svg(PLANE, "tfi", 90)), endpoint(leg.to, leg.arr, "Arrival"));
}

// ---------- airport sheet: "Your flight" + plane markers ----------

// terminals hook: TODO (future) when a leg departs from an airport with terminal data, show its gate's concourse and the nearest lounge (AWXTerminals.gateInfo in site/terminals.js). Nothing yet.
function decorateSheet(sheet, a) {
  if (!sheet || !a) return;
  sheet.querySelectorAll(".tflight, .tplane").forEach((x) => x.remove());
  const now = nowMs();
  const groups = [];
  const marks = [];
  for (const trip of allTrips()) {
    const roles = rolesAt(trip, a.iata).filter(line =>
      (line.until || line.at) >= now - TRIP_KEEP_AFTER_ARRIVAL_MS);
    if (!roles.length) continue;
    const r = resultOf(trip);
    const sm = app()?.summary?.(a);
    const contexts = roles.filter(line => sm?.level >= 2 && window.AWXOutlook?.overlaps({ start: sm.start, end: sm.end }, line.at, line.until))
      .map(line => `${a.iata} ${line.role === "dep" ? "departure" : line.role === "arr" ? "arrival" : "connection"} overlaps peak airport risk.`);
    const rows = trip.legs.flatMap((leg, i) => {
      const lr = resultOf({ ...trip, legs: [leg] });
      const note = lr.status === "early" ? `Forecast from ${whenText(Date.parse(leg.dep) - 24 * HOUR, tzFor(leg.from, trip), now)}.`
        : lr.status === "unknown" ? "Forecast coverage unavailable" : lr.concerns.find(c => c.level > 0)?.short || null;
      const display = { ...lr, label: lr.status === "ok" ? "Low airport risk" : lr.label };
      const row = h("button", { type: "button", class: "tfrow " + lr.cls, "data-flight-leg": i + 1,
        "aria-label": `Leg ${i + 1} of ${trip.legs.length}, ${leg.from} to ${leg.to}. ${dateLine(Date.parse(leg.dep), tzFor(leg.from, trip))}. ${lr.label}. Open the trip`, onclick: () => openTrip(trip.id) },
        h("span", { class: "tfhead" }, h("span", { class: "tfl" }, trip.legs.length > 1 ? `Leg ${i + 1} of ${trip.legs.length}` : "Scheduled flight"), pillEl(display, true)),
        flightRoute(leg, trip, true),
        note ? h("span", { class: "tfcontext" }, note) : null);
      const conn = r.legs[i]?.conn;
      return [row, conn ? h("div", { class: "tfconnection" + (conn.tight ? " tight" : "") },
        `${conn.minutes} min connection · ${conn.iata}`, conn.tight ? h("span", { class: "badge l2" }, "Tight") : null,
        r.concerns.some(c => c.side === "conn" && c.leg === i && c.level >= 2) ? h("span", { class: "tfconn-risk" }, "Missed connection possible") : null) : null];
    }).filter(Boolean);
    groups.push(h("div", { class: "tfgroup" },
      ...rows,
      ...[...new Set(contexts)].map(text => h("p", { class: "tfcontext tfnotice" }, text)),
      h("p", { class: "tfsource" }, r.scheduleNote),
      calStatus().warn && trip.source !== "manual" ? h("p", { class: "tfcontext warn" }, "Calendar update unavailable · saved times may be outdated") : null));
    for (const line of roles) marks.push({ at: line.at, what: line.role === "dep" ? "departure" : line.role === "arr" ? "arrival" : "connection" });
  }
  if (!groups.length) return;
  const box = h("section", { class: "tflight", "aria-label": "Your flights" },
    h("h3", { class: "tfheading" }, "Your flights"), ...groups);
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
  if (S.view?.kind === "connect" && S.connectBusy) S.connectSeq++;
  S.view = null;
  S.importDraft = null; S.importSeq++;
  w.classList.remove("open");
  if (!(app() && app().state.openIata)) document.documentElement.classList.remove("lock");
  if (tripCtl) tripCtl.closed(); // build2b hook
  const done = () => { if (!S.view) w.hidden = true; };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 300);
  const target = S.lastFocus?.isConnected ? S.lastFocus : document.querySelector(app()?.state.openIata ? "#sheet .close" : "#tab-trips");
  target?.focus({ preventScroll: true });
}
const head = (title, ...right) => h("div", { class: "sh-head" },
  title,
  h("div", { class: "right", style: "gap:6px" }, ...right, h("button", { type: "button", class: "close", "aria-label": "Close", onclick: closeTrip }, svg(CLOSE, "x"))));
const sec = (title, ...kids) => h("div", { class: "sec" }, h("h3", {}, title), ...kids);

function openTrip(id) { if (!enabled()) return; S.view = { kind: "trip", id }; drawView(); show(); }
function openEdit(id) { if (!enabled()) return; S.view = { kind: "edit", id }; drawView(); show(); }
function openImport() { if (!enabled()) return; S.importDraft = null; S.importError = ""; S.importBusy = false; S.importSeq++; S.view = { kind: "import" }; drawView(); show(); }
function openConnect() { if (!enabled()) return; S.connectError = ""; S.connectBusy = false; S.connectText = ""; S.view = { kind: "connect" }; drawView(); show(); }
function openSettings() { if (!enabled()) return; S.view = { kind: "settings" }; drawView(); show(); }
/** Redraw an open trip sheet when the data refreshes (not the editor: it would lose the typing). */
function refreshOpen() { if (S.view && S.view.kind !== "edit" && S.view.kind !== "import" && S.view.kind !== "connect") drawView(true); }

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
  else if (S.view.kind === "import") kids = importView();
  else if (S.view.kind === "connect") kids = connectView();
  else kids = settingsView();
  sheet.replaceChildren(h("div", { class: "grab", "aria-hidden": "true" }), ...kids.filter(k => k != null));
  if (keep) sheet.scrollTop = top; else sheet.scrollTop = 0;
  if (keep && S.view.kind === "import") sheet.querySelector('[role="alert"], [role="status"], .tbtn.primary, input')?.focus({ preventScroll: true });
}

function sourceLine(trip) {
  if (trip.source === "manual") return trip.imported ? "Imported calendar snapshot · saved on this device only" : "Added by you · saved on this device only";
  return "From your flight calendar" + calAgo();
}

function levelBox(title, sub, at, note) {
  return h("div", { class: "box" },
    h("h4", {}, title, at ? h("span", { class: "pill sm " + (at.level == null ? "off" : lv(at.level)) }, at.level == null ? "Unknown" : LEVEL_LABELS[at.level]) : null),
    h("div", { class: "muted small" }, sub),
    h("div", { class: "tbx" }, note || (at ? (at.level == null ? at.quality : at.reason || (at.level ? "Minor weather conditions" : "No significant weather")) : byIata(title.split(" ").pop()) ? "Forecast unavailable for this scheduled time" : "No data for this airport yet")),
    at?.quality && at.level != null ? h("div", { class: "muted small" }, at.quality) : null,
    at && at.level != null && at.delay && at.delay.p != null ? h("div", { class: "muted small" }, delayWordsFor(at.delay, title.split(" ").pop()) || "") : null); // build2b hook: words, not %
}

function tripView(trip) {
  const r = resultOf(trip);
  const first = trip.legs[0];
  const tzF = tzFor(first.from, trip);
  const legsEls = r.legs.map((l, i) => {
    const tf = tzFor(l.from, trip), tt = tzFor(l.to, trip);
    return h("div", { class: "tleg" },
      h("div", { class: "tfhead tleg-h" }, h("span", { class: "tfl" }, `Leg ${i + 1} of ${trip.legs.length}`)),
      flightRoute(l, trip),
      h("div", { class: "two" },
        levelBox(`Scheduled departure ${l.from}`, whenText(l.dep, tf, nowMs()), l.depAt, !l.depAt && l.scheduledDepPassed ? "Forecast coverage expired" : null),
        levelBox(`Scheduled arrival ${l.to}`, whenText(l.arr, tt, nowMs()), l.arrAt, !l.arrAt && l.scheduledArrPassed ? "Forecast coverage expired" : null)),
      l.conn ? h("div", { class: "tconn" + (l.conn.tight ? " tight" : "") },
        `Scheduled connection at ${l.conn.iata} · ${l.conn.minutes} min`, l.conn.tight ? h("span", { class: "badge l2" }, "Tight") : null) : null,
    );
  });
  const impacts = itineraryImpacts(trip, r);
  const impactSections = impacts.map(g => h("div", { class: "timpact", "data-impact-iata": g.iata },
    h("h4", {}, `${g.role} · ${g.iata}`),
    ...g.notes.map(text => h("p", {}, text)),
    h("button", { type: "button", class: "timpact-link", onclick: () => openAirport(g.iata) }, `View ${g.iata} airport details ›`)));
  const codes = [...new Set(trip.legs.flatMap((l) => [l.from, l.to]))];
  const manual = trip.source === "manual";
  let delArmed = false;
  return [
    head(h("div", { id: "tripTitle" }, routeEl(trip, true))),
    todayFlight()?.trip.id === trip.id ? h("div", { class: "tnext-label" }, "Today's flight brief") : null,
    h("div", { class: "where sh-where" }, dateLine(Date.parse(first.dep), tzF)),
    h("div", { class: "box tstat" }, pillEl(r), h("div", { class: "tbx", style: "margin-top:8px;font-weight:600" }, r.top),
      h("div", { class: "muted small", style: "margin-top:8px" }, r.scheduleNote), r.quality && r.concerns.some((c) => c.level > 0) ? h("div", { class: "muted small" }, r.quality) : null),
    impacts.length ? sec("Along your itinerary", ...impactSections) : null,
    sec(trip.legs.length > 1 ? "Scheduled flights" : "Scheduled flight", ...legsEls,
      trip.legs.length > 1 ? h("div", { class: "muted small", style: "margin-top:8px" }, "Connection time is based on the schedule. Actual arrival, gates and time to reach the next flight are not available.") : null),
    sec("Airports", h("div", { class: "tapts" }, codes.map((c) => h("button", {
      type: "button", class: "tapt", onclick: () => openAirport(c),
    }, h("b", {}, c), h("span", { class: "muted small" }, (byIata(c) && byIata(c).city) || ""))))),
    h("div", { class: "checked" },
      h("p", { class: "muted" }, sourceLine(trip)),
      !manual && calStatus().warn ? h("p", { class: "warn" }, "Your flight calendar couldn't be read on the last update — times may be out of date.") : null,
      manual ? h("div", { class: "tbtns" },
        trip.legs.length <= 2 ? h("button", { type: "button", class: "tbtn", onclick: () => openEdit(trip.id) }, "Edit") : h("p", { class: "muted small" }, "To update multiple connections, delete this trip and import an updated calendar file."),
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
  if (a) {
    if (window.AWXSheet?.transfer) AWXSheet.transfer(closeTrip, () => app().openSheet(code));
    else { closeTrip(); app().openSheet(code); }
    return;
  }
  closeTrip();
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
  if (legs.length > 2) return [head(h("h2", { id: "tripTitle", class: "th2" }, "Edit trip")), h("p", { class: "muted" }, "This imported trip has multiple connections. To replace its schedule, delete it and import an updated calendar file."), h("button", { type: "button", class: "tbtn", onclick: () => openTrip(ex.id) }, "Back to trip")];
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
  const viaArr = inp("time", ex && legs.length > 1 ? val(Date.parse(legs[0].arr), tzOf(f.via), "t") : "", "Scheduled connection arrival (local)");
  const viaDep = inp("time", ex && legs.length > 1 ? val(Date.parse(legs[1].dep), tzOf(f.via), "t") : "", "Scheduled connection departure (local)");
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
      if (!v(viaArr) || !v(viaDep)) { err.textContent = "Add the scheduled arrival and departure at the connection."; return; }
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
    const before = S.manual;
    S.manual = ex ? S.manual.map((t) => (t.id === ex.id ? trip : t)) : [...S.manual, trip];
    if (!saveManual()) { S.manual = before; err.textContent = "Device storage is unavailable. The trip was not saved."; return; }
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

// ---------- one-time calendar import ----------
function importView() {
  const d = S.importDraft;
  const input = h("input", { type: "file", class: "tin", accept: ".ics,text/calendar", "aria-label": "Calendar file", onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const seq = ++S.importSeq;
    S.importDraft = null; S.importError = ""; S.importBusy = true;
    drawView(true);
    try {
      if (file.size > MAX_CALENDAR_BYTES) throw new Error("Choose a calendar file under 1 MB.");
      const [text, airports] = await Promise.all([file.text(), loadAirports().catch(() => { throw new Error("Airport directory unavailable. Check your connection and try again."); })]);
      const draft = calendarDraft(text, { airports, existing: [...S.manual, ...(connectedDoc()?.trips || [])], now: nowMs() });
      if (S.view?.kind !== "import" || seq !== S.importSeq) return;
      S.importDraft = draft;
      if (!draft.trips.length) S.importError = draft.skipped ? "These matching flights are already saved. Nothing new to import." : "No recognizable timed flights in the next 7 days or recent 24 hours. The file needs departure and arrival airports and times.";
    } catch (err) {
      if (S.view?.kind !== "import" || seq !== S.importSeq) return;
      S.importError = (err.message.startsWith("Choose ") || err.message.startsWith("Airport directory unavailable.")) ? err.message : "Couldn't read this calendar. Check the file and try again.";
    }
    if (S.view?.kind === "import" && seq === S.importSeq) { S.importBusy = false; drawView(true); }
  } });
  const save = () => {
    if (!d?.trips.length) return;
    // Recheck matches in case another tab added a flight while this preview was open.
    const known = new Set([...loadManual(), ...(connectedDoc()?.trips || [])].flatMap(t => t.legs.map(flightKey)));
    const added = d.trips.filter(t => !t.legs.some(l => known.has(flightKey(l))));
    const before = S.manual;
    S.manual = [...loadManual(), ...added];
    if (!saveManual()) { S.manual = before; S.importError = "Device storage is unavailable. The trips were not saved."; drawView(true); return; }
    closeTrip();
    if (window.AWXNav) AWXNav.go("trips");
    render();
    setTimeout(() => { if (!S.view && window.AWXNav?.tab() === "trips" && (document.activeElement === document.body || document.activeElement.id === "tab-trips")) document.querySelector("#navTrips .tnext")?.focus({ preventScroll: true }); }, 320);
  };
  return [
    head(h("h2", { id: "tripTitle", class: "th2" }, "Import calendar")),
    h("p", { class: "muted" }, "Choose an exported .ics file. It is read on this device only; the file and calendar link are never uploaded."),
    h("div", { class: "box" }, h("label", { class: "tfield" }, h("div", { class: "tlabel" }, "Calendar file"), input),
      h("p", { class: "muted small" }, "Flights in the next 7 days and trips scheduled to arrive within the past 24 hours. This is a snapshot: import again or edit times when plans change.")),
    S.importBusy ? h("p", { role: "status", class: "muted", tabindex: "-1" }, "Reading calendar…") : null,
    S.importError ? h("p", { role: "alert", class: "terr", tabindex: "-1" }, S.importError) : null,
    d?.trips.length ? sec("Preview", d.trips.slice(0, 5).map(t => h("div", { class: "item" }, routeEl(t), h("div", { class: "muted small" }, dateLine(Date.parse(t.legs[0].dep), t.tz[t.legs[0].from])))),
      d.trips.length > 5 ? h("p", { class: "muted small" }, `And ${d.trips.length - 5} more trips`) : null,
      h("p", { class: "muted small" }, `${d.flights} flight${d.flights === 1 ? "" : "s"} ready${d.skipped ? ` · ${d.skipped} matching flights skipped` : ""}. Only airports, scheduled times and airport time zones are saved; no names, flight numbers or booking details.`),
      h("button", { type: "button", class: "tbtn primary", onclick: save }, `Save ${d.trips.length} trip${d.trips.length === 1 ? "" : "s"}`)) : null,
  ];
}

// ---------- private calendar connection ----------
function connectView() {
  const status = calStatus();
  const input = h("input", { type: "url", class: "tin", value: S.connectText, placeholder: "webcal://… or https://…", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-label": "Calendar subscription link", oninput: e => { S.connectText = e.target.value; } });
  const connect = async e => {
    e.preventDefault();
    if (!S.connectText.trim() || S.connectBusy) return;
    if (T.name) { S.connectError = "Calendar connections are unavailable in test scenarios. Return to live data to connect."; drawView(true); return; }
    const url = S.connectText.trim(), seq = ++S.connectSeq;
    S.connectBusy = true; S.connectError = ""; drawView(true);
    try {
      const [doc] = await Promise.all([requestCalendar(url), loadAirports().catch(() => null)]);
      if (!enabled() || seq !== S.connectSeq || S.view?.kind !== "connect") return;
      const value = { url, doc };
      if (!saveConnection(value)) throw new Error("Device storage is unavailable. The calendar was not connected.");
      S.connection = value; S.connectionAt = Date.now(); S.connectionFailed = false; S.connectText = "";
      closeTrip(); window.AWXNav?.go("trips"); render();
    } catch (err) {
      if (!enabled() || seq !== S.connectSeq || S.view?.kind !== "connect") return;
      S.connectError = err.name === "TypeError" || err.name === "AbortError" ? "Couldn't connect right now. Check your connection and try again." : err.message;
    } finally { if (seq === S.connectSeq) { S.connectBusy = false; if (S.view?.kind === "connect") drawView(true); } }
  };
  const disconnect = () => {
    if (!saveConnection(null)) { S.connectError = "Device storage is unavailable. Try again to disconnect."; drawView(true); return; }
    S.connectSeq++; S.connection = null; S.connectionFailed = false; S.connectionAt = 0;
    closeTrip(); render();
  };
  return [
    head(h("h2", { id: "tripTitle", class: "th2" }, "Connect flight calendar")),
    h("p", { class: "muted" }, "Paste a calendar link to keep your flights up to date. Saved on this device."),
    S.connection ? sec("Your calendar", h("div", { class: "tcal" }, status.text), h("div", { class: "tbtns" },
      h("button", { type: "button", class: "tbtn", onclick: async e => { e.currentTarget.disabled = true; await refreshConnection(true); if (S.view?.kind === "connect") drawView(true); } }, "Refresh now"),
      h("button", { type: "button", class: "tbtn danger", onclick: disconnect }, "Disconnect"))) : null,
    h("form", { class: "box", onsubmit: connect },
      h("label", { class: "tfield" }, h("div", { class: "tlabel" }, S.connection ? "Replace calendar link" : "Calendar subscription link"), input),
      h("p", { class: "muted small" }, "Shared iCloud and Google calendars supported. Only airports and scheduled times are kept. Keep your flight-calendar link private."),
      h("button", { type: "submit", class: "tbtn primary", disabled: S.connectBusy }, S.connectBusy ? "Connecting…" : S.connection ? "Replace calendar" : "Connect calendar")),
    S.connectError ? h("p", { role: "alert", class: "terr" }, S.connectError) : null,
    h("details", { class: "sec" },
      h("summary", { class: "tbtn", style: "min-height:44px;display:flex;align-items:center;cursor:pointer" }, "Connect Flighty through iCloud"),
      h("ol", { class: "muted", style: "padding-left:20px;line-height:1.4" },
        h("li", {}, "Export from Flighty: Settings → Calendar Sync → Calendar Export. Choose a dedicated calendar in iCloud for your flights."),
        h("li", {}, "Share from iCloud: Apple Calendar → Calendars → info beside your flight calendar → enable Public Calendar → Share Link."),
        h("li", {}, "Paste the iCloud link above to connect. Flighty maintains the calendar; Airports refreshes your flights while the app is open. For Google Calendar, use its iCal subscription link.")),
      h("p", { class: "muted small" }, "Anyone with a public calendar link can read it. Keep this calendar limited to flights and keep its link private.")),
    h("button", { type: "button", class: "tbtn", onclick: openImport }, "Import a calendar file instead"),
  ];
}

// ---------- settings ----------

/** Flight calendar status: {connected, ok, warn, text} ("Connected · 3 upcoming flights" / "Not connected"). */
function calStatus() {
  const c = connectedDoc();
  if (S.connection && S.connectionFailed) return { connected: true, ok: false, warn: true, text: "Connected · update unavailable; saved times may be outdated" };
  if (!S.connection && S.calFailed) return { connected: !!c?.configured, ok: false, warn: true, text: "Couldn't check — saved calendar times may be out of date" };
  if (!c || !c.configured) return { connected: false, ok: false, text: "Not connected" };
  if (c.ok === false) return { connected: true, ok: false, warn: true, text: "Connected · couldn't read it on the last update" + (c.error ? ` (${c.error})` : "") };
  const now = nowMs();
  const n = (c.trips || []).reduce((k, t) => k + t.legs.filter((l) => Date.parse(l.arr) > now).length, 0);
  return { connected: true, ok: true, text: `Connected · ${n} upcoming flight${n === 1 ? "" : "s"}` };
}

function settingsView() {
  const st = calStatus();
  const g = connectedDoc() && Date.parse(connectedDoc().generated);
  const man = S.manual.map((t) => ({ ...t, source: "manual" })).sort((a, b) => Date.parse(a.legs[0].dep) - Date.parse(b.legs[0].dep));
  return [
    head(h("h2", { id: "tripTitle", class: "th2" }, "Trips")),
    sec("Add your flights", h("div", { class: "muted small" }, "Save flights on this device, or import a calendar snapshot."),
      h("div", { class: "tbtns" }, h("button", { type: "button", class: "tbtn primary", onclick: () => openEdit(null) }, "Add a trip"), h("button", { type: "button", class: "tbtn", onclick: openConnect }, "Connect calendar"), h("button", { type: "button", class: "tbtn", onclick: openImport }, "Import calendar file"))),
    st.connected || st.warn ? sec("Flight calendar", h("div", { class: "tcal" + (st.warn ? " warn" : "") }, st.text), g ? h("div", { class: "muted small" }, "Checked " + ago(Math.max(0, nowMs() - g))) : null) : null,
    sec("Added on this device",
      man.length ? man.map((t) => h("div", { class: "item tman" },
        h("div", {}, h("b", {}, t.legs.map((l) => l.from).concat(t.legs[t.legs.length - 1].to).join(" → ")),
          h("div", { class: "muted small" }, dateLine(Date.parse(t.legs[0].dep), tzFor(t.legs[0].from, t)))),
        h("div", { class: "tbtns" },
          h("button", { type: "button", class: "tbtn", onclick: () => openTrip(t.id) }, "Open"),
          t.legs.length <= 2 ? h("button", { type: "button", class: "tbtn", onclick: () => openEdit(t.id) }, "Edit") : null)))
        : h("div", { class: "muted", style: "font-size:14px" }, "No trips added on this device."),
      h("div", { class: "tbtns", style: "margin-top:12px" }, h("button", { type: "button", class: "tbtn primary", onclick: () => openEdit(null) }, "Add a trip"))),
  ];
}

// ---------- styles ----------

const CSS = `
#trips{margin-bottom:14px}
#trips:empty{display:none}
.thome{display:block;width:100%;padding:12px 14px;text-align:left;min-height:44px}
.thome-heading{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px}
.thome-main{display:flex;flex-wrap:wrap;align-items:center;gap:5px 10px;font-size:14px}
.thome-main b{font-size:18px;letter-spacing:-.02em}
.thome-summary{display:block;font-size:13px;line-height:1.4;margin-top:8px}
.timpact{padding:12px 0;border-bottom:1px solid var(--line)}
.timpact:last-child{border-bottom:0}
.timpact h4{font-size:14px;margin:0 0 6px}
.timpact p{font-size:14px;margin:6px 0;line-height:1.45}
.timpact-link{min-height:44px;font-size:13px;font-weight:600;color:var(--brand)}
.thome-note{display:block;font-size:11px;color:var(--muted);margin-top:5px}
.thome:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
.trips-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 8px}
.trips-h h2{margin:0;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.trips-b{display:flex;align-items:center;gap:6px}
.tadd{white-space:nowrap;flex:none;min-height:44px;padding:0 14px;border-radius:999px;background:var(--card);font-size:14px;font-weight:600;color:var(--brand)}
.tgear{width:44px;height:44px;border-radius:50%;background:var(--card);display:grid;place-items:center;color:var(--muted)}
.tgear svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
.tlist{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.troute{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;row-gap:2px}
.troute .tc{font-size:40px;line-height:.95;font-weight:800;letter-spacing:-.035em}
.troute.big{flex-wrap:wrap}
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
.twrap .sheet{top:0;bottom:0;max-height:none;border-radius:0;padding-top:calc(env(safe-area-inset-top) + 8px)}
.twrap .two{grid-template-columns:repeat(2,minmax(0,1fr))}
.twrap .two .box h4{flex-wrap:wrap}
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
.tbtn.primary{background:var(--accent-btn,var(--brand));color:var(--brand-ink,#000)}
.tbtn.danger{color:var(--crit)}
.tflight{display:grid;gap:10px;margin:0 0 16px}
.tfheading{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 4px}
.tfgroup{border-radius:18px;background:var(--card-2);overflow:hidden}
.tfdate{padding:12px 14px 0;font-size:12px;font-weight:600;color:var(--muted)}
.tfrow{display:block;width:100%;text-align:left;padding:8px 12px;min-height:44px;background:transparent}
.tfrow.off{--c:var(--muted)}
.tfrow:focus-visible{outline:2px solid var(--brand);outline-offset:-3px;border-radius:12px}
.tfhead{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 10px;margin-bottom:5px}
.tfl{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.tfhead .pill.sm{font-size:11px;padding:3px 8px}
.tfroute{display:grid;grid-template-columns:minmax(0,1fr) 36px minmax(0,1fr);align-items:center;gap:8px}
.tfendpoint{display:grid;gap:3px;min-width:0}
.tfendpoint:last-child{text-align:right}
.tfrole,.tfday{font-size:11px;color:var(--muted);line-height:1.3}
.tfcode{font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.05}
.tftime{font-size:14px;font-weight:600;line-height:1.35}
.tfpath{display:flex;justify-content:center;position:relative;color:var(--muted)}
.tfpath::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid var(--line)}
.tfpath .tfi{position:relative;width:18px;height:18px;fill:currentColor;background:var(--card-2)}
.tfcontext{display:block;margin-top:5px;font-size:11px;font-weight:400;line-height:1.4;color:var(--muted)}
.tfconnection{display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;padding:6px 12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:12px;font-weight:600;color:var(--muted)}
.tfconnection.tight{color:var(--l2)}
.tfsource{padding:0 12px 8px;margin:0;font-size:11px;line-height:1.4;color:var(--muted)}
.tfnotice{margin:0;padding:0 12px 5px}
.tfroute.compact{grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);gap:6px}
.compact .tfcode{font-size:22px}
.compact .tftime{font-size:12px}
.compact .tfday{font-size:10px}
.tfconn-risk{font-size:11px;font-weight:400}
.tleg{padding:14px;border-radius:18px;background:var(--card-2)}
.tleg>.tfroute{margin-bottom:12px}
.tleg .box{background:var(--card);padding:10px}
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
.tnext-label{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.tnext-action{font-size:15px;font-weight:700;color:var(--brand);margin-top:16px;min-height:28px}
.timport-note{font-size:13px;margin-top:14px!important}
.tcal-line{font-size:13px;color:var(--muted);min-width:0}
.tcal-line.warn{color:var(--l2);font-weight:600}
.ttab-empty .tempty{width:38px;height:38px;fill:currentColor}
@media (max-width:380px){.troute .tc{font-size:34px}.troute.big .tc{font-size:38px}}
`;

function setEnabled(on) {
  on = on === true && enabled();
  if (on === active) return;
  active = on;
  if (on) {
    S.manual = loadManual(); S.connection = T.name ? null : loadConnection();
    S.connectionAt = 0;
    refreshTimer = setInterval(() => { if (!document.hidden) refreshConnection(); }, MIN);
    render();
  } else {
    clearInterval(refreshTimer); refreshTimer = null;
    ++S.connectSeq; ++S.importSeq; ++calSeq;
    for (const ctl of requests) ctl.abort();
    requests.clear(); S.loading = null; S.connectionLoading = null; S.calAt = 0;
    if (S.view) closeTrip();
    S.importDraft = null; S.connectText = ""; S.connectBusy = false; S.importBusy = false;
    render();
  }
}
function init() {
  if (!document.getElementById("awx-trips-css")) document.head.append(h("style", { id: "awx-trips-css" }, CSS));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !S.view) return;
    if (e.target && e.target.getAttribute && e.target.getAttribute("aria-expanded") === "true") return; // the search list closes first
    e.stopImmediatePropagation(); // the airport sheet underneath stays open
    closeTrip();
  }, true);
  window.addEventListener("storage", (e) => { if (!enabled()) return; if (e.key === CALENDAR_KEY) { S.connection = T.name ? null : loadConnection(); S.connectSeq++; S.connectionAt = 0; S.connectionFailed = false; render(); } if (e.key === KEY) { S.manual = loadManual(); render(); } });
  window.AWXTrips = {
    hasTodayFlight: () => !!todayFlight(), openTodayBrief,
    setEnabled, render, decorateSheet, liveIds, todayAirportIds, openTrip, openEdit, openSettings: openTripSettings,
    // site/settings.js (Settings → Trips & flight calendar) and site/nav.js (Trips tab)
    openAdd: () => openEdit(null), openImport, openConnect,
    calStatus,
    ready: () => (S.loading || (S.calAt ? Promise.resolve() : loadCal(true))),
    list: () => (enabled() ? S.manual : []).map((t) => ({ id: t.id, from: t.legs[0].from, to: t.legs[t.legs.length - 1].to, dep: t.legs[0].dep, name: t.legs.length > 1 ? "via " + t.legs.slice(1).map((l) => l.from).join(", ") : "" })),
    routes: () => allTrips().flatMap((t) => t.legs.map((l) => ({ from: l.from, to: l.to }))),
    _state: () => ({ cal: S.cal, manual: S.manual, trips: allTrips().map((t) => ({ id: t.id, source: t.source, ...resultOf(t) })) }),
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshConnection(); });
  setEnabled(enabled());
}

init();
