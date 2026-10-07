// Check page: the scenario assertions beyond check.js evalAssert (scenarios hook). check.html?mock=1 runs them
// for every scenario in data/scenarios/index.json (README "Test scenarios" lists the types).
//   dataAsserts(add, {sc, data, delta})   on the scenario's status.json (already shifted) and its movement.json
//   pageAsserts(add, w, doc, asserts)     in the scenario's page (hidden 390 px frame, Traveler mode)
// Data assertions:
//   {t:"words", iata, at: "now" | "peak" | hour | [from, to], word?, key?, keys?, cue?, sentence?}
//        the delay words (site/delay.js likelihood) for that hour, the 24-hour peak (the card's hour), or the
//        highest chance in hours from..to
//   {t:"badge", iata, re}   {t:"noFaa", iata}   {t:"opsplan", iata, kind, re}   {t:"atcscc", iata, type, cnx}
//   {t:"alert", iata, event}   {t:"spc", iata, cat}   {t:"sigmet", iata}   {t:"model", basis}
//   {t:"movement", iata, line: re | null, arrBelow?: share}   {t:"airlineAlert", re}
//   {t:"tripConcern", i, re}  one of trip i's concerns (site/trip-risk.js) matches
//   {t:"change", iata, kind?, re}  the scenario's changes.json has a matching event (brief hook)
//   words also take every: true (every hour in [from, to] has the word/key) and notKey (no hour in range has it)
//   {t:"hourLevel", iata, at: [from, to], op, v}   the highest hour level in from..to
//   {t:"hourReason", iata, at: [from, to], re, every?}  some (every) hour in from..to has a matching reason
//   {t:"cascade", iata, hub, re?}  {t:"noCascade", iata, hub?}  hub cascade notes (status.json cascade, poller/hubs.mjs)
//   {t:"notice", iata, kind?, re?, level?}  one of the airport's notices (README "Notices") of that kind matches re;
//        level = the highest level it set in the 24 hours (0 = information)            (restrictions hook)
//   {t:"noticeSource", name: tfr, ok}  (restrictions hook)
// Page assertions:
//   {t:"now", iata, level?, obs?, re?, notRe?}  the page's current hour (README "The observed next hour"): the
//        airport's current level (outlook.js summary), whether that hour is the observed one (obs: true/false), and
//        its headline + "Now" reasons match re / don't match notRe
//   {t:"card", iata, re}   the airport's card on the All list
//   {t:"sheet", iata, re}  the airport's sheet (text, including closed "Why?" parts)
//   {t:"airportDetail", iata, page, re} selected Airport details menu popup (material safety assertions stay "sheet")
//   {t:"national", re}     the national strip (#natstrip)
//   {t:"header", re}       the "Updated …" / "Live updates unavailable …" line
//   {t:"banner", re}       the banner area
//   {t:"noPercent"}        Traveler mode: no "%" in delay-chance text (cards, every sheet, trips)
//   {t:"noAirportBrief"} no standalone starred-airport brief is rendered
//   {t:"today", iata, re}  the airport menu's Today’s changes popup (brief hook)
//   {t:"details", iata, cards?: ["why","pilot","plan"], re?}  the sheet's "More details ›" row opens the full-height
//        More details page with those cards (default all three); Traveler text outside Pilot details has no "%"
//        and no aviation codes; re matches the page text
import { tripStatus } from "./trip-risk.js";
// the same pattern as check.js AVIATION_CODES (kept here so this module doesn't import check.js)
const CODES = /\b(VFR|MVFR|IFR|LIFR|METAR|TAF|SIGMET|LAMP|TCF|CWA|TEMPO|PROB[34]0|BECMG|NOSIG|CLSD|(?:FEW|SCT|BKN|OVC)\d{3}|\d{4}Z|\d{3}°?\s?\d+G?\d*\s?kt|kt)\b/;
/** Text of the open More details page outside Pilot details (what a Traveler reads as plain words). */
export function detailsPlainText(doc) {
  const sh = doc.getElementById("mdSheet");
  if (!sh) return "";
  const c = sh.cloneNode(true);
  c.querySelectorAll(".pilot").forEach((e) => e.remove());
  return c.textContent.replace(/\s+/g, " ");
}
/** Opens airport iata's sheet, then its "More details ›" row; returns the page element (or null). */
export async function openDetailsPage(w, doc, iata, page = "technical") {
  w.AWXApp.openSheet(iata);
  await later(w, 60);
  const row = doc.querySelector('#sheet [data-detail="' + page + '"]');
  if (!row) return null;
  row.click();
  await later(w, 60);
  const wrap = doc.getElementById("mdWrap");
  return wrap && !wrap.hidden ? doc.getElementById("mdSheet") : null;
}

const DATA = new Set(["words", "badge", "noFaa", "opsplan", "atcscc", "alert", "spc", "sigmet", "model", "movement", "airlineAlert", "tripConcern", "hourLevel", "hourReason", "cascade", "noCascade", "change", "notice", "noticeSource"]); // brief hook: change; restrictions hook: notice, noticeSource
const PAGE = new Set(["now", "card", "sheet", "airportDetail", "national", "header", "banner", "noPercent", "noAirportBrief", "today", "details"]); // airportDetail: selected secondary menu page
export const isPageAssert = (x) => PAGE.has(x.t);

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

let delayMod;
async function delayWords() {
  if (delayMod === undefined) {
    try {
      const D = await import("./delay.js");
      const report = await getJson("./data/model/report.json");
      if (D.setReport && report) D.setReport(report);
      delayMod = typeof D.likelihood === "function" ? D : null;
    } catch { delayMod = null; }
  }
  return delayMod;
}
let mvMod;
async function movementMod() {
  if (mvMod === undefined) { try { mvMod = (await import("./movement.js")).default; } catch { mvMod = null; } }
  return mvMod;
}

const re = (s) => new RegExp(s);
const short = (v) => JSON.stringify(v).slice(0, 160);

/** Hour index for a words assertion: "now" = 0, "peak" = the first highest chance (the card's hour), [a, b] = highest in a..b. */
function hourFor(a, at) {
  const hs = a.hours || [];
  const p = (i) => (hs[i] && hs[i].delay && hs[i].delay.p != null ? hs[i].delay.p : -1);
  if (at == null || at === "now") return 0;
  if (typeof at === "number") return at;
  const [lo, hi] = at === "peak" ? [0, hs.length - 1] : at;
  let best = lo;
  for (let i = lo; i <= hi && i < hs.length; i++) if (p(i) > p(best)) best = i;
  return best;
}

export async function dataAsserts(add, { sc, data, delta, shift }) {
  const list = (sc.assert || []).filter((x) => DATA.has(x.t));
  if (!list.length) return;
  const ap = (iata) => (data.airports || []).find((a) => a.iata === iata);
  let mv = null;
  if (list.some((x) => x.t === "movement" || x.t === "airlineAlert")) {
    const raw = await getJson(`./data/scenarios/${sc.name}/movement.json`);
    mv = raw ? shift(raw, delta) : null;
  }
  for (const x of list) {
    const a = x.iata ? ap(x.iata) : null;
    let ok = false, label = "", got = "";
    switch (x.t) {
      case "words": {
        const D = await delayWords();
        if ((x.every || x.notKey) && Array.isArray(x.at)) { // closures hook / hubs hook: every hour in the range
          const hs = [];
          for (let i = x.at[0]; a && i <= x.at[1] && i < a.hours.length; i++) {
            const d = a.hours[i].delay;
            hs.push({ i, L: D && d ? D.likelihood(d, { iata: x.iata, aviation: false }) : null });
          }
          label = `${x.iata} delay words every hour ${x.at[0]}–${x.at[1]}: ${[x.word && `"${x.word}"`, x.key && `key ${x.key}`, x.notKey && `never key ${x.notKey}`].filter(Boolean).join(", ")}`;
          const bad = hs.filter(({ L }) => !L || (x.word && L.word !== x.word) || (x.key && L.key !== x.key) || (x.notKey && L.key === x.notKey));
          ok = !!D && hs.length > 0 && !bad.length;
          got = !D ? "site/delay.js didn't load" : bad.slice(0, 3).map(({ i, L }) => `hour ${i}: ${L ? `"${L.word}"` : "no delay numbers"}`).join("; ");
          break;
        }
        const i = a ? hourFor(a, x.at) : -1;
        const d = a && a.hours[i] && a.hours[i].delay;
        const L = D && d ? D.likelihood(d, { iata: x.iata, aviation: false }) : null;
        const want = [x.word && `"${x.word}"`, x.key && `key ${x.key}`, x.keys && `one of ${x.keys.join("/")}`, x.cue != null && `cue "${x.cue}"`, x.sentence && `"${x.sentence}"`].filter(Boolean).join(", ");
        label = `${x.iata} delay words ${Array.isArray(x.at) ? `hours ${x.at[0]}–${x.at[1]}` : x.at || "now"}: ${want}`;
        if (!D) { got = "site/delay.js has no likelihood() (delay words come with build2b)"; break; }
        if (!L) { got = a ? `no delay numbers in hour ${i}` : "no such airport"; break; }
        ok = (!x.word || L.word === x.word) && (!x.key || L.key === x.key) && (!x.keys || x.keys.includes(L.key)) && (x.cue == null || L.cue === x.cue) && (!x.sentence || L.sentence === x.sentence);
        got = `hour ${i}: "${L.sentence}" (p ${d.p}, usual ${d.pTypical})`;
        break;
      }
      case "badge": {
        const b = ((a && a.faa) || []).map((f) => f.badge).filter(Boolean);
        ok = b.some((s) => re(x.re).test(s));
        label = `${x.iata} program badge /${x.re}/`;
        got = `got ${short(b)}`;
        break;
      }
      case "noFaa":
        ok = !!a && !(a.faa || []).length;
        label = `${x.iata} has no FAA programs`;
        got = `got ${short(((a && a.faa) || []).map((f) => f.type))}`;
        break;
      case "opsplan": {
        const items = ((a && a.opsplan && a.opsplan.items) || []).filter((i) => !x.kind || i.kind === x.kind);
        ok = items.some((i) => re(x.re).test(i.text));
        label = `${x.iata} ops plan ${x.kind || "item"} /${x.re}/`;
        got = `got ${short(items.map((i) => i.text))}`;
        break;
      }
      case "atcscc": {
        const xs = ((a && a.atcscc) || []).filter((v) => v.type === x.type && (x.cnx == null || !!v.cnx === x.cnx));
        ok = xs.length > 0;
        label = `${x.iata} ATCSCC ${x.type}${x.cnx ? " cancelled" : ""}`;
        got = `got ${short(((a && a.atcscc) || []).map((v) => [v.type, v.cnx ? "CNX" : v.active ? "active" : "inactive"]))}`;
        break;
      }
      case "alert": {
        const ev = ((a && a.alerts) || []).map((v) => v.event);
        ok = ev.includes(x.event);
        label = `${x.iata} NWS ${x.event}`;
        got = `got ${short(ev)}`;
        break;
      }
      case "spc":
        ok = !!a && a.spc === x.cat;
        label = `${x.iata} SPC outlook ${x.cat}`;
        got = `got ${a ? a.spc : "no airport"}`;
        break;
      case "sigmet":
        ok = !!a && (a.sigmets || []).length > 0;
        label = `${x.iata} under a convective SIGMET`;
        got = `got ${a ? (a.sigmets || []).length : "no airport"}`;
        break;
      case "model":
        ok = !!data.delayModel && data.delayModel.basis === x.basis;
        label = `delay model basis "${x.basis}"`;
        got = `got ${short(data.delayModel)}`;
        break;
      case "movement": {
        const M = await movementMod();
        const e = mv && mv.airports && mv.airports[x.iata];
        label = `${x.iata} movement ${x.line === null ? "no card line" : x.line ? `line /${x.line}/` : ""}${x.arrBelow ? `, arrivals under ${Math.round(x.arrBelow * 100)}% of normal` : ""}`;
        if (!M || !e) { got = !M ? "site/movement.js didn't load" : "no movement entry"; break; }
        M._set(mv);
        const node = M.line({ iata: x.iata, tz: a ? a.tz : "UTC" });
        const text = node ? node.textContent : null;
        const arrOk = !x.arrBelow || (e.baseline && e.baseline.arrHr && e.arrHr < x.arrBelow * e.baseline.arrHr);
        ok = (x.line === undefined || (x.line === null ? text == null : text != null && re(x.line).test(text))) && arrOk;
        got = `got line ${JSON.stringify(text)}, departures ${e.depHr}/hr vs ${e.baseline && e.baseline.depHr}, arrivals ${e.arrHr}/hr vs ${e.baseline && e.baseline.arrHr}`;
        break;
      }
      case "tripConcern": {
        const raw = await getJson(`./data/scenarios/${sc.name}/trips.json`);
        const t = raw && shift(raw, delta).trips ? shift(raw, delta).trips[x.i || 0] : null;
        const by = new Map((data.airports || []).map((y) => [y.iata, y]));
        const r = t ? tripStatus(t, (c) => by.get(c) || null, { now: Date.now() }) : null;
        const texts = r ? r.concerns.map((c) => c.text) : [];
        ok = texts.some((v) => re(x.re).test(v));
        label = `trip ${x.i || 0} concern /${x.re}/`;
        got = r ? `got ${short(texts)}` : "no such trip";
        break;
      }
      case "notice": { // restrictions hook
        const items = ((a && a.notices && a.notices.items) || []).filter((v) => !x.kind || v.kind === x.kind);
        ok = items.some((v) => (!x.re || re(x.re).test(v.text)) && (x.level == null || (v.peak || 0) === x.level));
        label = `${x.iata} notice ${x.kind || ""}${x.re ? ` /${x.re}/` : ""}${x.level != null ? ` at level ${x.level}` : ""}`;
        got = `got ${short(((a && a.notices && a.notices.items) || []).map((v) => [v.kind, v.peak || 0, v.text]))}`;
        break;
      }
      case "noticeSource": { // restrictions hook
        const s = (data.noticeSources || {})[x.name];
        ok = !!s && !!s.ok === x.ok;
        label = `notice source ${x.name} ${x.ok ? "ok" : "unavailable"}`;
        got = `got ${s ? (s.ok ? "ok" : "error: " + s.error) : "missing"}`;
        break;
      }
      case "change": { // brief hook
        const raw = await getJson(`./data/scenarios/${sc.name}/changes.json`);
        const evs = ((raw && raw.events) || []).filter((e) => e.iata === x.iata && (!x.kind || e.kind === x.kind));
        ok = evs.some((e) => re(x.re).test(e.sentence));
        label = `${x.iata} change log ${x.kind || "event"} /${x.re}/`;
        got = raw ? `got ${short(evs.map((e) => e.sentence))}` : "no changes.json";
        break;
      }
      case "hourLevel": {
        const hs = a ? a.hours.slice(x.at[0], x.at[1] + 1) : [];
        const v = hs.length ? Math.max(...hs.map((h) => h.level)) : null;
        const cmp = { "==": v === x.v, ">=": v >= x.v, "<=": v <= x.v, ">": v > x.v, "<": v < x.v }[x.op];
        ok = v != null && !!cmp;
        label = `${x.iata} highest level in hours ${x.at[0]}–${x.at[1]} ${x.op} ${x.v}`;
        got = `got ${short(hs.map((h) => h.level))}`;
        break;
      }
      case "hourReason": {
        const hs = a ? a.hours.slice(x.at[0], x.at[1] + 1) : [];
        const hit = (h) => (h.reasons || []).some((r) => re(x.re).test(r));
        ok = hs.length > 0 && (x.every ? hs.every(hit) : hs.some(hit));
        label = `${x.iata} ${x.every ? "every" : "some"} hour ${x.at[0]}–${x.at[1]} has a reason /${x.re}/`;
        got = `got ${short(hs.map((h) => (h.reasons || [])[0] || null))}`;
        break;
      }
      case "cascade":
      case "noCascade": {
        const cs = ((a && a.cascade) || []).filter((c) => !x.hub || c.hub === x.hub);
        const has = cs.some((c) => !x.re || re(x.re).test(c.text));
        ok = !!a && (x.t === "cascade" ? has : !cs.length);
        label = `${x.iata} ${x.t === "cascade" ? "has" : "has no"} hub cascade note${x.hub ? " from " + x.hub : ""}${x.re ? ` /${x.re}/` : ""}`;
        got = `got ${short(((a && a.cascade) || []).map((c) => c.text))}`;
        break;
      }
      case "airlineAlert": {
        const s = ((mv && mv.airlineAlerts) || []).map((v) => v.sentence);
        ok = s.some((t) => re(x.re).test(t));
        label = `airline alert /${x.re}/`;
        got = `got ${short(s)}`;
        break;
      }
    }
    add(ok ? "pass" : "fail", `Expect: ${label}`, ok ? "" : [got, x.note ? `(${x.note})` : ""].filter(Boolean).join(" "));
  }
}

// Run waits in the visible check page; offscreen iframe timers may be clamped to one second.
const later = (w, ms) => new Promise((r) => setTimeout(r, ms));
async function until(w, fn, ms) {
  const t0 = Date.now();
  let v;
  while (!(v = fn()) && Date.now() - t0 < ms) await later(w, 50);
  return v;
}

/** Runs the page assertions in an already loaded scenario frame. */
export async function pageAsserts(add, w, doc, asserts) {
  const list = (asserts || []).filter((x) => PAGE.has(x.t));
  if (!list.length) return;
  const A = w && w.AWXApp;
  if (!A || !doc) { for (const x of list) add("fail", `Expect on page: ${x.t}`, "the app didn't load"); return; }
  const P = w.AWXPrefs || (w.AWXNav && w.AWXNav.prefs && w.AWXNav.prefs());
  // Traveler mode, airport time, 12-hour clock, IATA codes, whatever was left in this browser (test mode: not saved, site/testmode.js)
  if (P && P.setPref && P.getPrefs) for (const [k, v] of Object.entries({ mode: "traveler", timeRef: "airport", clock: 12, codes: "iata" })) if (String(P.getPrefs()[k]) !== String(v)) P.setPref(k, v);
  const showAll = async () => { if (A.state.filter !== "all") { A.state.filter = "all"; A.render(); } await later(w, 60); };
  const sheetText = async (iata) => { A.openSheet(iata); await later(w, 80); const s = doc.getElementById("sheet"); return s ? s.textContent.replace(/\s+/g, " ") : ""; };
  const closeSheet = () => { if (A.closeSheet) A.closeSheet(); };
  for (const x of list) {
    let ok = false, label = "", got = "";
    switch (x.t) {
      case "now": {
        const a = (A.state.data.airports || []).find((y) => y.iata === x.iata);
        const sm = a ? A.summary(a) : null, o = a ? A.outlook(a) : null, h = sm && sm.nowHour;
        const text = [o && o.headline, ...((h && h.reasons) || [])].join(" | ");
        ok = !!a && !!h && (x.level == null || sm.nowLevel === x.level) && (x.obs == null || !!h.obs === x.obs)
          && (!x.re || re(x.re).test(text)) && (!x.notRe || !new RegExp(x.notRe, "i").test(text));
        label = `${x.iata} now: ${[x.level != null && `level ${x.level}`, x.obs != null && (x.obs ? "the observed hour" : "the forecast hour"), x.re && `/${x.re}/`, x.notRe && `not /${x.notRe}/i`].filter(Boolean).join(", ")}`;
        got = a ? `level ${sm.nowLevel}, ${h && h.obs ? "observed" : h && h.fcNow ? "forecast (worded as one)" : "build hour " + (a.hours || []).indexOf(h)}: "${text}"` : "no such airport";
        break;
      }
      case "card": {
        await showAll();
        let c = doc.querySelector(`#list .card[data-iata="${x.iata}"]`);
        if (c) {
          c.scrollIntoView({ block: "center" });
          c.style.contentVisibility = "visible"; // Hidden QA frames cannot trigger viewport rendering.
          A.ensureCardTimeline?.(c);
          await later(w, 30);
        }
        // Card modules (traffic, delay words) may finish after the initial airport render.
        for (let n = 0; n < 15 && c && !new RegExp(x.re, "i").test(c.innerText.replace(/\s+/g, " ")); n++) {
          await later(w, 100);
          c = doc.querySelector(`#list .card[data-iata="${x.iata}"]`);
        }
        const t = c ? c.innerText.replace(/\s+/g, " ") : "";
        ok = !!c && new RegExp(x.re, "i").test(t);
        label = `${x.iata} card /${x.re}/`;
        got = c ? `card says "${t.slice(0, 200)}"` : "no card";
        break;
      }
      case "sheet": {
        const t = await sheetText(x.iata);
        closeSheet();
        ok = re(x.re).test(t);
        label = `${x.iata} sheet /${x.re}/`;
        got = `sheet says "${t.slice(0, 240)}"`;
        break;
      }
      case "national": {
        const s = await until(w, () => doc.getElementById("natstrip"), 1500);
        const t = s ? s.innerText.replace(/\s+/g, " ").trim() : "";
        ok = !!s && re(x.re).test(t);
        label = `national strip /${x.re}/`;
        got = s ? `strip says "${t}"` : "no #natstrip (the national strip comes with build2b)";
        break;
      }
      case "header":
      case "banner": {
        const id = x.t === "header" ? "updated" : "banner";
        const hit = await until(w, () => { const e = doc.getElementById(id); return e && re(x.re).test(e.textContent) ? e : null; }, 4000);
        const e = doc.getElementById(id);
        ok = !!hit;
        label = `${x.t} /${x.re}/`;
        got = e ? `says "${e.textContent.replace(/\s+/g, " ").trim().slice(0, 200)}"` : `no #${id}`;
        break;
      }
      case "noAirportBrief": {
        ok = !doc.getElementById("brief") && !doc.getElementById("briefWrap");
        label = "No standalone airport brief";
        got = ok ? "Flight context owns the brief" : "Standalone airport brief found";
        break;
      }
      case "today": { // brief hook
        A.openSheet(x.iata);
        await later(w, 80);
        doc.querySelector('#sheet [data-detail="today"]')?.click();
        await later(w, 60);
        const c = doc.querySelector("#mdSheet .bf-today");
        if (c) {
          c.scrollIntoView({ block: "center" });
          c.style.contentVisibility = "visible"; // Hidden QA frames cannot trigger viewport rendering.
          A.ensureCardTimeline?.(c);
          await later(w, 30);
        }
        const t = c ? c.innerText.replace(/\s+/g, " ").trim() : "";
        closeSheet();
        ok = !!c && re(x.re).test(t);
        label = `${x.iata} sheet "Today" /${x.re}/`;
        got = c ? `Today says "${t.slice(0, 240)}"` : "no Today card";
        break;
      }
      case "details": {
        const want = x.cards || ["why", "pilot", "plan"];
        const page = await openDetailsPage(w, doc, x.iata);
        const have = page ? [...page.querySelectorAll(":scope > section[data-md]")].map((e) => e.dataset.md) : [];
        const head = page ? (page.querySelector("#mdTitle") || {}).textContent : "";
        const plain = page ? detailsPlainText(doc) : "";
        const pct = /\d\s?%/.exec(plain);
        const code = CODES.exec(plain);
        const all = page ? page.textContent.replace(/\s+/g, " ") : "";
        ok = !!page && want.every((k) => have.includes(k)) && head === x.iata && !pct && !code && (!x.re || re(x.re).test(all));
        if (A.closeDetails) A.closeDetails();
        closeSheet();
        label = `${x.iata} "More details" opens with ${want.join(", ")}; no % or codes outside Pilot details${x.re ? ` /${x.re}/` : ""}`;
        got = !page ? "no More details row, or the page didn't open" : `cards ${have.join(", ") || "none"}; title "${head}"` +
          (pct ? `; "%" in "${plain.slice(Math.max(0, pct.index - 40), pct.index + 10)}"` : "") + (code ? `; code "${code[0]}" in "${plain.slice(Math.max(0, code.index - 40), code.index + 20)}"` : "");
        break;
      }
      case "airportDetail": {
        const page = await openDetailsPage(w, doc, x.iata, x.page);
        const text = page ? page.textContent.replace(/\s+/g, " ") : "";
        ok = !!page && re(x.re).test(text);
        label = `${x.iata} ${x.page} popup /${x.re}/`;
        got = page ? `popup says "${text.slice(0, 300)}"` : "menu row or popup missing";
        A.closeDetails(); closeSheet();
        break;
      }
      case "noPercent": {
        await showAll();
        const hits = [];
        const scan = (root, where) => {
          for (const el of root.querySelectorAll(".dl-line, .dl-block, .dl-routine, .sc-delay, #trips, .tflight, .mv-line, .mv-sum, #brief, .bf-today") /* brief hook */) {
            const t = el.textContent;
            if (/\d\s?%/.test(t)) hits.push(`${where}: "${t.trim().replace(/\s+/g, " ").slice(0, 70)}"`);
          }
        };
        scan(doc, "home");
        for (const a of A.state.data.airports.filter((y) => !y.trip)) {
          A.openSheet(a.iata);
          await later(w, 15);
          const s = doc.getElementById("sheet");
          if (s) scan(s, a.iata);
        }
        closeSheet();
        ok = !hits.length;
        label = "Traveler mode: delay chances in words, no % (cards, sheets, trips)";
        got = hits.slice(0, 3).join("; ");
        break;
      }
    }
    add(ok ? "pass" : "fail", `Expect on page: ${label}`, ok ? "" : [got, x.note ? `(${x.note})` : ""].filter(Boolean).join(" "));
  }
}

/**
 * Every view, every airport (run for each scenario and for live data, in a Traveler-mode 390 px frame):
 *   - one level: the card's pill equals the sheet headline's (the highest pill on the sheet's rest cards);
 *   - words and colours agree: the hours the card's headline names (site/outlook.js summary window) are all coloured
 *     at that level or higher on the card's timeline, and every forecast hour coloured above Clear says why (its
 *     lens label has a reason or delay word);
 *   - no visible text node reads "null", "undefined" or "NaN" (home, every sheet, the national panel, three More
 *     details pages);
 *   - Traveler text on cards and sheets (outside Pilot details and raw text) has no "%".
 * add(status, label, detail).
 */
/**
 * README "The observed next hour": an airport whose fresh METAR (within outlook.js OBS_NEXT_MAX, newer than the TAF
 * the current hour was read from) is VFR with no weather must not have a current hour that claims fog, low
 * visibility or low clouds now. Hours replaced by the observed hour 1 (obs) pass; a current hour still read from the
 * forecast but worded as one (fcNow) is reported, not failed. Fails on test data, warns on live data (an older build
 * without obsNext, or a fresher METAR the build hasn't seen).
 */
export function obsHourGuard(add, w, where = "") {
  const A = w.AWXApp, O = w.AWXOutlook;
  const now = A.refNow(), H = 3600e3, max = (O && O.OBS_NEXT_MAX) || 75 * 60e3;
  const LOW = /\b(fog|low visibility|low clouds|mist)\b/i, LOWR = /^(Visibility|Ceiling|Vertical visibility)\b|\b(Fog|Mist)\b/i;
  const bad = [], fixed = [], qualified = [];
  for (const a of A.state.data.airports || []) {
    const m = a.metar, hs = a.hours || [];
    const obs = Date.parse(m && m.obsTime);
    if (!m || !Number.isFinite(obs) || now - obs > max || m.fltCat !== "VFR" || m.wx) continue;
    const i = hs.findIndex((h) => Date.parse(h.t) <= now && now < Date.parse(h.t) + H);
    if (i < 1) continue; // hour 0 is the METAR's own
    const h = hs[i];
    if (h.obs) { fixed.push(a.iata); continue; }
    const basis = Date.parse(a.taf && a.taf.issued);
    if (Number.isFinite(basis) && obs <= basis) continue; // the forecast is newer than the observation
    const o = A.outlook(a);
    const claims = LOW.test((o && o.headline) || "") || (h.reasons || []).some((r) => LOWR.test(r));
    if (!claims) continue;
    if (h.fcNow && !/^(Dense fog|Low visibility|Fog|Low clouds)$/i.test((o && o.headline) || "")) { qualified.push(a.iata); continue; }
    bad.push(`${a.iata}: "${o && o.headline}" with METAR ${m.raw || m.obsTime}`);
  }
  add(bad.length ? (/live/.test(where) ? "warn" : "fail") : "pass", `A fresh clear METAR is never under a forecast fog / low cloud "Now"${where}`,
    bad.slice(0, 4).join("; ") || `${fixed.length} current hours from the observation${fixed.length ? " (" + fixed.slice(0, 6).join(", ") + ")" : ""}${qualified.length ? `; ${qualified.length} worded as forecast` : ""}`);
}

export async function consistencyChecks(add, w, doc, where = "") {
  const A = w && w.AWXApp;
  if (!A || !A.state || !A.state.data) { add("fail", `Consistency checks${where}`, "the app didn't load"); return; }
  try { obsHourGuard(add, w, where); } catch (e) { add("fail", `Observed next hour check${where}`, String(e.message || e)); }
  const P = w.AWXPrefs;
  if (P && P.setPref && P.getPrefs) for (const [k, v] of Object.entries({ mode: "traveler", timeRef: "airport", clock: 12, codes: "iata" })) if (String(P.getPrefs()[k]) !== String(v)) P.setPref(k, v);
  const LV = { Clear: 0, Minor: 1, Moderate: 2, High: 3, Severe: 4 };
  const BAD = /(^|[^A-Za-z])(null|undefined|NaN)([^A-Za-z]|$)/;
  const nulls = [], pct = [], levels = [], windows = [], unexplained = [];
  const scanText = (root, label) => {
    if (!root) return;
    const tw = doc.createTreeWalker(root, w.NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      const el = n.parentElement;
      if (!el || el.closest("script, style, .raw, pre")) continue;
      if (BAD.test(n.nodeValue)) nulls.push(`${label}: "${n.nodeValue.trim().slice(0, 50)}"`);
      if (/\d\s?%/.test(n.nodeValue) && !el.closest(".pilot, .lamp")) pct.push(`${label}: "${n.nodeValue.trim().slice(0, 50)}"`);
    }
  };
  A.state.filter = "all";
  A.render();
  await later(w, 80);
  scanText(doc.getElementById("list"), "home");
  scanText(doc.getElementById("national"), "national strip");
  const now = A.refNow();
  const H = 3600e3;
  // Hide the large airport list while inspecting sheets, avoiding repeated layout of every timeline.
  const listEl = doc.getElementById("list"), listDisplay = listEl.style.display;
  listEl.style.display = "none";
  let compared = 0, noPill = 0;
  for (const card of doc.querySelectorAll("#list .card[data-iata]")) {
    A.ensureCardTimeline?.(card); // Exercise every lazy timeline, including off-screen airports.
    const iata = card.dataset.iata;
    const a = A.state.data.airports.find((x) => x.iata === iata);
    if (!a) continue;
    const badgeLevels = [...card.querySelectorAll(".badge[data-level]")].map(el => Number(el.dataset.level));
    const cardLv = badgeLevels.length ? Math.max(...badgeLevels) : null;
    // Current severity stays primary; meaningful higher future risk has a separate neutral line.
    const sm = A.summary(a);
    const laterBadge = card.querySelector('.badge[data-phase="forecast"]');
    const currentLevel = sm.current?.kind === "unknown" ? null : (sm.current?.level ?? sm.nowLevel);
    if (laterBadge || !!card.querySelector(".card-forecast") !== !!(sm.later && sm.level >= 2)) levels.push(`${iata}: upcoming risk presentation disagrees with outlook`);
    if (cardLv !== currentLevel || card.dataset.level !== (currentLevel == null ? "unknown" : String(currentLevel))) levels.push(`${iata}: card ${cardLv}, current outlook ${currentLevel}`);
    if ((sm.later && sm.level >= 2) && !/Upcoming /.test(card.getAttribute("aria-label"))) levels.push(`${iata}: upcoming risk missing from accessibility label`);
    const tl = card.querySelector(".tl-wrap");
    const T = tl && tl._tl;
    if (T && sm.level >= 1 && Number.isFinite(sm.end)) {
      const inWin = T.slots.filter((s) => (s.kind === "now" || s.kind === "fc") && s.key + H > sm.start && s.key < sm.end);
      const low = inWin.filter((s) => !(s.level >= sm.level));
      if (low.length) windows.push(`${iata}: headline ${sm.level} ${new Date(sm.start).toISOString().slice(11, 16)}–${new Date(sm.end).toISOString().slice(11, 16)}Z, hours at ${low.map((s) => s.level).join("/")}`);
    }
    if (T && A.slotText) for (const s of T.slots) {
      if ((s.kind === "now" || s.kind === "fc") && s.level > 0 && A.slotText(s, a).split(" · ").length < 3) unexplained.push(`${iata} ${new Date(s.key).toISOString().slice(11, 16)}Z level ${s.level}`);
    }
    // The main card matches Now; Looking ahead may have a higher level.
    A.openSheet(iata);
    await later(w, 10);
    const sh = doc.getElementById("sheet");
    if (sm.later && !sh.querySelector(`#lookingAhead [data-level="${sm.level}"]`)) levels.push(`${iata}: later risk is missing from detail Looking ahead`);
    const ahead = sh.querySelector("#lookingAhead"), timeline = sh.querySelector(".tlsec"), log = sh.querySelector(".logcard:not(.ahead-card)");
    if (sh.querySelector(".boxwrap .sc-ahead")) levels.push(`${iata}: future outlook remains above the timeline`);
    if (ahead && (!timeline || !(timeline.compareDocumentPosition(ahead) & w.Node.DOCUMENT_POSITION_FOLLOWING) || log && !(ahead.compareDocumentPosition(log.parentElement) & w.Node.DOCUMENT_POSITION_FOLLOWING))) levels.push(`${iata}: Looking ahead is not between timeline and log`);
    const pills = [...sh.querySelectorAll('.bx-layer[data-layer="rest"] .sc-head[data-level]')].map(p => Number(p.dataset.level));
    if (pills.length) {
      compared++;
      const top = pills[0];
      if (top !== cardLv) levels.push(`${iata}: card ${cardLv}, sheet ${top}`);
    } else noPill++;
    const c = sh.cloneNode(true);
    c.querySelectorAll(".bx-layer:not(.on)").forEach((e) => e.remove());
    scanText(c, iata);
  }
  A.closeSheet();
  listEl.style.display = listDisplay;
  if (A.openNational) { A.openNational(); await later(w, 40); scanText(doc.getElementById("panel"), "national panel"); if (A.closePanel) A.closePanel(); }
  for (const a of A.state.data.airports.filter((x) => !x.trip).slice(0, 3)) {
    if (await openDetailsPage(w, doc, a.iata)) scanText(doc.getElementById("mdSheet"), a.iata + " More details");
    if (A.closeDetails) A.closeDetails();
    A.closeSheet();
  }
  void now;
  // A flight itinerary is additive: every leg is available alongside the standard airport sections.
  const trip = w.AWXTrips?._state().trips[0];
  if (trip) {
    A.openSheet(trip.legs[0].from);
    await later(w, 30);
    const sh = doc.getElementById("sheet");
    const rows = sh.querySelectorAll(".tflight [data-flight-leg]");
    const complete = rows.length >= trip.legs.length && sh.querySelector(".tlsec")
      && sh.querySelector('[data-detail="weather"]') && sh.querySelector('[data-detail="technical"]')
      && [...rows].every(row => row.querySelectorAll(".tfendpoint").length === 2 && row.querySelectorAll(".tftime").length === 2);
    add(complete ? "pass" : "fail", `Flights retain every leg and the standard airport view${where}`,
      `${rows.length} leg rows; airport timeline, Weather and More details remain available`);
    A.closeSheet();
  }
  add(levels.length ? "fail" : "pass", `One level${where}: card badge = current detail headline`, levels.slice(0, 4).join("; ") || `${compared} airports compared${noPill ? `, ${noPill} sheets show no level (data unknown)` : ""}`);
  add(windows.length ? "fail" : "pass", `Words and colours agree${where}: the headline's hours are coloured at its level`, windows.slice(0, 4).join("; ") || "every headline window");
  add(unexplained.length ? "fail" : "pass", `Every coloured hour says why${where}`, unexplained.slice(0, 4).join("; ") || "no unexplained hours");
  add(nulls.length ? "fail" : "pass", `No "null" / "undefined" / "NaN" in visible text${where}`, nulls.slice(0, 4).join("; ") || "home, sheets, national panel, More details");
  add(pct.length ? "fail" : "pass", `Traveler: no "%" on cards and sheets${where}`, pct.slice(0, 4).join("; ") || "cards and every sheet");
}
