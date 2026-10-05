// Check-page assertions for the nav shell (site/nav.js, site/settings.js), run by check.js in a hidden
// 390 px frame: tab bar present, tabs update the hash (and Back returns), the menu opens and closes,
// a Settings switch persists across a reload and shows in prefs (then is put back), and the last
// card scrolls fully clear of the bar.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch { /* frame navigating */ }
    await sleep(80);
  }
  return null;
}

function load(f, url) {
  return new Promise((res) => { f.onload = () => res(); f.src = url; });
}
const ready = (f) => until(() => {
  const w = f.contentWindow, d = f.contentDocument;
  // readyState "complete": a hash change before the load event is a replacement, so Back would leave the page (build2b)
  return w && w.AWXNav && d.readyState === "complete" && d.querySelector("#list .card, #list .empty") && !/Loading airports/.test(d.getElementById("list").textContent) ? w : null;
});

/** add(status, label, detail) from check.js's group(). url: the index.html to test. */
export async function navChecks(add, url) {
  const holder = document.getElementById("frames");
  const f = document.createElement("iframe");
  holder.append(f);
  try {
    await load(f, url);
    let w = await ready(f);
    if (!w) { add("fail", "Nav shell loads", "the tab bar never initialised (window.AWXNav missing)"); return; }
    let d = f.contentDocument;

    // tab bar
    const bar = d.querySelector(".awx-tabbar[role=tablist]");
    const tabs = bar ? [...bar.querySelectorAll("[role=tab]")] : [];
    add(bar && tabs.length === 3 && tabs[0].getAttribute("aria-selected") === "true" ? "pass" : "fail", "Tab bar present",
      bar ? tabs.map((t) => t.textContent + (t.getAttribute("aria-selected") === "true" ? " (selected)" : "")).join(", ") : "no .awx-tabbar");

    // tabs -> hash, Back returns
    const len0 = w.history.length;
    d.getElementById("tab-trips").click();
    const toTrips = await until(() => w.location.hash === "#trips" && !d.getElementById("navTrips").hidden, 2000);
    // build2b: Back only when the tab change added an entry; otherwise Back would leave the check page itself
    if (w.history.length > len0) w.history.back();
    else add("warn", "Tab change added no history entry", `history.length ${len0} → ${w.history.length}; Back not tried`);
    const back = await until(() => d.getElementById("tab-airports").getAttribute("aria-selected") === "true" && !d.getElementById("navAirports").hidden, 2000);
    add(toTrips && back ? "pass" : "fail", "Switching tabs updates the hash", `Trips → ${toTrips ? "#trips" : "hash " + JSON.stringify(w.location.hash)}; Back → ${back ? "Airports" : "not Airports"}`);

    // Short tabs must not clamp page scroll or move the common header/content origin.
    const airports = d.getElementById("navAirports");
    const position = () => [d.querySelector("header").getBoundingClientRect().top,
      d.querySelector("header").getBoundingClientRect().bottom,
      d.querySelector(".awx-panel:not([hidden])").getBoundingClientRect().top,
      bar.getBoundingClientRect().top, w.scrollY];
    const origin = position();
    airports.scrollTop = 200;
    const saved = airports.scrollTop;
    const jumps = [];
    for (const tab of ["trips", "map", "airports"]) {
      w.AWXNav.go(tab);
      for (let i = 0; i < 3; i++) {
        await sleep(20); // Offscreen check-page frames can suspend requestAnimationFrame.
        if (position().some((n, j) => Math.abs(n - origin[j]) > 1)) jumps.push(tab);
      }
    }
    const restored = Math.abs(airports.scrollTop - saved) < 1;
    airports.scrollTop = 0;
    add(!jumps.length && restored ? "pass" : "fail", "Tabs share a fixed header and content origin; scroll positions are restored",
      jumps.length ? `vertical jumps: ${jumps.join(", ")}` : `header/content/bar unchanged; Airports scroll ${saved} px ${restored ? "restored" : "lost"}`);

    // map hook: canvas map (site/map.js); deeper checks in site/map/check.js
    w.AWXNav.go("map");
    const mapReady = await until(() => d.querySelectorAll(".map-airport-row").length > 0 && w.AWXMap && w.AWXMap._state().dots > 0, 5000);
    add(mapReady ? "pass" : "fail", "Map draws airport dots and the accessible list", `${d.querySelectorAll(".map-airport-row").length} list rows, ${w.AWXMap ? w.AWXMap._state().dots : 0} dots`);
    if (mapReady) {
      const st = w.AWXMap._state();
      const a = w.AWXApp.state.data.airports.find((x) => d.querySelector(`.map-airport-row[data-code="${x.iata}"]`));
      const code = a ? a.iata : "no major in the list";
      const agrees = a && st.heads[code] === w.AWXApp.outlook(a, st.at).headline;
      add(agrees ? "pass" : "fail", "Map and detail share the same airport-hour outlook", code);
    }
    w.AWXNav.go("airports");

    // menu opens and closes (Escape, outside tap)
    const btn = d.getElementById("navMenuBtn");
    btn.click();
    const menu = d.getElementById("navMenu");
    const opened = await until(() => !menu.hidden && menu.classList.contains("open") && menu.contains(d.activeElement), 1500);
    menu.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const closedEsc = await until(() => menu.hidden && d.activeElement === btn, 1500);
    btn.click();
    await until(() => !menu.hidden, 1000);
    d.querySelector(".awx-catch").click();
    const closedTap = await until(() => menu.hidden, 1500);
    add(opened && closedEsc && closedTap ? "pass" : "fail", "Menu opens and closes",
      `open ${opened ? "ok" : "no"}, Escape ${closedEsc ? "closes (focus back on the button)" : "didn't close"}, outside tap ${closedTap ? "closes" : "didn't close"}`);

    // a Settings switch persists after reload and shows in prefs
    const key = "tstm";
    btn.click();
    await until(() => !menu.hidden, 1000);
    const item = [...menu.querySelectorAll(".awx-mi")].find((x) => x.textContent.trim() === "Settings");
    item.click();
    const sw = await until(() => d.querySelector(`.awx-set-wrap:not([hidden]) [role=switch][data-key="${key}"]`), 2000);
    if (!sw) add("fail", "Setting persists after reload", `Settings didn't open or has no "${key}" switch`);
    else {
      const before = sw.getAttribute("aria-checked") === "true";
      sw.click();
      const inPrefs = w.AWXNav.prefs().getPrefs().show[key] === !before;
      const reloadUrl = new URL(f.contentWindow.location.href);
      reloadUrl.searchParams.set("nav-check-reload", String(Date.now()));
      await load(f, reloadUrl.href);
      w = await ready(f);
      d = f.contentDocument;
      const kept = w && w.AWXNav.prefs().getPrefs().show[key] === !before;
      let shown = false;
      if (w) {
        w.AWXNav.openSettings();
        const sw2 = await until(() => d.querySelector(`[role=switch][data-key="${key}"]`), 2000);
        shown = !!sw2 && sw2.getAttribute("aria-checked") === String(!before);
        const P = w.AWXNav.prefs();
        P.setPref("show", Object.assign({}, P.getPrefs().show, { [key]: before })); // put it back
        d.querySelector(".awx-done").click();
        await until(() => !w.AWXNav || d.querySelector(".awx-set-wrap[hidden]"), 1500);
      }
      add(inPrefs && kept && shown ? "pass" : "fail", "Setting persists after reload",
        `"${key}" ${before ? "on → off" : "off → on"}: in prefs ${inPrefs ? "yes" : "no"}, after reload ${kept ? "kept" : "lost"}, switch ${shown ? "shows it" : "doesn't show it"} (restored afterwards)`);
    }

    // the last card scrolls fully clear of the bar
    if (w) {
      const filters = [...d.querySelectorAll("#seg button")];
      add(filters.length === 2 && filters.some(b => /^My airports/.test(b.textContent)) && filters.some(b => /^At risk/.test(b.textContent)) ? "pass" : "fail", "Airport filters: My airports and At risk", filters.map(b => b.textContent).join(", "));
      const risk = filters.find((b) => /^At risk/.test(b.textContent));
      if (risk) risk.click();
      if (!d.querySelector("#list .card")) filters.find(b => /^My airports/.test(b.textContent))?.click();
      await sleep(150);
      const panel = d.getElementById("navAirports");
      panel.scrollTop = panel.scrollHeight;
      await sleep(150);
      const cards = d.querySelectorAll("#list .card");
      const last = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null;
      const b = d.querySelector(".awx-tabbar").getBoundingClientRect();
      const okb = last && last.bottom <= b.top && last.bottom <= w.innerHeight;
      add(okb ? "pass" : "fail", "Nothing hidden behind the tab bar",
        last ? `last of ${cards.length} cards ends at ${Math.round(last.bottom)} px, bar starts at ${Math.round(b.top)} px` : "no cards");
      const errs = (w.__awxErrors || []).map((e) => `${e.kind}: ${e.msg}`);
      add(errs.length ? "fail" : "pass", "No errors while using the nav shell", errs.join(" | ") || "none");
    }
  } catch (e) {
    add("fail", "Nav checks ran to the end", String((e && e.stack) || e));
  } finally {
    f.remove();
  }
}
