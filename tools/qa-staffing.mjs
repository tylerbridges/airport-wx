import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { assemble } from '../poller/core.mjs';
import { parseFaaXml, expandTemplate } from '../poller/lib.mjs';
import { parseAdvisory, finalizeAtcscc } from '../poller/sources.mjs';
import { writeSplit } from '../poller/poll.mjs';

// Synthetic candidate-only inputs, never written to production or presented as live FAA data.
await mkdir('qa-evidence', { recursive: true });
const now = new Date();
const airport = JSON.parse(await readFile('airports.json', 'utf8')).find(a => a.iata === 'ORD');
const fixture = async name => JSON.parse(expandTemplate(await readFile(`poller/fixtures/${name}.json`, 'utf8'), now));
const faaParsed = parseFaaXml('<AIRPORT_STATUS_INFORMATION><Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>ORD</ARPT><Reason>other</Reason><Avg>65 minutes</Avg><Max>90 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type></AIRPORT_STATUS_INFORMATION>', { now });
const text = expandTemplate(`ATCSCC ADVZY 053 ORD/ZAU {{mdy+0}} CDM GROUND DELAY PROGRAM
CTL ELEMENT: ORD
ELEMENT TYPE: APT
CUMULATIVE PROGRAM PERIOD: {{z-10}}Z - {{z+90}}Z
IMPACTING CONDITION: STAFFING / STAFFING
EFFECTIVE TIME: {{z-10}} - {{z+90}}
SIGNATURE: {{sig-10}}`, now);
const advisory = finalizeAtcscc([parseAdvisory(text, { now })], now);
const ord = assemble({ airports: [airport], now, metars: await fixture('metar'), tafs: await fixture('taf'), sigmets: [], faaParsed, spc: null, nws: {}, atcscc: advisory })[0];
assert.equal(ord.faa[0].reason, 'other');
assert.equal(ord.faa[0].cause, 'staffing');
assert.equal(ord.faa[0].causeLabel, 'air traffic control staffing');
assert.ok(ord.now.reasons.some(r => /air traffic control staffing/.test(r)));
const status = JSON.parse(await readFile('site/data/status.json', 'utf8'));
const old = status.airports.find(a => a.iata === 'ORD');
ord.notices = old.notices;
status.airports = status.airports.map(a => a.iata === 'ORD' ? { ...old, ...ord } : a);
status.generated = now.toISOString();
await writeFile('site/data/status.json', JSON.stringify(status));
await writeSplit(status, 'site/data');
await writeFile('qa-evidence/synthetic-cause.json', JSON.stringify({ fixture: true, input: { nas: 'other', advisory: text }, output: { faa: ord.faa, reasons: ord.now.reasons } }, null, 2));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const result = { commit: process.env.GITHUB_SHA, checks: [], errors: [] };
try {
  const check = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await check.goto('http://localhost:8000/check.html?mock=1&nosw=1', { waitUntil: 'domcontentloaded' });
  await check.waitForFunction(() => /^CHECK (PASS|FAIL)/.test(document.querySelector('#result')?.textContent || ''), null, { timeout: 180000 });
  const report = await check.locator('#result').innerText();
  await writeFile('qa-evidence/check.txt', report);
  await check.screenshot({ path: 'qa-evidence/check.png', fullPage: true });
  result.checks.push({ url: 'check.html?mock=1', result: report.split('\n')[0] });
  assert.match(report, /^CHECK PASS/);
  await check.close();
  for (const mode of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: mode });
    for (const scenario of ['', 'thunderstorm-ground-stop']) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      const query = scenario ? `?test=${scenario}&nosw=1` : '?nosw=1';
      await page.goto(`http://localhost:8000/index.html${query}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.AWXApp?.state.loaded && document.querySelector('.card'), null, { timeout: 30000 });
      await page.screenshot({ path: `qa-evidence/${scenario || 'normal'}-${mode}.png`, fullPage: true });
      if (!scenario) {
        const card = page.locator('.card[data-iata="ORD"]').first();
        const subheading = await card.locator('.card-context').innerText();
        assert.match(subheading, /staffing/i);
        assert.doesNotMatch(subheading, /other/i);
        await card.click();
        await page.locator('#sheetWrap:not([hidden]) .sc-blurb').first().waitFor();
        const blurb = await page.locator('#sheet .sc-blurb').first().innerText();
        assert.match(blurb, /staffing/i);
        assert.doesNotMatch(blurb, /other cause/i);
        await page.screenshot({ path: `qa-evidence/staffing-sheet-${mode}.png`, fullPage: true });
        result.checks.push({ mode, viewport: '390x844', fixture: true, cardSubheading: subheading, sheetBlurb: blurb });
      }
      result.errors.push(...errors);
      result.checks.push({ mode, viewport: '390x844', page: scenario || 'normal', consoleErrors: errors });
      assert.deepEqual(errors, []);
      await page.close();
    }
    await context.close();
  }
  result.pass = true;
} catch (e) {
  result.pass = false;
  result.failure = e.stack;
  throw e;
} finally {
  await writeFile('qa-evidence/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
