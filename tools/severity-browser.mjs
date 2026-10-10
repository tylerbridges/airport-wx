// Frozen 390px lifecycle regression. Node built-ins and a locally installed Chromium only.
// node tools/severity-browser.mjs [--site /path/to/site] (CHROME overrides the executable)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture = JSON.parse(await readFile(new URL('./fixtures/severity-tyr.json', import.meta.url)));
const root = resolve(process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : 'site');
const server = createServer(async (req,res) => {
  try {
    const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith(root + '/')) throw Error('path');
    const bytes = await readFile(path);
    res.setHeader('Content-Type', ({'.js':'text/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'})[extname(path)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(),'awx-severity-'));
const chrome = spawn(process.env.CHROME || 'chromium', ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore','ignore','ignore','pipe','pipe']});
const pause = ms=>new Promise(r=>setTimeout(r,ms));
let id=0, session, buffer=''; const pending = new Map();
chrome.stdio[4].on('data', bytes => {
  buffer += bytes.toString();
  let end;
  while ((end=buffer.indexOf('\0'))>=0) {
    const message=buffer.slice(0,end); buffer=buffer.slice(end+1);
    if (!message) continue;
    const m=JSON.parse(message), p=pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error?p.reject(m.error):p.resolve(m.result); }
  }
});
const cmd=(method,params={})=>new Promise((resolve,reject)=>{
  const n=++id, timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method));},20000);
  pending.set(n,{resolve,reject,timer});
  chrome.stdio[3].write(JSON.stringify({id:n,method,params,...(session&&!method.startsWith('Target.')?{sessionId:session}:{})})+'\0');
});
try {
  const {targetId}=await cmd('Target.createTarget',{url:'about:blank'});
  ({sessionId:session}=await cmd('Target.attachToTarget',{targetId,flatten:true}));
  const js=async expression=>{ if (expression.includes('await ') && !expression.trim().startsWith('(async')) expression='(async()=>{'+expression+'})()'; const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value; };
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__severityBuild = ${JSON.stringify(fixture.build)};
    window.__severityClock = ${Date.parse(fixture.before)};
    Date.now = () => window.__severityClock;
    window.__severityRelay = null;
    window.__severityDetail = null;
    window.__severityErrors = [];
    addEventListener('error',e=>__severityErrors.push(e.message));
    addEventListener('unhandledrejection',e=>__severityErrors.push(String(e.reason)));
    const originalError=console.error; console.error=(...args)=>{__severityErrors.push(args.map(String).join(' '));originalError(...args);};
    const originalFetch = fetch;
    window.fetch = async (url, opts) => {
      const path = new URL(typeof url === 'string' ? url : url.url, location.href).pathname;
      const answer = data => new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}});
      if (path.endsWith('/data/summary.json')) {
        if(window.__severityHoldSummary) await new Promise(r=>window.__severityReleaseSummary=r);
        return answer(AWXSplit.split(__severityBuild).summary);
      }
      if (path.endsWith('/data/config.json')) return answer({liveUrl:location.origin+'/relay'});
      if (path.endsWith('/relay/status')) return answer(__severityRelay || {...__severityBuild,live:true,generated:new Date(__severityClock).toISOString(),airports:[]});
      if (path.endsWith('/data/airport/TYR.json')) {
        if (window.__severityHoldDetail) await new Promise(r=>window.__severityReleaseDetail=r);
        return answer(__severityDetail || AWXSplit.split(__severityBuild).details.TYR);
      }
      if (['trips','changes','movement','accuracy'].some(k=>path.includes('/data/'+k))) return new Response('',{status:404});
      return originalFetch(url, opts);
    };
  `});
  await cmd('Page.navigate',{url:origin+'/index.html?nosw=1'});
  for (let i=0;i<100;i++){if(await js('!!window.AWXApp?.state.loaded && !!document.getElementById("tab-map")'))break;await pause(50);}
  await js("document.getElementById('tab-map').click()");
  for(let i=0;i<100;i++){if(await js('!!window.AWXMap'))break;await pause(25);}
  const inspect = async (label, level) => {
    const result = await js(`(async()=>{
      const A=AWXApp; A.state.filter='all';
      if (!document.querySelector('.card[data-iata="TYR"]')) A.render();
      A.openSheet('TYR'); await A.detailReady('TYR');
      AWXMap.setFilter('all'); AWXMap.setOffset(0);
      const m=AWXMap._state(), a=A.state.data.airports.find(x=>x.iata==='TYR');
      const card=document.querySelector('.card[data-iata="TYR"]'), sh=document.querySelector('#sheet .bx-layer[data-layer="rest"] .sc-head');
      const map=document.querySelector('.map-airport-row[data-code="TYR"]');
      A.ensureCardTimeline(card); const tl=card.querySelector('.tl-wrap')._tl;
      const value=el=>el?.hasAttribute('data-level')?Number(el.dataset.level):null;
      if (!card) return {missing:true, errors:__severityErrors, text:document.body.innerText.slice(0,2500),state:A.state};
      return {card:card.dataset.level, badge:value(card.querySelector('.badge')), detail:value(sh),
        outlook:A.outlook(a).level, summary:A.summary(a).nowLevel, map:m.levels.TYR, timeline:tl.slots[tl.day.cur].level,
        cardLabel:card.getAttribute('aria-label'), mapLabel:map?.getAttribute('aria-label'),
        mapClass:map?.className, time:A.refNow(), generated:A.state.data.generated, relay:A.state.data.live,
        errors:__severityErrors};
    })()`);
    assert.equal(result.card,level==null?'unknown':String(level),label+' card');
    for (const k of ['badge','detail','outlook','summary','map','timeline']) assert.equal(result[k],level,label+' '+k+' '+JSON.stringify(result));
    assert.match(result.cardLabel,level==null?/Status unconfirmed/:new RegExp(['Clear','Minor','Moderate','High','Severe'][level]+' risk'));
    assert.equal(/\bunknown\b/.test(result.mapClass),level==null,label+' accessible map state');
    assert.ok(result.mapLabel,label+' accessible map label');
    assert.match(result.mapLabel, level==null?/unavailable|unconfirmed|outdated|Offline/:new RegExp(['Clear','Minor','Moderate','High','Severe'][level]),label+' accessible map wording'); assert.deepEqual(result.errors,[]);
    console.log('PASS',label,JSON.stringify(result));
    await js('AWXApp.closeSheet()');
  };
  await inspect('before METAR expiry',0);
  const hasRefresh = await js("typeof AWXApp.refresh==='function'"); // allow the same regression to demonstrate the baseline failure
  if (hasRefresh) await js('__severityHoldSummary=true; void(window.__severityPendingRefresh=AWXApp.refresh())');
  await js(`__severityClock=${Date.parse(fixture.after)}`);
  await pause(1200); // the scheduled validity timer must refresh cards too, without a fetch or manual render
  await inspect('after METAR expiry during a pending refresh',null);
  if(hasRefresh) assert.equal(await js('!!window.__severityReleaseSummary'),true,'summary fetch is held across expiry');
  await js('__severityHoldSummary=false;__severityReleaseSummary()');
  await js('__severityPendingRefresh');
  await js('await AWXApp.refresh()');
  await inspect('after summary/detail refresh',null);
  // A relay generation changes current severity when opening a sheet; details from the build cannot override it.
  await js(`__severityRelay=structuredClone(__severityBuild);__severityRelay.live=true;
    __severityRelay.generated=new Date(__severityClock).toISOString();
    const a=__severityRelay.airports[0];a.metar.obsTime=__severityRelay.generated;
    a.hours[0].level=3;a.hours[0].reasons=['Visibility 1/4 sm'];a.hours[0].vis=0.25;
    AWXApp.openSheet('TYR');`);
  await pause(550);
  await inspect('relay refresh, build detail retained',3);
  await js('await AWXApp.refresh()');
  await inspect('relay after refresh',3);
  await js(`__severityRelay=structuredClone(__severityBuild);__severityRelay.live=true;await AWXApp.refresh();`);
  await inspect('late older relay cannot roll back severity',3);
  // A delayed old detail arrives after a new summary. It must never revive an unavailable hour.
  await js(`__severityDetail=AWXSplit.split(__severityBuild).details.TYR;__severityRelay=null;
    __severityBuild=structuredClone(__severityBuild);__severityBuild.generated=new Date(__severityClock+1000).toISOString();
    delete __severityBuild.airports[0].hours[0].level; __severityBuild.airports[0].hours[0].reasons=[];
    __severityHoldDetail=true;AWXApp.closeSheet();await AWXApp.refresh();AWXApp.openSheet('TYR');`);
  await inspectWithoutDetail();
  async function inspectWithoutDetail(){
    assert.equal(await js('document.querySelector(".card[data-iata=TYR]").dataset.level'),'unknown','new summary before old detail');
    await js('__severityHoldDetail=false;__severityReleaseDetail()');
    await inspect('new summary followed by old detail',null);
  }
  // New data at the hour boundary should replace hour 1 with obsNext, then revert at its 75-minute expiry.
  await js(`__severityDetail=null;__severityBuild=${JSON.stringify(fixture.build)};__severityClock=Date.parse('2026-10-10T04:59:59Z');
    __severityBuild.generated='2026-10-10T04:59:00Z';
    for(const s of Object.values(__severityBuild.sources))s.at=__severityBuild.generated;
    const a=__severityBuild.airports[0];a.metar.obsTime='2026-10-10T04:00:00Z';a.hours[1].level=3;a.hours[1].reasons=['Low clouds'];
    a.obsNext={...a.hours[1],level:0,reasons:[]};await AWXApp.refresh();`);
  await inspect('before hour rollover',0);
  await js("__severityClock=Date.parse('2026-10-10T05:00:00Z')");await pause(1200);
  await inspect('hour rollover',0);
  await js("__severityClock=Date.parse('2026-10-10T05:15:00.001Z'); AWXApp.render()");
  await inspect('observed-next expiry',3);
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  chrome.kill(); if(chrome.exitCode==null) await new Promise(r=>chrome.once('exit',r));
  server.close(); await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
