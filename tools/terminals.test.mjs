// terminals hook: Overpass parsing and simplification (tools/terminals-lib.mjs), the committed terminal files,
// and the curated lounge data's schema (site/data/lounges.json, validated by site/terminals.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./terminals-lib.mjs";
import { loungeProblems, staleLounges, needsCheck, loungeFootnote, findGate, loungeGroups, extent, fitBox, gateSpacing, gateInfo, normGate } from "../site/terminals.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const AIRPORTS = json("airports.json");
const MSP = AIRPORTS.find((a) => a.iata === "MSP");
const FIX = json("tools/fixtures/terminals/MSP.overpass.json");

test("terminals: the Overpass query searches inside the aerodrome for every feature, with a 60 s timeout", () => {
  const q = L.buildQuery(MSP);
  assert.match(q, /^\[out:json\]\[timeout:60\];/);
  assert.match(q, /\["aeroway"="aerodrome"\]\["iata"="MSP"\]/);
  assert.match(q, /\["aeroway"="aerodrome"\]\["icao"="KMSP"\]/);
  assert.match(q, /map_to_area/);
  for (const f of ['"aeroway"="terminal"', '"building"="terminal"', '"aeroway"="gate"', '"aeroway"="runway"', '"amenity"="lounge"', '"aeroway"="lounge"']) assert.ok(q.includes(f), f);
  assert.match(q, /out geom/);
  assert.ok(!L.buildQuery({ iata: 'M"SP', icao: "K;MSP" }).includes('M"SP'), "codes are sanitised");
});

test("terminals: projection round-trips to well under a metre", () => {
  const P = L.projector(44.88, -93.22);
  const [x, y] = P.toXY(44.89, -93.2);
  assert.ok(Math.abs(y - 1112) < 2 && Math.abs(x - 1577) < 3, `${x} ${y}`);
  const [lat, lon] = P.toLL(x, y);
  assert.ok(Math.abs(lat - 44.89) < 1e-9 && Math.abs(lon + 93.2) < 1e-9);
});

test("terminals: Douglas-Peucker keeps corners, drops points within 5 m", () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([i * 10, (i % 2 ? 1.5 : -1.5)]); // 1 km zig-zag of ±1.5 m
  assert.deepEqual(L.simplifyLine(line).length, 2);
  const bent = [[0, 0], [50, 2], [100, 0], [100, 50], [100, 100]];
  assert.deepEqual(L.simplifyLine(bent), [[0, 0], [100, 0], [100, 100]]);
  assert.deepEqual(L.simplifyLine([[0, 0], [1, 1]]), [[0, 0], [1, 1]]);
  // a densely traced rectangle with jitter comes back as its 4 corners, every original point within tolerance
  const ring = [];
  const corners = [[0, 0], [300, 0], [300, 120], [0, 120], [0, 0]];
  for (let c = 0; c < 4; c++) for (let k = 0; k < 30; k++) {
    const [a, b] = [corners[c], corners[c + 1]];
    ring.push([a[0] + (b[0] - a[0]) * k / 30 + (k ? Math.sin(k) : 0), a[1] + (b[1] - a[1]) * k / 30 + (k ? Math.cos(k) : 0)]);
  }
  ring.push(ring[0]);
  const s = L.simplifyRing(ring);
  assert.equal(s.length, 4, JSON.stringify(s));
  assert.ok(Math.abs(L.ringArea(s) - 36000) / 36000 < 0.03);
  assert.deepEqual(L.simplifyRing([[0, 0], [1, 0], [0, 0]]), []);
});

test("terminals: multipolygon pieces join into rings", () => {
  const rings = L.joinRings([[[0, 0], [10, 0], [10, 10]], [[0, 0], [0, 10], [10, 10]]]); // second piece runs backwards
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  assert.equal(L.joinRings([[[0, 0], [10, 0]]]).length, 0, "an unclosable piece is dropped");
});

test("terminals: the MSP fixture parses into terminals, grouped gates, runways and lounges", () => {
  const t = L.parseOverpass(FIX, MSP);
  assert.equal(t.ok, true);
  assert.equal(t.aerodrome, true);
  assert.equal(t.osmBase, "2026-10-01T00:00:00Z");
  assert.deepEqual(t.terminals.filter((x) => x.name).map((x) => x.name).sort(), ["Terminal 1", "Terminal 2"]);
  assert.ok(t.terminals.every((x) => x.rings.every((r) => r.length >= 3 && r.length <= 12)), "simplified outlines");
  assert.ok(!t.terminals.some((x) => L.ringArea(x.rings[0]) < L.MIN_TERMINAL_M2), "the kiosk is left out");
  assert.equal(t.gates.length, 131, "duplicate C12 and the ref-less gate are skipped");
  assert.deepEqual(t.groups.map((g) => g.name), ["Concourse A", "Concourse B", "Concourse C", "Concourse D", "Concourse E", "Concourse F", "Concourse G", "Concourse H"]);
  assert.ok(t.groups.slice(0, 7).every((g) => g.terminal === "Terminal 1"), "fingers inherit their terminal");
  assert.equal(t.groups[7].terminal, "Terminal 2");
  const c12 = t.gates.find((g) => g.ref === "C12");
  assert.equal(t.groups[c12.g].name, "Concourse C");
  assert.deepEqual(t.runways.map((r) => r.ref), ["12R/30L", "12L/30R", "4/22", "17/35"]);
  assert.ok(t.runways.every((r) => r.line.length === 2));
  assert.equal(t.lounges.length, 4);
  assert.ok(t.lounges.some((l) => l.name === "Escape Lounge"), "a lounge mapped as an area becomes a point");
  assert.equal(t.licenseUrl, "https://www.openstreetmap.org/copyright");
  assert.ok(JSON.stringify(t).length < 12000, "compact");
});

test("terminals: bad, empty and partial replies are tolerated", () => {
  assert.equal(L.parseOverpass({ elements: [] }, MSP).ok, false);
  assert.equal(L.parseOverpass({ elements: [] }, MSP).why, "empty reply");
  assert.equal(L.parseOverpass(null, MSP).ok, false);
  assert.match(L.parseOverpass({ remark: "runtime error: Query timed out", elements: FIX.elements }, MSP).why, /timed out/);
  const noAd = L.parseOverpass({ elements: FIX.elements.filter((e) => !(e.tags && e.tags.aeroway === "aerodrome")) }, MSP);
  assert.equal(noAd.ok, true, "still usable without the aerodrome element (falls back to airports.json coordinates)");
  const junk = L.parseOverpass({ elements: [{ type: "way", id: 1, tags: { aeroway: "terminal" } }, { type: "node", id: 2, tags: { aeroway: "gate", ref: "A1" } }, { foo: 1 }, null] }, MSP);
  assert.equal(junk.ok, false);
  assert.equal(L.gateLetter("C12"), "C");
  assert.equal(L.gateLetter("12"), null);
  assert.equal(L.normGate(" gate b-12 "), "B12");
  assert.equal(normGate("Gate B 12"), "B12");
});

test("terminals: committed files match the builder and the index", () => {
  const idx = json("site/data/terminals/index.json");
  assert.equal(idx.v, 1);
  assert.ok(Date.parse(idx.checked));
  assert.equal(idx.licenseUrl, "https://www.openstreetmap.org/copyright");
  const files = readdirSync(join(ROOT, "site/data/terminals")).filter((f) => f !== "index.json");
  for (const f of files) {
    const iata = f.replace(".json", "");
    assert.ok(AIRPORTS.some((a) => a.iata === iata), `${iata} is a major airport`);
    assert.equal(idx.airports[iata] && idx.airports[iata].ok, true, `${iata} listed in index.json`);
    const t = json("site/data/terminals/" + f);
    assert.equal(t.v, 1);
    assert.ok(extent(t), `${iata} has something to draw`);
  }
  for (const [k, v] of Object.entries(idx.airports)) if (v.ok) assert.ok(files.includes(k + ".json"), `${k}.json exists`);
  const msp = json("site/data/terminals/MSP.json");
  if (msp.fixture) assert.equal(L.contentKey(msp), L.contentKey({ ...L.parseOverpass(FIX, MSP), fixture: true }), "MSP.json is the fixture build");
});

test("terminals: page helpers find gates and concourses and fit the drawing", () => {
  const t = L.parseOverpass(FIX, MSP);
  assert.equal(findGate(t, "b12").gate.ref, "B12");
  assert.equal(findGate(t, "Gate H 3").group.terminal, "Terminal 2");
  assert.equal(findGate(t, "G").gates.length, 22);
  assert.equal(findGate(t, "Z99"), null);
  assert.equal(findGate(t, ""), null);
  assert.deepEqual(gateInfo(t, "C3"), { ref: "C3", concourse: "Concourse C", terminal: "Terminal 1" });
  const e = extent(t);
  const box = fitBox(e, 16 / 10);
  assert.ok(Math.abs(box[2] / box[3] - 1.6) < 1e-9);
  assert.ok(box[2] >= e.x1 - e.x0 - 1e-6 && box[3] >= e.y1 - e.y0 - 1e-6);
  const sp = gateSpacing(t.gates);
  assert.ok(sp > 10 && sp < 80, String(sp));
});

test("lounges: lounges.json is well-formed for all 32 airports", () => {
  const doc = json("site/data/lounges.json");
  assert.deepEqual(loungeProblems(doc, new Set(AIRPORTS.map((a) => a.iata))), []);
});

test("lounges: the verified list (checked 2026-10-04) is complete and readable", () => {
  const doc = json("site/data/lounges.json");
  assert.deepEqual(loungeProblems(doc, new Set(AIRPORTS.map((a) => a.iata))), []);
  const now = Date.parse("2026-10-04T12:00:00Z");
  const st = staleLounges(doc, now);
  assert.equal(st.total, 162);
  assert.equal(st.old.length, 0);
  let low = 0;
  for (const ap of Object.values(doc.airports)) {
    for (const l of ap.lounges) {
      assert.ok(!/%/.test(l.access) && l.access.length <= 60, l.access);
      if (l.confidence === "low" || !l.verified) { low++; assert.equal(needsCheck(l, now), true); }
      else assert.equal(needsCheck(l, now), false, l.name);
    }
    if (ap.lounges.length) assert.equal(loungeFootnote(ap.lounges), "Checked Oct 2026 — confirm with the airline before you go");
  }
  assert.ok(low > 0 && low < st.total);
  const groups = loungeGroups(doc.airports.ORD.lounges);
  assert.ok(groups.length >= 3 && groups.every((g) => /^Terminal [123]\b/.test(g.terminal)), groups.map((g) => g.terminal).join(", "));
});

test("lounges: the card footnote uses the oldest verified month, and none without a verified date", () => {
  assert.equal(loungeFootnote([{ verified: "2026-10-04" }, { verified: "2026-09-30" }, { verified: null }]), "Checked Sep 2026 — confirm with the airline before you go");
  assert.equal(loungeFootnote([{ verified: null }]), null);
  assert.equal(loungeFootnote([]), null);
});

test("lounges: the schema check catches bad entries and stale dates", () => {
  const good = { name: "Delta Sky Club", operator: "Delta Air Lines", terminal: "Concourse C", side: "airside", access: "Sky Club members", verified: "2026-09-01", source: "https://www.delta.com/x", confidence: "high" };
  const doc = (l, map = { url: "https://www.mspairport.com/", kind: "home", verified: null }) => ({ v: 1, airports: { MSP: { map, lounges: [l] } } });
  assert.deepEqual(loungeProblems(doc(good)), []);
  assert.match(loungeProblems(doc({ ...good, source: "delta.com" }))[0], /source/);
  assert.match(loungeProblems(doc({ ...good, confidence: "maybe" }))[0], /confidence/);
  assert.match(loungeProblems(doc({ ...good, verified: null }))[0], /high confidence needs/);
  assert.match(loungeProblems(doc({ ...good, verified: "Sept 2026" }))[0], /verified/);
  assert.match(loungeProblems(doc({ ...good, access: "" }))[0], /no access/);
  assert.match(loungeProblems(doc({ ...good, side: "inside" }))[0], /side/);
  assert.match(loungeProblems(doc(good, { url: "http://x.com", kind: "map" }))[0], /https/);
  assert.match(loungeProblems(doc(good), new Set(["MSP", "ORD"]))[0], /ORD: missing/);
  assert.deepEqual(loungeProblems(null), ["not a lounges.json (v 1 with airports{})"]);
  const now = Date.parse("2026-10-04T00:00:00Z");
  assert.equal(staleLounges(doc(good), now).old.length, 0);
  assert.equal(staleLounges(doc({ ...good, verified: "2026-03-01" }), now).old.length, 1, "older than 6 months");
  assert.equal(staleLounges(doc({ ...good, verified: null, confidence: "low" }), now).unverified.length, 1);
  assert.equal(needsCheck(good, now), false);
  assert.equal(needsCheck({ ...good, verified: "2026-03-01" }, now), true);
});
