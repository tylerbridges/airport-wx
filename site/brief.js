// Per-airport Today’s changes, refreshed with app data. The day-of flight brief lives in trips.js.
const HOUR = 3600e3;
const MIN = 60e3;
const W = typeof window !== "undefined" ? window : {}; // require-free in Node (tools/brief.test.mjs)
const T = W.AWXTest || { name: null };
const app = () => W.AWXApp;
export const KINDS = ["level", "program_start", "program_end", "program_extend", "closure_start", "closure_end", "warning", "word", "plan_gs_add", "plan_gs_drop", "movement"];

const S = { data: null, failed: false, gen: null, seen: -1, loading: null };

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
const plural = (n, one, many) => (n === 1 ? one : many);
const nowMs = () => { const A = app(); return A && A.brief ? A.brief.refNow() : Date.now(); };
const hideMap = () => {
  const p = window.AWXPrefs ? window.AWXPrefs.getPrefs() : null;
  const o = {};
  for (const [k, v] of Object.entries((p && p.show) || {})) if (v === false) o[k] = true;
  return o;
};
const catsHidden = (cat) => !!(window.AWXCats && window.AWXCats.hidden(cat, hideMap()));

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

// Changes remain available from airport details; the trip module owns the day-of brief.
function render() {
  const A = app();
  if (A?.state && A.state.fetchedAt !== S.seen) { S.seen = A.state.fetchedAt; load(); }
}

// ---------- airport sheet: "Today" ----------

function todaySection(a) {
  const A = app();
  if (!A || !A.brief) return null;
  const list = todayEvents(a);
  if (!list.length) return null;
  const tz = A.dispTz(a);
  const B = A.brief;
  const sec = h("section", { class: "sec bf-today" },
    h("div", { class: "sec-h" }, B.icon ? B.icon(B.ICONS.clock) : null, h("h3", {}, "Today"), h("span", { class: "rule", "aria-hidden": "true" })),
    h("div", { class: "scard" },
      h("ul", { class: "bf-evs" }, list.map((e) => h("li", { class: "bf-ev" }, h("span", { class: "bf-t" }, A.clock(Date.parse(e.t), tz)), h("span", { class: "bf-s" }, eventText(e, a)))))));
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
.bf-evs{list-style:none;margin:0;padding:6px 0 0}
.bf-ev{display:flex;gap:10px;padding:5px 0;font-size:14px;line-height:1.35;border-bottom:1px dashed var(--line)}
.bf-ev:last-child{border-bottom:0}
.bf-t{flex:none;min-width:64px;color:var(--muted);font-variant-numeric:tabular-nums}
.bf-s{flex:1;min-width:0;overflow-wrap:anywhere}
.bf-more{padding-top:4px;font-size:13px;color:var(--muted)}
`;

const api = { render, decorateSheet, todaySection, todayEvents, reload: () => { S.seen = -1; return load(); }, checkRow, changeProblems, _state: () => ({ data: S.data, failed: S.failed }) };
// Only the main page loads airport changes (check.html imports checkRow).
if (typeof document !== "undefined" && document.getElementById("list")) {
  if (!document.getElementById("awx-brief-css")) document.head.append(h("style", { id: "awx-brief-css" }, CSS));
  window.AWXBrief = api;
  load();
  setInterval(() => { if (document.visibilityState === "visible") render(); }, 5 * MIN);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
  const A = app();
  if (A && A.render && A.state && A.state.data) A.render();
}
export default api;
