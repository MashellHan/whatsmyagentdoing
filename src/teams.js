'use strict';

const { EventEmitter } = require('node:events');
const { HerdrWatcher } = require('./herdr');
const { Watcher } = require('./watcher');

// Herdr owns identity and topology. The unchanged Watcher/parsers own activity.
// Never infer a binding from cwd, name, terminal title, or fuzzy ID matching.
function joinSessions(members, logs) {
  const index = new Map();
  for (const log of logs) {
    for (const id of new Set([log.id, log.sessionId].filter(Boolean))) {
      const key = `${log.agent}:${id}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(log);
    }
  }
  const used = new Set();
  const joined = members.map(member => {
    const matches = member.logAgent === member.agent && member.logSessionId
      ? index.get(`${member.agent}:${member.logSessionId}`) || [] : [];
    if (matches.length !== 1) return {
      ...member, statusSource: 'herdr', herdrStatus: member.sourceStatus,
      binding: matches.length > 1 ? 'ambiguous-session' : member.logSessionId ? 'log-unavailable' : 'no-session-id',
    };
    const log = matches[0];
    used.add(log);
    // Whitelist Herdr metadata so heartbeat timestamps and agent_status can
    // never overwrite the log status or change its original timeout behavior.
    return {
      ...log, key: member.key,
      displayName: member.displayName, teamId: member.teamId, workspaceId: member.workspaceId,
      paneId: member.paneId, tabId: member.tabId, role: member.role, presence: member.presence,
      source: 'log', statusSource: 'log', herdrStatus: member.sourceStatus,
      logKey: `${log.agent}:${log.id}`, logSessionId: member.logSessionId,
      binding: 'exact-session', capabilities: { resume: true },
    };
  });
  return joined.concat(logs.filter(log => !used.has(log)).map(log => ({
    ...log, source: 'log', statusSource: 'log', teamId: 'ungrouped',
    displayName: `${log.agent}:${String(log.sessionId || log.id).slice(0, 8)}`,
    logKey: `${log.agent}:${log.id}`, logSessionId: log.sessionId || log.id,
    binding: 'unregistered-log',
  })));
}

class TeamWatcher extends EventEmitter {
  constructor({ herdr = new HerdrWatcher(), logs = new Watcher() } = {}) {
    super();
    this.herdr = herdr; this.logs = logs;
    this.changed = () => this.emit('change');
  }
  start() {
    if (this.running) return this;
    this.running = true;
    this.logs.on('change', this.changed); this.herdr.on('change', this.changed);
    this.logs.start(); this.herdr.start();
    return this;
  }
  stop() {
    this.running = false;
    this.herdr.stop(); this.logs.stop();
    this.logs.off('change', this.changed); this.herdr.off('change', this.changed);
  }
  async tick() { this.logs.tick(); await this.herdr.tick(); }
  sessions() { return joinSessions(this.herdr.sessions(), this.logs.sessions()); }
  teams() {
    const teams = [...this.herdr.teams()];
    if (this.sessions().some(s => s.teamId === 'ungrouped')) teams.push({
      id: 'ungrouped', name: '未分组', label: '未分组', presence: 'fresh',
    });
    return teams;
  }
  sourceInfo() { return { ...this.herdr.sourceInfo(), kind: 'logs+herdr', statusPolicy: 'log-first-exact-session', logInterval: 1000 }; }
  ruleContext(teamId) { return this.herdr.ruleContext(teamId); }
}

module.exports = { TeamWatcher, joinSessions };
