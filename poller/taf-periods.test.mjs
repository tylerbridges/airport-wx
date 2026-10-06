import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tafPeriods } from './taf-periods.mjs';
const H = 3600000, t = Date.parse('2026-10-06T18:00:00Z');
const base = { timeFrom:t/1000, timeTo:(t+12*H)/1000, wdir:180,wspd:12,visib:'6+',clouds:[{cover:'SCT',base:4000}] };
const taf = groups => ({validTimeFrom:t/1000,validTimeTo:(t+12*H)/1000,fcsts:[base,...groups]});
test('forecast periods keep exact FM boundaries, units and visibility limits',()=>{
 const rows=tafPeriods(taf([{fcstChange:'FM',timeFrom:(t+2*H+30*60000)/1000,wdir:270,wspd:8,visib:2,wxString:'BR',clouds:[{cover:'BKN',base:800}]}]));
 assert.equal(rows.length,2);assert.equal(rows[0].to,'2026-10-06T20:30:00.000Z');
 assert.equal(rows[0].cond.visibilityAbove,true);assert.equal(rows[1].cond.ceiling,800);assert.equal(rows[1].cond.fltCat,'IFR');
});
test('temporary and probability windows inherit changing winds without replacing prevailing conditions',()=>{
 const rows=tafPeriods(taf([{fcstChange:'FM',timeFrom:(t+4*H)/1000,wdir:270,wspd:8,visib:'6+',clouds:[{cover:'SCT',base:5000}]},
 {fcstChange:'TEMPO',timeFrom:(t+2*H)/1000,timeTo:(t+6*H)/1000,visib:2,wxString:'TSRA',clouds:[{cover:'BKN',base:1500}]},
 {fcstChange:'PROB',probability:30,timeFrom:(t+8*H)/1000,timeTo:(t+10*H)/1000,wxString:'SHRA'}]));
 const temp=rows.filter(r=>r.kind==='TEMPO');assert.equal(temp.length,2);assert.deepEqual(temp.map(r=>r.cond.wind.dir),[180,270]);
 assert.equal(rows.find(r=>r.kind==='PROB').probability,30);
 assert.ok(rows.filter(r=>r.kind==='prevailing').every(r=>r.cond.wx===null));
});
test('gradual changes retain the change window and become prevailing at timeBec',()=>{
 const rows=tafPeriods(taf([{fcstChange:'BECMG',timeFrom:(t+2*H)/1000,timeTo:(t+4*H)/1000,timeBec:(t+4*H)/1000,visib:2,clouds:[{cover:'OVC',base:700}]}]));
 const change=rows.find(r=>r.kind==='BECMG');assert.equal(change.from,'2026-10-06T20:00:00.000Z');assert.equal(change.to,'2026-10-06T22:00:00.000Z');
 assert.equal(change.cond.wind.spd,12);assert.equal(rows.filter(r=>r.kind==='prevailing')[1].cond.ceiling,700);
});
test('missing base or validity cannot invent decoded forecasts',()=>{
 assert.deepEqual(tafPeriods(null),[]);assert.deepEqual(tafPeriods({fcsts:[base]}),[]);
 assert.deepEqual(tafPeriods({...taf([]),fcsts:[{fcstChange:'TEMPO'}]}),[]);
});

test('real Punta Gorda TAF preserves the temporary shower window and prevailing wind',()=>{
 const taf = JSON.parse(readFileSync(new URL('./fixtures/taf-pgd-real.json', import.meta.url)))[0];
 const rows = tafPeriods(taf), temporary = rows.find(r=>r.kind==='TEMPO');
 assert.equal(rows.length,4);
 assert.equal(temporary.from,'2026-10-06T21:00:00.000Z');assert.equal(temporary.to,'2026-10-07T01:00:00.000Z');
 assert.deepEqual(temporary.cond.wind,{dir:220,spd:7});assert.equal(temporary.cond.wx,'SHRA');assert.equal(temporary.cond.ceiling,3000);
 assert.equal(rows.at(-1).cond.wind.dir,'VRB');assert.equal(rows.at(-1).cond.visibilityAbove,true);
});
