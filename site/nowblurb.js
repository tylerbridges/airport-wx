// The airport sheet's Now card blurb (README "Airport sheet"): two short plain parts under the headline —
// specifics (what is happening and why) and trend (improving, holding, worsening, or unknown). Pure: no DOM, no
// fetching; it only words the objects the sheet has already computed (outlook evaluate/summary, the hour's reasons,
// storm data, warnings, today's level events). Loaded before app.js; tools/nowblurb.test.mjs runs it in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXNowBlurb = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const HOUR = 3600000;
  const LEVEL = ["Clear", "Minor", "Moderate", "High", "Severe"];
  const SPC = { TSTM: 0, MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 5 };
  const SPC_NAME = { MRGL: "marginal", SLGT: "slight", ENH: "enhanced", MDT: "moderate", HIGH: "high" };
  const COVER = { high: "widespread", medium: "scattered", low: "isolated" };
  // the specifics are cut to whole fragments (never mid-sentence) to stay within three lines at 360 px, the trend within two
  const MAX_SPEC = 105;
  const MAX_TREND = 66;

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const low = (s) => (/^[A-Z][a-z]/.test(s) && !/^(FAA|NWS|SPC|TCF|ATC)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  const dot = (s) => (s && !/[.!?]$/.test(s) ? s + "." : s);
  const list = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

  /** Default formatters (Node tests): the app passes its own (12/24-hour clock, display zone). */
  function formatters(tz, now) {
    const z = tz || "UTC";
    const hm = new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "numeric", minute: "2-digit" });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" });
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short" });
    const mi = new Intl.DateTimeFormat("en-US", { timeZone: z, minute: "numeric" });
    const tidy = (s) => s.replace(/[  ]/g, " ");
    const clock = (ms) => tidy(hm.format(ms));
    const short = (ms) => clock(ms).replace(":00 ", " ");
    return {
      clock,
      when: (ms) => (day.format(ms) === day.format(now) ? short(ms) : day.format(ms) === day.format(now + 24 * HOUR) ? "tomorrow " + short(ms) : wd.format(ms) + " " + short(ms)),
      floor: (ms) => ms - (Number(mi.format(ms)) || 0) * 60000 - (((ms % 60000) + 60000) % 60000),
    };
  }

  /** "Light winds and good visibility" from the latest observation (mph, statute miles, feet); null parts are left out. */
  function condWords(c) {
    if (!c) return [];
    const out = [];
    const g = c.gustMph, s = c.windMph;
    if (g != null && g >= 40) out.push("strong gusty winds");
    else if (g != null && g >= 25 || s != null && s >= 20) out.push("gusty winds");
    else if (s != null && s >= 13) out.push("breezy winds");
    else if (s != null) out.push("light winds");
    if (c.visMi != null) out.push(c.visMi < 1 ? "poor visibility" : c.visMi < 3 ? "reduced visibility" : c.visMi >= 5 ? "good visibility" : "fair visibility");
    if (c.ceilingFt != null && c.ceilingFt < 1000) out.push(c.ceilingFt < 500 ? "very low clouds" : "low clouds");
    return out;
  }

  /** Storm fragments: [{pri, text}] — a thunderstorm alert over or near the field, the severe-storm outlook, the air-traffic storm forecast. */
  function stormBits(st, aviation, F) {
    const out = [];
    if (!st) return out;
    if (st.near) {
      const end = Number.isFinite(st.until) ? st.until : null;
      if (aviation) out.push({ pri: 1, g: "storm", text: "Convective SIGMET over or within 10 nm" + (end ? " until " + F.when(end) : "") });
      else {
        out.push({ pri: 1, g: "storm", text: "Thunderstorm advisory near the airport" + (end ? " until " + F.when(end) : "") });
      }
    }
    if (st.spc && SPC[st.spc] != null) {
      const n = SPC[st.spc];
      out.push({ pri: 2, g: "storm", text: aviation ? (n ? `SPC ${cap(SPC_NAME[st.spc])} risk (level ${n} of 5)` : "SPC general thunderstorms")
        : n ? `severe storms possible today (${SPC_NAME[st.spc]} risk)` : "thunderstorms possible in the area today" });
    }
    const tcf = (st.tcf || [])[0];
    if (tcf) {
      const at = Number.isFinite(tcf.valid) ? tcf.valid : Date.parse(tcf.valid);
      const t = Number.isFinite(at) ? " around " + F.when(F.floor(at)) : "";
      out.push({ pri: 8, g: "storm", text: aviation ? `TCF ${tcf.coverage || "some"} coverage${t}` : `${COVER[tcf.coverage] || "some"} storms forecast for air traffic${t}` });
    }
    return out;
  }

  /** What is happening and why, in one or two short sentences. */
  function specifics(x, F) {
    const av = !!x.aviation;
    const bits = [];
    const head = String(x.headline || "").toLowerCase();
    if (x.programText) bits.push({ pri: 0, g: "prog", text: x.programText });
    // the hour's reasons, minus the headline itself ("Storms near the airport") and anything the storm fragments say
    const reasons = (x.reasons || []).map(String).filter((r) => r && r.toLowerCase().replace(/ until .*$/, "") !== head && !/^Storms near the airport\b/.test(r));
    reasons.forEach((r, i) => bits.push({ pri: i === 0 ? 3 : i === 1 ? 5 : 7, g: "wx", text: r }));
    bits.push(...stormBits(x.storms, av, F));
    const warns = [...new Set((x.warnings || []).filter(Boolean))];
    warns.forEach((w, i) => bits.push({ pri: i === 0 ? 4 : 6, g: "warn", text: w }));
    const quiet = !bits.some((b) => b.g === "prog" || b.g === "wx") && !(x.level > 0);
    if (quiet) {
      // nothing disruptive: still say what the airport looks like (never a bare "Clear")
      const cw = condWords(x.cond);
      const none = x.kind === "normal" ? (warns.length ? "no FAA delays reported" : "no FAA delays or weather warnings reported") : null;
      const words = cw.concat(none ? [none] : []);
      if (words.length) bits.push({ pri: 0.5, g: "cond", text: cap(list(words)) });
      if (x.kind === "unknown" && x.quality) bits.push({ pri: 0.4, g: "qual", text: qualityWords(x.quality) });
    }
    if (!bits.length) return "";
    const render = (bs) => {
      const by = (g) => bs.filter((b) => b.g === g).map((b) => b.text);
      const parts = [];
      for (const t of by("prog")) parts.push(dot(t));
      for (const t of by("cond")) parts.push(dot(t));
      for (const t of by("qual")) parts.push(dot(t));
      const wx = by("wx");
      if (wx.length) parts.push(dot(cap(wx.map((t, i) => (i ? low(t) : t)).join(", "))));
      const st = by("storm");
      if (st.length) parts.push(dot(cap(st.map((t, i) => (i ? low(t) : t)).join("; "))));
      const w = by("warn");
      if (w.length) parts.push(dot(list(w) + " in effect"));
      return parts.join(" ");
    };
    let keep = bits.slice();
    while (render(keep).length > MAX_SPEC && keep.length > 1) {
      const worst = keep.reduce((m, b) => (b.pri > m.pri ? b : m), keep[0]);
      if (worst.pri <= 0) break;
      keep = keep.filter((b) => b !== worst);
    }
    return render(keep);
  }

  /** A missing-data qualifier in plain words (outlook.js health quality). */
  function qualityWords(q) {
    const s = String(q || "");
    if (/^Offline/.test(s)) return "You're offline, so this is the last-known airport data";
    if (/outdated/.test(s) && /^Data/.test(s)) return "This airport data may be outdated";
    if (/observation unavailable/.test(s)) return "No recent weather report from the airport";
    if (/forecast unavailable/i.test(s)) return "The airport forecast is unavailable or outdated";
    if (/^Weather only/.test(s)) return "FAA delay information isn't available for this airport";
    if (/^Storm data/.test(s)) return "Storm reports couldn't be checked, so a quiet status may be incomplete";
    if (/hidden/.test(s)) return "Some disruptions are hidden by your settings";
    if (/restrictions unavailable/.test(s)) return "Nearby flight restrictions couldn't be checked";
    return "Some airport data couldn't be checked, so a quiet status may be incomplete";
  }

  /** The latest of today's level changes as a past-direction phrase, when it still matches the current level. */
  function pastBit(x, F) {
    const ev = (x.events || []).filter((e) => e && (e.kind == null || e.kind === "level") && Number.isFinite(e.from) && Number.isFinite(e.to) && e.from !== e.to && Date.parse(e.t) <= x.now)
      .sort((p, q) => Date.parse(q.t) - Date.parse(p.t))[0];
    if (!ev || x.level == null) return null;
    const at = F.clock(Date.parse(ev.t));
    if (ev.to < ev.from && x.level < ev.from) {
      if (x.aviation) return `Down from ${LEVEL[ev.from] || "higher"} since ${at}`;
      return x.level > 0 ? "Improving since " + at : "Improved since " + at;
    }
    if (ev.to > ev.from && x.level >= ev.to) return x.aviation ? `Up from ${LEVEL[ev.from] || "lower"} since ${at}` : "Worse since " + at;
    return null;
  }

  /**
   * Where the Now condition is heading, from computed data only: recent level events, outlook recovery/eases, the
   * FAA program's end, the display levels of the coming hours and where forecast coverage stops. Never a guess and
   * never a quiet "all good" when data is missing. Returns {text, improvement} (improvement: the outlook's own
   * recovery/eases is said here, so the sheet leaves its "Forecast improvement" row out of Looking ahead).
   */
  function trend(x, F) {
    const av = !!x.aviation;
    if (x.kind === "unknown" || x.level == null) {
      if (x.stale) return { text: "Trend unavailable until data refreshes", improvement: false };
      if (x.noForecast) return { text: av ? "No TAF covers this hour" : "No airport forecast covers this hour", improvement: false };
      return { text: "Trend unavailable until data refreshes", improvement: false };
    }
    const L = x.level;
    const past = pastBit(x, F);
    const when = (ms) => F.when(F.floor(ms));
    const aft = (ms) => (!av && /^\d/.test(when(ms)) ? "after about " : "after ") + when(ms);
    let fut = null, improvement = false;
    const levels = (x.levels || []).filter((h) => Date.parse(h.t) + HOUR > x.now);
    // the current run of hours at this level and what follows it
    let r = 0;
    while (r + 1 < levels.length && levels[r + 1].level === L) r++;
    const runEnd = levels.length ? Date.parse(levels[r].t) + HOUR : null;
    const after = r + 1 < levels.length ? levels[r + 1] : null; // null: the forecast ends with this run
    if (x.open) {
      // an FAA program with no stated end: only the weather can be forecast
      if (x.weatherCause && (x.recovery || x.eases)) { fut = (av ? "Weather forecast improves " : "Weather expected to improve ") + aft(x.recovery || x.eases.at); improvement = true; }
      else fut = av ? "No FAA end time; improvement depends on the program" : "No improvement forecast until the FAA lifts it";
    } else if (x.recovery) {
      fut = (av ? "Forecast drops to Low or Clear " : "Expected to improve ") + aft(x.recovery); improvement = true;
    } else if (x.eases && Number.isFinite(x.eases.at)) {
      fut = (av ? "Forecast eases to " : "Expected to ease to ") + (LEVEL[x.eases.level] || "a lower level") + " " + aft(x.eases.at); improvement = true;
    } else if (x.laterPeak) {
      fut = av ? "Higher risk forecast later" : "May get worse later";
    } else if (after && after.level == null && runEnd - x.now < 12 * HOUR) { // a gap far ahead is just where the forecast ends
      fut = (av ? "TAF coverage ends " : "No forecast beyond ") + when(runEnd);
    } else if (after && after.level != null && after.level > L) {
      fut = (av ? "Forecast rises to " + LEVEL[after.level] + " " : "May get worse ") + aft(runEnd);
    } else if (after && after.level != null && after.level < L) {
      fut = after.level === 0 ? (av ? "Forecast Clear " : "Expected to clear ") + aft(runEnd)
        : (av ? "Forecast eases to " : "Expected to ease to ") + LEVEL[after.level] + " " + aft(runEnd);
    } else if (runEnd != null && !(after && after.level != null)) {
      fut = L === 0 ? (av ? "No change forecast through " : "No change expected through ") + when(runEnd)
        : (av ? "No improvement forecast before " : "Not expected to improve before ") + when(runEnd);
    }
    if (!fut && !past) return { text: "Trend unavailable until data refreshes", improvement: false };
    let text = past && fut ? past + "; " + low(fut) : past || fut;
    if (text.length > MAX_TREND && fut) text = fut; // the forward part is the one the brief can't drop
    return { text, improvement };
  }

  /**
   * build(x) -> {specifics, trend, improvement}. x: {aviation, now, tz, level (display level now; null unknown),
   * kind (outlook kind), headline, quality, stale, noForecast, programText, reasons[], cond {windMph, gustMph, visMi,
   * ceilingFt}, storms {near, until, spc, tcf[]}, warnings[], recovery, eases {at, level}, open, weatherCause,
   * laterPeak, levels [{t, level}] (outlook summary levels), events [{t, kind, from, to}], fmt {when, clock, floor}}.
   */
  function build(x) {
    const now = Number.isFinite(x.now) ? x.now : Date.now();
    const F = Object.assign(formatters(x.tz, now), x.fmt || {});
    const y = { ...x, now };
    const t = trend(y, F);
    return { specifics: specifics(y, F), trend: dot(t.text), improvement: t.improvement };
  }

  // Traveler strings: no raw codes, no "%", no certainty claims (tools/nowblurb.test.mjs guard)
  const CODES = /\b(VFR|MVFR|IFR|LIFR|METAR|TAF|SIGMET|LAMP|TCF|CWA|SPC|TEMPO|PROB[34]0|BECMG|NOSIG|CLSD|(?:FEW|SCT|BKN|OVC)\d{3}|\d{4}Z|\d{3}°?\s?\d+G?\d*\s?kt|kt)\b/;
  const CERTAIN = /\b(will|definitely|certainly|guaranteed?|for sure|no chance)\b/i;
  return { build, specifics, trend, condWords, qualityWords, CODES, CERTAIN, LEVEL };
});
