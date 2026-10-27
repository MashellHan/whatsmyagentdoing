const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const source = new EventEmitter();
let teams = ['w1', 'w2', 'w3', 'w4', 'w5', 'ungrouped'].map(id => ({ id, name: id === 'w2' ? '很长的团队名称-with-a-long-label' : id, presence: 'fresh' }));
const states = { w1: ['thinking', 'tool', 'typing', 'done', 'idle'], w2: ['idle', 'done'], w3: ['waiting'], w4: [], w5: ['unknown'], ungrouped: ['tool'] };
let sessions = Object.entries(states).flatMap(([teamId, statuses]) => statuses.map((status, i) => ({
  id: `${teamId}-${i}`, key: `${teamId}-${i}`, teamId, agent: 'codex', source: status === 'unknown' ? 'herdr' : 'log',
  statusSource: status === 'unknown' ? 'herdr' : 'log', sourceStatus: status,
  status: status === 'unknown' ? 'idle' : status, herdrStatus: 'working', lastEventAt: Date.now(),
})));
source.sessions = () => sessions; source.teams = () => teams;
(async () => {
  const server = createServer(source);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.WMAD_BROWSER_EXECUTABLE ? { executablePath: process.env.WMAD_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base); await page.waitForSelector('[data-testid=house]');
    assert.equal(await page.locator('#busy-team-count').innerText(), '1');
    assert.equal(await page.locator('#idle-team-count').innerText(), '1');
    assert.equal(await page.locator('#working-count').innerText(), '4');
    assert.match(await page.locator('[data-team-id=w1]').innerText(), /3\/5.*正在忙/);
    assert.equal(await page.locator('[data-team-id=w2]').getAttribute('data-activity'), 'idle');
    for (const [id, kind] of [['w3', 'attention'], ['w4', 'empty'], ['w5', 'unknown']]) assert.equal(await page.locator(`[data-team-id=${id}]`).getAttribute('data-activity'), kind);
    const style = id => page.locator(`[data-team-id=${id}]`).evaluate(el => ({
      filter: getComputedStyle(el.querySelector('svg')).filter,
      lamp: getComputedStyle(el.querySelector('.window-glow')).fill,
      smoke: getComputedStyle(el.querySelector('.smoke')).visibility,
    }));
    const busy = await style('w1'), idle = await style('w2');
    assert.notEqual(busy.lamp, idle.lamp); assert.equal(busy.smoke, 'visible'); assert.equal(idle.smoke, 'hidden'); assert.match(idle.filter, /saturate/);
    const rects = await page.locator('[data-testid=house]').evaluateAll(nodes => nodes.map(n => ({ x: n.getBoundingClientRect().x, y: n.getBoundingClientRect().y })));
    assert.ok(rects[2].y > rects[0].y + 200, 'third house begins a new street block');
    assert.ok(Math.abs(rects[1].y - rects[0].y) > 5, 'opposite houses are staggered');
    assert.ok(rects[1].x > rects[0].x + 200);
    for (const selector of ['.plaza', '.avenue', '.street-tree', '.street-lamp', '.street-bench']) assert.equal(await page.locator(selector).first().isVisible(), true);
    // Retain the actual button/SVG through status updates (focus and smoke don't restart).
    await page.locator('[data-team-id=w1]').focus();
    await page.evaluate(() => { window.savedHouse = document.querySelector('[data-team-id=w1]'); window.savedArt = savedHouse.querySelector('svg'); });
    sessions = sessions.map(s => s.teamId === 'w1' ? { ...s, status: 'done' } : s); source.emit('change');
    await page.waitForFunction(() => document.querySelector('[data-team-id=w1]').dataset.activity === 'idle');
    assert.equal(await page.locator('#busy-team-count').innerText(), '0'); assert.equal(await page.locator('#idle-team-count').innerText(), '2');
    assert.equal(await page.evaluate(() => savedHouse === document.activeElement && savedArt === savedHouse.querySelector('svg')), true);
    assert.equal((await style('w1')).smoke, 'hidden');
    teams = [...teams, ...Array.from({ length: 7 }, (_, i) => ({ id: `extra-${i}`, name: `Extra ${i}` }))]; source.emit('change');
    await page.waitForFunction(() => document.querySelectorAll('.house').length === 13);
    for (const width of [320, 390, 540, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
      const boxes = await page.locator('.house').evaluateAll(nodes => nodes.map(n => { const b = n.getBoundingClientRect(); return { x:b.x, y:b.y, r:b.right, b:b.bottom }; }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]; assert.ok(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y, `houses overlap ${width}`);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.window-glow').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    teams = teams.slice(0, 2); source.emit('change'); await page.waitForFunction(() => document.querySelectorAll('.house').length === 2);
    await page.locator('[data-team-id=w1]').focus(); await page.keyboard.press('Enter'); await page.waitForURL('**/office?team=w1');
    assert.deepEqual(errors, []);
    console.log('PASS homepage: log-first ratios/counters, idle lights-off, busy smoke, attention/unknown/empty, staggered streets, 13-house wrapping, mobile, focus/live updates and reduced motion');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
