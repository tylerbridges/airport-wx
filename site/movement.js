// Movement: "Traffic right now" from data/movement.json (written by poller/movement.mjs from
// community ADS-B feeds; README "Movement"). Nothing is computed here.
//   line(airport)   card line under the reason, only when it means something:
//                   departures index < 0.7 or > 1.3, coverage >= 0.6, a baseline, data under 20 min old
//   card(airport)   sheet card "Traffic right now" (.sec header + .card)
//   alerts()        airline alert banner for the top of the list; appended to #natstrip instead when
//                   that element exists (then returns null)
//   checkRow(add)   "Movement feed" row for check.html
//   SOURCES         feed list for Settings → Data & checks
// Loaded as a module by index.html; app.js calls it through window.AWXMovement ("movement hook").

const MIN = 60e3;
const FRESH_MS = 20 * MIN;

export const SOURCES = [
  {
    id: "adsbfi", name: "adsb.fi", role: "primary", url: "https://adsb.fi",
    what: "Aircraft positions near each airport, from community ADS-B receivers (departure/arrival rates, taxiing, holding)",
    api: "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}", docs: "https://github.com/adsbfi/opendata",
    terms: "Personal, non-commercial use only; 1 request per second; cite adsb.fi with a link to its home page.",
    attribution: "Aircraft positions: adsb.fi",
  },
  {
    id: "adsblol", name: "ADSB.lol", role: "fallback", url: "https://adsb.lol",
    what: "Same aircraft data, used when adsb.fi doesn't answer",
    api: "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}", docs: "https://github.com/adsblol/api",
    terms: "Free, no key today (ADSB.lol says a key will be required in the future); data under ODbL 1.0.",
    license: "ODbL 1.0", licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "Aircraft positions © ADSB.lol contributors, ODbL 1.0",
  },
];

const STYLE = `
.mv-line { margin-top: 6px; font-size: 14px; font-weight: 600; line-height: 1.3; }
.mv-line.mv-lo { color: var(--l3); } .mv-line.mv-hi { color: var(--l1); }
.sheet .mv-card { background: var(--card-2); border-radius: 16px; padding: 12px 14px; cursor: default; }
.sheet .mv-card:active { transform: none; }
.mv-sum { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
.mv-sum.mv-lo { color: var(--l3); } .mv-sum.mv-hi { color: var(--l1); }
.mv-row + .mv-row { margin-top: 10px; }
.mv-rh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 14px; }
.mv-rh b { font-weight: 700; }
.mv-rh .mv-v { font-variant-numeric: tabular-nums; }
.mv-track { position: relative; height: 10px; margin-top: 5px; border-radius: 5px; background: var(--line); overflow: visible; }
.mv-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--c, var(--l1)); }
.mv-norm { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); }
.mv-facts { display: flex; gap: 6px 16px; flex-wrap: wrap; margin-top: 12px; font-size: 14px; }
.mv-facts b { font-variant-numeric: tabular-nums; }
.mv-when { margin-top: 8px; font-size: 12.5px; color: var(--muted); }
.mv-when.mv-old { color: var(--l2); font-weight: 600; }
.mv-src { margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.4; }
.mv-src a { color: var(--l1); text-decoration: none; }
.mv-src a:focus-visible { outline: 2px solid var(--l1); outline-offset: 2px; border-radius: 4px; }
.banner.mv-alert { border-left-color: var(--l3); }
.mv-alert .mv-am { color: var(--muted); font-size: 12.5px; }
`;

let data = null;
let lastGen = null;

function injectStyle() {
  if (document.getElementById("mv-style")) return;
  const s = document.createElement("style");
  s.id = "mv-style";
  s.textContent = STYLE;
  document.head.append(s);
}

function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

const fmts = new Map();
function clock(ms, tz) {
  const k = tz || "local";
  if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat("en-US", Object.assign({ hour: "numeric", minute: "2-digit", hour12: true }, tz ? { timeZone: tz } : {})));
  return fmts.get(k).format(ms).replace(/[  ]/g, " ");
}
const agoText = (ms) => (ms < 2 * MIN ? "just now" : ms < 90 * MIN ? `${Math.round(ms / MIN)} min ago` : `${Math.round(ms / 3600e3)} h ago`);

function entry(a) {
  return (a && data && data.airports && data.airports[a.iata]) || null;
}
const ageOf = (e) => Date.now() - Date.parse(e.asOf);
const fresh = (e) => e && e.asOf && ageOf(e) < FRESH_MS;
const meaningful = (e) => fresh(e) && e.index != null && e.baseline && e.baseline.depHr && e.coverage >= 0.6 && (e.index < 0.7 || e.index > 1.3);
const pctOff = (index) => Math.round(Math.abs(1 - index) * 100);

/** "Departures running 38% below normal" (null unless it means something). */
export function line(a) {
  const e = entry(a);
  if (!meaningful(e)) return null;
  const low = e.index < 1;
  return el("div", "mv-line " + (low ? "mv-lo" : "mv-hi"), `Departures running ${pctOff(e.index)}% ${low ? "below" : "above"} normal`);
}

function bar(label, value, normal) {
  const max = Math.max(value || 0, normal || 0, 1) * 1.15;
  const ratio = normal ? (value || 0) / normal : null;
  const color = ratio == null ? "var(--l1)" : ratio < 0.5 ? "var(--l3)" : ratio < 0.7 ? "var(--l2)" : "var(--l1)";
  const track = el("div", "mv-track");
  track.setAttribute("role", "img");
  track.setAttribute("aria-label", `${label}: ${value == null ? "unknown" : value + " per hour"}${normal ? `, normal ${normal}` : ""}`);
  const fill = el("div", "mv-fill");
  fill.style.width = `${(100 * (value || 0)) / max}%`;
  fill.style.setProperty("--c", color);
  track.append(fill);
  if (normal) {
    const m = el("div", "mv-norm");
    m.style.left = `${(100 * normal) / max}%`;
    track.append(m);
  }
  return el("div", "mv-row",
    el("div", "mv-rh", el("b", null, label), el("span", "mv-v", value == null ? "—" : `${value}/hr`, normal ? el("span", "muted", ` · normal ${normal}`) : null)),
    track);
}

function sourceLine(e) {
  const used = (e.src && SOURCES.find((s) => s.id === e.src)) || SOURCES[0];
  const a = el("a", null, used.name);
  a.href = used.url;
  a.target = "_blank";
  a.rel = "noopener";
  const b = e.baseline || {};
  const days = data.learning ? data.learning.days : null;
  const base = b.source === "own" ? `our log, ${days != null ? days + (days === 1 ? " day" : " days") : (b.n || 0) + " weeks"}`
    : b.source === "bts" ? "airline schedules (BTS)"
    : "none yet";
  return el("div", "mv-src", "From community ADS-B receivers (", a, ")", used.license ? ` · ${used.license}` : "", ` · baseline: ${base}`);
}

/** Sheet card "Traffic right now" (null when this airport has no movement data). */
export function card(a) {
  const e = entry(a);
  if (!e || !e.asOf) return null;
  injectStyle();
  const b = e.baseline || {};
  const old = !fresh(e);
  const tone = meaningful(e) ? (e.index < 1 ? " mv-lo" : " mv-hi") : "";
  const sum = meaningful(e) ? `Departures running ${pctOff(e.index)}% ${e.index < 1 ? "below" : "above"} normal` : e.sentence;
  const box = el("div", "card mv-card",
    sum ? el("div", "mv-sum" + tone, sum) : null,
    bar("Departures", e.depHr, b.depHr),
    bar("Arrivals", e.arrHr, b.arrHr),
    el("div", "mv-facts",
      el("span", null, "Taxiing out ", el("b", null, e.taxiOut ?? 0)),
      el("span", null, "Holding nearby ", el("b", null, e.holding ?? 0))),
    el("div", "mv-when" + (old ? " mv-old" : ""),
      `As of ${clock(Date.parse(e.asOf), a.tz)}` + (old ? ` (${agoText(ageOf(e))}; not updating)` : "")
      + (e.coverage != null && e.coverage < 0.6 && !old ? ` · limited data this hour (${e.n || 0} of 12 checks)` : "")),
    sourceLine(e));
  box.setAttribute("aria-label", "Traffic right now");
  const sec = el("div", "sec mv-sec", el("h3", null, "Traffic right now"), box);
  return sec;
}

/** Airline alert banner(s); null when none, or when they went into #natstrip. */
export function alerts() {
  const list = (data && data.run && Date.now() - Date.parse(data.generated) < 2 * FRESH_MS && data.airlineAlerts) || [];
  const strip = document.getElementById("natstrip");
  if (strip) strip.querySelectorAll(".mv-alert").forEach((x) => x.remove());
  if (!list.length) return null;
  injectStyle();
  const kids = list.map((x) => el("div", null, el("b", null, x.sentence)));
  if (strip) {
    for (const x of list) strip.append(el("div", "mv-alert", x.sentence));
    return null;
  }
  return el("div", "banner mv-alert", ...kids, el("div", "mv-am", "From aircraft tracking, compared with the usual for this hour"));
}

/** check.html row. add(status, label, detail). */
export async function checkRow(add) {
  let r;
  try { r = await fetch("./data/movement.json", { cache: "no-store" }); } catch (e) { add("warn", "Movement feed", "couldn't fetch data/movement.json: " + (e.message || e)); return; }
  if (!r.ok) { add("warn", "Movement feed", r.status === 404 ? "data/movement.json not deployed yet" : `HTTP ${r.status}`); return; }
  let d;
  try { d = await r.json(); } catch { add("warn", "Movement feed", "data/movement.json isn't JSON"); return; }
  const run = d.run || {};
  const age = Date.now() - Date.parse(d.generated);
  const bits = [`last run ${run.ok ? "ok" : "failed"}`, `${run.airports ?? 0} of ${run.of ?? "?"} airports`, `data ${Number.isFinite(age) ? agoText(age) : "of unknown age"}`];
  if (run.src && run.src.length) bits.push(run.src.join(" + "));
  if (run.outOfTime) bits.push("time budget hit (rotating)");
  if (run.errors && run.errors.length) bits.push(run.errors[0]);
  if (d.learning) bits.push(`learning ${d.learning.days} of ${d.learning.of} days`);
  add(run.ok && age < FRESH_MS ? "pass" : "warn", "Movement feed", bits.join(" · "));
}

async function load() {
  if (window.AWXTest && window.AWXTest.name) return; // test scenarios aren't live traffic
  try {
    const r = await fetch("./data/movement.json", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (!d || typeof d.airports !== "object") return;
    data = d;
    if (d.generated !== lastGen) {
      lastGen = d.generated;
      const app = window.AWXApp;
      if (app && app.render && app.state && app.state.data) app.render();
    }
  } catch { /* no movement data: the page simply doesn't show it */ }
}

const api = { card, line, alerts, checkRow, SOURCES, _set: (d) => { data = d; } };
// Only the main page loads data (check.html and Settings import this module for checkRow/SOURCES).
if (typeof document !== "undefined" && document.getElementById("list")) {
  window.AWXMovement = api;
  injectStyle();
  load();
  setInterval(load, 2 * MIN);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
}
export default api;
