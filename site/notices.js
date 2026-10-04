// Airport sheet "Flight restrictions" card: nearby FAA TFRs from
// status.json `airports[].notices` as plain sentences, most important first, at most 5 and then "+N more" as
// plain text (no expanders). Aviation mode adds each item's raw TFR text and the source line. A hidden
// Settings category (site/cats.js keys on each item: runways, vip, space, atc) drops its items; full airport
// closures ("always") can't be hidden. Classic script, loaded before app.js; window.AWXNotices.
(function (root) {
  "use strict";
  var MAX = 5;
  function agoMin(iso, now) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var m = Math.max(0, Math.round((now - t) / 60000));
    return m < 60 ? m + " MIN AGO" : Math.round(m / 60) + " H AGO";
  }

  /** Items shown under the settings: not hidden, not ended, and in Traveler mode not already shown elsewhere (dup). */
  function visible(n, ctx) {
    return ((n && n.items) || []).filter(function (x) {
      if (!x || x.src !== "tfr" || !x.text) return false;
      if (x.cat && x.cat !== "always" && ctx.hidden && ctx.hidden(x.cat)) return false;
      if (x.to && Date.parse(x.to) <= ctx.now) return false;
      if (x.dup && !ctx.aviation && !(x.peak > 1)) return false;
      return true;
    });
  }

  /**
   * The "Flight restrictions" section for the airport sheet, or null when there is nothing to show.
   * ctx: {h, section (app.js section()), aviation: bool, retime(text), hidden(cat), now (ms), sources: status.noticeSources}
   */
  function section(v, a, ctx) {
    var n = v && v.notices;
    var list = visible(n, ctx);
    if (!list.length) return null;
    var h = ctx.h;
    var shown = list.slice(0, MAX);
    var more = list.length - shown.length + Math.max(0, ((n.count || 0) - (n.items || []).length));
    var kids = shown.map(function (x) {
      var lvl = x.peak || 0;
      var text = ctx.retime(x.text) + (x.dup && ctx.aviation ? " Also reported by the FAA above." : "");
      return h("div", { class: "item" + (lvl ? "" : " info"), "data-kind": x.kind },
        h("div", { class: lvl ? "" : "muted", style: lvl >= 2 ? "font-weight:600" : "" }, text),
        ctx.aviation && x.raw ? h("pre", { class: "raw rawt" }, x.raw + (x.src === "tfr" && x.nm != null ? "\n(" + (x.nm ? x.nm + " NM from the airport" : "over the airport") + ")" : "")) : null);
    });
    if (more > 0) kids.push(h("div", { class: "muted small", style: "padding:8px 0 2px" }, "+" + more + " more"));
    if (ctx.aviation) {
      var s = ctx.sources || {};
      var parts = [];
      if (s.tfr && s.tfr.ok) parts.push("FAA TFR LIST · UPDATED " + agoMin(s.tfr.at, ctx.now));
      if (parts.length) kids.push(h("div", { class: "srcl" }, "SOURCE: " + parts.join("; ")));
    }
    return ctx.section("Flight restrictions", "ops", kids, null, { meta: "FAA", id: "notices" });
  }

  var api = { section: section, visible: visible, MAX: MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AWXNotices = api;
})(typeof window !== "undefined" ? window : this);
