const test = require('node:test');
const assert = require('node:assert/strict');
const { HerdrWatcher, rows } = require('../src/herdr');
const { snapshot } = require('../src/server');

function fixture({ session } = {}) {
  let now = 1000, fail = false;
  const data = {
    workspaces: [{ workspace_id: 'w1', label: 'Alpha', agent_status: 'working' }, { workspace_id: 'w2', label: 'Empty' }],
    agents: ['working', 'blocked', 'done', 'idle', 'unknown', 'new-future-state'].map((s, i) => ({
      pane_id: `w1:p${i}`, workspace_id: 'w1', tab_id: 'w1:t1', agent: 'codex', agent_status: s,
      ...(i ? { name: `member-${i}` } : {}), cwd: '/same/workspace', terminal_title: 'SECRET TITLE',
      agent_session: { kind: 'id', value: `session-${i}` },
    })),
  };
  const calls = [];
  const w = new HerdrWatcher({ teamMap: { workspaces: { w1: { leaderPane: 'w1:p1', expectedName: 'member-1' } } }, now: () => now,
    session, run: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (fail) throw Error('private terminal content must not leak');
      const field = args.at(-2) === 'workspace' ? 'workspaces' : 'agents';
      return { stdout: JSON.stringify({ result: { [field]: data[field] } }) };
    },
  });
  return { w, data, calls, advance: () => { now += 10_000_000; }, fail: value => { fail = value; } };
}

test('Herdr fixed read commands, schema, exact status mapping and explicit names/leader', async () => {
  const f = fixture(); await f.w.tick();
  assert.deepEqual(f.calls.map(c => [c.cmd, ...c.args]), [['herdr', 'workspace', 'list'], ['herdr', 'agent', 'list']]);
  assert.ok(f.calls.every(c => c.options.timeout === 4000 && c.options.maxBuffer === 2097152 && !c.options.shell));
  assert.deepEqual(f.w.sessions().map(s => s.status), ['thinking', 'waiting', 'done', 'idle', 'idle', 'idle']);
  assert.deepEqual(f.w.sessions().map(s => s.sourceStatus), ['working', 'blocked', 'done', 'idle', 'unknown', 'unknown']);
  assert.equal(f.w.sessions()[0].displayName, 'w1:p0');
  assert.equal(f.w.sessions()[1].displayName, 'member-1');
  assert.equal(f.w.sessions()[1].role, 'leader');
  assert.equal(f.w.teams().length, 2, 'empty workspace has a house');
  assert.equal(JSON.stringify(f.w.sessions()).includes('SECRET'), false);
  assert.equal(JSON.stringify(f.w.sessions()).includes('/same/workspace'), false);
});

test('an explicit Herdr session stays selected through read failures and recovery', async () => {
  const f = fixture({ session: 'fixture-session' });
  await f.w.tick();
  const members = f.w.sessions().map(s => s.key);
  f.fail(true); await f.w.tick();
  assert.equal(f.w.sourceInfo().presence, 'stale');
  assert.deepEqual(f.w.sessions().map(s => s.key), members);
  f.fail(false); await f.w.tick();
  assert.equal(f.w.sourceInfo().presence, 'fresh');
  assert.equal(f.w.sourceInfo().scope, 'selected-herdr-session');
  assert.equal(f.w.sourceInfo().session, 'fixture-session');
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.every(c => c.cmd === 'herdr' && c.args[0] === '--session' && c.args[1] === 'fixture-session' && !c.options.shell));
  assert.deepEqual(f.calls.slice(0, 2).map(c => c.args.slice(2)), [['workspace', 'list'], ['agent', 'list']]);
});

test('unchanged polls are quiet, raw working/blocked never time out, rename keeps seat key', async () => {
  const f = fixture(); let changes = 0; f.w.on('change', () => changes++);
  await f.w.tick(); const before = snapshot(f.w); f.advance(); await f.w.tick();
  assert.equal(changes, 1);
  assert.deepEqual(snapshot(f.w).sessions, before.sessions);
  assert.equal(snapshot(f.w).sessions.find(s => s.paneId === 'w1:p0').status, 'thinking');
  const key = f.w.sessions()[1].key;
  f.data.agents[1].name = 'new-name'; await f.w.tick();
  assert.equal(f.w.sessions()[1].key, key);
  assert.equal(f.w.sessions()[1].role, 'member', 'expectedName protects stale leader config');
  f.data.agents[1].agent_session.value = 'replacement'; await f.w.tick();
  assert.notEqual(f.w.sessions()[1].key, key);
});

test('failure or malformed JSON retains stale members/houses, recovers without status fabrication', async () => {
  const f = fixture(); await f.w.tick(); f.fail(true); await f.w.tick();
  assert.equal(f.w.sessions().length, 6);
  assert.ok(f.w.sessions().every(s => s.presence === 'stale'));
  assert.ok(f.w.teams().every(s => s.presence === 'stale'));
  assert.equal(f.w.sourceInfo().presence, 'stale');
  assert.equal(JSON.stringify(snapshot(f.w)).includes('private terminal'), false);
  f.fail(false); f.data.agents = null; await f.w.tick();
  assert.equal(f.w.sessions().length, 6);
  f.data.agents = []; await f.w.tick();
  assert.equal(f.w.sourceInfo().presence, 'fresh');
  assert.equal(f.w.sessions().length, 0, 'successful empty list removes occupants');
  assert.equal(f.w.teams().length, 2);
});

test('invalid entries and duplicate panes reject whole snapshots', () => {
  for (const value of [{}, { result: {} }, { result: { agents: [{}] } }, { result: { agents: [null] } },
    { result: { agents: [{ pane_id: 'p1', workspace_id: 'w1' }, { pane_id: 'p1', workspace_id: 'w1' }] } }]) {
    assert.throws(() => rows(JSON.stringify(value), 'agents'));
  }
  assert.throws(() => rows('not json', 'agents'));
});

test('one in-flight poll and stop prevents late response mutation', async () => {
  const callbacks = []; let calls = 0;
  const w = new HerdrWatcher({ run: (cmd, args) => { calls++; return new Promise(resolve => callbacks.push(() => resolve({ stdout: JSON.stringify({ result: { [args[0] === 'agent' ? 'agents' : 'workspaces']: [] } }) }))); } });
  const a = w.tick(), b = w.tick(); assert.equal(a, b); assert.equal(calls, 2);
  w.stop(); callbacks.forEach(fn => fn()); await a;
  assert.equal(w.sourceInfo().presence, 'connecting');
});

test('snapshot defaults private and never uses prompt/title for Herdr identity', async () => {
  const f = fixture(); await f.w.tick();
  f.w.sessions()[0].prompt = 'PRIVATE PROMPT'; f.w.sessions()[0].reply = 'PRIVATE REPLY';
  f.w.sessions()[0].title = 'PRIVATE TITLE'; f.w.sessions()[0].error = 'PRIVATE ERROR';
  const result = snapshot(f.w);
  assert.equal(result.privacy, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.sessions.find(s => s.paneId === 'w1:p0').displayName, 'w1:p0');
  assert.equal(result.sessions[0].capabilities.resume, false);
});

test('configured dev/designer roles require exact pane and expected name without electing a leader', async () => {
  const f = fixture();
  f.w.teamMap.members = {
    'w1:p2': { expectedName: 'member-2', role: 'dev' },
    'w1:p3': { expectedName: 'member-3', role: 'designer' },
    'w1:p4': { expectedName: 'wrong-name', role: 'dev' },
    'w1:p5': { expectedName: 'member-5', role: 'leader' },
  };
  await f.w.tick();
  const byPane = new Map(snapshot(f.w).sessions.map(s => [s.paneId, s]));
  assert.equal(byPane.get('w1:p1').role, 'leader');
  assert.equal(byPane.get('w1:p2').role, 'dev');
  assert.equal(byPane.get('w1:p3').role, 'designer');
  assert.equal(byPane.get('w1:p4').role, 'member');
  assert.equal(byPane.get('w1:p5').role, 'member');
  f.data.agents[2].name = 'replacement'; await f.w.tick();
  assert.equal(f.w.sessions()[2].role, 'member');
});

test('rule directory candidates remain private and stop being available when identity is stale', async () => {
  const f = fixture(); await f.w.tick();
  assert.deepEqual(f.w.ruleContext('w1').directories, ['/same/workspace']);
  assert.equal(f.w.ruleContext('unknown'), null);
  assert.equal(JSON.stringify(snapshot(f.w)).includes('/same/workspace'), false);
  assert.equal(JSON.stringify(snapshot(f.w)).includes('ruleDirectories'), false);
  f.fail(true); await f.w.tick(); assert.equal(f.w.ruleContext('w1'), null);
});
