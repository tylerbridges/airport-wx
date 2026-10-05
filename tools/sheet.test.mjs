import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("Settings-to-calendar handoff reuses history; Back closes the calendar once", () => {
  const events = {}, states = [{}]; let at = 0, backs = 0, closes = 0;
  const element = () => ({style:{},addEventListener(){},contains(){return true;}});
  const body = {...element(),getAttribute(){return null;},removeAttribute(){}};
  const document = {body,documentElement:{classList:{add(){},remove(){}}},addEventListener(){},removeEventListener(){}};
  const history = {get state(){return states[at];},pushState(s){states.splice(++at);states[at]=s;},replaceState(s){states[at]=s;},back(){backs++;at--;events.popstate();}};
  const window = {history,document,addEventListener(k,f){events[k]=f;},scrollTo(){},scrollY:0}; window.top=window;
  runInNewContext(readFileSync(new URL('../site/sheet.js', import.meta.url), 'utf8'), {window,document,history});
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
