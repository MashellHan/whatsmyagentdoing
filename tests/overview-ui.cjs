// L1 first-screen contract; L2 large-stage behavior is tested separately.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const source = new EventEmitter();
let teams = ['workshop', 'studio', 'garden', 'ungrouped'].map((id, i) => ({ id, name: ['Engineering workshop', 'Design studio', 'Garden office', '未分组'][i], presence: 'fresh' }));
source.teams = () => teams;
source.sessions = () => teams.flatMap((team, j) => Array.from({ length: 3 }, (_, i) => ({
  key: `${team.id}:${i}`, id: `${team.id}:${i}`, teamId: team.id, agent: 'codex',
  role: ['leader', 'dev', 'designer'][i], status: j % 2 ? 'done' : i ? 'idle' : 'tool',
  source: 'log', statusSource: 'log', herdrStatus: 'working', lastEventAt: Date.now(),
})));
source.sourceInfo = () => ({ presence: 'fresh' });
async function settled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
(async () => {
  const server = createServer(source);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.WMAD_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], external = []; page.on('pageerror', e => errors.push(e.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(base); await page.waitForSelector('.house');
    const dimensions = [];
    for (const [width, height] of [[1280,720],[1366,768],[1440,900],[1920,1080],[2560,1440]]) {
      await page.setViewportSize({ width, height }); await settled(page);
      const size = await page.evaluate(() => {
        const map = document.querySelector('.town-map').getBoundingClientRect();
        return { viewport: [innerWidth, innerHeight], bottom: map.bottom, houses: [...document.querySelectorAll('.house')].map(el => {
          const rect = el.getBoundingClientRect(), sign = el.querySelector('.house-sign'), art = el.querySelector('.house-art-stage').getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, sign: sign.getBoundingClientRect().left, artRight: art.right, clipped: sign.scrollHeight > sign.clientHeight + 1 };
        }), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(size.overflow, false);
      assert.ok(size.bottom <= height, `map outside first screen ${JSON.stringify(size)}`);
      assert.ok(size.houses.every(h => h.top >= 0 && h.bottom <= height && !h.clipped && h.artRight <= h.sign), 'all four entire houses/signs visible without clipping');
      assert.ok(size.houses[2].top > size.houses[0].bottom, 'two rows, not a single strip');
      dimensions.push({ viewport: size.viewport, mapBottom: size.bottom });
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await settled(page);
    const compactHeight = await page.locator('.town-map').evaluate(el => el.getBoundingClientRect().height);
    const expanded = page.locator('.town-view-controls [data-town-view=expanded]');
    await expanded.focus(); await page.keyboard.press('Enter'); await settled(page);
    assert.ok(await page.locator('.town-map').evaluate(el => el.getBoundingClientRect().height) > compactHeight * 1.5);
    assert.equal(await page.locator('.town-view-controls [data-town-view=expanded]').getAttribute('aria-pressed'), 'true');
    await page.locator('.town-view-controls [data-town-view=overview]').click(); await settled(page);
    assert.equal(await page.locator('.town-map').evaluate(el => el.getBoundingClientRect().height), compactHeight);
    assert.equal(await page.locator('.town-view-controls button').evaluateAll(nodes => nodes.every(el => el.getBoundingClientRect().height >= 44)), true);
    await page.reload(); await page.waitForSelector('.house'); await settled(page);
    assert.equal(await page.locator('body').getAttribute('data-town-view'), 'overview');
    if (process.env.WMAD_OVERVIEW_SCREENSHOTS) {
      fs.mkdirSync(process.env.WMAD_OVERVIEW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WMAD_OVERVIEW_SCREENSHOTS, 'town-first-screen.png') });
    }
    for (const width of [1051, 1100, 1250, 1251, 1050, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await settled(page);
      assert.equal(await page.locator('.town-view-controls').isVisible(), width > 1050);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.house').evaluateAll(nodes => nodes.every(el => {
        const sign = el.querySelector('.house-sign').getBoundingClientRect(), art = el.querySelector('.house-art-stage').getBoundingClientRect();
        return innerWidth > 1050 ? sign.left >= art.right : sign.top >= art.bottom;
      })), true);
      if (process.env.WMAD_OVERVIEW_SCREENSHOTS && [1051, 390, 320].includes(width)) {
        await page.screenshot({ path: path.join(process.env.WMAD_OVERVIEW_SCREENSHOTS, `town-${width}.png`), fullPage: true });
      }
    }
    // More houses and long labels extend naturally instead of being hidden to fit.
    teams = Array.from({ length: 13 }, (_, i) => ({ id: `team-${i}`, name: i === 0 ? 'Long label '.repeat(20) : `Team ${i}`, presence: 'fresh' }));
    source.emit('change'); await page.waitForFunction(() => document.querySelectorAll('.house').length === 13);
    await page.setViewportSize({ width: 1280, height: 720 }); await settled(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.house-sign').evaluateAll(nodes => nodes.every(el => el.scrollHeight <= el.clientHeight + 1)), true);
    assert.ok(await page.locator('.town-map').evaluate(el => el.getBoundingClientRect().bottom) > 720);
    // Text zoom is allowed to grow the map; it must not hide names or overlap lots.
    await page.evaluate(() => {
      document.querySelectorAll('.house-sign, .house-sign *').forEach(el => {
        const style = getComputedStyle(el);
        el.dataset.zoomFont = `${parseFloat(style.fontSize) * 2}px`;
        el.dataset.zoomLine = `${parseFloat(style.lineHeight) * 2}px`;
      });
      document.querySelectorAll('[data-zoom-font]').forEach(el => {
        el.style.fontSize = el.dataset.zoomFont; el.style.lineHeight = el.dataset.zoomLine;
      });
    });
    await settled(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.house-sign').evaluateAll(nodes => nodes.every(el => el.scrollHeight <= el.clientHeight + 1)), true);
    assert.equal(await page.locator('.house').evaluateAll(nodes => nodes.every((el, i) => i < 2 || el.getBoundingClientRect().top > nodes[i - 2].getBoundingClientRect().bottom)), true);
    teams = []; source.emit('change');
    await page.waitForFunction(() => document.querySelectorAll('.house').length === 0);
    await settled(page);
    assert.equal(await page.locator('#neighborhood').isVisible(), false);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log('PASS first-screen overview, expanded toggle, mobile and natural overflow:', JSON.stringify(dimensions));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
