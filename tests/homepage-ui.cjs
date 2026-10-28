// Round 4 fixture only: random loopback port; never visits a running team service.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const source = new EventEmitter();
const member = (teamId, status, i) => ({
  id: `${teamId}-${i}`, key: `${teamId}-${i}`, teamId, agent: 'codex',
  source: status === 'unknown' ? 'herdr' : 'log', statusSource: status === 'unknown' ? 'herdr' : 'log',
  sourceStatus: status, status: status === 'unknown' ? 'idle' : status,
  herdrStatus: 'working', lastEventAt: Date.now(), role: ['leader', 'dev', 'designer'][i] || 'member',
  prompt: 'PRIVATE BODY', reply: 'PRIVATE REPLY',
});
let teams = ['w1', 'w2', 'w3', 'w4', 'w5', 'ungrouped'].map(id => ({ id, name: id, presence: 'fresh' }));
let sessions = Object.entries({ w1: ['thinking', 'tool', 'typing', 'done', 'idle'], w2: ['idle', 'done'], w3: ['waiting'], w4: [], w5: ['unknown'], ungrouped: ['tool'] })
  .flatMap(([id, statuses]) => statuses.map((status, i) => member(id, status, i)));
let presence = 'fresh';
source.sessions = () => sessions; source.teams = () => teams; source.sourceInfo = () => ({ presence });
const symbols = { busy: '↻', idle: 'Zzz', attention: '!', unknown: '?', empty: '—' };
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function layoutCheck(page, width) {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 1100 });
  await settle(page);
  const issues = await page.evaluate(() => {
    const issues = [], mobile = innerWidth <= 760, clearance = mobile ? 8 : 12;
    const nodes = [...document.querySelectorAll('.house')], signs = nodes.map(n => n.querySelector('.house-sign').getBoundingClientRect());
    const gap = (a,b) => Math.max(b.top-a.bottom, a.top-b.bottom, b.left-a.right, a.left-b.right);
    const box = el => el.getBoundingClientRect();
    if (document.documentElement.scrollWidth > innerWidth) issues.push('horizontal overflow');
    if (+document.querySelector('#neighborhood').dataset.rows !== Math.ceil(nodes.length/(mobile ? 1 : 2))) issues.push('actual rows');
    nodes.forEach((n, i) => {
      const b = box(n), sign = signs[i], stage = box(n.querySelector('.house-art-stage'));
      if (sign.top-stage.bottom < 7.5) issues.push(`art/sign spacing ${i}`);
      if (n.querySelector('.house-sign').scrollHeight > n.querySelector('.house-sign').clientHeight + 1) issues.push(`clipped sign ${i}`);
      if (sign.bottom > b.bottom + 1) issues.push(`content outside button ${i}`);
      if (innerWidth <= 1050 && (getComputedStyle(n).marginLeft !== '0px' || getComputedStyle(n).getPropertyValue('--lot-offset').trim() !== '0px')) issues.push('mid/mobile stagger');
      if (mobile && i && Math.abs(b.left-box(nodes[0]).left) > 1) issues.push('not single column');
      for (let j = i+1; j < nodes.length; j++) if (gap(b,box(nodes[j])) < 0) issues.push(`houses overlap ${i}/${j}`);
      // SVG geometry, not just the parent button. Include the entire yard and cat/Zzz.
      for (const selector of ['.lot-garden', '.sleeping-cat']) {
        const el = n.querySelector(selector);
        if (getComputedStyle(el).visibility === 'visible' && gap(box(el),sign) < clearance) issues.push(`${selector} near sign ${i}`);
      }
      for (const el of n.querySelectorAll('.lot-garden, .sleeping-cat, .roof-pennant, .smoke')) {
        const p = box(el), map = box(document.querySelector('.town-map'));
        if (getComputedStyle(el).visibility === 'visible' && (p.left < map.left || p.right > map.right || p.top < map.top)) issues.push(`art outside map ${i}`);
      }
      const text = n.querySelector('.house-name');
      if (text.scrollWidth > text.clientWidth+1) issues.push(`long name overflow ${i}`);
    });
    for (const tree of document.querySelectorAll('.street-tree')) {
      if (!tree.checkVisibility()) continue;
      const b = box(tree), street = box(tree.parentElement);
      // Tree pseudos are deliberately contained by the full crown+shadow box.
      for (const pseudo of ['::before','::after']) {
        const s = getComputedStyle(tree,pseudo);
        if (parseFloat(s.left) < 0 || parseFloat(s.top) < 0 || parseFloat(s.width) > b.width+.1 || parseFloat(s.height) > b.height+.1) issues.push('tree pseudo outside box');
      }
      if (b.top < street.top || b.bottom > street.bottom) issues.push('tree outside real cross-street');
      if (signs.some(sign => gap(b,sign) < clearance)) issues.push('tree near sign');
    }
    for (const hedge of document.querySelectorAll('.hedge')) {
      if (hedge.checkVisibility() && signs.some(sign => gap(box(hedge),sign) < clearance)) issues.push('hedge near sign');
    }
    return issues;
  });
  assert.deepEqual(issues, [], `layout at ${width}`);
}
(async () => {
  const server = createServer(source);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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
    // Keep the real SSE protocol/server; observe the instance only for disconnect simulation.
    await page.addInitScript(() => {
      const Native = window.EventSource;
      window.EventSource = class extends Native { constructor(...args) { super(...args); window.fixtureEvents = this; } };
    });
    await page.goto(base); await page.waitForSelector('[data-testid=house]'); await settle(page);
    await page.locator('#townLayout [data-layout=wide]').click(); await settle(page);
    const house = id => page.locator(`[data-team-id="${id}"]`);
    const emit = async () => { source.emit('change'); await settle(page); };
    const setStates = async statuses => {
      sessions = [...sessions.filter(s => s.teamId !== 'w1'), ...statuses.map((status,i) => member('w1', status, i))];
      await emit();
      await page.waitForFunction(total => document.querySelector('[data-team-id=w1]').dataset.total === String(total), statuses.length);
    };
    const waitKind = kind => page.waitForFunction(kind => document.querySelector('[data-team-id=w1]').dataset.activity === kind, kind);
    const style = id => house(id).evaluate(el => {
      const s = selector => getComputedStyle(el.querySelector(selector));
      return {
        materials: [...el.querySelectorAll('.house-illustration path, .house-illustration ellipse, .house-illustration circle')].map(n => [getComputedStyle(n).fill, getComputedStyle(n).stroke]),
        card: ['.house-sign','.house-name','.status-chip','.busy-ratio','.window-glow'].map(q => [s(q).color,s(q).backgroundColor,s(q).borderColor,s(q).fill,s(q).boxShadow]),
        ancestors: [el,el.querySelector('.house-art-stage'),el.querySelector('.house-illustration'),el.parentElement,el.parentElement.parentElement].map(n => [getComputedStyle(n).filter,getComputedStyle(n).opacity]),
      };
    });
    const visibility = (id, selector) => house(id).locator(selector).evaluate(el => getComputedStyle(el).visibility);
    const animations = id => house(id).locator('.puff,.flag-cloth,.window-person,.window-light').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).animationName));
    assert.equal(await page.locator('#busy-team-count').innerText(), '1');
    assert.equal(await page.locator('#idle-team-count').innerText(), '1');
    assert.equal(await page.locator('#working-count').innerText(), '4');
    assert.match(await house('w1').innerText(), /3\/5.*正在忙/);
    assert.match(await house('w1').locator('.house-roles').innerText(), /leader 1 · dev 1 · designer 1/);
    assert.equal((await page.locator('body').innerText()).includes('PRIVATE'), false);
    const baseline = await style('w1');
    assert.ok(baseline.ancestors.every(([filter,opacity]) => filter === 'none' && opacity === '1'));
    assert.equal(await page.locator('.busy-meter').count(), 0);
    const positions = await page.locator('.house').evaluateAll(nodes => nodes.map(n => ({ x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y })));
    assert.ok(positions[2].y > positions[0].y+300);
    assert.ok(positions[1].y-positions[0].y > 5, 'desktop stagger');
    assert.ok(positions[1].x > positions[0].x+200);
    const clips = await page.locator('clipPath').evaluateAll(nodes => nodes.map(n => n.id));
    assert.equal(new Set(clips).size, clips.length);
    assert.equal(await house('w1').locator('.window-clip').getAttribute('clip-path'), `url(#${clips[0]})`);
    await house('w1').focus();
    await page.evaluate(() => {
      window.savedHouse = document.querySelector('[data-team-id=w1]'); window.savedArt = savedHouse.querySelector('.house-illustration');
      window.savedAnimation = savedArt.querySelector('.puff').getAnimations()[0];
    });
    // The server deduplicates unchanged snapshots, so explicitly deliver a repeated
    // SSE message to exercise renderHouses rather than merely testing server silence.
    await page.evaluate(() => fixtureEvents.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(teamTown.snapshot)})));
    await settle(page);
    assert.equal(await page.evaluate(() => savedHouse === document.activeElement && savedArt === savedHouse.querySelector('.house-illustration') && savedAnimation === savedArt.querySelector('.puff').getAnimations()[0]), true);
    // Real-time sampling for >3 smoke cycles; a single screenshot cannot establish continuity.
    const motion = await house('w1').evaluate(el => new Promise(resolve => {
      let samples = 0, gaps = 0, escaped = 0; const flags = new Set(), people = new Set(), lights = new Set(), start = performance.now();
      const timer = setInterval(() => {
        samples++;
        const puffs = [...el.querySelectorAll('.puff')];
        if (!puffs.some(n => +getComputedStyle(n).opacity > .5)) gaps++;
        const top = el.querySelector('.house-art-stage').getBoundingClientRect().top;
        if (puffs.some(n => n.getBoundingClientRect().top < top+4)) escaped++;
        flags.add(getComputedStyle(el.querySelector('.flag-cloth')).transform);
        people.add(getComputedStyle(el.querySelector('.window-person')).transform);
        lights.add(getComputedStyle(el.querySelector('.window-light')).opacity);
        if (performance.now()-start >= 12000) { clearInterval(timer); resolve({ samples,gaps,escaped,flags:flags.size,people:people.size,lights:lights.size }); }
      }, 100);
    }));
    // Background Chromium may coalesce timers; require coverage across the full 12s,
    // not an exact wall-clock scheduling rate on a busy development machine.
    assert.ok(motion.samples >= 10, JSON.stringify(motion)); assert.equal(motion.gaps,0); assert.equal(motion.escaped,0);
    assert.ok(motion.flags > 3 && motion.people > 3 && motion.lights > 3, JSON.stringify(motion));
    console.log('PASS 12s continuous busy motion', JSON.stringify(motion));
    for (const [kind, states] of [['idle',Array(5).fill('done')], ['attention',Array(5).fill('waiting')], ['unknown',Array(5).fill('unknown')], ['empty',[]], ['busy',Array(5).fill('tool')]]) {
      await setStates(states); await waitKind(kind);
      assert.deepEqual(await style('w1'), baseline, `same-house palette ${kind}`);
      assert.equal(await house('w1').locator('.state-symbol').innerText(), symbols[kind]);
      assert.equal(await visibility('w1','.smoke'), kind === 'busy' ? 'visible' : 'hidden');
      assert.equal(await visibility('w1','.window-light'), kind === 'busy' ? 'visible' : 'hidden');
      assert.equal(await visibility('w1','.sleeping-cat'), kind === 'idle' ? 'visible' : 'hidden');
      assert.equal(await visibility('w1','.closed-curtains'), ['idle','empty'].includes(kind) ? 'visible' : 'hidden');
      if (kind !== 'busy') assert.ok((await animations('w1')).every(name => name === 'none'));
      assert.equal(await page.evaluate(() => savedHouse === document.activeElement && savedArt === savedHouse.querySelector('.house-illustration')),true);
    }
    await setStates(['tool','waiting','unknown','idle','done']); await waitKind('busy');
    await page.waitForFunction(() => document.querySelector('[data-team-id=w1] .house-note').textContent.includes('状态未明'));
    assert.match(await house('w1').getAttribute('aria-label'), /1 位等待处理 · 1 位状态未明/);
    assert.match(await house('w1').innerText(), /4 日志 · 1 Herdr 回退/);
    async function assertStatic(id) {
      assert.ok((await animations(id)).every(name => name === 'none'));
      assert.equal(await visibility(id,'.smoke'),'visible');
      const poses = await house(id).locator('.puff').evaluateAll(nodes => nodes.map(n => [getComputedStyle(n).transform,+getComputedStyle(n).opacity]));
      assert.ok(poses.every(([,opacity]) => opacity > 0));
      assert.equal(new Set(poses.map(([transform]) => transform)).size,3);
      const transform = await house(id).locator('.house-illustration').evaluate(n => getComputedStyle(n).transform);
      await house(id).hover(); await house(id).focus();
      assert.equal(await house(id).locator('.house-illustration').evaluate(n => getComputedStyle(n).transform), transform);
      assert.equal(await house(id).locator('.house-arrow').evaluate(n => getComputedStyle(n).transform),'none');
    }
    await page.locator('#motion-toggle').click();
    assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'),'true');
    await assertStatic('w1');
    await setStates(['tool','tool','unknown','idle','done']);
    await page.waitForFunction(() => document.querySelector('[data-team-id=w1]').dataset.working === '2');
    assert.match(await house('w1').innerText(), /2\/5.*正在忙/, 'SSE continues while paused');
    await page.emulateMedia({ reducedMotion:'reduce' }); await settle(page);
    assert.equal(await page.locator('#motion-toggle').isVisible(),false);
    assert.match(await page.locator('#motion-reason').innerText(), /按系统设置/); await assertStatic('w1');
    await page.emulateMedia({ reducedMotion:'no-preference' }); await settle(page);
    assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'),'true');
    await page.locator('#motion-toggle').click();
    assert.ok((await animations('w1')).every(name => name !== 'none'));
    for (const mode of ['team','source','disconnect']) {
      if (mode === 'team') teams = teams.map(t => t.id === 'w1' ? {...t,presence:'stale'} : t);
      if (mode === 'source') presence = 'stale';
      if (mode === 'disconnect') await page.evaluate(() => fixtureEvents.dispatchEvent(new Event('error'))); else await emit();
      await page.waitForFunction(() => document.querySelector('[data-team-id=w1]').dataset.stale === 'true');
      await assertStatic('w1');
      assert.match(await house('w1').getAttribute('aria-label'), /上次状态：忙碌中 · 可能过期/);
      assert.equal(await house('w1').locator('.freshness-clock').isVisible(),true);
      assert.equal(await house('w1').getAttribute('data-working'),'2');
      if (mode === 'team') {
        assert.match(await house('w1').innerText(), /身份过期/);
        assert.equal(await house('ungrouped').getAttribute('data-static'),'false');
      } else assert.equal(await house('ungrouped').getAttribute('data-static'),'true');
      if (mode === 'disconnect') await page.evaluate(() => fixtureEvents.dispatchEvent(new Event('open')));
      teams = teams.map(t => ({...t,presence:'fresh'})); presence = 'fresh'; await emit();
      await page.waitForFunction(() => document.querySelector('[data-team-id=w1]').dataset.static === 'false');
      assert.ok((await animations('w1')).every(name => name !== 'none'));
    }
    teams = [...teams, ...Array.from({length:7},(_,i) => ({id:`extra-${i}`,name:`Extra ${i}`,presence:'fresh'}))];
    teams[1].name = '很长的中文团队名称'.repeat(5) + 'continuousEnglishName'.repeat(5) + '<img src=x onerror=alert(1)>';
    await setStates([...Array(110).fill('tool'),'waiting','unknown']);
    await page.waitForFunction(() => document.querySelectorAll('.house').length === 13);
    assert.equal(await page.locator('img[src=x]').count(),0);
    await house('w1').focus();
    const headroom = await house('w1').evaluate(el => {
      const puffs = [...el.querySelectorAll('.puff')], animations = puffs.map(n => n.getAnimations()[0]);
      const saved = animations.map(a => a.currentTime);
      let minimum = Infinity;
      animations.forEach(a => a.pause());
      for (let ms = 0; ms <= 3600; ms += 100) {
        animations.forEach(a => { a.currentTime = ms; });
        minimum = Math.min(minimum, ...puffs.map(n => n.getBoundingClientRect().top-el.querySelector('.house-art-stage').getBoundingClientRect().top));
      }
      animations.forEach((a,i) => { a.currentTime = saved[i]; a.play(); });
      return minimum;
    });
    assert.ok(headroom >= 4, `max-size focused smoke headroom ${headroom}`);
    for (const width of [1440,1051,1050,768,761,760,541,540,390,320]) await layoutCheck(page,width);
    // Text-only 200% enlargement, including previously px-sized business text.
    await page.evaluate(() => {
      for (const n of document.querySelectorAll('.house-sign span')) {
        const s = getComputedStyle(n); n.dataset.fontSize = s.fontSize; n.dataset.lineHeight = s.lineHeight;
      }
      for (const n of document.querySelectorAll('.house-sign span')) {
        n.style.fontSize = `${parseFloat(n.dataset.fontSize)*2}px`;
        if (Number.isFinite(parseFloat(n.dataset.lineHeight))) n.style.lineHeight = `${parseFloat(n.dataset.lineHeight)*2}px`;
      }
    });
    await layoutCheck(page,320);
    await page.evaluate(() => { for (const n of document.querySelectorAll('.house-sign span')) { n.style.fontSize=''; n.style.lineHeight=''; } });
    // Exercise row counts without waiting for new SSE after breakpoint changes.
    const allTeams = teams, allSessions = sessions;
    for (const count of [0,1,2,3,13]) {
      teams = allTeams.slice(0,count); sessions = allSessions.filter(s => teams.some(t => t.id === s.teamId)); await emit();
      await page.waitForFunction(count => document.querySelectorAll('.house').length === count,count);
      for (const width of [1440,390]) {
        await layoutCheck(page,width);
        const rows = Math.ceil(count/(width <= 760 ? 1 : 2));
        assert.equal(await page.locator('.plaza').isVisible(), rows > 1);
        assert.equal(await page.locator('.street-tree').first().isVisible(), rows > 1);
      }
    }
    assert.equal(await page.locator('#motion-toggle').evaluate(n => n.getBoundingClientRect().height >= 44),true);
    assert.equal(await page.locator('.header-meta a').evaluateAll(nodes => nodes.every(n => n.getBoundingClientRect().height >= 44)),true);
    // Both native keyboard activation paths retain the original office entry URL.
    await house('w1').focus(); await page.keyboard.press('Enter'); await page.waitForURL('**/office?team=w1');
    await page.goto(base); await page.waitForSelector('[data-team-id=w2]');
    await house('w2').focus(); await page.keyboard.press('Space'); await page.waitForURL('**/office?team=w2');
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
    console.log('PASS homepage: log-first + roles; same-house colors; all five non-color states; 12s continuous motion; mixed attention/unknown; pause/reduce/stale; responsive 0/1/2/3/13 houses, plants/cat clearances, 200% text, focus and keyboard');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
