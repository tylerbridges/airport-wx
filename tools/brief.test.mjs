// brief hook: site/brief.js helpers in Node, and every scenario's changes.json is well-formed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { changeProblems, KINDS } from "../site/brief.js";
import * as C from "../poller/changes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("brief: changeProblems flags malformed change logs", () => {
  const ok = { v: 1, generated: "2026-10-04T12:00:00.000Z", events: [{ t: "2026-10-04T11:00:00.000Z", iata: "ORD", kind: "level", from: 1, to: 2, sentence: "Risk up to Moderate" }] };
  assert.deepEqual(changeProblems(ok, new Set(["ORD"])), []);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], sentence: "Delays 45%" }] })[0], /bad sentence/);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], kind: "nope" }] })[0], /unknown kind/);
  assert.match(changeProblems(ok, new Set(["MSP"]))[0], /unknown airport/);
  assert.match(changeProblems({ ...ok, events: [{ ...ok.events[0], t: "2026-10-02T11:00:00.000Z" }] })[0], /older than 36 h/);
  assert.deepEqual(changeProblems(null), ["not a changes.json (v 1 with events[])"]);
});

test("brief: every scenario's changes.json is well-formed and matches its status", async () => {
  const dir = join(ROOT, "site/data/scenarios");
  const idx = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  let total = 0;
  for (const sc of idx.scenarios) {
    const st = JSON.parse(await readFile(join(dir, sc.file), "utf8"));
    const ch = JSON.parse(await readFile(join(dir, sc.name, "changes.json"), "utf8"));
    assert.deepEqual(changeProblems(ch, new Set(st.airports.map((a) => a.iata))), [], sc.name);
    assert.equal(ch.generated, st.generated, `${sc.name}: built from its own status`);
    total += ch.events.length;
  }
  assert.ok(total > 0);
  assert.deepEqual(new Set(KINDS), new Set(["level", "program_start", "program_end", "program_extend", "closure_start", "closure_end", "warning", "word", "plan_gs_add", "plan_gs_drop", "movement"]));
  assert.ok(C.KEEP_MS === 36 * 3600e3);
});

// Device visit summaries use recorded events, not changes in data availability.
const {createVisits, selectChanges, meaningful, SEEN_KEY} = await import('../site/since.js');
test('since checked: first visit seeds; refresh retains summary; new visit and dismiss acknowledge it', () => {
  const now=Date.parse('2026-10-08T12:00Z');let raw=null;
  const storage={getItem:()=>raw,setItem:(k,v)=>{assert.equal(k,SEEN_KEY);raw=v;}};
  const v=createVisits(storage);v.begin(now);
  const e={iata:'MSP',t:new Date(now-60000).toISOString(),kind:'level',from:0,to:3,sentence:'Risk up to High'};
  const log={generated:new Date(now).toISOString(),events:[e]};
  assert.deepEqual(selectChanges(log,['MSP'],v.baseline(log,['MSP']),now),[]);
  v.checkpoint(log,['MSP'],now);v.begin(now+600000);
  const next={generated:new Date(now+600000).toISOString(),events:[e,{...e,t:new Date(now+300000).toISOString(),from:3,to:0,sentence:'Risk down to Clear'}]};
  assert.equal(selectChanges(next,['MSP'],v.baseline(next,['MSP']),now+600000).length,1);
  v.checkpoint(next,['MSP'],now+600000);
  assert.equal(selectChanges(next,['MSP'],v.baseline(next,['MSP']),now+600000).length,1,'refresh cannot erase the current visit summary');
  v.begin(now+600000);
  assert.equal(selectChanges(next,['MSP'],v.baseline(next,['MSP']),now+600000).length,0);
});
test('since checked: delayed event publication, irrelevant airports, minor noise, duplicates and history cutoff',()=>{
  const now=Date.parse('2026-10-08T12:00Z'),base={MSP:{at:now-600000,keys:[]}};
  const e={iata:'MSP',t:new Date(now-900000).toISOString(),kind:'program_start',to:'ground_stop',sentence:'Ground stop started'};
  const events=[e,e,{...e,iata:'ORD'},{...e,kind:'level',from:0,to:1},{...e,t:new Date(now+60000).toISOString()},{...e,t:new Date(now-37*3600000).toISOString()}];
  assert.deepEqual(selectChanges({events},['MSP'],base,now),[e]);
  assert.equal(meaningful({...e,kind:'level',from:3,to:1}),true);
  assert.equal(meaningful({...e,kind:'movement'}),false);
});
test('since checked: latest state per event family; new favorites start without retrospective alerts',()=>{
  const now=Date.now(),storage={getItem:()=>null,setItem(){}};const v=createVisits(storage);v.begin(now);
  const log={generated:new Date(now).toISOString(),events:[{iata:'ORD',kind:'level',from:0,to:3,t:new Date(now-1000).toISOString(),sentence:'Risk up to High'}]};
  assert.deepEqual(selectChanges(log,['ORD'],v.baseline(log,['ORD']),now),[]);
  const baseline={ORD:{at:now-10000,keys:[]}};
  log.events.push({...log.events[0],t:new Date(now).toISOString(),from:3,to:0,sentence:'Risk down to Clear'});
  assert.deepEqual(selectChanges(log,['ORD'],baseline,now).map(e=>e.sentence),['Risk down to Clear']);
});
test('since checked: bad or blocked storage is safe and checkpoints contain only airport event cursors',()=>{
  const now=Date.now(),log={generated:new Date(now).toISOString(),events:[]};
  const v=createVisits({getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}});
  v.begin(now);v.baseline(log,['MSP']);assert.doesNotThrow(()=>v.checkpoint(log,['MSP'],now,true));
  v.begin(now);assert.deepEqual(selectChanges(log,['MSP'],v.baseline(log,['MSP']),now),[]);
  const invalid=createVisits({getItem:()=>'{bad',setItem(){}});assert.doesNotThrow(()=>invalid.begin(now));
});
