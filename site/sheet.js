// Shared bottom-sheet behaviour (build2b): every sheet (airport detail, national list, Settings and its pages,
// search, and the trip sheet later) is dismissed the same way. Classic script loaded before app.js;
// window.AWXSheet.makeSheet (also module.exports for Node).
//
//   const ctl = AWXSheet.makeSheet(el, {
//     onClose(reason),         // the owner's close function; reason: "drag" | "back"
//     header: ".grab, .sh-head", // drag handle at any scroll position (gets touch-action: none)
//     backdrop: element,       // optional: fades with the drag
//     scroller: (target) => el,// optional: the element that scrolls under target (default: el)
//     noPull: ".tl.big",       // optional: content where a pull never starts a drag (scrub surfaces, reorder grips)
//     move: element,           // optional: the element that follows the finger (default: el)
//   });
//   ctl.opened()  // call when the sheet opens: pushes a history entry, locks the page scroll
//   ctl.closed()  // call when it closes (any way): pops that entry, unlocks and restores the page scroll
//
// Dragging: the header drags the whole sheet at any scroll position (pointer events); the content drags it only
// while its scroller is at the top (touch events; when scrolled, a drag scrolls). Released past 25% of the
// sheet's height or flicked faster than 0.5 px/ms it closes, else it springs back. The browser / iOS back
// gesture closes the top sheet (history state {awxSheets: depth}); inside a frame (the check page) history is
// left alone.
(function (root) {
  "use strict";
  var stack = []; // open controllers, bottom to top
  var lock = { n: 0, y: 0 };
  var useHistory = typeof window !== "undefined" && window === window.top && !!(window.history && history.pushState);
  var popping = false;
  var reduced = function () { return root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches; };

  function lockScroll() {
    if (lock.n++) return;
    var b = document.body;
    lock.y = root.scrollY || 0;
    lock.style = b.getAttribute("style");
    b.style.position = "fixed";
    b.style.top = -lock.y + "px";
    b.style.left = "0";
    b.style.right = "0";
    b.style.width = "100%";
  }
  function unlockScroll() {
    if (!lock.n || --lock.n) return;
    var b = document.body;
    if (lock.style == null) b.removeAttribute("style"); else b.setAttribute("style", lock.style);
    root.scrollTo(0, lock.y);
  }
  function depth() {
    var s = history.state;
    return s && typeof s.awxSheets === "number" ? s.awxSheets : 0;
  }
  if (useHistory) {
    root.addEventListener("popstate", function () {
      var d = depth();
      popping = true;
      try {
        while (stack.length > d) {
          var top = stack[stack.length - 1];
          top.opts.onClose && top.opts.onClose("back");
          if (stack[stack.length - 1] === top) top.ctl.closed(); // the owner didn't report it
        }
      } finally { popping = false; }
    });
  }

  function makeSheet(el, opts) {
    opts = opts || {};
    var entry = { el: el, opts: opts, open: false };
    var moveEl = function () { return opts.move || el; };
    var bd = function () { return typeof opts.backdrop === "function" ? opts.backdrop() : opts.backdrop; };
    var drag = null;
    var swallow = 0;

    function setY(y) {
      var m = moveEl();
      m.style.transition = "none";
      m.style.transform = "translateY(" + y + "px)";
      var b = bd();
      if (b) { b.style.transition = "none"; b.style.opacity = String(Math.max(0, 1 - y / Math.max(1, m.offsetHeight))); }
    }
    function clearInline() {
      var m = moveEl();
      m.style.transition = "";
      m.style.transform = "";
      var b = bd();
      if (b) { b.style.transition = ""; b.style.opacity = ""; }
    }
    function sample(y) {
      var t = Date.now();
      drag.samples.push([t, y]);
      while (drag.samples.length > 2 && t - drag.samples[0][0] > 100) drag.samples.shift();
    }
    function begin(y) {
      drag = { y0: y, dy: 0, samples: [], on: true };
      sample(y);
    }
    function moveTo(y) {
      drag.dy = Math.max(0, y - drag.y0);
      sample(y);
      setY(drag.dy);
    }
    function release() {
      var d = drag;
      drag = null;
      if (!d) return;
      var s = d.samples, v = 0;
      if (s.length > 1) v = (s[s.length - 1][1] - s[0][1]) / Math.max(1, s[s.length - 1][0] - s[0][0]);
      var hgt = moveEl().offsetHeight || 1;
      if (d.dy > 0.25 * hgt || (v > 0.5 && d.dy > 10)) {
        // inline styles cleared in the same frame as the owner's close: the close transition runs from here
        clearInline();
        opts.onClose && opts.onClose("drag");
        if (entry.open) ctl.closed();
        return;
      }
      // spring back
      var mm = moveEl(), bb = bd();
      if (reduced()) { clearInline(); return; }
      mm.style.transition = "transform .32s cubic-bezier(.34, 1.3, .64, 1)";
      mm.style.transform = "translateY(0)";
      if (bb) { bb.style.transition = "opacity .25s ease"; bb.style.opacity = ""; }
      setTimeout(function () { if (!drag) clearInline(); }, 360);
    }

    // header: pointer drag at any scroll position (the header has touch-action: none)
    var hp = null;
    el.addEventListener("pointerdown", function (e) {
      if (!entry.open || e.button > 0 || !opts.header || !e.target.closest || !e.target.closest(opts.header)) return;
      hp = { id: e.pointerId, y: e.clientY, x: e.clientX, on: false };
    });
    el.addEventListener("pointermove", function (e) {
      if (!hp || e.pointerId !== hp.id) return;
      if (!hp.on) {
        var dy = e.clientY - hp.y;
        if (dy < 6 || Math.abs(e.clientX - hp.x) > dy) { if (Math.abs(dy) > 6 || Math.abs(e.clientX - hp.x) > 6) hp = null; return; }
        hp.on = true;
        try { e.target.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        begin(hp.y);
      }
      moveTo(e.clientY);
    });
    var hpEnd = function (e) {
      if (!hp || e.pointerId !== hp.id) return;
      var was = hp.on;
      hp = null;
      if (was) { swallow = Date.now() + 350; release(); }
    };
    el.addEventListener("pointerup", hpEnd);
    el.addEventListener("pointercancel", hpEnd);
    el.addEventListener("click", function (e) { if (Date.now() < swallow) { e.preventDefault(); e.stopPropagation(); } }, true);

    // content: touch pull while the scroller is at the top
    var tp = null;
    el.addEventListener("touchstart", function (e) {
      tp = null;
      if (!entry.open || e.touches.length !== 1) return;
      var t = e.target;
      if (opts.header && t.closest && t.closest(opts.header)) return; // the pointer handler has it
      if (opts.noPull && t.closest && t.closest(opts.noPull)) return;
      var sc = (opts.scroller && opts.scroller(t)) || el;
      if (sc.scrollTop > 0) return;
      tp = { y: e.touches[0].clientY, x: e.touches[0].clientX, sc: sc, on: false };
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      if (!tp) return;
      var y = e.touches[0].clientY, dy = y - tp.y, dx = e.touches[0].clientX - tp.x;
      if (!tp.on) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        if (dy <= 0 || Math.abs(dx) > dy || tp.sc.scrollTop > 0) { tp = null; return; } // scrolls normally
        tp.on = true;
        begin(tp.y);
      }
      if (e.cancelable) e.preventDefault();
      moveTo(y);
    }, { passive: false });
    var tpEnd = function () {
      var was = tp && tp.on;
      tp = null;
      if (was) release();
    };
    el.addEventListener("touchend", tpEnd);
    el.addEventListener("touchcancel", tpEnd);

    var ctl = {
      opened: function () {
        if (entry.open) return;
        entry.open = true;
        clearInline();
        stack.push(entry);
        lockScroll();
        if (useHistory) history.pushState(Object.assign({}, history.state || {}, { awxSheets: stack.length }), "");
      },
      closed: function () {
        if (!entry.open) return;
        var i = stack.indexOf(entry);
        var before = stack.length;
        entry.open = false;
        if (i >= 0) stack.splice(i, 1);
        unlockScroll();
        drag = null; hp = null; tp = null;
        var b = bd();
        if (b) { b.style.transition = ""; b.style.opacity = ""; }
        if (useHistory && !popping && depth() === before) history.back();
      },
      isOpen: function () { return entry.open; },
      dragging: function () { return !!drag; },
    };
    entry.ctl = ctl;
    return ctl;
  }

  var api = { makeSheet: makeSheet, openCount: function () { return stack.length; } };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWXSheet = api;
})(typeof window !== "undefined" ? window : globalThis);
