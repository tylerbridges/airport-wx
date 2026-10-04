// Radar engine for the airport sheet's radar card (site/radar/card.js). Copied from Tyler's weather site
//   (github.com/tylerbridges/tylerbridges.github.io, wx-radar.js at commit d4f012bd19231412be944e30a3ac8a2e9f8fa97b);
//   that repo's AGENTS.md "Radar tab" section describes how it works. Changes for embedding here:
//   - no device-location following (locate / back-to-place buttons, geolocation) and no colour-style toggle
//     (no localStorage); the legend is drawn by card.js
//   - opts.static (no pan/zoom: the card), opts.zoom, opts.recenter, opts.overlay (airport glyph + range rings on
//     the label layer), opts.onTime / opts.onNote (header "Updated", stale and backup notes), opts.one (newest scan
//     only: the check page), api.destroy() (stop workers, free tiles), api.home(), api.repaint(), api.palettes()
//   - data-theme "auto" follows the system (this app's prefs.js); downloaded scans in Cache API "awx-mrms-1"
//   - shared callbacks (vector map, resize, colour scheme) are registered once, so the host can move between the
//     card and the full-screen sheet
// The original description follows (MRMS from NOAA Open Data on AWS comes first; see AGENTS.md there).
//
// Radar tab: a small dependency-free slippy map drawn on three stacked canvases (base map, radar, labels).
//   Radar, first choice: NOAA MRMS (Multi-Radar Multi-Sensor, lower 48, 1 km, every 2 min) from NCEP's GeoServer:
//   quality-controlled base reflectivity plus MRMS precipitation type, requested as WMS tiles for 11 frames over the
//   last hour. Each pixel's colour is decoded back to its exact value using the layers' own legends (fetched as JSON),
//   then redrawn by type: rain in greens → yellow → red, snow in white → light blue → blue, hail cores magenta.
//   Fallback (if NCEP can't be reached or doesn't allow pixel access): the NWS NEXRAD N0Q mosaic from the Iowa
//   Environmental Mesonet, read back to dBZ from IEM's exact N0Q colour table and drawn in the rain palette (no type).
//   Radar is requested one zoom level coarser than the map and drawn with bilinear smoothing; frames crossfade.
//   Base map and labels: Esri Canvas (dark or light grey to match the theme).
(function (root) {
  "use strict";
  var TS = 256, MINZ = 3, MAXZ = 12, RMAX = 8, NF = 11, STEP = 5 * 60000;
  var IEM = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/";
  var META = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json";
  var OG = "https://opengeo.ncep.noaa.gov/geoserver/conus/", REF = "conus_bref_qcd", TYP = "conus_pcpn_typ";
  var ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  // this same file also runs as a background worker (decoding and smoothing radar tiles, storm-motion matching) so
  //   that heavy work never blocks drawing: INW is true inside the worker
  var INW = typeof document === "undefined", SELF = !INW && document.currentScript ? document.currentScript.src : null;
  var el, stage, cvB, cvR, cvL, cxB, cxR, cxL, ui = {}, W = 0, HH = 0, SW = 0, SH = 0, MG = 0, dpr = 1, rdpr = 1, ldpr = 1, on = false, opts = {};
  // rv: the view the canvases were last drawn at. While a finger moves the map, only a CSS transform on the canvas
  //   stage changes (composited by the browser at the display's full refresh rate); the canvases are redrawn when the
  //   gesture ends or the stage's spare margin runs out.
  //   Each layer keeps its own drawn view (RV.B base, RV.R radar, RV.L lines+labels) and its own transform, so when
  //   the margin runs low the layers are redrawn on separate frames (never all three at once), well before the edge
  //   shows. `rv` points at the view being drawn right now.
  var RV = { B: { x: 0.5, y: 0.5, z: 7 }, R: { x: 0.5, y: 0.5, z: 7 }, L: { x: 0.5, y: 0.5, z: 7 } }, rv = RV.R, redraws = 0;
  function at(v, fn) { var o = rv; rv = v; try { return fn(); } finally { rv = o; } }
  var view = { x: 0.5, y: 0.5, z: 7 }, home = null;
  var cache = new Map(), tick = 0, corsOK = null, style = "smooth";
  var frames = null, pending = null, cur = NF - 1, frac = 0, playing = false, ph = 0, userPaused = false;
  var need = 0, raf = 0, lastT = 0, refreshT = 0, LAYERS = [];

  // ---------- projection (web mercator, x/y in 0..1) ----------
  function mx(lon) { return (lon + 180) / 360; }
  function my(lat) { var s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
  function scale() { return TS * Math.pow(2, view.z); }
  function rscale() { return TS * Math.pow(2, rv.z); }
  function dark() {
    // this app's prefs.js writes "auto" | "light" | "dark" (auto = follow the system)
    var t = document.documentElement.getAttribute("data-theme");
    return t === "dark" || t === "light" ? t === "dark" : !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  // ---------- palettes ----------
  // NWS reflectivity colours (dBZ → rgb), used to read a served tile back to dBZ: each pixel is projected onto this
  //   colour ramp and takes the dBZ of the nearest point on it.
  var NWS = [[5, 4, 233, 231], [10, 1, 159, 244], [15, 3, 0, 244], [20, 2, 253, 2], [25, 1, 197, 1], [30, 0, 142, 0], [35, 253, 248, 2],
    [40, 229, 188, 0], [45, 253, 149, 0], [50, 253, 0, 0], [55, 212, 0, 0], [60, 188, 0, 0], [65, 248, 0, 253], [70, 152, 84, 198], [75, 253, 253, 253]];
  // display palettes by precipitation type: dBZ, r, g, b, alpha (the lightest returns fade in)
  //   rain follows the NWS/RadarScope breakpoints: greens to 34, yellow from 35, orange from 45, red from 50,
  //   dark red from 55, magenta from 60 (moderate-to-heavy bands used to stay dark green until 40)
  var RAIN = [[10, 120, 214, 120, 0], [15, 120, 214, 120, 0.5], [20, 76, 190, 88, 0.76], [25, 40, 165, 64, 0.86], [30, 22, 132, 52, 0.92],
    [34, 18, 118, 48, 0.93], [35, 246, 214, 52, 0.95], [40, 255, 176, 40, 0.97], [45, 255, 128, 32, 0.98], [50, 236, 58, 40, 1],
    [55, 178, 18, 40, 1], [60, 222, 44, 196, 1], [70, 255, 222, 255, 1]];
  var SNOW = [[5, 236, 246, 255, 0.32], [10, 236, 246, 255, 0.58], [18, 196, 226, 255, 0.8], [26, 132, 188, 250, 0.91], [33, 78, 138, 238, 0.96], [42, 44, 88, 206, 1]];
  var HAIL = [[30, 22, 132, 52, 0.94], [34, 18, 118, 48, 0.95], [35, 246, 214, 52, 0.97], [45, 255, 128, 32, 0.98], [50, 236, 58, 40, 1], [55, 178, 18, 40, 1], [58, 222, 44, 196, 1], [70, 255, 222, 255, 1]];
  var MINDBZ = 10; // below this is mostly clutter and drizzle-level noise: not drawn in the smooth style
  function pack(c) { return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3] * 255)]; }
  function ramp(P, v) {
    if (v <= P[0][0]) return P[0].slice(1);
    for (var i = 1; i < P.length; i++) if (v <= P[i][0]) {
      var a = P[i - 1], b = P[i], t = (v - a[0]) / (b[0] - a[0]);
      return a.slice(1).map(function (x, k) { return x + (b[k + 1] - x) * t; });
    }
    return P[P.length - 1].slice(1);
  }
  // colour → value along a colour ramp [[value, r, g, b], …]: the value at the nearest point on the ramp, or null
  //   when no ramp colour is within `tol` (map furniture, missing-data grey)
  function project(P, r, g, b, tol) {
    var best = 1e9, v = null;
    if (P.length === 1) { var q = P[0]; best = (r - q[1]) * (r - q[1]) + (g - q[2]) * (g - q[2]) + (b - q[3]) * (b - q[3]); v = q[0]; }
    for (var i = 1; i < P.length; i++) {
      var a = P[i - 1], c = P[i], vx = c[1] - a[1], vy = c[2] - a[2], vz = c[3] - a[3], L = vx * vx + vy * vy + vz * vz || 1;
      var t = Math.max(0, Math.min(1, ((r - a[1]) * vx + (g - a[2]) * vy + (b - a[3]) * vz) / L));
      var dx = r - (a[1] + vx * t), dy = g - (a[2] + vy * t), dz = b - (a[3] + vz * t), d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; v = a[0] + (c[0] - a[0]) * t; }
    }
    return best <= tol * tol ? v : null;
  }
  function toDbz(r, g, b) { return project(NWS, r, g, b, 110); }
  // MRMS legends: reflectivity is a colour ramp (value → colour, interpolated); precipitation type is exact colours
  //   per class. Built from GeoServer's JSON legend so the decoding matches NCEP's own styling exactly.
  var REFP = null, TYPC = null;
  function hex(c) { c = String(c || "").replace("#", ""); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function entries(j) {
    var out = [];
    (function walk(o) { if (!o || typeof o !== "object") return; if (Array.isArray(o.entries) && o.entries.length && o.entries[0].color) { out = out.concat(o.entries); return; } Object.keys(o).forEach(function (k) { walk(o[k]); }); })(j);
    return out;
  }
  function typeOf(label, q) {
    var t = String(label || "").toLowerCase();
    if (/no ?precip|no ?coverage|missing|none/.test(t) || q === 0 || q < 0) return null;
    if (/snow/.test(t) || q === 3) return "s";
    if (/hail/.test(t) || q === 7) return "h";
    return "r";
  }
  var LREF = new Map(), LTYP = new Map();
  function refDbz(r, g, b) { var k = (r << 16) | (g << 8) | b, v = LREF.get(k); if (v === undefined) { v = project(REFP, r, g, b, 40); LREF.set(k, v); } return v; }
  function typAt(r, g, b) {
    var k = (r << 16) | (g << 8) | b, v = LTYP.get(k);
    if (v === undefined) { var best = 1e9; v = null; TYPC.forEach(function (c) { var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]); if (d < best) { best = d; v = c[3]; } }); if (best > 30 * 30) v = null; LTYP.set(k, v); }
    return v;
  }
  function mk(w, h) { if (INW) return new OffscreenCanvas(w, h); var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  var EMPTY = INW ? {} : mk(1, 1); // a tile with nothing to draw
  function pixels(im) {
    var c = mk(TS, TS);
    var x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0, TS, TS);
    return { c: c, x: x, d: x.getImageData(0, 0, TS, TS) }; // getImageData throws if the server doesn't allow CORS
  }
  // colour tables per type (index: dBZ×2, 0–99.5 dBZ) as packed RGBA words for direct writes into image data
  var PALS = null;
  function pal() {
    if (PALS) return PALS;
    var le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    PALS = [RAIN, RAIN, SNOW, HAIL].map(function (P) {
      var a = new Uint32Array(200);
      for (var i = 0; i < 200; i++) { var c = pack(ramp(P, i / 2)); a[i] = le ? ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 : ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0; }
      return a;
    });
    return PALS;
  }
  // Smooth rendering: decode every pixel to its value (dBZ) and type, then resample the value field at twice the
  //   resolution with bilinear interpolation and colour each output pixel from its value: smooth contour edges
  //   instead of blocky 1 km pixels, with colours that still come from the measured values. No extra blur: in a
  //   comparison against single-site NEXRAD Level II, blurring shaved storm cores (fewer 35+ dBZ areas shown) for no
  //   gain in average accuracy. Type is nearest-pixel.
  function smoothTile(im, dec, imT) {
    var R = pixels(im), p = R.d.data, q = imT ? pixels(imT).d.data : null, N = TS, LOW = MINDBZ - 12;
    var f = new Float32Array(N * N), ty = new Uint8Array(N * N), any = false;
    for (var i = 0, k = 0; k < N * N; k++, i += 4) {
      var z = p[i + 3] ? dec(p[i], p[i + 1], p[i + 2]) : null;
      f[k] = z == null ? LOW : Math.max(LOW, z); if (z != null && z >= MINDBZ - 4) any = true;
      if (z != null) { var t = q ? (q[i + 3] ? typAt(q[i], q[i + 1], q[i + 2]) : null) : "r"; ty[k] = t === "s" ? 2 : t === "h" ? 3 : 1; }
    }
    if (!any) return EMPTY; // nothing to draw (most tiles)
    var M = N * 2, c = mk(M, M);
    var h = f, x, y;
    var cx = c.getContext("2d"), out = cx.createImageData(M, M), d32 = new Uint32Array(out.data.buffer), L = pal();
    for (y = 0; y < M; y++) {
      var sy = Math.max(0, Math.min(N - 1.001, (y + 0.5) / 2 - 0.5)), y0 = sy | 0, fy = sy - y0;
      for (x = 0; x < M; x++) {
        var sx = Math.max(0, Math.min(N - 1.001, (x + 0.5) / 2 - 0.5)), x0 = sx | 0, fx = sx - x0, a = y0 * N + x0;
        var v = (h[a] * (1 - fx) + h[a + 1] * fx) * (1 - fy) + (h[a + N] * (1 - fx) + h[a + N + 1] * fx) * fy;
        if (v < MINDBZ) continue;
        var tk = ty[((sy + 0.5) | 0) * N + ((sx + 0.5) | 0)] || ty[a] || ty[a + 1] || ty[a + N] || ty[a + N + 1] || 1;
        d32[y * M + x] = L[tk][Math.min(199, (v * 2) | 0)];
      }
    }
    cx.putImageData(out, 0, 0); return c;
  }
  // MRMS: reflectivity tile + type tile → one smooth, type-coloured tile
  function compose(imR, imT) { return smoothTile(imR, refDbz, imT || null); }
  // IEM fallback: reflectivity only (read back from the NWS colour ramp), drawn in the rain palette
  // The IEM mosaic tiles use IEM's own 255-colour N0Q table (index i = -32 + (i-1)/2 dBZ, 0.5 dBZ steps; from
  //   mesonet.agron.iastate.edu/GIS/rasters.php?rid=2), not the 15-colour NWS ramp, so pixels are decoded against
  //   that exact table: an exact colour match, else the nearest table colour if it is close.
  var IEMP = "85718f85728f86738d87758b87768b887789897987897a878a7b858b7d848b7e848c7f828d81808d82808e837e8f847c8f857c90877b918879918979928b77938d759691539894579b975b9d9a60a09d64a3a068a5a36da8a671aaa976adac7ab0af7eb2b283b7b88cbabb90bdbe94bfc199c2c49dc4c7a2c7caa6cacdaaccd0afd2d4b4cfd2b4c9ccb4c6c9b4c3c7b4c0c4b4bdc1b4b9beb4b6bbb4b3b9b4b0b6b4adb3b4aab0b4a4abb4a0a8b49da5b49aa2b497a0b4949db4919ab4949bb59098b48c95b38892b2808cb07c89af7886ae7483ac7080ab6c7daa6779a96376a85f73a75b70a6576da44f67a24b64a14761a0435e9f415b9e4361a24568a6486faa4a76ae4d7db24f84b6518bbb5699c3599fc75ba6cb5eadcf60b4d462bbd865c2dc67c9e06ad0e46fd6e868d6d759d6b352d6a24bd69043d67e3cd66d35d65b11d51811d11710cd1710c81610c4160fbc150fb7140eb3140eaf130eab130da6120da2120d9e110c99110c95100c91100b880f0b840e0a800e0a7c0d0a770d09730c096f0c096b0b08660b08620a095e09327308467d085b88076f9207849d0698a806adb205c1bd05d6c704ead204ffe200ffd800ffd300ffce00ffc900ffc400ffc000ffbb00ffb600ffb100ffac00ffa700ffa200ff9900ff9400ff8f00ff8a00ff8500ff8000ff0000f80000f10000ea0000e30000d50000cd0000c60000bf0000b80000b10000aa0000a300009b00009400008d00007f0000780000710000fffffffff5ffffeaffffdfffffd4ffffc9ffffbeffffb3ffff9dffff92ffff75fffc6bfdf960faf656f7f34bf4f040f1ed36efea2bece720e9e10be3b200ffac00fca400f79b00f49300ef8800ea8300e87900e27200dd6900db05ecf005ebf005eaf005dde005dce005dbe005cdd005ccd004bdc004bcc004bbc004aeb004adb0049ea0049da0049ca0038e90038d90038c90037e80037d80036f70036e70036d70025f60025e60024f50024e50024d50023f40023e40023d40013030012f30012020011f20011e203a67b53a66b53a65b53a64b53a63b53a62b5";
  var LIEM = new Map(), IEMC = null;
  function iemDbz(r, g, b) {
    var k = (r << 16) | (g << 8) | b, v = LIEM.get(k);
    if (v !== undefined) return v;
    if (!IEMC) { IEMC = []; for (var i = 0; i < IEMP.length / 6; i++) { var c = parseInt(IEMP.substr(i * 6, 6), 16); IEMC.push([c >> 16, (c >> 8) & 255, c & 255, -32 + i / 2]); LIEM.set(c, -32 + i / 2); } v = LIEM.get(k); if (v !== undefined) return v; }
    var best = 1e9; v = null;
    IEMC.forEach(function (c) { var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]); if (d < best) { best = d; v = c[3]; } });
    if (best > 24 * 24) v = null; LIEM.set(k, v); return v;
  }
  // IEM's MRMS tiles (SeamlessHSR, NOAA's quality-controlled lowest-scan reflectivity: birds, insects and ground
  //   clutter removed) use IEM's gr2ae table: index i = -32 + i/2 dBZ (black = none, grey = missing). From IEM's
  //   scripts/mrms/mrms_lcref_comp.py and gr2ae.txt.
  var LCP = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a4a4ffa1a1fc9e9ef99a9af69797f29494ef9191ec8e8ee98a8ae68787e38484e08181dc7e7ed97a7ad67777d37474d07171cd6e6ec96a6ac66767c34080ff3e7df93d7af23b76ec3a73e63870df366dd9356ad33366cc3263c63060c02e5db92d5ab32b56ac2a53a62850a0264d99254a9323468d22438620408000f90000f20000ec0000e60000df0000d90000d30000cc0000c60000c00000b90000b30000ac0000a60000a000009900009300008d00008600008000fff900fff200ffec00ffe600ffdf00ffd900ffd300ffcc00ffc600ffc000ffb900ffb300ffac00ffa600ffa000ff9900ff9300ff8d00ff8600ff0000fa0000f50000f10000ec0000e70000e30000de0000d90000d40000cf0000cb0000c60000c10000bd0000b80000b30000ae0000aa0000a50000ff00fff900f9f200f2ec00ece600e6df00dfd900d9d300d3cc00ccc600c6c000c0b900b9b300b3ac00aca600a6a000a09900999300938d008d860086fffffff9f9f9f2f2f2ececece6e6e6dfdfdfd9d9d9d3d3d3ccccccc6c6c6c0c0c0b9b9b9b3b3b3acacaca6a6a6a0a0a09999999393938d8d8d868686808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080909090";
  var LLC = null;
  function lcrefDbz(r, g, b) {
    if (!LLC) { LLC = new Map(); for (var i = 86; i < 226; i++) LLC.set(parseInt(LCP.substr(i * 6, 6), 16), -32 + i / 2); }
    var v = LLC.get((r << 16) | (g << 8) | b); return v === undefined ? null : v;
  }
  function recolor(im, url) { return smoothTile(im, /mrms::lcref/.test(url || "") ? lcrefDbz : iemDbz, null); }

  // ---------- tiles ----------
  function get(key, url, radar) {
    var e = cache.get(key); if (e) { e.t = ++tick; return e; }
    e = { t: ++tick }; cache.set(key, e); load(e, url, radar, corsOK !== false && radar);
    if (cache.size > 900) { // drop the least recently drawn (room for the loop's tiles plus the ring around the view)
      var all = Array.from(cache.entries()).sort(function (a, b) { return a[1].t - b[1].t; });
      for (var i = 0; i < 200; i++) cache.delete(all[i][0]);
    }
    return e;
  }
  function load(e, url, radar, cors) {
    if (url && url.s3) return loadGT(e, url);
    if (radar && cors && workers()) return loadW(e, url);
    if (Array.isArray(url)) return loadMrms(e, url);
    var im = new Image(); im.decoding = "async"; if (cors) im.crossOrigin = "anonymous";
    im.onload = function () {
      e.raw = im;
      if (radar && !cors && e.corsFail) corsOK = false; // loads fine without CORS: the server just doesn't allow pixel access
      if (radar && cors) work(function () { try { e.sm = recolor(im, url); corsOK = true; } catch (x) { corsOK = false; } e.ok = true; soon(2); });
      else { e.ok = true; soon(radar ? 2 : 5); }
    };
    im.onerror = function () {
      if (cors) { e.corsFail = true; load(e, url, radar, false); return; }
      e.err = true; paint(0);
    };
    im.src = url;
  }
  // MRMS tile: reflectivity and type images, composed once both are in (a missing type tile just means "rain")
  function loadMrms(e, urls) {
    var ims = [null, null], left = 2;
    function done() {
      if (--left) return;
      if (!ims[0]) { e.err = true; paint(0); return; }
      e.raw = ims[0];
      work(function () { try { e.sm = compose(ims[0], ims[1]); corsOK = true; } catch (x) { corsOK = false; } e.ok = true; soon(2); });
    }
    urls.forEach(function (u, k) {
      var im = new Image(); im.crossOrigin = "anonymous"; im.decoding = "async";
      im.onload = function () { ims[k] = im; done(); }; im.onerror = done; im.src = u;
    });
  }
  // Background workers (2, this same script): fetch the tile(s), decode and smooth them and hand back ready-to-draw
  //   bitmaps, so a big rain shield or a refresh never stalls playback or panning. Without worker support (or if a
  //   worker fails) the same code runs here on the main thread in small slices.
  var WK = null, wkI = 0, wid = 0, wjobs = {};
  function workers() {
    if (WK !== null) return WK;
    WK = false;
    if (!SELF || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return WK;
    try { var nw = Math.max(2, Math.min(4, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2) - 1)); WK = []; for (var q = 0; q < nw; q++) WK.push(q); WK = WK.map(function () { var w = new Worker(SELF); w.onmessage = fromW; w.onerror = wFail; return w; }); cfgW(); } catch (x) { WK = false; }
    return WK;
  }
  function cfgW() { if (WK && REFP) WK.forEach(function (w) { w.postMessage({ cfg: { REFP: REFP, TYPC: TYPC } }); }); }
  function toWi(i, m, cb) { m.id = ++wid; wjobs[m.id] = { cb: cb, m: m }; WK[i % WK.length].postMessage(m); }
  function toW(m, cb, tr) { m.id = ++wid; wjobs[m.id] = { cb: cb, m: m }; WK[wkI++ % WK.length].postMessage(m, tr || []); }
  function fromW(ev) {
    var r = ev.data; if (r.loaded) { s3Got(r.loaded); return; }
    var j = wjobs[r.id]; if (!j) return; delete wjobs[r.id];
    if (r.nosupport) { wFail(); j.cb(null, true); return; }
    j.cb(r);
  }
  // a worker that can't run: stop using workers and redo whatever was waiting on them here
  function wFail(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!WK) return; WK.forEach(function (w) { w.terminate(); }); WK = false;
    var js = wjobs; wjobs = {}; Object.keys(js).forEach(function (k) { js[k].cb(null, true); });
  }
  function loadW(e, url) {
    var mrms = Array.isArray(url);
    toW({ kind: "tile", urls: mrms ? url : [url], mrms: mrms }, function (r, redo) {
      if (redo) return load(e, url, true, true);
      if (r.err) { if (mrms) { e.err = true; soon(0); } else { e.corsFail = true; load(e, url, true, false); } return; }
      e.raw = r.raw; e.sm = r.empty ? EMPTY : r.sm; corsOK = true; e.ok = true; soon(2);
    });
  }
  // tile arrivals repaint right away while the map is still; mid-gesture they're batched (a few per second at most)
  var soonT = 0, soonB = 0, dirty = 0;
  function soon(b) {
    if (!(pts.size || inertia || tween)) return paint(b);
    soonB |= b; if (!soonT) soonT = setTimeout(function () { soonT = 0; dirty |= soonB; soonB = 0; paint(0); }, 180);
  }
  // smoothing runs in small slices (~10 ms per turn) so a big rain shield never freezes scrolling or the map
  var jobs = [], jobT = 0;
  function work(fn) { jobs.push(fn); if (!jobT) jobT = setTimeout(runJobs, 0); }
  function runJobs() {
    var t0 = performance.now(); jobT = 0;
    while (jobs.length && performance.now() - t0 < 10) jobs.shift()();
    if (jobs.length) jobT = setTimeout(runJobs, 0);
  }
  function img(e) { return !e || !e.ok ? null : (style === "smooth" || frames && frames.src === "s3") && e.sm ? e.sm : e.raw; }
  function baseUrl(kind, z, x, y) { return ESRI + (dark() ? "World_Dark_Gray_" : "World_Light_Gray_") + kind + "/MapServer/tile/" + z + "/" + y + "/" + x; }
  var E = 20037508.342789244;
  function wms(layer, time, z, x, y) {
    var sz = 2 * E / Math.pow(2, z), x0 = -E + x * sz, y1 = E - y * sz;
    return OG + layer + "/ows?service=WMS&version=1.1.1&request=GetMap&layers=" + layer + "&styles=&format=image/png&transparent=true&srs=EPSG:3857" +
      "&width=256&height=256&bbox=" + [x0, y1 - sz, x0 + sz, y1].map(function (v) { return v.toFixed(1); }).join(",") + "&time=" + new Date(time).toISOString().replace(".000Z", "Z");
  }
  function radarUrl(f, k, z, x, y) {
    if (f.src === "s3") return { s3: true, t: f.times[k], z: z, x: x, y: y, v: boxVer };
    if (f.src === "mrms") return [wms(REF, f.times[k], z, x, y), wms(TYP, f.times[k], z, x, y)];
    if (f.src === "iemq") return IEM + "mrms::lcref-" + new Date(f.times[k]).toISOString().replace(/[-T:]/g, "").slice(0, 12) + "/" + z + "/" + x + "/" + y + ".png";
    return IEM + f.layers[k] + "/" + z + "/" + x + "/" + y + ".png?b=" + f.bucket;
  }

  // visible tile range at tile zoom zt: [{i, j, x0, y0, x1, y1}] in device pixels (edges rounded so tiles never overlap)
  function visible(zt, dp) {
    dp = dp || dpr; var n = Math.pow(2, zt), s = rscale(), out = [];
    var l = rv.x - SW / 2 / s, r = rv.x + SW / 2 / s, t = rv.y - SH / 2 / s, b = rv.y + SH / 2 / s;
    for (var j = Math.max(0, Math.floor(t * n)); j <= Math.min(n - 1, Math.floor(b * n)); j++)
      for (var i = Math.floor(l * n); i <= Math.floor(r * n); i++) {
        var px = function (wx) { return Math.round(((wx - rv.x) * s + SW / 2) * dp); }, py = function (wy) { return Math.round(((wy - rv.y) * s + SH / 2) * dp); };
        out.push({ i: i, j: j, n: n, z: zt, x0: px(i / n), y0: py(j / n), x1: px((i + 1) / n), y1: py((j + 1) / n) });
      }
    return out;
  }
  // draw one tile, or the nearest loaded ancestor's matching quarter while it loads
  // When zooming out, the coarser tiles usually aren't loaded yet but the sharper ones just shown are, so a missing
  //   tile is first rebuilt from its loaded children (two levels down), then from a loaded ancestor.
  function drawKids(ctx, v, getE, lv) {
    var i = ((v.i % v.n) + v.n) % v.n, any = false, wx = (v.x1 - v.x0) / 2, wy = (v.y1 - v.y0) / 2;
    for (var b = 0; b < 2; b++) for (var a = 0; a < 2; a++) {
      var c = { i: 2 * i + a, j: 2 * v.j + b, n: v.n * 2, z: v.z + 1, x0: v.x0 + a * wx, y0: v.y0 + b * wy, x1: v.x0 + (a + 1) * wx, y1: v.y0 + (b + 1) * wy };
      var im = img(getE(c.z, c.i, c.j, false));
      if (im === EMPTY) { any = true; continue; }
      if (im) { ctx.drawImage(im, 0, 0, im.width || im.naturalWidth, im.height || im.naturalHeight, c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0); any = true; }
      else if (lv > 1 && drawKids(ctx, c, getE, lv - 1)) any = true;
    }
    return any;
  }
  function drawTile(ctx, v, getE) {
    var i = ((v.i % v.n) + v.n) % v.n;
    for (var d = 0; d <= 4 && v.z - d >= 0; d++) {
      var e = getE(v.z - d, i >> d, v.j >> d, d === 0), im = img(e);
      if (!im && d === 0 && v.z < 12 && drawKids(ctx, v, getE, 2)) return true;
      if (!im) continue;
      if (im === EMPTY) return true;
      var sz = (im.width || im.naturalWidth) / (1 << d), sx = (i - ((i >> d) << d)) * sz, sy = (v.j - ((v.j >> d) << d)) * sz;
      ctx.drawImage(im, sx, sy, sz, sz, v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
      return true;
    }
    return false;
  }
  function lowGet(key, url) { var e = cache.get(key); if (e) return e; e = get(key, url, true); e.t = 0; return e; }
  function peek(key) { var e = cache.get(key); if (e) e.t = ++tick; return e; }
  function layerGet(kind) {
    var th = dark() ? "d" : "l";
    return function (z, x, y, request) { var k = kind + th + z + "/" + x + "/" + y; return request ? get(k, baseUrl(kind, z, x, y), false) : peek(k); };
  }
  function radarGet(f, k) {
    return function (z, x, y, request) { var key = rkey(f, k, z, x, y); return request === 2 ? lowGet(key, radarUrl(f, k, z, x, y)) : request ? get(key, radarUrl(f, k, z, x, y), true) : peek(key); };
  }
  function rkey(f, k, z, x, y) { return "r" + f.src + (f.src === "s3" ? boxVer + "|" + (f.flags[k] ? keyTime(f.flags[k]) : "") + "|" : "") + (f.times ? f.times[k] : f.bucket + ":" + k) + ":" + z + "/" + x + "/" + y; }
  function tz() { return Math.max(0, Math.min(16, Math.round(rv.z))); }
  // radar one level coarser than the map (smoother, and MRMS/NEXRAD mosaics are ~1 km anyway), native in NWS colours
  //   (MRMS from NOAA's archive is drawn from the exact 1 km grid, so it can be requested sharper when zoomed in)
  function rz() { var s3 = frames && frames.src === "s3"; return Math.max(MINZ, Math.min(s3 ? 10 : RMAX, Math.round(rv.z) - (style === "smooth" || s3 ? 1 : 0))); }

  // ---------- drawing ----------
  function paint(bits) { need |= bits == null ? 7 : bits; if (on && !raf) raf = requestAnimationFrame(frame); }
  // base map: the vector map (wx-vmap.js) when its tiles can be reached — pure black land in dark mode, sharp lines
  //   and text at any zoom — otherwise Esri's raster tiles
  var VM = root.WXVMap;
  function vec() { return VM && VM.ok(); }
  function drawBase() {
    if (vec()) { VM.drawBase(cxB, visible(VM.tileZoom(rv.z)), { dark: dark(), dpr: dpr, z: rv.z }); return; }
    cxB.setTransform(1, 0, 0, 1, 0, 0); cxB.fillStyle = dark() ? "#000" : "#f3f3f1"; cxB.fillRect(0, 0, cvB.width, cvB.height);
    if (VM && !VM.failed()) return; // vector map still starting up
    var g = layerGet("Base"); visible(tz()).forEach(function (v) { drawTile(cxB, v, g); });
  }
  function drawLabels() {
    cxL.setTransform(1, 0, 0, 1, 0, 0); cxL.clearRect(0, 0, cvL.width, cvL.height);
    if (vec()) VM.drawTop(cxL, visible(VM.tileZoom(rv.z), ldpr), { dark: dark(), dpr: ldpr, z: rv.z, w: SW, h: SH });
    else if (!VM || VM.failed()) { var g = layerGet("Reference"); visible(tz(), ldpr).forEach(function (v) { drawTile(cxL, v, g); }); }
    // the airport marker and range rings are drawn by the host page (opts.overlay) in device pixels:
    //   {x, y} = the airport, pxPerM = device pixels per metre at its latitude (web mercator), d = pixel ratio
    if (!home || !opts.overlay) return;
    var s = rscale(), d = ldpr, hx = home.x - rv.x; hx -= Math.round(hx);
    cxL.save();
    try { opts.overlay(cxL, { x: (hx * s + SW / 2) * d, y: ((home.y - rv.y) * s + SH / 2) * d, d: d, pxPerM: s * d / (40075016.686 * Math.cos(home.lat * Math.PI / 180)), dark: dark(), w: SW * d, h: SH * d }); }
    catch (e) { if (root.console) console.warn(e); }
    cxL.restore();
  }
  // two frames blended exactly: A at (1-f) and B at f with additive compositing = a linear crossfade
  function drawRadar() {
    cxR.globalCompositeOperation = "source-over"; cxR.globalAlpha = 1; cxR.clearRect(0, 0, cvR.width, cvR.height);
    if (!frames) return;
    cxR.imageSmoothingEnabled = true; cxR.imageSmoothingQuality = "high";
    var vs = visible(rz(), rdpr), a = cur, b = (cur + 1) % NF, f = playing || frac ? frac : 0;
    // motion-compensated in-between: frame A slides forward along the storms' motion while frame B slides in from
    //   behind, so echoes glide between radar scans instead of fading in and out in place
    var mv = b === a + 1 ? motionFor(a) : null, s = rscale() * rdpr, mx = mv ? mv.x * s : 0, my = mv ? mv.y * s : 0;
    cxR.globalCompositeOperation = "lighter";
    // per tile: crossfade only when both scans' tiles are in. If one is still loading, the other is drawn at full
    //   strength (no dip in brightness, which read as the radar pulsing); if neither, the shown scan's nearest
    //   loaded stand-in (children or ancestor) is drawn
    var ga = radarGet(frames, a), gb = radarGet(frames, b), have = function (g, v) { var im = img(g(v.z, ((v.i % v.n) + v.n) % v.n, v.j, false)); return !!im; };
    vs.forEach(function (v) {
      var wa = 1 - f, wb = f;
      if (wb > 0.001 && wa > 0.001) { var ha = have(ga, v), hb = have(gb, v); if (ha !== hb) { miss++; if (ha) { wa = 1; wb = 0; } else { wa = 0; wb = 1; } } }
      if (wa > 0.001) { cxR.globalAlpha = wa; drawTile(cxR, mx && f ? shift(v, mx * f, my * f) : v, ga); }
      if (wb > 0.001) { cxR.globalAlpha = wb; drawTile(cxR, mx && f ? shift(v, mx * (f - 1), my * (f - 1)) : v, gb); }
    });
    cxR.globalCompositeOperation = "source-over"; cxR.globalAlpha = 1;
  }
  var miss = 0; // tiles drawn from one scan only because the other wasn't loaded yet (tests)
  function shift(v, ox, oy) { return { i: v.i, j: v.j, n: v.n, z: v.z, x0: v.x0 + ox, y0: v.y0 + oy, x1: v.x1 + ox, y1: v.y1 + oy }; }

  // ---------- storm motion between consecutive frames ----------
  // For each pair of frames, the shift that best lines up their echoes (a coarse block match on a 1/6-scale copy of
  //   the view, refined to sub-cell with a parabola fit). Stored in world units, so it holds while panning nearby;
  //   recomputed for a new zoom level or area. Echo-free views get no motion (plain crossfade).
  var MV = {}, mvKey = "";
  function motionKey() { return frames ? frames.bucket + ":" + rz() + ":" + Math.round(rv.x * 16) + "," + Math.round(rv.y * 16) : ""; }
  function motionFor(k) { var e = MV[mvKey]; return e && e[k] ? e[k] : null; }
  function alphaGrid(f, k, C, gw, gh) {
    var c = mk(gw, gh);
    var x = c.getContext("2d", { willReadFrequently: true }), g = radarGet(f, k), q = 1 / (C * dpr);
    visible(rz()).forEach(function (v) { drawTile(x, { i: v.i, j: v.j, n: v.n, z: v.z, x0: v.x0 * q, y0: v.y0 * q, x1: v.x1 * q, y1: v.y1 * q }, g); });
    var d = x.getImageData(0, 0, gw, gh).data, a = new Uint8Array(gw * gh);
    for (var i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  // Search range covers storms up to ~160 km/h at any zoom: the range in grid cells grows as you zoom in, and a
  //   coarse-to-fine search keeps that cheap.
  var VMAX = 160 / 3.6; // m/s
  function gapMs(f, k) { return f.times ? f.times[k + 1] - f.times[k] : 5 * 60000; }
  function estimate(f, k, cb) {
    var C = 6, gw = Math.ceil(SW / C), gh = Math.ceil(SH / C), A, B, w = rscale();
    var cellM = C / w * 40075016 * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - 2 * rv.y))));
    var R = Math.max(5, Math.min(90, Math.ceil(VMAX * gapMs(f, k) / 1000 / cellM) + 1));
    try { A = alphaGrid(f, k, C, gw, gh); B = alphaGrid(f, k + 1, C, gw, gh); } catch (e) { return cb(null); }
    function done(m) { cb(m ? { x: m.x * C / w, y: m.y * C / w } : null); }
    if (workers()) toW({ kind: "sad", A: A, B: B, gw: gw, gh: gh, R: R }, function (r, redo) { done(redo ? sad(A, B, gw, gh, R) : r.mv); }, [A.buffer, B.buffer]);
    else done(sad(A, B, gw, gh, R));
  }
  // mean absolute difference between grid A and grid B shifted by (dx, dy)
  function mad(A, B, gw, gh, dx, dy) {
    var sum = 0, n = 0, y0 = Math.max(0, -dy), y1 = Math.min(gh, gh - dy), x0 = Math.max(0, -dx), x1 = Math.min(gw, gw - dx);
    for (var y = y0; y < y1; y++) { var ra = y * gw, rb = (y + dy) * gw + dx; for (var x = x0; x < x1; x++) { var d = A[ra + x] - B[rb + x]; sum += d < 0 ? -d : d; } n += x1 - x0; }
    return n > 0 ? sum / n : 1e9;
  }
  function half(A, gw, gh) {
    var w = gw >> 1, h = gh >> 1, o = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var i = 2 * y * gw + 2 * x; o[y * w + x] = (A[i] + A[i + 1] + A[i + gw] + A[i + gw + 1] + 2) >> 2; }
    return { A: o, w: w, h: h };
  }
  // best shift (in grid cells, sub-cell) between two alpha grids, or null when there's too little echo to tell or
  //   the best match sits at the edge of the search. Coarse-to-fine: halve the grids until the range is ≤ 6 cells,
  //   search that fully, then refine ±2 cells at each finer level.
  function sad(A, B, gw, gh, R) {
    var echo = 0; for (var i = 0; i < A.length; i++) if (A[i] > 40) echo++;
    if (echo < 60) return null;
    var L = [{ A: A, B: B, w: gw, h: gh }];
    while (R >> (L.length - 1) > 6 && L[L.length - 1].w > 40 && L[L.length - 1].h > 40) { var t = L[L.length - 1], a = half(t.A, t.w, t.h), b = half(t.B, t.w, t.h); L.push({ A: a.A, B: b.A, w: a.w, h: a.h }); }
    var top = L.length - 1, Rt = Math.ceil(R / (1 << top)), bx = 0, by = 0, best = 1e18, dx, dy, v;
    for (dy = -Rt; dy <= Rt; dy++) for (dx = -Rt; dx <= Rt; dx++) { v = mad(L[top].A, L[top].B, L[top].w, L[top].h, dx, dy); if (v < best) { best = v; bx = dx; by = dy; } }
    if (Math.abs(bx) === Rt || Math.abs(by) === Rt) return null; // at the edge of the search: not trustworthy
    for (var l = top - 1; l >= 0; l--) {
      var cx = bx * 2, cy = by * 2; best = 1e18;
      for (dy = cy - 2; dy <= cy + 2; dy++) for (dx = cx - 2; dx <= cx + 2; dx++) { v = mad(L[l].A, L[l].B, L[l].w, L[l].h, dx, dy); if (v < best) { best = v; bx = dx; by = dy; } }
    }
    function sub(m, c, p) { var den = m - 2 * c + p; return den > 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den))) : 0; }
    return { x: bx + sub(mad(A, B, gw, gh, bx - 1, by), best, mad(A, B, gw, gh, bx + 1, by)), y: by + sub(mad(A, B, gw, gh, bx, by - 1), best, mad(A, B, gw, gh, bx, by + 1)) };
  }
  // Storm motion changes slowly, so once every pair is measured: pairs that couldn't be measured take their
  //   neighbours' motion, then a median of three and a light 1-2-1 average remove outliers and speed jumps from
  //   one step to the next (the glide then keeps a steady pace through the loop).
  function settle(raw, n) {
    var v = raw.slice(0, n).map(function (m) { return m ? { x: m.x, y: m.y } : null; });
    if (!v.some(Boolean)) return v.map(function () { return { x: 0, y: 0 }; });
    for (var i = 0; i < n; i++) if (!v[i]) { var a = null, b = null; for (var j = i - 1; j >= 0; j--) if (raw[j]) { a = raw[j]; break; } for (j = i + 1; j < n; j++) if (raw[j]) { b = raw[j]; break; } v[i] = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: (a || b).x, y: (a || b).y }; }
    function med(q, c) { return q.map(function (m, i) { var s = [q[Math.max(0, i - 1)][c], m[c], q[Math.min(n - 1, i + 1)][c]].sort(function (p, r) { return p - r; }); return s[1]; }); }
    var mx = med(v, "x"), my = med(v, "y");
    return v.map(function (m, i) { var p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1); return { x: (mx[p] + 2 * mx[i] + mx[q]) / 4, y: (my[p] + 2 * my[i] + my[q]) / 4 }; });
  }
  function planMotion() {
    var key = motionKey(); if (!frames || !key || key === mvKey && MV[key]) return;
    mvKey = key; if (MV[key]) return;
    var f = frames, out = MV[key] = [], raw = [], left = f.n - 1;
    for (var k = 0; k < f.n - 1; k++) (function (k) { work(function () { if (frames === f && mvKey === key) at(RV.R, function () { estimate(f, k, function (m) {
      raw[k] = m; if (m) out[k] = m;
      if (--left === 0) settle(raw, f.n - 1).forEach(function (s, i) { out[i] = s; });
      if (mvKey === key) paint(2);
    }); }); }); })(k);
  }
  function frame(ts) {
    raf = 0; if (!on) return;
    var dt = lastT ? Math.min(0.1, (ts - lastT) / 1000) : 0; lastT = ts;
    if (playing) { advance(dt); need |= 2; }
    if (inertia) { stepInertia(dt); }
    if (tween) { stepTween(ts); }
    // Each layer shows its last drawing moved/scaled by a CSS transform until it is redrawn at the current view:
    //   right away for new content (need bits), when the gesture is over, or mid-gesture once its spare margin is
    //   half used. Stale layers are redrawn one per frame so no single frame does all the work. While playing, the
    //   radar is redrawn every frame anyway, so it simply follows the view.
    var gest = pts.size > 0 || inertia || tween, stale = 0, pick = null, worst = -1, sv = scale();
    LAYERS.forEach(function (L) {
      var v = RV[L.k], dx = view.x - v.x; dx -= Math.round(dx);
      var k = Math.pow(2, view.z - v.z), tx = -dx * sv, ty = (v.y - view.y) * sv, off = dx || view.y !== v.y || view.z !== v.z;
      L.tf = off ? "translate3d(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px,0) scale(" + k.toFixed(5) + ")" : "";
      if (dirty & L.b && !(need & L.b) && worst < 2) { worst = 2; pick = L; } // new tiles arrived mid-gesture
      if (!off) return;
      stale |= L.b;
      var use = Math.max(Math.abs(tx) + W / 2 * Math.abs(1 - k), Math.abs(ty) + HH / 2 * Math.abs(1 - k)) / MG + (k < 0.8 || k > 1.6 ? 1 : 0);
      if (need & L.b) return; // redrawn below anyway
      if ((!gest || use > 0.65) && use > worst) { worst = use; pick = L; }
    });
    if (pick) { need |= pick.b; dirty &= ~pick.b; if (worst < 2) redraws++; }
    if (need) {
      LAYERS.forEach(function (L) {
        if (!(need & L.b)) return;
        var v = RV[L.k]; v.x = view.x; v.y = view.y; v.z = view.z; L.tf = "";
        at(v, L.draw);
      });
      if (need & stale) { clearTimeout(moved.t); moved.t = setTimeout(preload, 120); }
      dirty &= ~need; need = 0; timeUi();
    }
    LAYERS.forEach(function (L) { if (L.c.style.transform !== L.tf) L.c.style.transform = L.tf; });
    checkPending();
    var left = LAYERS.some(function (L) { return L.tf; });
    if (playing || gest || left || dirty) raf = requestAnimationFrame(frame); else lastT = 0;
  }

  // ---------- frames and playback ----------
  // Second choice: NOAA's quality-controlled MRMS reflectivity as served by IEM (latest time from its JSON, then
  //   6-minute steps back; IEM keeps every even minute)
  var LCJ = "https://mesonet.agron.iastate.edu/data/gis/images/4326/mrms/lcref.json";
  function lcrefFrames() {
    return fetch(LCJ + "?b=" + Math.floor(Date.now() / 60000)).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var v = Date.parse(j && j.meta && j.meta.start_valid); if (!isFinite(v) || Date.now() - v > 30 * 60000) throw 0;
      v = Math.floor(v / 120000) * 120000; var times = [];
      for (var k = 10; k >= 0; k--) times.push(v - k * 6 * 60000);
      return { src: "iemq", n: times.length, times: times, valid: v, bucket: v };
    });
  }
  function iemFrames() {
    var bucket = Math.floor(Date.now() / STEP), layers = [], n = 11;
    for (var k = 0; k < n; k++) { var m = (n - 1 - k) * 5; layers.push("nexrad-n0q-900913" + (m ? "-m" + (m < 10 ? "0" : "") + m + "m" : "")); }
    var f = { src: "iem", n: n, bucket: bucket, layers: layers, valid: null, times: null };
    fetch(META + "?b=" + bucket).then(function (r) { return r.json(); }).then(function (j) {
      var v = Date.parse(j && j.meta && j.meta.valid); if (isFinite(v)) { f.valid = v; timeUi(); }
    }).catch(function () {});
    return f;
  }
  // MRMS frame times from the layer's WMS capabilities: the latest time and ~6-minute steps back over the last hour
  function mrmsTimes(xml) {
    var m = /<(?:Dimension|Extent)[^>]*name="time"[^>]*>([^<]+)</i.exec(xml); if (!m) return null;
    var all = [];
    m[1].trim().split(",").forEach(function (part) {
      var r = part.trim().split("/");
      if (r.length === 3) { var a = Date.parse(r[0]), b = Date.parse(r[1]), pm = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(r[2]), st = pm ? ((+pm[1] || 0) * 60 + (+pm[2] || 0)) * 60000 : 0; if (st) for (var t = b; t >= a && all.length < 2000; t -= st) all.push(t); }
      else { var t1 = Date.parse(r[0]); if (isFinite(t1)) all.push(t1); }
    });
    all = all.filter(isFinite).sort(function (a, b) { return a - b; }); if (!all.length) return null;
    var last = all[all.length - 1], pick = [];
    for (var k = 10; k >= 0; k--) {
      var want = last - k * 6 * 60000, best = null;
      all.forEach(function (t) { if (Math.abs(t - want) <= 3 * 60000 && (best == null || Math.abs(t - want) < Math.abs(best - want))) best = t; });
      if (best != null && pick.indexOf(best) < 0) pick.push(best);
    }
    return pick.length >= 2 ? pick : null;
  }
  // First choice: MRMS straight from NOAA's public archive on AWS (noaa-mrms-pds, open to browsers, ~2 min behind
  //   real time): SeamlessHSR (quality-controlled lowest clean scan: birds/insects/clutter removed) plus PrecipFlag
  //   for rain/snow/hail. The GRIB2 files are decoded in the background worker (PNG-packed grids) and tiles are drawn
  //   from the exact values — no colour decoding, no map server in between.
  var S3 = "https://noaa-mrms-pds.s3.amazonaws.com/";
  // NOAA runs the same product on five grids (first match wins; CONUS before the Caribbean for south Florida)
  var DOMS = [
    { k: "CONUS", ni: 7000, nj: 3500, lat0: 54.995, lon0: -129.995, d: 0.01 },
    { k: "ALASKA", ni: 5000, nj: 2200, lat0: 71.995, lon0: -175.995, d: 0.01 },
    { k: "HAWAII", ni: 2600, nj: 2200, lat0: 25.9975, lon0: -163.9975, d: 0.005 },
    { k: "CARIB", ni: 3000, nj: 1500, lat0: 24.995, lon0: -89.995, d: 0.01 },
    { k: "GUAM", ni: 2000, nj: 1800, lat0: 17.9975, lon0: 140.0025, d: 0.005 }];
  var dom = DOMS[0];
  function domFor(lat, lon) {
    for (var i = 0; i < DOMS.length; i++) { var D = DOMS[i], dl = ((lon - D.lon0) % 360 + 360) % 360; if (lat <= D.lat0 && lat >= D.lat0 - (D.nj - 1) * D.d && dl <= (D.ni - 1) * D.d) return D; }
    return null;
  }
  var s3OK = null, boxVer = 0, box = null, s3Why = "", wErr = "";
  function ymd(t) { return new Date(t).toISOString().slice(0, 10).replace(/-/g, ""); }
  function keyTime(k) { var m = /(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2/.exec(k); return m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2], +m[3], +m[4]) : NaN; }
  function s3List(prod, since) {
    var days = [ymd(since), ymd(Date.now())].filter(function (d, i, a) { return a.indexOf(d) === i; });
    return Promise.all(days.map(function (d) {
      var pre = prod + d + "/", name = prod.split("/")[1], sa = pre + "MRMS_" + name + "_" + (d === ymd(since) ? new Date(since).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-") : d + "-0000");
      return fetch(S3 + "?list-type=2&prefix=" + encodeURIComponent(pre) + "&start-after=" + encodeURIComponent(sa)).then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (x) { var out = [], re = /<Key>([^<]+)<\/Key>/g, m; while ((m = re.exec(x))) out.push(m[1]); return out; });
    })).then(function (ls) { return [].concat.apply([], ls).map(function (k) { return { k: k, t: keyTime(k) }; }).filter(function (o) { return isFinite(o.t); }).sort(function (a, b) { return a.t - b.t; }); });
  }
  function s3Frames() {
    if (s3OK === false) return Promise.reject();
    if (!workers()) { s3Why = "this browser can't run the background decoder"; return Promise.reject(); }
    if (typeof DecompressionStream === "undefined") { s3Why = "this browser can't unzip the files"; return Promise.reject(); }
    var since = Date.now() - 75 * 60000;
    // SeamlessHSR: the lowest clean scan at each spot (closest to a single radar's base scan). Against Level II it
    //   kept heavy cores the merged base product softened (40+ dBZ cores shown as 40+: 66% vs 0% south of Rochester,
    //   93% vs 82% near Oklahoma City) with the same bird/insect filtering.
    return Promise.all([s3List(dom.k + "/SeamlessHSR_00.00/", since), s3List(dom.k + "/PrecipFlag_00.00/", since)]).catch(function (e) { s3Why = "couldn't list NOAA's files"; throw e; }).then(function (L) {
      var R = L[0], F = L[1]; if (R.length < 5) { s3Why = "too few recent scans in NOAA's archive"; throw 0; }
      var last = R[R.length - 1].t, step = 6 * 60000, base = Math.floor(last / step) * step, pick = [];
      // the newest scan, then scans nearest to fixed 6-minute marks (stable across refreshes, so only new ones load)
      for (var k = 9; k >= 0; k--) {
        var want = base - k * step, b = null;
        R.forEach(function (o) { if (Math.abs(o.t - want) <= 3 * 60000 && o.t < last - 60000 && (!b || Math.abs(o.t - want) < Math.abs(b.t - want))) b = o; });
        if (b && (!pick.length || pick[pick.length - 1].t !== b.t)) pick.push(b);
      }
      pick.push(R[R.length - 1]);
      if (opts.one) pick = [R[R.length - 1]]; // the check page: the newest scan only
      // precipitation type for each scan; NOAA publishes it a couple of minutes after the reflectivity, so the newest
      //   scan may borrow the latest one up to 10 minutes older (type changes slowly) instead of having none
      var fl = pick.map(function (o) { var b = null; F.forEach(function (q) { if (q.t <= o.t + 60000 && o.t - q.t <= 10 * 60000 && (!b || q.t > b.t)) b = q; }); return b ? b.k : null; });
      if (pick.length < (opts.one ? 1 : 5)) throw 0;
      return { src: "s3", n: pick.length, times: pick.map(function (o) { return o.t; }), refs: pick.map(function (o) { return o.k; }), flags: fl, valid: last, bucket: last + ":" + fl[fl.length - 1] };
    });
  }
  // the worker keeps the sharp (0.01°) grid for a 16° box around the view and a 0.04° copy of the whole country
  function needBox() {
    var lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * view.y))) * 180 / Math.PI, lon = view.x * 360 - 180;
    if (box && Math.abs(lat - box.lat) < 4.5 && Math.abs(lon - box.lon) < 4.5) return false;
    box = { lat: lat, lon: lon, v: ++boxVer }; if (WK) WK.forEach(function (w) { w.postMessage({ grid: "box", box: box }); }); return true;
  }
  // frames are shared out between the workers (each decodes and draws its own), newest first. On a first load the
  //   newest scan downloads alone, so the current radar shows as soon as possible; the rest start once it's in.
  var s3W = {}, s3Have = {}, s3Wait = null;
  function s3Load(f) {
    needBox();
    var lists = WK.map(function () { return []; }), nt = f.times[f.n - 1];
    for (var i = f.n - 1, j = 0; i >= 0; i--, j++) { var w = s3W[f.times[i]] != null ? s3W[f.times[i]] : j % WK.length; s3W[f.times[i]] = w; lists[w].push({ t: f.times[i], ref: f.refs[i], flag: f.flags[i] }); }
    // every worker gets its list now (so tile requests wait for their frame instead of failing); on a first load
    //   the others hold their downloads until the newest scan is in
    var first = !Object.keys(s3Have).length;
    if (s3Wait) { clearTimeout(s3Wait.t); s3Wait = null; }
    WK.forEach(function (w, k) { w.postMessage({ grid: "load", base: S3, frames: lists[k], prune: k === 0, hold: first && k !== s3W[nt] }); });
    if (!first) return;
    var rest = function () { if (!s3Wait) return; clearTimeout(s3Wait.t); s3Wait = null; WK.forEach(function (w) { w.postMessage({ grid: "go" }); }); };
    s3Wait = { nt: nt, go: rest, t: setTimeout(rest, 4000) };
  }
  function s3Got(t) { s3Have[t] = 1; if (s3Wait && s3Wait.nt === t) s3Wait.go(); }
  function loadGT(e, u) {
    if (!WK) { e.err = true; soon(0); return; }
    toWi(s3W[u.t] || 0, { kind: "gtile", t: u.t, z: u.z, x: u.x, y: u.y, v: u.v }, function (r, redo) {
      if (redo || r.err) { if (r && r.msg) wErr = r.msg; e.err = true; soon(0); return; }
      e.sm = r.empty ? EMPTY : r.sm; e.raw = e.sm; corsOK = true; e.ok = true; soon(2);
    });
  }
  // try MRMS (needs NCEP to allow cross-origin reads: legends, capabilities and tile pixels); otherwise the IEM mosaic
  var mrmsOK = null;
  function mrmsFrames() {
    if (mrmsOK === false) return Promise.reject();
    var leg = function (l) { return fetch(OG + l + "/ows?service=WMS&request=GetLegendGraphic&format=application/json&layer=" + l).then(function (r) { if (!r.ok) throw 0; return r.json(); }); };
    return Promise.all([leg(REF), leg(TYP), fetch(OG + REF + "/ows?service=WMS&version=1.3.0&request=GetCapabilities&b=" + Math.floor(Date.now() / 120000)).then(function (r) { if (!r.ok) throw 0; return r.text(); })]).then(function (res) {
      var re = entries(res[0]).map(function (e) { var c = hex(e.color); return [parseFloat(e.quantity)].concat(c); }).filter(function (e) { return isFinite(e[0]); }).sort(function (a, b) { return a[0] - b[0]; });
      var te = entries(res[1]).map(function (e) { var c = hex(e.color); return c.concat(typeOf(e.label, parseFloat(e.quantity))); });
      var times = mrmsTimes(res[2]);
      if (re.length < 5 || !te.length || !times) throw 0;
      REFP = re; TYPC = te; LREF.clear(); LTYP.clear(); mrmsOK = true; cfgW();
      return { src: "mrms", n: times.length, times: times, valid: times[times.length - 1], bucket: times[times.length - 1] };
    }).catch(function (e) { mrmsOK = false; throw e; });
  }
  // checking: a check (or the new scans it found) is still coming in; upd: when the radar last refreshed
  var lastLoad = 0, checking = false, upd = 0, tickT = 0;
  var gen = 0; // bumped by destroy(): replies to an earlier load are dropped
  function loadFrames() {
    lastLoad = Date.now(); checking = true; timeUi();
    var g = gen;
    // the backups only cover the lower 48
    s3Frames().catch(function (e) { if (dom.k !== "CONUS") throw e; return mrmsFrames(); }).catch(function () { return iemqOK === false ? Promise.reject() : lcrefFrames(); }).catch(function () { if (dom.k !== "CONUS") throw 0; return iemFrames(); }).then(function (f) {
      if (g !== gen) return;
      if (ui.msg === "Radar couldn't load right now") ui.msg = ""; // an earlier failure has cleared up
      if (f.src === "s3") s3Load(f);
      if (!frames) { setFrames(f); preload(); paint(2); } else if (f.bucket !== frames.bucket || f.src !== frames.src) { pending = f; preload(); }
      if (!pending) { checking = false; upd = Date.now(); }
      legend(); plan(); timeUi();
    }).catch(function (e) { if (g !== gen) return; if (root.console && e && e.stack) console.warn(e); checking = false; lastR = 0; ui.msg = "Radar couldn't load right now"; status(statusText()); plan(60000); timeUi(); });
  }
  // Refresh as soon as new data exists. NOAA scans every 2 minutes and posts each one ~1 minute after its time
  //   (its precipitation type ~1.5 minutes after), so check right then and every 15 s until it shows up; other
  //   sources every 5 minutes.
  function plan(wait) {
    clearTimeout(refreshT); refreshT = 0; if (!on) return;
    var f = pending || frames, now = Date.now();
    if (wait == null) {
      if (f && f.src === "s3") {
        var t = f.times[f.n - 1], fk = f.flags[f.n - 1], at = [t + 2 * 60000 + 62000];
        if (!fk || keyTime(fk) !== t) at.push(t + 105000); // the newest scan's own type is still to come
        at = at.filter(function (x) { return x > now; });
        wait = at.length ? Math.min.apply(null, at) - now : now - t > 10 * 60000 ? 60000 : 15000;
      } else wait = Math.max(15000, lastLoad + STEP - now);
    }
    refreshT = setTimeout(function () { if (on && !pending) loadFrames(); else plan(15000); }, Math.max(1000, wait));
  }
  // phones pause timers in the background: catch up as soon as the page is back
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", function () { if (!document.hidden && on && refreshT) plan(1000); });
  function setFrames(f) { frames = f; NF = f.n; ui.range.max = NF - 1; if (cur > NF - 1 || !started) cur = NF - 1; }
  // request every frame's visible tiles so playback never waits on the network, then the same for a ring of tiles
  //   just beyond the screen (one tile all round, three ahead of a pan), so panning shows radar that is already
  //   drawn instead of filling in afterwards. No loading indicator: the map just keeps up.
  function preload() {
    if (frames && frames.src === "s3" && view.z >= 5.5 && needBox()) paint(2);
    var req = function (f, vs) {
      for (var q = 0; q < f.n; q++) { var k = (Math.min(cur, f.n - 1) + q) % f.n, g = radarGet(f, k); vs.forEach(function (v) { g(v.z, ((v.i % v.n) + v.n) % v.n, v.j, true); }); }
    };
    // the frames on screen first, then the rest of the loop in playback order
    [frames, pending].forEach(function (f) { if (f) req(f, at(view, function () { return visible(rz()); })); });
    // the ring waits until every frame's visible tiles are in (so it never delays what's on screen), and is asked
    //   for at low priority (first to be dropped from the cache); the rest of the loop gets it only while playing
    if (frames && at(view, function () { return readyIn(frames); }) >= 1) {
      var ring = at(view, function () { return around(rz()); }), k0 = Math.min(cur, frames.n - 1);
      for (var q = 0; q < (playing ? frames.n : 1); q++) { var g = radarGet(frames, (k0 + q) % frames.n); ring.forEach(function (v) { g(v.z, ((v.i % v.n) + v.n) % v.n, v.j, 2); }); }
    }
    if (vec() && VM.prefetch) VM.prefetch(at(view, function () { return around(VM.tileZoom(view.z)); }));
  }
  // tiles outside the stage: one ring all round plus two more on the side the map is moving towards, nearest first
  var dir = { x: 0, y: 0 }, lastV = null;
  function around(zt) {
    var n = Math.pow(2, zt), s = rscale(), out = [];
    var i0 = Math.floor((rv.x - SW / 2 / s) * n), i1 = Math.floor((rv.x + SW / 2 / s) * n), j0 = Math.floor((rv.y - SH / 2 / s) * n), j1 = Math.floor((rv.y + SH / 2 / s) * n);
    var L = i0 - (dir.x < 0 ? 3 : 1), R = i1 + (dir.x > 0 ? 3 : 1), T = j0 - (dir.y < 0 ? 3 : 1), B = j1 + (dir.y > 0 ? 3 : 1);
    var cx = rv.x * n + dir.x * 2, cy = rv.y * n + dir.y * 2;
    for (var j = Math.max(0, T); j <= Math.min(n - 1, B); j++)
      for (var i = L; i <= R; i++) if (i < i0 || i > i1 || j < j0 || j > j1) out.push({ i: i, j: j, n: n, z: zt, d: Math.hypot(i + 0.5 - cx, j + 0.5 - cy) });
    return out.sort(function (a, b) { return a.d - b.d; });
  }
  // share of the shown frame's ring tiles already loaded (check.html / tests)
  function ringReady() {
    var vs = at(view, function () { return around(rz()); }), n = 0, ok = 0, k = Math.min(cur, frames.n - 1);
    vs.forEach(function (v) { var e = peek(rkey(frames, k, v.z, ((v.i % v.n) + v.n) % v.n, v.j)); n++; if (e && (e.ok || e.err)) ok++; });
    return n ? ok / n : 1;
  }
  // which way the map is moving (in screens), so the ring reaches further that way
  function track() {
    var s = scale();
    if (lastV && Math.abs(lastV.z - view.z) < 0.01) {
      var dx = view.x - lastV.x; dx -= Math.round(dx);
      var px = dx * s, py = (view.y - lastV.y) * s;
      if (Math.abs(px) + Math.abs(py) > 2) dir = { x: Math.abs(px) > Math.abs(py) * 0.4 ? Math.sign(px) : 0, y: Math.abs(py) > Math.abs(px) * 0.4 ? Math.sign(py) : 0 };
    }
    lastV = { x: view.x, y: view.y, z: view.z };
  }
  // while a pan or zoom is under way: ask for what's coming at most every 220 ms, and once more when it stops
  var lastPre = 0;
  function ahead() {
    track(); var now = Date.now();
    if (now - lastPre > 220) { lastPre = now; preload(); }
  }
  function ready(f) { return at(RV.R, function () { return readyIn(f); }); }
  // share of every frame's tiles for the current view (rv) that are in
  function readyIn(f) {
    var vs = visible(rz()), n = 0, ok = 0;
    for (var k = 0; k < f.n; k++) vs.forEach(function (v) { var e = peek(rkey(f, k, v.z, ((v.i % v.n) + v.n) % v.n, v.j)); n++; if (e && (e.ok || e.err)) ok++; });
    return n ? ok / n : 1;
  }
  // if IEM's MRMS tiles turn out not to load at all, drop to the NEXRAD mosaic
  var iemqOK = null;
  function errAll(f) {
    var vs = at(RV.R, function () { return visible(rz()); }), n = 0, bad = 0;
    vs.forEach(function (v) { var e = peek(rkey(f, f.n - 1, v.z, ((v.i % v.n) + v.n) % v.n, v.j)); if (e && (e.ok || e.err)) { n++; if (e.err) bad++; } });
    return n > 0 && bad === n;
  }
  function checkPending() {
    if (frames && frames.src === "iemq" && !iemqOK && ready(frames) >= 1) { if (errAll(frames)) { iemqOK = false; setFrames(iemFrames()); preload(); paint(2); legend(); } else iemqOK = true; }
    // last resort: if even the unfiltered mosaic's tiles all fail, say so instead of a blank map with a running clock
    if (frames && frames.src === "iem" && ready(frames) >= 1 && errAll(frames) && !ui.msg) { checking = false; ui.msg = "Radar couldn't load right now"; }
    if (frames && frames.src === "s3" && !s3OK && ready(frames) >= 1) { if (errAll(frames)) { s3OK = false; s3Why = "couldn't decode NOAA's files" + (wErr ? " (" + wErr + ")" : ""); frames = null; loadFrames(); return; } else s3OK = true; }
    nowLine();
    if (pending && ready(pending) >= 1) { setFrames(pending); pending = null; checking = false; upd = Date.now(); paint(2); }
    var r = frames ? ready(frames) : 0;
    lastR = r; status(statusText());
    if (r >= 1) at(RV.R, planMotion);
    // once the view is complete, ask for the ring around it (preload skipped it while the view was still loading)
    if (r >= 1) { var rk = rz() + ":" + Math.floor(view.x * 64) + "," + Math.floor(view.y * 64) + ":" + playing + ":" + (frames && frames.bucket); if (rk !== ringK) { ringK = rk; preload(); } }
    if (r >= 1 && !playing && !userPaused && !started) { started = true; if (!reduced()) play(true); }
  }
  var started = false, outUS = false, lastR = 0, ringK = "";
  // no loading percentage: radar fills in as it arrives; only real problems get a message
  function statusText() { return ui.msg || (outUS ? "Radar isn't available for this location" : ""); }
  function reduced() { return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  // continuous playback: each step glides from one scan to the next over its whole duration (no hold, no jump);
  //   the latest frame holds, then fades back to the first
  var STEPD = 0.55, HOLD = 1.6, BACK = 0.35;
  // each step lasts in proportion to the real time between its scans, so storms move at a steady pace
  function stepDur(k) {
    var t = frames && frames.times; if (!t || k + 1 >= t.length) return STEPD;
    var g = (t[t.length - 1] - t[0]) / (t.length - 1); return g > 0 ? STEPD * Math.max(0.5, Math.min(2, (t[k + 1] - t[k]) / g)) : STEPD;
  }
  function advance(dt) {
    ph += dt;
    if (cur === NF - 1) { if (ph >= HOLD + BACK) { ph = 0; cur = 0; frac = 0; } else frac = ph > HOLD ? smooth((ph - HOLD) / BACK) : 0; return; }
    var d = stepDur(cur);
    if (ph >= d) { ph -= d; cur++; if (cur === NF - 1) { frac = 0; return; } d = stepDur(cur); }
    frac = Math.min(1, ph / d);
  }
  function play(p) {
    playing = p; ui.play.innerHTML = p ? '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
    ui.play.setAttribute("aria-label", p ? "Pause" : "Play");
    if (p) { ph = 0; frac = 0; if (cur === NF - 1) cur = 0; }
    paint(2);
  }
  function timeUi() {
    if (!ui.time) return;
    var pos = cur + frac, k = Math.round(pos) % NF;
    var rvv = String(+(pos > NF - 1 ? NF - 1 : pos).toFixed(2)); if (ui.range.value !== rvv) ui.range.value = rvv;
    var t = !frames ? null : frames.times ? frames.times[k] : frames.valid ? frames.valid - (NF - 1 - k) * 5 * 60000 : null;
    var ago = t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : (NF - 1 - k) * 5, abs = t ? fmt(t) : "";
    // RadarScope style: the shown scan's time, and under it when the radar last refreshed; both turn red when the
    //   newest scan is older than expected (NOAA's every 2 min, so 8 min; the backups every 5, so 16)
    var nt = !frames ? null : frames.times ? frames.times[frames.n - 1] : frames.valid;
    var late = !!nt && Date.now() - nt > (frames.src === "s3" ? 8 : 16) * 60000;
    var t2 = upd ? "Updated " + fmt(upd) : checking ? "Loading" : "";
    if (ui.t1.textContent !== abs) ui.t1.textContent = abs;
    if (ui.t2.textContent !== t2) ui.t2.textContent = t2;
    ui.time.classList.toggle("late", late); ui.time.classList.toggle("chk", checking);
    var ti = t ? (k === NF - 1 ? "Newest scan" : ago + " min before now") + (late ? " · radar is behind" : "") : ""; if (ui.time.title !== ti) ui.time.title = ti;
    if (opts.onTime) opts.onTime({ shown: t, newest: nt, upd: upd, updText: t2, checking: checking, late: late, failed: !!ui.msg });
  }
  function fmt(t) { return opts.fmtTime ? opts.fmtTime(t) : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  // what's on screen, in plain words, under the map: which source, how fresh, and (if a backup) why
  var nowTxt = "";
  function nowLine() {
    // normally silent; only speaks up when the radar is behind or a backup that can include non-weather echoes is on
    //   (this app: handed to opts.onNote, shown under the map)
    if (!opts.onNote || !frames) return;
    var t = frames.times ? frames.times[frames.n - 1] : frames.valid, ago = t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
    var h = "";
    if (frames.src === "iem") h = "Showing backup radar: some light echoes may not be precipitation.";
    if (ago != null && ago > 15) h = (h ? h + " " : "") + "Radar is running behind: newest scan " + (opts.fmtTime ? opts.fmtTime(t) : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) + " (" + ago + " min ago).";
    if (h === nowTxt) return; nowTxt = h; opts.onNote(h);
  }
  function status(t) { if (ui.stat && ui.stat.textContent !== t) { ui.stat.textContent = t; ui.stat.hidden = !t; } }

  // ---------- gestures ----------
  var pts = new Map(), g0 = null, inertia = null, tween = null, lastTap = 0, samples = [];
  function worldAt(sx, sy) { var s = scale(); return { x: view.x + (sx - W / 2) / s, y: view.y + (sy - HH / 2) / s }; }
  function zoomAt(sx, sy, z) {
    z = Math.max(MINZ, Math.min(MAXZ, z)); var w = worldAt(sx, sy); view.z = z;
    var s = scale(); view.x = w.x - (sx - W / 2) / s; view.y = w.y - (sy - HH / 2) / s; clampView();
  }
  function clampView() { view.y = Math.max(0.05, Math.min(0.95, view.y)); view.x = ((view.x % 1) + 1) % 1; }
  function moved() { paint(0); ahead(); clearTimeout(moved.t); moved.t = setTimeout(preload, 150); }
  function local(e) { var r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function gesture() {
    var p = Array.from(pts.values());
    if (p.length === 1) g0 = { n: 1, x: p[0].x, y: p[0].y, vx: view.x, vy: view.y };
    else if (p.length >= 2) g0 = { n: 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, m: { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }, z: view.z, w: null };
    if (g0 && g0.n === 2) g0.w = worldAt(g0.m.x, g0.m.y);
  }
  function wire() {
    var t = stage;
    t.addEventListener("pointerdown", function (e) {
      if (opts.static) return; // the card: not interactive (taps open the full-screen sheet)
      t.setPointerCapture(e.pointerId); var p = local(e); pts.set(e.pointerId, p); inertia = null; tween = null;
      if (pts.size === 1) { samples = [{ x: p.x, y: p.y, t: e.timeStamp }]; t._down = { x: p.x, y: p.y, t: e.timeStamp }; }
      gesture();
    });
    t.addEventListener("pointermove", function (e) {
      if (!pts.has(e.pointerId)) return; var p = local(e); pts.set(e.pointerId, p);
      var ps = Array.from(pts.values()), s = scale();
      if (g0 && g0.n === 1 && ps.length === 1) {
        view.x = g0.vx - (p.x - g0.x) / s; view.y = g0.vy - (p.y - g0.y) / s; clampView();
        samples.push({ x: p.x, y: p.y, t: e.timeStamp }); if (samples.length > 6) samples.shift();
      } else if (g0 && g0.n === 2 && ps.length >= 2) {
        var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), m = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
        view.z = Math.max(MINZ, Math.min(MAXZ, g0.z + Math.log2(d / g0.d))); var s2 = scale();
        view.x = g0.w.x - (m.x - W / 2) / s2; view.y = g0.w.y - (m.y - HH / 2) / s2; clampView();
      }
      moved();
    });
    function up(e) {
      if (!pts.has(e.pointerId)) return; var p = local(e), d0 = t._down; pts.delete(e.pointerId);
      if (pts.size === 0) {
        var tap = d0 && Math.hypot(p.x - d0.x, p.y - d0.y) < 8 && e.timeStamp - d0.t < 300;
        if (tap) { if (e.timeStamp - lastTap < 320) { zoomTo(p.x, p.y, Math.round(view.z) + 1); lastTap = 0; } else lastTap = e.timeStamp; }
        else if (g0 && g0.n === 1 && samples.length > 1) {
          var a = samples[0], b = samples[samples.length - 1], dt = Math.max(16, b.t - a.t);
          if (e.timeStamp - b.t < 80) { inertia = { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt }; paint(0); }
        }
        g0 = null; paint(0);
      } else gesture();
    }
    t.addEventListener("pointerup", up); t.addEventListener("pointercancel", up);
    t.addEventListener("wheel", function (e) {
      if (opts.static) return;
      e.preventDefault(); var p = local(e), k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0022;
      zoomAt(p.x, p.y, view.z - e.deltaY * k); moved();
    }, { passive: false });
  }
  function stepInertia(dt) {
    var ms = dt * 1000, s = scale(); view.x -= inertia.vx * ms / s; view.y -= inertia.vy * ms / s; clampView();
    var k = Math.exp(-ms / 260); inertia.vx *= k; inertia.vy *= k; ahead();
    if (Math.hypot(inertia.vx, inertia.vy) < 0.02) { inertia = null; preload(); }
  }
  function zoomTo(sx, sy, z) { tween = { sx: sx, sy: sy, z0: view.z, z1: Math.max(MINZ, Math.min(MAXZ, z)), t0: 0 }; paint(0); }
  function stepTween(ts) {
    if (!tween.t0) tween.t0 = ts; var t = Math.min(1, (ts - tween.t0) / (tween.fly ? 480 : 260));
    if (tween.fly) { var e = smooth(t), F = tween.fly, dx = F.x1 - F.x0; dx -= Math.round(dx); view.x = F.x0 + dx * e; view.y = F.y0 + (F.y1 - F.y0) * e; view.z = F.z0 + (F.z1 - F.z0) * e; clampView(); }
    else zoomAt(tween.sx, tween.sy, tween.z0 + (tween.z1 - tween.z0) * smooth(t));
    if (t >= 1) { tween = null; preload(); }
  }
  function flyTo(p, z) { tween = { fly: { x0: view.x, y0: view.y, z0: view.z, x1: p.x, y1: p.y, z1: z == null ? view.z : z }, t0: 0 }; inertia = null; paint(0); }
  // fly back to the airport at the opening zoom (the full-screen sheet's "airport" button)
  function goHome() { if (home) flyTo(home, opts.zoom || 8); }

  // ---------- setup ----------
  // registered once for the whole page (the host element can be rebuilt or moved between the card and the sheet)
  var RO = null, once = false;
  function onVmReady() { paint(7); }
  function onVmTile() { soon(5); }
  function build(host) {
    el = host; el.innerHTML =
      '<div class="rstage"><canvas class="rl rb"></canvas><canvas class="rl rr"></canvas><canvas class="rl rt"></canvas></div>' +
      '<div class="rstat" hidden></div>' +
      '<div class="rbar"><button type="button" class="rplay" aria-label="Play"></button><input type="range" class="rrange" min="0" max="' + (NF - 1) + '" step="0.01" value="' + (NF - 1) + '" aria-label="Radar time"><button type="button" class="rtime num" aria-label="Show the latest radar and check for new scans"><b></b><span></span></button></div>';
    stage = el.querySelector(".rstage"); var cs = el.querySelectorAll("canvas"); cvB = cs[0]; cvR = cs[1]; cvL = cs[2];
    cxB = cvB.getContext("2d"); cxR = cvR.getContext("2d"); cxL = cvL.getContext("2d");
    LAYERS = [{ k: "R", b: 2, c: cvR, draw: drawRadar, tf: "" }, { k: "B", b: 1, c: cvB, draw: drawBase, tf: "" }, { k: "L", b: 4, c: cvL, draw: drawLabels, tf: "" }];
    ui = { stat: el.querySelector(".rstat"), play: el.querySelector(".rplay"), range: el.querySelector(".rrange"), time: el.querySelector(".rtime"), t1: el.querySelector(".rtime b"), t2: el.querySelector(".rtime span"), msg: "" };
    ui.play.addEventListener("click", function () { userPaused = playing; play(!playing); started = true; });
    ui.range.addEventListener("input", function () { var v = +ui.range.value; playing && play(false); userPaused = true; started = true; cur = Math.min(NF - 1, Math.floor(v)); frac = v - cur; if (cur === NF - 1) frac = 0; paint(2); });
    // like RadarScope's product time: tap to jump to the newest scan and check for a newer one now
    ui.time.addEventListener("click", function () {
      if (opts.static) return;
      playing && play(false); userPaused = true; started = true; if (frames) { cur = NF - 1; frac = 0; } paint(2);
      if (on && !checking) loadFrames();
    });
    play(false); wire();
    if (!RO) RO = new ResizeObserver(function () { if (el) size(); });
    RO.disconnect(); RO.observe(el);
    if (once) return; once = true;
    if (VM) VM.init(onVmReady, onVmTile);
    if (root.matchMedia) root.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { paint(7); });
  }
  // the legend lives outside the map (card.js): tell it whether the shown source has precipitation type (snow)
  function legend() {
    var typed = !!(frames && (frames.src === "mrms" || frames.src === "s3"));
    if (opts.onLegend) opts.onLegend({ snow: typed, src: frames ? frames.src : null });
  }
  function size() {
    var r = el.getBoundingClientRect(); if (!r.width) return;
    // the stage is the view plus a spare margin on every side, so a drag shows already-drawn map until it is redrawn
    // map and radar at up to 2x; the lines-and-labels layer at the screen's full resolution (up to 3x) for sharp text
    // radar at 1.5x: the smoothed radar has about one source pixel per CSS pixel, so more only costs time per frame
    W = r.width; HH = r.height; dpr = Math.min(2, root.devicePixelRatio || 1); rdpr = Math.min(1.5, root.devicePixelRatio || 1); ldpr = Math.min(3, root.devicePixelRatio || 1); MG = Math.round(Math.max(W, HH) * 0.2);
    SW = W + 2 * MG; SH = HH + 2 * MG;
    stage.style.cssText = "left:" + -MG + "px;top:" + -MG + "px;width:" + SW + "px;height:" + SH + "px";
    ["B", "R", "L"].forEach(function (k) { RV[k].x = view.x; RV[k].y = view.y; RV[k].z = view.z; });
    cvB.width = Math.round(SW * dpr); cvB.height = Math.round(SH * dpr);
    cvR.width = Math.round(SW * rdpr); cvR.height = Math.round(SH * rdpr);
    cvL.width = Math.round(SW * ldpr); cvL.height = Math.round(SH * ldpr);
    paint(7); preload();
  }

  var api = {
    // show the radar in `host` centred on {lat, lon}; opts.fmtTime(ms) formats frame times in the location's zone,
    //   opts.zoom = the opening zoom (default 7), opts.recenter = go back to the location at that zoom
    show: function (host, loc, o) {
      opts = o || {};
      if (el !== host) build(host);
      var h = { x: mx(loc.lon), y: my(loc.lat), lat: loc.lat }, changed = !home || Math.abs(h.x - home.x) > 1e-6 || Math.abs(h.y - home.y) > 1e-6;
      home = h;
      if (changed || opts.recenter) { view.x = h.x; view.y = h.y; view.z = opts.zoom || 7; inertia = null; tween = null; }
      if (opts.static) { pts.clear(); g0 = null; inertia = null; }
      var D = domFor(loc.lat, loc.lon); outUS = !D;
      if (D && D !== dom) { // another NOAA grid (Alaska, Hawaii, Caribbean, Guam): start over on it
        dom = D; frames = null; pending = null; s3W = {}; s3Have = {}; box = null; boxVer++; s3OK = null; s3Why = "";
        if (workers()) WK.forEach(function (w) { w.postMessage({ grid: "dom", dom: D }); });
      }
      on = true; size();
      if (!frames || Math.floor(Date.now() / STEP) !== frames.bucket) loadFrames();
      else plan();
      // keeps "Updated" and the late colour current between scans
      clearInterval(tickT); tickT = setInterval(function () { timeUi(); nowLine(); }, 15000);
      legend(); timeUi(); paint(7);
    },
    hide: function () { on = false; playing && play(false); started = false; userPaused = false; clearTimeout(refreshT); clearInterval(tickT); if (raf) cancelAnimationFrame(raf); raf = 0; lastT = 0; pts.clear(); inertia = null; tween = null; },
    // tear everything down (the airport sheet closed): workers stopped (their downloads cancelled), tiles and
    //   decoded scans freed. Files already downloaded stay in the Cache API, so reopening only decodes them again.
    destroy: function () {
      api.hide();
      if (WK) WK.forEach(function (w) { w.terminate(); });
      gen++; WK = null; wjobs = {}; jobs = []; clearTimeout(jobT); jobT = 0; clearTimeout(soonT); soonT = 0; soonB = 0; dirty = 0;
      if (s3Wait) { clearTimeout(s3Wait.t); s3Wait = null; }
      cache.clear(); frames = null; pending = null; s3W = {}; s3Have = {}; box = null; boxVer++; MV = {}; mvKey = ""; ringK = "";
      s3OK = null; s3Why = ""; wErr = ""; mrmsOK = null; iemqOK = null; corsOK = null; upd = 0; checking = false; nowTxt = ""; lastR = 0;
      NF = 11; cur = NF - 1; frac = 0; dom = DOMS[0]; home = null; need = 0;
      if (RO) RO.disconnect();
      if (el) el.innerHTML = "";
      el = null; ui = {}; LAYERS = []; opts = {};
    },
    home: function () { goHome(); },
    repaint: function () { paint(7); legend(); timeUi(); },
    palettes: function () { return { RAIN: RAIN, SNOW: SNOW }; },
    covers: function (lat, lon) { return !!domFor(lat, lon); },
    refresh: function () { if (on) loadFrames(); },
    // for the live data check
    _state: function () { return { msg: ui.msg || "", on: on, why: s3Why, dom: dom.k, rvR: RV.R, rdpr: rdpr, SW: SW, SH: SH, times: frames && frames.times, refs: frames && frames.refs, flags: frames && frames.flags, s3OK: s3OK, box: box, wk: !!WK, mv: (MV[mvKey] || []).map(function (m) { return m ? [+(m.x * rscale()).toFixed(1), +(m.y * rscale()).toFixed(1)] : null; }), redraws: redraws, tf: cvL && cvL.style.transform, tfs: LAYERS.map(function (L) { return L.c.style.transform; }), src: frames && frames.src, mrmsOK: mrmsOK, corsOK: corsOK, frames: frames && frames.n, valid: frames && frames.valid, ready: frames ? ready(frames) : 0, ring: frames ? ringReady() : 0, miss: miss, view: view, playing: playing, cur: cur, frac: frac }; },
    _pal: function () { return pal(); },
    // radar values at [[lat, lon], …] for frame time t (default newest), as drawn; for the live accuracy check
    _probe: function (pts, t) {
      return new Promise(function (ok, no) {
        if (!frames || frames.src !== "s3" || !WK) return no(new Error("radar not on NOAA grids"));
        t = t || frames.times[frames.n - 1];
        toWi(s3W[t] || 0, { kind: "probe", t: t, pts: pts }, function (r, redo) { if (redo || !r || r.err) no(new Error(r && r.msg || "probe failed")); else ok(r.vals); });
      });
    }
  };
  if (!INW) { root.WXRadar = api; return; }
  // ---------- worker side ----------
  var can2d = false; try { can2d = !!new OffscreenCanvas(1, 1).getContext("2d"); } catch (x) {}
  function fetchBitmap(u) {
    return fetch(u, { mode: "cors", credentials: "omit" }).then(function (r) { if (!r.ok) throw 0; return r.blob(); })
      .then(function (b) { return createImageBitmap(b, { colorSpaceConversion: "none" }); });
  }
  // ----- MRMS grids from NOAA's archive (GRIB2, PNG-packed) -----
  var G = {}, GBOX = null, NI = 7000, NJ = 3500, LAT0 = 54.995, LON0 = -129.995, DEG = 0.01, FB = 1600, CS = 4;
  function gunzip(buf, fmt) { return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream(fmt))); }
  // GRIB2 → { R, E, D, png } (template 5.41: value = (R + X·2^E) / 10^D, X from a greyscale PNG)
  function grib(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), p = 16, out = {};
    function s16(o) { var v = dv.getUint16(o); return v & 0x8000 ? -(v & 0x7fff) : v; }
    while (p + 5 <= u8.length && !(u8[p] === 55 && u8[p + 1] === 55 && u8[p + 2] === 55 && u8[p + 3] === 55)) {
      var len = dv.getUint32(p), sec = u8[p + 4];
      if (sec === 3) { out.ni = dv.getUint32(p + 30); out.nj = dv.getUint32(p + 34); }
      if (sec === 5) { out.R = dv.getFloat32(p + 11); out.E = s16(p + 15); out.D = s16(p + 17); out.bits = u8[p + 19]; }
      if (sec === 7) out.png = u8.subarray(p + 5, p + len);
      p += len;
    }
    return out;
  }
  // PNG row unfiltering, one tight loop per filter type
  function unfilter(row, cur, prev, n, bpp) {
    var ft = row[0], x, a, b, c, p, pa, pb, pc;
    if (ft === 0) { for (x = 0; x < n; x++) cur[x] = row[x + 1]; }
    else if (ft === 1) { for (x = 0; x < bpp; x++) cur[x] = row[x + 1]; for (x = bpp; x < n; x++) cur[x] = (row[x + 1] + cur[x - bpp]) & 255; }
    else if (ft === 2) { for (x = 0; x < n; x++) cur[x] = (row[x + 1] + prev[x]) & 255; }
    else if (ft === 3) { for (x = 0; x < bpp; x++) cur[x] = (row[x + 1] + (prev[x] >> 1)) & 255; for (x = bpp; x < n; x++) cur[x] = (row[x + 1] + ((cur[x - bpp] + prev[x]) >> 1)) & 255; }
    else {
      for (x = 0; x < bpp; x++) cur[x] = (row[x + 1] + prev[x]) & 255;
      for (x = bpp; x < n; x++) {
        a = cur[x - bpp]; b = prev[x]; c = prev[x - bpp]; p = a + b - c;
        pa = p > a ? p - a : a - p; pb = p > b ? p - b : b - p; pc = p > c ? p - c : c - p;
        cur[x] = (row[x + 1] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
  }
  // stream-decode a greyscale PNG row by row (rows are unfiltered as they arrive; only two rows kept)
  function pngRows(png, onRow) {
    var dv = new DataView(png.buffer, png.byteOffset, png.byteLength), p = 8, w = 0, bpp = 1, idat = [], n = 0;
    while (p < png.length) {
      var len = dv.getUint32(p), type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
      if (type === "IHDR") { w = dv.getUint32(p + 8); bpp = png[p + 16] === 16 ? 2 : 1; }
      if (type === "IDAT") { idat.push(png.subarray(p + 8, p + 8 + len)); n += len; }
      p += 12 + len;
    }
    var stride = w * bpp, row = new Uint8Array(stride + 1), cur = new Uint8Array(stride), prev = new Uint8Array(stride), fill = 0, r = 0;
    var reader = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    function pump() {
      return reader.read().then(function (res) {
        if (res.done) return r;
        var c = res.value, i = 0;
        while (i < c.length) {
          var take = Math.min(c.length - i, stride + 1 - fill); row.set(c.subarray(i, i + take), fill); fill += take; i += take;
          if (fill === stride + 1) { unfilter(row, cur, prev, stride, bpp);
            onRow(r++, cur, bpp); var t = prev; prev = cur; cur = t; fill = 0;
          }
        }
        return pump();
      });
    }
    return pump();
  }
  // reflectivity → bytes q = (dBZ + 10)·2 (0 = none); type → 0 none, 1 rain, 2 snow, 3 hail
  function decodeRef(buf, fr) {
    var g = grib(buf), sc = Math.pow(2, g.E), dd = Math.pow(10, g.D), bx = GBOX, lut = new Uint8Array(65536), dl = new Float64Array(65536), L0 = Math.pow(10, -1);
    // dl = linear value above the no-echo floor (−10 dBZ), so cells without echo (most of the grid) add nothing
    for (var X = 0; X < 65536; X++) { var v = (g.R + X * sc) / dd; lut[X] = v < 0 ? 0 : v > 117 ? 254 : Math.round((v + 10) * 2); dl[X] = v > -10 ? Math.pow(10, Math.min(117, v) / 10) - L0 : 0; }
    // zoomed-out copy: each 4×4 block is the average of its reflectivity in linear units (what a 4 km pixel really
    //   contains). Taking the block maximum instead made rain areas ~15% too big and doubled the area of 40+ dBZ
    //   cores in a test against the full grid.
    var r0 = bx.r0, c0 = bx.c0, c1 = c0 + FB, fine = new Uint8Array(FB * FB), CW = NI >> 2, CH = NJ >> 2, acc = new Float64Array(CW * CH).fill(16 * L0);
    return pngRows(g.png, function (r, row) {
      var fo = (r - r0) * FB - c0, inF = r >= r0 && r < r0 + FB, co = (r >> 2) * CW;
      for (var c = 0; c < NI; c++) {
        var X = (row[2 * c] << 8) | row[2 * c + 1], d = dl[X];
        if (d === 0) continue;
        acc[co + (c >> 2)] += d;
        var q = lut[X]; if (q && inF && c >= c0 && c < c1) fine[fo + c] = q;
      }
    }).then(function () {
      var coarse = new Uint8Array(CW * CH);
      for (var i = 0; i < coarse.length; i++) { var db = 10 * Math.log10(acc[i] / 16); coarse[i] = db < -9.75 ? 0 : Math.min(254, Math.round((db + 10) * 2)); }
      fr.fine = fine; fr.coarse = coarse; fr.fbox = bx;
    });
  }
  function decodeFlag(buf, fr) {
    var g = grib(buf), bx = GBOX, r0 = bx.r0, c0 = bx.c0, c1 = c0 + FB, H = FB / 2, ft = new Uint8Array(H * H), CW = NI >> 2, ct = new Uint8Array(CW * (NJ >> 2));
    var lut = new Uint8Array(65536); for (var X = 0; X < 65536; X++) { var v = Math.round(g.R + X); lut[X] = v === 3 ? 2 : v === 7 ? 3 : v > 0 ? 1 : 0; }
    return pngRows(g.png, function (r, row, bpp) {
      var inF = r >= r0 && r < r0 + FB, fo = ((r - r0) >> 1) * H, top = (r & 3) === 0, co = (r >> 2) * CW, c, k;
      for (c = 0; c < NI; c++) {
        k = lut[bpp === 2 ? (row[2 * c] << 8) | row[2 * c + 1] : row[c]]; if (!k) continue;
        if (inF && c >= c0 && c < c1) ft[fo + ((c - c0) >> 1)] = k;
        if (top || ct[co + (c >> 2)] === 0) ct[co + (c >> 2)] = k; // any precipitation in the 4×4 block
      }
    }).then(function () { fr.ft = ft; fr.ct = ct; });
  }
  // NOAA's file names never change, so downloaded scans are kept for 2 hours (reopening only fetches new ones)
  var CK = "awx-mrms-1"; // this app's own copy (the weather site on the same origin keeps "wx-mrms-1")
  function getFile(url) {
    var net = function () { return fetch(url).then(function (r) { if (!r.ok) throw new Error("download failed (" + r.status + ")"); return r; }); };
    if (typeof caches === "undefined") return net();
    return caches.open(CK).then(function (c) {
      return c.match(url).then(function (r) { return r || net().then(function (r) { c.put(url, r.clone()).catch(function () {}); return r; }); });
    }, net);
  }
  function pruneFiles() {
    if (typeof caches === "undefined") return;
    caches.open(CK).then(function (c) { return c.keys().then(function (ks) { ks.forEach(function (q) { var t = keyTime(q.url); if (!(t > Date.now() - 2 * 3600000)) c.delete(q); }); }); }).catch(function () {});
  }
  function fetchGz(url) { return getFile(url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return gunzip(b, "gzip").arrayBuffer(); }).then(function (b) { return new Uint8Array(b); }); }
  // frames load one after another (newest first), so the current radar shows as soon as possible; downloads run
  //   ahead in their own chain, so the next file is already arriving while this one is being decoded
  function gridFrame(f, after, dlAfter) {
    var fr = G[f.t];
    if (fr) {
      // its precipitation type was borrowed from an older scan and its own has now been posted
      if (f.flag && fr.flagK !== f.flag) { fr.flagK = f.flag; fr.p = fr.p.then(function () { return fetchGz(f.base + f.flag); }).then(function (b) { fr.rawF = b; fr.reBox = null; return fr.fbox === GBOX ? decodeFlag(b, fr) : null; }, function () { return null; }).then(function () { return fr; }); }
      return fr;
    }
    fr = G[f.t] = { t: f.t, flagK: f.flag };
    fr.dl = (dlAfter || Promise.resolve()).then(function () { return Promise.all([fetchGz(f.base + f.ref), f.flag ? fetchGz(f.base + f.flag).catch(function () { return null; }) : null]); });
    fr.p = Promise.all([fr.dl, after]).then(function (r) { return r[0]; }).then(function (b) {
      fr.raw = b[0]; fr.rawF = b[1];
      return Promise.all([decodeRef(b[0], fr), b[1] ? decodeFlag(b[1], fr) : null]);
    }).then(function () { root.postMessage({ loaded: f.t }); return fr; });
    fr.p.catch(function (e) { delete G[f.t]; GERR[f.t] = String(e && e.message || e); });
    return fr;
  }
  var FR = {}, LASTK = {}, GERR = {}, GATE = null;
  function gtile(m) {
    var fr = G[m.t]; if (!fr) return Promise.reject();
    return fr.p.then(function () {
      if (fr.fbox === GBOX) return fr;
      // the view moved to a new area: re-decode the sharp grid for it from the kept file (once per area)
      if (fr.reBox !== GBOX) { fr.reBox = GBOX; fr.re = Promise.all([decodeRef(fr.raw, fr), fr.rawF ? decodeFlag(fr.rawF, fr) : null]); }
      return fr.re.then(function () { return fr; });
    }).then(function (fr) {
      var M = 512, n = Math.pow(2, m.z), c = new OffscreenCanvas(M, M), cx = c.getContext("2d"), img = cx.createImageData(M, M), d32 = new Uint32Array(img.data.buffer), L = pal(), any = false;
      var b = fr.fbox, CW = NI / CS, CH = NJ / CS, H = FB / 2, degPx = 360 / (n * M), useFine = degPx < 2 * DEG;
      var col = new Float64Array(M);
      for (var ox = 0; ox < M; ox++) col[ox] = (((m.x + (ox + 0.5) / M) / n) * 360 - 180 - LON0) / DEG;
      for (var oy = 0; oy < M; oy++) {
        var wy = (m.y + (oy + 0.5) / M) / n, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180 / Math.PI, gr = (LAT0 - lat) / DEG;
        if (gr < -1 || gr > NJ) continue;
        for (ox = 0; ox < M; ox++) {
          var gc = col[ox], v, tk, fx, fy, x0, y0, a, hasT = !!fr.ft;
          if (gc < -1 || gc > NI) continue;
          var lr = gr - b.r0, lc = gc - b.c0;
          if (useFine && lr >= 0 && lr < FB - 1 && lc >= 0 && lc < FB - 1) {
            y0 = lr | 0; x0 = lc | 0; fy = lr - y0; fx = lc - x0; a = y0 * FB + x0;
            v = ((fr.fine[a] * (1 - fx) + fr.fine[a + 1] * fx) * (1 - fy) + (fr.fine[a + FB] * (1 - fx) + fr.fine[a + FB + 1] * fx) * fy) / 2 - 10;
            tk = fr.ft ? fr.ft[(Math.round(lr) >> 1) * H + (Math.round(lc) >> 1)] : 1;
          } else {
            var cr = gr / CS - 0.375, cc = gc / CS - 0.375; if (cr < 0) cr = 0; if (cc < 0) cc = 0; if (cr > CH - 1.001) cr = CH - 1.001; if (cc > CW - 1.001) cc = CW - 1.001;
            y0 = cr | 0; x0 = cc | 0; fy = cr - y0; fx = cc - x0; a = y0 * CW + x0;
            v = ((fr.coarse[a] * (1 - fx) + fr.coarse[a + 1] * fx) * (1 - fy) + (fr.coarse[a + CW] * (1 - fx) + fr.coarse[a + CW + 1] * fx) * fy) / 2 - 10;
            tk = fr.ct ? fr.ct[Math.round(cr) * CW + Math.round(cc)] : 1;
          }
          // light snow is often only 5–10 dBZ: shown from 5 where NOAA's type grid says snow, rain from 10
          if (v < (tk === 2 ? 5 : MINDBZ)) continue;
          // weak echoes (under 20 dBZ) only where NOAA's precipitation-type grid says something is falling: in a
          //   check against 15 radars' dual-pol scans this removed most leftover bird/insect and blocked-beam echoes
          //   while keeping 98%+ of real precipitation (stronger echoes are always shown)
          if (v < 20 && hasT && !tk) continue;
          d32[oy * M + ox] = L[tk === 2 ? 2 : tk === 3 ? 3 : 1][Math.min(199, (v * 2) | 0)]; any = true;
        }
      }
      if (!any) return { empty: true };
      cx.putImageData(img, 0, 0); return { sm: c.transferToImageBitmap() };
    });
  }
  // radar at points, as the map shows it (weak echoes need NOAA's precipitation flag): strongest value within ~5 km
  //   on the sharp grid, or within the surrounding 4×4 blocks on the zoomed-out copy. For the live accuracy check.
  function probe(fr, pts) {
    var CW = NI / CS, CH = NJ / CS, H = FB / 2, b = fr.fbox, R = Math.max(1, Math.round(0.045 / DEG));
    return pts.map(function (p) {
      var gr = (LAT0 - p[0]) / DEG, gc = (((p[1] - LON0) % 360 + 360) % 360) / DEG, best = null, bt = 0, fine = false;
      if (gr < 0 || gr > NJ - 1 || gc < 0 || gc > NI - 1) return null;
      var lr = Math.round(gr) - b.r0, lc = Math.round(gc) - b.c0;
      function take(q, tk, has) { if (!q) return; var v = q / 2 - 10; if (v < (tk === 2 ? 5 : MINDBZ) || v < 20 && has && !tk) return; if (best == null || v > best) { best = v; bt = tk; } }
      if (lr >= R && lr < FB - R && lc >= R && lc < FB - R) {
        fine = true;
        for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) take(fr.fine[(lr + dy) * FB + lc + dx], fr.ft ? fr.ft[((lr + dy) >> 1) * H + ((lc + dx) >> 1)] : 1, !!fr.ft);
      } else {
        var cr = Math.round(gr / CS), cc = Math.round(gc / CS);
        for (var y = Math.max(0, cr - 1); y <= Math.min(CH - 1, cr + 1); y++) for (var x = Math.max(0, cc - 1); x <= Math.min(CW - 1, cc + 1); x++) take(fr.coarse[y * CW + x], fr.ct ? fr.ct[y * CW + x] : 1, !!fr.ct);
      }
      return { v: best, t: bt === 2 ? "snow" : bt === 3 ? "hail" : best != null ? "rain" : "", fine: fine };
    });
  }
  function boxFor(bx) {
    var r = Math.round((LAT0 - bx.lat) / DEG) - FB / 2, c = Math.round((bx.lon - LON0) / DEG) - FB / 2;
    return { r0: Math.max(0, Math.min(NJ - FB, r)), c0: Math.max(0, Math.min(NI - FB, c)), v: bx.v };
  }
  root.onmessage = function (ev) {
    var m = ev.data;
    if (m.grid === "dom") { var D = m.dom; NI = D.ni; NJ = D.nj; LAT0 = D.lat0; LON0 = D.lon0; DEG = D.d; G = {}; FR = {}; LASTK = {}; GERR = {}; GBOX = null; return; }
    if (m.grid === "go") { if (GATE) { GATE.open(); GATE = null; } return; }
    if (m.grid === "box") { GBOX = boxFor(m.box); return; }
    if (m.grid === "load") {
      // keep this set and the previous one (still on screen until the new one is ready)
      if (m.prune) pruneFiles();
      if (GATE) { GATE.open(); GATE = null; }
      var keep = {}, prev = Promise.resolve(), dl = prev, noop = function () {};
      if (m.hold) { var open; dl = GATE = new Promise(function (r) { open = r; }); GATE.open = open; }
      m.frames.forEach(function (f) { f.base = m.base; FR[f.t] = f; keep[f.t] = 1; var fr = gridFrame(f, prev, dl); prev = fr.p.catch(noop); if (fr.dl) dl = fr.dl.catch(noop); });
      Object.keys(G).forEach(function (t) { if (!keep[t] && !LASTK[t]) { delete G[t]; delete FR[t]; } }); LASTK = keep;
      return;
    }
    if (m.kind === "probe") {
      var pf = G[m.t]; (pf ? pf.p : Promise.reject(new Error("frame not loaded"))).then(function (fr) { root.postMessage({ id: m.id, vals: probe(fr, m.pts) }); }, function (e) { root.postMessage({ id: m.id, err: true, msg: String(e && e.message || e) }); });
      return;
    }
    if (m.kind === "gtile") {
      if (!can2d) { root.postMessage({ id: m.id, nosupport: true }); return; }
      var fr = G[m.t]; (fr ? fr.p : Promise.reject(new Error(GERR[m.t] || "frame not loaded"))).then(function () { return gtile(m); }).then(function (r) { r.id = m.id; root.postMessage(r, r.sm ? [r.sm] : []); }, function (e) { root.postMessage({ id: m.id, err: true, msg: String(e && e.message || e || "error").slice(0, 80) }); });
      return;
    }
    if (m.cfg) { REFP = m.cfg.REFP; TYPC = m.cfg.TYPC; LREF.clear(); LTYP.clear(); return; }
    if (!can2d) { root.postMessage({ id: m.id, nosupport: true }); return; }
    if (m.kind === "sad") { root.postMessage({ id: m.id, mv: sad(m.A, m.B, m.gw, m.gh, m.R) }); return; }
    // tile: a missing type tile just means "rain"; a missing reflectivity tile is an error
    Promise.all(m.urls.map(function (u, i) { return fetchBitmap(u).catch(function (x) { if (i === 0) throw x; return null; }); })).then(function (ims) {
      var sm = m.mrms ? compose(ims[0], ims[1]) : recolor(ims[0], m.urls[0]), out = { id: m.id, raw: ims[0] }, tr = [ims[0]];
      if (ims[1]) ims[1].close();
      if (sm === EMPTY) out.empty = true; else { out.sm = sm.transferToImageBitmap(); tr.push(out.sm); }
      root.postMessage(out, tr);
    }).catch(function () { root.postMessage({ id: m.id, err: true }); });
  };
})(this);
