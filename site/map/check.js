// Check-page rows for the Map tab (site/map.js), run by check.js in mock mode in a hidden 390 px frame
// (`// map hook` in check.js): the tab renders, one dot per airport with a list row each, a tap on ORD's dot opens
// its sheet, the time slider recolours the dots by hour and the dots agree with the shared outlook.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch { /* frame navigating */ }
    await sleep(80);
  }
  return null;
}

/** add(status, label, detail) from check.js's group(); url: the index.html to open (a ?test= scenario). */
export async function mapChecks(add, url) {
  const holder = document.getElementById("frames");
  const f = document.createElement("iframe");
  holder.append(f);
  try {
    await new Promise((res) => { f.onload = res; f.src = url + "#map"; });
    const w = await until(() => { const x = f.contentWindow; return x && x.AWXApp && x.AWXApp.state.data && x.AWXNav && x.AWXMap ? x : null; });
    if (!w) { add("fail", "Map tab renders", "the Map tab never mounted (window.AWXMap missing)"); return; }
    const d = f.contentDocument;
    w.AWXMap.setFilter("all");
    const st = await until(() => { const s = w.AWXMap._state(); return s.dots > 0 && s.rows > 0 ? s : null; }, 6000) || w.AWXMap._state();
    const stage = d.querySelector(".mapx-stage");
    const sh = stage ? stage.getBoundingClientRect().height : 0;
    const n = w.AWXApp.state.data.airports.length;
    add(stage && sh >= 300 && !d.getElementById("navMap").hidden ? "pass" : "fail", "Map tab renders", `stage ${Math.round(sh)} px tall, base map: ${st.base}${st.vmap === "fail" ? " (vector tiles unreachable, outline fallback)" : ""}, ${st.labels} codes labelled`);
    add(st.dots === st.shown && st.shown >= n && st.rows === st.shown ? "pass" : "fail", "One dot and one list row per airport",
      `${st.dots} dots, ${st.rows} list rows, ${n} airports in status.json (${st.onScreen} on screen in the mainland view)`);

    // tap ORD's dot: pointer events + the click that follows, as a finger would
    const p = w.AWXMap.pos("ORD");
    const over = d.querySelector(".mapx-over");
    if (!p || !p.on || !over) add("fail", "Tapping a dot opens its sheet", "ORD isn't on screen");
    else {
      const o = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0 };
      over.dispatchEvent(new w.PointerEvent("pointerdown", o));
      over.dispatchEvent(new w.PointerEvent("pointerup", o));
      over.dispatchEvent(new w.MouseEvent("click", o));
      const open = await until(() => !d.getElementById("sheetWrap").hidden && w.AWXApp.state.openIata === "ORD", 3000);
      add(open ? "pass" : "fail", "Tapping a dot opens its sheet", open ? "ORD sheet opened" : `sheet ${d.getElementById("sheetWrap").hidden ? "closed" : "open for " + w.AWXApp.state.openIata}`);
      w.AWXApp.closeSheet();
      await until(() => d.getElementById("sheetWrap").hidden, 2000);
    }

    // the slider recolours by hour, and every major's dot matches the shared outlook at that hour
    const slider = d.querySelector(".mapx-slider");
    const set = (k) => { slider.value = String(k); slider.dispatchEvent(new w.Event("input", { bubbles: true })); return w.AWXMap._state(); };
    const s0 = set(0);
    let moved = null;
    for (let k = 1; k <= s0.maxOff && !moved; k++) {
      const s = set(k);
      const diff = Object.keys(s0.levels).filter((c) => s0.levels[c] !== s.levels[c]);
      if (diff.length) moved = { k, s, diff };
    }
    const WORDS = ["Clear", "Minor", "Moderate", "High", "Severe"];
    const lv = (x) => (x == null ? "No data" : WORDS[x]);
    add(moved ? "pass" : "fail", "Time slider recolours the dots", moved
      ? `${moved.s.when}: ${moved.diff.length} airports change, e.g. ${moved.diff.slice(0, 3).map((c) => `${c} ${lv(s0.levels[c])} → ${lv(moved.s.levels[c])}`).join(", ")}; range ${s0.minOff} to +${s0.maxOff} h`
      : "no dot changed colour over the forecast hours");
    const k = moved ? moved.k : 0;
    const s = set(k);
    const bad = w.AWXApp.state.data.airports.filter((a) => {
      const o = w.AWXApp.outlook(a, s.at);
      const want = o.kind === "unknown" || o.level == null ? null : o.level;
      return s.levels[a.iata] !== want || s.heads[a.iata] !== o.headline;
    }).map((a) => a.iata);
    add(bad.length ? "fail" : "pass", "Dots agree with the airport-hour outlook", bad.length ? "differs at " + bad.join(", ") : `all ${n} airports at ${s.when}`);
    set(0);
    const errs = (w.__awxErrors || []).map((e) => `${e.kind}: ${e.msg}`);
    add(errs.length ? "fail" : "pass", "No errors on the Map tab", errs.join(" | ") || "none");
  } catch (e) {
    add("fail", "Map checks ran to the end", String((e && e.stack) || e));
  } finally {
    f.remove();
  }
}
