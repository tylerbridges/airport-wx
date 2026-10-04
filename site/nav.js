// Navigation shell: floating glass tab bar (Airports / Trips / Map) with a round search button,
// large per-tab header with round glass buttons (refresh, menu), the glass menu popover, the
// full-screen search sheet and the theme (prefs.theme -> data-theme on <html>).
//
// Loaded as a module after app.js and searched.js. It only rearranges existing nodes (ids kept,
// so app.js and searched.js keep working) and talks to them through window.AWXApp / AWXExtra.
// Tab state lives in the URL hash (#airports, #trips, #map), so Back works.
import { mountSearch } from "./search.js";
import { h, icon, prefs, reducedMotion, trapFocus, app } from "./navui.js";
import { initSettings, openSettings, settingsOpen } from "./settings.js";

const TABS = [
  { id: "airports", label: "Airports", title: "Airports", icon: "terminal" },
  { id: "trips", label: "Trips", title: "Trips", icon: "ticket" },
  { id: "map", label: "Map", title: "Map", icon: "foldmap" },
];
const $ = (id) => document.getElementById(id);
export const tabFromHash = (hash) => { const k = String(hash || "").replace(/^#/, ""); return TABS.some((t) => t.id === k) ? k : "airports"; };

let cur = null;
const scrollBy = {}; // tab -> scrollY, restored when coming back
let bar, nav, menuBtn;

// ---------- theme ----------

const META = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({ m, content: m.content }));
function applyTheme(p) {
  const t = ["light", "dark"].includes(p && p.theme) ? p.theme : "auto";
  document.documentElement.setAttribute("data-theme", t);
  for (const { m, content } of META) m.content = t === "dark" ? "#000000" : t === "light" ? "#f2f2f7" : content;
}

// ---------- layout ----------

function buildPanels() {
  const wrap = document.querySelector(".wrap");
  const header = wrap.querySelector("header");
  const pa = h("div", { id: "navAirports", class: "awx-panel", role: "tabpanel", "aria-labelledby": "tab-airports" });
  for (const el of [...wrap.children]) if (el !== header && el.tagName !== "NOSCRIPT") pa.append(el);
  const pt = h("div", { id: "navTrips", class: "awx-panel", role: "tabpanel", "aria-labelledby": "tab-trips", hidden: true });
  const pm = h("div", { id: "navMap", class: "awx-panel", role: "tabpanel", "aria-labelledby": "tab-map", hidden: true });
  header.after(pa, pt, pm);

  // header: big title per tab + round glass buttons (refresh from app.js, and the menu)
  header.classList.add("awx-head");
  const refresh = $("refresh");
  refresh.classList.add("glass", "awx-round");
  menuBtn = h("button", { type: "button", class: "glass awx-round", id: "navMenuBtn", "aria-label": "Menu", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => (menuOpen ? closeMenu() : openMenu()) }, icon("person"));
  header.append(h("div", { class: "awx-hbtns" }, refresh, menuBtn));
}

function buildBar() {
  bar = h("div", { class: "awx-tabbar glass", role: "tablist", "aria-label": "Sections" },
    TABS.map((t) => h("button", {
      type: "button", role: "tab", id: "tab-" + t.id, "data-tab": t.id, "aria-controls": "nav" + t.id[0].toUpperCase() + t.id.slice(1),
      "aria-selected": "false", tabindex: "-1",
      onclick: () => go(t.id),
    }, icon(t.icon), h("span", {}, t.label))));
  bar.addEventListener("keydown", (e) => {
    const i = TABS.findIndex((t) => t.id === cur);
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") j = (i + TABS.length - 1) % TABS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = TABS.length - 1;
    if (j == null) return;
    e.preventDefault();
    go(TABS[j].id);
    $("tab-" + TABS[j].id).focus();
  });
  const sb = h("button", { type: "button", class: "awx-searchbtn glass", id: "navSearchBtn", "aria-label": "Search airports", onclick: () => openSearch() }, icon("wlens"));
  nav = h("nav", { class: "awx-nav", "aria-label": "Main" }, h("div", { class: "awx-navin" }, bar, sb));
  document.body.append(nav);
}

/** Switch tab through the hash (adds a history entry, so Back returns to the previous tab). */
function go(id) {
  if (id === cur) { window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }); return; }
  if (tabFromHash(location.hash) === id && location.hash) { show(id); return; }
  location.hash = id;
}

function show(id) {
  if (cur) scrollBy[cur] = window.scrollY;
  const prev = cur;
  cur = id;
  document.body.setAttribute("data-tab", id);
  for (const t of TABS) {
    const sel = t.id === id;
    const b = $("tab-" + t.id);
    b.setAttribute("aria-selected", String(sel));
    b.tabIndex = sel ? 0 : -1;
    $("nav" + t.id[0].toUpperCase() + t.id.slice(1)).hidden = !sel;
  }
  const h1 = document.querySelector(".wrap header h1");
  if (h1) h1.textContent = TABS.find((t) => t.id === id).title;
  if (id === "trips") renderTrips();
  if (id === "map") renderMap();
  if (prev) window.scrollTo(0, scrollBy[id] || 0);
}

// ---------- Trips / Map ----------

function renderTrips() {
  const box = $("navTrips");
  if (window.AWXTrips && typeof window.AWXTrips.render === "function") { window.AWXTrips.render(box); return; }
  if (box.querySelector(".awx-empty")) return;
  const add = () => (window.AWXTrips && typeof window.AWXTrips.openAdd === "function" ? window.AWXTrips.openAdd() : openSettings("trips", { focus: "add" }));
  box.replaceChildren(h("div", { class: "awx-empty" },
    h("div", { class: "awx-empty-ico" }, icon("case")),
    h("h2", {}, "No trips yet"),
    h("p", {}, "Add a flight to watch for disruptions at both ends, or connect your flight calendar to bring trips in automatically."),
    h("button", { type: "button", class: "awx-btn primary", onclick: add }, "Add a trip"),
    h("button", { type: "button", class: "awx-btn", onclick: () => openSettings("trips", { focus: "connect" }) }, "Connect your flight calendar")));
}

function renderMap() {
  const box = $("navMap");
  if (box.firstChild) return;
  box.append(h("div", { class: "awx-empty" },
    h("div", { class: "awx-empty-ico" }, icon("map")),
    h("h2", {}, "Coming soon"),
    h("p", {}, "A map of disruption risk across your airports is on the roadmap.")));
}

// ---------- menu popover ----------

let menuOpen = false;
let menu, catcher, untrapMenu = null, accP = null;
/** "How accurate is this?" shows only when accuracy.html exists (one HEAD request, made the first time the menu opens). */
function accuracyExists() {
  if (!accP) accP = fetch("./accuracy.html", { method: "HEAD", cache: "no-store" }).then((r) => r.ok).catch(() => false);
  return accP;
}
function menuItems() {
  const favs = (app() && app().state.favs) || [];
  const row = (ico, label, act, extra) => h(act.href ? "a" : "button", Object.assign({ role: "menuitem", class: "awx-mi", tabindex: "-1" },
    act.href ? { href: act.href } : { type: "button", onclick: () => { closeMenu(); act.fn(); } }, extra || {}),
  h("span", { class: "awx-mi-ico" }, icon(ico)), h("span", { class: "awx-mi-t" }, label), act.count != null ? h("span", { class: "awx-mi-n" }, act.count) : null);
  const acc = row("target", "How accurate is this?", { href: "accuracy.html" }, { hidden: true, id: "navMenuAcc" });
  accuracyExists().then((ok) => { if (ok) acc.hidden = false; });
  return [
    row("star", "Your airports", { fn: () => openSettings("airports"), count: favs.length }),
    row("calendar", "Trips & flight calendar", { fn: () => openSettings("trips") }),
    row("gear", "Settings", { fn: () => openSettings() }),
    h("div", { class: "awx-msep", role: "separator" }),
    acc,
    row("pulse", "Data & checks", { fn: () => openSettings("data") }),
    window.AWXTest && window.AWXTest.openPicker ? row("check", "Test scenarios", { fn: () => window.AWXTest.openPicker() }) : null, // scenarios hook: the scenario list in site/testmode.js
  ].filter(Boolean);
}
function buildMenu() {
  // full-screen catcher: an outside tap closes the menu without also tapping the card under it
  catcher = h("div", { class: "awx-catch", hidden: true, onclick: () => closeMenu() });
  menu = h("div", { class: "awx-pop glass", id: "navMenu", role: "menu", "aria-label": "Menu", hidden: true });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".awx-mi")].filter((x) => !x.hidden);
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
  });
  document.body.append(catcher, menu);
}
function placeMenu() {
  const r = menuBtn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = Math.min(290, vw - 24);
  const right = Math.min(Math.max(12, vw - r.right), vw - 12 - w);
  const top = Math.max(8, r.bottom + 8);
  Object.assign(menu.style, { width: w + "px", right: right + "px", top: top + "px", maxHeight: `calc(100dvh - ${top + 12}px)` });
}
function openMenu() {
  if (menuOpen) return;
  menuOpen = true;
  menu.replaceChildren(...menuItems());
  placeMenu();
  catcher.hidden = false;
  menu.hidden = false;
  void menu.offsetWidth;
  menu.classList.add("open");
  menuBtn.setAttribute("aria-expanded", "true");
  untrapMenu = trapFocus(menu);
  menu.querySelector(".awx-mi").focus({ preventScroll: true });
}
function closeMenu(returnFocus = true) {
  if (!menuOpen) return;
  menuOpen = false;
  menu.classList.remove("open");
  catcher.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  if (untrapMenu) untrapMenu();
  const done = () => { if (!menuOpen) menu.hidden = true; };
  if (reducedMotion()) done(); else setTimeout(done, 180);
  if (returnFocus) menuBtn.focus({ preventScroll: true });
}

// ---------- search sheet ----------

let srch = null, srchApi = null, srchOpts = {}, untrapSrch = null, srchReturn = null;
function buildSearch() {
  const mount = h("div", { class: "awx-srch-mount" });
  srch = h("div", { class: "awx-srch", id: "navSearch", role: "dialog", "aria-modal": "true", "aria-labelledby": "navSearchT", hidden: true },
    h("div", { class: "awx-srch-in" },
      h("div", { class: "awx-srch-head" },
        h("h2", { id: "navSearchT" }, "Search"),
        h("button", { type: "button", class: "awx-txtbtn", onclick: () => closeSearch() }, "Cancel")),
      mount,
      h("p", { class: "awx-srch-hint" }, "Any airport by code, city or name. Major U.S. airports include FAA delays and weather warnings.")));
  document.body.append(srch);
  srchApi = mountSearch(mount, {
    onPick: (a) => {
      const o = srchOpts;
      closeSearch(false);
      if (o.onPick) { o.onPick(a); return; }
      if (cur !== "airports") go("airports");
      if (window.AWXExtra && window.AWXExtra.pick) window.AWXExtra.pick(a);
      else if (app()) app().openSheet(a.code);
    },
    getFavs: () => (app() && app().state.favs) || [],
    onToggleFav: (code) => { if (app()) app().toggleFav(code); if (srchOpts.onFavs) srchOpts.onFavs(); },
  });
  srch.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); closeSearch(); } });
  // build2b hook: drag the header or pull at the top to close; back gesture; page scroll lock (site/sheet.js)
  srchCtl = window.AWXSheet ? window.AWXSheet.makeSheet(srch, { onClose: () => closeSearch(), header: ".awx-srch-head" }) : null;
}
let srchCtl = null;
export function openSearch(opts = {}) {
  if (!srch) buildSearch();
  srchOpts = opts;
  srchReturn = document.activeElement;
  srch.querySelector("#navSearchT").textContent = opts.title || "Search";
  srch.hidden = false;
  if (srchCtl) srchCtl.opened(); // build2b hook
  void srch.offsetWidth;
  srch.classList.add("open");
  untrapSrch = trapFocus(srch);
  srchApi.input.value = "";
  srchApi.input.focus({ preventScroll: true });
  syncBar();
}
function closeSearch(returnFocus = true) {
  if (!srch || srch.hidden) return;
  srch.classList.remove("open");
  if (srchCtl) srchCtl.closed(); // build2b hook
  srchApi.close();
  srchApi.input.blur();
  if (untrapSrch) untrapSrch();
  const done = () => { if (!srch.classList.contains("open")) { srch.hidden = true; syncBar(); } };
  if (reducedMotion()) done(); else setTimeout(done, 260);
  if (returnFocus && srchReturn && srchReturn.focus) srchReturn.focus({ preventScroll: true });
}
const searchOpen = () => !!srch && !srch.hidden;

// ---------- bar visibility ----------

/** The bar hides while the airport sheet, the national list, Settings or search is open. */
function syncBar() {
  const sw = $("sheetWrap");
  const pw = $("panelWrap"); // build2b hook: the national list sheet (app.js)
  const hide = (sw && !sw.hidden) || (pw && !pw.hidden) || settingsOpen() || searchOpen();
  nav.classList.toggle("hide", !!hide);
  if (hide) nav.setAttribute("inert", ""); else nav.removeAttribute("inert");
}

// ---------- init ----------

function init() {
  const P = prefs();
  applyTheme(P.getPrefs());
  P.onPrefs((p) => applyTheme(p));
  document.body.classList.add("awx-nav-on");
  buildPanels();
  buildBar();
  buildMenu();
  initSettings({ openSearch, onToggle: () => syncBar() });
  const sw = $("sheetWrap");
  if (sw) new MutationObserver(syncBar).observe(sw, { attributes: true, attributeFilter: ["hidden"] });
  if ($("panelWrap")) new MutationObserver(syncBar).observe($("panelWrap"), { attributes: true, attributeFilter: ["hidden"] }); // build2b hook
  window.addEventListener("hashchange", () => { closeMenu(false); show(tabFromHash(location.hash)); });
  window.addEventListener("resize", () => { if (menuOpen) placeMenu(); });
  show(tabFromHash(location.hash));
  syncBar();
  window.AWXNav = { go, show, tab: () => cur, openMenu, closeMenu, menuOpen: () => menuOpen, openSearch, closeSearch, openSettings, prefs };
}

init();
