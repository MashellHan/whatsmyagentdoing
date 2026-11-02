'use strict';
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const { normalizeQuota } = require('../src/quota');

(async () => {
  const now = Date.now();
  const accounts = [
    { id: 'work', login: 'fixture-enterprise', host: 'microsoft.ghe.com', used: 45197, remaining: 95.5 },
    { id: 'personal', login: 'fixture-personal', host: 'github.com', unlimited: true },
    { id: 'github-work', login: 'fixture-github-work', host: 'github.com', used: 418, remaining: 99.9 },
    { id: 'other', login: 'fixture-work', host: 'msft.ghe.com', used: 64, remaining: 99.9 },
  ];
  let quota = { capturedAt: now, accounts: accounts.map(a => normalizeQuota(a, {
    login: a.login, copilot_plan: 'enterprise', quota_reset_date: '2026-12-01',
    quota_snapshots: { premium_interactions: { unlimited: !!a.unlimited, has_quota: !a.unlimited, percent_remaining: a.remaining ?? 100, credits_used: a.used ?? 0, entitlement: a.unlimited ? 0 : 1_000_000 }, chat: { unlimited: true }, completions: { unlimited: true } },
  }, now)) };
  const source = new EventEmitter();
  source.teams = () => ['开发组', '设计组', '研究组', '审查组'].map((name, i) => ({ id: `w${i}`, name, presence: 'fresh' }));
  source.sessions = () => ['thinking', 'tool', 'idle', 'done'].map((status, i) => ({ id: `fixture-${i}`, key: `fixture-${i}`, teamId: `w${i}`, agent: 'copilot', status, statusSource: 'log', lastEventAt: Date.now() }));
  const monitor = new EventEmitter();
  monitor.snapshot = () => quota; monitor.start = () => {}; monitor.stop = () => {};
  const server = createServer(source, {}, { quotaMonitor: monitor });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.WMAD_BROWSER_EXECUTABLE ? { executablePath: process.env.WMAD_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [], external = [], base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) { external.push(url.href); return route.abort(); }
      return route.continue();
    });
    await page.goto(base);
    await page.waitForSelector('#quota-rows tr:nth-child(4)');
    assert.match(await page.locator('#quota-state').innerText(), /^最近采集 \d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/);
    assert.match(await page.locator('[data-account=work] .quota-usage').innerText(), /45,197\s*\/\s*1,000,000/);
    assert.equal(await page.locator('[data-account=work] .quota-remaining strong').innerText(), '95.5%');
    assert.equal(await page.locator('[data-account=personal] .quota-remaining strong').innerText(), '不限额');
    assert.equal(await page.locator('[data-account=personal] meter').count(), 0);
    assert.equal(await page.locator('[data-account=personal] .quota-usage').innerText(), '未提供统计');
    assert.equal(await page.getByRole('meter').count(), 3);
    const output = path.join(__dirname, '../.local/quota-preview');
    fs.mkdirSync(output, { recursive: true });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 400 ? 844 : 1100 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}`);
      assert.equal(await page.locator('#quota-panel').isVisible(), true);
      assert.equal(await page.evaluate(() => document.querySelector('#quota-panel').getBoundingClientRect().top >= document.querySelector('.town-map').getBoundingClientRect().bottom), true, `quota below town at ${width}`);
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, width === 1440 ? 'desktop.png' : 'mobile.png'), fullPage: true });
    }
    quota = { ...quota, accounts: quota.accounts.map(a => ({ ...a, updatedAt: now - 3 * 60 * 60_000 - 60_000 })) };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelectorAll('.quota-note').length === 4);
    assert.match(await page.locator('[data-account=work]').innerText(), /已过期/);
    quota = { ...quota, accounts: quota.accounts.map((a, i) => ({ ...a, updatedAt: now, ...(i ? {} : { status: 'auth-required', error: 'authentication' }) })) };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('[data-account=work] .quota-note').textContent.includes('重新登录'));
    assert.equal(await page.locator('[data-account=work] .quota-remaining strong').innerText(), '95.5%');
    await page.route('**/api/quota', route => route.fulfill({ status: 503, body: '{}' }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('[data-account=other] .quota-note')?.textContent.includes('连接中断'));
    assert.equal(await page.locator('#quota-rows tr').count(), 4, 'request failures keep labelled prior evidence');
    await page.unroute('**/api/quota');
    quota = null; await page.reload();
    await page.waitForFunction(() => document.querySelector('#quota-state').textContent === '未启用');
    assert.equal(await page.locator('#quota-table').isVisible(), false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS quota UI: four accounts, unlimited/unknown/stale/auth/error states, 1440/768/390/320px, local requests only');
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
