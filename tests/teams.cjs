const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { joinSessions, TeamWatcher } = require('../src/teams');
const { view, snapshot } = require('../src/server');
const NOW = 10_000_000;
const member = (extra = {}) => ({ key: 'herdr:w1:p1:abc', id: 'w1:p1', paneId: 'w1:p1', agent: 'codex', logAgent: 'codex',
  logSessionId: 'abc', displayName: 'leader', teamId: 'w1', workspaceId: 'w1', role: 'leader', source: 'herdr',
  status: 'thinking', sourceStatus: 'working', lastEventAt: NOW, startedAt: NOW, turnStartedAt: NOW, presence: 'fresh', ...extra });
const log = (extra = {}) => ({ id: 'abc', agent: 'codex', status: 'done', lastEventAt: 1000, startedAt: 10, turnStartedAt: 900,
  prompt: 'SECRET PROMPT', reply: 'SECRET REPLY', title: 'SECRET TITLE', ...extra });

test('exact provider/session binding: log states and times win, Herdr supplies identity only, no duplicate', () => {
  const result = joinSessions([member()], [log()]);
  assert.equal(result.length, 1);
  assert.deepEqual([result[0].status, result[0].lastEventAt, result[0].turnStartedAt, result[0].startedAt], ['done', 1000, 900, 10]);
  assert.equal(result[0].displayName, 'leader'); assert.equal(result[0].role, 'leader');
  assert.equal(result[0].teamId, 'w1'); assert.equal(result[0].statusSource, 'log');
  assert.equal(result[0].herdrStatus, 'working'); assert.equal(result[0].logKey, 'codex:abc');
  const projected = view(result[0], NOW, {});
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
  assert.equal(projected.sourceStatus, 'done');
});

test('all original timeout boundaries apply to joined log states regardless of Herdr working heartbeat', () => {
  const cases = [['typing', 45_000, 'done'], ['thinking', 15 * 60_000, 'idle'], ['tool', 45 * 60_000, 'idle'], ['waiting', 2 * 3600_000, 'idle'], ['error', 2 * 3600_000, 'idle']];
  for (const [status, threshold, expected] of cases) {
    for (const delta of [0, 1]) {
      const raw = log({ status, lastEventAt: NOW - threshold - delta });
      const joined = joinSessions([member()], [raw])[0];
      assert.equal(view(joined, NOW, {}).status, delta ? expected : status);
      for (const field of ['status', 'activity', 'lastEventAt', 'turnStartedAt', 'startedAt']) assert.equal(view(joined, NOW, {})[field], view(raw, NOW, {})[field]);
    }
  }
  for (const status of ['idle', 'done', 'interrupted']) assert.equal(view(joinSessions([member()], [log({ status })])[0], NOW, {}).status, status);
});

test('Claude/Codex/Gemini identity is preserved and Gemini sessionId aliases bind exactly', () => {
  for (const agent of ['claude', 'codex', 'gemini']) {
    const raw = log({ agent, id: agent === 'gemini' ? 'session-file-name' : 'abc', sessionId: agent === 'gemini' ? 'abc' : null });
    const result = joinSessions([member({ agent, logAgent: agent })], [raw]);
    assert.equal(result.length, 1); assert.equal(result[0].agent, agent); assert.equal(result[0].statusSource, 'log');
  }
});

test('missing, mismatched, ambiguous sessions never guess by cwd/name; unmatched logs are ungrouped', () => {
  for (const m of [member({ logSessionId: null }), member({ logSessionId: 'abcd' }), member({ logAgent: 'claude' })]) {
    const result = joinSessions([m], [log()]);
    assert.equal(result.length, 2); assert.equal(result[0].statusSource, 'herdr');
    assert.equal(result[0].status, 'thinking'); assert.equal(result[1].teamId, 'ungrouped');
  }
  const result = joinSessions([member()], [log(), log({ id: 'def', sessionId: 'abc' })]);
  assert.equal(result[0].binding, 'ambiguous-session'); assert.equal(result.length, 3);
});

test('late log discovery, rename, stale Herdr and occupant replacement cannot contaminate log activity', () => {
  const raw = log();
  assert.equal(joinSessions([member()], [])[0].statusSource, 'herdr');
  const first = joinSessions([member()], [raw])[0];
  const renamed = joinSessions([member({ displayName: 'new-name', presence: 'stale', sourceStatus: 'blocked' })], [raw])[0];
  assert.equal(renamed.key, first.key); assert.equal(renamed.status, 'done');
  assert.equal(renamed.presence, 'stale'); assert.equal(renamed.herdrStatus, 'blocked');
  const replacement = joinSessions([member({ key: 'new-occupant', logSessionId: 'new-id' })], [raw]);
  assert.equal(replacement[0].statusSource, 'herdr'); assert.equal(replacement[1].teamId, 'ungrouped');
});

test('composed lifecycle forwards both sources and retains empty houses plus ungrouped logs', async () => {
  function source(data) { const s = new EventEmitter(); Object.assign(s, { sessions: () => data, start: () => { s.starts = (s.starts || 0) + 1; }, stop: () => { s.stopped = true; }, tick: () => {} }); return s; }
  const herdr = source([member()]), logs = source([log(), log({ id: 'other' })]);
  herdr.teams = () => [{ id: 'w1' }, { id: 'w2' }]; herdr.sourceInfo = () => ({ presence: 'fresh' });
  const w = new TeamWatcher({ herdr, logs }); let changes = 0; w.on('change', () => changes++);
  w.start(); w.start(); await w.tick(); logs.emit('change'); herdr.emit('change');
  assert.equal(changes, 2); assert.equal(logs.starts, 1); assert.equal(herdr.starts, 1);
  assert.deepEqual(w.teams().map(t => t.id), ['w1', 'w2', 'ungrouped']);
  assert.equal(snapshot(w).source.statusPolicy, 'log-first-exact-session');
  w.stop(); logs.emit('change'); assert.equal(changes, 2); assert.ok(herdr.stopped && logs.stopped);
});
