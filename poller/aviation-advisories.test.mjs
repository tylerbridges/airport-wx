import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sigmetAdvisoriesAt, altitudeWords } from "./aviation-advisories.mjs";
import { assemble } from "./core.mjs";
import { tripStatus } from "./trip-risk.mjs";
const now = new Date("2026-10-04T23:00:00Z");
const area = {icaoId:"KKCI",seriesId:"1",hazard:"TURB",qualifier:"SEV",base:28000,top:42000,geom:"AREA",validTimeFrom:+now/1000-1800,validTimeTo:+now/1000+3600,coords:[{lon:-89,lat:40},{lon:-86,lat:40},{lon:-86,lat:43},{lon:-89,lat:43}],rawSigmet:"SEV TURB FL280/420"};
const here = records => sigmetAdvisoriesAt(-87.9,41.9,records,now);
test("operational advisory keeps altitude, exact time and hazard separate from convection",()=>{
 const x=here([area])[0];assert.equal(x.title,"Severe turbulence");assert.match(x.text,/28,000–42,000 ft/);assert.equal(x.to,new Date(+now+3600e3).toISOString());
 assert.equal(here([{...area,hazard:"CONVECTIVE"}]).length,0);
 assert.equal(here([{...area,qualifier:"MOD",rawSigmet:"MOD TURB"}]).length,0);
 assert.match(here([{...area,hazard:"ICE"}])[0].text,/Severe icing/);
 assert.match(here([{...area,hazard:"VA",base:0,top:22000}])[0].text,/surface to 22,000 ft/);
 assert.equal(altitudeWords(null,null),"altitude not specified");
});
test("time/location filtering rejects expired, malformed and distant advisories, allows upcoming",()=>{
 for(const change of [{validTimeTo:+now/1000},{validTimeFrom:null},{validTimeTo:null},{base:45000,top:42000},{geom:"LINE"},{coords:[{lat:41,lon:null},{lat:42,lon:-87},{lat:43,lon:-88}]}])assert.equal(here([{...area,...change}]).length,0);
 assert.equal(sigmetAdvisoriesAt(-122,47,[area],now).length,0);
 assert.equal(here([{...area,validTimeFrom:+now/1000+1800}]).length,1);
 assert.equal(here([area,area]).length,1);
 assert.deepEqual(here([null, {}, {...area, coords:{}}, {...area,coords:[{lat:40,lon:-89},{lat:41,lon:-88},{lat:42,lon:-87}]}]),[]);
});
test("date-line polygon matches the Aleutians and excludes Greenwich",()=>{
 const x={...area,coords:[{lat:50,lon:179},{lat:50,lon:-179},{lat:53,lon:-179},{lat:53,lon:179}]};
 assert.equal(sigmetAdvisoriesAt(180,51,[x],now).length,1);
 assert.equal(sigmetAdvisoriesAt(0,51,[x],now).length,0);
});
test("real NOAA samples support international turbulence, icing and volcanic ash",async()=>{
 const fx=JSON.parse(await readFile(new URL('./fixtures/sigmet-advisories-real.json',import.meta.url),'utf8'));
 for(const x of fx.records){const c=x.coords[0],n=sigmetAdvisoriesAt(Number(c.lon),Number(c.lat),[x],new Date((x.validTimeFrom+1)*1000));assert.equal(n.length,1,x.hazard);assert.equal(n[0].hazard,x.hazard);}
});
test("high-altitude advisories add useful trip context without raising airport or delay risk",()=>{
 const a={iata:"ORD",icao:"KORD",tz:"America/Chicago",lon:-87.9,lat:41.9};
 const options={airports:[a],now,metars:[],tafs:[],sigmets:[],faaParsed:null,spc:null,nws:null};
 const clean=assemble(options)[0],withHazard=assemble({...options,isigmets:[area]})[0];
 assert.deepEqual(withHazard.hours,clean.hours);assert.deepEqual(withHazard.now,clean.now);assert.equal(withHazard.aviationAdvisories.length,1);
 const trip={legs:[{from:"ORD",to:"ORD",dep:+now+10*60e3,arr:+now+30*60e3}]};
 const result=tripStatus(trip,{ORD:withHazard},{now:+now});const notes=result.concerns.filter(c=>/Severe turbulence/.test(c.text));
 assert.equal(notes.length,2);assert.ok(notes.every(c=>c.level===0&&c.kind==="note"));assert.match(notes[0].text,/28,000–42,000 ft/);
 assert.equal(tripStatus({...trip,legs:[{...trip.legs[0],dep:+now+3600e3,arr:+now+7200e3}]},{ORD:withHazard},{now:+now}).concerns.filter(c=>/Severe turbulence/.test(c.text)).length,0);
});
