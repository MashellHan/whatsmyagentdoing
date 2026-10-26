'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const STATES = { working: 'thinking', blocked: 'waiting', done: 'done', idle: 'idle', unknown: 'idle' };
const text = value => typeof value === 'string' && value.length > 0 ? value : null;
const rawStatus = value => Object.hasOwn(STATES, value) ? value : 'unknown';

function rows(output, field) {
  const parsed = JSON.parse(typeof output === 'string' ? output : output.stdout);
  const list = parsed?.result?.[field];
  if (!Array.isArray(list)) throw new Error(`Invalid Herdr ${field} response`);
  const ids = new Set();
  for (const item of list) {
    const id = field === 'agents' ? item?.pane_id : item?.workspace_id;
    if (!text(id) || !text(item?.workspace_id) || ids.has(id)) throw new Error(`Invalid Herdr ${field} identity`);
    ids.add(id);
  }
  return list;
}

class HerdrWatcher extends EventEmitter {
  constructor({ teamMap = {}, interval = 2000, run = execute, now = Date.now } = {}) {
    super();
    this.teamMap = teamMap;
    this.interval = interval;
    this.run = run;
    this.now = now;
    this.members = [];
    this.houses = [];
    this.health = { kind: 'herdr', scope: 'current-herdr-session', presence: 'connecting', error: null };
    this.pending = null;
    this.stopped = false;
  }
  sessions() { return this.members; }
  teams() { return this.houses; }
  sourceInfo() { return this.health; }
  start() {
    if (this.timer) return this;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.interval);
    return this;
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }
  tick() {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    this.pending = this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }
  async poll() {
    const before = JSON.stringify([this.members, this.houses, this.health]);
    this.controller = new AbortController();
    try {
      const options = { timeout: 4000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true, signal: this.controller.signal };
      // Fixed, read-only commands. Never interpolate pane IDs into a shell.
      const results = await Promise.allSettled([
        this.run('herdr', ['workspace', 'list'], options),
        this.run('herdr', ['agent', 'list'], options),
      ]);
      // Wait for both commands to settle even if one fails immediately.
      // Otherwise a slow sibling could overlap with the next poll.
      if (results.some(r => r.status === 'rejected')) throw new Error('Herdr read failed');
      const [workspaceJSON, agentJSON] = results.map(r => r.value);
      const workspaces = rows(workspaceJSON, 'workspaces');
      const agents = rows(agentJSON, 'agents');
      if (this.stopped) return;
      const now = this.now();
      const previous = new Map(this.members.map(s => [s.key, s]));
      const houses = new Map(workspaces.map(w => [w.workspace_id, {
        id: w.workspace_id, workspaceId: w.workspace_id,
        name: text(w.label) || w.workspace_id, label: text(w.label) || w.workspace_id,
        sourceStatus: rawStatus(w.agent_status), presence: 'fresh',
      }]));
      this.members = agents.map(a => {
        // Session IDs are now available in the local CLI; never guess from cwd/title.
        const occupant = a.agent_session?.kind === 'id' ? text(a.agent_session.value) : null;
        const key = `herdr:${a.pane_id}:${occupant || text(a.agent) || 'unknown'}`;
        const old = previous.get(key);
        const sourceStatus = rawStatus(a.agent_status);
        const displayName = text(a.name) || a.pane_id;
        const config = this.teamMap.workspaces?.[a.workspace_id];
        const leader = config?.leaderPane === a.pane_id && (!config.expectedName || config.expectedName === displayName);
        if (!houses.has(a.workspace_id)) houses.set(a.workspace_id, {
          id: a.workspace_id, workspaceId: a.workspace_id, name: a.workspace_id,
          label: a.workspace_id, sourceStatus: 'unknown', presence: 'fresh',
        });
        const changed = !old || old.sourceStatus !== sourceStatus;
        return {
          key, id: a.pane_id, agent: text(a.agent) || 'unknown', source: 'herdr',
          logSessionId: occupant,
          logAgent: occupant ? (text(a.agent_session.agent) || text(a.agent)) : null,
          sourceStatus, status: STATES[sourceStatus], displayName,
          teamId: a.workspace_id, workspaceId: a.workspace_id,
          paneId: a.pane_id, tabId: text(a.tab_id),
          role: leader ? 'leader' : 'member', presence: 'fresh',
          capabilities: { resume: false },
          startedAt: old?.startedAt || now,
          lastEventAt: changed ? now : old.lastEventAt,
          turnStartedAt: sourceStatus === 'working' ? (old?.sourceStatus === 'working' ? old.turnStartedAt : now) : null,
          // No terminal titles, cwd, prompts, replies or session contents are ingested.
        };
      }).sort((a, b) => a.paneId.localeCompare(b.paneId, undefined, { numeric: true }));
      this.houses = [...houses.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      this.health = { kind: 'herdr', scope: 'current-herdr-session', presence: 'fresh', error: null };
    } catch {
      if (this.stopped) return;
      // Failed/malformed reads are NOT an empty list: retain occupants and seats.
      this.members = this.members.map(s => ({ ...s, presence: 'stale' }));
      this.houses = this.houses.map(t => ({ ...t, presence: 'stale' }));
      this.health = { kind: 'herdr', scope: 'current-herdr-session', presence: 'stale', error: 'Herdr 状态读取失败；保留上次快照，正在重试。' };
    } finally {
      this.controller = null;
    }
    if (!this.stopped && before !== JSON.stringify([this.members, this.houses, this.health])) this.emit('change');
  }
}

module.exports = { HerdrWatcher, rows, STATES };
