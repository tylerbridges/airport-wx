// Shared bits for the nav shell (site/nav.js) and Settings (site/settings.js): element builder,
// inline icons (drawn for this app), the prefs API, focus trapping. No dependencies.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// 24×24 stroke icons. Each entry: list of path data (or ["c", cx, cy, r] circles, ["r", x, y, w, h, rx] rects).
const ICONS = {
  // build2b: our own tab glyphs, wide 28×18 (rounded 2 px strokes); "f" paths fill amber when the tab is selected,
  // "k" paths are knock-out details drawn over the fill
  terminal: { vb: "0 0 28 18", p: [["f", "M4.5 8h13.5a2.5 2.5 0 0 1 2.5 2.5v5H2v-5A2.5 2.5 0 0 1 4.5 8z"], ["f", "M21 15.5v-9h3v9z"], ["f", "M19.8 6.5V4.2a1.7 1.7 0 0 1 1.7-1.7h2a1.7 1.7 0 0 1 1.7 1.7v2.3z"], ["k", "M6 11.8h10"], ["", "M1 15.5h26"]] },
  ticket: { vb: "0 0 28 18", p: [["f", "M5 2.5h12a2 2 0 0 0 4 0h2a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-2a2 2 0 0 0-4 0H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"], ["k", "M19 6.6v.9M19 10.5v.9"], ["k", "M6 7.2h7M6 10.8h4.5"]] },
  foldmap: { vb: "0 0 28 18", p: [["f", "M2 4.6 9.5 2.5l9 2.1 7.5-2.1v11l-7.5 2.1-9-2.1L2 15.6z"], ["k", "M9.5 2.5v11M18.5 4.6v11"]] },
  wlens: { vb: "0 0 28 18", p: [["", ["c", 11, 8.2, 5.6]], ["", "M15.6 11.6l7.2 3.9"]] },
  tower: ["M6.5 6.5h11l-2 4.5h-7z", "M10 11v9.5M14 11v9.5", "M7 20.5h10", "M12 6.5V3.5", "M9.5 3.5h5"],
  case: [["r", 3.5, 7.5, 17, 12, 2.5], "M9 7.5V5.6c0-.6.5-1.1 1.1-1.1h3.8c.6 0 1.1.5 1.1 1.1v1.9", "M8 7.5v12M16 7.5v12"],
  map: ["M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2z", "M9 4.5v13M15 6.5v13"],
  lens: [["c", 10.5, 10.5, 6], "M15 15l5 5"],
  person: [["c", 12, 12, 9], ["c", 12, 10, 3.2], "M6.2 18.4c1.3-2 3.4-3.1 5.8-3.1s4.5 1.1 5.8 3.1"],
  star: ["M12 3.8l2.4 5 5.5.7-4 3.9 1 5.4-4.9-2.7-4.9 2.7 1-5.4-4-3.9 5.5-.7z"],
  plane: ["M4 13.5l6.2-1.6L13.4 4.6c.3-.6 1.5-.6 1.6.2l-.7 6.3 4.9-1.2c1-.2 1.8.9 1 1.6l-4.4 2.1-1.9 6.1c-.2.6-1.1.7-1.4.1l-1-4.4-4.3 1.1-1.2 1.5H4.6l.9-2.8-1.7-.9z"],
  gear: [["c", 12, 12, 3], "M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7", ["c", 12, 12, 6.6]],
  target: [["c", 12, 12, 8.5], ["c", 12, 12, 4.5], ["c", 12, 12, 1]],
  pulse: ["M3 12h4l2.5-6 4 12 2.5-6H21"],
  calendar: [["r", 3.5, 5, 17, 15, 2.5], "M3.5 9.5h17", "M8 3v4M16 3v4"],
  chevR: ["M9.5 5.5 16 12l-6.5 6.5"],
  chevL: ["M14.5 5.5 8 12l6.5 6.5"],
  grip: ["M5 9h14M5 15h14"],
  minus: ["M7 12h10"],
  plus: ["M12 6v12M6 12h12"],
  close: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
  ext: ["M14 4.5h5.5V10", "M19.5 4.5 11 13", "M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
};

export function icon(name, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  const def = ICONS[name];
  if (def && def.vb) { // wide glyph with fill / knock-out layers (build2b)
    svg.setAttribute("viewBox", def.vb);
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("class", ((cls || "") + " wide").trim());
    for (const [layer, d] of def.p) {
      let e;
      if (Array.isArray(d)) { e = document.createElementNS(ns, "circle"); e.setAttribute("cx", d[1]); e.setAttribute("cy", d[2]); e.setAttribute("r", d[3]); }
      else { e = document.createElementNS(ns, "path"); e.setAttribute("d", d); }
      if (layer) e.setAttribute("class", layer);
      svg.append(e);
    }
    return svg;
  }
  for (const p of def || []) {
    let e;
    if (typeof p === "string") { e = document.createElementNS(ns, "path"); e.setAttribute("d", p); }
    else if (p[0] === "c") { e = document.createElementNS(ns, "circle"); e.setAttribute("cx", p[1]); e.setAttribute("cy", p[2]); e.setAttribute("r", p[3]); }
    else { e = document.createElementNS(ns, "rect"); ["x", "y", "width", "height", "rx"].forEach((k, i) => e.setAttribute(k, p[i + 1])); }
    svg.append(e);
  }
  return svg;
}

/** The settings API from site/prefs.js (window.AWXPrefs, or global functions if prefs.js defines those). */
export function prefs() {
  const w = window;
  if (w.AWXPrefs && typeof w.AWXPrefs.getPrefs === "function") return w.AWXPrefs;
  if (typeof w.getPrefs === "function" && typeof w.setPref === "function") {
    return { getPrefs: w.getPrefs, setPref: w.setPref, onPrefs: w.onPrefs || (() => () => {}), DEFAULTS: w.DEFAULTS || w.getPrefs() };
  }
  // prefs.js missing: in-memory so the UI still works (nothing is saved)
  if (!prefs._mem) {
    const DEF = { mode: "traveler", show: {}, theme: "auto", clock: "12", codes: "iata", timeRef: "airport" };
    let cur = JSON.parse(JSON.stringify(DEF));
    const fns = [];
    prefs._mem = {
      DEFAULTS: DEF, getPrefs: () => JSON.parse(JSON.stringify(cur)),
      setPref: (k, v) => { if (k === "show") cur.show = Object.assign({}, cur.show, v); else cur[k] = v; fns.forEach((f) => f(cur, k)); return cur; },
      onPrefs: (f) => { fns.push(f); return () => fns.splice(fns.indexOf(f), 1); },
    };
  }
  return prefs._mem;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
/** Keeps Tab / Shift+Tab inside root. Returns a function that removes the trap. */
export function trapFocus(root) {
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length && !x.closest("[inert]"));
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}

export const app = () => window.AWXApp || null;

/** app.js?v= of the running page (the app version shown in Settings → About). */
export function appVersion() {
  const s = document.querySelector('script[src*="app.js"]');
  const m = s && /[?&]v=(\d+)/.exec(s.getAttribute("src"));
  return m ? m[1] : "?";
}
