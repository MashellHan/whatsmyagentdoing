// Privacy whitelist for the Cloudflare remote view. Used by BOTH the mini-1
// push agent and the ingest Worker: anything not listed here is dropped.
// Allowed: team name, member name, agent type, status, timestamps.
// Never: prompts, replies, titles, errors, activity, cwd/project, model,
// session/pane ids, team guidelines (AGENTS.md / TEAMS.md) or any free text.

export const OFFLINE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;

const STATUSES = new Set(['thinking', 'tool', 'typing', 'waiting', 'done', 'idle', 'error', 'interrupted']);
const SOURCE_STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'unknown', ...STATUSES]);
const AGENTS = new Set(['claude', 'codex', 'gemini', 'unknown']);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const KEY = /^k_[0-9a-f]{16}$/;
const MAX_TEAMS = 50;
const MAX_SESSIONS = 300;

const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const time = (value) => (Number.isFinite(value) && value > 0 && value < 1e14 ? Math.round(value) : null);
const presence = (value) => (value === 'stale' ? 'stale' : 'fresh');
const pick = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

function team(t) {
  if (!t || typeof t !== 'object' || !ID.test(t.id || '')) return null;
  const name = text(t.name, 80) || t.id;
  return { id: t.id, name, label: text(t.label, 80) || name, presence: presence(t.presence) };
}

function session(s, index) {
  if (!s || typeof s !== 'object') return null;
  const via = s.statusSource === 'herdr' ? 'herdr' : 'log';
  return {
    key: KEY.test(s.key || '') ? s.key : `k_${index.toString(16).padStart(16, '0')}`,
    teamId: ID.test(s.teamId || '') ? s.teamId : 'ungrouped',
    displayName: text(s.displayName, 80),
    agent: pick(s.agent, AGENTS, 'unknown'),
    status: pick(s.status, STATUSES, 'idle'),
    sourceStatus: pick(s.sourceStatus, SOURCE_STATUSES, 'unknown'),
    statusSource: via,
    source: s.source === 'herdr' ? 'herdr' : 'log',
    presence: presence(s.presence),
    subagent: s.subagent === true,
    lastEventAt: time(s.lastEventAt),
    startedAt: time(s.startedAt),
    turnStartedAt: time(s.turnStartedAt),
  };
}

// `sourceOk === false` marks a snapshot whose local source could not be read.
export function sanitizeSnapshot(input, { sourceOk = true } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const teams = (Array.isArray(raw.teams) ? raw.teams : []).slice(0, MAX_TEAMS).map(team).filter(Boolean);
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).slice(0, MAX_SESSIONS).map(session).filter(Boolean);
  const stale = !sourceOk || raw.source?.presence === 'stale';
  return {
    now: time(raw.now),
    lang: null,
    privacy: true,
    teams,
    sessions,
    source: { kind: 'remote', presence: stale ? 'stale' : 'fresh', error: stale ? 'mini-1 本地状态暂不可读，显示上次快照。' : null },
  };
}

// Stable comparison signature that ignores the snapshot clock.
export function signature(snapshot) {
  return JSON.stringify({ ...snapshot, now: 0 });
}

// Viewer-side offline rule: offline when the last push from mini-1 is older
// than OFFLINE_MS. Server-relative age avoids trusting the phone's clock.
export function isOffline(clock, localNow) {
  const { lastPushAt, serverNow, receivedAt } = clock || {};
  if (!lastPushAt || !serverNow || !receivedAt) return true;
  return serverNow - lastPushAt + (localNow - receivedAt) > OFFLINE_MS;
}
