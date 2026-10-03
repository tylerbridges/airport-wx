// Settings: a full-height sheet with a navigation stack (pages push and pop with a slide and a
// back chevron), drawn as an iOS grouped inset list. Every value reads and writes site/prefs.js
// (AWXPrefs) and applies at once. Pages: root (mode, disruption toggles, display, about),
// "airports" (reorder / remove / add favourites, the same awx-favs list app.js uses, through
// AWXApp.setFavs), "trips" (flight calendar status from data/trips.json, how to connect it, manual
// trips from site/trips.js when present) and "data" (build time, live relay, sources, checks).
import { h, icon, prefs, reducedMotion, trapFocus, app, appVersion } from "./navui.js";
import { loadAirports, airportsLoaded } from "./search.js";

const GH = "https://github.com/tylerbridges/airport-wx";
const SECRETS_URL = GH + "/settings/secrets/actions";
// Disruption categories: keys from prefs.js CATEGORIES, labels from site/cats.js (AWXCats.LABELS, the same table
// app.js filters with), so every switch drives the page's filtering. Fallback labels if cats.js is missing.
const CAT_FALLBACK = {
  storms: "Thunderstorms", winter: "Winter weather", wind: "Wind", fog: "Low clouds & fog", heat: "Heat",
  faa: "FAA delay programs & ground stops", atc: "ATC staffing & equipment", runways: "Runway closures",
  vip: "VIP / security restrictions", space: "Space launches", tstm: "General thunderstorm info",
};
const CAT_LABELS = new Proxy({}, { get: (t, k) => (window.AWXCats && window.AWXCats.LABELS && window.AWXCats.LABELS[k]) || CAT_FALLBACK[k] });
const catKeys = () => (P().CATEGORIES || (window.AWXCats && window.AWXCats.KEYS) || Object.keys((P().DEFAULTS && P().DEFAULTS.show) || CAT_FALLBACK));
const SOURCES = [
  ["FAA NAS Status", "Ground stops, delay programs and closures", ["faa"]],
  ["FAA Command Center", "Advisories and the daily operations plan", ["atcscc"]],
  ["aviationweather.gov", "Airport reports, forecasts and storm advisories", ["metar", "taf", "sigmet", "tcf", "cwa"]],
  ["National Weather Service", "Warnings and advisories", ["nws"]],
  ["Storm Prediction Center", "Severe storm outlook", ["spc"]],
  ["NOAA LAMP", "Hourly thunder, wind and cloud guidance", ["lamp"]],
  ["Bureau of Transportation Statistics", "On-time history for delay chances", []],
];

let ctx = { openSearch: null, onToggle: () => {} };
let wrap, sheet, live, untrap = null, returnTo = null, isOpen = false;
const stack = []; // [{name, el, refresh}]

export function initSettings(c) { ctx = Object.assign(ctx, c || {}); }
export const settingsOpen = () => isOpen;

// ---------- controls ----------

const P = () => prefs();
const say = (msg) => { if (live) { live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 30); } };

function group(title, rows, foot, attrs) {
  return h("section", Object.assign({ class: "awx-grp" }, attrs || {}),
    title ? (title.nodeType ? title : h("h3", { class: "awx-gh" }, title)) : null,
    h("div", { class: "awx-list" }, rows),
    foot ? h("div", { class: "awx-foot" }, foot) : null);
}

/** Segmented control (radiogroup); arrows move the choice. */
function seg(label, opts, value, onSet, cls) {
  const btns = opts.map(([v, t]) => h("button", {
    type: "button", role: "radio", "data-v": String(v), "aria-checked": String(String(v) === String(value)),
    tabindex: String(v) === String(value) ? "0" : "-1", onclick: () => pick(String(v)),
  }, t));
  function pick(v) {
    btns.forEach((b) => { const on = b.dataset.v === v; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
    onSet(v);
  }
  const g = h("div", { class: "awx-sseg" + (cls ? " " + cls : ""), role: "radiogroup", "aria-label": label }, btns);
  g.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement);
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d || i < 0) return;
    e.preventDefault();
    const b = btns[(i + d + btns.length) % btns.length];
    pick(b.dataset.v);
    b.focus();
  });
  return g;
}

function switchRow(key, label, on, onSet, sub) {
  const id = "awxsw-" + key;
  const sw = h("button", { type: "button", role: "switch", class: "awx-switch", "aria-checked": String(!!on), "aria-labelledby": id, "data-key": key,
    onclick: (e) => { e.stopPropagation(); flip(); } }, h("span", { class: "awx-knob" }));
  function flip() {
    const v = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(v));
    onSet(v);
  }
  return h("div", { class: "awx-row awx-click", onclick: flip },
    h("span", { class: "awx-rt" }, h("span", { id }, label), sub ? h("small", {}, sub) : null), sw);
}

function navRow(ico, label, value, onclick, attrs) {
  return h("button", Object.assign({ type: "button", class: "awx-row awx-nrow", onclick }, attrs || {}),
    ico ? h("span", { class: "awx-ri" }, icon(ico)) : null,
    h("span", { class: "awx-rt" }, label),
    value != null ? h("span", { class: "awx-rv" }, value) : null,
    icon("chevR", "awx-chev"));
}
function linkRow(ico, label, href, ext) {
  return h("a", Object.assign({ class: "awx-row awx-nrow", href }, ext ? { target: "_blank", rel: "noopener" } : {}),
    ico ? h("span", { class: "awx-ri" }, icon(ico)) : null,
    h("span", { class: "awx-rt" }, label),
    icon(ext ? "ext" : "chevR", "awx-chev"));
}
function valueRow(label, value, attrs) {
  return h("div", Object.assign({ class: "awx-row" }, attrs || {}), h("span", { class: "awx-rt" }, label), h("span", { class: "awx-rv" }, value));
}
/** A one-of list with checkmarks (role radio). */
function checkList(label, opts, value, onSet) {
  const rows = opts.map(([v, t]) => h("button", { type: "button", role: "radio", class: "awx-row awx-crow", "data-v": v, "aria-checked": String(v === value),
    onclick: () => { rows.forEach((r) => r.setAttribute("aria-checked", String(r.dataset.v === v))); onSet(v); } },
  h("span", { class: "awx-rt" }, t), icon("check", "awx-tick")));
  return h("div", { role: "radiogroup", "aria-label": label, class: "awx-rg" }, rows);
}

// ---------- formatting ----------

function when(ms) {
  if (!Number.isFinite(ms)) return "—";
  const p = P().getPrefs();
  const today = new Date(ms).toDateString() === new Date().toDateString();
  const t = new Intl.DateTimeFormat("en-US", Object.assign({ hour: "numeric", minute: "2-digit", hour12: String(p.clock) !== "24" }, today ? {} : { month: "short", day: "numeric" })).format(ms).replace(/[\u202f\u00a0]/g, " ");
  const m = Math.max(0, Math.round((Date.now() - ms) / 60e3));
  return t + " · " + (m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.floor(m / 60) + " hr ago" : Math.floor(m / 1440) + " d ago");
}

async function getJson(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json(), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, status: 0 };
  } finally { clearTimeout(timer); }
}

// ---------- pages ----------

const PAGES = {
  root: { title: "Settings", build: buildRoot },
  airports: { title: "Your airports", build: buildAirports },
  trips: { title: "Trips & flight calendar", build: buildTrips },
  data: { title: "Data & checks", build: buildData },
};

function buildRoot(body) {
  const p = P().getPrefs();
  const set = (k) => (v) => P().setPref(k, v);
  const favs = (app() && app().state.favs) || [];
  const keys = catKeys();
  const show = p.show || {};
  body.replaceChildren(
    group("Mode", [h("div", { class: "awx-row awx-wide" }, seg("Mode", [["traveler", "Traveler"], ["aviation", "Aviation"]], p.mode, set("mode"), "awx-mode"))],
      h("div", { class: "awx-modeexp" },
        h("span", {}, "Plain-English impacts"),
        h("span", {}, "Adds METAR, TAF, codes"))),
    group(null, [
      navRow("star", "Your airports", String(favs.length), () => push("airports"), { "data-page": "airports" }),
      navRow("calendar", "Trips & flight calendar", null, () => push("trips"), { "data-page": "trips" }),
    ]),
    group("Show these disruptions", [
      ...keys.map((k) => switchRow(k, CAT_LABELS[k] || k[0].toUpperCase() + k.slice(1), show[k] !== false,
        (v) => { P().setPref("show", Object.assign({}, P().getPrefs().show, { [k]: v })); say((CAT_LABELS[k] || k) + (v ? " shown" : " hidden")); })),
      h("div", { class: "awx-row awx-off", "aria-disabled": "true" }, h("span", { class: "awx-rt" }, "Ground stops & airport closures"), h("span", { class: "awx-rv" }, "Always shown")),
    ], "Ground stops and full airport closures are always shown, whatever you turn off here."),
    group("Display", [
      h("div", { class: "awx-row awx-split" }, h("span", { class: "awx-rt" }, "Appearance"), seg("Appearance", [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]], p.theme, set("theme"))),
      h("div", { class: "awx-row awx-split" }, h("span", { class: "awx-rt" }, "Clock"), seg("Clock", [["12", "12-hour"], ["24", "24-hour"]], String(p.clock), set("clock"))),
      h("div", { class: "awx-row awx-split" }, h("span", { class: "awx-rt" }, "Airport codes"), seg("Airport codes", [["iata", "IATA"], ["icao", "ICAO"]], p.codes, set("codes"))),
    ]),
    group("Times", [checkList("Times", [["airport", "Each airport's local time"], ["mine", "My time zone"]], p.timeRef, set("timeRef"))],
      "Forecast hours, delays and timelines use this time zone."),
    group(null, [navRow("pulse", "Data & checks", null, () => push("data"), { "data-page": "data" })]),
    group("About", [valueRow("Version", appVersion())],
      "Your airports and settings stay on this device. Trips publish only airports and flight times, never names or booking details."),
  );
}

// ----- Your airports -----

function airportInfo(code) {
  const m = ((app() && app().state.data && app().state.data.airports) || []).find((a) => a.iata === code);
  if (m) return { where: [m.city, m.state].filter(Boolean).join(", "), name: m.name };
  const a = (airportsLoaded() || []).find((x) => x.code === code);
  if (a) return { where: [a.city, a.country === "US" ? a.state : a.country].filter(Boolean).join(", "), name: a.name };
  return null;
}
function setFavs(list) {
  const A = app();
  if (A && A.setFavs) A.setFavs(list);
  else if (A) { A.state.favs.splice(0, A.state.favs.length, ...list); A.render(); }
}
let editing = false;
function buildAirports(body, page) {
  const favs = ((app() && app().state.favs) || []).slice();
  if (!airportsLoaded() && favs.some((c) => !airportInfo(c))) loadAirports().then(() => page.refresh()).catch(() => {});
  const remove = (code) => { setFavs(((app() && app().state.favs) || []).filter((c) => c !== code)); say(code + " removed"); page.refresh(); };
  const list = h("ul", { class: "awx-favs", "aria-label": "Your airports, in order" }, favs.map((code, i) => {
    const info = airportInfo(code);
    return h("li", { class: "awx-fav", "data-code": code },
      h("div", { class: "awx-fav-act" }, h("button", { type: "button", class: "awx-del", tabindex: "-1", "aria-hidden": "true", onclick: () => remove(code) }, "Delete")),
      h("div", { class: "awx-fav-row" },
        editing ? h("button", { type: "button", class: "awx-minus", "aria-label": "Remove " + code, onclick: () => remove(code) }, icon("minus")) : null,
        h("span", { class: "awx-fav-code" }, code),
        h("span", { class: "awx-fav-t" }, h("b", {}, info ? info.where || info.name : code), info && info.where ? h("span", {}, info.name) : null),
        h("button", { type: "button", class: "awx-grip", "aria-label": `Reorder ${code}, position ${i + 1} of ${favs.length}. Use the up and down arrow keys.` }, icon("grip"))));
  }));
  wireReorder(list);
  wireSwipe(list);
  const head = h("div", { class: "awx-gh awx-gh2" }, h("h3", {}, "Airports"),
    favs.length ? h("button", { type: "button", class: "awx-txtbtn", "aria-pressed": String(editing), onclick: () => { editing = !editing; page.refresh(); } }, editing ? "Done" : "Edit") : null);
  body.replaceChildren(
    group(head, favs.length ? [list] : [h("div", { class: "awx-row awx-off" }, "No airports yet")],
      favs.length ? "Drag the handle to change the order. Swipe left on an airport, or tap Edit, to remove it." : null),
    group(null, [h("button", { type: "button", class: "awx-row awx-nrow awx-accent", "data-act": "add",
      onclick: () => ctx.openSearch && ctx.openSearch({ title: "Add airport", onPick: (a) => {
        const cur = ((app() && app().state.favs) || []);
        if (!cur.includes(a.code)) setFavs([...cur, a.code]);
        say(a.code + " added");
        page.refresh();
      }, onFavs: () => page.refresh() }) },
    h("span", { class: "awx-ri" }, icon("plus")), h("span", { class: "awx-rt" }, "Add airport"))]),
  );
}
const order = (list) => [...list.querySelectorAll("li.awx-fav")].map((li) => li.dataset.code);

/** Drag the grip (pointer events) to reorder; arrow keys on the grip do the same. */
function wireReorder(list) {
  list.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".awx-grip");
    if (!grip || e.button > 0) return;
    e.preventDefault();
    const li = grip.closest("li");
    const startY = e.clientY;
    const top0 = li.offsetTop;
    const max = list.offsetHeight - li.offsetHeight;
    const before = order(list).join();
    li.classList.add("drag");
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const move = (ev) => {
      const want = Math.max(0, Math.min(max, top0 + ev.clientY - startY));
      const mid = want + li.offsetHeight / 2;
      let n;
      while ((n = li.nextElementSibling) && mid > n.offsetTop + n.offsetHeight / 2) n.after(li);
      while ((n = li.previousElementSibling) && mid < n.offsetTop + n.offsetHeight / 2) n.before(li);
      li.style.transform = `translateY(${want - li.offsetTop}px)`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      li.classList.remove("drag");
      li.style.transform = "";
      const now = order(list);
      if (now.join() !== before) { setFavs(now); say(`${li.dataset.code} moved to position ${now.indexOf(li.dataset.code) + 1} of ${now.length}`); refreshGrips(list); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  list.addEventListener("keydown", (e) => {
    const grip = e.target.closest(".awx-grip");
    if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const li = grip.closest("li");
    const n = e.key === "ArrowUp" ? li.previousElementSibling : li.nextElementSibling;
    if (!n) return;
    if (e.key === "ArrowUp") n.before(li); else n.after(li);
    grip.focus();
    const now = order(list);
    setFavs(now);
    refreshGrips(list);
    say(`${li.dataset.code} moved to position ${now.indexOf(li.dataset.code) + 1} of ${now.length}`);
  });
}
function refreshGrips(list) {
  const lis = [...list.querySelectorAll("li.awx-fav")];
  lis.forEach((li, i) => li.querySelector(".awx-grip").setAttribute("aria-label", `Reorder ${li.dataset.code}, position ${i + 1} of ${lis.length}. Use the up and down arrow keys.`));
}

/** Swipe a row left to reveal Delete. */
function wireSwipe(list) {
  const close = (except) => list.querySelectorAll("li.open").forEach((li) => { if (li !== except) setOpen(li, false); });
  const setOpen = (li, on) => {
    li.classList.toggle("open", on);
    const d = li.querySelector(".awx-del");
    d.tabIndex = on ? 0 : -1;
    if (on) d.removeAttribute("aria-hidden"); else d.setAttribute("aria-hidden", "true");
  };
  list.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || e.button > 0) return;
    const li = e.target.closest("li.awx-fav");
    if (!li) return;
    const row = li.querySelector(".awx-fav-row");
    const x0 = e.clientX, y0 = e.clientY;
    const base = li.classList.contains("open") ? -88 : 0;
    let on = false, dx = 0;
    const move = (ev) => {
      dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!on) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { on = true; close(li); row.style.transition = "none"; }
        else if (Math.abs(dy) > 10) { end(); return; }
        else return;
      }
      row.style.transform = `translateX(${Math.min(0, Math.max(-130, base + dx))}px)`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!on) { if (base) setOpen(li, false); return; }
      row.style.transition = "";
      row.style.transform = "";
      setOpen(li, base + dx < -44);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}

// ----- Trips & flight calendar -----

/** Upcoming flights in data/trips.json (Build 4); tolerant of the exact shape. */
export function upcomingFlights(j, now = Date.now()) {
  if (j && Number.isFinite(j.upcoming)) return j.upcoming;
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") { if (Array.isArray(x.flights)) walk(x.flights); else out.push(x); }
  };
  walk((j && (j.flights || j.trips || j.items || j.events)) || []);
  return out.filter((f) => {
    const t = Date.parse(f.dep || f.depart || f.departure || f.depTime || f.start || f.time || f.date || "");
    const e = Date.parse(f.arr || f.arrive || f.arrival || f.arrTime || f.end || "");
    return !Number.isFinite(t) || (Number.isFinite(e) ? e : t + 6 * 3600e3) >= now;
  }).length;
}
function manualTrips() {
  const T = window.AWXTrips;
  if (T && typeof T.list === "function") { try { return T.list() || []; } catch { return []; } }
  try { const v = JSON.parse(localStorage.getItem("awx-trips") || "[]"); return Array.isArray(v) ? v : Array.isArray(v && v.trips) ? v.trips : []; } catch { return []; }
}
function tripLabel(t, i) {
  const f = (t && Array.isArray(t.flights) && t.flights[0]) || t || {};
  const code = (x) => (typeof x === "string" ? x : x && (x.iata || x.code || x.icao)) || "";
  const from = code(f.from || f.origin || f.dep_airport), to = code(f.to || f.dest || f.destination || f.arr_airport);
  const ms = Date.parse(f.dep || f.depart || f.departure || f.date || f.start || "");
  const name = (t && (t.name || t.title)) || [f.airline, f.flight || f.number].filter(Boolean).join(" ");
  return {
    title: from && to ? `${from} → ${to}` : name || "Trip " + (i + 1),
    sub: [from && to ? name : "", Number.isFinite(ms) ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(ms) : ""].filter(Boolean).join(" · "),
  };
}
function buildTrips(body, page, opts) {
  const status = valueRow("Status", "Checking…", { "data-id": "calstatus" });
  const steps = h("ol", { class: "awx-steps" },
    h("li", {}, "In your flight app, turn on calendar sync to a dedicated calendar (only flights go in it)."),
    h("li", {}, "In Calendar, share that calendar as a public calendar."),
    h("li", {}, "Copy the calendar's public link."),
    h("li", {}, "On GitHub, add the link as a repository secret named ", h("code", {}, "FLIGHTY_ICS_URL"), ". The next update reads it."));
  const trips = manualTrips();
  const T = window.AWXTrips;
  const canAdd = !!(T && typeof T.openAdd === "function");
  const addRow = h("button", { type: "button", class: "awx-row awx-nrow awx-accent", "data-act": "add", disabled: !canAdd,
    onclick: () => { close(false); T.openAdd(); } }, h("span", { class: "awx-ri" }, icon("plus")), h("span", { class: "awx-rt" }, "Add a trip"));
  body.replaceChildren(
    group("Flight calendar", [status]),
    group("Connect your flight calendar", [h("div", { class: "awx-row awx-block" }, steps), linkRow(null, "Open GitHub secrets", SECRETS_URL, true)],
      "The secret stays private on GitHub. Only airports and flight times are published to this site.", { id: "awx-connect" }),
    group("Your trips", [
      ...trips.map((t, i) => { const l = tripLabel(t, i); return h("div", { class: "awx-row" }, h("span", { class: "awx-ri" }, icon("plane")), h("span", { class: "awx-rt" }, l.title, l.sub ? h("small", {}, l.sub) : null)); }),
      trips.length ? null : h("div", { class: "awx-row awx-off" }, "No trips added on this device"),
      addRow,
    ].filter(Boolean), canAdd ? null : "Adding trips by hand isn't available yet.", { id: "awx-addtrip" }),
  );
  // data/trips.json comes with site/trips.js (Build 4); without it there is nothing to read (and no 404 to log)
  (T ? getJson("./data/trips.json") : Promise.resolve({ ok: false })).then((r) => {
    const v = status.querySelector(".awx-rv");
    const connected = r.ok && r.data && r.data.connected !== false && !r.data.error;
    v.textContent = connected ? `Connected · ${upcomingFlights(r.data)} upcoming flight${upcomingFlights(r.data) === 1 ? "" : "s"}` : "Not connected";
    v.classList.toggle("awx-good", !!connected);
  });
  if (opts && opts.focus) setTimeout(() => { const el = body.querySelector(opts.focus === "add" ? "#awx-addtrip" : "#awx-connect"); if (el) el.scrollIntoView({ block: "start" }); }, 0);
}

// ----- Data & checks -----

function buildData(body) {
  const A = app();
  const st = (A && A.state) || {};
  const build = st.build || st.data;
  const test = window.AWXTest && window.AWXTest.name;
  const buildText = test ? "Test scenario (not live)" : st.sample ? "Sample data (no live build yet)" : build ? when(Date.parse(build.generated)) : st.loaded ? "Couldn't load" : "Loading…";
  const relay = valueRow("Live relay", "Checking…", { "data-id": "relay" });
  const src = (st.data && st.data.sources) || {};
  const srcRows = SOURCES.map(([name, what, keys]) => {
    const have = keys.filter((k) => src[k]);
    const down = have.filter((k) => !src[k].ok).length;
    const part = have.filter((k) => src[k].ok && src[k].error).length;
    const stat = !keys.length ? ["History", ""] : !have.length ? ["—", ""] : down === have.length ? ["Unavailable", "awx-bad"] : down || part ? ["Partly unavailable", "awx-warn"] : ["OK", "awx-good"];
    return h("div", { class: "awx-row" }, h("span", { class: "awx-rt" }, name, h("small", {}, what)), h("span", { class: "awx-rv " + stat[1] }, stat[0]));
  });
  body.replaceChildren(
    group("Data", [valueRow("Last data build", buildText), relay],
      "The build runs every few minutes; the live relay adds fresher weather and FAA data on top when it's set up."),
    group("Sources", srcRows),
    group(null, [linkRow("pulse", "Run checks", "check.html"), linkRow("ext", "Roadmap on GitHub", GH + "/blob/main/ROADMAP.md", true)]),
  );
  (async () => {
    const v = relay.querySelector(".awx-rv");
    const c = await getJson("./data/config.json");
    const url = c.ok && c.data && typeof c.data.liveUrl === "string" && /^https?:\/\//.test(c.data.liveUrl) ? c.data.liveUrl.replace(/\/+$/, "") : null;
    if (!url) { v.textContent = "Not set up"; return; }
    const hl = await getJson(url + "/health");
    v.textContent = hl.ok && hl.data && hl.data.ok ? `Online · ${hl.ms} ms` : "Not responding";
    v.classList.add(hl.ok && hl.data && hl.data.ok ? "awx-good" : "awx-bad");
  })();
}

// ---------- sheet + stack ----------

function build() {
  live = h("div", { class: "awx-vh", "aria-live": "polite" });
  sheet = h("div", { class: "awx-set", id: "navSettings", role: "dialog", "aria-modal": "true", "aria-label": "Settings" }, live);
  wrap = h("div", { class: "awx-set-wrap", hidden: true }, h("div", { class: "awx-set-bd", onclick: () => close() }), sheet);
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
  document.body.append(wrap);
  // build2b hook: drag the header (any page, any scroll position) or pull the content at the top to close the
  // whole sheet; back gesture; page scroll lock (site/sheet.js)
  sheetCtl = window.AWXSheet ? window.AWXSheet.makeSheet(sheet, {
    onClose: () => close(), header: ".awx-ph", backdrop: wrap.querySelector(".awx-set-bd"), noPull: ".awx-favs",
    scroller: (t) => (t.closest && t.closest(".awx-pb")) || (stack.length ? stack[stack.length - 1].el.querySelector(".awx-pb") : sheet),
  }) : null;
}
let sheetCtl = null;

function makePage(name, opts) {
  const def = PAGES[name] || PAGES.root;
  const prev = stack[stack.length - 1];
  const tid = "awxpt-" + name;
  const body = h("div", { class: "awx-pbody" });
  const scroller = h("div", { class: "awx-pb" }, h("h2", { class: "awx-lt", id: tid }, def.title), body);
  const el = h("section", { class: "awx-page", "data-page": name, "aria-labelledby": tid },
    h("div", { class: "awx-ph" },
      prev ? h("button", { type: "button", class: "awx-back", "aria-label": "Back to " + PAGES[prev.name].title, onclick: () => pop() }, icon("chevL"), h("span", {}, PAGES[prev.name].title)) : h("span", {}),
      h("button", { type: "button", class: "awx-txtbtn awx-done", onclick: () => close() }, "Done")),
    scroller);
  const page = { name, el, refresh: () => { const y = scroller.scrollTop; def.build(body, page, null); scroller.scrollTop = y; } };
  def.build(body, page, opts);
  return page;
}

function push(name, opts, animate = true) {
  const page = makePage(name, opts);
  const prev = stack[stack.length - 1];
  stack.push(page);
  const anim = animate && prev && !reducedMotion();
  if (anim) page.el.classList.add("right");
  sheet.append(page.el);
  if (prev) {
    prev.el.setAttribute("inert", "");
    if (anim) { void page.el.offsetWidth; page.el.classList.remove("right"); }
    prev.el.classList.add("left");
  }
  const back = page.el.querySelector(".awx-back, .awx-done");
  if (isOpen) setTimeout(() => back && back.focus({ preventScroll: true }), anim ? 340 : 0);
}

function pop() {
  if (stack.length < 2) { close(); return; }
  const top = stack.pop();
  const prev = stack[stack.length - 1];
  prev.el.removeAttribute("inert");
  prev.el.classList.remove("left");
  prev.refresh();
  top.el.setAttribute("inert", "");
  if (reducedMotion()) top.el.remove();
  else { top.el.classList.add("right"); setTimeout(() => top.el.remove(), 340); }
  const b = prev.el.querySelector(`[data-page="${top.name}"]`) || prev.el.querySelector(".awx-back, .awx-done");
  if (b) b.focus({ preventScroll: true });
}

/** Opens Settings (root), or straight onto a page with Settings under it so Back leads there. */
export function openSettings(page, opts) {
  if (!wrap) build();
  if (isOpen) { if (page && PAGES[page]) push(page, opts); return; }
  returnTo = document.activeElement;
  stack.splice(0).forEach((p) => p.el.remove());
  editing = false;
  push("root", null, false);
  if (page && page !== "root" && PAGES[page]) push(page, opts, false);
  isOpen = true;
  wrap.hidden = false;
  document.documentElement.classList.add("awx-lock");
  if (sheetCtl) sheetCtl.opened(); // build2b hook
  void wrap.offsetWidth;
  wrap.classList.add("open");
  untrap = trapFocus(sheet);
  const top = stack[stack.length - 1].el;
  (top.querySelector(".awx-back") || top.querySelector(".awx-done")).focus({ preventScroll: true });
  ctx.onToggle(true);
}

export function close(returnFocus = true) {
  if (!isOpen) return;
  isOpen = false;
  wrap.classList.remove("open");
  document.documentElement.classList.remove("awx-lock");
  if (sheetCtl) sheetCtl.closed(); // build2b hook
  if (untrap) untrap();
  const done = () => { if (!isOpen) { wrap.hidden = true; stack.splice(0).forEach((p) => p.el.remove()); ctx.onToggle(false); } };
  if (reducedMotion()) done(); else setTimeout(done, 320);
  if (returnFocus && returnTo && returnTo.focus) returnTo.focus({ preventScroll: true });
}
export { close as closeSettings };
