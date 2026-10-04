// Dependency-free airport outlook map. Boundaries are local Natural Earth data.
import { h, app } from "./navui.js";
import { loadAirports } from "./search.js";
const NS = "http://www.w3.org/2000/svg";
const project = (lon, lat) => [(lon + 180) / 360 * 1000, (90 - lat) / 180 * 500];
const svgEl = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  if (text != null) e.textContent = text;
  return e;
};
export function mountMap(container) {
  let offset = 0, filter = "mine", selected = null, index = [], entries = [], land = null, landFailed = false;
  let box = [project(-128, 51)[0], project(-128, 51)[1], 182, 84], initialized = false;
  let dragged = false, down = null, pointers = new Map(), pinch = null;
  let cameraBeforeResize = null, previousWidth = 0, pending = false;
  const map = svgEl("svg", { class: "risk-map", viewBox: box.join(" "), role: "group", "aria-label": "Airport disruption map. Use zoom buttons or drag to explore." });
  const background = svgEl("g", { class: "map-land" }), routes = svgEl("g", { class: "map-routes", "aria-hidden": "true" }), pins = svgEl("g");
  map.append(background, routes, pins);
  const heading = h("h2", {}, "Airport outlook");
  const timeLabel = h("p", { class: "map-time muted", "aria-live": "polite" });
  const preview = h("div", { class: "map-preview", "aria-live": "polite" });
  const list = h("div", { class: "map-airport-list" });
  const count = h("p", { class: "map-count muted", "aria-live": "polite" });
  const warning = h("p", { class: "map-warning", hidden: true });
  const timeButtons = [0, 3, 6, 12, 24].map((hours) => h("button", { type: "button", "aria-pressed": String(hours === offset), onclick: () => {
    offset = hours; timeButtons.forEach((b, i) => b.setAttribute("aria-pressed", String([0, 3, 6, 12, 24][i] === offset))); render();
  } }, hours ? "+" + hours + "h" : "Now"));
  const filters = [["mine", "My airports"], ["all", "All"], ["risk", "At risk"]].map(([key, label]) => h("button", { type: "button", "aria-pressed": String(key === filter), onclick: () => {
    filter = key; filters.forEach((b, i) => b.setAttribute("aria-pressed", String(["mine", "all", "risk"][i] === filter))); fitEntries(); render();
  } }, label));
  const toolbar = h("div", { class: "map-camera", role: "group", "aria-label": "Map navigation" },
    h("button", { type: "button", "aria-label": "Zoom in", onclick: () => zoom(0.65) }, "+"),
    h("button", { type: "button", "aria-label": "Zoom out", onclick: () => zoom(1.5) }, "−"),
    h("button", { type: "button", onclick: () => { fitEntries(); draw(); } }, "Fit airports"));
  container.replaceChildren(h("section", { class: "map-section" },
    h("div", { class: "map-heading" }, heading),
    h("div", { class: "map-times", role: "group", "aria-label": "Forecast time" }, timeButtons), timeLabel,
    h("div", { class: "map-filters", role: "group", "aria-label": "Map airport filter" }, filters),
    h("div", { class: "map-stage" }, map, toolbar),
    h("div", { class: "map-legend" },
      h("span", {}, h("i", { class: "l0" }), "Normal"), h("span", {}, h("i", { class: "l2" }), "Forecast risk"),
      h("span", {}, h("i", { class: "l4" }), "! FAA restriction"), h("span", {}, h("i", { class: "unknown" }), "? Unavailable")),
    warning, count, preview,
    h("p", { class: "map-coverage muted" }, "Forecasts cover monitored airports. Saved airports without disruption forecasts stay grey. Map outline: ", h("a", { href: "https://www.naturalearthdata.com/about/terms-of-use/", target: "_blank", rel: "noopener" }, "Natural Earth")),
    list));
  function visible() {
    const favs = app()?.state.favs || [];
    return entries.filter((e) => filter === "mine" ? favs.includes(e.code) : filter === "risk" ? e.o.level >= 2 || e.o.kind === "active" || e.o.kind === "unknown" : true);
  }
  function fitEntries() {
    const es = visible();
    if (!es.length) return;
    const points = es.map((e) => project(e.a.lon, e.a.lat)), xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const width = Math.max(20, Math.max(...xs) - Math.min(...xs) + 22), height = Math.max(12, Math.max(...ys) - Math.min(...ys) + 15);
    const ratio = map.clientWidth / map.clientHeight || 1.5;
    const w = Math.max(width, height * ratio), hh = w / ratio;
    box = [(Math.max(...xs) + Math.min(...xs) - w) / 2, (Math.max(...ys) + Math.min(...ys) - hh) / 2, w, hh];
    clamp();
  }
  function clamp() {
    const ratio = map.clientWidth / map.clientHeight || 1.5;
    box[2] = Math.max(0.7, Math.min(990, box[2])); box[3] = box[2] / ratio;
    box[0] = Math.max(-30, Math.min(1000 - box[2] + 30, box[0]));
    box[1] = Math.max(-40, Math.min(500 - box[3] + 40, box[1]));
  }
  function zoom(factor, x = box[0] + box[2] / 2, y = box[1] + box[3] / 2) {
    const fx = (x - box[0]) / box[2], fy = (y - box[1]) / box[3];
    box = [x - box[2] * factor * fx, y - box[3] * factor * fy, box[2] * factor, box[3] * factor]; clamp(); draw();
  }
  function choose(e, focus = false) {
    selected = e.code; draw(); renderPreview();
    for (const row of list.children) row.setAttribute("aria-pressed", String(row.dataset.code === selected));
    if (focus) preview.querySelector("button")?.focus({ preventScroll: true });
  }
  function draw() {
    if (!map.clientWidth) return;
    map.setAttribute("viewBox", box.join(" "));
    if (land && !background.childNodes.length) {
      const path = land.rings.map((ring) => "M" + ring.map(([lon, lat]) => project(lon, lat).map((n) => n.toFixed(3)).join(",")).join("L") + "Z").join(" ");
      background.append(svgEl("path", { d: path, "vector-effect": "non-scaling-stroke" }));
    }
    routes.replaceChildren();
    const byCode = new Map(entries.map((e) => [e.code, e]));
    for (const r of window.AWXTrips?.routes?.() || []) {
      const from = byCode.get(r.from), to = byCode.get(r.to);
      if (!from || !to) continue;
      const [x, y] = project(from.a.lon, from.a.lat), [xx, yy] = project(to.a.lon, to.a.lat);
      // Avoid drawing an artificial route through the whole world across the date line.
      if (Math.abs(x - xx) > 500) continue;
      routes.append(svgEl("path", { d: `M${x},${y} Q${(x + xx) / 2},${Math.min(y, yy) - Math.abs(x - xx) * 0.12} ${xx},${yy}`, "vector-effect": "non-scaling-stroke" }));
    }
    const scale = map.getScreenCTM()?.a || map.clientWidth / box[2];
    const groups = [];
    for (const e of visible()) {
      const [x, y] = project(e.a.lon, e.a.lat);
      if (x < box[0] || x > box[0] + box[2] || y < box[1] || y > box[1] + box[3]) continue;
      const group = groups.find((g) => Math.hypot((g.x - x) * scale, (g.y - y) * scale) < 46);
      if (group) { group.items.push(e); } else groups.push({ x, y, items: [e] });
    }
    pins.replaceChildren();
    for (const g of groups) {
      const worst = g.items.reduce((a, b) => (b.o.level ?? -1) > (a.o.level ?? -1) ? b : a);
      const unknown = g.items.every((e) => e.o.kind === "unknown");
      const cls = unknown ? "unknown" : "l" + (worst.o.level || 0);
      const one = g.items.length === 1;
      const active = g.items.some((e) => e.code === selected);
      const label = one ? worst.code + ": " + worst.o.headline + (worst.o.quality ? ". " + worst.o.quality : "") : g.items.length + " airports: " + g.items.map((e) => e.code).join(", ") + ". Zoom to separate pins.";
      const pin = svgEl("g", { class: "map-pin " + cls + (active ? " selected" : ""), transform: `translate(${g.x},${g.y}) scale(${1 / scale})`, role: "button", tabindex: 0, "aria-label": label, "aria-pressed": String(active) });
      pin.append(svgEl("circle", { r: 22, class: "pin-target" }), svgEl("circle", { r: one ? 11 : 15, class: "pin-dot" }),
        svgEl("text", { class: "pin-glyph", "text-anchor": "middle", y: 5 }, one ? worst.o.kind === "unknown" ? "?" : worst.o.kind === "active" ? "!" : worst.o.kind === "forecast" ? "~" : "✓" : g.items.length),
        svgEl("text", { class: "pin-label", "text-anchor": "middle", y: -19 }, one ? worst.code : ""));
      const activate = () => { if (one) choose(worst); else zoom(0.4, g.x, g.y); };
      pin._activate = activate;
      pin.addEventListener("click", (e) => { if (e.detail === 0 && !dragged) { e.stopPropagation(); activate(); } });
      pin.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (one) choose(worst, true); else { activate(); map.focus(); } } });
      pins.append(pin);
    }
  }
  function renderPreview() {
    const es = visible();
    let e = es.find((e) => e.code === selected);
    if (!e) { e = es.find((e) => e.o.kind === "active") || es.find((e) => e.o.level >= 2) || es[0]; selected = e?.code || null; }
    if (!e) { preview.replaceChildren(h("p", { class: "muted" }, filter === "mine" ? "Save an airport to see it here, or choose All." : "No significant airport disruption expected at this time.")); return; }
    const o = e.o, A = app(), at = A?.whenLabel?.(o.at, A.dispTz(e.a)) || "";
    const code = A?.codeOf?.(e.a) || e.code;
    const statusClass = o.kind === "unknown" ? "unknown" : "l" + (o.level || 0);
    const forecast = o.window && (o.kind === "forecast" || o.kind === "normal") ? "Highest risk " + A.whenLabel(o.window.start, A.dispTz(e.a)) + " – " + A.whenLabel(o.window.end, A.dispTz(e.a)) : "";
    const open = () => {
      if ((A?.state.data?.airports || []).some((a) => a.iata === e.code)) A.openSheet(e.code);
      else { window.AWXNav?.go("airports"); window.AWXExtra?.pick(e.a); }
    };
    preview.replaceChildren(
      h("div", { class: "map-preview-head" }, h("b", { class: "map-code" }, code), h("span", { class: "muted" }, e.a.name)),
      h("h3", { class: "map-status " + statusClass }, o.headline),
      o.quality ? h("p", { class: "map-quality" }, o.quality) : null,
      h("p", { class: "muted map-selected-time" }, offset ? "Forecast for " + at + " · " + A.zoneAbbr(o.at, A.dispTz(e.a)) : "Now · " + A.zoneAbbr(o.at, A.dispTz(e.a))),
      o.cue ? h("p", { class: "map-cue" }, o.cue) : null,
      o.impacts.length ? h("p", {}, o.impacts[0].label + ": " + o.impacts[0].value) : o.kind === "forecast" && o.reasons.length ? h("p", {}, o.reasons.join(" · ")) : null,
      o.scheduledEnd ? h("p", { class: "muted" }, "Scheduled through " + A.whenLabel(o.scheduledEnd, A.dispTz(e.a)) + " · may change") : forecast ? h("p", { class: "muted" }, forecast) : null,
      o.extension ? h("p", { class: "muted" }, "FAA extension outlook: " + o.extension) : null,
      h("button", { type: "button", class: "map-open", onclick: open }, "Airport details", " ›"));
  }
  function render() {
    const A = app(), data = A?.state.data;
    if (!data) { count.textContent = "Loading airport data…"; return; }
    const reference = A.refNow(), at = reference + offset * 3600000;
    const all = [...data.airports];
    for (const code of A.state.favs) {
      if (all.some((a) => a.iata === code)) continue;
      const a = index.find((a) => a.code === code);
      if (a) all.push({ ...a, iata: code, hours: [], metar: null });
    }
    entries = all.filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map((a) => ({ a, code: a.iata, o: A.outlook(a, at) }));
    const es = visible();
    timeLabel.textContent = offset ? `In ${offset} hours · all pins show the same moment; details use airport-local time` : "Now · current airport conditions";
    count.textContent = `${es.length} airport${es.length === 1 ? "" : "s"}` + (es.some((e) => e.o.kind === "unknown") ? ` · ${es.filter((e) => e.o.kind === "unknown").length} unavailable` : "") + (offset === 24 ? " · forecasts may not extend to this hour yet" : "");
    warning.hidden = !landFailed;
    warning.textContent = landFailed ? "Map outline unavailable. Airport status and the list below remain available." : "";
    if (!initialized && map.clientWidth && es.length) { fitEntries(); initialized = true; }
    renderPreview(); draw();
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    list.replaceChildren(...es.map((e) => h("button", { type: "button", "data-code": e.code, class: "map-airport-row", "aria-pressed": String(e.code === selected), onclick: () => {
      selected = e.code; const [x, y] = project(e.a.lon, e.a.lat); box[0] = x - box[2] / 2; box[1] = y - box[3] / 2; clamp(); choose(e); render();
    } }, h("b", {}, A.codeOf(e.a)), h("span", {}, e.a.city || e.a.name), h("span", { class: "map-row-status " + (e.o.kind === "unknown" ? "unknown" : "l" + (e.o.level || 0)) }, e.o.headline))));
    if (focused) list.querySelector(`[data-code="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  function schedule() { if (pending || container.hidden) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
  map.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragged = false; pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY, box: [...box], target: e.target.closest(".map-pin") };
    map.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [p, q] = [...pointers.values()]; pinch = { distance: Math.hypot(p.x - q.x, p.y - q.y), box: [...box] }; }
  });
  map.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !down) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [p, q] = [...pointers.values()], distance = Math.hypot(p.x - q.x, p.y - q.y);
      if (distance < 5) return;
      const factor = pinch.distance / distance; box = [...pinch.box];
      const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
      box = [cx - box[2] * factor / 2, cy - box[3] * factor / 2, box[2] * factor, box[3] * factor]; dragged = true; clamp(); draw(); return;
    }
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.hypot(dx, dy) < 7 && !dragged) return;
    dragged = true;
    const scale = map.getScreenCTM()?.a || map.clientWidth / box[2];
    box[0] = down.box[0] - dx / scale; box[1] = down.box[1] - dy / scale; clamp(); draw();
  });
  const release = (e) => {
    const tap = e.type === "pointerup" && !dragged && pointers.size === 1 ? down?.target : null;
    pointers.delete(e.pointerId); pinch = null;
    if (!pointers.size) down = null;
    else { const p = [...pointers.values()][0]; down = { ...p, box: [...box] }; }
    if (map.hasPointerCapture(e.pointerId)) map.releasePointerCapture(e.pointerId);
    tap?._activate?.();
  };
  map.addEventListener("pointerup", release); map.addEventListener("pointercancel", release);
  map.addEventListener("lostpointercapture", (e) => { pointers.delete(e.pointerId); if (!pointers.size) { down = null; pinch = null; } });
  map.setAttribute("tabindex", "0");
  map.addEventListener("keydown", (e) => {
    if (e.target !== map) return;
    if (["+", "="].includes(e.key)) { e.preventDefault(); zoom(0.65); }
    else if (e.key === "-") { e.preventDefault(); zoom(1.5); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); box[0] += (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0) * box[2] * 0.15;
      box[1] += (e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0) * box[3] * 0.15; clamp(); draw();
    }
  });
  new ResizeObserver(() => {
    if (!map.clientWidth || map.clientWidth === previousWidth) return;
    const center = [box[0] + box[2] / 2, box[1] + box[3] / 2];
    previousWidth = map.clientWidth; cameraBeforeResize = center;
    clamp(); box[1] = cameraBeforeResize[1] - box[3] / 2; schedule();
  }).observe(map);
  document.addEventListener("awx:render", schedule); document.addEventListener("awx:trips", schedule);
  window.AWXPrefs?.onPrefs(schedule);
  fetch("./data/map-land.json").then((r) => { if (!r.ok) throw Error("map outline"); return r.json(); }).then((data) => { land = data; schedule(); }).catch(() => { landFailed = true; schedule(); });
  loadAirports().then((airports) => { index = airports; schedule(); }).catch(() => {});
  setInterval(schedule, 60000);
  return { render };
}
