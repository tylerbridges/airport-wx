// Phase 3: "Will it cause delays?" — renders the delay model's numbers from status.json
// (airports[].hours[].delay, top-level delayModel; README "Delay model"). No scoring happens here.
//   delayLine(airport)            card line: "62% chance of delays 6–9 PM" + muted "usually 18%"
//   delayBlock(airport, hourIdx)  sheet block (hourIdx null = the peak window)
// Loaded as a module by index.html; app.js calls it through window.AWXDelay (marked "phase3 hook").

const HOUR = 3600e3;
const STYLE = `
.dl-line { margin-top: 6px; font-size: 14px; font-weight: 600; line-height: 1.3; }
.dl-line .dl-usual, .dl-line .dl-src { font-weight: 500; color: var(--muted); }
.dl-hi { color: var(--l3); } .dl-mid { color: var(--l2); } .dl-lo { color: var(--text); }
.dl-block { background: var(--card-2); border-radius: 16px; padding: 12px 14px; margin-bottom: 10px; }
.dl-block h3 { margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.dl-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.dl-big { font-size: 40px; line-height: 1; font-weight: 800; letter-spacing: -.03em; }
.dl-what { font-size: 15px; font-weight: 600; }
.dl-usual-b { margin-top: 4px; font-size: 14px; color: var(--muted); }
.dl-min, .dl-now, .dl-faa { margin-top: 6px; font-size: 14px; }
.dl-analog { margin-top: 8px; font-size: 13.5px; line-height: 1.4; color: var(--text); opacity: .9; }
.dl-srcline { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }
.dl-srcline a { color: var(--l1); text-decoration: none; white-space: nowrap; }
.dl-srcline a:focus-visible { outline: 2px solid var(--l1); outline-offset: 2px; border-radius: 4px; }
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
const clock = (ms, tz) => tidy(fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }, "hm").format(ms)).replace(":00 ", " ");
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
const pct = (p) => Math.round(p * 100) + "%";
const tone = (p) => (p >= 0.6 ? "dl-hi" : p >= 0.35 ? "dl-mid" : "dl-lo");
const NOW_KINDS = { ground_stop: "FAA ground stop", ground_delay: "FAA ground delay program", delay: "FAA-reported delays" };

/** {i (peak hour), s, e (window), p} over the 24 hours, or null without delay numbers. */
function peakWindow(a) {
  const hs = a.hours || [];
  let i = -1;
  hs.forEach((h, k) => { if (h.delay && h.delay.p != null && (i < 0 || h.delay.p > hs[i].delay.p)) i = k; });
  if (i < 0) return null;
  const p = hs[i].delay.p;
  const near = (k) => hs[k] && hs[k].delay && hs[k].delay.p != null && hs[k].delay.p >= p - 0.1;
  let s = i;
  let e = i;
  while (near(s - 1)) s--;
  while (near(e + 1)) e++;
  return { i, s, e, p };
}

function usualText(d, short) {
  if (d.pTypical == null) return "";
  return "usually " + pct(d.pTypical) + (short ? "" : d.typicalScope === "airport" ? " here" : " at this hour");
}

/** Card line under the reason. Returns an element, or null when there are no delay numbers. */
export function delayLine(a) {
  injectStyle();
  const w = a && peakWindow(a);
  if (!w) return null;
  const h0 = a.hours[0].delay;
  if (h0 && h0.p >= 1 && NOW_KINDS[h0.override]) {
    return el("div", "dl-line dl-hi", "Delays happening now" + (h0.minutes && h0.minutesFrom === "faa" ? ` · about ${h0.minutes} min` : ""),
      el("span", "dl-usual", " · " + NOW_KINDS[h0.override]));
  }
  const d = a.hours[w.i].delay;
  if (w.p < 0.2) {
    return el("div", "dl-line dl-lo", "Delays unlikely · up to " + pct(w.p), d.pTypical != null ? el("span", "dl-usual", " · " + usualText(d, true)) : null);
  }
  const start = Date.parse(a.hours[w.s].t);
  const end = Date.parse(a.hours[w.e].t) + HOUR;
  const when = w.s === 0 && w.e === a.hours.length - 1 ? "in the next 24 hours" : rangeLabel(start, end, a.tz, w.s === 0);
  return el("div", "dl-line " + tone(w.p), `${pct(w.p)} chance of delays ${when}`, d.pTypical != null ? el("span", "dl-usual", " · " + usualText(d, true)) : null);
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
  const link = el("a", null, "How accurate? ›");
  link.href = "accuracy.html";
  return el("div", "dl-srcline", parts.join(" · ") + " · ", link);
}

/** Sheet block "Will it cause delays?" for hour i (null = the peak window). Always returns a node. */
export function delayBlock(a, i) {
  injectStyle();
  const w = a && peakWindow(a);
  if (!w) return document.createDocumentFragment();
  const idx = i == null ? w.i : i;
  const hr = a.hours[idx];
  const d = hr && hr.delay;
  if (!d || d.p == null) return document.createDocumentFragment();
  const t0 = Date.parse(hr.t);
  let what;
  if (i == null) {
    const start = Date.parse(a.hours[w.s].t);
    const end = Date.parse(a.hours[w.e].t) + HOUR;
    what = w.s === 0 && w.e === a.hours.length - 1 ? "chance of delays in the next 24 hours" : "chance of delays " + rangeLabel(start, end, a.tz, w.s === 0);
  } else what = "chance of delays " + (idx === 0 ? "this hour" : "at " + dayPrefix(t0, a.tz) + clock(t0, a.tz));
  const kids = [el("h3", null, "Will it cause delays?")];
  const faaNow = d.p >= 1 && NOW_KINDS[d.override];
  kids.push(el("div", "dl-main", el("span", "dl-big " + tone(d.p), faaNow ? "Now" : pct(d.p)), el("span", "dl-what", faaNow ? "delays are happening" : what)));
  if (faaNow) {
    kids.push(el("div", "dl-faa", NOW_KINDS[d.override] + " in effect" + (d.minutes && d.minutesFrom === "faa" ? ` · FAA average delay about ${d.minutes} min` : "")));
    if (d.minutes && d.minutesFrom !== "faa") kids.push(el("div", "dl-min", `Delays like this typically run about ${d.minutes} min`));
  }
  else if (d.pTypical != null) kids.push(el("div", "dl-usual-b", usualText(d) + (d.p >= 2 * d.pTypical && d.pTypical > 0 ? ` — about ${Math.round(d.p / d.pTypical)}× the usual chance` : "")));
  if (/^possible_/.test(d.override || "")) {
    kids.push(el("div", "dl-faa", "The FAA plans a possible " + (d.override === "possible_ground_stop" ? "ground stop" : "ground delay program") + (d.rateFrom === "history" ? ` — in our records about ${pct(d.p)} of these went ahead` : " — counted as an even chance until we have its track record")));
  }
  if (!faaNow && d.minutes) kids.push(el("div", "dl-min", `If delays hit: typically about ${d.minutes} min`));
  if (i == null && w.i !== 0 && a.hours[0].delay && a.hours[0].delay.p != null) kids.push(el("div", "dl-now", "Right now: " + pct(a.hours[0].delay.p)));
  if (d.analog && d.analog.text) kids.push(el("div", "dl-analog", d.analog.text));
  kids.push(sourceLine());
  return el("div", "dl-block", ...kids);
}

const api = { delayLine, delayBlock };
window.AWXDelay = api;
// app.js may have rendered before this module ran: render again so the lines appear
if (window.AWXApp && window.AWXApp.render && window.AWXApp.state && window.AWXApp.state.data) window.AWXApp.render();
export default api;
