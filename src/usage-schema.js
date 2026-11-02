'use strict';

const AGENTS = new Set(['claude', 'codex', 'copilot', 'gemini', 'omp']);
const STATES = new Set(['loading', 'ready', 'partial', 'unavailable']);
const COUNTERS = ['todayTokens', 'monthTokens', 'weekTokens', 'previousWeekTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Only aggregate counters cross into snapshots; no log paths or request IDs.
function sanitizeUsage(value) {
  const raw = value && typeof value === 'object' ? value : {};
  let timeZone = null;
  try { if (typeof raw.timeZone === 'string') timeZone = new Intl.DateTimeFormat('en', { timeZone: raw.timeZone }).resolvedOptions().timeZone; } catch {}
  const out = {
    status: STATES.has(raw.status) ? raw.status : 'unavailable',
    updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : null,
    timeZone,
    day: typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) ? raw.day : null,
    month: typeof raw.month === 'string' && /^\d{4}-\d{2}$/.test(raw.month) ? raw.month : null,
    agents: [...new Set((Array.isArray(raw.agents) ? raw.agents : []).filter(agent => AGENTS.has(agent)))],
  };
  for (const key of COUNTERS) out[key] = count(raw[key]);
  if (['ready', 'partial'].includes(out.status) && (!out.updatedAt || !out.day || !out.month || !out.timeZone || COUNTERS.some(key => out[key] === null))) out.status = 'unavailable';
  if (out.status === 'loading' || out.status === 'unavailable') for (const key of COUNTERS) out[key] = null;
  return out;
}

module.exports = { sanitizeUsage, AGENTS };
