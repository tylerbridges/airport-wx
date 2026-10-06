// Loaded first (blocking, in <head>) by index.html (and check.html). Jobs:
// 1. Error capture for check.html's render test: window.__awxErrors collects uncaught errors,
//    unhandled rejections and console.error calls from this page.
// 2. Test scenarios: ?test=<name> makes app.js read data/scenarios/<name>.json instead of
//    data/summary.json (and searched.js read data/scenarios/<name>/wx/, trips.js <name>/trips.json). A scenario
//    file is a full build; app.js splits it in memory (site/split.js), so its airport details are ready at once.
//    Scenario files are built once by tools/build-scenarios.mjs, so rebase() shifts every ISO time
//    in them by the same amount to make the scenario look current (minus its lagMin, e.g. the
//    stale-data scenario). While a scenario is open (scenarios hook):
//    - nothing is saved: writes to awx-* localStorage keys (favourites, settings, trips, recent
//      searches) go to a per-tab overlay in sessionStorage instead, so they last for the test session
//      and the real values are untouched (an overlay entry is dropped once the real value changes);
//    - data/config.json answers with the scenario's config (<name>/config.json: no live relay, or a
//      dead one), and the scenario's movement (<name>/movement.json) is handed to site/movement.js;
//    - the banner gets "· Exit" (back to live data), and says so when the scenario set any delay
//      chances itself (scenario.json delayOverride);
//    - LIVE_PATH scenarios run the app's normal live path instead of its test-mode shortcut (app.js
//      never calls the relay in test mode): data/summary.json, trips.json, wx/ and movement.json are
//      answered from the scenario (shifted the same way) and the relay named in its config is
//      unreachable, so the page has to say so itself.
// 3. The "Test scenarios" sheet (AWXTest.openPicker(), from the menu: site/nav.js "scenarios hook"):
//    every scenario in data/scenarios/index.json by group, Exit test mode, and Run all checks.
(function () {
  "use strict";
  var errs = (window.__awxErrors = []);
  var push = function (kind, msg) { errs.push({ kind: kind, msg: String(msg).slice(0, 500), at: Date.now() }); };
  window.addEventListener("error", function (e) {
    push("error", e.message || (e.target && e.target.src ? "failed to load " + e.target.src : "error"));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { push("rejection", e.reason && e.reason.message ? e.reason.message : e.reason); });
  var ce = console.error;
  console.error = function () {
    try { push("console", Array.prototype.map.call(arguments, String).join(" ")); } catch (x) { /* ignore */ }
    return ce.apply(console, arguments);
  };

  var m = /[?&]test=([a-z0-9-]{1,60})(?:&|$)/.exec(location.search);
  var scen = m ? m[1] : null;
  // Scenarios that run the app's live-relay path against their own (dead) relay. Must match the
  // scenarios whose scenario.json has config.liveUrl (tools/build-scenarios.mjs checks this).
  var LIVE_PATH = { "live-relay-down": 1 };
  var live = !!(scen && LIVE_PATH[scen]);
  var name = live ? null : scen; // a LIVE_PATH page looks like a live page to app.js
  var ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/;
  var SCN = "./data/scenarios/";

  function shift(v, d) {
    if (typeof v === "string") return ISO.test(v) ? new Date(Date.parse(v) + d).toISOString() : v;
    if (Array.isArray(v)) return v.map(function (x) { return shift(x, d); });
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = shift(v[k], d);
      return o;
    }
    return v;
  }
  // Reason texts carry the airport's local clock times as written at build time ("until 11 AM ET", "forecast 4–7 PM",
  // "Sun 2:05 AM"); shiftClocks() moves them by the same delta as the ISO times so the words match the shifted data.
  // Dates written as "Nov 4" stay as they are.
  var CLOCK = /\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(\d{1,2})(?::(\d\d))?(?:–(\d{1,2})(?::(\d\d))?)? (AM|PM)\b/g;
  var WDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var SKIP = { raw: 1, rawText: 1, title: 1, id: 1, iata: 1, icao: 1, name: 1, city: 1, state: 1, tz: 1, t: 1 };
  var dtfs = {};
  function parts(ms, tz) {
    var k = tz;
    if (!dtfs[k]) dtfs[k] = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
    var o = {};
    dtfs[k].formatToParts(ms).forEach(function (x) { o[x.type] = x.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: o.weekday };
  }
  function wall(y, mo, d, h, mi, tz) { // the instant of a wall-clock time in tz
    var g = Date.UTC(y, mo - 1, d, h, mi);
    for (var i = 0; i < 2; i++) { var p = parts(g, tz); g += (Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)); }
    return g;
  }
  function clockText(ms, tz, withWd) {
    var p = parts(ms, tz);
    var h12 = p.h % 12 || 12;
    return (withWd ? p.wd + " " : "") + h12 + (p.mi ? ":" + (p.mi < 10 ? "0" : "") + p.mi : "") + " " + (p.h < 12 ? "AM" : "PM");
  }
  function shiftClocks(text, tz, ref, d) {
    if (typeof text !== "string" || !/\d (AM|PM)\b/.test(text)) return text;
    var base = parts(ref, tz);
    var resolve = function (h12, mi, ap, wd) {
      var hr = (Number(h12) % 12) + (ap === "PM" ? 12 : 0);
      for (var k = -1; k <= 7; k++) {
        var t = wall(base.y, base.mo, base.d + k, hr, Number(mi || 0), tz);
        if (wd ? parts(t, tz).wd === wd && t >= ref - 24 * 3600e3 : t >= ref - 3 * 3600e3) return t;
      }
      return wall(base.y, base.mo, base.d, hr, Number(mi || 0), tz);
    };
    return text.replace(CLOCK, function (all, wd, h1, m1, h2, m2, ap) {
      var round = function (t) { return Math.floor((t + d) / 60e3) * 60e3; }; // as the page shows shifted ISO times (to the minute)
      if (!h2) return clockText(round(resolve(h1, m1, ap, wd)), tz, !!wd);
      var end = round(resolve(h2, m2, ap, wd));
      var startRaw = resolve(h1, m1, ap, wd);
      if (startRaw > end - d) startRaw -= 24 * 3600e3;
      var a = clockText(round(startRaw), tz, !!wd), b = clockText(end, tz, false);
      var ha = a.slice(-2), hb = b.slice(-2);
      return ha === hb ? a.slice(0, -3) + "–" + b : a + " – " + b;
    });
  }
  function shiftAirportText(v, tz, ref, d, key) {
    if (typeof v === "string") return SKIP[key] ? v : shiftClocks(v, tz, ref, d);
    if (Array.isArray(v)) return v.map(function (x) { return shiftAirportText(x, tz, ref, d, key); });
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = SKIP[k] ? v[k] : shiftAirportText(v[k], tz, ref, d, k);
      return o;
    }
    return v;
  }
  /** Every airport's texts with their clock times moved by d (ref: when they were written). */
  function shiftTexts(data, d, ref) {
    if (!d || !data || !Array.isArray(data.airports) || !Number.isFinite(ref)) return data;
    var out = {};
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    out.airports = data.airports.map(function (a) {
      if (!a || !a.tz) return a;
      try { return shiftAirportText(a, a.tz, ref, d, null); } catch (e) { return a; }
    });
    return out;
  }
  function deltaOf(data, now) {
    var sc = data && data.scenario;
    return sc && sc.builtAt ? (now || Date.now()) - Date.parse(sc.builtAt) - (sc.lagMin || 0) * 60e3 : 0;
  }

  var T = (window.AWXTest = {
    name: name,
    scenario: scen, // the open scenario, LIVE_PATH ones included
    livePath: live,
    url: name ? SCN + name + ".json" : null,
    wxBase: name ? SCN + name + "/wx/" : "./data/wx/",
    delta: 0,
    info: null, // status.scenario of the open scenario once loaded
    /** Shift all times so the scenario's build time lands on now - lagMin. Later calls (shards) reuse the same shift. */
    rebase: function (data, opts) {
      var sc = data && data.scenario;
      if (sc && sc.builtAt) {
        this.delta = deltaOf(data, opts && opts.now);
        if (scen) { this.info = sc; scenarioLoaded(); }
      }
      return this.delta ? shiftTexts(shift(data, this.delta), this.delta, sc && Date.parse(sc.builtAt)) : data;
    },
    shift: shift,
    shiftClocks: shiftClocks, // tools/ and check: clock times in reason texts follow the shift
    openPicker: function () { openPicker(); },
    exitUrl: "./",
  });
  if (!scen) return;

  // ---------- nothing is saved while a scenario is open ----------

  var OVL = "awx-test:";
  try {
    var REAL = window.localStorage;
    var SS = window.sessionStorage;
    var P = Storage.prototype;
    var oGet = P.getItem, oSet = P.setItem, oRem = P.removeItem;
    var mine = function (st, k) { return st === REAL && /^awx-/.test(String(k)); };
    var overlay = function (k) {
      var raw = oGet.call(SS, OVL + k);
      if (raw == null) return null;
      try {
        var o = JSON.parse(raw);
        if (o.base === oGet.call(REAL, k)) return o;
      } catch (x) { /* corrupt: drop it */ }
      oRem.call(SS, OVL + k); // the real value changed since: it wins
      return null;
    };
    P.getItem = function (k) {
      if (mine(this, k)) { var o = overlay(k); if (o) return o.v; }
      return oGet.apply(this, arguments);
    };
    P.setItem = function (k, v) {
      if (!mine(this, k)) return oSet.apply(this, arguments);
      oSet.call(SS, OVL + k, JSON.stringify({ base: oGet.call(REAL, k), v: String(v) }));
    };
    P.removeItem = function (k) {
      if (!mine(this, k)) return oRem.apply(this, arguments);
      oSet.call(SS, OVL + k, JSON.stringify({ base: oGet.call(REAL, k), v: null }));
    };
  } catch (x) { /* storage blocked: nothing can be saved anyway */ }
  function clearOverlay() {
    try {
      var SS = window.sessionStorage;
      var keys = [];
      for (var i = 0; i < SS.length; i++) { var k = SS.key(i); if (k && k.indexOf(OVL) === 0) keys.push(k); }
      keys.forEach(function (k) { SS.removeItem(k); });
    } catch (x) { /* ignore */ }
  }
  T.exit = function () { clearOverlay(); location.href = T.exitUrl; };

  // ---------- data requests answered from the scenario ----------

  var ofetch = window.fetch.bind(window);
  var statusP = null;
  function scenarioStatus() {
    if (!statusP) statusP = ofetch(SCN + scen + ".json", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    return statusP;
  }
  var reply = function (obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } }); };
  /** Fetch a scenario file and shift its times like the scenario's status.json. */
  function shifted(path) {
    return scenarioStatus().then(function (st) {
      var d = deltaOf(st);
      return ofetch(SCN + scen + "/" + path, { cache: "no-store" }).then(function (r) {
        if (!r.ok) return r;
        return r.json().then(function (j) { return reply(shift(j, d)); });
      });
    });
  }
  var relayHost = null;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var u;
    try { u = new URL(url, location.href); } catch (x) { return ofetch(input, init); }
    if (relayHost && u.host === relayHost) return Promise.reject(new TypeError("Failed to fetch")); // the scenario's relay is down
    if (u.origin === location.origin) {
      var p = u.pathname;
      if (/\/data\/config\.json$/.test(p)) {
        return ofetch(SCN + scen + "/config.json", { cache: "no-store" }).then(function (r) {
          if (!r.ok) return reply({ liveUrl: null });
          return r.json().then(function (c) {
            try { relayHost = c && c.liveUrl ? new URL(c.liveUrl).host : null; } catch (x) { relayHost = null; }
            return reply(c);
          });
        });
      }
      if (live) {
        if (/\/data\/(?:status|summary)\.json$/.test(p)) { // the full scenario: app.js splits it in memory (site/split.js)
          return scenarioStatus().then(function (st) { T.info = st.scenario || null; scenarioLoaded(); var dd = deltaOf(st); return reply(shiftTexts(shift(st, dd), dd, st.scenario && Date.parse(st.scenario.builtAt))); });
        }
        var mm = /\/data\/(trips\.json|movement\.json|changes\.json|wx\/[A-Za-z0-9_.-]+\.json)$/.exec(p); // brief hook: changes.json
        if (mm) return shifted(mm[1]);
      }
    }
    return ofetch(input, init);
  };

  // ---------- after the scenario loads: movement, banner ----------

  var loadedOnce = false;
  function scenarioLoaded() {
    if (loadedOnce) return;
    loadedOnce = true;
    watchBanner();
    if (!live) feedMovement();
  }
  /** site/movement.js skips its own fetch in test mode: hand it the scenario's movement, shifted like the scenario. */
  function feedMovement() {
    var d = T.delta;
    ofetch(SCN + scen + "/movement.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (mv) {
      if (!mv) return;
      var data = shift(mv, d);
      var tries = 0;
      (function give() {
        var M = window.AWXMovement, A = window.AWXApp;
        if (M && M._set && A && A.render && A.state && A.state.data) {
          M._set(data);
          try { A.render(); } catch (x) { /* app renders again on its own */ }
        } else if (tries++ < 100) setTimeout(give, 50);
      })();
    }).catch(function () { /* no movement for this scenario */ });
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return e;
  }
  function exitLink() {
    return el("a", { href: T.exitUrl, class: "awx-tp-exit", "data-awx-exit": "1", onclick: function (e) { e.preventDefault(); T.exit(); } }, ["Exit"]);
  }
  /** "Test scenario: <title> (not live) · Exit" — app.js draws the banner (rebuilt on every render); this adds Exit, or the whole banner on LIVE_PATH pages. */
  function decorate() {
    var box = document.getElementById("banner");
    if (!box) return;
    var b = [].slice.call(box.querySelectorAll(".banner")).filter(function (x) { return /Test scenario/.test(x.textContent); })[0];
    var info = T.info || {};
    if (!b && live) {
      b = el("div", { class: "banner awx-tp-banner" }, [el("b", { text: "Test scenario: " + (info.title || scen) + " " }), "(not live)"]);
      box.prepend(b);
    }
    if (!b || b.querySelector("[data-awx-exit]")) return;
    tpStyle();
    var od = info.delayOverride;
    if (od && od.length) b.append(" · delay chances set by the scenario at " + od.map(function (x) { return x.iata; }).join(", "));
    b.append(" · ", exitLink());
  }
  var watching = false;
  function watchBanner() {
    if (watching) return;
    var go = function () {
      var box = document.getElementById("banner");
      if (!box) { setTimeout(go, 50); return; }
      watching = true;
      decorate();
      new MutationObserver(decorate).observe(box, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  }

  // ---------- "Test scenarios" sheet (function declarations: available before the early return above) ----------
  function tpStyle() {
    if (document.getElementById("awx-tp-style")) return;
    var css = document.createElement("style");
    css.id = "awx-tp-style";
    css.textContent = [
      ".awx-tp { position: fixed; inset: 0; z-index: 90; display: flex; align-items: flex-end; justify-content: center; }",
      ".awx-tp-bd { position: absolute; inset: 0; background: var(--backdrop, rgba(0,0,0,.5)); }",
      ".awx-tp-sh { position: relative; width: 100%; max-width: 560px; max-height: 88dvh; overflow: auto; overscroll-behavior: contain; background: var(--bg, #000); color: var(--text, #fff);",
      "  border-radius: 18px 18px 0 0; padding: 14px 16px calc(24px + env(safe-area-inset-bottom)); font: 15px/1.35 var(--font, system-ui, sans-serif); box-shadow: 0 -8px 30px rgba(0,0,0,.35); }",
      ".awx-tp-grab { width: 36px; height: 5px; border-radius: 3px; background: var(--line, rgba(255,255,255,.2)); margin: -4px auto 8px; }",
      ".awx-tp-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }",
      ".awx-tp-hd h2 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -.02em; }",
      ".awx-tp-x { font: inherit; font-weight: 600; color: var(--l1, #2ec4d6); background: none; border: 0; min-height: 44px; padding: 0 4px; cursor: pointer; }",
      ".awx-tp-note { color: var(--muted, #a1a1a6); font-size: 13px; margin: 0 2px 6px; }",
      ".awx-tp h3 { margin: 18px 4px 6px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted, #a1a1a6); }",
      ".awx-tp-g { background: var(--card, #1c1c1e); border-radius: 14px; overflow: hidden; }",
      ".awx-tp-r { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; padding: 10px 14px; min-height: 44px; cursor: pointer; text-decoration: none; }",
      ".awx-tp-r + .awx-tp-r { border-top: 1px solid var(--line, rgba(255,255,255,.1)); }",
      ".awx-tp-r b { display: block; font-weight: 600; }",
      ".awx-tp-r small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--muted, #a1a1a6); font-size: 13px; margin-top: 2px; }",
      ".awx-tp-r[aria-current=true] b::after { content: \" · open\"; color: var(--l2, #ffb020); font-weight: 600; }",
      ".awx-tp-r.acc b { color: var(--l1, #2ec4d6); }",
      ".awx-tp-r:focus-visible, .awx-tp-x:focus-visible { outline: 2px solid var(--l1, #2ec4d6); outline-offset: -2px; border-radius: 10px; }",
      ".banner .awx-tp-exit { color: var(--l1, #2ec4d6); font-weight: 600; }",
    ].join("\n");
    document.head.append(css);
  }
  function openPicker() {
    var T = window.AWXTest;
    var old = document.getElementById("awxTestPicker");
    if (old) old.remove();
    tpStyle();
    var mk = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    var prevFocus = document.activeElement;
    var wrap = mk("div", "awx-tp");
    wrap.id = "awxTestPicker";
    var bd = mk("div", "awx-tp-bd");
    var sh = mk("div", "awx-tp-sh");
    sh.setAttribute("role", "dialog");
    sh.setAttribute("aria-modal", "true");
    sh.setAttribute("aria-labelledby", "awxTpTitle");
    sh.append(mk("div", "awx-tp-grab"));
    var hd = mk("div", "awx-tp-hd");
    var h2 = mk("h2", null, "Test scenarios");
    h2.id = "awxTpTitle";
    var x = mk("button", "awx-tp-x", "Done");
    x.type = "button";
    hd.append(h2, x);
    var body = mk("div");
    body.append(mk("p", "awx-tp-note", "Sample situations run through the real data pipeline, with every time moved to now. Nothing you change while one is open is saved."));
    sh.append(hd, body);
    wrap.append(bd, sh);
    var ctl = null; // site/sheet.js: drag the header (or pull at the top) to close, back gesture, page scroll lock
    var closed = false;
    var close = function () {
      if (closed) return;
      closed = true;
      if (ctl) ctl.closed();
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    };
    var onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      var f = [].slice.call(sh.querySelectorAll("button, a[href]"));
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    x.onclick = close;
    bd.onclick = close;
    document.addEventListener("keydown", onKey, true);
    var row = function (title, sub, href, onclick, cls) {
      var r = mk("a", "awx-tp-r" + (cls ? " " + cls : ""));
      r.href = href;
      r.append(mk("b", null, title));
      if (sub) r.append(mk("small", null, sub));
      if (onclick) r.addEventListener("click", function (e) { e.preventDefault(); onclick(); });
      return r;
    };
    var group = function (title, rows) {
      var frag = document.createDocumentFragment();
      if (title) frag.append(mk("h3", null, title));
      var g = mk("div", "awx-tp-g");
      rows.forEach(function (r) { g.append(r); });
      frag.append(g);
      return frag;
    };
    var top = [];
    if (T && T.scenario) top.push(row("Exit test mode", "Back to live data", T.exitUrl, function () { T.exit(); }, "acc"));
    top.push(row("Run all checks", "Every scenario through the check page (check.html?mock=1)", "check.html?mock=1", null, "acc"));
    body.append(group(null, top));
    var loading = mk("p", "awx-tp-note", "Loading scenarios…");
    body.append(loading);
    document.body.append(wrap);
    if (window.AWXSheet && window.AWXSheet.makeSheet) {
      ctl = window.AWXSheet.makeSheet(sh, { onClose: function () { close(); }, header: ".awx-tp-grab, .awx-tp-hd", backdrop: bd });
      ctl.opened();
    }
    x.focus({ preventScroll: true });
    fetch("./data/scenarios/index.json", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (idx) {
      loading.remove();
      var groups = idx.groups || {};
      var keys = Object.keys(groups);
      var list = idx.scenarios || [];
      list.forEach(function (s) { if (!s.group || keys.indexOf(s.group) < 0) { if (keys.indexOf("other") < 0) { keys.push("other"); groups.other = "Other"; } s.group = "other"; } });
      keys.forEach(function (k) {
        var rows = list.filter(function (s) { return s.group === k; }).map(function (s) {
          var r = row(s.title, s.blurb || s.description, "./?test=" + encodeURIComponent(s.name));
          if (T && T.scenario === s.name) r.setAttribute("aria-current", "true");
          return r;
        });
        if (rows.length) body.append(group(groups[k], rows));
      });
    }).catch(function (e) {
      loading.textContent = "Couldn't load the scenario list (" + (e && e.message ? e.message : e) + ").";
    });
  }
})();
