const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');

const source = new EventEmitter();
const teams = ['team', 'design', 'review', 'ungrouped'].map(id => ({ id, name: id === 'ungrouped' ? '未分组' : id, presence: 'fresh' }));
const sessions = Array.from({ length: 10 }, (_, i) => ({
  id: 'compact-' + i, key: 'compact-' + i, paneId: 'fixture-pane-' + i,
  teamId: i < 6 ? 'team' : i === 6 ? 'design' : i === 7 ? 'review' : 'ungrouped',
  displayName: ['Implementation Lead', 'Interface Reviewer', 'API Developer'][i % 3] + ' ' + i,
  agent: ['codex', 'claude', 'gemini'][i % 3], status: i === 0 ? 'thinking' : 'done',
  source: 'herdr', statusSource: 'herdr', sourceStatus: i === 0 ? 'working' : 'done',
  role: 'member', lastEventAt: Date.now(),
}));
source.teams = () => teams;
source.sessions = () => sessions;
source.sourceInfo = () => ({ kind: 'logs+herdr', presence: 'fresh' });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

async function fits(page, name) {
  await settle(page);
  const result = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    clipped: [...document.querySelectorAll('.house-sign')].some(n => n.scrollHeight > n.clientHeight + 1),
    canvasBottom: document.querySelector('#office')?.getBoundingClientRect().bottom,
    rosterBottom: document.querySelector('#teamRoster')?.getBoundingClientRect().bottom,
  }));
  assert.ok(result.pageWidth <= result.width, name + ' horizontal overflow: ' + JSON.stringify(result));
  assert.ok(result.pageHeight <= result.height + 1, name + ' should fit one screen: ' + JSON.stringify(result));
  assert.equal(result.clipped, false, name + ' must not clip team details');
  if (result.canvasBottom) assert.ok(result.canvasBottom <= result.height, name + ' canvas fits');
  if (result.rosterBottom) assert.ok(result.rosterBottom <= result.height, name + ' roster fits');
  return result;
}

(async () => {
  const server = createServer(source);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.WMAD_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors = [], base = 'http://127.0.0.1:' + server.address().port;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === base || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const measurements = [];
    const capture = async name => {
      if (!process.env.WMAD_SCREENSHOTS) return;
      fs.mkdirSync(process.env.WMAD_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WMAD_SCREENSHOTS, name + '.png'), fullPage: true, animations: 'disabled' });
    };
    await page.goto(base); await page.waitForSelector('.house');
    assert.equal(await page.locator('body').getAttribute('data-layout'), 'compact');
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      measurements.push({ view: 'town', ...await fits(page, 'town ' + width) });
      assert.equal(await page.locator('.house').count(), 4);
      await capture('town-' + width);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#townLayout [data-layout=wide]').click(); await settle(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'large neighborhood remains available');
    await page.reload(); await page.waitForSelector('.house');
    assert.equal(await page.locator('body').getAttribute('data-layout'), 'wide', 'remember the explicit layout choice');
    await page.locator('#townLayout [data-layout=compact]').click();
    await fits(page, 'return to compact town');

    await page.goto(base + '/office?team=team&quality=mid');
    const ready = () => page.waitForFunction(() => office?.framesShown > 4 && (officeKind === 'mid' || office.loaded));
    await ready();
    for (const quality of ['mid', 'high']) {
      await page.locator('#qualSeg [data-v=' + quality + ']').click(); await ready();
      for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768]]) {
        await page.setViewportSize({ width, height });
        measurements.push({ view: quality, ...await fits(page, quality + ' office ' + width) });
        assert.equal(await page.locator('#office').getAttribute('data-scale'), 'fit');
        assert.equal(await page.locator('.team-member').count(), 6);
        await capture('office-' + quality + '-' + width);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-scale=wide]').click(); await settle(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'large office remains available');
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('[data-scale=fit]').click(); await fits(page, 'return to fit office');
    await page.goto(base + '/office?quality=mid'); await ready();
    await fits(page, 'all teams office');

    for (const url of [base, base + '/office?team=team&quality=mid']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url); await page.waitForSelector(url === base ? '.house' : '#office canvas'); await settle(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile stays readable without horizontal scrolling');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(measurements, null, 2));
    console.log('PASS compact town and 2D/3D office fit desktop windows, with optional large views and mobile reflow');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
