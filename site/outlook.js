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
      out.push({ type, end: x.end, start: x.start, extension: x.extension, detail: "", source: "atcscc" });
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
        add("Flights to this airport", (current ? "Held before departure" : "Scheduled to be held before departure") + (avg ? " · FAA average " + avg.replace(/(\d+)h\s*(\d+)m/g, "$1 hr $2 min").replace(/(\d+)m\b/g, "$1 min").replace(/(\d+)h\b/g, "$1 hr") : ""));
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
  function score(h, opts) {
    const L = h?.delay && opts.words ? opts.words(h.delay) : null;
    const meaningful = L && L.key !== "now" && (opts.notable ? opts.notable(h.delay, h.level, L) : h.level >= 2);
    const level = Math.max(h?.level || 0, meaningful ? ({ possible: 2, likely: 3, very: 4 }[L.key] || 0) : 0);
    return { L, meaningful, level };
  }
  function windowFor(a, opts, after) {
    const hs = a.hours || [];
    let peak = -1;
    hs.forEach((h, i) => {
      if (ms(h.t) + HOUR <= after) return;
      const s = score(h, opts);
      if (s.level < 2) return;
      if (peak < 0 || s.level > score(hs[peak], opts).level || s.level === score(hs[peak], opts).level && (s.L?.rate || 0) > (score(hs[peak], opts).L?.rate || 0)) peak = i;
    });
    if (peak < 0) return null;
    const target = score(hs[peak], opts);
    const near = (i) => i >= 0 && i < hs.length && score(hs[i], opts).level === target.level;
    let start = peak, end = peak;
    while (near(start - 1) && ms(hs[start - 1].t) + HOUR > after) start--;
    while (near(end + 1)) end++;
    return { start: ms(hs[start].t), end: ms(hs[end].t) + HOUR, hour: hs[peak], level: target.level, words: target.meaningful ? target.L : null };
  }
  function evaluate(a, opts = {}) {
    const now = opts.now ?? Date.now(), at = opts.at ?? now;
    const h = (a.hours || []).find((x) => ms(x.t) <= at && at < ms(x.t) + HOUR);
    const current = at < Math.floor(now / HOUR) * HOUR + HOUR;
    const sources = opts.sources || {};
    const unavailable = ["faa", "atcscc", "metar", "taf"].some((k) => !sources[k]?.ok || sources[k].error || sources[k].stale);
    const outdated = !Number.isFinite(ms(opts.generated)) || now - ms(opts.generated) > 30 * 60000;
    const missingWeather = !a.metar || !Number.isFinite(ms(a.metar.obsTime)) || now - ms(a.metar.obsTime) > 2 * HOUR;
    const incomplete = unavailable || missingWeather || opts.sample;
    const quality = outdated ? "Data may be outdated" : incomplete ? "Some data unavailable" : opts.hidden ? "Some disruptions hidden by your settings" : "";
    const programs = restrictions(a, at, now);
    const s = score(h, opts);
    const first = programs[0];
    let kind = "normal", headline = current ? "Operating normally" : "Normal conditions expected", level = s.level;
    if (!h) { kind = "unknown"; headline = "Forecast unavailable for this time"; level = null; }
    else if (first) {
      kind = current ? "active" : "forecast";
      headline = first.type === "closure" ? current ? "Airport closed" : "Airport closure scheduled"
        : first.type === "ground_stop" ? current ? "Flights to " + a.iata + " held" : "Ground stop scheduled"
        : first.type === "ground_delay" ? current ? "Arrival delays in effect" : "Arrival delay program scheduled" : "Delays happening now";
      level = Math.max(level, first.type === "closure" || first.type === "ground_stop" ? 4 : first.type === "ground_delay" ? 3 : 2);
    } else if (s.meaningful || s.level > 0) {
      kind = "forecast";
      headline = s.meaningful ? s.L.word.replace(/^Delays/, "Airport disruption") : s.level >= 3 ? "Airport disruption likely" : s.level >= 2 ? "Airport disruption possible" : "Minor disruption possible";
    }
    if (outdated || incomplete && kind === "normal") { kind = "unknown"; headline = outdated ? "Status may be outdated" : "No disruptions reported · some data unavailable"; }
    else if (opts.hidden && kind === "normal") headline = "No issues in your selected categories";
    if (kind === "normal" && opts.noticesDown) headline += " · notices unavailable"; // airport NOTAMs/TFRs couldn't be read: never an unqualified "normal"
    const window = h ? windowFor(a, opts, at) : null;
    const end = first && ms(first.end);
    // Recovery is a forecast, never a promise tied to an FAA program's scheduled end.
    let recovery = null;
    if (h && s.level >= 2) {
      const i = a.hours.indexOf(h);
      const lower = a.hours.find((x, j) => j > i && score(x, opts).level < s.level && !restrictions(a, ms(x.t), now).length && (j + 1 >= a.hours.length || score(a.hours[j + 1], opts).level < s.level));
      if (lower) recovery = ms(lower.t);
    }
    const reasons = uniq((h?.reasons || []).map((r) => opts.plain ? opts.plain(r, a) : r)).slice(0, 2);
    return { kind, headline, level, at, current, quality, reasons, programs, impacts: directionRows(programs, current),
      scheduledEnd: Number.isFinite(end) ? end : null,
      extension: first?.extension || null, window, recovery,
      cue: s.meaningful ? s.L.cue : "", size: s.meaningful ? s.L.size : "",
      basis: first ? current ? "FAA restriction" : "Scheduled FAA restriction" : kind === "forecast" ? "Airport forecast" : "Current conditions",
      // This definition deliberately describes an airport hour rather than a personal flight outcome.
      definition: "Risk of weather or air traffic control disruption across this airport during an hour.",
    };
  }
  function overlaps(window, at, until) {
    const start = ms(at), end = Number.isFinite(ms(until)) ? ms(until) : start + 1;
    return !!window && start < window.end && end > window.start;
  }
  return { evaluate, restrictions, directionRows, windowFor, overlaps };
});
