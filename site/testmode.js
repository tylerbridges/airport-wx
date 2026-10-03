// Loaded first (blocking, in <head>) by index.html. Two jobs:
// 1. Error capture for check.html's render test: window.__awxErrors collects uncaught errors,
//    unhandled rejections and console.error calls from this page.
// 2. Test scenarios: ?test=<name> makes app.js read data/scenarios/<name>.json instead of
//    data/status.json (and searched.js read data/scenarios/<name>/wx/). Scenario files are built
//    once by tools/build-scenarios.mjs, so rebase() shifts every ISO time in them by the same
//    amount to make the scenario look current (minus its lagMin, e.g. the stale-data scenario).
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
  var name = m ? m[1] : null;
  var ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/;

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

  window.AWXTest = {
    name: name,
    url: name ? "./data/scenarios/" + name + ".json" : null,
    wxBase: name ? "./data/scenarios/" + name + "/wx/" : "./data/wx/",
    delta: 0,
    /** Shift all times so the scenario's build time lands on now - lagMin. Later calls (shards) reuse the same shift. */
    rebase: function (data, opts) {
      var sc = data && data.scenario;
      var now = (opts && opts.now) || Date.now();
      if (sc && sc.builtAt) this.delta = now - Date.parse(sc.builtAt) - (sc.lagMin || 0) * 60e3;
      return this.delta ? shift(data, this.delta) : data;
    },
    shift: shift,
  };
})();
