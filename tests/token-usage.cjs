'use strict';
// Synthetic histories only; never reads the user's agent logs.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageMonitor } = require('../src/token-usage');
const { sanitizeUsage } = require('../src/usage-schema');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T10:00:00+08:00');
const stamp = at => new Date(at).toISOString();
const codex = (at, tokens, total = tokens) => ({ type: 'event_msg', timestamp: stamp(at), payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: total, output_tokens: 0 }, last_token_usage: { input_tokens: tokens - 2, output_tokens: 2, cached_input_tokens: 3, reasoning_output_tokens: 1 },
} } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [];
  return { files, write(name, agent, events) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    fs.utimesSync(file, NOW / 1000, NOW / 1000);
    files.push({ agent, file });
    return file;
  } };
}

test('calendar totals include cache once, deduplicate copied responses, and compare equal rolling weeks', async t => {
  const f = fixture(t);
  const events = [codex(NOW - 15 * DAY, 10), codex(NOW - 13 * DAY, 60, 70), codex(NOW - 8 * DAY, 50, 120),
    codex(NOW - 5 * DAY, 70, 190), codex(NOW - DAY, 20, 210), codex(NOW, 30, 240)];
  events.push({ ...events.at(-1), timestamp: stamp(NOW + 1) });
  f.write('codex.jsonl', 'codex', events);
  f.write('fork-copy.jsonl', 'codex', events.slice(0, -1));
  const claude = { type: 'assistant', timestamp: stamp(NOW), message: { id: 'response-one', usage: {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [] } };
  f.write('claude.jsonl', 'claude', [claude, claude]);
  const copilot = { type: 'session.usage_record', id: 'event-one', timestamp: stamp(NOW), data: { usage: {
    inputTokens: 200, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 45, reasoningTokens: 20, accounting: { sourceSessionId: 'root-one', usageId: 'call-one' } } } };
  f.write('copilot.jsonl', 'copilot', [copilot, { ...copilot, id: 'replayed-event' }]);
  f.write('other-copilot.jsonl', 'copilot', [{ ...copilot, data: { usage: { ...copilot.data.usage, accounting: { sourceSessionId: 'root-two', usageId: 'call-one' } } } }]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => NOW });
  await monitor.poll();
  const value = monitor.snapshot();
  assert.equal(value.status, 'ready');
  assert.equal(value.todayTokens, 30 + 135 + 2 * 230);
  assert.equal(value.monthTokens, 20 + 30 + 135 + 2 * 230);
  assert.equal(value.weekTokens, 70 + 20 + 30 + 135 + 2 * 230);
  assert.equal(value.previousWeekTokens, 60 + 50);
  assert.equal(value.day, '2026-11-02');
  assert.equal(value.month, '2026-11');
  assert.deepEqual(value.agents, ['claude', 'codex', 'copilot']);
  await monitor.poll();
  assert.deepEqual(monitor.snapshot(), value, 'unchanged polls do not add usage again');
});

test('full streamed history includes middle records and handles partial appends and replacement', async t => {
  const f = fixture(t);
  const file = f.write('large.jsonl', 'codex', [codex(NOW, 100), { prompt: 'PRIVATE'.repeat(220_000) }, codex(NOW + 1, 200, 300),
    { output: 'PRIVATE'.repeat(220_000) }, codex(NOW + 2, 300, 600)]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => NOW + 100 });
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 600, 'usage in the middle is not skipped');
  const next = JSON.stringify(codex(NOW + 3, 400, 1000));
  fs.appendFileSync(file, next.slice(0, next.length / 2));
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 600, 'an unfinished record is not guessed');
  fs.appendFileSync(file, next.slice(next.length / 2) + '\n');
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 1000);
  fs.writeFileSync(file, JSON.stringify(codex(NOW, 50)) + '\n');
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 50, 'rewritten histories replace old contributions');
});

test('local midnight, month rollover and exact seven-day boundaries update without new log lines', async t => {
  const f = fixture(t);
  let now = Date.parse('2026-11-01T00:00:00+08:00');
  f.write('dates.jsonl', 'codex', [codex(now - 14 * DAY - 1, 10, 10), codex(now - 14 * DAY, 20, 30),
    codex(now - 7 * DAY, 30, 60), codex(now - 1, 40, 100), codex(now, 50, 150)]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => now });
  await monitor.poll();
  assert.equal(monitor.snapshot().monthTokens, 50);
  assert.equal(monitor.snapshot().todayTokens, 50);
  assert.equal(monitor.snapshot().weekTokens, 120);
  assert.equal(monitor.snapshot().previousWeekTokens, 20);
  now += DAY;
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 0);
  assert.equal(monitor.snapshot().monthTokens, 50);
  assert.equal(monitor.snapshot().weekTokens, 90);
  assert.equal(monitor.snapshot().previousWeekTokens, 30);
});

test('Gemini updates and OMP message usage retain provider totals without counting cached subsets twice', async t => {
  const f = fixture(t);
  const message = { type: 'gemini', id: 'g1', timestamp: stamp(NOW), tokens: { input: 100, output: 20, cached: 80, thoughts: 5, total: 125 } };
  f.write('gemini.jsonl', 'gemini', [message, { ...message, content: 'PRIVATE' }]);
  f.write('legacy.json', 'gemini', []);
  fs.writeFileSync(f.files.at(-1).file, JSON.stringify({ messages: [message] }));
  f.write('omp.jsonl', 'omp', [{ type: 'message', id: 'o1', timestamp: stamp(NOW), message: { role: 'assistant', usage: {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 } } }]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => NOW });
  await monitor.poll();
  assert.equal(monitor.snapshot().todayTokens, 225);
});

test('missing or unreadable records stay unavailable and snapshots contain only bounded aggregate fields', async t => {
  const f = fixture(t);
  const file = f.write('valid.jsonl', 'codex', [codex(NOW, 100)]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => NOW });
  assert.equal(monitor.snapshot().status, 'loading');
  assert.equal(monitor.snapshot().todayTokens, null);
  await monitor.poll();
  const valid = monitor.snapshot();
  const sanitized = sanitizeUsage({ ...valid, path: '/PRIVATE/log', request: 'PRIVATE', prompt: 'PRIVATE', agents: ['codex', 'PRIVATE'], previousWeekTokens: -1 });
  assert.equal(sanitized.status, 'unavailable');
  assert.equal(sanitized.todayTokens, null);
  assert.ok(!JSON.stringify(sanitized).includes('PRIVATE'));
  assert.equal(sanitizeUsage({ ...valid, timeZone: '/PRIVATE/log' }).timeZone, null);
  f.files.push({ agent: 'codex', file: file + '.missing' });
  await monitor.poll();
  assert.equal(monitor.snapshot().status, 'partial');
  assert.equal(monitor.snapshot().todayTokens, 100);
  fs.unlinkSync(file);
  await monitor.poll();
  assert.equal(monitor.snapshot().status, 'unavailable');
  assert.equal(monitor.snapshot().todayTokens, null, 'missing records are not presented as zero');
});

test('HTTP and SSE carry sanitized aggregate usage and remote whitelists strip private evidence', async t => {
  const { EventEmitter } = require('node:events');
  const { createServer } = require('../src/server');
  const f = fixture(t);
  f.write('http.jsonl', 'codex', [codex(NOW, 123)]);
  const monitor = new UsageMonitor({ files: () => f.files, now: () => NOW });
  const watcher = new EventEmitter(); watcher.sessions = () => [];
  const server = createServer(watcher, {}, { usageMonitor: monitor });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await monitor.poll();
  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(snapshot.usage.todayTokens, 123);
  const response = await fetch(`${base}/events`);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"todayTokens":123/);
  await reader.cancel();
  const { sanitizeSnapshot } = await import('../cloudflare/shared/whitelist.mjs');
  const remote = sanitizeSnapshot({ ...snapshot, usage: { ...snapshot.usage, path: '/PRIVATE/log', requestId: 'PRIVATE', prompt: 'PRIVATE' } });
  assert.equal(remote.usage.todayTokens, 123);
  assert.equal(JSON.stringify(remote).includes('PRIVATE'), false);
  assert.deepEqual(sanitizeSnapshot(remote), remote, 'push and ingest use the same aggregate whitelist');
});
