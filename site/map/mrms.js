// Map tab radar overlay (map hook): NOAA's quality-controlled MRMS reflectivity (SeamlessHSR: birds, insects and
// clutter removed) as served by the Iowa Environmental Mesonet, the radar popup's own second source. CONUS only.
// Tiles are decoded back to dBZ with IEM's gr2ae table (index i = -32 + i/2 dBZ; same as site/radar/wx-radar.js
// lcrefDbz) and redrawn in one neutral ramp so the risk dots' colours stay readable. Echoes under 10 dBZ are left out.
const IEM = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/mrms::lcref-";
const LCJ = "https://mesonet.agron.iastate.edu/data/gis/images/4326/mrms/lcref.json";
const LCP = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a4a4ffa1a1fc9e9ef99a9af69797f29494ef9191ec8e8ee98a8ae68787e38484e08181dc7e7ed97a7ad67777d37474d07171cd6e6ec96a6ac66767c34080ff3e7df93d7af23b76ec3a73e63870df366dd9356ad33366cc3263c63060c02e5db92d5ab32b56ac2a53a62850a0264d99254a9323468d22438620408000f90000f20000ec0000e60000df0000d90000d30000cc0000c60000c00000b90000b30000ac0000a60000a000009900009300008d00008600008000fff900fff200ffec00ffe600ffdf00ffd900ffd300ffcc00ffc600ffc000ffb900ffb300ffac00ffa600ffa000ff9900ff9300ff8d00ff8600ff0000fa0000f50000f10000ec0000e70000e30000de0000d90000d40000cf0000cb0000c60000c10000bd0000b80000b30000ae0000aa0000a50000ff00fff900f9f200f2ec00ece600e6df00dfd900d9d300d3cc00ccc600c6c000c0b900b9b300b3ac00aca600a6a000a09900999300938d008d860086fffffff9f9f9f2f2f2ececece6e6e6dfdfdfd9d9d9d3d3d3ccccccc6c6c6c0c0c0b9b9b9b3b3b3acacaca6a6a6a0a0a09999999393938d8d8d868686808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080909090";
let LLC = null;
function dbzOf(r, g, b) {
  if (!LLC) { LLC = new Map(); for (let i = 86; i < 226; i++) LLC.set(parseInt(LCP.substr(i * 6, 6), 16), -32 + i / 2); }
  const v = LLC.get((r << 16) | (g << 8) | b);
  return v === undefined ? null : v;
}
// light, moderate, heavy, very heavy: alpha rises with intensity
const STEPS = [[10, 0.22], [25, 0.38], [35, 0.55], [45, 0.72], [55, 0.86]];
const alphaOf = (v) => { let a = 0; for (const [d, x] of STEPS) if (v >= d) a = x; return a; };

/** One radar layer: latest scan time, tile cache and a draw call for the map's base canvas. */
export function makeRadar(onChange) {
  const S = { on: false, valid: null, checked: 0, failed: false, tiles: new Map(), dark: null, timer: 0 };
  async function refresh() {
    if (!S.on) return;
    try {
      const r = await fetch(LCJ + "?b=" + Math.floor(Date.now() / 60000));
      if (!r.ok) throw Error(r.status);
      const j = await r.json();
      const v = Date.parse(j && j.meta && j.meta.start_valid);
      if (!Number.isFinite(v) || Date.now() - v > 30 * 60000) throw Error("stale");
      S.failed = false; S.checked = Date.now();
      if (v !== S.valid) { S.valid = v; S.tiles.clear(); }
    } catch { S.failed = true; }
    onChange();
  }
  function setOn(on) {
    S.on = !!on;
    clearInterval(S.timer); S.timer = 0;
    if (S.on) { refresh(); S.timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 120000); }
    else S.tiles.clear();
    onChange();
  }
  document.addEventListener("visibilitychange", () => { if (S.on && document.visibilityState === "visible" && Date.now() - S.checked > 60000) refresh(); });
  function tile(z, x, y, dark) {
    if (S.dark !== dark) { S.dark = dark; S.tiles.clear(); }
    const n = 1 << z, xi = ((x % n) + n) % n, key = z + "/" + xi + "/" + y;
    let e = S.tiles.get(key);
    if (e) return e.c;
    e = { c: null }; S.tiles.set(key, e);
    if (S.tiles.size > 240) S.tiles.delete(S.tiles.keys().next().value);
    const stamp = new Date(S.valid).toISOString().replace(/[-T:]/g, "").slice(0, 12);
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 256;
        const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, 256, 256), p = d.data;
        const [R, G, B] = dark ? [205, 222, 255] : [38, 52, 84];
        for (let k = 0; k < p.length; k += 4) {
          const v = p[k + 3] ? dbzOf(p[k], p[k + 1], p[k + 2]) : null;
          const a = v == null ? 0 : alphaOf(v);
          p[k] = R; p[k + 1] = G; p[k + 2] = B; p[k + 3] = Math.round(a * 255);
        }
        g.putImageData(d, 0, 0);
        e.c = c;
      } catch { e.c = null; }
      onChange(true);
    };
    im.onerror = () => {};
    im.src = IEM + stamp + "/" + z + "/" + xi + "/" + y + ".png";
    return null;
  }
  /** Draw the radar for screen slots ({i, j, z, x0, y0, x1, y1} in device px, site/map.js visibleSlots). */
  function draw(ctx, slots, dark) {
    if (!S.on || !S.valid) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true;
    for (const s of slots) {
      const c = tile(s.z, s.i, s.j, dark);
      if (c) ctx.drawImage(c, s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    }
    ctx.restore();
  }
  return { setOn, draw, state: () => ({ on: S.on, valid: S.valid, failed: S.failed, tiles: S.tiles.size }) };
}
