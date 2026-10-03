import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetarCsv, parseTafXml, computeGlobal } from "./global.mjs";
import { expandTemplate } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-03T19:20:00Z");
const fx = (f) => expandTemplate(readFileSync(join(HERE, "fixtures", f), "utf8"), NOW);

test("metars.cache.csv: skips the status lines, reads raw_text/station_id/observation_time", () => {
  const m = parseMetarCsv(fx("metars.cache.csv"), NOW);
  assert.ok(m.length >= 50);
  const egll = m.find((x) => x.icaoId === "EGLL");
  assert.match(egll.rawOb, /^EGLL \d{6}Z 24008KT 9999/);
  assert.equal(egll.visib, "6+"); // 9999 m
  assert.equal(egll.obsTime * 1000 <= +NOW, true);
  // raw-text only (no header): still finds METARs by pattern
  const bare = parseMetarCsv("KMSP 031853Z 34018G28KT 1/2SM +SN OVC004 M02/M03 A2992\n", NOW);
  assert.equal(bare[0].icaoId, "KMSP");
  assert.equal(bare[0].wxString, "+SN");
  assert.equal(bare[0].wgst, 28);
});

test("tafs.cache.xml: TAFs parsed from <raw_text> with <issue_time>", () => {
  const t = parseTafXml(fx("tafs.cache.xml"), NOW);
  assert.ok(t.length >= 48);
  const e = t.find((x) => x.icaoId === "EGLL");
  assert.equal(e.fcsts.length, 1);
  assert.ok(e.validTimeTo * 1000 > +NOW);
  const amp = parseTafXml("<TAF><raw_text>TAF KJFK 031720Z 0318/0424 31015G25KT P6SM BKN040 TEMPO 0320/0322 3SM TSRA BKN015CB</raw_text><station_id>KJFK</station_id></TAF>", NOW);
  assert.equal(amp[0].fcsts[1].fcstChange, "TEMPO");
});

test("computeGlobal: METAR-only, TAF-only, both, none, stale METAR", () => {
  const H = 3600;
  const s = Math.floor(+NOW / 1000);
  const metars = [
    { icaoId: "KFCM", obsTime: s - 600, rawOb: "KFCM 031910Z 30010KT 2SM -SN OVC008", visib: 2, wxString: "-SN", clouds: [{ cover: "OVC", base: 800 }], wgst: null },
    { icaoId: "KOLD", obsTime: s - 3 * H, rawOb: "KOLD old", visib: "6+", clouds: [] },
    { icaoId: "EGLL", obsTime: s - 900, rawOb: "EGLL 031905Z 24008KT 9999 FEW045 18/08 Q1013", visib: "6+", clouds: [{ cover: "FEW", base: 4500 }] },
  ];
  const tafs = [{ icaoId: "EGLL", issueTime: s - 3000, validTimeFrom: s - H, validTimeTo: s + 30 * H, rawTAF: "TAF EGLL …", fcsts: [{ timeFrom: s - H, timeTo: s + 30 * H, fcstChange: null, visib: "6+", wxString: null, clouds: [{ cover: "SCT", base: 5000 }] }] }];
  const g = computeGlobal({ airports: [{ icao: "KFCM", tz: "America/Chicago" }, { icao: "KOLD", tz: null }, { icao: "EGLL", tz: "Europe/London" }, { icao: "Y49", tz: "America/Chicago" }], metars, tafs, now: NOW });
  const f = g.get("KFCM");
  assert.equal(f.n, 2); // snow, IFR
  assert.equal(f.h.length, 24);
  assert.equal(f.h.slice(1), "-".repeat(23)); // no TAF: later hours unknown, not "clear"
  assert.equal(f.pl, "Light snow and low clouds — visibility 2 miles");
  assert.equal(f.im, "De-icing and slower operations — delays likely");
  assert.equal(f.t, undefined);
  assert.equal(g.has("KOLD"), false); // only a 3 h old METAR
  assert.equal(g.has("Y49"), false);
  const e = g.get("EGLL");
  assert.equal(e.h, "0".repeat(24));
  assert.ok(e.m && e.t && e.mt && e.ti);
});
