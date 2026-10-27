const test = require('node:test');
const assert = require('node:assert/strict');
const { activityOf, summarize } = require('../public/town');
const log = status => ({ status, statusSource: 'log', source: 'log', herdrStatus: 'working' });

test('homepage busy ratio uses final log states, not contradictory Herdr status', () => {
  const a = activityOf(['thinking', 'tool', 'typing', 'idle', 'done'].map(log));
  assert.deepEqual(a, { total: 5, busy: 3, attention: 0, resting: 2, unknown: 0, logs: 5, fallback: 0, kind: 'busy' });
  assert.equal(activityOf(['done', 'idle', 'interrupted'].map(log)).kind, 'idle');
});
test('attention, unknown and empty are never reported as all idle', () => {
  for (const status of ['waiting', 'error']) assert.equal(activityOf([log(status), log('idle')]).kind, 'attention');
  assert.equal(activityOf([log('new-state')]).kind, 'unknown');
  assert.equal(activityOf([]).kind, 'empty');
  assert.equal(activityOf([{ status: 'idle', statusSource: 'herdr', sourceStatus: 'unknown' }]).kind, 'unknown');
  const mixed = activityOf([log('tool'), log('waiting')]);
  assert.equal(mixed.kind, 'busy'); assert.equal(mixed.attention, 1);
});
test('explicit Herdr fallback is preserved only when the backend marked it unmatched', () => {
  const a = activityOf([{ status: 'thinking', source: 'herdr', sourceStatus: 'working' }, log('done')]);
  assert.equal(a.busy, 1); assert.equal(a.logs, 1); assert.equal(a.fallback, 1);
  assert.equal(activityOf([{ ...log('done'), source: 'herdr', sourceStatus: 'unknown' }]).kind, 'idle', 'explicit log provenance wins');
});
test('top counts actual teams separately from ungrouped, and includes all working agents', () => {
  const snapshot = { teams: ['w1', 'w2', 'w3', 'w4', 'ungrouped'].map(id => ({ id })), sessions: [
    { ...log('tool'), teamId: 'w1' }, { ...log('done'), teamId: 'w2' }, { ...log('idle'), teamId: 'w2' },
    { ...log('waiting'), teamId: 'w3' }, { ...log('typing'), teamId: 'ungrouped' },
  ] };
  const result = summarize(snapshot);
  assert.equal(result.busyTeams, 1); assert.equal(result.idleTeams, 1); assert.equal(result.otherTeams, 2);
  assert.equal(result.teams, 4); assert.equal(result.workingAgents, 2); assert.equal(result.ungroupedAgents, 1);
  assert.equal(result.houses.length, 5);
  assert.deepEqual(summarize({ teams: [], sessions: [] }), { houses: [], teams: 0, busyTeams: 0, idleTeams: 0, otherTeams: 0, workingAgents: 0, ungroupedAgents: 0 });
});
