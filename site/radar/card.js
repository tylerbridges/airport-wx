// Radar preview in the Weather page and full-screen airport radar (radar hook). Loaded as a module by index.html; app.js calls it through
// window.AWXRadarCard:
//   section(a, section) -> the "Radar" section for the sheet (null for airports outside NOAA's U.S. radar grids)
//   close()             -> the airport sheet closed: stop and tear the radar down
//
// The radar engine (site/radar/wx-radar.js + wx-vmap.js, copied from the weather site) is loaded only when a sheet's
// card scrolls into view (IntersectionObserver), never on the home list. In the card the map is a fixed 16:10 view
// about 66 nm across centred on the airport (runway glyph, range rings at 10 and 30 nm), the loop plays once loaded
// (latest frame + a play button with reduced motion) and pauses when the card leaves the screen; it isn't pannable,
// so the sheet scrolls normally. Tapping it opens a full-screen radar sheet (site/sheet.js makeSheet) with pan, zoom,
// play/pause, the time slider and the scan time. The engine is shared: its map element moves between the card and
// the full-screen sheet. Closing the airport sheet stops the workers and frees everything (downloaded scans stay in
// the Cache API for 2 hours, so reopening only decodes them again).
//
// Wording: Traveler mode's legend is just "Rain · Snow" colour bars and ring labels in miles; Aviation mode adds
// dBZ ticks and labels the rings in nm.
import { covered, zoomFor, ringLabel, RINGS_NM, NM } from "./geo.js";

const ENGINE_V = "3"; // bump with wx-radar.js / wx-vmap.js changes
const BASE = new URL("./", import.meta.url);
const app = () => window.AWXApp;
const aviation = () => !!(window.AWXPrefs && window.AWXPrefs.getPrefs().mode === "aviation");
const reduced = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
const FAIL = "Radar couldn't load right now";

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const NS = "http://www.w3.org/2000/svg";
function svg(paths, cls) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
  return s;
}

// ---------- engine loading ----------
let engineP = null;
function script(src) {
  return new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = src; s.async = false;
    s.onload = ok;
    s.onerror = () => { s.remove(); no(new Error("couldn't load " + src)); };
    document.head.append(s);
  });
}
export function loadEngine() {
  if (window.WXRadar) return Promise.resolve(window.WXRadar);
  if (!engineP) {
    engineP = (window.WXVMap ? Promise.resolve() : script(new URL("wx-vmap.js?v=" + ENGINE_V, BASE).href).catch(() => null)) // no vector map: Esri base tiles
      .then(() => script(new URL("wx-radar.js?v=" + ENGINE_V, BASE).href))
      .then(() => { if (!window.WXRadar) throw new Error("radar engine missing"); return window.WXRadar; });
    engineP.catch(() => { engineP = null; });
  }
  return engineP;
}

// ---------- state ----------
const S = {
  a: null, R: null, mode: "card", shown: false, visible: false, zoom: 8, heading: null,
  box: null, host: null, msg: null, meta: null, io: null, info: null, note: "", snow: true, pal: null,
  legs: [], notes: [], full: null, generation: 0,
};
const loc = (a) => ({ lat: +a.lat, lon: +a.lon });
const FMT = new Map(); // the engine asks for the same few scan times every frame: format each once per airport/zone
function fmtTime(t) {
  const A = app(), a = S.a;
  const key = t + "|" + (a ? a.iata : "") + "|" + (A && A.dispTz && a ? A.dispTz(a) : "");
  if (FMT.has(key)) return FMT.get(key);
  if (FMT.size > 200) FMT.clear();
  const out = fmtRaw(t, A, a);
  FMT.set(key, out);
  return out;
}
function fmtRaw(t, A, a) {
  try { if (A && A.clock && a) return A.clock(t, A.dispTz(a)); } catch (e) { /* fall through */ }
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------- the map overlay: range rings + runway glyph (device pixels) ----------
function drawOverlay(ctx, o) {
  const d = o.d, dark = o.dark, av = aviation();
  ctx.lineWidth = 1.2 * d;
  ctx.setLineDash([5 * d, 4 * d]);
  ctx.strokeStyle = dark ? "rgba(255,255,255,.5)" : "rgba(20,20,24,.42)";
  const rings = RINGS_NM.map((nm) => ({ nm, r: nm * NM * o.pxPerM }));
  for (const g of rings) { ctx.beginPath(); ctx.arc(o.x, o.y, g.r, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.font = `600 ${(10.5 * d).toFixed(1)}px -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif`;
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; // labels just inside each ring
  const ang = (-24 * Math.PI) / 180;
  for (const g of rings) {
    if (g.r < 14 * d) continue;
    const x = o.x + g.r * Math.cos(ang) - 5 * d, y = o.y + g.r * Math.sin(ang), t = ringLabel(g.nm, av);
    ctx.strokeStyle = dark ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.92)"; ctx.lineWidth = 3 * d; ctx.strokeText(t, x, y);
    ctx.fillStyle = dark ? "rgba(255,255,255,.88)" : "rgba(20,20,24,.82)"; ctx.fillText(t, x, y);
  }
  // runway glyph (the app's mark): a short runway along the airport's main runway heading, amber centreline
  ctx.translate(o.x, o.y);
  ctx.rotate((((S.heading == null ? 0 : S.heading) % 180) * Math.PI) / 180);
  const w = 6 * d, L = 20 * d;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-w / 2, -L / 2, w, L, 1.5 * d); else ctx.rect(-w / 2, -L / 2, w, L);
  ctx.lineWidth = 2.5 * d; ctx.strokeStyle = dark ? "rgba(0,0,0,.9)" : "rgba(255,255,255,.95)"; ctx.stroke();
  ctx.fillStyle = dark ? "#F4F4F6" : "#1C1C1E"; ctx.fill();
  ctx.fillStyle = "#FFB020";
  for (let y = -L / 2 + 3 * d; y < L / 2 - 4 * d; y += 4.4 * d) ctx.fillRect(-0.65 * d, y, 1.3 * d, 2.4 * d);
}
// main runway heading from the airport list search already loads: the direction most runways share (parallels), else
//   the first listed; the glyph is north-up until then
function loadHeading(a) {
  S.heading = null;
  const X = window.AWXExtra;
  if (!X || typeof X.runways !== "function") return;
  Promise.resolve(X.runways(a.icao, a.iata)).then((rws) => {
    if (S.a !== a || !rws || !rws.length) return;
    const hds = rws.map((r) => { const n = parseInt(String(r.ids || "").split("/")[0], 10); return r.headingTrue != null ? Number(r.headingTrue) : Number.isFinite(n) ? n * 10 : NaN; }).filter(Number.isFinite);
    if (!hds.length) return;
    const key = (x) => Math.round((((x % 180) + 180) % 180) / 10) % 18, count = {};
    for (const x of hds) count[key(x)] = (count[key(x)] || 0) + 1;
    S.heading = hds.reduce((best, x) => (count[key(x)] > count[key(best)] ? x : best), hds[0]);
    if (S.R && S.shown) S.R.repaint();
  }).catch(() => {});
}

// ---------- legend, header, notes ----------
function grad(P, lo, hi) {
  const stops = P.filter((s) => s[4] == null || s[4] > 0).map((s) => `rgba(${s[1]},${s[2]},${s[3]},${Math.max(0.45, s[4] == null ? 1 : s[4])}) ${(((Math.min(hi, Math.max(lo, s[0])) - lo) / (hi - lo)) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg,${stops.join(",")})`;
}
const RAIN_SPAN = [15, 70], SNOW_SPAN = [5, 42]; // dBZ shown along each bar
const TICKS = { rain: [20, 35, 50, 65], snow: [10, 20, 30, 40] };
function makeLegend() {
  const bar = (kind) => h("span", { class: "awr-li awr-l" + kind[0] }, h("b", {}, kind === "rain" ? "Rain" : "Snow"), h("i", { class: "awr-bar", "data-k": kind }));
  const el = h("div", { class: "awr-leg" }, bar("rain"), h("span", { class: "awr-dot", "aria-hidden": "true" }, "·"), bar("snow"), h("span", { class: "awr-unit" }, "dBZ"), h("span", { class: "awr-cr" }, "© OpenStreetMap"));
  S.legs.push(el);
  updateLegends();
  return el;
}
function updateLegends() {
  const av = aviation();
  for (const el of S.legs) {
    el.classList.toggle("av", av);
    el.querySelector(".awr-ls").hidden = !S.snow;
    el.querySelector(".awr-dot").hidden = !S.snow;
    const u = el.querySelector(".awr-unit"); u.hidden = !av; u.textContent = av ? "dBZ" : ""; // Traveler: no numbers at all
    for (const b of el.querySelectorAll(".awr-bar")) {
      const k = b.dataset.k, span = k === "rain" ? RAIN_SPAN : SNOW_SPAN;
      if (S.pal) b.style.background = grad(k === "rain" ? S.pal.RAIN : S.pal.SNOW, span[0], span[1]);
      b.replaceChildren(...(av ? TICKS[k].map((v) => h("em", { style: `left:${(((v - span[0]) / (span[1] - span[0])) * 100).toFixed(1)}%` }, String(v))) : []));
    }
  }
}
function makeNote() { const el = h("p", { class: "awr-note", hidden: true }); S.notes.push(el); paintNotes(); return el; }
function paintNotes() {
  const test = window.AWXTest && window.AWXTest.name ? "Live radar — not part of this test scenario." : "";
  // a failed radar says only "Radar couldn't load right now": the engine's backup/stale note is left out then
  const t = [S.info && S.info.failed ? "" : S.note, test].filter(Boolean).join(" ");
  for (const el of S.notes) { if (el.textContent !== t) el.textContent = t; el.hidden = !t; }
}
function metaText() {
  const i = S.info;
  if (!i) return S.shown ? "Loading" : "NOAA";
  if (i.failed) return "Unavailable";
  return i.updText || (i.checking ? "Loading" : "NOAA");
}
function paintMeta() {
  const t = metaText(), late = !!(S.info && S.info.late);
  if (S.meta) { if (S.meta.textContent !== t) S.meta.textContent = t; S.meta.classList.toggle("awr-late", late); }
  if (S.full && S.a) {
    const sub = (app() && app().codeOf ? app().codeOf(S.a) : S.a.iata) + " · " + t;
    if (S.full.sub.textContent !== sub) S.full.sub.textContent = sub;
    S.full.sub.classList.toggle("awr-late", late);
  }
}
function showMsg(t) { if (S.msg) { S.msg.textContent = t || ""; S.msg.hidden = !t; } }

// ---------- engine options ----------
function engineOpts(kind) {
  return {
    static: kind === "card", zoom: S.zoom, recenter: kind === "card", fmtTime,
    overlay: drawOverlay,
    onTime: (i) => { const was = !!(S.info && S.info.failed); S.info = i; paintMeta(); if (was !== !!i.failed) paintNotes(); },
    onNote: (t) => { S.note = t || ""; paintNotes(); },
    onLegend: (l) => { S.snow = !!l.snow; updateLegends(); },
  };
}
function setRm() { if (S.host) S.host.classList.toggle("awr-rm", reduced()); }

// ---------- the card ----------
function ensureBox() {
  if (S.box) return;
  S.host = h("div", { class: "awr-map awr-static" });
  S.msg = h("div", { class: "awr-msg", hidden: true });
  S.box = h("div", { class: "awr-box", role: "button", tabindex: "0", "aria-label": "Radar loop around the airport. Opens full-screen radar." }, S.host, S.msg);
  S.box.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".rplay")) return; openFull(); });
  S.box.addEventListener("keydown", (e) => { if (e.target === S.box && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openFull(); } });
  S.cardLeg = makeLegend();
  S.cardNote = makeNote();
}
function observe() {
  if (S.io) return;
  if (typeof IntersectionObserver === "undefined") { S.visible = true; return; }
  S.io = new IntersectionObserver((es) => { for (const e of es) onVis(e.isIntersecting); }, { threshold: 0.15 });
  S.io.observe(S.box);
}
function onVis(v) {
  S.visible = v;
  if (!S.a || S.mode === "full") return;
  if (v) start();
  else if (S.R && S.shown) S.R.hide(); // off screen: pause the loop and the refresh timers
}
function start() {
  const a = S.a, generation = S.generation;
  if (!a) return;
  S.shown = true; paintMeta();
  loadEngine().then((R) => {
    if (S.generation !== generation || !S.a || S.mode === "full" || !S.visible) return;
    S.R = R; S.pal = R.palettes(); updateLegends(); showMsg("");
    S.zoom = zoomFor(S.box.clientWidth, +a.lat);
    setRm();
    R.show(S.host, loc(a), engineOpts("card"));
  }, () => { if (S.generation === generation && S.a) { S.info = { failed: true }; paintMeta(); paintNotes(); showMsg(FAIL); } });
}

/** The "Radar" section for airport a, built with app.js's section() helper (null when a has no U.S. radar). */
export function section(a, sectionFn) {
  if (!a || !covered(a)) { if (S.a) close(); return null; }
  if (S.a && S.a.iata !== a.iata) close();
  const isNew = S.a !== a && (!S.a || S.a.iata !== a.iata);
  S.a = a;
  ensureBox();
  if (isNew) loadHeading(a);
  const kids = [S.box, S.cardLeg, S.cardNote];
  let sec;
  if (typeof sectionFn === "function") sec = sectionFn("Radar", "radar", kids, null, { cls: "awr-card", meta: metaText() });
  else sec = h("section", { class: "sec" }, h("div", { class: "sec-h" }, h("h3", {}, "Radar"), h("span", { class: "rule", "aria-hidden": "true" }), h("span", { class: "meta" }, metaText())), h("div", { class: "scard awr-card" }, ...kids));
  sec.classList.add("awr-sec");
  S.meta = sec.querySelector(".sec-h .meta");
  paintMeta(); paintNotes(); updateLegends();
  if (S.mode !== "full" && S.host.parentNode !== S.box) S.box.prepend(S.host);
  observe();
  if (S.visible && !S.shown && S.mode !== "full") requestAnimationFrame(() => { if (S.visible && !S.shown && S.a === a) start(); });
  else if (S.R && S.shown) S.R.repaint(); // theme / mode / clock may have changed
  return sec;
}

/** The airport sheet closed (or switched airport): stop the loop, cancel downloads, free memory. */
export function close() {
  if (S.full && S.full.open) closeFull(true);
  S.generation++;
  if (S.io) { S.io.disconnect(); S.io = null; }
  S.visible = false; S.mode = "card";
  if (S.R) S.R.destroy();
  S.a = null; S.shown = false; S.info = null; S.note = ""; S.heading = null;
  showMsg(""); paintNotes();
}

// ---------- full-screen radar sheet ----------
function buildFull() {
  const F = {};
  F.leg = makeLegend();
  F.note = makeNote();
  F.sub = h("div", { class: "awr-fsub" });
  F.close = h("button", { type: "button", class: "close", "aria-label": "Close radar", onclick: () => closeFull() }, svg(["M6 6l12 12", "M18 6L6 18"]));
  F.map = h("div", { class: "awr-fmap" },
    h("button", { type: "button", class: "awr-home", "aria-label": "Center on the airport", onclick: () => S.R && S.R.home() }, svg(["M12 3v3", "M12 18v3", "M3 12h3", "M18 12h3", "M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z"])));
  F.sheet = h("div", { class: "sheet awr-fsheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "awrFTitle" },
    h("div", { class: "grab", "aria-hidden": "true" }),
    h("div", { class: "awr-fhead" }, h("div", {}, h("h2", { id: "awrFTitle" }, "Radar"), F.sub), F.close),
    F.map, F.leg, F.note,
    h("p", { class: "awr-credit" }, "Radar: NOAA MRMS (NOAA Open Data on AWS). Map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors (Esri if unavailable)."));
  F.bd = h("div", { class: "backdrop", onclick: () => closeFull() });
  F.wrap = h("div", { class: "sheet-wrap awr-fwrap", hidden: true }, F.bd, F.sheet);
  document.body.append(F.wrap);
  F.sheet.addEventListener("keydown", (ev) => window.AWXApp?.popupFocus(F.sheet, ev));
  F.ctl = window.AWXSheet ? window.AWXSheet.makeSheet(F.sheet, { onClose: () => closeFull(), header: ".grab, .awr-fhead", backdrop: F.bd, noPull: ".awr-fmap" }) : { opened() {}, closed() {} };
  F.esc = (e) => { if (e.key === "Escape" && F.open) { e.preventDefault(); e.stopImmediatePropagation(); closeFull(); } };
  S.full = F;
  return F;
}
/** Open directly from the airport menu without mounting or loading an inline radar card. */
function open(a) {
  if (!a || !covered(a)) return;
  if (S.a && S.a.iata !== a.iata) close();
  S.a = a;
  ensureBox();
  loadHeading(a);
  openFull(true);
}
function openFull(standalone = false) {
  if (!S.a || (S.full && S.full.open)) return;
  const F = S.full || buildFull(), a = S.a, generation = S.generation;
  F.open = true; F.standalone = standalone; F.last = document.activeElement; F.lastDetail = F.last && F.last.dataset.detail; S.mode = "full";
  F.map.prepend(S.host);
  S.host.classList.remove("awr-static");
  F.wrap.hidden = false;
  F.parent = standalone ? document.getElementById("sheet") : S.box.closest('[role="dialog"]');
  if (F.parent) F.parent.inert = true;
  F.ctl.opened();
  void F.wrap.offsetHeight; // reflow so the transition runs
  F.wrap.classList.add("open");
  window.addEventListener("keydown", F.esc, true);
  paintMeta(); paintNotes(); updateLegends();
  F.close.focus({ preventScroll: true });
  S.shown = true;
  loadEngine().then((R) => {
    if (S.generation !== generation || !S.a || !F.open) return;
    S.R = R; S.pal = R.palettes(); updateLegends(); showMsg("");
    setRm();
    R.show(S.host, loc(a), engineOpts("full"));
  }, () => { if (S.generation === generation && F.open) { S.info = { failed: true }; paintMeta(); showMsg(FAIL); } });
}
function closeFull(noRestore) {
  const F = S.full;
  if (!F || !F.open) return;
  F.open = false; S.mode = "card";
  if (F.parent) F.parent.inert = false;
  window.removeEventListener("keydown", F.esc, true);
  F.wrap.classList.remove("open");
  F.sheet.style.transform = ""; F.sheet.style.transition = "";
  F.ctl.closed();
  const done = () => { if (!F.open) F.wrap.hidden = true; };
  if (reduced()) done(); else setTimeout(done, 300);
  if (S.box) {
    S.host.classList.add("awr-static");
    S.box.prepend(S.host);
    const focus = F.last?.isConnected ? F.last : F.lastDetail ? document.querySelector('#sheet [data-detail="' + F.lastDetail + '"]') : null;
    if (!noRestore) (F.standalone ? focus : S.box)?.focus({ preventScroll: true });
  }
  if (F.standalone) {
    if (S.R) S.R.destroy();
    S.shown = false; S.visible = false;
    return;
  }
  if (noRestore || !S.R || !S.a) return;
  if (S.visible) S.R.show(S.host, loc(S.a), engineOpts("card")); // back to the airport-centred card view
  else { S.R.hide(); S.shown = false; }
}

// ---------- styles ----------
const CSS = `
.awr-card.scard{padding:12px 12px 10px}
.awr-box{position:relative;aspect-ratio:16/10;border-radius:14px;overflow:hidden;cursor:pointer;background:#000;border:1px solid var(--line)}
:root[data-theme="light"] .awr-box{background:#f3f3f1}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) .awr-box{background:#f3f3f1}}
.awr-box:focus-visible{outline:2px solid var(--brand,#ffb020);outline-offset:2px}
.awr-map{position:absolute;inset:0;overflow:hidden;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none}
.awr-map .rstage{position:absolute;touch-action:none;cursor:grab}.awr-map .rstage:active{cursor:grabbing}
.awr-map .rl{position:absolute;inset:0;width:100%;height:100%;display:block;transform-origin:50% 50%;will-change:transform}
.awr-map .rbar,.awr-map .rstat,.awr-home,.awr-msg{background:rgba(28,28,30,.86);color:#fff;border:1px solid rgba(255,255,255,.14);box-shadow:0 4px 14px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08)}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.awr-map .rbar,.awr-map .rstat,.awr-home,.awr-msg{background:rgba(28,28,30,.6);-webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%)}}
.awr-map .rbar{position:absolute;left:10px;right:10px;bottom:10px;display:flex;align-items:center;gap:10px;padding:5px 14px 5px 5px;border-radius:999px;z-index:2}
.awr-map .rplay{width:36px;height:36px;border-radius:50%;background:var(--brand-fill,#ffb020);display:grid;place-items:center;flex:none;transition:transform .12s ease}
.awr-map .rplay:active{transform:scale(.94)}
.awr-map .rplay svg{width:16px;height:16px;fill:var(--brand-ink,#1a1200)}
.awr-map .rrange{flex:1;min-width:0;accent-color:var(--brand-fill,#ffb020);margin:0}
.awr-map .rtime{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:78px;color:#fff;white-space:nowrap;text-align:right;line-height:1.15}
.awr-map .rtime b{font-size:13px;font-weight:600}
.awr-map .rtime span{font-size:10.5px;font-weight:500;color:rgba(235,235,245,.72);display:flex;align-items:center;gap:4px}
.awr-map .rtime span:empty{display:none}
.awr-map .rtime.chk span::before{content:"";width:7px;height:7px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:awr-spin .8s linear infinite}
@keyframes awr-spin{to{transform:rotate(360deg)}}
.awr-map .rtime.late b,.awr-map .rtime.late span{color:#ff6961}
.awr-map .rstat,.awr-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:999px;padding:6px 13px;font-size:13px;font-weight:500;white-space:nowrap;pointer-events:none;z-index:2}
.awr-msg[hidden],.awr-map .rstat[hidden]{display:none}
.awr-static{touch-action:auto}
.awr-static .rstage{pointer-events:none;touch-action:auto;cursor:inherit}
.awr-static .rbar{left:auto;right:8px;bottom:8px;padding:3px 9px;gap:6px;pointer-events:none}
.awr-static .rrange,.awr-static .rtime span,.awr-static .rplay{display:none}
.awr-static .rbar:has(.rtime b:empty){display:none}
.awr-static .rtime{min-width:0}.awr-static .rtime b{font-size:12px}
.awr-static.awr-rm .rbar{padding-left:3px}
.awr-static.awr-rm .rplay{display:grid;width:28px;height:28px;pointer-events:auto}
.awr-static.awr-rm .rplay svg{width:13px;height:13px}
@media (prefers-reduced-motion: reduce){.awr-map .rtime.chk span::before{animation:none;opacity:.6}.awr-map .rplay{transition:none}}
.awr-leg{display:flex;align-items:center;gap:8px;margin:9px 2px 0;font-size:12px;color:var(--muted);min-height:16px}
.awr-li{display:flex;align-items:center;gap:6px}.awr-li[hidden],.awr-dot[hidden],.awr-unit[hidden]{display:none}
.awr-li b{font-weight:600;color:var(--text)}
.awr-bar{position:relative;display:block;width:50px;flex:none;height:6px;border-radius:3px;background:var(--line)}
.awr-leg.av{padding-bottom:9px}
.awr-bar em{position:absolute;top:7px;transform:translateX(-50%);font-style:normal;font-size:9px;line-height:1;color:var(--muted)}
.awr-unit{font-size:10.5px}
.awr-cr{margin-left:auto;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.awr-fsheet .awr-cr{display:none}
.awr-note{margin:6px 2px 0;font-size:12.5px;color:var(--muted)}
.awr-late{color:var(--crit)!important}
.awr-fwrap{z-index:12}
.awr-fsheet{height:92vh;height:92dvh;display:flex;flex-direction:column;overflow:hidden;padding-bottom:calc(env(safe-area-inset-bottom) + 12px)}
.awr-fhead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 0 10px;touch-action:none}
.awr-fhead h2{margin:0;font-size:22px;font-weight:800;letter-spacing:-.02em}
.awr-fsub{font-size:13px;color:var(--muted);margin-top:1px}
.awr-fmap{position:relative;flex:1;min-height:220px;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:#000}
:root[data-theme="light"] .awr-fmap{background:#f3f3f1}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) .awr-fmap{background:#f3f3f1}}
.awr-home{position:absolute;top:10px;right:10px;z-index:3;width:40px;height:40px;border-radius:50%;display:grid;place-items:center}
.awr-home svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round}
.awr-credit{margin:6px 2px 0;font-size:10.5px;line-height:1.3;color:var(--muted)}
`;

let inited = false;
function init() {
  if (inited || typeof document === "undefined" || !document.getElementById("sheet")) return;
  inited = true;
  document.head.append(h("style", { id: "awr-css" }, CSS));
  if (window.AWXPrefs) window.AWXPrefs.onPrefs(() => requestAnimationFrame(() => { FMT.clear(); updateLegends(); if (S.R && S.shown) S.R.repaint(); }));
  if (window.matchMedia) matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", setRm);
  window.AWXRadarCard = { section, close, open, covered, _state: () => ({ a: S.a && S.a.iata, mode: S.mode, shown: S.shown, visible: S.visible, zoom: S.zoom, info: S.info, engine: !!window.WXRadar }) };
}
init();

// ---------- check page (radar hook in check.js) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frame(url, w = 390, hgt = 844) {
  const holder = document.getElementById("frames") || document.body;
  const f = document.createElement("iframe");
  f.style.cssText = `width:${w}px;height:${hgt}px;border:0`;
  f.src = url;
  holder.append(f);
  return f;
}
/** Live: one MRMS frame for MSP decoded in a hidden frame (radar/probe.html); a blocked network is a warning. */
async function probeCheck(add) {
  const f = frame(new URL("probe.html?lat=44.8848&lon=-93.2223", BASE).href, 390, 244);
  const t0 = Date.now();
  try {
    let R = null, st = null;
    while (Date.now() - t0 < 20000) {
      await sleep(250);
      R = f.contentWindow && f.contentWindow.WXRadar;
      if (!R) continue;
      st = R._state();
      if (st.src || st.msg) break;
    }
    if (!R) { add("fail", "Radar engine loads", "radar/wx-radar.js didn't start in the hidden frame"); return; }
    if (!st || (!st.src && !st.msg)) { add("warn", "Radar: MSP frame", "skipped: no answer from NOAA within 20 s (network blocked or slow?)"); return; }
    if (st.msg && !st.src) { add("warn", "Radar: MSP frame", `skipped: ${st.msg}${st.why ? " (" + st.why + ")" : ""} — NOAA's radar files couldn't be reached from here`); return; }
    if (st.src !== "s3") { add("warn", "Radar: MSP frame", `NOAA's MRMS files on AWS unavailable (${st.why || "unknown"}); backup source "${st.src}" in use`); return; }
    const newest = st.times[st.times.length - 1];
    const left = Math.max(1000, 25000 - (Date.now() - t0));
    const vals = await Promise.race([R._probe([[44.8848, -93.2223]]), sleep(left).then(() => { throw new Error("timeout"); })]);
    const v = vals && vals[0];
    const at = v && v.v != null ? `${v.v.toFixed(1)} dBZ ${v.t}` : "no echo";
    const age = Math.round((Date.now() - newest) / 60000);
    add(age > 15 ? "warn" : "pass", "Radar: MSP frame decoded", `MRMS ${st.dom} scan ${new Date(newest).toISOString().slice(11, 16)}Z (${age} min old) · at MSP: ${at}`);
  } catch (e) {
    const m = String((e && e.message) || e);
    add(m === "timeout" ? "warn" : "fail", "Radar: MSP frame decoded", m === "timeout" ? "listed NOAA's scans but the download/decode didn't finish within 25 s" : "decode failed: " + m);
  } finally {
    f.remove();
  }
}
/** Scenarios: lazy Weather preview and full-screen lifecycle with a network-free engine stub. */
async function cardCheck(add) {
  // IntersectionObserver correctly ignores the suite's off-screen iframe. Give this
  // visibility test an on-screen footprint without showing or intercepting its UI.
  const holder = document.getElementById("frames") || document.body;
  const holderStyle = holder.getAttribute("style");
  if (holder !== document.body) holder.style.cssText += ";position:fixed;left:0;top:0;opacity:0;pointer-events:none";
  const f = frame("./index.html?test=all-clear");
  try {
    const t0 = Date.now();
    let w = null;
    while (Date.now() - t0 < 15000) {
      await sleep(100);
      w = f.contentWindow;
      if (w && w.AWXApp && w.AWXApp.state.loaded && w.AWXRadarCard && w.document.querySelector("#list .card")) break;
    }
    if (!w || !w.AWXApp || !w.AWXRadarCard) { add("fail", "Radar card", "app or radar/card.js didn't load"); return; }
    add(w.WXRadar ? "fail" : "pass", "Radar engine not loaded on the home list", w.WXRadar ? "wx-radar.js loaded before any sheet opened" : "");
    w.AWXApp.openSheet("MSP");
    await sleep(300);
    const row = w.document.querySelector('#sheet [data-detail="radar"]');
    const inline = w.document.querySelector("#sheet .awr-sec");
    const ok = row && /Radar/.test(row.textContent) && /Live rain and snow/.test(row.textContent) && !inline && !w.WXRadar;
    add(ok ? "pass" : "fail", "Radar in the airport details menu", ok ? "Opens on demand; no radar engine or inline card in the main sheet" : "Radar menu missing or engine loaded before opening");
    const doc = w.document;
    const rows = [...doc.querySelectorAll("#sheet .ad-row")];
    const compact = rows.length >= 3 && rows.every((x) => x.getBoundingClientRect().height >= 44) && !doc.querySelector("#sheet .ln-sec, #sheet .tm-sec, #sheet .pilot, #sheet .bf-today");
    add(compact ? "pass" : "fail", "Airport details use navigation rows", compact ? "44 px targets; amenities and technical reports open on demand" : "Rows missing, undersized, or secondary cards inline");
    const calls = { show: 0, hide: 0, destroy: 0 };
    w.WXRadar = {
      show: (host) => { calls.show++; if (!host.firstChild) host.append(doc.createElement("canvas")); },
      hide: () => { calls.hide++; }, destroy: () => { calls.destroy++; },
      palettes: () => ({ RAIN: [[15, 0, 180, 0, 1], [70, 255, 0, 0, 1]], SNOW: [[5, 240, 240, 255, 1], [42, 0, 0, 255, 1]] }),
      repaint() {}, home() {},
    };
    const weather = doc.querySelector('#sheet [data-detail="weather"]');
    if (weather) {
      weather.focus(); weather.click(); await sleep(60);
      const preview = doc.querySelector("#mdSheet .awr-box");
      add(preview && doc.querySelector("#mdSheet .awr-sec") ? "pass" : "fail", "Weather page includes airport radar", preview ? "Airport-centered preview with full-screen activation" : "Radar preview missing");
      preview?.scrollIntoView({ block: "center" });
      const visibleStart = Date.now();
      while (!calls.show && Date.now() - visibleStart < 2500) await sleep(100);
      add(calls.show > 0 ? "pass" : "fail", "Weather radar starts only when visible", "Engine show calls: " + calls.show);
      preview?.click(); await sleep(60);
      const full = doc.querySelector(".awr-fwrap"), parent = doc.getElementById("mdSheet");
      add(full && !full.hidden && parent.inert ? "pass" : "fail", "Weather radar expands above its parent page", "Weather page is inert behind full-screen radar");
      full?.querySelector('[aria-label="Close radar"]')?.click(); await sleep(60);
      add(!parent.inert && doc.activeElement === preview && calls.destroy === 0 ? "pass" : "fail", "Radar returns to the Weather preview", "Restores focus and reuses the loaded engine");
      const page = doc.getElementById("mdSheet"), back = page?.querySelector('[aria-label="Back to airport"]');
      if (back) {
        back.focus(); page.scrollTop = 40;
        const top = page.scrollTop;
        w.AWXApp.render();
        const refreshed = /weather/.test(page.getAttribute("aria-label") || "") && page.scrollTop === top && doc.activeElement?.getAttribute("aria-label") === "Back to airport";
        add(refreshed ? "pass" : "fail", "Airport popup keeps page, scroll and focus on refresh", refreshed ? "Weather page stays open at the same position" : "Live refresh reset the popup");
        page.querySelector('[aria-label="Back to airport"]').click();
        add(calls.destroy === 1 && !w.AWXRadarCard._state().shown && !w.AWXRadarCard._state().visible ? "pass" : "fail", "Leaving Weather tears down radar", "Stops workers and disconnects visibility observation");
        const restored = doc.activeElement?.dataset.detail === "weather" && w.AWXApp.state.openIata === "MSP";
        add(restored ? "pass" : "fail", "Airport popup returns to its menu row", restored ? "Back keeps the airport open and restores focus after the row was replaced" : "Back lost airport or menu focus");
      } else add("fail", "Airport popup opens with Back", "Weather page or Back button missing");
    } else add("fail", "Airport details Weather row", "Weather row missing");
    w.AWXApp.closeSheet();
  } finally {
    f.remove();
    if (holderStyle == null) holder.removeAttribute("style"); else holder.setAttribute("style", holderStyle);
  }
}
export async function checkRow(add, { mock = false } = {}) {
  return mock ? cardCheck(add) : probeCheck(add);
}

const api = { section, close, checkRow, loadEngine };
export default api;
