// Disruption categories for Settings → "Show these disruptions" (build2b). Pure, no DOM: loaded by
// index.html before app.js (window.AWXCats) and by tools/cats.test.mjs in Node (module.exports).
//
// The data keeps one list of reason strings per hour (status.json `hours[].reasons`, written by
// poller/risk.mjs); a hidden category drops its reasons and the hour's level is recomputed from the
// reasons left. So each reason needs a category and its level, read back from the reason text (and the
// cause class wording risk.mjs puts in it). The test checks that, for every hour in the fixtures and
// scenarios, the highest level read back equals the level the poller computed.
//
// Category "always" (ground stops, full airport closures) can never be hidden. null = plain weather
// with no toggle (rain, drizzle): always shown.
(function (root) {
  "use strict";
  var KEYS = ["storms", "winter", "wind", "fog", "heat", "faa", "atc", "runways", "vip", "space", "tstm"];
  var LABELS = {
    storms: "Thunderstorms", winter: "Winter weather", wind: "Wind", fog: "Low clouds & fog", heat: "Heat",
    faa: "FAA delay programs & ground stops", atc: "ATC staffing & equipment", runways: "Runway closures",
    vip: "VIP / security restrictions", space: "Space launches", tstm: "General thunderstorm info",
  };

  function visNum(v) {
    var n = 0;
    String(v).trim().split(/\s+/).forEach(function (p) {
      if (p.indexOf("/") >= 0) { var q = p.split("/"); n += Number(q[1]) ? Number(q[0]) / Number(q[1]) : 0; } else n += Number(p) || 0;
    });
    return n;
  }
  /** Program cause wording (risk.mjs causePhrase / ops plan cause) -> category for a non-ground-stop program. */
  function programCat(text) {
    var s = String(text || "");
    if (/air traffic control staffing|equipment outage|staffing/i.test(s)) return "atc";
    if (/\bsecurity\b|VIP movement/i.test(s)) return "vip";
    if (/space launch/i.test(s)) return "space";
    return "faa";
  }
  /** Ops plan "FAA reports <phrase> affecting arrivals" phrase -> category. */
  function phraseCat(p) {
    var s = String(p || "");
    if (/storm|thunder/.test(s)) return "storms";
    if (/wind/.test(s)) return "wind";
    if (/low clouds|visibility|fog/.test(s)) return "fog";
    if (/winter/.test(s)) return "winter";
    if (/runway/.test(s)) return "runways";
    if (/equipment/.test(s)) return "atc";
    return "faa";
  }
  var ALERTS = [
    [/^(Tornado) Warning/, "storms", 4], [/^(Blizzard|Ice Storm) Warning/, "winter", 4], [/^(Hurricane|Extreme Wind) Warning/, "wind", 4],
    [/^Severe Thunderstorm Warning/, "storms", 3], [/^Winter Storm Warning/, "winter", 3], [/^(Tropical Storm|High Wind) Warning/, "wind", 3],
    [/^Winter Weather Advisory/, "winter", 2], [/^Wind Advisory/, "wind", 2], [/^Dense Fog Advisory/, "fog", 2],
  ];
  /** NWS alert event -> category (also for alerts that never set a level, e.g. heat). */
  function alertCat(ev) {
    var e = String(ev || "");
    for (var i = 0; i < ALERTS.length; i++) if (ALERTS[i][0].test(e)) return ALERTS[i][1];
    if (/heat/i.test(e)) return "heat";
    if (/thunder|tornado/i.test(e)) return "storms";
    if (/winter|snow|ice|freez|blizzard|frost|cold|chill/i.test(e)) return "winter";
    if (/wind|hurricane|tropical|gale/i.test(e)) return "wind";
    if (/fog|smoke|dust/i.test(e)) return "fog";
    return null;
  }
  var SPC = { Marginal: 1, Slight: 2, Enhanced: 3, Moderate: 4, High: 4 };

  /**
   * One reason string (as in status.json, raw or with a "forecast 4–7 PM" window added) ->
   * {cat, level, src, conf}: level null when it can't be read back. src: FAA | NWS | SPC | TAF | LAMP | METAR.
   * conf: high (official FAA program / NWS warning / observed) | medium (TAF prevailing, outlooks) | low (chance / LAMP).
   */
  function reason(text) {
    var s = String(text || "");
    var m;
    var chance = /^Chance of /.test(s);
    if (chance) {
      var inner = reason(s.slice(10).charAt(0).toUpperCase() + s.slice(11));
      return { cat: inner.cat, level: inner.level == null ? null : Math.max(0, inner.level - 1), src: "TAF", conf: "low" };
    }
    var r = function (cat, level, src, conf) { return { cat: cat, level: level, src: src, conf: conf }; };
    // hubs hook: hub cascade note (poller/hubs.mjs): "ORD ground stop may delay (some) flights to and from Chicago"
    if ((m = /^[A-Z]{3} (closure|ground stop|ground delay program|delays) may (?:disrupt|delay|spread to) (some )?flights to and from /.exec(s))) return r("faa", m[2] ? 1 : 2, "FAA", "medium");
    // FAA programs (NAS status, ATCSCC advisories, ops plan)
    if (/^Ground stop\b/.test(s)) return r("always", 4, "FAA", "high");
    if (/^Airport closed\b/.test(s)) return r("always", 4, "FAA", "high");
    if (/^Ground delay program\b/.test(s)) return r(programCat(s), 3, "FAA", "high");
    if (/^Delays\b/.test(s)) return r(programCat(s), 2, "FAA", "high");
    if ((m = /^FAA plans a possible (ground stop|ground delay program|ground stop or delay program)/.exec(s))) return r(programCat(s), 2, "FAA", "medium");
    if (/^FAA reports delays\b/.test(s)) return r("faa", 2, "FAA", "high");
    if ((m = /^FAA reports (.+?) affecting arrivals/.exec(s))) return r(phraseCat(m[1]), 1, "FAA", "high");
    if (/^Air traffic control staffing/.test(s)) return r("atc", 2, "FAA", "high");
    if (/^Runways? .*\b(glideslope|ILS)\b/.test(s)) return r("atc", 1, "FAA", "high");
    // restrictions hook: FAA runway constraints; keep these separate from weather
    if (/^(ILS|glideslope) out of service\b/.test(s)) return r("atc", 1, "FAA", "high");
    if (/^VIP movement\b/.test(s)) return r("vip", 2, "FAA", "high");
    if (/^Space launch nearby\b/.test(s)) return r("space", 1, "FAA", "high");
    if (/^Runways? .*\b(closed|construction|limited operations|out of service)\b/.test(s)) return r("runways", 1, "FAA", "high");
    if (/^Runway closed\b/.test(s)) return r("runways", 1, "FAA", "high");
    // advisories
    if (/^Convective SIGMET\b/.test(s)) return r("storms", 3, "NWS", "high");
    if (/^Center weather advisory: thunderstorms/.test(s)) return r("storms", 2, "NWS", "high");
    if (/^Center weather advisory: (IFR|low clouds)/.test(s)) return r("fog", 2, "NWS", "high");
    if ((m = /^(Marginal|Slight|Enhanced|Moderate|High) risk of severe storms/.exec(s))) return r("storms", SPC[m[1]], "SPC", "medium");
    if (/^General thunderstorms possible/.test(s)) return r("tstm", 0, "SPC", "medium");
    if ((m = /^Thunder chance (\d+)%/.exec(s))) return r("storms", Number(m[1]) >= 40 ? 3 : Number(m[1]) >= 20 ? 2 : 0, "LAMP", "low");
    if (/^Storms likely nearby/.test(s)) return r("storms", 2, "LAMP", "low");
    if ((m = /^Thunderstorms, (high|medium|low) coverage \(TCF\)/.exec(s))) return r("storms", m[1] === "high" ? 3 : m[1] === "medium" ? 2 : 0, "NWS", "medium");
    for (var i = 0; i < ALERTS.length; i++) if (ALERTS[i][0].test(s)) return r(ALERTS[i][1], ALERTS[i][2], "NWS", "high");
    // conditions (METAR / TAF): src is filled in by the caller (observed vs forecast)
    var w = function (cat, level) { return r(cat, level, null, null); };
    if (/^Heavy thunderstorms\b/.test(s)) return w("storms", 4);
    if (/^Thunderstorm gusts \d+ kt/.test(s)) return w("storms", 4);
    if (/^Thunderstorms nearby\b/.test(s)) return w("storms", 3);
    if (/^Thunderstorms\b/.test(s)) return w("storms", 3);
    if (/^Freezing rain\b/.test(s)) return w("winter", 4);
    if (/^(Freezing drizzle|Ice pellets|Heavy snow)\b/.test(s)) return w("winter", 3);
    if (/^Snow, visibility\b/.test(s)) return w("winter", 3);
    if (/^Snow\b/.test(s)) return w("winter", 2);
    if ((m = /^Gusts (\d+) kt/.exec(s))) return w("wind", Number(m[1]) >= 35 ? 3 : Number(m[1]) >= 25 ? 2 : 0);
    if ((m = /^Ceiling ([\d,]+) ft/.exec(s))) { var ft = Number(m[1].replace(/,/g, "")); return w("fog", ft < 500 ? 3 : ft < 1000 ? 2 : ft <= 3000 ? 1 : 0); }
    if ((m = /^Visibility ((?:\d+ )?\d+(?:\/\d+)?) sm/.exec(s))) { var v = visNum(m[1]); return w("fog", v < 1 ? 3 : v < 3 ? 2 : v <= 5 ? 1 : 0); }
    if (/^Mist\b/.test(s)) return w("fog", 1);
    if (/^(Rain|Drizzle)\b/.test(s)) return w(null, 1);
    return r(null, null, null, null);
  }

  /** FAA NAS status entry -> category ("always" for ground stops and active full closures). */
  function faa(f) {
    if (f.type === "ground_stop") return "always";
    if (f.type === "closure") return (f.scope || "full") === "full" && f.active !== false ? "always" : "runways";
    var c = f.cause;
    if (c === "staffing" || c === "equipment") return "atc";
    if (c === "vip" || c === "security") return "vip";
    if (c === "space") return "space";
    return "faa";
  }
  /** ATCSCC advisory {type, active, cause}. */
  function adv(x) {
    if (x.type === "GS" && x.active) return "always";
    return faa({ type: "delay", cause: x.cause });
  }
  /** Ops plan item {kind, text, cause}. */
  function planItem(x) {
    if (x.kind === "program" && /^Ground stop\b/.test(x.text || "") && x.level >= 4) return "always";
    var c = reason(x.text).cat;
    return c === undefined ? "faa" : c || "faa";
  }

  /** Is this category hidden under these settings? ("always" and null never are.) */
  function hidden(cat, hide) {
    return !!(cat && cat !== "always" && hide && hide[cat]);
  }

  /**
   * One hour {level, reasons} with hidden categories removed: {level, reasons, dropped}. The level is the
   * highest level read back from the reasons kept; a kept reason whose level can't be read keeps the
   * poller's level (never under-reports), and the result never exceeds it.
   */
  function filterHour(hr, hide) {
    var kept = [];
    var dropped = 0;
    var lvl = 0;
    var unknown = false;
    (hr.reasons || []).forEach(function (t) {
      var c = reason(t);
      if (hidden(c.cat, hide)) { dropped++; return; }
      kept.push(t);
      if (c.level == null) unknown = true;
      else if (c.level > lvl) lvl = c.level;
    });
    if (!dropped) return { level: hr.level, reasons: hr.reasons || [], dropped: 0 };
    return { level: unknown || hr.level == null ? hr.level : Math.min(hr.level, lvl), reasons: kept, dropped: dropped }; // null = no forecast stays unknown
  }

  /**
   * Departure vs arrival impact in plain words for one card (build2b), or null. reasons: the hour's reason
   * strings; programs: FAA programs covering it [{type: ground_stop|ground_delay|delay|closure, detail}].
   * FAA programs are facts ("held"); weather is worded as likely. Low clouds / visibility mainly cut arrival
   * rates; thunderstorms hold departures; winter weather (de-icing) and strong crosswinds slow both.
   */
  function impact(reasons, programs) {
    var P = programs || [];
    var has = function (t) { return P.some(function (p) { return p.type === t; }); };
    if (has("closure")) return "No flights in or out (airport closed)";
    if (has("ground_stop")) return "Departures held (ground stop)";
    if (has("ground_delay")) return "Arrivals held at their origin (delay program)";
    var dly = P.filter(function (p) { return p.type === "delay"; }).map(function (p) { return String(p.detail || ""); }).join(" ");
    if (dly) {
      var dep = /Departures|Arrivals\/Departures/i.test(dly), arr = /Arrivals/i.test(dly);
      return (dep && arr ? "Both directions delayed" : dep ? "Departures delayed" : arr ? "Arrivals delayed" : "Delays reported") + " (FAA)";
    }
    // outlooks (SPC) describe the region's risk, not this airport's operations
    var R = (reasons || []).map(function (t) { var c = reason(t); return { t: String(t), cat: c.cat, level: c.level || 0, src: c.src }; })
      .filter(function (x) { return x.src !== "SPC"; });
    for (var i = 0; i < R.length; i++) {
      var fm = /^FAA reports (.+?) affecting arrivals/.exec(R[i].t);
      if (fm && !R.some(function (x) { return x.cat === "storms" && x.level >= 2; })) return "Arrivals likely slowed (FAA: " + fm[1] + ")";
    }
    var any = function (cat, min) { return R.some(function (x) { return x.cat === cat && x.level >= min; }); };
    if (any("storms", 2)) return "Departures likely held (storms)";
    if (any("winter", 2)) return "Both directions likely slowed (de-icing, snow or ice)";
    if (any("wind", 3) || R.some(function (x) { return x.cat === "wind" && /Warning|Advisory/.test(x.t) && x.level >= 2; })) return "Both directions likely slowed (strong crosswinds)";
    if (any("fog", 2)) {
      var vis = R.some(function (x) { return x.cat === "fog" && x.level >= 2 && /^(Chance of )?[Vv]isibility|Fog/.test(x.t); });
      return "Arrivals likely slowed (" + (vis ? "poor visibility" : "low clouds") + ")";
    }
    if (any("vip", 2)) return "Brief ground holds possible (VIP movement)"; // restrictions hook
    if (any("runways", 2)) return "Both directions may be slowed (fewer runways)"; // restrictions hook
    if (any("atc", 2)) return "Both directions may be slowed (air traffic control staffing)";
    if (any("faa", 2)) return "Delays reported (FAA)";
    return null;
  }

  /**
   * What the sheet shows at rest (build2b): "split" = Now | Peak (a later, higher peak exists); "single" = one
   * full-width "Now · Peak" card (the current hour is the peak); "clear" = one card, clear for the whole window.
   */
  function restLayout(nowLevel, peakLevel, peakIsLater) {
    if (peakIsLater && peakLevel > nowLevel) return "split";
    return peakLevel > 0 || nowLevel > 0 ? "single" : "clear";
  }

  var api = { impact: impact, restLayout: restLayout, KEYS: KEYS, LABELS: LABELS, reason: reason, faa: faa, adv: adv, planItem: planItem, alert: alertCat, hidden: hidden, filterHour: filterHour, programCat: programCat };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AWXCats = api;
})(typeof window !== "undefined" ? window : this);
