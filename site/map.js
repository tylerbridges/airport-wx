// Map tab (site/nav.js mounts it the first time the tab opens): a full-height canvas map of airport risk.
//
//   Base:     OpenFreeMap vector tiles drawn by site/map/vmap.js (a copy of the weather site's wx-vmap.js), loaded
//             only when the tab opens. Until tiles arrive, or if they can't be reached, the base is drawn from
//             bundled public-domain Natural Earth outlines: site/map/us.json (states, PR) over data/map-land.json.
//   Dots:     every airport in status.json (the 32 majors and trip airports), plus starred and trip airports from
//             the global shards (data/wx/, through AWXExtra._shardFor). Colour = the shared airport-hour outlook
//             (site/outlook.js via AWXApp.outlook) at the slider's hour; past hours use the timeline's observed
//             slots (AWXApp.daySlots). Missing or stale coverage is a hollow grey dot, never green.
//   Overlays: a ring around airports with a ground stop, delay program or closure at that hour; thin lines from a hub
//             with a program to the airports its cascade note (status.json airports[].cascade) covers at that hour.
//   Access:   the list under the map mirrors the dots (same filter, same hour); the stage pans with arrow keys.
import { h, app } from "./navui.js";
import { loadAirports } from "./search.js";

const HOUR = 3600e3;
const WORDS = ["Clear", "Minor", "Moderate", "High", "Severe"];
const CONUS = [-123.6, 24.6, -68.4, 49.2];
const RING = new Set(["ground_stop", "ground_delay", "closure"]);
const STORE = "awx-map";
const USER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const safe = (fn, d = null) => { try { return fn(); } catch { return d; } };
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif";

let vmapP = null;
/** site/map/vmap.js as a classic script (its tile worker runs the same file, found through document.currentScript). */
function loadVmap() {
  if (!vmapP) vmapP = new Promise((res) => {
    if (window.AWXMapBase) { res(window.AWXMapBase); return; }
    const s = document.createElement("script");
    s.src = "./map/vmap.js?v=2";
    s.onload = () => res(window.AWXMapBase || null);
    s.onerror = () => res(null);
    document.head.append(s);
  });
  return vmapP;
}
const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw Error(url + " " + r.status); return r.json(); });

export function mountMap(container) {
  const saved = safe(() => JSON.parse(localStorage.getItem(STORE)) || {}, {}) || {};
  let filter = ["all", "mine", "risk"].includes(saved.filter) ? saved.filter : "all";
  let showRings = saved.rings !== false, showCascade = false;
  let offset = 0, minOff = 0, maxOff = 23, at = Date.now();
  let view = null, bv = null, W = 0, H = 0, dpr = 1;
  let all = [], shown = [], byCode = new Map(), dots = [], edges = [], labelBoxes = [];
  let index = [], land = null, us = null, VM = null, vmState = "loading", tileSeen = false, baseKind = "none";
  let baseDirty = true, baseAt = 0, frame = 0, gesturing = false, colors = null, pulsing = false;
  const shardAirports = new Map(); // code -> status-shaped airport built from its shard entry (null: no entry)
  const shardSig = new Map();
  const shardChecks = new Map(); // code -> latest bounded refresh context; requests share searched.js shard TTL
  const shardLoading = new Set();

  // ---------- DOM ----------
  const base = h("canvas", { class: "mapx-base", "aria-hidden": "true" });
  const over = h("canvas", { class: "mapx-over", "aria-hidden": "true" });
  const segBtns = [["all", "All"], ["mine", "My airports"], ["risk", "At risk"]].map(([k, label]) =>
    h("button", { type: "button", "data-filter": k, "aria-pressed": String(k === filter), onclick: () => setFilter(k) }, label));
  const seg = h("div", { class: "mapx-seg glass", role: "group", "aria-label": "Airports to show" }, segBtns);
  const sw = (key, label, note) => h("button", { type: "button", role: "switch", class: "mapx-sw", "data-key": key, "aria-checked": String(key === "rings" ? showRings : showCascade), onclick: () => toggleLayer(key) },
    h("span", { class: "mapx-sw-t" }, h("b", {}, label), h("span", {}, note)), h("i", { "aria-hidden": "true" }));
  const layers = h("div", { class: "mapx-layers glass", id: "mapxLayers", hidden: true, role: "group", "aria-label": "Map overlays" },
    sw("rings", "FAA programs", "Ring around airports with a ground stop, delay program or closure"));
  const layersBtn = h("button", { type: "button", class: "mapx-lbtn glass", "aria-expanded": "false", "aria-controls": "mapxLayers", onclick: () => openLayers(layers.hidden) }, "Overlays");
  const toolBtn = (label, aria, fn) => h("button", { type: "button", class: "glass", "aria-label": aria, onclick: fn }, label);
  const listTitle = h("h2", { tabindex: "-1" }, "Airports on the map");
  const count = h("span", { class: "mapx-count" });
  const listHead = h("div", { class: "mapx-listhead" }, listTitle, count);
  const tools = h("div", { class: "mapx-tools" },
    toolBtn("+", "Zoom in", () => zoomAt(W / 2, H / 2, view.z + 1)),
    toolBtn("−", "Zoom out", () => zoomAt(W / 2, H / 2, view.z - 1)),
    toolBtn("U.S.", "Show the whole U.S. mainland", () => { fit(); draw(true); }),
    toolBtn("List", "Go to the airport list", () => { listHead.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" }); listTitle.focus({ preventScroll: true }); }));
  const whenB = h("b", {}), whenS = h("span", {});
  const slider = h("input", { type: "range", class: "mapx-slider", min: "0", max: "23", step: "1", value: "0", "aria-label": "Forecast hour" });
  const legendBox = h("div", { class: "mapx-legend", "aria-hidden": "true" });
  const attrib = h("a", { class: "mapx-attr", hidden: true, href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "© OpenStreetMap");
  const timeBox = h("div", { class: "mapx-time glass" }, h("div", { class: "mapx-when" }, h("span", { "aria-hidden": "true" }, whenB, whenS), attrib), slider, legendBox,
    h("span", { class: "map-open-hint", style: "font-size:12px;color:var(--muted)" }, "Tap an airport for current status"));
  const stage = h("div", { class: "mapx-stage", tabindex: "0", role: "group", "aria-label": "Airport risk map. Drag or use the arrow keys to pan, plus and minus to zoom. The airport list below has the same information." },
    base, over, h("div", { class: "mapx-top" }, seg, layersBtn), layers, tools, timeBox);
  const list = h("ul", { class: "map-airport-list", "aria-label": "Airports on the map" });
  const foot = h("p", { class: "mapx-foot" });
  container.replaceChildren(h("section", { class: "mapx" }, stage, listHead, list, foot));

  // ---------- data ----------
  function store() { safe(() => localStorage.setItem(STORE, JSON.stringify({ filter, rings: showRings, cascade: showCascade }))); }
  function setFilter(k) {
    filter = k; segBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === k))); store(); render();
  }
  function toggleLayer(k) {
    if (k === "rings") showRings = !showRings; else showCascade = !showCascade;
    layers.querySelector(`[data-key="${k}"]`).setAttribute("aria-checked", String(k === "rings" ? showRings : showCascade));
    store(); draw();
  }
  function openLayers(open) {
    layers.hidden = !open; layersBtn.setAttribute("aria-expanded", String(open));
    if (open) layers.querySelector("button").focus({ preventScroll: true });
  }
  document.addEventListener("pointerdown", (e) => { if (!layers.hidden && !layers.contains(e.target) && e.target !== layersBtn) openLayers(false); });
  layers.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); openLayers(false); layersBtn.focus(); } });

  /** A starred or trip airport outside status.json, from its global shard entry (weather only). */
  function shardAirport(x) {
    const A = app(), ex = window.AWXExtra;
    if (!x.icao || !ex || !ex._shardFor || shardLoading.has(x.code)) return;
    shardLoading.add(x.code);
    shardChecks.set(x.code, { at: Date.now(), context: [A.state.data?.generated, A.state.data?.live, !!A.state.offline].join("|") });
    ex._shardFor(x.icao).then((s) => {
      const lw = (A.state.liveWx || {})[x.icao];
      const e = lw || (s && s.data && s.data.a && s.data.a[x.icao]);
      const h0 = Date.parse((lw && A.state.liveH0) || (s && s.data && s.data.h0) || (e && e.pt));
      const sig = e ? [e.h, e.mt, e.ti, h0, s?.data?.generated, A.state.data?.live, !!s?.error, !!A.state.offline].join("|") : "none";
      if (shardSig.get(x.code) === sig) return;
      shardSig.set(x.code, sig);
      if (!e || !Number.isFinite(h0)) { shardAirports.set(x.code, null); schedule(); return; }
      const pt = Date.parse(e.pt);
      const hours = String(e.h || "").split("").map((c, i) => ({ t: new Date(h0 + i * HOUR).toISOString(), level: c === "-" ? null : Number(c), reasons: h0 + i * HOUR === pt && e.r ? [e.r] : [] }))
        .filter((r) => r.level != null); // an hour no report covers stays unknown, never Clear
      shardAirports.set(x.code, hours.length ? {
        iata: x.code, icao: x.icao, name: x.name, city: x.city, tz: x.tz || "UTC", lat: x.lat, lon: x.lon, shard: true,
        coverage: { generated: lw ? A.state.data.live : s.data.generated, weatherOnly: true,
          sources: { metar: lw ? A.state.data.sources.metar : s.sources?.metars, taf: lw ? A.state.data.sources.taf : s.sources?.tafs } },
        hours, observed: [], metar: e.mt ? { obsTime: e.mt } : null, taf: e.t ? { issued: e.ti } : null, faa: [], atcscc: [], alerts: [], cascade: [],
        now: { level: e.n || 0, reasons: [] }, peak: { level: e.p || 0, at: e.pt || hours[0].t, reasons: e.r ? [e.r] : [] },
      } : null);
      schedule();
    }).catch(() => { shardSig.delete(x.code); }).finally(() => { shardLoading.delete(x.code); });
  }

  function collect() {
    const A = app(), data = A && A.state.data;
    if (!data) return false;
    const favs = A.state.favs || [];
    const trip = new Set();
    for (const r of safe(() => window.AWXTrips.routes(), []) || []) { trip.add(r.from); trip.add(r.to); }
    for (const a of data.airports) if (a.trip) trip.add(a.iata);
    const majors = new Set(data.airports.map((a) => a.iata));
    all = data.airports.filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map((a) => ({ a, code: a.iata, major: true }));
    for (const code of new Set([...favs, ...trip])) {
      if (majors.has(code)) continue;
      const x = index.find((y) => y.code === code);
      if (!x || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const check = shardChecks.get(code), context = [data.generated, data.live, !!A.state.offline].join("|");
      if (!check || check.context !== context || Date.now() - check.at >= 60e3) shardAirport(x);
      const s = shardAirports.get(code);
      all.push({ a: s || { iata: code, icao: x.icao, name: x.name, city: x.city, tz: x.tz || "UTC", lat: x.lat, lon: x.lon, hours: [], observed: [], metar: null, faa: [] }, code, major: false });
    }
    for (const e of all) { e.mine = favs.includes(e.code) || trip.has(e.code); e.wx = mx(e.a.lon); e.wy = my(e.a.lat); }
    byCode = new Map(all.map((e) => [e.code, e]));
    // slider range: the past 12 hours when observed history is there; forecast hours as far as any airport has them
    const now = A.refNow();
    minOff = data.airports.some((a) => (a.observed || []).length) ? -12 : 0;
    maxOff = 0;
    for (let k = 1; k <= 24; k++) {
      const t = now + k * HOUR;
      if (all.some((e) => (e.a.hours || []).some((x) => Date.parse(x.t) <= t && t < Date.parse(x.t) + HOUR))) maxOff = k;
    }
    offset = Math.max(minOff, Math.min(maxOff, offset));
    return true;
  }

  /** Level (null = unknown), headline and FAA programs for one airport at the slider's hour. */
  function stateOf(e) {
    const A = app();
    const v = safe(() => (e.a.hours && e.a.hours.length ? A.view(e.a) : e.a), e.a) || e.a;
    const programs = safe(() => window.AWXOutlook.restrictions(v, at, A.refNow()), []) || [];
    if (offset < 0) {
      const ds = e.a.hours && e.a.hours.length ? safe(() => A.daySlots(e.a)) : null;
      const s = ds && ds.cur >= 0 ? ds.slots[ds.cur + offset] : null;
      const lv = s && s.kind === "obs" && s.level != null ? s.level : null;
      return { lv, programs, head: lv == null ? "No report for this hour" : (s.observed ? "Observed: " : "Earlier forecast: ") + WORDS[lv] };
    }
    const o = safe(() => A.outlook(e.a, at));
    if (!o) return { lv: null, programs, head: "Forecast unavailable for this time" };
    return { lv: o.kind === "unknown" || o.level == null ? null : Math.max(0, Math.min(4, o.level)), programs: o.programs || programs, head: o.headline, quality: o.quality };
  }
  /** Cascade notes on this airport, from a hub with a program (not plain hub delays), in effect at the slider's hour. */
  function cascadesOf(e) {
    const show = safe(() => window.AWXPrefs.getPrefs().show, {}) || {};
    return (e.a.cascade || []).filter((c) => c.kind !== "delays" && Date.parse(c.from) <= at && at < Date.parse(c.to) && byCode.has(c.hub) &&
      show[safe(() => window.AWXCats.reason(c.text).cat)] !== false);
  }

  function render() {
    const A = app();
    if (!A || !collect()) { count.textContent = "Loading airports…"; return; }
    at = A.refNow() + offset * HOUR;
    for (const e of all) Object.assign(e, stateOf(e));
    shown = all.filter((e) => filter === "mine" ? e.mine : filter === "risk" ? e.lv == null || e.lv >= 2 || e.programs.some((p) => RING.has(p.type)) : true);
    slider.min = String(minOff); slider.max = String(maxOff); slider.value = String(offset);
    const w = whenWords();
    whenB.textContent = w.main; whenS.textContent = w.sub;
    slider.setAttribute("aria-valuetext", w.main + ", " + w.sub);
    legend();
    renderList();
    draw();
  }
  function legend() {
    const items = WORDS.map((word, i) => h("span", {}, h("i", { class: "l" + i }), word));
    if (shown.some((e) => e.lv == null)) items.push(h("span", {}, h("i", { class: "nodata" }), "No data"));
    legendBox.replaceChildren(...items);
  }

  /**
   * The slider's zone follows Settings → Times (map hook): "My time zone" = the device's; "Airport time" = the first
   * starred airport's (one clock for a national map), named with its code.
   */
  function sliderZone() {
    const A = app();
    const mine = safe(() => window.AWXPrefs.getPrefs().timeRef === "mine", false);
    if (mine) return { tz: USER_TZ, whose: "your time" };
    const favs = safe(() => A.state.favs, []) || [];
    const list = safe(() => A.state.data.airports, []) || [];
    const home = favs.map((c) => list.find((a) => a.iata === c)).find((a) => a && a.tz);
    return home ? { tz: home.tz, whose: (safe(() => A.codeOf(home), home.iata) || home.iata) + " time" } : { tz: USER_TZ, whose: "your time" };
  }
  /** "Now" / "Tonight 9 PM" / "Tomorrow 6 AM" / "Today 3 PM" in the slider's zone (sliderZone). */
  function whenWords() {
    const A = app(), now = A.refNow(), Z = sliderZone(), tz = Z.tz;
    const zone = safe(() => A.zoneAbbr(at, tz), "") || "";
    const sub = (offset < 0 ? "Observed" : offset === 0 ? "Current conditions" : "Forecast") + " · " + Z.whose + (zone ? " (" + zone + ")" : "");
    if (offset === 0) return { main: "Now", sub };
    const t = Math.floor(at / HOUR) * HOUR;
    const label = safe(() => A.hourLabel(t, tz), "") || new Date(t).toLocaleTimeString([], { hour: "numeric" });
    const key = (ms) => safe(() => A.brief.dayKey(ms, tz)) || new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
    const dd = key(t) === key(now) ? 0 : key(t) === key(now + 24 * HOUR) ? 1 : key(t) === key(now - 24 * HOUR) ? -1 : 9;
    const hr = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(t)) % 24; // map hook: zone from sliderZone()
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(t);
    let word;
    if (offset < 0) word = dd === 0 ? "Today" : dd === -1 ? "Yesterday" : wd;
    else if (dd === 0) word = hr < 5 ? "Overnight" : hr < 12 ? "This morning" : hr < 18 ? "This afternoon" : "Tonight";
    else if (dd === 1) word = hr < 5 ? "Tonight" : "Tomorrow";
    else word = wd;
    return { main: word + " " + label, sub };
  }

  const hasRing = (e) => e.programs.some((p) => RING.has(p.type));
  function sorted() {
    const rank = (e) => (e.lv == null ? 1.5 : e.lv) + (hasRing(e) ? 0.5 : 0);
    return [...shown].sort((x, y) => rank(y) - rank(x) || (y.mine - x.mine) || x.code.localeCompare(y.code));
  }
  function renderList() {
    const A = app();
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    const rows = sorted().map((e) => {
      const code = safe(() => A.codeOf(e.a), e.code) || e.code;
      const word = e.lv == null ? "No data" : WORDS[e.lv];
      const status = e.lv == null || (e.head && e.head.toLowerCase().includes(word.toLowerCase())) ? e.head || word : e.head ? word + " · " + e.head : word;
      const ring = hasRing(e) && !/held|program|closed|closure/i.test(status) ? ". FAA program in effect" : "";
      return h("li", {}, h("button", { type: "button", class: "map-airport-row " + (e.lv == null ? "unknown" : "l" + e.lv), "data-code": e.code,
        "aria-label": `${code}, ${e.a.city || e.a.name || ""}. ${status}${ring}${e.quality ? ". " + e.quality : ""}${e.a.shard ? ". Weather only" : ""}. Open current airport status`, onclick: () => openAirport(e) },
      h("b", { style: e.quality ? "grid-row:span 3" : null }, code), h("span", {}, e.a.city || e.a.name || ""), h("span", { class: "map-row-status" }, h("i", { "aria-hidden": "true" }), status), e.quality ? h("span", { class: "map-row-quality", style: "grid-column:2;font-size:12px;color:var(--muted)" }, e.quality) : null));
    });
    if (!shown.length) rows.push(h("li", { class: "mapx-empty" }, filter === "mine" ? "Star an airport or add a trip to see it here." : "No airport is at risk at this hour."));
    list.replaceChildren(...rows);
    count.textContent = `${shown.length} airport${shown.length === 1 ? "" : "s"}`;
    renderFoot();
    if (focused) list.querySelector(`[data-code="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  function renderFoot() {
    const b = baseKind === "vector" ? "Map data © OpenStreetMap contributors, tiles by OpenFreeMap. " : baseKind === "outline" && vmState === "fail" ? "Simplified outlines (Natural Earth): the detailed base map couldn't load. " : "";
    foot.textContent = b + "Colours show airport disruption risk at the selected hour. Tap an airport to open its current status. Starred and trip airports outside the major list use weather forecasts only.";
    attrib.hidden = baseKind !== "vector";
  }
  function openAirport(e) {
    const A = app();
    if ((A.state.data?.airports || []).some((a) => a.iata === e.code)) A.openSheet(e.code);
    else { const x = index.find((y) => y.code === e.code); window.AWXNav?.go("airports"); if (x) window.AWXExtra?.pick(x); }
  }

  // ---------- view ----------
  const scaleOf = (v) => 256 * Math.pow(2, v.z);
  const toScreen = (wx, wy, v = view) => { const s = scaleOf(v); return [(wx - v.x) * s + W / 2, (wy - v.y) * s + H / 2]; };
  const toWorld = (sx, sy, v = view) => { const s = scaleOf(v); return [v.x + (sx - W / 2) / s, v.y + (sy - H / 2) / s]; };
  const insets = () => ({ top: 112, bottom: (timeBox.offsetHeight || 110) + 16 });
  /** Stage-relative boxes of the floating controls: labels avoid them. */
  const controlBoxes = () => [stage.querySelector(".mapx-top"), tools, timeBox].map((el) => {
    const r = el.getBoundingClientRect(), o = stage.getBoundingClientRect();
    return { x0: r.left - o.left - 2, y0: r.top - o.top - 2, x1: r.right - o.left + 2, y1: r.bottom - o.top + 2 };
  });
  function fit() {
    const [x0, y1, x1, y0] = [mx(CONUS[0]), my(CONUS[1]), mx(CONUS[2]), my(CONUS[3])];
    const { top, bottom } = insets();
    const fw = Math.max(100, W - 20), fh = Math.max(100, H - top - bottom);
    view = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: Math.log2(Math.min(fw / (x1 - x0), fh / (y1 - y0)) / 256) };
    view.y -= (top - bottom) / 2 / scaleOf(view);
    clamp();
  }
  function clamp() {
    view.z = Math.max(1.5, Math.min(11, view.z));
    view.x = Math.max(mx(-190), Math.min(mx(180), view.x)); // starred airports can be anywhere
    view.y = Math.max(my(78), Math.min(my(-55), view.y));
  }
  function zoomAt(sx, sy, z) {
    if (!view) return;
    const [wx, wy] = toWorld(sx, sy);
    view.z = Math.max(1.5, Math.min(11, z));
    const s = scaleOf(view);
    view.x = wx - (sx - W / 2) / s; view.y = wy - (sy - H / 2) / s;
    clamp(); draw(true);
  }

  // ---------- drawing ----------
  function dark() {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function readColors() {
    const cs = getComputedStyle(container);
    const v = (k, d) => cs.getPropertyValue(k).trim() || d;
    const dk = dark();
    colors = { dark: dk, l: [0, 1, 2, 3, 4].map((i) => v("--l" + i, "#888")), muted: v("--muted", "#8e8e93"), brand: v("--brand", "#ffb020"),
      text: dk ? "#fff" : "#000", halo: dk ? "rgba(0,0,0,.9)" : "rgba(255,255,255,.95)", edge: dk ? "#000" : "#fff" };
  }
  function resize() {
    const want = Math.max(340, container.clientHeight - 58) + "px"; // the list heading peeks out below the map
    if (stage.style.height !== want) stage.style.height = want;
    const w = stage.clientWidth, hh = stage.clientHeight;
    if (!w || !hh) return false;
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (w !== W || hh !== H || d !== dpr) {
      const first = !view, c = view && toWorld(W / 2, H / 2);
      W = w; H = hh; dpr = d;
      for (const cv of [base, over]) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px"; }
      if (first) fit(); else { view.x = c[0]; view.y = c[1]; clamp(); }
      baseDirty = true;
    }
    return true;
  }
  /** Request a frame; baseToo = the base map must be redrawn for the view (during gestures it follows by CSS). */
  function draw(baseToo) {
    if (baseToo) baseDirty = true;
    if (frame || container.hidden) return;
    frame = requestAnimationFrame(paint);
  }
  function paint(ts) {
    frame = 0;
    if (container.hidden || !resize() || !view) return;
    if (!colors) readColors();
    layout();
    const t = performance.now();
    if (baseDirty && (!gesturing || t - baseAt > 180)) { drawBase(); baseDirty = false; baseAt = t; renderFoot(); }
    placeBase();
    drawOver(ts || t);
    pulsing = !reduced() && document.visibilityState === "visible" && dots.some((d) => d.on && d.e.lv === 4);
    if (pulsing || (gesturing && baseDirty)) frame = requestAnimationFrame(paint);
  }
  function visibleSlots(zt) {
    const n = Math.pow(2, zt), s = scaleOf(view), out = [];
    const l = view.x - W / 2 / s, r = view.x + W / 2 / s, t = view.y - H / 2 / s, b = view.y + H / 2 / s;
    const px = (wx) => Math.round(((wx - view.x) * s + W / 2) * dpr), py = (wy) => Math.round(((wy - view.y) * s + H / 2) * dpr);
    for (let j = Math.max(0, Math.floor(t * n)); j <= Math.min(n - 1, Math.floor(b * n)); j++)
      for (let i = Math.floor(l * n); i <= Math.floor(r * n); i++)
        out.push({ i, j, n, z: zt, x0: px(i / n), y0: py(j / n), x1: px((i + 1) / n), y1: py((j + 1) / n) });
    return out;
  }
  function drawBase() {
    const ctx = base.getContext("2d");
    bv = { ...view };
    const dk = colors.dark;
    if (VM && vmState === "ok" && tileSeen) {
      baseKind = "vector";
      const slots = visibleSlots(VM.tileZoom(view.z));
      safe(() => {
        VM.drawBase(ctx, slots, { dark: dk, dpr, z: view.z });
        VM.drawTop(ctx, slots, { dark: dk, dpr, z: view.z, w: W, h: H, roads: false, classes: { state: 1 }, avoid: labelBoxes });
      });
      return;
    }
    baseKind = "outline";
    const P = dk ? { water: "#0f2033", land: "#000000", state: "rgba(255,255,255,.42)" } : { water: "#bfd3e6", land: "#f3f3f1", state: "rgba(0,0,0,.32)" };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = P.water; ctx.fillRect(0, 0, base.width, base.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = scaleOf(view), ox = W / 2 - view.x * s, oy = H / 2 - view.y * s;
    const vx0 = view.x - W / 2 / s, vx1 = view.x + W / 2 / s, vy0 = view.y - H / 2 / s, vy1 = view.y + H / 2 / s;
    const path = (rings) => {
      ctx.beginPath();
      for (const r of rings) {
        if (r.b[2] < vx0 || r.b[0] > vx1 || r.b[3] < vy0 || r.b[1] > vy1) continue;
        const p = r.p;
        ctx.moveTo(p[0] * s + ox, p[1] * s + oy);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k] * s + ox, p[k + 1] * s + oy);
        ctx.closePath();
      }
    };
    ctx.fillStyle = P.land;
    if (land) { path(land); ctx.fill(); }
    if (us) { path(us); ctx.fill(); ctx.lineJoin = "round"; ctx.strokeStyle = P.state; ctx.lineWidth = 0.9; ctx.stroke(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  /** Keep the base canvas lined up with the current view by CSS while it hasn't been redrawn for it. */
  function placeBase() {
    if (!bv) return;
    const k = Math.pow(2, view.z - bv.z), s = scaleOf(view);
    const tx = W / 2 - k * W / 2 + (bv.x - view.x) * s, ty = H / 2 - k * H / 2 + (bv.y - view.y) * s;
    base.style.transform = Math.abs(k - 1) < 1e-6 && Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01 ? "" : `translate(${tx}px,${ty}px) scale(${k})`;
  }
  const textW = new Map();
  /** Dot positions, off-screen pointers and collision-checked IATA labels (worst airports placed first). */
  function layout() {
    const ctx = over.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "700 11.5px " + FONT;
    dots = []; edges = [];
    const { top, bottom } = insets();
    for (const e of sorted()) {
      const [sx, sy] = toScreen(e.wx, e.wy);
      const on = sx > -20 && sx < W + 20 && sy > -20 && sy < H + 20;
      dots.push({ e, sx, sy, r: e.mine ? 7 : 6, on });
      if (!on && (e.lv >= 3 || hasRing(e)) && edges.length < 6) {
        // a high-risk airport off screen gets a small pointer at the edge; tapping it pans there
        const cx = W / 2, cy = (top + H - bottom) / 2, dx = sx - cx, dy = sy - cy;
        const f = Math.min((W / 2 - 22) / Math.abs(dx || 1e-9), ((H - top - bottom) / 2 - 4) / Math.abs(dy || 1e-9));
        edges.push({ e, sx: cx + dx * f, sy: cy + dy * f, ang: Math.atan2(dy, dx) });
      }
    }
    const boxes = dots.filter((d) => d.on).map((d) => ({ x0: d.sx - d.r - 1, y0: d.sy - d.r - 1, x1: d.sx + d.r + 1, y1: d.sy + d.r + 1 }));
    const n = boxes.length;
    boxes.push(...controlBoxes()); // never under the floating controls
    const hit = (b) => boxes.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
    const placed = [];
    for (const d of dots) {
      d.label = null;
      if (!d.on) continue;
      const code = safe(() => app().codeOf(d.e.a), d.e.code) || d.e.code;
      if (!textW.has(code)) textW.set(code, ctx.measureText(code).width);
      const tw = textW.get(code), th = 13, g = d.r + 3;
      for (const [x0, y0] of [[d.sx + g, d.sy - th / 2], [d.sx - g - tw, d.sy - th / 2], [d.sx - tw / 2, d.sy - g - th], [d.sx - tw / 2, d.sy + g]]) {
        const b = { x0: x0 - 1, y0, x1: x0 + tw + 1, y1: y0 + th };
        if (b.x0 < 2 || b.x1 > W - 2 || hit(b)) continue;
        boxes.push(b); placed.push(b); d.label = { code, x: x0, y: y0 + th / 2 }; break;
      }
    }
    labelBoxes = boxes.slice(0, n).concat(placed);
  }
  function drawOver(ts) {
    const ctx = over.getContext("2d"), C = colors;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, over.width, over.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = (lv) => (lv == null ? C.muted : C.l[lv]);
    // trip routes (airport codes only)
    ctx.lineCap = "round";
    for (const r of safe(() => window.AWXTrips.routes(), []) || []) {
      const a = byCode.get(r.from), b = byCode.get(r.to);
      if (!a || !b) continue;
      const [x0, y0] = toScreen(a.wx, a.wy), [x1, y1] = toScreen(b.wx, b.wy);
      ctx.strokeStyle = C.brand; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + x1) / 2, Math.min(y0, y1) - Math.abs(x1 - x0) * 0.15, x1, y1); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // hub cascade lines: hub -> affected airport, with a small arrowhead
    if (showCascade) {
      for (const d of dots) for (const c of cascadesOf(d.e)) {
        const hub = byCode.get(c.hub), [hx, hy] = toScreen(hub.wx, hub.wy);
        ctx.strokeStyle = ctx.fillStyle = col(hub.lv == null ? 3 : Math.max(2, hub.lv)); ctx.globalAlpha = 0.7; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
        const ang = Math.atan2(d.sy - hy, d.sx - hx), ex = d.sx - Math.cos(ang) * (d.r + 3), ey = d.sy - Math.sin(ang) * (d.r + 3);
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(ang - 0.45) * 7, ey - Math.sin(ang - 0.45) * 7); ctx.lineTo(ex - Math.cos(ang + 0.45) * 7, ey - Math.sin(ang + 0.45) * 7); ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // Severe: a gentle pulse (a still halo under reduced motion)
    const still = reduced();
    for (const d of dots) {
      if (!d.on || d.e.lv !== 4) continue;
      const ph = still ? 0.3 : (ts % 2200) / 2200;
      ctx.globalAlpha = still ? 0.3 : 0.5 * (1 - ph);
      ctx.fillStyle = C.l[4];
      ctx.beginPath(); ctx.arc(d.sx, d.sy, d.r + 2 + ph * 12, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // FAA program rings
    if (showRings) for (const d of dots) {
      if (!d.on || !hasRing(d.e)) continue;
      ctx.beginPath(); ctx.arc(d.sx, d.sy, d.r + 5, 0, 2 * Math.PI);
      ctx.strokeStyle = C.edge; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.strokeStyle = C.brand; ctx.lineWidth = 2.2; ctx.stroke();
    }
    // dots, worst drawn last so they sit on top
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i];
      if (!d.on) continue;
      ctx.beginPath(); ctx.arc(d.sx, d.sy, d.r, 0, 2 * Math.PI);
      if (d.e.lv == null) { ctx.fillStyle = C.edge; ctx.fill(); ctx.strokeStyle = C.muted; ctx.lineWidth = 2.2; ctx.stroke(); }
      else { ctx.fillStyle = col(d.e.lv); ctx.fill(); ctx.strokeStyle = C.edge; ctx.lineWidth = 1.6; ctx.stroke(); }
    }
    ctx.font = "700 11.5px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.lineJoin = "round";
    const text = (s, x, y) => { ctx.strokeStyle = C.halo; ctx.lineWidth = 3; ctx.strokeText(s, x, y); ctx.fillStyle = C.text; ctx.fillText(s, x, y); };
    for (const d of dots) if (d.label) text(d.label.code, d.label.x, d.label.y);
    // off-screen pointers (e.g. a ground stop in Honolulu while the mainland is shown)
    for (const g of edges) {
      ctx.save(); ctx.translate(g.sx, g.sy); ctx.rotate(g.ang);
      ctx.fillStyle = col(g.e.lv); ctx.strokeStyle = C.edge; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-5, -7); ctx.lineTo(-5, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      const tw = textW.get(g.e.code) || 28;
      text(g.e.code, Math.max(4, Math.min(W - tw - 4, g.sx - Math.cos(g.ang) * 18 - tw / 2)), g.sy - Math.sin(g.ang) * 18);
    }
  }

  // ---------- input: pan, pinch, wheel, double tap, tap a dot ----------
  const ptrs = new Map();
  let gest = null, tapStart = null, lastTap = 0, tapHit = null;
  const local = (e) => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function pick(sx, sy, touch) {
    const R = touch ? 30 : 22; // 44 px targets, larger under a finger
    let best = null, bd = R;
    for (const d of dots) { if (!d.on) continue; const dd = Math.hypot(d.sx - sx, d.sy - sy); if (dd <= bd) { bd = dd; best = d; } }
    if (best) return { e: best.e };
    for (const g of edges) if (Math.hypot(g.sx - sx, g.sy - sy) <= R) return { e: g.e, pan: true };
    return null;
  }
  function startGesture() {
    const p = [...ptrs.values()];
    if (p.length === 1) gest = { kind: "pan", sx: p[0][0], sy: p[0][1], v0: { ...view } };
    else if (p.length >= 2) {
      const [a, b] = p, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      gest = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, w: toWorld(mid[0], mid[1]), z0: view.z };
    }
  }
  over.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || !view) return;
    if (!layers.hidden) openLayers(false);
    safe(() => over.setPointerCapture(e.pointerId));
    ptrs.set(e.pointerId, local(e));
    tapStart = ptrs.size === 1 ? { p: local(e), t: performance.now(), touch: e.pointerType !== "mouse", moved: false } : null;
    startGesture();
  });
  over.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, local(e));
    const p = [...ptrs.values()];
    if (tapStart && Math.hypot(p[0][0] - tapStart.p[0], p[0][1] - tapStart.p[1]) > 8) tapStart.moved = true;
    if (!gest || (tapStart && !tapStart.moved)) return;
    gesturing = true;
    if (gest.kind === "pan") {
      const s = scaleOf(view);
      view.x = gest.v0.x - (p[0][0] - gest.sx) / s; view.y = gest.v0.y - (p[0][1] - gest.sy) / s;
    } else if (p.length >= 2) {
      const [a, b] = p, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view.z = Math.max(1.5, Math.min(11, gest.z0 + Math.log2((Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / gest.d0)));
      const s = scaleOf(view);
      view.x = gest.w[0] - (mid[0] - W / 2) / s; view.y = gest.w[1] - (mid[1] - H / 2) / s;
    }
    clamp(); draw(true);
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const pos = local(e);
    ptrs.delete(e.pointerId);
    safe(() => { if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId); });
    if (e.type === "pointerup" && tapStart && !tapStart.moved && !ptrs.size && performance.now() - tapStart.t < 600) {
      const hit = pick(pos[0], pos[1], tapStart.touch);
      if (hit && hit.pan) { view.x = hit.e.wx; view.y = hit.e.wy; clamp(); draw(true); }
      else if (hit) tapHit = { e: hit.e, t: performance.now() }; // opened on the click that follows (a sheet opened now would take a touch's click)
      else if (performance.now() - lastTap < 320) { zoomAt(pos[0], pos[1], view.z + 1); lastTap = 0; }
      else lastTap = performance.now();
    }
    tapStart = null;
    if (ptrs.size) startGesture(); else { gest = null; if (gesturing) { gesturing = false; draw(true); } }
  };
  over.addEventListener("click", () => { const t = tapHit; tapHit = null; if (t && performance.now() - t.t < 1000) openAirport(t.e); });
  over.addEventListener("pointerup", up);
  over.addEventListener("pointercancel", up);
  over.addEventListener("lostpointercapture", (e) => { if (ptrs.has(e.pointerId)) up(e); });
  over.addEventListener("wheel", (e) => {
    if (!view) return;
    e.preventDefault();
    const [sx, sy] = local(e);
    zoomAt(sx, sy, view.z - Math.max(-1, Math.min(1, e.deltaY * (e.deltaMode ? 0.05 : 0.0025))));
  }, { passive: false });
  stage.addEventListener("keydown", (e) => {
    if (e.target !== stage || !view) return;
    const step = 80 / scaleOf(view), k = e.key;
    if (k === "+" || k === "=") zoomAt(W / 2, H / 2, view.z + 1);
    else if (k === "-" || k === "_") zoomAt(W / 2, H / 2, view.z - 1);
    else if (k === "ArrowLeft") view.x -= step;
    else if (k === "ArrowRight") view.x += step;
    else if (k === "ArrowUp") view.y -= step;
    else if (k === "ArrowDown") view.y += step;
    else return;
    e.preventDefault(); clamp(); draw(true);
  });
  slider.addEventListener("input", () => { offset = Number(slider.value) || 0; render(); });

  // ---------- lifecycle ----------
  let pending = false;
  function schedule() { if (pending || container.hidden) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
  const restyle = () => { colors = null; draw(true); };
  new ResizeObserver(() => draw(true)).observe(container);
  document.addEventListener("awx:render", schedule);
  document.addEventListener("awx:trips", schedule);
  safe(() => window.AWXPrefs.onPrefs(() => { restyle(); textW.clear(); schedule(); }));
  safe(() => matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyle));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") draw(); });
  setInterval(schedule, 60e3);
  const toRings = (rings) => rings.map((ring) => {
    const p = new Float64Array(ring.length * 2), b = [Infinity, Infinity, -Infinity, -Infinity];
    ring.forEach(([lon, lat], i) => { const x = mx(lon), y = my(lat); p[2 * i] = x; p[2 * i + 1] = y; b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); });
    return { p, b };
  });
  getJson("./map/us.json").then((g) => { us = toRings(g.features.flatMap((f) => f.geometry.coordinates.map((poly) => poly[0]))); draw(true); }).catch(() => {});
  getJson("./data/map-land.json").then((d) => { land = toRings(d.rings || []); draw(true); }).catch(() => {});
  loadAirports().then((l) => { index = l; schedule(); }).catch(() => {});
  loadVmap().then((M) => {
    VM = M;
    if (!M) { vmState = "fail"; draw(true); return; }
    M.init((ok) => { vmState = ok ? "ok" : "fail"; draw(true); }, () => { tileSeen = true; draw(true); });
  });

  /** Run a pending render and frame now (the check page's hidden frames may not get animation frames). */
  function flush() {
    if (pending) { pending = false; render(); }
    if (frame) cancelAnimationFrame(frame);
    frame = 0; paint(performance.now());
  }
  window.AWXMap = { // map hook: read by the check page (site/map/check.js)
    _state: () => (flush(), { dots: dots.length, onScreen: dots.filter((d) => d.on).length, shown: shown.length, rows: list.querySelectorAll(".map-airport-row").length,
      base: baseKind, vmap: vmState, offset, minOff, maxOff, at, filter, when: whenB.textContent,
      levels: Object.fromEntries(shown.map((e) => [e.code, e.lv])), heads: Object.fromEntries(shown.map((e) => [e.code, e.head])),
      labels: dots.filter((d) => d.label).length, rings: dots.filter((d) => d.on && hasRing(d.e)).length, pulsing }),
    pos: (code) => { flush(); const d = dots.find((x) => x.e.code === code); if (!d) return null; const r = over.getBoundingClientRect(); return { x: r.left + d.sx, y: r.top + d.sy, on: d.on }; },
    setOffset: (k) => { offset = Math.max(minOff, Math.min(maxOff, k)); render(); },
    setFilter,
    fit: () => { fit(); draw(true); },
  };
  return { render: () => { render(); draw(true); } };
}
