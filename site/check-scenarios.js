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
// Page assertions:
//   {t:"card", iata, re}   the airport's card on the All list
//   {t:"sheet", iata, re}  the airport's sheet (text, including closed "Why?" parts)
//   {t:"national", re}     the national strip (#natstrip)
//   {t:"header", re}       the "Updated …" / "Live data unavailable …" line
//   {t:"banner", re}       the banner area
//   {t:"noPercent"}        Traveler mode: no "%" in delay-chance text (cards, every sheet, trips)
//   {t:"brief", re, favs?} the morning brief, opened as the menu does (AWXBrief.open), with these starred airports (brief hook)
//   {t:"today", iata, re}  the airport sheet's "Today" card (brief hook)
import { tripStatus } from "./trip-risk.js";

const DATA = new Set(["words", "badge", "noFaa", "opsplan", "atcscc", "alert", "spc", "sigmet", "model", "movement", "airlineAlert", "tripConcern", "hourLevel", "hourReason", "cascade", "noCascade", "change"]); // brief hook: change
const PAGE = new Set(["card", "sheet", "national", "header", "banner", "noPercent", "brief", "today"]); // brief hook: brief, today
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

const later = (w, ms) => new Promise((r) => w.setTimeout(r, ms));
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
  if (P && P.setPref && P.getPrefs && P.getPrefs().mode !== "traveler") P.setPref("mode", "traveler"); // test mode: not saved (site/testmode.js)
  const showAll = async () => { if (A.state.filter !== "all") { A.state.filter = "all"; A.render(); } await later(w, 60); };
  const sheetText = async (iata) => { A.openSheet(iata); await later(w, 80); const s = doc.getElementById("sheet"); return s ? s.textContent.replace(/\s+/g, " ") : ""; };
  const closeSheet = () => { if (A.closeSheet) A.closeSheet(); };
  for (const x of list) {
    let ok = false, label = "", got = "";
    switch (x.t) {
      case "card": {
        await showAll();
        const c = doc.querySelector(`#list .card[data-iata="${x.iata}"]`);
        const t = c ? c.innerText.replace(/\s+/g, " ") : "";
        ok = !!c && re(x.re).test(t);
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
      case "brief": { // brief hook: opened the way the menu does, whatever the time of day
        const B = w.AWXBrief;
        if (x.favs && A.setFavs) A.setFavs(x.favs); // test mode: not saved (site/testmode.js)
        if (B) { B.open(); await later(w, 60); }
        const e = doc.getElementById("brief");
        const t = e && !e.hidden ? e.innerText.replace(/\s+/g, " ").trim() : "";
        ok = !!t && re(x.re).test(t) && !/\d\s?%/.test(t);
        label = `morning brief /${x.re}/`;
        got = !B ? "site/brief.js didn't load" : t ? `brief says "${t.slice(0, 240)}"` : "no brief shown";
        break;
      }
      case "today": { // brief hook
        A.openSheet(x.iata);
        await later(w, 80);
        const c = doc.querySelector("#sheet .bf-today");
        const t = c ? c.innerText.replace(/\s+/g, " ").trim() : "";
        closeSheet();
        ok = !!c && re(x.re).test(t);
        label = `${x.iata} sheet "Today" /${x.re}/`;
        got = c ? `Today says "${t.slice(0, 240)}"` : "no Today card";
        break;
      }
      case "noPercent": {
        await showAll();
        const hits = [];
        const scan = (root, where) => {
          for (const el of root.querySelectorAll(".dl-line, .dl-block, .sc-delay, #trips, .tflight, #brief, .bf-today") /* brief hook */) {
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
