// Airport search: instant typeahead over every airport in data/airports-all.json (and
// data/airports-extra.json when the core list has no match). Self-contained ES module, no
// dependencies.
//
//   mountSearch(container, { onPick(airport), getFavs() -> codes[], onToggleFav(code), base })
//
// Ranking: exact IATA/ICAO code, then the alias table ("NYC" -> JFK/LGA/EWR), then
// scheduled-service airports before others, larger airport types first, then code prefix,
// city word prefix and name word prefix. Matching ignores case and accents. Recent picks are
// kept in localStorage ("awx-recent"). The list loads on first focus.

const RECENT_KEY = "awx-recent";
const MAX = 8;

/** Lowercase, strip accents and punctuation: "Hagåtña" -> "hagatna", "St. Paul" -> "st paul". */
export function normalize(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[–—'’.]/g, (c) => (c === "." || c === "'" || c === "’" ? "" : " ")).replace(/[^a-z0-9]+/g, " ").trim();
}

/** Common city and region names that don't match an airport's own city/name. Order matters. */
export const ALIASES = {
  nyc: ["JFK", "LGA", "EWR"], "new york": ["JFK", "LGA", "EWR"], "new york city": ["JFK", "LGA", "EWR"],
  chicago: ["ORD", "MDW"], chi: ["ORD", "MDW"],
  dc: ["DCA", "IAD", "BWI"], washington: ["DCA", "IAD", "BWI"], "washington dc": ["DCA", "IAD", "BWI"],
  "bay area": ["SFO", "OAK", "SJC"], sf: ["SFO", "OAK", "SJC"], "san francisco": ["SFO", "OAK", "SJC"],
  la: ["LAX", "BUR", "LGB", "SNA", "ONT"], "los angeles": ["LAX", "BUR", "LGB", "SNA", "ONT"],
  dallas: ["DFW", "DAL"], houston: ["IAH", "HOU"], "south florida": ["MIA", "FLL", "PBI"], miami: ["MIA", "FLL"],
  "twin cities": ["MSP", "STP"], minneapolis: ["MSP", "STP"], "st paul": ["MSP", "STP"], "saint paul": ["MSP", "STP"],
  vegas: ["LAS"], philly: ["PHL"], nola: ["MSY"], "salt lake": ["SLC"],
  london: ["LHR", "LGW", "STN", "LTN", "LCY", "SEN"], paris: ["CDG", "ORY"], tokyo: ["HND", "NRT"],
  milan: ["MXP", "LIN", "BGY"], rome: ["FCO", "CIA"], moscow: ["SVO", "DME", "VKO"], "sao paulo": ["GRU", "CGH", "VCP"],
  "buenos aires": ["EZE", "AEP"], seoul: ["ICN", "GMP"], shanghai: ["PVG", "SHA"], beijing: ["PEK", "PKX"],
  stockholm: ["ARN", "BMA"], osaka: ["KIX", "ITM"], toronto: ["YYZ", "YTZ"], montreal: ["YUL"],
};
const TYPE_RANK = { L: 0, M: 1, S: 2 };
export const US_AREAS = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];

/** File JSON -> airport objects with precomputed search keys. */
export function decodeList(j) {
  const f = Object.fromEntries((j.f || []).map((k, i) => [k, i]));
  return (j.a || []).map((r) => {
    const a = {
      iata: r[f.iata] || "", icao: r[f.icao] || "", name: r[f.name] || "", city: r[f.city] || "",
      country: r[f.country] || "", region: r[f.region] || "", lat: r[f.lat], lon: r[f.lon],
      tz: r[f.tz] >= 0 ? j.tz[r[f.tz]] : null, scheduled: !!r[f.scheduled], hasMetar: !!r[f.hasMetar], hasTaf: !!r[f.hasTaf],
      type: r[f.type] || "S", runways: (r[f.runways] || []).map(([ids, headingTrue]) => ({ ids, headingTrue })),
    };
    a.code = a.iata || a.icao;
    a.state = US_AREAS.includes(a.country) && a.country === "US" ? a.region.split("-")[1] || "" : a.country;
    a._city = normalize(a.city).split(" ").filter(Boolean);
    a._name = normalize(a.name).split(" ").filter(Boolean);
    return a;
  });
}

const prefixAll = (qw, words) => qw.every((w) => words.some((x) => x.startsWith(w)));

/** Ranked matches for query (up to limit). */
export function rank(query, list, { limit = MAX } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const Q = q.replace(/ /g, "").toUpperCase();
  const qw = q.split(" ");
  const alias = ALIASES[q] || null;
  const hits = [];
  for (const a of list) {
    let exact = 0;
    let tier = 9;
    if (Q === a.iata || Q === a.icao) exact = 1;
    const ai = alias ? alias.indexOf(a.iata) : -1;
    if (exact) tier = 0;
    else if (Q.length >= 2 && (a.iata.startsWith(Q) || a.icao.startsWith(Q))) tier = 1;
    else if (prefixAll(qw, a._city)) tier = 2;
    else if (prefixAll(qw, [...a._city, ...a._name])) tier = 3;
    if (tier === 9 && ai < 0) continue;
    hits.push({ a, k: [exact ? 0 : ai >= 0 ? 1 : 2, ai >= 0 ? ai : 0, a.scheduled ? 0 : 1, TYPE_RANK[a.type] ?? 3, tier, a.code] });
  }
  hits.sort((x, y) => {
    for (let i = 0; i < x.k.length; i++) {
      if (x.k[i] < y.k[i]) return -1;
      if (x.k[i] > y.k[i]) return 1;
    }
    return 0;
  });
  return hits.slice(0, limit).map((h) => h.a);
}

/** Great-circle distance in statute miles. */
export function miles(a, b) {
  const R = 3958.8;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Nearest airport in list (other than a) passing filter. Returns {airport, miles} or null. */
export function nearest(a, list, filter = (x) => x.hasMetar || x.hasTaf) {
  let best = null;
  for (const x of list) {
    if (x === a || x.code === a.code || !filter(x) || x.lat == null) continue;
    const d = miles(a, x);
    if (!best || d < best.miles) best = { airport: x, miles: d };
  }
  return best;
}

// ---------- data loading (shared, cached) ----------

const cache = { base: null, core: null, extra: null, list: null, extraWanted: false };
/** Loads the core list once; returns the decoded list. */
export async function loadAirports(base = "./data/") {
  if (cache.core && cache.base === base) return cache.list;
  const res = await fetch(base + "airports-all.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  cache.base = base;
  cache.core = decodeList(j);
  cache.extraWanted = !!j.extra;
  cache.list = cache.core;
  return cache.list;
}
/** Loads airports-extra.json (only if the core file says it exists). */
export async function loadExtra(base = "./data/") {
  if (!cache.extraWanted || cache.extra) return cache.list;
  const res = await fetch(base + "airports-extra.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  cache.extra = decodeList(await res.json());
  cache.list = cache.core.concat(cache.extra);
  return cache.list;
}
export const airportsLoaded = () => cache.list;

// ---------- recents ----------

export function getRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 6) : [];
  } catch { return []; }
}
function addRecent(code) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([code, ...getRecent().filter((c) => c !== code)].slice(0, 6))); } catch { /* storage blocked */ }
}

// ---------- UI ----------

const CSS = `
.awx-s{position:relative;margin:0 0 14px}
.awx-s input{width:100%;font:inherit;font-size:17px;line-height:1.2;color:var(--text,#fff);background:var(--card,#1c1c1e);border:0;border-radius:12px;padding:11px 14px 11px 38px;outline:none;-webkit-appearance:none;appearance:none}
.awx-s input:focus-visible{outline:2px solid var(--l1,#2ec4d6);outline-offset:1px}
.awx-s .ico{position:absolute;left:12px;top:12px;width:18px;height:18px;color:var(--muted,#8e8e93);pointer-events:none}
.awx-s ul{list-style:none;margin:6px 0 0;padding:4px 0;background:var(--card,#1c1c1e);border-radius:16px;max-height:70vh;overflow:auto}
.awx-s ul[hidden]{display:none}
.awx-s li{display:flex;align-items:center;gap:12px;padding:8px 6px 8px 14px;cursor:pointer;min-height:52px}
.awx-s li+li{border-top:1px solid var(--line,rgba(255,255,255,.1))}
.awx-s li[aria-selected=true]{background:var(--card-2,#2c2c2e)}
.awx-s li.hd{min-height:0;padding:6px 14px 2px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#8e8e93);cursor:default}
.awx-s li.none{color:var(--muted,#8e8e93);cursor:default}
.awx-s .c{font-size:24px;font-weight:800;letter-spacing:-.02em;min-width:64px}
.awx-s .t{flex:1;min-width:0}
.awx-s .t b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.awx-s .t span{display:block;font-size:13px;color:var(--muted,#8e8e93);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.awx-s .st{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;color:var(--muted,#8e8e93);flex:none}
.awx-s .st svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8}
.awx-s .st[aria-pressed=true]{color:var(--l2,#ffb020)}
.awx-s .st[aria-pressed=true] svg{fill:currentColor}
.awx-vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
let uid = 0;

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function svg(d, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d);
  p.setAttribute("stroke-linejoin", "round");
  p.setAttribute("stroke-linecap", "round");
  s.append(p);
  return s;
}
const STAR = "M12 3.5l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z";
const LENS = "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20";

/** Where line for a result row: "Minneapolis, MN · Minneapolis–St Paul International Airport". */
export function placeLine(a) {
  const st = a.country === "US" ? a.state : a.country;
  return [a.city, st].filter(Boolean).join(", ");
}

export function mountSearch(container, { onPick = () => {}, getFavs = () => [], onToggleFav = null, base = "./data/" } = {}) {
  if (!document.getElementById("awx-search-css")) document.head.append(el("style", { id: "awx-search-css" }, CSS));
  const id = "awxs" + ++uid;
  const input = el("input", {
    id: id + "i", type: "search", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id + "l",
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search", placeholder: "Search airports, cities, codes",
  });
  const list = el("ul", { id: id + "l", role: "listbox", "aria-label": "Airports", hidden: true });
  const live = el("div", { class: "awx-vh", "aria-live": "polite" });
  const root = el("div", { class: "awx-s" }, el("label", { class: "awx-vh", for: id + "i" }, "Search airports"), svg(LENS, "ico"), input, list, live);
  container.append(root);

  let items = [];
  let active = -1;
  let loading = null;
  let failed = false;

  const ensure = () => {
    if (!loading) loading = loadAirports(base).catch((e) => { failed = true; loading = null; throw e; });
    return loading;
  };

  function setActive(i) {
    active = i;
    [...list.querySelectorAll("li[role=option]")].forEach((li, k) => li.setAttribute("aria-selected", String(k === i)));
    const cur = list.querySelector(`#${id}o${i}`);
    if (cur) { input.setAttribute("aria-activedescendant", cur.id); cur.scrollIntoView({ block: "nearest" }); } else input.removeAttribute("aria-activedescendant");
  }
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function pick(a) {
    addRecent(a.code);
    input.value = "";
    close();
    input.blur();
    onPick(a);
  }
  function row(a, i) {
    const favs = getFavs() || [];
    const fav = favs.includes(a.code);
    const star = onToggleFav ? el("button", {
      type: "button", class: "st", tabindex: "-1", "aria-pressed": String(fav),
      "aria-label": (fav ? "Remove " : "Add ") + a.code + (fav ? " from" : " to") + " my airports",
      onclick: (e) => { e.stopPropagation(); onToggleFav(a.code); const now = (getFavs() || []).includes(a.code); e.currentTarget.setAttribute("aria-pressed", String(now)); e.currentTarget.setAttribute("aria-label", (now ? "Remove " : "Add ") + a.code + (now ? " from" : " to") + " my airports"); },
      onmousedown: (e) => e.preventDefault(),
    }, svg(STAR)) : null;
    return el("li", {
      id: `${id}o${i}`, role: "option", "aria-selected": "false", "data-code": a.code,
      "aria-label": `${a.code}, ${placeLine(a)}, ${a.name}`,
      onmousedown: (e) => e.preventDefault(), // keep focus in the input
      onclick: () => pick(a),
    }, el("span", { class: "c", "aria-hidden": "true" }, a.code), el("span", { class: "t", "aria-hidden": "true" }, el("b", {}, placeLine(a) || a.name), el("span", {}, a.name)), star);
  }
  function show(rows, heading, emptyText) {
    items = rows;
    const kids = [];
    if (heading && rows.length) kids.push(el("li", { class: "hd", role: "presentation" }, heading));
    rows.forEach((a, i) => kids.push(row(a, i)));
    if (!rows.length && emptyText) kids.push(el("li", { class: "none", role: "presentation" }, emptyText));
    list.replaceChildren(...kids);
    const open = kids.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    setActive(rows.length && input.value.trim() ? 0 : -1);
    live.textContent = input.value.trim() ? (rows.length ? `${rows.length} result${rows.length > 1 ? "s" : ""}` : emptyText || "") : "";
  }

  async function update() {
    const q = input.value;
    let all;
    try { all = await ensure(); } catch { show([], null, "Couldn't load the airport list"); return; }
    if (q !== input.value) return; // typed on meanwhile
    if (!q.trim()) {
      const rec = getRecent().map((c) => all.find((a) => a.code === c)).filter(Boolean);
      if (rec.length) show(rec, "Recent"); else close();
      return;
    }
    let res = rank(q, all);
    if (!res.length) {
      try { all = await loadExtra(base); } catch { /* core only */ }
      if (q !== input.value) return;
      res = rank(q, all);
    }
    show(res, null, "No airports match");
  }

  input.addEventListener("focus", () => { update(); });
  input.addEventListener("input", () => { update(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) update(); else setActive(Math.min(items.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter") { if (items[active]) { e.preventDefault(); pick(items[active]); } }
    else if (e.key === "Escape") { if (!list.hidden) { e.preventDefault(); close(); } else input.value = ""; }
    else if (e.key === "s" && e.altKey && items[active] && onToggleFav) { e.preventDefault(); onToggleFav(items[active].code); update(); }
  });
  return { input, close, update, failed: () => failed };
}
