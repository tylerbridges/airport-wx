// Trips in the poll (README "Trips"): reads the flight calendar, adds the trip airports to this run's
// full-detail pipeline, and writes site/data/trips.json (airports and times only) plus a redacted
// format sample into the raw folder (-> raw/latest/ on the history branch).
//
//   live:      env FLIGHTY_ICS_URL (webcal:// or https://), fetched once per run
//   fixtures:  <FIXTURES_DIR or poller/fixtures>/trips.ics when present (times are template tokens:
//              {{ics+90 America/Chicago}} = local "YYYYMMDDTHHMMSS" 90 min from now in that zone,
//              {{icsz+90}} = UTC "YYYYMMDDTHHMMSSZ", {{icsd+1}} = all-day date 1 day from now)
//   TRIPS_OUT: output path (default: trips.json next to the status.json being written)
//
// The calendar URL is a secret: it is never logged or written anywhere (errors are generic, and in
// GitHub Actions the https:// form is masked too). Never throws: a failure is stated in trips.json.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tripsFromIcs, makeLookup, redactedSample } from "./trips.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UA = "airport-wx (github.com/tylerbridges/airport-wx)";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** webcal://… -> https://… (null when it isn't a URL). */
export function icsHttpsUrl(u) {
  const s = String(u ?? "").trim();
  if (!s) return null;
  const m = /^(webcals?|https?):\/\/(.+)$/i.exec(s);
  return m ? "https://" + m[2] : null;
}

/** Replaces the secret URL (any scheme, and its path) in a message. */
export function maskSecret(msg, secret) {
  let s = String(msg ?? "");
  const raw = String(secret ?? "").trim();
  if (!raw) return s;
  const rest = raw.replace(/^[a-z]+:\/\//i, "");
  const path = rest.slice(rest.indexOf("/"));
  for (const x of [raw, "https://" + rest, "http://" + rest, "webcal://" + rest, rest, path.length > 8 ? path : null]) {
    if (x) s = s.split(x).join("***");
  }
  return s;
}

/** Fetch the calendar; errors carry no URL (status code, timeout, or the network error code). */
async function fetchIcs(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/calendar, */*" }, signal: ctl.signal, redirect: "follow" });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`timeout after ${TIMEOUT_MS / 1000}s`);
      throw new Error(`network error${e?.cause?.code ? " (" + String(e.cause.code).replace(/[^A-Z_]/g, "") + ")" : ""}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from the calendar`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("calendar file too large");
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not a calendar file (no BEGIN:VCALENDAR)");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const p2 = (x) => String(x).padStart(2, "0");
function wallParts(ms, tz) {
  const o = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms))) o[x.type] = x.value;
  return o;
}
/** Fixture tokens: {{ics+MIN ZONE}}, {{icsz+MIN}}, {{icsd+DAYS}} (minutes rounded to 5). */
export function expandIcsTemplate(text, now = new Date()) {
  const base = Math.round(+now / 300e3) * 300e3;
  return String(text).replace(/\{\{(icsz|icsd|ics)([+-]\d+)(?:\s+([A-Za-z_/]+))?\}\}/g, (_, kind, n, tz) => {
    const k = Number(n);
    if (kind === "icsd") {
      const d = new Date(base + k * 24 * 3600e3);
      return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
    }
    const t = base + k * 60e3;
    if (kind === "icsz") {
      const d = new Date(t);
      return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00Z`;
    }
    const w = wallParts(t, tz || "UTC");
    return `${w.year}${p2(w.month)}${p2(w.day)}T${p2(w.hour)}${p2(w.minute)}00`;
  });
}

// ---------- airports ----------

/** The full airport list (site/data/airports-all.json, + airports-extra.json) as [{iata, icao, name, city, state, tz, lat, lon, country}]. */
export async function loadAllAirports(dataDir = join(ROOT, "site/data")) {
  const out = [];
  for (const f of ["airports-all.json", "airports-extra.json"]) {
    let j;
    try { j = JSON.parse(await readFile(join(dataDir, f), "utf8")); } catch { continue; }
    const k = Object.fromEntries((j.f || []).map((n, i) => [n, i]));
    for (const r of j.a || []) {
      const iata = r[k.iata] || "";
      if (!/^[A-Z]{3}$/.test(iata)) continue;
      const country = r[k.country] || "";
      const region = r[k.region] || "";
      out.push({
        iata, icao: r[k.icao] || "", name: r[k.name] || iata, city: r[k.city] || "", country,
        state: country === "US" ? region.split("-")[1] || "" : country,
        tz: r[k.tz] >= 0 ? j.tz[r[k.tz]] : null, lat: r[k.lat], lon: r[k.lon], type: r[k.type] || "S", scheduled: !!r[k.scheduled],
      });
    }
  }
  // larger, scheduled airports first, so a city name picks the main airport
  const rank = (a) => (a.scheduled ? 0 : 3) + ({ L: 0, M: 1, S: 2 }[a.type] ?? 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Curated airports + trip airports not in it, looked up in the full list (full-detail pipeline for
 * this run: FAA, NWS, SPC, LAMP, METAR/TAF). Added entries carry `trip: true`. Returns {airports, added, missing}.
 */
export function withTripAirports(curated, trips, all) {
  const have = new Set(curated.map((a) => a.iata));
  const byIata = new Map(all.map((a) => [a.iata, a]));
  const added = [];
  const missing = [];
  for (const t of trips) for (const l of t.legs) for (const c of [l.from, l.to]) {
    if (have.has(c)) continue;
    have.add(c);
    const a = byIata.get(c);
    if (!a || !a.icao || !a.tz || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) { missing.push(c); continue; }
    added.push({ iata: a.iata, icao: a.icao, name: a.name, city: a.city, state: a.state, lat: a.lat, lon: a.lon, tz: a.tz, trip: true });
  }
  return { airports: [...curated, ...added], added: added.map((a) => a.iata), missing };
}

// ---------- the run ----------

/**
 * Reads the calendar (never throws). Returns {doc (trips.json), sample (redacted) | null, addAirports(list), finish({out, rawDir})}.
 * env: process.env-like; fixtures: read trips.ics from the fixture dir instead of the network.
 */
export async function prepareTrips({ fixtures = false, now = new Date(), env = process.env, dataDir = join(ROOT, "site/data") } = {}) {
  const secret = String(env.FLIGHTY_ICS_URL || "").trim();
  const doc = { generated: now.toISOString(), configured: false, ok: true, error: null, source: null, count: 0, flights: 0, trips: [] };
  let sample = null;
  let text = null;
  if (fixtures) {
    const dir = env.FIXTURES_DIR ? resolve(env.FIXTURES_DIR) : join(HERE, "fixtures");
    try { text = expandIcsTemplate(await readFile(join(dir, "trips.ics"), "utf8"), now); doc.configured = true; doc.source = "fixture"; } catch { /* no trips in this fixture set */ }
  } else if (secret) {
    doc.configured = true;
    doc.source = "calendar";
    const url = icsHttpsUrl(secret);
    if (env.GITHUB_ACTIONS === "true" && url) {
      // the secret is masked as stored (webcal://…); mask the https:// form and the path as well
      const rest = url.replace(/^https:\/\//, "");
      for (const m of [url, rest, rest.slice(rest.indexOf("/"))]) if (m.length > 8) console.log(`::add-mask::${m}`);
    }
    if (!url) { doc.ok = false; doc.error = "FLIGHTY_ICS_URL isn't a webcal:// or https:// link"; }
    else {
      try { text = await fetchIcs(url); } catch (e) { doc.ok = false; doc.error = maskSecret(String(e?.message || e), secret).slice(0, 120); }
    }
  }
  let all = [];
  if (text != null) {
    try {
      all = await loadAllAirports(dataDir);
      let curated = [];
      try { curated = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8")); } catch { /* full list only */ }
      const lookup = makeLookup([...curated, ...all]);
      const salt = secret || "airport-wx fixture salt";
      const hash = (s) => createHash("sha256").update(s).digest("hex");
      const r = tripsFromIcs(text, { now, lookup, salt, hash });
      doc.trips = r.trips;
      doc.count = r.trips.length;
      doc.flights = r.stats.upcomingFlights;
      sample = { generated: doc.generated, source: doc.source, ...redactedSample(r.cal, r.stats, lookup) };
    } catch (e) {
      doc.ok = false;
      doc.error = maskSecret("couldn't read the calendar: " + String(e?.message || e), secret).slice(0, 120);
      doc.trips = [];
    }
  }
  let added = [];
  let missing = [];
  return {
    doc,
    sample,
    /** curated airports -> curated + trip airports (this run only). */
    async addAirports(curated) {
      if (!doc.trips.length) return curated;
      if (!all.length) all = await loadAllAirports(dataDir);
      const r = withTripAirports(curated, doc.trips, all);
      added = r.added;
      missing = r.missing;
      return r.airports;
    },
    /** status.json airports: marks the ones added for trips (`trip: true`, so the page keeps them off its lists). */
    markAirports(list) {
      const set = new Set(added);
      for (const a of list || []) if (set.has(a.iata)) a.trip = true;
      return list;
    },
    /** Writes trips.json (and the redacted sample + a "trips" entry in the raw folder's sources.json). */
    async finish({ out, rawDir = null }) {
      const file = env.TRIPS_OUT ? resolve(env.TRIPS_OUT) : join(dirname(out), "trips.json");
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(doc) + "\n");
      } catch (e) { console.error("trips.json not written: " + e.message); }
      if (rawDir) {
        try {
          const meta = { ok: doc.ok, at: doc.generated, error: doc.error, configured: doc.configured, trips: doc.count, flights: doc.flights, files: [] };
          if (sample) {
            await writeFile(join(rawDir, "trips-sample.json"), JSON.stringify(sample, null, 1) + "\n");
            meta.files = ["trips-sample.json"];
          }
          const sf = join(rawDir, "sources.json");
          let src = {};
          try { src = JSON.parse(await readFile(sf, "utf8")); } catch { /* none yet */ }
          src.trips = meta;
          await writeFile(sf, JSON.stringify(src, null, 1) + "\n");
        } catch (e) { console.error("trips sample not written: " + e.message); }
      }
      const what = !doc.configured ? "not configured (no FLIGHTY_ICS_URL)" : !doc.ok ? "FAIL " + doc.error
        : `${doc.count} trip${doc.count === 1 ? "" : "s"}, ${doc.flights} flight${doc.flights === 1 ? "" : "s"}${added.length ? ", added airports " + added.join(" ") : ""}${missing.length ? ", unknown airports " + missing.join(" ") : ""}`;
      console.log(`${doc.configured && !doc.ok ? "FAIL" : "ok  "} trips: ${what}`);
      return { file, doc };
    },
  };
}
