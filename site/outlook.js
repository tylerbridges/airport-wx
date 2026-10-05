// Airport-hour outlook shared by the detail sheet and map. No DOM or data fetching.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXOutlook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const HOUR = 3600000;
  const ms = (x) => Number.isFinite(x) ? x : Date.parse(x);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  function restrictions(a, at, now) {
    const current = at < Math.floor(now / HOUR) * HOUR + HOUR;
    const out = (a.faa || []).filter((f) => {
      if (f.active === false || f.scope === "limited" || f.scope === "runway") return false;
      const start = ms(f.start), end = ms(f.end);
      if (Number.isFinite(start) && at < start) return false;
      return Number.isFinite(end) ? at < end : current;
    }).map((f) => ({ ...f, source: "faa" }));
    for (const x of a.atcscc || []) {
      if (x.cnx || !["GS", "GDP"].includes(x.type)) continue;
      const start = ms(x.start), end = ms(x.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || at < start || at >= end) continue;
      // A superseded advisory must never reappear in a future map hour.
      const latest = (a.atcscc || []).filter((y) => y.type === x.type).every((y) => !(ms(y.issued) > ms(x.issued)));
      if (!latest || start <= now && !x.active) continue;
      const type = x.type === "GS" ? "ground_stop" : "ground_delay";
      const existing = out.find((f) => f.type === type);
      if (existing) { existing.extension = x.extension || null; continue; }
      out.push({ type, end: x.end, start: x.start, extension: x.extension, detail: "", source: "atcscc", cause: x.cause || null, causeLabel: x.causeLabel || x.causeText || "" });
    }
    return out.sort((x, y) => ({ closure: 0, ground_stop: 1, ground_delay: 2, delay: 3 }[x.type] ?? 4) - ({ closure: 0, ground_stop: 1, ground_delay: 2, delay: 3 }[y.type] ?? 4));
  }
  function directionRows(programs, current) {
    const rows = [];
    const add = (label, value) => rows.push({ label, value });
    for (const f of programs) {
      if (f.type === "closure") { add("Arrivals & departures", current ? "Airport closed to flights" : "Airport closure scheduled"); continue; }
      if (f.type === "ground_stop" || f.type === "ground_delay") {
        const avg = /avg ([^,;]+)/i.exec(f.detail || "")?.[1];
        add("Arrivals", (current ? "Held at their departure airports" : "Scheduled to be held at their departure airports") + (avg ? " · FAA average " + avg.replace(/(\d+)h\s*(\d+)m/g, "$1 hr $2 min").replace(/(\d+)m\b/g, "$1 min").replace(/(\d+)h\b/g, "$1 hr") : ""));
        continue;
      }
      for (const part of String(f.detail || "").split(/;\s*/)) {
        const match = /^(Arrivals\/Departures|Arrivals|Departures|Delays)\s+(.+)$/i.exec(part);
        if (!match) continue;
        const value = match[2].replace(/(\d+)h\s*(\d+)m/g, "$1 hr $2 min").replace(/(\d+)m\b/g, "$1 min").replace(/(\d+)h\b/g, "$1 hr").replace(/,?\s*until.*$/i, "");
        add(match[1] === "Arrivals/Departures" || match[1] === "Delays" ? "Arrivals & departures" : match[1], "Delays " + value);
      }
    }
    return rows.filter((r, i) => !rows.slice(0, i).some((p) => p.label === r.label && p.value === r.value));
  }
  // One display level per hour (README "Display level"): the hour's weather/FAA level raised by its delay words —
  // "Delays happening now" to the FAA program's level, "very likely" to at least High, "likely" to at least Moderate,
  // "possible" to at least Minor; usual delays, a small chance or unlikely raise nothing. Every coloured or labelled
  // hour (timelines, hour cards, headlines, the map, the brief, trips) uses it, so words and colours agree.
  const PROG_LEVEL = { closure: 4, ground_stop: 4, ground_delay: 3, delay: 2 };
  const RAISE = { possible: 1, likely: 2, very: 3 };
  function delayRaise(h, L) {
    if (!L) return 0;
    if (L.key === "now") return PROG_LEVEL[h?.delay?.override] || 2;
    return RAISE[L.key] || 0;
  }
  // Overnight hours (1:00–4:59 AM airport time) carry few scheduled flights, so a delay chance there is no headline:
  // it never raises the hour's level. Weather, FAA restrictions and delays happening now still count (overnight snow
  // or fog sets up the first morning departures).
  const HFMT = new Map();
  function quietHour(t, tz) {
    if (!tz || !Number.isFinite(ms(t))) return false;
    let f = HFMT.get(tz);
    if (!f) { try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }); } catch { return false; } HFMT.set(tz, f); }
    const hr = Number(f.format(ms(t))) % 24;
    return hr >= 1 && hr <= 4;
  }
  function score(h, opts) {
    const L = h?.delay && opts.words ? opts.words(h.delay) : null;
    const quiet = quietHour(h?.t, opts.tz);
    const raise = quiet && L?.key !== "now" ? 0 : delayRaise(h, L);
    const level = Math.max(h?.level || 0, raise);
    return { L, meaningful: raise > 0, level, raise, raised: raise > (h?.level || 0), quiet };
  }
  function windowFor(a, opts, after) {
    const hs = a.hours || [];
    let peak = -1;
    hs.forEach((h, i) => {
      if (ms(h.t) + HOUR <= after || h.level == null) return; // an hour no forecast covers is unknown, never a window

      const s = score(h, opts);
      if (s.level < 2) return;
      if (peak < 0 || s.level > score(hs[peak], opts).level || s.level === score(hs[peak], opts).level && (s.L?.rate || 0) > (score(hs[peak], opts).L?.rate || 0)) peak = i;
    });
    if (peak < 0) return null;
    const target = score(hs[peak], opts);
    const near = (i) => i >= 0 && i < hs.length && hs[i].level != null && score(hs[i], opts).level === target.level;
    let start = peak, end = peak;
    while (near(start - 1) && ms(hs[start - 1].t) + HOUR > after) start--;
    while (near(end + 1)) end++;
    return { start: ms(hs[start].t), end: ms(hs[end].t) + HOUR, hour: hs[peak], level: target.level, words: target.meaningful ? target.L : null };
  }
  // One health contract for airport outlooks and Trips; health never discards known disruptions.
  function health(a, opts = {}) {
    const now = opts.now ?? Date.now();
    const coverage = a.coverage || {}, weatherOnly = !!(coverage.weatherOnly || a.shard);
    const sources = coverage.sources || opts.sources || {};
    const generated = ms(coverage.generated || opts.generated);
    const required = weatherOnly ? ["metar", "taf"] : ["faa", "atcscc", "metar", "taf", "nws"];
    const age = (k) => (Number.isFinite(ms(sources[k]?.at)) ? now - ms(sources[k].at) : 0);
    // FAA Command Center advisories come only from the GitHub build (the live relay doesn't fetch them). While the relay's
    // FAA status (active ground stops, delay programs, closures) is fresh they may lag up to 3 hours before the outlook
    // counts as incomplete; the sheet's checked line says how old they are (advisoriesAge).
    const faaFresh = !!sources.faa?.ok && !sources.faa.error && !sources.faa.stale && age("faa") <= 30 * 60000;
    const limit = (k) => (k === "atcscc" && faaFresh ? 3 * HOUR : 30 * 60000);
    const unavailable = required.some((k) => !sources[k]?.ok || sources[k].error || sources[k].stale || age(k) > limit(k));
    const advisoriesAge = required.includes("atcscc") && sources.atcscc?.ok && age("atcscc") > 30 * 60000 ? age("atcscc") : null;
    // Storm sources (Convective SIGMETs, SPC outlook, LAMP thunder chances, TCF, CWAs): a quiet outlook without them
    // could be silently wrong, so it is qualified ("storm data unavailable"). SIGMETs are refreshed by the live relay
    // (30 min); the rest come only from the GitHub build, so they may lag up to 3 hours.
    const STORM = ["sigmet", "spc", "lamp", "tcf", "cwa"];
    const stormDown = !weatherOnly && STORM.some((k) => !sources[k] || !sources[k].ok || sources[k].error || sources[k].stale || age(k) > (k === "sigmet" ? 30 * 60000 : 3 * HOUR));
    const outdated = !Number.isFinite(generated) || now - generated > 30 * 60000 || generated - now > 5 * 60000;
    const observed = ms(a.metar?.obsTime), forecastIssued = ms(a.taf?.issued);
    const missingWeather = !Number.isFinite(observed) || now - observed > 2 * HOUR || observed - now > 10 * 60000;
    const missingForecast = !a.taf || !Number.isFinite(forecastIssued) || now - forecastIssued > 12 * HOUR || forecastIssued - now > 10 * 60000;
    const incomplete = unavailable || missingWeather || missingForecast || opts.sample || opts.offline || weatherOnly || opts.noticesDown || stormDown;
    const quality = opts.offline ? "Offline · showing last-known airport data" : outdated ? "Data may be outdated" : missingWeather ? "Recent weather observation unavailable"
      : missingForecast ? "Airport forecast unavailable or outdated" : unavailable || opts.sample ? "Some data unavailable" : weatherOnly ? "Weather only · FAA delay coverage unavailable"
      : stormDown ? "Storm data unavailable" : opts.hidden ? "Some disruptions hidden by your settings" : opts.noticesDown ? "Nearby flight restrictions unavailable" : "";
    return { outdated, incomplete, quality, advisoriesAge, stormDown, checked: Number.isFinite(generated) ? generated : null,
      observed: Number.isFinite(observed) ? observed : null, forecastIssued: Number.isFinite(forecastIssued) ? forecastIssued : null, missingWeather, missingForecast, weatherOnly };

  }
  // "1/8", "3/8", "1 1/2", "0.25", "2" (statute miles) -> number
  function visNumber(s) {
    const m = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(String(s).trim());
    if (m) return Number(m[3]) ? Number(m[1] || 0) + Number(m[2]) / Number(m[3]) : null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  /** Lowest visibility (sm) a set of reasons states ("Visibility 1/8 sm", "Snow, visibility 1 1/2 sm"), or null. */
  function reasonVisibility(r) {
    let low = null;
    for (const m of String(r).matchAll(/visibility\s+(?:under\s+)?((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s*sm\b/gi)) {
      const v = visNumber(m[1]);
      if (v != null && (low == null || v < low)) low = v;
    }
    return low;
  }
  function conditionHeadline(h, current = false) {
    const r = (h?.reasons || []).join(" ");
    const suffix = current ? "" : " expected";
    // storms and winter weather outrank the visibility they bring (snow at 1/4 sm is winter weather, not fog)
    if (/Thunder|Convective SIGMET|\bstorms\b/i.test(r)) return "Storms near the airport" + suffix;
    if (/Snow|Freezing|Ice|Winter|Blizzard/i.test(r)) return "Winter weather" + suffix;
    const vis = reasonVisibility(r);
    const fog = /\b(Fog|Mist)\b/i.test(r) || /(^|[\s+-])(FG|BR|FZFG|MIFG|BCFG|PRFG)\b/.test(String(h?.wx || ""));
    if (/Dense Fog/i.test(r) || fog && vis != null && vis <= 0.5) return "Dense fog" + suffix;
    if (vis != null && vis <= 0.5) return "Low visibility" + suffix;
    if (/Fog/i.test(r)) return "Fog" + suffix;
    if (/Ceiling/i.test(r)) return "Low clouds" + suffix;
    if (vis != null) return "Low visibility" + suffix;
    if (/Gust|Wind/i.test(r)) return "Strong winds" + suffix;
    return current ? "Disruption possible" : "Disruption possible in forecast";
  }
  function evaluate(a, opts = {}) {
    const now = opts.now ?? Date.now(), at = opts.at ?? now;
    const h = (a.hours || []).find((x) => ms(x.t) <= at && at < ms(x.t) + HOUR);
    const current = at < Math.floor(now / HOUR) * HOUR + HOUR;
    const { outdated, incomplete, quality, stormDown } = health(a, opts);
    const programs = restrictions(a, at, now);
    const impacts = directionRows(programs, current);
    const s = score(h, opts);
    const first = programs[0];
    let kind = "normal", headline = current ? "Operating normally" : "Normal conditions expected", level = s.level;
    if (first) {
      kind = current ? "active" : "forecast";
      headline = first.type === "closure" ? current ? "Airport closed" : "Airport closure scheduled"
        : first.type === "ground_stop" ? current ? "Ground Stop" : "Ground Stop scheduled"
        : first.type === "ground_delay" ? current ? "Arrivals delayed" : "Arrival delay program scheduled"
        : impacts.length === 1 ? impacts[0].label + (current ? " delayed" : " delays scheduled") : current ? "Flight delays in effect" : "Flight delays scheduled";
      level = Math.max(level, first.type === "closure" || first.type === "ground_stop" ? 4 : first.type === "ground_delay" ? 3 : 2);
    } else if (!h || h.level == null) { kind = "unknown"; headline = "Forecast unavailable for this time"; level = null; } // no forecast covers this hour: unknown, never normal
    else if (s.meaningful || s.level > 0) {
      kind = "forecast";
      headline = s.meaningful ? s.L.word.replace(/^Delays/, "Flight delays") : conditionHeadline(h, current);
    }
    if ((outdated || incomplete) && kind === "normal") { kind = "unknown"; headline = opts.offline ? "Offline · status unconfirmed" : outdated ? "Status may be outdated" : opts.noticesDown ? "No disruptions reported · flight restrictions unavailable" : stormDown ? "No disruptions reported · storm data unavailable" : "No disruptions reported · some data unavailable"; }
    else if (opts.hidden && kind === "normal") headline = "No issues in your selected categories";
    if (kind === "normal" && opts.noticesDown) headline += " · flight restrictions unavailable"; // nearby TFRs couldn't be read: never an unqualified "normal"
    const window = h ? windowFor(a, opts, at) : null;
    const end = first && ms(first.end);
    // Recovery is a forecast, never a promise tied to an FAA program's scheduled end, and only for weather: a program
    // for volume, staffing, equipment or an airline's IT outage doesn't end because the weather improves.
    // "Lower disruption risk" (recovery) only when the level falls to Low/Clear (≤ 1) and stays there for the next hour
    // too; a drop of a level or two that stays disruptive is easing ({at, level}: "Eases to Moderate after 9 PM"). Neither
    // falls inside the delay window shown above it (this outlook's window, or opts.notBefore from the sheet's delay line):
    // the first confirmed hour at or after that window's end is used instead. Hours no forecast covers never confirm.
    let recovery = null, eases = null;
    if (h && h.level != null && s.level >= 2 && programs.every((f) => f.cause === "weather")) {
      const hs = a.hours, i = hs.indexOf(h);
      const lv = (j) => (j < hs.length && hs[j].level != null ? score(hs[j], opts).level : null);
      const ok = (j, max) => lv(j) != null && lv(j) <= max && !restrictions(a, ms(hs[j].t), now).length && (j + 1 >= hs.length || lv(j + 1) != null && lv(j + 1) <= max);
      let after = Number.isFinite(opts.notBefore) ? opts.notBefore : -Infinity;
      if (window && window.start <= ms(h.t) + HOUR && window.end > after) after = window.end; // the window this hour is in
      const from = (max) => hs.findIndex((x, j) => j > i && ms(x.t) >= after && ok(j, max));
      const j1 = from(1);
      if (j1 >= 0) recovery = ms(hs[j1].t);
      else {
        const j2 = from(s.level - 1);
        if (j2 >= 0) eases = { at: ms(hs[j2].t), level: Math.max(lv(j2), j2 + 1 < hs.length ? lv(j2 + 1) : 0) };
      }
    }
    const reasons = uniq((h?.reasons || []).map((r) => opts.plain ? opts.plain(r, a) : r)).slice(0, 2);
    return { kind, headline, level, at, current, quality, reasons, programs, impacts,
      scheduledEnd: Number.isFinite(end) ? end : null,
      extension: first?.extension || null, window, recovery, eases,
      cue: s.meaningful ? s.L.cue : "", size: s.meaningful ? s.L.size : "",
      basis: first ? current ? "FAA restriction" : "Scheduled FAA restriction" : kind === "forecast" ? "Airport forecast" : "Current conditions",
      // This definition deliberately describes an airport hour rather than a personal flight outcome.
      definition: "Risk of weather or air traffic control disruption across this airport during an hour.",
    };
  }
  /** The level of hour h as the sheet and map show it: its own level, raised by notable delay chances and FAA restrictions in force at `at`. */
  function levelAt(a, h, opts, at, now) {
    const p = restrictions(a, at, now)[0];
    if (h && h.level == null) return p ? PROG_LEVEL[p.type] || 2 : null; // no forecast: unknown unless an FAA restriction is in force
    return Math.max(score(h, opts).level, p ? PROG_LEVEL[p.type] || 2 : 0);
  }
  /**
   * One level for an airport, shared by the home card, the sheet's headline, the brief, the map's Now and trips: the
   * highest airport-hour level (evaluate's, at each remaining hour) and when it applies.
   * {level, nowLevel, later (the peak is later and higher than now), start, end (the run at `level`), peakAt (ISO
   * hour), peakHour, words (delay words when they set the level), nowEnd, next (level after the current run), current
   * (evaluate() now), levels [{t, level}], open (an FAA program in force with no stated end: the poller holds it 3–5
   * hours, which is not an end), uncertainFrom (ms: after the open program's hold hours the timeline is uncertain), openLevel}.
   */
  function summary(a, opts = {}) {
    const now = opts.now ?? Date.now();
    const current = evaluate(a, { ...opts, at: now });
    const hs = (a.hours || []).filter((h) => ms(h.t) + HOUR > now);
    // an hour no forecast covers has level null (unknown); the current hour keeps a number (health qualifies it)
    const levels = hs.map((h, i) => ({ t: h.t, level: i === 0 && ms(h.t) <= now && current.level != null ? current.level : i === 0 ? levelAt(a, h, opts, Math.max(ms(h.t), now), now) ?? 0 : levelAt(a, h, opts, Math.max(ms(h.t), now), now) }));
    const L = (i) => levels[i].level;
    const nowLevel = levels.length ? L(0) : current.level || 0;
    const open = (current.programs || []).find((f) => f.source === "faa" && !Number.isFinite(ms(f.end)) && !f.perm && PROG_LEVEL[f.type]) || null;
    const out = { level: nowLevel, nowLevel, later: false, start: now, end: null, peakAt: null, peakHour: null, words: null, nowEnd: null, next: null,
      current, levels, byT: new Map(levels.map((x) => [x.t, x.level])), nowHour: hs[0] || null, open, openLevel: open ? PROG_LEVEL[open.type] : null, uncertainFrom: null };
    if (!levels.length) return out;
    let p = 0;
    levels.forEach((x, i) => { if (x.level != null && x.level > L(p)) p = i; });
    let q = p;
    while (q + 1 < levels.length && L(q + 1) === L(p)) q++;
    let r = 0;
    while (r + 1 < levels.length && L(r + 1) === L(0)) r++;
    const sc = score(hs[p], opts);
    Object.assign(out, { level: L(p), later: p > 0 && L(p) > L(0), start: p === 0 ? now : ms(hs[p].t), end: ms(hs[q].t) + HOUR, peakAt: hs[p].t, peakHour: hs[p],
      words: sc.meaningful && sc.level >= L(p) ? sc.L : null, nowEnd: ms(hs[r].t) + HOUR, next: r + 1 < levels.length ? L(r + 1) : null });
    if (open) {
      const k = levels.findIndex((x, i) => i > 0 && x.level < out.openLevel);
      if (k > 0) out.uncertainFrom = ms(hs[k].t);
    }
    return out;
  }
  function overlaps(window, at, until) {
    const start = ms(at), end = Number.isFinite(ms(until)) ? ms(until) : start + 1;
    return !!window && start < window.end && end > window.start;
  }
  return { conditionHeadline, reasonVisibility, quietHour, health, evaluate, summary, levelAt, score, restrictions, directionRows, windowFor, overlaps, PROG_LEVEL, RAISE };
});
