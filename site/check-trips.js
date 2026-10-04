// Check page: trips (README "Trips"). Called from check.js through marked hooks ("// trips hook").
//   live:  a "Trips" row (configured or not, trip count, last calendar fetch ok), a privacy check
//          (trips.json has only airport codes, times and hashed ids: no flight-number pattern, names or
//          emails), and that every trip airport is in status.json with full data.
//   mock:  the same per scenario, plus the scenario's trip assertions:
//          {t: "trips", count, configured}, {t: "trip", i, status, re}, {t: "tripAirport", iata}.
import { tripStatus, privacyProblems } from "./trip-risk.js?v=4";

const MIN = 60e3;
const ago = (ms) => (ms < MIN ? "just now" : ms < 60 * MIN ? `${Math.round(ms / MIN)} min ago` : `${(ms / 3600e3).toFixed(1)} h ago`);

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  }
}

/**
 * add(status, label, detail) adds a row. ctx: {url, data (status.json, already shifted in mock), shift(d), asserts, mock}.
 */
export async function tripChecks(add, { url, data, shift = (d) => d, asserts = [], mock = false }) {
  const got = await getJson(url);
  if (!got.ok) {
    add(mock ? "fail" : "warn", "Trips", got.status === 404 ? "data/trips.json not found (the poller writes it every run)" : `trips.json didn't load (HTTP ${got.status || got.error})`);
    return;
  }
  const doc = shift(got.data);
  const trips = doc.trips || [];
  const flights = trips.reduce((n, t) => n + (t.legs || []).length, 0);
  const age = Date.now() - Date.parse(doc.generated);
  if (!doc.configured) add("pass", "Trips", "flight calendar not configured (no FLIGHTY_ICS_URL secret) · manual trips only");
  else if (doc.ok === false) add("fail", "Trips: flight calendar fetch", `configured, last fetch failed: ${doc.error || "unknown error"}`);
  else add("pass", "Trips", `configured · ${trips.length} trip${trips.length === 1 ? "" : "s"}, ${flights} flight${flights === 1 ? "" : "s"} · last fetch ok ${Number.isFinite(age) ? ago(Math.max(0, age)) : ""}`.trim());

  const bad = privacyProblems(got.data);
  add(bad.length ? "fail" : "pass", "Trips privacy: only airports, times and hashed ids (no flight numbers, names or emails)", bad.join("; ") || `${trips.length} trips clean`);

  if (data && trips.length) {
    const by = new Map((data.airports || []).map((a) => [a.iata, a]));
    const codes = [...new Set(trips.flatMap((t) => t.legs.flatMap((l) => [l.from, l.to])))];
    const missing = codes.filter((c) => !by.has(c));
    add(missing.length ? "fail" : "pass", "Trip airports have full data in status.json", missing.length ? `missing: ${missing.join(", ")}` : codes.join(", "));
    const noMetar = codes.filter((c) => by.has(c) && !(by.get(c).metar && Date.now() - Date.parse(by.get(c).metar.obsTime) < 2 * 3600e3));
    if (noMetar.length) add("warn", "Trip airports with a METAR under 2 h old", `no recent METAR: ${noMetar.join(", ")} (the trip uses the forecast only there)`);
  }

  for (const x of asserts || []) {
    if (x.t === "trips") {
      const ok = trips.length === x.count && (x.configured == null || !!doc.configured === x.configured);
      add(ok ? "pass" : "fail", `Expect: ${x.count} trip${x.count === 1 ? "" : "s"}${x.configured != null ? (x.configured ? ", calendar configured" : ", not configured") : ""}`, ok ? "" : `got ${trips.length}, configured ${doc.configured}`);
    } else if (x.t === "trip") {
      const t = trips[x.i || 0];
      const by = new Map(((data && data.airports) || []).map((a) => [a.iata, a]));
      const r = t ? tripStatus(t, (c) => by.get(c) || null, { now: Date.now() }) : null;
      const ok = !!r && (!x.status || r.label === x.status) && (!x.re || new RegExp(x.re).test(r.top));
      add(ok ? "pass" : "fail", `Expect: trip ${x.i || 0} ${x.status ? `"${x.status}"` : ""}${x.re ? ` /${x.re}/` : ""}`, ok ? "" : r ? `got "${r.label}": ${r.top}` : "no such trip");
    } else if (x.t === "tripAirport") {
      const a = ((data && data.airports) || []).find((y) => y.iata === x.iata);
      const ok = !!(a && a.trip && Array.isArray(a.hours) && a.hours.length);
      add(ok ? "pass" : "fail", `Expect: ${x.iata} joins the full pipeline as a trip airport`, ok ? "" : a ? "present but not marked trip" : "missing from status.json");
    }
  }
}
