'use strict';
// Cloudflare remote view: privacy whitelist, offline rule, Access JWT checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = (p) => import(pathToFileURL(path.join(__dirname, '..', p)).href);

const RAW = {
  now: 1700000000000, lang: 'zh', privacy: false,
  source: { kind: 'logs+herdr', presence: 'fresh', error: 'C:/secret/path', statusPolicy: 'x' },
  teams: [{ id: 'w1', workspaceId: 'w1', name: 'm365', label: 'm365', sourceStatus: 'blocked', presence: 'fresh', guidelines: '# AGENTS.md secret' },
          { id: '../evil', name: 'bad' }],
  sessions: [{
    key: 'herdr:w1-p1:019abc', id: 'w1-p1', agent: 'codex', status: 'tool', sourceStatus: 'working', statusSource: 'log', source: 'log',
    displayName: 'team-leader', teamId: 'w1', workspaceId: 'w1', paneId: 'w1-p1', tabId: 't1', role: 'leader', presence: 'fresh',
    prompt: 'PROMPT', reply: 'REPLY', title: 'TITLE', error: 'ERR', activity: 'Bash: rm -rf', cwd: '/Users/x/company', project: 'company',
    model: 'gpt', sessionId: '019abc', logSessionId: '019abc', logKey: 'codex:019abc', parentId: 'p', subagent: false,
    lastEventAt: 1700000000000, startedAt: 1699999990000, turnStartedAt: 1699999999000, capabilities: { resume: true }, agentsMd: 'x',
  }],
};

test('whitelist keeps only team/member/agent/status/time fields', async () => {
  const { sanitizeSnapshot } = await load('cloudflare/shared/whitelist.mjs');
  const out = sanitizeSnapshot(RAW);
  assert.deepEqual(Object.keys(out).sort(), ['lang', 'now', 'privacy', 'sessions', 'source', 'teams']);
  assert.equal(out.lang, null); assert.equal(out.privacy, true);
  assert.deepEqual(out.teams, [{ id: 'w1', name: 'm365', label: 'm365', presence: 'fresh' }]);
  assert.deepEqual(Object.keys(out.sessions[0]).sort(), ['agent', 'displayName', 'key', 'lastEventAt', 'presence', 'source', 'sourceStatus', 'startedAt', 'status', 'statusSource', 'subagent', 'teamId', 'turnStartedAt']);
  const text = JSON.stringify(out);
  for (const secret of ['PROMPT', 'REPLY', 'TITLE', 'ERR', 'Bash', '/Users', 'company', 'gpt', '019abc', 'w1-p1', 'AGENTS', 'secret', '"role"', 'capabilities']) assert.ok(!text.includes(secret), secret);
  assert.equal(out.source.error, null);
});

test('push side hashes member keys and marks unreadable source stale', async () => {
  const { prepare, shouldSend } = await load('cloudflare/push/push.mjs');
  const out = prepare(RAW, false);
  assert.match(out.sessions[0].key, /^k_[0-9a-f]{16}$/);
  assert.equal(out.source.presence, 'stale');
  assert.equal(shouldSend('a', { sig: 'a', sentAt: 0 }, 19_999), false);
  assert.equal(shouldSend('a', { sig: 'a', sentAt: 0 }, 20_000), true);
  assert.equal(shouldSend('b', { sig: 'a', sentAt: 0 }, 1), true);
});

test('remote snapshots retain new providers and gateway provenance without new private fields', async () => {
  const { sanitizeSnapshot } = await load('cloudflare/shared/whitelist.mjs');
  const { prepare } = await load('cloudflare/push/push.mjs');
  const providers = ['copilot', 'omp', 'kimi', 'dsh', 'grok'];
  const raw = { ...RAW, summary: { projects: { PRIVATE_PROJECT: 4 }, tokens: 1234 },
    sessions: providers.map(agent => ({ ...RAW.sessions[0], agent, source: 'magpie', statusSource: 'magpie',
      context: { used: 500, window: 1000 }, today: { turns: 4, tokens: 1234 }, ompProfile: 'PRIVATE_PROFILE', resumeCommand: 'PRIVATE_COMMAND' })) };
  const out = sanitizeSnapshot(prepare(raw, true));
  assert.deepEqual(out.sessions.map(s => s.agent), providers);
  assert.ok(out.sessions.every(s => s.source === 'magpie' && s.statusSource === 'magpie'));
  for (const forbidden of ['PRIVATE', 'summary', 'context', 'today', 'ompProfile', 'resumeCommand']) {
    assert.equal(JSON.stringify(out).includes(forbidden), false, forbidden);
  }
});

test('authenticated remote assets include new provider SVGs while local rules remain inaccessible', async t => {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await subtle.exportKey('jwk', pair.publicKey), kid: 'fixture-key' };
  const { accessKeys } = await load('cloudflare/viewer/access.mjs');
  const team = 'https://asset-fixture.cloudflareaccess.com';
  await accessKeys(team, async () => Response.json({ keys: [jwk] }));
  const seconds = Math.floor(Date.now() / 1000);
  const b64 = value => Buffer.from(value).toString('base64url');
  const data = `${b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid }))}.${b64(JSON.stringify({ iss: team, aud: ['fixture-aud'], sub: 'fixture', iat: seconds, exp: seconds + 600, email: 'fixture@example.test' }))}`;
  const token = `${data}.${b64(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(data)))}`;
  const { default: worker } = await load('cloudflare/viewer/worker.mjs');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(__dirname, '../cloudflare/build.mjs')]);
  const requested = [];
  const env = { VIEWER_HOST: 'fixture.example.test', ACCESS_TEAM_URL: team, ACCESS_AUD: 'fixture-aud', ALLOWED_VIEWER_EMAIL: 'fixture@example.test',
    ASSETS: { fetch: async request => { const asset = new URL(request.url || request).pathname; requested.push(asset); return new Response(fs.readFileSync(path.join(__dirname, '../cloudflare/dist', asset)), { headers: { 'content-type': 'image/svg+xml' } }); } } };
  const request = (asset, authenticated = true) => worker.fetch(new Request(`https://${env.VIEWER_HOST}${asset}`, {
    headers: authenticated ? { 'cf-access-jwt-assertion': token } : {},
  }), env);
  for (const provider of ['copilot', 'omp', 'kimi', 'dsh', 'grok']) {
    const asset = `/assets/agents/${provider}.svg`;
    const response = await request(asset);
    assert.equal(response.status, 200, provider);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), fs.readFileSync(path.join(__dirname, '..', asset), 'utf8'));
    assert.equal((await request(asset, false)).status, 403);
  }
  for (const asset of ['/rules-ui.js', '/api/rules', '/assets/agents/README.md']) assert.equal((await request(asset)).status, 404);
  assert.equal(requested.length, 5, 'only authenticated, allowed assets reach the asset binding');
});

test('viewer shows mini-1 offline after 60s without a push', async () => {
  const shim = require('../cloudflare/viewer/remote-shim.js');
  const shared = await load('cloudflare/shared/whitelist.mjs');
  for (const isOffline of [shim.isOffline, shared.isOffline]) {
    const clock = { lastPushAt: 1000, serverNow: 21_000, receivedAt: 500_000 };
    assert.equal(isOffline(clock, 500_000), false);          // 20s old
    assert.equal(isOffline(clock, 540_000), false);          // 60s old
    assert.equal(isOffline(clock, 540_001), true);           // >60s
    assert.equal(isOffline(null, 1), true);                  // never pushed
  }
  const stale = shim.withPresence({ sessions: [], source: { presence: 'fresh' } }, true);
  assert.equal(stale.source.presence, 'stale');
  assert.match(stale.source.error, /mini-1 离线/);
});

test('Access JWT: signature, issuer, audience, expiry and exact email', async () => {
  const { verifyAccessJwt } = await load('cloudflare/viewer/access.mjs');
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const now = 1_800_000_000_000, team = 'https://team.cloudflareaccess.com', aud = 'AUD1';
  const sign = async (claims, kid = 'k1') => {
    const head = b64(JSON.stringify({ alg: 'RS256', kid })), body = b64(JSON.stringify(claims));
    return `${head}.${body}.${b64(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(`${head}.${body}`)))}`;
  };
  const good = { iss: team, aud: [aud], sub: 'u', iat: now / 1000 - 10, exp: now / 1000 + 600, email: 'MXHAN@outlook.com' };
  const opts = { teamUrl: team, audience: aud, allowedEmail: 'mxhan@outlook.com', getKeys: async () => new Map([['k1', pair.publicKey]]), now };
  assert.deepEqual(await verifyAccessJwt(await sign(good), opts), { email: 'mxhan@outlook.com' });
  assert.equal(await verifyAccessJwt(null, opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, aud: ['other'] }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, iss: 'https://evil' }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 600 }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, email: 'someone@else.com' }), opts), null);
  assert.equal(await verifyAccessJwt(await sign(good, 'k2'), opts), null);
  const token = await sign(good);
  assert.equal(await verifyAccessJwt(token.slice(0, -4) + 'AAAA', opts), null);
});
