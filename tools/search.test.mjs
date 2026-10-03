// site/search.js is browser ESM; import it through a data: URL so Node treats it as a module.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site/search.js"), "utf8");
const S = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const list = S.decodeList(JSON.parse(readFileSync(join(ROOT, "site/data/airports-all.json"), "utf8")));
const codes = (q) => S.rank(q, list).map((a) => a.code);

test("exact codes first (IATA, ICAO, any case)", () => {
  assert.equal(codes("ord")[0], "ORD");
  assert.equal(codes("KORD")[0], "ORD");
  assert.equal(codes("egll")[0], "LHR");
  assert.equal(codes("Y49")[0], "Y49"); // no IATA: ICAO/GPS code is the code
});

test("aliases and city names", () => {
  assert.deepEqual(codes("NYC").slice(0, 3), ["JFK", "LGA", "EWR"]);
  assert.deepEqual(codes("chicago").slice(0, 2), ["ORD", "MDW"]);
  assert.deepEqual(codes("DC").slice(0, 3), ["DCA", "IAD", "BWI"]);
  assert.deepEqual(codes("bay area"), ["SFO", "OAK", "SJC"]);
  assert.equal(codes("london")[0], "LHR");
});

test("prefix matching, scheduled before others, accent-insensitive", () => {
  assert.deepEqual(codes("minneap").slice(0, 1), ["MSP"]);
  assert.ok(codes("eden pr").includes("FCM"));
  assert.equal(codes("hagatna")[0], "GUM");
  assert.equal(codes("san juan")[0], "SJU");
  assert.equal(S.normalize("Hagåtña"), "hagatna");
  // "St Paul": scheduled MSP (alias) before non-scheduled STP
  assert.deepEqual(codes("st paul").slice(0, 2), ["MSP", "STP"]);
  assert.ok(S.rank("a", list).length <= 8);
  assert.deepEqual(codes(""), []);
});

test("nearest airport with reports", () => {
  const y49 = list.find((a) => a.code === "Y49");
  const n = S.nearest(y49, list, (x) => x.hasMetar);
  assert.ok(n && n.airport.code && n.miles > 50 && n.miles < 200, JSON.stringify(n && [n.airport.code, n.miles]));
});

test("alias prefixes from 4 letters", () => {
  assert.equal(codes("lond")[0], "LHR");
  assert.deepEqual(codes("chic").slice(0, 2), ["ORD", "MDW"]);
});
