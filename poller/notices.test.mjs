import test from "node:test";
import assert from "node:assert/strict";
import { noticesFor, applyNotices, tfrItem } from "./notices.mjs";
import { tripStatus, noticeOf } from "./trip-risk.mjs";
const NOW = new Date("2026-10-04T18:20:00Z"), H = 3600e3;
const LGA = { iata: "LGA", tz: "America/New_York", lat: 40.7769, lon: -73.874 };
const LGA_RWY = [];
const hours = () => Array.from({length: 6}, (_, i) => ({t: new Date(Math.floor(+NOW/H)*H+i*H),items:[],level:0}));
const score = (a, rwys, texts, {tfrs = null} = {}) => {
 const n = noticesFor({a,tfrs,now:NOW}), hs = applyNotices(hours(),n,{now:NOW});
 return {n,hs,reasons:hs.map(h=>h.items.map(x=>`${x.level} ${x.text}`))};
};
test("unavailable restrictions remain unknown; legacy NOTAM items cannot score", () => {
 assert.equal(noticesFor({a:LGA}), null);
 const hs = hours(); applyNotices(hs,{items:[{src:"notam",at:"span",level:4,reason:"Airport closed"}]});
 assert.equal(hs[0].level,0);
});
test("TFRs: VIP Moderate with its window, space Low, stadium information only, far away ignored", () => {
  const circle = (lat, lon, nm) => ({ circles: [{ lat, lon, nm }] });
  const vip = { id: "6/4321", type: "VIP", text: "!FDC 6/4321 ZDC DC..VIP", from: +NOW + 2 * H, to: +NOW + 4 * H, areas: [{ ...circle(40.70, -74.0, 10), from: +NOW + 2 * H, to: +NOW + 4 * H }] };
  const space = { id: "6/5501", type: "SPACE", text: "!FDC 6/5501 SPACE OPS", from: +NOW - H, to: +NOW + H, areas: [{ ...circle(40.9, -73.6, 20), from: null, to: null }] };
  const stadium = { id: "6/6100", type: "STADIUM", text: "!FDC 6/6100 STADIUM", from: +NOW - H, to: +NOW + 3 * H, areas: [{ ...circle(40.83, -73.93, 3) }] };
  const far = { id: "6/7000", type: "VIP", text: "far", from: +NOW, to: +NOW + 2 * H, areas: [{ ...circle(42.36, -71.0, 10) }] };
  const s = score(LGA, LGA_RWY, [], { tfrs: [vip, space, stadium, far] });
  assert.deepEqual(s.n.items.map((x) => [x.kind, x.level, x.at]), [["vip", 2, "span"], ["space", 1, "span"], ["stadium", 0, "none"]]);
  assert.equal(s.n.items[0].reason, "VIP movement — brief ground holds possible 4:20–6:20 PM");
  assert.equal(s.n.items[0].text, "VIP movement nearby: flight restrictions 4:20–6:20 PM — brief ground holds are possible.");
  assert.deepEqual(s.reasons[0], ["1 Space launch nearby — airspace restrictions until 3:20 PM"]);
  assert.deepEqual(s.reasons[2], ["2 VIP movement — brief ground holds possible 4:20–6:20 PM"]);
  assert.deepEqual(s.reasons[5], []);
  assert.equal(s.n.items[2].text, "Stadium event flight restrictions nearby until 5:20 PM — airline flights aren't affected.");
  // causes for the Settings categories
  assert.deepEqual(s.n.items.map((x) => [x.cause, x.cat]), [["vip", "vip"], ["space", "space"], ["security", "vip"]]);
  // within 30 nm of the area's edge counts; a long-standing information-only TFR doesn't
  assert.ok(tfrItem({ ...vip, areas: [{ ...circle(41.2, -73.874, 1) }] }, LGA, { now: NOW })); // ~24 nm away
  assert.equal(tfrItem({ ...vip, areas: [{ ...circle(41.5, -73.874, 1) }] }, LGA, { now: NOW }), null); // ~42 nm
  assert.equal(tfrItem({ ...stadium, to: null, areas: [{ ...circle(40.83, -73.93, 3), from: null, to: null }] }, LGA, { now: NOW }), null);
});

test("trips: a VIP movement or runway closure at a trip airport during the leg adds a concern (not a weather one)", () => {
  const t0 = Math.floor(+NOW / H) * H;
  const hrs = (reasons, level) => Array.from({ length: 24 }, (_, i) => ({ t: new Date(t0 + i * H).toISOString(), level: i >= 2 && i <= 4 ? level : 0, reasons: i >= 2 && i <= 4 ? reasons : [] }));
  const by = {
    DCA: { iata: "DCA", tz: "America/New_York", state: "DC", hours: hrs(["VIP movement — brief ground holds possible 4–7 PM"], 2) },
    ORD: { iata: "ORD", tz: "America/Chicago", state: "IL", hours: hrs(["Runway 10L/28R closed until Oct 5", "Mist"], 1) },
  };
  const trip = { legs: [{ from: "DCA", to: "ORD", dep: t0 + 3 * H, arr: t0 + 4 * H }] };
  const r = tripStatus(trip, by, { now: +NOW });
  const texts = r.concerns.map((c) => `${c.level} ${c.kind} ${c.text}`);
  assert.ok(texts.includes("2 notice VIP movement near DCA around your 5 PM departure — brief ground holds are possible."), texts.join("\n"));
  assert.ok(texts.some((t) => /^1 notice Runway 10L\/28R closed at ORD around your 5 PM arrival — usually only minor delays\.$/.test(t)), texts.join("\n"));
  assert.ok(!texts.some((t) => /weather .*VIP/.test(t)));
  assert.equal(r.status, "possible");
  assert.deepEqual(noticeOf("Runway 4L/22R closed"), { kind: "runway", level: 1 });
  assert.equal(noticeOf("Rain"), null);
});

test("permanent VIP protection is context; open-ended temporary movement still warns", () => {
 const vip = {id:"9/2934",type:"VIP",text:"2608141107-PERM",from:+NOW-H,to:null,areas:[{circles:[{lat:LGA.lat,lon:LGA.lon,nm:1}]}]};
 const s = score(LGA, [], [], {tfrs:[vip]});
 assert.equal(s.n.items[0].level,0); assert.equal(s.n.items[0].at,"none");
 assert.match(s.n.items[0].text,/Permanent VIP protection/);
 assert.ok(s.hs.every(h=>h.level===0));
 assert.equal(tfrItem({...vip,text:"Temporary VIP movement"}, LGA,{now:NOW}).level,2);
});
