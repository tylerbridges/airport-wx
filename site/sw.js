// Service worker for the Airports app (README "Service worker"): the installed app opens from this device's copy of
// the page, then reads fresh data. Scope ./ (/airport-wx/ live). Only same-origin GETs under the scope are handled;
// everything cross-origin (radar, map tiles, IEM, the live relay) never reaches respondWith.
//   page (index.html / ./)  network first (2.5 s), else the saved copy; a changed page re-syncs the shell cache
//   ?v= files               cache first (immutable per version); other site files: stale-while-revalidate
//   data (summary, airport/, wx/, config, model/)  network first (4 s), the saved copy only when the network fails;
//                           such a reply carries "X-AWX-SW: fallback" and app.js then says "Offline · last checked …"
//   scenarios, trips.json, status.json, movement.json, changes.json, uptime.json, cache:"no-store"/"reload"  network only
// Pages opened with ?test=… or ?nosw=1 and check.html go straight to the network (nothing cached for them).
// Caches: "awx-shell-<VERSION>", "awx-data-<VERSION>"; only older ones with these prefixes are ever deleted, and
// they may vanish at any time (the weather site's /sw.js clears every cache on the origin) -> network, re-populate.
// Bump VERSION on every change to this file; tools/sw.test.mjs pins a hash of the file to it.
const VERSION = "1";
const SHELL = "awx-shell-" + VERSION;
const DATA = "awx-data-" + VERSION;
const PREFIXES = ["awx-shell-", "awx-data-"];
const NAV_TIMEOUT = 2500;
const DATA_TIMEOUT = 4000;
const DATA_MAX = 150; // airport files + weather shards kept (oldest saved first out); summary, config and model always stay

const DATA_NET_FIRST = /^data\/(?:summary\.json|config\.json|airport\/[A-Za-z0-9]+\.json|wx\/[A-Za-z0-9_-]+\.json|model\/[^?#]+)$/;
const DATA_STATIC = /^data\/(?:airports-all\.json|airports-extra\.json|lounges\.json|map-land\.json|sample\.json|terminals\/[^?#]+)$/;

/** Pages that bypass the worker: test scenarios, ?nosw=1, the check page. */
function bypassPage(href) {
  try {
    const u = new URL(href);
    return /[?&](?:test=|nosw=1(?:&|$))/.test(u.search) || /\/check\.html$/.test(u.pathname);
  } catch (e) { return false; }
}

/**
 * Pure routing: r = {url, scope, method, mode, cache, range}. Returns
 * "pass" (not intercepted), "nav", "index", "data", "versioned" or "static".
 */
function route(r) {
  if (r.method !== "GET" || r.range) return "pass";
  let u, s;
  try { u = new URL(r.url); s = new URL(r.scope); } catch (e) { return "pass"; }
  if (u.origin !== s.origin || !u.pathname.startsWith(s.pathname)) return "pass";
  const rel = u.pathname.slice(s.pathname.length);
  const isIndex = rel === "" || rel === "index.html";
  if (r.mode === "navigate") return isIndex && !bypassPage(u.href) ? "nav" : "pass";
  if (isIndex) return "index"; // checkVersion (no-store) and the refresh button (reload): network, then re-sync
  if (r.cache === "no-store" || r.cache === "reload" || rel === "sw.js") return "pass";
  if (rel.startsWith("data/")) return DATA_NET_FIRST.test(rel) ? "data" : DATA_STATIC.test(rel) ? "static" : "pass";
  return /[?&]v=[^&]/.test(u.search) ? "versioned" : "static";
}

/** Same-origin scripts, styles, icons and the manifest a page (index.html) loads. */
function pageAssets(html, base) {
  const out = [];
  const origin = new URL(base).origin;
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const at = /\s(?:src|href)\s*=\s*"([^"]+)"/i.exec(tag);
    if (!at) continue;
    if (m[1].toLowerCase() === "link" && !/\srel\s*=\s*"(?:stylesheet|manifest|icon|apple-touch-icon|modulepreload|preload)"/i.test(tag)) continue;
    try { const u = new URL(at[1], base); if (u.origin === origin) out.push(u.href); } catch (e) { /* bad URL */ }
  }
  return out;
}
/** Relative module imports (static and import("./…")) in a script. */
function scriptImports(js, base) {
  const out = [];
  const re = /\b(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"'\s]+)["']/g;
  let m;
  while ((m = re.exec(js))) { try { out.push(new URL(m[1], base).href); } catch (e) { /* bad URL */ } }
  return out;
}

if (typeof module === "object" && module.exports) module.exports = { VERSION, SHELL, DATA, PREFIXES, route, bypassPage, pageAssets, scriptImports, DATA_NET_FIRST, DATA_STATIC };

// ---------- worker ----------

if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) {
  const scope = () => self.registration.scope;
  const indexUrl = () => new URL("index.html", scope()).href;
  const open = (name) => caches.open(name);
  const isVersioned = (href) => /[?&]v=[^&]/.test(new URL(href).search);
  const isCode = (href) => /\.(?:js|mjs|css)$/.test(new URL(href).pathname);
  const goodResp = (res) => res && res.ok && res.type === "basic" && !res.redirected;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const quiet = (p) => Promise.resolve(p).catch(() => null);

  async function cachedIndexText() {
    try { const c = await open(SHELL); const r = await c.match(indexUrl()); return r ? await r.text() : null; } catch (e) { return null; }
  }
  /** Unversioned scripts/styles can't be told apart by URL: drop them when the page changed (a code deploy). */
  async function purgeUnversionedCode() {
    try {
      const c = await open(SHELL);
      await Promise.all((await c.keys()).filter((q) => isCode(q.url) && !isVersioned(q.url)).map((q) => c.delete(q)));
    } catch (e) { /* cache gone */ }
  }

  // Make the shell cache match one index.html: its assets (and their module imports) first, then the page itself,
  // then drop versioned files it no longer uses. The saved page is only replaced once its files are saved, so an
  // offline start never gets a page whose scripts aren't there. One sync at a time.
  let syncChain = Promise.resolve();
  function sync(text) {
    const run = async () => {
      if (text === (await cachedIndexText())) return; // saved only once its files were: already in step
      const c = await open(SHELL);
      const want = new Set();
      const queue = pageAssets(text, indexUrl());
      let failed = 0;
      const one = async (href) => {
        if (want.has(href)) return;
        want.add(href);
        let res = isVersioned(href) ? await c.match(href) : null;
        if (!res) {
          res = await quiet(fetch(href, { cache: "no-cache", credentials: "same-origin" }));
          if (!res) { failed++; return; } // network error: don't commit this page yet
          if (!goodResp(res)) return; // missing on the server: the page can't have it either
          await c.put(href, res.clone());
        }
        const path = new URL(href).pathname;
        if (/\.m?js$/.test(path)) queue.push(...scriptImports(await res.text(), href));
        else if (/\.webmanifest$/.test(path)) {
          try { for (const i of JSON.parse(await res.text()).icons || []) queue.push(new URL(i.src, href).href); } catch (e) { /* not JSON */ }
        }
      };
      while (queue.length) await Promise.all(queue.splice(0, 8).map((h) => one(h).catch(() => { failed++; })));
      if (failed) return; // keep the previous page; the next visit tries again
      await c.put(indexUrl(), new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      for (const q of await c.keys()) if (isVersioned(q.url) && !want.has(q.url)) await c.delete(q);
    };
    syncChain = syncChain.then(run).catch(() => null);
    return syncChain;
  }

  self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(fetch(indexUrl(), { cache: "no-cache", credentials: "same-origin" }).then((res) => {
      if (!goodResp(res)) throw new Error("index.html HTTP " + res.status);
      return res.text();
    }).then(sync));
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      try {
        for (const k of await caches.keys()) if (PREFIXES.some((p) => k.startsWith(p)) && k !== SHELL && k !== DATA) await caches.delete(k);
      } catch (e) { /* caches unavailable */ }
      await self.clients.claim();
    })());
  });

  /** Page: network first; a slow or failed network gets the saved page. */
  async function navigate(event) {
    const req = event.request;
    const net = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(async (res) => {
      if (!goodResp(res)) return { pass: true };
      const text = await res.text();
      const headers = new Headers(res.headers);
      headers.delete("Content-Encoding");
      headers.delete("Content-Length");
      return { res: new Response(text, { status: res.status, statusText: res.statusText, headers }), text };
    });
    // background: keep the saved page (and its files) in step with the network's, also after a timeout
    event.waitUntil(net.then((r) => (r.text ? sync(r.text) : null)).catch(() => null));
    const first = await Promise.race([net.catch(() => ({ err: true })), sleep(NAV_TIMEOUT).then(() => ({ timeout: true }))]);
    if (first.res) {
      // a new page (code deploy): its unversioned modules must not come from the old copy
      const old = await cachedIndexText();
      if (old !== null && old !== first.text) await purgeUnversionedCode();
      return first.res;
    }
    if (first.pass) return fetch(req);
    let copy = null;
    try { copy = await (await open(SHELL)).match(indexUrl()); } catch (e) { /* cache gone */ }
    if (copy) return copy;
    const r = await net; // nothing saved: wait for the network (rejects offline -> the browser's own error page)
    return r.res || fetch(req);
  }

  /** index.html fetched by the page (checkVersion's no-store, the refresh button's reload): always the network. */
  function indexFetch(event) {
    const p = fetch(event.request);
    event.waitUntil(p.then(async (res) => {
      if (!goodResp(res)) return;
      const text = await res.clone().text();
      if (text !== (await cachedIndexText())) await sync(text);
    }).catch(() => null));
    return p;
  }

  async function cacheFirst(event) {
    const req = event.request;
    try { const hit = await (await open(SHELL)).match(req.url); if (hit) return hit; } catch (e) { /* cache gone */ }
    const res = await fetch(req);
    if (goodResp(res)) { const copy = res.clone(); event.waitUntil(open(SHELL).then((c) => c.put(req.url, copy)).catch(() => null)); }
    return res;
  }

  async function staleWhileRevalidate(event) {
    const req = event.request;
    let hit = null;
    try { hit = await (await open(SHELL)).match(req.url); } catch (e) { /* cache gone */ }
    const net = fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(async (res) => {
      if (goodResp(res)) await (await open(SHELL)).put(req.url, res.clone());
      return res;
    });
    if (hit) { event.waitUntil(net.catch(() => null)); return hit; }
    return net.catch(() => fetch(req));
  }

  /** Data: network first; the saved copy only when the network fails or is slow, marked so the page says so. */
  async function dataFirst(event) {
    const req = event.request;
    const u = new URL(req.url);
    const key = u.origin + u.pathname; // ?g=<generated> re-asks for the same file
    let store = null;
    const net = fetch(req).then((res) => {
      if (goodResp(res) && res.status === 200) {
        const copy = res.clone();
        store = open(DATA).then(async (c) => {
          await c.put(key, copy);
          const many = (await c.keys()).filter((q) => /\/data\/(?:airport|wx)\//.test(q.url));
          for (const q of many.slice(0, Math.max(0, many.length - DATA_MAX))) await c.delete(q);
        }).catch(() => null);
      }
      return res;
    });
    event.waitUntil(net.then(() => store, () => null));
    const first = await Promise.race([net.then((res) => ({ res }), () => ({ err: true })), sleep(DATA_TIMEOUT).then(() => ({ timeout: true }))]);
    if (first.res) return first.res;
    let copy = null;
    try { copy = await (await open(DATA)).match(key); } catch (e) { /* cache gone */ }
    if (copy) {
      const headers = new Headers(copy.headers);
      headers.set("X-AWX-SW", "fallback");
      return new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers });
    }
    return net; // nothing saved: the network's answer or its error (never a made-up 404)
  }

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    const kind = route({ url: req.url, scope: scope(), method: req.method, mode: req.mode, cache: req.cache, range: req.headers.has("range") });
    if (kind === "pass") return;
    if (kind === "nav") { event.respondWith(navigate(event)); return; }
    event.respondWith((async () => {
      if (event.clientId) {
        try { const c = await self.clients.get(event.clientId); if (c && bypassPage(c.url)) return fetch(req); } catch (e) { /* no client */ }
      }
      if (kind === "index") return indexFetch(event);
      if (kind === "data") return dataFirst(event);
      if (kind === "versioned") return cacheFirst(event);
      return staleWhileRevalidate(event);
    })());
  });
}
