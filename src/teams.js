'use strict';

const { EventEmitter } = require('node:events');
const { HerdrWatcher } = require('./herdr');
const { Watcher } = require('./watcher');
const { RulesError } = require('./rules');
const { instructionScopes } = require('./rule-context');

// Herdr owns identity and topology. The unchanged Watcher/parsers own activity.
// Never infer a binding from cwd, name, terminal title, or fuzzy ID matching.
const activitySource = session => session.source === 'magpie' ? 'magpie' : 'log';
function joinSessions(members, logs) {
  const index = new Map();
  for (const log of logs) {
    // Kimi children carry their parent's session ID for resume, not identity.
    const alias = log.agent === 'kimi' && log.parentId ? null : log.sessionId;
    for (const id of new Set([log.id, alias].filter(Boolean))) {
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
      source: activitySource(log), statusSource: activitySource(log), herdrStatus: member.sourceStatus,
      logKey: `${log.agent}:${log.id}`, logSessionId: member.logSessionId,
      binding: 'exact-session', capabilities: { resume: log.source !== 'magpie' },
    };
  });
  return joined.concat(logs.filter(log => !used.has(log)).map(log => ({
    ...log, source: activitySource(log), statusSource: activitySource(log), teamId: 'ungrouped',
    capabilities: { resume: log.source !== 'magpie' },
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
  member(teamId, memberKey) {
    if (this.herdr.sourceInfo().presence !== 'fresh') throw new RulesError('scope_stale', 503);
    const member = this.sessions().find(s => s.teamId === teamId && s.key === memberKey && s.paneId);
    if (!member || teamId === 'ungrouped') throw new RulesError('member_unavailable', 404);
    return member;
  }
  memberActivity(teamId, memberKey) {
    const member = this.member(teamId, memberKey);
    if (member.binding !== 'exact-session' || member.statusSource !== 'log') {
      return { member: memberKey, available: false, reason: member.binding === 'exact-session' ? 'log-unavailable' : member.binding, entries: [], limit: 30, textLimit: 360 };
    }
    const detail = this.logs.localDetails?.(member.logKey);
    if (!detail) return { member: memberKey, available: false, reason: 'log-unavailable', entries: [], limit: 30, textLimit: 360 };
    const { documents, ...activity } = detail;
    return { member: memberKey, available: true, ...activity };
  }
  ruleContext(teamId, memberKey = null) {
    const context = this.herdr.ruleContext(teamId, memberKey);
    if (!context) return null;
    if (!memberKey) return { ...context, instructionRoots: instructionScopes(context) };
    const member = this.member(teamId, memberKey);
    const documents = member.binding === 'exact-session' && member.statusSource === 'log'
      ? this.logs.localDetails?.(member.logKey)?.documents || [] : [];
    return { ...context, instructionRoots: instructionScopes(context, member.agent, documents) };
  }
}

module.exports = { TeamWatcher, joinSessions };
