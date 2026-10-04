import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTfrList, parseTfrDetail, tfrType, geoDeg, tfrTime, tfrNear, areaDistNm, tfrDetailUrl } from "./tfr.mjs";
import { expandTemplate } from "./lib.mjs";
import { run } from "./poll.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-04T18:20:00Z");
const fx = async (f) => expandTemplate(await readFile(join(HERE, "fixtures", f), "utf8"), NOW);

test("TFR list: notam_id/state (as on the live export), tolerant of other shapes", async () => {
  const list = parseTfrList(JSON.parse(await fx("tfr-list.json")));
  assert.deepEqual(list.map((t) => [t.id, t.type, t.state]), [["6/4321", "VIP", "DC"], ["6/5501", "SPACE", "FL"], ["6/6100", "STADIUM", "NV"], ["6/0990", "HAZARDS", "ID"]]);
  assert.deepEqual(parseTfrList({ data: [{ notamId: "1/2345", TYPE: "91.141 VIP" }, { notam_id: "bogus" }] }).map((t) => [t.id, t.type]), [["1/2345", "VIP"]]);
  assert.deepEqual(parseTfrList("<html>"), []);
  assert.equal(tfrDetailUrl("6/4321"), "https://tfr.faa.gov/download/detail_6_4321.xml");
});

test("TFR types from the type text, CFR section or NOTAM text", () => {
  assert.equal(tfrType("VIP"), "VIP");
  assert.equal(tfrType("", "PURSUANT TO 14 CFR SECTION 91.141"), "VIP");
  assert.equal(tfrType("SPACE OPERATIONS"), "SPACE");
  assert.equal(tfrType("SECURITY", "STADIUM SPORTING EVENT"), "STADIUM");
  assert.equal(tfrType("SECURITY"), "SECURITY");
  assert.equal(tfrType("HAZARDS", "FIRE FIGHTING"), "HAZARDS");
  assert.equal(tfrType("SPECIAL"), "SPECIAL");
});

test("TFR detail XML: areas (merged polygon, else circles), schedules, text", async () => {
  const d = parseTfrDetail(await fx("tfr-detail-6_4321.xml"));
  assert.equal(d.id, "6/4321");
  assert.equal(d.type, "VIP");
  assert.equal(d.areas.length, 2);
  assert.equal(d.areas[0].ring.length, 24);
  assert.equal(d.from, +NOW + 120 * 60e3);
  assert.equal(d.to, +NOW + 240 * 60e3);
  assert.match(d.text, /^!FDC 6\/4321 ZDC DC\.\.AIRSPACE WASHINGTON/);
  // DCA is inside; BWI (about 28 NM out) is near the 30 NM ring; Philadelphia is not
  assert.equal(tfrNear(-77.0402, 38.8512, d).nm, 0);
  assert.ok(tfrNear(-76.6683, 39.1754, d));
  assert.equal(tfrNear(-75.2411, 39.8719, d), null);
  // circle-only area (no merged polygon), km radius
  const xml = `<XNOTAM-Update><Group><Add><Not><NotUid><txtLocalName>1/1</txtLocalName></NotUid><dateEffective>2026-10-04T20:00:00</dateEffective><dateExpire>2026-10-04T22:00:00</dateExpire>
    <TfrNot><codeType>SPACE OPERATIONS</codeType><TFRAreaGroup><aseTFRArea><txtName>A</txtName></aseTFRArea><aseShapes><Abd><Avx><geoLatArc>28.6N</geoLatArc><geoLongArc>080.6W</geoLongArc><valRadiusArc>18.52</valRadiusArc><uomRadiusArc>KM</uomRadiusArc></Avx></Abd></aseShapes></TFRAreaGroup></TfrNot></Not></Add></Group></XNOTAM-Update>`;
  const c = parseTfrDetail(xml);
  assert.equal(c.type, "SPACE");
  assert.equal(c.from, Date.UTC(2026, 9, 4, 20)); // no zone: UTC
  assert.ok(Math.abs(c.areas[0].circles[0].nm - 10) < 1e-9);
  assert.equal(Math.round(areaDistNm(-80.6, 28.9, c.areas[0])), 8); // 18 NM north of the center, radius 10
  assert.equal(parseTfrDetail("<html>not xml</html>"), null);
  assert.deepEqual([geoDeg("38.85N"), geoDeg("077.04W"), geoDeg("-77.04"), geoDeg("x")], [38.85, -77.04, -77.04, null]);
  assert.equal(tfrTime("202610061800"), Date.UTC(2026, 9, 6, 18));
});

test("poll --fixtures: notice sources, items at the airports and their hours (DCA VIP, MCO space, LGA nightly runway)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "awx-notices-"));
  try {
    const { status } = await run({ fixtures: true, out: join(dir, "status.json"), now: NOW, rawDir: join(dir, "raw") });
    assert.equal(status.noticeSources.notam.ok, true);
    assert.equal(status.noticeSources.notam.via, "search");
    assert.equal(status.noticeSources.tfr.ok, true);
    const ap = (c) => status.airports.find((a) => a.iata === c);
    const dca = ap("DCA");
    assert.equal(dca.notices.items[0].kind, "vip");
    assert.equal(dca.peak.level, 2);
    assert.match(dca.peak.reasons[0], /^VIP movement — brief ground holds possible /);
    assert.ok(ap("MCO").notices.items.some((x) => x.kind === "space"));
    assert.ok(ap("LGA").notices.items.some((x) => x.kind === "runway" && x.sched));
    assert.equal(ap("DEN").notices.items[0].dup, true); // the ops plan SIR reports it
    assert.ok(ap("ORD").notices.other >= 1); // obstacle light: counted, not listed
    const raw = JSON.parse(await readFile(join(dir, "raw", "sources.json"), "utf8"));
    assert.deepEqual(raw.notam.files, ["notams.json"]);
    assert.deepEqual(raw.tfr.files, ["tfr-list.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
