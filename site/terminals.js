// Terminal map and lounges (terminals hook) opened from the airport details menu. Loaded by index.html as a module; app.js calls
// AWXTerminals.decorateSheet(sheet, a) at the end of renderSheet(), and check.js imports checkRow().
//
//   - "Terminal map": a small north-up SVG of the terminal outlines (data/terminals/<IATA>.json, built monthly
//     from OpenStreetMap by tools/build-terminals.mjs): terminals as shapes, gates as dots, runways as thin
//     lines, lounges from OSM as amber markers, concourse letters. Tap it for the full-screen map (site/sheet.js
//     makeSheet): pan, pinch or wheel zoom (SVG viewBox, no library), gate labels once they're readable, gate
//     search ("B12") that highlights and centres the gate, and the airport's official map link.
//   - "Lounges": data/lounges.json (hand-curated), grouped by terminal, one access line each. Entries that are
//     low confidence or not verified show "Check before you go"; the card ends with a muted footnote "Checked Oct 2026
//     — confirm with the airline before you go" (oldest verified date). Hidden when the airport has none.
// Only airports listed in data/terminals/index.json are fetched (no 404s). Map data © OpenStreetMap contributors.
//
// TODO (trips hook, future): when a trip leg departs from an airport whose terminal data is known, the trip sheet
// could show the departure gate's concourse and the nearest lounge (use gateInfo(iata, ref) below). Nothing yet.

const DAY = 864e5;
export const LOUNGE_MAX_AGE_DAYS = 183; // a verified date older than ~6 months is flagged on the check page
export const TERMINALS_FRESH_DAYS = 45; // the monthly build: warn when the last check is older than this
const NS = "http://www.w3.org/2000/svg";
const OSM_COPY = "https://www.openstreetmap.org/copyright";
const W = typeof window !== "undefined" ? window : {};

// ---------- pure helpers (Node-testable) ----------

const DATE = /^\d{4}-\d\d-\d\d$/;
export const ACCESS_MAX = 60; // the access summary is one short line
const URLRE = /^https:\/\/[^\s/]+\.[^\s]+$/;
/** Problems in a lounges.json ([] when well-formed). iatas: optional Set of airports that must all be present. */
export function loungeProblems(doc, iatas = null) {
  const out = [];
  if (!doc || doc.v !== 1 || !doc.airports || typeof doc.airports !== "object") return ["not a lounges.json (v 1 with airports{})"];
  if (iatas) for (const c of iatas) if (!doc.airports[c]) out.push(`${c}: missing`);
  for (const [c, ap] of Object.entries(doc.airports)) {
    if (iatas && !iatas.has(c)) out.push(`${c}: not one of the major airports`);
    if (!ap || !Array.isArray(ap.lounges)) { out.push(`${c}: no lounges[]`); continue; }
    if (ap.map != null) {
      if (!URLRE.test(String(ap.map.url || ""))) out.push(`${c}: map url isn't https`);
      if (!["map", "home"].includes(ap.map.kind)) out.push(`${c}: map kind must be map or home`);
      if (ap.map.verified != null && !DATE.test(ap.map.verified)) out.push(`${c}: map verified isn't YYYY-MM-DD`);
    }
    ap.lounges.forEach((l, i) => {
      const w = `${c} lounge ${i}`;
      for (const k of ["name", "operator", "terminal", "access"]) if (typeof l[k] !== "string" || !l[k].trim()) out.push(`${w}: no ${k}`);
      if (l.side != null && !["airside", "landside"].includes(l.side)) out.push(`${w}: side must be airside or landside`);
      if (!URLRE.test(String(l.source || ""))) out.push(`${w}: source isn't an https URL`);
      if (!["high", "low"].includes(l.confidence)) out.push(`${w}: confidence must be high or low`);
      if (l.verified != null && !DATE.test(l.verified)) out.push(`${w}: verified isn't YYYY-MM-DD`);
      if (l.confidence === "high" && l.verified == null) out.push(`${w}: high confidence needs a verified date`);
      if (typeof l.access === "string" && (l.access.length > ACCESS_MAX || /%/.test(l.access))) out.push(`${w}: access line too long or has %`);
    });
  }
  return out.slice(0, 5);
}

/** Lounge entries whose verified date is missing or older than maxDays, as "MSP Delta Sky Club (Concourse C)". */
export function staleLounges(doc, now = Date.now(), maxDays = LOUNGE_MAX_AGE_DAYS) {
  const out = { unverified: [], old: [], total: 0 };
  for (const [c, ap] of Object.entries((doc && doc.airports) || {})) {
    for (const l of (ap && ap.lounges) || []) {
      out.total++;
      const tag = `${c} ${l.name} (${l.area || l.terminal})`;
      if (!l.verified) out.unverified.push(tag);
      else if (now - Date.parse(l.verified + "T00:00:00Z") > maxDays * DAY) out.old.push(tag);
    }
  }
  return out;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The lounge card's footnote: "Checked Oct 2026 — confirm with the airline before you go" (the oldest verified date), or null when nothing is verified. */
export function loungeFootnote(list) {
  const dates = (list || []).map((l) => l && l.verified).filter((d) => DATE.test(String(d || ""))).sort();
  if (!dates.length) return null;
  const [y, m] = dates[0].split("-");
  return `Checked ${MONTHS[+m - 1]} ${y} — confirm with the airline before you go`;
}
/** Says "check before you go" for this entry? */
export const needsCheck = (l, now = Date.now()) => !l || l.confidence !== "high" || !l.verified || now - Date.parse(l.verified + "T00:00:00Z") > LOUNGE_MAX_AGE_DAYS * DAY;

export const normGate = (s) => String(s || "").toUpperCase().replace(/^\s*GATE\s*/, "").replace(/[\s-]+/g, "");
/** Find a gate (or a concourse when only letters are typed) in a terminal file. */
export function findGate(t, q) {
  const k = normGate(q);
  if (!t || !k) return null;
  const g = (t.gates || []).find((x) => normGate(x.ref) === k);
  if (g) return { gate: g, group: (t.groups || [])[g.g] || null };
  if (/^[A-Z]{1,2}$/.test(k)) {
    const gi = (t.groups || []).findIndex((x) => x.name === "Concourse " + k);
    if (gi >= 0) return { group: t.groups[gi], gates: t.gates.filter((x) => x.g === gi) };
  }
  return null;
}
/** Lounges grouped by terminal, in file order: [{terminal, items}] */
export function loungeGroups(list) {
  const m = new Map();
  for (const l of list || []) {
    if (!m.has(l.terminal)) m.set(l.terminal, []);
    m.get(l.terminal).push(l);
  }
  return [...m].map(([terminal, items]) => ({ terminal, items }));
}

/** The drawing's extent: terminals, gates and lounges (runways run far beyond and are left to be clipped). */
export function extent(t, pad = 0.1) {
  const pts = [...(t.terminals || []).flatMap((x) => x.rings.flat()), ...(t.gates || []).map((g) => [g.x, g.y]), ...(t.lounges || []).map((l) => [l.x, l.y])];
  if (!pts.length) for (const r of t.runways || []) pts.push(...r.line);
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = Math.max(200, x1 - x0), h = Math.max(200, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x0: cx - (w / 2) * (1 + pad * 2), x1: cx + (w / 2) * (1 + pad * 2), y0: cy - (h / 2) * (1 + pad * 2), y1: cy + (h / 2) * (1 + pad * 2) };
}
/** Fit an extent into a w:h box: SVG viewBox numbers [x, y, w, h] with SVG y = -north. */
export function fitBox(e, aspect) {
  let w = e.x1 - e.x0, h = e.y1 - e.y0;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
  return [cx - w / 2, -cy - h / 2, w, h];
}
/** Typical spacing between neighbouring gates (median nearest-neighbour distance, metres). */
export function gateSpacing(gates) {
  if (!gates || gates.length < 2) return 60;
  const sample = gates.length > 200 ? gates.filter((_, i) => i % Math.ceil(gates.length / 200) === 0) : gates;
  const d = sample.map((g) => Math.min(...gates.filter((o) => o !== g).map((o) => Math.hypot(o.x - g.x, o.y - g.y)))).sort((a, b) => a - b);
  return Math.max(10, d[d.length >> 1]);
}
/** Gate info for other features (trips, later): {ref, concourse, terminal} or null. */
export function gateInfo(t, ref) {
  const f = findGate(t, ref);
  return f && f.gate ? { ref: f.gate.ref, concourse: f.group && f.group.name, terminal: f.group && f.group.terminal } : null;
}

// ---------- data ----------

const S = { index: null, lounges: null, files: new Map(), pending: new Map(), loading: null, viewer: null };
async function getJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function loadBase() {
  if (!S.loading) S.loading = getJson("./data/terminals/index.json").then((d) => { S.index = d; }).catch(() => { S.index = { airports: {} }; });
  return S.loading;
}
/** lounges.json (61 KB) isn't needed to draw the home page: it loads the first time an airport sheet opens (or its map link is needed). */
function loadLounges() {
  if (!S.loadingL) S.loadingL = getJson("./data/lounges.json").then((d) => { S.lounges = loungeProblems(d).length ? { airports: {} } : d; }).catch(() => { S.lounges = { airports: {} }; });
  return S.loadingL;
}
function loadFile(iata) {
  if (S.files.has(iata)) return Promise.resolve(S.files.get(iata));
  if (!S.pending.has(iata)) {
    S.pending.set(iata, getJson(`./data/terminals/${iata}.json`).then((d) => { S.files.set(iata, d && (d.terminals || d.gates) ? d : null); }).catch(() => { S.files.set(iata, null); }));
  }
  return S.pending.get(iata).then(() => S.files.get(iata));
}
const hasMap = (iata) => !!(S.index && S.index.airports && S.index.airports[iata] && S.index.airports[iata].ok);

// ---------- DOM helpers ----------

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
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const ICON_MAP = ["M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z", "M9 4v13.5", "M15 6.5V20"];
const ICON_SOFA = ["M4 11V8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5V11", "M3 12.5a1.5 1.5 0 0 1 3 0V15h12v-2.5a1.5 1.5 0 0 1 3 0V18H3z", "M5 18v2M19 18v2"];
function icon(d) {
  const svg = s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: "ico" });
  for (const p of d) svg.append(s("path", { d: p }));
  return svg;
}
function section(title, ico, kids, meta, cls) {
  return h("section", { class: "sec " + cls },
    h("div", { class: "sec-h" }, icon(ico), h("h3", {}, title), h("span", { class: "rule", "aria-hidden": "true" }), meta ? h("span", { class: "meta" }, meta) : null),
    h("div", { class: "scard" }, ...kids));
}
const pathD = (rings) => rings.map((r) => "M" + r.map(([x, y]) => x + " " + -y).join("L") + "Z").join("");

/** The drawing as an <svg>. opts: {box: [x,y,w,h], dot (radius in metres), letters (concourse letters), labels} */
function drawing(t, opts) {
  const [bx, by, bw, bh] = opts.box;
  const svg = s("svg", { viewBox: `${bx} ${by} ${bw} ${bh}`, class: "tm-svg", role: "img", preserveAspectRatio: "xMidYMid meet" });
  const gRw = s("g", { class: "tm-rw" });
  for (const r of t.runways || []) gRw.append(s("polyline", { points: r.line.map(([x, y]) => x + "," + -y).join(" "), "vector-effect": "non-scaling-stroke" }));
  const gT = s("g", { class: "tm-term" });
  for (const x of t.terminals || []) gT.append(s("path", { d: pathD(x.rings), "vector-effect": "non-scaling-stroke" }));
  const gG = s("g", { class: "tm-gates" });
  for (const g of t.gates || []) gG.append(s("circle", { cx: g.x, cy: -g.y, r: opts.dot, "data-ref": g.ref }));
  const gL = s("g", { class: "tm-lounges" });
  for (const l of t.lounges || []) gL.append(s("rect", { x: l.x - opts.dot * 1.6, y: -l.y - opts.dot * 1.6, width: opts.dot * 3.2, height: opts.dot * 3.2, rx: opts.dot * 0.6, transform: `rotate(45 ${l.x} ${-l.y})`, "data-x": l.x, "data-y": -l.y, "vector-effect": "non-scaling-stroke" }, s("title", {}, l.name)));
  svg.append(gRw, gT, gG, gL);
  if (opts.letters) {
    const gC = s("g", { class: "tm-conc", "font-size": opts.letters });
    (t.groups || []).forEach((grp, i) => {
      const m = /^Concourse ([A-Z]{1,2})$/.exec(grp.name);
      const gs = (t.gates || []).filter((g) => g.g === i);
      if (!m || !gs.length) return;
      const cx = gs.reduce((a, g) => a + g.x, 0) / gs.length, cy = gs.reduce((a, g) => a + g.y, 0) / gs.length;
      gC.append(s("text", { x: cx, y: -cy, "text-anchor": "middle", "dominant-baseline": "central" }, m[1]));
    });
    svg.append(gC);
  }
  return svg;
}

// ---------- sheet cards ----------

function mapCard(a, t) {
  const e = extent(t);
  if (!e) return null;
  const box = fitBox(e, 16 / 10);
  const k = box[2] / 340; // metres per CSS pixel at the card's usual width
  const dot = Math.max(1.1, Math.min(2.6, (gateSpacing(t.gates) / k) * 0.28)) * k;
  const svg = drawing(t, { box, dot, letters: 13 * k });
  const nG = (t.gates || []).length, nC = (t.groups || []).filter((g) => /^Concourse /.test(g.name)).length;
  const bits = [nC > 1 ? `${nC} concourses` : null, nG ? `${nG} gates` : null, (t.lounges || []).length ? "lounges in amber" : null].filter(Boolean).join(" · ");
  const open = (ev) => { if (ev.target.closest && ev.target.closest("a")) return; openViewer(a, t); };
  return section("Terminal map", ICON_MAP, [
    h("div", { class: "tm-card", role: "button", tabindex: "0", "aria-label": `Terminal map of ${a.iata}. Open it full screen to find a gate.`, onclick: open, onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openViewer(a, t); } } },
      svg,
      h("div", { class: "tm-cap" }, h("span", {}, bits || "Terminal outlines"), h("span", { class: "tm-open" }, "Find a gate ›"))),
    t.fixture ? h("div", { class: "tm-note" }, "Sample layout: the real map arrives with the next monthly data update.") : null,
    h("div", { class: "tm-attr" }, "Map data ", h("a", { href: OSM_COPY, target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors")),
  ], "OpenStreetMap", "tm-sec");
}

function loungeCard(a, list) {
  const now = Date.now();
  const groups = loungeGroups(list);
  const allCheck = list.every((l) => needsCheck(l, now)); // then one line for the card instead of one per entry
  return section("Lounges", ICON_SOFA, [allCheck ? h("div", { class: "ln-all" }, "Check before you go: lounges, hours and access rules change.") : null, ...groups.map((g) => h("div", { class: "item ln-grp" },
    h("div", { class: "subt" }, g.terminal),
    ...g.items.map((l) => h("div", { class: "ln" },
      h("div", { class: "ln-n" }, h("b", {}, l.name), l.area || l.side === "landside" ? h("span", { class: "muted" }, " · " + [l.area, l.side === "landside" ? "before security" : null].filter(Boolean).join(" · ")) : null),
      h("div", { class: "ln-a" }, l.access, !allCheck && needsCheck(l, now) ? h("span", { class: "ln-chk" }, " · Check before you go") : null))))),
    !allCheck && loungeFootnote(list) ? h("div", { class: "ln-foot" }, loungeFootnote(list)) : null], "Curated", "ln-sec");
}

/** Navigation only: maps and lounge lists stay behind the Airport details menu. */
function decorateSheet(sheet, a) {
  if (!sheet || !a) return;
  const menu = sheet.querySelector(".ad-menu"), A = W.AWXApp;
  if (!menu || !A?.detailRow) return;
  if (!S.index) { loadBase().then(() => redecorate(a.iata)); return; }
  if (!S.lounges) loadLounges().then(() => redecorate(a.iata)); // the Lounges row appears when its list arrives
  const anchor = menu.querySelector('[data-detail="technical"]');
  if (hasMap(a.iata) && !menu.querySelector('[data-detail="terminal"]')) {
    const row = A.detailRow("Terminal map", "Find a gate or concourse", "terminal", async () => {
      const [t] = await Promise.all([S.files.get(a.iata) || loadFile(a.iata), loadLounges()]); // lounges.json carries the airport's official-map link
      // An airport change while loading must not open the previous airport's map.
      if (A.state.openIata !== a.iata || !document.querySelector('#sheet [data-detail="terminal"]') || document.getElementById("sheet").inert) return;
      if (!row.isConnected) document.querySelector('#sheet [data-detail="terminal"]').focus({ preventScroll: true });
      if (t) openViewer(a, t);
      else A.openDetails(a.iata, "terminal");
    });
    anchor.before(row);
  }
  const L = S.lounges && S.lounges.airports && S.lounges.airports[a.iata];
  if (L && L.lounges?.length && !menu.querySelector('[data-detail="lounges"]')) anchor.before(A.detailRow("Lounges", "Locations and access rules", "lounges", () => A.openDetails(a.iata, "lounges")));
  A.refreshDetails?.();
}
function detail(a, key) {
  const L = S.lounges?.airports?.[a.iata];
  return key === "lounges" && L?.lounges?.length ? loungeCard(a, L.lounges) : null;
}
function redecorate(iata) {
  const A = W.AWXApp;
  const sheet = document.getElementById("sheet");
  if (!A || !A.state || A.state.openIata !== iata || !sheet) return;
  const a = (A.state.data && (A.state.data.airports || []).find((x) => x.iata === iata)) || null;
  if (a) decorateSheet(sheet, a);
}

// ---------- full-screen map ----------

function viewerWrap() {
  if (S.viewer) return S.viewer;
  const w = h("div", { class: "sheet-wrap tm-wrap", id: "tmWrap", hidden: true },
    h("div", { class: "backdrop", onclick: () => closeViewer() }),
    h("div", { class: "sheet tm-sheet", id: "tmSheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "tmTitle" }));
  document.body.append(w);
  w.querySelector(".sheet").addEventListener("keydown", (ev) => W.AWXApp?.popupFocus(w.querySelector(".sheet"), ev));
  const ctl = W.AWXSheet ? W.AWXSheet.makeSheet(w.querySelector(".sheet"), { onClose: () => closeViewer(), header: ".grab, .tm-head", backdrop: w.querySelector(".backdrop"), noPull: ".tm-stage, input" }) : null;
  S.viewer = { w, ctl, open: false, last: null };
  return S.viewer;
}

function openViewer(a, t) {
  const V = viewerWrap();
  V.last = document.activeElement;
  V.lastDetail = V.last && V.last.dataset.detail;
  const sheet = V.w.querySelector(".sheet");
  const L = S.lounges && S.lounges.airports && S.lounges.airports[a.iata];
  const link = L && L.map && L.map.url ? h("a", { class: "tm-link", href: L.map.url, target: "_blank", rel: "noopener" }, L.map.kind === "map" ? "Open the airport's official map" : "Open the airport's website for its maps", " ↗") : null;
  const input = h("input", { type: "search", class: "tm-q", placeholder: "Find a gate, e.g. " + ((t.gates && t.gates[Math.min(11, t.gates.length - 1)] || {}).ref || "B12"), "aria-label": "Find a gate", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", enterkeyhint: "search" });
  const msg = h("div", { class: "tm-msg", "aria-live": "polite" });
  const stage = h("div", { class: "tm-stage" });
  const zin = h("button", { type: "button", class: "tm-z", "aria-label": "Zoom in" }, "+");
  const zout = h("button", { type: "button", class: "tm-z", "aria-label": "Zoom out" }, "−");
  sheet.replaceChildren(
    h("div", { class: "grab", "aria-hidden": "true" }),
    h("div", { class: "tm-head" },
      h("div", {}, h("div", { class: "tm-title", id: "tmTitle" }, a.iata + " terminal map"), h("div", { class: "muted tm-sub" }, a.name)),
      h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => closeViewer() }, closeIcon())),
    h("form", { class: "tm-find", role: "search", onsubmit: (ev) => { ev.preventDefault(); find(); input.blur(); } }, input),
    msg,
    stage,
    h("div", { class: "tm-foot" }, link, h("div", { class: "tm-attr" }, t.fixture ? "Sample layout · " : "", "Map data ", h("a", { href: OSM_COPY, target: "_blank", rel: "noopener" }, "© OpenStreetMap contributors"))));
  const z = h("div", { class: "tm-zbar" }, zin, zout);
  stage.append(z);

  V.w.hidden = false;
  document.getElementById("sheet").inert = true;
  document.documentElement.classList.add("lock");
  if (V.ctl) V.ctl.opened();
  void V.w.offsetHeight;
  V.w.classList.add("open");
  V.open = true;
  V.esc = (ev) => { if (ev.key === "Escape" && V.open) { ev.preventDefault(); ev.stopImmediatePropagation(); closeViewer(); } };
  window.addEventListener("keydown", V.esc, true);
  sheet.querySelector(".close").focus({ preventScroll: true });

  // map state: viewBox [x, y, w, h] in metres (y = -north)
  const e = extent(t, 0.06);
  const far = (t.runways || []).length ? extent({ runways: t.runways }, 0.1) : null; // zoomed out: the whole airfield
  const maxW = Math.max(e.x1 - e.x0, far ? far.x1 - far.x0 : 0, far ? far.y1 - far.y0 : 0) * 1.4;
  const spacing = gateSpacing(t.gates);
  let sw = 1, sh = 1, vb = null, svg = null, hi = null, raf = 0;
  const dims = () => { const r = stage.getBoundingClientRect(); sw = Math.max(1, r.width); sh = Math.max(1, r.height); };
  dims();
  vb = fitBox(e, sw / sh);
  svg = drawing(t, { box: vb, dot: 1, letters: false });
  svg.setAttribute("aria-label", `Map of ${a.iata}'s terminals and gates`);
  const gLab = s("g", { class: "tm-labels" });
  for (const g of t.gates || []) gLab.append(s("text", { x: g.x, y: -g.y, "text-anchor": "middle" }, g.ref));
  const gConc = s("g", { class: "tm-conc" });
  (t.groups || []).forEach((grp, i) => {
    const gs = (t.gates || []).filter((g) => g.g === i);
    if (!gs.length) return;
    const cx = gs.reduce((q, g) => q + g.x, 0) / gs.length, cy = gs.reduce((q, g) => q + g.y, 0) / gs.length;
    gConc.append(s("text", { x: cx, y: -cy, "text-anchor": "middle", "dominant-baseline": "central" }, grp.name.replace(/^Concourse /, "")));
  });
  const gLn = s("g", { class: "tm-lnl" });
  for (const l of t.lounges || []) gLn.append(s("text", { x: l.x, y: -l.y }, l.name));
  const ring = s("circle", { class: "tm-hi", r: 1, cx: 0, cy: 0, "vector-effect": "non-scaling-stroke", visibility: "hidden" });
  svg.append(gConc, gLab, gLn, ring);
  stage.prepend(svg);

  const minW = Math.max(60, spacing * 3);
  function apply() {
    raf = 0;
    const k = vb[2] / sw; // metres per CSS pixel
    svg.setAttribute("viewBox", vb.join(" "));
    const dot = Math.max(1.4, Math.min(3.6, (spacing / k) * 0.28)) * k;
    for (const c of svg.querySelectorAll(".tm-gates circle")) c.setAttribute("r", dot);
    for (const r of svg.querySelectorAll(".tm-lounges rect")) {
      const x = +r.dataset.x, y = +r.dataset.y;
      r.setAttribute("x", x - 5 * k); r.setAttribute("y", y - 5 * k); r.setAttribute("width", 10 * k); r.setAttribute("height", 10 * k); r.setAttribute("rx", 2 * k);
    }
    const showLabels = spacing / k >= 26;
    gLab.setAttribute("font-size", 10.5 * k);
    gLab.setAttribute("visibility", showLabels ? "visible" : "hidden");
    for (const x of gLab.children) x.setAttribute("dy", (x.classList.contains("on") ? -15 : -6) * k);
    gConc.setAttribute("font-size", 15 * k);
    gConc.setAttribute("visibility", showLabels ? "hidden" : "visible");
    gLn.setAttribute("font-size", 11 * k);
    gLn.setAttribute("visibility", spacing / k >= 18 ? "visible" : "hidden");
    for (const x of gLn.children) x.setAttribute("dx", 8 * k);
    if (hi) { ring.setAttribute("r", 11 * k); }
    zin.disabled = vb[2] <= minW + 0.5;
    zout.disabled = vb[2] >= maxW - 0.5;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(apply); };
  function zoomAt(f, px, py) {
    const nw = Math.max(minW, Math.min(maxW, vb[2] * f));
    const r = nw / vb[2];
    const mx = vb[0] + (px / sw) * vb[2], my = vb[1] + (py / sh) * vb[3];
    vb = [mx - (mx - vb[0]) * r, my - (my - vb[1]) * r, nw, vb[3] * r];
    kick();
  }
  function centre(x, y, w) {
    const nw = Math.max(minW, Math.min(maxW, w || vb[2]));
    const nh = nw * (sh / sw);
    vb = [x - nw / 2, -y - nh / 2, nw, nh];
    kick();
  }
  zin.onclick = () => zoomAt(1 / 1.6, sw / 2, sh / 2);
  zout.onclick = () => zoomAt(1.6, sw / 2, sh / 2);

  // gestures: one pointer pans, two pinch; wheel zooms at the cursor; double tap zooms in
  const pts = new Map();
  let lastTap = 0;
  const mid = (v) => [(v[0][0] + v[1][0]) / 2, (v[0][1] + v[1][1]) / 2];
  const dist = (v) => Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]) || 1;
  const local = (ev) => { const r = stage.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  svg.addEventListener("pointerdown", (ev) => {
    try { svg.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    pts.set(ev.pointerId, local(ev));
    if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { const [x, y] = local(ev); zoomAt(1 / 2, x, y); lastTap = 0; } else lastTap = now;
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!pts.has(ev.pointerId)) return;
    const prev = pts.get(ev.pointerId), cur = local(ev);
    if (pts.size === 1) {
      vb[0] -= (cur[0] - prev[0]) * (vb[2] / sw);
      vb[1] -= (cur[1] - prev[1]) * (vb[3] / sh);
      if (Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) > 2) lastTap = 0;
      pts.set(ev.pointerId, cur);
      kick();
    } else if (pts.size === 2) {
      const before = [...pts.values()];
      pts.set(ev.pointerId, cur);
      const after = [...pts.values()];
      const m0 = mid(before), m1 = mid(after);
      vb[0] -= (m1[0] - m0[0]) * (vb[2] / sw);
      vb[1] -= (m1[1] - m0[1]) * (vb[3] / sh);
      zoomAt(dist(before) / dist(after), m1[0], m1[1]);
      lastTap = 0;
    }
  });
  const up = (ev) => { pts.delete(ev.pointerId); };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  svg.addEventListener("wheel", (ev) => { ev.preventDefault(); const [x, y] = local(ev); zoomAt(Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.002)), x, y); }, { passive: false });

  function find() {
    const q = input.value.trim();
    svg.querySelectorAll(".tm-gates circle.on").forEach((c) => c.classList.remove("on"));
    svg.querySelectorAll(".tm-labels text.on").forEach((c) => c.classList.remove("on"));
    ring.setAttribute("visibility", "hidden");
    hi = null;
    if (!q) { msg.textContent = ""; return; }
    const f = findGate(t, q);
    if (!f) { msg.textContent = `No gate “${q.toUpperCase()}” in the map data.`; msg.className = "tm-msg miss"; return; }
    msg.className = "tm-msg";
    if (f.gate) {
      hi = f.gate;
      const c = svg.querySelector(`.tm-gates circle[data-ref="${CSS.escape(f.gate.ref)}"]`);
      if (c) c.classList.add("on");
      const i = (t.gates || []).indexOf(f.gate);
      if (gLab.children[i]) gLab.children[i].classList.add("on");
      ring.setAttribute("cx", f.gate.x); ring.setAttribute("cy", -f.gate.y); ring.setAttribute("visibility", "visible");
      msg.textContent = `Gate ${f.gate.ref}` + (f.group ? ` · ${[f.group.name !== f.group.terminal ? f.group.name : null, f.group.terminal].filter(Boolean).join(", ")}` : "");
      centre(f.gate.x, f.gate.y, Math.min(vb[2], Math.max(minW, spacing * 10)));
    } else {
      const xs = f.gates.map((g) => g.x), ys = f.gates.map((g) => g.y);
      const ee = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      msg.textContent = `${f.group.name} · ${f.gates.length} gates`;
      centre((ee.x0 + ee.x1) / 2, (ee.y0 + ee.y1) / 2, Math.max(ee.x1 - ee.x0, (ee.y1 - ee.y0) * (sw / sh)) * 1.3);
    }
  }
  input.addEventListener("input", () => { if (findGate(t, input.value)) find(); else if (!input.value.trim()) find(); });
  const onResize = () => { dims(); vb[3] = vb[2] * (sh / sw); kick(); };
  V.onResize = onResize;
  addEventListener("resize", onResize);
  apply();
  requestAnimationFrame(() => { dims(); vb = fitBox(e, sw / sh); apply(); });
  const c = V.w.querySelector(".close");
  if (c) c.focus({ preventScroll: true });
  V.find = (q) => { input.value = q; find(); };
}

function closeViewer() {
  const V = S.viewer;
  if (!V || !V.open) return;
  V.open = false;
  document.getElementById("sheet").inert = false;
  window.removeEventListener("keydown", V.esc, true);
  V.w.classList.remove("open");
  const A = W.AWXApp;
  if (!(A && A.state && A.state.openIata)) document.documentElement.classList.remove("lock");
  if (V.ctl) V.ctl.closed();
  if (V.onResize) removeEventListener("resize", V.onResize);
  const reduced = W.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const done = () => { if (!V.open) V.w.hidden = true; };
  if (reduced) done(); else setTimeout(done, 300);
  const focus = V.last && V.last.isConnected ? V.last : V.lastDetail ? document.querySelector('#sheet [data-detail="' + V.lastDetail + '"]') : null;
  if (focus) focus.focus({ preventScroll: true });
}
function closeIcon() {
  const svg = s("svg", { viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" });
  svg.append(s("path", { d: "M6 6l12 12M18 6L6 18" }));
  return svg;
}

// ---------- check page ----------

const ago = (ms) => (ms < 2 * DAY ? `${Math.round(ms / 36e5)} h ago` : `${Math.round(ms / DAY)} days ago`);
/** Check-page rows: terminal data present and fresh, every listed file loads, lounges schema and verified dates. */
export async function checkRow(add, opts = {}) {
  const base = opts.base || "./data/";
  let idx = null;
  try { idx = await getJson(base + "terminals/index.json"); } catch (e) { add("fail", "Terminal maps: index.json loads", String(e.message || e)); }
  const majors = opts.majors || null; // the 32 major airports when the caller knows them
  if (idx) {
    const aps = idx.airports || {};
    const okList = Object.keys(aps).filter((k) => aps[k] && aps[k].ok);
    const of = majors ? majors.length : 32;
    const age = Date.now() - Date.parse(idx.checked);
    const fixtures = okList.filter((k) => aps[k].fixture);
    add(okList.length >= of ? "pass" : "warn", "Terminal maps: data present", `${okList.length} of ${of} airports${fixtures.length ? ` (${fixtures.join(", ")} sample layout until the monthly workflow runs)` : ""}${idx.failed ? `; ${idx.failed} failed last run` : ""}`);
    add(Number.isFinite(age) && age <= TERMINALS_FRESH_DAYS * DAY ? "pass" : "warn", "Terminal maps: fresh", Number.isFinite(age) ? `checked ${ago(age)} (${idx.checked}); warn after ${TERMINALS_FRESH_DAYS} days` : "no check date");
    let bad = [];
    for (const k of okList) {
      try {
        const t = await getJson(`${base}terminals/${k}.json`);
        if (!t || t.v !== 1 || !Array.isArray(t.terminals) || !Array.isArray(t.gates) || t.licenseUrl !== OSM_COPY) bad.push(`${k}: malformed`);
        else if (!extent(t)) bad.push(`${k}: nothing to draw`);
      } catch (e) { bad.push(`${k}: ${e.message || e}`); }
    }
    add(bad.length ? "fail" : "pass", "Terminal maps: files load and draw", bad.length ? bad.slice(0, 3).join("; ") : `${okList.length} files, OSM attribution present`);
  }
  let L = null;
  try { L = await getJson(base + "lounges.json"); } catch (e) { add("fail", "Lounges: lounges.json loads", String(e.message || e)); return; }
  const probs = loungeProblems(L, majors ? new Set(majors) : null);
  const st = staleLounges(L);
  add(probs.length ? "fail" : "pass", "Lounges: data well-formed", probs.length ? probs.join("; ") : `${st.total} lounges at ${Object.values(L.airports).filter((x) => x.lounges.length).length} airports`);
  add(st.unverified.length || st.old.length ? "warn" : "pass", "Lounges: verified in the last 6 months",
    st.unverified.length || st.old.length ? `${st.unverified.length} not verified, ${st.old.length} older than 6 months (they show "Check before you go"), e.g. ${[...st.old, ...st.unverified].slice(0, 2).join("; ")}` : `all ${st.total} verified since ${new Date(Date.now() - LOUNGE_MAX_AGE_DAYS * DAY).toISOString().slice(0, 10)}`);
  const maps = Object.entries(L.airports).filter(([, x]) => x.map);
  const unv = maps.filter(([, x]) => !x.map.verified).length;
  add(unv ? "warn" : "pass", "Lounges: official map links verified", `${maps.length - unv} of ${maps.length} verified; ${maps.filter(([, x]) => x.map.kind === "map").length} go straight to a map page`);
}

// ---------- styles ----------

const STYLE = `
.tm-card { display: block; margin: 10px 0 0; cursor: pointer; border-radius: 12px; }
.tm-card:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.tm-card .tm-svg { display: block; width: 100%; aspect-ratio: 16 / 10; height: auto; border-radius: 12px; background: var(--card); }
.tm-svg .tm-rw polyline { fill: none; stroke: var(--muted); stroke-width: 2; opacity: .55; stroke-linecap: round; }
.tm-svg .tm-term path { fill: color-mix(in srgb, var(--text) 13%, transparent); stroke: color-mix(in srgb, var(--text) 45%, transparent); stroke-width: 1; stroke-linejoin: round; }
.tm-svg .tm-gates circle { fill: var(--text); opacity: .8; }
.tm-svg .tm-gates circle.on { fill: var(--brand); opacity: 1; }
.tm-svg .tm-lounges rect { fill: var(--brand); stroke: var(--card); stroke-width: 1.5; }
.tm-svg .tm-conc text { fill: var(--text); font-weight: 800; font-family: var(--font); paint-order: stroke; stroke: var(--card); stroke-width: .3em; stroke-linejoin: round; }
.tm-svg .tm-labels text { fill: var(--text); font-weight: 600; font-family: var(--font); paint-order: stroke; stroke: var(--card); stroke-width: .35em; stroke-linejoin: round; }
.tm-svg .tm-labels text.on { fill: var(--brand); font-weight: 800; }
.tm-svg .tm-lnl text { fill: var(--brand); font-weight: 700; font-family: var(--font); paint-order: stroke; stroke: var(--card); stroke-width: .35em; stroke-linejoin: round; dominant-baseline: central; }
.tm-svg .tm-hi { fill: none; stroke: var(--brand); stroke-width: 3; }
.tm-cap { display: flex; justify-content: space-between; gap: 8px; padding: 8px 2px 0; font-size: 13px; color: var(--muted); }
.tm-open { color: var(--brand); font-weight: 600; white-space: nowrap; }
.tm-note { margin-top: 6px; font-size: 12.5px; color: var(--muted); }
.tm-attr { margin-top: 4px; font-size: 11.5px; color: var(--muted); }
.tm-attr a { color: inherit; }
.ln-grp .subt { margin-bottom: 4px; }
.ln { padding: 4px 0; }
.ln + .ln { border-top: 1px dashed var(--line); }
.ln-n { font-size: 14.5px; line-height: 1.3; }
.ln-a { font-size: 12.5px; line-height: 1.35; color: var(--muted); margin-top: 1px; }
.ln-chk { color: var(--brand); font-weight: 600; white-space: nowrap; }
.ln-all { padding: 10px 0 2px; font-size: 13px; font-weight: 600; color: var(--brand); }
.ln-foot { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; line-height: 1.4; color: var(--muted); }
.tm-wrap { z-index: 13; }
.tm-sheet.sheet { top: max(env(safe-area-inset-top), 10px); max-height: none; display: flex; flex-direction: column; overflow: hidden; padding-bottom: calc(env(safe-area-inset-bottom) + 12px); }
.tm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 2px 0 8px; touch-action: none; }
.tm-title { font-size: 24px; line-height: 1.1; font-weight: 800; letter-spacing: -.02em; }
.tm-sub { font-size: 13px; margin-top: 2px; }
.tm-find { margin: 0; }
.tm-q { width: 100%; font: inherit; font-size: 16px; color: var(--text); background: var(--card-2); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-height: 44px; }
.tm-q:focus { outline: 2px solid var(--brand); outline-offset: 0; }
.tm-msg { min-height: 22px; padding: 4px 2px 2px; font-size: 13.5px; font-weight: 600; }
.tm-msg.miss { color: var(--muted); font-weight: 500; }
.tm-stage { position: relative; flex: 1; min-height: 200px; border-radius: 16px; overflow: hidden; background: var(--card-2); }
.tm-stage .tm-svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
.tm-stage .tm-svg .tm-lounges rect, .tm-stage .tm-svg .tm-labels text, .tm-stage .tm-svg .tm-lnl text, .tm-stage .tm-svg .tm-conc text { stroke: var(--card-2); }
.tm-zbar { position: absolute; right: 8px; bottom: 8px; display: grid; gap: 6px; }
.tm-z { width: 44px; height: 44px; border-radius: 12px; background: var(--card); color: var(--text); font-size: 22px; font-weight: 600; line-height: 1; box-shadow: 0 1px 4px rgba(0, 0, 0, .25); }
.tm-z:disabled { opacity: .4; }
.tm-foot { padding-top: 8px; }
.tm-link { display: inline-flex; align-items: center; min-height: 44px; color: var(--brand); font-weight: 600; font-size: 14.5px; text-decoration: none; }
`;

const api = { decorateSheet, detail, checkRow, loungeProblems, staleLounges, findGate, gateInfo, _state: () => S, _open: (iata) => { const t = S.files.get(iata); const A = W.AWXApp; const a = A && A.state.data && A.state.data.airports.find((x) => x.iata === iata); if (t && a) openViewer(a, t); return !!(t && a); }, _find: (q) => S.viewer && S.viewer.find && S.viewer.find(q) };
// Only the main page draws (check.html imports this module for checkRow).
if (typeof document !== "undefined" && document.getElementById("list")) {
  if (!document.getElementById("awx-tm-css")) document.head.append(h("style", { id: "awx-tm-css" }, STYLE));
  W.AWXTerminals = api;
  loadBase().then(() => {
    const A = W.AWXApp;
    if (A && A.state && A.state.openIata) redecorate(A.state.openIata);
  });
}
export default api;
