const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {}, Image: class {}, console };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/office.js'), 'utf8'), context);
function office() {
  const o = Object.create(context.window.Office.prototype);
  Object.assign(o, { pal: new Proxy({}, { get: (_, key) => key === 'dark' ? false : '#888888' }), people: new Map(), deskOf: new Map(), first: true });
  o.plan = o.buildPlan(0); return o;
}
function member(i, status = 'idle', role = 'member') {
  return { key: `p${i}`, id: `p${i}`, displayName: `name-${i}`, source: 'herdr', agent: 'codex', sourceStatus: status,
    status: ({ working: 'thinking', blocked: 'waiting', idle: 'idle', done: 'done', unknown: 'idle' })[status], role };
}
test('Herdr metadata does not force idle/done/unknown members to work; original off-duty cap applies', () => {
  const o = office(), list = Array.from({ length: 24 }, (_, i) => member(i, ['idle', 'done', 'unknown'][i % 3]));
  o.update(list);
  assert.equal(o.people.size, 7); assert.equal(o.deskOf.size, 0); assert.equal(o.offDuty, 17);
  const seats = [...o.deskOf]; o.update(list.map(s => ({ ...s, displayName: 'renamed' })));
  assert.deepEqual([...o.deskOf], seats);
  for (const p of o.people.values()) assert.equal(o.stateOf(p).act, null);
});
test('leader arriving after members explicitly takes main seat, holds it through status/size changes', () => {
  const o = office(); o.update([member(1, 'working'), member(2, 'working')]);
  const leader = member(3, 'done', 'leader');
  o.update([member(1, 'working'), member(2, 'working'), leader]);
  assert.equal(o.deskOf.get(leader.key), o.leaderDesk);
  assert.equal(new Set(o.deskOf.values()).size, 3);
  const seats = [...o.deskOf];
  o.update([member(1, 'working'), member(2, 'working'), leader]);
  assert.deepEqual([...o.deskOf], seats, 'unchanged leader does not churn Map insertion order');
  for (const status of ['idle', 'working', 'blocked', 'unknown']) {
    o.update([...Array.from({ length: 16 }, (_, i) => member(i + 4, 'working')), member(3, status, 'leader')]);
    assert.equal(o.deskOf.get(leader.key), o.leaderDesk);
    assert.equal(new Set(o.deskOf.values()).size, 17);
  }
});
test('working thinks, blocked waves, idle/done/unknown use original wandering without fabricated work', () => {
  const o = office(); o.update(['working', 'blocked', 'idle', 'done', 'unknown'].map((s, i) => member(i, s)));
  assert.deepEqual([...o.people.values()].map(p => o.stateOf(p).act), ['think', 'wave', null, null, null]);
  assert.deepEqual([...o.people.values()].map(p => p.mode), ['work', 'work', 'wander', 'wander', 'wander']);
});
test('linked log states override contradictory Herdr metadata for actions and retain provider appearance', () => {
  const o = office();
  const providers = ['claude', 'codex', 'gemini'];
  const list = providers.map((agent, i) => ({ ...member(i, 'working'), agent, source: 'log', statusSource: 'log', status: 'done', herdrStatus: 'working' }));
  o.update(list);
  assert.equal(o.deskOf.size, 0);
  assert.ok([...o.people.values()].every(p => p.mode === 'wander'));
  assert.equal(new Set([...o.people.values()].map(p => p.shirt)).size, 3);
  for (const agent of providers) assert.ok(context.window.OFFICE_AGENT_BADGES[agent].logo.endsWith(`${agent}.png`));
  o.update([{ ...list[0], role: 'leader' }]);
  const leader = o.people.get('p0'); leader.path = [];
  assert.equal(o.stateOf(leader).act, null, 'done leader sits neutrally, never thinks/types');
});
test('unmodified log sessions keep original off-duty wandering behavior', () => {
  const o = office(); o.update(Array.from({ length: 12 }, (_, i) => ({ ...member(i), source: 'log' })));
  assert.equal(o.people.size, 7); assert.equal(o.offDuty, 5); assert.equal(o.deskOf.size, 0);
});
