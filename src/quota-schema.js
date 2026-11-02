'use strict';

const POLL_MS = 60 * 60_000;
const STALE_MS = 3 * 60 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i;
const STATUSES = new Set(['pending', 'ok', 'error', 'auth-required']);
const ERRORS = new Set(['authentication', 'identity', 'request', 'invalid-response']);
const PLANS = new Set(['enterprise', 'business', 'individual', 'individual_pro', 'individual_max', 'free']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15 ? value : null;
const time = value => number(value) > 0 && value < 1e14 ? Math.round(value) : null;
const bool = value => typeof value === 'boolean' ? value : null;

// Only account identifiers, quota counters and evidence times may cross into a
// browser or the remote view. Credentials and upstream error text never do.
function sanitizeQuotaSnapshot(input) {
  if (!input || !Array.isArray(input.accounts)) return null;
  const seen = new Set();
  const accounts = input.accounts.slice(0, 8).flatMap(a => {
    if (!a || typeof a.id !== 'string' || typeof a.login !== 'string' || !ID.test(a.id) || !ID.test(a.login) || typeof a.host !== 'string' || a.host.length > 253 || !HOST.test(a.host) || seen.has(a.id)) return [];
    seen.add(a.id);
    const p = a.premium;
    const remaining = number(p?.remainingPercent);
    return [{
      id: a.id, host: a.host, login: a.login,
      plan: PLANS.has(a.plan) ? a.plan : null,
      status: STATUSES.has(a.status) ? a.status : 'pending',
      error: ERRORS.has(a.error) ? a.error : null,
      checkedAt: time(a.checkedAt), updatedAt: time(a.updatedAt),
      resetDate: typeof a.resetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.resetDate) ? a.resetDate : null,
      premium: p && typeof p.unlimited === 'boolean' ? {
        unlimited: p.unlimited, hasQuota: bool(p.hasQuota),
        remainingPercent: !p.unlimited && p.hasQuota === true && remaining !== null && remaining <= 100 ? remaining : null,
        used: number(p.used), limit: number(p.limit),
      } : null,
      chatUnlimited: bool(a.chatUnlimited), completionsUnlimited: bool(a.completionsUnlimited),
    }];
  });
  return { capturedAt: time(input.capturedAt), accounts };
}

module.exports = { sanitizeQuotaSnapshot, POLL_MS, STALE_MS };
