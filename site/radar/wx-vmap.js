// Copied from Tyler's weather site (github.com/tylerbridges/tylerbridges.github.io, wx-vmap.js at commit
//   d4f012bd19231412be944e30a3ac8a2e9f8fa97b) unchanged: the radar card's base map (site/radar/card.js). Tiles from
//   OpenFreeMap (© OpenMapTiles, data © OpenStreetMap contributors); the credit is shown under the map.
//
// Vector base map for the Radar tab: OpenStreetMap vector tiles (OpenMapTiles schema, served free by OpenFreeMap)
//   decoded in the browser and drawn on canvas at the screen's native resolution, so coastlines, state and county
//   lines, roads and place names stay sharp at every zoom. Dependency-free: a small protobuf reader decodes the
//   Mapbox Vector Tile format. wx-radar.js asks this module to draw the land/water layer under the radar and the
//   lines and labels over it; if the tiles can't be reached it keeps using its raster base map.
(function (root) {
  "use strict";
  var TILEJSON = "https://tiles.openfreemap.org/planet";
  var tmpl = null, maxz = 14, state = "idle", onReady = [], onTile = [];
  var tiles = new Map(), tick = 0;
  // tiles are fetched and decoded by a background worker (this same file) so decoding never stalls the map
  var INW = typeof document === "undefined", SELF = !INW && document.currentScript ? document.currentScript.src : null;

  // ---------- protobuf / Mapbox Vector Tile decoding ----------
  function Pbf(buf) { this.b = buf; this.p = 0; this.end = buf.length; }
  Pbf.prototype.varint = function () {
    var b = this.b, v = 0, s = 0, c;
    do { c = b[this.p++]; if (s < 28) v |= (c & 0x7f) << s; else v += (c & 0x7f) * Math.pow(2, s); s += 7; } while (c & 0x80);
    return v < 0 ? v + 4294967296 : v;
  };
  Pbf.prototype.svarint = function () { var n = this.varint(); return n % 2 === 1 ? (n + 1) / -2 : n / 2; };
  Pbf.prototype.bytes = function () { var n = this.varint(), s = this.p; this.p += n; return this.b.subarray(s, s + n); };
  Pbf.prototype.string = function () { var u = this.bytes(), s = ""; try { s = new TextDecoder().decode(u); } catch (e) { for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); } return s; };
  Pbf.prototype.skip = function (t) { if (t === 0) this.varint(); else if (t === 1) this.p += 8; else if (t === 2) this.p += this.varint(); else if (t === 5) this.p += 4; };
  Pbf.prototype.packed = function () { var n = this.varint(), end = this.p + n, out = []; while (this.p < end) out.push(this.varint()); return out; };
  function readValue(pb) {
    var end = pb.p + pb.varint(), v = null;
    while (pb.p < end) {
      var k = pb.varint(), f = k >> 3, t = k & 7;
      if (f === 1) v = pb.string();
      else if (f === 2) { v = new DataView(pb.b.buffer, pb.b.byteOffset + pb.p, 4).getFloat32(0, true); pb.p += 4; }
      else if (f === 3) { v = new DataView(pb.b.buffer, pb.b.byteOffset + pb.p, 8).getFloat64(0, true); pb.p += 8; }
      else if (f === 4 || f === 5) v = pb.varint();
      else if (f === 6) v = pb.svarint();
      else if (f === 7) v = !!pb.varint();
      else pb.skip(t);
    }
    return v;
  }
  // geometry → array of rings/lines/points, each a flat [x0, y0, x1, y1, …] in tile units (0..extent)
  function geom(cmds) {
    var out = [], cur = null, x = 0, y = 0, i = 0;
    while (i < cmds.length) {
      var c = cmds[i++], id = c & 7, n = c >> 3;
      if (id === 7) { if (cur && cur.length >= 2) cur.push(cur[0], cur[1]); continue; }
      for (var k = 0; k < n; k++) {
        var dx = cmds[i++], dy = cmds[i++]; x += (dx >>> 1) ^ -(dx & 1); y += (dy >>> 1) ^ -(dy & 1);
        if (id === 1) { cur = [x, y]; out.push(cur); } else if (cur) cur.push(x, y);
      }
    }
    // drop points closer than 3/4096 of the tile to the last kept one (well under a screen pixel at any zoom this
    //   tile is drawn at) — detailed borders and coastlines lose most of their points, with no visible change
    return out.map(function (r) {
      if (r.length <= 4) return new Int16Array(r);
      var o = [r[0], r[1]], lx = r[0], ly = r[1];
      for (var k = 2; k < r.length - 2; k += 2) { var px = r[k], py = r[k + 1]; if (Math.abs(px - lx) >= 3 || Math.abs(py - ly) >= 3) { o.push(px, py); lx = px; ly = py; } }
      o.push(r[r.length - 2], r[r.length - 1]);
      return new Int16Array(o); // compact, and cheap to hand over from the worker
    });
  }
  var WANT = { water: 1, waterway: 1, boundary: 1, transportation: 1, place: 1, water_name: 0 };
  function decode(buf) {
    var pb = new Pbf(new Uint8Array(buf)), layers = {};
    while (pb.p < pb.end) {
      var key = pb.varint();
      if (key >> 3 !== 3) { pb.skip(key & 7); continue; }
      var end = pb.p + pb.varint(), name = "", keys = [], vals = [], feats = [], ext = 4096;
      while (pb.p < end) {
        var k = pb.varint(), f = k >> 3;
        if (f === 1) name = pb.string();
        else if (f === 2) feats.push(pb.bytes());
        else if (f === 3) keys.push(pb.string());
        else if (f === 4) vals.push(readValue(pb));
        else if (f === 5) ext = pb.varint();
        else pb.skip(k & 7);
      }
      if (!WANT[name]) continue;
      layers[name] = { ext: ext, f: feats.map(function (fb) {
        var q = new Pbf(fb), tags = [], type = 0, g = [], props = {};
        while (q.p < q.end) { var kk = q.varint(), ff = kk >> 3; if (ff === 2) tags = q.packed(); else if (ff === 3) type = q.varint(); else if (ff === 4) g = q.packed(); else q.skip(kk & 7); }
        for (var i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
        return { t: type, p: props, g: geom(g) };
      }) };
    }
    return layers;
  }

  // ---------- tiles ----------
  function init(cb, tileCb) {
    // shared by the radar and the model maps: each registers its own callbacks
    if (tileCb && onTile.indexOf(tileCb) < 0) onTile.push(tileCb);
    if (state === "ok" || state === "fail") { if (cb) cb(state === "ok"); return; }
    if (cb) onReady.push(cb);
    if (state !== "idle") return;
    state = "loading";
    fetch(TILEJSON).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      tmpl = j && j.tiles && j.tiles[0]; maxz = Math.min(14, j.maxzoom || 14); if (!tmpl) throw 0;
      state = "ok"; onReady.forEach(function (f) { f(true); });
    }).catch(function () { state = "fail"; onReady.forEach(function (f) { f(false); }); });
  }
  var WK = null, wid = 0, wjobs = {};
  function worker() {
    if (WK !== null) return WK;
    WK = false; if (!SELF || typeof Worker === "undefined") return WK;
    try {
      WK = new Worker(SELF);
      WK.onmessage = function (ev) { var r = ev.data, cb = wjobs[r.id]; delete wjobs[r.id]; if (cb) cb(r.err ? null : r.L, r.err); };
      WK.onerror = function (ev) { ev.preventDefault(); WK.terminate(); WK = false; var js = wjobs; wjobs = {}; Object.keys(js).forEach(function (k) { js[k](null, "redo"); }); };
    } catch (x) { WK = false; }
    return WK;
  }
  function fetchTile(url, cb) {
    if (worker()) { var id = ++wid; wjobs[id] = function (L, err) { if (err === "redo") fetchTile(url, cb); else cb(L); }; WK.postMessage({ id: id, url: url }); return; }
    fetch(url).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (b) { cb(decode(b)); }).catch(function () { cb(null); });
  }
  function get(z, x, y, request) {
    var k = z + "/" + x + "/" + y, e = tiles.get(k);
    if (e) { e.t = ++tick; return e; }
    if (!request || state !== "ok") return null;
    e = { t: ++tick }; tiles.set(k, e);
    fetchTile(tmpl.replace("{z}", z).replace("{x}", x).replace("{y}", y), function (L) { if (L) { e.L = L; e.ok = true; onTile.forEach(function (f) { f(); }); } else e.err = true; });
    if (tiles.size > 400) { var all = Array.from(tiles.entries()).sort(function (a, b) { return a[1].t - b[1].t; }); for (var i = 0; i < 120; i++) tiles.delete(all[i][0]); }
    return e;
  }
  // Tiles at the view's own zoom (not one lower): OpenMapTiles only includes county lines from tile zoom 7, trunk
  //   roads from 7, primary from 8 and secondary from 9, so a coarser tile would drop them a whole zoom level early.
  //   Past zoom 7 tiles drop back one level (drawn at 512 px, about a quarter as many to draw); county lines and
  //   trunk roads are already in those, primary roads then show from zoom 9 and secondary from 10.
  function tileZoom(z) { var r = Math.round(z); return Math.max(0, Math.min(maxz, Math.max(r - 1, Math.min(7, r)))); }

  // ---------- styling ----------
  var PAL = {
    dark: { bg: "#000000", water: "#0f2033", waterway: "#1a3450", county: "rgba(255,255,255,.24)", state: "rgba(255,255,255,.78)", country: "rgba(255,255,255,.9)",
      road: [ "rgba(255,255,255,.58)", "rgba(255,255,255,.44)", "rgba(255,255,255,.32)", "rgba(255,255,255,.22)" ], text: "#ffffff", text2: "#dde3ea", text3: "#b4bcc6", halo: "rgba(0,0,0,.92)", stateText: "rgba(255,255,255,.62)" },
    light: { bg: "#f3f3f1", water: "#bfd3e6", waterway: "#a9c2da", county: "rgba(0,0,0,.2)", state: "rgba(0,0,0,.62)", country: "rgba(0,0,0,.75)",
      road: [ "rgba(0,0,0,.42)", "rgba(0,0,0,.32)", "rgba(0,0,0,.23)", "rgba(0,0,0,.16)" ], text: "#10161e", text2: "#26303c", text3: "#47525e", halo: "rgba(255,255,255,.95)", stateText: "rgba(0,0,0,.55)" }
  };

  // which roads show is mostly decided by what each tile zoom contains; only minor streets are held back
  function roadRank(c) { return c === "motorway" ? 0 : c === "trunk" || c === "primary" ? 1 : c === "secondary" ? 2 : c === "tertiary" || c === "minor" ? 3 : -1; }
  function roadMinZ(r) { return [0, 0, 0, 9.5][r]; }
  function roadWidth(r, z) { var b = [1.5, 1.15, 0.9, 0.75][r]; return b * Math.max(0.6, Math.min(3, Math.pow(1.3, z - 8))); }

  // Visit the loaded tile (or nearest loaded ancestor) for each visible tile slot, with a transform from tile
  //   units to device pixels and a clip to that slot. cb(layers, s, zt) draws; s = device px per tile unit.
  // draw one loaded tile's content into a slot rect (tile units → device pixels, clipped to the rect)
  function put(ctx, L, zt, x0, y0, x1, y1, ox, oy, s, cb) {
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.setTransform(s, 0, 0, s, ox, oy); cb(L, s, zt); ctx.restore();
  }
  // missing tile while zooming out: use its loaded children (two levels down) before falling back to an ancestor
  function kids(ctx, v, i, cb, lv) {
    var any = false, w = (v.x1 - v.x0) / 2, h = (v.y1 - v.y0) / 2;
    for (var b = 0; b < 2; b++) for (var a = 0; a < 2; a++) {
      var c = { z: v.z + 1, x0: v.x0 + a * w, y0: v.y0 + b * h, x1: v.x0 + (a + 1) * w, y1: v.y0 + (b + 1) * h }, ci = 2 * i + a, cj = 2 * v.j + b;
      var e = get(c.z, ci, cj, false);
      if (e && e.ok) { put(ctx, e.L, c.z, c.x0, c.y0, c.x1, c.y1, c.x0, c.y0, w / 4096, cb); any = true; }
      else if (lv > 1) { c.j = cj; if (kids(ctx, c, ci, cb, lv - 1)) any = true; }
    }
    return any;
  }
  function eachTile(ctx, slots, cb) {
    slots.forEach(function (v) {
      var i = ((v.i % v.n) + v.n) % v.n, e0 = get(v.z, i, v.j, true);
      if (!(e0 && e0.ok) && v.z < maxz && kids(ctx, v, i, cb, 2)) return;
      for (var d = 0; d <= 5 && v.z - d >= 0; d++) {
        var e = get(v.z - d, i >> d, v.j >> d, d === 0);
        if (!e || !e.ok) continue;
        var w = v.x1 - v.x0, ext = 4096, s = w * (1 << d) / ext;
        var ox = v.x0 - (i - ((i >> d) << d)) * w, oy = v.y0 - (v.j - ((v.j >> d) << d)) * w;
        put(ctx, e.L, v.z - d, v.x0, v.y0, v.x1, v.y1, ox, oy, s, cb);
        return;
      }
    });
  }
  // one path per style (all features batched): far fewer draw calls, and overlapping segments don't double up
  function add(ctx, g, close) { g.forEach(function (r) { ctx.moveTo(r[0], r[1]); for (var k = 2; k < r.length; k += 2) ctx.lineTo(r[k], r[k + 1]); if (close) ctx.closePath(); }); }
  function strokeAll(ctx, list) { if (!list.length) return; ctx.beginPath(); list.forEach(function (f) { add(ctx, f.g); }); ctx.stroke(); }

  // land and water, under the radar
  function drawBase(ctx, slots, o) {
    var P = o.dark ? PAL.dark : PAL.light;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = P.bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    eachTile(ctx, slots, function (L, s) {
      if (L.water) { ctx.fillStyle = P.water; ctx.beginPath(); L.water.f.forEach(function (f) { if (f.t === 3) add(ctx, f.g, true); }); ctx.fill(); }
      if (L.waterway && o.z >= 8) { ctx.strokeStyle = P.waterway; ctx.lineWidth = 1.2 * o.dpr / s; ctx.lineJoin = ctx.lineCap = "round"; strokeAll(ctx, L.waterway.f.filter(function (f) { return f.t === 2; })); }
    });
  }
  // county/state lines and roads over the radar, then place names
  function drawTop(ctx, slots, o) {
    var P = o.dark ? PAL.dark : PAL.light, z = o.z, d = o.dpr, places = [];
    eachTile(ctx, slots, function (L, s) {
      ctx.lineJoin = ctx.lineCap = "round";
      if (L.transportation && !o.placesOnly) {
        var by = [[], [], [], []];
        L.transportation.f.forEach(function (f) { var r = roadRank(f.p["class"]); if (f.t === 2 && r >= 0 && z >= roadMinZ(r) && f.p.brunnel !== "tunnel") by[r].push(f); });
        for (var r = 3; r >= 0; r--) { if (!by[r].length) continue; ctx.strokeStyle = P.road[r]; ctx.lineWidth = roadWidth(r, z) * d / s; strokeAll(ctx, by[r]); }
      }
      if (L.boundary && !o.placesOnly) {
        var bl = { 6: [], 4: [], 2: [] };
        L.boundary.f.forEach(function (f) { if (f.t === 2 && f.p.maritime !== 1 && f.p.maritime !== true && bl[+f.p.admin_level]) bl[+f.p.admin_level].push(f); });
        if (z >= 6.5) { ctx.strokeStyle = P.county; ctx.lineWidth = 0.8 * d / s; strokeAll(ctx, bl[6]); }
        ctx.strokeStyle = P.state; ctx.lineWidth = (z < 6 ? 1.1 : 1.5) * d / s; strokeAll(ctx, bl[4]);
        ctx.strokeStyle = P.country; ctx.lineWidth = 1.7 * d / s; strokeAll(ctx, bl[2]);
      }
      if (L.place) L.place.f.forEach(function (f) {
        if (f.t !== 1 || !f.g[0]) return;
        var m = ctx.getTransform(), x = (f.g[0][0] * m.a + m.e) / d, y = (f.g[0][1] * m.d + m.f) / d;
        places.push({ p: f.p, x: x, y: y });
      });
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return labels(ctx, places, P, z, d, o.w, o.h, o);
  }
  // place names: biggest places first, skipping any that would overlap one already placed; sizes grow gently with zoom
  var CLS = { state: 0, city: 1, town: 2, village: 3 };
  // o.placesOnly (official county map): no state names, each place gets a dot with its name beside it, names skip
  //   the boxes in o.avoid (the county numbers), o.classes limits which classes draw, o.text/o.halo override the palette;
//   returns the boxes taken (including o.avoid) so the caller can place more labels around them
  function labels(ctx, places, P, z, d, w, h, o) {
    o = o || {};
    var seen = {}, list = [];
    places.forEach(function (pl) {
      var c = pl.p["class"], name = pl.p["name:en"] || pl.p.name_en || pl.p.name; if (!name || CLS[c] == null) return;
      if (c === "state" && (z < 4 || z > 7.5 || o.placesOnly)) return;
      if (c === "town" && z < 7.5 || c === "village" && z < 9.5) return;
      if (o.classes && !o.classes[c]) return;
      var k = name + "|" + Math.round(pl.x / 60) + "|" + Math.round(pl.y / 60); if (seen[k]) return; seen[k] = 1;
      if (pl.x < -50 || pl.y < -20 || pl.x > w + 50 || pl.y > h + 20) return;
      list.push({ c: c, name: c === "state" ? String(pl.p.name_en || name).toUpperCase() : name, x: pl.x, y: pl.y, r: (CLS[c] * 100) + (+pl.p.rank || 50) - (pl.p.capital ? 20 : 0) });
    });
    list.sort(function (a, b) { return a.r - b.r; });
    var boxes = (o.avoid || []).slice(), zz = Math.max(4, Math.min(12, z)), dots = !!o.placesOnly;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    list.slice(0, 400).forEach(function (L) {
      var size = L.c === "state" ? 10.5 + (zz - 4) * 0.4 : L.c === "city" ? 12 + (zz - 5) * 0.5 : L.c === "town" ? 11.5 + (zz - 8) * 0.45 : 11 + (zz - 10) * 0.4;
      size = Math.min(L.c === "city" ? 17 : 15, size); if (dots) size *= 0.85;
      var wt = dots ? (L.c === "city" ? 500 : 400) : L.c === "city" ? 600 : L.c === "state" ? 600 : 500, sp = L.c === "state" ? 1.5 : 0;
      ctx.font = wt + " " + (size * d).toFixed(1) + "px -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif";
      if (sp && "letterSpacing" in ctx) ctx.letterSpacing = (sp * d) + "px";
      var tw = ctx.measureText(L.name).width / d, tx = dots ? L.x + 5 + tw / 2 : L.x, bx = { x0: tx - tw / 2 - 3, x1: tx + tw / 2 + 3, y0: L.y - size * 0.7, y1: L.y + size * 0.7 };
      if (dots) bx.x0 = L.x - 3.5;
      var hit = function (b) { for (var i = 0; i < boxes.length; i++) { var q = boxes[i]; if (b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0) return true; } return false; };
      if (hit(bx) && dots) { tx = L.x - 5 - tw / 2; bx = { x0: tx - tw / 2 - 3, x1: L.x + 3.5, y0: bx.y0, y1: bx.y1 }; } // try the left side
      if (hit(bx)) { if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"; return; }
      boxes.push(bx);
      ctx.strokeStyle = o.halo || P.halo; ctx.lineWidth = 3 * d; ctx.strokeText(L.name, tx * d, L.y * d);
      ctx.fillStyle = o.text ? o.text : L.c === "state" ? P.stateText : L.c === "city" ? P.text : L.c === "town" ? P.text2 : P.text3;
      ctx.fillText(L.name, tx * d, L.y * d);
      if (dots) { ctx.beginPath(); ctx.arc(L.x * d, L.y * d, 2.2 * d, 0, 2 * Math.PI); ctx.fill(); }
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    });
    return boxes;
  }

  if (INW) {
    root.onmessage = function (ev) {
      var m = ev.data;
      fetch(m.url).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (b) {
        var L = decode(b), tr = [];
        Object.keys(L).forEach(function (n) { L[n].f.forEach(function (f) { f.g.forEach(function (r) { tr.push(r.buffer); }); }); });
        root.postMessage({ id: m.id, L: L }, tr);
      }).catch(function () { root.postMessage({ id: m.id, err: true }); });
    };
    return;
  }
  // ask for tiles just off screen ahead of time ({ z, i, j, n } list, nearest first), so panning finds them loaded
  function prefetch(list) { if (state !== "ok") return; list.slice(0, 40).forEach(function (v) { if (v.z <= maxz) get(v.z, ((v.i % v.n) + v.n) % v.n, v.j, true); }); }
  root.WXVMap = { prefetch: prefetch, init: init, ok: function () { return state === "ok"; }, failed: function () { return state === "fail"; }, tileZoom: tileZoom, drawBase: drawBase, drawTop: drawTop, _decode: decode };
})(this);
