// Morning brief and the airport menu's Today’s changes page (brief hook). Loaded as a module after app.js; talks to it
// through window.AWXApp (state, view, dispTz, clock, codeOf, openSheet, and AWXApp.brief: the helpers app.js
// exports for this file) and is called back by two marked hooks in app.js: render() -> AWXBrief.render(),
// renderSheet() -> AWXBrief.decorateSheet(sheet, a).
//
//   - The brief: a compact glass card at the top of the Airports tab, shown 4–11 AM device time and otherwise from
//     the menu ("Today's brief"). One headline for the starred airports and today's trip airports, up to three
//     lines (today's trips with their status, then the airports that need attention with their worst period
//     today), one national line when notable. Dismiss hides it until tomorrow (localStorage "awx-brief").
//   - "Today" in the airport sheet: the airport's change-log events since local midnight, newest first, six at
//     most, then "+N earlier" (plain text).
// Built from status.json (through app.js, so the Settings filters and time settings apply), trips (site/trips.js)
// and data/changes.json (poller/changes.mjs), refreshed whenever the app's data is. No "%" in Traveler mode.

const HOUR = 3600e3;
const MIN = 60e3;
const KEY = "awx-brief";
const SHOW_FROM = 4; // device-local hours the brief shows by itself: 4 AM ...
const SHOW_TO = 11; // ... until 11 AM
const TODAY_MAX = 6;
const RECENT_END_MS = 6 * HOUR; // a program that ended this recently is worth a mention
const W = typeof window !== "undefined" ? window : {}; // require-free in Node (tools/brief.test.mjs)
const T = W.AWXTest || { name: null };
const app = () => W.AWXApp;
const CAT_WORD = { storms: "storms", tstm: "storms", winter: "snow and ice", wind: "wind", fog: "low clouds", heat: "heat", runways: "runway closure", atc: "ATC staffing", vip: "VIP movement", space: "space launch", faa: "FAA program" };
const RANK = { unlikely: 0, small: 1, usual: 1, possible: 2, likely: 3, very: 4, now: 5 };
export const KINDS = ["level", "program_start", "program_end", "program_extend", "closure_start", "closure_end", "warning", "word", "plan_gs_add", "plan_gs_drop", "movement"];

const S = { data: null, failed: false, gen: null, seen: -1, loading: null, forced: false };

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const lv = (n) => "l" + Math.max(0, Math.min(4, n | 0));
const plural = (n, one, many) => (n === 1 ? one : many);
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const deviceDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const nowMs = () => { const A = app(); return A && A.brief ? A.brief.refNow() : Date.now(); };
const hideMap = () => {
  const p = window.AWXPrefs ? window.AWXPrefs.getPrefs() : null;
  const o = {};
  for (const [k, v] of Object.entries((p && p.show) || {})) if (v === false) o[k] = true;
  return o;
};
const catsHidden = (cat) => !!(window.AWXCats && window.AWXCats.hidden(cat, hideMap()));

function readDismissed() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return v && typeof v.dismissed === "string" ? v.dismissed : null; } catch { return null; }
}
function writeDismissed(day) {
  try { localStorage.setItem(KEY, JSON.stringify({ dismissed: day })); } catch { /* storage blocked: hidden for this page only */ }
}

// ---------- data: changes.json ----------

function appReady() {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => ((app() && app().state && app().state.loaded) || Date.now() - t0 > 8000 ? res() : setTimeout(tick, 50));
    tick();
  });
}
function load() {
  if (S.loading) return S.loading;
  S.loading = (async () => {
    await appReady(); // test mode: the scenario's shift is known once status.json is loaded
    const url = T.name ? `./data/scenarios/${T.name}/changes.json` : "./data/changes.json";
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        S.data = T.name && T.shift ? T.shift(d, T.delta || 0) : d;
        S.failed = !!(d && d.error);
      } else { S.data = null; S.failed = r.status !== 404; }
    } catch { S.failed = true; }
    S.loading = null;
    const gen = S.data ? S.data.generated : null;
    if (gen !== S.gen) {
      S.gen = gen;
      const A = app();
      if (A && A.render && A.state && A.state.data) A.render();
    }
  })();
  return S.loading;
}
const events = () => (S.data && !S.data.error && Array.isArray(S.data.events) ? S.data.events.filter((e) => e && e.iata && e.sentence && Date.parse(e.t)) : []);

/** Category of an event for the Settings filters (null = never hidden; ground stops and closures can't be). */
export function eventCat(e) {
  const C = window.AWXCats;
  if (!C) return null;
  if (/^program_/.test(e.kind)) {
    const type = e.prog || e.to || e.from;
    return type === "ground_stop" ? "always" : C.programCat(e.cause || "");
  }
  if (/^closure_/.test(e.kind)) return "always";
  if (e.kind === "warning") return C.alert(e.to);
  if (/^plan_gs/.test(e.kind)) return "faa";
  return null;
}

/** The sentence as shown: an extension's new end in the display zone and clock. */
function eventText(e, a) {
  const A = app();
  if (e.kind === "program_extend" && Date.parse(e.to)) return e.sentence.replace(/until .*$/, "until " + A.brief.whenLabel(Date.parse(e.to), A.dispTz(a)));
  return e.sentence;
}

/** The airport's events since local midnight (display zone) — or the last 6 h when that reaches further back, so just after midnight
 * the card still shows the evening — newest first, hidden categories left out. */
export function todayEvents(a) {
  const A = app();
  const tz = A.dispTz(a);
  const now = nowMs();
  const from = Math.min(A.brief.localMidnight(now, tz), now - 6 * 60 * MIN);
  return events().filter((e) => e.iata === a.iata && Date.parse(e.t) >= from && Date.parse(e.t) <= now + MIN && !catsHidden(eventCat(e)))
    .sort((x, y) => Date.parse(y.t) - Date.parse(x.t));
}

// ---------- the brief ----------

/** "4–8 PM", "tomorrow 6–9 AM", "11 AM – 2 PM" in tz. */
function rangeText(start, end, tz) {
  const A = app(), B = A.brief;
  const w = B.whenLabel(start, tz);
  const sa = A.clock(start, tz), sb = A.clock(end, tz);
  const prefix = w.endsWith(sa) ? w.slice(0, w.length - sa.length) : "";
  const half = (x) => x.split(" ").pop();
  if (B.dayKey(start, tz) === B.dayKey(end, tz) && / [AP]M$/.test(sa) && half(sa) === half(sb)) return prefix + sa.slice(0, sa.lastIndexOf(" ")) + "–" + sb;
  // "11 PM – 1 AM tomorrow" when only the end is tomorrow
  const tmw = !prefix && B.dayKey(end, tz) !== B.dayKey(start, tz) && B.dayKey(end, tz) === B.dayKey(B.refNow() + 24 * HOUR, tz) && B.dayKey(end - 1, tz) !== B.dayKey(start, tz);
  return prefix + sa + " – " + sb + (tmw ? " tomorrow" : "");
}

/** Cause word for an hour's reasons: "storms", "low clouds", else the first plain reason. */
function causeOf(reasons, level, a) {
  const C = W.AWXCats;
  let fallback = null;
  for (const r of reasons || []) {
    const c = C ? C.reason(r) : null;
    if (c && c.level != null && c.level < level) continue;
    if (c && CAT_WORD[c.cat] && c.cat !== "faa") return CAT_WORD[c.cat];
    // a program's or plan's cause: "Delays — weather (thunderstorms), …", "FAA plans a possible ground stop … (storms)"
    const m = /—\s*[^,(]*\(([^)]+)\)/.exec(String(r)) || /\(([^)]+)\)\s*$/.exec(String(r));
    if (m && !fallback && !/^(conditions|LAMP|TCF|ATCSCC)$/.test(m[1])) fallback = m[1].toLowerCase().replace(/\bthunderstorms?\b/g, "storms").replace(/\b(it|atc|ils|vip|tfr|gps|faa|nas)\b/g, (x) => x.toUpperCase()); // "IT outage"
  }
  if (fallback) return fallback;
  const first = app().brief.shortList(reasons, a)[0];
  return first ? lowerFirst(first) : null;
}

/** One airport for the brief: {a, level, attention, text}. Levels and windows are the page's display levels
 * (AWXApp hourLevel: weather/FAA raised by the delay chance), so the brief, the card and the timeline agree. */
function airportItem(a) {
  const A = app(), B = A.brief;
  const v = A.view(a);
  const tz = A.dispTz(a);
  const now = nowMs();
  const end = Math.max(B.localMidnight(now, tz, 1), now + 12 * HOUR);
  const hrs = v.hours.filter((x) => Date.parse(x.t) + HOUR > now && Date.parse(x.t) < end);
  const code = A.codeOf(a);
  if (!hrs.length) return { a, level: 0, attention: false, text: code + ": forecast not available" };
  const lvl = hrs.map((x, k) => (B.hourLevel ? B.hourLevel(a, x, k === 0) : x.level) || 0);
  let i = 0;
  lvl.forEach((l, k) => { if (l > lvl[i]) i = k; });
  let j = i;
  while (j + 1 < hrs.length && lvl[j + 1] === lvl[i]) j++;
  const worst = lvl[i];
  const t0 = Date.parse(v.hours[0].t);
  const progs = B.programsAt(v, t0, true).filter((f) => f.type !== "delay");
  const D = window.AWXDelay;
  const d = hrs[i].delay;
  const L = D && D.likelihood && d && d.p != null ? D.likelihood(d, { iata: a.iata }) : null;
  const notable = !!(L && D.notable && D.notable(d, worst, L));
  const attention = worst >= 2 || progs.length > 0 || (notable && RANK[L.key] >= RANK.likely);
  const zt = B.zoneTag ? B.zoneTag(a) : "";
  // a program or closure that ended in the last few hours
  const ended = todayEvents(a).find((e) => (e.kind === "program_end" || e.kind === "closure_end") && now - Date.parse(e.t) <= RECENT_END_MS);
  const endedText = ended ? lowerFirst(ended.sentence) + " " + A.clock(Date.parse(ended.t), tz) + zt : null;
  let text;
  if (progs.length) {
    const order = { closure: 0, ground_stop: 1, ground_delay: 2 };
    const f = progs.sort((x, y) => (order[x.type] ?? 9) - (order[y.type] ?? 9))[0];
    const cause = f.type === "closure" ? null : causeOf(v.now.reasons, v.now.level, a);
    const line = B.programLine(f, a).replace(/, avg .*$/, "");
    text = `${code}: ${line}${/\d (AM|PM)$|\d:\d\d$/.test(line) ? zt : ""}${cause ? " — " + cause : ""}`;
  } else {
    const start = Math.max(Date.parse(hrs[i].t), now);
    const stop = Date.parse(hrs[j].t) + HOUR;
    // "Delays happening now" (FAA delays in effect) needs no period: the level's run isn't the delays' end
    const when = notable && L.key === "now" ? "" : (B.rangeText ? B.rangeText(start, stop, tz) : rangeText(start, stop, tz)) + zt;
    const what = notable ? L.word : `${B.LEVELS[worst].label} risk`;
    const reasons = B.hourReasons ? B.hourReasons(a, hrs[i], worst) : hrs[i].reasons;
    const why = endedText || (causeOf(reasons, worst, a) || "").replace(/^(busy [a-z ]+) — .*$/, "$1") || null; // "busy evening", not "… — delays likely" twice
    text = `${code}: ${what}${when ? " " + when : ""}${why ? " — " + why : ""}`;
  }
  return { a, level: Math.max(worst, progs.some((f) => f.type === "ground_stop" || f.type === "closure") ? 4 : progs.length ? 3 : 0), attention, text, ended: endedText };
}

/** Trips with a flight today (display zone of the origin) or in progress: [{id, level, text}]. */
function tripItems() {
  const Tr = window.AWXTrips;
  if (!Tr || typeof Tr._state !== "function") return [];
  const A = app(), B = A.brief;
  const now = nowMs();
  const by = new Map(((A.state.data && A.state.data.airports) || []).map((a) => [a.iata, a]));
  const out = [];
  let list = [];
  try { list = Tr._state().trips || []; } catch { return []; }
  for (const t of list) {
    const legs = t.legs || [];
    const leg = legs.find((l) => !l.landed);
    if (!leg || t.status === "done") continue;
    const tz = A.dispTz(by.get(leg.from) || { tz: "UTC" });
    const dep = Number(leg.dep) || Date.parse(leg.dep);
    const today = B.dayKey(dep, tz) === B.dayKey(now, tz) || (leg.departed && !leg.landed);
    if (!today) continue;
    const route = `${legs[0].from}→${legs[legs.length - 1].to}`;
    const level = { ok: 0, possible: 2, likely: 3, disruption: 4 }[t.status] ?? 0;
    const tail = t.short && t.status !== "ok" && t.status !== "early" ? " — " + t.short : "";
    const zt = B.zoneTag ? B.zoneTag(by.get(leg.from) || { tz: "UTC" }, dep) : "";
    out.push({ id: t.id, level, codes: legs.flatMap((l) => [l.from, l.to]), text: `${route} ${A.clock(dep, tz)}${zt}: ${t.label}${tail}` });
  }
  return out;
}

/** Everything the card says: {headline, lines: [{text, level, iata?, trip?}], national, note, count, attention}. */
export function briefModel() {
  const A = app();
  const d = A && A.state && A.state.data;
  if (!d || !A.brief) return null;
  const by = new Map(d.airports.map((a) => [a.iata, a]));
  const trips = tripItems();
  const codes = [...new Set([...A.state.favs, ...trips.flatMap((t) => t.codes)])].filter((c) => by.has(c));
  const items = codes.map((c) => airportItem(by.get(c)));
  const attn = items.filter((x) => x.attention).sort((x, y) => y.level - x.level || codes.indexOf(x.a.iata) - codes.indexOf(y.a.iata));
  const n = codes.length;
  const headline = !n ? "No starred airports yet"
    : attn.length ? `${attn.length} ${plural(attn.length, "airport needs", "airports need")} attention`
    : n === 1 ? `All clear at ${A.codeOf(by.get(codes[0]))} today` : `All clear at your ${n} airports today`;
  const lines = [];
  for (const t of trips.slice(0, 2)) lines.push({ text: t.text, level: t.level, trip: t.id });
  for (const x of attn) if (lines.length < 3) lines.push({ text: x.text, level: x.level, iata: x.a.iata });
  // all clear, but a program ended at one of them earlier today: say so
  if (!attn.length) for (const x of items) if (x.ended && lines.length < 3) lines.push({ text: `${A.codeOf(x.a)}: ${x.ended[0].toUpperCase()}${x.ended.slice(1)}`, level: 0, iata: x.a.iata });
  let national = null;
  const s = A.brief.nationalSummary();
  if (s && (s.stops.length || s.closed.length || s.gdps.length || s.stormRegions.length)) {
    // the strip's notable part only: closures, ground stops, delay programs, storms
    const n2 = (k, one, many) => (s[k].length ? `${s[k].length} ${plural(s[k].length, one, many)}` : null);
    const parts = [n2("closed", "airport closed", "airports closed"), n2("stops", "ground stop", "ground stops"), n2("gdps", "delay program", "delay programs")].filter(Boolean).join(", ");
    const storms = s.stormRegions.length ? "storms in " + (/^(Alaska|Hawaii)$/.test(s.stormRegions[0]) ? "" : "the ") + s.stormRegions[0] : null;
    national = "U.S.: " + [parts, storms].filter(Boolean).join(" · ");
  }
  // never silently wrong: say when the picture is incomplete
  const src = d.sources || {};
  const down = ["faa", "atcscc", "metar", "taf", "nws"].some((k) => src[k] && (!src[k].ok || src[k].stale));
  const old = nowMs() - Date.parse(d.generated) > 30 * MIN;
  const hidden = Object.keys(hideMap()).length > 0;
  const note = [A.state.sample ? "Sample data" : old ? "Data may be outdated" : null, down ? "Some data unavailable" : null, hidden ? "Some disruption types hidden" : null].filter(Boolean).join(" · ") || null;
  return { headline, lines, national, note, count: n, attention: attn.length };
}

const inWindow = () => { const hr = new Date().getHours(); return hr >= SHOW_FROM && hr < SHOW_TO; };
const dismissedToday = () => readDismissed() === deviceDay(Date.now());
export const isShown = () => S.forced || (inWindow() && !dismissedToday());

function box() {
  let b = document.getElementById("brief");
  if (!b) {
    const seg = document.getElementById("seg");
    if (!seg || !seg.parentNode) return null;
    b = h("section", { id: "brief", hidden: true });
    seg.before(b);
  }
  return b;
}

function render() {
  const A = app();
  if (A && A.state && A.state.fetchedAt !== S.seen) { S.seen = A.state.fetchedAt; load(); } // refreshed with the data
  const b = box();
  if (!b) return;
  const m = isShown() ? briefModel() : null;
  if (!m) { b.hidden = true; b.replaceChildren(); return; }
  b.className = "awx-brief glass";
  b.setAttribute("aria-label", "Today's brief");
  b.hidden = false;
  const line = (x) => h("li", {},
    h("button", { type: "button", class: "bf-l", onclick: () => (x.trip && window.AWXTrips ? window.AWXTrips.openTrip(x.trip) : x.iata ? A.openSheet(x.iata) : null) },
      h("span", { class: "dot " + lv(x.level), "aria-hidden": "true" }), h("span", { class: "bf-lt" }, x.text)));
  b.replaceChildren(...[
    h("div", { class: "bf-h" },
      h("span", { class: "bf-k" }, "Today's brief"),
      h("button", { type: "button", class: "bf-x", "aria-label": "Dismiss today's brief until tomorrow", onclick: dismiss }, "Dismiss")),
    h("div", { class: "bf-head" }, m.headline),
    m.lines.length ? h("ul", { class: "bf-lines" }, m.lines.map(line)) : null,
    m.national ? h("div", { class: "bf-nat" }, m.national) : null,
    m.note ? h("div", { class: "bf-note" }, m.note) : null].filter(Boolean));
}

function dismiss() {
  writeDismissed(deviceDay(Date.now()));
  S.forced = false;
  render();
  const seg = document.querySelector("#seg button[aria-selected='true']");
  if (seg) seg.focus({ preventScroll: true });
}

/** Menu → "Today's brief": show it now (also after it was dismissed), on the Airports tab, scrolled into view. */
function open() {
  S.forced = true;
  if (window.AWXNav && window.AWXNav.tab && window.AWXNav.tab() !== "airports" && window.AWXNav.go) window.AWXNav.go("airports");
  render();
  const b = document.getElementById("brief");
  if (b && !b.hidden) {
    const panel = b.closest(".awx-panel");
    if (panel) panel.scrollTop = 0; else b.scrollIntoView({ block: "start" });
    const x = b.querySelector(".bf-x");
    if (x) x.focus({ preventScroll: true });
  }
}

// ---------- airport sheet: "Today" ----------

function todaySection(a) {
  const A = app();
  if (!A || !A.brief) return null;
  const list = todayEvents(a);
  if (!list.length) return null;
  const tz = A.dispTz(a);
  const shown = list.slice(0, TODAY_MAX);
  const more = list.length - shown.length;
  const B = A.brief;
  const sec = h("section", { class: "sec bf-today" },
    h("div", { class: "sec-h" }, B.icon ? B.icon(B.ICONS.clock) : null, h("h3", {}, "Today"), h("span", { class: "rule", "aria-hidden": "true" })),
    h("div", { class: "scard" },
      h("ul", { class: "bf-evs" }, shown.map((e) => h("li", { class: "bf-ev" }, h("span", { class: "bf-t" }, A.clock(Date.parse(e.t), tz)), h("span", { class: "bf-s" }, eventText(e, a))))),
      more > 0 ? h("div", { class: "bf-more" }, `+${more} earlier`) : null));
  return sec;
}
function decorateSheet(sheet, a) {
  if (!sheet || !a) return;
  const A = app(), menu = sheet.querySelector(".ad-menu");
  if (!menu || !A?.detailRow) return;
  if (!todayEvents(a).length || menu.querySelector('[data-detail="today"]')) return;
  menu.querySelector('[data-detail="technical"]').before(A.detailRow("Today’s changes", "Recent airport updates", "today", () => A.openDetails(a.iata, "today")));
}

// ---------- check page ----------

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/;
/** Problems in a changes.json: [] when it is well-formed. */
export function changeProblems(d, iatas = null) {
  const out = [];
  if (!d || d.v !== 1 || !Array.isArray(d.events)) return ["not a changes.json (v 1 with events[])"];
  if (!ISO.test(String(d.generated || ""))) out.push("no generated time");
  d.events.forEach((e, i) => {
    const where = `event ${i}`;
    if (!e || !ISO.test(String(e.t || ""))) out.push(`${where}: bad time`);
    else if (!KINDS.includes(e.kind)) out.push(`${where}: unknown kind ${e.kind}`);
    else if (!e.sentence || /%/.test(e.sentence)) out.push(`${where}: bad sentence "${e.sentence}"`);
    else if (iatas && !iatas.has(e.iata)) out.push(`${where}: unknown airport ${e.iata}`);
    else if (Date.parse(d.generated) - Date.parse(e.t) > 36 * HOUR + MIN) out.push(`${where}: older than 36 h`);
  });
  return out.slice(0, 3);
}
/** Check-page row: the change log loads, is well-formed and (live) fresh. */
export async function checkRow(add, { url = "./data/changes.json", shift = (d) => d, mock = false, data = null } = {}) {
  let r;
  try { r = await fetch(url, { cache: "no-store" }); } catch (e) { add(mock ? "fail" : "warn", "Change log", "couldn't fetch " + url + ": " + (e.message || e)); return; }
  if (!r.ok) { add(mock ? "fail" : "warn", "Change log", r.status === 404 ? `${url} not deployed yet` : `HTTP ${r.status}`); return; }
  let d;
  try { d = shift(await r.json()); } catch { add("fail", "Change log", url + " isn't JSON"); return; }
  if (d && d.error) { add("warn", "Change log", "last run failed: " + d.error); return; }
  const probs = changeProblems(d, data ? new Set(data.airports.map((a) => a.iata)) : null);
  const age = Date.now() - Date.parse(d.generated);
  const n = (d.events || []).length;
  const detail = `${n} ${plural(n, "event", "events")} in the last 36 h · built ${Math.max(0, Math.round(age / MIN))} min ago${d.since ? " · log since " + d.since.slice(0, 16).replace("T", " ") + "Z" : ""}`;
  if (probs.length) add("fail", "Change log well-formed", probs.join("; "));
  else if (!mock && age > 20 * MIN) add("warn", "Change log fresh", detail);
  else add("pass", "Change log", detail);
}

// ---------- init ----------

const CSS = `
.awx-brief { border-radius: 20px; padding: 12px 14px 12px; margin: 0 0 12px; color: var(--text); }
.awx-brief[hidden] { display: none; }
.bf-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bf-k { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--brand); }
.bf-x { font: inherit; font-size: 13px; font-weight: 600; color: var(--muted); background: none; border: 0; padding: 10px 2px 10px 12px; margin: -10px 0; min-height: 44px; cursor: pointer; }
.bf-x:focus-visible, .bf-l:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 8px; }
.bf-head { font-size: 19px; font-weight: 800; letter-spacing: -.02em; line-height: 1.25; margin-top: 2px; }
.bf-lines { list-style: none; margin: 6px 0 0; padding: 0; }
.bf-l { width: 100%; display: flex; align-items: baseline; gap: 9px; text-align: left; font: inherit; font-size: 14.5px; line-height: 1.35; color: var(--text); background: none; border: 0; padding: 5px 0; cursor: pointer; }
.bf-l .dot { width: 8px; height: 8px; box-shadow: none; transform: translateY(-1px); }
.bf-lt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.bf-nat { margin-top: 6px; padding-top: 7px; border-top: 1px solid var(--line); font-size: 13.5px; color: var(--muted); line-height: 1.35; }
.bf-note { margin-top: 6px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.bf-evs { list-style: none; margin: 0; padding: 6px 0 0; }
.bf-ev { display: flex; gap: 10px; padding: 5px 0; font-size: 14px; line-height: 1.35; border-bottom: 1px dashed var(--line); }
.bf-ev:last-child { border-bottom: 0; }
.bf-t { flex: none; min-width: 64px; color: var(--muted); font-variant-numeric: tabular-nums; }
.bf-s { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.bf-more { padding-top: 4px; font-size: 13px; color: var(--muted); }
`;

const api = { render, decorateSheet, todaySection, open, dismiss, isShown, model: briefModel, todayEvents, reload: () => { S.seen = -1; return load(); }, checkRow, changeProblems, _state: () => ({ data: S.data, failed: S.failed, forced: S.forced, dismissed: readDismissed() }) };
// Only the main page shows the brief (check.html imports this module for checkRow).
if (typeof document !== "undefined" && document.getElementById("list")) {
  if (!document.getElementById("awx-brief-css")) document.head.append(h("style", { id: "awx-brief-css" }, CSS));
  window.AWXBrief = api;
  load();
  if (W.AWXTrips && typeof W.AWXTrips.ready === "function") Promise.resolve(W.AWXTrips.ready()).then(() => render()).catch(() => {}); // trips arrive after the first render
  setInterval(() => { if (document.visibilityState === "visible") render(); }, 5 * MIN); // the 4–11 AM window
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
  const A = app();
  if (A && A.render && A.state && A.state.data) A.render();
}
export default api;
