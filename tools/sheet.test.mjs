import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("Settings-to-calendar handoff reuses history; Back closes the calendar once", () => {
  const events = {}, states = [{}]; let at = 0, backs = 0, closes = 0;
  const element = () => ({style:{},addEventListener(){},contains(){return true;}});
  const body = {...element(),classList:{contains(){return false;}},getAttribute(){return null;},removeAttribute(){}};
  const document = {body,dispatchEvent(){},documentElement:{classList:{add(){},remove(){}}},addEventListener(){},removeEventListener(){}};
  const history = {get state(){return states[at];},pushState(s){states.splice(++at);states[at]=s;},replaceState(s){states[at]=s;},back(){backs++;at--;events.popstate();}};
  const window = {history,document,addEventListener(k,f){events[k]=f;},scrollTo(){},scrollY:0}; window.top=window;
  runInNewContext(readFileSync(new URL('../site/sheet.js', import.meta.url), 'utf8'), {window,document,history,Event:class {constructor(type){this.type=type;}}});
  const settings = window.AWXSheet.makeSheet(element());
  const calendar = window.AWXSheet.makeSheet(element(), {onClose(){closes++;calendar.closed();}});
  settings.opened();
  window.AWXSheet.transfer(() => settings.closed(), () => calendar.opened());
  assert.equal(backs,0,"no pending Back event can dismiss the newly opened calendar");
  assert.equal(states.length,2,"the old sheet's entry is reused");
  assert.equal(window.AWXSheet.openCount(),1);
  assert.equal(calendar.isOpen(),true);
  history.back();
  assert.equal(closes,1); assert.equal(window.AWXSheet.openCount(),0);
});


test("App sheet locking preserves the viewport and announces every visibility change", () => {
  const style = {position:"relative"}, notices = []; let scrollCalls = 0;
  const body = {style,classList:{contains:k=>k==="awx-nav-on"},getAttribute:()=>"position:relative"};
  const document = {body,documentElement:{classList:{add(){},remove(){}}},
    addEventListener(){},removeEventListener(){},dispatchEvent:e=>notices.push(e.type)};
  const window = {document,scrollY:0,scrollTo(){scrollCalls++;},addEventListener(){}};
  window.top = {};
  runInNewContext(readFileSync(new URL('../site/sheet.js', import.meta.url), 'utf8'),
    {window,document,Event:class {constructor(type){this.type=type;}}});
  const ctl=window.AWXSheet.makeSheet({style:{},addEventListener(){},contains(){return true;}});
  ctl.opened(); assert.equal(body.style.position,"relative");
  ctl.closed(); assert.deepEqual(body.style,{position:"relative"});
  assert.equal(scrollCalls,0,"dismissal must not trigger viewport scrolling");
  assert.deepEqual(notices,["awx:sheet-change","awx:sheet-change"]);
});
