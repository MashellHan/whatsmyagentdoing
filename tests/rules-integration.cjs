// Real local reader + browser, but only a disposable synthetic repository.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { RulesReader } = require('../src/rules');
const { createServer } = require('../src/server');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-browser-'));
  fs.mkdirSync(path.join(temp, '.git'));
  fs.mkdirSync(path.join(temp, 'docs'));
  fs.writeFileSync(path.join(temp, 'AGENTS.md'), '# Garden team guidelines\n\nThis is a synthetic example, not a real team document.\n\n## Collaboration\n\n- Review the design before implementation.\n- Keep changes small and testable.\n- Never publish private conversation data.\n\n## Verification\n\nUse **local fixtures** and record the outcome.\n\n```sh\nnpm test\n```\n\n![disabled image](https://example.invalid/private.png)\n');
  fs.writeFileSync(path.join(temp, 'docs', 'TEAM-WORKFLOW.md'), '# Workflow\n\n1. Design\n2. Implement\n3. Review\n');
  const watcher = new EventEmitter();
  watcher.sessions = () => [{ key: 'demo', id: 'demo', agent: 'codex', teamId: 'garden', displayName: 'Reviewer', source: 'log', status: 'done', lastEventAt: Date.now() }];
  watcher.teams = () => [{ id: 'garden', name: 'Garden studio', presence: 'fresh' }];
  const reader = new RulesReader(team => team === 'garden' ? { directories: [temp], roots: [], extraFiles: [] } : null);
  const server = createServer(watcher, {}, { rulesReader: reader });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.WMAD_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const base = `http://127.0.0.1:${server.address().port}`, external = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith('data:')) external.push(req.url()); });
    await page.goto(base + '/office?team=garden'); await page.waitForSelector('#rules-entry');
    assert.equal(reader.lists.size, 0, 'page load does not scan repositories');
    await page.click('#rules-entry'); await page.waitForSelector('.rules-file');
    assert.equal(await page.locator('.rules-file').count(), 2);
    assert.equal(await page.locator('.rules-body h1').count(), 0, 'list never preloads first document');
    await page.locator('.rules-file').filter({ hasText: /^.*AGENTS.md/ }).click();
    await page.waitForSelector('.rules-body h1');
    assert.equal(await page.locator('.rules-body h1').innerText(), 'Garden team guidelines');
    assert.equal(await page.locator('.rules-body img,.rules-body a').count(), 0);
    const body = await (await fetch(base + '/api/sessions')).text();
    assert.equal(body.includes('Garden team guidelines'), false); assert.equal(body.includes(temp), false);
    if (process.env.WMAD_RULES_SCREENSHOTS) {
      fs.mkdirSync(process.env.WMAD_RULES_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WMAD_RULES_SCREENSHOTS, 'team-rules-desktop.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.WMAD_RULES_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.WMAD_RULES_SCREENSHOTS, 'team-rules-mobile.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.rules-body').textContent(), '');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS actual rules helper/server/browser: on-demand, exact file, safe Markdown, no leak or external request, desktop/mobile');
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
