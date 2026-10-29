// Real browser framing rules + viewer Worker, with synthetic Access and state.
// No live credentials, Cloudflare requests or private local logs are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

(async () => {
  execFileSync(process.execPath, [path.join(root, 'cloudflare/build.mjs')]);
  const { accessKeys } = await import('../cloudflare/viewer/access.mjs');
  const { default: worker } = await import('../cloudflare/viewer/worker.mjs');
  const team = 'https://pip-fixture.cloudflareaccess.com', seconds = Math.floor(Date.now() / 1000);
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'pip-fixture' };
  await accessKeys(team, async () => Response.json({ keys: [jwk] }));
  const b64 = value => Buffer.from(value).toString('base64url');
  const claims = { iss: team, aud: ['pip-fixture'], sub: 'fixture', email: 'fixture@example.test', iat: seconds, exp: seconds + 600 };
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid }))}.${b64(JSON.stringify(claims))}`;
  const token = `${unsigned}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(unsigned)))}`;

  // Node lacks Workers' HTMLRewriter. Model only the head.prepend operation;
  // the actual Worker still chooses the route, verifies JWTs and sets headers.
  const originalRewriter = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = class {
    on(selector, handler) { assert.equal(selector, 'head'); this.handler = handler; return this; }
    transform(response) {
      const handler = this.handler;
      return new Response(new ReadableStream({ async start(controller) {
        try {
          let prefix = '';
          handler.element({ prepend(value) { prefix += value; } });
          controller.enqueue(new TextEncoder().encode((await response.text()).replace('<head>', '<head>' + prefix)));
          controller.close();
        } catch (error) { controller.error(error); }
      } }), response);
    }
  };
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json' };
  const env = {
    VIEWER_HOST: '127.0.0.1', ACCESS_TEAM_URL: team, ACCESS_AUD: 'pip-fixture', ALLOWED_VIEWER_EMAIL: 'fixture@example.test',
    ASSETS: { fetch(request) {
      const file = path.join(root, 'cloudflare/dist', new URL(request.url || request).pathname);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream' } });
    } },
  };
  const requests = [], serverErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers(req.headers);
      const authenticated = /(?:^|;\s*)fixture_access=yes(?:;|$)/.test(req.headers.cookie || '');
      if (authenticated) headers.set('cf-access-jwt-assertion', token);
      const response = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers }), env);
      requests.push({ path: req.url, authenticated, status: response.status });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { serverErrors.push(error.message); res.writeHead(500).end(); }
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<iframe src="${base}/office?team=fixture&pip=1"></iframe>`);
  });
  await listen(foreign);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.WMAD_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'fixture_access', value: 'yes', url: base, sameSite: 'Lax', httpOnly: true }]);
    const channels = new Set(), errors = [], consoleErrors = [];
    let status = 'thinking';
    const update = () => ({ lastPushAt: Date.now(), serverNow: Date.now(), snapshot: {
      now: Date.now(), privacy: true, teams: [{ id: 'fixture', name: 'Fixture town', presence: 'fresh' }],
      sessions: [{ key: 'k_0000000000000001', teamId: 'fixture', displayName: 'Fixture lead', agent: 'codex', status, statusSource: 'log', source: 'log', presence: 'fresh', lastEventAt: Date.now() }],
      source: { kind: 'remote', presence: 'fresh' },
    } });
    await context.routeWebSocket('**/ws', channel => {
      channels.add(channel); channel.onClose(() => channels.delete(channel));
      channel.send(JSON.stringify(update()));
    });
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    });
    const page = await context.newPage();
    await page.goto(base + '/office?team=fixture&quality=mid');
    await page.waitForFunction(() => teamOffice.snapshot.sessions.length === 1 && teamOffice.office?.framesShown > 4);
    const popupReady = context.waitForEvent('page');
    await page.locator('#pipBtn').click();
    const popup = await popupReady;
    try {
      await popup.frameLocator('iframe').locator('#office canvas').waitFor({ timeout: 7000 });
    } catch {
      throw new Error('Remote PiP failed to render: ' + consoleErrors.join('\n'));
    }
    const frame = popup.frames().find(frame => new URL(frame.url(), base).searchParams.get('pip') === '1');
    await frame.waitForFunction(() => teamOffice.snapshot.sessions.length === 1 && teamOffice.office?.framesShown > 4);
    assert.equal(await frame.evaluate(() => teamOffice.teamId), 'fixture');
    assert.equal(await frame.evaluate(() => teamOffice.snapshot.source.kind), 'remote');
    assert.ok(requests.some(r => new URL(r.path, base).searchParams.get('pip') === '1' && r.authenticated && r.status === 200), 'PiP keeps the same-site login cookie');
    assert.equal(await page.evaluate(() => teamOffice.office.visible), false);
    status = 'done'; for (const channel of channels) channel.send(JSON.stringify(update()));
    await frame.waitForFunction(() => teamOffice.snapshot.sessions[0].status === 'done');
    await frame.locator('#qualSeg [data-v=high]').click();
    await frame.waitForFunction(() => officeKind === 'high:office' && teamOffice.office?.loaded && teamOffice.office.framesShown > 4);
    assert.equal(await frame.locator('#rules-entry,.member-activity').count(), 0);
    await popup.close(); await page.waitForFunction(() => !teamOffice.popout.win && teamOffice.office.visible);
    assert.deepEqual(errors, []); assert.deepEqual(serverErrors, []);

    // Only compact office pages opt in to same-origin framing.
    for (const route of ['/office?pip=1', '/office/?pip=1']) {
      const response = await context.request.get(base + route);
      assert.equal(response.status(), 200);
      assert.equal(response.headers()['x-frame-options'], 'SAMEORIGIN');
      assert.equal(response.headers()['content-security-policy'], "frame-ancestors 'self'");
      assert.equal(response.headers()['access-control-allow-origin'], undefined);
    }
    for (const route of ['/', '/town?pip=1', '/office', '/office?pip=0']) {
      assert.equal((await context.request.get(base + route)).headers()['x-frame-options'], 'DENY');
    }
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.get(base + '/office?pip=1')).status(), 403);
    await anonymous.close();
    const other = await context.newPage();
    const blocked = other.waitForEvent('console', { predicate: message => /frame-ancestors|X-Frame-Options/.test(message.text()), timeout: 7000 });
    await other.goto(`http://127.0.0.1:${foreign.address().port}`); await blocked;
    assert.equal(await other.locator('iframe').contentFrame().locator('#office canvas').count(), 0, 'another origin cannot embed the authenticated compact view');
    await context.close();
    console.log('PASS remote PiP: authenticated same-origin frame, 2D/3D, live feed, close, strict normal-page and cross-origin framing, no CORS relaxation');
  } finally {
    await browser?.close(); await stop(server); await stop(foreign);
    if (originalRewriter === undefined) delete globalThis.HTMLRewriter; else globalThis.HTMLRewriter = originalRewriter;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
