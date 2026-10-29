// Synthetic local members only. Never opens real session logs or guidelines.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { RecentActivity } = require('../src/activity');
const { RulesReader } = require('../src/rules');
const { createServer } = require('../src/server');

const source = new EventEmitter(), calls = [];
let members = [
  { key: 'a', id: 'a', paneId: 'p1', teamId: 'fixture', agent: 'codex', displayName: 'Fixture lead', model: 'fixture-model', reasoningEffort: 'xhigh', context: 42000, contextWindow: 258400, contextWindowSource: 'recorded', status: 'thinking', lastEventAt: Date.now(), presence: 'fresh' },
  { key: 'b', id: 'b', paneId: 'p2', teamId: 'fixture', agent: 'claude', displayName: 'Fixture reviewer', status: 'done', lastEventAt: Date.now(), presence: 'fresh' },
];
source.sessions = () => members;
source.teams = () => [{ id: 'fixture', name: 'Fixture team', presence: 'fresh' }];
source.sourceInfo = () => ({ kind: 'logs+herdr', presence: 'fresh' });
const history = new Map([['a', new RecentActivity()], ['b', new RecentActivity()]]);
function command(key, id, text) {
  history.get(key).observe({ agent: 'codex', cwd: '/fixture' }, { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: text }) } });
}
for (let i = 0; i < 44; i++) command('a', String(i), 'SYNTHETIC_COMMAND_' + i);
command('a', 'long', '<img src="https://invalid.test" onerror="window.memberXss=true">' + '🧭'.repeat(1000));
command('b', 'b', 'ONLY_MEMBER_B');
let held = null;
source.memberActivity = (team, key) => {
  calls.push({ team, key });
  const value = { member: key, available: true, ...history.get(key).snapshot() };
  if (held && key === 'a') { const wait = held; held = null; return wait.promise.then(() => value); }
  return value;
};
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-browser-'));
  for (const key of ['a', 'b']) {
    fs.mkdirSync(path.join(temp, key, '.git'), { recursive: true });
    fs.writeFileSync(path.join(temp, key, 'AGENTS.md'), `# MEMBER_${key}_GUIDELINES\n\nSynthetic shared rules.`);
  }
  const reader = new RulesReader((team, member) => team === 'fixture' ? { directories: [path.join(temp, member || 'a')], roots: [], extraFiles: [], memberKey: member } : null);
  const server = createServer(source, {}, { rulesReader: reader });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.WMAD_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage(), errors = [], external = [], base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
    await page.addInitScript(() => {
      const original = fetch; window.ignoreMemberAbort = false;
      window.fetch = (input, options = {}) => {
        if (String(input).startsWith('/api/members/') && ignoreMemberAbort) { const { signal, ...rest } = options; options = rest; }
        return original(input, options);
      };
    });
    const a = page.locator('.team-member[data-key=a]'), b = page.locator('.team-member[data-key=b]');
    await page.goto(base + '/office?team=fixture&quality=mid');
    await page.waitForSelector('.member-rules');
    assert.equal(calls.length, 0); assert.equal(reader.lists.size, 0, 'neither history nor rules prefetch');
    assert.match(await a.locator('.member-config').textContent(), /fixture-model.*xhigh.*258.4k/);
    assert.match(await b.locator('.member-config').textContent(), /未记录/);
    assert.equal(await page.evaluate(() => document.querySelector('#rules-entry').getBoundingClientRect().bottom <= document.querySelector('.roster-heading').getBoundingClientRect().top), true);

    await a.locator('.member-summary').click();
    await page.waitForFunction(() => document.querySelectorAll('.member-command').length === 30);
    assert.equal(await a.locator('.member-summary').getAttribute('aria-expanded'), 'true');
    assert.ok((await a.locator('.member-command').last().innerText()).includes('内容已截断'));
    assert.equal(await page.locator('.member-activity img,.member-activity script').count(), 0);
    assert.equal(await page.evaluate(() => window.memberXss), undefined);
    assert.equal(await a.locator('.member-command pre').last().evaluate(n => Array.from(n.textContent).length), 360);
    await a.locator('.member-commands').evaluate(n => { window.savedMemberList = n; n.scrollTop = 0; });
    members[0].status = 'tool'; members[0].reasoningEffort = 'max'; source.emit('change');
    await page.waitForFunction(() => document.querySelector('.team-member[data-key=a]').dataset.status === 'tool');
    assert.match(await a.locator('.member-config').textContent(), /max/);
    assert.equal(await page.evaluate(() => savedMemberList === document.querySelector('.member-commands')), true);
    command('a', 'new', 'LIVE_COMMAND_ADDED');
    await page.waitForFunction(() => document.querySelector('.member-commands').textContent.includes('LIVE_COMMAND_ADDED'));
    assert.equal(await a.locator('.member-commands').evaluate(n => n.scrollTop), 0, 'live updates preserve backscroll');

    await a.locator('.member-summary').click(); const stopped = calls.length;
    await page.waitForTimeout(1800); assert.equal(calls.length, stopped, 'closed panels stop polling');
    await page.evaluate(() => { ignoreMemberAbort = true; });
    held = defer(); const late = held;
    await a.locator('.member-summary').click(); await page.waitForFunction(() => document.querySelector('.member-activity'));
    for (let retry = 0; calls.length === stopped && retry < 100; retry++) await page.waitForTimeout(20);
    assert.ok(calls.length > stopped, 'held request reached the server');
    await b.locator('.member-summary').click();
    await page.waitForFunction(() => document.querySelector('.member-commands').textContent.includes('ONLY_MEMBER_B'));
    late.resolve(); await page.waitForTimeout(100);
    assert.equal(await a.locator('.member-activity').count(), 0);
    assert.equal((await b.locator('.member-commands').textContent()).includes('LIVE_COMMAND_ADDED'), false);

    await b.locator('.member-rules').click(); await page.waitForSelector('.rules-file');
    assert.match(await page.locator('#rules-title').textContent(), /成员准则/);
    assert.match(await page.locator('.rules-team').textContent(), /Fixture reviewer/);
    await page.locator('.rules-file').click(); await page.waitForSelector('.rules-body h1');
    assert.equal(await page.locator('.rules-body h1').textContent(), 'MEMBER_b_GUIDELINES');
    const modalStopped = calls.length; await page.waitForTimeout(1700); assert.equal(calls.length, modalStopped, 'covered panels pause polling');
    const initial = await page.locator('#rules-dialog').boundingBox(); assert.ok(initial.width > 1300);
    await page.locator('.rules-maximize').click();
    const maximized = await page.locator('#rules-dialog').boundingBox(); assert.ok(maximized.width > initial.width);
    await page.locator('.rules-maximize').click();
    assert.ok(Math.abs((await page.locator('#rules-dialog').boundingBox()).width - initial.width) < 2);
    const grip = await page.locator('.rules-resize').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 220, grip.y + grip.height / 2 - 150, { steps: 8 }); await page.mouse.up();
    const resized = await page.locator('#rules-dialog').boundingBox();
    assert.ok(resized.width < initial.width - 150 && resized.height < initial.height - 100, 'pointer grip changes both dimensions');
    await page.locator('.rules-resize').focus(); await page.keyboard.press('ArrowLeft');
    assert.ok((await page.locator('#rules-dialog').boundingBox()).width < resized.width, 'keyboard resize');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('member-rules')), true);
    await b.locator('.member-summary').click();
    await a.locator('.member-rules').click(); await page.waitForSelector('.rules-file');
    await page.locator('.rules-file').click(); await page.waitForSelector('.rules-body h1');
    assert.equal(await page.locator('.rules-body h1').textContent(), 'MEMBER_a_GUIDELINES');
    members = members.filter(m => m.key !== 'a'); source.emit('change');
    await page.waitForFunction(() => !document.querySelector('#rules-dialog').open);
    assert.equal(await page.locator('.rules-body').textContent(), '', 'departed occupants lose document contents');

    await b.locator('.member-summary').click();
    await page.waitForSelector('.member-command');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenStopped = calls.length; await page.waitForTimeout(1700); assert.equal(calls.length, hiddenStopped);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.member-activity-status').textContent.startsWith('实时'));
    for (const [width, height] of [[1280, 720], [1024, 768], [390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `member panel fits ${width}`);
      if (width >= 1024) {
        const geometry = await page.evaluate(() => ({ height: innerHeight, page: document.documentElement.scrollHeight, roster: document.querySelector('#teamRoster').getBoundingClientRect().toJSON(), office: document.querySelector('#office').getBoundingClientRect().toJSON() }));
        assert.ok(geometry.page <= geometry.height + 1, 'desktop remains one screen: ' + JSON.stringify(geometry));
      }
      await b.locator('.member-rules').click(); await page.waitForSelector('.rules-file');
      const rect = await page.locator('#rules-dialog').boundingBox();
      assert.ok(rect.x >= -1 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1);
      await page.keyboard.press('Escape');
      // Let the per-scope limiter elapse before the next explicit list refresh.
      await page.waitForTimeout(510);
    }
    const state = await page.evaluate(() => JSON.stringify({ snapshot: teamOffice.snapshot, local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.doesNotMatch(state, /SYNTHETIC_COMMAND|LIVE_COMMAND|ONLY_MEMBER_B|GUIDELINES/);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS members: live bounded history, tags, no prefetch, stop/abort, row/scroll identity, isolated rules, resizable reader, mobile and private snapshots');
  } finally {
    held?.resolve(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
