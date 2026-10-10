import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), O = require('../site/outlook.js'), S = require('../site/split.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/severity-tyr.json', import.meta.url)));
const copy = x => structuredClone(x), H = 3600e3;
const opts = (build, now) => ({ now, generated: build.generated, sources: build.sources });
function equivalent(build, now) {
  const {summary, details} = S.split(build), a = build.airports[0];
  const slim = O.withObsHour(summary.airports[0], now), full = O.withObsHour(a, now);
  const restored = S.restore(slim, details[a.iata].airport), options = opts(build, now);
  const expected = O.evaluate(full, options);
  for (const x of [slim, restored]) {
    const norm = o => ({ ...o, window: o.window ? { ...o.window, hour:o.window.hour.t } : null });
    assert.deepEqual(norm(O.evaluate(x, options)), norm(expected));
    const sm = O.summary(x, options);
    assert.equal(sm.current.level, expected.level);
    assert.equal(sm.nowLevel, expected.level, 'unknown cannot fall back to Clear');
    assert.equal(sm.byT.get(x.hours.find(h => Date.parse(h.t) <= now && now < Date.parse(h.t) + H)?.t), expected.level);
  }
  return expected;
}
test('TYR run 38025565205: known to unknown at the recovered METAR expiry, inside a minute', () => {
  const {build, before, after} = fixture;
  assert.equal(equivalent(build, Date.parse(before)).level, 0);
  const end = Date.parse(build.airports[0].metar.obsTime) + 2 * H;
  assert.equal(O.nextChange(build.airports[0], opts(build, Date.parse(before))), end + 1);
  assert.equal(equivalent(build, end).level, 0);
  assert.equal(equivalent(build, end + 1).level, null);
  assert.equal(equivalent(build, Date.parse(after)).kind, 'unknown');
});
test('split arrival order: another generation cannot fill absent severity, reasons or delay overrides', () => {
  const build = copy(fixture.build), now = Date.parse(fixture.before), a = build.airports[0];
  delete a.hours[0].level; delete a.hours[0].reasons;
  const {summary,details} = S.split(build), old = copy(details.TYR.airport);
  old.hours[0].level = 3; old.hours[0].reasons = ['Dense fog']; old.hours[0].delay.override = 'ground_delay';
  for (const detail of [null, old, null, old]) {
    const restored = S.restore(summary.airports[0], detail);
    assert.equal(O.evaluate(restored, opts(build,now)).level, null);
    assert.equal(restored.hours[0].reasons, undefined);
    assert.equal(restored.hours[0].delay.override, undefined);
  }
  // Summary before detail, or detail before summary: the new summary's unknown state wins both orders.
  const newer = copy(build); newer.generated = new Date(now + 1000).toISOString();
  const newSlim = S.split(newer).summary.airports[0];
  assert.equal(O.evaluate(S.restore(newSlim, old), opts(newer, now)).level, null);
});
test('relay refresh replaces coverage and severity together, then expiry qualifies the new snapshot', () => {
  const b = copy(fixture.build), now = Date.parse(fixture.after), a = b.airports[0];
  assert.equal(equivalent(b,now).level, null);
  b.generated = new Date(now).toISOString();
  a.metar.obsTime = b.generated;
  a.coverage = { generated:b.generated, sources:copy(b.sources) };
  assert.equal(equivalent(b,now).level, 0);
  a.hours[0].level = 3; a.hours[0].reasons = ['Visibility 1/4 sm'];
  assert.equal(equivalent(b,now).level, 3);
  a.hours[0].level = 0; a.hours[0].reasons = [];
  a.coverage.sources.metar.ok = false;
  assert.equal(equivalent(b,now).level, null);
});
test('hour rollover and observed-next expiry are equivalent before and after detail restoration', () => {
  const b = copy(fixture.build), a = b.airports[0], now = Date.parse('2026-10-10T05:00:00Z');
  b.generated = '2026-10-10T04:59:00Z';
  a.metar.obsTime = '2026-10-10T04:00:00Z';
  for (const s of Object.values(b.sources)) s.at = b.generated;
  a.hours[1].level = 3; a.hours[1].reasons = ['Low clouds'];
  a.obsNext = { ...a.hours[1], level:0, reasons:[] };
  assert.equal(equivalent(b,now-1).level, 0);
  assert.equal(equivalent(b,now).level, 0);
  assert.equal(equivalent(b,now+15*60000).level, 0);
  assert.equal(equivalent(b,now+15*60000+1).level, 3);
});
test('scheduled restriction and source expiry refresh precisely, preserving known disruptions', () => {
  const b = copy(fixture.build), a = b.airports[0], now = Date.parse(fixture.before);
  a.faa = [{ type:'ground_stop', end:new Date(now+500).toISOString() }];
  assert.equal(O.nextChange(a,opts(b,now)),now+500);
  assert.equal(equivalent(b,now).level,4);
  assert.equal(equivalent(b,now+500).level,0);
  a.faa[0].end = new Date(now).toISOString();
  a.coverage = { generated:b.generated, sources:copy(b.sources) };
  a.coverage.sources.faa.at = new Date(now-30*60000).toISOString();
  assert.equal(O.nextChange(a,opts(b,now)),now+1);
  assert.equal(equivalent(b,now+1).level,null);
  a.faa[0].end = new Date(now+1000).toISOString();
  assert.equal(equivalent(b,now+1).level,4);
});
