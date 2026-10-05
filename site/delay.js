// Phase 3: "Will it cause delays?" — renders the delay model's numbers from status.json
// (airports[].hours[].delay, top-level delayModel; README "Delay model"). No scoring happens here.
//   likelihood(delay, opts)       plain words for a delay chance (build2b): "Delays likely · higher than usual"
//   delayLine(airport)            card line: "Delays likely 6–9 PM · higher than usual"
//   delayBlock(airport, hourIdx)  sheet card (hourIdx null = the peak window); brief outlook; technical explanation is visible in Aviation mode
// Traveler mode never shows a percentage; Aviation mode adds the calibrated % in brackets.
// Loaded as a module by index.html; app.js calls it through window.AWXDelay (marked "phase3 hook").

const HOUR = 3600e3;
const STYLE = `
.dl-line { margin-top: 6px; font-size: 14px; font-weight: 600; line-height: 1.3; }
.dl-line .dl-usual, .dl-line .dl-src { font-weight: 500; color: var(--muted); }
.dl-hi { color: var(--l3); } .dl-mid { color: var(--l2); } .dl-lo { color: var(--text); }
.dl-block { background: var(--card-2); border-radius: 16px; padding: 12px 14px; margin-bottom: 10px; }
.dl-block h3 { margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.dl-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.dl-big { font-size: 21px; line-height: 1.2; font-weight: 800; letter-spacing: -.02em; }
.dl-what { font-size: 15px; font-weight: 600; }
.dl-usual-b { margin-top: 4px; font-size: 14px; color: var(--muted); }
.dl-min, .dl-now, .dl-faa { margin-top: 6px; font-size: 14px; }
.dl-analog { margin-top: 8px; font-size: 13.5px; line-height: 1.4; color: var(--text); opacity: .9; }
.dl-srcline { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }
.dl-why { margin-top: 8px; }
.dl-srcline a:focus-visible { outline: 2px solid var(--l1); outline-offset: 2px; border-radius: 4px; }
.dl-why-h { font-size: 15px; font-weight: 700; line-height: 1.3; }
.dl-whyc .dl-analog:first-of-type { margin-top: 6px; }
.dl-acc { display: inline-flex; align-items: center; min-height: 44px; margin-top: 2px; font-size: 14px; font-weight: 600; color: var(--brand, var(--l1)); text-decoration: none; }
.dl-acc:focus-visible { outline: 2px solid var(--l1); outline-offset: 2px; border-radius: 4px; }
`;

function injectStyle() {
  if (document.getElementById("dl-style")) return;
  const s = document.createElement("style");
  s.id = "dl-style";
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
function fmt(tz, opts, key) {
  const k = tz + key;
  if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, opts)));
  return fmts.get(k);
}
const tidy = (s) => s.replace(/[  ]/g, " ");
const clock = (ms, tz) => (window.AWXApp && AWXApp.clock ? AWXApp.clock(ms, tz) : tidy(fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "hm").format(ms)).replace(":00 ", " ")); // build2b hook: 12/24-hour setting
const tzOf = (a) => (window.AWXApp && AWXApp.dispTz ? AWXApp.dispTz(a) : a.tz); // build2b hook: airport or my time zone
const dayKey = (ms, tz) => fmt(tz, { year: "numeric", month: "numeric", day: "numeric" }, "ymd").format(ms);
const refNow = () => {
  const st = window.AWXApp && window.AWXApp.state;
  return st && st.sample && st.data ? Date.parse(st.data.generated) : Date.now();
};
function dayPrefix(ms, tz) {
  const now = refNow();
  if (dayKey(ms, tz) === dayKey(now, tz)) return "";
  if (dayKey(ms, tz) === dayKey(now + 24 * HOUR, tz)) return "tomorrow ";
  return fmt(tz, { weekday: "short" }, "wd").format(ms) + " ";
}
/** "6–9 PM", "11 AM – 2 PM", "tomorrow 6–9 AM", "through 9 PM" (window starting now). */
function rangeLabel(start, end, tz, fromNow) {
  const b = clock(end, tz);
  if (fromNow) return "through " + dayPrefix(end, tz) + b;
  const a = clock(start, tz);
  const pre = dayPrefix(start, tz);
  const endDay = dayKey(end - 1, tz); // a window ending at midnight stays on its day ("7 PM – 12 AM")
  if (dayKey(start, tz) === endDay && a.split(" ").pop() === b.split(" ").pop()) return pre + a.slice(0, a.lastIndexOf(" ")) + "–" + b;
  if (dayKey(start, tz) === endDay) return pre + a + " – " + b;
  const suffix = !pre && dayPrefix(end, tz) === "tomorrow " ? " tomorrow" : " " + dayPrefix(end, tz).trim();
  return pre + a + " – " + b + suffix;
}
const NOW_KINDS = { ground_stop: "FAA ground stop", ground_delay: "FAA ground delay program", delay: "FAA-reported delays", closure: "Airport closed" }; // closures hook

// ---------- likelihood words (build2b) ----------

let REPORT = null; // data/model/report.json (test reliability table and per-airport skill); loaded once below
export function setReport(r) { REPORT = r && r.test ? r : null; }
const MIN_BIN = 200; // supported hours a reliability bin needs before its word is trusted
const LOW_SKILL = 0.02; // Brier skill vs climatology at or below this: cap at "Delays possible"
const WORDS = [
  ["unlikely", "Delays unlikely"],
  ["small", "Small chance of delays"],
  ["usual", "Usual delays"],
  ["possible", "Delays possible"],
  ["likely", "Delays likely"],
  ["very", "Delays very likely"],
];
const WORD = Object.fromEntries(WORDS);
const STEP_DOWN = { very: "likely", likely: "possible", possible: "small", small: "unlikely", usual: "unlikely", unlikely: "unlikely" };
const RANK = { unlikely: 0, small: 1, usual: 1, possible: 2, likely: 3, very: 4 };

/**
 * The model score already includes isotonic calibration fitted before the test period.
 * Holdout outcomes explain sample support; they must never fit another score mapping.
 */
export function calibrate(p, report = REPORT) {
  const support = report && (report.displaySupport || report.test);
  const rel = support && Array.isArray(support.reliability) ? support.reliability : null;
  if (!rel || p == null || !Number.isFinite(Number(p))) return { rate: p, bin: null };
  p = Number(p);
  const bin = rel.find((b) => p >= b.lo && (p < b.hi || (b.hi >= 1 && p <= 1))) || null;
  return { rate: p, bin };
}

/** "typically 30–45 min": the median ± 10, rounded to 5, never one number. */
export function minutesRange(m) {
  if (m == null || !Number.isFinite(Number(m))) return "";
  const r5 = (x) => Math.max(5, Math.round(x / 5) * 5);
  const lo = r5(Number(m) - 10), hi = Math.max(lo + 10, r5(Number(m) + 10));
  return `typically ${lo}–${hi} min`;
}

const FAA_NOW = { ground_stop: true, ground_delay: true, delay: true, closure: true }; // closures hook: a closed airport is "happening now", never "very likely"
/**
 * Plain, conservative words for one hour's delay numbers ({p, pTypical, minutes, minutesFrom, override}):
 * {key, word, sentence, cue, rate, size}. opts: {iata, report, aviation}. Rules (README "Delay words"):
 * FAA ground stop / delay program / reported delays / full airport closure in effect -> "Delays happening now" (+ the FAA average);
 * else the calibrated observed rate: < 12% unlikely; 12–25% "Usual delays" within ±25% of the typical rate, else
 * "Small chance"; 25–45% possible; 45–70% likely; >= 70% very likely only when that bin's observed rate was >= 70%
 * over >= 200 test hours. A bin with < 200 test hours steps down one word; airports where the model's skill vs
 * climatology is <= 0.02 are capped at "Delays possible". Cue: "higher than usual" at >= 1.25x the typical rate,
 * "lower than usual" at <= 0.75x.
 */
export function likelihood(d, opts = {}) {
  if (!d || d.p == null) return null;
  const report = opts.report !== undefined ? opts.report : REPORT;
  const aviation = opts.aviation !== undefined ? opts.aviation : !!(globalThis.AWXPrefs && globalThis.AWXPrefs.getPrefs().mode === "aviation");
  if (Number(d.p) >= 1 && FAA_NOW[d.override]) {
    const avg = d.minutes && d.minutesFrom === "faa" ? `FAA average about ${Math.round(d.minutes)} min` : "";
    return { key: "now", word: "Delays happening now", sentence: "Delays happening now" + (avg ? " · " + avg : ""), cue: "", rate: 1, size: avg };
  }
  const { rate, bin } = calibrate(Number(d.p), report);
  const support = report && (report.displaySupport || report.test);
  const ap = opts.iata && support && support.byAirport && support.byAirport[opts.iata];
  if (d.modelCoverage === "pooled" || report && opts.iata && !ap) {
    return { key: "unknown", word: "Delay forecast uncertain", sentence: "Delay forecast uncertain · no airport-specific accuracy history", cue: "", rate, size: "" };
  }
  const typ = d.pTypical != null ? Number(d.pTypical) : null;
  let key;
  if (rate < 0.12) key = "unlikely";
  else if (rate < 0.25) key = typ != null && Math.abs(rate - typ) <= 0.25 * typ ? "usual" : "small";
  else if (rate < 0.45) key = "possible";
  else if (rate < 0.7) key = "likely";
  else key = "very";
  const small = !!report && (!bin || !(bin.n >= MIN_BIN));
  if (key === "very" && !(bin && bin.rate >= 0.7 && bin.n >= MIN_BIN)) key = "likely"; // the one step down for this bin
  else if (small) key = STEP_DOWN[key];
  const skill = ap && ap.bss ? ap.bss.climo : null;
  if (skill != null && skill <= LOW_SKILL && RANK[key] > RANK.possible) key = "possible";
  const cue = typ > 0 && d.typicalScope !== "pooled" ? (rate >= 1.25 * typ ? "higher than usual" : rate <= 0.75 * typ ? "lower than usual" : "") : "";
  const word = WORD[key] + (aviation ? ` (${Math.round(rate * 100)}%)` : "");
  const size = key !== "unlikely" ? minutesRange(d.minutes) : "";
  return { key, word, sentence: word + (cue ? " · " + cue : ""), cue, rate, size };
}
/** Routine airport delay rates do not count as an operational disruption. */
export function notable(d, level, L) {
  if (!L || ["unknown", "unlikely", "small", "usual"].includes(L.key)) return false;
  return L.key === "now" || level > 0 || /^possible_/.test(d?.override || "") || L.cue === "higher than usual" && L.rate >= 0.45;
}
/** The band of an observed share (the same cut-offs as likelihood(), without calibration or caps). */
export function bandOf(rate) {
  return rate < 0.12 ? 0 : rate < 0.25 ? 1 : rate < 0.45 ? 2 : rate < 0.7 ? 3 : 4;
}
/** An analog {n, k} agrees with the words L when its share is in the same band or one apart. */
export function analogAgrees(an, L) {
  if (!an || !an.n || !L) return false;
  if (L.key === "now") return an.k / an.n >= 0.45;
  return Math.abs(bandOf(an.k / an.n) - RANK[L.key]) <= 1;
}
/** "about 6 in 10" for a share. */
export const inTen = (x) => `about ${Math.max(0, Math.min(10, Math.round(Number(x) * 10)))} in 10`;
/** Analog sentence without percentages: "…, 131 (61%) had delays…" -> "…, about 6 in 10 had delays…". */
export function analogWords(an) {
  if (!an || !an.text) return "";
  let t = String(an.text).replace(/(\d[\d,]*) \((\d+)%\) had/, (all, k, p) => `${inTen(Number(p) / 100)} had`);
  if (/%/.test(t) && an.n) t = t.replace(/[\d.]+%/g, inTen(an.k / an.n));
  return t;
}

/** {i (peak hour), s, e (window), p} over the 24 hours, or null without delay numbers. */
function peakWindow(a, include = () => true) {
  const hs = a.hours || [];
  let i = -1;
  hs.forEach((h, k) => { if (h.delay && h.delay.p != null && include(h) && (i < 0 || h.delay.p > hs[i].delay.p)) i = k; });
  if (i < 0) return null;
  const p = hs[i].delay.p;
  const near = (k) => hs[k] && include(hs[k]) && hs[k].delay && hs[k].delay.p != null && hs[k].delay.p >= p - 0.1;
  let s = i;
  let e = i;
  while (near(s - 1)) s--;
  while (near(e + 1)) e++;
  return { i, s, e, p };
}


/** Card line under the reason: plain words (no % in Traveler mode). Returns an element, or null when there are no delay numbers. */
export function delayLine(a) {
  injectStyle();
  const w = a && peakWindow(a);
  if (!w) return null;
  const h0 = a.hours[0].delay;
  const L0 = h0 ? likelihood(h0, { iata: a.iata }) : null;
  if (L0 && L0.key === "now") return el("div", "dl-line dl-hi", L0.sentence, NOW_KINDS[h0.override] ? el("span", "dl-usual", " · " + NOW_KINDS[h0.override]) : null);
  const d = a.hours[w.i].delay;
  const L = likelihood(d, { iata: a.iata });
  const cls = RANK[L.key] >= 3 ? "dl-hi" : RANK[L.key] === 2 ? "dl-mid" : "dl-lo";
  const start = Date.parse(a.hours[w.s].t);
  const end = Date.parse(a.hours[w.e].t) + HOUR;
  const when = L.key === "unlikely" || (w.s === 0 && w.e === a.hours.length - 1) ? "" : " " + rangeLabel(start, end, tzOf(a), w.s === 0);
  return el("div", "dl-line " + cls, L.word + when, L.cue ? el("span", "dl-usual", " · " + L.cue) : null);
}

function monthYear(ym) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ym || ""));
  return m ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1] + " " + m[1] : "";
}
/** "Jun–Jul 2026", "Aug 2024 – Jul 2026". */
function spanLabel(a, b) {
  const A = monthYear(a);
  const B = monthYear(b);
  if (!A || !B || A === B) return A || B;
  return A.slice(-4) === B.slice(-4) ? A.slice(0, 3) + "–" + B : A + " – " + B;
}
function sourceLine() {
  const st = window.AWXApp && window.AWXApp.state;
  const info = st && st.data && st.data.delayModel;
  const parts = [];
  if (info) {
    const span = info.months ? `${info.months} months` : "";
    if (info.basis === "model") parts.push(`Based on ${span || "past"} of FAA/BTS flight records${info.since ? " since " + monthYear(info.since) : ""}`);
    else parts.push(info.source === "seed"
      ? `Based on how often each risk level led to delays in ${spanLabel(info.since, info.through)} FAA/BTS flight records`
      : `Based on how often each risk level led to delays in ${span || "past"} of FAA/BTS flight records`);
    const u = /^(\d{4})-(\d{2})-(\d{2})/.exec(info.updated || "");
    if (u) parts.push((info.basis === "model" ? "model updated " : "updated ") + `${monthYear(u[1] + "-" + u[2]).split(" ")[0]} ${+u[3]}, ${u[1]}`);
  } else parts.push("Based on FAA/BTS flight records");
  return el("div", "dl-srcline", parts.join(" · ")); // the accuracy page is in the menu
}

const isAviation = () => !!(globalThis.AWXPrefs && globalThis.AWXPrefs.getPrefs().mode === "aviation");
/** The window the sheet's "Delay outlook" card shows (null = the card is left out): every hour in Aviation mode, else notable ones. */
function cardWindow(a, aviation = isAviation()) {
  const include = (hr) => {
    const L = likelihood(hr.delay, { iata: a.iata });
    return aviation || L?.key !== "now" && notable(hr.delay, hr.level, L);
  };
  return a ? peakWindow(a, include) : null;
}

// ---------- routine outlook line (the sheet's one line when the Delay outlook card is left out) ----------

const PARTS = [[0, "overnight"], [5, "morning"], [12, "afternoon"], [17, "evening"], [21, "night"]];
const PART_PHRASE = { overnight: "overnight", morning: "this morning", afternoon: "this afternoon", evening: "this evening", night: "tonight" };
const localHour = (ms, tz) => Number(fmt(tz, { hour: "numeric", hourCycle: "h23" }, "h23").format(ms)) % 24;
const partOf = (ms, tz) => { const h = localHour(ms, tz); let p = PARTS[0][1]; for (const [from, name] of PARTS) if (h >= from) p = name; return p; };
/**
 * "today", "this evening", "this afternoon and evening", "tonight" for a window [start, end) in the airport's local
 * day; whole = the window is every remaining hour of the day.
 */
export function dayPartPhrase(start, end, tz, whole = false) {
  const parts = [];
  for (let t = start; t < end; t += HOUR) { const p = partOf(t, tz); if (!parts.includes(p)) parts.push(p); }
  if (!parts.length) return "today";
  if (parts.length >= 3 || (whole && parts.length > 1 && parts[0] !== "evening")) return "today";
  if (parts.length === 1) return PART_PHRASE[parts[0]];
  if (parts[0] === "evening" && parts[1] === "night") return "tonight";
  return PART_PHRASE[parts[0]] + " and " + (parts[1] === "night" ? "tonight" : parts[1]);
}
/**
 * One short Traveler line for routine conditions over the rest of the airport's local day, in likelihood() words:
 * the strongest band (highest word, then highest calibrated rate) and its time window, e.g. "Delays unlikely today",
 * "Usual delays this evening", "Delays possible this afternoon · typically 15–30 min" (the size only from
 * "possible" up). Null when there are no delay numbers left today or delays are happening now (FAA program).
 * Returns {i (hour index), L, key, start, end, when, text}. Never a percentage.
 */
export function routineOutlook(a, now = refNow()) {
  const hs = (a && a.hours) || [];
  const tz = a && a.tz;
  if (!tz) return null;
  const today = dayKey(now, tz);
  const idx = [];
  hs.forEach((h, i) => { const t = Date.parse(h.t); if (t + HOUR > now && dayKey(t, tz) === today && h.delay && h.delay.p != null) idx.push(i); });
  if (!idx.length) return null;
  const Ls = idx.map((i) => likelihood(hs[i].delay, { iata: a.iata, aviation: false }));
  if (Ls.some((L) => !L || L.key === "now" || L.key === "unknown")) return null;
  let b = 0;
  Ls.forEach((L, k) => { if (RANK[L.key] > RANK[Ls[b].key] || (RANK[L.key] === RANK[Ls[b].key] && L.rate > Ls[b].rate)) b = k; });
  const key = Ls[b].key;
  let s = b, e = b;
  while (s > 0 && Ls[s - 1].key === key && idx[s - 1] === idx[s] - 1) s--;
  while (e + 1 < idx.length && Ls[e + 1].key === key && idx[e + 1] === idx[e] + 1) e++;
  const start = Math.max(Date.parse(hs[idx[s]].t), Math.floor(now / HOUR) * HOUR);
  const end = Date.parse(hs[idx[e]].t) + HOUR;
  const when = dayPartPhrase(start, end, tz, s === 0 && e === idx.length - 1);
  const size = RANK[key] >= RANK.possible ? Ls[b].size : "";
  return { i: idx[b], L: Ls[b], key, start, end, when, text: WORD[key] + " " + when + (size ? " · " + size : "") };
}

/**
 * The hour behind the sheet's delay headline: the Delay outlook card's hour when the card shows, else the routine
 * line's, else the current hour. {i, L, from: "card" | "routine" | "now", routine?} or null without delay numbers.
 */
export function outlookHour(a, now = refNow()) {
  const w = cardWindow(a);
  if (w) return { i: w.i, s: w.s, e: w.e, L: likelihood(a.hours[w.i].delay, { iata: a.iata }), from: "card" };
  const r = routineOutlook(a, now);
  if (r) return { i: r.i, L: r.L, from: "routine", routine: r };
  const d = a && a.hours && a.hours[0] && a.hours[0].delay;
  return d && d.p != null ? { i: 0, L: likelihood(d, { iata: a.iata }), from: "now" } : null;
}

/**
 * More details → "Why this outlook": the similar-days comparison ("In 707 similar evening hours at ORD …, about 5
 * in 10 had delays …"; left out when it contradicts the headline band, analogAgrees), how often outlooks like this
 * were right, what the numbers are based on, and a link to the accuracy page. Counts as "about N in 10", never %.
 * Always returns an element.
 */
export function whyBlock(a, now = refNow()) {
  injectStyle();
  const o = a ? outlookHour(a, now) : null;
  const kids = [];
  if (!o || !o.L) {
    kids.push(el("div", "dl-analog", "No delay numbers for this airport right now."));
  } else {
    const d = a.hours[o.i].delay;
    const L = o.L;
    let head = L.key === "unknown" ? L.sentence : L.word;
    if (o.from === "routine") head = o.routine.text;
    else if (o.from === "card" && L.key !== "now") {
      const start = Date.parse(a.hours[o.s].t), end = Date.parse(a.hours[o.e].t) + HOUR;
      head = L.word.replace(/^Delays/, "Flight delays") + " " + (o.s === 0 && o.e === a.hours.length - 1 ? "in the next 24 hours" : rangeLabel(start, end, tzOf(a), o.s === 0));
    }
    kids.push(el("div", "dl-why-h", head));
    const an = analogWords(d.analog);
    if (an && analogAgrees(d.analog, L)) kids.push(el("div", "dl-analog", an));
    const { bin } = calibrate(Number(d.p));
    if (L.key !== "now" && L.key !== "unknown" && bin && bin.rate != null && bin.n) {
      kids.push(el("div", "dl-analog", RANK[L.key] >= RANK.possible
        ? `Across airports, warnings like this were followed by delays ${inTen(bin.rate)} times.`
        : `Across airports, hours given this outlook had delays ${inTen(bin.rate)} times.`));
    }
    if (d.pTypical != null && d.typicalScope !== "pooled" && L.key !== "now") kids.push(el("div", "dl-analog", `On a typical day at this hour, delays happen ${inTen(d.pTypical)} times.`));
  }
  kids.push(sourceLine());
  const link = document.createElement("a");
  link.className = "dl-acc";
  link.href = "accuracy.html";
  link.textContent = "How accurate are the delay chances? ›";
  kids.push(link);
  return el("div", "dl-whyc", ...kids);
}

/**
 * The sheet's headline outlook, shown inside the top Now card: the Traveler peak window's words ("Flight delays
 * likely"), its time ("5–9 PM") and size ("typically 55–75 min"). Null when that window isn't notable or delays
 * are happening now (the FAA program is the headline then). Never a percentage.
 */
export function outlookLead(a) {
  injectStyle();
  const w = cardWindow(a, false);
  if (!w) return null;
  const hr = a.hours[w.i];
  const d = hr && hr.delay;
  if (!d || d.p == null) return null;
  const L = likelihood(d, { iata: a.iata, aviation: false });
  if (!L || L.key === "now" || L.key === "unknown" || !notable(d, hr.level, L)) return null;
  const start = Date.parse(a.hours[w.s].t), end = Date.parse(a.hours[w.e].t) + HOUR;
  const when = w.s === 0 && w.e === a.hours.length - 1 ? "in the next 24 hours" : rangeLabel(start, end, tzOf(a), w.s === 0);
  const notes = [];
  if (d.modelCoverage === "pooled") notes.push("No airport-specific delay history; estimate uses other airports.");
  if (globalThis.AWXApp?.state.data?.delayModel?.basis !== "model") notes.push(sourceLine().textContent);
  if (/^possible_/.test(d.override || "")) notes.push("The FAA plans a possible " + (d.override === "possible_ground_stop" ? "ground stop" : "ground delay program") + ".");
  return { t: hr.t, start, key: L.key, word: L.word.replace(/^Delays/, "Flight delays"), when, size: L.size || "", cue: L.cue || "",
    cls: RANK[L.key] >= 3 ? "dl-hi" : RANK[L.key] === 2 ? "dl-mid" : "dl-lo", notes };
}

/**
 * Sheet card "Will it cause delays?" for hour i (null = the peak window): the words big, the size ("typically
 * 30–45 min") and timing. Quiet or active-delay Traveler views omit this duplicate card; Aviation mode also
 * shows the analog, calibration and source explanation as visible text. Always returns a node.
 */
export function delayBlock(a, i, opts = {}) {
  injectStyle();
  const aviation = isAviation();
  const w = cardWindow(a, aviation);
  if (!w) return document.createDocumentFragment();
  const idx = i == null ? w.i : i;
  const hr = a.hours[idx];
  const d = hr && hr.delay;
  if (!d || d.p == null) return document.createDocumentFragment();
  const t0 = Date.parse(hr.t);
  const L = likelihood(d, { iata: a.iata });
  if (!aviation && (L.key === "now" || !notable(d, hr.level, L))) return document.createDocumentFragment();
  let when;
  if (L.key === "now") when = "";
  else if (i == null) {
    const start = Date.parse(a.hours[w.s].t);
    const end = Date.parse(a.hours[w.e].t) + HOUR;
    when = w.s === 0 && w.e === a.hours.length - 1 ? "in the next 24 hours" : rangeLabel(start, end, tzOf(a), w.s === 0);
  } else when = idx === 0 ? "this hour" : "at " + dayPrefix(t0, tzOf(a)) + clock(t0, tzOf(a));
  const cls = L.key === "now" || RANK[L.key] >= 3 ? "dl-hi" : RANK[L.key] === 2 ? "dl-mid" : "dl-lo";
  const covered = opts.coveredHours?.includes(hr.t);
  const kids = covered ? [] : [el("div", "dl-main", el("span", "dl-big " + cls, L.key === "now" ? L.word : L.word.replace(/^Delays/, "Flight delays")), when ? el("span", "dl-what", when) : null)];
  const sub = [L.cue, L.size ? "When disrupted: " + L.size : ""].filter(Boolean).join(" · ");
  if (sub) kids.push(el("div", "dl-usual-b", sub));
  if (L.key === "now" && NOW_KINDS[d.override]) kids.push(el("div", "dl-faa", d.override === "closure" ? "Airport closed" : NOW_KINDS[d.override] + " in effect"));
  if (/^possible_/.test(d.override || "")) {
    kids.push(el("div", "dl-faa", "The FAA plans a possible " + (d.override === "possible_ground_stop" ? "ground stop" : "ground delay program")));
  }
  // Why?: the analog (only when it agrees with the words: same band or one apart), how often warnings like this
  // were right, and what the numbers are based on
  const why = [];
  const an = analogWords(d.analog);
  if (an && analogAgrees(d.analog, L)) why.push(el("div", "dl-analog", an));
  const { bin } = calibrate(Number(d.p));
  if (L.key !== "now" && L.key !== "unknown" && bin && bin.rate != null && bin.n) why.push(el("div", "dl-analog", `Across airports, warnings like this were followed by delays ${inTen(bin.rate)} times.`));
  if (d.pTypical != null && d.typicalScope !== "pooled" && L.key !== "now") why.push(el("div", "dl-analog", `On a typical day at this hour, delays happen ${inTen(d.pTypical)} times.`));
  why.push(sourceLine());
  kids.push(aviation ? el("div", "dl-why", ...why) : el("div", "dl-srcline", "Airport-wide weather and air traffic control risk · forecast estimate"));
  if (d.modelCoverage === "pooled") kids.push(el("div", "dl-srcline", "No airport-specific delay accuracy history; estimate uses other airports."));
  if (!aviation && window.AWXApp?.state.data?.delayModel?.basis !== "model") kids.push(sourceLine());
  return el("div", "dl-block", ...kids);
}

const api = { delayLine, delayBlock, outlookLead, likelihood, notable, calibrate, analogWords, analogAgrees, minutesRange, setReport, routineOutlook, outlookHour, whyBlock, dayPartPhrase };
if (typeof window !== "undefined" && window.document) {
  window.AWXDelay = api;
  // Holdout sample support and explanations; probabilities are calibrated by the model.
  fetch("./data/model/report.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((r) => {
    if (!r) return;
    setReport(r);
    if (window.AWXApp && window.AWXApp.render && window.AWXApp.state && window.AWXApp.state.data) window.AWXApp.render();
  }).catch(() => {});
}
// app.js may have rendered before this module ran: render again so the lines appear
if (typeof window !== "undefined" && window.AWXApp && window.AWXApp.render && window.AWXApp.state && window.AWXApp.state.data) window.AWXApp.render();
export default api;
