'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RecentActivity } = require('../src/activity');
const { Watcher } = require('../src/watcher');
const { TeamWatcher } = require('../src/teams');
const { newSession, applyCodex, applyClaude, applyOMP } = require('../src/parsers');
const { createServer, snapshot } = require('../src/server');

const call = (id, command) => ({ type: 'response_item', timestamp: '2026-10-29T03:30:00Z',
  payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: command }) } });
const member = (id, teamId = 'w1') => ({ key: `herdr:${teamId}:${id}`, id, paneId: `${teamId}:${id}`, agent: 'codex', logAgent: 'codex',
  logSessionId: id, teamId, source: 'herdr', sourceStatus: 'working', presence: 'fresh' });

test('private history retains 30 tool requests, truncates Unicode, ignores outputs and reasoning', () => {
  const recent = new RecentActivity(), session = newSession('codex', 'a', null);
  session.cwd = '/fixture/project';
  for (let n = 0; n < 45; n++) recent.observe(session, call(String(n), `command-${n}`));
  let result = recent.snapshot();
  assert.equal(result.entries.length, 30); assert.equal(result.entries[0].text, 'command-15');
  recent.observe(session, call('44', 'command-44')); assert.equal(recent.snapshot().entries.length, 30);
  const payloads = [{ type: 'reasoning', summary: 'PRIVATE_THOUGHT' }, { type: 'function_call_output', output: 'PRIVATE_RESULT' }, { type: 'message', role: 'user', content: 'PRIVATE_PROMPT' }];
  for (const payload of payloads) recent.observe(session, { type: 'response_item', payload });
  assert.doesNotMatch(JSON.stringify(recent.snapshot()), /PRIVATE_/);
  recent.observe(session, call('long', '🧭'.repeat(1000)));
  result = recent.snapshot().entries.at(-1);
  assert.equal(Array.from(result.text).length, 360); assert.equal(result.truncated, true); assert.ok(result.text.endsWith('…'));
});

test('wrapped commands and observed instruction references are decoded without execution', () => {
  const recent = new RecentActivity(), session = { agent: 'codex', cwd: '/fixture/project' };
  const script = 'await tools.exec_command({cmd:"cat ../.agents/team/roles/reviewer.md"}); await tools.exec_command({cmd:\'node --version\'}); globalThis.ACTIVITY_TEST_EXECUTED = true;';
  recent.observe(session, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'wrapped', input: script } });
  assert.deepEqual(recent.snapshot().entries.map(e => e.text), ['cat ../.agents/team/roles/reviewer.md', 'node --version']);
  assert.deepEqual([...recent.documents], ['/fixture/.agents/team/roles/reviewer.md']);
  assert.equal(globalThis.ACTIVITY_TEST_EXECUTED, undefined);
  recent.observe(session, call('unrelated', 'cat secrets.md'));
  assert.equal(recent.documents.size, 1, 'ordinary Markdown is not classified as a member instruction');
});

test('providers keep every requested tool and deduplicate repeated message updates', () => {
  const cases = [
    ['claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'node -v' } }, { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/fixture/AGENTS.md' } }] } }, 2],
    ['gemini', { type: 'gemini', toolCalls: [{ id: 'a', name: 'run_shell_command', args: { command: 'node -v' } }] }, 1],
    ['copilot', { type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'bash', arguments: { command: 'node -v' } } }, 1],
    ['omp', { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'node -v' } }] } }, 1],
    ['kimi', { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'a', name: 'Bash' } }, 1],
    ['dsh', { type: 'tool/call', data: { callId: 'a', name: 'Read' } }, 1],
    ['grok', { params: { update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Shell', rawInput: { command: 'node -v' } } } }, 1],
  ];
  for (const [agent, record, count] of cases) {
    const recent = new RecentActivity(), session = { agent, cwd: '/fixture', lastEventAt: 1 };
    recent.observe(session, record); recent.observe(session, record);
    assert.equal(recent.snapshot().entries.length, count, agent);
  }
});

test('replayed Gemini message updates cannot evict newer requests', () => {
  const recent = new RecentActivity(), session = { agent: 'gemini' };
  const message = n => ({ type: 'gemini', timestamp: new Date(1700000000000 + n * 1000).toISOString(), toolCalls: [{ id: String(n), name: 'Shell', args: { command: 'command-' + n } }] });
  recent.observe(session, { $set: { messages: Array.from({ length: 40 }, (_, n) => message(n)) } });
  recent.observe(session, message(0));
  assert.equal(recent.snapshot().entries.length, 30);
  assert.equal(recent.snapshot().entries[0].text, 'command-10');
  assert.equal(recent.snapshot().entries.at(-1).text, 'command-39');
});

test('watcher reuses bounded observations on append and drops them on log rewrite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.jsonl'), descriptor = { agent: 'codex', id: 'a', file };
  fs.writeFileSync(file, JSON.stringify(call('a', 'PRIVATE_COMMAND_A')) + '\n');
  const logs = new Watcher({ magpieSources: [] }); logs.open(descriptor, fs.statSync(file));
  const tracker = logs.trackers.get(file);
  fs.appendFileSync(file, JSON.stringify(call('b', 'PRIVATE_COMMAND_B')) + '\n'); logs.track(descriptor, 0);
  assert.equal(logs.trackers.get(file), tracker);
  assert.deepEqual(logs.localDetails('codex:a').entries.map(e => e.text), ['PRIVATE_COMMAND_A', 'PRIVATE_COMMAND_B']);
  assert.equal(logs.localDetails('claude:a'), null);
  assert.doesNotMatch(JSON.stringify(snapshot(logs)), /PRIVATE_COMMAND|entries|documents/);
  fs.writeFileSync(file, '\n'); logs.track(descriptor, 0); logs.track(descriptor, 0);
  assert.deepEqual(logs.localDetails('codex:a').entries, []);
});

test('DSH seed history from a parent is not shown as a child member request', () => {
  const logs = new Watcher({ magpieSources: [] }), { applyDsh } = require('../src/clients');
  const tracker = { session: newSession('dsh', 'child', null), apply: applyDsh, partial: '', recent: new RecentActivity() };
  const records = [
    { type: 'session', id: 'child', version: 4, isSeeded: true, delegationDepth: 1 },
    { type: 'tool/call', data: { callId: 'parent', name: 'PARENT_REQUEST' } },
    { type: 'session/end-seed' },
    { type: 'tool/call', data: { callId: 'child', name: 'CHILD_REQUEST' } },
  ];
  logs.feed(tracker, records.map(r => JSON.stringify(r)).join('\n') + '\n', false);
  assert.deepEqual(tracker.recent.snapshot().entries.map(e => e.tool), ['CHILD_REQUEST']);
});

test('member activity requires a fresh exact binding and HTTP keeps it local and on demand', async t => {
  let registered = [member('a'), member('b', 'w2'), { ...member('unbound'), logSessionId: null }], fresh = true;
  let raw = [{ id: 'a', agent: 'codex' }, { id: 'b', agent: 'codex' }];
  const herdr = new EventEmitter(); herdr.sessions = () => registered; herdr.teams = () => [{ id: 'w1' }, { id: 'w2' }];
  herdr.sourceInfo = () => ({ presence: fresh ? 'fresh' : 'stale' });
  const logs = new EventEmitter(); logs.sessions = () => raw;
  let reads = 0; logs.localDetails = key => { reads++; return { entries: [{ id: 'a', text: `PRIVATE_${key}`, tool: 'Shell', at: 1 }], documents: ['/PRIVATE/AGENTS.md'], limit: 30, textLimit: 360 }; };
  const watcher = new TeamWatcher({ herdr, logs });
  const server = createServer(watcher);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, route = '/api/members/activity?team=w1&member=herdr:w1:a';
  const headers = { 'x-agent-office-rule-read': '1' };
  assert.equal((await fetch(base + '/api/sessions')).status, 200); assert.equal(reads, 0);
  assert.equal((await fetch(base + route)).status, 403);
  for (const extra of [{ origin: 'https://other.invalid' }, { 'sec-fetch-site': 'cross-site' }, { forwarded: 'host=localhost' }, { range: 'bytes=0-1' }]) {
    assert.equal((await fetch(base + route, { headers: { ...headers, ...extra } })).status, 403);
  }
  assert.equal((await fetch(base + route, { method: 'POST', headers })).status, 403);
  for (const suffix of ['&member=x', '&team=w2', '&path=/PRIVATE']) assert.equal((await fetch(base + route + suffix, { headers })).status, 404);
  const response = await fetch(base + route, { headers }); const data = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(data.entries[0].text, /codex:a/);
  assert.equal(Object.hasOwn(data, 'documents'), false);
  assert.throws(() => watcher.memberActivity('w2', registered[0].key), /member_unavailable/);
  assert.equal(watcher.memberActivity('w1', registered[2].key).reason, 'no-session-id');
  raw.push({ id: 'duplicate', agent: 'codex', sessionId: 'a' });
  assert.equal(watcher.memberActivity('w1', registered[0].key).reason, 'ambiguous-session'); raw.pop();
  fresh = false; assert.throws(() => watcher.memberActivity('w1', registered[0].key), /scope_stale/); fresh = true;
  registered = [member('replacement')];
  assert.equal((await fetch(base + route, { headers })).status, 404);
});

test('configuration uses recorded per-turn values, clears old models, and labels estimated windows', () => {
  const s = newSession('codex', 'a', null);
  applyCodex(s, { type: 'turn_context', payload: { model: 'model-a', effort: 'xhigh' } });
  applyCodex(s, { type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 258400 } } });
  let view = snapshot({ sessions: () => [s] }).sessions[0];
  assert.equal(view.model, 'model-a'); assert.equal(view.reasoningEffort, 'xhigh'); assert.equal(view.contextWindow, 258400);
  assert.equal(view.contextWindowSource, 'recorded');
  applyCodex(s, { type: 'turn_context', payload: { model: 'model-b', collaboration_mode: { settings: { reasoning_effort: 'max' } } } });
  assert.equal(s.contextWindow, null); assert.equal(s.reasoningEffort, 'max');
  applyCodex(s, { type: 'turn_context', payload: { model: 'model-b' } }); assert.equal(s.reasoningEffort, null);
  const claude = newSession('claude', 'c', null);
  applyClaude(claude, { type: 'assistant', message: { id: 'one', usage: { input_tokens: 100 }, content: [] } });
  assert.equal(snapshot({ sessions: () => [claude] }).sessions[0].contextWindowSource, 'estimated');
  const omp = newSession('omp', 'o', null); applyOMP(omp, { type: 'thinking_level_change', thinkingLevel: 'high' });
  assert.equal(omp.reasoningEffort, 'high');
});
