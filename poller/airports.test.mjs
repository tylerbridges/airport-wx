import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {monitoredAirports,loadMonitoredAirports} from './airports.mjs';
import {FIELDS} from '../tools/build-airports.mjs';
test('live coverage includes US airline airports with weather, preserving baseline metadata',async()=>{
 const baseline=[{iata:'ORD',icao:'KORD',tz:'America/Chicago',name:'Curated name'}];
 const row=(iata,icao,country,scheduled=1,metar=1)=>[iata,icao,iata,'City',country,country==='US'?'US-TX':country+'-X',30,-97,0,scheduled,metar,1,'M',[]];
 const catalog={f:FIELDS,tz:['America/Chicago'],a:[row('ORD','KORD','US'),row('DAL','KDAL','US'),row('SJU','TJSJ','PR'),row('YYZ','CYYZ','CA'),row('ZZZ','KZZZ','US',0),row('XXX','KXXX','US',1,0)]};
 const result=monitoredAirports(baseline,catalog);
 assert.deepEqual(result.map(a=>a.iata),['ORD','DAL','SJU']);
 assert.equal(result[0].name,'Curated name');assert.equal(result[1].state,'TX');assert.equal(result[2].state,'PR');
 const fixture=await loadMonitoredAirports({fixtures:true});
 assert.equal(fixture.length,JSON.parse(await readFile(new URL('../airports.json',import.meta.url))).length);
 const live=await loadMonitoredAirports();
 for(const code of ['DAL','HOU','OAK','SJC','SNA','BUR','ONT','MSY','SAT','RDU','BZN','SJU','GUM']) assert.ok(live.some(a=>a.iata===code),code);
 assert.ok(live.length>500);
 assert.equal(new Set(live.map(a=>a.iata)).size,live.length);
});
