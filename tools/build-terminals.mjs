#!/usr/bin/env node
// Terminal maps (terminals hook): builds site/data/terminals/<IATA>.json and index.json from OpenStreetMap.
//
//   node tools/build-terminals.mjs              all 32 airports in airports.json, one Overpass query each
//   node tools/build-terminals.mjs --only MSP,ORD
//   node tools/build-terminals.mjs --fixtures   MSP from tools/fixtures/terminals/MSP.overpass.json (no network)
//
// Polite by design (Overpass usage policy): one query per airport, one at a time, at least 5 s apart, a 60 s
// timeout, no retries, an identifying User-Agent. Run monthly by .github/workflows/terminals.yml (~32 queries a
// month). Tolerant: an airport whose query fails or comes back empty keeps its previous file, and the run still
// exits 0 unless every airport failed. An airport file is rewritten only when its content changed (the OSM
// timestamp alone doesn't count); index.json records this run's check date, so the monthly commit always has it.
// Data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERPASS_URL, buildQuery, parseOverpass, contentKey } from "./terminals-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "airport-wx terminal maps (monthly, 1 query per airport; https://github.com/tylerbridges/airport-wx)";
const GAP_MS = 5500; // between queries (policy: be far below the limits)
const TIMEOUT_MS = 60e3;

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FIX = args.includes("--fixtures");
const OUT = arg("--out") || join(ROOT, "site/data/terminals");
const only = (arg("--only") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(ap) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS + 5e3);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "data=" + encodeURIComponent(buildQuery(ap, TIMEOUT_MS / 1e3)),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limited)" : res.status === 504 ? " (server busy)" : ""}`);
    try { return JSON.parse(text); } catch { throw new Error("reply isn't JSON: " + text.slice(0, 80).replace(/\s+/g, " ")); }
  } finally { clearTimeout(timer); }
}

async function main() {
  let airports = readJson(join(ROOT, "airports.json"), []);
  if (FIX) airports = airports.filter((a) => a.iata === "MSP");
  if (only.length) airports = airports.filter((a) => only.includes(a.iata));
  if (!airports.length) { console.error("no airports to build"); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  const idxPath = join(OUT, "index.json");
  const prev = readJson(idxPath, null);
  const now = new Date().toISOString();
  const index = {
    v: 1, checked: now, source: "OpenStreetMap via Overpass API", attribution: "© OpenStreetMap contributors", license: "ODbL",
    licenseUrl: "https://www.openstreetmap.org/copyright", airports: { ...((prev && prev.airports) || {}) },
  };
  let ok = 0, failed = 0, changed = 0;
  for (let i = 0; i < airports.length; i++) {
    const ap = airports[i];
    if (i && !FIX) await sleep(GAP_MS);
    const file = join(OUT, ap.iata + ".json");
    const old = readJson(file, null);
    let t = null, why = null;
    try {
      const json = FIX ? readJson(join(ROOT, `tools/fixtures/terminals/${ap.iata}.overpass.json`)) : await overpass(ap);
      if (!json) throw new Error("no fixture");
      t = parseOverpass(json, ap);
      if (!t.ok) { why = t.why; t = null; }
    } catch (e) { why = e.name === "AbortError" ? "timed out" : String(e.message || e); }
    const was = index.airports[ap.iata] || {};
    if (!t) {
      failed++;
      console.log(`${ap.iata}: kept ${old ? "the previous file" : "nothing (no previous file)"} — ${why}`);
      index.airports[ap.iata] = old ? { ...was, lastError: why, lastErrorAt: now } : { ok: false, why, lastErrorAt: now };
      continue;
    }
    ok++;
    if (FIX) t.fixture = true;
    const same = old && contentKey(old) === contentKey(t);
    if (!same) { writeFileSync(file, JSON.stringify(t) + "\n"); changed++; }
    const updated = same && was.updated ? was.updated : now.slice(0, 10);
    index.airports[ap.iata] = {
      ok: true, terminals: t.terminals.length, gates: t.gates.length, runways: t.runways.length, lounges: t.lounges.length,
      osmBase: t.osmBase, updated, ...(FIX ? { fixture: true } : {}),
    };
    console.log(`${ap.iata}: ${t.terminals.length} terminal shapes, ${t.gates.length} gates in ${t.groups.length} groups, ${t.runways.length} runways, ${t.lounges.length} lounges${same ? " (unchanged)" : ""}`);
  }
  index.ok = ok;
  index.failed = failed;
  writeFileSync(idxPath, JSON.stringify(index, null, 1) + "\n");
  console.log(`done: ${ok} ok, ${failed} failed, ${changed} files changed`);
  if (!ok && failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
