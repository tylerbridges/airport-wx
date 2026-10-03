// Search + cards for airports outside the curated majors. Loaded as a module after app.js;
// talks to it only through window.AWXApp ({state, openSheet, toggleFav, render}) and is called
// back by app.js's render() (window.AWXExtra.render).
//
// Picking an airport:
//   - a major (in status.json): opens its normal detail sheet;
//   - anything else: a card above the list built from the global shard data/wx/<letter>.json
//     (METAR now + TAF hourly levels, no FAA/NWS/SPC), with a note saying what isn't covered;
//   - no METAR/TAF at all: a card saying so, linking the nearest airport that has reports.
// Starred non-major airports (same "awx-favs" list as the majors) show on "My airports".
import { mountSearch, loadAirports, airportsLoaded, nearest, placeLine, US_AREAS } from "./search.js";

const LEVELS = ["Clear", "Minor", "Moderate", "High", "Severe"];
const PICK_KEY = "awx-picked";
const SHARD_TTL = 120e3;
const STALE_MS = 30 * 60e3;
const HOUR = 3600e3;

const T = window.AWXTest || { name: null, wxBase: "./data/wx/", rebase: (d) => d };
const app = () => window.AWXApp;
const shards = new Map(); // letter -> {at, data | null, error}
let wxIndex = null; // data/wx/index.json (source status of the global run)
let picked = loadPicked();
const open = new Set(); // codes whose details are expanded

function loadPicked() {
  try { return sessionStorage.getItem(PICK_KEY) || null; } catch { return null; }
}
function savePicked() {
  try { if (picked) sessionStorage.setItem(PICK_KEY, picked); else sessionStorage.removeItem(PICK_KEY); } catch { /* ignore */ }
}

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
const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));
const tidy = (s) => s.replace(/[  ]/g, " ");
function fmt(ms, tz, opts) {
  try { return tidy(new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", ...opts }).format(ms)); } catch { return tidy(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(ms)); }
}
const hourLabel = (ms, tz) => fmt(ms, tz, { hour: "numeric", hour12: true });
const clock = (ms, tz) => fmt(ms, tz, { hour: "numeric", minute: "2-digit", hour12: true }).replace(":00 ", " ");
function tzName(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", timeZoneName: "short" }).formatToParts(ms).find((x) => x.type === "timeZoneName");
    return p ? p.value : "UTC";
  } catch { return "UTC"; }
}
function ago(ms) {
  const m = Math.floor(ms / 60e3);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? hrs + " hr " + (m % 60) + " min ago" : Math.floor(hrs / 24) + " d ago";
}

// ---------- data ----------

const majorCodes = () => new Set(((app() && app().state.data && app().state.data.airports) || []).map((a) => a.iata));
const isMajor = (code) => majorCodes().has(code);
const byCode = (code) => (airportsLoaded() || []).find((a) => a.code === code) || null;

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}

/** Waits until app.js has its status data (test mode needs it for the time shift). */
function appReady() {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => (app() && app().state.loaded) || Date.now() - t0 > 8000 ? res() : setTimeout(tick, 50);
    tick();
  });
}

async function shardFor(icao) {
  const k = /^[A-Z0-9]/i.test(icao) ? icao[0].toUpperCase() : "_";
  const s = shards.get(k);
  if (s && (s.loading || Date.now() - s.at < SHARD_TTL)) return s.loading || s;
  const entry = { at: Date.now(), data: null, error: null };
  entry.loading = (async () => {
    await appReady();
    try {
      if (!wxIndex || Date.now() - wxIndex._at > SHARD_TTL) {
        try { wxIndex = { ...T.rebase(await getJson(T.wxBase + "index.json")), _at: Date.now() }; } catch { wxIndex = { ok: false, error: "no index", _at: Date.now() }; }
      }
      // letters with no airport aren't written; don't request them (a 404 is a console error)
      if (wxIndex.ok && Array.isArray(wxIndex.letters) && !wxIndex.letters.includes(k)) entry.data = { a: {}, generated: wxIndex.generated };
      else entry.data = T.rebase(await getJson(T.wxBase + k + ".json"));
    } catch (e) {
      // 404 = no airport with reports under this letter (when the global run itself succeeded)
      entry.error = e.status === 404 && wxIndex && wxIndex.ok ? null : "load";
      entry.data = entry.error ? null : { a: {}, generated: wxIndex.generated };
    }
    entry.at = Date.now();
    delete entry.loading;
    shards.set(k, entry);
    return entry;
  })();
  shards.set(k, entry);
  return entry.loading;
}

// ---------- cards ----------

function timeline(e, h0, tz) {
  const t0 = Date.parse(h0);
  const levels = String(e.h || "").split("").map((c) => (c === "-" ? null : Number(c)));
  const frac = Math.max(0, Math.min(1, (Date.now() - t0) / (levels.length * HOUR)));
  const segs = levels.map((l) => h("span", { class: l == null ? "s nd" : "s " + lv(l) }));
  const tl = h("div", { class: "tl", role: "img", "aria-label": `Next 24 hours: peak ${LEVELS[e.p] || "Clear"}` }, segs,
    h("span", { class: "nowm", style: `left:${(frac * 100).toFixed(2)}%` }));
  const ticks = h("div", { class: "ticks", "aria-hidden": "true" });
  for (let i = 0; i < levels.length; i += 6) ticks.append(h("span", { style: `left:${(i / levels.length) * 100}%` }, i === 0 ? "Now" : hourLabel(t0 + i * HOUR, tz)));
  ticks.append(h("span", { class: "tz" }, tzName(t0, tz)));
  return h("div", { class: "tl-wrap" }, tl, ticks);
}

function scopeNote(a) {
  return US_AREAS.includes(a.country)
    ? "Weather forecast only — FAA programs and alerts shown for major airports"
    : "Weather only — FAA/NWS data covers U.S. airports";
}

function starBtn(code) {
  const favs = (app() && app().state.favs) || [];
  const fav = favs.includes(code);
  return h("button", {
    type: "button", class: "star", "aria-pressed": String(fav), "aria-label": (fav ? "Remove " : "Add ") + code + (fav ? " from" : " to") + " my airports",
    onclick: (ev) => { ev.stopPropagation(); app().toggleFav(code); },
  }, starSvg());
}

function shell(a, kids, { dismiss } = {}) {
  return h("div", { class: "card xcard", "data-code": a.code },
    h("div", { class: "top" },
      h("div", { class: "code" }, a.code),
      h("div", { class: "right" }, ...kids.right, starBtn(a.code),
        dismiss ? h("button", { type: "button", class: "star xclose", "aria-label": "Close " + a.code, onclick: (ev) => { ev.stopPropagation(); dismiss(); } }, "×") : null)),
    a.name ? h("div", { class: "aname" }, a.name) : null,
    placeLine(a) ? h("div", { class: "where" }, placeLine(a)) : null,
    ...kids.body);
}

function card(a, shard, opts) {
  const tz = a.tz || "UTC";
  if (!shard || shard.error) {
    return shell(a, { right: [], body: [
      h("div", { class: "reason crit" }, "Weather data couldn't load right now"),
      h("div", { class: "sub" }, "Try again in a few minutes. " + scopeNote(a)),
    ] }, opts);
  }
  const lw = (app().state.liveWx || {})[a.icao]; // live relay: fresher entry from the Worker when there is one
  const e = lw || shard.data.a[a.icao];
  if (!e) {
    const list = airportsLoaded() || [];
    const near = nearest(a, list, (x) => x.hasMetar);
    return shell(a, { right: [], body: [
      h("div", { class: "reason" }, "No weather reports from this airport — check the nearest major airport"),
      near ? h("button", { type: "button", class: "xnear", onclick: (ev) => { ev.stopPropagation(); pick(near.airport); } },
        `Nearest with reports: ${near.airport.code} · ${placeLine(near.airport) || near.airport.name} (${Math.round(near.miles)} mi)`) : null,
    ] }, opts);
  }
  const genMs = lw ? Date.parse(app().state.data.live) : Date.parse(shard.data.generated); // live relay
  const stale = Number.isFinite(genMs) && Date.now() - genMs > STALE_MS;
  const expanded = open.has(a.code);
  const reason = e.r || e.pl || (e.p ? "Elevated risk" : "No significant weather");
  const details = expanded ? h("div", { class: "xdet" },
    e.pl ? h("div", {}, h("b", {}, "Now: "), e.pl) : h("div", { class: "muted" }, "No recent observation (METAR)"),
    e.im ? h("div", {}, h("b", {}, "What it means: "), e.im) : null,
    e.mt ? h("div", { class: "muted small" }, "Observed " + ago(Math.max(0, Date.now() - Date.parse(e.mt))) + " · " + clock(Date.parse(e.mt), tz) + " " + tzName(Date.parse(e.mt), tz)) : null,
    e.m ? h("pre", { class: "raw" }, e.m) : null,
    e.t ? h("pre", { class: "raw" }, e.t) : h("div", { class: "muted small" }, "No TAF (forecast) issued for this airport"),
  ) : null;
  return shell(a, { right: [h("span", { class: "pill " + lv(e.p) }, LEVELS[e.p] || "Clear")], body: [
    h("div", { class: "reason" }, reason),
    e.n !== e.p ? h("div", { class: "sub" }, "Now: " + (LEVELS[e.n] || "Clear")) : null,
    timeline(e, (lw && app().state.liveH0) || shard.data.h0 || e.pt, tz),
    h("div", { class: "sub xnote" }, scopeNote(a)),
    stale ? h("div", { class: "sub crit" }, "Weather data updated " + ago(Date.now() - genMs)) : null,
    !e.t ? h("div", { class: "sub" }, "No forecast (TAF) for this airport — only current conditions are known (grey hours)") : null,
    details,
    h("button", { type: "button", class: "xmore", "aria-expanded": String(expanded), onclick: (ev) => { ev.stopPropagation(); if (open.has(a.code)) open.delete(a.code); else open.add(a.code); render(); } }, expanded ? "Hide details" : "Details"),
  ] }, opts);
}

// ---------- render ----------

let renderSeq = 0;
async function render() {
  const box = document.getElementById("extra");
  if (!box || !app()) return;
  const st = app().state;
  const majors = majorCodes();
  const favs = (st.favs || []).filter((c) => !majors.has(c));
  const codes = [];
  if (picked && !majors.has(picked)) codes.push(picked);
  if (st.filter === "mine") for (const c of favs) if (!codes.includes(c)) codes.push(c);
  const seq = ++renderSeq;
  if (!codes.length) { box.replaceChildren(); fixEmpty(false); return; }
  let list = airportsLoaded();
  if (!list) { try { list = await loadAirports(); } catch { list = []; } }
  const items = await Promise.all(codes.map(async (c) => {
    const a = (list || []).find((x) => x.code === c);
    if (!a) return null;
    return { a, shard: await shardFor(a.icao || a.code) };
  }));
  if (seq !== renderSeq) return;
  const cards = items.filter(Boolean).map(({ a, shard }) => card(a, shard, a.code === picked ? { dismiss: () => { picked = null; savePicked(); render(); } } : undefined));
  box.replaceChildren(...cards);
  fixEmpty(cards.length > 0 && st.filter === "mine");
}

/** app.js says "No saved airports yet" when none of the favourites is a major; hide that if we show starred cards. */
function fixEmpty(hasCards) {
  const empty = document.querySelector("#list > .empty");
  if (empty) empty.hidden = !!hasCards;
}

function pick(a) {
  if (isMajor(a.code)) { app().openSheet(a.code); return; }
  picked = a.code;
  savePicked();
  render().then(() => {
    const el = document.querySelector(`#extra .card[data-code="${a.code}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

const CSS = `
#extra{margin-bottom:12px}
#extra:empty{display:none}
.xcard .tl .s.nd{background:var(--line);opacity:1}
.xcard .xclose{font-size:24px;line-height:1;font-weight:400}
.xcard .xnote{margin-top:8px}
.xcard .crit{color:var(--crit)}
.xcard .xmore,.xcard .xnear{margin-top:10px;font-size:14px;font-weight:600;color:var(--l1);padding:6px 0}
.xcard .xnear{display:block;text-align:left}
.xcard .xdet{margin-top:10px;display:grid;gap:8px;font-size:14px}
.xfoot{margin:22px 4px 0;font-size:13px}
.xfoot a{color:var(--muted)}
`;

function init() {
  if (!document.getElementById("awx-extra-css")) document.head.append(h("style", { id: "awx-extra-css" }, CSS));
  const mount = document.getElementById("search");
  if (mount) {
    mountSearch(mount, {
      onPick: pick,
      getFavs: () => (app() && app().state.favs) || [],
      onToggleFav: (code) => app() && app().toggleFav(code),
    });
  }
  // live relay: picked + starred non-major airports for app.js's live call: [{icao, tz}]
  const liveIds = () => {
    const majors = majorCodes();
    const codes = [picked, ...(((app() && app().state.favs) || []))].filter((c) => c && !majors.has(c));
    return [...new Set(codes)].map(byCode).filter((a) => a && a.icao).map((a) => ({ icao: a.icao, tz: a.tz || null }));
  };
  window.AWXExtra = { render: () => { render(); }, pick, _shardFor: shardFor, liveIds };
  render();
}

init();
