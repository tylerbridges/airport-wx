// Device-only visit checkpoints; no calendar contents or personal flight data are stored.
export const SEEN_KEY = "awx-seen-changes";
const HOUR = 3600e3, LATE = 20 * 60e3;
const key = e => JSON.stringify([e.t, e.kind, e.from, e.to, e.prog]);
export function meaningful(e) {
  if (/^(program_(start|end|extend)|closure_(start|end)|warning)$/.test(e.kind)) return true;
  return e.kind === "level" && Number.isInteger(e.from) && Number.isInteger(e.to) && e.from !== e.to && Math.max(e.from, e.to) >= 2;
}
export function selectChanges(log, ids, baseline, now) {
  const wanted = new Set(ids), seen = new Set();
  return (log.events || []).filter(e => e && typeof e.iata === "string").filter(e => {
    const old = baseline[e.iata], at = Date.parse(e.t), id = e.iata + key(e);
    if (!wanted.has(e.iata) || !old || !meaningful(e) || !e.sentence || seen.has(id) || at > now || at < now - 36 * HOUR) return false;
    // Debounced events can be published one poll after their original event time.
    if (!(at > old.at || at > old.at - LATE && !old.keys.includes(key(e)))) return false;
    seen.add(id); return true;
  }).sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).filter(e => {
    const family = e.kind.startsWith("program_") ? "program:" + (e.prog || (e.kind === "program_end" ? e.from : e.to))
      : e.kind.startsWith("closure_") ? "closure" : e.kind === "warning" ? "warning:" + e.to : e.kind;
    const group = e.iata + ":" + family;
    if (seen.has(group)) return false;
    seen.add(group); return true;
  });
}
export function createVisits(storage) {
  let saved = {}, baseline = {};
  function read(now) {
    try {
      const d = JSON.parse(storage.getItem(SEEN_KEY));
      if (d?.v !== 1 || !d.airports || typeof d.airports !== "object") return {};
      return Object.fromEntries(Object.entries(d.airports).filter(([id, x]) => /^[A-Z0-9]{3,4}$/.test(id) && x && Number.isFinite(x.at) && x.at > now - 30 * 24 * HOUR && x.at <= now + 60000 && Array.isArray(x.keys))
        .slice(0, 96).map(([id,x]) => [id, {at:x.at, keys:x.keys.filter(k => typeof k === "string" && k.length < 300).slice(0, 24)}]));
    } catch { return saved; }
  }
  function snapshot(log, id) {
    const at = Date.parse(log.generated);
    return {at, keys:(log.events || []).filter(e => e && e.iata === id && Date.parse(e.t) > at - LATE).sort((a,b)=>Date.parse(b.t)-Date.parse(a.t)).slice(0,24).map(key)};
  }
  return {
    begin(now) { saved = read(now); baseline = {...saved}; },
    baseline(log, ids) { for (const id of ids) if (!baseline[id]) baseline[id] = snapshot(log, id); return baseline; },
    checkpoint(log, ids, now, dismiss = false) {
      const next = {...read(now)};
      for (const id of ids) {
        const x = snapshot(log, id);
        if (!next[id] || next[id].at <= x.at) next[id] = x;
        if (dismiss) baseline[id] = x;
      }
      saved = Object.fromEntries(Object.entries(next).sort((a,b)=>b[1].at-a[1].at).slice(0,96));
      try { storage.setItem(SEEN_KEY, JSON.stringify({v:1, airports:saved})); } catch { /* Memory-only when storage is unavailable. */ }
    }
  };
}

export function createSinceChecked(host, context, storage) {
  const visits = createVisits(storage), doc = host.ownerDocument;
  let expanded = false, signature = "", current = null;
  visits.begin(Date.now());
  const element = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  function visible() {
    return doc.visibilityState === "visible" && !doc.getElementById("navAirports")?.hidden && !(window.AWXSheet?.openCount?.() > 0);
  }
  function acknowledge(dismiss = false) {
    if (!current || !visible()) return;
    if (!dismiss && !host.hidden) {
      const r = host.getBoundingClientRect(), head = doc.querySelector(".head")?.getBoundingClientRect().bottom || 0;
      if (r.top < Math.max(0, head) || r.bottom > innerHeight - 80) return;
    }
    visits.checkpoint(current.log, current.ids, Date.now(), dismiss);
  }
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) acknowledge();
  }, {threshold:[0, 0.25, 1]}) : null;
  observer?.observe(host);
  function render() {
    const c = context(), now = Date.now();
    const generated = Date.parse(c?.log?.generated);
    if (!c || c.blocked || c.failed || c.log?.error || !Array.isArray(c.log?.events) || !Number.isFinite(generated) || generated > now + 60000 || now - generated > 30 * 60e3) {
      current = null; host.hidden = true; signature = ""; return;
    }
    const ids = [...new Set(c.ids)].filter(id => /^[A-Z0-9]{3,4}$/.test(id));
    const baseline = visits.baseline(c.log, ids);
    const items = selectChanges(c.log, ids, baseline, now).filter(e => !c.hidden(e));
    current = {...c, ids};
    if (!items.length) { host.hidden = true; signature = ""; if (visible()) acknowledge(); return; }
    const limited = ids.some(id => baseline[id]?.at < Math.max(Date.parse(c.log.since) || 0, now - 36 * HOUR));
    const nextSignature = JSON.stringify([items.map(e=>[e.iata,key(e),c.text(e)]), expanded, limited]);
    host.hidden = false;
    if (signature !== nextSignature) {
      signature = nextSignature;
      const header = element("div", "since-head"), title = element("h2", "", "Since you last checked"), dismiss = element("button", "since-dismiss", "Dismiss");
      dismiss.type = "button"; dismiss.addEventListener("click", () => { acknowledge(true); expanded = false; render(); });
      header.append(title, dismiss);
      const list = element("ul", "since-list");
      for (const e of items.slice(0, expanded ? items.length : 3)) {
        const li = element("li"), row = element("button", "since-row"), code = element("b", "since-code", e.iata);
        row.type = "button"; row.append(code, element("span", "since-text", c.text(e)), element("span", "since-arrow", "›"));
        row.setAttribute("aria-label", `${e.iata}: ${c.text(e)}. Open airport overview`);
        row.addEventListener("click", () => c.open(e.iata)); li.append(row); list.append(li);
      }
      host.replaceChildren(header, list);
      if (items.length > 3) {
        const more = element("button", "since-more", expanded ? "Show fewer" : `${items.length - 3} more changes ›`);
        more.type = "button"; more.setAttribute("aria-expanded", String(expanded)); more.addEventListener("click", () => {expanded = !expanded; render();}); host.append(more);
      }
      const note = element("p", "since-note", limited ? "Available changes cover only the recorded history, up to 36 hours." : "Reported changes · tap an airport for its current outlook");
      host.append(note);
    }
    // Re-renders may happen while an already-visible panel receives a fresh log.
    const r = host.getBoundingClientRect();
    if (visible() && r.top >= 0 && r.bottom <= innerHeight) acknowledge();
  }
  function resume() { if (doc.visibilityState === "visible") { visits.begin(Date.now()); expanded = false; signature = ""; render(); } }
  doc.addEventListener("visibilitychange", resume);
  doc.addEventListener("awx:trips", render);
  return {render};
}
