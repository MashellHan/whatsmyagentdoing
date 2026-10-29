// Fixture-only end-to-end checks for the town -> ORIGINAL office workflow.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const w = new EventEmitter();
const states = ['thinking', 'tool', 'typing', 'waiting', 'done', 'idle', 'error', 'interrupted', 'idle'];
let members = states.map((status, i) => ({ key: `p${i}`, id: `session-${i}`, agent: ['claude', 'codex', 'gemini'][i % 3],
  source: i === 8 ? 'herdr' : 'log', statusSource: i === 8 ? 'herdr' : 'log', sourceStatus: i === 8 ? 'unknown' : status,
  herdrStatus: i === 8 ? 'unknown' : 'working', binding: i === 8 ? 'no-session-id' : 'exact-session',
  displayName: i === 0 ? 'leader-test' : i === 1 ? '<img src=x onerror=alert(1)>' : `member-${i}`,
  paneId: `w1:p${i}`, teamId: 'w1', role: i === 0 ? 'leader' : 'member', status,
  lastEventAt: Date.now(), startedAt: Date.now() - 5000, presence: 'fresh',
  prompt: 'PRIVATE BODY', reply: 'PRIVATE REPLY', title: 'PRIVATE TITLE' }));
members.push({ ...members[0], key: 'other-team', paneId: 'w2:p1', teamId: 'w2', role: 'member', displayName: 'NEVER-IN-W1' });
let houses = ['w1', 'w2', 'w3', 'w4'].map((id, i) => ({ id, name: i === 3 ? '很长的团队名称-with-a-long-workspace-label' : `Team ${i + 1}`, presence: 'fresh' }));
w.sessions = () => members; w.teams = () => houses; w.sourceInfo = () => ({ presence: houses[0].presence });
async function ready(page) { await page.waitForFunction(() => office?.framesShown > 3 && state.loaded); }
async function settings(page) { if (await page.locator('#settingsMenu').getAttribute('open') === null) await page.click('#settingsMenu > summary'); }
(async () => {
  const server = createServer(w);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.WMAD_BROWSER_EXECUTABLE ? { executablePath: process.env.WMAD_BROWSER_EXECUTABLE } : {}),
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'zh-CN' });
    const errors = [], remote = [];
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    context.on('request', req => { const url = new URL(req.url()); if (url.protocol !== 'data:' && url.origin !== base) remote.push(req.url()); });
    const page = await context.newPage(), base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base); await page.waitForSelector('[data-testid=house]');
    assert.equal(await page.locator('[data-testid=house]').count(), 4);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `town overflow at ${width}`);
    }
    await page.locator('[data-team-id=w1]').focus(); await page.keyboard.press('Enter'); await ready(page);
    assert.equal(new URL(page.url()).searchParams.get('team'), 'w1');
    assert.equal(await page.locator('#viewSeg [data-v=list]').isVisible(), true);
    assert.equal(await page.locator('#qualSeg [data-v=high]').isVisible(), true);
    assert.equal(await page.locator('#pipBtn').isVisible(), true);
    assert.equal(await page.locator('[data-testid=member]').count(), 9);
    assert.equal(await page.evaluate(() => state.data.sessions.every(s => s.teamId === 'w1')), true);
    assert.equal(await page.evaluate(() => office.deskOf.get('p0') === office.leaderDesk), true);
    assert.deepEqual(await page.evaluate(() => ['p4', 'p5', 'p7', 'p8'].map(k => office.people.get(k).mode)), ['wander', 'wander', 'wander', 'wander']);
    assert.equal(await page.evaluate(() => office.people.get('p1').s.agent), 'codex');
    assert.equal(await page.evaluate(() => new Set(['p0', 'p1', 'p2'].map(k => office.people.get(k).shirt)).size), 3);
    await page.waitForFunction(() => Object.values(OFFICE_AGENT_BADGES).every(b => b.image.complete && b.image.naturalWidth));
    assert.ok((await page.locator('#members').innerText()).includes('<img src=x onerror=alert(1)>'));
    assert.equal(await page.locator('img[src=x]').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('PRIVATE'), false);
    assert.equal(await page.locator('#members [data-source=log].source-badge').count(), 8);
    assert.equal(await page.locator('#members [data-source=herdr].source-badge').count(), 1);
    assert.match(await page.locator('#members [data-source=herdr].source-badge').innerText(), /Herdr 回退 · unknown/);
    console.log('PASS town enters original office; three providers, correct work/wander modes, roster, source and privacy');

    const today = require('../src/parsers').dayKey(Date.now());
    members = members.map(s => s.key === 'p0' ? { ...s, cwd: '/fixture/inside-project', daily: { day: today, turns: 2, tokens: 1200 } }
      : s.key === 'other-team' ? { ...s, cwd: '/fixture/outside-project', daily: { day: today, turns: 90, tokens: 9_000_000 } } : s);
    w.emit('change');
    await page.waitForFunction(() => state.data.sessions.some(s => s.today));
    assert.equal(await page.locator('#todayTokens').innerText(), '1.2k');
    await page.click('#todayMenu > summary');
    assert.match(await page.locator('#todayPanel').innerText(), /inside-project/);
    assert.doesNotMatch(await page.locator('#todayPanel').innerText(), /outside-project|9\.00M/);
    await page.keyboard.press('Escape');
    console.log('PASS Today totals and project names are scoped to the selected team');

    await page.click('#viewSeg [data-v=list]');
    assert.equal(await page.locator('#main .card').count(), 9, 'all eight log states plus unknown fallback');
    assert.deepEqual(await page.locator('#main .card').evaluateAll(nodes => [...new Set(nodes.map(n => n.querySelector('.agent').classList[1]))].sort()), ['claude', 'codex', 'gemini']);
    assert.equal(await page.locator('#teamRoster').isVisible(), true);
    await page.click('#viewSeg [data-v=office]'); await page.click('#qualSeg [data-v=high]');
    await page.waitForFunction(() => officeKind === 'high:office' && office.loaded && office.framesShown > 4);
    assert.equal(await page.evaluate(() => office.actors.size), 9);
    const badges = await page.evaluate(() => {
      const found = new Set(), original = office.agentBadge;
      office.agentBadge = function(a, ...args) { found.add(a.short); return original.call(this, a, ...args); };
      office.frame(performance.now()); office.agentBadge = original; return [...found].sort();
    });
    assert.deepEqual(badges, ['Cl', 'Cx', 'G']);
    console.log('PASS original list groups and 3D share the same team scope, provider badges and status');

    await page.click('#pipBtn'); await page.waitForFunction(() => !!popout.win);
    const pip = context.pages().find(p => p !== page);
    await pip.waitForSelector('iframe');
    const frame = await pip.locator('iframe').contentFrame();
    await frame.locator('#office canvas').first().waitFor();
    // FrameLocator for interactions, actual Frame for evaluation.
    const child = pip.frames().find(f => f.url().includes('pip=1'));
    await child.waitForFunction(() => office?.loaded && office.framesShown > 4);
    assert.equal(await child.evaluate(() => TEAM), 'w1');
    assert.equal(await child.evaluate(() => state.data.sessions.length), 9);
    assert.equal(await page.evaluate(() => office.visible), false);
    await child.locator('#viewSeg [data-v=list]').click();
    await page.waitForFunction(() => state.view === 'list');
    assert.equal(await child.locator('#main .card').count(), 9, 'team PiP retains completed/idle members too');
    assert.equal((await child.locator('body').innerText()).includes('NEVER-IN-W1'), false);
    await settings(page); await page.click('#agentSeg [data-v=gemini]');
    await child.waitForFunction(() => state.agent === 'gemini');
    assert.equal(await child.locator('#main .card').count(), 3);
    await settings(page); await page.click('#agentSeg [data-v=all]');
    await child.waitForFunction(() => state.agent === 'all');
    await child.locator('#viewSeg [data-v=office]').click(); await child.locator('#qualSeg [data-v=mid]').click();
    await child.waitForFunction(() => officeKind === 'mid' && office.framesShown > 4);
    await pip.close(); await page.waitForFunction(() => !popout.win && office.visible);
    console.log('PASS actual team PiP: 3D, office/list, filters, bidirectional prefs, isolation and close restoration');

    members = members.map(s => ({ ...s, presence: 'stale' })); houses = houses.map(t => ({ ...t, presence: 'stale' })); w.emit('change');
    await page.waitForSelector('#members .stale-chip');
    members = members.map(s => s.key === 'p1' ? { ...s, status: 'done', displayName: 'renamed-member', presence: 'fresh' } : { ...s, presence: 'fresh' });
    houses = houses.map(t => ({ ...t, presence: 'fresh' })); w.emit('change');
    await page.waitForFunction(() => document.querySelector('[data-pane-id="w1:p1"]').dataset.status === 'done');
    assert.equal(await page.evaluate(() => office.people.get('p1').mode), 'wander', 'log completion releases the work desk');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `office overflow at ${width}`);
      await page.click('#viewSeg [data-v=list]');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `list overflow at ${width}`);
      await page.click('#viewSeg [data-v=office]');
    }
    await page.reload(); await ready(page); assert.equal(await page.evaluate(() => TEAM), 'w1');
    await page.click('#back'); await page.waitForSelector('[data-team-id=w3]'); await page.locator('[data-team-id=w3]').click();
    await page.waitForFunction(() => state.loaded);
    assert.equal(await page.locator('[data-testid=member]').count(), 0);
    assert.equal(await page.evaluate(() => state.agent), 'all');
    const fallback = await context.newPage();
    await fallback.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined }));
    await fallback.goto(base + '/office?team=w2&view=office'); await ready(fallback);
    await fallback.click('#pipBtn'); await fallback.waitForFunction(() => !!popout.stream && !popout.busy && document.getElementById('pipVideo').videoWidth > 0);
    assert.equal(await fallback.evaluate(() => state.data.sessions.every(s => s.teamId === 'w2')), true);
    await fallback.click('#closePreview'); await fallback.waitForFunction(() => !popout.stream);
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    console.log('PASS team stale/recovery, completion action, responsive office/list, reload, empty house and video PiP fallback; zero page errors/external requests');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
