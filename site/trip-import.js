// Device-only calendar snapshots. No I/O; caller keeps the source file in memory only.
import { tripsFromIcs, makeLookup, groupTrips, fnvHash } from "./trips-parser.js?v=1";

export const MAX_CALENDAR_BYTES = 1024 * 1024;
export const flightKey = (l) => [l.from, l.to, Date.parse(l.dep)].join("|");

/** Airport/time-only drafts, with matching flights already on the device/site removed. */
export function calendarDraft(text, { airports = [], existing = [], now = Date.now() } = {}) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_CALENDAR_BYTES || !/^\uFEFF?BEGIN:VCALENDAR\s*$/mi.test(text) || !/^END:VCALENDAR\s*$/mi.test(text)) throw new Error("Choose a valid calendar (.ics) file under 1 MB.");
  const parsed = tripsFromIcs(text.replace(/^\uFEFF/, ""), { now, lookup: makeLookup(airports) });
  const seen = new Set(existing.flatMap((t) => (t.legs || []).map(flightKey)));
  let skipped = 0;
  const newLegs = [];
  for (const t of parsed.trips) for (const l of t.legs) {
    const key = flightKey(l);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    newLegs.push({ from: l.from, to: l.to, dep: Date.parse(l.dep), arr: Date.parse(l.arr) });
  }
  const zones = new Map(airports.map((a) => [a.iata, a.tz]));
  const trips = groupTrips(newLegs).map((legs) => {
    const clean = legs.map((l) => ({ from: l.from, to: l.to, dep: new Date(l.dep).toISOString(), arr: new Date(l.arr).toISOString() }));
    return { id: "i" + fnvHash(clean.map(flightKey).join(";")), legs: clean, imported: true,
      tz: Object.fromEntries([...new Set(clean.flatMap((l) => [l.from, l.to]))].map((c) => [c, zones.get(c) || "UTC"])) };
  });
  return { trips, skipped, flights: newLegs.length, events: parsed.stats.events };
}

/** Choose the next flight by its schedule, never by assumed airborne/arrived status. */
export function nextScheduled(trips, now = Date.now()) {
  const future = trips.flatMap((trip) => trip.legs.map((leg) => ({ trip, leg }))).filter(({ leg }) => Date.parse(leg.dep) >= now).sort((a, b) => Date.parse(a.leg.dep) - Date.parse(b.leg.dep));
  if (future.length) return { ...future[0], future: true };
  const recent = [...trips].sort((a, b) => Date.parse(b.legs[b.legs.length - 1].arr) - Date.parse(a.legs[a.legs.length - 1].arr))[0];
  return recent ? { trip: recent, leg: recent.legs[recent.legs.length - 1], future: false } : null;
}
