// Phase 3: the "How accurate is this?" page, built from data/model/report.json (tools/train.mjs) and,
// before any training run, data/model/fallback.json. README "Delay model".
const root = document.getElementById("root");
const SMALL = 200; // hours: below this a number is labelled as a small sample

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const pct = (x, d = 0) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
const n0 = (x) => (x == null ? "–" : Math.round(x).toLocaleString("en-US"));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const my = (ym) => { const m = /^(\d{4})-(\d{2})/.exec(String(ym || "")); return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : ""; };
const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : ""; };
const card = (title, ...kids) => el("section", { class: "card" }, title ? el("h2", {}, title) : null, ...kids);
const monthsText = (list) => (list.length ? (list.length === 1 ? my(list[0]) : `${my(list[0])} – ${my(list[list.length - 1])}`) : "");

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}

const DEF_TEXT = "An hour at an airport counts as a real delay when at least a quarter of its departures or arrivals were 15+ minutes late because of weather or air traffic control (the FAA/BTS \"weather\" and \"NAS\" delay causes), or at least 5% of its flights were cancelled for those reasons. Hours with fewer than 5 flights are left out.";

function reliabilityChart(rel, relRule) {
  const W = 320;
  const H = 240;
  const P = { l: 36, r: 20, t: 10, b: 30 };
  const x = (v) => P.l + v * (W - P.l - P.r);
  const y = (v) => H - P.b - v * (H - P.t - P.b);
  const ns = "http://www.w3.org/2000/svg";
  const s = (tag, a) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Reliability: predicted chance versus how often delays happened" });
  for (let k = 0; k <= 4; k++) {
    const v = k / 4;
    svg.append(s("line", { x1: x(0), x2: x(1), y1: y(v), y2: y(v), class: "axis" }));
    const t = s("text", { x: P.l - 6, y: y(v) + 4, "text-anchor": "end" }); t.textContent = Math.round(v * 100) + "%"; svg.append(t);
    const u = s("text", { x: x(v), y: H - P.b + 16, "text-anchor": "middle" }); u.textContent = Math.round(v * 100) + "%"; svg.append(u);
  }
  svg.append(s("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), class: "diag" }));
  const max = Math.max(1, ...rel.map((b) => b.n), ...(relRule || []).map((b) => b.n));
  const r = (n) => 3 + 7 * Math.sqrt(n / max);
  const pts = rel.filter((b) => b.n >= 10 && b.meanP != null && b.rate != null);
  if (pts.length > 1) svg.append(s("polyline", { points: pts.map((b) => `${x(b.meanP)},${y(b.rate)}`).join(" "), class: "mline" }));
  for (const b of relRule || []) if (b.n >= 10 && b.meanP != null && b.rate != null) svg.append(s("circle", { cx: x(b.meanP), cy: y(b.rate), r: r(b.n), class: "rule", opacity: 0.75 }));
  for (const b of pts) svg.append(s("circle", { cx: x(b.meanP), cy: y(b.rate), r: r(b.n), class: "model" }));
  const lx = s("text", { x: (P.l + W - P.r) / 2, y: H - 2, "text-anchor": "middle" }); lx.textContent = "What we said"; svg.append(lx);
  return svg;
}

function summarySentences(rel) {
  const ok = rel.filter((b) => b.n >= 30 && b.rate != null);
  const pick = [];
  const low = ok.find((b) => b.lo === 0);
  const mid = ok.filter((b) => b.lo >= 0.2 && b.lo < 0.5).sort((a, b) => b.n - a.n)[0];
  const high = ok.filter((b) => b.lo >= 0.5).sort((a, b) => b.n - a.n)[0];
  for (const b of [high, mid, low]) if (b && !pick.includes(b)) pick.push(b);
  return pick.map((b) => {
    const said = b.lo === 0 ? `under ${Math.round(b.hi * 100)}%` : `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`;
    return el("p", { class: "say" }, "When we said ", el("b", {}, said), ", delays happened ", el("b", {}, pct(b.rate)), ` of the time (${n0(b.n)} hours${b.n < SMALL ? " — a small sample" : ""}).`);
  });
}

function renderReport(rep) {
  const T = rep.test;
  const kids = [];
  if (rep.fixtures) kids.push(el("div", { class: "banner" }, el("b", {}, "Fixture data. "), "These numbers come from a synthetic test world, not real flights."));
  // what is live
  const live = rep.live || {};
  const statusText = rep.deployed
    ? `The model trained ${day(rep.generated)} passed its safety check and is in use.`
    : live.basis === "model"
      ? `This month's retrained model didn't pass the safety check, so the model trained ${day(live.modelDate)} stays in use. The numbers below are the new model's test results.`
      : "No model has passed the safety check yet, so chances come from how often each risk level led to delays in the past. The numbers below are the candidate model's test results.";
  kids.push(el("div", { class: "card status" + (rep.deployed ? "" : " warn") },
    el("p", { class: "big" }, statusText),
    !rep.deployed && rep.gate && rep.gate.reasons.length ? el("p", { class: "small muted" }, "Why: " + rep.gate.reasons.join("; ") + ".") : null,
    el("p", { class: "small muted" }, `Tested on ${monthsText(rep.period.test)} — months the model never saw while learning${rep.period.winterInTest ? ", including winter" : " (no winter month yet)"}. Learned from ${monthsText(rep.period.train)}.`)));

  // plain summary
  kids.push(card("In plain words",
    ...summarySentences(T.reliability),
    el("p", { class: "small muted" }, `${n0(T.n)} airport-hours were checked across ${Object.keys(T.byAirport).length} airports. Delays happened in ${pct(T.base)} of them.`)));

  // reliability chart
  kids.push(card("Said vs. happened",
    reliabilityChart(T.reliability, T.reliabilityRule),
    el("div", { class: "legend" },
      el("span", {}, el("span", { class: "dot", style: "background:var(--l1)" }), "Delay chance"),
      el("span", {}, el("span", { class: "dot", style: "background:var(--l2)" }), "Old risk levels"),
      el("span", {}, "Dashed line = perfect")),
    el("p", { class: "small muted" }, "Dots on the dashed line mean the chance was right on average; bigger dots cover more hours. Groups with under 10 hours aren't drawn.")));

  // vs typical
  const vt = (T.vsTypical || []).filter((g) => g.n);
  if (vt.length) {
    kids.push(card("Compared with a usual hour",
      el("div", { class: "bars" }, vt.map((g) => el("div", { class: "bar" },
        el("span", {}, cap(g.label.replace(/ \(.*\)$/, ""))),
        el("span", { class: "muted" }, `${pct(g.rate)} vs usual ${pct(g.typical)}`),
        el("span", { class: "track" }, el("span", { class: "fill", style: `width:${Math.min(100, (g.rate || 0) * 100).toFixed(1)}%` }), el("span", { class: "typ", style: `left:${Math.min(100, (g.typical || 0) * 100).toFixed(1)}%` }))))),
      el("p", { class: "small muted" }, "When the chance was well above the usual rate for that airport and hour, delays really were more common — and less common when it was below. The tick marks the usual rate.")));
  }

  // skill
  const sk = T.bss || {};
  kids.push(card("Better than the alternatives?",
    el("p", { class: "say" }, `Compared with just quoting the usual rate for the airport, hour and month, the delay chance is `, el("b", {}, sk.climo == null ? "–" : sk.climo > 0 ? `${pct(sk.climo)} more accurate` : `${pct(-sk.climo)} less accurate`), "."),
    el("p", { class: "say" }, "Compared with the old risk levels (each level turned into its historical delay rate): ", el("b", {}, sk.rule == null ? "–" : sk.rule > 0 ? `${pct(sk.rule)} more accurate` : `${pct(-sk.rule)} less accurate`), "."),
    T.catch ? el("p", { class: "say" }, `Of the hours that had real delays, ${pct(T.catch.model50.pod)} had a chance of 50% or more; the old High/Severe levels flagged ${pct(T.catch.ruleHigh.pod)}. When we said 50% or more, delays didn't happen ${pct(T.catch.model50.far)} of the time.`) : null,
    T.minutes && T.minutes.n ? el("p", { class: "say" }, `When delays happened, the expected delay length was off by a median of ${T.minutes.medianAbsError} minutes.`) : null,
    el("p", { class: "small muted" }, `Accuracy here is the Brier score (lower is better): ${fmt3(T.brier.model)} for the delay chance, ${fmt3(T.brier.climo)} for the usual rate, ${fmt3(T.brier.rule)} for the old levels. Ranking ability (AUC, 0.5 = guessing): ${fmt3(T.auc.model)}.`)));

  // by lead
  if (T.byLead) {
    kids.push(card("By how far ahead",
      el("div", { class: "tablewrap" }, el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Ahead"), el("th", {}, "Hours"), el("th", {}, "vs usual"), el("th", {}, "vs old levels"))),
        el("tbody", {}, Object.entries(T.byLead).map(([k, s]) => el("tr", {}, el("td", {}, k.replace("-", "–") + " hr"), el("td", {}, n0(s.n)), el("td", {}, pct(s.bss.climo)), el("td", {}, pct(s.bss.rule)))))))));
  }

  // per airport
  const aps = Object.entries(T.byAirport || {}).sort((a, b) => b[1].n - a[1].n);
  if (aps.length) {
    kids.push(card("By airport",
      el("div", { class: "tablewrap" }, el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Airport"), el("th", {}, "Hours"), el("th", {}, "Delays"), el("th", {}, "vs usual"), el("th", {}, "vs old levels"))),
        el("tbody", {}, aps.map(([ap, s]) => el("tr", {},
          el("td", {}, ap), el("td", {}, n0(s.n) + (s.n < SMALL ? "*" : "")), el("td", {}, pct(s.base)),
          el("td", {}, s.bss.climo == null ? "–" : pct(s.bss.climo)), el("td", {}, s.bss.rule == null ? "–" : pct(s.bss.rule))))))),
      el("p", { class: "small muted" }, `"vs usual" / "vs old levels": how much more accurate the delay chance was than quoting the usual rate or the old risk levels. Negative numbers mean the delay chance did worse than that alternative at that airport. * fewer than ${SMALL} hours: too few to judge.`)));
  }

  kids.push(card("What counts as a delay", el("p", { class: "say" }, (rep.def && rep.def.text) || DEF_TEXT)));
  kids.push(card("How it works",
    el("dl", { class: "def" },
      el("dt", {}, "Data"), el("dd", {}, `${rep.period.months} months of FAA/BTS on-time records (${monthsText([rep.period.since, rep.period.through])}) with the airport forecasts (TAFs) and weather reports that were current at the time.`),
      el("dt", {}, "Model"), el("dd", {}, "A statistical model weighs the forecast (storms, low clouds, visibility, wind and crosswind, snow and ice), the weather right now, weather at the airline hub, the hour, day and season, and the airport's own history; then its chances are adjusted so that, on held-out months, \"60%\" really meant about 60%."),
      el("dt", {}, "FAA programs"), el("dd", {}, "When the FAA has a ground stop or ground delay program in effect, delays are happening: the chance shows as \"Now\" with the FAA's average delay."),
      el("dt", {}, "Safety check"), el("dd", {}, "Each retrained model goes live only if, on the test months, it beats both the usual rate and the old risk levels. Otherwise the previous one stays."))));
  root.replaceChildren(...kids);
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmt3 = (x) => (x == null ? "–" : x.toFixed(3));

function renderSeedOnly(fb) {
  const kids = [];
  kids.push(el("div", { class: "card status warn" },
    el("p", { class: "big" }, "The delay model hasn't been trained yet."),
    el("p", { class: "say" }, "Until it is, each chance is how often that risk level led to real delays in past flight records" + (fb && fb.since ? ` (${my(fb.since)}${fb.through && fb.through !== fb.since ? " – " + my(fb.through) : ""})` : "") + ".")));
  if (fb && fb.levels) {
    const names = ["Clear", "Minor", "Moderate", "High", "Severe"];
    const lead = Object.keys(fb.levels);
    const head = el("thead", {}, el("tr", {}, el("th", {}, "Level"), ...lead.map((k) => el("th", {}, k.replace("-", "–") + " hr"))));
    const body = el("tbody", {}, names.map((nm, i) => el("tr", {}, el("td", {}, nm), ...lead.map((k) => el("td", {}, pct(fb.levels[k][i]))))));
    kids.push(card("Risk level → how often delays happened",
      el("div", { class: "tablewrap" }, el("table", {}, head, body)),
      el("p", { class: "small muted" }, "Columns: how far ahead the forecast was."),
      fb.note ? el("p", { class: "small muted" }, fb.note) : null));
  }
  kids.push(card("What counts as a delay", el("p", { class: "say" }, DEF_TEXT)));
  root.replaceChildren(...kids);
}

(async () => {
  let rep = null;
  let fb = null;
  try { fb = await getJson("./data/model/fallback.json"); } catch (e) { /* none */ }
  // the seed fallback (before the first training run) means there is no report.json yet: don't ask for it
  if (!fb || fb.source !== "seed") {
    try { rep = await getJson("./data/model/report.json"); } catch (e) {
      if (e.status !== 404) { root.replaceChildren(el("p", { class: "muted" }, "Couldn't load the accuracy report. Try again later.")); return; }
    }
  }
  if (rep && rep.test && rep.test.reliability) renderReport(rep);
  else if (fb) renderSeedOnly(fb);
  else root.replaceChildren(el("p", { class: "muted" }, "No accuracy report yet."));
})();
