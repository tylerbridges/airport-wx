import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mapNationalAlerts} from './nws-wide.mjs';
const polygon={type:'Polygon',coordinates:[[[-100,25],[-90,25],[-90,35],[-100,35],[-100,25]]]};
const airports=[{iata:'DAL',lon:-97,lat:32},{iata:'JFK',lon:-73,lat:41}];
const zone='https://api.weather.gov/zones/forecast/TXZ001';
test('national NWS alerts match polygons and zone geometry; zone cache prevents repeated calls',async()=>{
 const cacheDir=await mkdtemp(join(tmpdir(),'awx-zones-'));let calls=0;
 try{
  const snapshot={features:[{id:'warning',geometry:polygon,properties:{event:'Tornado Warning'}},{id:'watch',geometry:null,properties:{event:'Winter Storm Watch',affectedZones:[zone]}}]};
  const getZone=async()=>{calls++;return {geometry:{type:"GeometryCollection",geometries:[polygon]}};};
  const map=await mapNationalAlerts({airports,snapshot,getZone,cacheDir});
  assert.deepEqual(map.DAL.features.map(a=>a.id),['warning','watch']);assert.equal(map.JFK.features.length,0);
  await mapNationalAlerts({airports,snapshot,getZone,cacheDir});assert.equal(calls,1);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});
test('NWS malformed or unresolved geography never produces a quiet alert map',async()=>{
 const cacheDir=await mkdtemp(join(tmpdir(),'awx-zones-'));
 try{
  await assert.rejects(mapNationalAlerts({airports,snapshot:{},getZone:async()=>{},cacheDir}),/no features/);
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:null,properties:{affectedZones:[zone]}}]},getZone:async()=>{throw new Error('zone unavailable');},cacheDir}),/zone unavailable/);
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:null,properties:{}}]},getZone:async()=>{},cacheDir}),/no geographic/);
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[],pagination:{next:'next-page'}},getZone:async()=>{},cacheDir}),/pagination/);
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:{type:'Point',coordinates:[-97,32]}}]},getZone:async()=>{},cacheDir}),/invalid/);
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:{type:'Polygon',coordinates:[[[NaN,32],[-90,25],[-90,35],[-100,35]]]}}]},getZone:async()=>{},cacheDir}),/invalid/);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});

test('SAME-only county alert resolves and caches its precise county geometry',async()=>{
 const cacheDir=await mkdtemp(join(tmpdir(),'awx-same-'));const urls=[];
 try{
  // Live NWS Local Area Emergency shape: Bannock County, no polygon or affectedZones.
  const alert={id:'county-emergency',geometry:null,properties:{event:'Local Area Emergency',areaDesc:'bannock county',affectedZones:[],geocode:{SAME:['016005']}}};
  const getZone=async url=>{urls.push(url);return {geometry:polygon};};
  const map=await mapNationalAlerts({airports,snapshot:{features:[alert]},getZone,cacheDir});
  assert.deepEqual(urls,['https://api.weather.gov/zones/county/IDC005']);
  assert.deepEqual(map.DAL.features,[alert]);assert.deepEqual(map.JFK.features,[]);
  await mapNationalAlerts({airports,snapshot:{features:[alert]},getZone,cacheDir});assert.equal(urls.length,1);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});
test('SAME fallback never broadens subdivisions, statewide codes or partially unresolved coverage',async()=>{
 const cacheDir=await mkdtemp(join(tmpdir(),'awx-same-'));
 try{
  for(const codes of [['116005'],['016000'],['099005'],['016005','116005'],['bad'],[16005]]){
   await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:null,properties:{geocode:{SAME:codes}}}]},getZone:async()=>{throw new Error('must not request widened geography');},cacheDir}),/no geographic/);
  }
  await assert.rejects(mapNationalAlerts({airports,snapshot:{features:[{geometry:null,properties:{geocode:{SAME:['016005']}}}]},getZone:async()=>({geometry:null}),cacheDir}),/geometry unavailable/);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});
test('published polygon and affected zones take priority over SAME fallback',async()=>{
 const cacheDir=await mkdtemp(join(tmpdir(),'awx-same-'));const urls=[];
 try{
  const a={id:'polygon',geometry:polygon,properties:{geocode:{SAME:['116005']}}};
  const b={id:'zones',geometry:null,properties:{affectedZones:[zone],geocode:{SAME:['016005']}}};
  const map=await mapNationalAlerts({airports,snapshot:{features:[a,b]},getZone:async url=>{urls.push(url);return {geometry:polygon};},cacheDir});
  assert.deepEqual(urls,[zone]);assert.deepEqual(map.DAL.features.map(x=>x.id),['polygon','zones']);
 }finally{await rm(cacheDir,{recursive:true,force:true});}
});
