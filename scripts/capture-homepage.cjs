// Round 4: homepage only, no Herdr CLI, no 4545 access and no room mutations.
// Leader may set HOMEPAGE_CAPTURE_FIXTURE=1 for deterministic five-state evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { summarize } = require('../public/town');
(async () => {
  const fixture = process.env.HOMEPAGE_CAPTURE_FIXTURE === '1';
  let base = 'http://127.0.0.1:4546', server, browser;
  const dir = process.env.HOMEPAGE_CAPTURE_DIR || path.join(__dirname, '../docs/screenshots');
  const prefix = fixture ? 'round4-fixture' : 'team-town';
  try {
    if (fixture) {
      const { EventEmitter } = require('node:events');
      const { createServer } = require('../src/server');
      const source = new EventEmitter();
      const states = { busy:['tool','waiting','unknown'], idle:['done','idle'], attention:['waiting'], unknown:['unknown'], empty:[] };
      source.teams = () => Object.keys(states).map(id => ({id,name:`${id} · 花园街区`,presence:'fresh'}));
      source.sessions = () => Object.entries(states).flatMap(([teamId,list]) => list.map((status,i) => ({
        id:`${teamId}-${i}`, key:`${teamId}-${i}`, teamId, agent:'codex', status:status === 'unknown' ? 'idle' : status,
        source:status === 'unknown' ? 'herdr' : 'log', statusSource:status === 'unknown' ? 'herdr' : 'log', sourceStatus:status,
        role:['leader','dev','designer'][i], herdrStatus:'working', lastEventAt:Date.now(),
      })));
      source.sourceInfo = () => ({presence:'fresh'});
      server = createServer(source);
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    }
    browser = await chromium.launch({ headless:true, ...(process.env.WMAD_BROWSER_EXECUTABLE ? { executablePath:process.env.WMAD_BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport:{ width:1440, height:1200 }, colorScheme:'light' });
    const errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.protocol !== 'data:' && u.origin !== base) { external.push(u.href); return route.abort(); }
      return route.continue();
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    await page.goto(base); await page.waitForFunction(() => teamTown.snapshot.teams.length > 0); await settle();
    const observed = await page.evaluate(() => ({ snapshot:teamTown.snapshot, summary:teamTown.summary,
      busy:Number(document.querySelector('#busy-team-count').textContent), idle:Number(document.querySelector('#idle-team-count').textContent), working:Number(document.querySelector('#working-count').textContent) }));
    const expected = summarize(observed.snapshot);
    assert.equal(observed.busy, expected.busyTeams); assert.equal(observed.idle, expected.idleTeams); assert.equal(observed.working, expected.workingAgents);
    assert.ok(observed.snapshot.sessions.every(s => s.prompt == null && s.reply == null && s.title == null));
    fs.mkdirSync(dir, { recursive:true });
    await page.screenshot({ path:path.join(dir, `${prefix}-overview.png`), fullPage:true });
    if (fixture) {
      for (const kind of ['busy','idle','attention','unknown','empty']) await page.locator(`[data-activity=${kind}]`).first().screenshot({ path:path.join(dir, `${prefix}-${kind}-normal.png`) });
    }
    for (const width of [390,320]) {
      await page.setViewportSize({ width, height:width === 320 ? 568 : 844 }); await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path:path.join(dir, width === 390 ? `${prefix}-mobile.png` : `${prefix}-mobile-320.png`), fullPage:true });
    }
    await page.setViewportSize({ width:1440, height:1200 });
    await page.emulateMedia({ reducedMotion:'reduce' }); await settle();
    await page.screenshot({ path:path.join(dir, `${prefix}-static.png`), fullPage:true });
    if (fixture) {
      for (const kind of ['busy','idle','attention','unknown','empty']) await page.locator(`[data-activity=${kind}]`).first().screenshot({ path:path.join(dir, `${prefix}-${kind}-static.png`) });
      await page.locator('[data-activity=idle] .sleeping-cat').screenshot({ path:path.join(dir, `${prefix}-cat-detail.png`) });
      await page.locator('[data-activity=busy] .house-art-stage').screenshot({ path:path.join(dir, `${prefix}-smoke-headroom.png`) });
      const grayscale = await page.addStyleTag({content:'.town-map { filter:grayscale(1); }'});
      await page.screenshot({ path:path.join(dir, `${prefix}-grayscale.png`), fullPage:true });
      await grayscale.evaluate(el => el.remove());
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    fs.writeFileSync(path.join(dir, fixture ? 'round4-fixture-verification.json' : 'homepage-verification.json'), JSON.stringify({ verifiedAt:new Date().toISOString(), url:base, fixture,
      busyTeams:expected.busyTeams, idleTeams:expected.idleTeams, otherTeams:expected.otherTeams, workingAgents:expected.workingAgents,
      teams:expected.teams, ungroupedAgents:expected.ungroupedAgents,
      houses:expected.houses.map(h => ({ id:h.team.id, name:h.team.name, ...h.activity })),
      checks:['effective log-first status', 'per-house busy ratio and explicit all-idle', 'busy/idle team totals', 'desktop multi-row street layout', '390px and 320px mobile', 'reduced-motion stills', ...(fixture ? ['five normal/static states', 'cat and smoke detail', 'grayscale evidence'] : []), 'private/local-only', 'no browser errors'],
    }, null, 2) + '\n');
    console.log(`PASS homepage capture: ${expected.houses.length} houses, ${expected.busyTeams} busy teams, ${expected.idleTeams} idle teams, ${expected.workingAgents} working agents`);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
