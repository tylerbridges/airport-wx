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
