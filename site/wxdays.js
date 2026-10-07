// Weather page helpers (pure, no DOM): one condition classifier + emoji set shared by the Now card's current-conditions
// pill, the Weather page's hero and its Today / Tomorrow forecast rows, and the day-row builder that rolls the airport
// forecast (TAF periods, exact windows) into two plain summaries. Tested by tools/wxdays.test.mjs.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXWxDays = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const HOUR = 3600000;
  const mph1 = (kt) => Math.round(Number(kt) * 1.15);
  const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
  const lc = (x) => (x && /^[A-Z][a-z]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);

  // ---------- time ----------
  const fmts = new Map();
  function parts(ms, tz) {
    let f = fmts.get(tz);
    if (!f) {
      try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }); }
      catch (e) { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }); }
      fmts.set(tz, f);
    }
    const p = {};
    for (const x of f.formatToParts(ms)) if (x.type !== "literal") p[x.type] = Number(x.value);
    p.hour %= 24;
    return p;
  }
  const localHour = (ms, tz) => parts(ms, tz).hour;
  /** Instant of local midnight in tz, `add` days after the local day holding ms. */
  function midnight(ms, tz, add = 0) {
    const p = parts(ms, tz);
    const g = Date.UTC(p.year, p.month - 1, p.day + add);
    const off = (t) => { const q = parts(t, tz); return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - Math.floor(t / 1000) * 1000; };
    let t = g - off(g);
    const o2 = off(t);
    if (g - o2 !== t) t = g - o2;
    return t;
  }

  /** Is the sun down at (lat, lon) at ms? Solar elevation below -0.833°; local 7 PM – 6 AM when the position is unknown. */
  function nightAt(lat, lon, ms, tz) {
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const R = Math.PI / 180, d = (ms - 946728000000) / 864e5;
      const g = (357.529 + 0.98560028 * d) * R;
      const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
      const e = (23.439 - 3.6e-7 * d) * R;
      const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
      const ha = ((18.697374558 + 24.06570982441908 * d) * 15 + lon) * R - ra;
      return Math.asin(Math.sin(lat * R) * Math.sin(dec) + Math.cos(lat * R) * Math.cos(dec) * Math.cos(ha)) < -0.833 * R;
    }
    const hr = localHour(ms, tz || "UTC");
    return hr < 6 || hr >= 19;
  }

  // ---------- one classifier, one emoji set ----------
  /** Cloud covers from a METAR/TAF string ("FEW050 BKN250" -> ["FEW", "BKN"]; remarks ignored) or a clouds list. */
  function coversOf(src) {
    if (Array.isArray(src)) return src.map((c) => String((c && c.cover) || "").toUpperCase()).filter(Boolean);
    return (String(src || "").split(/\sRMK\s/)[0].match(/\b(FEW|SCT|BKN|OVC|VV)\d{3}/g) || []).map((x) => x.replace(/\d+$/, ""));
  }
  const tokens = (wx) => String(wx || "").trim().split(/\s+/).filter(Boolean)
    .map((t) => /^(\+|-|VC)?([A-Z]+)$/.exec(t)).filter((m) => m && !m[2].startsWith("RE")).map((m) => ({ i: m[1] || "", k: m[2] }));
  /**
   * Weather kind from conditions {wx, cig, vis, wgst (kt)} and cloud covers: thunder, freezing, snow, showers, rain, fog,
   * wind, ovc, bkn, sct, few, clear — or null when nothing is known about the sky.
   */
  function kind(c, covers) {
    if (!c) return null;
    const tk = tokens(c.wx);
    const has = (re, vc) => tk.some((t) => (vc || t.i !== "VC") && re.test(t.k));
    if (has(/TS/, true)) return "thunder";
    if (has(/^FZ(RA|DZ)|PL|IC/)) return "freezing";
    if (has(/SN|SG|GS|GR/)) return "snow";
    if (has(/SH/, true)) return "showers";
    if (has(/RA|DZ|UP/)) return "rain";
    const cv = covers || [];
    if (has(/FG|BR|HZ|FU|DU|SA|VA/) || (c.vis != null && c.vis < 3) || cv.includes("VV")) return "fog";
    if (c.wgst != null && mph1(c.wgst) >= 25) return "wind";
    if (cv.includes("OVC")) return "ovc";
    if (cv.includes("BKN")) return "bkn";
    if (cv.includes("SCT")) return "sct";
    if (cv.includes("FEW")) return "few";
    if (c.cig != null) return "bkn";
    return covers ? "clear" : null;
  }
  const EMOJI = { thunder: "⛈️", freezing: "🧊", snow: "🌨️", showers: "🌦️", rain: "🌧️", fog: "🌫️", wind: "💨", ovc: "☁️", bkn: "🌥️", sct: "⛅", few: "🌤️", clear: "☀️" };
  const EMOJI_NIGHT = { showers: "🌧️", bkn: "☁️", sct: "☁️", few: "🌙", clear: "🌙" };
  const emoji = (k, night) => (k ? (night && EMOJI_NIGHT[k]) || EMOJI[k] || "" : "");

  // ---------- plain words ----------
  /** Weather words for a wx string (same names as app.js shortCond): "Light snow", "Thunderstorms, rain"; "" when none. */
  function wxWords(wx) {
    const out = [];
    for (const { i, k } of tokens(wx)) {
      const deg = i === "+" ? "Heavy " : i === "-" ? "Light " : "";
      let p = null;
      if (/TS/.test(k)) p = i === "VC" ? "Storms nearby" : i === "+" ? "Heavy thunderstorms" : "Thunderstorms";
      else if (/FZRA/.test(k)) p = "Freezing rain";
      else if (/FZDZ/.test(k)) p = "Freezing drizzle";
      else if (/FZFG/.test(k)) p = "Freezing fog";
      else if (/SN/.test(k)) p = deg + "snow";
      else if (/PL/.test(k)) p = "Sleet";
      else if (/SHRA/.test(k)) p = i === "VC" ? "Showers nearby" : deg + "showers";
      else if (/RA/.test(k)) p = deg + "rain";
      else if (/DZ/.test(k)) p = deg + "drizzle";
      else if (/FG/.test(k)) p = i === "VC" ? "Fog nearby" : "Fog";
      else if (/BR/.test(k)) p = "Light fog / haze";
      else if (/HZ/.test(k)) p = "Haze";
      else if (/FU/.test(k)) p = "Smoke";
      if (p) out.push(cap(p.trim()));
    }
    // one name per thing: "Heavy snow" covers a later "Snow"
    const keep = out.filter((p, n) => out.indexOf(p) === n && !out.some((o) => o !== p && o.toLowerCase().endsWith(" " + p.toLowerCase())));
    return keep.slice(0, 2).map((p, n) => (n ? lc(p) : p)).join(", ");
  }
  const COVER_WORD = { ovc: "Cloudy", bkn: "Mostly cloudy", sct: "Partly cloudy", few: "Mostly clear", clear: "Clear" };
  const PRI = { thunder: 9, freezing: 8, snow: 7, rain: 6, showers: 6 };
  /** {txt, pri, kind} for one hour's conditions; pri >= 3 is disruptive (named with its timing in the summary). */
  function phrase(c) {
    const k = kind(c, c.covers);
    const w = wxWords(c.wx);
    if (w) return { txt: w, kind: k, pri: PRI[k] || (k === "fog" && tokens(c.wx).some((t) => /FG/.test(t.k) && t.i !== "VC") ? 5 : 2) };
    if (c.vis != null && c.vis < 3) return { txt: "Low visibility", kind: "fog", pri: 4 };
    if (c.cig != null && c.cig < 1000) return { txt: "Low clouds", kind: k === "fog" ? "fog" : "ovc", pri: 3 };
    const ck = k === "wind" ? kind(Object.assign({}, c, { wgst: null }), c.covers) : k;
    return { txt: COVER_WORD[ck] || "", kind: ck, pri: 0 };
  }
  const PART = (hr) => (hr < 5 || hr >= 22 ? "overnight" : hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening");
  /** "in the morning", "overnight", "in the afternoon and evening"; "" when it spans three or more parts of the day. */
  function whenWords(list) {
    const u = [...new Set(list)];
    if (u.length > 2) return "";
    if (u.length === 2 && !u.includes("overnight")) return "in the " + u.join(" and ");
    return u.map((p) => (p === "overnight" ? "overnight" : "in the " + p)).join(" and ");
  }
  const mode = (arr) => {
    const n = new Map();
    for (const x of arr) n.set(x, (n.get(x) || 0) + 1);
    let best = null;
    for (const [x, c] of n) if (best == null || c > n.get(best)) best = x;
    return best;
  };
  const FC = ["LIFR", "IFR", "MVFR", "VFR"];
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (d) => COMPASS[Math.round((((Number(d) % 360) + 360) % 360) / 45) % 8];

  /** TAF period cond -> the hour-condition shape used here. */
  const fromTaf = (c) => ({ wx: c.wx || null, cig: c.ceiling ?? null, vis: c.visib ?? null, wdir: c.wind ? c.wind.dir : null, wspd: c.wind ? c.wind.spd : null,
    wgst: c.gust ?? null, covers: Array.isArray(c.clouds) ? coversOf(c.clouds) : null, fltCat: c.fltCat || null });
  const fromHour = (x) => ({ wx: x.wx || null, cig: x.cig ?? null, vis: x.vis ?? null, wdir: x.wdir ?? null, wspd: x.wspd ?? null, wgst: x.wgst ?? null, covers: null, fltCat: x.fltCat || null });

  /**
   * Two forecast rows, Today (now to the airport's local midnight) and Tomorrow (the next local calendar day), from the
   * TAF's display periods (exact windows; TEMPO/PROB folded in as "at times" / "chance of") and, only for time no TAF
   * period covers, the app's hourly conditions (level not null). Ranges are min–max over the covered hours.
   * opts: {now, tz (airport zone), periods, hours, lat, lon}. Times are ms.
   */
  function days(opts) {
    const now = opts.now, tz = opts.tz || "UTC";
    const periods = (opts.periods || []).map((p) => Object.assign({}, p, { f: Date.parse(p.from), t: Date.parse(p.to) })).filter((p) => p.t > p.f);
    const prev = periods.filter((p) => p.kind === "prevailing").sort((x, y) => x.f - y.f);
    const over = periods.filter((p) => p.kind === "TEMPO" || p.kind === "PROB");
    const tafEnd = prev.length ? Math.max(...prev.map((p) => p.t)) : null;
    const hours = (opts.hours || []).filter((x) => x && x.level != null).map((x) => ({ s: Date.parse(x.t), x }));
    const m1 = midnight(now, tz, 1), m2 = midnight(now, tz, 2);
    return [build("today", "Today", now, m1), build("tomorrow", "Tomorrow", m1, m2)];

    function build(key, label, start, end) {
      const slots = [];
      for (let ts = start; ts < end; ts = Math.floor(ts / HOUR) * HOUR + HOUR) {
        const p = prev.find((x) => x.f <= ts && ts < x.t);
        let base = null, until = null;
        if (p) { base = fromTaf(p.cond || {}); until = p.t; }
        else {
          const hr = hours.find((y) => y.s <= ts && ts < y.s + HOUR);
          if (hr) { base = fromHour(hr.x); until = hr.s + HOUR; }
        }
        if (!base) continue;
        const ov = over.filter((x) => x.f <= ts && ts < x.t).map((x) => ({ kind: x.kind, probability: x.probability, c: fromTaf(x.cond || {}) }));
        slots.push({ ts, part: PART(localHour(ts, tz)), base, ov, until, ph: phrase(base) });
      }
      const day = { key, label, start, end, hours: slots.length, tafEnd };
      if (!slots.length) return Object.assign(day, { none: true, summary: "No forecast", noAfter: tafEnd != null && tafEnd <= start ? tafEnd : null });
      const last = Math.min(end, Math.max(...slots.map((s) => s.until)));
      day.from = slots[0].ts > start + HOUR - 1 ? slots[0].ts : null;
      day.until = last < end ? last : null;
      // gaps inside the covered span (no TAF period and no hourly conditions)
      day.gaps = [];
      for (let n = 1; n < slots.length; n++) {
        const gapFrom = slots[n - 1].until;
        if (slots[n].ts > gapFrom && slots[n].ts - slots[n - 1].ts > HOUR) day.gaps.push({ from: gapFrom, to: slots[n].ts });
      }

      // summary words
      const base = slots.map((s) => s.ph);
      const top = base.reduce((b, x) => (x.pri > b.pri ? x : b), base[0]);
      let text;
      const quiet = base.filter((x) => x.pri < 3 && x.txt);
      if (top.pri < 3) {
        const q = quiet.map((x) => x.txt);
        // sky words change often; "then" only when the sky really changes (clear/mostly clear, partly, mostly cloudy/cloudy)
        const B = { Clear: 0, "Mostly clear": 0, "Partly cloudy": 1, "Mostly cloudy": 2, Cloudy: 2 };
        const same = (x, y) => x === y || (B[x] != null && B[x] === B[y]);
        if (!q.length) text = "No significant weather";
        else if (same(q[0], q[q.length - 1])) text = mode(q);
        else {
          const head = q.filter((x) => same(x, q[0])), tail = q.filter((x) => same(x, q[q.length - 1]));
          text = mode(head) + ", then " + lc(mode(tail));
        }
      } else {
        const on = slots.filter((s) => s.ph.txt === top.txt);
        if (on.length === slots.length) text = top.txt;
        else {
          const when = whenWords(on.map((s) => s.part));
          const lastTxt = base[base.length - 1].txt;
          if (base[0].txt === top.txt && lastTxt !== top.txt && lastTxt) text = (top.txt + " " + when).trim() + ", then " + lc(lastTxt);
          else {
            const rest = mode(quiet.map((x) => x.txt));
            text = rest ? rest + ", " + (lc(top.txt) + " " + when).trim() : (top.txt + " " + when).trim();
          }
        }
      }
      // temporary and chance groups: the worst one of each that is worse than the hour's own conditions
      const extra = [];
      let worst = top;
      for (const kindName of ["TEMPO", "PROB"]) {
        let best = null;
        const at = [];
        for (const s of slots) for (const o of s.ov.filter((x) => x.kind === kindName)) {
          const ph = phrase(Object.assign({}, s.base, o.c));
          if (ph.pri < 2 || ph.pri <= s.ph.pri || ph.txt === s.ph.txt) continue;
          if (!best || ph.pri > best.pri) { best = ph; at.length = 0; }
          if (ph.txt === best.txt) at.push(s.part);
        }
        if (!best || extra.some((x) => x.txt === best.txt) || (top.pri >= 3 && best.txt === top.txt)) continue;
        extra.push({ kind: kindName, txt: best.txt, when: whenWords(at) });
        if (best.pri > worst.pri) worst = best;
      }
      for (const x of extra) text += ", " + (x.kind === "TEMPO" ? "at times " : "chance of ") + (lc(x.txt) + " " + x.when).trim();
      day.summary = text;
      day.extra = extra;

      // ranges (prevailing hours; gusts, visibility, ceiling and category also over temporary groups, never chance groups)
      const sus = slots.map((s) => s.base).filter((c) => c.wspd != null);
      if (sus.length) {
        const sp = sus.map((c) => mph1(c.wspd)), lo = Math.min(...sp), hi = Math.max(...sp);
        const dirs = sus.filter((c) => c.wspd > 0 && c.wdir != null && c.wdir !== "VRB").map((c) => compass(c.wdir));
        const dir = !dirs.length ? (hi > 0 ? "Variable" : "") : dirs[0] === dirs[dirs.length - 1] || new Set(dirs).size === 1 ? mode(dirs) : dirs[0] + " to " + dirs[dirs.length - 1];
        day.wind = { lo, hi, dir, text: hi === 0 ? "Calm" : (dir ? dir + " " : "") + (lo === hi ? hi : lo === 0 ? "up to " + hi : lo + "–" + hi) + " mph" };
      }
      const tempo = slots.flatMap((s) => s.ov.filter((o) => o.kind === "TEMPO").map((o) => Object.assign({}, s.base, o.c)));
      const all = slots.map((s) => s.base).concat(tempo);
      const g = all.map((c) => c.wgst).filter((x) => x != null);
      day.gust = g.length ? mph1(Math.max(...g)) : null;
      const vis = all.map((c) => c.vis).filter((x) => x != null);
      day.vis = vis.length ? Math.min(...vis) : null;
      const cig = all.map((c) => c.cig).filter((x) => x != null);
      day.cig = cig.length ? Math.min(...cig) : null;
      const cats = all.map((c) => c.fltCat).filter((x) => FC.includes(x));
      day.fltCat = cats.length ? cats.reduce((b, x) => (FC.indexOf(x) < FC.indexOf(b) ? x : b)) : null;

      // emoji: the most disruptive condition, else gusts, else the usual sky; night when most covered hours are dark
      const nights = slots.filter((s) => nightAt(opts.lat, opts.lon, s.ts, tz)).length;
      day.night = nights * 2 > slots.length;
      day.kind = worst.pri >= 3 ? worst.kind : day.gust != null && day.gust >= 25 ? "wind" : mode(base.filter((x) => x.pri === 0 && x.kind).map((x) => x.kind)) || mode(base.filter((x) => x.kind).map((x) => x.kind)) || null;
      day.emoji = emoji(day.kind, day.night);
      // the hours a disruptive condition applies (the page looks their timeline level up)
      day.hot = slots.filter((s) => s.ph.pri >= 3 || s.ov.some((o) => o.kind === "TEMPO" && phrase(Object.assign({}, s.base, o.c)).pri >= 3)).map((s) => s.ts);
      return day;
    }
  }

  return { HOUR, kind, emoji, coversOf, wxWords, phrase, nightAt, midnight, days, compass };
});
