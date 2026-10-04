// Terminal maps (terminals hook): pure helpers for tools/build-terminals.mjs and its tests.
// One Overpass query per airport returns the airport's terminal buildings, gates, runways and lounges from
// OpenStreetMap; this file turns that reply into the compact site/data/terminals/<IATA>.json the page draws.
// Coordinates are local metres from the airport's reference point (x east, y north), so the drawing is
// north-up with no projection code in the browser. Data © OpenStreetMap contributors (ODbL).

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const SIMPLIFY_M = 5; // Douglas-Peucker tolerance, metres
export const MIN_TERMINAL_M2 = 300; // smaller building=terminal pieces (kiosks, canopies) are left out
export const GATE_TERMINAL_M = 400;
export const PIECE_JOIN_M = 150; // an unnamed terminal piece this close to a named terminal is part of it // a gate further than this from every terminal is grouped by its letter only
const R = 6371008.8;

/**
 * The Overpass QL for one airport: the aerodrome (way or relation, matched on its IATA or ICAO tag) becomes the
 * search area; inside it terminals (aeroway or building), gates, runways and lounges, with inline geometry.
 */
export function buildQuery(ap, timeout = 60) {
  const iata = String(ap.iata).replace(/[^A-Z0-9]/gi, "");
  const icao = String(ap.icao || "").replace(/[^A-Z0-9]/gi, "");
  const ad = [`wr["aeroway"="aerodrome"]["iata"="${iata}"];`];
  if (icao) ad.push(`wr["aeroway"="aerodrome"]["icao"="${icao}"];`);
  return [
    `[out:json][timeout:${timeout}];`,
    `(${ad.join("")})->.ad;`,
    `.ad map_to_area->.a;`,
    `(`,
    `  wr(area.a)["aeroway"="terminal"];`,
    `  wr(area.a)["building"="terminal"];`,
    `  node(area.a)["aeroway"="gate"];`,
    `  way(area.a)["aeroway"="runway"];`,
    `  nwr(area.a)["amenity"="lounge"];`,
    `  nwr(area.a)["aeroway"="lounge"];`,
    `)->.f;`,
    `.ad out tags center;`,
    `.f out geom qt;`,
  ].join("\n");
}

/** Local equirectangular projection around [lat, lon]: metres east/north. Good to well under 1 m over an airport. */
export function projector(lat0, lon0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const toXY = (lat, lon) => [((lon - lon0) * Math.PI / 180) * R * k, ((lat - lat0) * Math.PI / 180) * R];
  const toLL = (x, y) => [lat0 + (y / R) * 180 / Math.PI, lon0 + (x / (R * k)) * 180 / Math.PI];
  return { toXY, toLL };
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline of [x, y] (iterative, keeps both ends). */
export function simplifyLine(pts, tol = SIMPLIFY_M) {
  if (!Array.isArray(pts) || pts.length < 3) return (pts || []).slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let max = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > max) { max = d; idx = k; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * A closed ring: split at the point farthest from the first so Douglas-Peucker has two real ends, then rejoin.
 * Returns the ring without the repeated closing point, or [] when it collapses below a triangle.
 */
export function simplifyRing(ring, tol = SIMPLIFY_M) {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return [];
  let far = 0, fd = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  const a = simplifyLine(pts.slice(0, far + 1), tol);
  const b = simplifyLine(pts.slice(far).concat([pts[0]]), tol);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : [];
}

export function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}
export function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringDist(p, r) {
  if (pointInRing(p, r)) return 0;
  let d = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(p, r[j], r[i]));
  return d;
}
function centroid(r) {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

/** Join way pieces (arrays of [x, y]) end to end into closed rings (multipolygon outers). Unclosable pieces are dropped. */
export function joinRings(pieces) {
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const left = pieces.filter((p) => p && p.length >= 2).map((p) => p.slice());
  const rings = [];
  while (left.length) {
    let cur = left.shift();
    let grew = true;
    while (!same(cur[0], cur[cur.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = cur[cur.length - 1];
        if (same(end, p[0])) cur = cur.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

/** The concourse letter(s) a gate ref starts with: "C12" → "C", "G 1" → "G", "12" → null. */
export function gateLetter(ref) {
  const m = /^\s*([A-Z]{1,2})[\s-]?\d/i.exec(String(ref || ""));
  return m ? m[1].toUpperCase() : null;
}
/** Normalise what someone types: "gate b 12" → "B12". */
export function normGate(s) {
  return String(s || "").toUpperCase().replace(/^\s*GATE\s*/, "").replace(/[\s-]+/g, "");
}

const round = (v) => Math.round(v);
const rpt = (p) => [round(p[0]), round(p[1])];
const nameOf = (t) => (t && (t.name || t["name:en"] || t.ref && (/^\d+$/.test(t.ref) ? "Terminal " + t.ref : t.ref))) || null;

/**
 * Overpass JSON → the page's terminal file. ap: an airports.json entry. Tolerant: unknown elements are skipped,
 * and an empty or partial reply still gives a well-formed object (with ok:false and a reason when nothing usable).
 */
export function parseOverpass(json, ap, opts = {}) {
  const tol = opts.tol ?? SIMPLIFY_M;
  const els = (json && Array.isArray(json.elements)) ? json.elements.filter((e) => e && typeof e === "object") : [];
  const ad = els.find((e) => e.tags && e.tags.aeroway === "aerodrome");
  const lat0 = ad && ad.center ? ad.center.lat : ap.lat;
  const lon0 = ad && ad.center ? ad.center.lon : ap.lon;
  const P = projector(lat0, lon0);
  const geomXY = (g) => (Array.isArray(g) ? g.filter((n) => n && Number.isFinite(n.lat) && Number.isFinite(n.lon)).map((n) => P.toXY(n.lat, n.lon)) : []);
  const seen = new Set();
  const terminals = [], gatesRaw = [], runways = [], lounges = [];

  for (const e of els) {
    if (!e || !e.tags || e === ad) continue;
    const key = e.type + e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = e.tags;
    const isTerm = t.aeroway === "terminal" || t.building === "terminal";
    const isLounge = t.amenity === "lounge" || t.aeroway === "lounge";
    if (isLounge) {
      let p = null;
      if (e.type === "node" && Number.isFinite(e.lat)) p = P.toXY(e.lat, e.lon);
      else if (e.center) p = P.toXY(e.center.lat, e.center.lon);
      else if (e.geometry) { const g = geomXY(e.geometry); if (g.length) p = centroid(g); }
      else if (e.members) { const g = e.members.flatMap((m) => geomXY(m.geometry)); if (g.length) p = centroid(g); }
      if (p) lounges.push({ name: t.name || "Lounge", ...(t.operator ? { op: t.operator } : {}), x: round(p[0]), y: round(p[1]) });
      if (!isTerm) continue;
    }
    if (t.aeroway === "gate" && e.type === "node" && Number.isFinite(e.lat)) {
      const ref = String(t.ref || t.name || "").trim();
      if (ref) gatesRaw.push({ ref, p: P.toXY(e.lat, e.lon) });
      continue;
    }
    if (t.aeroway === "runway" && e.type === "way") {
      const g = geomXY(e.geometry);
      if (g.length < 2) continue;
      let line;
      const closed = g.length > 3 && Math.hypot(g[0][0] - g[g.length - 1][0], g[0][1] - g[g.length - 1][1]) < 1;
      if (closed) { // runway mapped as an area: its longest span
        let best = -1;
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
          const d = Math.hypot(g[i][0] - g[j][0], g[i][1] - g[j][1]);
          if (d > best) { best = d; line = [g[i], g[j]]; }
        }
      } else line = simplifyLine(g, tol);
      runways.push({ ...(t.ref ? { ref: t.ref } : {}), line: line.map(rpt) });
      continue;
    }
    if (isTerm) {
      let rings = [];
      if (e.type === "way") { const g = geomXY(e.geometry); if (g.length >= 4) rings = [g]; }
      else if (e.type === "relation" && Array.isArray(e.members)) {
        rings = joinRings(e.members.filter((m) => m.type === "way" && (m.role === "outer" || m.role === "")).map((m) => geomXY(m.geometry)));
      }
      rings = rings.map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 3 && ringArea(r) >= MIN_TERMINAL_M2);
      if (!rings.length) continue;
      terminals.push({ name: nameOf(t), aeroway: t.aeroway === "terminal", rings: rings.map((r) => r.map(rpt)) });
    }
  }

  // An unnamed building=terminal that sits inside a named aeroway=terminal is the same building twice: drop it.
  const named = terminals.filter((x) => x.name);
  const terms = terminals.filter((x) => x.name || !named.some((n) => n.rings.some((r) => pointInRing(centroid(x.rings[0]), r))));
  terms.sort((a, b) => ringArea(b.rings[0]) - ringArea(a.rings[0]));
  // Unnamed pieces (concourse fingers mapped as building=terminal) belong to the nearest named terminal within
  // PIECE_JOIN_M of any of their corners; gates in them are grouped under that terminal.
  for (const x of terms) {
    if (x.name) { x.of = x.name; continue; }
    let bd = Infinity;
    for (const n of named) {
      const d = Math.min(...x.rings[0].map((p) => Math.min(...n.rings.map((r) => ringDist(p, r)))));
      if (d < bd) { bd = d; x.of = d <= PIECE_JOIN_M ? n.name : null; }
    }
  }

  // Gates: the terminal they're in (or nearest within GATE_TERMINAL_M), then the concourse letter of their ref.
  const termOf = (p) => {
    let best = -1, bd = Infinity;
    terms.forEach((x, i) => {
      const d = Math.min(...x.rings.map((r) => ringDist(p, r)));
      if (d < bd) { bd = d; best = i; }
    });
    return bd <= GATE_TERMINAL_M ? best : -1;
  };
  const groups = [];
  const gIdx = new Map();
  const gates = [];
  const refSeen = new Set();
  for (const g of gatesRaw.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }))) {
    const k = normGate(g.ref);
    if (refSeen.has(k)) continue; // the same gate mapped twice
    refSeen.add(k);
    const ti = termOf(g.p);
    const tname = ti >= 0 ? terms[ti].of || null : null;
    const L = gateLetter(g.ref);
    const gname = L ? "Concourse " + L : tname || "Other gates";
    const gk = gname + "|" + (L ? "" : tname || "");
    if (!gIdx.has(gk)) { gIdx.set(gk, groups.length); groups.push({ name: gname, terminal: tname, gates: [] }); }
    const gi = gIdx.get(gk);
    groups[gi].gates.push(g.ref);
    if (tname && !groups[gi].terminal) groups[gi].terminal = tname;
    gates.push({ ref: g.ref, x: round(g.p[0]), y: round(g.p[1]), g: gi });
  }

  const pts = [...terms.flatMap((x) => x.rings.flat()), ...gates.map((g) => [g.x, g.y]), ...lounges.map((l) => [l.x, l.y])];
  const bbox = pts.length ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : null;
  const out = {
    v: 1, iata: ap.iata, origin: [Math.round(lat0 * 1e6) / 1e6, Math.round(lon0 * 1e6) / 1e6],
    osmBase: (json && json.osm3s && json.osm3s.timestamp_osm_base) || null,
    aerodrome: !!ad, bbox,
    terminals: terms.map((x) => ({ name: x.name, ...(x.of && !x.name ? { of: x.of } : {}), rings: x.rings })),
    groups, gates, runways, lounges,
    attribution: "© OpenStreetMap contributors", license: "ODbL", licenseUrl: "https://www.openstreetmap.org/copyright",
  };
  out.ok = terms.length > 0 || gates.length > 0;
  if (!out.ok) out.why = !els.length ? "empty reply" : !ad ? "aerodrome not found in OpenStreetMap" : "no terminals or gates mapped";
  if (json && typeof json.remark === "string" && /error/i.test(json.remark)) { out.ok = false; out.why = json.remark.slice(0, 160); }
  return out;
}

/** The content that matters for "changed?": everything except the OSM timestamp. */
export function contentKey(t) {
  if (!t) return "";
  const { osmBase, ...rest } = t;
  return JSON.stringify(rest);
}
