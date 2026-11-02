'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { QuotaMonitor, normalizeQuota, configuredQuotaMonitor } = require('../src/quota');
const { sanitizeQuotaSnapshot } = require('../src/quota-schema');
const { quotaView } = require('../public/quota');

const NOW = 1_800_000_000_000;
const account = { id: 'work', host: 'example.ghe.com', login: 'fixture-work' };
const raw = (login = account.login) => ({
  login, copilot_plan: 'enterprise', quota_reset_date: '2026-12-01', token: 'SECRET_TOKEN',
  quota_snapshots: {
    premium_interactions: { unlimited: false, has_quota: true, percent_remaining: 95.5, credits_used: 45_197, entitlement: 1_000_000 },
    chat: { unlimited: true }, completions: { unlimited: true },
  },
});

test('quota configuration is optional and resolves only explicitly selected, confirmed identities', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-quota-'));
  try {
    const config = path.join(dir, 'config.json'), helper = path.join(dir, 'scripts', 'helper.py');
    assert.equal(configuredQuotaMonitor(config), null);
    fs.mkdirSync(path.dirname(helper)); fs.writeFileSync(helper, '# fixture only\n');
    fs.mkdirSync(path.join(dir, 'references'));
    fs.writeFileSync(path.join(dir, 'references/accounts.json'), JSON.stringify({ work: account }));
    fs.writeFileSync(config, JSON.stringify({ helper, profiles: ['work'] }));
    const monitor = configuredQuotaMonitor(config);
    assert.deepEqual(monitor.accounts, [account]); monitor.stop();
    fs.writeFileSync(config, JSON.stringify({ helper, profiles: ['unconfirmed'] }));
    assert.throws(() => configuredQuotaMonitor(config), /configuration is invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('homepage distinguishes unlimited, missing, failed and expired evidence without making up percentages', () => {
  const record = normalizeQuota(account, raw(), NOW);
  const clock = { serverNow: NOW, receivedAt: NOW, failed: false };
  assert.equal(quotaView(record, clock, NOW).remaining, '95.5%');
  assert.equal(quotaView(record, clock, NOW).usage, '45,197 / 1,000,000');
  assert.equal(quotaView(record, clock, NOW).stale, false);
  assert.equal(quotaView(record, clock, NOW + 60 * 60_000).stale, false);
  assert.equal(quotaView(record, clock, NOW + 3 * 60 * 60_000).stale, false);
  assert.equal(quotaView(record, clock, NOW + 3 * 60 * 60_000 + 1).note, '已过期');
  assert.equal(quotaView({ ...record, status: 'auth-required' }, clock, NOW).note, '需要重新登录');
  assert.equal(quotaView({ ...account, status: 'pending' }, clock, NOW).remaining, '—');
  const unlimited = { ...record, premium: { unlimited: true, remainingPercent: 100, used: 0, limit: 0 } };
  assert.equal(quotaView(unlimited, clock, NOW).remaining, '不限额');
  assert.equal(quotaView(unlimited, clock, NOW).usage, '未提供统计');
  assert.equal(quotaView(unlimited, clock, NOW).percent, null);
});

test('quota uses the API percentage, keeps accounting units, and never exports credentials', () => {
  const record = normalizeQuota(account, raw(), NOW);
  assert.equal(record.premium.remainingPercent, 95.5);
  assert.equal(record.premium.used, 45_197);
  assert.equal(record.premium.limit, 1_000_000);
  assert.equal(record.updatedAt, NOW);
  const snapshot = sanitizeQuotaSnapshot({ capturedAt: NOW, accounts: [{ ...record, token: 'SECRET_TOKEN', error: 'SECRET_ERROR' }], token: 'SECRET_TOKEN' });
  assert.equal(snapshot.accounts[0].error, null);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  const unlimited = raw();
  Object.assign(unlimited.quota_snapshots.premium_interactions, { unlimited: true, has_quota: false, entitlement: 0, credits_used: 0, percent_remaining: 100 });
  const result = normalizeQuota(account, unlimited, NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.premium.unlimited, true);
  assert.equal(result.premium.remainingPercent, null, 'unlimited is not a measured 100% remaining');
  assert.throws(() => normalizeQuota(account, raw('wrong-account'), NOW), /identity/);
  const malformed = raw(); malformed.quota_snapshots.premium_interactions.percent_remaining = 101;
  assert.throws(() => normalizeQuota(account, malformed, NOW), /invalid/);
  assert.equal(sanitizeQuotaSnapshot({ capturedAt: NOW, accounts: [{ ...record, host: 'https://evil.test/?token=SECRET' }] }).accounts.length, 0);
  assert.equal(sanitizeQuotaSnapshot({ capturedAt: NOW, accounts: [{ ...record, login: 123 }] }).accounts.length, 0);
});

test('independent polls retain last successful values as failed, coalesce refreshes and discard stopped results', async () => {
  let now = NOW, failing = false, calls = 0;
  const accounts = [account, { id: 'other', host: 'github.com', login: 'fixture-other' }];
  const monitor = new QuotaMonitor({ accounts, now: () => now, query: async a => {
    calls++;
    if (failing && a.id === 'work') throw Object.assign(new Error('SECRET_TOKEN'), { quotaError: 'authentication' });
    return raw(a.login);
  } });
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.equal(calls, 2);
  now += 60 * 60_000; failing = true;
  await monitor.refresh();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.accounts[0].status, 'auth-required');
  assert.equal(snapshot.accounts[0].updatedAt, NOW);
  assert.equal(snapshot.accounts[0].checkedAt, now);
  assert.equal(snapshot.accounts[0].premium.remainingPercent, 95.5);
  assert.equal(snapshot.accounts[1].status, 'ok');
  assert.equal(snapshot.accounts[1].updatedAt, now);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  let release;
  const stopped = new QuotaMonitor({ accounts: [account], now: () => now, query: () => new Promise(resolve => { release = resolve; }) });
  const poll = stopped.refresh();
  stopped.stop(); release(raw()); await poll;
  assert.equal(stopped.snapshot().capturedAt, null);
  monitor.stop();
});

test('background collection runs on startup and every hour, independently of page reads', async t => {
  let tick, now = NOW, calls = 0;
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 60 * 60_000); tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const monitor = new QuotaMonitor({ accounts: [account], now: () => now, query: async () => { calls++; return raw(); } });
  monitor.start(); await monitor.inFlight;
  assert.equal(calls, 1);
  monitor.snapshot(); monitor.snapshot(); assert.equal(calls, 1);
  now += 60 * 60_000; tick(); await monitor.inFlight;
  assert.equal(calls, 2);
  assert.equal(monitor.snapshot().capturedAt, now);
  monitor.stop(); tick(); await Promise.resolve();
  assert.equal(calls, 2);
});

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(entries) { for (const [key, value] of Object.entries(entries)) this.values.set(key, structuredClone(value)); }
  async delete(keys) { for (const key of keys) this.values.delete(key); }
  async transaction(fn) { return fn(this); }
  async list({ prefix, start, end, reverse, limit = 1000 }) {
    let rows = [...this.values].filter(([key]) => key.startsWith(prefix) && (!start || key >= start) && (!end || key < end)).sort(([a], [b]) => a.localeCompare(b));
    if (reverse) rows.reverse();
    return new Map(rows.slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
}

test('cloud quota history survives a new reader, deduplicates heartbeats, rejects older captures and expires at 90 days', async () => {
  const { saveQuota, readQuotaHistory, HISTORY_MS, LATEST_KEY } = await import('../cloudflare/shared/quota-store.mjs');
  const storage = new Storage();
  const sample = at => ({ capturedAt: at, accounts: [normalizeQuota(account, raw(), at)] });
  await saveQuota(storage, sample(NOW - HISTORY_MS - 1), NOW - HISTORY_MS - 1);
  await saveQuota(storage, sample(NOW), NOW);
  await saveQuota(storage, sample(NOW), NOW);
  await saveQuota(storage, sample(NOW - 1), NOW);
  assert.equal((await storage.get(LATEST_KEY)).capturedAt, NOW);
  const history = await readQuotaHistory(storage, NOW);
  assert.equal(history.length, 1);
  assert.equal(history[0].capturedAt, NOW);
  assert.equal(storage.values.size, 2, 'one latest key and one retained history sample');
  assert.equal(JSON.stringify([...storage.values]).includes('SECRET'), false);
});

test('Durable Object recreation restores quota but keeps town sessions in memory only', async t => {
  const { TownState } = await import('../cloudflare/ingest/worker.mjs');
  const previous = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  t.after(() => { if (previous === undefined) delete globalThis.WebSocketRequestResponsePair; else globalThis.WebSocketRequestResponsePair = previous; });
  const storage = new Storage();
  const context = () => ({ storage, getWebSockets: () => [], setWebSocketAutoResponse() {} });
  const original = new TownState(context());
  await original.fetch(new Request('https://town/push', { method: 'POST', body: JSON.stringify({
    now: NOW, teams: [], sessions: [], token: 'SECRET_TOKEN',
    quota: { capturedAt: NOW, accounts: [normalizeQuota(account, raw(), NOW)] },
  }) }));
  const restored = new TownState(context());
  const body = await (await restored.fetch(new Request('https://town/quota'))).json();
  assert.equal(body.quota.accounts[0].premium.remainingPercent, 95.5);
  assert.equal((await (await restored.fetch(new Request('https://town/state'))).json()).snapshot, null);
  assert.equal(JSON.stringify([...storage.values]).includes('SECRET'), false);
});

test('local HTTP and the upload whitelist expose cached quota only, with no request-triggered GitHub calls', async () => {
  const { sanitizeSnapshot } = await import('../cloudflare/shared/whitelist.mjs');
  const source = new EventEmitter(); source.sessions = () => []; source.teams = () => [];
  const monitor = new EventEmitter();
  const quota = { capturedAt: NOW, accounts: [normalizeQuota(account, raw(), NOW)] };
  monitor.snapshot = () => ({ ...quota, token: 'SECRET_TOKEN' });
  let starts = 0, stops = 0;
  monitor.start = () => starts++; monitor.stop = () => stops++;
  const server = createServer(source, {}, { quotaMonitor: monitor });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/quota`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.quota.accounts[0].premium.remainingPercent, 95.5);
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
    assert.equal((await fetch(`${base}/api/quota`, { method: 'POST' })).status, 405);
    const snapshot = await (await fetch(`${base}/api/sessions`)).json();
    const uploaded = sanitizeSnapshot({ ...snapshot, token: 'SECRET_TOKEN' });
    assert.equal(uploaded.quota.accounts.length, 1);
    assert.equal(JSON.stringify(uploaded).includes('SECRET'), false);
    assert.equal(starts, 1);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  assert.equal(stops, 1);
});
